import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import * as current from "@deepseek-ai/dsh-llm";
import * as next from "@deepseek-ai/dsh-llm-next";
import type { ImageBlock } from "@deepseek-ai/dsh-llm";
import { FriendliAdapter } from "../src/adapter.ts";
import { serializeMessages } from "../src/serialize.ts";

for (const [version, protocol] of [
  ["0.2.0-rc.2", next],
  ["0.2.1-alpha.3", current],
] as const) {
  describe(`native ${version} protocol`, () => {
    it("serializes first-class tool results, errors, and one-shot request inputs", () => {
      const callId = protocol.ToolCallId("lookup");
      expect(
        serializeMessages([
          protocol.createToolResultMessage({
            callId,
            content: [
              { type: "text", text: "first" },
              { type: "text", text: " second" },
            ],
            isError: false,
          }),
          protocol.createToolResultMessage({
            callId: protocol.ToolCallId("empty"),
            content: [],
            isError: false,
          }),
          protocol.createToolResultMessage({
            callId: protocol.ToolCallId("failed"),
            content: [{ type: "text", text: "denied" }],
            isError: true,
          }),
          { role: "user", content: [{ type: "text", text: "continue" }] },
        ]),
      ).toEqual([
        { role: "tool", tool_call_id: "lookup", content: "first second" },
        { role: "tool", tool_call_id: "empty", content: "(no output)" },
        { role: "tool", tool_call_id: "failed", content: "Error: denied" },
        { role: "user", content: "continue" },
      ]);
    });

    it("rejects developer tool updates instead of turning them into user instructions", () => {
      const update = protocol.createDeveloperMessage({
        source: { kind: "user" },
        content: [{ type: "tool-removal", toolName: "lookup" }],
      });
      expect(() => serializeMessages([update])).toThrowError(
        expect.objectContaining({ code: "UNSUPPORTED_TOOL_UPDATE" }),
      );
    });

    it("demonstrates that upstream projects even video files to text before dispatch", () => {
      const file = protocol.createUserMessage({
        source: { kind: "user" },
        content: [
          {
            type: "file",
            attachment: {
              attachmentId: "sha256:0123456789abcdef",
              name: "clip.mp4",
              bytes: 100,
            },
          },
        ],
      });
      const projected = protocol.projectFilesToText(
        [file],
        () => "/saved/clip.mp4",
      );
      expect(projected[0]?.content[0]?.type).toBe("text");
      expect(serializeMessages(projected)).toEqual([
        {
          role: "user",
          content: expect.stringContaining("/saved/clip.mp4"),
        },
      ]);
      // Bypassing request assembly must not masquerade a generic file as video.
      expect(() => serializeMessages([file])).toThrowError(
        expect.objectContaining({ code: "UNSUPPORTED_CONTENT" }),
      );
    });

    it("reads first-class tool image attachments and keeps parallel results contiguous over HTTP", async () => {
      const image = {
        type: "image",
        attachment: { attachmentId: "saved-image", mediaType: "image/png" },
      } as ImageBlock;
      const bytes = Uint8Array.from([137, 80, 78, 71]);
      const reads: unknown[] = [];
      let received: unknown;
      const server = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        received = JSON.parse(Buffer.concat(chunks).toString());
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          'data: {"choices":[{"delta":{"content":"received"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        );
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const { port } = server.address() as { port: number };
      const adapter = new FriendliAdapter({
        options: () => ({
          baseURL: `http://127.0.0.1:${port}`,
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
        const callId = protocol.ToolCallId("image");
        const otherId = protocol.ToolCallId("other");
        const messages = [
          protocol.createAssistantMessage({
            source: { provider: "friendli", model: "vision" },
            content: [
              {
                type: "tool-call",
                id: callId,
                name: "read_image",
                arguments: "{}",
              },
              {
                type: "tool-call",
                id: otherId,
                name: "read_file",
                arguments: "{}",
              },
            ],
          }),
          protocol.createToolResultMessage({
            callId,
            content: [{ type: "text", text: "loaded" }, image],
            isError: false,
          }),
          protocol.createToolResultMessage({
            callId: otherId,
            content: [{ type: "text", text: "other" }],
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
        expect(received).toMatchObject({
          messages: [
            {
              role: "assistant",
              tool_calls: [{ id: "image" }, { id: "other" }],
            },
            { role: "tool", tool_call_id: "image", content: "loaded" },
            { role: "tool", tool_call_id: "other", content: "other" },
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
          ],
        });
        expect(output).not.toHaveLength(0);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
  });
}
