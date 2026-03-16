import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCallFn } from "../../src/agents/ooda/triage.js";
import {
  buildArchivistPrompt,
  parsePatterns,
  readState,
  runArchivist,
  shouldRunArchivist,
  statePath,
  writeState,
  type ArchivistState,
  type EpisodicEvent,
  type EpisodicStore,
  type PatternExtraction,
  type SemanticStore,
} from "./archivist.js";

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
      expect(state.last_run_turn).toBe(0);
      expect(state.last_run_at).toBe("1970-01-01T00:00:00Z");
    });

    it("reads existing state file", () => {
      const state: ArchivistState = {
        last_run_turn: 200,
        last_run_at: "2026-03-15T10:00:00Z",
      };
      fs.writeFileSync(statePath(tmpDir), JSON.stringify(state));

      const result = readState(tmpDir);
      expect(result.last_run_turn).toBe(200);
      expect(result.last_run_at).toBe("2026-03-15T10:00:00Z");
    });

    it("throws on malformed state file", () => {
      fs.writeFileSync(statePath(tmpDir), "not json");
      expect(() => readState(tmpDir)).toThrow();
    });

    it("throws on missing required fields", () => {
      fs.writeFileSync(statePath(tmpDir), JSON.stringify({ last_run_turn: 5 }));
      expect(() => readState(tmpDir)).toThrow("missing last_run_turn or last_run_at");
    });

    it("throws on invalid timestamp (M7)", () => {
      fs.writeFileSync(
        statePath(tmpDir),
        JSON.stringify({ last_run_turn: 5, last_run_at: "not-a-date" }),
      );
      expect(() => readState(tmpDir)).toThrow("not a valid timestamp");
    });
  });

  describe("writeState", () => {
    it("writes state to disk", () => {
      writeState(tmpDir, { last_run_turn: 100, last_run_at: "2026-03-16T12:00:00Z" });

      const state = readState(tmpDir);
      expect(state.last_run_turn).toBe(100);
      expect(state.last_run_at).toBe("2026-03-16T12:00:00Z");
    });

    it("creates parent directories if needed", () => {
      const deepPath = path.join(tmpDir, "deep", "nested");
      writeState(deepPath, { last_run_turn: 50, last_run_at: "2026-03-16T12:00:00Z" });
      expect(fs.existsSync(statePath(deepPath))).toBe(true);
    });
  });
});

// ============================================================================
// shouldRunArchivist
// ============================================================================

describe("shouldRunArchivist", () => {
  it("returns true when enough turns have passed", () => {
    const state: ArchivistState = { last_run_turn: 0, last_run_at: "2026-03-15T00:00:00Z" };
    expect(shouldRunArchivist(100, state, 100)).toBe(true);
  });

  it("returns false when not enough turns have passed", () => {
    const state: ArchivistState = { last_run_turn: 0, last_run_at: "2026-03-15T00:00:00Z" };
    expect(shouldRunArchivist(99, state, 100)).toBe(false);
  });

  it("returns true when more than interval turns have passed", () => {
    const state: ArchivistState = { last_run_turn: 50, last_run_at: "2026-03-15T00:00:00Z" };
    expect(shouldRunArchivist(200, state, 100)).toBe(true);
  });

  it("returns false when turnInterval is 0", () => {
    const state: ArchivistState = { last_run_turn: 0, last_run_at: "2026-03-15T00:00:00Z" };
    expect(shouldRunArchivist(1000, state, 0)).toBe(false);
  });

  it("returns false when turnInterval is negative", () => {
    const state: ArchivistState = { last_run_turn: 0, last_run_at: "2026-03-15T00:00:00Z" };
    expect(shouldRunArchivist(1000, state, -1)).toBe(false);
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
    expect(prompt).toContain("stack: string value");
    expect(prompt).toContain("projects: object with");
    expect(prompt).toContain("people: object with");
    expect(prompt).toContain("domain_context: string value");
  });

  it("includes constraint about max 10 patterns", () => {
    const prompt = buildArchivistPrompt([createTestEvent()]);
    expect(prompt).toContain("Maximum 10 patterns");
  });

  it("includes the 2-event citation requirement", () => {
    const prompt = buildArchivistPrompt([createTestEvent()]);
    expect(prompt).toContain("at least 2 supporting events");
  });

  it("includes output format instructions", () => {
    const prompt = buildArchivistPrompt([createTestEvent()]);
    expect(prompt).toContain("Respond with raw JSON only");
    expect(prompt).toContain("Do not wrap in code fences");
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
    const patterns = parsePatterns(VALID_MODEL_RESPONSE);
    expect(patterns).toHaveLength(2);
    expect(patterns[0].section).toBe("stack");
    expect(patterns[0].key).toBe("language");
    expect(patterns[0].value).toBe("TypeScript 5.x");
    expect(patterns[1].section).toBe("domain_context");
  });

  it("parses empty array", () => {
    const patterns = parsePatterns("[]");
    expect(patterns).toHaveLength(0);
  });

  it("strips markdown code fences", () => {
    const wrapped = "```json\n" + VALID_MODEL_RESPONSE + "\n```";
    const patterns = parsePatterns(wrapped);
    expect(patterns).toHaveLength(2);
  });

  it("rejects non-array response", () => {
    expect(() => parsePatterns('{"key": "value"}')).toThrow("must be a JSON array");
  });

  it("rejects too many patterns", () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      section: "stack",
      key: `key${i}`,
      value: "v",
      reason: "r",
    }));
    expect(() => parsePatterns(JSON.stringify(many))).toThrow("Too many patterns: 11");
  });

  it("rejects invalid section", () => {
    const bad = [{ section: "invalid", key: "k", value: "v", reason: "r" }];
    expect(() => parsePatterns(JSON.stringify(bad))).toThrow("section must be one of");
  });

  it("rejects missing key", () => {
    const bad = [{ section: "stack", key: "", value: "v", reason: "r" }];
    expect(() => parsePatterns(JSON.stringify(bad))).toThrow("non-empty key");
  });

  it("rejects null value", () => {
    const bad = [{ section: "stack", key: "k", value: null, reason: "r" }];
    expect(() => parsePatterns(JSON.stringify(bad))).toThrow("non-null value");
  });

  it("rejects missing reason", () => {
    const bad = [{ section: "stack", key: "k", value: "v", reason: "" }];
    expect(() => parsePatterns(JSON.stringify(bad))).toThrow("non-empty reason");
  });

  it("rejects invalid JSON", () => {
    expect(() => parsePatterns("not json")).toThrow();
  });

  it("rejects non-string value for stack section (M9)", () => {
    const bad = [{ section: "stack", key: "lang", value: { nested: true }, reason: "test" }];
    expect(() => parsePatterns(JSON.stringify(bad))).toThrow("must be a string for section");
  });

  it("rejects non-string value for domain_context section (M9)", () => {
    const bad = [{ section: "domain_context", key: "focus", value: 42, reason: "test" }];
    expect(() => parsePatterns(JSON.stringify(bad))).toThrow("must be a string for section");
  });

  it("rejects non-object value for people section (M9)", () => {
    const bad = [{ section: "people", key: "alice", value: "just a string", reason: "test" }];
    expect(() => parsePatterns(JSON.stringify(bad))).toThrow("must be an object for section");
  });

  it("rejects array value for projects section (M9)", () => {
    const bad = [{ section: "projects", key: "proj", value: [1, 2], reason: "test" }];
    expect(() => parsePatterns(JSON.stringify(bad))).toThrow("must be an object for section");
  });

  it("accepts object values for projects section", () => {
    const patterns = parsePatterns(
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

    expect(semantic.logEntries).toHaveLength(1);
    expect(semantic.logEntries[0].action).toBe("distill");
    expect(semantic.logEntries[0].reason).toContain("2 patterns");
    expect(semantic.logEntries[0].reason).toContain("3 events");
  });

  it("updates state file after run", async () => {
    const events = createTestEvents(2);
    const episodic = createMockEpisodicStore(events);
    const semantic = createMockSemanticStore();
    const callModel: ModelCallFn = vi.fn(async () => VALID_MODEL_RESPONSE);

    await runArchivist(tmpDir, 150, episodic, semantic, callModel);

    const state = readState(tmpDir);
    expect(state.last_run_turn).toBe(150);
    expect(new Date(state.last_run_at).getTime()).toBeGreaterThan(Date.now() - 5000);
  });

  it("handles no events gracefully without advancing state (C3)", async () => {
    // Pre-set state so we can verify it's not changed
    writeState(tmpDir, { last_run_turn: 50, last_run_at: "2026-03-15T00:00:00Z" });

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
    expect(state.last_run_turn).toBe(50);
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

  it("falls back after all retries fail", async () => {
    const callModel: ModelCallFn = vi.fn(async () => "garbage");
    const events = createTestEvents(3);
    const episodic = createMockEpisodicStore(events);
    const semantic = createMockSemanticStore();

    const result = await runArchivist(tmpDir, 100, episodic, semantic, callModel);

    expect(result.fromFallback).toBe(true);
    expect(result.patternsExtracted).toHaveLength(0);
    expect(result.eventsProcessed).toBe(3);
    // Events should still be marked processed
    expect(episodic.processedIds).toHaveLength(3);
    expect(callModel).toHaveBeenCalledTimes(2); // initial + 1 retry
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

  it("uses sinceTimestamp from state file for retrieval", async () => {
    // Write a state file with a known last_run_at
    writeState(tmpDir, {
      last_run_turn: 50,
      last_run_at: "2026-03-15T00:00:00Z",
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

    expect(capturedTimestamp).toBe(new Date("2026-03-15T00:00:00Z").getTime());
  });
});
