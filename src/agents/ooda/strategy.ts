/**
 * OODA Phase B — Strategy (The Decision Matrix)
 *
 * Generates 2-4 candidate strategies from configured archetypes,
 * scores them via the VALUATION_ENGINE, and selects the winner.
 *
 * Feature-flagged off by default.
 */

import type { PrioritiesFile, SITREP, Strategy } from "../../../extensions/memory-ooda/types.js";
import type { ModelCallFn } from "./triage.js";
import {
  scoreStrategies,
  validateDomainWeights,
  validateRubric,
  type UnscoredStrategy,
} from "./valuation-engine.js";

// ============================================================================
// Types
// ============================================================================

export interface StrategyInput {
  /** SITREP from the triage phase */
  sitrep: SITREP;
  /** Domain weights and scoring config */
  priorities: PrioritiesFile;
  /** Original user observation */
  observation: string;
}

export interface StrategyResult {
  /** All scored candidates, sorted by weightedTotal desc */
  candidates: Strategy[];
  /** The winning strategy (highest score) */
  winner: Strategy;
  /** Whether we fell back to a default strategy */
  fromFallback: boolean;
}

// ============================================================================
// Default Fallback Strategy
// ============================================================================

export function createDefaultStrategy(sitrep: SITREP): Strategy {
  return {
    label: "minimal_viable_action",
    reasoning: `Default strategy for priority-${sitrep.priority} observation: ${sitrep.summary.slice(0, 100)}`,
    alignmentScore: 0.5,
    efficiencyScore: 0.7,
    riskScore: 0.8,
    weightedTotal: 0.0, // will be scored
  };
}

// ============================================================================
// Prompt Construction
// ============================================================================

function formatArchetypes(priorities: PrioritiesFile): string {
  return priorities.strategy_labels.map((s) => `  - ${s.label}: ${s.description}`).join("\n");
}

function formatDomains(priorities: PrioritiesFile): string {
  return Object.entries(priorities.domains)
    .toSorted(([, a], [, b]) => b.weight - a.weight)
    .map(([name, d]) => `  - ${name} (weight=${d.weight}): ${d.description}`)
    .join("\n");
}

export function buildStrategyPrompt(input: StrategyInput): string {
  const archetypes = formatArchetypes(input.priorities);
  const domains = formatDomains(input.priorities);
  const rubric = input.priorities.scoring_rubric;

  return `You are a strategy advisor for an AI agent system.

Given a situation report (SITREP) and domain context, generate 2-4 candidate
strategies and score each on three axes.

## SITREP
Priority: ${input.sitrep.priority}/10
Summary: ${input.sitrep.summary}
Conflicts: ${input.sitrep.conflictsDetected.length > 0 ? input.sitrep.conflictsDetected.join("; ") : "none"}
Relevant facts: ${input.sitrep.relevantFacts.length > 0 ? input.sitrep.relevantFacts.join(", ") : "none"}
Recommended domains: ${input.sitrep.recommendedDomains.length > 0 ? input.sitrep.recommendedDomains.join(", ") : "none"}

## Original Observation
${input.observation}

## Available Strategy Archetypes
${archetypes}

## Active Domains
${domains}

## Scoring Axes
Each strategy must be scored 0.0 to 1.0 on:
- alignment (weight=${rubric.alignment.weight}): ${rubric.alignment.description}
- efficiency (weight=${rubric.efficiency.weight}): ${rubric.efficiency.description}
- risk (weight=${rubric.risk.weight}): ${rubric.risk.description} (higher = safer)

## Instructions
Return ONLY a valid JSON array of 2-4 strategy objects:
[
  {
    "label": "<archetype name>",
    "reasoning": "<one-line rationale for this strategy>",
    "alignmentScore": <0.0-1.0>,
    "efficiencyScore": <0.0-1.0>,
    "riskScore": <0.0-1.0>
  }
]

Pick from the available archetypes. Score honestly — do not inflate all scores.
Return ONLY the JSON array. No markdown fences, no commentary.`;
}

// ============================================================================
// Response Parsing
// ============================================================================

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (match) {
    return (match[1] ?? "").trim();
  }
  return trimmed;
}

export function parseStrategyCandidates(raw: string): UnscoredStrategy[] {
  const cleaned = stripCodeFences(raw);
  const parsed = JSON.parse(cleaned);

  if (!Array.isArray(parsed)) {
    throw new Error("Strategy response must be a JSON array");
  }

  if (parsed.length < 1 || parsed.length > 6) {
    throw new Error(`Expected 2-4 strategies, got ${parsed.length}`);
  }

  return parsed.map((item: unknown, idx: number) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`Strategy[${idx}] must be an object`);
    }

    const obj = item as Record<string, unknown>;

    if (typeof obj.label !== "string" || obj.label.length === 0) {
      throw new Error(`Strategy[${idx}] must have a non-empty label`);
    }
    if (typeof obj.reasoning !== "string" || obj.reasoning.length === 0) {
      throw new Error(`Strategy[${idx}] must have non-empty reasoning`);
    }
    if (typeof obj.alignmentScore !== "number") {
      throw new Error(`Strategy[${idx}].alignmentScore must be a number`);
    }
    if (typeof obj.efficiencyScore !== "number") {
      throw new Error(`Strategy[${idx}].efficiencyScore must be a number`);
    }
    if (typeof obj.riskScore !== "number") {
      throw new Error(`Strategy[${idx}].riskScore must be a number`);
    }

    return {
      label: obj.label,
      reasoning: obj.reasoning,
      alignmentScore: obj.alignmentScore,
      efficiencyScore: obj.efficiencyScore,
      riskScore: obj.riskScore,
    };
  });
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Run the strategy phase: validate priorities, call the model to generate
 * candidate strategies, score them, and select the winner.
 *
 * On failure, falls back to a default minimal_viable_action strategy.
 */
export async function runStrategy(
  input: StrategyInput,
  callModel: ModelCallFn,
  options?: { maxRetries?: number },
): Promise<StrategyResult> {
  const maxRetries = options?.maxRetries ?? 1;
  const rubric = input.priorities.scoring_rubric;

  // Validate rubric and domains upfront
  try {
    validateRubric(rubric);
    validateDomainWeights(input.priorities.domains);
  } catch {
    // Validation failure is fatal — do not retry, use fallback
    const fallback = createDefaultStrategy(input.sitrep);
    const scored = scoreStrategies(
      [
        {
          label: fallback.label,
          reasoning: fallback.reasoning,
          alignmentScore: fallback.alignmentScore,
          efficiencyScore: fallback.efficiencyScore,
          riskScore: fallback.riskScore,
        },
      ],
      rubric,
    );
    return {
      candidates: scored,
      winner: scored[0],
      fromFallback: true,
    };
  }

  const prompt = buildStrategyPrompt(input);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const raw = await callModel(prompt);
      const unscored = parseStrategyCandidates(raw);
      const scored = scoreStrategies(unscored, rubric);

      return {
        candidates: scored,
        winner: scored[0],
        fromFallback: false,
      };
    } catch {
      // Retry on next iteration or fall through to fallback
    }
  }

  // All attempts failed — score the default strategy
  const fallback = createDefaultStrategy(input.sitrep);
  const scored = scoreStrategies(
    [
      {
        label: fallback.label,
        reasoning: fallback.reasoning,
        alignmentScore: fallback.alignmentScore,
        efficiencyScore: fallback.efficiencyScore,
        riskScore: fallback.riskScore,
      },
    ],
    rubric,
  );

  return {
    candidates: scored,
    winner: scored[0],
    fromFallback: true,
  };
}
