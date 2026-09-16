/**
 * The plugin-lifecycle MECHANISM the plugin-based harness adapters (dsh,
 * hermes) share: the command-runner contract and the combined-output
 * wrapper for their own plugin CLI. Lifecycle POLICY — idempotency rules,
 * ownership gates, failure severity — is per-harness and stays in each
 * adapter, because each is dictated by the harness's own CLI substrate.
 *
 * TODO(plugin-lifecycle): a full lifecycle-template abstraction (prepare/enable/disable flows) stays deferred until a third plugin-based harness arrives — two implementations whose policies have converged don't yet satisfy rule-of-three.
 */

/** The minimal command-runner contract; the real one spans the harness CLI. */
export type CommandRunner = (
  file: string,
  args: string[],
  options?: { timeoutMs?: number },
) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

/** Plugin installs fetch from the network; allow a generous ceiling. */
const PLUGIN_COMMAND_TIMEOUT_MS = 180_000;

/**
 * Runs one plugin command through the given runner; stdout and stderr are
 * combined (and trimmed) so callers report everything the CLI said,
 * whichever stream it chose.
 */
export async function runPluginCommand(
  run: CommandRunner,
  file: string,
  args: string[],
): Promise<{ ok: boolean; output: string }> {
  const result = await run(file, args, {
    timeoutMs: PLUGIN_COMMAND_TIMEOUT_MS,
  });
  return {
    ok: result.ok,
    output: `${result.stdout}${result.stderr}`.trim(),
  };
}

/** What a disable flow did to the harness config. */
export type DisableOutcome = "restored" | "none";
