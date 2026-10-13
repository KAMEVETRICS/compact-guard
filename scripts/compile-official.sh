#!/usr/bin/env bash
# Offline validation of vendored examples; compiler outputs stay under /tmp.
set -uo pipefail
export PATH="$HOME/.local/bin:$HOME/.compact/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d /tmp/compact-official.XXXXXX)"
failed=0
echo "Compiler: $(compact compile --version)"
for source in "$ROOT"/packages/analyzer/test/fixtures/official/*.compact; do
  echo "FILE $(basename "$source")"
  if compact compile --skip-zk "$source" "$OUT/$(basename "$source" .compact)"; then
    echo "RESULT ok"
  else
    echo "RESULT FAIL"
    failed=1
  fi
done
echo "Compiler output: $OUT"
exit "$failed"
