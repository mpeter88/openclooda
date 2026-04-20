/**
 * CR_OODA_CAUSAL_RETRIEVAL — retrieve episodic memories by antecedence.
 *
 * Cosine retrieval finds text that resembles the query. Causal retrieval finds
 * decisions whose downstream outcome matches the query — "what led to this
 * state?" The two are complementary, not alternatives.
 *
 * v1: index outcome-labeled events back to the most recent decision memory
 * sharing the same actionId. Callers query by outcomeSignal or outcome band.
 */

import type { EpisodicEvent } from "./archivist.js";

export interface AntecedentRow {
  decisionId: string;
  decisionText: string;
  decisionAt: number;
  outcomeAt: number;
  gapMs: number;
  outcomeSignal: string;
  outcome: "success" | "failure" | "partial";
  actionId: string;
}

export interface CausalIndex {
  /** Keyed by outcomeSignal; preserves insertion order within each bucket. */
  byOutcomeSignal: Map<string, AntecedentRow[]>;
  /** Keyed by outcome band. */
  byOutcome: Map<"success" | "failure" | "partial", AntecedentRow[]>;
}

/**
 * Build the causal index from a set of events. Decision memories are identified
 * by `category === "decision"` + non-empty `actionId`; outcome events are any
 * events where `outcome` is set. A decision + outcome are joined when they
 * share an `actionId`.
 *
 * Pure. O(n) in the number of events.
 */
export function buildCausalIndex(events: EpisodicEvent[]): CausalIndex {
  const decisionsByAction = new Map<string, EpisodicEvent>();
  for (const e of events) {
    if (!e.actionId) continue;
    if (e.category !== "decision") continue;
    const existing = decisionsByAction.get(e.actionId);
    if (!existing || e.createdAt > existing.createdAt) {
      decisionsByAction.set(e.actionId, e);
    }
  }

  const byOutcomeSignal = new Map<string, AntecedentRow[]>();
  const byOutcome = new Map<"success" | "failure" | "partial", AntecedentRow[]>();

  for (const e of events) {
    if (!e.actionId) continue;
    if (!e.outcome) continue;
    const decision = decisionsByAction.get(e.actionId);
    if (!decision) continue;
    if (decision.id === e.id) continue; // don't self-link a single memory

    const row: AntecedentRow = {
      decisionId: decision.id,
      decisionText: decision.text,
      decisionAt: decision.createdAt,
      outcomeAt: e.outcomeAt ?? e.createdAt,
      gapMs: (e.outcomeAt ?? e.createdAt) - decision.createdAt,
      outcomeSignal: e.outcomeSignal ?? "",
      outcome: e.outcome,
      actionId: e.actionId,
    };

    if (row.outcomeSignal) {
      const list = byOutcomeSignal.get(row.outcomeSignal) ?? [];
      list.push(row);
      byOutcomeSignal.set(row.outcomeSignal, list);
    }
    const bandList = byOutcome.get(e.outcome) ?? [];
    bandList.push(row);
    byOutcome.set(e.outcome, bandList);
  }

  return { byOutcomeSignal, byOutcome };
}

export interface FindAntecedentsQuery {
  outcomeSignal?: string;
  outcome?: "success" | "failure" | "partial";
  /** Cap how far back (from `now`) to look. Default unlimited. */
  withinMs?: number;
  /** Max results. Default 10. */
  limit?: number;
  /** Injected for tests; defaults to Date.now(). */
  now?: number;
}

/**
 * Look up antecedents for the given query. Returns the most recent decision
 * memories whose outcome matched the query, sorted by `decisionAt` descending.
 * Returns [] on empty match — never throws.
 */
export function findAntecedents(
  events: EpisodicEvent[],
  query: FindAntecedentsQuery,
): AntecedentRow[] {
  const index = buildCausalIndex(events);
  const limit = query.limit ?? 10;
  const now = query.now ?? Date.now();
  const cutoff = query.withinMs !== undefined ? now - query.withinMs : -Infinity;

  let pool: AntecedentRow[] = [];
  if (query.outcomeSignal) {
    pool = index.byOutcomeSignal.get(query.outcomeSignal) ?? [];
  } else if (query.outcome) {
    pool = index.byOutcome.get(query.outcome) ?? [];
  } else {
    // No selector — flatten all outcome buckets.
    for (const list of index.byOutcome.values()) pool.push(...list);
  }

  return pool
    .filter((r) => r.decisionAt >= cutoff)
    .sort((a, b) => b.decisionAt - a.decisionAt)
    .slice(0, limit);
}

/**
 * Format antecedents as a compact one-line-per-row summary, suitable for
 * attaching to `CriticalFailureEvent.evidence` or the error classifier
 * `toolTrace`.
 */
export function formatAntecedents(rows: AntecedentRow[]): string[] {
  return rows.map((r) => {
    const isoDate = new Date(r.decisionAt).toISOString().slice(0, 16);
    const gapMin = (r.gapMs / 60_000).toFixed(1);
    const snippet =
      r.decisionText.length > 140 ? r.decisionText.slice(0, 140) + "…" : r.decisionText;
    return `[${isoDate}] [${r.outcome}${r.outcomeSignal ? "/" + r.outcomeSignal : ""}] Δt=${gapMin}m action=${r.actionId} — ${snippet}`;
  });
}
