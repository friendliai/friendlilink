import { afterEach, describe, expect, it, vi } from "vitest";

// verifyFriendliApiKey now sends an authenticated chat/completions probe —
// GET /v1/models answers 200 to any Bearer, so it can no longer fake a
// verification. Mock global fetch so these tests pin the wire contract:
// 401 = rejected, 422 = auth cleared, anything else = inconclusive pass.
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

  it("rejects a key Friendli answers 401 to, naming the probe model", async () => {
    routeResponses({ models: 200, chat: 401, modelId: "zai-org/GLM-5.3" });

    const result = await verifyFriendliApiKey("bogus-key-12345");

    expect(result).toEqual({
      ok: false,
      message: "FriendliAI rejected this API key (unauthorized).",
    });
    // The credential probe carries the Bearer and the catalog's first model.
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

  it("accepts a key that clears auth (422 on the empty-messages body)", async () => {
    routeResponses({ models: 200, chat: 422, modelId: "zai-org/GLM-5.3" });

    await expect(verifyFriendliApiKey("real-key-123456")).resolves.toEqual({
      ok: true,
    });
  });

  it("still rejects on 401 when the catalog probe fails — auth is read before the body", async () => {
    routeResponses({ models: 500, chat: 401 });

    await expect(
      verifyFriendliApiKey("bogus-key-12345"),
    ).resolves.toMatchObject({ ok: false });
  });

  it("passes a key it cannot disprove, with the uncertainty as a message", async () => {
    routeResponses({ models: 200, chat: new Error("network down") });

    await expect(
      verifyFriendliApiKey("real-key-123456"),
    ).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining("Could not reach"),
    });
  });

  it("passes with a warning when the gateway answers something unpredicted", async () => {
    routeResponses({ models: 200, chat: 503, modelId: "zai-org/GLM-5.3" });

    await expect(
      verifyFriendliApiKey("real-key-123456"),
    ).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining("HTTP 503"),
    });
  });
});
