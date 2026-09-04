/*
 * The control role.
 *
 * Exactly one of these runs per environment. It owns the TTL lease, spawns the
 * exec workers, serves control actions, and is the only process allowed to kill
 * a process tree. Splitting this from the exec role is what stops a chatty
 * command from delaying the lease renewal that keeps the environment alive.
 */

import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"

import { killProcessGroup } from "../vendor/process-utils.mjs"
import {
	CFG,
	KILL_ESCALATE_MS,
	PLATFORM,
	PUSH_MAX_BYTES,
	SPAWN_GAP_MS,
	VERSION,
	envDir,
	jobDir,
	jobsDir,
	metaPath,
	overlayPath,
	redactPath,
	shellsPath,
	statePath,
	stickyCwdPath,
	workDir,
} from "./config.mjs"
import { brokerReq, pushChunk } from "./broker.mjs"
import { killMarkerPath, outRawPath, readRange } from "./exec.mjs"
import { probeShells } from "./shell.mjs"
import { run } from "./state.mjs"
import {
	clamp,
	diskFreeMb,
	guardedQuiet,
	jitter,
	log,
	mkdirp,
	num,
	readTextOr,
	sleep,
	writeJson,
} from "./util.mjs"

/* ------------------------------------------------------------- job  survey */

export function listJobIds() {
	try {
		return fs.readdirSync(jobsDir())
	} catch {
		return []
	}
}

function jobPid(id) {
	const pid = Number.parseInt(readTextOr(path.join(jobDir(id), "pid"), "") || "", 10)
	return Number.isFinite(pid) ? pid : null
}

export function jobState(id) {
	const meta = readTextOr(path.join(jobDir(id), "meta.json"))
	if (meta) {
		try {
			return JSON.parse(meta).state || "exited"
		} catch {
			/* fall through */
		}
	}
	if (fs.existsSync(path.join(jobDir(id), "pid"))) return "running"
	return "lost"
}

/**
 * What is still in flight, for the lease renewal payload.
 *
 * `spawn_gap` is the interesting case: the O_EXCL marker exists but no pid file
 * followed it, which means the exec worker died between claiming the command and
 * spawning it. That is reported as `lost` with spawn_gap set, so the broker can
 * tell the caller re-running is safe. The old system reported this as
 * `state: unknown, output_bytes: 0` and left the caller guessing.
 */
export function listRunning() {
	const out = []
	for (const id of listJobIds()) {
		if (fs.existsSync(path.join(jobDir(id), "meta.json"))) continue
		const pid = jobPid(id)
		const started = Number.parseInt(
			readTextOr(path.join(jobDir(id), "started_at"), "") || "",
			10,
		)
		let alive = false
		if (pid !== null) {
			try {
				process.kill(pid, 0)
				alive = true
			} catch {
				/* gone or not ours */
			}
		}
		const spawnGap =
			pid === null && Number.isFinite(started) && Date.now() - started > SPAWN_GAP_MS
		out.push({
			command_id: id,
			state: spawnGap ? "lost" : "running",
			alive,
			spawn_gap: spawnGap,
			started_at: Number.isFinite(started) ? started : null,
		})
	}
	return out
}

async function killAllJobs(hard) {
	for (const id of listJobIds()) {
		const pid = jobPid(id)
		if (pid === null) continue
		await killProcessGroup({
			pid,
			escalate: !hard,
			signal: hard ? "SIGKILL" : undefined,
			escalateMs: KILL_ESCALATE_MS,
		}).catch(() => {})
	}
}

/* ---------------------------------------------------------------- actions */

export async function handleAction(action, token) {
	if (!action || !action.type) return
	switch (action.type) {
		case "ping":
			return

		case "kill": {
			const ids = action.command_id === "all" ? listJobIds() : [String(action.command_id)]
			for (const id of ids) {
				// Drop the marker BEFORE signalling, so the exec loop attributes the death
				// to 'user' instead of racing and calling it 'inactivity'.
				guardedQuiet(() => fs.writeFileSync(killMarkerPath(id), "user"))
				const pid = jobPid(id)
				if (pid === null) continue
				await killProcessGroup({
					pid,
					escalate: action.signal !== "KILL",
					signal: action.signal === "KILL" ? "SIGKILL" : undefined,
					escalateMs: KILL_ESCALATE_MS,
				}).catch(() => {})
			}
			return
		}

		case "pull": {
			// Serve a raw byte range the broker no longer holds. This is why out.raw is
			// never deleted, and why the broker can get away with a bounded tail.
			const id = String(action.command_id)
			const from = num(action.from_byte, 0)
			try {
				const want = clamp(num(action.max_bytes, PUSH_MAX_BYTES), 1, 256 * 1024)
				const { total, bytes } = readRange(outRawPath(id), from, want)
				await pushChunk(
					{
						req_id: action.req_id,
						command_id: id,
						start_byte: from,
						bytes_b64: bytes.toString("base64"),
						total_bytes: total,
						bytes_written: total,
						state: jobState(id),
						pull: true,
					},
					token,
				)
			} catch (e) {
				await pushChunk(
					{
						req_id: action.req_id,
						command_id: id,
						start_byte: from,
						bytes_b64: "",
						total_bytes: 0,
						bytes_written: 0,
						state: "lost",
						pull: true,
						agent_error: String((e && e.message) || e),
					},
					token,
				)
			}
			return
		}

		case "overlay":
			guardedQuiet(() => fs.writeFileSync(overlayPath(), String(action.content || "")))
			return

		case "chdir":
			if (action.cwd) guardedQuiet(() => fs.writeFileSync(stickyCwdPath(), String(action.cwd)))
			return

		default:
			log(`unknown action ${action.type}`)
	}
}

/* ----------------------------------------------------------------- enroll */

async function enroll(shells) {
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
				// Recorded because libuv#1490 is only closed for us by being
				// single-threaded, and knowing the exact libuv build makes that auditable.
				uv_version: process.versions.uv || null,
				os_release: `${os.type()} ${os.release()}`,
				cpu_count: os.cpus().length,
				mem_mb: Math.floor(os.totalmem() / (1024 * 1024)),
				disk_free_mb: diskFreeMb(envDir()),
				// The whole point of publishing this: a bad `shell:` can be refused before
				// a command is queued rather than failing later, and pwsh is never
				// silently replaced by Windows PowerShell 5.1.
				shells,
				shell_default: PLATFORM === "windows" ? "pwsh" : "bash",
				term: process.env.TERM || null,
				work_dir: workDir(),
				root_dir: CFG.root,
				ttl_minutes: CFG.ttlMinutes,
				run_url: `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${
					process.env.GITHUB_REPOSITORY || ""
				}/actions/runs/${CFG.runId}`,
				agent_version: VERSION,
			},
			timeoutMs: 25000,
		})
		if (r.status === 200 && r.json && r.json.agent_token) return r.json
		// A rejected enroll is terminal by design -- enroll is one-shot, so a 4xx
		// means this run will never be allowed to serve this env. Only retry
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

/**
 * Record why we are going away BEFORE anything else tears the job down. Without
 * this, a TTL expiry and a cancelled workflow look identical afterwards.
 */
function finish(reason, code) {
	writeJson(metaPath(), {
		env_id: CFG.envId,
		platform: PLATFORM,
		exit_reason: reason,
		at: Date.now(),
		agent_version: VERSION,
	})
	log(`exit_reason=${reason}`)
	process.exitCode = code
}

function spawnExecWorker(index, token) {
	// stdio 'ignore', never 'pipe'. Node cannot tune a child's stdout high-water
	// mark, so a chatty worker on a pipe would stall this process's event loop --
	// and stalling this process means the lease stops being renewed.
	const child = spawn(process.execPath, [process.argv[1], "--role=exec"], {
		stdio: "ignore",
		detached: false,
		env: {
			...process.env,
			GHA_MCP_ROLE: "exec",
			GHA_MCP_WORKER: String(index),
			GHA_MCP_TOKEN: token,
		},
	})
	child.unref()
	child.on("exit", (code) => {
		if (!run.stopping) log(`exec worker ${index} exited (${code})`)
	})
	return child
}

/* ------------------------------------------------------------------- main */

export async function controlMain() {
	mkdirp(envDir())
	mkdirp(jobsDir())
	mkdirp(workDir())
	if (!fs.existsSync(overlayPath())) guardedQuiet(() => fs.writeFileSync(overlayPath(), ""))
	if (!fs.existsSync(stickyCwdPath()))
		guardedQuiet(() => fs.writeFileSync(stickyCwdPath(), workDir()))

	// Probe before enrolling and persist the result, so the exec workers use the
	// same answer that was advertised to the broker.
	const shells = probeShells()
	writeJson(shellsPath(), shells)
	log(`shells: ${JSON.stringify(shells)}`)

	const enrolled = await enroll(shells)
	if (!enrolled) {
		finish("enroll_failed", 1)
		return
	}

	let ttlExpiresAt = enrolled.ttl_expires_at || Date.now() + CFG.ttlMinutes * 60000
	const unreachableLimitMs = clamp(num(enrolled.unreachable_limit_s, 600), 60, 3600) * 1000
	const execWorkers = clamp(num(enrolled.exec_workers, CFG.execWorkers), 1, 8)
	if (Array.isArray(enrolled.redact) && enrolled.redact.length) {
		guardedQuiet(() => fs.writeFileSync(redactPath(), enrolled.redact.join("\n")))
	}
	writeJson(statePath(), {
		env_id: CFG.envId,
		platform: PLATFORM,
		ttl_expires_at: ttlExpiresAt,
		enrolled_at: Date.now(),
		agent_version: VERSION,
	})

	const children = []
	for (let i = 0; i < execWorkers; i++) children.push(spawnExecWorker(i, enrolled.agent_token))

	let exitReason = "crash"
	let lastOkAt = Date.now()
	let attempt = 0

	try {
		while (!run.stopping) {
			if (Date.now() > ttlExpiresAt) {
				exitReason = "ttl"
				break
			}
			if (Date.now() - lastOkAt > unreachableLimitMs) {
				// The lease could not be renewed. Self-destruct so the environment is
				// reclaimed even if the broker, the Durable Object or the MCP session is
				// gone for good. A runner that outlives its controller is a billing leak
				// and, worse, a shell nobody is watching.
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
		run.stopping = true
		finish(exitReason, 0)
		for (const c of children) {
			try {
				c.kill("SIGKILL")
			} catch {
				/* already gone */
			}
		}
		await killAllJobs(true)
	}
}
