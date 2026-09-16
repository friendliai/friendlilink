import { readJsonIfExists, writeJson } from "../io/json.js";
import { stateEntry } from "./paths.js";

export interface HarnessState {
  enabled: boolean;
}

export interface GlobalConfig {
  /** "" | "{keychain:friendli-api-key}" | a legacy plaintext literal */
  apiKey: string;
  harnesses: Record<string, HarnessState>;
}

function defaultConfig(): GlobalConfig {
  return { apiKey: "", harnesses: {} };
}

export function globalConfigPath(home: string): string {
  return stateEntry(home, "config.json");
}

export async function readGlobalConfig(home: string): Promise<GlobalConfig> {
  const { value } = await readJsonIfExists<Partial<GlobalConfig>>(
    globalConfigPath(home),
  );
  return {
    ...defaultConfig(),
    ...value,
    harnesses: { ...(value?.harnesses ?? {}) },
  };
}

/** Merges `patch` onto the existing file (harness map is merged, not replaced). */
export async function writeGlobalConfig(
  home: string,
  patch: Partial<GlobalConfig>,
): Promise<GlobalConfig> {
  const current = await readGlobalConfig(home);
  const next: GlobalConfig = {
    ...current,
    ...patch,
    harnesses: { ...current.harnesses, ...(patch.harnesses ?? {}) },
  };
  // A literal (non-`{ref}`) apiKey means a real secret is about to land on
  // disk — lock the file down to owner-only.
  const hasLiteralSecret = Boolean(next.apiKey) && !next.apiKey.startsWith("{");
  await writeJson(
    globalConfigPath(home),
    next,
    hasLiteralSecret ? { mode: 0o600 } : {},
  );
  return next;
}

export async function setHarnessEnabled(
  home: string,
  harnessId: string,
  enabled: boolean,
): Promise<void> {
  const current = await readGlobalConfig(home);
  await writeGlobalConfig(home, {
    harnesses: {
      ...current.harnesses,
      [harnessId]: { ...current.harnesses[harnessId], enabled },
    },
  });
}

export async function isHarnessEnabled(
  home: string,
  harnessId: string,
): Promise<boolean> {
  const config = await readGlobalConfig(home);
  return config.harnesses[harnessId]?.enabled === true;
}
