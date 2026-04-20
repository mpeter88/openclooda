import { describe, expect, it } from "vitest";
import type { EpisodicEvent } from "./archivist.js";
import { buildCausalIndex, findAntecedents, formatAntecedents } from "./causal-retrieval.js";

function mk(overrides: Partial<EpisodicEvent>): EpisodicEvent {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    text: "",
    category: "decision",
    importance: 0.5,
    createdAt: 0,
    archivistProcessed: false,
    ...overrides,
  };
}

describe("buildCausalIndex", () => {
  it("joins decision + outcome sharing the same actionId", () => {
    const events: EpisodicEvent[] = [
      mk({
        id: "d1",
        text: "deploy to staging",
        category: "decision",
        actionId: "act-1",
        createdAt: 1000,
      }),
      mk({
        id: "o1",
        text: "staging deploy completed",
        category: "other",
        actionId: "act-1",
        createdAt: 1500,
        outcome: "success",
        outcomeSignal: "deploy_success",
        outcomeAt: 1500,
      }),
    ];
    const idx = buildCausalIndex(events);
    expect(idx.byOutcomeSignal.get("deploy_success")).toHaveLength(1);
    expect(idx.byOutcome.get("success")).toHaveLength(1);
    expect(idx.byOutcomeSignal.get("deploy_success")?.[0].decisionId).toBe("d1");
    expect(idx.byOutcomeSignal.get("deploy_success")?.[0].gapMs).toBe(500);
  });

  it("skips events with no actionId", () => {
    const events: EpisodicEvent[] = [
      mk({
        id: "d1",
        text: "free-floating decision",
        category: "decision",
        createdAt: 1000,
      }),
      mk({
        id: "o1",
        text: "outcome without actionId",
        outcome: "failure",
        outcomeSignal: "whatever",
        createdAt: 2000,
      }),
    ];
    const idx = buildCausalIndex(events);
    expect(idx.byOutcomeSignal.size).toBe(0);
    expect(idx.byOutcome.size).toBe(0);
  });

  it("picks the most recent decision when multiple share an actionId", () => {
    const events: EpisodicEvent[] = [
      mk({
        id: "d1",
        text: "old decision",
        category: "decision",
        actionId: "act-1",
        createdAt: 500,
      }),
      mk({
        id: "d2",
        text: "recent decision",
        category: "decision",
        actionId: "act-1",
        createdAt: 1500,
      }),
      mk({
        id: "o1",
        text: "outcome",
        category: "other",
        actionId: "act-1",
        createdAt: 2000,
        outcome: "failure",
        outcomeSignal: "pipeline_fail",
        outcomeAt: 2000,
      }),
    ];
    const idx = buildCausalIndex(events);
    const rows = idx.byOutcomeSignal.get("pipeline_fail");
    expect(rows).toHaveLength(1);
    expect(rows![0].decisionId).toBe("d2");
    expect(rows![0].gapMs).toBe(500);
  });

  it("never self-links a single memory", () => {
    const events: EpisodicEvent[] = [
      mk({
        id: "self",
        text: "decision + outcome on same memory",
        category: "decision",
        actionId: "act-1",
        createdAt: 1000,
        outcome: "success",
        outcomeSignal: "self_signal",
        outcomeAt: 1000,
      }),
    ];
    const idx = buildCausalIndex(events);
    expect(idx.byOutcomeSignal.size).toBe(0);
  });
});

describe("findAntecedents", () => {
  const events: EpisodicEvent[] = [
    mk({
      id: "d1",
      text: "staging deploy attempt A",
      category: "decision",
      actionId: "act-A",
      createdAt: 1000,
    }),
    mk({
      id: "o1",
      text: "pipeline failed A",
      category: "other",
      actionId: "act-A",
      createdAt: 1100,
      outcome: "failure",
      outcomeSignal: "pipeline_fail",
      outcomeAt: 1100,
    }),
    mk({
      id: "d2",
      text: "staging deploy attempt B",
      category: "decision",
      actionId: "act-B",
      createdAt: 2000,
    }),
    mk({
      id: "o2",
      text: "pipeline failed B",
      category: "other",
      actionId: "act-B",
      createdAt: 2100,
      outcome: "failure",
      outcomeSignal: "pipeline_fail",
      outcomeAt: 2100,
    }),
    mk({
      id: "d3",
      text: "staging deploy attempt C",
      category: "decision",
      actionId: "act-C",
      createdAt: 3000,
    }),
    mk({
      id: "o3",
      text: "deploy succeeded C",
      category: "other",
      actionId: "act-C",
      createdAt: 3100,
      outcome: "success",
      outcomeSignal: "deploy_success",
      outcomeAt: 3100,
    }),
  ];

  it("filters by outcomeSignal and sorts by decisionAt desc", () => {
    const rows = findAntecedents(events, { outcomeSignal: "pipeline_fail" });
    expect(rows).toHaveLength(2);
    expect(rows[0].decisionId).toBe("d2");
    expect(rows[1].decisionId).toBe("d1");
  });

  it("filters by outcome band", () => {
    const rows = findAntecedents(events, { outcome: "failure" });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.outcome === "failure")).toBe(true);
  });

  it("flattens all outcomes when no selector supplied", () => {
    const rows = findAntecedents(events, {});
    expect(rows.length).toBeGreaterThanOrEqual(3);
  });

  it("respects limit", () => {
    const rows = findAntecedents(events, { outcome: "failure", limit: 1 });
    expect(rows).toHaveLength(1);
  });

  it("withinMs excludes stale antecedents", () => {
    const now = 3500;
    const rows = findAntecedents(events, {
      outcome: "failure",
      withinMs: 2000,
      now,
    });
    // With withinMs=2000 from now=3500, cutoff=1500 → only act-B (decisionAt=2000) passes.
    expect(rows).toHaveLength(1);
    expect(rows[0].decisionId).toBe("d2");
  });

  it("returns [] when no match", () => {
    expect(findAntecedents(events, { outcomeSignal: "no_such_signal" })).toEqual([]);
    expect(findAntecedents([], { outcome: "failure" })).toEqual([]);
  });
});

describe("formatAntecedents", () => {
  it("produces readable one-liners with date, outcome, gap, snippet", () => {
    const out = formatAntecedents([
      {
        decisionId: "d1",
        decisionText: "deploy staging with hot-fix 'commit revert'",
        decisionAt: 1700000000000,
        outcomeAt: 1700000300000,
        gapMs: 300000,
        outcomeSignal: "pipeline_fail",
        outcome: "failure",
        actionId: "act-123",
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("pipeline_fail");
    expect(out[0]).toContain("act-123");
    expect(out[0]).toContain("Δt=5.0m");
  });

  it("truncates long decision text", () => {
    const longText = "x".repeat(300);
    const out = formatAntecedents([
      {
        decisionId: "d",
        decisionText: longText,
        decisionAt: 1700000000000,
        outcomeAt: 1700000000000,
        gapMs: 0,
        outcomeSignal: "",
        outcome: "success",
        actionId: "a",
      },
    ]);
    expect(out[0].length).toBeLessThan(220);
    expect(out[0]).toContain("…");
  });
});
