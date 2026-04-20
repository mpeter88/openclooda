import { describe, expect, it } from "vitest";
import type { EpisodicEvent } from "./archivist.js";
import {
  DEFAULT_FORGETTING_POLICY,
  explainKeep,
  partitionForPrune,
  shouldKeep,
} from "./learned-forgetting.js";

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function mk(overrides: Partial<EpisodicEvent>): EpisodicEvent {
  return {
    id: "0",
    text: "",
    category: "other",
    importance: 0.5,
    createdAt: NOW - 120 * DAY, // 120 days old — past default 90-day floor
    archivistProcessed: false,
    ...overrides,
  };
}

describe("shouldKeep", () => {
  it("keeps events under the age floor unconditionally", () => {
    const e = mk({ createdAt: NOW - 10 * DAY });
    expect(shouldKeep(e, DEFAULT_FORGETTING_POLICY, NOW)).toBe(true);
  });

  it("drops an old noise event with no keep signals", () => {
    const e = mk({
      category: "other",
      importance: 0.3,
      outcome: undefined,
      outcomeAt: undefined,
    });
    expect(shouldKeep(e, DEFAULT_FORGETTING_POLICY, NOW)).toBe(false);
  });

  it("keeps high-importance events (signal 1)", () => {
    const e = mk({ importance: 0.9 });
    expect(shouldKeep(e, DEFAULT_FORGETTING_POLICY, NOW)).toBe(true);
    expect(explainKeep(e, DEFAULT_FORGETTING_POLICY, NOW)).toMatch(/importance/);
  });

  it("keeps outcome-labeled events (signal 2)", () => {
    const e = mk({ importance: 0.3, outcome: "failure", outcomeSignal: "x" });
    expect(shouldKeep(e, DEFAULT_FORGETTING_POLICY, NOW)).toBe(true);
    expect(explainKeep(e, DEFAULT_FORGETTING_POLICY, NOW)).toMatch(/outcome=failure/);
  });

  it("keeps recently-touched events (signal 3 via outcomeAt)", () => {
    const e = mk({
      importance: 0.3,
      outcome: undefined,
      outcomeAt: NOW - 5 * DAY, // within 30-day default window
    });
    expect(shouldKeep(e, DEFAULT_FORGETTING_POLICY, NOW)).toBe(true);
    expect(explainKeep(e, DEFAULT_FORGETTING_POLICY, NOW)).toMatch(/outcomeAt_recent/);
  });

  it("keeps category-allowlisted events (signal 4)", () => {
    const e = mk({ category: "decision", importance: 0.3 });
    expect(shouldKeep(e, DEFAULT_FORGETTING_POLICY, NOW)).toBe(true);
    expect(explainKeep(e, DEFAULT_FORGETTING_POLICY, NOW)).toMatch(/category=decision/);
  });

  it("disabling keepOutcomeLabeled lets outcome events be dropped", () => {
    const policy = { ...DEFAULT_FORGETTING_POLICY, keepOutcomeLabeled: false };
    const e = mk({
      importance: 0.3,
      outcome: "success",
      category: "other",
      outcomeAt: NOW - 40 * DAY, // outside 30d recent window
    });
    expect(shouldKeep(e, policy, NOW)).toBe(false);
  });

  it("custom importance floor takes effect", () => {
    const policy = { ...DEFAULT_FORGETTING_POLICY, keepImportanceFloor: 0.9 };
    const e = mk({ importance: 0.8, category: "other", outcome: undefined });
    expect(shouldKeep(e, policy, NOW)).toBe(false);
  });
});

describe("partitionForPrune", () => {
  it("partitions a realistic mix of 1000 events conservatively", () => {
    const events: EpisodicEvent[] = [];
    for (let i = 0; i < 1000; i++) {
      // Deterministic seed — mix of event shapes.
      const age = 100 * DAY + i * 60_000; // all past 90-day floor
      const isDecision = i % 20 === 0;
      const isHighImportance = i % 17 === 0;
      const isOutcomeLabeled = i % 13 === 0;
      events.push(
        mk({
          id: `${i}`,
          createdAt: NOW - age,
          category: isDecision ? "decision" : "other",
          importance: isHighImportance ? 0.85 : 0.4,
          outcome: isOutcomeLabeled ? "success" : undefined,
        }),
      );
    }
    const { keep, drop } = partitionForPrune(events, DEFAULT_FORGETTING_POLICY, NOW);
    expect(keep.length + drop.length).toBe(1000);
    // Expected: at most ~20% dropped (this is a conservative policy).
    expect(drop.length).toBeLessThanOrEqual(850);
    // All dropped events must be NEITHER outcome-labeled NOR category=decision.
    for (const d of drop) {
      expect(d.outcome).toBeUndefined();
      expect(d.category).not.toBe("decision");
    }
  });

  it("empty input returns empty partitions", () => {
    const r = partitionForPrune([], DEFAULT_FORGETTING_POLICY, NOW);
    expect(r.keep).toEqual([]);
    expect(r.drop).toEqual([]);
  });

  it("everything under age floor is kept", () => {
    const events = Array.from({ length: 50 }, (_, i) =>
      mk({ id: `${i}`, createdAt: NOW - i * 60_000 }),
    );
    const r = partitionForPrune(events, DEFAULT_FORGETTING_POLICY, NOW);
    expect(r.drop).toHaveLength(0);
    expect(r.keep).toHaveLength(50);
  });
});
