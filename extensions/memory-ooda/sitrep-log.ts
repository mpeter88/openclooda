/**
 * S1/S2: SITREP persistence — append-only JSONL log of SITREP entries.
 *
 * One file per day: `<workspacePath>/sitrep-log/YYYY-MM-DD.jsonl`
 * Each line is a JSON object with timestamp, sessionKey, priority, domains,
 * attention, and thinkingLevel.
 */

import fs from "node:fs";
import path from "node:path";
import type { SITREP } from "./types.js";

// ============================================================================
// Types
// ============================================================================

export interface SitrepLogEntry {
  timestamp: string;
  sessionKey: string;
  priority: number;
  domains: Record<string, string[]>;
  attention: string | null;
  thinkingLevel: string;
}

// ============================================================================
// S1: Append SITREP to daily JSONL log
// ============================================================================

/**
 * Append a SITREP entry to the daily JSONL log file.
 * Creates the `sitrep-log/` directory and file if needed.
 */
export function appendSitrepLog(
  workspacePath: string,
  sitrep: SITREP,
  sessionKey: string,
  thinkingLevel: string,
): void {
  const logDir = path.join(workspacePath, "sitrep-log");
  fs.mkdirSync(logDir, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  const logFile = path.join(logDir, `${today}.jsonl`);

  const entry: SitrepLogEntry = {
    timestamp: new Date().toISOString(),
    sessionKey,
    priority: sitrep.priority,
    domains: {
      recommended: sitrep.recommendedDomains,
    },
    attention: sitrep.attention ?? null,
    thinkingLevel,
  };

  fs.appendFileSync(logFile, JSON.stringify(entry) + "\n", "utf-8");
}

// ============================================================================
// S2: Read SITREP log for a given date
// ============================================================================

/**
 * Read the SITREP log for a given date (default: today).
 * Returns parsed entries, or an empty array if no log exists for that date.
 */
export function readSitrepLog(workspacePath: string, date?: string): SitrepLogEntry[] {
  const targetDate = date ?? new Date().toISOString().slice(0, 10);
  const logFile = path.join(workspacePath, "sitrep-log", `${targetDate}.jsonl`);

  if (!fs.existsSync(logFile)) {
    return [];
  }

  const content = fs.readFileSync(logFile, "utf-8");
  const entries: SitrepLogEntry[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      entries.push(JSON.parse(trimmed) as SitrepLogEntry);
    } catch {
      // Skip malformed lines
    }
  }

  return entries;
}
