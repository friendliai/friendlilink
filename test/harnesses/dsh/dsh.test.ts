import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

const confirmMock = vi.fn();
vi.mock("@clack/prompts", () => ({
  confirm: (...a: unknown[]) => confirmMock(...(a as [])),
  isCancel: (v: unknown) => v === Symbol.for("cancel"),
}));
import { readGlobalConfig } from "../../../src/config/global-config.js";
import {
  createBaseContext,
  type HarnessContext,
} from "../../../src/harness/types.js";
import {
  PLUGIN_BUNDLE,
  dshDataDir,
  dshHome,
  dshProfile,
  manifestPathOf,
  patchPathOf,
  readProviderState,
} from "../../../src/harnesses/dsh/core.js";
import {
  dshAdapter,
  setDshPluginRunnerForTests,
} from "../../../src/harnesses/dsh/index.js";
import {
  installDshPlugin,
  removeDshPlugin,
  setDshLatestTagResolverForTests,
  type CommandRunner,
} from "../../../src/harnesses/dsh/plugins.js";
import { writeFileAtomic } from "../../../src/io/atomic-write.js";
import { writeJson } from "../../../src/io/json.js";
import { createSandboxHome, type Sandbox } from "../../helpers.js";

const MODEL = "zai-org/GLM-5.2";
const TEST_KEY = "flpl_sandbox_test_key";
/** The stubbed registry dist-tag so the expected add spec is deterministic. */
const TEST_LATEST = "0.1.5";
const ADD_ARGS = [
  "plugin",
  "--profile",
  "web",
  "add",
  `${PLUGIN_BUNDLE}@${TEST_LATEST}`,
];
const REMOVE_ARGS = ["plugin", "--profile", "web", "remove", PLUGIN_BUNDLE];

/** A stand-in for the `dsh` binary: records every `dsh plugin …` invocation
 * and applies the same manifest side effect the real one does — adding the
 * bundle to `dsh.profile.bundles` in the profile's package.json — so adapter
 * flows end in the managed on-disk state a real install leaves behind.
 * The pnpm probe from `ensurePnpmAvailable` passes through (returns ok) so
 * the adapter delegates straight to `dsh plugin`. */
function fakeDshBinary(calls: string[][], home: string): CommandRunner {
  return async (_file: string, args: string[]) => {
    if (_file === "pnpm") return { ok: true, stdout: "", stderr: "" };
    calls.push(args);
    const profile = args[2];
    if ((args[3] === "add" || args[3] === "remove") && profile) {
      await writeJson(manifestPathOf(dshProfile(home, profile)), {
        dsh: { profile: { bundles: args[3] === "add" ? [PLUGIN_BUNDLE] : [] } },
      });
    }
    return { ok: true, stdout: "", stderr: "" };
  };
}

describe("dsh plugin commands", () => {
  beforeEach(() => {
    setDshLatestTagResolverForTests(async () => TEST_LATEST);
    confirmMock.mockReset();
  });

  afterEach(() => {
    setDshLatestTagResolverForTests(null);
  });

  it("adds and removes the bundle through `dsh plugin --profile <p>`", async () => {
    const files: string[] = [];
    const calls: string[][] = [];
    const run = async (file: string, args: string[]) => {
      files.push(file);
      calls.push(args);
      return { ok: true, stdout: "", stderr: "" };
    };

    await installDshPlugin(run, "web");
    await removeDshPlugin(run, "web");

    // pnpm --version probe precedes each dsh plugin command.
    expect(files).toEqual(["pnpm", "dsh", "pnpm", "dsh"]);
    expect(calls).toEqual([
      ["--version"],
      ADD_ARGS,
      ["--version"],
      REMOVE_ARGS,
    ]);
  });

  it("rejects a nonzero exit even when the output says 'already up to date'", async () => {
    const run = async (file: string) =>
      file === "pnpm"
        ? { ok: true, stdout: "", stderr: "" }
        : { ok: false, stdout: "", stderr: " Already up to date" };

    // dsh only reconciles dsh.profile.bundles on a zero exit, so a nonzero
    // result means the bundle may not be registered — never success.
    await expect(installDshPlugin(run, "web")).rejects.toThrow(
      /Already up to date/,
    );
  });

  it("throws with dsh's output when the install fails for real", async () => {
    const run = async (file: string) =>
      file === "pnpm"
        ? { ok: true, stdout: "", stderr: "" }
        : { ok: false, stdout: "", stderr: " ERR_PNPM_FETCH 404" };

    await expect(installDshPlugin(run, "web")).rejects.toThrow(
      /ERR_PNPM_FETCH 404/,
    );
  });

  it("enables pnpm via corepack when it is not on PATH", async () => {
    confirmMock.mockResolvedValue(true);
    const calls: string[][] = [];
    const run = async (file: string, args: string[]) => {
      calls.push([file, ...args]);
      if (file === "pnpm") return { ok: false, stdout: "", stderr: "" };
      // corepack --version probe and corepack enable both succeed.
      return { ok: true, stdout: "", stderr: "" };
    };

    await installDshPlugin(run, "web", true);

    // pnpm probe (fail) → corepack --version probe → confirm → corepack enable → dsh plugin add.
    expect(calls).toEqual([
      ["pnpm", "--version"],
      ["corepack", "--version"],
      ["corepack", "enable"],
      ["dsh", ...ADD_ARGS],
    ]);
    expect(confirmMock).toHaveBeenCalledTimes(1);
  });

  it("throws when the user declines corepack enable", async () => {
    confirmMock.mockResolvedValue(false);
    const run = async (file: string) =>
      file === "pnpm"
        ? { ok: false, stdout: "", stderr: "" }
        : { ok: true, stdout: "", stderr: "" };

    await expect(installDshPlugin(run, "web", true)).rejects.toThrow(
      /corepack enable/,
    );
    expect(confirmMock).toHaveBeenCalledTimes(1);
  });

  it("throws without prompting when --non-interactive and pnpm is absent", async () => {
    confirmMock.mockResolvedValue(true);
    const run = async (file: string) =>
      file === "pnpm"
        ? { ok: false, stdout: "", stderr: "" }
        : { ok: true, stdout: "", stderr: "" };

    // interactive=false → no confirm, direct error.
    await expect(installDshPlugin(run, "web", false)).rejects.toThrow(
      /corepack enable/,
    );
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("installs corepack via npm then enables pnpm when neither is on PATH", async () => {
    confirmMock.mockResolvedValue(true);
    const calls: string[][] = [];
    const run = async (file: string, args: string[]) => {
      calls.push([file, ...args]);
      if (file === "pnpm") return { ok: false, stdout: "", stderr: "" };
      if (file === "corepack" && args[0] === "--version")
        return { ok: false, stdout: "", stderr: "" };
      // corepack enable and npm install -g corepack succeed.
      return { ok: true, stdout: "", stderr: "" };
    };

    await installDshPlugin(run, "web", true);

    expect(calls).toEqual([
      ["pnpm", "--version"],
      ["corepack", "--version"],
      ["npm", "install", "-g", "corepack"],
      ["corepack", "enable"],
      ["dsh", ...ADD_ARGS],
    ]);
    expect(confirmMock).toHaveBeenCalledTimes(1);
  });
});

describe("dsh adapter", () => {
  let sandbox: Sandbox;
  let calls: string[][];
  let logs: string[];
  const savedEnv: {
    DSH_HOME: string | undefined;
    FRIENDLIAI_API_KEY: string | undefined;
  } = { DSH_HOME: undefined, FRIENDLIAI_API_KEY: undefined };

  /** A context aimed at the sandbox with prompts off, a pinned model, and the
   * key coming from env — the --skip/--model equivalents, so `on` never hits
   * the network. */
  function ctx(overrides: Partial<HarnessContext> = {}): HarnessContext {
    return Object.assign(
      createBaseContext(),
      {
        home: sandbox.home,
        onboardingMode: "skip",
        main: MODEL,
      },
      overrides,
    );
  }

  beforeEach(async () => {
    sandbox = await createSandboxHome();
    savedEnv.DSH_HOME = process.env.DSH_HOME;
    savedEnv.FRIENDLIAI_API_KEY = process.env.FRIENDLIAI_API_KEY;
    // dsh's home lives inside the sandbox, so no write can reach the real
    // ~/.dsh — and the env key keeps resolveVerifiedKey off the network.
    process.env.DSH_HOME = join(sandbox.home, "dsh-home");
    process.env.FRIENDLIAI_API_KEY = TEST_KEY;
    calls = [];
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    setDshLatestTagResolverForTests(async () => TEST_LATEST);
    setDshPluginRunnerForTests(fakeDshBinary(calls, sandbox.home));
  });

  afterEach(async () => {
    setDshPluginRunnerForTests(null);
    setDshLatestTagResolverForTests(null);
    vi.restoreAllMocks();
    if (savedEnv.DSH_HOME === undefined) {
      delete process.env.DSH_HOME;
    } else {
      process.env.DSH_HOME = savedEnv.DSH_HOME;
    }
    if (savedEnv.FRIENDLIAI_API_KEY === undefined) {
      delete process.env.FRIENDLIAI_API_KEY;
    } else {
      process.env.FRIENDLIAI_API_KEY = savedEnv.FRIENDLIAI_API_KEY;
    }
    await sandbox.cleanup();
  });

  it("registers with the expected id and label", () => {
    expect(dshAdapter.id).toBe("dsh");
    expect(dshAdapter.label).toBe("DeepSeek Harness");
  });

  it("on routes the web profile through Friendli end-to-end", async () => {
    await dshAdapter.on(ctx());

    expect(calls).toEqual([ADD_ARGS]);

    const env = await readFile(join(dshHome(sandbox.home), ".env"), "utf8");
    expect(env).toContain(`FRIENDLIAI_API_KEY=${TEST_KEY}`);

    const raw = await readFile(
      patchPathOf(dshProfile(sandbox.home, "web")),
      "utf8",
    );
    expect(YAML.parse(raw)).toEqual([
      {
        id: "agent-default-model",
        config: { provider: "friendli", model: MODEL },
      },
    ]);

    expect(
      await readProviderState(dshDataDir(sandbox.home), sandbox.home, "web"),
    ).toEqual({
      apiKeySource: "env",
      model: MODEL,
      profile: "web",
    });

    expect((await readGlobalConfig(sandbox.home)).harnesses.dsh?.enabled).toBe(
      true,
    );
    expect(await dshAdapter.providerStatus(ctx())).toBe("friendli");
  });

  it("honors $DSH_HOME for the key instead of the legacy ~/.dsh default", async () => {
    const elsewhere = join(sandbox.home, "elsewhere");
    process.env.DSH_HOME = elsewhere;

    await dshAdapter.on(ctx());

    expect(
      await readFile(join(dshHome(sandbox.home), ".env"), "utf8"),
    ).toContain(`FRIENDLIAI_API_KEY=${TEST_KEY}`);
    await expect(
      readFile(join(sandbox.home, ".dsh", ".env"), "utf8"),
    ).rejects.toThrow();
  });

  it("on with --profile targets the named profile", async () => {
    await dshAdapter.on(ctx({ profile: "myprofile" }));

    expect(calls).toEqual([
      [
        "plugin",
        "--profile",
        "myprofile",
        "add",
        `${PLUGIN_BUNDLE}@${TEST_LATEST}`,
      ],
    ]);
    const raw = await readFile(
      patchPathOf(dshProfile(sandbox.home, "myprofile")),
      "utf8",
    );
    expect(YAML.parse(raw)).toEqual([
      {
        id: "agent-default-model",
        config: { provider: "friendli", model: MODEL },
      },
    ]);
  });

  it.each(["- id: [broken\n", "not-a-patch: true\n"])(
    "on rejects invalid patches before installation: %s",
    async (original) => {
      const patchPath = patchPathOf(dshProfile(sandbox.home, "web"));
      await writeFileAtomic(patchPath, original);
      await expect(dshAdapter.on(ctx())).rejects.toThrow(/fix it and rerun/);
      expect(calls).toEqual([]);
      expect(await readFile(patchPath, "utf8")).toBe(original);
      await expect(
        readFile(join(dshHome(sandbox.home), ".env"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each([false, true])(
    "on preserves a hand-authored Friendli row for off (bundle already installed: %s)",
    async (installed) => {
      const patchPath = patchPathOf(dshProfile(sandbox.home, "web"));
      const original =
        "# user's existing Friendli selection\n" +
        "- id: agent-default-model\n" +
        "  config: {provider: friendli, model: user-model, custom: keep}\n";
      await writeFileAtomic(patchPath, original);
      if (installed) {
        await writeJson(manifestPathOf(dshProfile(sandbox.home, "web")), {
          dsh: { profile: { bundles: [PLUGIN_BUNDLE] } },
        });
      }

      await dshAdapter.on(ctx());
      await dshAdapter.on(ctx({ main: "another-model" }));
      await dshAdapter.off(ctx());

      expect(await readFile(patchPath, "utf8")).toBe(original);
    },
  );

  it.each([false, true])(
    "failed install leaves later user edits intact on off (retry on: %s)",
    async (retry) => {
      const patchPath = patchPathOf(dshProfile(sandbox.home, "web"));
      const original =
        "# before failed install\n- id: agent-default-model\n" +
        "  config: {provider: deepseek-official, model: original}\n";
      const edited = original
        .replace("before failed install", "user edited after failure")
        .replace("model: original", "model: user-edit");
      await writeFileAtomic(patchPath, original);
      setDshPluginRunnerForTests(async (file: string) =>
        file === "pnpm"
          ? { ok: true, stdout: "", stderr: "" }
          : { ok: false, stdout: "", stderr: "ERR_PNPM_FETCH 404" },
      );

      await expect(dshAdapter.on(ctx())).rejects.toThrow(/ERR_PNPM_FETCH 404/);
      expect(await readFile(patchPath, "utf8")).toBe(original);
      await writeFileAtomic(patchPath, edited);
      setDshPluginRunnerForTests(fakeDshBinary(calls, sandbox.home));
      if (retry) await dshAdapter.on(ctx());
      await dshAdapter.off(ctx());

      expect(await readFile(patchPath, "utf8")).toBe(edited);
    },
  );

  it.each([false, true])(
    "dotenv failure after install leaves later user edits intact on off (retry on: %s)",
    async (retry) => {
      const patchPath = patchPathOf(dshProfile(sandbox.home, "web"));
      const envPath = join(dshHome(sandbox.home), ".env");
      const dataDir = dshDataDir(sandbox.home);
      const original =
        "# before dotenv failure\n- id: agent-default-model\n" +
        "  config: {provider: deepseek-official, model: original}\n";
      const edited = original
        .replace("before dotenv failure", "user edited after failure")
        .replace("model: original", "model: user-edit");
      await writeFileAtomic(patchPath, original);
      // A directory deterministically makes the real dotenv read fail.
      await mkdir(envPath);

      await expect(dshAdapter.on(ctx())).rejects.toMatchObject({
        code: "EISDIR",
      });
      // on tries legacy remove first (ok), then add (ok), then dotenv fails.
      expect(calls).toEqual([ADD_ARGS]);
      expect(await readFile(patchPath, "utf8")).toBe(original);
      expect(await readProviderState(dataDir, sandbox.home, "web")).toBe(
        undefined,
      );
      expect
        .soft(
          (await readdir(dataDir)).filter((name) =>
            name.endsWith("-backup.json"),
          ),
        )
        .toEqual([]);

      await writeFileAtomic(patchPath, edited);
      await rm(envPath, { recursive: true });
      if (retry) await dshAdapter.on(ctx());
      await dshAdapter.off(ctx());

      expect(await readFile(patchPath, "utf8")).toBe(edited);
      expect(
        (await readdir(dataDir)).filter((name) =>
          name.endsWith("-backup.json"),
        ),
      ).toEqual([]);
      expect(calls).toEqual(
        retry ? [ADD_ARGS, ADD_ARGS, REMOVE_ARGS] : [ADD_ARGS, REMOVE_ARGS],
      );
    },
  );

  it("failed install preserves a prior backup even when the patch matches it", async () => {
    const patchPath = patchPathOf(dshProfile(sandbox.home, "web"));
    const original = "# original\n- id: tools\n  config: {mode: native}\n";
    await writeFileAtomic(patchPath, original);
    await dshAdapter.on(ctx());
    // A user may restore the original manually without deleting our bookkeeping.
    await writeFileAtomic(patchPath, original);
    const dataDir = dshDataDir(sandbox.home);
    const before = await Promise.all(
      (await readdir(dataDir))
        .sort()
        .map(async (name) => [
          name,
          await readFile(join(dataDir, name), "utf8"),
        ]),
    );
    setDshPluginRunnerForTests(async (file: string) =>
      file === "pnpm"
        ? { ok: true, stdout: "", stderr: "" }
        : { ok: false, stdout: "", stderr: "install failed" },
    );

    await expect(dshAdapter.on(ctx())).rejects.toThrow(/install failed/);
    const after = await Promise.all(
      (await readdir(dataDir))
        .sort()
        .map(async (name) => [
          name,
          await readFile(join(dataDir, name), "utf8"),
        ]),
    );
    expect(after).toEqual(before);
    setDshPluginRunnerForTests(fakeDshBinary(calls, sandbox.home));
    await dshAdapter.off(ctx());
    expect(await readFile(patchPath, "utf8")).toBe(original);
  });

  it.each([
    {
      change: "replace",
      original: "# original\n- id: tools\n  config: {mode: native}\n",
      partial: "- id: [broken\n",
    },
    { change: "delete", original: "", partial: undefined },
    { change: "create", original: undefined, partial: "" },
  ])(
    "failed install preserves recovery after a partial patch $change",
    async ({ change, original, partial }) => {
      const patchPath = patchPathOf(dshProfile(sandbox.home, "web"));
      if (original !== undefined) await writeFileAtomic(patchPath, original);
      setDshPluginRunnerForTests(async (file: string) => {
        if (file === "pnpm") return { ok: true, stdout: "", stderr: "" };
        if (partial === undefined) await rm(patchPath);
        else await writeFileAtomic(patchPath, partial);
        return { ok: false, stdout: "", stderr: "partial install failed" };
      });

      await expect(dshAdapter.on(ctx())).rejects.toThrow(
        /partial install failed/,
      );
      const backupNames = (await readdir(dshDataDir(sandbox.home))).filter(
        (name) => name.endsWith("-backup.json"),
      );
      expect(backupNames).toHaveLength(1);
      if (change === "replace") {
        // An unparseable live file may still hold user bytes, so off
        // refuses with on's fix-it advice instead of silently restoring
        // over it — the retained backup remains the recovery path.
        await expect(dshAdapter.off(ctx())).rejects.toThrow(/fix it and rerun/);
        expect(await readFile(patchPath, "utf8")).toBe(partial);
        expect(backupNames).toHaveLength(1);
        // Once the user clears the unusable file, off completes recovery.
        await rm(patchPath);
        await dshAdapter.off(ctx());
        expect(await readFile(patchPath, "utf8")).toBe(original);
        return;
      }
      await dshAdapter.off(ctx());
      if (original === undefined) {
        await expect(readFile(patchPath, "utf8")).rejects.toMatchObject({
          code: "ENOENT",
        });
      } else {
        expect(await readFile(patchPath, "utf8")).toBe(original);
      }
    },
  );

  it("off removes the bundle, restores the patch bytes, and disables the harness", async () => {
    const original =
      "# tuned by hand — keep\n" +
      "- id: tools\n" +
      "  config: {mode: native}\n";
    const patchPath = patchPathOf(dshProfile(sandbox.home, "web"));
    await writeFileAtomic(patchPath, original);

    await dshAdapter.on(ctx());
    calls.length = 0; // capture only the remove invocation below

    await dshAdapter.off(ctx());

    expect(calls).toEqual([REMOVE_ARGS]);
    expect(await readFile(patchPath, "utf8")).toBe(original);
    expect((await readGlobalConfig(sandbox.home)).harnesses.dsh?.enabled).toBe(
      false,
    );
    expect(await dshAdapter.providerStatus(ctx())).toBe("default");
  });

  it.each(["boom", "ERR_PNPM_CANNOT_REMOVE_MISSING_DEPS"])(
    "off restores the patch but reports failed removal: %s",
    async (stderr) => {
      await dshAdapter.on(ctx());
      const patchPath = patchPathOf(dshProfile(sandbox.home, "web"));
      setDshPluginRunnerForTests(async (file: string) =>
        file === "pnpm"
          ? { ok: true, stdout: "", stderr: "" }
          : { ok: false, stdout: "", stderr },
      );
      logs.length = 0;

      await expect(dshAdapter.off(ctx())).rejects.toThrow(stderr);

      // Restoration succeeds independently, but the stale manifest still needs a retry.
      await expect(readFile(patchPath, "utf8")).rejects.toThrow();
      await expect(dshAdapter.off(ctx())).rejects.toThrow(stderr);
      expect(logs.join("\n")).not.toContain("bundle has been removed");
      expect(logs.join("\n")).not.toContain("nothing to do");
    },
  );

  it("off restores a FRIENDLIAI_API_KEY the user had before on (review case)", async () => {
    // The reviewer's exact scenario: the user already had a key in dsh's .env.
    await writeFileAtomic(
      join(dshHome(sandbox.home), ".env"),
      `FRIENDLIAI_API_KEY=user-own-key\nOTHER=keep\n`,
    );

    await dshAdapter.on(ctx());
    // on overwrote the field with the frlink key …
    expect(await readFile(join(dshHome(sandbox.home), ".env"), "utf8")).toBe(
      `OTHER=keep\nFRIENDLIAI_API_KEY=${TEST_KEY}\n`,
    );

    await dshAdapter.off(ctx());

    // … and off put the user's line back (at our line's anchor position —
    // dotenv keys are unordered, so the semantic field is exactly restored).
    expect(await readFile(join(dshHome(sandbox.home), ".env"), "utf8")).toBe(
      `OTHER=keep\nFRIENDLIAI_API_KEY=user-own-key\n`,
    );
  });

  it("off preserves the user's own edit to the key field made after on", async () => {
    await dshAdapter.on(ctx());
    // The user rotated the key by hand while managed.
    await writeFileAtomic(
      join(dshHome(sandbox.home), ".env"),
      `OTHER=keep\nFRIENDLIAI_API_KEY=user-rotated\n`,
    );

    await dshAdapter.off(ctx());

    // Their edit wins — off must not revert it to anything of ours.
    expect(await readFile(join(dshHome(sandbox.home), ".env"), "utf8")).toBe(
      `OTHER=keep\nFRIENDLIAI_API_KEY=user-rotated\n`,
    );
  });

  it("off removes the key line when the user had none, and the file otherwise", async () => {
    await dshAdapter.on(ctx());

    await dshAdapter.off(ctx());

    // on created the .env holding only our key: off deletes it wholesale.
    await expect(
      readFile(join(dshHome(sandbox.home), ".env"), "utf8"),
    ).rejects.toThrow();
  });

  it("off without any ownership record never touches .env", async () => {
    await writeFileAtomic(
      join(dshHome(sandbox.home), ".env"),
      `FRIENDLIAI_API_KEY=user-own-key\n`,
    );

    await dshAdapter.off(ctx()); // never ran on: no record, no removal

    expect(await readFile(join(dshHome(sandbox.home), ".env"), "utf8")).toBe(
      `FRIENDLIAI_API_KEY=user-own-key\n`,
    );
  });
  it("off on a half-managed profile (bundle present, no patch row) removes the bundle and says so", async () => {
    // Simulate a stray `dsh plugin add` without frlink's patch row:
    // installed: true via the manifest, isFriendliManaged: false.
    await writeJson(manifestPathOf(dshProfile(sandbox.home, "web")), {
      dsh: { profile: { bundles: [PLUGIN_BUNDLE] } },
    });
    calls.length = 0;

    await dshAdapter.off(ctx());

    expect(calls).toEqual([REMOVE_ARGS]);
    expect(logs.join("\n")).toContain("not fully managed");
    expect(await dshAdapter.providerStatus(ctx())).toBe("default");
  });

  it("off rejects a zero exit that leaves the bundle registered", async () => {
    await writeJson(manifestPathOf(dshProfile(sandbox.home, "web")), {
      dsh: { profile: { bundles: [PLUGIN_BUNDLE] } },
    });
    setDshPluginRunnerForTests(async () => ({
      ok: true,
      stdout: "",
      stderr: "",
    }));

    await expect(dshAdapter.off(ctx())).rejects.toThrow(/still registered/);
    expect(logs.join("\n")).not.toContain("bundle has been removed");
  });

  it("off on a fully-unmanaged profile skips the remove entirely", async () => {
    await dshAdapter.off(ctx());

    expect(calls).toEqual([]); // no dsh command ran
    expect(logs.join("\n")).toContain("nothing to do");
  });

  it("status reports the managed route for humans", async () => {
    await dshAdapter.on(ctx());
    logs.length = 0;

    await dshAdapter.status(ctx());

    expect(logs[0]).toBe(
      "dsh: routed through FriendliAI (@friendliai/dsh-llm-friendli bundle).",
    );
  });

  it("status --json prints the machine-readable shape", async () => {
    await dshAdapter.on(ctx());
    logs.length = 0;

    await dshAdapter.status(ctx({ json: true }));

    const parsed = JSON.parse(logs[0] ?? "");
    expect(Object.keys(parsed).sort()).toEqual([
      "apiKeySource",
      "managed",
      "model",
      "profile",
    ]);
    expect(parsed).toEqual({
      managed: true,
      model: MODEL,
      apiKeySource: "env",
      profile: "web",
    });
  });

  it.each(["on", "off", "status", "providerStatus"] as const)(
    "%s rejects traversal without touching the target patch",
    async (verb) => {
      const patchPath = join(sandbox.home, "target", "cordis.patch.yml");
      const original =
        "- id: agent-default-model\n" +
        "  config: {provider: deepseek-official, model: keep}\n";
      await writeFileAtomic(patchPath, original);
      delete process.env.FRIENDLIAI_API_KEY;

      await expect(
        dshAdapter[verb](ctx({ profile: "../../target" })),
      ).rejects.toThrow(/invalid profile name/);
      expect(calls).toEqual([]);
      expect(await readFile(patchPath, "utf8")).toBe(original);
    },
  );

  it("rejects --base-url before key lookup or any installation/config writes", async () => {
    delete process.env.FRIENDLIAI_API_KEY;
    await expect(
      dshAdapter.on(
        ctx({
          baseUrlFromFlag: true,
          baseUrl: "https://dedicated.example/v1",
        }),
      ),
    ).rejects.toThrow(/--base-url is not supported for dsh/);
    expect(calls).toEqual([]);
    await expect(
      readFile(manifestPathOf(dshProfile(sandbox.home, "web")), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(dshHome(sandbox.home), ".env"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("on/off reject --settings-path: dsh plugin targets its own profile dir", async () => {
    const settingsPath = join(sandbox.home, "elsewhere-profile");

    await expect(dshAdapter.on(ctx({ settingsPath }))).rejects.toThrow(
      /--settings-path is not supported for dsh on\/off/,
    );
    expect(calls).toEqual([]); // no dsh command ran
    await expect(dshAdapter.off(ctx({ settingsPath }))).rejects.toThrow(
      /--settings-path is not supported for dsh on\/off/,
    );
  });

  it("status --json reports an unmanaged harness", async () => {
    await dshAdapter.status(ctx({ json: true }));

    expect(JSON.parse(logs[0] ?? "")).toEqual({
      managed: false,
      model: null,
      apiKeySource: null,
      profile: null,
    });
  });
});
