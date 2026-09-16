import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readJsonIfExists, readRawIfExists, writeJson } from "../../io/json.js";
import { writeFileAtomic } from "../../io/atomic-write.js";
import YAML from "yaml";
import {
  removeQuietly,
  snapshotFileIfNeeded,
  type ConfigBackup,
} from "../common/backup.js";
import {
  configBackupSlot,
  slotKey,
  snapshotOwnsConfigPath,
} from "../common/slot-key.js";
import { harnessDataDir } from "../../config/paths.js";

/** The profile `dsh` runs when the user doesn't name one. */
export const DEFAULT_DSH_PROFILE = "web";
/** The plugin bundle the caller installs via `dsh plugin add`. */
export const PLUGIN_BUNDLE = "@friendliai/dsh-llm-friendli";
/** The patch row dsh reads its default model from. */
export const MODEL_ROW_ID = "agent-default-model";
/** The patch row that carries the bundle's plugin config (our telemetry
 * headers ride its `extraHeaders` field). Same id as the bundle's inserted
 * plugin row, so the profile patch replaces that row's config. */
export const PLUGIN_ROW_ID = "@friendliai/dsh-llm-friendli";
/** The provider slug the @friendliai/dsh-llm-friendli bundle registers. */
export const PLUGIN_PROVIDER = "friendli";

export function dshHome(home: string): string {
  const override = process.env.DSH_HOME?.trim();
  return override ? override : path.join(home, ".dsh");
}

/** Match dsh's traversal and reserved-directory restrictions; never sanitize names. */
export function validateDshProfile(profile: string): void {
  if (
    profile === "" ||
    profile === "." ||
    profile === ".." ||
    profile === "node_modules" ||
    profile.includes("/") ||
    profile.includes("\\")
  ) {
    throw new Error(`dsh: invalid profile name ${JSON.stringify(profile)}`);
  }
}

export function dshProfile(
  home: string,
  profile: string,
  override = "",
): string {
  validateDshProfile(profile);
  return override || path.join(dshHome(home), "profiles", profile);
}

export function patchPathOf(profileDir: string): string {
  return path.join(profileDir, "cordis.patch.yml");
}

export function manifestPathOf(profileDir: string): string {
  return path.join(profileDir, "package.json");
}

export function dshDataDir(home: string, override = ""): string {
  return harnessDataDir(home, "dsh", override);
}

export interface ProviderState {
  apiKeySource: "flag" | "env" | "keychain";
  model: string;
  profile: string;
}

/** Slot key scoped to (resolved dsh home, profile) — dsh names the profile per
 * invocation, and several homes can share one machine. The tuple contents are
 * dsh POLICY; the hash is common (see SPEC.md). */
function dshSlotKey(home: string, profile: string): string {
  validateDshProfile(profile);
  return slotKey([path.resolve(dshHome(home)), profile]);
}

/** State is profile-scoped: enabling profile B must not clobber profile A. */
function statePath(dataDir: string, home: string, profile: string): string {
  return path.join(dataDir, `provider-state-${dshSlotKey(home, profile)}.json`);
}

/** Old lossy slots are usable only when their recorded patch path matches.
 * Legacy state has no such ownership proof and is deliberately ignored.
 * The probe, ENAMETOOLONG tolerance, and ownership check are the shared
 * mechanism; the slot names themselves are dsh POLICY. */
async function configBackupPath(
  dataDir: string,
  home: string,
  profile: string,
  configPath: string,
): Promise<string> {
  return configBackupSlot({
    dataDir,
    slotName: `config-${dshSlotKey(home, profile)}`,
    // The pre-hashing lossy name; every legacy basename contains "::",
    // which Windows cannot store as a filename (the probe skips that
    // platform entirely).
    legacySlotName: `config-${`${dshHome(home)}::${profile}`.replace(
      /[^a-zA-Z0-9:_.-]/g,
      "_",
    )}`,
    configPath,
  });
}

/**
 * Parses the profile's patch file as a document whose root is a YAML sequence
 * of `{id, config}` rows. `parseDocument` keeps comments and quoting styles —
 * we only rewrite the one row we own, so everything else must survive
 * byte-comparable. A missing file parses as an empty document (""); yaml v2
 * reports syntax problems on the returned document instead of throwing, so
 * those are surfaced with the same advice as the hermes core.
 */
async function parseDocumentOrAdvise(
  patchPath: string,
): Promise<YAML.Document> {
  const { existed, raw } = await readRawIfExists(patchPath);
  try {
    const doc = YAML.parseDocument(existed ? raw : "");
    const [error] = doc.errors;
    if (error) {
      // Rethrown below so the message matches the hermes core's wording.
      throw error;
    }
    return doc as unknown as YAML.Document;
  } catch (error) {
    throw new Error(
      `${patchPath} could not be parsed as YAML — fix it and rerun. ` +
        `Underlying error: ${(error as Error).message}`,
      { cause: error },
    );
  }
}

/** The LAST `{id, config}` row in `items` with the given id, if present.
 * dsh applies rows in order with later writes winning, so the final row is
 * the only effective one — patching an earlier duplicate would report
 * success without routing through Friendli. */
function rowWithId(seq: YAML.YAMLSeq, id: string): YAML.YAMLMap | undefined {
  for (let i = seq.items.length - 1; i >= 0; i--) {
    const item = seq.items[i];
    if (YAML.isMap(item) && String(item.get("id")) === id) {
      return item;
    }
  }
  return undefined;
}

/** A row is ours only while its live selection still matches our state. */
function rowMatchesState(
  row: YAML.YAMLMap | undefined,
  state: ProviderState | undefined,
  profile: string,
): boolean {
  const config = row?.get("config");
  return (
    state?.profile === profile &&
    YAML.isMap(config) &&
    config.items.length === 2 &&
    config.get("provider") === PLUGIN_PROVIDER &&
    config.get("model") === state.model
  );
}

/** Validate and snapshot the patch before plugin install changes the manifest.
 * A route match is not ownership; see SPEC.md. */
export async function prepareDshPatch(options: {
  home: string;
  dataDir: string;
  profile: string;
  profileDirOverride?: string;
}): Promise<{
  doc: YAML.Document;
  discardUnusedSnapshot: () => Promise<void>;
}> {
  const { home, dataDir, profile, profileDirOverride } = options;
  const patchPath = patchPathOf(dshProfile(home, profile, profileDirOverride));
  const doc = await parseDocumentOrAdvise(patchPath);
  if (!YAML.isSeq(doc.contents) && doc.contents !== null) {
    throw new Error(
      `${patchPath} is not a cordis patch file (expected a YAML array of {id, config} rows) — fix it and rerun.`,
    );
  }
  const backupPath = await configBackupPath(dataDir, home, profile, patchPath);
  const { existed: hadBackup } =
    await readJsonIfExists<ConfigBackup>(backupPath);
  await snapshotFileIfNeeded({
    configPath: patchPath,
    backupPath,
    isManaged: async () =>
      rowMatchesState(
        YAML.isSeq(doc.contents)
          ? rowWithId(doc.contents, MODEL_ROW_ID)
          : undefined,
        await readProviderState(dataDir, home, profile),
        profile,
      ),
  });
  const createdBackup = hadBackup
    ? undefined
    : (await readJsonIfExists<ConfigBackup>(backupPath)).value;
  return {
    doc,
    async discardUnusedSnapshot() {
      // Never discard prior recovery state or a snapshot needed to undo a
      // partial install. Compare raw bytes AND existence, not parsed YAML.
      if (!createdBackup) return;
      const current = await readRawIfExists(patchPath);
      if (
        current.existed === createdBackup.snapshot.existed &&
        current.raw === createdBackup.snapshot.raw
      ) {
        await removeQuietly(backupPath);
      }
    },
  };
}

/** Single write path for `dsh on`: the final `agent-default-model` row points
 * at `{provider: friendli, model}`. No key in the patch (the bundle reads
 * FRIENDLIAI_API_KEY from env). See SPEC.md. */
export async function enableFriendliForDsh(options: {
  home: string;
  dataDir: string;
  apiKeySource: "flag" | "env" | "keychain";
  model: string;
  profile: string;
  profileDirOverride?: string;
  /** Static headers baked into the bundle's plugin config at `on` time. */
  telemetryHeaders?: Readonly<Record<string, string>>;
}): Promise<{ model: string }> {
  const { home, dataDir, apiKeySource, model, profile } = options;
  const telemetryHeaders = options.telemetryHeaders ?? {};
  const profileDirOverride = options.profileDirOverride ?? "";
  const profileDir = dshProfile(home, profile, profileDirOverride);
  const patchPath = patchPathOf(profileDir);

  const { doc } = await prepareDshPatch(options);

  // The patch root is a sequence of `{id, config}` rows: rewrite the
  // agent-default-model row in place (keeping its position) or append it
  // after the user's rows. An empty file starts a fresh sequence; a
  // non-empty file whose root is NOT a sequence is refused rather than
  // silently replaced — that would destroy a document we don't own.
  // Re-read `doc.contents` inside the closure: the first upsert may
  // promote a null root to a new sequence (assigning `doc.contents`),
  // so a root captured once outside would stay stale (undefined) and the
  // second upsert would overwrite the row just created instead of
  // appending to it.
  const upsertRow = (id: string, config: Record<string, unknown>) => {
    const seq = YAML.isSeq(doc.contents) ? doc.contents : undefined;
    const existing = seq ? rowWithId(seq, id) : undefined;
    if (existing) {
      existing.set("config", doc.createNode(config));
    } else if (seq) {
      seq.add(doc.createNode({ id, config }));
    } else {
      doc.contents = doc.createNode([{ id, config }]);
    }
  };
  upsertRow(MODEL_ROW_ID, { provider: PLUGIN_PROVIDER, model });
  if (Object.keys(telemetryHeaders).length > 0) {
    // The bundle plugin's config row: extraHeaders ride on every provider
    // request. A row the user authored keeps its position; only the config
    // side is ours (the same replace-by-id ownership model as the model row).
    upsertRow(PLUGIN_ROW_ID, { extraHeaders: telemetryHeaders });
  }

  const serialized = `${doc.toString().replace(/\n+$/, "\n")}\n`;
  await writeFileAtomic(patchPath, serialized, { mode: 0o600 });

  await writeJson(
    statePath(dataDir, home, profile),
    { apiKeySource, model, profile } satisfies ProviderState,
    { mode: 0o600 },
  );

  return { model };
}

export type { DisableOutcome } from "../common/plugin-runner.js";

/** Parse pre-`on` snapshot bytes with the live file's refusal conventions:
 * our `on` refuses syntactically broken and non-row-sequence patches before
 * snapshotting, so a snapshot that fails either check was never one of ours —
 * refusing (instead of silently replacing the live file) keeps the backup
 * available as recovery. */
function parseSnapshotOrAdvise(patchPath: string, raw: string): YAML.Document {
  let doc: YAML.Document;
  try {
    doc = YAML.parseDocument(raw);
    const [error] = doc.errors;
    if (error) {
      // Rethrown below so the message matches the live-file advice.
      throw error;
    }
  } catch (error) {
    throw new Error(
      `${patchPath} could not be parsed as YAML — fix it and rerun. ` +
        `Underlying error: ${(error as Error).message}`,
      { cause: error },
    );
  }
  if (!YAML.isSeq(doc.contents) && doc.contents !== null) {
    throw new Error(
      `${patchPath} is not a cordis patch file (expected a YAML array of {id, config} rows) — fix it and rerun.`,
    );
  }
  return doc as unknown as YAML.Document;
}

/** The document holds no rows at all (absent/empty root or an emptied
 * sequence) — a semantically empty patch, whatever its byte form. */
function emptyPatchDoc(doc: YAML.Document): boolean {
  return (
    doc.contents === null ||
    (YAML.isSeq(doc.contents) && doc.contents.items.length === 0)
  );
}

/** State-less ownership fallback (see disableFriendliForDsh): when the
 * durable state file is gone but the backup envelope owns this exact
 * config path, a live `agent-default-model` row is still claimable as ours
 * only when its config is exactly the two-key `{provider: friendli,
 * model: <any>}` shape our `on` writes. Any extra key — or a different
 * provider — means the user authored it, and their row wins. */
function rowHasOurWriteSignature(row: YAML.YAMLMap | undefined): boolean {
  const config = row?.get("config");
  return (
    YAML.isMap(config) &&
    config.items.length === 2 &&
    config.get("provider") === PLUGIN_PROVIDER &&
    typeof config.get("model") === "string"
  );
}

/** Restores cordis.patch.yml to pre-frlink state + drops our state file;
 * caller removes the bundle via `dsh plugin remove` after. With a backup,
 * per-row three-way merge: only the `agent-default-model` row reverts (user
 * edits to any row survive). Without a backup, only a row still matching our
 * state is removed. See SPEC.md. */
export async function disableFriendliForDsh(options: {
  home: string;
  dataDir: string;
  profile: string;
  profileDirOverride?: string;
}): Promise<"restored" | "none"> {
  const profileDir = dshProfile(
    options.home,
    options.profile,
    options.profileDirOverride ?? "",
  );
  const patchPath = patchPathOf(profileDir);
  const backupPath = await configBackupPath(
    options.dataDir,
    options.home,
    options.profile,
    patchPath,
  );
  const { value: backup } = await readJsonIfExists<ConfigBackup>(backupPath);
  if (!backup) {
    const state = await readProviderState(
      options.dataDir,
      options.home,
      options.profile,
    );
    // A provider route is not ownership evidence; leave unowned files untouched.
    if (!state) return "none";
    const doc = await parseDocumentOrAdvise(patchPath);
    const seq = YAML.isSeq(doc.contents) ? doc.contents : undefined;
    const row = seq ? rowWithId(seq, MODEL_ROW_ID) : undefined;
    const pluginRow = seq ? rowWithId(seq, PLUGIN_ROW_ID) : undefined;
    const owned = rowMatchesState(row, state, options.profile);
    if (row && owned) {
      seq?.delete(seq.items.indexOf(row));
      // The plugin config row we wrote alongside it goes too — a config for
      // a bundle `off` is about to remove is ours to clean up.
      if (pluginRow) seq?.delete(seq.items.indexOf(pluginRow));
      await writeFileAtomic(
        patchPath,
        `${doc.toString().replace(/\n+$/, "\n")}\n`,
        {
          mode: 0o600,
        },
      );
    }
    await removeQuietly(
      statePath(options.dataDir, options.home, options.profile),
    );
    return owned ? "restored" : "none";
  }

  const { existed: liveExists } = await readRawIfExists(patchPath);
  if (!liveExists) {
    // Nothing of the user's can survive in a file that is gone, so the
    // pre-`on` bytes are the whole truth; a file that never existed before
    // `on` stays missing.
    if (backup.snapshot.existed) {
      await writeFileAtomic(patchPath, backup.snapshot.raw);
    }
  } else {
    const doc = await parseDocumentOrAdvise(patchPath);
    if (!YAML.isSeq(doc.contents) && doc.contents !== null) {
      // Never silently replace a foreign document we don't own — the same
      // refusal convention the enable path enforces.
      throw new Error(
        `${patchPath} is not a cordis patch file (expected a YAML array of {id, config} rows) — fix it and rerun.`,
      );
    }
    const preOn = parseSnapshotOrAdvise(patchPath, backup.snapshot.raw);
    const seq = YAML.isSeq(doc.contents) ? doc.contents : undefined;
    const ourRow = seq ? rowWithId(seq, MODEL_ROW_ID) : undefined;
    const state = await readProviderState(
      options.dataDir,
      options.home,
      options.profile,
    );
    const owned =
      state !== undefined
        ? rowMatchesState(ourRow, state, options.profile)
        : snapshotOwnsConfigPath(backup, patchPath) &&
          rowHasOurWriteSignature(ourRow);
    const liveJs = doc.toJS();
    // Revert a row to its pre-`on` state (config restored, or the row deleted
    // when pre-`on` had no such row) — the same per-row merge the model row
    // uses, applied to the plugin config row too.
    const revertRow = (id: string) => {
      const row = seq ? rowWithId(seq, id) : undefined;
      if (!row) return;
      const preOnRow = YAML.isSeq(preOn.contents)
        ? rowWithId(preOn.contents, id)
        : undefined;
      if (preOnRow) {
        const preOnConfig = preOnRow.get("config");
        if (preOnConfig === undefined) {
          row.delete("config");
        } else {
          row.set("config", preOnConfig);
        }
      } else {
        seq?.delete(seq.items.indexOf(row));
      }
    };
    if (owned) {
      revertRow(MODEL_ROW_ID);
      revertRow(PLUGIN_ROW_ID);
    }
    if (
      backup.snapshot.existed &&
      (isDeepStrictEqual(doc.toJS(), preOn.toJS()) ||
        (emptyPatchDoc(doc) && emptyPatchDoc(preOn)))
    ) {
      // The merge is semantically the pre-`on` file — restore its exact
      // bytes so comments and formatting survive the round trip (an empty
      // patch counts: an emptied sequence matches a missing/empty root).
      await writeFileAtomic(patchPath, backup.snapshot.raw);
    } else if (emptyPatchDoc(doc) && !backup.snapshot.existed) {
      // Our row was the only reason this file existed; the pre-`on` state
      // had no file, and nothing user-made survives the revert.
      await removeQuietly(patchPath);
    } else if (isDeepStrictEqual(doc.toJS(), liveJs)) {
      // Nothing of ours was reverted — the live file already is the merged
      // result, byte-for-byte as the user left it.
    } else {
      await writeFileAtomic(
        patchPath,
        `${doc.toString().replace(/\n+$/, "\n")}\n`,
        {
          mode: 0o600,
        },
      );
    }
  }
  await removeQuietly(backupPath);
  await removeQuietly(
    statePath(options.dataDir, options.home, options.profile),
  );
  return "restored";
}

/**
 * True iff the profile package.json lists the @friendliai/dsh-llm-friendli bundle in
 * `dsh.profile.bundles` — the same manifest dsh itself reconciles on
 * `plugin add`/`remove`, so this is the authoritative is-installed probe.
 * Missing files read as "not installed".
 */
export async function bundleInstalled(options: {
  home: string;
  profile: string;
  profileDirOverride?: string;
}): Promise<boolean> {
  const profileDir = dshProfile(
    options.home,
    options.profile,
    options.profileDirOverride ?? "",
  );
  const { existed, value: manifest } = await readJsonIfExists<{
    dsh?: { profile?: { bundles?: unknown } };
  }>(manifestPathOf(profileDir));
  if (!existed) return false;
  const bundles = manifest?.dsh?.profile?.bundles;
  const bundleItems = Array.isArray(bundles)
    ? bundles
    : ((bundles as { items?: unknown[] } | null)?.items ?? []);
  return bundleItems.some((item) => String(item) === PLUGIN_BUNDLE);
}

/**
 * True iff the profile package.json lists the @friendliai/dsh-llm-friendli bundle in
 * `dsh.profile.bundles` AND the patch has an agent-default-model row whose
 * config points at the plugin's `friendli` provider. Missing files read as
 * "not ours" rather than an error.
 */
export async function isFriendliManaged(options: {
  home: string;
  profile: string;
  profileDirOverride?: string;
}): Promise<boolean> {
  const profileDir = dshProfile(
    options.home,
    options.profile,
    options.profileDirOverride ?? "",
  );

  const { existed: manifestExisted, value: manifest } = await readJsonIfExists<{
    dsh?: { profile?: { bundles?: unknown } };
  }>(manifestPathOf(profileDir));
  if (!manifestExisted) {
    return false;
  }
  const bundles = manifest?.dsh?.profile?.bundles;
  // `dsh` writes plain JSON, but the split mirrors the hermes core: the
  // Document represents lists as sequence NODES; plain arrays pass through.
  const bundleItems = Array.isArray(bundles)
    ? bundles
    : ((bundles as { items?: unknown[] } | null)?.items ?? []);
  if (!bundleItems.some((item) => String(item) === PLUGIN_BUNDLE)) {
    return false;
  }

  const doc = await parseDocumentOrAdvise(patchPathOf(profileDir));
  const seq = YAML.isSeq(doc.contents) ? doc.contents : undefined;
  const row = seq ? rowWithId(seq, MODEL_ROW_ID) : undefined;
  return row?.getIn(["config", "provider"]) === PLUGIN_PROVIDER;
}

export async function readProviderState(
  dataDir: string,
  home: string,
  profile: string,
): Promise<ProviderState | undefined> {
  const { value } = await readJsonIfExists<ProviderState>(
    statePath(dataDir, home, profile),
  );
  return value;
}
