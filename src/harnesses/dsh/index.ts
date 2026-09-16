import path from "node:path";
import { setHarnessEnabled } from "../../config/global-config.js";
import { friendliApiBaseUrl } from "../../friendli/base-url.js";
import { isInstalledByMarker } from "../common/installed.js";
import { resolveVerifiedKey } from "../common/key-preamble.js";
import { interactiveSession, pickMainModel } from "../common/model-pick.js";
import type {
  HarnessAdapter,
  HarnessContext,
  OnOutcome,
  ProviderStatus,
} from "../../harness/types.js";
import { FRIENDLI_API_KEY_ENV } from "../../keys/api-key.js";
import { revertOwnedEnvKey, writeOwnedEnvKey } from "../../keys/env.js";
import {
  DEFAULT_DSH_PROFILE,
  bundleInstalled,
  disableFriendliForDsh,
  dshDataDir,
  dshHome,
  enableFriendliForDsh,
  isFriendliManaged,
  prepareDshPatch,
  readProviderState,
  validateDshProfile,
} from "./core.js";
import {
  installDshPlugin,
  removeDshPlugin,
  type CommandRunner,
} from "./plugins.js";

/** The runner used by on/off to invoke `dsh plugin …`; overridable in
 * tests so the adapter never needs the real `dsh` binary. */
let pluginRunner: CommandRunner | null = null;

export function setDshPluginRunnerForTests(runner: CommandRunner | null) {
  pluginRunner = runner;
}

function apiBaseUrl(ctx: HarnessContext): string {
  if (ctx.baseUrlFromFlag) {
    throw new Error(
      `--base-url is not supported for dsh: frlink does not configure the bundle's endpoint. ` +
        `Drop the flag to use the default FriendliAI serverless endpoint.`,
    );
  }
  return friendliApiBaseUrl();
}

function paths(ctx: HarnessContext): { dataDir: string } {
  return {
    dataDir: dshDataDir(ctx.home, ctx.dataDir),
  };
}

/**
 * `--settings-path` overrides the profile directory for READS (status,
 * providerStatus) — useful to inspect a profile dir without naming its
 * dsh home. But configuration writes go through the `dsh` CLI, which resolves
 * the profile dir itself, so `on`/`off` with the flag would install into
 * one directory and patch another. Refuse the split instead.
 */
function profileDirOnly(ctx: HarnessContext): string {
  if (ctx.settingsPath) {
    throw new Error(
      `--settings-path is not supported for dsh on/off: dsh plugin installs target its own profile directory, ` +
        `so patching a different directory would leave the profile half-managed. ` +
        `Drop the flag (or point DSH_HOME at the desired dsh home).`,
    );
  }
  return "";
}

/** The profile the user named, or dsh's default. */
function activeProfile(ctx: HarnessContext): string {
  const profile = ctx.profile || DEFAULT_DSH_PROFILE;
  validateDshProfile(profile);
  return profile;
}

async function on(ctx: HarnessContext): Promise<OnOutcome | void> {
  const profile = activeProfile(ctx);
  profileDirOnly(ctx);
  // Login flow unchanged: resolve + verify the key, persist when from a flag.
  const resolved = await resolveVerifiedKey(ctx, apiBaseUrl(ctx));
  const pick = await pickMainModel(ctx, {
    apiKey: resolved.key,
    baseUrl: apiBaseUrl(ctx),
  });
  if (pick.cancelled) {
    return { cancelled: true };
  }

  const paths_ = paths(ctx);
  const preparation = await prepareDshPatch({
    home: ctx.home,
    dataDir: paths_.dataDir,
    profile,
  });
  try {
    await installDshPlugin(
      pluginRunner ?? undefined,
      profile,
      interactiveSession(ctx),
    );

    // The key must honor DSH_HOME: dsh materializes this .env into
    // process.env at boot, where the bundle reads it per request. The
    // shared owned-key write records what the FRIENDLIAI_API_KEY field
    // held before overwriting it, so `off` restores the user's own key.
    await writeOwnedEnvKey({
      dataDir: paths_.dataDir,
      envPath: path.join(dshHome(ctx.home), ".env"),
      key: FRIENDLI_API_KEY_ENV,
      value: resolved.key,
    });
  } catch (error) {
    await preparation.discardUnusedSnapshot();
    throw error;
  }

  await enableFriendliForDsh({
    home: ctx.home,
    dataDir: paths_.dataDir,
    apiKeySource: resolved.source,
    model: pick.model,
    profile,
    profileDirOverride: ctx.settingsPath,
    telemetryHeaders: ctx.telemetryHeaders,
  });

  await setHarnessEnabled(ctx.home, "dsh", true);

  console.log("frlink: DeepSeek Harness is now routed through FriendliAI.");
  console.log(`  model: ${pick.model}`);
  console.log(`  profile: ${profile}`);
}

async function off(ctx: HarnessContext): Promise<void> {
  const profile = activeProfile(ctx);
  profileDirOnly(ctx);
  const paths_ = paths(ctx);
  // Disable first so the patch is restored before the bundle disappears.
  const outcome = await disableFriendliForDsh({
    home: ctx.home,
    dataDir: paths_.dataDir,
    profile,
    profileDirOverride: ctx.settingsPath,
  });
  // Probe the manifest first: removing an absent bundle makes pnpm fail with
  // CANNOT_REMOVE_MISSING_DEPS, which would warn on every repeat `off`.
  const installed = await bundleInstalled({
    home: ctx.home,
    profile,
    profileDirOverride: ctx.settingsPath,
  });
  if (installed) {
    const removal = await removeDshPlugin(
      pluginRunner ?? undefined,
      profile,
      interactiveSession(ctx),
    );
    // Only a zero pnpm exit reconciles the manifest, including missing-deps errors.
    if (!removal.ok) {
      throw new Error(
        `Could not remove the @friendliai/dsh-llm-friendli bundle: ${removal.output}. ` +
          `The patch restore has completed, but bundle cleanup is incomplete. ` +
          `Repair the profile dependencies and retry: dsh plugin --profile ${profile} remove @friendliai/dsh-llm-friendli`,
      );
    }
    if (await bundleInstalled({ home: ctx.home, profile })) {
      throw new Error(
        `dsh reported removal success, but @friendliai/dsh-llm-friendli is still registered in the profile manifest. ` +
          `Repair the profile dependencies and retry \`frlink dsh off\`.`,
      );
    }
  }
  // off unwrote what on wrote — but only what on actually owned: a
  // FRIENDLIAI_API_KEY the user had before `on` comes back byte-for-byte,
  // a field the user has since edited is left alone entirely, and no
  // record (never managed, or a different dsh home) means we touch nothing.
  await revertOwnedEnvKey({
    dataDir: paths_.dataDir,
    envPath: path.join(dshHome(ctx.home), ".env"),
    key: FRIENDLI_API_KEY_ENV,
  });
  await setHarnessEnabled(ctx.home, "dsh", false);
  console.log(
    outcome === "restored"
      ? "frlink: DeepSeek Harness profile restored to its pre-FriendliAI state."
      : installed
        ? "frlink: DeepSeek Harness was not fully managed (no patch restored, bundle installed); the @friendliai/dsh-llm-friendli bundle has been removed."
        : "frlink: DeepSeek Harness was not managed by frlink; nothing to do.",
  );
}

async function status(ctx: HarnessContext): Promise<void> {
  const paths_ = paths(ctx);
  const managed = await isFriendliManaged({
    home: ctx.home,
    profile: activeProfile(ctx),
    profileDirOverride: ctx.settingsPath,
  });
  const state = managed
    ? await readProviderState(paths_.dataDir, ctx.home, activeProfile(ctx))
    : undefined;

  if (ctx.json) {
    console.log(
      JSON.stringify(
        {
          managed,
          model: state?.model ?? null,
          apiKeySource: state?.apiKeySource ?? null,
          profile: state?.profile ?? null,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (!managed) {
    console.log(
      "dsh: not managed by frlink (the @friendliai/dsh-llm-friendli bundle is not installed or the patch row does not name it).",
    );
    return;
  }

  console.log(
    "dsh: routed through FriendliAI (@friendliai/dsh-llm-friendli bundle).",
  );
  if (state) {
    console.log(`  api key source: ${state.apiKeySource}`);
    console.log(`  model: ${state.model}`);
    console.log(`  profile: ${state.profile}`);
  }
}

async function resolveKey(ctx: HarnessContext): Promise<string> {
  const resolved = await resolveVerifiedKey(ctx, apiBaseUrl(ctx));
  return resolved.key;
}

async function providerStatus(ctx: HarnessContext): Promise<ProviderStatus> {
  return (await isFriendliManaged({
    home: ctx.home,
    profile: activeProfile(ctx),
    profileDirOverride: ctx.settingsPath,
  }))
    ? "friendli"
    : "default";
}

/** dsh is present when its home directory is — the same dir `dshHome`
 * resolves (DSH_HOME override honored, defaulting to `~/.dsh`). */
async function isInstalled(home: string): Promise<boolean> {
  return isInstalledByMarker("dsh", home);
}

export const dshAdapter: HarnessAdapter = {
  id: "dsh",
  label: "DeepSeek Harness",
  telemetryHeaders: true,
  on,
  off,
  status,
  resolveKey,
  providerStatus,
  isInstalled,
};
