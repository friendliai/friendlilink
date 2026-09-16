import { describe, expect, it } from "vitest";
import { parseCli } from "../../src/cli/parse-args.js";
import { listHarnesses, resolveHarnessId } from "../../src/harness/registry.js";

describe("harness name aliases", () => {
  it("resolves every canonical id to itself", () => {
    for (const harness of listHarnesses()) {
      expect(resolveHarnessId(harness.id)).toBe(harness.id);
    }
  });

  it.each([
    ["claude-code", "claude"],
    ["codex-cli", "codex"],
    ["chatgpt", "codex"],
    ["hermes-agent", "hermes"],
    ["deepseek-harness", "dsh"],
  ])("resolves %s to %s", (alias, canonical) => {
    expect(resolveHarnessId(alias)).toBe(canonical);
  });

  it("does not resolve an unknown name", () => {
    expect(resolveHarnessId("cluade")).toBeUndefined();
  });

  it("does not resolve inherited object properties", () => {
    // A plain-object alias table answers these with an inherited function,
    // which sails past the `--exclude` typo guard and excludes nothing.
    for (const name of [
      "constructor",
      "toString",
      "hasOwnProperty",
      "__proto__",
    ]) {
      expect(resolveHarnessId(name)).toBeUndefined();
    }
  });

  it("keeps aliases out of the registry itself, so `check`/`all` list each agent once", () => {
    const ids = listHarnesses().map((harness) => harness.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      "claude",
      "codex",
      "cursor",
      "dsh",
      "hermes",
      "opencode",
      "pi",
    ]);
  });

  it("routes an aliased command to the canonical harness", () => {
    expect(parseCli(["claude-code", "status"])).toMatchObject({
      kind: "harness",
      route: { harnessId: "claude", verb: "status" },
    });
    expect(parseCli(["chatgpt", "off"])).toMatchObject({
      kind: "harness",
      route: { harnessId: "codex", verb: "off" },
    });
  });

  it("accepts claude-only flags under the claude alias", () => {
    expect(
      parseCli(["claude-code", "on", "--opus", "vendor/model-one"]),
    ).toMatchObject({ kind: "harness", ctx: { opus: "vendor/model-one" } });
    // ...and still rejects them elsewhere, by canonical name.
    expect(parseCli(["chatgpt", "on", "--opus", "x"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("not a `codex` one"),
    });
  });

  it("reports the canonical id in a bad-verb usage error", () => {
    expect(parseCli(["deepseek-harness", "nope"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("frlink dsh <on|off|status>"),
    });
  });
});
