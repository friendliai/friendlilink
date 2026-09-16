import type { FriendliModel } from "../../friendli/model-catalog.js";

/**
 * What frlink tells Claude Code about a Friendli model's reasoning.
 *
 * Reasoning and effort support come from the live catalog — `GET /v1/models`
 * reports each model's options. Reasoning models use the gateway's adaptive
 * thinking request format instead of a client-selected token budget. Effort
 * remains a separate catalog capability. There is no model-name allowlist.
 *
 * Slot-level `_SUPPORTED_CAPABILITIES` only works on providers such as
 * Bedrock, Vertex and Foundry. Claude Code 2.1.270 ignores it on the Anthropic
 * API transport, including a custom ANTHROPIC_BASE_URL. That transport needs
 * the scoped, signed CLAUDE_CODE_MODEL_CAPABILITIES rules below instead.
 */

/**
 * Claude Code's capability names for reasoning, and what each one claims:
 *
 * - `thinking` — the model reasons at all.
 * - `adaptive_thinking` — when enabled, send `thinking: {type: "adaptive"}`
 *   without `budget_tokens`. This is our Messages transport policy, not a
 *   claim that the catalog exposes an effort control for this model.
 * - `effort` / `xhigh_effort` / `max_effort` — it has an effort axis, and how
 *   far up it goes. Claude Code sends the level as `output_config.effort`, which
 *   Friendli honours across the whole ladder.
 *
 * `rejects_disabled_thinking` is never emitted: every Friendli reasoning model
 * tested against the live Messages surface accepts `thinking: {"type":
 * "disabled"}` and really turns reasoning off — including models without a
 * `toggle` in the catalog, whose toggle only describes the chat-completions
 * `enable_thinking` kwarg, not what Messages accepts. A future model that
 * does reject disabled thinking will need a new catalog signal wired in
 * here.
 *
 * One fidelity gap worth knowing: Claude Code's vocabulary cannot express
 * "high and max only", which is what GLM-5.2 offers, so a lower level stays
 * selectable. Friendli accepts it and the model applies whatever its template
 * does — nothing breaks, the level just may not bite.
 */
export function claudeCodeCapabilities(
  model: FriendliModel | undefined,
): string[] {
  if (!model?.reasoning) {
    return [];
  }
  const capabilities = ["thinking", "adaptive_thinking"];

  const effortLevels = model.reasoningEffortLevels ?? [];
  if (effortLevels.length > 0) capabilities.push("effort");
  if (effortLevels.includes("xhigh")) capabilities.push("xhigh_effort");
  if (effortLevels.includes("max")) capabilities.push("max_effort");

  return capabilities;
}

/** Internal Claude Code compatibility surface, verified against 2.1.270.
 * Rules match the canonical identity (after modelOverrides), without [1m].
 * Missing capabilities must be explicitly negated: omission inherits the
 * capabilities of the Claude model used as the slot's identity.
 * Keep the native-CLI integration test when changing this format. */
export function claudeCodeCapabilityRule(
  modelId: string,
  model: FriendliModel,
): string {
  // Delimiters and a trailing wildcard have syntax in this env variable.
  // Never let an arbitrary gateway id turn into a rule for another model.
  if (!modelId || /[;=,*]/.test(modelId)) return "";
  const enabled = new Set(claudeCodeCapabilities(model));
  const names = [
    "thinking",
    "effort",
    "xhigh_effort",
    "max_effort",
    "adaptive_thinking",
    "interleaved_thinking",
    "rejects_disabled_thinking",
  ];
  return `${modelId}=${names.map((name) => (enabled.has(name) ? name : `-${name}`)).join(",")}`;
}
