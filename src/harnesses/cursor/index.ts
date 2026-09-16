import * as clack from "@clack/prompts";
import { setHarnessEnabled } from "../../config/global-config.js";
import {
  friendliApiBaseUrl,
  normalizeFriendliBaseUrl,
} from "../../friendli/base-url.js";
import { checkFriendliCredential } from "../../friendli/client.js";
import {
  fetchFriendliModelCatalog,
  type FriendliModel,
} from "../../friendli/model-catalog.js";
import { isInstalledByMarker } from "../common/installed.js";
import { resolveVerifiedKey } from "../common/key-preamble.js";
import { interactiveSession } from "../common/model-pick.js";
import type {
  HarnessAdapter,
  HarnessContext,
  OnOutcome,
  ProviderStatus,
} from "../../harness/types.js";
import {
  assertCursorProfileExists,
  cursorDataDir,
  cursorHasManagedMarkers,
  cursorStateDbPath,
  APPLICATION_USER_KEY,
  disableFriendliForCursor,
  enableFriendliForCursor,
  parseBlob,
  readProviderState,
} from "./core.js";
import {
  friendliKeyInEnvironment,
  isLikelyFriendliKey,
  persistApiKey,
} from "../../keys/api-key.js";
import { readItemTableValue } from "../../system/sqlite.js";
import { isInsideCursor, stopCursor, waitForCursorExit } from "./guard.js";
import {
  clearPending,
  deferUntilCursorExits,
  deferredLogPath,
  readPending,
} from "./deferred.js";
import { appendFile } from "node:fs/promises";

/** Cursor's OpenAI override talks to Friendli's OpenAI-compatible endpoint;
 * the same root verifies the API key. */
function apiBaseUrl(ctx: HarnessContext): string {
  return friendliApiBaseUrl(
    ctx.baseUrlFromFlag && ctx.baseUrl
      ? normalizeFriendliBaseUrl(ctx.baseUrl)
      : undefined,
  );
}

function paths(ctx: HarnessContext): { dbPath: string; dataDir: string } {
  return {
    dbPath: cursorStateDbPath(ctx.home, ctx.settingsPath),
    dataDir: cursorDataDir(ctx.home, ctx.dataDir),
  };
}

/**
 * macOS reads login-keychain items during `on` and each one can raise a
 * password prompt, so say it is coming before it appears.
 *
 * How many is knowable without touching the keychain: the Friendli key is
 * read from there only when neither `--api-key` nor the environment supplied
 * one (see resolveApiKey's precedence). Cursor Safe Storage is always read,
 * to write the key where Cursor looks.
 */
function warnAboutKeychainPrompts(ctx: HarnessContext): void {
  if (process.platform !== "darwin") {
    return;
  }
  const fromKeychain = !ctx.apiKey?.trim() && !friendliKeyInEnvironment();
  console.log(
    `frlink: macOS may ask for your login password ${fromKeychain ? "twice" : "once"} — ` +
      `${fromKeychain ? "for frlink's saved key, then " : ""}for Cursor Safe Storage.`,
  );
  console.log('  "Always Allow" skips it next time.');
}

/** Where to get or rotate a key, for the one error a user can actually fix. */
const API_KEYS_DOC_URL =
  "https://friendli.ai/docs/guides/suite/personal-api-keys";

/**
 * Make sure the key Cursor is about to receive is one Friendli accepts.
 *
 * Cursor does not call Friendli from this machine — it hands the key to its
 * own backend, which makes the call — so a dead key produces no error here,
 * no error at `on`, and a 401 several hops away inside the IDE. Nothing else
 * in the flow catches it either: `GET /v1/models` answers unauthenticated
 * requests, so neither the key verification nor the catalog fetch can tell a
 * live key from a revoked one.
 *
 * Rejected keys are re-asked for rather than refused outright, because the
 * usual cause is a stale `FRIENDLIAI_API_KEY` or a rotated saved key, and the
 * fix is one paste. A key entered here is saved the way `login` saves it.
 */
async function keyCursorCanUse(
  ctx: HarnessContext,
  key: string,
  catalog: FriendliModel[],
  /** Whether the starting key came from `--api-key`, which `login` would have
   * saved. It is saved here instead, once Friendli has actually accepted it. */
  saveIfAccepted = false,
): Promise<{ key: string; fromPrompt: boolean } | { cancelled: true }> {
  const probeModel = catalog[0]?.id;
  // No catalog means no model to probe with. `enableFriendliForCursor` already
  // refuses to register nothing, so let it give that error instead of ours.
  if (!probeModel) return { key, fromPrompt: false };

  let candidate = key;
  for (let attempt = 0; ; attempt++) {
    const check = await checkFriendliCredential(
      candidate,
      probeModel,
      apiBaseUrl(ctx),
    );
    if (check.accepted) {
      if (!check.conclusive && check.message)
        console.warn(`frlink: ${check.message}`);
      if (attempt > 0 || saveIfAccepted) {
        await persistApiKey(ctx.home, candidate);
      }
      return { key: candidate, fromPrompt: attempt > 0 };
    }
    if (!interactiveSession(ctx)) {
      throw new Error(
        `${check.message ?? "FriendliAI rejected this API key."} Cursor would have been pointed at FriendliAI with a key that cannot be used. ` +
          "Run `frlink login` with a working key, or pass --api-key.",
      );
    }
    if (attempt === 0) {
      clack.log.warn(
        `${check.message ?? "FriendliAI rejected this API key."}\n` +
          `Please enter the correct FriendliAI API key. ${API_KEYS_DOC_URL}`,
      );
    }
    const entered = await clack.password({
      message:
        attempt === 0
          ? "FriendliAI API key:"
          : "That key was rejected too. FriendliAI API key:",
      validate: (value) =>
        isLikelyFriendliKey(value ?? "")
          ? undefined
          : "That doesn't look like a FriendliAI API key.",
    });
    if (clack.isCancel(entered)) {
      clack.cancel("Cancelled — Cursor was left unchanged.");
      return { cancelled: true };
    }
    candidate = entered.trim();
  }
}

async function on(ctx: HarnessContext): Promise<OnOutcome | void> {
  // Cursor keeps the model per conversation, not per install, so there is no
  // single model for `on` to set — see enableFriendliForCursor. Saying so
  // beats accepting the flag and quietly doing nothing with it.
  //
  // Only a model the user typed is refused. `all on` pins one selection on
  // every harness, and failing the whole run over a model Cursor was never
  // going to use would be the tail wagging the dog — there, `on` registers
  // the catalog and the picker is still where you choose.
  if (ctx.main && ctx.mainFromFlag) {
    throw new Error(
      "`cursor on` takes no --model: Cursor picks the model per conversation, so `on` registers the whole FriendliAI catalog and you choose in Cursor's model picker.",
    );
  }
  await assertCursorProfileExists(paths(ctx).dbPath);
  if (await deferIfInsideCursor(ctx, "on")) {
    return;
  }
  if (!(await awaitCursorExitIfDeferred(ctx))) {
    return;
  }
  await stopCursor(ctx.force);
  warnAboutKeychainPrompts(ctx);

  // Do not let the preamble save a `--api-key` key yet: its check probes the
  // unauthenticated `/models`, so it would bank a revoked key that
  // keyCursorCanUse is about to reject.
  const resolved = await resolveVerifiedKey(ctx, apiBaseUrl(ctx), {
    persistFlagKey: false,
  });

  // The model list Cursor's picker will offer. Offline, enable falls back to
  // whatever an earlier run registered, and fails if there is nothing.
  const catalog: FriendliModel[] = await fetchFriendliModelCatalog(
    resolved.key,
    apiBaseUrl(ctx),
  ).catch(() => []);

  // Before anything is written: prove Friendli accepts this key.
  const usable = await keyCursorCanUse(
    ctx,
    resolved.key,
    catalog,
    resolved.source === "flag",
  );
  if ("cancelled" in usable) return { cancelled: true };

  const paths_ = paths(ctx);
  const result = await enableFriendliForCursor({
    dbPath: paths_.dbPath,
    dataDir: paths_.dataDir,
    apiKey: usable.key,
    // A prompted key was just written to the keychain, so reporting the
    // source the run started with would misdescribe where it now lives.
    apiKeySource: usable.fromPrompt ? "keychain" : resolved.source,
    baseUrl: apiBaseUrl(ctx),
    catalogIds: catalog.map((model) => model.id),
  });

  await setHarnessEnabled(ctx.home, "cursor", true);

  console.log("frlink: Cursor is now routed through FriendliAI.");
  console.log(`  endpoint: ${apiBaseUrl(ctx)}`);
  console.log(
    `  models offered: ${result.modelsAdded.length} — choose one in Cursor's model picker`,
  );
  if (result.modelsHidden.length > 0) {
    console.log(
      `  hidden: ${result.modelsHidden.length} of Cursor's own models that stop working behind the override`,
    );
  }
}

/**
 * Inside Cursor's own terminal the write cannot be made now: Cursor would
 * overwrite it from its in-memory cache on quit. Hand the work to a detached
 * run that waits for Cursor to exit.
 *
 * Returns true when the caller should stop.
 */
async function deferIfInsideCursor(
  ctx: HarnessContext,
  verb: "on" | "off",
): Promise<boolean> {
  if (ctx.awaitCursorExit || !isInsideCursor()) {
    return false;
  }
  const { dataDir } = paths(ctx);
  await deferUntilCursorExits({ verb, dataDir });
  console.log(
    `frlink: Cursor is running, so \`${verb}\` will be applied when you quit it.`,
  );
  console.log(
    "  Nothing changes until then — `cursor status` keeps reporting the current state",
  );
  console.log("  until you quit Cursor and open it again.");
  return true;
}

/** The detached run: wait for Cursor to go, then fall through and do the work. */
async function awaitCursorExitIfDeferred(
  ctx: HarnessContext,
): Promise<boolean> {
  if (!ctx.awaitCursorExit) {
    return true;
  }
  const { dataDir } = paths(ctx);
  const exited = await waitForCursorExit();
  if (!exited) {
    await appendFile(
      deferredLogPath(dataDir),
      `${new Date().toISOString()} gave up waiting for Cursor to exit\n`,
    ).catch(() => {});
    await clearPending(dataDir);
    return false;
  }
  return true;
}

/** Record the deferred outcome; the marker is what `status` reports on. */
async function finishDeferred(
  ctx: HarnessContext,
  verb: "on" | "off",
  error?: unknown,
): Promise<void> {
  if (!ctx.awaitCursorExit) {
    return;
  }
  const { dataDir } = paths(ctx);
  const outcome = error ? `failed: ${(error as Error).message}` : "applied";
  await appendFile(
    deferredLogPath(dataDir),
    `${new Date().toISOString()} ${verb} ${outcome}\n`,
  ).catch(() => {});
  await clearPending(dataDir);
}

async function off(ctx: HarnessContext): Promise<void> {
  if (await deferIfInsideCursor(ctx, "off")) {
    return;
  }
  if (!(await awaitCursorExitIfDeferred(ctx))) {
    return;
  }
  await stopCursor(ctx.force);

  const result = await disableFriendliForCursor(paths(ctx));
  await setHarnessEnabled(ctx.home, "cursor", false);

  if (result.outcome === "none") {
    console.log("frlink: Cursor was not managed by frlink; nothing to do.");
    return;
  }
  console.log(
    "frlink: Cursor settings restored to their pre-FriendliAI state.",
  );
  if (result.apiKey === "left") {
    console.log("  note: the OpenAI key cell was left as you set it.");
  } else if (!result.hadBackup) {
    console.log(
      "  note: the pre-`on` snapshot was missing, so any OpenAI API key you had before could not be put back; the key cell is now empty.",
    );
  } else if (result.apiKey === "cleared") {
    console.log(
      "  note: the OpenAI key cell is empty again, as it was before `on`.",
    );
  }
}

/**
 * `managed` answers one question: is Cursor routed at the Friendli endpoint
 * *this* command would use? So it turns true on `on` and false on `off`, and
 * it is deliberately false when `on` pointed Cursor at some other endpoint —
 * a staging `--base-url`, or the capture relay in CONTRIBUTING.md.
 *
 * That last case is still ours, though, and saying "not managed by
 * frlink" about a database carrying our ownership record reads as a
 * flat contradiction — the JSON even printed `managed: false` beside
 * `ours: true`. `ours` and the endpoint we actually wrote are reported
 * alongside, and the key source no longer disappears with them: it is
 * bookkeeping about the last `on`, true whichever endpoint that `on` chose.
 */
async function status(ctx: HarnessContext): Promise<void> {
  const paths_ = paths(ctx);
  const raw = await readItemTableValue(paths_.dbPath, APPLICATION_USER_KEY);
  const blob = parseBlob(raw);
  const expected = apiBaseUrl(ctx);
  const routedTo =
    typeof blob.openAIBaseUrl === "string" ? blob.openAIBaseUrl : "";
  const managed = blob.useOpenAIKey === true && routedTo === expected;
  const ours = cursorHasManagedMarkers(blob);
  const state =
    managed || ours ? await readProviderState(paths_.dataDir) : undefined;
  const pending = await readPending(paths_.dataDir);

  if (ctx.json) {
    console.log(
      JSON.stringify(
        {
          managed,
          apiKeySource: state?.apiKeySource ?? null,
          ours,
          baseUrl: routedTo || null,
          expectedBaseUrl: expected,
          pending: pending?.verb ?? null,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (pending) {
    console.log(
      `cursor: \`${pending.verb}\` is queued and applies when you quit Cursor; what follows is the state until then.`,
    );
  }
  if (managed) {
    console.log("cursor: routed through FriendliAI.");
    if (state) {
      console.log(`  api key source: ${state.apiKeySource}`);
    }
    return;
  }

  if (ours) {
    // Configured by us, just not at the endpoint this invocation targets.
    console.log(
      routedTo
        ? `cursor: configured by frlink, but routed to ${routedTo} — not ${expected}.`
        : "cursor: configured by frlink, but the OpenAI override is no longer active.",
    );
    if (state) {
      console.log(`  api key source: ${state.apiKeySource}`);
    }
    console.log(
      `  \`cursor off\` reverts it; \`cursor status --base-url ${routedTo || expected}\` reports on that endpoint.`,
    );
    return;
  }

  console.log(
    "cursor: not managed by frlink (no FriendliAI OpenAI override active).",
  );
}

async function resolveKey(ctx: HarnessContext): Promise<string> {
  const resolved = await resolveVerifiedKey(ctx, apiBaseUrl(ctx));
  return resolved.key;
}

async function providerStatus(ctx: HarnessContext): Promise<ProviderStatus> {
  const paths_ = paths(ctx);
  const raw = await readItemTableValue(paths_.dbPath, APPLICATION_USER_KEY);
  const blob = parseBlob(raw);
  const routed =
    blob.useOpenAIKey === true && blob.openAIBaseUrl === apiBaseUrl(ctx);
  if (routed) {
    return "friendli";
  }
  // An unreadable key doesn't mean unmanaged: a half-finished teardown can
  // clear the key cell while our markers (models registered, built-ins
  // hidden) are still on the blob — still report routed so `off` runs.
  return cursorHasManagedMarkers(blob) ? "friendli" : "default";
}

/** `all` and `check installed` skip harnesses this machine never set up;
 * Cursor's marker is its user-data root, not a binary on PATH. */
async function isInstalled(home: string): Promise<boolean> {
  return isInstalledByMarker("cursor", home);
}

/** A detached run must leave a verdict behind either way — it has no terminal. */
function recordingOutcome<T>(
  verb: "on" | "off",
  run: (ctx: HarnessContext) => Promise<T>,
): (ctx: HarnessContext) => Promise<T> {
  return async (ctx) => {
    try {
      const result = await run(ctx);
      await finishDeferred(ctx, verb);
      return result;
    } catch (error) {
      await finishDeferred(ctx, verb, error);
      throw error;
    }
  };
}

export const cursorAdapter: HarnessAdapter = {
  id: "cursor",
  label: "Cursor",
  on: recordingOutcome("on", on),
  off: recordingOutcome("off", off),
  status,
  resolveKey,
  providerStatus,
  isInstalled,
};
