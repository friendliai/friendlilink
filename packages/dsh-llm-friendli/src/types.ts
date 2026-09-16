/**
 * FriendliAI serverless chat-completions wire format (OpenAI-compatible) and
 * the `/models` listing shape. Types only.
 *
 * Grounded in live responses from `https://api.friendli.ai/serverless/v1`
 * (models + chat/completions) and the reasoning guide
 * (https://friendli.ai/docs/guides/reasoning), 2026-08.
 *
 * @module @friendliai/dsh-llm-friendli/types
 */

/** Request body for `POST {baseURL}/chat/completions`. Always streaming. */
export interface WireRequest {
  model: string;
  messages: WireMessage[];
  stream: true;
  stream_options: { include_usage: true };
  tools?: WireTool[];
  temperature?: number;
  max_tokens?: number;
  stop?: string[];
  /**
   * Controllable-reasoning toggle. Friendli reads `enable_thinking` from
   * `chat_template_kwargs`, NOT a top-level field. Absent for always-reasoning
   * models (they think regardless).
   */
  chat_template_kwargs?: { enable_thinking?: boolean };
  /** Split reasoning tokens into `reasoning_content` instead of inlining `<think>`. */
  parse_reasoning?: boolean;
  /** Emit the parsed reasoning content (still billed either way). */
  include_reasoning?: boolean;
  /** OpenAI-style effort, sent only when the model's `/models` entry advertises the value. */
  reasoning_effort?: string;
  /**
   * Top-level integer capping internal reasoning-token usage. Sent as `0` to
   * reliably suppress reasoning (the `enable_thinking=false` toggle alone does
   * not work on every model — see the hermes-friendli-provider plugin docstring
   * for live-verified details).
   */
  reasoning_budget?: number;
}

/** System/user/tool message: a single content string. */
export interface WireTextMessage {
  role: "system" | "user";
  content: string;
}

/** Tool-result message, keyed by the originating call id. */
export interface WireToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

/** Assistant history message; `content` is `""` (never null) on tool-only turns. */
export interface WireAssistantMessage {
  role: "assistant";
  content: string;
  /** CoT passback replayed on tool-call turns; omitted otherwise to save tokens. */
  reasoning_content?: string;
  tool_calls?: WireToolCall[];
}

/** One entry of the request `messages` array, discriminated on `role`. */
export type WireMessage =
  WireTextMessage | WireAssistantMessage | WireToolMessage;

/** A completed tool call replayed on assistant history; `arguments` is a raw JSON string. */
export interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** One entry of the request `tools` array; `parameters` is a JSON Schema object. */
export interface WireTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** One parsed SSE `data:` payload (a chat.completion.chunk). */
export interface WireChunk {
  choices?: WireChoice[];
  usage?: WireUsage | null;
}

/** One streamed choice; `finish_reason` is non-null only on the terminal chunk. */
export interface WireChoice {
  delta?: WireDelta;
  finish_reason?: string | null;
}

/** Incremental content of one streamed choice; any subset of fields per chunk. */
export interface WireDelta {
  role?: string;
  content?: string | null;
  /** Reasoning tokens, streamed separately when `parse_reasoning` + `include_reasoning`. */
  reasoning_content?: string | null;
  tool_calls?: WireToolCallDelta[];
}

/** A streamed fragment of one tool call; fragments sharing `index` concatenate. */
export interface WireToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

/** Wire token accounting (OpenAI-compatible; cache hits reported under `prompt_tokens_details`). */
export interface WireUsage {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

/** Non-2xx error body. */
export interface WireError {
  error?: { message?: string; type?: string; code?: string };
}

/**
 * One raw entry of `GET /models`. Only the fields this adapter reads are
 * typed; everything is optional/unknown because a listing can drift.
 */
export interface WireModelEntry {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  max_completion_tokens?: unknown;
  /** Present only on models no longer active; such entries are dropped from the catalog. */
  deprecation_date?: unknown;
  reasoning?: unknown;
  /** Capability descriptors: `{type:'toggle'}`, `{type:'effort',values:[...]}`, `{type:'budget_tokens',...}`. */
  reasoning_options?: unknown;
}

/** `GET /models` response envelope. */
export interface WireModelList {
  data?: unknown;
}
