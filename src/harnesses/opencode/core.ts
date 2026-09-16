import path from "node:path";
import type { FriendliModel } from "../../friendli/model-catalog.js";
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
import { harnessDataDir } from "../../config/paths.js";

/** opencode's provider id for Friendli, keyed identically in models.dev. */
export const PROVIDER_ID = "friendli";

/** `/connect` writes exactly this entry — we write the same shape so the
 * provider listing and auth flow treat frlink like a manual connect. */
interface AuthEntry {
  type: string;
  key?: string;
}

interface ProviderState {
  apiKeySource: "flag" | "env" | "keychain";
  model: string;
}

/** One entry of opencode's config `provider.<id>.models.<modelId>` — just the
 * fields opencode's model merge actually reads (verified against its 1.18.27
 * `packages/opencode/src/provider/provider.ts`: `model.temperature/reasoning/
 * attachment/tool_call/modalities/interleaved/cost/limit/variants`). Every
 * field but `name` is optional on purpose: an entry carries only what
 * Friendli's live catalog really reported for that model. */
interface ModelListEntry {
  name: string;
  reasoning?: boolean;
  temperature?: boolean;
  attachment?: boolean;
  tool_call?: boolean;
  /** Response field carrying the reasoning stream (e.g. "reasoning_content");
   * opencode's merge accepts the bare string form and converts it itself. */
  interleaved?: string;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; output?: number };
  /** models.dev-style flat pricing, dollars per million tokens (opencode's unit). */
  cost?: { input?: number; output?: number; cache_read?: number };
  variants?: Record<string, Record<string, unknown>>;
}

/** When opencode knows (from its models.dev snapshot) that a model supports
 * reasoning but can't derive concrete effort levels from the id, it guesses
 * these three keys for `@ai-sdk/openai-compatible` models — the npm every
 * Friendli model uses. Ids models.dev doesn't list get no guess at all.
 *
 * Verified against opencode 1.18.27 (`packages/opencode/src/provider/transform.ts`,
 * `ProviderTransform.variants()`'s `@ai-sdk/openai-compatible` case, `WIDELY_SUPPORTED_EFFORTS`).
 * This is opencode's internal fallback, not a documented contract — if a future
 * opencode version changes it, re-verify with `opencode models friendli --verbose`
 * after upgrading and update this list to match. */
const AUTO_INFERRED_EFFORT_KEYS = ["low", "medium", "high"];

/**
 * Shape a model's reasoning selector for opencode (which folds config
 * `variants` by key over its own models.dev-derived set). Rules:
 * - toggle → always `off` = `chat_template_kwargs.enable_thinking: false`;
 *   `on` only when there are no effort levels to turn reasoning on with.
 * - effort levels → each as a `reasoningEffort` variant (the only way a
 *   brand-new id the models.dev snapshot hasn't listed gets a selector).
 * - guessed keys the model doesn't support → `{ disabled: true }` (omit =
 *   they'd stay live, e.g. a low/medium/high selector on `gemma`).
 */
function reasoningVariantsFor(
  model: FriendliModel,
): Pick<ModelListEntry, "variants"> {
  if (!model.reasoningToggle && !model.reasoningEffortLevels?.length) {
    return {};
  }
  const variants: Record<string, Record<string, unknown>> = {};
  if (model.reasoningToggle) {
    variants.off = { chat_template_kwargs: { enable_thinking: false } };
    if (!model.reasoningEffortLevels?.length) {
      variants.on = { chat_template_kwargs: { enable_thinking: true } };
    }
  }
  for (const level of model.reasoningEffortLevels ?? []) {
    variants[level] = { reasoningEffort: level };
  }
  for (const key of AUTO_INFERRED_EFFORT_KEYS) {
    if (!model.reasoningEffortLevels?.includes(key)) {
      variants[key] = { disabled: true };
    }
  }
  return { variants };
}

/** Friendli's live view of one model, in opencode's config-model shape.
 * opencode fills these fields from its own models.dev snapshot when it knows
 * the id, then merges whatever this config carries ON TOP, by key — so writing
 * them pins the live values, and ids the snapshot hasn't listed yet (which
 * otherwise resolve with `reasoning: false`, empty limits, zero cost and no
 * variants) stay fully usable from day one. */
function opencodeModelEntry(model: FriendliModel): ModelListEntry {
  return {
    name: model.label,
    ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
    ...(model.temperature !== undefined
      ? { temperature: model.temperature }
      : {}),
    // opencode derives "can attach files" the same way for its own Modal
    // plugin: any non-text input modality counts.
    ...(model.inputModalities?.some((modality) => modality !== "text")
      ? { attachment: true }
      : {}),
    ...(model.toolCall !== undefined ? { tool_call: model.toolCall } : {}),
    ...(model.interleaved ? { interleaved: model.interleaved } : {}),
    ...(model.inputModalities !== undefined ||
    model.outputModalities !== undefined
      ? {
          modalities: {
            ...(model.inputModalities !== undefined
              ? { input: model.inputModalities }
              : {}),
            ...(model.outputModalities !== undefined
              ? { output: model.outputModalities }
              : {}),
          },
        }
      : {}),
    ...(model.contextLength !== undefined ||
    model.maxCompletionTokens !== undefined
      ? {
          limit: {
            ...(model.contextLength !== undefined
              ? { context: model.contextLength }
              : {}),
            ...(model.maxCompletionTokens !== undefined
              ? { output: model.maxCompletionTokens }
              : {}),
          },
        }
      : {}),
    ...(model.pricing
      ? {
          cost: {
            ...(model.pricing.input !== undefined
              ? { input: model.pricing.input }
              : {}),
            ...(model.pricing.output !== undefined
              ? { output: model.pricing.output }
              : {}),
            ...(model.pricing.cacheRead !== undefined
              ? { cache_read: model.pricing.cacheRead }
              : {}),
          },
        }
      : {}),
    ...reasoningVariantsFor(model),
  };
}

export function configPath(home: string, override = ""): string {
  if (override) {
    return override;
  }
  const configRoot = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(configRoot, "opencode", "opencode.json");
}

export function authPath(home: string): string {
  const dataRoot =
    process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
  return path.join(dataRoot, "opencode", "auth.json");
}

export function opencodeDataDir(home: string, override = ""): string {
  return harnessDataDir(home, "opencode", override);
}

function statePath(dataDir: string): string {
  return path.join(dataDir, "provider-state.json");
}

/** True when opencode's default model is one of Friendli's. An unparseable
 * config surfaces with the actionable message from `readConfigOrAdvise`. */
export async function isFriendliManaged(configPath: string): Promise<boolean> {
  const config = await readConfigOrAdvise(configPath);
  return (
    typeof config?.model === "string" &&
    (config.model as string).startsWith(`${PROVIDER_ID}/`)
  );
}

/** Same as readJsonIfExists, but a parse failure gets an actionable message
 * instead of a bare SyntaxError (opencode configs sometimes carry comments). */
async function readConfigOrAdvise(
  filePath: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const { value } = await readJsonIfExists<Record<string, unknown>>(filePath);
    return value;
  } catch (error) {
    throw new Error(
      `${filePath} could not be parsed as JSON (trailing commas and comments are not supported ` +
        `here) — clean it up and rerun. Underlying error: ${(error as Error).message}`,
      { cause: error },
    );
  }
}

/** The single write path for `opencode on`: snapshot both files, write the
 * auth entry opencode's `/connect` would have written, and pin the default
 * model to the Friendli one. */
export async function enableFriendliForOpenCode(options: {
  configPath: string;
  authPath: string;
  dataDir: string;
  apiKey: string;
  apiKeySource: "flag" | "env" | "keychain";
  model: string;
  telemetryHeaders?: Readonly<Record<string, string>>;
  /** Friendli's live model list, when it could be fetched — merged into
   * `provider.friendli.models` so opencode's model list for Friendli isn't
   * limited to its own (often stale) models.dev snapshot, and so each model's
   * limits, pricing, modalities and reasoning variants stay pinned to the
   * live values even for ids the snapshot doesn't know yet. */
  models?: FriendliModel[];
}): Promise<{ model: string }> {
  const {
    configPath,
    authPath,
    dataDir,
    apiKey,
    apiKeySource,
    model,
    telemetryHeaders = {},
    models,
  } = options;

  // A pre-friendli-routed config shouldn't be snapshotted as "original".
  // The auth file gets no managed check: a frlink-written entry is
  // indistinguishable from a `/connect` one, and snapshotting too eagerly is
  // the safe direction (restores the user's own key untouched).
  await snapshotFileIfNeeded({
    configPath,
    backupPath: backupPathFor(dataDir, "config"),
    isManaged: () => isFriendliManaged(configPath),
  });
  await snapshotFileIfNeeded({
    configPath: authPath,
    backupPath: backupPathFor(dataDir, "auth"),
    isManaged: async () => false,
  });

  const auth = await readConfigOrAdvise(authPath);
  const nextAuth = {
    ...auth,
    [PROVIDER_ID]: { type: "api", key: apiKey } satisfies AuthEntry,
  };
  // The file now carries the API key literally.
  await writeJson(authPath, nextAuth, { mode: 0o600 });

  const config = objectOrEmpty(await readConfigOrAdvise(configPath));
  const nextConfig: Record<string, unknown> = {
    ...config,
    model: `${PROVIDER_ID}/${model}`,
  };
  const hasModels = Boolean(models && models.length > 0);
  const hasTelemetryHeaders = Object.keys(telemetryHeaders).length > 0;
  if (hasModels || hasTelemetryHeaders) {
    const providers = objectOrEmpty(config.provider);
    const friendliProvider = objectOrEmpty(providers[PROVIDER_ID]);

    const modelList: Record<string, ModelListEntry> = {};
    for (const m of models ?? []) {
      modelList[m.id] = opencodeModelEntry(m);
    }
    const friendliOptions = objectOrEmpty(friendliProvider.options);

    nextConfig.provider = {
      ...providers,
      [PROVIDER_ID]: {
        ...friendliProvider,
        ...(hasModels
          ? {
              models: {
                ...objectOrEmpty(friendliProvider.models),
                ...modelList,
              },
            }
          : {}),
        ...(hasTelemetryHeaders
          ? {
              options: {
                ...friendliOptions,
                headers: mergeFrlinkTelemetryHeaders(
                  staticTelemetryHeaders(friendliOptions.headers),
                  telemetryHeaders,
                ),
              },
            }
          : {}),
      },
    };
  }
  await writeJson(configPath, nextConfig);

  await writeJson(
    statePath(dataDir),
    { apiKeySource, model } satisfies ProviderState,
    {
      mode: 0o600,
    },
  );

  return { model: `${PROVIDER_ID}/${model}` };
}

/** Restores both files to their pre-FriendliLink bytes (or deletes them
 * if they didn't exist). */
export async function disableFriendliForOpenCode(options: {
  configPath: string;
  authPath: string;
  dataDir: string;
}): Promise<DisableOutcome> {
  const configOutcome = await restoreFileFromBackup({
    configPath: options.configPath,
    backupPath: backupPathFor(options.dataDir, "config"),
  });
  const authOutcome = await restoreFileFromBackup({
    configPath: options.authPath,
    backupPath: backupPathFor(options.dataDir, "auth"),
  });

  if (configOutcome === "none" && authOutcome === "none") {
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
