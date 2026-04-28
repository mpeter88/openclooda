import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hypothesis, Run } from "./hypothesis-schema.js";
import {
  experimentDir,
  readExperimentRecord,
  writeExperimentRecord,
  type ExperimentRecord,
} from "./research-loop.js";
import { parseRefineDraft, runResearchRefine } from "./research-refine.js";
import type { ModelCallFn } from "./triage.js";

const SAMPLE_DIFF = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1 +1 @@
-a
+b
`;

function seedExperimentRefining(tmp: string, runsCount: number = 1): ExperimentRecord {
  const now = new Date().toISOString();
  const hypothesis_obj: Hypothesis = {
    id: "H-017",
    claim: "old claim",
    prediction: "old prediction",
    success_metric: {
      fixture_tag: "H-017-x",
      min_pass_rate: 0.6,
      min_delta_vs_parent: 0.05,
    },
    failure_metric: { regression_forbidden_tags: ["critical"] },
    scope_boundary: ["extensions/memory-ooda/council.ts"],
  };
  const runs: Run[] = Array.from({ length: runsCount }, (_, i) => ({
    run_id: `H-017-R-${String(i + 1).padStart(3, "0")}`,
    started_at: now,
    ended_at: now,
    verdict: "signal",
    notes: `run ${i + 1}`,
  }));
  const record: ExperimentRecord = {
    exp_id: "exp-refine-1",
    created_at: now,
    updated_at: now,
    status: "refining",
    source: { kind: "paper", ref: "arxiv:1234" },
    parent_genid: "initial",
    scope: {
      allowed_paths: ["extensions/memory-ooda/council.ts"],
      denylist_paths: [],
      max_files: 3,
    },
    hypothesis_obj,
    runs,
    max_runs: 3,
    scores: {},
  };
  fs.mkdirSync(experimentDir(tmp, record.exp_id), { recursive: true });
  writeExperimentRecord(tmp, record);
  return record;
}

describe("parseRefineDraft", () => {
  it("parses refine_tests shape", () => {
    const raw = JSON.stringify({
      action: "refine_tests",
      rationale: "old fixtures too loose",
      new_fixtures: {
        fixtures: [
          {
            id: "fx-new",
            label: "tight",
            fixture: { observation: "x", knowledge: {}, priorities: {} },
            expected: {
              actionId: "a",
              description: "",
              successSignal: "",
              failureSignal: "",
              domain: "ops",
            },
            priorOutcome: "success",
            capturedAt: new Date().toISOString(),
          },
        ],
        rationale: "tighter",
      },
    });
    const d = parseRefineDraft(raw);
    expect(d.action).toBe("refine_tests");
    expect(d.new_fixtures?.fixtures).toHaveLength(1);
  });

  it("parses refine_hypothesis_and_diff shape", () => {
    const raw = JSON.stringify({
      action: "refine_hypothesis_and_diff",
      rationale: "claim too strong",
      new_claim: "narrower claim",
      new_prediction: "narrower prediction",
      new_diff: SAMPLE_DIFF,
    });
    const d = parseRefineDraft(raw);
    expect(d.action).toBe("refine_hypothesis_and_diff");
    expect(d.new_diff).toBe(SAMPLE_DIFF);
  });

  it("throws on invalid action", () => {
    expect(() => parseRefineDraft(JSON.stringify({ action: "explode" }))).toThrow();
  });

  it("throws when refine_tests has no fixtures", () => {
    expect(() =>
      parseRefineDraft(JSON.stringify({ action: "refine_tests", new_fixtures: { fixtures: [] } })),
    ).toThrow();
  });

  it("throws when refine_hypothesis_and_diff missing diff", () => {
    expect(() =>
      parseRefineDraft(
        JSON.stringify({
          action: "refine_hypothesis_and_diff",
          new_claim: "x",
          new_prediction: "y",
        }),
      ),
    ).toThrow();
  });
});

describe("runResearchRefine", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-research-refine-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("refine_tests overwrites top-level fixtures file + transitions to sandboxed", async () => {
    seedExperimentRefining(tmp);
    const callModel: ModelCallFn = vi.fn(async () =>
      JSON.stringify({
        action: "refine_tests",
        rationale: "old fixtures too loose",
        new_fixtures: {
          fixtures: [
            {
              id: "fx-tight",
              label: "tight",
              fixture: { observation: "", knowledge: {}, priorities: {} },
              expected: {
                actionId: "a",
                description: "",
                successSignal: "",
                failureSignal: "",
                domain: "ops",
              },
              priorOutcome: "success",
              capturedAt: new Date().toISOString(),
            },
          ],
          rationale: "tighter",
        },
      }),
    );
    const r = await runResearchRefine(tmp, callModel, { expId: "exp-refine-1" });
    expect(r.outcome).toBe("refined");
    expect(r.action).toBe("refine_tests");
    expect(r.nextRunId).toBe("H-017-R-002");
    const updated = readExperimentRecord(tmp, "exp-refine-1");
    expect(updated?.status).toBe("sandboxed");
    expect(updated?.runs).toHaveLength(2);
    const dir = experimentDir(tmp, "exp-refine-1");
    expect(fs.readFileSync(path.join(dir, "hypothesis-fixtures.jsonl"), "utf-8")).toContain(
      "fx-tight",
    );
    expect(fs.existsSync(path.join(dir, "runs", "H-017-R-002", "refine.json"))).toBe(true);
  });

  it("refine_hypothesis_and_diff rewrites claim + diff", async () => {
    seedExperimentRefining(tmp);
    const callModel: ModelCallFn = vi.fn(async () =>
      JSON.stringify({
        action: "refine_hypothesis_and_diff",
        rationale: "claim too strong",
        new_claim: "tighter claim",
        new_prediction: "tighter prediction",
        new_diff: SAMPLE_DIFF,
      }),
    );
    const r = await runResearchRefine(tmp, callModel, { expId: "exp-refine-1" });
    expect(r.outcome).toBe("refined");
    expect(r.action).toBe("refine_hypothesis_and_diff");
    const updated = readExperimentRecord(tmp, "exp-refine-1");
    expect(updated?.hypothesis_obj?.claim).toBe("tighter claim");
    expect(updated?.status).toBe("sandboxed");
    const dir = experimentDir(tmp, "exp-refine-1");
    expect(fs.readFileSync(path.join(dir, "diff.patch"), "utf-8")).toContain("+b");
  });

  it("concludes with dump when max_runs reached", async () => {
    seedExperimentRefining(tmp, 3); // already at max
    const callModel: ModelCallFn = vi.fn(); // should never be called
    const r = await runResearchRefine(tmp, callModel, { expId: "exp-refine-1" });
    expect(r.outcome).toBe("max_runs_reached");
    expect(callModel).not.toHaveBeenCalled();
    const updated = readExperimentRecord(tmp, "exp-refine-1");
    expect(updated?.status).toBe("concluded-dump");
    expect(updated?.conclusion?.verdict).toBe("dump");
  });

  it("returns not_applicable when record is not in refining state", async () => {
    const r0 = seedExperimentRefining(tmp);
    writeExperimentRecord(tmp, { ...r0, status: "compared" });
    const callModel: ModelCallFn = vi.fn();
    const r = await runResearchRefine(tmp, callModel, { expId: "exp-refine-1" });
    expect(r.outcome).toBe("not_applicable");
    expect(callModel).not.toHaveBeenCalled();
  });

  it("returns parse_error when model response malformed", async () => {
    seedExperimentRefining(tmp);
    const callModel: ModelCallFn = vi.fn(async () => "not json");
    const r = await runResearchRefine(tmp, callModel, { expId: "exp-refine-1" });
    expect(r.outcome).toBe("parse_error");
  });
});
