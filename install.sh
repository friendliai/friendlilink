#!/usr/bin/env bash
# Installs the frlink CLI: builds it from source and drops a launcher on PATH.
# Single-package TS CLI, with no compiled binary to fetch.
set -euo pipefail

MIN_NODE_MAJOR=18
# Cloned when the script is piped in and FRLINK_SOURCE is unset, so the
# documented `curl ... | bash` one-liner works with nothing else set.
DEFAULT_SOURCE="https://github.com/friendliai/friendlilink.git"
# An explicit override always wins, including when the directory does not
# exist yet.
if [ -n "${FRLINK_HOME:-}" ]; then
  INSTALL_HOME="${FRLINK_HOME}"
else
  INSTALL_HOME="$HOME/.frlink"
fi

CLONE_DIR="$INSTALL_HOME/cli"
BIN_DIR="$HOME/.local/bin"
BIN_NAME="frlink"
# Advertised short names plus the common misspellings, all answered to.
BIN_ALIASES="frn friendlilink friendlink frnlink frlnk frnlnk frnli"
# Marks a forwarder as ours. Short names like `frn` can collide with a
# command the user already has; the alias is written only when the path is
# free or already holds a forwarder carrying this line, so an upgrade still
# overwrites ours and an unrelated command is never truncated.
ALIAS_SENTINEL="frlink alias launcher"

log() { printf '%s\n' "$*"; }
err() { printf 'frlink install: %s\n' "$*" >&2; }
die() {
  err "$*"
  exit 1
}

check_node() {
  if ! command -v node >/dev/null 2>&1; then
    die "Node.js >= ${MIN_NODE_MAJOR} is required but wasn't found on PATH. Install it from nodejs.org and re-run this script."
  fi
  local major
  major="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
  if [ "$major" -lt "$MIN_NODE_MAJOR" ]; then
    die "Node.js >= ${MIN_NODE_MAJOR} is required (found $(node -v)). Install a newer version and re-run this script."
  fi
}

# Prefer an existing local checkout (e.g. `./install.sh` run inside the repo).
# Falls back to cloning FRLINK_SOURCE (default: DEFAULT_SOURCE) when the
# script was piped in and no local checkout exists.
resolve_source_dir() {
  local self="${BASH_SOURCE[0]:-}"
  if [ -n "$self" ] && [ -f "$self" ]; then
    local script_dir
    script_dir="$(cd "$(dirname "$self")" && pwd)"
    # Read the name rather than grepping for a literal: node is already a hard
    # dependency (checked above), and a grep for the package name silently
    # stops matching the day the package is renamed.
    if [ -f "$script_dir/package.json" ] \
      && [ "$(node -p 'require(process.argv[1]).name' "$script_dir/package.json" 2>/dev/null)" = "frlink" ]; then
      echo "$script_dir"
      return
    fi
  fi

  local source_url="${FRLINK_SOURCE:-$DEFAULT_SOURCE}"
  if [ -d "$CLONE_DIR/.git" ]; then
    log "Updating existing checkout at $CLONE_DIR ..." >&2
    git -C "$CLONE_DIR" pull --ff-only
  else
    log "Cloning $source_url into $CLONE_DIR ..." >&2
    git clone --depth 1 "$source_url" "$CLONE_DIR"
  fi
  echo "$CLONE_DIR"
}

build_source() {
  local dir="$1"
  log "Installing dependencies in $dir ..."
  (cd "$dir" && npm install --no-fund --no-audit)
  log "Building ..."
  (cd "$dir" && npm run build)
}

# True when `path` is free or holds a forwarder we wrote before; warns and
# returns false when something else is already there, so installing frlink
# never clobbers an unrelated command that happens to share the name.
claim_alias_path() {
  local path="$1"
  if [ ! -e "$path" ]; then
    return 0
  fi
  if grep -qF "$ALIAS_SENTINEL" "$path" 2>/dev/null; then
    return 0
  fi
  err "Skipping the $(basename "$path") alias: $path already exists and was not created by frlink."
  return 1
}

write_launcher() {
  local dir="$1"
  local entry="$dir/dist/bin/frlink.js"
  local node_path
  node_path="$(command -v node)"

  mkdir -p "$BIN_DIR"
  cat >"$BIN_DIR/$BIN_NAME" <<LAUNCHER
#!/usr/bin/env bash
NODE_BIN="$node_path"
if [ ! -x "\$NODE_BIN" ]; then
  NODE_BIN="node"
fi
exec "\$NODE_BIN" "$entry" "\$@"
LAUNCHER
  chmod +x "$BIN_DIR/$BIN_NAME"

  # One-line forwarders, so the node path lives in exactly one file.
  local alias_name
  for alias_name in $BIN_ALIASES; do
    claim_alias_path "$BIN_DIR/$alias_name" || continue
    printf '#!/usr/bin/env bash\n# %s\nexec "%s/%s" "$@"\n' \
      "$ALIAS_SENTINEL" "$BIN_DIR" "$BIN_NAME" >"$BIN_DIR/$alias_name"
    chmod +x "$BIN_DIR/$alias_name"
  done

  # Best-effort Windows shim (Git-Bash/Cygwin environments only).
  if command -v cygpath >/dev/null 2>&1; then
    local win_entry
    win_entry="$(cygpath -w "$entry")"
    cat >"$BIN_DIR/$BIN_NAME.cmd" <<SHIM
@echo off
node "$win_entry" %*
SHIM
    for alias_name in $BIN_ALIASES; do
      claim_alias_path "$BIN_DIR/$alias_name.cmd" || continue
      cat >"$BIN_DIR/$alias_name.cmd" <<SHIM
@echo off
rem $ALIAS_SENTINEL
node "$win_entry" %*
SHIM
    done
  fi
}

add_bin_dir_to_path() {
  local export_line='export PATH="$HOME/.local/bin:$PATH"'
  local rc_file="$HOME/.bashrc"
  case "${SHELL:-}" in
    */zsh) rc_file="$HOME/.zshrc" ;;
    */bash) rc_file="$HOME/.bashrc" ;;
  esac

  touch "$rc_file"
  if ! grep -qxF "$export_line" "$rc_file"; then
    printf '\n# Added by frlink installer\n%s\n' "$export_line" >>"$rc_file"
    log "Added $BIN_DIR to PATH in $rc_file (restart your shell, or run: source $rc_file)"
  fi

  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) export PATH="$BIN_DIR:$PATH" ;;
  esac
}

main() {
  check_node
  local source_dir
  source_dir="$(resolve_source_dir)"
  build_source "$source_dir"
  write_launcher "$source_dir"
  add_bin_dir_to_path

  log ""
  log "frlink installed: $BIN_DIR/$BIN_NAME"
  log "It also answers to frn and friendlilink — same command, any subcommand."
  log ""
  log "Next steps:"
  log "  frlink login"
  log "  frlink claude on"
  log ""
  log "Other supported agents:"
  log "  frlink opencode on"
  log "  frlink codex on"
  log "  frlink cursor on"
  log "  frlink pi on"
  log "  frlink hermes on"
  log "  frlink dsh on"
}

main "$@"
