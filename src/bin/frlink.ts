#!/usr/bin/env node
import { runAllCommand, runCheckCommand } from "../cli/commands/all.js";
import {
  runGlobalStatus,
  runLogin,
  runLogout,
  runModelList,
} from "../cli/commands/global.js";
import { runHarnessCommand } from "../cli/commands/harness.js";
import { parseCli } from "../cli/parse-args.js";

const HELP_TEXT = `frlink — run your coding agents on Friendli Model APIs

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

Flags for \`all\`:
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

frlink also answers to \`frn\` and \`friendlilink\`.
`;

async function main(): Promise<void> {
  const parsed = parseCli(process.argv.slice(2));

  switch (parsed.kind) {
    case "help":
      console.log(HELP_TEXT);
      return;
    case "error":
      console.error(`frlink: ${parsed.message}`);
      process.exitCode = 1;
      return;
  }

  switch (parsed.kind) {
    case "harness":
      await runHarnessCommand(parsed.route, parsed.ctx);
      return;
    case "all":
      await runAllCommand(parsed.verb, parsed.ctx);
      return;
    case "check":
      await runCheckCommand(parsed.ctx);
      return;
    case "login":
      await runLogin(parsed.ctx);
      return;
    case "logout":
      await runLogout(parsed.ctx);
      return;
    case "global-status":
      await runGlobalStatus(parsed.ctx);
      return;
    case "model-list":
      await runModelList(parsed.ctx);
      return;
  }
}

main().catch((error: unknown) => {
  console.error(`frlink: ${(error as Error).message}`);
  process.exitCode = 1;
});
