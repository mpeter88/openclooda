import { describe, expect, it, vi } from "vitest";
import type { PrioritiesFile, SITREP } from "../../../extensions/memory-ooda/types.js";
import {
  buildStrategyPrompt,
  createDefaultStrategy,
  parseStrategyCandidates,
  runStrategy,
  type StrategyInput,
} from "./strategy.js";
import type { ModelCallFn } from "./triage.js";

// ============================================================================
// Fixtures
// ============================================================================

function createTestPriorities(): PrioritiesFile {
  return {
    _meta: {
      version: 1,
      updated_at: new Date().toISOString(),
      updated_by: "user",
      description: "Test",
    },
    domains: {
      core_project: {
        weight: 0.8,
        description: "Primary project work",
        examples: ["coding"],
        approval_count: 0,
        override_count: 0,
      },
    },
    strategy_labels: [
      { label: "aggressive_fix", description: "Act immediately" },
      { label: "minimal_viable_action", description: "Smallest unblocking step" },
    ],
    scoring_rubric: {
      alignment: { weight: 0.4, description: "Match with goals" },
      efficiency: { weight: 0.35, description: "Token cost vs value" },
      risk: { weight: 0.25, description: "Side-effect potential" },
    },
    thresholds: {
      min_priority_for_full_ooda: 5,
      min_thinking_level_for_full_ooda: "medium",
      critical_failure_score_floor: 0.3,
      archivist_turn_interval: 100,
      meta_reviewer_weekly_enabled: false,
    },
    _weight_adjustment_log: [],
  };
}

function createTestSITREP(overrides?: Partial<SITREP>): SITREP {
  return {
    priority: 7,
    summary: "User requests a code refactor",
    conflictsDetected: [],
    relevantFacts: ["stack.openclaw"],
    recommendedDomains: ["core_project"],
    ...overrides,
  };
}

function createTestInput(): StrategyInput {
  return {
    sitrep: createTestSITREP(),
    priorities: createTestPriorities(),
    observation: "Refactor the triage module to use DI",
  };
}

const VALID_MODEL_RESPONSE = JSON.stringify([
  {
    label: "aggressive_fix",
    reasoning: "High priority refactor — do it now",
    alignmentScore: 0.9,
    efficiencyScore: 0.6,
    riskScore: 0.7,
  },
  {
    label: "minimal_viable_action",
    reasoning: "Extract interface first, refactor later",
    alignmentScore: 0.7,
    efficiencyScore: 0.9,
    riskScore: 0.9,
  },
]);

// ============================================================================
// createDefaultStrategy
// ============================================================================

describe("createDefaultStrategy", () => {
  it("returns minimal_viable_action with moderate scores", () => {
    const sitrep = createTestSITREP();
    const strategy = createDefaultStrategy(sitrep);
    expect(strategy.label).toBe("minimal_viable_action");
    expect(strategy.alignmentScore).toBe(0.5);
    expect(strategy.efficiencyScore).toBe(0.7);
    expect(strategy.riskScore).toBe(0.8);
  });

  it("includes priority and summary in reasoning", () => {
    const sitrep = createTestSITREP({ priority: 9, summary: "Production is down" });
    const strategy = createDefaultStrategy(sitrep);
    expect(strategy.reasoning).toContain("priority-9");
    expect(strategy.reasoning).toContain("Production is down");
  });
});

// ============================================================================
// buildStrategyPrompt
// ============================================================================

describe("buildStrategyPrompt", () => {
  it("includes SITREP details", () => {
    const prompt = buildStrategyPrompt(createTestInput());
    expect(prompt).toContain("Priority: 7/10");
    expect(prompt).toContain("User requests a code refactor");
  });

  it("includes observation truncated to 500 chars", () => {
    const input = createTestInput();
    input.observation = "x".repeat(800);
    const prompt = buildStrategyPrompt(input);
    // Should contain the first 500 chars, not all 800
    expect(prompt).not.toContain("x".repeat(800));
    expect(prompt).toContain("x".repeat(500));
  });

  it("includes strategy archetypes", () => {
    const prompt = buildStrategyPrompt(createTestInput());
    expect(prompt).toContain("aggressive_fix");
    expect(prompt).toContain("minimal_viable_action");
  });

  it("includes domain weights", () => {
    const prompt = buildStrategyPrompt(createTestInput());
    expect(prompt).toContain("core_project (weight=0.8)");
  });

  it("includes scoring axis weights", () => {
    const prompt = buildStrategyPrompt(createTestInput());
    expect(prompt).toContain("alignment (weight=0.4)");
    expect(prompt).toContain("efficiency (weight=0.35)");
    expect(prompt).toContain("risk (weight=0.25)");
  });

  it("includes scoring calibration scale", () => {
    const prompt = buildStrategyPrompt(createTestInput());
    expect(prompt).toContain("0.0-0.2: Poor fit");
    expect(prompt).toContain("0.9-1.0: Excellent fit");
  });

  it("includes differentiation constraint", () => {
    const prompt = buildStrategyPrompt(createTestInput());
    expect(prompt).toContain("at least one axis per strategy scores below 0.5");
  });

  it("includes unique archetype constraint", () => {
    const prompt = buildStrategyPrompt(createTestInput());
    expect(prompt).toContain("different archetype label");
  });

  it("includes few-shot example", () => {
    const prompt = buildStrategyPrompt(createTestInput());
    expect(prompt).toContain("## Example");
    expect(prompt).toContain("aggressive_fix");
    expect(prompt).toContain("minimal_viable_action");
  });

  it("includes CoT nudge", () => {
    const prompt = buildStrategyPrompt(createTestInput());
    expect(prompt).toContain("First consider which archetypes best fit");
  });

  it("uses improved output format language", () => {
    const prompt = buildStrategyPrompt(createTestInput());
    expect(prompt).toContain("Respond with raw JSON only");
    expect(prompt).toContain("Do not wrap in code fences");
  });

  it("includes never_do as hard constraints when present", () => {
    const input = createTestInput();
    input.neverDo = ["delete production data", "merge without review"];
    const prompt = buildStrategyPrompt(input);
    expect(prompt).toContain("Hard Constraints");
    expect(prompt).toContain("delete production data; merge without review");
    expect(prompt).toContain("score 0.0 on alignment");
  });

  it("omits hard constraints section when neverDo is empty", () => {
    const input = createTestInput();
    input.neverDo = [];
    const prompt = buildStrategyPrompt(input);
    expect(prompt).not.toContain("Hard Constraints");
  });

  it("omits hard constraints section when neverDo is undefined", () => {
    const prompt = buildStrategyPrompt(createTestInput());
    expect(prompt).not.toContain("Hard Constraints");
  });

  it("includes JSON schema instructions", () => {
    const prompt = buildStrategyPrompt(createTestInput());
    expect(prompt).toContain('"label"');
    expect(prompt).toContain('"reasoning"');
    expect(prompt).toContain('"alignmentScore"');
  });
});

// ============================================================================
// parseStrategyCandidates
// ============================================================================

describe("parseStrategyCandidates", () => {
  it("parses valid strategy array", () => {
    const candidates = parseStrategyCandidates(VALID_MODEL_RESPONSE);
    expect(candidates).toHaveLength(2);
    expect(candidates[0].label).toBe("aggressive_fix");
    expect(candidates[1].label).toBe("minimal_viable_action");
    expect(candidates[0].alignmentScore).toBe(0.9);
  });

  it("strips markdown code fences", () => {
    const wrapped = "```json\n" + VALID_MODEL_RESPONSE + "\n```";
    const candidates = parseStrategyCandidates(wrapped);
    expect(candidates).toHaveLength(2);
  });

  it("rejects non-array response", () => {
    expect(() => parseStrategyCandidates('{"label": "test"}')).toThrow("must be a JSON array");
  });

  it("rejects empty array (M1)", () => {
    expect(() => parseStrategyCandidates("[]")).toThrow("Expected 2-4 strategies, got 0");
  });

  it("rejects single strategy (M1)", () => {
    const one = JSON.stringify([
      {
        label: "fix",
        reasoning: "test",
        alignmentScore: 0.5,
        efficiencyScore: 0.5,
        riskScore: 0.5,
      },
    ]);
    expect(() => parseStrategyCandidates(one)).toThrow("Expected 2-4 strategies, got 1");
  });

  it("rejects more than 4 strategies (M1)", () => {
    const five = Array.from({ length: 5 }, (_, i) => ({
      label: `s${i}`,
      reasoning: "test",
      alignmentScore: 0.5,
      efficiencyScore: 0.5,
      riskScore: 0.5,
    }));
    expect(() => parseStrategyCandidates(JSON.stringify(five))).toThrow(
      "Expected 2-4 strategies, got 5",
    );
  });

  it("rejects out-of-range scores (M2)", () => {
    const bad = JSON.stringify([
      { label: "a", reasoning: "r", alignmentScore: 1.5, efficiencyScore: 0.5, riskScore: 0.5 },
      { label: "b", reasoning: "r", alignmentScore: 0.5, efficiencyScore: 0.5, riskScore: 0.5 },
    ]);
    expect(() => parseStrategyCandidates(bad)).toThrow("alignmentScore must be a number in [0, 1]");
  });

  it("rejects negative scores (M2)", () => {
    const bad = JSON.stringify([
      { label: "a", reasoning: "r", alignmentScore: 0.5, efficiencyScore: -0.1, riskScore: 0.5 },
      { label: "b", reasoning: "r", alignmentScore: 0.5, efficiencyScore: 0.5, riskScore: 0.5 },
    ]);
    expect(() => parseStrategyCandidates(bad)).toThrow(
      "efficiencyScore must be a number in [0, 1]",
    );
  });

  it("rejects missing label", () => {
    const bad = JSON.stringify([
      { reasoning: "test", alignmentScore: 0.5, efficiencyScore: 0.5, riskScore: 0.5 },
      { label: "b", reasoning: "r", alignmentScore: 0.5, efficiencyScore: 0.5, riskScore: 0.5 },
    ]);
    expect(() => parseStrategyCandidates(bad)).toThrow("non-empty label");
  });

  it("rejects missing reasoning", () => {
    const bad = JSON.stringify([
      { label: "test", alignmentScore: 0.5, efficiencyScore: 0.5, riskScore: 0.5 },
      { label: "b", reasoning: "r", alignmentScore: 0.5, efficiencyScore: 0.5, riskScore: 0.5 },
    ]);
    expect(() => parseStrategyCandidates(bad)).toThrow("non-empty reasoning");
  });

  it("rejects non-numeric scores", () => {
    const bad = JSON.stringify([
      {
        label: "test",
        reasoning: "test",
        alignmentScore: "high",
        efficiencyScore: 0.5,
        riskScore: 0.5,
      },
      { label: "b", reasoning: "r", alignmentScore: 0.5, efficiencyScore: 0.5, riskScore: 0.5 },
    ]);
    expect(() => parseStrategyCandidates(bad)).toThrow("alignmentScore must be a number in [0, 1]");
  });

  it("rejects invalid JSON", () => {
    expect(() => parseStrategyCandidates("not json")).toThrow();
  });
});

// ============================================================================
// runStrategy
// ============================================================================

describe("runStrategy", () => {
  it("returns scored and sorted strategies on success", async () => {
    const callModel: ModelCallFn = vi.fn(async () => VALID_MODEL_RESPONSE);
    const result = await runStrategy(createTestInput(), callModel);

    expect(result.fromFallback).toBe(false);
    expect(result.candidates).toHaveLength(2);
    // Winner should be the one with higher weightedTotal
    expect(result.winner).toBeDefined();
    expect(result.winner.weightedTotal).toBeGreaterThan(0);
    // Candidates should be sorted desc
    expect(result.candidates[0].weightedTotal).toBeGreaterThanOrEqual(
      result.candidates[1].weightedTotal,
    );
  });

  it("the winner has the highest score", async () => {
    const callModel: ModelCallFn = vi.fn(async () => VALID_MODEL_RESPONSE);
    const result = await runStrategy(createTestInput(), callModel);
    expect(result.winner).toBe(result.candidates[0]);
  });

  it("retries on malformed JSON and succeeds", async () => {
    let calls = 0;
    const callModel: ModelCallFn = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return "bad json";
      }
      return VALID_MODEL_RESPONSE;
    });

    const result = await runStrategy(createTestInput(), callModel);
    expect(result.fromFallback).toBe(false);
    expect(callModel).toHaveBeenCalledTimes(2);
  });

  it("falls back to default strategy after all retries fail", async () => {
    const callModel: ModelCallFn = vi.fn(async () => "garbage");
    const result = await runStrategy(createTestInput(), callModel);

    expect(result.fromFallback).toBe(true);
    expect(result.winner.label).toBe("minimal_viable_action");
    expect(result.candidates).toHaveLength(1);
    expect(callModel).toHaveBeenCalledTimes(2); // initial + 1 retry
  });

  it("falls back on model throwing", async () => {
    const callModel: ModelCallFn = vi.fn(async () => {
      throw new Error("model down");
    });
    const result = await runStrategy(createTestInput(), callModel);
    expect(result.fromFallback).toBe(true);
  });

  it("respects maxRetries=0", async () => {
    const callModel: ModelCallFn = vi.fn(async () => "bad");
    const result = await runStrategy(createTestInput(), callModel, { maxRetries: 0 });

    expect(result.fromFallback).toBe(true);
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  it("scores candidates correctly with the rubric", async () => {
    // Return strategies with known scores
    const response = JSON.stringify([
      {
        label: "aggressive_fix",
        reasoning: "go",
        alignmentScore: 1.0,
        efficiencyScore: 0.0,
        riskScore: 0.0,
      },
      {
        label: "minimal_viable_action",
        reasoning: "wait",
        alignmentScore: 0.0,
        efficiencyScore: 1.0,
        riskScore: 0.0,
      },
    ]);
    const callModel: ModelCallFn = vi.fn(async () => response);
    const result = await runStrategy(createTestInput(), callModel);

    // aggressive: V = 1.0*0.4 + 0*0.35 + 0*0.25 = 0.4
    // minimal: V = 0*0.4 + 1.0*0.35 + 0*0.25 = 0.35
    const aggressive = result.candidates.find((c) => c.label === "aggressive_fix");
    const minimal = result.candidates.find((c) => c.label === "minimal_viable_action");

    expect(aggressive?.weightedTotal).toBeCloseTo(0.4, 4);
    expect(minimal?.weightedTotal).toBeCloseTo(0.35, 4);
    expect(result.winner.label).toBe("aggressive_fix");
  });
});
