export interface Semver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/**
 * First `x.y.z` triple in arbitrary command output. Suffixes like
 * "2.1.233 (Claude Code)" or pre-release tags are ignored — for the version
 * guard we only care about the numeric ordering.
 */
export function parseSemver(text: string): Semver | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (!match) {
    return null;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return { major, minor, patch };
}

export function formatSemver(version: Semver): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

export function compareSemver(a: Semver, b: Semver): -1 | 0 | 1 {
  for (const part of ["major", "minor", "patch"] as const) {
    if (a[part] !== b[part]) {
      return a[part] < b[part] ? -1 : 1;
    }
  }
  return 0;
}
