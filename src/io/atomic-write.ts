import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

async function existingFileMode(filePath: string): Promise<number | undefined> {
  try {
    const stats = await stat(filePath);
    return stats.mode & 0o777;
  } catch {
    return undefined;
  }
}

/**
 * Write-to-temp-then-rename so a crash or concurrent read never sees a
 * half-written file. The temp file lives next to the target (rename is only
 * atomic within the same filesystem). Preserves the target's existing
 * permission mode unless `mode` is passed explicitly (e.g. 0o600 for secrets).
 */
export async function writeFileAtomic(
  filePath: string,
  data: string,
  options: { mode?: number } = {},
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const targetMode = options.mode ?? (await existingFileMode(filePath));
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    if (targetMode !== undefined) {
      await writeFile(tempPath, data, { mode: targetMode });
    } else {
      await writeFile(tempPath, data);
    }
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
  if (targetMode !== undefined) {
    await chmod(filePath, targetMode);
  }
}
