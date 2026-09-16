import * as clack from "@clack/prompts";
import { runCommand } from "../../system/exec.js";
import { PLUGIN_BUNDLE } from "./core.js";
import {
  runPluginCommand,
  type CommandRunner,
} from "../common/plugin-runner.js";

/** The single definition lives in the shared mechanism module; re-exported
 * so the adapter's own import sites stay stable. */
export type { CommandRunner };

/**
 * Resolve the registry's `latest` dist-tag for one package.
 *
 * Needed rather than a bare `dsh plugin add @friendliai/dsh-llm-friendli`: pnpm resolves
 * `latest`-spec plugin adds by peer-satisfaction and silently falls back to
 * the highest version whose peers match `@deepseek-ai/dsh-llm`'s own stale
 * `latest` tag (verified: it installs 0.1.2 while registry latest is 0.1.5,
 * deterministic across pnpm 11/12, caches, and stores). Resolving the tag
 * here and passing an exact spec sidesteps the fallback entirely.
 */
async function registryLatest(
  packageName: string,
  registry: string,
): Promise<string> {
  const response = await fetch(`${registry}/${packageName}`, {
    headers: { accept: "application/vnd.npm.install-v1+json" },
  });
  if (!response.ok) {
    throw new Error(
      `could not look up the latest ${packageName} on ${registry} (HTTP ${response.status})`,
    );
  }
  const distTags = (await response.json()) as Record<
    string,
    { latest?: unknown }
  >;
  const latest: unknown = distTags["dist-tags"]?.latest;
  if (typeof latest !== "string" || latest === "") {
    throw new Error(`no "latest" dist-tag found for ${packageName}`);
  }
  return latest;
}

/** The registry `latest` lookup; overridable in tests to keep them offline. */
let latestTagResolver:
  ((packageName: string, registry: string) => Promise<string>) | null = null;

export function setDshLatestTagResolverForTests(
  resolver: typeof latestTagResolver,
) {
  latestTagResolver = resolver;
}

const NPM_REGISTRY = "https://registry.npmjs.org";

/** Short timeout for the pnpm/corepack probes — we just need to know if the
 * binary resolves, not run a full install. */
const PROBE_TIMEOUT_MS = 10_000;

/** Run a command, returning ok:false on spawn failure (ENOENT) instead of
 * rejecting — `runCommand` rejects when a binary is not on PATH, but the
 * probe needs a plain boolean to decide whether to try corepack. */
async function softProbe(
  runner: CommandRunner,
  file: string,
  args: string[],
): Promise<boolean> {
  try {
    const result = await runner(file, args, {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    return result.ok;
  } catch {
    return false;
  }
}

/** Ensure pnpm is on PATH before a `dsh plugin` call. dsh's `plugin`
 * command is a hardcoded pnpm forwarder, so pnpm must be installed.
 *
 * Corepack (bundled with Node.js ≥16.9) can install the pnpm shim via
 * `corepack enable`. If corepack itself is not on PATH, frlink installs it
 * first via `npm install -g corepack`. Both are system-level operations,
 * so the user must confirm before they run; `--non-interactive` refuses
 * instead of prompting.
 *
 * After `corepack enable`, the pnpm binary is downloaded lazily on first
 * invocation — no re-probe is needed, dsh triggers the download within its
 * plugin-command timeout. */
async function ensurePnpmAvailable(
  runner: CommandRunner,
  interactive: boolean,
): Promise<void> {
  if (await softProbe(runner, "pnpm", ["--version"])) return;

  const hint =
    "Install pnpm: `npm install -g pnpm`, or `corepack enable`, then rerun.";

  if (!interactive) throw new Error(`pnpm is not on PATH. ${hint}`);

  const corepackAvailable = await softProbe(runner, "corepack", ["--version"]);
  const message = corepackAvailable
    ? "pnpm isn't installed yet — corepack can enable it with `corepack enable`. OK to proceed?"
    : "pnpm isn't installed yet — frlink can install corepack via npm and enable pnpm for you. OK to proceed?";
  const confirmed = await clack.confirm({ message });
  if (clack.isCancel(confirmed) || !confirmed) {
    throw new Error(`pnpm is not on PATH. ${hint}`);
  }

  if (!corepackAvailable) {
    if (!(await softProbe(runner, "npm", ["install", "-g", "corepack"]))) {
      throw new Error(`Failed to install corepack via npm. ${hint}`);
    }
  }

  if (!(await softProbe(runner, "corepack", ["enable"]))) {
    throw new Error(`\`corepack enable\` failed. ${hint}`);
  }
}

/**
 * Installs the @friendliai/dsh-llm-friendli bundle into the profile. `dsh plugin add` is a
 * pnpm forwarder that also appends the bundle to dsh.profile.bundles — but
 * ONLY reconciles the bundle list on a zero exit, so every nonzero result is
 * a failure even when the output mentions "Already up to date". pnpm re-adds
 * are already idempotent (exit 0), so no output sniffing is needed.
 */
export async function installDshPlugin(
  run: CommandRunner | undefined,
  profile: string,
  interactive = true,
): Promise<void> {
  const runner = run ?? runCommand;
  await ensurePnpmAvailable(runner, interactive);
  const latest = await (latestTagResolver ?? registryLatest)(
    PLUGIN_BUNDLE,
    NPM_REGISTRY,
  );
  const spec = `${PLUGIN_BUNDLE}@${latest}`;
  const { ok, output } = await runPluginCommand(runner, "dsh", [
    "plugin",
    "--profile",
    profile,
    "add",
    spec,
  ]);
  if (!ok) {
    throw new Error(
      `dsh plugin --profile ${profile} add ${spec} failed: ${output}`,
    );
  }
}

/** Removes the bundle from the profile; a failure is reported by the
 * caller, not thrown. */
export async function removeDshPlugin(
  run: CommandRunner | undefined,
  profile: string,
  interactive = true,
): Promise<{ ok: boolean; output: string }> {
  const runner = run ?? runCommand;
  await ensurePnpmAvailable(runner, interactive);
  return runPluginCommand(runner, "dsh", [
    "plugin",
    "--profile",
    profile,
    "remove",
    PLUGIN_BUNDLE,
  ]);
}
