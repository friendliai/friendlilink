#!/usr/bin/env bash
# Upstream compat watch — per-harness install + unit-test runner (CI matrix step).
#
# Usage: install-and-test.sh <name> <to-version>
#
# Installs the NEW upstream version of one harness CLI, then runs that
# harness's vitest suite with HOME and harness homes redirected into a
# throwaway sandbox (the shell-script twin of test/helpers.ts
# createSandboxHome()). Hermes is intentionally omitted from the env override:
# its tests create their own per-test homes, and hermesHome() must resolve
# those paths from the test context. Reports skipped tests as failure: with the real CLI
# installed, describe.skipIf(binary) must not skip — a skip here means the new
# version broke the probe or the install, and a "pass" would be misleading.
#
# Exit codes (consumed by the workflow unit step's outcome):
#   0 = unit pass, nonzero = unit fail (or install fail — indistinguishable
#   by design; both mean "investigate this version").

set -euo pipefail

name="$1"
to="$2"
[[ -z "$name" || -z "$to" ]] && { echo "usage: install-and-test.sh <name> <to>"; exit 2; }

# --- install ---------------------------------------------------------------
install_claude()   {
  npm install -g "@anthropic-ai/claude-code@$to"
  # Opt the real CLI into the claude integration suite (see
  # test/harnesses/claude/claude-cli.integration.test.ts — the suite runs
  # only when this env points at a binary).
  export FRLINK_TEST_CLAUDE_BINARY="$(npm prefix -g)/bin/claude"
}
install_codex()    { npm install -g "@openai/codex@$to"; }
install_opencode() { npm install -g "opencode-ai@$to"; }
install_pi()       { npm install -g "@earendil-works/pi-coding-agent@$to"; }
install_dsh()      { npm install -g "@deepseek-ai/dsh-llm@$to"; }
# hermes distributes via its own installer (repo is private:true on npm —
# the `hermes-agent` npm package is an unofficial third-party bridge).
# The installer always fetches latest, so verify it matches $to afterwards.
install_hermes()   {
  curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash >/dev/null
  export PATH="$HOME/.hermes/bin:$PATH"
  local got
  got="$(hermes --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
  if [[ "$got" != "$to" ]]; then
    echo "hermes installed $got, expected $to (installer fetches latest)"
    exit 1
  fi
}

# Install only the root app for non-dsh legs. A workspace-wide install also
# runs the dsh adapter's prepare script, which must not make an unrelated
# harness's result fail. Keep the normal HOME for pnpm's cache; only the
# test process below uses the sandbox. The dsh leg deliberately updates its
# dependency in this disposable checkout rather than freezing the lockfile.
pnpm --filter frlink install

if [[ "$name" == dsh ]]; then
  # Compile the local adapter against the version under test, not whichever
  # dsh-llm version happens to be declared in this checkout. This leg alone
  # installs the workspace plugin and must fail on adapter incompatibility.
  pnpm --filter @friendliai/dsh-llm-friendli add --save-dev --save-exact "@deepseek-ai/dsh-llm@$to"
  pnpm --filter @friendliai/dsh-llm-friendli run typecheck
fi

# Hermes' Python provider is not a pnpm workspace package. Exercise it only
# on the Hermes leg, against the exact runtime installed above, so a provider
# failure cannot mark another harness's update as incompatible.
run_hermes_plugin() {
  local sandbox runtime status=0
  sandbox="$(mktemp -d)"
  runtime="$HOME/.hermes/hermes-agent"
  mkdir -p "$sandbox/plugins/model-providers"
  ln -s "$PWD/packages/hermes-friendli-provider" "$sandbox/plugins/model-providers/friendli"
  HERMES_HOME="$sandbox" PYTHONPATH="$runtime${PYTHONPATH:+:$PYTHONPATH}" \
    uv run --no-project --python "$runtime/venv/bin/python" --with pytest \
      python -m pytest packages/hermes-friendli-provider/test_friendli_profile.py \
      packages/hermes-friendli-provider/test_transport_kwargs.py -q || status=$?
  rm -rf "$sandbox"
  return "$status"
}

# --- unit ------------------------------------------------------------------
run_unit() {
  local sandbox
  sandbox="$(mktemp -d)"
  export HOME="$sandbox/home"
  export XDG_CONFIG_HOME="$sandbox/home/.config"
  export APPDATA="$sandbox/home/AppData/Roaming"
  export DSH_HOME="$sandbox/home/.dsh"

  export PI_CODING_AGENT_DIR="$sandbox/home/.pi/agent"

  set +e
  pnpm test -- "test/harnesses/$name" 2>&1 | tee /tmp/unit-output.txt
  local status=${PIPESTATUS[0]}
  set -e
  rm -rf "$sandbox"

  if grep -Eq "skipped *[0-9]+| *[0-9]+ *skipped" /tmp/unit-output.txt; then
    echo "unit: skipped tests detected — treating as fail (new version broke the probe or install)"
    return 1
  fi
  return "$status"
}

case "$name" in
  claude|codex|opencode|pi|hermes|dsh) ;;
  *) echo "unknown harness: $name"; exit 2 ;;
esac

cd "$(dirname "$0")/../.."
"install_$name"
if [[ "$name" == hermes ]]; then
  run_hermes_plugin
fi
run_unit
