import { describe, expect, it, vi } from "vitest";
import { ensureIdeStopped } from "../../src/system/ide-running.js";
import { CURSOR_EXECUTABLE_MATCHES_FOR_TESTS } from "../../src/harnesses/cursor/guard.js";

const spec = {
  darwinPattern: "Cursor.app/Contents/MacOS/Cursor",
  linuxPattern: "[/]cursor([[:space:]]|$)",
  windowsImage: "Cursor\\.exe",
};

describe("ensureIdeStopped", () => {
  it("returns immediately when the IDE is not running", async () => {
    const log = vi.fn();
    await ensureIdeStopped({
      spec,
      label: "Cursor IDE",
      runningMessage: "quit it",
      isRunning: () => false,
      log,
    });
    expect(log).not.toHaveBeenCalled();
  });

  it("warns and returns with --force even while running", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await ensureIdeStopped({
        spec,
        label: "Cursor IDE",
        runningMessage: "quit it",
        force: true,
        isRunning: () => true,
      });
      expect(warnSpy).toHaveBeenCalledWith("quit it");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("throws in non-interactive sessions while the IDE runs", async () => {
    await expect(
      ensureIdeStopped({
        spec,
        label: "Cursor IDE",
        runningMessage: "quit it",
        isRunning: () => true,
      }),
    ).rejects.toThrow("quit it");
  });

  it("throws once the wait deadline passes without the IDE quitting", async () => {
    let clock = 0;
    const tickedNow = () => (clock += 100_000); // deadline ≤ every subsequent read
    await expect(
      ensureIdeStopped({
        spec,
        label: "Cursor IDE",
        runningMessage: "quit it",
        isRunning: () => true,
        stdin: { isTTY: true }, // deadline branch is only reachable interactively
        now: tickedNow,
        maxWaitMs: 90_000,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/still appears to be running after 90s/);
  });
});

describe("running inside the IDE's own terminal", () => {
  it("proceeds without asking the user to quit", async () => {
    const log = vi.fn();
    // Quitting would kill this command, so `on`/`off` run and the caller
    // asks for a restart instead. Also covers pgrep missing the IDE there.
    await ensureIdeStopped({
      spec,
      label: "Cursor IDE",
      runningMessage: "quit it",
      isRunning: () => true,
      isInside: () => true,
      stdin: { isTTY: true },
      log,
    });
    expect(log).not.toHaveBeenCalled();
  });
});

describe("Cursor executable matching (ancestry walk)", () => {
  const matches = CURSOR_EXECUTABLE_MATCHES_FOR_TESTS;

  it("matches the real executables", () => {
    for (const path of [
      "/Applications/Cursor.app/Contents/MacOS/Cursor",
      "/Users/me/Applications/Cursor.app/Contents/MacOS/Cursor",
      "/opt/cursor/cursor",
      "/usr/bin/cursor",
    ]) {
      expect(matches(path), path).toBe(true);
    }
  });

  it("does not match a command that merely mentions Cursor", () => {
    // Why the walk reads `ps -o comm=` and not `command=`: an argument list
    // can quote the IDE's path without being the IDE.
    for (const path of [
      "/bin/zsh",
      "/usr/bin/grep Cursor.app/Contents/MacOS/Cursor",
      "/Applications/CursorLike.app/Contents/MacOS/Other",
      "/usr/local/bin/cursor-cli",
    ]) {
      expect(matches(path), path).toBe(false);
    }
  });
});
