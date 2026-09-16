/**
 * Surgical edits to Codex config.toml — only touches frlink-owned
 * keys/tables so array-of-tables and other non-flat TOML (projects, mcp_servers,
 * tui state) is preserved byte-for-byte. Parameterized by provider id and
 * reduced to what frlink writes (the FriendliAI guide's keys,
 * verbatim).
 */

import { mergeFrlinkTelemetryHeaders } from "../../telemetry/request-headers.js";

const ROOT_MODEL_PROVIDER_LINE = /^model_provider\s*=.+$/;
const ROOT_MODEL_LINE = /^model\s*=.+$/;
const ROOT_REASONING_EFFORT_LINE = /^model_reasoning_effort\s*=.+$/;
const ROOT_MODEL_CATALOG_LINE = /^model_catalog_json\s*=.+$/;

function tomlString(value: string): string {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function tomlInlineStringMap(
  values: Readonly<Record<string, string>>,
): string | null {
  const entries = Object.entries(values);
  if (entries.length === 0) {
    return null;
  }
  return `{ ${entries.map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`).join(", ")} }`;
}

function cannotSafelyPreserveHttpHeaders(message: string): never {
  throw new Error(
    `Cannot safely preserve Codex http_headers: ${message}. Expected an inline map of quoted TOML strings.`,
  );
}

function skipTomlHorizontalWhitespace(raw: string, index: number): number {
  while (raw[index] === " " || raw[index] === "\t") {
    index += 1;
  }
  return index;
}

function parseTomlBasicString(
  raw: string,
  start: number,
): { value: string; nextIndex: number } {
  if (raw[start] !== '"') {
    cannotSafelyPreserveHttpHeaders(
      "a map key or value is not a quoted string",
    );
  }

  let value = "";
  for (let index = start + 1; index < raw.length; index += 1) {
    const character = raw[index]!;
    if (character === '"') {
      return { value, nextIndex: index + 1 };
    }
    if (character.charCodeAt(0) === 0x5c) {
      const escape = raw[index + 1];
      if (!escape) {
        cannotSafelyPreserveHttpHeaders(
          "a quoted string ends with a backslash",
        );
      }
      if (escape.charCodeAt(0) === 0x5c) {
        value += String.fromCharCode(0x5c);
        index += 1;
        continue;
      }
      if (escape === '"') {
        value += '"';
        index += 1;
        continue;
      }
      cannotSafelyPreserveHttpHeaders(
        "a quoted string uses an unsupported TOML escape",
      );
    }
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      cannotSafelyPreserveHttpHeaders(
        "a quoted string contains an unescaped control character",
      );
    }
    value += character;
  }

  cannotSafelyPreserveHttpHeaders("a quoted string is unterminated");
}

/**
 * Parses only Codex's one-line inline string-map form, preserving its semantic
 * keys and values for the next surgical provider-table rewrite.
 */
function parseTomlInlineStringMap(raw: string): Record<string, string> {
  let index = skipTomlHorizontalWhitespace(raw, 0);
  if (raw[index] !== "{") {
    cannotSafelyPreserveHttpHeaders("the value is not an inline map");
  }
  index = skipTomlHorizontalWhitespace(raw, index + 1);

  const values = Object.create(null) as Record<string, string>;
  while (raw[index] !== "}") {
    const key = parseTomlBasicString(raw, index);
    index = skipTomlHorizontalWhitespace(raw, key.nextIndex);
    if (raw[index] !== "=") {
      cannotSafelyPreserveHttpHeaders("a map entry is missing =");
    }
    index = skipTomlHorizontalWhitespace(raw, index + 1);
    const value = parseTomlBasicString(raw, index);
    if (Object.hasOwn(values, key.value)) {
      cannotSafelyPreserveHttpHeaders(
        "the inline map contains a duplicate key",
      );
    }
    values[key.value] = value.value;
    index = skipTomlHorizontalWhitespace(raw, value.nextIndex);

    if (raw[index] === "}") {
      break;
    }
    if (raw[index] !== ",") {
      cannotSafelyPreserveHttpHeaders(
        "map entries are not separated by commas",
      );
    }
    index = skipTomlHorizontalWhitespace(raw, index + 1);
    if (raw[index] === "}") {
      cannotSafelyPreserveHttpHeaders("the inline map has a trailing comma");
    }
  }

  index = skipTomlHorizontalWhitespace(raw, index + 1);
  if (raw[index] !== undefined && raw[index] !== "#") {
    cannotSafelyPreserveHttpHeaders("the inline map has trailing content");
  }
  return values;
}

/**
 * The dotted key path of a table header line, or null when the line is not
 * one. Handles what a hand-written config actually contains: surrounding
 * whitespace, a trailing comment, quoted segments, and array-of-tables.
 *
 * Matching headers by exact string cost us twice. `[projects.work]  # mine`
 * was not recognized as a header at all, so the root-key stripper kept
 * running past it and deleted the `model` / `model_provider` lines *inside*
 * that table. And `[ model_providers.friendliai ]` did not match our own
 * table, so `on` appended a second one — a duplicate table, which is a TOML
 * parse error, leaving Codex unable to start.
 */
function tableHeaderPath(
  trimmed: string,
): { path: string[]; array: boolean } | null {
  if (!trimmed.startsWith("[")) {
    return null;
  }
  const array = trimmed.startsWith("[[");
  const open = array ? 2 : 1;
  // Find the closing bracket, ignoring one inside a quoted segment.
  let quote: string | null = null;
  let close = -1;
  for (let i = open; i < trimmed.length; i++) {
    const char = trimmed[i]!;
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "]") {
      close = i;
      break;
    }
  }
  if (close === -1) {
    return null;
  }
  const inner = trimmed.slice(open, close);
  const rest = trimmed.slice(close + (array ? 2 : 1)).trim();
  // Only whitespace or a comment may follow the header on its line.
  if (array && !trimmed.slice(close).startsWith("]]")) {
    return null;
  }
  if (rest && !rest.startsWith("#")) {
    return null;
  }
  const path: string[] = [];
  let segment = "";
  quote = null;
  for (const char of inner) {
    if (quote) {
      if (char === quote) quote = null;
      else segment += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ".") {
      path.push(segment.trim());
      segment = "";
      continue;
    }
    segment += char;
  }
  path.push(segment.trim());
  return { path, array };
}

function isAnyTableHeader(trimmed: string): boolean {
  return tableHeaderPath(trimmed) !== null;
}

/** True when the line opens exactly `[model_providers.<providerId>]`,
 * however it happens to be spelled. */
function isProviderTableHeader(trimmed: string, providerId: string): boolean {
  const header = tableHeaderPath(trimmed);
  return (
    header !== null &&
    !header.array &&
    header.path.length === 2 &&
    header.path[0] === "model_providers" &&
    header.path[1] === providerId
  );
}

function providerTableHeader(providerId: string): string {
  return `[model_providers.${providerId}]`;
}

/**
 * Extracts only the documented one-line `http_headers` map before the provider
 * table is removed, so values we cannot round-trip are never silently lost.
 */
/** Matches `http_headers =`, `"http_headers" =`, and `'http_headers' =`. */
const HTTP_HEADERS_ASSIGNMENT =
  /^(?:"http_headers"|'http_headers'|http_headers)\s*=\s*(.*)$/;

function extractFriendliHttpHeaders(
  raw: string,
  providerId: string,
): Record<string, string> {
  let inProviderTable = false;
  let subTableHeader: string | undefined;
  let headers: Record<string, string> | undefined;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (isAnyTableHeader(trimmed)) {
      if (subTableHeader === undefined) {
        subTableHeader = /^\[model_providers\.[^\]]+\.http_headers\]$/.test(
          trimmed,
        )
          ? trimmed
          : undefined;
      }
      if (inProviderTable) {
        break;
      }
      inProviderTable = isProviderTableHeader(trimmed, providerId);
      continue;
    }
    if (!inProviderTable) {
      continue;
    }

    const assignment = HTTP_HEADERS_ASSIGNMENT.exec(trimmed);
    if (!assignment) {
      continue;
    }
    if (headers !== undefined) {
      cannotSafelyPreserveHttpHeaders(
        "the provider table contains http_headers more than once",
      );
    }
    headers = parseTomlInlineStringMap(assignment[1] ?? "");
  }

  if (subTableHeader !== undefined) {
    cannotSafelyPreserveHttpHeaders(
      `http_headers is also defined as the sub-table ${subTableHeader}; ` +
        `rewrite it inline first — a stale table form would conflict with ` +
        `the inline map this rewrite generates`,
    );
  }

  return headers ?? {};
}

function ensureTrailingNewline(text: string): string {
  if (!text) {
    return "";
  }
  return text.endsWith("\n") ? text : `${text}\n`;
}

export interface FriendliRouting {
  providerId: string;
  providerName: string;
  baseUrl: string;
  modelId: string;
  apiKey: string;
  /** Static custom headers supported by Codex's provider configuration. */
  telemetryHeaders?: Readonly<Record<string, string>>;
  /** `model_reasoning_effort`. Omitted entirely when absent, so the model's own
   * chat-template default applies. */
  reasoningEffort?: string;
  /** Absolute path to the Codex model catalog we generated, or undefined to
   * leave Codex on its own bundled catalog. */
  modelCatalogPath?: string;
}

/**
 * Codex 0.153 dropped the chat-completions wire: `wire_api = "chat"` is now a
 * hard config error ("no longer supported ... set `wire_api = \"responses\"`"),
 * and every request goes to `{base_url}/responses`. The default is already
 * "responses", but "chat" was the silently-correct default until it wasn't, so
 * the wire Friendli is actually reached over gets stated rather than inherited.
 */
const WIRE_API = "responses";

/**
 * Removes frlink's routing footprint: the entire
 * [model_providers.<id>] table and (optionally) the root-level routing keys.
 * User-owned tables and root keys are kept untouched.
 */
export function stripFriendliRoutingRaw(
  raw: string,
  options: { providerId: string; stripRootRouting?: boolean },
): string {
  const lines = raw.split("\n");
  const out: string[] = [];
  let skippingTable = false;
  let atRoot = true;

  for (const line of lines) {
    const trimmed = line.trim();
    if (atRoot && options.stripRootRouting) {
      if (
        ROOT_MODEL_PROVIDER_LINE.test(trimmed) ||
        ROOT_MODEL_LINE.test(trimmed) ||
        ROOT_REASONING_EFFORT_LINE.test(trimmed) ||
        ROOT_MODEL_CATALOG_LINE.test(trimmed)
      ) {
        continue;
      }
    }
    if (isAnyTableHeader(trimmed)) {
      atRoot = false;
    }
    if (isProviderTableHeader(trimmed, options.providerId)) {
      skippingTable = true;
      continue;
    }
    if (skippingTable) {
      if (isAnyTableHeader(trimmed)) {
        skippingTable = false;
        out.push(line);
      }
      continue;
    }
    out.push(line);
  }

  return ensureTrailingNewline(out.join("\n").replace(/\n+$/, "\n"));
}

/**
 * Rewrites config.toml so Codex routes through Friendli: the guide's root
 * `model` + `model_provider` keys land at the top (root keys must precede
 * any table header), and the provider table is (re)written at the end.
 * Re-running on an already-patched file is idempotent.
 */
export function patchFriendliRoutingRaw(
  raw: string,
  routing: FriendliRouting,
): string {
  // Read the current inline map before stripFriendliRoutingRaw removes the
  // provider table, then let the shared merger replace only managed names.
  const existingHttpHeaders = extractFriendliHttpHeaders(
    raw,
    routing.providerId,
  );
  const mergedHttpHeaders = mergeFrlinkTelemetryHeaders(
    existingHttpHeaders,
    routing.telemetryHeaders,
  );
  // Drop the blank lines left behind by routing-key stripping too, so
  // re-patching is byte-for-byte idempotent.
  const base = stripFriendliRoutingRaw(raw, {
    providerId: routing.providerId,
    stripRootRouting: true,
  }).replace(/^\n+/, "");
  // Root keys first, then whatever the user had, then our table — the shape
  // the FriendliAI guide shows, with user sections intact between them.
  const routingBlock = [
    `model_provider = ${tomlString(routing.providerId)}`,
    `model = ${tomlString(routing.modelId)}`,
    ...(routing.modelCatalogPath
      ? [`model_catalog_json = ${tomlString(routing.modelCatalogPath)}`]
      : []),
    ...(routing.reasoningEffort
      ? [`model_reasoning_effort = ${tomlString(routing.reasoningEffort)}`]
      : []),
  ].join("\n");
  const httpHeaders = tomlInlineStringMap(mergedHttpHeaders);
  const tablesBlock = [
    providerTableHeader(routing.providerId),
    `name = ${tomlString(routing.providerName)}`,
    `base_url = ${tomlString(routing.baseUrl)}`,
    `experimental_bearer_token = ${tomlString(routing.apiKey)}`,
    `wire_api = ${tomlString(WIRE_API)}`,
    ...(httpHeaders ? [`http_headers = ${httpHeaders}`] : []),
  ].join("\n");

  if (!base.trim()) {
    return `${routingBlock}\n\n${tablesBlock}\n`;
  }
  const separator = base.endsWith("\n") ? "" : "\n";
  return `${routingBlock}\n\n${base}${separator}\n${tablesBlock}\n`;
}

/** Value of a root-level `key = "value"` line, or null when absent. TOML
 * literal strings (single-quoted) are valid too, and a hand-written config may
 * well use them. */
export function rootString(raw: string, key: string): string | null {
  const pattern = new RegExp(`^${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (isAnyTableHeader(trimmed)) {
      return null;
    }
    const match = pattern.exec(trimmed);
    if (match) {
      return match[1] ?? match[2] ?? null;
    }
  }
  return null;
}
