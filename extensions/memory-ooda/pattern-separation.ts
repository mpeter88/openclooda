/**
 * CR_OODA_PATTERN_SEPARATION_GATE — dentate-gyrus analog for recall.
 *
 * Source: Mattson 2014. Hippocampus does two opposing things — pattern
 * separation (push similar-looking inputs apart) and pattern completion (fill
 * fragments from stored associations). openclooda's recall is pure-completion
 * today; this module adds a three-band classifier over the same retrieval
 * results so the LLM can distinguish "near-identical — confabulation hazard"
 * from "semantically adjacent but practically distinct."
 */

import { minhash, minhashJaccard } from "./min-hash.js";

export type SeparationBand =
  | "exact_duplicate"
  | "semantic_twin"
  | "lexical_echo"
  | "fuzzy_candidate"
  | "weak_signal";

export interface SeparationThresholds {
  /** Dense cosine similarity at/above which candidates are exact-match territory. */
  exact_dense_floor: number;
  /** Hash Jaccard at/above which a candidate is lexically close. */
  exact_hash_floor: number;
  /** Dense cosine ceiling below which candidates are dropped to weak-signal. */
  weak_dense_ceil: number;
}

export const DEFAULT_SEPARATION_THRESHOLDS: SeparationThresholds = {
  exact_dense_floor: 0.95,
  exact_hash_floor: 0.8,
  weak_dense_ceil: 0.6,
};

export interface RetrievalCandidate {
  memoryId: string;
  denseSim: number;
  hashJaccard: number;
}

export interface ClassifiedCandidate extends RetrievalCandidate {
  band: SeparationBand;
}

/**
 * Classify a single candidate into one of five bands based on dense cosine
 * similarity + MinHash Jaccard similarity. See CR for the band matrix; briefly:
 *
 *   dense ≥ 0.95, hash ≥ 0.80 → exact_duplicate  (confabulation hazard)
 *   dense ≥ 0.95, hash < 0.80 → semantic_twin    (same meaning, different words)
 *   dense < 0.95, hash ≥ 0.80 → lexical_echo     (same words, different meaning)
 *   0.60 ≤ dense < 0.95       → fuzzy_candidate  (normal completion)
 *   dense < 0.60              → weak_signal      (drop or deep-retrieval only)
 */
export function classifyCandidate(
  candidate: RetrievalCandidate,
  thresholds: SeparationThresholds = DEFAULT_SEPARATION_THRESHOLDS,
): SeparationBand {
  const { denseSim, hashJaccard } = candidate;
  if (denseSim < thresholds.weak_dense_ceil) {
    if (hashJaccard >= thresholds.exact_hash_floor) return "lexical_echo";
    return "weak_signal";
  }
  if (denseSim >= thresholds.exact_dense_floor) {
    if (hashJaccard >= thresholds.exact_hash_floor) return "exact_duplicate";
    return "semantic_twin";
  }
  if (hashJaccard >= thresholds.exact_hash_floor) return "lexical_echo";
  return "fuzzy_candidate";
}

export function classifyAll(
  candidates: RetrievalCandidate[],
  thresholds: SeparationThresholds = DEFAULT_SEPARATION_THRESHOLDS,
): ClassifiedCandidate[] {
  return candidates.map((c) => ({ ...c, band: classifyCandidate(c, thresholds) }));
}

/** Compute novelty score for a query given its retrieval result set.
 *
 *   novelty = 1 - max(denseSim across all candidates)
 *
 * Range [0, 1]. 1.0 = no near-match (genuinely novel). 0.0 = query is already
 * in memory. Used by triage/council to gate how aggressively to reason vs echo.
 */
export function computeNovelty(candidates: RetrievalCandidate[]): number {
  if (candidates.length === 0) return 1;
  let maxSim = -Infinity;
  for (const c of candidates) {
    if (c.denseSim > maxSim) maxSim = c.denseSim;
  }
  if (!Number.isFinite(maxSim)) return 1;
  return Math.max(0, Math.min(1, 1 - maxSim));
}

/**
 * Returns true iff any candidate falls in a band that warrants the Council
 * Discriminator — the council member whose job is to ask "what's different
 * about this situation vs the near-match?"
 *
 * Fires on exact_duplicate (strong confabulation hazard). lexical_echo is
 * quieter but still dangerous; future tuning may bring it under this gate too.
 */
export function needsDiscriminator(candidates: ClassifiedCandidate[]): boolean {
  return candidates.some((c) => c.band === "exact_duplicate");
}

/**
 * Summarize band distribution — used by threshold auto-tuner (weekly) to
 * decide whether `exact_dense_floor` / `weak_dense_ceil` should shift.
 */
export function bandDistribution(
  candidates: ClassifiedCandidate[],
): Record<SeparationBand, number> {
  const d: Record<SeparationBand, number> = {
    exact_duplicate: 0,
    semantic_twin: 0,
    lexical_echo: 0,
    fuzzy_candidate: 0,
    weak_signal: 0,
  };
  for (const c of candidates) d[c.band]++;
  return d;
}

// ============================================================================
// Helpers for LLM-facing prompt tagging
// ============================================================================

/** Human-readable one-liner warning for each band, injected into context. */
export function bandNotice(band: SeparationBand): string {
  switch (band) {
    case "exact_duplicate":
      return "WARNING: near-identical prior context exists. If the new answer matches the old one, say so explicitly. If not, name what changed.";
    case "lexical_echo":
      return "CAUTION: lexical overlap with a past memory that had a different meaning. Do not assume the past answer applies here.";
    case "semantic_twin":
      return "NOTE: a semantically similar past memory is available; completion is appropriate.";
    case "fuzzy_candidate":
      return "NOTE: a fuzzy match is available; treat as supporting context.";
    case "weak_signal":
      return "NOTE: weak match; treat as incidental.";
  }
}

/**
 * Build a compact pattern-separation context block from classified candidates.
 * Returns empty string when no candidates — caller should omit.
 */
export function formatSeparationContext(candidates: ClassifiedCandidate[]): string {
  if (candidates.length === 0) return "";
  const grouped = new Map<SeparationBand, ClassifiedCandidate[]>();
  for (const c of candidates) {
    const list = grouped.get(c.band) ?? [];
    list.push(c);
    grouped.set(c.band, list);
  }
  const lines: string[] = [];
  for (const band of [
    "exact_duplicate",
    "lexical_echo",
    "semantic_twin",
    "fuzzy_candidate",
  ] as SeparationBand[]) {
    const rows = grouped.get(band);
    if (!rows || rows.length === 0) continue;
    lines.push(`[${band}] ${bandNotice(band)}`);
    for (const r of rows.slice(0, 5)) {
      lines.push(
        `  · memoryId=${r.memoryId} denseSim=${r.denseSim.toFixed(2)} hashJaccard=${r.hashJaccard.toFixed(2)}`,
      );
    }
  }
  if (lines.length === 0) return "";
  return `<pattern-separation>\n${lines.join("\n")}\n</pattern-separation>`;
}

// ============================================================================
// MinHash re-export for convenience
// ============================================================================

export { minhash, minhashJaccard };

export { serializeSignature, deserializeSignature } from "./min-hash.js";

/**
 * Given two texts, produce a hash Jaccard directly (convenience for callers
 * that haven't pre-computed signatures — O(n) per call).
 */
export function hashJaccardOfTexts(a: string, b: string): number {
  return minhashJaccard(minhash(a), minhash(b));
}
