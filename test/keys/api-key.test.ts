import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSecretMock = vi.fn();

// The OS keychain store is machine-global — mock it so these tests never
// read the developer's real stored key (same rationale as key-preamble.test).
vi.mock("../../src/keys/secret-store.js", () => ({
  getSecret: (...args: unknown[]) => getSecretMock(...args),
  setSecret: vi.fn(),
  deleteSecret: vi.fn(),
}));

const { FRIENDLI_API_KEY_ENV, FRIENDLI_API_KEY_ENV_ALIASES, resolveApiKey } =
  await import("../../src/keys/api-key.js");

const ALL_ENV_NAMES = [FRIENDLI_API_KEY_ENV, ...FRIENDLI_API_KEY_ENV_ALIASES];

describe("resolveApiKey env fallbacks", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    getSecretMock.mockReset().mockResolvedValue(null);
    for (const name of ALL_ENV_NAMES) {
      vi.stubEnv(name, "");
    }
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    errorSpy.mockRestore();
  });

  it("prefers the canonical FRIENDLIAI_API_KEY over every alias", async () => {
    vi.stubEnv(FRIENDLI_API_KEY_ENV, "canonical-key");
    vi.stubEnv("FRIENDLI_API_KEY", "old-name-key");
    vi.stubEnv("FRIENDLI_TOKEN", "sdk-name-key");

    const resolved = await resolveApiKey({ home: "/tmp/nope" });

    expect(resolved).toEqual({ key: "canonical-key", source: "env" });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("falls back to FRIENDLI_API_KEY before FRIENDLI_TOKEN", async () => {
    vi.stubEnv("FRIENDLI_API_KEY", "old-name-key");
    vi.stubEnv("FRIENDLI_TOKEN", "sdk-name-key");

    const resolved = await resolveApiKey({ home: "/tmp/nope" });

    expect(resolved).toEqual({ key: "old-name-key", source: "env" });
  });

  it("falls back to FRIENDLI_TOKEN when it is the only name set", async () => {
    vi.stubEnv("FRIENDLI_TOKEN", "sdk-name-key");

    const resolved = await resolveApiKey({ home: "/tmp/nope" });

    expect(resolved).toEqual({ key: "sdk-name-key", source: "env" });
  });

  it("resolves an alias silently — an alias is a supported spelling", async () => {
    vi.stubEnv("FRIENDLI_API_KEY", "old-name-key");

    await resolveApiKey({ home: "/tmp/nope" });

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("keeps the --api-key flag above every env name", async () => {
    vi.stubEnv(FRIENDLI_API_KEY_ENV, "canonical-key");
    vi.stubEnv("FRIENDLI_TOKEN", "sdk-name-key");

    const resolved = await resolveApiKey({
      apiKeyFlag: "flag-key",
      home: "/tmp/nope",
    });

    expect(resolved).toEqual({ key: "flag-key", source: "flag" });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("ignores whitespace-only alias values and reaches the keychain", async () => {
    vi.stubEnv("FRIENDLI_API_KEY", "   ");
    vi.stubEnv("FRIENDLI_TOKEN", "\t");
    getSecretMock.mockResolvedValueOnce("stored-key");

    const resolved = await resolveApiKey({ home: "/tmp/nope" });

    expect(resolved).toEqual({ key: "stored-key", source: "keychain" });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("reports none when no flag, env name, or stored key exists", async () => {
    const resolved = await resolveApiKey({ home: "/tmp/nope" });

    expect(resolved).toEqual({ key: "", source: "none" });
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
