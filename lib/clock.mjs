/*
 * The feedforward tail clock.
 *
 * A fixed poll interval cannot work here. 120ms was fine for a chatty build and
 * catastrophic for `yes`, which was measured at 10.2 GiB/s: a GitHub-hosted
 * macOS or Windows runner has 14 GB free, so it fills the disk in under two
 * seconds. Nor is the writer throttled into cooperating — on Linux a process
 * writing to a real file runs unthrottled until dirty pages reach
 * vm.dirty_ratio, which defaults to 20% of RAM.
 *
 * So the interval is derived from how much damage could possibly be done before
 * the next look:
 *
 *     interval = clamp(free * 0.5 / (n * r_max), 3ms, 100ms)
 *
 * r_max is a DECAYING running maximum of the observed write rate. A plain
 * running max would latch at the peak of one `tar` and never come back down.
 * n is the exec worker count, because they share one volume.
 *
 * The 3ms floor is set by control-loop latency, not by the cost of fstat.
 */

import { clamp } from "./util.mjs"

export const POLL_MIN_MS = 3
export const POLL_MAX_MS = 100
export const R_MAX_SEED = 10 * 1024 * 1024 * 1024 // the measured `yes` rate
export const R_MAX_DECAY = 0.9
export const FREE_HEADROOM = 0.5

export function makeTailClock(concurrency) {
	let rMax = R_MAX_SEED
	let lastSize = 0
	let lastAt = Date.now()
	const n = Math.max(1, concurrency)
	return {
		/** Feed the newest observed size and free space; get the next sleep in ms. */
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
