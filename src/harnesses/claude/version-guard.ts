import * as clack from "@clack/prompts";
import { runCommand, type CommandResult } from "../../system/exec.js";
import {
  compareSemver,
  formatSemver,
  parseSemver,
  type Semver,
} from "../../system/semver.js";

const CLAUDE_CODE_PACKAGE = "@anthropic-ai/claude-code";

/** A range of Claude Code releases known to break against Friendli's Model API. */
export interface ClaudeIncompatibility {
  /** Newest Claude Code release that still works; anything above it is refused. */
  lastCompatibleVersion: string;
  /** One clause naming what breaks, spliced into the prompt and the errors. */
  summary: string;
}

/**
 * The incompatibility this guard was built for: Claude Code v2.1.234 and
 * later sent tool definitions using `allOf` with multiple subschemas, which
 * Friendli's Model API rejected with a 422.
 *
 * The Model API accepts those schemas now, so this entry is kept as the
 * worked example (and the guard's test fixture) rather than deleted —
 * assigning it to `ACTIVE_INCOMPATIBILITY` re-arms the whole flow.
 */
export const ALLOF_422_INCOMPATIBILITY: ClaudeIncompatibility = {
  lastCompatibleVersion: "2.1.233",
  summary: "sends 'allOf' tool schemas the Model API rejects with 422",
};

/**
 * What `claude on` enforces today.
 *
 * `null` means no known incompatibility, and the guard stays dormant: it runs
 * no commands, prompts for nothing, pins no version, and leaves Claude Code's
 * auto-updater alone, so users track the latest release. Point this at an
 * entry — `ALLOF_422_INCOMPATIBILITY`, or a new one written the same way —
 * to re-arm the check the next time a Claude Code release breaks against the
 * Model API.
 */
export const ACTIVE_INCOMPATIBILITY: ClaudeIncompatibility | null = null;

export interface VersionGuardResult {
  /** "skipped": no incompatibility is active, so nothing was checked. */
  outcome: "ok" | "downgraded" | "not-installed" | "skipped";
  /** Installed version as reported by `claude --version`, null if unknown. */
  version: string | null;
  downgraded: boolean;
}

export type VersionGuardOutcome = VersionGuardResult | { outcome: "cancelled" };

/** The oldest release the incompatibility covers — one patch past the last
 * compatible one. */
function firstIncompatibleVersion(last: Semver): string {
  return formatSemver({ ...last, patch: last.patch + 1 });
}

function downgradeInstruction(npmManaged: boolean, target: string): string {
  return npmManaged
    ? `npm install -g ${CLAUDE_CODE_PACKAGE}@${target}`
    : `claude install ${target}`;
}

/** `claude --version` output, or null when the CLI is missing/unparseable. */
async function readInstalledVersion(): Promise<Semver | null> {
  let output: CommandResult;
  try {
    output = await runCommand("claude", ["--version"], { timeoutMs: 15_000 });
  } catch {
    return null;
  }
  return parseSemver(`${output.stdout} ${output.stderr}`);
}

/**
 * `claude doctor` reports how this install is managed, e.g. a
 * "Config install method: npm" or "Config install method: native" line —
 * straight from the CLI itself, so it stays accurate even if Anthropic adds
 * install methods beyond npm and native later. Returns the lowercased method
 * name, or null if `doctor` doesn't exist (older CLI) or its output doesn't
 * match.
 */
async function readDoctorInstallMethod(): Promise<string | null> {
  try {
    const result = await runCommand("claude", ["doctor"], {
      timeoutMs: 15_000,
    });
    if (!result.ok) {
      return null;
    }
    const match = /Config install method:\s*(\S+)/i.exec(result.stdout);
    return match?.[1] ? match[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Claude Code ships two install methods: npm (`npm install -g
 * @anthropic-ai/claude-code`) and Anthropic's native installer, which manages
 * its own versioned binaries under `~/.local/share/claude/versions` and
 * exposes `claude install <version>` to switch between them. Downgrading
 * always via `npm install -g` breaks the native case: npm tries to place its
 * own bin link at the same PATH entry the native installer already owns and
 * fails with EEXIST.
 *
 * `claude doctor`'s self-reported method is the primary signal; `npm ls -g`
 * is only a fallback for CLI versions old enough to lack `doctor`.
 */
async function claudeIsNpmManaged(): Promise<boolean> {
  const reported = await readDoctorInstallMethod();
  if (reported) {
    return reported === "npm";
  }
  try {
    const result = await runCommand(
      "npm",
      ["ls", "-g", CLAUDE_CODE_PACKAGE, "--depth=0"],
      {
        timeoutMs: 15_000,
      },
    );
    return result.ok;
  } catch {
    return false;
  }
}

async function downgradeToLastCompatible(
  current: Semver,
  last: Semver,
  npmManaged: boolean,
): Promise<VersionGuardResult> {
  const target = formatSemver(last);
  console.log(
    `frlink: Downgrading Claude Code from v${formatSemver(current)} to v${target}...`,
  );
  const instruction = downgradeInstruction(npmManaged, target);

  let install: CommandResult;
  try {
    install = npmManaged
      ? await runCommand(
          "npm",
          ["install", "-g", `${CLAUDE_CODE_PACKAGE}@${target}`],
          {
            timeoutMs: 300_000,
          },
        )
      : await runCommand("claude", ["install", target], { timeoutMs: 300_000 });
  } catch (error) {
    throw new Error(
      `${(error as Error).message}\nDowngrade manually instead: ${instruction}, then rerun \`frlink claude on\`.`,
      { cause: error },
    );
  }
  if (!install.ok) {
    throw new Error(
      `Downgrading Claude Code failed${install.stderr ? `:\n${install.stderr.trim()}` : "."} ` +
        `Downgrade manually instead: ${instruction}, then rerun \`frlink claude on\`.`,
    );
  }

  // The install command succeeding is not proof — verify the pinned version is on PATH now.
  const rechecked = await readInstalledVersion();
  if (!rechecked || compareSemver(rechecked, last) !== 0) {
    throw new Error(
      `Claude Code still reports v${rechecked ? formatSemver(rechecked) : "unknown"} after the downgrade — ` +
        `expected v${target}. Check \`which claude\` and that no other Claude Code install ` +
        `takes precedence on PATH, then rerun \`frlink claude on\`.`,
    );
  }
  return {
    outcome: "downgraded",
    version: formatSemver(rechecked),
    downgraded: true,
  };
}

/**
 * The "is it okay to downgrade?" step of `claude on`. When an incompatibility
 * is active, it verifies the installed Claude Code is compatible with
 * Friendli's Model API, downgrades it (with the user's consent) when it
 * isn't, and refuses to continue otherwise: enabling FriendliLink on a
 * known-broken Claude Code would just produce API errors. With none active
 * (the default today) it returns "skipped" without touching the machine.
 *
 * Runs before any config write, so a decline or a failed downgrade leaves the
 * user's settings untouched.
 */
export async function runClaudeVersionGuard(options: {
  interactive: boolean;
  /** Overrides `ACTIVE_INCOMPATIBILITY`; `null` forces the dormant path. */
  incompatibility?: ClaudeIncompatibility | null;
}): Promise<VersionGuardOutcome> {
  const incompatibility =
    options.incompatibility === undefined
      ? ACTIVE_INCOMPATIBILITY
      : options.incompatibility;
  if (!incompatibility) {
    return { outcome: "skipped", version: null, downgraded: false };
  }

  const last = parseSemver(incompatibility.lastCompatibleVersion);
  if (!last) {
    throw new Error(
      `Invalid lastCompatibleVersion "${incompatibility.lastCompatibleVersion}" in the active Claude Code incompatibility.`,
    );
  }

  const version = await readInstalledVersion();
  if (!version) {
    clack.log.warn(
      "Could not determine the installed Claude Code version; skipping the version check.",
    );
    return { outcome: "not-installed", version: null, downgraded: false };
  }

  if (compareSemver(version, last) <= 0) {
    return { outcome: "ok", version: formatSemver(version), downgraded: false };
  }

  const found = formatSemver(version);
  const target = formatSemver(last);
  const npmManaged = await claudeIsNpmManaged();
  const instruction = downgradeInstruction(npmManaged, target);

  if (!options.interactive) {
    throw new Error(
      `Claude Code v${found} is not compatible with FriendliAI's Model API: v${firstIncompatibleVersion(last)} ` +
        `and later ${incompatibility.summary}. ` +
        `Downgrade first: ${instruction}, then rerun \`frlink claude on\`.`,
    );
  }

  const confirmed = await clack.confirm({
    message:
      `Claude Code v${found} is not compatible with FriendliAI's Model API ` +
      `(v${firstIncompatibleVersion(last)}+ ${incompatibility.summary}). ` +
      `Is it okay to downgrade Claude Code to v${target}?`,
  });
  if (clack.isCancel(confirmed) || !confirmed) {
    return { outcome: "cancelled" };
  }

  return downgradeToLastCompatible(version, last, npmManaged);
}
