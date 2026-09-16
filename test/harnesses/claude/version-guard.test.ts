import { beforeEach, describe, expect, it, vi } from "vitest";

const runCommandMock = vi.fn();
const confirmMock = vi.fn();
const isCancelMock = vi.fn(() => false);

vi.mock("../../../src/system/exec.js", () => ({
  runCommand: (...args: unknown[]) => runCommandMock(...args),
}));

vi.mock("@clack/prompts", () => ({
  confirm: (...args: unknown[]) => confirmMock(...args),
  isCancel: (...args: unknown[]) => isCancelMock(...args),
  log: { warn: vi.fn() },
}));

const { runClaudeVersionGuard, ALLOF_422_INCOMPATIBILITY } =
  await import("../../../src/harnesses/claude/version-guard.js");

/** The guard is dormant by default, so every armed test passes the retained
 * allOf incompatibility explicitly. */
const ARMED = { incompatibility: ALLOF_422_INCOMPATIBILITY };
const LAST_COMPATIBLE_VERSION = ALLOF_422_INCOMPATIBILITY.lastCompatibleVersion;

function versionOutput(version: string) {
  return {
    ok: true,
    exitCode: 0,
    stdout: `${version} (Claude Code)\n`,
    stderr: "",
  };
}

/**
 * `runCommand` mock routing: `claude --version`, `claude doctor`
 * (install-method detection, preferred), `npm ls -g` (fallback detection for
 * CLIs without `doctor`), and the actual downgrade (`npm install -g` or
 * `claude install`). `npmManaged` defaults to true so existing npm-install
 * scenarios don't need to opt in explicitly; `doctorAvailable` defaults to
 * true and set to false simulates an older CLI without the `doctor`
 * subcommand, forcing the `npm ls -g` fallback.
 */
function mockCommandSmoke(args: {
  installed: string;
  npmOk?: boolean;
  recheck?: string;
  npmManaged?: boolean;
  doctorAvailable?: boolean;
}) {
  const npmManaged = args.npmManaged ?? true;
  const doctorAvailable = args.doctorAvailable ?? true;
  runCommandMock.mockImplementation(
    async (file: string, commandArgs: string[]) => {
      if (commandArgs[0] === "--version") {
        const hasDowngraded = runCommandMock.mock.calls.some(
          (call) => (call[1] as string[])[0] === "install",
        );
        return versionOutput(
          hasDowngraded ? (args.recheck ?? args.installed) : args.installed,
        );
      }
      if (file === "claude" && commandArgs[0] === "doctor") {
        if (!doctorAvailable) {
          return {
            ok: false,
            exitCode: 1,
            stdout: "",
            stderr: "unknown command 'doctor'",
          };
        }
        return {
          ok: true,
          exitCode: 0,
          stdout: `Config install method: ${npmManaged ? "npm" : "native"}\n`,
          stderr: "",
        };
      }
      if (file === "npm" && commandArgs[0] === "ls") {
        return npmManaged
          ? { ok: true, exitCode: 0, stdout: "", stderr: "" }
          : { ok: false, exitCode: 1, stdout: "", stderr: "" };
      }
      if (
        (file === "npm" || file === "claude") &&
        commandArgs[0] === "install"
      ) {
        if (args.npmOk === false) {
          return {
            ok: false,
            exitCode: 1,
            stdout: "",
            stderr: "EACCES: permission denied",
          };
        }
        return { ok: true, exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected command: ${file} ${commandArgs.join(" ")}`);
    },
  );
}

describe("claude code version guard", () => {
  beforeEach(() => {
    runCommandMock.mockReset();
    confirmMock.mockReset();
    isCancelMock.mockReset().mockImplementation(() => false);
  });

  it("passes the last compatible version through without prompting", async () => {
    mockCommandSmoke({ installed: LAST_COMPATIBLE_VERSION });
    const result = await runClaudeVersionGuard({ interactive: true, ...ARMED });
    expect(result).toEqual({
      outcome: "ok",
      version: LAST_COMPATIBLE_VERSION,
      downgraded: false,
    });
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("passes older compatible versions through without prompting", async () => {
    mockCommandSmoke({ installed: "2.1.100" });
    const result = await runClaudeVersionGuard({ interactive: true, ...ARMED });
    expect(result).toEqual({
      outcome: "ok",
      version: "2.1.100",
      downgraded: false,
    });
  });

  it("downgrades after consent and re-verifies the installed version", async () => {
    mockCommandSmoke({
      installed: "2.1.245",
      recheck: LAST_COMPATIBLE_VERSION,
    });
    confirmMock.mockResolvedValueOnce(true);

    const result = await runClaudeVersionGuard({ interactive: true, ...ARMED });

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(runCommandMock).toHaveBeenCalledWith(
      "npm",
      ["install", "-g", `@anthropic-ai/claude-code@${LAST_COMPATIBLE_VERSION}`],
      {
        timeoutMs: 300_000,
      },
    );
    expect(result).toEqual({
      outcome: "downgraded",
      version: LAST_COMPATIBLE_VERSION,
      downgraded: true,
    });
  });

  it("downgrades via the native installer when claude isn't npm-managed", async () => {
    mockCommandSmoke({
      installed: "2.1.245",
      recheck: LAST_COMPATIBLE_VERSION,
      npmManaged: false,
    });
    confirmMock.mockResolvedValueOnce(true);

    const result = await runClaudeVersionGuard({ interactive: true, ...ARMED });

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(runCommandMock).toHaveBeenCalledWith(
      "claude",
      ["install", LAST_COMPATIBLE_VERSION],
      {
        timeoutMs: 300_000,
      },
    );
    expect(result).toEqual({
      outcome: "downgraded",
      version: LAST_COMPATIBLE_VERSION,
      downgraded: true,
    });
  });

  it("falls back to `npm ls -g` when `claude doctor` isn't available", async () => {
    mockCommandSmoke({
      installed: "2.1.245",
      recheck: LAST_COMPATIBLE_VERSION,
      npmManaged: false,
      doctorAvailable: false,
    });
    confirmMock.mockResolvedValueOnce(true);

    const result = await runClaudeVersionGuard({ interactive: true, ...ARMED });

    expect(runCommandMock).toHaveBeenCalledWith("claude", ["doctor"], {
      timeoutMs: 15_000,
    });
    expect(runCommandMock).toHaveBeenCalledWith(
      "npm",
      ["ls", "-g", "@anthropic-ai/claude-code", "--depth=0"],
      { timeoutMs: 15_000 },
    );
    expect(runCommandMock).toHaveBeenCalledWith(
      "claude",
      ["install", LAST_COMPATIBLE_VERSION],
      {
        timeoutMs: 300_000,
      },
    );
    expect(result).toEqual({
      outcome: "downgraded",
      version: LAST_COMPATIBLE_VERSION,
      downgraded: true,
    });
  });

  it("returns cancelled when the user declines the downgrade", async () => {
    mockCommandSmoke({ installed: "2.1.245" });
    confirmMock.mockResolvedValueOnce(false);

    const result = await runClaudeVersionGuard({ interactive: true, ...ARMED });

    expect(result).toEqual({ outcome: "cancelled" });
    expect(runCommandMock).not.toHaveBeenCalledWith(
      "npm",
      ["install", expect.anything(), expect.anything()],
      expect.anything(),
    );
    expect(runCommandMock).not.toHaveBeenCalledWith(
      "claude",
      ["install", expect.anything()],
      expect.anything(),
    );
  });

  it("returns cancelled when the user dismisses the prompt", async () => {
    mockCommandSmoke({ installed: "2.1.245" });
    const cancelSymbol = Symbol("cancel");
    confirmMock.mockResolvedValueOnce(cancelSymbol);
    isCancelMock.mockImplementation((value: unknown) => value === cancelSymbol);

    const result = await runClaudeVersionGuard({ interactive: true, ...ARMED });
    expect(result).toEqual({ outcome: "cancelled" });
  });

  it("blocks non-interactive sessions with the manual downgrade instruction", async () => {
    mockCommandSmoke({ installed: "2.1.245" });

    await expect(
      runClaudeVersionGuard({ interactive: false, ...ARMED }),
    ).rejects.toThrow(/npm install -g @anthropic-ai\/claude-code@2\.1\.233/);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("warns and continues when the claude CLI is not on PATH", async () => {
    runCommandMock.mockRejectedValueOnce(
      new Error("Failed to run `claude`: ENOENT"),
    );

    const result = await runClaudeVersionGuard({ interactive: true, ...ARMED });

    expect(result).toEqual({
      outcome: "not-installed",
      version: null,
      downgraded: false,
    });
  });

  it("warns and continues when the version output cannot be parsed", async () => {
    runCommandMock.mockResolvedValueOnce({
      ok: true,
      exitCode: 0,
      stdout: "claude nightlies are not versioned\n",
      stderr: "",
    });

    const result = await runClaudeVersionGuard({ interactive: true, ...ARMED });

    expect(result).toEqual({
      outcome: "not-installed",
      version: null,
      downgraded: false,
    });
  });

  it("surfaces npm failures and points at the manual command", async () => {
    mockCommandSmoke({ installed: "2.1.245", npmOk: false });
    confirmMock.mockResolvedValueOnce(true);

    await expect(
      runClaudeVersionGuard({ interactive: true, ...ARMED }),
    ).rejects.toThrow(
      /EACCES: permission denied[\s\S]*npm install -g @anthropic-ai\/claude-code@2\.1\.233/,
    );
  });

  it("fails when the downgrade does not take effect on PATH", async () => {
    // npm "succeeds" but claude still reports the old version (e.g. a
    // non-npm install earlier on PATH wins).
    mockCommandSmoke({ installed: "2.1.245", recheck: "2.1.245" });
    confirmMock.mockResolvedValueOnce(true);

    await expect(
      runClaudeVersionGuard({ interactive: true, ...ARMED }),
    ).rejects.toThrow(/still reports v2\.1\.245 after the downgrade/);
  });
  it("stays dormant by default: no commands, no prompts, no version pin", async () => {
    const result = await runClaudeVersionGuard({ interactive: true });

    expect(result).toEqual({
      outcome: "skipped",
      version: null,
      downgraded: false,
    });
    // Nothing is inspected or changed on the machine — not even `claude --version`.
    expect(runCommandMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("stays dormant in non-interactive sessions too, instead of blocking", async () => {
    const result = await runClaudeVersionGuard({ interactive: false });

    expect(result).toEqual({
      outcome: "skipped",
      version: null,
      downgraded: false,
    });
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it("skips when an explicit null incompatibility is passed", async () => {
    mockCommandSmoke({ installed: "2.1.245" });

    const result = await runClaudeVersionGuard({
      interactive: true,
      incompatibility: null,
    });

    expect(result).toEqual({
      outcome: "skipped",
      version: null,
      downgraded: false,
    });
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it("re-arms from any incompatibility entry, not just the retained one", async () => {
    mockCommandSmoke({ installed: "3.0.5", recheck: "3.0.4" });
    confirmMock.mockResolvedValueOnce(true);

    const result = await runClaudeVersionGuard({
      interactive: true,
      incompatibility: {
        lastCompatibleVersion: "3.0.4",
        summary: "breaks tool streaming",
      },
    });

    expect(confirmMock.mock.calls[0]?.[0]).toMatchObject({
      message: expect.stringContaining("breaks tool streaming"),
    });
    expect(runCommandMock).toHaveBeenCalledWith(
      "npm",
      ["install", "-g", "@anthropic-ai/claude-code@3.0.4"],
      { timeoutMs: 300_000 },
    );
    expect(result).toEqual({
      outcome: "downgraded",
      version: "3.0.4",
      downgraded: true,
    });
  });
});
