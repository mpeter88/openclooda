# CR_OPENCLOODA_PHASE1_INBOX_FAST_CLARIFY

**Status:** WRITTEN  
**Priority:** P1  
**Estimated effort:** 3-4 hours  
**Phase:** 1 of 5 (see OPENCLOODA-ARCH-v2-SPEC.md)  
**Spec reference:** `docs/OPENCLOODA-ARCH-v2-SPEC.md` — Flows 1 + Project Suggestion Tracking

---

## What This Builds

The first layer of the GTD workflow: every significant observation gets typed and timestamped into an Inbox. A topic suggestion tracker accumulates turn counts and surfaces project creation suggestions.

This phase does NOT update the world model (Phase 2+). It creates the raw material — typed inbox items — that slow Clarify will later process.

---

## Schema

Add two tables to `~/.openclaw/memory/lancedb/memories.sqlite` (same DB used by sqlite-vec fallback):

```sql
-- Inbox: typed observations awaiting slow Clarify
CREATE TABLE IF NOT EXISTS inbox (
  id TEXT PRIMARY KEY,
  capturedAt INTEGER NOT NULL,
  sessionId TEXT,
  text TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('project','area','reference','trash','someday')),
  pertiansTo TEXT,           -- project/area id from KNOWLEDGE.json, or null
  nextTouchpoint TEXT CHECK (nextTouchpoint IN ('now','today','this_week','someday') OR nextTouchpoint IS NULL),
  processed INTEGER NOT NULL DEFAULT 0,  -- 0=pending, 1=processed by slow Clarify
  createdAt INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);

-- Topic tracker: accumulates turn counts for project suggestion detection
CREATE TABLE IF NOT EXISTS topic_tracker (
  topic_key TEXT PRIMARY KEY,   -- project/area id, or normalized topic slug
  sample_text TEXT,             -- most recent mention (for context when suggesting)
  turn_count INTEGER DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  suggested_at INTEGER,         -- timestamp when suggestion was surfaced (null = not yet)
  dismissed_at INTEGER          -- timestamp when user dismissed (null = still pending)
);
```

---

## Fast Clarify LLM Call

**When:** Every substantive turn (same gate as existing Archivist: `isSubstantiveAssistantTurn`).

**Always on** — not gated by thinking level.

**Model:** Cheapest available (haiku/flash). No conversation history.

**Prompt:**

```
You are classifying an observation for a personal knowledge management system.

Active projects and areas: {comma-separated ids from KNOWLEDGE.json}

Observation: "{text}"

Classify this observation. Return JSON only, no explanation:
{
  "type": "project" | "area" | "reference" | "trash" | "someday",
  "pertains_to": "<id from the active list above>" | null,
  "next_touchpoint": "now" | "today" | "this_week" | "someday" | null
}

Rules:
- "project" = relates to active work on a specific project
- "area" = relates to an ongoing responsibility (OpenClaw stability, health, etc.)
- "reference" = factual info worth keeping (architecture decisions, lessons learned)
- "trash" = noise, pleasantries, no informational value
- "someday" = interesting idea with no current action
- pertains_to must be one of the active ids above, or null if none fit
- next_touchpoint: "now" = needs attention this session, "today" = today, "this_week" = this week, "someday" = no urgency, null = not actionable
```

**Output handling:**

- Parse JSON
- On parse failure: log warning, type = "reference", pertains_to = null (safe fallback)
- Write to inbox table
- Update topic_tracker for pertains_to (or detected topic if pertains_to is null)

---

## Topic Suggestion Logic

After every fast Clarify call:

1. If `pertains_to` is non-null (matches an active project/area):
   - Increment `topic_tracker.turn_count` for that id
   - This is normal activity tracking, no suggestion needed

2. If `pertains_to` is null but type is "project" or "reference":
   - Extract a topic key from the observation (LLM can return a suggested slug, or use first 3 words normalized)
   - Increment `topic_tracker.turn_count` for that slug

3. At `turn_count == 8` for any topic without an active project match:
   - Run **insight check** (second cheap LLM call):
     ```
     Does this look like a project — something with a clear outcome and multiple steps?
     Topic: "{topic_key}"
     Recent mention: "{sample_text}"
     Return JSON: {"is_project": true|false, "suggested_name": "..." | null, "reason": "..."}
     ```
   - If `is_project = true`: set `topic_tracker.suggested_at = now`, store suggestion in `meta` key in `memories.sqlite`
   - Surface suggestion in next SITREP (see Orient integration below)

---

## Orient Integration (minimal — Phase 4 does full world model read)

In Phase 1, Orient gets a lightweight addition to the SITREP from pending suggestions only:

```typescript
// In strategy.ts or triage.ts before_agent_start hook:
const pendingSuggestions = await db
  .prepare(
    "SELECT topic_key, sample_text FROM topic_tracker WHERE suggested_at IS NOT NULL AND dismissed_at IS NULL",
  )
  .all();

if (pendingSuggestions.length > 0) {
  sitrep += "\n## Project Suggestions\n";
  for (const s of pendingSuggestions) {
    sitrep += `- Suggestion: "${s.topic_key}" may warrant a project (based on recent activity). Confirm with user.\n`;
  }
}
```

This is the only Orient change in Phase 1. Full world model integration is Phase 4.

---

## Implementation

**Files to change:**

1. `extensions/memory-lancedb/index.ts`
   - `SqliteVecMemoryDB.doInitialize()` — add `inbox` and `topic_tracker` table creation after existing `memories` table setup
   - `Archivist` — after storing to episodic memory, call `fastClarify()` and write to inbox
   - Add `fastClarify(text: string, projectIds: string[]): Promise<InboxClassification>` method
   - Add `writeInboxItem(item: InboxItem)` method
   - Add `updateTopicTracker(topicKey: string, sampleText: string)` method
   - Add `getPendingProjectSuggestions()` method

2. `extensions/memory-ooda/index.ts` (or `strategy.ts`)
   - Read pending suggestions from DB, append to SITREP

3. `extensions/memory-lancedb/config.ts`
   - Add `fastClarifyModel` config field (defaults to cheapest available provider model)

**KNOWLEDGE.json usage:**

```typescript
// Read active project/area IDs from KNOWLEDGE.json for the fast Clarify prompt
const knowledge = JSON.parse(fs.readFileSync(knowledgePath, "utf8"));
const projectIds = [
  ...(knowledge.projects || []).map((p: any) => p.id || p.name),
  ...(knowledge.areas || []).map((a: any) => a.id || a.name),
].filter(Boolean);
```

---

## TypeScript Interfaces

```typescript
interface InboxClassification {
  type: "project" | "area" | "reference" | "trash" | "someday";
  pertiansTo: string | null;
  nextTouchpoint: "now" | "today" | "this_week" | "someday" | null;
}

interface InboxItem extends InboxClassification {
  id: string;
  capturedAt: number;
  sessionId: string;
  text: string;
  processed: boolean;
}

interface TopicSuggestion {
  topicKey: string;
  sampleText: string;
  suggestedAt: number;
}
```

---

## Done When

- [ ] `inbox` and `topic_tracker` tables created on init
- [ ] Fast Clarify fires on every substantive Archivist turn
- [ ] Inbox populated with typed items after a session
- [ ] Types look semantically correct on spot-check (AMF turns → type=project, pertains_to=amf-platform)
- [ ] Topic tracker increments correctly
- [ ] Suggestion surfaced in SITREP after 8 turns on unknown topic that passes insight check
- [ ] 300/300 tests pass (or same skip pattern as now)

---

## Tests

- Unit: `fastClarify` returns valid `InboxClassification` for known AMF observation
- Unit: `fastClarify` handles parse failure gracefully (returns safe default)
- Unit: `updateTopicTracker` increments count
- Unit: `getPendingProjectSuggestions` returns only non-dismissed suggestions
- Integration: 5 turns about AMF → 5 inbox items, all type=project/pertains_to=amf-platform
- Integration: insight check triggers at turn_count=8 for unknown topic

---

## Read-First Preamble (for agent)

Before implementing:

1. Read `extensions/memory-lancedb/index.ts` — understand existing `SqliteVecMemoryDB`, `Archivist`, and store() method
2. Read `extensions/memory-lancedb/config.ts` — understand existing config structure
3. Read `extensions/memory-ooda/index.ts` — understand existing SITREP assembly
4. Read `~/.openclaw/world-model/../KNOWLEDGE.json` path from config — understand project ID source
5. Describe in 2-3 sentences what the Archivist currently does before adding to it
