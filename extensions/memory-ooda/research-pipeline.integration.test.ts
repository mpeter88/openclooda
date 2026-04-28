/**
 * CR_OODA_HYPOTHESIS_DISCIPLINE_HARDENING — Finding 6: end-to-end integration.
 *
 * Composition test for the full research pipeline:
 *
 *   Happy: propose → R-001 signal → refine_tests → R-002 pass → rollout-proposed
 *   Sad:   propose → R-001 signal → refine_tests → R-002 signal → refine_tests
 *          → R-003 signal → refine sees max_runs → concluded-dump
 *
 * Each stage is driven directly via its module entry-point so we exercise the
 * contracts between modules (propose ↔ sandbox ↔ compare ↔ refine ↔ rollout)
 * without depending on the tick dispatcher's stage selection. The dispatcher
 * itself has narrower coverage in research-tick.test.ts.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveAdmissionCase } from "./admission-gate.js";
import { readCloseOuts } from "./conclusion.js";
import { runResearchCompare, runResearchRollout } from "./research-compare.js";
import { experimentDir, readExperimentRecord, type ResearchCandidate } from "./research-loop.js";
import { runResearchPropose } from "./research-propose.js";
import { runResearchRefine } from "./research-refine.js";
import {
  runResearchSandbox,
  type IsolationDeps,
  type SandboxIsolation,
} from "./research-sandbox.js";
import type { ModelCallFn } from "./triage.js";
import type { AdmissionCase } from "./types.js";

const FIXTURE_TAG = "H-curiosity-amb";
const ALLOWED_PATH = "extensions/memory-ooda/council.ts";

const VALID_DIFF = `diff --git a/extensions/memory-ooda/council.ts b/extensions/memory-ooda/council.ts
--- a/extensions/memory-ooda/council.ts
+++ b/extensions/memory-ooda/council.ts
@@ -1 +1,2 @@
 x
+y
`;

const CANDIDATE: ResearchCandidate = {
  id: "arxiv:integration-test",
  source: "arxiv",
  title: "integration",
  abstract: "integration test",
  discovered_at: new Date().toISOString(),
  relevance_score: 0.9,
  relevance_rationale: "test",
};

function makeFixture(id: string): AdmissionCase {
  return {
    id,
    label: id,
    fixture: { observation: id, knowledge: {}, priorities: {} } as AdmissionCase["fixture"],
    expected: {
      actionId: id,
      description: "",
      successSignal: "",
      failureSignal: "",
      domain: "ops",
    },
    priorOutcome: "success",
    capturedAt: new Date().toISOString(),
    tags: [FIXTURE_TAG],
  };
}

function buildProposalJSON(): string {
  return JSON.stringify({
    proposal_md: "test proposal",
    hypothesis: {
      claim: "x",
      prediction: "y",
      success_metric: {
        fixture_tag: FIXTURE_TAG,
        min_pass_rate: 0.6,
        min_delta_vs_parent: 0.05,
      },
      failure_metric: { regression_forbidden_tags: ["critical"] },
    },
    value: {
      what_it_adds: "experiment",
      why_now: "now",
      roadmap_link: { mode: "existing", horizon: "current", epic: "curiosity" },
      est_impact: 0.5,
      est_effort: 0.2,
    },
    hypothesis_fixtures: {
      fixtures: [makeFixture("fx-001")],
      rationale: "tight",
    },
    allowed_paths: [ALLOWED_PATH],
    diff: VALID_DIFF,
  });
}

function buildRefineTestsJSON(idSuffix: string): string {
  return JSON.stringify({
    action: "refine_tests",
    rationale: `tightening fixtures ${idSuffix}`,
    new_fixtures: {
      fixtures: [makeFixture(`fx-${idSuffix}`)],
      rationale: "tighter",
    },
  });
}

/**
 * Mock isolation. `passActionIds` is the set of fixture observation strings
 * that succeed — anything else fails. The isolation captures the fixture's
 * observation and uses it as the routing key.
 */
function makeIsolation(passActionIds: Set<string>): IsolationDeps {
  return {
    applyDiff: async (expId): Promise<SandboxIsolation> => ({
      handle: expId,
      cleanup: async () => {
        /* noop */
      },
    }),
    runCase: async (_iso, fixture) => {
      const observation = String(fixture.observation ?? "");
      if (passActionIds.has(observation)) {
        return { source: "tool_result", success: true, toolName: "t", summary: "" };
      }
      return { source: "tool_result", success: false, toolName: "t", summary: "" };
    },
  };
}

function seedRoadmap(tmp: string): void {
  fs.writeFileSync(
    path.join(tmp, "ROADMAP.md"),
    "# ROADMAP\n## Current\n### curiosity curiosity-driven exploration\n",
    "utf-8",
  );
}

function seedAdmission(tmp: string): void {
  // Minimal regression corpus — none of these carry the H-fixture tag, so
  // they only contribute to mean_delta, not hypothesis_pass_rate.
  for (let i = 0; i < 5; i++) {
    saveAdmissionCase(tmp, {
      id: `reg-${i}`,
      label: `reg-${i}`,
      fixture: {
        observation: `reg-${i}`,
        knowledge: {},
        priorities: {},
      } as AdmissionCase["fixture"],
      expected: {
        actionId: `reg-${i}`,
        description: "",
        successSignal: "",
        failureSignal: "",
        domain: "ops",
      },
      priorOutcome: "success",
      capturedAt: new Date().toISOString(),
    });
  }
}

describe("research pipeline — end-to-end integration", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-pipeline-int-"));
    seedRoadmap(tmp);
    seedAdmission(tmp);
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("happy path: propose → R-001 signal → refine_tests → R-002 pass → rollout-proposed", async () => {
    // Stateful callModel: first call = proposal, second = refine_tests.
    let callIdx = 0;
    const callModel: ModelCallFn = vi.fn(async () => {
      callIdx++;
      if (callIdx === 1) return buildProposalJSON();
      if (callIdx === 2) return buildRefineTestsJSON("r2");
      throw new Error(`unexpected callModel call ${callIdx}`);
    });

    // Stage 1 — propose. R-001 placeholder seeded.
    const proposeResult = await runResearchPropose(tmp, callModel, {
      candidate: CANDIDATE,
      architectureSummary: "",
      parentGenid: "initial",
    });
    expect(proposeResult.experiment.status).toBe("proposed");
    expect(proposeResult.validation.valid).toBe(true);
    const expId = proposeResult.experiment.exp_id;

    // Stage 2 — sandbox R-001 with all H-fixtures FAILING. Regression corpus
    // passes (positive mean_delta), but H-pass-rate=0 → "signal" verdict.
    await runResearchSandbox(
      expId,
      makeIsolation(new Set(["reg-0", "reg-1", "reg-2", "reg-3", "reg-4"])),
      {
        workspacePath: tmp,
        smallSubsetSize: 3,
      },
    );
    let rec = readExperimentRecord(tmp, expId)!;
    expect(rec.status).toBe("sandboxed");
    expect(rec.runs?.[0].run_id).toMatch(/-R-001$/);

    // Stage 3 — compare. mean_delta>0 (sandbox passes vs zero baseline),
    // H-pass-rate=0 < 0.6 → "signal" → status=refining.
    const compareR001 = await runResearchCompare({
      workspacePath: tmp,
      expId,
      baseline: {
        pass_rate_small: 0,
        pass_rate_full: 0,
        regressions: [],
        per_domain: {},
        p95_latency_ms: null,
        new_error_tags: 0,
      },
    });
    expect(compareR001?.verdict).toBe("signal");
    rec = readExperimentRecord(tmp, expId)!;
    expect(rec.status).toBe("refining");

    // Stage 4 — refine_tests. Generates R-002 placeholder, rewrites fixtures
    // to pass on the next sandbox eval. Status → sandboxed.
    const refineResult = await runResearchRefine(tmp, callModel, { expId });
    expect(refineResult.outcome).toBe("refined");
    expect(refineResult.action).toBe("refine_tests");
    expect(refineResult.nextRunId).toMatch(/-R-002$/);
    rec = readExperimentRecord(tmp, expId)!;
    expect(rec.runs).toHaveLength(2);
    expect(rec.status).toBe("sandboxed");

    // Stage 5 — sandbox R-002 with H-fixture fx-r2 passing. Regression corpus
    // also passes. H-pass-rate=1, mean_delta>0 → next compare = "pass".
    await runResearchSandbox(
      expId,
      makeIsolation(new Set(["reg-0", "reg-1", "reg-2", "reg-3", "reg-4", "fx-r2"])),
      { workspacePath: tmp, smallSubsetSize: 3 },
    );
    rec = readExperimentRecord(tmp, expId)!;
    expect(rec.runs?.[1].hypothesis_pass_rate).toBe(1);

    // Stage 6 — compare R-002. verdict=pass → stays at compared.
    const compareR002 = await runResearchCompare({
      workspacePath: tmp,
      expId,
      baseline: {
        pass_rate_small: 0,
        pass_rate_full: 0,
        regressions: [],
        per_domain: {},
        p95_latency_ms: null,
        new_error_tags: 0,
      },
    });
    expect(compareR002?.verdict).toBe("pass");
    rec = readExperimentRecord(tmp, expId)!;
    expect(rec.status).toBe("compared");

    // Stage 7 — rollout. Verdict=pass and (per Finding 7) trusts the verdict
    // without a second threshold gate.
    const rollout = await runResearchRollout({ workspacePath: tmp, expId });
    expect(rollout.admitted).toBe(true);
    rec = readExperimentRecord(tmp, expId)!;
    expect(rec.status).toBe("rollout-proposed");
    expect(rec.rollout?.proposal_id).toBeDefined();
  });

  it("sad path: 3 signal verdicts → max_runs reached → concluded-dump with close-out row", async () => {
    let callIdx = 0;
    const callModel: ModelCallFn = vi.fn(async () => {
      callIdx++;
      if (callIdx === 1) return buildProposalJSON();
      if (callIdx === 2) return buildRefineTestsJSON("r2");
      if (callIdx === 3) return buildRefineTestsJSON("r3");
      throw new Error(`unexpected callModel call ${callIdx}`);
    });

    // Propose.
    const proposeResult = await runResearchPropose(tmp, callModel, {
      candidate: CANDIDATE,
      architectureSummary: "",
      parentGenid: "initial",
    });
    const expId = proposeResult.experiment.exp_id;

    // Sandbox R-001: H-fixture fails → signal.
    await runResearchSandbox(
      expId,
      makeIsolation(new Set(["reg-0", "reg-1", "reg-2", "reg-3", "reg-4"])),
      {
        workspacePath: tmp,
        smallSubsetSize: 3,
      },
    );
    await runResearchCompare({
      workspacePath: tmp,
      expId,
      baseline: {
        pass_rate_small: 0,
        pass_rate_full: 0,
        regressions: [],
        per_domain: {},
        p95_latency_ms: null,
        new_error_tags: 0,
      },
    });
    expect(readExperimentRecord(tmp, expId)?.status).toBe("refining");

    // Refine R-002.
    await runResearchRefine(tmp, callModel, { expId });
    // Sandbox R-002: H-fixture fails again → signal.
    await runResearchSandbox(
      expId,
      makeIsolation(new Set(["reg-0", "reg-1", "reg-2", "reg-3", "reg-4"])),
      {
        workspacePath: tmp,
        smallSubsetSize: 3,
      },
    );
    await runResearchCompare({
      workspacePath: tmp,
      expId,
      baseline: {
        pass_rate_small: 0,
        pass_rate_full: 0,
        regressions: [],
        per_domain: {},
        p95_latency_ms: null,
        new_error_tags: 0,
      },
    });
    expect(readExperimentRecord(tmp, expId)?.status).toBe("refining");

    // Refine R-003.
    await runResearchRefine(tmp, callModel, { expId });
    // Sandbox R-003: still fails.
    await runResearchSandbox(
      expId,
      makeIsolation(new Set(["reg-0", "reg-1", "reg-2", "reg-3", "reg-4"])),
      {
        workspacePath: tmp,
        smallSubsetSize: 3,
      },
    );
    await runResearchCompare({
      workspacePath: tmp,
      expId,
      baseline: {
        pass_rate_small: 0,
        pass_rate_full: 0,
        regressions: [],
        per_domain: {},
        p95_latency_ms: null,
        new_error_tags: 0,
      },
    });
    expect(readExperimentRecord(tmp, expId)?.status).toBe("refining");

    // Refine called 4th time — realRuns=3 ≥ max_runs=3 → concluded-dump.
    const finalRefine = await runResearchRefine(tmp, callModel, { expId });
    expect(finalRefine.outcome).toBe("max_runs_reached");
    const final = readExperimentRecord(tmp, expId)!;
    expect(final.status).toBe("concluded-dump");
    expect(final.conclusion?.verdict).toBe("dump");
    expect(final.conclusion?.learning).toMatch(/max_runs/);

    // Close-out row appended to .research-log.jsonl.
    const closeOuts = readCloseOuts(tmp);
    const ours = closeOuts.find((c) => c.exp_id === expId);
    expect(ours?.verdict).toBe("dump");
    expect(ours?.hypothesis_id).toMatch(/^H-/);

    // Audit trail: each refine wrote a runs/<R>/refine.json side-car.
    const expDir = experimentDir(tmp, expId);
    expect(fs.existsSync(path.join(expDir, "runs", final.runs![1].run_id, "refine.json"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(expDir, "runs", final.runs![2].run_id, "refine.json"))).toBe(
      true,
    );
  });
});
