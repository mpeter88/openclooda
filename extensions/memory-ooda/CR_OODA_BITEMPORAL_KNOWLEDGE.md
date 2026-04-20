# CR: OODA Bitemporal Knowledge — Validity Windows and Supersession for KNOWLEDGE.json

**Date:** 2026-04-18
**Status:** WRITTEN
**Priority:** HIGH — preferences, people, and project state go stale silently today; no mechanism to deprecate a fact without destroying its history
**Source:** Zep: A Temporal Knowledge Graph Architecture for Agent Memory, Rasmussen et al. 2025 (arxiv 2501.13956). Bitemporal schema borrowed. Graphiti engine explicitly **not** adopted — we keep the flat JSON store.

---

## Current State

`KNOWLEDGE.json` (shape in `types.ts`, I/O in `semantic-memory.ts`) stores facts as flat `Record<string, unknown>`. A fact is either present or absent. There is no:

- Event time vs ingestion time separation — a fact that was true last month cannot be distinguished from a fact stated last week.
- Invalidation mechanism — when "Peter prefers async over sync" changes to "Peter prefers sync after standup," the new preference overwrites the old silently, destroying the audit trail.
- Successor link — when `projects.amf-platform.status` transitions `active → paused`, we lose the transition timestamp and cause.

The Archivist's existing dedup prompt mitigates this by telling the model to update rather than create near-duplicates, but the fix is behavioral, not structural. A correct bitemporal schema makes the update/supersede operation explicit and queryable.

---

## Design

### C1 — Temporal Envelope (new, additive schema)

Introduce a parallel `_temporal` map keyed by canonical `section.key` path. The live value in its native section is unchanged — bitemporal metadata lives alongside:

```typescript
// types.ts — additive
export interface TemporalEnvelope {
  /** When the fact became true in the user's world (best-known). */
  valid_from: string; // ISO
  /** When the fact stopped being true. null = still valid. */
  valid_to: string | null;
  /** When this envelope was recorded into KNOWLEDGE.json. */
  ingested_at: string; // ISO
  /** Source or agent that ingested. */
  ingested_by: "archivist" | "user" | "meta_reviewer" | string;
  /** Predecessor envelope this supersedes (same canonical key, earlier). */
  supersedes?: string; // ingested_at of prior envelope
  /** Why this envelope was superseded / invalidated (if valid_to != null). */
  invalidation_reason?: string;
  /** Confidence at ingestion time. */
  confidence: number; // [0, 1]
  /** Timestamps of identical-value re-writes. Populated only on the
   *  currently-valid envelope. See C2 reconfirmation rule. */
  reconfirmations?: string[];
}

export interface KnowledgeFile {
  // ... existing fields unchanged ...
  /**
   * Bitemporal metadata. Key = "<section>.<fact_key>".
   * Envelopes are append-only; superseded envelopes retained for audit.
   */
  _temporal?: Record<string, TemporalEnvelope[]>;
}
```

**Invariant:** at most one envelope per canonical key has `valid_to === null` (the currently-valid one). All others have `valid_to !== null`.

### C2 — `upsertFact` Becomes Temporal-Aware

`semantic-memory.ts` `upsertFact` grows a new overload:

```typescript
export interface UpsertOptions {
  /** When this fact became true. Default: now. */
  valid_from?: string;
  /** Confidence [0, 1]. Default: 0.9 (archivist) or 1.0 (user). */
  confidence?: number;
  /** Reason the previous envelope is being superseded (if any). */
  invalidation_reason?: string;
}

export function upsertFact(
  workspacePath: string,
  section: string,
  key: string,
  value: unknown,
  opts?: UpsertOptions,
): void;
```

Semantics on write:

1. Read current envelopes for `"<section>.<key>"`.
2. If a currently-valid envelope exists (`valid_to === null`):
   - If the new `value` is structurally equal to the current value, bump `confidence` and append `ingested_at` into a `reconfirmations: string[]` field on that envelope (new optional field). Do **not** write a new envelope.
   - Otherwise, set that envelope's `valid_to = now`, `invalidation_reason = opts.invalidation_reason ?? "superseded"`. Append a new envelope with `valid_from = opts.valid_from ?? now`, `supersedes = prior.ingested_at`.
3. Write the new `value` to the flat section (back-compat — readers that don't know about `_temporal` still work).

### C3 — Invalidation without Replacement

New API for explicit removal without a successor value:

```typescript
export function invalidateFact(
  workspacePath: string,
  section: string,
  key: string,
  reason: string,
): void;
```

Sets the currently-valid envelope's `valid_to = now`. Does **not** remove the value from the flat section — the value is preserved as historical, but a read through `getCurrentFacts()` (new helper, C5) filters it out.

### C4 — Schema Migration

`getFacts()` initializes `_temporal = {}` when absent. On first write after upgrade, `upsertFact` back-fills an envelope with `valid_from = _meta.updated_at` (best available proxy), `ingested_at = now`, `confidence = 0.7` (unknown origin), `ingested_by = "migration"`. Migration is lazy per-key — no big-bang rewrite.

### C5 — Readers

```typescript
/** Returns the flat KnowledgeFile filtered to currently-valid facts only. */
export function getCurrentFacts(workspacePath: string): KnowledgeFile;

/** Returns the full bitemporal history for a key. Oldest first. */
export function getFactHistory(
  workspacePath: string,
  section: string,
  key: string,
): TemporalEnvelope[];

/** Returns facts that were valid at a specific timestamp. */
export function getFactsAsOf(workspacePath: string, timestamp: string): KnowledgeFile;
```

`formatFactsForContext()` switches to `getCurrentFacts`. The injected system-prompt context stops showing invalidated facts without losing them from disk.

### C6 — CLI

- `openclaw workspace knowledge history <section>.<key>` — print the envelope timeline.
- `openclaw workspace knowledge invalidate <section>.<key> --reason "..."` — explicit invalidation.
- `openclaw workspace knowledge asof <ISO timestamp>` — dump the as-of snapshot.

### C7 — Archivist Integration

The Archivist already reuses existing keys to avoid near-duplicates. With C1–C5, the dedup/update decision becomes explicit: `invalidation_reason` is populated from the Archivist's `reason` field. This makes the next CR (`CR_OODA_ARCHIVIST_CRUD_CLASSIFIER`, Batch B2) fit cleanly — the CRUD classifier emits explicit ADD/UPDATE/DELETE/NOOP decisions that each map to one envelope operation.

### C8 — Snapshot Discipline

`upsertFact` already takes a pre-write snapshot. C1 doubles the blast radius of a botched write (value + \_temporal can go out of sync). Atomic rename of the tmp file protects against crash. Add a post-write invariant check: after rename, re-read and verify every `_temporal[key]` has at most one `valid_to === null`. If violated, restore snapshot and throw.

---

## Acceptance Criteria

- [ ] `TemporalEnvelope` and `_temporal` added to `KnowledgeFile`.
- [ ] `upsertFact` writes an envelope on every new or changed value; reconfirms (no new envelope) on identical re-write.
- [ ] `invalidateFact` sets `valid_to` without changing the flat value.
- [ ] `getCurrentFacts`, `getFactHistory`, `getFactsAsOf` unit-tested with a synthetic timeline.
- [ ] Migration lazy-back-fills envelopes with `ingested_by: "migration"` on first touch.
- [ ] Invariant check fails closed with snapshot restore on structural violations.
- [ ] `formatFactsForContext` excludes invalidated facts; existing injection tests pass.
- [ ] New CLI subcommands work end-to-end on a test workspace.

---

## Risk and Open Questions

1. **File bloat.** Each change adds an envelope; high-churn keys (e.g., project status flipping active/paused) accumulate. Mitigation: `prune_envelopes_older_than_days` threshold (default 365) that drops envelopes whose `valid_to + window < now`, preserving only the currently-valid one plus the most recent two predecessors. Pruning is separate from `valid_to` (invalidation is non-destructive; pruning is the destructive garbage-collection pass).
2. **Predecessors of structured values (projects, people).** When a project entry changes from `{status: "active", ...}` to `{status: "paused", ...}`, do we supersede at the whole-object level or at the `status` field? Decision: envelope tracks the whole section's entry (`projects.amf-platform`). Field-level supersession is out of scope for v1.
3. **Clock trust.** `valid_from` defaults to `Date.now()`. Archivist-inferred facts may have a true `valid_from` earlier than ingestion — we currently can't recover that. Leave as-is; `ingested_at` is always accurate, `valid_from` is best-effort.
4. **Concurrent writes.** Archivist runs async on `setImmediate`. If a user-initiated `invalidateFact` and an Archivist `upsertFact` collide, the atomic rename protects file integrity but the envelope sequence could interleave incorrectly. Mitigation: wrap the read-modify-write in a cooperative file lock (`~/.openclaw/workspace/.knowledge.lock`) — already a pattern the snapshot module uses.
5. **Arxiv ID verified.** 2501.13956 confirmed — Rasmussen, Paliychuk, Beauvais, Ryan, Chalef 2025. Schema details are paraphrased from the Zep paper's description of Graphiti; do not claim identical field names without reading the paper's appendix before merge.
