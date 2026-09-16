import { isDeepStrictEqual } from "node:util";

/**
 * What `cursor on` changed, recorded well enough for `cursor off` to put it
 * back without touching anything else.
 *
 * Cursor keeps everything in one ~428KB JSON row: sixty-odd top-level keys
 * covering MCP servers, ignore rules, composer history, personal docs — all
 * Cursor's, none ours. The previous design snapshotted that row and wrote it
 * back wholesale on `off`, which meant a week of the user's unrelated Cursor
 * state was rolled back along with our four fields. This record exists so
 * `off` can be a field-level revert instead, the way the hermes and dsh
 * harnesses already work.
 *
 * The four marker arrays it replaces recorded *what we changed* but never
 * *what was there before*, so they could not restore a prior value, could not
 * tell an absent key from a false one, and could not express anything but
 * flat string lists. Each entry here carries the prior value alongside ours.
 *
 * Two rules govern every revert, and they are what make repeated runs and
 * hand-edits safe:
 *
 *   - A field whose live value is no longer what we wrote belongs to whoever
 *     changed it. Leave it.
 *   - A list change reality already undid is not ours to redo.
 */

/** One field we set: what was there, and what we put there. */
export interface FieldRecord {
  /** Whether the key existed at all before we wrote it. */
  had: boolean;
  prior?: unknown;
  wrote: unknown;
}

/** Membership changes to one string list. */
export interface ListRecord {
  inserted: string[];
  removed: string[];
  /** Whether the list key existed at all before we touched it. When it did
   * not, a revert that empties it removes the key rather than leaving `[]`. */
  had?: boolean;
}

export interface CursorOwnership {
  v: 1;
  baseUrl: string;
  appliedAt: string;
  /** Proves the key cell still holds the key we wrote; "" when unknown. */
  keyFingerprint: string;
  /** Blob-root fields: `openAIBaseUrl`, `useOpenAIKey`. */
  scalars: Record<string, FieldRecord>;
  /** `aiSettings` list membership we changed. */
  lists: Record<string, ListRecord>;
  /** `aiSettings.modelConfig[mode]`, field by field. */
  modes: Record<string, Record<string, FieldRecord>>;
  /** `availableDefaultModels2` entries, keyed by name. Reserved for the
   * reasoning work; `off` already knows how to undo it. */
  catalogEntries: Record<
    string,
    { createdByUs: boolean; fields: Record<string, FieldRecord> }
  >;
  /** `aiSettings.modelParameterPreferences[modelId]`. Reserved likewise. */
  parameterPreferences: Record<string, FieldRecord>;
}

/** Where the record lives on the blob. A value inside Cursor's own database:
 * it is what `off` looks for to know a change was ours. */
const OWNERSHIP_FIELD = "friendlilink";

type Container = Record<string, unknown>;

export function emptyOwnership(
  base: Partial<CursorOwnership> = {},
): CursorOwnership {
  return {
    v: 1,
    baseUrl: "",
    appliedAt: "",
    keyFingerprint: "",
    scalars: {},
    lists: {},
    modes: {},
    catalogEntries: {},
    parameterPreferences: {},
    ...base,
  };
}

/* -------------------------------------------------------------------------- */
/* The two primitives, and their inverses                                      */
/* -------------------------------------------------------------------------- */

/** Set a field, recording what was there. */
export function writeField(
  container: Container,
  key: string,
  value: unknown,
  into: Record<string, FieldRecord>,
): void {
  // Only the FIRST write of a run records the prior — a second write would
  // record our own value as the user's.
  if (!(key in into)) {
    const had = Object.hasOwn(container, key);
    into[key] = had
      ? { had, prior: container[key], wrote: value }
      : { had, wrote: value };
  } else {
    into[key]!.wrote = value;
  }
  container[key] = value;
}

/** Put a field back, unless it is no longer ours. */
export function revertField(
  container: Container,
  key: string,
  record: FieldRecord,
): void {
  if (!isDeepStrictEqual(container[key], record.wrote)) {
    return; // someone changed it after us; it is theirs now
  }
  if (record.had) {
    container[key] = record.prior;
  } else {
    delete container[key];
  }
}

function listRecord(into: Record<string, ListRecord>, key: string): ListRecord {
  return (into[key] ??= { inserted: [], removed: [] });
}

/** Add an id to a list, recording it only when it was genuinely absent. */
export function insertInto(
  list: string[],
  id: string,
  into: Record<string, ListRecord>,
  key: string,
): void {
  if (list.includes(id)) {
    return; // already the user's; claiming it would delete their entry on `off`
  }
  list.push(id);
  const record = listRecord(into, key);
  if (!record.inserted.includes(id)) {
    record.inserted.push(id);
  }
}

/** Drop an id from a list, recording it only when it was genuinely present. */
export function removeFrom(
  list: string[],
  id: string,
  into: Record<string, ListRecord>,
  key: string,
): string[] {
  if (!list.includes(id)) {
    return list;
  }
  const record = listRecord(into, key);
  if (!record.removed.includes(id)) {
    record.removed.push(id);
  }
  return list.filter((entry) => entry !== id);
}

/** Undo our membership changes, skipping any reality already undid. */
export function revertList(list: string[], record: ListRecord): string[] {
  const inserted = new Set(record.inserted);
  const next = list.filter((id) => !inserted.has(id));
  for (const id of record.removed) {
    if (!next.includes(id)) {
      next.push(id);
    }
  }
  return next;
}

/* -------------------------------------------------------------------------- */
/* Reading the record                                                          */
/* -------------------------------------------------------------------------- */

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

function aiSettingsOf(blob: Container): Container {
  const ai = blob.aiSettings;
  return ai && typeof ai === "object" ? (ai as Container) : {};
}

/** The record for this blob, or undefined when we do not own it. */
export function readOwnership(blob: Container): CursorOwnership | undefined {
  const stored = aiSettingsOf(blob)[OWNERSHIP_FIELD];
  if (
    stored &&
    typeof stored === "object" &&
    (stored as CursorOwnership).v === 1
  ) {
    return { ...emptyOwnership(), ...(stored as CursorOwnership) };
  }
  return undefined;
}

/** True when this blob carries evidence we configured it. */
export function cursorIsManaged(blob: Container): boolean {
  return readOwnership(blob) !== undefined;
}

/* -------------------------------------------------------------------------- */
/* Reverting                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Undo everything the record describes, in reverse of the order `on` applied
 * it, and remove the record itself. The blob object is mutated in place —
 * never replaced — so every key Cursor owns survives untouched.
 */
export function revertAll(blob: Container, record: CursorOwnership): void {
  const ai = aiSettingsOf(blob);

  // Catalog entries and parameter preferences (written by the reasoning work).
  const entries = Array.isArray(blob.availableDefaultModels2)
    ? blob.availableDefaultModels2
    : [];
  for (const [name, tracked] of Object.entries(record.catalogEntries)) {
    const index = entries.findIndex(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        (entry as Container).name === name,
    );
    if (index === -1) continue; // Cursor's catalog refresh already took it
    if (tracked.createdByUs) {
      entries.splice(index, 1);
      continue;
    }
    for (const [key, field] of Object.entries(tracked.fields)) {
      revertField(entries[index] as Container, key, field);
    }
  }

  const preferences = ai.modelParameterPreferences;
  if (preferences && typeof preferences === "object") {
    for (const [modelId, field] of Object.entries(
      record.parameterPreferences,
    )) {
      revertField(preferences as Container, modelId, field);
    }
  }

  // Modes.
  const modelConfig = ai.modelConfig;
  if (modelConfig && typeof modelConfig === "object") {
    for (const [mode, fields] of Object.entries(record.modes)) {
      const entry = (modelConfig as Container)[mode];
      if (!entry || typeof entry !== "object") continue;
      for (const [key, field] of Object.entries(fields)) {
        revertField(entry as Container, key, field);
      }
    }
  }

  // Lists.
  for (const [key, listChanges] of Object.entries(record.lists)) {
    if (!Object.hasOwn(ai, key)) continue;
    const next = revertList(stringList(ai[key]), listChanges);
    if (next.length === 0 && listChanges.had === false) {
      delete ai[key]; // we created this list; leaving `[]` invents a key
      continue;
    }
    ai[key] = next;
  }

  // Blob-root scalars.
  for (const [key, field] of Object.entries(record.scalars)) {
    revertField(blob, key, field);
  }

  clearOwnership(blob);
}

/** Remove the record. */
export function clearOwnership(blob: Container): void {
  delete aiSettingsOf(blob)[OWNERSHIP_FIELD];
}

/** Store the record on the blob. */
export function storeOwnership(blob: Container, record: CursorOwnership): void {
  const ai = blob.aiSettings;
  if (!ai || typeof ai !== "object") {
    blob.aiSettings = { [OWNERSHIP_FIELD]: record };
    return;
  }
  (ai as Container)[OWNERSHIP_FIELD] = record;
}
