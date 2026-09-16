import * as clack from "@clack/prompts";
import {
  fetchFriendliModelCatalog,
  type FriendliModel,
} from "../../friendli/model-catalog.js";
import type { HarnessContext } from "../../harness/types.js";

/** Model used when the user didn't pick one — the FriendliAI docs'
 * reference model. */
export const DEFAULT_FRIENDLI_MODEL = "zai-org/GLM-5.2";

/**
 * Whether prompts are allowed in this session: only `--interactive` forces
 * them on, and `--json`/`--non-interactive` keep them off. Everything else
 * follows the actual TTY, like the Claude adapter has always done.
 */
export function interactiveSession(ctx: HarnessContext): boolean {
  return (
    ctx.onboardingMode === "prompt" ||
    (ctx.onboardingMode === "auto" &&
      !ctx.json &&
      Boolean(process.stdin.isTTY) &&
      Boolean(process.stdout.isTTY))
  );
}

export type ModelPick =
  | {
      model: string;
      cancelled: false;
      /** The catalog this pick was made from, so callers needing model metadata
       * do not fetch it a second time. Empty when it was never fetched. */
      catalog: FriendliModel[];
    }
  | { cancelled: true };

/**
 * Decide the main model for a single-model harness `on` flow: an explicit
 * `--model` wins; interactive sessions pick from Friendli's live catalog,
 * Falls back to the default model when the catalog can't be fetched or the
 * session isn't interactive.
 */
export async function pickMainModel(
  ctx: HarnessContext,
  options: { apiKey: string; baseUrl: string },
): Promise<ModelPick> {
  if (ctx.main) {
    return { model: ctx.main, cancelled: false, catalog: [] };
  }

  if (interactiveSession(ctx)) {
    let models: FriendliModel[] = [];
    try {
      models = await fetchFriendliModelCatalog(options.apiKey, options.baseUrl);
    } catch {
      // Offline/5xx — better to proceed with the default than to block here.
    }
    const pickerOptions = models.map((model) => ({
      value: model.id,
      label: model.label,
    }));
    if (pickerOptions.length > 0) {
      const choice = await clack.select({
        message: "FriendliAI model to route through:",
        options: pickerOptions,
      });
      if (clack.isCancel(choice)) {
        clack.cancel("Cancelled — nothing was changed.");
        return { cancelled: true };
      }
      return { model: choice as string, cancelled: false, catalog: models };
    }
    clack.log.warn(
      `FriendliAI's model catalog is unavailable; using ${DEFAULT_FRIENDLI_MODEL}.`,
    );
  }

  return { model: DEFAULT_FRIENDLI_MODEL, cancelled: false, catalog: [] };
}
