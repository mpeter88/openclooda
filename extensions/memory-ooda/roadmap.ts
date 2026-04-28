/**
 * CR_OODA_HYPOTHESIS_DISCIPLINE — roadmap parser + proposed-epics queue.
 *
 * ROADMAP.md is operator-owned. The plugin reads it to validate hypothesis
 * roadmap links; it writes only via the explicitly operator-initiated
 * `roadmap accept` path.
 *
 * Draft epics proposed by the loop land in `.proposed-epics.jsonl` (append-
 * only queue). `roadmap accept` appends the accepted epic to ROADMAP.md and
 * flips the queue entry's status. `roadmap reject` flips to rejected.
 *
 * Parser is tolerant by design: unknown markdown is ignored, only the
 * `## <Horizon>` sections and their `### <epic-id> <title>` headers matter.
 */

import fs from "node:fs";
import path from "node:path";

export const ROADMAP_FILENAME = "ROADMAP.md";
export const PROPOSED_EPICS_FILENAME = ".proposed-epics.jsonl";

export type Horizon = "current" | "near" | "distant";

export interface RoadmapEpic {
  id: string;
  title: string;
  horizon: Horizon;
}

export interface ProposedEpicRow {
  epic_id: string;
  title: string;
  rationale: string;
  horizon: Horizon;
  proposed_by_hypothesis_id: string;
  proposed_by_exp_id: string;
  proposed_at: string;
  status: "pending" | "accepted" | "rejected";
  resolved_at?: string;
  resolved_reason?: string;
}

export function roadmapPath(workspacePath: string): string {
  return path.join(workspacePath, ROADMAP_FILENAME);
}

export function proposedEpicsPath(workspacePath: string): string {
  return path.join(workspacePath, PROPOSED_EPICS_FILENAME);
}

// ============================================================================
// ROADMAP.md parser
// ============================================================================

/**
 * Read the epics from ROADMAP.md. Missing file → empty list (operator hasn't
 * bootstrapped yet). Unknown markdown is ignored; we only key off
 * `## Current | Near | Distant` H2 sections and `### <id> <title>` H3 lines
 * within them.
 */
export function listEpics(workspacePath: string): RoadmapEpic[] {
  const p = roadmapPath(workspacePath);
  if (!fs.existsSync(p)) return [];
  const text = fs.readFileSync(p, "utf-8");
  const out: RoadmapEpic[] = [];
  let horizon: Horizon | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const h2 = /^##\s+(.+)\s*$/.exec(line);
    if (h2) {
      const label = h2[1].trim().toLowerCase();
      horizon = label.startsWith("current")
        ? "current"
        : label.startsWith("near")
          ? "near"
          : label.startsWith("distant")
            ? "distant"
            : null;
      continue;
    }
    const h3 = /^###\s+(\S+)\s+(.+)\s*$/.exec(line);
    if (h3 && horizon) {
      out.push({ id: h3[1].trim(), title: h3[2].trim(), horizon });
    }
  }
  return out;
}

export function findEpic(workspacePath: string, epicId: string): RoadmapEpic | null {
  return listEpics(workspacePath).find((e) => e.id === epicId) ?? null;
}

/**
 * Append an epic to ROADMAP.md under the given horizon section. Creates the
 * section if missing. Operator-triggered only (via `roadmap accept`).
 */
export function appendEpic(workspacePath: string, epic: RoadmapEpic): void {
  const p = roadmapPath(workspacePath);
  let text = fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : "";
  if (!text.trim()) {
    text = "# OpenClooda Roadmap\n\n" + "## Current\n\n## Near\n\n## Distant\n";
  }
  const header = horizonHeader(epic.horizon);
  const insertLine = `### ${epic.id} ${epic.title}\n`;
  if (!text.includes(header)) {
    text += `\n${header}\n${insertLine}`;
  } else {
    // Insert immediately after the horizon header.
    text = text.replace(header, `${header}\n${insertLine}`);
  }
  fs.writeFileSync(p, text, "utf-8");
}

function horizonHeader(h: Horizon): string {
  return h === "current" ? "## Current" : h === "near" ? "## Near" : "## Distant";
}

// ============================================================================
// Proposed epics queue — append-only JSONL
// ============================================================================

export function readProposedEpics(workspacePath: string): ProposedEpicRow[] {
  const p = proposedEpicsPath(workspacePath);
  if (!fs.existsSync(p)) return [];
  const text = fs.readFileSync(p, "utf-8");
  const out: ProposedEpicRow[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as ProposedEpicRow);
    } catch {
      // tolerate corrupt lines; operator can clean up manually
    }
  }
  return out;
}

export function appendProposedEpic(
  workspacePath: string,
  row: Omit<ProposedEpicRow, "proposed_at" | "status"> &
    Partial<Pick<ProposedEpicRow, "proposed_at" | "status">>,
): ProposedEpicRow {
  const full: ProposedEpicRow = {
    ...row,
    proposed_at: row.proposed_at ?? new Date().toISOString(),
    status: row.status ?? "pending",
  };
  const p = proposedEpicsPath(workspacePath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, `${JSON.stringify(full)}\n`, "utf-8");
  return full;
}

/**
 * The queue is append-only for audit, so we record resolution by appending a
 * new row with the same epic_id and the resolved status. `pendingEpics` below
 * collapses the log to the latest state per epic_id.
 */
export function resolveProposedEpic(
  workspacePath: string,
  epicId: string,
  resolution: "accepted" | "rejected",
  reason: string,
): ProposedEpicRow | null {
  const existing = pendingEpics(workspacePath).find((r) => r.epic_id === epicId);
  if (!existing) return null;
  const resolved: ProposedEpicRow = {
    ...existing,
    status: resolution,
    resolved_at: new Date().toISOString(),
    resolved_reason: reason,
  };
  const p = proposedEpicsPath(workspacePath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, `${JSON.stringify(resolved)}\n`, "utf-8");
  return resolved;
}

/** Latest state per epic_id. */
export function latestEpicStates(workspacePath: string): Map<string, ProposedEpicRow> {
  const out = new Map<string, ProposedEpicRow>();
  for (const row of readProposedEpics(workspacePath)) {
    out.set(row.epic_id, row);
  }
  return out;
}

export function pendingEpics(workspacePath: string): ProposedEpicRow[] {
  return [...latestEpicStates(workspacePath).values()].filter((r) => r.status === "pending");
}

// ============================================================================
// Bootstrap — write a starter ROADMAP.md populated from today's gap list
// ============================================================================

const STARTER_ROADMAP = `# OpenClooda Roadmap

Operator-owned. Hypotheses must link to an epic below or propose a new one
(which lands in .proposed-epics.jsonl awaiting operator accept/reject).

Horizons:
- Current   — shipping or immediate next
- Near      — weeks-to-months
- Distant   — bigger bets, not on the critical path

## Current

### curiosity curiosity-driven exploration & intrinsic motivation
### metacognition calibrated uncertainty & metacognitive consolidation
### reasoning-shapes richer council shapes (tree/graph-of-thought, debate, verification)

## Near

### theory-of-mind generative world models & ToM
### tool-discovery dynamic tool discovery + skill library acquisition
### hierarchical-planning options frameworks & hierarchical planners
### graph-rag graph-RAG / hierarchical long-term memory
### continual-learning lifelong learning under drift
### self-critique self-refine / constitutional AI / RLAIF
### benchmarks-beyond-passk SWE-bench-style evals & novel benchmarks

## Distant

### neurosci-mechanisms predictive coding, free energy, global workspace, neuromorphic
### decision-theory POMDP, bandits, sequential decision, optimal stopping
`;

/** Write the starter ROADMAP.md if one doesn't exist. Returns true iff written. */
export function bootstrapRoadmap(workspacePath: string): boolean {
  const p = roadmapPath(workspacePath);
  if (fs.existsSync(p)) return false;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, STARTER_ROADMAP, "utf-8");
  return true;
}
