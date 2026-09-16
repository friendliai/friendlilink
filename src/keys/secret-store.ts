import { readFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stateEntry } from "../config/paths.js";
import { writeFileAtomic } from "../io/atomic-write.js";

/** The keychain service this CLI writes under. */
export const SECRET_SERVICE = "FriendliLink";
/** Names the vendor, not this product — unchanged by the rename. */
export const SECRET_ACCOUNT = "friendli-api-key";

/**
 * Subset of `cross-keychain`'s API this module relies on, typed locally since
 * the package ships no bundled types.
 */
interface CrossKeychainModule {
  setPassword(service: string, account: string, value: string): Promise<void>;
  getPassword(service: string, account: string): Promise<string | null>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

let keychainModulePromise: Promise<CrossKeychainModule | null> | null = null;

/** Lazily import cross-keychain once per process; null if it can't load (no native backend on this platform, missing optional dep, etc). */
async function loadKeychainModule(): Promise<CrossKeychainModule | null> {
  if (!keychainModulePromise) {
    keychainModulePromise = import("cross-keychain")
      .then((mod) => mod as unknown as CrossKeychainModule)
      .catch(() => null);
  }
  return keychainModulePromise;
}

const API_KEY_FILE = ".api-key";

function plaintextFallbackPath(home: string): string {
  return stateEntry(home, API_KEY_FILE);
}

async function readPlaintextFallback(home: string): Promise<string | null> {
  try {
    const raw = await readFile(plaintextFallbackPath(home), "utf8");
    return raw.trim() || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/** True if `home` resolves inside the OS temp directory — a strong signal
 * that `$HOME` was overridden (deliberately, e.g. a sandboxed shell, or by
 * mistake) rather than pointing at the user's real profile. A key written
 * there won't be found again once that override goes away. */
function looksLikeTempHome(home: string): boolean {
  const tmp = path.resolve(os.tmpdir());
  const resolved = path.resolve(home);
  return resolved === tmp || resolved.startsWith(tmp + path.sep);
}

/**
 * One line, whatever the reason: this is a normal, expected fallback (no
 * keychain on this OS, a sandboxed/CI run, a locked keychain, ...), not a
 * frlink failure — so it shouldn't read like a wall of errors.
 */
async function writePlaintextFallback(
  home: string,
  value: string,
  reason?: string,
): Promise<void> {
  const tempHomeNote = looksLikeTempHome(home)
    ? " — this looks like a temp directory; if $HOME wasn't meant to point here, the key won't be found next time"
    : "";
  console.warn(
    `frlink: ${reason ?? "no OS keychain available"} — saving the API key to ` +
      `${plaintextFallbackPath(home)} instead (owner-only permissions)${tempHomeNote}.`,
  );
  await writeFileAtomic(plaintextFallbackPath(home), value, { mode: 0o600 });
}

async function deletePlaintextFallback(home: string): Promise<void> {
  await unlink(plaintextFallbackPath(home)).catch(() => {});
}

export async function setSecret(home: string, value: string): Promise<void> {
  const trimmed = value.trim();
  const keychain = await loadKeychainModule();
  if (!keychain) {
    await writePlaintextFallback(home, trimmed);
    return;
  }
  try {
    await keychain.setPassword(SECRET_SERVICE, SECRET_ACCOUNT, trimmed);
    const readback = await keychain.getPassword(SECRET_SERVICE, SECRET_ACCOUNT);
    if (!readback || readback.trim() !== trimmed) {
      throw new Error(
        "Storage verification failed: the key could not be read back from the keychain.",
      );
    }
  } catch (error) {
    // Keychain write/verify failed (locked, denied, unsupported backend) —
    // fall back rather than losing the key entirely. Native errors can carry
    // a multi-line "Caused by" chain; keep only the first line so this stays
    // one readable warning instead of a wall of text.
    const reason = (error as Error).message.split("\n")[0];
    await writePlaintextFallback(
      home,
      trimmed,
      `OS keychain unavailable (${reason})`,
    );
  }
}

export async function getSecret(home: string): Promise<string | null> {
  const keychain = await loadKeychainModule();
  if (keychain) {
    try {
      const value = (
        await keychain.getPassword(SECRET_SERVICE, SECRET_ACCOUNT)
      )?.trim();
      if (value) {
        return value;
      }
    } catch {
      // locked, denied, or unsupported — fall through to the file fallback
    }
  }
  return readPlaintextFallback(home);
}

export async function deleteSecret(home: string): Promise<void> {
  const keychain = await loadKeychainModule();
  if (keychain) {
    await keychain
      .deletePassword(SECRET_SERVICE, SECRET_ACCOUNT)
      .catch(() => {});
  }
  await deletePlaintextFallback(home);
}
