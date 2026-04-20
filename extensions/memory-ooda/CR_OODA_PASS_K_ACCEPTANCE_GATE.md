# CR: OODA pass^k Acceptance Gate — Enforcement Surface Beyond PolicyProposals

**Date:** 2026-04-18
**Status:** WRITTEN
**Priority:** HIGH — locks the pass^k discipline across every change surface, not just PolicyProposal admission
**Depends on:** `CR_OODA_GROUNDED_EVAL_HARNESS_V2.md` (Batch A1) — defines `pass-k.ts` and the admission corpus.
**Sources:**

- τ-bench, Yao et al. 2024 (arxiv 2406.12045) — pass^k definition (fraction of cases passing on ALL k trials).
- τ²-Bench, Barres et al. 2025 (arxiv 2506.07982) — dual-control extension.
- Sierra engineering blog, 2025 — pass^k as the reliability metric that kills pass@1 for agentic tasks.

---

## Current State and Scope Note

Batch A1's Grounded Eval Harness V2 introduces:

- `pass-k.ts` module with `runPassK(cases, runnable, config)`
- `admission-gate.ts` calling pass^k on proposal admission
- `PRIORITIES.json.thresholds.passk_admission_floor` config

A1 covers the **mechanism** and applies it to `PolicyProposal` admission. This CR covers the **enforcement surface** — every other change path that currently bypasses reliability gating:

1. Changes to `SOUL.md` content (user-edited).
2. Promotion of a Belief to a KNOWLEDGE.json fact (Batch B3 flow).
3. Archivist prompt changes (code-level, not config-level).
4. Council mode toggles (none/system1/system2).
5. Trajectory scale factor calibrations (Batch A2's `calibrate` CLI).
6. Strategy archetype additions or weight-rubric changes.

Without this CR, those paths can still change operational behavior without demonstrating reliability. The A1 admission gate only catches the subset that happens to flow through `addProposal`.

---

## Design

### C1 — ChangeKind Registry

New module `extensions/memory-ooda/change-gate.ts`:

```typescript
export type ChangeKind =
  | "policy_proposal" // already handled by A1's admission-gate
  | "soul_md_edit" // user edits to SOUL.md
  | "knowledge_edit" // direct user edits to KNOWLEDGE.json (outside Archivist)
  | "belief_promotion" // B3 — promoting belief to fact
  | "archivist_prompt" // code-level change to buildArchivistPrompt
  | "council_mode" // flipping system1/system2/none
  | "trajectory_calibration"
  | "archetype_change"
  | "rubric_change";

export interface ChangeRequest {
  kind: ChangeKind;
  id: string; // stable identifier for this change
  summary: string; // one-line
  diff: string; // textual diff of what will change
  initiator: "user" | "meta_reviewer" | "archivist" | "ci";
  /** Allow this CR to skip gating in emergencies. Logs loudly. */
  skipPassK?: { reason: string; approver: string };
}

export interface GateOutcome {
  admit: boolean;
  reason: string;
  passK?: PassKResult;
  ranCases: number;
  duration_ms: number;
}

export async function runChangeGate(
  req: ChangeRequest,
  cases: AdmissionCase[],
  runnable: AdmissionRunnable,
  config: ChangeGateConfig,
): Promise<GateOutcome>;
```

`change-gate.ts` is the single choke point every admissibility path flows through. It wraps A1's `runPassK` with per-ChangeKind policy:

| ChangeKind               | Default pass^k floor | Default k | Skippable with justification  |
| ------------------------ | -------------------- | --------- | ----------------------------- |
| `policy_proposal`        | 0.60 (from A1)       | 8         | No                            |
| `soul_md_edit`           | 0.70                 | 8         | Yes (user emergency override) |
| `belief_promotion`       | 0.60                 | 4         | No                            |
| `archivist_prompt`       | 0.70                 | 8         | Yes (CI: with test addition)  |
| `council_mode`           | 0.50                 | 4         | No                            |
| `trajectory_calibration` | 0.60                 | 8         | No                            |
| `archetype_change`       | 0.60                 | 4         | No                            |
| `rubric_change`          | 0.70                 | 8         | No                            |

Floors are seeded in `PRIORITIES.json.thresholds.passk_by_kind` and operator-tunable.

### C2 — Enforcement Points

Each of the following code paths calls `runChangeGate` before committing:

**`soul_md_edit`** — Hook on `extensions/memory-ooda/` that watches for SOUL.md modifications. When a write is detected:

1. Snapshot pre-edit SOUL.md.
2. Assemble a ChangeRequest with the diff.
3. Run the gate.
4. If `admit=false`, restore from snapshot; print the failing cases and require `--force --reason "..."` to retry.

Implementation detail (implementation-blocking prerequisite): this hook requires a `pre_config_write` (or equivalent) plugin lifecycle event. As of 2026-04-18 a grep of `packages/plugin-sdk/` does not find such a hook. Implementation step 1 is to verify the plugin API surface — if the hook does not exist, one of two paths:

- **Path A (preferred):** add `pre_config_write` to the plugin-sdk and wire it in the gateway config-write paths. Scope: contained SDK extension.
- **Path B (fallback):** raw `$EDITOR` writes to SOUL.md cannot be gated. In this mode, `soul_md_edit` enforcement is advisory only — a post-write audit detects drift and emits a `PolicyProposal` of category `policy` with `confidence: 1.0` demanding re-gating. The CLI wrapper `openclaw workspace soul edit` is the only fully-gated path; raw edits are logged but not blocked.

The CR proceeds assuming Path A is available. If Path B is forced, enforcement posture for `soul_md_edit` explicitly weakens — document loudly.

**`belief_promotion`** (Batch B3) — The `promoteBelief()` function calls the gate directly before invoking `upsertFact`.

**`archivist_prompt`** — Tests in CI. A new `pnpm test:archivist:prompt-regression` task re-runs the admission corpus against the current `buildArchivistPrompt` output. Any prompt change in a PR that fails this test blocks merge. Failure message links to the failing cases.

**`council_mode`** — Gate wraps the PRIORITIES.json config write that flips `council_*_enabled` fields. Prior defaults used `user_signal`-only approval; now gated.

**`trajectory_calibration`** — Batch A2's `calibrate` CLI emits a PolicyProposal which flows through A1's admission gate. Additionally, running `calibrate` in dry-run mode must still execute pass^k against the proposed factors before emitting the proposal.

**`archetype_change` / `rubric_change`** — Gate wraps edits to PRIORITIES.json `strategy_labels` and `scoring_rubric`.

### C3 — CLI and Observability

- `openclaw workspace gate status` — prints current floors per ChangeKind, last pass^k run time, last result.
- `openclaw workspace gate run --kind <kind> --change <id>` — manual invocation (dev / CI).
- `openclaw workspace gate history [--failing] [--kind X]` — rolling log of gate outcomes.

All gate outcomes write to `~/.openclaw/workspace/.gate-history.jsonl` (append-only, one row per gate invocation).

### C4 — Regression CI Integration

Root `package.json` gains:

```json
{
  "scripts": {
    "test:gate:archivist": "openclaw workspace gate run --kind archivist_prompt --change current",
    "test:gate:all": "openclaw workspace gate run --kind all --change current"
  }
}
```

GitHub Actions: a new workflow `.github/workflows/ooda-gate.yml` runs `test:gate:archivist` on every PR that touches `extensions/memory-ooda/archivist.ts` or `extensions/memory-ooda/triage.ts`. Fails the check on `admit=false`.

### C5 — Emergency Override

For `soul_md_edit` and `archivist_prompt`, the gate allows explicit override:

```bash
openclaw workspace soul edit --force --reason "fixing live incident; will re-gate within 24h" --approver mpeter88
```

Override requirements:

- Non-empty `reason`.
- `approver` matches an allowlist in PRIORITIES.json (`thresholds.override_approvers: string[]`).
- Override is logged to `.gate-history.jsonl` with `override: true`.
- A reminder proposal is auto-created: "Re-gate soul_md_edit from 2026-04-18 within 24h" with `category: "policy"`, `confidence: 1.0`, auto-escalating severity every day it goes unresolved.

Override is never available for `policy_proposal`, `belief_promotion`, `council_mode`, `trajectory_calibration`, `archetype_change`, or `rubric_change` — those must pass the gate.

### C6 — Interaction with Other CRs

- **A1:** calls `runChangeGate(kind: "policy_proposal", ...)` internally instead of calling `runPassK` directly. A1's admission-gate becomes a thin wrapper around `runChangeGate`.
- **A2:** calibration flow rewired.
- **B1:** belief promotions use the gate. KNOWLEDGE.json direct user edits also gated (treated as `soul_md_edit`-class under a new `knowledge_edit` kind, same floors).
- **B3:** Beliefs promotion path invokes the gate.
- **C1 (error taxonomy):** gate failures emit ErrorTags with `axis: "planning"` (the proposed change was a wrong plan) or `"reflection"` (the agent misjudged its own reliability).
- **D1/D2:** council mode toggles gated.

---

## Acceptance Criteria

- [ ] `change-gate.ts` module with `runChangeGate`, `ChangeKind`, `ChangeRequest`, `GateOutcome`.
- [ ] Per-ChangeKind floors in `PRIORITIES.json.thresholds.passk_by_kind`.
- [ ] Each of the seven enforcement points hooked up and tested.
- [ ] CLI commands present.
- [ ] CI workflow `ooda-gate.yml` green on main.
- [ ] Emergency override documented, rate-limited (max 3 overrides per 7-day window per approver), and audited in `.gate-history.jsonl`.
- [ ] Existing tests unaffected — gate is additive for change paths, not runtime-path.

---

## Risk and Open Questions

1. **Gate-the-gate problem.** Changing the gate's own floors is a `rubric_change` — gated. This prevents unilateral weakening. Initial floors require user approval via the existing PolicyProposal flow (which is gated, etc.). Recursion terminates at operator approval + CI on the first commit establishing the floors.
2. **Flaky corpus.** If admission cases become unreliable (e.g., external API changed), the gate rejects legitimate changes. Mitigation: `openclaw workspace admission health` runs the corpus against the **current** config (no change proposed) and flags cases failing at baseline.
3. **Cost.** pass^8 × 20 cases × 8 enforcement points per week could be 1280 LLM calls. Gate is opt-in by `ChangeKind` and budget-aware. Track and surface weekly cost in `gate status`.
4. **Developer friction.** Prompt changes now block merge on gate failure. Mitigation: the gate's failing-case reports are concrete ("Case `sitrep_amf_regression_2026_03_12` now produces priority 4; prior 7"). Developers fix the prompt or update the case fixture deliberately.
5. **Bootstrap.** Fresh workspace has no cases. Gate falls open with `admit=true, reason: "no_corpus_bootstrap"` for the first 14 days or until ≥5 cases exist, whichever is later. Matches A1's fallback.
6. **Arxiv ID.** 2506.07982 confirmed — τ²-bench (Barres et al. 2025). pass^k formalism cites τ-bench original (2406.12045, Yao et al. 2024). Both should be cited in any public writing.
