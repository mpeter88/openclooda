/**
 * CR_OODA_GROUNDED_EVAL_HARNESS_V2 — admission gate for PolicyProposals.
 *
 * Frozen regression suite: a change (policy, weight adjustment, etc.) is admitted
 * only when it passes on previously-working admission cases AND meets the
 * configured pass^k floor.
 *
 * Borrowed from Darwin Gödel Machine (arxiv 2505.22954) — archive + empirical
 * validation gate keeps the evolvable skeleton from grading its own fitness.
 */

import fs from "node:fs";
import path from "node:path";
import { runPassK, type AdmissionRunnable } from "./pass-k.js";
import type { ActualOutcome, AdmissionCase, AdmissionReport, PolicyProposal } from "./types.js";

const ADMISSION_DIR = ".admission-cases";

export function admissionCorpusPath(workspacePath: string): string {
  return path.join(workspacePath, ADMISSION_DIR);
}

export function listAdmissionCases(workspacePath: string): AdmissionCase[] {
  const dir = admissionCorpusPath(workspacePath);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const cases: AdmissionCase[] = [];
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, f), "utf-8");
      cases.push(JSON.parse(raw) as AdmissionCase);
    } catch {
      // skip malformed
    }
  }
  return cases;
}

export function saveAdmissionCase(workspacePath: string, c: AdmissionCase): void {
  const dir = admissionCorpusPath(workspacePath);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${c.id}.json`);
  fs.writeFileSync(file, JSON.stringify(c, null, 2) + "\n", "utf-8");
}

export interface AdmissionGateOptions {
  /** pass^k floor for admission. Default: 0.60. */
  passRateFloor?: number;
  /** k values to test. Default: [1, 2, 4, 8]. */
  kValues?: number[];
  /** Per-case timeout in ms. Default: 15000. */
  caseTimeoutMs?: number;
  /** Minimum cases required; below this, gate falls open ("no_corpus"). */
  minCasesForGate?: number;
  /** Run pass^k battery (slow). If false, runs single-trial only. */
  passKEnabled?: boolean;
}

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
 * Run the admission gate against an admission corpus.
 *
 * - Returns admit=true when:
 *   - Corpus has fewer than minCasesForGate (bootstrap) — falls open.
 *   - Every case whose priorOutcome="success" still succeeds (no regressions),
 *     AND overall pass rate >= passRateFloor,
 *     AND (if passKEnabled) pass^8 >= passRateFloor - 0.20.
 */
export async function runAdmissionGate(
  proposal: PolicyProposal,
  cases: AdmissionCase[],
  runnable: AdmissionRunnable,
  opts: AdmissionGateOptions = {},
): Promise<AdmissionReport> {
  const passRateFloor = opts.passRateFloor ?? 0.6;
  const kValues = opts.kValues ?? [1, 2, 4, 8];
  const caseTimeoutMs = opts.caseTimeoutMs ?? 15_000;
  const minCasesForGate = opts.minCasesForGate ?? 5;
  const passKEnabled = opts.passKEnabled ?? false;

  // Bootstrap: not enough cases → fall open.
  if (cases.length < minCasesForGate) {
    return {
      proposalId: proposal.id,
      casesRun: 0,
      casesPassed: 0,
      casesFailed: [],
      passRate: 0,
      kPassRates: {},
      admit: true,
      admitReason: `no_corpus_bootstrap (${cases.length} < ${minCasesForGate})`,
      computedAt: new Date().toISOString(),
    };
  }

  // Single-trial pass
  const casesFailed: AdmissionReport["casesFailed"] = [];
  let casesPassed = 0;

  for (const c of cases) {
    try {
      const outcome = await withTimeout(runnable(c.fixture), caseTimeoutMs);
      const success = outcomeIsSuccess(outcome);
      if (success) {
        casesPassed++;
      } else {
        // Regression check: prior-success case failing is hard block.
        const reason = c.priorOutcome === "success" ? "regression_on_prior_success" : "fail";
        casesFailed.push({ caseId: c.id, reason });
      }
    } catch (e) {
      casesFailed.push({ caseId: c.id, reason: `timeout_or_error: ${String(e)}` });
    }
  }

  const passRate = casesPassed / cases.length;
  const hasRegression = casesFailed.some((f) => f.reason === "regression_on_prior_success");

  // Optional pass^k
  let kPassRates: Record<number, number> = {};
  if (passKEnabled) {
    const passK = await runPassK(cases, runnable, {
      kValues,
      caseIds: cases.map((c) => c.id),
      caseTimeoutMs,
    });
    kPassRates = passK.passRates;
  }

  const kFloor = passKEnabled ? (kPassRates[8] ?? kPassRates[4] ?? 0) >= passRateFloor - 0.2 : true;

  const admit = !hasRegression && passRate >= passRateFloor && kFloor;

  let admitReason: string;
  if (hasRegression) admitReason = "regression_on_prior_success_case";
  else if (passRate < passRateFloor)
    admitReason = `pass_rate ${passRate.toFixed(2)} < floor ${passRateFloor}`;
  else if (!kFloor) admitReason = `pass^8 below floor - 0.20`;
  else admitReason = `passed: ${casesPassed}/${cases.length}, pass_rate=${passRate.toFixed(2)}`;

  return {
    proposalId: proposal.id,
    casesRun: cases.length,
    casesPassed,
    casesFailed,
    passRate,
    kPassRates,
    admit,
    admitReason,
    computedAt: new Date().toISOString(),
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("admission case timeout")), ms);
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
