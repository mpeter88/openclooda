# CR_OODA_PATTERN_SEPARATION_GATE — Dentate-gyrus analog for recall

Status: implemented
Target batch: G (after emotional-tagging + DMN)
Estimated effort: 5 days
Depends on:

- CR_OODA_EMOTIONAL_TAGGING (priority-weighted recall is the right base signal)
- Dual-embedding infrastructure (sparse hash + dense embedding) — new

---

## Source

Mattson, 2014 — "Superior Pattern Processing is the Essence of the Evolved Human Brain" (_Frontiers in Neuroscience_, 8:265). Hippocampus does two opposing things:

- **Pattern separation** (dentate gyrus, new granule cells): take two similar inputs and push them apart in representational space so retrieval doesn't confuse them. New neurons — adult neurogenesis — specifically sharpen separation.
- **Pattern completion** (CA3, recurrent collaterals): take a fragmentary input and fill in missing context from stored associations.

These are opposite operations on the same machinery, and they trade off. The brain regulates the balance depending on whether the current task needs discrimination or recall.

## Motivation

openclooda's current memory-lancedb recall is pure-completion: cosine-similarity over dense embeddings, top-k nearest neighbors, no separation. This produces a well-known failure mode: near-duplicate contexts (same user, same project, slightly different situation) return essentially the same memory, and the LLM gap-fills by completing the familiar pattern rather than recognizing the novel piece.

In practice this is openclooda's hallucination/confabulation path: high-similarity recall invites the model to echo prior answers as if they apply to the new situation. The reflect loop detects this downstream (sometimes) but the damage — stale reasoning cited as fresh — is already in the turn output.

This CR adds an explicit separation signal to recall: distinguish between "almost identical — confabulation hazard" and "semantically adjacent but practically distinct — useful fuzzy fill."

## Design

### Dual-embedding capture

Current: each episodic event gets one dense embedding (nomic-embed-text, 768d).

After: each event also gets a **sparse hash signature** — MinHash over token n-grams of the event text. 128-bit hash, stored alongside the dense vector in the episodic row.

```ts
interface EpisodicEvent {
  // ... existing fields
  vector: number[]; // dense, existing
  hashSignature: number[]; // MinHash, new — 4 × int32 for 128 bits
}
```

MinHash is cheap to compute (no model call), and Jaccard similarity on MinHash sketches is well-correlated with actual n-gram overlap.

### Three-band retrieval

Recall query returns k=20 candidates ranked by dense cosine-sim (existing). For each candidate, compute MinHash Jaccard similarity with the query text (token-level n-grams).

Classify into bands:

| Band              | Dense cosine | MinHash Jaccard | Interpretation                                                                                    |
| ----------------- | ------------ | --------------- | ------------------------------------------------------------------------------------------------- |
| `exact_duplicate` | ≥ 0.95       | ≥ 0.80          | Near-identical prior turn. Strong confabulation hazard.                                           |
| `semantic_twin`   | ≥ 0.95       | < 0.80          | Same meaning, different words. Completion is appropriate — this is what cosine sim is for.        |
| `lexical_echo`    | < 0.95       | ≥ 0.80          | Same words, different meaning (unusual). Separation signal: this past memory is _not_ the answer. |
| `fuzzy_candidate` | 0.60 – 0.95  | anything        | Normal fuzzy fill. Pass through.                                                                  |
| `weak_signal`     | < 0.60       | anything        | Drop from primary context; available via deep-retrieval only.                                     |

Return candidates annotated with band. LLM prompt template uses the band explicitly:

- `exact_duplicate` → framed as "Warning: you have seen nearly identical context at {timestamp}. If this new turn has the same answer, say so. If different, explain what changed."
- `lexical_echo` → framed as "Caution: lexical overlap with a past memory that had a different meaning. Do not assume the past answer applies."
- Others → framed as today (informational context).

### Adaptive threshold

The 0.95 / 0.80 thresholds are starting values. Each workspace accumulates hit-rate data per band. Over time, PRIORITIES.json exposes:

```jsonc
"separation_thresholds": {
  "exact_dense_floor": 0.95,
  "exact_hash_floor": 0.80,
  "weak_dense_ceil": 0.60,
  "auto_tune_enabled": true
}
```

When `auto_tune_enabled`, a weekly job (DMN work unit, or meta-reviewer pass) shifts thresholds to maintain target proportions:

- `exact_duplicate` ≤ 5% of retrievals (too many → raise thresholds; hazard alerts become noise)
- `weak_signal` ≤ 30% of retrievals (too many → lower ceiling; we're dropping useful signal)

### Novelty score

In addition to bands, compute per-query novelty:

```
novelty = 1 - max(dense_similarity of top-k retrieved)
```

Range [0, 1]. High novelty → query has no near-match in memory → safe to generate freely; system2 council more important (no prior to lean on). Low novelty → query closely matches past → completion is easy but also risky; invoke `exact_duplicate` / `lexical_echo` handling.

Wire novelty into `runTriage`: add a `novelty` axis to SITREP (new optional field). High priority + high novelty = genuinely new problem, escalate to system2 even at lower priority threshold. Low priority + low novelty = routine, suppress full-OODA.

### Separation-aware confabulation check

When `exact_duplicate` retrievals fire, `runCouncil` gets a new member: the **Discriminator**. Its one question: "What is different between the current situation and the nearest prior? If nothing is different, return the prior answer. If something is different, name it."

This formalizes the brain's pattern-separation task: force an explicit difference call.

## Schema additions

```ts
// types.ts
export interface SITREP {
  // ... existing
  novelty?: number; // 0-1, present when recall ran
}

export interface RetrievalBand {
  band: "exact_duplicate" | "semantic_twin" | "lexical_echo" | "fuzzy_candidate" | "weak_signal";
  denseSim: number;
  hashJaccard: number;
  memoryId: string;
}

export interface RetrievalResult {
  candidates: Array<EpisodicEvent & RetrievalBand>;
  novelty: number;
  thresholdsUsed: SeparationThresholds;
}
```

Episodic row gains `hashSignature: number[]` column in both sqlite-vec and lancedb backends.

## Integration points

1. `extensions/memory-lancedb/api.js` — extend capture to compute + store MinHash signature. Extend recall to compute bands and novelty.
2. `extensions/memory-lancedb/index.ts` — sqlite schema migration: add `hash_signature` BLOB column. Lancedb: add to Arrow schema.
3. `extensions/memory-ooda/triage.ts` — accept optional `novelty` input; include in SITREP when present.
4. `extensions/memory-ooda/council.ts` — add Discriminator member type; fires only when retrieval band includes `exact_duplicate`.
5. `extensions/memory-ooda/index.ts` `before_agent_start` — retrieval happens before triage; pass `novelty` into `runTriage` input.
6. New file `extensions/memory-lancedb/min-hash.ts` — pure MinHash implementation (128-bit, 4×int32).

## Testability

Unit tests:

- MinHash: deterministic for same input; Jaccard similarity matches naive token-set Jaccard within 5% for 1000 synthetic pairs.
- Band classifier: given synthetic (dense, hash) pairs, produces expected band.
- Novelty: on empty workspace, novelty = 1.0. On exact-duplicate query, novelty ≤ 0.05.
- Threshold auto-tune: simulate 1000 retrievals with skewed band distribution, verify tuning moves thresholds toward target proportions.
- Schema migration: old rows without hash_signature read correctly; capture fills forward.

Integration test: seed workspace with 50 episodic events including 5 exact duplicates (same text, 1 word changed). Query with the original text. Verify:

- `exact_duplicate` band returned for all 5 semantically-equivalent matches.
- Council fires Discriminator.
- LLM output cites the difference explicitly (fixture assertion on council_trace.discriminator output).

## Success metrics

- **Confabulation reduction** — grounded-eval harness fixtures intentionally designed to trap completion (near-duplicate context with a material difference). Target: Discriminator catches the difference ≥ 80% of the time, versus current ≥ 30% (baseline must be measured).
- **Novelty-tuned council escalation** — % of turns that upgrade from system1 to system2 due to high novelty + mid-priority should be non-trivial (target 10-15%), and those turns should show better alignment scores than forced-system1.
- **Hash compute overhead** — capture p95 latency increase ≤ 2ms (MinHash over a few hundred tokens is sub-millisecond).
- **Threshold auto-tune convergence** — after 200 queries, band distribution stabilizes within 10% of targets without manual tuning.

## Admission gate

- `kind: "knowledge_edit"` for the schema migration (one-time).
- Standard gate on capture changes.
- Threshold auto-tune changes to PRIORITIES.json are `kind: "trajectory_calibration"`.

## Out of scope

- Replacing dense embeddings with learned sparse codes (à la SPLADE). MinHash is a pragmatic stand-in; full learned sparse retrieval is a much bigger project.
- Adult-neurogenesis analog — the biology suggests _new_ granule cells over-separate specifically to sharpen recent memories vs old. Implementation would require decayed embedding spaces. Future CR.
- Cross-modal separation (image + text). Text-only v1.
- Integration with channel-provided similarity signals (e.g. GitHub issue duplicate-detector). Out of scope.

## Open questions

- MinHash signature size: 128-bit (our proposal) vs 256-bit. Larger = more accurate Jaccard estimate but 2x storage per event. 128-bit is the sweet spot for ≤1% Jaccard estimation error.
- Should Discriminator fire on `lexical_echo` band too, or only `exact_duplicate`? Opinion: yes, because lexical overlap without semantic match is the most confabulation-inducing state. But it's rare enough that the noise floor might be acceptable.
- When the workspace has < 50 episodic events, band classification is meaningless (everything is either "no match" or "the only match"). Disable gate until corpus threshold crossed. Gate already has this pattern (min_corpus_bootstrap).
