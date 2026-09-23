import { FRIENDLI_BASE_URL, friendliApiUrl } from "./base-url.js";
import { fetchFriendliModelCatalog } from "./model-catalog.js";

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
  let probeModel: string | undefined;
  try {
    probeModel = (await fetchFriendliModelCatalog(apiKey, baseUrl))[0]?.id;
  } catch {
    // The catalog is optional. The authenticated probe still decides.
  }
  const check = await checkFriendliCredential(
    apiKey,
    probeModel ?? "",
    baseUrl,
  );
  if (!check.accepted || !check.conclusive) {
    return {
      ok: false,
      message: check.accepted
        ? "Could not verify the FriendliAI API key."
        : "FriendliAI rejected the API key.",
    };
  }
  return { ok: true };
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
