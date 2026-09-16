import { writeGlobalConfig } from "../config/global-config.js";
import { deleteSecret, getSecret, setSecret } from "./secret-store.js";

/** The Friendli API key's canonical env-var name — matches the
 * friendliai-provider plugin (v1.0.0+) so the same variable works for
 * frlink resolution and the plugin's dotenv read.
 * LEGACY: pre-plugin releases documented and read `FRIENDLI_API_KEY`;
 * resolve it as a fallback so an upgrade never silently loses the key. */
export const FRIENDLI_API_KEY_ENV = "FRIENDLIAI_API_KEY";

/** Fallback env-var names accepted when the canonical one is unset:
 * `FRIENDLI_API_KEY` (this CLI's pre-rename name) then `FRIENDLI_TOKEN`
 * (the name Friendli's own SDKs/docs use). Checked in order, and resolved
 * silently — an alias is a supported spelling, not something to nag about. */
export const FRIENDLI_API_KEY_ENV_ALIASES = [
  "FRIENDLI_API_KEY",
  "FRIENDLI_TOKEN",
] as const;
const KEYCHAIN_REF = "{keychain:friendli-api-key}";

/**
 * Friendli's exact API key format isn't pinned down yet — accept any
 * reasonably-sized non-whitespace token rather than guessing a prefix and
 * rejecting a real key that doesn't match. Tighten once the format is known.
 */
export function isLikelyFriendliKey(key: string): boolean {
  return key.trim().length >= 8;
}

export async function persistApiKey(
  home: string,
  apiKey: string,
): Promise<void> {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    return;
  }
  await setSecret(home, trimmed);
  await writeGlobalConfig(home, { apiKey: KEYCHAIN_REF });
}

export async function clearApiKey(home: string): Promise<void> {
  await deleteSecret(home);
  await writeGlobalConfig(home, { apiKey: "" });
}

export type ApiKeySource = "flag" | "env" | "keychain" | "none";

export interface ResolvedApiKey {
  key: string;
  source: ApiKeySource;
}

/** Precedence: --api-key flag > env (FRIENDLIAI_API_KEY, then the aliases
 * in FRIENDLI_API_KEY_ENV_ALIASES) > OS keychain / plaintext fallback. */
/** Whether the environment already supplies a key, so resolveApiKey below
 * will not reach the keychain. Kept beside it so the two cannot drift. */
export function friendliKeyInEnvironment(): boolean {
  return [FRIENDLI_API_KEY_ENV, ...FRIENDLI_API_KEY_ENV_ALIASES].some((name) =>
    Boolean(process.env[name]?.trim()),
  );
}

export async function resolveApiKey(options: {
  apiKeyFlag?: string | undefined;
  home: string;
}): Promise<ResolvedApiKey> {
  const flag = options.apiKeyFlag?.trim();
  if (flag) {
    return { key: flag, source: "flag" };
  }
  const envKey = process.env[FRIENDLI_API_KEY_ENV]?.trim();
  if (envKey) {
    return { key: envKey, source: "env" };
  }
  for (const alias of FRIENDLI_API_KEY_ENV_ALIASES) {
    const aliasKey = process.env[alias]?.trim();
    if (aliasKey) {
      return { key: aliasKey, source: "env" };
    }
  }
  const stored = await getSecret(options.home);
  if (stored) {
    return { key: stored, source: "keychain" };
  }
  return { key: "", source: "none" };
}
