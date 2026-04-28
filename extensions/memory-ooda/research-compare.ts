/**
 * CR_OODA_RESEARCH_LOOP — Stage 4 (compare) + Stage 5 (rollout proposal).
 *
 * Pure arithmetic over ExperimentResult objects + one emission path into the
 * existing PolicyProposal store. No LLM calls, no fs beyond the experiment dir
 * + rollout queue.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { concludeAndTransition } from "./conclusion.js";
import type { RunVerdict } from "./hypothesis-schema.js";
import { addProposal } from "./proposals.js";
import {
  appendRolloutQueue,
  experimentDir,
  transitionStage,
  writeExperimentRecord,
  type ExperimentRecord,
  type ExperimentResult,
} from "./research-loop.js";

export interface CompareResult {
  mean_delta: number;
  per_domain: Record<string, number>;
  had_regression: boolean;
  regression_ids: string[];
}

/**
 * Pure compare: sandbox vs baseline ExperimentResult. `per_domain` is the
 * baseline-minus-sandbox delta (positive = improvement). If a baseline has no
 * full pass_rate_full, fall back to pass_rate_small.
 *
 * `had_regression` is true iff sandbox.regressions is non-empty (any
 * prior-success case that flipped to failure).
 */
export function compareResults(
  baseline: ExperimentResult | undefined,
  sandbox: ExperimentResult,
): CompareResult {
  const b = baseline?.pass_rate_full ?? baseline?.pass_rate_small ?? null;
  const s = sandbox.pass_rate_full ?? sandbox.pass_rate_small ?? null;
  const baselineGlobal = typeof b === "number" ? b : 0;
  const sandboxGlobal = typeof s === "number" ? s : 0;
  const per_domain: Record<string, number> = {};
  const domains = new Set([
    ...Object.keys(baseline?.per_domain ?? {}),
    ...Object.keys(sandbox.per_domain),
  ]);
  for (const d of domains) {
    const bv = baseline?.per_domain?.[d] ?? 0;
    const sv = sandbox.per_domain[d] ?? 0;
    per_domain[d] = sv - bv;
  }
  return {
    mean_delta: sandboxGlobal - baselineGlobal,
    per_domain,
    had_regression: sandbox.regressions.length > 0,
    regression_ids: [...sandbox.regressions],
  };
}

// ============================================================================
// Stage 4 main entry
// ============================================================================

export interface CompareOptions {
  workspacePath: string;
  expId: string;
  /** Baseline can be supplied directly (e.g. cached from parent generation). */
  baseline?: ExperimentResult;
  /**
   * Or resolved via a loader the caller provides — useful when the baseline
   * needs to be computed just-in-time from the parent generation.
   */
  loadBaseline?: (parentGenid: string) => Promise<ExperimentResult | undefined>;
}

/**
 * Derive a `RunVerdict` from compare + the hypothesis's success/failure
 * metrics. When no `hypothesis_obj` is present on the record (legacy
 * pre-CR_OODA_HYPOTHESIS_DISCIPLINE experiments), fall back to the old
 * "pass iff no regression and mean_delta>=0" heuristic.
 */
export function deriveRunVerdict(
  record: ExperimentRecord,
  compare: CompareResult,
  hypothesisPassRate: number | null | undefined,
): RunVerdict {
  const h = record.hypothesis_obj;
  if (!h) {
    // Legacy path.
    if (compare.had_regression) return "fail";
    return compare.mean_delta >= 0 ? "pass" : "signal";
  }
  const hp = typeof hypothesisPassRate === "number" ? hypothesisPassRate : 0;
  const deltaOk = compare.mean_delta >= h.success_metric.min_delta_vs_parent;
  const hpOk = hp >= h.success_metric.min_pass_rate;
  // Forbidden-tag regressions are a hard fail. Today we can't tag regressions
  // in ExperimentResult, so any non-empty regression set counts against any
  // forbidden tag being present. This is conservative — it will only loosen
  // once regressions carry tag provenance.
  const forbiddenHit =
    h.failure_metric.regression_forbidden_tags.length > 0 && compare.had_regression;

  if (forbiddenHit) return "fail";
  if (deltaOk && hpOk) return "pass";
  if (deltaOk || hpOk) return "signal";
  return "fail";
}

export async function runResearchCompare(
  options: CompareOptions,
): Promise<{ record: ExperimentRecord; compare: CompareResult; verdict: RunVerdict } | null> {
  const dir = experimentDir(options.workspacePath, options.expId);
  const statusFile = path.join(dir, "status.json");
  if (!fs.existsSync(statusFile)) return null;
  const record = JSON.parse(fs.readFileSync(statusFile, "utf-8")) as ExperimentRecord;
  if (!record.scores.sandbox) return null;

  const baseline =
    options.baseline ??
    (options.loadBaseline ? await options.loadBaseline(record.parent_genid) : undefined);
  const compare = compareResults(baseline, record.scores.sandbox);
  fs.writeFileSync(path.join(dir, "delta.json"), JSON.stringify(compare, null, 2) + "\n", "utf-8");

  // Derive verdict from the current (last) run's hypothesis pass rate.
  const lastRun = record.runs?.[record.runs.length - 1];
  const verdict = deriveRunVerdict(record, compare, lastRun?.hypothesis_pass_rate);

  const runs = [...(record.runs ?? [])];
  if (runs.length > 0) {
    const lastIdx = runs.length - 1;
    runs[lastIdx] = {
      ...runs[lastIdx],
      mean_delta: compare.mean_delta,
      verdict,
    };
  }

  const updated: ExperimentRecord = {
    ...record,
    scores: {
      ...record.scores,
      baseline,
      delta: {
        mean: compare.mean_delta,
        per_domain: compare.per_domain,
        had_regression: compare.had_regression,
      },
    },
    runs,
  };
  writeExperimentRecord(options.workspacePath, updated);
  transitionStage(options.workspacePath, options.expId, "compared");

  // Route based on verdict.
  // - pass:    stay at "compared"; downstream `runResearchRollout` promotes.
  // - signal:  transition to "refining" so the next tick invokes
  //            `runResearchRefine`.
  // - fail:    conclude as dump immediately; do not consume further ticks.
  if (verdict === "signal") {
    transitionStage(options.workspacePath, options.expId, "refining");
  } else if (verdict === "fail") {
    concludeAndTransition(
      options.workspacePath,
      options.expId,
      {
        verdict: "dump",
        learning: `compare verdict=fail; mean_delta=${compare.mean_delta.toFixed(3)}; regressions=${compare.regression_ids.length}; hypothesis_pass_rate=${lastRun?.hypothesis_pass_rate ?? "n/a"}`,
        authored_by: "system",
      },
      "concluded-dump",
    );
  }

  return { record: updated, compare, verdict };
}

// ============================================================================
// Stage 5 — rollout proposal emission
// ============================================================================

export interface RolloutOptions {
  workspacePath: string;
  expId: string;
  /** Minimum mean delta required to emit a proposal. Default +0.05. */
  rolloutThreshold?: number;
}

export interface RolloutDecision {
  admitted: boolean;
  reason: string;
  proposal_id?: string;
}

/**
 * Evaluate the experiment's delta. If it meets the rollout threshold and has
 * no regressions, emit a PolicyProposal (category: "research_rollout") and
 * append to the rollout queue. Otherwise transition to `rejected` with notes.
 *
 * Finding 7 — when `record.hypothesis_obj` is present, trust the upstream
 * verdict from compare. Compare already routed signal/fail elsewhere
 * (refining/concluded-dump), so rollout only ever sees `pass`. The legacy
 * threshold gate is kept for pre-hypothesis-discipline records that have no
 * verdict to trust.
 */
export async function runResearchRollout(options: RolloutOptions): Promise<RolloutDecision> {
  const threshold = options.rolloutThreshold ?? 0.05;
  const dir = experimentDir(options.workspacePath, options.expId);
  const statusFile = path.join(dir, "status.json");
  if (!fs.existsSync(statusFile)) {
    return { admitted: false, reason: "experiment record missing" };
  }
  const record = JSON.parse(fs.readFileSync(statusFile, "utf-8")) as ExperimentRecord;
  const delta = record.scores.delta;
  if (!delta) {
    transitionStage(options.workspacePath, options.expId, "rejected", "no compare result");
    return { admitted: false, reason: "no compare result" };
  }

  if (record.hypothesis_obj) {
    // Verdict-aware path. compare derived "pass" from both
    // min_delta_vs_parent and min_pass_rate; no second threshold gate.
    const lastRun = record.runs?.[record.runs.length - 1];
    if (lastRun?.verdict !== "pass") {
      return {
        admitted: false,
        reason: `verdict=${lastRun?.verdict ?? "n/a"} (rollout requires pass)`,
      };
    }
  } else {
    // Legacy path — pre-hypothesis-discipline records only have the threshold.
    if (delta.had_regression) {
      transitionStage(
        options.workspacePath,
        options.expId,
        "rejected",
        "regressed on prior-success admission cases",
      );
      return { admitted: false, reason: "regression on prior-success case(s)" };
    }
    if (delta.mean < threshold) {
      transitionStage(
        options.workspacePath,
        options.expId,
        "rejected",
        `mean delta ${delta.mean.toFixed(3)} below threshold ${threshold}`,
      );
      return {
        admitted: false,
        reason: `mean delta ${delta.mean.toFixed(3)} < ${threshold}`,
      };
    }
  }

  // Diff content — passed as reasoning to the proposal for traceability.
  const diffPath = path.join(dir, "diff.patch");
  const diff = fs.existsSync(diffPath) ? fs.readFileSync(diffPath, "utf-8") : "";
  const hypothesis = record.hypothesis ?? "(no hypothesis recorded)";
  const citation = record.source.citation ?? record.source.ref;

  const proposalId = `research-${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const proposal = addProposal(options.workspacePath, {
    id: proposalId,
    timestamp: now,
    rule: `experiment:${options.expId}`,
    proposal: `Rollout experiment ${options.expId} (Δ=${delta.mean.toFixed(3)})`,
    reasoning: `Hypothesis: ${hypothesis}\n\nCitation: ${citation}\n\nDelta:\n${JSON.stringify(delta, null, 2)}\n\nDiff:\n${diff.slice(0, 4000)}`,
    evidence: Object.keys(delta.per_domain),
    category: "workflow",
    confidence: Math.min(1, 0.6 + delta.mean),
    autoGenerated: true,
  });

  appendRolloutQueue(options.workspacePath, {
    exp_id: options.expId,
    proposal_id: proposal.id,
    queued_at: now,
    summary: `${citation ?? ""} Δ=${delta.mean.toFixed(3)}`.trim(),
  });

  const updated: ExperimentRecord = {
    ...record,
    rollout: { proposal_id: proposal.id, queued_at: now },
  };
  writeExperimentRecord(options.workspacePath, updated);
  transitionStage(options.workspacePath, options.expId, "rollout-proposed");

  return {
    admitted: true,
    reason: `rollout proposal ${proposal.id} queued for human approval`,
    proposal_id: proposal.id,
  };
}
