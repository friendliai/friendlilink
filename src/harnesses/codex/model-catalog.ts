import { runCommand } from "../../system/exec.js";
import type { FriendliModel } from "../../friendli/model-catalog.js";

/**
 * Teaching Codex about Friendli's models.
 *
 * Codex's `/model` picker reads one catalog, and by default that catalog holds
 * only Codex's own bundled models — a Friendli model never appears in it, and
 * running one draws `Model metadata for '…' not found. Defaulting to fallback
 * metadata`. There is no config key that ADDS a model to that list, but there
 * is one that REPLACES it: root `model_catalog_json`, a path to a JSON catalog.
 * Point it at a catalog built from `GET /v1/models` and the picker offers
 * exactly Friendli's models, with reasoning rows that follow what each
 * model's controls allow (`reasoningLevels()` has the shapes).
 *
 * Everything here is derived from the live catalog; there is no model list.
 *
 * Two things about the format, both learned the hard way against codex 0.153
 * (it is Codex's private schema, validated strictly, and undocumented):
 *
 *  - Entries are built field by field rather than cloned from one of Codex's
 *    own. Cloning looks tempting — it is how the instructions get filled in —
 *    but it carries whatever capabilities that model has, and the newest one
 *    turns on a multi-agent tool that Friendli rejects with
 *    `422 unsupported input item type: additional_tools`.
 *  - `apply_patch_tool_type` is deliberately absent. Set to Codex's usual
 *    "freeform" it sends a grammar-constrained custom tool, and Friendli
 *    answers `422 invalid tools: custom.format type grammar is not supported`.
 *    Omitting it keeps apply_patch off and the agent loop working.
 *
 * `base_instructions` is the one field with no sensible value of our own: it
 * is Codex's coding-agent system prompt. It is copied from whichever model
 * Codex itself would have used, so behaviour is unchanged from running a
 * Friendli model on fallback metadata today.
 */

/** The fields codex 0.153 requires of every catalog entry, plus the optional
 * ones worth filling in. Codex rejects the file outright on a missing
 * required field, so this shape is not advisory. */
export interface CodexModelEntry {
  slug: string;
  display_name: string;
  description?: string;
  supported_reasoning_levels: Array<{ effort: string; description: string }>;
  default_reasoning_level?: string;
  shell_type: string;
  visibility: string;
  supported_in_api: boolean;
  priority: number;
  support_verbosity: boolean;
  truncation_policy: unknown;
  experimental_supported_tools: unknown[];
  base_instructions: string;
  context_window?: number;
  max_context_window?: number;
}

/** What we borrow from Codex's own catalog: the coding-agent prompt, and the
 * two shape fields it is tuned alongside. */
export interface CodexCatalogTemplate {
  base_instructions: string;
  shell_type: string;
  truncation_policy: unknown;
}

interface RawCodexEntry {
  slug?: string;
  priority?: number;
  visibility?: string;
  shell_type?: string;
  truncation_policy?: unknown;
  base_instructions?: string;
}

/**
 * The template, read from Codex's own bundled catalog — the entry Codex would
 * pick by default. Undefined when Codex is not installed, its catalog cannot
 * be read, or the entry carries no instructions; the caller then writes no
 * catalog at all and leaves Codex on its fallback metadata.
 */
export async function readCodexCatalogTemplate(): Promise<
  CodexCatalogTemplate | undefined
> {
  try {
    const result = await runCommand("codex", ["debug", "models"], {
      timeoutMs: 20_000,
    });
    if (!result.ok) {
      return undefined;
    }
    const parsed = JSON.parse(result.stdout) as { models?: RawCodexEntry[] };
    const listed = (parsed.models ?? [])
      .filter((model) => model.slug && model.visibility === "list")
      .sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity));
    const best = listed[0];
    if (!best?.base_instructions || !best.shell_type) {
      return undefined;
    }
    return {
      base_instructions: best.base_instructions,
      shell_type: best.shell_type,
      truncation_policy: best.truncation_policy ?? {
        mode: "tokens",
        limit: 10_000,
      },
    };
  } catch {
    return undefined;
  }
}

/** The reasoning level a model starts at: its strongest advertised rung. */
function defaultLevel(levels: string[]): string | undefined {
  return levels.length > 0 ? levels[levels.length - 1] : undefined;
}

/**
 * The off row, offered exactly where `codex on --reasoning off` works:
 * picking it writes the same `model_reasoning_effort = "none"` the flag
 * does, arriving as `reasoning.effort: "none"`. Toggle models only:
 * live-tested 2026-09-10, on them reasoning stops cleanly (GLM-5.2: 59
 * output tokens with, 2 without), while GLM-5.3 spills its chain-of-thought
 * into the answer and MiniMax burns reasoning tokens silently. Rides last,
 * because codex remaps `ultra` to the first row it does not know; the
 * one-lever story is in `reasoning.ts`.
 */
const REASONING_OFF_LEVEL = {
  effort: "none",
  description: "Turn thinking off",
} as const;

/**
 * The on row where reasoning has no effort dial: a toggle without efforts
 * (GLM-5.1, gemma-4, DeepSeek-V3.2), or an always-on reasoner with no
 * controls at all (MiniMax-M2.5). Picking it sends `reasoning.effort:
 * "medium"`, live-tested 2026-09-10 to be a no-op on all of them; the row
 * exists to show "on", and a model the catalog says cannot reason gets none.
 */
const REASONING_ON_LEVEL = {
  effort: "medium",
  description: "Reasoning on (model default)",
} as const;

/**
 * One model's picker rows, following its reasoning controls:
 *
 * - advertised efforts verbatim, plus the off level a toggle proves;
 * - a toggle with no efforts: the on row, then the off level;
 * - always-reasoning with neither: the on row alone, since it cannot be
 *   switched off;
 * - cannot reason: nothing.
 */
function reasoningLevels(
  model: Pick<
    FriendliModel,
    "reasoning" | "reasoningEffortLevels" | "reasoningToggle"
  >,
): Array<{ effort: string; description: string }> {
  const efforts = model.reasoningEffortLevels ?? [];
  if (efforts.length > 0) {
    return [
      ...efforts.map((effort) => ({
        effort,
        description: `Friendli ${effort} reasoning`,
      })),
      ...(model.reasoningToggle === true ? [REASONING_OFF_LEVEL] : []),
    ];
  }
  if (model.reasoningToggle === true) {
    return [REASONING_ON_LEVEL, REASONING_OFF_LEVEL];
  }
  return model.reasoning === true ? [REASONING_ON_LEVEL] : [];
}

/**
 * One Codex catalog from Friendli's live model list.
 *
 * Rows come from `reasoningLevels()`. Only an advertised effort can become
 * a default, so `none` and `medium` never do, and a model with no advertised
 * efforts keeps its own default: Codex sends no `reasoning.effort` for it.
 */
export function buildCodexCatalog(
  models: FriendliModel[],
  template: CodexCatalogTemplate,
): { models: CodexModelEntry[] } {
  return {
    models: models.map((model, index) => {
      const efforts = model.reasoningEffortLevels ?? [];
      const fallback = defaultLevel(efforts);
      return {
        slug: model.id,
        display_name: model.label,
        ...(model.description ? { description: model.description } : {}),
        supported_reasoning_levels: reasoningLevels(model),
        ...(fallback ? { default_reasoning_level: fallback } : {}),
        shell_type: template.shell_type,
        visibility: "list",
        supported_in_api: true,
        // Keeps the picker in Friendli's own catalog order.
        priority: index + 1,
        // Friendli's Responses API documents no verbosity control.
        support_verbosity: false,
        truncation_policy: template.truncation_policy,
        experimental_supported_tools: [],
        base_instructions: template.base_instructions,
        ...(model.contextLength
          ? {
              context_window: model.contextLength,
              max_context_window: model.contextLength,
            }
          : {}),
      };
    }),
  };
}
