---
name: openclooda-memory-health
description: Current OODA memory health — archivist state, knowledge counts, pending proposals, distortion regime.
paths:
  - "extensions/memory-ooda/**"
  - "extensions/memory-lancedb/**"
---

# OpenClooda Memory Health

## Archivist State

!`cat ~/.openclaw/workspace/.archivist-state.json 2>/dev/null | jq . 2>/dev/null || echo "no archivist state file"`

## Pending Proposals

!`openclaw workspace proposals list --pending 2>&1 | head -20`

## LanceDB Memory Stats

!`openclaw ltm stats 2>&1 | head -10`

## Recent Distortion Readings

!`tail -n 5 ~/.openclaw/workspace/.distortion-history.jsonl 2>/dev/null || echo "no distortion history"`

## Recent Gate History (last 5)

!`tail -n 5 ~/.openclaw/workspace/.gate-history.jsonl 2>/dev/null || echo "no gate history"`

---

Rules when acting on this output:

- `turns_since_last_archivist > 3× interval` means archivist is stalled — check last_run_at and logs.
- `campbell_suspected` in distortion history: do NOT approve weight proposals until regime returns to healthy.
- Pending proposals > 5: triage them before creating more.
