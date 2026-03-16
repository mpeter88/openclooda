/**
 * Archivist — Async Tier 2 → Tier 3 Distillation
 *
 * Runs every N turns (configurable via thresholds.archivist_turn_interval).
 * Reads recent episodic events from LanceDB, runs a summarization pass
 * to extract stable patterns, and upserts them into KNOWLEDGE.json.
 *
 * Purely async, outside the hot path. Feature-flagged off by default.
 */

import fs from "node:fs";
import path from "node:path";
import { errorMessage, stripCodeFences } from "../../src/agents/ooda/parse-utils.js";
import type { ModelCallFn } from "../../src/agents/ooda/triage.js";

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
}

/** Abstraction over Tier 2 store for testability. */
export interface EpisodicStore {
  retrieveSince(sinceTimestamp: number, limit?: number): Promise<EpisodicEvent[]>;
  markProcessed(id: string): Promise<void>;
  prune(olderThanMs: number, onlyProcessed?: boolean): Promise<number>;
}

/** Abstraction over Tier 3 store for testability. */
export interface SemanticStore {
  upsertFact(section: string, key: string, value: unknown): void;
  appendArchivistLog(action: string, reason: string): void;
}

/** Persisted state across archivist runs. */
export interface ArchivistState {
  last_run_turn: number;
  last_run_at: string;
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
  section: "stack" | "projects" | "people" | "domain_context";
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
    return { last_run_turn: 0, last_run_at: "1970-01-01T00:00:00Z" };
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw);

  if (typeof parsed.last_run_turn !== "number" || typeof parsed.last_run_at !== "string") {
    throw new Error("Invalid .archivist-state.json: missing last_run_turn or last_run_at");
  }

  if (isNaN(new Date(parsed.last_run_at).getTime())) {
    throw new Error("Invalid .archivist-state.json: last_run_at is not a valid timestamp");
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
 * Determine whether the Archivist should run based on the current turn
 * count and the configured interval.
 */
export function shouldRunArchivist(
  currentTurn: number,
  state: ArchivistState,
  turnInterval: number,
): boolean {
  if (turnInterval <= 0) return false;
  return currentTurn - state.last_run_turn >= turnInterval;
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

  return `You are the Archivist, a pattern-extraction agent that distills episodic memory into stable semantic facts.

Given a batch of recent episodic events from a user's AI assistant, identify stable patterns that should be promoted to long-term semantic memory.

## Episodic Events
${eventsBlock}

## What to Extract
Look for:
- Recurring preferences (e.g., user consistently prefers async communication)
- Technology patterns (e.g., user keeps using TypeScript + Vitest)
- People patterns (e.g., "Alex" appears frequently as a collaborator)
- Project patterns (e.g., a project has shifted from active to paused)
- Domain context (e.g., user is currently focused on infrastructure work)

Only extract patterns supported by multiple events or high-importance signals. Do not promote one-off observations.

## Output Format
Respond with raw JSON only. Do not wrap in code fences or add any text outside the JSON.

[
  {
    "section": "<stack | projects | people | domain_context>",
    "key": "<identifier for this fact>",
    "value": <string for stack/domain_context, or object for projects/people>,
    "reason": "<brief explanation of which events support this pattern>"
  }
]

Return an empty array [] if no stable patterns are found.

## Section Value Formats
- stack: string value (e.g., "TypeScript 5.x")
- domain_context: string value (e.g., "Currently focused on OODA agent implementation")
- projects: object with { "status": "active"|"paused"|"complete", "priority_domain": "<domain>", "key_constraint": "<constraint>", "notes": "<notes>" }
- people: object with { "role": "<role>", "relationship": "<relationship>", "communication_preference": "<preference>", "notes": "<notes>" }

## Constraints
- Maximum 10 patterns per batch
- Each pattern must cite at least 2 supporting events in the reason
- Prefer updating existing facts over creating new ones
- Never infer sensitive personal information (health, finances, relationships beyond professional)

Verify your JSON is syntactically valid before responding.`;
}

// ============================================================================
// Response Parsing
// ============================================================================

const VALID_SECTIONS = new Set(["stack", "projects", "people", "domain_context"]);

export function parsePatterns(raw: string): PatternExtraction[] {
  const cleaned = stripCodeFences(raw);
  const parsed = JSON.parse(cleaned);

  if (!Array.isArray(parsed)) {
    throw new Error("Archivist response must be a JSON array");
  }

  if (parsed.length > 10) {
    throw new Error(`Too many patterns: ${parsed.length} (max 10)`);
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
      (obj.section === "stack" || obj.section === "domain_context") &&
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
export async function runArchivist(
  workspacePath: string,
  currentTurn: number,
  episodicStore: EpisodicStore,
  semanticStore: SemanticStore,
  callModel: ModelCallFn,
  config?: Partial<ArchivistConfig>,
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

  // Step 7: Update state
  writeState(workspacePath, {
    last_run_turn: currentTurn,
    last_run_at: new Date().toISOString(),
  });

  return {
    patternsExtracted: patterns,
    eventsProcessed: events.length,
    eventsPruned,
    fromFallback,
    lastError: lastError ? errorMessage(lastError) : undefined,
  };
}
