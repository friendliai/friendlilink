import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each(["pass", "fail", "skipped (unit failed)", "skipped (no API key)"])(
  "includes downloaded logs only for current e2e failures (%s)",
  (e2e) => {
    const dir = mkdtempSync(join(tmpdir(), "upstream-notify-"));
    try {
      for (const name of ["codex", "hermes"]) {
        mkdirSync(join(dir, `e2e-log-${name}`));
        writeFileSync(
          join(dir, `e2e-log-${name}`, "e2e.log"),
          `${name} failure`,
        );
      }
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(
            new URL("../../scripts/upstream-check/notify.mjs", import.meta.url),
          ),
        ],
        {
          encoding: "utf8",
          env: {
            MODE: "report",
            E2E_LOG_DIR: dir,
            RESULTS: JSON.stringify([
              { name: "codex", from: "1", to: "2", unit: "pass", e2e },
            ]),
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.includes("codex failure")).toBe(e2e === "fail");
      expect(result.stdout).not.toContain("hermes failure");
      expect(result.stdout).toContain("• *codex* 1 → 2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
