# Contributing

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
