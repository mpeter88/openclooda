/**
 * CR_OODA_COUNCIL_KS_STOPPING — adaptive chair sampling with discrete KS stability.
 *
 * Source: Multi-Agent Debate for LLM Judges with Adaptive Stability Detection,
 * Hu, Tan, Wang, Qu, Chen 2025 (arxiv 2510.12697).
 *
 * We sample the chair multiple times (across rotating temperatures), track the
 * empirical distribution over verdict labels, and stop when the round-over-round
 * KS distance drops below the configured threshold. Discrete-KS for a categorical
 * label space: max per-label absolute difference in empirical frequency.
 */

import type { AdaptiveChairConfig, ChairSamplingResult } from "./types.js";

export type ChairSampleFn = (
  attempt: number,
  temperature: number,
) => Promise<{ label: string; confidence: number; raw: string }>;

/**
 * Compute discrete KS distance between two empirical label distributions.
 * Returns max over all seen labels of absolute frequency difference.
 */
export function discreteKS(
  prev: Map<string, number>,
  curr: Map<string, number>,
  prevTotal: number,
  currTotal: number,
): number {
  if (prevTotal === 0 || currTotal === 0) return 1;
  const labels = new Set([...prev.keys(), ...curr.keys()]);
  let maxDiff = 0;
  for (const label of labels) {
    const p = (prev.get(label) ?? 0) / prevTotal;
    const q = (curr.get(label) ?? 0) / currTotal;
    const diff = Math.abs(p - q);
    if (diff > maxDiff) maxDiff = diff;
  }
  return maxDiff;
}

/** Default config with sensible baselines matching the CR. */
export const DEFAULT_ADAPTIVE_CONFIG: AdaptiveChairConfig = {
  enabled: true,
  minSamples: 3,
  maxSamples: 9,
  ksThreshold: 0.15,
  temperatures: [0.0, 0.4, 0.8],
  priorityFloor: 7,
  dailyBudget: 200,
};

/**
 * Run adaptive chair sampling. Calls `sampleFn` up to `maxSamples` times,
 * rotating temperatures from the configured list. Stops early when:
 *   - All `minSamples` draws agree (100% consensus) — winnerShare=1.0.
 *   - Round-over-round KS distance < `ksThreshold` after `minSamples`.
 */
export async function runAdaptiveChair(
  sampleFn: ChairSampleFn,
  config: AdaptiveChairConfig = DEFAULT_ADAPTIVE_CONFIG,
): Promise<ChairSamplingResult> {
  const min = Math.max(1, config.minSamples);
  const max = Math.max(min, config.maxSamples);
  const temperatures = config.temperatures.length > 0 ? config.temperatures : [0.0];

  const samples: ChairSamplingResult["samples"] = [];
  const labelCounts = new Map<string, number>();
  let prevCounts = new Map<string, number>();
  const ksByRound: number[] = [];
  let stabilizedAt = -1;
  let forcedStop = false;

  for (let i = 0; i < max; i++) {
    const temp = temperatures[i % temperatures.length];
    const { label, confidence, raw } = await sampleFn(i, temp);
    samples.push({
      attempt: i,
      temperature: temp,
      parsedLabel: label,
      parsedConfidence: confidence,
      raw,
    });
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);

    // Early-confident shortcut: after minSamples, if all agree, stop.
    if (i + 1 >= min && labelCounts.size === 1) {
      stabilizedAt = i + 1;
      break;
    }

    // KS check: only after minSamples collected.
    if (i + 1 > min) {
      const ks = discreteKS(prevCounts, labelCounts, i, i + 1);
      ksByRound.push(ks);
      if (ks < config.ksThreshold) {
        stabilizedAt = i + 1;
        break;
      }
    }

    // Save snapshot for next round's KS comparison.
    prevCounts = new Map(labelCounts);
  }

  if (stabilizedAt === -1) {
    stabilizedAt = samples.length;
    forcedStop = true;
  }

  // Modal winner
  let winnerLabel = "";
  let winnerCount = 0;
  for (const [label, count] of labelCounts) {
    if (count > winnerCount) {
      winnerCount = count;
      winnerLabel = label;
    }
  }
  const winnerShare = samples.length > 0 ? winnerCount / samples.length : 0;

  // Split verdict: top two within 0.1 on forced stop
  let splitVerdict = false;
  if (forcedStop) {
    const sortedCounts = [...labelCounts.values()].sort((a, b) => b - a);
    if (sortedCounts.length >= 2) {
      const topShare = sortedCounts[0] / samples.length;
      const secondShare = sortedCounts[1] / samples.length;
      if (topShare - secondShare < 0.1) splitVerdict = true;
    }
  }

  return {
    samples,
    stabilizedAt,
    ksByRound,
    winnerLabel,
    winnerShare,
    forcedStop,
    splitVerdict,
  };
}

// ============================================================================
// Jury activation helper (interacts with D1)
// ============================================================================

export type JuryDecision = "skip" | "fire_by_winnerShare" | "fire_by_thresholds";

/**
 * Decide whether to activate the jury layer based on the adaptive-chair result
 * and the D1 jury thresholds (priority + disagreement).
 *
 *  - winnerShare >= 0.85: skip jury, chair is reliable.
 *  - winnerShare < 0.6: force fire jury regardless of priority/disagreement.
 *  - Otherwise: delegate to priority+disagreement thresholds from D1.
 */
export function juryActivation(
  winnerShare: number,
  priority: number,
  disagreementScore: number,
  priorityFloor = 9,
  disagreementFloor = 0.6,
): JuryDecision {
  if (winnerShare >= 0.85) return "skip";
  if (winnerShare < 0.6) return "fire_by_winnerShare";
  if (priority >= priorityFloor && disagreementScore >= disagreementFloor) {
    return "fire_by_thresholds";
  }
  return "skip";
}
