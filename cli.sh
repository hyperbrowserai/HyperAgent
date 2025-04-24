SCRIPT_DIR="$(cd "$(dirname $(realpath "$0"))" && pwd)"
NODE_OPTIONS="--no-deprecation" node "$SCRIPT_DIR/dist/cli/index.js" $@