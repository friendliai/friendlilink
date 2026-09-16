import path from "node:path";
import { runCommand } from "../../system/exec.js";
import { rootString } from "./toml-patch.js";

/**
 * Codex 0.153 profiles: `$CODEX_HOME/<name>.config.toml`, layered over the base
 * config by `codex --profile <name>`.
 *
 * They are the only way back to the user's own provider for a single run, and
 * the layering direction decides who owns which file. A profile is applied ON
 * TOP of config.toml, and the legacy root `profile = "..."` selector is gone —
 * the loader rejects it outright ("legacy `profile` config is no longer
 * supported; use `--profile <name>` with `<name>.config.toml` instead"), and so
 * does the config writer. So a profile cannot be made the default.
 *
 * That fixes the arrangement: Friendli stays in config.toml, where `codex` with
 * no flags picks it up, and the escape hatch is the profile. It also keeps
 * Codex's own writes safe — its TUI persists model picks to config.toml, which
 * frlink owns while on and restores on off. Putting Friendli in a
 * profile instead would silently shadow those picks.
 */

/** Codex rejects anything that is not a plain name: "invalid --profile value
 * `a/b`; pass a plain name such as `work`". */
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Used when the prior provider id is not usable as a profile name. */
export const FALLBACK_PROFILE_NAME = "before-friendli";

/** First line of every profile file we write — how `off` tells ours from a
 * file the user happened to have at the same path. */
export const PROFILE_SENTINEL = "# Written by frlink.";

export interface RestoreProfile {
  /** The provider Codex used before `on`; "openai" when config.toml named none. */
  modelProvider: string;
  /**
   * The model the profile pins. A profile layers *over* config.toml, and there
   * is no way to express "unset", so leaving this out would let the escape
   * hatch inherit the Friendli model `on` wrote at root and send it to OpenAI.
   * When config.toml named no model, Codex's own default is used instead.
   */
  model?: string;
  /** Same reasoning as `model`: `on` writes an effort tuned for a Friendli
   * model at root, and the hatch would otherwise inherit it. */
  reasoningEffort?: string;
}

/** One entry of `codex debug models`, Codex's own bundled model catalog. */
export interface CodexCatalogEntry {
  slug?: string;
  priority?: number;
  visibility?: string;
  default_reasoning_level?: string;
}

export interface CodexDefaults {
  model: string;
  reasoningEffort?: string;
}

/**
 * Pick what the hatch should pin out of Codex's own catalog.
 *
 * With a model named by the snapshot, the answer is that model and — the part
 * worth getting right — *that model's* default effort. Efforts are per-model
 * (gpt-5.6-sol defaults to low, gpt-5.5 to medium), so copying the effort off
 * Codex's top-priority model would quietly change the level the user was
 * running at. A model Codex does not know has no default to copy, so the hatch
 * pins the model alone rather than inventing one.
 *
 * With no model named, this is Codex's own default: the highest-priority model
 * it lists in the picker, and its effort.
 */
export function pickCodexDefaults(
  models: CodexCatalogEntry[],
  forModel?: string,
): CodexDefaults | undefined {
  if (forModel) {
    const named = models.find((model) => model.slug === forModel);
    return {
      model: forModel,
      ...(named?.default_reasoning_level
        ? { reasoningEffort: named.default_reasoning_level }
        : {}),
    };
  }
  const listed = models
    .filter((model) => model.slug && model.visibility === "list")
    .sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity));
  const best = listed[0];
  if (!best?.slug) {
    return undefined;
  }
  return {
    model: best.slug,
    ...(best.default_reasoning_level
      ? { reasoningEffort: best.default_reasoning_level }
      : {}),
  };
}

/**
 * What the hatch should pin, read from Codex's own catalog — offline, and the
 * same answer Codex itself would reach. Undefined when Codex is not installed
 * or the catalog cannot be read; the caller then writes no model and says so.
 */
export async function codexDefaults(
  forModel?: string,
): Promise<CodexDefaults | undefined> {
  try {
    const result = await runCommand("codex", ["debug", "models"], {
      timeoutMs: 20_000,
    });
    if (!result.ok) {
      return undefined;
    }
    const parsed = JSON.parse(result.stdout) as {
      models?: CodexCatalogEntry[];
    };
    return pickCodexDefaults(parsed.models ?? [], forModel);
  } catch {
    return undefined;
  }
}

/**
 * Derive the escape hatch from the pre-`on` snapshot rather than the live file.
 * By the time `off` runs — or a second `on` — the live config already says
 * `friendliai`, and a profile pointing back at Friendli would be useless.
 */
export function restoreProfileFromSnapshot(
  rawConfigToml: string,
  fallback?: { model: string; reasoningEffort?: string },
): RestoreProfile {
  const model = rootString(rawConfigToml, "model") ?? fallback?.model;
  const effort =
    rootString(rawConfigToml, "model_reasoning_effort") ??
    fallback?.reasoningEffort;
  return {
    modelProvider: rootString(rawConfigToml, "model_provider") ?? "openai",
    ...(model ? { model } : {}),
    ...(effort ? { reasoningEffort: effort } : {}),
  };
}

export function profileNameFor(restore: RestoreProfile): string {
  return PROFILE_NAME.test(restore.modelProvider)
    ? restore.modelProvider
    : FALLBACK_PROFILE_NAME;
}

export function profilePath(
  home: string,
  name: string,
  configOverride = "",
): string {
  const dir = configOverride
    ? path.dirname(configOverride)
    : path.join(home, ".codex");
  return path.join(dir, `${name}.config.toml`);
}

/** The whole file. frlink owns every byte of it. */
export function renderRestoreProfile(
  restore: RestoreProfile,
  name: string,
): string {
  const lines = [
    PROFILE_SENTINEL,
    "# Restores Codex to the provider it used before `frlink codex on`:",
    "#",
    `#     codex --profile ${name}`,
    "#",
    "# `frlink codex off` removes this file.",
    `model_provider = ${JSON.stringify(restore.modelProvider)}`,
  ];
  if (restore.model) {
    lines.push(`model = ${JSON.stringify(restore.model)}`);
  }
  if (restore.reasoningEffort) {
    lines.push(
      `model_reasoning_effort = ${JSON.stringify(restore.reasoningEffort)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Whether a profile file at this path is one of ours. */
export function isOurProfile(raw: string): boolean {
  return raw.startsWith(PROFILE_SENTINEL);
}
