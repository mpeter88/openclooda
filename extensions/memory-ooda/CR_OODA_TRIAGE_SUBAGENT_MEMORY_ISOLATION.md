# CR: OODA Triage Subagent Memory Isolation

**Date:** 2026-03-18  
**Status:** IMPLEMENTED  
**Priority:** HIGH — Ollama GIN logs leaking into chat on every turn; UX regression  
**Discovered:** Ollama HTTP server access logs appearing in TUI chat window during normal conversation

---

## Problem

The triage `callModel` in `extensions/memory-ooda/index.ts` spawns a subagent via
`api.runtime.subagent.run()` on **every** `before_agent_start` event. This subagent
is a full agent session — it triggers all registered plugin hooks including
`memory-lancedb`'s `autoRecall` (`before_agent_start` hook).

`autoRecall` calls the Ollama embedding API to embed the triage prompt for memory
search. Ollama's HTTP server logs (`[GIN] 2026/03/18 - ... POST "/v1/embeddings"`)
and runner startup logs appear in stdout and are captured in the subagent output
stream, which leaks into the parent session's TUI chat display.

**Trigger chain:**

```
User message
  → before_agent_start (memory-ooda triage)
    → api.runtime.subagent.run() [triage subagent]
      → before_agent_start (memory-lancedb autoRecall on subagent)
        → embeddings.embed(prompt)  [Ollama HTTP call]
          → Ollama GIN logs → stdout → TUI chat leak
```

This happens on every single turn, causing Ollama startup/GIN logs to pollute the
chat interface.

---

## Root Cause

`autoRecall` and `autoCapture` hooks in `memory-lancedb` fire on all agent sessions
including subagents spawned by OODA triage. There is no mechanism to mark a subagent
as "internal/ephemeral" and skip memory hooks.

The triage subagent does not benefit from memory recall (it only needs to produce a
SITREP JSON blob) and should not trigger any memory side effects.

---

## Fix

### F1 — Add `lane` support to skip memory hooks (PREFERRED)

`SubagentRunParams` already has an optional `lane?: string` field. Memory plugins
should skip hooks when the session lane is a known internal lane.

**In `extensions/memory-lancedb/index.ts`** — add lane check to both hooks:

```typescript
// before_agent_start (autoRecall)
api.on("before_agent_start", async (event) => {
  // Skip for internal OODA subagent sessions
  if ((event as Record<string, unknown>).lane === "ooda-internal") return;
  // ... existing recall logic
});

// agent_end (autoCapture)
api.on("agent_end", async (event) => {
  // Same check — no point capturing OODA internal turns
  if ((event as Record<string, unknown>).lane === "ooda-internal") return;
  // ... existing capture logic
});
```

**In `extensions/memory-ooda/index.ts`** — pass lane when spawning triage/strategy/archivist subagents:

```typescript
const { runId } = await api.runtime.subagent.run({
  sessionKey,
  message: prompt,
  lane: "ooda-internal", // ← add this
  extraSystemPrompt: "...",
  deliver: false,
});
```

### F2 — Check if lane is exposed in hook event (DEPENDENCY)

Verify `PluginHookBeforeAgentStartEvent` exposes the session lane. If not, check
`PluginHookAgentEndEvent`. If neither exposes lane, the lane must be made available
via the hook event type — add `lane?: string` to both event types in
`src/plugins/types.ts`.

### F3 — Fallback: skip hooks by session key prefix (SIMPLER)

If lane is not available in hook events, use session key prefix matching:

```typescript
api.on("before_agent_start", async (event) => {
  // OODA triage/strategy/archivist sessions use "ooda-" prefix
  const sessionId = (event as Record<string, unknown>).sessionId as string | undefined;
  if (sessionId?.startsWith("ooda-")) return;
  // ... existing recall logic
});
```

The session key `ooda-${Date.now()}` is already used in the callModel helper.

---

## Immediate Mitigation (while CR is not yet implemented)

Disable `autoRecall` in config to stop Ollama calls on every turn:

```json
"memory-lancedb": {
  "config": {
    "autoRecall": false,
    "autoCapture": true
  }
}
```

This stops the GIN log leak. Recall can be re-enabled after F1-F3 are implemented.

---

## Files Changed

| File                                 | Change                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------- |
| `extensions/memory-lancedb/index.ts` | F1 or F3: lane/sessionId check in before_agent_start + agent_end hooks |
| `extensions/memory-ooda/index.ts`    | F1: add `lane: "ooda-internal"` to all subagent.run() calls            |
| `src/plugins/types.ts`               | F2: add `lane?: string` to hook event types (if needed)                |

---

## Test Cases

1. Normal user turn → autoRecall fires, Ollama called, memories injected
2. OODA triage subagent turn → autoRecall skipped, no Ollama call, no GIN logs
3. OODA archivist subagent turn → autoCapture skipped, no self-poisoning
4. After fix, Ollama GIN logs no longer appear in TUI chat

---

## Notes

- F3 (session key prefix) is the quickest to implement — no core type changes needed
- F1 (lane) is architecturally cleaner and generalizes to other internal subagents
- The Archivist's callModel subagent has the same problem — it would also trigger  
  autoRecall/autoCapture if the Archivist ever runs (currently blocked by LanceDB issue)
- `deliver: false` on subagent.run() suppresses message delivery but does NOT suppress  
  plugin hook firing — hooks still run on the subagent session
