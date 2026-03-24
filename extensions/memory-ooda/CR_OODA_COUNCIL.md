# CR: OODA Council — System 1 / System 2 Strategy Deliberation

**Date:** 2026-03-24
**Status:** IMPLEMENTED
**Priority:** HIGH — materially improves strategy quality; architecture is clean extension of existing runStrategy()
**Author:** Design session with michaelpeter

---

## Problem

The current Strategy phase uses a single `callModel()` call to generate and score candidates.
There is no adversarial pressure, no cross-examination, and no structural way for the agent
to catch its own blind spots before committing to a direction.

Inspired by:

- Kahneman's System 1 (fast, heuristic) / System 2 (slow, deliberate) thinking
- IEP Champion's multi-agent wave + ARB quality gate pattern
- Orion-Sapienform's council deliberation with explicit chair arbitration

---

## Design

Two council modes, selected by a `councilMode` field on `StrategyInput`:

### System 1 — Devil's Advocate (always-on, low cost)

Fires on **every** full OODA turn (i.e., when `shouldRunFullOODA` returns true).

**Members (parallel):**

1. Existing strategy prompt → produces candidates + winner as today
2. **Devil's Advocate** (`callModel` with small/fast model): given the proposed winner,
   generate the strongest 1-2 sentence objection

**Chair (inline, no extra call):**
The existing strategy prompt is amended to append the Devil's Advocate objection as
context. The winning strategy's `reasoning` is updated to acknowledge or rebut it.
No extra model call — the chair logic is baked into the prompt.

**Net cost:** +1 small model call (haiku-class), parallel with nothing.
**Net benefit:** Every strategy has been stress-tested before the agent acts on it.

### System 2 — Full Council (threshold-gated, quality-first)

Fires when SITREP priority ≥ `thresholds.council_priority_threshold` (default: 7)
**AND** `thinkingLevel >= "medium"`.

**Members (parallel, 3 calls):**

1. **Analyst** — factual read, no action bias. What is actually happening here?
2. **Strategist** — action options with explicit tradeoffs. What should we do and why?
3. **Skeptic** — what assumption in the proposed strategies is most likely wrong?

**Chair (1 call, sequential after members):**
Receives all three member outputs + original SITREP. Produces:

- Final strategy selection (same `Strategy` shape as today)
- `council_trace`: object capturing member outputs + chair reasoning (for Archivist)
- `dissent`: boolean — true if chair overrode the Strategist's top pick

**Net cost:** +3 small + 1 medium model calls (parallel where possible).
**Net benefit:** High-stakes decisions get genuine deliberation.

---

## Changes Required

### C1 — `council.ts` (NEW FILE)

New module: `extensions/memory-ooda/council.ts`

Exports:

```typescript
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

export async function runCouncil(
  input: StrategyInput,
  mode: CouncilMode,
  callModel: ModelCallFn,
): Promise<CouncilResult>;
```

Internal flow:

- `"none"` → delegates to existing `runStrategy()`, wraps result
- `"system1"` → runs strategy + devil's advocate in parallel, amends winner reasoning
- `"system2"` → runs 3 members in parallel, then chair call, returns full trace

### C2 — `strategy.ts` (MODIFY)

Add `councilMode?: CouncilMode` to `StrategyInput`.
Existing `runStrategy()` signature unchanged — council is opt-in from the caller.

Add `buildDevilsAdvocatePrompt(winner: Strategy, sitrep: SITREP): string` — generates the
DA prompt given a proposed winning strategy.

Add `buildChairPrompt(members: CouncilMember[], sitrep: SITREP, priorities: PrioritiesFile): string` —
System 2 chair prompt that takes all member outputs.

### C3 — `types.ts` (MODIFY)

Add to `PrioritiesFile.thresholds`:

```typescript
council_priority_threshold: number; // default: 7
council_system1_enabled: boolean; // default: true
council_system2_enabled: boolean; // default: true
```

Add `CouncilTrace` type:

```typescript
export interface CouncilTrace {
  mode: "system1" | "system2";
  members: Array<{ role: string; output: string }>;
  chairReasoning: string;
  dissent: boolean;
}
```

Add optional `councilTrace?: CouncilTrace` to `Strategy`.

### C4 — `index.ts` (MODIFY)

In `before_agent_start`, after `runStrategy()`:

1. Determine `councilMode`:
   - `sitrep.priority >= priorities.thresholds.council_priority_threshold`
     AND `thinkingLevel >= "medium"` AND `council_system2_enabled` → `"system2"`
   - `council_system1_enabled` → `"system1"`
   - else → `"none"`

2. Call `runCouncil(strategyInput, councilMode, callModel)`

3. Inject `<ooda-council>` block into context when System 2 ran (System 1 is silent — just amends the winner's reasoning inline)

4. Log council dissent at `api.logger.info` level when `dissent: true`

### C5 — `PRIORITIES.json` template (MODIFY)

Add council thresholds to the default template generated by `getPriorities()`:

```json
"council_priority_threshold": 7,
"council_system1_enabled": true,
"council_system2_enabled": true
```

### C6 — Tests (NEW FILE)

`council.test.ts`:

- System 1: winner reasoning is amended with DA objection
- System 2: all 3 members called, chair selects winner, dissent flag set correctly
- `"none"` mode: delegates to runStrategy, no extra calls
- Fallback: council failure degrades to runStrategy result (no crash)
- Integration: councilMode selected correctly from priority + thinkingLevel thresholds

---

## Acceptance Criteria

- [ ] System 1 fires on every full OODA turn; winner.reasoning mentions or rebuts the DA objection
- [ ] System 2 fires only when priority ≥ 7 AND thinkingLevel ≥ "medium"
- [ ] System 2 `<ooda-council>` block visible in system context (inspectable)
- [ ] `dissent: true` logged when chair overrides Strategist
- [ ] Council failure (model call error) degrades gracefully to existing runStrategy result
- [ ] All existing strategy tests still pass
- [ ] New council tests: ≥ 10 cases covering both modes + fallback

---

## Files Changed

| File                                     | Change                                  |
| ---------------------------------------- | --------------------------------------- |
| `extensions/memory-ooda/council.ts`      | NEW — council orchestration             |
| `extensions/memory-ooda/council.test.ts` | NEW — tests                             |
| `extensions/memory-ooda/strategy.ts`     | Add DA + chair prompt builders          |
| `extensions/memory-ooda/types.ts`        | CouncilTrace, council thresholds        |
| `extensions/memory-ooda/index.ts`        | councilMode selection + runCouncil call |
| `extensions/memory-ooda/priorities.ts`   | Add council threshold defaults          |

---

## Notes

- System 1 is invisible to the user — it only shows up as better-reasoned strategy output
- System 2 injects an `<ooda-council>` block only when it fires — not every turn
- The `council_trace` written by System 2 is available to the Archivist for pattern detection
  (e.g., "dissent happens frequently on coding tasks" → policy proposal)
- Model for DA and members: whatever `callModel` resolves to — no hardcoded model.
  The caller (index.ts) can pass a faster model for System 1, main model for System 2 chair.
- Devil's Advocate prompt should be tightly scoped: "given THIS specific winner, what is
  the single strongest objection?" — not a general critique of all strategies
