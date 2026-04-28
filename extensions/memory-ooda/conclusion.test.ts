import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { concludeExperiment, readCloseOuts } from "./conclusion.js";
import type { Hypothesis } from "./hypothesis-schema.js";
import { readResearchLog, writeExperimentRecord, type ExperimentRecord } from "./research-loop.js";

function seedExperiment(tmp: string, overrides: Partial<ExperimentRecord> = {}): ExperimentRecord {
  const now = new Date().toISOString();
  const hypothesis_obj: Hypothesis = {
    id: "H-017",
    claim: "x",
    prediction: "y",
    success_metric: {
      fixture_tag: "H-017-x",
      min_pass_rate: 0.6,
      min_delta_vs_parent: 0.05,
    },
    failure_metric: { regression_forbidden_tags: ["critical"] },
    scope_boundary: ["a.ts"],
  };
  const record: ExperimentRecord = {
    exp_id: "exp-test",
    created_at: now,
    updated_at: now,
    status: "sandboxed",
    source: { kind: "paper", ref: "arxiv:1234" },
    parent_genid: "initial",
    scope: { allowed_paths: ["a.ts"], denylist_paths: [], max_files: 3 },
    hypothesis_obj,
    scores: {},
    ...overrides,
  };
  writeExperimentRecord(tmp, record);
  return record;
}

describe("concludeExperiment", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-conclusion-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("stamps conclusion into record and appends close-out row to research log", () => {
    seedExperiment(tmp);
    const r = concludeExperiment(tmp, "exp-test", {
      verdict: "dump",
      learning: "fixtures didn't encode the claim tightly enough",
      authored_by: "system",
    });
    expect(r.record?.conclusion?.verdict).toBe("dump");
    expect(r.closeOut?.hypothesis_id).toBe("H-017");
    expect(r.closeOut?.verdict).toBe("dump");

    const closeOuts = readCloseOuts(tmp);
    expect(closeOuts).toHaveLength(1);
    expect(closeOuts[0].exp_id).toBe("exp-test");
    expect(closeOuts[0].source_candidate_id).toBe("arxiv:1234");
  });

  it("close-out rows don't pollute readResearchLog output", () => {
    seedExperiment(tmp);
    concludeExperiment(tmp, "exp-test", {
      verdict: "stage",
      learning: "promoted",
      authored_by: "human",
    });
    const candidates = readResearchLog(tmp);
    expect(candidates).toHaveLength(0); // only close-out rows present
  });

  it("returns nulls when record doesn't exist", () => {
    const r = concludeExperiment(tmp, "not-a-thing", {
      verdict: "dump",
      learning: "",
      authored_by: "system",
    });
    expect(r.record).toBeNull();
    expect(r.closeOut).toBeNull();
  });
});
