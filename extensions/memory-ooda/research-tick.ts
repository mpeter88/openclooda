/**
 * CR_OODA_RESEARCH_LOOP — DMN tick dispatcher.
 *
 * Advances the research pipeline by one step per tick:
 *   1. If an experiment is `proposed`, run sandbox (stage 3).
 *   2. Else if `sandboxed`, run compare (stage 4).
 *   3. Else if `compared`, run rollout (stage 5).
 *   4. Else if an unpromoted candidate exists in the research log, run propose
 *      (stage 2) on the oldest unpromoted candidate.
 *   5. Else run discover (stage 1) to refresh the research log.
 *
 * Stage 3 (sandbox) requires an `IsolationDeps` implementation. Callers who
 * don't want to run stage 3 yet (no Docker / worktree) can pass
 * `enableSandbox: false` and the dispatcher stops at stage 2 proposals for
 * human review.
 */

import { validParents } from "./agent-archive.js";
import { appendDMNLog } from "./dmn.js";
import { runResearchCompare, runResearchRollout } from "./research-compare.js";
import { runResearchDiscover, type DiscoverOptions } from "./research-discover.js";
import type { ResearchCandidate, ExperimentRecord } from "./research-loop.js";
import { listExperiments, readResearchLog, transitionStage } from "./research-loop.js";
import { runResearchPropose, type ProposeOptions } from "./research-propose.js";
import { runResearchRefine } from "./research-refine.js";
import { runResearchSandbox, type IsolationDeps } from "./research-sandbox.js";
import type { ModelCallFn } from "./triage.js";

export interface ResearchTickConfig {
  feeds: string[];
  keywords: string[];
  architectureSummary: string;
  candidateFloor?: number;
  rolloutThreshold?: number;
  enableSandbox?: boolean;
  /** Present only when enableSandbox=true. */
  isolation?: IsolationDeps;
  /** Present only when enableSandbox=true. */
  baselineLoader?: (
    parentGenid: string,
  ) => Promise<NonNullable<ExperimentRecord["scores"]["baseline"]>>;
  fetchUrl?: (url: string) => Promise<string>;
  /**
   * HyperAgents-style parent selection uses `random.choice` over the filtered
   * pool of valid_parent=true generations. Injectable for deterministic tests.
   */
  random?: () => number;
}

export type ResearchTickAction =
  | "sandbox"
  | "compare"
  | "rollout"
  | "refine"
  | "propose"
  | "discover"
  | "noop";

export interface ResearchTickOutcome {
  action: ResearchTickAction;
  details: string;
  advanced_exp_id?: string;
}

function firstByStatus(
  experiments: ExperimentRecord[],
  status: ExperimentRecord["status"],
): ExperimentRecord | undefined {
  return experiments.find((e) => e.status === status);
}

function firstUnpromotedCandidate(
  workspacePath: string,
  experiments: ExperimentRecord[],
): ResearchCandidate | undefined {
  const promoted = new Set(experiments.map((e) => e.source.ref));
  const candidates = readResearchLog(workspacePath);
  return candidates.find((c) => !c.promoted_to_experiment_id && !promoted.has(c.id));
}

/**
 * HyperAgents / DGM-style parent selection: random choice over the filtered
 * pool of valid_parent=true generations. Falls back to "initial" when the
 * archive has no valid parents yet (bootstrap case on a fresh workspace).
 *
 * Injected RNG keeps the selection deterministic under test. Randomness is
 * intentional — it prevents the experimentation stream from collapsing into a
 * single greedy lineage.
 */
export function pickParentGenid(workspacePath: string, random: () => number = Math.random): string {
  const valid = validParents(workspacePath);
  if (valid.length === 0) return "initial";
  const idx = Math.floor(random() * valid.length);
  return valid[Math.min(idx, valid.length - 1)].genid;
}

/**
 * Run one research tick. Returns what action was taken + details. Callers
 * (e.g. the DMN runner in index.ts) are responsible for budget accounting.
 */
export async function runResearchTickOnce(
  workspacePath: string,
  callModel: ModelCallFn,
  config: ResearchTickConfig,
): Promise<ResearchTickOutcome> {
  const experiments = listExperiments(workspacePath);

  // Priority 1: advance an existing experiment that has a sandbox result but
  // hasn't compared yet. compare may transition the record to `refining`
  // (signal verdict) or `concluded-dump` (fail verdict); only on `pass` does
  // it stay at `compared` for rollout evaluation.
  const compared = firstByStatus(experiments, "sandboxed");
  if (compared) {
    await runResearchCompare({
      workspacePath,
      expId: compared.exp_id,
      loadBaseline: config.baselineLoader,
    });
    // Re-read status — compare may have moved it.
    const post = listExperiments(workspacePath).find((e) => e.exp_id === compared.exp_id);
    if (post?.status === "compared") {
      const rolloutDecision = await runResearchRollout({
        workspacePath,
        expId: compared.exp_id,
        rolloutThreshold: config.rolloutThreshold,
      });
      return {
        action: rolloutDecision.admitted ? "rollout" : "compare",
        details: rolloutDecision.reason,
        advanced_exp_id: compared.exp_id,
      };
    }
    return {
      action: "compare",
      details: `compared ${compared.exp_id} → ${post?.status}`,
      advanced_exp_id: compared.exp_id,
    };
  }

  // Priority 2a: advance an experiment in `refining` — the compare stage
  // detected signal but not pass; refine tick generates a next run.
  const refining = firstByStatus(experiments, "refining");
  if (refining) {
    const r = await runResearchRefine(workspacePath, callModel, {
      expId: refining.exp_id,
    });
    return {
      action: "refine",
      details: `refine ${refining.exp_id}: outcome=${r.outcome}${r.action ? ` action=${r.action}` : ""}${r.reason ? ` reason=${r.reason}` : ""}`,
      advanced_exp_id: refining.exp_id,
    };
  }

  // Priority 2b: advance an experiment that's proposed but not yet sandboxed.
  // Skips `awaiting-epic-approval` — those require operator action.
  const proposed = firstByStatus(experiments, "proposed");
  if (proposed) {
    if (!config.enableSandbox || !config.isolation) {
      return {
        action: "noop",
        details: `experiment ${proposed.exp_id} proposed — sandbox disabled`,
        advanced_exp_id: proposed.exp_id,
      };
    }
    // Apply-failure routing (CR_OODA_HYPOTHESIS_DISCIPLINE_HARDENING #1):
    // a corrupt LLM patch used to throw out of runResearchSandbox and leave
    // the record stuck at `proposed` forever, deadlocking every later tick.
    // Catch here so the next refine tick can rewrite the diff.
    try {
      await runResearchSandbox(proposed.exp_id, config.isolation, {
        workspacePath,
      });
    } catch (err) {
      const reason = String(err).slice(0, 200);
      appendDMNLog(workspacePath, {
        timestamp: new Date().toISOString(),
        bucket: "dormant",
        kind: "research_tick",
        outcome: "error",
        details: `sandbox apply failed → refining ${proposed.exp_id}: ${reason}`,
      });
      transitionStage(workspacePath, proposed.exp_id, "refining", `apply failed: ${reason}`);
      return {
        action: "sandbox",
        details: `sandbox apply failed → refining: ${reason}`,
        advanced_exp_id: proposed.exp_id,
      };
    }
    return {
      action: "sandbox",
      details: `sandboxed ${proposed.exp_id}`,
      advanced_exp_id: proposed.exp_id,
    };
  }

  // Priority 3: promote a discovered candidate to a proposed experiment.
  const unpromoted = firstUnpromotedCandidate(workspacePath, experiments);
  if (unpromoted) {
    // HyperAgents/DGM-style random-over-filtered parent selection.
    const parentGenid = pickParentGenid(workspacePath, config.random);
    const proposeOpts: ProposeOptions = {
      candidate: unpromoted,
      architectureSummary: config.architectureSummary,
      parentGenid,
    };
    const result = await runResearchPropose(workspacePath, callModel, proposeOpts);
    return {
      action: "propose",
      details: `proposed ${result.experiment.exp_id} (valid=${result.validation.valid})`,
      advanced_exp_id: result.experiment.exp_id,
    };
  }

  // Priority 4: discover — no candidate pending, no experiment in flight.
  const discoverOpts: DiscoverOptions = {
    feeds: config.feeds,
    keywords: config.keywords,
    architectureSummary: config.architectureSummary,
    candidateFloor: config.candidateFloor,
  };
  const d = await runResearchDiscover(
    workspacePath,
    { fetchUrl: config.fetchUrl, callModel },
    discoverOpts,
  );
  return {
    action: "discover",
    details: `scanned=${d.scanned} accepted=${d.accepted}`,
  };
}
