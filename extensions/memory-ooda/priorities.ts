/**
 * PRIORITIES.json — read/write/validate for domain weights and scoring rubric.
 *
 * The Meta-Reviewer adjusts domain weights over time.
 * Scoring rubric weights (alignment/efficiency/risk) require manual tuning.
 */

import fs from "node:fs";
import path from "node:path";
import { createSnapshot, restoreLatestSnapshot } from "./snapshot.js";
import type { PrioritiesFile } from "./types.js";

const PRIORITIES_FILENAME = "PRIORITIES.json";

// ============================================================================
// Default Template
// ============================================================================

export function createDefaultPriorities(): PrioritiesFile {
  return {
    _meta: {
      version: 1,
      updated_at: new Date().toISOString(),
      updated_by: "user",
      description:
        "Domain weights and scoring rubric for OODA strategy evaluation. " +
        "Domain weights are adjusted by the Meta-Reviewer; scoring rubric requires manual tuning.",
    },
    domains: {
      core_project: {
        weight: 0.8,
        description: "Primary project work — coding, architecture, reviews",
        examples: ["implement feature", "fix bug", "review PR"],
        approval_count: 0,
        override_count: 0,
      },
      communication: {
        weight: 0.5,
        description: "Messaging, emails, scheduling",
        examples: ["reply to message", "schedule meeting"],
        approval_count: 0,
        override_count: 0,
      },
      operations: {
        weight: 0.4,
        description: "DevOps, infrastructure, deployment",
        examples: ["deploy service", "check monitoring"],
        approval_count: 0,
        override_count: 0,
      },
    },
    strategy_labels: [
      { label: "aggressive_fix", description: "Act immediately with full effort and resources" },
      {
        label: "delegate_task",
        description: "Route to another person or agent; track to completion",
      },
      {
        label: "strategic_delay",
        description: "Defer until a better moment; set reminder + context",
      },
      {
        label: "minimal_viable_action",
        description: "Do the smallest thing that unblocks progress",
      },
    ],
    scoring_rubric: {
      alignment: {
        weight: 0.4,
        description: "Match with SOUL.md and active domain goals",
      },
      efficiency: {
        weight: 0.35,
        description: "Token cost and time vs. expected value",
      },
      risk: {
        weight: 0.25,
        description: "Potential for irreversible side-effects or missed commitments",
      },
    },
    thresholds: {
      min_priority_for_full_ooda: 5,
      min_thinking_level_for_full_ooda: "medium",
      critical_failure_score_floor: 0.3,
      archivist_turn_interval: 15,
      meta_reviewer_weekly_enabled: false,
      council_priority_threshold: 7,
      council_system1_enabled: true,
      council_system2_enabled: true,
    },
    _weight_adjustment_log: [],
  };
}

// ============================================================================
// Path Resolution
// ============================================================================

export function prioritiesPath(workspacePath: string): string {
  return path.join(workspacePath, PRIORITIES_FILENAME);
}

// ============================================================================
// Read / Write
// ============================================================================

/**
 * Read and parse PRIORITIES.json.
 * Creates a default template if the file doesn't exist.
 */
export function getPriorities(workspacePath: string): PrioritiesFile {
  const filePath = prioritiesPath(workspacePath);

  if (!fs.existsSync(filePath)) {
    const defaults = createDefaultPriorities();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(defaults, null, 2) + "\n", "utf-8");
    return defaults;
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw) as PrioritiesFile;

  if (!parsed._meta || typeof parsed._meta.version !== "number") {
    throw new Error("Invalid PRIORITIES.json: missing or malformed _meta block");
  }

  if (!parsed.scoring_rubric) {
    throw new Error("Invalid PRIORITIES.json: missing scoring_rubric");
  }

  return parsed;
}

/**
 * Write an updated PrioritiesFile to disk with snapshot safety.
 */
export function writePriorities(workspacePath: string, priorities: PrioritiesFile): void {
  const filePath = prioritiesPath(workspacePath);

  createSnapshot(workspacePath, PRIORITIES_FILENAME);

  priorities._meta.updated_at = new Date().toISOString();

  const json = JSON.stringify(priorities, null, 2) + "\n";

  try {
    JSON.parse(json);
  } catch {
    restoreLatestSnapshot(workspacePath, PRIORITIES_FILENAME);
    throw new Error("writePriorities produced invalid JSON; snapshot restored");
  }

  fs.writeFileSync(filePath, json, "utf-8");
}

/**
 * Update a single domain weight and log the change.
 */
export function updateDomainWeight(
  workspacePath: string,
  domain: string,
  newWeight: number,
  reason: string,
): void {
  const priorities = getPriorities(workspacePath);

  if (!priorities.domains[domain]) {
    throw new Error(`Domain "${domain}" not found in PRIORITIES.json`);
  }

  if (newWeight < 0.1 || newWeight > 1.0) {
    throw new Error(`Domain weight must be in [0.1, 1.0], got ${newWeight}`);
  }

  const oldWeight = priorities.domains[domain].weight;
  const roundedWeight = Math.round(newWeight * 1000) / 1000;
  priorities.domains[domain].weight = roundedWeight;
  priorities._meta.updated_by = "meta_reviewer";

  priorities._weight_adjustment_log.push({
    timestamp: new Date().toISOString(),
    domain,
    old_weight: oldWeight,
    new_weight: roundedWeight,
    reason,
  });

  writePriorities(workspacePath, priorities);
}
