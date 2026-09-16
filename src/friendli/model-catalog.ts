import { FRIENDLI_BASE_URL, friendliApiUrl } from "./base-url.js";

/** Normalized view of one entry from Friendli's `/v1/models` — raw wire fields
 * are parsed exactly once, here, into the shape this repo's harness adapters
 * consume. */
export interface FriendliModel {
  id: string;
  label: string;
  /** Native context window in tokens, when Friendli reports one. */
  contextLength?: number;
  /** Largest completion Friendli allows, when it reports one. */
  maxCompletionTokens?: number;
  /** Whether the model supports reasoning/thinking. */
  reasoning?: boolean;
  /** Effort levels Friendli exposes for this model's reasoning (e.g. ["low", "high", "max"]). */
  reasoningEffortLevels?: string[];
  /** Whether Friendli exposes an on/off switch for this model's reasoning,
   * separate from (and sometimes alongside) effort levels. It is the signal
   * that decides whether an "off" request is honoured or corrupts the output. */
  reasoningToggle?: boolean;
  /** Token pricing normalized to DOLLARS PER MILLION TOKENS — the unit opencode
   * and models.dev price models in — already converted from Friendli's
   * per-token decimal strings. */
  pricing?: { input?: number; output?: number; cacheRead?: number };
  /** Whether the model accepts tool/function calls, when Friendli reports it. */
  toolCall?: boolean;
  /** Input modalities Friendli lists (e.g. ["text", "image", "video"]). */
  inputModalities?: string[];
  /** Output modalities Friendli lists (e.g. ["text"]). */
  outputModalities?: string[];
  /** Response field that carries the reasoning stream when Friendli names one
   * (e.g. "reasoning_content"). */
  interleaved?: string;
  /** Whether temperature is an accepted sampling parameter. */
  temperature?: boolean;
  description?: string;
}

interface FriendliReasoningOption {
  type: string;
  /** Present on "effort" options: the discrete levels Friendli accepts. */
  values?: string[];
  /** Present on "budget_tokens" options; only carried, never consumed here. */
  min?: number;
  max?: number;
}

/** Friendli quotes each model's prices as per-token decimal strings (e.g.
 * "0.00000015" dollars/token); opencode and models.dev price models per
 * million tokens. Round the conversion — a raw float multiply turns that same
 * price into 0.15000000000000002 in a human-readable config file. */
function pricePerMillion(raw: string | number | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.round(parsed * 1_000_000 * 1e6) / 1e6;
}

interface FriendliModelEntry {
  id: string;
  name?: string;
  context_length?: number;
  max_completion_tokens?: number;
  reasoning?: boolean;
  reasoning_options?: FriendliReasoningOption[];
  /** Friendli sends the input/output pair and the prompt/completion aliases;
   * any of them can be missing. */
  pricing?: {
    input?: string | number;
    output?: string | number;
    prompt?: string | number;
    completion?: string | number;
    input_cache_read?: string | number;
  };
  functionality?: { tool_call?: boolean; [key: string]: unknown };
  input_modalities?: string[];
  output_modalities?: string[];
  interleaved?: string;
  default_params?: { temperature?: number; [key: string]: unknown };
  description?: string;
  [key: string]: unknown;
}

interface ModelListResponse {
  data: FriendliModelEntry[];
}

/** Parse one raw `/v1/models` entry; exported for tests. Only fields Friendli
 * actually sent survive — everything else stays undefined, so adapters only
 * ever write metadata that was really reported. */
export function toFriendliModel(entry: FriendliModelEntry): FriendliModel {
  const effortOption = entry.reasoning_options?.find(
    (option) => option.type === "effort",
  );
  const hasToggle =
    entry.reasoning_options?.some((option) => option.type === "toggle") ??
    false;
  const input = pricePerMillion(entry.pricing?.input ?? entry.pricing?.prompt);
  const output = pricePerMillion(
    entry.pricing?.output ?? entry.pricing?.completion,
  );
  const cacheRead = pricePerMillion(entry.pricing?.input_cache_read);
  return {
    id: entry.id,
    label: entry.name ?? entry.id,
    ...(entry.context_length !== undefined
      ? { contextLength: entry.context_length }
      : {}),
    ...(entry.max_completion_tokens !== undefined
      ? { maxCompletionTokens: entry.max_completion_tokens }
      : {}),
    ...(entry.reasoning !== undefined ? { reasoning: entry.reasoning } : {}),
    ...(effortOption?.values !== undefined
      ? { reasoningEffortLevels: effortOption.values }
      : {}),
    ...(hasToggle ? { reasoningToggle: true } : {}),
    ...(input !== undefined || output !== undefined || cacheRead !== undefined
      ? {
          pricing: {
            ...(input !== undefined ? { input } : {}),
            ...(output !== undefined ? { output } : {}),
            ...(cacheRead !== undefined ? { cacheRead } : {}),
          },
        }
      : {}),
    ...(entry.functionality?.tool_call !== undefined
      ? { toolCall: entry.functionality.tool_call }
      : {}),
    ...(entry.input_modalities !== undefined
      ? { inputModalities: entry.input_modalities }
      : {}),
    ...(entry.output_modalities !== undefined
      ? { outputModalities: entry.output_modalities }
      : {}),
    ...(typeof entry.interleaved === "string"
      ? { interleaved: entry.interleaved }
      : {}),
    // A temperature default means the parameter is accepted.
    ...(entry.default_params !== undefined &&
    "temperature" in entry.default_params
      ? { temperature: true }
      : {}),
    ...(entry.description !== undefined
      ? { description: entry.description }
      : {}),
  };
}

/** Fetch the list of models available for the onboarding wizard's slot pickers. */
export async function fetchFriendliModelCatalog(
  apiKey: string,
  baseUrl: string = FRIENDLI_BASE_URL,
): Promise<FriendliModel[]> {
  const response = await fetch(friendliApiUrl("models", baseUrl), {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    throw new Error(
      `FriendliAI model catalog request failed: HTTP ${response.status}`,
    );
  }
  const payload = (await response.json()) as ModelListResponse;
  return (payload.data ?? []).map(toFriendliModel);
}
