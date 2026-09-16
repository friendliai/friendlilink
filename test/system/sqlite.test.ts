import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyItemTableWrites,
  ensureItemTable,
  readItemTableValue,
} from "../../src/system/sqlite.js";
import { createSandboxHome, type Sandbox } from "../helpers.js";

describe("state.vscdb ItemTable access", () => {
  let sandbox: Sandbox;
  let dbPath: string;

  beforeEach(async () => {
    sandbox = await createSandboxHome();
    dbPath = path.join(sandbox.home, "state.vscdb");
    await mkdir(path.dirname(dbPath), { recursive: true });
    await ensureItemTable(dbPath);
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it("round-trips text values through write/read", async () => {
    await applyItemTableWrites(dbPath, [
      { op: "set", key: "k1", value: "plain-value" },
    ]);
    expect(await readItemTableValue(dbPath, "k1")).toBe("plain-value");

    await applyItemTableWrites(dbPath, [
      { op: "set", key: "k1", value: '{"json":true}' },
    ]);
    expect(await readItemTableValue(dbPath, "k1")).toBe('{"json":true}');
  });

  it("treats a missing row and a missing DB as empty strings", async () => {
    expect(await readItemTableValue(dbPath, "absent-key")).toBe("");
    expect(
      await readItemTableValue(path.join(sandbox.home, "no-such-db"), "k"),
    ).toBe("");
  });

  it("applies a write set atomically and deletes rows", async () => {
    await applyItemTableWrites(dbPath, [
      { op: "set", key: "k1", value: "one" },
      { op: "set", key: "k2", value: "two" },
    ]);
    await applyItemTableWrites(dbPath, [{ op: "del", key: "k1" }]);
    expect(await readItemTableValue(dbPath, "k1")).toBe("");
    expect(await readItemTableValue(dbPath, "k2")).toBe("two");
  });

  it("escapes single quotes in keys and values", async () => {
    const tricky = 'it\'s a "quote" party';
    await applyItemTableWrites(dbPath, [
      { op: "set", key: "key'with'quotes", value: tricky },
    ]);
    expect(await readItemTableValue(dbPath, "key'with'quotes")).toBe(tricky);
  });

  it("keeps spaces and newlines verbatim", async () => {
    const blob = JSON.stringify({ nested: { array: ["a\nb", "c d"] } });
    await applyItemTableWrites(dbPath, [
      { op: "set", key: "blob", value: blob },
    ]);
    expect(await readItemTableValue(dbPath, "blob")).toBe(blob);
    await rm(dbPath, { force: true });
  });
});
