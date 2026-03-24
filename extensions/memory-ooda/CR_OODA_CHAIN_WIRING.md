# CR: OODA Chain Wiring — Archivist + Turn Counter

**Date:** 2026-03-18  
**Status:** IMPLEMENTED  
**Priority:** P0 — Plugin is loaded but OODA chain is not running  
**Author:** Diagnostic session with michaelpeter

---

## Problem

The `memory-ooda` plugin registers successfully and injects `KNOWLEDGE.json` context into
every agent turn via `before_agent_start`. However, the full OODA chain — Archivist,
Meta-Reviewer, triage, strategy — is **never invoked**. The plugin is a context injector
only; it has no `agent_end` hook and no turn counter.

Confirmed by inspection of `~/.openclaw/workspace/KNOWLEDGE.json`:

- `turn_count_at_last_update: 0`
- `_archivist_log: []`
- `updated_by: "user"` (never written by Archivist)

The Archivist function (`runArchivist()` in `archivist.ts`) is fully built and tested.
The `memory-lancedb` plugin already captures episodic events on `agent_end` with
`autoCapture: true` and exposes `retrieveSince()` / `markProcessed()` / `prune()` as
OODA methods on its store. The wiring between the two plugins is simply missing.

---

## What Exists (No Changes Needed)

- `archivist.ts` — fully implemented, tested, `runArchivist()` ready to call
- `shouldRunArchivist(currentTurn, state, turnInterval)` — correct trigger logic
- `memory-lancedb` — `retrieveSince()`, `markProcessed()`, `prune()` already on store
- `PRIORITIES.json` — `archivist_turn_interval: 10` configured
- `KNOWLEDGE.json` — schema correct, ready for Archivist writes
- `agent_end` hook — available in `PluginHookName`, `memory-lancedb` already uses it

---

## Changes Required

### W1 — Add `agent_end` hook to `index.ts` (CRITICAL)

Register an `agent_end` hook that:

1. Increments a persistent turn counter
2. Checks `shouldRunArchivist()` against configured `archivist_turn_interval`
3. If due: calls `runArchivist()` async (non-blocking, does not delay reply)

The turn counter must be persisted to `.archivist-state.json` (already managed by
`readState()` / `writeState()` in `archivist.ts`).

**File:** `extensions/memory-ooda/index.ts`

```typescript
import { runArchivist, shouldRunArchivist, readState, writeState } from "./archivist.js";

// Inside register():
let turnCount = readState(workspacePath).last_run_turn;

api.on("agent_end", async (event) => {
  if (!event.success) return;

  turnCount++;

  // Persist incremented turn count immediately (before archivist check)
  const state = readState(workspacePath);
  const updatedState = { ...state, last_run_turn: turnCount };
  writeState(workspacePath, updatedState);

  // Check if Archivist should run
  const priorities = getPriorities(workspacePath);
  const interval = priorities.thresholds.archivist_turn_interval ?? 10;

  if (!shouldRunArchivist(turnCount, state, interval)) return;

  // Fire async — do not await, must not block agent reply
  setImmediate(async () => {
    try {
      const episodicStore = api.memory?.getEpisodicStore?.();
      if (!episodicStore) {
        api.logger.warn("memory-ooda: no episodic store available — skipping Archivist");
        return;
      }

      const semanticStore = {
        upsertFact: (section: string, key: string, value: unknown) =>
          upsertFact(workspacePath, section, key, value),
        appendArchivistLog: (action: string, reason: string) =>
          appendArchivistLog(workspacePath, action, reason),
      };

      const result = await runArchivist(
        workspacePath,
        turnCount,
        episodicStore,
        semanticStore,
        (prompt) => api.callModel(prompt),
        { turnInterval: interval },
      );

      api.logger.info(
        `memory-ooda: Archivist ran — ${result.patternsExtracted.length} patterns, ` +
          `${result.eventsProcessed} events, ${result.eventsPruned} pruned`,
      );
    } catch (err) {
      api.logger.warn(`memory-ooda: Archivist failed: ${String(err)}`);
    }
  });
});
```

---

### W2 — Expose `getEpisodicStore()` on `OpenClawPluginApi.memory` (DEPENDENCY)

The Archivist needs access to the `memory-lancedb` store's OODA methods. The plugin API
needs a way to access the active memory slot's episodic store.

Check if `api.memory` already exposes this surface. If not, one of:

**Option A** — `api.memory.getEpisodicStore()` returns the active memory plugin's store
(preferred — clean abstraction)

**Option B** — Pass the LanceDB store reference directly via plugin config
(pragmatic fallback if API surface doesn't exist yet)

**Option C** — `memory-ooda` reads LanceDB directly via its own db handle, bypassing
the plugin API (last resort — tight coupling)

Investigate `src/plugins/types.ts` `OpenClawPluginApi.memory` shape before implementing.

---

### W3 — Expose `callModel()` on `OpenClawPluginApi` (DEPENDENCY)

The Archivist calls an LLM for pattern extraction. The plugin API needs a way to make
a model call without spawning a full agent turn.

Check if `api.callModel` or equivalent exists. If not:

- Add `callModel(prompt: string, options?: { model?: string }): Promise<string>` to
  `OpenClawPluginApi`
- Should use the agent's configured model, default tier (not thinking)
- Must not count as a user-visible turn (no session history entry)

---

### W4 — Meta-Reviewer weekly trigger (LOWER PRIORITY)

`meta-reviewer.ts` is also fully built but not wired. Once W1-W3 are done, the
Meta-Reviewer can be triggered from the same `agent_end` hook on a time-based check
(weekly, per `meta_reviewer_weekly_enabled` in `PRIORITIES.json`).

Leave for follow-on once Archivist is confirmed working.

---

## Acceptance Criteria

- [ ] After 10 agent turns, `KNOWLEDGE.json` `_archivist_log` has at least one entry
- [ ] `KNOWLEDGE.json` `turn_count_at_last_update` increments past 0
- [ ] `KNOWLEDGE.json` `updated_by` shows `"archivist"` on first Archivist write
- [ ] Archivist run does not add measurable latency to agent replies (fires via `setImmediate`)
- [ ] If episodic store is unavailable, plugin degrades gracefully (logs warn, no crash)
- [ ] Existing `before_agent_start` context injection continues to work unchanged

---

## Open Questions

1. Does `OpenClawPluginApi.memory` already expose an episodic store interface, or does
   W2 require a new API surface? Check `src/plugins/types.ts` lines 1228+.
2. Does `api.callModel()` exist? If not, W3 is a core change required before this CR
   can be fully implemented.
3. Should the turn counter reset on `/new` / `/reset`? The `before_reset` hook exists
   and could clear the in-memory `turnCount` — but `.archivist-state.json` should
   persist across resets (the Archivist cares about wall-clock turns, not per-session).

---

## Files Changed

| File                                  | Change                                             |
| ------------------------------------- | -------------------------------------------------- |
| `extensions/memory-ooda/index.ts`     | Add `agent_end` hook (W1)                          |
| `extensions/memory-ooda/archivist.ts` | No changes — already correct                       |
| `src/plugins/types.ts`                | Add `api.memory.getEpisodicStore()` if needed (W2) |
| `src/plugins/types.ts`                | Add `api.callModel()` if needed (W3)               |

---

## Notes

- `memory-lancedb` `autoCapture` is already enabled — Tier 2 events ARE being written.
  The Archivist has data to work with as soon as W1-W3 are wired.
- `PRIORITIES.json` `archivist_turn_interval` is set to 10 (changed from default 100
  during this session). This is correct for development/testing.
- `meta_reviewer_weekly_enabled: true` — Meta-Reviewer is configured but W4 depends
  on W1-W3 first.
