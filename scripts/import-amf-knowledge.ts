#!/usr/bin/env bun
/**
 * K1/K2: AMF KnowledgeHarvester → OODA Episodic Import
 *
 * Scans AMF output directories for completed runs and imports findings
 * into the OODA episodic memory store. Idempotent — safe to run on a cron.
 *
 * Usage:
 *   bun scripts/import-amf-knowledge.ts <amf-output-dir> [--db-path <lancedb-path>]
 *
 * The script reads:
 *   - CR STATUS.md (IMPLEMENTED entries → lessons)
 *   - parity_report.json (score, gaps)
 *   - ARCHITECTURE_REPORT.md (key findings)
 *
 * Each finding is stored as episodic memory with source="amf_harvester".
 */

import { homedir } from "node:os";
import { join } from "node:path";
import {
  importAMFKnowledge,
  findCompletedRuns,
  alreadyImported,
} from "../extensions/memory-ooda/cross-project.js";

// Minimal episodic store that writes to sqlite (same as memory-ooda fallback)
async function buildImportStore(dbPath: string) {
  const { DatabaseSync } = await import("node:sqlite");
  const { join: pathJoin } = await import("node:path");
  const { mkdirSync } = await import("node:fs");

  mkdirSync(dbPath, { recursive: true });
  const sqlitePath = pathJoin(dbPath, "memories.sqlite");

  // Create table if it doesn't exist (first-run safety)
  const db = new DatabaseSync(sqlitePath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      importance REAL NOT NULL DEFAULT 0.5,
      category TEXT NOT NULL DEFAULT 'other',
      createdAt INTEGER NOT NULL,
      source TEXT,
      actionId TEXT,
      archivistProcessed INTEGER NOT NULL DEFAULT 0,
      outcome TEXT,
      outcomeSignal TEXT,
      outcomeAt INTEGER
    )
  `);

  return {
    async store(event: {
      text: string;
      importance: number;
      category: string;
      source?: string;
      actionId?: string;
    }) {
      const { randomUUID } = await import("node:crypto");
      db.prepare(
        `INSERT INTO memories (id, text, importance, category, createdAt, source, actionId, archivistProcessed)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      ).run(
        randomUUID(),
        event.text,
        event.importance,
        event.category,
        Date.now(),
        event.source ?? null,
        event.actionId ?? null,
      );
    },

    // Stubs for EpisodicStore interface (not needed for import-only)
    async retrieveSince() {
      return [];
    },
    async markProcessed() {},
    async prune() {
      return 0;
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const amfOutputDir = args[0];

  if (!amfOutputDir) {
    console.error("Usage: bun scripts/import-amf-knowledge.ts <amf-output-dir> [--db-path <path>]");
    process.exit(1);
  }

  const dbPathIdx = args.indexOf("--db-path");
  const dbPath =
    dbPathIdx >= 0 && args[dbPathIdx + 1]
      ? args[dbPathIdx + 1]
      : join(homedir(), ".openclaw", "memory", "lancedb");

  // Report what we'll scan
  const runs = findCompletedRuns(amfOutputDir);
  const pendingRuns = runs.filter((r) => !alreadyImported(r.outputDir));
  console.log(`Found ${runs.length} completed run(s), ${pendingRuns.length} pending import`);

  if (pendingRuns.length === 0) {
    console.log("Nothing to import.");
    return;
  }

  const store = await buildImportStore(dbPath);
  const imported = await importAMFKnowledge(amfOutputDir, store);
  console.log(`Imported ${imported} finding(s) into episodic memory`);
}

main().catch((err) => {
  console.error("Import failed:", err);
  process.exit(1);
});
