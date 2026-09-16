import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBaseContext } from "../../../src/harness/types.js";
import { globalConfigPath } from "../../../src/config/global-config.js";
import { getDotenvPath } from "../../../src/keys/env-path.js";
import {
  configPath,
  hermesDataDir,
  hermesSlot,
} from "../../../src/harnesses/hermes/core.js";
import {
  hermesAdapter,
  setHermesPluginRunnerForTests,
} from "../../../src/harnesses/hermes/index.js";
import { createSandboxHome } from "../../helpers.js";

const MODEL = "zai-org/GLM-5.2";

/** Adapter-facing full on→off cycle: the file-set cycle this suite exists
 * for. Key via env (no network), model pinned, plugin runner stubbed. */
function ctx(home: string) {
  return {
    ...createBaseContext(),
    home,
    onboardingMode: "skip" as const,
    main: MODEL,
  };
}

/** A fake hermes: a successful `plugins remove` also deletes the install
 * directory (like the real CLI) so the post-removal re-probe passes. */
function fakeHermes(home: string) {
  return async (_file: string, args: string[]) => {
    if (args[0] === "plugins" && args[1] === "remove") {
      const { rm } = await import("node:fs/promises");
      await rm(`${home}/.hermes/plugins/friendliai-provider`, {
        recursive: true,
        force: true,
      });
    }
    return { ok: true, stdout: "", stderr: "" };
  };
}

describe("hermes on/off full file cycle", () => {
  let sandbox: Awaited<ReturnType<typeof createSandboxHome>>;
  let savedKey: string | undefined;

  beforeEach(async () => {
    sandbox = await createSandboxHome();
    savedKey = process.env.FRIENDLIAI_API_KEY;
    process.env.FRIENDLIAI_API_KEY = "friendli-key-1234";
    setHermesPluginRunnerForTests(fakeHermes(sandbox.home));
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    setHermesPluginRunnerForTests(null);
    vi.mocked(console.log).mockRestore();
    if (savedKey === undefined) delete process.env.FRIENDLIAI_API_KEY;
    else process.env.FRIENDLIAI_API_KEY = savedKey;
    await sandbox.cleanup();
  });

  it("on creates the full managed file set", async () => {
    const home = sandbox.home;
    await hermesAdapter.on(ctx(home));

    const config = configPath(home);
    const { backupPath, statePath: state } = hermesSlot(
      hermesDataDir(home),
      config,
    );

    const raw = await readFile(config, "utf8");
    expect(raw).toContain(`default: ${MODEL}`);
    expect(raw).toContain("provider: friendli");
    expect(raw).toContain("friendliai-provider");
    // The plugin install directory exists (the fake runner leaves creation
    // to hermes in real life; assert what on itself guarantees instead).
    expect(await readFile(`${home}/.hermes/.env`, "utf8")).toContain(
      "FRIENDLIAI_API_KEY=friendli-key-1234",
    );
    const stateDoc = JSON.parse(await readFile(state, "utf8"));
    expect(stateDoc.model).toBe(MODEL);
    expect(stateDoc.installedByUs).toBe(true);
    expect(existsSync(backupPath)).toBe(true); // first on snapshots the pre-state

    // secret-bearing files are owner-only.
    expect((await stat(config)).mode & 0o777).toBe(0o600);
    expect((await stat(getDotenvPath(home))).mode & 0o777).toBe(0o600);

    // enabled flag in the global config.
    expect(
      JSON.parse(await readFile(globalConfigPath(home), "utf8")),
    ).toMatchObject({ harnesses: { hermes: { enabled: true } } });
  });

  it("off reverts our files and the .env key on created", async () => {
    const home = sandbox.home;
    await hermesAdapter.on(ctx(home));
    await hermesAdapter.off(ctx(home));

    const config = configPath(home);
    const dataDir = hermesDataDir(home);
    const { backupPath, statePath: state } = hermesSlot(dataDir, config);

    // config deleted: it never existed before this on.
    expect(existsSync(config)).toBe(false);
    // bookkeeping consumed.
    expect(existsSync(backupPath)).toBe(false);
    expect(existsSync(state)).toBe(false);
    // `off` reverts the dotenv key under our ownership contract: the user
    // had no FRIENDLIAI_API_KEY line before `on`, so the line `on` wrote —
    // and the file `on` created — is removed.
    expect(existsSync(getDotenvPath(home))).toBe(false);
    expect(
      JSON.parse(await readFile(globalConfigPath(home), "utf8")),
    ).toMatchObject({ harnesses: { hermes: { enabled: false } } });
  });

  it("is a no-op off when nothing was ever enabled", async () => {
    const home = sandbox.home;
    await hermesAdapter.off(ctx(home));
    // nothing created — in particular no config, no state, no .env
    expect(existsSync(configPath(home))).toBe(false);
    expect(
      existsSync(hermesSlot(hermesDataDir(home), configPath(home)).statePath),
    ).toBe(false);
    expect(existsSync(getDotenvPath(home))).toBe(false);
  });

  it("keys bookkeeping slots per resolved config path (profiles never cross)", async () => {
    // Two config paths under one data dir — profile B's off must not touch
    // profile A's pre-on bytes. Each slot is keyed by the resolved config
    // path, so the files can never collide.
    const home = sandbox.home;
    const dataDir = hermesDataDir(home);
    const slotA = hermesSlot(dataDir, `${home}/.hermes/config.yaml`);
    const slotB = hermesSlot(dataDir, `${home}/.hermes-profile-b/config.yaml`);
    expect(slotA.backupPath).not.toBe(slotB.backupPath);
    expect(slotA.statePath).not.toBe(slotB.statePath);

    // `on` against the default home writes bookkeeping under exactly the
    // default config's slot — nowhere else.
    await hermesAdapter.on(ctx(home));
    expect(existsSync(slotA.statePath)).toBe(true);
    expect(existsSync(slotB.statePath)).toBe(false);
  });
});
