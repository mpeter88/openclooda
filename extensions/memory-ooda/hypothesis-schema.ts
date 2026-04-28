/**
 * CR_OODA_HYPOTHESIS_DISCIPLINE — structured hypothesis schema.
 *
 * Every experiment must declare a falsifiable hypothesis linked to a product
 * roadmap epic. This module owns: the types, the H-NNN allocator, and simple
 * validators used by the propose stage.
 *
 * The allocator is file-based and transaction-safe: we read → increment →
 * write-then-rename so a crash between read and write can't produce two
 * experiments with the same H-id. (One tick = one propose = one allocation;
 * races are rare but we still guard against them.)
 */

import fs from "node:fs";
import path from "node:path";
import type { AdmissionCase } from "./types.js";

export const HYPOTHESIS_COUNTER_FILENAME = ".archive/hypothesis-counter.txt";
export const HYPOTHESIS_COUNTER_LOCK_FILENAME = ".archive/hypothesis-counter.lock";

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_POLL_INTERVAL_MS = 50;

// ============================================================================
// Types
// ============================================================================

export interface HypothesisSuccessMetric {
  fixture_tag: string; // H-fixture tag, e.g. "H-017-ambiguous"
  min_pass_rate: number; // 0..1 on H-specific fixtures
  min_delta_vs_parent: number; // mean_delta floor over regression corpus
}

export interface HypothesisFailureMetric {
  regression_forbidden_tags: string[]; // fail if any fixture with these tags regresses
  max_latency_delta_ms?: number; // optional latency guardrail
}

export interface Hypothesis {
  id: string; // "H-017" — workspace-sequential
  claim: string; // one-sentence testable statement
  prediction: string; // what we expect to observe
  success_metric: HypothesisSuccessMetric;
  failure_metric: HypothesisFailureMetric;
  scope_boundary: string[]; // mirrors ExperimentRecord.scope.allowed_paths
}

export type RoadmapLink =
  | {
      mode: "existing";
      horizon: "current" | "near" | "distant";
      epic: string; // existing epic id from ROADMAP.md
    }
  | {
      mode: "propose";
      horizon: "current" | "near" | "distant";
      epic_id: string; // slug proposed by the loop
      title: string;
      rationale: string;
    };

export interface ValueImpact {
  what_it_adds: string;
  why_now: string;
  roadmap_link: RoadmapLink;
  est_impact: number; // 0..1 subjective
  est_effort: number; // 0..1 subjective
}

export type RunVerdict = "pass" | "signal" | "fail" | "error";

export interface Run {
  run_id: string; // "H-017-R-001"
  started_at: string; // ISO
  ended_at?: string; // ISO
  hypothesis_pass_rate?: number; // 0..1 over H-specific fixtures
  regression_pass?: boolean;
  mean_delta?: number;
  verdict: RunVerdict;
  notes: string; // LLM- or operator-authored summary
  refine_action?: "refine_tests" | "refine_hypothesis_and_diff";
}

export interface HypothesisFixtures {
  fixtures: AdmissionCase[];
  rationale: string;
}

export interface Conclusion {
  verdict: "stage" | "dump" | "inconclusive";
  learning: string;
  authored_by: "system" | "human";
  concluded_at: string;
}

// ============================================================================
// H-NNN counter — transaction-safe
// ============================================================================

function counterPath(workspacePath: string): string {
  return path.join(workspacePath, HYPOTHESIS_COUNTER_FILENAME);
}

/** Read current counter; 0 if file absent or malformed. */
export function readHypothesisCounter(workspacePath: string): number {
  const p = counterPath(workspacePath);
  if (!fs.existsSync(p)) return 0;
  const raw = fs.readFileSync(p, "utf-8").trim();
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function lockPath(workspacePath: string): string {
  return path.join(workspacePath, HYPOTHESIS_COUNTER_LOCK_FILENAME);
}

/**
 * Acquire an exclusive file-lock on the counter via `wx` open. Spins until
 * acquired or LOCK_TIMEOUT_MS passes. Throws on timeout — caller should treat
 * timeout as "skip this allocation; next tick will retry". Stale locks (held
 * by a dead pid) eventually time out; we don't try to GC them here because
 * the read+write+rename window is sub-millisecond.
 */
function acquireCounterLock(workspacePath: string): number {
  const p = lockPath(workspacePath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      // wx = O_CREAT | O_EXCL — fails if file exists. atomic across processes.
      return fs.openSync(p, "wx");
    } catch (err) {
      lastErr = err;
      // EEXIST → another process holds the lock; spin briefly.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      // Tight sync sleep is fine here — counter ops are sub-ms; spin briefly.
      const until = Date.now() + LOCK_POLL_INTERVAL_MS;
      while (Date.now() < until) {
        /* spin */
      }
    }
  }
  throw new Error(`hypothesis counter lock timeout after ${LOCK_TIMEOUT_MS}ms: ${String(lastErr)}`);
}

function releaseCounterLock(workspacePath: string, fd: number): void {
  try {
    fs.closeSync(fd);
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(lockPath(workspacePath));
  } catch {
    /* lock already cleaned up */
  }
}

/**
 * Allocate the next hypothesis id and persist the counter. Write-then-rename
 * so a crash during write can't leave a torn file that would re-use an id.
 *
 * Finding 3 — guarded by an exclusive file-lock so concurrent processes
 * (gateway tick + CLI command) cannot both read N and both write N+1, which
 * would mint duplicate H-ids. Throws on lock-timeout so propose returns
 * unallocated and the next tick can retry.
 */
export function allocateHypothesisId(workspacePath: string): string {
  const p = counterPath(workspacePath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const fd = acquireCounterLock(workspacePath);
  try {
    const next = readHypothesisCounter(workspacePath) + 1;
    const tmp = `${p}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, String(next), "utf-8");
    fs.renameSync(tmp, p);
    return `H-${String(next).padStart(3, "0")}`;
  } finally {
    releaseCounterLock(workspacePath, fd);
  }
}

/** Zero-padded run id within a hypothesis. */
export function makeRunId(hypothesisId: string, runNumber: number): string {
  return `${hypothesisId}-R-${String(runNumber).padStart(3, "0")}`;
}

// ============================================================================
// Validators — defensive checks at the propose-stage boundary
// ============================================================================

export interface HypothesisValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateHypothesis(h: Hypothesis): HypothesisValidationResult {
  const errors: string[] = [];
  if (!h.id?.match(/^H-\d{3,}$/)) errors.push(`hypothesis.id malformed: ${h.id}`);
  if (!h.claim?.trim()) errors.push("hypothesis.claim required");
  if (!h.prediction?.trim()) errors.push("hypothesis.prediction required");
  const sm = h.success_metric;
  if (!sm?.fixture_tag?.trim()) errors.push("success_metric.fixture_tag required");
  if (typeof sm?.min_pass_rate !== "number" || sm.min_pass_rate < 0 || sm.min_pass_rate > 1) {
    errors.push("success_metric.min_pass_rate must be in [0,1]");
  }
  if (typeof sm?.min_delta_vs_parent !== "number") {
    errors.push("success_metric.min_delta_vs_parent required");
  }
  const fm = h.failure_metric;
  if (!Array.isArray(fm?.regression_forbidden_tags)) {
    errors.push("failure_metric.regression_forbidden_tags must be an array");
  }
  if (!Array.isArray(h.scope_boundary) || h.scope_boundary.length === 0) {
    errors.push("scope_boundary must be a non-empty array");
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Finding 5 — per-fixture shape validation. Run at the propose-stage boundary
 * so malformed fixtures fail fast (with a clear reason) rather than crashing
 * the sandbox stage when it tries to evaluate them.
 *
 * Required per fixture: id (non-empty), label, fixture (object), expected
 * (object with actionId/description/successSignal/failureSignal/domain),
 * priorOutcome ("success"|"failure"), capturedAt (ISO date), tags (array
 * containing the supplied fixture_tag).
 */
export function validateHypothesisFixtures(
  fixtures: unknown,
  fixture_tag: string,
): HypothesisValidationResult {
  const errors: string[] = [];
  if (!Array.isArray(fixtures) || fixtures.length === 0) {
    errors.push("fixtures must be a non-empty array");
    return { valid: false, errors };
  }
  for (let i = 0; i < fixtures.length; i++) {
    const fx = fixtures[i] as Record<string, unknown> | null | undefined;
    const tag = `fixtures[${i}]`;
    if (!fx || typeof fx !== "object" || Array.isArray(fx)) {
      errors.push(`${tag}: must be an object`);
      continue;
    }
    if (typeof fx.id !== "string" || fx.id.length === 0) {
      errors.push(`${tag}.id required (non-empty string)`);
    }
    if (typeof fx.label !== "string") {
      errors.push(`${tag}.label required (string)`);
    }
    if (!fx.fixture || typeof fx.fixture !== "object" || Array.isArray(fx.fixture)) {
      errors.push(`${tag}.fixture required (object)`);
    }
    const expected = fx.expected as Record<string, unknown> | undefined;
    if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
      errors.push(`${tag}.expected required (object)`);
    } else {
      for (const k of ["actionId", "description", "successSignal", "failureSignal", "domain"]) {
        if (typeof expected[k] !== "string") {
          errors.push(`${tag}.expected.${k} required (string)`);
        }
      }
    }
    if (fx.priorOutcome !== "success" && fx.priorOutcome !== "failure") {
      errors.push(`${tag}.priorOutcome must be "success" or "failure"`);
    }
    if (typeof fx.capturedAt !== "string" || Number.isNaN(new Date(fx.capturedAt).getTime())) {
      errors.push(`${tag}.capturedAt required (ISO timestamp)`);
    }
    if (!Array.isArray(fx.tags) || !fx.tags.includes(fixture_tag)) {
      errors.push(`${tag}.tags must include "${fixture_tag}"`);
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validateValueImpact(v: ValueImpact): HypothesisValidationResult {
  const errors: string[] = [];
  if (!v.what_it_adds?.trim()) errors.push("value.what_it_adds required");
  if (!v.why_now?.trim()) errors.push("value.why_now required");
  if (typeof v.est_impact !== "number" || v.est_impact < 0 || v.est_impact > 1) {
    errors.push("value.est_impact must be in [0,1]");
  }
  if (typeof v.est_effort !== "number" || v.est_effort < 0 || v.est_effort > 1) {
    errors.push("value.est_effort must be in [0,1]");
  }
  const rl = v.roadmap_link;
  if (!rl) {
    errors.push("value.roadmap_link required");
  } else if (rl.mode === "existing") {
    if (!rl.epic?.trim()) errors.push("roadmap_link.epic required in existing mode");
    if (!["current", "near", "distant"].includes(rl.horizon)) {
      errors.push("roadmap_link.horizon invalid");
    }
  } else if (rl.mode === "propose") {
    if (!rl.epic_id?.trim()) errors.push("roadmap_link.epic_id required in propose mode");
    if (!rl.title?.trim()) errors.push("roadmap_link.title required in propose mode");
    if (!rl.rationale?.trim()) errors.push("roadmap_link.rationale required in propose mode");
    if (!["current", "near", "distant"].includes(rl.horizon)) {
      errors.push("roadmap_link.horizon invalid");
    }
  } else {
    errors.push("roadmap_link.mode must be 'existing' or 'propose'");
  }
  return { valid: errors.length === 0, errors };
}
