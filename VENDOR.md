# Vendored / referenced code

## Referenced during design (no code copied into this repository)

| Project | License | What was taken |
| --- | --- | --- |
| [sst/opencode](https://github.com/sst/opencode) `packages/opencode/src/tool/bash.ts` | MIT | Spill full output to a file when the inline cap is exceeded; SIGTERM then SIGKILL after 3s; do not use `detached` on Windows |
| [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `ShellExecutionService` | Apache-2.0 | Inactivity timeout that resets on output; scrollback caps; `killProcessGroup` shape |
| [wonderwhy-er/DesktopCommanderMCP](https://github.com/wonderwhy-er/DesktopCommanderMCP) | MIT | Paginated output reads (`offset`/`length`), eviction bookkeeping, and the M2 file-edit tool design (`read_file` / `write_file` / `edit_block`) |
| [nmt3325/opencode-mcp-bridge](https://github.com/nmt3325/opencode-mcp-bridge) | MIT | `isJsonPayload` guard against proxies answering 200 with an HTML body; `ok`/`next_action` result shape |

## Copied into this repository

Nothing yet. `agent.mjs` is original code written against the contract in the design
document; the broker repository vendors `config.ts` and `result.ts` from
`nmt3325/opencode-mcp-bridge` (MIT) and records the exact commit there.
