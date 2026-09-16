# @friendliai/dsh-llm-friendli

[![npm](https://img.shields.io/npm/v/@friendliai/dsh-llm-friendli)](https://www.npmjs.com/package/@friendliai/dsh-llm-friendli)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that adds [FriendliAI](https://friendli.ai) as an LLM provider. Friendli speaks the OpenAI-compatible chat API, so the adapter implements the harness `LlmAdapter` contract over it and fetches the model catalog from Friendli at runtime.

## Quick start

Install the `dsh` CLI, add the plugin to a profile, export your key, and launch:

```bash
npm i -g @deepseek-ai/dsh                       # the dsh CLI (needs Node.js)
dsh plugin --profile web add @friendliai/dsh-llm-friendli   # register the friendli provider
export FRIENDLIAI_API_KEY="flp_..."               # your Friendli key
dsh web                                         # friendli is now a provider
```

That's it. `dsh plugin add` merges the plugin's bundle patch into the profile, so the `friendli` provider is registered with working defaults — no config file to touch. Open the web UI, pick a Friendli model, and go. The model list is pulled live from Friendli.

Prefer not to install globally? Prefix each command with `npx @deepseek-ai/dsh` instead.

Confirm the layer loaded without booting:

```bash
dsh --profile web --dump-config   # look for a "# == @friendliai/dsh-llm-friendli" layer
```

Get a key from the [Friendli dashboard](https://friendli.ai). It's read from the environment on every request, so never inline it in a config file or commit it.

## Configuration

The defaults work out of the box. To override any of them, add a config block in your profile's own `cordis.patch.yml`:

```yaml
- id: "@friendliai/dsh-llm-friendli"
  name: "@friendliai/dsh-llm-friendli"
  config:
    apiKeyEnv: FRIENDLIAI_API_KEY # default
    baseURL: https://api.friendli.ai/serverless/v1 # default
    providers: [friendli] # default
    thinking: enabled # optional; on/off for controllable models
    modelCacheTtlMs: 60000 # default; model-catalog cache
    extraHeaders: { X-Title: DeepSeek Harness } # optional; static headers merged after attribution
```

To use it outside `dsh web`, point an agent at a Friendli model id (as returned by `GET /models`). See [`examples/cordis.yml`](examples/cordis.yml) for a full fragment.

```yaml
- id: agent-loop
  name: "@deepseek-ai/dsh-agent-loop"
  config:
    agents:
      - id: main
        provider: friendli
        model: zai-org/GLM-5.2
```

## License

MIT © FriendliAI
