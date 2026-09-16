import { describe, expect, it } from "vitest";
import { mapFinishReason, mapUsage, translate } from "../src/translate.ts";
import { DONE } from "../src/sse.ts";
import type { StreamChunk } from "@deepseek-ai/dsh-llm";

/** Feed an array of SSE data payloads through translate(). */
async function collect(payloads: string[]): Promise<StreamChunk[]> {
  async function* source(): AsyncGenerator<string> {
    for (const p of payloads) yield p;
  }
  const out: StreamChunk[] = [];
  for await (const chunk of translate(source())) out.push(chunk);
  return out;
}

const chunk = (delta: unknown, finish?: string | null): string =>
  JSON.stringify({
    choices: [
      { delta, ...(finish === undefined ? {} : { finish_reason: finish }) },
    ],
  });

describe("mapFinishReason", () => {
  it("maps known reasons", () => {
    expect(mapFinishReason("stop")).toEqual({ kind: "stop" });
    expect(mapFinishReason("tool_calls")).toEqual({ kind: "tool-calls" });
    expect(mapFinishReason("length")).toEqual({ kind: "max-tokens" });
  });
  it("maps unknown reasons to an error finish", () => {
    expect(mapFinishReason("content_filter")).toEqual({
      kind: "error",
      failure: {
        message: "model stopped: content_filter",
        code: "CONTENT_FILTER",
      },
    });
  });
});

describe("mapUsage", () => {
  it("subtracts cached tokens out of inputTokens (disjoint counts)", () => {
    expect(
      mapUsage({
        prompt_tokens: 100,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 30 },
        completion_tokens_details: { reasoning_tokens: 20 },
      }),
    ).toEqual({
      inputTokens: 70,
      outputTokens: 50,
      cacheReadTokens: 30,
      reasoningTokens: 20,
    });
  });
  it("omits cache/reasoning when absent", () => {
    expect(mapUsage({ prompt_tokens: 10, completion_tokens: 5 })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
    });
  });
});

describe("translate", () => {
  it("emits text block-start/delta/end then finish", async () => {
    const out = await collect([
      chunk({ content: "Hello" }),
      chunk({ content: " world" }),
      chunk({}, "stop"),
      DONE,
    ]);
    expect(out).toEqual([
      { type: "block-start", index: 0, blockType: "text" },
      { type: "text-delta", index: 0, text: "Hello" },
      { type: "text-delta", index: 0, text: " world" },
      {
        type: "block-end",
        index: 0,
        block: { type: "text", text: "Hello world" },
      },
      { type: "finish", reason: { kind: "stop" } },
    ]);
  });

  it("opens a reasoning block before text and ignores an empty first reasoning delta", async () => {
    const out = await collect([
      chunk({ reasoning_content: "" }),
      chunk({ reasoning_content: "think" }),
      chunk({ content: "answer" }),
      chunk({}, "stop"),
      DONE,
    ]);
    expect(out.map((c) => c.type)).toEqual([
      "block-start",
      "reasoning-delta",
      "block-start",
      "text-delta",
      "block-end",
      "block-end",
      "finish",
    ]);
    expect(out[0]).toEqual({
      type: "block-start",
      index: 0,
      blockType: "reasoning",
    });
    expect(out[2]).toEqual({
      type: "block-start",
      index: 1,
      blockType: "text",
    });
  });

  it("assembles a streamed tool call", async () => {
    const out = await collect([
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call-1",
            function: { name: "bash", arguments: '{"cmd":' },
          },
        ],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] }),
      chunk({}, "tool_calls"),
      DONE,
    ]);
    expect(out.at(-2)).toEqual({
      type: "block-end",
      index: 0,
      block: {
        type: "tool-call",
        id: "call-1",
        name: "bash",
        arguments: '{"cmd":"ls"}',
      },
    });
    expect(out.at(-1)).toEqual({
      type: "finish",
      reason: { kind: "tool-calls" },
    });
  });

  it("reports a trailing usage-only chunk", async () => {
    const out = await collect([
      chunk({ content: "hi" }),
      chunk({}, "stop"),
      JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }),
      DONE,
    ]);
    expect(out.at(-2)).toEqual({
      type: "usage",
      usage: { inputTokens: 5, outputTokens: 2 },
    });
    expect(out.at(-1)).toEqual({ type: "finish", reason: { kind: "stop" } });
  });

  it("maps a stop finish with no content to an EMPTY_RESPONSE error", async () => {
    const out = await collect([chunk({}, "stop"), DONE]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "finish", reason: { kind: "error" } });
  });

  it("throws on malformed JSON", async () => {
    await expect(collect(["not json", DONE])).rejects.toThrow(
      /malformed SSE payload/,
    );
  });
});
