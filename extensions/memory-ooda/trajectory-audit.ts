/**
 * CR_OODA_TRAJECTORY_AWARE_TRIAGE_V2 — audit log + lift evaluator.
 *
 * `.trajectory-audit.jsonl` — one row per triage call.
 * Shadow-mode rows + single_path_escalation rows form the control group.
 * Live-mode rows are the treatment group. The evaluator computes per-quadrant
 * lift of scaled-priority vs matched-raw-priority controls.
 */

import fs from "node:fs";
import path from "node:path";
import type { EpisodicEvent } from "./archivist.js";
import type { TrajectoryAuditRow, TrajectoryScalingConfig } from "./types.js";

const AUDIT_FILENAME = ".trajectory-audit.jsonl";
const AUDIT_MAX_BYTES = 50 * 1024 * 1024; // 50 MB rotation

export function auditPath(workspacePath: string): string {
  return path.join(workspacePath, AUDIT_FILENAME);
}

export function appendTrajectoryAudit(workspacePath: string, row: TrajectoryAuditRow): void {
  const file = auditPath(workspacePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  // Rotation: if file exceeds cap, move to .1 and start fresh.
  try {
    const stat = fs.statSync(file);
    if (stat.size > AUDIT_MAX_BYTES) {
      const rotated = file + ".1";
      if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
      fs.renameSync(file, rotated);
    }
  } catch {
    // File does not exist yet — no rotation needed.
  }

  fs.appendFileSync(file, JSON.stringify(row) + "\n", "utf-8");
}

export function readTrajectoryAudit(workspacePath: string): TrajectoryAuditRow[] {
  const file = auditPath(workspacePath);
  if (!fs.existsSync(file)) return [];
  const content = fs.readFileSync(file, "utf-8");
  const rows: TrajectoryAuditRow[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed) as TrajectoryAuditRow);
    } catch {
      // skip malformed lines
    }
  }
  return rows;
}

// ============================================================================
// Lift evaluator (matched-control)
// ============================================================================

export interface TrajectoryEvalReport {
  window: { days: number; rows: number };
  byQuadrant: Record<
    string,
    {
      rows: number;
      scaledSuccessRate: number;
      matchedBaselineSuccessRate: number;
      lift: number;
    }
  >;
  verdict: "adopt_live" | "keep_shadow" | "revert_off";
  reason: string;
}

/**
 * Compute per-quadrant lift of trajectory scaling vs matched-priority controls.
 *
 * Treatment = rows with mode="live" that have an associated actionId linked to
 * a subsequent episodic event with an outcome label.
 *
 * Control = rows with mode="shadow" (or where scaledPriority === rawPriority)
 * whose rawPriority equals the treatment row's scaledPriority.
 */
export function evaluateTrajectoryScaling(
  auditRows: TrajectoryAuditRow[],
  episodicEvents: EpisodicEvent[],
  config: TrajectoryScalingConfig,
  windowDays = 30,
): TrajectoryEvalReport {
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const recent = auditRows.filter((r) => r.timestamp >= cutoff);

  const outcomeByActionId = new Map<string, "success" | "failure" | "partial">();
  for (const e of episodicEvents) {
    if (e.actionId && e.outcome) outcomeByActionId.set(e.actionId, e.outcome);
  }

  const quadrants: TrajectoryEvalReport["byQuadrant"] = {};

  for (const quadrant of ["pos_pos", "pos_neg", "neg_pos", "neg_neg"] as const) {
    const treatment = recent.filter((r) => r.mode === "live" && r.quadrant === quadrant);
    const treated = treatment.filter((r) => r.actionId && outcomeByActionId.has(r.actionId));

    // Controls: matched by scaledPriority (treatment) = rawPriority (control).
    const treatmentPriorities = new Set(treatment.map((r) => r.scaledPriority));
    const controls = recent.filter(
      (r) =>
        (r.mode === "shadow" || r.scaledPriority === r.rawPriority) &&
        r.actionId &&
        outcomeByActionId.has(r.actionId) &&
        treatmentPriorities.has(r.rawPriority),
    );

    const treatedSuccessRate =
      treated.length > 0
        ? treated.filter((r) => outcomeByActionId.get(r.actionId!) === "success").length /
          treated.length
        : 0;
    const controlSuccessRate =
      controls.length > 0
        ? controls.filter((r) => outcomeByActionId.get(r.actionId!) === "success").length /
          controls.length
        : 0;

    quadrants[quadrant] = {
      rows: treatment.length,
      scaledSuccessRate: treatedSuccessRate,
      matchedBaselineSuccessRate: controlSuccessRate,
      lift: treatedSuccessRate - controlSuccessRate,
    };
  }

  const totalRows = recent.length;
  const totalTreatmentRows = Object.values(quadrants).reduce((acc, q) => acc + q.rows, 0);
  const anyNegative = Object.values(quadrants).some((q) => q.rows >= 50 && q.lift < 0);
  const anyAtMinSample = Object.values(quadrants).some((q) => q.rows >= 50);
  const allAtMinSample = Object.values(quadrants).every((q) => q.rows === 0 || q.rows >= 50);
  const allLiftPositive = Object.values(quadrants).every((q) => q.rows === 0 || q.lift > 0.05);
  const aggregateLift =
    Object.values(quadrants).reduce((acc, q) => acc + q.lift * q.rows, 0) /
    Math.max(1, totalTreatmentRows);

  let verdict: TrajectoryEvalReport["verdict"];
  let reason: string;

  void config; // verdict computed from rows, not config

  if (totalRows >= 200 && aggregateLift < 0) {
    verdict = "revert_off";
    reason = `Aggregate lift ${aggregateLift.toFixed(3)} < 0 over ${totalRows} rows`;
  } else if (!anyAtMinSample) {
    verdict = "keep_shadow";
    reason = "No quadrant has >=50 rows — insufficient signal to justify live";
  } else if (anyNegative) {
    verdict = "keep_shadow";
    reason = "At least one quadrant with negative lift at >=50 rows";
  } else if (allAtMinSample && allLiftPositive) {
    verdict = "adopt_live";
    reason = "All non-empty quadrants show lift > 0.05 at >=50 rows";
  } else {
    verdict = "keep_shadow";
    reason = "Insufficient matched-control rows to justify live mode";
  }

  return {
    window: { days: windowDays, rows: totalRows },
    byQuadrant: quadrants,
    verdict,
    reason,
  };
}
