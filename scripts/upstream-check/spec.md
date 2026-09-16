# upstream-check spec

Daily CI (`upstream-compat-watch`, `.github/workflows/upstream-compat-watch.yml`) that watches upstream agent CLI versions and reports compat results to Slack. Cursor is out of scope (no machine-readable version source).

## Watched packages (npm dist-tags.latest)

| harness  | npm package                       |
| -------- | --------------------------------- |
| claude   | `@anthropic-ai/claude-code`       |
| codex    | `@openai/codex`                   |
| dsh      | `@deepseek-ai/dsh-llm`            |
| hermes   | `hermes-agent`                    |
| opencode | `opencode-ai`                     |
| pi       | `@earendil-works/pi-coding-agent` |

## Pipeline

```
detect (daily cron 11:00 KST + workflow_dispatch)
  └─ check.mjs — diff latest vs versions.json; emit changed matrix
unit-e2e (matrix: changed harnesses only)
  ├─ install-and-test.sh <name> <to> — install new version, run that
  │   harness's unit suite (test/harnesses/<name>) under a sandbox HOME
  └─ e2e.mjs — skipped if unit failed (steps.unit.outcome == 'success')
notify
  ├─ report: per-harness version bump + unit + e2e to Slack
  ├─ heartbeat line on no-change days
  └─ commit versions.json only when unit passed (failed versions retry
     and re-alert daily)
```

## Files

- `check.mjs` — npm lookup + diff. Snapshot keys are the real npm package names; the harness alias lives in check.mjs's WATCH list. Records latest locally; commit is the workflow's job. Registry failure = `::warning::` only.
- `versions.json` — last passing snapshot, keyed by npm package name. Source of truth for the diff.
- `install-and-test.sh` — `npm install -g <pkg>@<to>` then `pnpm test -- test/harnesses/<name>` with HOME/XDG/DSH_HOME/HERMES_HOME/PI_CODING_AGENT_DIR pointed at a throwaway sandbox (shell twin of `createSandboxHome()` in test/helpers.ts). Skipped tests are treated as failure: with the real CLI installed, `describe.skipIf(binary)` must not skip.
- `e2e.mjs` — stub. Every harness returns `{"e2e":"not implemented"}`, exit 0. Single extension point for future real e2e.
- `notify.mjs` — builds the Slack message from the changed matrix + aggregate unit result (or `RESULTS`/`MODE` env for local runs). No `SLACK_WEBHOOK_URL` → `::warning::`, exit 0.

## Secrets

- `SLACK_WEBHOOK_URL` — incoming webhook for the target org public channel.

## User-facing requirements (fixed)

1. Alert on version update.
2. Unit test results for that update.
3. e2e results for that update (currently always "not implemented").
4. Only changed harnesses run; unit failure skips e2e.
