import { unlink } from "node:fs/promises";

/** Best-effort unlink for owned bookkeeping files; missing already means done. */
export async function removeQuietly(filePath: string): Promise<void> {
  await unlink(filePath).catch(() => {});
}
