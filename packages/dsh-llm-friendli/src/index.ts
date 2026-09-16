/**
 * Register a {@link FriendliAdapter} on `ctx.llm` for the configured provider
 * routes. Connection facts are resolved per request from the plugin's
 * `cordis.yml` config, and the model catalog is fetched from Friendli's
 * `GET /models` at runtime — nothing about the model list is hand-maintained.
 *
 * The API key is read from the environment variable named by
 * {@link Config.apiKeyEnv} (default `FRIENDLIAI_API_KEY`) at each request, so a
 * request without any key fails with `MISSING_CREDENTIAL` rather than at load.
 *
 * @module @friendliai/dsh-llm-friendli
 */

import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { LlmError } from "@deepseek-ai/dsh-llm";
import { FriendliAdapter, PUBLIC_BASE_URL } from "./adapter.ts";
import type { FriendliConnectionOptions } from "./adapter.ts";

export { FriendliAdapter, PUBLIC_BASE_URL, httpErrorCode } from "./adapter.ts";
export type {
  FriendliConnectionOptions,
  FriendliAdapterOptions,
} from "./adapter.ts";
export { fetchModels, normalizeModel } from "./models.ts";
export type { FriendliModel, ReasoningCapability } from "./models.ts";
export type { RequestDefaults } from "./serialize.ts";

/** The plugin name and the LLM service it injects. */
export const name = "@friendliai/dsh-llm-friendli";
export const inject = ["llm"];

const DEFAULT_API_KEY_ENV = "FRIENDLIAI_API_KEY";
const DEFAULT_MODEL_CACHE_TTL_MS = 60_000;

/**
 * Plugin config, validated by the same-named schema. Every field is optional:
 * a missing key resolves through {@link Config.apiKeyEnv} at each request, an
 * omitted `baseURL` uses the public serverless endpoint, and `thinking`
 * defaults to the model's own behavior.
 */
export interface Config {
  /** Environment variable holding the bearer token; defaults to `FRIENDLIAI_API_KEY`. */
  apiKeyEnv?: string;
  /** Endpoint base; defaults to `https://api.friendli.ai/serverless/v1`. */
  baseURL?: string;
  /** Provider routes this adapter serves; defaults to `['friendli']`. */
  providers?: string[];
  /**
   * Controllable-reasoning stance for models exposing a toggle: `enabled` or
   * `disabled`. Omitted leaves the model's own default. Ignored by
   * always-reasoning models.
   */
  thinking?: "enabled" | "disabled";
  /** Model-catalog cache TTL in milliseconds (default 60,000). */
  modelCacheTtlMs?: number;
  /**
   * Extra static headers merged into every provider request after the
   * harness attribution set (per-config values win per header name).
   * Route attribution (X-Title/HTTP-Referer) is baked here at config time.
   */
  extraHeaders?: Record<string, string>;
}

export const Config: Schema<Config> = Schema.object({
  apiKeyEnv: Schema.string().default(DEFAULT_API_KEY_ENV),
  baseURL: Schema.string().default(PUBLIC_BASE_URL),
  providers: Schema.array(Schema.string()).default(["friendli"]),
  thinking: Schema.union(["enabled", "disabled"]),
  modelCacheTtlMs: Schema.number().min(0).default(DEFAULT_MODEL_CACHE_TTL_MS),
  extraHeaders: Schema.dict(Schema.string()).default({}),
});

/**
 * Read a bearer token from the process environment.
 * @param envName - the variable to read.
 * @returns the trimmed token, or `undefined` when unset/blank.
 */
function tokenFromEnv(envName: string): string | undefined {
  const raw = process.env[envName];
  const trimmed = raw?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

export function apply(ctx: Context, config: Config): void {
  const apiKeyEnv = config.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
  const providers = config.providers ?? ["friendli"];

  const options = (): FriendliConnectionOptions => ({
    baseURL: config.baseURL ?? PUBLIC_BASE_URL,
    defaults: { thinking: config.thinking },
    modelCacheTtlMs: config.modelCacheTtlMs ?? DEFAULT_MODEL_CACHE_TTL_MS,
    extraHeaders: config.extraHeaders ?? {},
  });

  const resolveApiKey = (): Promise<string> => {
    const key = tokenFromEnv(apiKeyEnv);
    if (key === undefined) {
      return Promise.reject(
        new LlmError(
          `@friendliai/dsh-llm-friendli: no API key for providers [${providers.join(", ")}];` +
            ` export ${apiKeyEnv} in the launching environment`,
          "MISSING_CREDENTIAL",
        ),
      );
    }
    return Promise.resolve(key);
  };

  // Discovery degrades to unauthenticated: GET /models is public.
  const resolveDiscoveryKey = (): Promise<string | undefined> =>
    Promise.resolve(tokenFromEnv(apiKeyEnv));

  const adapter = new FriendliAdapter({
    options,
    resolveApiKey,
    resolveDiscoveryKey,
  });
  ctx.llm.registerAdapter(providers, adapter);
}
