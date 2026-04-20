# CR_OODA_CAUSAL_RETRIEVAL — Retrieve by antecedence, not cosine alone

Status: shipping
Target batch: G (follows emotional-tagging + DMN + pattern-separation)
Estimated effort: 1 day
Depends on: episodic events with `actionId` + `outcome` / `outcomeSignal` (already present)

---

## Source

Du et al. 2026 survey on episodic memory in LLM agents (filed as a deferred idea in `cr/CR_BATCH_A_TO_E_CHECKPOINT.md`). Human recall is not pure similarity: we preferentially retrieve memories that _caused_ the current situation (or memories whose consequences resemble the current problem), not memories that merely look like the current observation.

## Motivation

memory-lancedb's recall is cosine over dense embeddings — good for finding texts that resemble the query, weak for finding decisions that _led to_ the current state. When a user asks "why did the deploy fail" or "what's different this time," the useful answer lives in antecedent decisions, not in semantically similar memories.

Today those decisions are captured (we have `actionId`-tagged decision memories + outcome-labeled success/failure events), but nothing surfaces them as antecedents. The pattern-separation gate (shipped) gives us surface-form duplicate detection; causal retrieval is the complementary axis: same _result_, different _surface_.

## Design

### Causal index

Built in-memory from an episodic-event window:

```
causalIndex: Map<outcomeSignal, Array<AntecedentRow>>
AntecedentRow: { decisionId, decisionText, decisionAt, outcomeAt, gapMs, outcome }
```

The index is constructed by joining each outcome-labeled event (`outcome !== undefined`) back to the most recent decision-class memory with the same `actionId`. Result: for every outcomeSignal we've ever seen, a list of past decisions that preceded it.

### Retrieval API

```ts
findAntecedents(
  events: EpisodicEvent[],
  query: { outcomeSignal?: string; outcome?: "success" | "failure" | "partial"; withinMs?: number },
  options?: { limit?: number },
): AntecedentRow[];
```

Returns decisions whose associated outcome matches the query, sorted by recency. Complements cosine retrieval — doesn't replace it.

### Integration points (v1 scope)

1. **Observability CLI** — new `workspace errors causes <signal>` shows antecedents for a given failure signal. Operator-facing tool.
2. **Archivist step 9.6** — when emitting a `criticalFailure`, attach the top-3 antecedent decisions as evidence. Lets the meta-reviewer see "these decisions preceded this failure mode" without a separate query.
3. (Out of scope v1) Wire into `before_agent_start` so triage + council can cite antecedents. Needs prompt-surface work; defer.

### Contract

- Pure over events array — no mutation.
- No LLM calls.
- Returns empty array when the corpus has no matching antecedents. Never throws.

## Schema

No changes. Relies on existing `EpisodicEvent` fields (`actionId`, `outcome`, `outcomeSignal`, `outcomeAt`, `createdAt`).

## Success metrics

- Integration: `openclaw workspace errors causes build_failed` on a populated workspace returns non-empty list with monotone `decisionAt` descending.
- Quality: for labeled failures, antecedent lists overlap with the expected "what changed" answer in test fixtures. Measure via admission corpus once CAUSAL_RETRIEVAL fixtures land.

## Out of scope

- Automatic causal-chain inference (Granger tests, propensity scores).
- Multi-hop chains (A → B → C).
- Cross-session antecedent lookup (same actionId across session boundaries).
