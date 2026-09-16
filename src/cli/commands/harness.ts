import { buildFrlinkTelemetryHeaders } from "../../telemetry/request-headers.js";
import { getHarness } from "../../harness/registry.js";
import type {
  HarnessAdapter,
  HarnessContext,
  HarnessRoute,
} from "../../harness/types.js";

/** The context a harness's `on` runs with. Attribution headers are generated
 * once here — at `on` dispatch, never per request or session — and only for
 * harnesses with a verified static custom-header surface. Shared by the
 * single-harness `on` and `all on` so every `on` path bakes identical headers. */
export function onDispatchContext(
  harness: HarnessAdapter,
  ctx: HarnessContext,
): HarnessContext {
  return harness.telemetryHeaders
    ? {
        ...ctx,
        telemetryHeaders: buildFrlinkTelemetryHeaders(harness.id),
      }
    : ctx;
}

export async function runHarnessCommand(
  route: HarnessRoute,
  ctx: HarnessContext,
): Promise<void> {
  const harness = getHarness(route.harnessId);
  if (!harness) {
    throw new Error(`Unknown harness: ${route.harnessId}`);
  }

  switch (route.verb) {
    case "on": {
      const outcome = await harness.on(onDispatchContext(harness, ctx));
      if (outcome?.cancelled) {
        process.exitCode = 1;
      }
      break;
    }
    case "off":
      await harness.off(ctx);
      break;
    case "status":
      await harness.status(ctx);
      break;
  }
}
