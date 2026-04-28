import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  allocateHypothesisId,
  makeRunId,
  readHypothesisCounter,
  validateHypothesis,
  validateHypothesisFixtures,
  validateValueImpact,
  type Hypothesis,
  type ValueImpact,
} from "./hypothesis-schema.js";

describe("H-NNN counter", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-hid-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("starts at 0 and allocates sequentially", () => {
    expect(readHypothesisCounter(tmp)).toBe(0);
    expect(allocateHypothesisId(tmp)).toBe("H-001");
    expect(allocateHypothesisId(tmp)).toBe("H-002");
    expect(allocateHypothesisId(tmp)).toBe("H-003");
    expect(readHypothesisCounter(tmp)).toBe(3);
  });

  it("persists across reads so parallel processes can't re-use", () => {
    allocateHypothesisId(tmp);
    allocateHypothesisId(tmp);
    // Simulate a fresh process read
    expect(readHypothesisCounter(tmp)).toBe(2);
    expect(allocateHypothesisId(tmp)).toBe("H-003");
  });

  it("tolerates a corrupt counter file (resets to 0)", () => {
    const counterFile = path.join(tmp, ".archive", "hypothesis-counter.txt");
    fs.mkdirSync(path.dirname(counterFile), { recursive: true });
    fs.writeFileSync(counterFile, "not-a-number");
    expect(readHypothesisCounter(tmp)).toBe(0);
    expect(allocateHypothesisId(tmp)).toBe("H-001");
  });
});

describe("makeRunId", () => {
  it("zero-pads run number to 3 digits", () => {
    expect(makeRunId("H-017", 1)).toBe("H-017-R-001");
    expect(makeRunId("H-017", 23)).toBe("H-017-R-023");
  });
});

describe("validateHypothesis", () => {
  const base: Hypothesis = {
    id: "H-001",
    claim: "adding X improves Y",
    prediction: "pass rate up 5%",
    success_metric: {
      fixture_tag: "H-001-ambiguous",
      min_pass_rate: 0.6,
      min_delta_vs_parent: 0.05,
    },
    failure_metric: {
      regression_forbidden_tags: ["critical"],
    },
    scope_boundary: ["triage.ts"],
  };

  it("accepts a well-formed hypothesis", () => {
    const r = validateHypothesis(base);
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("rejects malformed id", () => {
    const r = validateHypothesis({ ...base, id: "bad-id" });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("id"))).toBe(true);
  });

  it("rejects out-of-range pass rate", () => {
    const r = validateHypothesis({
      ...base,
      success_metric: { ...base.success_metric, min_pass_rate: 1.5 },
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("min_pass_rate"))).toBe(true);
  });

  it("rejects empty scope_boundary", () => {
    const r = validateHypothesis({ ...base, scope_boundary: [] });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("scope_boundary"))).toBe(true);
  });
});

describe("validateValueImpact", () => {
  const baseExisting: ValueImpact = {
    what_it_adds: "curiosity-driven triage",
    why_now: "recall plateaued on ambiguous inputs",
    roadmap_link: { mode: "existing", horizon: "current", epic: "curiosity" },
    est_impact: 0.6,
    est_effort: 0.3,
  };

  const baseProposed: ValueImpact = {
    ...baseExisting,
    roadmap_link: {
      mode: "propose",
      horizon: "near",
      epic_id: "metacog-consolidation",
      title: "Metacognitive consolidation",
      rationale: "novel direction, no existing epic covers this",
    },
  };

  it("accepts existing-mode link with known shape", () => {
    expect(validateValueImpact(baseExisting).valid).toBe(true);
  });

  it("accepts propose-mode link with full payload", () => {
    expect(validateValueImpact(baseProposed).valid).toBe(true);
  });

  it("rejects existing mode without epic", () => {
    const bad: ValueImpact = {
      ...baseExisting,
      roadmap_link: { mode: "existing", horizon: "current", epic: "" },
    };
    expect(validateValueImpact(bad).valid).toBe(false);
  });

  it("rejects propose mode without rationale", () => {
    const bad: ValueImpact = {
      ...baseProposed,
      roadmap_link: {
        mode: "propose",
        horizon: "near",
        epic_id: "x",
        title: "x",
        rationale: "",
      },
    };
    expect(validateValueImpact(bad).valid).toBe(false);
  });

  it("rejects out-of-range est_impact", () => {
    expect(validateValueImpact({ ...baseExisting, est_impact: -0.1 }).valid).toBe(false);
    expect(validateValueImpact({ ...baseExisting, est_impact: 1.5 }).valid).toBe(false);
  });
});

describe("validateHypothesisFixtures", () => {
  const TAG = "H-test-tag";
  const goodFixture = {
    id: "fx-1",
    label: "label",
    fixture: { observation: "x", knowledge: {}, priorities: {} },
    expected: {
      actionId: "a",
      description: "d",
      successSignal: "s",
      failureSignal: "f",
      domain: "ops",
    },
    priorOutcome: "success" as const,
    capturedAt: new Date().toISOString(),
    tags: [TAG],
  };

  it("accepts a well-formed fixture array", () => {
    const r = validateHypothesisFixtures([goodFixture], TAG);
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("rejects an empty array", () => {
    const r = validateHypothesisFixtures([], TAG);
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/non-empty/);
  });

  it("rejects when tags missing the required tag", () => {
    const r = validateHypothesisFixtures([{ ...goodFixture, tags: [] }], TAG);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("must include"))).toBe(true);
  });

  it("rejects malformed expected block", () => {
    const r = validateHypothesisFixtures(
      [
        {
          ...goodFixture,
          expected: { actionId: "a" } as unknown as (typeof goodFixture)["expected"],
        },
      ],
      TAG,
    );
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("expected.description"))).toBe(true);
  });

  it("rejects malformed capturedAt", () => {
    const r = validateHypothesisFixtures([{ ...goodFixture, capturedAt: "garbage" }], TAG);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("capturedAt"))).toBe(true);
  });
});

describe("allocateHypothesisId concurrency", () => {
  it("releases the lock after each allocation so the next call succeeds", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-hid-lock-"));
    try {
      // Sequential calls — each must release the lock so the next can take it.
      const ids = [allocateHypothesisId(tmp), allocateHypothesisId(tmp), allocateHypothesisId(tmp)];
      expect(ids).toEqual(["H-001", "H-002", "H-003"]);
      // Lock file should be cleaned up after release.
      expect(fs.existsSync(path.join(tmp, ".archive", "hypothesis-counter.lock"))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("times out when an external process holds the lock", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-hid-lock-busy-"));
    try {
      const lockFile = path.join(tmp, ".archive", "hypothesis-counter.lock");
      fs.mkdirSync(path.dirname(lockFile), { recursive: true });
      // Simulate an outside process holding the lock by creating the file
      // and leaving it. acquireCounterLock should spin until the 5s deadline
      // and then throw. We use a vi mock of Date.now to avoid the real wait.
      const realNow = Date.now;
      let cur = 0;
      Date.now = () => {
        cur += 1000;
        return cur;
      };
      fs.writeFileSync(lockFile, "");
      try {
        expect(() => allocateHypothesisId(tmp)).toThrow(/lock timeout/);
      } finally {
        Date.now = realNow;
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
