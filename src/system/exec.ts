import { spawn } from "node:child_process";

export interface CommandResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run an external command without a shell (no quoting hazards, no PATH
 * globbing). Resolves with the collected output whatever the exit code is;
 * rejects only when the command can't be started, times out, or the process
 * is killed. Callers surface `stderr` in their own error messages.
 */
export async function runCommand(
  file: string,
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk;
    });
    child.on("error", (error: Error) => {
      clearTimeout(timer);
      reject(new Error(`Failed to run \`${file}\`: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`\`${file}\` timed out after ${timeoutMs}ms`));
        return;
      }
      resolve({ ok: code === 0, exitCode: code, stdout, stderr });
    });
  });
}
