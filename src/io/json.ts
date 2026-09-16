import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "./atomic-write.js";

export interface RawFile {
  existed: boolean;
  raw: string;
}

/** Raw text read, distinguishing "file absent" from "file empty". */
export async function readRawIfExists(filePath: string): Promise<RawFile> {
  try {
    const raw = await readFile(filePath, "utf8");
    return { existed: true, raw };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { existed: false, raw: "" };
    }
    throw error;
  }
}

export async function readJsonIfExists<T>(
  filePath: string,
): Promise<{ existed: boolean; value: T | undefined }> {
  const { existed, raw } = await readRawIfExists(filePath);
  if (!existed || !raw.trim()) {
    return { existed, value: undefined };
  }
  return { existed, value: JSON.parse(raw) as T };
}

export async function writeJson(
  filePath: string,
  value: unknown,
  options: { mode?: number } = {},
): Promise<void> {
  await writeFileAtomic(
    filePath,
    `${JSON.stringify(value, null, 2)}\n`,
    options,
  );
}
