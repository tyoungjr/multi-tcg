#!/bin/bash
# Install/refresh the com.collectibles.snap launchd agent on macOS.
# Resolves your current node/npm paths and bakes them into the plist so the
# agent works regardless of nvm/asdf/homebrew layout. Idempotent — re-run after
# switching Node versions or moving the project directory.

set -euo pipefail

if [ "$(uname)" != "Darwin" ]; then
  echo "ERROR: this script is macOS-only (uses launchd)." >&2
  exit 1
fi

# Resolve repo root regardless of where the script is called from.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

NPM_PATH="$(command -v npm || true)"
NODE_PATH="$(command -v node || true)"

if [ -z "$NPM_PATH" ] || [ -z "$NODE_PATH" ]; then
  echo "ERROR: npm and node must be on PATH for the user running this script." >&2
  echo "       Install node 20+ first (brew install node@20 or nvm install 20)." >&2
  exit 1
fi

NODE_DIR="$(dirname "$NODE_PATH")"
TEMPLATE="$SCRIPT_DIR/com.collectibles.snap.plist.template"
TARGET="$HOME/Library/LaunchAgents/com.collectibles.snap.plist"

if [ ! -f "$TEMPLATE" ]; then
  echo "ERROR: template not found at $TEMPLATE" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"

sed \
  -e "s|@@WORKING_DIR@@|$PROJECT_DIR|g" \
  -e "s|@@NPM@@|$NPM_PATH|g" \
  -e "s|@@NODE_DIR@@|$NODE_DIR|g" \
  "$TEMPLATE" > "$TARGET"

echo "==> Wrote $TARGET"
echo "    WORKING_DIR: $PROJECT_DIR"
echo "    NPM:         $NPM_PATH"
echo "    NODE:        $NODE_PATH"

# Unload any existing copy first so we pick up edits to PATH/working dir.
# 2>/dev/null swallows "not loaded" on first install.
launchctl unload "$TARGET" 2>/dev/null || true
launchctl load "$TARGET"

echo ""
echo "==> Loaded. Useful commands:"
echo "    Tail logs:    tail -f '$PROJECT_DIR/snap.log' '$PROJECT_DIR/snap.err.log'"
echo "    Restart:      launchctl kickstart -k gui/\$UID/com.collectibles.snap"
echo "    Stop:         launchctl unload '$TARGET'"
echo "    Status:       launchctl list | grep com.collectibles.snap"
echo ""
echo "==> First-run note: macOS may prompt 'Allow incoming connections?' on"
echo "    port 3457. Click Allow, or pre-approve in"
echo "    System Settings > Network > Firewall."
