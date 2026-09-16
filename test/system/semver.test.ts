import { describe, expect, it } from "vitest";
import {
  compareSemver,
  formatSemver,
  parseSemver,
} from "../../src/system/semver.js";

describe("parseSemver", () => {
  it("extracts the first x.y.z triple from noisy CLI output", () => {
    expect(parseSemver("2.1.233 (Claude Code)")).toEqual({
      major: 2,
      minor: 1,
      patch: 233,
    });
    expect(parseSemver("some-prefix 2.1.240\nother line")).toEqual({
      major: 2,
      minor: 1,
      patch: 240,
    });
  });

  it("returns null when no version triple is present", () => {
    expect(parseSemver("claude: command not found")).toBeNull();
    expect(parseSemver("2.1")).toBeNull();
    expect(parseSemver("")).toBeNull();
  });
});

describe("formatSemver", () => {
  it("renders the canonical dotted form", () => {
    expect(formatSemver({ major: 2, minor: 1, patch: 233 })).toBe("2.1.233");
  });
});

describe("compareSemver", () => {
  it("orders by major, then minor, then patch", () => {
    expect(
      compareSemver(parseSemver("2.1.233")!, parseSemver("2.1.234")!),
    ).toBe(-1);
    expect(
      compareSemver(parseSemver("2.1.234")!, parseSemver("2.1.233")!),
    ).toBe(1);
    expect(
      compareSemver(parseSemver("2.1.233")!, parseSemver("2.1.233")!),
    ).toBe(0);
    expect(compareSemver(parseSemver("2.1.245")!, parseSemver("2.2.0")!)).toBe(
      -1,
    );
    expect(compareSemver(parseSemver("1.9.9")!, parseSemver("2.0.0")!)).toBe(
      -1,
    );
  });
});
