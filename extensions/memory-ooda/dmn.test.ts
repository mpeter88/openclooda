import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EpisodicEvent } from "./archivist.js";
import { formBelief } from "./beliefs.js";
import { appendDistortionSample } from "./distortion-index.js";
import {
  DEFAULT_DMN_CONFIG,
  DEFAULT_WORK_UNIT_FLAGS,
  advanceWorkUnitRotation,
  cadenceMs,
  eligibleWorkKinds,
  isLLMBackedKind,
  readDMNState,
  recordLLMCall,
  runBeliefRescore,
  runCampbellWatchdog,
  selectBucket,
  selectWorkUnit,
  withinLLMBudget,
  writeDMNState,
  type DMNState,
} from "./dmn.js";

describe("selectBucket", () => {
  it("active when user turn within 5 min", () => {
    expect(selectBucket(0)).toBe("active");
    expect(selectBucket(4 * 60 * 1000)).toBe("active");
  });

  it("recent when 5-30 min absent", () => {
    expect(selectBucket(5 * 60 * 1000)).toBe("recent");
    expect(selectBucket(29 * 60 * 1000)).toBe("recent");
  });

  it("idle when 30 min - 4 h absent", () => {
    expect(selectBucket(30 * 60 * 1000)).toBe("idle");
    expect(selectBucket(3 * 60 * 60 * 1000)).toBe("idle");
  });

  it("dormant when 4-24 h absent", () => {
    expect(selectBucket(4 * 60 * 60 * 1000)).toBe("dormant");
    expect(selectBucket(23 * 60 * 60 * 1000)).toBe("dormant");
  });

  it("asleep beyond 24 h", () => {
    expect(selectBucket(25 * 60 * 60 * 1000)).toBe("asleep");
    expect(selectBucket(100 * 60 * 60 * 1000)).toBe("asleep");
  });
});

describe("cadenceMs", () => {
  it("active=90s, recent=5m, idle=15m, dormant=60m, asleep=infinity", () => {
    expect(cadenceMs("active")).toBe(90 * 1000);
    expect(cadenceMs("recent")).toBe(5 * 60 * 1000);
    expect(cadenceMs("idle")).toBe(15 * 60 * 1000);
    expect(cadenceMs("dormant")).toBe(60 * 60 * 1000);
    expect(cadenceMs("asleep")).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("eligibleWorkKinds", () => {
  it("excludes pattern_distill in active/recent", () => {
    expect(eligibleWorkKinds("active")).not.toContain("pattern_distill");
    expect(eligibleWorkKinds("recent")).not.toContain("pattern_distill");
  });

  it("excludes retrospective_chair + rehearsal in idle/dormant", () => {
    expect(eligibleWorkKinds("idle")).not.toContain("retrospective_chair");
    expect(eligibleWorkKinds("idle")).not.toContain("rehearsal");
    expect(eligibleWorkKinds("dormant")).not.toContain("retrospective_chair");
  });

  it("asleep excludes everything", () => {
    expect(eligibleWorkKinds("asleep")).toHaveLength(0);
  });
});

describe("isLLMBackedKind", () => {
  it("flags retrospective_chair/rehearsal/pattern_distill", () => {
    expect(isLLMBackedKind("retrospective_chair")).toBe(true);
    expect(isLLMBackedKind("rehearsal")).toBe(true);
    expect(isLLMBackedKind("pattern_distill")).toBe(true);
  });

  it("belief_rescore + campbell_watchdog are free", () => {
    expect(isLLMBackedKind("belief_rescore")).toBe(false);
    expect(isLLMBackedKind("campbell_watchdog")).toBe(false);
  });
});

describe("selectWorkUnit", () => {
  const emptyState: DMNState = {
    last_tick_at: null,
    bucket: "active",
    ticks_since_last_user_turn: 0,
    work_units_completed: 0,
    by_kind: {},
    last_work_kind_index: -1,
    llm_calls_24h: 0,
    llm_calls_24h_window_start: null,
  };

  it("respects flags when selecting", () => {
    const flags = {
      belief_rescore: true,
      retrospective_chair: false,
      rehearsal: false,
      pattern_distill: false,
      campbell_watchdog: true,
    };
    const kind = selectWorkUnit("active", emptyState, flags);
    expect(["belief_rescore", "campbell_watchdog"]).toContain(kind);
  });

  it("rotates across eligible kinds", () => {
    const flags = { ...DEFAULT_WORK_UNIT_FLAGS };
    let state: DMNState = { ...emptyState };
    const picked: string[] = [];
    for (let i = 0; i < 3; i++) {
      const k = selectWorkUnit("active", state, flags);
      expect(k).toBeDefined();
      picked.push(k!);
      state = advanceWorkUnitRotation(state, k!, "active", flags);
    }
    // With both eligible kinds on (belief_rescore + campbell_watchdog), picks should alternate.
    expect(picked[0]).not.toBe(picked[1]);
  });

  it("returns undefined when asleep", () => {
    expect(selectWorkUnit("asleep", emptyState)).toBeUndefined();
  });

  it("returns undefined when all flags off", () => {
    const flags = {
      belief_rescore: false,
      retrospective_chair: false,
      rehearsal: false,
      pattern_distill: false,
      campbell_watchdog: false,
    };
    expect(selectWorkUnit("active", emptyState, flags)).toBeUndefined();
  });
});

describe("LLM budget", () => {
  const base: DMNState = {
    last_tick_at: null,
    bucket: "active",
    ticks_since_last_user_turn: 0,
    work_units_completed: 0,
    by_kind: {},
    last_work_kind_index: -1,
    llm_calls_24h: 0,
    llm_calls_24h_window_start: null,
  };

  it("within budget when counter below cap", () => {
    expect(withinLLMBudget(base, Date.now(), 50)).toBe(true);
  });

  it("rejects beyond cap within window", () => {
    const now = Date.now();
    const state = {
      ...base,
      llm_calls_24h: 50,
      llm_calls_24h_window_start: new Date(now - 60_000).toISOString(),
    };
    expect(withinLLMBudget(state, now, 50)).toBe(false);
  });

  it("rolls window over after 24h", () => {
    const now = Date.now();
    const state = {
      ...base,
      llm_calls_24h: 50,
      llm_calls_24h_window_start: new Date(now - 25 * 60 * 60 * 1000).toISOString(),
    };
    expect(withinLLMBudget(state, now, 50)).toBe(true);
  });

  it("recordLLMCall starts window when empty", () => {
    const now = Date.now();
    const r = recordLLMCall(base, now);
    expect(r.llm_calls_24h).toBe(1);
    expect(r.llm_calls_24h_window_start).not.toBeNull();
  });

  it("recordLLMCall resets window when past 24h", () => {
    const now = Date.now();
    const state = {
      ...base,
      llm_calls_24h: 10,
      llm_calls_24h_window_start: new Date(now - 25 * 60 * 60 * 1000).toISOString(),
    };
    const r = recordLLMCall(state, now);
    expect(r.llm_calls_24h).toBe(1);
  });
});

describe("persistent state", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-dmn-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("read/write round-trip", () => {
    const state: DMNState = {
      last_tick_at: "2026-04-20T00:00:00Z",
      bucket: "idle",
      ticks_since_last_user_turn: 7,
      work_units_completed: 12,
      by_kind: { belief_rescore: 7, campbell_watchdog: 5 },
      last_work_kind_index: 1,
      llm_calls_24h: 3,
      llm_calls_24h_window_start: "2026-04-20T00:00:00Z",
    };
    writeDMNState(tmp, state);
    const read = readDMNState(tmp);
    expect(read.bucket).toBe("idle");
    expect(read.by_kind.belief_rescore).toBe(7);
    expect(read.llm_calls_24h).toBe(3);
  });

  it("returns fresh defaults when no file exists", () => {
    const s = readDMNState(tmp);
    expect(s.bucket).toBe("active");
    expect(s.work_units_completed).toBe(0);
    expect(s.last_work_kind_index).toBe(-1);
  });
});

describe("runCampbellWatchdog", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-dmn-campbell-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("no_data when history is empty", () => {
    const r = runCampbellWatchdog(tmp);
    expect(r.triggered).toBe(false);
    expect(r.regime).toBe("no_data");
  });

  it("emits criticalFailure when samples trip campbell_suspected", () => {
    const now = Date.now();
    // Synthesize 20 samples: measured (approval) rising, grounded reversing.
    // Evenly split first/last half so the regime detector has enough points per half.
    for (let i = 0; i < 20; i++) {
      const progress = i / 19; // 0..1
      appendDistortionSample(tmp, {
        domain: "ops",
        timestamp: now - (20 - i) * 60_000,
        measured: 0.5 + progress * 0.3, // climbing
        grounded: 0.6 - progress * 0.4, // reversing
        approvalCount: 5 + i,
        overrideCount: 1,
      });
    }
    const r = runCampbellWatchdog(tmp);
    expect(r.triggered).toBe(true);
    expect(r.regime).toBe("campbell_suspected");
    expect(fs.existsSync(path.join(tmp, ".critical-failures.jsonl"))).toBe(true);
    const row = JSON.parse(
      fs.readFileSync(path.join(tmp, ".critical-failures.jsonl"), "utf-8").trim(),
    );
    expect(row.type).toBe("criticalFailure");
    expect(row.severity).toBe("critical");
    expect(row.implicated_rule).toBe("dmn.campbell_watchdog");
  });
});

describe("runBeliefRescore", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-dmn-belief-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const mkEvent = (
    id: string,
    text: string,
    outcome?: "success" | "failure" | "partial",
  ): EpisodicEvent => ({
    id,
    text,
    category: "decision",
    importance: 0.5,
    createdAt: Date.now() - 1000,
    archivistProcessed: false,
    outcome,
  });

  it("skips when no outcome-labeled events", () => {
    formBelief(tmp, {
      id: "b1",
      claim: "async replies preferred",
      domain: "comms",
      confidence: 0.7,
    });
    const r = runBeliefRescore(tmp, [mkEvent("a", "some text with no outcome")]);
    expect(r.skipped_no_recent_events).toBe(true);
  });

  it("reinforces on success + token overlap", () => {
    formBelief(tmp, {
      id: "b1",
      claim: "async replies outperform sync responses",
      domain: "comms",
      confidence: 0.7,
    });
    const r = runBeliefRescore(tmp, [
      mkEvent("e1", "async replies landed cleanly today", "success"),
    ]);
    expect(r.reinforced).toContain("b1");
  });

  it("weakens on failure + token overlap", () => {
    formBelief(tmp, {
      id: "b2",
      claim: "build gate catches regressions reliably",
      domain: "testing",
      confidence: 0.7,
    });
    const r = runBeliefRescore(tmp, [
      mkEvent("e2", "build gate missed a regression today", "failure"),
    ]);
    expect(r.weakened).toContain("b2");
  });

  it("ignores beliefs with insufficient token overlap", () => {
    formBelief(tmp, {
      id: "b3",
      claim: "asynchronous message delivery",
      domain: "comms",
      confidence: 0.7,
    });
    const r = runBeliefRescore(tmp, [
      mkEvent("e3", "completely unrelated topic about widgets", "success"),
    ]);
    expect(r.reinforced).toHaveLength(0);
    expect(r.weakened).toHaveLength(0);
  });
});
