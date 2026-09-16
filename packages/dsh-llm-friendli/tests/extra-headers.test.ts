/**
 * extraHeaders reach the wire: config-provided headers are merged into every
 * provider request after the attribution set, so per-name config values win.
 */
import { describe, expect, it, vi } from "vitest";
import { FriendliAdapter } from "../src/adapter.ts";
import { attributionHeaders } from "@deepseek-ai/dsh-llm";

const extraHeaders = {
  "X-Title": "DeepSeek Harness",
  "HTTP-Referer": "friendlilink/v0.1.0",
};

const adapter = new FriendliAdapter({
  options: () => ({
    baseURL: "https://api.example.test/serverless/v1",
    defaults: {},
    modelCacheTtlMs: 60_000,
    extraHeaders,
  }),
  resolveApiKey: () => Promise.resolve("test-key"),
});

describe("extraHeaders on the wire", () => {
  it("merges config extraHeaders after the attribution headers", async () => {
    const fetchMock = vi.fn(
      async (_url: unknown, init?: { headers?: unknown }) =>
        new Response(
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    try {
      const chunks: unknown[] = [];
      for await (const chunk of adapter.stream({
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      } as never)) {
        chunks.push(chunk);
      }
      const headers = fetchMock.mock.calls[0]![1]!.headers as Record<
        string,
        string
      >;
      expect(headers["X-Title"]).toBe("DeepSeek Harness");
      expect(headers["HTTP-Referer"]).toBe("friendlilink/v0.1.0");
      expect(headers["user-agent"]).toBe(attributionHeaders()["user-agent"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
