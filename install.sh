#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="${1:-$HOME/.gemini/config/plugins/gemini-web}"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$(dirname "$TARGET_DIR")"

if [ "$SOURCE_DIR" != "$TARGET_DIR" ]; then
  echo "[*] Syncing plugin files to $TARGET_DIR ..."
  mkdir -p "$TARGET_DIR/config"
  for item in plugin.json mcp_config.json package.json package-lock.json tsconfig.json README.md install.sh install.ps1 src skills tests; do
    if [ -e "$SOURCE_DIR/$item" ]; then
      rm -rf "$TARGET_DIR/$item"
      cp -R "$SOURCE_DIR/$item" "$TARGET_DIR/$item"
    fi
  done
  cp -f "$SOURCE_DIR/config/selectors.json" "$TARGET_DIR/config/selectors.json"
  cp -f "$SOURCE_DIR/config/config.example.json" "$TARGET_DIR/config/config.example.json"
fi

if [ ! -f "$TARGET_DIR/config/config.json" ] && [ -f "$TARGET_DIR/config/config.example.json" ]; then
  cp "$TARGET_DIR/config/config.example.json" "$TARGET_DIR/config/config.json"
  echo "[+] Initialized local config/config.json from template."
fi

cd "$TARGET_DIR"
echo "[*] Installing isolated Node.js dependencies..."
npm install --no-audit --no-fund
echo "[*] Compiling TypeScript..."
npm run build
echo "[*] Running doctor check..."
node dist/src/cli.js doctor

echo ""
echo "[OK] Antigravity plugin 'gemini-web' installed at: $TARGET_DIR"
echo "Next: Start a new turn in Antigravity and say: /gemini-web login myaccount"
