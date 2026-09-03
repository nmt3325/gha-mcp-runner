# gha-mcp-runner

Runner side of **gha-mcp** — an MCP server that gives an AI agent shell access to
ephemeral GitHub Actions runners (Linux / macOS / Windows).

This repository intentionally contains **only**:

- `.github/workflows/{linux,macos,windows}.yml` — one file per OS, `runs-on` written as a **literal**
- `.github/actions/run-agent/` — the composite action all three share
- `agent.mjs` — the single-file, zero-dependency runner agent
- `.github/workflows/probe.yml` — Gate 0: collects the platform facts the design depends on

The broker / MCP server lives in a **separate** repository on purpose. Commands executed
by the AI always hold this repository's `GITHUB_TOKEN`, so keeping the source elsewhere means
AI-executed code cannot push to it. Jobs here declare `permissions: {}`.

## Triggers

`workflow_dispatch` **only**. Never add `pull_request`, `pull_request_target` or
`issue_comment` to any workflow in this repository: that is the single property that makes it
safe for this repository to be public (fork PRs get a read-only token and no secrets, and
`workflow_dispatch` requires write access, so a fork branch can never be dispatched).

Public is deliberate — standard GitHub-hosted runners are free and unmetered on public
repositories, including macOS. On a private repository the Free tier's 2,000 min/month becomes
an effective ~200 macOS min/month, which is not usable for interactive sessions.

## Required repository secrets

| Secret | Purpose |
| --- | --- |
| `BROKER_URL` | e.g. `https://gha-mcp.<subdomain>.workers.dev` |
| `BROKER_SECRET` | shared secret used only for the one-shot enroll HMAC |
| `GH_PAT` | optional. Fine-grained PAT for cloning **other** private repos. Never granted on this repository. |

Dispatch inputs carry only `env_id` and `ttl_minutes`. Secrets are never passed as inputs
(`::add-mask::` does not work on `workflow_dispatch` inputs — actions/runner#643).

## Design invariants (do not break these)

1. **A tool call never blocks past 55s.** Everything is start → poll.
2. **Completion is never inferred from stdout EOF.** Only the process exit event *and* the `rc`
   file written by the wrapper script.
3. **`state: "unknown"` does not exist.** A confirmed absence is `lost`; a transient inability to
   read state is `poll_error`. They are different fields.
4. **TTL is a lease owned by the runner.** If the broker is unreachable for too long the runner
   destroys itself, so an env is always reclaimed even if the broker or MCP session dies.
5. **`control` never holds a pipe.** exec workers are spawned with `stdio: ['ignore', fd, fd]`.
6. Byte offsets are the only cursor. Tails are cut at the last `\n`; the two exceptions back up
   at most 3 bytes to clear a UTF-8 continuation byte.

See the design document for the full contract and the reasoning behind each item.
