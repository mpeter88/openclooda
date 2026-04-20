import { describe, expect, it } from "vitest";
import {
  buildChairPreReadPrompt,
  computeDisagreement,
  parseChairPrior,
  runJury,
} from "./council-discipline.js";
import type { SITREP } from "./types.js";

const archetypes = ["aggressive_fix", "delegate_task", "strategic_delay", "minimal_viable_action"];

const makeSITREP = (overrides: Partial<SITREP> = {}): SITREP => ({
  priority: 7,
  summary: "test scenario",
  conflictsDetected: [],
  relevantFacts: [],
  recommendedDomains: ["amf_pipeline"],
  ...overrides,
});

describe("computeDisagreement", () => {
  it("score=0 when all members land on same archetype", () => {
    const members = [
      { role: "analyst", output: "recommend aggressive_fix now" },
      { role: "strategist", output: "clearly aggressive_fix is the play" },
      { role: "skeptic", output: "aggressive_fix is fine here" },
    ];
    const reading = computeDisagreement(members, archetypes);
    expect(reading.score).toBe(0);
    expect(reading.clusters).toHaveLength(1);
    expect(reading.contradictions).toHaveLength(0);
  });

  it("score=1 when every member on distinct archetype", () => {
    const members = [
      { role: "a", output: "aggressive_fix" },
      { role: "b", output: "delegate_task" },
      { role: "c", output: "strategic_delay" },
    ];
    const reading = computeDisagreement(members, archetypes);
    expect(reading.score).toBe(1);
    expect(reading.clusters).toHaveLength(3);
    // C(3,2) = 3 contradictions
    expect(reading.contradictions).toHaveLength(3);
  });

  it("score mid when two clusters", () => {
    const members = [
      { role: "a", output: "aggressive_fix" },
      { role: "b", output: "aggressive_fix" },
      { role: "c", output: "strategic_delay" },
    ];
    const reading = computeDisagreement(members, archetypes);
    expect(reading.score).toBeGreaterThan(0);
    expect(reading.score).toBeLessThan(1);
    expect(reading.clusters).toHaveLength(2);
  });

  it("handles unclassified members without contradiction inflation", () => {
    const members = [
      { role: "a", output: "not matching anything specific" },
      { role: "b", output: "aggressive_fix" },
    ];
    const reading = computeDisagreement(members, archetypes);
    // a is unclassified vs b=aggressive_fix — still one contradiction signals needed
    // filter skips unclassified vs anything, so 0 contradictions.
    expect(reading.contradictions).toHaveLength(0);
  });

  it("empty members returns score 0", () => {
    const reading = computeDisagreement([], archetypes);
    expect(reading.score).toBe(0);
  });
});

describe("parseChairPrior", () => {
  it("parses valid chair prior", () => {
    const raw = JSON.stringify({
      preReadWinner: "delegate_task",
      preReadReasoning: "clear delegation case",
      preReadConfidence: 0.75,
    });
    const prior = parseChairPrior(raw);
    expect(prior.preReadWinner).toBe("delegate_task");
    expect(prior.preReadConfidence).toBe(0.75);
  });

  it("clamps confidence to [0,1]", () => {
    const raw = JSON.stringify({
      preReadWinner: "x",
      preReadReasoning: "y",
      preReadConfidence: 1.5,
    });
    expect(parseChairPrior(raw).preReadConfidence).toBe(1);
  });

  it("rejects missing preReadWinner", () => {
    expect(() => parseChairPrior(JSON.stringify({ preReadReasoning: "x" }))).toThrow();
  });

  it("strips code fences", () => {
    const raw =
      "```json\n" +
      JSON.stringify({
        preReadWinner: "x",
        preReadReasoning: "y",
        preReadConfidence: 0.5,
      }) +
      "\n```";
    expect(parseChairPrior(raw).preReadWinner).toBe("x");
  });
});

describe("buildChairPreReadPrompt", () => {
  it("omits member outputs from the pre-read prompt", () => {
    const prompt = buildChairPreReadPrompt(makeSITREP(), archetypes);
    expect(prompt).not.toContain("strategist");
    expect(prompt).not.toContain("skeptic");
    expect(prompt).toContain("SITREP");
    for (const a of archetypes) {
      expect(prompt).toContain(a);
    }
  });
});

describe("runJury", () => {
  it("affirm×3 produces verdict=affirm", async () => {
    const model = async () => JSON.stringify({ vote: "affirm", reasoning: "sound call" });
    const result = await runJury(
      { label: "x", reasoning: "y" },
      { analyst: "..." },
      makeSITREP(),
      model,
    );
    expect(result.verdict).toBe("affirm");
    expect(result.individualVotes).toHaveLength(3);
  });

  it("overturn×3 produces verdict=overturn and overturn message", async () => {
    const model = async () => JSON.stringify({ vote: "overturn", reasoning: "flawed reasoning" });
    const result = await runJury(
      { label: "x", reasoning: "y" },
      { analyst: "..." },
      makeSITREP(),
      model,
    );
    expect(result.verdict).toBe("overturn");
    expect(result.finalChairReasoning).toContain("overturned");
  });

  it("split produces verdict=split with dissent-noted message", async () => {
    let i = 0;
    const model = async () => {
      i++;
      return JSON.stringify({
        vote: i === 1 ? "overturn" : "affirm",
        reasoning: `r${i}`,
      });
    };
    const result = await runJury(
      { label: "x", reasoning: "y" },
      { analyst: "..." },
      makeSITREP(),
      model,
    );
    expect(result.verdict).toBe("split");
    expect(result.finalChairReasoning).toContain("split");
  });

  it("parse failure defaults to affirm (safe)", async () => {
    const model = async () => "not json";
    const result = await runJury(
      { label: "x", reasoning: "y" },
      { analyst: "..." },
      makeSITREP(),
      model,
    );
    expect(result.verdict).toBe("affirm");
  });
});
