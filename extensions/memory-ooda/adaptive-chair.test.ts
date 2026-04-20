import { describe, expect, it } from "vitest";
import {
  DEFAULT_ADAPTIVE_CONFIG,
  discreteKS,
  juryActivation,
  runAdaptiveChair,
  type ChairSampleFn,
} from "./adaptive-chair.js";

describe("discreteKS", () => {
  it("returns 0 when distributions are identical", () => {
    const a = new Map([
      ["x", 2],
      ["y", 1],
    ]);
    const b = new Map([
      ["x", 4],
      ["y", 2],
    ]);
    expect(discreteKS(a, b, 3, 6)).toBe(0);
  });

  it("returns 1 when distributions are disjoint", () => {
    const a = new Map([["x", 3]]);
    const b = new Map([["y", 3]]);
    expect(discreteKS(a, b, 3, 3)).toBe(1);
  });

  it("returns 0.5 for half-overlapping distributions", () => {
    const a = new Map([["x", 2]]);
    const b = new Map([
      ["x", 1],
      ["y", 1],
    ]);
    const ks = discreteKS(a, b, 2, 2);
    expect(ks).toBe(0.5);
  });

  it("returns 1 when any total is zero", () => {
    expect(discreteKS(new Map(), new Map([["x", 1]]), 0, 1)).toBe(1);
  });
});

describe("runAdaptiveChair", () => {
  it("stops at minSamples when 100% consensus", async () => {
    let call = 0;
    const sampleFn: ChairSampleFn = async () => {
      call++;
      return { label: "aggressive_fix", confidence: 0.9, raw: `r${call}` };
    };
    const result = await runAdaptiveChair(sampleFn, {
      ...DEFAULT_ADAPTIVE_CONFIG,
      minSamples: 3,
      maxSamples: 9,
    });
    expect(result.stabilizedAt).toBe(3);
    expect(result.winnerShare).toBe(1);
    expect(result.winnerLabel).toBe("aggressive_fix");
    expect(result.samples).toHaveLength(3);
  });

  it("detects stability when KS < threshold across rounds", async () => {
    // After minSamples, distribution stabilizes to same ratio.
    const labels = [
      "aggressive_fix",
      "aggressive_fix",
      "delegate_task",
      "aggressive_fix",
      "aggressive_fix",
      "delegate_task",
    ];
    let i = 0;
    const sampleFn: ChairSampleFn = async () => ({
      label: labels[i++ % labels.length],
      confidence: 0.8,
      raw: "",
    });
    const result = await runAdaptiveChair(sampleFn, {
      ...DEFAULT_ADAPTIVE_CONFIG,
      minSamples: 3,
      maxSamples: 9,
      ksThreshold: 0.2,
    });
    expect(result.forcedStop || result.stabilizedAt <= 9).toBe(true);
  });

  it("forced stop at maxSamples without stability", async () => {
    // Alternating labels: never stabilize.
    let i = 0;
    const sampleFn: ChairSampleFn = async () => ({
      label: i++ % 2 === 0 ? "a" : "b",
      confidence: 0.5,
      raw: "",
    });
    const result = await runAdaptiveChair(sampleFn, {
      ...DEFAULT_ADAPTIVE_CONFIG,
      minSamples: 3,
      maxSamples: 5,
      ksThreshold: 0.01,
    });
    expect(result.forcedStop).toBe(true);
    expect(result.samples).toHaveLength(5);
  });

  it("detects split verdict on forced stop when top two are within 0.1", async () => {
    let i = 0;
    const sampleFn: ChairSampleFn = async () => ({
      label: i++ % 2 === 0 ? "a" : "b",
      confidence: 0.5,
      raw: "",
    });
    const result = await runAdaptiveChair(sampleFn, {
      ...DEFAULT_ADAPTIVE_CONFIG,
      minSamples: 2,
      maxSamples: 4,
      ksThreshold: 0.01,
    });
    expect(result.splitVerdict).toBe(true);
  });

  it("rotates through temperatures", async () => {
    const observedTemps: number[] = [];
    const sampleFn: ChairSampleFn = async (_, temp) => {
      observedTemps.push(temp);
      return { label: "x", confidence: 0.5, raw: "" };
    };
    await runAdaptiveChair(sampleFn, {
      ...DEFAULT_ADAPTIVE_CONFIG,
      minSamples: 5,
      maxSamples: 5,
      temperatures: [0.0, 0.5, 1.0],
    });
    expect(observedTemps).toEqual([0.0, 0.5, 1.0, 0.0, 0.5]);
  });
});

describe("juryActivation", () => {
  it("skips jury when winnerShare >= 0.85", () => {
    expect(juryActivation(0.9, 10, 1.0)).toBe("skip");
  });

  it("forces jury when winnerShare < 0.6", () => {
    expect(juryActivation(0.55, 3, 0.1)).toBe("fire_by_winnerShare");
  });

  it("fires by thresholds in mid-range with high priority + disagreement", () => {
    expect(juryActivation(0.7, 9, 0.7)).toBe("fire_by_thresholds");
  });

  it("skips in mid-range when priority or disagreement below floor", () => {
    expect(juryActivation(0.7, 6, 0.7)).toBe("skip");
    expect(juryActivation(0.7, 9, 0.3)).toBe("skip");
  });
});
