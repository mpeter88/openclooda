#!/usr/bin/env bash
# pre-edit-check.sh — validate exact-text exists before attempting an edit
# Usage: ./scripts/pre-edit-check.sh <file> <search_text>
# Example: ./scripts/pre-edit-check.sh extensions/memory-ooda/index.ts "before_agent_start"
#
# Purpose: Catches whitespace drift or prior partial edits before the edit tool
# fails with "Could not find the exact text". Run this before every edit to
# index.ts or archivist.ts.

set -euo pipefail

FILE="${1:-}"
SEARCH="${2:-}"

if [[ -z "$FILE" || -z "$SEARCH" ]]; then
  echo "Usage: $0 <file> <search_text_first_line>"
  echo ""
  echo "Example:"
  echo "  $0 extensions/memory-ooda/index.ts 'before_agent_start'"
  exit 1
fi

if [[ ! -f "$FILE" ]]; then
  echo "❌ File not found: $FILE"
  exit 1
fi

MATCHES=$(grep -n "$SEARCH" "$FILE" 2>/dev/null | head -5)

if [[ -z "$MATCHES" ]]; then
  echo "❌ NOT FOUND: '$SEARCH' in $FILE"
  echo ""
  echo "   The target block may have drifted. Read the file fresh before editing."
  exit 1
else
  echo "✅ Found in $FILE:"
  echo "$MATCHES"
  echo ""
  echo "   Safe to proceed with edit."
fi
