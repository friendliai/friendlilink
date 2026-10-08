# upstream-check spec

Daily CI (`upstream-compat-watch`, `.github/workflows/upstream-compat-watch.yml`)
watches upstream agent CLI versions and reports compat results to Slack.
Cursor is out of scope (no machine-readable version source).

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
  └─ e2e.sh <name> <to> — skipped if unit failed (steps.unit.outcome
     == 'success') or FRIENDLIAI_API_KEY is not configured
notify
  ├─ report: per-harness version bump + unit + e2e to Slack
  ├─ heartbeat line on no-change days
  └─ commit versions.json only when unit passed (failed versions retry
     and re-alert daily)
```

## Files

- `check.mjs` — npm lookup + diff. Snapshot keys are the real npm package names; the harness alias lives in check.mjs's WATCH list. Records latest locally; commit is the workflow's job. Registry failure = `::warning::` only.
- `versions.json` — last passing snapshot, keyed by npm package name. Source of truth for the diff.
- `install-and-test.sh` — all matrix legs run `pnpm --filter frlink install`, installing the root app and test runner without selecting the workspace dsh adapter or running its `prepare` script. Only the dsh leg then installs `@deepseek-ai/dsh-llm@<to>` into the workspace adapter with pnpm (an ephemeral manifest/lockfile change in the CI checkout) and runs the adapter's `typecheck`. No install uses `--ignore-scripts`: adapter compilation failures belong to the dsh unit verdict, not to pi/codex/other legs. Each leg installs its real CLI at `<to>` and runs `pnpm test -- test/harnesses/<name>` with HOME/XDG/DSH_HOME/PI_CODING_AGENT_DIR pointed at a throwaway sandbox (Hermes resolves its per-test home from the test context). Skipped tests are treated as failure: with the real CLI installed, `describe.skipIf(binary)` must not skip.
- The Hermes leg alone runs `packages/hermes-friendli-provider`'s pytest suite against the just-installed Hermes checkout/venv. A temporary `HERMES_HOME` discovers this checkout's plugin; `uv` overlays pytest without changing Hermes' runtime dependencies. The workflow sets up `uv` only for that matrix leg. A provider regression fails Hermes' unit step and skips its e2e, without affecting any other harness.
- `e2e.sh` — one harness, typed like a user: re-exec into an `env -i` shell with an empty throwaway HOME → install the harness (`<to>`) → install frlink from `main` with the public `install.sh` → `frlink login` → start `scripts/friendli-relay.mjs` (logging proxy) and `frlink <name> on --model <cheapest model>` (picked each run from `GET /v1/models`: cheapest by input+output price among models with a reasoning `toggle` → level `off`, or an `effort` option → its lowest level), pointing the harness at the proxy (claude/codex/pi `--base-url`, opencode `OPENCODE_CONFIG_CONTENT`, hermes `hermes config set model.base_url`, dsh plugin `baseURL`) → one inference with that level set by the harness's own command, never by frlink (off: claude `MAX_THINKING_TOKENS=0`, codex `-c model_reasoning_effort=none`, opencode `--variant off`, pi `--thinking off`, hermes `--reasoning none`, dsh `reasoningEffort: off`; effort: claude `--effort`, the others the same flags with the level in `settings.yaml` + plugin `thinking: disabled`) → check the proxy capture: at least one inference request, every one answered 200, none with reasoning in the response when it was turned off; on failure the non-2xx Friendli answers (e.g. 429) are printed to stderr, so they reach the Slack log → `frlink <name> off` → assert `status` no longer routed and the API key is gone from HOME → `logout` → HOME removed. The key is withheld from the environment until `login`, so third-party installers never see it. Any failing command fails the leg.
- `notify.mjs` — appends, per failed e2e harness, the tail of its stdout/stderr (leg uploads artifact `e2e-log-<name>`, notify downloads them into `E2E_LOG_DIR`) to the report; builds the Slack message from the changed matrix + per-harness unit/e2e verdicts (`unit-results.mjs`, read from the Actions jobs API steps), or `RESULTS`/`MODE` env for local runs. No `SLACK_WEBHOOK_URL` → `::warning::`, exit 0.

The pull-request `ci` workflow uses the same isolation: its `frlink (pnpm)` job installs only `frlink`, while the dedicated `@friendliai/dsh-llm-friendli` job installs and compiles the adapter. An upstream DeepSeek type change must fail the adapter job without preventing CLI checks from running.

## Isolation smoke design

In a disposable checkout, make the workspace dsh adapter fail TypeScript compilation (for example, add an unresolved import to its source). Run `bash scripts/upstream-check/install-and-test.sh pi <current pi version>` and the same command for `codex` (with their respective versions): both must install only `frlink`, run their actual harness suites, and never invoke the dsh adapter's `prepare` or `typecheck`. Then run `bash scripts/upstream-check/install-and-test.sh dsh <current dsh version>`: it must fail during adapter compilation, before reporting a unit pass, and the workflow must skip only that leg's e2e. Restore the disposable checkout; with the adapter fixed, rerun the dsh leg against the upstream version being reported to check that the selected `@deepseek-ai/dsh-llm` dependency is exactly `<to>` and that both adapter typecheck and the dsh harness suite pass. No API key is needed for these unit checks.
Similarly, break the Hermes provider in a disposable checkout: the pi/codex/dsh legs must not run its Python tests, while the Hermes leg must fail its unit step. Restore the provider and run the Hermes leg to check that its isolated plugin tests and harness tests both execute against the installed runtime.

## Secrets

- `SLACK_WEBHOOK_URL` — incoming webhook for the target org public channel.
- `FRIENDLIAI_API_KEY` — Friendli API key for the e2e inference (one tiny request per changed harness). Missing → e2e reported as `skipped (no API key)`.

## User-facing requirements (fixed)

1. Alert on version update.
2. Unit test results for that update.
3. e2e results for that update (real inference through the harness; pass / fail / skipped).
4. Only changed harnesses run; unit failure skips e2e.
