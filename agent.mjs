#!/usr/bin/env node
/*
 * gha-mcp runner agent — one file plus one vendored module, zero npm deps, Node >= 20.
 *
 *   node agent.mjs --role=control    enroll, hold the /control long-poll, own the TTL
 *                                    lease, spawn exec workers, be the sole killer
 *   node agent.mjs --role=exec       hold the /next long-poll, run one command at a time
 *
 * INVARIANTS. These were argued out over four debate sessions; each one exists
 * because its absence produced a specific, reproducible failure in the previous
 * generation of this system. Do not "simplify" them away.
 *
 *  1. Completion is decided by the process exit event, corroborated by the `rc`
 *     file. Never by stdout EOF. An orphaned grandchild keeps the write end of
 *     stdout open long after the shell is gone, so EOF means nothing.
 *
 *  2. No pipes anywhere in the output path. The child receives ONE O_APPEND file
 *     descriptor on out.raw as both stdout and stderr. Node cannot tune a child's
 *     stdout high-water mark, so a chatty child on a pipe stalls this process —
 *     that was the old system's number one bug ("command timed out after 30s").
 *     Handing both slots the same fd also makes the kernel serialise the
 *     interleave, which is the only portable way to preserve merge order.
 *
 *  3. There is exactly ONE output file per command, out.raw, and the cursor is a
 *     raw byte offset into it. No rotation, no second stripped file. ANSI
 *     stripping and secret redaction are READ-TIME transforms applied by the
 *     broker to a window, so they can never move the cursor. This is what makes
 *     a retry after `MCP error -32001` re-read byte-identical content: the
 *     server holds no per-reader position at all, like an HTTP Range request.
 *
 *  4. The agent never reads the child's bytes in order to forward them as text.
 *     It fstat()s for the size and pread()s ranges, then base64s them. Positional
 *     reads do not touch a shared file offset, so two concurrent reads of
 *     different ranges cannot interfere.
 *
 *  5. Duplicate delivery is expected. Exclusion is a runner-side O_EXCL marker,
 *     not a broker lock.
 *
 *  6. Disconnection is a normal event on this transport, not an exception:
 *     reconnect immediately with jittered backoff.
 *
 *  7. killed_reason is single-valued with a FIXED priority:
 *         enospc > output_cap > timeout | inactivity > user > spawn_gap
 *     `enospc` is set ONLY when one of the agent's OWN writes actually returns
 *     ENOSPC. A file that stops growing while statfs reports zero free blocks is
 *     `inactivity` plus an advisory warning — "no output" is ALWAYS `inactivity`.
 *     Getting this backwards persists a permanent mislabel into the broker's
 *     storage, because `cargo build`, `npm ci` and `sleep` all look identical to
 *     a disk-full stall from the outside.
 *
 *  8. fs.watch is banned. It is unreliable on macOS and Windows, and every fs API
 *     except the explicitly synchronous ones goes through the libuv threadpool.
 *     Growth is detected with synchronous fstat on the read-only fd.
 *
 *  9. worker_threads must never be imported. libuv#1490 (two threads calling
 *     uv_spawn can inherit each other's handles) is only closed for us because
 *     this process is single-threaded. CI greps for it.
 *
 * 10. Windows PowerShell 5.1 is never used and never substituted for pwsh. It is
 *     a different product that installs side-by-side with PowerShell 7, and its
 *     redirection operators corrupt byte streams. Absence of pwsh is reported as
 *     a precondition failure, not papered over with a fallback.
 */

import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"

import { killProcessGroup } from "./vendor/process-utils.mjs"

const VERSION = "0.2.0"

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

/* --------------------------------------------------------- tail clock tuning */

// The tail poll interval is not a constant. A fixed 120 ms was safe for a chatty
// build and catastrophic for `yes`, which was measured at 10.2 GiB/s: a runner
// with 14 GB free fills the disk in under two seconds, so any fixed interval is
// either wasteful or too late. Instead the interval is derived feedforward from
// how fast the disk could possibly be consumed before the next look.
const POLL_MIN_MS = 3 // control-loop latency floor, not a CPU limit
const POLL_MAX_MS = 100
const R_MAX_SEED = 10 * 1024 * 1024 * 1024 // 10 GiB/s, the measured `yes` rate
const R_MAX_DECAY = 0.9 // a running max must decay or it never comes back down
const FREE_HEADROOM = 0.5 // never plan to consume more than half the free space

const PUSH_IDLE_MS = 400
const PUSH_SIZE_BYTES = 32 * 1024
const PUSH_MAX_BYTES = 64 * 1024
const PREAD_CHUNK = 256 * 1024
const STATFS_INTERVAL_MS = 250
const RC_GRACE_MS = 3000
const KILL_ESCALATE_MS = 3000
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024 * 1024

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
const shellsPath = () => path.join(envDir(), "shells.json")
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
function readTextOr(p, d = null) {
	try {
		return fs.readFileSync(p, "utf8")
	} catch {
		return d
	}
}
function readJsonOr(p, d = null) {
	const t = readTextOr(p)
	if (t === null) return d
	try {
		return JSON.parse(t)
	} catch {
		return d
	}
}

/* ------------------------------------------------------------ ENOSPC guards */

// Invariant 7. This timestamp is the ONLY thing allowed to produce
// killed_reason='enospc', and it is only ever set from a real failed write.
let enospcAt = null

function isNoSpace(e) {
	return Boolean(e) && (e.code === "ENOSPC" || e.code === "EDQUOT" || e.code === "EFBIG")
}

/** Run a write; remember a genuine out-of-space failure; rethrow. */
function guarded(fn) {
	try {
		return fn()
	} catch (e) {
		if (isNoSpace(e)) enospcAt = Date.now()
		throw e
	}
}

/** Run a write; remember out-of-space; swallow everything else. */
function guardedQuiet(fn) {
	try {
		return fn()
	} catch (e) {
		if (isNoSpace(e)) enospcAt = Date.now()
		return null
	}
}

function mkdirp(p) {
	return guarded(() => fs.mkdirSync(p, { recursive: true }))
}

function writeJson(p, obj) {
	const tmp = `${p}.tmp`
	return guardedQuiet(() => {
		fs.writeFileSync(tmp, JSON.stringify(obj))
		fs.renameSync(tmp, p)
	})
}

/**
 * Free bytes on the volume holding `p`, or null.
 *
 * `bavail` is "available blocks for unprivileged users". On APFS it EXCLUDES
 * purgeable space (Disk Utility showing "255.34 GB available (145.56 GB
 * purgeable)" corresponds to `df` reporting 110G), so on macOS this
 * UNDER-reports. That direction is safe: it only shortens the poll interval.
 * It is never a kill trigger — see invariant 7.
 */
function diskFreeBytes(p) {
	try {
		const s = fs.statfsSync(p)
		return Number(s.bavail) * Number(s.bsize)
	} catch {
		return null
	}
}

function diskFreeMb(p) {
	const b = diskFreeBytes(p)
	return b === null ? null : Math.floor(b / (1024 * 1024))
}

/**
 * `bavail === 0` is advisory. Confirm it with a real one-byte write, because a
 * real failed write is the only admissible evidence for killed_reason='enospc'.
 * Also relevant: a write that hits ENOSPC can be PARTIAL, and later writes can
 * interleave into the gap, so "the disk is full" and "the output is intact" are
 * independent facts.
 */
function confirmNoSpace(dir) {
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
			enospcAt = Date.now()
			return true
		}
		return false
	}
}

/* -------------------------------------------------------------- tail clock */

/**
 * Feedforward tail clock.
 *
 *   interval = clamp(free * 0.5 / (n * r_max), 3ms, 100ms)
 *
 * `r_max` is a DECAYING running maximum of the observed write rate, seeded at
 * the measured `yes` throughput. A plain running max would latch at the peak of
 * one `tar` and never recover; the 0.9 factor lets it fall back.
 *
 * `n` is the number of exec workers, because they share one volume.
 */
function makeTailClock(concurrency) {
	let rMax = R_MAX_SEED
	let lastSize = 0
	let lastAt = Date.now()
	const n = Math.max(1, concurrency)
	return {
		next(size, freeBytes) {
			const now = Date.now()
			const dt = Math.max(1, now - lastAt)
			const grew = Math.max(0, size - lastSize)
			const rObs = (grew * 1000) / dt
			rMax = Math.max(rObs, rMax * R_MAX_DECAY, 1)
			lastSize = size
			lastAt = now
			const free = Number.isFinite(freeBytes) && freeBytes > 0 ? freeBytes : R_MAX_SEED
			const ms = (free * FREE_HEADROOM * 1000) / (n * rMax)
			return clamp(Math.floor(ms), POLL_MIN_MS, POLL_MAX_MS)
		},
		get rate() {
			return rMax
		},
	}
}

/* -------------------------------------------------------------- broker HTTP */

/**
 * HTTP to the broker. Returns { status, json, text } and never throws for
 * network failures — "broker unreachable" is a normal event on this transport,
 * not an exception, so the caller decides.
 *
 * The deadline is ABSOLUTE. A per-attempt timeout that resets is how
 * actions-runner-controller#4191 kept a dead container alive forever
 * (4 -> 3 -> 2 -> 1 -> 4 -> ...); the whole point of a deadline is that it
 * cannot be refreshed by making progress on the wrong thing.
 *
 * A 200 whose body is not a JSON object is reported as status 0, because a proxy
 * or a captive portal answering 200 with HTML is a transport failure wearing a
 * success code.
 */
async function brokerReq(method, pathname, opts = {}) {
	const { token, body, timeoutMs = 20000, headers = {}, deadlineAt } = opts
	if (!CFG.brokerUrl) return { status: 0, json: null, text: "BROKER_URL unset" }
	const budget = deadlineAt ? Math.min(timeoutMs, deadlineAt - Date.now()) : timeoutMs
	if (budget <= 0) return { status: 0, json: null, text: "deadline exceeded before send" }
	const ac = new AbortController()
	const timer = setTimeout(() => ac.abort(), budget)
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

/* ------------------------------------------------------------------- shells */

let SHELLS = null

/**
 * Which shells actually exist here. Published as facts.shells at enroll so the
 * broker can reject `shell:'pwsh'` up front instead of failing a command later.
 *
 * PowerShell 7 does not replace Windows PowerShell 5.1 — Microsoft installs it
 * to a separate directory and the two run side-by-side — and actions/runner#3415
 * records that explicit `pwsh` deliberately does NOT fall back to Desktop. We
 * take the same position, loudly.
 */
function probeShells() {
	const ver = (exe, args) => {
		try {
			const r = spawnSync(exe, args, {
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 8000,
				windowsHide: true,
				encoding: "utf8",
			})
			if (r && r.status === 0 && r.stdout) {
				return String(r.stdout).trim().split(/\r?\n/)[0].slice(0, 120)
			}
		} catch {
			/* not installed */
		}
		return null
	}
	return {
		pwsh: ver(IS_WIN ? "pwsh.exe" : "pwsh", ["-v"]),
		bash: ver(IS_WIN ? "bash.exe" : "/bin/bash", ["--version"]),
		sh: IS_WIN ? null : ver("/bin/sh", ["-c", "echo /bin/sh"]),
		zsh: IS_WIN ? null : ver("zsh", ["--version"]),
		cmd: IS_WIN ? process.env.COMSPEC || "cmd.exe" : null,
	}
}

function shells() {
	if (SHELLS) return SHELLS
	SHELLS = readJsonOr(shellsPath(), null) || probeShells()
	return SHELLS
}

const SHELL_KINDS = {
	pwsh: { kind: "pwsh", ext: ".ps1" },
	bash: { kind: "bash", ext: ".sh" },
	sh: { kind: "sh", ext: ".sh" },
	zsh: { kind: "zsh", ext: ".sh" },
	cmd: { kind: "cmd", ext: ".cmd" },
}

function shellPlan(requested) {
	const want = String(requested || (IS_WIN ? "pwsh" : "bash")).toLowerCase()
	if (want === "powershell") {
		return {
			ok: false,
			error:
				"shell 'powershell' (Windows PowerShell 5.1) is not supported: its redirection " +
				"operators corrupt byte streams and it is a separate side-by-side product. Use shell:'pwsh'.",
		}
	}
	const plan = SHELL_KINDS[want]
	if (!plan) {
		return { ok: false, error: `unknown shell '${want}'; expected one of ${Object.keys(SHELL_KINDS).join(", ")}` }
	}
	const have = shells()
	if (!have[plan.kind]) {
		return {
			ok: false,
			error: `shell '${want}' is not present on this ${PLATFORM} runner (facts.shells.${plan.kind} is null). No fallback is attempted by design.`,
		}
	}
	return { ok: true, ...plan }
}

/* ------------------------------------------------------------ shell wrapper */

function q(s) {
	return `'${String(s).replace(/'/g, "'\\''")}'`
}
function pq(s) {
	return `'${String(s).replace(/'/g, "''")}'`
}

function posixScript(cmd, ctx) {
	const shebang =
		ctx.kind === "sh" ? "/bin/sh" : ctx.kind === "zsh" ? "/usr/bin/env zsh" : "/usr/bin/env bash"
	// actions/runner's documented POSIX invocation is
	//     bash --noprofile --norc -eo pipefail {0}
	// (docs/adrs/0277-run-action-shell-options.md). We keep `pipefail` and
	// deliberately drop `-e`: the caller sends multi-command input, and `-e` aborts
	// the whole script on the first non-zero status — including `tput` under
	// TERM=dumb, which exits 3.
	//
	// Note what is NOT here: `exec 0</dev/null`. stdin is already a real file (see
	// invariant 2), and the old version of this script threw away caller-supplied
	// stdin by reopening fd 0.
	return (
		`#!${shebang}\n` +
		`set -o pipefail 2>/dev/null || true\n` +
		`cd ${q(ctx.cwd)} || exit 127\n` +
		`if [ -f ${q(ctx.overlay)} ]; then . ${q(ctx.overlay)}; fi\n` +
		`{\n${cmd}\n}\n` +
		`__gha_rc=$?\n` +
		`pwd > ${q(ctx.cwdOut)} 2>/dev/null || true\n` +
		`printf '%s' "$__gha_rc" > ${q(ctx.rc)}.tmp 2>/dev/null && mv -f ${q(ctx.rc)}.tmp ${q(ctx.rc)} 2>/dev/null\n` +
		`exit $__gha_rc\n`
	)
}

function pwshScript(cmd, ctx) {
	// The first and last lines are taken VERBATIM from actions/runner
	// src/Runner.Worker/Handlers/ScriptHandlerHelpers.cs (MIT):
	//
	//   var prepend = "$ErrorActionPreference = 'stop'";
	//   var append  = @"if ((Test-Path -LiteralPath variable:\LASTEXITCODE)) { exit $LASTEXITCODE }";
	//
	// The append is the fix for the old system's worst symptom. `pwsh -File` leaves
	// $LASTEXITCODE unset and defaults a script's own exit status to 0
	// (about_Automatic_Variables; PowerShell#11461), so a failed build was reported
	// as `exit 0` with "command produced no output". Azure DevOps' PowerShell@2 task
	// arrived at the same one-line fix independently.
	//
	// Encoding is pinned here, in the shell, rather than guessed by the reader:
	// [Console]::OutputEncoding decides how pwsh DECODES a native program's output
	// (PowerShell#14945) and $OutputEncoding decides how it ENCODES text piped INTO
	// one (PowerShell#7233). Both are required; setting only the first was a bug.
	//
	// There is no `2>&1` and no `>` redirection anywhere: the merge happens at the
	// file-descriptor level (invariant 2). PowerShell's own redirection is not
	// byte-transparent before 7.4 and mangles native output.
	return [
		`$ErrorActionPreference = 'stop'`,
		`$ProgressPreference = 'SilentlyContinue'`,
		`try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}`,
		`try { [Console]::InputEncoding  = [System.Text.UTF8Encoding]::new($false) } catch {}`,
		`try { $OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}`,
		`try { if ($PSStyle) { $PSStyle.OutputRendering = 'PlainText' } } catch {}`,
		`Set-Location -LiteralPath ${pq(ctx.cwd)}`,
		`if (Test-Path -LiteralPath ${pq(ctx.overlay)}) {`,
		`  Get-Content -LiteralPath ${pq(ctx.overlay)} | ForEach-Object {`,
		`    if ($_ -match '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {`,
		`      [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2])`,
		`    }`,
		`  }`,
		`}`,
		`$global:LASTEXITCODE = $null`,
		`& {`,
		String(cmd),
		`}`,
		// Capture immediately: every line below would clobber $LASTEXITCODE and $?.
		`$__gha_rc = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }`,
		`try { (Get-Location).Path | Set-Content -LiteralPath ${pq(ctx.cwdOut)} -NoNewline } catch {}`,
		`try { Set-Content -LiteralPath ${pq(ctx.rc)} -Value "$__gha_rc" -NoNewline } catch {}`,
		`$global:LASTEXITCODE = $__gha_rc`,
		`if ((Test-Path -LiteralPath variable:\\LASTEXITCODE)) { exit $LASTEXITCODE }`,
		``,
	].join("\n")
}

function cmdScript(cmd, ctx) {
	return (
		`@echo off\r\n` +
		`chcp 65001 >nul 2>nul\r\n` +
		`cd /d "${ctx.cwd}"\r\n` +
		`${String(cmd).replace(/\r?\n/g, "\r\n")}\r\n` +
		`set __gha_rc=%ERRORLEVEL%\r\n` +
		`cd > "${ctx.cwdOut}"\r\n` +
		`<nul set /p=%__gha_rc%> "${ctx.rc}"\r\n` +
		`exit /b %__gha_rc%\r\n`
	)
}

function spawnArgs(kind, scriptPath) {
	switch (kind) {
		case "pwsh":
			// actions/runner's docs say `pwsh -command ". '{0}'"` while its own ADR says
			// `"& '{0}'"` — upstream disagrees with itself. We diverge on purpose and
			// use -File, which is only safe BECAUSE of the appended LASTEXITCODE
			// epilogue above. -NoProfile and -NonInteractive are additions too: the
			// runner passes neither, but a profile on a self-hosted box must not be able
			// to undo our encoding setup, and an interactive prompt behind a non-TTY
			// stdin hangs forever.
			return [
				IS_WIN ? "pwsh.exe" : "pwsh",
				[
					"-NoLogo",
					"-NoProfile",
					"-NonInteractive",
					"-ExecutionPolicy",
					"Bypass",
					"-File",
					scriptPath,
				],
			]
		case "cmd":
			// /V:OFF matters: with delayed expansion on, a literal `!` in the caller's
			// command is silently eaten. actions/runner uses
			//   %ComSpec% /D /E:ON /V:OFF /S /C "CALL "{0}""
			return [process.env.COMSPEC || "cmd.exe", ["/d", "/e:on", "/v:off", "/s", "/c", scriptPath]]
		case "sh":
			return ["/bin/sh", [scriptPath]]
		case "zsh":
			return ["zsh", [scriptPath]]
		default:
			return [IS_WIN ? "bash.exe" : "/bin/bash", ["--noprofile", "--norc", scriptPath]]
	}
}

function childEnv(extra) {
	const e = { ...process.env }
	for (const k of Object.keys(e)) {
		if (SCRUB_EXACT.includes(k) || SCRUB_PREFIXES.some((p) => k.startsWith(p))) delete e[k]
	}
	// TERM is intentionally unset: a bare TERM makes tools emit escapes with no
	// terminal to interpret them, and TERM=dumb makes `tput` exit 3.
	delete e.TERM
	e.CI = "1"
	// about_ANSI_Terminals: "If $Env:NO_COLOR exists, then $PSStyle.OutputRendering
	// is set to PlainText". Belt and braces with the preamble above.
	e.NO_COLOR = "1"
	e.GIT_TERMINAL_PROMPT = "0"
	e.DEBIAN_FRONTEND = "noninteractive"
	return { ...e, ...(extra || {}) }
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
				bytes_written: 0,
				state: "lost",
				exit_code: null,
				runtime_ms: 0,
				eof: true,
				killed_reason: enospcAt ? "enospc" : null,
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

	// O_EXCL is the whole exclusion mechanism. /next may deliver the same command
	// twice (that is expected); only one worker can create this file.
	const startedAt = path.join(dir,