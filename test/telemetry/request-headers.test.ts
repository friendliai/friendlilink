import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildFrlinkTelemetryHeaders,
  mergeFrlinkTelemetryHeaderLines,
  mergeFrlinkTelemetryHeaders,
  stripFrlinkTelemetryHeaderLines,
  stripFrlinkTelemetryHeaders,
} from "../../src/telemetry/request-headers.js";

const packageVersion = (
  JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as {
    version: string;
  }
).version;

describe("FriendliLink request telemetry", () => {
  it("builds exactly the two managed headers with a normalized version", () => {
    const headers = buildFrlinkTelemetryHeaders("claude", {
      frlinkVersion: "v0.8.0-beta.1+build.host-derived",
    });

    expect(headers).toEqual({
      "X-Title": "Claude Code",
      "HTTP-Referer": "frlink/v0.8.0",
    });
    expect(Object.keys(headers)).toEqual(["X-Title", "HTTP-Referer"]);
  });

  it.each([
    ["claude", "Claude Code"],
    ["codex", "Codex"],
    ["dsh", "DeepSeek Harness"],
    ["hermes", "Hermes Agent"],
    ["opencode", "OpenCode"],
    ["pi", "Pi"],
  ] as const)("maps %s to canonical title %s", (harnessId, title) => {
    expect(
      buildFrlinkTelemetryHeaders(harnessId, {
        frlinkVersion: "1.2.3",
      }),
    ).toEqual({
      "X-Title": title,
      "HTTP-Referer": "frlink/v1.2.3",
    });
  });

  it("uses the local package version when no version is supplied", () => {
    expect(buildFrlinkTelemetryHeaders("codex")).toEqual({
      "X-Title": "Codex",
      "HTTP-Referer": `frlink/v${packageVersion}`,
    });
  });

  it("bounds unusable version data to unknown", () => {
    expect(
      buildFrlinkTelemetryHeaders("codex", {
        frlinkVersion: "host-derived-value",
      }),
    ).toEqual({
      "X-Title": "Codex",
      "HTTP-Referer": "frlink/unknown",
    });
  });

  it("rejects an unknown harness id", () => {
    expect(() =>
      buildFrlinkTelemetryHeaders("cursor", {
        frlinkVersion: "1.2.3",
      }),
    ).toThrow("No request attribution title configured for harness: cursor");
  });

  it("replaces whatever referer value was there, whatever it says", () => {
    // Strip and merge key off the header NAME, never its value, so any stale
    // `HTTP-Referer` is overwritten by the next `on` and removed by `off`.
    const existing = {
      "HTTP-Referer": "some-older-tool/v0.1.0",
      "X-Title": "Claude Code",
      "X-User-Header": "mine",
    };
    expect(stripFrlinkTelemetryHeaders(existing)).toEqual({
      "X-User-Header": "mine",
    });
    expect(
      mergeFrlinkTelemetryHeaders(
        existing,
        buildFrlinkTelemetryHeaders("claude", { frlinkVersion: "1.2.3" }),
      ),
    ).toEqual({
      "X-User-Header": "mine",
      "X-Title": "Claude Code",
      "HTTP-Referer": "frlink/v1.2.3",
    });
  });

  it("strips only managed object header names case-insensitively", () => {
    expect(
      stripFrlinkTelemetryHeaders({
        "X-User-Trace": "keep",
        "User-Agent": "opencode/1.2.3 ai-sdk/5",
        "x-title": "old",
        "HTTP-REFERER": "https://example.com/old",
        "X-FireRouter-Harness": "legacy-but-unmanaged",
        "Fireworks-Use-Case": "legacy-but-unmanaged",
      }),
    ).toEqual({
      "X-User-Trace": "keep",
      "User-Agent": "opencode/1.2.3 ai-sdk/5",
      "X-FireRouter-Harness": "legacy-but-unmanaged",
      "Fireworks-Use-Case": "legacy-but-unmanaged",
    });
  });

  it("merges telemetry object headers while preserving unrelated values", () => {
    const merged = mergeFrlinkTelemetryHeaders(
      {
        "X-User-Trace": "keep",
        "User-Agent": "opencode/1.2.3 ai-sdk/5",
        "x-title": "old",
        "HTTP-REFERER": "https://example.com/old",
        "X-FireRouter-Harness": "legacy-but-unmanaged",
      },
      {
        "X-Title": "OpenCode",
        "HTTP-Referer": "frlink/v0.8.0",
      },
    );

    expect(merged).toEqual({
      "X-User-Trace": "keep",
      "User-Agent": "opencode/1.2.3 ai-sdk/5",
      "X-FireRouter-Harness": "legacy-but-unmanaged",
      "X-Title": "OpenCode",
      "HTTP-Referer": "frlink/v0.8.0",
    });
  });

  it("strips only managed newline header names case-insensitively", () => {
    const lines = [
      "X-User-Trace: keep",
      "User-Agent: claude-cli/2.1.19",
      "x-title: old",
      "HTTP-REFERER: https://example.com/old",
      "X-FireRouter-Harness: legacy-but-unmanaged",
      "Fireworks-Use-Case: legacy-but-unmanaged",
    ].join("\n");

    expect(stripFrlinkTelemetryHeaderLines(lines)).toBe(
      [
        "X-User-Trace: keep",
        "User-Agent: claude-cli/2.1.19",
        "X-FireRouter-Harness: legacy-but-unmanaged",
        "Fireworks-Use-Case: legacy-but-unmanaged",
      ].join("\n"),
    );
  });

  it("merges telemetry header lines while preserving unrelated lines", () => {
    const current = [
      "X-User-Trace: keep",
      "User-Agent: claude-cli/2.1.19",
      "x-title: old",
      "HTTP-REFERER: https://example.com/old",
      "X-FireRouter-Harness: legacy-but-unmanaged",
    ].join("\n");

    expect(
      mergeFrlinkTelemetryHeaderLines(current, {
        "X-Title": "Claude Code",
        "HTTP-Referer": "frlink/v0.8.0",
      }),
    ).toBe(
      [
        "X-Title: Claude Code",
        "HTTP-Referer: frlink/v0.8.0",
        "X-User-Trace: keep",
        "User-Agent: claude-cli/2.1.19",
        "X-FireRouter-Harness: legacy-but-unmanaged",
      ].join("\n"),
    );
  });
});
