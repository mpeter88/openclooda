/**
 * Tier 3 Semantic Memory — read/write wrapper for KNOWLEDGE.json.
 *
 * The Executive model never writes here directly.
 * Only the Archivist process calls upsertFact().
 */

import fs from "node:fs";
import path from "node:path";
import {
  reportRawEditWarning,
  stampContentHash,
  verifyContentHash,
  type HashableFile,
} from "./content-hash.js";
import { createSnapshot, restoreLatestSnapshot } from "./snapshot.js";
import type { KnowledgeFile, TemporalEnvelope, UpsertOptions } from "./types.js";

const KNOWLEDGE_FILENAME = "KNOWLEDGE.json";

// ============================================================================
// Bitemporal helpers (CR_OODA_BITEMPORAL_KNOWLEDGE)
// ============================================================================

/** Canonical envelope key: `<section>.<fact_key>`. */
function envelopeKey(section: string, key: string): string {
  return `${section}.${key}`;
}

/** Read section's fact value — handles Record-shaped sections only. */
function readSectionFact(knowledge: KnowledgeFile, section: string, key: string): unknown {
  const sectionData = (knowledge as unknown as Record<string, unknown>)[section];
  if (typeof sectionData !== "object" || sectionData === null || Array.isArray(sectionData)) {
    return undefined;
  }
  return (sectionData as Record<string, unknown>)[key];
}

/** Deep-equality check suitable for fact values (primitives + plain objects). */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Ensure at most one envelope per key has `valid_to === null`. */
function assertTemporalInvariant(knowledge: KnowledgeFile): void {
  const temporal = knowledge._temporal ?? {};
  for (const [canonicalKey, envelopes] of Object.entries(temporal)) {
    const valid = envelopes.filter((e) => e.valid_to === null);
    if (valid.length > 1) {
      throw new Error(
        `Temporal invariant violated for ${canonicalKey}: ${valid.length} envelopes with valid_to=null`,
      );
    }
  }
}

/** Find the currently-valid envelope for a key (valid_to === null), if any. */
function findCurrentEnvelope(
  temporal: Record<string, TemporalEnvelope[]>,
  section: string,
  key: string,
): TemporalEnvelope | undefined {
  const envs = temporal[envelopeKey(section, key)];
  if (!envs) return undefined;
  return envs.find((e) => e.valid_to === null);
}

/**
 * Create a default empty KnowledgeFile template.
 */
export function createDefaultKnowledge(): KnowledgeFile {
  return {
    _meta: {
      version: 1,
      updated_at: new Date().toISOString(),
      updated_by: "user",
      turn_count_at_last_update: 0,
      description:
        "Tier 3 Semantic Memory — distilled, non-timestamped facts. Updated by the Archivist process; never written by the Executive model directly.",
    },
    identity: {
      name: "",
      timezone: "",
      location_primary: "",
      language_primary: "en",
      communication_style: "",
    },
    stack: {},
    projects: {},
    people: {},
    preferences: {
      always_ask_before: [],
      never_do: [],
      prefers_async_over_sync: false,
      prefers_delegation_over_diy: false,
      response_length: "concise",
      notes: "",
    },
    commitments: [],
    domain_context: {},
    lessons_learned: {},
    _archivist_log: [],
    _temporal: {},
  };
}

/**
 * Resolve the full path to KNOWLEDGE.json within a workspace.
 */
export function knowledgePath(workspacePath: string): string {
  return path.join(workspacePath, KNOWLEDGE_FILENAME);
}

/**
 * Read and parse KNOWLEDGE.json.
 * Creates a default template if the file doesn't exist.
 */
export function getFacts(workspacePath: string): KnowledgeFile {
  const filePath = knowledgePath(workspacePath);

  if (!fs.existsSync(filePath)) {
    const defaults = createDefaultKnowledge();
    stampContentHash(defaults as unknown as HashableFile);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = filePath + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(defaults, null, 2) + "\n", "utf-8");
    fs.renameSync(tmpPath, filePath);
    return defaults;
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw) as KnowledgeFile;

  // Basic structural validation — must have _meta and identity at minimum
  if (!parsed._meta || typeof parsed._meta.version !== "number") {
    throw new Error(`Invalid KNOWLEDGE.json: missing or malformed _meta block`);
  }

  // CR_OODA_PASS_K_ACCEPTANCE_GATE (Path C): raw-edit detection. Mismatch
  // means the file drifted outside the authoritative writer; log once and
  // take a snapshot so the current state is recoverable.
  const verdict = verifyContentHash(parsed as unknown as HashableFile);
  if (verdict.status === "mismatch") {
    reportRawEditWarning(workspacePath, KNOWLEDGE_FILENAME, verdict.claimed, verdict.computed);
    try {
      createSnapshot(workspacePath, KNOWLEDGE_FILENAME);
    } catch {
      // snapshot best-effort
    }
  }

  return parsed;
}

/**
 * Upsert a fact into a section of KNOWLEDGE.json.
 *
 * Takes a snapshot before writing. Bitemporal envelopes tracked in `_temporal`:
 * - identical re-write → reconfirmation (append to existing envelope's reconfirmations[])
 * - different value → supersession (seal predecessor, write new envelope)
 *
 * If the write produces invalid JSON or violates the temporal invariant
 * (>1 valid_to=null envelope per key), the snapshot is restored automatically.
 */
export function upsertFact(
  workspacePath: string,
  section: string,
  key: string,
  value: unknown,
  opts?: UpsertOptions,
): void {
  const knowledge = getFacts(workspacePath);
  const filePath = knowledgePath(workspacePath);

  const recordSections = [
    "stack",
    "projects",
    "people",
    "domain_context",
    "lessons_learned",
    "preferences_notes",
  ];
  if (!recordSections.includes(section)) {
    throw new Error(
      `Cannot upsert into section "${section}". Allowed: ${recordSections.join(", ")}`,
    );
  }

  // Auto-initialise section + _temporal
  if (!(section in knowledge)) {
    (knowledge as Record<string, unknown>)[section] = {};
  }
  if (!knowledge._temporal) {
    knowledge._temporal = {};
  }

  createSnapshot(workspacePath, KNOWLEDGE_FILENAME);

  const now = new Date().toISOString();
  const canonicalKey = envelopeKey(section, key);
  const currentValue = readSectionFact(knowledge, section, key);
  const currentEnvelope = findCurrentEnvelope(knowledge._temporal, section, key);

  // --- Bitemporal envelope logic ---
  if (!knowledge._temporal[canonicalKey]) {
    knowledge._temporal[canonicalKey] = [];
  }

  if (currentEnvelope) {
    if (valuesEqual(currentValue, value)) {
      // Reconfirmation — append timestamp; no new envelope.
      if (!currentEnvelope.reconfirmations) {
        currentEnvelope.reconfirmations = [];
      }
      currentEnvelope.reconfirmations.push(now);
    } else {
      // Supersession — seal predecessor, add new envelope.
      currentEnvelope.valid_to = now;
      currentEnvelope.invalidation_reason = opts?.invalidation_reason ?? "superseded";
      const newEnvelope: TemporalEnvelope = {
        valid_from: opts?.valid_from ?? now,
        valid_to: null,
        ingested_at: now,
        ingested_by: opts?.ingested_by ?? "archivist",
        supersedes: currentEnvelope.ingested_at,
        confidence: opts?.confidence ?? 0.9,
      };
      knowledge._temporal[canonicalKey].push(newEnvelope);
    }
  } else if (currentValue !== undefined) {
    // Migration path: section has value but no envelope. Lazy back-fill.
    const migrated: TemporalEnvelope = {
      valid_from: knowledge._meta.updated_at ?? now,
      valid_to: value === currentValue ? null : now,
      ingested_at: knowledge._meta.updated_at ?? now,
      ingested_by: "migration",
      confidence: 0.7,
    };
    knowledge._temporal[canonicalKey].push(migrated);
    if (!valuesEqual(currentValue, value)) {
      migrated.invalidation_reason = opts?.invalidation_reason ?? "superseded";
      const newEnvelope: TemporalEnvelope = {
        valid_from: opts?.valid_from ?? now,
        valid_to: null,
        ingested_at: now,
        ingested_by: opts?.ingested_by ?? "archivist",
        supersedes: migrated.ingested_at,
        confidence: opts?.confidence ?? 0.9,
      };
      knowledge._temporal[canonicalKey].push(newEnvelope);
    }
  } else {
    // ADD: fresh fact.
    const newEnvelope: TemporalEnvelope = {
      valid_from: opts?.valid_from ?? now,
      valid_to: null,
      ingested_at: now,
      ingested_by: opts?.ingested_by ?? "archivist",
      confidence: opts?.confidence ?? 0.9,
    };
    knowledge._temporal[canonicalKey].push(newEnvelope);
  }

  // Perform the flat-section upsert
  const sectionData = knowledge[section as keyof KnowledgeFile];
  if (typeof sectionData === "object" && sectionData !== null && !Array.isArray(sectionData)) {
    (sectionData as Record<string, unknown>)[key] = value;
  }

  knowledge._meta.updated_at = now;
  knowledge._meta.updated_by = opts?.ingested_by === "user" ? "user" : "archivist";

  // Temporal invariant check BEFORE write
  try {
    assertTemporalInvariant(knowledge);
  } catch (err) {
    restoreLatestSnapshot(workspacePath, KNOWLEDGE_FILENAME);
    throw new Error(`upsertFact invariant violation; snapshot restored: ${String(err)}`);
  }

  // Stamp content hash so downstream readers can detect raw edits.
  stampContentHash(knowledge as unknown as HashableFile);

  const json = JSON.stringify(knowledge, null, 2) + "\n";

  try {
    JSON.parse(json);
  } catch {
    restoreLatestSnapshot(workspacePath, KNOWLEDGE_FILENAME);
    throw new Error("upsertFact produced invalid JSON; snapshot restored");
  }

  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, json, "utf-8");
  fs.renameSync(tmpPath, filePath);
}

/**
 * Invalidate the currently-valid envelope for a fact.
 * Does NOT remove the value from the flat section — filtered out by getCurrentFacts.
 */
export function invalidateFact(
  workspacePath: string,
  section: string,
  key: string,
  reason: string,
): void {
  const knowledge = getFacts(workspacePath);
  const filePath = knowledgePath(workspacePath);

  if (!knowledge._temporal) {
    knowledge._temporal = {};
  }
  const current = findCurrentEnvelope(knowledge._temporal, section, key);
  if (!current) {
    // Nothing to invalidate — either key doesn't exist or already invalidated.
    return;
  }

  createSnapshot(workspacePath, KNOWLEDGE_FILENAME);

  const now = new Date().toISOString();
  current.valid_to = now;
  current.invalidation_reason = reason;
  knowledge._meta.updated_at = now;

  try {
    assertTemporalInvariant(knowledge);
  } catch (err) {
    restoreLatestSnapshot(workspacePath, KNOWLEDGE_FILENAME);
    throw new Error(`invalidateFact invariant violation; snapshot restored: ${String(err)}`);
  }

  stampContentHash(knowledge as unknown as HashableFile);
  const json = JSON.stringify(knowledge, null, 2) + "\n";
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, json, "utf-8");
  fs.renameSync(tmpPath, filePath);
}

/**
 * Delete a fact outright from the flat section.
 * Used by the CRUD classifier's DELETE path when bitemporal is unavailable
 * or when the caller explicitly wants destructive removal.
 */
export function deleteFact(workspacePath: string, section: string, key: string): void {
  const knowledge = getFacts(workspacePath);
  const filePath = knowledgePath(workspacePath);

  const sectionData = (knowledge as unknown as Record<string, unknown>)[section];
  if (typeof sectionData !== "object" || sectionData === null || Array.isArray(sectionData)) {
    return;
  }
  const rec = sectionData as Record<string, unknown>;
  if (!(key in rec)) return;

  createSnapshot(workspacePath, KNOWLEDGE_FILENAME);
  delete rec[key];

  // Also invalidate any temporal envelope if present
  if (knowledge._temporal) {
    const current = findCurrentEnvelope(knowledge._temporal, section, key);
    if (current) {
      current.valid_to = new Date().toISOString();
      current.invalidation_reason = "deleted";
    }
  }

  knowledge._meta.updated_at = new Date().toISOString();

  stampContentHash(knowledge as unknown as HashableFile);
  const json = JSON.stringify(knowledge, null, 2) + "\n";
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, json, "utf-8");
  fs.renameSync(tmpPath, filePath);
}

/**
 * Return KnowledgeFile filtered to currently-valid facts (valid_to === null).
 * Facts whose envelope is invalidated are stripped from the flat sections.
 */
export function getCurrentFacts(workspacePath: string): KnowledgeFile {
  const knowledge = getFacts(workspacePath);
  if (!knowledge._temporal) return knowledge;

  const result: KnowledgeFile = JSON.parse(JSON.stringify(knowledge));
  for (const [canonicalKey, envelopes] of Object.entries(knowledge._temporal)) {
    const current = envelopes.find((e) => e.valid_to === null);
    if (current) continue;
    // No currently-valid envelope — strip the flat value.
    const [section, key] = canonicalKey.split(".");
    if (!section || !key) continue;
    const sectionData = (result as unknown as Record<string, unknown>)[section];
    if (typeof sectionData === "object" && sectionData !== null && !Array.isArray(sectionData)) {
      delete (sectionData as Record<string, unknown>)[key];
    }
  }
  return result;
}

/** Return full envelope history for a fact key, oldest first. */
export function getFactHistory(
  workspacePath: string,
  section: string,
  key: string,
): TemporalEnvelope[] {
  const knowledge = getFacts(workspacePath);
  const envs = knowledge._temporal?.[envelopeKey(section, key)];
  if (!envs) return [];
  return [...envs].sort((a, b) => a.ingested_at.localeCompare(b.ingested_at));
}

/**
 * Return facts that were currently-valid at the given ISO timestamp.
 * Facts whose envelope's [valid_from, valid_to) contained the timestamp are included.
 */
export function getFactsAsOf(workspacePath: string, timestamp: string): KnowledgeFile {
  const knowledge = getFacts(workspacePath);
  if (!knowledge._temporal) return knowledge;

  const asOfMs = new Date(timestamp).getTime();
  const result: KnowledgeFile = JSON.parse(JSON.stringify(knowledge));

  // For each temporal key, find the envelope valid at timestamp.
  for (const [canonicalKey, envelopes] of Object.entries(knowledge._temporal)) {
    const matching = envelopes.find((e) => {
      const fromMs = new Date(e.valid_from).getTime();
      const toMs = e.valid_to === null ? Infinity : new Date(e.valid_to).getTime();
      return fromMs <= asOfMs && asOfMs < toMs;
    });
    const [section, key] = canonicalKey.split(".");
    if (!section || !key) continue;
    const sectionData = (result as unknown as Record<string, unknown>)[section];
    if (typeof sectionData !== "object" || sectionData === null || Array.isArray(sectionData)) {
      continue;
    }
    const rec = sectionData as Record<string, unknown>;
    if (!matching) {
      delete rec[key];
    }
    // If matching exists but value in current file is different from asOf-era value,
    // we cannot reconstruct the old scalar/object without storing values in envelopes.
    // v1 limitation: getFactsAsOf returns the CURRENT value for keys that were valid
    // at the timestamp. Full value history requires storing value in envelope (v2).
  }
  return result;
}

/**
 * Append an entry to the _archivist_log.
 * Takes a snapshot before writing (matching upsertFact safety pattern).
 */
export function appendArchivistLog(workspacePath: string, action: string, reason: string): void {
  const knowledge = getFacts(workspacePath);
  const filePath = knowledgePath(workspacePath);

  createSnapshot(workspacePath, KNOWLEDGE_FILENAME);

  knowledge._archivist_log.push({
    timestamp: new Date().toISOString(),
    action,
    reason,
  });

  knowledge._meta.updated_at = new Date().toISOString();

  stampContentHash(knowledge as unknown as HashableFile);
  const json = JSON.stringify(knowledge, null, 2) + "\n";

  try {
    JSON.parse(json);
  } catch {
    restoreLatestSnapshot(workspacePath, KNOWLEDGE_FILENAME);
    throw new Error("appendArchivistLog produced invalid JSON; snapshot restored");
  }

  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, json, "utf-8");
  fs.renameSync(tmpPath, filePath);
}

/**
 * Format KNOWLEDGE.json facts as a context string for system prompt injection.
 *
 * Returns a human-readable summary suitable for prepending to the agent's
 * system context. Empty sections are omitted.
 */
export function formatFactsForContext(knowledge: KnowledgeFile): string {
  const sections: string[] = [];

  // Identity
  const id = knowledge.identity;
  const idParts: string[] = [];
  if (id.name) idParts.push(`Name: ${id.name}`);
  if (id.timezone) idParts.push(`Timezone: ${id.timezone}`);
  if (id.location_primary) idParts.push(`Location: ${id.location_primary}`);
  if (id.communication_style) idParts.push(`Communication style: ${id.communication_style}`);
  if (idParts.length > 0) {
    sections.push(`Identity:\n${idParts.map((p) => `  ${p}`).join("\n")}`);
  }

  // Stack
  const stackEntries = Object.entries(knowledge.stack);
  if (stackEntries.length > 0) {
    sections.push(`Tech Stack:\n${stackEntries.map(([k, v]) => `  ${k}: ${v}`).join("\n")}`);
  }

  // Projects
  const projectEntries = Object.entries(knowledge.projects);
  if (projectEntries.length > 0) {
    const lines = projectEntries.map(([name, p]) => {
      const parts = [`status=${p.status}`];
      if (p.priority_domain) parts.push(`domain=${p.priority_domain}`);
      if (p.key_constraint) parts.push(`constraint: ${p.key_constraint}`);
      return `  ${name}: ${parts.join(", ")}`;
    });
    sections.push(`Projects:\n${lines.join("\n")}`);
  }

  // People
  const peopleEntries = Object.entries(knowledge.people);
  if (peopleEntries.length > 0) {
    const lines = peopleEntries.map(([name, p]) => {
      const parts: string[] = [];
      if (p.role) parts.push(p.role);
      if (p.relationship) parts.push(p.relationship);
      if (p.communication_preference) parts.push(`prefers: ${p.communication_preference}`);
      return `  ${name}: ${parts.join(", ")}`;
    });
    sections.push(`People:\n${lines.join("\n")}`);
  }

  // Preferences
  const prefs = knowledge.preferences;
  const prefParts: string[] = [];
  if (prefs.never_do.length > 0) {
    prefParts.push(`Never do: ${prefs.never_do.join("; ")}`);
  }
  if (prefs.always_ask_before.length > 0) {
    prefParts.push(`Always ask before: ${prefs.always_ask_before.join("; ")}`);
  }
  if (prefs.response_length !== "concise") {
    prefParts.push(`Response length: ${prefs.response_length}`);
  }
  if (prefs.notes) {
    prefParts.push(`Notes: ${prefs.notes}`);
  }
  if (prefParts.length > 0) {
    sections.push(`Preferences:\n${prefParts.map((p) => `  ${p}`).join("\n")}`);
  }

  // Commitments
  if (knowledge.commitments.length > 0) {
    const lines = knowledge.commitments.map((c) => {
      const when = c.day ? `${c.recurrence} ${c.day} ${c.time}` : `${c.recurrence} ${c.time}`;
      return `  ${c.label}: ${when}${c.blocking ? " (blocking)" : ""}`;
    });
    sections.push(`Commitments:\n${lines.join("\n")}`);
  }

  // Lessons learned
  const lessonEntries = Object.entries(knowledge.lessons_learned ?? {});
  if (lessonEntries.length > 0) {
    sections.push(`Lessons Learned:\n${lessonEntries.map(([k, v]) => `  ${k}: ${v}`).join("\n")}`);
  }

  // Domain context
  const ctxEntries = Object.entries(knowledge.domain_context);
  if (ctxEntries.length > 0) {
    sections.push(`Domain Context:\n${ctxEntries.map(([k, v]) => `  ${k}: ${v}`).join("\n")}`);
  }

  if (sections.length === 0) return "";

  return `<semantic-memory>\nDistilled knowledge about the user and their world. Treat as stable context.\n\n${sections.join("\n\n")}\n</semantic-memory>`;
}
