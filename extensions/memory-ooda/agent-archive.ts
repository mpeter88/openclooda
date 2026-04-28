/**
 * CR_OODA_AGENT_ARCHIVE — per-generation ledger of the plugin itself.
 *
 * Source: HyperAgents (arxiv 2603.19461) gen_{genid}/metadata.json + archive.jsonl,
 * descended from DGM (arxiv 2505.22954). Tracks lineage of admission-gated
 * changes so we can ask "which plugin version produced this outcome?" and
 * descend experimental variants from known-good parents.
 *
 * Pure fs read/write; no LLM calls. Append-only.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ChangeKind } from "./types.js";

const ARCHIVE_FILENAME = ".agent-archive.jsonl";

export interface GenerationRow {
  genid: string;
  parent_genid: string;
  created_at: string;
  plugin_source_hash: string;
  workspace_hashes: {
    knowledge: string | null;
    beliefs: string | null;
    priorities: string | null;
  };
  admission: {
    gate_id: string;
    kind: ChangeKind;
    reason: string;
  };
  scores: Record<string, number>;
  run_full_eval: boolean;
  valid_parent: boolean;
  experiment_id?: string;
  lineage_depth: number;
  summary?: string;
}

export function archivePath(workspacePath: string): string {
  return path.join(workspacePath, ARCHIVE_FILENAME);
}

// ============================================================================
// Read path — pure fs
// ============================================================================

export function readArchive(workspacePath: string): GenerationRow[] {
  const file = archivePath(workspacePath);
  if (!fs.existsSync(file)) return [];
  const out: GenerationRow[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as GenerationRow);
    } catch {
      // skip malformed
    }
  }
  return out;
}

export function latestGenid(workspacePath: string): string | null {
  const rows = readArchive(workspacePath);
  return rows.length > 0 ? rows[rows.length - 1].genid : null;
}

export function findGeneration(workspacePath: string, genid: string): GenerationRow | null {
  const rows = readArchive(workspacePath);
  return rows.find((r) => r.genid === genid) ?? null;
}

/** Return the path from `genid` back to `"initial"`. Empty on missing genid. */
export function lineageTo(workspacePath: string, genid: string): GenerationRow[] {
  const rows = readArchive(workspacePath);
  const byGenid = new Map(rows.map((r) => [r.genid, r]));
  const chain: GenerationRow[] = [];
  let cursor: string | null = genid;
  const seen = new Set<string>();
  while (cursor && cursor !== "initial" && !seen.has(cursor)) {
    seen.add(cursor);
    const row = byGenid.get(cursor);
    if (!row) break;
    chain.push(row);
    cursor = row.parent_genid;
  }
  return chain;
}

export function childrenOf(workspacePath: string, genid: string): GenerationRow[] {
  return readArchive(workspacePath).filter((r) => r.parent_genid === genid);
}

export function validParents(workspacePath: string): GenerationRow[] {
  return readArchive(workspacePath).filter((r) => r.valid_parent);
}

// ============================================================================
// Write path — append + targeted updates
// ============================================================================

export interface AppendGenerationInput {
  plugin_source_hash: string;
  workspace_hashes: GenerationRow["workspace_hashes"];
  admission: GenerationRow["admission"];
  experiment_id?: string;
  summary?: string;
  run_full_eval?: boolean;
  valid_parent?: boolean;
}

/**
 * Derive a short genid from the plugin source hash + gate id + timestamp. 12 hex
 * chars is short enough for CLI use and collision-free at any realistic archive
 * size (>>100k rows needed before 50% collision probability).
 */
function deriveGenid(plugin_source_hash: string, gate_id: string, nowMs: number): string {
  return createHash("sha256")
    .update(`${plugin_source_hash}|${gate_id}|${nowMs}`)
    .digest("hex")
    .slice(0, 12);
}

export function appendGeneration(
  workspacePath: string,
  input: AppendGenerationInput,
): GenerationRow {
  const file = archivePath(workspacePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const prev = latestGenid(workspacePath);
  const now = Date.now();
  const genid = deriveGenid(input.plugin_source_hash, input.admission.gate_id, now);
  const parent_genid = prev ?? "initial";
  const prevRows = readArchive(workspacePath);
  const parentRow = prevRows.find((r) => r.genid === parent_genid);
  const lineage_depth = parentRow ? parentRow.lineage_depth + 1 : 0;
  const row: GenerationRow = {
    genid,
    parent_genid,
    created_at: new Date(now).toISOString(),
    plugin_source_hash: input.plugin_source_hash,
    workspace_hashes: input.workspace_hashes,
    admission: input.admission,
    scores: {},
    run_full_eval: input.run_full_eval ?? false,
    valid_parent: input.valid_parent ?? true,
    ...(input.experiment_id ? { experiment_id: input.experiment_id } : {}),
    lineage_depth,
    ...(input.summary ? { summary: input.summary } : {}),
  };
  fs.appendFileSync(file, JSON.stringify(row) + "\n", "utf-8");
  return row;
}

/**
 * Mutate an existing row in place. Preserves insertion order by rewriting the
 * file atomically. Used by score back-fill and valid_parent flag updates.
 */
function updateGenerationRow(
  workspacePath: string,
  genid: string,
  mutator: (row: GenerationRow) => GenerationRow,
): boolean {
  const rows = readArchive(workspacePath);
  let found = false;
  const updated = rows.map((r) => {
    if (r.genid !== genid) return r;
    found = true;
    return mutator(r);
  });
  if (!found) return false;
  const file = archivePath(workspacePath);
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, updated.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
  fs.renameSync(tmp, file);
  return true;
}

export function recordGenerationScore(
  workspacePath: string,
  genid: string,
  domain: string,
  score: number,
): boolean {
  return updateGenerationRow(workspacePath, genid, (row) => ({
    ...row,
    scores: { ...row.scores, [domain]: score },
  }));
}

export function markValidParent(
  workspacePath: string,
  genid: string,
  valid: boolean,
  reason: string,
): boolean {
  return updateGenerationRow(workspacePath, genid, (row) => ({
    ...row,
    valid_parent: valid,
    summary: reason
      ? `${row.summary ?? ""}${row.summary ? "; " : ""}valid_parent=${valid}:${reason}`.slice(
          0,
          300,
        )
      : row.summary,
  }));
}

export function markRunFullEval(workspacePath: string, genid: string, run: boolean): boolean {
  return updateGenerationRow(workspacePath, genid, (row) => ({ ...row, run_full_eval: run }));
}

// ============================================================================
// Average-score helper for parent-selection heuristics
// ============================================================================

/**
 * Mean score across a row's domains. Returns null when no domain has scored.
 * Matches HyperAgents' score-averaging used in `select_next_parent`.
 */
export function meanScore(row: GenerationRow): number | null {
  const values = Object.values(row.scores);
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
