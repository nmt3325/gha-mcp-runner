# gha-mcp-runner

Runner half of **gha-mcp**: ephemeral Linux / macOS / Windows shell environments for
an AI agent, provisioned as GitHub Actions jobs and driven over MCP.

The MCP server itself lives in `nmt3325/gha-mcp-broker`. This repository contains
only what runs *on* the runner.

```
AI ──MCP──▶ broker (Cloudflare Worker + Durable Object)
                │  workflow_dispatch
                ▼
        GitHub Actions job  ──▶  agent.mjs  ──▶  bash / pwsh
                ▲                    │
                └────── HTTPS long-poll (outbound only) ──┘
```

## Why this repository is public

Standard GitHub-hosted runners are free and unmetered on public repositories,
including macOS. On the Free plan a private repository gets 2,000 minutes/month,
and macOS bills at 10x, which works out to roughly 200 usable macOS minutes a
month -- not enough to be useful.

Being public is safe here because of one property, and it is the only thing
protecting the repository:

> **Every workflow is `workflow_dispatch` only.**

Fork pull requests get a read-only `GITHUB_TOKEN` and no access to secrets, and
`workflow_dispatch` requires write access to the repository, so a fork cannot
dispatch these workflows or reach `BROKER_SECRET`. Adding `pull_request`,
`pull_request_target`, or `issue_comment` to any workflow here destroys that
property. Do not do it.

## Files

| Path | Role |
| --- | --- |
| `agent.mjs` | The whole runner. Zero dependencies, single file, Node >= 20. |
| `.github/actions/run-agent/action.yml` | Shared setup: Node, Windows console encoding, git credentials, then run the agent in the foreground. |
| `.github/workflows/{linux,macos,windows}.yml` | One per platform, literal `runs-on`, `workflow_dispatch` only. |
| `.github/workflows/probe.yml` | Gate 0. Measures long-GET tolerance and orphan behaviour on all three OSes before anything else is trusted. |

## agent.mjs

Two roles in one file:

```
node agent.mjs --role=control   # enroll, hold the /control long-poll, own the TTL
                                # lease, spawn exec workers, sole tree-killer
node agent.mjs --role=exec      # hold /next, run one command at a time
```

The control plane is a separate process from the exec workers so that a command
producing 100 MB of output cannot delay a `kill` or a lease renewal.

### The invariants worth knowing before editing it

**No pipes, anywhere.** Children are spawned with `stdio: ['ignore', fd, fd]`
where `fd` is an appending descriptor on `out.raw`. Node cannot tune a child's
stdout high-water mark, so a chatty child on a `'pipe'` stdio stalls the parent's
event loop. Worse, the previous system's supervisor forked a child, redirected the
child's descriptors, and never closed its *own* copies -- so the caller never saw
EOF and a job that had already exited 0 was reported as
`command timed out after 30s and was terminated`. Writing straight to a file fd
removes the entire class of bug, and survives the worker dying.

**Completion comes from the exit event AND an `rc` file, never from stdout EOF.**
An orphaned grandchild holding the output file open is normal and must not look
like a running job.

**Duplicate delivery is expected; double execution is not.** `/next` may hand the
same command to two workers. Exclusion is `fs.openSync(started_at, 'wx')` --
`O_EXCL` on the runner, not a lock in the broker. A lock in the broker would have
to be broken when a runner dies, and would then be wrong.

**Disconnection is a normal event.** `wrangler deploy` swaps the Worker isolate
and drops every in-flight long poll. Every loop reconnects with jittered backoff
and treats a dropped poll as uneventful.

**No `TERM`.** A bare `TERM` makes tools emit escape sequences with no terminal to
interpret them; `TERM=dumb` makes `tput` exit 3, which kills any script under
`set -e`. `CI=1` and `NO_COLOR=1` are set instead, and output is ANSI-stripped
unconditionally on the way to `out.strip`.

**`set -e` is deliberately absent** from the POSIX wrapper, and
`$ErrorActionPreference` is left alone in the pwsh wrapper. Both turn ordinary
multi-command input into surprise aborts.

**A lone `\r` becomes `\n`.** Deleting it fuses an entire progress bar into one
enormous line, which then trips `max_bytes` on every subsequent read.

**Secrets are scrubbed from every child environment**: `BROKER_SECRET`,
`GHA_MCP_*`, `GITHUB_TOKEN`, `ACTIONS_*`, `INPUT_*`. The PAT for private clones is
never an environment variable -- it goes into a `GIT_CONFIG_GLOBAL` credential
store file with mode 600, and is additionally redacted to `***` at strip time.

### Job layout on disk

```
$RUNNER_TEMP/gha-mcp/<env_id>/
  work/                     default working directory (macOS /work is read-only)
  overlay.env               persisted env vars, sourced by every command
  cwd                       sticky working directory
  state.json  meta.json     enroll result; exit_reason
  jobs/<command_id>/
    cmd.sh | cmd.ps1 | cmd.cmd
    started_at              O_EXCL marker: the exclusion mechanism
    pid  pgid  rc  cwd_out
    out.raw                 exactly as the child wrote it (deleted unless keep_raw)
    out.strip               ANSI-stripped; the ONLY stream byte offsets refer to
    meta.json
```

## Setup

Repository secrets (Settings -> Secrets and variables -> Actions):

| Secret | Required | What |
| --- | --- | --- |
| `BROKER_URL` | yes | e.g. `https://gha-mcp.<subdomain>.workers.dev` |
| `BROKER_SECRET` | yes | shared secret for the one-shot enroll HMAC; must match the broker's |
| `GH_PAT` | no | fine-grained PAT if the agent needs to clone other private repos |

## Gate 0

Run `probe.yml` before trusting any of this. It answers, on all three OSes at
once, the questions the design rests on:

1. Can a hosted runner hold a GET open for 20 / 30 / 50 / 70 seconds against
   `workers.dev`? If not, long-polling is the wrong transport and no application
   design fixes it. Pass `long_get_base` as your deployed broker's
   `https://.../probe?wait=` once it exists.
2. Does a background process inheriting the step's stdout hang the step?
3. What is `TERM` on macOS and Windows runners?

## Status

M1: shell only -- `env_create`, `env_status`, `env_list`, `env_destroy`,
`env_extend`, `exec`, `exec_read`, `exec_kill`. File editing in M1 is
`exec` + base64 + `git apply`; dedicated edit tools come in M2.
