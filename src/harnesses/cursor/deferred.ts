import { spawn } from "node:child_process";
import path from "node:path";
import { readJsonIfExists, writeJson } from "../../io/json.js";
import { removeQuietly } from "../common/backup.js";

/**
 * Cursor caches its whole store in memory at launch and flushes changed keys
 * back on quit, without watching the file — so anything we write while it is
 * open is overwritten by that flush. Run from Cursor's own terminal we cannot
 * ask the user to quit either, because quitting kills the command.
 *
 * So the work is deferred: a detached copy of this CLI waits for Cursor to
 * exit and then applies it, when there is no cache left to clobber it.
 */

export interface PendingOperation {
  verb: "on" | "off";
  queuedAt: string;
  /** Where the detached run reports what happened. */
  logPath: string;
}

export function pendingPath(dataDir: string): string {
  return path.join(dataDir, "pending.json");
}

export function deferredLogPath(dataDir: string): string {
  return path.join(dataDir, "pending.log");
}

export async function readPending(
  dataDir: string,
): Promise<PendingOperation | undefined> {
  const { value } = await readJsonIfExists<PendingOperation>(
    pendingPath(dataDir),
  );
  return value;
}

export async function clearPending(dataDir: string): Promise<void> {
  await removeQuietly(pendingPath(dataDir));
}

/**
 * Re-launch this command detached, to run once Cursor has exited. The child
 * gets the same argv plus the flag that makes it wait first, so every path
 * and key flag the user passed still applies.
 */
export async function deferUntilCursorExits(options: {
  verb: "on" | "off";
  dataDir: string;
  argv?: string[];
  now?: () => string;
  spawnFn?: typeof spawn;
}): Promise<PendingOperation> {
  const { verb, dataDir } = options;
  const argv = options.argv ?? process.argv.slice(2);
  const pending: PendingOperation = {
    verb,
    queuedAt: (options.now ?? (() => new Date().toISOString()))(),
    logPath: deferredLogPath(dataDir),
  };
  // Written before the spawn: a marker with no child is recoverable, a child
  // with no marker is invisible.
  await writeJson(pendingPath(dataDir), pending, { mode: 0o600 });

  const child = (options.spawnFn ?? spawn)(
    process.execPath,
    // execArgv carries any loader (tsx) this run needed; without it a dev
    // run would respawn plain node on a TypeScript entry point.
    [...process.execArgv, process.argv[1] ?? "", ...argv, AWAIT_FLAG],
    { detached: true, stdio: "ignore", env: process.env },
  );
  child.unref();
  return pending;
}

/** Internal: makes a run wait for Cursor to exit before doing anything. */
export const AWAIT_FLAG = "--await-cursor-exit";
