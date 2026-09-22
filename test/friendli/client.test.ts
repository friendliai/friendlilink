import { afterEach, describe, expect, it, vi } from "vitest";

// verifyFriendliApiKey uses an authenticated chat probe.
// 401 and 403 reject. 422 accepts. Other responses fail verification.
const fetchMock = vi.fn();

vi.stubGlobal("fetch", (...args: unknown[]) => fetchMock(...args));

const { verifyFriendliApiKey } = await import("../../src/friendli/client.js");

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

  it("rejects when the credential probe cannot reach Friendli", async () => {
    routeResponses({ models: 200, chat: new Error("network down") });

    await expect(
      verifyFriendliApiKey("real-key-123456"),
    ).resolves.toMatchObject({
      ok: false,
      message: "Could not verify the FriendliAI API key.",
    });
  });

  it("rejects when Friendli returns an unexpected status", async () => {
    routeResponses({ models: 200, chat: 503, modelId: "zai-org/GLM-5.3" });

    await expect(
      verifyFriendliApiKey("real-key-123456"),
    ).resolves.toMatchObject({
      ok: false,
      message: "Could not verify the FriendliAI API key.",
    });
  });
});
