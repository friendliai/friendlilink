import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sandbox } from "../../helpers.js";

const insideCursorMock = vi.fn(() => false);
vi.mock("../../../src/harnesses/cursor/guard.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/harnesses/cursor/guard.js")
    >();
  return {
    ...actual,
    isInsideCursor: () => insideCursorMock(),
    stopCursor: async () => {},
    waitForCursorExit: async () => true,
  };
});

process.env.FRLINK_SECRET_PLAINTEXT = "1";

const { ensureItemTable, readItemTableValue } =
  await import("../../../src/system/sqlite.js");
const { APPLICATION_USER_KEY } =
  await import("../../../src/harnesses/cursor/core.js");
const { cursorAdapter } =
  await import("../../../src/harnesses/cursor/index.js");
const { createBaseContext } = await import("../../../src/harness/types.js");
const { pendingPath, deferUntilCursorExits } =
  await import("../../../src/harnesses/cursor/deferred.js");
const { createSandboxHome } = await import("../../helpers.js");

describe("cursor on/off from Cursor's own terminal", () => {
  let sandbox: Sandbox;
  let dbPath: string;
  let dataDir: string;

  beforeEach(async () => {
    sandbox = await createSandboxHome();
    dbPath = path.join(sandbox.home, "state.vscdb");
    dataDir = path.join(sandbox.home, "data");
    await mkdir(path.dirname(dbPath), { recursive: true });
    await ensureItemTable(dbPath);
    insideCursorMock.mockReset().mockReturnValue(false);
  });
  afterEach(async () => await sandbox.cleanup());

  const ctx = (extra: Record<string, unknown> = {}) => ({
    ...createBaseContext(),
    home: sandbox.home,
    settingsPath: dbPath,
    dataDir,
    onboardingMode: "skip" as const,
    ...extra,
  });

  it("writes nothing now and queues the work instead", async () => {
    insideCursorMock.mockReturnValue(true);
    const spawnFn = vi.fn(() => ({ unref: () => {} }));

    // The adapter path must not touch the database at all.
    await cursorAdapter.off(ctx());
    expect(await readItemTableValue(dbPath, APPLICATION_USER_KEY)).toBe("");

    // ...and the marker `status` reads must be there.
    await deferUntilCursorExits({
      verb: "off",
      dataDir,
      argv: ["cursor", "off"],
      spawnFn: spawnFn as never,
    });
    const marker = JSON.parse(await readFile(pendingPath(dataDir), "utf8"));
    expect(marker.verb).toBe("off");
  });

  it("passes the original flags plus the wait flag to the detached run", async () => {
    const spawnFn = vi.fn(() => ({ unref: () => {} }));
    await deferUntilCursorExits({
      verb: "on",
      dataDir,
      argv: ["cursor", "on", "--base-url", "https://staging.example"],
      spawnFn: spawnFn as never,
    });
    const [, args, opts] = spawnFn.mock.calls[0] as unknown as [
      string,
      string[],
      { detached: boolean },
    ];
    expect(args).toContain("--base-url");
    expect(args).toContain("https://staging.example");
    expect(args.at(-1)).toBe("--await-cursor-exit");
    expect(opts.detached).toBe(true);
  });

  it("the detached run does the work and clears the marker", async () => {
    insideCursorMock.mockReturnValue(true);
    await deferUntilCursorExits({
      verb: "off",
      dataDir,
      argv: ["cursor", "off"],
      spawnFn: (() => ({ unref: () => {} })) as never,
    });

    // --await-cursor-exit is what stops it deferring again forever.
    await cursorAdapter.off(ctx({ awaitCursorExit: true }));

    await expect(readFile(pendingPath(dataDir), "utf8")).rejects.toThrow();
  });
});
