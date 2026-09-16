#!/usr/bin/env node
/**
 * Upstream compat watch — e2e entrypoint (STUB, plan v4 requirement).
 *
 * Per-harness end-to-end tests (real CLI + fake Friendli API) are not
 * implemented yet. Every harness reports `not implemented` and exits 0 so
 * the workflow stays green and the Slack report shows "➖ e2e: not
 * implemented". When a harness gains a real e2e, implement it here — this
 * file is the single extension point.
 *
 * Usage: node e2e.mjs <harness> <from> <to>
 * Output: JSON {"name": ..., "from": ..., "to": ..., "e2e": "not implemented"}
 */

const E2E_STATUS = {
  claude: "not implemented",
  codex: "not implemented",
  dsh: "not implemented",
  hermes: "not implemented",
  opencode: "not implemented",
  pi: "not implemented",
};

const [name, from, to] = process.argv.slice(2);
if (!name || !from || !to) {
  console.error("usage: node e2e.mjs <harness> <from> <to>");
  process.exit(2);
}
if (!(name in E2E_STATUS)) {
  console.error(`unknown harness: ${name}`);
  process.exit(2);
}

console.log(JSON.stringify({ name, from, to, e2e: E2E_STATUS[name] }));
