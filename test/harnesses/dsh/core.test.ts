import { readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  DEFAULT_DSH_PROFILE,
  disableFriendliForDsh,
  dshDataDir,
  dshHome,
  dshProfile,
  enableFriendliForDsh,
  isFriendliManaged,
  manifestPathOf,
  patchPathOf,
  PLUGIN_BUNDLE,
  readProviderState,
} from "../../../src/harnesses/dsh/core.js";
import { writeFileAtomic } from "../../../src/io/atomic-write.js";
import { writeJson } from "../../../src/io/json.js";
import { createSandboxHome, type Sandbox } from "../../helpers.js";

const MODEL = "zai-org/GLM-5.2";

function profileDir(sandbox: Sandbox): string {
  return dshProfile(sandbox.home, DEFAULT_DSH_PROFILE);
}

function enable(sandbox: Sandbox, options: Record<string, unknown> = {}) {
  return enableFriendliForDsh({
    home: sandbox.home,
    dataDir: dshDataDir(sandbox.home),
    apiKeySource: "env",
    model: MODEL,
    profile: DEFAULT_DSH_PROFILE,
    ...options,
  });
}

function disable(sandbox: Sandbox, options: Record<string, unknown> = {}) {
  return disableFriendliForDsh({
    home: sandbox.home,
    dataDir: dshDataDir(sandbox.home),
    profile: DEFAULT_DSH_PROFILE,
    ...options,
  });
}

async function writeManifest(sandbox: Sandbox, bundles: string[]) {
  await writeJson(manifestPathOf(profileDir(sandbox)), {
    dsh: { profile: { bundles } },
  });
}

describe("dsh core", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    delete process.env.DSH_HOME;
    sandbox = await createSandboxHome();
  });

  afterEach(async () => {
    delete process.env.DSH_HOME;
    await sandbox.cleanup();
  });

  it("resolves dshHome honoring $DSH_HOME, and overrides short-circuit", () => {
    expect(dshHome(sandbox.home)).toBe(join(sandbox.home, ".dsh"));

    const custom = join(sandbox.home, "elsewhere");
    process.env.DSH_HOME = custom;
    expect(dshHome(sandbox.home)).toBe(custom);
    expect(dshProfile(sandbox.home, DEFAULT_DSH_PROFILE)).toBe(
      join(custom, "profiles", DEFAULT_DSH_PROFILE),
    );

    // Blank (whitespace-only) overrides fall back to the default.
    process.env.DSH_HOME = "   ";
    expect(dshHome(sandbox.home)).toBe(join(sandbox.home, ".dsh"));

    delete process.env.DSH_HOME;
    expect(dshProfile(sandbox.home, DEFAULT_DSH_PROFILE)).toBe(
      join(sandbox.home, ".dsh", "profiles", DEFAULT_DSH_PROFILE),
    );
    expect(dshProfile(sandbox.home, "web", "/explicit/dir")).toBe(
      "/explicit/dir",
    );
    expect(dshDataDir(sandbox.home)).toBe(join(sandbox.home, ".frlink", "dsh"));
    expect(dshDataDir(sandbox.home, "/state/override")).toBe("/state/override");
  });

  it.each(["", ".", "..", "node_modules", "a/b", "a\\b"])(
    "rejects invalid profile names before resolving even an override: %j",
    (profile) => {
      expect(() => dshProfile(sandbox.home, profile)).toThrow(
        /invalid profile name/,
      );
      expect(() => dshProfile(sandbox.home, profile, "/explicit/dir")).toThrow(
        /invalid profile name/,
      );
    },
  );

  it.each(["web", " my profile ", "한글", ".hidden", "a..b", "Node_Modules"])(
    "preserves upstream-valid profile names verbatim: %j",
    (profile) => {
      expect(dshProfile(sandbox.home, profile)).toBe(
        join(dshHome(sandbox.home), "profiles", profile),
      );
    },
  );

  it("creates the patch with the agent-default-model row on a missing file", async () => {
    await expect(
      readFile(patchPathOf(profileDir(sandbox)), "utf8"),
    ).rejects.toThrow();

    const outcome = await enable(sandbox);
    expect(outcome).toEqual({ model: MODEL });

    const raw = await readFile(patchPathOf(profileDir(sandbox)), "utf8");
    expect(YAML.parse(raw)).toEqual([
      {
        id: "agent-default-model",
        config: { provider: "friendli", model: MODEL },
      },
    ]);
  });

  it("stores the patch owner-only", async () => {
    await enable(sandbox);
    expect((await stat(patchPathOf(profileDir(sandbox)))).mode & 0o777).toBe(
      0o600,
    );
  });

  it("refuses a non-empty patch whose root is not a row sequence", async () => {
    await writeFileAtomic(
      patchPathOf(profileDir(sandbox)),
      "not-a-patch: true\n",
    );

    await expect(enable(sandbox)).rejects.toThrow(/expected a YAML array/);

    // The foreign document is untouched — no silent replacement.
    expect(await readFile(patchPathOf(profileDir(sandbox)), "utf8")).toBe(
      "not-a-patch: true\n",
    );
  });

  it("preserves unrelated rows and comments, appending after existing ids", async () => {
    const original =
      "# tuned by hand — keep\n" +
      "- id: tools\n" +
      "  config: {mode: native}\n";
    await writeFileAtomic(patchPathOf(profileDir(sandbox)), original);

    await enable(sandbox);

    const raw = await readFile(patchPathOf(profileDir(sandbox)), "utf8");
    expect(raw).toContain("# tuned by hand — keep");
    const rows = YAML.parse(raw) as {
      id: string;
      config: Record<string, unknown>;
    }[];
    expect(rows.map((row) => row.id)).toEqual(["tools", "agent-default-model"]);
    expect(rows[0].config).toEqual({ mode: "native" });
    expect(rows[1].config).toEqual({ provider: "friendli", model: MODEL });
  });

  it("patches the LAST duplicate agent-default-model row (later rows win)", async () => {
    const original =
      "- id: agent-default-model\n" +
      "  config: {provider: deepseek-official, model: deepseek-v4-flash}\n" +
      "- id: tools\n" +
      "  config: {mode: native}\n" +
      "- id: agent-default-model\n" +
      "  config: {provider: deepseek-official, model: deepseek-v4-flash}\n";
    await writeFileAtomic(patchPathOf(profileDir(sandbox)), original);

    await enable(sandbox);

    const rows = YAML.parse(
      await readFile(patchPathOf(profileDir(sandbox)), "utf8"),
    ) as { id: string; config: Record<string, unknown> }[];
    const modelRows = rows.filter((row) => row.id === "agent-default-model");
    expect(modelRows).toHaveLength(2);
    // The earlier duplicate stays as the user wrote it …
    expect(modelRows[0].config).toEqual({
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
    });
    // … and only the effective final row now routes through Friendli.
    expect(modelRows[1].config).toEqual({ provider: "friendli", model: MODEL });
  });

  it("keeps profile state isolated: enabling B leaves A's state intact", async () => {
    await enable(sandbox, { profile: "a", model: "zai-org/GLM-5.1" });
    await enable(sandbox, { profile: "b", model: "zai-org/GLM-5.2" });

    expect(
      await readProviderState(dshDataDir(sandbox.home), sandbox.home, "a"),
    ).toMatchObject({ profile: "a", model: "zai-org/GLM-5.1" });
    expect(
      await readProviderState(dshDataDir(sandbox.home), sandbox.home, "b"),
    ).toMatchObject({ profile: "b", model: "zai-org/GLM-5.2" });

    // Disabling B must not delete A's state.
    await disable(sandbox, { profile: "b" });
    expect(
      await readProviderState(dshDataDir(sandbox.home), sandbox.home, "a"),
    ).toBeDefined();
  });

  it("replaces an existing agent-default-model row in place", async () => {
    const original =
      "- id: agent-default-model\n" +
      "  config: {provider: deepseek-official, model: deepseek-v4-flash}\n" +
      "- id: tools\n" +
      "  config: {mode: native}\n";
    await writeFileAtomic(patchPathOf(profileDir(sandbox)), original);

    await enable(sandbox);

    const raw = await readFile(patchPathOf(profileDir(sandbox)), "utf8");
    const rows = YAML.parse(raw) as {
      id: string;
      config: Record<string, unknown>;
    }[];
    expect(rows.filter((row) => row.id === "agent-default-model")).toHaveLength(
      1,
    );
    expect(rows.map((row) => row.id)).toEqual(["agent-default-model", "tools"]);
    expect(rows[0].config).toEqual({ provider: "friendli", model: MODEL });
    expect(rows[1].config).toEqual({ mode: "native" });
  });

  it("writes and returns the provider state", async () => {
    await enable(sandbox, { apiKeySource: "flag", model: "zai-org/GLM-5.1" });
    expect(
      await readProviderState(
        dshDataDir(sandbox.home),
        sandbox.home,
        DEFAULT_DSH_PROFILE,
      ),
    ).toEqual({
      apiKeySource: "flag",
      model: "zai-org/GLM-5.1",
      profile: DEFAULT_DSH_PROFILE,
    });
  });

  it("restores the original patch byte-for-byte on disable", async () => {
    const original =
      "# tuned by hand — keep\n" +
      "- id: tools\n" +
      "  config: {mode: native}\n";
    await writeFileAtomic(patchPathOf(profileDir(sandbox)), original);
    await enable(sandbox);

    const outcome = await disable(sandbox);
    expect(outcome).toBe("restored");
    expect(await readFile(patchPathOf(profileDir(sandbox)), "utf8")).toBe(
      original,
    );
    expect(
      await readProviderState(
        dshDataDir(sandbox.home),
        sandbox.home,
        DEFAULT_DSH_PROFILE,
      ),
    ).toBeUndefined();
  });

  it("deletes the patch on disable when it did not exist before enable", async () => {
    await enable(sandbox);
    const outcome = await disable(sandbox);
    expect(outcome).toBe("restored");
    await expect(
      readFile(patchPathOf(profileDir(sandbox)), "utf8"),
    ).rejects.toThrow();
  });

  it.each(["deepseek-official", "friendli"])(
    "off leaves an unowned %s model row byte-for-byte intact",
    async (provider) => {
      const original =
        "# not managed by frlink\n" +
        `- id: agent-default-model\n  config: {provider: ${provider}, model: user-model}\n`;
      const patchPath = patchPathOf(profileDir(sandbox));
      await writeFileAtomic(patchPath, original);

      expect(await disable(sandbox)).toBe("none");
      expect(await readFile(patchPath, "utf8")).toBe(original);
    },
  );

  it.each([
    { provider: "deepseek-official", model: MODEL },
    { provider: "friendli", model: "user-model" },
    { provider: "friendli", model: MODEL, custom: "keep" },
  ])(
    "off preserves a user-edited row when its backup was lost: %j",
    async (config) => {
      await enable(sandbox);
      const dataDir = dshDataDir(sandbox.home);
      for (const name of await readdir(dataDir)) {
        if (name.endsWith("-backup.json")) await rm(join(dataDir, name));
      }
      const patchPath = patchPathOf(profileDir(sandbox));
      const original = YAML.stringify([{ id: "agent-default-model", config }]);
      await writeFileAtomic(patchPath, original);

      expect(await disable(sandbox)).toBe("none");
      expect(await readFile(patchPath, "utf8")).toBe(original);
    },
  );

  it.each([
    { provider: "deepseek-official", model: "user-edit" },
    { provider: "friendli", model: "user-edit" },
    { provider: "friendli", model: MODEL, custom: "keep" },
  ])(
    "re-on snapshots a user-edited row despite stale state after backup loss: %j",
    async (config) => {
      await enable(sandbox);
      const dataDir = dshDataDir(sandbox.home);
      for (const name of await readdir(dataDir)) {
        if (name.endsWith("-backup.json")) await rm(join(dataDir, name));
      }
      const patchPath = patchPathOf(profileDir(sandbox));
      const edited =
        "# user's new selection — keep exactly\n" +
        YAML.stringify([{ id: "agent-default-model", config }]);
      await writeFileAtomic(patchPath, edited);

      await enable(sandbox, { model: "another-model" });
      expect(await disable(sandbox)).toBe("restored");
      expect(await readFile(patchPath, "utf8")).toBe(edited);
    },
  );

  it("removes only the matching owned row when its backup was lost", async () => {
    const patchPath = patchPathOf(profileDir(sandbox));
    await writeFileAtomic(patchPath, "- id: tools\n  config: {mode: native}\n");
    await enable(sandbox);
    const dataDir = dshDataDir(sandbox.home);
    for (const name of await readdir(dataDir)) {
      if (name.endsWith("-backup.json")) await rm(join(dataDir, name));
    }
    expect(await disable(sandbox)).toBe("restored");
    expect(YAML.parse(await readFile(patchPath, "utf8"))).toEqual([
      { id: "tools", config: { mode: "native" } },
    ]);
    expect(
      await readProviderState(dataDir, sandbox.home, DEFAULT_DSH_PROFILE),
    ).toBeUndefined();
  });

  it("returns none on disable when no backup exists", async () => {
    expect(await disable(sandbox)).toBe("none");
  });

  it("bakes telemetry headers into the plugin config row at on", async () => {
    const patchPath = patchPathOf(profileDir(sandbox));
    const original =
      "- id: tools\n  config: {mode: native}\n" +
      '- id: "@friendliai/dsh-llm-friendli"\n  config: {thinking: enabled}\n';
    await writeFileAtomic(patchPath, original);

    await enable(sandbox, {
      telemetryHeaders: {
        "X-Title": "DeepSeek Harness",
        "HTTP-Referer": "frlink/v0.1.0",
      },
    });

    const rows = YAML.parse(await readFile(patchPath, "utf8")) as {
      id: string;
      config: Record<string, unknown>;
    }[];
    expect(rows.map((row) => row.id)).toEqual([
      "tools",
      "@friendliai/dsh-llm-friendli",
      "agent-default-model",
    ]);
    // A user-authored plugin row keeps its position and gets our headers
    // in its config (replace-by-id: our config replaces the row's config).
    expect(rows[1].config).toEqual({
      extraHeaders: {
        "X-Title": "DeepSeek Harness",
        "HTTP-Referer": "frlink/v0.1.0",
      },
    });

    // off reverts the plugin row (and the model row), keeping user rows.
    await disable(sandbox);
    expect(YAML.parse(await readFile(patchPath, "utf8"))).toEqual([
      { id: "tools", config: { mode: "native" } },
      { id: "@friendliai/dsh-llm-friendli", config: { thinking: "enabled" } },
    ]);
  });

  it("on without telemetry headers never touches the plugin row", async () => {
    const patchPath = patchPathOf(profileDir(sandbox));
    const original =
      '- id: "@friendliai/dsh-llm-friendli"\n  config: {thinking: enabled}\n';
    await writeFileAtomic(patchPath, original);

    await enable(sandbox);

    const rows = YAML.parse(await readFile(patchPath, "utf8")) as {
      id: string;
      config: Record<string, unknown>;
    }[];
    expect(rows[0].config).toEqual({ thinking: "enabled" }); // untouched
    expect(rows[1]).toEqual({
      id: "agent-default-model",
      config: { provider: "friendli", model: MODEL },
    });
  });

  it("on with telemetry on a missing patch keeps both the model and plugin rows", async () => {
    // Regression: upsertRow once captured the root once outside the
    // closure. On a missing/empty patch the first upsert promotes null
    // to a fresh sequence, but the stale (undefined) capture made the
    // second upsert overwrite that sequence instead of appending —
    // dropping the agent-default-model row and leaving `dsh status`
    // reporting "not routed through Friendli" right after `on`.
    const patchPath = patchPathOf(profileDir(sandbox));
    await expect(readFile(patchPath, "utf8")).rejects.toThrow();

    await enable(sandbox, {
      telemetryHeaders: {
        "X-Title": "DeepSeek Harness",
        "HTTP-Referer": "frlink/v0.1.0",
      },
    });

    const rows = YAML.parse(await readFile(patchPath, "utf8")) as {
      id: string;
      config: Record<string, unknown>;
    }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      id: "agent-default-model",
      config: { provider: "friendli", model: MODEL },
    });
    expect(rows[1]).toEqual({
      id: "@friendliai/dsh-llm-friendli",
      config: {
        extraHeaders: {
          "X-Title": "DeepSeek Harness",
          "HTTP-Referer": "frlink/v0.1.0",
        },
      },
    });

    // The freshly-enrolled profile is immediately reported as managed.
    await writeManifest(sandbox, [PLUGIN_BUNDLE]);
    expect(
      await isFriendliManaged({
        home: sandbox.home,
        profile: DEFAULT_DSH_PROFILE,
      }),
    ).toBe(true);
  });

  it("is managed only with both the bundle and the friendli provider row", async () => {
    const check = () =>
      isFriendliManaged({
        home: sandbox.home,
        profile: DEFAULT_DSH_PROFILE,
      });

    // Neither: missing package.json and missing patch file.
    expect(await check()).toBe(false);

    // Only the bundle in package.json, no patch row.
    await writeManifest(sandbox, [PLUGIN_BUNDLE]);
    expect(await check()).toBe(false);

    // Only the patch row: missing package.json + friendli row.
    await rm(manifestPathOf(profileDir(sandbox)), { force: true });
    await writeFileAtomic(
      patchPathOf(profileDir(sandbox)),
      `- id: agent-default-model\n  config: {provider: friendli, model: ${MODEL}}\n`,
    );
    expect(await check()).toBe(false);

    // A patch row with another provider is not ours either.
    await writeFileAtomic(
      patchPathOf(profileDir(sandbox)),
      `- id: agent-default-model\n  config: {provider: deepseek-official, model: deepseek-v4-flash}\n`,
    );
    expect(await check()).toBe(false);

    // Both: bundle present + friendli provider row.
    await writeManifest(sandbox, [PLUGIN_BUNDLE]);
    await writeFileAtomic(
      patchPathOf(profileDir(sandbox)),
      `- id: agent-default-model\n  config: {provider: friendli, model: ${MODEL}}\n`,
    );
    expect(await check()).toBe(true);
  });
});

describe("dsh off per-row merge restore", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    delete process.env.DSH_HOME;
    sandbox = await createSandboxHome();
  });

  afterEach(async () => {
    delete process.env.DSH_HOME;
    await sandbox.cleanup();
  });

  it("off keeps a user row added after on (byte-restore dropped it)", async () => {
    const patchPath = patchPathOf(profileDir(sandbox));
    const original = "# hand-tuned\n- id: tools\n  config: {mode: native}\n";
    await writeFileAtomic(patchPath, original);
    await enable(sandbox);
    const managed = await readFile(patchPath, "utf8");
    const withUserRow = `${managed}- id: user-tool\n  config: {speed: turbo}\n`;
    await writeFileAtomic(patchPath, withUserRow);

    expect(await disable(sandbox)).toBe("restored");

    const after = await readFile(patchPath, "utf8");
    // The row the user added AFTER our on must survive off — the old
    // byte-for-byte restore silently dropped it.
    expect(after).toContain("- id: user-tool");
    expect(after).toContain("# hand-tuned");
    const rows = YAML.parse(after) as { id: string }[];
    expect(rows.map((row) => row.id)).toEqual(["tools", "user-tool"]);
  });

  it("off leaves a user-edited agent-default-model row exactly as the user left it", async () => {
    const patchPath = patchPathOf(profileDir(sandbox));
    const original = "# hand-tuned\n- id: tools\n  config: {mode: native}\n";
    await writeFileAtomic(patchPath, original);
    await enable(sandbox);
    const edited = (await readFile(patchPath, "utf8")).replace(
      MODEL,
      "user-picked-model",
    );
    await writeFileAtomic(patchPath, edited);

    expect(await disable(sandbox)).toBe("restored");

    // The model no longer matches durable state, so the row is the user's.
    expect(await readFile(patchPath, "utf8")).toBe(edited);
  });

  it("off restores the pre-on agent-default-model config at the live position", async () => {
    const patchPath = patchPathOf(profileDir(sandbox));
    const original =
      "- id: first\n  config: {a: 1}\n" +
      "- id: agent-default-model\n  config: {provider: deepseek-official, model: pre-on-pick}\n" +
      "- id: last\n  config: {b: 2}\n";
    await writeFileAtomic(patchPath, original);
    await enable(sandbox);
    // A post-on user edit keeps the result off the byte-exact path so the
    // merge itself is observable.
    const managed = await readFile(patchPath, "utf8");
    await writeFileAtomic(
      patchPath,
      `${managed}- id: user-extra\n  config: {x: 1}\n`,
    );

    expect(await disable(sandbox)).toBe("restored");

    const rows = YAML.parse(await readFile(patchPath, "utf8")) as {
      id: string;
      config: Record<string, unknown>;
    }[];
    expect(rows.map((row) => row.id)).toEqual([
      "first",
      "agent-default-model",
      "last",
      "user-extra",
    ]);
    expect(rows[1].config).toEqual({
      provider: "deepseek-official",
      model: "pre-on-pick",
    });
  });

  it("off restores the pre-on bytes exactly when the user never edited the file", async () => {
    const patchPath = patchPathOf(profileDir(sandbox));
    const original =
      "# tuned by hand — keep\n" +
      "- id: tools\n" +
      "  config: {mode: native}\n";
    await writeFileAtomic(patchPath, original);
    await enable(sandbox);
    expect(await readFile(patchPath, "utf8")).toContain("agent-default-model");

    expect(await disable(sandbox)).toBe("restored");
    expect(await readFile(patchPath, "utf8")).toBe(original);
  });

  it("off keeps user rows when on created the patch over a nonexistent pre-on file", async () => {
    const patchPath = patchPathOf(profileDir(sandbox));
    await enable(sandbox);
    const managed = await readFile(patchPath, "utf8");
    await writeFileAtomic(
      patchPath,
      `${managed}- id: user-tool\n  config: {speed: turbo}\n`,
    );

    expect(await disable(sandbox)).toBe("restored");

    // The file survives with exactly the pre-on-absent state: our row is
    // deleted, the user's rows remain (the old restore deleted the file).
    const rows = YAML.parse(await readFile(patchPath, "utf8")) as {
      id: string;
    }[];
    expect(rows.map((row) => row.id)).toEqual(["user-tool"]);
  });

  it.each([
    { preOn: "# user's own file\n- id: tools\n  config: {v: 1}\n" },
    { preOn: undefined },
  ])(
    "off restores the pre-on state when the user deleted the live file after on (pre-on existed: %j)",
    async ({ preOn }) => {
      const patchPath = patchPathOf(profileDir(sandbox));
      if (preOn) await writeFileAtomic(patchPath, preOn);
      await enable(sandbox);
      await rm(patchPath);

      expect(await disable(sandbox)).toBe("restored");

      if (preOn) {
        expect(await readFile(patchPath, "utf8")).toBe(preOn);
      } else {
        await expect(readFile(patchPath, "utf8")).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    },
  );

  it.each([
    { config: { provider: "friendli", model: "some-model" }, owned: true },
    {
      config: { provider: "friendli", model: "some-model", custom: "keep" },
      owned: false,
    },
  ])(
    "off without a state file claims the row only via the two-key friendli signature: %j",
    async ({ config, owned }) => {
      const patchPath = patchPathOf(profileDir(sandbox));
      const original = "- id: tools\n  config: {mode: native}\n";
      await writeFileAtomic(patchPath, original);
      await enable(sandbox);
      // Reshape the managed row to the shape under test (any model passes
      // the fallback signature; an extra key fails it) and destroy the
      // durable state file, leaving the ownership fallback on its own.
      const edited = YAML.stringify([
        { id: "tools", config: { mode: "native" } },
        { id: "agent-default-model", config },
      ]);
      await writeFileAtomic(patchPath, edited);
      const dataDir = dshDataDir(sandbox.home);
      for (const name of await readdir(dataDir)) {
        if (name.startsWith("provider-state-")) {
          await rm(join(dataDir, name));
        }
      }

      expect(await disable(sandbox)).toBe("restored");

      if (owned) {
        // Two-key friendli signature + envelope-owned backup: ours → removed.
        expect(await readFile(patchPath, "utf8")).toBe(original);
      } else {
        // Any extra key means the user authored it: untouched.
        expect(await readFile(patchPath, "utf8")).toBe(edited);
      }
    },
  );

  it.each(["- id: [broken\n", "not-a-patch: true\n"])(
    "off refuses an unusable live patch without consuming recovery: %s",
    async (userEdit) => {
      const patchPath = patchPathOf(profileDir(sandbox));
      const original = "- id: tools\n  config: {mode: native}\n";
      await writeFileAtomic(patchPath, original);
      await enable(sandbox);
      await writeFileAtomic(patchPath, userEdit);

      await expect(disable(sandbox)).rejects.toThrow(/fix it and rerun/);

      // The foreign bytes stay put and the backup stays recoverable.
      expect(await readFile(patchPath, "utf8")).toBe(userEdit);
      expect(
        (await readdir(dshDataDir(sandbox.home))).filter((name) =>
          name.endsWith("-backup.json"),
        ),
      ).toHaveLength(1);

      // Once the user clears the unusable file, recovery completes.
      await rm(patchPath);
      expect(await disable(sandbox)).toBe("restored");
      expect(await readFile(patchPath, "utf8")).toBe(original);
    },
  );

  it("off restores an empty pre-on file as empty", async () => {
    const patchPath = patchPathOf(profileDir(sandbox));
    await writeFileAtomic(patchPath, "");
    await enable(sandbox);

    expect(await disable(sandbox)).toBe("restored");
    expect(await readFile(patchPath, "utf8")).toBe("");
  });
});
