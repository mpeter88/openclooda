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
import { buildCausalIndex, findAntecedents, formatAntecedents } from "./causal-retrieval.js";
import {
  appendDistortionSample,
  computeDistortion,
  readDistortionHistory,
} from "./distortion-index.js";
import { aggregateAxisPriors } from "./error-classifier.js";
import { DEFAULT_FORGETTING_POLICY, partitionForPrune } from "./learned-forgetting.js";
import type { MetricRegistry, MetricContext } from "./metric-registry.js";
import { errorMessage, stripCodeFences } from "./parse-utils.js";
import { addArchivistProposals, addProposal, type ProposalCandidate } from "./proposals.js";
import { getFacts } from "./semantic-memory.js";
import type { ModelCallFn } from "./triage.js";
import type {
  CriticalFailureEvent,
  DomainOutcomeStats,
  ErrorTag,
  PrioritiesFile,
  WeightProposal,
} from "./types.js";
import { gateWrite } from "./write-gate.js";

const ERROR_TAGS_SIDECAR = ".error-tags.jsonl";
const CRITICAL_FAILURES_FILE = ".critical-failures.jsonl";
const AXIS_PRIORS_FILE = ".axis-priors.json";
const DEFAULT_DISTORTION_WINDOW = { days: 30, minSamples: 10 };
const DEFAULT_AXIS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function readErrorTagsSidecar(workspacePath: string): Map<string, ErrorTag[]> {
  const file = path.join(workspacePath, ERROR_TAGS_SIDECAR);
  const map = new Map<string, ErrorTag[]>();
  if (!fs.existsSync(file)) return map;
  const content = fs.readFileSync(file, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed) as { eventId: string; tags: ErrorTag[] };
      if (row.eventId && Array.isArray(row.tags)) {
        map.set(row.eventId, row.tags);
      }
    } catch {
      // skip malformed rows
    }
  }
  return map;
}

export function appendErrorTagsSidecar(
  workspacePath: string,
  eventId: string,
  tags: ErrorTag[],
): void {
  const file = path.join(workspacePath, ERROR_TAGS_SIDECAR);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(
    file,
    JSON.stringify({ eventId, tags, at: new Date().toISOString() }) + "\n",
    "utf-8",
  );
}

export function appendCriticalFailure(workspacePath: string, event: CriticalFailureEvent): void {
  const file = path.join(workspacePath, CRITICAL_FAILURES_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(event) + "\n", "utf-8");
}

export function readCriticalFailures(workspacePath: string): CriticalFailureEvent[] {
  const file = path.join(workspacePath, CRITICAL_FAILURES_FILE);
  if (!fs.existsSync(file)) return [];
  const out: CriticalFailureEvent[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as CriticalFailureEvent);
    } catch {
      // skip
    }
  }
  return out;
}

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
  /** CR_OODA_ERROR_TAXONOMY: five-axis failure tags populated for outcome !== "success". */
  errorTags?: import("./types.js").ErrorTag[];
  /** CR_OODA_EMOTIONAL_TAGGING: SITREP priority (1-10) at capture time. Weighting multiplier for recall + aggregation. */
  sitrepPriorityAtCapture?: number;
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
  /** CR_OODA_LEARNED_FORGETTING: remove a specific event by id when usefulness policy drops it. */
  delete?(id: string): Promise<boolean | void>;
}

/** Abstraction over Tier 3 store for testability. */
export interface SemanticStore {
  upsertFact(
    section: string,
    key: string,
    value: unknown,
    opts?: import("./types.js").UpsertOptions,
  ): void;
  appendArchivistLog(action: string, reason: string): void;
  /** CR_OODA_ARCHIVIST_CRUD_CLASSIFIER: remove fact from flat section (does NOT touch temporal history). Optional for back-compat. */
  deleteFact?(section: string, key: string): void;
  /** CR_OODA_BITEMPORAL_KNOWLEDGE: mark currently-valid envelope as invalid without deleting the flat value. Optional for back-compat. */
  invalidateFact?(section: string, key: string, reason: string): void;
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
  /** CR_OODA_ARCHIVIST_CRUD_CLASSIFIER: optional — defaults to "ADD" for
   *  backward compat with model outputs predating the CRUD prompt. */
  action?: import("./types.js").PatternAction;
  section:
    | "stack"
    | "projects"
    | "people"
    | "domain_context"
    | "lessons_learned"
    | "preferences_notes";
  key: string;
  /** Present for ADD/UPDATE/BELIEVE. Null for DELETE or NOOP. */
  value: unknown;
  /** For UPDATE: prior value the model believes is being replaced. */
  previousValue?: unknown;
  /** For DELETE: reason the fact is no longer true. */
  invalidation_reason?: string;
  reason: string;
}

/** Result of applying a single PatternExtraction. */
export interface ApplyActionResult {
  action: import("./types.js").PatternAction;
  applied: boolean;
  rejectedReason?: string;
}

/** Summary of CRUD action counts across an archivist run. */
export interface ActionCounts {
  add: number;
  update: number;
  delete: number;
  noop: number;
  believe: number;
  rejected: number;
}

/** Result of a single archivist run. */
export interface ArchivistResult {
  patternsExtracted: PatternExtraction[];
  eventsProcessed: number;
  eventsPruned: number;
  fromFallback: boolean;
  /** Last error from model call attempts, if any. */
  lastError?: string;
  /** CR_OODA_ARCHIVIST_CRUD_CLASSIFIER: per-action breakdown. */
  actionCounts?: ActionCounts;
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

export function buildArchivistPrompt(
  events: EpisodicEvent[],
  existingKeys?: { lessons: string[]; domain: string[] },
): string {
  const eventsBlock = formatEventsBlock(events);

  // Show existing keys so the model can update rather than reinvent
  let existingKeysBlock = "";
  if (existingKeys) {
    const lessonKeys = existingKeys.lessons.length > 0 ? existingKeys.lessons.join(", ") : "(none)";
    const domainKeys = existingKeys.domain.length > 0 ? existingKeys.domain.join(", ") : "(none)";
    existingKeysBlock = `
## Existing Keys (REUSE these — do NOT create duplicates)

lessons_learned keys: ${lessonKeys}
domain_context keys: ${domainKeys}

CRITICAL: If the events describe something already covered by an existing key,
use THAT key to update its value. Do NOT create a new key with slightly different
wording (e.g. "exact_whitespace_for_edits" vs "exact_copy_for_replacement" — these
are the same lesson and must use one canonical key).
`;
  }

  return `You are the Archivist — a long-term memory distillation agent.

You receive a batch of recent episodic events from an AI assistant session.
Your job: extract durable knowledge worth remembering across future sessions.

CRITICAL OUTPUT RULES:
- Every pattern must have a non-null \`value\`. If you have nothing to say
  for a key, OMIT THE ENTIRE PATTERN — do not emit \`"value": null\`.
- Every pattern must have a non-empty \`reason\`. Same rule: omit instead of null.
- Empty array \`[]\` is a valid response if no events warrant durable knowledge.

## Episodic Events
${eventsBlock}
${existingKeysBlock}
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

## Actions (choose exactly one per pattern)

- **ADD** — new fact not in store. Omit action entirely for backward compat (defaults to ADD).
- **UPDATE** — existing fact whose value is now wrong. Provide previousValue matching the stored value.
- **DELETE** — fact no longer true. Provide invalidation_reason. value should be null.
- **NOOP** — events noted but no durable change. Explain in reason; emit only when you considered adding and decided against.
- **BELIEVE** — pattern is a working theory, not yet a stable truth. Use for repeated observations with confidence 0.4-0.7.

Prefer NOOP over forcing a change when events are noise. UPDATE requires accurate previousValue or the write will be rejected.

## Output Format
Respond with raw JSON only. No code fences, no text outside the JSON.

[
  {
    "action": "ADD" | "UPDATE" | "DELETE" | "NOOP" | "BELIEVE",
    "section": "<stack | projects | people | domain_context | lessons_learned | preferences_notes>",
    "key": "<identifier>",
    "value": <string for stack/domain_context/lessons_learned/preferences_notes, object for projects/people, null for DELETE/NOOP>,
    "previousValue": <current stored value for UPDATE only>,
    "invalidation_reason": "<required for DELETE>",
    "reason": "<which events support this>"
  }
]

Return [] if no patterns found. Maximum 15 patterns per batch.

## Constraints
- lessons_learned entries can come from a SINGLE event if it clearly describes a mistake or lesson
- All other sections require 2+ supporting events
- Never infer sensitive personal information (health, finances)
- REUSE existing keys when the concept already exists — update the value, don't create a near-duplicate
- Only create a NEW key when the pattern is genuinely novel (not covered by any existing key)

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

/**
 * Drop reasons recorded by the most recent parsePatterns invocation. Cleared
 * at the start of each call. Caller reads this to log soft-drop reasons
 * for observability — see CR_OODA_ARCHIVIST_CRUD_CLASSIFIER.md notes on
 * tolerant per-item validation.
 */
export const parsePatternErrors: string[] = [];

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

  // Soft-drop per-item validation. The LLM occasionally emits malformed or
  // null-valued patterns inside an otherwise-valid batch (e.g.
  // `{"section":"lessons_learned","key":"x","value":null}` when it had
  // nothing to say). Throwing on a single bad row used to poison the whole
  // run, which then kept retrying the same poisoned batch every tick. We
  // now drop bad rows + record their reasons so the caller can surface
  // signal without freezing the loop. parsePatternErrors carries those
  // drop reasons so the caller can log them.
  parsePatternErrors.length = 0;
  const validActions = new Set(["ADD", "UPDATE", "DELETE", "NOOP", "BELIEVE"]);
  return parsed.flatMap((item: unknown, idx: number): PatternExtraction[] => {
    const drop = (reason: string): PatternExtraction[] => {
      parsePatternErrors.push(`Pattern[${idx}] dropped: ${reason}`);
      return [];
    };

    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return drop("not an object");
    }

    const obj = item as Record<string, unknown>;

    if (typeof obj.section !== "string" || !VALID_SECTIONS.has(obj.section)) {
      return drop(
        `section must be one of ${[...VALID_SECTIONS].join(", ")} — got ${String(obj.section)}`,
      );
    }
    if (typeof obj.key !== "string" || obj.key.length === 0) {
      return drop("missing or empty key");
    }
    if (obj.value === undefined || obj.value === null) {
      return drop(`null value for key "${obj.key}" (section ${obj.section})`);
    }
    // Per-section type validation
    if (
      (obj.section === "stack" ||
        obj.section === "domain_context" ||
        obj.section === "lessons_learned" ||
        obj.section === "preferences_notes") &&
      typeof obj.value !== "string"
    ) {
      return drop(`value must be a string for section "${obj.section}"`);
    }
    if (
      (obj.section === "projects" || obj.section === "people") &&
      (typeof obj.value !== "object" || Array.isArray(obj.value))
    ) {
      return drop(`value must be an object for section "${obj.section}"`);
    }
    if (typeof obj.reason !== "string" || obj.reason.length === 0) {
      return drop("missing or empty reason");
    }

    // Validate optional action field
    let action: import("./types.js").PatternAction | undefined;
    if (obj.action !== undefined) {
      if (typeof obj.action !== "string" || !validActions.has(obj.action)) {
        return drop(
          `action must be one of ADD, UPDATE, DELETE, NOOP, BELIEVE — got ${String(obj.action)}`,
        );
      }
      action = obj.action as import("./types.js").PatternAction;
    }

    return [
      {
        action,
        section: obj.section as PatternExtraction["section"],
        key: obj.key,
        value: obj.value,
        previousValue: obj.previousValue,
        invalidation_reason:
          typeof obj.invalidation_reason === "string" ? obj.invalidation_reason : undefined,
        reason: obj.reason,
      },
    ];
  });
}

// ============================================================================
// CR_OODA_ARCHIVIST_CRUD_CLASSIFIER — applyPatternAction
// ============================================================================

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Apply a single PatternExtraction action to the semantic store.
 *
 * ADD:    create new fact. Rejected if envelope with valid_to=null exists (forces UPDATE).
 * UPDATE: previousValue must match current stored value (stale-check).
 * DELETE: invalidates the envelope; does not destroy flat value unless deleteFact is used.
 * NOOP:   records a log entry, no store change.
 * BELIEVE: handled externally (B3). This dispatcher just records and returns applied=false.
 *
 * Rejection reasons:
 *  - "already_exists": ADD against existing fact (model must re-classify)
 *  - "stale_previous_value": UPDATE's previousValue doesn't match store
 *  - "missing_value": ADD/UPDATE/BELIEVE with null value
 *  - "missing_reason": DELETE without invalidation_reason
 *  - "unknown_action": action string outside the enum
 */
export async function applyPatternAction(
  workspacePath: string,
  pattern: PatternExtraction,
  semanticStore: SemanticStore,
  currentValue: unknown,
): Promise<ApplyActionResult> {
  const action = pattern.action ?? "ADD";

  // CR_OODA_PASS_K_ACCEPTANCE_GATE (Path C): gate write-producing actions.
  // ADD/UPDATE/DELETE mutate KNOWLEDGE.json; NOOP and BELIEVE don't. Falls open
  // when the admission corpus has <5 cases, so bootstrap workspaces behave
  // exactly as pre-gate code did.
  if (action === "ADD" || action === "UPDATE" || action === "DELETE") {
    const gate = await gateWrite({
      kind: "knowledge_edit",
      id: `knowledge-${pattern.section}-${pattern.key}-${Date.now()}-${randomUUID().slice(0, 6)}`,
      summary: `${action} ${pattern.section}.${pattern.key}`,
      diff: JSON.stringify({
        before: currentValue ?? null,
        after: pattern.value ?? null,
        reason: pattern.reason ?? pattern.invalidation_reason ?? "",
      }),
      workspacePath,
      initiator: "archivist",
    });
    if (!gate.admit) {
      semanticStore.appendArchivistLog(
        `pattern_gate_rejected_${pattern.section}_${pattern.key}`,
        `admission_gate: ${gate.reason}`,
      );
      return {
        action,
        applied: false,
        rejectedReason: `admission_gate: ${gate.reason}`,
      };
    }
  }

  switch (action) {
    case "ADD": {
      if (pattern.value === null || pattern.value === undefined) {
        return { action, applied: false, rejectedReason: "missing_value" };
      }
      if (currentValue !== undefined) {
        // Fall through to reconfirmation path — semantically a NOOP at storage level.
        if (deepEqual(currentValue, pattern.value)) {
          semanticStore.upsertFact(pattern.section, pattern.key, pattern.value);
          return { action, applied: true };
        }
        return { action, applied: false, rejectedReason: "already_exists" };
      }
      semanticStore.upsertFact(pattern.section, pattern.key, pattern.value);
      return { action, applied: true };
    }

    case "UPDATE": {
      if (pattern.value === null || pattern.value === undefined) {
        return { action, applied: false, rejectedReason: "missing_value" };
      }
      if (pattern.previousValue !== undefined && !deepEqual(currentValue, pattern.previousValue)) {
        return { action, applied: false, rejectedReason: "stale_previous_value" };
      }
      semanticStore.upsertFact(pattern.section, pattern.key, pattern.value, {
        invalidation_reason: pattern.invalidation_reason ?? pattern.reason,
      });
      return { action, applied: true };
    }

    case "DELETE": {
      if (!pattern.invalidation_reason) {
        return { action, applied: false, rejectedReason: "missing_reason" };
      }
      if (semanticStore.invalidateFact) {
        semanticStore.invalidateFact(pattern.section, pattern.key, pattern.invalidation_reason);
      } else if (semanticStore.deleteFact) {
        semanticStore.deleteFact(pattern.section, pattern.key);
      } else {
        return { action, applied: false, rejectedReason: "store_missing_delete" };
      }
      return { action, applied: true };
    }

    case "NOOP": {
      semanticStore.appendArchivistLog(
        `pattern_noop_${pattern.section}_${pattern.key}`,
        pattern.reason,
      );
      return { action, applied: true };
    }

    case "BELIEVE": {
      // Beliefs tier handled in B3 — here we log and defer.
      semanticStore.appendArchivistLog(
        `pattern_believe_${pattern.section}_${pattern.key}`,
        `Belief candidate deferred to beliefs tier: ${pattern.reason}`,
      );
      return { action, applied: false, rejectedReason: "deferred_to_beliefs_tier" };
    }

    default:
      return { action, applied: false, rejectedReason: "unknown_action" };
  }
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
  // Prefer grounded metric when available; fall back to LLM-label success rate
  const observedRate = stats.groundedScore ?? stats.successRate;
  const metricSource = stats.groundedScore !== undefined ? "grounded" : "llm-labels";
  const expectedSuccessRate = currentWeight;
  const delta = observedRate - expectedSuccessRate;
  if (Math.abs(delta) > 0.2 && stats.decisions >= 5) {
    const proposedWeight = clamp(currentWeight + delta * 0.3, 0.1, 1.0);
    return {
      domain: stats.domain,
      currentWeight,
      proposedWeight,
      rationale: `${stats.decisions} decisions, ${(observedRate * 100).toFixed(0)}% ${metricSource} rate vs ${(currentWeight * 100).toFixed(0)}% weight`,
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
  maxEventsPerRun: 20, // Process in small batches — keeps prompt tight and subagent within timeout
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
  /** Optional: grounded metric registry for evaluation harness. */
  metricRegistry?: MetricRegistry,
  /** Optional: metric context for grounded score computation. */
  metricContext?: MetricContext,
): Promise<ArchivistResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const state = readState(workspacePath);

  // Step 1: Retrieve unprocessed events.
  // Always query from epoch (sinceTimestamp=0) — the episodic store's
  // retrieveSince filters on archivistProcessed=0, which is the authoritative
  // gate. last_run_at was previously used as the time window but causes drift:
  // if last_run_at advances past the newest unprocessed row (e.g. clock skew,
  // state written after data), retrieveSince returns 0 events forever.
  // The processed flag never has this problem — it's set only after successful
  // distillation and cleared only by explicit reset.
  const events = await episodicStore.retrieveSince(0, cfg.maxEventsPerRun);

  if (events.length === 0) {
    // Do NOT advance state — retrieval may have failed silently (C3)
    return { patternsExtracted: [], eventsProcessed: 0, eventsPruned: 0, fromFallback: false };
  }

  // Step 2: Run summarization pass with retries
  let patterns: PatternExtraction[] = [];
  let fromFallback = false;
  let lastError: unknown;

  // Read existing keys so the model can update rather than re-duplicate
  let existingKeys: { lessons: string[]; domain: string[] } | undefined;
  try {
    const facts = getFacts(workspacePath);
    existingKeys = {
      lessons: Object.keys(facts.lessons_learned ?? {}),
      domain: Object.keys(facts.domain_context ?? {}),
    };
  } catch {
    // Best-effort — prompt works without existing keys
  }

  const prompt = buildArchivistPrompt(events, existingKeys);

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      const raw = await callModel(prompt);
      patterns = parsePatterns(raw);
      lastError = undefined;
      // Log any per-item soft-drops from the parser so observability isn't
      // silent. parsePatterns now drops bad rows instead of throwing the
      // whole batch (which used to freeze the loop on a single null value).
      if (parsePatternErrors.length > 0) {
        semanticStore.appendArchivistLog(
          "parse_partial",
          `parsed=${patterns.length}, dropped=${parsePatternErrors.length}: ${parsePatternErrors.slice(0, 5).join("; ")}`,
        );
      }
      break;
    } catch (err) {
      lastError = err;
      if (attempt === cfg.maxRetries) {
        // All attempts failed — do NOT mark events processed and do NOT
        // advance last_run_at. Leave them for the next archivist run to retry.
        // Marking processed on LLM failure silently discards data.
        fromFallback = true;
      }
    }
  }

  // If model failed entirely, bail without touching processed flags or state.
  if (fromFallback) {
    semanticStore.appendArchivistLog(
      "distill_failed",
      `Model failed after ${cfg.maxRetries + 1} attempt(s) on ${events.length} events — will retry next run. Last error: ${errorMessage(lastError)}`,
    );
    return {
      patternsExtracted: [],
      eventsProcessed: 0,
      eventsPruned: 0,
      fromFallback: true,
      lastError: errorMessage(lastError),
    };
  }

  // Step 3: Apply each pattern via CRUD classifier (CR_OODA_ARCHIVIST_CRUD_CLASSIFIER).
  // All writes happen before any event marking (C1 ordering).
  const actionCounts: ActionCounts = {
    add: 0,
    update: 0,
    delete: 0,
    noop: 0,
    believe: 0,
    rejected: 0,
  };

  // Resolve current values once from the facts snapshot
  let currentFacts: Awaited<ReturnType<typeof getFacts>> | undefined;
  try {
    currentFacts = getFacts(workspacePath);
  } catch {
    // Best-effort — proceed with undefined currentValue checks
  }

  for (const pattern of patterns) {
    const section = currentFacts?.[pattern.section as keyof typeof currentFacts] as
      | Record<string, unknown>
      | undefined;
    const currentValue = section && typeof section === "object" ? section[pattern.key] : undefined;

    const result = await applyPatternAction(workspacePath, pattern, semanticStore, currentValue);

    if (!result.applied) {
      actionCounts.rejected++;
      semanticStore.appendArchivistLog(
        `pattern_${result.action.toLowerCase()}_rejected`,
        `${pattern.section}.${pattern.key}: ${result.rejectedReason ?? "unknown"}`,
      );
      continue;
    }

    switch (result.action) {
      case "ADD":
        actionCounts.add++;
        break;
      case "UPDATE":
        actionCounts.update++;
        break;
      case "DELETE":
        actionCounts.delete++;
        break;
      case "NOOP":
        actionCounts.noop++;
        break;
      case "BELIEVE":
        actionCounts.believe++;
        break;
    }

    semanticStore.appendArchivistLog(
      `pattern_${result.action.toLowerCase()}`,
      `${pattern.section}.${pattern.key}: ${pattern.reason}`,
    );
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

  // Fetch all recent events once — reused by steps 3c, 9, 10, 11.
  // Previously each step called retrieveSince(0, 10_000) independently,
  // causing 4 redundant full table scans per archivist run.
  let allRecent: EpisodicEvent[] = [];
  try {
    allRecent = await episodicStore.retrieveSince(0, 10_000);
  } catch {
    // Best-effort — supplementary steps degrade gracefully
  }

  // Step 3c (O5): Outcome stats — summarize outcome data into KNOWLEDGE.json
  try {
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

  // Step 6: Prune old processed events.
  // CR_OODA_LEARNED_FORGETTING: prefer selective delete-by-id using the
  // usefulness policy when the store supports it; fall back to the legacy
  // blind age-based prune when it doesn't. The policy protects high-importance
  // events, outcome-labeled decisions, recently-touched memories, and any
  // category in the allowlist (default: decision).
  const pruneThreshold = Date.now() - cfg.pruneAfterDays * 24 * 60 * 60 * 1000;
  let eventsPruned = 0;
  if (episodicStore.delete) {
    const candidates = await episodicStore.retrieveSince(0, 10_000);
    const { drop } = partitionForPrune(
      candidates,
      { ...DEFAULT_FORGETTING_POLICY, olderThanMs: cfg.pruneAfterDays * 24 * 60 * 60 * 1000 },
      Date.now(),
    );
    for (const e of drop) {
      try {
        await episodicStore.delete(e.id);
        eventsPruned++;
      } catch {
        // best-effort; keep going with remaining candidates
      }
    }
  } else {
    eventsPruned = await episodicStore.prune(pruneThreshold, true);
  }

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
      const domainStats = aggregateDomainOutcomes(allRecent);

      // Attach grounded scores from the metric registry when available
      if (metricRegistry && metricContext) {
        for (const stats of domainStats) {
          const result = await metricRegistry.compute(stats.domain, metricContext);
          if (result) {
            stats.groundedScore = result.score;
            stats.groundedMetricSource = result.description;

            // Log discrepancy between LLM labels and grounded metric
            if (Math.abs(result.score - stats.successRate) > 0.3) {
              semanticStore.appendArchivistLog(
                "metric_discrepancy",
                `Domain ${stats.domain}: grounded=${result.score.toFixed(2)} vs LLM-labels=${stats.successRate.toFixed(2)} (${result.description})`,
              );
            }
          }
        }
      }

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

  // Step 9.5 (Capability Uplift): distortion index + axis priors + critical failure emission.
  // Decoupled from priorities so it runs even on bootstrap workspaces where PRIORITIES.json is absent.
  try {
    // Distortion samples: per-domain approval-vs-grounded drift snapshot.
    if (priorities) {
      const freshStats = aggregateDomainOutcomes(allRecent);
      if (metricRegistry && metricContext) {
        for (const stats of freshStats) {
          const result = await metricRegistry.compute(stats.domain, metricContext);
          if (result) {
            stats.groundedScore = result.score;
            stats.groundedMetricSource = result.description;
          }
        }
      }
      const now = Date.now();
      for (const stats of freshStats) {
        const entry = priorities.domains[stats.domain];
        const approvalCount = Number.isFinite(entry?.approval_count) ? entry!.approval_count : 0;
        const overrideCount = Number.isFinite(entry?.override_count) ? entry!.override_count : 0;
        appendDistortionSample(workspacePath, {
          domain: stats.domain,
          timestamp: now,
          measured: stats.successRate,
          grounded: stats.groundedScore ?? stats.successRate,
          approvalCount,
          overrideCount,
        });
      }

      // Per-domain distortion regime computed from the sidecar history.
      const allHistory = readDistortionHistory(workspacePath);
      const domainsSeen = new Set<string>(allHistory.map((s) => s.domain));
      for (const domain of domainsSeen) {
        const reading = computeDistortion(
          allHistory.filter((s) => s.domain === domain),
          DEFAULT_DISTORTION_WINDOW,
        );
        if (reading.regime === "campbell_suspected") {
          semanticStore.appendArchivistLog(
            "campbell_suspected",
            `Domain ${domain}: ${reading.evidence.join("; ")}`,
          );
          // CR_OODA_CAUSAL_RETRIEVAL: attach the most recent failure
          // antecedents so meta-reviewer sees what preceded this regime shift
          // without re-querying. Domain-filter is best-effort; rows without
          // matching actionId joins are silently skipped.
          const antecedents = formatAntecedents(
            findAntecedents(allRecent, {
              outcome: "failure",
              limit: 5,
            }),
          );
          appendCriticalFailure(workspacePath, {
            type: "criticalFailure",
            timestamp: new Date().toISOString(),
            actionId: `distortion-${domain}-${now}`,
            expectedOutcome: {
              actionId: `distortion-${domain}-${now}`,
              description: `Grounded metric for ${domain} tracks approval signal`,
              successSignal: "grounded_tracks_measured",
              failureSignal: "campbell_suspected",
              domain,
            },
            actualOutcome: {
              source: "inferred",
              confidence: Math.max(reading.campbellIndex, 0.7),
              reasoning: `campbell_suspected regime: ${reading.evidence.join("; ")}`,
            },
            severity: "critical",
            implicated_rule: "distortion.campbell_regime",
            ...(antecedents.length > 0 ? { antecedents } : {}),
          });
        } else if (reading.regime === "goodhart_warning") {
          semanticStore.appendArchivistLog(
            "goodhart_warning",
            `Domain ${domain}: ${reading.evidence.join("; ")}`,
          );
        }
      }
    }

    // Axis priors: aggregate failure-axis evidence from episodic events + sidecar.
    const errorTagMap = readErrorTagsSidecar(workspacePath);
    if (errorTagMap.size > 0) {
      const enriched = allRecent.map((e) => {
        const tags = errorTagMap.get(e.id);
        return tags ? { ...e, errorTags: tags } : e;
      });
      // CR_OODA_EMOTIONAL_TAGGING: weight error-tag contributions by the
      // SITREP priority at capture so high-arousal failures dominate the
      // axis-prior signal used by triage and meta-review.
      const priors = aggregateAxisPriors(enriched, DEFAULT_AXIS_WINDOW_MS, inferDomain, {
        priorityWeighting: true,
      });
      if (priors.length > 0) {
        const file = path.join(workspacePath, AXIS_PRIORS_FILE);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(
          file,
          JSON.stringify(
            { generatedAt: new Date().toISOString(), windowDays: 30, priors },
            null,
            2,
          ) + "\n",
          "utf-8",
        );
        semanticStore.appendArchivistLog(
          "axis_priors_refreshed",
          `Aggregated ${priors.length} axis-prior row(s) across domains`,
        );
      }
    }
  } catch (err) {
    semanticStore.appendArchivistLog("capability_uplift_error", errorMessage(err));
  }

  // Step 10 (K3): Export AMF-relevant lessons to shared knowledge file
  if (patterns.length > 0) {
    try {
      const { exportOodaLessons } = await import("./cross-project.js");
      const amfLessonsPath = path.join(
        workspacePath,
        "..",
        "amf-platform",
        "knowledge",
        "ooda-lessons.json",
      );
      const exported = exportOodaLessons(amfLessonsPath, patterns, allRecent);
      if (exported > 0) {
        semanticStore.appendArchivistLog(
          "amf_lessons_exported",
          `Exported ${exported} AMF-relevant lesson(s) to ooda-lessons.json`,
        );
      }
    } catch {
      // Best-effort — cross-project export is supplementary
    }
  }

  // Step 11 (K5): Promote high-importance AMF findings into KNOWLEDGE.json
  try {
    const { promoteAMFFindings } = await import("./cross-project.js");
    const promoted = promoteAMFFindings(allRecent, semanticStore);
    if (promoted > 0) {
      semanticStore.appendArchivistLog(
        "amf_findings_promoted",
        `Promoted ${promoted} high-importance AMF finding(s) to KNOWLEDGE.json`,
      );
    }
  } catch {
    // Best-effort — AMF promotion is supplementary
  }

  return {
    patternsExtracted: patterns,
    eventsProcessed: events.length,
    eventsPruned,
    fromFallback,
    lastError: lastError ? errorMessage(lastError) : undefined,
    actionCounts,
  };
}

// ============================================================================
// ArchivistRunner — Async Singleton
// ============================================================================

/** Logger interface matching the subset used by ArchivistRunner. */
export interface ArchivistLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

/** Dependencies injected at construction time. */
export interface ArchivistRunnerDeps {
  workspacePath: string;
  logger: ArchivistLogger;
  getEpisodicStore: () => Promise<EpisodicStore | null>;
  makeSemanticStore: () => SemanticStore;
  callModel: ModelCallFn;
  /** Return current priorities, or undefined if unavailable. */
  getPriorities: () => PrioritiesFile | undefined;
  /** Health reporting callbacks. */
  pingHealth: (component: string, data: Record<string, unknown>) => void;
  pingHealthError: (component: string, error: string) => void;
  /** Optional: grounded metric registry for evaluation harness. */
  metricRegistry?: MetricRegistry;
  /** Optional: builds the metric context for grounded score computation. */
  makeMetricContext?: (episodicStore: EpisodicStore) => MetricContext;
}

/**
 * Async singleton that owns the archivist lifecycle.
 *
 * - Instantiated once during plugin registration.
 * - `nudge()` is called from every `agent_end` — increments turn counter,
 *   persists state, and if the archivist is due, kicks off a background run
 *   via setImmediate. At most one run at a time.
 * - `callModel` uses direct Anthropic API calls (no subagent/request context
 *   needed), so running from agent_end is safe.
 */
export class ArchivistRunner {
  private running = false;
  private turnCount: number;
  private readonly deps: ArchivistRunnerDeps;

  constructor(deps: ArchivistRunnerDeps) {
    this.deps = deps;

    // Restore turn count from persisted state
    try {
      const state = readState(deps.workspacePath);
      this.turnCount = state.last_processed_turn;
    } catch {
      this.turnCount = 0;
    }
  }

  /** True while a run is in progress. */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Called from `agent_end`. Increments the turn counter, persists state,
   * and — if the archivist is due and not already running — kicks off a
   * background run via setImmediate.
   */
  nudge(): void {
    this.turnCount++;
    this.deps.pingHealth("agent_end", { turnCount: this.turnCount });

    // Persist turn counter
    let currentState: ArchivistState;
    try {
      currentState = readState(this.deps.workspacePath);
      writeState(this.deps.workspacePath, {
        ...currentState,
        last_processed_turn: this.turnCount,
        turns_since_last_archivist: currentState.turns_since_last_archivist + 1,
      });
      currentState = {
        ...currentState,
        turns_since_last_archivist: currentState.turns_since_last_archivist + 1,
      };
    } catch (err) {
      this.deps.logger.warn(`memory-ooda: failed to persist turn count: ${String(err)}`);
      return;
    }

    if (this.running) return;

    let turnInterval: number;
    try {
      const priorities = this.deps.getPriorities();
      turnInterval = priorities?.thresholds?.archivist_turn_interval ?? 15;
    } catch {
      turnInterval = 15;
    }

    if (!shouldRunArchivist(currentState, turnInterval)) return;

    // Archivist is due — run in setImmediate so it never blocks the user's
    // response. callModel uses direct Anthropic API (no gateway subagent),
    // so no request context is needed.
    this.running = true;
    this.deps.logger.info("memory-ooda: archivist starting (background)");
    setImmediate(() => {
      this.execute(turnInterval)
        .catch((err) => {
          this.deps.logger.warn(`memory-ooda: archivist background run failed: ${String(err)}`);
          this.deps.pingHealthError("archivist", String(err));
        })
        .finally(() => {
          this.running = false;
        });
    });
  }

  private async execute(turnInterval: number): Promise<void> {
    const episodicStore = await this.deps.getEpisodicStore();
    if (!episodicStore) return;

    const semanticStore = this.deps.makeSemanticStore();
    const priorities = this.deps.getPriorities();
    const metricContext = this.deps.makeMetricContext?.(episodicStore);

    const result = await runArchivist(
      this.deps.workspacePath,
      0,
      episodicStore,
      semanticStore,
      this.deps.callModel,
      { turnInterval },
      priorities,
      this.deps.metricRegistry,
      metricContext,
    );

    if (result.fromFallback) {
      this.deps.logger.warn(
        `memory-ooda: archivist model failed — will retry. Error: ${result.lastError ?? "unknown"}`,
      );
      this.deps.pingHealthError("archivist", result.lastError ?? "model failed");
    } else {
      this.deps.logger.info(
        `memory-ooda: archivist completed — ${result.eventsProcessed} events, ${result.patternsExtracted.length} patterns`,
      );
      this.deps.pingHealth("archivist", {
        eventsProcessed: result.eventsProcessed,
        patternsExtracted: result.patternsExtracted.length,
      });
    }
  }
}
