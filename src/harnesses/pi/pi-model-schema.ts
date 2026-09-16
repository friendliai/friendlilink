/**
 * Pi's custom-provider model schema, transcribed from the harness's own
 * documentation (earendil-works/pi, packages/coding-agent/docs/
 * custom-provider.md — "Model Definition Reference") so frlink
 * can emit models.json entries without a build-time dependency on the
 * pi-ai package.
 *
 * Only the subset frlink writes is reproduced here, with the
 * doc's literal union types: drifting from the doc is a deliberate edit
 * against this file, reviewed in diff, not a silent type mismatch.
 *
 * Source of truth (main at transcription time):
 * https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/custom-provider.md#model-definition-reference
 */

/** Pi's /thinking levels, exactly as its ProviderModelConfig.thinkingLevelMap
 * keys them. "off" is Pi's own off-switch; the rest are reasoning efforts. */
export type PiThinkingLevel =
  "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Maps pi thinking levels to provider/model-specific values; null marks a
 * level unsupported. */
export type PiThinkingLevelMap = Partial<
  Record<PiThinkingLevel, string | null>
>;

/** The $var placeholders Pi's ChatTemplateKwargVariableSchema resolves per
 * request; the requested kwarg is dropped at "off". */
export type PiChatTemplateVar =
  "thinking.enabled" | "thinking.effort" | "thinking.budget";

export interface PiChatTemplateKwargValue {
  $var: PiChatTemplateVar;
  omitWhenOff?: boolean;
}

export interface PiCompat {
  supportsDeveloperRole?: boolean;
  thinkingFormat?:
    | "openai"
    | "openrouter"
    | "deepseek"
    | "together"
    | "baseten"
    | "zai"
    | "qwen"
    | "chat-template"
    | "qwen-chat-template"
    | "string-thinking"
    | "ant-ling";
  chatTemplateKwargs?: Record<
    string,
    string | number | boolean | null | PiChatTemplateKwargValue
  >;
}
