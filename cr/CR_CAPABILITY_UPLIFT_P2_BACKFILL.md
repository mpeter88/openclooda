# CR: Capability Uplift — Phase 2: Memory Backfill from Daily Markdown

**Date:** 2026-03-19
**Status:** WRITTEN
**Priority:** HIGH — unlocks recall of all historical context
**Effort:** ~2 hours
**Dependency:** CR_CAPABILITY_UPLIFT_P1_CAPTURE (use correct filter before backfilling)
**Files:** `scripts/backfill-memory.ts` (new), `extensions/memory-lancedb/index.ts`

---

## Problem

Months of conversation context lives in `~/.openclaw/workspace/memory/YYYY-MM-DD.md`
files as plain text. The sqlite-vec store has 8 entries. None of the historical context
is searchable via `autoRecall`. When the agent searches memory for "what did we decide
about AMF parity" or "what was the ProfileManager gap", it finds nothing.

This is the highest-leverage gap after Phase 1: backfilling populates the store so
every subsequent session benefits from historical recall.

---

## Changes

### B1 — Backfill script

**File:** `scripts/backfill-memory.ts` (new)

```typescript
#!/usr/bin/env npx tsx
/**
 * Memory Backfill Script
 * ======================
 * Reads memory/YYYY-MM-DD.md files from the workspace, splits into
 * paragraphs, filters by substantive signal, embeds, deduplicates
 * against the existing store, and inserts.
 *
 * Safe to run multiple times — dedup (similarity > 0.95) prevents
 * double-insertion.
 *
 * Usage:
 *   npx tsx scripts/backfill-memory.ts [--days 30] [--dry-run] [--verbose]
 *
 * Environment:
 *   OPENCLAW_WORKSPACE  — path to workspace dir (default: ~/.openclaw/workspace)
 *   OPENCLAW_MEMORY_DB  — path to memories.sqlite (default: ~/.openclaw/memory/lancedb/memories.sqlite)
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    days: { type: "string", default: "30" },
    "dry-run": { type: "boolean", default: false },
    verbose: { type: "boolean", default: false },
  },
});

const WORKSPACE =
  process.env.OPENCLAW_WORKSPACE ?? path.join(os.homedir(), ".openclaw", "workspace");
const MEMORY_DB =
  process.env.OPENCLAW_MEMORY_DB ??
  path.join(os.homedir(), ".openclaw", "memory", "lancedb", "memories.sqlite");
const DAYS = parseInt(args.days as string, 10);
const DRY_RUN = args["dry-run"] as boolean;
const VERBOSE = args.verbose as boolean;

// Reuse the same filter logic as memory-lancedb
// (import from the built extension or duplicate the function)
function isSubstantive(text: string): boolean {
  if (text.length < 100) return false;
  const SIGNALS = [
    /\broot cause\b/i,
    /\bdecision\b|\bdecided\b/i,
    /\bconfirmed\b|\bverified\b/i,
    /\bpattern\b|\brecurring\b/i,
    /\barchitectural\b/i,
    /\bregression\b|\bviolation\b/i,
    /\brecommend\b|\badvise\b/i,
    /\bthe right (approach|way|call)\b/i,
    /\bparity (score|gap|fail)\b/i,
    /\bCR_\w+\b/,
    /\bPhase [1-9]\b/i,
    /\bshould (never|always|not)\b/i,
    /\bthe lesson\b|\bwhat this means\b/i,
    /\bgap\b|\bmismatch\b|\bdiscrepancy\b/i,
    /\bfix\b.{0,20}\bis\b/i,
  ];
  return SIGNALS.some((r) => r.test(text)) || text.length > 500;
}

function detectCategory(text: string): string {
  if (/prefer|like|want|better than/i.test(text)) return "preference";
  if (/decided|decision|chose|will use/i.test(text)) return "decision";
  if (/is|are|has|have|exists/i.test(text)) return "fact";
  return "other";
}

function parseMarkdownIntoChunks(
  content: string,
  source: string,
): Array<{ text: string; source: string }> {
  const chunks: Array<{ text: string; source: string }> = [];

  // Split on section headers first to get topical chunks
  const sections = content.split(/^#{1,3} .+/m);

  for (const section of sections) {
    // Then split each section on double newlines
    const paragraphs = section.split(/\n{2,}/);
    for (const para of paragraphs) {
      const text = para.trim();
      if (isSubstantive(text)) {
        chunks.push({ text, source });
      }
    }
  }

  return chunks;
}

async function main() {
  const memDir = path.join(WORKSPACE, "memory");
  if (!fs.existsSync(memDir)) {
    console.error(`Memory directory not found: ${memDir}`);
    process.exit(1);
  }

  // Find markdown files within the day window
  const cutoff = Date.now() - DAYS * 24 * 60 * 60 * 1000;
  const files = fs
    .readdirSync(memDir)
    .filter((f) => f.match(/^\d{4}-\d{2}-\d{2}\.md$/))
    .map((f) => ({ name: f, mtime: fs.statSync(path.join(memDir, f)).mtimeMs }))
    .filter((f) => f.mtime >= cutoff)
    .sort((a, b) => b.mtime - a.mtime) // newest first
    .map((f) => path.join(memDir, f.name));

  console.log(`Found ${files.length} memory files within ${DAYS} days`);
  if (DRY_RUN) console.log("DRY RUN — no writes will occur");

  // Parse all files into chunks
  const allChunks: Array<{ text: string; source: string }> = [];
  for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
    const filename = path.basename(file);
    const chunks = parseMarkdownIntoChunks(content, `backfill:${filename}`);
    if (VERBOSE) console.log(`  ${filename}: ${chunks.length} substantive chunks`);
    allChunks.push(...chunks);
  }

  console.log(`Total substantive chunks: ${allChunks.length}`);

  if (DRY_RUN) {
    console.log("Sample chunks:");
    allChunks
      .slice(0, 5)
      .forEach((c, i) => console.log(`  [${i + 1}] (${c.source}) ${c.text.slice(0, 80)}...`));
    return;
  }

  // Open sqlite-vec store and insert with dedup
  // (uses the same DB as the plugin — node:sqlite + sqlite-vec extension)
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(MEMORY_DB);

  // Load sqlite-vec extension
  const { getVecExtensionPath } = await import("@sqlite-vec/node");
  db.loadExtension(getVecExtensionPath());

  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  // Embeddings — reuse same Ollama provider as the plugin
  const { Ollama } = await import("ollama");
  const ollama = new Ollama();
  const EMBED_MODEL = process.env.EMBED_MODEL ?? "nomic-embed-text";

  for (const chunk of allChunks) {
    try {
      // Embed
      const resp = await ollama.embed({ model: EMBED_MODEL, input: chunk.text });
      const vector = resp.embeddings[0];
      if (!vector) {
        errors++;
        continue;
      }

      // Dedup check (similarity > 0.95)
      const existing = db
        .prepare(`SELECT id FROM memories WHERE vec_distance_cosine(embedding, ?) < 0.05 LIMIT 1`)
        .get(new Float32Array(vector));

      if (existing) {
        skipped++;
        continue;
      }

      // Insert
      const id = crypto.randomUUID();
      const now = Date.now();
      const category = detectCategory(chunk.text);
      const importance = 0.6; // slightly below live captures

      db.prepare(
        `INSERT INTO memories (id, text, importance, category, createdAt, source, archivistProcessed)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
      ).run(id, chunk.text, importance, category, now, chunk.source);

      // Also store the vector
      db.prepare(`INSERT INTO memories_vec (rowid, embedding) VALUES (last_insert_rowid(), ?)`).run(
        new Float32Array(vector),
      );

      inserted++;
      if (VERBOSE) console.log(`  ✓ inserted: ${chunk.text.slice(0, 60)}...`);
    } catch (err) {
      errors++;
      if (VERBOSE) console.error(`  ✗ error: ${err}`);
    }
  }

  db.close();

  console.log(`\nBackfill complete:`);
  console.log(`  Inserted:  ${inserted}`);
  console.log(`  Skipped (dup): ${skipped}`);
  console.log(`  Errors:    ${errors}`);
}

main().catch(console.error);
```

### B2 — `memory_backfill` tool in memory-lancedb plugin

**File:** `extensions/memory-lancedb/index.ts`  
**Location:** plugin tools array

Add alongside `memory_store` and `memory_recall`:

```typescript
{
  name: "memory_backfill",
  description: "Backfill episodic memory from workspace daily markdown files. Safe to run multiple times — deduplication prevents double-insertion.",
  params: Type.Object({
    days: Type.Optional(Type.Number({
      description: "How many days back to scan (default: 30)",
    })),
    dryRun: Type.Optional(Type.Boolean({
      description: "Report what would be inserted without writing (default: false)",
    })),
  }),
  async handler({ days = 30, dryRun = false }) {
    // Spawn the backfill script as a subprocess
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    const scriptPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..", "..", "scripts", "backfill-memory.ts"
    );

    const args = [`--days`, String(days)];
    if (dryRun) args.push("--dry-run");

    try {
      const { stdout, stderr } = await execFileAsync(
        "npx", ["tsx", scriptPath, ...args],
        { timeout: 120_000 }
      );
      return { success: true, output: stdout + stderr };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },
},
```

---

## Acceptance Criteria

- [ ] `npx tsx scripts/backfill-memory.ts --dry-run --days 30` runs without error and reports chunk counts
- [ ] Real run inserts ≥ 50 entries from 2026-03-18 + 2026-03-19 markdown files
- [ ] Re-running produces 0 new inserts (dedup working)
- [ ] `memory_backfill` tool callable from agent and returns output summary
- [ ] `autoRecall` finds relevant entries for "AMF parity" query after backfill
- [ ] All existing 20/21 memory-lancedb tests still pass
