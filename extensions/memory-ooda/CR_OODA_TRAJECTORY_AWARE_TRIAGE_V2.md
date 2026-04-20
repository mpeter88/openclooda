# CR: OODA Trajectory-Aware Triage V2 — Equal-Budget Baseline, Calibration, Shadow Mode

**Date:** 2026-04-18
**Status:** WRITTEN
**Priority:** HIGH — current trajectory scaling is enabled by default with paper-derived defaults but has no acceptance evidence; this CR provides the evidence or kills the feature
**Supersedes:** `CR_OODA_TRAJECTORY_AWARE_TRIAGE.md` (v1 — `applyTrajectoryScaling` + `computeDomainTrajectories` already implemented in `triage.ts`)
**Sources:**

- Single-Agent LLMs Outperform Multi-Agent Systems Under Equal Thinking Token Budgets, Tran and Kiela 2026 (arxiv 2604.02460) — equal-budget methodology
- Original AOD-CFR scaling retained from v1 source

---

## Current State

`triage.ts` implements:

- `computeDomainTrajectories(events, windowDays, minOutcomes, inferDomainFn)` — pure, tested
- `applyTrajectoryScaling(sitrep, trajectories, config?)` — pure, tested, preserves `rawPriority`
- `TrajectoryScalingConfig` with AOD-CFR defaults: `pos_pos=0.9 / pos_neg=0.7 / neg_pos=0.8 / neg_neg=1.3`
- Injection into PRIORITIES.json thresholds as `trajectory_scaling`

V1 ships the **mechanism**. V2 adds the **evidence** required to trust it. Without V2, the feature is paper-credentialed guessing on live priority calculations.

---

## Problem — Three Evidence Gaps

### E1: No equal-budget baseline

Tran and Kiela 2026 show that many multi-mechanism gains over single-path agents disappear when token budgets are matched. Our trajectory scaling adds a compute line (trajectory computation + scaling arithmetic is cheap, but the _downstream_ effect is more full-OODA firings when `neg_neg=1.3` pushes priorities up). We have no evidence the downstream gain beats simply raising `min_priority_for_full_ooda` by -1 (i.e., giving single-path triage the same "extra compute" budget).

### E2: No calibration of scale factors against our actual outcome data

Defaults came from AOD-CFR's game-theoretic setting. Our domain is agentic assistant work. `pos_neg=0.7` (dampen bad news in a winning streak) might be flat wrong for debugging contexts where a first regression after green days is exactly the signal we should escalate on.

### E3: No audit trail tying scaled priority to subsequent outcome

`rawPriority` is preserved per-SITREP but nothing aggregates across SITREPs to answer: "when scaling pushed priority up, did the subsequent executive action succeed more often than matched-priority unscaled turns?" Without that, we cannot prove scaling is adding signal rather than noise.

---

## Design

### C1 — Shadow-Mode Scaling (new mode)

Add `trajectory_scaling_mode` to `TrajectoryScalingConfig`:

```typescript
export type TrajectoryScalingMode = "off" | "shadow" | "live";

export interface TrajectoryScalingConfig {
  // ... existing fields ...
  mode: TrajectoryScalingMode; // replaces boolean `enabled`; default: "shadow" for 4 weeks, then "live"
}
```

- `off`: no computation, no log (same as current `enabled: false`).
- `shadow`: compute `rawPriority` and `scaledPriority`, log both, **use rawPriority downstream**. All gating, routing, and council decisions run on the unscaled number.
- `live`: current behavior (scaled priority overrides raw).

Migration (dual-field transition window):

- v2.0: both `enabled: boolean` and `mode: TrajectoryScalingMode` accepted at load; `mode` takes precedence when present; missing `mode` derives from `enabled` (`true` → `"live"`, `false` → `"off"`).
- v2.0 writes always emit `mode`; never strip `enabled` (keeps downgrade compatible).
- v2.1: `enabled` removed; any load of a PRIORITIES.json with only `enabled` migrates in-place with a one-time `_archivist_log` `migrated_trajectory_config` entry.
- New deployments default to `mode: "shadow"`.

### C2 — Scaling Audit Log (new file)

New append-only file `~/.openclaw/workspace/.trajectory-audit.jsonl`, one row per triage call:

```typescript
export interface TrajectoryAuditRow {
  timestamp: number;
  sitrepSummary: string; // truncated 80 chars
  rawPriority: number;
  scaledPriority: number;
  quadrant: "pos_pos" | "pos_neg" | "neg_pos" | "neg_neg" | "neutral";
  scaleApplied: number;
  domains: string[];
  avgTrajectory: number;
  mode: TrajectoryScalingMode;
  actionId?: string; // link to downstream ExpectedOutcome/ActualOutcome
}
```

Appended by `runTriage` wrapper in `index.ts` after `parseSITREP`. One row per SITREP regardless of mode.

### C3 — Trajectory Effectiveness Metric (new analysis)

New file `extensions/memory-ooda/trajectory-eval.ts`:

```typescript
export interface TrajectoryEvalReport {
  window: { days: number; rows: number };
  byQuadrant: Record<
    string,
    {
      rows: number;
      /** outcome rate on the scaled SITREPs in this quadrant */
      scaledSuccessRate: number;
      /** outcome rate on matched-raw-priority SITREPs from shadow mode */
      matchedBaselineSuccessRate: number;
      /** delta the scaling attributes to itself */
      lift: number;
    }
  >;
  verdict: "adopt_live" | "keep_shadow" | "revert_off";
  reason: string;
}

export function evaluateTrajectoryScaling(
  auditRows: TrajectoryAuditRow[],
  episodicEvents: EpisodicEvent[],
  config: TrajectoryScalingConfig,
): TrajectoryEvalReport;
```

Matching logic (the honest equal-budget baseline):

- For each live or shadow row R with `scaledPriority = p`, find all rows from shadow mode (or from history before v1 trajectory landed) with `rawPriority = p` — same priority, no scaling. These are the matched control.
- Compare downstream `outcome` distribution between treated and matched control. Lift = treatedSuccess - controlSuccess.
- Verdict rules:
  - `adopt_live`: every non-empty quadrant shows `lift > 0.05` on `>= 50` rows.
  - `keep_shadow`: any quadrant with `lift < 0`, or any quadrant with `< 50` rows.
  - `revert_off`: overall lift across all quadrants `< 0` on `>= 200` total rows.

### C4 — Per-Quadrant Calibration Tool (CLI)

New CLI subcommand `openclaw workspace trajectory calibrate` runs a grid search over scale factors against the audit log + episodic outcomes and reports the factor combination that maximizes lift per quadrant. Does **not** auto-write — emits a `PolicyProposal` of category `policy` that requires user approval (which then flows through the V2 admission gate from `CR_OODA_GROUNDED_EVAL_HARNESS_V2`).

Grid: `pos_pos ∈ [0.7, 1.0]` step 0.1, same ranges for others. Report top 5 combinations plus paper defaults for comparison.

### C5 — Equal-Budget Single-Agent Control

Add a `single_path_escalation` config to PRIORITIES.json thresholds:

```typescript
export interface PrioritiesFile {
  thresholds: {
    // ... existing ...
    /** Ablation mode: ignore scaling, instead decrement min_priority_for_full_ooda by N. */
    single_path_escalation_offset?: number; // default: undefined (disabled)
  };
}
```

When set, trajectory scaling is forced `off` and `min_priority_for_full_ooda` is reduced by `offset`. This is the matched-compute control: same expected full-OODA firing rate, no trajectory math. The evaluator (C3) uses rows collected under `single_path_escalation_offset` as the honest baseline when shadow rows are scarce.

### C6 — Index.ts Wiring + applyTrajectoryScaling Contract Fix

`index.ts` `before_agent_start` hook currently calls `applyTrajectoryScaling`. Change to:

```typescript
const rawSITREP = await runTriage(...);
const scaled = applyTrajectoryScaling(rawSITREP.sitrep, trajectories, cfg);
const effectiveSITREP = cfg.mode === "live" ? scaled : rawSITREP.sitrep;
appendTrajectoryAudit({ raw: rawSITREP.sitrep, scaled, mode: cfg.mode, ... });
```

**Contract change to `applyTrajectoryScaling`:** current `triage.ts:380` short-circuits with `if (clamped === rawPriority) return sitrep` — dropping the `rawPriority` annotation when the scale factor produces no change. Audit log requires both raw and scaled per row regardless of mode. Fix: always set `rawPriority` on the returned SITREP:

```typescript
// Before return, always preserve rawPriority for downstream audit:
return { ...sitrep, priority: clamped, rawPriority };
// when clamped === rawPriority, rawPriority === priority — still present, not undefined.
```

Existing tests that assert `rawPriority === undefined` on no-op path must be updated — this is the explicit contract change.

### C7 — Integrate with Grounded Harness V2

`CR_OODA_GROUNDED_EVAL_HARNESS_V2`'s distortion index consumes per-domain grounded metric. This CR's audit log feeds the same meta-reviewer. A `campbell_suspected` regime in any domain forces `mode = "off"` for that domain's trajectory scaling until operator clears.

---

## Acceptance Criteria

- [ ] `TrajectoryScalingMode` enum with migration path from boolean `enabled`.
- [ ] `.trajectory-audit.jsonl` append, with rotation at 50 MB.
- [ ] `trajectory-eval.ts` unit-tested against synthetic audit rows with known lifts.
- [ ] `openclaw workspace trajectory report` prints the per-quadrant lift table.
- [ ] `openclaw workspace trajectory calibrate` emits a PolicyProposal; does not auto-write scale factors.
- [ ] New installs default to `mode: "shadow"`. Existing installs with `enabled: true` migrate to `mode: "live"` with a one-time `_archivist_log` entry noting the migration.
- [ ] No trajectory-scaled priority reaches downstream phases when `mode !== "live"`.

---

## Risk and Open Questions

1. **Matched baseline scarcity.** Many priority values are rare in shadow data. For sparse buckets, the evaluator uses `single_path_escalation_offset` rows or falls back to `verdict: keep_shadow` with `reason: "insufficient_matched_control"`.
2. **Domain aliasing in trajectories.** `computeDomainTrajectories` uses `inferDomain` from `archivist.ts` (keyword matching). An observation mentioning "infrastructure" and "testing" gets the first-match domain, which can skew trajectory attribution. Out of scope for this CR — tracked separately.
3. **Switching `live → shadow` on regression.** The meta-reviewer can flip mode if `verdict: revert_off`. This is a SOUL.md-adjacent change and must go through the admission gate.
4. **Arxiv ID.** 2604.02460 verified (Tran and Kiela). AOD-CFR source originally cited under the DeepMind ID 2602.16928v2 in v1 CR — that ID format is suspect; verify and re-cite if necessary before merging this CR's prose.
