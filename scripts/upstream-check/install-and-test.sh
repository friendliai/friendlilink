#!/usr/bin/env bash
# Upstream compat watch — per-harness install + unit-test runner (CI matrix step).
#
# Usage: install-and-test.sh <name> <to-version>
#
# Installs the NEW upstream version of one harness CLI, then runs that
# harness's vitest suite with HOME and harness homes redirected into a
# throwaway sandbox (the shell-script twin of test/helpers.ts
# createSandboxHome()). Reports skipped tests as failure: with the real CLI
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

# Dependency install first, with the normal HOME — the sandbox redirection
# below is for the test process, not the package manager (a redirected HOME
# gives pnpm an empty cache and costs minutes on CI for nothing). No
# --frozen-lockfile: lockfiles are intentionally not committed to this repo
# (see .github/workflows/ci.yml).
pnpm install

# --- unit ------------------------------------------------------------------
run_unit() {
  local sandbox
  sandbox="$(mktemp -d)"
  export HOME="$sandbox/home"
  export XDG_CONFIG_HOME="$sandbox/home/.config"
  export APPDATA="$sandbox/home/AppData/Roaming"
  export DSH_HOME="$sandbox/home/.dsh"
  export HERMES_HOME="$sandbox/home/.hermes"
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
run_unit
