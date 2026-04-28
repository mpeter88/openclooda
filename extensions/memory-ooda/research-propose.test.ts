import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { experimentDir, readExperimentRecord } from "./research-loop.js";
import type { ResearchCandidate } from "./research-loop.js";
import {
  extractChangedPaths,
  makeExperimentId,
  parseProposal,
  runResearchPropose,
  validateScope,
  type ProposalDraft,
} from "./research-propose.js";
import type { ModelCallFn } from "./triage.js";

const CANDIDATE: ResearchCandidate = {
  id: "arxiv:2603.19461",
  source: "arxiv",
  title: "HyperAgents self-improving",
  abstract: "agents that modify their own code",
  discovered_at: new Date().toISOString(),
  relevance_score: 0.9,
  relevance_rationale: "direct",
};

const GOOD_DIFF = `diff --git a/extensions/memory-ooda/council.ts b/extensions/memory-ooda/council.ts
--- a/extensions/memory-ooda/council.ts
+++ b/extensions/memory-ooda/council.ts
@@ -1,3 +1,4 @@
+// CR_OODA_RESEARCH_LOOP: experimental edit
 export const COUNCIL_MODE = "system2";
 const foo = 1;
`;

const OOS_DIFF = `diff --git a/.admission-cases/some.json b/.admission-cases/some.json
--- a/.admission-cases/some.json
+++ b/.admission-cases/some.json
@@ -1 +1 @@
-{}
+{"x":1}
`;

describe("extractChangedPaths", () => {
  it("returns paths from all diff --git headers", () => {
    const paths = [...extractChangedPaths(GOOD_DIFF)];
    expect(paths).toEqual(["extensions/memory-ooda/council.ts"]);
  });

  it("handles renames (a/ and b/ differ)", () => {
    const diff = `diff --git a/old.ts b/new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-x\n+y\n`;
    const paths = [...extractChangedPaths(diff)].sort();
    expect(paths).toEqual(["new.ts", "old.ts"]);
  });

  it("returns empty set on malformed input", () => {
    expect(extractChangedPaths("not a diff").size).toBe(0);
  });
});

describe("validateScope", () => {
  const scope = {
    allowed_paths: ["extensions/memory-ooda/council.ts"],
    denylist_paths: [".admission-cases/"],
    max_files: 3,
  };

  it("accepts an in-scope diff", () => {
    const v = validateScope(GOOD_DIFF, scope);
    expect(v.valid).toBe(true);
    expect(v.changedPaths).toEqual(["extensions/memory-ooda/council.ts"]);
  });

  it("rejects a denylist hit with a specific reason", () => {
    const v = validateScope(OOS_DIFF, scope);
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/denylisted/);
    expect(v.denyListHits.length).toBeGreaterThan(0);
  });

  it("rejects when max_files exceeded", () => {
    const manyFilesDiff = Array.from(
      { length: 5 },
      (_, i) =>
        `diff --git a/extensions/memory-ooda/f${i}.ts b/extensions/memory-ooda/f${i}.ts\n--- a/extensions/memory-ooda/f${i}.ts\n+++ b/extensions/memory-ooda/f${i}.ts\n@@ -1 +1 @@\n-x\n+y\n`,
    ).join("");
    const v = validateScope(manyFilesDiff, {
      allowed_paths: ["extensions/memory-ooda/"],
      denylist_paths: [],
      max_files: 3,
    });
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/max_files/);
  });

  it("rejects out-of-scope paths (not in allowed_paths)", () => {
    const diff = `diff --git a/src/other.ts b/src/other.ts\n--- a/src/other.ts\n+++ b/src/other.ts\n@@ -1 +1 @@\n-x\n+y\n`;
    const v = validateScope(diff, scope);
    expect(v.valid).toBe(false);
    expect(v.outOfScope).toContain("src/other.ts");
  });

  it("rejects when diff has no headers", () => {
    const v = validateScope("just some text", scope);
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/no recognizable file headers/);
  });
});

const SAMPLE_HYPOTHESIS = {
  claim: "curiosity-driven triage raises recall on ambiguous inputs",
  prediction: "pass rate up 5%",
  success_metric: {
    fixture_tag: "H-curiosity-amb",
    min_pass_rate: 0.6,
    min_delta_vs_parent: 0.05,
  },
  failure_metric: { regression_forbidden_tags: ["critical"] },
};

const SAMPLE_VALUE_EXISTING = {
  what_it_adds: "curiosity bias on triage",
  why_now: "ambiguity recall plateaued",
  roadmap_link: { mode: "existing", horizon: "current", epic: "curiosity" },
  est_impact: 0.5,
  est_effort: 0.2,
};

const SAMPLE_VALUE_PROPOSE = {
  what_it_adds: "metacog consolidation stage",
  why_now: "we have no way to self-critique today",
  roadmap_link: {
    mode: "propose",
    horizon: "near",
    epic_id: "metacog-consolidation",
    title: "Metacognitive consolidation",
    rationale: "no existing epic covers this",
  },
  est_impact: 0.7,
  est_effort: 0.4,
};

const SAMPLE_FIXTURES = {
  fixtures: [
    {
      id: "H-curiosity-amb-001",
      label: "ambiguous-input-1",
      fixture: { observation: "...", knowledge: {}, priorities: {} },
      expected: {
        actionId: "fx1",
        description: "",
        successSignal: "",
        failureSignal: "",
        domain: "ops",
      },
      priorOutcome: "success",
      capturedAt: new Date().toISOString(),
      tags: ["H-curiosity-amb"],
    },
  ],
  rationale: "falsifies claim if model still misses ambiguous inputs",
};

describe("parseProposal", () => {
  it("parses well-formed JSON output with structured hypothesis", () => {
    const raw = JSON.stringify({
      proposal_md: "do something",
      hypothesis: SAMPLE_HYPOTHESIS,
      value: SAMPLE_VALUE_EXISTING,
      hypothesis_fixtures: SAMPLE_FIXTURES,
      allowed_paths: ["a.ts"],
      diff: GOOD_DIFF,
    });
    const d = parseProposal(raw);
    expect(d.proposal_md).toBe("do something");
    expect(d.allowed_paths).toEqual(["a.ts"]);
    expect(d.hypothesis.claim).toContain("curiosity");
    expect(d.value.roadmap_link.mode).toBe("existing");
    expect(d.hypothesis_fixtures.fixtures).toHaveLength(1);
  });

  it("throws on missing hypothesis object", () => {
    const raw = JSON.stringify({
      proposal_md: "x",
      allowed_paths: ["a.ts"],
      diff: GOOD_DIFF,
    });
    expect(() => parseProposal(raw)).toThrow(/hypothesis/);
  });

  it("throws on missing hypothesis_fixtures", () => {
    const raw = JSON.stringify({
      proposal_md: "x",
      hypothesis: SAMPLE_HYPOTHESIS,
      value: SAMPLE_VALUE_EXISTING,
      allowed_paths: ["a.ts"],
      diff: GOOD_DIFF,
    });
    expect(() => parseProposal(raw)).toThrow(/fixture/);
  });

  it("strips code fences around the JSON", () => {
    const raw =
      "```json\n" +
      JSON.stringify({
        proposal_md: "x",
        hypothesis: SAMPLE_HYPOTHESIS,
        value: SAMPLE_VALUE_EXISTING,
        hypothesis_fixtures: SAMPLE_FIXTURES,
        allowed_paths: ["a.ts"],
        diff: GOOD_DIFF,
      }) +
      "\n```";
    const d = parseProposal(raw);
    expect(d.proposal_md).toBe("x");
  });
});

describe("makeExperimentId", () => {
  it("builds a slug from the candidate id", () => {
    const id = makeExperimentId(CANDIDATE);
    expect(id).toMatch(/^exp-\d{4}-\d{2}-\d{2}-/);
    expect(id).toContain("arxiv");
  });

  it("truncates long slugs", () => {
    const long = makeExperimentId({
      ...CANDIDATE,
      id: "x".repeat(100),
    });
    expect(long.length).toBeLessThan(50);
  });
});

describe("runResearchPropose", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-research-propose-"));
    // Seed a ROADMAP.md so existing-mode proposals can resolve the "curiosity" epic.
    fs.writeFileSync(
      path.join(tmp, "ROADMAP.md"),
      "# ROADMAP\n## Current\n### curiosity curiosity-driven exploration\n",
      "utf-8",
    );
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function modelReturning(overrides: Record<string, unknown>): ModelCallFn {
    return vi.fn(async () =>
      JSON.stringify({
        proposal_md: "yep",
        hypothesis: SAMPLE_HYPOTHESIS,
        value: SAMPLE_VALUE_EXISTING,
        hypothesis_fixtures: SAMPLE_FIXTURES,
        allowed_paths: ["extensions/memory-ooda/council.ts"],
        diff: GOOD_DIFF,
        ...overrides,
      }),
    );
  }

  it("writes proposal.md + scope.json + diff.patch + fixtures on valid proposal", async () => {
    const r = await runResearchPropose(tmp, modelReturning({}), {
      candidate: CANDIDATE,
      architectureSummary: "openclooda summary",
      parentGenid: "initial",
    });
    expect(r.experiment.status).toBe("proposed");
    expect(r.validation.valid).toBe(true);
    const dir = experimentDir(tmp, r.experiment.exp_id);
    expect(fs.existsSync(path.join(dir, "proposal.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "scope.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "diff.patch"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "hypothesis-fixtures.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "status.json"))).toBe(true);
    const read = readExperimentRecord(tmp, r.experiment.exp_id);
    expect(read?.hypothesis_obj?.id).toMatch(/^H-\d{3}$/);
    expect(read?.hypothesis_obj?.claim).toContain("curiosity");
    expect(read?.value?.roadmap_link.mode).toBe("existing");
    expect(read?.runs).toHaveLength(1);
    expect(read?.runs?.[0].run_id).toMatch(/^H-\d{3}-R-001$/);
  });

  it("propose-mode roadmap link queues epic + transitions to awaiting-epic-approval", async () => {
    const r = await runResearchPropose(tmp, modelReturning({ value: SAMPLE_VALUE_PROPOSE }), {
      candidate: CANDIDATE,
      architectureSummary: "",
      parentGenid: "initial",
    });
    expect(r.experiment.status).toBe("awaiting-epic-approval");
    expect(r.epicProposed).toBe(true);
    const proposedQueue = fs.readFileSync(path.join(tmp, ".proposed-epics.jsonl"), "utf-8");
    expect(proposedQueue).toContain("metacog-consolidation");
  });

  it("unknown existing epic → rejected with epic-gate note", async () => {
    const r = await runResearchPropose(
      tmp,
      modelReturning({
        value: {
          ...SAMPLE_VALUE_EXISTING,
          roadmap_link: { mode: "existing", horizon: "current", epic: "not-an-epic" },
        },
      }),
      { candidate: CANDIDATE, architectureSummary: "", parentGenid: "initial" },
    );
    expect(r.experiment.status).toBe("rejected");
    expect(r.experiment.notes).toMatch(/epic/);
  });

  it("rejects with notes when the model emits an out-of-scope diff", async () => {
    const r = await runResearchPropose(
      tmp,
      modelReturning({
        allowed_paths: ["extensions/memory-ooda/council.ts"],
        diff: OOS_DIFF,
      }),
      {
        candidate: CANDIDATE,
        architectureSummary: "",
        parentGenid: "initial",
      },
    );
    expect(r.experiment.status).toBe("rejected");
    expect(r.experiment.notes).toMatch(/denylisted/);
  });

  it("rejects when the model emits malformed JSON", async () => {
    const callModel: ModelCallFn = vi.fn(async () => "not json");
    const r = await runResearchPropose(tmp, callModel, {
      candidate: CANDIDATE,
      architectureSummary: "",
      parentGenid: "initial",
      maxRetries: 0,
    });
    expect(r.experiment.status).toBe("rejected");
    expect(r.experiment.notes).toMatch(/proposal parse failed/);
  });

  it("carries paper citation + hypothesis object into the record", async () => {
    const r = await runResearchPropose(tmp, modelReturning({}), {
      candidate: CANDIDATE,
      architectureSummary: "",
      parentGenid: "abc-123",
    });
    expect(r.experiment.source.ref).toBe(CANDIDATE.id);
    expect(r.experiment.source.citation).toBe(CANDIDATE.title);
    expect(r.experiment.parent_genid).toBe("abc-123");
    expect(r.experiment.hypothesis_obj?.claim).toContain("curiosity");
  });

  it("rejects when fixture missing required success_metric.fixture_tag", async () => {
    const fixturesWithoutTag = {
      ...SAMPLE_FIXTURES,
      fixtures: SAMPLE_FIXTURES.fixtures.map((f) => {
        const { tags: _omit, ...rest } = f;
        return { ...rest, tags: [] };
      }),
    };
    const r = await runResearchPropose(
      tmp,
      modelReturning({ hypothesis_fixtures: fixturesWithoutTag }),
      {
        candidate: CANDIDATE,
        architectureSummary: "",
        parentGenid: "initial",
        maxRetries: 0,
      },
    );
    expect(r.experiment.status).toBe("rejected");
    expect(r.experiment.notes).toMatch(/Hypothesis fixtures invalid|tags must include/);
  });
});
