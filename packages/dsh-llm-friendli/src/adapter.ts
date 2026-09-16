/**
 * `FriendliAdapter`: fetch + SSE against the FriendliAI serverless
 * (OpenAI-compatible) chat-completions endpoint, emitting harness StreamChunks.
 * The catalog comes from `GET /models` at runtime — Friendli's own listing is
 * the authoritative source for ids, context windows, output caps, and reasoning
 * capability, so nothing here is hand-maintained.
 *
 * @module @friendliai/dsh-llm-friendli/adapter
 */

import {
  attributionHeaders,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
} from "@deepseek-ai/dsh-llm";
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmModelReasoningInfo,
  LlmProviderInfo,
  LlmReasoningEffortInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { fetchModels } from "./models.ts";
import type { FriendliModel } from "./models.ts";
import { serializeRequest } from "./serialize.ts";
import type { RequestDefaults } from "./serialize.ts";
import { parseSse } from "./sse.ts";
import { translate } from "./translate.ts";
import type { WireError } from "./types.ts";

/** Public FriendliAI serverless endpoint base. */
export const PUBLIC_BASE_URL = "https://api.friendli.ai/serverless/v1";

/** Validated connection facts for one operation, resolved by the plugin per request. */
export interface FriendliConnectionOptions {
  /** Endpoint base; `/chat/completions` and `/models` are appended. */
  baseURL: string;
  /** Adapter-level reasoning defaults applied to every call. */
  defaults: RequestDefaults;
  /** Time-to-live for the cached model catalog, in milliseconds. */
  modelCacheTtlMs: number;
  /** Static extra headers merged into every request (after attribution). */
  extraHeaders: Readonly<Record<string, string>>;
}

/** Operation-local resolution hooks the plugin owns. */
export interface FriendliAdapterOptions {
  /** Current validated connection facts; called once per operation. */
  options: () => FriendliConnectionOptions;
  /**
   * Resolve the bearer token for one request. Throws `LlmError`
   * `MISSING_CREDENTIAL` when no key is available.
   */
  resolveApiKey: () => Promise<string>;
  /**
   * Resolve a token for discovery/listing. May return `undefined`: `GET /models`
   * is public, so listing degrades to the unauthenticated catalog rather than
   * failing when no key is configured.
   */
  resolveDiscoveryKey?: () => Promise<string | undefined>;
}

const OFF = ReasoningEffortId("off");
const ON = ReasoningEffortId("on");

/**
 * Build the selectable reasoning efforts from a model's advertised capabilities.
 * A `toggle` capability contributes the on/off pair; an `effort` capability
 * contributes each named level (`high`, `max`, …) as its own selectable id —
 * these ride the wire verbatim as `reasoning_effort`, which Friendli honors.
 * Returns `undefined` when the model advertises no controllable reasoning, so
 * always-reasoning models expose no selector.
 */
function reasoningInfo(
  model: FriendliModel,
): LlmModelReasoningInfo | undefined {
  if (!model.reasoning) return undefined;
  const efforts: LlmReasoningEffortInfo[] = [];
  const seen = new Set<string>();
  const push = (id: string, name: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    efforts.push({ id: ReasoningEffortId(id), name });
  };
  for (const option of model.reasoningOptions) {
    if (option.type === "toggle") {
      push(OFF, "Off");
      push(ON, "On");
    } else if (option.type === "effort") {
      for (const value of option.values ?? []) push(value, value);
    }
  }
  if (efforts.length === 0) return undefined;
  // Prefer an explicit on/off default; otherwise the first advertised level.
  const defaultEffort = seen.has(ON) ? ON : efforts[0]!.id;
  return { efforts, defaultEffort };
}

/** Map an HTTP status to a stable LlmError code. */
export function httpErrorCode(status: number): string {
  if (status === 401) return "AUTH";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "MODEL_NOT_FOUND";
  if (status === 429) return "RATE_LIMIT";
  if (status === 400) return "INVALID_REQUEST";
  if (status >= 500) return "SERVER";
  return `HTTP_${status}`;
}

/** Advisory `LlmModelInfo` for one normalized model. */
function modelInfo(provider: string, model: FriendliModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name,
    inputModalities: ["text"],
  };
}

/**
 * The Friendli adapter. One instance serves every provider route it is
 * registered under; the harness model name IS the Friendli wire model id.
 */
export class FriendliAdapter extends LlmAdapter {
  private cache?: { at: number; models: readonly FriendliModel[] };

  constructor(private readonly config: FriendliAdapterOptions) {
    super();
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: "FriendliAI" };
  }

  /** Fetch the catalog, honoring a short TTL cache so selectors don't refetch per keystroke. */
  private async models(
    signal?: AbortSignal,
  ): Promise<readonly FriendliModel[]> {
    const { baseURL, modelCacheTtlMs } = this.config.options();
    const now = Date.now();
    if (this.cache !== undefined && now - this.cache.at < modelCacheTtlMs)
      return this.cache.models;
    const key = await (this.config.resolveDiscoveryKey?.() ??
      Promise.resolve(undefined));
    const models = await fetchModels(
      baseURL,
      key,
      signal,
      this.config.options().extraHeaders,
    );
    this.cache = { at: now, models };
    return models;
  }

  override async listModels(
    provider: string,
  ): Promise<readonly LlmModelInfo[]> {
    const models = await this.models();
    return models.map((model) => modelInfo(provider, model));
  }

  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const found = (await this.models(signal)).find(
      (entry) => entry.id === model,
    );
    const base: LlmResolvedModelInfo =
      found === undefined
        ? { provider, id: model, name: model, inputModalities: ["text"] }
        : modelInfo(provider, found);
    return {
      ...base,
      ...(found?.contextWindow === undefined
        ? {}
        : { context: { contextWindow: found.contextWindow } }),
      // The catalog's `max_completion_tokens` is the model's output CAPACITY
      // (often == context_length), not a per-request cap. Advertising it as
      // `defaultMaxTokens` makes the harness send max_tokens == the full
      // context window, so prompt + max_tokens > context_length and Friendli
      // rejects every request ("maximum context length ... requested N output
      // tokens"). Omit it and the provider's own output default applies;
      // explicit request-level maxTokens still wins.
      // Advertise exactly the reasoning controls the listing shows: a `toggle`
      // capability yields off/on; an `effort` capability yields each named level
      // (e.g. high, max). Named levels ride the wire as `reasoning_effort`, which
      // Friendli honors directly. Reasoning stays adapter-authoritative — never a
      // core enum — and always-reasoning models expose no selector.
      ...(found === undefined
        ? {}
        : ((info) => (info === undefined ? {} : { reasoning: info }))(
            reasoningInfo(found),
          )),
    };
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const connection = this.config.options();
    const apiKey = await this.config.resolveApiKey();
    const consumer = new AbortController();
    const upstream =
      options.signal === undefined
        ? consumer.signal
        : AbortSignal.any([options.signal, consumer.signal]);

    const body = serializeRequest(options, connection.defaults);
    const payload = JSON.stringify(body);
    const headers = {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "text/event-stream",
      ...attributionHeaders(),
      ...connection.extraHeaders,
    };

    let response: Response;
    try {
      response = await fetch(`${connection.baseURL}/chat/completions`, {
        method: "POST",
        headers,
        body: payload,
        signal: upstream,
      });
    } catch (error: unknown) {
      if (options.signal?.aborted)
        throw new LlmError("Friendli request aborted by caller", "ABORTED", {
          cause: error,
        });
      throw new LlmError(
        `Friendli API request to ${connection.baseURL} failed`,
        "TRANSPORT",
        { cause: error },
      );
    }

    if (!response.ok) {
      let message = `Friendli API error (HTTP ${response.status})`;
      try {
        const parsed = (await response.json()) as WireError;
        if (parsed.error?.message) message = parsed.error.message;
      } catch {
        // Keep the status-based message when the error body is not JSON.
      }
      throw new LlmError(message, httpErrorCode(response.status), {
        status: response.status,
      });
    }
    if (!response.body) {
      throw new LlmError(
        "Friendli API returned no response body",
        "EMPTY_RESPONSE",
      );
    }

    try {
      yield* translate(parseSse(response.body));
    } catch (error: unknown) {
      if (options.signal?.aborted)
        throw new LlmError("Friendli request aborted by caller", "ABORTED", {
          cause: error,
        });
      if (error instanceof LlmError) throw error;
      throw new LlmError(
        `Friendli API stream from ${connection.baseURL} failed`,
        "TRANSPORT",
        { cause: error },
      );
    } finally {
      consumer.abort("Friendli stream consumer stopped");
    }
  }
}
