import {
  ensureIdeStopped,
  isIdeRunning,
  isRunningInsideIde,
  type IdeProcessSpec,
} from "../../system/ide-running.js";

/** Verified against real Cursor cmdlines: the main process owns the store;
 * Electron helper/GPU/utility children (`--type=…`) do not. */
const CURSOR_PROCESS_SPEC: IdeProcessSpec = {
  darwinPattern: "Cursor.app/Contents/MacOS/Cursor",
  // Unanchored + trailing boundary so /opt/cursor/cursor etc. match.
  linuxPattern: "[/]cursor([[:space:]]|$)",
  linuxCmdlineMatches: (cmdline) => !/\s--type=/.test(cmdline),
  windowsImage: "Cursor\\.exe",
  // Anchored and space-free, so only a real executable path qualifies.
  executableMatches: (executable) =>
    /^[^ ]*\/Cursor\.app\/Contents\/MacOS\/Cursor$/.test(executable) ||
    /^[^ ]*\/cursor$/i.test(executable),
};

const CURSOR_RUNNING_MESSAGE =
  "Cursor IDE is running. Quit Cursor IDE fully (Cmd-Q / File > Quit) so the write isn't " +
  "overwritten by Cursor's in-memory state, then rerun. Or pass --force to write anyway (not recommended).";

/** Wait for Cursor to be quit before writing (interactive wait-retry;
 * non-interactive throws; --force downgrades to a warning). */
export function stopCursor(force: boolean): Promise<void> {
  return ensureIdeStopped({
    spec: CURSOR_PROCESS_SPEC,
    label: "Cursor IDE",
    runningMessage: CURSOR_RUNNING_MESSAGE,
    force,
  });
}

/** Whether Cursor currently owns its store. Read-only — used by `on`/`off`'s
 * guard above, and by the diagnostics in scripts/ to explain a stale read. */
export function isCursorRunning(): boolean {
  return isIdeRunning(CURSOR_PROCESS_SPEC);
}

/** Whether this command was typed into Cursor's own terminal. */
export function isInsideCursor(): boolean {
  return isRunningInsideIde(CURSOR_PROCESS_SPEC);
}

/** Test seam: the executable predicate the ancestry walk uses. */
export const CURSOR_EXECUTABLE_MATCHES_FOR_TESTS =
  CURSOR_PROCESS_SPEC.executableMatches!;

/** Poll until Cursor is gone. Resolves false if it outlives the deadline. */
export async function waitForCursorExit(
  options: {
    pollMs?: number;
    maxWaitMs?: number;
    isRunning?: () => boolean;
  } = {},
): Promise<boolean> {
  const { pollMs = 2000, maxWaitMs = 12 * 60 * 60 * 1000 } = options;
  const isRunning = options.isRunning ?? isCursorRunning;
  const deadline = Date.now() + maxWaitMs;
  while (isRunning()) {
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return true;
}
