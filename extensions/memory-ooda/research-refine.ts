/**
 * CR_OODA_HYPOTHESIS_DISCIPLINE — Stage 4.5 (refine).
 *
 * When `research-compare` produces a `signal` verdict (partial evidence — the
 * hypothesis fixtures moved the needle but not past the success floor, OR
 * the regression suite leaked) we don't conclude yet. We give the system one
 * more shot at it, up to `max_runs` retries.
 *
 * The refine tick has a single binary choice, driven by the LLM given the
 * last run's artefacts:
 *
 *   (a) refine_tests — the hypothesis fixtures were too loose. Generate new
 *       fixtures; keep the diff.
 *   (b) refine_hypothesis_and_diff — the claim was too strong OR the diff
 *       missed the mark. Tighten the hypothesis, emit a new diff.
 *
 * Output artefacts land at `.experiments/{exp-id}/runs/{R-NNN}/` so every
 * run's inputs are auditable.
 *
 * This module is state-pure: it reads the record, constructs the refine
 * prompt, calls the model, parses + validates the response, writes the new
 * run artefacts, appends a new Run to the record, and transitions the
 * record's status back to `sandboxed` so the next DMN tick picks it up.
 */

import fs from "node:fs";
import path from "node:path";
import { concludeAndTransition } from "./conclusion.js";
import { makeRunId, type HypothesisFixtures, type Run } from "./hypothesis-schema.js";
import { stripCodeFences } from "./parse-utils.js";
import {
  experimentDir,
  readExperimentRecord,
  writeExperimentRecord,
  type ExperimentRecord,
} from "./research-loop.js";
import { validateScope } from "./research-propose.js";
import type { ModelCallFn } from "./triage.js";

export interface RefineDraft {
  action: "refine_tests" | "refine_hypothesis_and_diff";
  rationale: string;
  new_fixtures?: HypothesisFixtures;
  new_claim?: string;
  new_prediction?: string;
  new_diff?: string;
}

// ============================================================================
// Prompt
// ============================================================================

function buildRefinePrompt(record: ExperimentRecord): string {
  const lastRun = record.runs?.[record.runs.length - 1];
  const h = record.hypothesis_obj;
  return `You are the openclooda refine-tick author. A hypothesis experiment
produced a "signal" verdict — partial evidence, but not enough to rollout.
Choose EXACTLY one of two refinement paths:

  (a) refine_tests — the hypothesis fixtures were too loose to detect the
      claim; keep the diff, generate tighter fixtures.
  (b) refine_hypothesis_and_diff — the claim was too strong or the diff was
      wrong; tighten the hypothesis + emit a new diff. Keep the same scope
      (${h?.scope_boundary.join(", ")}).

## Hypothesis
Id: ${h?.id}
Claim: ${h?.claim}
Prediction: ${h?.prediction}
Success metric: fixture_tag=${h?.success_metric.fixture_tag}
                min_pass_rate=${h?.success_metric.min_pass_rate}
                min_delta_vs_parent=${h?.success_metric.min_delta_vs_parent}
Failure metric: forbidden_tags=${(h?.failure_metric.regression_forbidden_tags ?? []).join(", ")}

## Last run
run_id: ${lastRun?.run_id}
verdict: ${lastRun?.verdict}
hypothesis_pass_rate: ${lastRun?.hypothesis_pass_rate ?? "n/a"}
regression_pass: ${lastRun?.regression_pass ?? "n/a"}
mean_delta: ${lastRun?.mean_delta ?? "n/a"}
notes: ${lastRun?.notes}

## Output
Respond with raw JSON only (no fences). ONE of these shapes:

Shape A (refine_tests):
{
  "action": "refine_tests",
  "rationale": "<why the old fixtures were too loose>",
  "new_fixtures": {
    "fixtures": [ /* AdmissionCase[] — same tag ${h?.success_metric.fixture_tag} */ ],
    "rationale": "<why these new fixtures falsify the claim tightly>"
  }
}

Shape B (refine_hypothesis_and_diff):
{
  "action": "refine_hypothesis_and_diff",
  "rationale": "<why the claim or diff needed revision>",
  "new_claim": "<one-sentence tightened claim>",
  "new_prediction": "<what we now expect to observe>",
  "new_diff": "<unified diff text, scope-constrained>"
}`;
}

export function parseRefineDraft(raw: string): RefineDraft {
  const cleaned = stripCodeFences(raw);
  const parsed = JSON.parse(cleaned) as Record<string, unknown>;
  const action = parsed.action;
  if (action !== "refine_tests" && action !== "refine_hypothesis_and_diff") {
    throw new Error(`refine: invalid action ${String(action)}`);
  }
  const rationale = typeof parsed.rationale === "string" ? parsed.rationale : "";
  if (action === "refine_tests") {
    const nf = parsed.new_fixtures as HypothesisFixtures | undefined;
    if (!nf || !Array.isArray(nf.fixtures) || nf.fixtures.length === 0) {
      throw new Error("refine_tests requires non-empty new_fixtures.fixtures");
    }
    return { action, rationale, new_fixtures: nf };
  }
  const new_claim = typeof parsed.new_claim === "string" ? parsed.new_claim : "";
  const new_prediction = typeof parsed.new_prediction === "string" ? parsed.new_prediction : "";
  const new_diff = typeof parsed.new_diff === "string" ? parsed.new_diff : "";
  if (!new_claim || !new_prediction || !new_diff) {
    throw new Error("refine_hypothesis_and_diff requires new_claim, new_prediction, new_diff");
  }
  return { action, rationale, new_claim, new_prediction, new_diff };
}

// ============================================================================
// Main entry
// ============================================================================

export interface RefineOptions {
  expId: string;
  /** Override MAX_RUNS_DEFAULT for tests. */
  maxRuns?: number;
}

export interface RefineResult {
  outcome: "refined" | "max_runs_reached" | "parse_error" | "scope_widened" | "not_applicable";
  nextRunId?: string;
  action?: RefineDraft["action"];
  reason?: string;
}

export async function runResearchRefine(
  workspacePath: string,
  callModel: ModelCallFn,
  options: RefineOptions,
): Promise<RefineResult> {
  const record = readExperimentRecord(workspacePath, options.expId);
  if (!record) {
    return { outcome: "not_applicable", reason: "record not found" };
  }
  if (record.status !== "refining") {
    return {
      outcome: "not_applicable",
      reason: `record status=${record.status}, not refining`,
    };
  }
  const runs = record.runs ?? [];
  const maxRuns = options.maxRuns ?? record.max_runs ?? 3;

  // Finding 9 — propose seeds R-001 with verdict="error" + no ended_at as a
  // placeholder. Sandbox always sets ended_at on real runs (even when verdict
  // stays "error"). So `verdict==="error" && !ended_at` is the unique
  // placeholder shape; everything else counts as a real attempt.
  const realRuns = runs.filter((r) => r.verdict !== "error" || r.ended_at);
  if (realRuns.length >= maxRuns) {
    const lastRun = runs[runs.length - 1];
    concludeAndTransition(
      workspacePath,
      options.expId,
      {
        verdict: "dump",
        learning: `max_runs=${maxRuns} reached without pass; last verdict=${lastRun.verdict}, notes=${lastRun.notes}`,
        authored_by: "system",
      },
      "concluded-dump",
    );
    return { outcome: "max_runs_reached", reason: `${realRuns.length}/${maxRuns}` };
  }

  let draft: RefineDraft | null = null;
  let parseError = "";
  try {
    const raw = await callModel(buildRefinePrompt(record));
    draft = parseRefineDraft(raw);
  } catch (err) {
    parseError = String(err).slice(0, 200);
  }
  if (!draft) {
    return { outcome: "parse_error", reason: parseError };
  }

  // Finding 2 — re-validate scope on refine_hypothesis_and_diff. Iterative
  // refinement must NOT silently widen the file set past the original
  // allowed_paths. On violation: conclude as dump with an explicit learning
  // note so the audit trail records why the experiment died.
  if (draft.action === "refine_hypothesis_and_diff" && draft.new_diff) {
    const scopeCheck = validateScope(draft.new_diff, record.scope);
    if (!scopeCheck.valid) {
      const reason = scopeCheck.reason ?? "scope violation";
      concludeAndTransition(
        workspacePath,
        options.expId,
        {
          verdict: "dump",
          learning: `refine widened scope: ${reason}`,
          authored_by: "system",
        },
        "concluded-dump",
      );
      return { outcome: "scope_widened", reason };
    }
  }

  const nextRunNumber = runs.length + 1;
  const hypothesisId = record.hypothesis_obj?.id ?? "H-unknown";
  const nextRunId = makeRunId(hypothesisId, nextRunNumber);
  const now = new Date().toISOString();

  const dir = experimentDir(workspacePath, options.expId);
  const runDir = path.join(dir, "runs", nextRunId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "refine.json"),
    JSON.stringify({ action: draft.action, rationale: draft.rationale }, null, 2),
    "utf-8",
  );

  // Update the record with the refinements.
  let updated: ExperimentRecord = { ...record };

  if (draft.action === "refine_tests" && draft.new_fixtures) {
    fs.writeFileSync(
      path.join(runDir, "hypothesis-fixtures.jsonl"),
      draft.new_fixtures.fixtures.map((f) => JSON.stringify(f)).join("\n") + "\n",
      "utf-8",
    );
    // Also overwrite the top-level hypothesis-fixtures.jsonl so the sandbox
    // stage (which reads the top-level file by convention) picks up the new
    // set on the next run.
    fs.writeFileSync(
      path.join(dir, "hypothesis-fixtures.jsonl"),
      draft.new_fixtures.fixtures.map((f) => JSON.stringify(f)).join("\n") + "\n",
      "utf-8",
    );
  } else if (
    draft.action === "refine_hypothesis_and_diff" &&
    draft.new_claim &&
    draft.new_prediction &&
    draft.new_diff
  ) {
    fs.writeFileSync(path.join(runDir, "diff.patch"), draft.new_diff, "utf-8");
    fs.writeFileSync(path.join(dir, "diff.patch"), draft.new_diff, "utf-8");
    if (updated.hypothesis_obj) {
      updated = {
        ...updated,
        hypothesis_obj: {
          ...updated.hypothesis_obj,
          claim: draft.new_claim,
          prediction: draft.new_prediction,
        },
        hypothesis: draft.new_claim,
      };
    }
  }

  const newRun: Run = {
    run_id: nextRunId,
    started_at: now,
    verdict: "error", // placeholder; sandbox will fill in.
    notes: `refined via ${draft.action}: ${draft.rationale.slice(0, 200)}`,
    refine_action: draft.action,
  };

  updated = {
    ...updated,
    runs: [...runs, newRun],
    updated_at: now,
    status: "sandboxed" as ExperimentRecord["status"], // transition back to rerun sandbox
  };
  writeExperimentRecord(workspacePath, updated);

  return { outcome: "refined", nextRunId, action: draft.action };
}
