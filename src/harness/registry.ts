import { claudeAdapter } from "../harnesses/claude/index.js";
import { codexAdapter } from "../harnesses/codex/index.js";
import { cursorAdapter } from "../harnesses/cursor/index.js";
import { dshAdapter } from "../harnesses/dsh/index.js";
import { hermesAdapter } from "../harnesses/hermes/index.js";
import { opencodeAdapter } from "../harnesses/opencode/index.js";
import { piAdapter } from "../harnesses/pi/index.js";
import type { HarnessAdapter } from "./types.js";

const registry = new Map<string, HarnessAdapter>([
  [claudeAdapter.id, claudeAdapter],
  [codexAdapter.id, codexAdapter],
  [cursorAdapter.id, cursorAdapter],
  [dshAdapter.id, dshAdapter],
  [hermesAdapter.id, hermesAdapter],
  [opencodeAdapter.id, opencodeAdapter],
  [piAdapter.id, piAdapter],
]);

/** Longer names people reach for, mapped to the canonical harness id. Kept
 * out of `registry` itself: `listHarnesses()` walks its values, so an extra
 * key there would list the same agent twice in `check`/`all`.
 *
 * A Map, not an object: a plain object answers `["constructor"]` and
 * `["toString"]` with an inherited function, which would sail past the
 * `--exclude` typo guard and silently exclude nothing. */
const HARNESS_ALIASES = new Map<string, string>([
  ["claude-code", "claude"],
  ["codex-cli", "codex"],
  ["chatgpt", "codex"],
  ["hermes-agent", "hermes"],
  ["deepseek-harness", "dsh"],
]);

/** Canonical id for a name the user typed, or undefined when it names no
 * harness. Accepts both the canonical ids and the aliases above. */
export function resolveHarnessId(name: string): string | undefined {
  return registry.has(name) ? name : HARNESS_ALIASES.get(name);
}

export function getHarness(id: string): HarnessAdapter | undefined {
  return registry.get(id);
}

export function listHarnesses(): HarnessAdapter[] {
  return [...registry.values()];
}
