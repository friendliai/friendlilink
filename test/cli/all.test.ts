import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessContext } from "../../src/harness/types.js";
import { buildFrlinkTelemetryHeaders } from "../../src/telemetry/request-headers.js";

// resolveVerifiedKey is the only Friendli-side call `all on` makes — stubbed
// so no test reaches the network or a keychain.
const resolveKeyMock = vi.fn();
vi.mock("../../src/harnesses/common/key-preamble.js", () => ({
  resolveVerifiedKey: (...args: unknown[]) => resolveKeyMock(...args),
}));

// pickMainModel decides the one shared model — stubbed to return a fixed pick.
const pickMock = vi.fn();
vi.mock("../../src/harnesses/common/model-pick.js", () => ({
  pickMainModel: (...args: unknown[]) => pickMock(...args),
}));

// Registry fully faked: adapters record calls without touching disk.
const onMock = vi.fn();
const offMock = vi.fn();
const providerStatusMock = vi.fn();
const isInstalledMock = vi.fn();
const fakeAdapters = [
  {
    id: "aaa",
    label: "AAA",
    on: onMock,
    off: offMock,
    providerStatus: providerStatusMock,
    isInstalled: isInstalledMock,
  },
  {
    id: "bbb",
    label: "BBB",
    on: onMock,
    off: offMock,
    providerStatus: providerStatusMock,
    isInstalled: isInstalledMock,
  },
  // No isInstalled probe — must always be attempted.
  {
    id: "ccc",
    label: "CCC",
    on: onMock,
    off: offMock,
    providerStatus: providerStatusMock,
  },
];
vi.mock("../../src/harness/registry.js", () => ({
  listHarnesses: () => fakeAdapters,
  resolveHarnessId: (name: string) => {
    const alias = name === "aaa-alias" ? "aaa" : name;
    return fakeAdapters.some((adapter) => adapter.id === alias)
      ? alias
      : undefined;
  },
}));

const { createBaseContext } = await import("../../src/harness/types.js");
const { parseCli } = await import("../../src/cli/parse-args.js");
const { runAllCommand, runCheckCommand, summarizeInstallResult } =
  await import("../../src/cli/commands/all.js");

function ctx(overrides: Partial<HarnessContext> = {}): HarnessContext {
  return { ...createBaseContext(), onboardingMode: "skip", ...overrides };
}

const out: string[] = [];
const err: string[] = [];
/** summarize prints multiple lines via one console.log("\n"-joined), so
 * assertions join the captured lines the way a terminal would show them. */
const stdout = () => out.join("\n");

describe("all command", () => {
  beforeEach(() => {
    out.length = 0;
    err.length = 0;
    process.exitCode = 0;
    onMock.mockReset().mockResolvedValue(undefined);
    offMock.mockReset().mockResolvedValue(undefined);
    providerStatusMock.mockReset().mockResolvedValue("default");
    isInstalledMock.mockReset().mockResolvedValue(true);
    resolveKeyMock.mockReset().mockResolvedValue({ key: "key", source: "env" });
    pickMock
      .mockReset()
      .mockResolvedValue({ model: "zai-org/GLM-5.2", cancelled: false });
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      out.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      err.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  it("parses `all <verb>` with flags and rejects unknown verbs", () => {
    const parsed = parseCli(["all", "on", "--model", "zai-org/GLM-5.3"]);
    expect(parsed).toMatchObject({ kind: "all", verb: "on" });
    expect((parsed as { ctx: HarnessContext }).ctx.main).toBe(
      "zai-org/GLM-5.3",
    );

    expect(parseCli(["all", "sync"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("frlink all"),
    });
    expect(parseCli(["all"])).toMatchObject({ kind: "error" });
  });

  it("`all on` partitions first: reports not-installed without touching keys or models", async () => {
    // Give every adapter a probe (even the normally probe-less ccc) so
    // installed can be truly empty — that's the scenario this gate covers.
    const ccc = fakeAdapters[2] as { isInstalled?: unknown };
    ccc.isInstalled = async () => false;
    isInstalledMock.mockResolvedValue(false);
    try {
      await runAllCommand("on", ctx());
      expect(resolveKeyMock).not.toHaveBeenCalled();
      expect(pickMock).not.toHaveBeenCalled();
      expect(onMock).not.toHaveBeenCalled();
      expect(stdout()).toContain(
        "frlink: AAA, BBB, CCC are not installed — skipped.",
      );
    } finally {
      delete ccc.isInstalled;
    }
  });

  it("a probe that throws is reported and attempted, not silently skipped", async () => {
    isInstalledMock.mockRejectedValueOnce(
      new Error("EACCES: permission denied"),
    );
    await runAllCommand("on", ctx());
    // aaa's probe failed -> attempted anyway; bbb's probe wasn't reached by
    // the mock's once-rejection but resolves true; ccc has no probe.
    expect(onMock).toHaveBeenCalledTimes(3);
    expect(err).toContain(
      "frlink: aaa install check failed (EACCES: permission denied) — attempting it anyway",
    );
    expect(stdout()).toContain("frlink: Enabled FriendliAI on AAA, BBB, CCC.");
  });

  it("`all on` runs every installed adapter with the same picked model", async () => {
    await runAllCommand("on", ctx());
    expect(onMock).toHaveBeenCalledTimes(3);
    for (const call of onMock.mock.calls) {
      expect((call[0] as HarnessContext).main).toBe("zai-org/GLM-5.2");
    }
    expect(stdout()).toContain("frlink: Enabled FriendliAI on AAA, BBB, CCC.");
    expect(err).toEqual([]);
    expect(process.exitCode).toBe(0);
  });

  it("`all on` bakes attribution headers only for telemetry-capable harnesses", async () => {
    // ccc stands in for a header-capable harness: a real id (so the title
    // lookup resolves) and telemetryHeaders on; aaa stays non-capable. `on` is
    // the shared spy, so calls land in registry order [aaa, bbb, ccc].
    const ccc = fakeAdapters[2] as { id: string; telemetryHeaders?: boolean };
    const savedId = ccc.id;
    ccc.id = "codex";
    ccc.telemetryHeaders = true;
    try {
      await runAllCommand("on", ctx());
      // The capable harness gets the two managed headers, generated per-id.
      expect(
        (onMock.mock.calls[2][0] as HarnessContext).telemetryHeaders,
      ).toEqual(buildFrlinkTelemetryHeaders("codex"));
      // A harness with no static header surface keeps the empty default.
      expect(
        (onMock.mock.calls[0][0] as HarnessContext).telemetryHeaders,
      ).toEqual({});
    } finally {
      ccc.id = savedId;
      delete ccc.telemetryHeaders;
    }
  });

  it("skips not-installed harnesses and says so; probe-less harnesses still run", async () => {
    isInstalledMock.mockResolvedValue(false);
    await runAllCommand("on", ctx());
    expect(onMock).toHaveBeenCalledTimes(1); // only ccc, the probe-less one
    expect(stdout()).toContain("frlink: Enabled FriendliAI on CCC.");
    expect(stdout()).toContain("frlink: AAA, BBB are not installed — skipped.");
    expect(process.exitCode).toBe(0);
  });

  it("uses singular verb when exactly one harness is skipped", async () => {
    isInstalledMock.mockImplementation(async () => true);
    // aaa + bbb installed, ccc probe-less... make exactly one probe return false:
    isInstalledMock.mockImplementationOnce(async () => false);
    // call order: aaa probe(false), bbb probe(true)
    await runAllCommand("on", ctx());
    expect(stdout()).toContain("frlink: AAA is not installed — skipped.");
    expect(stdout()).toContain("frlink: Enabled FriendliAI on BBB, CCC.");
  });

  it("a failing harness doesn't stop the run and exits non-zero", async () => {
    onMock
      .mockResolvedValueOnce(undefined) // aaa
      .mockRejectedValueOnce(new Error("config exploded")) // bbb
      .mockResolvedValueOnce(undefined); // ccc
    await runAllCommand("on", ctx());
    expect(onMock).toHaveBeenCalledTimes(3);
    expect(err).toContain("frlink: bbb failed: config exploded");
    // The enabled line lists only the harnesses that actually succeeded.
    expect(stdout()).toContain("frlink: Enabled FriendliAI on AAA, CCC.");
    expect(process.exitCode).toBe(1);
  });

  it("`all on` stops without writing when model selection is cancelled", async () => {
    pickMock.mockResolvedValue({ cancelled: true });
    await runAllCommand("on", ctx());
    expect(onMock).not.toHaveBeenCalled();
    expect(stdout()).toContain("frlink: Cancelled — nothing was written.");
    expect(process.exitCode).toBe(1);
  });

  it("`all off` runs off for installed harnesses and reports skipped ones", async () => {
    isInstalledMock.mockResolvedValue(false);
    await runAllCommand("off", ctx());
    expect(offMock).toHaveBeenCalledTimes(1); // probe-less ccc runs anyway
    expect(stdout()).toContain("frlink: AAA, BBB are not installed — skipped.");
    expect(process.exitCode).toBe(0);
  });

  it("`all installed` / `all status` alias the `check` inventory", () => {
    expect(parseCli(["all", "installed"])).toMatchObject({ kind: "check" });
    expect(parseCli(["all", "status"])).toMatchObject({
      kind: "global-status",
    });
    // ...and inherit check's refusal to filter a read-only inventory.
    expect(parseCli(["all", "status", "--exclude", "aaa"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("does not support --exclude"),
    });
  });

  it("rejects an `all` verb that is neither a write nor an inventory", () => {
    expect(parseCli(["all", "sideways"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("on|off|installed|status"),
    });
  });

  it("`check` parses and lists installed vs not-installed without touching keys or models", async () => {
    expect(parseCli(["check", "installed"])).toMatchObject({ kind: "check" });
    expect(parseCli(["check", "status"])).toMatchObject({
      kind: "global-status",
    });
    isInstalledMock.mockResolvedValue(false);
    await runCheckCommand(ctx());
    // ccc has no probe — always counts as installed.
    expect(resolveKeyMock).not.toHaveBeenCalled();
    expect(pickMock).not.toHaveBeenCalled();
    expect(stdout()).toContain("frlink: Installed: CCC.");
    expect(stdout()).toContain("frlink: Not installed: AAA, BBB.");
    expect(process.exitCode).toBe(0);
  });

  it("`check` reports when nothing is installed and still can't be confused with a probe error", async () => {
    const ccc = fakeAdapters[2] as { isInstalled?: unknown };
    ccc.isInstalled = async () => false;
    isInstalledMock.mockResolvedValue(false);
    try {
      await runCheckCommand(ctx());
      expect(stdout()).toContain(
        "frlink: No supported coding agents are installed.",
      );
      expect(stdout()).toContain("frlink: Not installed: AAA, BBB, CCC.");
    } finally {
      delete ccc.isInstalled;
    }
  });

  it("`all on` skips harnesses already routed through Friendli and reports them", async () => {
    providerStatusMock
      .mockImplementation(async () => "default")
      .mockImplementationOnce(async () => "friendli");
    await runAllCommand("on", ctx());
    expect(onMock).toHaveBeenCalledTimes(2); // bbb + ccc only — aaa skipped
    expect(stdout()).toContain(
      "frlink: AAA is already routed through FriendliAI — left untouched.",
    );
    expect(stdout()).toContain("frlink: Enabled FriendliAI on BBB, CCC.");
  });

  it("`all on` touches no key or model when every installed harness is already routed", async () => {
    providerStatusMock.mockResolvedValue("friendli");
    await runAllCommand("on", ctx());
    expect(resolveKeyMock).not.toHaveBeenCalled();
    expect(pickMock).not.toHaveBeenCalled();
    expect(onMock).not.toHaveBeenCalled();
    expect(stdout()).toContain(
      "frlink: AAA, BBB, CCC are already routed through FriendliAI — left untouched.",
    );
  });

  it("`--exclude` drops harnesses from `all off` entirely — neither run nor reported", async () => {
    const excluded = ctx({ exclude: "aaa,bbb" });
    await runAllCommand("off", excluded);
    expect(offMock).toHaveBeenCalledTimes(1); // only ccc
    expect(stdout()).toEqual(""); // excluded appear nowhere — not run, not reported
  });

  it("`--exclude` accepts a harness alias", async () => {
    await runAllCommand("off", ctx({ exclude: "aaa-alias" }));
    expect(offMock).toHaveBeenCalledTimes(2); // bbb and ccc; aaa excluded
    expect(stdout()).not.toContain("AAA");
  });

  it("`--exclude` with an unknown harness id is refused", async () => {
    await expect(
      runAllCommand("off", ctx({ exclude: "cluade" })),
    ).rejects.toThrow(/unknown agent id/i);
    expect(offMock).not.toHaveBeenCalled();
  });

  it("`check` does not accept --exclude (a filtered inventory would lie)", async () => {
    expect(parseCli(["check", "installed", "--exclude", "aaa"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("does not support --exclude"),
    });
  });

  it("summarize formats the requested feedback lines", () => {
    const [aaa, bbb, ccc] = fakeAdapters;
    expect(
      summarizeInstallResult({ enabled: [aaa, bbb], skipped: [ccc] }),
    ).toBe(
      "frlink: Enabled FriendliAI on AAA, BBB.\nfrlink: CCC is not installed — skipped.",
    );
    expect(summarizeInstallResult({ enabled: [], skipped: [ccc] })).toBe(
      "frlink: CCC is not installed — skipped.",
    );
    expect(summarizeInstallResult({ enabled: [aaa], skipped: [] })).toBe(
      "frlink: Enabled FriendliAI on AAA.",
    );
  });
});
