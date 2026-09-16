import { beforeEach, describe, expect, it, vi } from "vitest";

// `macReadMasterPassword` is the one path that can raise a macOS Keychain
// dialog; mocking the spawn lets the prompt count be asserted on any host.
const spawnSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

const {
  aesDecrypt,
  aesEncrypt,
  windowsAesGcmDecrypt,
  windowsAesGcmEncrypt,
  macReadMasterPassword,
  resetMacMasterPasswordCacheForTests,
  EMPTY_BUFFER_JSON,
} = await import("../../src/system/safestorage.js");

describe("safestorage OSCrypt primitives", () => {
  /** macOS scheme: v10 + AES-128-CBC, PBKDF2(1003). */
  it("round-trips a secret through the macOS AES scheme", () => {
    const encrypted = aesEncrypt(
      "flp_super-secret-key",
      "master-password",
      "v10",
      1003,
    );
    expect(encrypted.subarray(0, 3).toString("latin1")).toBe("v10");
    expect(encrypted).not.toContain("flp_super-secret");
    expect(aesDecrypt(encrypted, "master-password", 1003)).toBe(
      "flp_super-secret-key",
    );
  });

  it("does not decrypt with the wrong master password", () => {
    const encrypted = aesEncrypt("secret", "right", "v10", 1003);
    expect(() => aesDecrypt(encrypted, "wrong", 1003)).toThrow();
  });

  /** Linux schemes: v11 with keyring (1 iteration) and v10 basic_text. */
  it("round-trips the Linux keyring (v11) and basic_text (v10) schemes", () => {
    const v11 = aesEncrypt("secret", "keyring-password", "v11", 1);
    expect(v11.subarray(0, 3).toString("latin1")).toBe("v11");
    expect(aesDecrypt(v11, "keyring-password", 1)).toBe("secret");

    const v10 = aesEncrypt("secret", "peanuts", "v10", 1);
    expect(aesDecrypt(v10, "peanuts", 1)).toBe("secret");
  });

  /** Windows scheme: v10 + AES-256-GCM, tag at the end. */
  it("round-trips a secret through the Windows AES-256-GCM scheme", async () => {
    const { randomBytes } = await import("node:crypto");
    const key = randomBytes(32);
    const encrypted = windowsAesGcmEncrypt("flp_super-secret-key", key);
    expect(encrypted.subarray(0, 3).toString("latin1")).toBe("v10");
    expect(encrypted).not.toContain("flp_super-secret");
    expect(windowsAesGcmDecrypt(encrypted, key)).toBe("flp_super-secret-key");
  });

  it("exposes Cursor's empty-ciphertext 'no key' shape", () => {
    expect(EMPTY_BUFFER_JSON).toBe('{"type":"Buffer","data":[]}');
    expect(JSON.stringify(JSON.parse(EMPTY_BUFFER_JSON))).toBeDefined();
  });
});

describe("macOS Safe Storage master password lookup", () => {
  beforeEach(() => {
    resetMacMasterPasswordCacheForTests();
    spawnSyncMock.mockReset();
  });

  /** Each `security` call can raise a Keychain dialog, so a hit must be
   * memoised — otherwise every encrypt/decrypt in one `cursor on` prompts. */
  it("spawns `security` once across repeated reads", () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "master-password\n" });

    expect(macReadMasterPassword()).toBe("master-password");
    expect(macReadMasterPassword()).toBe("master-password");

    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  /** A denied or cancelled dialog exits non-zero. Without caching the failure,
   * the next caller re-spawns and the user who just said no is asked again. */
  it("spawns `security` once when the lookup fails", () => {
    spawnSyncMock.mockReturnValue({ status: 1, stdout: "" });

    expect(macReadMasterPassword()).toBe("");
    expect(macReadMasterPassword()).toBe("");

    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });
});
