/*
 * Shell selection, script generation and child environment.
 *
 * The prologue/epilogue pair for pwsh is taken VERBATIM from actions/runner
 * src/Runner.Worker/Handlers/ScriptHandlerHelpers.cs (MIT, blob
 * 6ec953b78d0ac8e637d420be02346473efad577a):
 *
 *     var prepend = "$ErrorActionPreference = 'stop'";
 *     var append  = @"if ((Test-Path -LiteralPath variable:\LASTEXITCODE)) { exit $LASTEXITCODE }";
 *
 * That append is the fix for the previous system's worst symptom. `pwsh -File`
 * leaves $LASTEXITCODE unset and a *.ps1 script's own exit status defaults to 0
 * (about_Automatic_Variables; PowerShell#11461: "In the absence of an explicit
 * exit statement, POSIX-like shells report the last statement's exit code as the
 * script's, whereas *.ps1 scripts default to 0"). So a failed build came back as
 * `exit 0` with "command produced no output". Azure DevOps' PowerShell@2 task
 * documents the identical one-line fix, which is good evidence it is the right
 * one rather than a coincidence.
 */

import { IS_WIN, PLATFORM, SCRUB_EXACT, SCRUB_PREFIXES, shellsPath } from "./config.mjs"
import { readJsonOr } from "./util.mjs"
import { spawnSync } from "node:child_process"

/* ------------------------------------------------------------- shell facts */

let SHELLS = null

/**
 * Which shells actually exist here. Published as facts.shells at enroll so a bad
 * `shell:` can be refused up front instead of failing a command later.
 *
 * PowerShell 7 does not replace Windows PowerShell 5.1: Microsoft installs it to
 * a separate directory and the two run side-by-side. actions/runner#3415 records
 * that an explicit `pwsh` deliberately does NOT fall back to Desktop. We take
 * the same position, and we say so instead of guessing.
 */
export function probeShells() {
	const ver = (exe, args) => {
		try {
			const r = spawnSync(exe, args, {
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 8000,
				windowsHide: true,
				encoding: "utf8",
			})
			if (r && r.status === 0 && r.stdout) {
				return String(r.stdout).trim().split(/\r?\n/)[0].slice(0, 120)
			}
		} catch {
			/* not installed */
		}
		return null
	}
	return {
		pwsh: ver(IS_WIN ? "pwsh.exe" : "pwsh", ["-v"]),
		bash: ver(IS_WIN ? "bash.exe" : "/bin/bash", ["--version"]),
		sh: IS_WIN ? null : ver("/bin/sh", ["-c", "echo /bin/sh"]),
		zsh: IS_WIN ? null : ver("zsh", ["--version"]),
		cmd: IS_WIN ? process.env.COMSPEC || "cmd.exe" : null,
	}
}

export function shells() {
	if (SHELLS) return SHELLS
	SHELLS = readJsonOr(shellsPath(), null) || probeShells()
	return SHELLS
}

const SHELL_KINDS = {
	pwsh: { kind: "pwsh", ext: ".ps1" },
	bash: { kind: "bash", ext: ".sh" },
	sh: { kind: "sh", ext: ".sh" },
	zsh: { kind: "zsh", ext: ".sh" },
	cmd: { kind: "cmd", ext: ".cmd" },
}

/** @returns {{ok:true, kind:string, ext:string} | {ok:false, error:string}} */
export function shellPlan(requested) {
	const want = String(requested || (IS_WIN ? "pwsh" : "bash")).toLowerCase()
	if (want === "powershell") {
		return {
			ok: false,
			error:
				"shell 'powershell' (Windows PowerShell 5.1) is not supported: it is a separate " +
				"side-by-side product whose redirection operators corrupt byte streams. Use shell:'pwsh'.",
		}
	}
	const plan = SHELL_KINDS[want]
	if (!plan) {
		return {
			ok: false,
			error: `unknown shell '${want}'; expected one of ${Object.keys(SHELL_KINDS).join(", ")}`,
		}
	}
	const have = shells()
	if (!have[plan.kind]) {
		return {
			ok: false,
			error:
				`shell '${want}' is not present on this ${PLATFORM} runner ` +
				`(facts.shells.${plan.kind} is null). No fallback is attempted by design.`,
		}
	}
	return { ok: true, ...plan }
}

/* ----------------------------------------------------------------- quoting */

/** POSIX single-quote: close, escape, reopen. */
export function q(s) {
	return `'${String(s).replace(/'/g, "'\\''")}'`
}

/** PowerShell single-quote: double it. */
export function pq(s) {
	return `'${String(s).replace(/'/g, "''")}'`
}

/* ----------------------------------------------------------------- scripts */

export function posixScript(cmd, ctx) {
	const shebang =
		ctx.kind === "sh" ? "/bin/sh" : ctx.kind === "zsh" ? "/usr/bin/env zsh" : "/usr/bin/env bash"
	// actions/runner's documented POSIX invocation is
	//     bash --noprofile --norc -eo pipefail {0}
	// (docs/adrs/0277-run-action-shell-options.md). We keep pipefail and
	// deliberately drop -e: the caller sends multi-command input, and -e aborts the
	// whole script on the first non-zero status, including `tput` under TERM=dumb,
	// which exits 3.
	//
	// Note what is NOT here: `exec 0</dev/null`. stdin is already a real file, and
	// the previous version of this script silently threw away caller-supplied
	// stdin by reopening fd 0.
	return (
		`#!${shebang}\n` +
		`set -o pipefail 2>/dev/null || true\n` +
		`cd ${q(ctx.cwd)} || exit 127\n` +
		`if [ -f ${q(ctx.overlay)} ]; then . ${q(ctx.overlay)}; fi\n` +
		`{\n${cmd}\n}\n` +
		`__gha_rc=$?\n` +
		`pwd > ${q(ctx.cwdOut)} 2>/dev/null || true\n` +
		`printf '%s' "$__gha_rc" > ${q(ctx.rc)}.tmp 2>/dev/null && mv -f ${q(ctx.rc)}.tmp ${q(ctx.rc)} 2>/dev/null\n` +
		`exit $__gha_rc\n`
	)
}

export function pwshScript(cmd, ctx) {
	// Encoding is pinned here, in the shell, rather than guessed by the reader.
	// [Console]::OutputEncoding decides how pwsh DECODES a native program's output
	// (PowerShell#14945: "it is [Console]::OutputEncoding that determines how
	// PowerShell decodes the output from native programs"), and $OutputEncoding
	// decides how it ENCODES text piped INTO one (PowerShell#7233). Both are
	// required; setting only the first was a bug.
	//
	// There is no `2>&1` and no `>` anywhere: the merge happens at the file
	// descriptor level, upstream of the shell. PowerShell's own redirection only
	// became byte-transparent for native commands in 7.4 (about_Redirection), and
	// Windows PowerShell 5.1 corrupts files outright (FiloSottile/age#290).
	return [
		`$ErrorActionPreference = 'stop'`,
		`$ProgressPreference = 'SilentlyContinue'`,
		`try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}`,
		`try { [Console]::InputEncoding  = [System.Text.UTF8Encoding]::new($false) } catch {}`,
		`try { $OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}`,
		`try { if ($PSStyle) { $PSStyle.OutputRendering = 'PlainText' } } catch {}`,
		`Set-Location -LiteralPath ${pq(ctx.cwd)}`,
		`if (Test-Path -LiteralPath ${pq(ctx.overlay)}) {`,
		`  Get-Content -LiteralPath ${pq(ctx.overlay)} | ForEach-Object {`,
		`    if ($_ -match '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {`,
		`      [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2])`,
		`    }`,
		`  }`,
		`}`,
		`$global:LASTEXITCODE = $null`,
		`& {`,
		String(cmd),
		`}`,
		// Capture immediately: every line below would clobber $LASTEXITCODE and $?.
		`$__gha_rc = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }`,
		`try { (Get-Location).Path | Set-Content -LiteralPath ${pq(ctx.cwdOut)} -NoNewline } catch {}`,
		`try { Set-Content -LiteralPath ${pq(ctx.rc)} -Value "$__gha_rc" -NoNewline } catch {}`,
		// Guarantee the upstream epilogue below always fires, which is the whole
		// reason -File is safe for us.
		`$global:LASTEXITCODE = $__gha_rc`,
		`if ((Test-Path -LiteralPath variable:\\LASTEXITCODE)) { exit $LASTEXITCODE }`,
		``,
	].join("\n")
}

export function cmdScript(cmd, ctx) {
	return (
		`@echo off\r\n` +
		`chcp 65001 >nul 2>nul\r\n` +
		`cd /d "${ctx.cwd}"\r\n` +
		`${String(cmd).replace(/\r?\n/g, "\r\n")}\r\n` +
		`set __gha_rc=%ERRORLEVEL%\r\n` +
		`cd > "${ctx.cwdOut}"\r\n` +
		`<nul set /p=%__gha_rc%> "${ctx.rc}"\r\n` +
		`exit /b %__gha_rc%\r\n`
	)
}

export function renderScript(kind, cmd, ctx) {
	if (kind === "pwsh") return pwshScript(cmd, ctx)
	if (kind === "cmd") return cmdScript(cmd, ctx)
	return posixScript(cmd, ctx)
}

/* -------------------------------------------------------------- invocation */

export function spawnArgs(kind, scriptPath) {
	switch (kind) {
		case "pwsh":
			// actions/runner's docs say `pwsh -command ". '{0}'"` while its own ADR 0277
			// says `"& '{0}'"` -- upstream disagrees with itself. We diverge on purpose
			// and use -File, which is only safe BECAUSE of the appended LASTEXITCODE
			// epilogue. -NoProfile and -NonInteractive are additions too: the runner
			// passes neither, but a profile on a self-hosted box must not be able to
			// undo our encoding setup, and an interactive prompt behind a non-TTY stdin
			// hangs forever (eas-cli#3774, apify-cli#1206).
			return [
				IS_WIN ? "pwsh.exe" : "pwsh",
				["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
			]
		case "cmd":
			// /V:OFF is the important half of actions/runner's
			//     %ComSpec% /D /E:ON /V:OFF /S /C "CALL "{0}""
			// With delayed expansion on, a literal ! in the caller's command is eaten.
			// We pass the script path as its own argv entry rather than embedding it in
			// a quoted CALL, to stay clear of cmd.exe's nested-quote parsing.
			return [process.env.COMSPEC || "cmd.exe", ["/d", "/e:on", "/v:off", "/s", "/c", scriptPath]]
		case "sh":
			return ["/bin/sh", [scriptPath]]
		case "zsh":
			return ["zsh", [scriptPath]]
		default:
			return [IS_WIN ? "bash.exe" : "/bin/bash", ["--noprofile", "--norc", scriptPath]]
	}
}

export function childEnv(extra) {
	const e = { ...process.env }
	for (const k of Object.keys(e)) {
		if (SCRUB_EXACT.includes(k) || SCRUB_PREFIXES.some((p) => k.startsWith(p))) delete e[k]
	}
	// TERM is intentionally unset rather than set to something. A bare TERM makes
	// tools emit escapes with no terminal to interpret them, and TERM=dumb makes
	// `tput` exit 3, which then trips any script running under set -e.
	delete e.TERM
	e.CI = "1"
	// about_ANSI_Terminals: "If $Env:NO_COLOR exists, then $PSStyle.OutputRendering
	// is set to PlainText". Belt and braces with the preamble in pwshScript.
	e.NO_COLOR = "1"
	e.GIT_TERMINAL_PROMPT = "0"
	e.DEBIAN_FRONTEND = "noninteractive"
	return { ...e, ...(extra || {}) }
}
