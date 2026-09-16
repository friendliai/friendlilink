import os from "node:os";

export type OnboardingMode = "auto" | "prompt" | "skip";

/** Flags + resolved state threaded through a harness command. */
export interface HarnessContext {
  home: string;
  apiKey: string;
  apiKeyFromFlag: boolean;
  baseUrl: string;
  baseUrlFromFlag: boolean;
  /** Explicit --model (pins the "main" model, skips the slot mapping). */
  main: string;
  /** Whether `main` came from the user's own `--model`, as opposed to `all on`
   * broadcasting one selection to every harness. A harness that cannot take a
   * model refuses the first and ignores the second — same distinction
   * `apiKeyFromFlag` and `baseUrlFromFlag` already draw. */
  mainFromFlag: boolean;
  opus: string;
  sonnet: string;
  haiku: string;
  fable: string;
  subagent: string;
  onboardingMode: OnboardingMode;
  json: boolean;
  settingsPath: string;
  dataDir: string;
  /** Profile name for profile-per-harness tools (dsh); "" = the tool default. */
  profile: string;
  /** `--exclude`: comma-separated harness ids `all`/`check` must skip. */
  exclude: string;
  /** --force: proceed past soft guards (e.g. the running-IDE write guard). */
  force: boolean;
  /** Internal: this run was launched detached and must wait for Cursor to
   * exit before touching anything. Not a documented flag. */
  awaitCursorExit: boolean;
  /** Static request headers baked into capable harness config during `on`. */
  telemetryHeaders: Record<string, string>;
  /** --reasoning: requested reasoning effort, or "off". Empty means unset, so
   * the model's own default applies. Read by the codex adapter only — the
   * other harnesses carry their own reasoning arrangements, so passing it to
   * them has no effect. */
  reasoning: string;
  /** Set by `all on` after it resolved, verified, and persisted the flag
   * key once: adapters' resolveVerifiedKey re-resolution then skips the
   * redundant verification+persist while still reporting source "flag". */
  apiKeyPreverified?: boolean;
}

export function createBaseContext(): HarnessContext {
  return {
    home: os.homedir(),
    apiKey: "",
    apiKeyFromFlag: false,
    baseUrl: "",
    baseUrlFromFlag: false,
    main: "",
    mainFromFlag: false,
    opus: "",
    sonnet: "",
    haiku: "",
    fable: "",
    subagent: "",
    onboardingMode: "auto",
    json: false,
    settingsPath: "",
    dataDir: "",
    profile: "",
    exclude: "",
    force: false,
    awaitCursorExit: false,
    telemetryHeaders: {},
    reasoning: "",
  };
}

export type HarnessVerb = "on" | "off" | "status";
/** Verbs the `all` command accepts — top-level `status` covers reporting for
 * every harness at once, so `all status` would duplicate it. */
export type AllVerb = "on" | "off";

export interface HarnessRoute {
  harnessId: string;
  verb: HarnessVerb;
}

export type ProviderStatus = "friendli" | "custom" | "default";

export interface OnOutcome {
  cancelled?: boolean;
}

export interface HarnessAdapter {
  id: string;
  label: string;
  /** Whether `on` should bake static FriendliLink attribution headers into the harness config. */
  telemetryHeaders?: boolean;
  on(ctx: HarnessContext): Promise<OnOutcome | void>;
  off(ctx: HarnessContext): Promise<void>;
  status(ctx: HarnessContext): Promise<void>;
  resolveKey(ctx: HarnessContext): Promise<string>;
  providerStatus(ctx: HarnessContext): Promise<ProviderStatus>;
  /** Whether the harness is present on this machine (config dir exists).
   * Used by `all` to skip harnesses the user never installed; optional so
   * a harness adapter can still work without one. */
  isInstalled?(home: string): Promise<boolean>;
}
