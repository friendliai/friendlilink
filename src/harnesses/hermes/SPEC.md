# hermes

Routes hermes through the friendliai-provider plugin (not a `custom_providers`
entry): `custom` sends `reasoning_effort: "none"` which Friendli 422s; the
plugin sends the real switches (`reasoning_budget: 0`,
`chat_template_kwargs.enable_thinking: false`) per model from the catalog.

Plugin source lives in this repo at `packages/hermes-friendli-provider/`; the
install target `friendliai/hermes-friendli-provider` on GitHub is a mirror CI
keeps in sync (`.github/workflows/sync-hermes-plugin.yml`).

## on

1. Key preamble (shared path, see `keys/SPEC.md`), pick a model.
2. `hermes plugins install friendliai/hermes-friendliai-provider`
   ("already exists" = success). Pre-probe: if the plugin dir predates `on`,
   `off` must not remove it (recorded in state).
3. Write `FRIENDLIAI_API_KEY` into `<home>/.env` — shared
   `writeOwnedEnvKey`, fatal on failure (a success whose plugin can't
   authenticate breaks the route contract).
4. Rewrite config.yaml: `model: {default, provider: friendli}` +
   plugin in `plugins.enabled`. Drop leftover `model.base_url/api_key/
api_mode` (the plugin supplies them; no key ever goes in config.yaml).
   Idempotent re-`on` also migrates legacy `FriendliAI*` custom_providers
   entries and retires the pre-rename `friendli-provider` from enabled
   (same `friendli` slug — load order would decide otherwise; its dir is
   never touched by us).

Home = `$HERMES_HOME` when set (profiles/sandboxes/desktop set it), else
`~/.hermes` — every write (config.yaml, .env, plugin) goes under the same
resolved home. `login` never creates a hermes home.

## off

Remove the plugin first when the install was ours (failures leave all
recovery state for a retry), then per-field 3-way revert of config.yaml:
fields still holding our written values go back to pre-`on` (user-edited
fields stay as edited; semantic-equal result restores the original bytes
so comments survive; missing pre-`on` file + no user content = deleted).
The `.env` key reverts via `revertOwnedEnvKey` — same contract as dsh.
`plugins.remove` leaves orphaned names in config lists; `off` drops our
own either way.
