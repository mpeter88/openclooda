# CR: OODA Council KS Stopping — Adaptive Chair Sampling with Stability Detection

**Date:** 2026-04-18
**Status:** WRITTEN
**Priority:** MEDIUM — structural upgrade to chair arbitration; without it, single-sample chair is a known variance source
**Depends on:** `CR_OODA_COUNCIL_ADVERSARIAL_DISCIPLINE.md` (Batch D1) — position-anchored chair.
**Source:** Multi-Agent Debate for LLM Judges with Adaptive Stability Detection, Hu, Tan, Wang, Qu, Chen 2025 (arxiv 2510.12697). Beta-Binomial mixture + Kolmogorov-Smirnov stopping borrowed and adapted to our council's chair-sampling regime.

---

## Current State

`runCouncil` system2 makes **one** chair call. The chair's verdict is a single sample from a distribution. If chair confidence is low or the decision is borderline, the single sample is noisy — a resampled chair might reverse the verdict.

D1 introduces chair position-anchoring (pre-read + post-read chair = 2 calls). That helps against sycophancy but doesn't address verdict variance. On borderline cases, both the pre-read and post-read chair are still single samples.

Hu et al. 2025 proposes: sample the chair multiple times across rounds, model the verdict distribution as a Beta-Binomial mixture, and stop when the KS distance between successive rounds drops below a threshold. The result is a verdict whose stability is measured, not assumed.

---

## Design

### C1 — Chair Sampling Loop

New function in `council.ts`:

```typescript
export interface AdaptiveChairConfig {
  enabled: boolean; // default: true when council_mode === "system2"
  /** Minimum chair samples before stability check. Default: 3 */
  minSamples: number;
  /** Maximum chair samples before forced stop. Default: 9 */
  maxSamples: number;
  /** KS distance threshold below which distribution is considered stable. Default: 0.15 */
  ksThreshold: number;
  /** Temperatures used across samples (cycled). Default: [0.0, 0.4, 0.8] */
  temperatures: number[];
}

export interface ChairSamplingResult {
  samples: Array<{
    attempt: number;
    temperature: number;
    parsed: ChairParsed;
    raw: string;
  }>;
  stabilizedAt: number; // sample index where KS dropped below threshold
  ksByRound: number[]; // KS distance per round
  winner: ChairParsed; // modal verdict across samples
  winnerShare: number; // fraction of samples voting this winner
  forcedStop: boolean; // true if maxSamples reached without stability
}

export async function runAdaptiveChair(
  members: Array<{ role: string; output: string }>,
  sitrep: SITREP,
  priorities: PrioritiesFile,
  prior: ChairPrior, // from D1
  callModel: ModelCallFn,
  config: AdaptiveChairConfig,
): Promise<ChairSamplingResult>;
```

Loop semantics:

1. Take `minSamples` chair samples at rotating temperatures.
2. Compute empirical distribution over verdict labels (archetype names).
3. For each subsequent sample (up to `maxSamples`):
   - Append the sample.
   - Compute KS distance between the distribution at `n` samples vs the distribution at `n-1` samples.
   - If `KS < ksThreshold`, stop.
4. Emit the modal winner.

Implementation detail: the verdict "distribution" is over a discrete label space (the archetype set). KS on a discrete distribution degenerates to the maximum absolute cumulative-probability difference — equivalent to the classical two-sample test for categorical data. Hu et al. use Beta-Binomial for binary verdicts; our multi-label space generalizes via per-label Bernoulli indicators and reports the max per-label KS as the round's stopping statistic.

### C2 — Early-Confident Shortcut

If all `minSamples` draws agree on the same winner (100% consensus in first N), skip to output with `stabilizedAt = minSamples` and `winnerShare = 1.0`. Don't waste additional draws on trivially stable decisions.

### C3 — Split-Verdict Fallback

If the sampling loop reaches `maxSamples` with `forcedStop = true` and no label commands a plurality (top two labels within 0.1 of each other), emit `dissent: true` in the final `CouncilTrace`. The meta-reviewer surfaces persistent split verdicts as a proposal: "archetype set may be ill-defined for domain X — consider adding or merging archetypes."

### C4 — Integration with D1 Position Anchoring

The anchored chair from D1 runs as sample 0 (the pre-read). Samples 1..N run with the anchor visible in the prompt (per D1). The sampling loop thus includes the anchor implicitly — every post-read sample respects C1-position-anchored-chair semantics, and variance is measured across anchored samples, not unanchored ones.

### C5 — Logging

`CouncilTrace` (extended further from D1):

```typescript
export interface CouncilTrace {
  // ... from D1 ...
  adaptiveChair?: {
    enabled: boolean;
    sampleCount: number;
    stabilizedAt: number;
    winnerShare: number;
    ksTrajectory: number[];
    forcedStop: boolean;
  };
}
```

### C6 — Configuration

`PrioritiesFile.thresholds`:

```typescript
{
  council_adaptive_chair_enabled: boolean; // default: true
  council_adaptive_chair_min_samples: number; // default: 3
  council_adaptive_chair_max_samples: number; // default: 9
  council_adaptive_chair_ks_threshold: number; // default: 0.15
  council_adaptive_chair_priority_floor: number; // default: 7 — below, single-sample
  council_chair_daily_budget: number; // default: 200 — see C9
}
```

Depends on D1 exporting `ChairParsed` (currently a local interface at `council.ts:332`).

### C7 — Jury Layer Interaction

D1's optional jury ran at `priority >= 9, disagreement >= 0.6`. With adaptive chair:

- If `winnerShare >= 0.85` (strong chair consensus across samples), skip jury — chair is reliable by measurement.
- If `winnerShare < 0.6`, force jury on regardless of disagreement floor.
- Between 0.6 and 0.85, existing D1 trigger rules apply.

### C8 — CLI and Observability

- `openclaw workspace council sampling report` — 30-day view: mean samples-to-stable, max KS trajectory, forced-stop rate per domain.
- `openclaw workspace council sampling tune` — grid-searches `ksThreshold` and `minSamples` against historical SITREP log records. Emits a PolicyProposal (gated by C2).

### C9 — Cost Control

Adaptive chair adds 2–8 chair calls per high-stakes turn. Guardrails:

- Gate by `sitrep.priority`: adaptive sampling only when `priority >= thresholds.council_adaptive_chair_priority_floor` (default `7`). Lower-priority turns use a single chair call.
- Budget ceiling: per-day chair-sample budget cap in `PRIORITIES.json.thresholds.council_chair_daily_budget` (default `200`). Exceeded budget forces single-sample mode with a `_archivist_log` warning entry.

---

## Acceptance Criteria

- [ ] `runAdaptiveChair` with discrete KS stopping implemented and unit-tested against synthetic sample sequences.
- [ ] Early-confident shortcut exercised on 100%-consensus fixtures.
- [ ] Split-verdict fallback emits `dissent: true`.
- [ ] `winnerShare` feeds jury activation thresholds (C7).
- [ ] New config keys present; operator-adjustable.
- [ ] Integration test: a full system2 run with adaptive chair on a borderline fixture produces `stabilizedAt < maxSamples` and a winner matching the modal sample.
- [ ] Budget ceiling enforced; exceeded budget logged.

---

## Risk and Open Questions

1. **Discrete vs continuous KS.** The paper's Beta-Binomial mixture is for binary verdicts. Our adaptation treats per-label Bernoulli indicators and takes max over labels. This is standard but loses a continuous confidence dimension. For v2 we could also sample `alignmentScore / efficiencyScore / riskScore` and KS-test those continuous values.
2. **Cost spike on consistently-borderline domains.** If a domain chronically produces `winnerShare < 0.6`, cost balloons. Mitigation: meta-reviewer detects this and proposes adding an archetype or tightening SITREP routing; proposal gated by the pass^k gate.
3. **Temperature cycling side-effects.** High-temperature chair samples can produce low-quality reasoning that drags the winnerShare. Only sample temperatures the rest of the stack already tolerates (match `agents.defaults` temperature ceiling).
4. **Arxiv ID verified.** 2510.12697 confirmed — Hu, Tan, Wang, Qu, Chen 2025. Mechanism adapted, not copied verbatim.
5. **Dependency.** This CR depends on D1's chair position anchoring. If D1 ships later, adaptive-chair can still run, but skipping the pre-read step means variance measurement is over unanchored chairs — measured variance is larger, stability harder to detect. Document as a prerequisite.
