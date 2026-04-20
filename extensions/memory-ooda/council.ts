/**
 * OODA Council — System 1 / System 2 Strategy Deliberation
 *
 * System 1 (Devil's Advocate): fast, always-on adversarial check on strategy winner.
 * System 2 (Full Council): deliberative multi-member council for high-priority decisions.
 */

import { runAdaptiveChair, type ChairSampleFn } from "./adaptive-chair.js";
import {
  buildChairPreReadPrompt,
  computeDisagreement,
  parseChairPrior,
  runJury,
} from "./council-discipline.js";
import { errorMessage, stripCodeFences } from "./parse-utils.js";
import {
  buildChairPrompt,
  buildDevilsAdvocatePrompt,
  runStrategy,
  type StrategyInput,
} from "./strategy.js";
import type { ModelCallFn } from "./triage.js";
import type { ChairPrior, CouncilTrace, JuryResult, Strategy } from "./types.js";

// ============================================================================
// Types
// ============================================================================

export type CouncilMode = "system1" | "system2" | "none";

export interface CouncilMember {
  role: "analyst" | "strategist" | "skeptic" | "devils_advocate" | "discriminator";
  prompt: string;
  output?: string;
}

/**
 * CR_OODA_PATTERN_SEPARATION_GATE: Discriminator member prompt.
 *
 * Fires when retrieval produces at least one `exact_duplicate` candidate. One
 * question only: what is different between the current situation and the
 * near-match? Forces an explicit separation call so the rest of the council
 * doesn't gap-fill by echoing the prior answer.
 */
export function buildDiscriminatorPrompt(
  observation: string,
  nearMatchSummaries: string[],
): string {
  const matches =
    nearMatchSummaries.length > 0
      ? nearMatchSummaries.map((m, i) => `(${i + 1}) ${m}`).join("\n")
      : "(no summaries available — infer from context)";
  return `You are the Discriminator — a council member whose sole job is pattern separation.

The retrieval layer flagged at least one near-identical past memory for this observation. The rest of the council is about to reason — your job is to make them do real work, not echo the prior.

## Current observation
${observation.slice(0, 600)}

## Near-identical prior(s)
${matches}

## Task
Answer in 1-3 sentences:
  - If nothing is materially different between the current situation and the near-match, say "No material difference" and stop.
  - Otherwise, name the specific difference(s). Be concrete — timestamp, constraint, actor, side effect, whatever it is.

Respond with raw text only.`;
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

    const archetypes = input.priorities.strategy_labels.map((s) => s.label);

    // CR_OODA_PATTERN_SEPARATION_GATE: Discriminator fires when the retrieval
    // layer flagged exact-duplicate near-matches. Runs in parallel with the
    // other members; its output is attached to the chair's context so the
    // verdict can cite "what's different."
    let discriminatorOutput: string | undefined;
    const separationMatches = input.separationMatches ?? [];
    if (separationMatches.length > 0) {
      const discriminatorPrompt = buildDiscriminatorPrompt(input.observation, separationMatches);
      members.push({ role: "discriminator", prompt: discriminatorPrompt });
      try {
        discriminatorOutput = await callModel(discriminatorPrompt);
        members[members.length - 1].output = discriminatorOutput;
      } catch {
        discriminatorOutput = "[discriminator failed]";
        members[members.length - 1].output = discriminatorOutput;
      }
    }

    // CR_OODA_COUNCIL_ADVERSARIAL_DISCIPLINE: chair pre-read anchor.
    // Chair commits to an initial lean based ONLY on the SITREP, before seeing
    // member outputs. Used later to flag post-read reversals and anchor fallbacks.
    let chairPrior: ChairPrior | undefined;
    if (input.priorities.thresholds.council_chair_anchoring_enabled) {
      try {
        const preReadPrompt = buildChairPreReadPrompt(input.sitrep, archetypes);
        const preReadRaw = await callModel(preReadPrompt);
        chairPrior = parseChairPrior(preReadRaw);
      } catch {
        // Pre-read is best-effort — absence is tolerated downstream.
      }
    }

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

    // CR_OODA_COUNCIL_ADVERSARIAL_DISCIPLINE: disagreement score + flip detection.
    const disagreement = computeDisagreement(
      [
        { role: "analyst", output: analystOutput },
        { role: "strategist", output: strategistOutput },
        { role: "skeptic", output: skepticOutput },
      ],
      archetypes,
    );
    const minDisagreement = input.priorities.thresholds.council_min_disagreement ?? 0.15;
    const lowDisagreement = disagreement.score < minDisagreement;
    const flipped = chairPrior !== undefined && chairPrior.preReadWinner !== chairParsed.label;

    // CR_OODA_COUNCIL_ADVERSARIAL_DISCIPLINE: optional jury on high-priority + high-disagreement decisions.
    let juryResult: JuryResult | undefined;
    const juryPriorityFloor = input.priorities.thresholds.council_jury_priority_floor ?? 9;
    const juryDisagreementFloor =
      input.priorities.thresholds.council_jury_disagreement_floor ?? 0.6;
    if (
      input.priorities.thresholds.council_jury_enabled &&
      input.sitrep.priority >= juryPriorityFloor &&
      disagreement.score >= juryDisagreementFloor
    ) {
      try {
        juryResult = await runJury(
          { label: chairParsed.label, reasoning: chairParsed.reasoning },
          {
            analyst: analystOutput,
            strategist: strategistOutput,
            skeptic: skepticOutput,
          },
          input.sitrep,
          callModel,
        );
      } catch {
        // Jury is supplementary — absence does not invalidate the chair verdict.
      }
    }

    // CR_OODA_COUNCIL_KS_STOPPING: optional adaptive-chair stability sampling.
    // Trace-only in this integration; the chair verdict above remains authoritative
    // (scoring requires a fully-parsed chair response, which adaptive sampling
    // does not produce). Stability metrics land on councilTrace.adaptiveChair.
    let adaptiveTrace: CouncilTrace["adaptiveChair"] | undefined;
    const adaptiveFloor = input.priorities.thresholds.council_adaptive_chair_priority_floor ?? 7;
    if (
      input.priorities.thresholds.council_adaptive_chair_enabled &&
      input.sitrep.priority >= adaptiveFloor
    ) {
      try {
        const sampleFn: ChairSampleFn = async (_attempt, _temperature) => {
          const raw = await callModel(chairPrompt);
          const parsed = parseChairResponse(raw);
          return { label: parsed.label, confidence: parsed.alignmentScore, raw };
        };
        const adaptiveConfig = {
          enabled: true,
          minSamples: input.priorities.thresholds.council_adaptive_chair_min_samples ?? 3,
          maxSamples: input.priorities.thresholds.council_adaptive_chair_max_samples ?? 9,
          ksThreshold: input.priorities.thresholds.council_adaptive_chair_ks_threshold ?? 0.15,
          temperatures: [0.0, 0.4, 0.8],
          priorityFloor: adaptiveFloor,
          dailyBudget: input.priorities.thresholds.council_chair_daily_budget ?? 200,
        };
        const adaptive = await runAdaptiveChair(sampleFn, adaptiveConfig);
        adaptiveTrace = {
          enabled: true,
          sampleCount: adaptive.samples.length,
          stabilizedAt: adaptive.stabilizedAt,
          winnerShare: adaptive.winnerShare,
          ksTrajectory: adaptive.ksByRound,
          forcedStop: adaptive.forcedStop,
        };
      } catch {
        // Adaptive chair is diagnostic — absence does not invalidate anything.
      }
    }

    const councilTrace: CouncilTrace = {
      mode: "system2",
      members: [
        { role: "analyst", output: analystOutput },
        { role: "strategist", output: strategistOutput },
        { role: "skeptic", output: skepticOutput },
      ],
      chairReasoning: chairParsed.chairReasoning,
      dissent: chairParsed.dissent,
      prior: chairPrior,
      flipped,
      disagreement,
      low_disagreement: lowDisagreement,
      jury: juryResult,
      adaptiveChair: adaptiveTrace,
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
        ...(discriminatorOutput ? { discriminator: discriminatorOutput } : {}),
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

export interface ChairParsed {
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
