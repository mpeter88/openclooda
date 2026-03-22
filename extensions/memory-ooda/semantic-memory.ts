/**
 * Tier 3 Semantic Memory — read/write wrapper for KNOWLEDGE.json.
 *
 * The Executive model never writes here directly.
 * Only the Archivist process calls upsertFact().
 */

import fs from "node:fs";
import path from "node:path";
import { createSnapshot, restoreLatestSnapshot } from "./snapshot.js";
import type { KnowledgeFile } from "./types.js";

const KNOWLEDGE_FILENAME = "KNOWLEDGE.json";

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

  return parsed;
}

/**
 * Upsert a fact into a section of KNOWLEDGE.json.
 *
 * Takes a snapshot before writing. If the write produces invalid JSON,
 * the snapshot is restored automatically.
 *
 * @param workspacePath - Path to the OODA workspace directory
 * @param section - Top-level key in KnowledgeFile (e.g. "stack", "projects", "people", "domain_context")
 * @param key - Key within the section's Record
 * @param value - Value to set
 */
export function upsertFact(
  workspacePath: string,
  section: string,
  key: string,
  value: unknown,
): void {
  const knowledge = getFacts(workspacePath);
  const filePath = knowledgePath(workspacePath);

  // Validate that the section is a Record-style section we can upsert into
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

  // Auto-initialise section if not yet present in the file (e.g. lessons_learned)
  if (!(section in knowledge)) {
    (knowledge as Record<string, unknown>)[section] = {};
  }

  // Snapshot before writing
  createSnapshot(workspacePath, KNOWLEDGE_FILENAME);

  // Perform the upsert
  const sectionData = knowledge[section as keyof KnowledgeFile];
  if (typeof sectionData === "object" && sectionData !== null && !Array.isArray(sectionData)) {
    (sectionData as Record<string, unknown>)[key] = value;
  }

  // Update metadata
  knowledge._meta.updated_at = new Date().toISOString();
  knowledge._meta.updated_by = "archivist";

  // Write with validation + atomic rename (crash-safe)
  const json = JSON.stringify(knowledge, null, 2) + "\n";

  // Verify the JSON we're about to write is valid by re-parsing
  try {
    JSON.parse(json);
  } catch {
    // Restore from snapshot if we somehow produced invalid JSON
    restoreLatestSnapshot(workspacePath, KNOWLEDGE_FILENAME);
    throw new Error("upsertFact produced invalid JSON; snapshot restored");
  }

  // Atomic write: write to .tmp then rename — a crash mid-write leaves
  // the .tmp as garbage but the last good KNOWLEDGE.json intact.
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, json, "utf-8");
  fs.renameSync(tmpPath, filePath);
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

  // Domain context
  const ctxEntries = Object.entries(knowledge.domain_context);
  if (ctxEntries.length > 0) {
    sections.push(`Domain Context:\n${ctxEntries.map(([k, v]) => `  ${k}: ${v}`).join("\n")}`);
  }

  if (sections.length === 0) return "";

  return `<semantic-memory>\nDistilled knowledge about the user and their world. Treat as stable context.\n\n${sections.join("\n\n")}\n</semantic-memory>`;
}
