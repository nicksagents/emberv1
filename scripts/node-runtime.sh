#!/usr/bin/env bash

# Shared Node runtime resolution for Ember scripts.
# Ensures we run with a Node binary that can load node:sqlite.

EMBER_DEFAULT_NODE_VERSION="${EMBER_DEFAULT_NODE_VERSION:-v22.12.0}"

ember_local_node_root() {
  if [ -n "${EMBER_LOCAL_NODE_ROOT:-}" ]; then
    printf "%s" "$EMBER_LOCAL_NODE_ROOT"
    return 0
  fi

  local home_default="$HOME/.local/share/ember"
  if mkdir -p "$home_default" >/dev/null 2>&1; then
    printf "%s" "$home_default"
    return 0
  fi

  if [ -n "${EMBER_ROOT:-}" ]; then
    local repo_default="$EMBER_ROOT/.ember/runtime"
    mkdir -p "$repo_default" >/dev/null 2>&1 || true
    printf "%s" "$repo_default"
    return 0
  fi

  printf "%s" "$home_default"
}

ember_node_supports_sqlite() {
  local node_bin="$1"
  "$node_bin" -e "require('node:sqlite')" >/dev/null 2>&1
}

ember_node_supports_sqlite_with_flag() {
  local node_bin="$1"
  "$node_bin" --experimental-sqlite -e "require('node:sqlite')" >/dev/null 2>&1
}

ember_detect_platform_triplet() {
  local os
  local arch
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Linux) os="linux" ;;
    Darwin) os="darwin" ;;
    *)
      echo "Unsupported OS: $os" >&2
      return 1
      ;;
  esac

  case "$arch" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *)
      echo "Unsupported architecture: $arch" >&2
      return 1
      ;;
  esac

  printf "%s-%s" "$os" "$arch"
}

ember_download_to_file() {
  local url="$1"
  local output="$2"

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$output"
    return
  fi

  if command -v wget >/dev/null 2>&1; then
    wget -q "$url" -O "$output"
    return
  fi

  echo "Neither curl nor wget is installed; cannot download Node runtime." >&2
  return 1
}

ember_ensure_local_node() {
  local version="$EMBER_DEFAULT_NODE_VERSION"
  local triplet
  local local_root
  local install_dir
  local legacy_dir
  local archive
  local archive_alt
  local url
  local url_alt
  local tmp_dir
  local tmp_archive
  local tmp_archive_alt
  local extracted

  triplet="$(ember_detect_platform_triplet)"
  local_root="$(ember_local_node_root)"
  install_dir="$local_root/node-${version}-${triplet}"
  legacy_dir="$HOME/.local/node-${version}"
  if [ -x "$install_dir/bin/node" ]; then
    printf "%s" "$install_dir/bin/node"
    return 0
  fi
  if [ -x "$legacy_dir/bin/node" ]; then
    printf "%s" "$legacy_dir/bin/node"
    return 0
  fi

  archive="node-${version}-${triplet}.tar.xz"
  archive_alt="node-${version}-${triplet}.tar.gz"
  url="https://nodejs.org/dist/${version}/${archive}"
  url_alt="https://nodejs.org/dist/${version}/${archive_alt}"

  mkdir -p "$local_root" || {
    echo "Cannot create local Node runtime directory: $local_root" >&2
    return 1
  }
  tmp_dir="$(mktemp -d)"
  tmp_archive="$tmp_dir/$archive"
  tmp_archive_alt="$tmp_dir/$archive_alt"
  extracted="$tmp_dir/node-${version}-${triplet}"

  if ember_download_to_file "$url" "$tmp_archive"; then
    tar -xJf "$tmp_archive" -C "$tmp_dir" >/dev/null 2>&1 || {
      rm -f "$tmp_archive"
      ember_download_to_file "$url_alt" "$tmp_archive_alt" || {
        rm -rf "$tmp_dir"
        echo "Failed to download Node runtime from $url or $url_alt" >&2
        return 1
      }
      tar -xzf "$tmp_archive_alt" -C "$tmp_dir" || {
        rm -rf "$tmp_dir"
        echo "Failed to extract downloaded Node runtime archive." >&2
        return 1
      }
    }
  else
    ember_download_to_file "$url_alt" "$tmp_archive_alt" || {
      rm -rf "$tmp_dir"
      echo "Failed to download Node runtime from $url or $url_alt" >&2
      return 1
    }
    tar -xzf "$tmp_archive_alt" -C "$tmp_dir" || {
      rm -rf "$tmp_dir"
      echo "Failed to extract downloaded Node runtime archive." >&2
      return 1
    }
  fi
  rm -rf "$install_dir"
  mv "$extracted" "$install_dir" || {
    rm -rf "$tmp_dir"
    echo "Failed to move Node runtime into $install_dir" >&2
    return 1
  }
  rm -rf "$tmp_dir"

  if [ ! -x "$install_dir/bin/node" ]; then
    echo "Failed to install local Node runtime at $install_dir" >&2
    return 1
  fi

  printf "%s" "$install_dir/bin/node"
}

ember_resolve_node_runtime() {
  local current_node
  local resolved_node

  EMBER_NODE_BIN=""
  EMBER_NODE_OPTIONS=""
  EMBER_NODE_SOURCE=""

  current_node="$(command -v node 2>/dev/null || true)"
  if [ -n "$current_node" ] && ember_node_supports_sqlite "$current_node"; then
    EMBER_NODE_BIN="$current_node"
    EMBER_NODE_SOURCE="system"
    return 0
  fi

  if [ -n "$current_node" ] && ember_node_supports_sqlite_with_flag "$current_node"; then
    EMBER_NODE_BIN="$current_node"
    EMBER_NODE_OPTIONS="--experimental-sqlite"
    EMBER_NODE_SOURCE="system-with-flag"
    return 0
  fi

  if ! resolved_node="$(ember_ensure_local_node)"; then
    echo "Unable to install or locate a compatible local Node runtime." >&2
    return 1
  fi
  if ember_node_supports_sqlite "$resolved_node"; then
    EMBER_NODE_BIN="$resolved_node"
    EMBER_NODE_SOURCE="local"
    return 0
  fi

  if ember_node_supports_sqlite_with_flag "$resolved_node"; then
    EMBER_NODE_BIN="$resolved_node"
    EMBER_NODE_OPTIONS="--experimental-sqlite"
    EMBER_NODE_SOURCE="local-with-flag"
    return 0
  fi

  echo "No compatible Node runtime with node:sqlite support is available." >&2
  return 1
}
