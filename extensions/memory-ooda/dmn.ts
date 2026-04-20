/**
 * CR_OODA_DMN_INTEGRATION_LOOP — Default Mode Network analog.
 *
 * Source: Mattson 2014. The DMN integrates prior patterns, rehearses likely
 * futures, and tracks consciousness level. Its activity decays in deep sleep
 * and ramps back on waking — a good analog for "idle user" decay so background
 * work tapers instead of burning API quota on an absent operator.
 *
 * This module provides the pure scheduling + dispatch logic. The memory-ooda
 * plugin register() wires in the service that actually ticks + fires work.
 */

import fs from "node:fs";
import path from "node:path";
import { DEFAULT_ADAPTIVE_CONFIG, runAdaptiveChair, type ChairSampleFn } from "./adaptive-chair.js";
import { appendCriticalFailure, type EpisodicEvent, type EpisodicStore } from "./archivist.js";
import { getBeliefs, reinforceBelief, weakenBelief } from "./beliefs.js";
import { computeDistortion, readDistortionHistory } from "./distortion-index.js";
import { stripCodeFences } from "./parse-utils.js";
import { getPriorities } from "./priorities.js";
import { addArchivistProposals, type ProposalCandidate } from "./proposals.js";
import { getFacts } from "./semantic-memory.js";
import { readSitrepLog, type SitrepLogEntry } from "./sitrep-log.js";
import { runTriage, type ModelCallFn, type TriageInput } from "./triage.js";
import type {
  BeliefEvidence,
  CriticalFailureEvent,
  DistortionReading,
  KnowledgeFile,
  SITREP,
} from "./types.js";

// ============================================================================
// Cadence buckets
// ============================================================================

export type DMNBucket = "active" | "recent" | "idle" | "dormant" | "asleep";

export interface DMNCadenceConfig {
  enabled: boolean;
  /** Active bucket interval (ms). User turn within 5 minutes. */
  active_interval_ms: number;
  /** Recent bucket interval (ms). User turn within 30 minutes. */
  recent_interval_ms: number;
  /** Idle bucket interval (ms). User turn within 4 hours. */
  idle_interval_ms: number;
  /** Dormant bucket interval (ms). User turn within 24 hours. */
  dormant_interval_ms: number;
  /** Absence threshold (ms) beyond which DMN pauses entirely. */
  asleep_after_ms: number;
}

export const DEFAULT_DMN_CONFIG: DMNCadenceConfig = {
  enabled: true,
  active_interval_ms: 90 * 1000, // 90s
  recent_interval_ms: 5 * 60 * 1000, // 5 min
  idle_interval_ms: 15 * 60 * 1000, // 15 min
  dormant_interval_ms: 60 * 60 * 1000, // 60 min
  asleep_after_ms: 24 * 60 * 60 * 1000, // 24 h
};

/**
 * Map absence duration (ms) → bucket. Bucket boundaries:
 *   0 – 5 min → active
 *   5 – 30 min → recent
 *   30 min – 4 h → idle
 *   4 – 24 h → dormant
 *   > 24 h → asleep (paused)
 */
export function selectBucket(
  absenceMs: number,
  config: DMNCadenceConfig = DEFAULT_DMN_CONFIG,
): DMNBucket {
  if (absenceMs >= config.asleep_after_ms) return "asleep";
  if (absenceMs >= 4 * 60 * 60 * 1000) return "dormant";
  if (absenceMs >= 30 * 60 * 1000) return "idle";
  if (absenceMs >= 5 * 60 * 1000) return "recent";
  return "active";
}

/** Cadence for a bucket; `asleep` returns Number.POSITIVE_INFINITY (paused). */
export function cadenceMs(
  bucket: DMNBucket,
  config: DMNCadenceConfig = DEFAULT_DMN_CONFIG,
): number {
  switch (bucket) {
    case "active":
      return config.active_interval_ms;
    case "recent":
      return config.recent_interval_ms;
    case "idle":
      return config.idle_interval_ms;
    case "dormant":
      return config.dormant_interval_ms;
    case "asleep":
      return Number.POSITIVE_INFINITY;
  }
}

// ============================================================================
// Work units
// ============================================================================

export type DMNWorkKind =
  | "belief_rescore"
  | "retrospective_chair"
  | "rehearsal"
  | "pattern_distill"
  | "campbell_watchdog";

export interface DMNWorkUnitFlags {
  belief_rescore: boolean;
  retrospective_chair: boolean;
  rehearsal: boolean;
  pattern_distill: boolean;
  campbell_watchdog: boolean;
}

export const DEFAULT_WORK_UNIT_FLAGS: DMNWorkUnitFlags = {
  // Free (no LLM): default on in all workspaces.
  belief_rescore: true,
  campbell_watchdog: true,
  // LLM-backed: off by default. Operators opt in via PRIORITIES.json once they
  // have budget headroom; each tick runs at most one of these, so total cost
  // stays bounded by cadence.
  retrospective_chair: false,
  rehearsal: false,
  pattern_distill: false,
};

/** Which kinds of work are valid for a bucket. Asleep excludes everything. */
export function eligibleWorkKinds(bucket: DMNBucket): DMNWorkKind[] {
  switch (bucket) {
    case "active":
    case "recent":
      return ["belief_rescore", "retrospective_chair", "rehearsal", "campbell_watchdog"];
    case "idle":
    case "dormant":
      return ["belief_rescore", "pattern_distill", "campbell_watchdog"];
    case "asleep":
      return [];
  }
}

/** Pick the next work unit — round-robin across eligible kinds, honouring flags. */
export function selectWorkUnit(
  bucket: DMNBucket,
  state: DMNState,
  flags: DMNWorkUnitFlags = DEFAULT_WORK_UNIT_FLAGS,
): DMNWorkKind | undefined {
  const pool = eligibleWorkKinds(bucket).filter((k) => flags[k]);
  if (pool.length === 0) return undefined;
  const lastIdx = state.last_work_kind_index ?? -1;
  const nextIdx = (lastIdx + 1) % pool.length;
  return pool[nextIdx];
}

/**
 * Update rotation state after a work unit is selected. Caller passes the kind
 * that was actually dispatched (which may differ from selectWorkUnit if flags
 * change mid-tick).
 */
export function advanceWorkUnitRotation(
  state: DMNState,
  dispatched: DMNWorkKind,
  bucket: DMNBucket,
  flags: DMNWorkUnitFlags = DEFAULT_WORK_UNIT_FLAGS,
): DMNState {
  const pool = eligibleWorkKinds(bucket).filter((k) => flags[k]);
  const idx = pool.indexOf(dispatched);
  return {
    ...state,
    last_work_kind_index: idx === -1 ? state.last_work_kind_index : idx,
    work_units_completed: (state.work_units_completed ?? 0) + 1,
    by_kind: {
      ...state.by_kind,
      [dispatched]: (state.by_kind?.[dispatched] ?? 0) + 1,
    },
    last_tick_at: new Date().toISOString(),
  };
}

// ============================================================================
// Persistent state
// ============================================================================

const DMN_STATE_FILENAME = ".dmn-state.json";
const DMN_LOG_FILENAME = ".dmn-log.jsonl";

export interface DMNState {
  last_tick_at: string | null;
  bucket: DMNBucket;
  ticks_since_last_user_turn: number;
  work_units_completed: number;
  by_kind: Partial<Record<DMNWorkKind, number>>;
  last_work_kind_index: number;
  /** Daily budget counters. LLM-backed work increments llm_calls_24h. */
  llm_calls_24h: number;
  llm_calls_24h_window_start: string | null;
}

export function dmnStatePath(workspacePath: string): string {
  return path.join(workspacePath, DMN_STATE_FILENAME);
}

export function dmnLogPath(workspacePath: string): string {
  return path.join(workspacePath, DMN_LOG_FILENAME);
}

export function readDMNState(workspacePath: string): DMNState {
  const file = dmnStatePath(workspacePath);
  if (!fs.existsSync(file)) {
    return {
      last_tick_at: null,
      bucket: "active",
      ticks_since_last_user_turn: 0,
      work_units_completed: 0,
      by_kind: {},
      last_work_kind_index: -1,
      llm_calls_24h: 0,
      llm_calls_24h_window_start: null,
    };
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as DMNState;
  } catch {
    return {
      last_tick_at: null,
      bucket: "active",
      ticks_since_last_user_turn: 0,
      work_units_completed: 0,
      by_kind: {},
      last_work_kind_index: -1,
      llm_calls_24h: 0,
      llm_calls_24h_window_start: null,
    };
  }
}

export function writeDMNState(workspacePath: string, state: DMNState): void {
  const file = dmnStatePath(workspacePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, file);
}

export interface DMNLogRow {
  timestamp: string;
  bucket: DMNBucket;
  kind: DMNWorkKind;
  outcome: "success" | "noop" | "error";
  details?: string;
  durationMs?: number;
}

export function appendDMNLog(workspacePath: string, row: DMNLogRow): void {
  const file = dmnLogPath(workspacePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + "\n", "utf-8");
}

// ============================================================================
// Daily budget tracking
// ============================================================================

export const DEFAULT_DAILY_LLM_BUDGET = 50;

/**
 * Returns true iff an LLM-backed work unit is within the 24h budget. Resets
 * the window when the oldest tracked window start is more than 24h old.
 */
export function withinLLMBudget(
  state: DMNState,
  now: number = Date.now(),
  budget: number = DEFAULT_DAILY_LLM_BUDGET,
): boolean {
  const windowStart = state.llm_calls_24h_window_start
    ? new Date(state.llm_calls_24h_window_start).getTime()
    : now;
  const ageMs = now - windowStart;
  if (ageMs >= 24 * 60 * 60 * 1000) {
    return true; // window rolls over when caller tries; treat as fresh
  }
  return state.llm_calls_24h < budget;
}

/**
 * Increment the LLM-call counter, rolling the 24h window if needed. Returns
 * the updated state (caller persists).
 */
export function recordLLMCall(state: DMNState, now: number = Date.now()): DMNState {
  const windowStart = state.llm_calls_24h_window_start
    ? new Date(state.llm_calls_24h_window_start).getTime()
    : 0;
  const ageMs = now - windowStart;
  if (ageMs >= 24 * 60 * 60 * 1000 || windowStart === 0) {
    return {
      ...state,
      llm_calls_24h: 1,
      llm_calls_24h_window_start: new Date(now).toISOString(),
    };
  }
  return {
    ...state,
    llm_calls_24h: state.llm_calls_24h + 1,
  };
}

export function isLLMBackedKind(kind: DMNWorkKind): boolean {
  return kind === "retrospective_chair" || kind === "rehearsal" || kind === "pattern_distill";
}

// ============================================================================
// Campbell watchdog — free work unit, no LLM, pure file read
// ============================================================================

export interface CampbellWatchdogResult {
  triggered: boolean;
  regime: DistortionReading["regime"] | "no_data";
  domain?: string;
}

/**
 * Re-read distortion history and check whether a Campbell-suspected regime has
 * appeared since the last tick. If so, emit a `criticalFailure` event; the
 * existing meta-reviewer pipeline will pick it up on next run.
 *
 * Pure vs its dependencies: takes fs-bound helpers as args so tests can mock.
 */
export function runCampbellWatchdog(
  workspacePath: string,
  options: { windowDays?: number; minSamples?: number } = {},
): CampbellWatchdogResult {
  const window = {
    days: options.windowDays ?? 30,
    minSamples: options.minSamples ?? 10,
  };
  const history = readDistortionHistory(workspacePath);
  if (history.length === 0) {
    return { triggered: false, regime: "no_data" };
  }
  const domainsSeen = new Set(history.map((s) => s.domain));
  for (const domain of domainsSeen) {
    const reading = computeDistortion(
      history.filter((s) => s.domain === domain),
      window,
    );
    if (reading.regime === "campbell_suspected") {
      const event: CriticalFailureEvent = {
        type: "criticalFailure",
        timestamp: new Date().toISOString(),
        actionId: `dmn-campbell-${domain}-${Date.now()}`,
        expectedOutcome: {
          actionId: `dmn-campbell-${domain}-${Date.now()}`,
          description: `DMN watchdog expects grounded tracking for ${domain}`,
          successSignal: "grounded_tracks_measured",
          failureSignal: "campbell_suspected",
          domain,
        },
        actualOutcome: {
          source: "inferred",
          confidence: Math.max(reading.campbellIndex, 0.7),
          reasoning: `DMN watchdog: ${reading.evidence.join("; ")}`,
        },
        severity: "critical",
        implicated_rule: "dmn.campbell_watchdog",
      };
      appendCriticalFailure(workspacePath, event);
      return { triggered: true, regime: reading.regime, domain };
    }
  }
  return { triggered: false, regime: "healthy" };
}

// ============================================================================
// Scheduler — testable factory around setTimeout lifecycle
// ============================================================================

export interface DMNSchedulerDeps {
  /** Fires on each tick. Resolves when the tick has completed its I/O. */
  tick: () => Promise<void>;
  /** Returns the ms-delay for the next scheduled tick. Called after each tick. */
  nextDelayMs: () => number;
  /** Injected for tests; defaults to global `setTimeout`. */
  setTimeoutFn?: typeof setTimeout;
  /** Injected for tests; defaults to global `clearTimeout`. */
  clearTimeoutFn?: typeof clearTimeout;
  /** Called when a tick throws so callers can log. Defaults to no-op. */
  onError?: (err: unknown) => void;
}

export interface DMNScheduler {
  start(initialDelayMs: number): void;
  stop(): void;
  /** For tests — how many live timers the scheduler currently owns (0 or 1). */
  pendingCount(): number;
}

/**
 * Build a scheduler that runs `tick` at the cadence `nextDelayMs` returns.
 * Self-rescheduling (not setInterval) so each tick re-evaluates the bucket.
 * `start` is idempotent — calling twice clears the prior timer before setting
 * a new one. `stop` cancels any in-flight timer; pending ticks still finish
 * but a new timer is not scheduled.
 */
export function createDMNScheduler(deps: DMNSchedulerDeps): DMNScheduler {
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function schedule(ms: number): void {
    if (stopped) return;
    if (timer) {
      clearTimeoutFn(timer);
      timer = null;
    }
    if (!Number.isFinite(ms) || ms < 0) return;
    timer = setTimeoutFn(() => {
      timer = null;
      void runOnce();
    }, ms);
    // Tolerate missing unref on fake timers in tests.
    if (timer && typeof (timer as unknown as { unref?: () => void }).unref === "function") {
      (timer as unknown as { unref: () => void }).unref();
    }
  }

  async function runOnce(): Promise<void> {
    try {
      await deps.tick();
    } catch (err) {
      deps.onError?.(err);
    }
    if (!stopped) {
      schedule(deps.nextDelayMs());
    }
  }

  return {
    start(initialDelayMs: number) {
      stopped = false;
      schedule(initialDelayMs);
    },
    stop() {
      stopped = true;
      if (timer) {
        clearTimeoutFn(timer);
        timer = null;
      }
    },
    pendingCount() {
      return timer ? 1 : 0;
    },
  };
}

// ============================================================================
// Belief re-score — free work unit, no LLM, lightweight evidence match
// ============================================================================

export interface BeliefRescoreResult {
  reinforced: string[];
  weakened: string[];
  skipped_no_recent_events: boolean;
}

/**
 * Re-score currently-active beliefs against episodic events captured since the
 * last tick. Heuristic match: a belief's claim text shares two or more non-stop
 * tokens with an outcome-labeled event text → that event is evidence.
 *
 *   outcome === "success" + tokens overlap → reinforceBelief (delta capped at 0.02)
 *   outcome === "failure" + tokens overlap → weakenBelief (delta capped at 0.02)
 *
 * Small deltas mean drift is gradual; even ten ticks per hour during the Active
 * bucket can't move a belief more than 0.2 per hour.
 */
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "to",
  "of",
  "in",
  "on",
  "at",
  "for",
  "with",
  "and",
  "or",
  "that",
  "this",
  "it",
  "was",
  "be",
  "by",
  "as",
  "from",
]);

function tokenize(text: string): Set<string> {
  const lower = text.toLowerCase();
  const tokens = lower.match(/[a-z][a-z0-9]{2,}/g) ?? [];
  const out = new Set<string>();
  for (const t of tokens) {
    if (!STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

function overlapCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

export function runBeliefRescore(
  workspacePath: string,
  recentEvents: EpisodicEvent[],
  options: { minOverlap?: number; reinforceDelta?: number; weakenDelta?: number } = {},
): BeliefRescoreResult {
  const minOverlap = options.minOverlap ?? 2;
  const reinforceDelta = options.reinforceDelta ?? 0.02;
  const weakenDelta = options.weakenDelta ?? 0.02;

  const outcomeEvents = recentEvents.filter(
    (e) => e.outcome && (e.outcome === "success" || e.outcome === "failure"),
  );
  if (outcomeEvents.length === 0) {
    return { reinforced: [], weakened: [], skipped_no_recent_events: true };
  }

  const beliefs = getBeliefs(workspacePath);
  const active = Object.values(beliefs.beliefs).filter((b) => !b.retired);
  if (active.length === 0) {
    return { reinforced: [], weakened: [], skipped_no_recent_events: false };
  }

  const reinforced: string[] = [];
  const weakened: string[] = [];
  for (const belief of active) {
    const claimTokens = tokenize(belief.claim);
    for (const ev of outcomeEvents) {
      const evTokens = tokenize(ev.text);
      if (overlapCount(claimTokens, evTokens) < minOverlap) continue;

      const evidence: BeliefEvidence = {
        at: new Date(ev.createdAt).toISOString(),
        source: "episodic",
        ref: ev.id,
        weight: 1,
      };
      try {
        if (ev.outcome === "success") {
          reinforceBelief(
            workspacePath,
            belief.id,
            evidence,
            Math.min(1, belief.confidence + reinforceDelta),
          );
          reinforced.push(belief.id);
        } else if (ev.outcome === "failure") {
          weakenBelief(
            workspacePath,
            belief.id,
            evidence,
            Math.max(0, belief.confidence - weakenDelta),
          );
          weakened.push(belief.id);
        }
      } catch {
        // If the belief was retired mid-loop, skip silently.
      }
      break; // one evidence hit per belief per tick — keep drift gradual
    }
  }
  return { reinforced, weakened, skipped_no_recent_events: false };
}

// ============================================================================
// Retrospective adaptive-chair — LLM-backed work unit
// ============================================================================

export interface RetrospectiveChairResult {
  evaluated: number;
  criticalEmitted: boolean;
  winnerShare?: number;
  sessionKey?: string;
}

/**
 * Scan recent SITREP log for high-priority decisions and re-run adaptive chair
 * sampling to check stability after the fact. If the verdict is unstable
 * (winnerShare < 0.6), append a `criticalFailure` of severity `warning` so the
 * meta-reviewer picks it up next run.
 *
 * Cost-bounded by the adaptive-chair config (min/max samples). Runs zero LLM
 * calls if no qualifying SITREP entry found.
 */
export async function runRetrospectiveChair(
  workspacePath: string,
  callModel: ModelCallFn,
  options: { priorityFloor?: number; lookbackMs?: number; archetypes?: string[] } = {},
): Promise<RetrospectiveChairResult> {
  const priorityFloor = options.priorityFloor ?? 7;
  const lookbackMs = options.lookbackMs ?? 60 * 60 * 1000;

  const today = new Date().toISOString().slice(0, 10);
  const entries = readSitrepLog(workspacePath, today);
  const cutoff = Date.now() - lookbackMs;
  const candidates = entries
    .filter((e) => new Date(e.timestamp).getTime() >= cutoff)
    .filter((e) => e.priority >= priorityFloor)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  if (candidates.length === 0) {
    return { evaluated: 0, criticalEmitted: false };
  }

  const target = candidates[0];
  const archetypes = options.archetypes ?? [
    "aggressive_fix",
    "minimal_viable_action",
    "observe_and_wait",
    "escalate",
  ];
  const prompt = `Given a past high-priority situation, pick the most defensible archetype label.

## Past observation
Session: ${target.sessionKey}
Priority: ${target.priority}/10
Attention: ${target.attention ?? "(none)"}

## Archetypes
${archetypes.map((a) => `- ${a}`).join("\n")}

Respond with raw JSON only:
{ "label": "<archetype>", "confidence": <0.0-1.0> }`;

  const sampleFn: ChairSampleFn = async (_attempt, _temperature) => {
    const raw = await callModel(prompt);
    try {
      const parsed = JSON.parse(stripCodeFences(raw)) as {
        label?: string;
        confidence?: number;
      };
      const label =
        typeof parsed.label === "string" && parsed.label.length > 0 ? parsed.label : "unclassified";
      const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0.5;
      return { label, confidence, raw };
    } catch {
      return { label: "unclassified", confidence: 0, raw };
    }
  };

  const adaptive = await runAdaptiveChair(sampleFn, {
    ...DEFAULT_ADAPTIVE_CONFIG,
    minSamples: 3,
    maxSamples: 5,
  });

  if (adaptive.winnerShare < 0.6) {
    const actionId = `dmn-retrospective-${target.sessionKey}-${Date.now()}`;
    appendCriticalFailure(workspacePath, {
      type: "criticalFailure",
      timestamp: new Date().toISOString(),
      actionId,
      expectedOutcome: {
        actionId,
        description: `DMN retrospective chair expects stable verdict for ${target.sessionKey}`,
        successSignal: "adaptive_chair_winnerShare_gte_0.6",
        failureSignal: "adaptive_chair_unstable",
        domain: "strategy",
      },
      actualOutcome: {
        source: "inferred",
        confidence: 0.7,
        reasoning: `DMN retrospective chair on P${target.priority} decision: winnerShare=${adaptive.winnerShare.toFixed(2)}, stabilizedAt=${adaptive.stabilizedAt}, forcedStop=${adaptive.forcedStop}`,
      },
      severity: "warning",
      implicated_rule: "dmn.retrospective_chair",
    });
    return {
      evaluated: 1,
      criticalEmitted: true,
      winnerShare: adaptive.winnerShare,
      sessionKey: target.sessionKey,
    };
  }

  return {
    evaluated: 1,
    criticalEmitted: false,
    winnerShare: adaptive.winnerShare,
    sessionKey: target.sessionKey,
  };
}

// ============================================================================
// Rehearsal — LLM-backed work unit
// ============================================================================

const DMN_REHEARSAL_FILENAME = ".dmn-rehearsals.jsonl";

export interface RehearsalResult {
  rehearsed: boolean;
  commitmentLabel?: string;
  cachedSitrep?: SITREP;
}

export interface RehearsalRow {
  rehearsedAt: string;
  commitment: string;
  syntheticObservation: string;
  sitrep: SITREP;
}

export function appendRehearsalRow(workspacePath: string, row: RehearsalRow): void {
  const file = path.join(workspacePath, DMN_REHEARSAL_FILENAME);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + "\n", "utf-8");
}

export function readRecentRehearsals(workspacePath: string, limit = 20): RehearsalRow[] {
  const file = path.join(workspacePath, DMN_REHEARSAL_FILENAME);
  if (!fs.existsSync(file)) return [];
  const rows: RehearsalRow[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed) as RehearsalRow);
    } catch {
      // skip
    }
  }
  return rows.slice(-limit);
}

/**
 * Pre-compute a triage pass for any knowledge.commitments firing in the next
 * 60 minutes. Result cached to `.dmn-rehearsals.jsonl` so when the real event
 * arrives, the before_agent_start flow can check for a matching rehearsal and
 * reuse the already-computed SITREP.
 */
export async function runRehearsal(
  workspacePath: string,
  callModel: ModelCallFn,
  options: { horizonMinutes?: number } = {},
): Promise<RehearsalResult> {
  const horizon = options.horizonMinutes ?? 60;
  let knowledge: KnowledgeFile;
  try {
    knowledge = getFacts(workspacePath);
  } catch {
    return { rehearsed: false };
  }
  const commitments = knowledge.commitments ?? [];
  if (commitments.length === 0) return { rehearsed: false };

  // Pick the first commitment with a label; real firing-time logic would use a
  // scheduler crossref. For the first ship we rehearse any labeled commitment.
  const target = commitments.find((c) => c.label && c.label.length > 0);
  if (!target) return { rehearsed: false };

  const synthetic = `You have "${target.label}" coming up in ${horizon} minutes. What should you prepare for?`;

  const priorities = getPriorities(workspacePath);
  const triageInput: TriageInput = {
    observation: synthetic,
    facts: knowledge,
    priorities,
  };
  const { sitrep } = await runTriage(triageInput, callModel);

  appendRehearsalRow(workspacePath, {
    rehearsedAt: new Date().toISOString(),
    commitment: target.label,
    syntheticObservation: synthetic,
    sitrep,
  });

  return {
    rehearsed: true,
    commitmentLabel: target.label,
    cachedSitrep: sitrep,
  };
}

// ============================================================================
// Pattern distillation — LLM-backed work unit (lightweight archivist)
// ============================================================================

export interface PatternDistillResult {
  candidatesAdded: number;
  eventsScanned: number;
}

/**
 * Lightweight archivist: scan recent unprocessed episodic events and propose
 * candidate patterns without upserting anything to KNOWLEDGE.json. Real
 * upserts continue to go through the main archivist (which has the admission
 * gate + temporal invariants). This unit is exploration, not mutation.
 */
export async function runPatternDistill(
  workspacePath: string,
  callModel: ModelCallFn,
  episodicStore: EpisodicStore | null,
  options: { maxEvents?: number } = {},
): Promise<PatternDistillResult> {
  if (!episodicStore) return { candidatesAdded: 0, eventsScanned: 0 };
  const maxEvents = options.maxEvents ?? 10;

  const events = await episodicStore.retrieveSince(0, maxEvents);
  if (events.length === 0) return { candidatesAdded: 0, eventsScanned: 0 };

  const prompt = `You are the pattern-distillation assistant. Given ${events.length} recent memories, extract at most 2 candidate patterns that might warrant an archivist upsert. Be conservative: confidence must be >= 0.6.

## Recent memories
${events.map((e, i) => `(${i + 1}) [${e.category}] ${e.text.slice(0, 200)}`).join("\n")}

## Output (raw JSON only)
[
  { "proposal": "<short pattern claim>", "confidence": <0.0-1.0>, "rationale": "<1 sentence>" }
]`;

  let raw: string;
  try {
    raw = await callModel(prompt);
  } catch {
    return { candidatesAdded: 0, eventsScanned: events.length };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFences(raw));
  } catch {
    return { candidatesAdded: 0, eventsScanned: events.length };
  }
  if (!Array.isArray(parsed)) return { candidatesAdded: 0, eventsScanned: events.length };

  const candidates: ProposalCandidate[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const obj = item as Record<string, unknown>;
    const proposal = typeof obj.proposal === "string" ? obj.proposal : "";
    const confidence = typeof obj.confidence === "number" ? obj.confidence : 0;
    const rationale = typeof obj.rationale === "string" ? obj.rationale : "";
    if (!proposal || confidence < 0.6) continue;
    candidates.push({
      proposal,
      confidence,
      rationale,
      category: "workflow",
    });
  }
  if (candidates.length === 0) {
    return { candidatesAdded: 0, eventsScanned: events.length };
  }

  const added = addArchivistProposals(workspacePath, candidates);
  return { candidatesAdded: added, eventsScanned: events.length };
}
