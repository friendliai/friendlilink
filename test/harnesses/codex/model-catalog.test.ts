import { describe, expect, it } from "vitest";
import {
  buildCodexCatalog,
  type CodexCatalogTemplate,
} from "../../../src/harnesses/codex/model-catalog.js";
import type { FriendliModel } from "../../../src/friendli/model-catalog.js";

const TEMPLATE: CodexCatalogTemplate = {
  base_instructions: "You are a coding agent running in the Codex CLI.",
  shell_type: "unified_exec",
  truncation_policy: { mode: "tokens", limit: 10_000 },
};

/** Shaped like what GET /v1/models reports for the real catalog. */
const MODELS: FriendliModel[] = [
  {
    id: "zai-org/GLM-5.3",
    label: "zai-org/GLM-5.3",
    reasoning: true,
    reasoningEffortLevels: ["low", "high", "max"],
    contextLength: 1_048_576,
    description: "Flagship GLM",
  },
  {
    id: "zai-org/GLM-5.2",
    label: "zai-org/GLM-5.2",
    reasoning: true,
    reasoningEffortLevels: ["high", "max"],
    reasoningToggle: true,
  },
  // Reasons, but has no effort axis at all.
  {
    id: "MiniMaxAI/MiniMax-M2.5",
    label: "MiniMaxAI/MiniMax-M2.5",
    reasoning: true,
  },
];

describe("buildCodexCatalog", () => {
  it("offers exactly Friendli's models, in catalog order", () => {
    const { models } = buildCodexCatalog(MODELS, TEMPLATE);
    expect(models.map((m) => m.slug)).toEqual([
      "zai-org/GLM-5.3",
      "zai-org/GLM-5.2",
      "MiniMaxAI/MiniMax-M2.5",
    ]);
    expect(models.map((m) => m.priority)).toEqual([1, 2, 3]);
    expect(models.every((m) => m.visibility === "list")).toBe(true);
  });

  /** The point of the feature: real rungs per model, never a generic set,
   * and off only where off is honoured. */
  it("gives each model Friendli's advertised levels, plus none where off is honoured", () => {
    const { models } = buildCodexCatalog(MODELS, TEMPLATE);
    const efforts = (slug: string) =>
      models
        .find((m) => m.slug === slug)!
        .supported_reasoning_levels.map((l) => l.effort);
    expect(efforts("zai-org/GLM-5.3")).toEqual(["low", "high", "max"]);
    // GLM-5.2 carries a toggle, so its rows end with the off level.
    expect(efforts("zai-org/GLM-5.2")).toEqual(["high", "max", "none"]);
  });

  /** `none` rides last and never becomes a default: Codex remaps an `ultra`
   * request to the first row it does not know as `ultra`, and a leading
   * `none` would switch that request's reasoning off. */
  it("offers the none level last, and only where the catalog proves a toggle", () => {
    const { models } = buildCodexCatalog(MODELS, TEMPLATE);
    const glm52 = models.find((m) => m.slug === "zai-org/GLM-5.2")!;
    const rows = glm52.supported_reasoning_levels;
    expect(rows[rows.length - 1]).toEqual({
      effort: "none",
      description: "Turn thinking off",
    });
    expect(glm52.default_reasoning_level).toBe("max");
    // No toggle, no row: GLM-5.3 would spill its chain-of-thought into the
    // answer, MiniMax would silently burn reasoning tokens.
    for (const slug of ["zai-org/GLM-5.3", "MiniMaxAI/MiniMax-M2.5"]) {
      const offered = models
        .find((m) => m.slug === slug)!
        .supported_reasoning_levels.map((l) => l.effort);
      expect(offered).not.toContain("none");
    }
    // A toggle with no rungs (GLM-5.1's shape): the on row plus the off
    // level, neither a default.
    const toggleOnly = buildCodexCatalog(
      [
        {
          id: "zai-org/GLM-5.1",
          label: "zai-org/GLM-5.1",
          reasoning: true,
          reasoningToggle: true,
        },
      ],
      TEMPLATE,
    );
    const glm51 = toggleOnly.models[0]!;
    expect(glm51.supported_reasoning_levels).toEqual([
      { effort: "medium", description: "Reasoning on (model default)" },
      { effort: "none", description: "Turn thinking off" },
    ]);
    expect(glm51.default_reasoning_level).toBeUndefined();
  });

  /** An always-reasoning model with neither dial nor switch (MiniMax): the
   * on row alone, and nothing becomes a default. */
  it("offers the on-row alone to an always-reasoning model without a dial or switch", () => {
    const { models } = buildCodexCatalog(MODELS, TEMPLATE);
    const minimax = models.find((m) => m.slug === "MiniMaxAI/MiniMax-M2.5")!;
    expect(minimax.supported_reasoning_levels).toEqual([
      { effort: "medium", description: "Reasoning on (model default)" },
    ]);
    expect(minimax.default_reasoning_level).toBeUndefined();
    // A model the catalog says cannot reason gets nothing at all.
    const flat = buildCodexCatalog(
      [{ id: "x/flat", label: "x/flat", reasoning: false }],
      TEMPLATE,
    );
    expect(flat.models[0]!.supported_reasoning_levels).toEqual([]);
  });

  it("starts at the strongest advertised rung", () => {
    const { models } = buildCodexCatalog(MODELS, TEMPLATE);
    expect(models[0]!.default_reasoning_level).toBe("max");
    const lowOnly = buildCodexCatalog(
      [
        {
          id: "m",
          label: "m",
          reasoning: true,
          reasoningEffortLevels: ["minimal", "low"],
        },
      ],
      TEMPLATE,
    );
    expect(lowOnly.models[0]!.default_reasoning_level).toBe("low");
  });

  /** codex 0.153 rejects the whole file when any entry is missing one of
   * these, and then silently falls back to its own catalog. */
  it("fills every field codex requires", () => {
    const { models } = buildCodexCatalog(MODELS, TEMPLATE);
    for (const entry of models) {
      for (const field of [
        "slug",
        "display_name",
        "supported_reasoning_levels",
        "shell_type",
        "visibility",
        "supported_in_api",
        "priority",
        "support_verbosity",
        "truncation_policy",
        "experimental_supported_tools",
        "base_instructions",
      ] as const) {
        expect(entry[field], `${entry.slug} is missing ${field}`).toBeDefined();
      }
    }
  });

  /** "freeform" makes Codex send a grammar-constrained custom tool, which
   * Friendli rejects: 422 invalid tools: custom.format type grammar. */
  it("never sets apply_patch_tool_type", () => {
    const { models } = buildCodexCatalog(MODELS, TEMPLATE);
    for (const entry of models) {
      expect(entry).not.toHaveProperty("apply_patch_tool_type");
    }
  });

  it("carries the context window through when Friendli reports one", () => {
    const { models } = buildCodexCatalog(MODELS, TEMPLATE);
    expect(models[0]!.context_window).toBe(1_048_576);
    expect(models[1]!.context_window).toBeUndefined();
  });

  /** The catalog is written next to our other bookkeeping; it must never
   * become somewhere the API key ends up. */
  it("contains no credential material", () => {
    const serialized = JSON.stringify(buildCodexCatalog(MODELS, TEMPLATE));
    expect(serialized).not.toMatch(/flp_|bearer|api[_-]?key/i);
  });

  it("produces an empty catalog for an empty model list", () => {
    expect(buildCodexCatalog([], TEMPLATE).models).toEqual([]);
  });
});
