import { describe, expect, it } from "vitest";
import { normalizeModel } from "../src/models.ts";
import type { WireModelEntry } from "../src/types.ts";

describe("normalizeModel", () => {
  it("normalizes a live reasoning model with a toggle capability", () => {
    const entry: WireModelEntry = {
      id: "zai-org/GLM-5.2",
      name: "zai-org/GLM-5.2",
      context_length: 1048576,
      max_completion_tokens: 1048576,
      reasoning: true,
      reasoning_options: [
        { type: "toggle" },
        { type: "effort", values: ["high", "max"] },
        { type: "budget_tokens", min: -1, max: 1048576 },
      ],
    };
    expect(normalizeModel(entry)).toEqual({
      id: "zai-org/GLM-5.2",
      name: "zai-org/GLM-5.2",
      contextWindow: 1048576,
      maxTokens: 1048576,
      reasoning: true,
      reasoningOptions: [
        { type: "toggle" },
        { type: "effort", values: ["high", "max"] },
        { type: "budget_tokens" },
      ],
    });
  });

  it("drops a deprecated entry", () => {
    expect(
      normalizeModel({ id: "old/model", deprecation_date: "2026-01-01" }),
    ).toBeUndefined();
  });

  it("drops an entry with no usable id", () => {
    expect(normalizeModel({ name: "nameless" })).toBeUndefined();
    expect(normalizeModel({ id: "" })).toBeUndefined();
  });

  it("defaults name to id and omits unusable capacities", () => {
    expect(
      normalizeModel({
        id: "x/y",
        context_length: 0,
        max_completion_tokens: -5,
      }),
    ).toEqual({
      id: "x/y",
      name: "x/y",
      reasoning: false,
      reasoningOptions: [],
    });
  });
});
