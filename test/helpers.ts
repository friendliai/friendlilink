import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface Sandbox {
  home: string;
  cleanup(): Promise<void>;
}

/** A throwaway HOME directory so tests never touch the real machine's ~/.claude or ~/.frlink. */
export async function createSandboxHome(): Promise<Sandbox> {
  const home = await mkdtemp(path.join(tmpdir(), "frlink-test-"));
  return {
    home,
    async cleanup() {
      await rm(home, { recursive: true, force: true });
    },
  };
}
