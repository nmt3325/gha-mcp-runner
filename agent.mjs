#!/usr/bin/env node
/*
 * gha-mcp runner agent.
 *
 *   node agent.mjs --role=control    enroll, hold the /control long-poll, own the
 *                                    TTL lease, spawn exec workers, and be the
 *                                    only process that kills a tree
 *   node agent.mjs --role=exec       hold the /next long-poll, run one command
 *                                    at a time
 *
 * No npm dependencies. Node >= 20. The only imported third-party code is
 * vendor/process-utils.mjs, which is a port of gemini-cli's killProcessGroup.
 *
 * ---------------------------------------------------------------------------
 * INVARIANTS
 *
 * Each of these exists because its absence produced a specific, reproducible
 * failure in the previous generation of this system. They were argued out across
 * four debate sessions; please do not "simplify" them away.
 *
 *  1. Completion is decided by the process exit event, corroborated by the `rc`
 *     file. NEVER by stdout EOF. An orphaned grandchild keeps the write end of
 *     stdout open long after the shell is gone, so EOF means nothing. This is
 *     what produced `command timed out after 30s` on commands that had already
 *     finished.
 *
 *  2. No pipes anywhere in the output path. The child receives ONE O_APPEND file
 *     descriptor on out.raw as both stdout and stderr. Node cannot tune a
 *     child's stdout high-water mark, so a chatty child on a pipe stalls this
 *     process. Handing both slots the same descriptor also makes the kernel
 *     decide the interleave, which is the only portable way to preserve merge
 *     order -- no shell-level `2>&1` is involved.
 *
 *  3. There is exactly ONE output file per command, and the cursor is a raw byte
 *     offset into it. No rotation, no second stripped file. ANSI stripping and
 *     secret redaction are READ-TIME transforms applied by the broker to a
 *     window, so they can never move the cursor.
 *
 *  4. Reads are positional. pread does not touch a shared file offset, so
 *     re-reading a range is byte-identical and two readers of different ranges
 *     cannot interfere. Together with 3, this is what makes an MCP client's
 *     retry after `MCP error -32001` safe: the server holds no per-reader
 *     position at all, exactly like an HTTP Range request. Every rejected
 *     candidate implementation failed on precisely this point -- they all
 *     re-attach to a live stream and keep a mutable read cursor server-side.
 *
 *  5. Duplicate delivery is expected. Exclusion is a runner-side O_EXCL marker,
 *     not a broker lock.
 *
 *  6. Disconnection is a normal event on this transport, not an exception.
 *     Reconnect immediately with jittered backoff.
 *
 *  7. killed_reason is single-valued with a FIXED priority:
 *         enospc > output_cap > timeout | inactivity > user > spawn_gap
 *     `enospc` is set ONLY when one of the agent's OWN writes actually returns
 *     ENOSPC. A file that stops growing while statfs reports zero free blocks is
 *     `inactivity` plus an advisory warning -- "no output" is ALWAYS
 *     `inactivity`. Getting this backwards persists a permanent mislabel,
 *     because `cargo build`, `npm ci` and `sleep` are indistinguishable from a
 *     disk-full stall from the outside.
 *
 *  8. fs.watch is banned. It is unreliable on macOS and Windows, and every fs
 *     API except the explicitly synchronous ones goes through libuv's
 *     threadpool. Growth is detected with synchronous fstat on a read-only fd.
 *
 *  9. worker_threads must NEVER be imported. libuv#1490 -- "If two threads were
 *     to simultaneously call uv_spawn, they might accidentally both inherit
 *     handles intended for the other process" -- is only closed for us because
 *     this process is single-threaded. CI greps for it.
 *
 * 10. Windows PowerShell 5.1 is never used and never substituted for pwsh. It is
 *     a separate product that installs side-by-side with PowerShell 7, and its
 *     redirection operators corrupt byte streams. A missing pwsh is reported as
 *     a precondition failure, not papered over with a fallback.
 * ---------------------------------------------------------------------------
 */

import { CFG } from "./lib/config.mjs"
import { controlMain } from "./lib/control.mjs"
import { run } from "./lib/state.mjs"
import { log } from "./lib/util.mjs"
import { execWorkerMain } from "./lib/worker.mjs"

function parseRole() {
	for (const a of process.argv.slice(2)) {
		const m = /^--role=(.+)$/.exec(a)
		if (m) return m[1]
	}
	return process.env.GHA_MCP_ROLE || "control"
}

// Cooperative shutdown. GitHub's cancellation sequence is SIGINT, 7500ms,
// SIGTERM, 2500ms, then it kills the tree, so there is a real budget here to
// finish the current push and record an exit reason.
for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, () => {
		run.stopping = true
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
		// controlMain's own finally block already recorded an exit reason.
		log(`control fatal: ${e && e.stack}`)
		process.exit(1)
	})
}
