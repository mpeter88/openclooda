import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  keywordFilter,
  parseRssFeed,
  runResearchDiscover,
  scoreRelevance,
  type RawFeedItem,
} from "./research-discover.js";
import { readResearchLog } from "./research-loop.js";
import type { ModelCallFn } from "./triage.js";

const ATOM_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2603.19461v1</id>
    <title>HyperAgents: Self-Improving Agents</title>
    <summary>We introduce HyperAgents, a framework for self-referential self-improving agents that can optimize for any computable task. LLM agents modify their own codebase.</summary>
    <link href="http://arxiv.org/abs/2603.19461v1"/>
    <published>2026-03-19T12:00:00Z</published>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2603.00001v1</id>
    <title>Unrelated Paper About Quantum Computing</title>
    <summary>We prove a new theorem about decoherence in superconducting qubits at millikelvin temperatures.</summary>
    <link href="http://arxiv.org/abs/2603.00001v1"/>
    <published>2026-03-20T12:00:00Z</published>
  </entry>
</feed>`;

const RSS_FIXTURE = `<rss version="2.0">
<channel>
  <item>
    <guid>rss-item-1</guid>
    <title>Pattern Separation in LLMs</title>
    <description><![CDATA[A paper about LLM memory retrieval with pattern separation and dentate gyrus analogs.]]></description>
    <link>https://example.com/paper1</link>
  </item>
</channel>
</rss>`;

describe("parseRssFeed", () => {
  it("parses Atom entries", () => {
    const items = parseRssFeed(ATOM_FIXTURE);
    expect(items).toHaveLength(2);
    expect(items[0].title).toContain("HyperAgents");
    expect(items[0].id).toContain("2603.19461");
    expect(items[0].link).toContain("arxiv.org");
  });

  it("parses RSS 2.0 items with CDATA", () => {
    const items = parseRssFeed(RSS_FIXTURE);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("rss-item-1");
    expect(items[0].summary).toContain("pattern separation");
  });

  it("returns empty array on malformed input", () => {
    expect(parseRssFeed("<not xml at all")).toEqual([]);
    expect(parseRssFeed("")).toEqual([]);
  });

  it("strips HTML tags + decodes entities in cleaned text", () => {
    const xml = `<feed><entry><id>x</id><title>A &amp; B &lt;tag&gt;</title><summary>text</summary><link href="y"/></entry></feed>`;
    const items = parseRssFeed(xml);
    expect(items[0].title).toBe("A & B <tag>");
  });
});

describe("keywordFilter", () => {
  const items: RawFeedItem[] = [
    { id: "a", title: "Pattern separation in LLM agents", summary: "", link: "" },
    { id: "b", title: "A quantum computing paper", summary: "nothing to see", link: "" },
    { id: "c", title: "DGM: Darwin Gödel Machine", summary: "self-improving agents", link: "" },
  ];

  it("matches any keyword (case-insensitive)", () => {
    const r = keywordFilter(items, ["pattern separation"]);
    expect(r.map((i) => i.id)).toEqual(["a"]);
  });

  it("matches across title + summary", () => {
    const r = keywordFilter(items, ["self-improving"]);
    expect(r.map((i) => i.id)).toEqual(["c"]);
  });

  it("returns all items when keyword list is empty", () => {
    expect(keywordFilter(items, []).length).toBe(items.length);
  });

  it("multi-keyword is OR (union semantics)", () => {
    const r = keywordFilter(items, ["DGM", "quantum"]);
    expect(r.map((i) => i.id).sort()).toEqual(["b", "c"]);
  });
});

describe("scoreRelevance", () => {
  const item: RawFeedItem = {
    id: "x",
    title: "test",
    summary: "abstract",
    link: "",
  };

  it("returns parsed score when model emits valid JSON", async () => {
    const callModel: ModelCallFn = vi.fn(async () =>
      JSON.stringify({ score: 0.85, rationale: "direct relevance" }),
    );
    const r = await scoreRelevance(item, "openclooda summary", callModel);
    expect(r.score).toBeCloseTo(0.85, 5);
    expect(r.rationale).toBe("direct relevance");
  });

  it("clamps out-of-range scores to [0, 1]", async () => {
    const callModel: ModelCallFn = vi.fn(async () =>
      JSON.stringify({ score: 1.5, rationale: "oops" }),
    );
    const r = await scoreRelevance(item, "summary", callModel);
    expect(r.score).toBe(1);
  });

  it("falls back to 0/parse_failed on malformed JSON", async () => {
    const callModel: ModelCallFn = vi.fn(async () => "not json at all");
    const r = await scoreRelevance(item, "summary", callModel);
    expect(r.score).toBe(0);
    expect(r.rationale).toBe("parse_failed");
  });

  it("handles missing score field", async () => {
    const callModel: ModelCallFn = vi.fn(async () => JSON.stringify({ rationale: "no score" }));
    const r = await scoreRelevance(item, "summary", callModel);
    expect(r.score).toBe(0);
  });
});

describe("runResearchDiscover", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-research-discover-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("writes accepted candidates to .research-log.jsonl above the floor", async () => {
    const fetchUrl = vi.fn(async () => ATOM_FIXTURE);
    const callModel: ModelCallFn = vi.fn(async (prompt: string) => {
      // Score HyperAgents 0.9, quantum 0.1.
      if (prompt.includes("HyperAgents")) {
        return JSON.stringify({ score: 0.9, rationale: "direct applicability" });
      }
      return JSON.stringify({ score: 0.1, rationale: "unrelated" });
    });

    const r = await runResearchDiscover(
      tmp,
      { fetchUrl, callModel },
      {
        feeds: ["http://arxiv.example/rss"],
        keywords: ["self-improving", "quantum"],
        architectureSummary: "openclooda summary",
        candidateFloor: 0.6,
      },
    );

    expect(r.scanned).toBe(2);
    expect(r.matched_keywords).toBe(2);
    expect(r.scored).toBe(2);
    expect(r.accepted).toBe(1);

    const log = readResearchLog(tmp);
    expect(log).toHaveLength(1);
    expect(log[0].title).toContain("HyperAgents");
    expect(log[0].relevance_score).toBeGreaterThanOrEqual(0.6);
    expect(log[0].source).toBe("arxiv");
  });

  it("dedupes against existing research log", async () => {
    const fetchUrl = vi.fn(async () => ATOM_FIXTURE);
    const callModel: ModelCallFn = vi.fn(async () =>
      JSON.stringify({ score: 0.9, rationale: "yes" }),
    );
    const opts = {
      feeds: ["http://arxiv.example/rss"],
      keywords: ["hyperagents"],
      architectureSummary: "summary",
    };
    await runResearchDiscover(tmp, { fetchUrl, callModel }, opts);
    const second = await runResearchDiscover(tmp, { fetchUrl, callModel }, opts);
    expect(second.accepted).toBe(0);
    expect(second.skipped_existing).toBeGreaterThan(0);
    // Log still has exactly one entry.
    expect(readResearchLog(tmp)).toHaveLength(1);
  });

  it("tolerates dead feeds without aborting", async () => {
    const fetchUrl = vi.fn(async (url: string) => {
      if (url.includes("bad")) throw new Error("network");
      return ATOM_FIXTURE;
    });
    const callModel: ModelCallFn = vi.fn(async () =>
      JSON.stringify({ score: 0.9, rationale: "ok" }),
    );
    const r = await runResearchDiscover(
      tmp,
      { fetchUrl, callModel },
      {
        feeds: ["http://bad.example/rss", "http://arxiv.example/rss"],
        keywords: ["hyperagents"],
        architectureSummary: "",
      },
    );
    expect(r.accepted).toBe(1);
  });

  it("respects maxCandidatesPerRun", async () => {
    const manyItemsXml =
      "<feed>" +
      Array.from(
        { length: 20 },
        (_, i) =>
          `<entry><id>paper-${i}</id><title>self-improving agent ${i}</title><summary>x</summary><link href="x"/></entry>`,
      ).join("") +
      "</feed>";
    const fetchUrl = vi.fn(async () => manyItemsXml);
    const callModel: ModelCallFn = vi.fn(async () =>
      JSON.stringify({ score: 0.9, rationale: "y" }),
    );
    const r = await runResearchDiscover(
      tmp,
      { fetchUrl, callModel },
      {
        feeds: ["x"],
        keywords: ["self-improving"],
        architectureSummary: "",
        maxCandidatesPerRun: 3,
      },
    );
    expect(r.scored).toBe(3);
    expect(r.accepted).toBe(3);
  });
});
