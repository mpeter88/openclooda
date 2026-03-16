import { describe, expect, it, vi } from "vitest";
import {
  adjustWeights,
  buildPolicyReviewPrompt,
  calculateWeightAdjustment,
  classifyFailureSeverity,
  parseProposals,
  runMetaReviewer,
  shouldTriggerPolicyReview,
  type PrioritiesStore,
  type ProposalStore,
} from "./meta-reviewer.js";
import type { ModelCallFn } from "./triage.js";
import type {
  ActualOutcome,
  CriticalFailureEvent,
  DomainEntry,
  ExpectedOutcome,
  PolicyProposal,
  PrioritiesFile,
} from "./types.js";

// ============================================================================
// Fixtures
// ============================================================================

function createTestExpectedOutcome(overrides?: Partial<ExpectedOutcome>): ExpectedOutcome {
  return {
    actionId: "action-001",
    description: "Deploy staging environment",
    successSignal: "Deployment completes with HTTP 200",
    failureSignal: "Deployment fails or times out",
    domain: "operations",
    ...overrides,
  };
}

function createTestActualOutcome(overrides?: Partial<ActualOutcome>): ActualOutcome {
  return {
    source: "tool_result",
    success: false,
    toolName: "deploy",
    summary: "Deployment failed: timeout after 120s",
    ...overrides,
  } as ActualOutcome;
}

function createTestFailure(overrides?: Partial<CriticalFailureEvent>): CriticalFailureEvent {
  return {
    type: "criticalFailure",
    timestamp: "2026-03-16T12:00:00Z",
    actionId: "action-001",
    expectedOutcome: createTestExpectedOutcome(),
    actualOutcome: createTestActualOutcome(),
    severity: "critical",
    implicated_rule: "always_ask_before_deploy",
    ...overrides,
  };
}

function createTestDomain(overrides?: Partial<DomainEntry>): DomainEntry {
  return {
    weight: 0.8,
    description: "Test domain",
    examples: [],
    approval_count: 0,
    override_count: 0,
    ...overrides,
  };
}

function createTestPriorities(domains?: Record<string, DomainEntry>): PrioritiesFile {
  return {
    _meta: {
      version: 1,
      updated_at: new Date().toISOString(),
      updated_by: "user",
      description: "Test",
    },
    domains: domains ?? {
      operations: createTestDomain({ weight: 0.5 }),
      core_project: createTestDomain({ weight: 0.8 }),
    },
    strategy_labels: [],
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

function createMockPrioritiesStore(): PrioritiesStore & {
  adjustments: Array<{ domain: string; newWeight: number; reason: string }>;
} {
  const adjustments: Array<{ domain: string; newWeight: number; reason: string }> = [];
  const priorities = createTestPriorities();

  return {
    adjustments,
    getPriorities() {
      return priorities;
    },
    updateDomainWeight(domain: string, newWeight: number, reason: string) {
      adjustments.push({ domain, newWeight, reason });
    },
  };
}

function createMockProposalStore(): ProposalStore & { proposals: PolicyProposal[] } {
  const proposals: PolicyProposal[] = [];
  return {
    proposals,
    addProposal(proposal: Omit<PolicyProposal, "status">) {
      const full: PolicyProposal = { ...proposal, status: "pending" };
      proposals.push(full);
      return full;
    },
  };
}

const VALID_PROPOSALS_RESPONSE = JSON.stringify([
  {
    rule: "always_ask_before_deploy",
    proposal: "Allow auto-deploy to staging without confirmation",
    reasoning: "User has never rejected a staging deploy in 15 observations",
    evidence: ["action-001", "action-002"],
  },
]);

// ============================================================================
// calculateWeightAdjustment
// ============================================================================

describe("calculateWeightAdjustment", () => {
  it("does not adjust when under minimum observations", () => {
    const domain = createTestDomain({ approval_count: 5, override_count: 3 });
    const result = calculateWeightAdjustment(domain);
    expect(result.shouldAdjust).toBe(false);
  });

  it("adjusts upward when approvals exceed overrides", () => {
    const domain = createTestDomain({
      weight: 0.5,
      approval_count: 8,
      override_count: 2,
    });
    const result = calculateWeightAdjustment(domain);
    expect(result.shouldAdjust).toBe(true);
    expect(result.newWeight).toBeGreaterThan(0.5);
  });

  it("adjusts downward when overrides exceed approvals", () => {
    const domain = createTestDomain({
      weight: 0.8,
      approval_count: 2,
      override_count: 8,
    });
    const result = calculateWeightAdjustment(domain);
    expect(result.shouldAdjust).toBe(true);
    expect(result.newWeight).toBeLessThan(0.8);
  });

  it("clamps to max delta of 0.05", () => {
    const domain = createTestDomain({
      weight: 0.5,
      approval_count: 100,
      override_count: 0,
    });
    const result = calculateWeightAdjustment(domain);
    // Max upward adjustment is weight * (1 + 0.05) = 0.525
    expect(result.newWeight).toBeLessThanOrEqual(0.525);
  });

  it("enforces floor of 0.1", () => {
    const domain = createTestDomain({
      weight: 0.1,
      approval_count: 0,
      override_count: 100,
    });
    const result = calculateWeightAdjustment(domain);
    expect(result.newWeight).toBeGreaterThanOrEqual(0.1);
  });

  it("enforces ceiling of 1.0", () => {
    const domain = createTestDomain({
      weight: 0.99,
      approval_count: 100,
      override_count: 0,
    });
    const result = calculateWeightAdjustment(domain);
    expect(result.newWeight).toBeLessThanOrEqual(1.0);
  });

  it("does not adjust when result equals current weight", () => {
    const domain = createTestDomain({
      weight: 0.5,
      approval_count: 5,
      override_count: 5,
    });
    const result = calculateWeightAdjustment(domain);
    expect(result.shouldAdjust).toBe(false);
  });

  it("does not adjust when approval_count is NaN (H3)", () => {
    const domain = createTestDomain({ approval_count: NaN, override_count: 5 });
    const result = calculateWeightAdjustment(domain);
    expect(result.shouldAdjust).toBe(false);
    expect(result.newWeight).toBe(domain.weight);
  });

  it("does not adjust when override_count is negative (H3)", () => {
    const domain = createTestDomain({ approval_count: 10, override_count: -5 });
    const result = calculateWeightAdjustment(domain);
    expect(result.shouldAdjust).toBe(false);
  });

  it("adjusts exactly at minimum observation threshold", () => {
    const domain = createTestDomain({
      weight: 0.5,
      approval_count: 8,
      override_count: 2,
    });
    const result = calculateWeightAdjustment(domain);
    expect(result.shouldAdjust).toBe(true);
  });
});

// ============================================================================
// classifyFailureSeverity
// ============================================================================

describe("classifyFailureSeverity", () => {
  it("returns critical for failed tool_result", () => {
    const outcome: ActualOutcome = {
      source: "tool_result",
      success: false,
      toolName: "deploy",
      summary: "failed",
    };
    expect(classifyFailureSeverity(outcome)).toBe("critical");
  });

  it("returns warning for successful tool_result", () => {
    const outcome: ActualOutcome = {
      source: "tool_result",
      success: true,
      toolName: "deploy",
      summary: "ok",
    };
    expect(classifyFailureSeverity(outcome)).toBe("warning");
  });

  it("returns critical for user override", () => {
    const outcome: ActualOutcome = {
      source: "user_signal",
      signal: "overridden",
      context: "user changed approach",
    };
    expect(classifyFailureSeverity(outcome)).toBe("critical");
  });

  it("returns critical for user correction", () => {
    const outcome: ActualOutcome = {
      source: "user_signal",
      signal: "corrected",
      context: "user fixed output",
    };
    expect(classifyFailureSeverity(outcome)).toBe("critical");
  });

  it("returns warning for user approval", () => {
    const outcome: ActualOutcome = {
      source: "user_signal",
      signal: "approved",
      context: "user accepted",
    };
    expect(classifyFailureSeverity(outcome)).toBe("warning");
  });

  it("returns warning for inferred outcome (v2)", () => {
    const outcome: ActualOutcome = {
      source: "inferred",
      confidence: 0.8,
      reasoning: "follow-up suggests success",
    };
    expect(classifyFailureSeverity(outcome)).toBe("warning");
  });
});

// ============================================================================
// shouldTriggerPolicyReview
// ============================================================================

describe("shouldTriggerPolicyReview", () => {
  it("returns true for critical failure with implicated rule", () => {
    const event = createTestFailure({ severity: "critical", implicated_rule: "some_rule" });
    expect(shouldTriggerPolicyReview(event)).toBe(true);
  });

  it("returns false for warning severity", () => {
    const event = createTestFailure({ severity: "warning", implicated_rule: "some_rule" });
    expect(shouldTriggerPolicyReview(event)).toBe(false);
  });

  it("returns false when no implicated rule", () => {
    const event = createTestFailure({ severity: "critical", implicated_rule: undefined });
    expect(shouldTriggerPolicyReview(event)).toBe(false);
  });

  it("returns false for empty implicated_rule string (H2)", () => {
    const event = createTestFailure({ severity: "critical", implicated_rule: "" });
    expect(shouldTriggerPolicyReview(event)).toBe(false);
  });
});

// ============================================================================
// adjustWeights
// ============================================================================

describe("adjustWeights", () => {
  it("adjusts domains that meet observation threshold", () => {
    const priorities = createTestPriorities({
      operations: createTestDomain({
        weight: 0.5,
        approval_count: 12,
        override_count: 2,
      }),
    });
    const store = createMockPrioritiesStore();

    const adjustments = adjustWeights(priorities, store);

    expect(adjustments).toHaveLength(1);
    expect(adjustments[0].domain).toBe("operations");
    expect(adjustments[0].newWeight).toBeGreaterThan(0.5);
    expect(store.adjustments).toHaveLength(1);
  });

  it("skips domains below observation threshold", () => {
    const priorities = createTestPriorities({
      operations: createTestDomain({
        weight: 0.5,
        approval_count: 3,
        override_count: 2,
      }),
    });
    const store = createMockPrioritiesStore();

    const adjustments = adjustWeights(priorities, store);
    expect(adjustments).toHaveLength(0);
  });

  it("continues adjusting when one domain throws (M10)", () => {
    const priorities = createTestPriorities({
      operations: createTestDomain({
        weight: 0.5,
        approval_count: 12,
        override_count: 2,
      }),
      core_project: createTestDomain({
        weight: 0.8,
        approval_count: 2,
        override_count: 10,
      }),
    });
    let callCount = 0;
    const store: PrioritiesStore = {
      getPriorities() {
        return priorities;
      },
      updateDomainWeight(_domain: string, _newWeight: number, _reason: string) {
        callCount++;
        if (callCount === 1) {
          throw new Error("disk full");
        }
      },
    };

    const adjustments = adjustWeights(priorities, store);
    // First domain should fail, second should succeed
    expect(adjustments).toHaveLength(1);
  });

  it("adjusts multiple domains independently", () => {
    const priorities = createTestPriorities({
      operations: createTestDomain({
        weight: 0.5,
        approval_count: 12,
        override_count: 2,
      }),
      core_project: createTestDomain({
        weight: 0.8,
        approval_count: 2,
        override_count: 10,
      }),
    });
    const store = createMockPrioritiesStore();

    const adjustments = adjustWeights(priorities, store);
    expect(adjustments).toHaveLength(2);

    const ops = adjustments.find((a) => a.domain === "operations");
    const core = adjustments.find((a) => a.domain === "core_project");
    expect(ops!.newWeight).toBeGreaterThan(0.5);
    expect(core!.newWeight).toBeLessThan(0.8);
  });
});

// ============================================================================
// buildPolicyReviewPrompt
// ============================================================================

describe("buildPolicyReviewPrompt", () => {
  it("includes failure details", () => {
    const failures = [createTestFailure()];
    const prompt = buildPolicyReviewPrompt(failures);

    expect(prompt).toContain("action-001");
    expect(prompt).toContain("Deploy staging environment");
    expect(prompt).toContain("always_ask_before_deploy");
  });

  it("includes tool_result actual outcome", () => {
    const failures = [createTestFailure()];
    const prompt = buildPolicyReviewPrompt(failures);
    expect(prompt).toContain("tool_result: deploy failed");
  });

  it("includes user_signal actual outcome", () => {
    const failures = [
      createTestFailure({
        actualOutcome: {
          source: "user_signal",
          signal: "overridden",
          context: "user changed approach",
        },
      }),
    ];
    const prompt = buildPolicyReviewPrompt(failures);
    expect(prompt).toContain("user_signal: overridden");
  });

  it("includes severity tags", () => {
    const prompt = buildPolicyReviewPrompt([createTestFailure({ severity: "critical" })]);
    expect(prompt).toContain("[critical]");
  });

  it("includes constraint about max 5 proposals", () => {
    const prompt = buildPolicyReviewPrompt([createTestFailure()]);
    expect(prompt).toContain("Maximum 5 proposals");
  });

  it("includes 2-event evidence requirement", () => {
    const prompt = buildPolicyReviewPrompt([createTestFailure()]);
    expect(prompt).toContain("at least 2 supporting failure events");
  });

  it("includes safety-critical rule constraint", () => {
    const prompt = buildPolicyReviewPrompt([createTestFailure()]);
    expect(prompt).toContain("Never propose removing safety-critical rules");
  });

  it("includes output format instructions", () => {
    const prompt = buildPolicyReviewPrompt([createTestFailure()]);
    expect(prompt).toContain("Respond with raw JSON only");
    expect(prompt).toContain("Do not wrap in code fences");
  });
});

// ============================================================================
// parseProposals
// ============================================================================

describe("parseProposals", () => {
  it("parses valid proposals", () => {
    const proposals = parseProposals(VALID_PROPOSALS_RESPONSE);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].rule).toBe("always_ask_before_deploy");
    expect(proposals[0].evidence).toEqual(["action-001", "action-002"]);
  });

  it("parses empty array", () => {
    expect(parseProposals("[]")).toHaveLength(0);
  });

  it("strips markdown code fences", () => {
    const wrapped = "```json\n" + VALID_PROPOSALS_RESPONSE + "\n```";
    expect(parseProposals(wrapped)).toHaveLength(1);
  });

  it("rejects non-array response", () => {
    expect(() => parseProposals('{"rule": "test"}')).toThrow("must be a JSON array");
  });

  it("rejects too many proposals", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      rule: `rule${i}`,
      proposal: "p",
      reasoning: "r",
      evidence: ["a"],
    }));
    expect(() => parseProposals(JSON.stringify(many))).toThrow("Too many proposals: 6");
  });

  it("rejects missing rule", () => {
    const bad = [{ rule: "", proposal: "p", reasoning: "r", evidence: ["a"] }];
    expect(() => parseProposals(JSON.stringify(bad))).toThrow("non-empty rule");
  });

  it("rejects missing proposal", () => {
    const bad = [{ rule: "r", proposal: "", reasoning: "r", evidence: ["a"] }];
    expect(() => parseProposals(JSON.stringify(bad))).toThrow("non-empty proposal");
  });

  it("rejects missing reasoning", () => {
    const bad = [{ rule: "r", proposal: "p", reasoning: "", evidence: ["a"] }];
    expect(() => parseProposals(JSON.stringify(bad))).toThrow("non-empty reasoning");
  });

  it("rejects empty evidence", () => {
    const bad = [{ rule: "r", proposal: "p", reasoning: "r", evidence: [] }];
    expect(() => parseProposals(JSON.stringify(bad))).toThrow("non-empty evidence");
  });

  it("rejects invalid JSON", () => {
    expect(() => parseProposals("not json")).toThrow();
  });

  it("filters non-string evidence entries", () => {
    const mixed = [{ rule: "r", proposal: "p", reasoning: "r", evidence: ["a", 123, "b", null] }];
    const result = parseProposals(JSON.stringify(mixed));
    expect(result[0].evidence).toEqual(["a", "b"]);
  });
});

// ============================================================================
// runMetaReviewer
// ============================================================================

describe("runMetaReviewer", () => {
  it("creates proposals from reviewable failures", async () => {
    const failures = [
      createTestFailure({ actionId: "action-001", implicated_rule: "some_rule" }),
      createTestFailure({ actionId: "action-002", implicated_rule: "some_rule" }),
    ];
    const priorities = createTestPriorities();
    const pStore = createMockPrioritiesStore();
    const propStore = createMockProposalStore();
    const callModel: ModelCallFn = vi.fn(async () => VALID_PROPOSALS_RESPONSE);

    const result = await runMetaReviewer({ failures, priorities }, pStore, propStore, callModel);

    expect(result.proposalsCreated).toHaveLength(1);
    expect(result.proposalsCreated[0].status).toBe("pending");
    expect(result.fromFallback).toBe(false);
  });

  it("skips model call when no reviewable failures", async () => {
    const failures = [
      createTestFailure({ severity: "warning" }), // not reviewable
    ];
    const priorities = createTestPriorities();
    const pStore = createMockPrioritiesStore();
    const propStore = createMockProposalStore();
    const callModel: ModelCallFn = vi.fn(async () => "should not be called");

    const result = await runMetaReviewer({ failures, priorities }, pStore, propStore, callModel);

    expect(result.proposalsCreated).toHaveLength(0);
    expect(callModel).not.toHaveBeenCalled();
  });

  it("adjusts weights independently of model call", async () => {
    const priorities = createTestPriorities({
      operations: createTestDomain({
        weight: 0.5,
        approval_count: 12,
        override_count: 2,
      }),
    });
    const pStore = createMockPrioritiesStore();
    const propStore = createMockProposalStore();
    const callModel: ModelCallFn = vi.fn(async () => "[]");

    const result = await runMetaReviewer(
      { failures: [createTestFailure()], priorities },
      pStore,
      propStore,
      callModel,
    );

    expect(result.weightsAdjusted).toHaveLength(1);
    expect(result.weightsAdjusted[0].domain).toBe("operations");
  });

  it("retries on malformed model output and succeeds", async () => {
    let calls = 0;
    const callModel: ModelCallFn = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return "bad json";
      }
      return VALID_PROPOSALS_RESPONSE;
    });

    const result = await runMetaReviewer(
      { failures: [createTestFailure()], priorities: createTestPriorities() },
      createMockPrioritiesStore(),
      createMockProposalStore(),
      callModel,
    );

    expect(result.fromFallback).toBe(false);
    expect(result.proposalsCreated).toHaveLength(1);
    expect(callModel).toHaveBeenCalledTimes(2);
  });

  it("falls back after all retries fail", async () => {
    const callModel: ModelCallFn = vi.fn(async () => "garbage");

    const result = await runMetaReviewer(
      { failures: [createTestFailure()], priorities: createTestPriorities() },
      createMockPrioritiesStore(),
      createMockProposalStore(),
      callModel,
    );

    expect(result.fromFallback).toBe(true);
    expect(result.proposalsCreated).toHaveLength(0);
    expect(callModel).toHaveBeenCalledTimes(2);
  });

  it("falls back on model throwing", async () => {
    const callModel: ModelCallFn = vi.fn(async () => {
      throw new Error("model down");
    });

    const result = await runMetaReviewer(
      { failures: [createTestFailure()], priorities: createTestPriorities() },
      createMockPrioritiesStore(),
      createMockProposalStore(),
      callModel,
    );

    expect(result.fromFallback).toBe(true);
  });

  it("respects maxRetries=0", async () => {
    const callModel: ModelCallFn = vi.fn(async () => "bad");

    const result = await runMetaReviewer(
      { failures: [createTestFailure()], priorities: createTestPriorities() },
      createMockPrioritiesStore(),
      createMockProposalStore(),
      callModel,
      { maxRetries: 0 },
    );

    expect(result.fromFallback).toBe(true);
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  it("handles empty failures list", async () => {
    const callModel: ModelCallFn = vi.fn(async () => "should not be called");

    const result = await runMetaReviewer(
      { failures: [], priorities: createTestPriorities() },
      createMockPrioritiesStore(),
      createMockProposalStore(),
      callModel,
    );

    expect(result.proposalsCreated).toHaveLength(0);
    expect(result.fromFallback).toBe(false);
    expect(callModel).not.toHaveBeenCalled();
  });
});
