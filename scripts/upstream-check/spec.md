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
  └─ heartbeat line on no-change days
snapshot
  └─ open a versions.json update PR only when the whole unit-e2e
     matrix succeeds; failed versions retry and re-alert daily
```

## Files

- `check.mjs` — npm lookup + diff. Snapshot keys are the real npm package names; the harness alias lives in check.mjs's WATCH list. Records latest locally; commit is the workflow's job. Registry failure = `::warning::` only.
- `versions.json` — last passing snapshot, keyed by npm package name. Source of truth for the diff.
- `install-and-test.sh` — all matrix legs run `pnpm --filter frlink install`, installing the root app and test runner without selecting the workspace dsh adapter or running its `prepare` script. Only the dsh leg then installs `@deepseek-ai/dsh-llm@<to>` into the workspace adapter with pnpm (an ephemeral manifest/lockfile change in the CI checkout) and runs the adapter's `typecheck`. No install uses `--ignore-scripts`: adapter compilation failures belong to the dsh unit verdict, not to pi/codex/other legs. Each leg installs its real CLI at `<to>` and runs `pnpm test -- test/harnesses/<name>` with HOME/XDG/DSH_HOME/PI_CODING_AGENT_DIR pointed at a throwaway sandbox (Hermes resolves its per-test home from the test context). Skipped tests are treated as failure: with the real CLI installed, `describe.skipIf(binary)` must not skip.
- The Hermes leg alone runs `packages/hermes-friendli-provider`'s pytest suite against the just-installed Hermes runtime. It hashes the canonical `~/.hermes/hermes-agent` checkout path using Hermes' install-key convention (the first 16 hex characters of SHA-256), then reads that install's `facts.json` under `~/.hermes/installs/<key>/`. `packages.venv.environment` selects the active `<generation>/venv`; its sibling `workspace` supplies `PYTHONPATH`. Old generations and other installs must not be selected. A temporary `HERMES_HOME` discovers this checkout's plugin; `uv` overlays pytest without changing Hermes' runtime dependencies. The workflow sets up `uv` only for that matrix leg. A provider regression fails Hermes' unit step and skips its e2e, without affecting any other harness.
- `e2e.sh` — one harness, typed like a user: re-exec into an `env -i` shell with an empty throwaway HOME → install the harness (`<to>`) → install frlink from `main` with the public `install.sh` → `frlink login` → start `scripts/friendli-relay.mjs` → run the modality cases below → `frlink <name> off` → assert `status` no longer routed and the API key is gone from HOME → `logout` → stop leftover processes whose `/proc` environ carries the sandbox HOME (detached harness daemons included) → HOME removed. The key is withheld from the environment until `login`, so third-party installers never see it. Any failing command fails the leg; teardown is best-effort and keeps the leg's exit code. Linux with bash 4+ only; elsewhere it exits 2 before creating HOME.
- Both Hermes install paths pass `--non-interactive` to the upstream installer. This skips setup/gateway prompts even when launched from a real terminal; relying on CI's lack of a TTY is insufficient. E2E deliberately sets `TERM=dumb`, so launching the installer's curses setup wizard there is invalid. Routing and credentials are configured by frlink after installation instead.
- `modalities.mjs` — selects the cheapest active model by input+output price for each live `input_modalities` value, generates local fixtures, and verifies relay captures. Cases run **text → image → remaining modalities alphabetically**. Each case uses a fresh harness invocation and a separate capture, with reasoning off when supported or the lowest advertised effort otherwise. Retains the existing no-reasoning-when-off check. Availability only: require the selected model to reach Friendli, all inference responses to be 200 without stream errors, and image/video content parts to survive the harness transport. No response-word or recognition-accuracy assertion.
- Native image inputs: Claude stream-json image blocks; Codex `exec --image`; OpenCode `run --file`; Pi `@input.png`; Hermes `chat --image`. Image is a locally generated 32×32 PNG.
- Hermes video uses a locally generated one-second 32×32 MP4. A fresh `hermes chat --toolsets video` session is asked to call `video_analyze` on that file. This is the real agent/tool/auxiliary-model path, not a direct CLI video attachment flag or frame extraction. `auxiliary.vision` is pinned to the selected Friendli model, provider, relay base URL, and reasoning level; the tool uses the vision auxiliary route. The relay must capture an actual video content part reaching the selected model; a tool call or text-only answer alone is not coverage. `ffmpeg` is required locally for this case only; in CI (`CI` set) `e2e.sh` installs it with apt right before the video fixture, so legs without a video case never install it. The image PNG is generated with Node `zlib`.
- dsh headless has no **direct CLI attachment** argument or local-path expansion, so this runner skips its image case. The separate multi-turn `read_image(file_path)` flow can return image bytes; the current Friendli adapter handles both legacy nested `tool-result` blocks and first-class tool messages. That flow is not exercised by this runner; the skip is not an adapter image-support failure.
- Unknown future modalities are reported as skipped until a tested input path and fixture are available. Skips do not count as successful modality coverage. A tested path that drops/rejects the attachment fails the case, even if a text answer succeeds (including Hermes auxiliary-image fallback).
- `notify.mjs` — appends, per failed e2e harness, the tail of its stdout/stderr (leg uploads artifact `e2e-log-<name>`, notify downloads them into `E2E_LOG_DIR`) to the report; builds the Slack message from the changed matrix + per-harness unit/e2e verdicts (`unit-results.mjs`, read from the Actions jobs API steps), or `RESULTS`/`MODE` env for local runs. No `SLACK_WEBHOOK_URL` → `::warning::`, exit 0.

The pull-request `ci` workflow uses the same isolation: its `frlink (pnpm)` job installs only `frlink`, while the dedicated `@friendliai/dsh-llm-friendli` job installs and compiles the adapter. An upstream DeepSeek type change must fail the adapter job without preventing CLI checks from running.

## Input modality coverage

This is live inference E2E coverage, not a claim about every upstream UI, API, tool, or provider. Only changed harnesses run; a unit failure or missing API key skips that harness's entire E2E step. Cases are generated only for active modalities in Friendli's live catalog, with one cheapest model per modality.

| Harness     | Text          | Image                                                                       | Video                                                                  |
| ----------- | ------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Claude Code | Direct prompt | stream-json image block                                                     | Skipped: no native video block in the tested input contract            |
| Codex       | `exec` prompt | `exec --image`                                                              | Skipped: no native video input in the tested exec path                 |
| OpenCode    | `run` prompt  | `run --file`                                                                | Skipped: local MP4 rejected by the upstream CLI                        |
| Pi          | `-p` prompt   | `@input.png`                                                                | Skipped: non-image `@file` inputs are read as text, not native video   |
| Hermes      | `chat -q`     | `chat --image`                                                              | `video_analyze` tool → auxiliary Friendli request with `video_url`     |
| dsh         | Headless task | Skipped: no direct attachment CLI; `read_image` flow is outside this runner | Skipped: no native video content path in the upstream protocol/adapter |

OpenCode 1.19.1's local `run --file input.mp4` failed with `Cannot read binary file` before reaching Friendli in [run 38840006060](https://github.com/friendliai/friendlilink/actions/runs/38840006060). The runner explicitly reports that upstream CLI limitation instead of attempting an unsupported attachment. This is a skip, not a video pass. Re-enabling the case requires a working native video transport through both the CLI and its OpenAI-compatible SDK; declaring video in model metadata alone is insufficient.

Audio and document/PDF cases are not implemented. The catalog observed during this update advertises text/image/video inputs and text outputs only; the runner neither creates fixtures nor enables input paths for audio/document. Future catalog entries alone will not enable those cases. This does not mean every upstream lacks those features: Claude accepts document blocks, Codex core has audio inputs outside the tested exec path, and Hermes has separate speech-to-text tooling. Output audio/image/video generation is outside this input-availability check.

## Isolation smoke design

In a disposable checkout, make the workspace dsh adapter fail TypeScript compilation (for example, add an unresolved import to its source). Run `bash scripts/upstream-check/install-and-test.sh pi <current pi version>` and the same command for `codex` (with their respective versions): both must install only `frlink`, run their actual harness suites, and never invoke the dsh adapter's `prepare` or `typecheck`. Then run `bash scripts/upstream-check/install-and-test.sh dsh <current dsh version>`: it must fail during adapter compilation, before reporting a unit pass, and the workflow must skip only that leg's e2e. Restore the disposable checkout; with the adapter fixed, rerun the dsh leg against the upstream version being reported to check that the selected `@deepseek-ai/dsh-llm` dependency is exactly `<to>` and that both adapter typecheck and the dsh harness suite pass. No API key is needed for these unit checks.
Similarly, break the Hermes provider in a disposable checkout: the pi/codex/dsh legs must not run its Python tests, while the Hermes leg must fail its unit step. Restore the provider and run the Hermes leg to check that its isolated plugin tests and harness tests both execute against the installed runtime.

For managed-runtime discovery, keep an obsolete executable `<generation>/venv/bin/python` beside the active generation, then run the Hermes leg. The provider tests must use the environment recorded in this checkout's `facts.json`, with imports from its sibling `workspace`, regardless of directory order. If the recorded interpreter is missing, the leg must fail rather than falling back to an old generation.

## Secrets

- `SLACK_WEBHOOK_URL` — incoming webhook for the target org public channel.
- `FRIENDLIAI_API_KEY` — Friendli API key for the e2e inference (one tiny invocation per supported live input modality per changed harness; harness auxiliary calls may add requests). Missing → e2e reported as `skipped (no API key)`.

## User-facing requirements (fixed)

1. Alert on version update.
2. Unit test results for that update.
3. e2e results for that update (real inference through the harness; pass / fail / skipped).
4. Only changed harnesses run; unit failure skips e2e.
