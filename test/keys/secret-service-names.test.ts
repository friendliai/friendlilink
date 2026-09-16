import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSandboxHome, type Sandbox } from "../helpers.js";

/**
 * A working in-memory keychain, unlike secret-store.test.ts's always-failing
 * one: these tests are about WHICH service names are read, written, and
 * deleted, which only shows up when the backend succeeds.
 */
const store = new Map<string, string>();
const key = (service: string, account: string) => `${service}::${account}`;
const setPassword = vi.fn(async (s: string, a: string, v: string) => {
  store.set(key(s, a), v);
});
const getPassword = vi.fn(
  async (s: string, a: string) => store.get(key(s, a)) ?? null,
);
const deletePassword = vi.fn(async (s: string, a: string) =>
  store.delete(key(s, a)),
);

vi.mock("cross-keychain", () => ({
  setPassword: (...args: [string, string, string]) => setPassword(...args),
  getPassword: (...args: [string, string]) => getPassword(...args),
  deletePassword: (...args: [string, string]) => deletePassword(...args),
  listBackends: () => ["test"],
}));

const { SECRET_ACCOUNT, SECRET_SERVICE, deleteSecret, getSecret, setSecret } =
  await import("../../src/keys/secret-store.js");

describe("keychain service names", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    store.clear();
    setPassword.mockClear();
    getPassword.mockClear();
    deletePassword.mockClear();
    sandbox = await createSandboxHome();
  });
  afterEach(async () => {
    await sandbox.cleanup();
  });

  it("writes, reads, and deletes only under the FriendliLink service", async () => {
    await setSecret(sandbox.home, "flp_key");
    expect(store.get(key(SECRET_SERVICE, SECRET_ACCOUNT))).toBe("flp_key");
    await expect(getSecret(sandbox.home)).resolves.toBe("flp_key");
    await deleteSecret(sandbox.home);
    expect(store.has(key(SECRET_SERVICE, SECRET_ACCOUNT))).toBe(false);
  });

  it("falls back to the plaintext file when the keychain has nothing", async () => {
    await expect(getSecret(sandbox.home)).resolves.toBeNull();
  });

  it("resolves when the keychain read throws — falls back to the file", async () => {
    getPassword.mockRejectedValueOnce(new Error("keychain is locked"));
    await expect(getSecret(sandbox.home)).resolves.toBeNull();
  });

  it("logout deletes the plaintext key file too", async () => {
    const { STATE_DIR } = await import("../../src/config/paths.js");
    await mkdir(path.join(sandbox.home, STATE_DIR), { recursive: true });
    await writeFile(path.join(sandbox.home, STATE_DIR, ".api-key"), "flp_file");

    await deleteSecret(sandbox.home);

    expect(existsSync(path.join(sandbox.home, STATE_DIR, ".api-key"))).toBe(
      false,
    );
    await expect(getSecret(sandbox.home)).resolves.toBeNull();
  });

  it("logout survives the key item already being gone", async () => {
    await deleteSecret(sandbox.home);
    expect(deletePassword).toHaveBeenCalledWith(SECRET_SERVICE, SECRET_ACCOUNT);
  });
});
