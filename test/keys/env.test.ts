import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeOwnedEnvKey } from "../../src/keys/env.js";
import { getDotenvPath, hermesHome } from "../../src/keys/env-path.js";
import { createSandboxHome } from "../helpers.js";

const KEY = "FRIENDLIAI_API_KEY";

/** Saves/restores $HERMES_HOME around a test body. */
async function withHermesHome<T>(
  value: string | undefined,
  body: () => Promise<T> | T,
): Promise<T> {
  const original = process.env.HERMES_HOME;
  if (value === undefined) {
    delete process.env.HERMES_HOME;
  } else {
    process.env.HERMES_HOME = value;
  }
  try {
    return await body();
  } finally {
    if (original === undefined) {
      delete process.env.HERMES_HOME;
    } else {
      process.env.HERMES_HOME = original;
    }
  }
}

describe("hermesHome / getDotenvPath", () => {
  it("defaults to ~/.hermes under the provided home", async () => {
    await withHermesHome(undefined, () => {
      const home = "/fake/home";
      expect(hermesHome(home)).toBe("/fake/home/.hermes");
      expect(getDotenvPath(home)).toBe("/fake/home/.hermes/.env");
    });
  });

  it("follows $HERMES_HOME so the written key lands where hermes reads it", async () => {
    await withHermesHome("/fake/hermes-home", () => {
      expect(hermesHome("/unrelated/home")).toBe("/fake/hermes-home");
      expect(getDotenvPath("/unrelated/home")).toBe("/fake/hermes-home/.env");
    });
  });

  it("ignores a whitespace-only HERMES_HOME", async () => {
    await withHermesHome("  ", () => {
      expect(getDotenvPath("/fake/home")).toBe("/fake/home/.hermes/.env");
    });
  });
});

describe("writeOwnedEnvKey writes to the hermes home", () => {
  it("lands in $HERMES_HOME/.env, not the unix home's", async () => {
    const sandbox = await createSandboxHome();
    try {
      await withHermesHome(join(sandbox.home, "hermes-home"), async () => {
        await writeOwnedEnvKey({
          dataDir: join(sandbox.home, "data"),
          envPath: getDotenvPath(sandbox.home),
          key: KEY,
          value: "sandbox-key",
        });
        expect(
          await readFile(join(sandbox.home, "hermes-home", ".env"), "utf8"),
        ).toBe(`${KEY}=sandbox-key\n`);
        // The unix-home ~/.hermes directory must not have been created.
        const { access } = await import("node:fs/promises");
        await expect(access(join(sandbox.home, ".hermes"))).rejects.toThrow();
      });
    } finally {
      await sandbox.cleanup();
    }
  });
});

describe("writeOwnedEnvKey", () => {
  it("creates, replaces, and preserves other lines", async () => {
    const sandbox = await createSandboxHome();
    try {
      const envPath = getDotenvPath(sandbox.home);
      const dataDir = join(sandbox.home, "data");
      const write = (value: string) =>
        writeOwnedEnvKey({ dataDir, envPath, key: KEY, value });

      // Creates the file when missing.
      await write("first-key");
      expect(await readFile(envPath, "utf8")).toBe(`${KEY}=first-key\n`);

      // Drop-all-then-append: the fresh value always lands at the end.
      await writeFile(envPath, `OTHER=keep\n${KEY}=old\nANOTHER=also\n`);
      await write("second-key");
      expect(await readFile(envPath, "utf8")).toBe(
        `OTHER=keep\nANOTHER=also\n${KEY}=second-key\n`,
      );

      // Duplicate KEY lines are all removed; only the fresh value survives.
      await writeFile(envPath, `OTHER=keep\n${KEY}=stale-1\n${KEY}=stale-2\n`);
      await write("third-key");
      expect(await readFile(envPath, "utf8")).toBe(
        `OTHER=keep\n${KEY}=third-key\n`,
      );
    } finally {
      await sandbox.cleanup();
    }
  });
  it("rejects a non-ENOENT read error instead of wiping the file", async () => {
    const sandbox = await createSandboxHome();
    try {
      const envPath = getDotenvPath(sandbox.home);
      const dataDir = join(sandbox.home, "data");
      await writeOwnedEnvKey({
        dataDir,
        envPath,
        key: KEY,
        value: "first",
      });
      // Root ignores file modes — the read succeeds, so there's nothing to
      // propagate.
      if (process.getuid?.() === 0) return;
      const { chmod } = await import("node:fs/promises");
      await chmod(envPath, 0o000);
      await expect(
        writeOwnedEnvKey({ dataDir, envPath, key: KEY, value: "second" }),
      ).rejects.toThrow();
      await chmod(envPath, 0o600);
      // The failed write must not have wiped the existing contents.
      expect(await readFile(envPath, "utf8")).toBe(`${KEY}=first\n`);
    } finally {
      await sandbox.cleanup();
    }
  });
});
