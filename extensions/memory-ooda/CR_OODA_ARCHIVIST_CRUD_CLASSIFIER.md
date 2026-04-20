# CR: OODA Archivist CRUD Classifier — Explicit ADD / UPDATE / DELETE / NOOP

**Date:** 2026-04-18
**Status:** WRITTEN
**Priority:** HIGH — Archivist currently upserts implicitly; no way to record "this old fact is now wrong" or "nothing new worth storing" as first-class decisions
**Source:** Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory, Chhikara et al. 2025 (arxiv 2504.19413). Four-action classifier semantics borrowed.
**Companion:** `CR_OODA_BITEMPORAL_KNOWLEDGE.md` (Batch B1) — CRUD classifier actions map directly onto the bitemporal envelope operations.

---

## Current State

`archivist.ts` extracts `PatternExtraction[]` from recent events, then:

```typescript
for (const pattern of patterns) {
  semanticStore.upsertFact(pattern.section, pattern.key, pattern.value);
}
```

Every pattern becomes an upsert. There is no explicit decision to:

- **Add** a genuinely new fact.
- **Update** an existing fact because it changed.
- **Delete** a fact that is no longer true.
- **Noop** — acknowledge the events were observed but nothing changed in durable knowledge.

The prompt's "REUSE existing keys" rule conflates add and update into one write. There is no way for the Archivist to say "this fact used to be true, it's now false." And there is no telemetry separating turns that generated noise from turns that genuinely surfaced new knowledge.

---

## Design

### C1 — PatternExtraction Gets an Action

Extend the existing type in `archivist.ts`:

```typescript
export type PatternAction = "ADD" | "UPDATE" | "DELETE" | "NOOP";

export interface PatternExtraction {
  /** Optional for backward-compat with pre-CR model outputs.
   *  `undefined` defaults to "ADD" in applyPatternAction. */
  action?: PatternAction;
  section:
    | "stack"
    | "projects"
    | "people"
    | "domain_context"
    | "lessons_learned"
    | "preferences_notes";
  key: string;
  /** Present for ADD and UPDATE. Null for DELETE. Null for NOOP (no change). */
  value: unknown | null;
  /** For UPDATE: the prior value the model believes is being replaced.
   *  Used by the classifier's own sanity check — rejected if it doesn't match current store. */
  previousValue?: unknown;
  /** For DELETE: why this fact is no longer true. Required. */
  invalidation_reason?: string;
  /** Always required — brief audit trail. */
  reason: string;
}
```

### C2 — Prompt Rewrite

Replace the existing target-sections prompt in `buildArchivistPrompt` with explicit classifier instructions:

```
For each stable pattern in the events, choose ONE action:

ADD  — A new fact not currently stored.
UPDATE — A fact whose current stored value is now wrong; provide previousValue.
DELETE — A fact that is no longer true; provide invalidation_reason.
NOOP — Events were noted but no durable change (explain why in reason).

Rules:
- UPDATE requires previousValue to match what's in the knowledge store.
- DELETE requires invalidation_reason ("user said X is no longer true" / "superseded by Y" / "project archived").
- NOOP is preferred over forcing a change when the events are noise.
- At most 15 actions per batch. NOOP entries don't count against the limit — they're diagnostic.
```

The prompt is fed the current value for each existing key (from `existingKeys` — now extended to include current values, not just keys).

### C3 — Apply Actions

New function in `archivist.ts`:

```typescript
export async function applyPatternAction(
  pattern: PatternExtraction,
  workspacePath: string,
  semanticStore: SemanticStore,
): Promise<ApplyActionResult>;

export interface ApplyActionResult {
  action: PatternAction;
  applied: boolean;
  rejectedReason?: string;
}
```

Per-action semantics (leveraging bitemporal envelope API from Batch B1):

- **ADD:** If a currently-valid envelope exists, reject with `already_exists` — force model to re-classify as UPDATE.
- **UPDATE:** If `previousValue` does not deep-equal the current stored value, reject with `stale_previous_value`. Otherwise, call `upsertFact(...)` which creates a successor envelope and writes the new value.
- **DELETE:** Call `invalidateFact(section, key, invalidation_reason)`.
- **NOOP:** Append a structured `_archivist_log` entry `{ action: "noop", reason }`. No write to facts.

Rejected actions are retained in the result for logging but do not propagate further. The archivist retries a rejected UPDATE once as a fresh classification call with the rejection reason as extra context.

### C4 — Outcome Labeling

Attach the action decision to episodic events' telemetry:

```typescript
// After applyPatternAction returns:
await episodicStore.labelOutcome?.(pattern_sourced_event.actionId, {
  outcome: result.applied ? "success" : "partial",
  observedAt: Date.now(),
  signal: `archivist_${result.action.toLowerCase()}${result.rejectedReason ? "_rejected" : ""}`,
});
```

This feeds the existing `aggregateDomainOutcomes` pipeline with real classifier decisions instead of pretending every archivist write was a "success."

### C5 — Archivist Log Shape

Current `_archivist_log` entries:

```json
{ "timestamp": "...", "action": "distill", "reason": "Extracted 5 patterns..." }
```

New per-action entries (in addition to batch-level distill entry):

```json
{
  "timestamp": "...",
  "action": "pattern_add" | "pattern_update" | "pattern_delete" | "pattern_noop" | "pattern_rejected",
  "section": "lessons_learned",
  "key": "package_detection_first_match",
  "reason": "event 3 described the recent KDMS mis-placement bug",
  "rejectedReason": "stale_previous_value" // only on rejected
}
```

### C6 — Metrics

Each archivist run produces a summary added to `ArchivistResult`:

```typescript
export interface ArchivistResult {
  // ... existing ...
  actionCounts: {
    add: number;
    update: number;
    delete: number;
    noop: number;
    rejected: number;
  };
}
```

Health telemetry (`pingHealth`) reports these counts so the grounded eval harness can see whether the archivist is adding signal or churning.

### C7 — Interaction with B1 Bitemporal

This CR depends on B1's bitemporal envelope API:

- `UPDATE` requires the supersession envelope operation.
- `DELETE` requires `invalidateFact`.
- `reconfirmations` (B1's re-write-of-same-value behavior) surfaces naturally as the ADD-but-identical no-op path: same value → reconfirmation, distinct from NOOP which means "no fact to store at all."

If B1 ships first, B2 is straightforward. If B2 ships first, fall back requires **extending `SemanticStore`** (`archivist.ts:62`) with a `deleteFact(section, key)` method — the current interface has only `upsertFact` and `appendArchivistLog`. Fallback behavior: `UPDATE` overwrites without history via existing `upsertFact`; `DELETE` calls the new `deleteFact` which removes the key from the flat section and appends an `_archivist_log` entry. The classifier prompt and action enum still ship. Bitemporal can be added later without re-prompting.

**Reconfirmation terminology:** when B1 ships, an ADD against an existing identical value flows through B1's reconfirmation branch (append to `reconfirmations[]` on the existing envelope), not B2's classifier. The classifier's ADD-identical path collapses into UPSERT-reconfirm at the storage layer. Document this in both CRs' prose to avoid drift.

---

## Acceptance Criteria

- [ ] `PatternExtraction.action` with four-value enum; validation rejects any other string.
- [ ] Prompt includes current value per existing key so the model can choose UPDATE vs ADD correctly.
- [ ] `applyPatternAction` unit-tested for each action and for each rejection case.
- [ ] Rejected-UPDATE retry path tested.
- [ ] `ArchivistResult.actionCounts` reflected in `runArchivist` return value and in health ping.
- [ ] No regression in existing archivist integration tests — action defaults to `ADD` for first encounter, which matches prior behavior.
- [ ] Per-action `_archivist_log` rows appear in a test workspace after a distill run.

---

## Risk and Open Questions

1. **Model compliance with the four-action format.** The JSON schema extension is simple but models sometimes emit free-form `action` strings. Retry once on parse failure (matching existing retry pattern); on second failure, skip the pattern with a `_archivist_log` `pattern_parse_failed` entry.
2. **Interaction with dedup prompt.** The existing "REUSE existing keys" instruction overlaps with UPDATE semantics. Rewrite the prompt so the classifier's action is the sole decision surface — remove the implicit "reuse" framing.
3. **NOOP ratio as a health metric.** If the archivist is emitting 80% NOOP, either the trigger cadence is too aggressive or the episodic capture is too noisy. Track noopRatio over time; if > 0.7 for 3 consecutive runs, emit a `criticalFailure` event of severity `warning`.
4. **Arxiv ID verified.** 2504.19413 confirmed (Chhikara, Khant, Aryan, Singh, Yadav 2025). Mem0's classifier is for free-text memory; our adaptation uses structured sections — cite the paper for the ADD/UPDATE/DELETE/NOOP idea, not as a drop-in implementation.
