#!/usr/bin/env bash
# UserPromptSubmit hook — injects a minimal openclaw ambient status block
# into every prompt when cwd is inside an openclaw/openclooda checkout.
#
# Output cap: ≤ 6 lines. Timeout: 500ms (non-blocking).
# Hooked in via ~/.claude/settings.json — see CR_OPENCLAW_SKILLS_CONTEXT_HYGIENE.md.

set -u

cwd="$(pwd 2>/dev/null)"
case "$cwd" in
  */openclaw*|*/openclooda*) ;;
  *) exit 0 ;;
esac

gateway="unknown"
pending=0
archivist_due=0

# All checks best-effort — hook must never fail the prompt.
gateway=$(timeout 0.3s openclaw gateway status --require-rpc 2>/dev/null | head -1 || echo "unreachable")

if [ -f "$HOME/.openclaw/workspace/.policy-proposals.json" ]; then
  pending=$(jq '[.[] | select(.status=="pending")] | length' "$HOME/.openclaw/workspace/.policy-proposals.json" 2>/dev/null || echo 0)
fi

if [ -f "$HOME/.openclaw/workspace/.archivist-state.json" ]; then
  archivist_due=$(jq -r '.turns_since_last_archivist // 0' "$HOME/.openclaw/workspace/.archivist-state.json" 2>/dev/null || echo 0)
fi

cat <<EOF
<openclaw-ambient>
gateway: $gateway
pending_proposals: $pending
archivist_turns_since_last: $archivist_due
</openclaw-ambient>
EOF
