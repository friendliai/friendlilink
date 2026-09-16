import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readGlobalConfig,
  setHarnessEnabled,
} from "../../../src/config/global-config.js";
import { createBaseContext } from "../../../src/harness/types.js";
import {
  claudeDataDir,
  enableFriendliProvider,
  userSettingsPath,
} from "../../../src/harnesses/claude/core.js";
import { claudeAdapter } from "../../../src/harnesses/claude/index.js";
import { writeJson } from "../../../src/io/json.js";
import { createSandboxHome, type Sandbox } from "../../helpers.js";

describe("Claude backup recovery", () => {
  let sandbox: Sandbox;
  let settingsPath: string;
  let dataDir: string;
  const settings = {
    env: { FRLINK_MANAGED: "1", ANTHROPIC_AUTH_TOKEN: "test-key" },
  };

  beforeEach(async () => {
    sandbox = await createSandboxHome();
    settingsPath = userSettingsPath(sandbox.home);
    dataDir = claudeDataDir(sandbox.home);
    await writeJson(settingsPath, settings);
    await setHarnessEnabled(sandbox.home, "claude", true);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await sandbox.cleanup();
  });

  it("fails off without changing settings or enabled state when the backup is missing", async () => {
    const before = await readFile(settingsPath, "utf8");
    await expect(
      claudeAdapter.off({ ...createBaseContext(), home: sandbox.home }),
    ).rejects.toThrow("no matching pre-FriendliAI backup");
    expect(await readFile(settingsPath, "utf8")).toBe(before);
    expect(
      (await readGlobalConfig(sandbox.home)).harnesses.claude?.enabled,
    ).toBe(true);
  });

  it("does not snapshot managed settings as the original when the backup is missing", async () => {
    await expect(
      enableFriendliProvider({
        settingsPath,
        dataDir,
        apiKey: "new-key",
        apiKeySource: "env",
        baseUrl: "https://example.invalid",
        mainModel: "",
        mapping: {},
      }),
    ).rejects.toThrow("no matching pre-FriendliAI backup");
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual(settings);
    await expect(
      readFile(path.join(dataDir, "provider-backup.json")),
    ).rejects.toThrow();
  });

  it.each([
    { managed: true, existed: true },
    { managed: false, existed: true },
    { managed: true, existed: false },
    { managed: false, existed: false },
  ])(
    "rejects off for a different settings path (managed: $managed, snapshot existed: $existed)",
    async ({ managed, existed }) => {
      const selectedPath = path.join(sandbox.home, "other-settings.json");
      await writeJson(selectedPath, managed ? settings : { custom: "keep" });
      const backupPath = path.join(dataDir, "provider-backup.json");
      const statePath = path.join(dataDir, "provider-state.json");
      await writeJson(backupPath, {
        configPath: settingsPath,
        snapshot: { existed, raw: existed ? '{"unrelated":true}' : "" },
      });
      await writeJson(statePath, { apiKeySource: "env", mapping: {} });
      const preservedPaths = [
        selectedPath,
        settingsPath,
        backupPath,
        statePath,
      ];
      const before = await Promise.all(
        preservedPaths.map((file) => readFile(file, "utf8")),
      );

      await expect(
        claudeAdapter.off({
          ...createBaseContext(),
          home: sandbox.home,
          settingsPath: selectedPath,
        }),
      ).rejects.toThrow("backup does not belong to the selected settings path");

      expect(
        await Promise.all(preservedPaths.map((file) => readFile(file, "utf8"))),
      ).toEqual(before);
      expect(
        (await readGlobalConfig(sandbox.home)).harnesses.claude?.enabled,
      ).toBe(true);
    },
  );

  it("rejects on when the data directory holds a backup for another settings path", async () => {
    const selectedPath = path.join(sandbox.home, "new-settings.json");
    const backupPath = path.join(dataDir, "provider-backup.json");
    await writeJson(backupPath, {
      configPath: settingsPath,
      snapshot: { existed: true, raw: "{}" },
    });
    const before = await readFile(backupPath, "utf8");
    await expect(
      enableFriendliProvider({
        settingsPath: selectedPath,
        dataDir,
        apiKey: "new-key",
        apiKeySource: "env",
        baseUrl: "https://example.invalid",
        mainModel: "",
        mapping: {},
      }),
    ).rejects.toThrow("backup does not belong to the selected settings path");
    await expect(readFile(selectedPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(backupPath, "utf8")).toBe(before);
  });

  it("rejects a backup without a recorded configPath", async () => {
    await writeJson(path.join(dataDir, "provider-backup.json"), {
      snapshot: { existed: true, raw: "{}" },
    });
    await expect(
      claudeAdapter.off({ ...createBaseContext(), home: sandbox.home }),
    ).rejects.toThrow("backup does not belong to the selected settings path");
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual(settings);
  });

  it("accepts a recorded configPath that resolves to the selected settings path", async () => {
    await writeJson(path.join(dataDir, "provider-backup.json"), {
      configPath: path.relative(process.cwd(), settingsPath),
      snapshot: { existed: true, raw: '{"custom":"original"}\n' },
    });
    await claudeAdapter.off({
      ...createBaseContext(),
      home: sandbox.home,
      settingsPath,
    });
    expect(await readFile(settingsPath, "utf8")).toBe(
      '{"custom":"original"}\n',
    );
  });

  it.each([true, false])(
    "off restores the frlink snapshot (file originally existed: %s)",
    async (existed) => {
      const original = '{\n  "custom": true\n}\n';
      await writeJson(path.join(dataDir, "provider-backup.json"), {
        configPath: settingsPath,
        snapshot: { existed, raw: existed ? original : "" },
      });
      await writeJson(path.join(dataDir, "provider-state.json"), {
        apiKeySource: "env",
        mapping: {},
      });
      await claudeAdapter.off({ ...createBaseContext(), home: sandbox.home });
      if (existed) expect(await readFile(settingsPath, "utf8")).toBe(original);
      else await expect(readFile(settingsPath)).rejects.toThrow();
      expect(
        (await readGlobalConfig(sandbox.home)).harnesses.claude?.enabled,
      ).toBe(false);
      for (const file of ["provider-backup.json", "provider-state.json"]) {
        await expect(readFile(path.join(dataDir, file))).rejects.toThrow();
      }
      await claudeAdapter.off({ ...createBaseContext(), home: sandbox.home });
    },
  );
});
