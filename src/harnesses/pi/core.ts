import path from "node:path";
import { readJsonIfExists, writeJson } from "../../io/json.js";
import {
  mergeFrlinkTelemetryHeaders,
  objectOrEmpty,
  staticTelemetryHeaders,
} from "../../telemetry/request-headers.js";
import {
  backupPathFor,
  removeQuietly,
  restoreFileFromBackup,
  snapshotFileIfNeeded,
} from "../common/backup.js";
import type { DisableOutcome } from "../common/plugin-runner.js";
import type { FriendliModel } from "../../friendli/model-catalog.js";
import { buildPiCatalog, type PiModelEntry } from "./catalog.js";
import { harnessDataDir } from "../../config/paths.js";

export type { PiModelEntry } from "./catalog.js";

/** The provider key Pi's model picker shows — the name the FriendliAI guide
 * uses so a guided hand-setup and frlink produce the same config. */
export const PROVIDER_ID = "friendliai-chat-completions";
export const AGENT_DIR_RELATIVE_PATH = ".pi/agent";
export const SETTINGS_FILE_NAME = "settings.json";
export const MODELS_FILE_NAME = "models.json";

interface ProviderState {
  apiKeySource: "flag" | "env" | "keychain";
  model: string;
}

export function agentDir(home: string, settingsOverride = ""): string {
  // --settings-path points at settings.json; models.json sits beside it.
  if (settingsOverride) {
    return path.dirname(settingsOverride);
  }
  // pi itself resolves PI_CODING_AGENT_DIR before ~/.pi/agent (getAgentDir()
  // in its bundle) — we must write to the dir pi READS from, or an env-
  // scoped install never sees our config.
  return (
    process.env.PI_CODING_AGENT_DIR?.trim() ||
    path.join(home, AGENT_DIR_RELATIVE_PATH)
  );
}

export function piSettingsPath(home: string, override = ""): string {
  return override || path.join(agentDir(home), SETTINGS_FILE_NAME);
}

export function piModelsPath(home: string, settingsOverride = ""): string {
  return path.join(agentDir(home, settingsOverride), MODELS_FILE_NAME);
}

export function piDataDir(home: string, override = ""): string {
  return harnessDataDir(home, "pi", override);
}

function statePath(dataDir: string): string {
  return path.join(dataDir, "provider-state.json");
}

/** True when Pi's default provider is the Friendli one. */
export async function isFriendliManaged(
  settingsPath: string,
): Promise<boolean> {
  const { value: settings } = await readJsonIfExists<{
    defaultProvider?: unknown;
  }>(settingsPath);
  return settings?.defaultProvider === PROVIDER_ID;
}

/**
 * Single write path for `pi on`. models.json gets the FriendliAI-guide
 * provider block (custom OpenAI-completions) with the full live catalog, or
 * the picked model alone if the catalog is unreachable. Entries only ADD
 * (see ./catalog.ts) the off-switch + role-pin shapes; Pi renders the
 * /thinking level itself. Session start level is Pi's call — frlink doesn't
 * seed modelThinkingLevels. settings.json points the default at it;
 * auth.json is NOT touched (custom providers keep their key in models.json).
 */
export async function enableFriendliForPi(options: {
  settingsPath: string;
  modelsPath: string;
  dataDir: string;
  apiKey: string;
  apiKeySource: "flag" | "env" | "keychain";
  /** Friendli's OpenAI-compatible base (`.../serverless/v1`). */
  baseUrl: string;
  model: string;
  catalog: FriendliModel[];
  telemetryHeaders?: Readonly<Record<string, string>>;
}): Promise<{ model: string; models: PiModelEntry[] }> {
  const {
    settingsPath,
    modelsPath,
    dataDir,
    apiKey,
    apiKeySource,
    baseUrl,
    model,
    catalog,
    telemetryHeaders = {},
  } = options;

  await snapshotFileIfNeeded({
    configPath: settingsPath,
    backupPath: backupPathFor(dataDir, "settings"),
    isManaged: () => isFriendliManaged(settingsPath),
  });
  await snapshotFileIfNeeded({
    configPath: modelsPath,
    backupPath: backupPathFor(dataDir, "models"),
    isManaged: async () => false, // our entry is indistinguishable from a hand-added one
  });

  const entries: PiModelEntry[] =
    catalog.length > 0
      ? buildPiCatalog(catalog)
      : // The picked model alone, plain — for a genuinely empty catalog
        // response, not a failed fetch (`pi on` fails outright on that; see
        // ./index.ts, since a plain entry here would silently drop a
        // switch model's enable_thinking fix while still reporting
        // success). Its off-switch rules come from Friendli's catalog
        // (reasoning_options) — without one there's nothing to calibrate
        // against, so this passes reasoning_effort through untouched, same
        // as the guide's hand-setup shape.
        [{ id: model, reasoning: true }];
  const { value: modelsConfig } = await readJsonIfExists<{
    providers?: Record<string, unknown>;
  }>(modelsPath);
  const existingProvider = objectOrEmpty(
    modelsConfig?.providers?.[PROVIDER_ID],
  );
  const telemetryConfig =
    Object.keys(telemetryHeaders).length > 0
      ? {
          headers: mergeFrlinkTelemetryHeaders(
            staticTelemetryHeaders(existingProvider.headers),
            telemetryHeaders,
          ),
        }
      : {};
  const nextModels = {
    ...modelsConfig,
    providers: {
      ...modelsConfig?.providers,
      [PROVIDER_ID]: {
        ...existingProvider,
        baseUrl,
        api: "openai-completions",
        apiKey,
        models: entries,
        ...telemetryConfig,
      },
    },
  };
  // The file now carries the API key literally.
  await writeJson(modelsPath, nextModels, { mode: 0o600 });

  const { value: settings } =
    await readJsonIfExists<Record<string, unknown>>(settingsPath);
  const nextSettings = {
    ...settings,
    defaultProvider: PROVIDER_ID,
    defaultModel: model,
    // Scope the picker to our provider's models. Pi matches this against
    // `${provider}/${id}` with minimatch, where a bare `*` doesn't cross `/`
    // — every Friendli model id is itself `org/model`, so `*` never matches
    // any of them. `**` spans the extra segment; the explicit entry keeps
    // the chosen model selectable even if the glob semantics ever change.
    enabledModels: [`${PROVIDER_ID}/**`, `${PROVIDER_ID}/${model}`],
  };
  await writeJson(settingsPath, nextSettings);

  await writeJson(
    statePath(dataDir),
    { apiKeySource, model } satisfies ProviderState,
    {
      mode: 0o600,
    },
  );

  return { model, models: entries };
}

/** Restores both files to their pre-FriendliLink bytes (or deletes them
 * if they didn't exist). */
export async function disableFriendliForPi(options: {
  settingsPath: string;
  modelsPath: string;
  dataDir: string;
}): Promise<DisableOutcome> {
  const settingsOutcome = await restoreFileFromBackup({
    configPath: options.settingsPath,
    backupPath: backupPathFor(options.dataDir, "settings"),
  });
  const modelsOutcome = await restoreFileFromBackup({
    configPath: options.modelsPath,
    backupPath: backupPathFor(options.dataDir, "models"),
  });

  if (settingsOutcome === "none" && modelsOutcome === "none") {
    return "none";
  }
  await removeQuietly(statePath(options.dataDir));
  return "restored";
}

export async function readProviderState(
  dataDir: string,
): Promise<ProviderState | undefined> {
  const { value } = await readJsonIfExists<ProviderState>(statePath(dataDir));
  return value;
}
