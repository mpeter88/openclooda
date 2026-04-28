# CR_OODA_RESEARCH_LOOP — Autonomous literature-to-experiment-to-rollout pipeline

Status: scaffold shipping; full implementation phased
Target batch: H → I (phased)
Estimated effort: 2 weeks across multiple sessions
Depends on: CR_OODA_AGENT_ARCHIVE (lineage substrate), CR_OODA_PASS_K_ACCEPTANCE_GATE
(admission gate), CR_OODA_DMN_INTEGRATION_LOOP (budgeted background scheduler)

---

## Source

- Zhang et al. 2026, "HyperAgents" (arxiv 2603.19461). Per-generation diff + frozen
  evaluation harness + random-over-filtered parent selection.
- Zhang et al. 2025, "Darwin Gödel Machine" (arxiv 2505.22954). Self-improving
  skeleton with empirical validation gate.
- Classical open-ended evolution literature (POET, Quality-Diversity archives).

The motivation surfaced in a conversation with Peter on 2026-04-20 while reading
facebookresearch/Hyperagents: openclooda should autonomously find relevant papers,
draft experimental patches applying their ideas, run them in an isolated sandbox,
compare against a baseline, and only propose production rollout when the result
beats baseline on the grounded-eval harness.

## Motivation

openclooda has:

- A structured cognitive architecture (triage, council, archivist, meta-reviewer,
  DMN, beliefs, admission gate).
- Content-hash integrity + snapshot rollback.
- A generation archive (CR_OODA_AGENT_ARCHIVE) so we can descend experiments from
  known-good parents.

What's missing is the **discovery → experimentation → promotion** pipeline. Today
new CRs are all drafted by the operator + Claude in interactive sessions. There's
no mechanism for the plugin to notice "a paper published last week suggests a
concrete improvement to my council structure" and act on it — even partially — on
its own.

This CR designs that pipeline. It sits deliberately behind a human rollout gate
(autonomy ends before production merge), but everything upstream can run
unattended on a DMN-scheduled budget.

## Design

### Five stages

Each stage is a pure function over an `ExperimentRecord` (stored under
`.experiments/{exp-id}/`). Stages resume across DMN ticks, so a single experiment
may span many hours of wall-clock at low cadence.

#### Stage 1 — Discover

`research-discover.ts`:

- Pulls from configured feeds (default: arxiv `cs.AI` new submissions RSS,
  optionally semantic-scholar / github trending).
- For each item, produces a `ResearchCandidate` row in `.research-log.jsonl`.
- Filters by keyword match against `PRIORITIES.json.thresholds.research_keywords`
  (default: `["llm agent", "self-improving", "memory retrieval", "dgm", "pattern
separation", "episodic memory", "planning", "multi-agent"]`).
- Surviving candidates go through an LLM relevance scorer:
  prompt = `openclooda architecture summary + paper abstract + "Rate 0-1 how
directly applicable this paper's central idea is to the current architecture.
Respond with raw JSON {score, rationale}."`
- Only `score ≥ research_candidate_floor` (default 0.6) proceeds.

Budget: one LLM call per candidate; capped by DMN's existing `llm_calls_24h`.

#### Stage 2 — Propose

`research-propose.ts`:

- For each high-relevance candidate, generate an experiment proposal.
- Inputs: openclooda source tree summary + paper abstract + current archive
  lineage summary (which generations are valid parents).
- LLM produces:
  - `proposal.md` — a CR-style document (narrower scope than a full CR).
  - `hypothesis.md` — "what will improve, by how much, on which domain."
  - `scope.json` — explicit allowlist of files this experiment may touch.
- Scope enforcement: diff generated in Stage 3 is diffed against scope.json; any
  out-of-scope edit fails the experiment before sandbox (mirrors HyperAgents'
  `filter_patch_by_files(["domains/"])` but applied proactively + symmetrically).

Budget: one LLM call per proposal.

#### Stage 3 — Sandbox

`research-sandbox.ts`:

- Select a parent generation from `.agent-archive.jsonl` via
  `select_next_parent`-style logic (random-over-filtered, see HyperAgents
  discussion).
- Create an isolated workspace:
  - Preferred: Docker container with the plugin source + a fresh empty workspace.
  - Fallback (no docker): `git worktree` under `.experiments/{exp-id}/worktree/`
    - a separate `$HOME/.openclaw-exp-{exp-id}/` state dir.
- Apply the proposed diff inside the sandbox.
- Run the existing admission corpus (`listAdmissionCases`) in staged form:
  - Small subset first (first 5 cases or `stagedeval_frac` fraction).
  - If small pass-rate ≥ `research_expand_threshold` (default 0.4, DGM's value),
    expand to full corpus.
- Capture `ExperimentResult`:
  - `pass_rate` per-subset.
  - Distortion/axis-priors delta against baseline.
  - p95 latency of the hot path.
  - Any new error-classifier tags.
  - `stagedeval_frac` normalisation applied to match full-eval scores (CR Path C
    of HyperAgents' `get_saved_score`).

Budget: depends on pass^k. Hard cap = 2 experiments/day running stage 3.

#### Stage 4 — Compare

`research-compare.ts`:

- Baseline score = cached admission-corpus score for the parent generation from
  the archive (populated by archivist step 9.5 when it runs).
- If baseline missing, run it now against the parent's plugin source (same
  sandbox infra, no diff applied).
- `delta.json`:
  - Per-domain `{baseline, sandbox, delta}`.
  - Global mean delta.
  - Regression check: any prior-success admission case that flipped to failure.

#### Stage 5 — Rollout proposal

`research-rollout.ts`:

- If `delta.mean ≥ research_rollout_threshold` (default +0.05) AND no
  regressions on priorOutcome=success cases:
  - Emit a `PolicyProposal` with:
    - `category: "research_rollout"`.
    - `proposal` = one-line experiment summary.
    - `reasoning` = full ExperimentResult + paper citation + diff size.
    - `evidence[]` = list of admission case ids that the experiment improved on.
  - The proposal goes through the EXISTING `runChangeGate` pipeline at
    `kind: "policy_proposal"` with the FULL admission corpus (not the staged
    subset). This is the empirical-validation gate from DGM.
  - On gate admit → user approves via `openclaw workspace proposals approve <id>`.
    On user approval → the diff lands as a new generation in the archive with
    `experiment_id` set.

Human gate preserved. Autonomy ends before production merge.

### Artifacts

```
.experiments/
  {exp-id}/
    source.md            # paper arxiv id, source repo commit (when applicable)
    proposal.md          # LLM-generated CR-style draft (stage 2)
    hypothesis.md        # testable prediction
    scope.json           # {"allowed_paths": [...], "max_files": N}
    diff.patch           # the actual change (stage 2 LLM generates)
    baseline-score.json  # parent generation's grounded score (stage 4)
    sandbox-score.json   # patched variant's grounded score (stage 3)
    delta.json           # comparison (stage 4)
    status.json          # {stage, state, updated_at}
    log.jsonl            # per-stage transcript
    lineage.json         # {parent_genid, children_experiments: []}
.research-log.jsonl      # append-only discovery ledger (stage 1)
.rollout-queue.jsonl     # experiments awaiting human approval (stage 5 passed)
```

`status.json.stage` is one of:
`discovered | proposed | sandboxed | compared | rollout-proposed | rolled-out | rejected | superseded`

### DMN integration

New work kind `research_tick` — Idle + Dormant buckets only.

Each tick:

- Pick the oldest in-progress experiment whose next stage is not blocked on
  external input.
- Advance ONE stage.
- Write updated status.json + log.jsonl.

If no in-progress experiment exists, run Stage 1 (discover) to refresh the
research log. Experiments that reach `rollout-proposed` land in
`.rollout-queue.jsonl`; user drains the queue via CLI.

Budget: rolled into the existing `llm_calls_24h` DMN counter. Default cap: 5
`research_tick`s per 24h absent user activity.

### Safety boundaries

1. **Sandbox isolation.** Sandbox runs NEVER in the same process or workspace as
   the live gateway. Docker preferred; `git worktree` + isolated `$HOME` fallback.
   If neither is available, experiments stop at Stage 2 (proposal only) — never
   Stage 3.
2. **Scope enforcement.** Diff against scope.json BEFORE sandbox. Out-of-scope
   edit → experiment auto-rejected. Same principle as HyperAgents'
   `filter_patch_by_files(["domains/"])` but symmetric: no file in scope.json's
   denylist is EVER touched. Admission corpus directory is on every experiment's
   denylist by default.
3. **Human approval gate at rollout.** `research_rollout` proposals require
   explicit `openclaw workspace proposals approve <id>` from the operator.
4. **Budget caps.** Per-24h LLM calls capped via DMN; per-24h experiments capped
   at 2 Stage-3 runs, 5 DMN ticks overall.
5. **Content-hash + snapshot.** Even on admit, the rollout writes the new
   generation via the existing gate flow, so snapshot/rollback still works.
6. **Cite-or-reject.** Every experiment MUST carry `source.md` with a paper
   citation or an explicit "no paper — operator-initiated" marker. No anonymous
   experiments.

### CLI

```
openclaw workspace research list [--status X] [--limit N]
openclaw workspace research show <exp-id>
openclaw workspace research log <exp-id>            # full log.jsonl
openclaw workspace research propose <arxiv-id|path> # manual stage-2 trigger
openclaw workspace research sandbox <exp-id>        # force stage 3 now (bypass DMN)
openclaw workspace research diff <exp-id>           # view the generated patch
openclaw workspace research reject <exp-id> <reason>
openclaw workspace research rollout <exp-id>        # file rollout proposal
openclaw workspace research rollout-queue           # show pending approvals
```

## Schema additions

- `ExperimentRecord` + `ResearchCandidate` + `ExperimentResult` types (new file
  `research-loop.ts`).
- `PolicyProposal.category` gains `"research_rollout"` variant.
- `PRIORITIES.json.thresholds`:
  - `research_keywords: string[]`
  - `research_candidate_floor: number` (default 0.6)
  - `research_expand_threshold: number` (default 0.4)
  - `research_rollout_threshold: number` (default 0.05)
  - `research_max_experiments_per_day: number` (default 2)
  - `research_feed_urls: string[]` (default `["http://export.arxiv.org/rss/cs.AI"]`)

## Integration points

- New files:
  - `extensions/memory-ooda/research-loop.ts` — pure types + stage dispatcher.
  - `extensions/memory-ooda/research-discover.ts` — Stage 1.
  - `extensions/memory-ooda/research-propose.ts` — Stage 2.
  - `extensions/memory-ooda/research-sandbox.ts` — Stage 3.
  - `extensions/memory-ooda/research-compare.ts` — Stage 4.
  - `extensions/memory-ooda/research-rollout.ts` — Stage 5.
- Modified:
  - `dmn.ts` — add `research_tick` to `DMNWorkKind`, flag default off, runner.
  - `cli.ts` — `workspace research …` command group.
  - `types.ts` — `PolicyProposal.category` extension.

## Phasing

Ship sequentially across multiple sessions:

**Phase A (this session):** scaffold `research-loop.ts` with types + state
helpers + empty stage functions. Tests for state round-trip. Research tick in
DMN flagged default-off with a stub runner that logs "not yet implemented."

**Phase B:** Stage 1 (discover) — real arxiv RSS fetch + relevance scoring.

**Phase C:** Stage 2 (propose) — LLM generates proposal + diff + scope.

**Phase D:** Stage 3 (sandbox) — Docker runner + staged eval.

**Phase E:** Stages 4 + 5 — compare + rollout proposal.

Each phase independently shippable; earlier phases remain useful even when later
phases aren't ready (e.g. Phase B alone gives us an auto-curated reading list).

## Testability

Phase A:

- State round-trip: write ExperimentRecord → read → fields intact.
- Stage transitions: status advances in legal order (no `rolled-out` before
  `rollout-proposed`).
- DMN `research_tick` runner: when flag off, logs noop; when on but not
  implemented, logs a warning.

Phase B+:

- Stage 1: mock RSS feed, assert candidates land in `.research-log.jsonl`.
- Stage 2: mock LLM, assert `proposal.md + scope.json + diff.patch` written.
- Stage 3 scope enforcement: diff containing out-of-scope edit auto-rejects.
- Stage 4 comparison: known baseline + known sandbox → expected delta.
- Stage 5: a delta-above-threshold ExperimentResult emits a PolicyProposal with
  `category: "research_rollout"` and enters `.rollout-queue.jsonl`.

## Success metrics

- **End-to-end trial.** Within 30 days of Phase E landing, at least one
  experiment traverses all five stages from discover to rolled-out, producing a
  commit whose `Experiment-Id` trailer matches an `.experiments/{exp-id}/`
  folder.
- **Rejection ratio.** ≥ 60% of stage-3 experiments are rejected at stages 4-5
  (not regressions — just didn't clear the rollout threshold). Reading: most
  experiments will fail. That's fine. We're building the infrastructure, not a
  foregone-conclusion improvement pipeline.
- **Citation hygiene.** 100% of admitted rollouts cite a source (paper or
  operator-initiated marker). No anonymous mutations.
- **Human veto rate.** Of stage-5 proposals that the gate admits, operator still
  rejects ≥ 10% on review. If operator approves everything the gate approves,
  either the threshold is too strict or human review is rubber-stamping.

## Out of scope

- Fully autonomous rollout (no human gate). Deliberately excluded.
- Cross-workspace experiment sharing ("this research loop discovered a useful
  mutation on Alice's workspace; apply it to Bob's"). Future CR.
- Paper re-reads — each paper is scored once; no mechanism to reconsider a
  previously-rejected candidate when the architecture has drifted enough to make
  the paper newly relevant. Future CR (paper_reincarnation).
- Experiment recombination (taking good diffs from two experiments and merging
  them). Future CR.
- Operator-provided experiment ideas expressed as natural-language hypotheses
  rather than paper citations. Could land in Phase C via `research propose
--idea "..."` but not scoped here.

## Phase-A deliverable (this session)

Types + state helpers + DMN hook + empty-but-safe runner. This is enough to:

- Bind the shape to the archive lineage (experiments reference parent_genid).
- Let future sessions implement stages without re-designing the substrate.
- Run the full smoke suite with the skeleton in place, proving no regression.
