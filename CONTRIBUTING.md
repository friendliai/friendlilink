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
| `hermes-friendli-provider`     | `packages/hermes-friendli-provider/plugin.yaml` | `hermes-friendli-provider@<semver>`     | CI pushes directly to the mirror repo             |

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

For `hermes-friendli-provider`, no manual publish — a push changing
`packages/hermes-friendli-provider/**` on `main` triggers
`.github/workflows/sync-hermes-plugin.yml`. It copies the plugin directory to
`friendliai/hermes-friendliai-provider` and publishes with a fast-forward push
to the mirror's `main`. No mirror PR or target-side sync workflow is needed.
The workflow can also be run manually; unchanged content skips the push.

The source repo's `HERMES_MIRROR_DEPLOY_KEY` Actions secret holds the private
SSH key for the mirror's write-enabled `friendlilink mirror sync` deploy key.
It grants access only to that mirror; `WEB_GITHUB_TOKEN` is not used for sync.
Rotate the public deploy key and the source secret together.

The mirror's `Mirror sync PR policy` ruleset requires one approval and code
owner review for other writers, preserving the existing Lee-Si-Yoon and
Dependabot bypasses. Deploy keys bypass only this PR requirement; the separate
classic branch protection still forbids force pushes and branch deletion.
GitHub applies the ruleset bypass to the deploy-key actor type, not an
individual key. Keep the sync key as the mirror's only write deploy key:
additional write deploy keys would inherit the same PR bypass.
