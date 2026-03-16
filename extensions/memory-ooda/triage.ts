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
import type { KnowledgeFile, PrioritiesFile, SITREP } from "./types.js";

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
  "recommendedDomains": [<domain names from the active domains list — empty array if none>]
}

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
