import path from "node:path";
import { access, constants, stat } from "node:fs/promises";
import { dshHome } from "../dsh/core.js";
import { agentDir as piAgentDir } from "../pi/core.js";
import { configPath as opencodeConfigPath } from "../opencode/core.js";
import { configPath as codexConfigPath } from "../codex/core.js";
import { configPath as hermesConfigPath } from "../hermes/core.js";
import { userSettingsPath as claudeSettingsPath } from "../claude/core.js";
import { cursorStateDbPath } from "../cursor/core.js";

/** Is `file` a regular executable file? False only for genuine absence
 * (ENOENT, ENOTDIR) or a genuinely non-executable file (EACCES on X_OK —
 * the file exists but no +x). Anything else (EMFILE, EIO, ...) propagates
 * so `partition` reports the probe failure instead of a silent skip. */
async function isExecutableFile(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return (await stat(file)).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES") {
      return false;
    }
    throw error;
  }
}

/** Weakest rung of the probe ladder — last resort for a harness installed
 * as a binary but never run (npm installs create the config dir only on
 * first launch, so a fresh install would otherwise read as "not
 * installed"). Genuine absence is the normal false. */
export async function executableOnPath(name: string): Promise<boolean> {
  const suffixes =
    process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      if (await isExecutableFile(path.join(dir, name + suffix))) {
        return true;
      }
    }
  }
  return false;
}

/** A harness's marker dirs — the SAME resolver its on/off writes through,
 * so detection and writes cannot disagree by construction. One entry each
 * (every harness resolves its config deterministically); listed as an
 * array to keep the ladder loop honest. */
export function markerDirs(id: string, home: string): string[] {
  switch (id) {
    case "claude":
      return [path.dirname(claudeSettingsPath(home))];
    case "codex":
      return [path.dirname(codexConfigPath(home))];
    case "dsh":
      return [dshHome(home)];
    case "pi":
      return [piAgentDir(home)];
    case "hermes":
      return [path.dirname(hermesConfigPath(home))];
    case "opencode":
      return [path.dirname(opencodeConfigPath(home))];
    case "cursor":
      // the user-data root, three levels up from state.vscdb
      return [
        path.dirname(path.dirname(path.dirname(cursorStateDbPath(home)))),
      ];
    default:
      throw new Error(`no marker dir known for harness: ${id}`);
  }
}

/** Binary each harness falls back to on PATH when no marker dir exists
 * (installed-but-never-run) — for dsh and hermes the ONLY rung, since
 * their on/off spawn the harness CLI itself. Empty means no binary rung
 * (cursor: the IDE binary proves nothing about the app-data we mutate). */
export function markerExecutable(id: string): string {
  switch (id) {
    case "claude":
      return "claude";
    case "codex":
      return "codex";
    case "dsh":
      return "dsh";
    case "pi":
      return "pi";
    case "hermes":
      return "hermes";
    case "opencode":
      return "opencode";
    case "cursor":
      // no binary rung: the IDE binary on PATH proves nothing about the
      // app-data we mutate — the dir marker above is Cursor's only rung.
      return "";
    default:
      return "";
  }
}

/** For test assertions and the check.SPEC table. */
export function markerDir(id: string, home: string): string | undefined {
  return markerDirs(id, home)[0];
}

/** Install probe shared by harness adapters: installed ⇔ any marker dir
 * exists, else the binary is on PATH. Only genuine absence (ENOENT,
 * ENOTDIR) reads as "not installed" — other errors (EACCES, EMFILE, ...)
 * propagate so `all` reports the probe as failed instead of silently
 * skipping a harness that may well be installed. */
export async function dirExists(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return false;
    }
    throw error;
  }
}

/** The unified probe ladder, shared by every adapter (cursor included —
 * it just has a one-entry markerDirs list and no binary rung). */
export async function isInstalledByMarker(
  id: string,
  home: string,
): Promise<boolean> {
  if (binaryIsRequired(id)) {
    // on/off shells out to the harness's own CLI, so the binary on PATH
    // IS the marker: a config dir can outlive a deleted binary (the
    // "spawn dsh ENOENT" half-install this probe once crashed on), and a
    // binary that was never run still works — detection must say exactly
    // what on/off can operate on. The dir rung stays in markerDirs for
    // the other harnesses and for write-path documentation.
    const exec = markerExecutable(id);
    return exec ? executableOnPath(exec) : false;
  }
  for (const dir of markerDirs(id, home)) {
    if (await dirExists(dir)) {
      return true;
    }
  }
  const exec = markerExecutable(id);
  return exec ? executableOnPath(exec) : false;
}

/** Harnesses whose on/off MUST spawn their own CLI binary: dsh and hermes
 * install/remove their plugin through `dsh plugin …` / `hermes plugins …`,
 * so a missing binary makes every flow fail regardless of the config dir.
 * All other adapters write config files directly and never spawn. */
export function binaryIsRequired(id: string): boolean {
  return id === "dsh" || id === "hermes";
}
