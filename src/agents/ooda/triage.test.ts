import { describe, expect, it, vi } from "vitest";
import { createDefaultKnowledge } from "../../../extensions/memory-ooda/semantic-memory.js";
import type { KnowledgeFile, PrioritiesFile } from "../../../extensions/memory-ooda/types.js";
import {
  buildTriagePrompt,
  createDefaultSITREP,
  parseSITREP,
  runTriage,
  shouldRunFullOODA,
  type ModelCallFn,
  type TriageInput,
} from "./triage.js";

// ============================================================================
// Test Fixtures
// ============================================================================

function createTestPriorities(overrides?: Partial<PrioritiesFile>): PrioritiesFile {
  return {
    _meta: {
      version: 1,
      updated_at: new Date().toISOString(),
      updated_by: "user",
      description: "Test priorities",
    },
    domains: {
      core_project: {
        weight: 0.9,
        description: "Primary project work",
        examples: ["coding", "architecture"],
        approval_count: 0,
        override_count: 0,
      },
      operations: {
        weight: 0.5,
        description: "DevOps and infrastructure",
        examples: ["deployment", "monitoring"],
        approval_count: 0,
        override_count: 0,
      },
    },
    strategy_labels: [
      { label: "deep_work", description: "Focused implementation" },
      { label: "quick_fix", description: "Fast resolution" },
    ],
    scoring_rubric: {
      alignment: { weight: 0.4, description: "Match with goals" },
      efficiency: { weight: 0.35, description: "Token cost vs value" },
      risk: { weight: 0.25, description: "Potential for side-effects" },
    },
    thresholds: {
      min_priority_for_full_ooda: 5,
      min_thinking_level_for_full_ooda: "medium",
      critical_failure_score_floor: 0.3,
      archivist_turn_interval: 100,
      meta_reviewer_weekly_enabled: false,
    },
    _weight_adjustment_log: [],
    ...overrides,
  };
}

function createTestFacts(overrides?: Partial<KnowledgeFile>): KnowledgeFile {
  const base = createDefaultKnowledge();
  return {
    ...base,
    identity: {
      ...base.identity,
      name: "Michael",
      timezone: "US/Central",
    },
    stack: { openclaw: "TypeScript + ESM" },
    projects: {
      "ooda-agent": {
        status: "active",
        priority_domain: "core_project",
        key_constraint: "Ship Q2",
        notes: "",
      },
    },
    preferences: {
      ...base.preferences,
      never_do: ["delete production data"],
    },
    ...overrides,
  };
}

function createTestInput(observation?: string): TriageInput {
  return {
    observation: observation ?? "Please refactor the triage module to use dependency injection",
    facts: createTestFacts(),
    priorities: createTestPriorities(),
  };
}

// ============================================================================
// createDefaultSITREP
// ============================================================================

describe("createDefaultSITREP", () => {
  it("returns a priority-5 SITREP", () => {
    const sitrep = createDefaultSITREP("hello world");
    expect(sitrep.priority).toBe(5);
    expect(sitrep.summary).toBe("hello world");
    expect(sitrep.conflictsDetected).toEqual([]);
    expect(sitrep.relevantFacts).toEqual([]);
    expect(sitrep.recommendedDomains).toEqual([]);
  });

  it("truncates long observations to 200 chars", () => {
    const long = "x".repeat(500);
    const sitrep = createDefaultSITREP(long);
    expect(sitrep.summary.length).toBe(200);
  });
});

// ============================================================================
// buildTriagePrompt
// ============================================================================

describe("buildTriagePrompt", () => {
  it("includes observation in the prompt", () => {
    const prompt = buildTriagePrompt(createTestInput("fix the login bug"));
    expect(prompt).toContain("fix the login bug");
  });

  it("includes user identity from facts", () => {
    const prompt = buildTriagePrompt(createTestInput());
    expect(prompt).toContain("Michael");
    expect(prompt).toContain("US/Central");
  });

  it("includes tech stack", () => {
    const prompt = buildTriagePrompt(createTestInput());
    expect(prompt).toContain("openclaw=TypeScript + ESM");
  });

  it("includes projects with status", () => {
    const prompt = buildTriagePrompt(createTestInput());
    expect(prompt).toContain("ooda-agent");
    expect(prompt).toContain("status=active");
  });

  it("includes never_do preferences", () => {
    const prompt = buildTriagePrompt(createTestInput());
    expect(prompt).toContain("delete production data");
  });

  it("includes domains sorted by weight", () => {
    const prompt = buildTriagePrompt(createTestInput());
    const coreIdx = prompt.indexOf("core_project");
    const opsIdx = prompt.indexOf("operations");
    expect(coreIdx).toBeLessThan(opsIdx);
    expect(prompt).toContain("weight=0.9");
  });

  it("includes JSON schema instructions", () => {
    const prompt = buildTriagePrompt(createTestInput());
    expect(prompt).toContain('"priority"');
    expect(prompt).toContain('"summary"');
    expect(prompt).toContain('"conflictsDetected"');
    expect(prompt).toContain('"relevantFacts"');
    expect(prompt).toContain('"recommendedDomains"');
  });

  it("includes priority guide", () => {
    const prompt = buildTriagePrompt(createTestInput());
    expect(prompt).toContain("1-2: Trivial");
    expect(prompt).toContain("9-10: Critical");
  });

  it("handles empty facts gracefully", () => {
    const input: TriageInput = {
      observation: "hello",
      facts: createDefaultKnowledge(),
      priorities: createTestPriorities(),
    };
    const prompt = buildTriagePrompt(input);
    expect(prompt).toContain("No user context available.");
  });
});

// ============================================================================
// parseSITREP
// ============================================================================

describe("parseSITREP", () => {
  it("parses valid SITREP JSON", () => {
    const raw = JSON.stringify({
      priority: 7,
      summary: "User wants to refactor the triage module",
      conflictsDetected: [],
      relevantFacts: ["stack.openclaw"],
      recommendedDomains: ["core_project"],
    });

    const sitrep = parseSITREP(raw);
    expect(sitrep.priority).toBe(7);
    expect(sitrep.summary).toBe("User wants to refactor the triage module");
    expect(sitrep.relevantFacts).toEqual(["stack.openclaw"]);
    expect(sitrep.recommendedDomains).toEqual(["core_project"]);
  });

  it("strips markdown code fences", () => {
    const raw =
      '```json\n{"priority": 3, "summary": "hello", "conflictsDetected": [], "relevantFacts": [], "recommendedDomains": []}\n```';
    const sitrep = parseSITREP(raw);
    expect(sitrep.priority).toBe(3);
  });

  it("rejects invalid priority values", () => {
    expect(() => parseSITREP('{"priority": 0, "summary": "test"}')).toThrow("Invalid priority");
    expect(() => parseSITREP('{"priority": 11, "summary": "test"}')).toThrow("Invalid priority");
    expect(() => parseSITREP('{"priority": 5.5, "summary": "test"}')).toThrow("Invalid priority");
    expect(() => parseSITREP('{"priority": "high", "summary": "test"}')).toThrow(
      "Invalid priority",
    );
  });

  it("rejects missing summary", () => {
    expect(() => parseSITREP('{"priority": 5}')).toThrow("non-empty summary");
    expect(() => parseSITREP('{"priority": 5, "summary": ""}')).toThrow("non-empty summary");
  });

  it("rejects non-object responses", () => {
    expect(() => parseSITREP('"just a string"')).toThrow("must be a JSON object");
    expect(() => parseSITREP("[1, 2, 3]")).toThrow("must be a JSON object");
  });

  it("rejects invalid JSON", () => {
    expect(() => parseSITREP("not json at all")).toThrow();
  });

  it("filters non-string array entries", () => {
    const raw = JSON.stringify({
      priority: 5,
      summary: "test",
      conflictsDetected: ["valid", 42, null, "also valid"],
      relevantFacts: [true, "fact1"],
      recommendedDomains: "not an array",
    });
    const sitrep = parseSITREP(raw);
    expect(sitrep.conflictsDetected).toEqual(["valid", "also valid"]);
    expect(sitrep.relevantFacts).toEqual(["fact1"]);
    expect(sitrep.recommendedDomains).toEqual([]);
  });

  it("defaults missing arrays to empty", () => {
    const raw = JSON.stringify({ priority: 5, summary: "test" });
    const sitrep = parseSITREP(raw);
    expect(sitrep.conflictsDetected).toEqual([]);
    expect(sitrep.relevantFacts).toEqual([]);
    expect(sitrep.recommendedDomains).toEqual([]);
  });
});

// ============================================================================
// runTriage
// ============================================================================

describe("runTriage", () => {
  const validResponse = JSON.stringify({
    priority: 7,
    summary: "Refactor request for triage module",
    conflictsDetected: [],
    relevantFacts: ["stack.openclaw"],
    recommendedDomains: ["core_project"],
  });

  it("returns parsed SITREP on successful model call", async () => {
    const callModel: ModelCallFn = vi.fn(async () => validResponse);
    const { sitrep, fromFallback } = await runTriage(createTestInput(), callModel);

    expect(fromFallback).toBe(false);
    expect(sitrep.priority).toBe(7);
    expect(sitrep.summary).toBe("Refactor request for triage module");
    expect(callModel).toHaveBeenCalledOnce();
  });

  it("retries once on malformed JSON, then succeeds", async () => {
    let calls = 0;
    const callModel: ModelCallFn = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return "not valid json";
      }
      return validResponse;
    });

    const { sitrep, fromFallback } = await runTriage(createTestInput(), callModel);

    expect(fromFallback).toBe(false);
    expect(sitrep.priority).toBe(7);
    expect(callModel).toHaveBeenCalledTimes(2);
  });

  it("falls back to default SITREP after all retries fail", async () => {
    const callModel: ModelCallFn = vi.fn(async () => "garbage");

    const { sitrep, fromFallback } = await runTriage(createTestInput("deploy to prod"), callModel);

    expect(fromFallback).toBe(true);
    expect(sitrep.priority).toBe(5);
    expect(sitrep.summary).toBe("deploy to prod");
    expect(callModel).toHaveBeenCalledTimes(2); // initial + 1 retry
  });

  it("falls back on model call throwing", async () => {
    const callModel: ModelCallFn = vi.fn(async () => {
      throw new Error("model unavailable");
    });

    const { sitrep, fromFallback } = await runTriage(createTestInput(), callModel);
    expect(fromFallback).toBe(true);
    expect(sitrep.priority).toBe(5);
  });

  it("respects maxRetries=0", async () => {
    const callModel: ModelCallFn = vi.fn(async () => "bad json");

    const { fromFallback } = await runTriage(createTestInput(), callModel, {
      maxRetries: 0,
    });

    expect(fromFallback).toBe(true);
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  it("passes the constructed prompt to the model", async () => {
    const callModel: ModelCallFn = vi.fn(async () => validResponse);
    const input = createTestInput("fix the login bug");

    await runTriage(input, callModel);

    const promptArg = (callModel as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(promptArg).toContain("fix the login bug");
    expect(promptArg).toContain("Michael");
    expect(promptArg).toContain("core_project");
  });
});

// ============================================================================
// shouldRunFullOODA
// ============================================================================

describe("shouldRunFullOODA", () => {
  const priorities = createTestPriorities();
  // thresholds: min_priority=5, min_thinking="medium"

  it("returns true when priority and thinking meet thresholds", () => {
    const sitrep = { ...createDefaultSITREP(""), priority: 7 as const };
    expect(shouldRunFullOODA(sitrep, priorities, "medium")).toBe(true);
    expect(shouldRunFullOODA(sitrep, priorities, "high")).toBe(true);
  });

  it("returns false when thinking level is too low", () => {
    const sitrep = { ...createDefaultSITREP(""), priority: 8 as const };
    expect(shouldRunFullOODA(sitrep, priorities, "low")).toBe(false);
  });

  it("returns false when priority is below threshold", () => {
    const sitrep = { ...createDefaultSITREP(""), priority: 3 as const };
    expect(shouldRunFullOODA(sitrep, priorities, "high")).toBe(false);
  });

  it("returns true at exact threshold boundary", () => {
    const sitrep = { ...createDefaultSITREP(""), priority: 5 as const };
    expect(shouldRunFullOODA(sitrep, priorities, "medium")).toBe(true);
  });

  it("respects custom threshold values", () => {
    const strict = createTestPriorities({
      thresholds: {
        ...priorities.thresholds,
        min_priority_for_full_ooda: 8,
        min_thinking_level_for_full_ooda: "high",
      },
    });
    const sitrep = { ...createDefaultSITREP(""), priority: 7 as const };
    expect(shouldRunFullOODA(sitrep, strict, "high")).toBe(false);

    const critical = { ...createDefaultSITREP(""), priority: 9 as const };
    expect(shouldRunFullOODA(critical, strict, "high")).toBe(true);
    expect(shouldRunFullOODA(critical, strict, "medium")).toBe(false);
  });
});
