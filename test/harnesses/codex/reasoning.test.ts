import { describe, expect, it } from "vitest";
import {
  EFFORT_LEVELS,
  parseEffortRequest,
  reasoningNotice,
  resolveCodexReasoning,
  ReasoningOffUnsupported,
} from "../../../src/harnesses/codex/reasoning.js";

/** Shaped like what GET /v1/models reports, so the rules are exercised through
 * catalog metadata rather than model ids. */
const TOGGLE = { reasoningToggle: true };
const NO_TOGGLE = { reasoningToggle: false };
/** A catalog entry that simply never mentioned a toggle — same meaning as a
 * stated absent one, and the shape the live catalog actually returns. */
const UNSTATED = {};

describe("parseEffortRequest", () => {
  it("accepts every level Friendli's Responses API documents", () => {
    for (const level of EFFORT_LEVELS) {
      expect(parseEffortRequest(level)).toBe(level);
    }
  });

  /** Friendli documents this rung and Codex forwards it untouched; leaving it
   * out made the strongest level unreachable. */
  it("accepts ultracode", () => {
    expect(parseEffortRequest("ultracode")).toBe("ultracode");
  });

  it("accepts off, and treats an empty flag as unset", () => {
    expect(parseEffortRequest("off")).toBe("off");
    expect(parseEffortRequest("")).toBeUndefined();
  });

  it("rejects anything else, naming what is accepted", () => {
    expect(() => parseEffortRequest("banana")).toThrow(
      /Unknown --reasoning value: banana/,
    );
    expect(() => parseEffortRequest("banana")).toThrow(/ultracode/);
  });

  /** Codex rewrites its own `ultra` to `medium` before sending, so offering it
   * would promise a level the user never gets. */
  it("rejects Codex's `ultra`, which never reaches the wire intact", () => {
    expect(() => parseEffortRequest("ultra")).toThrow(
      /Unknown --reasoning value/,
    );
  });
});

describe("resolveCodexReasoning", () => {
  it("emits no key at all when nothing was requested", () => {
    expect(resolveCodexReasoning(TOGGLE, undefined, "m")).toEqual({
      rationale: "unrequested",
    });
    // No catalog entry is fine here — an unrequested effort needs no metadata.
    expect(resolveCodexReasoning(undefined, undefined, "m")).toEqual({
      rationale: "unrequested",
    });
  });

  /** Friendli validates nothing and the effect of an unadvertised rung is not
   * even monotonic, so there is nothing to gain from remapping the user's
   * choice — and a remap would silently disobey them. */
  it("passes a level through verbatim, whatever the model advertises", () => {
    for (const level of EFFORT_LEVELS) {
      expect(resolveCodexReasoning(NO_TOGGLE, level, "m")).toEqual({
        effort: level,
        rationale: "effort",
      });
      expect(resolveCodexReasoning(UNSTATED, level, "m")).toEqual({
        effort: level,
        rationale: "effort",
      });
    }
  });

  it("passes a level through with no catalog entry at all", () => {
    expect(resolveCodexReasoning(undefined, "max", "m")).toEqual({
      effort: "max",
      rationale: "effort",
    });
  });

  it("turns reasoning off with none when the catalog reports a toggle", () => {
    expect(resolveCodexReasoning(TOGGLE, "off", "zai-org/GLM-5.2")).toEqual({
      effort: "none",
      rationale: "off-via-none",
    });
  });

  /** Without a toggle, `effort: "none"` makes the model write its
   * chain-of-thought into the answer (measured on GLM-5.3 / GLM-5.3-Flash),
   * so it is refused rather than silently corrupting the output. */
  it("refuses off when the catalog reports no toggle", () => {
    expect(() =>
      resolveCodexReasoning(NO_TOGGLE, "off", "zai-org/GLM-5.3"),
    ).toThrow(ReasoningOffUnsupported);
    expect(() =>
      resolveCodexReasoning(NO_TOGGLE, "off", "zai-org/GLM-5.3"),
    ).toThrow(/zai-org\/GLM-5\.3 cannot turn reasoning off/);
    // "not stated" and "stated absent" mean the same thing to the catalog.
    expect(() => resolveCodexReasoning(UNSTATED, "off", "m")).toThrow(
      ReasoningOffUnsupported,
    );
  });

  /** An unreachable catalog is not evidence of a toggle, and guessing wrong
   * here corrupts output — so it refuses instead. */
  it("refuses off when there is no catalog entry to vouch for a toggle", () => {
    expect(() => resolveCodexReasoning(undefined, "off", "m")).toThrow(
      ReasoningOffUnsupported,
    );
    expect(() => resolveCodexReasoning(undefined, "off", "m")).toThrow(
      /catalog is unreachable/,
    );
  });

  /** The invariant that matters: "none" never goes out without a toggle
   * behind it, and nothing else is ever rewritten. */
  it("only ever emits none behind a toggle, and never alters a level", () => {
    for (const toggle of [true, false, undefined]) {
      const model = toggle === undefined ? {} : { reasoningToggle: toggle };
      for (const request of [...EFFORT_LEVELS, "off", undefined] as const) {
        let resolved;
        try {
          resolved = resolveCodexReasoning(model, request, "m");
        } catch (error) {
          expect(error).toBeInstanceOf(ReasoningOffUnsupported);
          expect(request).toBe("off");
          expect(toggle).not.toBe(true);
          continue;
        }
        if (resolved.effort === "none") {
          expect(request).toBe("off");
          expect(toggle).toBe(true);
        } else if (resolved.effort !== undefined) {
          expect(resolved.effort).toBe(request);
        } else {
          expect(request).toBeUndefined();
        }
      }
    }
  });
});

describe("reasoningNotice", () => {
  it("stays silent when no effort was requested", () => {
    expect(reasoningNotice({ rationale: "unrequested" })).toBe("");
  });

  it("reports the level that was written", () => {
    expect(reasoningNotice({ effort: "high", rationale: "effort" })).toBe(
      "  reasoning: high",
    );
    expect(reasoningNotice({ effort: "none", rationale: "off-via-none" })).toBe(
      "  reasoning: off",
    );
  });
});
