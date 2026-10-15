import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as current from "@deepseek-ai/dsh-llm";
import * as next from "@deepseek-ai/dsh-llm-next";
import * as legacy from "@deepseek-ai/dsh-llm-legacy";
import { FriendliAdapter, PUBLIC_BASE_URL } from "../src/adapter.ts";

const token = process.env.FRIENDLIAI_API_KEY;
// Genuine 128x128 solid-blue PNG; native video is not representable in DSH.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAABcUlEQVR4nO3UwQkAMAwDsey/dDuGHmfQAIdDe3dv6AI7AF5gB9gB9AR7AX6FfUFdviDOF8T5gjhfEOcL4nxBnC+I8wVxviDOF8T5gjhfEOcL4nxBnC+I8wVxviDOF8T5gjhfEOcL4nxBnC+I8wVxviDOF8T5gjhfEOcL4nxBnC+I8wVxviDOF8T5gjhfEOcL4nxBnC+I8wVxviDOF8T5gjhfEOcL4nxBnC+I8wVxviDOF8T5gjhfEOcL4nxBnC+I8wVxviDOF8T5gjhfEOcL4nxBnC+I8wVxviDOF8T5gjhfEOcL4nxBnC+I8wVxviDOF8T5gjhfEOcL4nxBnC+I8wVxviDOF8T5gjhfEOcL4nxBnC+I8wVxviDOF8T5gjhfEOcL4nxBnC+I8wVxviDOF8T5gjhfEOcL4nxBnC+I8wVxviDOF8T5gjhfEOcL4nxBnC+I8wVxviDOF8T5gjhfEOcL4nxBnC+I8wVxviDOF7yyD5jow7LduQJbAAAAAElFTkSuQmCC",
  "base64",
);

for (const [version, protocol] of [
  ["0.1.2-rc.1", legacy],
  ["0.2.0-rc.2", next],
  ["0.2.1-alpha.3", current],
] as const) {
  describe.skipIf(!token)(`real Friendli native ${version}`, () => {
    it("transports native text and tool-returned image bytes", async () => {
      const home = await mkdtemp(join(tmpdir(), "friendli-dsh-native-"));
      const imagePath = join(home, "blue.png");
      await writeFile(imagePath, png, { mode: 0o600 });
      const digest = createHash("sha256").update(png).digest("hex");
      let reads = 0;
      const adapter = new FriendliAdapter({
        options: () => ({
          baseURL: PUBLIC_BASE_URL,
          defaults: { thinking: "disabled" },
          extraHeaders: {},
          modelCacheTtlMs: 0,
        }),
        resolveApiKey: async () => token!,
        attachments: {
          readImage: async (ref) => {
            const data = await readFile(imagePath);
            expect(
              `sha256:${createHash("sha256").update(data).digest("hex")}`,
            ).toBe(ref.attachmentId);
            reads++;
            return { ref, data };
          },
        },
      });
      try {
        const model = "zai-org/GLM-5.3-Flash";
        const callId = protocol.ToolCallId("read-blue-image");
        const messages = [
          protocol.createUserMessage({
            source: { kind: "user" },
            content: [
              {
                type: "text",
                text: "Use read_image, then name the dominant color of the returned image in one word.",
              },
            ],
          }),
          protocol.createAssistantMessage({
            source: { provider: "friendli", model },
            content: [
              {
                type: "tool-call",
                id: callId,
                name: "read_image",
                arguments: "{}",
              },
            ],
          }),
          protocol.createToolResultMessage({
            callId,
            content: [
              {
                type: "image",
                attachment: {
                  attachmentId: `sha256:${digest}`,
                  mediaType: "image/png",
                  bytes: png.length,
                  width: 128,
                  height: 128,
                },
              },
            ],
            isError: false,
          }),
        ];
        let text = "";
        for await (const chunk of adapter.stream({
          provider: "friendli",
          model,
          messages,
          reasoningEffort: protocol.ReasoningEffortId("off"),
          maxTokens: 128,
          tools: [
            {
              name: "read_image",
              description: "Return the image",
              parameters: { type: "object", properties: {} },
            },
          ],
        }))
          if (chunk.type === "text-delta") text += chunk.text;
        expect(reads).toBe(1);
        expect(text.toLowerCase()).toContain("blue");
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    }, 90_000);
  });
}
