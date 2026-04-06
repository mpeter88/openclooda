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
import fs from "node:fs";
import path from "node:path";
import {
  aggregateDomainOutcomes,
  inferDomain,
  type EpisodicEvent,
  type EpisodicStore,
} from "./archivist.js";
import { errorMessage, stripCodeFences } from "./parse-utils.js";
import { readSitrepLog, type SitrepLogEntry } from "./sitrep-log.js";
import type { ModelCallFn } from "./triage.js";
import type {
  ActualOutcome,
  CriticalFailureEvent,
  DomainEntry,
  DomainOutcomeStats,
  KnowledgeFile,
  PolicyProposal,
  PrioritiesFile,
} from "./types.js";

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

// ============================================================================
// M2: Weekly Analysis Passes
// ============================================================================

/** Result of Pass 1: per-domain outcome audit. */
export interface DomainAudit {
  domain: string;
  decisions: number;
  successRate: number;
  topFailureModes: Array<{ signal: string; count: number }>;
  recommendation: string;
}

/** Result of Pass 3: knowledge gap. */
export interface KnowledgeGap {
  domain: string;
  knowledgeEntries: number;
  recentEpisodicCount: number;
  recommendation: string;
}

/** Rejection reason grouped by frequency. */
export interface RejectionReasonGroup {
  reason: string;
  count: number;
  proposalIds: string[];
}

/** Result of Pass 4: proposal effectiveness. */
export interface ProposalEffectiveness {
  total: number;
  approved: number;
  rejected: number;
  pending: number;
  /** Approved proposals that had subsequent outcome data. */
  approvedWithOutcomeData: number;
  /** Rejected proposals grouped by rejection reason. */
  rejectionReasonGroups: RejectionReasonGroup[];
}

/** SITREP drift summary for a session or day. */
export interface SitrepDriftSummary {
  /** Date of the log entries */
  date: string;
  /** Total SITREP entries analyzed */
  entryCount: number;
  /** Priority range: [min, max] */
  priorityRange: [number, number];
  /** Average priority across entries */
  avgPriority: number;
  /** Number of entries with an attention directive */
  attentionCount: number;
  /** Distinct attention directives issued */
  attentionDirectives: string[];
}

/** Full weekly analysis result (M2 + M3). */
export interface WeeklyAnalysisResult {
  date: string;
  domainAudits: DomainAudit[];
  knowledgeGaps: KnowledgeGap[];
  proposalEffectiveness: ProposalEffectiveness;
  promptMutations: number;
  sitrepDrift: SitrepDriftSummary[];
  recommendedActions: string[];
  reportPath: string;
}

/**
 * Pass 1 — Outcome audit: per-domain success rates and failure modes.
 */
export function auditDomainOutcomes(events: EpisodicEvent[]): DomainAudit[] {
  const stats = aggregateDomainOutcomes(events);
  const audits: DomainAudit[] = [];

  for (const s of stats) {
    // Collect failure signals for this domain
    const domainEvents = events.filter(
      (e) => e.outcome === "failure" && inferDomain(e.text) === s.domain,
    );
    const signalCounts = new Map<string, number>();
    for (const e of domainEvents) {
      const sig = e.outcomeSignal ?? "unknown";
      signalCounts.set(sig, (signalCounts.get(sig) ?? 0) + 1);
    }
    const topFailureModes = [...signalCounts.entries()]
      .map(([signal, count]) => ({ signal, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);

    let recommendation: string;
    if (s.decisions < 3) {
      recommendation = "insufficient data";
    } else if (s.successRate >= 0.8) {
      recommendation = "no change";
    } else if (s.successRate >= 0.5) {
      recommendation = "monitor — moderate success rate";
    } else {
      recommendation = "review strategy — low success rate";
    }

    audits.push({
      domain: s.domain,
      decisions: s.decisions,
      successRate: s.successRate,
      topFailureModes,
      recommendation,
    });
  }

  return audits;
}

/**
 * Pass 3 — Knowledge gap detection: domains with < threshold KNOWLEDGE.json entries
 * but many episodic memories.
 */
export function detectKnowledgeGaps(
  knowledge: KnowledgeFile,
  events: EpisodicEvent[],
  minEntries: number = 3,
): KnowledgeGap[] {
  // Count episodic events per domain
  const domainEventCounts = new Map<string, number>();
  for (const e of events) {
    const domain = inferDomain(e.text);
    if (domain === "unknown") continue;
    domainEventCounts.set(domain, (domainEventCounts.get(domain) ?? 0) + 1);
  }

  // Count KNOWLEDGE.json entries per domain by scanning projects + domain_context + lessons_learned
  const domainKnowledgeCounts = new Map<string, number>();
  for (const [key] of Object.entries(knowledge.projects ?? {})) {
    const domain = inferDomain(key);
    if (domain !== "unknown") {
      domainKnowledgeCounts.set(domain, (domainKnowledgeCounts.get(domain) ?? 0) + 1);
    }
  }
  for (const [key] of Object.entries(knowledge.domain_context ?? {})) {
    const domain = inferDomain(key);
    if (domain !== "unknown") {
      domainKnowledgeCounts.set(domain, (domainKnowledgeCounts.get(domain) ?? 0) + 1);
    }
  }
  for (const [key] of Object.entries(knowledge.lessons_learned ?? {})) {
    const domain = inferDomain(key);
    if (domain !== "unknown") {
      domainKnowledgeCounts.set(domain, (domainKnowledgeCounts.get(domain) ?? 0) + 1);
    }
  }

  const gaps: KnowledgeGap[] = [];
  for (const [domain, episodicCount] of domainEventCounts) {
    const knowledgeCount = domainKnowledgeCounts.get(domain) ?? 0;
    if (knowledgeCount < minEntries && episodicCount >= minEntries) {
      gaps.push({
        domain,
        knowledgeEntries: knowledgeCount,
        recentEpisodicCount: episodicCount,
        recommendation: `Promote ${domain} episodic memories to KNOWLEDGE.json (${knowledgeCount} entries, ${episodicCount} recent memories)`,
      });
    }
  }

  return gaps.sort((a, b) => b.recentEpisodicCount - a.recentEpisodicCount);
}

/**
 * Pass 4 — Proposal effectiveness: analyze approval/rejection rates.
 */
export function analyzeProposalEffectiveness(proposals: PolicyProposal[]): ProposalEffectiveness {
  const approved = proposals.filter((p) => p.status === "approved").length;
  const rejected = proposals.filter((p) => p.status === "rejected").length;
  const pending = proposals.filter((p) => p.status === "pending").length;

  // Count approved proposals that have some outcome correlation
  // (presence of evidence array with 2+ items as a proxy)
  const approvedWithOutcomeData = proposals.filter(
    (p) => p.status === "approved" && p.evidence.length >= 2,
  ).length;

  // Group rejected proposals by rejection reason
  const reasonMap = new Map<string, string[]>();
  for (const p of proposals.filter((p) => p.status === "rejected")) {
    const reason = p.rejectionReason ?? "no reason given";
    const ids = reasonMap.get(reason) ?? [];
    ids.push(p.id);
    reasonMap.set(reason, ids);
  }
  const rejectionReasonGroups: RejectionReasonGroup[] = [...reasonMap.entries()]
    .map(([reason, proposalIds]) => ({ reason, count: proposalIds.length, proposalIds }))
    .sort((a, b) => b.count - a.count);

  return {
    total: proposals.length,
    approved,
    rejected,
    pending,
    approvedWithOutcomeData,
    rejectionReasonGroups,
  };
}

/**
 * Count prompt mutation events in episodic history.
 * Prompt mutations are structural events where write/edit touched memory-ooda/*.ts files.
 */
export function countPromptMutations(events: EpisodicEvent[]): number {
  return events.filter(
    (e) => e.category === "structural_event" && e.text.includes("prompt_mutation:"),
  ).length;
}

// ============================================================================
// S3: SITREP Drift Analysis
// ============================================================================

/**
 * Analyze SITREP log entries for a time window to detect priority drift
 * and attention directive patterns.
 */
export function analyzeSitrepDrift(
  workspacePath: string,
  windowDays: number,
): SitrepDriftSummary[] {
  const summaries: SitrepDriftSummary[] = [];
  const today = new Date();

  for (let i = 0; i < windowDays; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const entries = readSitrepLog(workspacePath, dateStr);

    if (entries.length === 0) continue;

    const priorities = entries.map((e) => e.priority);
    const minP = Math.min(...priorities);
    const maxP = Math.max(...priorities);
    const avgP = priorities.reduce((a, b) => a + b, 0) / priorities.length;

    const withAttention = entries.filter((e) => e.attention !== null);
    const directives = [...new Set(withAttention.map((e) => e.attention!))];

    summaries.push({
      date: dateStr,
      entryCount: entries.length,
      priorityRange: [minP, maxP],
      avgPriority: Math.round(avgP * 10) / 10,
      attentionCount: withAttention.length,
      attentionDirectives: directives,
    });
  }

  return summaries;
}

// ============================================================================
// M3: Report Generation
// ============================================================================

/**
 * Format a domain audit into markdown.
 */
function formatDomainAudit(audit: DomainAudit): string {
  const successPct = (audit.successRate * 100).toFixed(0);
  const lines = [
    `### ${audit.domain}`,
    ``,
    `- ${audit.decisions} decisions, ${successPct}% success rate`,
  ];
  if (audit.topFailureModes.length > 0) {
    const modes = audit.topFailureModes.map((m) => `${m.signal} (${m.count})`).join(", ");
    lines.push(`- Top failure modes: ${modes}`);
  }
  lines.push(`- Recommendation: ${audit.recommendation}`);
  return lines.join("\n");
}

/**
 * Generate the full meta-review markdown report (M3).
 */
export function generateReport(analysis: WeeklyAnalysisResult): string {
  const lines: string[] = [];

  lines.push(`# Meta-Review ${analysis.date}`);
  lines.push("");

  // Outcome Audit
  lines.push("## Outcome Audit");
  lines.push("");
  if (analysis.domainAudits.length === 0) {
    lines.push("No outcome data available.");
  } else {
    for (const audit of analysis.domainAudits) {
      lines.push(formatDomainAudit(audit));
      lines.push("");
    }
  }

  // Knowledge Gaps
  lines.push("## Knowledge Gaps");
  lines.push("");
  if (analysis.knowledgeGaps.length === 0) {
    lines.push("No significant knowledge gaps detected.");
  } else {
    for (const gap of analysis.knowledgeGaps) {
      lines.push(
        `- ${gap.domain}: ${gap.knowledgeEntries} KNOWLEDGE.json entries, ${gap.recentEpisodicCount} recent episodic memories — should promote`,
      );
    }
  }
  lines.push("");

  // Proposal Effectiveness
  lines.push("## Proposal Effectiveness");
  lines.push("");
  const pe = analysis.proposalEffectiveness;
  lines.push(
    `- ${pe.total} proposals total: ${pe.approved} approved, ${pe.rejected} rejected, ${pe.pending} pending`,
  );
  if (pe.approved > 0) {
    lines.push(
      `- ${pe.approvedWithOutcomeData}/${pe.approved} approved proposals have outcome correlation data`,
    );
  }
  if (pe.rejectionReasonGroups.length > 0) {
    lines.push("- Rejection reasons:");
    for (const group of pe.rejectionReasonGroups) {
      lines.push(`  - "${group.reason}" (${group.count}×)`);
    }
  } else if (pe.rejected > 0) {
    lines.push("- No rejection reasons recorded for rejected proposals");
  }
  lines.push("");

  // Prompt Mutations
  if (analysis.promptMutations > 0) {
    lines.push("## Prompt Mutations");
    lines.push("");
    lines.push(`- ${analysis.promptMutations} prompt mutation event(s) detected in review window`);
    lines.push("");
  }

  // SITREP Drift (S3)
  if (analysis.sitrepDrift.length > 0) {
    lines.push("## SITREP Drift Analysis");
    lines.push("");
    for (const day of analysis.sitrepDrift) {
      lines.push(
        `- **${day.date}**: ${day.entryCount} SITREPs, priority ${day.priorityRange[0]}-${day.priorityRange[1]} (avg ${day.avgPriority}), ${day.attentionCount} attention directive(s)`,
      );
      for (const dir of day.attentionDirectives) {
        lines.push(`  - "${dir}"`);
      }
    }
    lines.push("");
  }

  // Recommended Actions
  lines.push("## Recommended Actions");
  lines.push("");
  if (analysis.recommendedActions.length === 0) {
    lines.push("No actions recommended at this time.");
  } else {
    for (let i = 0; i < analysis.recommendedActions.length; i++) {
      lines.push(`${i + 1}. [ ] ${analysis.recommendedActions[i]}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

// ============================================================================
// M4: Convert Recommended Actions to Proposals
// ============================================================================

/**
 * Convert meta-review recommended actions into PolicyProposals.
 * Returns the number of proposals created.
 */
export function convertActionsToProposals(
  workspacePath: string,
  actions: string[],
  proposalStore: ProposalStore,
): PolicyProposal[] {
  const created: PolicyProposal[] = [];
  const now = new Date().toISOString();

  for (let i = 0; i < actions.length; i++) {
    const proposal = proposalStore.addProposal({
      id: `meta-review-${Date.now()}-${i}`,
      timestamp: now,
      rule: "meta_review",
      proposal: actions[i],
      reasoning: "Generated by weekly meta-review analysis",
      evidence: [`meta-review-${now}`],
      category: "workflow",
      confidence: 0.7,
      autoGenerated: true,
    });
    created.push(proposal);
  }

  return created;
}

// ============================================================================
// M1: Weekly Meta-Review Entry Point
// ============================================================================

/** Configuration for a weekly meta-review run. */
export interface WeeklyMetaReviewConfig {
  /** Days of episodic history to analyze. Default: 30 */
  windowDays: number;
  /** Minimum KNOWLEDGE.json entries before a domain is flagged as a gap. Default: 3 */
  minKnowledgeEntries: number;
  /** Whether to convert recommended actions to proposals. Default: false */
  createProposals: boolean;
}

const DEFAULT_WEEKLY_CONFIG: WeeklyMetaReviewConfig = {
  windowDays: 30,
  minKnowledgeEntries: 3,
  createProposals: false,
};

/**
 * Run the full weekly meta-review analysis (M1-M4).
 *
 * Inputs:
 * - Episodic events from the last N days (Tier 2)
 * - KNOWLEDGE.json current state
 * - Proposal history
 *
 * Outputs:
 * - `meta-review/YYYY-MM-DD.md` report
 * - Optionally converts actions to proposals (M4)
 */
export async function runWeeklyMetaReview(
  workspacePath: string,
  episodicStore: EpisodicStore,
  knowledge: KnowledgeFile,
  proposals: PolicyProposal[],
  proposalStore: ProposalStore | null,
  config?: Partial<WeeklyMetaReviewConfig>,
): Promise<WeeklyAnalysisResult> {
  const cfg = { ...DEFAULT_WEEKLY_CONFIG, ...config };
  const windowMs = cfg.windowDays * 24 * 60 * 60 * 1000;
  const sinceTimestamp = Date.now() - windowMs;
  const today = new Date().toISOString().slice(0, 10);

  // Retrieve episodic events from the window
  const events = await episodicStore.retrieveSince(sinceTimestamp, 10_000);

  // Pass 1: Outcome audit
  const domainAudits = auditDomainOutcomes(events);

  // Pass 3: Knowledge gaps
  const knowledgeGaps = detectKnowledgeGaps(knowledge, events, cfg.minKnowledgeEntries);

  // Pass 4: Proposal effectiveness
  const proposalEffectiveness = analyzeProposalEffectiveness(proposals);

  // M5: Count prompt mutations
  const promptMutations = countPromptMutations(events);

  // S3: SITREP drift analysis
  const sitrepDrift = analyzeSitrepDrift(workspacePath, cfg.windowDays);

  // Build recommended actions from analysis
  const recommendedActions: string[] = [];

  for (const gap of knowledgeGaps) {
    recommendedActions.push(gap.recommendation);
  }

  for (const audit of domainAudits) {
    if (audit.successRate < 0.5 && audit.decisions >= 5) {
      recommendedActions.push(
        `Review ${audit.domain} strategy — ${(audit.successRate * 100).toFixed(0)}% success rate across ${audit.decisions} decisions`,
      );
    }
  }

  if (promptMutations > 0) {
    recommendedActions.push(`Review ${promptMutations} prompt mutation(s) for outcome correlation`);
  }

  // S3: Flag SITREP drift patterns
  for (const day of sitrepDrift) {
    if (day.priorityRange[1] - day.priorityRange[0] >= 5 && day.entryCount >= 3) {
      recommendedActions.push(
        `SITREP priority swung ${day.priorityRange[0]}-${day.priorityRange[1]} on ${day.date} (${day.entryCount} entries) — review triage calibration`,
      );
    }
  }

  // Write report to meta-review/YYYY-MM-DD.md
  const reportDir = path.join(workspacePath, "meta-review");
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `${today}.md`);

  const result: WeeklyAnalysisResult = {
    date: today,
    domainAudits,
    knowledgeGaps,
    proposalEffectiveness,
    promptMutations,
    sitrepDrift,
    recommendedActions,
    reportPath,
  };

  const reportContent = generateReport(result);
  fs.writeFileSync(reportPath, reportContent, "utf-8");

  // M4: Optionally convert actions to proposals
  if (cfg.createProposals && proposalStore && recommendedActions.length > 0) {
    convertActionsToProposals(workspacePath, recommendedActions, proposalStore);
  }

  return result;
}
