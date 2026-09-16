import { resolveHarnessId } from "../harness/registry.js";
import {
  createBaseContext,
  type AllVerb,
  type HarnessContext,
  type HarnessRoute,
  type HarnessVerb,
} from "../harness/types.js";

export type ParsedCommand =
  | { kind: "harness"; route: HarnessRoute; ctx: HarnessContext }
  | { kind: "all"; verb: AllVerb; ctx: HarnessContext }
  | { kind: "check"; ctx: HarnessContext }
  | { kind: "login"; ctx: HarnessContext }
  | { kind: "logout"; ctx: HarnessContext }
  | { kind: "global-status"; ctx: HarnessContext }
  | { kind: "model-list"; ctx: HarnessContext }
  | { kind: "help" }
  | { kind: "error"; message: string };

const HARNESS_VERBS: HarnessVerb[] = ["on", "off", "status"];
const ALL_VERBS: AllVerb[] = ["on", "off"];

export function parseCli(argv: string[]): ParsedCommand {
  try {
    return parseCliInner(argv);
  } catch (error) {
    return { kind: "error", message: (error as Error).message };
  }
}

function parseCliInner(argv: string[]): ParsedCommand {
  const [command, ...rest] = argv;

  if (
    !command ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    return { kind: "help" };
  }

  if (command === "login") {
    return { kind: "login", ctx: applyFlags(createBaseContext(), rest) };
  }
  if (command === "logout") {
    return { kind: "logout", ctx: applyFlags(createBaseContext(), rest) };
  }
  if (command === "model") {
    const [sub, ...modelRest] = rest;
    if (sub !== "list") {
      return {
        kind: "error",
        message: `Unknown \`model\` subcommand: ${sub ?? "(none)"}. Try \`frlink model list\`.`,
      };
    }
    return {
      kind: "model-list",
      ctx: applyFlags(createBaseContext(), modelRest),
    };
  }
  if (command === "check") {
    const [sub, ...checkRest] = rest;
    return (
      parseInventory(sub, checkRest) ?? {
        kind: "error",
        message: `Unknown \`check\` subcommand: ${sub ?? "(none)"}. Try \`frlink check installed\` or \`frlink check status\`.`,
      }
    );
  }
  if (command === "all") {
    const [verb, ...allRest] = rest;
    // `all installed` / `all status` are aliases for the `check` inventory —
    // `all` is the namespace people reach for first.
    const inventory = parseInventory(verb, allRest);
    if (inventory) {
      return inventory;
    }
    if (!verb || !ALL_VERBS.includes(verb as AllVerb)) {
      return {
        kind: "error",
        message: `Usage: frlink all <on|off|installed|status> [flags]`,
      };
    }
    // `all` targets several agents at once; single-agent path flags
    // (--settings-path/--data-dir) and Claude-only model slots would be
    // handed to every adapter and can collide across file formats — reject.
    const agentSpecific = allRest.find((arg) =>
      [
        "--settings-path",
        "--data-dir",
        "--opus",
        "--sonnet",
        "--haiku",
        "--fable",
        "--subagent",
      ].includes(arg),
    );
    if (agentSpecific) {
      return {
        kind: "error",
        message: `\`${agentSpecific}\` targets a single agent — run \`frlink <agent> ${verb} ${agentSpecific} ...\` instead.`,
      };
    }
    return {
      kind: "all",
      verb: verb as AllVerb,
      ctx: applyFlags(createBaseContext(), allRest),
    };
  }

  const harnessId = resolveHarnessId(command);
  if (!harnessId) {
    return {
      kind: "error",
      message: `Unknown command or agent: ${command}. Try \`frlink help\`.`,
    };
  }

  const [verb, ...harnessRest] = rest;
  if (!verb || !HARNESS_VERBS.includes(verb as HarnessVerb)) {
    return {
      kind: "error",
      message: `Usage: frlink ${harnessId} <on|off|status> [flags]`,
    };
  }

  const ctx = applyFlags(createBaseContext(), harnessRest, harnessId);
  return {
    kind: "harness",
    route: { harnessId, verb: verb as HarnessVerb },
    ctx,
  };
}

/** The read-only inventory subcommands, shared by `check` and its `all`
 * aliases. Returns undefined when `sub` names neither. */
function parseInventory(
  sub: string | undefined,
  rest: string[],
): ParsedCommand | undefined {
  if (sub !== "installed" && sub !== "status") {
    return undefined;
  }
  const ctx = applyFlags(createBaseContext(), rest);
  if (ctx.exclude) {
    // This is a read-only inventory — hiding agents from it would make the
    // report lie. Narrow the target set with `all on/off --exclude`.
    throw new Error(
      "`check` does not support --exclude — it lists every agent unconditionally. Use `all <verb> --exclude` to narrow writes.",
    );
  }
  return sub === "installed"
    ? { kind: "check", ctx }
    : { kind: "global-status", ctx };
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (value === undefined) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

/**
 * Flags only one harness understands. Everything else is accepted everywhere;
 * these are rejected outside their own command, so `codex on --opus <id>`
 * fails loudly instead of being silently ignored.
 */
const HARNESS_ONLY_FLAGS: Record<string, string> = {
  "--opus": "claude",
  "--sonnet": "claude",
  "--haiku": "claude",
  "--fable": "claude",
  "--subagent": "claude",
};

function applyFlags(
  ctx: HarnessContext,
  args: string[],
  harnessId?: string,
): HarnessContext {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const onlyFor = arg ? HARNESS_ONLY_FLAGS[arg] : undefined;
    if (onlyFor && harnessId !== onlyFor) {
      throw new Error(
        `${arg} is a \`${onlyFor}\` flag${harnessId ? `, not a \`${harnessId}\` one` : ""}.`,
      );
    }
    switch (arg) {
      case "--api-key":
        ctx.apiKey = requireValue(args, ++i, "--api-key");
        ctx.apiKeyFromFlag = true;
        break;
      case "--base-url":
        ctx.baseUrl = requireValue(args, ++i, "--base-url");
        ctx.baseUrlFromFlag = true;
        break;
      case "--model":
        ctx.main = requireValue(args, ++i, "--model");
        ctx.mainFromFlag = true;
        break;
      case "--opus":
        ctx.opus = requireValue(args, ++i, "--opus");
        break;
      case "--sonnet":
        ctx.sonnet = requireValue(args, ++i, "--sonnet");
        break;
      case "--haiku":
        ctx.haiku = requireValue(args, ++i, "--haiku");
        break;
      case "--fable":
        ctx.fable = requireValue(args, ++i, "--fable");
        break;
      case "--subagent":
        ctx.subagent = requireValue(args, ++i, "--subagent");
        break;
      case "--interactive":
        ctx.onboardingMode = "prompt";
        break;
      case "--non-interactive":
        ctx.onboardingMode = "skip";
        break;
      case "--json":
        ctx.json = true;
        break;
      case "--force":
        ctx.force = true;
        break;
      case "--await-cursor-exit":
        // Internal: set by the detached run `cursor on/off` schedules from
        // inside Cursor's terminal. Deliberately absent from help.
        ctx.awaitCursorExit = true;
        break;
      case "--reasoning":
        ctx.reasoning = requireValue(args, ++i, "--reasoning");
        break;
      case "--settings-path":
        ctx.settingsPath = requireValue(args, ++i, "--settings-path");
        break;
      case "--data-dir":
        ctx.dataDir = requireValue(args, ++i, "--data-dir");
        break;
      case "--profile":
        ctx.profile = requireValue(args, ++i, "--profile");
        break;
      case "--exclude":
        ctx.exclude = requireValue(args, ++i, "--exclude");
        break;
      default:
        throw new Error(`Unknown flag: ${arg}. Try \`frlink help\`.`);
    }
  }
  return ctx;
}
