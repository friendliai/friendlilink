import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";

/**
 * Electron `safeStorage`-compatible secret encryption for Cursor's OpenAI key.
 *
 * Cursor stores the key NOT as a per-secret OS keychain entry but as an
 * encrypted blob in the application-scoped `state.vscdb` (`ItemTable`, key
 * `secret://cursorAuth/openAIKey`), decrypted with Electron `safeStorage`.
 * The stored value is exactly `JSON.stringify(safeStorage.encryptString(v))`
 * — the JSON form of a Node Buffer — whose bytes are the platform ciphertext.
 * This module reproduces that ciphertext so Cursor can actually read the key.
 *
 * Platform schemes (matching Chromium's OSCrypt, which Electron wraps):
 * - macOS:   `v10` + AES-128-CBC. Key = PBKDF2-HMAC-SHA1(masterPw, "saltysalt",
 *            1003, 16). IV = 16×0x20. Master password: a random value in the
 *            login keychain under service "Cursor Safe Storage".
 * - Windows: `v10` + AES-256-GCM. Layout: v10(3) + nonce(12) + ciphertext +
 *            tag(16). The 32-byte key is DPAPI-protected and base64-encoded
 *            under `os_crypt.encrypted_key` in the `Local State` JSON file.
 * - Linux:   `v11` + AES-128-CBC with 1 PBKDF2 iteration when a keyring
 *            (libsecret) holds the master password, else `v10` with the
 *            hardcoded "peanuts" password (basic_text backend) — also 1
 *            iteration. Without a keyring the stored secret is obfuscated,
 *            not encrypted.
 *
 * macOS path tested; Windows/Linux same OSCrypt scheme, NOT verified E2E here.
 *
 * Test seam: FRLINK_SECRET_PLAINTEXT=1 → encrypt/decrypt = identity (Cursor
 * won't read it; lets harness logic run headless in CI).
 */

const APP_NAME = "Cursor";
const SALT = "saltysalt";
const MAC_ITERATIONS = 1003;
const LINUX_ITERATIONS = 1;
const KEY_LEN = 16;
const IV = Buffer.alloc(16, 0x20);
const LINUX_BASIC_PASSWORD = "peanuts";

/** `JSON.stringify(Buffer.alloc(0))` — Cursor's own "no key" shape for a
 * `secret://` cell when the user clears the key in the IDE. */
export const EMPTY_BUFFER_JSON = JSON.stringify({ type: "Buffer", data: [] });

/* Windows (Chromium OSCrypt async — AES-256-GCM with a DPAPI-protected key). */
const WIN_VERSION = "v10";
const WIN_NONCE_LEN = 12;
const WIN_TAG_LEN = 16;
const WIN_KEY_LEN = 32;
const DPAPI_PREFIX = "DPAPI";

export function plaintextMode(): boolean {
  // Strictly "1" so FRLINK_SECRET_PLAINTEXT=0 never enables it — a common
  // footgun with truthy-string env checks.
  return process.env.FRLINK_SECRET_PLAINTEXT === "1";
}

/* -------------------------------------------------------------------------- */
/* OSCrypt AES (macOS + Linux)                                                 */
/* -------------------------------------------------------------------------- */

function deriveKey(masterPassword: string, iterations: number): Buffer {
  return crypto.pbkdf2Sync(masterPassword, SALT, iterations, KEY_LEN, "sha1");
}

/** Chromium OSCrypt AES encryption (macOS `v10`, Linux `v10`/`v11`). */
export function aesEncrypt(
  plaintext: string,
  masterPassword: string,
  version: string,
  iterations = MAC_ITERATIONS,
): Buffer {
  const key = deriveKey(masterPassword, iterations);
  const cipher = crypto.createCipheriv("aes-128-cbc", key, IV);
  const body = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([Buffer.from(version, "latin1"), body]);
}

/** Chromium OSCrypt AES decryption (inverse of `aesEncrypt`). */
export function aesDecrypt(
  blob: Buffer,
  masterPassword: string,
  iterations = MAC_ITERATIONS,
): string {
  const key = deriveKey(masterPassword, iterations);
  const body = blob.subarray(3); // strip the 3-byte "vNN" version prefix
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, IV);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString(
    "utf8",
  );
}

/* -------------------------------------------------------------------------- */
/* macOS — master password from the login keychain                            */
/* -------------------------------------------------------------------------- */

/** Per-process cache: each lookup can show a Keychain prompt, and macOS
 * "Allow" is one-shot — re-lookup would re-prompt for every operation. */
const macMasterPasswordCache = new Map<string, string>();

/** Test seam: clear the cached master password. */
export function resetMacMasterPasswordCacheForTests(): void {
  macMasterPasswordCache.clear();
}

/** Read the Safe Storage master password from the macOS login keychain, or "".
 * Exported so the prompt-count behaviour can be tested off a macOS host. */
export function macReadMasterPassword(): string {
  if (macMasterPasswordCache.has("cursor")) {
    return macMasterPasswordCache.get("cursor") ?? "";
  }
  const r = spawnSync(
    "security",
    ["find-generic-password", "-s", `${APP_NAME} Safe Storage`, "-w"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    // Cache the failure too. A denied or cancelled dialog exits non-zero, and
    // an uncached "" sends the very next caller straight back to `security` —
    // a second, identically worded prompt for a user who just said no.
    macMasterPasswordCache.set("cursor", "");
    return "";
  }
  const password = String(r.stdout || "").replace(/\n$/, "");
  macMasterPasswordCache.set("cursor", password);
  return password;
}

/* -------------------------------------------------------------------------- */
/* Linux — master password from libsecret, else "peanuts" (basic backend)      */
/* -------------------------------------------------------------------------- */

/** Chromium OSCrypt v2 libsecret collection schema. */
export const LINUX_OSCRYPT_V2_SCHEMA = "chrome_libsecret_os_crypt_password_v2";

/** Whether `secret-tool` (libsecret-tools) is on PATH. */
export function linuxSecretToolOnPath(): boolean {
  try {
    const r = spawnSync("secret-tool", [], {
      encoding: "utf8",
      stdio: "ignore",
    });
    return !r.error;
  } catch {
    return false;
  }
}

/** Whether the session D-Bus has an owner for org.freedesktop.secrets. */
export function linuxDBusSecretServiceHasOwner(): boolean {
  try {
    const res = spawnSync(
      "dbus-send",
      [
        "--session",
        "--print-reply",
        "--dest=org.freedesktop.DBus",
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus.NameHasOwner",
        "string:org.freedesktop.secrets",
      ],
      { encoding: "utf8", timeout: 3000 },
    );
    if (res.error || res.status !== 0) {
      return false;
    }
    return /boolean\s+true/.test(res.stdout || "");
  } catch {
    return false;
  }
}

/** Memoized per process — Secret Service availability doesn't change mid-run. */
let secretServiceReachableMemo: boolean | undefined;

export function resetLinuxSafeStorageDetectionForTests(): void {
  secretServiceReachableMemo = undefined;
}

/** Whether a Secret Service implementation is reachable on Linux. */
export function linuxSecretServiceReachable(): boolean {
  if (secretServiceReachableMemo !== undefined) {
    return secretServiceReachableMemo;
  }
  if (process.platform !== "linux") {
    secretServiceReachableMemo = false;
    return false;
  }
  secretServiceReachableMemo =
    linuxSecretToolOnPath() || linuxDBusSecretServiceHasOwner();
  return secretServiceReachableMemo;
}

/** Whether Linux safeStorage would write an obfuscated (not encrypted) blob. */
export function linuxSafeStorageIsObfuscatedFallback(): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  return !linuxSecretServiceReachable();
}

function linuxSecretToolLookup(attrs: string[]): string {
  if (!linuxSecretToolOnPath()) {
    return "";
  }
  const r = spawnSync("secret-tool", ["lookup", ...attrs], {
    encoding: "utf8",
  });
  if (r.status === 0 && String(r.stdout || "").length > 0) {
    return String(r.stdout).replace(/\n$/, "");
  }
  return "";
}

/** Read the Chromium v2 OSCrypt master password (libsecret schema). */
function linuxOsCryptV2PasswordLookup(application: string): string {
  return linuxSecretToolLookup([
    "xdg:schema",
    LINUX_OSCRYPT_V2_SCHEMA,
    "application",
    application,
  ]);
}

/** D-Bus/libsecret fallback via python3-secretstorage when secret-tool is absent. */
function linuxPythonOsCryptV2PasswordLookup(application: string): string {
  if (!linuxDBusSecretServiceHasOwner()) {
    return "";
  }
  const script = [
    "import os, sys",
    "app = os.environ.get('FCONN_OSCRYPT_APPLICATION', '')",
    "schema = os.environ.get('FCONN_OSCRYPT_SCHEMA', '')",
    "if not app or not schema:",
    "    raise SystemExit(0)",
    "try:",
    "    import secretstorage",
    "except ImportError:",
    "    raise SystemExit(0)",
    "bus = secretstorage.dbus_init()",
    "coll = secretstorage.get_default_collection(bus)",
    "items = list(coll.search_items({'xdg:schema': schema, 'application': app}))",
    "sys.stdout.write(items[0].get_secret().decode() if items else '')",
  ].join("\n");
  const r = spawnSync("python3", ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      FCONN_OSCRYPT_APPLICATION: application,
      FCONN_OSCRYPT_SCHEMA: LINUX_OSCRYPT_V2_SCHEMA,
    },
  });
  if (r.status === 0 && String(r.stdout || "").length > 0) {
    return String(r.stdout).replace(/\n$/, "");
  }
  return "";
}

/**
 * Try the Linux keyring for the Safe Storage master password — v2 schema by
 * application attribute, then the legacy service/account pair. forEncrypt
 * restricts to `secret-tool` only (the python fallback can return stale
 * legacy passwords Electron wouldn't use for encrypting).
 */
function linuxReadMasterPassword(forEncrypt = false): string {
  const service = `${APP_NAME} Safe Storage`;
  for (const application of ["cursor", APP_NAME]) {
    const appPw =
      linuxOsCryptV2PasswordLookup(application) ||
      (forEncrypt ? "" : linuxPythonOsCryptV2PasswordLookup(application));
    if (appPw) {
      return appPw;
    }
  }
  return linuxSecretToolLookup(["service", service, "account", APP_NAME]);
}

/* -------------------------------------------------------------------------- */
/* Windows — DPAPI via PowerShell (ProtectedData, CurrentUser)                 */
/* -------------------------------------------------------------------------- */

function runPowerShell(script: string): string {
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
    },
  );
  if (r.status !== 0) {
    return "";
  }
  return String(r.stdout || "")
    .replace(/\r?\n/g, "")
    .trim();
}

/** DPAPI-unprotect a raw byte buffer. */
function windowsUnprotectBuffer(blob: Buffer): Buffer {
  const b64 = blob.toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Security",
    `$bytes=[Convert]::FromBase64String('${b64}')`,
    "$dec=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Convert]::ToBase64String($dec)",
  ].join(";");
  const out = runPowerShell(script);
  return out ? Buffer.from(out, "base64") : Buffer.alloc(0);
}

/**
 * Read the Chromium/Electron `os_crypt` master key from Cursor's `Local
 * State` JSON file: base64 under `os_crypt.encrypted_key`, with a 5-byte
 * "DPAPI" prefix, DPAPI-protected (CurrentUser).
 */
export function loadWindowsOsCryptKey(localStatePath: string): Buffer {
  let raw: string;
  try {
    raw = readFileSync(localStatePath, "utf8");
  } catch {
    throw new Error(
      `Could not read Cursor's "Local State" file at ${localStatePath}. Open Cursor once (it creates the OSCrypt key on first launch) and retry.`,
    );
  }
  let parsed: { os_crypt?: { encrypted_key?: unknown } };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `Cursor's "Local State" file at ${localStatePath} is not valid JSON.`,
    );
  }
  const encKeyB64 = parsed.os_crypt?.encrypted_key;
  if (typeof encKeyB64 !== "string" || !encKeyB64) {
    throw new Error(
      `Cursor's "Local State" file at ${localStatePath} has no os_crypt.encrypted_key. Open Cursor once and retry.`,
    );
  }
  const encKey = Buffer.from(encKeyB64, "base64");
  if (
    encKey.subarray(0, DPAPI_PREFIX.length).toString("latin1") !== DPAPI_PREFIX
  ) {
    // A non-DPAPI prefix suggests App-Bound Encryption (v20), which an
    // external process cannot replicate. Fail clearly, not corruptly.
    throw new Error(
      `Cursor's OSCrypt key in "Local State" has an unexpected prefix "${encKey.subarray(0, 5).toString("latin1")}" (expected "DPAPI"). App-Bound Encryption may be enabled; this is not supported.`,
    );
  }
  const key = windowsUnprotectBuffer(encKey.subarray(DPAPI_PREFIX.length));
  if (key.length !== WIN_KEY_LEN) {
    throw new Error(
      `DPAPI-unprotected OSCrypt key from "Local State" is ${key.length} bytes, expected ${WIN_KEY_LEN}.`,
    );
  }
  return key;
}

/** Chromium OSCrypt Windows encryption: `v10` + AES-256-GCM, tag at the end. */
export function windowsAesGcmEncrypt(plaintext: string, key32: Buffer): Buffer {
  const nonce = crypto.randomBytes(WIN_NONCE_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", key32, nonce, {
    authTagLength: WIN_TAG_LEN,
  });
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([
    Buffer.from(WIN_VERSION, "latin1"),
    nonce,
    ciphertext,
    tag,
  ]);
}

/** Chromium OSCrypt Windows decryption. */
export function windowsAesGcmDecrypt(blob: Buffer, key32: Buffer): string {
  const nonce = blob.subarray(
    WIN_VERSION.length,
    WIN_VERSION.length + WIN_NONCE_LEN,
  );
  const tag = blob.subarray(blob.length - WIN_TAG_LEN);
  const ciphertext = blob.subarray(
    WIN_VERSION.length + WIN_NONCE_LEN,
    blob.length - WIN_TAG_LEN,
  );
  const decipher = crypto.createDecipheriv("aes-256-gcm", key32, nonce, {
    authTagLength: WIN_TAG_LEN,
  });
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export interface SecretOptions {
  /** Required on Windows: path to Cursor's `Local State` file. */
  localStatePath?: string;
}

/**
 * Encrypt a secret into the exact string Cursor stores in `state.vscdb`
 * (`JSON.stringify(safeStorage.encryptString(value))`).
 */
export function encryptSecret(
  plaintext: string,
  options: SecretOptions = {},
): string {
  if (plaintextMode()) {
    return plaintext;
  }
  const platform = os.platform();
  if (platform === "darwin") {
    const pw = macReadMasterPassword();
    if (!pw) {
      throw new Error(secretEncryptionUnavailableMessage());
    }
    return JSON.stringify(aesEncrypt(plaintext, pw, "v10", MAC_ITERATIONS));
  }
  if (platform === "win32") {
    const localStatePath =
      options.localStatePath ?? windowsDefaultLocalStatePath();
    const key32 = loadWindowsOsCryptKey(localStatePath);
    return JSON.stringify(windowsAesGcmEncrypt(plaintext, key32));
  }
  const keyringPw = linuxReadMasterPassword(true);
  if (keyringPw) {
    // Keyring backend: v11 + 1 PBKDF2 iteration.
    return JSON.stringify(
      aesEncrypt(plaintext, keyringPw, "v11", LINUX_ITERATIONS),
    );
  }
  // basic_text backend: v10 + hardcoded "peanuts" password, 1 iteration.
  return JSON.stringify(
    aesEncrypt(plaintext, LINUX_BASIC_PASSWORD, "v10", LINUX_ITERATIONS),
  );
}

/** Decrypt a value read from `state.vscdb` back to plaintext; "" if it can't
 * be decrypted (including Cursor's empty-ciphertext "no key" shape). */
export function decryptSecret(
  stored: string,
  options: SecretOptions = {},
): string {
  if (stored === "" || stored == null) {
    return "";
  }
  if (plaintextMode()) {
    return stored === EMPTY_BUFFER_JSON ? "" : stored;
  }
  let blob: Buffer;
  try {
    const parsed = JSON.parse(stored) as { data?: unknown };
    if (!parsed || !Array.isArray(parsed.data)) {
      return "";
    }
    blob = Buffer.from(parsed.data);
  } catch {
    return "";
  }
  if (blob.length === 0) {
    return "";
  }
  try {
    const platform = os.platform();
    if (platform === "win32") {
      const localStatePath =
        options.localStatePath ?? windowsDefaultLocalStatePath();
      return windowsAesGcmDecrypt(blob, loadWindowsOsCryptKey(localStatePath));
    }
    const version = blob.subarray(0, 3).toString("latin1");
    let pw: string;
    let iterations: number;
    if (platform === "darwin") {
      pw = macReadMasterPassword();
      iterations = MAC_ITERATIONS;
    } else if (version === "v11") {
      pw = linuxReadMasterPassword();
      iterations = LINUX_ITERATIONS;
    } else {
      pw = LINUX_BASIC_PASSWORD;
      iterations = LINUX_ITERATIONS;
    }
    if (!pw) {
      return "";
    }
    return aesDecrypt(blob, pw, iterations);
  } catch {
    return "";
  }
}

/** Whether we can produce a blob Cursor will decrypt on this machine. */
export function isSecretEncryptionAvailable(
  options: SecretOptions = {},
): boolean {
  if (plaintextMode()) {
    return true;
  }
  const platform = os.platform();
  if (platform === "darwin") {
    return macReadMasterPassword().length > 0;
  }
  if (platform === "win32") {
    try {
      loadWindowsOsCryptKey(
        options.localStatePath ?? windowsDefaultLocalStatePath(),
      );
      return true;
    } catch {
      return false;
    }
  }
  // Linux: the basic_text backend always works; a keyring is a bonus.
  return true;
}

export function secretEncryptionUnavailableMessage(): string {
  const platform = os.platform();
  if (platform === "darwin") {
    return (
      `Could not read Cursor's "Cursor Safe Storage" key from the login Keychain, so the API key ` +
      "can't be stored where Cursor reads it. Open Cursor once (it creates this key on first launch) and retry."
    );
  }
  if (platform === "win32") {
    return (
      `Could not load Cursor's OSCrypt encryption key from its "Local State" file. ` +
      "Open Cursor once (it creates this key on first launch) and retry."
    );
  }
  return "Could not encrypt the API key for Cursor's secret storage.";
}

function windowsDefaultLocalStatePath(): string {
  const appData = process.env.APPDATA ?? "";
  return `${appData}\\Cursor\\Local State`;
}
