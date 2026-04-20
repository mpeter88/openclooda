# CR: OODA Error Taxonomy — Five-Axis Failure Tags on Episodic Events

**Date:** 2026-04-18
**Status:** WRITTEN
**Priority:** HIGH — failure events currently carry only success/failure/partial; no axis tag means no actionable prior update per failure class
**Source:** Where LLM Agents Fail and How They Can Learn From Failures, Zhu et al. 2025 (arxiv 2509.25370). AgentErrorTaxonomy five-axis scheme borrowed.

---

## Current State

`EpisodicEvent` in `archivist.ts`:

```typescript
export interface EpisodicEvent {
  // ...
  outcome?: "success" | "failure" | "partial";
  outcomeSignal?: string;
  outcomeAt?: number;
}
```

A failure is a boolean. `outcomeSignal` is freeform text. `aggregateDomainOutcomes` counts failures per domain but cannot answer "are we failing at **planning** in `amf_pipeline` or at **action execution**?" — information needed to update the correct prior.

Zhu et al.'s AgentErrorTaxonomy defines five failure axes that cleanly partition what goes wrong in a deployed agent. Adding this as a structured tag turns every failure event into a targeted training signal for the meta-reviewer and trajectory components.

---

## Design

### C1 — Five Axes

```typescript
export type ErrorAxis =
  | "memory" // wrong or missing recall; stale context used; write lost
  | "reflection" // wrong self-assessment; failure misdiagnosed; hallucinated outcome
  | "planning" // chose the wrong strategy; missed an option; scored incorrectly
  | "action" // tool call failed; argument wrong; side-effect unintended
  | "system"; // infrastructure: rate limit, timeout, disk full, gateway down

export interface ErrorTag {
  axis: ErrorAxis;
  severity: "minor" | "major" | "critical";
  signal: string; // short free-text — what specifically went wrong
  /** Classifier confidence [0, 1]. */
  confidence: number;
  /** Optional: link to a KNOWLEDGE fact or belief whose use contributed to the failure. */
  implicated_fact?: string; // "<section>.<key>"
  implicated_belief?: string; // belief id
}
```

### C2 — EpisodicEvent Extension

```typescript
export interface EpisodicEvent {
  // ... existing ...
  outcome?: "success" | "failure" | "partial";
  outcomeSignal?: string;
  outcomeAt?: number;
  /** Populated when outcome is "failure" or "partial". Optional for "success". */
  errorTags?: ErrorTag[];
}
```

Multiple tags per event are allowed — one failure can be both a `planning` miss and an `action` misfire.

### C3 — Classifier

New module `extensions/memory-ooda/error-classifier.ts`:

```typescript
export async function classifyError(
  event: EpisodicEvent,
  context: ErrorClassifyContext,
  callModel: ModelCallFn,
): Promise<ErrorTag[]>;

export interface ErrorClassifyContext {
  sitrep?: SITREP;
  strategy?: Strategy;
  expectedOutcome?: ExpectedOutcome;
  actualOutcome?: ActualOutcome;
  /** Current KNOWLEDGE.json and BELIEFS.json state at the time of failure. */
  factsSnapshot?: KnowledgeFile;
  beliefsSnapshot?: BeliefsFile;
  toolTrace?: Array<{ tool: string; args: unknown; result: unknown; error?: string }>;
}
```

Prompt contract outputs a `ErrorTag[]` JSON array. Rules:

- Exactly one tag per distinct axis contribution (no duplicates of the same axis).
- Severity calibration: `critical` only when the failure blocks downstream work; otherwise `major` for visible wrong outcomes, `minor` for cosmetic or easily-retried.
- `confidence < 0.5` tags are retained but marked `uncertain` — classifier retry once before accepting.

### C4 — Classifier Triggers

- **Every `outcome === "failure"` event on `agent_end`:** queue a classify job. Non-blocking.
- **Every `partial`:** classify opportunistically — partials often reveal a planning/action mismatch.
- **`success` events:** only classified when `rawPriority >= 8` — we want to understand what barely-worked so we can double down.

Classification runs in a background queue (shared with Archivist's async path) with a rolling 10-job limit and a `classifier_errors` telemetry counter.

### C5 — Prior Updates

The meta-reviewer consumes error-tagged events:

```typescript
export interface ErrorAxisPriorStats {
  domain: string;
  axis: ErrorAxis;
  countCritical: number;
  countMajor: number;
  countMinor: number;
  /** Rate of this axis failure within domain over window. */
  axisRate: number;
  /** Most common signal strings for this axis+domain. */
  topSignals: Array<{ signal: string; count: number }>;
}

export function aggregateAxisPriors(
  events: EpisodicEvent[],
  windowMs: number,
): ErrorAxisPriorStats[];
```

When the trajectory-aware triage (CR A2) computes domain trajectory, it now also receives axis priors:

- If `memory` axis rate > 0.3 for a domain, inject a priming note into the triage prompt: "Recent memory failures in this domain — verify recall coverage before acting."
- If `planning` axis rate > 0.3, signal the strategy phase to expand archetype generation from 2–4 to 3–5 candidates.
- If `action` axis rate > 0.3, the executive is instructed to include explicit tool-call pre-checks.
- If `system` axis rate > 0.3, fall back to `strategic_delay` archetype by default.
- If `reflection` axis rate > 0.3, trigger the grounded eval harness's Campbell diagnostic (Batch A1) on a shorter window.

### C6 — Surface in Proposals

`PolicyProposal` gains an optional `axis_evidence` field:

```typescript
export interface PolicyProposal {
  // ...
  axis_evidence?: {
    domain: string;
    axis: ErrorAxis;
    recentCount: number;
    topSignal: string;
  };
}
```

A weight proposal now says "infrastructure domain: planning-axis failures up 40% over 14 days" instead of only "weight delta 0.7 → 0.55." The user sees a reason rooted in a specific failure class.

### C7 — CLI

- `openclaw workspace errors stats [--domain X] [--window 14d]` — table of axis rates per domain.
- `openclaw workspace errors recent --axis planning` — list recent events tagged with a specific axis.
- `openclaw workspace errors classify <actionId>` — manually invoke the classifier on a specific event (dev/debug).

### C8 — Storage

Error tags are stored on the episodic event row itself in LanceDB. Schema migration: add `errorTags` JSON column (string), default `null`. Existing rows read as empty array.

---

## Acceptance Criteria

- [ ] `ErrorAxis` enum and `ErrorTag` type in `types.ts`.
- [ ] `error-classifier.ts` with prompt, parse, retry; tested against 10 hand-labeled fixture events covering all 5 axes.
- [ ] Every new `agent_end` with `outcome !== "success"` produces a classification attempt.
- [ ] `aggregateAxisPriors` unit-tested against synthetic events.
- [ ] Triage + Strategy + Executive prompts receive axis-prior priming when thresholds exceeded (gated by a new `thresholds.axis_prior_inject_floor`, default 0.3).
- [ ] CLI subcommands present.
- [ ] `PolicyProposal.axis_evidence` populated by the meta-reviewer on weight proposals.
- [ ] LanceDB schema migration verified — existing rows readable post-migration.

---

## Risk and Open Questions

1. **Classifier reliability.** A misclassified `memory` as `action` shifts the wrong prior. Retry-once + confidence threshold + 60-day rolling audit of classifier calibration (manual spot check of 20 random classifications monthly; if error > 30%, widen the uncertain-tag threshold).
2. **Multi-axis events.** A failure with three axes contributes one count each to three priors — fine for attribution, but inflates aggregate counts. Document that sum of axis counts > event count by design.
3. **Hot-path cost.** Classifier runs async. Bound the background queue so a burst of failures doesn't starve Archivist. Shared queue with Archivist uses fair scheduling (round-robin).
4. **Overlap with V2 grounded harness.** The distortion index (A1) reads grounded vs approval metrics. A high reflection-axis rate in a domain is a leading indicator of Campbell regime — wire this as a cross-check: `reflection_axis_rate > 0.3 AND grounded/measured divergence > 0.2` = elevated Campbell risk.
5. **Arxiv ID verified.** 2509.25370 confirmed — Zhu et al. 2025. Five axes verbatim from the abstract: memory, reflection, planning, action, system. Paper reports +24% all-correct and +26% task success when AgentDebug closes the loop from failure tags to strategy changes. We're adopting the taxonomy, not the debug algorithm verbatim.
