import { mkdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listHarnesses } from "../../../src/harness/registry.js";
import { createSandboxHome, type Sandbox } from "../../helpers.js";

/** SSOT: the probe ladder lives in src/harnesses/common/installed.ts —
 * this test imports it instead of mirroring it, so probe/spec drift is
 * impossible by construction. */
import {
  binaryIsRequired,
  isInstalledByMarker,
  markerDir,
  markerExecutable,
} from "../../../src/harnesses/common/installed.js";

describe("harness install probes", () => {
  let sandbox: Sandbox;
  // opencode/cursor probes read XDG_CONFIG_HOME / APPDATA when set. Point
  // them inside the sandbox so a dev/CI machine's real config dirs are
  // never read — the mkdir below would otherwise create dirs there.
  let originalXdg: string | undefined;
  let originalAppdata: string | undefined;
  let originalDshHome: string | undefined;
  let originalHermesHome: string | undefined;
  let originalPiDir: string | undefined;
  let originalPath: string | undefined;

  beforeEach(async () => {
    sandbox = await createSandboxHome();
    originalXdg = process.env.XDG_CONFIG_HOME;
    originalAppdata = process.env.APPDATA;
    originalDshHome = process.env.DSH_HOME;
    originalHermesHome = process.env.HERMES_HOME;
    originalPiDir = process.env.PI_CODING_AGENT_DIR;
    originalPath = process.env.PATH;
    process.env.XDG_CONFIG_HOME = path.join(sandbox.home, ".config");
    process.env.APPDATA = path.join(sandbox.home, "AppData", "Roaming");
    process.env.DSH_HOME = path.join(sandbox.home, ".dsh");
    process.env.HERMES_HOME = path.join(sandbox.home, ".hermes");
    process.env.PI_CODING_AGENT_DIR = path.join(sandbox.home, ".pi", "agent");
    process.env.PATH = path.join(sandbox.home, "empty-path");
  });

  afterEach(async () => {
    for (const [key, original] of [
      ["XDG_CONFIG_HOME", originalXdg],
      ["APPDATA", originalAppdata],
      ["DSH_HOME", originalDshHome],
      ["HERMES_HOME", originalHermesHome],
      ["PI_CODING_AGENT_DIR", originalPiDir],
      ["PATH", originalPath],
    ] as const) {
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
    await sandbox.cleanup();
  });

  it("every registered adapter exposes an isInstalled probe", () => {
    // Deliberate first-party contract, not an accident of `isInstalled?`
    // being optional: detection-first is the point of `all`, so an adapter
    // we ship must say whether its harness is installed — a future
    // probe-less adapter fails here, loudly, on purpose. The optional type
    // stays a runtime safety net (probe-less adapters always run, covered
    // in test/cli/all.test.ts), not permission to register without a probe.
    const missing = listHarnesses().filter(
      (harness) => typeof harness.isInstalled !== "function",
    );
    expect(missing.map((harness) => harness.id)).toEqual([]);
    // markerDir must cover the whole registry so the probe coverage below
    // stays exhaustive as new harnesses are added (its default case throws).
    for (const harness of listHarnesses()) {
      expect(
        () => markerDir(harness.id, sandbox.home),
        `${harness.id}: markerDir must have a case`,
      ).not.toThrow();
    }
  });

  it("reports not installed on a clean HOME, installed once the harness's own config dir appears", async () => {
    for (const harness of listHarnesses()) {
      const probe = harness.isInstalled!;
      expect(
        await probe(sandbox.home),
        `${harness.id}: clean home should be not installed`,
      ).toBe(false);

      const marker = markerDir(harness.id, sandbox.home)!;
      await mkdir(marker, { recursive: true });
      if (binaryIsRequired(harness.id)) {
        // These on/off flows spawn the harness's own CLI, so the binary
        // is the marker — a leftover dir without one is a half install
        // (detailed in the dedicated regression test below).
        expect(
          await probe(sandbox.home),
          `${harness.id}: dir without the binary must not read as installed`,
        ).toBe(false);
        continue;
      }
      expect(
        await probe(sandbox.home),
        `${harness.id}: marker dir should read as installed`,
      ).toBe(true);
    }
  });

  it("a config dir outliving its deleted binary reads as not installed (dsh/hermes ENOENT regression)", async () => {
    // PR #10 review scenario: `~/.dsh` existed but the `dsh` binary had
    // been deleted — the dir-only probe said "installed" and `all on`
    // crashed with `spawn dsh ENOENT` after resolving the key and model.
    // For harnesses whose on/off shells out to their own CLI, installed
    // ⇔ executable binary on PATH, dir or no dir.
    for (const id of ["dsh", "hermes"] as const) {
      const marker = markerDir(id, sandbox.home)!;
      await mkdir(marker, { recursive: true });
      const probe = listHarnesses().find((h) => h.id === id)!.isInstalled!;
      expect(
        await probe(sandbox.home),
        `${id}: leftover dir, deleted binary must read as not installed`,
      ).toBe(false);
    }
  });

  it("cursor reads as not installed when only the ancestor app-data dir exists (darwin regression)", async () => {
    // the marker bug resolved to ~/Library/Application Support — present on
    // every macOS machine, so a never-installed Cursor read as installed.
    const platform = process.platform;
    const parent =
      platform === "darwin"
        ? path.join(sandbox.home, "Library", "Application Support")
        : platform === "win32"
          ? path.join(sandbox.home, "AppData", "Roaming")
          : path.join(sandbox.home, ".config");
    await mkdir(parent, { recursive: true });
    const probe = listHarnesses().find((h) => h.id === "cursor")!.isInstalled!;
    expect(await probe(sandbox.home)).toBe(false);
  });

  it("a harness installed as a binary but never run still reads as installed (PATH rung)", async () => {
    const { chmod, writeFile } = await import("node:fs/promises");
    const binDir = path.join(sandbox.home, "bin");
    await mkdir(binDir, { recursive: true });
    // cursor has no binary rung by construction (markerExecutable returns
    // ""): the IDE binary on PATH proves nothing about the app-data we
    // mutate, so even a `cursor` executable must leave it not installed.
    const fakeCursor = path.join(binDir, "cursor");
    await writeFile(fakeCursor, "#!/bin/sh\n");
    await chmod(fakeCursor, 0o755);
    process.env.PATH = binDir;
    expect(
      await isInstalledByMarker("cursor", sandbox.home),
      "cursor: IDE binary on PATH must not read as installed",
    ).toBe(false);
    process.env.PATH = path.join(sandbox.home, "empty-path");
    for (const harness of listHarnesses()) {
      const exec = markerExecutable(harness.id);
      if (!exec) {
        continue;
      }
      expect(
        await isInstalledByMarker(harness.id, sandbox.home),
        `${harness.id}: binary alone should read as installed`,
      ).toBe(false);
      const fake = path.join(binDir, exec);
      await writeFile(fake, "#!/bin/sh\n");
      await chmod(fake, 0o755);
      process.env.PATH = binDir;
      expect(
        await isInstalledByMarker(harness.id, sandbox.home),
        `${harness.id}: binary on PATH should read as installed`,
      ).toBe(true);
      process.env.PATH = path.join(sandbox.home, "empty-path");
    }
  });
});
