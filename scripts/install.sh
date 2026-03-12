#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# ── Colours ────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'

log()  { echo -e "${BLUE}▶${NC} $*"; }
ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC} $*"; }
err()  { echo -e "${RED}✗${NC} $*" >&2; }
die()  { err "$*"; exit 1; }

# ── Header ─────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}  Ember — Setup${NC}"
echo -e "  Repo: ${ROOT_DIR}"
echo ""

# ── 1. Node.js ─────────────────────────────────────────────────────────────
log "Checking Node.js..."
command -v node &>/dev/null || die "Node.js is required. Install v20+ from https://nodejs.org"
NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js v20+ required (found $(node --version)). Update at https://nodejs.org"
ok "Node.js $(node --version)"

log "Checking npm..."
command -v npm &>/dev/null || die "npm is required. Reinstall Node.js from https://nodejs.org"
ok "npm $(npm --version)"

# ── 2. pnpm ────────────────────────────────────────────────────────────────
log "Checking pnpm..."
if ! command -v pnpm &>/dev/null; then
  log "Installing pnpm via corepack..."
  if command -v corepack &>/dev/null; then
    corepack enable
    corepack prepare pnpm@10.9.0 --activate || npm install -g pnpm@10.9.0
  else
    npm install -g pnpm@10.9.0
  fi
fi
ok "pnpm $(pnpm --version)"

# ── 3. Dependencies ────────────────────────────────────────────────────────
log "Installing workspace dependencies..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
ok "Dependencies installed"

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
pnpm --filter @ember/prompts build
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
add_to_path() {
  local rcfile="$1"
  if [ -f "$rcfile" ] && ! grep -qF '.local/bin' "$rcfile" 2>/dev/null; then
    printf '\n# Added by Ember installer\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$rcfile"
    ok "Updated $rcfile with PATH"
  fi
}
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
