# Contributing

## Internal → public dispatch

Run the manual `Dispatch internal to public` workflow to publish an internal
ref. It applies only changes since the internal commit recorded by the most
recent public dispatch commit (`Synced from friendliai/friendlilink-internal @
<SHA>`). Public-only edits are retained; `.github/**` stays repo-specific.
The public clone must include its full history, and the recorded commit must
be an ancestor of the selected internal ref. If provenance is missing or
edits overlap, dispatch fails before opening a PR. Reconcile the conflicting
public edits into internal, then rerun; do not force a whole-tree sync.

Run `bash .github/scripts/dispatch/apply.test.sh` to check preservation,
conflict handling, and missing-provenance behavior locally.

## Versioning & releases

The repo ships three independently versioned artifacts. Each has its own
version string in a different file, and releases are cut by pushing a git tag
named `<artifact>@<semver>`. A CI workflow
(`.github/workflows/validate-release-tags.yml`) rejects tags whose semver does
not match the artifact's version file, so a typo cannot mint a release whose
git ref disagrees with published metadata.

| Artifact                       | Version file                                    | Tag pattern                             | Published how                                     |
| ------------------------------ | ----------------------------------------------- | --------------------------------------- | ------------------------------------------------- |
| `frlink` (CLI)                 | root `package.json` → `"version"`               | `frlink@<semver>`                       | Not published — `install.sh` builds from checkout |
| `@friendliai/dsh-llm-friendli` | `packages/dsh-llm-friendli/package.json`        | `@friendliai/dsh-llm-friendli@<semver>` | `npm publish` (manual)                            |
| `hermes-friendli-provider`     | `packages/hermes-friendli-provider/plugin.yaml` | `hermes-friendli-provider@<semver>`     | CI syncs to the mirror repo; merging publishes    |

### Cutting a release

1. Bump the version in the artifact's version file.
2. Commit and push.
3. Tag and create a GitHub Release in one step:

```bash
gh release create @friendliai/dsh-llm-friendli@0.1.0 \
  --target main \
  --title "@friendliai/dsh-llm-friendli 0.1.0" \
  --notes "What changed since the last tag"
```

The tag-push triggers the validator workflow; it must pass before the release
is trusted. For `@friendliai/dsh-llm-friendli`, publish to npm after the tag is validated:

```bash
cd packages/dsh-llm-friendli && pnpm publish
```

For `hermes-friendli-provider`, no manual publish — the same push that changed
`plugin.yaml` triggers `.github/workflows/sync-hermes-plugin.yml` (on merge to
`main`), which opens a PR on the mirror repo; merging that PR publishes.

## Public-to-internal sync

The internal repository is the development source of truth. Public releases
are dispatched from internal manually. The daily follower workflow imports
public changes after the latest dispatch (or the last reviewed import) with a
three-way merge onto internal `main`, excluding `.github/`. It records the
imported public commit in `.github/follower-public-base.sha` in the same PR as
the content. If both sides changed the same content, the workflow fails and
closes stale follower PRs instead of reverting internal work. Resolve the
conflict manually, keeping internal changes where appropriate, and update the
cursor to the reviewed public commit before retrying. A later dispatch
supersedes an older cursor.
