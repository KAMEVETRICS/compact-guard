#!/usr/bin/env bash
# Compiles every corpus contract with `compact compile --skip-zk` and writes
# the results to docs/CORPUS_COMPILE_LOG.md. Exit code 1 if any file fails.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d)"
LOG="$ROOT/docs/CORPUS_COMPILE_LOG.md"
fail=0

{
  echo "# Corpus compile log"
  echo
  echo "Date: $(date -u +%Y-%m-%dT%H:%MZ)  "
  echo "Compiler: \`$(compact compile --version 2>&1 | head -1)\`"
  echo
  echo "| File | Result |"
  echo "| --- | --- |"
} > "$LOG"

while IFS= read -r f; do
  rel="${f#"$ROOT"/}"
  if err="$(compact compile --skip-zk "$f" "$OUT/${rel//\//_}" 2>&1)"; then
    echo "| \`$rel\` | ok |" >> "$LOG"
    echo "ok    $rel"
  else
    fail=1
    first="$(printf '%s' "$err" | tr '\n' ' ' | sed 's/|/\\|/g' | cut -c1-200)"
    echo "| \`$rel\` | **FAIL**: $first |" >> "$LOG"
    echo "FAIL  $rel"
    printf '%s\n' "$err" | sed 's/^/      /'
  fi
done < <(find "$ROOT/corpus" -name '*.compact' | sort)

rm -rf "$OUT"
echo "Log: $LOG"
exit "$fail"
