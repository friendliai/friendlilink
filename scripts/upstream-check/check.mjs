#!/usr/bin/env node
/**
 * Upstream compat watch — detect step.
 *
 * Compares npm `latest` dist-tags for the watched harness CLIs against the
 * last committed snapshot in scripts/upstream-check/versions.json. Emits a
 * GitHub Actions matrix of changed harnesses; callers without GITHUB_OUTPUT
 * get a human-readable summary instead.
 *
 * Snapshot policy (plan v4, decision 2): the detect step only RECORDS
 * versions.json locally; the workflow commits it after unit tests pass — a
 * failing version must retry (and re-alert) the next day.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSIONS_FILE = path.join(__dirname, "versions.json");

/**
 * Snapshot keys are the real npm package names (versions.json is self-
 * describing). The harness alias is still needed by the workflow steps
 * (install-and-test.sh, e2e.mjs, unit-results.mjs key off it).
 */
const WATCH = [
  { name: "claude", pkg: "@anthropic-ai/claude-code" },
  { name: "codex", pkg: "@openai/codex" },
  { name: "dsh", pkg: "@deepseek-ai/dsh-llm" },
  // Upstream hermes is not distributed on npm (the `hermes-agent` npm package
  // is a third-party unofficial bridge); watch the official GitHub releases.
  { name: "hermes", pkg: "hermes-agent", github: "NousResearch/hermes-agent" },
  { name: "opencode", pkg: "opencode-ai" },
  { name: "pi", pkg: "@earendil-works/pi-coding-agent" },
];

async function npmLatest(pkg) {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(pkg)}`,
    {
      headers: { accept: "application/vnd.npm.install-v1+json" },
    },
  );
  if (!response.ok) {
    throw new Error(
      `could not look up ${pkg} on the npm registry (HTTP ${response.status})`,
    );
  }
  const distTags = await response.json();
  const latest = distTags["dist-tags"]?.latest;
  if (typeof latest !== "string" || latest === "") {
    throw new Error(`no "latest" dist-tag found for ${pkg}`);
  }
  return latest;
}

/**
 * hermes tags releases with calver (v2026.9.14) but reports a semver in the
 * release NAME ("Hermes Agent v0.21.3 (v2026.9.14)") and in `hermes
 * --version`. We track the semver the installed CLI reports, so both the
 * snapshot and install verification speak the same version language. Fall
 * back to the tag when the name carries no semver.
 */
function hermesSemverFrom(release) {
  const fromName = release.name?.match(/\bv?(\d+\.\d+\.\d+)\b/)?.[1];
  return fromName ?? release.tag_name.replace(/^v/, "");
}

async function githubLatestRelease(repo) {
  const response = await fetch(
    `https://api.github.com/repos/${repo}/releases/latest`,
    {
      headers: { accept: "application/vnd.github+json" },
    },
  );
  if (!response.ok) {
    throw new Error(
      `could not look up ${repo} releases (HTTP ${response.status})`,
    );
  }
  const release = await response.json();
  if (typeof release.tag_name !== "string" || release.tag_name === "") {
    throw new Error(`no latest release found for ${repo}`);
  }
  return repo === "NousResearch/hermes-agent"
    ? hermesSemverFrom(release)
    : release.tag_name.replace(/^v/, "");
}

/**
 * ponytail: serialize registry lookups — no import DEDUPE/import interleaving
 * of writes; a single alert run has at most 6 lookups so this is not slow.
 */
async function main() {
  let current = {};
  let baseline = false;
  try {
    const parsed = JSON.parse(await fs.readFile(VERSIONS_FILE, "utf8"));
    if (typeof parsed === "object" && parsed !== null) current = parsed;
    else throw new Error("malformed snapshot: not a JSON object");
    baseline = Object.keys(current).length === 0;
  } catch (error) {
    if (!baseline) {
      // A committed snapshot that can't be parsed must never pass silently as
      // a fresh baseline: fail detection so the heartbeat can't claim health.
      console.error(`::error::versions.json unreadable: ${error.message}`);
      process.exit(1);
    }
  }

  const changes = [];
  for (const { name, pkg, github } of WATCH) {
    try {
      const latest = github
        ? await githubLatestRelease(github)
        : await npmLatest(pkg);
      if (current[pkg] && current[pkg] !== latest) {
        changes.push({ name, pkg, from: current[pkg], to: latest });
      }
      current[pkg] = latest;
    } catch (error) {
      // Transient registry failure: warn and keep the old snapshot so the
      // next run retries (matches the plan's "npm lookup failure = warning" policy).
      console.error(`::warning::${name}: ${error.message}`);
    }
  }

  await fs.mkdir(path.dirname(VERSIONS_FILE), { recursive: true });
  await fs.writeFile(VERSIONS_FILE, JSON.stringify(current, null, 2) + "\n");

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    await fs.appendFile(
      githubOutput,
      `changed=${changes.length > 0 ? "true" : "false"}\n`,
    );
    await fs.appendFile(
      githubOutput,
      `matrix<<UPSTREAM_EOF\n${JSON.stringify(changes)}\nUPSTREAM_EOF\n`,
    );
    // Fresh-checkout jobs (notify/commit) can't see this runner's file
    // written above; hand them the new snapshot explicitly.
    await fs.appendFile(
      githubOutput,
      `versions<<UPSTREAM_EOF\n${JSON.stringify(current, null, 2)}\nUPSTREAM_EOF\n`,
    );
  }
  if (changes.length > 0) {
    for (const change of changes) {
      console.log(
        `upstream change: ${change.name} ${change.from} -> ${change.to}`,
      );
    }
  } else {
    console.log("no upstream changes");
  }
}

await main();
