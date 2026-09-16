import { mkdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBaseContext } from "../../../src/harness/types.js";

// Cursor couches the key in Electron safeStorage ciphertext when the security
// CLI + keychain entry is available; the plaintext seam keeps tests off the
// real login Keychain entirely. The OSCrypt schemes themselves are covered by
// safestorage.test.ts with injected passwords.
process.env.FRLINK_SECRET_PLAINTEXT = "1";

const { ensureItemTable, readItemTableValue } =
  await import("../../../src/system/sqlite.js");
const {
  APPLICATION_USER_KEY,
  CURSOR_AUTH_OPENAI_KEY,
  CURSOR_AUTH_OPENAI_KEY_SECRET,
  cursorDataDir,
  cursorHasManagedMarkers,
  disableFriendliForCursor,
  enableFriendliForCursor,
  managedModels,
  parseBlob,
} = await import("../../../src/harnesses/cursor/core.js");
const { cursorAdapter } =
  await import("../../../src/harnesses/cursor/index.js");

import { cursorKeyWritesForTests } from "../../../src/harnesses/cursor/core.js";
import {
  emptyOwnership,
  storeOwnership,
} from "../../../src/harnesses/cursor/ownership.js";
import { createSandboxHome, type Sandbox } from "../../helpers.js";

/** Cursor's per-mode model. `on` never writes it — these tests assert that —
 * but `off` still reverts the modes an older release wrote. */
function cursorCurrentModelId(
  blob: ReturnType<typeof parseBlob>,
  mode: string,
): string {
  const config = blob.aiSettings?.modelConfig as
    | Record<
        string,
        { modelName?: unknown; selectedModels?: Array<{ modelId?: unknown }> }
      >
    | undefined;
  const cfg = config?.[mode];
  if (typeof cfg?.modelName === "string" && cfg.modelName) {
    return cfg.modelName;
  }
  const selected = cfg?.selectedModels?.[0]?.modelId;
  return typeof selected === "string" ? selected : "";
}

const API_BASE = "https://api.friendli.ai/serverless/v1";
const MODEL = "zai-org/GLM-5.2";
const CATALOG_IDS = ["zai-org/GLM-5.2", "deepseek-ai/DeepSeek-V3.2"];

// A realistic pre-existing applicationUser blob: mode configs carrying the
// user's prior selection, a custom model they added themselves, and Cursor's
// built-in catalogue listing.
const APPLICATION_USER_SEED = {
  openAIBaseUrl: null,
  useOpenAIKey: false,
  availableDefaultModels2: [{ name: "composer-2.5" }, { name: "auto-smart" }],
  aiSettings: {
    userAddedModels: ["custom/UserModel"],
    modelOverrideEnabled: ["custom/UserModel"],
    modelConfig: {
      composer: {
        modelName: "custom/UserModel",
        selectedModels: [{ modelId: "custom/UserModel", parameters: [] }],
      },
      "cmd-k": {
        modelName: "auto-smart",
        selectedModels: [{ modelId: "auto-smart", parameters: [] }],
      },
    },
  },
};

describe("cursor core", () => {
  let sandbox: Sandbox;
  let dbPath: string;
  let dataDir: string;

  beforeEach(async () => {
    sandbox = await createSandboxHome();
    dbPath = path.join(sandbox.home, "state.vscdb");
    dataDir = cursorDataDir(sandbox.home);
    await mkdir(path.dirname(dbPath), { recursive: true });
    await ensureItemTable(dbPath);
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  async function seed(
    appUser: unknown = APPLICATION_USER_SEED,
    key = "users-own-openai-key",
  ): Promise<void> {
    const { applyItemTableWrites } =
      await import("../../../src/system/sqlite.js");
    if (appUser !== null) {
      await applyItemTableWrites(dbPath, [
        {
          op: "set",
          key: APPLICATION_USER_KEY,
          value: JSON.stringify(appUser as object),
        },
      ]);
    }
    if (key !== null) {
      await applyItemTableWrites(dbPath, [
        { op: "set", key: "cursorAuth/openAIKey", value: key },
      ]);
    }
  }

  async function enable(overrides: Record<string, unknown> = {}) {
    return enableFriendliForCursor({
      dbPath,
      dataDir,
      apiKey: "test-key",
      apiKeySource: "env",
      baseUrl: API_BASE,
      model: MODEL,
      catalogIds: CATALOG_IDS,
      ...overrides,
    });
  }

  function blob(): Promise<ReturnType<typeof parseBlob>> {
    return readItemTableValue(dbPath, APPLICATION_USER_KEY).then(parseBlob);
  }

  it("routes the OpenAI override at Friendli and registers the catalog", async () => {
    await seed(APPLICATION_USER_SEED);
    await enable();

    const raw = await readItemTableValue(dbPath, APPLICATION_USER_KEY);
    const next = parseBlob(raw);
    expect(next.openAIBaseUrl).toBe(API_BASE);
    expect(next.useOpenAIKey).toBe(true);

    const ai = next.aiSettings as Record<string, unknown>;
    expect(ai.userAddedModels).toEqual(
      expect.arrayContaining(["custom/UserModel", ...CATALOG_IDS]),
    );
    expect(ai.modelOverrideEnabled).toEqual(
      expect.arrayContaining(CATALOG_IDS),
    );

    // Cursor's per-conversation model is left entirely alone: `on` puts the
    // models in the picker and nothing else chooses for the user.
    expect(cursorCurrentModelId(next, "composer")).toBe("custom/UserModel");
    expect(cursorCurrentModelId(next, "cmd-k")).toBe("auto-smart");

    // User's own custom model survives...
    expect(ai.modelOverrideDisabled).not.toContain("custom/UserModel");
    // ...while Cursor built-ins the Friendli endpoint can't serve are hidden
    // from both lists (an enabled id overrides a disabled one).
    expect(ai.modelOverrideDisabled).toEqual(
      expect.arrayContaining(["auto-smart", "composer-2.5"]),
    );
    expect(ai.modelOverrideEnabled).not.toContain("auto-smart");

    expect(managedModels(next)).toEqual(expect.arrayContaining(CATALOG_IDS));
    expect(cursorHasManagedMarkers(next)).toBe(true);

    // Key cells: legacy plaintext + the (seam) secret:// value.
    expect(await readItemTableValue(dbPath, CURSOR_AUTH_OPENAI_KEY)).toBe(
      "test-key",
    );
    expect(
      await readItemTableValue(dbPath, CURSOR_AUTH_OPENAI_KEY_SECRET),
    ).toBe("test-key");
  });

  it("habituates a never-configured DB (Cursor fresh install)", async () => {
    await enable();

    const next = await blob();
    expect(next.openAIBaseUrl).toBe(API_BASE);
    expect(cursorCurrentModelId(next, "composer")).toBe("");
  });

  /** Offline with nothing registered before, `on` would hide Cursor's own
   * models and offer none of ours — an editor that cannot answer. Refuse
   * instead, before any write. */
  it("refuses rather than registering nothing when the catalog is unreachable", async () => {
    await seed(APPLICATION_USER_SEED);
    const before = await readItemTableValue(dbPath, APPLICATION_USER_KEY);

    await expect(enable({ catalogIds: [] })).rejects.toThrow(
      /could not fetch/i,
    );
    expect(await readItemTableValue(dbPath, APPLICATION_USER_KEY)).toBe(before);
  });

  /** …but an earlier run's models are a good enough fallback to stay up. */
  it("keeps the previously registered models when the catalog is unreachable", async () => {
    await seed(APPLICATION_USER_SEED);
    await enable();
    await enable({ catalogIds: [] });

    expect(managedModels(await blob())).toEqual(
      expect.arrayContaining(CATALOG_IDS),
    );
  });

  it("restores the user's blob and key byte-for-byte on disable", async () => {
    await seed(APPLICATION_USER_SEED, "users-own-openai-key");
    await enable();

    const outcome = await disableFriendliForCursor({ dbPath, dataDir });
    expect(outcome.outcome).toBe("restored");

    const raw = await readItemTableValue(dbPath, APPLICATION_USER_KEY);
    expect(JSON.parse(raw)).toEqual(APPLICATION_USER_SEED);
    expect(await readItemTableValue(dbPath, CURSOR_AUTH_OPENAI_KEY)).toBe(
      "users-own-openai-key",
    );
    expect(cursorHasManagedMarkers(parseBlob(raw))).toBe(false);
  });

  it("restore matches Cursor's 'no key' shape when the user had no key", async () => {
    await seed(APPLICATION_USER_SEED, null);
    await enable();

    const outcome = await disableFriendliForCursor({ dbPath, dataDir });
    expect(outcome.outcome).toBe("restored");
    await expect(
      readItemTableValue(dbPath, CURSOR_AUTH_OPENAI_KEY),
    ).resolves.toBe("");
    expect(
      await readItemTableValue(dbPath, CURSOR_AUTH_OPENAI_KEY_SECRET),
    ).toBe(JSON.stringify({ type: "Buffer", data: [] }));
  });

  it("reports a cleared cell as cleared, not as one we left alone", async () => {
    await seed(APPLICATION_USER_SEED, null);
    await enable();

    // Putting the cell back to empty *is* restoring the user's prior state,
    // so `off` must not claim it left the cell as the user set it.
    expect((await disableFriendliForCursor({ dbPath, dataDir })).apiKey).toBe(
      "cleared",
    );
  });

  /** The ownership rule reaches the key cell too: a cell the user emptied
   * while we were on is theirs, and `off` must not push a pre-`on` key back
   * into it. An empty cell alone is not enough to conclude that, though — a
   * ciphertext we cannot decrypt also reads as empty, and that one still has
   * to be cleared or the Friendli key leaks. */
  it("leaves the key cell alone when the user emptied it after `on`", async () => {
    await seed(APPLICATION_USER_SEED, "users-own-openai-key");
    await enable();

    const { applyItemTableWrites } =
      await import("../../../src/system/sqlite.js");
    await applyItemTableWrites(dbPath, [
      { op: "del", key: CURSOR_AUTH_OPENAI_KEY },
      { op: "del", key: CURSOR_AUTH_OPENAI_KEY_SECRET },
    ]);

    const outcome = await disableFriendliForCursor({ dbPath, dataDir });
    expect(outcome.apiKey).toBe("left");
    expect(await readItemTableValue(dbPath, CURSOR_AUTH_OPENAI_KEY)).toBe("");
    // …and the blob still reverted; only the key cell was off limits.
    expect(
      JSON.parse(await readItemTableValue(dbPath, APPLICATION_USER_KEY)),
    ).toEqual(APPLICATION_USER_SEED);
  });

  /** Clearing the key in Cursor's own UI leaves the row in place holding an
   * empty ciphertext, which must read as an empty cell and not as one holding
   * something we failed to decrypt. */
  it("treats Cursor's empty-ciphertext cell as emptied, not as unreadable", async () => {
    await seed(APPLICATION_USER_SEED, "users-own-openai-key");
    await enable();

    const { applyItemTableWrites } =
      await import("../../../src/system/sqlite.js");
    await applyItemTableWrites(dbPath, [
      { op: "del", key: CURSOR_AUTH_OPENAI_KEY },
      {
        op: "set",
        key: CURSOR_AUTH_OPENAI_KEY_SECRET,
        value: JSON.stringify({ type: "Buffer", data: [] }),
      },
    ]);

    expect((await disableFriendliForCursor({ dbPath, dataDir })).apiKey).toBe(
      "left",
    );
  });

  it("puts the user's key back when the cell still holds ours", async () => {
    await seed(APPLICATION_USER_SEED, "users-own-openai-key");
    await enable();

    const outcome = await disableFriendliForCursor({ dbPath, dataDir });
    expect(outcome.apiKey).toBe("restored");
    expect(await readItemTableValue(dbPath, CURSOR_AUTH_OPENAI_KEY)).toBe(
      "users-own-openai-key",
    );
  });

  it("leaves a key the user replaced with their own after `on`", async () => {
    await seed(APPLICATION_USER_SEED, "users-own-openai-key");
    await enable();

    const { applyItemTableWrites } =
      await import("../../../src/system/sqlite.js");
    await applyItemTableWrites(dbPath, [
      {
        op: "set",
        key: CURSOR_AUTH_OPENAI_KEY,
        value: "a-brand-new-openai-key",
      },
      {
        op: "set",
        key: CURSOR_AUTH_OPENAI_KEY_SECRET,
        value: "a-brand-new-openai-key",
      },
    ]);

    const outcome = await disableFriendliForCursor({ dbPath, dataDir });
    expect(outcome.apiKey).toBe("left");
    expect(await readItemTableValue(dbPath, CURSOR_AUTH_OPENAI_KEY)).toBe(
      "a-brand-new-openai-key",
    );
  });

  it("deletes the applicationUser row on disable if it never existed", async () => {
    await enable();

    const outcome = await disableFriendliForCursor({ dbPath, dataDir });
    expect(outcome.outcome).toBe("restored");
    expect(await readItemTableValue(dbPath, APPLICATION_USER_KEY)).toBe("");
  });

  it("re-enable keeps the original snapshot and refreshes the picker list", async () => {
    await seed(APPLICATION_USER_SEED);
    await enable();
    await enable({ catalogIds: [...CATALOG_IDS, "zai-org/GLM-5.1"] });

    const next = await blob();
    expect(managedModels(next)).toEqual(
      expect.arrayContaining([...CATALOG_IDS, "zai-org/GLM-5.1"]),
    );

    await disableFriendliForCursor({ dbPath, dataDir });
    const raw = await readItemTableValue(dbPath, APPLICATION_USER_KEY);
    expect(JSON.parse(raw)).toEqual(APPLICATION_USER_SEED);
  });

  /** The ownership record lives on the blob, not in our data dir, so losing
   * the backup no longer costs the true prior values — only the user's
   * previous API key, which is the one thing the record cannot carry. The old
   * code reset touched modes to Cursor's "default" here. */
  it("still reverts to the real prior values when the backup is gone", async () => {
    await seed(APPLICATION_USER_SEED);
    await enable();
    const { readdir, rm } = await import("node:fs/promises");
    const backups = await readdir(dataDir);
    for (const name of backups) {
      await rm(path.join(dataDir, name));
    }

    const outcome = await disableFriendliForCursor({ dbPath, dataDir });
    expect(outcome.outcome).toBe("restored");

    const next = await blob();
    expect(next.useOpenAIKey).toBe(false);
    expect(next.openAIBaseUrl).toBe(null);
    expect(
      (next.aiSettings as Record<string, unknown>).userAddedModels,
    ).toEqual(["custom/UserModel"]);
    expect((next.aiSettings as Record<string, unknown>).modelConfig).toEqual({
      composer: expect.objectContaining({ modelName: "custom/UserModel" }),
      "cmd-k": expect.objectContaining({ modelName: "auto-smart" }),
    });
    expect(cursorCurrentModelId(next, "composer")).toBe("custom/UserModel");
    // The seed had no hide list; we created it, so it goes away entirely.
    expect(
      Object.hasOwn(next.aiSettings as object, "modelOverrideDisabled"),
    ).toBe(false);
    expect(cursorHasManagedMarkers(next)).toBe(false);
  });

  /** The property the revert-then-apply design exists for: `on` first undoes
   * the previous run, so however many times it runs, `off` lands in the same
   * place. Without it, the second `on` records the first one's values as the
   * user's priors and `off` can never get back. */
  it("is idempotent: on;on;off leaves the same blob as on;off", async () => {
    await seed(APPLICATION_USER_SEED);
    await enable();
    await disableFriendliForCursor({ dbPath, dataDir });
    const once = await readItemTableValue(dbPath, APPLICATION_USER_KEY);

    await seed(APPLICATION_USER_SEED);
    await enable();
    await enable();
    await enable({ catalogIds: [...CATALOG_IDS, "zai-org/GLM-5.1"] });
    await disableFriendliForCursor({ dbPath, dataDir });
    const thrice = await readItemTableValue(dbPath, APPLICATION_USER_KEY);

    expect(JSON.parse(thrice)).toEqual(JSON.parse(once));
    expect(JSON.parse(thrice)).toEqual(APPLICATION_USER_SEED);
  });

  /** `off` on a Cursor we never touched must not write at all — not even a
   * re-serialized version of the same JSON. */
  it("writes nothing at all when it does not own the database", async () => {
    await seed(APPLICATION_USER_SEED);
    const before = await readItemTableValue(dbPath, APPLICATION_USER_KEY);

    const result = await disableFriendliForCursor({ dbPath, dataDir });
    expect(result.outcome).toBe("none");
    expect(await readItemTableValue(dbPath, APPLICATION_USER_KEY)).toBe(before);
  });

  /** A second `off` is a no-op, and a following `on` starts from a genuinely
   * clean world. */
  it("survives off -> off -> on", async () => {
    await seed(APPLICATION_USER_SEED);
    await disableFriendliForCursor({ dbPath, dataDir });
    expect((await disableFriendliForCursor({ dbPath, dataDir })).outcome).toBe(
      "none",
    );

    await enable();
    expect((await blob()).openAIBaseUrl).toBe(API_BASE);
    await disableFriendliForCursor({ dbPath, dataDir });
    expect(
      JSON.parse(await readItemTableValue(dbPath, APPLICATION_USER_KEY)),
    ).toEqual(APPLICATION_USER_SEED);
  });

  /** A model the user picked themselves after `on` is theirs, and survives. */
  it("leaves a mode the user re-picked after `on`", async () => {
    await seed(APPLICATION_USER_SEED);
    await enable();

    const { applyItemTableWrites } =
      await import("../../../src/system/sqlite.js");
    const live = await blob();
    const ai = live.aiSettings as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    ai.modelConfig!.composer!.modelName = "claude-opus-5";
    await applyItemTableWrites(dbPath, [
      { op: "set", key: APPLICATION_USER_KEY, value: JSON.stringify(live) },
    ]);

    await disableFriendliForCursor({ dbPath, dataDir });
    expect(cursorCurrentModelId(await blob(), "composer")).toBe(
      "claude-opus-5",
    );
  });

  /** The reason `off` stopped writing the snapshot back wholesale. Cursor owns
   * almost every key in this row — MCP servers, ignore rules, composer state —
   * and keeps writing to it the whole time we are enabled. Restoring the
   * pre-`on` bytes rolled all of that back. */
  it("leaves Cursor's own state alone, including keys written after `on`", async () => {
    await seed(APPLICATION_USER_SEED);
    await enable();

    const { applyItemTableWrites } =
      await import("../../../src/system/sqlite.js");
    const live = await blob();
    const withCursorState = {
      ...live,
      mcpServers: { github: { command: "npx" } },
      cursorIgnore: ["secrets/**"],
      composerState: { lastOpened: 1234 },
    };
    await applyItemTableWrites(dbPath, [
      {
        op: "set",
        key: APPLICATION_USER_KEY,
        value: JSON.stringify(withCursorState),
      },
    ]);

    await disableFriendliForCursor({ dbPath, dataDir });

    const next = await blob();
    expect(next.mcpServers).toEqual({ github: { command: "npx" } });
    expect(next.cursorIgnore).toEqual(["secrets/**"]);
    expect(next.composerState).toEqual({ lastOpened: 1234 });
    // …and our own routing is still gone.
    expect(next.openAIBaseUrl).toBe(null);
    expect(cursorHasManagedMarkers(next)).toBe(false);
  });

  it("never touches a hand-configured Cursor (no markers, no backup)", async () => {
    await seed(APPLICATION_USER_SEED);
    // A user's own OpenAI routing — not our markers, no backup.
    const { applyItemTableWrites } =
      await import("../../../src/system/sqlite.js");
    const selfRouted = {
      ...APPLICATION_USER_SEED,
      useOpenAIKey: true,
      openAIBaseUrl: "https://my-proxy.example/v1",
    };
    await applyItemTableWrites(dbPath, [
      {
        op: "set",
        key: APPLICATION_USER_KEY,
        value: JSON.stringify(selfRouted),
      },
    ]);

    const outcome = await disableFriendliForCursor({ dbPath, dataDir });
    expect(outcome.outcome).toBe("none");
    expect(
      JSON.parse(await readItemTableValue(dbPath, APPLICATION_USER_KEY)),
    ).toEqual(selfRouted);
  });

  it("does not snapshot when routing is already ours", async () => {
    const { readdir } = await import("node:fs/promises");
    const countBackups = async () =>
      (await readdir(dataDir)).filter((name) =>
        name.startsWith("cursor-backup."),
      ).length;

    await enable();
    expect(await countBackups()).toBe(1); // from the first enable
    await enable();
    expect(await countBackups()).toBe(1); // re-`on` kept the original snapshot
  });

  /** Cursor reads the encrypted cell before the plaintext one, so a ciphertext
   * left over from an earlier run would keep winning and `on` would report
   * success while Cursor carried on with the old key. */
  it("clears the encrypted key cell when encryption is unavailable", () => {
    const writes = cursorKeyWritesForTests(
      "/nope/state.vscdb",
      "{}",
      "flp_new",
      false,
    );
    expect(writes).toContainEqual({
      op: "del",
      key: "secret://cursorAuth/openAIKey",
    });
    expect(writes).toContainEqual({
      op: "set",
      key: "cursorAuth/openAIKey",
      value: "flp_new",
    });
  });
});

describe("cursor adapter", () => {
  async function scratchDb(): Promise<{ sandbox: Sandbox; dbPath: string }> {
    const sandbox = await createSandboxHome();
    const dbPath = path.join(sandbox.home, "state.vscdb");
    await mkdir(path.dirname(dbPath), { recursive: true });
    await ensureItemTable(dbPath);
    return { sandbox, dbPath };
  }

  it("registers with the expected id and label", () => {
    expect(cursorAdapter.id).toBe("cursor");
    expect(cursorAdapter.label).toBe("Cursor");
  });

  it("providerStatus follows the OpenAI override", async () => {
    const { sandbox, dbPath } = await scratchDb();
    try {
      const { applyItemTableWrites } =
        await import("../../../src/system/sqlite.js");
      const ctx = {
        ...createBaseContext(),
        home: sandbox.home,
        settingsPath: dbPath,
        onboardingMode: "skip",
      } as const;
      expect(await cursorAdapter.providerStatus(ctx)).toBe("default");

      await applyItemTableWrites(dbPath, [
        {
          op: "set",
          key: APPLICATION_USER_KEY,
          value: JSON.stringify({
            useOpenAIKey: true,
            openAIBaseUrl: API_BASE,
          }),
        },
      ]);
      expect(await cursorAdapter.providerStatus(ctx)).toBe("friendli");
    } finally {
      await sandbox.cleanup();
    }
  });

  /** Captures `status`'s JSON without letting it reach the terminal. */
  async function statusJson(ctx: Parameters<typeof cursorAdapter.status>[0]) {
    const lines: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => void lines.push(args.join(" "));
    try {
      await cursorAdapter.status({ ...ctx, json: true });
    } finally {
      console.log = log;
    }
    return JSON.parse(lines.join("\n")) as {
      managed: boolean;
      apiKeySource: string | null;
      ours: boolean;
      baseUrl: string | null;
      expectedBaseUrl: string;
    };
  }

  it("says to launch Cursor first when it has never created a profile", async () => {
    const sandbox = await createSandboxHome();
    try {
      // No state.vscdb: Cursor writes it on first launch. Without this guard
      // `on` dies on the raw SQLite "unable to open database file".
      const missing = path.join(sandbox.home, "never", "state.vscdb");
      await expect(
        cursorAdapter.on({
          ...createBaseContext(),
          home: sandbox.home,
          settingsPath: missing,
          dataDir: path.join(sandbox.home, "data"),
          onboardingMode: "skip" as const,
          force: true,
        }),
      ).rejects.toThrow(/never been launched/);
    } finally {
      await sandbox.cleanup();
    }
  });

  it("managed turns on with `on` and off again with `off`", async () => {
    const { sandbox, dbPath } = await scratchDb();
    try {
      const ctx = {
        ...createBaseContext(),
        home: sandbox.home,
        settingsPath: dbPath,
        dataDir: cursorDataDir(sandbox.home),
        onboardingMode: "skip" as const,
      };
      expect((await statusJson(ctx)).managed).toBe(false);

      await enableFriendliForCursor({
        dbPath,
        dataDir: cursorDataDir(sandbox.home),
        apiKey: "flp_key",
        apiKeySource: "keychain",
        baseUrl: API_BASE,
        catalogIds: CATALOG_IDS,
      });
      const on = await statusJson(ctx);
      expect(on.managed).toBe(true);
      expect(on.ours).toBe(true);
      expect(on.apiKeySource).toBe("keychain");
      expect(on.baseUrl).toBe(API_BASE);

      await disableFriendliForCursor({
        dbPath,
        dataDir: cursorDataDir(sandbox.home),
      });
      const off = await statusJson(ctx);
      expect(off.managed).toBe(false);
      expect(off.ours).toBe(false);
      expect(off.baseUrl).toBeNull();
    } finally {
      await sandbox.cleanup();
    }
  });

  it("reports a run against another endpoint as ours, not as unmanaged", async () => {
    const { sandbox, dbPath } = await scratchDb();
    const staging = "https://staging.example/v1";
    try {
      const ctx = {
        ...createBaseContext(),
        home: sandbox.home,
        settingsPath: dbPath,
        dataDir: cursorDataDir(sandbox.home),
        onboardingMode: "skip" as const,
      };
      await enableFriendliForCursor({
        dbPath,
        dataDir: cursorDataDir(sandbox.home),
        apiKey: "flp_key",
        apiKeySource: "env",
        baseUrl: staging,
        catalogIds: CATALOG_IDS,
      });

      // Default endpoint: not what this invocation targets, so not `managed` —
      // but still ours, and the key source must survive the distinction.
      const plain = await statusJson(ctx);
      expect(plain.managed).toBe(false);
      expect(plain.ours).toBe(true);
      expect(plain.baseUrl).toBe(staging);
      expect(plain.apiKeySource).toBe("env");

      // Ask about that endpoint and it is `managed` after all.
      const aimed = await statusJson({
        ...ctx,
        baseUrl: staging,
        baseUrlFromFlag: true,
      });
      expect(aimed.managed).toBe(true);
      expect(aimed.expectedBaseUrl).toBe(staging);
    } finally {
      await sandbox.cleanup();
    }
  });

  it("refuses a typed --model but ignores one broadcast by `all on`", async () => {
    const { sandbox, dbPath } = await scratchDb();
    try {
      const base = {
        ...createBaseContext(),
        home: sandbox.home,
        settingsPath: dbPath,
        dataDir: cursorDataDir(sandbox.home),
        onboardingMode: "skip" as const,
        apiKey: "flp_key",
        apiKeyFromFlag: false,
        main: MODEL,
      };
      // `cursor on --model X`: the user asked for something Cursor cannot do.
      await expect(
        cursorAdapter.on({ ...base, mainFromFlag: true }),
      ).rejects.toThrow(/takes no --model/);

      // `all on`: one selection pinned on every harness. Cursor is not the
      // reason that run should fail, so the model is ignored, not refused.
      // Everything past the guard (the running-IDE check, the key, the
      // catalog fetch) is out of scope here and may legitimately fail — what
      // must not happen is failing on the model.
      const broadcast = await cursorAdapter
        .on({ ...base, mainFromFlag: false })
        .then(() => "")
        .catch((error: Error) => error.message);
      expect(broadcast).not.toMatch(/takes no --model/);
    } finally {
      await sandbox.cleanup();
    }
  });

  it("providerStatus flags a half-finished teardown via our markers", async () => {
    const { sandbox, dbPath } = await scratchDb();
    try {
      const { applyItemTableWrites } =
        await import("../../../src/system/sqlite.js");
      const ctx = {
        ...createBaseContext(),
        home: sandbox.home,
        settingsPath: dbPath,
        onboardingMode: "skip",
      } as const;
      // Base URL and key cell cleared, but our ownership record survives —
      // still ours to clean up, so `off` must see it.
      const owned: Record<string, unknown> = { aiSettings: {} };
      storeOwnership(owned, emptyOwnership({ model: MODEL }));
      await applyItemTableWrites(dbPath, [
        {
          op: "set",
          key: APPLICATION_USER_KEY,
          value: JSON.stringify({
            useOpenAIKey: false,
            openAIBaseUrl: null,
            aiSettings: owned.aiSettings,
          }),
        },
      ]);
      expect(await cursorAdapter.providerStatus(ctx)).toBe("friendli");
    } finally {
      await sandbox.cleanup();
    }
  });
});
