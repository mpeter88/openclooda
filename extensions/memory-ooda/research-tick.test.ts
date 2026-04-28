import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveAdmissionCase } from "./admission-gate.js";
import { appendGeneration, markValidParent } from "./agent-archive.js";
import {
  appendCandidate,
  experimentDir,
  listExperiments,
  writeExperimentRecord,
  type ExperimentRecord,
} from "./research-loop.js";
import type { IsolationDeps, SandboxIsolation } from "./research-sandbox.js";
import { pickParentGenid, runResearchTickOnce } from "./research-tick.js";
import type { ModelCallFn } from "./triage.js";
import type { AdmissionCase } from "./types.js";

const ATOM_FIXTURE = `<?xml version="1.0"?>
<feed>
  <entry>
    <id>arxiv:test-discover</id>
    <title>Self-improving agents via code diffs</title>
    <summary>agents modify their own source code</summary>
    <link href="http://arxiv.example/abs/test"/>
  </entry>
</feed>`;

const VALID_DIFF = `diff --git a/extensions/memory-ooda/council.ts b/extensions/memory-ooda/council.ts
--- a/extensions/memory-ooda/council.ts
+++ b/extensions/memory-ooda/council.ts
@@ -1 +1,2 @@
 x
+y
`;

function discoverCallModel(): ModelCallFn {
  return vi.fn(async () => JSON.stringify({ score: 0.9, rationale: "direct" }));
}

function proposeCallModel(): ModelCallFn {
  return vi.fn(async () =>
    JSON.stringify({
      proposal_md: "test proposal",
      hypothesis: "this works",
      allowed_paths: ["extensions/memory-ooda/council.ts"],
      diff: VALID_DIFF,
    }),
  );
}

const mkCase = (id: string): AdmissionCase => ({
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
  priorOutcome: "success",
  capturedAt: new Date().toISOString(),
});

function alwaysPassIsolation(): IsolationDeps {
  return {
    applyDiff: async (expId): Promise<SandboxIsolation> => ({
      handle: expId,
      cleanup: async () => {
        /* noop */
      },
    }),
    runCase: async () => ({ source: "tool_result", success: true, toolName: "t", summary: "" }),
  };
}

describe("runResearchTickOnce — dispatch precedence", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-research-tick-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const baseConfig = {
    feeds: ["http://arxiv.example/rss"],
    keywords: ["self-improving"],
    architectureSummary: "test",
  };

  it("empty state → action=discover", async () => {
    const callModel = discoverCallModel();
    const r = await runResearchTickOnce(tmp, callModel, {
      ...baseConfig,
      fetchUrl: async () => ATOM_FIXTURE,
    });
    expect(r.action).toBe("discover");
    expect(r.details).toMatch(/accepted=/);
  });

  it("candidate pending → action=propose", async () => {
    appendCandidate(tmp, {
      id: "arxiv:already",
      source: "arxiv",
      title: "Already discovered",
      discovered_at: new Date().toISOString(),
      relevance_score: 0.9,
    });
    const callModel = proposeCallModel();
    const r = await runResearchTickOnce(tmp, callModel, baseConfig);
    expect(r.action).toBe("propose");
    expect(r.advanced_exp_id).toMatch(/^exp-/);
  });

  it("proposed experiment → action=sandbox when enabled", async () => {
    for (let i = 0; i < 3; i++) saveAdmissionCase(tmp, mkCase(`c${i}`));
    const record: ExperimentRecord = {
      exp_id: "exp-pending",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      status: "proposed",
      source: { kind: "paper", ref: "arxiv:x" },
      parent_genid: "initial",
      scope: {
        allowed_paths: ["extensions/memory-ooda/council.ts"],
        denylist_paths: [],
        max_files: 3,
      },
      scores: {},
    };
    writeExperimentRecord(tmp, record);
    fs.writeFileSync(
      path.join(experimentDir(tmp, "exp-pending"), "diff.patch"),
      VALID_DIFF,
      "utf-8",
    );

    const r = await runResearchTickOnce(tmp, vi.fn(), {
      ...baseConfig,
      enableSandbox: true,
      isolation: alwaysPassIsolation(),
    });
    expect(r.action).toBe("sandbox");
    expect(r.advanced_exp_id).toBe("exp-pending");
    const finished = listExperiments(tmp).find((e) => e.exp_id === "exp-pending");
    expect(finished?.status).toBe("sandboxed");
  });

  it("proposed experiment + sandbox disabled → action=noop", async () => {
    const record: ExperimentRecord = {
      exp_id: "exp-noop",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      status: "proposed",
      source: { kind: "paper", ref: "arxiv:x" },
      parent_genid: "initial",
      scope: { allowed_paths: [], denylist_paths: [], max_files: 3 },
      scores: {},
    };
    writeExperimentRecord(tmp, record);
    const r = await runResearchTickOnce(tmp, vi.fn(), {
      ...baseConfig,
      enableSandbox: false,
    });
    expect(r.action).toBe("noop");
    expect(r.details).toMatch(/sandbox disabled/);
  });

  it("propose uses random.choice over valid archive parents", async () => {
    // Seed three valid parents + one invalid; the injected RNG picks index 1.
    const rowA = appendGeneration(tmp, {
      plugin_source_hash: "ha",
      workspace_hashes: { knowledge: null, beliefs: null, priorities: null },
      admission: { gate_id: "g-a", kind: "knowledge_edit", reason: "ok" },
    });
    const rowB = appendGeneration(tmp, {
      plugin_source_hash: "hb",
      workspace_hashes: { knowledge: null, beliefs: null, priorities: null },
      admission: { gate_id: "g-b", kind: "knowledge_edit", reason: "ok" },
    });
    const rowC = appendGeneration(tmp, {
      plugin_source_hash: "hc",
      workspace_hashes: { knowledge: null, beliefs: null, priorities: null },
      admission: { gate_id: "g-c", kind: "knowledge_edit", reason: "ok" },
    });
    markValidParent(tmp, rowC.genid, false, "regressed");
    void rowA;

    // RNG returns 0.5 → index 1 on a 2-element filtered pool → rowB.genid.
    const random = () => 0.5;
    const id = pickParentGenid(tmp, random);
    // Valid parents are [rowA, rowB] in insertion order.
    expect(id).toBe(rowB.genid);

    // End-to-end: a tick that promotes a candidate should stamp parent=rowB.
    appendCandidate(tmp, {
      id: "arxiv:random-parent-test",
      source: "arxiv",
      title: "test",
      discovered_at: new Date().toISOString(),
      relevance_score: 0.9,
    });
    const r = await runResearchTickOnce(tmp, proposeCallModel(), {
      ...baseConfig,
      random,
    });
    expect(r.action).toBe("propose");
    const exp = listExperiments(tmp).find((e) => e.source.ref === "arxiv:random-parent-test");
    expect(exp?.parent_genid).toBe(rowB.genid);
  });

  it("pickParentGenid falls back to 'initial' when archive is empty", () => {
    expect(pickParentGenid(tmp)).toBe("initial");
  });

  it("sandbox apply failure routes proposed → refining (no longer stuck)", async () => {
    saveAdmissionCase(tmp, mkCase("c0"));
    const record: ExperimentRecord = {
      exp_id: "exp-fail",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      status: "proposed",
      source: { kind: "paper", ref: "arxiv:x" },
      parent_genid: "initial",
      scope: {
        allowed_paths: ["extensions/memory-ooda/council.ts"],
        denylist_paths: [],
        max_files: 3,
      },
      scores: {},
    };
    writeExperimentRecord(tmp, record);
    fs.writeFileSync(path.join(experimentDir(tmp, "exp-fail"), "diff.patch"), VALID_DIFF, "utf-8");
    const failingIsolation: IsolationDeps = {
      applyDiff: async () => {
        throw new Error("git apply failed (exit=128): error: corrupt patch at line 155");
      },
      runCase: async () => ({
        source: "tool_result",
        success: true,
        toolName: "t",
        summary: "",
      }),
    };
    const r = await runResearchTickOnce(tmp, vi.fn(), {
      ...baseConfig,
      enableSandbox: true,
      isolation: failingIsolation,
    });
    expect(r.action).toBe("sandbox");
    expect(r.details).toMatch(/apply failed/);
    expect(r.advanced_exp_id).toBe("exp-fail");
    const updated = listExperiments(tmp).find((e) => e.exp_id === "exp-fail");
    expect(updated?.status).toBe("refining");
  });

  it("sandboxed experiment → action=compare or rollout", async () => {
    const record: ExperimentRecord = {
      exp_id: "exp-sbxed",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      status: "sandboxed",
      source: { kind: "paper", ref: "arxiv:x", citation: "HA" },
      parent_genid: "initial",
      scope: { allowed_paths: [], denylist_paths: [], max_files: 3 },
      scores: {
        sandbox: {
          pass_rate_small: 0.95,
          pass_rate_full: 0.95,
          regressions: [],
          per_domain: { ops: 0.9 },
          p95_latency_ms: null,
          new_error_tags: 0,
        },
      },
    };
    writeExperimentRecord(tmp, record);
    fs.writeFileSync(path.join(experimentDir(tmp, "exp-sbxed"), "diff.patch"), VALID_DIFF, "utf-8");
    const r = await runResearchTickOnce(tmp, vi.fn(), {
      ...baseConfig,
      baselineLoader: async () => ({
        pass_rate_small: 0.7,
        pass_rate_full: 0.7,
        regressions: [],
        per_domain: { ops: 0.7 },
        p95_latency_ms: null,
        new_error_tags: 0,
      }),
    });
    expect(["rollout", "compare"]).toContain(r.action);
    expect(r.advanced_exp_id).toBe("exp-sbxed");
  });
});
