/**
 * CR_OODA_GROUNDED_EVAL_HARNESS_V2 — pass^k reliability metric.
 *
 * Definition (Sierra τ-bench, arxiv 2406.12045):
 *   pass^k = fraction of cases where the case succeeds on ALL k independent replays.
 *
 * Strictly monotone decreasing in k. Acceptance gate: pass^8 >= 0.60.
 */

import type { ActualOutcome, AdmissionCase, PassKConfig, PassKResult } from "./types.js";

export type AdmissionRunnable = (fixture: AdmissionCase["fixture"]) => Promise<ActualOutcome>;

function outcomeIsSuccess(o: ActualOutcome): boolean {
  switch (o.source) {
    case "tool_result":
      return o.success === true;
    case "user_signal":
      return o.signal === "approved";
    case "inferred":
      return o.confidence >= 0.7;
  }
}

/**
 * Run pass^k battery over a set of cases. Each case is replayed maxK times.
 * pass^k is computed as the fraction of cases whose first k runs all succeeded.
 */
export async function runPassK(
  cases: AdmissionCase[],
  runnable: AdmissionRunnable,
  config: PassKConfig,
): Promise<PassKResult> {
  const kValues = [...config.kValues].sort((a, b) => a - b);
  const maxK = kValues[kValues.length - 1] ?? 1;

  const selected =
    config.caseIds.length > 0 ? cases.filter((c) => config.caseIds.includes(c.id)) : cases;

  // For each case, run maxK trials. Track per-trial success.
  const perCaseResults: boolean[][] = [];
  for (const c of selected) {
    const trials: boolean[] = [];
    for (let i = 0; i < maxK; i++) {
      try {
        const outcome = await withTimeout(runnable(c.fixture), config.caseTimeoutMs);
        trials.push(outcomeIsSuccess(outcome));
      } catch {
        trials.push(false);
      }
    }
    perCaseResults.push(trials);
  }

  const passRates: Record<number, number> = {};
  for (const k of kValues) {
    if (perCaseResults.length === 0) {
      passRates[k] = 0;
      continue;
    }
    const caseCount = perCaseResults.filter((trials) => trials.slice(0, k).every((t) => t)).length;
    passRates[k] = caseCount / perCaseResults.length;
  }

  const narrative = kValues.map((k) => `pass^${k}=${(passRates[k] * 100).toFixed(0)}%`).join(", ");

  return {
    kValues,
    passRates,
    totalTrials: perCaseResults.length * maxK,
    trialsPerCase: maxK,
    narrative: `${selected.length} cases, ${maxK} trials each: ${narrative}`,
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("pass-k trial timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
