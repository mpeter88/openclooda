import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildArxivQueryUrl, runResearchBackfill } from "./research-backfill.js";
import { readResearchLog } from "./research-loop.js";

function atomFixture(entries: Array<{ id: string; title: string; summary: string }>): string {
  const items = entries
    .map(
      (e) => `
  <entry>
    <id>${e.id}</id>
    <title>${e.title}</title>
    <summary>${e.summary}</summary>
    <link href="http://arxiv.example/abs/${e.id}"/>
  </entry>`,
    )
    .join("");
  return `<?xml version="1.0"?><feed>${items}</feed>`;
}

describe("buildArxivQueryUrl", () => {
  it("encodes category, keyword, date range, and cap", () => {
    const url = buildArxivQueryUrl("cs.AI", "world model", "2024-01-01", "2026-04-20", 50);
    expect(url).toMatch(/export\.arxiv\.org\/api\/query/);
    expect(url).toContain("cat%3Acs.AI");
    // The word/ordering inside search_query is URL-encoded; just check tokens.
    expect(url).toContain("world+model");
    expect(url).toContain("submittedDate");
    expect(url).toContain("202401010000");
    expect(url).toContain("202604200000");
    expect(url).toContain("max_results=50");
    expect(url).toContain("sortBy=submittedDate");
  });

  it("throws on invalid date", () => {
    expect(() => buildArxivQueryUrl("cs.AI", "x", "not-a-date", "2026-01-01", 10)).toThrow();
  });
});

describe("runResearchBackfill", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-backfill-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("iterates the (cat × kw) grid and accepts high-scoring candidates", async () => {
    const fetchCalls: string[] = [];
    const fetchUrl = async (url: string) => {
      fetchCalls.push(url);
      const kwMatch = /all%3A%22([^%]+)%22/.exec(url);
      const catMatch = /cat%3A([^+]+)\+/.exec(url);
      const kw = decodeURIComponent((kwMatch?.[1] ?? "unknown").replace(/\+/g, " "));
      const cat = (catMatch?.[1] ?? "cs.X").replace(".", "-");
      const slug = kw.replace(/\s+/g, "-");
      return atomFixture([
        {
          id: `arxiv:${cat}-${slug}-paper`,
          title: `Novel approach to ${kw}`,
          summary: "concrete, testable mechanism",
        },
      ]);
    };
    const callModel = vi.fn(async () => JSON.stringify({ score: 0.8, rationale: "matches gap" }));
    const sleep = vi.fn(async () => {
      /* noop */
    });

    const r = await runResearchBackfill(
      tmp,
      { fetchUrl, callModel, sleep },
      {
        categories: ["cs.AI", "cs.LG"],
        keywords: ["world model", "tool use"],
        architectureSummary: "openclooda gap list",
        since: "2024-01-01",
        until: "2026-04-20",
        maxPerQuery: 10,
        maxCandidatesTotal: 100,
        candidateFloor: 0.45,
        requestDelaySec: 0,
      },
    );

    expect(r.queries_issued).toBe(4); // 2 cat × 2 kw
    expect(r.scanned).toBe(4);
    expect(r.accepted).toBe(4);
    expect(fetchCalls).toHaveLength(4);

    const rows = readResearchLog(tmp);
    expect(rows.map((c) => c.id).sort()).toEqual([
      "arxiv:cs-AI-tool-use-paper",
      "arxiv:cs-AI-world-model-paper",
      "arxiv:cs-LG-tool-use-paper",
      "arxiv:cs-LG-world-model-paper",
    ]);
  });

  it("honours maxCandidatesTotal across the grid", async () => {
    // Each query returns two items; budget only allows 3 scored total.
    const fetchUrl = async (url: string) => {
      const kwMatch = /all%3A%22([^%]+)%22/.exec(url);
      const kw = decodeURIComponent((kwMatch?.[1] ?? "x").replace(/\+/g, " "));
      const slug = kw.replace(/\s+/g, "-");
      return atomFixture([
        {
          id: `arxiv:${slug}-1`,
          title: `Paper 1 on ${kw}`,
          summary: kw,
        },
        {
          id: `arxiv:${slug}-2`,
          title: `Paper 2 on ${kw}`,
          summary: kw,
        },
      ]);
    };
    const callModel = vi.fn(async () => JSON.stringify({ score: 0.9, rationale: "ok" }));

    const r = await runResearchBackfill(
      tmp,
      { fetchUrl, callModel, sleep: async () => undefined },
      {
        categories: ["cs.AI"],
        keywords: ["a", "b", "c"],
        architectureSummary: "s",
        maxPerQuery: 10,
        maxCandidatesTotal: 3,
        candidateFloor: 0.5,
        requestDelaySec: 0,
      },
    );

    // Budget caps scored calls; accepted cannot exceed budget.
    expect(r.scored).toBeLessThanOrEqual(3);
    expect(r.accepted).toBeLessThanOrEqual(3);
  });

  it("continues after a fetch failure (runResearchDiscover swallows it)", async () => {
    let call = 0;
    const fetchUrl = async (url: string) => {
      call++;
      if (call === 1) throw new Error("network down");
      const kwMatch = /all%3A%22([^%]+)%22/.exec(url);
      const kw = decodeURIComponent((kwMatch?.[1] ?? "x").replace(/\+/g, " "));
      return atomFixture([{ id: `arxiv:ok-${call}`, title: `paper on ${kw}`, summary: kw }]);
    };
    const callModel = vi.fn(async () => JSON.stringify({ score: 0.7, rationale: "ok" }));

    const r = await runResearchBackfill(
      tmp,
      { fetchUrl, callModel, sleep: async () => undefined },
      {
        categories: ["cs.AI"],
        keywords: ["a", "b"],
        architectureSummary: "s",
        candidateFloor: 0.5,
        requestDelaySec: 0,
      },
    );

    // runResearchDiscover swallows fetch failures silently — the feed is
    // skipped but the query completes. So queries_failed stays 0 and scanned=1.
    expect(r.queries_issued).toBe(2);
    expect(r.scanned).toBe(1);
    expect(r.accepted).toBe(1);
  });

  it("invokes onProgress callback after each query", async () => {
    const events: Array<{ done: number; total: number }> = [];
    const fetchUrl = async () => atomFixture([]);
    const callModel = vi.fn(async () => JSON.stringify({ score: 0, rationale: "" }));

    await runResearchBackfill(
      tmp,
      { fetchUrl, callModel, sleep: async () => undefined },
      {
        categories: ["cs.AI", "cs.LG"],
        keywords: ["a"],
        architectureSummary: "s",
        requestDelaySec: 0,
        onProgress: (p) => events.push({ done: p.done, total: p.total }),
      },
    );

    expect(events).toEqual([
      { done: 1, total: 2 },
      { done: 2, total: 2 },
    ]);
  });
});
