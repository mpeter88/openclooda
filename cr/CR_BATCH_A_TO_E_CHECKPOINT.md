# Batch A–E Checkpoint — 2026-04-19

Snapshot of state after landing CR batches A–E. For next session pickup.

---

## Status: all 12 phases shipped, 274/274 tests green

```bash
cd ~/Projects/src/openclooda && ./scripts/smoke/run-ooda-batch.sh
# 13 suites, 274 tests, ~3.3s
```

## What landed (files)

### CR specs (verified + edited for cold-read audit)

Under `extensions/memory-ooda/`:

- `CR_OODA_GROUNDED_EVAL_HARNESS_V2.md` (A1)
- `CR_OODA_TRAJECTORY_AWARE_TRIAGE_V2.md` (A2)
- `CR_OODA_BITEMPORAL_KNOWLEDGE.md` (B1)
- `CR_OODA_ARCHIVIST_CRUD_CLASSIFIER.md` (B2)
- `CR_OODA_BELIEFS_TIER.md` (B3)
- `CR_OODA_ERROR_TAXONOMY.md` (C1)
- `CR_OODA_PASS_K_ACCEPTANCE_GATE.md` (C2)
- `CR_OODA_COUNCIL_ADVERSARIAL_DISCIPLINE.md` (D1)
- `CR_OODA_COUNCIL_KS_STOPPING.md` (D2)

Under `cr/`:

- `CR_OPENCLAW_SKILLS_CONTEXT_HYGIENE.md` (E)
- `CR_BATCH_A_TO_E_SMOKE_TESTS.md`
- `CR_BATCH_A_TO_E_CHECKPOINT.md` (this doc)

### Implementation — modules + tests

Under `extensions/memory-ooda/`:

- `types.ts` (extended — 18 new interfaces, threshold keys)
- `semantic-memory.ts` (+bitemporal) + `bitemporal.test.ts` (15)
- `archivist.ts` (+CRUD dispatch, actionCounts, deleteFact/invalidateFact in SemanticStore)
- `crud-classifier.test.ts` (10)
- `beliefs.ts` + `beliefs.test.ts` (13)
- `triage.ts` (+resolveTrajectoryMode, classifyQuadrant, rawPriority always-set contract)
- `trajectory-audit.ts` + `trajectory-audit.test.ts` (15)
- `pass-k.ts`
- `admission-gate.ts`
- `distortion-index.ts`
- `grounded-harness.test.ts` (14)
- `error-classifier.ts` + `error-classifier.test.ts` (15)
- `change-gate.ts` + `change-gate.test.ts` (11)
- `council.ts` (exported `ChairParsed`)
- `council-discipline.ts` + `council-discipline.test.ts` (14)
- `adaptive-chair.ts` + `adaptive-chair.test.ts` (13)
- `fixtures/smoke/README.md`

Under `scripts/`:

- `scripts/smoke/run-ooda-batch.sh`
- `scripts/install-claude-extras.sh`

Under `tools/claude/`:

- `skills/openclaw-status-live/SKILL.md`
- `skills/openclooda-memory-health/SKILL.md`
- `skills/openclaw-docs-mintlify/SKILL.md`
- `skills/openclaw-release/SKILL.md`
- `hooks/openclaw-status-inject.sh`
- `hooks/openclaw-memory-capture.sh`
- `settings/settings.fragment.json`

### Installed (to user's home — done this session)

- `~/.claude/skills/` — 4 skills (via `scripts/install-claude-extras.sh`)
- `~/.claude/hooks/` — 2 hook scripts (mode 700)

---

## What's NOT yet done — pickup list

### 1. Merge settings.json fragment (hooks won't fire without this)

Source: `~/Projects/src/openclooda/tools/claude/settings/settings.fragment.json`
Target: `~/.claude/settings.json`

The fragment defines `UserPromptSubmit` (ambient status inject) + `Stop`
(memory-capture dry-run by default) hooks pointing to scripts already installed.

Action: diff current `~/.claude/settings.json` against fragment, append hooks
arrays (preserving existing hooks). Use `update-config` skill.

### 2. Integration wiring (modules exist, not yet called from the hot paths)

- **`runArchivist` in `archivist.ts:runArchivist`:**
  - Call `computeDistortion(appendDistortionSample(...))` after outcome aggregation — so distortion history gets populated every archivist run.
  - Emit `criticalFailure` event on `campbell_suspected` regime.
  - Call `aggregateAxisPriors` and feed priors to next turn via a shared state file or in-memory cache.

- **`index.ts` `before_agent_start` hook:**
  - Call `resolveTrajectoryMode` + `classifyQuadrant` + `appendTrajectoryAudit` after the triage call.
  - If `mode !== "live"`, downstream uses `rawSITREP.sitrep` not `scaled`.
  - Inject `formatBeliefsForContext(getActiveBeliefs(...))` after KNOWLEDGE.json injection.

- **`runCouncil` in `council.ts`:**
  - system2: add chair pre-read (`buildChairPreReadPrompt` + `parseChairPrior`) before the parallel member pass.
  - After chair parse, run `computeDisagreement` on member outputs; populate `CouncilTrace.disagreement` + `low_disagreement`.
  - If `priority >= jury_floor && disagreement >= jury_floor`, call `runJury`; attach to trace.
  - Optionally replace single chair call with `runAdaptiveChair` when `sitrep.priority >= council_adaptive_chair_priority_floor`.

- **Meta-reviewer:**
  - Before emitting `PolicyProposal`, run `runChangeGate({kind:"policy_proposal", ...})`. If `admit=false`, auto-reject with `rejectionReason`.
  - Attach `AdmissionReport` to the proposal.

- **Episodic failure → error classifier:**
  - In `agent_end` hook, when `outcome !== "success"`, enqueue `classifyError(event, context, callModel)` and persist resulting `ErrorTag[]` on the episodic event.

### 3. `pre_config_write` plugin hook (C2 blocker)

Unverified that `packages/plugin-sdk` exposes a `pre_config_write` event.
Grep came back empty. Decide Path A (add the hook) or Path B (CLI-wrapper-only, no raw-edit gating).

### 4. CLI stubs not shipped

The CRs reference many `openclaw workspace ...` subcommands:

- `admission {capture,list,replay,passk}`
- `distortion`
- `trajectory {report,calibrate}`
- `knowledge {upsert,invalidate,history,asof}`
- `beliefs {list,show,form,reinforce,contradict,retire,promote}`
- `errors {classify,seed,stats,recent}`
- `gate {status,run,history}`
- `council {simulate,sampling,mode}`
- `soul edit`

Each module has pure functions ready to wire to CLI — need cli.ts dispatch stubs. Left for next session.

### 5. Real admission corpus

`fixtures/smoke/` is empty (README only). Populate via `openclaw workspace admission capture <actionId>` on actual successful sessions once the CLI lands.

### 6. CLAUDE.md slim-down (E rollout Phase 3)

Do AFTER:

- Settings fragment merged (item 1)
- 14-day observation window on skill activation reliability (log `~/.claude/logs/skill-activation.jsonl`)
- Remaining scoped skills authored (E Phase 2)

Current `openclaw/CLAUDE.md` is ~750 lines. Target ≤200 after migration.

### 7. Two deferred CR ideas (from auditor's Du 2026 survey finding)

Not drafted — just filed:

- `CR_OODA_CAUSAL_RETRIEVAL` — retrieve episodic by "what caused this" not cosine.
- `CR_OODA_LEARNED_FORGETTING` — prune by usefulness signal, not age.

---

## Resume commands

```bash
# Verify baseline
cd ~/Projects/src/openclooda && ./scripts/smoke/run-ooda-batch.sh

# Re-run single phase
node_modules/.bin/vitest run --no-coverage extensions/memory-ooda/<phase>.test.ts

# Check what's uncommitted
cd ~/Projects/src/openclooda && git status
```

## Known issues / risks carried forward

1. **`applyTrajectoryScaling` contract change** — now always sets `rawPriority`. Any consumer that reads `rawPriority === undefined` as "no scaling applied" must switch to `rawPriority === priority`. Verified no current test assumes the old contract; verify integration sites.
2. **`PatternExtraction.action` defaults to `ADD`** — old model outputs without the field still work. But prompt now asks for action explicitly — model outputs with malformed action will parse-throw.
3. **Bitemporal migration is lazy.** First write per-key back-fills an envelope with `ingested_by: "migration"`. Pre-migration facts are not traceable to original events.
4. **`getFactsAsOf` v1 limitation** — returns current value for keys that were valid at the timestamp. Full value history requires storing value in envelope (out of scope v1; would increase disk by ~2x).
5. **Council integration not wired** — council-discipline + adaptive-chair are standalone. `runCouncil` still uses the pre-CR flow. Integration phase will edit `council.ts:runCouncil`.
