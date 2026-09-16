# dsh

A profile lives at `<$DSH_HOME|~/.dsh>/profiles/NAME`. Two files matter:
`package.json` (bundle list under `dsh.profile.bundles`) and
`cordis.patch.yml` (YAML rows, later rows win). dsh has no provider notion
of its own — the `@friendliai/dsh-llm-friendli` bundle registers the `friendli`
provider; frlink installs it and owns exactly the FINAL
`agent-default-model` row (patching an earlier duplicate would report
success without routing anything).

The bundle's source lives in this repo at `packages/dsh-llm-friendli/`
(published to npm as `@friendliai/dsh-llm-friendli`); see that directory's README
for how it is built and tested.

## on

`frlink dsh on` — profile defaults to `web`, override with `--profile`.

1. Validates the profile name (dsh's rules: no empty, `.`, `..`,
   `node_modules`, separators). Rejects `--settings-path` for `on`/`off`
   (status may use it) and rejects `--base-url` for `on`: the bundle owns
   its endpoint, so a requested URL we would silently drop is refused.
2. Key preamble: resolve the key (flag > env > keychain), verify a
   flag-supplied key against Friendli, persist it, pick a model.
3. Parses `cordis.patch.yml`. A file whose root is not a row array is
   refused, not repaired. Snapshots it unless a backup already exists and
   the live `agent-default-model` row already matches our recorded state
   (a bare Friendli row is not ownership evidence: the user could have
   written it too).
4. Installs the bundle with `dsh plugin --profile P add
@friendliai/dsh-llm-friendli@<latest>` (the `latest` dist-tag is resolved over the
   registry first: a bare spec makes pnpm silently fall back to an older
   version whose peers match). An "already exists" result is success.
   If the install fails and the patch bytes are unchanged, a snapshot
   created by this attempt is discarded; backups from earlier attempts
   survive for `off`. dsh's `plugin` command is a hardcoded pnpm
   forwarder, so frlink probes `pnpm --version` first and, if pnpm is
   not on PATH, asks the user to confirm `corepack enable`
   (Node.js ≥16.9) — it is a system-level operation, so it must never
   be silent. `--non-interactive` refuses instead of prompting.
5. Writes `FRIENDLIAI_API_KEY` into `<dsh-home>/.env`. dsh puts this
   file into process.env at boot and the bundle reads the variable per
   request. No key material goes into the patch or package.json.
6. Rewrites the final `agent-default-model` row in place (keeping its
   position) or appends a new one after the user's rows, with
   `provider: friendli` and the picked model. Later rows win, as above.

## off

Restore the patch before touching the bundle, then
`dsh plugin --profile P remove @friendliai/dsh-llm-friendli` only if the manifest
still lists it. The same pnpm/corepack probe (with user confirm) as `on`
applies. Patch restore is a per-row merge: only our row reverts
(user edits survive, other rows follow the live file, semantic-equal
restores original bytes, no backup + state-matching row = strip).
A nonzero removal exit or still-registered bundle after a zero exit
fails the command; the patch restore is never rolled back.
The `.env` key reverts via the shared `revertOwnedEnvKey` (contract in
`keys/SPEC.md`).

Backup/state slots: SHA-256 of (resolved dsh home, profile) — several dsh
homes can share one machine.
