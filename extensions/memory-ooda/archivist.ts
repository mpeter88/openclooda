/**
 * Archivist — Async Tier 2 → Tier 3 Distillation
 *
 * Runs every N turns (configurable via thresholds.archivist_turn_interval).
 * Reads recent episodic events from LanceDB, runs a summarization pass
 * to extract stable patterns, and upserts them into KNOWLEDGE.json.
 *
 * Purely async, outside the hot path. Feature-flagged off by default.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { errorMessage, stripCodeFences } from "./parse-utils.js";
import { addArchivistProposals, addProposal, type ProposalCandidate } from "./proposals.js";
import type { ModelCallFn } from "./triage.js";
import type { DomainOutcomeStats, PrioritiesFile, WeightProposal } from "./types.js";

// ============================================================================
// Types
// ============================================================================

/** Minimal view of an episodic event from Tier 2 (LanceDB). */
export interface EpisodicEvent {
  id: string;
  text: string;
  category: string;
  importance: number;
  createdAt: number;
  source?: string;
  actionId?: string;
  archivistProcessed?: boolean;
  // Outcome labeling (Tier 2 — O3)
  outcome?: "success" | "failure" | "partial";
  outcomeSignal?: string;
  outcomeAt?: number;
}

/** Outcome label applied to a decision memory. */
export interface OutcomeLabel {
  outcome: "success" | "failure" | "partial";
  observedAt: number;
  signal: string;
  detail?: string;
}

/** Abstraction over Tier 2 store for testability. */
export interface EpisodicStore {
  retrieveSince(sinceTimestamp: number, limit?: number): Promise<EpisodicEvent[]>;
  markProcessed(id: string): Promise<void>;
  prune(olderThanMs: number, onlyProcessed?: boolean): Promise<number>;
  /** Optional write method — used by structural event capture (C3). */
  store?(event: Omit<EpisodicEvent, "id" | "createdAt" | "archivistProcessed">): Promise<void>;
  /** O3: Label the outcome of a decision memory by its actionId. */
  labelOutcome?(actionId: string, label: OutcomeLabel): Promise<void>;
  /** O2: Find recent memories with an actionId for outcome labeling. */
  findRecentWithActionId?(limit?: number): Promise<EpisodicEvent[]>;
}

/** Abstraction over Tier 3 store for testability. */
export interface SemanticStore {
  upsertFact(section: string, key: string, value: unknown): void;
  appendArchivistLog(action: string, reason: string): void;
}

/** Persisted state across archivist runs. */
export interface ArchivistState {
  /** Turn counter — incremented on every agent_end. Persists across restarts. */
  last_processed_turn: number;
  /**
   * Turns elapsed since the archivist last ran. Incremented on every agent_end,
   * reset to 0 after a successful archivist run. No subtraction of two global
   * counters — this counter is self-contained and restart-safe.
   */
  turns_since_last_archivist: number;
  last_run_at: string;
  /** Number of archivist completions since the meta-reviewer last ran. */
  archivist_runs_since_meta_review: number;
  /** @deprecated use turns_since_last_archivist — kept for migration compat */
  last_archivist_turn?: number;
  /** @deprecated renamed to last_processed_turn — kept for migration compat */
  last_run_turn?: number;
}

/** Configuration for a single archivist run. */
export interface ArchivistConfig {
  /** Turns between archivist runs (from thresholds.archivist_turn_interval) */
  turnInterval: number;
  /** Days after which processed events are pruned (default: 90) */
  pruneAfterDays: number;
  /** Max events to process per run (default: 500) */
  maxEventsPerRun: number;
  /** Max retries on malformed model output (default: 1) */
  maxRetries: number;
}

/** A single pattern extracted by the model from episodic events. */
export interface PatternExtraction {
  section:
    | "stack"
    | "projects"
    | "people"
    | "domain_context"
    | "lessons_learned"
    | "preferences_notes";
  key: string;
  value: unknown;
  reason: string;
}

/** Result of a single archivist run. */
export interface ArchivistResult {
  patternsExtracted: PatternExtraction[];
  eventsProcessed: number;
  eventsPruned: number;
  fromFallback: boolean;
  /** Last error from model call attempts, if any. */
  lastError?: string;
}

// ============================================================================
// State File Management
// ============================================================================

const STATE_FILENAME = ".archivist-state.json";

export function statePath(workspacePath: string): string {
  return path.join(workspacePath, STATE_FILENAME);
}

export function readState(workspacePath: string): ArchivistState {
  const filePath = statePath(workspacePath);

  if (!fs.existsSync(filePath)) {
    return {
      last_processed_turn: 0,
      turns_since_last_archivist: 0,
      last_run_at: "1970-01-01T00:00:00Z",
      archivist_runs_since_meta_review: 0,
    };
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw);

  if (typeof parsed.last_run_at !== "string") {
    throw new Error("Invalid .archivist-state.json: missing last_run_at");
  }

  if (isNaN(new Date(parsed.last_run_at).getTime())) {
    throw new Error("Invalid .archivist-state.json: last_run_at is not a valid timestamp");
  }

  // Migration: old format used last_run_turn for both counters
  if (typeof parsed.last_processed_turn !== "number") {
    const legacy = typeof parsed.last_run_turn === "number" ? parsed.last_run_turn : 0;
    parsed.last_processed_turn = legacy;
  }

  // Migration: old format used last_archivist_turn (two global counters, drift-prone).
  // Convert to turns_since_last_archivist (self-contained counter).
  if (typeof parsed.turns_since_last_archivist !== "number") {
    if (typeof parsed.last_archivist_turn === "number") {
      // Estimate from old counters — may be off if restarted mid-run, but
      // better than starting from 0 and skipping a run that's already due.
      parsed.turns_since_last_archivist = Math.max(
        0,
        parsed.last_processed_turn - parsed.last_archivist_turn,
      );
    } else {
      parsed.turns_since_last_archivist = 0;
    }
  }

  if (typeof parsed.archivist_runs_since_meta_review !== "number") {
    parsed.archivist_runs_since_meta_review = 0;
  }

  return parsed as ArchivistState;
}

export function writeState(workspacePath: string, state: ArchivistState): void {
  const filePath = statePath(workspacePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

// ============================================================================
// Turn-Based Trigger
// ============================================================================

/**
 * Determine whether the Archivist should run.
 * Uses turns_since_last_archivist — a self-contained counter that resets to 0
 * after each run. Restart-safe: no subtraction of two global counters.
 */
export function shouldRunArchivist(state: ArchivistState, turnInterval: number): boolean {
  if (turnInterval <= 0) return false;
  return state.turns_since_last_archivist >= turnInterval;
}

// ============================================================================
// Prompt Construction
// ============================================================================

const MAX_EVENT_TEXT_LENGTH = 200;

function formatEventsBlock(events: EpisodicEvent[]): string {
  return events
    .map((e, i) => {
      const date = new Date(e.createdAt).toISOString().slice(0, 16);
      const source = e.source ? ` [${e.source}]` : "";
      const text =
        e.text.length > MAX_EVENT_TEXT_LENGTH
          ? e.text.slice(0, MAX_EVENT_TEXT_LENGTH) + "..."
          : e.text;
      return `${i + 1}. (${date}${source}, importance=${e.importance}) ${text}`;
    })
    .join("\n");
}

export function buildArchivistPrompt(events: EpisodicEvent[]): string {
  const eventsBlock = formatEventsBlock(events);

  return `You are the Archivist — a long-term memory distillation agent.

You receive a batch of recent episodic events from an AI assistant session.
Your job: extract durable knowledge worth remembering across future sessions.

## Episodic Events
${eventsBlock}

## Target Sections (extract to each one actively)

### lessons_learned  ← MOST IMPORTANT
Mistakes made, bugs found, anti-patterns encountered, and what they teach.
Every bug report, revert, wrong assumption, or "we should have known better" is a lesson.
Key: 3-5 words snake_case (e.g. "claude_streaming_required", "check_all_branches")
Value: 1-2 sentence actionable lesson.

Examples:
  "claude_streaming_required": "Always use messages.stream() not messages.create() — the Anthropic SDK enforces a 10-minute timeout on blocking calls that large generations exceed."
  "check_all_branches": "When auditing for code violations, check worktree branches too — violations hide in in-flight branches, not just committed code."
  "package_detection_first_match": "Assembly script must use the shortest qualifying package (≥3 segments), not the first match — can land on a subpackage and misplace files."

### preferences_notes
How the user prefers to work, what they value, what they avoid. Free-form string.
Key: short label, Value: 1 sentence.

Examples:
  "cr_before_code": "Always write the CR spec before implementing — no code without a CR."
  "proactive_not_reactive": "Don't wait to be asked — surface blockers, propose improvements, act on patterns."

### people
Anyone mentioned by name with role and relevant context.
Value: object { "role", "relationship", "communication_preference", "notes" }

### projects
Update status, constraints, key patterns. Don't repeat what's already captured.

### domain_context
Cross-project patterns, recurring failure modes, architectural decisions that recur.

### stack
Technology, tools, versions that are stable across sessions.

## Output Format
Respond with raw JSON only. No code fences, no text outside the JSON.

[
  {
    "section": "<stack | projects | people | domain_context | lessons_learned | preferences_notes>",
    "key": "<identifier>",
    "value": <string for stack/domain_context/lessons_learned/preferences_notes, object for projects/people>,
    "reason": "<which events support this>"
  }
]

Return [] if no patterns found. Maximum 15 patterns per batch.

## Constraints
- lessons_learned entries can come from a SINGLE event if it clearly describes a mistake or lesson
- All other sections require 2+ supporting events
- Never infer sensitive personal information (health, finances)
- Prefer updating existing facts over creating new ones

Verify your JSON is syntactically valid before responding.`;
}

// ============================================================================
// Response Parsing
// ============================================================================

const VALID_SECTIONS = new Set([
  "stack",
  "projects",
  "people",
  "domain_context",
  "lessons_learned",
  "preferences_notes",
]);

export function parsePatterns(raw: string): PatternExtraction[] {
  const cleaned = stripCodeFences(raw);
  const parsed = JSON.parse(cleaned);

  if (!Array.isArray(parsed)) {
    throw new Error("Archivist response must be a JSON array");
  }

  if (parsed.length > 15) {
    throw new Error(`Too many patterns: ${parsed.length} (max 15)`);
  }

  // Empty array is valid — no patterns found
  if (parsed.length === 0) {
    return [];
  }

  return parsed.map((item: unknown, idx: number) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`Pattern[${idx}] must be an object`);
    }

    const obj = item as Record<string, unknown>;

    if (typeof obj.section !== "string" || !VALID_SECTIONS.has(obj.section)) {
      throw new Error(`Pattern[${idx}].section must be one of: ${[...VALID_SECTIONS].join(", ")}`);
    }
    if (typeof obj.key !== "string" || obj.key.length === 0) {
      throw new Error(`Pattern[${idx}] must have a non-empty key`);
    }
    if (obj.value === undefined || obj.value === null) {
      throw new Error(`Pattern[${idx}] must have a non-null value`);
    }
    // Per-section type validation
    if (
      (obj.section === "stack" ||
        obj.section === "domain_context" ||
        obj.section === "lessons_learned" ||
        obj.section === "preferences_notes") &&
      typeof obj.value !== "string"
    ) {
      throw new Error(`Pattern[${idx}].value must be a string for section "${obj.section}"`);
    }
    if (
      (obj.section === "projects" || obj.section === "people") &&
      (typeof obj.value !== "object" || Array.isArray(obj.value))
    ) {
      throw new Error(`Pattern[${idx}].value must be an object for section "${obj.section}"`);
    }
    if (typeof obj.reason !== "string" || obj.reason.length === 0) {
      throw new Error(`Pattern[${idx}] must have a non-empty reason`);
    }

    return {
      section: obj.section as PatternExtraction["section"],
      key: obj.key,
      value: obj.value,
      reason: obj.reason,
    };
  });
}

// ============================================================================
// Main Entry Point
// ============================================================================

// ============================================================================
// O1: Decision Detection
// ============================================================================

const DECISION_KEYWORDS = /\b(decided|chose|implemented|fixed|applied|switched)\b/i;

/**
 * Heuristic: is this pattern a decision or action worth tracking for outcomes?
 * True for lessons_learned (always), or patterns whose value contains decision verbs.
 */
export function isDecision(pattern: PatternExtraction): boolean {
  if (pattern.section === "lessons_learned") return true;
  if (typeof pattern.value === "string" && DECISION_KEYWORDS.test(pattern.value)) return true;
  return false;
}

// ============================================================================
// V1: Domain Outcome Aggregation
// ============================================================================

/**
 * Keyword → domain mapping. Each domain has keywords that, when found in the
 * memory text (case-insensitive), assign that memory to the domain.
 */
const DOMAIN_KEYWORDS: Record<string, string[]> = {
  amf_pipeline: ["amf", "pipeline", "kohlscore", "kohl", "assembly"],
  openclooda: ["ooda", "archivist", "triage", "valuation", "sitrep", "strategy", "knowledge.json"],
  infrastructure: ["deploy", "ci/cd", "docker", "kubernetes", "infra", "server"],
  testing: ["test", "vitest", "coverage", "spec", "e2e"],
};

/**
 * Infer which domain a memory belongs to, based on keyword matching.
 * Returns the first matching domain, or "unknown" if none match.
 */
export function inferDomain(text: string): string {
  const lower = text.toLowerCase();
  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      return domain;
    }
  }
  return "unknown";
}

/**
 * Aggregate outcome data per domain from episodic events that have outcomes.
 * Only considers events from the last 30 days by default.
 */
export function aggregateDomainOutcomes(
  events: EpisodicEvent[],
  windowMs: number = 30 * 24 * 60 * 60 * 1000,
): DomainOutcomeStats[] {
  const cutoff = Date.now() - windowMs;
  const withOutcome = events.filter((e) => e.outcome && e.createdAt >= cutoff);

  const byDomain = new Map<string, { successes: number; failures: number; partials: number }>();

  for (const e of withOutcome) {
    const domain = inferDomain(e.text);
    const stats = byDomain.get(domain) ?? { successes: 0, failures: 0, partials: 0 };
    if (e.outcome === "success") stats.successes++;
    else if (e.outcome === "failure") stats.failures++;
    else if (e.outcome === "partial") stats.partials++;
    byDomain.set(domain, stats);
  }

  const result: DomainOutcomeStats[] = [];
  for (const [domain, stats] of byDomain) {
    const decisions = stats.successes + stats.failures + stats.partials;
    result.push({
      domain,
      decisions,
      successes: stats.successes,
      failures: stats.failures,
      partials: stats.partials,
      successRate: decisions > 0 ? stats.successes / decisions : 0,
    });
  }

  return result;
}

// ============================================================================
// V2: Weight Proposal Generation
// ============================================================================

/** Clamp a value to [min, max]. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Determine whether a domain's outcome stats warrant a weight adjustment.
 * Fires when: |successRate - currentWeight| > 0.2 AND decisions >= 5.
 * Adjustment is conservative: 0.3× of delta.
 */
export function shouldProposeWeightAdjustment(
  stats: DomainOutcomeStats,
  currentWeight: number,
): WeightProposal | null {
  const expectedSuccessRate = currentWeight;
  const delta = stats.successRate - expectedSuccessRate;
  if (Math.abs(delta) > 0.2 && stats.decisions >= 5) {
    const proposedWeight = clamp(currentWeight + delta * 0.3, 0.1, 1.0);
    return {
      domain: stats.domain,
      currentWeight,
      proposedWeight,
      rationale: `${stats.decisions} decisions, ${(stats.successRate * 100).toFixed(0)}% success rate vs ${(currentWeight * 100).toFixed(0)}% weight`,
    };
  }
  return null;
}

/**
 * Generate weight proposals for all domains that have outcome stats
 * deviating significantly from their current weights.
 */
export function generateWeightProposals(
  domainStats: DomainOutcomeStats[],
  priorities: PrioritiesFile,
): WeightProposal[] {
  const proposals: WeightProposal[] = [];
  for (const stats of domainStats) {
    const domainEntry = priorities.domains[stats.domain];
    if (!domainEntry) continue;
    const proposal = shouldProposeWeightAdjustment(stats, domainEntry.weight);
    if (proposal) proposals.push(proposal);
  }
  return proposals;
}

// ============================================================================
// V3: Weight Proposals → PolicyProposal System
// ============================================================================

/**
 * Convert weight proposals into PolicyProposals and add them to the store.
 * Returns the number of proposals added.
 */
export function addWeightProposals(
  workspacePath: string,
  weightProposals: WeightProposal[],
): number {
  let added = 0;
  for (const wp of weightProposals) {
    addProposal(workspacePath, {
      id: `weight-${wp.domain}-${Date.now()}`,
      timestamp: new Date().toISOString(),
      category: "weight_adjustment",
      rule: wp.domain,
      proposal: `Adjust ${wp.domain} weight: ${wp.currentWeight} → ${wp.proposedWeight.toFixed(2)}`,
      reasoning: wp.rationale,
      evidence: [
        `Domain ${wp.domain}: current weight=${wp.currentWeight}, observed success rate=${wp.proposedWeight > wp.currentWeight ? "higher" : "lower"} than expected`,
      ],
      confidence: Math.min(
        0.9,
        wp.rationale.match(/^(\d+)/)?.[1] ? Number(wp.rationale.match(/^(\d+)/)?.[1]) / 20 : 0.5,
      ),
      autoGenerated: true,
    });
    added++;
  }
  return added;
}

const DEFAULT_CONFIG: ArchivistConfig = {
  turnInterval: 100,
  pruneAfterDays: 90,
  maxEventsPerRun: 500,
  maxRetries: 1,
};

/**
 * Run the Archivist distillation process.
 *
 * 1. Query Tier 2 (LanceDB) for events since last run.
 * 2. Run a summarization pass to extract stable patterns.
 * 3. Upsert each pattern into Tier 3 (KNOWLEDGE.json).
 * 4. Mark processed events in LanceDB.
 * 5. Append to _archivist_log.
 * 6. Prune old processed events.
 * 7. Update state file.
 */
// ============================================================================
// Proposal Extraction (second model pass)
// ============================================================================

const PROPOSAL_PROMPT_TEMPLATE = `You are scanning recent session memory for actionable suggestions worth surfacing proactively.

## Recent Events (showing first 40):
{EVENTS}

## Already Pending Proposals (do NOT duplicate):
{PENDING}

## What to look for:
1. RECURRING PROBLEMS — same issue appeared 3+ times → suggest a fix or process change
2. MISSING TOOLS — task done manually repeatedly → suggest building automation
3. ARCHITECTURAL GAPS — pattern of workarounds for a known root cause → suggest addressing root cause
4. PROCESS INEFFICIENCY — repeated friction in workflow → suggest streamlining

## Rules:
- Only emit proposals with confidence >= 0.6
- Maximum 3 proposals
- Each must be concrete and actionable (not vague)
- Do NOT propose things already in pending proposals above
- Do NOT propose things clearly outside the agent's scope

## Output:
Raw JSON array only. Empty array if nothing warrants a proposal.
[
  {
    "category": "project" | "workflow" | "technical",
    "rule": "<domain label e.g. AMF Pipeline, OpenCLOODA, Daily workflow>",
    "proposal": "<1-2 sentences: concrete action>",
    "reasoning": "<why this matters>",
    "evidence": ["<specific example 1>", "<specific example 2>"],
    "confidence": <0.0-1.0>
  }
]`;

async function extractProposals(
  events: EpisodicEvent[],
  workspacePath: string,
  callModel: ModelCallFn,
): Promise<ProposalCandidate[]> {
  // Need enough events to identify a pattern
  if (events.length < 5) return [];

  const { getProposals } = await import("./proposals.js");
  const existing = getProposals(workspacePath);
  const pendingText =
    existing
      .filter((p) => p.status === "pending")
      .map((p) => `- [${p.rule}] ${p.proposal}`)
      .join("\n") || "(none)";

  const eventSummary = events
    .slice(0, 40)
    .map((e, i) => `${i + 1}. [${e.category}] ${e.text.slice(0, 180)}`)
    .join("\n");

  const prompt = PROPOSAL_PROMPT_TEMPLATE.replace("{EVENTS}", eventSummary).replace(
    "{PENDING}",
    pendingText,
  );

  try {
    const raw = await callModel(prompt);
    const parsed = JSON.parse(stripCodeFences(raw));
    if (!Array.isArray(parsed)) return [];

    return parsed.filter(
      (p: ProposalCandidate) =>
        typeof p.proposal === "string" &&
        p.proposal.trim().length > 0 &&
        typeof p.confidence === "number" &&
        p.confidence >= 0.6,
    );
  } catch {
    return [];
  }
}

export async function runArchivist(
  workspacePath: string,
  currentTurn: number,
  episodicStore: EpisodicStore,
  semanticStore: SemanticStore,
  callModel: ModelCallFn,
  config?: Partial<ArchivistConfig>,
  /** Optional: pass priorities to enable V3 weight proposal generation. */
  priorities?: PrioritiesFile,
): Promise<ArchivistResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const state = readState(workspacePath);

  // Step 1: Retrieve events since last run
  // Use last_run_at timestamp (converted to ms) for the time-based query
  const sinceTimestamp = new Date(state.last_run_at).getTime();
  const events = await episodicStore.retrieveSince(sinceTimestamp, cfg.maxEventsPerRun);

  if (events.length === 0) {
    // Do NOT advance state — retrieval may have failed silently (C3)
    return { patternsExtracted: [], eventsProcessed: 0, eventsPruned: 0, fromFallback: false };
  }

  // Step 2: Run summarization pass with retries
  let patterns: PatternExtraction[] = [];
  let fromFallback = false;
  let lastError: unknown;

  const prompt = buildArchivistPrompt(events);

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      const raw = await callModel(prompt);
      patterns = parsePatterns(raw);
      lastError = undefined;
      break;
    } catch (err) {
      lastError = err;
      if (attempt === cfg.maxRetries) {
        // All attempts failed — still mark events as processed
        // to avoid reprocessing, but extract no patterns
        fromFallback = true;
      }
    }
  }

  // Step 3: Upsert patterns into Tier 3 (all upserts before any marking — C1)
  for (const pattern of patterns) {
    semanticStore.upsertFact(pattern.section, pattern.key, pattern.value);
  }

  // Step 3b (O1): Tag decision patterns with actionId and store into episodic backend
  if (episodicStore.store) {
    for (const pattern of patterns) {
      if (isDecision(pattern)) {
        const actionId = randomUUID();
        try {
          await episodicStore.store({
            text: typeof pattern.value === "string" ? pattern.value : JSON.stringify(pattern.value),
            importance: 0.75,
            category: "decision",
            source: "archivist",
            actionId,
          });
        } catch {
          // Best-effort — don't block archivist on decision tagging
        }
      }
    }
  }

  // Step 3c (O5): Outcome stats — summarize outcome data into KNOWLEDGE.json
  try {
    const allRecent = await episodicStore.retrieveSince(0, 10_000);
    const withOutcome = allRecent.filter((e) => e.outcome);
    if (withOutcome.length > 0) {
      const outcomeStats: Record<string, string> = {};
      const successCount = withOutcome.filter((e) => e.outcome === "success").length;
      const failureCount = withOutcome.filter((e) => e.outcome === "failure").length;
      const partialCount = withOutcome.filter((e) => e.outcome === "partial").length;
      const total = withOutcome.length;

      if (total > 0) {
        outcomeStats.overall_fix_rate = `${successCount}/${total} decisions succeeded (${failureCount} failed, ${partialCount} partial)`;
      }

      // Group failures by signal for recurring pattern detection
      const failuresBySignal = new Map<string, number>();
      for (const e of withOutcome.filter((x) => x.outcome === "failure")) {
        const sig = e.outcomeSignal ?? "unknown";
        failuresBySignal.set(sig, (failuresBySignal.get(sig) ?? 0) + 1);
      }
      for (const [signal, count] of failuresBySignal) {
        if (count >= 2) {
          outcomeStats[`recurring_failure_${signal}`] =
            `${signal} failures recurred ${count} times — investigate root cause`;
        }
      }

      for (const [key, value] of Object.entries(outcomeStats)) {
        semanticStore.upsertFact("lessons_learned", `outcome_${key}`, value);
      }
    }
  } catch {
    // Best-effort — outcome stats are supplementary
  }

  // Step 4: Mark all events as processed (only after upserts succeed — C1)
  for (const event of events) {
    try {
      await episodicStore.markProcessed(event.id);
    } catch {
      // Log and continue — partial marking is recoverable via re-processing
    }
  }

  // Step 5: Append to archivist log
  if (patterns.length > 0) {
    const patternSummary = patterns.map((p) => `${p.section}.${p.key}`).join(", ");
    semanticStore.appendArchivistLog(
      "distill",
      `Extracted ${patterns.length} patterns from ${events.length} events: ${patternSummary}`,
    );
  } else if (fromFallback) {
    semanticStore.appendArchivistLog(
      "distill_failed",
      `Processed ${events.length} events but model failed to extract patterns`,
    );
  } else {
    semanticStore.appendArchivistLog(
      "distill_empty",
      `Scanned ${events.length} events, no stable patterns found`,
    );
  }

  // Step 6: Prune old processed events
  const pruneThreshold = Date.now() - cfg.pruneAfterDays * 24 * 60 * 60 * 1000;
  const eventsPruned = await episodicStore.prune(pruneThreshold, true);

  // Step 7: Reset turns_since_last_archivist to 0. last_processed_turn is
  // maintained by index.ts on every agent_end — don't touch it here.
  const prevState = readState(workspacePath);
  writeState(workspacePath, {
    last_processed_turn: prevState.last_processed_turn,
    turns_since_last_archivist: 0,
    last_run_at: new Date().toISOString(),
    archivist_runs_since_meta_review: prevState.archivist_runs_since_meta_review + 1,
  });

  // Step 8: Proposal extraction (second pass — best effort, non-blocking)
  try {
    const candidates = await extractProposals(events, workspacePath, callModel);
    const added = addArchivistProposals(workspacePath, candidates);
    if (added > 0) {
      semanticStore.appendArchivistLog(
        "proposals_generated",
        `Generated ${added} proposal(s) from ${events.length} events`,
      );
    }
  } catch (err) {
    // Non-fatal — proposals are best-effort
    semanticStore.appendArchivistLog("proposals_error", errorMessage(err));
  }

  // Step 9 (V3): Weight proposal generation from domain outcome stats
  if (priorities) {
    try {
      const allRecent = await episodicStore.retrieveSince(0, 10_000);
      const domainStats = aggregateDomainOutcomes(allRecent);
      const weightProposals = generateWeightProposals(domainStats, priorities);
      if (weightProposals.length > 0) {
        const wpAdded = addWeightProposals(workspacePath, weightProposals);
        if (wpAdded > 0) {
          semanticStore.appendArchivistLog(
            "weight_proposals_generated",
            `Generated ${wpAdded} weight adjustment proposal(s): ${weightProposals.map((wp) => `${wp.domain} ${wp.currentWeight}→${wp.proposedWeight.toFixed(2)}`).join(", ")}`,
          );
        }
      }
    } catch {
      // Best-effort — weight proposals are supplementary
    }
  }

  return {
    patternsExtracted: patterns,
    eventsProcessed: events.length,
    eventsPruned,
    fromFallback,
    lastError: lastError ? errorMessage(lastError) : undefined,
  };
}
