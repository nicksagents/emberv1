#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"
export EMBER_ROOT="$ROOT_DIR"
source "$ROOT_DIR/scripts/node-runtime.sh"

# ── Colours ────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'

log()  { echo -e "${BLUE}▶${NC} $*"; }
ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC} $*"; }
err()  { echo -e "${RED}✗${NC} $*" >&2; }
die()  { err "$*"; exit 1; }

append_node_option() {
  local option="$1"
  case " ${NODE_OPTIONS-} " in
    *" $option "*) ;;
    *)
      export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }$option"
      ;;
  esac
}

resolve_node_gyp_js() {
  local node_prefix
  local candidate
  node_prefix="$(cd "$(dirname "$EMBER_NODE_BIN")/.." && pwd)"

  for candidate in \
    "$node_prefix/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js" \
    "/usr/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js" \
    "/usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js"
  do
    if [ -f "$candidate" ]; then
      printf "%s" "$candidate"
      return 0
    fi
  done

  return 1
}

ensure_node_pty_native() {
  log "Verifying node-pty native module..."
  if (cd "$ROOT_DIR/apps/server" && node -e "require('node-pty')") >/dev/null 2>&1; then
    ok "node-pty native module ready"
    return 0
  fi

  warn "node-pty prebuild missing for this platform; attempting source build..."

  local node_pty_dir
  local node_gyp_js
  local node_prefix

  node_pty_dir="$(cd "$ROOT_DIR/apps/server" && node -e "const path=require('node:path');process.stdout.write(path.dirname(require.resolve('node-pty/package.json')));")" || {
    warn "Unable to locate node-pty package. Continuing without PTY native backend."
    return 0
  }
  node_gyp_js="$(resolve_node_gyp_js)" || {
    warn "Unable to locate node-gyp. Continuing without PTY native backend."
    return 0
  }
  node_prefix="$(cd "$(dirname "$EMBER_NODE_BIN")/.." && pwd)"

  (
    cd "$node_pty_dir"
    node "$node_gyp_js" rebuild --nodedir="$node_prefix"
  ) || {
    warn "Failed to compile node-pty native module. Continuing with pipe terminal fallback."
    return 0
  }

  if (cd "$ROOT_DIR/apps/server" && node -e "require('node-pty')") >/dev/null 2>&1; then
    ok "node-pty native module compiled"
    return 0
  fi

  warn "node-pty still failed to load after rebuild. Continuing with pipe terminal fallback."
  return 0
}

add_to_path() {
  local rcfile="$1"
  if [ -f "$rcfile" ] && ! grep -qF '.local/bin' "$rcfile" 2>/dev/null; then
    printf '\n# Added by Ember installer\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$rcfile"
    ok "Updated $rcfile with PATH"
  fi
}

# ── Header ─────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}  Ember — Setup${NC}"
echo -e "  Repo: ${ROOT_DIR}"
echo ""

# ── 1. Node.js runtime ─────────────────────────────────────────────────────
log "Resolving Node.js runtime..."
ember_resolve_node_runtime || die "Unable to resolve a Node runtime with node:sqlite support."
NODE_BIN_DIR="$(cd "$(dirname "$EMBER_NODE_BIN")" && pwd)"
export PATH="$NODE_BIN_DIR:$PATH"
append_node_option "--disable-warning=ExperimentalWarning"
if [ -n "${EMBER_NODE_OPTIONS:-}" ]; then
  append_node_option "$EMBER_NODE_OPTIONS"
fi
ok "Node.js $(node --version) (${EMBER_NODE_SOURCE})"

log "Checking npm..."
command -v npm &>/dev/null || die "npm is required. Reinstall Node.js from https://nodejs.org"
ok "npm $(npm --version)"

# ── 2. pnpm ────────────────────────────────────────────────────────────────
log "Checking pnpm..."
export PATH="$HOME/.local/bin:$PATH"
if ! command -v pnpm &>/dev/null; then
  log "Installing pnpm in ~/.local via npm..."
  npm install -g pnpm@10.9.0 --prefix "$HOME/.local"
fi
command -v pnpm &>/dev/null || die "pnpm is required but was not installed successfully."
ok "pnpm $(pnpm --version)"

# ── 3. Dependencies ────────────────────────────────────────────────────────
log "Installing workspace dependencies..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
ok "Dependencies installed"
ensure_node_pty_native

# ── 4. .env ────────────────────────────────────────────────────────────────
if [ ! -f "$ROOT_DIR/.env" ]; then
  cp "$ROOT_DIR/.env.example" "$ROOT_DIR/.env"
  ok "Created .env from .env.example"
else
  ok ".env already exists"
fi

# ── 5. Build packages ──────────────────────────────────────────────────────
log "Building packages (first run takes ~30 seconds)..."
pnpm --filter @ember/core build
pnpm --filter @ember/ui-schema build
pnpm --filter @ember/connectors build
pnpm --filter @ember/desktop-mcp build
pnpm --filter @ember/prompts build
pnpm --filter @ember/project-scaffold-mcp build
pnpm --filter @ember/cli build
ok "Packages built"

# ── 6. Runtime bootstrap ───────────────────────────────────────────────────
log "Preparing data files and memory runtime..."
node "$ROOT_DIR/scripts/bootstrap-runtime.mjs"
ok "Runtime bootstrap complete"

# ── 7. Playwright browsers ────────────────────────────────────────────────
log "Installing Playwright Chromium (used for web automation)..."
SERVER_BIN="$ROOT_DIR/apps/server/node_modules/.bin"
if [ -x "$SERVER_BIN/playwright" ]; then
  "$SERVER_BIN/playwright" install chromium
else
  (cd "$ROOT_DIR/apps/server" && npx playwright install chromium)
fi
ok "Playwright Chromium installed"

# ── 8. Global `ember` command ─────────────────────────────────────────────
log "Installing the global 'ember' command..."

INSTALL_DIR="$HOME/.local/bin"
mkdir -p "$INSTALL_DIR"
chmod +x "$ROOT_DIR/ember"

# Write a wrapper that delegates to this repo's ember script.
# Using printf to avoid heredoc variable-expansion issues.
printf '#!/usr/bin/env bash\nexec "%s/ember" "$@"\n' "$ROOT_DIR" > "$INSTALL_DIR/ember"
chmod +x "$INSTALL_DIR/ember"
ok "Installed: $INSTALL_DIR/ember"

# Add ~/.local/bin to PATH in shell config files if not already present
add_to_path "$HOME/.zshrc"
add_to_path "$HOME/.bashrc"
add_to_path "$HOME/.bash_profile"

# ── 9. Diagnostics ─────────────────────────────────────────────────────────
log "Running Ember doctor..."
"$ROOT_DIR/ember" doctor
ok "Doctor checks completed"

# ── 10. Done ───────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}  Ember is ready!${NC}"
echo ""

if [[ ":${PATH}:" != *":${HOME}/.local/bin:"* ]]; then
  echo -e "  ${YELLOW}Reload your shell to activate the 'ember' command:${NC}"
  echo -e "    source ~/.zshrc      # zsh users"
  echo -e "    source ~/.bashrc     # bash users"
  echo ""
fi

echo -e "  Start Ember from anywhere:"
echo -e "    ${BOLD}ember${NC}"
echo ""
echo -e "  Or from the repo directory:"
echo -e "    ${BOLD}./ember${NC}"
echo ""
