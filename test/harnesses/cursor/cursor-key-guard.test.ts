import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Sandbox } from "../../helpers.js";

// The guard writes a recovered key through persistApiKey, which reaches the
// real OS keychain. Mock it: a test must never touch the developer's own key.
const persistApiKeyMock = vi.fn(async () => {});
vi.mock("../../../src/keys/api-key.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/keys/api-key.js")>();
  return {
    ...actual,
    persistApiKey: (...a: unknown[]) => persistApiKeyMock(...(a as [])),
  };
});

const passwordMock = vi.fn();
const isCancelMock = vi.fn(() => false);
vi.mock("@clack/prompts", () => ({
  password: (...a: unknown[]) => passwordMock(...a),
  isCancel: (...a: unknown[]) => isCancelMock(...(a as [])),
  cancel: vi.fn(),
  log: { warn: vi.fn() },
}));

process.env.FRLINK_SECRET_PLAINTEXT = "1";

const { ensureItemTable, readItemTableValue } =
  await import("../../../src/system/sqlite.js");
const { APPLICATION_USER_KEY } =
  await import("../../../src/harnesses/cursor/core.js");
const { cursorAdapter } =
  await import("../../../src/harnesses/cursor/index.js");
const { createBaseContext } = await import("../../../src/harness/types.js");
const { createSandboxHome } = await import("../../helpers.js");

const GOOD = "flp_a_key_friendli_accepts";
const BAD = "flp_a_key_friendli_rejects";
const CATALOG = { data: [{ id: "zai-org/GLM-5.1", name: "GLM 5.1" }] };

/**
 * Friendli's own shapes, measured against the live gateway:
 *   GET  /v1/models            200 for everyone, credential or not
 *   POST /v1/chat/completions  401 for a bad key, 422 for a good one with
 *                              an empty `messages` array (auth runs first)
 */
function gateway(accepts: string[]) {
  return vi.fn(
    async (
      input: string | URL,
      init?: { headers?: Record<string, string> },
    ) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify(CATALOG), { status: 200 });
      }
      const key = (init?.headers?.Authorization ?? "").replace(
        /^Bearer\s+/,
        "",
      );
      return accepts.includes(key)
        ? new Response(JSON.stringify({ detail: "bad body" }), { status: 422 })
        : new Response(JSON.stringify({ detail: "Unauthorized." }), {
            status: 401,
          });
    },
  );
}

describe("cursor on — API key guard", () => {
  let sandbox: Sandbox;
  let dbPath: string;
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    sandbox = await createSandboxHome();
    dbPath = path.join(sandbox.home, "state.vscdb");
    await mkdir(path.dirname(dbPath), { recursive: true });
    await ensureItemTable(dbPath);
    passwordMock.mockReset();
    isCancelMock.mockReset().mockImplementation(() => false);
    persistApiKeyMock.mockReset();
  });
  afterEach(async () => {
    globalThis.fetch = realFetch;
    await sandbox.cleanup();
  });

  function ctx(extra: Record<string, unknown> = {}) {
    return {
      ...createBaseContext(),
      home: sandbox.home,
      settingsPath: dbPath,
      dataDir: path.join(sandbox.home, "data"),
      apiKey: BAD,
      apiKeyFromFlag: true,
      apiKeyPreverified: true,
      onboardingMode: "skip" as const,
      // These exercise the key guard, not the running-IDE guard. Without
      // this the suite passes or fails depending on whether the developer
      // happens to have Cursor open.
      force: true,
      ...extra,
    };
  }

  it("writes nothing when Friendli rejects the key and there is no one to ask", async () => {
    globalThis.fetch = gateway([GOOD]) as unknown as typeof fetch;
    await expect(cursorAdapter.on(ctx())).rejects.toThrow(
      /rejected this API key/,
    );
    // The guard runs before the write: the row must not exist at all.
    expect(await readItemTableValue(dbPath, APPLICATION_USER_KEY)).toBe("");
    expect(passwordMock).not.toHaveBeenCalled();
  });

  it("asks for a new key, saves it, and routes Cursor with that one", async () => {
    globalThis.fetch = gateway([GOOD]) as unknown as typeof fetch;
    passwordMock.mockResolvedValueOnce(GOOD);

    await cursorAdapter.on(ctx({ onboardingMode: "prompt" }));

    expect(passwordMock).toHaveBeenCalledTimes(1);
    expect(persistApiKeyMock).toHaveBeenCalledWith(sandbox.home, GOOD);
    const blob = JSON.parse(
      await readItemTableValue(dbPath, APPLICATION_USER_KEY),
    );
    expect(blob.useOpenAIKey).toBe(true);
    expect(await readItemTableValue(dbPath, "cursorAuth/openAIKey")).toBe(GOOD);
  });

  it("keeps asking while the key is wrong, and leaves Cursor alone if cancelled", async () => {
    globalThis.fetch = gateway([GOOD]) as unknown as typeof fetch;
    passwordMock
      .mockResolvedValueOnce("still-wrong")
      .mockResolvedValueOnce("cancelled");
    isCancelMock.mockImplementation((v: unknown) => v === "cancelled");

    const outcome = await cursorAdapter.on(ctx({ onboardingMode: "prompt" }));

    expect(outcome).toEqual({ cancelled: true });
    expect(passwordMock).toHaveBeenCalledTimes(2);
    expect(persistApiKeyMock).not.toHaveBeenCalled();
    expect(await readItemTableValue(dbPath, APPLICATION_USER_KEY)).toBe("");
  });

  it("does not bank a --api-key key that Friendli then rejects", async () => {
    // The preamble's own check probes the unauthenticated /models endpoint,
    // so without deferral it would save a revoked key before we ask Friendli.
    globalThis.fetch = gateway([GOOD]) as unknown as typeof fetch;
    await expect(
      cursorAdapter.on(ctx({ apiKeyPreverified: false })),
    ).rejects.toThrow(/rejected this API key/);
    expect(persistApiKeyMock).not.toHaveBeenCalled();
  });

  it("saves a --api-key key once Friendli has accepted it", async () => {
    globalThis.fetch = gateway([GOOD]) as unknown as typeof fetch;
    await cursorAdapter.on(ctx({ apiKey: GOOD, apiKeyPreverified: false }));
    expect(persistApiKeyMock).toHaveBeenCalledWith(sandbox.home, GOOD);
  });

  it("does not block on an unreachable gateway — only an explicit 401 counts", async () => {
    globalThis.fetch = vi.fn(async (input: string | URL) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify(CATALOG), { status: 200 });
      }
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;

    await cursorAdapter.on(ctx());

    expect(passwordMock).not.toHaveBeenCalled();
    const blob = JSON.parse(
      await readItemTableValue(dbPath, APPLICATION_USER_KEY),
    );
    expect(blob.useOpenAIKey).toBe(true);
  });
});
