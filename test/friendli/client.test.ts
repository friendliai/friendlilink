import { afterEach, describe, expect, it, vi } from "vitest";

// verifyFriendliApiKey uses an authenticated chat probe.
// 401 and 403 reject. 422 accepts. Other responses fail verification.
const fetchMock = vi.fn();

vi.stubGlobal("fetch", (...args: unknown[]) => fetchMock(...args));

const { verifyFriendliApiKey, PROBE_FALLBACK_MODEL } =
  await import("../../src/friendli/client.js");

/** The model the credential probe sent. */
function probedModel(): string | undefined {
  const chatCall = fetchMock.mock.calls.find(([url]) =>
    String(url).endsWith("/chat/completions"),
  );
  return chatCall ? JSON.parse(chatCall[1].body).model : undefined;
}

/** How many times the catalog was requested. */
function catalogCalls(): number {
  return fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/models"))
    .length;
}

function response(status: number, payload?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

/** Route by URL: the public catalog probe then the credential probe. */
function routeResponses(options: {
  models: number | Error;
  chat: number | Error;
  modelId?: string;
}) {
  fetchMock.mockImplementation((_url: string | URL) => {
    const url = String(_url);
    if (url.endsWith("/models")) {
      return options.models instanceof Error
        ? Promise.reject(options.models)
        : Promise.resolve(
            response(options.models, {
              data: options.modelId ? [{ id: options.modelId }] : [],
            }),
          );
    }
    return options.chat instanceof Error
      ? Promise.reject(options.chat)
      : Promise.resolve(response(options.chat));
  });
}

describe("verifyFriendliApiKey", () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  it("rejects a key Friendli answers 401 to", async () => {
    routeResponses({ models: 200, chat: 401, modelId: "zai-org/GLM-5.3" });

    const result = await verifyFriendliApiKey("bogus-key-12345");

    expect(result).toEqual({
      ok: false,
      message: "FriendliAI rejected the API key.",
    });
    const chatCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/chat/completions"),
    );
    expect(chatCall?.[1]).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Bearer bogus-key-12345",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "zai-org/GLM-5.3",
        messages: [],
      }),
    });
  });

  it("rejects a key Friendli answers 403 to", async () => {
    routeResponses({ models: 200, chat: 403 });

    await expect(
      verifyFriendliApiKey("bogus-key-12345"),
    ).resolves.toMatchObject({ ok: false });
  });

  it("accepts a key that clears auth (422 on the empty-messages body)", async () => {
    routeResponses({ models: 200, chat: 422, modelId: "zai-org/GLM-5.3" });

    await expect(verifyFriendliApiKey("real-key-123456")).resolves.toEqual({
      ok: true,
    });
  });

  it("still rejects on 401 when the catalog probe fails", async () => {
    routeResponses({ models: 500, chat: 401 });

    await expect(
      verifyFriendliApiKey("bogus-key-12345"),
    ).resolves.toMatchObject({ ok: false });
  });

  it("retries a failed catalog once and probes with its live model", async () => {
    let catalogAttempts = 0;
    fetchMock.mockImplementation((url: string | URL) => {
      if (String(url).endsWith("/models")) {
        catalogAttempts++;
        return Promise.resolve(
          catalogAttempts === 1
            ? response(503)
            : response(200, { data: [{ id: "test/live-model" }] }),
        );
      }
      return Promise.resolve(response(422));
    });

    await expect(verifyFriendliApiKey("real-key-123456")).resolves.toEqual({
      ok: true,
    });
    expect(catalogCalls()).toBe(2);
    expect(probedModel()).toBe("test/live-model");
  });

  it("probes with the fallback model when the catalog stays unavailable", async () => {
    routeResponses({ models: 500, chat: 422 });

    await expect(verifyFriendliApiKey("real-key-123456")).resolves.toEqual({
      ok: true,
    });
    expect(catalogCalls()).toBe(2);
    expect(probedModel()).toBe(PROBE_FALLBACK_MODEL);
  });

  it("bounds every catalog attempt with a timeout", async () => {
    routeResponses({ models: 500, chat: 422 });

    await verifyFriendliApiKey("real-key-123456");
    const catalogInits = fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith("/models"))
      .map(([, init]) => init);
    expect(catalogInits).toHaveLength(2);
    for (const init of catalogInits) {
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("does not verify a key when the endpoint answers 404", async () => {
    // A wrong base URL 404s for every key, so 404 must never prove a key.
    routeResponses({ models: 404, chat: 404 });

    await expect(
      verifyFriendliApiKey("bogus-key-12345"),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining("HTTP 404"),
    });
  });

  it("rejects when the credential probe cannot reach Friendli", async () => {
    routeResponses({ models: 200, chat: new Error("network down") });

    await expect(
      verifyFriendliApiKey("real-key-123456"),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining("network down"),
    });
  });

  it("rejects when Friendli returns an unexpected status", async () => {
    routeResponses({ models: 200, chat: 503, modelId: "zai-org/GLM-5.3" });

    await expect(
      verifyFriendliApiKey("real-key-123456"),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining("HTTP 503"),
    });
  });
});
