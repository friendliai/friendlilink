import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { hermesHome } from "../../keys/env-path.js";
import { readJsonIfExists, readRawIfExists, writeJson } from "../../io/json.js";
import { writeFileAtomic } from "../../io/atomic-write.js";
import YAML from "yaml";
import {
  backupPathFor,
  removeQuietly,
  snapshotFileIfNeeded,
  type ConfigBackup,
} from "../common/backup.js";
import type { DisableOutcome } from "../common/plugin-runner.js";
import { harnessDataDir } from "../../config/paths.js";

/** A YAML node's value passed through `toJS(doc)`; plain JS values (in
 * tests) pass through untouched. */
function maybeNodeToJs(entry: unknown, doc: YAML.Document): unknown {
  const toJs = (entry as { toJS?: (doc: YAML.Document) => unknown } | null)
    ?.toJS;
  if (typeof toJs === "function") {
    return toJs.call(entry, doc);
  }
  return entry;
}

/** An entry's `name` normalized for comparison (undefined when absent) —
 * accepts a plain value or a YAML node from `doc`. */
function entryName(entry: unknown, doc: YAML.Document): string | undefined {
  const name = (maybeNodeToJs(entry, doc) as { name?: unknown } | null)?.name;
  return typeof name === "string" ? name.trim().toLowerCase() : undefined;
}

/** The pre-plugin legacy `custom_providers` entries `on` migrates away. */
const LEGACY_PROVIDER_NAMES = ["friendliai", "friendliai no thinking"];

/** True when `entry`'s `name` matches `expected` case-insensitively — used
 * to recognize our legacy managed `custom_providers` entries so `on` can
 * migrate them away (and `off` can restore them) while preserving
 * unrelated custom providers. */
function isNamedProvider(
  entry: unknown,
  expected: string,
  doc: YAML.Document,
): boolean {
  return entryName(entry, doc) === expected.toLowerCase();
}

/** The plugin key hermes installs under (directory / `plugins list` name). */
export const PLUGIN_NAME = "friendliai-provider";
/** The provider slug the friendliai-provider plugin registers. */
export const PLUGIN_PROVIDER = "friendli";
/**
 * The retired pre-rename plugin name. It registers the SAME `friendli`
 * slug, so when both sit in `plugins.enabled` which one serves the slug is
 * load-order dependent — `on` drops it from the enabled list (the install
 * directory itself is hers to remove) and `off` restores it when the user
 * had it enabled pre-`on`.
 */
export const LEGACY_PLUGIN_NAME = "friendli-provider";

export const CONFIG_RELATIVE_PATH = "config.yaml";

/** Lifecycle slots (backup + state) keyed by the resolved config path —
 * hermes never receives a profile name (its profiles resolve inside the hermes
 * process), so the path IS the identity. A path-hash can't let profile B's
 * `off` restore profile A's bytes. See SPEC.md. */
export function hermesSlot(dataDir: string, configFilePath: string) {
  const slot = createHash("sha256")
    .update(path.resolve(configFilePath))
    .digest("hex")
    .slice(0, 12);
  return {
    backupPath: backupPathFor(dataDir, `config-${slot}`),
    statePath: path.join(dataDir, `provider-state-${slot}.json`),
  };
}

interface ProviderState {
  apiKeySource: "flag" | "env" | "keychain";
  model: string;
  /** False when the plugin directory already existed before our `on`
   * installed it — `off` must then leave the user's plugin in place. */
  installedByUs?: boolean;
  /** Headers the `on` that wrote this state baked into
   * `model.default_headers` — `off` reverts exactly these. */
  telemetryHeaders?: Record<string, string>;
}

export function configPath(home: string, override = ""): string {
  return override || path.join(hermesHome(home), CONFIG_RELATIVE_PATH);
}

export function hermesDataDir(home: string, override = ""): string {
  return harnessDataDir(home, "hermes", override);
}

function statePath(dataDir: string, configFilePath: string): string {
  return hermesSlot(dataDir, configFilePath).statePath;
}

async function readRaw(configPath: string): Promise<string> {
  const { existed, raw } = await readRawIfExists(configPath);
  return existed ? raw : "";
}

async function parseDocumentOrAdvise(configPath: string) {
  const raw = await readRaw(configPath);
  try {
    // parseDocument keeps comments and quoting styles where possible —
    // hermes rewrites this file itself, but any surviving annotations
    // shouldn't die because of us.
    return YAML.parseDocument(raw);
  } catch (error) {
    throw new Error(
      `${configPath} could not be parsed as YAML — fix it and rerun. ` +
        `Underlying error: ${(error as Error).message}`,
      { cause: error },
    );
  }
}

/** True when the config's provider is the plugin and the plugin is enabled. */
export async function isFriendliManaged(configPath: string): Promise<boolean> {
  const doc = await parseDocumentOrAdvise(configPath);
  if (doc.getIn(["model", "provider"]) !== PLUGIN_PROVIDER) {
    return false;
  }
  return enabledPlugins(doc).includes(PLUGIN_NAME);
}

/** `plugins.enabled` as plain strings (the Document represents lists as
 * sequence NODES; plain arrays in tests pass through). */
function enabledPlugins(doc: YAML.Document): string[] {
  return seqItems(doc.getIn(["plugins", "enabled"]), doc).map((item) =>
    String(item),
  );
}

/** Plain-JS list items for a YAML sequence (or plain array in tests). */
function seqItems(value: unknown, doc: YAML.Document): unknown[] {
  return Array.isArray(value)
    ? value
    : ((value as { items?: unknown[] } | null)?.items ?? []).map((item) =>
        maybeNodeToJs(item, doc),
      );
}

/**
 * Single config write path for `hermes on`. Plugin enabled + `model` names the
 * picked default under the plugin's `friendli` provider. Legacy
 * `custom_providers` entries migrated away; see SPEC.md for the
 * ownership/restore contract.
 */
export async function enableFriendliForHermes(options: {
  configPath: string;
  dataDir: string;
  apiKeySource: "flag" | "env" | "keychain";
  model: string;
  pluginName?: string;
  /** Whether the plugin install was performed by this `on` (pre-probed by
   * the caller); recorded so `off` knows whether the uninstall is ours. */
  installedByUs?: boolean;
  /** Static headers baked into `model.default_headers` at `on` time; hermes
   * merges these over the provider profile's own headers on every request. */
  telemetryHeaders?: Readonly<Record<string, string>>;
}): Promise<{ model: string }> {
  const { configPath, dataDir, apiKeySource, model } = options;
  const telemetryHeaders = options.telemetryHeaders ?? {};
  const pluginName = options.pluginName ?? PLUGIN_NAME;

  const { backupPath } = hermesSlot(dataDir, configPath);
  await snapshotFileIfNeeded({
    configPath,
    backupPath,
    isManaged: () => isFriendliManaged(configPath),
  });

  const doc = await parseDocumentOrAdvise(configPath);

  // The plugin owns base_url/api_key/reasoning now — drop any leftover keys
  // from a previous custom-provider setup so the model block is exactly
  // {default, provider}.
  const modelKeys = new Set(
    (
      (doc.getIn(["model"]) as { items?: { key?: { value: string } }[] } | null)
        ?.items ?? []
    ).map((pair) => pair.key?.value),
  );
  for (const key of ["base_url", "api_key", "api_mode"] as const) {
    if (modelKeys.has(key)) {
      doc.deleteIn(["model", key]);
    }
  }
  doc.setIn(["model", "default"], model);
  doc.setIn(["model", "provider"], PLUGIN_PROVIDER);
  // Telemetry headers ride `model.default_headers` — hermes' documented
  // user-writable surface, applied over the provider profile's own headers
  // (agent_init._apply_openai_header_policy: model.default_headers overrides).
  if (Object.keys(telemetryHeaders).length > 0) {
    doc.setIn(["model", "default_headers"], telemetryHeaders);
  }

  // Migrate away the pre-plugin custom_providers entries (they carry inline
  // API keys); keep every entry that isn't one of ours.
  const customItems = seqItems(doc.getIn(["custom_providers"]), doc);
  if (customItems.length > 0) {
    const kept = customItems.filter(
      (entry) =>
        !isNamedProvider(entry, "FriendliAI", doc) &&
        !isNamedProvider(entry, "FriendliAI No Thinking", doc),
    );
    doc.setIn(["custom_providers"], kept);
  }

  const enabled = enabledPlugins(doc);
  // Retire the pre-rename plugin from the enabled list: both names register
  // the same `friendli` slug, and which one serves it is load-order
  // dependent. Only our new name stays enabled.
  const enabledWithoutLegacy = enabled.filter(
    (item) => item !== LEGACY_PLUGIN_NAME,
  );
  if (!enabledWithoutLegacy.includes(pluginName)) {
    enabledWithoutLegacy.push(pluginName);
  }
  doc.setIn(["plugins", "enabled"], enabledWithoutLegacy);
  // Never leave the plugin in `disabled` alongside `enabled`.
  const disabledItems = seqItems(doc.getIn(["plugins", "disabled"]), doc);
  if (disabledItems.some((item) => String(item) === pluginName)) {
    const keptDisabled = disabledItems.filter(
      (item) => String(item) !== pluginName,
    );
    doc.setIn(["plugins", "disabled"], keptDisabled);
  }

  const serialized = `${doc.toString().replace(/\n+$/, "\n")}\n`;
  await writeFileAtomic(configPath, serialized, { mode: 0o600 });

  await writeJson(
    statePath(dataDir, configPath),
    {
      apiKeySource,
      model,
      installedByUs: options.installedByUs ?? true,
      ...(Object.keys(telemetryHeaders).length > 0
        ? { telemetryHeaders: { ...telemetryHeaders } }
        : {}),
    } satisfies ProviderState,
    { mode: 0o600 },
  );

  return { model };
}

/** Behavior contract shared with the dsh disable flow; defined once in the
 * common plugin-runner module. */
export type { DisableOutcome };

/** The `off` result the hermes adapter acts on: what happened to the
 * config, and whether the plugin uninstall is ours to perform (the plugin
 * directory already existed before our `on` installed it). */
export interface DisableResult {
  outcome: DisableOutcome;
  /** False when the plugin pre-dated our `on` — `off` must leave it. */
  uninstallPlugin: boolean;
  /** True when `restored` came from the backup-less state strip: nothing
   * was reverted to a pre-`on` state, so the adapter reports it with its
   * own wording. */
  strippedWithoutBackup?: boolean;
}

/** The pre-`on` snapshot captured by `snapshotFileIfNeeded`. */
async function readBackup(
  backupPath: string,
): Promise<ConfigBackup | undefined> {
  const { value: backup } = await readJsonIfExists<ConfigBackup>(backupPath);
  return backup;
}

/** `doc.getIn(path)` normalized to plain JS for value comparison. */
function getPlain(doc: YAML.Document, path: (string | number)[]): unknown {
  return maybeNodeToJs(doc.getIn(path), doc);
}

/** True for null/empty string/empty collection (recursively) — a YAML doc
 * whose plain value passes this holds no content we would keep. */
function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true;
  }
  if (typeof value === "string") {
    return value.trim() === "";
  }
  if (Array.isArray(value)) {
    return value.every(isEmptyValue);
  }
  if (typeof value === "object") {
    return Object.values(value).every(isEmptyValue);
  }
  return false;
}

/**
 * Reverts only what `on` changed (three-way: live vs pre-on snapshot vs
 * on-wrote values); user edits survive. `plugins.enabled` membership is owned
 * by the pre-on snapshot. Backup-less strip uses durable state only.
 * `off` probes state FIRST (peek, not consume) then uninstalls plugin BEFORE
 * this function — so a failed removal keeps recovery artifacts intact for
 * retry. See SPEC.md.
 */
export async function disableFriendliForHermes(options: {
  configPath: string;
  dataDir: string;
}): Promise<DisableResult> {
  const { backupPath, statePath: stateFile } = hermesSlot(
    options.dataDir,
    options.configPath,
  );
  const backup = await readBackup(backupPath);
  if (!backup) {
    // Backup-less strip (dsh's backup-less `off` policy): with no
    // pre-`on` snapshot the durable provider state is the only undo
    // evidence left, so `off` still removes exactly what it proves is
    // ours instead of giving up — and always forgets the state itself.
    const state = await readJsonIfExists<ProviderState>(stateFile).then(
      (r) => r.value,
    );
    if (!state) {
      return { outcome: "none", uninstallPlugin: false };
    }
    // A pre-plugin state file (custom:friendliai era) has no
    // `installedByUs`; that era installed no plugin, so a missing
    // field means "not ours" (default false — never remove a plugin we
    // cannot prove we installed).
    const uninstallPlugin = state.installedByUs ?? false;
    // A missing config parses as an empty document: nothing in it can be
    // proven ours, so only the state-file cleanup below runs.
    const doc = await parseDocumentOrAdvise(options.configPath);
    let stripped = false;

    // model.default / model.provider — delete the key only while the
    // live value still deep-equals ours; a value the user changed
    // cannot be proven ours and survives untouched.
    let deletedFromModel = false;
    const scalars: [key: string, ours: unknown][] = [
      ["default", state.model],
      ["provider", PLUGIN_PROVIDER],
      ["default_headers", state.telemetryHeaders],
    ];
    for (const [key, ours] of scalars) {
      if (ours === undefined) {
        continue;
      }
      const current = getPlain(doc, ["model", key]);
      if (current === undefined || !isDeepStrictEqual(current, ours)) {
        continue;
      }
      doc.deleteIn(["model", key]);
      stripped = true;
      deletedFromModel = true;
    }
    // Prune a `model` block only OUR deletions emptied — a block the
    // user emptied themselves (or that already held nothing of ours)
    // is theirs to shape (same conservative gate the snapshot prune
    // replaces with "the pre-on config had nothing there").
    if (deletedFromModel && isEmptyValue(getPlain(doc, ["model"]))) {
      doc.deleteIn(["model"]);
    }
    // plugins.enabled — the install being ours proves the enabled entry
    // is ours too (`on` enabled what it installed); a plugin that
    // pre-dated our `on` left no pre-on evidence, so its entry is
    // unprovable and MUST be preserved.
    if (uninstallPlugin) {
      const enabled = seqItems(doc.getIn(["plugins", "enabled"]), doc);
      if (enabled.some((item) => String(item) === PLUGIN_NAME)) {
        doc.setIn(
          ["plugins", "enabled"],
          enabled.filter((item) => String(item) !== PLUGIN_NAME),
        );
        stripped = true;
      }
    }

    // Write only when something was stripped, so a no-op leaves the
    // live file byte-identical. The state file goes away here — but
    // the return value still hands `off` the uninstall decision, so it
    // can never silently skip plugin cleanup (the state file's very
    // existence proves a managed lifecycle).
    if (stripped) {
      const serialized = `${doc.toString().replace(/\n+$/, "\n")}\n`;
      await writeFileAtomic(options.configPath, serialized, { mode: 0o600 });
    }
    await removeQuietly(stateFile);
    return stripped
      ? { outcome: "restored", uninstallPlugin, strippedWithoutBackup: true }
      : // The state file itself proves a managed lifecycle: even with
        // nothing strippable left in the config, `off` must still run
        // the uninstall — a `none` would skip it silently.
        { outcome: "restored", uninstallPlugin, strippedWithoutBackup: true };
  }

  // An existing-but-empty pre-on file must stay distinguishable from a
  // file that never existed: `existed` decides restoration, raw content
  // decides parsing.
  const preOnRaw = backup.snapshot.raw;
  const preOn = YAML.parseDocument(preOnRaw);
  const doc = await parseDocumentOrAdvise(options.configPath);

  const state = await readJsonIfExists<ProviderState>(stateFile).then(
    (r) => r.value,
  );
  const ourModel = state?.model;
  // Pre-plugin (custom:friendliai era) state has no field and that era
  // installed no plugin — default false like the strip path above.
  const uninstallPlugin = state?.installedByUs ?? false;

  // model.default / model.provider — revert only when the field still holds
  // OUR value; a user's own value (written before or after `on`) survives.
  const scalars: [prop: string, ours: unknown][] = [
    ["default", ourModel],
    ["provider", PLUGIN_PROVIDER],
    // `on` also wrote default_headers (telemetry); the same user-edit
    // protection applies — a map we can't prove is ours (the user's own
    // headers, ours-but-edited) survives, pre-on's own value is restored.
    ["default_headers", state?.telemetryHeaders ?? undefined],
  ];
  for (const [key, ours] of scalars) {
    const current = getPlain(doc, ["model", key]);
    if (current === undefined) {
      continue;
    }
    if (ours === undefined || !isDeepStrictEqual(current, ours)) {
      continue; // user-edited (or we can't tell) — leave it alone
    }
    const preValue = preOn ? getPlain(preOn, ["model", key]) : undefined;
    if (preValue === undefined) {
      doc.deleteIn(["model", key]);
    } else {
      doc.setIn(["model", key], preValue);
    }
  }

  // model.base_url / api_key / api_mode — `on` deleted them; put the pre-on
  // values back when the user hasn't re-added their own (and the model block
  // they belonged to still exists — a user removing the whole block wins).
  for (const key of ["base_url", "api_key", "api_mode"] as const) {
    if (getPlain(doc, ["model", key]) !== undefined) {
      continue;
    }
    const preValue = preOn ? getPlain(preOn, ["model", key]) : undefined;
    if (preValue !== undefined && doc.hasIn(["model"])) {
      doc.setIn(["model", key], preValue);
    }
  }

  // plugins.enabled — membership is owned by the pre-`on` snapshot, not
  // by the uninstall decision: a name the user had enabled before our
  // `on` is theirs and stays (even when the directory below it is being
  // uninstalled), while ours is dropped whenever the snapshot shows they
  // didn't have it enabled (even when that directory pre-dated us). With
  // no snapshot document nothing can be proven, so the live list is left
  // alone — except the plugin we did install into a config that had
  // nothing, whose entry must not outlive the uninstall. The rest of the
  // list keeps its current order and any plugins the user added stay.
  // The retired pre-rename plugin entry our `on` removed comes back when
  // the user had it enabled pre-`on` and hasn't re-enabled it since (a
  // post-on re-enable is a user change and survives; the legacy install
  // directory is never touched).
  const enabled = seqItems(doc.getIn(["plugins", "enabled"]), doc);
  const preEnabled = preOn
    ? seqItems(preOn.getIn(["plugins", "enabled"]), preOn)
    : [];
  const entryIsOurs =
    preOn === undefined
      ? uninstallPlugin
      : !preEnabled.some((item) => String(item) === PLUGIN_NAME);
  const keptEnabled = entryIsOurs
    ? enabled.filter((item) => String(item) !== PLUGIN_NAME)
    : enabled;
  const legacyPreEnabledOnly =
    preEnabled.some((item) => String(item) === LEGACY_PLUGIN_NAME) &&
    !enabled.some((item) => String(item) === LEGACY_PLUGIN_NAME)
      ? [LEGACY_PLUGIN_NAME]
      : [];
  const finalEnabled = [...keptEnabled, ...legacyPreEnabledOnly];
  if (
    finalEnabled.length !== enabled.length ||
    legacyPreEnabledOnly.length > 0
  ) {
    doc.setIn(["plugins", "enabled"], finalEnabled);
  }

  // plugins.disabled — undo only OUR removal: re-add the name exactly when
  // the pre-on config had it disabled. A name the user disabled after `on`
  // is a user change; it stays disabled; a user removing the whole
  // disabled list (or plugins block) is honored too.
  const disabledNow = seqItems(doc.getIn(["plugins", "disabled"]), doc);
  const preDisabled = preOn
    ? seqItems(preOn.getIn(["plugins", "disabled"]), preOn)
    : undefined;
  if (
    preDisabled &&
    doc.hasIn(["plugins", "disabled"]) &&
    preDisabled.some((item) => String(item) === PLUGIN_NAME) &&
    !disabledNow.some((item) => String(item) === PLUGIN_NAME)
  ) {
    doc.setIn(["plugins", "disabled"], [...disabledNow, PLUGIN_NAME]);
  }

  // custom_providers — restore the legacy FriendliAI entries our migration
  // removed when the user hasn't re-added their own version (same name);
  // a user deleting the whole custom_providers block after `on` wins.
  const currentCustom = seqItems(doc.getIn(["custom_providers"]), doc);
  const preCustom = preOn
    ? seqItems(preOn.getIn(["custom_providers"]), preOn)
    : [];
  const missingLegacy =
    preOn && (doc.hasIn(["custom_providers"]) || currentCustom.length > 0)
      ? preCustom.filter(
          (entry) =>
            LEGACY_PROVIDER_NAMES.includes(entryName(entry, preOn) ?? "") &&
            !currentCustom.some(
              (current) => entryName(current, doc) === entryName(entry, preOn),
            ),
        )
      : [];
  if (missingLegacy.length > 0) {
    // Merge at their snapshot positions, not appended: an appended repair
    // reorders the list ([FriendliAI, Ollama] would come back as [Ollama,
    // FriendliAI]), which no longer deep-equals the pre-on config — the
    // byte-exact restore would then be impossible for no user reason.
    // Walk the snapshot order; for each pre-on slot take the restored
    // legacy entry when it is the one being repaired here, else the
    // user's live entry with that name, else the live unrelated entry.
    // User-added entries with no snapshot position keep their relative
    // order at the end.
    const byName = (entry: unknown, d: YAML.Document) => entryName(entry, d);
    const pending = [...missingLegacy];
    const used = new Set<unknown>();
    const rebuilt: unknown[] = [];
    const takeFrom = (
      list: unknown[],
      d: YAML.Document,
      name: string | undefined,
    ): unknown => {
      const found = list.find(
        (item) => !used.has(item) && byName(item, d) === name,
      );
      if (found !== undefined) {
        used.add(found);
      }
      return found;
    };
    for (const preEntry of preCustom) {
      const name = byName(preEntry, preOn);
      const isLegacy = LEGACY_PROVIDER_NAMES.includes(name ?? "");
      // Repaired legacy entries come from the snapshot itself.
      const choice = isLegacy
        ? takeFrom(pending, preOn, name)
        : takeFrom(currentCustom, doc, name);
      if (choice !== undefined) {
        rebuilt.push(choice);
      }
    }
    const leftovers = currentCustom.filter((item) => !used.has(item));
    doc.setIn(["custom_providers"], [...rebuilt, ...leftovers]);
  }

  // Prune containers only we emptied (the pre-on config had nothing there):
  // a no-op `off` should not leave `model: {}` husks behind.
  for (const empty of [
    ["model"],
    ["custom_providers"],
    ["plugins", "enabled"],
    ["plugins", "disabled"],
    ["plugins"],
  ] as const) {
    const current = getPlain(doc, [...empty]);
    if (!isEmptyValue(current)) {
      continue;
    }
    const preValue = preOn ? getPlain(preOn, [...empty]) : undefined;
    if (preValue === undefined) {
      doc.deleteIn([...empty]);
    }
  }

  const finalJs = doc.toJS();
  if (
    backup.snapshot.existed &&
    preOn &&
    isDeepStrictEqual(finalJs, preOn.toJS())
  ) {
    // The revert lands semantically on the pre-on config — restore its
    // exact bytes so comments and formatting survive the round trip.
    await writeFileAtomic(options.configPath, preOnRaw ?? "");
  } else if (isEmptyValue(finalJs) && !backup.snapshot.existed) {
    await removeQuietly(options.configPath);
  } else {
    const serialized = `${doc.toString().replace(/\n+$/, "\n")}\n`;
    await writeFileAtomic(options.configPath, serialized, { mode: 0o600 });
  }
  await removeQuietly(backupPath);
  await removeQuietly(stateFile);
  return { outcome: "restored", uninstallPlugin };
}

export async function readProviderState(
  dataDir: string,
  configFilePath: string,
): Promise<ProviderState | undefined> {
  const { value } = await readJsonIfExists<ProviderState>(
    statePath(dataDir, configFilePath),
  );
  return value;
}
