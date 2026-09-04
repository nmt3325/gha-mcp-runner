/*
 * HTTP to the broker.
 *
 * Two things make this different from an ordinary fetch wrapper:
 *
 *  - Network failure is a RETURN VALUE, not an exception. Being disconnected is
 *    a normal event on this transport (the runner holds 50-second long-polls
 *    against a Worker that can be swapped out mid-flight by a deploy), so the
 *    caller decides what it means.
 *
 *  - The deadline is ABSOLUTE. A per-attempt timeout that resets on activity is
 *    how actions-runner-controller#4191 kept a dead container alive forever, its
 *    retry counter cycling 4 -> 3 -> 2 -> 1 -> 4 -> ... The point of a deadline
 *    is that making progress on the wrong thing cannot refresh it.
 */

import { CFG } from "./config.mjs"
import { jitter, sleep } from "./util.mjs"
import { run } from "./state.mjs"

/** @returns {Promise<{status:number, json:object|null, text:string}>} */
export async function brokerReq(method, pathname, opts = {}) {
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
		// A 200 carrying HTML is a transport failure wearing a success code: a proxy,
		// a captive portal, or a Worker that failed to boot. Do not let it look OK.
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

/**
 * Deliver one output chunk. `start_byte` is the dedupe key, so re-delivering a
 * chunk is harmless and retrying is always safe.
 */
export async function pushChunk(payload, token = CFG.token) {
	for (let attempt = 0; attempt < 6 && !run.stopping; attempt++) {
		const r = await brokerReq("POST", `/agent/${encodeURIComponent(CFG.envId)}/chunk`, {
			token,
			body: payload,
			timeoutMs: 20000,
		})
		if (r.status === 200) return true
		// 401/403 means our lease is gone and 410 means the env is destroyed. Neither
		// gets better by waiting.
		if (r.status === 401 || r.status === 403 || r.status === 410) return false
		await sleep(jitter(400, attempt))
	}
	return false
}
