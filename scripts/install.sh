#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "Checking local toolchain..."
command -v node >/dev/null 2>&1 || { echo "Node is required."; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "npm is required."; exit 1; }

if ! command -v pnpm >/dev/null 2>&1; then
  echo "Enabling pnpm through corepack..."
  corepack enable pnpm
fi

echo "Installing workspace dependencies..."
pnpm install

echo "Preparing JSON data files..."
mkdir -p data
for file in connector-types.json providers.json provider-secrets.json role-assignments.json settings.json runtime.json; do
  if [ ! -f "data/$file" ]; then
    touch "data/$file"
  fi
done

echo "Building shared packages..."
pnpm build

echo "EMBER install complete."
echo "Next step: ./ember"
