# CR_OODA_HYPOTHESIS_DISCIPLINE_HARDENING — Robustness fixes for the structured hypothesis pipeline

Status: implemented
Target batch: K
Estimated effort: ~1 day
Depends on: CR_OODA_HYPOTHESIS_DISCIPLINE (the substrate this hardens),
CR_OODA_RESEARCH_LOOP (state machine), CR_OODA_AGENT_ARCHIVE (lineage).

---

## Source

8-agent peer review of CR_OODA_HYPOTHESIS_DISCIPLINE on 2026-04-26 surfaced 23
findings across logic, data, security, structure, customer-intent, pattern-
symmetry, wiring, and regression dimensions. Two were CRITICAL — the rest are
HIGH (8), MEDIUM (10), LOW (3).

This CR addresses the CRITICAL + HIGH findings as a coherent hardening pass
plus structural cleanup of the MEDIUMs that fall out of those fixes naturally.
LOW findings are listed at the end for tracking; they don't block shipping.

The original CR shipped runnable code — 885/885 tests green, gateway running
clean. But peer review showed the pipeline has cracks the unit tests don't
exercise: a single `git apply` failure deadlocks the loop forever; a refined
diff can silently widen its own scope; the H-fixture pass-rate the verdict
depends on is computed from un-filtered fixtures. None of these will surface
on the happy path. All of them will surface on real LLM output running through
real worktrees.

## Motivation

CR*OODA_HYPOTHESIS_DISCIPLINE delivered the right \_shape* — falsifiable
hypothesis, value linkage, refine loop, conclusion close-out, roadmap gate.
What it did not deliver is the _robustness_ needed for the loop to run
unattended on a real LLM emitting imperfect JSON / diffs / fixtures.

Concretely, the DMN log for 2026-04-23 shows:

```
{"bucket":"dormant","kind":"research_tick","outcome":"error",
 "details":"research_tick failed: Error: git apply failed (exit=128):
            error: corrupt patch at line 155","durationMs":4350}
{"bucket":"dormant","kind":"research_tick","outcome":"error",
 "details":"... corrupt patch at line 155 ...","durationMs":6380}
```

— the same record, hour after hour, never advancing. That is finding #1
playing out live. Until the loop can recover from a malformed LLM diff, it is
not a research loop; it is a research stutter.

The peer review also surfaced a class of subtler defects: the verdict logic
is double-gated, the H-fixture filter is convention-only, the R-001 placeholder
counts toward `max_runs`, the bootstrap is fire-and-forget. Each of these
makes the pipeline behave differently than the CR description claims. Honest
naming: the CR was directionally complete and structurally green, but the
seam between "tests pass" and "loop survives a noisy LLM" had not been
walked end-to-end.

## Design

### 1. Apply-failure routing (CRITICAL — finding #1)

Today: `runResearchTickOnce` awaits `runResearchSandbox` without a try/catch.
A `git apply` failure throws out of `applyDiff` (research-sandbox-worktree.ts),
the tick aborts, and the experiment record is never updated — it stays at
`status: "proposed"` forever, blocking every subsequent tick.

Change: wrap the sandbox call. On apply failure, transition to `refining` so
the next refine tick can rewrite the diff (the `refine_hypothesis_and_diff`
path already exists). After `max_runs` exhausted on an apply-failure cause,
the existing refine→max_runs→concluded-dump path takes over.

```ts
// research-tick.ts (priority 2b — proposed → sandboxed)
try {
  await runResearchSandbox(proposed.exp_id, config.isolation, { workspacePath });
} catch (err) {
  const reason = String(err).slice(0, 200);
  // Treat as signal-equivalent: the LLM produced something the sandbox
  // couldn't apply. Refine has the binary action choice (rewrite tests vs
  // rewrite hypothesis+diff) that fits this exact recovery shape.
  appendDMNLog(workspacePath /* ... */);
  transitionStage(workspacePath, proposed.exp_id, "refining", `apply failed: ${reason}`);
  return {
    action: "sandbox",
    details: `sandbox apply failed → refining: ${reason}`,
    advanced_exp_id: proposed.exp_id,
  };
}
```

Also: extend `canTransition` so `proposed → refining` is legal (currently
proposed→sandboxed is required first). State machine update:

```
proposed: ["awaiting-epic-approval", "sandboxed", "refining", "rejected"],
```

### 2. Refine-stage scope re-validation (CRITICAL — finding #2)

Today: `runResearchRefine` accepts `new_diff` from the LLM and writes it to
disk without re-checking `record.scope.allowed_paths`. Iterative refinement
can widen scope past the original allowed_paths — including writing to
operator-owned files like ROADMAP.md or `.admission-cases/`.

Change: import `validateScope` + `extractChangedPaths` from research-propose;
in the `refine_hypothesis_and_diff` branch (research-refine.ts:222-240), call
`validateScope(draft.new_diff, record.scope)` before writing. On invalid:
record the violation in the run notes, conclude the experiment as dump with
`learning = "refine widened scope: <reason>"`, transition to concluded-dump.

This makes the scope boundary structural, not convention. The LLM can refine
the diff content but not the file set.

### 3. Hypothesis ID race (HIGH — finding #3)

Today: `allocateHypothesisId` does read → +1 → write-then-rename. Two
concurrent ticks both read N, both write N+1, both return `H-N+1` —
duplicate IDs.

Change: use the existing `acquireSessionWriteLock`-style pattern from
openclaw core (or simpler: `fs.openSync(path, "wx")` exclusive-create on a
sentinel `.hypothesis-counter.lock` file). Hold the lock for the duration
of the read+write+rename. Release on completion or process exit.

The DMN scheduler runs serially within a single plugin instance, so the race
only matters across processes (gateway + CLI commands). This is a small
window but real.

### 4. H-fixture tag filtering (HIGH — finding #4)

Today: `readHypothesisFixtures` reads the entire `hypothesis-fixtures.jsonl`
file. `runResearchSandbox` evaluates every loaded fixture as an H-fixture and
computes `hypothesis_pass_rate` over all of them. The CR's central pass-rate
semantic ("pass requires H-fixtures pass at min_pass_rate") depends on those
fixtures actually being H-fixtures — currently enforced only by prompt
convention.

Change two things:

**At write time** (`parseProposal` in research-propose.ts): require every
fixture in `hypothesis_fixtures.fixtures` to carry `success_metric.fixture_tag`
in its `tags` array. Reject the proposal if any fixture is missing the tag.
This forces the LLM to comply with the prompt instruction.

**At read time** (`readHypothesisFixtures` in research-sandbox.ts): take the
record's `hypothesis_obj.success_metric.fixture_tag` as a parameter; filter
out fixtures whose `tags` don't include it. Belt + suspenders so a future
caller that bypasses propose validation still can't pollute the H-pass-rate.

This requires `AdmissionCase` to have a `tags?: string[]` field. Check
types.ts — if present, use it; if missing, add it (it's a small extension to
the existing schema).

### 5. Per-fixture shape validation (HIGH — finding #5)

Today: `parseProposal` casts `hypothesis_fixtures as HypothesisFixtures`
without per-fixture validation. The first time the sandbox tries to evaluate
a malformed fixture, it crashes — not the propose stage where it could be
caught and retried.

Change: add `validateHypothesisFixtures` to `hypothesis-schema.ts`. Required
fields per fixture: `id` (non-empty string), `label` (string), `fixture`
(object), `expected` (object with `actionId`, `description`, `successSignal`,
`failureSignal`, `domain`), `priorOutcome` (one of "success"/"failure"),
`capturedAt` (ISO string), `tags` (array containing `success_metric.fixture_tag`).
Return `{ valid, errors }` like the other validators. Call it in
`parseProposal` before write.

Reject the proposal if any fixture fails — same behavior as scope or
hypothesis validation failures today.

### 6. End-to-end integration test (HIGH — finding #6)

Today: 7 unit-level test files prove individual stages. Zero tests prove
composition. The CR claim "propose → sandbox → compare → refine → conclude
runs end-to-end" is unproven.

Change: add `research-pipeline.integration.test.ts` covering one full happy
path and one full sad path:

**Happy:** propose → R-001 signal → refine_tests → R-002 pass → rollout-proposed.
Stateful mock callModel returning the right JSON per stage. Assertions on
each transition and the final record state.

**Sad:** propose → R-001 signal → refine → R-002 signal → refine → R-003 signal →
max_runs reached → concluded-dump with close-out row in `.research-log.jsonl`.

Both tests use the same `IsolationDeps` mock + admission corpus seed. They
exist to fail when any stage's contract changes underneath the others.

### 7. Verdict double-gate (HIGH — finding #7)

Today: `deriveRunVerdict` returns "pass" only when both `min_delta_vs_parent`
AND `min_pass_rate` are met. Then `runResearchRollout` independently re-checks
`mean_delta >= rolloutThreshold` (default 0.05). Two gates on overlapping
criteria. Legacy fallback uses `mean_delta >= 0` — looser than new path.

Change: make `runResearchRollout` trust the upstream verdict.

```ts
// research-compare.ts:runResearchRollout
const lastRun = record.runs?.[record.runs.length - 1];
if (lastRun?.verdict !== "pass") {
  // Compare already routed signal/fail elsewhere; rollout only sees pass.
  return { admitted: false, reason: `verdict=${lastRun?.verdict ?? "n/a"}` };
}
// No second threshold — verdict==pass IS the gate.
```

Keep `rolloutThreshold` as a parameter for legacy records (no `hypothesis_obj`)
where verdict comes from the legacy heuristic and the threshold is the only
defense.

### 8. parsePatternErrors → action signal (HIGH — finding #8)

Today: `parsePatternErrors` is logged via `appendArchivistLog("parse_partial", ...)`.
Nothing reads that log to alert when drop rate is high.

Change three things:

- `appendArchivistLog` already exists; emit at WARN severity when `dropped /
parsed > 0.5`, ERROR when `parsed === 0 && dropped > 0` (LLM emitted only
  garbage). Today it's all info-level.
- Surface a new metric in `.archivist-state.json`: `recent_drop_rates: number[]`
  (last 10 runs). Append at runArchivist tail.
- DMN's `campbell_watchdog` already watches for distortion; extend its sources
  to include archivist drop rate. If drop rate >70% across 3 consecutive
  runs, fire `criticalFailure` of severity `warning`. Operator sees it via
  the existing distortion-index path.

### 9. R-001 placeholder semantics (HIGH — finding #9)

Today: propose seeds R-001 with `verdict="error"` placeholder. Refine checks
`runs.length >= maxRuns`. With max_runs=3, this allows R-001 (placeholder)

- R-002 + R-003 = 3 entries. Refine fires on R-002, R-003 — only 2 real
  attempts. CR description implies 3.

Change: filter the placeholder out of the count.

```ts
// research-refine.ts:168
const realRuns = runs.filter((r) => r.verdict !== "error" || r.ended_at);
if (realRuns.length >= maxRuns) {
  // conclude(dump, max_runs)
}
```

`r.verdict === "error" && !r.ended_at` is the placeholder shape (set by
propose, never touched by sandbox/compare). Once sandbox runs, `ended_at` is
set even if verdict is still error. So the filter degrades gracefully:
counts everything that actually ran, ignores never-ran placeholders.

### 10. Cleanup that falls out of the above

These MEDIUMs become trivial once the HIGHs land:

- **Double transition in compare** (#12): replaced by single-write decision
  in finding #7's rewrite.
- **Module-scoped `parsePatternErrors`** (#13): change parsePatterns return
  type to `{ patterns: PatternExtraction[]; errors: string[] }`. Caller
  inspects the returned shape, not module state. Drop the export.
- **Conclude+transition race** (#15): add `concludeAndTransition(workspacePath,
expId, conclusion, terminalStage)` helper that writes the conclusion AND
  the status in a single `writeExperimentRecord` call. Replace the two-call
  call sites in research-compare, research-refine, and cli.ts.
- **Roadmap injection** (#11): add `epic.id.match(/^[a-z0-9-]+$/)` and
  `epic.title.length < 200 && !epic.title.includes('\n')` checks in
  `appendProposedEpic` and `appendEpic`.
- **Epic ID collision** (#14): `if (findEpic(workspacePath, epic.id)) return`
  guard in `appendEpic`.
- **Truncation without persistence** (#10): keep the 200-char display
  truncation but ALSO write the full rationale to `runs/<R>/refine.json`
  (already done) — this becomes a documentation note, not a code change,
  since the audit trail already exists. CLI surfaces it via a new
  `research show-run <exp-id> <run-id>` command.
- **CR status drift** (P0-1): update CR_OODA_HYPOTHESIS_DISCIPLINE.md
  Status: draft → implemented.

### 11. Items deferred (out of this CR's scope)

- **Bootstrap race** (#16): make register() async or accept the documented
  race window. Both options are intrusive; deferred.
- **Hypothesis fixtures dual-location write** (#17): minor performance/clarity
  issue; defer until a third location appears.
- **Append-only queue extraction** (#18): three implementations now
  (trajectory-audit, sitrep-log, proposed-epics). One more occurrence
  triggers extraction to `AppendOnlyLog<T>`.
- **Counter file format upgrade** (#19): plain text → JSON. Low-impact;
  defer unless the file actually corrupts.
- **Threshold dogfood calibration** (#20): requires data we don't have yet.
  Run the loop against the 18 backfill candidates first; calibrate from
  observed distribution. Captured as a separate follow-up CR.
- **`latestEpicStates` dead export** (#21): trivial cleanup, do as a
  follow-up commit.
- **Doc state diagram drift** (#22): trivial cleanup.
- **Soft-drop asymmetry across parsers** (#23): defensible — research-stage
  parsers should hard-fail; archivist is the only one that should soft-drop.
  Document the asymmetry.

## Implementation plan (~1 day)

Files modified:

- `research-tick.ts` — try/catch around sandbox; refining slot + apply-fail routing
- `research-loop.ts` — add `proposed → refining` transition
- `research-refine.ts` — re-validate scope; placeholder-aware run count
- `research-propose.ts` — fixture tag enforcement; per-fixture validator
- `research-sandbox.ts` — H-fixture filter by tag
- `research-compare.ts` — single-write verdict routing; rollout trusts verdict
- `archivist.ts` — return `{patterns, errors}` instead of module-scoped state;
  WARN/ERROR severity on high drop
- `cli.ts` — `concludeAndTransition` helper; `research show-run` command;
  `latestEpicStates` removal
- `roadmap.ts` — injection guards in `appendEpic`/`appendProposedEpic`;
  collision check in `appendEpic`
- `hypothesis-schema.ts` — file-lock counter; `validateHypothesisFixtures`
- `types.ts` (if needed) — `AdmissionCase.tags?: string[]`
- `dmn.ts` — campbell_watchdog reads archivist drop rate
- `CR_OODA_HYPOTHESIS_DISCIPLINE.md` — status flip + state diagram sync

New files:

- `research-pipeline.integration.test.ts` — happy + sad full-pipeline tests
- `concludeAndTransition` helper (probably extends `conclusion.ts`)

## Safety

- Every CRITICAL fix transitions records to a recoverable state, not a
  silent terminal one. Apply failure → refining (LLM gets another shot).
  Refine widening scope → concluded-dump with explicit learning note. No
  data is silently discarded.
- Scope re-validation in refine is a tightening, not a loosening. Worst case
  it rejects a legitimate refine that the original propose would have allowed
  — recoverable via re-propose.
- File-lock counter is a small atomicity gain. If the lock can't be acquired
  within 5s, propose returns without allocating, and the candidate is left
  unpromoted for the next tick.
- Soft-drop severity escalation can cause new WARN/ERROR log volume on a
  poorly-tuned LLM. Documented as expected; operators should treat the
  warnings as a model-quality signal, not infrastructure failure.
- The integration test will catch contract drift earlier; if a future change
  breaks the pipeline, the test goes red instead of the loop going silent.

## Non-goals

- **No rewrite of the verdict-derivation rubric.** The 0.6 / 0.05 thresholds
  are kept as defaults, just no longer double-gated. Calibration is a
  separate dogfood-driven CR.
- **No per-fixture semantic eval.** Sandbox still does the structural
  typecheck pass. Per-fixture semantic remains a future CR; this hardening
  pass only fixes the segregation contract that pass-rate semantics depend on.
- **No bootstrap race fix.** Documented as a known minor.
- **No automated drop-rate auto-tuning.** Just the alert path.

## Rollout

1. Land the CR file (this document).
2. Implement findings 1, 2, 4, 7, 9 (CRITICAL + the most-impactful HIGHs)
   in one commit + tests.
3. Implement findings 3, 5, 6, 8 + the cleanup MEDIUMs in a second commit.
4. Run the integration test; confirm green.
5. Restart gateway; let one full tick fire on a proposed candidate;
   verify the apply-failure path actually transitions to refining
   (not error/stuck).
6. Update CR_OODA_HYPOTHESIS_DISCIPLINE.md status to "implemented + hardened".
7. Open a follow-up tracking CR for items in §11 (deferred).
