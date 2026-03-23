#!/bin/zsh

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
NODE_BIN="$ROOT_DIR/.tools/node-v24.14.0-darwin-arm64/bin/node"
ENV_FILE="$ROOT_DIR/.env.local"

export PATH="$ROOT_DIR/.tools/node-v24.14.0-darwin-arm64/bin:$PATH"

if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

exec "$NODE_BIN" "$ROOT_DIR/index.js" "$@"
