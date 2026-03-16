/**
 * OODA Phase — Meta-Reviewer (Structural Refinement / Double-Loop Learning)
 *
 * Triggered by:
 *   1. `criticalFailure` events — immediate review
 *   2. Weekly cron (when `meta_reviewer_weekly_enabled` is true)
 *
 * Processes ExpectedOutcome + ActualOutcome pairs to:
 *   - Detect whether failures stem from rules (→ PolicyProposal)
 *   - Adjust domain weights in PRIORITIES.json
 *
 * The Meta-Reviewer NEVER writes to KNOWLEDGE.json or SOUL.md.
 * All policy changes require explicit user approval.
 *
 * Feature-flagged off by default.
 */

import { randomUUID } from "node:crypto";
import type {
  ActualOutcome,
  CriticalFailureEvent,
  DomainEntry,
  PolicyProposal,
  PrioritiesFile,
} from "../../../extensions/memory-ooda/types.js";
import { errorMessage, stripCodeFences } from "./parse-utils.js";
import type { ModelCallFn } from "./triage.js";

// ============================================================================
// Types
// ============================================================================

/** Abstraction over PRIORITIES.json operations for testability. */
export interface PrioritiesStore {
  getPriorities(): PrioritiesFile;
  updateDomainWeight(domain: string, newWeight: number, reason: string): void;
}

/** Abstraction over policy proposal storage for testability. */
export interface ProposalStore {
  addProposal(proposal: Omit<PolicyProposal, "status">): PolicyProposal;
}

export interface MetaReviewerInput {
  failures: CriticalFailureEvent[];
  priorities: PrioritiesFile;
}

export interface MetaReviewerResult {
  proposalsCreated: PolicyProposal[];
  weightsAdjusted: Array<{ domain: string; oldWeight: number; newWeight: number }>;
  fromFallback: boolean;
  /** Last error from model call attempts, if any. */
  lastError?: string;
}

// ============================================================================
// Weight Adjustment Logic
// ============================================================================

const MIN_OBSERVATIONS = 10;
const MAX_DELTA = 0.05;
const WEIGHT_FLOOR = 0.1;
const WEIGHT_CEILING = 1.0;

/**
 * Calculate the new weight for a domain based on approval/override counts.
 *
 * Formula: new_weight = clamp(current_weight * (1 + (approvals - overrides) * 0.05), 0.1, 1.0)
 *
 * Guardrails:
 * - Minimum 10 observations before any adjustment
 * - Maximum single adjustment: +/- 0.05
 * - Floor of 0.1, ceiling of 1.0
 */
export function calculateWeightAdjustment(domain: DomainEntry): {
  newWeight: number;
  shouldAdjust: boolean;
} {
  // Guard against NaN/negative counts from manually edited files
  if (
    !Number.isFinite(domain.approval_count) ||
    domain.approval_count < 0 ||
    !Number.isFinite(domain.override_count) ||
    domain.override_count < 0
  ) {
    return { newWeight: domain.weight, shouldAdjust: false };
  }

  const totalObservations = domain.approval_count + domain.override_count;

  if (totalObservations < MIN_OBSERVATIONS) {
    return { newWeight: domain.weight, shouldAdjust: false };
  }

  const signal = domain.approval_count - domain.override_count;
  const rawDelta = signal * 0.05;
  const clampedDelta = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, rawDelta));
  const rawWeight = domain.weight * (1 + clampedDelta);
  const newWeight = Math.max(WEIGHT_FLOOR, Math.min(WEIGHT_CEILING, rawWeight));

  // Round to avoid floating-point noise
  const rounded = Math.round(newWeight * 1000) / 1000;

  if (rounded === domain.weight) {
    return { newWeight: domain.weight, shouldAdjust: false };
  }

  return { newWeight: rounded, shouldAdjust: true };
}

/**
 * Process all domains and adjust weights where warranted.
 * Returns the list of adjustments made.
 */
export function adjustWeights(
  priorities: PrioritiesFile,
  store: PrioritiesStore,
): Array<{ domain: string; oldWeight: number; newWeight: number }> {
  const adjustments: Array<{ domain: string; oldWeight: number; newWeight: number }> = [];

  for (const [name, entry] of Object.entries(priorities.domains)) {
    const { newWeight, shouldAdjust } = calculateWeightAdjustment(entry);
    if (shouldAdjust) {
      const oldWeight = entry.weight;
      try {
        store.updateDomainWeight(
          name,
          newWeight,
          `Meta-reviewer auto-adjustment: ${entry.approval_count} approvals, ${entry.override_count} overrides`,
        );
        adjustments.push({ domain: name, oldWeight, newWeight });
      } catch {
        // Log and continue — don't let one domain block others
      }
    }
  }

  return adjustments;
}

// ============================================================================
// Critical Failure Classification
// ============================================================================

/**
 * Determine the severity of a critical failure.
 *
 * - "critical": tool_result failure or user override/correction
 * - "warning": user approval (logged but not escalated)
 */
export function classifyFailureSeverity(outcome: ActualOutcome): "warning" | "critical" {
  if (outcome.source === "tool_result") {
    return outcome.success ? "warning" : "critical";
  }
  if (outcome.source === "user_signal") {
    return outcome.signal === "approved" ? "warning" : "critical";
  }
  // inferred — v2, treat as warning
  return "warning";
}

/**
 * Determine whether a critical failure event should trigger
 * a policy review (model call).
 */
export function shouldTriggerPolicyReview(event: CriticalFailureEvent): boolean {
  return (
    event.severity === "critical" &&
    typeof event.implicated_rule === "string" &&
    event.implicated_rule.length > 0
  );
}

// ============================================================================
// Prompt Construction
// ============================================================================

function formatFailuresBlock(failures: CriticalFailureEvent[]): string {
  return failures
    .map((f, i) => {
      const expected = f.expectedOutcome;
      const actual = f.actualOutcome;
      let actualSummary: string;
      if (actual.source === "tool_result") {
        actualSummary = `tool_result: ${actual.toolName} ${actual.success ? "succeeded" : "failed"} — ${actual.summary}`;
      } else if (actual.source === "user_signal") {
        actualSummary = `user_signal: ${actual.signal} — ${actual.context}`;
      } else {
        actualSummary = `inferred: confidence=${actual.confidence} — ${actual.reasoning}`;
      }

      return [
        `${i + 1}. [${f.severity}] Action: ${f.actionId}`,
        `   Expected: ${expected.description} (success: ${expected.successSignal})`,
        `   Actual: ${actualSummary}`,
        `   Domain: ${expected.domain}`,
        f.implicated_rule ? `   Implicated rule: ${f.implicated_rule}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

export function buildPolicyReviewPrompt(failures: CriticalFailureEvent[]): string {
  const failuresBlock = formatFailuresBlock(failures);

  return `You are the Meta-Reviewer, a structural refinement agent for an AI assistant's policy framework.

Given a set of critical failure events where expected outcomes diverged from actual outcomes, determine whether any failures stem from policy rules that should be reconsidered.

## Critical Failure Events
${failuresBlock}

## What to Analyze
For each failure with an implicated rule:
1. Was the rule itself the cause of the failure, or was it an execution error?
2. If the rule caused the failure, what change would prevent recurrence?
3. Is there enough evidence (multiple failures) to justify a policy change?

Only propose changes for rules that have demonstrably caused failures across multiple events. Do not propose changes for one-off errors.

## Output Format
Respond with raw JSON only. Do not wrap in code fences or add any text outside the JSON.

[
  {
    "rule": "<the implicated rule identifier>",
    "proposal": "<specific suggested change to the rule>",
    "reasoning": "<why this change would prevent future failures>",
    "evidence": [<actionIds that support this proposal>]
  }
]

Return an empty array [] if no policy changes are warranted.

## Constraints
- Maximum 5 proposals per review
- Each proposal must cite at least 2 supporting failure events
- Never propose removing safety-critical rules (deletion, deployment, credential handling)
- Proposals should narrow scope or add exceptions, not remove rules entirely

Verify your JSON is syntactically valid before responding.`;
}

// ============================================================================
// Response Parsing
// ============================================================================

export interface RawProposal {
  rule: string;
  proposal: string;
  reasoning: string;
  evidence: string[];
}

export function parseProposals(raw: string): RawProposal[] {
  const cleaned = stripCodeFences(raw);
  const parsed = JSON.parse(cleaned);

  if (!Array.isArray(parsed)) {
    throw new Error("Meta-reviewer response must be a JSON array");
  }

  if (parsed.length > 5) {
    throw new Error(`Too many proposals: ${parsed.length} (max 5)`);
  }

  if (parsed.length === 0) {
    return [];
  }

  return parsed.map((item: unknown, idx: number) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`Proposal[${idx}] must be an object`);
    }

    const obj = item as Record<string, unknown>;

    if (typeof obj.rule !== "string" || obj.rule.length === 0) {
      throw new Error(`Proposal[${idx}] must have a non-empty rule`);
    }
    if (typeof obj.proposal !== "string" || obj.proposal.length === 0) {
      throw new Error(`Proposal[${idx}] must have a non-empty proposal`);
    }
    if (typeof obj.reasoning !== "string" || obj.reasoning.length === 0) {
      throw new Error(`Proposal[${idx}] must have non-empty reasoning`);
    }
    if (!Array.isArray(obj.evidence) || obj.evidence.length === 0) {
      throw new Error(`Proposal[${idx}] must have non-empty evidence array`);
    }

    return {
      rule: obj.rule,
      proposal: obj.proposal,
      reasoning: obj.reasoning,
      evidence: obj.evidence.filter((e: unknown) => typeof e === "string"),
    };
  });
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Run the Meta-Reviewer on a batch of critical failure events.
 *
 * 1. Filter failures that implicate rules → call model for policy review.
 * 2. Parse model response into proposals → store via ProposalStore.
 * 3. Adjust domain weights based on approval/override counts.
 *
 * On model failure, falls back with no proposals but still adjusts weights.
 */
export async function runMetaReviewer(
  input: MetaReviewerInput,
  prioritiesStore: PrioritiesStore,
  proposalStore: ProposalStore,
  callModel: ModelCallFn,
  options?: { maxRetries?: number },
): Promise<MetaReviewerResult> {
  const maxRetries = options?.maxRetries ?? 1;

  // Step 1: Policy review for failures with implicated rules
  const reviewable = input.failures.filter(shouldTriggerPolicyReview);
  let proposalsCreated: PolicyProposal[] = [];
  let fromFallback = false;
  let lastError: unknown;

  if (reviewable.length > 0) {
    const prompt = buildPolicyReviewPrompt(reviewable);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const raw = await callModel(prompt);
        const rawProposals = parseProposals(raw);

        for (const rp of rawProposals) {
          const proposal = proposalStore.addProposal({
            id: `proposal-${randomUUID().slice(0, 8)}`,
            timestamp: new Date().toISOString(),
            rule: rp.rule,
            proposal: rp.proposal,
            reasoning: rp.reasoning,
            evidence: rp.evidence,
          });
          proposalsCreated.push(proposal);
        }

        lastError = undefined;
        break;
      } catch (err) {
        lastError = err;
        if (attempt === maxRetries) {
          fromFallback = true;
        }
      }
    }
  }

  // Step 2: Adjust domain weights (independent of model call)
  const weightsAdjusted = adjustWeights(input.priorities, prioritiesStore);

  return {
    proposalsCreated,
    weightsAdjusted,
    fromFallback,
    lastError: lastError ? errorMessage(lastError) : undefined,
  };
}
