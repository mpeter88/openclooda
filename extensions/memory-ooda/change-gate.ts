/**
 * CR_OODA_PASS_K_ACCEPTANCE_GATE — single choke point for every admissibility surface.
 *
 * Wraps runAdmissionGate + pass^k with per-ChangeKind floors and budgets,
 * emergency override support, and durable .gate-history.jsonl audit.
 *
 * Source: τ-bench pass^k (2406.12045) + DGM frozen-harness gate (2505.22954).
 */

import fs from "node:fs";
import path from "node:path";
import { runAdmissionGate, type AdmissionGateOptions } from "./admission-gate.js";
import type { AdmissionRunnable } from "./pass-k.js";
import type {
  AdmissionCase,
  ChangeKind,
  ChangeRequest,
  GateOutcome,
  PolicyProposal,
} from "./types.js";

const GATE_HISTORY = ".gate-history.jsonl";

export function gateHistoryPath(workspacePath: string): string {
  return path.join(workspacePath, GATE_HISTORY);
}

export interface GateHistoryRow extends GateOutcome {
  timestamp: string;
  kind: ChangeKind;
  changeId: string;
  summary: string;
}

export function appendGateHistory(workspacePath: string, row: GateHistoryRow): void {
  const file = gateHistoryPath(workspacePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + "\n", "utf-8");
}

export function readGateHistory(workspacePath: string): GateHistoryRow[] {
  const file = gateHistoryPath(workspacePath);
  if (!fs.existsSync(file)) return [];
  const out: GateHistoryRow[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as GateHistoryRow);
    } catch {
      // skip
    }
  }
  return out;
}

// ============================================================================
// Per-kind floors + override policy
// ============================================================================

interface KindPolicy {
  passRateFloor: number;
  k: number;
  overrideAllowed: boolean;
}

const DEFAULT_KIND_POLICIES: Record<ChangeKind, KindPolicy> = {
  policy_proposal: { passRateFloor: 0.6, k: 8, overrideAllowed: false },
  soul_md_edit: { passRateFloor: 0.7, k: 8, overrideAllowed: true },
  knowledge_edit: { passRateFloor: 0.7, k: 8, overrideAllowed: true },
  belief_promotion: { passRateFloor: 0.6, k: 4, overrideAllowed: false },
  archivist_prompt: { passRateFloor: 0.7, k: 8, overrideAllowed: true },
  council_mode: { passRateFloor: 0.5, k: 4, overrideAllowed: false },
  trajectory_calibration: { passRateFloor: 0.6, k: 8, overrideAllowed: false },
  archetype_change: { passRateFloor: 0.6, k: 4, overrideAllowed: false },
  rubric_change: { passRateFloor: 0.7, k: 8, overrideAllowed: false },
};

export function policyForKind(kind: ChangeKind, overrides?: Record<string, number>): KindPolicy {
  const base = DEFAULT_KIND_POLICIES[kind];
  if (overrides && overrides[kind] !== undefined) {
    return { ...base, passRateFloor: overrides[kind] };
  }
  return base;
}

// ============================================================================
// Override rate limit
// ============================================================================

const OVERRIDE_WINDOW_DAYS = 7;
const MAX_OVERRIDES_PER_WINDOW = 3;

export function isOverrideAllowed(
  workspacePath: string,
  approver: string,
  windowDays = OVERRIDE_WINDOW_DAYS,
  maxPerWindow = MAX_OVERRIDES_PER_WINDOW,
): { allowed: boolean; reason: string } {
  const history = readGateHistory(workspacePath);
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const recent = history.filter(
    (r) =>
      r.override === true && r.approver === approver && new Date(r.timestamp).getTime() >= cutoff,
  );
  if (recent.length >= maxPerWindow) {
    return {
      allowed: false,
      reason: `approver ${approver} used ${recent.length} overrides in the last ${windowDays}d (max ${maxPerWindow})`,
    };
  }
  return { allowed: true, reason: "within quota" };
}

// ============================================================================
// Main entry
// ============================================================================

export interface ChangeGateConfig extends AdmissionGateOptions {
  /** Per-kind floor overrides from PRIORITIES.json.thresholds.passk_by_kind. */
  kindFloorOverrides?: Record<string, number>;
  /** Approver allowlist. */
  overrideApprovers?: string[];
}

export async function runChangeGate(
  req: ChangeRequest,
  cases: AdmissionCase[],
  runnable: AdmissionRunnable,
  config: ChangeGateConfig = {},
  workspacePath?: string,
): Promise<GateOutcome> {
  const start = Date.now();
  const policy = policyForKind(req.kind, config.kindFloorOverrides);

  // Override path
  if (req.skipPassK) {
    if (!policy.overrideAllowed) {
      const outcome: GateOutcome = {
        admit: false,
        reason: `override not allowed for ${req.kind}`,
        ranCases: 0,
        duration_ms: Date.now() - start,
      };
      if (workspacePath) recordHistory(workspacePath, req, outcome);
      return outcome;
    }
    const approvers = config.overrideApprovers ?? [];
    if (!approvers.includes(req.skipPassK.approver)) {
      const outcome: GateOutcome = {
        admit: false,
        reason: `approver ${req.skipPassK.approver} not on allowlist`,
        ranCases: 0,
        duration_ms: Date.now() - start,
      };
      if (workspacePath) recordHistory(workspacePath, req, outcome);
      return outcome;
    }
    if (workspacePath) {
      const rate = isOverrideAllowed(workspacePath, req.skipPassK.approver);
      if (!rate.allowed) {
        const outcome: GateOutcome = {
          admit: false,
          reason: rate.reason,
          ranCases: 0,
          duration_ms: Date.now() - start,
        };
        recordHistory(workspacePath, req, outcome);
        return outcome;
      }
    }
    const outcome: GateOutcome = {
      admit: true,
      reason: `override granted by ${req.skipPassK.approver}: ${req.skipPassK.reason}`,
      ranCases: 0,
      duration_ms: Date.now() - start,
      override: true,
      approver: req.skipPassK.approver,
    };
    if (workspacePath) recordHistory(workspacePath, req, outcome);
    return outcome;
  }

  // Gated path — run admission gate
  const proposal: PolicyProposal = {
    id: req.id,
    timestamp: new Date().toISOString(),
    rule: req.kind,
    proposal: req.summary,
    reasoning: req.diff,
    evidence: [],
    status: "pending",
    category: "policy",
    confidence: 1.0,
    autoGenerated: req.initiator !== "user",
  };

  const report = await runAdmissionGate(proposal, cases, runnable, {
    ...config,
    passRateFloor: policy.passRateFloor,
    kValues: [1, Math.min(policy.k, 4), policy.k],
  });

  const outcome: GateOutcome = {
    admit: report.admit,
    reason: report.admitReason,
    passK:
      Object.keys(report.kPassRates).length > 0
        ? {
            kValues: Object.keys(report.kPassRates).map(Number),
            passRates: report.kPassRates,
            totalTrials: report.casesRun,
            trialsPerCase: policy.k,
            narrative: report.admitReason,
          }
        : undefined,
    ranCases: report.casesRun,
    duration_ms: Date.now() - start,
  };

  if (workspacePath) recordHistory(workspacePath, req, outcome);
  return outcome;
}

function recordHistory(workspacePath: string, req: ChangeRequest, outcome: GateOutcome): void {
  appendGateHistory(workspacePath, {
    ...outcome,
    timestamp: new Date().toISOString(),
    kind: req.kind,
    changeId: req.id,
    summary: req.summary,
  });
}
