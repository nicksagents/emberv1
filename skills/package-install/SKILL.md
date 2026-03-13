---
name: package-install
description: Install libraries, CLIs, and tools on the host machine using brew, npm, pip, cargo, apt, and other package managers.
roles: [coordinator, director]
tools: [run_terminal_command]
---

## Package Installation

Always check if a tool is already installed before installing it. Prefer workspace-local installs over global ones when possible.

### Check before installing

```bash
which <tool>                   # confirm binary is in PATH
brew list | grep <pkg>          # check Homebrew
npm list -g <pkg>               # check global npm
pip show <pkg>                  # check Python package
```

### Package manager quick reference

| Manager | Install | Check installed | Notes |
|---------|---------|----------------|-------|
| **brew** (macOS) | `brew install <pkg>` | `brew list \| grep <pkg>` | Prefer for CLI tools on macOS |
| **npm global** | `npm install -g <pkg>` | `npm list -g <pkg>` | Avoid unless required globally |
| **npx** | `npx <pkg> [args]` | — | One-off execution, no install needed |
| **pip** | `pip install <pkg>` | `pip show <pkg>` | Use venv when possible |
| **pip (venv)** | `python -m pip install <pkg>` | — | Preferred for Python projects |
| **cargo** | `cargo install <pkg>` | `cargo install --list` | Rust binaries |
| **apt** (Ubuntu/Debian) | `sudo apt install <pkg>` | `dpkg -l \| grep <pkg>` | System packages on Linux |
| **pnpm add** | `pnpm add <pkg>` | — | Workspace-local (preferred) |

### Workspace-local installs (preferred over global)

```bash
pnpm add <pkg>                  # add to current pnpm workspace
npm install <pkg>               # add to current npm project
pip install -r requirements.txt # install from file
```

### Common CLI tools (macOS via Homebrew)

```bash
brew install tailscale           # mesh VPN
brew install gh                  # GitHub CLI
brew install jq                  # JSON processor
brew install ffmpeg              # media processing
brew install ripgrep             # fast file search (rg)
brew install watchman            # file watcher
brew install wget curl           # HTTP downloaders
brew install node                # Node.js runtime
brew install python@3.12         # Python runtime
```

### After installing

Verify with `<tool> --version` or `which <tool>`. If not in PATH:
- macOS: `export PATH="$(brew --prefix)/bin:$PATH"` then restart terminal session
- Linux: check `/etc/profile.d/` or add to `~/.bashrc`

### Virtual environments (Python)

```bash
python -m venv .venv             # create venv
source .venv/bin/activate        # activate (macOS/Linux)
pip install <pkg>                # install into venv
```
