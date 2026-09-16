import {
  FRIENDLI_BASE_URL,
  normalizeFriendliBaseUrl,
} from "../../friendli/base-url.js";
import { listHarnesses, resolveHarnessId } from "../../harness/registry.js";
import type {
  AllVerb,
  HarnessAdapter,
  HarnessContext,
} from "../../harness/types.js";
import { resolveVerifiedKey } from "../../harnesses/common/key-preamble.js";
import { pickMainModel } from "../../harnesses/common/model-pick.js";
import { onDispatchContext } from "./harness.js";

/** Label or "A, B" joined for the `all` feedback lines. */
function joinLabels(harnesses: { label: string }[]): string {
  return harnesses.map((harness) => harness.label).join(", ");
}

/** The requested `all on` feedback — enabled list plus not-installed list. */
export function summarizeInstallResult(options: {
  enabled: { label: string }[];
  skipped: { label: string }[];
}): string {
  const lines: string[] = [];
  if (options.enabled.length > 0) {
    lines.push(`frlink: Enabled FriendliAI on ${joinLabels(options.enabled)}.`);
  }
  if (options.skipped.length > 0) {
    const verb = options.skipped.length === 1 ? "is" : "are";
    lines.push(
      `frlink: ${joinLabels(options.skipped)} ${verb} not installed — skipped.`,
    );
  }
  return lines.join("\n");
}

/** Print a summary, skipping the blank line an empty one would otherwise emit
 * — `all off` on a machine where every agent is installed has nothing to add
 * to the per-agent lines each adapter already printed. */
function printSummary(summary: string): void {
  if (summary) {
    console.log(summary);
  }
}

/** `frlink check` — list which agents this machine has installed.
 * Reuses the `all` partition (probe-failures already print there), no key or
 * model interaction: it only inspects, never writes. With `--json`, emits a
 * machine-readable {harness: bool} map instead of prose. */
export async function runCheckCommand(ctx: HarnessContext): Promise<void> {
  if (ctx.json) {
    const result: Record<string, boolean> = {};
    for (const harness of listHarnesses()) {
      try {
        result[harness.id] = harness.isInstalled
          ? await harness.isInstalled(ctx.home)
          : true;
      } catch (error) {
        console.error(
          `frlink: ${harness.id} install check failed (${(error as Error).message}) — treating as installed`,
        );
        result[harness.id] = true;
      }
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const { installed, skipped } = await partition(ctx);
  if (installed.length > 0) {
    console.log(`frlink: Installed: ${joinLabels(installed)}.`);
  } else {
    console.log("frlink: No supported coding agents are installed.");
  }
  if (skipped.length > 0) {
    console.log(`frlink: Not installed: ${joinLabels(skipped)}.`);
  }
}

/** Parse `ctx.exclude` into a Set; refuses ids the registry doesn't know —
 * a typo'd exclude would silently turn `all off --exclude cluade` into
 * running `off` on the agent the user meant to skip. */
function excludedIds(ctx: HarnessContext): Set<string> {
  const names = ctx.exclude
    ? ctx.exclude
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
    : [];
  if (names.length === 0) {
    return new Set();
  }
  // Accept the same aliases the command line does, so `--exclude claude-code`
  // is not mistaken for the typo this check exists to catch.
  const resolved = names.map((name) => [name, resolveHarnessId(name)] as const);
  const unknown = resolved.filter(([, id]) => !id).map(([name]) => name);
  if (unknown.length > 0) {
    const known = listHarnesses().map((harness) => harness.id);
    throw new Error(
      `--exclude: unknown agent id(s): ${unknown.join(", ")}. Known: ${known.join(", ")}.`,
    );
  }
  return new Set(resolved.map(([, id]) => id as string));
}

/** Split the registry into installed / not-installed, honoring `--exclude`:
 * excluded ids are dropped before the probes run, so they never appear in
 * either list and no work targets them. A harness without an
 * install probe always counts as installed — new adapters keep working with
 * `all` the moment they register; adding a probe later only refines it.
 * A probe that throws (EACCES, EMFILE, ...) can neither prove nor disprove
 * the harness is there, so it lands in installed and `on`/`off` surfaces the
 * real error — never a silent skip on a machine that couldn't be inspected. */
async function partition(
  ctx: HarnessContext,
): Promise<{ installed: HarnessAdapter[]; skipped: HarnessAdapter[] }> {
  const excluded = excludedIds(ctx);
  const installed: HarnessAdapter[] = [];
  const skipped: HarnessAdapter[] = [];
  for (const harness of listHarnesses()) {
    if (excluded.has(harness.id)) {
      continue;
    }
    try {
      const present = harness.isInstalled
        ? await harness.isInstalled(ctx.home)
        : true;
      (present ? installed : skipped).push(harness);
    } catch (error) {
      console.error(
        `frlink: ${harness.id} install check failed (${(error as Error).message}) — attempting it anyway`,
      );
      installed.push(harness);
    }
  }
  return { installed, skipped };
}

function sharedBaseUrl(ctx: HarnessContext): string {
  return ctx.baseUrlFromFlag && ctx.baseUrl
    ? normalizeFriendliBaseUrl(ctx.baseUrl)
    : FRIENDLI_BASE_URL;
}

async function allOn(ctx: HarnessContext): Promise<void> {
  // Partition before touching keys or models: on a machine where no agent
  // is installed, reporting "nothing to do" is the answer, not asking for
  // an API key first.
  const { installed, skipped } = await partition(ctx);
  if (installed.length === 0) {
    printSummary(summarizeInstallResult({ enabled: [], skipped }));
    return;
  }

  // Already-Friendli is a done deal — skip it rather than re-run `on`
  // (snapshot churn, re-prompting, a fresh model overwrite).
  const alreadyDone: HarnessAdapter[] = [];
  const fresh: HarnessAdapter[] = [];
  for (const harness of installed) {
    try {
      if ((await harness.providerStatus(ctx)) === "friendli") {
        alreadyDone.push(harness);
      } else {
        fresh.push(harness);
      }
    } catch {
      fresh.push(harness); // can't tell — let `on` surface the real error
    }
  }
  const failed: { harness: HarnessAdapter; message: string }[] = [];
  const enabled: HarnessAdapter[] = [];
  if (fresh.length === 0) {
    reportAllOnResult({ enabled, alreadyDone, skipped, failed });
    return;
  }

  // One key, one model, every harness still needing it — the requested
  // semantics: a single model selection applies the same model to all.
  const baseUrl = sharedBaseUrl(ctx);
  const resolved = await resolveVerifiedKey(ctx, baseUrl);
  const pick = await pickMainModel(ctx, { apiKey: resolved.key, baseUrl });
  if (pick.cancelled) {
    // The flag key (if any) was verified and persisted in
    // resolveVerifiedKey above — that's how `login` works too — but no
    // harness config was touched. Say both, so "nothing was written"
    // can't imply the vault wasn't.
    console.log(
      resolved.source === "flag"
        ? "frlink: Cancelled — no agent was configured, but the API key from --api-key was verified and saved."
        : "frlink: Cancelled — nothing was written.",
    );
    process.exitCode = 1;
    return;
  }

  // The picked model pins `main`, so no adapter prompts again and every
  // adapter writes the same model. The key was verified+persisted here
  // once — apiKeyPreverified stops adapters re-verifying the flag key.
  const sharedCtx: HarnessContext = {
    ...ctx,
    main: pick.model,
    // Broadcast, not a per-harness flag: an adapter that cannot take a model
    // ignores this instead of failing the run (see the cursor adapter).
    mainFromFlag: false,
    apiKeyPreverified: resolved.source === "flag",
  };
  for (const harness of fresh) {
    try {
      const outcome = await harness.on(onDispatchContext(harness, sharedCtx));
      if (outcome?.cancelled) {
        failed.push({ harness, message: "cancelled during onboarding" });
      } else {
        enabled.push(harness);
      }
    } catch (error) {
      failed.push({ harness, message: (error as Error).message });
    }
  }

  reportAllOnResult({ enabled, alreadyDone, skipped, failed });
}

/** The `all on` report: enabled, already-configured, and not-installed
 * lines, then failures on stderr. */
function reportAllOnResult(options: {
  enabled: HarnessAdapter[];
  alreadyDone: HarnessAdapter[];
  skipped: HarnessAdapter[];
  failed: { harness: HarnessAdapter; message: string }[];
}): void {
  printSummary(
    summarizeInstallResult({
      enabled: options.enabled,
      skipped: options.skipped,
    }),
  );
  if (options.alreadyDone.length > 0) {
    const verb = options.alreadyDone.length === 1 ? "is" : "are";
    console.log(
      `frlink: ${joinLabels(options.alreadyDone)} ${verb} already routed through FriendliAI — left untouched.`,
    );
  }
  for (const failure of options.failed) {
    console.error(`frlink: ${failure.harness.id} failed: ${failure.message}`);
  }
  if (options.failed.length > 0) {
    process.exitCode = 1;
  }
}

async function allOff(ctx: HarnessContext): Promise<void> {
  const { installed, skipped } = await partition(ctx);
  const failed: { harness: HarnessAdapter; message: string }[] = [];

  for (const harness of installed) {
    try {
      await harness.off(ctx);
    } catch (error) {
      failed.push({ harness, message: (error as Error).message });
    }
  }

  printSummary(summarizeInstallResult({ enabled: [], skipped }));
  for (const failure of failed) {
    console.error(`frlink: ${failure.harness.id} failed: ${failure.message}`);
  }
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

export async function runAllCommand(
  verb: AllVerb,
  ctx: HarnessContext,
): Promise<void> {
  switch (verb) {
    case "on":
      await allOn(ctx);
      return;
    case "off":
      await allOff(ctx);
      return;
  }
}
