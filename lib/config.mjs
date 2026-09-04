/* Platform detection, runtime configuration and the on-disk layout. */

import os from "node:os"
import path from "node:path"

import { clamp, num } from "./util.mjs"

export const VERSION = "0.2.0"

export const PLATFORM =
	process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux"
export const IS_WIN = PLATFORM === "windows"

export const CFG = {
	brokerUrl: String(process.env.BROKER_URL || "").replace(/\/+$/, ""),
	brokerSecret: process.env.BROKER_SECRET || "",
	envId: process.env.GHA_MCP_ENV_ID || "",
	ttlMinutes: num(process.env.GHA_MCP_TTL_MINUTES, 60),
	// GHA_MCP_ROOT is the self-hosted escape hatch. If this account is ever
	// suspended from GitHub-hosted runners again, the same agent has to be able to
	// run on a box we control, where RUNNER_TEMP does not exist.
	root: process.env.GHA_MCP_ROOT || path.join(process.env.RUNNER_TEMP || os.tmpdir(), "gha-mcp"),
	runId: process.env.GITHUB_RUN_ID || "0",
	runAttempt: process.env.GITHUB_RUN_ATTEMPT || "1",
	token: process.env.GHA_MCP_TOKEN || "",
	worker: num(process.env.GHA_MCP_WORKER, 0),
	execWorkers: clamp(num(process.env.GHA_MCP_EXEC_WORKERS, 4), 1, 8),
	waitSeconds: clamp(num(process.env.GHA_MCP_WAIT_SECONDS, 50), 5, 55),
}

/* ------------------------------------------------------------------ layout */

export const envDir = () => path.join(CFG.root, CFG.envId)
export const jobsDir = () => path.join(envDir(), "jobs")
export const jobDir = (id) => path.join(jobsDir(), id)
export const workDir = () => path.join(envDir(), "work")
export const overlayPath = () => path.join(envDir(), "overlay.env")
export const stickyCwdPath = () => path.join(envDir(), "cwd")
export const statePath = () => path.join(envDir(), "state.json")
export const shellsPath = () => path.join(envDir(), "shells.json")
export const metaPath = () => path.join(envDir(), "meta.json")
export const redactPath = () => path.join(envDir(), "redact.txt")

/* ------------------------------------------------------------------ tuning */

export const PUSH_IDLE_MS = 400
export const PUSH_SIZE_BYTES = 32 * 1024
export const PUSH_MAX_BYTES = 64 * 1024
export const STATFS_INTERVAL_MS = 250
export const RC_GRACE_MS = 3000
export const KILL_ESCALATE_MS = 3000
export const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024 * 1024
export const SPAWN_GAP_MS = 5000

/* -------------------------------------------------------------- env  scrub */

// Never hand these to AI-executed commands.
export const SCRUB_PREFIXES = ["ACTIONS_", "INPUT_", "GHA_MCP_"]
export const SCRUB_EXACT = [
	"BROKER_URL",
	"BROKER_SECRET",
	"GITHUB_TOKEN",
	"GH_TOKEN",
	"GH_PAT",
	"NODE_AUTH_TOKEN",
]
