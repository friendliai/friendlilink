import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  HarnessAdapter,
  HarnessContext,
} from "../../../src/harness/types.js";

const { getHarnessMock } = vi.hoisted(() => ({
  getHarnessMock: vi.fn(),
}));

vi.mock("../../../src/harness/registry.js", () => ({
  getHarness: (...args: unknown[]) => getHarnessMock(...args),
}));

const { createBaseContext } = await import("../../../src/harness/types.js");
const { buildFrlinkTelemetryHeaders } =
  await import("../../../src/telemetry/request-headers.js");
const { runHarnessCommand } =
  await import("../../../src/cli/commands/harness.js");

function testHarness(overrides: Partial<HarnessAdapter> = {}): HarnessAdapter {
  return {
    id: "codex",
    label: "Test Codex",
    on: async () => undefined,
    off: async () => undefined,
    status: async () => undefined,
    resolveKey: async () => "test-key",
    providerStatus: async () => "default",
    ...overrides,
  };
}

describe("runHarnessCommand telemetry lifecycle", () => {
  beforeEach(() => {
    getHarnessMock.mockReset();
  });

  it("passes static telemetry only to an enabled on dispatch", async () => {
    let receivedCtx: HarnessContext | undefined;
    const on = vi.fn(async (received: HarnessContext) => {
      receivedCtx = received;
    });
    const ctx = createBaseContext();
    getHarnessMock.mockReturnValue(testHarness({ telemetryHeaders: true, on }));

    await runHarnessCommand({ harnessId: "codex", verb: "on" }, ctx);

    expect(on).toHaveBeenCalledTimes(1);
    expect(receivedCtx).not.toBe(ctx);
    expect(receivedCtx).toEqual({
      ...ctx,
      telemetryHeaders: buildFrlinkTelemetryHeaders("codex"),
    });
  });

  it("passes the original context to a disabled on dispatch", async () => {
    let receivedCtx: HarnessContext | undefined;
    const on = vi.fn(async (received: HarnessContext) => {
      receivedCtx = received;
    });
    const ctx = createBaseContext();
    getHarnessMock.mockReturnValue(testHarness({ on }));

    await runHarnessCommand({ harnessId: "codex", verb: "on" }, ctx);

    expect(on).toHaveBeenCalledTimes(1);
    expect(receivedCtx).toBe(ctx);
  });

  it("leaves off and status contexts untouched for an enabled harness", async () => {
    let offCtx: HarnessContext | undefined;
    let statusCtx: HarnessContext | undefined;
    const off = vi.fn(async (received: HarnessContext) => {
      offCtx = received;
    });
    const status = vi.fn(async (received: HarnessContext) => {
      statusCtx = received;
    });
    const ctx = {
      ...createBaseContext(),
      telemetryHeaders: { "X-User-Trace": "keep" },
    };
    getHarnessMock.mockReturnValue(
      testHarness({ telemetryHeaders: true, off, status }),
    );

    await runHarnessCommand({ harnessId: "codex", verb: "off" }, ctx);
    await runHarnessCommand({ harnessId: "codex", verb: "status" }, ctx);

    expect(off).toHaveBeenCalledTimes(1);
    expect(offCtx).toBe(ctx);
    expect(status).toHaveBeenCalledTimes(1);
    expect(statusCtx).toBe(ctx);
    expect(ctx.telemetryHeaders).toEqual({ "X-User-Trace": "keep" });
  });
});
