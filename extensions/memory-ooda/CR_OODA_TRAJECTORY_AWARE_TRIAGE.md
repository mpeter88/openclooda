# CR: OODA Trajectory-Aware Triage — Asymmetric Signal Weighting

**Date:** 2026-04-17
**Status:** WRITTEN
**Priority:** HIGH — changes how every downstream OODA decision is made; small code surface, large behavioral impact
**Author:** Design session with michaelpeter
**Source:** DeepMind "Discovering Multiagent Learning Algorithms with LLMs" (2602.16928v2) — AOD-CFR asymmetric sign-dependent scaling

---

## Problem

Triage treats every incoming observation identically regardless of the project's recent trajectory. A first failure in a project that has been succeeding is weighted the same as a third consecutive failure in a project that is already declining. This is wrong — the signal content of an event depends on its context.

The current `runTriage` builds a SITREP with a scalar priority (1–10) based on the observation text matched against KNOWLEDGE.json facts and PRIORITIES.json domain weights. There is no trajectory input — the priority is purely a function of what the user said _right now_, not what has been happening over recent turns.

This means:

- A noise event in a winning streak can trigger a full OODA chain unnecessarily
- A critical signal in a losing streak can be underweighted because it looks routine in isolation
- The council/strategy phase receives no momentum context — it can't distinguish "first sign of trouble" from "third alarm on the same fire"

---

## Design

### Trajectory Signal Model

Inspired by AOD-CFR's asymmetric instantaneous regret scaling, which applies different multipliers depending on the combination of cumulative and instantaneous signs:

| Cumulative Trajectory | Current Signal       | Scaling | Rationale                                                             |
| --------------------- | -------------------- | ------- | --------------------------------------------------------------------- |
| positive (succeeding) | positive (good news) | 0.9×    | Reinforce but don't over-excite — things are already working          |
| positive (succeeding) | negative (bad news)  | 0.7×    | Dampen — likely noise against a strong trend. Flag but don't escalate |
| negative (failing)    | positive (good news) | 0.8×    | Be skeptical of reversals — one good signal doesn't erase a pattern   |
| negative (failing)    | negative (bad news)  | 1.3×    | Amplify — accelerate escalation. The trend is real, act on it         |

The scaling factors are configurable via PRIORITIES.json thresholds (not hardcoded magic numbers). The defaults above come from AOD-CFR's empirically-evolved values (1.1/0.9/0.7/1.2) adjusted for our 1–10 priority scale.

### Trajectory Computation

A project's "cumulative trajectory" is derived from its recent outcome labels in the episodic store:

```
trajectory = (successes - failures) / total_outcomes  // range: [-1.0, 1.0]
```

Computed over the last 30 days of events tagged with the project's domain. Positive trajectory = succeeding. Negative = failing. Near zero = mixed/uncertain.

The "current signal" polarity (positive/negative) is derived from the SITREP priority itself: ≤ 4 = positive (routine/good), ≥ 6 = negative (problem/escalation), 5 = neutral (no scaling).

---

## Changes Required

### C1 — `triage.ts` (MODIFY)

Add trajectory context to `TriageInput`:

```typescript
export interface TriageInput {
  observation: string;
  facts: KnowledgeFile;
  priorities: PrioritiesFile;
  /** Domain trajectory scores from recent outcome history. Key: domain name. */
  domainTrajectories?: Record<string, number>; // -1.0 to 1.0
}
```

Add `applyTrajectoryScaling()` — pure function, called after `parseSITREP`:

```typescript
export function applyTrajectoryScaling(
  sitrep: SITREP,
  trajectories: Record<string, number>,
  config: TrajectoryScalingConfig,
): SITREP;
```

This adjusts `sitrep.priority` based on the trajectory of the recommended domains:

1. For each `recommendedDomain`, look up its trajectory score
2. Determine the quadrant (cumulative +/-, current signal +/-)
3. Apply the corresponding scaling factor to the raw priority
4. Clamp to [1, 10], round to integer

The raw (unscaled) priority is preserved as `sitrep.rawPriority` for logging/debugging.

### C2 — `types.ts` (MODIFY)

Add to `SITREP`:

```typescript
export interface SITREP {
  priority: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
  /** Priority before trajectory scaling (for debugging/logging). */
  rawPriority?: number;
  summary: string;
  conflictsDetected: string[];
  relevantFacts: string[];
  recommendedDomains: string[];
  attention?: string;
}
```

Add to `PrioritiesFile.thresholds`:

```typescript
export interface TrajectoryScalingConfig {
  enabled: boolean; // default: true
  pos_pos_scale: number; // default: 0.9
  pos_neg_scale: number; // default: 0.7
  neg_pos_scale: number; // default: 0.8
  neg_neg_scale: number; // default: 1.3
  trajectory_window_days: number; // default: 30
  min_outcomes_for_trajectory: number; // default: 3
}
```

### C3 — `index.ts` (MODIFY)

In `before_agent_start`, before calling `runTriage`:

1. Query the episodic store for recent outcome-labeled events (last N days)
2. Group by `inferDomain()` (reuse from `archivist.ts`)
3. Compute trajectory score per domain: `(successes - failures) / total`
4. Pass as `domainTrajectories` in `TriageInput`

After `runTriage` returns:

1. Call `applyTrajectoryScaling(sitrep, trajectories, config)`
2. Use the scaled SITREP for all downstream decisions (shouldRunFullOODA, strategy, council)

### C4 — `archivist.ts` (NO CHANGE)

`inferDomain()` is already exported at line 404. No modification needed — triage can import it directly.

### C5 — Tests

- `triage.test.ts`: add tests for `applyTrajectoryScaling()` covering all four quadrants, neutral case, clamping, and the min_outcomes threshold
- `index.ts` integration: verify trajectory is passed through and scaling is applied

---

## Verification

1. Send a message about a domain with a positive trajectory (e.g., AMF after a successful run). Observe that routine observations get dampened and problem signals get dampened (skeptical of noise).
2. Send a message about a domain with a negative trajectory (e.g., a project with recent failures). Observe that problem signals get amplified and the full OODA chain fires more readily.
3. Check `sitrep.rawPriority` vs `sitrep.priority` in the debug output (`debugMode: "inline"`) to confirm scaling is applied.

---

## Non-Goals

- This CR does NOT change the LLM prompt for triage — the model still produces its own priority assessment. Trajectory scaling is a post-hoc adjustment, not a prompt modification. This keeps the triage model stateless and testable.
- This CR does NOT change domain weights in PRIORITIES.json — trajectory is orthogonal to domain importance. A high-weight domain with a positive trajectory still gets dampened on noise.
