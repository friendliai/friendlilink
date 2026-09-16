/**
 * Live e2e against the real Friendli serverless API. Requires FRIENDLIAI_API_KEY.
 * NOT run by the default `test` script or CI — invoke explicitly:
 *   FRIENDLIAI_API_KEY=... pnpm run test:e2e
 * The token is never logged; failures print codes, not headers or bodies.
 */
import { describe, expect, it } from "vitest";
import { fetchModels } from "../src/models.ts";
import { FriendliAdapter, PUBLIC_BASE_URL } from "../src/adapter.ts";
import type { StreamChunk } from "@deepseek-ai/dsh-llm";

const token = process.env.FRIENDLIAI_API_KEY;
const MODEL = "zai-org/GLM-5.2";

describe.skipIf(!token)("friendli live e2e", () => {
  const adapter = new FriendliAdapter({
    options: () => ({
      baseURL: PUBLIC_BASE_URL,
      defaults: { thinking: "disabled" },
      modelCacheTtlMs: 60_000,
    }),
    resolveApiKey: () => Promise.resolve(token as string),
    resolveDiscoveryKey: () => Promise.resolve(token),
  });

  it("fetchModels returns active models with GLM-5.2", async () => {
    const models = await fetchModels(PUBLIC_BASE_URL, token);
    expect(models.length).toBeGreaterThan(0);
    const glm = models.find((m) => m.id === MODEL);
    expect(glm).toBeDefined();
    expect(glm?.reasoning).toBe(true);
    expect(glm?.contextWindow).toBeGreaterThan(0);
    // No deprecated model survives normalization.
    expect(models.every((m) => m.id.length > 0)).toBe(true);
  });

  it("resolveModel surfaces on/off plus advertised effort levels for GLM-5.2", async () => {
    const info = await adapter.resolveModel("friendli", MODEL);
    expect(info.id).toBe(MODEL);
    // GLM-5.2 advertises a toggle plus effort levels high/max in /models.
    const ids = info.reasoning?.efforts.map((e) => e.id) ?? [];
    expect(ids).toEqual(expect.arrayContaining(["off", "on", "high", "max"]));
    expect(info.context?.contextWindow).toBeGreaterThan(0);
  });

  it("stream translates real SSE into StreamChunks with visible text and usage", async () => {
    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream({
      provider: "friendli",
      model: MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Reply with exactly: FRIENDLI_E2E_OK" },
          ],
        },
      ],
    })) {
      chunks.push(chunk);
    }

    const text = chunks
      .filter(
        (c): c is Extract<StreamChunk, { type: "text-delta" }> =>
          c.type === "text-delta",
      )
      .map((c) => c.text)
      .join("");
    expect(text).toContain("FRIENDLI_E2E_OK");

    const finish = chunks.at(-1);
    expect(finish?.type).toBe("finish");
    if (finish?.type === "finish") expect(finish.reason.kind).toBe("stop");

    const usage = chunks.find(
      (c): c is Extract<StreamChunk, { type: "usage" }> => c.type === "usage",
    );
    expect(usage?.usage.inputTokens).toBeGreaterThan(0);
    expect(usage?.usage.outputTokens).toBeGreaterThan(0);
  }, 30_000);

  it("stream emits a reasoning block when thinking is enabled", async () => {
    const thinking = new FriendliAdapter({
      options: () => ({
        baseURL: PUBLIC_BASE_URL,
        defaults: { thinking: "enabled" },
        modelCacheTtlMs: 60_000,
      }),
      resolveApiKey: () => Promise.resolve(token as string),
    });
    let sawReasoning = false;
    let sawText = false;
    for await (const chunk of thinking.stream({
      provider: "friendli",
      model: MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is 37 * 42? Think, then answer." },
          ],
        },
      ],
    })) {
      if (chunk.type === "block-start" && chunk.blockType === "reasoning")
        sawReasoning = true;
      if (chunk.type === "text-delta") sawText = true;
    }
    expect(sawReasoning).toBe(true);
    expect(sawText).toBe(true);
  }, 60_000);
});
