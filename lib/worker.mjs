/*
 * The exec worker loop.
 *
 * One long-poll, one command at a time, no local queue. Concurrency comes from
 * running several of these processes, not from running several commands inside
 * one, because a single process running N commands would have to multiplex their
 * output and that is precisely the complexity this design removes.
 */

import { CFG } from "./config.mjs"
import { brokerReq, pushChunk } from "./broker.mjs"
import { runCommand } from "./exec.mjs"
import { run } from "./state.mjs"
import { jitter, log, sleep, space } from "./util.mjs"

export async function execWorkerMain() {
	let attempt = 0
	while (!run.stopping) {
		const r = await brokerReq(
			"GET",
			`/agent/${encodeURIComponent(CFG.envId)}/next?wait=${CFG.waitSeconds}&worker=${CFG.worker}`,
			{ token: CFG.token, timeoutMs: (CFG.waitSeconds + 15) * 1000 },
		)
		// Our lease is gone (401/403) or the env is destroyed (410). Neither improves
		// with waiting, and continuing would mean running commands nobody can read.
		if (r.status === 401 || r.status === 403 || r.status === 410) {
			log(`next -> ${r.status}, worker exiting`)
			return
		}
		if (r.status !== 200) {
			// Being disconnected is normal here, not exceptional.
			await sleep(jitter(500, attempt++))
			continue
		}
		attempt = 0
		const cmd = r.json && r.json.command
		if (!cmd || !cmd.command_id) continue
		try {
			await runCommand(cmd)
		} catch (e) {
			// The command must always reach a terminal state, even when the agent is
			// the thing that broke. A command stuck in `running` forever is worse than
			// one reported as lost.
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
				killed_reason: space.enospcAt ? "enospc" : null,
				agent_error: String((e && e.message) || e),
			})
		}
	}
}
