import { describe, expect, it } from "vitest";
import { claudeCodeCapabilities } from "../../../src/harnesses/claude/reasoning.js";

/** Shaped like what `GET /v1/models` reports, so the rules are exercised through
 * catalog metadata rather than model ids. */
const model = (over: Record<string, unknown> = {}) => ({
  id: "vendor/Model",
  label: "Model",
  reasoning: true,
  ...over,
});

describe("claude reasoning capabilities", () => {
  it("declares nothing for a model that does not reason", () => {
    expect(claudeCodeCapabilities(model({ reasoning: false }))).toEqual([]);
    expect(claudeCodeCapabilities({ id: "x", label: "x" })).toEqual([]);
    expect(claudeCodeCapabilities(undefined)).toEqual([]);
  });

  it("declares the effort rungs the catalog reports", () => {
    expect(
      claudeCodeCapabilities(
        model({
          reasoningEffortLevels: ["low", "high", "max", "xhigh"],
          reasoningToggle: true,
        }),
      ),
    ).toEqual([
      "thinking",
      "adaptive_thinking",
      "effort",
      "xhigh_effort",
      "max_effort",
    ]);
  });

  it("declares no effort axis when the catalog reports none", () => {
    expect(claudeCodeCapabilities(model({ reasoningToggle: true }))).toEqual([
      "thinking",
      "adaptive_thinking",
    ]);
  });

  /** `rejects_disabled_thinking` is never declared: every Friendli reasoning
   * model tested accepts `thinking: {"type": "disabled"}` on the Messages
   * surface and really turns reasoning off — with or without a catalog
   * `toggle`, which only describes the chat-completions `enable_thinking`
   * kwarg. A future model that rejects disabled thinking will need a new
   * catalog signal wired into claudeCodeCapabilities. */
  it("never declares rejects_disabled_thinking, with or without a toggle", () => {
    for (const capabilities of [
      claudeCodeCapabilities(model()),
      claudeCodeCapabilities(model({ reasoningToggle: true })),
    ]) {
      expect(capabilities).not.toContain("rejects_disabled_thinking");
    }
  });
});
