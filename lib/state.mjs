/*
 * Process-wide run state.
 *
 * Lives in its own module so the broker transport, the exec loop and the control
 * loop can all observe the same shutdown flag without importing each other.
 */

export const run = { stopping: false }
