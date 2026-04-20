# CR: OODA Grounded Evaluation Harness V2 — Admission Gate, Reward-Hacking Diagnostic, pass^k

**Date:** 2026-04-18
**Status:** WRITTEN
**Priority:** CRITICAL — defends every adaptive mechanism against self-grading
**Supersedes:** `CR_OODA_GROUNDED_EVALUATION_HARNESS.md` (v1 — core MetricRegistry already implemented in `metric-registry.ts`)
**Sources:**

- Darwin Gödel Machine, Zhang et al. 2025 (arxiv 2505.22954) — archive + empirical-gate admission
- Reward Hacking as Equilibrium under Finite Evaluation, Wang and Huang 2026 (arxiv 2603.28063) — Goodhart vs Campbell two-regime diagnostic
- τ-bench + τ²-bench, Barres et al. 2025 (arxiv 2506.07982) + Sierra pass^k methodology — reliability metric beyond single-trial

---

## Current State

`metric-registry.ts` already implements:

- `MetricRegistry` class with `register` / `compute` / `computeAll`
- Built-in resolvers: `openclooda` (archivist health), `amf_pipeline` (parity score)
- `createDefaultRegistry()` factory
- Integration into `runArchivist`: groundedScore attached to `DomainOutcomeStats`, discrepancy logged when `|grounded - llmLabels| > 0.3`
- `shouldProposeWeightAdjustment` prefers groundedScore when available

V1 ships **grounded signal**. V2 closes three remaining gaps that block trusting the loop end-to-end.

---

## Problem — Three Remaining Gaps

### G1: No admission gate on proposals

Current flow: Archivist or Meta-Reviewer generates a `PolicyProposal`, user sees it in `workspace proposals list`, user approves. Once approved, the change lands. There is no **pre-admission check** that the proposed change would not regress measured behavior on a fixed battery. This is exactly what DGM calls out as the failure mode of self-modifying systems without a frozen gate: the archive accepts candidates that locally look good on the proposer's signal but degrade an independent measure.

### G2: No reward-hacking diagnostic on approval signals

`successRate` and approval/override counters can drift for two distinct reasons (Wang and Huang 2026):

- **Goodhart regime:** agent reallocates effort to score well on measured dimensions, neglects unmeasured ones. Current `_weight_adjustment_log` cannot distinguish this from genuine improvement.
- **Campbell regime:** agent actively degrades the evaluator (e.g., steers the user toward rubber-stamping, generates output that biases subsequent labels). Catastrophic and undetectable without a separate diagnostic.

### G3: Single-trial gating on policy changes

Every accepted proposal is effectively pass@1. Sierra's τ-bench work shows pass@1 for agents overstates reliability — same task run k=8 times drops from ~60% to &lt;25% on GPT-4o. A SOUL.md or PRIORITIES.json change that passes one replay has not demonstrated that it holds under repetition.

---

## Design

### C1 — Admission Gate for PolicyProposal (new module)

New file `extensions/memory-ooda/admission-gate.ts`:

```typescript
export interface AdmissionCase {
  id: string;
  /** Human label for the case. */ label: string;
  /** Replayable fixture: inputs that reproduce a prior decision scenario. */
  fixture: AdmissionFixture;
  /** Required outcome — the gate fails if replay deviates. */
  expected: ExpectedOutcome;
}

export interface AdmissionFixture {
  observation: string;
  knowledge: KnowledgeFile; // snapshotted at fixture creation time
  priorities: PrioritiesFile; // snapshotted at fixture creation time
  domainTrajectories?: Record<string, number>;
}

export interface AdmissionReport {
  proposalId: string;
  casesRun: number;
  casesPassed: number;
  casesFailed: Array<{ caseId: string; reason: string }>;
  passRate: number; // casesPassed / casesRun
  kPassRates: Record<number, number>; // pass^k for k in [1, 2, 4, 8]
  admit: boolean;
  admitReason: string;
}

export async function runAdmissionGate(
  proposal: PolicyProposal,
  cases: AdmissionCase[],
  runnable: (fixture: AdmissionFixture, proposal: PolicyProposal) => Promise<ActualOutcome>,
  opts?: { kValues?: number[]; passRateFloor?: number },
): Promise<AdmissionReport>;
```

Admission rules:

- `passRateFloor` default `0.80` — at least 80% of cases must succeed on a single trial.
- `pass^8` must be `>= passRateFloor - 0.20` (guardrail against flaky-but-lucky proposals).
- `admit=false` if any case whose prior outcome was `success` now fails (no regressions allowed on previously-working cases).

**Case corpus:** `~/.openclaw/workspace/.admission-cases/*.json`. Cases are captured from `SitrepLogEntry` records (see `sitrep-log.ts`) when the loop succeeded — each captured case is a proven-good trajectory. A separate CLI `openclaw workspace admission capture` promotes a successful episodic event plus its sitrep/chair trace into an admission case.

### C2 — Goodhart/Campbell Distortion Index (new module)

New file `extensions/memory-ooda/distortion-index.ts`:

```typescript
export interface DistortionSample {
  domain: string;
  timestamp: number;
  measured: number; // successRate or groundedScore
  grounded: number; // from MetricRegistry — the independent signal
  approvalCount: number;
  overrideCount: number;
}

export interface DistortionReading {
  domain: string;
  /** [0, 1]. Fraction of variance explained by unmeasured-dimension gaming. */
  goodhartIndex: number;
  /** [0, 1]. Rate at which the grounded signal diverges from approval signal. */
  campbellIndex: number;
  /** One of: "healthy" | "goodhart_warning" | "campbell_suspected" | "insufficient_data" */
  regime: DistortionRegime;
  evidence: string[];
}

export function computeDistortion(
  samples: DistortionSample[],
  window: { days: number; minSamples: number },
): DistortionReading;
```

Regime classification:

- `healthy`: grounded tracks measured within 0.1, approval/override ratio stable.
- `goodhart_warning`: grounded trails measured by > 0.2 AND approval rate still climbing (gaming measured dimensions, grounded lagging).
- `campbell_suspected`: grounded **reverses** while approval signal still positive, OR override rate drops sharply while grounded drops (evaluator capture suspected). Triggers a `criticalFailure` event with severity `critical`.
- `insufficient_data`: fewer than `minSamples` in window.

Distortion is computed per archivist run and stored in `_archivist_log` as a structured entry. The meta-reviewer reads distortion readings before acting on any weight proposal; `goodhart_warning` forces the proposal into `confidence *= 0.5`, `campbell_suspected` auto-dismisses the proposal with `rejectionReason: "campbell_regime_suspected"`.

### C3 — pass^k Battery (new module)

New file `extensions/memory-ooda/pass-k.ts`:

```typescript
export interface PassKConfig {
  kValues: number[]; // default [1, 2, 4, 8]
  /** Cases from the admission corpus that count toward pass^k. */
  caseIds: string[];
  /** Per-case timeout. */ caseTimeoutMs: number;
}

export interface PassKResult {
  kValues: number[];
  passRates: Record<number, number>; // k -> successes-at-k / trials
  totalTrials: number;
  trialsPerCase: number;
  narrative: string;
}

export async function runPassK(
  cases: AdmissionCase[],
  runnable: AdmissionRunnable,
  config: PassKConfig,
): Promise<PassKResult>;
```

Definition (Sierra formalism):

```
pass^k = fraction of cases where the case succeeds on ALL k independent replays
```

`pass^k` is strictly monotone decreasing in k. Acceptance gate for any policy or weight proposal: `pass^8 >= 0.60` on the admission corpus.

### C4 — Wire-up

Modifications:

**`proposals.ts`** — add `admissionReport?: AdmissionReport` field to `PolicyProposal`. `addProposal()` becomes async when admission is required. A new `admissionRequired` flag on the proposal (default `true` for `category: "policy" | "weight_adjustment"`, `false` for `"project" | "workflow" | "technical"`) gates this.

**Async ripple (verified call sites):**

1. `proposals.ts:72` — direct `addProposal` (exported).
2. `archivist.ts:543` — `addWeightProposals` wraps `addProposal` synchronously.
3. `archivist.ts:861` — `addArchivistProposals` wrapper.

All three live inside the Archivist's async path (`runArchivist`), so promotion to async is mechanical. Preserve the sync signatures by adding a parallel `addProposalAsync` and `addWeightProposalsAsync`; migrate callers in one commit; deprecate sync variants in a follow-up.

**`meta-reviewer.ts`** — before emitting a proposal, run the admission gate and the distortion diagnostic. Attach both results. Do not emit if `admit=false` OR `regime === "campbell_suspected"`. Log all gate failures to `_archivist_log`.

**`archivist.ts`** — on every run, record a `DistortionSample` per domain (only when `groundedScore` is present). Rolling window of 30 days stored in `~/.openclaw/workspace/.distortion-history.jsonl`.

**CLI (`cli.ts`)** —

- `openclaw workspace admission capture <actionId>` — promote an episodic event to an admission case.
- `openclaw workspace admission list` / `list --failing`.
- `openclaw workspace admission replay <caseId>` — run a single case against current config.
- `openclaw workspace admission passk --k 8` — run full pass^k battery.
- `openclaw workspace distortion` — print current regime per domain with narrative.

### C5 — Snapshot and Rollback Integration

Every proposal admitted via the gate snapshots PRIORITIES.json, SOUL.md, and KNOWLEDGE.json into `~/.openclaw/workspace/.snapshots/` keyed by `proposalId` (not just timestamp). `openclaw workspace rollback --proposal <id>` restores the pre-admission state of all three files atomically.

---

## Acceptance Criteria

- [ ] `admission-gate.ts`, `distortion-index.ts`, `pass-k.ts` ship with unit tests covering: empty corpus, all-pass, regression on success case, pass^1 pass / pass^8 fail, Goodhart regime detection from synthetic drift, Campbell regime detection from reversal.
- [ ] `runArchivist` emits `DistortionSample` rows for every domain with a grounded metric; rolling file never exceeds 30 days.
- [ ] A proposal with `admit=false` never reaches `status=pending` — goes straight to `status=rejected` with `rejectionReason` from the report.
- [ ] `campbell_suspected` emits a `criticalFailure` event on the gateway event bus.
- [ ] `openclaw workspace distortion` returns a valid regime per known domain within 500 ms after archivist run completes.
- [ ] `pass^8 >= 0.60` is enforceable as a config threshold in `PRIORITIES.json.thresholds.passk_admission_floor`.

---

## Out of Scope (future CRs)

- Training a learned Campbell detector (this CR is statistical only).
- Admission cases auto-generated from synthetic adversarial traces (manual capture only for v2).
- Cross-project admission corpora sharing (keep per-workspace for now).

---

## Risk and Open Questions

1. **Replay determinism.** LLM-backed runnables are nondeterministic. pass^k tolerates this by design (it _is_ the measurement). But the admission gate's single-trial path needs a seed or temperature=0 fixture to avoid flaky rejections. Proposal: admission gate single-trial pass uses `temperature: 0`, then pass^k at defaults.
2. **Corpus bootstrap.** Fresh workspace has no admission cases. Gate defaults to `admit=true` with `admitReason: "no_corpus"` until `>= 5` cases exist. Every first-5-case proposal is logged as ungated in `_archivist_log`.
3. **Arxiv ID verification.** τ²-bench (2506.07982) is cited for pass^k but the formalism originates in τ-bench (2406.12045). Cite both. DGM (2505.22954) archive-gate specifics are paraphrased from the paper's archive + empirical-validation structure, not a verbatim mechanism — frame conservatively in CR prose.
4. **Cost.** pass^8 × 20-case corpus = 160 LLM calls per admission. Gate this behind `thresholds.admission_passk_enabled` default `false`; enable after corpus maturity.
