# CR: OODA Slot Decoupling — memory-ooda as slotless cognitive layer

**Date:** 2026-03-18  
**Status:** IMPLEMENTED  
**Priority:** P0 — memory-ooda and memory-lancedb are mutually exclusive; Archivist has no Tier 2 data to read

---

## Problem

`memory-ooda` is registered as `kind: "memory"`, which puts it in the exclusive memory slot.
When `plugins.slots.memory = "memory-ooda"`, the slot system automatically disables
`memory-lancedb` — the very plugin that provides the Tier 2 episodic store the Archivist reads.

Net result: the Archivist fires every 10 turns, finds no `memories` table (LanceDB never
initialized), logs a warning, and does nothing. Tier 3 semantic memory is never updated.

---

## Root Cause

`memory-ooda` is architecturally a **cognitive reasoning layer**, not a memory provider.
It reads from Tier 2 (LanceDB) and writes to Tier 3 (KNOWLEDGE.json). It does not provide
capture, retrieval, or recall services — those belong to `memory-lancedb`.

Registering it as `kind: "memory"` was incorrect. The two plugins are complementary:

```
memory-lancedb  →  Tier 2 capture + recall (owns memory slot)
memory-ooda     →  Tier 3 distillation + context injection (slotless)
```

---

## Fix

### C1 — Remove `kind` from memory-ooda plugin registration (CRITICAL)

**`extensions/memory-ooda/index.ts`** — remove `kind: "memory" as const`:

```typescript
const oodaPlugin = {
  id: "memory-ooda",
  name: "Memory (OODA)",
  description: "Cognitive OODA agent — Tier 3 semantic memory with knowledge injection",
  // kind removed — memory-ooda is slotless; memory-lancedb owns the memory slot
  register(api: OpenClawPluginApi) { ... }
};
```

### C2 — Update `openclaw.plugin.json` (CRITICAL)

**`extensions/memory-ooda/openclaw.plugin.json`** — remove `"kind": "memory"`:

```json
{
  "id": "memory-ooda",
  "configSchema": { ... }
}
```

### C3 — Update config — switch memory slot back to memory-lancedb (CRITICAL)

In `~/.openclaw/openclaw.json`, change:

```json
"plugins": {
  "slots": {
    "memory": "memory-lancedb"   ← was "memory-ooda"
  },
  "entries": {
    "memory-lancedb": { "enabled": true, ... },
    "memory-ooda": { "enabled": true }   ← stays enabled, now slotless
  }
}
```

### C4 — Rebuild + restart (CRITICAL)

```
pnpm build:docker
openclaw gateway restart
```

---

## Expected Outcome After Fix

- `memory-lancedb` owns the memory slot → captures episodic events on every `agent_end`
- `memory-ooda` loads as a plain plugin → injects KNOWLEDGE.json context, runs Archivist
- Archivist fires at turn 10 → reads from LanceDB `memories` table → distills into KNOWLEDGE.json
- No slot conflict, no mutual exclusion

---

## Config After Fix

```
plugins.slots.memory       = "memory-lancedb"   (Tier 2)
plugins.entries.memory-lancedb.enabled = true
plugins.entries.memory-ooda.enabled    = true    (slotless, runs alongside)
```

---

## Files Changed

| File                                          | Change                                             |
| --------------------------------------------- | -------------------------------------------------- |
| `extensions/memory-ooda/index.ts`             | Remove `kind: "memory" as const`                   |
| `extensions/memory-ooda/openclaw.plugin.json` | Remove `"kind": "memory"`                          |
| `~/.openclaw/openclaw.json`                   | Switch slot to `memory-lancedb`, keep both enabled |

---

## Notes

- `ContextEngine` (`kind: "context-engine"`) was considered but rejected — it requires
  implementing the full `assemble`/`compact`/`ingest` session context contract, which is
  heavier than needed. `memory-ooda` only needs hooks, not session context ownership.
- After this CR, `plugins.slots.memory = "memory-ooda"` config will still be accepted by
  the slot system (it's a valid plugin ID) but will have no effect since `memory-ooda` no
  longer declares a kind. The config should be cleaned up as part of C3.
- The `memory-lancedb` config warning (`plugin disabled (memory slot set to "memory-ooda")
but config is present`) will disappear after this fix.
