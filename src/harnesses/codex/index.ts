import { setHarnessEnabled } from "../../config/global-config.js";
import { fetchFriendliModelCatalog } from "../../friendli/model-catalog.js";
import {
  friendliApiBaseUrl,
  normalizeFriendliBaseUrl,
} from "../../friendli/base-url.js";
import { isInstalledByMarker } from "../common/installed.js";
import { resolveVerifiedKey } from "../common/key-preamble.js";
import { pickMainModel } from "../common/model-pick.js";
import type {
  HarnessAdapter,
  HarnessContext,
  OnOutcome,
  ProviderStatus,
} from "../../harness/types.js";
import {
  codexDataDir,
  configPath,
  disableFriendliForCodex,
  enableFriendliForCodex,
  isFriendliManaged,
  readFriendliStatus,
  readProviderState,
} from "./core.js";
import {
  parseEffortRequest,
  reasoningNotice,
  resolveCodexReasoning,
} from "./reasoning.js";

/** Codex talks to Friendli through the OpenAI-compatible endpoint, so the
 * config's base_url (and key verification) use the versioned API root. */
function apiBaseUrl(ctx: HarnessContext): string {
  return friendliApiBaseUrl(
    ctx.baseUrlFromFlag && ctx.baseUrl
      ? normalizeFriendliBaseUrl(ctx.baseUrl)
      : undefined,
  );
}

function paths(ctx: HarnessContext): { configPath: string; dataDir: string } {
  return {
    configPath: configPath(ctx.home, ctx.settingsPath),
    dataDir: codexDataDir(ctx.home, ctx.dataDir),
  };
}

async function on(ctx: HarnessContext): Promise<OnOutcome | void> {
  // Parse the flag before anything else: a typo should not cost the user a key
  // lookup and a walk through the model picker first.
  const requested = parseEffortRequest(ctx.reasoning);

  const resolved = await resolveVerifiedKey(ctx, apiBaseUrl(ctx));
  const pick = await pickMainModel(ctx, {
    apiKey: resolved.key,
    baseUrl: apiBaseUrl(ctx),
  });
  if (pick.cancelled) {
    return { cancelled: true };
  }

  // The catalog does two jobs now: it decides whether "off" is honoured (only
  // where a reasoning toggle is advertised), and it is what teaches Codex's
  // `/model` picker about Friendli's models at all. The picker has usually
  // just fetched it; fetch when it has not (a pinned --model, or
  // non-interactive). Best-effort — an unreachable catalog costs the picker
  // nicety, and `resolveCodexReasoning` refuses "off" on its own if it
  // cannot prove a toggle.
  let catalog = pick.catalog;
  if (catalog.length === 0) {
    catalog = await fetchFriendliModelCatalog(
      resolved.key,
      apiBaseUrl(ctx),
    ).catch(() => []);
  }
  const reasoning = resolveCodexReasoning(
    catalog.find((model) => model.id === pick.model),
    requested,
    pick.model,
  );

  const paths_ = paths(ctx);
  const result = await enableFriendliForCodex({
    configPath: paths_.configPath,
    dataDir: paths_.dataDir,
    apiKey: resolved.key,
    apiKeySource: resolved.source,
    baseUrl: apiBaseUrl(ctx),
    model: pick.model,
    home: ctx.home,
    ...(reasoning.effort ? { reasoningEffort: reasoning.effort } : {}),
    catalog,
    telemetryHeaders: ctx.telemetryHeaders,
  });

  await setHarnessEnabled(ctx.home, "codex", true);

  console.log("frlink: Codex is now routed through FriendliAI.");
  console.log(`  endpoint: ${apiBaseUrl(ctx)}`);
  console.log(`  model: ${pick.model}`);
  const notice = reasoningNotice(reasoning);
  if (notice) {
    console.log(notice);
  }
  if (result.modelsOffered > 0) {
    console.log(
      `  models offered: ${result.modelsOffered} — pick one with /model`,
    );
  }
}

async function off(ctx: HarnessContext): Promise<void> {
  const { outcome, profileRemoved } = await disableFriendliForCodex({
    ...paths(ctx),
    home: ctx.home,
  });
  await setHarnessEnabled(ctx.home, "codex", false);

  if (outcome === "restored") {
    console.log("frlink: Codex config restored to its pre-FriendliAI state.");
    return;
  }
  // No config snapshot to restore, but `on` may still have left the
  // escape-hatch profile behind — say what actually happened rather than
  // claiming nothing was managed.
  console.log(
    profileRemoved
      ? "frlink: the escape-hatch profile was removed; config.toml had no pre-FriendliAI snapshot to restore, so it was left as it is."
      : "frlink: Codex was not managed by frlink; nothing to do.",
  );
}

async function status(ctx: HarnessContext): Promise<void> {
  const paths_ = paths(ctx);
  const configStatus = await readFriendliStatus(paths_.configPath);
  const state = configStatus.managed
    ? await readProviderState(paths_.dataDir)
    : undefined;

  if (ctx.json) {
    console.log(
      JSON.stringify(
        {
          managed: configStatus.managed,
          model: state?.model ?? null,
          apiKeySource: state?.apiKeySource ?? null,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (!configStatus.managed) {
    console.log(
      "codex: not managed by frlink (config.toml does not name the friendliai provider).",
    );
    return;
  }

  console.log("codex: routed through FriendliAI.");
  if (state) {
    console.log(`  api key source: ${state.apiKeySource}`);
    console.log(`  model: ${state.model}`);
  } else {
    // friendli-routed without our state — probably configured by hand.
    console.log(`  model: ${configStatus.model ?? "(none named)"}`);
  }
}

async function resolveKey(ctx: HarnessContext): Promise<string> {
  const resolved = await resolveVerifiedKey(ctx, apiBaseUrl(ctx));
  return resolved.key;
}

async function providerStatus(ctx: HarnessContext): Promise<ProviderStatus> {
  return (await isFriendliManaged(paths(ctx).configPath))
    ? "friendli"
    : "default";
}

async function isInstalled(home: string): Promise<boolean> {
  return isInstalledByMarker("codex", home);
}

export const codexAdapter: HarnessAdapter = {
  id: "codex",
  label: "Codex",
  telemetryHeaders: true,
  on,
  off,
  status,
  resolveKey,
  providerStatus,
  isInstalled,
};
