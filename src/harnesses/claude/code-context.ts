const LEGACY_CLAUDE_CODE_1M_SUFFIX = /\[1m\]$/i;

/**
 * Normalize model ids saved by older FriendliLink releases. New settings
 * always store bare Friendli model ids, but stripping the legacy marker keeps
 * an old pinned value from leaking into any Claude Code model slot.
 */
export function stripLegacyClaudeCodeContextSuffix(modelId: string): string {
  return modelId.replace(LEGACY_CLAUDE_CODE_1M_SUFFIX, "");
}
