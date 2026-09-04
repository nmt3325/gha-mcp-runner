# VENDOR / 出典台帳 (runner)

> **重要**: 以前この台帳には `nmt3325/opencode-mcp-bridge` が移植元として記載されていました。
> 同リポジトリは beta/alpha 段階であるため、**移植元から全面的に排除しました**。
> 現在このリポジトリのコードは同リポジトリ由来のものを一切含みません。

単一の fork 元は存在しません。レイヤーごとに別々の上流から逐語移植しています。

---

## 1. プロセス起動 / プロセスツリー kill

| | |
| --- | --- |
| 上流 | `google-gemini/gemini-cli` |
| パス | `packages/core/src/utils/process-utils.ts` (+ 同ディレクトリのテスト) |
| ライセンス | Apache-2.0 |
| 取得 ref | `87a9c71d57a4ec56c00f3ff628970fea8291d812` |
| blob | `f0332ecdfceffa3843641d0981f812c61856ef7b` |
| 使用箇所 | `killTree()` |

採用理由: `killProcessGroup` が Windows で `taskkill /f /t` を使い、POSIX では `detached` プロセスグループに対して負の PID でシグナルを送る。3 OS 分の分岐がテストごと揃っている唯一の実装。

**注意**: gemini-cli 全体は移植していません。`shellExecutionService.ts` の `childProcessFallback()` は `child.on('exit')` を待つため高速コマンドの stdout を落とす既知の不具合 (#24923) があり、PTY 経路にも未解決 issue が多数あります。

### Apache-2.0 §4 の遵守

- §4(a): `third_party/gemini-cli/LICENSE` に全文を同梱する。
- §4(b): 移植ファイルのヘッダ直下に改変告知を置く。
- §4(c): 上流のヘッダを **1 バイトも変えずに** 保存する。

```
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * Modified by the gha-mcp project.
 * Source: google-gemini/gemini-cli @ 87a9c71d57a4ec56c00f3ff628970fea8291d812
 *   packages/core/src/utils/process-utils.ts
 * Changes: <具体の差分>
 */
```

- §4(d): **不要**。上流ルートツリー (41 エントリ) を全数確認し `NOTICE` ファイルが存在しないことを確認済み。

---

## 2. シェル定句 (prologue / epilogue / cmd 起動行)

| | |
| --- | --- |
| 上流 | `actions/runner` |
| パス | `src/Runner.Worker/Handlers/ScriptHandlerHelpers.cs`、`docs/adrs/0277-run-action-shell-options.md` |
| ライセンス | MIT |
| 取得 ref | `0b0ac2fdabf53d69add6175026945b8afc8549a5` |
| blob | `6ec953b78d0ac8e637d420be02346473efad577a` (cs) / `1f7f97fd3c38acd66121321e3ff4a1137681cbeb` (adr) |
| 使用箇所 | `posixScript`, `pwshScript`, `cmdScript` |

採用理由: **このエージェントは GitHub Actions runner の中で走る**ため、シェル起動規約についてこれ以上権威のある上流は存在しません。

定句は C# から TypeScript へ移植しますが、**文字列そのものは 1 バイトも変えません**。

```
# pwsh
prepend: $ErrorActionPreference = 'stop'
append : if ((Test-Path -LiteralPath variable:\LASTEXITCODE)) { exit $LASTEXITCODE }

# cmd
%ComSpec% /D /E:ON /V:OFF /S /C "CALL "{0}""

# bash
bash --noprofile --norc -eo pipefail {0}
```

### epilogue が必須である理由 (一次情報)

公式 `about_Automatic_Variables` および PowerShell #11461:

> In the *absence* of an explicit `exit` statement, POSIX-like shells report the *last statement*'s exit code as the script's, whereas `*.ps1` scripts default to `0`

つまり `pwsh -File` 単体では **失敗した native command が `exit 0` として返ります**。これは旧システムで実際に観測された「`exit 0` を返しつつ `command produced no output`」と同じ病理です。

Azure DevOps の `PowerShell@2` タスクが独立に同じ 1 行 (`ignoreLASTEXITCODE`) に到達していることが、これが慣習ではなく正解である裏付けです。

### 意図的に上流から乖離している点

| 差分 | 理由 |
| --- | --- |
| `-NoProfile -NonInteractive` を付ける | runner は 1 ステップ 1 プロセスだが、我々は無人で多数回起動する。profile の出力が stdout を汚す |
| `-File` を使う (docs は `-command ". '{0}'"`) | dot-source と call operator でスコープが異なり、docs と ADR が食い違っている |
| `powershell` (5.1) を選択肢から除外 | PowerShell 7 は 5.1 を置き換えず side-by-side で入る。5.1 の出力リダイレクトはファイルを壊す (age #290) |
| 3 OS 一律のシェル指定を諦め、`shell` を明示必須にした | 無指定時の runner 実体は `bash -e {0}` (actions/runner #353) |

`pwsh` は Windows で **プリインストールされているとは限らず**、`actions/runner` #3415 により明示指定した `pwsh` は Desktop へフォールバックしません。よって `enroll` 時に `pwsh -v` を検査し、結果を `facts.shells` として報告します。不在なら `shell:"pwsh"` は即エラーにし、黙って落ちる経路を作りません。

---

## 3. 新規実装 (上流なし)

| 関数 | 説明 |
| --- | --- |
| `brokerReq()` | ブローカーとの HTTP。**リセット可能なリトライカウンタではなく絶対デッドライン**で打ち切る。actions-runner-controller #4191 (「The retry counter resets (4→3→2→1→4→…), keeping the container alive indefinitely」) の反面教師 |
| `safeCut()` | UTF-8 境界 ≤3 B ＋ ANSI ≤4 KiB のルックバック。超過分はエスケープ内側で無条件カット。`exec_read` は `next_byte` で可逆な窓なので、端末のような「壊れた並びを出さない」不変条件は転移しない |
| `makeStripper()` | ANSI 除去の安全網。`$PSStyle.OutputRendering` は PowerShell 自身の整形出力にしか効かず、`gcc` / `npm` / `cargo` が吐く ANSI は素通りするため必要 |
| 適応ポーリング | `clamp(free × 0.5 / (n · r_max), 3ms, 100ms)`、`r_max = max(r_obs, r_max × 0.9)`、初期値 10 GiB/s |

### 適応ポーリングの根拠

固定 100ms は執行不能です。`yes | pv > /dev/null` は 10.2 GiB/s 出るため 1 周期で約 1 GiB 進み、macOS の 14 GB は約 1.4 秒で消えます。さらに Linux `Documentation/admin-guide/sysctl/vm.rst`:

> `dirty_ratio` — the number of pages at which a process which is generating disk writes will itself start writing out dirty data

書き手は RAM の 20% までスロットルされないため、`fstat` のサイズは RAM 速度で伸びます。フィードバック項だけの制御では静止→爆発の遷移で必ず 1 周期ぶん見逃すため、空き容量を入力とするフィードフォワード項が必要です。

### macOS の空き容量について

`fs.statfs().bavail` は APFS の purgeable 領域を **含みません** (過小報告)。purgeable を足すのは Finder の表示であって `statfs` ではありません。よってフロアは安全側に外れ、ポーリング間隔が必要以上に短くなるだけです。安全性の穴ではありません。

---

## 4. 不変条件 (CI で強制)

`agent.mjs` は **`worker_threads` を import してはいけません**。libuv #1490 (「If two threads were to simultaneously call `uv_spawn`, they might accidentally both inherit handles intended for the other process.」) が再活性化するためです。

```sh
grep -R "worker_threads" agent.mjs && exit 1
```

---

## 5. 採用しなかった候補

| 候補 | 却下理由 |
| --- | --- |
| `nmt3325/opencode-mcp-bridge` | beta/alpha 段階のため利用しない (ユーザー指示) |
| `wonderwhy-er/DesktopCommanderMCP` | `readOutputPaginated` の offset が行単位。`offset===0` が読み取り位置を破壊的に変更し、MCP -32001 リトライで出力が飛ぶ。`forceTerminate` は直下の子のみ |
| `sst/opencode` | `packages/core/src/tool/bash.ts` の TODO が M1 要件をほぼ全部「未実装」と自己申告。`permission.assert(...)` の人間承認が無人運用と両立しない |
| `charmbracelet/crush` | 埋め込みシェル (`mvdan.cc/sh`) で 3 OS 差を吸収する設計＝OS のシェルを使わない。Go |
| `All-Hands-AI/OpenHands` | tmux 前提で Windows 不可。`action_execution_server.py` が「LEGACY V0 CODE - Deprecated」 |
| `cline/cline` | VSCode のシェル統合に密結合。自身の修正が生 `child_process` への後退 (#8824) |
| E2B / Daytona の再アタッチ方式 | #1074 で 2 分後に `connect(pid)` が失敗、#1352 で再開後 stdout が約 8 KB で停止 |

共通する却下理由は「生きているストリームに再アタッチする」設計がサーバ側に可変な読み取り位置を持つことです。MCP の 60 秒制限下では、HTTP Range 相当の **サーバ側状態ゼロのランダムアクセス読み取り** が必要です。
