# FriendliLink

![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)

> Use [Friendli AI](https://friendli.ai/) models in Claude Code, OpenCode, Codex, Pi, Cursor, Hermes Agent, and DeepSeek Harness.

`frlink` wires the agent's provider settings (API key, base URL, model) to run through Friendli, and can restore the original settings just as easily.

Supported agents: **Claude Code CLI**, **Cursor Desktop / IDE**, **Codex CLI**, **OpenCode**, **Pi**, **Hermes Agent**, **DeepSeek Harness**.

## Table of contents

- [Install](#install)
- [Authentication](#authentication)
- [Enabling a harness](#enabling-a-harness)
  - [Checking what's installed on your machine](#checking-whats-installed-on-your-machine)
  - [Connect a harness](#connect-a-harness)
  - [All harnesses at once](#all-harnesses-at-once)
  - [Verify connection](#verify-connection)
- [Per-harness guides](#claude-code)
  - [Claude Code](#claude-code)
  - [Cursor](#cursor)
  - [Hermes Agent](#hermes-agent)
  - [DeepSeek Harness (dsh)](#deepseek-harness-dsh)
- [All commands](#all-commands)
- [Aliases](#aliases)

## Install

One-liner (downloads and runs the installer):

```bash
curl -fsSL https://raw.githubusercontent.com/friendliai/friendlilink/main/install.sh | bash
```

Or from a clone:

```bash
gh repo clone friendliai/friendlilink
cd friendlilink
npm install
npm run dev -- login
```

The installer builds the CLI and puts a `frlink` launcher on your `PATH` (`~/.local/bin`). Requires Node.js &gt;= 18.

## Authentication

Grab your API key at [Friendli Suite](https://friendli.ai/suite), then:

```bash
frlink login
```

## Enabling a harness

### Checking what's installed on your machine

```bash
frlink check installed
```

```text
frlink: Installed: Claude Code, Codex, DeepSeek Harness, Hermes Agent, OpenCode, Pi.
frlink: Not installed: Cursor.
```

### Connect a harness

Where `<agent>` is one of: `claude`, `cursor`, `codex`, `opencode`, `pi`, `hermes`, `dsh`.

```bash
frlink <agent> on
```

### All harnesses at once

```bash
frlink all on
```

```text
frlink: Enabled FriendliAI on Claude Code, Codex, DeepSeek Harness, OpenCode, Pi.
frlink: Cursor is not installed — skipped.
frlink: Hermes Agent is already routed through FriendliAI — left untouched.
```

### Verify connection

```bash
frlink check status
```

```text
FriendliAI API key: saved
  claude (Claude Code): routed through FriendliAI
  codex (Codex): routed through FriendliAI
  cursor (Cursor): routed through FriendliAI
  dsh (DeepSeek Harness): routed through FriendliAI
  hermes (Hermes Agent): routed through FriendliAI
  opencode (OpenCode): routed through FriendliAI
  pi (Pi): routed through FriendliAI
```

Agents frlink has not connected report `not routed` — they are still on their
own provider.

---

## Claude Code

Claude Code routes through per-slot model mapping — pick a Friendli model for each of Claude Code's model slots, either interactively or with flags:

```bash
frlink claude on
```

```text
claude: routed through FriendliAI.
  api key source: keychain
  opus: zai-org/GLM-5.3
  sonnet: zai-org/GLM-5.3-Flash
  haiku: google/gemma-4-31B-it
```

## Cursor

FriendliAI Model APIs work in Cursor's local chat, so open a folder before you use one. Cloud Agents — "Build in Cloud", "Start from scratch", Automations, and the Web/iOS/Slack/GitHub/Linear/API surfaces — run on Cursor's infrastructure and cannot use a model running with custom API key.

## Hermes Agent

Hermes resolves its home from `$HERMES_HOME` (default `~/.hermes`), and frlink writes to whatever home that resolves to. To configure frlink per hermes profile, point `HERMES_HOME` at the profile directory and run `on`

```bash
hermes profile create myprofile          # creates ~/.hermes/profiles/myprofile
export HERMES_HOME=~/.hermes/profiles/myprofile
frlink hermes on
hermes -p myprofile                      # runs against that profile
```

Run without the env var to configure the default home (`~/.hermes`).

> Hermes can also be configured without `frlink` by installing the [hermes-friendli-provider](packages/hermes-friendli-provider/) plugin directly.

## DeepSeek Harness (dsh)

`dsh` operates on a dsh profile (default `web`). Pass `--profile <name>` to target a different profile — on every verb (`on`, `off`, `status`), since state is per-profile:

```bash
frlink dsh on --profile myprofile
```

The dsh home itself follows `$DSH_HOME` (default `~/.dsh`).

> DeepSeek Harness can also be configured without frlink by installing the [@friendliai/dsh-llm-friendli](packages/dsh-llm-friendli/) plugin directly.

## All commands

<!-- Keep in sync with HELP_TEXT in src/bin/frlink.ts -->

```text
frlink — run your coding agents on FriendliAI models

Usage:
  frlink <command> [flags]
  frlink <agent> <on|off|status> [flags]

Getting started:
  frlink login [--api-key <key>]    Save your FriendliAI API key
  frlink check installed [--json]   List the agents installed on this machine
  frlink all on [flags]             Route every installed agent through FriendliAI
  frlink all off [flags]            Restore every agent's own settings

Agents:
  claude    Claude Code CLI          opencode  OpenCode
  cursor    Cursor Desktop / IDE     pi        Pi
  codex     Codex CLI                hermes    Hermes Agent
  dsh       DeepSeek Harness

Per-agent commands:
  frlink <agent> on [--api-key <key>] [--model <id>]
  frlink <agent> off
  frlink <agent> status [--json]

Agent-specific flags:
  claude    [--opus|--sonnet|--haiku|--fable|--subagent <id>]
            [--interactive|--non-interactive] [--base-url <url>]
  codex     [--reasoning <off|minimal|low|medium|high|xhigh|max|ultracode>]
  cursor    [--force]  (takes no --model — you pick the model inside Cursor)
  dsh       [--profile <name>]

Flags for `all`:
  frlink all on  [--api-key <key>] [--model <id>] [--base-url <url>]
                 [--force] [--interactive|--non-interactive] [--exclude <ids>]
  frlink all off [--force] [--exclude <ids>]

Other commands:
  frlink logout                     Remove the saved API key
  frlink check status [--json]      Show how every agent is routed
  frlink model list [--json]        List FriendliAI models and their prices
  frlink help                       Show this help

Examples:
  frlink login
  frlink claude on                  Route Claude Code through FriendliAI
  frlink all on --exclude cursor    Route everything except Cursor
  frlink claude off                 Put Claude Code's own settings back

frlink also answers to `frn` and `friendlilink`.
```
