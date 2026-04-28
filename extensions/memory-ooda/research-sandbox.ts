/**
 * CR_OODA_RESEARCH_LOOP — Stage 3 (sandbox).
 *
 * Applies an experiment's diff in an isolated workspace, runs the admission
 * corpus in staged form (small → full), and writes `sandbox-score.json`.
 *
 * The process-level isolation (`git worktree` / Docker) is injected via
 * `applyDiff` so tests can exercise the whole stage without touching real fs
 * or spawning child processes. In production the default `applyDiff` creates
 * a worktree under `.experiments/{exp-id}/worktree/` and `git apply`s the
 * diff; Docker variant lives in a follow-up phase.
 *
 * All LLM-backed work is injected via `AdmissionRunnable` — the sandbox
 * itself does not call an LLM; it only dispatches runnables and collects
 * scores. Admission cases are enumerated via the existing admission-gate
 * helpers so the evaluation set matches production.
 */

import fs from "node:fs";
import path from "node:path";
import { listAdmissionCases } from "./admission-gate.js";
import type { AdmissionRunnable } from "./pass-k.js";
import {
  experimentDir,
  writeExperimentRecord,
  type ExperimentRecord,
  type ExperimentResult,
} from "./research-loop.js";
import type { ActualOutcome, AdmissionCase } from "./types.js";

/**
 * Load the hypothesis-specific fixtures written alongside the experiment diff.
 * Returns `[]` when the file is absent or empty. These fixtures are run inside
 * the sandbox alongside the regression corpus; their pass rate is tracked
 * separately on the current Run so the verdict path can enforce the
 * hypothesis's success_metric.min_pass_rate.
 */
export function readHypothesisFixtures(workspacePath: string, expId: string): AdmissionCase[] {
  const file = path.join(experimentDir(workspacePath, expId), "hypothesis-fixtures.jsonl");
  if (!fs.existsSync(file)) return [];
  const out: AdmissionCase[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as AdmissionCase);
    } catch {
      /* tolerate corrupt lines */
    }
  }
  return out;
}

// ============================================================================
// Isolation interface — tests mock this
// ============================================================================

export interface SandboxIsolation {
  /** Sandbox handle — string path in the worktree variant; opaque in the mock. */
  handle: string;
  /** Cleanup (remove worktree, stop container). Best-effort; never throws. */
  cleanup: () => Promise<void>;
}

export interface IsolationDeps {
  /** Produces an isolated sandbox with the diff applied. Throws on apply failure. */
  applyDiff: (expId: string, diff: string) => Promise<SandboxIsolation>;
  /** Runs a single admission case inside the sandbox. */
  runCase: (iso: SandboxIsolation, fixture: AdmissionCase["fixture"]) => Promise<ActualOutcome>;
}

// ============================================================================
// Staged eval
// ============================================================================

export interface SandboxOptions {
  workspacePath: string;
  /** Admission corpus to evaluate against. Defaults to listAdmissionCases(workspace). */
  cases?: AdmissionCase[];
  /** Size of the staged subset run first. Default 5. */
  smallSubsetSize?: number;
  /** Pass rate on the small subset must meet this to expand to full. Default 0.4 (DGM). */
  expandThreshold?: number;
  /** Per-case timeout in ms. Default 15_000. */
  caseTimeoutMs?: number;
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

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("sandbox case timeout")), ms);
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

export async function evalCases(
  iso: SandboxIsolation,
  cases: AdmissionCase[],
  deps: IsolationDeps,
  caseTimeoutMs: number,
): Promise<{ passed: number; failed: string[]; regressions: string[] }> {
  const failed: string[] = [];
  const regressions: string[] = [];
  let passed = 0;
  for (const c of cases) {
    try {
      const outcome = await withTimeout(deps.runCase(iso, c.fixture), caseTimeoutMs);
      if (outcomeIsSuccess(outcome)) {
        passed++;
      } else {
        failed.push(c.id);
        if (c.priorOutcome === "success") regressions.push(c.id);
      }
    } catch {
      failed.push(c.id);
      if (c.priorOutcome === "success") regressions.push(c.id);
    }
  }
  return { passed, failed, regressions };
}

// ============================================================================
// Main entry
// ============================================================================

export interface SandboxResult {
  result: ExperimentResult;
  expanded_to_full: boolean;
}

export interface SandboxResultExtended extends SandboxResult {
  /** Pass rate on the hypothesis-specific fixtures alone (null when no H-fixtures loaded). */
  hypothesis_pass_rate: number | null;
  /** Number of hypothesis fixtures run. */
  hypothesis_fixtures_run: number;
}

export async function runResearchSandbox(
  expId: string,
  deps: IsolationDeps,
  options: SandboxOptions,
): Promise<SandboxResultExtended> {
  const smallSize = options.smallSubsetSize ?? 5;
  const threshold = options.expandThreshold ?? 0.4;
  const timeout = options.caseTimeoutMs ?? 15_000;
  const regressionCases = options.cases ?? listAdmissionCases(options.workspacePath);
  const hypothesisFixtures = readHypothesisFixtures(options.workspacePath, expId);

  // Load the diff we're going to apply.
  const dir = experimentDir(options.workspacePath, expId);
  const diffPath = path.join(dir, "diff.patch");
  if (!fs.existsSync(diffPath)) {
    throw new Error(`sandbox: diff.patch missing for ${expId}`);
  }
  const diff = fs.readFileSync(diffPath, "utf-8");

  // Partition the regression corpus into small + rest. HyperAgents/DGM-style
  // staged eval. Hypothesis fixtures are evaluated separately at the end so
  // their pass rate isn't diluted by the large regression corpus.
  const small = regressionCases.slice(0, Math.min(smallSize, regressionCases.length));
  const rest = regressionCases.slice(small.length);

  const iso = await deps.applyDiff(expId, diff);
  const tStart = Date.now();

  let smallStats = { passed: 0, failed: [] as string[], regressions: [] as string[] };
  let fullStats: { passed: number; failed: string[]; regressions: string[] } | null = null;
  let hypothesisStats: { passed: number; failed: string[]; regressions: string[] } = {
    passed: 0,
    failed: [],
    regressions: [],
  };
  let expanded = false;
  try {
    smallStats = await evalCases(iso, small, deps, timeout);
    const smallPassRate = small.length > 0 ? smallStats.passed / small.length : 0;
    if (smallPassRate >= threshold && rest.length > 0) {
      expanded = true;
      const restStats = await evalCases(iso, rest, deps, timeout);
      fullStats = {
        passed: smallStats.passed + restStats.passed,
        failed: [...smallStats.failed, ...restStats.failed],
        regressions: [...smallStats.regressions, ...restStats.regressions],
      };
    }
    // Always evaluate hypothesis fixtures (they're small + targeted). Skipping
    // them when the regression corpus fails small-subset would hide useful
    // signal from the refine-loop decision.
    if (hypothesisFixtures.length > 0) {
      hypothesisStats = await evalCases(iso, hypothesisFixtures, deps, timeout);
    }
  } finally {
    await iso.cleanup().catch(() => {
      /* best-effort */
    });
  }

  const durationMs = Date.now() - tStart;
  const totalRegressionCases = expanded ? small.length + rest.length : small.length;
  const regressionPassed = fullStats ? fullStats.passed : smallStats.passed;
  const result: ExperimentResult = {
    pass_rate_small: small.length > 0 ? smallStats.passed / small.length : null,
    pass_rate_full:
      expanded && totalRegressionCases > 0 ? regressionPassed / totalRegressionCases : null,
    regressions: (fullStats ?? smallStats).regressions,
    per_domain: {},
    p95_latency_ms: null,
    new_error_tags: 0,
    stagedeval_frac_applied: expanded
      ? undefined
      : small.length / Math.max(regressionCases.length, 1),
  };
  const hypothesis_pass_rate =
    hypothesisFixtures.length > 0 ? hypothesisStats.passed / hypothesisFixtures.length : null;

  // Persist sandbox-score.json + mutate the record status if provided.
  fs.writeFileSync(
    path.join(dir, "sandbox-score.json"),
    JSON.stringify(
      {
        result,
        expanded_to_full: expanded,
        durationMs,
        hypothesis_pass_rate,
        hypothesis_fixtures_run: hypothesisFixtures.length,
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );

  // Update experiment record: merge scores + transition to "sandboxed" from
  // either "proposed" (first run) or "sandboxed" (post-refine loopback). Also
  // stamp the hypothesis_pass_rate on the latest pending Run so the refine
  // loop can inspect it.
  const statusFile = path.join(dir, "status.json");
  if (fs.existsSync(statusFile)) {
    try {
      const record = JSON.parse(fs.readFileSync(statusFile, "utf-8")) as ExperimentRecord;
      if (record.status === "proposed" || record.status === "sandboxed") {
        record.status = "sandboxed";
        record.scores = {
          ...record.scores,
          sandbox: result,
          sandbox_by_run: {
            ...(record.scores.sandbox_by_run ?? {}),
          },
        };
        const runs = record.runs ?? [];
        if (runs.length > 0) {
          const lastIdx = runs.length - 1;
          const lastRun = runs[lastIdx];
          record.scores.sandbox_by_run![lastRun.run_id] = result;
          runs[lastIdx] = {
            ...lastRun,
            ended_at: new Date().toISOString(),
            hypothesis_pass_rate: hypothesis_pass_rate ?? undefined,
            regression_pass: result.regressions.length === 0,
          };
          record.runs = runs;
        }
        writeExperimentRecord(options.workspacePath, record);
      }
    } catch {
      // malformed — skip
    }
  }

  return {
    result,
    expanded_to_full: expanded,
    hypothesis_pass_rate,
    hypothesis_fixtures_run: hypothesisFixtures.length,
  };
}
