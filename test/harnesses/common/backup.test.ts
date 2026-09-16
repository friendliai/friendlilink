import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  backupPathFor,
  restoreFileFromBackup,
  snapshotFileIfNeeded,
} from "../../../src/harnesses/common/backup.js";
import { writeFileAtomic } from "../../../src/io/atomic-write.js";
import { createSandboxHome, type Sandbox } from "../../helpers.js";

describe("common backup helper", () => {
  let sandbox: Sandbox;
  let dataDir: string;
  let configPath: string;
  let lastManagedAnswer: boolean;

  beforeEach(async () => {
    sandbox = await createSandboxHome();
    dataDir = `${sandbox.home}/.frlink/test-harness`;
    configPath = `${sandbox.home}/test-harness/config.json`;
    lastManagedAnswer = false;
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  function snapshot() {
    return snapshotFileIfNeeded({
      configPath,
      backupPath: backupPathFor(dataDir, "config"),
      isManaged: () => Promise.resolve(lastManagedAnswer),
    });
  }

  it("snapshots the raw config bytes and restores them byte-for-byte", async () => {
    const original = '{\n  "custom": true,\n  "spacing": "kept"\n}\n';
    await writeFileAtomic(configPath, original);

    await snapshot();
    await writeFileAtomic(
      configPath,
      JSON.stringify({ friendli: true }) + "\n",
    );

    // Deliberately reformat — restore must return the original bytes, not a
    // re-serialization.
    expect(
      await restoreFileFromBackup({
        configPath,
        backupPath: backupPathFor(dataDir, "config"),
      }),
    ).toBe("restored");
    expect(await readFile(configPath, "utf8")).toBe(original);
  });

  it("deletes the config on restore when it didn't exist before enable", async () => {
    await snapshot();
    await writeFileAtomic(configPath, "{}\n");

    expect(
      await restoreFileFromBackup({
        configPath,
        backupPath: backupPathFor(dataDir, "config"),
      }),
    ).toBe("restored");
    await expect(readFile(configPath, "utf8")).rejects.toThrow();
  });

  it("removes the backup file once restored, so a second restore is a no-op", async () => {
    await writeFileAtomic(configPath, "original");
    await snapshot();

    expect(
      await restoreFileFromBackup({
        configPath,
        backupPath: backupPathFor(dataDir, "config"),
      }),
    ).toBe("restored");
    expect(
      await restoreFileFromBackup({
        configPath,
        backupPath: backupPathFor(dataDir, "config"),
      }),
    ).toBe("none");
  });

  it("does not overwrite an existing snapshot on a second enable", async () => {
    const original = "pre-frlink bytes";
    await writeFileAtomic(configPath, original);
    await snapshot();

    // Managed state changed the config; a re-run of `on` must not snapshot
    // the managed bytes over the pre-FriendliLink backup.
    await writeFileAtomic(configPath, "managed bytes\n");
    lastManagedAnswer = true;
    await snapshot();
    lastManagedAnswer = false;

    await restoreFileFromBackup({
      configPath,
      backupPath: backupPathFor(dataDir, "config"),
    });
    expect(await readFile(configPath, "utf8")).toBe(original);
  });

  it("skips snapshotting entirely when the config is already managed", async () => {
    lastManagedAnswer = true;
    await snapshot();
    await expect(
      readFile(backupPathFor(dataDir, "config"), "utf8"),
    ).rejects.toThrow();
  });
});
