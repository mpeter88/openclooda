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

/**
 * Allocate the next hypothesis id and persist the counter. Write-then-rename
 * so a crash during write can't leave a torn file that would re-use an id.
 */
export function allocateHypothesisId(workspacePath: string): string {
  const p = counterPath(workspacePath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const next = readHypothesisCounter(workspacePath) + 1;
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, String(next), "utf-8");
  fs.renameSync(tmp, p);
  return `H-${String(next).padStart(3, "0")}`;
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
