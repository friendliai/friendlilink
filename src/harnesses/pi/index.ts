import { setHarnessEnabled } from "../../config/global-config.js";
import {
  friendliApiBaseUrl,
  normalizeFriendliBaseUrl,
} from "../../friendli/base-url.js";
import {
  fetchFriendliModelCatalog,
  type FriendliModel,
} from "../../friendli/model-catalog.js";
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
  disableFriendliForPi,
  enableFriendliForPi,
  isFriendliManaged,
  piDataDir,
  piModelsPath,
  piSettingsPath,
  readProviderState,
} from "./core.js";

/** Pi talks to Friendli through the OpenAI-compatible endpoint, so the
 * provider definition (and key verification) use the versioned API root. */
function apiBaseUrl(ctx: HarnessContext): string {
  return friendliApiBaseUrl(
    ctx.baseUrlFromFlag && ctx.baseUrl
      ? normalizeFriendliBaseUrl(ctx.baseUrl)
      : undefined,
  );
}

function paths(ctx: HarnessContext): {
  settingsPath: string;
  modelsPath: string;
  dataDir: string;
} {
  return {
    settingsPath: piSettingsPath(ctx.home, ctx.settingsPath),
    modelsPath: piModelsPath(ctx.home, ctx.settingsPath),
    dataDir: piDataDir(ctx.home, ctx.dataDir),
  };
}

async function on(ctx: HarnessContext): Promise<OnOutcome | void> {
  const resolved = await resolveVerifiedKey(ctx, apiBaseUrl(ctx));
  const pick = await pickMainModel(ctx, {
    apiKey: resolved.key,
    baseUrl: apiBaseUrl(ctx),
  });
  if (pick.cancelled) {
    return { cancelled: true };
  }

  // The catalog isn't just a picker list: its reasoning_options are what
  // tell buildPiCatalog which models need the enable_thinking switch to
  // avoid a 422 or a stuck-on default. Swallowing a fetch failure here
  // would silently register the picked model plain — Pi then drops
  // /thinking off for it instead of emitting the switch — while `on` still
  // reports success. Let it fail instead; a transient failure should be
  // retried, not written over.
  const catalog: FriendliModel[] = await fetchFriendliModelCatalog(
    resolved.key,
    apiBaseUrl(ctx),
  );

  const paths_ = paths(ctx);
  const result = await enableFriendliForPi({
    settingsPath: paths_.settingsPath,
    modelsPath: paths_.modelsPath,
    dataDir: paths_.dataDir,
    apiKey: resolved.key,
    apiKeySource: resolved.source,
    baseUrl: apiBaseUrl(ctx),
    model: pick.model,
    catalog,
    telemetryHeaders: ctx.telemetryHeaders,
  });

  await setHarnessEnabled(ctx.home, "pi", true);

  console.log("frlink: Pi is now routed through FriendliAI.");
  console.log(`  model: ${pick.model}`);
  console.log(`  models offered: ${result.models.length}`);
}

async function off(ctx: HarnessContext): Promise<void> {
  const outcome = await disableFriendliForPi(paths(ctx));
  await setHarnessEnabled(ctx.home, "pi", false);

  console.log(
    outcome === "restored"
      ? "frlink: Pi settings and models restored to their pre-FriendliAI state."
      : "frlink: Pi was not managed by frlink; nothing to do.",
  );
}

async function status(ctx: HarnessContext): Promise<void> {
  const paths_ = paths(ctx);
  const managed = await isFriendliManaged(paths_.settingsPath);
  const state = managed ? await readProviderState(paths_.dataDir) : undefined;

  if (ctx.json) {
    console.log(
      JSON.stringify(
        {
          managed,
          model: state?.model ?? null,
          apiKeySource: state?.apiKeySource ?? null,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (!managed) {
    console.log(
      "pi: not managed by frlink (its default provider is not FriendliAI).",
    );
    return;
  }

  console.log("pi: routed through FriendliAI.");
  if (state) {
    console.log(`  api key source: ${state.apiKeySource}`);
    console.log(`  model: ${state.model}`);
  }
}

async function resolveKey(ctx: HarnessContext): Promise<string> {
  const resolved = await resolveVerifiedKey(ctx, apiBaseUrl(ctx));
  return resolved.key;
}

async function providerStatus(ctx: HarnessContext): Promise<ProviderStatus> {
  return (await isFriendliManaged(paths(ctx).settingsPath))
    ? "friendli"
    : "default";
}

async function isInstalled(home: string): Promise<boolean> {
  return isInstalledByMarker("pi", home);
}

export const piAdapter: HarnessAdapter = {
  id: "pi",
  label: "Pi",
  telemetryHeaders: true,
  on,
  off,
  status,
  resolveKey,
  providerStatus,
  isInstalled,
};
