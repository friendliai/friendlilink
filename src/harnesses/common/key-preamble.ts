import { verifyFriendliApiKey } from "../../friendli/client.js";
import type { HarnessContext } from "../../harness/types.js";
import {
  isLikelyFriendliKey,
  persistApiKey,
  resolveApiKey,
  type ApiKeySource,
} from "../../keys/api-key.js";

export type VerifiedKeySource = Exclude<ApiKeySource, "none">;

export interface VerifiedKey {
  key: string;
  source: VerifiedKeySource;
}

/**
 * Key-resolution preamble shared by every harness `on` flow: resolve via the
 * established precedence (--api-key flag > FRIENDLIAI_API_KEY env — legacy
 * FRIENDLI_API_KEY / FRIENDLI_TOKEN accepted as fallbacks > OS keychain),
 * sanity-check the shape, and verify a flag-supplied key against Friendli
 * (env/keychain keys are trusted as previously verified) before persisting it.
 * Throws the CLI-level error messages when no usable key exists.
 */
export async function resolveVerifiedKey(
  ctx: HarnessContext,
  baseUrl: string,
  options: {
    /** Save a `--api-key` key once it passes. Pass false when the caller runs
     * a stronger check of its own and will persist the survivor itself — the
     * verification here only proves Friendli is reachable, because it probes
     * `GET /v1/models`, which Friendli serves without a credential. */
    persistFlagKey?: boolean;
  } = {},
): Promise<VerifiedKey> {
  const resolved = await resolveApiKey({
    apiKeyFlag: ctx.apiKeyFromFlag ? ctx.apiKey : undefined,
    home: ctx.home,
  });
  // resolveApiKey reports "none" exactly when no key exists anywhere.
  if (resolved.source === "none") {
    throw new Error(
      "No FriendliAI API key found. Run `frlink login` first, or pass --api-key, or set FRIENDLIAI_API_KEY.",
    );
  }
  if (!isLikelyFriendliKey(resolved.key)) {
    throw new Error("That doesn't look like a FriendliAI API key.");
  }
  // `all on` has already verified and persisted the flag key by the time
  // adapters re-resolve it (ctx.apiKeyPreverified) — skip the redundant
  // verify+persist while still reporting the true "flag" source.
  if (resolved.source === "flag" && !ctx.apiKeyPreverified) {
    const verified = await verifyFriendliApiKey(resolved.key, baseUrl);
    if (!verified.ok) {
      throw new Error(verified.message ?? "FriendliAI rejected this API key.");
    }
    if (options.persistFlagKey !== false) {
      await persistApiKey(ctx.home, resolved.key);
    }
  }
  return { key: resolved.key, source: resolved.source };
}
