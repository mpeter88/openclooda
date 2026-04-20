import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EpisodicEvent, EpisodicStore } from "./archivist.js";
import {
  appendRehearsalRow,
  readRecentRehearsals,
  runPatternDistill,
  runRehearsal,
  runRetrospectiveChair,
} from "./dmn.js";
import { appendSitrepLog } from "./sitrep-log.js";
import type { ModelCallFn } from "./triage.js";
import type { SITREP } from "./types.js";

function writeDefaultWorkspace(tmp: string): void {
  // Seed KNOWLEDGE.json
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
            label: "weekly review",
            recurrence: "weekly",
            day: "Monday",
            time: "09:00",
            timezone: "UTC",
            blocking: true,
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
  // Seed PRIORITIES.json
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
          core: {
            weight: 0.8,
            description: "Primary",
            examples: [],
            approval_count: 0,
            override_count: 0,
          },
        },
        strategy_labels: [
          { label: "minimal_viable_action", description: "Smallest unblocking step" },
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

describe("runRetrospectiveChair", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-dmn-retro-"));
    writeDefaultWorkspace(tmp);
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const mkSitrep = (priority: number): SITREP => ({
    priority: priority as SITREP["priority"],
    summary: "test",
    conflictsDetected: [],
    relevantFacts: [],
    recommendedDomains: [],
  });

  it("evaluated=0 when no qualifying SITREP entries", async () => {
    const callModel: ModelCallFn = vi.fn(async () => "should not fire");
    const r = await runRetrospectiveChair(tmp, callModel, { priorityFloor: 7 });
    expect(r.evaluated).toBe(0);
    expect(callModel).not.toHaveBeenCalled();
  });

  it("emits criticalFailure when adaptive chair is unstable", async () => {
    appendSitrepLog(tmp, mkSitrep(8), "agent:main:x", "high");
    // Return alternating labels so winnerShare stays low.
    let i = 0;
    const labels = [
      "aggressive_fix",
      "minimal_viable_action",
      "observe_and_wait",
      "escalate",
      "aggressive_fix",
    ];
    const callModel: ModelCallFn = vi.fn(async () => {
      const label = labels[i++ % labels.length];
      return JSON.stringify({ label, confidence: 0.8 });
    });
    const r = await runRetrospectiveChair(tmp, callModel);
    expect(r.evaluated).toBe(1);
    expect(r.criticalEmitted).toBe(true);
    expect(fs.existsSync(path.join(tmp, ".critical-failures.jsonl"))).toBe(true);
  });

  it("no criticalFailure when adaptive chair agrees", async () => {
    appendSitrepLog(tmp, mkSitrep(8), "agent:main:x", "high");
    const callModel: ModelCallFn = vi.fn(async () =>
      JSON.stringify({ label: "minimal_viable_action", confidence: 0.9 }),
    );
    const r = await runRetrospectiveChair(tmp, callModel);
    expect(r.evaluated).toBe(1);
    expect(r.criticalEmitted).toBe(false);
  });
});

describe("runRehearsal", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-dmn-reh-"));
    writeDefaultWorkspace(tmp);
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("rehearses the first labeled commitment", async () => {
    const callModel: ModelCallFn = vi.fn(async () =>
      JSON.stringify({
        priority: 6,
        summary: "Weekly review prep",
        conflictsDetected: [],
        relevantFacts: [],
        recommendedDomains: ["core"],
      }),
    );
    const r = await runRehearsal(tmp, callModel);
    expect(r.rehearsed).toBe(true);
    expect(r.commitmentLabel).toBe("weekly review");
    expect(r.cachedSitrep?.priority).toBe(6);
    const rows = readRecentRehearsals(tmp);
    expect(rows).toHaveLength(1);
    expect(rows[0].commitment).toBe("weekly review");
  });

  it("rehearsed=false when no commitments", async () => {
    const knowledgePath = path.join(tmp, "KNOWLEDGE.json");
    const k = JSON.parse(fs.readFileSync(knowledgePath, "utf-8"));
    k.commitments = [];
    fs.writeFileSync(knowledgePath, JSON.stringify(k));
    const callModel: ModelCallFn = vi.fn(async () => "should not fire");
    const r = await runRehearsal(tmp, callModel);
    expect(r.rehearsed).toBe(false);
    expect(callModel).not.toHaveBeenCalled();
  });
});

describe("runPatternDistill", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-dmn-distill-"));
    writeDefaultWorkspace(tmp);
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const mkEvent = (id: string, text: string): EpisodicEvent => ({
    id,
    text,
    category: "decision",
    importance: 0.5,
    createdAt: Date.now() - 1000,
    archivistProcessed: false,
  });

  function mockStore(events: EpisodicEvent[]): EpisodicStore {
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

  it("returns 0/0 when store is null", async () => {
    const callModel: ModelCallFn = vi.fn(async () => "should not fire");
    const r = await runPatternDistill(tmp, callModel, null);
    expect(r).toEqual({ candidatesAdded: 0, eventsScanned: 0 });
    expect(callModel).not.toHaveBeenCalled();
  });

  it("returns 0 when no events available", async () => {
    const callModel: ModelCallFn = vi.fn(async () => "should not fire");
    const store = mockStore([]);
    const r = await runPatternDistill(tmp, callModel, store);
    expect(r.candidatesAdded).toBe(0);
    expect(r.eventsScanned).toBe(0);
    expect(callModel).not.toHaveBeenCalled();
  });

  it("adds high-confidence candidates as proposals", async () => {
    const store = mockStore([
      mkEvent("e1", "archivist run landed clean"),
      mkEvent("e2", "council dissent on staging deploy"),
    ]);
    const callModel: ModelCallFn = vi.fn(async () =>
      JSON.stringify([
        {
          proposal: "pattern A — archivist landings correlate with staging freezes",
          confidence: 0.75,
          rationale: "noticed",
        },
        {
          proposal: "low-confidence noise",
          confidence: 0.3,
          rationale: "weak signal",
        },
      ]),
    );
    const r = await runPatternDistill(tmp, callModel, store);
    expect(r.eventsScanned).toBe(2);
    expect(r.candidatesAdded).toBe(1);
  });

  it("returns 0 on malformed model output", async () => {
    const store = mockStore([mkEvent("e1", "anything")]);
    const callModel: ModelCallFn = vi.fn(async () => "not json");
    const r = await runPatternDistill(tmp, callModel, store);
    expect(r.candidatesAdded).toBe(0);
  });
});

describe("rehearsal sidecar helpers", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-dmn-reh-file-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("append + read round-trip", () => {
    appendRehearsalRow(tmp, {
      rehearsedAt: new Date().toISOString(),
      commitment: "a",
      syntheticObservation: "obs",
      sitrep: {
        priority: 5,
        summary: "",
        conflictsDetected: [],
        relevantFacts: [],
        recommendedDomains: [],
      },
    });
    expect(readRecentRehearsals(tmp)).toHaveLength(1);
  });

  it("empty array when file missing", () => {
    expect(readRecentRehearsals(tmp)).toEqual([]);
  });
});
