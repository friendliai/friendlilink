import path from "node:path";

/** Where this CLI keeps its own state: the global config, the plaintext key
 * fallback, and one data dir per harness holding the pre-`on` backups `off`
 * restores from. */
export const STATE_DIR = ".frlink";

/** One entry inside the state root. */
export function stateEntry(home: string, entry: string): string {
  return path.join(home, STATE_DIR, entry);
}

/** A harness's data dir: an explicit `--data-dir` wins, else the state root. */
export function harnessDataDir(
  home: string,
  harnessId: string,
  override = "",
): string {
  return override || stateEntry(home, harnessId);
}
