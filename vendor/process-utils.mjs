/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* ---------------------------------------------------------------------------
 * NOTICE OF MODIFICATION — required by Apache License 2.0 §4(b)
 *
 * This file was CHANGED by the gha-mcp project. It is derived from
 *
 *     google-gemini/gemini-cli
 *     packages/core/src/utils/process-utils.ts
 *     blob f0332ecdfceffa3843641d0981f812c61856ef7b
 *     (tree 87a9c71d57a4ec56c00f3ff628970fea8291d812)
 *
 * The copyright and licence header above is retained verbatim as required by
 * §4(c). The complete licence text is in third_party/gemini-cli/LICENSE, as
 * required by §4(a). gemini-cli ships no NOTICE file, so §4(d) does not apply.
 *
 * Changes made:
 *
 *  1. Translated from TypeScript to JavaScript (ESM). All type annotations, the
 *     `KillOptions` interface and the `NodeJS.Signals` union were removed. The
 *     option names, their defaults and the control flow are unchanged.
 *
 *  2. The `spawnAsync` import from `./shell-utils.js` was replaced by the local
 *     `spawnAsync` below so that this file has no dependency on the gemini-cli
 *     package tree. It keeps the contract this function relies on: resolve with
 *     `{ stdout }`, reject on a non-zero exit.
 *
 *  3. That local `spawnAsync` settles on the `close` event, not `exit`. Upstream
 *     gemini-cli has a live bug where `childProcessFallback()` listens for
 *     `exit` and therefore loses the output of fast commands
 *     (google-gemini/gemini-cli#24923). `pgrep` is exactly such a command, so
 *     using `exit` here would intermittently return an empty descendant list
 *     and leak grandchildren.
 *
 *  4. `spawnAsync` is given a hard timeout and `windowsHide`, so a wedged
 *     `taskkill` or `pgrep` cannot stall the agent's control loop.
 *
 *  5. PTY support was removed. gha-mcp never allocates a pseudo-terminal (the
 *     whole design forbids pipes and terminals in the output path), so the
 *     `pty` option and every `pty.kill()` branch are gone.
 *
 *  6. `SIGKILL_TIMEOUT_MS` is still exported and still the default, but an
 *     `escalateMs` option was added so the caller can choose a longer grace
 *     period. gha-mcp passes 3000 ms, because a build being torn down needs
 *     more than 200 ms to flush.
 * ------------------------------------------------------------------------- */

import os from "node:os"
import { spawn } from "node:child_process"

/** Default timeout for SIGKILL escalation on Unix systems. */
export const SIGKILL_TIMEOUT_MS = 200

/**
 * Minimal local replacement for gemini-cli's `./shell-utils.js` `spawnAsync`.
 * Resolves `{ stdout, stderr }` on exit code 0 and rejects otherwise.
 *
 * Settles on `close`, never on `exit`: see modification note 3 above.
 */
function spawnAsync(command, args, options = {}) {
	const timeoutMs = options.timeoutMs || 10_000
	return new Promise((resolve, reject) => {
		let child
		try {
			child = spawn(command, args, {
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			})
		} catch (e) {
			reject(e)
			return
		}
		let stdout = ""
		let stderr = ""
		let settled = false
		const timer = setTimeout(() => {
			if (settled) return
			settled = true
			try {
				child.kill("SIGKILL")
			} catch {
				// Ignore
			}
			reject(new Error(`${command} timed out after ${timeoutMs}ms`))
		}, timeoutMs)
		if (child.stdout) {
			child.stdout.setEncoding("utf8")
			child.stdout.on("data", (d) => {
				stdout += d
			})
		}
		if (child.stderr) {
			child.stderr.setEncoding("utf8")
			child.stderr.on("data", (d) => {
				stderr += d
			})
		}
		child.on("error", (e) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			reject(e)
		})
		child.on("close", (code) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			if (code === 0) resolve({ stdout, stderr })
			else reject(new Error(`${command} exited ${code}: ${stderr.trim().slice(0, 200)}`))
		})
	})
}

/**
 * Robustly terminates a process or process group across platforms.
 *
 * On Windows, it uses `taskkill /f /t` to ensure the entire tree is terminated.
 *
 * On Unix, it attempts to kill the process group (using -pid) with escalation
 * from SIGTERM to SIGKILL if requested. It also walks the process tree using pgrep
 * to ensure all descendants are killed.
 *
 * Options: { pid, escalate?, signal?, isExited?, escalateMs? }
 */
export async function killProcessGroup(options) {
	const {
		pid,
		escalate = false,
		isExited = () => false,
		escalateMs = SIGKILL_TIMEOUT_MS,
	} = options
	const isWindows = os.platform() === "win32"

	if (!pid) return

	if (isWindows) {
		// Invoke taskkill to ensure the entire tree is terminated and any orphaned descendant processes are reaped.
		try {
			await spawnAsync("taskkill", ["/pid", pid.toString(), "/f", "/t"], {
				timeoutMs: 15_000,
			})
		} catch {
			// Ignore errors if the process tree is already dead
		}
		return
	}

	// Unix logic: Walk process tree to find all descendants
	const getAllDescendants = async (parentPid) => {
		let children = []
		try {
			const { stdout } = await spawnAsync("pgrep", ["-P", parentPid.toString()], {
				timeoutMs: 5_000,
			})
			const pids = stdout
				.trim()
				.split("\n")
				.map((p) => parseInt(p, 10))
				.filter((p) => !isNaN(p))
			for (const p of pids) {
				children.push(p)
				const grandchildren = await getAllDescendants(p)
				children = children.concat(grandchildren)
			}
		} catch {
			// pgrep exits with 1 if no children are found
		}
		return children
	}

	const descendants = await getAllDescendants(pid)
	const allPidsToKill = [...descendants.reverse(), pid]

	try {
		const initialSignal = options.signal || (escalate ? "SIGTERM" : "SIGKILL")

		// Try killing the process group first (-pid)
		try {
			process.kill(-pid, initialSignal)
		} catch {
			// Ignore
		}

		// Kill individual processes in the tree to ensure detached descendants are caught
		for (const targetPid of allPidsToKill) {
			try {
				process.kill(targetPid, initialSignal)
			} catch {
				// Ignore
			}
		}

		if (escalate && !isExited()) {
			await new Promise((res) => setTimeout(res, escalateMs))
			if (!isExited()) {
				try {
					process.kill(-pid, "SIGKILL")
				} catch {
					// Ignore
				}

				for (const targetPid of allPidsToKill) {
					try {
						process.kill(targetPid, "SIGKILL")
					} catch {
						// Ignore
					}
				}
			}
		}
	} catch {
		// Ultimate fallback if something unexpected throws
		if (!isExited()) {
			try {
				process.kill(pid, "SIGKILL")
			} catch {
				// Ignore
			}
		}
	}
}
