import * as clack from "@clack/prompts";
import type { FriendliModel } from "../../friendli/model-catalog.js";
import type { ClaudeModelMapping } from "./core.js";

const SLOTS: Array<{ key: keyof ClaudeModelMapping; label: string }> = [
  { key: "opus", label: "Opus (heaviest reasoning)" },
  { key: "sonnet", label: "Sonnet (default)" },
  { key: "haiku", label: "Haiku (fastest)" },
  { key: "fable", label: "Fable" },
  { key: "subagent", label: "Subagent" },
];

/** Single-screen "pick a model per slot" wizard. Returns null if the user cancels. */
export async function runClaudeModelOnboarding(
  models: FriendliModel[],
): Promise<ClaudeModelMapping | null> {
  clack.intro("FriendliLink — Claude Code model setup");

  if (models.length === 0) {
    clack.log.warn(
      "FriendliAI's model catalog returned no models; skipping the picker.",
    );
    clack.outro("Continuing with no model overrides.");
    return {};
  }

  const mapping: ClaudeModelMapping = {};
  for (const slot of SLOTS) {
    const choice = await clack.select({
      message: `Model for ${slot.label}:`,
      // Every slot takes a Friendli model: once `on` moves the base URL, a slot
      // left on Claude Code's own default sends an Anthropic model id to
      // Friendli, which does not serve one.
      options: models.map((model) => ({ value: model.id, label: model.label })),
    });
    if (clack.isCancel(choice)) {
      clack.cancel("Cancelled — nothing was changed.");
      return null;
    }
    mapping[slot.key] = choice;
  }

  clack.outro("Model mapping saved.");
  return mapping;
}
