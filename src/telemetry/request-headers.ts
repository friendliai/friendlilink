import { readFileSync } from "node:fs";

/** The only request-header names FriendliLink creates and manages. */
const MANAGED_NAMES = new Set(["x-title", "http-referer"]);
const VERSION_PATTERN = /\bv?(\d+\.\d+\.\d+)\b/;
const HARNESS_TITLES: Readonly<Record<string, string>> = Object.freeze({
  claude: "Claude Code",
  codex: "Codex",
  dsh: "DeepSeek Harness",
  hermes: "Hermes Agent",
  opencode: "OpenCode",
  pi: "Pi",
});

type HeaderRecord = Readonly<Record<string, string>>;

function readLocalVersion(): string | undefined {
  try {
    const packageJson = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown };
    return typeof packageJson.version === "string"
      ? packageJson.version
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizedVersion(value: unknown): string {
  return String(value ?? "").match(VERSION_PATTERN)?.[1] ?? "";
}

/** Narrow an unknown config value to a plain object for safe spreading. */
export function objectOrEmpty(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Keep only string-valued entries, discarding junk a hand-edited config may hold. */
export function staticTelemetryHeaders(value: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(objectOrEmpty(value))) {
    if (typeof headerValue === "string") {
      headers[name] = headerValue;
    }
  }
  return headers;
}

/**
 * Builds the two static attribution headers for a supported FriendliLink harness.
 * The package version is read defensively when no explicit version is supplied.
 */
export function buildFrlinkTelemetryHeaders(
  harnessId: string,
  {
    frlinkVersion = readLocalVersion(),
  }: {
    frlinkVersion?: unknown;
  } = {},
): { "X-Title": string; "HTTP-Referer": string } {
  const harnessTitle = HARNESS_TITLES[harnessId];
  if (!harnessTitle) {
    throw new Error(
      `No request attribution title configured for harness: ${harnessId}`,
    );
  }

  const safeVersion = normalizedVersion(frlinkVersion);
  return {
    "X-Title": harnessTitle,
    "HTTP-Referer": safeVersion ? `frlink/v${safeVersion}` : "frlink/unknown",
  };
}

/** Returns object headers after removing FriendliLink-managed names case-insensitively. */
export function stripFrlinkTelemetryHeaders(
  headers: HeaderRecord = {},
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !MANAGED_NAMES.has(name.toLowerCase()),
    ),
  );
}

/** Replaces object-form FriendliLink headers while preserving unrelated headers verbatim. */
export function mergeFrlinkTelemetryHeaders(
  existing: HeaderRecord = {},
  telemetry: HeaderRecord = {},
): Record<string, string> {
  return {
    ...stripFrlinkTelemetryHeaders(existing),
    ...telemetry,
  };
}

/** Returns non-empty newline header lines after removing managed names case-insensitively. */
export function stripFrlinkTelemetryHeaderLines(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .split("\n")
    .filter((line) => {
      const colon = line.indexOf(":");
      const name =
        colon === -1 ? "" : line.slice(0, colon).trim().toLowerCase();
      return line.trim() && !MANAGED_NAMES.has(name);
    })
    .join("\n");
}

/** Replaces managed newline header lines while preserving unrelated lines verbatim. */
export function mergeFrlinkTelemetryHeaderLines(
  value: unknown,
  telemetry: HeaderRecord = {},
): string {
  const managed = Object.entries(telemetry)
    .map(([name, headerValue]) => `${name}: ${headerValue}`)
    .join("\n");

  return [managed, stripFrlinkTelemetryHeaderLines(value)]
    .filter(Boolean)
    .join("\n");
}
