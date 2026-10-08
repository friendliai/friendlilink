/**
 * Serialize harness messages into Friendli chat completions (OpenAI-compatible).
 * User text and images become ordered OpenAI content parts; text-only messages
 * remain strings. Assistant text becomes `content`, tool calls become
 * `tool_calls`, and tool results become separate `role:'tool'` messages.
 * Assistant reasoning is replayed as `reasoning_content` only on tool-call
 * turns. Image bytes are resolved by the attachment service before serialization.
 *
 * @module @friendliai/dsh-llm-friendli/serialize
 */

import { LlmError, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import type {
  AssistantMessage,
  ContentBlock,
  GenerateOptions,
  RequestMessage,
} from "@deepseek-ai/dsh-llm";
import type {
  WireContentPart,
  WireMessage,
  WireRequest,
  WireTool,
} from "./types.ts";

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

/** Keep text-only requests compact; interleave image parts in their original order. */
function userContent(
  blocks: readonly ContentBlock[],
  imageUrls?: ReadonlyMap<ContentBlock, string>,
): string | WireContentPart[] {
  let text = "";
  let parts: WireContentPart[] | undefined;
  for (const block of blocks) {
    if (block.type === "text") text += block.text;
    else if (block.type === "image") {
      const url = imageUrls?.get(block);
      if (url === undefined)
        throw new LlmError(
          "The Friendli adapter cannot serialize an image without verified attachment bytes.",
          "UNSUPPORTED_CONTENT",
        );
      parts ??= [];
      if (text) parts.push({ type: "text", text });
      text = "";
      parts.push({ type: "image_url", image_url: { url } });
    } else {
      throw new LlmError(
        `The Friendli chat-completions adapter cannot serialize ${block.type} in text content.`,
        "UNSUPPORTED_CONTENT",
      );
    }
  }
  if (parts === undefined) return text;
  if (text) parts.push({ type: "text", text });
  return parts;
}

/** Serialize one assistant message (text + reasoning + tool calls). */
function serializeAssistant(message: AssistantMessage): WireMessage {
  let text = "";
  let reasoning = "";
  const toolCalls: NonNullable<
    Extract<WireMessage, { role: "assistant" }>["tool_calls"]
  > = [];
  for (const block of message.content) {
    if (block.type === "text") text += block.text;
    else if (block.type === "reasoning") reasoning += block.text;
    else if (block.type === "tool-call") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: block.arguments },
      });
    } else {
      throw new LlmError(
        `The Friendli chat-completions adapter cannot serialize ${block.type} in assistant content.`,
        "UNSUPPORTED_CONTENT",
      );
    }
  }
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
 * Serialize ordered request history, including one-shot user inputs and
 * first-class tool-role results. This route does not advertise in-history tool
 * updates; developer messages must not be turned into user instructions.
 * @param messages - the harness request history, in order.
 * @returns the wire messages; order preserved.
 */
export function serializeMessages(
  messages: readonly RequestMessage[],
  imageUrls?: ReadonlyMap<ContentBlock, string>,
): WireMessage[] {
  const wire: WireMessage[] = [];
  for (const message of messages) {
    if (message.role === "developer") {
      throw new LlmError(
        "The Friendli chat-completions adapter does not support developer messages or in-history tool updates.",
        "UNSUPPORTED_TOOL_UPDATE",
      );
    }
    if (message.role === "assistant") {
      wire.push(serializeAssistant(message));
    } else if (message.role === "tool") {
      wire.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        content: userContent(message.content, imageUrls),
      });
    } else {
      wire.push({
        role: message.role,
        content: userContent(message.content, imageUrls),
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
  imageUrls?: ReadonlyMap<ContentBlock, string>,
): WireRequest {
  const messages: WireMessage[] = [];
  if (options.system !== undefined) {
    messages.push({ role: "system", content: options.system });
  }
  messages.push(...serializeMessages(options.messages, imageUrls));

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
