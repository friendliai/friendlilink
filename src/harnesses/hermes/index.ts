import { setHarnessEnabled } from "../../config/global-config.js";
import {
  friendliApiBaseUrl,
  normalizeFriendliBaseUrl,
} from "../../friendli/base-url.js";
import { isInstalledByMarker } from "../common/installed.js";
import { resolveVerifiedKey } from "../common/key-preamble.js";
import { pickMainModel } from "../common/model-pick.js";
import { FRIENDLI_API_KEY_ENV } from "../../keys/api-key.js";
import { revertOwnedEnvKey, writeOwnedEnvKey } from "../../keys/env.js";
import { getDotenvPath } from "../../keys/env-path.js";
import {
  backupPathFor,
  removeQuietly,
  snapshotFileIfNeeded,
  type ConfigBackup,
} from "../common/backup.js";
import { readJsonIfExists, readRawIfExists } from "../../io/json.js";
import type {
  HarnessAdapter,
  HarnessContext,
  OnOutcome,
  ProviderStatus,
} from "../../harness/types.js";
import {
  configPath,
  disableFriendliForHermes,
  enableFriendliForHermes,
  hermesDataDir,
  isFriendliManaged,
  readProviderState,
} from "./core.js";
import {
  installFriendliPlugin,
  PLUGIN_NAME,
  pluginAlreadyInstalled,
  removeFriendliPlugin,
  type CommandRunner,
} from "./plugins.js";

/** The runner used by on/off to invoke `hermes plugins …`; overridable in
 * tests so the adapter never needs the real `hermes` binary. */
let pluginRunner: CommandRunner | null = null;

export function setHermesPluginRunnerForTests(runner: CommandRunner | null) {
  pluginRunner = runner;
}

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
    dataDir: hermesDataDir(ctx.home, ctx.dataDir),
  };
}

async function on(ctx: HarnessContext): Promise<OnOutcome | void> {
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

  // Snapshot BEFORE the plugin install and dotenv write can fail halfway
  // (dsh's prepare order): a failed attempt must be able to discard the
  // backup it created, while a pre-existing backup — recovery state from
  // an earlier `on` — is never ours to delete. Use the same slot and
  // managed check enableFriendliForHermes does, so its own snapshot no-ops
  // and it stays the single config-write path.
  const backupPath = backupPathFor(paths_.dataDir, "config");
  const { existed: hadBackup } =
    await readJsonIfExists<ConfigBackup>(backupPath);
  await snapshotFileIfNeeded({
    configPath: paths_.configPath,
    backupPath,
    isManaged: () => isFriendliManaged(paths_.configPath),
  });
  // Receipt valid only for a backup CREATED by this attempt; discarding an
  // earlier backup on a failed re-`on` would destroy a prior `on`'s recovery.
  const createdBackup = hadBackup
    ? undefined
    : (await readJsonIfExists<ConfigBackup>(backupPath)).value;
  const discardUnusedSnapshot = async (): Promise<void> => {
    if (!createdBackup) {
      return;
    }
    // Discard only when the live file still matches the receipt exactly —
    // existence AND raw bytes, never parsed YAML: anything else touched
    // the file and it may still need this backup.
    const current = await readRawIfExists(paths_.configPath);
    if (
      current.existed === createdBackup.snapshot.existed &&
      current.raw === createdBackup.snapshot.raw
    ) {
      await removeQuietly(backupPath);
    }
  };

  // Probe BEFORE installing: a user who already installed the plugin must
  // keep it across a later `off` (the uninstall is ours only when the
  // install was).
  const installedByUs = !pluginAlreadyInstalled(ctx.home);
  let installSucceeded = false;
  try {
    await installFriendliPlugin(pluginRunner ?? undefined);
    installSucceeded = true;

    // The plugin reads FRIENDLIAI_API_KEY from Hermes' dotenv (~/.hermes/.env);
    // written here — not in `login` — so non-hermes users never get ~/.hermes.
    // The shared owned-key write records what the field held before
    // overwriting it (fatal when it cannot — an unrecorded overwrite would
    // make the user's key unrecoverable on `off`), then writes atomically.
    // Fatal when it fails (dsh policy): a reported-successful `on` whose
    // plugin cannot authenticate breaks the route contract — the write is
    // atomic, so the file is either untouched or whole, never half-written.
    await writeOwnedEnvKey({
      dataDir: paths_.dataDir,
      envPath: getDotenvPath(ctx.home),
      key: FRIENDLI_API_KEY_ENV,
      value: resolved.key,
    });
  } catch (error) {
    // Cleanup boundary ENDS HERE, before enableFriendliForHermes writes
    // anything: pre-enable setup failed with no config or state written,
    // so only the snapshot this attempt created is take-backable — and a
    // plugin THIS attempt successfully installed must not outlive the
    // attempt as a phantom "user-owned" install on the next `on` (nothing
    // would record that we installed it). Best-effort removal (only hermes
    // can reconcile its plugins directory; a removal failure here must not
    // mask the original error). A failed install removes nothing.
    if (installedByUs && installSucceeded) {
      await removeFriendliPlugin(pluginRunner ?? undefined).catch(() => {});
    }
    await discardUnusedSnapshot();
    throw error;
  }

  await enableFriendliForHermes({
    configPath: paths_.configPath,
    dataDir: paths_.dataDir,
    apiKeySource: resolved.source,
    model: pick.model,
    installedByUs,
    telemetryHeaders: ctx.telemetryHeaders,
  });

  await setHarnessEnabled(ctx.home, "hermes", true);

  console.log("frlink: Hermes Agent is now routed through FriendliAI.");
  console.log(`  model: ${pick.model}`);
}

async function off(ctx: HarnessContext): Promise<void> {
  // Remove the plugin FIRST (when ours), then let disableFriendliForHermes
  // consume the backup/state. The old order (restore, then remove) made
  // the failure path unretryable: `off` had already eaten the recovery
  // state, so a retry hit the `none` path and never attempted the removal
  // again — while telling the user to retry. Removal-first means a failed
  // removal leaves every recovery artifact in place and a retry does the
  // full job.
  //
  // Ownership gate: only the durable state decides whether the uninstall
  // is ours — a peek, not a consume; the state is removed later by
  // disableFriendliForHermes. Never remove a plugin the user installed
  // themselves just because its directory is present.
  const paths_ = paths(ctx);
  const state = await readProviderState(paths_.dataDir, paths_.configPath);
  const pluginIsOurs = state ? (state.installedByUs ?? false) : false;
  let pluginRemovedByUs = false;
  if (state && pluginIsOurs && pluginAlreadyInstalled(ctx.home)) {
    const removal = await removeFriendliPlugin(pluginRunner ?? undefined);
    // A failed removal must surface loudly — but the state is still
    // intact, so the user can genuinely retry this command.
    if (!removal.ok) {
      throw new Error(
        `Could not remove the friendliai-provider plugin: ${removal.output}. ` +
          `Nothing has been reverted yet — repair the hermes plugin state and retry: frlink hermes off ` +
          `(or: hermes plugins remove ${PLUGIN_NAME})`,
      );
    }
    // A zero exit is not proof: re-probe the install directory and fail
    // when hermes reported success without removing it.
    if (pluginAlreadyInstalled(ctx.home)) {
      throw new Error(
        `hermes reported removing the ${PLUGIN_NAME} plugin, but its directory still exists. ` +
          `Nothing has been reverted yet — repair the hermes plugin state and retry: frlink hermes off ` +
          `(or: hermes plugins remove ${PLUGIN_NAME})`,
      );
    }
    pluginRemovedByUs = true;
  }

  const { outcome, uninstallPlugin, strippedWithoutBackup } =
    await disableFriendliForHermes(paths(ctx));
  if (outcome === "none") {
    console.log(
      pluginRemovedByUs
        ? "frlink: the friendliai-provider plugin was removed; nothing else was managed by frlink."
        : "frlink: Hermes Agent was not managed by frlink; nothing to do.",
    );
    await setHarnessEnabled(ctx.home, "hermes", false);
    return;
  }
  if (!pluginRemovedByUs && !uninstallPlugin) {
    console.log(
      "frlink: the friendliai-provider plugin was already installed before `on`; left in place.",
    );
  }
  // off unwrote what on wrote — but only what on actually owned: a
  // FRIENDLIAI_API_KEY the user had before `on` comes back byte-for-byte,
  // a field the user has since edited is left alone entirely, and no
  // record (never managed, or a different hermes home) means we touch nothing.
  await revertOwnedEnvKey({
    dataDir: paths_.dataDir,
    envPath: getDotenvPath(ctx.home),
    key: FRIENDLI_API_KEY_ENV,
  });
  await setHarnessEnabled(ctx.home, "hermes", false);

  // A strip did not revert anything to a pre-`on` state — there is no
  // snapshot to revert to — so claiming a "pre-Friendli state" would be
  // dishonest; what happened is: the fields the durable state proves are
  // ours were removed, everything else was left as the user shaped it.
  console.log(
    strippedWithoutBackup
      ? "frlink: Hermes Agent config stripped of frlink-owned fields (no backup was found; changes you made since `on` were kept)."
      : "frlink: Hermes Agent config restored to its pre-FriendliAI state (changes you made since `on` were kept).",
  );
}

async function status(ctx: HarnessContext): Promise<void> {
  const paths_ = paths(ctx);
  const managed = await isFriendliManaged(paths_.configPath);
  const state = managed
    ? await readProviderState(paths_.dataDir, paths_.configPath)
    : undefined;

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
      "hermes: not managed by frlink (the friendliai-provider plugin is not enabled or the model block does not name it).",
    );
    return;
  }

  console.log(
    "hermes: routed through FriendliAI (friendliai-provider plugin).",
  );
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
  return (await isFriendliManaged(paths(ctx).configPath))
    ? "friendli"
    : "default";
}

async function isInstalled(home: string): Promise<boolean> {
  return isInstalledByMarker("hermes", home);
}

export const hermesAdapter: HarnessAdapter = {
  id: "hermes",
  label: "Hermes Agent",
  telemetryHeaders: true,
  on,
  off,
  status,
  resolveKey,
  providerStatus,
  isInstalled,
};
