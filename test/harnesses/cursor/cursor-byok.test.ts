import { describe, expect, it } from "vitest";
import {
  modelsToHide,
  survivesOpenAiOverride,
  vendorOf,
  type CursorModelEntry,
} from "../../../src/harnesses/cursor/byok.js";

/** Shaped like real `availableDefaultModels2` entries from Cursor 3.19.19 —
 * every vendor that appears in a stock catalog, plus the two shapes that
 * carry no vendor at all. */
const CATALOG: CursorModelEntry[] = [
  {
    name: "claude-opus-5",
    vendorName: "anthropic",
    vendor: { displayName: "Anthropic" },
  },
  {
    name: "claude-haiku-4-5",
    vendorName: "anthropic",
    vendor: { displayName: "Anthropic" },
  },
  {
    name: "gemini-3.1-pro",
    vendorName: "google",
    vendor: { displayName: "Google" },
  },
  {
    name: "gpt-5.6-sol",
    vendorName: "openai",
    vendor: { displayName: "OpenAI" },
  },
  {
    name: "gpt-5.3-codex",
    vendorName: "openai",
    vendor: { displayName: "OpenAI" },
  },
  { name: "grok-4.6", vendorName: "cursor", vendor: { displayName: "Cursor" } },
  {
    name: "composer-2.5",
    vendorName: "cursor",
    vendor: { displayName: "Cursor" },
  },
  {
    name: "kimi-k3",
    vendorName: "moonshot",
    vendor: { displayName: "Moonshot" },
  },
  { name: "glm-5.2", vendorName: "zai", vendor: { displayName: "ZAI" } },
  // Cursor's router: no vendor at all, and `defaultOn`.
  { name: "auto-smart", defaultOn: true },
  {
    name: "muse-spark-1.3",
    vendorName: "meta",
    vendor: { displayName: "Meta" },
  },
  // A Friendli model Cursor has already minted an entry for.
  { name: "zai-org/GLM-5.2", isUserAdded: true },
];

const never = () => false;
const noneOwned = new Set<string>();

describe("vendorOf", () => {
  it("prefers vendorName and falls back to the vendor object", () => {
    expect(vendorOf({ name: "a", vendorName: "OpenAI" })).toBe("openai");
    expect(vendorOf({ name: "a", vendor: { displayName: "Anthropic" } })).toBe(
      "anthropic",
    );
    expect(vendorOf({ name: "a" })).toBe("");
  });
});

describe("survivesOpenAiOverride", () => {
  /** Measured against Cursor 3.19.19 with the override pointed at a capture
   * server: these answered normally and nothing reached our endpoint. */
  it("keeps the models Cursor still serves", () => {
    for (const name of [
      "claude-opus-5",
      "claude-haiku-4-5",
      "gemini-3.1-pro",
    ]) {
      expect(
        survivesOpenAiOverride(CATALOG.find((e) => e.name === name)!),
        name,
      ).toBe(true);
    }
  });

  /** Cursor's router has no vendor and kept working; it is also what a fresh
   * Cursor opens with, so hiding it would be the most disruptive possible
   * default. */
  it("keeps the vendorless default router", () => {
    expect(
      survivesOpenAiOverride({ name: "auto-smart", defaultOn: true }),
    ).toBe(true);
    // …but a vendorless entry that is not the default stays unknown, and
    // unknown still means hide.
    expect(survivesOpenAiOverride({ name: "mystery-model" })).toBe(false);
  });

  /** Two distinct failures, both unusable while `on`, both hidden.
   * openai: captured — the request reaches our endpoint with a model id
   * Friendli cannot serve. cursor/meta: refused by Cursor outright, with
   * "this model does not support custom API keys". */
  it("hides both the captured and the refused", () => {
    for (const name of [
      "gpt-5.6-sol",
      "gpt-5.3-codex",
      "grok-4.6",
      "composer-2.5",
      "muse-spark-1.3",
      "kimi-k3",
      "glm-5.2",
    ]) {
      expect(
        survivesOpenAiOverride(CATALOG.find((e) => e.name === name)!),
        name,
      ).toBe(false);
    }
  });

  /** Two signals must agree. Either one alone is a guess, and a wrong guess
   * in the "keep" direction fails every time the user picks the model. */
  it("hides a model whose vendor and name prefix disagree, both ways round", () => {
    expect(
      survivesOpenAiOverride({ name: "opus-4", vendorName: "anthropic" }),
    ).toBe(false);
    expect(
      survivesOpenAiOverride({ name: "claude-x", vendorName: "openai" }),
    ).toBe(false);
  });

  it("hides an entry with no vendor at all", () => {
    expect(survivesOpenAiOverride({ name: "auto-smart" })).toBe(false);
  });

  /** The regression test for the defect this replaces: an earlier classifier
   * consulted useClaudeKey/useGoogleKey and hid Claude models exactly when
   * the user had their own Anthropic key — the one case the OpenAI override
   * provably does not touch. The decision cannot depend on them, so there is
   * nowhere to pass them in. */
  it("decides from the entry alone, with no reference to the BYOK key flags", () => {
    expect(survivesOpenAiOverride.length).toBe(1);
  });
});

describe("modelsToHide", () => {
  const hide = (over: Partial<Parameters<typeof modelsToHide>[0]> = {}) =>
    modelsToHide({
      entries: CATALOG,
      servable: never,
      userOwned: noneOwned,
      ...over,
    });

  it("hides exactly what stops working, and nothing else", () => {
    expect(hide().sort()).toEqual(
      [
        "composer-2.5",
        "glm-5.2",
        "gpt-5.3-codex",
        "gpt-5.6-sol",
        "grok-4.6",
        "kimi-k3",
        "muse-spark-1.3",
      ].sort(),
    );
  });

  it("never hides a model Friendli can serve", () => {
    const servable = (id: string) => id === "glm-5.2";
    expect(hide({ servable })).not.toContain("glm-5.2");
  });

  it("never hides the user's own models", () => {
    expect(hide()).not.toContain("zai-org/GLM-5.2");
    expect(hide({ userOwned: new Set(["grok-4.6"]) })).not.toContain(
      "grok-4.6",
    );
  });

  it("keeps the built-ins that survive the override", () => {
    const hidden = hide();
    expect(hidden).not.toContain("claude-opus-5");
    expect(hidden).not.toContain("gemini-3.1-pro");
    expect(hidden).not.toContain("auto-smart");
  });

  it("skips Cursor's reserved picker entries", () => {
    const entries = [
      { name: "default" },
      { name: "inherit" },
      { name: "none" },
    ];
    expect(
      modelsToHide({ entries, servable: never, userOwned: noneOwned }),
    ).toEqual([]);
  });
});
