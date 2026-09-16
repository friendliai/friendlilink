import { existsSync } from "node:fs";
import path from "node:path";
import { runCommand } from "../../system/exec.js";
import { hermesHome } from "../../keys/env-path.js";
import {
  runPluginCommand,
  type CommandRunner,
} from "../common/plugin-runner.js";

export const PLUGIN_SOURCE = "friendliai/hermes-friendliai-provider";
/** The plugin key hermes installs under (directory / `plugins list` name). */
export const PLUGIN_NAME = "friendliai-provider";
/** The provider slug the plugin registers in hermes' model block. */
export const PLUGIN_PROVIDER = "friendli";

/**
 * Whether the plugin is already installed under the hermes home — probed
 * BEFORE `hermes plugins install` so `off` can tell an install of ours from
 * one the user already had, and leave the user's in place.
 */
export function pluginAlreadyInstalled(home: string): boolean {
  return existsSync(path.join(hermesHome(home), "plugins", PLUGIN_NAME));
}

/** The single definition lives in the shared mechanism module; re-exported
 * so the adapter's own import sites stay stable. */
export type { CommandRunner };

/**
 * Installs the Friendli provider plugin. Idempotent: an "already exists"
 * failure is success (re-running `hermes on` must not break). Throws with
 * hermes' output for every other failure so the CLI surfaces the real
 * cause (repo not found, network, corrupt install...).
 */
export async function installFriendliPlugin(
  run?: CommandRunner,
): Promise<void> {
  run ??= runCommand;
  const { ok, output } = await runPluginCommand(run, "hermes", [
    "plugins",
    "install",
    PLUGIN_SOURCE,
  ]);
  if (!ok && !/already exists/i.test(output)) {
    throw new Error(
      `hermes plugins install ${PLUGIN_SOURCE} failed: ${output}`,
    );
  }
}

/** Removes the plugin; a failure is reported by the caller, not thrown. */
export async function removeFriendliPlugin(
  run?: CommandRunner,
): Promise<{ ok: boolean; output: string }> {
  run ??= runCommand;
  return runPluginCommand(run, "hermes", ["plugins", "remove", PLUGIN_NAME]);
}
