import { createHash } from "node:crypto";
import {
  cursorIsManaged,
  emptyOwnership,
  insertInto,
  readOwnership,
  removeFrom,
  revertAll,
  storeOwnership,
  writeField,
} from "./ownership.js";
import { removeQuietly } from "../common/backup.js";
import type { DisableOutcome } from "../common/plugin-runner.js";
import { catalogEntries, entryName, modelsToHide } from "./byok.js";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { chmod, mkdir } from "node:fs/promises";
import { readJsonIfExists, writeJson } from "../../io/json.js";
import {
  applyItemTableWrites,
  readItemTableValue,
  type ItemTableMutation,
} from "../../system/sqlite.js";
import {
  decryptSecret,
  encryptSecret,
  isSecretEncryptionAvailable,
} from "../../system/safestorage.js";
import { harnessDataDir } from "../../config/paths.js";

/**
 * Cursor stores AI settings in a SQLite DB (`state.vscdb`), not a JSON file.
 *
 * - API key        -> ItemTable row `secret://cursorAuth/openAIKey`, an Electron
 *                     `safeStorage`-encrypted cell. Older Cursor builds read a
 *                     plaintext `cursorAuth/openAIKey` cell — we write that as
 *                     a fallback so either build can read the key.
 * - Base URL       -> field `openAIBaseUrl` on the `applicationUser` JSON blob.
 * - Custom models  -> `aiSettings.userAddedModels` + `aiSettings.modelOverrideEnabled`.
 * - Hidden models  -> `aiSettings.modelOverrideDisabled` (picker hides these).
 * - Per-mode model -> `aiSettings.modelConfig[mode].{modelName, selectedModels}`.
 *
 * The `applicationUser` blob is one ItemTable row whose value is a compact
 * JSON string; we preserve that form so the on-disk delta stays minimal.
 *
 * Ownership: every change `on` makes is recorded under `aiSettings.friendlilink`
 * (see ownership.ts), which is also the only thing that authorizes `off` to
 * change anything back. Other provider-switching tools write their own fields
 * into this same blob and none of them clean up after each other, so `off`
 * touches only what the record names.
 */

export const APPLICATION_USER_KEY =
  "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser";
export const CURSOR_AUTH_OPENAI_KEY = "cursorAuth/openAIKey";
/** The encrypted cell modern Cursor reads (see system/safestorage.ts). */
export const CURSOR_AUTH_OPENAI_KEY_SECRET = "secret://cursorAuth/openAIKey";

/** Cursor's own on-disk shape for "no key": an empty ciphertext in the
 * `secret://` cell (and no legacy plaintext row). */
const EMPTY_SAFE_STORAGE_CIPHERTEXT = JSON.stringify({
  type: "Buffer",
  data: [],
});

interface AiSettings {
  [key: string]: unknown;
}

export interface CursorBlob {
  openAIBaseUrl?: unknown;
  useOpenAIKey?: unknown;
  availableDefaultModels2?: Array<{ name?: unknown } | null>;
  aiSettings?: AiSettings;
  [key: string]: unknown;
}

/** Move the user's key freely: the backup may hold it, so it stays 0600. */
export interface CursorSnapshot {
  appUserExisted: boolean;
  appUserRaw: string;
  openAIKey: string;
}

interface CursorBackup {
  dbPath: string;
  snapshot: CursorSnapshot;
}

interface ProviderState {
  apiKeySource: "flag" | "env" | "keychain";
}

export function cursorStateDbPath(home: string, override = ""): string {
  if (override) {
    return path.resolve(override);
  }
  const platform = os.platform();
  if (platform === "darwin") {
    return path.join(
      home,
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "globalStorage",
      "state.vscdb",
    );
  }
  if (platform === "win32") {
    const appData =
      process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, "Cursor", "User", "globalStorage", "state.vscdb");
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(
    configHome,
    "Cursor",
    "User",
    "globalStorage",
    "state.vscdb",
  );
}

/** Cursor's user-data root holds the Windows OSCrypt key; state.vscdb is
 * `User/globalStorage/` two levels below, so `Local State` is three up. */
function cursorLocalStatePath(dbPath: string): string {
  return path.join(
    path.dirname(path.dirname(path.dirname(path.resolve(dbPath)))),
    "Local State",
  );
}

/**
 * Cursor writes `state.vscdb` on its first launch. Until then there is no
 * profile to configure, and `on` would fail on the raw SQLite error
 * ("unable to open database file") with nothing pointing at the cause.
 */
export async function assertCursorProfileExists(dbPath: string): Promise<void> {
  if (existsSync(dbPath)) {
    return;
  }
  throw new Error(
    "The necessary config files haven't been created because Cursor has never been launched. " +
      "Please launch and quit Cursor, then run the same command again.",
  );
}

export function cursorDataDir(home: string, override = ""): string {
  return harnessDataDir(home, "cursor", override);
}

function statePath(dataDir: string): string {
  return path.join(dataDir, "provider-state.json");
}

/** Backups are keyed by the DB path — two state.vscdb files must never
 * restore each other. */
function backupPathFor(dataDir: string, dbPath: string): string {
  const key = createHash("sha256")
    .update(path.resolve(dbPath))
    .digest("hex")
    .slice(0, 16);
  return path.join(dataDir, `cursor-backup.${key}.json`);
}

async function readCursorBackup(
  dataDir: string,
  dbPath: string,
): Promise<CursorBackup | undefined> {
  const { value } = await readJsonIfExists<CursorBackup>(
    backupPathFor(dataDir, dbPath),
  );
  return value;
}

/** The pre-`on` blob a snapshot carries, for the prior values the legacy
 * markers never stored. A snapshot of "the row did not exist" is still
 * knowledge: every field we wrote was absent before, so a revert deletes
 * rather than nulls. */
async function writeCursorBackup(
  dataDir: string,
  dbPath: string,
  snapshot: CursorSnapshot,
): Promise<void> {
  const backupPath = backupPathFor(dataDir, dbPath);
  // The backup can hold the user's prior API key — keep dir + file owner-only.
  await mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
  await writeJson(backupPath, { dbPath: path.resolve(dbPath), snapshot });
  await chmod(backupPath, 0o600);
}

/* -------------------------------------------------------------------------- */
/* Key cells                                                                   */
/* -------------------------------------------------------------------------- */

/** Key-cell state (encrypted `secret://` + legacy plaintext fallback).
 * `key` is "" both when the cell is empty AND when a ciphertext couldn't be
 * decrypted — `occupied` distinguishes them. */
interface CursorKeyCell {
  key: string;
  /** Something is in the cell, decryptable or not. */
  occupied: boolean;
}

async function readCursorOpenAiKeyCell(dbPath: string): Promise<CursorKeyCell> {
  const secretRaw = await readItemTableValue(
    dbPath,
    CURSOR_AUTH_OPENAI_KEY_SECRET,
  );
  // Cursor writes an empty ciphertext for "no key" — that is an empty cell,
  // not an unreadable one.
  const hasSecret =
    Boolean(secretRaw) && secretRaw !== EMPTY_SAFE_STORAGE_CIPHERTEXT;
  const secret = hasSecret
    ? decryptSecret(secretRaw ?? "", {
        localStatePath: cursorLocalStatePath(dbPath),
      })
    : "";
  if (secret) {
    return { key: secret, occupied: true };
  }
  const legacy = await readItemTableValue(dbPath, CURSOR_AUTH_OPENAI_KEY);
  return { key: legacy ?? "", occupied: hasSecret || Boolean(legacy) };
}

/** The OpenAI key Cursor actually uses; "" = none or unreadable. */
export async function readCursorOpenAiKey(dbPath: string): Promise<string> {
  return (await readCursorOpenAiKeyCell(dbPath)).key;
}

/** Parse an applicationUser blob ("" parses to an empty blob). */
export function parseBlob(raw: string): CursorBlob {
  if (!raw) {
    return {};
  }
  const blob = JSON.parse(raw) as CursorBlob;
  if (!blob || typeof blob !== "object") {
    return {};
  }
  if (!blob.aiSettings || typeof blob.aiSettings !== "object") {
    blob.aiSettings = {};
  }
  return blob;
}

/* -------------------------------------------------------------------------- */
/* Pure blob transforms                                                        */
/* -------------------------------------------------------------------------- */

/** True when this Cursor carries our ownership record (or the legacy markers
 * an older release left). A routing match is deliberately NOT evidence — a
 * user can point the override at Friendli by hand, and dsh states the same
 * rule: "A provider route is not ownership evidence." */
export function cursorHasManagedMarkers(blob: CursorBlob): boolean {
  return cursorIsManaged(blob as Record<string, unknown>);
}

/** The Friendli models this run registered. */
export function managedModels(blob: CursorBlob): string[] {
  const record = readOwnership(blob as Record<string, unknown>);
  return record?.lists.userAddedModels?.inserted ?? [];
}

/* -------------------------------------------------------------------------- */
/* Enable / disable                                                            */
/* -------------------------------------------------------------------------- */

/** The atomic write set: the blob, the legacy plaintext key cell, and the
 * `secret://` ciphertext modern Cursor reads (dropped when encryption is
 * unavailable — e.g. Cursor never launched to create its key). */
function cursorKeyWrites(
  dbPath: string,
  blobRaw: string,
  apiKey: string,
  encryptionAvailable?: boolean,
): ItemTableMutation[] {
  const writes: ItemTableMutation[] = [
    { op: "set", key: APPLICATION_USER_KEY, value: blobRaw },
    { op: "set", key: CURSOR_AUTH_OPENAI_KEY, value: apiKey },
  ];
  const localStatePath = cursorLocalStatePath(dbPath);
  if (encryptionAvailable ?? isSecretEncryptionAvailable({ localStatePath })) {
    writes.push({
      op: "set",
      key: CURSOR_AUTH_OPENAI_KEY_SECRET,
      value: encryptSecret(apiKey, { localStatePath }),
    });
  } else {
    // Cursor reads the encrypted cell before the legacy plaintext one, so a
    // ciphertext left from an earlier run would keep winning and `on` would
    // report success while Cursor kept using the old key. Drop it, so the
    // plaintext row we just wrote is what Cursor sees.
    writes.push({ op: "del", key: CURSOR_AUTH_OPENAI_KEY_SECRET });
  }
  return writes;
}

/** Single write path for `cursor on`: snapshot (first run only), point the
 * OpenAI override at Friendli, register the catalog in the picker, hide the
 * built-ins the endpoint can't serve. Deliberately does NOT pick a model —
 * Cursor resolves the active model per-conversation, so a global choice would
 * only take effect for brand-new composers. See SPEC.md. */
export async function enableFriendliForCursor(options: {
  dbPath: string;
  dataDir: string;
  apiKey: string;
  apiKeySource: "flag" | "env" | "keychain";
  /** Friendli's OpenAI-compatible base (`.../serverless/v1`). */
  baseUrl: string;
  /** Friendli catalog ids to register in Cursor's picker. */
  catalogIds: string[];
  /** Stamped into the record; injected so tests are deterministic. */
  now?: () => string;
}): Promise<{ modelsAdded: string[]; modelsHidden: string[] }> {
  const { dbPath, dataDir, apiKey, apiKeySource, baseUrl, catalogIds } =
    options;

  const appUserRaw = await readItemTableValue(dbPath, APPLICATION_USER_KEY);
  const blob = parseBlob(appUserRaw) as Record<string, unknown>;
  const backup = await readCursorBackup(dataDir, dbPath);
  // The priors matter on the upgrade path: a blob left by an older release
  // carries the legacy markers and no record, and those markers never stored
  // what was there before. Without the snapshot the synthesis has to guess,
  // and `on` would then record the guess as the user's own value.
  const previous = readOwnership(blob);

  // Snapshot only genuinely pre-`on` state. A record means we have been here
  // before, so the live blob is already ours and is not the original.
  if (!backup && !previous) {
    // Decrypting the user's prior key needs the Safe Storage password, so only
    // reach for it on the one run that records the snapshot.
    await writeCursorBackup(dataDir, dbPath, {
      appUserExisted: Boolean(appUserRaw),
      appUserRaw,
      openAIKey: await readCursorOpenAiKey(dbPath),
    });
  }

  // Undo the previous run before measuring anything. Priors are then captured
  // from a blob that has been rolled back, so a second `on` can never record
  // our own values as the user's — and a model we hid last time is visible
  // again before we decide whether to hide it now. This is the same function
  // `off` calls: one revert path, exercised by both verbs.
  if (previous) {
    revertAll(blob, previous);
  }

  const record = emptyOwnership({
    baseUrl,
    appliedAt: (options.now ?? (() => new Date().toISOString()))(),
    keyFingerprint: fingerprintOf(apiKey),
  });
  const ai = (blob.aiSettings ??= {}) as Record<string, unknown>;
  const list = (key: string): string[] => {
    const current = Array.isArray(ai[key]) ? (ai[key] as unknown[]) : [];
    return current.filter((v): v is string => typeof v === "string");
  };

  // Note which of these lists exist *before* we touch them. A list we create
  // must be removed again on `off`, not left behind as an empty array the
  // user never had.
  for (const key of [
    "userAddedModels",
    "modelOverrideEnabled",
    "modelOverrideDisabled",
  ]) {
    record.lists[key] = {
      inserted: [],
      removed: [],
      had: Object.hasOwn(ai, key),
    };
  }

  writeField(blob, "openAIBaseUrl", baseUrl, record.scalars);
  writeField(blob, "useOpenAIKey", true, record.scalars);

  // Register every Friendli model. Offline, keep whatever a previous online
  // run registered rather than pruning a working setup.
  const entries = catalogEntries(blob);
  const builtinNames = new Set(
    entries.filter((e) => e.isUserAdded !== true).map(entryName),
  );
  const servableIds = new Set(catalogIds.filter(Boolean));
  if (catalogIds.length === 0 && previous) {
    for (const id of previous.lists.userAddedModels?.inserted ?? []) {
      if (!builtinNames.has(id)) servableIds.add(id);
    }
  }
  if (servableIds.size === 0) {
    // Nothing to offer and nothing to fall back on: registering no models
    // while hiding Cursor's own would leave an editor that cannot answer.
    throw new Error(
      "Could not fetch the FriendliAI model catalog, and no models are registered from an earlier run; Cursor was left unchanged.",
    );
  }

  const userOwned = new Set(list("userAddedModels"));
  const added: string[] = [];
  for (const id of servableIds) {
    const userAdded = list("userAddedModels");
    insertInto(userAdded, id, record.lists, "userAddedModels");
    ai.userAddedModels = userAdded;
    const enabled = list("modelOverrideEnabled");
    insertInto(enabled, id, record.lists, "modelOverrideEnabled");
    ai.modelOverrideEnabled = enabled;
    // A Friendli id colliding with a built-in the user had hidden must not
    // stay hidden now that we serve it.
    ai.modelOverrideDisabled = removeFrom(
      list("modelOverrideDisabled"),
      id,
      record.lists,
      "modelOverrideDisabled",
    );
    if (!userOwned.has(id)) added.push(id);
  }

  // Hide what stops working. Both lists must change: Cursor's own precedence
  // rules disagree with each other, so an id left in `modelOverrideEnabled`
  // can override its own entry in `modelOverrideDisabled`.
  const hidden = modelsToHide({
    entries,
    servable: (id) => servableIds.has(id),
    userOwned,
  });
  for (const id of hidden) {
    const disabled = list("modelOverrideDisabled");
    insertInto(disabled, id, record.lists, "modelOverrideDisabled");
    ai.modelOverrideDisabled = disabled;
    ai.modelOverrideEnabled = removeFrom(
      list("modelOverrideEnabled"),
      id,
      record.lists,
      "modelOverrideEnabled",
    );
  }

  // No mode is touched — see the note on this function. `record.modes` stays
  // in the type because `off` still has to undo the modes an older release
  // wrote.

  storeOwnership(blob, record);

  await applyItemTableWrites(
    dbPath,
    cursorKeyWrites(dbPath, JSON.stringify(blob), apiKey),
  );
  await writeJson(
    statePath(dataDir),
    { apiKeySource } satisfies ProviderState,
    { mode: 0o600 },
  );

  return { modelsAdded: added, modelsHidden: hidden };
}

/** What `off` did with the key cell. `cleared` = user had no key pre-`on`
 * (restoring). `left` = nothing changed. */
export type ApiKeyOutcome = "restored" | "cleared" | "left";

export interface CursorDisableResult {
  outcome: DisableOutcome;
  /** What happened to the OpenAI key cell. */
  apiKey: ApiKeyOutcome;
  /** False when the pre-`on` snapshot is gone — the only thing it carried that
   * the ownership record cannot. */
  hadBackup: boolean;
}

/**
 * Undo what `on` did, field by field. Ownership record on the blob is the only
 * change authority — a routed-looking blob is not evidence. The pre-`on`
 * snapshot survives only as the user's prior OpenAI API key (non-reconstructible
 * from the blob).
 */
export async function disableFriendliForCursor(options: {
  dbPath: string;
  dataDir: string;
}): Promise<CursorDisableResult> {
  const { dbPath, dataDir } = options;
  const backup = await readCursorBackup(dataDir, dbPath);
  if (backup && backup.dbPath !== path.resolve(dbPath)) {
    throw new Error(
      `Cursor backup was taken for ${backup.dbPath}, not ${dbPath}; refusing to restore.`,
    );
  }

  const appUserRaw = await readItemTableValue(dbPath, APPLICATION_USER_KEY);
  const blob = parseBlob(appUserRaw) as Record<string, unknown>;
  const record = readOwnership(blob);

  if (!record) {
    // Nothing in this database is provably ours. Leave it completely alone and
    // take only our own bookkeeping away.
    await removeQuietly(backupPathFor(dataDir, dbPath));
    await removeQuietly(statePath(dataDir));
    return { outcome: "none", apiKey: "left", hadBackup: Boolean(backup) };
  }

  revertAll(blob, record);

  // The row is Cursor's, not ours: only drop it when it did not exist before
  // our `on` AND nothing has since been written into it. Cursor stores its own
  // state here within seconds of launching.
  const neverExisted = backup !== undefined && !backup.snapshot.appUserExisted;
  const writes: ItemTableMutation[] = [
    neverExisted && isEffectivelyEmpty(blob)
      ? { op: "del", key: APPLICATION_USER_KEY }
      : { op: "set", key: APPLICATION_USER_KEY, value: JSON.stringify(blob) },
  ];
  const apiKey = appendKeyRestoreWrites(writes, {
    dbPath,
    priorKey: backup?.snapshot.openAIKey ?? "",
    fingerprint: record.keyFingerprint,
    // Reading this decrypts through the Safe Storage keychain item, which
    // prompts on macOS. Only worth a prompt when there is a fingerprint to
    // compare it against; without one we cannot prove anything either way.
    live: record.keyFingerprint
      ? await readCursorOpenAiKeyCell(dbPath)
      : { key: "", occupied: false },
  });

  await applyItemTableWrites(dbPath, writes);
  await removeQuietly(backupPathFor(dataDir, dbPath));
  await removeQuietly(statePath(dataDir));
  return { outcome: "restored", apiKey, hadBackup: Boolean(backup) };
}

/** Key-cell restore: the only place where unprovable means *clear* (a
 * leftover Friendli key would leak to api.openai.com). Ownership rule still
 * applies — the cell is ours when the fingerprint matches, so we restore the
 * prior key or clear; a different/empty readable cell is the user's and stays.
 * The unreadable case also reads as empty, so empty alone can't mean
 * user-cleared. */
function appendKeyRestoreWrites(
  writes: ItemTableMutation[],
  options: {
    dbPath: string;
    priorKey: string;
    fingerprint: string;
    live: CursorKeyCell;
  },
): ApiKeyOutcome {
  const { dbPath, priorKey, fingerprint, live } = options;
  const localStatePath = cursorLocalStatePath(dbPath);

  // Without a fingerprint nothing about the cell is provable, so neither
  // branch below may fire — fall through to the leak-safe path.
  if (fingerprint) {
    if (live.key && fingerprintOf(live.key) !== fingerprint) {
      return "left"; // they entered their own key
    }
    if (!live.occupied) {
      return "left"; // they emptied it; there is nothing of ours to take out
    }
  }

  if (priorKey) {
    writes.push({ op: "set", key: CURSOR_AUTH_OPENAI_KEY, value: priorKey });
    if (isSecretEncryptionAvailable({ localStatePath })) {
      writes.push({
        op: "set",
        key: CURSOR_AUTH_OPENAI_KEY_SECRET,
        value: encryptSecret(priorKey, { localStatePath }),
      });
    } else {
      writes.push({ op: "del", key: CURSOR_AUTH_OPENAI_KEY_SECRET });
    }
    return "restored";
  }

  writes.push({
    op: "set",
    key: CURSOR_AUTH_OPENAI_KEY_SECRET,
    value: EMPTY_SAFE_STORAGE_CIPHERTEXT,
  });
  writes.push({ op: "del", key: CURSOR_AUTH_OPENAI_KEY });
  return "cleared";
}

/** Nothing left but empty husks — safe to drop a row we created. */
function isEffectivelyEmpty(blob: Record<string, unknown>): boolean {
  return Object.entries(blob).every(([, value]) => {
    if (value === null || value === undefined) return true;
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === "object")
      return Object.keys(value as object).length === 0;
    return false;
  });
}

/** Identifies the key we wrote without storing it. */
function fingerprintOf(apiKey: string): string {
  return apiKey
    ? createHash("sha256").update(apiKey).digest("hex").slice(0, 16)
    : "";
}

export async function readProviderState(
  dataDir: string,
): Promise<ProviderState | undefined> {
  const { value } = await readJsonIfExists<ProviderState>(statePath(dataDir));
  return value;
}

/** Test seam: the key writes `on` would make, with encryption forced on or off. */
export function cursorKeyWritesForTests(
  dbPath: string,
  blobRaw: string,
  apiKey: string,
  encryptionAvailable: boolean,
): ItemTableMutation[] {
  return cursorKeyWrites(dbPath, blobRaw, apiKey, encryptionAvailable);
}
