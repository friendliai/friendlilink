/**
 * Read-only report on every field that decides whether Cursor routes a model
 * through Friendli. Writes nothing, prints no secret.
 *
 *   npx tsx scripts/cursor-inspect.ts [--db <state.vscdb>] [--json]
 *
 * Cursor attaches BYOK credentials to a request only when all of these hold
 * (`getModelDetailsFromName` in Cursor 3.20's workbench bundle):
 *
 *   useOpenAIKey === true          the OpenAI BYOK slot is on
 *   openAIKey() is non-empty       the key cell is readable by Cursor
 *   openAIBaseUrl is set           where its backend should send the request
 *   the model is in the picker     userAddedModels + modelOverrideEnabled
 *   admin byokDisabled !== true    a team policy can force useOpenAIKey off
 *
 * Miss any one and the request still goes out — to Cursor's own backend, with
 * a model id it does not serve, which answers "This model is not available".
 * That error is the symptom of this checklist failing, not of a bad key.
 */

import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import os from "node:os";
import {
  decryptSecret,
  linuxSafeStorageIsObfuscatedFallback,
} from "../src/system/safestorage.js";
import { isCursorRunning } from "../src/harnesses/cursor/guard.js";
import { readItemTableValue } from "../src/system/sqlite.js";
import {
  APPLICATION_USER_KEY,
  CURSOR_AUTH_OPENAI_KEY,
  CURSOR_AUTH_OPENAI_KEY_SECRET,
  cursorStateDbPath,
  parseBlob,
} from "../src/harnesses/cursor/core.js";
import { readOwnership } from "../src/harnesses/cursor/ownership.js";

const ADMIN_SETTINGS_KEY = "adminSettings.cached";
/** Cursor's own on-disk shape for "no key". */
const EMPTY_CIPHERTEXT = JSON.stringify({ type: "Buffer", data: [] });

function fingerprint(value: string): string {
  return value
    ? createHash("sha256").update(value).digest("hex").slice(0, 16)
    : "";
}

/** Cursor's user-data root holds the Windows OSCrypt key, three levels up. */
function localStatePathFor(dbPath: string): string {
  const parts = dbPath.split(/[\\/]/);
  return [...parts.slice(0, -3), "Local State"].join("/");
}

/** The `vNN` tag Chromium writes at the head of an OSCrypt blob: v10 is
 * macOS/Windows and Linux's password-free `basic_text` backend, v11 is Linux
 * with a real keyring. Anything else is not a shape we wrote. */
function safeStorageVersion(stored: string): string {
  try {
    const data = (JSON.parse(stored) as { data?: number[] }).data;
    if (!Array.isArray(data) || data.length < 3) return "unrecognized";
    return Buffer.from(data.slice(0, 3)).toString("latin1");
  } catch {
    return "unparseable";
  }
}

interface Finding {
  ok: boolean;
  label: string;
  detail: string;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const dbFlag = argv.indexOf("--db");
  const dbPath =
    dbFlag >= 0 ? (argv[dbFlag + 1] ?? "") : cursorStateDbPath(os.homedir());
  if (!dbPath) {
    throw new Error("--db needs a path");
  }

  const raw = await readItemTableValue(dbPath, APPLICATION_USER_KEY);
  const blob = parseBlob(raw);
  const ai = (blob.aiSettings ?? {}) as Record<string, unknown>;
  const record = readOwnership(blob as Record<string, unknown>);

  const strings = (key: string): string[] => {
    const value = ai[key];
    return Array.isArray(value)
      ? value.filter((v): v is string => typeof v === "string")
      : [];
  };

  // Both cells, the way Cursor reads them: the encrypted one wins, the legacy
  // plaintext one is the fallback it promotes on first launch.
  const secretCell = await readItemTableValue(
    dbPath,
    CURSOR_AUTH_OPENAI_KEY_SECRET,
  );
  const legacyCell = await readItemTableValue(dbPath, CURSOR_AUTH_OPENAI_KEY);
  const hasSecret = Boolean(secretCell) && secretCell !== EMPTY_CIPHERTEXT;
  const decrypted = hasSecret
    ? decryptSecret(secretCell, { localStatePath: localStatePathFor(dbPath) })
    : "";
  const effectiveKey = decrypted || legacyCell;
  // The OSCrypt scheme is per-platform and only the macOS one is verified
  // end-to-end against Cursor, so say which variant is on disk. Decrypting
  // here proves our own two halves agree, not that Electron agrees with them;
  // the version prefix is what a cross-platform report needs to carry.
  const cipherVersion = hasSecret ? safeStorageVersion(secretCell) : "";

  let byokDisabled: boolean | null = null;
  try {
    const admin = await readItemTableValue(dbPath, ADMIN_SETTINGS_KEY);
    if (admin)
      byokDisabled =
        (JSON.parse(admin) as { byokDisabled?: boolean }).byokDisabled ?? false;
  } catch {
    byokDisabled = null;
  }

  const added = strings("userAddedModels");
  const enabled = strings("modelOverrideEnabled");
  const notEnabled = added.filter((id) => !enabled.includes(id));
  const baseUrl =
    typeof blob.openAIBaseUrl === "string" ? blob.openAIBaseUrl : "";

  const findings: Finding[] = [
    {
      ok: blob.useOpenAIKey === true,
      label: "useOpenAIKey",
      detail:
        blob.useOpenAIKey === true
          ? "true"
          : `${JSON.stringify(blob.useOpenAIKey)} — Cursor sends no BYOK credentials at all`,
    },
    {
      ok: Boolean(baseUrl),
      label: "openAIBaseUrl",
      detail: baseUrl || "unset",
    },
    {
      ok: Boolean(effectiveKey),
      label: "API key cell",
      detail: effectiveKey
        ? `sha256:${fingerprint(effectiveKey)} from ${decrypted ? `the secret:// cell (${cipherVersion}, ${os.platform()})` : "the legacy plaintext cell"}${
            decrypted && legacyCell ? "; plaintext fallback also present" : ""
          }`
        : hasSecret
          ? `a ${cipherVersion} ciphertext is present but did not decrypt here — Cursor will read no key`
          : "empty",
    },
    {
      ok: added.length > 0 && notEnabled.length === 0,
      label: "picker registration",
      detail:
        added.length === 0
          ? "no userAddedModels — nothing Friendli is registered"
          : notEnabled.length > 0
            ? `${added.length} added, but not enabled: ${notEnabled.join(", ")}`
            : `${added.length} added and enabled`,
    },
    {
      ok: byokDisabled !== true,
      label: "admin byokDisabled",
      detail:
        byokDisabled === null
          ? "unknown (no cached admin settings; open Cursor once)"
          : byokDisabled
            ? "true — your Cursor team forbids custom API keys; Cursor resets useOpenAIKey to false"
            : "false",
    },
  ];

  if (record?.keyFingerprint && effectiveKey) {
    findings.push({
      ok: fingerprint(effectiveKey) === record.keyFingerprint,
      label: "key matches the one `on` wrote",
      detail:
        fingerprint(effectiveKey) === record.keyFingerprint
          ? "yes"
          : `cell holds sha256:${fingerprint(effectiveKey)}, record says sha256:${record.keyFingerprint} — something rewrote it since \`on\``,
    });
  }

  const report = {
    dbPath,
    dbModified: statSync(dbPath).mtime.toISOString(),
    cursorRunning: isCursorRunning(),
    managedByFrlink: Boolean(record),
    appliedAt: record?.appliedAt ?? null,
    recordedBaseUrl: record?.baseUrl ?? null,
    userAddedModels: added,
    modelOverrideEnabled: enabled,
    hiddenBuiltIns: strings("modelOverrideDisabled"),
    platform: os.platform(),
    keyCellCipherVersion: cipherVersion || null,
    legacyPlaintextCellPresent: Boolean(legacyCell),
    catalogSize: Array.isArray(blob.availableDefaultModels2)
      ? blob.availableDefaultModels2.length
      : 0,
    findings,
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`db          : ${report.dbPath}`);
  console.log(`modified    : ${report.dbModified}`);
  console.log(
    `cursor      : ${report.cursorRunning ? "RUNNING (quit it before `on`/`off`)" : "not running"}`,
  );
  console.log(
    `frlink: ${report.managedByFrlink ? `on since ${report.appliedAt} → ${report.recordedBaseUrl}` : "no ownership record — `cursor on` has not run here"}`,
  );
  console.log(
    `models      : ${report.userAddedModels.length} registered, ${report.hiddenBuiltIns.length} built-ins hidden, catalog has ${report.catalogSize} entries`,
  );
  console.log("");
  for (const finding of report.findings) {
    console.log(
      `  ${finding.ok ? "ok  " : "FAIL"}  ${finding.label.padEnd(32)} ${finding.detail}`,
    );
  }
  if (os.platform() === "linux" && linuxSafeStorageIsObfuscatedFallback()) {
    console.log(
      "\n  note  no Secret Service on this session, so Electron obfuscates rather than\n        encrypts the key cell. `on` matches that, but it is the least-tested path.",
    );
  }
  const failed = report.findings.filter((f) => !f.ok);
  console.log("");
  console.log(
    failed.length === 0
      ? 'All BYOK preconditions hold. If a model still answers "This model is not available",\nthe request reached Cursor\'s backend anyway — capture it with scripts/friendli-relay.mjs.'
      : `${failed.length} precondition(s) failed — Cursor will route these models to its own backend.`,
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
}

await main();
