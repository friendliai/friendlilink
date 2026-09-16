import { beforeEach, describe, expect, it, vi } from "vitest";

const verifyFriendliApiKeyMock = vi.fn();
const resolveApiKeyMock = vi.fn();
const persistApiKeyMock = vi.fn();

// The OS keychain store is machine-global — persistApiKey overwrites the
// user's real stored key — so both store-touching functions are mocked and
// these tests never touch the real machine.
vi.mock("../../../src/friendli/client.js", () => ({
  verifyFriendliApiKey: (...args: unknown[]) =>
    verifyFriendliApiKeyMock(...args),
}));

vi.mock("../../../src/keys/api-key.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/keys/api-key.js")>();
  return {
    ...actual,
    resolveApiKey: (...args: unknown[]) => resolveApiKeyMock(...args),
    persistApiKey: (...args: unknown[]) => persistApiKeyMock(...args),
  };
});

const { createBaseContext } = await import("../../../src/harness/types.js");
const { resolveVerifiedKey } =
  await import("../../../src/harnesses/common/key-preamble.js");

function context(
  overrides: Partial<ReturnType<typeof createBaseContext>> = {},
) {
  return { ...createBaseContext(), ...overrides };
}

describe("common key preamble", () => {
  beforeEach(() => {
    verifyFriendliApiKeyMock.mockReset().mockResolvedValue({ ok: true });
    resolveApiKeyMock.mockReset();
    persistApiKeyMock.mockReset();
  });

  it("resolves the key from the --api-key flag, verifying it against Friendli first", async () => {
    resolveApiKeyMock.mockResolvedValueOnce({
      key: "flag-supplied-key",
      source: "flag",
    });

    const result = await resolveVerifiedKey(
      context({ apiKey: "flag-supplied-key", apiKeyFromFlag: true }),
      "https://example.invalid/serverless",
    );

    expect(result).toEqual({ key: "flag-supplied-key", source: "flag" });
    expect(verifyFriendliApiKeyMock).toHaveBeenCalledWith(
      "flag-supplied-key",
      "https://example.invalid/serverless",
    );
    expect(persistApiKeyMock).toHaveBeenCalledWith(
      context().home,
      "flag-supplied-key",
    );
  });

  it("rejects a flag key Friendli does not accept, without persisting it", async () => {
    resolveApiKeyMock.mockResolvedValueOnce({
      key: "flag-supplied-key",
      source: "flag",
    });
    verifyFriendliApiKeyMock.mockResolvedValueOnce({
      ok: false,
      message: "unauthorized: bad key",
    });

    await expect(
      resolveVerifiedKey(
        context({ apiKey: "flag-supplied-key", apiKeyFromFlag: true }),
        "https://example.invalid",
      ),
    ).rejects.toThrow(/unauthorized: bad key/);
    expect(persistApiKeyMock).not.toHaveBeenCalled();
  });

  it("resolves the key from the FRIENDLI_API_KEY env without re-verification", async () => {
    resolveApiKeyMock.mockResolvedValueOnce({
      key: "env-supplied-key",
      source: "env",
    });

    const result = await resolveVerifiedKey(
      context(),
      "https://example.invalid",
    );

    expect(result).toEqual({ key: "env-supplied-key", source: "env" });
    expect(verifyFriendliApiKeyMock).not.toHaveBeenCalled();
    expect(persistApiKeyMock).not.toHaveBeenCalled();
  });

  it("skips verify+persist for a flag key already preverified by `all on`", async () => {
    resolveApiKeyMock.mockResolvedValueOnce({
      key: "flag-supplied-key",
      source: "flag",
    });

    const result = await resolveVerifiedKey(
      context({
        apiKey: "flag-...key",
        apiKeyFromFlag: true,
        apiKeyPreverified: true,
      }),
      "https://example.invalid",
    );

    expect(result).toEqual({ key: "flag-supplied-key", source: "flag" });
    expect(verifyFriendliApiKeyMock).not.toHaveBeenCalled();
    expect(persistApiKeyMock).not.toHaveBeenCalled();
  });

  it("throws the login hint when no key can be resolved", async () => {
    resolveApiKeyMock.mockResolvedValueOnce({ key: "", source: "none" });

    await expect(
      resolveVerifiedKey(context(), "https://example.invalid"),
    ).rejects.toThrow(/No FriendliAI API key found/);
  });

  it("rejects implausibly short keys before any verification", async () => {
    resolveApiKeyMock.mockResolvedValueOnce({ key: "short", source: "flag" });

    await expect(
      resolveVerifiedKey(
        context({ apiKey: "short", apiKeyFromFlag: true }),
        "https://example.invalid",
      ),
    ).rejects.toThrow(/doesn't look like a FriendliAI API key/);
    expect(verifyFriendliApiKeyMock).not.toHaveBeenCalled();
    expect(persistApiKeyMock).not.toHaveBeenCalled();
  });
});
