import { createHash } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  disableFriendliForDsh,
  dshDataDir,
  dshProfile,
  enableFriendliForDsh,
  patchPathOf,
  readProviderState,
} from "../../../src/harnesses/dsh/core.js";
import { writeFileAtomic } from "../../../src/io/atomic-write.js";
import { writeJson } from "../../../src/io/json.js";
import { createSandboxHome, type Sandbox } from "../../helpers.js";

const PROFILE = "web";

function slotKey(dshHome: string): string {
  return createHash("sha256")
    .update(JSON.stringify([path.resolve(dshHome), PROFILE]))
    .digest("hex");
}

function enable(sandbox: Sandbox, model: string) {
  return enableFriendliForDsh({
    home: sandbox.home,
    dataDir: dshDataDir(sandbox.home),
    apiKeySource: "env",
    model,
    profile: PROFILE,
  });
}

function disable(sandbox: Sandbox, profileDirOverride?: string) {
  return disableFriendliForDsh({
    home: sandbox.home,
    dataDir: dshDataDir(sandbox.home),
    profile: PROFILE,
    profileDirOverride,
  });
}

function readState(sandbox: Sandbox) {
  return readProviderState(dshDataDir(sandbox.home), sandbox.home, PROFILE);
}

function legacyPaths(sandbox: Sandbox, dshHome: string) {
  const key = `${dshHome}::${PROFILE}`.replace(/[^a-zA-Z0-9:_.-]/g, "_");
  const dataDir = dshDataDir(sandbox.home);
  return {
    backup: path.join(dataDir, `config-${key}-backup.json`),
    state: path.join(dataDir, `provider-state-${key}.json`),
  };
}

describe("dsh backup/state slots", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await createSandboxHome();
    vi.stubEnv("DSH_HOME", "");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await sandbox.cleanup();
  });

  it.skipIf(process.platform === "win32")(
    "restores a legacy backup only for its recorded actual patch path",
    async () => {
      const homeA = path.join(sandbox.home, "a", "b");
      const homeB = path.join(sandbox.home, "a_b");
      const overrideDir = path.join(sandbox.home, "custom-profile");
      const actualPatch = patchPathOf(overrideDir);
      const wrongPatch = patchPathOf(path.join(homeB, "profiles", PROFILE));
      const wrongOriginal = "# wrong home\n- id: tools\n  config: {}\n";
      const original =
        "# before old enable\n- id: tools\n  config: {old: true}\n";
      const legacy = legacyPaths(sandbox, homeA);
      expect(legacyPaths(sandbox, homeB)).toEqual(legacy);
      await writeFileAtomic(wrongPatch, wrongOriginal);
      await writeFileAtomic(
        actualPatch,
        "- id: agent-default-model\n  config: {provider: friendli, model: old}\n",
      );
      await writeJson(legacy.backup, {
        configPath: path.relative(process.cwd(), actualPatch),
        snapshot: { existed: true, raw: original },
      });
      await writeJson(legacy.state, {
        apiKeySource: "flag",
        model: "ambiguous-legacy-model",
        profile: PROFILE,
      });
      const oldBackupBytes = await readFile(legacy.backup, "utf8");
      const oldStateBytes = await readFile(legacy.state, "utf8");

      // The colliding home must not restore or consume another path's backup.
      vi.stubEnv("DSH_HOME", homeB);
      expect(await readState(sandbox)).toBeUndefined();
      expect(await disable(sandbox)).toBe("none");
      expect(await readFile(wrongPatch, "utf8")).toBe(wrongOriginal);
      expect(await readFile(legacy.backup, "utf8")).toBe(oldBackupBytes);
      expect(await readFile(legacy.state, "utf8")).toBe(oldStateBytes);

      // Matching the home is insufficient: the actual profile override must match.
      vi.stubEnv("DSH_HOME", homeA);
      expect(await disable(sandbox)).toBe("none");
      expect(await readFile(legacy.backup, "utf8")).toBe(oldBackupBytes);
      expect(await disable(sandbox, overrideDir)).toBe("restored");
      // The live row was ours (two-key friendli signature, claimed via the
      // envelope-owned backup); the pre-on tools row was absent from the
      // live file — a post-on removal the merge preserves — so off leaves
      // an emptied patch instead of resurrecting the pre-on bytes.
      expect(await readFile(actualPatch, "utf8")).toBe("[]\n\n");
      await expect(readFile(legacy.backup, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      // Legacy state has no authoritative configPath, so never import/delete it.
      expect(await readState(sandbox)).toBeUndefined();
      expect(await readFile(legacy.state, "utf8")).toBe(oldStateBytes);
    },
  );

  it.skipIf(process.platform === "win32")(
    "retains a matching legacy snapshot when enabling without importing old state",
    async () => {
      const homeA = path.join(sandbox.home, "a", "b");
      const homeB = path.join(sandbox.home, "a_b");
      const patchA = patchPathOf(path.join(homeA, "profiles", PROFILE));
      const patchB = patchPathOf(path.join(homeB, "profiles", PROFILE));
      const original =
        "# legacy original\n- id: tools\n  config: {old: true}\n";
      const current = "# current\n- id: tools\n  config: {old: false}\n";
      const legacy = legacyPaths(sandbox, homeA);
      await writeFileAtomic(patchA, current);
      await writeFileAtomic(patchB, current);
      await writeJson(legacy.backup, {
        configPath: patchA,
        snapshot: { existed: true, raw: original },
      });
      await writeJson(legacy.state, {
        apiKeySource: "flag",
        model: "ambiguous-legacy-model",
        profile: PROFILE,
      });
      const oldBackupBytes = await readFile(legacy.backup, "utf8");
      const oldStateBytes = await readFile(legacy.state, "utf8");

      // A colliding home creates its own new snapshot, leaving legacy data alone.
      vi.stubEnv("DSH_HOME", homeB);
      expect(await readState(sandbox)).toBeUndefined();
      await enable(sandbox, "model-b");
      expect(await readState(sandbox)).toMatchObject({ model: "model-b" });
      expect(await readFile(legacy.backup, "utf8")).toBe(oldBackupBytes);
      expect(await readFile(legacy.state, "utf8")).toBe(oldStateBytes);
      expect(await disable(sandbox)).toBe("restored");
      expect(await readFile(patchB, "utf8")).toBe(current);

      vi.stubEnv("DSH_HOME", homeA);
      expect(await readState(sandbox)).toBeUndefined();
      await enable(sandbox, "model-a");
      expect(await readState(sandbox)).toMatchObject({ model: "model-a" });
      expect(await disable(sandbox)).toBe("restored");
      // The user's old:true -> old:false edit post-dates the legacy on and
      // survives off; our row is the only thing removed, so the merged
      // result keeps the live tools row (with the serialization convention
      // normalizing the flow-map spacing) rather than the legacy bytes.
      expect(await readFile(patchA, "utf8")).toBe(
        "# current\n- id: tools\n  config: { old: false }\n\n",
      );
      expect(await readFile(legacy.state, "utf8")).toBe(oldStateBytes);
      expect(await readdir(dshDataDir(sandbox.home))).toEqual([
        path.basename(legacy.state),
      ]);
    },
  );

  it("keeps slots usable when the old lossy basename would exceed filesystem limits", async () => {
    const home = path.join(sandbox.home, "a".repeat(120), "b".repeat(120));
    vi.stubEnv("DSH_HOME", home);
    await mkdir(dshDataDir(sandbox.home), { recursive: true });
    await enable(sandbox, "model-long-home");
    expect(await readState(sandbox)).toMatchObject({
      model: "model-long-home",
    });
    expect((await readdir(dshDataDir(sandbox.home))).sort()).toEqual([
      `config-${slotKey(home)}-backup.json`,
      `provider-state-${slotKey(home)}.json`,
    ]);
    expect(await disable(sandbox)).toBe("restored");
    expect(await readdir(dshDataDir(sandbox.home))).toEqual([]);
  });

  it("shares the backup/state slot across relative and absolute home aliases", async () => {
    const absoluteHome = path.join(sandbox.home, "alias");
    vi.stubEnv("DSH_HOME", path.relative(process.cwd(), absoluteHome));
    const patchPath = patchPathOf(dshProfile(sandbox.home, PROFILE));
    const original = "# original\n- id: tools\n  config: {enabled: true}\n";
    await writeFileAtomic(patchPath, original);
    await enable(sandbox, "model-relative");

    vi.stubEnv("DSH_HOME", absoluteHome);
    expect(await readState(sandbox)).toMatchObject({ model: "model-relative" });
    await enable(sandbox, "model-absolute");
    expect((await readdir(dshDataDir(sandbox.home))).sort()).toEqual([
      `config-${slotKey(absoluteHome)}-backup.json`,
      `provider-state-${slotKey(absoluteHome)}.json`,
    ]);

    vi.stubEnv("DSH_HOME", path.relative(process.cwd(), absoluteHome));
    expect(await readState(sandbox)).toMatchObject({ model: "model-absolute" });
    expect(await disable(sandbox)).toBe("restored");
    expect(await readFile(patchPath, "utf8")).toBe(original);
    expect(await readdir(dshDataDir(sandbox.home))).toEqual([]);
  });

  it("isolates colliding home names in portable full-SHA256 slots", async () => {
    const homeA = path.join(sandbox.home, "a", "b");
    const homeB = path.join(sandbox.home, "a_b");
    const patchA = patchPathOf(path.join(homeA, "profiles", PROFILE));
    const patchB = patchPathOf(path.join(homeB, "profiles", PROFILE));
    const originalA = "# home A\n- id: tools-a\n  config: {enabled: true}\n";
    const originalB = "# home B\n- id: tools-b\n  config: {enabled: false}\n";
    await writeFileAtomic(patchA, originalA);
    await writeFileAtomic(patchB, originalB);

    vi.stubEnv("DSH_HOME", homeA);
    await enable(sandbox, "model-a");
    vi.stubEnv("DSH_HOME", homeB);
    await enable(sandbox, "model-b");
    expect(await readState(sandbox)).toMatchObject({ model: "model-b" });
    const managedB = await readFile(patchB, "utf8");

    vi.stubEnv("DSH_HOME", homeA);
    expect(await readState(sandbox)).toMatchObject({ model: "model-a" });
    const basenames = await readdir(dshDataDir(sandbox.home));
    expect(basenames.sort()).toEqual(
      [homeA, homeB]
        .flatMap((home) => [
          `config-${slotKey(home)}-backup.json`,
          `provider-state-${slotKey(home)}.json`,
        ])
        .sort(),
    );
    for (const basename of basenames) {
      expect(basename).toMatch(
        /^(?:config-[a-f0-9]{64}-backup|provider-state-[a-f0-9]{64})\.json$/,
      );
      expect(basename).not.toMatch(/[<>:"/\\|?*]/);
      expect(
        [...basename].every((character) => character.charCodeAt(0) >= 32),
      ).toBe(true);
    }

    expect(await disable(sandbox)).toBe("restored");
    expect(await readFile(patchA, "utf8")).toBe(originalA);
    expect(await readState(sandbox)).toBeUndefined();
    expect(await readFile(patchB, "utf8")).toBe(managedB);

    vi.stubEnv("DSH_HOME", homeB);
    expect(await readState(sandbox)).toMatchObject({ model: "model-b" });
    expect(await disable(sandbox)).toBe("restored");
    expect(await readFile(patchB, "utf8")).toBe(originalB);
    expect(await readdir(dshDataDir(sandbox.home))).toEqual([]);
  });
});
