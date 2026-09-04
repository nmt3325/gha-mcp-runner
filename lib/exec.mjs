/*
 * Running one command.
 *
 * The output path here is the reason this project exists. Everything else is
 * plumbing around these four facts:
 *
 *   1. The child writes to a FILE, through a descriptor it inherited. There is no
 *      pipe, so the agent's event loop cannot be stalled by a chatty child, and
 *      an orphaned grandchild holding stdout cannot stop us finishing.
 *   2. Both stdout and stderr are the SAME descriptor, so the kernel decides the
 *      interleave. No shell-level 2>&1 is involved anywhere.
 *   3. Completion comes from the exit event, corroborated by the rc file. Never
 *      from EOF, which an orphan can withhold indefinitely.
 *   4. Reads are positional. pread does not move a shared offset, so re-reading
 *      a range is byte-identical and two readers cannot interfere. That is what
 *      makes an MCP client's retry after a 60-second timeout safe.
 */

import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"

import { killProcessGroup } from "../vendor/process-utils.mjs"
import {
	CFG,
	DEFAULT_MAX_OUTPUT_BYTES,
	IS_WIN,
	KILL_ESCALATE_MS,
	PUSH_IDLE_MS,
	PUSH_MAX_BYTES,
	PUSH_SIZE_BYTES,
	RC_GRACE_MS,
	STATFS_INTERVAL_MS,
	jobDir,
	overlayPath,
	stickyCwdPath,
	workDir,
} from "./config.mjs"
import { makeTailClock } from "./clock.mjs"
import { pushChunk } from "./broker.mjs"
import { childEnv, renderScript, shellPlan, spawnArgs } from "./shell.mjs"
import { run } from "./state.mjs"
import {
	clamp,
	confirmNoSpace,
	diskFreeBytes,
	diskFreeMb,
	guarded,
	guardedQuiet,
	log,
	mkdirp,
	num,
	readTextOr,
	sleep,
	space,
	writeJson,
} from "./util.mjs"

export const outRawPath = (id) => path.join(jobDir(id), "out.raw")
export const killMarkerPath = (id) => path.join(jobDir(id), "kill")

/**
 * Read an arbitrary byte range out of a job's output. Used both by the push loop
 * and by the broker's `pull` action.
 *
 * Positional only. See fact 4 above.
 */
export function readRange(filePath, from, want) {
	let total = 0
	try {
		total = fs.statSync(filePath).size
	} catch {
		return { total: 0, bytes: Buffer.alloc(0) }
	}
	const start = clamp(num(from, 0), 0, total)
	const len = Math.min(Math.max(0, num(want, 0)), total - start)
	if (len <= 0) return { total, bytes: Buffer.alloc(0) }
	const fd = fs.openSync(filePath, "r")
	try {
		const buf = Buffer.allocUnsafe(len)
		const got = fs.readSync(fd, buf, 0, len, start)
		return { total, bytes: buf.subarray(0, Math.max(0, got)) }
	} finally {
		fs.closeSync(fd)
	}
}

function resolveCwd(explicit) {
	if (explicit) return explicit
	const sticky = (readTextOr(stickyCwdPath()) || "").trim()
	if (sticky) {
		try {
			if (fs.statSync(sticky).isDirectory()) return sticky
		} catch {
			/* fall through */
		}
	}
	return workDir()
}

/** Ship everything between st.pushed and st.size, 64 KiB at a time. */
async function flush(id, readFd, st, cmdState, exitCode, runtimeMs, eof, extra) {
	for (;;) {
		const start = st.pushed
		const want = Math.min(PUSH_MAX_BYTES, st.size - start)
		let b64 = ""
		if (want > 0) {
			const buf = Buffer.allocUnsafe(want)
			const got = fs.readSync(readFd, buf, 0, want, start)
			b64 = buf.subarray(0, Math.max(0, got)).toString("base64")
			st.pushed = start + Math.max(0, got)
		}
		const last = st.pushed >= st.size
		const ok = await pushChunk({
			command_id: id,
			start_byte: start,
			bytes_b64: b64,
			total_bytes: st.size,
			// Always reported. The adaptive clock removed the old byte budget from the
			// protocol, and this is the promise that replaced it: the caller can always
			// see how much the command actually wrote, even when it never reads it.
			bytes_written: st.size,
			state: last ? cmdState : "running",
			exit_code: last ? exitCode : null,
			runtime_ms: runtimeMs,
			eof: Boolean(eof && last),
			...(last ? extra || {} : {}),
		})
		st.lastPushAt = Date.now()
		if (!ok) return false
		if (want === 0 || last) return true
	}
}

async function failCommand(id, error) {
	await pushChunk({
		command_id: id,
		start_byte: 0,
		bytes_b64: "",
		total_bytes: 0,
		bytes_written: 0,
		state: "lost",
		exit_code: null,
		runtime_ms: 0,
		eof: true,
		killed_reason: space.enospcAt ? "enospc" : null,
		agent_error: String(error),
	})
}

export async function runCommand(cmd) {
	const id = String(cmd.command_id)
	const dir = jobDir(id)
	mkdirp(dir)

	// O_EXCL is the entire exclusion mechanism. /next may deliver the same command
	// twice; that is expected rather than a bug, and only one worker wins here.
	try {
		const fd = guarded(() => fs.openSync(path.join(dir, "started_at"), "wx"))
		try {
			fs.writeSync(fd, String(Date.now()))
		} finally {
			fs.closeSync(fd)
		}
	} catch (e) {
		if (e && e.code === "EEXIST") {
			log(`duplicate delivery of ${id} ignored`)
			return
		}
		throw e
	}

	// A shell that is not installed is a precondition failure, reported now. It is
	// never quietly substituted -- see lib/shell.mjs and actions/runner#3415.
	const plan = shellPlan(cmd.shell)
	if (!plan.ok) {
		await failCommand(id, plan.error)
		return
	}

	const cwd = resolveCwd(cmd.cwd)
	mkdirp(cwd)
	const ctx = {
		kind: plan.kind,
		cwd,
		overlay: overlayPath(),
		rc: path.join(dir, "rc"),
		cwdOut: path.join(dir, "cwd_out"),
	}
	const scriptPath = path.join(dir, `cmd${plan.ext}`)
	guarded(() =>
		fs.writeFileSync(scriptPath, renderScript(plan.kind, cmd.command, ctx), { mode: 0o700 }),
	)

	const rawPath = outRawPath(id)
	guarded(() => fs.writeFileSync(rawPath, ""))

	// Two descriptors on one file:
	//   writeFd  O_APPEND, handed to the child as BOTH stdout and stderr. We never
	//            write a single byte through it ourselves.
	//   readFd   read-only, used only for fstat() sizing and pread() ranges.
	// Node documents that positional WRITES are ignored on Linux when a file is
	// opened in append mode. We only ever position-READ, which is unaffected.
	const writeFd = guarded(() => fs.openSync(rawPath, "a"))
	const readFd = fs.openSync(rawPath, "r")

	// stdin is a real file, never an open pipe. A non-TTY process with an open
	// stdin makes many CLIs wait forever for input that will never arrive.
	let inFd
	try {
		if (cmd.stdin_b64) {
			const sp = path.join(dir, "stdin.bin")
			guarded(() => fs.writeFileSync(sp, Buffer.from(cmd.stdin_b64, "base64")))
			inFd = fs.openSync(sp, "r")
		} else {
			inFd = fs.openSync(IS_WIN ? "NUL" : "/dev/null", "r")
		}
	} catch (e) {
		for (const fd of [writeFd, readFd]) {
			try {
				fs.closeSync(fd)
			} catch {
				/* ignore */
			}
		}
		await failCommand(id, (e && e.message) || e)
		return
	}

	const [exe, args] = spawnArgs(plan.kind, scriptPath)
	const startMs = Date.now()
	let child = null
	let spawnError = null
	try {
		child = spawn(exe, args, {
			cwd,
			env: childEnv(cmd.env),
			stdio: [inFd, writeFd, writeFd],
			detached: !IS_WIN, // POSIX: its own process group, so the whole tree is killable
			windowsHide: true,
		})
	} catch (e) {
		spawnError = e
	}
	// The child holds its own dups now. Keeping ours open would leak a descriptor
	// per command and, worse, keep out.raw's write end alive after the child dies.
	for (const fd of [inFd, writeFd]) {
		try {
			fs.closeSync(fd)
		} catch {
			/* ignore */
		}
	}
	if (!child) {
		try {
			fs.closeSync(readFd)
		} catch {
			/* ignore */
		}
		await failCommand(id, (spawnError && spawnError.message) || spawnError)
		return
	}

	guardedQuiet(() => fs.writeFileSync(path.join(dir, "pid"), String(child.pid)))
	if (!IS_WIN) guardedQuiet(() => fs.writeFileSync(path.join(dir, "pgid"), String(child.pid)))

	let exited = null
	child.on("exit", (code, signal) => {
		exited = { code, signal, at: Date.now() }
	})
	child.on("error", (e) => {
		spawnError = e
		exited = { code: null, signal: null, at: Date.now() }
	})

	const clock = makeTailClock(CFG.execWorkers)
	const st = { size: 0, seen: 0, pushed: 0, lastGrowAt: startMs, lastPushAt: startMs }
	const timeoutMs = clamp(num(cmd.timeout_s, 3600), 1, 21600) * 1000
	const inactivityMs = Math.max(0, num(cmd.inactivity_kill_s, 0)) * 1000
	const maxOutBytes = clamp(
		num(cmd.max_output_bytes, DEFAULT_MAX_OUTPUT_BYTES),
		64 * 1024,
		8 * 1024 * 1024 * 1024,
	)
	const killMarker = killMarkerPath(id)
	const warnings = []
	let free = diskFreeBytes(dir)
	let statfsAt = Date.now()
	let killedReason = null
	let escalateAt = 0

	for (;;) {
		try {
			st.size = fs.fstatSync(readFd).size
		} catch {
			/* keep the last known size */
		}
		const now = Date.now()
		if (st.size > st.seen) {
			st.seen = st.size
			st.lastGrowAt = now
		}
		if (now - statfsAt >= STATFS_INTERVAL_MS) {
			free = diskFreeBytes(dir)
			statfsAt = now
		}

		const pending = st.size - st.pushed
		if (pending > 0 && (pending >= PUSH_SIZE_BYTES || now - st.lastPushAt >= PUSH_IDLE_MS)) {
			await flush(id, readFd, st, "running", null, now - startMs, false)
		}

		if (exited) {
			const rc = readTextOr(ctx.rc)
			if (rc !== null || Date.now() - exited.at > RC_GRACE_MS) break
		} else {
			// Fixed priority:
			//   enospc > output_cap > timeout | inactivity > user > spawn_gap
			// 'enospc' requires a write of OURS to have actually failed. A file that
			// stops growing is ALWAYS 'inactivity', because from the outside that is
			// indistinguishable from `cargo build` thinking or `npm ci` resolving, and
			// a wrong label here gets persisted forever.
			if (!killedReason && space.enospcAt) killedReason = "enospc"
			else if (!killedReason && st.size > maxOutBytes) killedReason = "output_cap"
			else if (!killedReason && now - startMs > timeoutMs) killedReason = "timeout"
			else if (!killedReason && inactivityMs > 0 && now - st.lastGrowAt > inactivityMs)
				killedReason = "inactivity"
			else if (!killedReason && fs.existsSync(killMarker)) killedReason = "user"
			else if (!killedReason && run.stopping) killedReason = "user"

			// Free space is advisory. It shortens the poll interval, it can add a
			// warning, and it prompts a REAL one-byte write probe -- but it is never
			// itself a kill trigger, and on APFS it under-reports anyway.
			if (free === 0 && !space.warned) {
				space.warned = true
				warnings.push(
					"statfs reports 0 available blocks; output may be truncated by the filesystem",
				)
				confirmNoSpace(dir)
			}

			if (killedReason && !escalateAt) {
				escalateAt = now + KILL_ESCALATE_MS
				killProcessGroup({
					pid: child.pid,
					escalate: true,
					escalateMs: KILL_ESCALATE_MS,
					isExited: () => Boolean(exited),
				}).catch(() => {})
			} else if (escalateAt && now > escalateAt) {
				escalateAt = now + KILL_ESCALATE_MS * 4
				killProcessGroup({
					pid: child.pid,
					signal: "SIGKILL",
					isExited: () => Boolean(exited),
				}).catch(() => {})
			}
		}

		await sleep(clock.next(st.size, free))
	}

	try {
		st.size = fs.fstatSync(readFd).size
	} catch {
		/* keep the last known size */
	}

	const rcText = readTextOr(ctx.rc)
	const rcNum = rcText === null ? null : Number.parseInt(String(rcText).trim(), 10)
	const signal = exited && exited.signal ? exited.signal : null
	// exit_code is reported RAW and placed ALONGSIDE killed_reason and signal, not
	// rewritten into 137/143. Rewriting it would mean a client re-reading the same
	// finished command could arrive at a different interpretation than the first
	// reader, which breaks the whole point of holding no per-reader state.
	let exitCode = Number.isFinite(rcNum)
		? rcNum
		: exited && typeof exited.code === "number"
			? exited.code
			: null
	let finalState = "exited"
	if (killedReason || signal) finalState = "killed"
	if (spawnError) {
		finalState = "lost"
		exitCode = null
	}
	// No rc file AND no numeric exit code means we genuinely do not know. That is
	// `lost` -- never `unknown`, and never a guessed 0. The old system's
	// `state: unknown, output_bytes: 0` for a live process is the exact ambiguity
	// being ruled out here.
	if (finalState === "exited" && exitCode === null) finalState = "lost"
	if (space.enospcAt && killedReason !== "enospc") {
		warnings.push("an agent write returned ENOSPC during this command; output may be incomplete")
	}

	// `cd /tmp; false` legitimately moves the working directory even though it
	// failed, so this is not gated on the exit code.
	const newCwd = (readTextOr(ctx.cwdOut) || "").trim() || null
	if (newCwd && !cmd.cwd) guardedQuiet(() => fs.writeFileSync(stickyCwdPath(), newCwd))

	writeJson(path.join(dir, "meta.json"), {
		command_id: id,
		shell: plan.kind,
		cwd,
		cwd_after: newCwd,
		state: finalState,
		exit_code: exitCode,
		signal,
		killed_reason: killedReason,
		started_at: startMs,
		ended_at: Date.now(),
		runtime_ms: Date.now() - startMs,
		total_bytes: st.size,
		bytes_written: st.size,
		output_capped: st.size > maxOutBytes,
		disk_free_mb: diskFreeMb(dir),
		warnings,
		spawn_error: spawnError ? String(spawnError.message || spawnError) : null,
		agent_write_enospc_at: space.enospcAt,
	})

	await flush(id, readFd, st, finalState, exitCode, Date.now() - startMs, true, {
		cwd_after: newCwd,
		killed_reason: killedReason,
		signal,
		output_capped: st.size > maxOutBytes,
		disk_free_mb: diskFreeMb(dir),
		warnings,
		agent_error: spawnError ? String(spawnError.message || spawnError) : undefined,
	})

	try {
		fs.closeSync(readFd)
	} catch {
		/* ignore */
	}

	// out.raw is deliberately NOT deleted. The broker only keeps a bounded tail in
	// storage and asks us to pull older byte ranges back when a client scrolls to
	// them, so removing it here would make old windows permanently unreadable.
	// Reclaiming the space by punching holes in it is M2 work.
}
