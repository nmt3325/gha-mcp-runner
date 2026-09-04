/*
 * Small helpers, plus the out-of-space evidence guards.
 *
 * The guards exist because killed_reason='enospc' is only allowed to come from
 * a write of OURS that actually returned ENOSPC. Anything weaker (a stalled
 * file, zero free blocks) is indistinguishable from `cargo build` thinking, and
 * mislabelling that gets persisted forever.
 */

import fs from "node:fs"
import path from "node:path"

export function num(v, d) {
	const n = Number(v)
	return Number.isFinite(n) ? n : d
}

export function clamp(n, lo, hi) {
	return Math.max(lo, Math.min(hi, n))
}

export function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms))
}

/** Exponential backoff with full jitter, capped at 15s. */
export function jitter(base, attempt) {
	const capped = Math.min(base * Math.pow(2, Math.min(attempt, 5)), 15000)
	return Math.floor(capped * (0.5 + Math.random() * 0.5))
}

export function log(...a) {
	process.stderr.write(`[agent ${process.env.GHA_MCP_ROLE || "?"}] ${a.join(" ")}\n`)
}

export function readTextOr(p, d = null) {
	try {
		return fs.readFileSync(p, "utf8")
	} catch {
		return d
	}
}

export function readJsonOr(p, d = null) {
	const t = readTextOr(p)
	if (t === null) return d
	try {
		return JSON.parse(t)
	} catch {
		return d
	}
}

/* ------------------------------------------------------------ space guards */

/**
 * The single source of truth for killed_reason='enospc'.
 * Written only by guarded()/guardedQuiet()/confirmNoSpace() on a real failure.
 */
export const space = { enospcAt: null, warned: false }

export function isNoSpace(e) {
	return Boolean(e) && (e.code === "ENOSPC" || e.code === "EDQUOT" || e.code === "EFBIG")
}

/** Run a write; record a genuine out-of-space failure; rethrow. */
export function guarded(fn) {
	try {
		return fn()
	} catch (e) {
		if (isNoSpace(e)) space.enospcAt = Date.now()
		throw e
	}
}

/** Run a write; record out-of-space; swallow everything else. */
export function guardedQuiet(fn) {
	try {
		return fn()
	} catch (e) {
		if (isNoSpace(e)) space.enospcAt = Date.now()
		return null
	}
}

export function mkdirp(p) {
	return guarded(() => fs.mkdirSync(p, { recursive: true }))
}

export function writeJson(p, obj) {
	const tmp = `${p}.tmp`
	return guardedQuiet(() => {
		fs.writeFileSync(tmp, JSON.stringify(obj))
		fs.renameSync(tmp, p)
	})
}

/**
 * Free bytes on the volume holding `p`, or null.
 *
 * Node documents bavail as "available blocks for unprivileged users". On APFS it
 * EXCLUDES purgeable space: Disk Utility reporting "255.34 GB available (145.56
 * GB purgeable)" corresponds to `df -H` reporting 110G, and 255.34 - 145.56 is
 * 109.78. So on macOS this UNDER-reports free space. That direction is safe: it
 * only shortens the tail poll interval. It is never a kill trigger.
 */
export function diskFreeBytes(p) {
	try {
		const s = fs.statfsSync(p)
		return Number(s.bavail) * Number(s.bsize)
	} catch {
		return null
	}
}

export function diskFreeMb(p) {
	const b = diskFreeBytes(p)
	return b === null ? null : Math.floor(b / (1024 * 1024))
}

/**
 * bavail === 0 is advisory. Confirm it with a real one-byte write, because a
 * real failed write is the only admissible evidence for 'enospc'.
 *
 * Worth remembering why this matters beyond labelling: a write(2) that hits
 * ENOSPC may be PARTIAL, and a later write can land in the gap. Red Hat's
 * busybox reproducer writes "abcde" to a full filesystem, then "12345", and
 * reads back "abcd12345". "The disk is full" and "the bytes are intact" are
 * independent facts, so we want to know which one we are looking at.
 */
export function confirmNoSpace(dir) {
	const p = path.join(dir, ".spaceprobe")
	try {
		const fd = fs.openSync(p, "w")
		try {
			fs.writeSync(fd, "x")
		} finally {
			fs.closeSync(fd)
		}
		fs.rmSync(p, { force: true })
		return false
	} catch (e) {
		if (isNoSpace(e)) {
			space.enospcAt = Date.now()
			return true
		}
		return false
	}
}
