import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendGeneration,
  archivePath,
  childrenOf,
  findGeneration,
  latestGenid,
  lineageTo,
  markRunFullEval,
  markValidParent,
  meanScore,
  readArchive,
  recordGenerationScore,
  validParents,
  type GenerationRow,
} from "./agent-archive.js";

function seedInput(overrides: Partial<Parameters<typeof appendGeneration>[1]> = {}) {
  return {
    plugin_source_hash: "hash-1",
    workspace_hashes: { knowledge: null, beliefs: null, priorities: null },
    admission: {
      gate_id: "gate-1",
      kind: "knowledge_edit" as const,
      reason: "ok",
    },
    ...overrides,
  };
}

describe("agent-archive read path", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-archive-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("empty archive: readers return empty structures", () => {
    expect(readArchive(tmp)).toEqual([]);
    expect(latestGenid(tmp)).toBeNull();
    expect(findGeneration(tmp, "anything")).toBeNull();
    expect(lineageTo(tmp, "x")).toEqual([]);
    expect(childrenOf(tmp, "x")).toEqual([]);
    expect(validParents(tmp)).toEqual([]);
  });

  it("tolerates malformed lines", () => {
    fs.writeFileSync(archivePath(tmp), "{bad json\n");
    expect(readArchive(tmp)).toEqual([]);
  });
});

describe("appendGeneration", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-archive-append-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("first row has parent='initial' and lineage_depth=0", () => {
    const row = appendGeneration(tmp, seedInput());
    expect(row.parent_genid).toBe("initial");
    expect(row.lineage_depth).toBe(0);
    expect(row.valid_parent).toBe(true);
    expect(row.run_full_eval).toBe(false);
    expect(row.genid).toHaveLength(12);
  });

  it("subsequent rows chain to the previous genid", () => {
    const a = appendGeneration(tmp, seedInput({ plugin_source_hash: "h-a" }));
    const b = appendGeneration(
      tmp,
      seedInput({
        plugin_source_hash: "h-b",
        admission: { gate_id: "gate-2", kind: "knowledge_edit", reason: "ok" },
      }),
    );
    expect(b.parent_genid).toBe(a.genid);
    expect(b.lineage_depth).toBe(1);
  });

  it("lineageTo reconstructs the full chain back to initial", () => {
    const a = appendGeneration(tmp, seedInput({ plugin_source_hash: "h-a" }));
    const b = appendGeneration(
      tmp,
      seedInput({
        plugin_source_hash: "h-b",
        admission: { gate_id: "gate-2", kind: "knowledge_edit", reason: "ok" },
      }),
    );
    const c = appendGeneration(
      tmp,
      seedInput({
        plugin_source_hash: "h-c",
        admission: { gate_id: "gate-3", kind: "knowledge_edit", reason: "ok" },
      }),
    );
    const chain = lineageTo(tmp, c.genid);
    expect(chain.map((r) => r.genid)).toEqual([c.genid, b.genid, a.genid]);
  });

  it("childrenOf returns direct descendants only", () => {
    const a = appendGeneration(tmp, seedInput({ plugin_source_hash: "h-a" }));
    const b = appendGeneration(
      tmp,
      seedInput({
        plugin_source_hash: "h-b",
        admission: { gate_id: "gate-2", kind: "knowledge_edit", reason: "ok" },
      }),
    );
    void b;
    expect(childrenOf(tmp, a.genid)).toHaveLength(1);
    expect(childrenOf(tmp, "initial")).toHaveLength(1);
  });

  it("preserves experiment_id when supplied", () => {
    const row = appendGeneration(tmp, seedInput({ experiment_id: "exp-42" }));
    expect(row.experiment_id).toBe("exp-42");
  });

  it("writes one line per row to .agent-archive.jsonl", () => {
    appendGeneration(tmp, seedInput());
    appendGeneration(
      tmp,
      seedInput({
        plugin_source_hash: "h-2",
        admission: { gate_id: "gate-2", kind: "knowledge_edit", reason: "ok" },
      }),
    );
    const content = fs.readFileSync(archivePath(tmp), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const l of lines) JSON.parse(l); // each line is valid JSON
  });
});

describe("updateGeneration helpers", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-archive-update-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("recordGenerationScore merges into scores map without reordering", () => {
    const a = appendGeneration(tmp, seedInput({ plugin_source_hash: "h-a" }));
    const b = appendGeneration(
      tmp,
      seedInput({
        plugin_source_hash: "h-b",
        admission: { gate_id: "gate-2", kind: "knowledge_edit", reason: "ok" },
      }),
    );
    expect(recordGenerationScore(tmp, a.genid, "polyglot", 0.72)).toBe(true);
    expect(recordGenerationScore(tmp, a.genid, "paper_review", 0.81)).toBe(true);
    const rows = readArchive(tmp);
    expect(rows[0].genid).toBe(a.genid);
    expect(rows[0].scores).toEqual({ polyglot: 0.72, paper_review: 0.81 });
    expect(rows[1].genid).toBe(b.genid);
    expect(rows[1].scores).toEqual({});
  });

  it("markValidParent=false excludes the row from validParents", () => {
    const a = appendGeneration(tmp, seedInput());
    markValidParent(tmp, a.genid, false, "regression-flagged");
    expect(validParents(tmp)).toHaveLength(0);
    const updated = findGeneration(tmp, a.genid);
    expect(updated?.valid_parent).toBe(false);
    expect(updated?.summary).toMatch(/valid_parent=false/);
  });

  it("markRunFullEval flips the flag", () => {
    const a = appendGeneration(tmp, seedInput());
    markRunFullEval(tmp, a.genid, true);
    expect(findGeneration(tmp, a.genid)?.run_full_eval).toBe(true);
  });

  it("update helpers return false when genid is unknown", () => {
    expect(recordGenerationScore(tmp, "no-such-genid", "polyglot", 0.5)).toBe(false);
    expect(markValidParent(tmp, "nope", false, "x")).toBe(false);
    expect(markRunFullEval(tmp, "nope", true)).toBe(false);
  });
});

describe("meanScore", () => {
  it("averages all domain scores", () => {
    const row: GenerationRow = {
      genid: "x",
      parent_genid: "initial",
      created_at: "",
      plugin_source_hash: "",
      workspace_hashes: { knowledge: null, beliefs: null, priorities: null },
      admission: { gate_id: "", kind: "knowledge_edit", reason: "" },
      scores: { polyglot: 0.8, paper_review: 0.6 },
      run_full_eval: false,
      valid_parent: true,
      lineage_depth: 0,
    };
    expect(meanScore(row)).toBeCloseTo(0.7, 5);
  });

  it("returns null when scores empty", () => {
    const row: GenerationRow = {
      genid: "x",
      parent_genid: "initial",
      created_at: "",
      plugin_source_hash: "",
      workspace_hashes: { knowledge: null, beliefs: null, priorities: null },
      admission: { gate_id: "", kind: "knowledge_edit", reason: "" },
      scores: {},
      run_full_eval: false,
      valid_parent: true,
      lineage_depth: 0,
    };
    expect(meanScore(row)).toBeNull();
  });
});
