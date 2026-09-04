# VENDOR / 出典台帳 (runner)

> **重要**: 以前この台帳には `nmt3325/opencode-mcp-bridge` が移植元として記載されていました。
> 同リポジトリは beta/alpha 段階であるため、**移植元から全面的に排除しました**。
> 現在このリポジトリのコードは同リポジトリ由来のものを一切含みません。

単一の fork 元は存在しません。レイヤーごとに別々の上流から逐語移植しています。

---

## 0. 実装レイアウト

| ファイル | 役割 | 出典 |
| --- | --- | --- |
| `agent.mjs` | ロール振り分けと不変条件の記述のみ | 新規 |
| `lib/config.mjs` | プラットフォーム判定・設定・レイアウト | 新規 |
| `lib/util.mjs` | 小物と **ENOSPC 証拠ガード** | 新規 |
| `lib/clock.mjs` | 適応テールクロック | 新規 |
| `lib/state.mjs` | 停止フラグ | 新規 |
| `lib/broker.mjs` | ブローカー HTTP (絶対デッドライン) | 新規 |
| `lib/shell.mjs` | シェル選択とスクリプト生成 | **`actions/runner`** (MIT) |
| `lib/exec.mjs` | 1 コマンドの実行と出力転送 | 新規 (kill のみ下記) |
| `lib/worker.mjs` | `/next` ロングポールループ | 新規 |
| `lib/control.mjs` | enroll・TTL リース・control アクション | 新規 |
| `vendor/process-utils.mjs` | プロセスツリー kill | **`google-gemini/gemini-cli`** (Apache-2.0) |

---

## 1. プロセス起動 / プロセスツリー kill

| | |
| --- | --- |
| 上流 | `google-gemini/gemini-cli` |
| パス | `packages/core/src/utils/process-utils.ts` |
| ライセンス | Apache-2.0 |
| 取得 ref | `87a9c71d57a4ec56c00f3ff628970fea8291d812` |
| blob | `f0332ecdfceffa3843641d0981f812c61856ef7b` |
| 移植先 | `vendor/process-utils.mjs` の `killProcessGroup()` |
| 呼び出し元 | `lib/exec.mjs` (タイムアウト等), `lib/control.mjs` (`kill` アクション・終了時) |

採用理由: `killProcessGroup` が Windows で `taskkill /f /t` を使い、POSIX では `detached` プロセスグループに負の PID でシグナルを送り、さらに `pgrep -P` で子孫を再帰列挙して個別にも送る。3 OS 分の分岐が揃っている唯一の実装。

**gemini-cli 全体は移植していません。** `shellExecutionService.ts` の `childProcessFallback()` は `child.on('exit')` を待つため高速コマンドの stdout を落とす既知の不具合 (#24923) があり、PTY 経路にも未解決 issue が多数あります (#15945 / #16773 / #15744 / #20941 / #25164)。

### 実際に加えた改変 (Apache-2.0 §4(b) の告知内容)

1. TypeScript → JavaScript (ESM)。型注釈・`KillOptions` interface・`NodeJS.Signals` を削除。**オプション名と既定値と制御フローは不変**。
2. `./shell-utils.js` からの `spawnAsync` import を、ローカル実装に置換 (上流パッケージツリーへの依存を断つため)。契約は同一 (`{ stdout }` で resolve、非 0 終了で reject)。
3. そのローカル `spawnAsync` は **`close` で settle し、`exit` では settle しない**。上流の #24923 と同じ罠で、`pgrep` はまさに「速いコマンド」なので `exit` だと子孫リストが空になり孫プロセスが漏れる。
4. `spawnAsync` にハードタイムアウトと `windowsHide` を追加。ハングした `taskkill` / `pgrep` が制御ループを止められないようにする。
5. PTY 対応を全削除 (`pty` オプションと全ての `pty.kill()` 分岐)。本プロジェクトは擬似端末を確保しない。
6. `SIGKILL_TIMEOUT_MS` (200 ms) は export も既定値も維持したまま、`escalateMs` オプションを追加。gha-mcp は 3000 ms を渡す。

### Apache-2.0 §4 の遵守状況 (実施済み)

| 条項 | 実施内容 |
| --- | --- |
| §4(a) | `third_party/gemini-cli/LICENSE` に全文を同梱済み (blob `7a4a3ea2424c09fbe48d455aed1eaa94d9124835` の逐語コピー) |
| §4(b) | `vendor/process-utils.mjs` 先頭に `NOTICE OF MODIFICATION` ブロックを設置済み |
| §4(c) | 上流ヘッダ (`@license` / `Copyright 2025 Google LLC` / `SPDX-License-Identifier: Apache-2.0`) を **1 バイトも変えずに** 保存済み |
| §4(d) | **不要**。上流ルートツリー (41 エントリ) を全数確認し `NOTICE` ファイルが存在しないことを確認済み |

§4(b)(c) は台帳ではなく **ファイル自身** が満たす義務なので、`.github/workflows/ci.yml` の `third-party attribution is intact` ステップで存在を強制しています。リファクタでヘッダが消えても気付けない、という状態を作らないためです。

---

## 2. シェル定句 (prologue / epilogue / cmd 起動行)

| | |
| --- | --- |
| 上流 | `actions/runner` |
| パス | `src/Runner.Worker/Handlers/ScriptHandlerHelpers.cs`、`docs/adrs/0277-run-action-shell-options.md` |
| ライセンス | MIT (`third_party/actions-runner/LICENSE` に同梱済み) |
| 取得 ref | `0b0ac2fdabf53d69add6175026945b8afc8549a5` |
| blob | `6ec953b78d0ac8e637d420be02346473efad577a` (cs) / `1f7f97fd3c38acd66121321e3ff4a1137681cbeb` (adr) |
| 移植先 | `lib/shell.mjs` の `posixScript` / `pwshScript` / `cmdScript` / `spawnArgs` |

採用理由: **このエージェントは GitHub Actions runner の中で走る**ため、シェル起動規約についてこれ以上権威のある上流は存在しません。

定句は C# から JavaScript へ移植しますが、**文字列そのものは 1 バイトも変えません**。

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

Azure DevOps の `PowerShell@2` タスクが独立に同じ 1 行に到達していることが、これが慣習ではなく正解である裏付けです。

`pwshScript` は epilogue の直前に `$global:LASTEXITCODE = $__gha_rc` を置いています。これがないと `Test-Path variable:\LASTEXITCODE` が偽になり得て epilogue が発火しません。**この 1 行があるからこそ `-File` を使ってよい**、という依存関係です。CI の `the actions/runner pwsh epilogue survives script generation` ステップが、生成後の文字列に対して逐語で検査します。

### 意図的に上流から乖離している点

| 差分 | 理由 |
| --- | --- |
| `-NoProfile -NonInteractive` を付ける | runner は 1 ステップ 1 プロセスだが、我々は無人で多数回起動する。profile が stdout を汚し、対話プロンプトは non-TTY stdin の背後で永久に待つ |
| `-File` を使う (docs は `-command ". '{0}'"`、ADR は `"& '{0}'"`) | **上流の docs と ADR が食い違っている**。上記 epilogue 保証があるので `-File` を選ぶ |
| `powershell` (5.1) を選択肢から除外 | PowerShell 7 は 5.1 を置き換えず side-by-side で入る。5.1 の出力リダイレクトはファイルを壊す (age #290) |
| POSIX で `-e` を落とす (`pipefail` は残す) | AI は複数コマンドをまとめて送る。`-e` は最初の非 0 で全体を中断し、`TERM=dumb` の `tput` は 3 で終了する |
| `shell` の明示を必須にした | 無指定時の runner 実体は `bash -e {0}` (actions/runner #353) |
| `cmd` はスクリプトパスを独立 argv で渡す (`CALL "..."` を入れ子にしない) | cmd.exe の入れ子クォート解釈を避ける。`/V:OFF` は上流どおり維持 (遅延展開が有効だとコマンド中のリテラル `!` が消える) |

`pwsh` は Windows で **プリインストールされているとは限らず**、`actions/runner` #3415 により明示指定した `pwsh` は Desktop へフォールバックしません。よって `enroll` 時に `pwsh -v` を検査し、結果を `facts.shells` として報告し `shells.json` に永続化します。不在なら `shell:"pwsh"` は即エラーにし、黙って別物に差し替わる経路を作りません。

### 移植中に発見した旧コードのバグ

旧 `posixScript` は `exec 0</dev/null` を出力していました。spawn が `stdin.bin` の fd を fd 0 として渡した **直後にそれを捨てていた** ため、stdin 付きコマンドは常に即 EOF を見ていました。新実装では削除済みで、`lib/shell.mjs` にコメントとして残しています。

---

## 3. 新規実装 (上流なし)

| 関数 | 場所 | 説明 |
| --- | --- | --- |
| `brokerReq()` | runner | **リセット可能なリトライカウンタではなく絶対デッドライン**で打ち切る。actions-runner-controller #4191 (「The retry counter resets (4→3→2→1→4→…), keeping the container alive indefinitely」) の反面教師 |
| `makeTailClock()` | runner | `clamp(free × 0.5 / (n · r_max), 3ms, 100ms)`、`r_max = max(r_obs, r_max × 0.9)`、初期値 10 GiB/s |
| `space` ガード | runner | `killed_reason='enospc'` の唯一の根拠。**自分自身の write が実際に ENOSPC を返した場合のみ** |
| `safeCut()` | **broker のみ** | UTF-8 境界 ≤3 B ＋ ANSI ≤4 KiB のルックバック |
| ANSI ストリッパ | **broker のみ** | 読み取り時変換 |

### 台帳からの乖離 (2 点、意図的)

**(1) `safeCut()` は agent 側に置きません。** 討議の結論表では `agent.mjs` と `src/bytes.ts` の両方に置くとしていました。実装して分かったのは、それが誤りだということです。エージェントは **生バイト範囲を生オフセットで** そのまま押し出すだけで、`PUSH_MAX_BYTES` による分割はブローカー側で生オフセットから再結合されるため何も壊しません。カット位置を決める場所が 2 か所あると両者を一致させ続ける必要が生じ、**それが破れた瞬間に冪等性が壊れます**。カットは読み取り時に 1 回だけ、が唯一の正しい形です。

**(2) ANSI ストリッパは runner から完全に撤去しました。** カーソルが生バイトオフセットになった以上、書き込み時の除去はオフセットを動かしてしまいます。`$PSStyle.OutputRendering` は PowerShell 自身の整形出力にしか効かず `gcc` / `npm` / `cargo` の ANSI は素通りするため、ストリッパ自体は依然必要ですが、置き場所はブローカーの読み取り経路です。

### 適応ポーリングの根拠

固定 100 ms は執行不能です。`yes | pv > /dev/null` は 10.2 GiB/s 出るため 1 周期で約 1 GiB 進み、macOS / Windows の 14 GB は約 1.4 秒で消えます。さらに Linux `Documentation/admin-guide/sysctl/vm.rst`:

> `dirty_ratio` — the number of pages at which a process which is generating disk writes will itself start writing out dirty data

書き手は RAM の 20% までスロットルされないため、`fstat` のサイズは RAM 速度で伸びます。フィードバック項だけの制御では静止→爆発の遷移で必ず 1 周期ぶん見逃すため、空き容量を入力とするフィードフォワード項が必要です。3 ms のフロアは `fstatSync` の CPU コストではなく **制御ループのレイテンシ**で決まっています。

### macOS の空き容量について

`fs.statfs().bavail` は APFS の purgeable 領域を **含みません** (過小報告)。Disk Utility の「255.34 GB available (145.56 GB purgeable)」に対し `df -H` は 110G を返し、255.34 − 145.56 ≈ 109.78 で一致します。よってフロアは安全側に外れ、ポーリング間隔が必要以上に短くなるだけです。**kill の根拠には一切使いません。**

---

## 4. 不変条件 (CI で強制)

`.github/workflows/ci.yml` が以下を落とします。

| ゲート | 根拠 |
| --- | --- |
| `worker_threads` / `new Worker(` の出現 | libuv #1490 (「If two threads were to simultaneously call `uv_spawn`, they might accidentally both inherit handles intended for the other process.」) は **本プロセスが単一スレッドである**ことだけを根拠に閉じている。スレッドを足した瞬間に根拠が失効する |
| `fs.watch` / `watchFile` の出現 | macOS / Windows で信頼できず、libuv スレッドプールを使う |
| `out.strip` / `out.N.raw` の出現 | 独自オフセットを持つ 2 つ目のファイルが、カーソルの非冪等性の原因だった |
| コマンド stdio に `"pipe"` の出現 | Node は子の stdout highWaterMark を調整できない。パイプ上の多弁な子はエージェントを止める |
| ライセンス同梱とヘッダの存在 | §4(a)(b)(c) はファイル自身が満たす義務 |
| 全モジュールの構文検査と import | ビルド段階が無いので、typo は本番 runner でしか露見しない |
| テールクロックの上下限 | 静止時に上限へ緩み、高速書き込み時に下限へ張り付くことを直接検査 |
| pwsh prologue / epilogue / `$OutputEncoding` の逐語存在 | 旧システム最悪の症状に対する修正そのもの |

---

## 5. 採用しなかった候補

| 候補 | 却下理由 |
| --- | --- |
| `nmt3325/opencode-mcp-bridge` | beta/alpha 段階のため利用しない (ユーザー指示) |
| `wonderwhy-er/DesktopCommanderMCP` | `readOutputPaginated` の offset が行単位。`offset===0` が読み取り位置を破壊的に変更し、MCP -32001 リトライで出力が飛ぶ。`forceTerminate` は直下の子のみ。テレメトリ同梱 |
| `google-gemini/gemini-cli` **全体** | #24923 (`'exit'` vs `'close'`) と PTY 経路の未解決 issue 群。`process-utils.ts` のみ採用 |
| `sst/opencode` | `packages/core/src/tool/bash.ts` の TODO が M1 要件をほぼ全部「未実装」と自己申告。`permission.assert(...)` の人間承認が無人運用と両立しない |
| `charmbracelet/crush` | 埋め込みシェル (`mvdan.cc/sh`) で 3 OS 差を吸収する設計＝OS のシェルを使わない。Go |
| `All-Hands-AI/OpenHands` | tmux 前提で Windows 不可。`action_execution_server.py` が「LEGACY V0 CODE - Deprecated」 |
| `anthropics/anthropic-quickstarts` computer-use-demo | `_BashSession` が tmux / POSIX 専用のセンチネル方式 |
| `cline/cline` | VSCode のシェル統合に密結合。自身の修正が生 `child_process` への後退 (#8824) |
| `coder/agentapi` / tmux 系 MCP | 画面差分方式は大量のビルドログを保持できない。tmux は Windows 不可 |
| `continuedev/continue` | Cursor による買収。#5342 / #3045 |
| E2B / Daytona の再アタッチ方式 | #1074 で 2 分後に `connect(pid)` が失敗、#1352 で再開後 stdout が約 8 KB で停止、#1587 |
| コマンド deny/allow リスト | セキュリティシアター。**層ごと廃止** |
| サイズ制限 FS (tmpfs / hdiutil / diskpart) | tmpfs は OOM デッドロック、Windows にディレクトリ単位クォータが無い、`diskpart` は昇格必須 |

共通する却下理由は「生きているストリームに再アタッチする」設計が **サーバ側に可変な読み取り位置**を持つことです。60 秒で切られる前提では、HTTP Range 相当の **サーバ側状態ゼロのランダムアクセス読み取り** が必須です。
