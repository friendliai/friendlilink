import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildFriendliProviderEnv,
  claudeDataDir,
  disableFriendliProvider,
  enableFriendliProvider,
  friendliBaseUrl,
  isFriendliManaged,
  slotModelOverrides,
  userSettingsPath,
} from "../../../src/harnesses/claude/core.js";
import { writeFileAtomic } from "../../../src/io/atomic-write.js";
import { createSandboxHome, type Sandbox } from "../../helpers.js";

describe("claude core", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await createSandboxHome();
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it("writes the Friendli env block and marks the config as managed", async () => {
    const settingsPath = userSettingsPath(sandbox.home);
    const dataDir = claudeDataDir(sandbox.home);

    const result = await enableFriendliProvider({
      settingsPath,
      dataDir,
      apiKey: "test-key",
      apiKeySource: "env",
      baseUrl: "https://example.invalid/anthropic",
      mainModel: "",
      mapping: { sonnet: "sonnet-1" },
    });

    expect(result.mapping).toEqual({ sonnet: "sonnet-1" });
    expect(await isFriendliManaged(settingsPath)).toBe(true);

    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(settings.env.ANTHROPIC_BASE_URL).toBe(
      "https://example.invalid/anthropic",
    );
    expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe("test-key");
    // No catalog, so no declared window — the [1m]-variant suppressor is only
    // written alongside a window that stays within Claude Code's 200k default.
    expect(settings.env.CLAUDE_CODE_DISABLE_1M_CONTEXT).toBeUndefined();
    // No version pin is in force, so Claude Code keeps auto-updating.
    expect(settings.env.DISABLE_AUTOUPDATER).toBeUndefined();
    // The slot env names the Claude id; the Friendli id rides in modelOverrides.
    expect(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-5");
    expect(settings.modelOverrides["claude-sonnet-5"]).toBe("sonnet-1");
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining(["WebSearch", "WebFetch", "SendMessage"]),
    );
  });

  it("writes telemetry header lines on re-enable while preserving unrelated custom headers", async () => {
    const settingsPath = userSettingsPath(sandbox.home);
    const dataDir = claudeDataDir(sandbox.home);
    await writeFileAtomic(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_CUSTOM_HEADERS: [
            "User-Agent: claude-cli/2.1.19",
            "X-User-Trace: keep",
            "x-title: stale-title",
            "HTTP-REFERER: https://example.invalid/stale",
          ].join("\n"),
        },
      }),
    );

    const common = {
      settingsPath,
      dataDir,
      apiKey: "test-key",
      apiKeySource: "env" as const,
      baseUrl: "https://example.invalid/anthropic",
      mainModel: "",
      mapping: {},
    };

    await enableFriendliProvider({
      ...common,
      telemetryHeaders: {
        "X-Title": "Claude Code",
        "HTTP-Referer": "frlink/v0.1.0",
      },
    });
    await enableFriendliProvider({
      ...common,
      telemetryHeaders: {
        "X-Title": "Claude Code",
        "HTTP-Referer": "frlink/v0.1.0",
      },
    });

    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(settings.env.ANTHROPIC_CUSTOM_HEADERS).toBe(
      [
        "X-Title: Claude Code",
        "HTTP-Referer: frlink/v0.1.0",
        "User-Agent: claude-cli/2.1.19",
        "X-User-Trace: keep",
      ].join("\n"),
    );
  });

  it("drops the no-op CLAUDE_AUTO_UPDATE key written by earlier releases", async () => {
    const settingsPath = userSettingsPath(sandbox.home);
    const dataDir = claudeDataDir(sandbox.home);
    await writeFileAtomic(
      settingsPath,
      '{\n  "env": { "CLAUDE_AUTO_UPDATE": "0", "MY_VAR": "keep" } }\n',
    );

    await enableFriendliProvider({
      settingsPath,
      dataDir,
      apiKey: "test-key",
      apiKeySource: "env",
      baseUrl: "https://example.invalid/anthropic",
      mainModel: "",
      mapping: {},
    });

    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(settings.env.CLAUDE_AUTO_UPDATE).toBeUndefined();
    expect(settings.env.MY_VAR).toBe("keep");
  });

  it("keeps a user's own DISABLE_AUTOUPDATER when it wasn't ours to begin with", async () => {
    const settingsPath = userSettingsPath(sandbox.home);
    const dataDir = claudeDataDir(sandbox.home);
    // Unmanaged settings: the user turned Claude Code's auto-updater off
    // themselves to control their own release.
    await writeFileAtomic(
      settingsPath,
      '{\n  "env": { "DISABLE_AUTOUPDATER": "1" } }\n',
    );

    await enableFriendliProvider({
      settingsPath,
      dataDir,
      apiKey: "test-key",
      apiKeySource: "env",
      baseUrl: "https://example.invalid/anthropic",
      mainModel: "",
      mapping: {},
    });

    let settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(settings.env.DISABLE_AUTOUPDATER).toBe("1");

    // ...and still after a second `on`, when the file is already managed:
    // ownership comes from the pre-frlink snapshot, not the marker.
    await enableFriendliProvider({
      settingsPath,
      dataDir,
      apiKey: "test-key",
      apiKeySource: "env",
      baseUrl: "https://example.invalid/anthropic",
      mainModel: "",
      mapping: {},
    });

    settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(settings.env.DISABLE_AUTOUPDATER).toBe("1");

    // `off` hands the file back exactly as the user wrote it.
    await disableFriendliProvider({ settingsPath, dataDir });
    expect(await readFile(settingsPath, "utf8")).toBe(
      '{\n  "env": { "DISABLE_AUTOUPDATER": "1" } }\n',
    );
  });

  it("takes the session off Bedrock and hands it back on `off`", async () => {
    const settingsPath = userSettingsPath(sandbox.home);
    const dataDir = claudeDataDir(sandbox.home);
    // A developer already set up for Bedrock: the selector and its region in
    // their own settings.json. Left alone, the selector outranks
    // ANTHROPIC_BASE_URL and `on` would change nothing they'd notice.
    const original =
      '{\n  "env": { "CLAUDE_CODE_USE_BEDROCK": "1", "AWS_REGION": "us-west-2" } }\n';
    await writeFileAtomic(settingsPath, original);

    await enableFriendliProvider({
      settingsPath,
      dataDir,
      apiKey: "test-key",
      apiKeySource: "env",
      baseUrl: "https://example.invalid/anthropic",
      mainModel: "",
      mapping: { sonnet: "sonnet-1" },
    });

    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    for (const key of [
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
      "CLAUDE_CODE_USE_ANTHROPIC_AWS",
      "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
      "CLAUDE_CODE_USE_MANTLE",
      "CLAUDE_CODE_USE_GATEWAY",
    ]) {
      expect(settings.env[key]).toBe("");
    }
    // Only the provider selection is neutralized: the credentials and region
    // stay put, so `off` leaves a working Bedrock setup behind.
    expect(settings.env.AWS_REGION).toBe("us-west-2");

    await disableFriendliProvider({ settingsPath, dataDir });
    expect(await readFile(settingsPath, "utf8")).toBe(original);
  });

  it("pins the auto-updater only while a version pin is in force", async () => {
    const settingsPath = userSettingsPath(sandbox.home);
    const dataDir = claudeDataDir(sandbox.home);

    await enableFriendliProvider({
      settingsPath,
      dataDir,
      apiKey: "test-key",
      apiKeySource: "env",
      baseUrl: "https://example.invalid/anthropic",
      mainModel: "",
      mapping: {},
      pinAutoUpdate: true,
    });

    let settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(settings.env.DISABLE_AUTOUPDATER).toBe("1");

    // Re-running without a pin must clear the stale one, not inherit it from
    // the managed env block we wrote a moment ago.
    await enableFriendliProvider({
      settingsPath,
      dataDir,
      apiKey: "test-key",
      apiKeySource: "env",
      baseUrl: "https://example.invalid/anthropic",
      mainModel: "",
      mapping: {},
    });

    settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(settings.env.DISABLE_AUTOUPDATER).toBeUndefined();
  });

  it("records the version-guard outcome in the provider state", async () => {
    const settingsPath = userSettingsPath(sandbox.home);
    const dataDir = claudeDataDir(sandbox.home);

    await enableFriendliProvider({
      settingsPath,
      dataDir,
      apiKey: "test-key",
      apiKeySource: "env",
      baseUrl: "https://example.invalid/anthropic",
      mainModel: "",
      mapping: {},
      versionGuard: { version: "2.1.233", downgraded: true },
    });

    const state = JSON.parse(
      await readFile(path.join(dataDir, "provider-state.json"), "utf8"),
    );
    expect(state.versionGuard).toEqual({
      version: "2.1.233",
      downgraded: true,
    });

    // `off` clears the state file again, so stale version info can't linger.
    await disableFriendliProvider({ settingsPath, dataDir });
    await expect(
      readFile(path.join(dataDir, "provider-state.json"), "utf8"),
    ).rejects.toThrow();
  });

  it("preserves unrelated settings and restores them byte-for-byte on disable", async () => {
    const settingsPath = userSettingsPath(sandbox.home);
    const dataDir = claudeDataDir(sandbox.home);
    const original = '{\n  "model": "some-other-model",\n  "custom": true\n}\n';
    await writeFileAtomic(settingsPath, original);

    await enableFriendliProvider({
      settingsPath,
      dataDir,
      apiKey: "test-key",
      apiKeySource: "flag",
      baseUrl: "https://example.invalid/anthropic",
      mainModel: "pinned-model",
      mapping: {},
    });

    const during = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(during.model).toBe("pinned-model");
    expect(during.custom).toBe(true);

    const outcome = await disableFriendliProvider({ settingsPath, dataDir });
    expect(outcome).toBe("restored");
    expect(await readFile(settingsPath, "utf8")).toBe(original);
  });

  it("deletes settings.json on disable if it did not exist before enable", async () => {
    const settingsPath = userSettingsPath(sandbox.home);
    const dataDir = claudeDataDir(sandbox.home);

    await enableFriendliProvider({
      settingsPath,
      dataDir,
      apiKey: "test-key",
      apiKeySource: "flag",
      baseUrl: "https://example.invalid/anthropic",
      mainModel: "",
      mapping: {},
    });

    const outcome = await disableFriendliProvider({ settingsPath, dataDir });
    expect(outcome).toBe("restored");
    await expect(readFile(settingsPath, "utf8")).rejects.toThrow();
  });

  it("disable is a no-op when nothing was ever enabled", async () => {
    const settingsPath = userSettingsPath(sandbox.home);
    const dataDir = claudeDataDir(sandbox.home);
    expect(await disableFriendliProvider({ settingsPath, dataDir })).toBe(
      "none",
    );
  });

  it("normalizes Claude Code's gateway base to the unversioned service root", () => {
    expect(friendliBaseUrl({ baseUrl: "", baseUrlFromFlag: false })).toBe(
      "https://api.friendli.ai/serverless",
    );

    const override = {
      baseUrl: "https://staging.example.invalid/serverless/v1/",
      baseUrlFromFlag: true,
    };
    expect(friendliBaseUrl(override)).toBe(
      "https://staging.example.invalid/serverless",
    );
  });

  it("builds the expected env block shape, omitting unset slots", () => {
    const env = buildFriendliProviderEnv("key-1", "https://example.invalid", {
      opus: "opus-1",
      haiku: "haiku-1",
      subagent: "sub-1",
    });
    expect(env).toMatchObject({
      FRLINK_MANAGED: "1",
      ANTHROPIC_BASE_URL: "https://example.invalid",
      ANTHROPIC_AUTH_TOKEN: "key-1",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-sonnet-4-6",
      CLAUDE_CODE_SUBAGENT_MODEL: "sub-1",
    });
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
  });

  it("names the slot Claude ids while the Friendli ids ride in modelOverrides", () => {
    const catalog = [
      { id: "zai-org/GLM-5.3", label: "GLM-5.3", contextLength: 1_048_576 },
      { id: "small-model", label: "Small Model", contextLength: 32_768 },
    ];

    const env = buildFriendliProviderEnv(
      "key-1",
      "https://example.invalid",
      { sonnet: "zai-org/GLM-5.3", haiku: "small-model" },
      catalog,
    );
    const overrides = slotModelOverrides({
      sonnet: "zai-org/GLM-5.3",
      haiku: "small-model",
    });

    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-5");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-sonnet-4-6");
    expect(overrides).toEqual({
      "claude-sonnet-5": "zai-org/GLM-5.3",
      "claude-sonnet-4-6": "small-model",
    });
  });

  it("declares _NAME, _DESCRIPTION, and _SUPPORTED_CAPABILITIES from catalog metadata", () => {
    const catalog = [
      {
        id: "zai-org/GLM-5.3",
        label: "zai-org/GLM-5.3",
        contextLength: 1_048_576,
        reasoning: true,
        reasoningEffortLevels: ["low", "high", "max"],
        description: "Flagship GLM model for long-horizon coding and agents",
      },
    ];

    const env = buildFriendliProviderEnv(
      "key-1",
      "https://example.invalid",
      { sonnet: "zai-org/GLM-5.3" },
      catalog,
    );

    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME).toBe("zai-org/GLM-5.3");
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION).toBe(
      "Flagship GLM model for long-horizon coding and agents",
    );
    // Straight from the catalog entry above: an effort option with "max" in
    // it. No rejects_disabled_thinking — toggle or not, the Messages surface
    // accepts thinking:disabled for every Friendli model tested.
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES).toBe(
      "thinking,adaptive_thinking,effort,max_effort",
    );
  });

  it("declares the effort rungs the catalog reports", () => {
    const env = buildFriendliProviderEnv(
      "key-1",
      "https://example.invalid",
      { sonnet: "zai-org/GLM-5.2" },
      [
        {
          id: "zai-org/GLM-5.2",
          label: "GLM-5.2",
          reasoning: true,
          reasoningEffortLevels: ["high", "max", "xhigh"],
        },
      ],
    );

    const capabilities = (
      env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES ?? ""
    ).split(",");
    expect(capabilities).toContain("effort");
    expect(capabilities).toContain("max_effort");
    expect(capabilities).toContain("xhigh_effort");
  });

  /** `rejects_disabled_thinking` is never declared, toggle or not: the
   * catalog's toggle describes the chat-completions `enable_thinking` kwarg,
   * while the Messages surface FriendliLink routes through accepts
   * `thinking: {"type": "disabled"}` and really turns reasoning off. */
  it("never declares rejects_disabled_thinking, with or without a toggle", () => {
    const capabilitiesFor = (reasoningToggle?: true) => {
      const env = buildFriendliProviderEnv(
        "key-1",
        "https://example.invalid",
        { sonnet: "vendor/Model" },
        [
          {
            id: "vendor/Model",
            label: "Model",
            reasoning: true,
            ...(reasoningToggle ? { reasoningToggle } : {}),
          },
        ],
      );
      return (
        env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES ?? ""
      ).split(",");
    };

    expect(capabilitiesFor(true)).not.toContain("rejects_disabled_thinking");
    expect(capabilitiesFor()).not.toContain("rejects_disabled_thinking");
  });

  /** Only `--model` declares a window: a mono-model `on` has no
   * `modelOverrides` coverage, so `CLAUDE_CODE_MAX_CONTEXT_TOKENS` is what
   * tells Claude Code the real size. Slot-mapped models resolve to a
   * recognized Claude id via `modelOverrides` and are sized from Claude
   * Code's baked table instead — a slot window here would fight that. */
  it("sets CLAUDE_CODE_MAX_CONTEXT_TOKENS from the main model's context_length", () => {
    const catalog = [
      { id: "main/model", label: "Main", contextLength: 163_840 },
      { id: "vendor/NoWindow", label: "NoWindow" },
    ];

    const mainWins = buildFriendliProviderEnv(
      "key-1",
      "https://example.invalid",
      { sonnet: "main/model" },
      catalog,
      { mainModel: "main/model" },
    );
    expect(mainWins.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe(String(163_840));

    // Catalog reports no window for the main model: nothing to say.
    const noWindow = buildFriendliProviderEnv(
      "key-1",
      "https://example.invalid",
      { sonnet: "vendor/NoWindow" },
      catalog,
      { mainModel: "vendor/NoWindow" },
    );
    expect(noWindow.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();

    // Slot mapping with no --model: window comes from the modelOverrides
    // route, not this env var.
    const slotMapped = buildFriendliProviderEnv(
      "key-1",
      "https://example.invalid",
      { sonnet: "main/model" },
      catalog,
    );
    expect(slotMapped.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
  });

  /** The [1m]-variant suppressor reads to Claude Code as "keep this session
   * within 200k". Declaring it alongside a >200k window is what trips the
   * compact-context-cap warning, so it only rides along below that line. */
  it("writes the [1m] suppressor only for windows within Claude Code's 200k", () => {
    const catalog = [
      { id: "vendor/Big", label: "Big", contextLength: 1_048_576 },
      { id: "vendor/Small", label: "Small", contextLength: 163_840 },
    ];

    const big = buildFriendliProviderEnv(
      "key-1",
      "https://example.invalid",
      { sonnet: "vendor/Big" },
      catalog,
      { mainModel: "vendor/Big" },
    );
    expect(big.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe(String(1_048_576));
    expect(big.CLAUDE_CODE_DISABLE_1M_CONTEXT).toBeUndefined();

    const small = buildFriendliProviderEnv(
      "key-1",
      "https://example.invalid",
      { sonnet: "vendor/Small" },
      catalog,
      { mainModel: "vendor/Small" },
    );
    expect(small.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe(String(163_840));
    expect(small.CLAUDE_CODE_DISABLE_1M_CONTEXT).toBe("1");
  });

  /** The slot entries of `modelOverrides` are ours; a user's own entries for
   * other models survive, and a later `on` with a different slot lineup
   * replaces rather than accumulates. */
  it("maps each slot's Claude id onto the Friendli model in modelOverrides", async () => {
    const settingsPath = userSettingsPath(sandbox.home);
    const dataDir = claudeDataDir(sandbox.home);
    // A user's own override for a non-slot model predates frlink.
    await writeFileAtomic(
      settingsPath,
      '{ "modelOverrides": { "claude-opus-4-6": "my-own-proxy-id" } }\n',
    );

    await enableFriendliProvider({
      settingsPath,
      dataDir,
      apiKey: "test-key",
      apiKeySource: "env",
      baseUrl: "https://example.invalid/anthropic",
      mainModel: "",
      mapping: { sonnet: "zai-org/GLM-5.2", fable: "MiniMaxAI/MiniMax-M2.5" },
    });

    let settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(settings.modelOverrides).toEqual({
      "claude-opus-4-6": "my-own-proxy-id",
      "claude-sonnet-5": "zai-org/GLM-5.2",
      "claude-fable-5": "MiniMaxAI/MiniMax-M2.5",
    });

    // Re-running with fewer slots drops the stale entry, not the user's.
    await enableFriendliProvider({
      settingsPath,
      dataDir,
      apiKey: "test-key",
      apiKeySource: "env",
      baseUrl: "https://example.invalid/anthropic",
      mainModel: "",
      mapping: { sonnet: "zai-org/GLM-5.3" },
    });

    settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(settings.modelOverrides).toEqual({
      "claude-opus-4-6": "my-own-proxy-id",
      "claude-sonnet-5": "zai-org/GLM-5.3",
    });
  });

  /** Setting the variable is what stops Claude Code guessing, so an empty list
   * states "this model does not reason" — worth saying when the catalog told us. */
  it("states emptiness for a catalog model that does not reason", () => {
    const env = buildFriendliProviderEnv(
      "key-1",
      "https://example.invalid",
      { sonnet: "acme/plain" },
      [{ id: "acme/plain", label: "Plain", reasoning: false }],
    );

    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES).toBe("");
  });

  /** With no catalog entry we know nothing, so we say nothing and let Claude
   * Code fall back to its own heuristics. */
  it("says nothing when the catalog has no entry for the model", () => {
    const env = buildFriendliProviderEnv("key-1", "https://example.invalid", {
      sonnet: "vendor/Unlisted",
    });

    expect(
      env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES,
    ).toBeUndefined();
  });

  it("strips legacy context suffixes from the subagent slot", () => {
    const env = buildFriendliProviderEnv("key-1", "https://example.invalid", {
      sonnet: "zai-org/GLM-5.3",
      subagent: "zai-org/GLM-5.3[1m]",
    });

    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-5");
    expect(slotModelOverrides({ sonnet: "zai-org/GLM-5.3[1m]" })).toEqual({
      "claude-sonnet-5": "zai-org/GLM-5.3",
    });
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("zai-org/GLM-5.3");
  });

  it("keeps the Claude slot id when a pinned model isn't in the catalog", () => {
    const env = buildFriendliProviderEnv("key-1", "https://example.invalid", {
      sonnet: "not-in-catalog",
    });

    // Slot always names the Claude id; the unknown Friendli id still rides in
    // modelOverrides, and without a catalog entry its label falls back to it.
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-5");
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME).toBe("not-in-catalog");
    expect(
      env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES,
    ).toBeUndefined();
  });
});

/** These describe one specific model, so a leftover from a previous `on` would
 * describe the wrong one. frlink is their only writer. */
describe("claude on clears stale per-slot metadata", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await createSandboxHome();
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it("does not leave a previous model's description or capabilities behind", async () => {
    const settingsPath = userSettingsPath(sandbox.home);
    const dataDir = claudeDataDir(sandbox.home);
    const enable = (mapping: Record<string, string>, catalog: unknown[]) =>
      enableFriendliProvider({
        settingsPath,
        dataDir,
        apiKey: "flp_k",
        apiKeySource: "env",
        baseUrl: "https://api.friendli.ai/serverless",
        mainModel: "",
        mapping,
        catalog: catalog as never,
      });

    await enable({ sonnet: "vendor/Rich" }, [
      {
        id: "vendor/Rich",
        label: "Rich",
        reasoning: true,
        reasoningEffortLevels: ["low", "max"],
        description: "the first model",
      },
    ]);

    // A later `on` where the catalog is unreachable: no entry for the new model.
    await enable({ sonnet: "vendor/Unlisted" }, []);

    const { env, modelOverrides } = JSON.parse(
      await readFile(settingsPath, "utf8"),
    );
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-5");
    expect(modelOverrides["claude-sonnet-5"]).toBe("vendor/Unlisted");
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION).toBeUndefined();
    expect(
      env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES,
    ).toBeUndefined();
  });
});
