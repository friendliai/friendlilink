import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupPathFor } from "../../../src/harnesses/common/backup.js";
import {
  configBackupSlot,
  slotKey,
  snapshotOwnsConfigPath,
} from "../../../src/harnesses/common/slot-key.js";
import { writeJson } from "../../../src/io/json.js";
import { createSandboxHome, type Sandbox } from "../../helpers.js";

describe("common slot-key mechanism", () => {
  let sandbox: Sandbox;
  let dataDir: string;

  beforeEach(async () => {
    sandbox = await createSandboxHome();
    dataDir = path.join(sandbox.home, ".frlink", "slots");
    await mkdir(dataDir, { recursive: true });
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it("hashes the same scope tuple deterministically (algorithm locked)", () => {
    // The digest MUST stay byte-identical: existing slots on disk are keyed
    // by this exact SHA-256, so any algorithm change orphans user backups.
    expect(slotKey(["/resolved/home", "web"])).toBe(
      createHash("sha256")
        .update(JSON.stringify(["/resolved/home", "web"]))
        .digest("hex"),
    );
    expect(slotKey({ home: "/h", profile: "p" })).toBe(
      slotKey({ home: "/h", profile: "p" }),
    );
  });

  it("keys distinct scopes distinctly, tuple order included", () => {
    expect(slotKey(["a", "b"])).not.toBe(slotKey(["b", "a"]));
    expect(slotKey(["a", "b"])).not.toBe(slotKey(["a", "b", "c"]));
    expect(slotKey(["a", "b"])).not.toBe(slotKey({ 0: "a", 1: "b" }));
  });

  it("falls back to the fresh hashed slot when the legacy basename is overlong", async () => {
    const slotName = `config-${slotKey(["/home", "web"])}`;
    const backupPath = await configBackupSlot({
      dataDir,
      slotName,
      // Longer than any NAME_MAX: the probe read throws ENAMETOOLONG,
      // which must read as "no legacy backup has ever existed here".
      legacySlotName: `config-${"x".repeat(300)}`,
      configPath: path.join(
        sandbox.home,
        "profiles",
        "web",
        "cordis.patch.yml",
      ),
    });
    expect(backupPath).toBe(backupPathFor(dataDir, slotName));
  });

  it.skipIf(process.platform === "win32")(
    "reuses a legacy slot only when its recorded configPath proves ownership",
    async () => {
      const slotName = `config-${slotKey(["/home/a", "web"])}`;
      const hashedPath = backupPathFor(dataDir, slotName);
      const configPath = path.join(
        sandbox.home,
        "profiles",
        "web",
        "cordis.patch.yml",
      );
      const snapshot = { existed: true, raw: "- id: tools\n" };
      const owned = backupPathFor(dataDir, "config-legacy-owned");
      const foreign = backupPathFor(dataDir, "config-legacy-foreign");
      await writeJson(owned, {
        // A path alias of configPath still proves THIS patch's ownership.
        configPath: path.relative(process.cwd(), configPath),
        snapshot,
      });
      await writeJson(foreign, {
        configPath: path.join(sandbox.home, "elsewhere", "patch.yml"),
        snapshot,
      });

      expect(
        await configBackupSlot({
          dataDir,
          slotName,
          legacySlotName: "config-legacy-foreign",
          configPath,
        }),
      ).toBe(hashedPath);
      expect(
        await configBackupSlot({
          dataDir,
          slotName,
          legacySlotName: "config-legacy-owned",
          configPath,
        }),
      ).toBe(owned);

      // A hashed slot that exists wins over any legacy slot: taking a new
      // snapshot must not shadow a valid legacy original.
      await writeJson(hashedPath, {
        configPath,
        snapshot: { existed: true, raw: "- id: later\n" },
      });
      expect(
        await configBackupSlot({
          dataDir,
          slotName,
          legacySlotName: "config-legacy-owned",
          configPath,
        }),
      ).toBe(hashedPath);
    },
  );

  it("proves recorded-path ownership across path aliases only", () => {
    const configPath = path.join(sandbox.home, "profiles", "web", "cfg.yaml");
    const envelope = { configPath, snapshot: { existed: true, raw: "" } };
    expect(snapshotOwnsConfigPath(envelope, configPath)).toBe(true);
    expect(
      snapshotOwnsConfigPath(
        {
          configPath: path.relative(process.cwd(), configPath),
          snapshot: { existed: false, raw: "" },
        },
        configPath,
      ),
    ).toBe(true);
    expect(
      snapshotOwnsConfigPath(
        {
          configPath: path.join(sandbox.home, "other", "cfg.yaml"),
          snapshot: { existed: true, raw: "" },
        },
        configPath,
      ),
    ).toBe(false);
    expect(snapshotOwnsConfigPath(undefined, configPath)).toBe(false);
  });
});
