import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchCatalogMock = vi.fn();
const selectMock = vi.fn();
const isCancelMock = vi.fn(() => false);

vi.mock("../../../src/friendli/model-catalog.js", () => ({
  fetchFriendliModelCatalog: (...args: unknown[]) => fetchCatalogMock(...args),
}));

vi.mock("@clack/prompts", () => ({
  cancel: vi.fn(),
  select: (...args: unknown[]) => selectMock(...args),
  isCancel: (...args: unknown[]) => isCancelMock(...args),
  log: { warn: vi.fn() },
}));

const { createBaseContext } = await import("../../../src/harness/types.js");
const { DEFAULT_FRIENDLI_MODEL, pickMainModel } =
  await import("../../../src/harnesses/common/model-pick.js");

function context(
  overrides: Partial<ReturnType<typeof createBaseContext>> = {},
) {
  return { ...createBaseContext(), ...overrides };
}

describe("common model pick", () => {
  let isStdoutTty: boolean | undefined;
  let isStdinTty: boolean | undefined;

  beforeEach(() => {
    fetchCatalogMock.mockReset();
    selectMock.mockReset();
    isCancelMock.mockReset().mockImplementation(() => false);
    isStdinTty = process.stdin.isTTY;
    isStdoutTty = process.stdout.isTTY;
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
  });

  afterEach(() => {
    process.stdin.isTTY = isStdinTty;
    process.stdout.isTTY = isStdoutTty;
  });

  it("uses an explicit --model without prompting", async () => {
    const pick = await pickMainModel(context({ main: "zai-org/GLM-5.1" }), {
      apiKey: "key",
      baseUrl: "https://example.invalid",
    });
    expect(pick).toMatchObject({ model: "zai-org/GLM-5.1", cancelled: false });
    expect(selectMock).not.toHaveBeenCalled();
    expect(fetchCatalogMock).not.toHaveBeenCalled();
  });

  it("falls back to the default model in non-interactive sessions", async () => {
    const pick = await pickMainModel(context({ onboardingMode: "skip" }), {
      apiKey: "key",
      baseUrl: "https://example.invalid",
    });
    expect(pick).toMatchObject({
      model: DEFAULT_FRIENDLI_MODEL,
      cancelled: false,
    });
    expect(fetchCatalogMock).not.toHaveBeenCalled();
  });

  it("falls back to the default model when the catalog is unreachable", async () => {
    fetchCatalogMock.mockRejectedValueOnce(new Error("offline"));
    const pick = await pickMainModel(context(), {
      apiKey: "key",
      baseUrl: "https://example.invalid",
    });
    expect(pick).toMatchObject({
      model: DEFAULT_FRIENDLI_MODEL,
      cancelled: false,
    });
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("lets interactive sessions pick from the live catalog", async () => {
    fetchCatalogMock.mockResolvedValueOnce([
      { id: "zai-org/GLM-5.2", label: "zai-org/GLM-5.2" },
      { id: "deepseek-ai/DeepSeek-V3.2", label: "deepseek-ai/DeepSeek-V3.2" },
    ]);
    selectMock.mockResolvedValueOnce("deepseek-ai/DeepSeek-V3.2");

    const pick = await pickMainModel(context(), {
      apiKey: "key",
      baseUrl: "https://example.invalid",
    });

    expect(pick).toMatchObject({
      model: "deepseek-ai/DeepSeek-V3.2",
      cancelled: false,
    });
    // Handed back so callers needing model metadata do not fetch it again.
    expect(pick.cancelled === false && pick.catalog.map((m) => m.id)).toEqual([
      "zai-org/GLM-5.2",
      "deepseek-ai/DeepSeek-V3.2",
    ]);
    expect(fetchCatalogMock).toHaveBeenCalledWith(
      "key",
      "https://example.invalid",
    );
  });

  it("surfaces cancellation from the picker", async () => {
    fetchCatalogMock.mockResolvedValueOnce([
      { id: "zai-org/GLM-5.2", label: "GLM-5.2" },
    ]);
    const cancelSymbol = Symbol("cancel");
    selectMock.mockResolvedValueOnce(cancelSymbol);
    isCancelMock.mockImplementation((value: unknown) => value === cancelSymbol);

    const pick = await pickMainModel(context(), {
      apiKey: "key",
      baseUrl: "https://example.invalid",
    });
    expect(pick).toEqual({ cancelled: true });
  });

  it("never prompts in --json mode", async () => {
    process.stdout.isTTY = true;
    const pick = await pickMainModel(context({ json: true }), {
      apiKey: "key",
      baseUrl: "https://example.invalid",
    });

    expect(pick).toMatchObject({
      model: DEFAULT_FRIENDLI_MODEL,
      cancelled: false,
    });
    expect(fetchCatalogMock).not.toHaveBeenCalled();
  });
});
