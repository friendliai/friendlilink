/**
 * Dynamic model discovery against Friendli Serverless `GET /models`.
 *
 * The listing is the authoritative catalog for this provider: Friendli reports
 * `context_length`, `max_completion_tokens`, and per-model reasoning capability
 * descriptors that no hand-maintained table would keep current. Entries
 * carrying a `deprecation_date` are dropped — a deprecated model is no longer
 * active even while it lingers in the response.
 *
 * A model appearing here does not guarantee every request is accepted: account
 * permissions, region, and lifecycle still apply at inference time, surfaced as
 * an `LlmError` from the stream path rather than hidden by this catalog.
 *
 * @module @friendliai/dsh-llm-friendli/models
 */

import { attributionHeaders, LlmError } from "@deepseek-ai/dsh-llm";
import type { WireModelEntry, WireModelList } from "./types.ts";

/** One reasoning capability a Friendli model advertises via `reasoning_options`. */
export interface ReasoningCapability {
  /** `toggle` = on/off thinking; `effort` = discrete levels; `budget_tokens` = numeric budget. */
  type: "toggle" | "effort" | "budget_tokens";
  /** Effort levels, present only for `type:'effort'` (e.g. `['high','max']`). */
  values?: readonly string[];
}

/** A normalized, active Friendli model. */
export interface FriendliModel {
  /** Wire model id accepted by chat/completions (e.g. `zai-org/GLM-5.2`). */
  id: string;
  /** Selector label; defaults to {@link id}. */
  name: string;
  /** Combined request/response context capacity, when disclosed. */
  contextWindow?: number;
  /** Per-request output-token cap, when disclosed. */
  maxTokens?: number;
  /** Whether the model does any reasoning at all. */
  reasoning: boolean;
  /** Advertised reasoning controls; empty when the model exposes none. */
  reasoningOptions: readonly ReasoningCapability[];
}

/** A positive integer, or `undefined` when absent/unusable. */
function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

/** A non-empty string, or `undefined`. */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Parse the `reasoning_options` array defensively; unknown descriptor shapes are skipped. */
function parseReasoningOptions(raw: unknown): ReasoningCapability[] {
  if (!Array.isArray(raw)) return [];
  const out: ReasoningCapability[] = [];
  for (const entry of raw) {
    const type = (entry as { type?: unknown } | null)?.type;
    if (type !== "toggle" && type !== "effort" && type !== "budget_tokens")
      continue;
    const values = (entry as { values?: unknown }).values;
    out.push({
      type,
      ...(Array.isArray(values) && values.every((v) => typeof v === "string")
        ? { values: values as string[] }
        : {}),
    });
  }
  return out;
}

/**
 * Normalize one `/models` entry, or `undefined` when it has no usable id or is
 * deprecated (a deprecated entry is not an active model).
 */
export function normalizeModel(
  entry: WireModelEntry,
): FriendliModel | undefined {
  const id = nonEmpty(entry.id);
  if (id === undefined) return undefined;
  if (entry.deprecation_date !== undefined && entry.deprecation_date !== null)
    return undefined;
  const contextWindow = positiveInt(entry.context_length);
  const maxTokens = positiveInt(entry.max_completion_tokens);
  return {
    id,
    name: nonEmpty(entry.name) ?? id,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    reasoning: entry.reasoning === true,
    reasoningOptions: parseReasoningOptions(entry.reasoning_options),
  };
}

/** Join the endpoint base with `/models`, treating the base as a prefix. */
function listingUrl(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, "")}/models`;
}

/**
 * Fetch and normalize the active model catalog from Friendli Serverless.
 * @param baseURL - endpoint base, e.g. `https://api.friendli.ai/serverless/v1`.
 * @param apiKey - bearer token; `GET /models` is public but a token keeps the
 *   listing consistent with what inference will accept for the account.
 * @param signal - optional caller cancellation.
 * @returns active models in listing order.
 * @throws LlmError coded `MODEL_LIST_FAILED` on transport, HTTP, or shape failure.
 */
export async function fetchModels(
  baseURL: string,
  apiKey: string | undefined,
  signal?: AbortSignal,
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<readonly FriendliModel[]> {
  const url = listingUrl(baseURL);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }),
        ...attributionHeaders(),
        ...extraHeaders,
      },
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error: unknown) {
    if (signal?.aborted)
      throw new LlmError(
        "Friendli model discovery aborted by caller",
        "ABORTED",
        { cause: error },
      );
    throw new LlmError(`could not reach ${url}`, "MODEL_LIST_FAILED", {
      cause: error,
    });
  }
  if (!response.ok) {
    const hint =
      response.status === 401 || response.status === 403
        ? "; check FRIENDLIAI_API_KEY"
        : "";
    throw new LlmError(
      `${url} answered ${response.status}${hint}`,
      "MODEL_LIST_FAILED",
      { status: response.status },
    );
  }
  let body: WireModelList;
  try {
    body = (await response.json()) as WireModelList;
  } catch (error: unknown) {
    throw new LlmError(`${url} did not answer with JSON`, "MODEL_LIST_FAILED", {
      cause: error,
    });
  }
  if (!Array.isArray(body.data)) {
    throw new LlmError(
      `${url} model listing has no "data" array`,
      "MODEL_LIST_FAILED",
    );
  }
  const models: FriendliModel[] = [];
  for (const raw of body.data) {
    const model = normalizeModel(raw as WireModelEntry);
    if (model !== undefined) models.push(model);
  }
  return models;
}
