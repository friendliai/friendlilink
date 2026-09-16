import type { ClaudeSettings } from "./core.js";

/**
 * Claude Code's native WebSearch/WebFetch tools call Anthropic-hosted
 * server-side tool infrastructure that isn't reachable through a non-
 * Anthropic gateway. SendMessage currently carries an `allOf` composition
 * with multiple schemas, which Friendli's Messages API rejects before
 * inference with HTTP 422. Deny these while FriendliLink is managing this
 * config; `off` restores the original permissions block wholesale via the raw
 * snapshot, so nothing here needs an explicit "undo."
 */
const GATEWAY_INCOMPATIBLE_TOOLS = ["WebSearch", "WebFetch", "SendMessage"];

export function applyServerToolsDenyList(settings: ClaudeSettings): void {
  const deny = new Set(settings.permissions?.deny ?? []);
  for (const tool of GATEWAY_INCOMPATIBLE_TOOLS) {
    deny.add(tool);
  }
  settings.permissions = { ...settings.permissions, deny: [...deny] };
}
