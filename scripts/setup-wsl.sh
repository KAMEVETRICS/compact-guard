#!/usr/bin/env bash
# Run inside WSL (Ubuntu). Installs the Compact toolchain pinned to the
# version in the Midnight compatibility matrix, then compiles the corpus.
# Docs: https://docs.midnight.network/getting-started/installation
set -euo pipefail

COMPACT_VERSION="${COMPACT_VERSION:-0.31.1}"

if ! command -v compact >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -LsSf \
    https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh
  # The installer puts compact in ~/.local/bin (or ~/.compact/bin on some versions).
  export PATH="$HOME/.local/bin:$HOME/.compact/bin:$PATH"
fi

compact update "$COMPACT_VERSION"
compact --version
compact compile --version

"$(dirname "$0")/compile-corpus.sh"
