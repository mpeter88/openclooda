/**
 * CR_OODA_RESEARCH_LOOP — Stage 2 (propose), with CR_OODA_HYPOTHESIS_DISCIPLINE
 * upgrades.
 *
 * Given a `ResearchCandidate` + the current archive lineage, the LLM drafts a
 * **structured** experiment:
 *   - proposal.md           — short CR-style description
 *   - hypothesis (object)   — falsifiable claim + success/failure metrics
 *   - value (object)        — what it adds / why now / roadmap link
 *   - hypothesis_fixtures   — admission cases that falsify the claim
 *   - diff.patch            — unified diff restricted to scope.allowed_paths
 *
 * Roadmap gate: every proposal must declare `value.roadmap_link`, either
 * referencing an existing epic (`mode: "existing"`) or proposing a new one
 * (`mode: "propose"`). An unknown existing epic rejects the proposal. A
 * propose-mode link queues a draft epic in `.proposed-epics.jsonl` and
 * transitions the experiment to `awaiting-epic-approval` — the operator must
 * accept or reject the epic before the experiment can advance.
 *
 * Scope enforcement is unchanged from the original CR_OODA_RESEARCH_LOOP:
 * the diff may only touch files in `scope.allowed_paths` and never the
 * denylist.
 */

import fs from "node:fs";
import path from "node:path";
import {
  allocateHypothesisId,
  makeRunId,
  validateHypothesis,
  validateValueImpact,
  type Hypothesis,
  type HypothesisFixtures,
  type Run,
  type ValueImpact,
} from "./hypothesis-schema.js";
import { stripCodeFences } from "./parse-utils.js";
import {
  experimentDir,
  writeExperimentRecord,
  type ExperimentRecord,
  type ExperimentScope,
  type ResearchCandidate,
} from "./research-loop.js";
import { appendProposedEpic, findEpic, listEpics } from "./roadmap.js";
import type { ModelCallFn } from "./triage.js";
import type { AdmissionCase } from "./types.js";

const DEFAULT_DENYLIST = [
  ".admission-cases/",
  ".agent-archive.jsonl",
  "openclaw.plugin.json",
  "ROADMAP.md", // operator-owned — experiments must not rewrite the roadmap
];

const MAX_FILES_DEFAULT = 3;
const MAX_RUNS_DEFAULT = 3;

// ============================================================================
// Prompt construction
// ============================================================================

function buildProposalPrompt(params: {
  candidate: ResearchCandidate;
  architectureSummary: string;
  parentGenid: string;
  existingEpicIds: string[];
  hint?: string;
}): string {
  const { candidate, architectureSummary, parentGenid, existingEpicIds, hint } = params;
  const epicList =
    existingEpicIds.length > 0 ? existingEpicIds.map((e) => `- ${e}`).join("\n") : "(none)";
  return `You are the openclooda research-proposal drafter. Every proposal
must carry a falsifiable hypothesis, an explicit value/impact rationale, a
linkage to the product roadmap, and one or more admission fixtures that
would falsify the hypothesis if it fails.

## Architecture summary
${architectureSummary}

## Candidate paper
Title: ${candidate.title ?? "(untitled)"}
Abstract: ${(candidate.abstract ?? "").slice(0, 1500)}
Relevance: ${candidate.relevance_score.toFixed(2)} — ${candidate.relevance_rationale ?? ""}

## Parent generation
${parentGenid}

## Existing roadmap epics (link to one, or propose a new one)
${epicList}

${hint ? `## Operator hint\n${hint}\n` : ""}
## Rules
- Touch at most ${MAX_FILES_DEFAULT} files.
- NEVER touch any file in the denylist: ${DEFAULT_DENYLIST.join(", ")}.
- Diff must be a valid unified diff (\`diff --git\` headers, \`---\`/\`+++\`, hunks with \`@@\`).
- Keep scope narrow: one experiment, one hypothesis, one falsifiable claim.
- The hypothesis.scope_boundary MUST equal the allowed_paths array.
- Hypothesis fixtures must be narrow admission cases: each has a unique id,
  a fixture body, an expected outcome, and at least one tag.
  Every fixture MUST include the tag \`${"${hypothesis.success_metric.fixture_tag}"}\` so
  the sandbox runner can select them.
- roadmap_link.mode must be either "existing" (and epic must be one of the
  ids listed above) or "propose" (and you must supply a fresh epic_id slug,
  a human-readable title, and a rationale explaining why no existing epic
  covers this direction).

## Output
Respond with raw JSON only (no markdown fences):
{
  "proposal_md": "<narrow CR-style description, ~200 words>",
  "hypothesis": {
    "claim": "<one-sentence testable statement>",
    "prediction": "<what we expect to observe>",
    "success_metric": {
      "fixture_tag": "<tag you will place on your hypothesis fixtures>",
      "min_pass_rate": 0.6,
      "min_delta_vs_parent": 0.05
    },
    "failure_metric": {
      "regression_forbidden_tags": ["critical"]
    }
  },
  "value": {
    "what_it_adds": "<one paragraph>",
    "why_now": "<one paragraph>",
    "roadmap_link": {
      "mode": "existing",
      "horizon": "current" | "near" | "distant",
      "epic": "<epic-id>"
    },
    "est_impact": 0.0,
    "est_effort": 0.0
  },
  "hypothesis_fixtures": {
    "fixtures": [
      {
        "id": "<fixture-id>",
        "label": "<short label>",
        "fixture": { "observation": "...", "knowledge": {}, "priorities": {} },
        "expected": { "actionId": "...", "description": "...",
                      "successSignal": "...", "failureSignal": "...",
                      "domain": "ops" },
        "priorOutcome": "success",
        "capturedAt": "<ISO>"
      }
    ],
    "rationale": "<why these fixtures falsify the claim>"
  },
  "allowed_paths": ["<path1>", "<path2>"],
  "diff": "<unified diff text>"
}`;
}

// ============================================================================
// Parsing + validation
// ============================================================================

export interface ProposalDraft {
  proposal_md: string;
  hypothesis: Omit<Hypothesis, "id" | "scope_boundary">;
  value: ValueImpact;
  hypothesis_fixtures: HypothesisFixtures;
  allowed_paths: string[];
  diff: string;
}

export function parseProposal(raw: string): ProposalDraft {
  const cleaned = stripCodeFences(raw);
  const parsed = JSON.parse(cleaned) as Record<string, unknown>;

  const proposal_md = typeof parsed.proposal_md === "string" ? parsed.proposal_md : "";
  const diff = typeof parsed.diff === "string" ? parsed.diff : "";
  const allowed_paths = Array.isArray(parsed.allowed_paths)
    ? (parsed.allowed_paths.filter((p) => typeof p === "string") as string[])
    : [];
  const hypothesis = parsed.hypothesis as Omit<Hypothesis, "id" | "scope_boundary">;
  const value = parsed.value as ValueImpact;
  const hypothesis_fixtures = parsed.hypothesis_fixtures as HypothesisFixtures;

  if (!proposal_md || !diff || allowed_paths.length === 0) {
    throw new Error("Proposal missing required fields (proposal_md/diff/allowed_paths)");
  }
  if (!hypothesis || typeof hypothesis !== "object") {
    throw new Error("Proposal missing hypothesis object");
  }
  if (!value || typeof value !== "object") {
    throw new Error("Proposal missing value object");
  }
  if (
    !hypothesis_fixtures ||
    !Array.isArray(hypothesis_fixtures.fixtures) ||
    hypothesis_fixtures.fixtures.length === 0
  ) {
    throw new Error("Proposal must include at least one hypothesis fixture");
  }

  // Finding 4 — fixture tag enforcement at write time. Every H-fixture must
  // carry the hypothesis's success_metric.fixture_tag in its tags array;
  // otherwise the sandbox's H-pass-rate would be computed over fixtures the
  // LLM never intended as hypothesis-specific. Reject the whole proposal
  // when any fixture is missing the tag — same posture as scope violations.
  const fixtureTag = hypothesis?.success_metric?.fixture_tag;
  if (typeof fixtureTag === "string" && fixtureTag.length > 0) {
    const missing: string[] = [];
    for (const fx of hypothesis_fixtures.fixtures) {
      const tags = (fx as { tags?: unknown }).tags;
      if (!Array.isArray(tags) || !tags.includes(fixtureTag)) {
        missing.push(String((fx as { id?: unknown }).id ?? "?"));
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `Hypothesis fixtures missing required tag "${fixtureTag}": ${missing.join(", ")}`,
      );
    }
  }

  return { proposal_md, hypothesis, value, hypothesis_fixtures, allowed_paths, diff };
}

/**
 * Extract the set of file paths touched by a unified diff. Looks at the
 * `diff --git a/<path> b/<path>` headers. Returns an empty set when no
 * headers are present (malformed diff).
 */
export function extractChangedPaths(diff: string): Set<string> {
  const out = new Set<string>();
  const re = /^diff --git a\/(\S+) b\/(\S+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(diff)) !== null) {
    if (m[1] === m[2]) out.add(m[1]);
    else {
      out.add(m[1]);
      out.add(m[2]);
    }
  }
  return out;
}

export interface ScopeValidation {
  valid: boolean;
  reason?: string;
  changedPaths: string[];
  outOfScope: string[];
  denyListHits: string[];
}

export function validateScope(diff: string, scope: ExperimentScope): ScopeValidation {
  const changed = [...extractChangedPaths(diff)];
  if (changed.length === 0) {
    return {
      valid: false,
      reason: "diff has no recognizable file headers",
      changedPaths: [],
      outOfScope: [],
      denyListHits: [],
    };
  }
  if (changed.length > scope.max_files) {
    return {
      valid: false,
      reason: `diff touches ${changed.length} files; max_files=${scope.max_files}`,
      changedPaths: changed,
      outOfScope: [],
      denyListHits: [],
    };
  }
  const outOfScope = changed.filter(
    (p) => !scope.allowed_paths.some((allowed) => p === allowed || p.startsWith(allowed)),
  );
  const denyListHits = changed.filter((p) =>
    scope.denylist_paths.some((deny) => p === deny || p.startsWith(deny)),
  );
  if (outOfScope.length > 0 || denyListHits.length > 0) {
    return {
      valid: false,
      reason:
        denyListHits.length > 0
          ? `diff touches denylisted paths: ${denyListHits.join(", ")}`
          : `diff touches out-of-scope paths: ${outOfScope.join(", ")}`,
      changedPaths: changed,
      outOfScope,
      denyListHits,
    };
  }
  return {
    valid: true,
    changedPaths: changed,
    outOfScope: [],
    denyListHits: [],
  };
}

// ============================================================================
// Main entry
// ============================================================================

export interface ProposeOptions {
  candidate: ResearchCandidate;
  architectureSummary: string;
  parentGenid: string;
  hint?: string;
  maxRetries?: number;
  extraDenylist?: string[];
  /** Override MAX_RUNS_DEFAULT for tests. */
  maxRuns?: number;
}

export interface ProposeResult {
  experiment: ExperimentRecord;
  validation: ScopeValidation;
  /** Errors from hypothesis/value schema validation, if any. */
  hypothesisErrors?: string[];
  /** True when a new epic was queued in .proposed-epics.jsonl. */
  epicProposed?: boolean;
}

export function makeExperimentId(candidate: ResearchCandidate): string {
  const slug = (candidate.id || candidate.title || "exp")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24);
  const stamp = new Date().toISOString().slice(0, 10);
  return `exp-${stamp}-${slug}`;
}

/**
 * Run stage 2. On success writes artefacts to `.experiments/{exp-id}/`:
 *   - proposal.md
 *   - scope.json
 *   - diff.patch
 *   - hypothesis-fixtures.jsonl
 *   - status.json (ExperimentRecord with structured hypothesis/value/runs)
 *
 * Resulting status:
 *   - "awaiting-epic-approval" when value.roadmap_link.mode === "propose"
 *   - "proposed" when existing-epic link is valid
 *   - "rejected" on parse failure, scope violation, or unknown existing epic
 */
export async function runResearchPropose(
  workspacePath: string,
  callModel: ModelCallFn,
  options: ProposeOptions,
): Promise<ProposeResult> {
  const maxRetries = options.maxRetries ?? 1;
  const maxRuns = options.maxRuns ?? MAX_RUNS_DEFAULT;
  const expId = makeExperimentId(options.candidate);
  const dir = experimentDir(workspacePath, expId);
  fs.mkdirSync(dir, { recursive: true });

  const existingEpicIds = listEpics(workspacePath).map((e) => e.id);

  const prompt = buildProposalPrompt({
    candidate: options.candidate,
    architectureSummary: options.architectureSummary,
    parentGenid: options.parentGenid,
    existingEpicIds,
    hint: options.hint,
  });

  let draft: ProposalDraft | null = null;
  let lastError = "";
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const raw = await callModel(prompt);
      draft = parseProposal(raw);
      break;
    } catch (err) {
      lastError = String(err).slice(0, 200);
    }
  }

  const now = new Date().toISOString();
  const denylist = [...DEFAULT_DENYLIST, ...(options.extraDenylist ?? [])];

  if (!draft) {
    const record: ExperimentRecord = {
      exp_id: expId,
      created_at: now,
      updated_at: now,
      status: "rejected",
      source: {
        kind: "paper",
        ref: options.candidate.id,
        citation: options.candidate.title,
      },
      parent_genid: options.parentGenid,
      scope: { allowed_paths: [], denylist_paths: denylist, max_files: MAX_FILES_DEFAULT },
      scores: {},
      notes: `proposal parse failed: ${lastError}`,
    };
    writeExperimentRecord(workspacePath, record);
    return {
      experiment: record,
      validation: {
        valid: false,
        reason: lastError,
        changedPaths: [],
        outOfScope: [],
        denyListHits: [],
      },
    };
  }

  // Build + validate the structured hypothesis.
  const hypothesisId = allocateHypothesisId(workspacePath);
  const fullHypothesis: Hypothesis = {
    id: hypothesisId,
    claim: draft.hypothesis.claim,
    prediction: draft.hypothesis.prediction,
    success_metric: draft.hypothesis.success_metric,
    failure_metric: draft.hypothesis.failure_metric,
    scope_boundary: draft.allowed_paths,
  };
  const hErrors = validateHypothesis(fullHypothesis);
  const vErrors = validateValueImpact(draft.value);

  // Scope validation.
  const scope: ExperimentScope = {
    allowed_paths: draft.allowed_paths,
    denylist_paths: denylist,
    max_files: MAX_FILES_DEFAULT,
  };
  const validation = validateScope(draft.diff, scope);

  // Epic-gate check. `existing` with unknown epic = hard reject. `propose`
  // triggers the awaiting-epic-approval state + queue write.
  const roadmapLink = draft.value?.roadmap_link;
  let epicProposed = false;
  let epicGateError = "";
  let initialStatus: ExperimentRecord["status"] = "proposed";
  if (vErrors.valid && hErrors.valid && validation.valid) {
    if (roadmapLink.mode === "existing") {
      if (!findEpic(workspacePath, roadmapLink.epic)) {
        epicGateError = `unknown roadmap epic "${roadmapLink.epic}"`;
        initialStatus = "rejected";
      }
    } else if (roadmapLink.mode === "propose") {
      appendProposedEpic(workspacePath, {
        epic_id: roadmapLink.epic_id,
        title: roadmapLink.title,
        rationale: roadmapLink.rationale,
        horizon: roadmapLink.horizon,
        proposed_by_hypothesis_id: hypothesisId,
        proposed_by_exp_id: expId,
      });
      epicProposed = true;
      initialStatus = "awaiting-epic-approval";
    }
  } else {
    initialStatus = "rejected";
  }

  // Persist artefacts regardless — rejected experiments keep their diff for audit.
  fs.writeFileSync(path.join(dir, "proposal.md"), draft.proposal_md + "\n", "utf-8");
  fs.writeFileSync(path.join(dir, "scope.json"), JSON.stringify(scope, null, 2) + "\n", "utf-8");
  fs.writeFileSync(path.join(dir, "diff.patch"), draft.diff, "utf-8");
  fs.writeFileSync(
    path.join(dir, "hypothesis-fixtures.jsonl"),
    draft.hypothesis_fixtures.fixtures.map((f) => JSON.stringify(f)).join("\n") + "\n",
    "utf-8",
  );

  // Seed initial run (R-001) with status=pending — sandbox stage will fill it in.
  const initialRun: Run = {
    run_id: makeRunId(hypothesisId, 1),
    started_at: now,
    verdict: "error", // placeholder until sandbox runs; real verdict written at compare.
    notes: "awaiting sandbox",
  };

  const notesParts: string[] = [];
  if (!hErrors.valid) notesParts.push(`hypothesis: ${hErrors.errors.join("; ")}`);
  if (!vErrors.valid) notesParts.push(`value: ${vErrors.errors.join("; ")}`);
  if (!validation.valid) notesParts.push(`scope: ${validation.reason}`);
  if (epicGateError) notesParts.push(`epic: ${epicGateError}`);

  const record: ExperimentRecord = {
    exp_id: expId,
    created_at: now,
    updated_at: now,
    status: initialStatus,
    source: {
      kind: "paper",
      ref: options.candidate.id,
      citation: options.candidate.title,
      ...(options.candidate.url ? { commit_hash: "" } : {}),
    },
    parent_genid: options.parentGenid,
    scope,
    hypothesis: draft.hypothesis.claim, // legacy free-text, retained
    hypothesis_obj: fullHypothesis,
    value: draft.value,
    runs: [initialRun],
    max_runs: maxRuns,
    scores: {},
    notes: notesParts.length > 0 ? notesParts.join(" | ") : undefined,
  };
  writeExperimentRecord(workspacePath, record);

  return {
    experiment: record,
    validation,
    hypothesisErrors:
      hErrors.errors.length > 0 || vErrors.errors.length > 0
        ? [...hErrors.errors, ...vErrors.errors]
        : undefined,
    epicProposed,
  };
}
