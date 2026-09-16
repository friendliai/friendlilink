import { toFriendliModel } from "../../../src/friendli/model-catalog.js";

/** Relevant fields from the public /serverless/v1/models response, 2026-09-13.
 * Exercise the real wire parser, not hand-written normalized capabilities. */
export const catalog = [
  { id: "deepseek-ai/DeepSeek-V3.2", toggle: true },
  { id: "MiniMaxAI/MiniMax-M2.5", toggle: false },
  { id: "zai-org/GLM-5.1", toggle: true },
  { id: "google/gemma-4-31B-it", toggle: true },
  { id: "zai-org/GLM-5.3", toggle: false, effort: ["low", "high", "max"] },
].map(({ id, toggle, effort }) =>
  toFriendliModel({
    id,
    name: id,
    reasoning: true,
    reasoning_options: [
      ...(toggle ? [{ type: "toggle" }] : []),
      ...(effort ? [{ type: "effort", values: effort }] : []),
      { type: "budget_tokens", min: -1, max: 1048576 },
    ],
  }),
);

export const mapping = {
  opus: "deepseek-ai/DeepSeek-V3.2",
  sonnet: "zai-org/GLM-5.1",
  haiku: "google/gemma-4-31B-it",
  fable: "MiniMaxAI/MiniMax-M2.5",
  subagent: "zai-org/GLM-5.3",
};
