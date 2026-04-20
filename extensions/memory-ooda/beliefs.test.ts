import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canPromote,
  createDefaultBeliefs,
  formBelief,
  formatBeliefsForContext,
  getActiveBeliefs,
  getBeliefs,
  reinforceBelief,
  retireBelief,
  weakenBelief,
} from "./beliefs.js";

describe("beliefs tier", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-beliefs-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates default BELIEFS.json on first read", () => {
    const beliefs = getBeliefs(tmpDir);
    expect(beliefs._meta.version).toBe(1);
    expect(beliefs.beliefs).toEqual({});
    expect(beliefs._belief_log).toEqual([]);
  });

  it("forms a new belief", () => {
    const b = formBelief(tmpDir, {
      id: "pref_delegation",
      claim: "prefers delegation on infra",
      domain: "infrastructure",
      confidence: 0.4,
    });
    expect(b.id).toBe("pref_delegation");
    expect(b.confidence).toBe(0.4);
    expect(b.evidence).toEqual([]);
    const file = getBeliefs(tmpDir);
    expect(file.beliefs.pref_delegation).toBeDefined();
    expect(file._belief_log[0].action).toBe("formed");
  });

  it("rejects duplicate belief id", () => {
    formBelief(tmpDir, { id: "x", claim: "y", domain: "z", confidence: 0.5 });
    expect(() =>
      formBelief(tmpDir, { id: "x", claim: "y2", domain: "z", confidence: 0.5 }),
    ).toThrow(/already exists/);
  });

  it("reinforces a belief with capped delta", () => {
    formBelief(tmpDir, { id: "x", claim: "c", domain: "d", confidence: 0.4 });
    const b = reinforceBelief(
      tmpDir,
      "x",
      { source: "episodic", ref: "ev1", weight: 0.2, at: new Date().toISOString() },
      0.9, // claimed, but capped at +0.15 per call
    );
    expect(b.confidence).toBeCloseTo(0.55, 2);
    expect(b.evidence).toHaveLength(1);
  });

  it("weakens a belief via contradicting evidence", () => {
    formBelief(tmpDir, { id: "x", claim: "c", domain: "d", confidence: 0.8 });
    const b = weakenBelief(
      tmpDir,
      "x",
      { source: "user_signal", ref: "ev2", weight: 0.5, at: new Date().toISOString() },
      0.3,
    );
    expect(b.confidence).toBeLessThan(0.8);
    expect(b.contradicting_evidence).toHaveLength(1);
  });

  it("retires a belief", () => {
    formBelief(tmpDir, { id: "x", claim: "c", domain: "d", confidence: 0.5 });
    const b = retireBelief(tmpDir, "x", "resolved");
    expect(b.retired?.reason).toBe("resolved");
  });

  it("rejects reinforcement on retired belief", () => {
    formBelief(tmpDir, { id: "x", claim: "c", domain: "d", confidence: 0.5 });
    retireBelief(tmpDir, "x", "done");
    expect(() =>
      reinforceBelief(tmpDir, "x", {
        source: "episodic",
        ref: "e",
        weight: 0.1,
        at: new Date().toISOString(),
      }),
    ).toThrow(/retired/);
  });

  it("getActiveBeliefs filters by confidence floor and retirement", () => {
    formBelief(tmpDir, { id: "a", claim: "c", domain: "d", confidence: 0.9 });
    formBelief(tmpDir, { id: "b", claim: "c", domain: "d", confidence: 0.3 });
    formBelief(tmpDir, { id: "c", claim: "c", domain: "d", confidence: 0.8 });
    retireBelief(tmpDir, "c", "done");

    const active = getActiveBeliefs(tmpDir, { minConfidence: 0.5 });
    expect(active.map((b) => b.id)).toEqual(["a"]);
  });

  it("canPromote requires age + confidence + no recent contradictions", () => {
    const now = Date.now();
    const oldTimestamp = new Date(now - 45 * 24 * 60 * 60 * 1000).toISOString();
    const belief = {
      id: "x",
      claim: "c",
      domain: "d",
      confidence: 0.9,
      formed_at: oldTimestamp,
      updated_at: oldTimestamp,
      evidence: [],
      contradicting_evidence: [],
      affects: ["triage" as const],
    };
    const result = canPromote(belief, now);
    expect(result.eligible).toBe(true);
  });

  it("canPromote rejects on recent contradiction", () => {
    const now = Date.now();
    const belief = {
      id: "x",
      claim: "c",
      domain: "d",
      confidence: 0.9,
      formed_at: new Date(now - 45 * 24 * 60 * 60 * 1000).toISOString(),
      updated_at: new Date().toISOString(),
      evidence: [],
      contradicting_evidence: [
        {
          source: "user_signal" as const,
          ref: "r",
          weight: 0.5,
          at: new Date().toISOString(),
        },
      ],
      affects: ["triage" as const],
    };
    const result = canPromote(belief, now);
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("contradiction");
  });

  it("formatBeliefsForContext respects floor and limit", () => {
    const beliefs = [
      {
        id: "a",
        claim: "alpha claim",
        domain: "d",
        confidence: 0.9,
        formed_at: "2026-04-01T00:00:00Z",
        updated_at: "2026-04-15T00:00:00Z",
        evidence: [],
        contradicting_evidence: [],
        affects: ["triage" as const],
      },
      {
        id: "b",
        claim: "beta claim",
        domain: "d",
        confidence: 0.5,
        formed_at: "2026-04-01T00:00:00Z",
        updated_at: "2026-04-15T00:00:00Z",
        evidence: [],
        contradicting_evidence: [],
        affects: ["triage" as const],
      },
    ];
    const out = formatBeliefsForContext(beliefs, { floor: 0.6 });
    expect(out).toContain("alpha claim");
    expect(out).not.toContain("beta claim");
  });

  it("returns empty string when no beliefs above floor", () => {
    expect(formatBeliefsForContext([], { floor: 0.6 })).toBe("");
  });

  it("createDefaultBeliefs returns empty structure", () => {
    const b = createDefaultBeliefs();
    expect(b.beliefs).toEqual({});
    expect(b._meta.updated_by).toBe("user");
  });
});
