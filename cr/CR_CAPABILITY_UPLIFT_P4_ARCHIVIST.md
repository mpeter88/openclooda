# CR: Capability Uplift — Phase 4: Archivist Lessons + Richer Patterns

**Date:** 2026-03-19
**Status:** WRITTEN
**Priority:** HIGH — distillation is only as good as what it extracts
**Effort:** ~2 hours
**Dependency:** CR_CAPABILITY_UPLIFT_P2_BACKFILL (need populated episodic store)
**Files:** `extensions/memory-ooda/types.ts`, `extensions/memory-ooda/archivist.ts`

---

## Problem

`KNOWLEDGE.json` today:

- `lessons_learned`: **doesn't exist** as a section
- `preferences`: **3 entries** (minimal)
- `people`: **empty**
- `domain_context`: thin

The Archivist prompt asks for "stable facts and patterns" but doesn't explicitly
instruct it to extract lessons, preferences, or people. Without explicit targets,
the model under-extracts. A session like 2026-03-19 should produce a dozen lessons
(messages.stream vs create, package detection subpackage, check all branches for
violations, etc.) — but these are invisible to future sessions.

---

## Changes

### A1 — Add `lessons_learned` to KnowledgeFile type

**File:** `extensions/memory-ooda/types.ts`

```typescript
export interface KnowledgeFile {
  _meta: KnowledgeMeta;
  identity: IdentitySection;
  stack: StackSection;
  projects: Record<string, ProjectEntry>;
  people: Record<string, PersonEntry>;
  preferences: Record<string, string>;
  domain_context: Record<string, string>;
  // NEW: distilled lessons from past sessions
  lessons_learned: Record<string, string>;
  commitments?: CommitmentsSection;
  [key: string]: unknown;
}
```

The `lessons_learned` structure is `key → lesson`:

- Key: 3-5 word label (e.g. `"claude_streaming_required"`, `"package_detection_subpackage"`)
- Value: 1-2 sentence actionable lesson (e.g. `"Always use client.messages.stream() for Claude calls — the Anthropic SDK enforces a timeout on blocking create() requests that exceed 10 minutes of generation."`)

### A2 — Update Archivist prompt for aggressive extraction

**File:** `extensions/memory-ooda/archivist.ts`  
**Location:** the model prompt template

Replace or extend the current "extract stable facts" instruction with explicit
target sections and examples:

```typescript
const ARCHIVIST_PROMPT = `
You are the Archivist — a long-term memory distillation agent.

You receive a batch of recent episodic events (session turns, decisions, bugs, analyses).
Your job: extract durable knowledge worth remembering across sessions.

## Target Sections (extract to each one actively)

### lessons_learned
Mistakes made, bugs found, anti-patterns encountered, and what they teach.
EVERY bug report, revert, or "we should have known better" is a lesson.
Key: 3-5 words (snake_case), Value: 1-2 sentence actionable lesson.

Examples:
  "claude_streaming_required": "Always use client.messages.stream() not messages.create() for Claude — the SDK enforces a 10-minute timeout on blocking calls that large generations exceed."
  "package_detection_first_match": "Assembly script package detection must use the shortest qualifying package (≥3 segments), not the first match — can land on a subpackage and misplace files."
  "check_all_branches": "When auditing for code pattern violations, check worktree branches too, not just committed code — violations hide in in-flight branches."
  "isSubstantiveAssistantTurn_too_narrow": "The capture filter was too conservative — 10 patterns missed most reasoning turns. A long response (>600 chars) is substantive by definition."

### preferences
How the user prefers to work, what they value, what they avoid.
Key: short label, Value: 1 sentence.

Examples:
  "cr_before_code": "Always write the CR spec before implementing — no code without a CR."
  "candy_thermometer": "Check in frequently during long tasks — don't disappear and reappear with a wall of code."
  "no_half_baked_messages": "Never send half-baked replies to messaging surfaces."

### people
Anyone mentioned by name with relevant context (role, relationship, contribution).

Examples:
  "Zach Sais": "Dev team engineer at 66degrees. Implements CRs. Recently introduced agent_utils.py regression in worktree branch — reverted after bug report."

### projects
Update status, key patterns, current gaps. Don't repeat what's already there.

### domain_context
Cross-project patterns, recurring failure modes, architectural decisions.

## Rules
- Extract aggressively — err toward too much, not too little
- lessons_learned is the most important section. Empty = failure.
- Don't duplicate exact entries already in KNOWLEDGE.json
- Key names must be unique snake_case identifiers
- Values must be standalone (no "see above" or forward references)

## Output Format
Return a JSON array of pattern extractions:
[
  { "section": "lessons_learned", "key": "...", "value": "...", "reason": "..." },
  { "section": "preferences", "key": "...", "value": "...", "reason": "..." },
  ...
]
Return [] if no new patterns found.
`;
```

### A3 — Initialize `lessons_learned` in default KNOWLEDGE.json

**File:** `extensions/memory-ooda/semantic-memory.ts` (or wherever defaults are set)

Add `lessons_learned: {}` to the default KnowledgeFile initializer so the section
always exists:

```typescript
export function createDefaultKnowledge(): KnowledgeFile {
  return {
    _meta: { ... },
    identity: { ... },
    stack: { ... },
    projects: {},
    people: {},
    preferences: {},
    domain_context: {},
    lessons_learned: {},  // NEW
  };
}
```

### A4 — Update `upsertFact` to handle `lessons_learned`

**File:** `extensions/memory-ooda/semantic-memory.ts`

Ensure `upsertFact("lessons_learned", key, value)` works without special-casing —
the section is a `Record<string, string>` same as `preferences` and `domain_context`,
so it should already work. Verify and add a test.

---

## Tests

Add to `extensions/memory-ooda/archivist.test.ts`:

```typescript
describe("lessons_learned extraction", () => {
  it("extracts lessons_learned from episodic events", async () => {
    const events: EpisodicEvent[] = [
      {
        id: "1",
        text: "The messages.stream() call was replaced with messages.create() which breaks large outputs — reverted.",
        category: "fact",
        importance: 0.8,
        createdAt: Date.now(),
        source: "assistant",
      },
    ];

    const mockCallModel: ModelCallFn = async () =>
      JSON.stringify([
        {
          section: "lessons_learned",
          key: "claude_streaming_required",
          value: "Always use streaming for Claude calls.",
          reason: "Bug found in worktree.",
        },
      ]);

    const store = createMockSemanticStore();
    await runArchivist({ events, store, callModel: mockCallModel, config: defaultConfig() });

    expect(store.facts["lessons_learned"]["claude_streaming_required"]).toBe(
      "Always use streaming for Claude calls.",
    );
  });

  it("upserts lessons_learned via SemanticStore", () => {
    const knowledge = createDefaultKnowledge();
    const store = createSemanticStore(knowledge);
    store.upsertFact("lessons_learned", "test_key", "test value");
    expect(knowledge.lessons_learned["test_key"]).toBe("test value");
  });
});
```

---

## Acceptance Criteria

- [ ] `KNOWLEDGE.json` has a `lessons_learned` section after first Archivist run on backfilled data
- [ ] After 3 Archivist runs: `lessons_learned` has ≥ 10 entries
- [ ] After 3 Archivist runs: `preferences` has ≥ 5 entries
- [ ] `people` section populated for anyone mentioned ≥ 3 times in events
- [ ] New `upsertFact("lessons_learned", ...)` test passes
- [ ] 279 OODA tests pass
