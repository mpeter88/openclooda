/**
 * CR_OODA_RESEARCH_LOOP — Stage 1 (discover).
 *
 * Fetches an arxiv-style RSS feed, keyword-filters candidates, scores
 * relevance via an injected model call, and appends surviving rows to
 * `.research-log.jsonl`. Deduplicates by candidate id so the same paper isn't
 * scored twice.
 *
 * Everything fetch-related is injected so unit tests stay offline.
 */

import { stripCodeFences } from "./parse-utils.js";
import { appendCandidate, readResearchLog, type ResearchCandidate } from "./research-loop.js";
import type { ModelCallFn } from "./triage.js";

export interface DiscoverDeps {
  /** Inject your own fetch for tests. Defaults to global `fetch`. */
  fetchUrl?: (url: string) => Promise<string>;
  /** Required — the model is used to score relevance. */
  callModel: ModelCallFn;
}

export interface DiscoverOptions {
  feeds: string[];
  keywords: string[];
  architectureSummary: string; // passed to the LLM for relevance scoring
  candidateFloor?: number; // default 0.6
  maxCandidatesPerRun?: number; // default 5
}

export interface DiscoverResult {
  scanned: number;
  matched_keywords: number;
  scored: number;
  accepted: number;
  skipped_existing: number;
}

// ============================================================================
// RSS parsing — pure, tolerant
// ============================================================================

export interface RawFeedItem {
  id: string;
  title: string;
  summary: string;
  link: string;
}

/**
 * Minimal arxiv-style RSS parser. Accepts both `<entry>` (Atom) and `<item>`
 * (RSS 2.0). Extracts only what we need for relevance scoring. On parse
 * failure, returns empty array — callers should never crash on a malformed
 * feed.
 */
export function parseRssFeed(xml: string): RawFeedItem[] {
  const out: RawFeedItem[] = [];
  // Match <entry>...</entry> and <item>...</item> blocks.
  const blockRe = /<(entry|item)\b[^>]*>([\s\S]*?)<\/\1>/g;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(xml)) !== null) {
    const block = match[2];
    const id = pickTag(block, "id") ?? pickTag(block, "guid") ?? pickLink(block);
    const title = pickTag(block, "title") ?? "";
    const summary = pickTag(block, "summary") ?? pickTag(block, "description") ?? "";
    const link = pickLink(block) ?? "";
    if (!id) continue;
    out.push({
      id: cleanText(id),
      title: cleanText(title),
      summary: cleanText(summary),
      link: cleanText(link),
    });
  }
  return out;
}

function pickTag(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = re.exec(xml);
  return m ? m[1] : undefined;
}

function pickLink(xml: string): string | undefined {
  // Atom: <link href="..."/>
  const atomMatch = /<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i.exec(xml);
  if (atomMatch) return atomMatch[1];
  // RSS 2.0: <link>...</link>
  return pickTag(xml, "link");
}

function cleanText(s: string): string {
  // Strip CDATA + collapse whitespace + decode a handful of HTML entities.
  return s
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// ============================================================================
// Keyword filtering
// ============================================================================

/**
 * Case-insensitive substring match on title+summary. Returns candidates whose
 * text contains at least one keyword. Keywords are lowercased before matching.
 */
export function keywordFilter(items: RawFeedItem[], keywords: string[]): RawFeedItem[] {
  if (keywords.length === 0) return items;
  const lowered = keywords.map((k) => k.toLowerCase());
  return items.filter((it) => {
    const blob = `${it.title} ${it.summary}`.toLowerCase();
    return lowered.some((k) => blob.includes(k));
  });
}

// ============================================================================
// Relevance scoring
// ============================================================================

const RELEVANCE_PROMPT_SYSTEM = `You are the openclooda research-relevance classifier.
Given the architecture summary and a candidate paper's title+abstract, rate how
directly applicable this paper's central idea is to openclooda's architecture on
a 0.0-1.0 scale. Err on the side of conservative (lower) scores.

Respond with raw JSON only:
{ "score": 0.0-1.0, "rationale": "<one sentence>" }`;

function buildRelevancePrompt(architectureSummary: string, item: RawFeedItem): string {
  return `${RELEVANCE_PROMPT_SYSTEM}

## Architecture summary
${architectureSummary}

## Candidate paper
Title: ${item.title}
Abstract: ${item.summary.slice(0, 1500)}

Respond with raw JSON only.`;
}

export interface ScoredCandidate {
  id: string;
  score: number;
  rationale: string;
}

export async function scoreRelevance(
  item: RawFeedItem,
  architectureSummary: string,
  callModel: ModelCallFn,
): Promise<ScoredCandidate> {
  const raw = await callModel(buildRelevancePrompt(architectureSummary, item));
  try {
    const parsed = JSON.parse(stripCodeFences(raw)) as {
      score?: unknown;
      rationale?: unknown;
    };
    const score = typeof parsed.score === "number" ? Math.max(0, Math.min(1, parsed.score)) : 0;
    const rationale = typeof parsed.rationale === "string" ? parsed.rationale : "no rationale";
    return { id: item.id, score, rationale };
  } catch {
    return { id: item.id, score: 0, rationale: "parse_failed" };
  }
}

// ============================================================================
// Main entry
// ============================================================================

export async function runResearchDiscover(
  workspacePath: string,
  deps: DiscoverDeps,
  options: DiscoverOptions,
): Promise<DiscoverResult> {
  const fetchUrl = deps.fetchUrl ?? defaultFetchUrl;
  const floor = options.candidateFloor ?? 0.6;
  const maxPerRun = options.maxCandidatesPerRun ?? 5;

  const existing = new Set(readResearchLog(workspacePath).map((c) => c.id));
  const seenThisRun = new Set<string>();

  let scanned = 0;
  let matched = 0;
  let scored = 0;
  let accepted = 0;
  let skippedExisting = 0;

  for (const feedUrl of options.feeds) {
    let xml: string;
    try {
      xml = await fetchUrl(feedUrl);
    } catch {
      continue; // skip a dead feed; don't fail the whole discover pass
    }
    const items = parseRssFeed(xml);
    scanned += items.length;

    const keyworded = keywordFilter(items, options.keywords);
    matched += keyworded.length;

    for (const item of keyworded) {
      if (scored >= maxPerRun) break;
      if (existing.has(item.id) || seenThisRun.has(item.id)) {
        skippedExisting++;
        continue;
      }
      seenThisRun.add(item.id);
      const result = await scoreRelevance(item, options.architectureSummary, deps.callModel);
      scored++;
      if (result.score < floor) continue;
      const candidate: ResearchCandidate = {
        id: item.id,
        source: guessSource(feedUrl),
        title: item.title,
        abstract: item.summary.slice(0, 2000),
        url: item.link,
        discovered_at: new Date().toISOString(),
        relevance_score: result.score,
        relevance_rationale: result.rationale,
      };
      appendCandidate(workspacePath, candidate);
      accepted++;
    }
  }

  return {
    scanned,
    matched_keywords: matched,
    scored,
    accepted,
    skipped_existing: skippedExisting,
  };
}

function guessSource(feedUrl: string): string {
  if (feedUrl.includes("arxiv")) return "arxiv";
  if (feedUrl.includes("github")) return "github";
  return "rss";
}

async function defaultFetchUrl(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
  return await res.text();
}
