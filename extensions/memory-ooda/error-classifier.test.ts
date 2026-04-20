import { describe, expect, it } from "vitest";
import type { EpisodicEvent } from "./archivist.js";
import {
  aggregateAxisPriors,
  buildErrorClassifierPrompt,
  classifyError,
  parseErrorTags,
} from "./error-classifier.js";

const mkEvent = (overrides: Partial<EpisodicEvent> = {}): EpisodicEvent => ({
  id: "e1",
  text: "deploy pipeline failed",
  category: "test",
  importance: 0.5,
  createdAt: Date.now(),
  outcome: "failure",
  ...overrides,
});

describe("parseErrorTags", () => {
  it("accepts a valid single-axis tag", () => {
    const tags = parseErrorTags(
      JSON.stringify([
        { axis: "action", severity: "major", signal: "tool exit 1", confidence: 0.9 },
      ]),
    );
    expect(tags).toHaveLength(1);
    expect(tags[0].axis).toBe("action");
  });

  it("accepts multi-axis tags", () => {
    const tags = parseErrorTags(
      JSON.stringify([
        { axis: "planning", severity: "major", signal: "wrong archetype", confidence: 0.8 },
        { axis: "action", severity: "minor", signal: "retry failed", confidence: 0.6 },
      ]),
    );
    expect(tags).toHaveLength(2);
  });

  it("dedupes same-axis entries", () => {
    const tags = parseErrorTags(
      JSON.stringify([
        { axis: "memory", severity: "major", signal: "first", confidence: 0.9 },
        { axis: "memory", severity: "minor", signal: "second", confidence: 0.5 },
      ]),
    );
    expect(tags).toHaveLength(1);
    expect(tags[0].signal).toBe("first");
  });

  it("rejects unknown axis", () => {
    expect(() =>
      parseErrorTags(
        JSON.stringify([{ axis: "delusion", severity: "major", signal: "x", confidence: 0.5 }]),
      ),
    ).toThrow(/axis/);
  });

  it("clamps confidence to [0,1]", () => {
    const tags = parseErrorTags(
      JSON.stringify([{ axis: "memory", severity: "minor", signal: "s", confidence: 1.5 }]),
    );
    expect(tags[0].confidence).toBe(1);
  });

  it("strips code fences", () => {
    const tags = parseErrorTags(
      "```json\n" +
        JSON.stringify([{ axis: "action", severity: "minor", signal: "x", confidence: 0.5 }]) +
        "\n```",
    );
    expect(tags).toHaveLength(1);
  });
});

describe("buildErrorClassifierPrompt", () => {
  it("includes event text excerpt", () => {
    const prompt = buildErrorClassifierPrompt(mkEvent({ text: "unique-marker-xyz" }), {});
    expect(prompt).toContain("unique-marker-xyz");
  });

  it("handles missing context gracefully", () => {
    const prompt = buildErrorClassifierPrompt(mkEvent(), {});
    expect(prompt).toContain("SITREP: none");
    expect(prompt).toContain("Tool trace:");
  });
});

describe("classifyError", () => {
  it("returns parsed tags on first success", async () => {
    const model = async () =>
      JSON.stringify([
        { axis: "memory", severity: "minor", signal: "stale recall", confidence: 0.7 },
      ]);
    const tags = await classifyError(mkEvent(), {}, model);
    expect(tags).toHaveLength(1);
    expect(tags[0].axis).toBe("memory");
  });

  it("returns [] on repeated parse failures", async () => {
    const model = async () => "not json";
    const tags = await classifyError(mkEvent(), {}, model);
    expect(tags).toEqual([]);
  });

  it("retries once on first malformed output", async () => {
    let call = 0;
    const model = async () => {
      call++;
      if (call === 1) return "{malformed";
      return JSON.stringify([
        { axis: "action", severity: "minor", signal: "retry", confidence: 0.5 },
      ]);
    };
    const tags = await classifyError(mkEvent(), {}, model);
    expect(tags).toHaveLength(1);
  });
});

describe("aggregateAxisPriors", () => {
  const inferDomain = (text: string) => (text.includes("amf") ? "amf_pipeline" : "unknown");

  it("returns empty when no tagged events", () => {
    const priors = aggregateAxisPriors(
      [mkEvent({ errorTags: [] })],
      30 * 24 * 3600 * 1000,
      inferDomain,
    );
    expect(priors).toEqual([]);
  });

  it("counts per-domain per-axis with severity breakdown", () => {
    const events: EpisodicEvent[] = [
      mkEvent({
        id: "e1",
        text: "amf pipeline error",
        errorTags: [
          { axis: "planning", severity: "major", signal: "x", confidence: 0.9 },
          { axis: "action", severity: "minor", signal: "y", confidence: 0.8 },
        ],
      }),
      mkEvent({
        id: "e2",
        text: "amf pipeline error",
        errorTags: [{ axis: "planning", severity: "critical", signal: "x", confidence: 0.9 }],
      }),
    ];
    const priors = aggregateAxisPriors(events, 30 * 24 * 3600 * 1000, inferDomain);
    const planning = priors.find((p) => p.axis === "planning");
    expect(planning?.countMajor).toBe(1);
    expect(planning?.countCritical).toBe(1);
    expect(planning?.domain).toBe("amf_pipeline");
  });

  it("filters out events outside the window", () => {
    const events: EpisodicEvent[] = [
      mkEvent({
        createdAt: Date.now() - 100 * 24 * 3600 * 1000,
        text: "amf old",
        errorTags: [{ axis: "memory", severity: "minor", signal: "x", confidence: 0.5 }],
      }),
    ];
    const priors = aggregateAxisPriors(events, 30 * 24 * 3600 * 1000, inferDomain);
    expect(priors).toEqual([]);
  });

  it("topSignals returns the 3 most frequent signals", () => {
    const events: EpisodicEvent[] = [];
    for (let i = 0; i < 5; i++) {
      events.push(
        mkEvent({
          id: `e${i}`,
          text: "amf",
          errorTags: [{ axis: "action", severity: "minor", signal: "timeout", confidence: 0.5 }],
        }),
      );
    }
    for (let i = 0; i < 2; i++) {
      events.push(
        mkEvent({
          id: `x${i}`,
          text: "amf",
          errorTags: [{ axis: "action", severity: "minor", signal: "refused", confidence: 0.5 }],
        }),
      );
    }
    const priors = aggregateAxisPriors(events, 30 * 24 * 3600 * 1000, inferDomain);
    expect(priors[0].topSignals[0].signal).toBe("timeout");
    expect(priors[0].topSignals[0].count).toBe(5);
  });
});
