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
    /** CR_OODA_PASS_K_ACCEPTANCE_GATE (Path C): sha256 of canonical JSON excluding this field. */
    content_hash?: string;
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
  /**
   * Bitemporal metadata (CR_OODA_BITEMPORAL_KNOWLEDGE).
   * Key = "<section>.<fact_key>". Envelopes are append-only; superseded
   * envelopes retained for audit. At most one envelope per key has valid_to === null.
   */
  _temporal?: Record<string, TemporalEnvelope[]>;
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
    /** CR_OODA_PASS_K_ACCEPTANCE_GATE (Path C): sha256 of canonical JSON excluding this field. */
    content_hash?: string;
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
    // --- CR_OODA_GROUNDED_EVAL_HARNESS_V2 ---
    /** Minimum pass^k ratio required before an admission-gated change lands. Default: 0.60 */
    passk_admission_floor?: number;
    /** Enable pass^k battery during admission (cost-gated). Default: false */
    admission_passk_enabled?: boolean;
    // --- CR_OODA_PASS_K_ACCEPTANCE_GATE ---
    /** Per-kind pass^k floors. See change-gate.ts. */
    passk_by_kind?: Record<string, number>;
    /** Allowlist of approvers who may use --force emergency override. */
    override_approvers?: string[];
    // --- CR_OODA_COUNCIL_ADVERSARIAL_DISCIPLINE ---
    council_chair_anchoring_enabled?: boolean;
    council_min_disagreement?: number;
    council_low_disagreement_window_days?: number;
    council_low_disagreement_ratio_floor?: number;
    council_jury_enabled?: boolean;
    council_jury_priority_floor?: number;
    council_jury_disagreement_floor?: number;
    // --- CR_OODA_COUNCIL_KS_STOPPING ---
    council_adaptive_chair_enabled?: boolean;
    council_adaptive_chair_min_samples?: number;
    council_adaptive_chair_max_samples?: number;
    council_adaptive_chair_ks_threshold?: number;
    council_adaptive_chair_priority_floor?: number;
    council_chair_daily_budget?: number;
    // --- CR_OODA_ERROR_TAXONOMY ---
    /** Axis-rate threshold above which triage/strategy prompts receive priming. Default: 0.3 */
    axis_prior_inject_floor?: number;
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

export type TrajectoryScalingMode = "off" | "shadow" | "live";

export interface TrajectoryScalingConfig {
  /** @deprecated Use `mode`. Kept for migration: true → "live", false → "off". */
  enabled?: boolean;
  /** V2 replacement for `enabled`. Defaults to "shadow" on new installs; migrated from `enabled` when only that field is present. */
  mode?: TrajectoryScalingMode;
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
  /**
   * CR_OODA_PATTERN_SEPARATION_GATE: novelty score in [0,1] from the recall
   * layer. 1.0 = no near-match (genuinely novel); 0.0 = query already in
   * memory. Populated when retrieval ran before triage; absent otherwise.
   */
  novelty?: number;
}

export interface CouncilTrace {
  mode: "system1" | "system2";
  members: Array<{ role: string; output: string }>;
  chairReasoning: string;
  dissent: boolean;
  // --- CR_OODA_COUNCIL_ADVERSARIAL_DISCIPLINE (all optional, back-compat) ---
  /** Chair's pre-read lean before seeing member outputs. */
  prior?: ChairPrior;
  /** Whether post-read chair reversed its pre-read verdict. */
  flipped?: boolean;
  /** When flipped=true, the specific member evidence cited. */
  flip_evidence?: string;
  /** Disagreement across council members. */
  disagreement?: DisagreementReading;
  /** True when post-read chair failed to cite evidence and fell back to the anchor. */
  anchor_fallback?: boolean;
  /** True when disagreement.score < threshold (single-voice decision). */
  low_disagreement?: boolean;
  /** Optional jury verdict when high-priority + high-disagreement. */
  jury?: JuryResult;
  // --- CR_OODA_COUNCIL_KS_STOPPING ---
  /** Adaptive chair sampling trace (only when enabled). */
  adaptiveChair?: {
    enabled: boolean;
    sampleCount: number;
    stabilizedAt: number;
    winnerShare: number;
    ksTrajectory: number[];
    forcedStop: boolean;
  };
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
  /**
   * CR_OODA_CAUSAL_RETRIEVAL: optional antecedent decisions surfaced by the
   * causal index at emit time. Lets downstream consumers (meta-reviewer,
   * operator via `workspace errors causes`) see "what preceded this failure"
   * without re-running the index.
   */
  antecedents?: string[];
}

// ============================================================================
// CR_OODA_BITEMPORAL_KNOWLEDGE — Temporal Envelopes
// ============================================================================

export interface TemporalEnvelope {
  /** When the fact became true in the user's world (best-known). */
  valid_from: string;
  /** When the fact stopped being true. null = still valid. */
  valid_to: string | null;
  /** When this envelope was recorded into KNOWLEDGE.json. */
  ingested_at: string;
  /** Source or agent that ingested. */
  ingested_by: "archivist" | "user" | "meta_reviewer" | "migration" | string;
  /** Predecessor envelope's ingested_at (same canonical key, earlier). */
  supersedes?: string;
  /** Why this envelope was superseded/invalidated (if valid_to !== null). */
  invalidation_reason?: string;
  /** Confidence at ingestion time [0, 1]. */
  confidence: number;
  /** Timestamps of identical-value re-writes. Populated only on currently-valid envelope. */
  reconfirmations?: string[];
}

export interface UpsertOptions {
  /** When this fact became true. Default: now. */
  valid_from?: string;
  /** Confidence [0, 1]. Default: 0.9 (archivist) or 1.0 (user). */
  confidence?: number;
  /** Reason the previous envelope is being superseded (if any). */
  invalidation_reason?: string;
  /** Identity of the writer. Default: "archivist". */
  ingested_by?: TemporalEnvelope["ingested_by"];
}

// ============================================================================
// CR_OODA_ARCHIVIST_CRUD_CLASSIFIER — four-action classifier
// ============================================================================

export type PatternAction = "ADD" | "UPDATE" | "DELETE" | "NOOP" | "BELIEVE";

// ============================================================================
// CR_OODA_BELIEFS_TIER — fourth tier
// ============================================================================

export interface BeliefEvidence {
  source: "episodic" | "tool_result" | "user_signal";
  ref: string;
  weight: number;
  at: string;
}

export interface Belief {
  id: string;
  claim: string;
  domain: string;
  confidence: number;
  formed_at: string;
  updated_at: string;
  evidence: BeliefEvidence[];
  contradicting_evidence: BeliefEvidence[];
  retired?: { at: string; reason: string };
  affects: Array<"triage" | "strategy" | "executive">;
}

export interface BeliefsFile {
  _meta: {
    version: number;
    updated_at: string;
    updated_by: "archivist" | "meta_reviewer" | "user";
    description: string;
    /** CR_OODA_PASS_K_ACCEPTANCE_GATE (Path C): sha256 of canonical JSON excluding this field. */
    content_hash?: string;
  };
  beliefs: Record<string, Belief>;
  _belief_log: Array<{
    timestamp: string;
    action: "formed" | "reinforced" | "weakened" | "retired" | "promoted";
    belief_id: string;
    delta: number;
    reason: string;
  }>;
}

// ============================================================================
// CR_OODA_ERROR_TAXONOMY — five-axis failure tags
// ============================================================================

export type ErrorAxis = "memory" | "reflection" | "planning" | "action" | "system";

export interface ErrorTag {
  axis: ErrorAxis;
  severity: "minor" | "major" | "critical";
  signal: string;
  confidence: number;
  implicated_fact?: string;
  implicated_belief?: string;
}

export interface ErrorAxisPriorStats {
  domain: string;
  axis: ErrorAxis;
  countCritical: number;
  countMajor: number;
  countMinor: number;
  axisRate: number;
  topSignals: Array<{ signal: string; count: number }>;
}

// ============================================================================
// CR_OODA_GROUNDED_EVAL_HARNESS_V2 — admission gate, distortion, pass^k
// ============================================================================

export interface AdmissionFixture {
  observation: string;
  knowledge: KnowledgeFile;
  priorities: PrioritiesFile;
  domainTrajectories?: Record<string, number>;
}

export interface AdmissionCase {
  id: string;
  label: string;
  fixture: AdmissionFixture;
  expected: ExpectedOutcome;
  /** Prior outcome observed on this case — used to detect regressions. */
  priorOutcome?: "success" | "failure" | "partial";
  capturedAt: string;
  /**
   * CR_OODA_HYPOTHESIS_DISCIPLINE_HARDENING #4: optional fixture tags. Used by
   * the research sandbox to filter hypothesis-specific fixtures (must include
   * `success_metric.fixture_tag`) so the H-pass-rate is computed only over
   * fixtures that actually target the hypothesis.
   */
  tags?: string[];
}

export interface AdmissionReport {
  proposalId: string;
  casesRun: number;
  casesPassed: number;
  casesFailed: Array<{ caseId: string; reason: string }>;
  passRate: number;
  /** pass^k by k. JSON-serialized keys become strings; readers must cast. */
  kPassRates: Record<number, number>;
  admit: boolean;
  admitReason: string;
  computedAt: string;
}

export interface DistortionSample {
  domain: string;
  timestamp: number;
  measured: number;
  grounded: number;
  approvalCount: number;
  overrideCount: number;
}

export type DistortionRegime =
  | "healthy"
  | "goodhart_warning"
  | "campbell_suspected"
  | "insufficient_data";

export interface DistortionReading {
  domain: string;
  goodhartIndex: number;
  campbellIndex: number;
  regime: DistortionRegime;
  evidence: string[];
}

export interface PassKConfig {
  kValues: number[];
  caseIds: string[];
  caseTimeoutMs: number;
}

export interface PassKResult {
  kValues: number[];
  passRates: Record<number, number>;
  totalTrials: number;
  trialsPerCase: number;
  narrative: string;
}

// ============================================================================
// CR_OODA_PASS_K_ACCEPTANCE_GATE — change-gate types
// ============================================================================

export type ChangeKind =
  | "policy_proposal"
  | "soul_md_edit"
  | "knowledge_edit"
  | "belief_promotion"
  | "archivist_prompt"
  | "council_mode"
  | "trajectory_calibration"
  | "archetype_change"
  | "rubric_change";

export interface ChangeRequest {
  kind: ChangeKind;
  id: string;
  summary: string;
  diff: string;
  initiator: "user" | "meta_reviewer" | "archivist" | "ci";
  skipPassK?: { reason: string; approver: string };
}

export interface GateOutcome {
  admit: boolean;
  reason: string;
  passK?: PassKResult;
  ranCases: number;
  duration_ms: number;
  /** true when override=--force was used. */
  override?: boolean;
  /** Approver name when override=true. */
  approver?: string;
}

// ============================================================================
// CR_OODA_TRAJECTORY_AWARE_TRIAGE_V2 — audit log shape
// ============================================================================

export interface TrajectoryAuditRow {
  timestamp: number;
  sitrepSummary: string;
  rawPriority: number;
  scaledPriority: number;
  quadrant: "pos_pos" | "pos_neg" | "neg_pos" | "neg_neg" | "neutral";
  scaleApplied: number;
  domains: string[];
  avgTrajectory: number;
  mode: TrajectoryScalingMode;
  actionId?: string;
}

// ============================================================================
// CR_OODA_COUNCIL_ADVERSARIAL_DISCIPLINE — chair anchoring, disagreement, jury
// ============================================================================

export interface ChairPrior {
  preReadWinner: string;
  preReadReasoning: string;
  preReadConfidence: number;
}

export interface DisagreementReading {
  score: number;
  clusters: Array<{ label: string; members: string[] }>;
  contradictions: Array<{ a: string; b: string; signal: string }>;
}

export interface JuryResult {
  verdict: "affirm" | "overturn" | "split";
  individualVotes: Array<{ juror: string; vote: "affirm" | "overturn"; reasoning: string }>;
  finalChairReasoning: string;
}

// ============================================================================
// CR_OODA_COUNCIL_KS_STOPPING — adaptive chair sampling
// ============================================================================

export interface AdaptiveChairConfig {
  enabled: boolean;
  minSamples: number;
  maxSamples: number;
  ksThreshold: number;
  temperatures: number[];
  priorityFloor: number;
  dailyBudget: number;
}

export interface ChairSamplingResult {
  samples: Array<{
    attempt: number;
    temperature: number;
    parsedLabel: string;
    parsedConfidence: number;
    raw: string;
  }>;
  stabilizedAt: number;
  ksByRound: number[];
  /** Modal verdict label across all samples. */
  winnerLabel: string;
  winnerShare: number;
  forcedStop: boolean;
  splitVerdict: boolean;
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
  // --- CR_OODA_GROUNDED_EVAL_HARNESS_V2 ---
  /** Populated when admission gate ran. */
  admissionReport?: AdmissionReport;
  /** Whether admission gate is required for this proposal. */
  admissionRequired?: boolean;
  // --- CR_OODA_ERROR_TAXONOMY ---
  /** Failure-axis evidence backing this proposal (for weight_adjustment proposals). */
  axis_evidence?: {
    domain: string;
    axis: ErrorAxis;
    recentCount: number;
    topSignal: string;
  };
}
