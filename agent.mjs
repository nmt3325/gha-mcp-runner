#!/usr/bin/env node
/*
 * gha-mcp runner agent — single file, zero dependencies, Node >= 20.
 *
 *   node agent.mjs --role=control    enroll, hold /control long-poll, own the TTL lease,
 *                                    spawn exec workers, be the sole process-tree killer
 *   node agent.mjs --role=exec       hold /next long-poll, run one command at a time
 *
 * Invariants (see the design doc — do not "simplify" these away):
 *  - Completion is decided by the process exit event AND the `rc` file. Never by stdout EOF.
 *  - No pipes anywhere. Children are spawned with stdio ['ignore', fd, fd] onto out.raw,
 *    so an orphan holding stdout can never stall this process (the old system's #1 bug).
 *  - Duplicate delivery is expected. Exclusion is a runner-side O_EXCL marker, not a broker lock.
 *  - Disconnection is a normal event: reconnect immediately with jittered backoff.
 *  - Byte offsets are the only cursor, over the stripped stream (out.strip).
 */

import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"

const VERSION = "0.1.0"

const PLATFORM =
	process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux"
const IS_WIN = PLATFORM === "windows"

const CFG = {
	brokerUrl: String(process.env.BROKER_URL || "").replace(/\/+$/, ""),
	brokerSecret: process.env.BROKER_SECRET || "",
	envId: process.env.GHA_MCP_ENV_ID || "",
	ttlMinutes: num(process.env.GHA_MCP_TTL_MINUTES, 60),
	root:
		process.env.GHA_MCP_ROOT ||
		path.join(process.env.RUNNER_TEMP || os.tmpdir(), "gha-mcp"),
	runId: process.env.GITHUB_RUN_ID || "0",
	runAttempt: process.env.GITHUB_RUN_ATTEMPT || "1",
	token: process.env.GHA_MCP_TOKEN || "",
	worker: num(process.env.GHA_MCP_WORKER, 0),
	execWorkers: clamp(num(process.env.GHA_MCP_EXEC_WORKERS, 4), 1, 8),
	waitSeconds: clamp(num(process.env.GHA_MCP_WAIT_SECONDS, 50), 5, 55),
}

// Tail / push tuning. Small enough that a chatty command still reports promptly,
// large enough that a 100 MB build log does not become 3000 HTTP requests.
const TAIL_INTERVAL_MS = 120
const PUSH_IDLE_MS = 400
const PUSH_SIZE_BYTES = 32 * 1024
const PUSH_MAX_BYTES = 64 * 1024
const RC_GRACE_MS = 3000
const KILL_ESCALATE_MS = 3000

// Never hand these to AI-executed commands.
const SCRUB_PREFIXES = ["ACTIONS_", "INPUT_", "GHA_MCP_"]
const SCRUB_EXACT = [
	"BROKER_URL",
	"BROKER_SECRET",
	"GITHUB_TOKEN",
	"GH_TOKEN",
	"GH_PAT",
	"NODE_AUTH_TOKEN",
]

const envDir = () => path.join(CFG.root, CFG.envId)
const jobsDir = () => path.join(envDir(), "jobs")
const jobDir = (id) => path.join(jobsDir(), id)
const workDir = () => path.join(envDir(), "work")
const overlayPath = () => path.join(envDir(), "overlay.env")
const stickyCwdPath = () => path.join(envDir(), "cwd")
const statePath = () => path.join(envDir(), "state.json")
const metaPath = () => path.join(envDir(), "meta.json")

/* ------------------------------------------------------------------ utils */

function num(v, d) {
	const n = Number(v)
	return Number.isFinite(n) ? n : d
}
function clamp(n, lo, hi) {
	return Math.max(lo, Math.min(hi, n))
}
function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms))
}
function jitter(base, attempt) {
	const capped = Math.min(base * Math.pow(2, Math.min(attempt, 5)), 15000)
	return Math.floor(capped * (0.5 + Math.random() * 0.5))
}
function log(...a) {
	process.stderr.write(`[agent ${process.env.GHA_MCP_ROLE || "?"}] ${a.join(" ")}\n`)
}
function mkdirp(p) {
	fs.mkdirSync(p, { recursive: true })
}
function readTextOr(p, d = null) {
	try {
		return fs.readFileSync(p, "utf8")
	} catch {
		return d
	}
}
function writeJson(p, obj) {
	const tmp = `${p}.tmp`
	fs.writeFileSync(tmp, JSON.stringify(obj))
	fs.renameSync(tmp, p)
}
function diskFreeMb(p) {
	try {
		const s = fs.statfsSync(p)
		return Math.floor((Number(s.bavail) * Number(s.bsize)) / (1024 * 1024))
	} catch {
		return null
	}
}

/**
 * HTTP to the broker. Returns { status, json, text } and never throws for
 * network failures — the caller decides, because "broker unreachable" is a
 * normal event on this transport, not an exception.
 *
 * Guards against the opencode-mcp-bridge failure mode where a proxy answers a
 * 200 with an HTML body: a 200 without a JSON object is reported as status 0.
 */
async function brokerReq(method, pathname, opts = {}) {
	const { token, body, timeoutMs = 20000, headers = {} } = opts
	if (!CFG.brokerUrl) return { status: 0, json: null, text: "BROKER_URL unset" }
	const ac = new AbortController()
	const timer = setTimeout(() => ac.abort(), timeoutMs)
	try {
		const res = await fetch(CFG.brokerUrl + pathname, {
			method,
			signal: ac.signal,
			headers: {
				accept: "application/json",
				...(body === undefined ? {} : { "content-type": "application/json" }),
				...(token ? { authorization: `Bearer ${token}` } : {}),
				...headers,
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		})
		const text = await res.text()
		let json = null
		try {
			const parsed = text ? JSON.parse(text) : null
			if (parsed && typeof parsed === "object") json = parsed
		} catch {
			/* not json */
		}
		if (res.status === 200 && !json) {
			return { status: 0, json: null, text: `non-JSON 200 body: ${text.slice(0, 200)}` }
		}
		return { status: res.status, json, text }
	} catch (e) {
		return { status: 0, json: null, text: String((e && e.message) || e) }
	} finally {
		clearTimeout(timer)
	}
}

/* --------------------------------------------------------------- stripping */

const RE_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
const RE_CSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g
const RE_ESC_SHORT = /\x1b[@-Z\\-_]/g

/**
 * Streaming ANSI stripper. Holds back a trailing incomplete UTF-8 sequence
 * (via TextDecoder stream mode), a trailing unterminated escape sequence, and a
 * trailing lone CR (which may turn out to be the first half of CRLF).
 *
 * A lone CR becomes \n rather than being deleted: deleting it fuses an entire
 * progress bar into one enormous line, which then trips max_bytes on every read.
 */
function makeStripper(secrets) {
	const decoder = new TextDecoder("utf-8")
	let held = ""
	return function push(buf, final) {
		let text = held + decoder.decode(buf, { stream: !final })
		held = ""
		if (!final) {
			const esc = text.lastIndexOf("\x1b")
			if (esc >= 0 && text.length - esc < 32 && !/[@-~]/.test(text.slice(esc + 2))) {
				held = text.slice(esc)
				text = text.slice(0, esc)
			}
			if (text.endsWith("\r")) {
				held = "\r" + held
				text = text.slice(0, -1)
			}
		}
		let out = text.replace(RE_OSC, "").replace(RE_CSI, "").replace(RE_ESC_SHORT, "")
		out = out.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
		for (const s of secrets) {
			if (s && s.length >= 8) out = out.split(s).join("***")
		}
		return out
	}
}

/* ------------------------------------------------------------ shell wrapper */

function shellPlan(shellName) {
	const want = shellName || (IS_WIN ? "pwsh" : "bash")
	if (IS_WIN) {
		if (want === "cmd") return { kind: "cmd", ext: ".cmd" }
		if (want === "bash") return { kind: "bash", ext: ".sh" }
		return { kind: "pwsh", ext: ".ps1" }
	}
	if (want === "pwsh") return { kind: "pwsh", ext: ".ps1" }
	if (want === "sh") return { kind: "sh", ext: ".sh" }
	if (want === "zsh") return { kind: "zsh", ext: ".sh" }
	return { kind: "bash", ext: ".sh" }
}

function posixScript(cmd, ctx) {
	const shebang = ctx.kind === "sh" ? "/bin/sh" : ctx.kind === "zsh" ? "/usr/bin/env zsh" : "/usr/bin/env bash"
	// set -e is deliberately absent: it kills legitimate multi-command input and
	// makes `tput` under TERM=dumb (exit 3) abort the whole script.
	return (
		`#!${shebang}\n` +
		`set -o pipefail 2>/dev/null || true\n` +
		`exec 0</dev/null\n` +
		`cd ${q(ctx.cwd)} || exit 127\n` +
		`if [ -f ${q(ctx.overlay)} ]; then . ${q(ctx.overlay)}; fi\n` +
		`{\n${cmd}\n}\n` +
		`__rc=$?\n` +
		`pwd > ${q(ctx.cwdOut)} 2>/dev/null || true\n` +
		`printf '%s' "$__rc" > ${q(ctx.rc + ".tmp")} && mv ${q(ctx.rc + ".tmp")} ${q(ctx.rc)}\n` +
		`exit $__rc\n`
	)
}

function pwshScript(cmd, ctx) {
	// $ErrorActionPreference is deliberately left at its default: forcing Stop
	// turns every warning-level cmdlet failure into a hard abort mid-command.
	return (
		`$ProgressPreference = 'SilentlyContinue'\n` +
		`try { chcp 65001 | Out-Null } catch {}\n` +
		`try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}\n` +
		`try { [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}\n` +
		`try { if ($PSStyle) { $PSStyle.OutputRendering = 'PlainText' } } catch {}\n` +
		`Set-Location -LiteralPath ${pq(ctx.cwd)}\n` +
		`if (Test-Path -LiteralPath ${pq(ctx.overlay)}) {\n` +
		`  Get-Content -LiteralPath ${pq(ctx.overlay)} | ForEach-Object {\n` +
		`    if ($_ -match '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {\n` +
		`      [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2])\n` +
		`    }\n` +
		`  }\n` +
		`}\n` +
		`$global:LASTEXITCODE = $null\n` +
		`& {\n${cmd}\n}\n` +
		`$__rc = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }\n` +
		`try { (Get-Location).Path | Set-Content -LiteralPath ${pq(ctx.cwdOut)} -NoNewline } catch {}\n` +
		`Set-Content -LiteralPath ${pq(ctx.rc)} -Value "$__rc" -NoNewline\n` +
		`exit $__rc\n`
	)
}

function cmdScript(cmd, ctx) {
	return (
		`@echo off\r\n` +
		`chcp 65001 >nul\r\n` +
		`cd /d "${ctx.cwd}"\r\n` +
		`${cmd.replace(/\n/g, "\r\n")}\r\n` +
		`set __rc=%ERRORLEVEL%\r\n` +
		`cd > "${ctx.cwdOut}"\r\n` +
		`<nul set /p=%__rc%> "${ctx.rc}"\r\n` +
		`exit /b %__rc%\r\n`
	)
}

function q(s) {
	return `'${String(s).replace(/'/g, "'\\''")}'`
}
function pq(s) {
	return `'${String(s).replace(/'/g, "''")}'`
}

function spawnArgs(kind, scriptPath) {
	switch (kind) {
		case "pwsh":
			return [
				IS_WIN ? "pwsh.exe" : "pwsh",
				["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
			]
		case "cmd":
			return [process.env.COMSPEC || "cmd.exe", ["/d", "/s", "/c", scriptPath]]
		case "sh":
			return ["/bin/sh", [scriptPath]]
		case "zsh":
			return ["zsh", [scriptPath]]
		default:
			return [IS_WIN ? "bash.exe" : "/bin/bash", [scriptPath]]
	}
}

function childEnv(extra) {
	const e = { ...process.env }
	for (const k of Object.keys(e)) {
		if (SCRUB_EXACT.includes(k) || SCRUB_PREFIXES.some((p) => k.startsWith(p))) delete e[k]
	}
	// TERM is intentionally not set: a bare TERM makes tools emit escapes with no
	// terminal to interpret them, and TERM=dumb makes tput exit 3.
	delete e.TERM
	e.CI = "1"
	e.NO_COLOR = "1"
	e.GIT_TERMINAL_PROMPT = "0"
	e.DEBIAN_FRONTEND = "noninteractive"
	return { ...e, ...(extra || {}) }
}

/* ------------------------------------------------------------- process kill */

function killTree(pid, hard) {
	if (!pid) return false
	try {
		if (IS_WIN) {
			const tk = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe")
			const exe = fs.existsSync(tk) ? tk : "taskkill"
			spawnSync(exe, ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" })
			return true
		}
		process.kill(-pid, hard ? "SIGKILL" : "SIGTERM")
		return true
	} catch {
		try {
			process.kill(pid, hard ? "SIGKILL" : "SIGTERM")
			return true
		} catch {
			return false
		}
	}
}

/* ------------------------------------------------------------- exec  worker */

let stopping = false

async function execWorkerMain() {
	let attempt = 0
	while (!stopping) {
		const r = await brokerReq(
			"GET",
			`/agent/${encodeURIComponent(CFG.envId)}/next?wait=${CFG.waitSeconds}&worker=${CFG.worker}`,
			{ token: CFG.token, timeoutMs: (CFG.waitSeconds + 15) * 1000 },
		)
		if (r.status === 401 || r.status === 403 || r.status === 410) {
			log(`next -> ${r.status}, worker exiting`)
			return
		}
		if (r.status !== 200) {
			// Disconnection is a normal event on this transport.
			await sleep(jitter(500, attempt++))
			continue
		}
		attempt = 0
		const cmd = r.json && r.json.command
		if (!cmd || !cmd.command_id) continue
		try {
			await runCommand(cmd)
		} catch (e) {
			log(`command ${cmd.command_id} crashed: ${e && e.stack}`)
			await pushChunk({
				command_id: cmd.command_id,
				start_byte: 0,
				bytes_b64: "",
				total_bytes: 0,
				state: "lost",
				exit_code: null,
				runtime_ms: 0,
				eof: true,
				agent_error: String((e && e.message) || e),
			})
		}
	}
}

async function pushChunk(payload) {
	for (let attempt = 0; attempt < 6 && !stopping; attempt++) {
		const r = await brokerReq("POST", `/agent/${encodeURIComponent(CFG.envId)}/chunk`, {
			token: CFG.token,
			body: payload,
			timeoutMs: 20000,
		})
		if (r.status === 200) return true
		if (r.status === 401 || r.status === 403 || r.status === 410) return false
		await sleep(jitter(400, attempt))
	}
	return false
}

async function runCommand(cmd) {
	const id = String(cmd.command_id)
	const dir = jobDir(id)
	mkdirp(dir)

	const startedAt = path.join(dir, "started_at")
	try {
		// O_EXCL is the whole exclusion mechanism. /next may deliver the same command
		// twice (that is fine and expected); only one worker can create this file.
		const fd = fs.openSync(startedAt, "wx")
		fs.writeSync(fd, String(Date.now()))
		fs.closeSync(fd)
	} catch (e) {
		if (e && e.code === "EEXIST") {
			log(`duplicate delivery of ${id} ignored`)
			return
		}
		throw e
	}

	const plan = shellPlan(cmd.shell)
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
	const body =
		plan.kind === "pwsh"
			? pwshScript(cmd.command, ctx)
			: plan.kind === "cmd"
				? cmdScript(cmd.command, ctx)
				: posixScript(cmd.command, ctx)
	fs.writeFileSync(scriptPath, body, { mode: 0o700 })

	const rawPath = path.join(dir, "out.raw")
	const stripPath = path.join(dir, "out.strip")
	fs.writeFileSync(rawPath, "")
	fs.writeFileSync(stripPath, "")

	// stdin from a real file, never an open pipe: a non-TTY with an open stdin
	// makes many CLIs wait forever for input.
	const devNull = IS_WIN ? "NUL" : "/dev/null"
	const outFd = fs.openSync(rawPath, "a")
	let inFd = null
	if (cmd.stdin_b64) {
		const sp = path.join(dir, "stdin.bin")
		fs.writeFileSync(sp, Buffer.from(cmd.stdin_b64, "base64"))
		inFd = fs.openSync(sp, "r")
	} else {
		inFd = fs.openSync(devNull, "r")
	}

	const [exe, args] = spawnArgs(plan.kind, scriptPath)
	const startMs = Date.now()
	let child
	try {
		child = spawn(exe, args, {
			cwd,
			env: childEnv(cmd.env),
			stdio: [inFd, outFd, outFd],
			detached: !IS_WIN, // POSIX: own process group so the whole tree is killable
			windowsHide: true,
		})
	} catch (e) {
		fs.closeSync(outFd)
		fs.closeSync(inFd)
		throw e
	}
	fs.writeFileSync(path.join(dir, "pid"), String(child.pid))
	if (!IS_WIN) fs.writeFileSync(path.join(dir, "pgid"), String(child.pid))
	fs.closeSync(outFd)
	fs.closeSync(inFd)

	let exited = null
	let spawnError = null
	child.on("exit", (code, signal) => {
		exited = { code, signal, at: Date.now() }
	})
	child.on("error", (e) => {
		spawnError = e
		exited = { code: null, signal: null, at: Date.now() }
	})

	const secrets = loadSecrets()
	const strip = makeStripper(secrets)
	const state = {
		rawOffset: 0,
		stripBytes: 0,
		pushedBytes: 0,
		lastOutputAt: startMs,
		lastPushAt: 0,
	}
	const timeoutMs = clamp(num(cmd.timeout_s, 3600), 1, 21600) * 1000
	const inactivityKillMs = num(cmd.inactivity_kill_s, 0) * 1000
	let killedReason = null
	let escalateAt = 0

	for (;;) {
		pump(rawPath, stripPath, strip, state, false)
		const now = Date.now()
		const pending = state.stripBytes - state.pushedBytes
		if (
			pending > 0 &&
			(pending >= PUSH_SIZE_BYTES || now - state.lastOutputAt >= PUSH_IDLE_MS)
		) {
			await flush(id, stripPath, state, "running", null, now - startMs, false)
		}

		if (exited) {
			const rc = readTextOr(ctx.rc)
			if (rc !== null || now - exited.at > RC_GRACE_MS) break
		} else {
			if (!killedReason && now - startMs > timeoutMs) killedReason = "timeout"
			if (!killedReason && inactivityKillMs > 0 && now - state.lastOutputAt > inactivityKillMs)
				killedReason = "inactivity"
			if (killedReason && !escalateAt) {
				killTree(child.pid, false)
				escalateAt = now + KILL_ESCALATE_MS
			} else if (escalateAt && now > escalateAt) {
				killTree(child.pid, true)
				escalateAt = now + KILL_ESCALATE_MS * 4
			}
			if (stopping) {
				killTree(child.pid, true)
				killedReason = killedReason || "agent_stopping"
			}
		}
		await sleep(TAIL_INTERVAL_MS)
	}

	pump(rawPath, stripPath, strip, state, true)

	const rcText = readTextOr(ctx.rc)
	const rcNum = rcText === null ? null : Number.parseInt(String(rcText).trim(), 10)
	const signal = exited && exited.signal ? exited.signal : null
	let finalState = "exited"
	let exitCode = Number.isFinite(rcNum) ? rcNum : exited && typeof exited.code === "number" ? exited.code : null
	if (killedReason || signal) {
		finalState = "killed"
		if (exitCode === null) exitCode = signal === "SIGKILL" ? 137 : 143
	}
	if (spawnError) {
		finalState = "lost"
		exitCode = null
	}
	// rc missing AND no numeric exit code means we genuinely do not know: that is
	// `lost`, never `unknown`, and never a guessed 0.
	if (finalState === "exited" && exitCode === null) finalState = "lost"

	const newCwd = (readTextOr(ctx.cwdOut) || "").trim() || null
	if (newCwd && !cmd.cwd) {
		try {
			fs.writeFileSync(stickyCwdPath(), newCwd)
		} catch {}
	}

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
		total_bytes: state.stripBytes,
		disk_free_mb: diskFreeMb(envDir()),
		spawn_error: spawnError ? String(spawnError.message || spawnError) : null,
	})

	await flush(id, stripPath, state, finalState, exitCode, Date.now() - startMs, true, {
		cwd_after: newCwd,
		killed_reason: killedReason,
		signal,
		disk_free_mb: diskFreeMb(envDir()),
	})

	if (!cmd.keep_raw) {
		try {
			fs.rmSync(rawPath, { force: true })
		} catch {}
	}
}

/** Read new bytes from out.raw, strip them, append to out.strip. */
function pump(rawPath, stripPath, strip, state, final) {
	let size = 0
	try {
		size = fs.statSync(rawPath).size
	} catch {
		return
	}
	if (size <= state.rawOffset && !final) return
	if (size > state.rawOffset) {
		const fd = fs.openSync(rawPath, "r")
		try {
			while (state.rawOffset < size) {
				const want = Math.min(256 * 1024, size - state.rawOffset)
				const buf = Buffer.allocUnsafe(want)
				const got = fs.readSync(fd, buf, 0, want, state.rawOffset)
				if (got <= 0) break
				state.rawOffset += got
				const out = strip(buf.subarray(0, got), false)
				if (out) {
					const bytes = Buffer.from(out, "utf8")
					fs.appendFileSync(stripPath, bytes)
					state.stripBytes += bytes.length
					state.lastOutputAt = Date.now()
				}
			}
		} finally {
			fs.closeSync(fd)
		}
	}
	if (final) {
		const out = strip(Buffer.alloc(0), true)
		if (out) {
			const bytes = Buffer.from(out, "utf8")
			fs.appendFileSync(stripPath, bytes)
			state.stripBytes += bytes.length
		}
	}
}

async function flush(id, stripPath, state, cmdState, exitCode, runtimeMs, eof, extra) {
	while (state.pushedBytes < state.stripBytes || (eof && state.pushedBytes === state.stripBytes)) {
		const start = state.pushedBytes
		const want = Math.min(PUSH_MAX_BYTES, state.stripBytes - start)
		let b64 = ""
		if (want > 0) {
			const fd = fs.openSync(stripPath, "r")
			try {
				const buf = Buffer.allocUnsafe(want)
				const got = fs.readSync(fd, buf, 0, want, start)
				b64 = buf.subarray(0, Math.max(0, got)).toString("base64")
				state.pushedBytes = start + Math.max(0, got)
			} finally {
				fs.closeSync(fd)
			}
		}
		const last = state.pushedBytes >= state.stripBytes
		await pushChunk({
			command_id: id,
			start_byte: start,
			bytes_b64: b64,
			total_bytes: state.stripBytes,
			state: last ? cmdState : "running",
			exit_code: last ? exitCode : null,
			runtime_ms: runtimeMs,
			eof: Boolean(eof && last),
			...(last ? extra || {} : {}),
		})
		state.lastPushAt = Date.now()
		if (want === 0) break
		if (last) break
	}
}

function resolveCwd(explicit) {
	if (explicit) return explicit
	const sticky = (readTextOr(stickyCwdPath()) || "").trim()
	if (sticky) {
		try {
			if (fs.statSync(sticky).isDirectory()) return sticky
		} catch {}
	}
	return workDir()
}

function loadSecrets() {
	const out = []
	const raw = readTextOr(path.join(envDir(), "redact.txt"), "")
	for (const line of String(raw).split(/\r?\n/)) {
		const v = line.trim()
		if (v) out.push(v)
	}
	if (CFG.brokerSecret) out.push(CFG.brokerSecret)
	if (CFG.token) out.push(CFG.token)
	return out
}

/* ---------------------------------------------------------------- control */

async function controlMain() {
	mkdirp(envDir())
	mkdirp(jobsDir())
	mkdirp(workDir())
	if (!fs.existsSync(overlayPath())) fs.writeFileSync(overlayPath(), "")
	if (!fs.existsSync(stickyCwdPath())) fs.writeFileSync(stickyCwdPath(), workDir())

	const enrolled = await enroll()
	if (!enrolled) {
		finish("enroll_failed", 1)
		return
	}

	let ttlExpiresAt = enrolled.ttl_expires_at || Date.now() + CFG.ttlMinutes * 60000
	const unreachableLimitMs = clamp(num(enrolled.unreachable_limit_s, 600), 60, 3600) * 1000
	const execWorkers = clamp(num(enrolled.exec_workers, CFG.execWorkers), 1, 8)
	if (Array.isArray(enrolled.redact) && enrolled.redact.length) {
		fs.writeFileSync(path.join(envDir(), "redact.txt"), enrolled.redact.join("\n"))
	}
	writeJson(statePath(), {
		env_id: CFG.envId,
		platform: PLATFORM,
		token: enrolled.agent_token,
		ttl_expires_at: ttlExpiresAt,
		enrolled_at: Date.now(),
	})

	const children = []
	for (let i = 0; i < execWorkers; i++) children.push(spawnExecWorker(i, enrolled.agent_token))

	let exitReason = "crash"
	let lastOkAt = Date.now()
	let attempt = 0

	try {
		while (!stopping) {
			if (Date.now() > ttlExpiresAt) {
				exitReason = "ttl"
				break
			}
			if (Date.now() - lastOkAt > unreachableLimitMs) {
				// The lease could not be renewed. Self-destruct so the env is reclaimed
				// even if the broker, the DO or the MCP session is gone for good.
				exitReason = "broker_unreachable"
				break
			}

			const r = await brokerReq("POST", `/agent/${encodeURIComponent(CFG.envId)}/control`, {
				token: enrolled.agent_token,
				body: {
					wait: CFG.waitSeconds,
					platform: PLATFORM,
					disk_free_mb: diskFreeMb(envDir()),
					running: listRunning(),
					agent_version: VERSION,
				},
				timeoutMs: (CFG.waitSeconds + 15) * 1000,
			})

			if (r.status === 410) {
				exitReason = "destroy_requested"
				break
			}
			if (r.status === 401 || r.status === 403) {
				exitReason = "unauthorized"
				break
			}
			if (r.status !== 200) {
				await sleep(jitter(700, attempt++))
				continue
			}
			attempt = 0
			lastOkAt = Date.now()

			const body = r.json || {}
			if (Number.isFinite(body.ttl_expires_at)) ttlExpiresAt = body.ttl_expires_at
			if (body.destroy) {
				exitReason = "destroy_requested"
				break
			}
			for (const action of body.actions || []) await handleAction(action, enrolled.agent_token)
		}
	} finally {
		stopping = true
		finish(exitReason, 0)
		for (const c of children) {
			try {
				c.kill("SIGKILL")
			} catch {}
		}
		killAllJobs(true)
	}
}

function spawnExecWorker(index, token) {
	// stdio 'ignore', never 'pipe': Node cannot tune a child's stdout highWaterMark,
	// so a chatty worker on a pipe would stall control's event loop.
	const child = spawn(
		process.execPath,
		[process.argv[1], "--role=exec"],
		{
			stdio: "ignore",
			detached: false,
			env: {
				...process.env,
				GHA_MCP_ROLE: "exec",
				GHA_MCP_WORKER: String(index),
				GHA_MCP_TOKEN: token,
			},
		},
	)
	child.unref()
	child.on("exit", (code) => {
		if (!stopping) log(`exec worker ${index} exited (${code}); respawning`)
	})
	return child
}

async function handleAction(action, token) {
	if (!action || !action.type) return
	switch (action.type) {
		case "ping":
			return
		case "kill": {
			const ids = action.command_id === "all" ? listJobIds() : [String(action.command_id)]
			for (const id of ids) {
				const pid = Number.parseInt(readTextOr(path.join(jobDir(id), "pid"), "") || "", 10)
				if (Number.isFinite(pid)) killTree(pid, action.signal === "KILL")
			}
			return
		}
		case "pull": {
			// Serve an arbitrary byte range that the broker no longer holds.
			const id = String(action.command_id)
			const p = path.join(jobDir(id), "out.strip")
			let b64 = ""
			let total = 0
			try {
				total = fs.statSync(p).size
				const from = clamp(num(action.from_byte, 0), 0, total)
				const want = Math.min(clamp(num(action.max_bytes, PUSH_MAX_BYTES), 1, 256 * 1024), total - from)
				if (want > 0) {
					const fd = fs.openSync(p, "r")
					try {
						const buf = Buffer.allocUnsafe(want)
						const got = fs.readSync(fd, buf, 0, want, from)
						b64 = buf.subarray(0, Math.max(0, got)).toString("base64")
					} finally {
						fs.closeSync(fd)
					}
				}
				await pushChunkAs(token, {
					req_id: action.req_id,
					command_id: id,
					start_byte: num(action.from_byte, 0),
					bytes_b64: b64,
					total_bytes: total,
					state: jobState(id),
					pull: true,
				})
			} catch (e) {
				await pushChunkAs(token, {
					req_id: action.req_id,
					command_id: id,
					start_byte: num(action.from_byte, 0),
					bytes_b64: "",
					total_bytes: 0,
					state: "lost",
					pull: true,
					agent_error: String((e && e.message) || e),
				})
			}
			return
		}
		case "overlay": {
			fs.writeFileSync(overlayPath(), String(action.content || ""))
			return
		}
		case "chdir": {
			if (action.cwd) fs.writeFileSync(stickyCwdPath(), String(action.cwd))
			return
		}
		default:
			log(`unknown action ${action.type}`)
	}
}

async function pushChunkAs(token, payload) {
	const saved = CFG.token
	CFG.token = token
	try {
		return await pushChunk(payload)
	} finally {
		CFG.token = saved
	}
}

function listJobIds() {
	try {
		return fs.readdirSync(jobsDir())
	} catch {
		return []
	}
}

function jobState(id) {
	const meta = readTextOr(path.join(jobDir(id), "meta.json"))
	if (meta) {
		try {
			return JSON.parse(meta).state || "exited"
		} catch {}
	}
	if (fs.existsSync(path.join(jobDir(id), "pid"))) return "running"
	if (fs.existsSync(path.join(jobDir(id), "started_at"))) return "lost"
	return "lost"
}

function listRunning() {
	const out = []
	for (const id of listJobIds()) {
		if (fs.existsSync(path.join(jobDir(id), "meta.json"))) continue
		const pid = Number.parseInt(readTextOr(path.join(jobDir(id), "pid"), "") || "", 10)
		const started = Number.parseInt(readTextOr(path.join(jobDir(id), "started_at"), "") || "", 10)
		let alive = false
		if (Number.isFinite(pid)) {
			try {
				process.kill(pid, 0)
				alive = true
			} catch {}
		}
		// started_at present but no pid for >5s means the worker died between the
		// marker and spawn: report `lost`, not `unknown`, and say re-running is safe.
		const spawnGap = !Number.isFinite(pid) && Number.isFinite(started) && Date.now() - started > 5000
		out.push({
			command_id: id,
			state: spawnGap ? "lost" : alive ? "running" : "running",
			spawn_gap: spawnGap,
			started_at: Number.isFinite(started) ? started : null,
		})
	}
	return out
}

function killAllJobs(hard) {
	for (const id of listJobIds()) {
		const pid = Number.parseInt(readTextOr(path.join(jobDir(id), "pid"), "") || "", 10)
		if (Number.isFinite(pid)) killTree(pid, hard)
	}
}

/**
 * Write exit_reason BEFORE anything else tears the job down, so a job that shows
 * up as "cancelled" in the Actions UI is still distinguishable from a TTL expiry.
 */
function finish(reason, code) {
	try {
		writeJson(metaPath(), {
			env_id: CFG.envId,
			platform: PLATFORM,
			exit_reason: reason,
			at: Date.now(),
			agent_version: VERSION,
		})
	} catch {}
	log(`exit_reason=${reason}`)
	process.exitCode = code
}

async function enroll() {
	for (let attempt = 0; attempt < 8; attempt++) {
		const nonce = crypto.randomBytes(16).toString("hex")
		const ts = String(Math.floor(Date.now() / 1000))
		const msg = [CFG.envId, CFG.runId, CFG.runAttempt, nonce, ts].join("\n")
		const sig = crypto.createHmac("sha256", CFG.brokerSecret).update(msg).digest("hex")
		const r = await brokerReq("POST", `/agent/${encodeURIComponent(CFG.envId)}/hello`, {
			headers: {
				"x-env-id": CFG.envId,
				"x-run-id": CFG.runId,
				"x-run-attempt": CFG.runAttempt,
				"x-nonce": nonce,
				"x-ts": ts,
				"x-sig": sig,
			},
			body: {
				platform: PLATFORM,
				node_version: process.version,
				os_release: `${os.type()} ${os.release()}`,
				cpu_count: os.cpus().length,
				mem_mb: Math.floor(os.totalmem() / (1024 * 1024)),
				disk_free_mb: diskFreeMb(envDir()),
				shell_default: IS_WIN ? "pwsh" : "bash",
				term: process.env.TERM || null,
				work_dir: workDir(),
				ttl_minutes: CFG.ttlMinutes,
				run_url: `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${process.env.GITHUB_REPOSITORY || ""}/actions/runs/${CFG.runId}`,
				agent_version: VERSION,
			},
			timeoutMs: 25000,
		})
		if (r.status === 200 && r.json && r.json.agent_token) return r.json
		// A rejected enroll is terminal by design (enroll is one-shot); only retry
		// transport-level failures.
		if (r.status >= 400 && r.status < 500) {
			log(`enroll rejected: ${r.status} ${r.text.slice(0, 200)}`)
			return null
		}
		log(`enroll attempt ${attempt + 1} failed: ${r.status} ${r.text.slice(0, 120)}`)
		await sleep(jitter(1000, attempt))
	}
	return null
}

/* -------------------------------------------------------------------- main */

function parseRole() {
	for (const a of process.argv.slice(2)) {
		const m = /^--role=(.+)$/.exec(a)
		if (m) return m[1]
	}
	return process.env.GHA_MCP_ROLE || "control"
}

for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, () => {
		stopping = true
	})
}

const role = parseRole()
process.env.GHA_MCP_ROLE = role

if (!CFG.envId || !CFG.brokerUrl) {
	log("GHA_MCP_ENV_ID and BROKER_URL are required")
	process.exit(2)
}

if (role === "exec") {
	if (!CFG.token) {
		log("GHA_MCP_TOKEN is required for --role=exec")
		process.exit(2)
	}
	execWorkerMain().catch((e) => {
		log(`exec worker fatal: ${e && e.stack}`)
		process.exit(1)
	})
} else {
	controlMain().catch((e) => {
		log(`control fatal: ${e && e.stack}`)
		finish("crash", 1)
		process.exit(1)
	})
}
