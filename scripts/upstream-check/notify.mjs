#!/usr/bin/env node
/**
 * Upstream compat watch — Slack notifier.
 *
 * Env:
 *   SLACK_WEBHOOK_URL — incoming webhook for the target org public channel.
 *                       If unset: ::warning:: and exit 0 (safe skip — the
 *                       workflow must not fail because a secret is missing).
 *   RESULTS           — JSON array: [{name, from, to, unit, e2e}, ...]
 *                       unit: "pass" | "fail" | "skipped"; e2e: "not implemented"
 *                       | "pass" | "fail" | "skipped (unit failed)"
 *   MODE              — "report" (changes present) | "heartbeat" (no changes)
 *
 * Behavior:
 *   report: one Slack block per changed harness — version bump, unit result,
 *           e2e result (user-confirmed requirement 1+2+3 in a single message).
 *   heartbeat: single line "no upstream changes" so a silently dead cron is
 *           noticeable (decision 6).
 */

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
  const unitVerdicts = process.env.UNIT_RESULTS
    ? JSON.parse(process.env.UNIT_RESULTS)
    : {}; // harness name -> "pass" | "fail"
  results = changed.map((c) => {
    const unit = unitVerdicts[c.name] ?? "fail";
    return {
      ...c,
      unit,
      // stub-phase e2e: unit failure must skip e2e (user rule 2)
      e2e: unit === "pass" ? "not implemented" : "skipped (unit failed)",
    };
  });
}

function unitLine(unit) {
  if (unit === "pass") return "✅";
  if (unit === "skipped") return "⚠️ skipped";
  return "❌ failed";
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
      `  ${unitLine(r.unit)} unit | ➖ e2e: ${r.e2e}`,
  );
  return {
    text: `:arrow_up: *Upstream update* — ${new Date().toISOString().slice(0, 10)}\n${lines.join("\n")}`,
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
