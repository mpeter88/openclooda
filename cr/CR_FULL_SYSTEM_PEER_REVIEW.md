# CR: Full System Peer Review — OODA Agent Implementation (PRs 1-7)

**Date:** 2026-03-16
**Author:** Architect (Claude)
**Branch:** `main`
**Priority:** HIGH
**Scope:** 12 source files across `extensions/memory-ooda/` and `src/agents/ooda/` — the complete OODA cognitive agent implementation
**Method:** 4-agent parallel peer review (Logic & Correctness, Data & Schema, Security & Reliability, Structure & Performance)
**Findings:** 24 confirmed (3 CRITICAL, 6 HIGH, 11 MEDIUM, 4 LOW)

---

## Executive Summary

The OODA agent implementation across PRs 1-7 is architecturally sound — clean DI interfaces, consistent fallback patterns, and good separation of concerns. The review surfaced three critical issues in the Archivist's failure handling (partial state on `markProcessed` failure, missing write safety in `appendArchivistLog`, and premature state advancement on empty retrieval), plus a cluster of validation gaps at model-output parse boundaries and duplicated utility code across 4 files.

No security vulnerabilities were found. The primary risk category is **silent data loss** under failure conditions that are unlikely but unrecoverable.

---

## Findings

### CRITICAL

**C1. Partial failure in `runArchivist()` leaves inconsistent state**

- **File(s):** `extensions/memory-ooda/archivist.ts:320-327`
- **Verified:** Yes — code reads sequentially: upsert patterns (320-322), then mark events (325-327), with no transaction boundary
- **Problem:** If `markProcessed()` throws on event N, patterns referencing events N+ are already upserted to KNOWLEDGE.json, but those events remain unprocessed. Next run re-ingests them, creating duplicate facts. Conversely, if `upsertFact()` throws on pattern M, events 1 through N-1 may already be marked processed — losing those observations without extracting their patterns.
- **Fix:** Restructure to two-phase commit:
  ```typescript
  // Phase 1: upsert all patterns (rollback-safe via snapshot)
  for (const pattern of patterns) {
    semanticStore.upsertFact(pattern.section, pattern.key, pattern.value);
  }
  // Phase 2: batch-mark all events only after upserts succeed
  const markErrors: string[] = [];
  for (const event of events) {
    try {
      await episodicStore.markProcessed(event.id);
    } catch {
      markErrors.push(event.id);
    }
  }
  // Log partial marking failures but don't fail the run
  ```

**C2. `appendArchivistLog()` writes KNOWLEDGE.json without snapshot or validation**

- **File(s):** `extensions/memory-ooda/semantic-memory.ts:143-156`
- **Verified:** Yes — compare with `upsertFact()` (lines 113-137) which has snapshot + JSON.parse validation + restore-on-failure; `appendArchivistLog()` has none of these
- **Problem:** If `fs.writeFileSync()` fails mid-write (disk full, permission error, process killed), KNOWLEDGE.json is corrupted with no recovery path. This destroys all Tier 3 semantic memory.
- **Fix:** Apply the same safety pattern used in `upsertFact()`:

  ```typescript
  export function appendArchivistLog(workspacePath: string, action: string, reason: string): void {
    const knowledge = getFacts(workspacePath);
    const filePath = knowledgePath(workspacePath);

    createSnapshot(workspacePath, KNOWLEDGE_FILENAME); // ADD

    knowledge._archivist_log.push({
      timestamp: new Date().toISOString(),
      action,
      reason,
    });
    knowledge._meta.updated_at = new Date().toISOString();

    const json = JSON.stringify(knowledge, null, 2) + "\n";
    try {
      // ADD
      JSON.parse(json); // ADD
    } catch {
      // ADD
      restoreLatestSnapshot(workspacePath, KNOWLEDGE_FILENAME); // ADD
      throw new Error("appendArchivistLog produced invalid JSON; snapshot restored");
    } // ADD

    fs.writeFileSync(filePath, json, "utf-8");
  }
  ```

**C3. Archivist advances state on empty retrieval — permanently skips events**

- **File(s):** `extensions/memory-ooda/archivist.ts:290-296`
- **Verified:** Yes — lines 292-295 call `writeState()` with current turn/time when `events.length === 0`
- **Problem:** If `retrieveSince()` returns zero events due to a transient store failure (connection timeout, corrupted index), the archivist advances `last_run_at` to now. Future runs query from the new timestamp and permanently skip the missed window. Those events are never processed.
- **Fix:** Only advance state after successful processing:
  ```typescript
  if (events.length === 0) {
    // Do NOT advance state — retrieval may have failed silently
    return { patternsExtracted: [], eventsProcessed: 0, eventsPruned: 0, fromFallback: false };
  }
  ```

### HIGH

**H1. Bare `catch {}` blocks across all retry loops — no error visibility**

- **File(s):**
  - `extensions/memory-ooda/archivist.ts:310`
  - `src/agents/ooda/strategy.ts:250`
  - `src/agents/ooda/triage.ts:245`
  - `src/agents/ooda/meta-reviewer.ts:338`
- **Verified:** Yes — all four files have identical `catch { // Retry on next iteration or fall through to fallback }` patterns
- **Problem:** When model calls fail or return unparseable JSON, the error is silently discarded. In production, operators have zero visibility into why the OODA chain is falling back. This makes debugging model integration issues nearly impossible.
- **Fix:** Capture and surface the error:
  ```typescript
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // ... model call + parse ...
    } catch (err) {
      lastError = err;
    }
  }
  // Include lastError in result or log it
  ```
  Consider adding `lastError?: string` to `ArchivistResult`, `StrategyResult`, `MetaReviewerResult`, and the triage result type.

**H2. `shouldTriggerPolicyReview()` passes empty `implicated_rule` strings**

- **File(s):** `src/agents/ooda/meta-reviewer.ts:150-152`
- **Verified:** Yes — condition is `event.implicated_rule !== undefined`, which passes for `""`
- **Problem:** An empty string `""` passes the gate and sends a prompt with no rule context, wasting a model call and potentially generating nonsensical proposals.
- **Fix:**
  ```typescript
  export function shouldTriggerPolicyReview(event: CriticalFailureEvent): boolean {
    return (
      event.severity === "critical" &&
      typeof event.implicated_rule === "string" &&
      event.implicated_rule.length > 0
    );
  }
  ```

**H3. NaN propagation in `calculateWeightAdjustment()`**

- **File(s):** `src/agents/ooda/meta-reviewer.ts:73-97`
- **Verified:** Yes — no validation on `domain.approval_count` or `domain.override_count` before arithmetic at line 83
- **Problem:** If PRIORITIES.json is manually edited with non-numeric or negative counts, the calculation produces `NaN` weights. `Math.max(NaN, 0.1)` returns `NaN`, which propagates to `writePriorities()` and corrupts the file.
- **Fix:** Add guard at function entry:
  ```typescript
  if (
    !Number.isFinite(domain.approval_count) ||
    domain.approval_count < 0 ||
    !Number.isFinite(domain.override_count) ||
    domain.override_count < 0
  ) {
    return { newWeight: domain.weight, shouldAdjust: false };
  }
  ```

**H4. No prompt size limit in `buildArchivistPrompt()`**

- **File(s):** `extensions/memory-ooda/archivist.ts:132-189`
- **Verified:** Yes — `formatEventsBlock()` includes full `e.text` with no truncation; `maxEventsPerRun` caps count but not text size
- **Problem:** 500 events with large text fields (e.g., pasted documents captured by auto-capture) can produce a multi-megabyte prompt, causing OOM or model token limit errors.
- **Fix:** Truncate per-event text and cap total block size:
  ```typescript
  function formatEventsBlock(events: EpisodicEvent[]): string {
    return events
      .map((e, i) => {
        const date = new Date(e.createdAt).toISOString().slice(0, 16);
        const source = e.source ? ` [${e.source}]` : "";
        const text = e.text.length > 200 ? e.text.slice(0, 200) + "..." : e.text;
        return `${i + 1}. (${date}${source}, importance=${e.importance}) ${text}`;
      })
      .join("\n");
  }
  ```

**H5. `stripCodeFences()` duplicated in 4 files**

- **File(s):**
  - `extensions/memory-ooda/archivist.ts:195-202`
  - `src/agents/ooda/meta-reviewer.ts:230-237`
  - `src/agents/ooda/strategy.ts:139-146`
  - `src/agents/ooda/triage.ts:177-184`
- **Verified:** Yes — identical 7-line function in all four files
- **Problem:** Maintenance hazard. A fix in one copy won't propagate to the others.
- **Fix:** Extract to `src/agents/ooda/parse-utils.ts`:
  ````typescript
  export function stripCodeFences(text: string): string {
    const trimmed = text.trim();
    const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (match) return (match[1] ?? "").trim();
    return trimmed;
  }
  ````
  Import from the shared module in all four files.

**H6. `restoreLatestSnapshot()` has TOCTOU between list and copy**

- **File(s):** `extensions/memory-ooda/snapshot.ts:91-97`
- **Verified:** Yes — `listSnapshots()` at line 92, then `copyFileSync()` at line 96 with no existence check
- **Problem:** If another process or cleanup deletes the snapshot between the list and copy calls, `copyFileSync()` throws an unhandled error during a critical recovery path.
- **Fix:** Wrap in try-catch with fallback to next snapshot:
  ```typescript
  export function restoreLatestSnapshot(workspacePath: string, filename: string): boolean {
    const snapshots = listSnapshots(workspacePath, filename);
    for (const snapshot of snapshots) {
      try {
        fs.copyFileSync(snapshot.path, path.join(workspacePath, filename));
        return true;
      } catch {
        continue; // Try next oldest snapshot
      }
    }
    return false;
  }
  ```

### MEDIUM

**M1. Strategy parser bounds don't match prompt or error message**

- **File(s):** `src/agents/ooda/strategy.ts:156-157`
- **Verified:** Yes — prompt says "2-4" (line 81), parser accepts 1-6, error says "Expected 2-4"
- **Problem:** Inconsistency between prompt instruction, validation bounds, and error message.
- **Fix:** Align all three: `if (parsed.length < 2 || parsed.length > 4)` with error message `Expected 2-4 strategies, got ${parsed.length}`.

**M2. Strategy scores not bounded to [0, 1] in parser**

- **File(s):** `src/agents/ooda/strategy.ts:173-181`
- **Verified:** Yes — only `typeof === "number"` checked; valuation engine clamps later
- **Problem:** Out-of-range scores (1.5, -0.3) silently pass the parser and are only corrected downstream. Malformed model output should be rejected at the parse boundary.
- **Fix:** Add range validation after type check:
  ```typescript
  if (obj.alignmentScore < 0 || obj.alignmentScore > 1) {
    throw new Error(`Strategy[${idx}].alignmentScore must be in [0, 1], got ${obj.alignmentScore}`);
  }
  ```

**M3. Priority allows non-integer values**

- **File(s):** `src/agents/ooda/triage.ts:196-198`
- **Verified:** Yes — `5.5` passes `typeof === "number"` before failing `VALID_PRIORITIES.has()`
- **Problem:** The error message is generic ("Must be 1-10") when the real issue is non-integer input. Clearer rejection improves debuggability.
- **Fix:** Add explicit integer check:
  ```typescript
  if (
    typeof priority !== "number" ||
    !Number.isInteger(priority) ||
    !VALID_PRIORITIES.has(priority)
  ) {
    throw new Error(`Invalid priority: ${String(priority)}. Must be an integer 1-10.`);
  }
  ```

**M4. Floating-point weight rounding inconsistency**

- **File(s):** `extensions/memory-ooda/priorities.ts:177-183` vs `src/agents/ooda/meta-reviewer.ts:90`
- **Verified:** Yes — meta-reviewer rounds to 3 decimals at line 90; `updateDomainWeight()` stores raw float
- **Problem:** Repeated weight adjustments accumulate floating-point drift (e.g., `0.7999999999`), making logs and debugging confusing.
- **Fix:** Round in `updateDomainWeight()`:
  ```typescript
  const roundedWeight = Math.round(newWeight * 1000) / 1000;
  priorities.domains[domain].weight = roundedWeight;
  ```

**M5. `createSnapshot()` return value not checked before critical writes**

- **File(s):** `extensions/memory-ooda/priorities.ts:138`, `semantic-memory.ts:113`
- **Verified:** Yes — both call `createSnapshot()` and proceed regardless of return value
- **Problem:** If snapshot creation fails (disk full, permissions), the write proceeds with no backup for rollback. The subsequent restore-on-failure path has nothing to restore.
- **Fix:** Check return value:
  ```typescript
  const snapshotPath = createSnapshot(workspacePath, FILENAME);
  if (!snapshotPath && fs.existsSync(filePath)) {
    throw new Error(`Failed to create snapshot of ${FILENAME} before write`);
  }
  ```

**M6. `upsertFact()` never updates `turn_count_at_last_update`**

- **File(s):** `extensions/memory-ooda/semantic-memory.ts:122-123`
- **Verified:** Yes — `_meta.updated_at` is updated but `turn_count_at_last_update` is not
- **Problem:** The field exists in the type (types.ts:16) and is initialized to 0, but never updated. This means the OODA chain cannot determine how stale facts are relative to the current turn.
- **Fix:** Add `currentTurn` parameter to `upsertFact()` signature and update the field.

**M7. `readState()` accepts invalid ISO timestamps**

- **File(s):** `extensions/memory-ooda/archivist.ts:98-100`
- **Verified:** Yes — validates `typeof === "string"` but not format; `new Date("garbage").getTime()` returns `NaN`
- **Problem:** Corrupted state file with invalid timestamp causes `NaN` in `retrieveSince()`, silently returning wrong results.
- **Fix:** Validate after parsing:
  ```typescript
  if (isNaN(new Date(parsed.last_run_at).getTime())) {
    throw new Error("Invalid .archivist-state.json: last_run_at is not a valid timestamp");
  }
  ```

**M8. `TriageOptions.timeoutMs` defined but never used**

- **File(s):** `src/agents/ooda/triage.ts:41-42`, and all `callModel()` sites
- **Verified:** Yes — `timeoutMs` exists in the interface but `runTriage()` never references it
- **Problem:** Model calls can hang indefinitely with no timeout. The option exists to suggest timeout support was intended but not implemented.
- **Fix:** Implement timeout wrapper or remove the unused option to avoid confusion. If implementing:
  ```typescript
  const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
    Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Model call timed out")), ms),
      ),
    ]);
  ```

**M9. `parsePatterns()` doesn't validate value types per section**

- **File(s):** `extensions/memory-ooda/archivist.ts:223-248`
- **Verified:** Yes — `value` only checked for null/undefined, not type per section
- **Problem:** A model returning `{ "section": "stack", "value": {"nested": true} }` is accepted, but `stack` expects string values. This causes type mismatches when consumed.
- **Fix:** Add per-section type validation:
  ```typescript
  if (
    (obj.section === "stack" || obj.section === "domain_context") &&
    typeof obj.value !== "string"
  ) {
    throw new Error(`Pattern[${idx}].value must be a string for section "${obj.section}"`);
  }
  if (
    (obj.section === "projects" || obj.section === "people") &&
    (typeof obj.value !== "object" || obj.value === null)
  ) {
    throw new Error(`Pattern[${idx}].value must be an object for section "${obj.section}"`);
  }
  ```

**M10. `adjustWeights()` loop terminates on first `updateDomainWeight()` failure**

- **File(s):** `src/agents/ooda/meta-reviewer.ts:109-120`
- **Verified:** Yes — no try-catch inside the loop; exception in one domain skips all subsequent
- **Problem:** If domain "operations" fails to update, "core_project" and "communication" are never adjusted, leaving weights inconsistent.
- **Fix:** Wrap the store call:
  ```typescript
  for (const [name, entry] of Object.entries(priorities.domains)) {
    const { newWeight, shouldAdjust } = calculateWeightAdjustment(entry);
    if (shouldAdjust) {
      try {
        store.updateDomainWeight(name, newWeight, `Meta-reviewer auto-adjustment...`);
        adjustments.push({ domain: name, oldWeight: entry.weight, newWeight });
      } catch {
        // Log and continue — don't let one domain block others
      }
    }
  }
  ```

**M11. No observability at key decision points**

- **File(s):** All `run*()` functions across `triage.ts`, `strategy.ts`, `archivist.ts`, `meta-reviewer.ts`
- **Verified:** Yes — none of the OODA modules accept or use a logger
- **Problem:** In production, no visibility into: which model was called, how many retries occurred, why fallback was used, what weights were adjusted, how many patterns extracted.
- **Fix:** Define a shared logger interface and inject it into each module:
  ```typescript
  export interface OodaLogger {
    info(msg: string): void;
    warn(msg: string): void;
  }
  ```
  Log at: model call attempt, retry, fallback activation, pattern extraction count, weight adjustment, and proposal creation.

### LOW

**L1. Silent catch in snapshot pruning**

- **File(s):** `extensions/memory-ooda/snapshot.ts:77-81`
- **Verified:** Yes — bare `catch {}` with comment "best-effort cleanup"
- **Problem:** Pruning failures go unnoticed; snapshots accumulate over time.
- **Fix:** Log at warn level (requires logger injection or `console.warn` as fallback).

**L2. Timestamp naming inconsistency across JSON files**

- **File(s):** `types.ts` (`updated_at` snake_case) vs `archivist.ts` (`createdAt` camelCase)
- **Verified:** Yes — persisted JSON uses snake_case; in-memory interfaces use camelCase
- **Problem:** Confusing for developers navigating between layers.
- **Fix:** Standardize to snake_case for all JSON-persisted fields. Low priority — cosmetic only.

**L3. Snapshot timestamp collision at second resolution**

- **File(s):** `extensions/memory-ooda/snapshot.ts:69`
- **Verified:** Yes — `Math.floor(Date.now() / 1000)` means two snapshots in same second overwrite
- **Problem:** Unlikely in practice but possible under load or in tests.
- **Fix:** Use millisecond resolution: `Date.now()` instead of `Math.floor(Date.now() / 1000)`.

**L4. Default strategy `weightedTotal: 0.0` is misleading**

- **File(s):** `src/agents/ooda/strategy.ts:54`
- **Verified:** Yes — initialized to 0.0 with comment "will be scored", immediately overwritten by `scoreStrategies()`
- **Problem:** Suggests the strategy is pre-scored when it's not. Cosmetic confusion.
- **Fix:** Remove the comment or initialize to `-1` to signal "unscored".

---

## Test Gaps

The following test cases should be added based on findings:

| #   | Finding | Test Case                                                                                                                              |
| --- | ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | C1      | `markProcessed()` throws on event N — verify KNOWLEDGE.json contains only patterns from events 1..N-1; verify events N+ are not marked |
| 2   | C2      | Mock `writeFileSync` to throw in `appendArchivistLog()` — verify KNOWLEDGE.json is not corrupted                                       |
| 3   | C3      | `retrieveSince()` returns `[]` — verify `.archivist-state.json` is NOT updated                                                         |
| 4   | H2      | CriticalFailureEvent with `implicated_rule: ""` — verify `shouldTriggerPolicyReview()` returns false                                   |
| 5   | H3      | Domain with `approval_count: NaN` — verify `calculateWeightAdjustment()` returns `shouldAdjust: false`                                 |
| 6   | H4      | Event with 1MB text field — verify prompt is truncated                                                                                 |
| 7   | M2      | Model returns `alignmentScore: 1.5` — verify parser throws                                                                             |
| 8   | M3      | Model returns `priority: 5.5` — verify parser throws with "integer" message                                                            |
| 9   | M7      | State file with `last_run_at: "not-a-date"` — verify `readState()` throws                                                              |
| 10  | M9      | Pattern with `section: "stack", value: { nested: true }` — verify parser throws                                                        |
| 11  | M10     | `updateDomainWeight()` throws for first domain — verify second domain is still adjusted                                                |

---

## Files Changed

| File                                        | Change                                                                                                                                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extensions/memory-ooda/archivist.ts`       | C1: restructure upsert/mark to two-phase commit. C3: remove state update on empty retrieval. H4: truncate event text in prompt. M7: validate ISO timestamp in `readState()`. M9: per-section value type validation. |
| `extensions/memory-ooda/semantic-memory.ts` | C2: add snapshot + validation to `appendArchivistLog()`. M6: add `currentTurn` param to `upsertFact()`.                                                                                                             |
| `extensions/memory-ooda/snapshot.ts`        | H6: try-catch with fallback in `restoreLatestSnapshot()`. L1: log pruning failures. L3: use ms resolution.                                                                                                          |
| `extensions/memory-ooda/priorities.ts`      | M4: round weight to 3 decimals. M5: check `createSnapshot()` return.                                                                                                                                                |
| `src/agents/ooda/meta-reviewer.ts`          | H2: validate non-empty `implicated_rule`. H3: guard NaN counts. M10: try-catch in `adjustWeights()` loop.                                                                                                           |
| `src/agents/ooda/strategy.ts`               | M1: align parser bounds to 2-4. M2: validate score range [0,1]. L4: remove misleading comment.                                                                                                                      |
| `src/agents/ooda/triage.ts`                 | M3: add integer check for priority. M8: implement or remove `timeoutMs`.                                                                                                                                            |
| `src/agents/ooda/parse-utils.ts`            | H5: **NEW FILE** — shared `stripCodeFences()`.                                                                                                                                                                      |
| All `run*()` functions                      | H1: capture `lastError` in retry loops. M11: inject logger interface.                                                                                                                                               |

---

## What's Done Well

1. **Consistent DI pattern.** `ModelCallFn`, `EpisodicStore`, `SemanticStore`, `PrioritiesStore`, and `ProposalStore` are all injected interfaces — making every module independently testable without mocking external systems. This is excellent architecture for a multi-model reasoning chain.

2. **Graceful degradation via fallback defaults.** Every `run*()` function has a well-defined fallback path that returns a safe default rather than crashing. The OODA chain never blocks the agent loop.

3. **Snapshot-before-write safety net.** The snapshot system with timestamped backups and automatic pruning is solid. The `upsertFact()` write-validate-restore pattern is the right model — it just needs to be applied consistently to `appendArchivistLog()` and checked for return value.
