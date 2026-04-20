/**
 * CR_OODA_PATTERN_SEPARATION_GATE — cross-plugin scan for near-duplicate
 * memories, backed by memory-lancedb's sqlite-vec store.
 *
 * Opens memories.sqlite read-only and scans hashSignature rows for high
 * MinHash-Jaccard matches with the query text. Used at before_agent_start to
 * surface `separationMatches` for the Council Discriminator.
 *
 * Does not compute dense cosine similarity — that requires an embedding call.
 * A hash-only scan is sufficient for the `exact_duplicate` and `lexical_echo`
 * bands (both require high hash match); semantic_twin detection would need
 * dense sim which lives on the retrieval-path side.
 */

import fs from "node:fs";
import path from "node:path";
import { deserializeSignature, minhash, minhashJaccard } from "./min-hash.js";

export interface NearDuplicateMatch {
  memoryId: string;
  text: string;
  hashJaccard: number;
  createdAt: number;
}

export interface SeparationScanOptions {
  /** Ceiling on rows scanned (bounded for cost). Default 500. */
  maxRows?: number;
  /** Minimum Jaccard to treat as a candidate. Default 0.6. */
  minJaccard?: number;
  /** Top-N to return. Default 5. */
  limit?: number;
}

/**
 * Scan memories.sqlite for near-duplicate rows by MinHash Jaccard. Returns
 * empty array when the DB is missing or has no hashSignature column (pre-
 * migration workspace). Never throws — callers can rely on a noop result.
 */
export async function scanForNearDuplicates(
  dbPath: string,
  queryText: string,
  options: SeparationScanOptions = {},
): Promise<NearDuplicateMatch[]> {
  const maxRows = options.maxRows ?? 500;
  const minJaccard = options.minJaccard ?? 0.6;
  const limit = options.limit ?? 5;

  const sqlitePath = path.join(dbPath, "memories.sqlite");
  if (!fs.existsSync(sqlitePath)) return [];

  let db: import("node:sqlite").DatabaseSync | undefined;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(sqlitePath);

    // Verify the schema supports separation (post-migration workspaces only).
    const columns = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === "hashSignature")) return [];

    const rows = db
      .prepare(
        `SELECT id, text, hashSignature, createdAt
         FROM memories
         WHERE hashSignature IS NOT NULL
         ORDER BY createdAt DESC
         LIMIT ?`,
      )
      .all(maxRows) as Array<{
      id: string;
      text: string;
      hashSignature: string;
      createdAt: number;
    }>;

    const querySig = minhash(queryText);
    const out: NearDuplicateMatch[] = [];
    for (const row of rows) {
      const rowSig = deserializeSignature(row.hashSignature);
      if (rowSig.length !== querySig.length) continue;
      const j = minhashJaccard(querySig, rowSig);
      if (j >= minJaccard) {
        out.push({
          memoryId: row.id,
          text: row.text,
          hashJaccard: j,
          createdAt: row.createdAt,
        });
      }
    }
    return out.sort((a, b) => b.hashJaccard - a.hashJaccard).slice(0, limit);
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      // best-effort
    }
  }
}

/**
 * Format near-duplicate matches into concise one-line summaries suitable for
 * passing as `separationMatches` to runCouncil. Caps text length to keep the
 * Discriminator prompt bounded.
 */
export function formatMatchesForDiscriminator(
  matches: NearDuplicateMatch[],
  maxTextLen = 200,
): string[] {
  return matches.map((m) => {
    const snippet = m.text.length > maxTextLen ? m.text.slice(0, maxTextLen) + "…" : m.text;
    const isoDate = new Date(m.createdAt).toISOString().slice(0, 10);
    return `[${isoDate}, jaccard=${m.hashJaccard.toFixed(2)}] ${snippet}`;
  });
}
