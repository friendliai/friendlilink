import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import os from "node:os";

/**
 * Shared "is the IDE GUI process running?" guard for harnesses that write to
 * an on-disk store the IDE may also be writing (Cursor's state.vscdb).
 * Writes while the IDE is open can be clobbered by its in-memory/WAL cache,
 * so the harness refuses — with a `--force` escape that downgrades to a
 * warning.
 */

export interface IdeProcessSpec {
  /** `pgrep -f` ERE on macOS (app bundle path). */
  darwinPattern: string;
  /** `pgrep -f` ERE on Linux (binary path/name). */
  linuxPattern: string;
  /** Optional per-hit /proc/<pid>/cmdline filter — use it to ignore Electron
   * helper children (`--type=…`) that don't own the on-disk store. */
  linuxCmdlineMatches?: (cmdline: string) => boolean;
  /** Regex fragment for the image name in `tasklist` output (Windows). */
  windowsImage: string;
  /** Does this executable path belong to the IDE? Kept separate from the
   * `pgrep` patterns above, which are POSIX EREs and not JS regexes. */
  executableMatches?: (executablePath: string) => boolean;
}

const QUIT_POLL_MS = 750;
const QUIT_WAIT_MS = 90_000;

function quitShortcut(): string {
  switch (os.platform()) {
    case "win32":
      return "Alt+F4 / File > Exit";
    case "darwin":
      return "Cmd-Q / File > Quit";
    default:
      return "Ctrl-Q / File > Quit";
  }
}

function quitInstruction(label: string): string {
  return `Quit ${label} (${quitShortcut()})`;
}

function readLinuxCmdline(pid: string): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
  } catch {
    return "";
  }
}

function anyLinuxPgrepHitMatches(
  pgrepOutput: string,
  cmdlineMatches: (cmdline: string) => boolean,
): boolean {
  for (const pid of pgrepOutput.trim().split("\n")) {
    if (!pid) {
      continue;
    }
    const cmdline = readLinuxCmdline(pid);
    if (cmdline && cmdlineMatches(cmdline)) {
      return true;
    }
  }
  return false;
}

/** True if the IDE GUI main process is currently running. */
export function isIdeRunning(spec: IdeProcessSpec): boolean {
  const platform = os.platform();
  try {
    if (platform === "win32") {
      const r = spawnSync("tasklist", ["/NH"], { encoding: "utf8" });
      // Anchor at line start and require a word boundary after, so the
      // pattern matches a whole image name and not a substring.
      const pattern = new RegExp(`^\\s*${spec.windowsImage}\\b`, "im");
      return r.status === 0 && pattern.test(r.stdout || "");
    }
    const pattern =
      platform === "darwin" ? spec.darwinPattern : spec.linuxPattern;
    const r = spawnSync("pgrep", ["-f", pattern], {
      encoding: "utf8" as const,
    });
    if (r.status !== 0 || !String(r.stdout || "").trim()) {
      return false;
    }
    if (platform === "linux" && spec.linuxCmdlineMatches) {
      return anyLinuxPgrepHitMatches(
        String(r.stdout),
        spec.linuxCmdlineMatches,
      );
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Is this process a descendant of the IDE — a command typed into its own
 * integrated terminal? `pgrep` has been seen to miss Cursor there, and the
 * guard cannot ask the user to quit an IDE that would kill this command, so
 * `on`/`off` proceed and the caller asks for a restart instead.
 */
export function isRunningInsideIde(spec: IdeProcessSpec): boolean {
  const matches = spec.executableMatches;
  if (!matches || os.platform() === "win32") {
    // No cheap ancestry walk on Windows; `tasklist` in isIdeRunning applies.
    return false;
  }
  try {
    let pid = String(process.ppid);
    // Bounded: a runaway or circular chain must not spin.
    for (
      let depth = 0;
      depth < 12 && pid && pid !== "0" && pid !== "1";
      depth++
    ) {
      // `comm=` is the executable alone; `command=` would include arguments,
      // so any shell quoting the IDE's path would match.
      const r = spawnSync("ps", ["-o", "ppid=,comm=", "-p", pid], {
        encoding: "utf8",
      });
      const line = String(r.stdout || "").trim();
      if (r.status !== 0 || !line) {
        return false;
      }
      const parsed = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!parsed) {
        return false;
      }
      const [, parent = "", executable = ""] = parsed;
      if (matches(executable)) {
        return true;
      }
      pid = parent;
    }
  } catch {
    return false;
  }
  return false;
}

/** Wait for Enter on stdin. Resolves on Enter, rejects on abort. */
function waitForEnter(signal: AbortSignal, promptText: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const abort = () => {
      cleanup();
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    };
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      rl.close();
    };
    signal.addEventListener("abort", abort, { once: true });
    rl.question(promptText, () => {
      cleanup();
      resolve();
    });
  });
}

/**
 * Interactive wait for the IDE to stop before writing (dependencies are
 * injectable so the logic is unit-testable without a real IDE):
 *
 * - IDE not running: returns immediately.
 * - `force`: warns and returns anyway.
 * - no TTY: throws — CI and scripts get the "quit it first" error verbatim.
 * - interactive: asks the user to quit, auto-detecting the exit while
 *   waiting for an Enter confirmation. Gives up after QUIT_WAIT_MS.
 *
 * frlink never closes or reopens the IDE — the user does.
 */
export async function ensureIdeStopped(options: {
  spec: IdeProcessSpec;
  label: string;
  runningMessage: string;
  force?: boolean;
  isRunning?: () => boolean;
  /** Whether this process is a descendant of the IDE (its own terminal). */
  isInside?: () => boolean;
  stdin?: { isTTY?: boolean };
  log?: (message: string) => void;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  confirm?: (message: string) => Promise<void>;
}): Promise<void> {
  const {
    spec,
    label,
    runningMessage,
    force = false,
    isRunning = () => isIdeRunning(spec),
    isInside = () => isRunningInsideIde(spec),
    stdin = process.stdin,
    log = (message: string) => console.log(message),
    pollIntervalMs = QUIT_POLL_MS,
    maxWaitMs = QUIT_WAIT_MS,
    sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
    confirm = (promptText: string) =>
      waitForEnter(new AbortController().signal, promptText),
  } = options;

  // Run from the IDE's own terminal, quitting it would kill this command, so
  // proceed; the caller tells the user to restart.
  if (isInside()) {
    return;
  }
  if (!isRunning()) {
    return;
  }
  if (force) {
    console.warn(runningMessage);
    return;
  }
  if (!stdin.isTTY) {
    throw new Error(runningMessage);
  }

  const deadline = now() + maxWaitMs;
  log(
    `${label} is running. ${quitInstruction(label)}, then press Enter — or just wait, and frlink will detect the exit.`,
  );
  log(
    "Ctrl-C cancels. Or re-run with --force to write while it's still open (not recommended).",
  );

  while (isRunning()) {
    if (now() >= deadline) {
      throw new Error(
        `${label} still appears to be running after ${Math.round(maxWaitMs / 1000)}s. ` +
          "Quit it fully (not just close the window) and re-run.",
      );
    }

    const abort = new AbortController();
    const poll = (async () => {
      // Race the user's Enter against auto-detection of the exit.
      await pollOnce({
        abort,
        isRunning,
        pollIntervalMs,
        sleep,
        deadline,
        now,
      });
    })();
    const enter = confirm("Press Enter once it's quit: ").catch(
      (error: Error) => {
        if (error.name === "AbortError") {
          return;
        }
        throw error;
      },
    );

    await Promise.race([poll, enter]);
    abort.abort();

    if (!isRunning()) {
      return;
    }
    log(
      `${label} still appears to be running. Quit it fully (not just close the window), ` +
        "then press Enter again — or wait for auto-detect.",
    );
  }
}

async function pollOnce(options: {
  abort: AbortController;
  isRunning: () => boolean;
  pollIntervalMs: number;
  sleep: (ms: number) => Promise<void>;
  deadline: number;
  now: () => number;
}): Promise<void> {
  const { abort, isRunning, pollIntervalMs, sleep, deadline, now } = options;
  while (!abort.signal.aborted) {
    if (now() >= deadline || !isRunning()) {
      return;
    }
    await sleep(pollIntervalMs);
  }
}
