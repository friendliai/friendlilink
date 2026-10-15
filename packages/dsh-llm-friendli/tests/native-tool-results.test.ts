import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
} from "@deepseek-ai/dsh-llm-legacy";
import type { ContentBlock, ImageBlock } from "@deepseek-ai/dsh-llm-legacy";
import { FriendliAdapter } from "../src/adapter.ts";
import { serializeMessages } from "../src/serialize.ts";

const call = ToolCallId("read-image");

describe("native tool results", () => {
  it("retains text, empty output, errors and mixed user content without phantom user turns", () => {
    const messages = [
      createToolResultMessage({
        callId: call,
        content: [
          { type: "text", text: "first" },
          { type: "text", text: " second" },
        ],
        isError: false,
      }),
      createToolResultMessage({
        callId: ToolCallId("empty"),
        content: [],
        isError: false,
      }),
      createToolResultMessage({
        callId: ToolCallId("failed"),
        content: [{ type: "text", text: "permission denied" }],
        isError: true,
      }),
      createUserMessage({
        source: { kind: "user" },
        content: [
          { type: "text", text: "continue" },
          {
            type: "tool-result",
            toolCallId: ToolCallId("mixed"),
            content: [{ type: "text", text: "result" }],
          },
        ],
      }),
    ];
    expect(serializeMessages(messages)).toEqual([
      { role: "tool", tool_call_id: call, content: "first second" },
      { role: "tool", tool_call_id: "empty", content: "(no output)" },
      {
        role: "tool",
        tool_call_id: "failed",
        content: "Error: permission denied",
      },
      { role: "user", content: "continue" },
      { role: "tool", tool_call_id: "mixed", content: "result" },
    ]);
  });

  it("resolves deeply nested attachment bytes and sends images after the complete parallel result batch", async () => {
    const image = {
      type: "image",
      attachment: { attachmentId: "saved-image", mediaType: "image/png" },
    } as ImageBlock;
    const bytes = Uint8Array.from([137, 80, 78, 71]);
    const reads: unknown[] = [];
    let receivedMessages: unknown[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const received: unknown = JSON.parse(Buffer.concat(chunks).toString());
      if (
        received &&
        typeof received === "object" &&
        "messages" in received &&
        Array.isArray(received.messages)
      )
        receivedMessages = received.messages;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        'data: {"choices":[{"delta":{"content":"Image received"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as { port: number };
    const adapter = new FriendliAdapter({
      options: () => ({
        baseURL: `http://127.0.0.1:${address.port}`,
        defaults: {},
        extraHeaders: {},
        modelCacheTtlMs: 0,
      }),
      resolveApiKey: async () => "local-test-key",
      attachments: {
        readImage: async (ref) => {
          reads.push(ref);
          return { ref, data: bytes };
        },
      },
    });
    try {
      const content: ContentBlock[] = [
        { type: "text", text: "loaded" },
        { type: "tool-result", toolCallId: call, content: [image] },
      ];
      const messages = [
        createAssistantMessage({
          source: { provider: "friendli", model: "vision" },
          content: [
            {
              type: "tool-call",
              id: call,
              name: "read_image",
              arguments: "{}",
            },
            {
              type: "tool-call",
              id: ToolCallId("other"),
              name: "read_file",
              arguments: "{}",
            },
          ],
        }),
        createToolResultMessage({ callId: call, content, isError: false }),
        createToolResultMessage({
          callId: ToolCallId("other"),
          content: [{ type: "text", text: "other output" }],
          isError: false,
        }),
      ];
      const output = [];
      for await (const chunk of adapter.stream({
        provider: "friendli",
        model: "vision",
        messages,
      }))
        output.push(chunk);
      expect(reads).toEqual([image.attachment]);
      expect(receivedMessages.slice(1)).toEqual([
        { role: "tool", tool_call_id: call, content: "loaded" },
        { role: "tool", tool_call_id: "other", content: "other output" },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Images returned by the preceding tool results:",
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
              },
            },
          ],
        },
      ]);
      expect(output).not.toHaveLength(0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("rejects nested images without verified attachment bytes", () => {
    const image = {
      type: "image",
      attachment: { attachmentId: "missing", mediaType: "image/png" },
    } as ImageBlock;
    expect(() =>
      serializeMessages([
        createToolResultMessage({
          callId: call,
          content: [image],
          isError: false,
        }),
      ]),
    ).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_CONTENT" }));
  });
});
