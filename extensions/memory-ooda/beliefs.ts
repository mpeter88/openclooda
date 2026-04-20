/**
 * Tier 4 Beliefs — BELIEFS.json read/write, form/reinforce/weaken/retire/promote.
 *
 * CR_OODA_BELIEFS_TIER. Beliefs are evolving stances, distinct from ground-truth
 * facts in KNOWLEDGE.json. The Executive never writes here directly; the Archivist
 * forms beliefs via the BELIEVE action, the Meta-Reviewer weakens them on critical
 * failures, and the user or meta-reviewer can promote a stable high-confidence
 * belief to a KNOWLEDGE.json fact via the admission-gated proposal flow.
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
import type { Belief, BeliefEvidence, BeliefsFile } from "./types.js";

const BELIEFS_FILENAME = "BELIEFS.json";

// ============================================================================
// Defaults and I/O
// ============================================================================

export function createDefaultBeliefs(): BeliefsFile {
  return {
    _meta: {
      version: 1,
      updated_at: new Date().toISOString(),
      updated_by: "user",
      description:
        "Tier 4 Beliefs — evolving stances with evidence. Promoted to KNOWLEDGE.json only via admission-gated proposal. Written by Archivist/Meta-Reviewer; never by Executive.",
    },
    beliefs: {},
    _belief_log: [],
  };
}

export function beliefsPath(workspacePath: string): string {
  return path.join(workspacePath, BELIEFS_FILENAME);
}

export function getBeliefs(workspacePath: string): BeliefsFile {
  const filePath = beliefsPath(workspacePath);
  if (!fs.existsSync(filePath)) {
    const defaults = createDefaultBeliefs();
    stampContentHash(defaults as unknown as HashableFile);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(defaults, null, 2) + "\n", "utf-8");
    fs.renameSync(tmp, filePath);
    return defaults;
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw) as BeliefsFile;
  if (!parsed._meta || typeof parsed._meta.version !== "number") {
    throw new Error("Invalid BELIEFS.json: missing or malformed _meta");
  }
  const verdict = verifyContentHash(parsed as unknown as HashableFile);
  if (verdict.status === "mismatch") {
    reportRawEditWarning(workspacePath, BELIEFS_FILENAME, verdict.claimed, verdict.computed);
    try {
      createSnapshot(workspacePath, BELIEFS_FILENAME);
    } catch {
      // snapshot best-effort
    }
  }
  return parsed;
}

function writeBeliefs(workspacePath: string, beliefs: BeliefsFile): void {
  const filePath = beliefsPath(workspacePath);
  createSnapshot(workspacePath, BELIEFS_FILENAME);
  beliefs._meta.updated_at = new Date().toISOString();
  stampContentHash(beliefs as unknown as HashableFile);
  const json = JSON.stringify(beliefs, null, 2) + "\n";
  try {
    JSON.parse(json);
  } catch {
    restoreLatestSnapshot(workspacePath, BELIEFS_FILENAME);
    throw new Error("writeBeliefs produced invalid JSON; snapshot restored");
  }
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, json, "utf-8");
  fs.renameSync(tmp, filePath);
}

// ============================================================================
// Mutation Ops
// ============================================================================

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export interface FormBeliefInput {
  id: string;
  claim: string;
  domain: string;
  confidence: number;
  affects?: Array<"triage" | "strategy" | "executive">;
  firstEvidence?: BeliefEvidence;
}

export function formBelief(workspacePath: string, input: FormBeliefInput): Belief {
  const beliefs = getBeliefs(workspacePath);
  if (beliefs.beliefs[input.id]) {
    throw new Error(`Belief already exists: ${input.id} (use reinforceBelief)`);
  }
  const now = new Date().toISOString();
  const belief: Belief = {
    id: input.id,
    claim: input.claim,
    domain: input.domain,
    confidence: clamp01(input.confidence),
    formed_at: now,
    updated_at: now,
    evidence: input.firstEvidence ? [input.firstEvidence] : [],
    contradicting_evidence: [],
    affects: input.affects ?? ["triage", "strategy"],
  };
  beliefs.beliefs[input.id] = belief;
  beliefs._belief_log.push({
    timestamp: now,
    action: "formed",
    belief_id: input.id,
    delta: belief.confidence,
    reason: `Formed with confidence ${belief.confidence.toFixed(2)}`,
  });
  writeBeliefs(workspacePath, beliefs);
  return belief;
}

/** Reinforce a belief. Confidence rises by min(0.15, claimed-current) toward claimed. */
export function reinforceBelief(
  workspacePath: string,
  id: string,
  evidence: BeliefEvidence,
  claimedConfidence?: number,
): Belief {
  const beliefs = getBeliefs(workspacePath);
  const belief = beliefs.beliefs[id];
  if (!belief) throw new Error(`Belief not found: ${id}`);
  if (belief.retired) throw new Error(`Cannot reinforce retired belief: ${id}`);

  const target =
    claimedConfidence !== undefined ? clamp01(claimedConfidence) : belief.confidence + 0.1;
  const delta = Math.min(0.15, Math.max(0, target - belief.confidence));
  const previous = belief.confidence;
  belief.confidence = clamp01(belief.confidence + delta);
  belief.evidence.push(evidence);
  belief.updated_at = new Date().toISOString();

  beliefs._belief_log.push({
    timestamp: belief.updated_at,
    action: "reinforced",
    belief_id: id,
    delta: belief.confidence - previous,
    reason: `Reinforced via ${evidence.source}:${evidence.ref}`,
  });
  writeBeliefs(workspacePath, beliefs);
  return belief;
}

/** Weaken a belief — confidence drops toward claimed, contradicting evidence appended. */
export function weakenBelief(
  workspacePath: string,
  id: string,
  evidence: BeliefEvidence,
  claimedConfidence?: number,
): Belief {
  const beliefs = getBeliefs(workspacePath);
  const belief = beliefs.beliefs[id];
  if (!belief) throw new Error(`Belief not found: ${id}`);
  if (belief.retired) throw new Error(`Cannot weaken retired belief: ${id}`);

  const target =
    claimedConfidence !== undefined ? clamp01(claimedConfidence) : belief.confidence - 0.1;
  const delta = Math.min(0.2, Math.max(0, belief.confidence - target));
  const previous = belief.confidence;
  belief.confidence = clamp01(belief.confidence - delta);
  belief.contradicting_evidence.push(evidence);
  belief.updated_at = new Date().toISOString();

  beliefs._belief_log.push({
    timestamp: belief.updated_at,
    action: "weakened",
    belief_id: id,
    delta: belief.confidence - previous,
    reason: `Weakened via contradicting ${evidence.source}:${evidence.ref}`,
  });
  writeBeliefs(workspacePath, beliefs);
  return belief;
}

export function retireBelief(workspacePath: string, id: string, reason: string): Belief {
  const beliefs = getBeliefs(workspacePath);
  const belief = beliefs.beliefs[id];
  if (!belief) throw new Error(`Belief not found: ${id}`);
  const now = new Date().toISOString();
  belief.retired = { at: now, reason };
  belief.updated_at = now;
  beliefs._belief_log.push({
    timestamp: now,
    action: "retired",
    belief_id: id,
    delta: -belief.confidence,
    reason,
  });
  writeBeliefs(workspacePath, beliefs);
  return belief;
}

/**
 * Check whether a belief meets promotion criteria (for the PolicyProposal flow).
 * Does NOT perform promotion — that requires user approval + admission gate.
 */
export function canPromote(
  belief: Belief,
  now: number = Date.now(),
  minConfidence = 0.85,
  minAgeDays = 30,
): { eligible: boolean; reason: string } {
  if (belief.retired) return { eligible: false, reason: "retired" };
  if (belief.confidence < minConfidence) {
    return {
      eligible: false,
      reason: `confidence ${belief.confidence.toFixed(2)} < ${minConfidence}`,
    };
  }
  const formed = new Date(belief.formed_at).getTime();
  const ageDays = (now - formed) / (24 * 60 * 60 * 1000);
  if (ageDays < minAgeDays) {
    return { eligible: false, reason: `age ${ageDays.toFixed(1)}d < ${minAgeDays}d` };
  }
  // Check contradicting evidence in last 30 days
  const cutoff = now - 30 * 24 * 60 * 60 * 1000;
  const recentContradictions = belief.contradicting_evidence.filter(
    (e) => new Date(e.at).getTime() >= cutoff,
  );
  if (recentContradictions.length > 0) {
    return {
      eligible: false,
      reason: `${recentContradictions.length} contradiction(s) in last 30d`,
    };
  }
  return { eligible: true, reason: "meets all promotion criteria" };
}

// ============================================================================
// Readers
// ============================================================================

/** Return currently-active (non-retired) beliefs sorted by confidence × recency. */
export function getActiveBeliefs(
  workspacePath: string,
  opts?: {
    minConfidence?: number;
    domain?: string;
    affectsPhase?: Belief["affects"][number];
    limit?: number;
  },
): Belief[] {
  const beliefs = getBeliefs(workspacePath);
  const floor = opts?.minConfidence ?? 0;
  const now = Date.now();
  const scored: Array<{ belief: Belief; score: number }> = [];
  for (const b of Object.values(beliefs.beliefs)) {
    if (b.retired) continue;
    if (b.confidence < floor) continue;
    if (opts?.domain && b.domain !== opts.domain) continue;
    if (opts?.affectsPhase && !b.affects.includes(opts.affectsPhase)) continue;
    const ageMs = now - new Date(b.updated_at).getTime();
    const recencyBoost = Math.max(0, 1 - ageMs / (30 * 24 * 60 * 60 * 1000));
    scored.push({ belief: b, score: b.confidence * 0.7 + recencyBoost * 0.3 });
  }
  scored.sort((a, b) => b.score - a.score);
  const limited = opts?.limit ? scored.slice(0, opts.limit) : scored;
  return limited.map((s) => s.belief);
}

/** Format for system-prompt injection. Drops evidence chains — just claim + confidence. */
export function formatBeliefsForContext(
  beliefs: Belief[],
  opts?: { floor?: number; limit?: number },
): string {
  const floor = opts?.floor ?? 0.6;
  const limit = opts?.limit ?? 10;
  const filtered = beliefs.filter((b) => b.confidence >= floor).slice(0, limit);
  if (filtered.length === 0) return "";
  const lines = filtered.map(
    (b) => `  [${b.confidence.toFixed(2)}] ${b.claim} (updated ${b.updated_at.slice(0, 10)})`,
  );
  return `<current-beliefs confidence-floor="${floor}">
Agent's current working theories; subject to revision. Distinct from stable facts.
${lines.join("\n")}
</current-beliefs>`;
}
