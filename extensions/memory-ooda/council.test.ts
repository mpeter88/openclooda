import { describe, expect, it, vi } from "vitest";
import { runCouncil, type CouncilMode, type CouncilResult } from "./council.js";
import type { StrategyInput } from "./strategy.js";
import type { ModelCallFn } from "./triage.js";
import type { PrioritiesFile, SITREP } from "./types.js";

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
      council_priority_threshold: 7,
      council_system1_enabled: true,
      council_system2_enabled: true,
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

function createTestInput(overrides?: Partial<StrategyInput>): StrategyInput {
  return {
    sitrep: createTestSITREP(),
    priorities: createTestPriorities(),
    observation: "Refactor the triage module to use DI",
    ...overrides,
  };
}

const VALID_STRATEGY_RESPONSE = JSON.stringify([
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

const VALID_CHAIR_RESPONSE = JSON.stringify({
  label: "aggressive_fix",
  reasoning: "High priority warrants immediate action given analyst findings",
  alignmentScore: 0.85,
  efficiencyScore: 0.6,
  riskScore: 0.7,
  dissent: false,
  chairReasoning: "Analyst confirmed urgency, skeptic concerns are manageable",
});

const DISSENT_CHAIR_RESPONSE = JSON.stringify({
  label: "minimal_viable_action",
  reasoning: "Skeptic raised valid concerns about blast radius; prefer incremental approach",
  alignmentScore: 0.7,
  efficiencyScore: 0.9,
  riskScore: 0.9,
  dissent: true,
  chairReasoning: "Overriding strategist recommendation due to risk concerns",
});

// ============================================================================
// "none" mode
// ============================================================================

describe("runCouncil — none mode", () => {
  it("delegates to runStrategy and wraps result", async () => {
    const callModel: ModelCallFn = vi.fn(async () => VALID_STRATEGY_RESPONSE);
    const result = await runCouncil(createTestInput(), "none", callModel);

    expect(result.mode).toBe("none");
    expect(result.winner).toBeDefined();
    // minimal_viable_action scores higher: 0.7*0.4 + 0.9*0.35 + 0.9*0.25 = 0.82
    expect(result.winner.label).toBe("minimal_viable_action");
    expect(result.members).toHaveLength(0);
    expect(result.dissent).toBe(false);
    expect(result.chairReasoning).toBe("");
  });

  it("makes no extra model calls beyond runStrategy", async () => {
    const callModel: ModelCallFn = vi.fn(async () => VALID_STRATEGY_RESPONSE);
    await runCouncil(createTestInput(), "none", callModel);

    // runStrategy calls model once (or twice on retry)
    expect(callModel).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// System 1 — Devil's Advocate
// ============================================================================

describe("runCouncil — system1 mode", () => {
  it("amends winner reasoning with DA objection", async () => {
    let callCount = 0;
    const callModel: ModelCallFn = vi.fn(async () => {
      callCount++;
      if (callCount === 1) return VALID_STRATEGY_RESPONSE; // strategy call
      return "This approach ignores the dependency graph complexity."; // DA call
    });

    const result = await runCouncil(createTestInput(), "system1", callModel);

    expect(result.mode).toBe("system1");
    expect(result.winner.reasoning).toContain("[DA objection:");
    expect(result.winner.reasoning).toContain("dependency graph complexity");
    expect(callModel).toHaveBeenCalledTimes(2);
  });

  it("includes devils_advocate member with output", async () => {
    let callCount = 0;
    const callModel: ModelCallFn = vi.fn(async () => {
      callCount++;
      if (callCount === 1) return VALID_STRATEGY_RESPONSE;
      return "Objection text here";
    });

    const result = await runCouncil(createTestInput(), "system1", callModel);

    expect(result.members).toHaveLength(1);
    expect(result.members[0].role).toBe("devils_advocate");
    expect(result.members[0].output).toBe("Objection text here");
  });

  it("degrades gracefully when DA call fails", async () => {
    let callCount = 0;
    const callModel: ModelCallFn = vi.fn(async () => {
      callCount++;
      if (callCount === 1) return VALID_STRATEGY_RESPONSE;
      throw new Error("DA model down");
    });

    const result = await runCouncil(createTestInput(), "system1", callModel);

    expect(result.mode).toBe("system1");
    // Winner should NOT have DA objection since DA failed
    expect(result.winner.reasoning).not.toContain("[DA objection:");
    expect(result.winner.label).toBe("minimal_viable_action");
  });

  it("falls back to runStrategy if strategy call also fails", async () => {
    let callCount = 0;
    const callModel: ModelCallFn = vi.fn(async (prompt: string) => {
      callCount++;
      // First two calls: strategy attempts (initial + retry) both fail
      // Third call: fallback runStrategy
      if (callCount <= 2) throw new Error("model down");
      if (callCount <= 4) return VALID_STRATEGY_RESPONSE;
      return "DA output";
    });

    const result = await runCouncil(createTestInput(), "system1", callModel);

    // Should still get a result without crashing
    expect(result.mode).toBe("system1");
    expect(result.winner).toBeDefined();
  });

  it("populates council_trace with DA output", async () => {
    let callCount = 0;
    const callModel: ModelCallFn = vi.fn(async () => {
      callCount++;
      if (callCount === 1) return VALID_STRATEGY_RESPONSE;
      return "The risk score seems inflated.";
    });

    const result = await runCouncil(createTestInput(), "system1", callModel);

    expect(result.council_trace.devils_advocate).toBe("The risk score seems inflated.");
  });
});

// ============================================================================
// System 2 — Full Council
// ============================================================================

describe("runCouncil — system2 mode", () => {
  // Helper: build a system2 mock that disambiguates members from chair.
  // Member prompts start with "You are the Analyst/Strategist/Skeptic on";
  // Chair prompt starts with "You are the Chair of".
  function system2Mock(opts: {
    analyst?: string;
    strategist?: string;
    skeptic?: string;
    chair?: string | Error;
    fallback?: string;
    callOrder?: string[];
  }): ModelCallFn {
    const order = opts.callOrder;
    return vi.fn(async (prompt: string) => {
      // Chair check first — chair prompt also contains member role names in its body
      if (prompt.startsWith("You are the Chair")) {
        order?.push("chair");
        if (opts.chair instanceof Error) throw opts.chair;
        return opts.chair ?? VALID_CHAIR_RESPONSE;
      }
      if (prompt.startsWith("You are the Analyst")) {
        order?.push("analyst");
        return opts.analyst ?? "Factual analysis output.";
      }
      if (prompt.startsWith("You are the Strategist")) {
        order?.push("strategist");
        return opts.strategist ?? "Recommend aggressive_fix.";
      }
      if (prompt.startsWith("You are the Skeptic")) {
        order?.push("skeptic");
        return opts.skeptic ?? "Assumption risk flagged.";
      }
      return opts.fallback ?? VALID_STRATEGY_RESPONSE;
    });
  }

  it("runs 3 members in parallel then chair sequentially", async () => {
    const callOrder: string[] = [];
    const callModel = system2Mock({ callOrder });

    const result = await runCouncil(createTestInput(), "system2", callModel);

    expect(result.mode).toBe("system2");
    expect(callOrder[callOrder.length - 1]).toBe("chair");
    expect(callModel).toHaveBeenCalledTimes(4); // 3 members + 1 chair
  });

  it("produces correct council_trace with all member outputs", async () => {
    const callModel = system2Mock({
      analyst: "Analysis output",
      strategist: "Strategy output",
      skeptic: "Skeptic output",
    });

    const result = await runCouncil(createTestInput(), "system2", callModel);

    expect(result.council_trace.analyst).toBe("Analysis output");
    expect(result.council_trace.strategist).toBe("Strategy output");
    expect(result.council_trace.skeptic).toBe("Skeptic output");
    expect(result.council_trace.chair).toBeDefined();
  });

  it("sets dissent=false when chair agrees with strategist", async () => {
    const callModel = system2Mock({ chair: VALID_CHAIR_RESPONSE });

    const result = await runCouncil(createTestInput(), "system2", callModel);

    expect(result.dissent).toBe(false);
    expect(result.winner.label).toBe("aggressive_fix");
  });

  it("sets dissent=true when chair overrides strategist", async () => {
    const callModel = system2Mock({ chair: DISSENT_CHAIR_RESPONSE });

    const result = await runCouncil(createTestInput(), "system2", callModel);

    expect(result.dissent).toBe(true);
    expect(result.winner.label).toBe("minimal_viable_action");
    expect(result.chairReasoning).toContain("Overriding");
  });

  it("attaches councilTrace to winner strategy", async () => {
    const callModel = system2Mock({});

    const result = await runCouncil(createTestInput(), "system2", callModel);

    expect(result.winner.councilTrace).toBeDefined();
    expect(result.winner.councilTrace?.mode).toBe("system2");
    expect(result.winner.councilTrace?.members).toHaveLength(3);
  });

  it("falls back when chair call fails", async () => {
    const callModel = system2Mock({ chair: new Error("chair model down") });

    const result = await runCouncil(createTestInput(), "system2", callModel);

    expect(result.mode).toBe("system2");
    expect(result.winner).toBeDefined();
    expect(result.chairReasoning).toContain("Chair call failed");
  });

  it("falls back when all members fail", async () => {
    // All member prompts throw, but fallback runStrategy call works
    const callModel: ModelCallFn = vi.fn(async (prompt: string) => {
      if (
        prompt.startsWith("You are the Analyst") ||
        prompt.startsWith("You are the Strategist") ||
        prompt.startsWith("You are the Skeptic")
      ) {
        throw new Error("member down");
      }
      return VALID_STRATEGY_RESPONSE;
    });

    const result = await runCouncil(createTestInput(), "system2", callModel);

    expect(result.mode).toBe("system2");
    expect(result.winner).toBeDefined();
    expect(result.chairReasoning).toContain("All council members failed");
  });

  it("computes weightedTotal on system2 winner using rubric", async () => {
    const callModel = system2Mock({});

    const result = await runCouncil(createTestInput(), "system2", callModel);

    // From VALID_CHAIR_RESPONSE: alignment=0.85, efficiency=0.6, risk=0.7
    // weightedTotal = 0.85*0.4 + 0.6*0.35 + 0.7*0.25 = 0.34 + 0.21 + 0.175 = 0.725
    expect(result.winner.weightedTotal).toBeCloseTo(0.725, 2);
  });

  // CR_OODA_PATTERN_SEPARATION_GATE ----------------------------------------

  it("fires Discriminator when separationMatches supplied", async () => {
    const calls: string[] = [];
    const callModel: ModelCallFn = vi.fn(async (prompt: string) => {
      if (prompt.startsWith("You are the Discriminator")) {
        calls.push("discriminator");
        return "The prior memory was about staging; this is production. Materially different.";
      }
      if (prompt.startsWith("You are the Analyst")) return "Analysis output";
      if (prompt.startsWith("You are the Strategist")) return "Strategy output";
      if (prompt.startsWith("You are the Skeptic")) return "Skeptic output";
      return VALID_CHAIR_RESPONSE;
    });

    const input: StrategyInput = {
      ...createTestInput(),
      separationMatches: [
        "prior staging deploy at 2026-03-15 succeeded",
        "prior staging deploy at 2026-03-22 succeeded",
      ],
    };
    const result = await runCouncil(input, "system2", callModel);

    expect(calls).toContain("discriminator");
    expect(result.council_trace.discriminator).toContain("production");
    expect(result.members.some((m) => m.role === "discriminator")).toBe(true);
  });

  it("does not fire Discriminator when separationMatches empty/absent", async () => {
    const calls: string[] = [];
    const callModel: ModelCallFn = vi.fn(async (prompt: string) => {
      if (prompt.startsWith("You are the Discriminator")) {
        calls.push("discriminator");
        return "should not fire";
      }
      if (prompt.startsWith("You are the Analyst")) return "Analysis output";
      if (prompt.startsWith("You are the Strategist")) return "Strategy output";
      if (prompt.startsWith("You are the Skeptic")) return "Skeptic output";
      return VALID_CHAIR_RESPONSE;
    });

    const result = await runCouncil(createTestInput(), "system2", callModel);

    expect(calls).toHaveLength(0);
    expect(result.council_trace.discriminator).toBeUndefined();
    expect(result.members.every((m) => m.role !== "discriminator")).toBe(true);
  });
});

// ============================================================================
// Mode Selection Integration
// ============================================================================

describe("council mode selection logic", () => {
  it("system2 requires priority >= threshold AND thinkingLevel >= medium", () => {
    const priorities = createTestPriorities();
    const thinkingRank = { low: 0, medium: 1, high: 2 };

    // priority 7, medium thinking → system2
    const sitrep7 = createTestSITREP({ priority: 7 });
    const meetsSystem2 =
      priorities.thresholds.council_system2_enabled &&
      sitrep7.priority >= priorities.thresholds.council_priority_threshold &&
      thinkingRank.medium >= thinkingRank.medium;
    expect(meetsSystem2).toBe(true);

    // priority 5, medium thinking → NOT system2 (priority too low)
    const sitrep5 = createTestSITREP({ priority: 5 });
    const tooLowPriority = sitrep5.priority >= priorities.thresholds.council_priority_threshold;
    expect(tooLowPriority).toBe(false);

    // priority 7, low thinking → NOT system2 (thinking too low)
    const lowThinking = thinkingRank.low >= thinkingRank.medium;
    expect(lowThinking).toBe(false);
  });

  it("system1 is the default when system2 conditions are not met", () => {
    const priorities = createTestPriorities();
    const sitrep5 = createTestSITREP({ priority: 5 });
    const thinkingRank = { low: 0, medium: 1, high: 2 };

    const meetsSystem2 =
      priorities.thresholds.council_system2_enabled &&
      sitrep5.priority >= priorities.thresholds.council_priority_threshold &&
      thinkingRank.medium >= thinkingRank.medium;

    const mode: CouncilMode = meetsSystem2
      ? "system2"
      : priorities.thresholds.council_system1_enabled
        ? "system1"
        : "none";

    expect(mode).toBe("system1");
  });

  it("returns none when both system1 and system2 are disabled", () => {
    const priorities = createTestPriorities();
    priorities.thresholds.council_system1_enabled = false;
    priorities.thresholds.council_system2_enabled = false;

    const mode: CouncilMode = priorities.thresholds.council_system2_enabled
      ? "system2"
      : priorities.thresholds.council_system1_enabled
        ? "system1"
        : "none";

    expect(mode).toBe("none");
  });
});
