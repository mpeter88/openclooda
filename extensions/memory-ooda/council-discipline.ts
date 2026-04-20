/**
 * CR_OODA_COUNCIL_ADVERSARIAL_DISCIPLINE — anti-sycophancy helpers for the council.
 *
 * Sources:
 * - D3 (arxiv 2410.04663) — advocates/judge/jury structure.
 * - Talk Isn't Always Cheap (arxiv 2509.05396) — stronger-flips-to-weaker failure mode.
 * - Peacemaker or Troublemaker (arxiv 2509.23055) — chair sycophancy + disagreement collapse.
 *
 * Provides pure utilities for computing disagreement and running jury verdicts.
 * Wiring into runCouncil happens in the integration phase.
 */

import { stripCodeFences } from "./parse-utils.js";
import type { ModelCallFn } from "./triage.js";
import type { ChairPrior, DisagreementReading, JuryResult, SITREP } from "./types.js";

// ============================================================================
// Disagreement detection
// ============================================================================

/**
 * Compute a disagreement score across council member outputs.
 *
 * Heuristic: extract archetype labels mentioned in each member's output
 * (case-insensitive substring match against the configured archetype set),
 * cluster members by their primary label, and derive a normalized entropy-like
 * score in [0, 1]. 0 = all members landed on the same archetype, 1 = maximally
 * divergent (each member on a distinct archetype).
 */
export function computeDisagreement(
  members: Array<{ role: string; output: string }>,
  archetypes: string[],
): DisagreementReading {
  if (members.length === 0 || archetypes.length === 0) {
    return { score: 0, clusters: [], contradictions: [] };
  }

  // Primary-label extraction per member
  const memberLabels = members.map((m) => {
    const lower = m.output.toLowerCase();
    const hits = archetypes.filter((a) => lower.includes(a.toLowerCase()));
    return { role: m.role, primary: hits[0] ?? "unclassified", all: hits };
  });

  // Cluster
  const clusterMap = new Map<string, string[]>();
  for (const { role, primary } of memberLabels) {
    const existing = clusterMap.get(primary) ?? [];
    existing.push(role);
    clusterMap.set(primary, existing);
  }
  const clusters = [...clusterMap.entries()].map(([label, members]) => ({ label, members }));

  // Normalized cluster entropy: 0 when one cluster, 1 when every member distinct.
  const n = members.length;
  const clusterCount = clusters.length;
  // Score is (clusters - 1) / (n - 1), clamped.
  const score = n <= 1 ? 0 : Math.max(0, Math.min(1, (clusterCount - 1) / (n - 1)));

  // Contradictions: pairs of members whose primary labels differ.
  const contradictions: Array<{ a: string; b: string; signal: string }> = [];
  for (let i = 0; i < memberLabels.length; i++) {
    for (let j = i + 1; j < memberLabels.length; j++) {
      const a = memberLabels[i];
      const b = memberLabels[j];
      if (a.primary !== b.primary && a.primary !== "unclassified" && b.primary !== "unclassified") {
        contradictions.push({
          a: a.role,
          b: b.role,
          signal: `${a.primary} vs ${b.primary}`,
        });
      }
    }
  }

  return { score, clusters, contradictions };
}

// ============================================================================
// Chair pre-read anchor
// ============================================================================

export function buildChairPreReadPrompt(sitrep: SITREP, archetypes: string[]): string {
  return `You are the Council Chair, making a preliminary judgment BEFORE reading member deliberations.

## SITREP
Priority: ${sitrep.priority}/10
Summary: ${sitrep.summary}
Recommended domains: ${sitrep.recommendedDomains.join(", ") || "none"}

## Available archetypes
${archetypes.map((a) => `- ${a}`).join("\n")}

## Task
State your initial lean based ONLY on the SITREP. This is your anchor — you will
re-read it after seeing member outputs, and the system will check whether you flipped.

Respond with raw JSON only:
{
  "preReadWinner": "<archetype label>",
  "preReadReasoning": "<1-2 sentences>",
  "preReadConfidence": <0.0-1.0>
}`;
}

export function parseChairPrior(raw: string): ChairPrior {
  const cleaned = stripCodeFences(raw);
  const parsed = JSON.parse(cleaned);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("ChairPrior must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.preReadWinner !== "string" || obj.preReadWinner.length === 0) {
    throw new Error("preReadWinner must be non-empty string");
  }
  if (typeof obj.preReadReasoning !== "string") {
    throw new Error("preReadReasoning must be string");
  }
  const confidence = typeof obj.preReadConfidence === "number" ? obj.preReadConfidence : 0.5;
  return {
    preReadWinner: obj.preReadWinner,
    preReadReasoning: obj.preReadReasoning,
    preReadConfidence: Math.max(0, Math.min(1, confidence)),
  };
}

// ============================================================================
// Jury
// ============================================================================

export interface JuryConfig {
  /** Temperatures for the three jurors. Default: [0.0, 0.3, 0.6]. */
  temperatures?: number[];
}

function buildJurorPrompt(
  chairVerdict: { label: string; reasoning: string },
  memberTrace: Record<string, string>,
  sitrep: SITREP,
): string {
  return `You are Juror — an independent reviewer of a council verdict.

## SITREP
Priority: ${sitrep.priority}/10, summary: ${sitrep.summary}

## Member trace
${Object.entries(memberTrace)
  .map(([role, out]) => `[${role}] ${String(out).slice(0, 400)}`)
  .join("\n")}

## Chair's verdict
Winner: ${chairVerdict.label}
Reasoning: ${chairVerdict.reasoning}

## Task
Vote: affirm the chair's verdict, or overturn it? Provide 1-2 sentences of reasoning.

Respond with raw JSON only:
{ "vote": "affirm" | "overturn", "reasoning": "<1-2 sentences>" }`;
}

export async function runJury(
  chairVerdict: { label: string; reasoning: string },
  memberTrace: Record<string, string>,
  sitrep: SITREP,
  callModel: ModelCallFn,
  config: JuryConfig = {},
): Promise<JuryResult> {
  const temperatures = config.temperatures ?? [0.0, 0.3, 0.6];
  const votes: JuryResult["individualVotes"] = [];

  for (let i = 0; i < temperatures.length; i++) {
    const prompt = buildJurorPrompt(chairVerdict, memberTrace, sitrep);
    try {
      const raw = await callModel(prompt);
      const parsed = JSON.parse(stripCodeFences(raw));
      const vote =
        typeof parsed.vote === "string" && (parsed.vote === "affirm" || parsed.vote === "overturn")
          ? parsed.vote
          : "affirm";
      votes.push({
        juror: `juror_${i}_t${temperatures[i]}`,
        vote,
        reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
      });
    } catch {
      // Parse failure counts as abstain = affirm (safer default)
      votes.push({
        juror: `juror_${i}_t${temperatures[i]}`,
        vote: "affirm",
        reasoning: "(parse failed — defaulted to affirm)",
      });
    }
  }

  const affirmCount = votes.filter((v) => v.vote === "affirm").length;
  const overturnCount = votes.length - affirmCount;
  let verdict: JuryResult["verdict"];
  if (affirmCount === votes.length) verdict = "affirm";
  else if (overturnCount === votes.length) verdict = "overturn";
  else verdict = "split";

  const finalChairReasoning =
    verdict === "overturn"
      ? `Jury overturned: ${votes.map((v) => v.reasoning).join(" | ")}`
      : verdict === "split"
        ? `Jury split — chair verdict stands; dissent noted.`
        : chairVerdict.reasoning;

  return { verdict, individualVotes: votes, finalChairReasoning };
}
