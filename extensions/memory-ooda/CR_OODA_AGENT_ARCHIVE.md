# CR_OODA_AGENT_ARCHIVE — Generation lineage for the plugin itself

Status: shipping
Target batch: H (foundation for research loop)
Estimated effort: 1 day
Depends on: none (uses existing content-hash + admission gate)

---

## Source

- Zhang et al. 2026, "HyperAgents" (arxiv 2603.19461). Per-generation `gen_{genid}/metadata.json` with `parent_genid`, `prev_patch_files`, `curr_patch_files`, `run_full_eval`, `valid_parent`. Archive as append-only jsonl ledger.
- Zhang et al. 2025, "Darwin Gödel Machine" (arxiv 2505.22954). Evolvable skeleton + empirical validation gate with archive of prior agents.

## Motivation

openclooda today has no lineage over itself. Every admission-gated change overwrites the previous plugin state in place. We can roll back a single file (`.snapshots/`), but we cannot:

- Ask "which plugin version produced this outcome?"
- Branch the plugin into experimental variants that run in parallel.
- Feed past generations as fixtures into the admission gate (DGM pattern).
- Trace a regression back to the specific CR that introduced it.
- Build the research loop (CR_OODA_RESEARCH_LOOP) — which needs an archive to descend experiments from.

This CR adds a per-generation ledger keyed by content-hash of the plugin source + workspace state at the moment a gate-admitted change lands.

## Design

### Generation unit

A "generation" is a point-in-time snapshot of:

1. The plugin source tree content-hash (sha256 over canonical file order).
2. The KNOWLEDGE.json + BELIEFS.json + PRIORITIES.json hashes (already present via CR Path C).
3. The admission-gate outcome that admitted this change.
4. The per-domain scores (when a grounded-eval harness has run).

Stored as append-only `.agent-archive.jsonl` in the workspace, one row per generation.

### Row shape

```ts
export interface GenerationRow {
  genid: string; // content-hash prefix, 12 hex chars
  parent_genid: string | "initial";
  created_at: string; // ISO
  plugin_source_hash: string; // sha256 of plugin source files
  workspace_hashes: {
    // from CR Path C content-hash fields
    knowledge: string | null;
    beliefs: string | null;
    priorities: string | null;
  };
  admission: {
    gate_id: string; // matches GateHistoryRow.changeId
    kind: ChangeKind;
    reason: string;
  };
  scores: Partial<Record<string, number>>; // per-domain, populated when eval runs
  run_full_eval: boolean; // mirrors HyperAgents flag
  valid_parent: boolean; // eligible for spawning children
  experiment_id?: string; // present when spawned via research loop
  lineage_depth: number; // distance from "initial"
  summary?: string; // one-line description for `workspace archive list`
}
```

### Initial generation

On first gateway boot after this CR lands, archive is empty. First admission-gated change creates `genid="initial"` or `genid=<content-hash>` with `parent_genid="initial"`. No real diff — just a bookmark.

### Append path

Hook into the existing `runChangeGate` return:

- On `admit=true`, compute current `plugin_source_hash` + workspace hashes.
- Resolve `parent_genid` from the last entry in `.agent-archive.jsonl` (monotone chain).
- Append new row.
- Do NOT write on `admit=false` — rejected changes don't enter lineage.

### Read path

```ts
function readArchive(workspacePath: string): GenerationRow[];
function latestGenid(workspacePath: string): string | null;
function findParent(workspacePath: string, genid: string): GenerationRow | null;
function lineageTo(workspacePath: string, genid: string): GenerationRow[];
function childrenOf(workspacePath: string, genid: string): GenerationRow[];
```

Pure reads — no mutation, no LLM calls. O(n) in archive length; archive is bounded by admission-gate frequency (tens of rows/day max).

### Score attachment

When `CR_OODA_LEARNED_FORGETTING`'s axis priors or distortion samples compute a domain score, back-fill it into the row for the current genid. Write path: `updateGenerationScore(genid, domain, score)`.

When not yet computed, score is absent — reader treats as "not evaluated." Matches HyperAgents' `stagedeval_frac` discipline: scores are always optional.

### Lineage enforcement

`valid_parent=false` is set when:

- Score regressed past `valid_parent_regression_floor` (default: -0.2 on any prior-success domain).
- Critical-failure event landed in the archivist window attributed to this generation.
- User explicitly marked invalid via CLI.

Children of invalid parents remain allowed — this is a soft signal for future parent-selection, not a hard prune (matches HyperAgents' random-with-filter approach).

### CLI

```
openclaw workspace archive list [--limit N] [--invalid-only] [--json]
openclaw workspace archive show <genid>
openclaw workspace archive lineage <genid>    # path back to initial
openclaw workspace archive children <genid>
openclaw workspace archive mark-invalid <genid> <reason>
```

## Schema additions

None on existing files (KNOWLEDGE/BELIEFS/PRIORITIES). One new file: `.agent-archive.jsonl`. Additive; pre-CR workspaces see empty archive.

## Integration points

1. New file `extensions/memory-ooda/agent-archive.ts` — pure read/write + types.
2. `extensions/memory-ooda/change-gate.ts` — after `appendGateHistory` on admit, hook archive append. Guard behind optional `archive?: { workspacePath }` config so tests stay orthogonal.
3. `extensions/memory-ooda/cli.ts` — register `workspace archive …` command group.
4. `extensions/memory-ooda/learned-forgetting.ts` — score-regression classifier extended to flag `valid_parent=false` when it fires.

## Testability

Unit tests:

- Empty archive → `latestGenid=null`, `childrenOf(anything)=[]`.
- Append → read round-trip; `lineage_depth` increments.
- `parent_genid` of new row = previous row's genid.
- `valid_parent=false` propagates into CLI filter.
- Score back-fill mutates existing row without disturbing ordering.

Integration test: tmp workspace → run 5 `runChangeGate(admit=true)` → assert 5 rows in archive, each linking to previous.

## Success metrics

- Archive append is idempotent on replay of gate-history.jsonl (for reconstruction after workspace loss).
- No measurable impact on `runChangeGate` p95 latency (<1ms append cost at up to 10k rows).
- `workspace archive lineage <latest>` produces a readable path on a real populated workspace within 30 days of CR landing.

## Out of scope

- Snapshotting the plugin source tree into `.agent-archive/{genid}/src/` (that's the storage side of CR_OODA_RESEARCH_LOOP).
- Selecting parents from the archive for experimentation (research loop).
- Cross-workspace archives.
- Archive compaction / prune policy (learned-forgetting-style signals could feed here later).
