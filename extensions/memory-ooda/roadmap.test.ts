import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendEpic,
  appendProposedEpic,
  bootstrapRoadmap,
  findEpic,
  latestEpicStates,
  listEpics,
  pendingEpics,
  resolveProposedEpic,
  roadmapPath,
} from "./roadmap.js";

describe("bootstrapRoadmap + listEpics", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-roadmap-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("writes a starter ROADMAP.md with the current gap list", () => {
    const wrote = bootstrapRoadmap(tmp);
    expect(wrote).toBe(true);
    expect(fs.existsSync(roadmapPath(tmp))).toBe(true);
    const epics = listEpics(tmp);
    expect(epics.length).toBeGreaterThan(5);
    expect(epics.map((e) => e.id)).toContain("curiosity");
    expect(epics.map((e) => e.id)).toContain("metacognition");
    expect(epics.map((e) => e.id)).toContain("neurosci-mechanisms");
    const neurosci = epics.find((e) => e.id === "neurosci-mechanisms");
    expect(neurosci?.horizon).toBe("distant");
  });

  it("is a no-op if ROADMAP.md already exists", () => {
    fs.writeFileSync(roadmapPath(tmp), "# Existing\n## Current\n### keepme custom\n", "utf-8");
    expect(bootstrapRoadmap(tmp)).toBe(false);
    const epics = listEpics(tmp);
    expect(epics.map((e) => e.id)).toEqual(["keepme"]);
  });

  it("parser tolerates unknown H2 sections and malformed H3 lines", () => {
    fs.writeFileSync(
      roadmapPath(tmp),
      [
        "# heading",
        "## Random",
        "### ignoreme should not be captured",
        "## Current",
        "### epic-a title a",
        "### epic-b title b",
        "some prose",
        "## Near",
        "### epic-c title c",
      ].join("\n"),
      "utf-8",
    );
    const epics = listEpics(tmp);
    expect(epics.map((e) => `${e.horizon}:${e.id}`)).toEqual([
      "current:epic-a",
      "current:epic-b",
      "near:epic-c",
    ]);
  });

  it("findEpic returns null for unknown id", () => {
    bootstrapRoadmap(tmp);
    expect(findEpic(tmp, "curiosity")?.id).toBe("curiosity");
    expect(findEpic(tmp, "not-a-real-epic")).toBeNull();
  });
});

describe("appendEpic", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-roadmap-append-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("appends under an existing horizon section", () => {
    bootstrapRoadmap(tmp);
    appendEpic(tmp, { id: "new-one", title: "a new direction", horizon: "near" });
    const epics = listEpics(tmp);
    const newOne = epics.find((e) => e.id === "new-one");
    expect(newOne?.horizon).toBe("near");
    expect(newOne?.title).toBe("a new direction");
  });

  it("creates the horizon section if missing", () => {
    fs.writeFileSync(roadmapPath(tmp), "# heading\n", "utf-8");
    appendEpic(tmp, { id: "x", title: "t", horizon: "current" });
    const epics = listEpics(tmp);
    expect(epics).toEqual([{ id: "x", title: "t", horizon: "current" }]);
  });
});

describe("proposed-epics queue", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-proposed-epics-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("append then pendingEpics returns the row", () => {
    appendProposedEpic(tmp, {
      epic_id: "draft-a",
      title: "Draft A",
      rationale: "novel direction",
      horizon: "distant",
      proposed_by_hypothesis_id: "H-001",
      proposed_by_exp_id: "exp-123",
    });
    const pending = pendingEpics(tmp);
    expect(pending).toHaveLength(1);
    expect(pending[0].epic_id).toBe("draft-a");
    expect(pending[0].status).toBe("pending");
  });

  it("resolveProposedEpic flips latest status to accepted/rejected", () => {
    appendProposedEpic(tmp, {
      epic_id: "draft-b",
      title: "Draft B",
      rationale: "rationale",
      horizon: "near",
      proposed_by_hypothesis_id: "H-002",
      proposed_by_exp_id: "exp-xyz",
    });
    const accepted = resolveProposedEpic(tmp, "draft-b", "accepted", "looks promising");
    expect(accepted?.status).toBe("accepted");
    expect(pendingEpics(tmp)).toHaveLength(0);
    expect(latestEpicStates(tmp).get("draft-b")?.status).toBe("accepted");
  });

  it("resolveProposedEpic returns null for unknown epic", () => {
    expect(resolveProposedEpic(tmp, "nope", "rejected", "x")).toBeNull();
  });

  it("preserves append-only audit trail across resolutions", () => {
    appendProposedEpic(tmp, {
      epic_id: "audit-me",
      title: "t",
      rationale: "r",
      horizon: "current",
      proposed_by_hypothesis_id: "H-010",
      proposed_by_exp_id: "exp-a",
    });
    resolveProposedEpic(tmp, "audit-me", "rejected", "out of scope");
    // Read raw JSONL — should have 2 rows
    const raw = fs
      .readFileSync(path.join(tmp, ".proposed-epics.jsonl"), "utf-8")
      .trim()
      .split("\n");
    expect(raw).toHaveLength(2);
    expect(JSON.parse(raw[0]).status).toBe("pending");
    expect(JSON.parse(raw[1]).status).toBe("rejected");
  });
});
