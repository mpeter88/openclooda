import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendCandidate,
  appendRolloutQueue,
  canTransition,
  EXPERIMENTS_DIR,
  experimentDir,
  isTerminal,
  listExperiments,
  readExperimentRecord,
  readResearchLog,
  readRolloutQueue,
  runResearchTick,
  transitionStage,
  writeExperimentRecord,
  type ExperimentRecord,
  type ExperimentStage,
} from "./research-loop.js";

function seedRecord(overrides: Partial<ExperimentRecord> = {}): ExperimentRecord {
  const now = new Date().toISOString();
  return {
    exp_id: "exp-test-1",
    created_at: now,
    updated_at: now,
    status: "discovered",
    source: {
      kind: "paper",
      ref: "arxiv:2603.19461",
      citation: "HyperAgents (Zhang et al. 2026)",
    },
    parent_genid: "initial",
    scope: {
      allowed_paths: ["extensions/memory-ooda/council.ts"],
      denylist_paths: [".admission-cases/"],
      max_files: 3,
    },
    scores: {},
    ...overrides,
  };
}

describe("canTransition + isTerminal", () => {
  it("legal transitions follow the documented state machine", () => {
    expect(canTransition("discovered", "proposed")).toBe(true);
    expect(canTransition("proposed", "sandboxed")).toBe(true);
    expect(canTransition("sandboxed", "compared")).toBe(true);
    expect(canTransition("compared", "rollout-proposed")).toBe(true);
    expect(canTransition("rollout-proposed", "rolled-out")).toBe(true);
  });

  it("rejects skipping stages", () => {
    expect(canTransition("discovered", "sandboxed")).toBe(false);
    expect(canTransition("proposed", "rolled-out")).toBe(false);
    expect(canTransition("sandboxed", "rollout-proposed")).toBe(false);
  });

  it("every non-terminal stage allows transition to rejected", () => {
    const nonTerminal: ExperimentStage[] = [
      "discovered",
      "proposed",
      "awaiting-epic-approval",
      "sandboxed",
      "compared",
      "refining",
      "rollout-proposed",
    ];
    for (const s of nonTerminal) {
      expect(canTransition(s, "rejected")).toBe(true);
    }
  });

  it("terminal stages forbid any further transition", () => {
    for (const s of [
      "rolled-out",
      "rejected",
      "superseded",
      "concluded-dump",
    ] as ExperimentStage[]) {
      expect(isTerminal(s)).toBe(true);
      expect(canTransition(s, "proposed")).toBe(false);
      expect(canTransition(s, "rolled-out")).toBe(false);
    }
  });

  it("epic-approval gate: propose→awaiting-epic-approval→sandboxed on accept", () => {
    expect(canTransition("proposed", "awaiting-epic-approval")).toBe(true);
    expect(canTransition("awaiting-epic-approval", "sandboxed")).toBe(true);
    // Operator reject path
    expect(canTransition("awaiting-epic-approval", "concluded-dump")).toBe(true);
  });

  it("refine loop: compared→refining→sandboxed with bounded retries", () => {
    expect(canTransition("compared", "refining")).toBe(true);
    expect(canTransition("refining", "sandboxed")).toBe(true);
    // compared with fail verdict → concluded-dump directly
    expect(canTransition("compared", "concluded-dump")).toBe(true);
  });
});

describe("research log (candidate discovery ledger)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-research-log-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("append then read round-trips", () => {
    appendCandidate(tmp, {
      id: "arxiv:2603.19461",
      source: "arxiv",
      title: "HyperAgents",
      discovered_at: new Date().toISOString(),
      relevance_score: 0.9,
    });
    const rows = readResearchLog(tmp);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("arxiv:2603.19461");
    expect(rows[0].relevance_score).toBe(0.9);
  });

  it("tolerates malformed lines", () => {
    fs.writeFileSync(path.join(tmp, ".research-log.jsonl"), "{bad\n");
    expect(readResearchLog(tmp)).toEqual([]);
  });

  it("empty state returns empty array", () => {
    expect(readResearchLog(tmp)).toEqual([]);
  });
});

describe("experiment record R/W", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-research-exp-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("write + read round-trips and updated_at is never earlier than created_at", () => {
    const rec = seedRecord();
    writeExperimentRecord(tmp, rec);
    const read = readExperimentRecord(tmp, rec.exp_id);
    expect(read).not.toBeNull();
    expect(read!.exp_id).toBe(rec.exp_id);
    expect(read!.status).toBe("discovered");
    // updated_at must be ≥ created_at. On fast machines it may equal it when
    // both resolve within the same millisecond — that's still a valid write.
    expect(new Date(read!.updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(rec.created_at).getTime(),
    );
  });

  it("read missing id returns null", () => {
    expect(readExperimentRecord(tmp, "nope")).toBeNull();
  });

  it("directory structure is .experiments/{exp-id}/status.json", () => {
    const rec = seedRecord({ exp_id: "exp-fixture" });
    writeExperimentRecord(tmp, rec);
    expect(fs.existsSync(path.join(tmp, EXPERIMENTS_DIR, "exp-fixture", "status.json"))).toBe(true);
    expect(fs.existsSync(experimentDir(tmp, "exp-fixture"))).toBe(true);
  });

  it("listExperiments returns all records sorted by created_at", () => {
    writeExperimentRecord(
      tmp,
      seedRecord({
        exp_id: "exp-a",
        created_at: "2026-01-01T00:00:00Z",
      }),
    );
    writeExperimentRecord(
      tmp,
      seedRecord({
        exp_id: "exp-b",
        created_at: "2026-02-01T00:00:00Z",
      }),
    );
    const all = listExperiments(tmp);
    expect(all.map((r) => r.exp_id)).toEqual(["exp-a", "exp-b"]);
  });
});

describe("transitionStage (state machine)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-research-trans-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("advances through legal stages", () => {
    writeExperimentRecord(tmp, seedRecord({ status: "discovered" }));
    expect(transitionStage(tmp, "exp-test-1", "proposed")).not.toBeNull();
    expect(readExperimentRecord(tmp, "exp-test-1")?.status).toBe("proposed");
    expect(transitionStage(tmp, "exp-test-1", "sandboxed")).not.toBeNull();
    expect(readExperimentRecord(tmp, "exp-test-1")?.status).toBe("sandboxed");
  });

  it("rejects illegal jumps", () => {
    writeExperimentRecord(tmp, seedRecord({ status: "discovered" }));
    expect(transitionStage(tmp, "exp-test-1", "rolled-out")).toBeNull();
    expect(readExperimentRecord(tmp, "exp-test-1")?.status).toBe("discovered");
  });

  it("returns null for unknown experiment", () => {
    expect(transitionStage(tmp, "no-such-exp", "proposed")).toBeNull();
  });

  it("persists notes alongside status", () => {
    writeExperimentRecord(tmp, seedRecord({ status: "discovered" }));
    transitionStage(tmp, "exp-test-1", "rejected", "sandbox regressed");
    expect(readExperimentRecord(tmp, "exp-test-1")?.notes).toBe("sandbox regressed");
  });
});

describe("rollout queue", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-research-roq-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("append + read round-trips", () => {
    appendRolloutQueue(tmp, {
      exp_id: "exp-x",
      proposal_id: "proposal-123",
      queued_at: new Date().toISOString(),
      summary: "try the staged eval pattern from HyperAgents",
    });
    const rows = readRolloutQueue(tmp);
    expect(rows).toHaveLength(1);
    expect(rows[0].exp_id).toBe("exp-x");
    expect(rows[0].proposal_id).toBe("proposal-123");
  });
});

describe("runResearchTick stub (Phase A)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-research-tick-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns a no-op result with a phase-A marker", async () => {
    const r = await runResearchTick(tmp, { enabled: true });
    expect(r.advanced).toBe(0);
    expect(r.discovered).toBe(0);
    expect(r.skipped_reason).toMatch(/phase A/);
  });

  it("does not throw when disabled", async () => {
    const r = await runResearchTick(tmp, { enabled: false });
    expect(r.advanced).toBe(0);
  });
});
