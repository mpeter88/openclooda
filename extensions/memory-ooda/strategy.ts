/**
 * OODA Phase B — Strategy (The Decision Matrix)
 *
 * Generates 2-4 candidate strategies from configured archetypes,
 * scores them via the VALUATION_ENGINE, and selects the winner.
 *
 * Feature-flagged off by default.
 */

import { errorMessage, stripCodeFences } from "./parse-utils.js";
import type { ModelCallFn } from "./triage.js";
import type { PrioritiesFile, SITREP, Strategy } from "./types.js";
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
  /** Hard constraints forwarded from user preferences (never_do) */
  neverDo?: string[];
}

export interface StrategyResult {
  /** All scored candidates, sorted by weightedTotal desc */
  candidates: Strategy[];
  /** The winning strategy (highest score) */
  winner: Strategy;
  /** Whether we fell back to a default strategy */
  fromFallback: boolean;
  /** Last error from model call attempts, if any. */
  lastError?: string;
  /** Domain inferred from SITREP recommendedDomains (for outcome correlation). */
  domain?: string;
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
    weightedTotal: 0.0,
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
  const neverDo = input.neverDo ?? [];

  return `You are a strategy advisor for an AI agent acting on behalf of the user.

Given a SITREP and domain context, generate 2-4 candidate strategies using different archetypes, then score each on three axes.

## SITREP
Priority: ${input.sitrep.priority}/10
Summary: ${input.sitrep.summary}
Conflicts: ${input.sitrep.conflictsDetected.length > 0 ? input.sitrep.conflictsDetected.join("; ") : "none"}
Relevant facts: ${input.sitrep.relevantFacts.length > 0 ? input.sitrep.relevantFacts.join(", ") : "none"}
Recommended domains: ${input.sitrep.recommendedDomains.length > 0 ? input.sitrep.recommendedDomains.join(", ") : "none"}

## Original Observation
${input.observation.slice(0, 500)}

## Available Strategy Archetypes
${archetypes}

## Active Domains
${domains}
${neverDo.length > 0 ? `\n## Hard Constraints\nThe user has forbidden: ${neverDo.join("; ")}. Any strategy violating these must score 0.0 on alignment.` : ""}

## Scoring Axes
Each strategy must be scored 0.0 to 1.0 on:
- alignment (weight=${rubric.alignment.weight}): ${rubric.alignment.description}
- efficiency (weight=${rubric.efficiency.weight}): ${rubric.efficiency.description}
- risk (weight=${rubric.risk.weight}): ${rubric.risk.description} (1.0 = safest, 0.0 = most dangerous)

## Scoring Calibration
- 0.0-0.2: Poor fit on this axis
- 0.3-0.5: Acceptable but with clear tradeoffs
- 0.6-0.8: Good fit
- 0.9-1.0: Excellent fit, reserved for strong matches

Ensure at least one axis per strategy scores below 0.5 to reflect real tradeoffs. Each strategy must use a different archetype label.

## Example
SITREP: priority=7, summary="User requests a code refactor"
Output:
[{"label":"aggressive_fix","reasoning":"High priority refactor aligns with active project goals","alignmentScore":0.9,"efficiencyScore":0.4,"riskScore":0.6},{"label":"minimal_viable_action","reasoning":"Extract interface first to reduce blast radius","alignmentScore":0.6,"efficiencyScore":0.9,"riskScore":0.9}]

## Output Format
First consider which archetypes best fit this situation, then score each honestly.

Respond with raw JSON only. Do not wrap in code fences or add any text outside the JSON.

[
  {
    "label": "<archetype name from the list above>",
    "reasoning": "<one sentence: why this archetype fits>",
    "alignmentScore": <0.0-1.0>,
    "efficiencyScore": <0.0-1.0>,
    "riskScore": <0.0-1.0>
  }
]`;
}

// ============================================================================
// Council Prompt Builders
// ============================================================================

export function buildDevilsAdvocatePrompt(winner: Strategy, sitrep: SITREP): string {
  return `You are a Devil's Advocate reviewing a proposed strategy for an AI agent.

## Context
SITREP priority: ${sitrep.priority}/10
SITREP summary: ${sitrep.summary}

## Proposed Winning Strategy
Label: ${winner.label}
Reasoning: ${winner.reasoning}
Scores: alignment=${winner.alignmentScore}, efficiency=${winner.efficiencyScore}, risk=${winner.riskScore}, weighted=${winner.weightedTotal}

## Task
Generate the single strongest 1-2 sentence objection to this strategy. Focus on what could go wrong, what assumption is most fragile, or what the strategy overlooks. Be specific to THIS strategy, not generic.

Respond with raw text only — no JSON, no formatting.`;
}

export function buildChairPrompt(
  members: Array<{ role: string; output: string }>,
  sitrep: SITREP,
  priorities: PrioritiesFile,
): string {
  const memberBlock = members.map((m) => `### ${m.role}\n${m.output}`).join("\n\n");

  return `You are the Chair of a strategy council for an AI agent. Three council members have analyzed a situation. Synthesize their perspectives and select the best strategy.

## SITREP
Priority: ${sitrep.priority}/10
Summary: ${sitrep.summary}

## Council Member Outputs
${memberBlock}

## Available Strategy Archetypes
${priorities.strategy_labels.map((s) => `- ${s.label}: ${s.description}`).join("\n")}

## Task
1. Consider all three perspectives
2. Select the best strategy (use one of the archetype labels above)
3. If you disagree with the Strategist's top recommendation, set dissent to true

Respond with raw JSON only:
{
  "label": "<archetype label>",
  "reasoning": "<your synthesis reasoning, 1-2 sentences>",
  "alignmentScore": <0.0-1.0>,
  "efficiencyScore": <0.0-1.0>,
  "riskScore": <0.0-1.0>,
  "dissent": <true|false>,
  "chairReasoning": "<why you chose this strategy over alternatives, 1-2 sentences>"
}`;
}

// ============================================================================
// Response Parsing
// ============================================================================

export function parseStrategyCandidates(raw: string): UnscoredStrategy[] {
  const cleaned = stripCodeFences(raw);
  const parsed = JSON.parse(cleaned);

  if (!Array.isArray(parsed)) {
    throw new Error("Strategy response must be a JSON array");
  }

  if (parsed.length < 2 || parsed.length > 4) {
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
    if (
      typeof obj.alignmentScore !== "number" ||
      obj.alignmentScore < 0 ||
      obj.alignmentScore > 1
    ) {
      throw new Error(`Strategy[${idx}].alignmentScore must be a number in [0, 1]`);
    }
    if (
      typeof obj.efficiencyScore !== "number" ||
      obj.efficiencyScore < 0 ||
      obj.efficiencyScore > 1
    ) {
      throw new Error(`Strategy[${idx}].efficiencyScore must be a number in [0, 1]`);
    }
    if (typeof obj.riskScore !== "number" || obj.riskScore < 0 || obj.riskScore > 1) {
      throw new Error(`Strategy[${idx}].riskScore must be a number in [0, 1]`);
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
  // Tag domain from SITREP for downstream outcome correlation (V1)
  const domain = input.sitrep.recommendedDomains[0];

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
      domain,
    };
  }

  const prompt = buildStrategyPrompt(input);
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const raw = await callModel(prompt);
      const unscored = parseStrategyCandidates(raw);
      const scored = scoreStrategies(unscored, rubric);

      return {
        candidates: scored,
        winner: scored[0],
        fromFallback: false,
        domain,
      };
    } catch (err) {
      lastError = err;
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
    domain,
    lastError: lastError ? errorMessage(lastError) : undefined,
  };
}
