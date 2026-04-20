/**
 * CR_OODA_PASS_K_ACCEPTANCE_GATE — in-plugin write gate (Path C).
 *
 * Thin wrapper around `runChangeGate` that supplies an admission corpus
 * (from `.admission-cases/`), a no-op runnable, and per-kind defaults. Intended
 * for every authoritative writer inside memory-ooda: archivist pattern apply,
 * belief form/promote, direct priorities edits, etc.
 *
 * Falls open when the admission corpus is below `minCasesForGate`, so brand-new
 * workspaces still work without a corpus. Once the corpus populates, the gate
 * becomes authoritative.
 */

import { listAdmissionCases } from "./admission-gate.js";
import { runChangeGate, type ChangeGateConfig } from "./change-gate.js";
import type { AdmissionRunnable } from "./pass-k.js";
import type { ActualOutcome, ChangeKind, ChangeRequest, GateOutcome } from "./types.js";

const FALL_OPEN_RUNNABLE: AdmissionRunnable = async (): Promise<ActualOutcome> => ({
  source: "inferred",
  confidence: 1,
  reasoning: "no runnable wired — admission gate falls open under min corpus floor",
});

export interface WriteGateRequest {
  kind: ChangeKind;
  id: string;
  summary: string;
  diff: string;
  workspacePath: string;
  initiator?: ChangeRequest["initiator"];
  /** Override runnable for cases where the caller can actually simulate the change. */
  runnable?: AdmissionRunnable;
  config?: ChangeGateConfig;
}

/**
 * Gate a mutation at the write-helper boundary. Returns a `GateOutcome` — callers
 * inspect `admit` and skip the write when false. On hard failure (malformed
 * corpus, unexpected exception) the helper admits to avoid blocking the plugin.
 */
export async function gateWrite(req: WriteGateRequest): Promise<GateOutcome> {
  const cases = listAdmissionCases(req.workspacePath);
  try {
    return await runChangeGate(
      {
        kind: req.kind,
        id: req.id,
        summary: req.summary,
        diff: req.diff,
        initiator: req.initiator ?? "archivist",
      },
      cases,
      req.runnable ?? FALL_OPEN_RUNNABLE,
      req.config ?? {},
      req.workspacePath,
    );
  } catch {
    return {
      admit: true,
      reason: "write_gate_error_fail_open",
      ranCases: 0,
      duration_ms: 0,
    };
  }
}
