import { describe, expect, it } from "vitest";
import {
  scoreStrategies,
  scoreStrategy,
  selectBestStrategy,
  validateDomainWeights,
  validateRubric,
  type ScoringRubric,
  type UnscoredStrategy,
} from "./valuation-engine.js";

// ============================================================================
// Fixtures
// ============================================================================

const DEFAULT_RUBRIC: ScoringRubric = {
  alignment: { weight: 0.4 },
  efficiency: { weight: 0.35 },
  risk: { weight: 0.25 },
};

function makeStrategy(overrides?: Partial<UnscoredStrategy>): UnscoredStrategy {
  return {
    label: "test_strategy",
    reasoning: "test reasoning",
    alignmentScore: 0.8,
    efficiencyScore: 0.7,
    riskScore: 0.9,
    ...overrides,
  };
}

// ============================================================================
// validateRubric
// ============================================================================

describe("validateRubric", () => {
  it("accepts valid rubric summing to 1.0", () => {
    expect(() => validateRubric(DEFAULT_RUBRIC)).not.toThrow();
  });

  it("accepts rubric within tolerance (0.001)", () => {
    expect(() =>
      validateRubric({
        alignment: { weight: 0.4 },
        efficiency: { weight: 0.35 },
        risk: { weight: 0.2501 },
      }),
    ).not.toThrow();
  });

  it("rejects rubric that doesn't sum to 1.0", () => {
    expect(() =>
      validateRubric({
        alignment: { weight: 0.5 },
        efficiency: { weight: 0.5 },
        risk: { weight: 0.5 },
      }),
    ).toThrow("must sum to 1.0");
  });

  it("rejects zero weight", () => {
    expect(() =>
      validateRubric({
        alignment: { weight: 0 },
        efficiency: { weight: 0.6 },
        risk: { weight: 0.4 },
      }),
    ).toThrow("must be in (0, 1]");
  });

  it("rejects negative weight", () => {
    expect(() =>
      validateRubric({
        alignment: { weight: -0.1 },
        efficiency: { weight: 0.6 },
        risk: { weight: 0.5 },
      }),
    ).toThrow("must be in (0, 1]");
  });

  it("rejects NaN weight", () => {
    expect(() =>
      validateRubric({
        alignment: { weight: NaN },
        efficiency: { weight: 0.6 },
        risk: { weight: 0.4 },
      }),
    ).toThrow("must be a number");
  });
});

// ============================================================================
// validateDomainWeights
// ============================================================================

describe("validateDomainWeights", () => {
  it("accepts valid domain weights", () => {
    expect(() =>
      validateDomainWeights({
        core: { weight: 0.8, description: "", examples: [], approval_count: 0, override_count: 0 },
        ops: { weight: 0.1, description: "", examples: [], approval_count: 0, override_count: 0 },
      }),
    ).not.toThrow();
  });

  it("rejects weight below 0.1", () => {
    expect(() =>
      validateDomainWeights({
        bad: { weight: 0.05, description: "", examples: [], approval_count: 0, override_count: 0 },
      }),
    ).toThrow('domain "bad" weight must be in [0.1, 1.0]');
  });

  it("rejects weight above 1.0", () => {
    expect(() =>
      validateDomainWeights({
        bad: { weight: 1.5, description: "", examples: [], approval_count: 0, override_count: 0 },
      }),
    ).toThrow('domain "bad" weight must be in [0.1, 1.0]');
  });

  it("accepts empty domains", () => {
    expect(() => validateDomainWeights({})).not.toThrow();
  });
});

// ============================================================================
// scoreStrategy
// ============================================================================

describe("scoreStrategy", () => {
  it("computes V = Σ(Si × Wi)", () => {
    const strategy = makeStrategy({
      alignmentScore: 0.8,
      efficiencyScore: 0.6,
      riskScore: 1.0,
    });
    const scored = scoreStrategy(strategy, DEFAULT_RUBRIC);

    // V = 0.8*0.4 + 0.6*0.35 + 1.0*0.25 = 0.32 + 0.21 + 0.25 = 0.78
    expect(scored.weightedTotal).toBeCloseTo(0.78, 4);
  });

  it("clamps scores above 1.0", () => {
    const strategy = makeStrategy({
      alignmentScore: 1.5,
      efficiencyScore: 2.0,
      riskScore: 1.0,
    });
    const scored = scoreStrategy(strategy, DEFAULT_RUBRIC);

    expect(scored.alignmentScore).toBe(1.0);
    expect(scored.efficiencyScore).toBe(1.0);
    // V = 1.0*0.4 + 1.0*0.35 + 1.0*0.25 = 1.0
    expect(scored.weightedTotal).toBeCloseTo(1.0, 4);
  });

  it("clamps scores below 0.0", () => {
    const strategy = makeStrategy({
      alignmentScore: -0.5,
      efficiencyScore: 0.0,
      riskScore: 0.5,
    });
    const scored = scoreStrategy(strategy, DEFAULT_RUBRIC);

    expect(scored.alignmentScore).toBe(0);
    expect(scored.efficiencyScore).toBe(0);
    // V = 0*0.4 + 0*0.35 + 0.5*0.25 = 0.125
    expect(scored.weightedTotal).toBeCloseTo(0.125, 4);
  });

  it("preserves label and reasoning", () => {
    const strategy = makeStrategy({ label: "aggressive_fix", reasoning: "ship it now" });
    const scored = scoreStrategy(strategy, DEFAULT_RUBRIC);
    expect(scored.label).toBe("aggressive_fix");
    expect(scored.reasoning).toBe("ship it now");
  });
});

// ============================================================================
// scoreStrategies
// ============================================================================

describe("scoreStrategies", () => {
  it("returns strategies sorted by weightedTotal descending", () => {
    const candidates: UnscoredStrategy[] = [
      makeStrategy({ label: "low", alignmentScore: 0.2, efficiencyScore: 0.2, riskScore: 0.2 }),
      makeStrategy({ label: "high", alignmentScore: 0.9, efficiencyScore: 0.9, riskScore: 0.9 }),
      makeStrategy({ label: "mid", alignmentScore: 0.5, efficiencyScore: 0.5, riskScore: 0.5 }),
    ];

    const scored = scoreStrategies(candidates, DEFAULT_RUBRIC);
    expect(scored[0].label).toBe("high");
    expect(scored[1].label).toBe("mid");
    expect(scored[2].label).toBe("low");
  });

  it("validates rubric before scoring", () => {
    const badRubric: ScoringRubric = {
      alignment: { weight: 0.5 },
      efficiency: { weight: 0.5 },
      risk: { weight: 0.5 },
    };
    expect(() => scoreStrategies([makeStrategy()], badRubric)).toThrow("must sum to 1.0");
  });

  it("handles empty candidates", () => {
    const scored = scoreStrategies([], DEFAULT_RUBRIC);
    expect(scored).toEqual([]);
  });
});

// ============================================================================
// selectBestStrategy
// ============================================================================

describe("selectBestStrategy", () => {
  it("returns the highest-scoring strategy", () => {
    const candidates: UnscoredStrategy[] = [
      makeStrategy({ label: "weak", alignmentScore: 0.1, efficiencyScore: 0.1, riskScore: 0.1 }),
      makeStrategy({ label: "strong", alignmentScore: 1.0, efficiencyScore: 1.0, riskScore: 1.0 }),
    ];

    const best = selectBestStrategy(candidates, DEFAULT_RUBRIC);
    expect(best?.label).toBe("strong");
    expect(best?.weightedTotal).toBeCloseTo(1.0, 4);
  });

  it("returns undefined for empty candidates", () => {
    const best = selectBestStrategy([], DEFAULT_RUBRIC);
    expect(best).toBeUndefined();
  });

  it("breaks ties deterministically (first inserted wins via stable sort)", () => {
    const candidates: UnscoredStrategy[] = [
      makeStrategy({ label: "first", alignmentScore: 0.5, efficiencyScore: 0.5, riskScore: 0.5 }),
      makeStrategy({ label: "second", alignmentScore: 0.5, efficiencyScore: 0.5, riskScore: 0.5 }),
    ];

    const best = selectBestStrategy(candidates, DEFAULT_RUBRIC);
    expect(best?.label).toBe("first");
  });
});
