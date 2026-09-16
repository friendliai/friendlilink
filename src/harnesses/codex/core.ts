import path from "node:path";
import { readJsonIfExists, readRawIfExists, writeJson } from "../../io/json.js";
import { writeFileAtomic } from "../../io/atomic-write.js";
import {
  backupPathFor,
  removeQuietly,
  restoreFileFromBackup,
  snapshotFileIfNeeded,
} from "../common/backup.js";
import type { DisableOutcome } from "../common/plugin-runner.js";
import { patchFriendliRoutingRaw, rootString } from "./toml-patch.js";
import {
  codexDefaults,
  isOurProfile,
  profileNameFor,
  profilePath,
  renderRestoreProfile,
  restoreProfileFromSnapshot,
} from "./profile.js";
import {
  buildCodexCatalog,
  readCodexCatalogTemplate,
} from "./model-catalog.js";
import type { FriendliModel } from "../../friendli/model-catalog.js";
import { harnessDataDir } from "../../config/paths.js";

export const PROVIDER_ID = "friendliai";
export const PROVIDER_NAME = "FriendliAI";
export const CONFIG_RELATIVE_PATH = ".codex/config.toml";

interface ProviderState {
  apiKeySource: "flag" | "env" | "keychain";
  model: string;
  /** Name of the escape-hatch profile `on` wrote, so `off` and `status` don't
   * have to re-derive it. */
  restoreProfileName?: string;
}

export function configPath(home: string, override = ""): string {
  return override || path.join(home, CONFIG_RELATIVE_PATH);
}

export function codexDataDir(home: string, override = ""): string {
  return harnessDataDir(home, "codex", override);
}

function statePath(dataDir: string): string {
  return path.join(dataDir, "provider-state.json");
}

async function readRaw(configPath: string): Promise<string> {
  const { existed, raw } = await readRawIfExists(configPath);
  return existed ? raw : "";
}

/** True when config.toml routes Codex through the Friendli provider. */
export async function isFriendliManaged(configPath: string): Promise<boolean> {
  const raw = await readRaw(configPath);
  return rootString(raw, "model_provider") === PROVIDER_ID;
}

/**
 * Write the "get me back to my own provider" profile, derived from the
 * pre-`on` snapshot. Returns the profile name.
 *
 * A pre-existing file at the same path that is NOT ours is snapshotted first,
 * so `off` hands the user's own profile back instead of deleting it.
 */
async function writeRestoreProfile(options: {
  configPath: string;
  dataDir: string;
  home: string;
}): Promise<string> {
  const { value: backup } = await readJsonIfExists<{
    snapshot?: { existed: boolean; raw: string };
  }>(backupPathFor(options.dataDir, "config"));
  // The snapshot is the pre-Friendli truth; the live file already says
  // friendliai on a re-`on`, which would make the escape hatch a no-op.
  const priorRaw = backup?.snapshot?.existed ? backup.snapshot.raw : "";
  // A profile layers over config.toml and cannot unset a key, so when the user
  // named no model the hatch has to pin Codex's own default — otherwise it
  // inherits the Friendli model `on` writes at root.
  const priorModel = rootString(priorRaw, "model");
  const needsFallback =
    !priorModel || !rootString(priorRaw, "model_reasoning_effort");
  const restore = restoreProfileFromSnapshot(
    priorRaw,
    // Ask about the model the hatch will actually pin, so the effort we copy
    // is that model's default and not some other model's.
    needsFallback ? await codexDefaults(priorModel ?? undefined) : undefined,
  );
  const name = profileNameFor(restore);
  const target = profilePath(options.home, name, options.configPath);

  await snapshotFileIfNeeded({
    configPath: target,
    backupPath: backupPathFor(options.dataDir, `profile-${name}`),
    isManaged: async () => isOurProfile((await readRawIfExists(target)).raw),
  });

  await writeFileAtomic(target, renderRestoreProfile(restore, name), {
    mode: 0o644,
  });
  return name;
}

/** The single write path for `codex on`: snapshot, patch the raw TOML
 * surgically (user tables untouched), write atomically at owner-only
 * permissions (the file now carries the API key). */
export async function enableFriendliForCodex(options: {
  configPath: string;
  dataDir: string;
  apiKey: string;
  apiKeySource: "flag" | "env" | "keychain";
  /** Friendli's OpenAI-compatible base (`.../serverless/v1`). */
  baseUrl: string;
  model: string;
  /** Home used to place the escape-hatch profile beside config.toml. */
  home: string;
  /** Resolved `model_reasoning_effort`; omitted when absent. */
  reasoningEffort?: string;
  /** Friendli's live catalog, used to teach Codex's `/model` picker about
   * these models. Empty leaves Codex on its own bundled catalog. */
  catalog?: FriendliModel[];
  /** Static request headers Codex writes on Friendli's provider table. */
  telemetryHeaders?: Readonly<Record<string, string>>;
}): Promise<{
  model: string;
  restoreProfileName: string;
  modelsOffered: number;
}> {
  const {
    configPath,
    dataDir,
    apiKey,
    apiKeySource,
    baseUrl,
    model,
    home,
    reasoningEffort,
    telemetryHeaders,
  } = options;

  await snapshotFileIfNeeded({
    configPath,
    backupPath: backupPathFor(dataDir, "config"),
    // "Already managed" has to mean "managed by US", and a config naming the
    // friendliai provider does not prove that — a user can (and does) write
    // one by hand. Our durable state is what proves a previous `on`; without
    // it their config is theirs, and it must be snapshotted like any other.
    // Skipping it left `off` with nothing to restore, so it reported "not
    // managed; nothing to do" over a config still routed at Friendli, with
    // the key we wrote sitting in it.
    isManaged: async () =>
      (await readProviderState(dataDir)) !== undefined &&
      (await isFriendliManaged(configPath)),
  });

  const restoreProfileName = await writeRestoreProfile({
    configPath,
    dataDir,
    home,
  });
  const modelCatalogPath = await writeModelCatalog(
    dataDir,
    options.catalog ?? [],
  );

  const raw = await readRaw(configPath);
  const patched = patchFriendliRoutingRaw(raw, {
    providerId: PROVIDER_ID,
    providerName: PROVIDER_NAME,
    baseUrl,
    modelId: model,
    apiKey,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(modelCatalogPath ? { modelCatalogPath } : {}),
    telemetryHeaders: telemetryHeaders ?? {},
  });
  await writeFileAtomic(configPath, patched, { mode: 0o600 });

  await writeJson(
    statePath(dataDir),
    { apiKeySource, model, restoreProfileName } satisfies ProviderState,
    {
      mode: 0o600,
    },
  );

  return {
    model,
    restoreProfileName,
    modelsOffered: modelCatalogPath ? (options.catalog?.length ?? 0) : 0,
  };
}

/** Where the generated Codex catalog lives — in our own data dir, so `off`
 * takes it away cleanly and the user's CODEX_HOME stays theirs. */
function modelCatalogPathFor(dataDir: string): string {
  return path.join(dataDir, "codex-models.json");
}

/**
 * Write the catalog that teaches Codex's picker about Friendli's models, and
 * return its path — or undefined when we cannot build one, in which case no
 * `model_catalog_json` key is written and Codex keeps its own catalog.
 *
 * Best-effort by design: an unreachable Friendli catalog or a Codex we cannot
 * read a template out of is a reason to skip the nicety, never to fail `on`.
 */
async function writeModelCatalog(
  dataDir: string,
  catalog: FriendliModel[],
): Promise<string | undefined> {
  const target = modelCatalogPathFor(dataDir);
  if (catalog.length === 0) {
    // A stale catalog from an earlier `on` would advertise models this one
    // could not confirm; drop it rather than point at it.
    await removeQuietly(target);
    return undefined;
  }
  const template = await readCodexCatalogTemplate();
  if (!template) {
    await removeQuietly(target);
    return undefined;
  }
  await writeJson(target, buildCodexCatalog(catalog, template));
  return path.resolve(target);
}

/** What `off` actually undid. The config and the escape-hatch profile are
 * tracked separately because they can be reverted independently: `on` skips
 * snapshotting a config that already named the friendliai provider, yet still
 * writes a profile. */
export interface CodexDisableResult {
  outcome: DisableOutcome;
  /** True when the escape-hatch profile was taken back (deleted, or a user
   * file we had displaced was restored). */
  profileRemoved: boolean;
}

/** Restores config.toml to its pre-FriendliLink bytes (or deletes it if
 * it didn't exist). */
export async function disableFriendliForCodex(options: {
  configPath: string;
  dataDir: string;
  home: string;
}): Promise<CodexDisableResult> {
  // Read before the state file goes, so we know which profile we created.
  const state = await readProviderState(options.dataDir);

  const outcome = await restoreFileFromBackup({
    configPath: options.configPath,
    backupPath: backupPathFor(options.dataDir, "config"),
  });
  // The profile and the state file are ours whenever `on` recorded them, and
  // that is independent of whether config.toml had a snapshot to restore: `on`
  // skips snapshotting a config that already named the friendliai provider
  // (a hand-written one is indistinguishable from ours), and returning early
  // there would strand the profile and its bookkeeping for good.
  const profileRemoved = await removeRestoreProfile(
    options,
    state?.restoreProfileName,
  );
  // The generated catalog is ours outright — the restored config no longer
  // points at it, so leaving it behind would only litter.
  await removeQuietly(modelCatalogPathFor(options.dataDir));
  await removeQuietly(statePath(options.dataDir));
  return { outcome, profileRemoved };
}

/**
 * Take back the escape-hatch profile: restore a user file we displaced, else
 * delete ours. A file that no longer carries our sentinel was edited by hand,
 * so it is left alone — deleting someone's edited config is worse than leaving
 * a stale profile they can remove themselves.
 */
async function removeRestoreProfile(
  options: { configPath: string; dataDir: string; home: string },
  name: string | undefined,
): Promise<boolean> {
  if (!name) {
    return false;
  }
  const target = profilePath(options.home, name, options.configPath);
  const { existed, raw } = await readRawIfExists(target);
  if (existed && !isOurProfile(raw)) {
    // The user has made this file their own. Leave it, but drop our snapshot of
    // it too — otherwise the next `on` sees a backup, skips snapshotting, and a
    // later `off` would restore that stale copy over their edit.
    await removeQuietly(backupPathFor(options.dataDir, `profile-${name}`));
    return false;
  }
  const restored = await restoreFileFromBackup({
    configPath: target,
    backupPath: backupPathFor(options.dataDir, `profile-${name}`),
  });
  if (restored === "none") {
    await removeQuietly(target);
  }
  return existed;
}

export interface CodexStatus {
  managed: boolean;
  model: string | null;
}

/** Which provider/model config.toml names at the root — no TOML parse needed. */
export async function readFriendliStatus(
  configPath: string,
): Promise<CodexStatus> {
  const raw = await readRaw(configPath);
  const provider = rootString(raw, "model_provider");
  return {
    managed: provider === PROVIDER_ID,
    // Show whatever model the config names, friendli-routed or not.
    model: rootString(raw, "model"),
  };
}

export async function readProviderState(
  dataDir: string,
): Promise<ProviderState | undefined> {
  const { value } = await readJsonIfExists<ProviderState>(statePath(dataDir));
  return value;
}
