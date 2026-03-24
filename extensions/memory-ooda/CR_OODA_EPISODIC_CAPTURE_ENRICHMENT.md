# CR: OODA Episodic Capture Enrichment

**Date:** 2026-03-18  
**Status:** IMPLEMENTED  
**Priority:** MEDIUM — Archivist has data but it's incomplete; semantic distillation quality is limited

---

## Problem

`memory-lancedb` with `autoCapture: true` only stores **user message text** from `agent_end`
events. The self-poisoning guard (skip non-user messages) is too conservative — it filters
out exactly the content the Archivist needs to build a useful semantic model:

1. **Assistant decisions and summaries** — what was built, decided, concluded each turn
2. **Explicit "remember this" moments** — user-directed captures that should always persist
3. **Structural/decision records** — CRs written, config changes made, significant tool actions

Result: the Archivist sees conversation topics but not decisions or outcomes. `KNOWLEDGE.json`
can learn "user talks about AMF platform" but not "team decided to write CRs for all changes"
or "memory-ooda was decoupled from memory slot on 2026-03-18."

---

## Changes

### C1 — Capture assistant turn summaries (MEDIUM)

In `memory-lancedb` `agent_end` capture, add a second pass for the **last assistant message**
with `importance: 0.5` (lower than user messages at 0.7). Filter to meaningful content only:

- Skip pure tool-use turns (only tool_use blocks, no text)
- Skip short acks ("Got it.", "Done.", "OK.")
- Capture turns where assistant text > 100 chars and contains a decision, conclusion, or summary

```typescript
// Capture last assistant message if substantive
const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
if (lastAssistant && isSubstantiveAssistantTurn(lastAssistant)) {
  const text = extractAssistantText(lastAssistant);
  if (text && shouldCapture(text)) {
    await db.store({ text, importance: 0.5, category: "decision", source: "assistant" });
  }
}
```

### C2 — High-importance forced capture via tool event (MEDIUM)

When the agent calls `memory_store` tool (already exists), ensure the capture bypasses
`shouldCapture` filters and stores at the specified importance. Currently `memory_store`
and `autoCapture` are separate pipelines — they should share the same LanceDB table so
the Archivist sees both.

### C3 — Structural capture hook on significant events (LOW)

Register captures for deterministic high-signal events:

- `config.patch` / `config.apply` — capture the change summary
- CR file written (detect `write` tool calls to `cr/*.md` paths)
- Gateway restart — capture reason

These are low-volume, high-signal events that the Archivist should always see regardless
of message content filtering.

---

## Files Changed

| File                                 | Change                                                      |
| ------------------------------------ | ----------------------------------------------------------- |
| `extensions/memory-lancedb/index.ts` | C1: capture last assistant message when substantive         |
| `extensions/memory-lancedb/index.ts` | C2: unify memory_store tool captures with autoCapture table |
| `extensions/memory-ooda/index.ts`    | C3: register structural captures on config/CR events        |

---

## Notes

- The "self-poisoning" concern is valid for raw model output (hallucinations, uncertainty).
  It's not valid for assistant turn _summaries_ of what was done. The fix is better filtering,
  not blanket exclusion.
- `importance: 0.5` for assistant captures means they rank below user messages in recall but
  above the `0.3` threshold typically used for pruning.
- C3 is the highest signal-to-noise addition — a CR being written is unambiguously a
  significant decision event. Zero false positives.
