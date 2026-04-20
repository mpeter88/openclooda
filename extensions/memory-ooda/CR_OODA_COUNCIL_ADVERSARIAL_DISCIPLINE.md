# CR: OODA Council Adversarial Discipline — Position-Anchored Chair, Sycophancy Floor, Explicit Advocates

**Date:** 2026-04-18
**Status:** WRITTEN
**Priority:** HIGH — council exists but lacks anti-sycophancy guardrails documented in 2025 literature; currently vulnerable to the exact failure modes research has catalogued
**Renamed from:** `CR_OODA_COUNCIL_DEVILS_ADVOCATE.md` (original Batch D1 framing). Renamed after reading `council.ts` — devils_advocate role is already present in `system1` mode; the real gap is adversarial discipline across system1 + system2.
**Sources:**

- Debate, Deliberate, Decide (D3), Harrasse, Bandi, Bandi, EACL 2026 (arxiv 2410.04663) — advocates / judge / optional jury; MORE and SAMRE protocols.
- Talk Isn't Always Cheap, 2025 (arxiv 2509.05396) — disagreement-rate collapse as a failure signal.
- Peacemaker or Troublemaker, 2509.23055 — chair sycophancy as the dominant failure mode in centralized multi-agent debate.

---

## Current State

`council.ts` implements three modes:

- **`none`:** passthrough to `runStrategy`.
- **`system1`:** strategy produces a winner; a `devils_advocate` call rebuts the winner; winner reasoning is amended with the DA objection; no chair.
- **`system2`:** three members (`analyst`, `strategist`, `skeptic`) run in parallel; a `chair` call arbitrates and emits JSON with `label`, `reasoning`, `alignmentScore`, `efficiencyScore`, `riskScore`, `dissent`, `chairReasoning`.

What's missing:

- **Chair position-anchoring.** The chair reads member outputs fresh each time and makes a fresh judgment. Literature shows chairs flip toward the weakest peer (sycophancy) without an anchoring prior. Our chair has no anchor.
- **Sycophancy / disagreement metric.** We do not measure whether members disagree. Three agreeable outputs produce the same chair reasoning as three sharply-opposed ones, but the literature shows the first is noise and the second is signal.
- **system2 lacks an explicit devil's advocate role.** The `skeptic` is defined as "identify the weakest assumption" — it's adversarial in spirit but not structured as an advocate _against_ a specific proposed winner.
- **Single-round deliberation.** No cross-examination. If analyst proposes X and strategist proposes Y, the chair picks without forcing defenders to rebut.

---

## Design

### C1 — Position-Anchored Chair

`buildChairPrompt` is extended to accept a prior:

```typescript
export interface ChairPrior {
  /** Chair's initial lean before reading member outputs.
   *  Produced by running the chair on SITREP only (no member text). */
  preReadWinner: string;
  preReadReasoning: string;
  preReadConfidence: number; // [0, 1]
}

function buildChairPrompt(
  members: Array<{ role: string; output: string }>,
  sitrep: SITREP,
  priorities: PrioritiesFile,
  prior: ChairPrior, // <-- NEW required arg
): string;
```

New flow in `runCouncil` system2:

1. Call chair **once** with only the SITREP and priorities — no member outputs. Parse pre-read winner. This is the chair's anchor.
2. Call members in parallel (existing).
3. Call chair a **second** time with member outputs **and** the prior. The prompt explicitly requires: "State whether you changed your pre-read position. If you did, cite the specific member evidence that forced the change. If you did not, state the strongest objection you are overriding."

The second chair call parses a `flipped: boolean` and `flip_evidence?: string` into the council trace.

Anti-sycophancy rule: if `flipped === true` and `flip_evidence` is empty or contradicts member outputs, the chair call is retried once; second failure degrades to using the pre-read winner and logs `council_trace.anchor_fallback = true`.

### C2 — Disagreement-Rate Floor

Compute a disagreement score across members:

```typescript
export interface DisagreementReading {
  /** [0, 1]. 0 = all members proposed the same archetype/stance. 1 = maximally divergent. */
  score: number;
  /** Labels seen in member outputs, clustered. */
  clusters: Array<{ label: string; members: string[] }>;
  /** Explicit contradictions between members (extracted via a lightweight LLM call OR regex heuristics on archetype labels). */
  contradictions: Array<{ a: string; b: string; signal: string }>;
}

export function computeDisagreement(
  members: Array<{ role: string; output: string }>,
  archetypes: string[],
): DisagreementReading;
```

Gate: if `disagreement.score < thresholds.council_min_disagreement` (default `0.15`), emit a `council_trace.low_disagreement = true` flag and a `criticalFailure` event of severity `warning`. The council still returns a winner, but the SITREP log records that this decision was effectively single-voice — which means full council compute was wasted.

Over a 30-day window, if `low_disagreement` fires on > 40% of system2 runs, the meta-reviewer auto-proposes downgrading the council to system1 for the affected domain (via PolicyProposal, gated by the pass^k acceptance gate).

### C3 — system2 Gains an Explicit Advocate Participant

`CouncilMember.role` already includes `devils_advocate` as an enum value (`council.ts:25`) — it is used by system1 today. This CR does **not** add a new role; it adds a fourth **participant** slot in system2 that uses the existing role.

The `devils_advocate` participant in system2 is a **post-strategist** member: it receives the Strategist's recommendation and is instructed to argue specifically against it using the Skeptic's blind-spot identification as input. Sequence in system2:

1. Parallel: analyst, strategist, skeptic (same as today).
2. Sequential: devils_advocate receives `strategist.output` and `skeptic.output`, produces a targeted rebuttal.
3. Chair (with position anchor, per C1) receives all 4 outputs.

This creates D3-style advocate structure inside system2 without abandoning the cognitive-role framing.

### C4 — Optional Jury for High-Stakes Decisions

When `sitrep.priority >= 9` AND `disagreement.score >= 0.6`, a jury layer runs:

```typescript
export interface JuryResult {
  verdict: "affirm" | "overturn" | "split";
  individualVotes: Array<{ juror: string; vote: "affirm" | "overturn"; reasoning: string }>;
  finalChairReasoning: string;
}
```

The jury is 3 independent model calls (same base model, different system prompts emphasizing "independent review"; different temperatures: 0.0, 0.3, 0.6). Each juror reads the chair's verdict and the full member trace and votes.

- `affirm` × 3 → chair verdict stands.
- `overturn` × 3 → chair re-runs with jury reasoning injected.
- Split → chair verdict stands, `dissent: true`, flag in trace; meta-reviewer audits weekly.

Jury fires at most once per turn. Out of scope: recursive jury layers.

### C5 — Configuration

`PrioritiesFile.thresholds` extensions:

```typescript
{
  council_chair_anchoring_enabled: boolean; // default: true
  council_min_disagreement: number; // default: 0.15
  council_low_disagreement_window_days: number; // default: 30
  council_low_disagreement_ratio_floor: number; // default: 0.4 (triggers downgrade proposal)
  council_jury_enabled: boolean; // default: true
  council_jury_priority_floor: number; // default: 9
  council_jury_disagreement_floor: number; // default: 0.6
}
```

### C6 — Council Trace Extended

`CouncilTrace` gains:

```typescript
export interface CouncilTrace {
  // ... existing ...
  prior?: ChairPrior;
  flipped?: boolean;
  flip_evidence?: string;
  disagreement?: DisagreementReading;
  anchor_fallback?: boolean;
  low_disagreement?: boolean;
  jury?: JuryResult;
}
```

All new fields optional for back-compat with existing `SITREPLogEntry` readers.

### C7 — Test Coverage

Unit tests for:

- `computeDisagreement` — all-same (0), all-different (1), two-cluster (mid).
- Chair prior parsing.
- Anchor-fallback path when second chair call produces empty flip_evidence.
- Jury verdict aggregation (affirm×3, overturn×3, split).
- System2 sequencing: strategist must complete before devils_advocate starts.
- Low-disagreement downgrade proposal surfaces via archivist proposals flow.

### C8 — Interaction with Other CRs

- **A1 (Grounded Eval V2):** jury verdicts and disagreement scores feed distortion index. An agent with consistent chair flips that the jury overturns is exhibiting Campbell-regime evaluator degradation.
- **A2 (Trajectory V2):** domain trajectories bias disagreement floor — a domain with strong negative trajectory gets `council_min_disagreement = 0.25` (higher floor — demand more dissent when things are failing).
- **C1 (Error Taxonomy):** anchor_fallback and low_disagreement events feed axis counts — `reflection` axis failures.
- **C2 (pass^k Gate):** any change to council mode, jury config, or disagreement floor is a `council_mode` ChangeKind requiring gate pass.
- **D2 (KS Stopping):** jury is a fixed-size panel; KS stopping from D2 applies to multi-round chair deliberations introduced there.

---

## Acceptance Criteria

- [ ] Chair position anchoring implemented and tested; anchor_fallback path exercised.
- [ ] `computeDisagreement` and disagreement floor wired.
- [ ] System2 devils_advocate role added, runs sequentially after strategist + skeptic.
- [ ] Jury layer fires at configured priority + disagreement thresholds; votes aggregated correctly.
- [ ] New config keys in `PrioritiesFile.thresholds` with defaults and validation.
- [ ] Extended `CouncilTrace` fields populated on every system2 run.
- [ ] Meta-reviewer weekly pass includes low-disagreement ratio and proposes downgrade when floor exceeded.
- [ ] No regression in existing `council.test.ts` — all tests pass, new tests green.

---

## Risk and Open Questions

1. **Cost.** System2 was 4 model calls (3 members + chair). This CR raises it to 6 in the default case (pre-read chair + 3 members + devils_advocate + post-read chair) and up to 9 when jury fires. Mitigate: chair pre-read uses a smaller/cheaper model. Jury only fires at `priority >= 9` + `disagreement >= 0.6` — low-base-rate event.
2. **Sycophancy measurement is fuzzy.** `computeDisagreement` using LLM-based contradiction extraction can itself be sycophantic. Start with heuristic label-clustering (archetype labels extracted via regex from member outputs), upgrade to LLM-judged only after baseline data.
3. **Jury homogeneity.** Three temperatures of the same model are not truly independent. Acknowledged limitation; upgrade to mixed-provider juries is out of scope.
4. **Downgrade proposal from meta-reviewer.** If system2 routinely shows low disagreement, the proposal is to move to system1. But system1 has its own devils_advocate. Make sure the downgrade path doesn't disable adversarial checking entirely — `system1` must remain the floor.
5. **Arxiv IDs.** All three verified (2026-04-18 re-check):
   - 2410.04663 — Harrasse, Bandi, Bandi (D3, EACL 2026).
   - 2509.05396 — Wynn, Satija, Hadfield 2025 ("Talk Isn't Always Cheap"). Confirms "stronger agent flips to weaker peer" failure mode. **Does not itself propose disagreement-rate as stopping signal** — the floor in C2 is our derivation in response to the failure mode the paper documents. Cite as motivation, not as source of the mechanism.
   - 2509.23055 — Yao et al. 2025 ("Peacemaker or Troublemaker"). Confirms sycophancy + judge vulnerability framing; "disagreement collapse" phrase present in abstract.

6. **`SitrepLogEntry` casing.** Existing type in `sitrep-log.ts:17` is `SitrepLogEntry` (lowercase `itrep`), not `SITREPLogEntry`. Use the canonical casing everywhere.

7. **`ChairParsed` visibility.** Current `council.ts:332` declares `ChairParsed` as a local interface. D2 imports it; this CR's C1 extends the chair flow. Export `ChairParsed` as part of D1's changes so downstream CRs can consume it.
