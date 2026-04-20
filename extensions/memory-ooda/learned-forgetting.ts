/**
 * CR_OODA_LEARNED_FORGETTING — prune episodic memory by usefulness.
 *
 * The default age-only prune treats a high-value decision memory identically
 * to a one-off tool log. Memory-core neuroscience (and the Mattson 2014 paper)
 * suggests durable encoding correlates with emotional arousal + frequent
 * retrieval + significance. This module codifies four "keep" signals and
 * exposes a pure partition function so callers can selectively evict.
 *
 * Pure. No fs. No LLM. `now` injected for deterministic tests.
 */

import type { EpisodicEvent } from "./archivist.js";

export interface ForgettingPolicy {
  /** Age cutoff — events older than this are drop-eligible unless a keep signal fires. */
  olderThanMs: number;
  /** Protect events with importance ≥ this multiplier (post-emotional-tagging weighting). */
  keepImportanceFloor: number;
  /** Protect events whose outcome is set (any band). */
  keepOutcomeLabeled: boolean;
  /** Protect events whose outcomeAt (proxy for last retrieval signal) falls within this window. */
  keepRetrievedWithinMs: number;
  /** Protect events whose category is in this allowlist (defaults to ["decision"]). */
  keepCategories: string[];
}

export const DEFAULT_FORGETTING_POLICY: ForgettingPolicy = {
  olderThanMs: 90 * 24 * 60 * 60 * 1000, // 90 days
  keepImportanceFloor: 0.75,
  keepOutcomeLabeled: true,
  keepRetrievedWithinMs: 30 * 24 * 60 * 60 * 1000, // 30 days
  keepCategories: ["decision"],
};

/**
 * Decide whether an event should be kept under the policy. Returns true to
 * preserve; false if the event is drop-eligible (older than cutoff AND no keep
 * signal fires).
 */
export function shouldKeep(
  event: EpisodicEvent,
  policy: ForgettingPolicy = DEFAULT_FORGETTING_POLICY,
  now: number = Date.now(),
): boolean {
  const ageMs = now - event.createdAt;
  // Under the age floor — unconditionally keep.
  if (ageMs < policy.olderThanMs) return true;

  // Signal 1: importance floor.
  if (typeof event.importance === "number" && event.importance >= policy.keepImportanceFloor) {
    return true;
  }

  // Signal 2: outcome labeled (success/failure/partial all count).
  if (policy.keepOutcomeLabeled && event.outcome) return true;

  // Signal 3: outcomeAt within retained window (proxy for "recently touched").
  if (
    typeof event.outcomeAt === "number" &&
    now - event.outcomeAt <= policy.keepRetrievedWithinMs
  ) {
    return true;
  }

  // Signal 4: category allowlist.
  if (policy.keepCategories.includes(event.category)) return true;

  return false;
}

export interface PartitionResult {
  keep: EpisodicEvent[];
  drop: EpisodicEvent[];
}

/** Split events into keep/drop partitions per the policy. */
export function partitionForPrune(
  events: EpisodicEvent[],
  policy: ForgettingPolicy = DEFAULT_FORGETTING_POLICY,
  now: number = Date.now(),
): PartitionResult {
  const keep: EpisodicEvent[] = [];
  const drop: EpisodicEvent[] = [];
  for (const e of events) {
    if (shouldKeep(e, policy, now)) keep.push(e);
    else drop.push(e);
  }
  return { keep, drop };
}

/**
 * Explain which signal protected a given event — useful for CLI dry-runs and
 * debugging. Returns null when the event would be dropped.
 */
export function explainKeep(
  event: EpisodicEvent,
  policy: ForgettingPolicy = DEFAULT_FORGETTING_POLICY,
  now: number = Date.now(),
): string | null {
  const ageMs = now - event.createdAt;
  if (ageMs < policy.olderThanMs) return "under_age_floor";
  if (typeof event.importance === "number" && event.importance >= policy.keepImportanceFloor) {
    return `importance=${event.importance.toFixed(2)} >= ${policy.keepImportanceFloor}`;
  }
  if (policy.keepOutcomeLabeled && event.outcome) {
    return `outcome=${event.outcome}`;
  }
  if (
    typeof event.outcomeAt === "number" &&
    now - event.outcomeAt <= policy.keepRetrievedWithinMs
  ) {
    return `outcomeAt_recent`;
  }
  if (policy.keepCategories.includes(event.category)) {
    return `category=${event.category}`;
  }
  return null;
}
