# CR: OODA Beliefs Tier — BELIEFS.json, the Fourth Memory Tier

**Date:** 2026-04-18
**Status:** WRITTEN
**Priority:** MEDIUM — separates "things the agent currently believes are true" from "things that are ground truth," enabling clean reasoning about drift and disagreement
**Sources:**

- Hindsight is 20/20: Building Agent Memory that Retains, Recalls, and Reflects, Latimer et al. 2025 (arxiv 2512.12818). Four-network schema borrowed; beliefs network adopted as a distinct tier.
- Memory for Autonomous LLM Agents (survey), Pengfei Du 2026 (arxiv 2603.07670v1) — Section on reflective self-improvement and policy-learned management motivates separating evolving opinion from stable fact.

---

## Current State

Three tiers exist today:

- **Tier 1 (working):** per-session in-context buffer; reconstructed each turn.
- **Tier 2 (episodic):** LanceDB vector store, outcome-labeled, pruned at 90 days.
- **Tier 3 (semantic):** `KNOWLEDGE.json` — distilled facts treated as stable ground truth.

A recurring failure mode: the Archivist writes a **hypothesis** into Tier 3 where only **observed fact** belongs. Example: a pattern seen in 3 sessions ("Peter prefers delegating infrastructure tasks") gets upserted into `preferences.prefers_delegation_over_diy = true`, becomes stable context, influences every subsequent turn — and may still be wrong. There's no graceful way for the agent to downgrade a stored "truth" to a "current belief, subject to revision" without losing it.

Hindsight 20/20's separation — **world facts** vs **evolving beliefs** — maps onto this. Ground-truth identity, commitments, stack versions live in KNOWLEDGE. Inferred patterns, dispositions, working theories live in BELIEFS.

---

## Design

### C1 — BELIEFS.json Shape

New file at `~/.openclaw/workspace/BELIEFS.json`, managed by a new module `extensions/memory-ooda/beliefs.ts`:

```typescript
export interface BeliefsFile {
  _meta: {
    version: number;
    updated_at: string;
    updated_by: "archivist" | "meta_reviewer" | "user";
    description: string;
  };
  /**
   * Evolving stances held by the agent about the user, projects, or the world.
   * Each belief is a claim with evidence and a confidence score.
   */
  beliefs: Record<string, Belief>;
  _belief_log: Array<{
    timestamp: string;
    action: "formed" | "reinforced" | "weakened" | "retired";
    belief_id: string;
    delta: number; // change in confidence
    reason: string;
  }>;
}

export interface Belief {
  id: string; // stable slug, e.g. "peter_prefers_delegation_on_infra"
  claim: string; // human-readable assertion
  domain: string; // matches PRIORITIES.json domain
  confidence: number; // [0, 1]
  formed_at: string; // ISO — when first written
  updated_at: string; // ISO — last reinforcement or weakening
  evidence: Array<{
    source: "episodic" | "tool_result" | "user_signal";
    ref: string; // event actionId or sitrep id
    weight: number; // contribution to confidence, signed
    at: string;
  }>;
  contradicting_evidence: Array<{
    source: "episodic" | "tool_result" | "user_signal";
    ref: string;
    weight: number;
    at: string;
  }>;
  /** If retired: when and why. */
  retired?: { at: string; reason: string };
  /** Downstream effects — which OODA phases should consider this belief. */
  affects: Array<"triage" | "strategy" | "executive">;
}
```

### C2 — Promotion Semantics

A belief becomes a KNOWLEDGE.json fact (promotion) when:

- `confidence >= 0.85` for `>= 30` days **and**
- no contradicting evidence within the last 30 days **and**
- the user has approved the promotion via a PolicyProposal (category `project` or `policy` depending on the belief's `affects`).

A KNOWLEDGE.json fact becomes a belief (demotion) when:

- Contradicting evidence arrives (tool_result or user_signal) **and**
- The bitemporal envelope (from Batch B1) sets `valid_to = now` **and**
- A new Belief is formed with `claim = former_fact_value`, `confidence = 0.4`, `contradicting_evidence = [the new event]`.

Demotion is the key operation KNOWLEDGE.json alone can't do: "this was our stable assumption; it's been challenged; track it as a belief until we're sure." Without it, contradictory evidence either overwrites silently or gets ignored.

### C3 — Archivist Integration

The Archivist's pattern classifier (Batch B2) gets a fifth target:

```typescript
export type PatternAction = "ADD" | "UPDATE" | "DELETE" | "NOOP" | "BELIEVE"; // new — forms or reinforces a belief rather than claiming fact
```

Prompt rule: "If events suggest a pattern but you are not confident it represents a stable truth, emit BELIEVE with an initial confidence `0.4 – 0.7`. Promote to ADD only when the same pattern has been BELIEVEd with `confidence >= 0.85` in the past."

`applyPatternAction` extends:

- **BELIEVE (new belief):** create a Belief with `confidence = claimed`.
- **BELIEVE (reinforcement):** update existing belief — bump confidence by `min(0.15, claimed - current)`, append evidence row.
- **BELIEVE (weakening):** a BELIEVE with `claimed < current` appends contradicting evidence, decrements confidence toward `claimed`.

### C4 — Injection into System Prompt

Beliefs are injected into the system prompt _after_ facts, in a distinct block:

```
<semantic-memory>...KNOWLEDGE.json...</semantic-memory>
<current-beliefs confidence-floor="0.6">
Top 10 beliefs by confidence × recency:
  [0.82] Peter prefers delegating infra tasks to cloud bridge (updated 2026-04-15)
  [0.71] AMF parity score plateaus without explicit schema review (updated 2026-04-12)
  ...
</current-beliefs>
```

Beliefs below a configurable confidence floor (default `0.6`) are not injected — they remain in BELIEFS.json but aren't context-weight.

`formatBeliefsForContext(beliefs, { floor, limit, affectsPhase })` mirrors `formatFactsForContext`.

### C5 — Meta-Reviewer Hook

When the Meta-Reviewer detects a `criticalFailure`, it cross-references any beliefs whose `affects` includes the failing phase. A belief with `confidence > 0.7` that was in the system prompt at the time of the failure gets weakened by 0.1 and a contradicting_evidence row appended pointing to the failure's `actionId`.

This is the first structural mechanism where **the agent's own beliefs get graded against its failures** rather than against the user's approval signal. Pairs directly with the Grounded Eval Harness V2 distortion diagnostic.

### C6 — CLI

- `openclaw workspace beliefs list [--min-confidence 0.6] [--domain X]`
- `openclaw workspace beliefs show <belief_id>` — full evidence and contradiction trail.
- `openclaw workspace beliefs retire <belief_id> --reason "..."` — manual retirement.
- `openclaw workspace beliefs promote <belief_id>` — triggers the PolicyProposal flow for promoting to KNOWLEDGE.json fact.

### C7 — File Safety

Same pattern as `semantic-memory.ts`: snapshot before write, tmp-file + atomic rename, JSON validation post-serialize. `.snapshots/BELIEFS.json.<ts>.bak` rotation at 5.

### C8 — Interaction with Other CRs

- **Batch A1 (Grounded Eval Harness V2):** beliefs with `affects = ["triage"]` whose confidence drifts while grounded metric in the same domain reverses — that's a strong Campbell-regime signal. Wire into distortion index.
- **Batch A2 (Trajectory-Aware Triage V2):** trajectory scaling's per-domain sign depends on episodic outcomes. Beliefs can supplement: when grounded trajectory is mixed but a strong belief exists, the belief's confidence biases scaling. Out of scope for this CR — flagged for follow-up.
- **Batch B1 (Bitemporal Knowledge):** demotion uses B1's `invalidateFact` directly. B3 is effectively B1's partner — together they make "drift without data loss" a first-class operation.
- **Batch B2 (CRUD Classifier):** extended to five actions (ADD/UPDATE/DELETE/NOOP/BELIEVE).

---

## Acceptance Criteria

- [ ] `BELIEFS.json` created on first Archivist run after this CR lands. Template via `createDefaultBeliefs()`.
- [ ] `beliefs.ts` exports `formBelief`, `reinforceBelief`, `weakenBelief`, `retireBelief`, `getActiveBeliefs`, `formatBeliefsForContext`.
- [ ] Promotion + demotion flows tested end-to-end on a synthetic workspace.
- [ ] `_belief_log` captures all transitions with delta.
- [ ] Meta-Reviewer attaches `contradicting_evidence` on critical failures.
- [ ] System-prompt injection respects the confidence floor and phase affects filter.
- [ ] CLI subcommands present and unit-tested.
- [ ] Snapshot + atomic write invariants match `semantic-memory.ts`.

---

## Risk and Open Questions

1. **Two stores of truth.** KNOWLEDGE.json and BELIEFS.json can encode overlapping claims with different confidence. The injection order is KNOWLEDGE first, then BELIEFS — a claim demoted from K to B **must** also be invalidated in K (via B1's `invalidateFact`), otherwise the system prompt shows both. Enforce: demotion is atomic, snapshots both files.
2. **Prompt bloat.** Beliefs with evidence chains are verbose. Injection formatter drops evidence — only `[confidence] claim (updated ...)` lines enter context. Full trail is a CLI / workspace inspection concern.
3. **Model awareness.** Adding a new tier the model hasn't seen before: include a one-sentence framing in the system prompt — "Beliefs are the agent's current working theories, subject to revision. Facts in `<semantic-memory>` are stable." This is the only prompt change to the Executive.
4. **Confidence arithmetic.** The 0.15 cap on single-reinforcement avoids runaway. Open question: is this the right shape, or should we use a proper Beta/Bernoulli update with evidence counts? Out of scope v1; revisit after 60 days of operational data.
5. **Survey citation note.** Pengfei Du's survey (2603.07670v1) classifies our architecture-to-be as spanning mechanism families 2 (retrieval-augmented) and 3 (reflective self-improvement). The beliefs tier is squarely in family 3 and the survey's "open problem: continual consolidation" names the exact promotion/demotion cycle this CR specifies.
6. **Arxiv ID verified.** 2512.12818 confirmed — Latimer, Boschi, Neeser, Bartholomew, Srivastava, Wang, Ramakrishnan 2025. Four-network separation (world facts / experiences / entity summaries / beliefs) directly inspires this CR's K/E/B split. Retain/recall/reflect ops map onto our store/retrieve/archivist flow — not adopted verbatim.
