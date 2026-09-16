# FriendliLink telemetry headers

## Config-time bake-in

Telemetry = config-time bake-in only. During `frlink <harness> on`, FriendliLink builds one fixed header map, writes it into harness config. Not session-start hook, request interceptor, proxy, or dynamic loop. After `on` finishes, FriendliLink NOT in request path; harness uses normal provider config.

Generated map = exactly two static headers:

```text
X-Title: <canonical harness title>
HTTP-Referer: frlink/v<package version>
```

`X-Title` = module's fixed canonical title for selected harness: `Claude Code`, `Codex`, `DeepSeek Harness`, `OpenCode`, or `Pi`. Package version read + normalized at config time; if unreadable/unnormalizable, referer = `frlink/unknown`.

Map contains no user, account, repository, path, prompt, session, or credential data. Does not add/override `User-Agent`.

## Supported configuration surfaces

Static headers only where FriendliLink has verified config surface:

- Claude Code: `ANTHROPIC_CUSTOM_HEADERS`
- Codex: `http_headers`
- dsh: `extraHeaders` on `@friendliai/dsh-llm-friendli` plugin config row
- Hermes: `model.default_headers`
- OpenCode: `options.headers`
- Pi: `headers`

Hermes headers win over friendliai-provider profile headers (`model.default_headers` overrides profile headers client-side). Cursor intentionally omitted: OpenAI override has no verified custom-header surface.

Re-running `frlink <harness> on` replaces two managed header names case-insensitively. Preserves unrelated user headers where surface supports it. `frlink <harness> off` uses existing config snapshot restoration.

### Existing OpenCode parser boundary

FriendliLink OpenCode writer accepts **strict JSON** only. Comment-bearing JSONC `opencode.json` rejected before any telemetry merge — existing config-parser limitation, not telemetry transport behavior. Remove comments or use valid JSON before `frlink opencode on`.

## Testing / Reproduction

Run from repo root. Credential-free: tests use local fixtures + sandboxed config paths, none need Friendli gateway credential.

Focused telemetry + lifecycle tests:

```bash
npm run test -- test/telemetry/request-headers.test.ts test/cli/commands/harness.test.ts
```

Affected harness tests:

```bash
npm run test -- \
  test/harnesses/claude/claude-harness.test.ts \
  test/harnesses/codex/codex.test.ts \
  test/harnesses/opencode/opencode.test.ts \
  test/harnesses/pi/pi.test.ts
```

Complete verification suite:

```bash
npm run test
npm run typecheck
npm run lint
npm run build
```

Checks validate local config generation + merge behavior only. Do NOT demonstrate live gateway-side analytics ingestion/aggregation/reporting; server-side behavior out of scope, unverified.
