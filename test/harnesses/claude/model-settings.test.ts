import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildFriendliProviderEnv,
  enableFriendliProvider,
  disableFriendliProvider,
  userSettingsPath,
  claudeDataDir,
} from "../../../src/harnesses/claude/core.js";
import { claudeCodeCapabilityRule } from "../../../src/harnesses/claude/reasoning.js";
import { createSandboxHome, type Sandbox } from "../../helpers.js";
import { writeJson } from "../../../src/io/json.js";
import { catalog, mapping } from "./catalog-fixture.js";

describe("Claude model settings", () => {
  let sandbox: Sandbox;
  beforeEach(async () => {
    sandbox = await createSandboxHome();
  });
  afterEach(async () => {
    await sandbox.cleanup();
  });

  it("negates effort for toggle/budget models, including canonical Haiku and raw subagent IDs", () => {
    const env = buildFriendliProviderEnv(
      "dummy",
      "http://localhost",
      mapping,
      catalog,
    );
    const rules = env.CLAUDE_CODE_MODEL_CAPABILITIES!.split(";");
    for (const id of [
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "claude-fable-5",
      mapping.opus,
      mapping.fable,
      mapping.haiku,
      mapping.sonnet,
    ]) {
      expect(
        rules
          .find((rule) => rule.startsWith(`${id}=`))
          ?.split("=")[1]
          ?.split(","),
      ).toEqual([
        "thinking",
        "-effort",
        "-xhigh_effort",
        "-max_effort",
        "adaptive_thinking",
        "-interleaved_thinking",
        "-rejects_disabled_thinking",
      ]);
    }
    expect(rules).toContain(
      `${mapping.subagent}=thinking,effort,-xhigh_effort,max_effort,adaptive_thinking,-interleaved_thinking,-rejects_disabled_thinking`,
    );
  });

  it("does not interpret a provider model ID as capability-rule syntax", () => {
    for (const id of [
      "vendor/*",
      "vendor/a;*=effort",
      "vendor/a,b",
      "vendor/a=b",
    ]) {
      expect(claudeCodeCapabilityRule(id, catalog[0]!)).toBe("");
    }
  });

  it("rebuilds picker, defaults and rules on repeated on, and restores original settings on off", async () => {
    const settingsPath = userSettingsPath(sandbox.home),
      dataDir = claudeDataDir(sandbox.home);
    const userRules = "my-model=effort;claude-sonnet-5=effort";
    await writeJson(settingsPath, {
      model: "claude-fable-5-1[1m]",
      env: {
        CLAUDE_CODE_MODEL_CAPABILITIES: userRules,
        ANTHROPIC_DEFAULT_MODEL: "my-default",
      },
      modelOverrides: {
        "claude-haiku-4-5": "old-broken-mapping",
        "claude-haiku-4-5-20251001": "old-budget-mapping",
        "claude-opus-4-6": "user-model",
      },
      modelPicker: { options: [{ model: "user-model" }] },
    });
    const original = await readFile(settingsPath, "utf8");
    const enable = (
      nextMapping: typeof mapping | { sonnet: string } | {},
      mainModel = "",
    ) =>
      enableFriendliProvider({
        settingsPath,
        dataDir,
        apiKey: "dummy",
        apiKeySource: "flag",
        baseUrl: "http://localhost",
        mapping: nextMapping,
        mainModel,
        catalog,
      });
    await enable(mapping);
    let settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(settings.model).toBe("sonnet");
    expect(settings.env.ANTHROPIC_DEFAULT_MODEL).toBe("sonnet");
    expect(settings.modelPicker.replaceBuiltInOptions).toBe(true);
    expect(
      settings.modelPicker.options.map((o: { model: string }) => o.model),
    ).toEqual([
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "claude-fable-5",
    ]);
    for (const row of settings.modelPicker.options) {
      const id = settings.modelOverrides[row.model];
      expect(row.label).toBe(catalog.find((model) => model.id === id)?.label);
    }
    expect(settings.modelOverrides["claude-haiku-4-5"]).toBeUndefined();
    expect(
      settings.modelOverrides["claude-haiku-4-5-20251001"],
    ).toBeUndefined();
    expect(settings.modelOverrides["claude-sonnet-4-6"]).toBe(mapping.haiku);
    expect(settings.env.CLAUDE_CODE_MODEL_CAPABILITIES).toContain(
      `${userRules};`,
    );

    await enable({ sonnet: mapping.subagent });
    settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(settings.modelPicker.options).toHaveLength(1);
    expect(settings.env.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
    expect(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBeUndefined();
    expect(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
    expect(settings.env.CLAUDE_CODE_MODEL_CAPABILITIES).not.toContain(
      mapping.fable,
    );
    expect(settings.env.CLAUDE_CODE_MODEL_CAPABILITIES).toContain(
      "claude-sonnet-5=thinking,effort,-xhigh_effort,max_effort",
    );
    expect(settings.modelOverrides).toEqual({
      "claude-opus-4-6": "user-model",
      "claude-sonnet-5": mapping.subagent,
    });

    await enable({}, mapping.haiku);
    settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(settings.model).toBe(mapping.haiku);
    expect(
      settings.modelPicker.options.map((o: { model: string }) => o.model),
    ).toEqual([mapping.haiku]);
    expect(settings.env.CLAUDE_CODE_MODEL_CAPABILITIES).not.toContain(
      mapping.subagent,
    );

    await enable({});
    settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(settings.model).toBe("claude-fable-5-1[1m]");
    expect(settings.env.CLAUDE_CODE_MODEL_CAPABILITIES).toBe(userRules);
    expect(settings.env.ANTHROPIC_DEFAULT_MODEL).toBe("my-default");
    expect(settings.modelPicker).toEqual({
      options: [{ model: "user-model" }],
    });
    await disableFriendliProvider({ settingsPath, dataDir });
    expect(await readFile(settingsPath, "utf8")).toBe(original);
  });
});
