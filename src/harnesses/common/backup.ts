import path from "node:path";
import { writeFileAtomic } from "../../io/atomic-write.js";
import { removeQuietly } from "../../io/fs.js";
import { readJsonIfExists, readRawIfExists, writeJson } from "../../io/json.js";
export { removeQuietly } from "../../io/fs.js";

export interface FileSnapshot {
  existed: boolean;
  raw: string;
}

export interface ConfigBackup {
  configPath: string;
  snapshot: FileSnapshot;
}

export function backupPathFor(dataDir: string, name: string): string {
  return path.join(dataDir, `${name}-backup.json`);
}

/**
 * Snapshot the raw (unparsed) config text before we touch it, so `off` can
 * restore it byte-for-byte — including formatting and key order we don't
 * otherwise preserve. No-ops if a backup already exists (don't overwrite a
 * pre-FriendliLink snapshot with an already-managed one) or if the config
 * is already managed by us (re-running `on` shouldn't snapshot our own state).
 */
export async function snapshotFileIfNeeded(options: {
  configPath: string;
  backupPath: string;
  isManaged: () => Promise<boolean>;
}): Promise<void> {
  const { existed: hasBackup } = await readJsonIfExists<unknown>(
    options.backupPath,
  );
  if (hasBackup) {
    return;
  }
  if (await options.isManaged()) {
    return;
  }
  const snapshot = await readRawIfExists(options.configPath);
  await writeJson(
    options.backupPath,
    { configPath: path.resolve(options.configPath), snapshot },
    { mode: 0o600 },
  );
}

export type RestoreOutcome = "restored" | "none";

/**
 * Restores a snapshot made by `snapshotFileIfNeeded` byte-for-byte — or
 * deletes the config entirely if it didn't exist before we touched it — then
 * removes the backup. Returns "none" when there was nothing to restore.
 */
export async function restoreFileFromBackup(options: {
  configPath: string;
  backupPath: string;
}): Promise<RestoreOutcome> {
  const { value: backup } = await readJsonIfExists<ConfigBackup>(
    options.backupPath,
  );
  if (!backup) {
    return "none";
  }

  if (backup.snapshot.existed) {
    await writeFileAtomic(options.configPath, backup.snapshot.raw);
  } else {
    await removeQuietly(options.configPath);
  }
  await removeQuietly(options.backupPath);

  return "restored";
}
