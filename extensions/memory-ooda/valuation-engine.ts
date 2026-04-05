/**
 * OODA VALUATION_ENGINE
 *
 * Scores candidate strategies using the formula: V = Σ(Si × Wi)
 * where Si is the per-axis score and Wi is the axis weight from
 * the scoring rubric in PRIORITIES.json.
 *
 * The rubric weights (alignment/efficiency/risk) are fixed by the
 * user and never auto-adjusted. Domain weights influence strategy
 * generation but not the valuation formula directly.
 */

import type { DomainOutcomeStats, PrioritiesFile, Strategy } from "./types.js";

// ============================================================================
// Types
// ============================================================================

export interface ScoringRubric {
  alignment: { weight: number };
  efficiency: { weight: number };
  risk: { weight: number };
}

/** A strategy before scoring (raw axis scores only). */
export interface UnscoredStrategy {
  label: string;
  reasoning: string;
  alignmentScore: number;
  efficiencyScore: number;
  riskScore: number;
}

// ============================================================================
// Validation
// ============================================================================

const WEIGHT_SUM_TOLERANCE = 0.001;

/**
 * Assert that rubric weights sum to 1.0 (±0.001) and each is in (0, 1].
 * Throws with an actionable error message on failure.
 */
export function validateRubric(rubric: ScoringRubric): void {
  const weights = [rubric.alignment.weight, rubric.efficiency.weight, rubric.risk.weight];

  for (const w of weights) {
    if (typeof w !== "number" || Number.isNaN(w)) {
      throw new Error(`VALUATION_ENGINE: rubric weight must be a number, got ${String(w)}`);
    }
    if (w <= 0 || w > 1) {
      throw new Error(
        `VALUATION_ENGINE: rubric weight must be in (0, 1], got ${w}. ` +
          `Check scoring_rubric in PRIORITIES.json.`,
      );
    }
  }

  const sum = weights.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1.0) > WEIGHT_SUM_TOLERANCE) {
    throw new Error(
      `VALUATION_ENGINE: scoring_rubric weights must sum to 1.0, got ${sum.toFixed(4)}. ` +
        `Current: alignment=${rubric.alignment.weight}, efficiency=${rubric.efficiency.weight}, risk=${rubric.risk.weight}`,
    );
  }
}

/**
 * Assert all domain weights are in [0.1, 1.0].
 */
export function validateDomainWeights(domains: PrioritiesFile["domains"]): void {
  for (const [name, entry] of Object.entries(domains)) {
    if (typeof entry.weight !== "number" || Number.isNaN(entry.weight)) {
      throw new Error(
        `VALUATION_ENGINE: domain "${name}" weight must be a number, got ${String(entry.weight)}`,
      );
    }
    if (entry.weight < 0.1 || entry.weight > 1.0) {
      throw new Error(
        `VALUATION_ENGINE: domain "${name}" weight must be in [0.1, 1.0], got ${entry.weight}`,
      );
    }
  }
}

// ============================================================================
// Scoring
// ============================================================================

/**
 * Clamp a score to [0, 1].
 */
function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Score a single strategy: V = Σ(Si × Wi)
 */
export function scoreStrategy(strategy: UnscoredStrategy, rubric: ScoringRubric): Strategy {
  const alignment = clamp01(strategy.alignmentScore) * rubric.alignment.weight;
  const efficiency = clamp01(strategy.efficiencyScore) * rubric.efficiency.weight;
  const risk = clamp01(strategy.riskScore) * rubric.risk.weight;

  return {
    ...strategy,
    alignmentScore: clamp01(strategy.alignmentScore),
    efficiencyScore: clamp01(strategy.efficiencyScore),
    riskScore: clamp01(strategy.riskScore),
    weightedTotal: alignment + efficiency + risk,
  };
}

/**
 * Score all candidate strategies and return them sorted by weightedTotal (desc).
 * Validates the rubric before scoring.
 */
export function scoreStrategies(candidates: UnscoredStrategy[], rubric: ScoringRubric): Strategy[] {
  validateRubric(rubric);

  return candidates
    .map((c) => scoreStrategy(c, rubric))
    .toSorted((a, b) => b.weightedTotal - a.weightedTotal);
}

/**
 * Select the highest-scoring strategy from candidates.
 * Returns undefined if no candidates are provided.
 */
export function selectBestStrategy(
  candidates: UnscoredStrategy[],
  rubric: ScoringRubric,
): Strategy | undefined {
  const scored = scoreStrategies(candidates, rubric);
  return scored[0];
}

// ============================================================================
// V4: Rubric Calibration Diagnostic
// ============================================================================

/** A strategy paired with its outcome for rubric calibration analysis. */
export interface StrategyOutcome {
  strategy: Strategy;
  outcome: "success" | "failure" | "partial";
}

/**
 * Analyze which scoring axis most often led to selecting strategies that
 * later failed. Returns a diagnostic string for the SITREP attention field,
 * or null if insufficient data (< 3 data points).
 *
 * Logic: for each failed strategy, identify the axis with the highest score
 * (the axis that "pulled" the strategy into selection). If one axis dominates
 * failures, it may be over-indexed.
 */
export function calibrateRubric(outcomes: StrategyOutcome[]): string | null {
  const failures = outcomes.filter((o) => o.outcome === "failure");
  if (failures.length < 3) return null;

  const axisCounts: Record<string, number> = { alignment: 0, efficiency: 0, risk: 0 };

  for (const { strategy } of failures) {
    const scores: Array<[string, number]> = [
      ["alignment", strategy.alignmentScore],
      ["efficiency", strategy.efficiencyScore],
      ["risk", strategy.riskScore],
    ];
    // Find the axis with the highest score on the failed strategy
    scores.sort((a, b) => b[1] - a[1]);
    const dominantAxis = scores[0][0];
    axisCounts[dominantAxis]++;
  }

  // Find the axis that dominates failures
  const entries = Object.entries(axisCounts).sort((a, b) => b[1] - a[1]);
  const [topAxis, topCount] = entries[0];
  const totalFailures = failures.length;

  // Only surface if one axis accounts for majority of failures
  if (topCount >= Math.ceil(totalFailures * 0.6)) {
    const otherAxis = entries.filter(([a]) => a !== topAxis).map(([a]) => a);
    const lowAxes = otherAxis.filter((a) => {
      // Check if this axis was consistently low on failed strategies
      const avgScore =
        failures.reduce((sum, f) => {
          const key = `${a}Score` as keyof Strategy;
          return sum + (f.strategy[key] as number);
        }, 0) / totalFailures;
      return avgScore < 0.5;
    });

    const lowAxesNote = lowAxes.length > 0 ? `, low-${lowAxes.join("/")}` : "";
    return `${topAxis} weighting appears over-indexed — ${topCount}/${totalFailures} recent failures were high-${topAxis}${lowAxesNote} strategies`;
  }

  return null;
}
