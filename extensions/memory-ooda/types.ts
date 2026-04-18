/**
 * Canonical OODA type definitions.
 *
 * These interfaces are the source of truth for KNOWLEDGE.json, PRIORITIES.json,
 * and all OODA reasoning chain data structures.
 */

// ============================================================================
// Tier 3 — Semantic Memory (KNOWLEDGE.json)
// ============================================================================

export interface KnowledgeFile {
  _meta: {
    version: number;
    updated_at: string;
    updated_by: "archivist" | "user";
    turn_count_at_last_update: number;
    description: string;
  };
  identity: {
    name: string;
    timezone: string;
    location_primary: string;
    language_primary: string;
    communication_style: string;
  };
  stack: Record<string, string>;
  projects: Record<
    string,
    {
      status: "active" | "paused" | "complete";
      priority_domain: string;
      key_constraint: string;
      notes: string;
    }
  >;
  people: Record<
    string,
    {
      role: string;
      relationship: string;
      communication_preference: string;
      notes: string;
    }
  >;
  preferences: {
    always_ask_before: string[];
    never_do: string[];
    prefers_async_over_sync: boolean;
    prefers_delegation_over_diy: boolean;
    response_length: "concise" | "detailed" | "adaptive";
    notes: string;
  };
  commitments: Array<{
    label: string;
    recurrence: "daily" | "weekly" | "biweekly" | "monthly";
    day?: string;
    time: string;
    timezone: string;
    blocking: boolean;
  }>;
  domain_context: Record<string, string>;
  /** Distilled lessons from past sessions. Key: short label (snake_case).
   *  Value: 1-2 sentence actionable lesson. Written by the Archivist. */
  lessons_learned: Record<string, string>;
  _archivist_log: Array<{
    timestamp: string;
    action: string;
    reason: string;
  }>;
}

// ============================================================================
// PRIORITIES.json
// ============================================================================

export interface DomainEntry {
  weight: number; // 0.1 – 1.0
  description: string;
  examples: string[];
  approval_count: number;
  override_count: number;
}

export interface ScoringAxis {
  weight: number;
  description: string;
}

export interface PrioritiesFile {
  _meta: {
    version: number;
    updated_at: string;
    updated_by: "user" | "meta_reviewer";
    description: string;
  };
  domains: Record<string, DomainEntry>;
  strategy_labels: Array<{
    label: string;
    description: string;
  }>;
  scoring_rubric: {
    alignment: ScoringAxis;
    efficiency: ScoringAxis;
    risk: ScoringAxis;
  };
  thresholds: {
    min_priority_for_full_ooda: number;
    min_thinking_level_for_full_ooda: "low" | "medium" | "high";
    critical_failure_score_floor: number;
    archivist_turn_interval: number;
    /** @deprecated Use meta_reviewer_archivist_interval instead */
    meta_reviewer_weekly_enabled: boolean;
    /** Run meta-reviewer after this many archivist completions (0 = disabled). Default: 5 */
    meta_reviewer_archivist_interval: number;
    council_priority_threshold: number;
    council_system1_enabled: boolean;
    council_system2_enabled: boolean;
    /** Trajectory-aware triage scaling config. */
    trajectory_scaling?: TrajectoryScalingConfig;
  };
  _weight_adjustment_log: Array<{
    timestamp: string;
    domain: string;
    old_weight: number;
    new_weight: number;
    reason: string;
  }>;
}

// ============================================================================
// Trajectory Scaling
// ============================================================================

export interface TrajectoryScalingConfig {
  enabled: boolean; // default: true
  /** Scale when cumulative positive, current signal positive. Default: 0.9 */
  pos_pos_scale: number;
  /** Scale when cumulative positive, current signal negative. Default: 0.7 */
  pos_neg_scale: number;
  /** Scale when cumulative negative, current signal positive. Default: 0.8 */
  neg_pos_scale: number;
  /** Scale when cumulative negative, current signal negative. Default: 1.3 */
  neg_neg_scale: number;
  /** Days of outcome history to compute trajectory. Default: 30 */
  trajectory_window_days: number;
  /** Minimum outcomes needed before trajectory is computed. Default: 3 */
  min_outcomes_for_trajectory: number;
}

// ============================================================================
// OODA Reasoning Chain
// ============================================================================

export interface SITREP {
  priority: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
  /** Priority before trajectory scaling (for debugging/logging). */
  rawPriority?: number;
  summary: string;
  conflictsDetected: string[];
  relevantFacts: string[];
  recommendedDomains: string[];
  /** Single imperative sentence (≤15 words) directing the executive on
   *  what to emphasize or watch for this turn.
   *  Only present when priority >= 6. */
  attention?: string;
}

export interface CouncilTrace {
  mode: "system1" | "system2";
  members: Array<{ role: string; output: string }>;
  chairReasoning: string;
  dissent: boolean;
}

export interface Strategy {
  label: string;
  reasoning: string;
  alignmentScore: number;
  efficiencyScore: number;
  riskScore: number;
  weightedTotal: number;
  councilTrace?: CouncilTrace;
}

export interface ExpectedOutcome {
  actionId: string;
  description: string;
  successSignal: string;
  failureSignal: string;
  domain: string;
}

export type ActualOutcome =
  | { source: "tool_result"; success: boolean; toolName: string; summary: string }
  | { source: "user_signal"; signal: "approved" | "overridden" | "corrected"; context: string }
  | { source: "inferred"; confidence: number; reasoning: string };

// ============================================================================
// Valuation Engine — Domain Outcome Stats & Weight Proposals (Tier 3)
// ============================================================================

/** Aggregated outcome data for a single domain over a time window. */
export interface DomainOutcomeStats {
  domain: string;
  decisions: number;
  successes: number;
  failures: number;
  partials: number;
  successRate: number;
  /** Grounded metric from MetricRegistry, if available. [0.0, 1.0]. */
  groundedScore?: number;
  /** Description of the grounded metric source. */
  groundedMetricSource?: string;
}

/** A proposed weight adjustment for a domain, based on outcome data. */
export interface WeightProposal {
  domain: string;
  currentWeight: number;
  proposedWeight: number;
  rationale: string;
}

// ============================================================================
// Events and Proposals
// ============================================================================

export interface CriticalFailureEvent {
  type: "criticalFailure";
  timestamp: string;
  actionId: string;
  expectedOutcome: ExpectedOutcome;
  actualOutcome: ActualOutcome;
  severity: "warning" | "critical";
  implicated_rule?: string;
}

export interface PolicyProposal {
  id: string;
  timestamp: string;
  rule: string;
  proposal: string;
  reasoning: string;
  evidence: string[];
  status: "pending" | "approved" | "rejected";
  /** Category of proposal. Legacy Meta-Reviewer proposals default to "policy". */
  category: "policy" | "project" | "workflow" | "technical" | "weight_adjustment";
  /** Archivist confidence 0.0–1.0. Legacy proposals default to 1.0. */
  confidence: number;
  /** true = generated by Archivist, false = generated by Meta-Reviewer */
  autoGenerated: boolean;
  /** Reason for rejection. Set when status = "rejected". */
  rejectionReason?: string;
  /** ISO timestamp when proposal was rejected. */
  rejectedAt?: string;
}
