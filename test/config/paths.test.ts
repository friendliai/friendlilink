import { mkdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  harnessDataDir,
  stateEntry,
  STATE_DIR,
} from "../../src/config/paths.js";
import { createSandboxHome, type Sandbox } from "../helpers.js";

describe("state path resolution", () => {
  let sandbox: Sandbox;
  const next = (...p: string[]) => path.join(sandbox.home, STATE_DIR, ...p);

  beforeEach(async () => {
    sandbox = await createSandboxHome();
  });
  afterEach(async () => {
    await sandbox.cleanup();
  });

  it("resolves every entry under the one state root", () => {
    expect(stateEntry(sandbox.home, "claude")).toBe(next("claude"));
    expect(stateEntry(sandbox.home, "config.json")).toBe(next("config.json"));
  });

  it("lets an explicit --data-dir win over the state root", () => {
    expect(harnessDataDir(sandbox.home, "pi", "/tmp/elsewhere")).toBe(
      "/tmp/elsewhere",
    );
    expect(harnessDataDir(sandbox.home, "pi")).toBe(next("pi"));
  });

  it("resolves the dir, which files inside it join into", async () => {
    await mkdir(next("codex"), { recursive: true });
    const dir = harnessDataDir(sandbox.home, "codex");
    expect(path.join(dir, "codex-models.json")).toBe(
      next("codex", "codex-models.json"),
    );
  });
});
