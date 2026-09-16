import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// login/logout persist to the machine-global OS keychain and verify the
// key against the real Friendli endpoint — mock both so these tests stay
// offline and never touch a real keychain (same pattern as
// key-preamble.test.ts: factory mocks hoisted above the imports below).
vi.mock("../../src/keys/secret-store.js", () => ({
  setSecret: vi.fn().mockResolvedValue(undefined),
  getSecret: vi.fn().mockResolvedValue(null),
  deleteSecret: vi.fn().mockResolvedValue(undefined),
}));

const verifyFriendliApiKeyMock = vi.fn();

vi.mock("../../src/friendli/client.js", () => ({
  verifyFriendliApiKey: (...args: unknown[]) =>
    verifyFriendliApiKeyMock(...args),
}));

// The interactive login draws a clack frame around the password prompt; mock
// the whole module so the welcome, cancel and outro paths are observable
// without a TTY. The flag-key tests below never reach any of it.
const passwordMock = vi.fn();
const isCancelMock = vi.fn(() => false);
const introMock = vi.fn();
const outroMock = vi.fn();
const cancelMock = vi.fn();
const logMessageMock = vi.fn();

vi.mock("@clack/prompts", () => ({
  intro: (...args: unknown[]) => introMock(...args),
  outro: (...args: unknown[]) => outroMock(...args),
  cancel: (...args: unknown[]) => cancelMock(...args),
  password: (...args: unknown[]) => passwordMock(...args),
  isCancel: (...args: unknown[]) => isCancelMock(...args),
  log: { message: (...args: unknown[]) => logMessageMock(...args) },
}));

const { runLogin, runLogout } =
  await import("../../src/cli/commands/global.js");
const { globalConfigPath, writeGlobalConfig } =
  await import("../../src/config/global-config.js");
const { setSecret, deleteSecret } =
  await import("../../src/keys/secret-store.js");
const { createBaseContext } = await import("../../src/harness/types.js");

/** ctx with the key on the flag so login never falls back to the prompt. */
function ctx(home: string, apiKey: string) {
  return { ...createBaseContext(), home, apiKey, apiKeyFromFlag: true };
}

const WORK_HOME = path.join(process.cwd(), ".tmp-auth-test-home");

describe("login / logout", () => {
  beforeEach(async () => {
    verifyFriendliApiKeyMock.mockReset();
    vi.mocked(setSecret).mockClear();
    vi.mocked(deleteSecret).mockClear();
    passwordMock.mockReset();
    isCancelMock.mockReset().mockReturnValue(false);
    introMock.mockReset();
    outroMock.mockReset();
    cancelMock.mockReset();
    logMessageMock.mockReset();
    await rm(WORK_HOME, { recursive: true, force: true });
  });

  it("login persists an accepted flag key; config.json keeps only the ref", async () => {
    verifyFriendliApiKeyMock.mockResolvedValue({ ok: true });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runLogin(ctx(WORK_HOME, "friendli-flag-key-1234"));

      expect(setSecret).toHaveBeenCalledWith(
        WORK_HOME,
        "friendli-flag-key-1234",
      );
      // config.json records the keychain ref — never the literal key.
      expect(
        JSON.parse(await readFile(globalConfigPath(WORK_HOME), "utf8")),
      ).toEqual({ apiKey: "{keychain:friendli-api-key}", harnesses: {} });
    } finally {
      log.mockRestore();
    }
  });

  it("login rejects a key Friendli denies, without saving anything", async () => {
    verifyFriendliApiKeyMock.mockResolvedValue({
      ok: false,
      message: "unauthorized: bad key",
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(
        runLogin(ctx(WORK_HOME, "friendli-flag-key-1234")),
      ).rejects.toThrow(/unauthorized: bad key/);
      expect(setSecret).not.toHaveBeenCalled();
      expect(globalConfigPath(WORK_HOME)).toContain("config.json");
    } finally {
      log.mockRestore();
    }
  });

  /** No key on the flag, so login falls through to the prompt. */
  function promptCtx(home: string) {
    return { ...createBaseContext(), home };
  }

  it("interactive login frames the prompt with the welcome and closes on success", async () => {
    verifyFriendliApiKeyMock.mockResolvedValue({ ok: true });
    passwordMock.mockResolvedValue("friendli-typed-key-1234");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runLogin(promptCtx(WORK_HOME));

      expect(introMock).toHaveBeenCalledWith("FRIENDLIAI · FriendliLink");
      expect(logMessageMock.mock.calls[0]?.[0]).toContain(
        "https://friendli.ai/suite",
      );
      expect(passwordMock).toHaveBeenCalledWith({
        message: "FriendliAI API key:",
      });
      expect(setSecret).toHaveBeenCalledWith(
        WORK_HOME,
        "friendli-typed-key-1234",
      );
      // The frame owns the closing line, so no bare `frlink:` line is printed.
      expect(outroMock).toHaveBeenCalledWith(
        "API key saved. Next: `frlink claude on`",
      );
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("cancelling the prompt saves nothing and says so inside the frame", async () => {
    passwordMock.mockResolvedValue(Symbol("cancel"));
    isCancelMock.mockReturnValue(true);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runLogin(promptCtx(WORK_HOME));

      expect(cancelMock).toHaveBeenCalledWith(
        "Cancelled — no API key was saved.",
      );
      expect(setSecret).not.toHaveBeenCalled();
      expect(verifyFriendliApiKeyMock).not.toHaveBeenCalled();
      expect(outroMock).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("`login --api-key` stays a single parseable line, with no frame", async () => {
    verifyFriendliApiKeyMock.mockResolvedValue({ ok: true });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runLogin(ctx(WORK_HOME, "friendli-flag-key-1234"));

      expect(introMock).not.toHaveBeenCalled();
      expect(passwordMock).not.toHaveBeenCalled();
      expect(outroMock).not.toHaveBeenCalled();
      expect(log.mock.calls).toEqual([["frlink: API key saved."]]);
    } finally {
      log.mockRestore();
    }
  });

  it("logout clears the key ref but preserves harness state", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await writeGlobalConfig(WORK_HOME, {
        apiKey: "{keychain:friendli-api-key}",
        harnesses: { hermes: { enabled: true } },
      });

      await runLogout(ctx(WORK_HOME, "friendli-flag-key-1234"));

      expect(deleteSecret).toHaveBeenCalledWith(WORK_HOME);
      // apiKey emptied, harnesses preserved — logout owns only the key.
      expect(
        JSON.parse(await readFile(globalConfigPath(WORK_HOME), "utf8")),
      ).toEqual({ apiKey: "", harnesses: { hermes: { enabled: true } } });
    } finally {
      log.mockRestore();
    }
  });
});
