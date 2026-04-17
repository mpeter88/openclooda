#!/usr/bin/env bash
# watch-archivist.sh — tight feedback loop for archivist.ts / archivist.test.ts edits
# Usage: ./scripts/watch-archivist.sh
# Runs tsc --noEmit + jest --testPathPattern archivist on every file save.
# Requires: nodemon or fswatch (macOS) + npx available

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OODA_DIR="$(dirname "$SCRIPT_DIR")"

cd "$OODA_DIR"

echo "🔍 OODA archivist watcher starting..."
echo "   Dir: $OODA_DIR"
echo "   Watching: archivist.ts, archivist.test.ts, types.ts"
echo "   Press Ctrl+C to stop."
echo ""

run_checks() {
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "⏱  $(date '+%H:%M:%S') — running checks..."
  echo ""

  echo "📐 tsc --noEmit..."
  if npx tsc --noEmit 2>&1; then
    echo "✅ Type check passed"
  else
    echo "❌ Type errors found"
  fi

  echo ""
  echo "🧪 jest --testPathPattern archivist..."
  if npx jest --testPathPattern archivist --no-coverage 2>&1; then
    echo "✅ Tests passed"
  else
    echo "❌ Tests failed"
  fi
  echo ""
}

# Run immediately on start
run_checks

# Watch for changes
if command -v fswatch &>/dev/null; then
  fswatch -o \
    "$OODA_DIR/archivist.ts" \
    "$OODA_DIR/archivist.test.ts" \
    "$OODA_DIR/types.ts" \
    | while read -r _; do
        run_checks
      done
elif command -v nodemon &>/dev/null; then
  nodemon \
    --watch archivist.ts \
    --watch archivist.test.ts \
    --watch types.ts \
    --ext ts \
    --exec "npx tsc --noEmit && npx jest --testPathPattern archivist --no-coverage" \
    2>&1
else
  echo "⚠️  Neither fswatch nor nodemon found."
  echo "   Install one: brew install fswatch  OR  npm install -g nodemon"
  echo "   Running checks once and exiting."
fi
