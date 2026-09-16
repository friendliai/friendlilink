import { setHarnessEnabled } from "../../config/global-config.js";
import {
  fetchFriendliModelCatalog,
  type FriendliModel,
} from "../../friendli/model-catalog.js";
import { isInstalledByMarker } from "../common/installed.js";
import { resolveVerifiedKey } from "../common/key-preamble.js";
import { interactiveSession } from "../common/model-pick.js";
import type {
  HarnessAdapter,
  HarnessContext,
  OnOutcome,
  ProviderStatus,
} from "../../harness/types.js";
import {
  claudeDataDir,
  disableFriendliProvider,
  enableFriendliProvider,
  friendliBaseUrl,
  isFriendliManaged,
  readProviderState,
  userSettingsPath,
  type ClaudeModelMapping,
} from "./core.js";
import { runClaudeModelOnboarding } from "./onboarding.js";
import { runClaudeVersionGuard } from "./version-guard.js";

function paths(ctx: HarnessContext): {
  settingsPath: string;
  dataDir: string;
} {
  return {
    settingsPath: userSettingsPath(ctx.home, ctx.settingsPath),
    dataDir: claudeDataDir(ctx.home, ctx.dataDir),
  };
}

function pinnedMapping(ctx: HarnessContext): ClaudeModelMapping {
  const mapping: ClaudeModelMapping = {};
  if (ctx.opus) mapping.opus = ctx.opus;
  if (ctx.sonnet) mapping.sonnet = ctx.sonnet;
  if (ctx.haiku) mapping.haiku = ctx.haiku;
  if (ctx.fable) mapping.fable = ctx.fable;
  if (ctx.subagent) mapping.subagent = ctx.subagent;
  return mapping;
}

async function on(ctx: HarnessContext): Promise<OnOutcome | void> {
  const baseUrl = friendliBaseUrl(ctx);

  // First, and before any write: when a Claude Code release is known to break
  // against Friendli's Model API, there's no point collecting keys or picking
  // models only to fail. No incompatibility is active today, so this returns
  // "skipped" without touching the machine (see version-guard.ts).
  const guard = await runClaudeVersionGuard({
    interactive: interactiveSession(ctx),
  });
  if (guard.outcome === "cancelled") {
    console.log(
      "frlink: Cancelled — the Claude Code downgrade was declined, so nothing was changed.",
    );
    return { cancelled: true };
  }
  // Only a live version pin justifies freezing Claude Code's auto-updater or
  // recording a version in our state.
  const versionPinned = guard.outcome !== "skipped";

  const resolved = await resolveVerifiedKey(ctx, baseUrl);

  const pinned = pinnedMapping(ctx);
  const hasPinned = Object.keys(pinned).length > 0;
  const wantsInteractive = interactiveSession(ctx) && !hasPinned && !ctx.main;

  let mapping: ClaudeModelMapping = pinned;
  let catalog: FriendliModel[] = [];
  if (ctx.onboardingMode !== "skip" && wantsInteractive) {
    catalog = await fetchFriendliModelCatalog(resolved.key, baseUrl);
    const picked = await runClaudeModelOnboarding(catalog);
    if (picked === null) {
      return { cancelled: true };
    }
    mapping = { ...picked, ...pinned };
  } else if (hasPinned || ctx.main) {
    // Flag-pinned models (--opus, --sonnet, ...) and an explicit --model skip
    // the wizard, but still need catalog metadata (context length, capabilities)
    // so Claude Code's own model validation doesn't reject them and sizes their
    // context window correctly. Best-effort: fall back to unenriched model ids
    // if Friendli's catalog can't be reached.
    catalog = await fetchFriendliModelCatalog(resolved.key, baseUrl).catch(
      () => [],
    );
  }

  const result = await enableFriendliProvider({
    ...paths(ctx),
    apiKey: resolved.key,
    apiKeySource: resolved.source,
    baseUrl,
    mainModel: ctx.main,
    mapping,
    catalog,
    pinAutoUpdate: versionPinned,
    ...(versionPinned
      ? {
          versionGuard: {
            version: guard.version,
            downgraded: guard.downgraded,
          },
        }
      : {}),
    telemetryHeaders: ctx.telemetryHeaders,
  });

  await setHarnessEnabled(ctx.home, "claude", true);

  console.log("frlink: Claude Code is now routed through FriendliAI.");
  console.log(`  endpoint: ${baseUrl}`);
  if (result.model) {
    console.log(`  model: ${result.model}`);
  }
  for (const [slot, value] of Object.entries(result.mapping)) {
    console.log(`  ${slot}: ${value}`);
  }
}

async function off(ctx: HarnessContext): Promise<void> {
  const outcome = await disableFriendliProvider(paths(ctx));
  await setHarnessEnabled(ctx.home, "claude", false);

  console.log(
    outcome === "restored"
      ? "frlink: Claude Code settings restored to their pre-FriendliAI state."
      : "frlink: No Claude Code backup found; settings were not changed.",
  );
}

async function status(ctx: HarnessContext): Promise<void> {
  const { settingsPath, dataDir } = paths(ctx);
  const managed = await isFriendliManaged(settingsPath);
  const state = managed ? await readProviderState(dataDir) : undefined;

  if (ctx.json) {
    console.log(
      JSON.stringify(
        {
          managed,
          mapping: state?.mapping ?? {},
          apiKeySource: state?.apiKeySource ?? null,
          claudeCode: state?.versionGuard ?? null,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (!managed) {
    console.log(
      "claude: not managed by frlink (using its own default provider).",
    );
    return;
  }

  console.log("claude: routed through FriendliAI.");
  if (state) {
    console.log(`  api key source: ${state.apiKeySource}`);
    if (state.versionGuard) {
      const code = state.versionGuard.version
        ? `v${state.versionGuard.version}${state.versionGuard.downgraded ? " (downgraded by frlink)" : ""}`
        : "unknown";
      console.log(`  claude code: ${code}`);
    }
    for (const [slot, value] of Object.entries(state.mapping)) {
      console.log(`  ${slot}: ${value}`);
    }
  }
}

async function resolveKey(ctx: HarnessContext): Promise<string> {
  const resolved = await resolveVerifiedKey(ctx, friendliBaseUrl(ctx));
  return resolved.key;
}

async function providerStatus(ctx: HarnessContext): Promise<ProviderStatus> {
  const { settingsPath } = paths(ctx);
  return (await isFriendliManaged(settingsPath)) ? "friendli" : "default";
}

async function isInstalled(home: string): Promise<boolean> {
  return isInstalledByMarker("claude", home);
}

export const claudeAdapter: HarnessAdapter = {
  id: "claude",
  label: "Claude Code",
  telemetryHeaders: true,
  on,
  off,
  status,
  resolveKey,
  providerStatus,
  isInstalled,
};
