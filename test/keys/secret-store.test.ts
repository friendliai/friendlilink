import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSandboxHome, type Sandbox } from "../helpers.js";

// cross-keychain talks to the OS keychain via the real process environment,
// not the `home` string passed into setSecret/getSecret — so on a dev
// machine with a real keychain it would silently succeed regardless of
// `home`, masking the plaintext fallback path these tests exercise. Forcing
// it to fail here makes the fallback (and its warnings) deterministic.
vi.mock("cross-keychain", () => ({
  setPassword: () => {
    throw new Error("no keychain in test environment");
  },
  getPassword: () => null,
  deletePassword: () => false,
  listBackends: () => [],
}));

const { setSecret } = await import("../../src/keys/secret-store.js");

describe("secret-store plaintext fallback warnings", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("emits a single consolidated warning, not a wall of text", async () => {
    const home = path.join(process.cwd(), ".tmp-secret-store-test-home");
    await mkdir(home, { recursive: true });
    try {
      await setSecret(home, "test-key");

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).not.toContain("\n");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("warns that $HOME looks like it was overridden to a temp directory", async () => {
    // createSandboxHome() itself lives under the OS temp dir, same as a
    // real accidental `$HOME` override would.
    const sandbox: Sandbox = await createSandboxHome();
    try {
      await setSecret(sandbox.home, "test-key");

      const messages = warnSpy.mock.calls.map((call) => String(call[0]));
      expect(
        messages.some((message) =>
          message.includes("looks like a temp directory"),
        ),
      ).toBe(true);
    } finally {
      await sandbox.cleanup();
    }
  });

  it("does not warn about a temp directory for a normal home path", async () => {
    const home = path.join(process.cwd(), ".tmp-secret-store-test-home");
    await mkdir(home, { recursive: true });
    try {
      await setSecret(home, "test-key");

      const messages = warnSpy.mock.calls.map((call) => String(call[0]));
      expect(
        messages.some((message) =>
          message.includes("looks like a temp directory"),
        ),
      ).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
