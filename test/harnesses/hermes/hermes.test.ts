import { existsSync, mkdirSync } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { createBaseContext } from "../../../src/harness/types.js";
import { readGlobalConfig } from "../../../src/config/global-config.js";
import { FRIENDLI_API_KEY_ENV } from "../../../src/keys/api-key.js";
import { getDotenvPath } from "../../../src/keys/env-path.js";
import {
  disableFriendliForHermes,
  enableFriendliForHermes,
  hermesSlot,
  isFriendliManaged,
  readProviderState,
} from "../../../src/harnesses/hermes/core.js";
import {
  installFriendliPlugin,
  removeFriendliPlugin,
} from "../../../src/harnesses/hermes/plugins.js";
import {
  hermesAdapter,
  setHermesPluginRunnerForTests,
} from "../../../src/harnesses/hermes/index.js";
import { writeFileAtomic } from "../../../src/io/atomic-write.js";
import { createSandboxHome, type Sandbox } from "../../helpers.js";

const MODEL = "zai-org/GLM-5.2";
const PLUGIN_NAME = "friendliai-provider";
const INSTALL_ARGS = [
  "plugins",
  "install",
  "friendliai/hermes-friendliai-provider",
];
const REMOVE_ARGS = ["plugins", "remove", PLUGIN_NAME];

/**
 * A hermes config already pointed at somebody else's OpenAI-compatible endpoint:
 * the migrate-from case `on` has to absorb and `off` has to hand back.
 *
 * The provider deliberately is not ours. `isFriendliManaged` keys on
 * `model.provider`, and `snapshotFileIfNeeded` skips snapshotting a config it
 * considers already managed — so a fixture naming Friendli here would make `on`
 * take no snapshot at all, and every "the user's settings come back" assertion
 * below would pass while testing nothing.
 */
const REAL_CONFIG = `model:
  default: acme/models/some-llm-v2
  provider: acme
  base_url: https://api.acme-llm.invalid/v1
  api_key: acme-older-key
  api_mode: chat_completions
plugins:
  enabled:
    - ponytail
  disabled:
    - ${PLUGIN_NAME}
agent:
  max_turns: 90
  # hermes' own annotation
  verify_on_stop: false
`;

/** A realistic pre-frlink hermes home: its own provider, an
 * unrelated enabled plugin, our plugin disabled, and annotations. */
function config(sandbox: Sandbox): string {
  return path.join(sandbox.home, ".hermes", "config.yaml");
}

function dataDir(sandbox: Sandbox): string {
  return path.join(sandbox.home, ".frlink", "hermes");
}

/** Lifecycle files live in per-config hashed slots (profile isolation). */
function slots(sandbox: Sandbox) {
  return hermesSlot(dataDir(sandbox), config(sandbox));
}

function backupFile(sandbox: Sandbox): string {
  return slots(sandbox).backupPath;
}

function stateFile(sandbox: Sandbox): string {
  return slots(sandbox).statePath;
}

function enable(sandbox: Sandbox, options: Record<string, unknown> = {}) {
  return enableFriendliForHermes({
    configPath: config(sandbox),
    dataDir: dataDir(sandbox),
    apiKeySource: "env",
    model: MODEL,
    ...options,
  });
}

function disable(sandbox: Sandbox) {
  return disableFriendliForHermes({
    configPath: config(sandbox),
    dataDir: dataDir(sandbox),
  });
}

async function loseBackup(sandbox: Sandbox): Promise<void> {
  await rm(backupFile(sandbox));
}

async function readConfig(sandbox: Sandbox) {
  // YAML.parse returns any — the assertion style of the rest of this suite.
  return YAML.parse(await readFile(config(sandbox), "utf8"));
}

describe("hermes on", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await createSandboxHome();
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it("writes the plugin-managed end state and keeps the rest of the config", async () => {
    await writeFileAtomic(config(sandbox), REAL_CONFIG);

    await enable(sandbox);

    const doc = await readConfig(sandbox);
    expect(doc.model).toEqual({ default: MODEL, provider: "friendli" });
    expect(doc.plugins.enabled).toEqual(["ponytail", PLUGIN_NAME]);
    expect(doc.plugins.disabled).toEqual([]);
    expect(doc.agent.max_turns).toBe(90);
    const raw = await readFile(config(sandbox), "utf8");
    expect(raw).toContain("# hermes' own annotation");
    expect(raw).not.toContain("acme-older-key"); // inline key never survives
    expect((await stat(config(sandbox))).mode & 0o777).toBe(0o600);
    expect(await isFriendliManaged(config(sandbox))).toBe(true);
    expect(await readProviderState(dataDir(sandbox), config(sandbox))).toEqual({
      apiKeySource: "env",
      model: MODEL,
      installedByUs: true,
    });
  });

  it("bakes telemetry headers into model.default_headers and reverts them on off", async () => {
    await writeFileAtomic(config(sandbox), REAL_CONFIG);

    const telemetryHeaders = {
      "X-Title": "Hermes Agent",
      "HTTP-Referer": "frlink/v0.1.0",
    };
    await enable(sandbox, { telemetryHeaders });

    const doc = await readConfig(sandbox);
    expect(doc.model).toEqual({
      default: MODEL,
      provider: "friendli",
      default_headers: telemetryHeaders,
    });
    expect(await readProviderState(dataDir(sandbox), config(sandbox))).toEqual({
      apiKeySource: "env",
      model: MODEL,
      installedByUs: true,
      telemetryHeaders,
    });

    // A user's own default_headers value (a map we cannot prove is ours)
    // survives off byte-for-byte by value.
    await writeFileAtomic(
      config(sandbox),
      YAML.stringify({
        ...doc,
        model: {
          ...doc.model,
          default_headers: { "X-User-Trace": "keep" },
        },
      }),
    );
    await disable(sandbox);
    const after = await readConfig(sandbox);
    expect(after.model.default_headers).toEqual({ "X-User-Trace": "keep" });

    // Reset to the same pre-on state the earlier runs started from, so the
    // final on/off pair sees a snapshot with no default_headers at all.
    await writeFileAtomic(config(sandbox), REAL_CONFIG);

    // Without user edits, off removes exactly what on wrote — the model
    // block lands back on the pre-on REAL_CONFIG state, with no
    // default_headers of ours left behind.
    await enable(sandbox, { telemetryHeaders });
    await disable(sandbox);
    const restored = await readConfig(sandbox);
    expect(restored.model).toMatchObject({
      provider: "acme",
      base_url: "https://api.acme-llm.invalid/v1",
    });
    expect(restored.model.default_headers).toBeUndefined();
  });

  it("re-enables idempotently and follows a re-picked model", async () => {
    await enable(sandbox);
    await enable(sandbox, { model: "zai-org/GLM-5.1" });

    const doc = await readConfig(sandbox);
    expect(doc.plugins.enabled).toEqual([PLUGIN_NAME]);
    expect(doc.model.default).toBe("zai-org/GLM-5.1");
    expect(
      await readProviderState(dataDir(sandbox), config(sandbox)),
    ).toMatchObject({
      model: "zai-org/GLM-5.1",
    });
  });

  it("creates a managed config from nothing", async () => {
    await enable(sandbox);

    const doc = await readConfig(sandbox);
    expect(doc.model.provider).toBe("friendli");
    expect(doc.plugins.enabled).toEqual([PLUGIN_NAME]);
    expect(await isFriendliManaged(config(sandbox))).toBe(true);
  });

  it("retires the pre-rename friendli-provider from plugins.enabled", async () => {
    // Both names register the same `friendli` slug; only our name stays enabled.
    await writeFileAtomic(
      config(sandbox),
      `model:\n  default: m\n  provider: acme\nplugins:\n  enabled:\n    - friendli-provider\n`,
    );

    await enable(sandbox);

    expect((await readConfig(sandbox)).plugins.enabled).toEqual([PLUGIN_NAME]);

    // Round trip: off restores the retired entry the user had enabled.
    await disable(sandbox);

    expect((await readConfig(sandbox)).plugins.enabled).toEqual([
      "friendli-provider",
    ]);
  });

  it("migrates away legacy FriendliAI custom_providers, keeps unrelated ones", async () => {
    await writeFileAtomic(
      config(sandbox),
      `${REAL_CONFIG}custom_providers:
- name: Ollama
  base_url: http://localhost:11434/v1
- name: FriendliAI
  base_url: https://old.example.invalid
  api_key: leaked-key
- name: FriendliAI No Thinking
  base_url: https://old.example.invalid
`,
    );

    await enable(sandbox);

    const doc = (await readConfig(sandbox)) as {
      custom_providers: { name: string }[];
    };
    expect(doc.custom_providers.map((entry) => entry.name)).toEqual(["Ollama"]);
    expect(await readFile(config(sandbox), "utf8")).not.toContain("leaked-key");
  });
});

describe("hermes off", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await createSandboxHome();
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it("restores the pre-on config byte-for-byte", async () => {
    await writeFileAtomic(config(sandbox), REAL_CONFIG);
    await enable(sandbox);

    const { outcome, uninstallPlugin } = await disable(sandbox);

    expect(outcome).toBe("restored");
    expect(uninstallPlugin).toBe(true);
    expect(await readFile(config(sandbox), "utf8")).toBe(REAL_CONFIG);
    expect(await isFriendliManaged(config(sandbox))).toBe(false);
    expect(existsSync(backupFile(sandbox))).toBe(false);
    expect(
      await readProviderState(dataDir(sandbox), config(sandbox)),
    ).toBeUndefined();
  });

  it("deletes a config it created", async () => {
    await enable(sandbox);

    const { outcome } = await disable(sandbox);

    expect(outcome).toBe("restored");
    await expect(readFile(config(sandbox), "utf8")).rejects.toThrow();
  });

  it("keeps changes made after on while reverting what it owns", async () => {
    await writeFileAtomic(config(sandbox), REAL_CONFIG);
    await enable(sandbox);

    // After `on` the user re-picks the default, enables their own tool, and
    // edits an annotation-free scalar. All of that must survive `off`.
    const managed = await readFile(config(sandbox), "utf8");
    await writeFileAtomic(
      config(sandbox),
      managed
        .replace(`default: ${MODEL}`, "default: zai-org/GLM-5.1-tuned")
        .replace("    - ponytail\n", "    - ponytail\n    - my-tool\n")
        .replace("max_turns: 90", "max_turns: 120"),
    );

    await disable(sandbox);

    const doc = await readConfig(sandbox);
    expect(doc.model).toEqual({
      default: "zai-org/GLM-5.1-tuned", // user's pick survives
      provider: "acme", // ours reverts to pre-on
      base_url: "https://api.acme-llm.invalid/v1",
      api_key: "acme-older-key", // keys `on` deleted come back
      api_mode: "chat_completions",
    });
    expect(doc.plugins.enabled).toEqual(["ponytail", "my-tool"]);
    expect(doc.plugins.enabled).not.toContain(PLUGIN_NAME);
    expect(doc.agent.max_turns).toBe(120);
  });

  it("does not re-add the enabled entry the user removed after on", async () => {
    await writeFileAtomic(config(sandbox), REAL_CONFIG);
    await enable(sandbox);

    const raw = await readFile(config(sandbox), "utf8");
    await writeFileAtomic(
      config(sandbox),
      raw.replace(`    - ${PLUGIN_NAME}\n`, ""),
    );

    await disable(sandbox);

    const doc = await readConfig(sandbox);
    expect(doc.model.provider).toBe("acme");
    expect(doc.plugins.enabled).toEqual(["ponytail"]);
  });

  it("keeps an enabled entry the user owned, without uninstalling", async () => {
    // The user enabled the plugin before ever running frlink: the
    // pre-on snapshot proves the entry is theirs and the install was not ours.
    await writeFileAtomic(
      config(sandbox),
      `model:\n  default: acme/models/some-llm-v2\n  provider: acme\nplugins:\n  enabled:\n    - ponytail\n    - ${PLUGIN_NAME}\nagent:\n  max_turns: 90\n`,
    );
    await enable(sandbox, { installedByUs: false });

    const result = await disable(sandbox);

    expect(result).toEqual({ outcome: "restored", uninstallPlugin: false });
    expect((await readConfig(sandbox)).plugins.enabled).toEqual([
      "ponytail",
      PLUGIN_NAME,
    ]);
  });

  it("keeps a pre-on enabled entry even when the uninstall is ours", async () => {
    await writeFileAtomic(
      config(sandbox),
      `model:\n  default: m\n  provider: acme\nplugins:\n  enabled:\n    - ${PLUGIN_NAME}\n`,
    );
    await enable(sandbox);

    const { uninstallPlugin } = await disable(sandbox);

    expect(uninstallPlugin).toBe(true);
    expect((await readConfig(sandbox)).plugins.enabled).toContain(PLUGIN_NAME);
  });

  it("drops our enabled entry even when the install pre-dated us", async () => {
    await writeFileAtomic(
      config(sandbox),
      `model:\n  default: m\n  provider: acme\nplugins:\n  enabled:\n    - ponytail\n`,
    );
    await enable(sandbox, { installedByUs: false });

    const { uninstallPlugin } = await disable(sandbox);

    expect(uninstallPlugin).toBe(false);
    const doc = await readConfig(sandbox);
    expect(doc.plugins.enabled).toEqual(["ponytail"]);
    expect(doc.plugins.enabled).not.toContain(PLUGIN_NAME);
  });

  it("restores the legacy FriendliAI custom_providers it migrated away", async () => {
    await writeFileAtomic(
      config(sandbox),
      `model:\n  default: m\n  provider: acme\ncustom_providers:\n- name: FriendliAI\n  base_url: https://old.example.invalid\n  api_key: leaked-key\n- name: FriendliAI No Thinking\n  base_url: https://old.example.invalid\n- name: Ollama\n  base_url: http://localhost:11434/v1\n`,
    );
    await enable(sandbox);

    await disable(sandbox);

    const doc = (await readConfig(sandbox)) as {
      custom_providers: { name: string }[];
    };
    expect(doc.custom_providers.map((entry) => entry.name).sort()).toEqual(
      ["FriendliAI", "FriendliAI No Thinking", "Ollama"].sort(),
    );
    expect(await readFile(config(sandbox), "utf8")).toContain("leaked-key");
  });

  it("leaves the user's re-added FriendliAI entry untouched", async () => {
    await writeFileAtomic(
      config(sandbox),
      `model:\n  default: m\n  provider: acme\ncustom_providers:\n- name: FriendliAI\n  base_url: https://old.example.invalid\n`,
    );
    await enable(sandbox);

    // After `on` the user configures their own FriendliAI entry.
    const raw = await readFile(config(sandbox), "utf8");
    await writeFileAtomic(
      config(sandbox),
      raw.replace(
        "custom_providers: []\n",
        "custom_providers:\n- name: FriendliAI\n  base_url: https://user.example.invalid\n",
      ),
    );

    await disable(sandbox);

    const doc = (await readConfig(sandbox)) as {
      custom_providers: { name: string; base_url: string }[];
    };
    const friendliEntries = doc.custom_providers.filter(
      (entry) => entry.name === "FriendliAI",
    );
    expect(friendliEntries).toHaveLength(1);
    expect(friendliEntries[0]?.base_url).toBe("https://user.example.invalid");
  });

  it("honors a plugins block the user deleted after on", async () => {
    await writeFileAtomic(
      config(sandbox),
      `model:\n  default: m\n  provider: acme\nplugins:\n  enabled:\n    - ponytail\n  disabled:\n    - ${PLUGIN_NAME}\n`,
    );
    await enable(sandbox);

    // The user removes the whole plugins block after `on`.
    await writeFileAtomic(
      config(sandbox),
      `model:\n  default: ${MODEL}\n  provider: friendli\nagent:\n  max_turns: 90\n`,
    );

    await disable(sandbox);

    const doc = await readConfig(sandbox);
    expect(doc.plugins).toBeUndefined();
    expect(doc.model.provider).toBe("acme");
  });

  it("is a no-op when neither backup nor state survive", async () => {
    await enable(sandbox);
    await loseBackup(sandbox);
    await rm(stateFile(sandbox));

    await expect(disable(sandbox)).resolves.toEqual({
      outcome: "none",
      uninstallPlugin: false,
    });
  });

  it("prunes an empty plugins block only it created", async () => {
    // Pre-on config had no plugins block; on added one; the user removed our
    // entry by hand — off must not leave `plugins: {enabled: []}` husks.
    await writeFileAtomic(
      config(sandbox),
      `model:\n  default: m\n  provider: acme\n`,
    );
    await enable(sandbox);

    const raw = await readFile(config(sandbox), "utf8");
    await writeFileAtomic(
      config(sandbox),
      raw.replace(`    - ${PLUGIN_NAME}\n`, ""),
    );

    await disable(sandbox);

    expect((await readConfig(sandbox)).plugins).toBeUndefined();
  });
});

describe("hermes off without a backup (state-only strip)", () => {
  let sandbox: Sandbox;
  let logs: string[];
  let log: typeof console.log;
  let savedKey: string | undefined;

  /** A context aimed at the sandbox with prompts off, a pinned model, and the
   * key from env — so `on` never hits the network. */
  function ctx() {
    return {
      ...createBaseContext(),
      home: sandbox.home,
      onboardingMode: "skip" as const,
      main: MODEL,
    };
  }

  /** A fake hermes: records calls; a successful `plugins remove` also
   * deletes the install directory (like the real CLI) so the post-removal
   * re-probe passes. */
  function recordingRunner(ok: boolean, stderr = "", home?: string) {
    const calls: string[][] = [];
    return {
      calls,
      run: async (_file: string, args: string[]) => {
        calls.push(args);
        if (ok && home && args[1] === "remove") {
          const { rmSync } = await import("node:fs");
          rmSync(path.join(home, ".hermes", "plugins", PLUGIN_NAME), {
            recursive: true,
            force: true,
          });
        }
        return { ok, stdout: "", stderr };
      },
    };
  }

  beforeEach(async () => {
    sandbox = await createSandboxHome();
    savedKey = process.env[FRIENDLI_API_KEY_ENV];
    process.env[FRIENDLI_API_KEY_ENV] = "friendli-key-1234";
    logs = [];
    log = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
  });

  afterEach(async () => {
    setHermesPluginRunnerForTests(null);
    console.log = log;
    if (savedKey === undefined) {
      delete process.env[FRIENDLI_API_KEY_ENV];
    } else {
      process.env[FRIENDLI_API_KEY_ENV] = savedKey;
    }
    await sandbox.cleanup();
  });

  it("strips our fields, orders the uninstall, and says so honestly", async () => {
    const installRunner = recordingRunner(true);
    setHermesPluginRunnerForTests(installRunner.run);
    await hermesAdapter.on(ctx());
    // The runner fakes hermes; create the install dir it would have made.
    mkdirSync(path.join(sandbox.home, ".hermes", "plugins", PLUGIN_NAME), {
      recursive: true,
    });
    await loseBackup(sandbox);

    const removalRunner = recordingRunner(true, "", sandbox.home);
    setHermesPluginRunnerForTests(removalRunner.run);
    await hermesAdapter.off(ctx());

    expect(removalRunner.calls).toEqual([REMOVE_ARGS]);
    const doc = await readConfig(sandbox);
    expect(doc.model).toBeUndefined();
    expect(doc.plugins.enabled).toEqual([]);
    expect(existsSync(stateFile(sandbox))).toBe(false);
    expect(logs.join("\n")).toContain("stripped of frlink-owned fields");
    expect(logs.join("\n")).not.toContain(
      "restored to its pre-FriendliAI state",
    );
  });

  it("keeps a user-changed model.default but strips the rest of ours", async () => {
    await enable(sandbox);
    const raw = await readFile(config(sandbox), "utf8");
    await writeFileAtomic(
      config(sandbox),
      raw.replace(`default: ${MODEL}`, "default: zai-org/GLM-5.1-tuned"),
    );
    await loseBackup(sandbox);

    const result = await disable(sandbox);

    expect(result).toEqual({
      outcome: "restored",
      uninstallPlugin: true,
      strippedWithoutBackup: true,
    });
    expect((await readConfig(sandbox)).model).toEqual({
      default: "zai-org/GLM-5.1-tuned",
    });
  });

  it("preserves an unprovable enabled entry when the install pre-dated us", async () => {
    await enable(sandbox, { installedByUs: false });
    await loseBackup(sandbox);

    const result = await disable(sandbox);

    expect(result).toEqual({
      outcome: "restored",
      uninstallPlugin: false,
      strippedWithoutBackup: true,
    });
    const doc = await readConfig(sandbox);
    expect(doc.model).toBeUndefined();
    expect(doc.plugins.enabled).toEqual([PLUGIN_NAME]);
    expect(existsSync(stateFile(sandbox))).toBe(false);
  });

  it("forgets the state even when the config is missing", async () => {
    await enable(sandbox);
    await rm(config(sandbox));
    await loseBackup(sandbox);

    // The state file proves a managed lifecycle even with the config
    // gone: uninstall is still owed (and nothing config-side reverts —
    // the missing file must not be recreated, only the state is dropped).
    await expect(disable(sandbox)).resolves.toEqual({
      outcome: "restored",
      uninstallPlugin: true,
      strippedWithoutBackup: true,
    });
    expect(existsSync(config(sandbox))).toBe(false);
    expect(existsSync(stateFile(sandbox))).toBe(false);
  });
});

describe("hermes adapter lifecycle", () => {
  let sandbox: Sandbox;
  let logs: string[];
  let log: typeof console.log;
  let savedKey: string | undefined;

  function ctx() {
    return {
      ...createBaseContext(),
      home: sandbox.home,
      onboardingMode: "skip" as const,
      main: MODEL,
    };
  }

  /** A fake hermes: records calls; a successful `plugins remove` also
   * deletes the install directory (like the real CLI) so the post-removal
   * re-probe passes. */
  function recordingRunner(ok: boolean, stderr = "", home?: string) {
    const calls: string[][] = [];
    return {
      calls,
      run: async (_file: string, args: string[]) => {
        calls.push(args);
        if (ok && home && args[1] === "remove") {
          const { rmSync } = await import("node:fs");
          rmSync(path.join(home, ".hermes", "plugins", PLUGIN_NAME), {
            recursive: true,
            force: true,
          });
        }
        return { ok, stdout: "", stderr };
      },
    };
  }

  beforeEach(async () => {
    sandbox = await createSandboxHome();
    savedKey = process.env[FRIENDLI_API_KEY_ENV];
    process.env[FRIENDLI_API_KEY_ENV] = "friendli-key-1234";
    logs = [];
    log = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
  });

  afterEach(async () => {
    setHermesPluginRunnerForTests(null);
    console.log = log;
    if (savedKey === undefined) {
      delete process.env[FRIENDLI_API_KEY_ENV];
    } else {
      process.env[FRIENDLI_API_KEY_ENV] = savedKey;
    }
    await sandbox.cleanup();
  });

  it("on installs once, writes the dotenv key, and marks the harness enabled", async () => {
    await writeFileAtomic(config(sandbox), REAL_CONFIG);
    const runner = recordingRunner(true);
    setHermesPluginRunnerForTests(runner.run);

    await hermesAdapter.on(ctx());

    expect(runner.calls).toEqual([INSTALL_ARGS]);
    expect(await readFile(getDotenvPath(sandbox.home), "utf8")).toBe(
      `${FRIENDLI_API_KEY_ENV}=friendli-key-1234\n`,
    );
    expect(await isFriendliManaged(config(sandbox))).toBe(true);
    expect((await readGlobalConfig(sandbox.home)).harnesses.hermes).toEqual({
      enabled: true,
    });
  });

  it("off uninstalls, restores the config, and reverts the dotenv key", async () => {
    await writeFileAtomic(config(sandbox), REAL_CONFIG);
    setHermesPluginRunnerForTests(recordingRunner(true).run);
    await hermesAdapter.on(ctx());
    // The runner fakes hermes; create the install dir it would have made.
    mkdirSync(path.join(sandbox.home, ".hermes", "plugins", PLUGIN_NAME), {
      recursive: true,
    });

    const removalRunner = recordingRunner(true, "", sandbox.home);
    setHermesPluginRunnerForTests(removalRunner.run);
    await hermesAdapter.off(ctx());

    expect(removalRunner.calls).toEqual([REMOVE_ARGS]);
    expect(await readFile(config(sandbox), "utf8")).toBe(REAL_CONFIG);
    // `off` reverts the dotenv key under our ownership contract: the user
    // had no FRIENDLIAI_API_KEY line before `on`, so the line `on` wrote —
    // and the file `on` created — is removed.
    await expect(
      readFile(getDotenvPath(sandbox.home), "utf8"),
    ).rejects.toThrow();
    expect((await readGlobalConfig(sandbox.home)).harnesses.hermes).toEqual({
      enabled: false,
    });
  });

  it("on discards a fresh snapshot and writes nothing when the install fails", async () => {
    await writeFileAtomic(config(sandbox), REAL_CONFIG);
    const runner = recordingRunner(false, "install failed");
    setHermesPluginRunnerForTests(runner.run);

    await expect(hermesAdapter.on(ctx())).rejects.toThrow(/install failed/);

    expect(runner.calls).toEqual([INSTALL_ARGS]);
    expect(await readFile(config(sandbox), "utf8")).toBe(REAL_CONFIG);
    expect(existsSync(backupFile(sandbox))).toBe(false);
    expect(existsSync(stateFile(sandbox))).toBe(false);
    expect(existsSync(getDotenvPath(sandbox.home))).toBe(false);
  });

  it("on fails fatally on a broken dotenv write, keeping the config untouched", async () => {
    if (process.getuid?.() === 0) {
      return; // root ignores file modes — the broken-dotenv trick relies on them
    }
    await writeFileAtomic(config(sandbox), REAL_CONFIG);
    // A directory named `.env` makes every write strategy fail while
    // config.yaml in the same directory stays writable.
    mkdirSync(getDotenvPath(sandbox.home));
    const runner = recordingRunner(true);
    setHermesPluginRunnerForTests(runner.run);

    await expect(hermesAdapter.on(ctx())).rejects.toMatchObject({
      code: "EISDIR",
    });

    expect(await readFile(config(sandbox), "utf8")).toBe(REAL_CONFIG);
    expect(existsSync(backupFile(sandbox))).toBe(false);
    expect(existsSync(stateFile(sandbox))).toBe(false);
    expect(logs.some((line) => line.includes("routed through Friendli"))).toBe(
      false,
    );
  });

  it("a pre-existing backup survives a failed on; a later off still restores", async () => {
    if (process.getuid?.() === 0) {
      return; // root ignores file modes — the broken-dotenv trick relies on them
    }
    await writeFileAtomic(config(sandbox), REAL_CONFIG);
    setHermesPluginRunnerForTests(recordingRunner(true).run);
    await hermesAdapter.on(ctx());
    const backupBefore = await readFile(backupFile(sandbox), "utf8");

    // Break the dotenv for a second `on`: its failure must not take the
    // prior `on`'s recovery state down with it.
    await rm(getDotenvPath(sandbox.home));
    mkdirSync(getDotenvPath(sandbox.home));
    await expect(hermesAdapter.on(ctx())).rejects.toMatchObject({
      code: "EISDIR",
    });
    expect(await readFile(backupFile(sandbox), "utf8")).toBe(backupBefore);

    await hermesAdapter.off(ctx());
    expect(await readFile(config(sandbox), "utf8")).toBe(REAL_CONFIG);
  });

  it("off throws on a failed removal before reverting anything, staying retryable", async () => {
    await writeFileAtomic(config(sandbox), REAL_CONFIG);
    setHermesPluginRunnerForTests(recordingRunner(true).run);
    await hermesAdapter.on(ctx());
    // The runner fakes hermes; create the install dir it would have made.
    mkdirSync(path.join(sandbox.home, ".hermes", "plugins", PLUGIN_NAME), {
      recursive: true,
    });

    setHermesPluginRunnerForTests(recordingRunner(false, "remove failed").run);
    await expect(hermesAdapter.off(ctx())).rejects.toThrow(
      /remove failed[\s\S]*retry: frlink hermes off/,
    );

    // Removal-first: nothing was reverted and every recovery artifact
    // survives, so an `off` retry does the full job again.
    expect(await isFriendliManaged(config(sandbox))).toBe(true);
    expect(existsSync(backupFile(sandbox))).toBe(true);
    expect(existsSync(stateFile(sandbox))).toBe(true);
    expect(logs.join("\n")).not.toContain(
      "restored to its pre-FriendliAI state",
    );
  });

  it("off throws when hermes reports removal but the plugin directory remains", async () => {
    await writeFileAtomic(config(sandbox), REAL_CONFIG);
    setHermesPluginRunnerForTests(recordingRunner(true).run);
    await hermesAdapter.on(ctx());
    // Simulate a zero-exit removal that deleted nothing.
    mkdirSync(path.join(sandbox.home, ".hermes", "plugins", PLUGIN_NAME), {
      recursive: true,
    });

    await expect(hermesAdapter.off(ctx())).rejects.toThrow(
      /directory still exists[\s\S]*retry: frlink hermes off/,
    );

    // Removal-first: the config hasn't been reverted yet — recovery
    // state intact, retryable.
    expect(await isFriendliManaged(config(sandbox))).toBe(true);
  });
});

describe("hermes adapter surfaces", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await createSandboxHome();
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it("registers with the expected id and label", () => {
    expect(hermesAdapter.id).toBe("hermes");
    expect(hermesAdapter.label).toBe("Hermes Agent");
  });

  it("providerStatus follows the plugin-enabled model block", async () => {
    const ctx = {
      ...createBaseContext(),
      home: sandbox.home,
      onboardingMode: "skip" as const,
    };
    expect(await hermesAdapter.providerStatus(ctx)).toBe("default");

    await enable(sandbox);
    expect(await hermesAdapter.providerStatus(ctx)).toBe("friendli");
  });

  it("on fails rather than overwrite a .env it cannot record", async () => {
    // Recordable-strictness: overwriting the user's key line without
    // having recorded what it held would make their value unrecoverable
    // on `off`, so an UNREADABLE .env must fail `on` outright — not warn
    // and plow on. Skipped under root (root ignores file modes).
    if (process.getuid?.() === 0) {
      return;
    }
    const home = sandbox.home;
    const hermesDir = `${home}/.hermes`;
    mkdirSync(hermesDir, { recursive: true });
    // A directory named `.env` makes every read and write strategy fail.
    mkdirSync(`${hermesDir}/.env`);

    const log = console.log;
    console.log = () => {};
    try {
      process.env[FRIENDLI_API_KEY_ENV] = "friendli-key-1234";
      const ctx = {
        ...createBaseContext(),
        home,
        main: MODEL,
        onboardingMode: "skip",
      } as const;
      await expect(hermesAdapter.on(ctx)).rejects.toThrow();
    } finally {
      delete process.env[FRIENDLI_API_KEY_ENV];
      console.log = log;
    }
    // And the config must not have been switched: on failed before the
    // config write.
    await expect(readFile(config(sandbox), "utf8")).rejects.toThrow();
  });

  it("is not managed when the provider is set but the plugin is missing", async () => {
    await writeFileAtomic(
      config(sandbox),
      `model:\n  default: ${MODEL}\n  provider: friendli\n`,
    );

    expect(await isFriendliManaged(config(sandbox))).toBe(false);
  });
});

describe("hermes plugin commands", () => {
  it("installs from the github source and removes by plugin name", async () => {
    const calls: string[][] = [];
    const run = async (_file: string, args: string[]) => {
      calls.push(args);
      return { ok: true, stdout: "", stderr: "" };
    };

    await installFriendliPlugin(run);
    await removeFriendliPlugin(run);

    expect(calls).toEqual([INSTALL_ARGS, REMOVE_ARGS]);
  });

  it("treats an already-installed plugin as success (idempotent on)", async () => {
    const run = async () => ({
      ok: false,
      stdout: "",
      stderr: `Error: Plugin '${PLUGIN_NAME}' already exists. Use force reinstall.`,
    });

    await expect(installFriendliPlugin(run)).resolves.toBeUndefined();
  });

  it("surfaces hermes' output when the install fails", async () => {
    const run = async () => ({
      ok: false,
      stdout: "",
      stderr: "connection refused",
    });

    await expect(installFriendliPlugin(run)).rejects.toThrow(
      /connection refused/,
    );
  });
});
