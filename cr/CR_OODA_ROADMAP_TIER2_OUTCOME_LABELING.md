# CR_OODA_ROADMAP_TIER2_OUTCOME_LABELING

**Priority:** P0  
**Date:** 2026-04-05  
**Status:** WRITTEN  
**Tier:** 2 — Make the Orient phase real  
**Goal:** Close the decision loop. When a decision plays out (fix works, run succeeds, parity improves), label the originating memory with the outcome. Without this, memory accumulates decisions but never learns from results.

---

## Problem

The Archivist captures decisions. The Strategy proposes actions. But nothing connects "we decided to do X" with "X worked / failed / had side effects." The memory stack has `actionId` on `MemoryEntry` (designed for this) but it's never populated. The valuation engine scores strategies but never updates weights based on observed outcomes. Pattern extraction only knows what happened — not whether it worked.

---

## Design

### O1 — Decision tagging at capture time

When the Archivist captures a decision-type memory, assign a stable `actionId` (UUID) and store it. This ID is the hook for later outcome labeling.

In `archivist.ts` `extractPatterns()`, for patterns of section `lessons_learned` or `domain_context` that describe a decision or action taken:

```typescript
const actionId = isDecision(pattern) ? crypto.randomUUID() : undefined;
await episodicBackend.store({
  text: pattern.value,
  importance: 0.75,
  category: "decision",
  actionId,
  // ...
});
```

`isDecision(pattern)` heuristic: pattern value contains "decided", "chose", "implemented", "fixed", "applied", "switched" — or `section === "lessons_learned"`.

### O2 — Outcome signal detection in `after_tool_call`

After certain tool calls, detect whether a prior decision succeeded or failed:

| Tool                                                        | Signal   | Outcome                      |
| ----------------------------------------------------------- | -------- | ---------------------------- |
| `exec` result containing "tests pass" / "BUILD SUCCESS"     | positive | prior fix decision succeeded |
| `exec` result containing "FAILED" / "error" / non-zero exit | negative | prior fix decision failed    |
| `gateway` restart completing without error                  | positive | config change successful     |
| `gateway` restart with error                                | negative | config change failed         |
| `cron` completion announced                                 | positive | scheduled task succeeded     |

When a positive/negative signal fires, find the most recent `actionId` memory in the episodic store (within the last N turns) and label it:

```typescript
await episodicBackend.labelOutcome(actionId, {
  outcome: "success" | "failure" | "partial",
  observedAt: Date.now(),
  signal: "build_passed" | "test_passed" | "runtime_error" | ...,
  detail: string, // first 200 chars of relevant output
});
```

### O3 — `labelOutcome` method on episodic backends

Add to both `SqliteVecMemoryDB` and `LanceMemoryDB`:

```typescript
async labelOutcome(actionId: string, label: {
  outcome: "success" | "failure" | "partial";
  observedAt: number;
  signal: string;
  detail?: string;
}): Promise<void>
```

Implementation: UPDATE the memory row to set `outcome`, `outcomeSIgnal`, `outcomeAt` fields. Requires schema migration (add 3 columns to `memories` table, nullable).

### O4 — Outcome-weighted retrieval in Orient phase

When `before_agent_start` does `autoRecall`, boost memories with `outcome = "success"` and suppress memories with `outcome = "failure"` in the re-ranking step:

```typescript
// In scoring retrieved memories:
if (memory.outcome === "success") score *= 1.3;
if (memory.outcome === "failure") score *= 0.6;
```

This makes successful patterns surface more prominently in context.

### O5 — Outcome stats in Archivist

When the Archivist runs its extraction pass, summarize outcome data into `KNOWLEDGE.json`:

```json
{
  "lessons_learned": {
    "fix_rate_module_discovery": "3/4 module discovery fixes succeeded on first attempt",
    "toml_pollution_pattern": "TOML catalog pollution recurred 3 times — root cause was multi-agent concurrent write"
  }
}
```

---

## Files to Change

| File                                  | Change                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------- |
| `extensions/memory-lancedb/index.ts`  | Add `labelOutcome()` to both backends + schema migration                   |
| `extensions/memory-ooda/archivist.ts` | Tag decision patterns with `actionId` at capture                           |
| `extensions/memory-ooda/index.ts`     | Outcome signal detection in `after_tool_call` handler; call `labelOutcome` |
| `extensions/memory-lancedb/index.ts`  | Outcome-weighted retrieval in `autoRecall`                                 |

---

## Tests Required

1. `labelOutcome` stores outcome fields on the correct memory
2. Decision pattern capture produces `actionId`
3. Outcome signal detection: exec with "tests pass" → positive label
4. Retrieval re-ranking: success-labeled memory scores higher than unlabeled
5. Archivist outcome summary written to KNOWLEDGE.json
