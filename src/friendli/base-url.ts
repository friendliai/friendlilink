/** Product-level Friendli Model APIs root, without an API version segment. */
export const FRIENDLI_BASE_URL = "https://api.friendli.ai/serverless";

/**
 * Accept both the service root and the legacy versioned base used by older
 * FriendliLink releases, then normalize them to one reusable root.
 */
export function normalizeFriendliBaseUrl(
  baseUrl: string = FRIENDLI_BASE_URL,
): string {
  return baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

/** Base expected by clients that append resource paths such as `/models`. */
export function friendliApiBaseUrl(
  baseUrl: string = FRIENDLI_BASE_URL,
): string {
  return `${normalizeFriendliBaseUrl(baseUrl)}/v1`;
}

/** Build a direct Friendli Model APIs URL from a resource path. */
export function friendliApiUrl(
  resourcePath: string,
  baseUrl: string = FRIENDLI_BASE_URL,
): string {
  const path = resourcePath.replace(/^\/+/, "");
  return `${friendliApiBaseUrl(baseUrl)}/${path}`;
}
