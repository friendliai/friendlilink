import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBaseContext } from "../../../src/harness/types.js";
import {
  codexDataDir,
  configPath,
  disableFriendliForCodex,
  enableFriendliForCodex,
  isFriendliManaged,
  readFriendliStatus,
} from "../../../src/harnesses/codex/core.js";
import {
  patchFriendliRoutingRaw,
  rootString,
  stripFriendliRoutingRaw,
} from "../../../src/harnesses/codex/toml-patch.js";
import {
  pickCodexDefaults,
  profilePath,
  restoreProfileFromSnapshot,
} from "../../../src/harnesses/codex/profile.js";
import { writeFileAtomic } from "../../../src/io/atomic-write.js";
import { createSandboxHome, type Sandbox } from "../../helpers.js";

// Modelled on a real config.toml carrying state frlink must not
// disturb: trusted project paths and TUI state in their own tables.
const USER_CONFIG = `model = "gpt-5.5"
model_provider = "openai"

[projects."/Users/woojin/test"]
trust_level = "trusted"

[tui.model_availability_nux]
"gpt-5.5" = 4
`;

const API_BASE = "https://api.friendli.ai/serverless/v1";
const MODEL = "zai-org/GLM-5.2";

function patch(raw: string, apiKey = "test-key") {
  return patchFriendliRoutingRaw(raw, {
    providerId: "friendliai",
    providerName: "FriendliAI",
    baseUrl: API_BASE,
    modelId: MODEL,
    apiKey,
  });
}

describe("codex toml patch", () => {
  it("writes the guide's routing keys while preserving user tables verbatim", () => {
    const patched = patch(USER_CONFIG);

    // Guide-verbatim routing at the top...
    expect(patched.split("\n").slice(0, 2).join("\n")).toBe(
      `model_provider = "friendliai"\nmodel = "${MODEL}"`,
    );
    // ...user tables survive byte-for-byte...
    expect(patched).toContain(
      `[projects."/Users/woojin/test"]\ntrust_level = "trusted"\n`,
    );
    expect(patched).toContain(`[tui.model_availability_nux]\n"gpt-5.5" = 4`);
    // ...and the provider table holds exactly the guide's keys.
    const table = patched.slice(
      patched.indexOf("[model_providers.friendliai]"),
    );
    expect(table).toBe(
      `[model_providers.friendliai]
name = "FriendliAI"
base_url = "${API_BASE}"
experimental_bearer_token = "test-key"
wire_api = "responses"
`,
    );
  });

  it("escapes quotes and backslashes in TOML string values", () => {
    const patched = patch('model = ""', 'key"with\\chars');
    expect(patched).toContain(
      `experimental_bearer_token = "key\\"with\\\\chars"`,
    );
  });

  it("serializes exactly the supplied static telemetry headers as an inline TOML map", () => {
    const patched = patchFriendliRoutingRaw("", {
      providerId: "friendliai",
      providerName: "FriendliAI",
      baseUrl: API_BASE,
      modelId: MODEL,
      apiKey: "test-key",
      telemetryHeaders: {
        "X-Title": "Codex",
        "HTTP-Referer": "frlink/v1.2.3",
      },
    });

    expect(
      patched.split("\n").filter((line) => line.startsWith("http_headers = ")),
    ).toEqual([
      'http_headers = { "X-Title" = "Codex", "HTTP-Referer" = "frlink/v1.2.3" }',
    ]);
  });

  it("starts a fresh file the same way", () => {
    const patched = patch("");
    expect(patched).toBe(
      `model_provider = "friendliai"
model = "${MODEL}"

[model_providers.friendliai]
name = "FriendliAI"
base_url = "${API_BASE}"
experimental_bearer_token = "test-key"
wire_api = "responses"
`,
    );
  });

  it("is idempotent when applied to its own output", () => {
    const once = patch(USER_CONFIG);
    const twice = patch(once);
    expect(twice).toBe(once);
  });

  it("replaces an existing friendliai table instead of duplicating it", () => {
    const once = patch(USER_CONFIG, "old-key");
    const twice = patch(once, "new-key");
    expect(twice.match(/\[model_providers\.friendliai\]/g)).toHaveLength(1);
    expect(twice).toContain(`experimental_bearer_token = "new-key"`);
    expect(twice).not.toContain(`experimental_bearer_token = "old-key"`);

    // Root model/model_provider also stay single.
    expect(twice.match(/^model_provider =/gm)).toHaveLength(1);
    expect(twice.match(/^model =/gm)).toHaveLength(1);
  });

  it("strip removes only frlink's footprint", () => {
    const stripped = stripFriendliRoutingRaw(patch(USER_CONFIG), {
      providerId: "friendliai",
      stripRootRouting: true,
    });
    // Only the routing keys and provider table go; the user's own
    // model/provider (from USER_CONFIG) must not come back duplicated by
    // layout — their original root keys were stripped too, since they are
    // the same root keys. Their *tables* are untouched:
    expect(stripped).toContain(`[projects."/Users/woojin/test"]`);
    expect(stripped).not.toContain(`[model_providers.friendliai]`);
    expect(stripped).not.toMatch(/^model_provider = "friendliai"$/m);
  });

  it("rootString reads root-level keys and stops at the first table", () => {
    expect(rootString(USER_CONFIG, "model")).toBe("gpt-5.5");
    expect(rootString(USER_CONFIG, "model_provider")).toBe("openai");
    // Keys inside tables are not root keys.
    expect(rootString(USER_CONFIG, "trust_level")).toBeNull();
    expect(rootString("", "model")).toBeNull();
  });

  /** A header with a trailing comment used to fail the "is this a table
   * header?" test, so the root-key stripper kept running past it and deleted
   * the `model` / `model_provider` lines INSIDE that table. */
  it("does not eat keys inside a table whose header carries a comment", () => {
    const patched = patch(
      `[profiles.work]  # my work profile\nmodel = "gpt-5.5-codex"\nmodel_provider = "openai"\n`,
    );
    expect(patched).toContain(`model = "gpt-5.5-codex"`);
    expect(patched).toContain(`model_provider = "openai"`);
  });

  /** Our own table has to be recognised however the user spelled it —
   * otherwise `on` appends a second one, and a duplicate table is a TOML
   * parse error that stops Codex from starting at all. */
  it("replaces the provider table whatever spelling it was written in", () => {
    for (const header of [
      `[model_providers.friendliai]`,
      `[ model_providers.friendliai ]`,
      `[model_providers.friendliai] # mine`,
      `[model_providers."friendliai"]`,
    ]) {
      const patched = patch(
        `model_provider = "friendliai"\n${header}\nname = "X"\nexperimental_bearer_token = "their-key"\n`,
      );
      const tables =
        patched.match(/\[\s*model_providers\s*\.\s*"?friendliai"?\s*\]/g) ?? [];
      expect(tables, `spelling: ${header}`).toHaveLength(1);
      expect(patched, `spelling: ${header}`).not.toContain("their-key");
    }
  });

  it("still treats array-of-tables as ending the root scope", () => {
    const patched = patch(`model = "old"\n[[mcp_servers]]\nname = "x"\n`);
    expect(patched).toContain(`[[mcp_servers]]`);
    expect(patched).toContain(`name = "x"`);
  });
});

describe("codex core", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await createSandboxHome();
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  function enable(options: Record<string, unknown> = {}) {
    return enableFriendliForCodex({
      configPath: configPath(sandbox.home),
      dataDir: codexDataDir(sandbox.home),
      apiKey: "test-key",
      apiKeySource: "env",
      baseUrl: API_BASE,
      model: MODEL,
      home: sandbox.home,
      ...options,
    });
  }

  it("patches a real-world config and restores it byte-for-byte on disable", async () => {
    const original = USER_CONFIG.replace("gpt-5.5", "claude-x");
    await writeFileAtomic(configPath(sandbox.home), original);

    await enable();

    expect(await isFriendliManaged(configPath(sandbox.home))).toBe(true);
    const status = await readFriendliStatus(configPath(sandbox.home));
    expect(status).toEqual({ managed: true, model: MODEL });

    const { outcome } = await disableFriendliForCodex({
      configPath: configPath(sandbox.home),
      dataDir: codexDataDir(sandbox.home),
      home: sandbox.home,
    });
    expect(outcome).toBe("restored");
    expect(await readFile(configPath(sandbox.home), "utf8")).toBe(original);
    expect(await isFriendliManaged(configPath(sandbox.home))).toBe(false);
  });

  it("works when config.toml did not exist, deleting it again on disable", async () => {
    await enable();

    const { outcome } = await disableFriendliForCodex({
      configPath: configPath(sandbox.home),
      dataDir: codexDataDir(sandbox.home),
      home: sandbox.home,
    });
    expect(outcome).toBe("restored");
    await expect(readFile(configPath(sandbox.home), "utf8")).rejects.toThrow();
  });

  it("bakes the supplied static telemetry map into the provider config", async () => {
    await enable({
      telemetryHeaders: {
        "X-Title": "Codex",
        "HTTP-Referer": "frlink/v1.2.3",
      },
    });

    const config = await readFile(configPath(sandbox.home), "utf8");
    expect(
      config.split("\n").filter((line) => line.startsWith("http_headers = ")),
    ).toEqual([
      'http_headers = { "X-Title" = "Codex", "HTTP-Referer" = "frlink/v1.2.3" }',
    ]);
  });

  it("re-enable preserves user headers while replacing stale telemetry headers", async () => {
    const userTrace = 'keep \\ and "quoted"';
    const userTraceTomlValue = JSON.stringify(userTrace);

    await writeFileAtomic(
      configPath(sandbox.home),
      `model_provider = "friendliai"
model = "old-model"

[model_providers.friendliai]
name = "FriendliAI"
base_url = "https://old.example/v1"
experimental_bearer_token = "old-key"
http_headers = { "X-User-Trace" = ${userTraceTomlValue}, "x-title" = "stale title", "HTTP-REFERER" = "https://example.com/stale" }
`,
    );
    const telemetryHeaders = {
      "X-Title": "Codex",
      "HTTP-Referer": "frlink/v1.2.3",
    };

    await enable({ telemetryHeaders });
    await enable({ telemetryHeaders });

    const config = await readFile(configPath(sandbox.home), "utf8");
    expect(
      config.split("\n").filter((line) => line.startsWith("http_headers = ")),
    ).toEqual([
      `http_headers = { "X-User-Trace" = ${userTraceTomlValue}, "X-Title" = "Codex", "HTTP-Referer" = "frlink/v1.2.3" }`,
    ]);
    expect(config).not.toContain('"x-title"');
    expect(config).not.toContain('"HTTP-REFERER"');
  });

  it("recognizes quoted http_headers keys and preserves their user values", async () => {
    await writeFileAtomic(
      configPath(sandbox.home),
      `model_provider = "friendliai"
model = "old-model"

[model_providers.friendliai]
name = "FriendliAI"
base_url = "https://old.example/v1"
experimental_bearer_token = "old-key"
"http_headers" = { "X-User-Trace" = "keep" }
`,
    );
    const telemetryHeaders = {
      "X-Title": "Codex",
      "HTTP-Referer": "frlink/v1.2.3",
    };

    await enable({ telemetryHeaders });

    const config = await readFile(configPath(sandbox.home), "utf8");
    expect(
      config.split("\n").filter((line) => line.startsWith("http_headers = ")),
    ).toEqual([
      'http_headers = { "X-User-Trace" = "keep", "X-Title" = "Codex", "HTTP-Referer" = "frlink/v1.2.3" }',
    ]);
    expect(config).not.toContain('"http_headers" =');
  });

  it("rejects an http_headers sub-table instead of silently dropping it", async () => {
    await writeFileAtomic(
      configPath(sandbox.home),
      `model_provider = "friendliai"
model = "old-model"

[model_providers.friendliai]
name = "FriendliAI"
base_url = "https://old.example/v1"
experimental_bearer_token = "old-key"

[model_providers.friendliai.http_headers]
X-User-Trace = "keep"
`,
    );

    await expect(enable()).rejects.toThrow(
      /sub-table \[model_providers\.friendliai\.http_headers\]/,
    );
  });

  it("re-enable keeps the earliest snapshot of user content", async () => {
    await writeFileAtomic(configPath(sandbox.home), USER_CONFIG);
    await enable();
    // The user edits their config while frlink is enabled.
    await writeFileAtomic(
      configPath(sandbox.home),
      `${patch(USER_CONFIG)}\n# my note`,
    );
    await enable();

    const { outcome } = await disableFriendliForCodex({
      configPath: configPath(sandbox.home),
      dataDir: codexDataDir(sandbox.home),
      home: sandbox.home,
    });
    expect(outcome).toBe("restored");
    expect(await readFile(configPath(sandbox.home), "utf8")).toBe(USER_CONFIG);
  });

  it("disable is a no-op when nothing was ever enabled", async () => {
    const { outcome } = await disableFriendliForCodex({
      configPath: configPath(sandbox.home),
      dataDir: codexDataDir(sandbox.home),
      home: sandbox.home,
    });
    expect(outcome).toBe("none");
  });
});

describe("codex adapter", () => {
  it("registers with the expected id and label", async () => {
    const { codexAdapter } =
      await import("../../../src/harnesses/codex/index.js");
    expect(codexAdapter.id).toBe("codex");
    expect(codexAdapter.label).toBe("Codex");
  });

  it("declares support for static telemetry headers", async () => {
    const { codexAdapter } =
      await import("../../../src/harnesses/codex/index.js");
    expect(codexAdapter.telemetryHeaders).toBe(true);
  });

  it("providerStatus follows config.toml's provider", async () => {
    const sandbox = await createSandboxHome();
    try {
      const { codexAdapter } =
        await import("../../../src/harnesses/codex/index.js");
      const ctx = {
        ...createBaseContext(),
        home: sandbox.home,
        onboardingMode: "skip",
      } as const;
      expect(await codexAdapter.providerStatus(ctx)).toBe("default");

      await writeFileAtomic(configPath(sandbox.home), patch(USER_CONFIG));
      expect(await codexAdapter.providerStatus(ctx)).toBe("friendli");
    } finally {
      await sandbox.cleanup();
    }
  });
});

describe("codex escape-hatch profile", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await createSandboxHome();
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  function enable(options: Record<string, unknown> = {}) {
    return enableFriendliForCodex({
      configPath: configPath(sandbox.home),
      dataDir: codexDataDir(sandbox.home),
      apiKey: "test-key",
      apiKeySource: "env",
      baseUrl: API_BASE,
      model: MODEL,
      home: sandbox.home,
      ...options,
    });
  }

  function disable() {
    return disableFriendliForCodex({
      configPath: configPath(sandbox.home),
      dataDir: codexDataDir(sandbox.home),
      home: sandbox.home,
    });
  }

  it("writes a profile naming the provider Codex used before", async () => {
    await writeFileAtomic(configPath(sandbox.home), USER_CONFIG);
    const result = await enable();

    expect(result.restoreProfileName).toBe("openai");
    const written = await readFile(
      profilePath(sandbox.home, "openai", configPath(sandbox.home)),
      "utf8",
    );
    expect(written).toContain(`model_provider = "openai"`);
    expect(written).toContain(`model = "gpt-5.5"`);
    // It is an escape hatch, not a credential store.
    expect(written).not.toContain("test-key");
  });

  it("names the profile openai when there was no prior config", async () => {
    const result = await enable();
    expect(result.restoreProfileName).toBe("openai");
    const written = await readFile(
      profilePath(sandbox.home, "openai", configPath(sandbox.home)),
      "utf8",
    );
    expect(written).toContain(`model_provider = "openai"`);
    // Whether a model line appears depends on Codex being installed to report
    // its default; either way it must never be the Friendli model.
    expect(written).not.toContain(MODEL);
  });

  /** A profile layers over config.toml and cannot unset a key, so with no model
   * of its own the hatch would inherit the Friendli model `on` wrote at root
   * and send it to OpenAI. */
  it("pins Codex's default model when the user had none", () => {
    expect(restoreProfileFromSnapshot("", { model: "gpt-5.6-sol" })).toEqual({
      modelProvider: "openai",
      model: "gpt-5.6-sol",
    });
  });

  it("prefers the user's own model over the fallback", () => {
    expect(
      restoreProfileFromSnapshot(USER_CONFIG, { model: "gpt-5.6-sol" }),
    ).toEqual({
      modelProvider: "openai",
      model: "gpt-5.5",
    });
  });

  /** `on` writes an effort tuned for a Friendli model at root; without an
   * override the hatch inherits it, including "none". */
  it("pins a reasoning effort so the hatch does not inherit Friendli's", () => {
    expect(
      restoreProfileFromSnapshot("", {
        model: "gpt-5.6-sol",
        reasoningEffort: "low",
      }),
    ).toEqual({
      modelProvider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
    });
  });

  it("prefers the user's own effort over the fallback", () => {
    const prior = `model_provider = "openai"\nmodel = "gpt-5.5"\nmodel_reasoning_effort = "high"\n`;
    expect(
      restoreProfileFromSnapshot(prior, { model: "x", reasoningEffort: "low" }),
    ).toMatchObject({ reasoningEffort: "high" });
  });

  /** Shaped like `codex debug models`, whose entries carry a per-model
   * default_reasoning_level. */
  const CODEX_CATALOG = [
    {
      slug: "gpt-5.6-sol",
      priority: 1,
      visibility: "list",
      default_reasoning_level: "low",
    },
    {
      slug: "gpt-5.5",
      priority: 7,
      visibility: "list",
      default_reasoning_level: "medium",
    },
    {
      slug: "gpt-5.4",
      priority: 16,
      visibility: "hide",
      default_reasoning_level: "medium",
    },
  ];

  it("picks Codex's own top-priority listed model when none was named", () => {
    expect(pickCodexDefaults(CODEX_CATALOG)).toEqual({
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
    });
  });

  /** The effort has to come from the model the hatch pins. Reading it off
   * Codex's top-priority model instead wrote `low` (sol's default) into a
   * hatch pinning gpt-5.5, silently downgrading the user's reasoning. */
  it("takes the effort from the named model, not the top-priority one", () => {
    expect(pickCodexDefaults(CODEX_CATALOG, "gpt-5.5")).toEqual({
      model: "gpt-5.5",
      reasoningEffort: "medium",
    });
  });

  it("pins a model Codex does not know without inventing an effort", () => {
    expect(pickCodexDefaults(CODEX_CATALOG, "some/custom-model")).toEqual({
      model: "some/custom-model",
    });
  });

  it("reads TOML literal strings as well as basic ones", () => {
    expect(
      restoreProfileFromSnapshot(
        `model_provider = 'azure'\nmodel = 'deployment'\n`,
      ),
    ).toEqual({
      modelProvider: "azure",
      model: "deployment",
    });
  });

  /** A second `on` must derive from the snapshot, not the live config — which
   * by then already says friendliai, making the hatch point back at Friendli. */
  it("keeps pointing at the original provider across a re-enable", async () => {
    await writeFileAtomic(configPath(sandbox.home), USER_CONFIG);
    await enable();
    await enable();

    const written = await readFile(
      profilePath(sandbox.home, "openai", configPath(sandbox.home)),
      "utf8",
    );
    expect(written).toContain(`model_provider = "openai"`);
    expect(written).not.toContain("friendliai");
  });

  it("removes the profile on disable", async () => {
    await writeFileAtomic(configPath(sandbox.home), USER_CONFIG);
    await enable();
    await disable();

    await expect(
      readFile(
        profilePath(sandbox.home, "openai", configPath(sandbox.home)),
        "utf8",
      ),
    ).rejects.toThrow();
  });

  it("hands back a pre-existing profile of the user's own", async () => {
    const theirs = `model_provider = "openai"\nmodel = "gpt-4.1"\n`;
    await writeFileAtomic(configPath(sandbox.home), USER_CONFIG);
    await writeFileAtomic(
      profilePath(sandbox.home, "openai", configPath(sandbox.home)),
      theirs,
    );

    await enable();
    await disable();

    expect(
      await readFile(
        profilePath(sandbox.home, "openai", configPath(sandbox.home)),
        "utf8",
      ),
    ).toBe(theirs);
  });

  /** Leaving the edit in place is only safe if our snapshot of it goes too;
   * otherwise the next `on` skips snapshotting and a later `off` restores the
   * stale copy over the edit. */
  it("drops its snapshot when it leaves a hand-edited profile alone", async () => {
    await writeFileAtomic(configPath(sandbox.home), USER_CONFIG);
    await enable();

    const edited = `model_provider = "openai"\nmodel = "gpt-4.1"\n`;
    const target = profilePath(
      sandbox.home,
      "openai",
      configPath(sandbox.home),
    );
    await writeFileAtomic(target, edited);
    await disable();

    // Re-enable and disable again: the edit must still be there.
    await enable();
    await writeFileAtomic(target, edited);
    await disable();
    expect(await readFile(target, "utf8")).toBe(edited);
  });

  it("leaves a profile the user edited after `on` alone", async () => {
    await writeFileAtomic(configPath(sandbox.home), USER_CONFIG);
    await enable();

    const edited = `model_provider = "openai"\nmodel = "gpt-4.1"\n`;
    await writeFileAtomic(
      profilePath(sandbox.home, "openai", configPath(sandbox.home)),
      edited,
    );
    await disable();

    expect(
      await readFile(
        profilePath(sandbox.home, "openai", configPath(sandbox.home)),
        "utf8",
      ),
    ).toBe(edited);
  });

  /** `on` skips snapshotting a config that already names the friendliai
   * provider — a hand-written one is indistinguishable from ours — so `off`
   * finds no config backup. It must still take back the profile it wrote;
   * returning early there stranded the file and its bookkeeping for good. */
  /** A config naming the friendliai provider is not proof WE wrote it — users
   * hand-configure Friendli in Codex too, and one did. Treating that as
   * "already managed" skipped the snapshot, so `off` had nothing to restore
   * and reported "not managed; nothing to do" over a config still routed at
   * Friendli, carrying the key `on` had written over theirs. */
  it("snapshots a friendliai config the user wrote by hand", async () => {
    const handWritten =
      `model_provider = "friendliai"\nmodel = "zai-org/GLM-5.1"\n\n` +
      `[model_providers.friendliai]\nname = "FriendliAI"\n` +
      `experimental_bearer_token = "their-own-key"\n`;
    await writeFileAtomic(configPath(sandbox.home), handWritten);
    await enable();

    const { outcome, profileRemoved } = await disable();
    expect(outcome).toBe("restored");
    expect(profileRemoved).toBe(true);
    // Byte-for-byte, including the key that was theirs before we touched it.
    expect(await readFile(configPath(sandbox.home), "utf8")).toBe(handWritten);
    await expect(
      readFile(
        profilePath(sandbox.home, "openai", configPath(sandbox.home)),
        "utf8",
      ),
    ).rejects.toThrow();
  });

  /** The second `on` must not re-snapshot over the first one's record — that
   * is what the managed check is actually for. */
  it("keeps the first snapshot when a re-enable finds its own state", async () => {
    const handWritten = `model_provider = "friendliai"\nmodel = "zai-org/GLM-5.1"\n`;
    await writeFileAtomic(configPath(sandbox.home), handWritten);
    await enable();
    await enable();
    await disable();

    expect(await readFile(configPath(sandbox.home), "utf8")).toBe(handWritten);
  });
});
