/**
 * Cross-Project Knowledge Bridge (Tier 4)
 *
 * K1: AMF KnowledgeHarvester → OODA episodic import
 * K3: OODA → AMF knowledge export (ooda-lessons.json)
 * K4: AMF-context detection for cross-project recall
 * K5: KNOWLEDGE.json auto-update from high-importance imports
 */

import fs from "node:fs";
import path from "node:path";
import type {
  EpisodicEvent,
  EpisodicStore,
  PatternExtraction,
  SemanticStore,
} from "./archivist.js";

// ============================================================================
// K4: AMF Context Detection
// ============================================================================

const AMF_KEYWORDS = [
  "amf",
  "pipeline",
  "forensic",
  "gradle",
  "kotlin",
  "parity",
  "kohlscore",
  "kohl",
  "assembly",
  "module scoping",
  "parity_report",
  "architecture_report",
  "worker.py",
  "forensic_orchestrator",
];

/**
 * Detect whether a user message is AMF-related, warranting cross-project recall.
 */
export function isAMFContext(message: string): boolean {
  const lower = message.toLowerCase();
  return AMF_KEYWORDS.some((kw) => lower.includes(kw));
}

// ============================================================================
// K1: AMF Run Finding Extraction
// ============================================================================

/** A single finding extracted from an AMF run output. */
export interface AMFRunFinding {
  text: string;
  importance: number;
  crId?: string;
  findingType: "cr_lesson" | "parity_gap" | "architecture_finding";
}

/** Metadata about a completed AMF run directory. */
export interface AMFRun {
  appId: string;
  outputDir: string;
  hasParityReport: boolean;
  hasArchitectureReport: boolean;
  hasStatusMd: boolean;
}

const IMPORT_MARKER_FILENAME = ".ooda-imported";

/**
 * Scan an AMF output directory for completed runs.
 * Each subdirectory with at least one output artifact is a run.
 */
export function findCompletedRuns(amfOutputDir: string): AMFRun[] {
  if (!fs.existsSync(amfOutputDir)) return [];

  const entries = fs.readdirSync(amfOutputDir, { withFileTypes: true });
  const runs: AMFRun[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const runDir = path.join(amfOutputDir, entry.name);
    const hasParityReport = fs.existsSync(path.join(runDir, "parity_report.json"));
    const hasArchitectureReport = fs.existsSync(path.join(runDir, "ARCHITECTURE_REPORT.md"));
    const hasStatusMd = fs.existsSync(path.join(runDir, "cr", "STATUS.md"));

    if (hasParityReport || hasArchitectureReport || hasStatusMd) {
      runs.push({
        appId: entry.name,
        outputDir: runDir,
        hasParityReport,
        hasArchitectureReport,
        hasStatusMd,
      });
    }
  }

  return runs;
}

/**
 * Check whether a run has already been imported (idempotency marker).
 */
export function alreadyImported(runDir: string): boolean {
  return fs.existsSync(path.join(runDir, IMPORT_MARKER_FILENAME));
}

/**
 * Mark a run as imported.
 */
export function markImported(runDir: string): void {
  fs.writeFileSync(path.join(runDir, IMPORT_MARKER_FILENAME), new Date().toISOString(), "utf-8");
}

/**
 * Extract findings from a parity_report.json.
 */
export function extractParityFindings(reportPath: string): AMFRunFinding[] {
  const raw = fs.readFileSync(reportPath, "utf-8");
  const report = JSON.parse(raw) as Record<string, unknown>;
  const findings: AMFRunFinding[] = [];

  const score = typeof report.score === "number" ? report.score : null;
  const gaps = Array.isArray(report.gaps) ? report.gaps : [];

  if (score !== null) {
    findings.push({
      text: `AMF parity score: ${score}${gaps.length > 0 ? ` — ${gaps.length} gap(s) detected` : ""}`,
      importance: score < 0.7 ? 0.9 : 0.6,
      findingType: "parity_gap",
    });
  }

  for (const gap of gaps) {
    const gapText =
      typeof gap === "string"
        ? gap
        : typeof gap === "object" && gap !== null
          ? JSON.stringify(gap)
          : String(gap);
    findings.push({
      text: `AMF parity gap: ${gapText.slice(0, 300)}`,
      importance: 0.8,
      findingType: "parity_gap",
    });
  }

  return findings;
}

/**
 * Extract findings from a CR STATUS.md — pull IMPLEMENTED entries as lessons.
 */
export function extractCRStatusFindings(statusPath: string): AMFRunFinding[] {
  const raw = fs.readFileSync(statusPath, "utf-8");
  const findings: AMFRunFinding[] = [];

  // Match rows with IMPLEMENTED status
  const implRegex = /\|\s*`?(\S+?)`?\s*\|[^|]*\|\s*`?IMPLEMENTED`?\s*\|[^|]*\|([^|]*)\|/g;
  let match;
  while ((match = implRegex.exec(raw)) !== null) {
    const crId = match[1];
    const notes = (match[2] ?? "").trim();
    if (crId && notes) {
      findings.push({
        text: `AMF CR ${crId} implemented: ${notes.slice(0, 300)}`,
        importance: 0.7,
        crId,
        findingType: "cr_lesson",
      });
    }
  }

  return findings;
}

/**
 * Extract findings from an ARCHITECTURE_REPORT.md.
 */
export function extractArchitectureFindings(reportPath: string): AMFRunFinding[] {
  const raw = fs.readFileSync(reportPath, "utf-8");
  const findings: AMFRunFinding[] = [];

  // Extract key findings from markdown sections (## headings with content)
  const sections = raw.split(/^## /m).slice(1); // skip preamble
  for (const section of sections.slice(0, 5)) {
    // cap at 5 sections
    const lines = section.split("\n");
    const heading = lines[0]?.trim() ?? "";
    const body = lines
      .slice(1)
      .filter((l) => l.trim().length > 0)
      .join(" ")
      .trim();

    if (heading && body.length > 20) {
      findings.push({
        text: `AMF architecture: ${heading} — ${body.slice(0, 300)}`,
        importance: 0.65,
        findingType: "architecture_finding",
      });
    }
  }

  return findings;
}

/**
 * Extract all findings from a single AMF run.
 */
export function extractRunFindings(run: AMFRun): AMFRunFinding[] {
  const findings: AMFRunFinding[] = [];

  if (run.hasParityReport) {
    try {
      findings.push(...extractParityFindings(path.join(run.outputDir, "parity_report.json")));
    } catch {
      // Skip malformed report
    }
  }

  if (run.hasStatusMd) {
    try {
      findings.push(...extractCRStatusFindings(path.join(run.outputDir, "cr", "STATUS.md")));
    } catch {
      // Skip malformed STATUS.md
    }
  }

  if (run.hasArchitectureReport) {
    try {
      findings.push(
        ...extractArchitectureFindings(path.join(run.outputDir, "ARCHITECTURE_REPORT.md")),
      );
    } catch {
      // Skip malformed report
    }
  }

  return findings;
}

// ============================================================================
// K1: Import AMF Knowledge → Episodic Store
// ============================================================================

/**
 * Import AMF run findings into the OODA episodic memory store.
 * Returns the number of findings imported.
 */
export async function importAMFKnowledge(
  amfOutputDir: string,
  episodicStore: EpisodicStore,
): Promise<number> {
  const runs = findCompletedRuns(amfOutputDir);
  let imported = 0;

  for (const run of runs) {
    if (alreadyImported(run.outputDir)) continue;

    const findings = extractRunFindings(run);
    for (const finding of findings) {
      if (episodicStore.store) {
        await episodicStore.store({
          text: finding.text,
          importance: finding.importance,
          category: "domain_context",
          source: "amf_harvester",
          actionId: finding.crId,
        });
        imported++;
      }
    }

    markImported(run.outputDir);
  }

  return imported;
}

// ============================================================================
// K3: OODA → AMF Knowledge Export
// ============================================================================

/** A lesson exported from OODA to AMF. */
export interface ExportedLesson {
  id: string;
  text: string;
  source: "ooda_archivist";
  confidence: number;
  outcomeLabeled: boolean;
}

/** The shared knowledge file structure. */
export interface OodaLessonsFile {
  lastUpdated: string;
  lessons: ExportedLesson[];
}

const AMF_RELEVANT_KEYWORDS = [
  "pipeline",
  "forensic",
  "gradle",
  "kotlin",
  "parity",
  "agent",
  "assembly",
  "module",
  "amf",
];

/**
 * Determine if a pattern is relevant to AMF pipeline work.
 */
export function isAMFRelevantPattern(pattern: PatternExtraction): boolean {
  const text = typeof pattern.value === "string" ? pattern.value : JSON.stringify(pattern.value);
  const searchText = `${pattern.key} ${text} ${pattern.reason}`.toLowerCase();
  return AMF_RELEVANT_KEYWORDS.some((kw) => searchText.includes(kw));
}

/**
 * Export AMF-relevant lessons from archivist patterns to a shared knowledge file.
 * Deduplicates by lesson ID (snake_case key from the pattern).
 */
export function exportOodaLessons(
  outputPath: string,
  patterns: PatternExtraction[],
  outcomeEvents?: EpisodicEvent[],
): number {
  const amfPatterns = patterns.filter(
    (p) =>
      (p.section === "lessons_learned" || p.section === "domain_context") &&
      isAMFRelevantPattern(p),
  );

  if (amfPatterns.length === 0) return 0;

  // Read existing file
  let existing: OodaLessonsFile = { lastUpdated: "", lessons: [] };
  if (fs.existsSync(outputPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(outputPath, "utf-8")) as OodaLessonsFile;
    } catch {
      // Start fresh on parse error
    }
  }

  const existingIds = new Set(existing.lessons.map((l) => l.id));
  let added = 0;

  for (const pattern of amfPatterns) {
    const id = `lesson-${pattern.key}`;
    if (existingIds.has(id)) continue;

    // Check if this pattern has an outcome label from events
    const hasOutcome =
      outcomeEvents?.some(
        (e) => e.source === "archivist" && e.outcome && e.text.includes(pattern.key),
      ) ?? false;

    existing.lessons.push({
      id,
      text: typeof pattern.value === "string" ? pattern.value : JSON.stringify(pattern.value),
      source: "ooda_archivist",
      confidence: 0.8,
      outcomeLabeled: hasOutcome,
    });
    existingIds.add(id);
    added++;
  }

  if (added > 0) {
    existing.lastUpdated = new Date().toISOString();
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(existing, null, 2) + "\n", "utf-8");
  }

  return added;
}

// ============================================================================
// K5: KNOWLEDGE.json Auto-Update from High-Importance AMF Imports
// ============================================================================

/**
 * Promote high-importance AMF findings from episodic store into KNOWLEDGE.json.
 * Considers events with source="amf_harvester" and importance >= 0.8.
 *
 * - Parity score improvements → domain_context.amf_pipeline
 * - Recurring failure modes → lessons_learned
 * - Architectural decisions → domain_context
 */
export function promoteAMFFindings(events: EpisodicEvent[], semanticStore: SemanticStore): number {
  const amfEvents = events.filter((e) => e.source === "amf_harvester" && e.importance >= 0.8);

  if (amfEvents.length === 0) return 0;

  let promoted = 0;

  // Group by finding type (inferred from text prefix)
  const parityEvents = amfEvents.filter((e) => e.text.startsWith("AMF parity"));
  const crEvents = amfEvents.filter((e) => e.text.startsWith("AMF CR"));

  // Parity score patterns → domain_context.amf_pipeline
  if (parityEvents.length > 0) {
    const latestParity = parityEvents[parityEvents.length - 1];
    semanticStore.upsertFact("domain_context", "amf_pipeline_parity", latestParity.text);
    promoted++;
  }

  // CR lessons with outcomes → lessons_learned
  for (const event of crEvents) {
    if (event.outcome === "success" || event.importance >= 0.9) {
      const key = event.actionId
        ? `amf_cr_${event.actionId.replace(/[^a-z0-9_]/gi, "_").slice(0, 40)}`
        : `amf_cr_${Date.now()}`;
      semanticStore.upsertFact("lessons_learned", key, event.text);
      promoted++;
    }
  }

  // Recurring failure modes (same text pattern appearing 2+ times)
  const failureCounts = new Map<string, number>();
  for (const event of amfEvents.filter((e) => e.text.includes("gap"))) {
    // Normalize to first 80 chars for grouping
    const normalized = event.text.slice(0, 80);
    failureCounts.set(normalized, (failureCounts.get(normalized) ?? 0) + 1);
  }
  for (const [pattern, count] of failureCounts) {
    if (count >= 2) {
      const key = `amf_recurring_${pattern
        .replace(/[^a-z0-9]/gi, "_")
        .slice(0, 40)
        .toLowerCase()}`;
      semanticStore.upsertFact(
        "lessons_learned",
        key,
        `Recurring AMF failure (${count}x): ${pattern}`,
      );
      promoted++;
    }
  }

  return promoted;
}
