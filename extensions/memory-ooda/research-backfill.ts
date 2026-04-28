/**
 * CR_OODA_RESEARCH_LOOP — historical backfill.
 *
 * Daily RSS only covers ~24h of arxiv announcements, so any paper submitted
 * before the loop was activated (or during a quiet stretch longer than a few
 * days) never enters the candidate stream. This module closes that gap by
 * querying the arxiv full-text API directly over a bounded (category × keyword
 * × date-range) grid, feeding matches through the same relevance scorer, and
 * appending survivors to the same `.research-log.jsonl` — so dedup by id stays
 * coherent and re-runs are safe.
 *
 * Scope: one-shot operator tool. Not scheduled. Bounded LLM spend via
 * `maxCandidatesTotal`. Fetch is injected so tests stay offline.
 */

import { runResearchDiscover, type DiscoverResult } from "./research-discover.js";
import type { ModelCallFn } from "./triage.js";

export interface BackfillOptions {
  categories: string[]; // e.g. ["cs.AI","cs.LG","cs.CL","cs.MA"]
  keywords: string[]; // iterated as all:"<kw>" disjunction per category
  architectureSummary: string; // handed to relevance scorer
  since?: string; // ISO date; default 2024-01-01
  until?: string; // ISO date; default today
  maxPerQuery?: number; // arxiv API cap per (cat,kw). Default 50
  maxCandidatesTotal?: number; // hard cap on LLM-scored items. Default 100
  candidateFloor?: number; // LLM score cutoff. Default 0.45
  /** Optional progress callback — fired after each (cat,kw) query completes. */
  onProgress?: (p: { done: number; total: number; url: string }) => void;
  /** Seconds to wait between arxiv API calls (courtesy throttle). Default 3. */
  requestDelaySec?: number;
}

export interface BackfillDeps {
  fetchUrl?: (url: string) => Promise<string>;
  callModel: ModelCallFn;
  /** Injectable sleep so tests don't actually wait. Default: setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Build the arxiv full-text API URL for one (category, keyword, date-range)
 * tuple. Date format is arxiv's native `YYYYMMDDHHMM`.
 */
export function buildArxivQueryUrl(
  category: string,
  keyword: string,
  since: string,
  until: string,
  maxPerQuery: number,
): string {
  const fromArxiv = toArxivDate(since);
  const toArxiv = toArxivDate(until);
  const quoted = `"${keyword}"`;
  const searchQuery = `cat:${category} AND all:${quoted} AND submittedDate:[${fromArxiv} TO ${toArxiv}]`;
  const params = new URLSearchParams({
    search_query: searchQuery,
    start: "0",
    max_results: String(maxPerQuery),
    sortBy: "submittedDate",
    sortOrder: "descending",
  });
  return `http://export.arxiv.org/api/query?${params.toString()}`;
}

function toArxivDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${iso}`);
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}${m}${day}0000`;
}

/**
 * Run a historical backfill. Iterates (cat × kw), each as an arxiv API query,
 * and pipes results through `runResearchDiscover` one URL at a time so the
 * existing dedup-by-id + relevance-score pipeline does all the work.
 *
 * The per-URL invocation uses `maxCandidatesPerRun = remainingBudget` so the
 * overall cap `maxCandidatesTotal` is honoured across the whole grid.
 */
export async function runResearchBackfill(
  workspacePath: string,
  deps: BackfillDeps,
  options: BackfillOptions,
): Promise<BackfillResult> {
  const since = options.since ?? "2024-01-01";
  const until = options.until ?? new Date().toISOString().slice(0, 10);
  const maxPerQuery = options.maxPerQuery ?? 50;
  const budgetTotal = options.maxCandidatesTotal ?? 100;
  const floor = options.candidateFloor ?? 0.45;
  const delayMs = (options.requestDelaySec ?? 3) * 1000;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  const grid: Array<{ cat: string; kw: string; url: string }> = [];
  for (const cat of options.categories) {
    for (const kw of options.keywords) {
      grid.push({
        cat,
        kw,
        url: buildArxivQueryUrl(cat, kw, since, until, maxPerQuery),
      });
    }
  }

  let totals: BackfillResult = {
    queries_issued: 0,
    scanned: 0,
    matched_keywords: 0,
    scored: 0,
    accepted: 0,
    skipped_existing: 0,
    queries_failed: 0,
  };

  let remaining = budgetTotal;
  for (const [i, entry] of grid.entries()) {
    if (remaining <= 0) break;
    try {
      const r: DiscoverResult = await runResearchDiscover(
        workspacePath,
        { fetchUrl: deps.fetchUrl, callModel: deps.callModel },
        {
          feeds: [entry.url],
          // arxiv query already filters by keyword, but keep the client-side
          // keyword list so offline-generated Atom fixtures still filter.
          keywords: [entry.kw],
          architectureSummary: options.architectureSummary,
          candidateFloor: floor,
          maxCandidatesPerRun: remaining,
        },
      );
      totals = {
        queries_issued: totals.queries_issued + 1,
        scanned: totals.scanned + r.scanned,
        matched_keywords: totals.matched_keywords + r.matched_keywords,
        scored: totals.scored + r.scored,
        accepted: totals.accepted + r.accepted,
        skipped_existing: totals.skipped_existing + r.skipped_existing,
        queries_failed: totals.queries_failed,
      };
      remaining -= r.scored;
    } catch {
      totals.queries_failed += 1;
    }
    options.onProgress?.({ done: i + 1, total: grid.length, url: entry.url });
    // Courtesy delay — skip after last entry.
    if (i < grid.length - 1 && delayMs > 0) await sleep(delayMs);
  }

  return totals;
}

export interface BackfillResult {
  queries_issued: number;
  queries_failed: number;
  scanned: number;
  matched_keywords: number;
  scored: number;
  accepted: number;
  skipped_existing: number;
}
