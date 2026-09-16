import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { revertOwnedEnvKey, writeOwnedEnvKey } from "../../src/keys/env.js";
import { writeFileAtomic } from "../../src/io/atomic-write.js";
import { createSandboxHome, type Sandbox } from "../helpers.js";

const KEY = "FRIENDLIAI_API_KEY";

describe("env key ownership", () => {
  let sandbox: Sandbox;
  let dataDir: string;
  let envPath: string;

  beforeEach(async () => {
    sandbox = await createSandboxHome();
    dataDir = join(sandbox.home, "data");
    envPath = join(sandbox.home, "dsh", ".env");
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  /** The shared on/off flow every dotenv harness uses. */
  const on = (value: string) =>
    writeOwnedEnvKey({ dataDir, envPath, key: KEY, value });
  const off = () => revertOwnedEnvKey({ dataDir, envPath, key: KEY });
  const writeUserKey = (value: string) =>
    writeFileAtomic(envPath, `${KEY}=${value}\n`);

  it("restores a pre-existing user key line that on overwrote", async () => {
    await writeUserKey("user-own-key");
    await on("frlink-key");

    expect(await off()).toBe("reverted");
    expect(await readFile(envPath, "utf8")).toBe(`${KEY}=user-own-key\n`);
  });

  it("deletes the line when the user had no such key, keeping other lines", async () => {
    const original = `OTHER=keep\n# comment\n`;
    // Seed via writeFileAtomic (same parent-dir behavior as the managed write).
    await writeFileAtomic(envPath, original);
    await on("frlink-key");

    expect(await off()).toBe("reverted");
    expect(await readFile(envPath, "utf8")).toBe(original);
  });

  it("deletes a file that on created and left otherwise empty", async () => {
    await on("frlink-key");
    expect(await readFile(envPath, "utf8")).toBe(`${KEY}=frlink-key\n`);

    await off();
    await expect(readFile(envPath, "utf8")).rejects.toThrow();
  });

  it("keeps a file on-created but since edited by the user (other lines added)", async () => {
    await on("frlink-key");
    // The user adds their own secret while managed.
    await writeFileAtomic(envPath, `${KEY}=frlink-key\nNEW_SECRET=x\n`);

    await off();

    // Our line is gone; the user's addition survives — file existed=false,
    // but it now has real content, so it must not be deleted.
    expect(await readFile(envPath, "utf8")).toBe(`NEW_SECRET=x\n`);
  });

  it("preserves the user's own edit to the same field (never reverts it)", async () => {
    await writeUserKey("user-own-key");
    await on("frlink-key");
    // The user re-points the key by hand while managed.
    await writeUserKey("user-rotated-key");

    await off();

    expect(await readFile(envPath, "utf8")).toBe(`${KEY}=user-rotated-key\n`);
  });

  it("restores multiple duplicate pre-existing key lines, in order", async () => {
    await writeFileAtomic(
      envPath,
      `OTHER=1\n${KEY}=first\nMID=2\n${KEY}=second\n`,
    );
    await on("frlink-key");

    await off();

    // The lines are restored in relative order at the anchor position (our
    // line's index); dotenv position among unrelated lines carries no
    // meaning, and later-duplicate still wins as before.
    expect(await readFile(envPath, "utf8")).toBe(
      `OTHER=1\nMID=2\n${KEY}=first\n${KEY}=second\n`,
    );
  });

  it("a re-on refreshes the written line but keeps the original capture", async () => {
    await writeUserKey("user-own-key");
    await on("frlink-key");
    await on("frlink-key-2");

    await off();
    expect(await readFile(envPath, "utf8")).toBe(`${KEY}=user-own-key\n`);
  });

  it("drops our value but keeps the user's lines when both coexist after an edit", async () => {
    // User re-added their own line ABOVE our still-writable field state.
    await writeFileAtomic(envPath, `${KEY}=user-line\n`);
    await on("ours");
    await writeFileAtomic(envPath, `${KEY}=user-line\n${KEY}=ours\nMID=1\n`);

    await off();
    // Field no longer matches what we wrote (2 lines) → treated as user's.
    expect(await readFile(envPath, "utf8")).toBe(`${KEY}=user-line\nMID=1\n`);
  });

  it("returns none when there is no record (never managed)", async () => {
    await writeUserKey("user-own-key");
    expect(await off()).toBe("none");
    expect(await readFile(envPath, "utf8")).toBe(`${KEY}=user-own-key\n`);
  });

  it("a no-record off never touches a file it does not own (env home changed)", async () => {
    await writeUserKey("user-own-key");
    // A different resolved home has no ownership record for this file.
    expect(
      await revertOwnedEnvKey({
        dataDir,
        envPath: join(sandbox.home, "other-home", ".env"),
        key: KEY,
      }),
    ).toBe("none");
    expect(await readFile(envPath, "utf8")).toBe(`${KEY}=user-own-key\n`);
  });

  it("removes the record after revert, so a second off is a no-op", async () => {
    await on("frlink-key");
    expect(await off()).toBe("reverted");
    expect(await off()).toBe("none");
  });
});
