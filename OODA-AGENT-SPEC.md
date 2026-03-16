# Cognitive OODA Agent — Implementation Specification

> Transforms OpenClaw's flat Observe-Plan-Act agent loop into a stateful,
> goal-oriented OODA (Observe-Orient-Decide-Act) system with self-correcting
> learning and persistent memory.

**Status:** Draft v2
**Date:** 2026-03-16
**Storage decision:** LanceDB (already integrated via `extensions/memory-lancedb`)
**Rollback strategy:** Timestamped file snapshots
**Outcome detection:** Typed union — tool results + user signals only (v1)

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Tri-Tier Memory Stack](#2-tri-tier-memory-stack)
3. [Multi-Model Reasoning Chain (OODA Loop)](#3-multi-model-reasoning-chain-ooda-loop)
4. [Double-Loop Learning](#4-double-loop-learning)
5. [Objective Weighting / VALUATION_ENGINE](#5-objective-weighting--valuation_engine)
6. [Schema Definitions](#6-schema-definitions)
7. [Rollback and Safety](#7-rollback-and-safety)
8. [Code Locations](#8-code-locations)
9. [Implementation Phases and PR Sequence](#9-implementation-phases-and-pr-sequence)
10. [Open Questions](#10-open-questions)

---

## 1. Architecture Overview

The current OpenClaw agent executes a single LLM call per turn: observe input, plan
a response, act via tools. This spec introduces three structural changes:

1. **Layered memory** — three tiers of persistence so the agent has context beyond
   the current conversation window.
2. **Multi-model reasoning chain** — a cheap triage pass before the expensive
   reasoning model, with a structured decision matrix in between.
3. **Double-loop learning** — async processes that refine the agent's knowledge
   and decision weights over time based on observed outcomes.

The system re-evaluates its relationship with the world every time it wakes up,
rather than simply executing a heartbeat.

### Design Constraints

- **Zero infrastructure.** No sidecar processes, no Docker, no external servers.
  Everything runs inside the OpenClaw gateway process or as cron jobs on the
  existing scheduler.
- **Build on what exists.** LanceDB is already integrated as an embedded vector
  store via `extensions/memory-lancedb`. The embedding pipeline (OpenAI), lifecycle
  hooks (`before_agent_start`, `agent_end`), tools (`memory_recall`, `memory_store`,
  `memory_forget`), and CLI (`ltm`) are all working. Extend, don't replace.
- **Latency-aware.** The full OODA chain only fires when `thinkingLevel >= "medium"`.
  Simple conversational turns skip straight to the Executive.
- **Human-in-the-loop.** No autonomous policy changes. The Meta-Reviewer proposes;
  the user approves.

---

## 2. Tri-Tier Memory Stack

The memory stack provides the contextual gravity needed for the Orient phase of OODA.

### 2.1 Tier 1 — Working Memory (Short-term)

| Attribute     | Value                                     |
|---------------|-------------------------------------------|
| Storage       | RAM / in-context buffer                   |
| Lifetime      | Current session                           |
| Purpose       | Active attention — turn-by-turn state, entity extraction, tool output context |

This partially exists in the Pi agent's session model. The addition is **structured
entity extraction** on each turn to populate named slots (people, projects, dates,
decisions) that downstream tiers can reference.

### 2.2 Tier 2 — Episodic Memory (Long-term)

| Attribute     | Value                                     |
|---------------|-------------------------------------------|
| Storage       | LanceDB (existing `extensions/memory-lancedb`) |
| Lifetime      | Persistent across sessions                |
| Purpose       | Historical journal — events with semantic embeddings for similarity retrieval |

**Existing infrastructure (no changes needed):**
- `MemoryDB` class — vector store/search/delete with dedup detection
- `Embeddings` class — OpenAI embedding pipeline (configurable model + dimensions)
- `memory_recall` / `memory_store` / `memory_forget` tools
- `before_agent_start` hook — auto-recall relevant memories into context
- `agent_end` hook — auto-capture important info from user messages
- `ltm` CLI commands (list, search, stats)
- Prompt injection detection + HTML entity escaping

**Extensions needed for OODA:**

The existing `MemoryEntry` schema stores general memories. OODA needs richer
event metadata for the Archivist and Meta-Reviewer to consume:

```typescript
// Extend the existing MemoryEntry in extensions/memory-lancedb
interface OodaMemoryEntry extends MemoryEntry {
  source: string;              // "github" | "email" | "chat" | "tool_output" | "user"
  actionId?: string;           // links to ExpectedOutcome for outcome tracking
  expectedOutcome?: ExpectedOutcome;
  actualOutcome?: ActualOutcome;
  archivistProcessed: boolean; // has the Archivist distilled this event?
}
```

**Pruning:** Events older than 90 days with `archivistProcessed: true` are eligible
for pruning. The Archivist distills patterns into Tier 3 before they age out.
Implemented as a new method on the existing `MemoryDB` class.

### 2.3 Tier 3 — Semantic Memory (Permanent)

| Attribute     | Value                                     |
|---------------|-------------------------------------------|
| Storage       | `~/.openclaw/workspace/KNOWLEDGE.json`    |
| Lifetime      | Permanent (updated by Archivist only)     |
| Purpose       | Distilled truth — non-timestamped facts about the user and their world |

**API:**
```typescript
interface SemanticMemory {
  getFacts(): KnowledgeFile;
  upsertFact(section: string, key: string, value: unknown): void;
  snapshot(): string;  // returns path to backup file
}
```

The Executive model **never writes** to Tier 3 directly. Only the Archivist process
updates it, ensuring facts are distilled from repeated patterns rather than
single observations.

**Injection order in system prompt:**
1. `AGENTS.md` / `SOUL.md` / `TOOLS.md` (existing)
2. `KNOWLEDGE.json` facts (new — inserted after SOUL.md)
3. `PRIORITIES.json` domain weights (new — inserted after KNOWLEDGE)
4. Working Memory entity slots (new — appended to context)

---

## 3. Multi-Model Reasoning Chain (OODA Loop)

The single Pi agent RPC call splits into three sequential phases. The full chain
only fires when `thinkingLevel >= "medium"` AND the Triage priority score meets
the `min_priority_for_full_ooda` threshold. Otherwise, skip to Phase C.

### 3.1 Phase A — Triage (Observe and Orient)

| Attribute     | Value                                     |
|---------------|-------------------------------------------|
| Model         | Lightweight, high-context (Haiku / Gemini Flash) |
| Input         | New observation + Tier 3 facts            |
| Output        | SITREP object                             |

The Triage performs **salience detection**: does this new input actually matter
given what we know about the user's priorities and current state?

```typescript
interface SITREP {
  priority: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
  summary: string;
  conflictsDetected: string[];   // e.g. "new email contradicts Q2 deadline"
  relevantFacts: string[];       // keys from KNOWLEDGE.json used in reasoning
  recommendedDomains: string[];  // which PRIORITIES.json domains apply
}
```

**Prompt contract:** The Triage model receives a structured prompt containing:
- The raw observation (user message, webhook event, tool output)
- The full `KNOWLEDGE.json` facts section
- Current `PRIORITIES.json` domain weights
- Instruction to output valid JSON conforming to the SITREP interface

**Output format:** Strict JSON. The Triage prompt ends with a JSON schema
constraint. Malformed output triggers a retry (max 1) or falls through to the
Executive with a default priority-5 SITREP.

**Config:** `agents.defaults.triageModel` in `openclaw.json` controls which model
runs the Triage pass. Defaults to the cheapest available model.

### 3.2 Phase B — Strategy (The Decision Matrix)

This phase prevents the agent from jumping to the first logical plan. It generates
and scores multiple candidate strategies.

**Activity 1 — Hypothesis Generation:**
The agent generates 2-4 distinct strategies from the configured archetypes:

| Archetype              | Description                                           |
|------------------------|-------------------------------------------------------|
| `aggressive_fix`       | Act immediately with full effort and resources        |
| `delegate_task`        | Route to another person or agent; track to completion |
| `strategic_delay`      | Defer until a better moment; set reminder + context   |
| `minimal_viable_action`| Do the smallest thing that unblocks progress          |

The archetype list is extensible via `PRIORITIES.json`.

**Activity 2 — Multi-Variable Scoring:**
Each strategy is scored against three axes:

| Axis        | Weight | Description                                            |
|-------------|--------|--------------------------------------------------------|
| Alignment   | 0.40   | Match with SOUL.md and active domain goals             |
| Efficiency  | 0.35   | Token cost and time vs. expected value                 |
| Risk        | 0.25   | Potential for irreversible side-effects or missed commitments |

**Startup assertion:** Rubric weights must sum to 1.0. The VALUATION_ENGINE
asserts this on boot and refuses to start if violated.

**Activity 3 — Optimization:**
The VALUATION_ENGINE scores each strategy: `V = sum(Si * Wi)` where S is the
per-axis score and W is the domain weight from `PRIORITIES.json`. The highest-scoring
strategy wins.

```typescript
interface Strategy {
  label: string;           // archetype name
  reasoning: string;       // one-line rationale
  alignmentScore: number;  // 0.0 - 1.0
  efficiencyScore: number; // 0.0 - 1.0
  riskScore: number;       // 0.0 - 1.0 (higher = safer)
  weightedTotal: number;   // computed by VALUATION_ENGINE
}
```

### 3.3 Phase C — Executive (Decide and Act)

| Attribute     | Value                                     |
|---------------|-------------------------------------------|
| Model         | Large, reasoning-heavy (Claude Sonnet / Opus / GPT-4o) |
| Input         | SITREP + winning Strategy + original observation |
| Output        | Tool calls + ExpectedOutcome statement    |

The Executive receives the SITREP and winning strategy as structured context
prepended to its system prompt. It commits to the chosen strategy and generates
a linear action script.

**Critical addition:** The Executive emits an `ExpectedOutcome` with every action:

```typescript
interface ExpectedOutcome {
  actionId: string;
  description: string;     // "PR #1234 should merge successfully"
  successSignal: string;   // "tool gh_pr_merge returns 200"
  failureSignal: string;   // "tool returns 422 or user says 'no'"
  domain: string;          // which PRIORITIES.json domain this falls under
}
```

This is stored in the session metadata via the existing `sessions.patch` WS method
and consumed by the Meta-Reviewer for outcome tracking.

**Config:** `agents.defaults.model` in `openclaw.json` controls the Executive model
(existing config key, no change needed).

---

## 4. Double-Loop Learning

Standard agents have single-loop learning (try a different tool if one fails).
This architecture adds double-loop learning: the agent updates its own rules
and preferences based on outcomes.

Both learners run **async, outside the hot path** on the existing Gateway cron
and event infrastructure.

### 4.1 The Archivist (Semantic Refinement)

| Attribute     | Value                                     |
|---------------|-------------------------------------------|
| Trigger       | Every 100 turns (configurable via `thresholds.archivist_turn_interval`) |
| Input         | Tier 2 episodic events since last run     |
| Output        | Tier 3 fact upserts                       |

**Turn counter:** Stored in `~/.openclaw/workspace/.archivist-state.json`:
```json
{
  "last_run_turn": 0,
  "last_run_at": "2026-03-16T00:00:00Z"
}
```

On gateway restart, the counter persists. If the gateway crashed mid-Archivist-run,
the state file is not updated, so the next run will reprocess the same window.
This is safe because `upsertFact` is idempotent.

**Process:**
1. Query Tier 2 (LanceDB) for events since `last_run_turn`.
2. Run a summarization pass (using the Triage model) to extract stable patterns.
3. For each stable pattern, call `semanticMemory.upsertFact()`.
4. Mark processed events with `archivistProcessed: true` in LanceDB.
5. Append an entry to `_archivist_log` in `KNOWLEDGE.json` with the reason.
6. Update `.archivist-state.json`.

**Example:** If the Archivist sees that the user has ignored 15 emails about
"marketing" but immediately acted on 12 emails about "IEP Sensei Core" over the
last 100 turns, it upserts a preference fact reflecting this pattern.

**Safety:** The Archivist takes a snapshot of `KNOWLEDGE.json` before writing
(see [Rollback and Safety](#7-rollback-and-safety)).

### 4.2 The Meta-Reviewer (Structural Refinement)

| Attribute     | Value                                     |
|---------------|-------------------------------------------|
| Trigger       | (1) `criticalFailure` event, (2) weekly cron |
| Input         | ExpectedOutcome + ActualOutcome pairs     |
| Output        | Policy proposals + weight adjustments     |

#### Actual Outcome Detection

The spec uses a **typed union** with three sources, only two of which are active
in v1:

```typescript
type ActualOutcome =
  | { source: "tool_result"; success: boolean; toolName: string; summary: string }
  | { source: "user_signal"; signal: "approved" | "overridden" | "corrected"; context: string }
  | { source: "inferred"; confidence: number; reasoning: string };  // v2, gated off
```

**`tool_result`** (high confidence): Captured automatically from tool call responses.
A 200/success exit = success. A 4xx/5xx/exception = failure. Covers ~60-70% of
agent actions.

**`user_signal`** (high confidence): Captured when the user explicitly approves,
overrides, or corrects an agent decision. The existing approval/override flow in
the Strategy phase already produces these signals — they just need to be persisted.

**`inferred`** (low confidence, v2): Heuristic detection from follow-up turns.
Logged but **does not trigger weight changes** until confidence thresholds are
validated against real outcome data from the other two sources.

#### The `criticalFailure` Event

New event type on the Gateway event bus:

```typescript
interface CriticalFailureEvent {
  type: "criticalFailure";
  timestamp: string;
  actionId: string;           // links to ExpectedOutcome
  expectedOutcome: ExpectedOutcome;
  actualOutcome: ActualOutcome;
  severity: "warning" | "critical";
  implicated_rule?: string;   // SOUL.md rule key, if applicable
}
```

**Emission criteria:** A `criticalFailure` is emitted when:
- A tool call returns a 4xx/5xx AND the ExpectedOutcome predicted success, OR
- The user explicitly overrides/corrects an agent action, OR
- The `actualOutcome` priority score is >= `critical_failure_score_floor` (default 3)
  points below the `expectedOutcome`.

#### Policy Proposals

When the Meta-Reviewer determines that a failure was caused by a rule in SOUL.md
(e.g., "always ask permission before deleting files" blocked an efficient cleanup),
it emits a `PolicyProposal`:

```typescript
interface PolicyProposal {
  id: string;
  timestamp: string;
  rule: string;              // the SOUL.md rule implicated
  proposal: string;          // suggested change
  reasoning: string;         // why the change would help
  evidence: string[];        // actionIds that support this
  status: "pending" | "approved" | "rejected";
}
```

**Delivery mechanism:** Policy proposals are written to
`~/.openclaw/workspace/.policy-proposals.json` and surfaced via:
1. A `openclaw workspace proposals` CLI command (new).
2. A notification in the agent's next turn preamble ("You have 2 pending policy
   proposals").
3. The Gateway WebSocket status channel (for Control UI consumers).

**The Meta-Reviewer never auto-updates SOUL.md.** All policy changes require
explicit user approval.

#### Weight Adjustment

When the Meta-Reviewer processes outcomes, it adjusts domain weights in
`PRIORITIES.json`:

```
new_weight = clamp(
  current_weight * (1 + (approvals - overrides) * 0.05),
  0.1,
  1.0
)
```

**Guardrails:**
- Minimum observation window: 10 outcomes in a domain before any adjustment.
- Maximum single adjustment: +/- 0.05 per review cycle.
- Floor of 0.1 prevents any domain from being fully muted.
- The `_weight_adjustment_log` records every change with reasoning.
- A snapshot of `PRIORITIES.json` is taken before writing.

---

## 5. Objective Weighting / VALUATION_ENGINE

The VALUATION_ENGINE is the scoring function used in Phase B (Strategy).

```typescript
interface ValuationEngine {
  score(strategies: Strategy[], domains: DomainWeights): Strategy;
  validateRubric(rubric: ScoringRubric): void;  // asserts weights sum to 1.0
}
```

**Formula:** `V = sum(Si * Wi)` where:
- `Si` = per-axis score (alignment, efficiency, risk) for strategy i
- `Wi` = axis weight from `scoring_rubric` in `PRIORITIES.json`

The per-axis scores are then multiplied by the relevant domain weight from
`PRIORITIES.json` to produce the final score.

**Startup behavior:** On boot, the engine:
1. Reads `PRIORITIES.json`.
2. Asserts `scoring_rubric` weights sum to 1.0 (+/- 0.001 for floating point).
3. Asserts all domain weights are in [0.1, 1.0].
4. Fails hard with an actionable error if validation fails.

**Evolution:** Through double-loop learning, the Meta-Reviewer adjusts domain
weights based on which decisions the user approves or overrides. The scoring
rubric weights (alignment/efficiency/risk) are **not** auto-adjusted — they
require manual tuning.

---

## 6. Schema Definitions

### 6.1 TypeScript Interfaces (Canonical)

These are the source of truth. The JSON templates are generated from these.

```typescript
// extensions/memory-ooda/types.ts

interface KnowledgeFile {
  _meta: {
    version: number;
    updated_at: string;
    updated_by: "archivist" | "user";
    turn_count_at_last_update: number;
    description: string;
  };
  identity: {
    name: string;
    timezone: string;
    location_primary: string;
    language_primary: string;
    communication_style: string;
  };
  stack: Record<string, string>;
  projects: Record<string, {
    status: "active" | "paused" | "complete";
    priority_domain: string;
    key_constraint: string;
    notes: string;
  }>;
  people: Record<string, {
    role: string;
    relationship: string;
    communication_preference: string;
    notes: string;
  }>;
  preferences: {
    always_ask_before: string[];
    never_do: string[];
    prefers_async_over_sync: boolean;
    prefers_delegation_over_diy: boolean;
    response_length: "concise" | "detailed" | "adaptive";
    notes: string;
  };
  commitments: Array<{
    label: string;
    recurrence: "daily" | "weekly" | "biweekly" | "monthly";
    day?: string;
    time: string;
    timezone: string;
    blocking: boolean;
  }>;
  domain_context: Record<string, string>;
  _archivist_log: Array<{
    timestamp: string;
    action: string;
    reason: string;
  }>;
}

interface PrioritiesFile {
  _meta: {
    version: number;
    updated_at: string;
    updated_by: "user" | "meta_reviewer";
    description: string;
  };
  domains: Record<string, {
    weight: number;          // 0.1 - 1.0
    description: string;
    examples: string[];
    approval_count: number;
    override_count: number;
  }>;
  strategy_labels: Array<{
    label: string;
    description: string;
  }>;
  scoring_rubric: {
    alignment: { weight: number; description: string };
    efficiency: { weight: number; description: string };
    risk: { weight: number; description: string };
  };
  thresholds: {
    min_priority_for_full_ooda: number;
    min_thinking_level_for_full_ooda: "low" | "medium" | "high";
    critical_failure_score_floor: number;
    archivist_turn_interval: number;
    meta_reviewer_weekly_enabled: boolean;
  };
  _weight_adjustment_log: Array<{
    timestamp: string;
    domain: string;
    old_weight: number;
    new_weight: number;
    reason: string;
  }>;
}
```

**Note on schema flattening:** Both files use flat structures. `stack`, `projects`,
`people`, and `domains` are direct `Record<string, ...>` maps — no intermediate
`entries` or `description` keys at the section level. Section-level descriptions
live in `_meta` or as code comments in the TypeScript interface.

### 6.2 JSON Templates

The `$schema` field is omitted until schemas are published. Use local TypeScript
interfaces for validation.

Templates for `KNOWLEDGE.json` and `PRIORITIES.json` are generated from the
TypeScript interfaces above with empty/default values. They land at
`~/.openclaw/workspace/` alongside `SOUL.md`.

---

## 7. Rollback and Safety

### File Snapshots

Before any automated write to `KNOWLEDGE.json` or `PRIORITIES.json`:

1. Copy the current file to `~/.openclaw/workspace/.snapshots/<filename>.<unix_timestamp>.bak`
2. Perform the write.
3. If the write fails or produces invalid JSON, restore from the snapshot immediately.
4. Keep the last 5 snapshots per file. Delete older ones.

**CLI support:** `openclaw workspace rollback [knowledge|priorities]` restores
the most recent snapshot. `openclaw workspace rollback --list` shows available
snapshots with diffs.

### Safety Invariants

- The Executive model **never writes** to Tier 3 (KNOWLEDGE.json) or PRIORITIES.json.
- The Archivist **never writes** to PRIORITIES.json.
- The Meta-Reviewer **never writes** to KNOWLEDGE.json.
- The Meta-Reviewer **never modifies** SOUL.md without user approval.
- `_archivist_log` and `_weight_adjustment_log` are append-only.
- All automated weight adjustments are clamped to [0.1, 1.0] with max
  single-step delta of 0.05.
- Minimum 10 observations in a domain before the Meta-Reviewer adjusts weights.

---

## 8. Code Locations

The OODA implementation splits across two layers: the **extension layer**
(plugin infrastructure) and the **core layer** (agent loop modifications).

### Extension Layer — `extensions/`

Everything that can be a plugin should be a plugin. This maximizes reuse of
existing infrastructure (lifecycle hooks, cron, CLI registration, config schema)
and keeps the core agent loop clean.

| Component | Location | Rationale |
|-----------|----------|-----------|
| Tier 2 episodic memory | `extensions/memory-lancedb/` (extend) | Already has LanceDB, embeddings, tools, hooks. Add OODA-specific fields and pruning. |
| Tier 3 semantic memory | `extensions/memory-ooda/semantic-memory.ts` | New. KNOWLEDGE.json read/write + snapshot. Registers `before_agent_start` hook to inject facts. |
| Archivist cron | `extensions/memory-ooda/archivist.ts` | New. Registers as cron job via Gateway cron API. Reads Tier 2, writes Tier 3. |
| OODA types | `extensions/memory-ooda/types.ts` | New. All shared interfaces (SITREP, Strategy, ExpectedOutcome, ActualOutcome, etc.) |
| PRIORITIES.json management | `extensions/memory-ooda/priorities.ts` | New. Read/write/validate + snapshot. |
| Policy proposals | `extensions/memory-ooda/proposals.ts` | New. Write/read `.policy-proposals.json`. |
| CLI commands | `extensions/memory-ooda/` | New. `openclaw workspace proposals`, `openclaw workspace rollback`. |

### Core Layer — `src/`

These modifications touch the agent loop itself and cannot be plugins.

| Component | Location | Rationale |
|-----------|----------|-----------|
| Triage phase | `src/agents/ooda/triage.ts` | New. Lightweight model pre-pass before Executive. |
| Strategy / Decision Matrix | `src/agents/ooda/strategy.ts` | New. Hypothesis generation + scoring. |
| VALUATION_ENGINE | `src/agents/ooda/valuation-engine.ts` | New. `V = sum(Si * Wi)` scoring function. |
| Agent loop integration | `src/agents/cli-runner.ts` (modify) | Wrap existing LLM call with triage → strategy → executive sequence. |
| Meta-Reviewer | `src/agents/ooda/meta-reviewer.ts` | New. Outcome tracking + weight adjustment. Hooks into agent events. |
| `criticalFailure` event | `src/gateway/events.ts` (modify) | Add new event type to Gateway event bus. |
| Outcome metadata | `src/gateway/server-methods/` (modify) | Extend `sessions.patch` schema with `expectedOutcome` / `actualOutcome`. |
| Config schema | `src/config/` (modify) | Add `agents.defaults.triageModel` key. |

### Why This Split

1. **Memory (Tier 2 + 3) stays in extensions.** The existing `memory-lancedb`
   already proves this pattern works. The plugin lifecycle hooks
   (`before_agent_start` for injection, `agent_end` for capture) are the right
   seam for memory operations. The Archivist is a cron job — the cron service
   already supports plugin-registered jobs.

2. **OODA reasoning chain goes in core.** The triage → strategy → executive
   sequence modifies the fundamental agent loop in `src/agents/cli-runner.ts`.
   This cannot be a plugin hook because it wraps the LLM call itself, not
   pre/post-processes it. The model routing (`triageModel` vs `model`) is a
   core config concern.

3. **Meta-Reviewer straddles both.** It reads from extension-managed data
   (LanceDB outcomes, PRIORITIES.json) but writes to core infrastructure
   (Gateway event bus). It lives in `src/agents/ooda/` because its trigger
   is the `criticalFailure` event on the core event bus.

### Dependency Flow

```
extensions/memory-lancedb  (Tier 2 — existing, extended)
         ↓ reads
extensions/memory-ooda     (Tier 3 + Archivist + proposals)
         ↓ injects via before_agent_start hook
src/agents/ooda/triage     (Phase A — lightweight model)
         ↓ SITREP
src/agents/ooda/strategy   (Phase B — decision matrix)
         ↓ winning Strategy
src/agents/cli-runner      (Phase C — Executive, existing loop)
         ↓ ExpectedOutcome + tool results
src/agents/ooda/meta-reviewer  (outcome tracking → weight adjustment)
         ↓ writes
extensions/memory-ooda/priorities.ts  (PRIORITIES.json updates)
```

---

## 9. Implementation Phases and PR Sequence

Start small, stay shippable. Each PR is independently useful.

### PR 1 — Tier 3 Semantic Memory (extension)

**Scope:** `KNOWLEDGE.json` template + semantic memory module + injection into
system prompt via `before_agent_start` hook.

**Location:** `extensions/memory-ooda/`

**Files:**
- `extensions/memory-ooda/package.json`
- `extensions/memory-ooda/openclaw.plugin.json`
- `extensions/memory-ooda/types.ts` — `KnowledgeFile` and `PrioritiesFile` interfaces
- `extensions/memory-ooda/semantic-memory.ts` — read/write wrapper with JSON validation
- `extensions/memory-ooda/semantic-memory.test.ts`
- `extensions/memory-ooda/index.ts` — plugin registration + `before_agent_start` hook

**Risk:** Zero. Additive, immediately useful. New extension, no core changes.

### PR 2 — Tier 2 Episodic Memory Extensions (extension)

**Scope:** Extend `memory-lancedb` with OODA-specific fields. Add pruning. Add
`archivistProcessed` flag and source metadata to memory entries.

**Location:** `extensions/memory-lancedb/` (modify)

**Files:**
- `extensions/memory-lancedb/index.ts` — extend `MemoryEntry` with OODA fields
- `extensions/memory-lancedb/index.test.ts` — pruning tests

**Risk:** Low. Additive schema changes to existing extension.

### PR 3 — Triage Phase (core)

**Scope:** SITREP type + lightweight model call wired before the Executive.
**Feature-flagged off by default.**

**Location:** `src/agents/ooda/`

**Files:**
- `src/agents/ooda/triage.ts` — Triage phase with prompt template
- `src/agents/ooda/triage.test.ts`

**Modify:**
- `src/agents/cli-runner.ts` — wrap existing LLM call with triage-first check
- `src/config/` — add `agents.defaults.triageModel`

**Risk:** Medium. Doubles model calls per turn when enabled. Gated behind
`thinkingLevel >= "medium"`.

### PR 4 — Decision Matrix + VALUATION_ENGINE (core + extension)

**Scope:** Strategy generation, scoring, and the valuation engine.
**Feature-flagged.**

**Location:** `src/agents/ooda/` + `extensions/memory-ooda/`

**Files:**
- `src/agents/ooda/strategy.ts` — hypothesis generation + scoring
- `src/agents/ooda/valuation-engine.ts` — `V = sum(Si * Wi)` implementation
- `src/agents/ooda/strategy.test.ts`
- `src/agents/ooda/valuation-engine.test.ts`
- `extensions/memory-ooda/priorities.ts` — PRIORITIES.json read/write/validate
- Template: `~/.openclaw/workspace/PRIORITIES.json`

**Risk:** Medium. New decision path, but feature-flagged.

### PR 5 — Archivist Cron (extension)

**Scope:** Async Tier 2 → Tier 3 distillation process.

**Location:** `extensions/memory-ooda/`

**Files:**
- `extensions/memory-ooda/archivist.ts` — cron job via Gateway cron API
- `extensions/memory-ooda/archivist.test.ts`

**Risk:** Low. Purely async read-then-write. Snapshot before writing.

### PR 6 — Meta-Reviewer + Outcome Tracking (core + extension)

**Scope:** `criticalFailure` event type, ExpectedOutcome/ActualOutcome tracking,
policy proposals, weight adjustment.

**Location:** `src/agents/ooda/` + `src/gateway/` + `extensions/memory-ooda/`

**Files:**
- `src/agents/ooda/meta-reviewer.ts`
- `src/agents/ooda/meta-reviewer.test.ts`
- `src/gateway/events.ts` — add `criticalFailure` event type
- `extensions/memory-ooda/proposals.ts` — policy proposal storage

**Modify:**
- `sessions.patch` schema — add `expectedOutcome` and `actualOutcome` fields
- `src/agents/cli-runner.ts` — Executive emits ExpectedOutcome with each action

**Risk:** Highest PR in the sequence. Requires the new event type and session
schema changes. Needs thorough testing.

### PR 7 — Feature Flag Removal + CLI (core + extension)

**Scope:** Remove feature flags, wire live PRIORITIES.json weight adjustment,
add `openclaw workspace` CLI commands.

**Location:** `extensions/memory-ooda/` + config changes

**Files:**
- `extensions/memory-ooda/cli.ts` — `proposals`, `rollback` subcommands
- Config changes to enable OODA chain by default

**Risk:** Medium. This is the "turn it on" PR.

---

## 10. Open Questions

1. **Embedding model reuse.** The existing `memory-lancedb` uses OpenAI embeddings.
   The OODA extension should reuse the same embedding pipeline and config rather
   than introducing a second one. Need to verify `memory-ooda` can import from
   `memory-lancedb` or if shared embedding logic should be extracted.

2. **Triage model fallback.** If the configured triage model is unavailable (rate
   limit, network), should the system skip triage entirely or queue the observation?
   Current proposal: skip and fall through to Executive with default SITREP.

3. **Multi-agent sessions.** When multiple agents are running, do they share
   Tier 2/3, or does each agent get its own episodic store? Shared Tier 3 with
   per-agent Tier 2 seems right but needs concurrency design.

4. **Privacy and data retention.** Tier 2 stores raw event content. What's the
   retention policy? The 90-day prune is a starting point but may need user
   configuration.

5. **`inferred` outcome source (v2).** When and how to enable the heuristic
   outcome detector. Needs a validation dataset from v1 tool_result and
   user_signal outcomes first.

6. **LanceDB macOS native bindings.** The existing extension notes that
   `@lancedb/lancedb` may not ship darwin native bindings. If this is still a
   blocker on the target platform, we may need to consider sqlite-vec as a
   fallback or lobby upstream for arm64 darwin support.
