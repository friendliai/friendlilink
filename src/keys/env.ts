import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../io/atomic-write.js";
import { removeQuietly } from "../io/fs.js";
import { readJsonIfExists, readRawIfExists, writeJson } from "../io/json.js";

/**
 * Writes `KEY=VALUE` into the dotenv at `envPath` (0o600: carries the key).
 * Drops ALL existing `KEY=…` lines (incl. duplicates — a stale later one must
 * not shadow) and appends fresh; other lines pass through. Unreadable (non-
 * ENOENT) errors propagate — silently rewriting would destroy other secrets.
 * Plain line replace, no dotenv dep; hermes parses `KEY=VALUE` the same way.
 */
async function setEnvValue(
  envPath: string,
  key: string,
  value: string,
): Promise<void> {
  let raw = "";
  try {
    raw = await readFile(envPath, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") {
      throw error;
    }
  }
  const line = `${key}=${value}`;
  const split = raw.trim() ? raw.split("\n") : [];
  while (split.length > 0 && split[split.length - 1] === "") {
    split.pop();
  }
  const lines = split.filter((l) => !l.startsWith(`${key}=`));
  lines.push(line);
  await writeFileAtomic(envPath, `${lines.join("\n").replace(/\n*$/, "\n")}`, {
    mode: 0o600,
  });
}

/**
 * The ownership record behind `off`'s key-line revert — what the KEY line
 * held before frlink ever wrote one, and the exact line our last
 * write produced. 0o600: it carries the key's value while active.
 */
interface EnvKeyRecord {
  /** Absolute dotenv path `on` wrote to — `off` reverts THIS file even if the
   * env override ($DSH_HOME/$HERMES_HOME) now points somewhere else. */
  envPath: string;
  key: string;
  /** The exact `KEY=VALUE` line the write produced, so `off` can tell our
   * untouched line apart from one the user has since edited. */
  wroteLine: string;
  /** The KEY lines present before frlink ever wrote one, in
   * order — what `off` puts back. */
  existingLines: string[];
  /** Whether the dotenv file itself existed before `on` created it. */
  fileExisted: boolean;
}

/**
 * The per-(env file, key) record path. The hash is fixed-length so any env
 * path — Windows drive letters, exotic $DSH_HOME/$HERMES_HOME values — is
 * one safe filename, and distinct homes never share a record.
 */
function envKeyRecordPath(
  dataDir: string,
  envPath: string,
  key: string,
): string {
  const id = createHash("sha256")
    .update(`${path.resolve(envPath)}\n${key}`)
    .digest("hex")
    .slice(0, 16);
  return path.join(dataDir, `env-key-${id}.json`);
}

/**
 * Called right before `setEnvValue` in every `on` flow so `off` can revert
 * exactly the line we own: the first `on` captures what the KEY line held
 * before we overwrite it (plus whether the file even existed); a re-`on`
 * keeps that original capture and only refreshes the written line. An `on`
 * against a different env file captures that file's pre-state fresh.
 */
async function trackEnvKeyWrite(options: {
  envPath: string;
  recordPath: string;
  key: string;
  value: string;
}): Promise<void> {
  const { envPath, recordPath, key } = options;
  const wroteLine = `${key}=${options.value}`;
  const { value: maybeRecord } =
    await readJsonIfExists<EnvKeyRecord>(recordPath);

  let next: EnvKeyRecord;
  if (
    maybeRecord &&
    maybeRecord.envPath === path.resolve(envPath) &&
    maybeRecord.key === key
  ) {
    next = { ...maybeRecord, wroteLine };
  } else {
    const { existed, raw } = await readRawIfExists(envPath);
    next = {
      envPath: path.resolve(envPath),
      key,
      wroteLine,
      existingLines: existed
        ? raw.split("\n").filter((line) => line.startsWith(`${key}=`))
        : [],
      fileExisted: existed,
    };
  }

  await writeJson(recordPath, next, { mode: 0o600 });
}

type EnvKeyRevertOutcome = "reverted" | "none";

/**
 * Reverts the one KEY line `trackEnvKeyWrite` + `setEnvValue` produced, under
 * the `off` contract: the user's pre-frlink line comes back (the
 * line disappears if none existed; the whole file is deleted only if `on`
 * created it and nothing else survives). A line the user has since edited is
 * theirs — we drop only copies of our own value and never touch theirs.
 *
 * ponytail: any record-less file is left alone, so an `off` run under a
 * changed $DSH_HOME/$HERMES_HOME can strand the old home's key line — a
 * residue warning, never data loss.
 */
async function revertEnvKey(options: {
  recordPath: string;
}): Promise<EnvKeyRevertOutcome> {
  const { value: record } = await readJsonIfExists<EnvKeyRecord>(
    options.recordPath,
  );
  if (!record) {
    return "none";
  }
  // Ownership ends here either way: reverted or left to the user.
  await removeQuietly(options.recordPath);

  const { existed, raw } = await readRawIfExists(record.envPath);
  if (!existed) {
    // The whole file is gone — nothing of ours survives.
    return "reverted";
  }

  const lines = raw.split("\n");
  const keyPrefix = `${record.key}=`;
  const keyLines = lines.filter((line) => line.startsWith(keyPrefix));
  // Untouched = the field is still exactly what `on` wrote, and only that.
  const untouched = keyLines.length === 1 && keyLines[0] === record.wroteLine;

  let changed = false;
  let inserted = false;
  const rebuilt: string[] = [];
  for (const line of lines) {
    if (line === record.wroteLine) {
      changed = true;
      // Restore the pre-existing content only if the field is still ours;
      // an edited field keeps the user's lines and drops only our value.
      if (untouched && !inserted) {
        rebuilt.push(...record.existingLines);
        inserted = true;
      }
      continue;
    }
    rebuilt.push(line);
  }
  if (!changed) {
    // The user already removed our line themselves — nothing to do.
    return "reverted";
  }

  if (!record.fileExisted && rebuilt.every((line) => !line.trim())) {
    // `on` created this file and nothing but our line ever lived in it.
    await removeQuietly(record.envPath);
  } else {
    await writeFileAtomic(
      record.envPath,
      `${rebuilt.join("\n").replace(/\n*$/, "\n")}`,
      { mode: 0o600 },
    );
  }
  return "reverted";
}

/**
 * Shared `on`-flow key write for dotenv-key harnesses (hermes `~/.hermes/.env`,
 * dsh `<DSH_HOME>/.env`). One call owns the lifecycle: record what the KEY
 * field held (`trackEnvKeyWrite`) then overwrite (`setEnvValue`) — same shape
 * as the config-file snapshot path. Recording failure is fatal so `on` never
 * silently loses the user's key.
 */
export async function writeOwnedEnvKey(options: {
  /** Harness data dir — the ownership record lives beside the harness state. */
  dataDir: string;
  /** The harness's own dotenv path (already resolved for DSH_HOME etc.). */
  envPath: string;
  key: string;
  value: string;
}): Promise<void> {
  const { envPath, key, value } = options;
  await trackEnvKeyWrite({
    envPath,
    recordPath: envKeyRecordPath(options.dataDir, envPath, key),
    key,
    value,
  });
  await setEnvValue(envPath, key, value);
}

/**
 * Shared `off`-flow key revert: undo `writeOwnedEnvKey` — restore pre-`on`
 * lines, drop only the line we wrote, never touch a user-edited field, touch
 * nothing without a record. A locked/unreadable .env can't block uninstall,
 * so failures are swallowed (record survives for retry).
 */
export async function revertOwnedEnvKey(options: {
  dataDir: string;
  envPath: string;
  key: string;
}): Promise<EnvKeyRevertOutcome> {
  try {
    return await revertEnvKey({
      recordPath: envKeyRecordPath(
        options.dataDir,
        options.envPath,
        options.key,
      ),
    });
  } catch {
    // An unreadable/locked .env should not block the uninstall; the record
    // stays so a retry can complete the revert.
    return "none";
  }
}
