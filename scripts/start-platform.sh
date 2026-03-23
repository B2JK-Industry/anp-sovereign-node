#!/bin/zsh
# Start the ANP node in platform mode.
# In platform mode the Hunter (auto-bidder) is disabled and the node
# acts as a shared discovery/storage layer for multiple agents.
#
# Usage:
#   ./scripts/start-platform.sh                  # production (node)
#   ./scripts/start-platform.sh --dev            # development (node --watch)
#
# Override the port with PORT=3001 ./scripts/start-platform.sh

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
NODE_BIN="$ROOT_DIR/.tools/node-v24.14.0-darwin-arm64/bin/node"
ENV_FILE="$ROOT_DIR/.env.local"

export PATH="$ROOT_DIR/.tools/node-v24.14.0-darwin-arm64/bin:$PATH"

if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

export ANP_PLATFORM_MODE=true
export PORT="${PORT:-3001}"

if [ "$1" = "--dev" ]; then
  exec "$NODE_BIN" --watch "$ROOT_DIR/backend/src/server.js"
else
  exec "$NODE_BIN" "$ROOT_DIR/backend/src/server.js"
fi
