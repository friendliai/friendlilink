import { describe, expect, it } from "vitest";
import { toFriendliModel } from "../../src/friendli/model-catalog.js";

/** One live `/v1/models` entry, fields quoted exactly as Friendli sends them
 * (prices are per-token decimal strings). */
describe("friendli model catalog", () => {
  it("parses a full live entry into the normalized shape harnesses consume", () => {
    const model = toFriendliModel({
      id: "zai-org/GLM-5.3-Flash",
      name: "zai-org/GLM-5.3-Flash",
      context_length: 1048576,
      max_completion_tokens: 1048576,
      pricing: {
        input: "0.00000015",
        output: "0.0000005",
        input_cache_read: "0.00000003",
      },
      functionality: { tool_call: true },
      reasoning: true,
      reasoning_options: [
        { type: "effort", values: ["low", "high", "max"] },
        { type: "budget_tokens", min: -1, max: 1048576 },
      ],
      input_modalities: ["text", "image", "video"],
      output_modalities: ["text"],
      interleaved: "reasoning_content",
      default_params: { temperature: 1.0 },
      description: "Native multimodal GLM model",
    });

    expect(model).toEqual({
      id: "zai-org/GLM-5.3-Flash",
      label: "zai-org/GLM-5.3-Flash",
      contextLength: 1048576,
      maxCompletionTokens: 1048576,
      reasoning: true,
      reasoningEffortLevels: ["low", "high", "max"],
      pricing: { input: 0.15, output: 0.5, cacheRead: 0.03 },
      toolCall: true,
      inputModalities: ["text", "image", "video"],
      outputModalities: ["text"],
      interleaved: "reasoning_content",
      temperature: true,
      description: "Native multimodal GLM model",
    });
  });

  it("recognizes reasoning toggles separate from effort levels", () => {
    const model = toFriendliModel({
      id: "zai-org/GLM-5.2",
      reasoning_options: [
        { type: "toggle" },
        { type: "effort", values: ["high", "max"] },
      ],
    });

    expect(model).toEqual({
      id: "zai-org/GLM-5.2",
      label: "zai-org/GLM-5.2",
      reasoningToggle: true,
      reasoningEffortLevels: ["high", "max"],
    });
  });

  it("accepts the prompt/completion pricing aliases Friendli also sends", () => {
    const model = toFriendliModel({
      id: "fallback-pricing-model",
      pricing: {
        prompt: "0.00000015",
        completion: "0.0000005",
        input_cache_read: "0.00000003",
      },
    });

    expect(model.pricing).toEqual({
      input: 0.15,
      output: 0.5,
      cacheRead: 0.03,
    });
  });

  it("falls back to the id as label and omits everything Friendli didn't report", () => {
    expect(toFriendliModel({ id: "MiniMaxAI/MiniMax-M2.5" })).toEqual({
      id: "MiniMaxAI/MiniMax-M2.5",
      label: "MiniMaxAI/MiniMax-M2.5",
    });
  });
});
