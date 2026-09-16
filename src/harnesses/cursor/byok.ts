/**
 * Which of Cursor's own models still work while the OpenAI override is on.
 *
 * Measured against Cursor 3.19.19 with the override pointed at a capture
 * server, there are three outcomes, not two:
 *
 *   SURVIVES  Cursor serves it as usual and nothing reaches our endpoint.
 *             `claude-opus-5` (anthropic), `gemini-3.1-pro` (google), and
 *             `auto-smart`, Cursor's vendorless router, all answered normally.
 *
 *   CAPTURED  The request arrives at our endpoint with the model id intact.
 *             `gpt-5.6-sol` and `gpt-5.4-nano` (openai). Friendli cannot serve
 *             those ids, so picking one is an error every time.
 *
 *   REFUSED   Cursor blocks the model itself while any custom API key is
 *             active, before anything is sent: "This model does not support
 *             custom API keys" (`grok-4.6`, `grok-4.5`, `composer-2.5`) or
 *             "This model is not available with a custom API key"
 *             (`muse-spark-1.3`). Nothing reaches us; the model is simply
 *             unusable until `off`.
 *
 * Both of the latter two are unusable while `on`, so both are hidden — but for
 * different reasons, and neither is something frlink can work around.
 *
 * The pattern behind it: Cursor keeps serving a model only when its vendor has
 * a BYOK slot of its own — Anthropic and Google — or when it is the router.
 * Everything else it either redirects to the one custom endpoint or declines.
 *
 * That also disposes of `useClaudeKey` / `useGoogleKey`. Cursor's own router
 * returns `"openai"` only for names that are neither `claude-*` nor `gemini-*`,
 * so those flags cannot change whether our override captures a Claude model —
 * and on this machine they are absent from the blob entirely. An earlier
 * attempt consulted them and hid Claude models exactly when the user had their
 * own Anthropic key, the one case the override provably does not touch.
 */

/** One entry of `availableDefaultModels2`, Cursor's model catalog. */
export interface CursorModelEntry {
  name?: unknown;
  vendorName?: unknown;
  vendor?: { displayName?: unknown } | null;
  isUserAdded?: unknown;
  defaultOn?: unknown;
  [key: string]: unknown;
}

/**
 * The BYOK slots Cursor routes away from the OpenAI one, as (vendor, prefix)
 * pairs. This is not a model catalog — it is the same two key slots the
 * harness already knows about, and Cursor supplies both signals itself.
 */
const BYOK_SLOTS = [
  { vendorName: "anthropic", prefix: "claude-" },
  { vendorName: "google", prefix: "gemini-" },
] as const;

/** Cursor's server-supplied vendor for an entry, lowercased; "" when absent. */
export function vendorOf(entry: CursorModelEntry): string {
  if (typeof entry.vendorName === "string") {
    return entry.vendorName.toLowerCase();
  }
  const displayName = entry.vendor?.displayName;
  return typeof displayName === "string" ? displayName.toLowerCase() : "";
}

export function entryName(entry: CursorModelEntry): string {
  return typeof entry.name === "string" ? entry.name : "";
}

/**
 * Whether this built-in keeps working while our override is on.
 *
 * Two independent signals must agree: Cursor's server-supplied `vendorName`,
 * and the name prefix its client actually routes by. Where they disagree we
 * hide — an Anthropic-vendored model not named `claude-*` routes to the OpenAI
 * slot, so hiding it is right. The asymmetry is deliberate: a model hidden in
 * error costs the user one `off`, while a model left visible in error fails
 * every time they pick it.
 *
 * One case this cannot catch, stated plainly because the two signals agree on
 * it. Cursor's router (`byokModelUtils`, verified in 3.20.10) reads
 *
 *     gemini-* AND NOT in {"gemini-1.5-preview"}  ->  the Google slot
 *
 * so an id in that exception set carries `vendorName: "google"` and a
 * `gemini-` prefix, passes the agreement test here, and stays visible while
 * actually routing to the OpenAI slot and failing. Nothing in the blob
 * distinguishes it; only the minified constant does, and copying that out of
 * the bundle is exactly the hardcoded catalog this project refuses to carry.
 * No id in the exception set has appeared in a served catalog so far — if one
 * does, it fails loudly on selection rather than silently, and the fix is a
 * signal from Cursor, not a list from us.
 */
export function survivesOpenAiOverride(entry: CursorModelEntry): boolean {
  const name = entryName(entry);
  if (!name) {
    return false;
  }
  const vendor = vendorOf(entry);
  // Cursor's router carries no vendor at all and kept working through the
  // override. It is also `defaultOn`, so hiding it would change what a fresh
  // Cursor opens with — too blunt for a model that demonstrably still answers.
  if (!vendor) {
    return entry.defaultOn === true;
  }
  return BYOK_SLOTS.some(
    (slot) => vendor === slot.vendorName && name.startsWith(slot.prefix),
  );
}

/** Cursor's reserved picker entries — never real models. */
const SENTINELS = new Set(["default", "inherit", "none"]);

/**
 * The built-ins to hide for one `on`: everything Cursor would route through
 * the OpenAI slot, minus anything Friendli can actually serve, minus the
 * user's own additions (never ours to judge), minus the sentinels.
 */
export function modelsToHide(options: {
  entries: CursorModelEntry[];
  /** Ids Friendli serves this run — those stay whatever their vendor says. */
  servable: (id: string) => boolean;
  /** Ids already in the user's `userAddedModels` before this run. */
  userOwned: ReadonlySet<string>;
}): string[] {
  const hidden: string[] = [];
  for (const entry of options.entries) {
    const name = entryName(entry);
    if (!name || SENTINELS.has(name)) continue;
    if (entry.isUserAdded === true || options.userOwned.has(name)) continue;
    if (options.servable(name)) continue;
    if (survivesOpenAiOverride(entry)) continue;
    hidden.push(name);
  }
  return hidden;
}

/** Cursor's model catalog off the blob, as entries. */
export function catalogEntries(blob: {
  availableDefaultModels2?: unknown;
}): CursorModelEntry[] {
  const raw = blob.availableDefaultModels2;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is CursorModelEntry =>
      Boolean(entry) && typeof entry === "object",
  );
}
