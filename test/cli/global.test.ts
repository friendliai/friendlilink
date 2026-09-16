import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessContext } from "../../src/harness/types.js";

// runGlobalStatus calls resolveApiKey directly: mock it so the test never
// reads the developer's real FRIENDLI_API_KEY / OS keychain.
const resolveApiKeyMock = vi.fn();
vi.mock("../../src/keys/api-key.js", () => ({
  resolveApiKey: (...args: unknown[]) => resolveApiKeyMock(...args),
}));

// Registry fully faked: adapters record calls without touching disk.
const providerStatusMock = vi.fn();
const fakeAdapters = [
  { id: "aaa", label: "AAA", providerStatus: providerStatusMock },
  { id: "bbb", label: "BBB", providerStatus: providerStatusMock },
];
vi.mock("../../src/harness/registry.js", () => ({
  listHarnesses: () => fakeAdapters,
}));

const { createBaseContext } = await import("../../src/harness/types.js");
const { formatModelTable, runGlobalStatus } =
  await import("../../src/cli/commands/global.js");

function ctx(overrides: Partial<HarnessContext> = {}): HarnessContext {
  return { ...createBaseContext(), onboardingMode: "skip", ...overrides };
}

const out: string[] = [];

describe("top-level status command", () => {
  beforeEach(() => {
    out.length = 0;
    resolveApiKeyMock
      .mockReset()
      .mockResolvedValue({ key: "", source: "none" });
    providerStatusMock.mockReset().mockResolvedValue("default");
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      out.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints the API-key line and one row per harness", async () => {
    await runGlobalStatus(ctx());
    expect(out).toContain("FriendliAI API key: not saved");
    expect(out).toContain("  aaa (AAA): not routed");
    expect(out).toContain("  bbb (BBB): not routed");
  });

  it("--json prints the machine-readable shape", async () => {
    resolveApiKeyMock.mockResolvedValue({ key: "key", source: "env" });
    providerStatusMock.mockResolvedValue("friendli");
    await runGlobalStatus(ctx({ json: true }));
    const jsonLine = out.find((line) => line.startsWith("{"));
    expect(jsonLine).toBeDefined();
    expect(JSON.parse(jsonLine!)).toMatchObject({
      apiKeyConfigured: true,
      harnesses: [
        { id: "aaa", label: "AAA", status: "friendli" },
        { id: "bbb", label: "BBB", status: "friendli" },
      ],
    });
  });
});

describe("model list table", () => {
  /** Synthetic, not a snapshot of Friendli's catalog: this formats whatever
   * `/v1/models` returns, so real ids and real prices would only go stale in
   * the repo. The shapes are what matters — a long id, a short one, each of
   * the three prices present and absent. */
  const models = [
    {
      id: "vendor-with-a-long-name/model-one",
      label: "vendor-with-a-long-name/model-one",
      pricing: { input: 1.26, output: 3.96, cacheRead: 0.234 },
    },
    // Friendli reports no cache-read price for some models.
    {
      id: "vendor/model-two",
      label: "vendor/model-two",
      pricing: { input: 0.14, output: 0.4 },
    },
    // ...and no pricing block at all for others.
    { id: "v/m", label: "v/m" },
  ];

  it("prints a header and exactly one row per model", () => {
    const lines = formatModelTable(models);
    expect(lines).toHaveLength(models.length + 1);
    expect(lines[0]).toContain("MODEL ID");
    expect(lines[0]).toContain("CACHE READ");
    expect(lines[0]).toContain("USD per 1M tokens");
  });

  it("prints each id once — no repeated label column", () => {
    const row = formatModelTable(models)[1]!;
    expect(row.match(/vendor-with-a-long-name\/model-one/g)).toHaveLength(1);
  });

  it("shows the three prices, keeping a third digit only when it carries information", () => {
    const [, full, noCacheRead, noPricing] = formatModelTable(models);
    expect(full!.split(/\s+/)).toEqual([
      "vendor-with-a-long-name/model-one",
      "1.26",
      "3.96",
      "0.234",
    ]);
    expect(noCacheRead!.split(/\s+/)).toEqual([
      "vendor/model-two",
      "0.14",
      "0.40",
      "-",
    ]);
    expect(noPricing!.split(/\s+/)).toEqual(["v/m", "-", "-", "-"]);
  });

  it("never rounds a real price down to zero", () => {
    const [, tiny, zero] = formatModelTable([
      {
        id: "v/tiny",
        label: "v/tiny",
        pricing: { input: 0.0001, output: 0.000015 },
      },
      { id: "v/zero", label: "v/zero", pricing: { input: 0, output: 0 } },
    ]);
    expect(tiny!.split(/\s+/)).toEqual(["v/tiny", "0.0001", "0.000015", "-"]);
    // A genuine zero still reads as zero.
    expect(zero!.split(/\s+/)).toEqual(["v/zero", "0.00", "0.00", "-"]);
  });

  it("pads into columns rather than tab-separating, so ids of different lengths line up", () => {
    const lines = formatModelTable(models);
    expect(lines.join("\n")).not.toContain("\t");
    // The id column is as wide as the longest id, on every line including the
    // header; the first price column then ends where INPUT ends.
    const idWidth = Math.max(
      "MODEL ID".length,
      ...models.map((model) => model.id.length),
    );
    const inputEnd = lines[0]!.indexOf("INPUT") + "INPUT".length;
    for (const line of lines) {
      expect(line.slice(idWidth, idWidth + 2)).toBe("  ");
      expect(line.slice(0, inputEnd).trimEnd()).toHaveLength(inputEnd);
    }
  });
});
