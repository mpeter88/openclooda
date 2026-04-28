/**
 * CR_OODA_RESEARCH_LOOP — Phase A scaffold.
 *
 * Types, state helpers, + DMN-compatible runner stub. Later phases implement
 * the five stages (discover/propose/sandbox/compare/rollout) on top of this
 * substrate. Phase A alone is enough to:
 *   - bind the experiment record shape to the archive lineage;
 *   - land the DMN `research_tick` work kind (default-off) with a safe stub;
 *   - keep smoke/CI honest so later phases can descend from a green baseline.
 *
 * All fs is pure (no LLM calls in this file). Stage bodies will live in
 * dedicated modules (research-discover.ts, research-propose.ts, etc.) once
 * written; this module only handles status round-trips + transition legality.
 */

import fs from "node:fs";
import path from "node:path";

// ============================================================================
// Types
// ============================================================================

export const RESEARCH_LOG_FILENAME = ".research-log.jsonl";
export const ROLLOUT_QUEUE_FILENAME = ".rollout-queue.jsonl";
export const EXPERIMENTS_DIR = ".experiments";

export type ExperimentStage =
  | "discovered"
  | "proposed"
  | "awaiting-epic-approval" // CR_OODA_HYPOTHESIS_DISCIPLINE
  | "sandboxed"
  | "compared"
  | "refining" // CR_OODA_HYPOTHESIS_DISCIPLINE
  | "rollout-proposed"
  | "rolled-out"
  | "concluded-dump" // CR_OODA_HYPOTHESIS_DISCIPLINE — terminal non-ship with learning
  | "rejected"
  | "superseded";

/**
 * Legal next stages from a given stage. Terminal: rejected, rolled-out,
 * superseded, concluded-dump.
 *
 * Epic-approval gate: a propose-mode roadmap link puts the experiment in
 * `awaiting-epic-approval`; operator accept → sandboxed; operator reject →
 * concluded-dump. Existing-mode roadmap links skip this stage.
 *
 * Refine loop: `compared` with a `signal` verdict transitions to `refining`,
 * which either revises tests or the diff and loops back to `sandboxed`.
 * `compared` with `pass` goes to `rollout-proposed`; `fail` to
 * `concluded-dump`.
 */
const TRANSITIONS: Record<ExperimentStage, ExperimentStage[]> = {
  discovered: ["proposed", "rejected"],
  proposed: ["awaiting-epic-approval", "sandboxed", "rejected"],
  "awaiting-epic-approval": ["sandboxed", "concluded-dump", "rejected"],
  sandboxed: ["compared", "rejected"],
  compared: ["rollout-proposed", "refining", "concluded-dump", "rejected"],
  refining: ["sandboxed", "concluded-dump", "rejected"],
  "rollout-proposed": ["rolled-out", "rejected", "superseded"],
  "rolled-out": [],
  "concluded-dump": [],
  rejected: [],
  superseded: [],
};

export function canTransition(from: ExperimentStage, to: ExperimentStage): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function isTerminal(stage: ExperimentStage): boolean {
  return (
    stage === "rolled-out" ||
    stage === "rejected" ||
    stage === "superseded" ||
    stage === "concluded-dump"
  );
}

export interface ResearchCandidate {
  id: string; // e.g. arxiv id or internal slug
  source: string; // arxiv | operator | github
  title?: string;
  abstract?: string;
  url?: string;
  discovered_at: string; // ISO
  relevance_score: number; // 0-1
  relevance_rationale?: string;
  promoted_to_experiment_id?: string;
}

export interface ExperimentScope {
  allowed_paths: string[];
  denylist_paths: string[];
  max_files: number;
}

export interface ExperimentResult {
  pass_rate_small: number | null;
  pass_rate_full: number | null;
  regressions: string[]; // admission case ids that flipped success→fail
  per_domain: Record<string, number>;
  p95_latency_ms: number | null;
  new_error_tags: number;
  stagedeval_frac_applied?: number;
}

export interface ExperimentRecord {
  exp_id: string;
  created_at: string;
  updated_at: string;
  status: ExperimentStage;
  source: {
    kind: "paper" | "operator" | "github";
    ref: string; // arxiv id, operator note, or repo url
    commit_hash?: string; // when kind=github
    citation?: string;
  };
  parent_genid: string; // agent-archive row this experiment descends from
  scope: ExperimentScope;
  /** @deprecated pre-hypothesis-discipline free-text; retained for back-compat. New records use `hypothesis_obj`. */
  hypothesis?: string;
  /**
   * Structured hypothesis (CR_OODA_HYPOTHESIS_DISCIPLINE). Optional to allow
   * back-compat with experiments created before the CR; the propose stage
   * emits it for all new experiments.
   */
  hypothesis_obj?: import("./hypothesis-schema.js").Hypothesis;
  value?: import("./hypothesis-schema.js").ValueImpact;
  /** Run history under this hypothesis. runs[i].run_id === H-NNN-R-NNN. */
  runs?: import("./hypothesis-schema.js").Run[];
  /** Hard cap on refine retries. Default 3 when set by propose. */
  max_runs?: number;
  conclusion?: import("./hypothesis-schema.js").Conclusion;
  scores: {
    baseline?: ExperimentResult;
    sandbox?: ExperimentResult;
    /** Per-run sandbox scores for the refine loop; keyed by run_id. */
    sandbox_by_run?: Record<string, ExperimentResult>;
    delta?: {
      mean: number;
      per_domain: Record<string, number>;
      had_regression: boolean;
    };
  };
  rollout?: {
    proposal_id: string; // PolicyProposal.id when stage 5 fires
    queued_at: string;
  };
  notes?: string;
}

// ============================================================================
// Paths + serialisation
// ============================================================================

export function researchLogPath(workspacePath: string): string {
  return path.join(workspacePath, RESEARCH_LOG_FILENAME);
}

export function rolloutQueuePath(workspacePath: string): string {
  return path.join(workspacePath, ROLLOUT_QUEUE_FILENAME);
}

export function experimentDir(workspacePath: string, expId: string): string {
  return path.join(workspacePath, EXPERIMENTS_DIR, expId);
}

export function experimentRecordPath(workspacePath: string, expId: string): string {
  return path.join(experimentDir(workspacePath, expId), "status.json");
}

// ============================================================================
// Research log (append-only discovery ledger)
// ============================================================================

export function appendCandidate(workspacePath: string, candidate: ResearchCandidate): void {
  const file = researchLogPath(workspacePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(candidate) + "\n", "utf-8");
}

export function readResearchLog(workspacePath: string): ResearchCandidate[] {
  const file = researchLogPath(workspacePath);
  if (!fs.existsSync(file)) return [];
  const out: ResearchCandidate[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      // Skip close-out rows written by conclusion.ts — they share the log
      // file but aren't candidates. Callers that want close-outs use
      // readCloseOuts() from conclusion.ts instead.
      if (parsed.closeout === true) continue;
      out.push(parsed as unknown as ResearchCandidate);
    } catch {
      // skip malformed
    }
  }
  return out;
}

// ============================================================================
// Experiment record R/W
// ============================================================================

export function writeExperimentRecord(workspacePath: string, record: ExperimentRecord): void {
  const dir = experimentDir(workspacePath, record.exp_id);
  fs.mkdirSync(dir, { recursive: true });
  const file = experimentRecordPath(workspacePath, record.exp_id);
  const tmp = file + ".tmp";
  const withUpdate = { ...record, updated_at: new Date().toISOString() };
  fs.writeFileSync(tmp, JSON.stringify(withUpdate, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, file);
}

export function readExperimentRecord(
  workspacePath: string,
  expId: string,
): ExperimentRecord | null {
  const file = experimentRecordPath(workspacePath, expId);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as ExperimentRecord;
  } catch {
    return null;
  }
}

export function listExperiments(workspacePath: string): ExperimentRecord[] {
  const dir = path.join(workspacePath, EXPERIMENTS_DIR);
  if (!fs.existsSync(dir)) return [];
  const out: ExperimentRecord[] = [];
  for (const entry of fs.readdirSync(dir)) {
    const r = readExperimentRecord(workspacePath, entry);
    if (r) out.push(r);
  }
  return out.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
}

/**
 * Transition an experiment's stage, validating legality. Returns the updated
 * record when the transition is legal, or null when rejected.
 */
export function transitionStage(
  workspacePath: string,
  expId: string,
  to: ExperimentStage,
  notes?: string,
): ExperimentRecord | null {
  const record = readExperimentRecord(workspacePath, expId);
  if (!record) return null;
  if (!canTransition(record.status, to)) return null;
  const updated: ExperimentRecord = {
    ...record,
    status: to,
    notes: notes ?? record.notes,
  };
  writeExperimentRecord(workspacePath, updated);
  return updated;
}

// ============================================================================
// Rollout queue
// ============================================================================

export function appendRolloutQueue(
  workspacePath: string,
  entry: { exp_id: string; proposal_id: string; queued_at: string; summary: string },
): void {
  const file = rolloutQueuePath(workspacePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf-8");
}

export function readRolloutQueue(
  workspacePath: string,
): Array<{ exp_id: string; proposal_id: string; queued_at: string; summary: string }> {
  const file = rolloutQueuePath(workspacePath);
  if (!fs.existsSync(file)) return [];
  const out: Array<{
    exp_id: string;
    proposal_id: string;
    queued_at: string;
    summary: string;
  }> = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // skip
    }
  }
  return out;
}

// ============================================================================
// DMN runner stub
//
// Phase A: logs a noop + returns. Phase B+ will dispatch stage work.
// ============================================================================

export interface ResearchTickOptions {
  enabled: boolean;
  maxCandidatesPerTick?: number;
}

export interface ResearchTickResult {
  advanced: number; // experiments whose stage advanced this tick
  discovered: number; // new candidates added
  skipped_reason?: string;
}

export async function runResearchTick(
  _workspacePath: string,
  _options: ResearchTickOptions,
): Promise<ResearchTickResult> {
  // Phase A: no-op. Wired into DMN so the code path exists + is reachable, but
  // the actual work is implemented in later-phase modules.
  return {
    advanced: 0,
    discovered: 0,
    skipped_reason:
      "research_loop phase A — runner stub; later phases will implement discovery + stage advancement",
  };
}
