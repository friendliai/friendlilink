# Plugin packages

Each agent's Friendli adapter lives here; the CLI installs/removes them through each harness's own plugin mechanism:

| Path                        | What it is                                                                                       | Installed by                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `dsh-llm-friendli/`         | npm package `@friendliai/dsh-llm-friendli` — the `friendli` provider bundle for DeepSeek Harness | `dsh plugin --profile <p> add @friendliai/dsh-llm-friendli`  |
| `hermes-friendli-provider/` | GitHub source of `friendliai/hermes-friendli-provider` — the Hermes model-provider plugin        | `hermes plugins install friendliai/hermes-friendli-provider` |

Their published homes are the contract, not this repo path: the dsh package publishes to npm under the same name, and the Hermes plugin repo mirrors `hermes-friendli-provider/`. Changes to either package are verified by per-package CI; the public repo also syncs the Hermes plugin mirror on merge.

## Development

- `@friendliai/dsh-llm-friendli`: `pnpm install && pnpm --filter @friendliai/dsh-llm-friendli run lint:all && pnpm --filter @friendliai/dsh-llm-friendli run build` (pnpm workspace — the root `pnpm-workspace.yaml` includes this package).
- `hermes-friendli-provider`: Python plugin, tested against the installed Hermes runtime: `test_friendli_profile.py` / `test_transport_kwargs.py` in this package. From the repo root, `bash scripts/upstream-check/install-and-test.sh hermes <version>` installs Hermes and runs both the provider and harness suites. The runner selects the active venv from the install's `facts.json` and adds its sibling `workspace` to `PYTHONPATH`; `uv` overlays pytest without modifying runtime dependencies.
