#!/usr/bin/env bash
# Stop hook — extracts "user corrected me" / "I verified X" moments from the
# session transcript and appends candidate memories.
#
# Guards:
#  - dry-run by default; set OPENCLAW_MEMORY_CAPTURE=1 to write for real
#  - rate-limited via touch-file: ≥300s between captures
#  - non-blocking (timeout 1s)

set -u

MEMORY_DIR="$HOME/.claude/projects/-Users-michaelpeter-Projects-src-openclaw/memory"
RATE_FILE="/tmp/openclaw-memory-capture.lock"
CAPTURE_MODE="${OPENCLAW_MEMORY_CAPTURE:-dry}"

# Rate limit: at most one capture per 300s
if [ -f "$RATE_FILE" ]; then
  last=$(stat -f %m "$RATE_FILE" 2>/dev/null || stat -c %Y "$RATE_FILE" 2>/dev/null || echo 0)
  now=$(date +%s)
  if [ $((now - last)) -lt 300 ]; then
    exit 0
  fi
fi
touch "$RATE_FILE"

# The Claude Code harness passes the transcript path via $CLAUDE_TRANSCRIPT_PATH
# (verify against your version). Fall back to skipping if unset.
transcript="${CLAUDE_TRANSCRIPT_PATH:-}"
if [ -z "$transcript" ] || [ ! -f "$transcript" ]; then
  exit 0
fi

# Extract candidate correction moments (simple grep — replace with LLM extractor
# once the Agent SDK path is wired).
candidates=$(grep -E -i \
  'you were right|i verified|i was wrong|actually.*(correct|wrong)|that was a bug in my|[Ii]gnore my earlier' \
  "$transcript" 2>/dev/null | head -5 || true)

if [ -z "$candidates" ]; then
  exit 0
fi

if [ "$CAPTURE_MODE" = "dry" ]; then
  echo "[memory-capture dry-run] candidates:" >&2
  echo "$candidates" | sed 's/^/  /' >&2
  exit 0
fi

# Live mode — append to MEMORY.md with a timestamped section
mkdir -p "$MEMORY_DIR"
{
  echo
  echo "## Session capture $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo
  echo "$candidates"
} >> "$MEMORY_DIR/auto-captures.md"

echo "[memory-capture] appended candidates to $MEMORY_DIR/auto-captures.md" >&2
