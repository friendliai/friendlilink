import { describe, expect, it, vi } from "vitest";
import { FriendliAdapter } from "../src/adapter.ts";
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
      input_modalities: ["text"],
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
      inputModalities: ["text"],
      reasoningOptions: [
        { type: "toggle" },
        { type: "effort", values: ["high", "max"] },
        { type: "budget_tokens" },
      ],
    });
  });

  it("uses catalog image capability without advertising unsupported video", () => {
    expect(
      normalizeModel({
        id: "zai-org/GLM-5.3-Flash",
        input_modalities: ["text", "image", "video"],
      })?.inputModalities,
    ).toEqual(["text", "image"]);
    expect(
      normalizeModel({ id: "text-only", input_modalities: ["text"] })
        ?.inputModalities,
    ).toEqual(["text"]);
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
      inputModalities: ["text"],
    });
  });

  it("exposes discovered image capability in both model selection and resolution", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: [
            {
              id: "zai-org/GLM-5.3-Flash",
              input_modalities: ["text", "image", "video"],
            },
            { id: "zai-org/GLM-5.2", input_modalities: ["text"] },
          ],
        }),
      ),
    );
    try {
      const adapter = new FriendliAdapter({
        options: () => ({
          baseURL: "https://api.example.test/serverless/v1",
          defaults: {},
          modelCacheTtlMs: 60_000,
          extraHeaders: {},
        }),
        resolveApiKey: async () => "unused",
      });
      const models = await adapter.listModels("friendli");
      expect(models.map((model) => [model.id, model.inputModalities])).toEqual([
        ["zai-org/GLM-5.3-Flash", ["text", "image"]],
        ["zai-org/GLM-5.2", ["text"]],
      ]);
      expect(
        (await adapter.resolveModel("friendli", "zai-org/GLM-5.3-Flash"))
          .inputModalities,
      ).toEqual(["text", "image"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
