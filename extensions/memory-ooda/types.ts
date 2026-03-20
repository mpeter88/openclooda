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
    meta_reviewer_weekly_enabled: boolean;
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
// OODA Reasoning Chain
// ============================================================================

export interface SITREP {
  priority: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
  summary: string;
  conflictsDetected: string[];
  relevantFacts: string[];
  recommendedDomains: string[];
  /** Single imperative sentence (≤15 words) directing the executive on
   *  what to emphasize or watch for this turn.
   *  Only present when priority >= 6. */
  attention?: string;
}

export interface Strategy {
  label: string;
  reasoning: string;
  alignmentScore: number;
  efficiencyScore: number;
  riskScore: number;
  weightedTotal: number;
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
}
