import { setHarnessEnabled } from "../../config/global-config.js";
import {
  FRIENDLI_BASE_URL,
  normalizeFriendliBaseUrl,
} from "../../friendli/base-url.js";
import {
  fetchFriendliModelCatalog,
  type FriendliModel,
} from "../../friendli/model-catalog.js";
import { resolveVerifiedKey } from "../common/key-preamble.js";
import { pickMainModel } from "../common/model-pick.js";
import { isInstalledByMarker } from "../common/installed.js";
import type {
  HarnessAdapter,
  HarnessContext,
  OnOutcome,
  ProviderStatus,
} from "../../harness/types.js";
import {
  authPath,
  configPath,
  disableFriendliForOpenCode,
  enableFriendliForOpenCode,
  isFriendliManaged,
  opencodeDataDir,
  readProviderState,
} from "./core.js";

/** Used for API-key verification and the model list fetch: opencode still
 * resolves the friendli provider's request endpoint itself (via models.dev),
 * so frlink only ever writes the auth entry, the default model, and
 * `provider.friendli.models` (Friendli's live model list) to opencode's config. */
function verificationBaseUrl(ctx: HarnessContext): string {
  return ctx.baseUrlFromFlag && ctx.baseUrl
    ? normalizeFriendliBaseUrl(ctx.baseUrl)
    : FRIENDLI_BASE_URL;
}

function paths(ctx: HarnessContext): {
  configPath: string;
  authPath: string;
  dataDir: string;
} {
  return {
    configPath: configPath(ctx.home, ctx.settingsPath),
    authPath: authPath(ctx.home),
    dataDir: opencodeDataDir(ctx.home, ctx.dataDir),
  };
}

async function on(ctx: HarnessContext): Promise<OnOutcome | void> {
  const resolved = await resolveVerifiedKey(ctx, verificationBaseUrl(ctx));
  const pick = await pickMainModel(ctx, {
    apiKey: resolved.key,
    baseUrl: verificationBaseUrl(ctx),
  });
  if (pick.cancelled) {
    return { cancelled: true };
  }

  // opencode's own model list for Friendli comes from its bundled models.dev
  // snapshot, which lags behind Friendli's serverless catalog — sync it into
  // `provider.friendli.models` ourselves instead of relying on that snapshot.
  let catalog: FriendliModel[] = [];
  try {
    catalog = await fetchFriendliModelCatalog(
      resolved.key,
      verificationBaseUrl(ctx),
    );
  } catch {
    // Offline/5xx — leave opencode's existing Friendli model list untouched.
  }

  const paths_ = paths(ctx);
  await enableFriendliForOpenCode({
    configPath: paths_.configPath,
    authPath: paths_.authPath,
    dataDir: paths_.dataDir,
    apiKey: resolved.key,
    apiKeySource: resolved.source,
    model: pick.model,
    telemetryHeaders: ctx.telemetryHeaders,
    models: catalog,
  });

  await setHarnessEnabled(ctx.home, "opencode", true);

  console.log("frlink: OpenCode is now routed through FriendliAI.");
  console.log(`  model: ${pick.model}`);
}

async function off(ctx: HarnessContext): Promise<void> {
  const outcome = await disableFriendliForOpenCode(paths(ctx));
  await setHarnessEnabled(ctx.home, "opencode", false);

  console.log(
    outcome === "restored"
      ? "frlink: OpenCode config and auth restored to their pre-FriendliAI state."
      : "frlink: OpenCode was not managed by frlink; nothing to do.",
  );
}

async function status(ctx: HarnessContext): Promise<void> {
  const paths_ = paths(ctx);
  const managed = await isFriendliManaged(paths_.configPath);
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
      "opencode: not managed by frlink (friendli is not the default provider).",
    );
    return;
  }

  console.log("opencode: routed through FriendliAI.");
  if (state) {
    console.log(`  api key source: ${state.apiKeySource}`);
    console.log(`  model: ${state.model}`);
  }
}

async function resolveKey(ctx: HarnessContext): Promise<string> {
  const resolved = await resolveVerifiedKey(ctx, verificationBaseUrl(ctx));
  return resolved.key;
}

async function providerStatus(ctx: HarnessContext): Promise<ProviderStatus> {
  return (await isFriendliManaged(paths(ctx).configPath))
    ? "friendli"
    : "default";
}

async function isInstalled(home: string): Promise<boolean> {
  return isInstalledByMarker("opencode", home);
}

export const opencodeAdapter: HarnessAdapter = {
  id: "opencode",
  label: "OpenCode",
  telemetryHeaders: true,
  on,
  off,
  status,
  resolveKey,
  providerStatus,
  isInstalled,
};
