/**
 * Serialize harness messages into Friendli chat completions (OpenAI-compatible).
 * User text is joined; assistant text becomes `content`, tool calls become
 * `tool_calls`, and tool results become separate `role:'tool'` messages.
 * Assistant reasoning is replayed as `reasoning_content` only on tool-call
 * turns. Image content is rejected explicitly because this wire route is
 * text-only.
 *
 * @module @friendliai/dsh-llm-friendli/serialize
 */

import {
  contentHasImage,
  LlmError,
  ReasoningEffortId,
} from "@deepseek-ai/dsh-llm";
import type {
  ContentBlock,
  GenerateOptions,
  Message,
} from "@deepseek-ai/dsh-llm";
import type { WireMessage, WireRequest, WireTool } from "./types.ts";

/**
 * Normalize an upstream JSON Schema for Friendli: its validator rejects any
 * `oneOf` with multiple branches (dsh emits `oneOf: [{type:'string'}, {type:'null'}]`
 * for optional tool parameters). Unwrap multi-branch oneOf to its first
 * non-null branch (description kept), recursively. ponytail: first branch wins
 * on genuinely ambiguous unions; revisit only if a tool needs it.
 */
function friendliSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(friendliSchema);
  if (typeof schema !== "object" || schema === null) return schema;
  const node = schema as Record<string, unknown>;
  if (Array.isArray(node["oneOf"]) && (node["oneOf"] as unknown[]).length > 1) {
    const branches = node["oneOf"] as Record<string, unknown>[];
    const pick =
      branches.find(
        (b) => !(typeof b === "object" && b !== null && b["type"] === "null"),
      ) ?? (branches[0] as Record<string, unknown>); // all-null oneOf: keep desc, treat as string
    return friendliSchema({
      ...pick,
      description:
        node["description"] ?? (pick as Record<string, unknown>)["description"],
    });
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node))
    out[key] = friendliSchema(value);
  return out;
}

/**
 * Reserved effort ids mapping to Friendli's on/off `enable_thinking` switch.
 * Named effort levels (e.g. `high`, `max`) are sent verbatim as `reasoning_effort`.
 */
export const OFF_EFFORT = ReasoningEffortId("off");
export const ON_EFFORT = ReasoningEffortId("on");

/** Adapter-level request defaults resolved from plugin config. */
export interface RequestDefaults {
  /**
   * Fallback reasoning stance used only when a request carries no
   * `reasoningEffort`: `enabled` sends `chat_template_kwargs.enable_thinking=true`,
   * `disabled` sends `false`. Undefined leaves the model's own default in place.
   */
  thinking?: "enabled" | "disabled" | undefined;
}

/** Join the text blocks of a message (user/tool-result content). */
function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/** Reject image content before any text-flattening path can silently drop it. */
function assertTextOnly(blocks: readonly ContentBlock[]): void {
  if (contentHasImage(blocks)) {
    throw new LlmError(
      "The Friendli chat-completions adapter does not support image content.",
      "UNSUPPORTED_CONTENT",
    );
  }
}

/** Serialize one assistant message (text + reasoning + tool calls). */
function serializeAssistant(message: Message): WireMessage {
  const text = flattenText(message.content);
  const reasoning = message.content
    .filter((block) => block.type === "reasoning")
    .map((block) => block.text)
    .join("");
  const toolCalls = message.content
    .filter((block) => block.type === "tool-call")
    .map((block) => ({
      id: block.id,
      type: "function" as const,
      function: { name: block.name, arguments: block.arguments },
    }));

  return {
    role: "assistant",
    // Text-less turns send "" — never null; some gateways reject null content.
    content: text,
    // Replay CoT only on tool-call turns (ignored on plain turns; drop to save tokens).
    ...(toolCalls.length > 0 && reasoning.length > 0
      ? { reasoning_content: reasoning }
      : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

/**
 * Serialize the conversation. `tool-result` blocks become standalone
 * `{role:'tool'}` messages; a mixed user message contributes its text first
 * and its tool results as separate wire messages after.
 * @param messages - the harness conversation, in order.
 * @returns the wire messages; order preserved.
 */
export function serializeMessages(messages: readonly Message[]): WireMessage[] {
  const wire: WireMessage[] = [];
  for (const message of messages) {
    assertTextOnly(message.content);
    if (message.role === "system") {
      wire.push({ role: "system", content: flattenText(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      wire.push(serializeAssistant(message));
      continue;
    }
    const toolResults = message.content.filter(
      (block) => block.type === "tool-result",
    );
    const text = flattenText(message.content);
    if (text.length > 0 || toolResults.length === 0) {
      wire.push({ role: "user", content: text });
    }
    for (const result of toolResults) {
      wire.push({
        role: "tool",
        tool_call_id: result.toolCallId,
        content: flattenText(result.content) || "(no output)",
      });
    }
  }
  return wire;
}

/**
 * Resolve the reasoning stance for one request. `parse_reasoning` +
 * `include_reasoning` always split reasoning tokens into `reasoning_content` so
 * the translator gets a clean channel. The on/off vs. effort-level decision
 * comes from the caller's selected effort, falling back to the adapter default:
 *
 * - `off` → `reasoning_budget: 0` + `chat_template_kwargs.enable_thinking=false`
 *   (reasoning suppressed). `enable_thinking=false` alone does not reliably
 *   suppress reasoning — see the hermes-friendli-provider plugin docstring,
 *   which live-verified that GLM-5.3 still leaks `<think>` markers with only
 *   the toggle set to false. `reasoning_budget: 0` is the switch that actually
 *   works on every catalog model.
 * - `on` → `enable_thinking=true` (thinking on, provider picks the depth).
 * - a named level (`high`, `max`, …) → `reasoning_effort` sent verbatim; Friendli
 *   honors it directly, so no `enable_thinking` is needed.
 * - no effort → the adapter's `thinking` default gates `enable_thinking`.
 *
 * A `session-title` call always wants visible text, never a thinking budget.
 */
function resolveReasoning(
  options: GenerateOptions,
  defaults: RequestDefaults,
): Pick<
  WireRequest,
  | "chat_template_kwargs"
  | "parse_reasoning"
  | "include_reasoning"
  | "reasoning_effort"
  | "reasoning_budget"
> {
  const split = { parse_reasoning: true, include_reasoning: true } as const;
  if (options.purpose === "session-title") {
    return { ...split, chat_template_kwargs: { enable_thinking: false } };
  }
  const effort = options.reasoningEffort;
  if (effort === OFF_EFFORT)
    return {
      ...split,
      reasoning_budget: 0,
      chat_template_kwargs: { enable_thinking: false },
    };
  if (effort === ON_EFFORT)
    return { ...split, chat_template_kwargs: { enable_thinking: true } };
  if (effort !== undefined) return { ...split, reasoning_effort: effort };
  // No per-request effort: fall back to the adapter-level thinking default.
  return {
    ...split,
    ...(defaults.thinking !== undefined
      ? {
          chat_template_kwargs: {
            enable_thinking: defaults.thinking === "enabled",
          },
        }
      : {}),
  };
}

/**
 * Build the full wire request. Always streaming with usage reporting; optional
 * fields are omitted rather than sent as null so provider defaults apply.
 * @param options - the harness request (model, history, system, tools, sampling).
 * @param defaults - adapter-level reasoning defaults.
 * @returns the chat-completions request body.
 */
export function serializeRequest(
  options: GenerateOptions,
  defaults: RequestDefaults = {},
): WireRequest {
  const messages: WireMessage[] = [];
  if (options.system !== undefined) {
    messages.push({ role: "system", content: options.system });
  }
  messages.push(...serializeMessages(options.messages));

  const tools: WireTool[] | undefined = options.tools?.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: friendliSchema(tool.parameters) as Record<string, unknown>,
    },
  }));

  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...resolveReasoning(options, defaults),
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(options.temperature !== undefined
      ? { temperature: options.temperature }
      : {}),
    ...(options.maxTokens === undefined
      ? {}
      : { max_tokens: options.maxTokens }),
    ...(options.stop !== undefined ? { stop: options.stop } : {}),
  };
}
