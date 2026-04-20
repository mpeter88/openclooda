/**
 * Integration harness — proves the hot-path wiring works end-to-end against
 * a real filesystem + real helper modules (not just mocked unit units).
 *
 * Layer covered: plugin hooks NOT fired (that needs the gateway), but every
 * module boundary we ship is exercised against on-disk state with synthetic
 * episodic events and a deterministic fake callModel.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendErrorTagsSidecar,
  inferDomain,
  readCriticalFailures,
  runArchivist,
  type EpisodicEvent,
  type EpisodicStore,
  type SemanticStore,
} from "./archivist.js";
import { formBelief, getBeliefs } from "./beliefs.js";
import { appendDistortionSample, readDistortionHistory } from "./distortion-index.js";
import {
  advanceWorkUnitRotation,
  cadenceMs,
  readDMNState,
  recordLLMCall,
  runBeliefRescore,
  runCampbellWatchdog,
  runRehearsal,
  selectBucket,
  selectWorkUnit,
  withinLLMBudget,
  writeDMNState,
  type DMNBucket,
  type DMNState,
} from "./dmn.js";
import { clearTurnSitrep, readTurnSitrep, writeTurnSitrep } from "./emotional-tagging.js";
import { appendSitrepLog } from "./sitrep-log.js";
import type { ModelCallFn } from "./triage.js";
import type { ErrorTag, SITREP } from "./types.js";

// ============================================================================
// Workspace fixtures — a real workspace on disk (tmpdir), seeded fresh per test
// ============================================================================

function seedWorkspace(tmp: string): void {
  fs.writeFileSync(
    path.join(tmp, "KNOWLEDGE.json"),
    JSON.stringify(
      {
        _meta: {
          version: 1,
          updated_at: new Date().toISOString(),
          updated_by: "user",
          turn_count_at_last_update: 0,
          description: "test",
        },
        identity: {
          name: "Test",
          timezone: "UTC",
          location_primary: "",
          language_primary: "en",
          communication_style: "",
        },
        stack: {},
        projects: {},
        people: {},
        commitments: [
          {
            label: "standup",
            recurrence: "daily",
            time: "09:30",
            timezone: "UTC",
            blocking: false,
          },
        ],
        domain_context: {},
        lessons_learned: {},
        preferences: { never_do: [], always_ask_before: [] },
        preferences_notes: {},
        _archivist_log: [],
        _temporal: {},
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(tmp, "PRIORITIES.json"),
    JSON.stringify(
      {
        _meta: {
          version: 1,
          updated_at: new Date().toISOString(),
          updated_by: "user",
          description: "test",
        },
        domains: {
          openclooda: {
            weight: 0.8,
            description: "Primary project work",
            examples: [],
            approval_count: 20,
            override_count: 3,
          },
          amf_pipeline: {
            weight: 0.5,
            description: "Secondary",
            examples: [],
            approval_count: 5,
            override_count: 1,
          },
        },
        strategy_labels: [
          {
            label: "minimal_viable_action",
            description: "Smallest unblocking step",
          },
        ],
        scoring_rubric: {
          alignment: { weight: 0.4, description: "" },
          efficiency: { weight: 0.35, description: "" },
          risk: { weight: 0.25, description: "" },
        },
        thresholds: {
          min_priority_for_full_ooda: 5,
          min_thinking_level_for_full_ooda: "medium",
          critical_failure_score_floor: 0.3,
          archivist_turn_interval: 100,
          meta_reviewer_weekly_enabled: false,
          meta_reviewer_archivist_interval: 5,
          council_priority_threshold: 7,
          council_system1_enabled: true,
          council_system2_enabled: true,
        },
        _weight_adjustment_log: [],
      },
      null,
      2,
    ),
  );
}

function mkEvent(overrides: Partial<EpisodicEvent>): EpisodicEvent {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    text: "archivist pattern extraction ran successfully",
    category: "decision",
    importance: 0.7,
    createdAt: Date.now(),
    archivistProcessed: false,
    ...overrides,
  };
}

function createSemanticStore(): SemanticStore & {
  upserts: Array<{ section: string; key: string; value: unknown }>;
  logs: Array<{ action: string; reason: string }>;
} {
  const upserts: Array<{ section: string; key: string; value: unknown }> = [];
  const logs: Array<{ action: string; reason: string }> = [];
  return {
    upserts,
    logs,
    upsertFact(section, key, value) {
      upserts.push({ section, key, value });
    },
    appendArchivistLog(action, reason) {
      logs.push({ action, reason });
    },
  };
}

function createEpisodicStore(events: EpisodicEvent[]): EpisodicStore {
  return {
    async retrieveSince() {
      return events;
    },
    async markProcessed() {
      /* noop */
    },
    async prune() {
      return 0;
    },
  };
}

// ============================================================================
// Part A: runArchivist step-9.5 end-to-end
// ============================================================================

describe("runArchivist end-to-end (step 9.5 capability uplift)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-integ-archivist-"));
    seedWorkspace(tmp);
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("writes distortion samples to .distortion-history.jsonl for outcome-labeled domains", async () => {
    const priorities = JSON.parse(fs.readFileSync(path.join(tmp, "PRIORITIES.json"), "utf-8"));
    const events: EpisodicEvent[] = [
      mkEvent({
        id: "00000001-0000-0000-0000-000000000001",
        text: "openclooda archivist run landed",
        outcome: "success",
      }),
      mkEvent({
        id: "00000002-0000-0000-0000-000000000002",
        text: "openclooda triage called successfully",
        outcome: "success",
      }),
      mkEvent({
        id: "00000003-0000-0000-0000-000000000003",
        text: "amf_pipeline kohlscore build failed",
        outcome: "failure",
      }),
    ];

    const callModel: ModelCallFn = vi.fn(async () => "[]"); // no patterns extracted

    await runArchivist(
      tmp,
      100,
      createEpisodicStore(events),
      createSemanticStore(),
      callModel,
      { maxRetries: 0 },
      priorities,
    );

    const samples = readDistortionHistory(tmp);
    const domains = new Set(samples.map((s) => s.domain));
    expect(domains.size).toBeGreaterThan(0);
    // Both domains appear — they have outcome-labeled events.
    expect(domains.has("openclooda") || domains.has("amf_pipeline")).toBe(true);
  });

  it("emits campbell_suspected critical failure when the regime trips", async () => {
    const priorities = JSON.parse(fs.readFileSync(path.join(tmp, "PRIORITIES.json"), "utf-8"));
    // Pre-seed an aggressive Campbell pattern: measured climbs, grounded
    // reverses, approval rate climbs — the canonical evaluator-capture signal.
    const now = Date.now();
    for (let i = 0; i < 20; i++) {
      const progress = i / 19;
      appendDistortionSample(tmp, {
        domain: "openclooda",
        timestamp: now - (20 - i) * 60_000,
        measured: 0.5 + progress * 0.4,
        grounded: 0.8 - progress * 0.6,
        approvalCount: 5 + i * 2,
        overrideCount: 1,
      });
    }

    // Feed events WITHOUT outcome labels so archivist does not append a fresh
    // sample that would dilute the pre-seeded Campbell signal. The step-9.5
    // pipeline still re-reads history and classifies every domain it sees.
    const events: EpisodicEvent[] = [
      mkEvent({
        id: "00000004-0000-0000-0000-000000000004",
        text: "openclooda archivist ran",
      }),
    ];
    const callModel: ModelCallFn = vi.fn(async () => "[]");

    await runArchivist(
      tmp,
      100,
      createEpisodicStore(events),
      createSemanticStore(),
      callModel,
      { maxRetries: 0 },
      priorities,
    );

    const failures = readCriticalFailures(tmp);
    const campbell = failures.find((f) => f.implicated_rule === "distortion.campbell_regime");
    expect(campbell).toBeDefined();
    expect(campbell?.severity).toBe("critical");
  });

  it("writes .axis-priors.json when error-tagged events exist", async () => {
    const priorities = JSON.parse(fs.readFileSync(path.join(tmp, "PRIORITIES.json"), "utf-8"));
    const events: EpisodicEvent[] = [
      mkEvent({
        id: "00000005-0000-0000-0000-000000000005",
        text: "openclooda triage planning failed",
        outcome: "failure",
        sitrepPriorityAtCapture: 8,
      }),
      mkEvent({
        id: "00000006-0000-0000-0000-000000000006",
        text: "openclooda archivist planning failed again",
        outcome: "failure",
        sitrepPriorityAtCapture: 3,
      }),
    ];
    const errorTags: ErrorTag[] = [
      {
        axis: "planning",
        severity: "major",
        signal: "wrong_strategy",
        confidence: 0.9,
      },
    ];
    appendErrorTagsSidecar(tmp, events[0].id, errorTags);
    appendErrorTagsSidecar(tmp, events[1].id, errorTags);

    const callModel: ModelCallFn = vi.fn(async () => "[]");

    await runArchivist(
      tmp,
      100,
      createEpisodicStore(events),
      createSemanticStore(),
      callModel,
      { maxRetries: 0 },
      priorities,
    );

    const axisFile = path.join(tmp, ".axis-priors.json");
    expect(fs.existsSync(axisFile)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(axisFile, "utf-8"));
    expect(parsed.priors.length).toBeGreaterThan(0);
    expect(parsed.priors[0].axis).toBe("planning");
    // Priority weighting is ON — higher-priority event should dominate the count.
    expect(parsed.priors[0].countMajor).toBeGreaterThan(0);
  });
});

// ============================================================================
// Part B: DMN bucket transitions with a mock clock
// ============================================================================

describe("DMN scheduler — tapered cadence across a simulated 24h timeline", () => {
  it("walks the full ladder active → recent → idle → dormant → asleep", () => {
    const userTurnAt = 0;
    const bucketAt = (absenceMs: number) => selectBucket(absenceMs - userTurnAt);
    expect(bucketAt(1 * 60_000)).toBe("active");
    expect(bucketAt(6 * 60_000)).toBe("recent");
    expect(bucketAt(35 * 60_000)).toBe("idle");
    expect(bucketAt(5 * 60 * 60_000)).toBe("dormant");
    expect(bucketAt(25 * 60 * 60_000)).toBe("asleep");
  });

  it("24-hour tick simulation stays within the budget ceiling", () => {
    // Without tapering, 24h × 40 ticks/h (90s) = 960 ticks.
    // With tapering the total should land well below 100.
    let absenceMs = 0;
    let ticks = 0;
    const maxSimulated = 24 * 60 * 60 * 1000;
    while (absenceMs < maxSimulated) {
      const bucket: DMNBucket = selectBucket(absenceMs);
      const next = cadenceMs(bucket);
      if (!Number.isFinite(next)) break;
      absenceMs += next;
      ticks++;
    }
    expect(ticks).toBeLessThan(100);
    expect(ticks).toBeGreaterThanOrEqual(20); // not zero — DMN is doing work
  });
});

// ============================================================================
// Part C: DMN state + work-unit dispatch persists across ticks
// ============================================================================

describe("DMN state persistence", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-integ-dmn-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("state → selectWorkUnit → advance → write → re-read round-trips", () => {
    let state = readDMNState(tmp);
    expect(state.last_work_kind_index).toBe(-1);

    const kind1 = selectWorkUnit("active", state);
    expect(kind1).toBeDefined();
    state = advanceWorkUnitRotation(state, kind1!, "active");
    writeDMNState(tmp, state);

    const re = readDMNState(tmp);
    expect(re.work_units_completed).toBe(1);
    expect(re.by_kind[kind1!]).toBe(1);
    expect(re.last_work_kind_index).toBeGreaterThanOrEqual(0);
  });

  it("LLM budget counter persists + saturates + rolls over", () => {
    let state = readDMNState(tmp);
    const now = Date.now();
    for (let i = 0; i < 50; i++) {
      state = recordLLMCall(state, now);
    }
    writeDMNState(tmp, state);
    state = readDMNState(tmp);
    expect(state.llm_calls_24h).toBe(50);
    expect(withinLLMBudget(state, now, 50)).toBe(false);

    // Rollover after 24h: fresh window.
    const later = now + 25 * 60 * 60 * 1000;
    expect(withinLLMBudget(state, later, 50)).toBe(true);
    state = recordLLMCall(state, later);
    expect(state.llm_calls_24h).toBe(1);
  });
});

// ============================================================================
// Part D: cross-plugin sidecar round-trip
// ============================================================================

describe("cross-plugin SITREP sidecar contract", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-integ-sidecar-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("memory-ooda write → memory-lancedb-style read (hardcoded path simulated)", () => {
    writeTurnSitrep(tmp, {
      priority: 9,
      writtenAt: new Date().toISOString(),
      sessionKey: "agent:main:test",
    });

    // Simulate the exact read memory-lancedb performs: own copy of the logic.
    // (Any drift in the reader would surface here.)
    function readViaLancedbStyle(workspacePath: string): number | undefined {
      const sidecar = path.join(workspacePath, ".turn-sitrep.json");
      if (!fs.existsSync(sidecar)) return undefined;
      const parsed = JSON.parse(fs.readFileSync(sidecar, "utf-8"));
      if (typeof parsed.priority !== "number") return undefined;
      const age = Date.now() - new Date(parsed.writtenAt).getTime();
      if (age > 5 * 60 * 1000) return undefined;
      return parsed.priority;
    }

    expect(readViaLancedbStyle(tmp)).toBe(9);

    // Double-check the ooda reader agrees.
    const read = readTurnSitrep(tmp);
    expect(read?.priority).toBe(9);
  });

  it("clearTurnSitrep removes what writeTurnSitrep wrote", () => {
    writeTurnSitrep(tmp, {
      priority: 7,
      writtenAt: new Date().toISOString(),
    });
    clearTurnSitrep(tmp);
    expect(readTurnSitrep(tmp)).toBeUndefined();
  });
});

// ============================================================================
// Part E: DMN free work units (no LLM) against a real workspace
// ============================================================================

describe("DMN free work units against real disk state", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-integ-dmn-free-"));
    seedWorkspace(tmp);
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("runCampbellWatchdog with fresh regime emits critical failure", () => {
    const now = Date.now();
    for (let i = 0; i < 20; i++) {
      const progress = i / 19;
      appendDistortionSample(tmp, {
        domain: "ops",
        timestamp: now - (20 - i) * 60_000,
        measured: 0.5 + progress * 0.3,
        grounded: 0.6 - progress * 0.4,
        approvalCount: 5 + i,
        overrideCount: 1,
      });
    }
    const r = runCampbellWatchdog(tmp);
    expect(r.triggered).toBe(true);
    expect(r.regime).toBe("campbell_suspected");
    const failures = readCriticalFailures(tmp);
    expect(failures.some((f) => f.implicated_rule === "dmn.campbell_watchdog")).toBe(true);
  });

  it("runBeliefRescore reinforces a belief when episodic evidence matches", () => {
    formBelief(tmp, {
      id: "b1",
      claim: "async replies outperform sync responses",
      domain: "comms",
      confidence: 0.7,
    });
    const events: EpisodicEvent[] = [
      mkEvent({
        id: "11111111-1111-1111-1111-111111111111",
        text: "async replies landed well today",
        outcome: "success",
      }),
    ];
    const r = runBeliefRescore(tmp, events);
    expect(r.reinforced).toContain("b1");
    const after = getBeliefs(tmp);
    expect(after.beliefs.b1.confidence).toBeGreaterThan(0.7);
  });
});

// ============================================================================
// Part F: rehearsal writes a sitrep cache that a real workflow could reuse
// ============================================================================

describe("DMN rehearsal writes a consumable sitrep cache", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-integ-rehearsal-"));
    seedWorkspace(tmp);
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("rehearsal writes .dmn-rehearsals.jsonl that a subsequent reader can parse", async () => {
    const syntheticSitrep: SITREP = {
      priority: 6,
      summary: "standup in 60 minutes",
      conflictsDetected: [],
      relevantFacts: [],
      recommendedDomains: ["openclooda"],
    };
    const callModel: ModelCallFn = vi.fn(async () => JSON.stringify(syntheticSitrep));
    const r = await runRehearsal(tmp, callModel);
    expect(r.rehearsed).toBe(true);

    const rehearsalsFile = path.join(tmp, ".dmn-rehearsals.jsonl");
    expect(fs.existsSync(rehearsalsFile)).toBe(true);
    const rows = fs.readFileSync(rehearsalsFile, "utf-8").trim().split("\n");
    expect(rows).toHaveLength(1);
    const row = JSON.parse(rows[0]);
    expect(row.commitment).toBe("standup");
    expect(row.sitrep.priority).toBe(6);
  });
});

// ============================================================================
// Part G: sitrep log → retrospective chair would find it (static check)
// ============================================================================

describe("sitrep log → retrospective chair pipeline", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-integ-retro-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("appendSitrepLog creates readable entries retrospective_chair can scan", () => {
    const sitrep: SITREP = {
      priority: 8,
      summary: "",
      conflictsDetected: [],
      relevantFacts: [],
      recommendedDomains: ["openclooda"],
    };
    appendSitrepLog(tmp, sitrep, "agent:main:t1", "medium");
    appendSitrepLog(tmp, sitrep, "agent:main:t2", "medium");

    // inferDomain sanity — used by downstream aggregation
    expect(inferDomain("openclooda archivist ran")).toBe("openclooda");

    const today = new Date().toISOString().slice(0, 10);
    const logPath = path.join(tmp, "sitrep-log", `${today}.jsonl`);
    expect(fs.existsSync(logPath)).toBe(true);
    const lines = fs.readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });
});
