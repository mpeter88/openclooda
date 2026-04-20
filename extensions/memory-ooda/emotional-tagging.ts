/**
 * CR_OODA_EMOTIONAL_TAGGING — priority-weighted episodic memory.
 *
 * Source: Mattson 2014 — arousal enhances hippocampal pattern separation.
 * SITREP priority is the openclooda analog of emotional arousal; pipe it into
 * episodic memory as a salience multiplier so high-stake turns encode more
 * durably than routine turns.
 */

import fs from "node:fs";
import path from "node:path";
import type { ErrorTag } from "./types.js";

/** SITREP priority used when a capture is not tagged (pre-CR rows, failures). */
export const DEFAULT_PRIORITY = 5;

/**
 * CR_OODA_EMOTIONAL_TAGGING (phase 2): cross-plugin priority signal.
 *
 * Memory-ooda owns triage and computes SITREP priority; memory-lancedb owns
 * autoCapture of user/assistant turns. They're separate plugins in the same
 * gateway process but can't import each other. The sidecar is the coupling:
 * memory-ooda writes .turn-sitrep.json at before_agent_start; memory-lancedb
 * reads it on capture.
 *
 * Freshness guard: readers must enforce a max age so a stale sitrep from a
 * crashed turn doesn't bleed into the next one.
 */
const TURN_SITREP_FILE = ".turn-sitrep.json";
const DEFAULT_FRESHNESS_MS = 5 * 60 * 1000;

export interface TurnSitrepSidecar {
  priority: number;
  rawPriority?: number;
  writtenAt: string;
  sessionKey?: string;
}

export function turnSitrepPath(workspacePath: string): string {
  return path.join(workspacePath, TURN_SITREP_FILE);
}

export function writeTurnSitrep(workspacePath: string, sidecar: TurnSitrepSidecar): void {
  const file = turnSitrepPath(workspacePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(sidecar, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, file);
}

export function clearTurnSitrep(workspacePath: string): void {
  const file = turnSitrepPath(workspacePath);
  if (fs.existsSync(file)) {
    try {
      fs.unlinkSync(file);
    } catch {
      // best-effort
    }
  }
}

/**
 * Read the active turn sitrep, returning undefined if absent or stale.
 * Consumers must treat undefined as "use default priority" — they MUST NOT
 * fall back to a cached value elsewhere; that defeats the freshness guard.
 */
export function readTurnSitrep(
  workspacePath: string,
  options: { maxAgeMs?: number; now?: number } = {},
): TurnSitrepSidecar | undefined {
  const file = turnSitrepPath(workspacePath);
  if (!fs.existsSync(file)) return undefined;
  let parsed: TurnSitrepSidecar;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as TurnSitrepSidecar;
  } catch {
    return undefined;
  }
  if (typeof parsed.priority !== "number" || typeof parsed.writtenAt !== "string") {
    return undefined;
  }
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_FRESHNESS_MS;
  const age = now - new Date(parsed.writtenAt).getTime();
  if (!Number.isFinite(age) || age > maxAgeMs) return undefined;
  return parsed;
}

/**
 * Map SITREP priority 1-10 to an importance multiplier.
 *
 *   P10 → 1.00  (full amplification)
 *   P5  → 0.75  (neutral baseline)
 *   P1  → 0.55  (near-floor)
 *
 * Multiplicative: a capture with baseline importance 0.8 at P9 lands at 0.76;
 * the same capture at P2 lands at 0.48. Sharpens the prior without clipping.
 */
export function priorityWeight(priority: number | undefined): number {
  const p = priority ?? DEFAULT_PRIORITY;
  const clamped = Math.max(1, Math.min(10, p));
  return 0.5 + 0.05 * clamped;
}

/** Apply the priority multiplier to a baseline importance value, clamped to [0, 1]. */
export function weightImportance(baseline: number, priority: number | undefined): number {
  const weighted = baseline * priorityWeight(priority);
  return Math.max(0, Math.min(1, weighted));
}

/**
 * Priority-weighted count for aggregation (e.g. axis priors).
 *
 * A `planning` failure at P9 signals more than a `planning` failure at P2. This
 * returns the per-event weight to use instead of a flat `1` when aggregating.
 */
export function priorityCountWeight(priority: number | undefined): number {
  return priorityWeight(priority) / priorityWeight(DEFAULT_PRIORITY);
}

// ============================================================================
// Priority-weighted axis-prior aggregation
// ============================================================================

export interface PriorityWeightedAxisStats {
  domain: string;
  axis: ErrorTag["axis"];
  /** Sum of priority-weighted counts (not raw counts). */
  weightedTotal: number;
  countCritical: number;
  countMajor: number;
  countMinor: number;
  axisRate: number;
  topSignals: Array<{ signal: string; count: number }>;
}
