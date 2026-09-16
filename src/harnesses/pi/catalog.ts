import type { FriendliModel } from "../../friendli/model-catalog.js";
import type {
  PiCompat,
  PiThinkingLevel,
  PiThinkingLevelMap,
} from "./pi-model-schema.js";

/** The gateway only accepts DeepSeek-V3.2's enable_thinking toggle while
 * the system prompt travels as the `system` role: a `developer`-role
 * message (what Pi's detected compat default produces for reasoning
 * models) alongside an explicit `chat_template_kwargs.enable_thinking:
 * true` draws a 422 "Invalid Input". Either piece alone, or the same
 * request with `system`, is accepted — so these entries keep the system
 * prompt on the plain role. */
const NO_DEVELOPER_ROLE = new Set(["deepseek-ai/DeepSeek-V3.2"]);

/** Pi's /thinking levels minus "off" — every effort key its
 * ProviderModelConfig.thinkingLevelMap accepts (see pi-model-schema.ts,
 * transcribed from Pi's custom-provider docs). */
const NON_OFF_LEVELS: readonly Exclude<PiThinkingLevel, "off">[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Pi's own picker treats an explicit `null` in a model's
 * thinkingLevelMap as "excluded" for *any* level. That lets it mirror
 * Friendli's reasoning_options exactly instead of offering levels Friendli
 * never claimed to support: each level Friendli's "effort" option lists
 * gets mapped to itself (the value actually sent is unchanged), everything
 * else gets `null`.
 *
 * A model with no effort list at all — just a toggle, or nothing (GLM-5.1,
 * gemma, DeepSeek, MiniMax) — has no granularity to mirror, but Pi still
 * needs one non-off level to represent "reasoning is happening"; "medium"
 * is Pi's own global default, so that's the one level left unlocked.
 *
 * "off" is handled separately from the rest: it's excluded (`null`) for
 * models with no toggle — Friendli genuinely has no way to turn their
 * reasoning off, so Pi's picker shouldn't offer it — and left out of the
 * map entirely for toggle models, where it's already selectable by
 * default and mapping it to anything else risks the gap this file works
 * around elsewhere (a string value here would ride onto the wire as
 * reasoning_effort, which has no accepted off value). */
function thinkingLevelMapFor(
  effortLevels: string[] | undefined,
  hasToggle: boolean,
): PiThinkingLevelMap {
  const reported = new Set(effortLevels ?? []);
  const hasEffortList = reported.size > 0;
  const map: PiThinkingLevelMap = {};
  for (const level of NON_OFF_LEVELS) {
    map[level] = reported.has(level)
      ? level
      : !hasEffortList && level === "medium"
        ? level
        : null;
  }
  if (!hasToggle) {
    map.off = null;
  }
  return map;
}

export interface PiModelEntry {
  id: string;
  reasoning: boolean;
  compat?: PiCompat;
  thinkingLevelMap?: PiThinkingLevelMap;
}

/** One catalog model → one Pi models.json entry, calibrated straight off
 * Friendli's own `reasoning_options`: a `{type: "toggle"}` entry means
 * reasoning can be switched off; a `{type: "effort"}` entry lists the
 * levels the model actually understands.
 *
 * Models with no toggle need no `compat` at all — Pi's detected compat for
 * the Friendli base URL already passes the requested /thinking level
 * through untouched as `reasoning_effort`, and what a model's own chat
 * template does with it is the gateway's business (confirmed: Friendli
 * 200s `reasoning_effort` on models with no declared effort option too).
 *
 * Models with a toggle get the one exception Pi can't derive on its own:
 * the gateway's *off* switch is `chat_template_kwargs.enable_thinking`,
 * not `reasoning_effort` (which has no accepted off value). Their entry
 * renders `{enable_thinking: false}` for /thinking off. For any other
 * level, models that also list effort values (GLM-5.2) additionally carry
 * `reasoning_effort: <level>` in the same kwargs via Pi's first-class
 * thinking.enabled/thinking.effort vars (which drop that kwarg
 * automatically at off); models with a toggle but no effort list
 * (GLM-5.1, gemma, DeepSeek) omit the reasoning_effort kwarg entirely, so
 * picking Pi's single "on" representative level ("medium" — see
 * thinkingLevelMapFor) changes nothing but enable_thinking.
 *
 * Every reasoning-capable entry also gets a `thinkingLevelMap`, so Pi's
 * own /thinking picker shows exactly the levels Friendli lists for that
 * model (plus off, for toggle models) — not Pi's full generic range. The
 * system-prompt role pin for DeepSeek is the one thing left keyed off data
 * Friendli's catalog doesn't expose at all. */
export function buildPiModelEntry(
  model: Pick<
    FriendliModel,
    "id" | "reasoning" | "reasoningToggle" | "reasoningEffortLevels"
  >,
): PiModelEntry {
  const hasEffortLevels = (model.reasoningEffortLevels?.length ?? 0) > 0;
  const thinkingLevelMap = thinkingLevelMapFor(
    model.reasoningEffortLevels,
    Boolean(model.reasoningToggle),
  );
  if (model.reasoningToggle) {
    // The branch only runs for reasoning models, so switch models claim
    // reasoning even when the catalog hasn't flagged them.
    const chatTemplateKwargs: NonNullable<PiCompat["chatTemplateKwargs"]> = {
      enable_thinking: { $var: "thinking.enabled" },
    };
    if (hasEffortLevels) {
      chatTemplateKwargs.reasoning_effort = { $var: "thinking.effort" };
    }
    const compat: PiCompat = {
      thinkingFormat: "chat-template",
      chatTemplateKwargs,
    };
    if (NO_DEVELOPER_ROLE.has(model.id)) {
      compat.supportsDeveloperRole = false;
    }
    return {
      id: model.id,
      reasoning: true,
      compat,
      thinkingLevelMap,
    };
  }
  const reasoning = Boolean(model.reasoning);
  return {
    id: model.id,
    reasoning,
    ...(reasoning ? { thinkingLevelMap } : {}),
  };
}

export function buildPiCatalog(catalog: FriendliModel[]): PiModelEntry[] {
  return catalog.map((model) => buildPiModelEntry(model));
}
