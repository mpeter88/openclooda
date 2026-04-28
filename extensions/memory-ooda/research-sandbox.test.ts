import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveAdmissionCase } from "./admission-gate.js";
import {
  experimentDir,
  readExperimentRecord,
  writeExperimentRecord,
  type ExperimentRecord,
} from "./research-loop.js";
import {
  evalCases,
  runResearchSandbox,
  type IsolationDeps,
  type SandboxIsolation,
} from "./research-sandbox.js";
import type { AdmissionCase } from "./types.js";

function mkCase(
  id: string,
  priorOutcome: AdmissionCase["priorOutcome"] = "success",
): AdmissionCase {
  return {
    id,
    label: id,
    fixture: {
      observation: "",
      knowledge: {} as AdmissionCase["fixture"]["knowledge"],
      priorities: {} as AdmissionCase["fixture"]["priorities"],
    },
    expected: {
      actionId: id,
      description: "",
      successSignal: "",
      failureSignal: "",
      domain: "ops",
    },
    priorOutcome,
    capturedAt: new Date().toISOString(),
  };
}

function seedExperiment(tmp: string, expId: string, diff: string): ExperimentRecord {
  const now = new Date().toISOString();
  const record: ExperimentRecord = {
    exp_id: expId,
    created_at: now,
    updated_at: now,
    status: "proposed",
    source: { kind: "paper", ref: "arxiv:x" },
    parent_genid: "initial",
    scope: { allowed_paths: [], denylist_paths: [], max_files: 3 },
    scores: {},
  };
  writeExperimentRecord(tmp, record);
  fs.writeFileSync(path.join(experimentDir(tmp, expId), "diff.patch"), diff, "utf-8");
  return record;
}

function mockIsolation(outcomes: Record<string, "success" | "failure">): IsolationDeps {
  return {
    applyDiff: vi.fn(
      async (expId: string, _diff: string): Promise<SandboxIsolation> => ({
        handle: `mock://${expId}`,
        cleanup: async () => {
          /* noop */
        },
      }),
    ),
    runCase: vi.fn(async (_iso, fixture) => {
      const actionId = fixture.observation || "";
      const desired = outcomes[actionId] ?? "success";
      if (desired === "success") {
        return { source: "tool_result", success: true, toolName: "t", summary: "" };
      }
      return { source: "tool_result", success: false, toolName: "t", summary: "" };
    }),
  };
}

describe("evalCases", () => {
  it("counts successes + failures + regressions", async () => {
    const iso: SandboxIsolation = { handle: "x", cleanup: async () => {} };
    const deps: IsolationDeps = {
      applyDiff: async () => iso,
      runCase: async (_i, f) => {
        if ((f.observation as string) === "a") {
          return { source: "tool_result", success: true, toolName: "t", summary: "" };
        }
        return { source: "tool_result", success: false, toolName: "t", summary: "" };
      },
    };
    const cases = [
      { ...mkCase("a"), fixture: { ...mkCase("a").fixture, observation: "a" } },
      { ...mkCase("b"), fixture: { ...mkCase("b").fixture, observation: "b" } },
      { ...mkCase("c", "failure"), fixture: { ...mkCase("c").fixture, observation: "c" } },
    ];
    const r = await evalCases(iso, cases, deps, 5000);
    expect(r.passed).toBe(1);
    expect(r.failed).toEqual(["b", "c"]);
    // Only `b` is a regression (priorOutcome=success); `c` already failed before.
    expect(r.regressions).toEqual(["b"]);
  });

  it("timeout on a case counts as failure (with regression if prior=success)", async () => {
    const iso: SandboxIsolation = { handle: "x", cleanup: async () => {} };
    const deps: IsolationDeps = {
      applyDiff: async () => iso,
      runCase: async () =>
        new Promise(() => {
          /* never resolves */
        }),
    };
    const r = await evalCases(iso, [mkCase("t1")], deps, 50);
    expect(r.failed).toEqual(["t1"]);
    expect(r.regressions).toEqual(["t1"]);
  });
});

describe("runResearchSandbox staged eval", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-research-sbx-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("expands to full set when small subset clears the threshold", async () => {
    for (let i = 0; i < 10; i++) saveAdmissionCase(tmp, mkCase(`c${i}`));
    seedExperiment(
      tmp,
      "exp-expand",
      "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n",
    );

    const deps = mockIsolation({});
    const r = await runResearchSandbox("exp-expand", deps, {
      workspacePath: tmp,
      smallSubsetSize: 3,
      expandThreshold: 0.5,
    });
    expect(r.expanded_to_full).toBe(true);
    expect(r.result.pass_rate_small).toBe(1);
    expect(r.result.pass_rate_full).toBe(1);
  });

  it("stays on the small subset when threshold not met", async () => {
    for (let i = 0; i < 10; i++) saveAdmissionCase(tmp, mkCase(`c${i}`));
    seedExperiment(
      tmp,
      "exp-noexpand",
      "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n",
    );

    const deps: IsolationDeps = {
      applyDiff: async (expId) => ({ handle: expId, cleanup: async () => {} }),
      // Every case fails → pass_rate_small = 0 → below 0.4 threshold.
      runCase: async () => ({ source: "tool_result", success: false, toolName: "t", summary: "" }),
    };
    const r = await runResearchSandbox("exp-noexpand", deps, {
      workspacePath: tmp,
      smallSubsetSize: 3,
      expandThreshold: 0.4,
    });
    expect(r.expanded_to_full).toBe(false);
    expect(r.result.pass_rate_full).toBeNull();
    expect(r.result.stagedeval_frac_applied).toBeCloseTo(3 / 10, 5);
  });

  it("writes sandbox-score.json and updates record status to sandboxed", async () => {
    saveAdmissionCase(tmp, mkCase("c0"));
    saveAdmissionCase(tmp, mkCase("c1"));
    seedExperiment(
      tmp,
      "exp-status",
      "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n",
    );

    await runResearchSandbox("exp-status", mockIsolation({}), {
      workspacePath: tmp,
      smallSubsetSize: 2,
      expandThreshold: 0.5,
    });

    const dir = experimentDir(tmp, "exp-status");
    expect(fs.existsSync(path.join(dir, "sandbox-score.json"))).toBe(true);
    const scoreFile = JSON.parse(fs.readFileSync(path.join(dir, "sandbox-score.json"), "utf-8"));
    expect(scoreFile.result.pass_rate_small).toBe(1);

    const record = readExperimentRecord(tmp, "exp-status");
    expect(record?.status).toBe("sandboxed");
    expect(record?.scores.sandbox).toBeDefined();
  });

  it("throws when diff.patch is missing", async () => {
    writeExperimentRecord(tmp, {
      exp_id: "exp-missing",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      status: "proposed",
      source: { kind: "paper", ref: "x" },
      parent_genid: "initial",
      scope: { allowed_paths: [], denylist_paths: [], max_files: 3 },
      scores: {},
    });
    await expect(
      runResearchSandbox("exp-missing", mockIsolation({}), { workspacePath: tmp }),
    ).rejects.toThrow(/diff\.patch missing/);
  });

  it("cleanup is called even when evalCases throws", async () => {
    saveAdmissionCase(tmp, mkCase("c0"));
    seedExperiment(
      tmp,
      "exp-cleanup",
      "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n",
    );
    const cleanup = vi.fn(async () => {
      /* noop */
    });
    const deps: IsolationDeps = {
      applyDiff: async (_expId) => ({ handle: "x", cleanup }),
      runCase: async () => {
        throw new Error("apply failed");
      },
    };
    const r = await runResearchSandbox("exp-cleanup", deps, {
      workspacePath: tmp,
      smallSubsetSize: 1,
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(r.result.pass_rate_small).toBe(0);
  });
});
