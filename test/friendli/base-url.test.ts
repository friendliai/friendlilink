import { describe, expect, it } from "vitest";
import {
  FRIENDLI_BASE_URL,
  friendliApiBaseUrl,
  friendliApiUrl,
  normalizeFriendliBaseUrl,
} from "../../src/friendli/base-url.js";

describe("Friendli base URLs", () => {
  it("uses an unversioned product root as the shared base", () => {
    expect(FRIENDLI_BASE_URL).toBe("https://api.friendli.ai/serverless");
    expect(friendliApiBaseUrl()).toBe("https://api.friendli.ai/serverless/v1");
  });

  it("builds versioned REST endpoints from resource paths", () => {
    expect(friendliApiUrl("models")).toBe(
      "https://api.friendli.ai/serverless/v1/models",
    );
    expect(friendliApiUrl("/messages")).toBe(
      "https://api.friendli.ai/serverless/v1/messages",
    );
  });

  it("accepts legacy versioned overrides without duplicating v1", () => {
    const legacy = "https://staging.example.invalid/serverless/v1/";
    expect(normalizeFriendliBaseUrl(legacy)).toBe(
      "https://staging.example.invalid/serverless",
    );
    expect(friendliApiUrl("models", legacy)).toBe(
      "https://staging.example.invalid/serverless/v1/models",
    );
  });
});
