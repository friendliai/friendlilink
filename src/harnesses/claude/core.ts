import path from "node:path";
import { readJsonIfExists, readRawIfExists, writeJson } from "../../io/json.js";
import {
  removeQuietly,
  restoreFileFromBackup,
  snapshotFileIfNeeded,
  type ConfigBackup,
} from "../common/backup.js";
import type { DisableOutcome } from "../common/plugin-runner.js";
import { snapshotOwnsConfigPath } from "../common/slot-key.js";
import {
  FRIENDLI_BASE_URL,
  normalizeFriendliBaseUrl,
} from "../../friendli/base-url.js";
import type { FriendliModel } from "../../friendli/model-catalog.js";
import { mergeFrlinkTelemetryHeaderLines } from "../../telemetry/request-headers.js";
import { applyServerToolsDenyList } from "./server-tools-deny.js";
import { stripLegacyClaudeCodeContextSuffix } from "./code-context.js";
import {
  claudeCodeCapabilities,
  claudeCodeCapabilityRule,
} from "./reasoning.js";
import { harnessDataDir } from "../../config/paths.js";

export const USER_SETTINGS_RELATIVE_PATH = ".claude/settings.json";

/** Marks the env block as ours, independent of the exact base URL (so a
 * `--base-url` override, e.g. a staging endpoint, is still recognized as
 * managed by us on the next `on`/`off`/`status`). */
const MANAGED_MARKER_KEY = "FRLINK_MANAGED";

/** Legacy inert key from earlier frlink releases. Migration only — never
 * written again. */
const LEGACY_NOOP_AUTO_UPDATE_KEY = "CLAUDE_AUTO_UPDATE";

/** Claude Code's real auto-updater switch. Only written while a version pin
 * is in force (see version-guard.ts); otherwise it is stripped from the
 * managed env block so a pin from an earlier release can't outlive its
 * reason. `off` restores the user's own settings either way. */
const AUTO_UPDATE_KEY = "DISABLE_AUTOUPDATER";

/** Corrects Claude Code's 200k default window for unrecognized (Friendli)
 * model ids. Written only when the catalog reports a context length; never
 * touches a user-owned value. */
const MAX_CONTEXT_TOKENS_KEY = "CLAUDE_CODE_MAX_CONTEXT_TOKENS";

/** Suppresses Claude Code's own `[1m]` model variants. Reads to Claude Code
 * as "keep this session within 200k", so it must never coexist with a
 * `CLAUDE_CODE_MAX_CONTEXT_TOKENS` above 200k — that pairing trips Claude
 * Code's compact-context-cap notice on every launch. */
const DISABLE_1M_CONTEXT_KEY = "CLAUDE_CODE_DISABLE_1M_CONTEXT";
const MODEL_CAPABILITIES_KEY = "CLAUDE_CODE_MODEL_CAPABILITIES";
const DEFAULT_MODEL_KEY = "ANTHROPIC_DEFAULT_MODEL";

/** Claude Code chooses its provider from these before it ever reads
 * `ANTHROPIC_BASE_URL`. Someone running Claude Code on Bedrock or Vertex has
 * one of them set — that is the documented setup — so without this their
 * requests keep going to that provider and `on` is a silent no-op. Claude Code
 * applies a settings.json `env` block over the process env, so writing the off
 * value here neutralizes both a value in this file and one exported from a
 * shell profile; empty reads as unset to every check it makes. `off` restores
 * the pre-frlink file byte-for-byte, which hands the provider back. */
const PROVIDER_SELECTION_KEYS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_GATEWAY",
] as const;

export interface ClaudeModelMapping {
  opus?: string;
  sonnet?: string;
  haiku?: string;
  fable?: string;
  subagent?: string;
}

/** Stable Claude compatibility identities for slot remapping and thinking.
 * Haiku uses Sonnet 4.6's identity — Claude Code rejects adaptive thinking
 * for Haiku 4.5 before consulting overrides. These are NOT the latest models. */
const SLOT_CLAUDE_ID = {
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-sonnet-4-6",
  fable: "claude-fable-5",
} as const satisfies Record<string, string>;

/** Claude Code's own settings.json shape — we only care about a few keys and
 * must preserve everything else untouched. */
export interface ClaudeSettings {
  model?: string;
  env?: Record<string, string>;
  /** Claude Code's per-version model id remapping; frlink owns the
   * slot entries it writes and clears them before each write. */
  modelOverrides?: Record<string, string>;
  modelPicker?: {
    options: Array<{ model: string; label?: string; description?: string }>;
    replaceBuiltInOptions?: boolean;
  };
  permissions?: { deny?: string[]; [key: string]: unknown };
  [key: string]: unknown;
}

interface ProviderState {
  apiKeySource: "flag" | "env" | "keychain";
  mapping: ClaudeModelMapping;
  /** Outcome of the Claude Code version guard at the last `on`. */
  versionGuard?: { version: string | null; downgraded: boolean };
}

export function userSettingsPath(home: string, override = ""): string {
  return override || path.join(home, USER_SETTINGS_RELATIVE_PATH);
}

export function claudeDataDir(home: string, override = ""): string {
  return harnessDataDir(home, "claude", override);
}

function providerBackupPath(dataDir: string): string {
  return path.join(dataDir, "provider-backup.json");
}

function providerStatePath(dataDir: string): string {
  return path.join(dataDir, "provider-state.json");
}

function parseSettings(raw: string): ClaudeSettings {
  if (!raw.trim()) {
    return {};
  }
  return JSON.parse(raw) as ClaudeSettings;
}

export async function isFriendliManaged(
  settingsPath: string,
): Promise<boolean> {
  const { raw } = await readRawIfExists(settingsPath);
  if (!raw.trim()) {
    return false;
  }
  const settings = parseSettings(raw);
  return settings.env?.[MANAGED_MARKER_KEY] === "1";
}

interface ProviderPaths {
  settingsPath: string;
  dataDir: string;
}

/** Never report success or snapshot our own settings when recovery is impossible. */
async function assertRecoverableSettings(
  options: ProviderPaths,
): Promise<void> {
  const backupPath = providerBackupPath(options.dataDir);
  const { existed, value: backup } =
    await readJsonIfExists<ConfigBackup>(backupPath);
  if (existed) {
    if (snapshotOwnsConfigPath(backup, options.settingsPath)) return;
    throw new Error(
      `Claude Code backup does not belong to the selected settings path (${options.settingsPath}). Settings were not changed. Backup: ${backupPath}`,
    );
  }
  if (!(await isFriendliManaged(options.settingsPath))) return;

  throw new Error(
    `Claude Code is still configured for FriendliAI, but no matching pre-FriendliAI backup was found. Settings were not changed. Expected backup: ${backupPath}`,
  );
}

/**
 * Snapshot the settings.json before we touch it (see
 * `snapshotFileIfNeeded`), under the historical `provider-backup.json`
 * name that earlier releases wrote.
 */
async function snapshotSettingsIfNeeded(
  settingsPath: string,
  dataDir: string,
): Promise<void> {
  await snapshotFileIfNeeded({
    configPath: settingsPath,
    backupPath: providerBackupPath(dataDir),
    isManaged: () => isFriendliManaged(settingsPath),
  });
}

/** Whether an env key is the user's own (not ours). The pre-frlink snapshot
 * is the authority — the managed marker alone can't (the first `on` leaves
 * the user's key in a now-managed file). Unreadable/unparseable err = leave. */
async function userOwnsEnvKey(dataDir: string, key: string): Promise<boolean> {
  const { value: backup } = await readJsonIfExists<{
    snapshot?: { existed: boolean; raw: string };
  }>(providerBackupPath(dataDir));
  if (!backup?.snapshot) {
    return true;
  }
  if (!backup.snapshot.existed) {
    // No settings file before us, so nothing in it can be theirs.
    return false;
  }
  try {
    return parseSettings(backup.snapshot.raw).env?.[key] !== undefined;
  } catch {
    return true;
  }
}

/** Suffixes of the per-slot metadata frlink owns. Cleared before each
 * write: they describe one specific model, so a leftover from a previous `on`
 * would describe the wrong one. */
const SLOT_METADATA_SUFFIXES = [
  "_NAME",
  "_DESCRIPTION",
  "_SUPPORTED_CAPABILITIES",
];

const SLOT_ENV_KEY = {
  opus: "ANTHROPIC_DEFAULT_OPUS_MODEL",
  sonnet: "ANTHROPIC_DEFAULT_SONNET_MODEL",
  haiku: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  fable: "ANTHROPIC_DEFAULT_FABLE_MODEL",
} as const satisfies Record<string, string>;

export function buildFriendliProviderEnv(
  apiKey: string,
  baseUrl: string,
  mapping: ClaudeModelMapping,
  catalog: FriendliModel[] = [],
  options: { mainModel?: string; pinAutoUpdate?: boolean } = {},
): Record<string, string> {
  const env: Record<string, string> = {
    [MANAGED_MARKER_KEY]: "1",
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: apiKey,
  };
  for (const key of PROVIDER_SELECTION_KEYS) {
    env[key] = "";
  }
  if (options.pinAutoUpdate) {
    // A pinned version only holds if Claude Code stops updating past it.
    // `DISABLE_AUTOUPDATER` is the switch its binary honors (checked before
    // any config, native installs included) — `CLAUDE_AUTO_UPDATE` looks
    // plausible but does nothing.
    env[AUTO_UPDATE_KEY] = "1";
  }
  const byId = new Map(catalog.map((model) => [model.id, model]));
  const capabilityRules = new Set<string>();
  const addRules = (id: string, info: FriendliModel) => {
    for (const spelling of new Set([id, id.toLowerCase()])) {
      const rule = claudeCodeCapabilityRule(spelling, info);
      if (rule) capabilityRules.add(rule);
    }
  };

  for (const [slot, envKey] of Object.entries(SLOT_ENV_KEY)) {
    const modelId = mapping[slot as keyof typeof SLOT_ENV_KEY];
    if (!modelId) continue;
    const bareModelId = stripLegacyClaudeCodeContextSuffix(modelId);
    const info = byId.get(modelId) ?? byId.get(bareModelId);
    // The slot env names the Claude id, not the Friendli id: Claude Code runs
    // capability and thinking logic (including "can thinking be disabled") in
    // terms of a model it recognizes, and an unrecognized Friendli id falls
    // into its unknown-model paths for all of it. The request's `model` field
    // still reaches Friendli as the Friendli id — `modelOverrides` (written
    // by enableFriendliProvider) swaps it at request-build time.
    env[envKey] = SLOT_CLAUDE_ID[slot as keyof typeof SLOT_ENV_KEY];
    env[`${envKey}_NAME`] = info?.label ?? bareModelId;
    if (info?.description) env[`${envKey}_DESCRIPTION`] = info.description;
    if (info) {
      // Keep the documented metadata for provider transports that honor it.
      // Friendli's Anthropic transport also needs the signed canonical rule.
      env[`${envKey}_SUPPORTED_CAPABILITIES`] =
        claudeCodeCapabilities(info).join(",");
      addRules(
        SLOT_CLAUDE_ID[slot as keyof typeof SLOT_ENV_KEY].replace(
          /-\d{8}$/,
          "",
        ),
        info,
      );
    }
  }

  // Bare --model and subagent ids, and modelOverrides values, can enter the
  // capability lookup without going through a slot alias.
  for (const id of [...Object.values(mapping), options.mainModel]) {
    if (!id) continue;
    const bareId = stripLegacyClaudeCodeContextSuffix(id);
    const info = byId.get(id) ?? byId.get(bareId);
    if (info) addRules(bareId, info);
  }
  if (capabilityRules.size > 0) {
    env[MODEL_CAPABILITIES_KEY] = [...capabilityRules].join(";");
  }
  const defaultModel = selectedSessionModel(mapping, options.mainModel ?? "");
  if (defaultModel) {
    // Claude Code rejects the short "haiku" alias in ANTHROPIC_DEFAULT_MODEL.
    env[DEFAULT_MODEL_KEY] =
      defaultModel === "haiku" ? SLOT_CLAUDE_ID.haiku : defaultModel;
  }

  if (mapping.subagent) {
    // Keep legacy saved mappings from forwarding a non-Friendli model id.
    env.CLAUDE_CODE_SUBAGENT_MODEL = stripLegacyClaudeCodeContextSuffix(
      mapping.subagent,
    );
  }

  // Claude Code caps any model it doesn't recognize at 200k, so tell it the
  // real window for the one model the session actually runs on — the main
  // model, falling back to the first mapped slot when there is no explicit
  // `--model` (that is what picks up the slot mapping in-session). The
  // catalog reports the number, so this stays right as models change; when
  // it doesn't report one, leave the variable for the user to set.
  //
  // Slot-mapped models skip this: their `modelOverrides` entry (see
  // slotModelOverrides) makes Claude Code resolve them to a recognized id
  // already sized from its own baked table, and the extra env would only let
  // the catalog window fight the baked one.
  const mainModel = options.mainModel ?? "";
  const mainEntry = mainModel
    ? (byId.get(mainModel) ??
      byId.get(stripLegacyClaudeCodeContextSuffix(mainModel)))
    : undefined;
  const contextLength = mainEntry?.contextLength;
  if (contextLength !== undefined && contextLength > 0) {
    env[MAX_CONTEXT_TOKENS_KEY] = String(contextLength);
    // Keep Claude Code from selecting or displaying its own `[1m]` model
    // variants — but only when the window stays inside Claude Code's 200k
    // default. `CLAUDE_CODE_DISABLE_1M_CONTEXT` reads as "keep this session
    // within 200k", so pairing it with a >200k window makes Claude Code warn
    // that the 1M-context cap isn't enforced on every startup. A model that
    // really is >200k wants the window, not the cap.
    if (contextLength <= 200_000) {
      env[DISABLE_1M_CONTEXT_KEY] = "1";
    }
  }
  return env;
}

/** Use a configured session slot for startup and the picker's Default row.
 * In particular, do not preserve a previously selected cached Claude ID. */
function selectedSessionModel(
  mapping: ClaudeModelMapping,
  mainModel: string,
): string {
  if (mainModel) return stripLegacyClaudeCodeContextSuffix(mainModel);
  return (
    (["sonnet", "opus", "haiku", "fable"] as const).find(
      (slot) => mapping[slot],
    ) ?? ""
  );
}

function modelPicker(
  mapping: ClaudeModelMapping,
  mainModel: string,
  catalog: FriendliModel[],
): ClaudeSettings["modelPicker"] {
  const options: NonNullable<ClaudeSettings["modelPicker"]>["options"] = [];
  for (const slot of Object.keys(SLOT_ENV_KEY) as Array<
    keyof typeof SLOT_ENV_KEY
  >) {
    const id = mapping[slot];
    if (!id) continue;
    const bareId = stripLegacyClaudeCodeContextSuffix(id);
    const info = catalog.find((model) => model.id === bareId);
    options.push({
      // Claude Code resolves aliases before looking up the confirmation and
      // current-model label. Key the row by that resolved identity so both
      // the picker and subsequent messages use the catalog's Friendli name.
      model: SLOT_CLAUDE_ID[slot],
      label: info?.label ?? bareId,
      description: info?.description ?? `Friendli model for ${slot}`,
    });
  }
  const main = stripLegacyClaudeCodeContextSuffix(mainModel);
  if (main && !options.some((option) => option.model === main)) {
    const info = catalog.find((model) => model.id === main);
    options.unshift({
      model: main,
      label: info?.label ?? main,
      description: info?.description ?? "Friendli session model",
    });
  }
  return options.length ? { options, replaceBuiltInOptions: true } : undefined;
}

/** `modelOverrides` entries for the mapped slots. Each maps the slot's
 * compatibility Claude id onto the Friendli model filling it, so Claude
 * Code resolves the Friendli id to a model it recognizes. `--model` (a bare
 * Friendli id) cannot be mapped this way — an override keyed by it would put
 * a Claude id in the request's `model` field nothing would understand, so a
 * mono-model `on` stays unmapped and keeps the catalog window instead. */
export function slotModelOverrides(
  mapping: ClaudeModelMapping,
): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const [slot, claudeId] of Object.entries(SLOT_CLAUDE_ID)) {
    const modelId = mapping[slot as keyof typeof SLOT_CLAUDE_ID];
    if (modelId)
      overrides[claudeId] = stripLegacyClaudeCodeContextSuffix(modelId);
  }
  return overrides;
}

export interface EnableResult {
  model: string;
  mapping: ClaudeModelMapping;
}

/** Single write path for `claude on`: snapshot first time, build the next
 * settings (preserving unrelated keys), write atomically at 0600, record
 * state. */
export async function enableFriendliProvider(
  options: ProviderPaths & {
    apiKey: string;
    apiKeySource: "flag" | "env" | "keychain";
    baseUrl: string;
    mainModel: string;
    mapping: ClaudeModelMapping;
    catalog?: FriendliModel[];
    /** Freeze Claude Code's auto-updater — only while a version pin is live. */
    pinAutoUpdate?: boolean;
    versionGuard?: { version: string | null; downgraded: boolean };
    /** Static headers generated for this `claude on`; omitted callers preserve custom headers. */
    telemetryHeaders?: Readonly<Record<string, string>>;
  },
): Promise<EnableResult> {
  const {
    settingsPath,
    dataDir,
    apiKey,
    apiKeySource,
    baseUrl,
    mainModel,
    mapping,
    catalog,
    pinAutoUpdate,
    versionGuard,
    telemetryHeaders = {},
  } = options;

  await assertRecoverableSettings(options);
  await snapshotSettingsIfNeeded(settingsPath, dataDir);

  const { raw } = await readRawIfExists(settingsPath);
  const current = parseSettings(raw);
  const { value: backup } = await readJsonIfExists<{
    snapshot?: { existed: boolean; raw: string };
  }>(providerBackupPath(dataDir));
  const original = backup?.snapshot
    ? parseSettings(backup.snapshot.raw)
    : current;
  // `off`'s restore can't reach keys left inside a merged env block, so both
  // auto-updater keys are cleaned up here instead.
  const existingEnv = { ...(current.env ?? {}) };
  for (const envKey of Object.values(SLOT_ENV_KEY)) {
    delete existingEnv[envKey];
    for (const suffix of SLOT_METADATA_SUFFIXES) {
      delete existingEnv[`${envKey}${suffix}`];
    }
  }
  delete existingEnv.CLAUDE_CODE_SUBAGENT_MODEL;
  // Rebuild our rules from the original user value on every on; otherwise a
  // later model selection inherits rules and defaults from the previous one.
  for (const key of [MODEL_CAPABILITIES_KEY, DEFAULT_MODEL_KEY]) {
    delete existingEnv[key];
    if (original.env?.[key] !== undefined) existingEnv[key] = original.env[key];
  }
  // CLAUDE_AUTO_UPDATE is inert in every Claude Code build, so dropping it
  // can't override anyone's real preference.
  delete existingEnv[LEGACY_NOOP_AUTO_UPDATE_KEY];
  delete existingEnv[MANAGED_MARKER_KEY];
  if (!(await userOwnsEnvKey(dataDir, AUTO_UPDATE_KEY))) {
    // DISABLE_AUTOUPDATER does work, so only remove one we put there: a pin
    // an earlier release wrote would otherwise ride along on every `on` and
    // freeze Claude Code long after its version pin is gone. It is re-added
    // below whenever a pin is in force.
    delete existingEnv[AUTO_UPDATE_KEY];
  }
  if (!(await userOwnsEnvKey(dataDir, MAX_CONTEXT_TOKENS_KEY))) {
    // Same dance for the context window: without this, a value written for an
    // earlier `on`'s model survives every later merge, including the catalog
    // reporting no window (or none for the new model) — where we deliberately
    // leave the key unset. It is re-added below whenever we know a window.
    delete existingEnv[MAX_CONTEXT_TOKENS_KEY];
  }
  if (!(await userOwnsEnvKey(dataDir, DISABLE_1M_CONTEXT_KEY))) {
    // And for the [1m]-variant suppressor: same ownership rule, re-added below
    // only when the window we're declaring stays within 200k.
    delete existingEnv[DISABLE_1M_CONTEXT_KEY];
  }

  const env = {
    ...existingEnv,
    ...buildFriendliProviderEnv(apiKey, baseUrl, mapping, catalog, {
      mainModel,
      pinAutoUpdate: Boolean(pinAutoUpdate),
    }),
  };
  if (Object.keys(telemetryHeaders).length > 0) {
    env.ANTHROPIC_CUSTOM_HEADERS = mergeFrlinkTelemetryHeaderLines(
      current.env?.ANTHROPIC_CUSTOM_HEADERS,
      telemetryHeaders,
    );
  }

  const next: ClaudeSettings = {
    ...current,
    env,
  };
  const ownRules = next.env?.[MODEL_CAPABILITIES_KEY];
  const userRules = original.env?.[MODEL_CAPABILITIES_KEY];
  if (next.env && ownRules && userRules && ownRules !== userRules) {
    next.env[MODEL_CAPABILITIES_KEY] = `${userRules};${ownRules}`;
  }
  const picker = modelPicker(mapping, mainModel, catalog ?? []);
  if (picker) next.modelPicker = picker;
  else if (original.modelPicker) next.modelPicker = original.modelPicker;
  else delete next.modelPicker;
  // Map each slot's compatibility Claude id onto the Friendli model
  // filling it, so Claude Code resolves Friendli ids to models it recognizes
  // — the recognized id is what lets it build thinking-off requests and size
  // the context window itself. We own every entry we write here: stale slot
  // entries are dropped so a later `on` with fewer slots doesn't leave a
  // previous mapping behind. A user's own non-slot entries are preserved.
  const slotOverrides = slotModelOverrides(mapping);
  const previousOverrides = { ...(current.modelOverrides ?? {}) };
  for (const claudeId of Object.values(SLOT_CLAUDE_ID)) {
    delete previousOverrides[claudeId];
  }
  // Remove both previous Haiku identities when migrating to adaptive thinking.
  delete previousOverrides["claude-haiku-4-5"];
  delete previousOverrides["claude-haiku-4-5-20251001"];
  next.modelOverrides = {
    ...previousOverrides,
    ...slotOverrides,
  };
  if (Object.keys(next.modelOverrides).length === 0) {
    delete next.modelOverrides;
  }
  const sessionModel = selectedSessionModel(mapping, mainModel);
  if (sessionModel) {
    next.model = sessionModel;
  } else if (original.model !== undefined) {
    next.model = original.model;
  } else {
    delete next.model;
  }
  applyServerToolsDenyList(next);

  await writeJson(settingsPath, next, { mode: 0o600 });
  const state: ProviderState = { apiKeySource, mapping };
  if (versionGuard) {
    state.versionGuard = versionGuard;
  }
  await writeJson(providerStatePath(dataDir), state, { mode: 0o600 });

  return { model: next.model || "", mapping };
}

/** Restores the raw pre-FriendliLink snapshot byte-for-byte, or deletes
 * settings.json entirely if it didn't exist before we touched it. */
export async function disableFriendliProvider(
  options: ProviderPaths,
): Promise<DisableOutcome> {
  await assertRecoverableSettings(options);
  const outcome = await restoreFileFromBackup({
    configPath: options.settingsPath,
    backupPath: providerBackupPath(options.dataDir),
  });
  if (outcome === "none") {
    return outcome;
  }
  await removeQuietly(providerStatePath(options.dataDir));
  return "restored";
}

export async function readProviderState(
  dataDir: string,
): Promise<ProviderState | undefined> {
  const { value } = await readJsonIfExists<ProviderState>(
    providerStatePath(dataDir),
  );
  return value;
}

export function friendliBaseUrl(ctx: {
  baseUrl: string;
  baseUrlFromFlag: boolean;
}): string {
  return ctx.baseUrlFromFlag && ctx.baseUrl
    ? normalizeFriendliBaseUrl(ctx.baseUrl)
    : FRIENDLI_BASE_URL;
}
