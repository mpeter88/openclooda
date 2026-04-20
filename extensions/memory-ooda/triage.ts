/**
 * OODA Phase A — Triage (Observe + Orient)
 *
 * A lightweight model classifies the incoming observation against
 * Tier 3 facts and domain priorities, producing a SITREP that
 * controls whether the full OODA chain fires.
 *
 * Feature-flagged off by default.
 */

import { errorMessage, stripCodeFences } from "./parse-utils.js";
import type {
  KnowledgeFile,
  PrioritiesFile,
  SITREP,
  TrajectoryScalingConfig,
  TrajectoryScalingMode,
} from "./types.js";

// ============================================================================
// Types
// ============================================================================

export interface TriageInput {
  /** The raw observation (user message, webhook event, tool output) */
  observation: string;
  /** Tier 3 semantic facts from KNOWLEDGE.json */
  facts: KnowledgeFile;
  /** Domain weights and thresholds from PRIORITIES.json */
  priorities: PrioritiesFile;
  /** Domain trajectory scores from recent outcome history. Key: domain name, value: [-1.0, 1.0]. */
  domainTrajectories?: Record<string, number>;
}

/**
 * Abstraction for calling a lightweight model.
 * Accepts a prompt string and returns the raw text response.
 * Injected for testability — production wires this to runEmbeddedPiAgent.
 */
export type ModelCallFn = (prompt: string) => Promise<string>;

export interface TriageOptions {
  /** Max retries on malformed JSON (default: 1) */
  maxRetries?: number;
}

// ============================================================================
// Default SITREP (fallback on triage failure)
// ============================================================================

export function createDefaultSITREP(observation: string): SITREP {
  return {
    priority: 5,
    summary: observation.slice(0, 200),
    conflictsDetected: [],
    relevantFacts: [],
    recommendedDomains: [],
  };
}

// ============================================================================
// Prompt Construction
// ============================================================================

function formatFactsBlock(facts: KnowledgeFile): string {
  const sections: string[] = [];

  if (facts.identity.name) {
    sections.push(`User: ${facts.identity.name}`);
  }
  if (facts.identity.timezone) {
    sections.push(`Timezone: ${facts.identity.timezone}`);
  }
  if (facts.identity.communication_style) {
    sections.push(`Communication style: ${facts.identity.communication_style}`);
  }

  const stackEntries = Object.entries(facts.stack);
  if (stackEntries.length > 0) {
    sections.push(`Stack: ${stackEntries.map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }

  const projectEntries = Object.entries(facts.projects);
  if (projectEntries.length > 0) {
    const lines = projectEntries.map(
      ([name, p]) => `  ${name}: status=${p.status}, domain=${p.priority_domain}`,
    );
    sections.push(`Projects:\n${lines.join("\n")}`);
  }

  const neverDo = facts.preferences.never_do;
  if (neverDo.length > 0) {
    sections.push(`Never do: ${neverDo.join("; ")}`);
  }

  const alwaysAsk = facts.preferences.always_ask_before;
  if (alwaysAsk.length > 0) {
    sections.push(`Always ask before: ${alwaysAsk.join("; ")}`);
  }

  return sections.join("\n");
}

function formatCommitmentsBlock(facts: KnowledgeFile): string {
  if (facts.commitments.length === 0) {
    return "";
  }
  return facts.commitments
    .map((c) => {
      const when = c.day ? `${c.recurrence} ${c.day} ${c.time}` : `${c.recurrence} ${c.time}`;
      return `  ${c.label}: ${when} (${c.timezone})${c.blocking ? " [BLOCKING]" : ""}`;
    })
    .join("\n");
}

function formatDomainsBlock(priorities: PrioritiesFile): string {
  const entries = Object.entries(priorities.domains);
  if (entries.length === 0) {
    return "No domains configured.";
  }

  return entries
    .toSorted(([, a], [, b]) => b.weight - a.weight)
    .map(([name, d]) => `  ${name} (weight=${d.weight}): ${d.description}`)
    .join("\n");
}

export function buildTriagePrompt(input: TriageInput): string {
  const factsBlock = formatFactsBlock(input.facts);
  const commitmentsBlock = formatCommitmentsBlock(input.facts);
  const domainsBlock = formatDomainsBlock(input.priorities);
  const userName = input.facts.identity.name || "the user";

  return `You are a domain-aware priority dispatcher for an AI agent acting on behalf of ${userName}.

Given an observation, user context, and active domains, produce a SITREP (situation report) classifying this observation's priority and relevance to the user's current goals.

## User Context
${factsBlock || "No user context available."}
${commitmentsBlock ? `\n## Active Commitments\n${commitmentsBlock}` : ""}

## Active Domains (priority weights)
${domainsBlock}

## Observation
${input.observation}

## Example
Observation: "The deploy pipeline is failing on staging"
Output:
{"priority":8,"summary":"Staging deploy pipeline failure — blocks releases","conflictsDetected":[],"relevantFacts":["projects.ooda-agent"],"recommendedDomains":["operations"]}

## Output Format
Respond with raw JSON only. Do not wrap in code fences or add any text outside the JSON.

{
  "priority": <integer 1-10>,
  "summary": "<one sentence, max 120 characters>",
  "conflictsDetected": [<conflicts with known facts, commitments, or preferences — empty array if none>],
  "relevantFacts": [<KNOWLEDGE.json keys that informed your reasoning — empty array if none>],
  "recommendedDomains": [<domain names from the active domains list — empty array if none>],
  "attention": "<optional — only when priority >= 6: single imperative ≤15 words for the executive>"
}

## attention field
When priority >= 6, add an "attention" field — a single imperative sentence (≤15 words)
directing the responding model on what to emphasize or watch for this turn.
Leave "attention" out entirely for priority <= 5.

Examples:
  "Deadline pressure is high — surface blockers before context."
  "User is debugging a live run — skip theory, go straight to cause."
  "This is client-facing — cite evidence, not opinion."
  "Multiple open CRs in flight — confirm which is being addressed."
  "Pattern matches a known failure mode — check for the documented fix first."

## Priority Calibration
- 1-2: Trivial — greetings, acknowledgments, no action needed
- 3-4: Low — general questions, informational requests
- 5-6: Medium — task requests, code changes, decisions needed
- 7-8: High — time-sensitive work, blocking issues, commitments at risk
- 9-10: Critical — production incidents, security issues, deadline breaches, conflicts with active commitments

If the observation is ambiguous or lacks enough information to classify confidently, default to priority 5 and note the ambiguity in the summary.

Verify your JSON is syntactically valid before responding.`;
}

// ============================================================================
// Response Parsing
// ============================================================================

const VALID_PRIORITIES = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

export function parseSITREP(raw: string): SITREP {
  const cleaned = stripCodeFences(raw);
  const parsed = JSON.parse(cleaned);

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("SITREP must be a JSON object");
  }

  const priority = parsed.priority;
  if (
    typeof priority !== "number" ||
    !Number.isInteger(priority) ||
    !VALID_PRIORITIES.has(priority)
  ) {
    throw new Error(`Invalid priority: ${String(priority)}. Must be an integer 1-10.`);
  }

  const summary = parsed.summary;
  if (typeof summary !== "string" || summary.length === 0) {
    throw new Error("SITREP must include a non-empty summary");
  }

  return {
    priority: priority as SITREP["priority"],
    summary,
    conflictsDetected: Array.isArray(parsed.conflictsDetected)
      ? parsed.conflictsDetected.filter((s: unknown) => typeof s === "string")
      : [],
    relevantFacts: Array.isArray(parsed.relevantFacts)
      ? parsed.relevantFacts.filter((s: unknown) => typeof s === "string")
      : [],
    recommendedDomains: Array.isArray(parsed.recommendedDomains)
      ? parsed.recommendedDomains.filter((s: unknown) => typeof s === "string")
      : [],
    attention: (() => {
      if (typeof parsed.attention !== "string" || parsed.attention.trim().length === 0) {
        return undefined;
      }
      // Trim to 15 words max
      const words = parsed.attention.trim().split(/\s+/);
      return words.length > 15 ? words.slice(0, 15).join(" ") + "…" : parsed.attention.trim();
    })(),
  };
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Run the triage phase: call a lightweight model with the observation
 * and context, returning a SITREP.
 *
 * On malformed JSON, retries once. On all failures, falls back to a
 * default priority-5 SITREP rather than blocking the agent loop.
 */
export async function runTriage(
  input: TriageInput,
  callModel: ModelCallFn,
  options?: TriageOptions,
): Promise<{ sitrep: SITREP; fromFallback: boolean; lastError?: string }> {
  const maxRetries = options?.maxRetries ?? 1;
  const prompt = buildTriagePrompt(input);
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const raw = await callModel(prompt);
      const sitrep = parseSITREP(raw);
      return { sitrep, fromFallback: false };
    } catch (err) {
      lastError = err;
    }
  }

  // All attempts failed — return safe fallback
  return {
    sitrep: createDefaultSITREP(input.observation),
    fromFallback: true,
    lastError: lastError ? errorMessage(lastError) : undefined,
  };
}

/**
 * Determine whether the full OODA chain should fire based on
 * the SITREP priority and the configured thresholds.
 */
export function shouldRunFullOODA(
  sitrep: SITREP,
  priorities: PrioritiesFile,
  thinkingLevel: "low" | "medium" | "high",
): boolean {
  const minPriority = priorities.thresholds.min_priority_for_full_ooda;
  const minThinking = priorities.thresholds.min_thinking_level_for_full_ooda;

  const thinkingRank = { low: 0, medium: 1, high: 2 };
  if (thinkingRank[thinkingLevel] < thinkingRank[minThinking]) {
    return false;
  }

  return sitrep.priority >= minPriority;
}

// ============================================================================
// Trajectory-Aware Scaling
// ============================================================================

const DEFAULT_TRAJECTORY_CONFIG: TrajectoryScalingConfig = {
  enabled: true,
  pos_pos_scale: 0.9,
  pos_neg_scale: 0.7,
  neg_pos_scale: 0.8,
  neg_neg_scale: 1.3,
  trajectory_window_days: 30,
  min_outcomes_for_trajectory: 3,
};

/**
 * Compute domain trajectory scores from outcome-labeled episodic events.
 * Returns a map of domain → trajectory score in [-1.0, 1.0].
 * Positive = succeeding trend, negative = failing trend.
 */
export function computeDomainTrajectories(
  events: Array<{ outcome?: string; text: string; createdAt: number }>,
  windowDays: number,
  minOutcomes: number,
  inferDomainFn: (text: string) => string,
): Record<string, number> {
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const withOutcome = events.filter((e) => e.outcome && e.createdAt >= cutoff);

  const byDomain = new Map<string, { successes: number; failures: number; total: number }>();

  for (const e of withOutcome) {
    const domain = inferDomainFn(e.text);
    const stats = byDomain.get(domain) ?? { successes: 0, failures: 0, total: 0 };
    if (e.outcome === "success") stats.successes++;
    else if (e.outcome === "failure") stats.failures++;
    stats.total++;
    byDomain.set(domain, stats);
  }

  const trajectories: Record<string, number> = {};
  for (const [domain, stats] of byDomain) {
    if (stats.total >= minOutcomes) {
      trajectories[domain] = (stats.successes - stats.failures) / stats.total;
    }
  }
  return trajectories;
}

/**
 * Apply trajectory-based scaling to a SITREP's priority.
 * Adjusts the priority up or down based on the asymmetric scaling matrix
 * (inspired by AOD-CFR's sign-dependent instantaneous regret scaling).
 *
 * Pure function — does not mutate the input SITREP.
 */
export function applyTrajectoryScaling(
  sitrep: SITREP,
  trajectories: Record<string, number>,
  config?: Partial<TrajectoryScalingConfig>,
): SITREP {
  const cfg = { ...DEFAULT_TRAJECTORY_CONFIG, ...config };
  if (!cfg.enabled) return sitrep;

  // Determine average trajectory across recommended domains
  const domainTrajectories = sitrep.recommendedDomains
    .map((d) => trajectories[d])
    .filter((t): t is number => t !== undefined);

  if (domainTrajectories.length === 0) return sitrep;

  const avgTrajectory = domainTrajectories.reduce((a, b) => a + b, 0) / domainTrajectories.length;
  const cumulativePositive = avgTrajectory > 0;

  // Current signal polarity: priority <= 4 = positive, >= 6 = negative, 5 = neutral
  if (sitrep.priority === 5) return sitrep;
  const signalNegative = sitrep.priority >= 6;

  // Select scaling factor from the asymmetric matrix
  let scale: number;
  if (cumulativePositive && !signalNegative) scale = cfg.pos_pos_scale;
  else if (cumulativePositive && signalNegative) scale = cfg.pos_neg_scale;
  else if (!cumulativePositive && !signalNegative) scale = cfg.neg_pos_scale;
  else scale = cfg.neg_neg_scale;

  const rawPriority = sitrep.priority;
  const scaled = Math.round(rawPriority * scale);
  const clamped = Math.max(1, Math.min(10, scaled)) as SITREP["priority"];

  // V2 contract: always set rawPriority so the audit log has both values
  // per-row, regardless of whether scaling changed the priority.
  return { ...sitrep, priority: clamped, rawPriority };
}

// ============================================================================
// CR_OODA_TRAJECTORY_AWARE_TRIAGE_V2 — mode resolution + audit log
// ============================================================================

/**
 * Resolve the effective trajectory-scaling mode from config, handling the
 * deprecated `enabled: boolean` field. Used during migration.
 */
export function resolveTrajectoryMode(
  config?: Partial<TrajectoryScalingConfig>,
): TrajectoryScalingMode {
  if (!config) return "shadow";
  if (config.mode) return config.mode;
  if (config.enabled === true) return "live";
  if (config.enabled === false) return "off";
  return "shadow";
}

/**
 * Classify the scaling quadrant for a SITREP given domain trajectories.
 * Mirrors the matrix in applyTrajectoryScaling for audit logging.
 */
export function classifyQuadrant(
  rawPriority: number,
  avgTrajectory: number,
): "pos_pos" | "pos_neg" | "neg_pos" | "neg_neg" | "neutral" {
  if (rawPriority === 5) return "neutral";
  const cumulativePositive = avgTrajectory > 0;
  const signalNegative = rawPriority >= 6;
  if (cumulativePositive && !signalNegative) return "pos_pos";
  if (cumulativePositive && signalNegative) return "pos_neg";
  if (!cumulativePositive && !signalNegative) return "neg_pos";
  return "neg_neg";
}
