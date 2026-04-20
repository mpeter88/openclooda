# CR_OODA_DMN_INTEGRATION_LOOP — Default Mode Network analog with activity-tapered cadence

Status: draft
Target batch: F (post-integration)
Estimated effort: 3 days
Depends on: none structurally; lighter if CR_OODA_EMOTIONAL_TAGGING has shipped (DMN can then re-score priority-weighted memories)

---

## Source

Mattson, 2014 — "Superior Pattern Processing is the Essence of the Evolved Human Brain" (_Frontiers in Neuroscience_, 8:265). The Default Mode Network (DMN) — posterior cingulate, medial prefrontal, lateral parietal — is active during introspection, not external tasks. It integrates prior patterns, rehearses likely futures, and supports "mental time travel." DMN connectivity correlates with consciousness level: reduced in NREM sleep, lowest in deep sleep, restored on waking.

## Motivation

openclooda currently has reactive loops (`agent_end` fires archivist-nudge, slow-clarify, reflect, error-classifier) and a pulse (`heartbeat` that only pings health). There is no genuine idle-state processing — between user turns the system does _nothing_.

This wastes an opportunity: pattern integration, belief re-scoring, and next-turn rehearsal are all well-suited to low-priority background work. They don't block any user-visible latency.

Critically, an untapered 90-second loop running for hours while the user is away is wasteful of API quota and produces diminishing returns (no new input to integrate). The biological analog backs this: DMN activity decreases during sleep. Our "sleep" is user absence. Work cadence must track user-presence.

## Design

### Cadence ladder (tapered)

Measured from `lastUserActivityAt` = timestamp of most recent `before_agent_start`.

| Bucket  | User absent for | Cadence      | Rationale                              |
| ------- | --------------- | ------------ | -------------------------------------- |
| Active  | ≤ 5 min         | every 90s    | Fresh signal; high-value integration   |
| Recent  | 5–30 min        | every 5 min  | Continued presence; steady integration |
| Idle    | 30 min – 4 h    | every 15 min | User may return soon; light upkeep     |
| Dormant | 4 h – 24 h      | every 60 min | Deep rest; minimal work                |
| Asleep  | > 24 h          | paused       | Resume on user activity                |

Any `before_agent_start` resets to Active immediately.

Configurable via `PRIORITIES.json`:

```jsonc
"dmn": {
  "enabled": true,
  "active_interval_s": 90,
  "recent_interval_s": 300,
  "idle_interval_s": 900,
  "dormant_interval_s": 3600,
  "asleep_after_hours": 24
}
```

### Work units

Each tick, DMN loop selects ONE work unit to run (not all; low-priority, cheap). Round-robin with bucket-scoped filters:

1. **Belief re-scoring** (runs in all buckets)
   - Read `BELIEFS.json` + episodic events since last DMN tick.
   - For each belief with `confidence > 0.6`, check whether recent events corroborate/contradict.
   - Apply `reinforceBelief` / `weakenBelief` with small deltas (≤ 0.02 per tick so drift is gradual).

2. **Retrospective adaptive-chair** (Active + Recent only)
   - Find last council decision flagged `dissent: true` in the last hour.
   - Run `runAdaptiveChair` on the decision (multi-sample stability check post-hoc).
   - If `winnerShare < 0.6`, write a `criticalFailure` event with severity `warning` — council was uncertain, flag for meta-review.

3. **Next-turn rehearsal** (Active + Recent only)
   - Read `knowledge.commitments` for any commitment firing in the next 60 min.
   - Pre-compute a triage pass on a synthetic observation (e.g. "you have X commitment in 30 minutes").
   - Cache result at `.dmn-rehearsals.jsonl` so when the real event fires, triage can reuse prior analysis.

4. **Pattern distillation** (Idle + Dormant only)
   - Lightweight archivist pass — retrieve top 10 unprocessed episodic events, extract 1-2 patterns, propose as candidates (not immediately upserted).
   - Accumulates candidates for next full archivist run.

5. **Campbell-regime watchdog** (all buckets)
   - Re-compute distortion index over recent window; if `campbell_suspected` regime entered since last tick, escalate (existing emit path).

### DMN metrics

Maintain `.dmn-state.json`:

```jsonc
{
  "last_tick_at": "2026-04-20T05:30:00Z",
  "bucket": "recent",
  "ticks_since_last_user_turn": 12,
  "work_units_completed": 47,
  "by_kind": {
    "belief_rescore": 20,
    "retrospective_chair": 8,
    "rehearsal": 9,
    "pattern_distill": 10,
  },
}
```

Log each work unit's outcome to `.dmn-log.jsonl` for later analysis.

### Idle-detection source of truth

`lastUserActivityAt` stored in `.archivist-state.json` (extend existing state file, don't proliferate files). Updated on every `before_agent_start`. DMN scheduler polls this field; no callbacks needed.

## Integration points

1. `extensions/memory-ooda/index.ts` — register new DMN service:
   - `api.registerService({ id: "memory-ooda-dmn", start: ..., stop: ... })`
   - `start` computes current bucket, schedules `setTimeout` for next tick based on cadence. Each tick re-evaluates bucket, re-schedules.
   - `stop` clears pending timeout.
2. New file `extensions/memory-ooda/dmn.ts` — `selectWorkUnit(bucket, state)`, `runWorkUnit(unit, deps)` — pure dispatch, easy to test.
3. `extensions/memory-ooda/archivist.ts` — extend `ArchivistState` with `last_user_activity_at: string` field.
4. `extensions/memory-ooda/beliefs.ts` — expose `rescoreAgainstEvidence(events, allBeliefs)` helper (currently logic is inline in `reinforceBelief` / `weakenBelief`).

## Testability

Unit tests:

- Bucket selection: given `lastUserActivityAt` at various ages, returns correct bucket.
- Cadence: each bucket returns expected interval.
- Taper determinism: replay a synthetic 24h timeline with mock clock, assert total tick count stays under budget (Active-equivalent would be 960 ticks/24h; tapered should be ~60-100).
- Work-unit selector: round-robin visits all eligible kinds; excluded kinds filtered by bucket.
- Reset: calling the hook that fires on `before_agent_start` restores Active bucket.

Integration test: stub clock, run 8 simulated hours, verify bucket transitions hit Recent / Idle / Dormant at expected boundaries.

## Success metrics

- **Cognitive readiness indicator** — on a `before_agent_start`, check whether a cached rehearsal from DMN pre-computed the incoming triage. If yes, triage latency drops to near-zero. Target: ≥ 30% of commitment-linked turns have a cache hit.
- **Early-warning dissent detection** — retrospective adaptive-chair catches council uncertainty that linear system missed. Target: ≥ 5 per week on active workspaces; validate against outcome labels (do flagged decisions have higher failure rate?).
- **No quota bloat** — total DMN API calls per day should scale sub-linearly with idle hours. Budget ceiling: ≤ 50 DMN-initiated LLM calls per 24h on an otherwise-idle workspace.
- **User-visible zero regression** — agent-turn latency unchanged whether DMN is running or paused.

## Admission gate

DMN work units that mutate state (belief re-score, pattern distillation → proposals) run through existing gate surfaces:

- Belief re-score → `kind: "belief_promotion"` (via existing admission path).
- Pattern distillation proposals → `kind: "knowledge_edit"` when eventually upserted.

DMN rehearsals and retrospective-chair are read-only; no gate.

## Out of scope

- Machine-learning the cadence curve (adaptive taper based on user patterns). Static config first; adapt later if needed.
- Cross-workspace DMN (integrating signals from sibling projects). Single-workspace only for v1.
- Real-time affect tracking (inferring user presence from channel activity other than direct agent turns). Single signal (`before_agent_start`) for v1.

## Open questions

- Should DMN pause entirely when gateway detects power-save/battery mode? Probably yes — add battery check on macOS/Linux hosts. Nice-to-have, not blocker.
- Should the Dormant bucket produce a "catch-up" burst on wake? Biological analog suggests yes (DMN ramps up quickly on waking). Implementation: on first bucket reset to Active, run 2-3 work units in quick succession instead of waiting for the next tick. Easy extension.
