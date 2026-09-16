import { beforeEach, describe, expect, it, vi } from "vitest";

const selectMock = vi.fn();
const isCancelMock = vi.fn(() => false);

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  select: (...args: unknown[]) => selectMock(...args),
  isCancel: (...args: unknown[]) => isCancelMock(...args),
  log: { warn: vi.fn() },
}));

const { runClaudeModelOnboarding } =
  await import("../../../src/harnesses/claude/onboarding.js");

describe("claude model onboarding wizard", () => {
  beforeEach(() => {
    selectMock.mockReset();
    isCancelMock.mockReset().mockImplementation(() => false);
  });

  it("returns an empty mapping without prompting when the catalog has no models", async () => {
    const result = await runClaudeModelOnboarding([]);
    expect(result).toEqual({});
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("records a model for every slot", async () => {
    selectMock
      .mockResolvedValueOnce("opus-1")
      .mockResolvedValueOnce("haiku-1")
      .mockResolvedValueOnce("haiku-1")
      .mockResolvedValueOnce("opus-1")
      .mockResolvedValueOnce("haiku-1");

    const models = [
      { id: "opus-1", label: "Opus One" },
      { id: "haiku-1", label: "Haiku One" },
    ];

    const result = await runClaudeModelOnboarding(models);
    expect(result).toEqual({
      opus: "opus-1",
      sonnet: "haiku-1",
      haiku: "haiku-1",
      fable: "opus-1",
      subagent: "haiku-1",
    });
    expect(selectMock).toHaveBeenCalledTimes(5);
  });

  it("offers only catalog models — no slot can be left on a Claude default", async () => {
    selectMock.mockResolvedValue("opus-1");

    await runClaudeModelOnboarding([{ id: "opus-1", label: "Opus One" }]);

    for (const [{ options }] of selectMock.mock.calls as Array<
      [{ options: Array<{ value: string }> }]
    >) {
      expect(options).toEqual([{ value: "opus-1", label: "Opus One" }]);
    }
  });

  it("returns null when the user cancels mid-wizard", async () => {
    const cancelSymbol = Symbol("cancel");
    selectMock
      .mockResolvedValueOnce("opus-1")
      .mockResolvedValueOnce(cancelSymbol);
    isCancelMock.mockImplementation((value: unknown) => value === cancelSymbol);

    const result = await runClaudeModelOnboarding([
      { id: "opus-1", label: "Opus One" },
    ]);
    expect(result).toBeNull();
  });
});
