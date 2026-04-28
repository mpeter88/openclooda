# CR_OODA_HYPOTHESIS_DISCIPLINE — Structured hypothesis, value-linkage, targeted tests, refine-loop

Status: implemented + hardened (see CR_OODA_HYPOTHESIS_DISCIPLINE_HARDENING)
Target batch: J
Estimated effort: ~1 day
Depends on: CR_OODA_RESEARCH_LOOP (pipeline substrate), CR_OODA_AGENT_ARCHIVE
(lineage substrate), CR_OODA_PASS_K_ACCEPTANCE_GATE (existing admission
fixture schema).

---

## Source

Conversation with Peter 2026-04-21 while reviewing the first backfill results
(18 candidates pulled from arxiv with curiosity / metacognition / recursive-
self-improvement signal). Peter pushed back on the thin current design:
experiments are one-shot typecheck pass/fails with no structured hypothesis,
no per-H test suite, no refine loop, no conclusion, no linkage to the product
roadmap. His words:

> "My thoughts → research → infer value & impact (why do it, what does it
> add) → falsifiable hypothesis on value & impact → write specific, targeted
> tests → run → evaluate → refine tests if signal, or refine hypothesis &
> rewrite tests → final test results → conclusion → stage for openclooda
> backlog OR dump, with final note in research experiment log. Note we need
> hypothesis numbering, experiment run numbers, etc. documentation. … We
> need to not just build things as an experiment — we need to find a way line
> to current / future value."

The core demand is epistemic: every experiment must carry a _falsifiable claim
about value_, and must be tested against hypothesis-specific fixtures — not the
generic `pnpm tsgo --noEmit` that the first iteration of
CR_OODA_RESEARCH_LOOP ships with.

## Motivation

Current `ExperimentRecord` treats a research paper as "apply its idea as a
diff, see if the diff still typechecks + doesn't regress the admission gate."
That conflates three separate questions:

1. _Does this idea matter for openclooda?_ (value)
2. _Do we predict what changes if we apply it?_ (falsifiable claim)
3. _Did the change land as predicted?_ (evaluation against a specific test)

Today only (3) is captured, and only via a coarse regression signal. Without
(1) and (2) the system drifts toward _busywork_ — it can generate
syntactically-valid diffs for every paper in the arxiv feed without any of
them tying back to what the product needs next. Without (2), a passing
sandbox tells us the diff typechecks but not whether the paper's claimed
capability actually showed up in the agent.

This CR closes those gaps by formalising the hypothesis schema, requiring
value + roadmap linkage at propose time, forcing per-hypothesis test
generation, and introducing a bounded refine-retry loop before a hypothesis
terminates.

## Design

### 1. Hypothesis schema

New field on `ExperimentRecord` (today it's free-text):

```ts
interface Hypothesis {
  id: string; // "H-017", workspace-sequential
  claim: string; // one-sentence testable statement
  prediction: string; // what we expect to observe
  success_metric: {
    fixture_tag: string; // e.g. "ambiguous-input"
    min_pass_rate: number; // e.g. 0.6 (on new H-specific fixtures)
    min_delta_vs_parent: number; // e.g. 0.05 mean_delta
  };
  failure_metric: {
    regression_forbidden_tags: string[]; // e.g. ["critical","safety"]
    max_latency_delta_ms?: number;
  };
  scope_boundary: string[]; // allowed_paths — duplicates ExperimentRecord.scope
  // for hypothesis-level auditability
}
```

`H-NNN` allocated by a counter file at `.archive/hypothesis-counter.txt`.
Numbering is workspace-scoped and monotonic across all experiments, so an
operator can always refer to "H-017" unambiguously in conversation.

### 2. Value + roadmap linkage

New field on `ExperimentRecord`:

```ts
interface ValueImpact {
  what_it_adds: string; // one paragraph — the capability delta
  why_now: string; // justification against current priorities
  roadmap_link: {
    horizon: "current" | "near" | "distant";
    epic: string; // must match an epic in ROADMAP.md
  };
  est_impact: number; // 0..1 — subjective importance
  est_effort: number; // 0..1 — subjective build cost
}
```

Hard rule in the propose stage: **every hypothesis must declare a roadmap
linkage — either `epic` (existing) or `propose_epic` (new).** Zero
roadmap-free experiments.

The `roadmap_link` field is a union:

```ts
type RoadmapLink =
  | { mode: "existing"; horizon: "current" | "near" | "distant"; epic: string }
  | {
      mode: "propose";
      horizon: "current" | "near" | "distant";
      epic_id: string; // suggested slug, e.g. "metacog-consolidation"
      title: string; // human-readable title
      rationale: string; // why this is a new direction, not a rehash of an existing epic
    };
```

**Existing epic path**: `epic` must match an ID in
`~/.openclaw/workspace/ROADMAP.md`. Unknown epic → proposal rejected.

**Proposed-epic path**: the loop emits a draft epic. This is a separate
operator-review gate — analogous to PolicyProposal for code rollout:

- Draft epic appended to `~/.openclaw/workspace/.proposed-epics.jsonl` with
  `{epic_id, title, rationale, horizon, proposed_by_hypothesis_id,
proposed_at, status: "pending"}`.
- The hypothesis enters state `awaiting_epic_approval` and does NOT advance
  to sandbox until the operator accepts or rejects the draft epic.
- CLI: `openclaw workspace roadmap pending` / `roadmap accept <epic-id>` /
  `roadmap reject <epic-id> <reason>`.
- On accept: epic is appended to `ROADMAP.md` under the chosen horizon,
  hypothesis transitions to `proposed → sandboxed` (normal path resumes).
- On reject: hypothesis transitions to `concluded(dump)` with
  `learning = "epic rejected: <reason>"` — the discovery stays in the log
  so future candidates can see the rejection.

This preserves operator-owned curation (only the operator can promote a
draft epic into ROADMAP.md) while allowing the loop to surface genuinely
novel directions without forcing every hypothesis into a pre-existing
bucket.

`ROADMAP.md` is a plain markdown file with a simple schema (three top-level
sections `## Current`, `## Near`, `## Distant`, each containing `### <epic-id>

<title>`). Parser is tolerant — unknown markdown is ignored; only epic IDs
matter. We ship a starter file populated from today's stated gaps
(curiosity, metacognition, richer-reasoning, ToM, tool-discovery,
hierarchical-planning, graph-rag, continual-learning, novel-benchmarks,
self-critique, neurosci-mechanisms, decision-theory).

### 3. Per-hypothesis test generation

Today, `research-propose.ts` asks the LLM for `{proposal_md, hypothesis,
allowed_paths, diff}`. We extend it to also return:

```ts
interface HypothesisFixtures {
  fixtures: AdmissionCase[]; // new admission-gate fixtures that
  // encode the hypothesis's prediction
  rationale: string; // why these fixtures falsify the claim
}
```

These fixtures are stored at `.experiments/<exp-id>/hypothesis-fixtures.jsonl`
and are _added to the admission corpus for this experiment only_ — they live
in the worktree's admission set during sandbox, alongside the full regression
corpus. A successful sandbox requires:

- **All hypothesis fixtures pass** at or above `success_metric.min_pass_rate`.
- **Regression suite** produces no failures tagged in
  `failure_metric.regression_forbidden_tags`.
- **Mean delta** vs parent meets `success_metric.min_delta_vs_parent`.

If _any_ of those three fail, the run's verdict is "signal" (partial) or
"fail" (no signal). Only all-three-green → "pass".

This replaces the "`pnpm tsgo --noEmit`" default eval with a structured,
hypothesis-specific harness. (The worktree-level typecheck still runs as a
prefilter — a diff that doesn't typecheck never reaches fixture evaluation.)

### 4. Refine-retry loop

Today, an experiment is terminal after one sandbox run. We introduce bounded
retries:

```ts
interface Run {
  run_id: string; // "H-017-R-001"
  started_at: string;
  sandbox_scores: ExperimentResult;
  hypothesis_pass_rate: number;
  regression_pass: boolean;
  verdict: "pass" | "signal" | "fail" | "error";
  notes: string; // LLM-authored or operator-authored
}
interface ExperimentRecord {
  // ...existing fields...
  runs: Run[];
  max_runs: number; // default 3
}
```

New state machine nodes:

```
proposed ─┬─ (epic existing)  → sandboxed
          └─ (epic proposed)  → awaiting_epic_approval ─┬─ accept → sandboxed
                                                        └─ reject → concluded(dump)

sandboxed → compared ─┬─ pass     → admitted  → rolled_out
                      ├─ signal   → refining  → sandboxed (next R)
                      └─ fail     → concluded(dump)
```

`refining` is driven by a new tick handler that:

1. Reads the last run's fixtures + sandbox output + regression delta.
2. Asks the LLM: "given this signal-but-not-pass result, choose EXACTLY one
   of: (a) refine tests — the fixtures didn't encode the claim tightly
   enough; (b) refine hypothesis + diff — the claim was too strong or the
   diff was wrong."
3. Generates the refined artifact (fixtures or diff), appends a new Run row,
   and transitions back to `sandboxed`.

Max 3 runs. After `max_runs` without pass → auto-concluded as dump with a
final LLM-authored `conclusion.learning` note.

### 5. Conclusion

New terminal field on `ExperimentRecord`:

```ts
interface Conclusion {
  verdict: "stage" | "dump" | "inconclusive";
  learning: string; // what we know now that we didn't before
  authored_by: "system" | "human";
  concluded_at: string;
}
```

When a hypothesis reaches a terminal state (rolled_out, dumped,
inconclusive-after-max-runs), the plugin:

1. Writes `conclusion` into the ExperimentRecord.
2. Appends a close-out row to `.research-log.jsonl` referencing the original
   candidate id + H-id + verdict + one-line learning. This closes the loop
   so the same discovery log is both the entry point (stage 1) and the
   exit record (stage 5).
3. For `stage` verdict — existing rollout-queue path (PolicyProposal emitted
   for human approval).
4. For `dump` — no rollout; the learning is preserved in the archive so
   a future candidate with similar shape can be flagged "related to H-017
   which dumped because…".

### 6. Numbering & audit

- `H-NNN` allocated at propose time via
  `.archive/hypothesis-counter.txt` (next-int file; transaction-safe write).
- Runs numbered within hypothesis: `H-017-R-001`, `H-017-R-002`.
- Every run appends a row to `.experiments/<exp-id>/runs.jsonl` in addition
  to updating the in-record `runs: Run[]` — JSONL is the append-only audit
  trail; the in-record array is for readers that don't want to re-parse.
- CLI: `openclaw workspace research hypothesis list` + `hypothesis show
H-017` + `hypothesis runs H-017`.

## Implementation plan (≤1 day)

New files:

- `hypothesis-schema.ts` — `Hypothesis`, `ValueImpact`, `RoadmapLink`,
  `Run`, `Conclusion` types + counter + validators.
- `roadmap.ts` — parse `ROADMAP.md`; expose `listEpics(workspacePath)`;
  append-epic on operator accept; manage `.proposed-epics.jsonl`
  (read/accept/reject/pending-list).
- `research-refine.ts` — tick handler for `refining` state. Reuses the
  propose-stage prompt machinery with a refine-specific prompt.
- `conclusion.ts` — terminal-state close-out writer + research-log back-reference.
- Tests: schema counter monotonic + transaction-safe; roadmap parser
  tolerant; epic-propose accept/reject round-trip; refine prompt generates
  well-formed output; conclusion writer appends to research-log.

Extended files:

- `research-loop.ts` — extend `ExperimentRecord` type; extend state machine
  with `refining`.
- `research-propose.ts` — require `hypothesis` + `value` + `hypothesis_fixtures`
  in LLM response; reject if roadmap epic unknown.
- `research-sandbox.ts` / `research-sandbox-worktree.ts` — new per-H fixture
  eval path; wire hypothesis fixtures into admission corpus for the sandbox
  run only.
- `research-compare.ts` — verdict derivation uses `success_metric` +
  `failure_metric` instead of hardcoded mean-delta threshold.
- `research-tick.ts` — add `refining` priority slot (between sandbox and
  compare in the dispatch order).
- `cli.ts` — `hypothesis` subcommand tree + `roadmap {pending,accept,reject}`
  tree.
- `index.ts` — plumb roadmap path + counter path into plugin config
  resolution.

Workspace bootstrap:

- Write `~/.openclaw/workspace/ROADMAP.md` with the gap list we already
  use as the architectureSummary, mapped into three horizons.
- Initialise `.archive/hypothesis-counter.txt` = 0 on first run.

## Safety

- `ROADMAP.md` is operator-owned. The plugin writes only via the
  `roadmap accept` path (which is explicitly operator-initiated). Draft
  epics land in `.proposed-epics.jsonl` — a queue, not the roadmap itself.
  Prevents the loop from silently inventing epics to justify experiments
  while still letting it surface genuinely novel directions.
- `max_runs=3` caps LLM spend per hypothesis (3 × propose-tier + 3 × sandbox).
- Hypothesis fixtures land in the worktree admission set, not the
  workspace's real admission set — so a bad hypothesis can't pollute the
  regression corpus.
- Conclusion step is authored by the system for now; human-override path
  exists via `openclaw workspace research conclude H-017 dump "..."`.

## Non-goals

- **Per-fixture semantic eval from scratch.** We're using the existing
  admission-gate fixture runner as-is — the hypothesis fixtures follow the
  same shape. A future CR can deepen fixture runtime (e.g. counterfactual
  stress tests); not this one.
- **Automatic roadmap editing.** The system cannot add epics on its own.
  It can _propose_ new epics (which surface via `roadmap pending`), but only
  operator-initiated `roadmap accept` writes to `ROADMAP.md`. Roadmap
  curation stays with the operator.
- **Beyond 3 runs.** If a hypothesis needs more iteration, it's a manual
  re-propose — the loop won't grind indefinitely.

## Rollout

1. Draft CR — this file.
2. Schema + roadmap + counter (half-day).
3. Propose/refine/compare wiring (half-day).
4. Dogfood on the 18 backfill candidates: let the loop draft H-001 through
   H-005 from the top-tier 0.82 papers, observe whether the roadmap gate
   catches anything and whether refine loops converge.
5. Calibrate max_runs + success_metric thresholds from that dogfood.
