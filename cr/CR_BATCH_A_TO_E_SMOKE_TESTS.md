# Smoke Tests — CR Batches A through E

**Date:** 2026-04-18
**Purpose:** per-CR + cross-cutting smoke probes. One page of commands per CR. Each probe is designed to fail loudly if the CR's core claim does not hold, and pass quickly when the implementation is working.

Run order: per-CR probes first (parallel where independent), then cross-cutting probes.

---

## Ground Rules

- All probes assume a throwaway workspace at `/tmp/ooda-smoke-$(date +%s)` — never run against `~/.openclaw/workspace`.
- Each probe prints `PASS` / `FAIL <reason>` and exits non-zero on failure.
- Shared fixtures live in `extensions/memory-ooda/fixtures/smoke/`:
  - `episodic-seed.jsonl` — 30 events covering all domains and outcomes.
  - `sitrep-seed.jsonl` — 15 SITREPs with known priorities.
  - `axis-fixtures.json` — 10 hand-labeled failure events per `ErrorAxis`.

---

## A1 — Grounded Eval Harness V2

### A1.1 Admission corpus capture + replay

```bash
openclaw workspace admission capture \
  --fixture fixtures/smoke/episodic-seed.jsonl \
  --action-id amf_success_2026_03_12
openclaw workspace admission replay amf_success_2026_03_12
# expect: passes on current config
```

### A1.2 Mutated PRIORITIES regression

```bash
openclaw workspace admission replay amf_success_2026_03_12 \
  --override-priorities '{"domains":{"amf_pipeline":{"weight":0.1}}}'
# expect: fails — mutated domain weight regresses prior-success case
```

### A1.3 Goodhart vs Campbell diagnostic

```bash
openclaw workspace distortion --simulate synthetic-goodhart
# expect: regime="goodhart_warning"
openclaw workspace distortion --simulate synthetic-campbell
# expect: regime="campbell_suspected", criticalFailure emitted
```

### A1.4 pass^8 floor enforcement

```bash
openclaw workspace admission passk --k 8 --case-set trivial-pass
# expect: pass^8 = 1.0
openclaw workspace admission passk --k 8 --case-set flaky-half
# expect: pass^8 near 0.0 (half the trials flip per case)
```

---

## A2 — Trajectory-Aware Triage V2

### A2.1 Shadow mode integrity

```bash
OPENCLAW_TRAJECTORY_MODE=shadow openclaw workspace triage simulate \
  --observation "deploy pipeline failing again on amf_pipeline"
# expect: audit row with rawPriority AND scaledPriority, downstream uses rawPriority
```

### A2.2 Quadrant coverage

```bash
openclaw workspace trajectory report --window 30d --from fixtures/smoke/episodic-seed.jsonl
# expect: all four quadrants represented (pos_pos, pos_neg, neg_pos, neg_neg) with row counts
```

### A2.3 Live-mode equality at quadrant=neutral

```bash
OPENCLAW_TRAJECTORY_MODE=live openclaw workspace triage simulate \
  --observation "neutral observation no domain match"
# expect: scaledPriority === rawPriority when no recommendedDomains
```

---

## B1 — Bitemporal Knowledge

### B1.1 Reconfirmation path

```bash
openclaw workspace knowledge upsert stack node "22.3.0"
openclaw workspace knowledge upsert stack node "22.3.0"   # identical
openclaw workspace knowledge history stack.node
# expect: ONE envelope, reconfirmations array size 1
```

### B1.2 Supersession path

```bash
openclaw workspace knowledge upsert stack node "22.4.0"   # different value
openclaw workspace knowledge history stack.node
# expect: TWO envelopes; first has valid_to set, second has valid_to=null
```

### B1.3 Invalidation without successor

```bash
openclaw workspace knowledge invalidate stack node --reason "removed node from stack"
# Verify via current-facts view (flat file retains the value as historical; current view filters it):
openclaw workspace knowledge get --view current stack.node
# expect: exit 1, "not currently valid"
openclaw workspace knowledge history stack.node
# expect: retired envelope with valid_to set and invalidation_reason="removed node from stack"
openclaw workspace knowledge asof "$(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ)"
# expect: stack.node present (one hour ago, before invalidation)
```

### B1.4 Invariant violation recovery

```bash
# Deliberately break the file with two valid_to=null envelopes using node (repo is TS/Node)
node -e '
  const fs = require("fs");
  const p = process.env.WS + "/KNOWLEDGE.json";
  const d = JSON.parse(fs.readFileSync(p, "utf8"));
  d._temporal["stack.node"][0].valid_to = null;  // breaks invariant (two null-valid_to)
  fs.writeFileSync(p, JSON.stringify(d, null, 2));
'
openclaw workspace knowledge upsert stack node "22.5.0"
# expect: snapshot restored, error printed, no change to stack.node
```

---

## B2 — Archivist CRUD Classifier

### B2.1 Four-action coverage on synthetic events

```bash
openclaw workspace archivist run --dry \
  --from fixtures/smoke/episodic-seed.jsonl \
  --expect-actions "ADD>=1,UPDATE>=1,DELETE>=1,NOOP>=1"
# expect: actionCounts hits all four bounds
```

### B2.2 UPDATE rejection on stale previousValue

```bash
openclaw workspace archivist inject-pattern \
  --action UPDATE --section stack --key node \
  --value "99.9.9" --previous-value "stale"
# expect: rejected with rejectedReason=stale_previous_value; no write
```

### B2.3 NOOP ratio warning

```bash
for i in 1 2 3; do
  openclaw workspace archivist run --from fixtures/smoke/noop-heavy.jsonl
done
openclaw workspace health
# expect: criticalFailure severity=warning with reason noopRatio>0.7
```

---

## B3 — Beliefs Tier

### B3.1 Form-reinforce-promote flow

```bash
openclaw workspace beliefs form --id pref_delegation --claim "prefers delegation on infra" --confidence 0.4 --domain infrastructure
for i in 1 2 3 4; do
  openclaw workspace beliefs reinforce pref_delegation --evidence "episodic-$i" --weight 0.15
done
openclaw workspace beliefs show pref_delegation
# expect: confidence ~0.85, 4 evidence rows
openclaw workspace beliefs promote pref_delegation
# expect: PolicyProposal emitted, gate passed, KNOWLEDGE.json.preferences.prefers_delegation_over_diy=true
```

### B3.2 Demotion via contradicting evidence

```bash
openclaw workspace beliefs contradict pref_delegation --evidence "user said no delegation please" --weight 0.5
openclaw workspace beliefs show pref_delegation
# expect: confidence drops toward 0.3-0.4, contradicting_evidence populated
```

### B3.3 Retirement

```bash
openclaw workspace beliefs retire pref_delegation --reason "resolved via user statement"
openclaw workspace beliefs list
# expect: pref_delegation NOT in active list; _belief_log entry present
```

---

## C1 — Error Taxonomy

### C1.1 Axis coverage on labeled fixtures

```bash
openclaw workspace errors classify fixtures/smoke/axis-fixtures.json --report
# expect: confusion matrix ≥ 70% correct per axis; any axis < 50% fails probe
```

### C1.2 Axis-prior priming affects triage

```bash
# Seed 15 planning failures in amf_pipeline
openclaw workspace errors seed --axis planning --domain amf_pipeline --count 15
openclaw workspace triage simulate --observation "amf_pipeline question" --dry
# expect: strategy archetype count expanded to 3-5 (from default 2-4) per C5 rule
```

### C1.3 LanceDB schema migration

```bash
openclaw workspace migrate --dry   # should detect errorTags column missing
openclaw workspace migrate          # applies migration
openclaw workspace errors stats     # should work — no crash on old rows
```

---

## C2 — pass^k Acceptance Gate

### C2.1 soul_md_edit blocked on gate fail

Precondition: `pre_config_write` plugin hook is available (Path A of C2-C2). Without Path A, raw `echo >>` bypasses the gate — this probe passes only via the CLI wrapper.

```bash
# Preferred: CLI-wrapped (always gated)
openclaw workspace soul edit --content "test rule — break everything"
# expect: rejected, admit=false, pre-edit SOUL.md unchanged
# Path A only (raw write intercept):
if openclaw plugin-api has-hook pre_config_write; then
  echo "test rule — break everything" >> ~/.openclaw/workspace/SOUL.md
  # expect: snapshot restored within 1s, pre-edit SOUL.md unchanged
fi
openclaw workspace gate history --kind soul_md_edit --failing
# expect: latest row has admit=false, reason non-empty
```

### C2.2 Emergency override path

```bash
openclaw workspace soul edit --force --reason "live incident 2026-04-18" --approver mpeter88 \
  --content "new rule X"
# expect: edit applies, gate-history row has override=true, reminder proposal created
openclaw workspace proposals list --pending | grep "Re-gate soul_md_edit"
# expect: present
```

### C2.3 Override not available for gated kinds

```bash
openclaw workspace council mode --force --reason "skip" set system1
# expect: rejected with "override not allowed for council_mode"
```

---

## D1 — Council Adversarial Discipline

### D1.1 Position-anchor flip detection

```bash
openclaw workspace council simulate --members fixtures/smoke/members-agreeable.json
# expect: chairTrace.flipped=false, chairTrace.flip_evidence empty, no anchor_fallback
openclaw workspace council simulate --members fixtures/smoke/members-contradictory.json
# expect: chairTrace.flipped=true, flip_evidence contains specific member role
```

### D1.2 Low-disagreement detection

```bash
openclaw workspace council simulate --members fixtures/smoke/members-identical.json
# expect: disagreement.score < 0.15, council_trace.low_disagreement=true, criticalFailure warning
```

### D1.3 Jury activation

```bash
openclaw workspace council simulate --priority 9 --disagreement-score 0.7 --members fixtures/smoke/members-split.json
# expect: jury.individualVotes has 3 entries, verdict populated
openclaw workspace council simulate --priority 6 --disagreement-score 0.3
# expect: jury=undefined — thresholds not met
```

---

## D2 — Council KS Stopping

### D2.1 Early-consensus shortcut

```bash
openclaw workspace council sampling simulate --consensus all-same --min-samples 3
# expect: stabilizedAt=3, winnerShare=1.0, sampleCount=3
```

### D2.2 Split-verdict forced stop

```bash
openclaw workspace council sampling simulate --distribution "0.45/0.45/0.1" --max-samples 9
# expect: forcedStop=true, dissent=true, winnerShare < 0.6
```

### D2.3 KS trajectory convergence

```bash
openclaw workspace council sampling simulate --distribution "0.7/0.2/0.1" --ks-threshold 0.15
# expect: ksTrajectory ends below threshold, stabilizedAt ≤ 6
```

### D2.4 Budget cap

```bash
OPENCLAW_CHAIR_DAILY_BUDGET=2 openclaw workspace council simulate --iterations 5
# expect: first 2 iterations use adaptive sampling; remaining 3 single-sample with warning log
```

---

## E — Skills and Hooks

### E.1 Skill activation in matching cwd

```bash
cd ~/Projects/src/openclaw/docs
claude -p "what are the Mintlify linking rules?"
# expect: response references openclaw-docs-mintlify skill content
# tail ~/.claude/logs/skill-activation.jsonl — latest row shows openclaw-docs-mintlify
```

### E.2 UserPromptSubmit injection gated by cwd

```bash
cd ~/Projects/src/openclaw && claude -p "quick status check"
# expect: session receives <openclaw-ambient> block
cd /tmp && claude -p "same prompt elsewhere"
# expect: no <openclaw-ambient> block injected
```

### E.3 Stop hook memory capture dry-run

```bash
OPENCLAW_MEMORY_CAPTURE_DRY=1 claude -p "session where user corrects assistant"
# <simulate correction turn>
# expect: dry-run log shows candidate capture, no write to MEMORY.md
```

### E.4 /commit skill blocks on pnpm check failure

```bash
cd ~/Projects/src/openclaw
# intentionally introduce a typescript error
sed -i 's/const /cnst /' src/commands/send.ts
claude -p "/commit"
# expect: hook blocks commit; error from pnpm check printed
git checkout src/commands/send.ts
```

### E.5 CLAUDE.md size after slim-down

```bash
wc -l ~/Projects/src/openclaw/CLAUDE.md
# expect: ≤200 lines after full rollout
```

---

## Cross-Cutting Smoke — End-to-End OODA Turn

### X.1 Priority-8 full-chain run with capture

```bash
openclaw workspace smoke e2e --priority 8 --domain amf_pipeline \
  --observation "parity regressed to 62 after schema change" \
  --expect "sitrep.priority>=8, strategy.winner, council_trace.members>=3, adaptiveChair.sampleCount>=3, ExpectedOutcome present, errorTags=[] (no failure yet)"
```

### X.2 Degradation path — LanceDB missing

```bash
mv ~/.openclaw/workspace/lancedb ~/.openclaw/workspace/lancedb.backup
openclaw workspace smoke e2e --priority 6 --observation "anything"
mv ~/.openclaw/workspace/lancedb.backup ~/.openclaw/workspace/lancedb
# expect: triage runs with empty trajectories, archivist skips with warning, no crash
```

### X.3 Archivist + Meta-Reviewer + Gate round-trip

```bash
openclaw workspace smoke full-loop \
  --seed fixtures/smoke/episodic-seed.jsonl \
  --force-archivist --force-meta-reviewer
# expect:
#   - Archivist produces >=5 patterns across ADD/UPDATE/DELETE/NOOP
#   - Meta-Reviewer emits >=1 PolicyProposal
#   - Proposal flows through pass^k gate
#   - If admit: KNOWLEDGE.json or PRIORITIES.json snapshot recorded, change applied
#   - If not admit: proposal transitions to status=rejected with rejectionReason
```

### X.4 Distortion alert on synthetic drift

```bash
openclaw workspace smoke distortion-drift --inject-synthetic-campbell --domain testing
# expect:
#   - Distortion regime transitions healthy -> campbell_suspected within 3 archivist runs
#   - criticalFailure event on gateway bus
#   - Any pending weight proposal for testing domain auto-rejected
```

---

## Harness Stubs Needed

Before any probe runs green, these CLI stubs must exist (implementation tracked in each corresponding CR):

- `openclaw workspace admission {capture,list,replay,passk}` — A1
- `openclaw workspace distortion` — A1
- `openclaw workspace trajectory {report,calibrate}` — A2
- `openclaw workspace knowledge {upsert,invalidate,history,asof}` — B1
- `openclaw workspace archivist {run,inject-pattern}` — B2
- `openclaw workspace beliefs {list,show,form,reinforce,contradict,retire,promote}` — B3
- `openclaw workspace errors {classify,seed,stats,recent}` — C1
- `openclaw workspace gate {status,run,history}` — C2
- `openclaw workspace soul edit` — C2
- `openclaw workspace council {simulate,sampling,mode}` — D1/D2
- `openclaw workspace smoke {e2e,full-loop,distortion-drift}` — cross-cutting

Each CLI stub ships in the CR that introduces the feature. Smoke tests stay failing until the stub and the underlying code land together.

---

## Runner

Single entry point: `scripts/smoke/run-ooda-batch.sh` runs all probes in order, short-circuits on first failure, and emits a `smoke-report.json` with per-probe result + timing. CI wire-up in a follow-up PR once probes stabilize.
