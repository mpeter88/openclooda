# OpenCLOODA Architecture v2 — Full Specification

_Finalized: 2026-04-07_

---

## Problem

The current OpenCLOODA is a reactive loop. Orient operates from episodic memory — fuzzy, recency-biased, structureless. Every session reconstructs context from scratch. The result: Orient is slow, incomplete, and wrong. Bad Orient makes every downstream decision wrong regardless of execution quality.

**Root cause:** No persistent, compiled world model. "Recall what happened" instead of "the model is already accurate."

---

## Framework

**OODA** is the cockpit — fast, real-time action loop. Orient is the dominant phase. If Orient is right, Decide is trivial.

**GTD** is the logistics layer — slower cycle, maintains the trusted system Orient reads from. Without it, cognitive load bleeds into the cockpit.

**World Model (Karpathy wiki pattern)** is the Organize layer — compiled, maintained, structured. Orient reads from it instead of raw memory.

```
OODA (real-time)
  Orient reads ──────────────────────────────────┐
                                                  ▼
                                    World Model (GTD: Organize)
                                    ┌─────────────────────────┐
                                    │  Projects               │
                                    │  Areas                  │
                                    │  Reference Wiki         │
                                    │  Someday                │
                                    └───────────┬─────────────┘
                                                │ maintained by
                                    GTD Workflow (slower cycle)
                                    ┌─────────────────────────┐
                                    │  Capture (Archivist)    │
                                    │  Fast Clarify (inline)  │
                                    │  Inbox (queue)          │
                                    │  Slow Clarify (async)   │
                                    │  Reflect (activity)     │
                                    └─────────────────────────┘
```

---

## Data Stores

### 1. Episodic Memory (existing)

Raw events, append-only, vector-indexed. Unchanged. Becomes supplementary — Orient reads world model first, episodic for detail ("what exactly happened on run 9?").

### 2. Inbox (new — SQLite table)

Short-lived queue. Populated by fast Clarify. Drained by slow Clarify.

```typescript
interface InboxItem {
  id: string;
  capturedAt: number;
  text: string;
  type: "project" | "area" | "reference" | "trash" | "someday";
  pertiansTo: string | null; // project/area id
  nextTouchpoint: "now" | "today" | "this_week" | "someday" | null;
  processed: boolean;
  sessionId: string; // which session generated it
}
```

### 3. World Model (new — structured files + SQLite index)

```
~/.openclaw/world-model/
  projects/
    amf-platform.json
    dreamboard.json
    iep-champion.json
    openclooda.json
    openclaw.json
  areas/
    openclaw-gateway.json
    personal.json
  reference/
    engineering-discipline.md        ← branch=hypothesis, five-why, verify before commit
    amf-pipeline-architecture.md
    openclooda-architecture.md
    known-failure-modes.md
    [project-id]-decisions.md        ← per-project architectural decisions
  someday/
    ideas.json
  index.json                         ← flat index, read first by Orient on every turn
  meta.json                          ← last reflect, inbox stats, project suggestions pending
```

**Project schema:**

```typescript
interface ProjectState {
  id: string;
  name: string;

  // Stable — set at creation, rarely changed
  goal: string;
  successCriteria: string[];

  // Milestone — changes as work progresses
  milestone: string;
  milestoneBlocking: string[];

  // Tactical — changes frequently
  openCRs: {
    name: string;
    status: "WRITTEN" | "PARTIAL" | "IMPLEMENTED";
    fixes: { n: number; done: boolean }[];
  }[];
  lastRun?: {
    id: string;
    label: string;
    result: "VERIFIED" | "ERROR" | "IMPLEMENTED" | string;
    parity?: number;
    rootCause?: string;
  };
  nextAction: string;

  // Metadata
  updatedAt: number;
  createdAt: number;
  status: "active" | "paused" | "complete";
}
```

**Area schema:**

```typescript
interface AreaState {
  id: string;
  name: string;
  description: string; // what "healthy" looks like
  currentStatus: string; // brief current state
  lastChecked: number;
  updatedAt: number;
}
```

---

## Flows

### Flow 1: Capture + Fast Clarify

**When:** Every turn, after `agent_end` hook fires (Archivist already runs here).

**Steps:**

1. Archivist extracts significant observations (existing path — decisions, insights, substantive turns)
2. **Fast Clarify LLM call** — cheap, constrained, no conversation history needed:

```
Model: gemini-flash (cheapest available)
Max tokens: ~100 out
Prompt:
  Active projects: {id_list}
  Active areas: {id_list}
  Observation: "{text}"

  Classify. Return JSON only:
  {"type": "project|area|reference|trash|someday", "pertains_to": "id or null", "next_touchpoint": "now|today|this_week|someday|null"}

Cost: ~150 tokens/turn
```

3. Write to Inbox with classification
4. Write to Episodic Memory (unchanged)

**Project suggestion tracking:**

- Maintain a rolling count per topic not matching an active project
- At 8 turns on a topic: run insight check ("does this look like a project — outcome + multiple steps?")
- If yes: add suggestion to `meta.json.pendingProjectSuggestions`
- Surface in SITREP when active in conversation: "Suggestion: X may warrant a project"

---

### Flow 2: Slow Clarify

**When:** Async, triggered when:

- Inbox count ≥ 5 unprocessed items, OR
- 30 min since last slow clarify with any inbox items pending

Runs as isolated background cron (not blocking current session).

**Steps:**

1. Pull all unprocessed inbox items, group by `pertains_to`
2. For each group (sequential, not parallel):
   a. Read current world model state for that project/area
   b. **Slow Clarify LLM call:**

```
Model: gemini-flash
Input: current project/area state + inbox items for this project (in order)
Prompt:
  Current state of {project_name}:
  {current_project_json}

  New observations (in order):
  1. {item1.text}
  2. {item2.text}
  ...

  Update the project state. What changed? Return a JSON patch.
  Only update fields that genuinely changed. Do not invent changes.

Output: {patch: {...}, summary: "brief description of what changed"}
```

3. Apply patch to world model file
4. Mark inbox items processed
5. Log what changed (for Reflect and human review)

**Reference items:** Observation classified as `reference` → slow Clarify writes or updates a markdown file in `reference/`. Cross-references existing reference pages.

---

### Flow 3: Orient reads World Model

**When:** `before_agent_start` hook, before Strategy assembles SITREP. (Already runs here.)

**Steps:**

1. Read `index.json` (always — fast, tiny file)
2. Identify relevant projects/areas for current context (from index metadata)
3. Read full JSON for relevant projects (1-3 files, not all)
4. Read any reference pages flagged as "always relevant" (engineering-discipline.md, etc.)
5. Inject into SITREP as compiled context:

```
## World Model

### Active Projects
**AMF Platform**
Goal: AI pipeline that reliably migrates Zebra→Honeywell apps with certified parity
Milestone: BarcodeSample1 compiles clean, no source SDK in output
Blocking: [none — run 14 in progress, awaiting result]
Last run: run14 — ERROR (GapClosure:types hallucinating comment words as class names)
Next action: Fix GapClosure scanner, run 15
Open CRs: CR_TAXONOMY_DRIVEN_MANIFEST_V2 (IMPLEMENTED)

**OpenCLOODA**
...

### Engineering Discipline
- Branch = hypothesis, main = certified
- Five-why: never stop at proximate cause
- Verify before commit (code AND agent output)
- Partial fix ≠ full fix — state explicitly which fixes are in before running

### Suggestions
- [none currently]
```

Orient uses episodic memory only for supplementary detail queries: "what exactly did run 9 produce?"

---

### Flow 4: Reflect

**When:** Activity-triggered. Fires when:

- 50 significant events since last Reflect, OR
- 7 days since last Reflect (safety net)

Runs as isolated background cron. Delivers summary as proactive notification.

**Steps:**

1. Read full world model
2. Read episodic memory from since last Reflect
3. **Reflect LLM call:**

```
Model: claude-sonnet or gemini-pro (quality matters here)
Input: full world model + recent episodic events + last reflect summary
Prompt:
  Review the world model against recent events.

  For each project:
  - Is the milestone still accurate?
  - Is the next action still correct?
  - Are any CRs stale (listed as open but actually done)?
  - Are there patterns worth adding to reference?

  For each area:
  - Is the status still current?

  Surface any pending project suggestions for human review.

  Return: {patches: [...], review_items: [...], new_reference_entries: [...]}
```

4. Apply patches to world model
5. Surface `review_items` as proactive notification to user
6. Write new reference entries
7. Update `meta.json.lastReflect`

---

### Flow 5: Project Lifecycle

**Creating:**

- Explicit: human says "let's track X as a project" → conversation-driven setup
- Suggested: system surfaces pending suggestions ("I've noticed 8+ turns on X, should this be a project?") → human confirms → conversation-driven setup

**Conversation-driven setup (both paths):**

```
Agent: What's the goal for X?
Human: [answers]
Agent: What does success look like?
Human: [answers]
Agent: What's the current milestone?
Human: [answers]
→ Agent writes projects/{id}.json with initial state
```

**Transitioning milestones:**

- Slow Clarify detects milestone completion in inbox items
- Proposes milestone transition: "BarcodeSample1 hit VERIFIED — should we update the milestone to KDMS?"
- Human confirms → world model updated

**Closing:**

- Explicit: human says "AMF Platform is complete" → project status set to "complete"
- Detected: Slow Clarify notices all success criteria met → proposes close

---

## Implementation Phases

### Phase 1 — Inbox + Fast Clarify

**Scope:** Add SQLite inbox table. Wire fast Clarify LLM call into Archivist. Tag every observation. Track topic counts for project suggestions.

**Files:**

- `extensions/memory-lancedb/index.ts` — add inbox SQLite table, fast Clarify call in Archivist
- New `extensions/memory-lancedb/inbox.ts` — inbox store class

**Done when:**

- After 10 turns, inbox has typed items
- Types look semantically correct
- `pertains_to` correctly maps to active project IDs
- Suggestion counter increments for repeated topics

**Tests:**

- Unit: fast Clarify returns valid JSON with correct type
- Unit: suggestion counter increments at 8 turns on same topic
- Integration: 5 turns about AMF → all tagged `project / amf-platform`

---

### Phase 2 — World Model Store + Bootstrap

**Scope:** Define schema and file structure. Implement read/write store. Conversation-driven bootstrap for active projects.

**Files:**

- New `extensions/memory-lancedb/world-model-store.ts` — read/write for project/area/reference/index
- `~/.openclaw/world-model/` — created on first run
- Bootstrap conversation flow in `extensions/memory-lancedb/index.ts`

**Bootstrap:** On first run with no world model, agent asks about each known project:

```
"I'm setting up your world model. Let's start with AMF Platform.
What's the current goal? What's the current milestone? What's blocking it?"
```

**Done when:**

- World model files exist for all active projects
- Read/write operations work
- Index stays current with every write

**Tests:**

- Unit: write project → read back matches
- Unit: index.json updated on every write
- Integration: bootstrap conversation produces valid world model

---

### Phase 3 — Slow Clarify

**Scope:** Background cron that drains inbox into world model. Sequential processing per project group.

**Files:**

- New `extensions/memory-lancedb/slow-clarify.ts`
- Cron registration in `extensions/memory-lancedb/index.ts`

**Done when:**

- Inbox drained within 30 min of filling
- World model patches reflect what happened (spot-check manually)
- Reference entries written for reference-type items

**Tests:**

- Unit: slow Clarify produces valid patch for known inbox item
- Integration: 5 inbox items → world model updated → inbox drained

---

### Phase 4 — Orient reads World Model

**Scope:** `before_agent_start` reads index + relevant project files. Injects as compiled context. Episodic recall becomes supplementary.

**Files:**

- `extensions/memory-ooda/index.ts` — triage/strategy reads world model before episodic
- `extensions/memory-lancedb/world-model-store.ts` — read interface

**Done when:**

- SITREP contains world model section (projects, areas, engineering discipline)
- Orient no longer reconstructs context from episodic recall alone
- Suggestion appears in SITREP when pending

**Tests:**

- Unit: world model section present in SITREP output
- Integration: after fast Clarify + slow Clarify, Orient SITREP reflects updated state

---

### Phase 5 — Reflect

**Scope:** Activity-triggered background cron. Heavier review, proactive notification.

**Files:**

- New `extensions/memory-lancedb/reflect.ts`
- Cron registration with activity threshold tracking

**Done when:**

- Reflect fires after 50 events
- World model updated with reflect patches
- Human receives notification with review items

**Tests:**

- Unit: Reflect produces valid patches + review items
- Integration: 50 events → Reflect fires → notification delivered

---

## What Doesn't Change

- OODA loop structure (Triage → Strategy → SITREP injection)
- Thinking level gating
- Episodic memory system (supplementary, not deprecated)
- Existing Archivist hook timing

---

## Key Constraint

The world model is trusted because it's maintained. If Reflect stops running, it rots. If Slow Clarify falls behind, it goes stale. The value is in the maintenance loop, not the data structure.

**The system is only as good as its Reflect cycle.**
