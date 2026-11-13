import { FRIENDLI_BASE_URL, friendliApiUrl } from "./base-url.js";
import { fetchFriendliModelCatalog } from "./model-catalog.js";

/**
 * Probe model when the catalog can't supply a live one. If Friendli retires
 * it, the probe gets a 404, which stays inconclusive: login reports "could
 * not confirm" instead of accepting the key. Update it then.
 */
export const PROBE_FALLBACK_MODEL = "zai-org/GLM-5.3";

/** Per-attempt limit on the catalog fetch, so a server that never answers
 * can't stall login (twice, with the retry). */
const CATALOG_TIMEOUT_MS = 5_000;

export interface VerifyKeyResult {
  ok: boolean;
  /** Message for a rejected or inconclusive check. */
  message?: string;
}

/** Result of one authenticated credential probe. */
export interface CredentialCheck {
  /** True when the response did not reject the key. */
  accepted: boolean;
  /** True when the response gives a definite auth result. */
  conclusive: boolean;
  message?: string;
}

/** Bearer auth against Friendli's gateway. */
function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

/**
 * Check a key before saving it.
 *
 * The model catalog provides a probe model. The empty chat request checks auth
 * before request validation and does not generate tokens.
 */
export async function verifyFriendliApiKey(
  apiKey: string,
  baseUrl: string = FRIENDLI_BASE_URL,
): Promise<VerifyKeyResult> {
  // Never probe with an empty model: Friendli answers it with 404 even for a
  // valid key, and a 404 can't be told apart from a wrong base URL. A real
  // model keeps a valid key on the 422 path.
  const check = await checkFriendliCredential(
    apiKey,
    (await liveCatalogModel(apiKey, baseUrl)) ?? PROBE_FALLBACK_MODEL,
    baseUrl,
  );
  if (!check.accepted || !check.conclusive) {
    return {
      ok: false,
      message: check.accepted
        ? (check.message ?? "Could not verify the FriendliAI API key.")
        : "FriendliAI rejected the API key.",
    };
  }
  return { ok: true };
}

/** A live model id from the catalog, retried once so a transient failure
 * doesn't push the probe onto the fixed fallback. */
async function liveCatalogModel(
  apiKey: string,
  baseUrl: string,
): Promise<string | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const catalog = await fetchFriendliModelCatalog(
        apiKey,
        baseUrl,
        AbortSignal.timeout(CATALOG_TIMEOUT_MS),
      );
      const id = catalog[0]?.id;
      if (id) return id;
    } catch {
      // The catalog is optional. The authenticated probe still decides.
    }
  }
  return undefined;
}

/** Probe a key without generating a completion. */
export async function checkFriendliCredential(
  apiKey: string,
  modelId: string,
  baseUrl: string = FRIENDLI_BASE_URL,
): Promise<CredentialCheck> {
  try {
    const response = await fetch(friendliApiUrl("chat/completions", baseUrl), {
      method: "POST",
      headers: { ...authHeaders(apiKey), "content-type": "application/json" },
      body: JSON.stringify({ model: modelId, messages: [] }),
    });
    if (response.status === 401 || response.status === 403) {
      return {
        accepted: false,
        conclusive: true,
        message: "FriendliAI rejected this API key (unauthorized).",
      };
    }
    // 422 means auth passed and empty messages were rejected.
    if (response.status === 422) {
      return { accepted: true, conclusive: true };
    }
    // Other responses do not prove that the key works.
    return {
      accepted: true,
      conclusive: false,
      message: `Could not confirm the API key. FriendliAI answered HTTP ${response.status} to the credential check.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      accepted: true,
      conclusive: false,
      message: `Could not reach FriendliAI to check the key: ${message}`,
    };
  }
}
