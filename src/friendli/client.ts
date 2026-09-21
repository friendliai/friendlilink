import { FRIENDLI_BASE_URL, friendliApiUrl } from "./base-url.js";
import { fetchFriendliModelCatalog } from "./model-catalog.js";

export interface VerifyKeyResult {
  ok: boolean;
  /** Set when ok is true but the check could not rule the key out — callers
   * warn rather than fail. Set when ok is false with the rejection reason. */
  message?: string;
}

/** Whether Friendli accepted a credential, and whether we can be sure. */
export interface CredentialCheck {
  /** False only on an explicit rejection. */
  accepted: boolean;
  /** False when the gateway never gave a verdict (offline, 5xx, ...). */
  conclusive: boolean;
  message?: string;
}

/** Bearer auth against Friendli's gateway. */
function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

export async function verifyFriendliApiKey(
  apiKey: string,
  baseUrl: string = FRIENDLI_BASE_URL,
): Promise<VerifyKeyResult> {
  let probeModel: string | undefined;
  try {
    probeModel = (await fetchFriendliModelCatalog(apiKey, baseUrl))[0]?.id;
  } catch {
    // The public catalog is best-effort — see the doc comment above.
  }
  const check = await checkFriendliCredential(
    apiKey,
    probeModel ?? "",
    baseUrl,
  );
  if (!check.accepted) {
    return check.message
      ? { ok: false, message: check.message }
      : { ok: false };
  }
  if (check.conclusive) {
    return { ok: true };
  }
  return check.message ? { ok: true, message: check.message } : { ok: true };
}

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
    if (response.status === 401) {
      return {
        accepted: false,
        conclusive: true,
        message: "FriendliAI rejected this API key (unauthorized).",
      };
    }
    // 422 is the expected pass: auth cleared, the empty `messages` refused.
    // Anything else got past auth too, but for a reason we did not predict —
    // a 403, a 5xx, a gateway in front of Friendli — so the key is let
    // through and the uncertainty is reported rather than swallowed.
    if (response.status === 422) {
      return { accepted: true, conclusive: true };
    }
    return {
      accepted: true,
      conclusive: false,
      message: `Could not confirm the API key — FriendliAI answered HTTP ${response.status} to the credential check.`,
    };
  } catch (error) {
    return {
      accepted: true,
      conclusive: false,
      message: `Could not reach FriendliAI to check the key: ${(error as Error).message}`,
    };
  }
}
