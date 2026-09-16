# `frlink check` — which agents are installed on this machine

## Problem

`all on` / `all off` / `check` need to know, before touching any key or
model, which coding agents are actually installed — touching nothing for an
absent harness.

## The probe ladder (SSOT)

Installed ⇔ any marker dir exists, else the harness binary is executable
on PATH. The ladder lives in code — `markerDirs()` / `markerExecutable()`
in `src/harnesses/common/installed.ts` — and every adapter's `isInstalled`
is a one-line call into it (`isInstalledByMarker`). `markerDirs` declares
detection and writes equal: each case delegates to the SAME resolver the
harness's own on/off flows through (dsh `dshHome()`, pi `agentDir()`,
hermes `configPath()`, opencode `configPath()`, cursor
`cursorStateDbPath()`, claude `userSettingsPath()`, codex `configPath()`)
— so where detection looks and where writes land cannot disagree by
construction. Tests import the same functions; the table below is a human
summary, enforced by `installed.test.ts` (a new harness without a case
fails the suite).

Rungs, strongest evidence first:

1. **Dedicated HOME env override** — where the app itself has one
   (`DSH_HOME`, `HERMES_HOME`, `PI_CODING_AGENT_DIR`). An explicitly
   relocated install is the strongest signal.
2. **Default config location** — dotdir under `$HOME` (`~/.claude`,
   `~/.codex`, `~/.pi/agent`, `~/.dsh`, `~/.hermes`), or
   `$XDG_CONFIG_HOME/<app>` for apps that follow XDG (`opencode`
   `$XDG_CONFIG_HOME/opencode`).
3. **Executable on PATH** — weakest rung, last resort. Catches
   installed-but-never-run (npm install creates the config dir only on
   first launch). Cursor has no binary rung: the Cursor IDE binary on
   PATH proves nothing about the app-data we mutate.

**Binary-required harnesses (dsh, hermes):** their `on`/`off` shells out
to the harness's own CLI (`dsh plugin …`, `hermes plugins …`), so the
run order inverts — the executable on PATH IS the marker, and the config
dir alone proves nothing: a dir can outlive a deleted binary (the
`spawn dsh ENOENT` half-install reported in review), while a binary that
was never run still works fine. For everyone else the ladder above runs
in order — their `on`/`off` write config files directly and never spawn.

| Harness  | Marker dirs (1+2)                                                                                                                      | Binary rung (3)      | Why                                                                                  |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------ |
| claude   | `~/.claude/`                                                                                                                           | `claude`             | config root, created on install/first run                                            |
| codex    | `~/.codex/`                                                                                                                            | `codex`              | `config.toml` lives inside                                                           |
| dsh      | `$DSH_HOME` or `~/.dsh/` (write path only)                                                                                             | `dsh` — sole rung    | `on`/`off` spawn `dsh plugin`; dir leftovers are not installable                     |
| pi       | `$PI_CODING_AGENT_DIR` or `~/.pi/agent/`                                                                                               | `pi`                 | dir only appears on first run — the original "installed but reports uninstalled" bug |
| hermes   | `$HERMES_HOME` or `~/.hermes/` (write path only)                                                                                       | `hermes` — sole rung | `on`/`off` spawn `hermes plugins`; dir leftovers are not installable                 |
| opencode | `$XDG_CONFIG_HOME/opencode/` (default `~/.config/opencode/`)                                                                           | `opencode`           | parent of `opencode.json`, XDG-aware                                                 |
| cursor   | platform app-data `Cursor/` (macOS `~/Library/Application Support/Cursor`, Windows `%APPDATA%\Cursor`, else `$XDG_CONFIG_HOME/Cursor`) | none                 | user-data root, only exists once Cursor has run                                      |

## Probe error semantics

Only genuine absence (`ENOENT`, `ENOTDIR`) reads as "not installed". Any
other probe error (EACCES, EMFILE, ...) can neither prove nor disprove the
harness, so the harness is reported as probe-failed on stderr and treated
as installed — `on`/`off` then surfaces the real error instead of a silent
skip on a machine we couldn't inspect.

## Command

`frlink check installed [--json]`

- Read-only: partitions the registry via the same code path as `all`; no
  key resolution, no model selection, nothing written.
- Prose output: `installed: <labels>.` and `not installed: <labels>.`
  (or "no supported coding agents are installed." when nothing is — that
  is the answer, not an error).
- `--json`: `{ "<harness-id>": true|false, ... }` covering the whole
  registry.
