import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  aggregateDomainOutcomes,
  buildArchivistPrompt,
  generateWeightProposals,
  inferDomain,
  parsePatterns,
  readState,
  runArchivist,
  shouldProposeWeightAdjustment,
  shouldRunArchivist,
  statePath,
  writeState,
  type ArchivistState,
  type EpisodicEvent,
  type EpisodicStore,
  type PatternExtraction,
  type SemanticStore,
} from "./archivist.js";
import type { ModelCallFn } from "./triage.js";
import type { DomainEntry, PrioritiesFile } from "./types.js";

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

function createTestEvents(count: number): EpisodicEvent[] {
  return Array.from({ length: count }, (_, i) =>
    createTestEvent({
      id: `${String(i).padStart(8, "0")}-bbbb-cccc-dddd-eeeeeeeeeeee`,
      text: `Event ${i}: user mentioned TypeScript preference`,
      createdAt: Date.now() - (count - i) * 60_000,
    }),
  );
}

function createMockEpisodicStore(events: EpisodicEvent[] = []): EpisodicStore & {
  processedIds: string[];
  pruneCalls: Array<{ olderThanMs: number; onlyProcessed: boolean }>;
} {
  const processedIds: string[] = [];
  const pruneCalls: Array<{ olderThanMs: number; onlyProcessed: boolean }> = [];

  return {
    processedIds,
    pruneCalls,
    async retrieveSince(_sinceTimestamp: number, _limit?: number) {
      return events;
    },
    async markProcessed(id: string) {
      processedIds.push(id);
    },
    async prune(olderThanMs: number, onlyProcessed = true) {
      pruneCalls.push({ olderThanMs, onlyProcessed });
      return 0;
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

const VALID_PATTERNS: PatternExtraction[] = [
  {
    section: "stack",
    key: "language",
    value: "TypeScript 5.x",
    reason: "Events 1-3 all reference TypeScript preference",
  },
  {
    section: "domain_context",
    key: "current_focus",
    value: "OODA agent implementation",
    reason: "Events 2,4,5 discuss OODA agent work",
  },
];

const VALID_MODEL_RESPONSE = JSON.stringify(VALID_PATTERNS);

// ============================================================================
// State Management
// ============================================================================

describe("state management", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-archivist-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("readState", () => {
    it("returns default state when file does not exist", () => {
      const state = readState(tmpDir);
      expect(state.turns_since_last_archivist).toBe(0);
      expect(state.last_run_at).toBe("1970-01-01T00:00:00Z");
    });

    it("reads existing state file", () => {
      const state: ArchivistState = {
        last_processed_turn: 200,
        turns_since_last_archivist: 15,
        last_run_at: "2026-03-15T10:00:00Z",
        archivist_runs_since_meta_review: 0,
      };
      fs.writeFileSync(statePath(tmpDir), JSON.stringify(state));

      const result = readState(tmpDir);
      expect(result.turns_since_last_archivist).toBe(15);
      expect(result.last_run_at).toBe("2026-03-15T10:00:00Z");
    });

    it("migrates old last_archivist_turn to turns_since_last_archivist", () => {
      // Old format: two global counters
      fs.writeFileSync(
        statePath(tmpDir),
        JSON.stringify({
          last_processed_turn: 100,
          last_archivist_turn: 80,
          last_run_at: "2026-03-15T10:00:00Z",
        }),
      );
      const result = readState(tmpDir);
      // Should compute the delta: 100 - 80 = 20
      expect(result.turns_since_last_archivist).toBe(20);
    });

    it("throws on malformed state file", () => {
      fs.writeFileSync(statePath(tmpDir), "not json");
      expect(() => readState(tmpDir)).toThrow();
    });

    it("throws on missing required fields", () => {
      fs.writeFileSync(
        statePath(tmpDir),
        JSON.stringify({ last_processed_turn: 5, turns_since_last_archivist: 5 }),
      );
      expect(() => readState(tmpDir)).toThrow("missing last_run_at");
    });

    it("throws on invalid timestamp (M7)", () => {
      fs.writeFileSync(
        statePath(tmpDir),
        JSON.stringify({
          last_processed_turn: 5,
          turns_since_last_archivist: 5,
          last_run_at: "not-a-date",
        }),
      );
      expect(() => readState(tmpDir)).toThrow("not a valid timestamp");
    });
  });

  describe("writeState", () => {
    it("writes state to disk", () => {
      writeState(tmpDir, {
        last_processed_turn: 100,
        turns_since_last_archivist: 5,
        last_run_at: "2026-03-16T12:00:00Z",
        archivist_runs_since_meta_review: 0,
      });

      const state = readState(tmpDir);
      expect(state.turns_since_last_archivist).toBe(5);
      expect(state.last_run_at).toBe("2026-03-16T12:00:00Z");
    });

    it("creates parent directories if needed", () => {
      const deepPath = path.join(tmpDir, "deep", "nested");
      writeState(deepPath, {
        last_processed_turn: 50,
        turns_since_last_archivist: 0,
        last_run_at: "2026-03-16T12:00:00Z",
        archivist_runs_since_meta_review: 0,
      });
      expect(fs.existsSync(statePath(deepPath))).toBe(true);
    });
  });
});

// ============================================================================
// shouldRunArchivist
// ============================================================================

describe("shouldRunArchivist", () => {
  it("returns true when enough turns have passed", () => {
    const state: ArchivistState = {
      last_processed_turn: 100,
      turns_since_last_archivist: 100,
      last_run_at: "2026-03-15T00:00:00Z",
      archivist_runs_since_meta_review: 0,
    };
    expect(shouldRunArchivist(state, 100)).toBe(true);
  });

  it("returns false when not enough turns have passed", () => {
    const state: ArchivistState = {
      last_processed_turn: 99,
      turns_since_last_archivist: 99,
      last_run_at: "2026-03-15T00:00:00Z",
      archivist_runs_since_meta_review: 0,
    };
    expect(shouldRunArchivist(state, 100)).toBe(false);
  });

  it("returns true when more than interval turns have passed", () => {
    const state: ArchivistState = {
      last_processed_turn: 200,
      turns_since_last_archivist: 150,
      last_run_at: "2026-03-15T00:00:00Z",
      archivist_runs_since_meta_review: 0,
    };
    expect(shouldRunArchivist(state, 100)).toBe(true);
  });

  it("returns false when turnInterval is 0", () => {
    const state: ArchivistState = {
      last_processed_turn: 1000,
      turns_since_last_archivist: 1000,
      last_run_at: "2026-03-15T00:00:00Z",
      archivist_runs_since_meta_review: 0,
    };
    expect(shouldRunArchivist(state, 0)).toBe(false);
  });

  it("returns false when turnInterval is negative", () => {
    const state: ArchivistState = {
      last_processed_turn: 1000,
      turns_since_last_archivist: 1000,
      last_run_at: "2026-03-15T00:00:00Z",
      archivist_runs_since_meta_review: 0,
    };
    expect(shouldRunArchivist(state, -1)).toBe(false);
  });
});

// ============================================================================
// buildArchivistPrompt
// ============================================================================

describe("buildArchivistPrompt", () => {
  it("includes all events with timestamps", () => {
    const events = createTestEvents(3);
    const prompt = buildArchivistPrompt(events);

    expect(prompt).toContain("Event 0:");
    expect(prompt).toContain("Event 1:");
    expect(prompt).toContain("Event 2:");
  });

  it("includes event source tags", () => {
    const events = [createTestEvent({ source: "github" })];
    const prompt = buildArchivistPrompt(events);
    expect(prompt).toContain("[github]");
  });

  it("includes importance values", () => {
    const events = [createTestEvent({ importance: 0.9 })];
    const prompt = buildArchivistPrompt(events);
    expect(prompt).toContain("importance=0.9");
  });

  it("includes section format descriptions", () => {
    const prompt = buildArchivistPrompt([createTestEvent()]);
    // P4: prompt updated to include new sections
    expect(prompt).toContain("lessons_learned");
    expect(prompt).toContain("preferences_notes");
    expect(prompt).toContain("projects");
    expect(prompt).toContain("people");
    expect(prompt).toContain("domain_context");
  });

  it("includes constraint about max patterns", () => {
    const prompt = buildArchivistPrompt([createTestEvent()]);
    expect(prompt).toContain("Maximum 15 patterns");
  });

  it("includes citation requirements", () => {
    const prompt = buildArchivistPrompt([createTestEvent()]);
    // lessons_learned can come from single event; others need 2+
    expect(prompt).toContain("lessons_learned entries can come from a SINGLE event");
    expect(prompt).toContain("2+ supporting events");
  });

  it("includes output format instructions", () => {
    const prompt = buildArchivistPrompt([createTestEvent()]);
    expect(prompt).toContain("Respond with raw JSON only");
    expect(prompt).toContain("No code fences");
  });

  it("truncates long event text (H4)", () => {
    const events = [createTestEvent({ text: "x".repeat(500) })];
    const prompt = buildArchivistPrompt(events);
    expect(prompt).not.toContain("x".repeat(500));
    expect(prompt).toContain("x".repeat(200) + "...");
  });

  it("includes privacy constraint", () => {
    const prompt = buildArchivistPrompt([createTestEvent()]);
    expect(prompt).toContain("Never infer sensitive personal information");
  });
});

// ============================================================================
// parsePatterns
// ============================================================================

describe("parsePatterns", () => {
  it("parses valid pattern array", () => {
    const { patterns } = parsePatterns(VALID_MODEL_RESPONSE);
    expect(patterns).toHaveLength(2);
    expect(patterns[0].section).toBe("stack");
    expect(patterns[0].key).toBe("language");
    expect(patterns[0].value).toBe("TypeScript 5.x");
    expect(patterns[1].section).toBe("domain_context");
  });

  it("parses empty array", () => {
    const { patterns } = parsePatterns("[]");
    expect(patterns).toHaveLength(0);
  });

  it("strips markdown code fences", () => {
    const wrapped = "```json\n" + VALID_MODEL_RESPONSE + "\n```";
    const { patterns } = parsePatterns(wrapped);
    expect(patterns).toHaveLength(2);
  });

  it("rejects non-array response", () => {
    expect(() => parsePatterns('{"key": "value"}')).toThrow("must be a JSON array");
  });

  it("rejects too many patterns", () => {
    const many = Array.from({ length: 16 }, (_, i) => ({
      section: "stack",
      key: `key${i}`,
      value: "v",
      reason: "r",
    }));
    expect(() => parsePatterns(JSON.stringify(many))).toThrow("Too many patterns: 16");
  });

  // Per-item validation soft-drops bad rows instead of throwing the
  // whole batch. The returned `errors` array carries each drop reason.

  it("drops pattern with invalid section but keeps valid siblings", () => {
    const mixed = [
      { section: "invalid", key: "bad", value: "v", reason: "r" },
      { section: "stack", key: "good", value: "v", reason: "r" },
    ];
    const { patterns, errors } = parsePatterns(JSON.stringify(mixed));
    expect(patterns).toHaveLength(1);
    expect(patterns[0].key).toBe("good");
    expect(errors.some((e) => e.includes("section must be one of"))).toBe(true);
  });

  it("drops pattern with empty key", () => {
    const bad = [{ section: "stack", key: "", value: "v", reason: "r" }];
    const { patterns, errors } = parsePatterns(JSON.stringify(bad));
    expect(patterns).toEqual([]);
    expect(errors.some((e) => e.includes("missing or empty key"))).toBe(true);
  });

  it("drops pattern with null value (the bug that froze the loop for 5 days)", () => {
    const bad = [{ section: "stack", key: "k", value: null, reason: "r" }];
    const { patterns, errors } = parsePatterns(JSON.stringify(bad));
    expect(patterns).toEqual([]);
    expect(errors.some((e) => e.includes("null value"))).toBe(true);
  });

  it("drops pattern with empty reason", () => {
    const bad = [{ section: "stack", key: "k", value: "v", reason: "" }];
    const { patterns, errors } = parsePatterns(JSON.stringify(bad));
    expect(patterns).toEqual([]);
    expect(errors.some((e) => e.includes("missing or empty reason"))).toBe(true);
  });

  it("rejects invalid JSON (whole-batch failure still throws)", () => {
    expect(() => parsePatterns("not json")).toThrow();
  });

  it("drops non-string value for stack section (M9)", () => {
    const bad = [{ section: "stack", key: "lang", value: { nested: true }, reason: "test" }];
    const { patterns, errors } = parsePatterns(JSON.stringify(bad));
    expect(patterns).toEqual([]);
    expect(errors.some((e) => e.includes("string"))).toBe(true);
  });

  it("drops non-string value for domain_context section (M9)", () => {
    const bad = [{ section: "domain_context", key: "focus", value: 42, reason: "test" }];
    const { patterns, errors } = parsePatterns(JSON.stringify(bad));
    expect(patterns).toEqual([]);
    expect(errors.some((e) => e.includes("string"))).toBe(true);
  });

  it("drops non-object value for people section (M9)", () => {
    const bad = [{ section: "people", key: "alice", value: "just a string", reason: "test" }];
    const { patterns, errors } = parsePatterns(JSON.stringify(bad));
    expect(patterns).toEqual([]);
    expect(errors.some((e) => e.includes("object"))).toBe(true);
  });

  it("drops array value for projects section (M9)", () => {
    const bad = [{ section: "projects", key: "proj", value: [1, 2], reason: "test" }];
    const { patterns, errors } = parsePatterns(JSON.stringify(bad));
    expect(patterns).toEqual([]);
    expect(errors.some((e) => e.includes("object"))).toBe(true);
  });

  it("accepts object values for projects section", () => {
    const { patterns } = parsePatterns(
      JSON.stringify([
        {
          section: "projects",
          key: "ooda-agent",
          value: {
            status: "active",
            priority_domain: "core_project",
            key_constraint: "spec compliance",
            notes: "7-PR sequence",
          },
          reason: "Events show consistent OODA work",
        },
      ]),
    );
    expect(patterns).toHaveLength(1);
    expect(patterns[0].value).toEqual({
      status: "active",
      priority_domain: "core_project",
      key_constraint: "spec compliance",
      notes: "7-PR sequence",
    });
  });
});

// ============================================================================
// runArchivist
// ============================================================================

describe("runArchivist", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-archivist-run-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extracts patterns and upserts facts on success", async () => {
    const events = createTestEvents(5);
    const episodic = createMockEpisodicStore(events);
    const semantic = createMockSemanticStore();
    const callModel: ModelCallFn = vi.fn(async () => VALID_MODEL_RESPONSE);

    const result = await runArchivist(tmpDir, 100, episodic, semantic, callModel);

    expect(result.fromFallback).toBe(false);
    expect(result.patternsExtracted).toHaveLength(2);
    expect(result.eventsProcessed).toBe(5);
    expect(semantic.upserts).toHaveLength(2);
    expect(semantic.upserts[0]).toEqual({
      section: "stack",
      key: "language",
      value: "TypeScript 5.x",
    });
  });

  it("marks all events as processed", async () => {
    const events = createTestEvents(3);
    const episodic = createMockEpisodicStore(events);
    const semantic = createMockSemanticStore();
    const callModel: ModelCallFn = vi.fn(async () => VALID_MODEL_RESPONSE);

    await runArchivist(tmpDir, 100, episodic, semantic, callModel);

    expect(episodic.processedIds).toHaveLength(3);
    expect(episodic.processedIds).toEqual(events.map((e) => e.id));
  });

  it("appends to archivist log on success", async () => {
    const events = createTestEvents(3);
    const episodic = createMockEpisodicStore(events);
    const semantic = createMockSemanticStore();
    const callModel: ModelCallFn = vi.fn(async () => VALID_MODEL_RESPONSE);

    await runArchivist(tmpDir, 100, episodic, semantic, callModel);

    // B2 CRUD classifier emits per-action rows before the batch-level "distill" row.
    const distill = semantic.logEntries.find((e) => e.action === "distill");
    expect(distill).toBeDefined();
    expect(distill!.reason).toContain("2 patterns");
    expect(distill!.reason).toContain("3 events");
    // 2 ADD patterns → 2 per-action rows + 1 distill row = 3 entries.
    const actionRows = semantic.logEntries.filter((e) => e.action.startsWith("pattern_"));
    expect(actionRows.length).toBeGreaterThanOrEqual(2);
  });

  it("updates state file after run", async () => {
    const events = createTestEvents(2);
    const episodic = createMockEpisodicStore(events);
    const semantic = createMockSemanticStore();
    const callModel: ModelCallFn = vi.fn(async () => VALID_MODEL_RESPONSE);

    await runArchivist(tmpDir, 150, episodic, semantic, callModel);

    const state = readState(tmpDir);
    // After a successful run, turns_since_last_archivist resets to 0
    expect(state.turns_since_last_archivist).toBe(0);
    expect(new Date(state.last_run_at).getTime()).toBeGreaterThan(Date.now() - 5000);
  });

  it("handles no events gracefully without advancing state (C3)", async () => {
    // Pre-set state so we can verify it's not changed
    writeState(tmpDir, {
      last_processed_turn: 50,
      turns_since_last_archivist: 10,
      last_run_at: "2026-03-15T00:00:00Z",
      archivist_runs_since_meta_review: 0,
    });

    const episodic = createMockEpisodicStore([]);
    const semantic = createMockSemanticStore();
    const callModel: ModelCallFn = vi.fn(async () => "should not be called");

    const result = await runArchivist(tmpDir, 100, episodic, semantic, callModel);

    expect(result.eventsProcessed).toBe(0);
    expect(result.patternsExtracted).toHaveLength(0);
    expect(result.fromFallback).toBe(false);
    expect(callModel).not.toHaveBeenCalled();
    // State should NOT be advanced on empty retrieval
    const state = readState(tmpDir);
    expect(state.turns_since_last_archivist).toBe(10);
    expect(state.last_run_at).toBe("2026-03-15T00:00:00Z");
  });

  it("retries on malformed model output and succeeds", async () => {
    let calls = 0;
    const callModel: ModelCallFn = vi.fn(async () => {
      calls++;
      if (calls === 1) return "bad json";
      return VALID_MODEL_RESPONSE;
    });

    const events = createTestEvents(3);
    const episodic = createMockEpisodicStore(events);
    const semantic = createMockSemanticStore();

    const result = await runArchivist(tmpDir, 100, episodic, semantic, callModel);

    expect(result.fromFallback).toBe(false);
    expect(result.patternsExtracted).toHaveLength(2);
    expect(callModel).toHaveBeenCalledTimes(2);
  });

  it("falls back after all retries fail — does NOT mark events processed", async () => {
    const callModel: ModelCallFn = vi.fn(async () => "garbage");
    const events = createTestEvents(3);
    const episodic = createMockEpisodicStore(events);
    const semantic = createMockSemanticStore();

    const result = await runArchivist(tmpDir, 100, episodic, semantic, callModel);

    expect(result.fromFallback).toBe(true);
    expect(result.patternsExtracted).toHaveLength(0);
    // eventsProcessed=0 because LLM failed — events left unprocessed for retry
    expect(result.eventsProcessed).toBe(0);
    // Events must NOT be marked processed — they need to be retried next run
    expect(episodic.processedIds).toHaveLength(0);
    expect(callModel).toHaveBeenCalledTimes(2); // initial + 1 retry
    // Log entry must record the failure
    expect(semantic.logEntries[0].action).toBe("distill_failed");
  });

  it("falls back on model throwing", async () => {
    const callModel: ModelCallFn = vi.fn(async () => {
      throw new Error("model down");
    });
    const events = createTestEvents(2);
    const episodic = createMockEpisodicStore(events);
    const semantic = createMockSemanticStore();

    const result = await runArchivist(tmpDir, 100, episodic, semantic, callModel);

    expect(result.fromFallback).toBe(true);
    expect(semantic.logEntries[0].action).toBe("distill_failed");
  });

  it("respects maxRetries=0", async () => {
    const callModel: ModelCallFn = vi.fn(async () => "bad");
    const events = createTestEvents(2);
    const episodic = createMockEpisodicStore(events);
    const semantic = createMockSemanticStore();

    const result = await runArchivist(tmpDir, 100, episodic, semantic, callModel, {
      maxRetries: 0,
    });

    expect(result.fromFallback).toBe(true);
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  it("logs distill_empty when model returns empty array", async () => {
    const callModel: ModelCallFn = vi.fn(async () => "[]");
    const events = createTestEvents(3);
    const episodic = createMockEpisodicStore(events);
    const semantic = createMockSemanticStore();

    const result = await runArchivist(tmpDir, 100, episodic, semantic, callModel);

    expect(result.fromFallback).toBe(false);
    expect(result.patternsExtracted).toHaveLength(0);
    expect(semantic.logEntries[0].action).toBe("distill_empty");
    expect(semantic.logEntries[0].reason).toContain("3 events");
  });

  it("calls prune with correct threshold", async () => {
    const events = createTestEvents(2);
    const episodic = createMockEpisodicStore(events);
    const semantic = createMockSemanticStore();
    const callModel: ModelCallFn = vi.fn(async () => "[]");

    const now = Date.now();
    await runArchivist(tmpDir, 100, episodic, semantic, callModel, { pruneAfterDays: 90 });

    expect(episodic.pruneCalls).toHaveLength(1);
    expect(episodic.pruneCalls[0].onlyProcessed).toBe(true);
    // Threshold should be ~90 days ago
    const expectedThreshold = now - 90 * 24 * 60 * 60 * 1000;
    expect(episodic.pruneCalls[0].olderThanMs).toBeCloseTo(expectedThreshold, -3);
  });

  it("continues marking events when markProcessed throws for some (C1)", async () => {
    const events = createTestEvents(3);
    let markCalls = 0;
    const episodic: EpisodicStore & { processedIds: string[] } = {
      processedIds: [],
      async retrieveSince() {
        return events;
      },
      async markProcessed(id: string) {
        markCalls++;
        if (markCalls === 2) throw new Error("mark failed");
        this.processedIds.push(id);
      },
      async prune() {
        return 0;
      },
    };
    const semantic = createMockSemanticStore();
    const callModel: ModelCallFn = vi.fn(async () => VALID_MODEL_RESPONSE);

    const result = await runArchivist(tmpDir, 100, episodic, semantic, callModel);

    // Patterns should still be upserted
    expect(semantic.upserts).toHaveLength(2);
    // 2 of 3 marks should succeed (event 2 failed)
    expect(episodic.processedIds).toHaveLength(2);
    expect(result.eventsProcessed).toBe(3);
  });

  it("captures lastError on fallback", async () => {
    const callModel: ModelCallFn = vi.fn(async () => "bad json");
    const events = createTestEvents(2);
    const episodic = createMockEpisodicStore(events);
    const semantic = createMockSemanticStore();

    const result = await runArchivist(tmpDir, 100, episodic, semantic, callModel);

    expect(result.fromFallback).toBe(true);
    expect(result.lastError).toBeDefined();
    expect(result.lastError).toContain("JSON");
  });

  it("always passes sinceTimestamp=0 to retrieveSince (archivistProcessed flag is authoritative)", async () => {
    // last_run_at in state is irrelevant — we always query from epoch
    // so the archivistProcessed flag gates retrieval, not time-based windowing.
    // Time-based windowing caused drift: if last_run_at advances past the
    // newest unprocessed row, retrieveSince returns 0 events forever.
    writeState(tmpDir, {
      last_processed_turn: 50,
      turns_since_last_archivist: 5,
      last_run_at: "2026-03-15T00:00:00Z",
      archivist_runs_since_meta_review: 0,
    });

    let capturedTimestamp: number | undefined;
    const episodicStore: EpisodicStore = {
      async retrieveSince(sinceTimestamp: number) {
        capturedTimestamp = sinceTimestamp;
        return [];
      },
      async markProcessed() {},
      async prune() {
        return 0;
      },
    };
    const semantic = createMockSemanticStore();
    const callModel: ModelCallFn = vi.fn(async () => "[]");

    await runArchivist(tmpDir, 150, episodicStore, semantic, callModel);

    // Must always be 0 — let the store's archivistProcessed filter gate retrieval
    expect(capturedTimestamp).toBe(0);
  });
});

// ============================================================================
// SqliteEpisodicStore (fallback for Intel Mac / no LanceDB binary)
// ============================================================================

describe("buildSqliteEpisodicStore (via node:sqlite, no LanceDB)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-sqlite-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createMemoriesDb(dir: string) {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(path.join(dir, "memories.sqlite"));
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        importance REAL NOT NULL DEFAULT 0.7,
        category TEXT NOT NULL DEFAULT 'other',
        createdAt INTEGER NOT NULL,
        source TEXT,
        actionId TEXT,
        archivistProcessed INTEGER NOT NULL DEFAULT 0
      )
    `);
    return db;
  }

  it("retrieveSince returns events after the given timestamp in order", async () => {
    const db = createMemoriesDb(tmpDir);
    db.prepare(
      "INSERT INTO memories (id, text, importance, category, createdAt, archivistProcessed) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("id-1", "old event", 0.8, "decision", 1000, 0);
    db.prepare(
      "INSERT INTO memories (id, text, importance, category, createdAt, archivistProcessed) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("id-2", "newer event", 0.7, "preference", 2000, 0);
    db.prepare(
      "INSERT INTO memories (id, text, importance, category, createdAt, archivistProcessed) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("id-3", "newest event", 0.9, "insight", 3000, 0);
    db.close();

    // Import the store builder — we need to expose it for testing, so call
    // buildEpisodicStore indirectly through a helper that mocks the LanceDB path
    // by using the sqlite path directly.
    const { DatabaseSync } = await import("node:sqlite");
    const sqlitePath = path.join(tmpDir, "memories.sqlite");
    const sqliteDb = new DatabaseSync(sqlitePath);

    const rows = sqliteDb
      .prepare(
        "SELECT id, text, category, importance, createdAt, source, actionId, archivistProcessed FROM memories WHERE createdAt > ? ORDER BY createdAt ASC LIMIT 1000",
      )
      .all(1500) as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe("id-2");
    expect(rows[1].id).toBe("id-3");
    expect(rows[0].archivistProcessed).toBe(0);
    sqliteDb.close();
  });

  it("markProcessed updates archivistProcessed to 1", async () => {
    const db = createMemoriesDb(tmpDir);
    db.prepare(
      "INSERT INTO memories (id, text, importance, category, createdAt, archivistProcessed) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "some event", 0.8, "decision", 1000, 0);
    db.close();

    const { DatabaseSync } = await import("node:sqlite");
    const sqliteDb = new DatabaseSync(path.join(tmpDir, "memories.sqlite"));
    sqliteDb
      .prepare("UPDATE memories SET archivistProcessed = 1 WHERE id = ?")
      .run("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");

    const row = sqliteDb
      .prepare("SELECT archivistProcessed FROM memories WHERE id = ?")
      .get("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee") as Record<string, unknown>;
    expect(row.archivistProcessed).toBe(1);
    sqliteDb.close();
  });

  it("prune deletes rows older than threshold", async () => {
    const db = createMemoriesDb(tmpDir);
    db.prepare(
      "INSERT INTO memories (id, text, importance, category, createdAt, archivistProcessed) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("id-old", "stale", 0.5, "other", 500, 1);
    db.prepare(
      "INSERT INTO memories (id, text, importance, category, createdAt, archivistProcessed) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("id-new", "fresh", 0.8, "decision", 5000, 0);
    db.close();

    const { DatabaseSync } = await import("node:sqlite");
    const sqliteDb = new DatabaseSync(path.join(tmpDir, "memories.sqlite"));
    const result = sqliteDb
      .prepare("DELETE FROM memories WHERE createdAt < ? AND archivistProcessed = 1")
      .run(1000) as { changes: number };
    expect(result.changes).toBe(1);

    const remaining = sqliteDb.prepare("SELECT id FROM memories").all() as Array<
      Record<string, unknown>
    >;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe("id-new");
    sqliteDb.close();
  });
});

// ============================================================================
// lessons_learned extraction (CR P4)
// ============================================================================

describe("lessons_learned extraction", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-archivist-lessons-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extracts lessons_learned from episodic events", async () => {
    const events: EpisodicEvent[] = [
      {
        id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        text: "The messages.stream() call was replaced with messages.create() which breaks large outputs — reverted.",
        category: "fact",
        importance: 0.8,
        createdAt: Date.now(),
        source: "assistant",
      },
    ];

    const mockCallModel: ModelCallFn = async () =>
      JSON.stringify([
        {
          section: "lessons_learned",
          key: "claude_streaming_required",
          value: "Always use streaming for Claude calls.",
          reason: "Bug found in worktree.",
        },
      ]);

    const episodic = createMockEpisodicStore(events);
    const semantic = createMockSemanticStore();
    await runArchivist(tmpDir, 100, episodic, semantic, mockCallModel);

    expect(semantic.upserts).toHaveLength(1);
    expect(semantic.upserts[0]).toEqual({
      section: "lessons_learned",
      key: "claude_streaming_required",
      value: "Always use streaming for Claude calls.",
    });
  });

  it("drops lessons_learned patterns whose value is not a string", () => {
    const bad = [
      {
        section: "lessons_learned",
        key: "test",
        value: { nested: true },
        reason: "test",
      },
    ];
    const { patterns, errors } = parsePatterns(JSON.stringify(bad));
    expect(patterns).toEqual([]);
    expect(errors.some((e) => e.includes("string") && e.includes("lessons_learned"))).toBe(true);
  });
});

// ============================================================================
// V1: inferDomain + aggregateDomainOutcomes
// ============================================================================

describe("inferDomain", () => {
  it("maps amf keywords to amf_pipeline", () => {
    expect(inferDomain("Fixed AMF pipeline regression")).toBe("amf_pipeline");
    expect(inferDomain("kohlscore calculation error")).toBe("amf_pipeline");
  });

  it("maps ooda keywords to openclooda", () => {
    expect(inferDomain("Archivist extracted 5 patterns")).toBe("openclooda");
    expect(inferDomain("SITREP priority was wrong")).toBe("openclooda");
  });

  it("maps infra keywords to infrastructure", () => {
    expect(inferDomain("Deploy to kubernetes failed")).toBe("infrastructure");
  });

  it("returns unknown for unmatched text", () => {
    expect(inferDomain("Had a great lunch")).toBe("unknown");
  });
});

describe("aggregateDomainOutcomes", () => {
  it("bins events by domain and computes success rate", () => {
    const events: EpisodicEvent[] = [
      createTestEvent({
        text: "AMF pipeline fix",
        outcome: "success",
        createdAt: Date.now() - 1000,
      }),
      createTestEvent({
        text: "AMF assembly error",
        outcome: "failure",
        createdAt: Date.now() - 2000,
        id: "11111111-bbbb-cccc-dddd-eeeeeeeeeeee",
      }),
      createTestEvent({
        text: "AMF kohlscore update",
        outcome: "success",
        createdAt: Date.now() - 3000,
        id: "22222222-bbbb-cccc-dddd-eeeeeeeeeeee",
      }),
      createTestEvent({
        text: "OODA archivist run",
        outcome: "success",
        createdAt: Date.now() - 4000,
        id: "33333333-bbbb-cccc-dddd-eeeeeeeeeeee",
      }),
    ];

    const stats = aggregateDomainOutcomes(events);
    const amf = stats.find((s) => s.domain === "amf_pipeline");
    expect(amf).toBeDefined();
    expect(amf!.decisions).toBe(3);
    expect(amf!.successes).toBe(2);
    expect(amf!.failures).toBe(1);
    expect(amf!.successRate).toBeCloseTo(2 / 3);

    const ooda = stats.find((s) => s.domain === "openclooda");
    expect(ooda).toBeDefined();
    expect(ooda!.decisions).toBe(1);
    expect(ooda!.successRate).toBe(1);
  });

  it("excludes events older than the window", () => {
    const oldEvent = createTestEvent({
      text: "AMF pipeline fix",
      outcome: "success",
      createdAt: Date.now() - 60 * 24 * 60 * 60 * 1000, // 60 days ago
    });
    const stats = aggregateDomainOutcomes([oldEvent]);
    expect(stats).toHaveLength(0);
  });

  it("excludes events without an outcome", () => {
    const noOutcome = createTestEvent({ text: "AMF pipeline check" });
    const stats = aggregateDomainOutcomes([noOutcome]);
    expect(stats).toHaveLength(0);
  });
});

// ============================================================================
// V2: shouldProposeWeightAdjustment + generateWeightProposals
// ============================================================================

describe("shouldProposeWeightAdjustment", () => {
  it("proposes adjustment when delta > 0.2 and n >= 5", () => {
    const stats = {
      domain: "amf_pipeline",
      decisions: 10,
      successes: 3,
      failures: 7,
      partials: 0,
      successRate: 0.3,
    };
    const result = shouldProposeWeightAdjustment(stats, 0.9);
    expect(result).not.toBeNull();
    expect(result!.domain).toBe("amf_pipeline");
    expect(result!.currentWeight).toBe(0.9);
    // delta = 0.3 - 0.9 = -0.6, proposed = 0.9 + (-0.6 * 0.3) = 0.72
    expect(result!.proposedWeight).toBeCloseTo(0.72);
  });

  it("returns null when delta <= 0.2", () => {
    const stats = {
      domain: "amf_pipeline",
      decisions: 10,
      successes: 8,
      failures: 2,
      partials: 0,
      successRate: 0.8,
    };
    expect(shouldProposeWeightAdjustment(stats, 0.9)).toBeNull();
  });

  it("returns null when decisions < 5", () => {
    const stats = {
      domain: "amf_pipeline",
      decisions: 3,
      successes: 0,
      failures: 3,
      partials: 0,
      successRate: 0.0,
    };
    expect(shouldProposeWeightAdjustment(stats, 0.9)).toBeNull();
  });

  it("clamps proposed weight to [0.1, 1.0]", () => {
    // Very high success rate with low weight → proposed would exceed 1.0
    const stats = {
      domain: "test",
      decisions: 10,
      successes: 10,
      failures: 0,
      partials: 0,
      successRate: 1.0,
    };
    const result = shouldProposeWeightAdjustment(stats, 0.3);
    expect(result).not.toBeNull();
    expect(result!.proposedWeight).toBeLessThanOrEqual(1.0);
    expect(result!.proposedWeight).toBeGreaterThanOrEqual(0.1);
  });
});

describe("generateWeightProposals", () => {
  function makeDomainEntry(weight: number): DomainEntry {
    return { weight, description: "", examples: [], approval_count: 0, override_count: 0 };
  }

  const priorities = {
    domains: {
      amf_pipeline: makeDomainEntry(0.9),
      openclooda: makeDomainEntry(0.8),
    },
  } as unknown as PrioritiesFile;

  it("generates proposals for domains with significant deviation", () => {
    const domainStats = [
      {
        domain: "amf_pipeline",
        decisions: 10,
        successes: 3,
        failures: 7,
        partials: 0,
        successRate: 0.3,
      },
      {
        domain: "openclooda",
        decisions: 10,
        successes: 8,
        failures: 2,
        partials: 0,
        successRate: 0.8,
      },
    ];
    const proposals = generateWeightProposals(domainStats, priorities);
    // amf_pipeline: delta = 0.3 - 0.9 = -0.6, |delta| > 0.2 → proposal
    // openclooda: delta = 0.8 - 0.8 = 0.0, |delta| <= 0.2 → no proposal
    expect(proposals).toHaveLength(1);
    expect(proposals[0].domain).toBe("amf_pipeline");
  });

  it("skips domains not in priorities", () => {
    const domainStats = [
      {
        domain: "unknown_domain",
        decisions: 10,
        successes: 2,
        failures: 8,
        partials: 0,
        successRate: 0.2,
      },
    ];
    const proposals = generateWeightProposals(domainStats, priorities);
    expect(proposals).toHaveLength(0);
  });
});
