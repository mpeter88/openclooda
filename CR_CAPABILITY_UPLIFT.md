# CR: Capability Uplift — 5-Phase Implementation Plan

**Date:** 2026-03-19  
**Status:** WRITTEN  
**Priority:** MEDIUM — no client deadline, build deliberately  
**Branch:** `capability-uplift` (cut from main)

---

## Motivation

The OODA architecture is complete and wired. The problem is it's running on near-empty
stores: 8 episodic memories after months of sessions, a `KNOWLEDGE.json` with thin
`preferences`/`people`/`lessons_learned` sections, and a proposals system that exists
but is disconnected from the Archivist. The five phases below address each gap in
dependency order.

---

## Phase 1 — Fix `isSubstantiveAssistantTurn` to capture more signal

**Files:** `extensions/memory-lancedb/index.ts`  
**Effort:** Small (~30 min)  
**Dependency:** None — standalone improvement

### Problem

The current filter requires one of 10 specific regex patterns. Today's session generated
dozens of substantive turns (architectural analysis, bug reports, code review) that didn't
match any of them. The consequence: `autoCapture` produces ~1 memory per long session
instead of 20-50.

### Fix

Broaden `isSubstantiveAssistantTurn` with three additional signal classes:

```typescript
// extensions/memory-lancedb/index.ts

export function isSubstantiveAssistantTurn(text: string): boolean {
  if (text.length < 120) return false;
  if (text.includes("<relevant-memories>") || text.includes("<ooda-notice>")) return false;

  const INSIGHT_SIGNALS = [
    // --- existing ---
    /\broot cause\b/i,
    /\bdiscrepancy\b|\bmismatch\b|\bgap\b/i,
    /\bdecision\b|\bdecided\b|\bchose\b/i,
    /\bconfirmed\b|\bverified\b|\bfound\b/i,
    /\bthe (fix|issue|problem|bug|cause) is\b/i,
    /\bthis means\b|\bimplication\b/i,
    /\bpattern\b|\brecurring\b/i,
    /\barchitectural\b|\bdesign decision\b/i,

    // --- new: code-level reasoning ---
    /\bregression\b|\bviolation\b|\banti-pattern\b/i,
    /\bwired\b|\bunwired\b|\bnot.*wired\b|\bnever.*called\b/i,
    /\bdeadlock\b|\brace condition\b|\btimeout\b/i,
    /\bblind spot\b|\bnever.*fires\b|\bsilently.*fails\b/i,

    // --- new: recommendations and conclusions ---
    /\brecommend\b|\bsuggestion\b|\badvise\b/i,
    /\bthe right (approach|way|call|tool|pattern)\b/i,
    /\bbetter (to|approach|option|choice)\b/i,
    /\btrade.?off\b|\bconsequence\b|\bimplication\b/i,

    // --- new: project-specific signal ---
    /\bparity (score|gap|check|fail)\b/i,
    /\bgenerat(ed|ion) (code|output|artifact)\b/i,
    /\bforensic (analysis|report|result)\b/i,
    /\bCR_\w+\b/, // any CR reference
    /\bPhase [1-9]\b|\bP[0-9] —\b/i, // priority/phase call-outs
  ];

  // Lower bar: any 1 signal OR length > 600 chars (long responses are usually substantive)
  return INSIGHT_SIGNALS.some((r) => r.test(text)) || text.length > 600;
}
```

Also raise the `importance` for assistant captures from `0.5` to `0.65` —
they're currently scored lower than user messages, which means they're the first
to be evicted. A code review or architectural recommendation is at least as valuable
as a user preference.

**Acceptance:** A session like today generates ≥20 assistant captures in sqlite-vec.

---

## Phase 2 — Memory backfill from daily markdown files

**Files:** New script `scripts/backfill-memory.ts` + `extensions/memory-lancedb/index.ts`  
**Effort:** Medium (~2 hours)  
**Dependency:** Phase 1 (want the correct capture filter before backfilling)

### Problem

Months of conversation context lives in `memory/YYYY-MM-DD.md` files as plain text.
The sqlite-vec store has 8 entries. None of the historical context is retrievable
via `autoRecall`. When I search my memory for "what did we decide about AMF parity",
it finds nothing.

### Fix: Backfill script

```typescript
// scripts/backfill-memory.ts
// Usage: npx tsx scripts/backfill-memory.ts [--days 30] [--dry-run]

/**
 * Reads memory/YYYY-MM-DD.md files, splits into paragraphs,
 * filters by isSubstantiveAssistantTurn equivalent, embeds,
 * deduplicates against existing store, and inserts.
 *
 * Safe to run multiple times — dedup prevents double-insertion.
 */
```

Implementation steps:

1. Walk `~/.openclaw/workspace/memory/*.md` files (newest first up to `--days`)
2. Parse each file into sections (split on `##` headers)
3. For each section, split into paragraphs (split on blank lines)
4. Filter: length > 100 chars AND contains at least one substantive signal
5. Embed each paragraph via the same embeddings provider as `autoCapture`
6. Search existing store for near-duplicate (similarity > 0.95) — skip if found
7. Insert with `source: "backfill"`, `importance: 0.6`, `category: detectCategory(text)`
8. Report: N paragraphs found, N filtered, N inserted, N skipped (dup)

Also expose as a CLI tool in `memory-lancedb` plugin so it can be triggered from
`openclaw workspace memory backfill`:

```typescript
// In memory-lancedb plugin tools:
{
  name: "memory_backfill",
  description: "Backfill episodic memory from workspace daily markdown files.",
  params: {
    days: { type: "number", description: "How many days back to scan (default: 30)" },
    dryRun: { type: "boolean", description: "Report what would be inserted without writing" },
  }
}
```

**Acceptance:** After running backfill, `autoRecall` surfaces relevant context from
prior sessions when I encounter the same project areas.

---

## Phase 3 — SITREP calibration + Strategy output verification

**Files:** `extensions/memory-ooda/triage.ts`, `extensions/memory-ooda/strategy.ts`,  
`extensions/memory-ooda/index.ts`  
**Effort:** Medium (~3 hours)  
**Dependency:** Phase 1+2 (SITREP quality improves when recall finds relevant facts)

### Problem

The SITREP is injected before every turn but there's no evidence it's materially
shaping responses. Two sub-problems:

**3a: SITREP is too summary-heavy, not action-signal-heavy**

Current format produces:

```json
{
  "priority": 6,
  "summary": "User is asking about AMF pipeline status",
  "conflictsDetected": [],
  "relevantFacts": ["AMF Platform: active project"],
  "recommendedDomains": ["engineering"]
}
```

What's actually useful:

```json
{
  "priority": 7,
  "summary": "AMF run status check — likely wants parity score + what's next",
  "conflictsDetected": [],
  "relevantFacts": [
    "Last run 5efa83db errored at IMPLEMENTING",
    "KDMS parity 74/100, 5 agent-fixable gaps known",
    "Client handover deadline: next week"
  ],
  "recommendedDomains": ["engineering"],
  "attention": "Deadline pressure — surface blockers, not context"
}
```

The `attention` field is new: a single imperative sentence about what to emphasize
or watch for. This is the highest-value output of Triage.

**Fix for 3a:** Add `attention` field to `SITREP` type + triage prompt:

```typescript
// types.ts
export interface SITREP {
  priority: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
  summary: string;
  conflictsDetected: string[];
  relevantFacts: string[];
  recommendedDomains: string[];
  attention?: string; // NEW: single imperative — what to watch for or emphasize
}
```

Update the triage prompt to produce `attention` when priority >= 6:

```
If priority >= 6, add an "attention" field: a single imperative sentence
(≤15 words) directing the executive on what to emphasize or watch for.
Examples:
  "Surface blockers first — deadline pressure is high."
  "User is debugging live; skip theory, go straight to cause."
  "This is a client-facing question — cite evidence, not opinion."
```

**3b: Strategy output is not visible or verifiable**

Strategy fires at medium+ thinking but there's no way to confirm it's producing
useful output vs. timing out or returning empty. Add a `strategy_debug` field to
the injected context (gated behind `OODA_DEBUG=true` env var) that appends the
raw strategy output to the system prompt so it can be inspected during development.

```typescript
// index.ts: in before_agent_start, after strategy runs
if (process.env.OODA_DEBUG === "true" && strategyResult) {
  parts.push(
    `<ooda-strategy-debug>\n${JSON.stringify(strategyResult, null, 2)}\n</ooda-strategy-debug>`,
  );
}
```

**Acceptance:**

- SITREP `attention` field present on priority-6+ turns
- `OODA_DEBUG=true` shows strategy output in system prompt
- Manual review: 5 consecutive turns, SITREP summary accurately predicts what
  response emphasized

---

## Phase 4 — Archivist produces richer patterns + lessons_learned

**Files:** `extensions/memory-ooda/archivist.ts`  
**Effort:** Medium (~2 hours)  
**Dependency:** Phase 2 (Archivist needs episodic events to read)

### Problem

The Archivist currently extracts to four sections: `stack`, `projects`, `people`,
`domain_context`. Looking at `KNOWLEDGE.json`, `people`, and `lessons_learned` are
empty, `preferences` is sparse. The Archivist prompt doesn't ask for these sections
explicitly enough, and `lessons_learned` doesn't exist as a target section at all.

### Fix: Add `lessons_learned` section + broaden Archivist prompt

**4a: New KNOWLEDGE.json section**

```typescript
// types.ts — add to KnowledgeFile
lessons_learned?: {
  [key: string]: string;  // key: short label, value: the lesson
};
```

**4b: Update PatternExtraction target sections**

```typescript
export interface PatternExtraction {
  section: "stack" | "projects" | "people" | "domain_context" | "lessons_learned" | "preferences";
  key: string;
  value: unknown;
  reason: string;
}
```

**4c: Sharper Archivist prompt**

Add explicit extraction targets to the Archivist model prompt. Currently the prompt
asks for "stable facts and patterns" in general. Make it specific:

```
You are extracting from episodic memory into long-term knowledge. Focus on:

LESSONS_LEARNED — mistakes made and what they teach:
  "messages.create not stream" → "Always use streaming for Claude calls; SDK enforces timeout on blocking requests > 10min"
  "package detection subpackage" → "Assembly script: use shortest package ≥3 segments, not first found"
  "worktree branch violations" → "Check ALL branches when auditing for pattern violations, not just committed code"

PREFERENCES — how the user likes things done:
  Tools, approaches, communication style specifics

PEOPLE — anyone mentioned by name with relevant context

DOMAIN_CONTEXT — project-specific patterns and constraints that recur

Extract lessons_learned aggressively. Every bug, mistake, or "we should have known
better" is a lesson. Short key (3-5 words), concise value (1-2 sentences max).
```

**Acceptance:** After 3 Archivist runs on backfilled data:

- `lessons_learned` has ≥10 entries
- `preferences` has ≥5 entries
- People section populated for anyone mentioned 3+ times

---

## Phase 5 — Archivist → Proposals pipeline (proactive initiative)

**Files:** `extensions/memory-ooda/archivist.ts`, `extensions/memory-ooda/proposals.ts`,  
`extensions/memory-ooda/index.ts`  
**Effort:** Medium-Large (~4 hours)  
**Dependency:** Phase 4 (Archivist must be producing good patterns first)

### Problem

The proposals system (`proposals.ts`, `PolicyProposal` type, `countPending()`) exists
and is hooked into the `before_agent_start` notice. But only the **Meta-Reviewer**
currently writes proposals, and Meta-Reviewer is focused on SOUL.md policy changes —
not actionable project suggestions.

The Archivist runs every 10 turns with full access to episodic patterns. It's the
right place to generate broader proposals: "I noticed X pattern across 3 sessions,
here's what I'd suggest."

### Fix: Archivist proposal generation

**5a: Extend `PolicyProposal` for general proposals (not just policy)**

```typescript
// types.ts
export interface PolicyProposal {
  id: string;
  timestamp: string;
  rule: string; // existing field — repurpose as "domain" for general proposals
  proposal: string;
  reasoning: string;
  evidence: string[];
  status: "pending" | "approved" | "rejected";
  // NEW fields:
  category: "policy" | "project" | "workflow" | "technical"; // type of proposal
  confidence: number; // 0-1 — how confident the Archivist is
  autoGenerated: boolean; // true = from Archivist, false = from Meta-Reviewer
}
```

**5b: Archivist proposal extraction**

Add a second model pass in the Archivist (after pattern extraction) that looks for
actionable proposals in the processed events:

```typescript
// archivist.ts — new function
async function extractProposals(
  events: EpisodicEvent[],
  existingKnowledge: KnowledgeFile,
  callModel: ModelCallFn,
): Promise<PolicyProposal[]> {
  // Only run if there are enough events to form a pattern (>= 5)
  if (events.length < 5) return [];
  // ...
}
```

Archivist proposal prompt:

```
You are scanning recent memory for actionable suggestions.

Look for:
1. RECURRING PROBLEMS — same issue appeared 3+ times → suggest a fix or process change
2. MISSING TOOLS — task done manually that could be automated → suggest building it
3. ARCHITECTURAL GAPS — pattern of workarounds → suggest addressing root cause
4. PROCESS INEFFICIENCY — repeated friction → suggest streamlining

For each proposal:
- category: "project" | "workflow" | "technical"
- rule: short domain label (e.g. "AMF Pipeline", "OpenCLOODA", "Daily workflow")
- proposal: concrete actionable suggestion (1-2 sentences)
- reasoning: why this matters, what evidence supports it
- evidence: 2-3 specific examples from the events
- confidence: 0.0–1.0 (only emit if >= 0.6)

Do NOT propose things already in the existing knowledge base.
Do NOT emit more than 3 proposals per run.
Return JSON array (empty array if nothing warrants a proposal).
```

**5c: Proposals threshold and dedup**

Before writing to disk:

- Skip if `confidence < 0.6`
- Skip if a pending proposal with >80% semantic similarity already exists
- Cap at 5 total pending proposals (don't spam)

**5d: Notice enhancement**

The existing notice tells me "You have N pending proposals" but doesn't summarize them.
Upgrade to show the first pending proposal inline (if only 1-2 pending):

```typescript
// index.ts — in notifyProposals block
if (pending === 1) {
  const proposals = getProposals(workspacePath).filter((p) => p.status === "pending");
  const p = proposals[0];
  parts.push(
    `<ooda-notice>Proposal pending: [${p.rule}] ${p.proposal} (run \`openclaw workspace proposals list\` to review)</ooda-notice>`,
  );
} else if (pending > 1) {
  parts.push(
    `<ooda-notice>You have ${pending} pending proposals. Run \`openclaw workspace proposals list --pending\` to review.</ooda-notice>`,
  );
}
```

**Acceptance:**

- After a 3-session work period, ≥1 auto-generated proposal appears
- Proposal is relevant (not hallucinated from thin evidence)
- Confidence threshold prevents spam — no more than 1-2 proposals per day

---

## Sequencing and Milestones

```
Phase 1 (isSubstantiveAssistantTurn fix)
  ~30 min — do first, unblocks everything downstream
  ↓
Phase 2 (backfill script)
  ~2 hours — run after Phase 1 so backfill uses the correct filter
  ↓
Phase 3 (SITREP calibration)
  ~3 hours — can overlap with Phase 2 since it's a different file
  ↓
Phase 4 (Archivist patterns)
  ~2 hours — needs Phase 2 backfill to have data to process
  ↓
Phase 5 (Archivist → Proposals)
  ~4 hours — needs Phase 4 running cleanly first
```

Total estimated effort: ~12 hours across the five phases.

---

## Out of Scope (deferred)

- **Cross-session memory federation** — memories from one session available in another
  via shared sqlite-vec. Requires gateway-level session sharing.
- **Proactive heartbeat proposals** — proposals surfaced via heartbeat without waiting
  for an active turn. Requires cron integration.
- **Memory decay** — importance scores decay over time for stale entries. `prune()`
  already exists; this is a scheduler concern.
- **Semantic dedup pass** — periodic merge of near-duplicate memories. Useful once
  store has >500 entries.

---

## Files Changed Summary

| File                                  | Phase | Change                                                                   |
| ------------------------------------- | ----- | ------------------------------------------------------------------------ |
| `extensions/memory-lancedb/index.ts`  | 1     | Broaden `isSubstantiveAssistantTurn`, raise assistant importance to 0.65 |
| `scripts/backfill-memory.ts`          | 2     | New — backfill script                                                    |
| `extensions/memory-lancedb/index.ts`  | 2     | Add `memory_backfill` tool                                               |
| `extensions/memory-ooda/types.ts`     | 3     | Add `attention` to SITREP type                                           |
| `extensions/memory-ooda/triage.ts`    | 3     | Update prompt for `attention` field                                      |
| `extensions/memory-ooda/index.ts`     | 3     | Inject `attention` into context + `OODA_DEBUG` strategy output           |
| `extensions/memory-ooda/types.ts`     | 4     | Add `lessons_learned` to KnowledgeFile                                   |
| `extensions/memory-ooda/archivist.ts` | 4     | Add `lessons_learned` section, sharper prompt                            |
| `extensions/memory-ooda/types.ts`     | 5     | Extend `PolicyProposal` with category/confidence/autoGenerated           |
| `extensions/memory-ooda/archivist.ts` | 5     | Add `extractProposals()` second pass                                     |
| `extensions/memory-ooda/proposals.ts` | 5     | Dedup logic + confidence threshold                                       |
| `extensions/memory-ooda/index.ts`     | 5     | Enhanced proposal notice                                                 |
