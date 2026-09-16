import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  enableFriendliProvider,
  type ClaudeModelMapping,
} from "../../../src/harnesses/claude/core.js";
import { catalog, mapping } from "./catalog-fixture.js";

// Opt in with an installed binary; no accounts, API keys or model inference.
// This tests the CLI's actual picker and request builder against a fake API.
const binary = process.env.FRLINK_TEST_CLAUDE_BINARY;
interface ModelRow {
  value: string;
  displayName: string;
  resolvedModel: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
}
interface Request {
  model: string;
  thinking?: { type: string };
  output_config?: { effort?: string };
}

describe.skipIf(!binary)("installed Claude CLI compatibility", () => {
  let root: string;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("uses catalog effort metadata and mapped IDs, even with a cached Fable picker row", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "frlink-claude-cli-"));
    const requests: Request[] = [];
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      if (!req.url?.includes("/messages") || req.url.includes("count_tokens")) {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify(
            req.url?.includes("count_tokens")
              ? { input_tokens: 1 }
              : { data: [] },
          ),
        );
        return;
      }
      requests.push(body);
      // An unmapped Claude ID must fail the test, rather than be accepted by
      // an overly permissive mock (the production Friendli API returns 404).
      if (!catalog.some((model) => model.id === body.model)) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            type: "error",
            error: {
              type: "not_found_error",
              message: `Unknown model: ${body.model}`,
            },
          }),
        );
        return;
      }
      const message = {
        id: "msg_mock",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text: "OK" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
      if (!body.stream) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(message));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const events = [
        {
          type: "message_start",
          message: { ...message, content: [], stop_reason: null },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "OK" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
      ];
      for (const event of events)
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw Error("No mock port");
    const settingsPath = path.join(root, "settings.json");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    let counter = 0;
    const configure = async (
      nextMapping: ClaudeModelMapping,
      mainModel = "",
      thinkingEnabled = false,
    ) => {
      await enableFriendliProvider({
        settingsPath,
        dataDir: path.join(root, "data"),
        apiKey: "local-dummy",
        apiKeySource: "flag",
        baseUrl,
        mapping: nextMapping,
        catalog,
        mainModel,
      });
      const settings = JSON.parse(await readFile(settingsPath, "utf8"));
      settings.alwaysThinkingEnabled = thinkingEnabled;
      await writeFile(settingsPath, JSON.stringify(settings));
    };
    const run = async (
      picker: boolean,
      model?: string,
    ): Promise<ModelRow[]> => {
      const configDir = path.join(root, `cli-${counter++}`);
      await mkdir(configDir);
      await writeFile(
        path.join(configDir, ".claude.json"),
        JSON.stringify({
          additionalModelOptionsAnsweredAt: Date.now(),
          additionalModelOptionsCache: [
            {
              value: "claude-fable-5-1[1m]",
              label: "Fable",
              description: "Fable 5.1",
            },
          ],
        }),
      );
      const args = [
        "--bare",
        "--setting-sources",
        "",
        "--settings",
        settingsPath,
        "--strict-mcp-config",
        "--tools",
        "",
        "--no-session-persistence",
      ];
      if (model) args.push("--model", model);
      if (picker)
        args.push(
          "--input-format",
          "stream-json",
          "--output-format",
          "stream-json",
          "--verbose",
          "-p",
        );
      else
        args.push(
          "--system-prompt",
          "Reply OK.",
          "--effort",
          "high",
          "-p",
          "Reply OK.",
        );
      const child = spawn(binary!, args, {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          CLAUDE_CONFIG_DIR: configDir,
          ANTHROPIC_API_KEY: "local-dummy",
          ANTHROPIC_BASE_URL: baseUrl,
          DISABLE_AUTOUPDATER: "1",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
      });
      let output = "",
        error = "",
        buffer = "";
      let models: ModelRow[] | undefined;
      child.stdout.on("data", (data) => {
        output += data;
        buffer += data;
        if (!picker) return;
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          const response = JSON.parse(line);
          if (response.type === "control_response") {
            models = response.response?.response?.models;
            child.kill("SIGTERM");
          }
        }
      });
      child.stderr.on("data", (data) => {
        error += data;
      });
      if (picker)
        child.stdin.write(
          JSON.stringify({
            type: "control_request",
            request_id: "init",
            request: { subtype: "initialize" },
          }) + "\n",
        );
      else child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
      let code: number | null;
      try {
        code = await new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", resolve);
        });
      } finally {
        clearTimeout(timer);
      }
      if (picker) {
        expect(models, error || output).toBeDefined();
        return models!;
      }
      expect(code, error || output).toBe(0);
      expect(output.trim()).toBe("OK");
      return [];
    };
    try {
      await configure(mapping);
      const rows = await run(true);
      expect(rows.map((row) => row.value)).toEqual([
        "default",
        "claude-opus-5",
        "claude-sonnet-5",
        "claude-sonnet-4-6",
        "claude-fable-5",
      ]);
      expect(rows.every((row) => !row.supportsEffort)).toBe(true);
      expect(rows.some((row) => row.displayName === "Fable")).toBe(false);
      // Exercise the actual values returned by /model, not only aliases.
      for (const [index, slot] of (
        ["opus", "sonnet", "haiku", "fable"] as const
      ).entries()) {
        const row = rows[index + 1]!;
        expect(row.displayName).toBe(
          catalog.find((model) => model.id === mapping[slot])?.label,
        );
        await run(false, row.value);
        expect(requests.at(-1)?.model).toBe(mapping[slot]);
        expect(requests.at(-1)?.thinking?.type).toBe("disabled");
        expect(requests.at(-1)?.output_config?.effort).toBeUndefined();
      }
      for (const slot of [
        undefined,
        "default",
        "opus",
        "sonnet",
        "haiku",
        "fable",
      ] as const) {
        await run(false, slot);
        const request = requests.at(-1)!;
        expect(request.model).toBe(
          mapping[slot === undefined || slot === "default" ? "sonnet" : slot],
        );
        expect(request.output_config?.effort).toBeUndefined();
        expect(request.thinking?.type).toBe("disabled");
      }

      // Thinking on is adaptive for every reasoning model, including models
      // with only a toggle/budget in the catalog; no client token budget.
      await configure(mapping, "", true);
      for (const slot of [
        "default",
        "opus",
        "sonnet",
        "haiku",
        "fable",
      ] as const) {
        await run(false, slot);
        const request = requests.at(-1)!;
        expect(request.model).toBe(
          mapping[slot === "default" ? "sonnet" : slot],
        );
        expect(request.thinking, slot).toMatchObject({ type: "adaptive" });
        expect(request.thinking).not.toHaveProperty("budget_tokens");
        expect(request.output_config?.effort).toBeUndefined();
      }
      // The result must follow the model metadata, not the family slot.
      await configure(
        { ...mapping, opus: mapping.haiku, haiku: mapping.opus },
        "",
        true,
      );
      expect((await run(true)).every((row) => !row.supportsEffort)).toBe(true);
      await run(false, "haiku");
      expect(requests.at(-1)?.model).toBe(mapping.opus);
      expect(requests.at(-1)?.thinking).toMatchObject({ type: "adaptive" });
      expect(requests.at(-1)?.thinking).not.toHaveProperty("budget_tokens");

      await configure({ haiku: mapping.haiku });
      expect((await run(true)).every((row) => !row.supportsEffort)).toBe(true);
      await run(false, "default");
      expect(requests.at(-1)?.model).toBe(mapping.haiku);

      await configure({}, mapping.haiku, true);
      expect((await run(true)).every((row) => !row.supportsEffort)).toBe(true);
      await run(false, "default");
      expect(requests.at(-1)?.model).toBe(mapping.haiku);
      expect(requests.at(-1)?.output_config?.effort).toBeUndefined();
      expect(requests.at(-1)?.thinking).toMatchObject({ type: "adaptive" });
      expect(requests.at(-1)?.thinking).not.toHaveProperty("budget_tokens");

      // A later on must retain effort support for models that actually have it.
      await configure({ sonnet: mapping.subagent });
      const effortRows = await run(true);
      expect(effortRows.map((row) => row.value)).toEqual([
        "default",
        "claude-sonnet-5",
      ]);
      expect(effortRows.every((row) => row.supportsEffort)).toBe(true);
      expect(effortRows[1]?.supportedEffortLevels).toContain("max");
      expect(effortRows[1]?.supportedEffortLevels).not.toContain("xhigh");
      await run(false);
      expect(requests.at(-1)?.model).toBe(mapping.subagent);
      expect(requests.at(-1)?.output_config?.effort).toBe("high");
      await configure({ sonnet: mapping.subagent }, "", true);
      await run(false);
      expect(requests.at(-1)?.thinking).toMatchObject({ type: "adaptive" });
      expect(requests.at(-1)?.thinking).not.toHaveProperty("budget_tokens");
      expect(requests.at(-1)?.output_config?.effort).toBe("high");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 60000);
});
