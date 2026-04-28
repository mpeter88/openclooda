import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hypothesis, Run } from "./hypothesis-schema.js";
import { getProposals } from "./proposals.js";
import {
  compareResults,
  deriveRunVerdict,
  runResearchCompare,
  runResearchRollout,
} from "./research-compare.js";
import {
  experimentDir,
  readExperimentRecord,
  readRolloutQueue,
  writeExperimentRecord,
  type ExperimentRecord,
  type ExperimentResult,
} from "./research-loop.js";

function seedSandboxedExperiment(
  tmp: string,
  expId: string,
  sandbox: ExperimentResult,
): ExperimentRecord {
  const now = new Date().toISOString();
  const record: ExperimentRecord = {
    exp_id: expId,
    created_at: now,
    updated_at: now,
    status: "sandboxed",
    source: { kind: "paper", ref: "arxiv:2603.19461", citation: "HyperAgents" },
    parent_genid: "initial",
    scope: { allowed_paths: [], denylist_paths: [], max_files: 3 },
    hypothesis: "staged eval reduces gate cost",
    scores: { sandbox },
  };
  writeExperimentRecord(tmp, record);
  const dir = experimentDir(tmp, expId);
  fs.writeFileSync(
    path.join(dir, "diff.patch"),
    "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n",
    "utf-8",
  );
  return record;
}

describe("compareResults", () => {
  it("computes mean + per-domain delta", () => {
    const baseline: ExperimentResult = {
      pass_rate_small: 0.6,
      pass_rate_full: 0.7,
      regressions: [],
      per_domain: { polyglot: 0.6, paper_review: 0.8 },
      p95_latency_ms: null,
      new_error_tags: 0,
    };
    const sandbox: ExperimentResult = {
      pass_rate_small: 0.75,
      pass_rate_full: 0.82,
      regressions: [],
      per_domain: { polyglot: 0.75, paper_review: 0.85 },
      p95_latency_ms: null,
      new_error_tags: 0,
    };
    const r = compareResults(baseline, sandbox);
    expect(r.mean_delta).toBeCloseTo(0.12, 5);
    expect(r.per_domain.polyglot).toBeCloseTo(0.15, 5);
    expect(r.per_domain.paper_review).toBeCloseTo(0.05, 5);
    expect(r.had_regression).toBe(false);
  });

  it("flags regression when sandbox has regression ids", () => {
    const sandbox: ExperimentResult = {
      pass_rate_small: 0.5,
      pass_rate_full: null,
      regressions: ["c1", "c2"],
      per_domain: {},
      p95_latency_ms: null,
      new_error_tags: 1,
    };
    const r = compareResults(undefined, sandbox);
    expect(r.had_regression).toBe(true);
    expect(r.regression_ids).toEqual(["c1", "c2"]);
  });

  it("treats undefined baseline as zero", () => {
    const sandbox: ExperimentResult = {
      pass_rate_small: 0.4,
      pass_rate_full: null,
      regressions: [],
      per_domain: {},
      p95_latency_ms: null,
      new_error_tags: 0,
    };
    const r = compareResults(undefined, sandbox);
    expect(r.mean_delta).toBeCloseTo(0.4, 5);
  });
});

describe("runResearchCompare", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-research-compare-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("writes delta.json and sets record.status=compared", async () => {
    seedSandboxedExperiment(tmp, "exp-cmp", {
      pass_rate_small: 0.8,
      pass_rate_full: 0.9,
      regressions: [],
      per_domain: { polyglot: 0.8 },
      p95_latency_ms: null,
      new_error_tags: 0,
    });
    const r = await runResearchCompare({
      workspacePath: tmp,
      expId: "exp-cmp",
      baseline: {
        pass_rate_small: 0.7,
        pass_rate_full: 0.8,
        regressions: [],
        per_domain: { polyglot: 0.7 },
        p95_latency_ms: null,
        new_error_tags: 0,
      },
    });
    expect(r).not.toBeNull();
    expect(r!.compare.mean_delta).toBeCloseTo(0.1, 5);
    const deltaFile = path.join(experimentDir(tmp, "exp-cmp"), "delta.json");
    expect(fs.existsSync(deltaFile)).toBe(true);
    const record = readExperimentRecord(tmp, "exp-cmp");
    expect(record?.status).toBe("compared");
    expect(record?.scores.delta?.mean).toBeCloseTo(0.1, 5);
  });

  it("loads baseline via injected loader when not provided inline", async () => {
    seedSandboxedExperiment(tmp, "exp-load", {
      pass_rate_small: 0.5,
      pass_rate_full: null,
      regressions: [],
      per_domain: {},
      p95_latency_ms: null,
      new_error_tags: 0,
    });
    const r = await runResearchCompare({
      workspacePath: tmp,
      expId: "exp-load",
      loadBaseline: async () => ({
        pass_rate_small: 0.4,
        pass_rate_full: null,
        regressions: [],
        per_domain: {},
        p95_latency_ms: null,
        new_error_tags: 0,
      }),
    });
    expect(r!.compare.mean_delta).toBeCloseTo(0.1, 5);
  });

  it("returns null for unknown experiment", async () => {
    const r = await runResearchCompare({ workspacePath: tmp, expId: "nope" });
    expect(r).toBeNull();
  });
});

describe("runResearchRollout", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-research-roll-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function prepareCompared(
    expId: string,
    sandbox: ExperimentResult,
    baseline: ExperimentResult,
  ) {
    seedSandboxedExperiment(tmp, expId, sandbox);
    await runResearchCompare({ workspacePath: tmp, expId, baseline });
  }

  it("emits a PolicyProposal + queue entry when delta meets threshold", async () => {
    await prepareCompared(
      "exp-ok",
      {
        pass_rate_small: 0.9,
        pass_rate_full: 0.92,
        regressions: [],
        per_domain: { polyglot: 0.9 },
        p95_latency_ms: null,
        new_error_tags: 0,
      },
      {
        pass_rate_small: 0.7,
        pass_rate_full: 0.8,
        regressions: [],
        per_domain: { polyglot: 0.7 },
        p95_latency_ms: null,
        new_error_tags: 0,
      },
    );
    const decision = await runResearchRollout({
      workspacePath: tmp,
      expId: "exp-ok",
      rolloutThreshold: 0.05,
    });
    expect(decision.admitted).toBe(true);
    expect(decision.proposal_id).toBeDefined();

    const proposals = getProposals(tmp);
    expect(proposals.some((p) => p.id === decision.proposal_id)).toBe(true);
    const prop = proposals.find((p) => p.id === decision.proposal_id)!;
    expect(prop.rule).toBe("experiment:exp-ok");
    expect(prop.proposal).toContain("exp-ok");
    expect(prop.autoGenerated).toBe(true);

    const queue = readRolloutQueue(tmp);
    expect(queue).toHaveLength(1);
    expect(queue[0].exp_id).toBe("exp-ok");

    const record = readExperimentRecord(tmp, "exp-ok");
    expect(record?.status).toBe("rollout-proposed");
    expect(record?.rollout?.proposal_id).toBe(decision.proposal_id);
  });

  it("rejects when mean delta is below threshold", async () => {
    await prepareCompared(
      "exp-small",
      {
        pass_rate_small: 0.72,
        pass_rate_full: 0.75,
        regressions: [],
        per_domain: {},
        p95_latency_ms: null,
        new_error_tags: 0,
      },
      {
        pass_rate_small: 0.7,
        pass_rate_full: 0.74,
        regressions: [],
        per_domain: {},
        p95_latency_ms: null,
        new_error_tags: 0,
      },
    );
    const decision = await runResearchRollout({
      workspacePath: tmp,
      expId: "exp-small",
      rolloutThreshold: 0.05,
    });
    expect(decision.admitted).toBe(false);
    expect(decision.reason).toMatch(/mean delta/);
    const record = readExperimentRecord(tmp, "exp-small");
    expect(record?.status).toBe("rejected");
  });

  it("rejects on regression regardless of positive delta", async () => {
    await prepareCompared(
      "exp-reg",
      {
        pass_rate_small: 0.9,
        pass_rate_full: 0.95,
        regressions: ["c7"], // flipped a prior-success case
        per_domain: {},
        p95_latency_ms: null,
        new_error_tags: 0,
      },
      {
        pass_rate_small: 0.6,
        pass_rate_full: 0.7,
        regressions: [],
        per_domain: {},
        p95_latency_ms: null,
        new_error_tags: 0,
      },
    );
    const decision = await runResearchRollout({
      workspacePath: tmp,
      expId: "exp-reg",
      rolloutThreshold: 0.05,
    });
    expect(decision.admitted).toBe(false);
    expect(decision.reason).toMatch(/regression/);
  });

  it("rejects when compare has not run", async () => {
    seedSandboxedExperiment(tmp, "exp-nocompare", {
      pass_rate_small: 0.9,
      pass_rate_full: null,
      regressions: [],
      per_domain: {},
      p95_latency_ms: null,
      new_error_tags: 0,
    });
    const decision = await runResearchRollout({
      workspacePath: tmp,
      expId: "exp-nocompare",
    });
    expect(decision.admitted).toBe(false);
    expect(decision.reason).toMatch(/no compare/);
  });
});

describe("deriveRunVerdict (CR_OODA_HYPOTHESIS_DISCIPLINE)", () => {
  const hypothesis: Hypothesis = {
    id: "H-001",
    claim: "x",
    prediction: "y",
    success_metric: {
      fixture_tag: "H-001-x",
      min_pass_rate: 0.6,
      min_delta_vs_parent: 0.05,
    },
    failure_metric: { regression_forbidden_tags: ["critical"] },
    scope_boundary: ["a.ts"],
  };
  const baseRecord: ExperimentRecord = {
    exp_id: "exp-v",
    created_at: "",
    updated_at: "",
    status: "compared",
    source: { kind: "paper", ref: "x" },
    parent_genid: "initial",
    scope: { allowed_paths: ["a.ts"], denylist_paths: [], max_files: 3 },
    hypothesis_obj: hypothesis,
    scores: {},
  };

  it("pass when both delta + H-pass-rate meet thresholds and no regressions", () => {
    const v = deriveRunVerdict(
      baseRecord,
      { mean_delta: 0.1, per_domain: {}, had_regression: false, regression_ids: [] },
      0.75,
    );
    expect(v).toBe("pass");
  });

  it("signal when only one of delta/H-pass-rate passes", () => {
    expect(
      deriveRunVerdict(
        baseRecord,
        { mean_delta: 0.1, per_domain: {}, had_regression: false, regression_ids: [] },
        0.3,
      ),
    ).toBe("signal");
    expect(
      deriveRunVerdict(
        baseRecord,
        { mean_delta: 0.02, per_domain: {}, had_regression: false, regression_ids: [] },
        0.9,
      ),
    ).toBe("signal");
  });

  it("fail when neither threshold met", () => {
    expect(
      deriveRunVerdict(
        baseRecord,
        { mean_delta: 0.0, per_domain: {}, had_regression: false, regression_ids: [] },
        0.2,
      ),
    ).toBe("fail");
  });

  it("fail on regression when forbidden_tags configured", () => {
    expect(
      deriveRunVerdict(
        baseRecord,
        { mean_delta: 0.1, per_domain: {}, had_regression: true, regression_ids: ["x"] },
        0.9,
      ),
    ).toBe("fail");
  });

  it("falls back to legacy heuristic when no hypothesis_obj", () => {
    const legacyRecord = { ...baseRecord, hypothesis_obj: undefined };
    expect(
      deriveRunVerdict(
        legacyRecord,
        { mean_delta: 0.1, per_domain: {}, had_regression: false, regression_ids: [] },
        null,
      ),
    ).toBe("pass");
    expect(
      deriveRunVerdict(
        legacyRecord,
        { mean_delta: 0.1, per_domain: {}, had_regression: true, regression_ids: ["x"] },
        null,
      ),
    ).toBe("fail");
  });
});

describe("runResearchCompare routing (signal → refining, fail → concluded-dump)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-compare-routing-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function seedWithHypothesis(
    expId: string,
    sandbox: ExperimentResult,
    runHypothesisPassRate: number,
  ): ExperimentRecord {
    const hypothesis: Hypothesis = {
      id: "H-001",
      claim: "x",
      prediction: "y",
      success_metric: {
        fixture_tag: "H-001-x",
        min_pass_rate: 0.6,
        min_delta_vs_parent: 0.05,
      },
      failure_metric: { regression_forbidden_tags: ["critical"] },
      scope_boundary: ["a.ts"],
    };
    const runs: Run[] = [
      {
        run_id: "H-001-R-001",
        started_at: new Date().toISOString(),
        hypothesis_pass_rate: runHypothesisPassRate,
        regression_pass: sandbox.regressions.length === 0,
        verdict: "error",
        notes: "post-sandbox",
      },
    ];
    const record: ExperimentRecord = {
      exp_id: expId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      status: "sandboxed",
      source: { kind: "paper", ref: "x" },
      parent_genid: "initial",
      scope: { allowed_paths: ["a.ts"], denylist_paths: [], max_files: 3 },
      hypothesis_obj: hypothesis,
      runs,
      max_runs: 3,
      scores: { sandbox },
    };
    fs.mkdirSync(experimentDir(tmp, expId), { recursive: true });
    writeExperimentRecord(tmp, record);
    fs.writeFileSync(
      path.join(experimentDir(tmp, expId), "diff.patch"),
      "diff --git a/x b/x\n",
      "utf-8",
    );
    return record;
  }

  it("signal verdict → record transitions to refining", async () => {
    seedWithHypothesis(
      "exp-signal",
      {
        pass_rate_small: 0.6,
        pass_rate_full: 0.62,
        regressions: [],
        per_domain: {},
        p95_latency_ms: null,
        new_error_tags: 0,
      },
      0.2, // H-pass-rate below threshold
    );
    const r = await runResearchCompare({
      workspacePath: tmp,
      expId: "exp-signal",
      baseline: {
        pass_rate_small: 0.5,
        pass_rate_full: 0.5,
        regressions: [],
        per_domain: {},
        p95_latency_ms: null,
        new_error_tags: 0,
      },
    });
    expect(r?.verdict).toBe("signal");
    const rec = readExperimentRecord(tmp, "exp-signal");
    expect(rec?.status).toBe("refining");
  });

  it("fail verdict → concluded-dump with close-out row", async () => {
    seedWithHypothesis(
      "exp-fail",
      {
        pass_rate_small: 0.3,
        pass_rate_full: 0.3,
        regressions: [],
        per_domain: {},
        p95_latency_ms: null,
        new_error_tags: 0,
      },
      0.1,
    );
    const r = await runResearchCompare({
      workspacePath: tmp,
      expId: "exp-fail",
      baseline: {
        pass_rate_small: 0.5,
        pass_rate_full: 0.5,
        regressions: [],
        per_domain: {},
        p95_latency_ms: null,
        new_error_tags: 0,
      },
    });
    expect(r?.verdict).toBe("fail");
    const rec = readExperimentRecord(tmp, "exp-fail");
    expect(rec?.status).toBe("concluded-dump");
    expect(rec?.conclusion?.verdict).toBe("dump");
  });

  it("pass verdict → stays at compared for rollout path", async () => {
    seedWithHypothesis(
      "exp-pass",
      {
        pass_rate_small: 0.9,
        pass_rate_full: 0.9,
        regressions: [],
        per_domain: {},
        p95_latency_ms: null,
        new_error_tags: 0,
      },
      0.9,
    );
    const r = await runResearchCompare({
      workspacePath: tmp,
      expId: "exp-pass",
      baseline: {
        pass_rate_small: 0.5,
        pass_rate_full: 0.5,
        regressions: [],
        per_domain: {},
        p95_latency_ms: null,
        new_error_tags: 0,
      },
    });
    expect(r?.verdict).toBe("pass");
    const rec = readExperimentRecord(tmp, "exp-pass");
    expect(rec?.status).toBe("compared");
  });
});
