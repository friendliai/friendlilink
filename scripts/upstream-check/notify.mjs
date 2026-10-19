#!/usr/bin/env node
/**
 * Upstream compat watch — Slack notifier.
 *
 * Env:
 *   SLACK_WEBHOOK_URL — incoming webhook for the target org public channel.
 *                       If unset: ::warning:: and exit 0 (safe skip — the
 *                       workflow must not fail because a secret is missing).
 *   RESULTS           — JSON array: [{name, from, to, unit, e2e}, ...]
 *                       unit: "pass" | "fail" | "skipped"; e2e: "pass" | "fail"
 *                       | "skipped (unit failed)" | "skipped (no API key)"
 *   MODE              — "report" (changes present) | "heartbeat" (no changes)
 *   E2E_LOG_DIR       — optional: dir of downloaded e2e-log-<harness>/e2e.log
 *                       artifacts from failed e2e legs, appended to the report
 *
 * Behavior:
 *   report: one Slack block per changed harness — version bump, unit result,
 *           e2e result (user-confirmed requirement 1+2+3 in a single message).
 *   heartbeat: single line "no upstream changes" so a silently dead cron is
 *           noticeable (decision 6).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const url = process.env.SLACK_WEBHOOK_URL;
const mode = process.env.MODE ?? "report";

// In CI the workflow passes the changed-harness matrix (from check.mjs) plus
// per-harness unit verdicts assembled from the Actions jobs API
// (needs.unit-e2e is an aggregate and cannot tell legs apart); locally
// RESULTS can be supplied directly.
let results = [];
if (process.env.RESULTS) {
  results = JSON.parse(process.env.RESULTS);
} else if (process.env.CHANGED) {
  const changed = JSON.parse(process.env.CHANGED);
  const verdicts = process.env.UNIT_RESULTS
    ? JSON.parse(process.env.UNIT_RESULTS)
    : {}; // harness name -> {unit, e2e}
  results = changed.map((c) => ({
    ...c,
    ...(verdicts[c.name] ?? { unit: "fail", e2e: "skipped (unit failed)" }),
  }));
}

function unitLine(unit) {
  if (unit === "pass") return "✅";
  if (unit === "skipped") return "⚠️ skipped";
  return "❌ failed";
}

function e2eLine(e2e) {
  if (e2e === "pass") return "✅ e2e";
  if (e2e === "fail") return "❌ e2e failed";
  return `➖ e2e: ${e2e}`;
}

function buildPayload() {
  if (mode === "heartbeat") {
    return {
      text: `:zzz: upstream watch — no changes (${new Date().toISOString().slice(0, 10)})`,
    };
  }
  // ponytail: plain "text" — block-kit formatting is overkill for 3 lines per harness
  const lines = results.map(
    (r) =>
      `• *${r.name}* ${r.from} → ${r.to}\n` +
      `  ${unitLine(r.unit)} unit | ${e2eLine(r.e2e)}`,
  );
  // Failed legs upload e2e.log as artifact e2e-log-<harness>; show each
  // harness's tail (already key-redacted by the e2e step) after the summary.
  const logDir = process.env.E2E_LOG_DIR;
  const failures =
    logDir && existsSync(logDir)
      ? readdirSync(logDir)
          // Reruns retain artifacts from earlier attempts; ignore recovered legs.
          .filter((entry) =>
            results.some(
              (r) => entry === `e2e-log-${r.name}` && r.e2e === "fail",
            ),
          )
          .map(
            (entry) =>
              `*${entry.replace(/^e2e-log-/, "")}* e2e log\n\`\`\`${readFileSync(
                join(logDir, entry, "e2e.log"),
                "utf8",
              ).slice(-3000)}\`\`\``,
          )
      : [];
  return {
    text: `:arrow_up: *Upstream update* — ${new Date().toISOString().slice(0, 10)}\n${[...lines, ...failures].join("\n")}`,
  };
}

console.log(buildPayload().text);

if (!url) {
  console.error("::warning::SLACK_WEBHOOK_URL not set; skipping notify");
  process.exit(0);
}

const response = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(buildPayload()),
});

if (!response.ok) {
  console.error(`::error::Slack webhook HTTP ${response.status}`);
  process.exit(1);
}
console.log("slack notified");
