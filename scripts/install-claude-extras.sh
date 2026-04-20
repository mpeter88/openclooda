#!/usr/bin/env bash
# Idempotent installer for OpenClaw's Claude Code skills + hooks.
# Copies from openclooda/tools/claude/** to ~/.claude/**.
#
# Safe to run multiple times. Does NOT auto-merge settings.json — prints a diff
# and asks for manual application.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/tools/claude"
DEST="$HOME/.claude"

if [ ! -d "$SRC" ]; then
  echo "ERROR: $SRC missing — run from openclooda checkout" >&2
  exit 1
fi

mkdir -p "$DEST/skills" "$DEST/hooks"

echo "Installing skills to $DEST/skills/ ..."
for skill_dir in "$SRC/skills"/*/; do
  [ -d "$skill_dir" ] || continue
  name=$(basename "$skill_dir")
  target="$DEST/skills/$name"
  mkdir -p "$target"
  cp "$skill_dir"/SKILL.md "$target/SKILL.md"
  echo "  - $name"
done

echo "Installing hooks to $DEST/hooks/ ..."
for hook in "$SRC/hooks"/*.sh; do
  [ -f "$hook" ] || continue
  name=$(basename "$hook")
  cp "$hook" "$DEST/hooks/$name"
  chmod 700 "$DEST/hooks/$name"
  echo "  - $name"
done

echo
echo "Settings fragment at: $SRC/settings/settings.fragment.json"
echo "Merge into $DEST/settings.json manually — script does NOT auto-merge."
echo
echo "Done. Restart any open Claude Code sessions to pick up new skills + hooks."
