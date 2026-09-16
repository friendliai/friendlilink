# Hermes FriendliAI Provider

FriendliAI model provider plugin for [Hermes Agent](https://github.com/NousResearch/hermes-agent).

Fast-path profile for `api.friendli.ai/serverless/v1`: catalog-driven reasoning
control (no hardcoded per-model effort tables) and the one wire quirk that
silently breaks the generic `custom` profile on Friendli — disabling
reasoning.

## Installation

```bash
hermes plugins install friendliai/hermes-friendliai-provider
```

Then add your API key to `~/.hermes/.env`:

```
FRIENDLIAI_API_KEY=your_key_here
```

Pick the provider with `hermes model` (FriendliAI → `zai-org/GLM-5.3` etc.)
or set it in `config.yaml`:

```yaml
model:
  provider: friendli
  default: zai-org/GLM-5.3
```

## Why not just point `custom` at Friendli?

- Registering Friendli as a plain `custom`/OpenAI-compatible endpoint in `config.yaml` works for chat, but turning reasoning off gets you an **HTTP 422** — `custom` sends `reasoning_effort: "none"`, which isn't a value Friendli accepts.
- This plugin sends both Friendli disable controls — `reasoning_budget: 0` and `chat_template_kwargs.enable_thinking: false` — so `/reasoning none` and the desktop toggle work without editing your config.
- Effort levels (`low`/`high`/`max`, ...) are validated per model from Friendli's live catalog, not a vocabulary you'd otherwise have to guess or hardcode yourself.
- `hermes model` lists Friendli's current models and picks a fast aux model automatically — a `custom` entry only ever shows what you typed in.

## License

MIT
