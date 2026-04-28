# CR_OODA_LEARNED_FORGETTING — Prune by usefulness, not age alone

Status: implemented
Target batch: G (alongside causal-retrieval)
Estimated effort: 1 day
Depends on: EpisodicEvent fields (importance, outcome, lastRetrievedAt if added later)

---

## Source

Human memory does not evict by pure recency. Semantic consolidation protects frequently-retrieved and emotionally-tagged memories while pruning ambient noise. openclooda's current prune is FIFO by age, which treats a high-value decision memory identically to a one-off tool log.

## Motivation

`EpisodicStore.prune(olderThanMs, onlyProcessed=true)` is the only eviction path today. It's blind to:

- **Retrieval recency**: a 120-day-old memory retrieved yesterday is likely load-bearing; today's policy drops it just because `createdAt < cutoff`.
- **Outcome**: decisions with labeled outcomes ("deploy failed: pipeline_fail") are the causal-retrieval and distortion substrate. Losing them breaks the signal.
- **Importance**: memories already weighted above 0.75 (post emotional-tagging multiplier — a P9-priority decision) should survive longer.

Result: archivist distillation works against a degrading substrate. Lessons learned leak out the bottom of the pipeline.

## Design

### Policy surface — pure

```ts
interface ForgettingPolicy {
  /** Age cutoff; events older than this are eligible unless protected. */
  olderThanMs: number;
  /** Protect events with importance >= this. Default 0.75. */
  keepImportanceFloor: number;
  /** Protect events whose outcome is set (any band). Default true. */
  keepOutcomeLabeled: boolean;
  /** Protect events retrieved within this window. Default 30 days. */
  keepRetrievedWithinMs: number;
  /** Protect category whitelist (e.g. "decision"). Default ["decision"]. */
  keepCategories: string[];
}

function shouldKeep(event: EpisodicEvent, policy: ForgettingPolicy, now: number): boolean;
function partitionForPrune(events, policy, now): { keep: EpisodicEvent[]; drop: EpisodicEvent[] };
```

### Signals

Four protections, OR'd:

1. Importance ≥ `keepImportanceFloor` → keep (high-arousal memories).
2. `outcome` present → keep (causal-retrieval substrate, distortion samples).
3. `lastRetrievedAt` within `keepRetrievedWithinMs` → keep (active memories).
4. `category` in `keepCategories` → keep (decisions never evict, regardless of age).

Otherwise: drop if `createdAt < now - olderThanMs`.

### Integration points (v1)

1. **`archivist.ts` step 6 (pruning)** — replace the current blind `episodicStore.prune(threshold, true)` with:
   ```
   const events = await episodicStore.retrieveSince(0, some-large-cap);
   const { drop } = partitionForPrune(events, policy, Date.now());
   for (const d of drop) await episodicStore.delete?.(d.id);
   ```
   When the store doesn't expose `delete`, fall back to the old path (no regression).
2. **Observability CLI** — `openclaw workspace memory forget-policy` dry-runs a partition and prints how many would drop vs keep. Operator tool.

### Contract

- `shouldKeep` + `partitionForPrune` pure; no fs; no LLM.
- Deterministic given same inputs + `now`.
- Conservative default: when in doubt, keep. Pruning is hard to reverse.

## Schema

No schema changes v1. `lastRetrievedAt` not required — reads `outcomeAt` (outcome-labeled events are tracked anyway) and `importance` + `category` + `createdAt` which all exist.

Future: add `lastRetrievedAt: number` column to episodic rows, updated on every `search()` hit, for policy signal #3.

## Success metrics

- Populate a fixture with 1000 synthetic events (mix of decision / structural / outcome-labeled / high-importance).
- Expected partition: ≤20% dropped at 30-day cutoff; ≥95% of dropped events are neither outcome-labeled nor category=decision.

## Out of scope

- Learned-model usefulness score (train a classifier on "was this memory retrieved in the last session").
- Propagating prune decisions to derived indices (causal, axis priors).
- Cross-workspace forgetting rules.
