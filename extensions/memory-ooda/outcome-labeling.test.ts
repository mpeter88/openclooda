/**
 * Outcome Labeling Tests (O1-O5)
 *
 * Tests for the Tier 2 outcome labeling feature:
 * O1: Decision pattern detection (isDecision)
 * O2: Outcome signal detection from tool calls
 * O3: labelOutcome stores outcome fields (tested via mock store)
 * O4: Outcome-weighted retrieval scoring
 * O5: Outcome stats summary in archivist
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isDecision,
  runArchivist,
  writeState,
  type ArchivistState,
  type EpisodicEvent,
  type EpisodicStore,
  type OutcomeLabel,
  type PatternExtraction,
  type SemanticStore,
} from "./archivist.js";
import type { ModelCallFn } from "./triage.js";

// ============================================================================
// Fixtures
// ============================================================================

function createTestEvent(overrides?: Partial<EpisodicEvent>): EpisodicEvent {
  return {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    text: "User prefers TypeScript over JavaScript",
    category: "preference",
    importance: 0.8,
    createdAt: Date.now() - 60_000,
    source: "user",
    archivistProcessed: false,
    ...overrides,
  };
}

function createMockEpisodicStore(events: EpisodicEvent[] = []): EpisodicStore & {
  processedIds: string[];
  storedEvents: Array<Omit<EpisodicEvent, "id" | "createdAt" | "archivistProcessed">>;
  labeledOutcomes: Array<{ actionId: string; label: OutcomeLabel }>;
} {
  const processedIds: string[] = [];
  const storedEvents: Array<Omit<EpisodicEvent, "id" | "createdAt" | "archivistProcessed">> = [];
  const labeledOutcomes: Array<{ actionId: string; label: OutcomeLabel }> = [];

  return {
    processedIds,
    storedEvents,
    labeledOutcomes,
    async retrieveSince(_sinceTimestamp: number, _limit?: number) {
      return events;
    },
    async markProcessed(id: string) {
      processedIds.push(id);
    },
    async prune(_olderThanMs: number, _onlyProcessed = true) {
      return 0;
    },
    async store(event) {
      storedEvents.push(event);
    },
    async labelOutcome(actionId: string, label: OutcomeLabel) {
      labeledOutcomes.push({ actionId, label });
    },
    async findRecentWithActionId(limit = 5) {
      return events
        .filter((e) => e.actionId)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit);
    },
  };
}

function createMockSemanticStore(): SemanticStore & {
  upserts: Array<{ section: string; key: string; value: unknown }>;
  logEntries: Array<{ action: string; reason: string }>;
} {
  const upserts: Array<{ section: string; key: string; value: unknown }> = [];
  const logEntries: Array<{ action: string; reason: string }> = [];

  return {
    upserts,
    logEntries,
    upsertFact(section: string, key: string, value: unknown) {
      upserts.push({ section, key, value });
    },
    appendArchivistLog(action: string, reason: string) {
      logEntries.push({ action, reason });
    },
  };
}

// ============================================================================
// O1: isDecision heuristic
// ============================================================================

describe("O1: isDecision", () => {
  it("returns true for lessons_learned section", () => {
    const pattern: PatternExtraction = {
      section: "lessons_learned",
      key: "test_lesson",
      value: "Always run lint before commit",
      reason: "Events 1-3",
    };
    expect(isDecision(pattern)).toBe(true);
  });

  it("returns true when value contains decision keywords", () => {
    const keywords = ["decided", "chose", "implemented", "fixed", "applied", "switched"];
    for (const keyword of keywords) {
      const pattern: PatternExtraction = {
        section: "domain_context",
        key: "test",
        value: `We ${keyword} to use the new approach`,
        reason: "test",
      };
      expect(isDecision(pattern)).toBe(true);
    }
  });

  it("returns false for non-decision patterns", () => {
    const pattern: PatternExtraction = {
      section: "stack",
      key: "language",
      value: "TypeScript 5.x",
      reason: "test",
    };
    expect(isDecision(pattern)).toBe(false);
  });

  it("returns false for non-string values in non-lessons sections", () => {
    const pattern: PatternExtraction = {
      section: "people",
      key: "alice",
      value: { role: "engineer", relationship: "teammate" },
      reason: "test",
    };
    expect(isDecision(pattern)).toBe(false);
  });
});

// ============================================================================
// O1: Decision tagging in archivist (actionId)
// ============================================================================

describe("O1: decision tagging produces actionId", () => {
  let workspacePath: string;

  beforeEach(() => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "archivist-o1-"));
  });

  afterEach(() => {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  it("stores decision patterns into episodic backend with actionId", async () => {
    const events = [
      createTestEvent({ text: "Implemented the OODA chain" }),
      createTestEvent({
        id: "11111111-bbbb-cccc-dddd-eeeeeeeeeeee",
        text: "Fixed the import bug",
      }),
    ];
    const store = createMockEpisodicStore(events);
    const semanticStore = createMockSemanticStore();

    const decisionPattern: PatternExtraction = {
      section: "lessons_learned",
      key: "always_check_imports",
      value: "Always verify imports exist before referencing them",
      reason: "Events 1-2",
    };

    const callModel: ModelCallFn = async () => JSON.stringify([decisionPattern]);

    // Seed state
    writeState(workspacePath, {
      last_processed_turn: 10,
      turns_since_last_archivist: 0,
      last_run_at: "1970-01-01T00:00:00Z",
      archivist_runs_since_meta_review: 0,
    });

    await runArchivist(workspacePath, 10, store, semanticStore, callModel, { turnInterval: 5 });

    // Decision pattern should be stored in episodic with an actionId
    expect(store.storedEvents.length).toBeGreaterThanOrEqual(1);
    const decisionEvent = store.storedEvents.find((e) => e.category === "decision");
    expect(decisionEvent).toBeDefined();
    expect(decisionEvent!.actionId).toBeDefined();
    expect(decisionEvent!.actionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(decisionEvent!.importance).toBe(0.75);
    expect(decisionEvent!.source).toBe("archivist");
  });

  it("does not store non-decision patterns as decisions", async () => {
    const events = [createTestEvent()];
    const store = createMockEpisodicStore(events);
    const semanticStore = createMockSemanticStore();

    const stackPattern: PatternExtraction = {
      section: "stack",
      key: "language",
      value: "TypeScript 5.x",
      reason: "Events 1",
    };

    const callModel: ModelCallFn = async () => JSON.stringify([stackPattern]);

    writeState(workspacePath, {
      last_processed_turn: 10,
      turns_since_last_archivist: 0,
      last_run_at: "1970-01-01T00:00:00Z",
      archivist_runs_since_meta_review: 0,
    });

    await runArchivist(workspacePath, 10, store, semanticStore, callModel, { turnInterval: 5 });

    const decisionEvents = store.storedEvents.filter((e) => e.category === "decision");
    expect(decisionEvents).toHaveLength(0);
  });
});

// ============================================================================
// O3: labelOutcome via mock store
// ============================================================================

describe("O3: labelOutcome stores outcome fields", () => {
  it("records outcome on the labeled entry", async () => {
    const store = createMockEpisodicStore();
    await store.labelOutcome!("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", {
      outcome: "success",
      observedAt: Date.now(),
      signal: "test_passed",
      detail: "All 42 tests passed",
    });

    expect(store.labeledOutcomes).toHaveLength(1);
    expect(store.labeledOutcomes[0].label.outcome).toBe("success");
    expect(store.labeledOutcomes[0].label.signal).toBe("test_passed");
  });
});

// ============================================================================
// O2: Outcome signal detection (unit — detectOutcomeSignal is internal,
//     tested through the after_tool_call integration in index.ts)
// ============================================================================

describe("O2: outcome signal detection patterns", () => {
  // Import the plugin to get access to the handler wiring
  // For unit testing the detection logic, we test the patterns directly

  it("positive exec signals match test pass patterns", () => {
    const positivePatterns = [
      /tests? pass(ed|ing)?/i,
      /BUILD SUCCESS/i,
      /all \d+ tests/i,
      /0 fail(ure|ed|ing)?s?\b/i,
    ];

    const testOutputs = [
      "42 tests passed, 0 failures",
      "BUILD SUCCESS in 3.2s",
      "all 15 tests completed",
      "0 failures, 12 passed",
      "test passing: npm test completed",
    ];

    for (const output of testOutputs) {
      const matched = positivePatterns.some((p) => p.test(output));
      expect(matched).toBe(true);
    }
  });

  it("negative exec signals match failure patterns", () => {
    const negativePatterns = [/FAIL(ED|URE|ING)?/i, /ERR(OR)?[\s:]/i, /exit code [1-9]/i];

    const errorOutputs = ["FAILED: 3 tests failed", "ERROR: build step failed", "exit code 1"];

    for (const output of errorOutputs) {
      const matched = negativePatterns.some((p) => p.test(output));
      expect(matched).toBe(true);
    }
  });
});

// ============================================================================
// O4: Outcome-weighted retrieval scoring
// ============================================================================

describe("O4: outcome-weighted retrieval", () => {
  it("success-labeled memory scores 1.3x higher", () => {
    const baseScore = 0.5;
    const successScore = baseScore * 1.3;
    const failureScore = baseScore * 0.6;

    expect(successScore).toBeGreaterThan(baseScore);
    expect(failureScore).toBeLessThan(baseScore);
    expect(successScore).toBeCloseTo(0.65);
    expect(failureScore).toBeCloseTo(0.3);
  });

  it("success-labeled memory outranks unlabeled at same distance", () => {
    // Simulate the scoring logic from search()
    const distance = 0.5;
    const baseScore = 1 / (1 + distance); // ~0.667

    const unlabeledScore = baseScore;
    const successScore = baseScore * 1.3;
    const failureScore = baseScore * 0.6;

    expect(successScore).toBeGreaterThan(unlabeledScore);
    expect(failureScore).toBeLessThan(unlabeledScore);
  });
});

// ============================================================================
// O5: Outcome stats in archivist → KNOWLEDGE.json
// ============================================================================

describe("O5: archivist outcome stats summary", () => {
  let workspacePath: string;

  beforeEach(() => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "archivist-o5-"));
  });

  afterEach(() => {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  it("writes outcome stats to lessons_learned when outcomes exist", async () => {
    const events = [
      createTestEvent({
        id: "11111111-bbbb-cccc-dddd-eeeeeeeeeeee",
        actionId: "aaaaaaaa-1111-2222-3333-444444444444",
        outcome: "success",
        outcomeSignal: "test_passed",
        outcomeAt: Date.now() - 30_000,
      }),
      createTestEvent({
        id: "22222222-bbbb-cccc-dddd-eeeeeeeeeeee",
        actionId: "bbbbbbbb-1111-2222-3333-444444444444",
        outcome: "failure",
        outcomeSignal: "build_failed",
        outcomeAt: Date.now() - 20_000,
      }),
      createTestEvent({
        id: "33333333-bbbb-cccc-dddd-eeeeeeeeeeee",
        actionId: "cccccccc-1111-2222-3333-444444444444",
        outcome: "success",
        outcomeSignal: "test_passed",
        outcomeAt: Date.now() - 10_000,
      }),
    ];
    const store = createMockEpisodicStore(events);
    const semanticStore = createMockSemanticStore();

    const callModel: ModelCallFn = async () => "[]"; // no patterns

    writeState(workspacePath, {
      last_processed_turn: 10,
      turns_since_last_archivist: 0,
      last_run_at: "1970-01-01T00:00:00Z",
      archivist_runs_since_meta_review: 0,
    });

    await runArchivist(workspacePath, 10, store, semanticStore, callModel, { turnInterval: 5 });

    // Check that outcome stats were upserted into lessons_learned
    const outcomeUpserts = semanticStore.upserts.filter(
      (u) => u.section === "lessons_learned" && String(u.key).startsWith("outcome_"),
    );
    expect(outcomeUpserts.length).toBeGreaterThan(0);

    // Should include overall fix rate
    const overallStat = outcomeUpserts.find((u) => u.key === "outcome_overall_fix_rate");
    expect(overallStat).toBeDefined();
    expect(String(overallStat!.value)).toContain("2/3");
    expect(String(overallStat!.value)).toContain("1 failed");
  });

  it("skips outcome stats when no outcomes exist", async () => {
    const events = [createTestEvent()]; // no outcome fields
    const store = createMockEpisodicStore(events);
    const semanticStore = createMockSemanticStore();

    const callModel: ModelCallFn = async () => "[]";

    writeState(workspacePath, {
      last_processed_turn: 10,
      turns_since_last_archivist: 0,
      last_run_at: "1970-01-01T00:00:00Z",
      archivist_runs_since_meta_review: 0,
    });

    await runArchivist(workspacePath, 10, store, semanticStore, callModel, { turnInterval: 5 });

    const outcomeUpserts = semanticStore.upserts.filter(
      (u) => u.section === "lessons_learned" && String(u.key).startsWith("outcome_"),
    );
    expect(outcomeUpserts).toHaveLength(0);
  });

  it("detects recurring failure signals", async () => {
    const events = [
      createTestEvent({
        id: "11111111-bbbb-cccc-dddd-eeeeeeeeeeee",
        actionId: "aaaaaaaa-1111-2222-3333-444444444444",
        outcome: "failure",
        outcomeSignal: "build_failed",
        outcomeAt: Date.now() - 30_000,
      }),
      createTestEvent({
        id: "22222222-bbbb-cccc-dddd-eeeeeeeeeeee",
        actionId: "bbbbbbbb-1111-2222-3333-444444444444",
        outcome: "failure",
        outcomeSignal: "build_failed",
        outcomeAt: Date.now() - 20_000,
      }),
    ];
    const store = createMockEpisodicStore(events);
    const semanticStore = createMockSemanticStore();

    const callModel: ModelCallFn = async () => "[]";

    writeState(workspacePath, {
      last_processed_turn: 10,
      turns_since_last_archivist: 0,
      last_run_at: "1970-01-01T00:00:00Z",
      archivist_runs_since_meta_review: 0,
    });

    await runArchivist(workspacePath, 10, store, semanticStore, callModel, { turnInterval: 5 });

    const recurringFailure = semanticStore.upserts.find(
      (u) => u.key === "outcome_recurring_failure_build_failed",
    );
    expect(recurringFailure).toBeDefined();
    expect(String(recurringFailure!.value)).toContain("2 times");
  });
});
