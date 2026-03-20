#!/usr/bin/env npx tsx
/**
 * Memory Backfill Script — CR_CAPABILITY_UPLIFT_P2_BACKFILL
 * ==========================================================
 * Reads memory/YYYY-MM-DD.md files from the workspace, splits into
 * paragraphs, filters for substantive content, embeds via the same
 * Ollama provider used by memory-lancedb, deduplicates against the
 * existing store, and inserts.
 *
 * Safe to run multiple times — dedup (cosine similarity > 0.95) prevents
 * double-insertion.
 *
 * Usage:
 *   npx tsx scripts/backfill-memory.ts [options]
 *
 * Options:
 *   --days N       How many days back to scan (default: 30)
 *   --dry-run      Report what would be inserted without writing
 *   --verbose      Print each chunk processed
 *   --db PATH      Override sqlite DB path
 *   --workspace PATH  Override workspace dir
 *
 * Environment (defaults read from ~/.openclaw/openclaw.json):
 *   EMBED_MODEL    Ollama embedding model (default: nomic-embed-text)
 *   EMBED_URL      Ollama base URL (default: http://localhost:11434/v1)
 *   EMBED_DIMS     Embedding dimensions (default: 768)
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

// ── CLI args ────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    days: { type: "string", default: "30" },
    "dry-run": { type: "boolean", default: false },
    verbose: { type: "boolean", default: false },
    db: { type: "string" },
    workspace: { type: "string" },
  },
  strict: false,
});

const DAYS = parseInt(args.days as string, 10);
const DRY_RUN = args["dry-run"] as boolean;
const VERBOSE = args.verbose as boolean;

// ── Path resolution ──────────────────────────────────────────────────────────

const HOME = os.homedir();
const WORKSPACE =
  (args.workspace as string | undefined) ?? path.join(HOME, ".openclaw", "workspace");
const DB_PATH =
  (args.db as string | undefined) ??
  path.join(HOME, ".openclaw", "memory", "lancedb", "memories.sqlite");

// Read embedding config from openclaw.json if not overridden by env
function readOcConfig() {
  const cfgPath = path.join(HOME, ".openclaw", "openclaw.json");
  if (!fs.existsSync(cfgPath)) {
    return {};
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    return cfg?.plugins?.["memory-lancedb"]?.config?.embedding ?? {};
  } catch {
    return {};
  }
}

const ocCfg = readOcConfig();
const EMBED_MODEL = process.env.EMBED_MODEL ?? ocCfg.model ?? "nomic-embed-text";
const EMBED_URL = process.env.EMBED_URL ?? ocCfg.baseUrl ?? "http://localhost:11434/v1";
const EMBED_DIMS = parseInt(process.env.EMBED_DIMS ?? String(ocCfg.dimensions ?? 768), 10);

// ── Substantive content filter (mirrors memory-lancedb) ───────────────────

function isSubstantive(text: string): boolean {
  if (text.length < 50) {
    return false;
  }
  if (text.length > 600) {
    return true;
  }

  const SIGNALS = [
    /\broot cause\b/i,
    /\bdiscrepancy\b|\bmismatch\b|\bgap\b/i,
    /\bdecision\b|\bdecided\b|\bchose\b/i,
    /\bconfirmed\b|\bverified\b|\bfound\b/i,
    /\bthe (fix|issue|problem|bug|cause) is\b/i,
    /\bthis means\b|\bimplication\b/i,
    /\bpattern\b|\brecurring\b/i,
    /\barchitectural\b|\bdesign decision\b/i,
    /\bregression\b|\bviolation\b|\banti-pattern\b/i,
    /\brecommend\b|\bsuggestion\b|\badvise\b/i,
    /\bthe right (approach|way|call|tool|pattern)\b/i,
    /\bbetter (to|approach|option|choice)\b/i,
    /\btrade.?off\b|\bconsequence of\b/i,
    /\bparity (score|gap|check|fail)\b/i,
    /\bCR_\w+\b/,
    /\bPhase [1-9]\b|\bP[0-9] —\b/i,
    /\bshould (never|always|not)\b/i,
    /\bthe lesson\b|\bwhat this means\b|\bwhat happened\b/i,
  ];

  return SIGNALS.some((r) => r.test(text));
}

function detectCategory(text: string): string {
  if (/prefer|like|want|better than/i.test(text)) {
    return "preference";
  }
  if (/decided|decision|chose|will use/i.test(text)) {
    return "decision";
  }
  if (/\+\d{10,}|@[\w.-]+\.\w+/i.test(text)) {
    return "entity";
  }
  return "fact";
}

// ── Parse markdown into chunks ────────────────────────────────────────────

interface Chunk {
  text: string;
  source: string;
}

function parseMarkdown(content: string, filename: string): Chunk[] {
  const chunks: Chunk[] = [];
  const source = `backfill:${filename}`;

  // Split on section headers to get topical groups
  const sections = content.split(/^#{1,3} .+/m);

  for (const section of sections) {
    // Split each section on blank lines
    const paragraphs = section.split(/\n{2,}/);
    for (const para of paragraphs) {
      const text = para
        .trim()
        // Strip markdown table dividers and code fences (keep content)
        .replace(/^\|[-:| ]+\|$/m, "")
        .replace(/^```\w*\s*/m, "")
        .replace(/```\s*$/m, "")
        .trim();

      if (isSubstantive(text)) {
        chunks.push({ text, source });
      }
    }
  }

  return chunks;
}

// ── Embeddings ────────────────────────────────────────────────────────────

async function embed(text: string): Promise<Float32Array> {
  const resp = await fetch(`${EMBED_URL}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer not-needed" },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });

  if (!resp.ok) {
    throw new Error(`Embeddings API error: ${resp.status} ${resp.statusText}`);
  }

  const data = (await resp.json()) as { data: Array<{ embedding: number[] }> };
  return new Float32Array(data.data[0].embedding);
}

// ── Cosine similarity ─────────────────────────────────────────────────────

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log("Memory Backfill");
  console.log(`  Workspace:   ${WORKSPACE}`);
  console.log(`  DB:          ${DB_PATH}`);
  console.log(`  Embed model: ${EMBED_MODEL} @ ${EMBED_URL}`);
  console.log(`  Days back:   ${DAYS}`);
  console.log(`  Dry run:     ${DRY_RUN}`);
  console.log();

  // Find memory markdown files
  const memDir = path.join(WORKSPACE, "memory");
  if (!fs.existsSync(memDir)) {
    console.error(`Memory directory not found: ${memDir}`);
    process.exit(1);
  }

  const cutoff = Date.now() - DAYS * 24 * 60 * 60 * 1000;
  const files = fs
    .readdirSync(memDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .map((f) => ({ name: f, mtime: fs.statSync(path.join(memDir, f)).mtimeMs }))
    .filter((f) => f.mtime >= cutoff)
    .toSorted((a, b) => b.mtime - a.mtime);

  console.log(`Found ${files.length} memory file(s) within ${DAYS} days:`);
  files.forEach((f) => console.log(`  ${f.name}`));
  console.log();

  // Parse all files into chunks
  const allChunks: Chunk[] = [];
  for (const { name } of files) {
    const content = fs.readFileSync(path.join(memDir, name), "utf-8");
    const chunks = parseMarkdown(content, name);
    console.log(`  ${name}: ${chunks.length} substantive chunk(s)`);
    if (VERBOSE) {
      chunks.forEach((c, i) => console.log(`    [${i + 1}] ${c.text.slice(0, 80)}...`));
    }
    allChunks.push(...chunks);
  }

  console.log(`\nTotal chunks to process: ${allChunks.length}`);

  if (DRY_RUN) {
    console.log("\nDRY RUN — sample chunks:");
    allChunks
      .slice(0, 8)
      .forEach((c, i) => console.log(`  [${i + 1}] (${c.source}) ${c.text.slice(0, 90)}`));
    return;
  }

  if (allChunks.length === 0) {
    console.log("Nothing to backfill.");
    return;
  }

  // Open DB
  if (!fs.existsSync(DB_PATH)) {
    console.error(`DB not found: ${DB_PATH}`);
    console.error("Run OpenClaw at least once to initialize the memory store.");
    process.exit(1);
  }

  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(DB_PATH, { allowExtension: true });

  // Load sqlite-vec
  const sqliteVec = await import("sqlite-vec");
  sqliteVec.load(db as unknown as Parameters<typeof sqliteVec.load>[0]);

  // Load existing vectors for dedup
  console.log("\nLoading existing vectors for dedup check...");
  const existingCount = (db.prepare("SELECT count(*) as n FROM memories").get() as { n: number }).n;
  console.log(`  ${existingCount} existing entries in store`);

  // Fetch all existing vectors using memories_vec rowid sequence
  const existingVectors: Float32Array[] = [];
  try {
    const vecRows = db.prepare("SELECT rowid, vector FROM memories_vec").all() as Array<{
      rowid: number;
      vector: Buffer;
    }>;
    for (const row of vecRows) {
      if (row.vector) {
        existingVectors.push(
          new Float32Array(row.vector.buffer, row.vector.byteOffset, EMBED_DIMS),
        );
      }
    }
  } catch (err) {
    console.log(`  Could not load existing vectors for dedup: ${String(err)} — will skip dedup`);
  }
  console.log(`  Loaded ${existingVectors.length} existing vector(s) for dedup`);

  // Process chunks
  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  console.log("\nProcessing chunks...");

  for (let i = 0; i < allChunks.length; i++) {
    const chunk = allChunks[i];

    process.stdout.write(`  [${i + 1}/${allChunks.length}] `);

    try {
      // Embed
      const vector = await embed(chunk.text);

      // Dedup: check cosine similarity against all existing vectors
      let isDup = false;
      for (const existing of existingVectors) {
        if (cosineSimilarity(vector, existing) > 0.95) {
          isDup = true;
          break;
        }
      }

      if (isDup) {
        process.stdout.write("dup\n");
        skipped++;
        continue;
      }

      // Insert
      const id = randomUUID();
      const now = Date.now();
      const category = detectCategory(chunk.text);

      db.exec("BEGIN");
      try {
        db.prepare(
          `INSERT INTO memories (id, text, importance, category, createdAt, source, actionId, archivistProcessed)
           VALUES (?, ?, ?, ?, ?, ?, NULL, 0)`,
        ).run(id, chunk.text, 0.6, category, now, chunk.source);

        // Insert vector — let vec0 assign its own rowid (explicit rowid
        // is rejected by the vec0 binding in standalone node:sqlite context).
        // The memories_vec rowid sequence mirrors the memories rowid sequence
        // as long as both tables are only written together in the same transaction.
        db.prepare("INSERT INTO memories_vec (vector) VALUES (?)").run(vector);

        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }

      // Add to local dedup list so subsequent chunks in same run are checked
      existingVectors.push(vector);

      process.stdout.write(`ok (${category})\n`);
      if (VERBOSE) {
        console.log(`    ${chunk.text.slice(0, 80)}`);
      }
      inserted++;
    } catch (err) {
      process.stdout.write(`error: ${String(err).slice(0, 60)}\n`);
      errors++;
    }
  }

  db.close();

  console.log(`\nBackfill complete:`);
  console.log(`  Inserted:      ${inserted}`);
  console.log(`  Skipped (dup): ${skipped}`);
  console.log(`  Errors:        ${errors}`);
  console.log(`  Total store:   ${existingCount + inserted} entries`);
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
