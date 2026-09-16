import { describe, expect, it } from "vitest";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import type { GenerateOptions, ToolSchema } from "@deepseek-ai/dsh-llm";
import { serializeRequest } from "../src/serialize.ts";

/** Minimal one-user-turn request; per-test overrides merge on top. */
function req(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: "friendli",
    model: "zai-org/GLM-5.2",
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ] as GenerateOptions["messages"],
    ...overrides,
  };
}

describe("serializeRequest reasoning wiring", () => {
  it("always requests the reasoning-content split", () => {
    const body = serializeRequest(req());
    expect(body.parse_reasoning).toBe(true);
    expect(body.include_reasoning).toBe(true);
  });

  it("sends a named effort level verbatim as reasoning_effort", () => {
    const high = serializeRequest(
      req({ reasoningEffort: ReasoningEffortId("high") }),
    );
    expect(high.reasoning_effort).toBe("high");
    expect(high.chat_template_kwargs).toBeUndefined();

    const max = serializeRequest(
      req({ reasoningEffort: ReasoningEffortId("max") }),
    );
    expect(max.reasoning_effort).toBe("max");
    expect(max.chat_template_kwargs).toBeUndefined();
  });

  it("maps the off/on toggle to enable_thinking, never reasoning_effort", () => {
    const off = serializeRequest(
      req({ reasoningEffort: ReasoningEffortId("off") }),
    );
    expect(off.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(off.reasoning_effort).toBeUndefined();

    const on = serializeRequest(
      req({ reasoningEffort: ReasoningEffortId("on") }),
    );
    expect(on.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(on.reasoning_effort).toBeUndefined();
  });

  it("falls back to the adapter thinking default when no effort is selected", () => {
    expect(
      serializeRequest(req(), { thinking: "enabled" }).chat_template_kwargs,
    ).toEqual({ enable_thinking: true });
    expect(
      serializeRequest(req(), { thinking: "disabled" }).chat_template_kwargs,
    ).toEqual({ enable_thinking: false });
    // No default, no per-request effort → leave the model's own behavior in place.
    const bare = serializeRequest(req());
    expect(bare.chat_template_kwargs).toBeUndefined();
    expect(bare.reasoning_effort).toBeUndefined();
  });

  it("forces thinking off for a session-title call regardless of effort", () => {
    const body = serializeRequest(
      req({
        purpose: "session-title",
        reasoningEffort: ReasoningEffortId("max"),
      }),
      { thinking: "enabled" },
    );
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("sends reasoning_budget:0 on the off path alongside enable_thinking:false", () => {
    const off = serializeRequest(
      req({ reasoningEffort: ReasoningEffortId("off") }),
    );
    expect(off.reasoning_budget).toBe(0);
    expect(off.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it("does not send reasoning_budget on non-off paths", () => {
    const on = serializeRequest(
      req({ reasoningEffort: ReasoningEffortId("on") }),
    );
    expect(on.reasoning_budget).toBeUndefined();

    const high = serializeRequest(
      req({ reasoningEffort: ReasoningEffortId("high") }),
    );
    expect(high.reasoning_budget).toBeUndefined();

    const bare = serializeRequest(req());
    expect(bare.reasoning_budget).toBeUndefined();
  });
});

describe("serializeRequest tool schema normalization", () => {
  /** GenerateOptions with a tool whose parameters contain nested oneOf. */
  function reqWithTool(parameters: Record<string, unknown>): GenerateOptions {
    const tool: ToolSchema = {
      name: "test-tool",
      description: "test",
      parameters,
    };
    return {
      provider: "friendli",
      model: "zai-org/GLM-5.2",
      messages: [
        { role: "user", content: [{ type: "text", text: "call it" }] },
      ] as GenerateOptions["messages"],
      tools: [tool],
    };
  }

  it("unwraps a multi-branch oneOf to its first non-null branch", () => {
    const body = serializeRequest(
      reqWithTool({
        type: "object",
        properties: {
          color: {
            oneOf: [{ type: "string" }, { type: "null" }],
            description: "pick a color",
          },
        },
      }),
    );
    const params = body.tools![0].function.parameters as Record<
      string,
      unknown
    >;
    const colorProp = (params.properties as Record<string, unknown>)
      .color as Record<string, unknown>;
    // The multi-branch oneOf should be unwrapped to the first non-null branch.
    expect(colorProp.type).toBe("string");
    expect(colorProp.description).toBe("pick a color");
    expect(colorProp.oneOf).toBeUndefined();
  });

  it("recursively normalizes a single-branch oneOf containing nested multi-branch oneOf", () => {
    // A single-branch oneOf whose branch contains a nested multi-branch oneOf.
    // Before the recursion fix, the inner oneOf survived because the outer
    // oneOf value was copied without recursion (only multi-branch oneOf entries
    // were unwrapped, and the single-branch oneOf's value was never recursed).
    // After the fix, the inner multi-branch oneOf is unwrapped to its first
    // non-null branch.
    const body = serializeRequest(
      reqWithTool({
        type: "object",
        properties: {
          nested: {
            oneOf: [
              {
                type: "object",
                properties: {
                  inner: {
                    oneOf: [{ type: "string" }, { type: "null" }],
                  },
                },
              },
            ],
          },
        },
      }),
    );
    const params = body.tools![0].function.parameters as Record<
      string,
      unknown
    >;
    // The outer single-branch oneOf is kept as-is (Friendli only rejects
    // multi-branch oneOf). Navigate through it to find the inner branch.
    const nestedProp = (params.properties as Record<string, unknown>)
      .nested as Record<string, unknown>;
    expect(Array.isArray(nestedProp.oneOf)).toBe(true);
    const outerBranch = (nestedProp.oneOf as Record<string, unknown>[])[0];
    const innerProps = (outerBranch.properties as Record<string, unknown>)
      .inner as Record<string, unknown>;
    // The inner multi-branch oneOf should be unwrapped to the first non-null
    // branch — this is the bug Copilot identified: without recursion, this
    // inner oneOf survived normalization.
    expect(innerProps.type).toBe("string");
    expect(innerProps.oneOf).toBeUndefined();
  });
});
