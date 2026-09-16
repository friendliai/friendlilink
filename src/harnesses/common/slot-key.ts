import { createHash } from "node:crypto";
import path from "node:path";
import { readJsonIfExists } from "../../io/json.js";
import { backupPathFor, type ConfigBackup } from "./backup.js";

/**
 * The slot MECHANISM harness adapters use to key backup/state files: a
 * stable SHA-256 over a harness-supplied scope tuple, plus the rules for
 * reusing an older lossy slot. What a slot's identity IS (the scope tuple's
 * contents) is per-harness POLICY and stays in each adapter, and it follows
 * from what the harness CLI actually exposes: dsh names the profile per
 * invocation, so it keys by [resolved home, profile]; hermes resolves
 * profile names inside its own process (profile use, -p, bare HERMES_HOME
 * sandboxes) and hand us only a resolved directory, so it keys by its
 * config path directly.
 */

/** A stable, filesystem-safe key for one harness-specific scope. */
export function slotKey(scope: unknown[] | Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(scope)).digest("hex");
}

/**
 * The recorded-configPath ownership proof: a backup envelope that named
 * THIS config path (path aliases resolved, overrides included) proves
 * frlink owns that path — even with no other state left.
 */
export function snapshotOwnsConfigPath(
  backup: ConfigBackup | undefined,
  configPath: string,
): boolean {
  return (
    typeof backup?.configPath === "string" &&
    path.resolve(backup.configPath) === path.resolve(configPath)
  );
}

/**
 * The backup slot for one config path: the hashed slot, or — only while no
 * hashed one exists yet — a legacy lossy slot whose recorded configPath
 * proves it snapshotted this exact path; legacy state without that
 * ownership evidence must remain unimported. Probing an overlong legacy
 * basename throws ENAMETOOLONG, which reads as "never held a backup here";
 * "::"-style legacy names can never have existed on Windows, so the probe
 * is skipped there entirely.
 */
export async function configBackupSlot(options: {
  dataDir: string;
  /** The hashed slot name, e.g. `config-${slotKey(scope)}`. */
  slotName: string;
  /** The pre-hashing lossy slot name older versions wrote. */
  legacySlotName: string;
  configPath: string;
}): Promise<string> {
  const backupPath = backupPathFor(options.dataDir, options.slotName);
  const { existed } = await readJsonIfExists<unknown>(backupPath);
  if (existed) return backupPath;

  if (process.platform === "win32") return backupPath;
  const legacyPath = backupPathFor(options.dataDir, options.legacySlotName);
  const { value: legacy } = await readJsonIfExists<ConfigBackup>(
    legacyPath,
  ).catch((error: unknown) => {
    // An overlong legacy name could never have held a backup on this filesystem.
    if ((error as NodeJS.ErrnoException).code === "ENAMETOOLONG")
      return { value: undefined };
    throw error;
  });
  return snapshotOwnsConfigPath(legacy, options.configPath)
    ? legacyPath
    : backupPath;
}
