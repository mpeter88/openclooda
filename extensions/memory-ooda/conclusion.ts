/**
 * CR_OODA_HYPOTHESIS_DISCIPLINE — terminal close-out writer.
 *
 * When an experiment reaches a terminal state (rolled-out, concluded-dump,
 * rejected) we:
 *   1. Stamp a structured `Conclusion` into the ExperimentRecord.
 *   2. Append a close-out row to `.research-log.jsonl` referencing the
 *      original candidate id + H-id + verdict + one-line learning. The same
 *      discovery log now serves as the exit record — closes the loop.
 *
 * The close-out row shares fields with `ResearchCandidate` so existing
 * readers don't break. The distinguishing marker is `closeout: true`.
 */

import fs from "node:fs";
import path from "node:path";
import type { Conclusion } from "./hypothesis-schema.js";
import {
  canTransition,
  readExperimentRecord,
  researchLogPath,
  writeExperimentRecord,
  type ExperimentRecord,
  type ExperimentStage,
} from "./research-loop.js";

export interface CloseOutRow {
  closeout: true;
  exp_id: string;
  hypothesis_id: string;
  source_candidate_id: string;
  verdict: Conclusion["verdict"];
  learning: string;
  concluded_at: string;
  authored_by: Conclusion["authored_by"];
}

/**
 * Stamp a conclusion into the experiment record and append a close-out row to
 * the research log. Idempotent: calling twice with the same verdict will
 * overwrite the stored conclusion but append the log row again (append-only
 * by design — the log captures the full history).
 */
export function concludeExperiment(
  workspacePath: string,
  expId: string,
  conclusion: Omit<Conclusion, "concluded_at"> & Partial<Pick<Conclusion, "concluded_at">>,
): { record: ReturnType<typeof readExperimentRecord>; closeOut: CloseOutRow | null } {
  const record = readExperimentRecord(workspacePath, expId);
  if (!record) return { record: null, closeOut: null };

  const full: Conclusion = {
    ...conclusion,
    concluded_at: conclusion.concluded_at ?? new Date().toISOString(),
  };

  const updated = {
    ...record,
    conclusion: full,
    updated_at: new Date().toISOString(),
  };
  writeExperimentRecord(workspacePath, updated);

  const row: CloseOutRow = {
    closeout: true,
    exp_id: expId,
    hypothesis_id: record.hypothesis_obj?.id ?? "unknown",
    source_candidate_id: record.source.ref,
    verdict: full.verdict,
    learning: full.learning,
    concluded_at: full.concluded_at,
    authored_by: full.authored_by,
  };

  const logFile = researchLogPath(workspacePath);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, `${JSON.stringify(row)}\n`, "utf-8");

  return { record: updated, closeOut: row };
}

/**
 * Atomic conclude + transition (CR_OODA_HYPOTHESIS_DISCIPLINE_HARDENING #15
 * cleanup). Writes the conclusion AND the terminal stage in a single
 * writeExperimentRecord call, then appends the close-out row. Replaces the
 * two-call call sites in research-compare / research-refine that previously
 * left a tiny window where the conclusion was stamped but the status hadn't
 * yet transitioned.
 */
export function concludeAndTransition(
  workspacePath: string,
  expId: string,
  conclusion: Omit<Conclusion, "concluded_at"> & Partial<Pick<Conclusion, "concluded_at">>,
  terminalStage: ExperimentStage,
): { record: ExperimentRecord | null; closeOut: CloseOutRow | null } {
  const record = readExperimentRecord(workspacePath, expId);
  if (!record) return { record: null, closeOut: null };

  const full: Conclusion = {
    ...conclusion,
    concluded_at: conclusion.concluded_at ?? new Date().toISOString(),
  };
  const nextStatus = canTransition(record.status, terminalStage) ? terminalStage : record.status;
  const updated: ExperimentRecord = {
    ...record,
    status: nextStatus,
    conclusion: full,
    updated_at: new Date().toISOString(),
  };
  writeExperimentRecord(workspacePath, updated);

  const row: CloseOutRow = {
    closeout: true,
    exp_id: expId,
    hypothesis_id: record.hypothesis_obj?.id ?? "unknown",
    source_candidate_id: record.source.ref,
    verdict: full.verdict,
    learning: full.learning,
    concluded_at: full.concluded_at,
    authored_by: full.authored_by,
  };
  const logFile = researchLogPath(workspacePath);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, `${JSON.stringify(row)}\n`, "utf-8");

  return { record: updated, closeOut: row };
}

/** Filter a research-log array to just the close-out rows. */
export function readCloseOuts(workspacePath: string): CloseOutRow[] {
  const p = researchLogPath(workspacePath);
  if (!fs.existsSync(p)) return [];
  const out: CloseOutRow[] = [];
  for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed.closeout === true) out.push(parsed as unknown as CloseOutRow);
    } catch {
      // tolerate corrupt lines
    }
  }
  return out;
}
