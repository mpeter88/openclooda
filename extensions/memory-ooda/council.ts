/**
 * OODA Council — System 1 / System 2 Strategy Deliberation
 *
 * System 1 (Devil's Advocate): fast, always-on adversarial check on strategy winner.
 * System 2 (Full Council): deliberative multi-member council for high-priority decisions.
 */

import { errorMessage, stripCodeFences } from "./parse-utils.js";
import {
  buildChairPrompt,
  buildDevilsAdvocatePrompt,
  runStrategy,
  type StrategyInput,
} from "./strategy.js";
import type { ModelCallFn } from "./triage.js";
import type { CouncilTrace, Strategy } from "./types.js";

// ============================================================================
// Types
// ============================================================================

export type CouncilMode = "system1" | "system2" | "none";

export interface CouncilMember {
  role: "analyst" | "strategist" | "skeptic" | "devils_advocate";
  prompt: string;
  output?: string;
}

export interface CouncilResult {
  mode: CouncilMode;
  members: CouncilMember[];
  chairReasoning: string;
  winner: Strategy;
  dissent: boolean;
  council_trace: Record<string, string>;
}

// ============================================================================
// System 2 Member Prompts
// ============================================================================

function buildAnalystPrompt(input: StrategyInput): string {
  return `You are the Analyst on a strategy council for an AI agent. Your role is factual analysis only — no action bias.

## SITREP
Priority: ${input.sitrep.priority}/10
Summary: ${input.sitrep.summary}
Conflicts: ${input.sitrep.conflictsDetected.join("; ") || "none"}
Relevant facts: ${input.sitrep.relevantFacts.join(", ") || "none"}

## Observation
${input.observation.slice(0, 500)}

## Task
What is actually happening here? Provide a factual 2-3 sentence analysis of the situation, the stakes, and key constraints. No recommendations — just the facts.

Respond with raw text only.`;
}

function buildStrategistPrompt(input: StrategyInput): string {
  const archetypes = input.priorities.strategy_labels
    .map((s) => `- ${s.label}: ${s.description}`)
    .join("\n");

  return `You are the Strategist on a strategy council for an AI agent. Your role is to propose action options with explicit tradeoffs.

## SITREP
Priority: ${input.sitrep.priority}/10
Summary: ${input.sitrep.summary}

## Observation
${input.observation.slice(0, 500)}

## Available Archetypes
${archetypes}

## Task
Propose 2-3 action options using the archetypes above. For each, state the key tradeoff in one sentence. Indicate which you recommend most strongly and why.

Respond with raw text only.`;
}

function buildSkepticPrompt(input: StrategyInput): string {
  return `You are the Skeptic on a strategy council for an AI agent. Your role is to identify the weakest assumption.

## SITREP
Priority: ${input.sitrep.priority}/10
Summary: ${input.sitrep.summary}

## Observation
${input.observation.slice(0, 500)}

## Task
What assumption in any proposed response to this situation is most likely wrong? What blind spot should the team watch for? Be specific in 2-3 sentences.

Respond with raw text only.`;
}

// ============================================================================
// Council Runner
// ============================================================================

/**
 * Run the OODA council in the selected mode.
 *
 * - "none": delegates to existing runStrategy(), wraps result
 * - "system1": strategy + devil's advocate in parallel, amends winner reasoning
 * - "system2": 3 members in parallel, then chair call, returns full trace
 *
 * On any failure, degrades gracefully to runStrategy() fallback.
 */
export async function runCouncil(
  input: StrategyInput,
  mode: CouncilMode,
  callModel: ModelCallFn,
): Promise<CouncilResult> {
  // ── "none" mode: pass-through ──────────────────────────────────────────
  if (mode === "none") {
    const result = await runStrategy(input, callModel);
    return {
      mode: "none",
      members: [],
      chairReasoning: "",
      winner: result.winner,
      dissent: false,
      council_trace: {},
    };
  }

  // ── "system1" mode: strategy + devil's advocate in parallel ────────────
  if (mode === "system1") {
    try {
      const strategyPromise = runStrategy(input, callModel);
      // We need the winner first for DA, but we can start strategy immediately
      const strategyResult = await strategyPromise;
      const winner = strategyResult.winner;

      const daPrompt = buildDevilsAdvocatePrompt(winner, input.sitrep);
      const daMember: CouncilMember = {
        role: "devils_advocate",
        prompt: daPrompt,
      };

      let daOutput: string;
      try {
        daOutput = await callModel(daPrompt);
        daMember.output = daOutput;
      } catch {
        // DA failed — return strategy result unchanged
        return {
          mode: "system1",
          members: [daMember],
          chairReasoning: "Devil's advocate call failed; proceeding with original strategy.",
          winner,
          dissent: false,
          council_trace: {},
        };
      }

      // Amend winner reasoning with DA rebuttal
      const amendedWinner: Strategy = {
        ...winner,
        reasoning: `${winner.reasoning} [DA objection: ${daOutput.trim()}]`,
      };

      return {
        mode: "system1",
        members: [daMember],
        chairReasoning: "",
        winner: amendedWinner,
        dissent: false,
        council_trace: {
          devils_advocate: daOutput.trim(),
        },
      };
    } catch {
      // Full fallback
      const fallback = await runStrategy(input, callModel);
      return {
        mode: "system1",
        members: [],
        chairReasoning: "System 1 council failed; fell back to standard strategy.",
        winner: fallback.winner,
        dissent: false,
        council_trace: {},
      };
    }
  }

  // ── "system2" mode: full council ───────────────────────────────────────
  try {
    const analystPrompt = buildAnalystPrompt(input);
    const strategistPrompt = buildStrategistPrompt(input);
    const skepticPrompt = buildSkepticPrompt(input);

    const members: CouncilMember[] = [
      { role: "analyst", prompt: analystPrompt },
      { role: "strategist", prompt: strategistPrompt },
      { role: "skeptic", prompt: skepticPrompt },
    ];

    // Run all 3 members in parallel
    const [analystResult, strategistResult, skepticResult] = await Promise.allSettled([
      callModel(analystPrompt),
      callModel(strategistPrompt),
      callModel(skepticPrompt),
    ]);

    // Extract outputs, fail gracefully if any member fails
    const analystOutput =
      analystResult.status === "fulfilled" ? analystResult.value : "[analyst failed]";
    const strategistOutput =
      strategistResult.status === "fulfilled" ? strategistResult.value : "[strategist failed]";
    const skepticOutput =
      skepticResult.status === "fulfilled" ? skepticResult.value : "[skeptic failed]";

    members[0].output = analystOutput;
    members[1].output = strategistOutput;
    members[2].output = skepticOutput;

    // If all members failed, fall back
    if (
      analystResult.status === "rejected" &&
      strategistResult.status === "rejected" &&
      skepticResult.status === "rejected"
    ) {
      const fallback = await runStrategy(input, callModel);
      return {
        mode: "system2",
        members,
        chairReasoning: "All council members failed; fell back to standard strategy.",
        winner: fallback.winner,
        dissent: false,
        council_trace: {},
      };
    }

    // Chair call — sequential after members
    const chairPrompt = buildChairPrompt(
      [
        { role: "Analyst", output: analystOutput },
        { role: "Strategist", output: strategistOutput },
        { role: "Skeptic", output: skepticOutput },
      ],
      input.sitrep,
      input.priorities,
    );

    let chairRaw: string;
    try {
      chairRaw = await callModel(chairPrompt);
    } catch {
      // Chair failed — fall back to standard strategy
      const fallback = await runStrategy(input, callModel);
      return {
        mode: "system2",
        members,
        chairReasoning: "Chair call failed; fell back to standard strategy.",
        winner: fallback.winner,
        dissent: false,
        council_trace: {
          analyst: analystOutput,
          strategist: strategistOutput,
          skeptic: skepticOutput,
        },
      };
    }

    // Parse chair response
    const chairParsed = parseChairResponse(chairRaw);

    const councilTrace: CouncilTrace = {
      mode: "system2",
      members: [
        { role: "analyst", output: analystOutput },
        { role: "strategist", output: strategistOutput },
        { role: "skeptic", output: skepticOutput },
      ],
      chairReasoning: chairParsed.chairReasoning,
      dissent: chairParsed.dissent,
    };

    const winner: Strategy = {
      label: chairParsed.label,
      reasoning: chairParsed.reasoning,
      alignmentScore: chairParsed.alignmentScore,
      efficiencyScore: chairParsed.efficiencyScore,
      riskScore: chairParsed.riskScore,
      weightedTotal: 0, // Will be overwritten below
      councilTrace,
    };

    // Compute weighted total using priorities rubric
    const rubric = input.priorities.scoring_rubric;
    winner.weightedTotal =
      winner.alignmentScore * rubric.alignment.weight +
      winner.efficiencyScore * rubric.efficiency.weight +
      winner.riskScore * rubric.risk.weight;

    return {
      mode: "system2",
      members,
      chairReasoning: chairParsed.chairReasoning,
      winner,
      dissent: chairParsed.dissent,
      council_trace: {
        analyst: analystOutput,
        strategist: strategistOutput,
        skeptic: skepticOutput,
        chair: chairParsed.chairReasoning,
      },
    };
  } catch (err) {
    // Full fallback
    const fallback = await runStrategy(input, callModel);
    return {
      mode: "system2",
      members: [],
      chairReasoning: `System 2 council failed (${errorMessage(err)}); fell back to standard strategy.`,
      winner: fallback.winner,
      dissent: false,
      council_trace: {},
    };
  }
}

// ============================================================================
// Chair Response Parsing
// ============================================================================

interface ChairParsed {
  label: string;
  reasoning: string;
  alignmentScore: number;
  efficiencyScore: number;
  riskScore: number;
  dissent: boolean;
  chairReasoning: string;
}

function parseChairResponse(raw: string): ChairParsed {
  const cleaned = stripCodeFences(raw);
  const parsed = JSON.parse(cleaned);

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Chair response must be a JSON object");
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.label !== "string" || obj.label.length === 0) {
    throw new Error("Chair response must have a non-empty label");
  }
  if (typeof obj.reasoning !== "string" || obj.reasoning.length === 0) {
    throw new Error("Chair response must have non-empty reasoning");
  }

  const clamp = (v: unknown): number => {
    const n = typeof v === "number" ? v : 0.5;
    return Math.max(0, Math.min(1, n));
  };

  return {
    label: obj.label,
    reasoning: obj.reasoning,
    alignmentScore: clamp(obj.alignmentScore),
    efficiencyScore: clamp(obj.efficiencyScore),
    riskScore: clamp(obj.riskScore),
    dissent: obj.dissent === true,
    chairReasoning:
      typeof obj.chairReasoning === "string" ? obj.chairReasoning : String(obj.reasoning),
  };
}
