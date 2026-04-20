# CR_OODA_EMOTIONAL_TAGGING — Priority-weighted episodic memory

Status: draft
Target batch: F (post-integration)
Estimated effort: 1 day
Depends on: none (ships standalone)

---

## Source

Mattson, 2014 — "Superior Pattern Processing is the Essence of the Evolved Human Brain" (_Frontiers in Neuroscience_, 8:265). Emotions are a memory-weighting mechanism: arousal enhances hippocampal pattern separation and durability of encoding. Fear, urgency, pleasure — not ends in themselves; salience gradients on the recall priors.

## Motivation

Currently every episodic memory captured by `memory-lancedb` uses a crude `importance` value (0.0–1.0) derived from category + heuristics at capture time. The SITREP priority (1–10) produced by `runTriage` — which _is_ openclooda's emotional-arousal analog — is discarded after it gates `shouldRunFullOODA` and selects council mode. It never reaches the memory layer.

Result: a decision made at P9 (deploy-pipeline incident, commitment at risk) has the same durability and recall prior as a decision made at P2 (acknowledgment of a greeting). Flat salience. Pattern retrieval cannot distinguish "elevated-stakes past" from "routine past."

This CR pipes the triage signal into capture and recall so memory weight tracks decision arousal.

## Design

### Capture-side

- `before_agent_start` computes `sitrep.priority` (already shipped).
- Propagate it into the per-turn context as `turnEmotion: { priority, rawPriority, quadrant }`.
- `after_tool_call` and any other episodic capture site reads `turnEmotion` from context and multiplies the captured `importance`:

  ```
  importance_weighted = baseline_importance * (0.5 + 0.05 * sitrep.priority)
  ```

  Yields:
  - P10 → 1.0x (full amplification)
  - P5 → 0.75x (neutral baseline)
  - P1 → 0.55x (near-floor)

- Also persist `sitrepPriorityAtCapture: number` directly on the episodic row (new column; backfill `null` for pre-CR rows).

### Recall-side

- `memory-lancedb` recall scorer currently uses cosine-sim + `importance`. Change to:

  ```
  score = cosine_sim * importance_weighted * age_decay
  ```

  Multiplying (not adding) because emotional weight is multiplicative in the dentate-gyrus analog — it sharpens the prior, doesn't add a constant.

### Meta-reviewer downstream

- `aggregateAxisPriors` (ErrorTag aggregation) should weight each error-tagged event by `sitrepPriorityAtCapture` when computing `axisRate`:

  ```
  weighted_count = sum(1 * priority_weight(event.sitrepPriorityAtCapture))
  ```

  A `planning` failure at P9 signals more than 10 `action` failures at P2.

- `computeDistortion` similarly: grounded-vs-measured drift should be computed on priority-weighted samples, not raw counts.

## Schema additions

```ts
interface EpisodicEvent {
  // ... existing fields
  sitrepPriorityAtCapture?: number; // 1-10, null for pre-CR events
}
```

No changes to KNOWLEDGE/BELIEFS/PRIORITIES files.

## Integration points

1. `src/triage.ts` — runTriage already returns sitrep; no change.
2. `extensions/memory-ooda/index.ts` `before_agent_start` — attach `sitrepPriorityAtCapture` to `ctx.turnEmotion` (new context field) so downstream hooks see it.
3. `extensions/memory-lancedb/index.ts` — capture path reads `ctx.turnEmotion?.priority`, applies weighting, stamps column.
4. `extensions/memory-lancedb/api.js` — recall scorer uses `importance_weighted`.
5. `extensions/memory-ooda/error-classifier.ts:aggregateAxisPriors` — accept optional priority weight fn.
6. `extensions/memory-ooda/distortion-index.ts:computeDistortion` — same.

## Testability

Unit tests:

- Weighting formula: P1/P5/P10 produce expected multipliers.
- Recall ordering: given 3 memories with identical embeddings but sitrep priorities 2/5/9, P9 wins.
- Backfill: events with `sitrepPriorityAtCapture=null` default to P5 weight (0.75x).
- Axis priors reweighting: one P9 failure outweighs five P2 failures.

Integration test: seed workspace with synthetic episodic log covering mixed priorities; run recall for ambiguous query; assert high-priority memories surface first.

## Success metrics

- **Retrieval quality delta** — measured via admission corpus with priority-labeled fixtures: does priority-weighted recall retrieve the "correct" memory (labeled by fixture author) more often than flat recall? Target ≥ 10% improvement at k=5.
- **Distortion detection lift** — in the grounded-eval harness, does Campbell regime detection fire earlier when priorities are weighted? Seed a synthetic drift + measure days-to-detection.
- **No latency regression** — capture path p95 unchanged; recall p95 unchanged (single multiplication added).

## Admission gate

`kind: "knowledge_edit"` on all capture changes. Pass-k floor standard 0.70 (knowledge_edit default). No regression on priorOutcome=success fixtures required.

## Out of scope

- Dynamic weight curve tuning (the 0.5 + 0.05x formula is hardcoded). If results show saturation/undershoot, follow-up CR can expose as PRIORITIES.json threshold.
- Emotional decay over time (arousal-memory decay curves). This CR treats priority-at-capture as static. Future CR could decay weight as age increases.
- Cross-modal emotional integration (channel-provided signals like "user typed in all caps" → stress proxy). Out of scope; separate affective-input CR.
