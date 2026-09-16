import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBaseContext } from "../../../src/harness/types.js";
import {
  disableFriendliForPi,
  enableFriendliForPi,
  isFriendliManaged,
  piDataDir,
  piModelsPath,
  piSettingsPath,
  readProviderState,
} from "../../../src/harnesses/pi/core.js";
import { piAdapter } from "../../../src/harnesses/pi/index.js";
import {
  buildPiCatalog,
  buildPiModelEntry,
} from "../../../src/harnesses/pi/catalog.js";
import { writeFileAtomic } from "../../../src/io/atomic-write.js";
import { createSandboxHome, type Sandbox } from "../../helpers.js";

const API_BASE = "https://api.friendli.ai/serverless/v1";
const MODEL = "zai-org/GLM-5.2";

// See NON_OFF_LEVELS/thinkingLevelMapFor in catalog.ts: every level is
// null unless Friendli's reasoning_options actually lists it (mapped to
// itself, so the value sent is unchanged). A toggle model with no effort
// list gets "medium" unlocked as Pi's single "on" representative and no
// "off" key at all (already selectable by default); a non-toggle model
// gets an explicit "off": null instead.
const GLM52_MAP = {
  minimal: null,
  low: null,
  medium: null,
  high: "high",
  xhigh: null,
  max: "max",
};
const TOGGLE_NO_EFFORT_MAP = {
  minimal: null,
  low: null,
  medium: "medium",
  high: null,
  xhigh: null,
  max: null,
};
const GLM53_MAP = {
  minimal: null,
  low: "low",
  medium: null,
  high: "high",
  xhigh: null,
  max: "max",
  off: null,
};
const NON_TOGGLE_NO_EFFORT_MAP = {
  minimal: null,
  low: null,
  medium: "medium",
  high: null,
  xhigh: null,
  max: null,
  off: null,
};

const CATALOG = [
  // Mirrors Friendli's own /models reasoning_options shape: a "toggle"
  // entry plus an "effort" entry listing "high"/"max".
  {
    id: "zai-org/GLM-5.2",
    label: "GLM-5.2",
    reasoning: true,
    reasoningToggle: true,
    reasoningEffortLevels: ["high", "max"],
  },
  // The catalog doesn't flag it as reasoning, but its toggle does. No
  // effort entry — Friendli doesn't list one for DeepSeek.
  {
    id: "deepseek-ai/DeepSeek-V3.2",
    label: "DeepSeek-V3.2",
    reasoning: false,
    reasoningToggle: true,
  },
];

function enable(sandbox: Sandbox, options: Record<string, unknown> = {}) {
  return enableFriendliForPi({
    settingsPath: piSettingsPath(sandbox.home),
    modelsPath: piModelsPath(sandbox.home),
    dataDir: piDataDir(sandbox.home),
    apiKey: "test-key",
    apiKeySource: "env",
    baseUrl: API_BASE,
    model: MODEL,
    catalog: CATALOG,
    ...options,
  });
}

describe("pi core", () => {
  let sandbox: Sandbox;
  // A dev/CI machine may export PI_CODING_AGENT_DIR for its own pi; clear
  // it before every test (the env-override test sets its own value) and
  // restore the original afterwards, so no test reads or writes outside
  // the sandbox — and the hook can't corrupt the process environment.
  let originalPiDir: string | undefined;

  beforeEach(async () => {
    sandbox = await createSandboxHome();
    originalPiDir = process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_CODING_AGENT_DIR;
  });

  afterEach(async () => {
    if (originalPiDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalPiDir;
    }
    await sandbox.cleanup();
  });

  it("routes settings/models through PI_CODING_AGENT_DIR like pi itself does", () => {
    const agentDir = path.join(sandbox.home, "custom-pi-dir");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    expect(piSettingsPath(sandbox.home)).toBe(
      path.join(agentDir, "settings.json"),
    );
    expect(piModelsPath(sandbox.home)).toBe(path.join(agentDir, "models.json"));
  });

  it("writes the guide's provider block with off-switch compat where supported", async () => {
    const originalModels = '{ "providers": { "openai": { "models": [] } } }\n';
    const originalSettings = '{ "theme": "dark" }\n';
    await writeFileAtomic(piModelsPath(sandbox.home), originalModels);
    await writeFileAtomic(piSettingsPath(sandbox.home), originalSettings);

    await enable(sandbox);

    const models = JSON.parse(
      await readFile(piModelsPath(sandbox.home), "utf8"),
    );
    expect(models.providers["friendliai-chat-completions"]).toEqual({
      baseUrl: API_BASE,
      api: "openai-completions",
      apiKey: "test-key",
      models: [
        // GLM-5.2 can disable reasoning: /thinking off renders
        // `chat_template_kwargs: {enable_thinking: false}` — the gateway
        // rejects a top-level enable_thinking with 422. It lists "high"
        // and "max" as effort values, so those (and only those) ride the
        // same kwargs and appear unlocked in the level map; "off" is left
        // out of the map entirely since it's already selectable for a
        // toggle model without one.
        {
          id: "zai-org/GLM-5.2",
          reasoning: true,
          compat: {
            thinkingFormat: "chat-template",
            chatTemplateKwargs: {
              enable_thinking: { $var: "thinking.enabled" },
              reasoning_effort: { $var: "thinking.effort" },
            },
          },
          thinkingLevelMap: GLM52_MAP,
        },
        // DeepSeek's first-party `thinking: {type}` object is not exposed
        // by the gateway (422) — its switch is the same
        // chat_template_kwargs.enable_thinking pair everyone with a toggle
        // gets. The catalog doesn't flag it as reasoning, but the switch
        // only exists on reasoning models, so the entry claims reasoning.
        // The role pin keeps the system prompt on `system`: a
        // `developer`-role message plus an explicit enable_thinking: true
        // is a 422 on this model (either piece alone, or the pair as
        // `system`, is fine). Friendli lists no effort option for it, so
        // the reasoning_effort kwarg is left out entirely — picking Pi's
        // single "medium" representative changes nothing but
        // enable_thinking.
        {
          id: "deepseek-ai/DeepSeek-V3.2",
          reasoning: true,
          compat: {
            thinkingFormat: "chat-template",
            supportsDeveloperRole: false,
            chatTemplateKwargs: {
              enable_thinking: { $var: "thinking.enabled" },
            },
          },
          thinkingLevelMap: TOGGLE_NO_EFFORT_MAP,
        },
      ],
    });
    // Unrelated providers survive.
    expect(models.providers.openai).toEqual({ models: [] });

    const settings = JSON.parse(
      await readFile(piSettingsPath(sandbox.home), "utf8"),
    );
    expect(settings.defaultProvider).toBe("friendliai-chat-completions");
    expect(settings.defaultModel).toBe(MODEL);
    expect(settings.enabledModels).toEqual([
      "friendliai-chat-completions/**",
      `friendliai-chat-completions/${MODEL}`,
    ]);
    // Which level a session starts at is Pi's own call; frlink
    // doesn't seed modelThinkingLevels.
    expect(settings.modelThinkingLevels).toBeUndefined();
    expect(settings.theme).toBe("dark");

    expect(await isFriendliManaged(piSettingsPath(sandbox.home))).toBe(true);
  });

  it("merges telemetry headers into an existing Friendli provider", async () => {
    await writeFileAtomic(
      piModelsPath(sandbox.home),
      JSON.stringify({
        providers: {
          "friendliai-chat-completions": {
            headers: {
              "X-User-Trace": "keep",
              "x-title": "stale title",
              "HTTP-REFERER": "stale referer",
            },
            userOption: "preserve",
          },
        },
      }),
    );

    await enable(sandbox, {
      telemetryHeaders: {
        "X-Title": "Pi",
        "HTTP-Referer": "frlink/v0.1.0",
      },
    });

    const provider = JSON.parse(
      await readFile(piModelsPath(sandbox.home), "utf8"),
    ).providers["friendliai-chat-completions"];
    expect(provider).toMatchObject({
      baseUrl: API_BASE,
      api: "openai-completions",
      models: [
        { id: "zai-org/GLM-5.2", reasoning: true },
        { id: "deepseek-ai/DeepSeek-V3.2", reasoning: true },
      ],
      userOption: "preserve",
    });
    expect(provider.headers).toEqual({
      "X-User-Trace": "keep",
      "X-Title": "Pi",
      "HTTP-Referer": "frlink/v0.1.0",
    });
  });

  it("registers only the picked model when the catalog is unreachable", async () => {
    await enable(sandbox, { catalog: [] });

    const models = JSON.parse(
      await readFile(piModelsPath(sandbox.home), "utf8"),
    );
    // The off-switch and effort compat come from Friendli's catalog
    // (reasoning_options); without one, even a switch model like GLM-5.2
    // registers plain — degraded, but matches the guide's hand-setup shape.
    expect(models.providers["friendliai-chat-completions"].models).toEqual([
      { id: MODEL, reasoning: true },
    ]);
  });

  it("stores the models file owner-only (it carries the API key literally)", async () => {
    await enable(sandbox);
    const mode = (await stat(piModelsPath(sandbox.home))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("replaces its own models on re-enable instead of accumulating", async () => {
    await enable(sandbox);
    const afterFirst = JSON.parse(
      await readFile(piModelsPath(sandbox.home), "utf8"),
    );
    await enable(sandbox, { catalog: [...CATALOG.slice(0, 1)] });
    const afterSecond = JSON.parse(
      await readFile(piModelsPath(sandbox.home), "utf8"),
    );

    expect(afterSecond.providers["friendliai-chat-completions"].models).toEqual(
      [
        {
          id: "zai-org/GLM-5.2",
          reasoning: true,
          compat: {
            thinkingFormat: "chat-template",
            chatTemplateKwargs: {
              enable_thinking: { $var: "thinking.enabled" },
              reasoning_effort: { $var: "thinking.effort" },
            },
          },
          thinkingLevelMap: GLM52_MAP,
        },
      ],
    );
    expect(
      Object.keys(afterSecond.providers["friendliai-chat-completions"] ?? {})
        .length,
    ).toBeGreaterThan(0);
    expect(
      afterFirst.providers["friendliai-chat-completions"].models,
    ).toHaveLength(2);
  });

  it("restores both files byte-for-byte on disable", async () => {
    const originalModels = '{ "providers": { "openai": { "models": [] } } }\n';
    const originalSettings =
      '{ "lastChangelogVersion": "0.80.3", "theme": "dark" }\n';
    await writeFileAtomic(piModelsPath(sandbox.home), originalModels);
    await writeFileAtomic(piSettingsPath(sandbox.home), originalSettings);

    await enable(sandbox);
    const outcome = await disableFriendliForPi({
      settingsPath: piSettingsPath(sandbox.home),
      modelsPath: piModelsPath(sandbox.home),
      dataDir: piDataDir(sandbox.home),
    });

    expect(outcome).toBe("restored");
    expect(await readFile(piModelsPath(sandbox.home), "utf8")).toBe(
      originalModels,
    );
    expect(await readFile(piSettingsPath(sandbox.home), "utf8")).toBe(
      originalSettings,
    );
    expect(await isFriendliManaged(piSettingsPath(sandbox.home))).toBe(false);
  });

  it("deletes files on disable that did not exist before enable", async () => {
    await enable(sandbox);

    const outcome = await disableFriendliForPi({
      settingsPath: piSettingsPath(sandbox.home),
      modelsPath: piModelsPath(sandbox.home),
      dataDir: piDataDir(sandbox.home),
    });

    expect(outcome).toBe("restored");
    await expect(
      readFile(piModelsPath(sandbox.home), "utf8"),
    ).rejects.toThrow();
    await expect(
      readFile(piSettingsPath(sandbox.home), "utf8"),
    ).rejects.toThrow();
  });

  it("records provider state with the model it pinned", async () => {
    await enable(sandbox, { apiKeySource: "flag" });
    const state = await readProviderState(piDataDir(sandbox.home));
    expect(state).toEqual({ apiKeySource: "flag", model: MODEL });
  });

  it("leaves the user's per-model thinking levels untouched", async () => {
    const originalSettings =
      '{ "modelThinkingLevels": { "openai/gpt-5": "high" } }\n';
    await writeFileAtomic(piSettingsPath(sandbox.home), originalSettings);

    await enable(sandbox);

    const settings = JSON.parse(
      await readFile(piSettingsPath(sandbox.home), "utf8"),
    );
    // A session's starting level is Pi's own call — frlink never
    // seeds or edits modelThinkingLevels.
    expect(settings.modelThinkingLevels).toEqual({ "openai/gpt-5": "high" });
  });
});

describe("pi reasoning rules", () => {
  it("mirrors Friendli's effort list for toggle models that have one", () => {
    // GLM-5.2 lists exactly "high"/"max" — the level map and the kwargs
    // it rides in should reflect exactly that, nothing more.
    expect(
      buildPiModelEntry({
        id: "zai-org/GLM-5.2",
        reasoning: true,
        reasoningToggle: true,
        reasoningEffortLevels: ["high", "max"],
      }),
    ).toEqual({
      id: "zai-org/GLM-5.2",
      reasoning: true,
      compat: {
        thinkingFormat: "chat-template",
        chatTemplateKwargs: {
          enable_thinking: { $var: "thinking.enabled" },
          reasoning_effort: { $var: "thinking.effort" },
        },
      },
      thinkingLevelMap: GLM52_MAP,
    });
  });

  it("gives toggle models with no effort list only off/medium, and no reasoning_effort kwarg", () => {
    // gemma and GLM-5.1 have no "effort" entry in Friendli's own
    // reasoning_options, only "toggle" — so there's no granularity to
    // expose. Pi still needs one non-off level to represent "on"; medium
    // is Pi's own default. Since there's nothing to send Friendli beyond
    // the switch itself, the entry omits reasoning_effort from
    // chatTemplateKwargs entirely — selecting medium only changes
    // enable_thinking.
    expect(
      buildPiModelEntry({
        id: "google/gemma-4-31B-it",
        reasoning: true,
        reasoningToggle: true,
      }),
    ).toEqual({
      id: "google/gemma-4-31B-it",
      reasoning: true,
      compat: {
        thinkingFormat: "chat-template",
        chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" } },
      },
      thinkingLevelMap: TOGGLE_NO_EFFORT_MAP,
    });
    expect(
      buildPiModelEntry({
        id: "zai-org/GLM-5.1",
        reasoning: true,
        reasoningToggle: true,
      }),
    ).toEqual({
      id: "zai-org/GLM-5.1",
      reasoning: true,
      compat: {
        thinkingFormat: "chat-template",
        chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" } },
      },
      thinkingLevelMap: TOGGLE_NO_EFFORT_MAP,
    });
  });

  it("gives non-toggle reasoning models the level map without a compat entry, off excluded", () => {
    // GLM-5.3/Flash cannot turn reasoning off — Friendli has no toggle for
    // them — so /thinking "off" shouldn't even be offered; the map
    // explicitly nulls it. No `compat` needed either way: Pi's detected
    // compat for the Friendli base URL already sends reasoning_effort at
    // the top level.
    for (const id of ["zai-org/GLM-5.3", "zai-org/GLM-5.3-Flash"]) {
      expect(
        buildPiModelEntry({
          id,
          reasoning: true,
          reasoningEffortLevels: ["low", "high", "max"],
        }),
      ).toEqual({ id, reasoning: true, thinkingLevelMap: GLM53_MAP });
    }
    // MiniMax lists neither a toggle nor an effort option: off stays
    // excluded, and the single "medium" representative is all that's left.
    expect(
      buildPiModelEntry({ id: "MiniMaxAI/MiniMax-M2.5", reasoning: true }),
    ).toEqual({
      id: "MiniMaxAI/MiniMax-M2.5",
      reasoning: true,
      thinkingLevelMap: NON_TOGGLE_NO_EFFORT_MAP,
    });
    // A model the catalog doesn't flag as reasoning gets no map at all:
    // Pi's own getSupportedThinkingLevels short-circuits to ["off"] for it
    // regardless of what the map would say.
    expect(
      buildPiModelEntry({ id: "unknown/org/model", reasoning: false }),
    ).toEqual({
      id: "unknown/org/model",
      reasoning: false,
    });
  });

  it('never maps "off" to a string — Friendli\'s reasoning_effort has no accepted off value', () => {
    // Toggle models never carry an "off" key at all (already selectable
    // by default); non-toggle models carry "off": null (excluded), never
    // a string that would ride onto the wire as reasoning_effort.
    const toggleEntry = buildPiModelEntry({
      id: "zai-org/GLM-5.2",
      reasoning: true,
      reasoningToggle: true,
      reasoningEffortLevels: ["high", "max"],
    });
    expect(toggleEntry.thinkingLevelMap).not.toHaveProperty("off");

    const nonToggleEntry = buildPiModelEntry({
      id: "zai-org/GLM-5.3",
      reasoning: true,
      reasoningEffortLevels: ["low", "high", "max"],
    });
    expect(nonToggleEntry.thinkingLevelMap?.off).toBeNull();
  });

  it("builds a switch entry per model in the catalog", () => {
    const entries = buildPiCatalog([
      { id: "google/gemma-4-31B-it", label: "gemma", reasoningToggle: true },
      { id: "zai-org/GLM-5.1", label: "GLM-5.1", reasoningToggle: true },
    ]);
    expect(entries[0]).toEqual({
      id: "google/gemma-4-31B-it",
      reasoning: true,
      compat: {
        thinkingFormat: "chat-template",
        chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" } },
      },
      thinkingLevelMap: TOGGLE_NO_EFFORT_MAP,
    });
    expect(entries[1]).toEqual({
      id: "zai-org/GLM-5.1",
      reasoning: true,
      compat: {
        thinkingFormat: "chat-template",
        chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" } },
      },
      thinkingLevelMap: TOGGLE_NO_EFFORT_MAP,
    });
  });
});

describe("pi adapter", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await createSandboxHome();
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it("registers with the expected id, label, and telemetry capability", () => {
    expect(piAdapter.id).toBe("pi");
    expect(piAdapter.label).toBe("Pi");
    expect((piAdapter as { telemetryHeaders?: unknown }).telemetryHeaders).toBe(
      true,
    );
  });

  it("providerStatus follows Pi's default provider", async () => {
    const ctx = {
      ...createBaseContext(),
      home: sandbox.home,
      onboardingMode: "skip",
    } as const;
    expect(await piAdapter.providerStatus(ctx)).toBe("default");

    await writeFileAtomic(
      piSettingsPath(sandbox.home),
      '{ "defaultProvider": "friendliai-chat-completions" }\n',
    );
    expect(await piAdapter.providerStatus(ctx)).toBe("friendli");
  });

  it("puts models.json beside a --settings-path override", () => {
    const home = "/custom-home";
    expect(piModelsPath(home, "/elsewhere/settings.json")).toBe(
      "/elsewhere/models.json",
    );
  });

  it("fails on rather than silently registering the picked model without its compat", async () => {
    // A catalog fetch failure must not silently fall back to a plain
    // entry: without reasoning_options, a switch model (the default pick,
    // GLM-5.2) would lose its enable_thinking fix — Pi would drop
    // /thinking off for it instead of emitting the switch — while `on`
    // still reported success.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network unreachable")),
    );
    const originalEnvKey = process.env.FRIENDLI_API_KEY;
    process.env.FRIENDLI_API_KEY = "test-env-key-00000000";
    try {
      const ctx = {
        ...createBaseContext(),
        home: sandbox.home,
        onboardingMode: "skip",
      } as const;
      await expect(piAdapter.on(ctx)).rejects.toThrow();
      await expect(
        readFile(piModelsPath(sandbox.home), "utf8"),
      ).rejects.toThrow();
    } finally {
      vi.unstubAllGlobals();
      if (originalEnvKey === undefined) {
        delete process.env.FRIENDLI_API_KEY;
      } else {
        process.env.FRIENDLI_API_KEY = originalEnvKey;
      }
    }
  });
});
