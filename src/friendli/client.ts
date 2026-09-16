import { FRIENDLI_BASE_URL, friendliApiUrl } from "./base-url.js";

export interface VerifyKeyResult {
  ok: boolean;
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
  try {
    const response = await fetch(friendliApiUrl("models", baseUrl), {
      headers: authHeaders(apiKey),
    });
    if (response.ok) {
      return { ok: true };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        message: "FriendliAI rejected this API key (unauthorized).",
      };
    }
    return {
      ok: false,
      message: `FriendliAI returned HTTP ${response.status} while verifying the key.`,
    };
  } catch (error) {
    return {
      ok: false,
      message: `Could not reach FriendliAI: ${(error as Error).message}`,
    };
  }
}

/**
 * Does Friendli actually accept this key?
 *
 * `verifyFriendliApiKey` above cannot answer that. It probes `GET /v1/models`,
 * which Friendli serves to everyone — it returns 200 with no Authorization
 * header at all — so a 200 proves the gateway is reachable and nothing about
 * the credential. This sends an authenticated request instead: a
 * `chat/completions` call carrying no messages. Auth is checked first, so a
 * valid key gets past it and is refused on the body (422) while an invalid one
 * is refused at the door (401). Inference is never reached and no tokens are
 * spent.
 *
 * Only an explicit 401 is treated as rejection. A 403, a 5xx, a DNS failure —
 * none of those prove the key is bad, and a guard that blocks a working setup
 * on a transient error is worse than the hole it closes. So the bias is
 * deliberate: this can pass a bad key through, but it will not stop a good one.
 */
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
