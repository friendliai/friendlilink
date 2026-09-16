import type { FriendliModel } from "../../friendli/model-catalog.js";

/**
 * Codex's reasoning control, mapped onto what Friendli's Responses API offers.
 *
 * Codex 0.153 speaks only the Responses wire and forwards
 * `model_reasoning_effort` as `reasoning.effort`. What can and cannot be
 * expressed there decides this whole module:
 *
 * - An effort level is passed through as the user wrote it. Friendli validates
 *   nothing, and which rungs a given model actually acts on is the gateway's
 *   business, not something to second-guess client-side. Verified 2026-09-10:
 *   a rung a model does not advertise still returns 200, and its effect is not
 *   even monotonic (GLM-5.2 advertises high+max; `minimal` produced 1536 output
 *   tokens against `high`'s 200). So there is nothing to gain from remapping a
 *   level, and a remap would silently disobey the user.
 * - Reasoning cannot be turned off the way the other harnesses do it. Their
 *   switch is `chat_template_kwargs.enable_thinking: false`: rejected as a
 *   body field (422), accepted nested inside `reasoning`, where Codex's
 *   request struct has no room for it; its other channel, `query_params`,
 *   lands in the URL. The one lever left is `reasoning.effort: "none"`, safe
 *   only behind a toggle (see below), surfaced by the picker catalog as a
 *   trailing `none` level on exactly those models (model-catalog.ts).
 *
 * Everything is derived from the live `GET /v1/models` catalog. There is no
 * model list here.
 */

/**
 * The effort values Friendli's Responses API documents, weakest to strongest.
 *
 * This is the API's vocabulary, not a per-model one: a level is accepted here
 * whether or not the chosen model advertises it, exactly as the API behaves.
 * `none` is deliberately absent — it is an off switch, handled separately, and
 * it is not part of the documented enum.
 *
 * One value is Codex's, not Friendli's: Codex rewrites its own `ultra` to
 * `medium` before sending (verified on the wire), so `ultra` is not offered.
 * `ultracode` passes through untouched.
 */
export const EFFORT_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultracode",
] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

/** What the user asked for. "off" is a request to stop reasoning entirely. */
export type EffortRequest = Effort | "off" | undefined;

/** Parse a `--reasoning` value without needing the catalog, so a typo is
 * caught before any key lookup, prompt or write. */
export function parseEffortRequest(value: string): EffortRequest {
  if (!value) {
    return undefined;
  }
  if (value === "off" || (EFFORT_LEVELS as readonly string[]).includes(value)) {
    return value as EffortRequest;
  }
  throw new Error(
    `Unknown --reasoning value: ${value}. Expected off, ${EFFORT_LEVELS.join(", ")}.`,
  );
}

export type ReasoningRationale = "unrequested" | "effort" | "off-via-none";

export interface CodexReasoning {
  /** `model_reasoning_effort`, or undefined to leave the key out entirely so
   * the model's own default applies. */
  effort?: Effort | "none";
  rationale: ReasoningRationale;
}

/** Raised when "off" cannot be honoured for the chosen model. Thrown before
 * anything is written, so `on` fails without touching the machine. */
export class ReasoningOffUnsupported extends Error {}

/**
 * Resolve what `model_reasoning_effort` should say for one model.
 *
 * The rules, in order:
 *
 * - Nothing requested: emit no key at all, so the model's own default stands.
 * - A level: emit it verbatim, whatever the model advertises.
 * - "off": emit `reasoning.effort: "none"`, but only when the catalog reports a
 *   `toggle` option for the model. That flag is the only signal in the catalog
 *   that the chat template can genuinely stop reasoning, and the difference is
 *   not cosmetic. Measured 2026-09-10 with `effort: "none"`:
 *     - toggle (GLM-5.2, GLM-5.1): reasoning stops, answer is clean.
 *     - no toggle (GLM-5.3, GLM-5.3-Flash): the chain-of-thought is emitted
 *       into the message body instead — sometimes closed by a stray
 *       `</think>`, sometimes with no marker at all. The answer is corrupt.
 *   MiniMax-M2.5 has no toggle and stays clean, but it also keeps burning
 *   reasoning tokens, so "none" buys nothing there. Refusing whenever the
 *   catalog cannot vouch for a toggle costs only that case and never corrupts.
 */
export function resolveCodexReasoning(
  /** Undefined when the model has no catalog entry — which is not the same as
   * a model that cannot stop reasoning, and must not be treated as one. */
  model: Pick<FriendliModel, "reasoningToggle"> | undefined,
  requested: EffortRequest,
  modelId: string,
): CodexReasoning {
  if (requested === undefined) {
    return { rationale: "unrequested" };
  }
  if (requested !== "off") {
    return { effort: requested, rationale: "effort" };
  }
  if (model === undefined) {
    throw new ReasoningOffUnsupported(
      `Cannot turn reasoning off for ${modelId}: FriendliAI's model catalog is unreachable, ` +
        `so there is no way to tell whether this model can stop reasoning. ` +
        `Retry, or pick an effort level instead (${EFFORT_LEVELS.join(", ")}).`,
    );
  }
  if (model.reasoningToggle !== true) {
    throw new ReasoningOffUnsupported(
      `${modelId} cannot turn reasoning off. FriendliAI's catalog reports no reasoning toggle for it, ` +
        `and over the Responses API that Codex speaks, asking anyway makes the model write its ` +
        `chain-of-thought into the answer. Pick an effort level instead ` +
        `(${EFFORT_LEVELS.join(", ")}), or drop --reasoning to use the model's default.`,
    );
  }
  return { effort: "none", rationale: "off-via-none" };
}

/** One line for `codex on`, or "" when there is nothing worth saying. */
export function reasoningNotice(resolved: CodexReasoning): string {
  switch (resolved.rationale) {
    case "off-via-none":
      return "  reasoning: off";
    case "effort":
      return `  reasoning: ${resolved.effort}`;
    default:
      return "";
  }
}
