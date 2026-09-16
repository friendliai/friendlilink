import { readFile } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBaseContext } from "../../../src/harness/types.js";
import {
  authPath,
  configPath,
  disableFriendliForOpenCode,
  enableFriendliForOpenCode,
  isFriendliManaged,
  opencodeDataDir,
  readProviderState,
} from "../../../src/harnesses/opencode/core.js";
import { opencodeAdapter } from "../../../src/harnesses/opencode/index.js";
import { writeFileAtomic } from "../../../src/io/atomic-write.js";
import { createSandboxHome, type Sandbox } from "../../helpers.js";

const MODEL = "zai-org/GLM-5.2";

// configPath()/authPath() honor XDG_CONFIG_HOME/XDG_DATA_HOME over the `home`
// they are given. CI runners export those variables, which would silently
// redirect every sandboxed path at the real (runner) config dir and break
// isolation; pin them to the sandbox for the duration of each test.
const savedXdg: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME"]) {
    savedXdg[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME"]) {
    if (savedXdg[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedXdg[key];
    }
  }
});

function context(home: string, overrides: Record<string, unknown> = {}) {
  return { ...createBaseContext(), home, ...overrides } as ReturnType<
    typeof createBaseContext
  >;
}

async function enable(sandbox: Sandbox, options: Record<string, unknown> = {}) {
  return enableFriendliForOpenCode({
    configPath: configPath(sandbox.home),
    authPath: authPath(sandbox.home),
    dataDir: opencodeDataDir(sandbox.home),
    apiKey: "test-key",
    apiKeySource: "env",
    model: MODEL,
    ...options,
  });
}

describe("opencode core", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await createSandboxHome();
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it("writes the /connect-style auth entry and pins the friendli model", async () => {
    const originalAuth =
      '{\n  "anthropic": { "type": "api", "key": "«redacted:sk-…»" }\n}\n';
    const originalConfig =
      '{\n  "$schema": "https://opencode.ai/config.json",\n  "agent": { "title": { "model": "anthropic/claude-sonnet-4-20250514" } }\n}\n';
    await writeFileAtomic(authPath(sandbox.home), originalAuth);
    await writeFileAtomic(configPath(sandbox.home), originalConfig);

    await enable(sandbox);

    const auth = JSON.parse(await readFile(authPath(sandbox.home), "utf8"));
    expect(auth.friendli).toEqual({ type: "api", key: "test-key" });
    expect(auth.anthropic).toEqual({ type: "api", key: "«redacted:sk-…»" });

    const config = JSON.parse(await readFile(configPath(sandbox.home), "utf8"));
    expect(config.model).toBe(`friendli/${MODEL}`);
    // Unrelated config keys survive verbatim.
    expect(config.$schema).toBe("https://opencode.ai/config.json");
    expect(config.agent.title.model).toBe("anthropic/claude-sonnet-4-20250514");

    expect(await isFriendliManaged(configPath(sandbox.home))).toBe(true);

    const state = await readProviderState(opencodeDataDir(sandbox.home));
    expect(state).toEqual({ apiKeySource: "env", model: MODEL });
  });

  it("merges telemetry headers into Friendli options without losing user configuration", async () => {
    await writeFileAtomic(
      configPath(sandbox.home),
      JSON.stringify({
        provider: {
          friendli: {
            customProviderOption: "keep-provider-field",
            options: {
              timeout: 3_000,
              headers: {
                "X-User-Trace": "keep-me",
                "x-title": "stale-title",
                "HTTP-REFERER": "stale-referer",
              },
            },
          },
        },
      }),
    );

    await enable(sandbox, {
      telemetryHeaders: {
        "X-Title": "OpenCode",
        "HTTP-Referer": "frlink/v0.1.0",
      },
    });

    const config = JSON.parse(await readFile(configPath(sandbox.home), "utf8"));
    expect(config.provider.friendli.customProviderOption).toBe(
      "keep-provider-field",
    );
    expect(config.provider.friendli.options.timeout).toBe(3_000);
    expect(config.provider.friendli.options.headers).toEqual({
      "X-User-Trace": "keep-me",
      "X-Title": "OpenCode",
      "HTTP-Referer": "frlink/v0.1.0",
    });
  });

  it("stores the auth file owner-only (it carries the API key literally)", async () => {
    await enable(sandbox);

    const mode = (await stat(authPath(sandbox.home))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("restores both files byte-for-byte on disable", async () => {
    const originalAuth =
      '{ "anthropic": { "type": "api", "key": "keep-me" } }\n';
    const originalConfig = '{ "custom": true }\n';
    await writeFileAtomic(authPath(sandbox.home), originalAuth);
    await writeFileAtomic(configPath(sandbox.home), originalConfig);

    await enable(sandbox);

    const outcome = await disableFriendliForOpenCode({
      configPath: configPath(sandbox.home),
      authPath: authPath(sandbox.home),
      dataDir: opencodeDataDir(sandbox.home),
    });

    expect(outcome).toBe("restored");
    expect(await readFile(authPath(sandbox.home), "utf8")).toBe(originalAuth);
    expect(await readFile(configPath(sandbox.home), "utf8")).toBe(
      originalConfig,
    );
    expect(await isFriendliManaged(configPath(sandbox.home))).toBe(false);
  });

  it("deletes files on disable that did not exist before enable", async () => {
    await enable(sandbox);

    const outcome = await disableFriendliForOpenCode({
      configPath: configPath(sandbox.home),
      authPath: authPath(sandbox.home),
      dataDir: opencodeDataDir(sandbox.home),
    });

    expect(outcome).toBe("restored");
    await expect(readFile(authPath(sandbox.home), "utf8")).rejects.toThrow();
    await expect(readFile(configPath(sandbox.home), "utf8")).rejects.toThrow();
  });

  it("preserve the user's own friendli auth on off: a re-enable never re-snapshots", async () => {
    // The user connected friendli manually via /connect before frlink.
    const originalAuth =
      '{ "friendli": { "type": "api", "key": "users-own-key" } }\n';
    await writeFileAtomic(authPath(sandbox.home), originalAuth);

    await enable(sandbox);
    await enable(sandbox); // second `on` without `off` must not re-snapshot

    await disableFriendliForOpenCode({
      configPath: configPath(sandbox.home),
      authPath: authPath(sandbox.home),
      dataDir: opencodeDataDir(sandbox.home),
    });

    // Their own manual /connect key comes back untouched.
    expect(await readFile(authPath(sandbox.home), "utf8")).toBe(originalAuth);
  });

  it("does not snapshot a config that was already routed to friendli", async () => {
    await writeFileAtomic(
      configPath(sandbox.home),
      JSON.stringify({ model: "friendli/some-other-model" }),
    );

    await enable(sandbox);

    // `on` still pins our model, but nothing was snapshotted — so a later
    // `off` cannot (and must not try to) restore the user's own routing.
    await expect(
      readFile(opencodeDataDir(sandbox.home) + "/config-backup.json", "utf8"),
    ).rejects.toThrow();

    const outcome = await disableFriendliForOpenCode({
      configPath: configPath(sandbox.home),
      authPath: authPath(sandbox.home),
      dataDir: opencodeDataDir(sandbox.home),
    });
    expect(outcome).toBe("restored"); // the auth entry we wrote was undone

    const config = JSON.parse(await readFile(configPath(sandbox.home), "utf8"));
    expect(config.model).toBe(`friendli/${MODEL}`);
  });

  it("reports an actionable error for comment-bearing config", async () => {
    await writeFileAtomic(
      configPath(sandbox.home),
      '{ "$schema": "x", // comment\n }\n',
    );
    await expect(enable(sandbox)).rejects.toThrow(
      /could not be parsed as JSON/,
    );
  });

  it("syncs Friendli's live model list into provider.friendli.models", async () => {
    await enable(sandbox, {
      models: [
        { id: "zai-org/GLM-5.3-Flash", label: "zai-org/GLM-5.3-Flash" },
        { id: "zai-org/GLM-5.2", label: "zai-org/GLM-5.2" },
      ],
    });

    const config = JSON.parse(await readFile(configPath(sandbox.home), "utf8"));
    expect(config.provider.friendli.models).toEqual({
      "zai-org/GLM-5.3-Flash": { name: "zai-org/GLM-5.3-Flash" },
      "zai-org/GLM-5.2": { name: "zai-org/GLM-5.2" },
    });
  });

  it("writes an off (and, without effort levels, an on) reasoning variant for toggle-capable models, real effort levels as reasoningEffort variants otherwise, and disables only the guessed effort keys the model doesn't really have", async () => {
    await enable(sandbox, {
      models: [
        // toggle only (e.g. GLM-5.1, gemma, DeepSeek-V3.2 today): no discrete
        // effort levels, so opencode's own id/npm guesswork either shows no
        // variant at all or (for models like gemma with no id-pattern match)
        // a low/medium/high effort selector it doesn't actually support.
        {
          id: "zai-org/GLM-5.1",
          label: "zai-org/GLM-5.1",
          reasoningToggle: true,
        },
        // toggle *and* effort (e.g. GLM-5.2): opencode's own data doesn't
        // capture the toggle today, so it never offers a way to fully turn
        // reasoning off — we add just "off" on top of its own "high"/"max".
        {
          id: "zai-org/GLM-5.2",
          label: "zai-org/GLM-5.2",
          reasoningToggle: true,
          reasoningEffortLevels: ["high", "max"],
        },
        // effort only, no toggle (e.g. GLM-5.3, GLM-5.3-Flash): opencode only
        // knows these levels from its models.dev snapshot, which lags behind
        // Friendli's catalog — ids the snapshot hasn't listed yet resolve with
        // no reasoning and no variants at all until this entry supplies them.
        {
          id: "zai-org/GLM-5.3",
          label: "zai-org/GLM-5.3",
          reasoningEffortLevels: ["low", "high", "max"],
        },
        // no reasoning support at all.
        { id: "MiniMaxAI/MiniMax-M2.5", label: "MiniMaxAI/MiniMax-M2.5" },
      ],
    });

    const config = JSON.parse(await readFile(configPath(sandbox.home), "utf8"));
    const models = config.provider.friendli.models;

    expect(models["zai-org/GLM-5.1"]).toEqual({
      name: "zai-org/GLM-5.1",
      variants: {
        off: { chat_template_kwargs: { enable_thinking: false } },
        on: { chat_template_kwargs: { enable_thinking: true } },
        low: { disabled: true },
        medium: { disabled: true },
        high: { disabled: true },
      },
    });
    expect(models["zai-org/GLM-5.2"]).toEqual({
      name: "zai-org/GLM-5.2",
      variants: {
        off: { chat_template_kwargs: { enable_thinking: false } },
        high: { reasoningEffort: "high" },
        max: { reasoningEffort: "max" },
        low: { disabled: true },
        medium: { disabled: true },
      },
    });
    expect(models["zai-org/GLM-5.3"]).toEqual({
      name: "zai-org/GLM-5.3",
      variants: {
        low: { reasoningEffort: "low" },
        high: { reasoningEffort: "high" },
        max: { reasoningEffort: "max" },
        medium: { disabled: true },
      },
    });
    expect(models["MiniMaxAI/MiniMax-M2.5"]).toEqual({
      name: "MiniMaxAI/MiniMax-M2.5",
    });
  });

  it("passes Friendli's live metadata through, so ids opencode's models.dev snapshot doesn't know yet still resolve fully", async () => {
    await enable(sandbox, {
      models: [
        // Everything Friendli's live /v1/models reports for GLM-5.3-Flash —
        // an id opencode 1.18.27's snapshot doesn't list at all, which without
        // this entry resolves with reasoning:false, no variants, zero limits
        // and zero cost.
        {
          id: "zai-org/GLM-5.3-Flash",
          label: "zai-org/GLM-5.3-Flash",
          reasoning: true,
          temperature: true,
          toolCall: true,
          contextLength: 1048576,
          maxCompletionTokens: 1048576,
          pricing: { input: 0.15, output: 0.5, cacheRead: 0.03 },
          inputModalities: ["text", "image", "video"],
          outputModalities: ["text"],
          interleaved: "reasoning_content",
          reasoningEffortLevels: ["low", "high", "max"],
        },
      ],
    });

    const config = JSON.parse(await readFile(configPath(sandbox.home), "utf8"));
    expect(config.provider.friendli.models).toEqual({
      "zai-org/GLM-5.3-Flash": {
        name: "zai-org/GLM-5.3-Flash",
        reasoning: true,
        temperature: true,
        attachment: true,
        tool_call: true,
        interleaved: "reasoning_content",
        modalities: { input: ["text", "image", "video"], output: ["text"] },
        limit: { context: 1048576, output: 1048576 },
        cost: { input: 0.15, output: 0.5, cache_read: 0.03 },
        variants: {
          low: { reasoningEffort: "low" },
          high: { reasoningEffort: "high" },
          max: { reasoningEffort: "max" },
          medium: { disabled: true },
        },
      },
    });
  });

  it("leaves provider config untouched when no model list was fetched (offline)", async () => {
    await writeFileAtomic(
      configPath(sandbox.home),
      JSON.stringify({ model: "anthropic/claude-sonnet-4-20250514" }),
    );

    await enable(sandbox, { models: [] });

    const config = JSON.parse(await readFile(configPath(sandbox.home), "utf8"));
    expect(config.provider).toBeUndefined();
  });

  it("keeps unrelated provider config and hand-added models the fresh list doesn't include", async () => {
    await writeFileAtomic(
      configPath(sandbox.home),
      JSON.stringify({
        provider: {
          friendli: {
            options: { baseURL: "https://my-custom-friendli-proxy.example" },
            models: {
              "my-org/hand-rolled-finetune": { name: "hand-rolled-finetune" },
            },
          },
        },
      }),
    );

    await enable(sandbox, {
      models: [{ id: "zai-org/GLM-5.3-Flash", label: "zai-org/GLM-5.3-Flash" }],
    });

    const config = JSON.parse(await readFile(configPath(sandbox.home), "utf8"));
    expect(config.provider.friendli.options).toEqual({
      baseURL: "https://my-custom-friendli-proxy.example",
    });
    expect(
      config.provider.friendli.models["my-org/hand-rolled-finetune"],
    ).toEqual({
      name: "hand-rolled-finetune",
    });
    expect(config.provider.friendli.models["zai-org/GLM-5.3-Flash"]).toEqual({
      name: "zai-org/GLM-5.3-Flash",
    });
  });
});

describe("opencode adapter", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await createSandboxHome();
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it("registers with the expected id and label", () => {
    expect(opencodeAdapter.id).toBe("opencode");
    expect(opencodeAdapter.label).toBe("OpenCode");
  });

  it("declares telemetry header support", () => {
    expect(opencodeAdapter.telemetryHeaders).toBe(true);
  });

  it("providerStatus follows the config's default provider", async () => {
    const ctx = context(sandbox.home, { onboardingMode: "skip" });
    expect(await opencodeAdapter.providerStatus(ctx)).toBe("default");

    await enableFriendliForOpenCode({
      configPath: configPath(sandbox.home),
      authPath: authPath(sandbox.home),
      dataDir: opencodeDataDir(sandbox.home),
      apiKey: "test-key",
      apiKeySource: "env",
      model: MODEL,
    });

    expect(await opencodeAdapter.providerStatus(ctx)).toBe("friendli");
  });
});
