#!/usr/bin/env bash
# Upstream compat watch — e2e for ONE harness, typed the way a user would.
# Usage: e2e.sh <name> <to>      (needs FRIENDLIAI_API_KEY in the env)
#
# Clean terminal -> install harness -> install frlink from main -> login -> on
# -> text, image, then remaining live input modalities, one tiny inference each
# where the harness supports it -> check relay availability -> off -> reset.
# Any failing command fails the run (set -e).

set -euo pipefail

name="${1:-}" to="${2:-}"
[[ -z "$name" || -z "$to" ]] && { echo "usage: e2e.sh <name> <to>"; exit 2; }
case "$name" in claude|codex|opencode|pi|hermes|dsh) ;; *) echo "unknown harness: $name"; exit 2 ;; esac

# --- clean terminal: empty env, empty HOME, thrown away on exit ---------------
if [[ -z "${E2E_CLEAN:-}" ]]; then
  : "${FRIENDLIAI_API_KEY:?FRIENDLIAI_API_KEY is required}"
  exec env -i E2E_CLEAN=1 HOME="$(mktemp -d)" TERM=dumb \
    PATH="$(dirname "$(command -v node)"):/usr/local/bin:/usr/bin:/bin" \
    FFMPEG_BINARY="$(command -v ffmpeg)" \
    FRIENDLIAI_API_KEY="$FRIENDLIAI_API_KEY" bash "$0" "$@"
fi
relay="$(cd "$(dirname "$0")/.." && pwd)/friendli-relay.mjs"
modalities="$(cd "$(dirname "$0")" && pwd)/modalities.mjs"
# On failure, say what Friendli answered: every 4xx/5xx, plus requests the relay
# could not forward at all (those never reach capture.jsonl).
cleanup() {
  local rc=$?
  if [[ $rc != 0 && -f capture.jsonl ]]; then
    node -e '
for (const l of require("fs").readFileSync("capture.jsonl", "utf8").trim().split("\n").map(JSON.parse))
  if (l.request.method === "POST" && l.response.status >= 400)
    console.error("proxy: Friendli answered", l.response.status, l.request.path, JSON.stringify(l.response.body).slice(0, 300));
' || true
  fi
  [[ $rc == 0 ]] || grep "upstream error" relay.log 2>/dev/null || true
  kill "${relay_pid:-}" 2>/dev/null || true
  rm -rf "$HOME"
}
trap cleanup EXIT
cd "$HOME"

# The key stays out of the environment until the user "types" it, so the
# third-party installs below never see it.
key="$FRIENDLIAI_API_KEY"
unset FRIENDLIAI_API_KEY

# Cheapest active model per live input modality.
models_url=https://api.friendli.ai/serverless/v1/models
echo "e2e: fetching model catalog: GET $models_url" >&2
if http_status="$(curl -fsS -o models.json -w '%{http_code}' "$models_url")"; then
  :
else
  rc=$?
  echo "e2e: FAILED stage=model-catalog method=GET url=$models_url http_status=$http_status curl_exit=$rc" >&2
  exit "$rc"
fi
node "$modalities" plan models.json > cases.txt
[[ -s cases.txt ]] || { echo "e2e: model catalog has no input modalities"; exit 1; }
prompt="Reply briefly. Do not use tools."

export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$HOME/.hermes/bin:$PATH"

# --- 1. install the harness (the version under test) --------------------------
case "$name" in
  claude)   npm install -g "@anthropic-ai/claude-code@$to" ;;
  codex)    npm install -g "@openai/codex@$to" ;;
  opencode) npm install -g "opencode-ai@$to" ;;
  pi)       npm install -g "@earendil-works/pi-coding-agent@$to" ;;
  hermes)   curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
            # the installer always fetches latest: make sure that is the version under test
            [[ "$(hermes --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)" == "$to" ]] ;;
  dsh)      npm install -g "@deepseek-ai/dsh-llm@$to" pnpm ;;
esac

# --- 2. install frlink from the latest main -----------------------------------
curl -fsSL https://raw.githubusercontent.com/friendliai/friendlilink/main/install.sh | bash

frlink check status | grep "^  $name (.*): not routed"

# --- 3. run each supported modality in a fresh harness session ----------------
frlink login --api-key "$key"

proxy=http://127.0.0.1:8787
node "$relay" --port 8787 --log capture.jsonl --bodies 1000000 --quiet 2>relay.log &
relay_pid=$!
until curl -s -o /dev/null "$proxy"; do kill -0 "$relay_pid"; sleep 0.2; done

profile=()
[[ "$name" == dsh ]] && profile=(--profile headless)

while read -r modality model level <&3; do
  case "$modality:$name" in
    text:*|image:claude|image:codex|image:opencode|image:pi|image:hermes) ;;
    video:opencode) ;;
    *) echo "e2e: $modality skipped: $name has no native attachment transport"; continue ;;
  esac
  echo "e2e: $modality: $model, reasoning $level"
  node "$modalities" fixture "$modality"
  # No previous session's request may satisfy this case.
  : > capture.jsonl
  attachment=() effort=()
  unset MAX_THINKING_TOKENS
  case "$name" in
    claude)
      frlink claude on --model "$model" --base-url "$proxy"
      if [[ "$level" == off ]]; then export MAX_THINKING_TOKENS=0
      elif [[ "$level" != default ]]; then effort=(--effort "$level"); fi
      if [[ "$modality" == image ]]; then
        out="$(claude ${effort[@]+"${effort[@]}"} -p --input-format stream-json --output-format stream-json --verbose < image.jsonl)"
      else
        out="$(claude ${effort[@]+"${effort[@]}"} -p "$prompt")"
      fi ;;
    codex)
      frlink codex on --model "$model" --base-url "$proxy"
      [[ "$level" == default ]] || effort=(-c model_reasoning_effort="${level/off/none}")
      [[ "$modality" == image ]] && attachment=(--image "$HOME/input.png")
      out="$(codex exec --skip-git-repo-check ${effort[@]+"${effort[@]}"} ${attachment[@]+"${attachment[@]}"} -- "$prompt")" ;;
    opencode)
      frlink opencode on --model "$model"
      export OPENCODE_CONFIG_CONTENT='{"provider":{"friendli":{"options":{"baseURL":"'"$proxy"'/v1"}}}}'
      [[ "$level" == default ]] || effort=(--variant "$level")
      [[ "$modality" == image ]] && attachment=(--file "$HOME/input.png")
      [[ "$modality" == video ]] && attachment=(--file "$HOME/input.mp4")
      out="$(opencode run ${effort[@]+"${effort[@]}"} --title e2e "$prompt" ${attachment[@]+"${attachment[@]}"})" ;;
    pi)
      frlink pi on --model "$model" --base-url "$proxy"
      [[ "$level" == default ]] || effort=(--thinking "$level")
      [[ "$modality" == image ]] && attachment=("@$HOME/input.png")
      out="$(pi -p ${effort[@]+"${effort[@]}"} ${attachment[@]+"${attachment[@]}"} "$prompt")" ;;
    hermes)
      frlink hermes on --model "$model"
      hermes config set model.base_url "$proxy/v1"
      [[ "$level" == default ]] || effort=(--reasoning "${level/off/none}")
      [[ "$modality" == image ]] && attachment=(--image "$HOME/input.png")
      out="$(hermes chat -Q ${effort[@]+"${effort[@]}"} ${attachment[@]+"${attachment[@]}"} -q "$prompt")" ;;
    dsh)
      frlink dsh on "${profile[@]}" --model "$model"
      cat > .dsh/settings.yaml <<YAML
agent-default-model: { provider: friendli, model: $model$([[ "$level" == default ]] || printf ', reasoningEffort: "%s"' "$level") }
YAML
      cat > thinking-off.yml <<YAML
- id: "@friendliai/dsh-llm-friendli"
  config: { thinking: disabled, baseURL: "$proxy/v1" }
YAML
      # dsh headless accepts text tasks only; it has no attachment flag.
      out="$(dsh "${profile[@]}" --patch thinking-off.yml ${attachment[@]+"${attachment[@]}"} "$prompt")" ;;
  esac
  echo "$out"
  node "$modalities" verify "$modality" "$model" "$level"
done 3< cases.txt < /dev/null

frlink "$name" status ${profile[@]+"${profile[@]}"} | grep "routed through FriendliAI"
frlink "$name" off ${profile[@]+"${profile[@]}"}

# --- 4. the reset really happened ---------------------------------------------
frlink "$name" status ${profile[@]+"${profile[@]}"} | grep "not managed by frlink"
if grep -rIlF "$key" "$HOME" --exclude-dir=.frlink; then
  echo "e2e: API key still present in the files above after \`frlink $name off\`"
  exit 1
fi
frlink logout
frlink check status | grep "API key: not saved"
echo "e2e: $name $to passed"
