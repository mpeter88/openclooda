/**
 * CR_OODA_ERROR_TAXONOMY — five-axis failure classifier.
 *
 * Source: Where LLM Agents Fail and How They Can Learn From Failures,
 * Zhu et al. 2025 (arxiv 2509.25370).
 *
 * Classifies a failing episodic event into one or more of:
 *   memory / reflection / planning / action / system
 */

import type { EpisodicEvent } from "./archivist.js";
import { priorityCountWeight } from "./emotional-tagging.js";
import { stripCodeFences } from "./parse-utils.js";
import type { ModelCallFn } from "./triage.js";
import type {
  ActualOutcome,
  BeliefsFile,
  ErrorAxis,
  ErrorAxisPriorStats,
  ErrorTag,
  ExpectedOutcome,
  KnowledgeFile,
  SITREP,
  Strategy,
} from "./types.js";

export interface ErrorClassifyContext {
  sitrep?: SITREP;
  strategy?: Strategy;
  expectedOutcome?: ExpectedOutcome;
  actualOutcome?: ActualOutcome;
  factsSnapshot?: KnowledgeFile;
  beliefsSnapshot?: BeliefsFile;
  toolTrace?: Array<{ tool: string; args: unknown; result: unknown; error?: string }>;
}

const VALID_AXES = new Set<ErrorAxis>(["memory", "reflection", "planning", "action", "system"]);
const VALID_SEVERITY = new Set(["minor", "major", "critical"]);

export function buildErrorClassifierPrompt(
  event: EpisodicEvent,
  context: ErrorClassifyContext,
): string {
  const sitrep = context.sitrep
    ? `priority=${context.sitrep.priority}, summary="${context.sitrep.summary}"`
    : "none";
  const strategy = context.strategy ? `label=${context.strategy.label}` : "none";
  const expected = context.expectedOutcome
    ? `${context.expectedOutcome.description} (success=${context.expectedOutcome.successSignal})`
    : "none";
  const actual = context.actualOutcome ? JSON.stringify(context.actualOutcome) : "none";
  const toolTrace = context.toolTrace
    ? context.toolTrace.map((t) => `- ${t.tool}${t.error ? ` (error: ${t.error})` : ""}`).join("\n")
    : "none";

  return `You are classifying a failed agent action into the five-axis AgentErrorTaxonomy.

Axes:
- memory:     wrong/missing recall, stale context used, write lost
- reflection: wrong self-assessment, failure misdiagnosed, hallucinated outcome
- planning:   chose the wrong strategy, missed an option, scored incorrectly
- action:     tool call failed, argument wrong, side-effect unintended
- system:     rate limit, timeout, disk full, gateway down

Context:
  SITREP: ${sitrep}
  Strategy: ${strategy}
  ExpectedOutcome: ${expected}
  ActualOutcome: ${actual}
  Event text: ${event.text.slice(0, 400)}
  Tool trace:
${toolTrace}

Output one or more ErrorTags as a JSON array. Rules:
- Each tag targets a DISTINCT axis. Do not duplicate axis.
- severity: "minor" | "major" | "critical" — critical only blocks downstream work.
- confidence: 0.0–1.0 — if < 0.5, classify conservatively.
- signal: short free-text — specifically what went wrong.

Respond with raw JSON only, no fences:
[
  { "axis": "<one of: memory|reflection|planning|action|system>",
    "severity": "<minor|major|critical>",
    "signal": "<short text>",
    "confidence": <number> }
]`;
}

export function parseErrorTags(raw: string): ErrorTag[] {
  const cleaned = stripCodeFences(raw);
  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) {
    throw new Error("ErrorTags response must be a JSON array");
  }
  const tags: ErrorTag[] = [];
  const seenAxes = new Set<ErrorAxis>();
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`ErrorTag[${i}] must be an object`);
    }
    const obj = item as Record<string, unknown>;
    if (typeof obj.axis !== "string" || !VALID_AXES.has(obj.axis as ErrorAxis)) {
      throw new Error(`ErrorTag[${i}].axis must be one of ${[...VALID_AXES].join(", ")}`);
    }
    const axis = obj.axis as ErrorAxis;
    if (seenAxes.has(axis)) {
      // Skip duplicates rather than error — accepts minor model drift
      continue;
    }
    seenAxes.add(axis);
    if (typeof obj.severity !== "string" || !VALID_SEVERITY.has(obj.severity)) {
      throw new Error(`ErrorTag[${i}].severity invalid`);
    }
    if (typeof obj.signal !== "string" || obj.signal.length === 0) {
      throw new Error(`ErrorTag[${i}].signal must be non-empty`);
    }
    const confidence = typeof obj.confidence === "number" ? obj.confidence : 0.5;
    tags.push({
      axis,
      severity: obj.severity as ErrorTag["severity"],
      signal: obj.signal,
      confidence: Math.max(0, Math.min(1, confidence)),
      implicated_fact: typeof obj.implicated_fact === "string" ? obj.implicated_fact : undefined,
      implicated_belief:
        typeof obj.implicated_belief === "string" ? obj.implicated_belief : undefined,
    });
  }
  return tags;
}

/**
 * Run the error classifier on a single event. Retries once on malformed JSON.
 * Returns empty array on total failure (non-fatal to the caller).
 */
export async function classifyError(
  event: EpisodicEvent,
  context: ErrorClassifyContext,
  callModel: ModelCallFn,
): Promise<ErrorTag[]> {
  const prompt = buildErrorClassifierPrompt(event, context);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await callModel(prompt);
      return parseErrorTags(raw);
    } catch {
      if (attempt === 1) return [];
    }
  }
  return [];
}

// ============================================================================
// Aggregation
// ============================================================================

/**
 * Aggregate error-tagged episodic events into per-domain axis prior stats.
 * Uses inferDomain from archivist — duplicated here to avoid cyclic deps.
 */
export interface AxisPriorsOptions {
  /**
   * CR_OODA_EMOTIONAL_TAGGING: when true, per-event counts are scaled by the
   * event's SITREP priority at capture. A `planning` failure at P9 contributes
   * more than a `planning` failure at P2. Defaults to false for backward
   * compatibility (existing tests rely on flat counts).
   */
  priorityWeighting?: boolean;
}

export function aggregateAxisPriors(
  events: EpisodicEvent[],
  windowMs: number,
  inferDomain: (text: string) => string,
  options: AxisPriorsOptions = {},
): ErrorAxisPriorStats[] {
  const cutoff = Date.now() - windowMs;
  const useWeighting = options.priorityWeighting === true;
  const byDomainAxis = new Map<
    string,
    { critical: number; major: number; minor: number; total: number; signals: Map<string, number> }
  >();
  let totalInWindow = 0;

  for (const e of events) {
    if (e.createdAt < cutoff) continue;
    if (!e.errorTags || e.errorTags.length === 0) continue;
    const domain = inferDomain(e.text);
    const w = useWeighting ? priorityCountWeight(e.sitrepPriorityAtCapture) : 1;
    totalInWindow++;
    for (const tag of e.errorTags) {
      const key = `${domain}|${tag.axis}`;
      const existing = byDomainAxis.get(key) ?? {
        critical: 0,
        major: 0,
        minor: 0,
        total: 0,
        signals: new Map<string, number>(),
      };
      existing.total += w;
      if (tag.severity === "critical") existing.critical += w;
      else if (tag.severity === "major") existing.major += w;
      else existing.minor += w;
      existing.signals.set(tag.signal, (existing.signals.get(tag.signal) ?? 0) + w);
      byDomainAxis.set(key, existing);
    }
  }

  const out: ErrorAxisPriorStats[] = [];
  // Count total events per domain (denominator for axisRate).
  // When priority weighting is on, the denominator also uses weighted counts
  // so that axisRate stays in [0,1] rather than inflating.
  const domainTotals = new Map<string, number>();
  for (const e of events) {
    if (e.createdAt < cutoff) continue;
    const d = inferDomain(e.text);
    const w = useWeighting ? priorityCountWeight(e.sitrepPriorityAtCapture) : 1;
    domainTotals.set(d, (domainTotals.get(d) ?? 0) + w);
  }

  for (const [key, s] of byDomainAxis) {
    const [domain, axis] = key.split("|") as [string, ErrorAxis];
    const domainTotal = domainTotals.get(domain) ?? 1;
    const topSignals = [...s.signals.entries()]
      .toSorted(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([signal, count]) => ({ signal, count }));
    out.push({
      domain,
      axis,
      countCritical: s.critical,
      countMajor: s.major,
      countMinor: s.minor,
      axisRate: s.total / domainTotal,
      topSignals,
    });
  }
  void totalInWindow;
  return out;
}
