# CR_OPENCLOODA_PHASE3_SLOW_CLARIFY

**Status:** WRITTEN  
**Priority:** P1  
**Estimated effort:** 4-5 hours  
**Phase:** 3 of 5 (see OPENCLOODA-ARCH-v2-SPEC.md)  
**Depends on:** Phase 1 (inbox table), Phase 2 (world model store)  
**Spec reference:** `docs/OPENCLOODA-ARCH-v2-SPEC.md` — Flow 2 (Slow Clarify)

---

## What This Builds

The background worker that drains the inbox into the world model. Slow Clarify reads unprocessed inbox items, groups them by project/area, processes them sequentially, and writes patches to the world model. It's the bridge between raw observations (inbox) and compiled state (world model).

---

## Trigger Conditions

Slow Clarify runs as a background cron job. Fires when **either**:

- `inbox` table has ≥5 unprocessed items, OR
- Time since `meta.json.lastSlowClarify` > 30 minutes AND any unprocessed items exist

Runs in an **isolated session** (not blocking the current conversation).

---

## Processing Logic

**Step 1 — Fetch and group**

```typescript
// Pull all unprocessed inbox items, ordered by capturedAt ASC
const items = db
  .prepare("SELECT * FROM inbox WHERE processed = 0 ORDER BY capturedAt ASC")
  .all() as InboxItem[];

// Group by pertains_to (null items grouped together as "unattached")
const groups = Map<string | null, InboxItem[]>();
for (const item of items) {
  const key = item.pertiansTo ?? "__unattached__";
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key)!.push(item);
}
```

**Step 2 — Process each group sequentially**

For each group with a known project/area id:

```typescript
const currentState = store.readProject(projectId); // or readArea

// Slow Clarify LLM call
const prompt = `
Current state of "${project.name}":
${JSON.stringify(currentState, null, 2)}

New observations (in chronological order):
${items.map((item, i) => `${i + 1}. [${item.type}] ${item.text}`).join("\n")}

Review these observations. Update the project state to reflect what changed.
Return a JSON patch — only include fields that genuinely changed based on the observations.
Do not invent changes not evidenced in the observations.

Valid patch fields: milestone, milestoneBlocking, nextAction, openCRs, lastRun, status

Return JSON only:
{
  "patch": { ...only changed fields... },
  "summary": "one sentence describing what changed"
}
`;

const response = await callLLM(prompt); // gemini-flash
const { patch, summary } = JSON.parse(response);

// Apply patch
store.patchProject(projectId, {
  ...patch,
  updatedAt: Date.now(),
});

// Log
logger.info(`Slow Clarify: updated ${project.name} — ${summary}`);
```

**Step 3 — Handle reference items**

Items with `type = "reference"` from any group:

```typescript
// Group reference items by apparent topic (use LLM to cluster)
// For MVP: append to [pertains_to]-decisions.md or a general reference file
for (const refItem of referenceItems) {
  const filename = refItem.pertiansTo
    ? `${refItem.pertiansTo}-decisions.md`
    : "general-reference.md";

  const existing = store.readReference(filename) ?? "";
  const entry = `\n## ${new Date(refItem.capturedAt).toISOString().split("T")[0]}\n\n${refItem.text}\n`;
  store.writeReference(filename, filename.replace(".md", ""), existing + entry);
}
```

**Step 4 — Handle unattached items**

Items where `pertains_to` is null after Phase 1 fast Clarify:

```typescript
// Run a second fast Clarify with the now-complete world model project list
// If they still don't match anything: type them as "reference" or "someday" and file accordingly
// Do not discard — every observation has value even if unattached
```

**Step 5 — Mark processed and update meta**

```typescript
// Mark all processed items
db.prepare("UPDATE inbox SET processed = 1 WHERE id IN (...)").run(...ids);

// Update meta
store.writeMeta({
  ...store.readMeta(),
  lastSlowClarify: Date.now(),
});
```

---

## Cron Registration

```typescript
// In extensions/memory-lancedb/index.ts plugin registration:
api.cron.add({
  name: "memory-lancedb-slow-clarify",
  schedule: { kind: "every", everyMs: 5 * 60 * 1000 }, // check every 5 min
  payload: {
    kind: "agentTurn",
    message:
      "Run slow Clarify if inbox has ≥5 unprocessed items or 30+ min since last run. Check conditions, process if triggered, update meta.json, report what changed.",
  },
  sessionTarget: "isolated",
  delivery: { mode: "none" }, // silent unless something notable
});
```

**Condition check in the isolated agent turn:**
The agent turn reads the inbox count and `meta.lastSlowClarify`, decides whether to run, runs if conditions met, reports briefly. Silent by default — no announcement unless something notable (e.g., a milestone was detected as complete).

---

## Special Detection: Milestone Transitions

During slow Clarify, detect milestone-level events in the observations:

```typescript
// After applying patch, check for milestone completion signals
const milestoneComplete = items.some(
  (item) =>
    item.text.toLowerCase().includes("verified") ||
    item.text.toLowerCase().includes("parity ≥") ||
    item.text.toLowerCase().includes("certified"),
);

if (milestoneComplete && currentState.milestone !== patch.milestone) {
  // Propose milestone transition
  store.writeMeta({
    ...meta,
    pendingProjectSuggestions: [
      ...meta.pendingProjectSuggestions,
      {
        topicKey: `milestone-transition:${project.id}`,
        sampleText: `"${currentState.milestone}" may be complete — suggest transitioning to next milestone`,
        suggestedAt: Date.now(),
      },
    ],
  });
}
```

Surfaces in next SITREP via Orient's pending suggestions read.

---

## LLM Call Constraints

- **Model:** gemini-flash (cost control)
- **Max items per group per call:** 10 (if more, process in batches of 10)
- **Max groups per slow Clarify run:** 5 (cap to avoid runaway cost)
- **Timeout:** 30 seconds per call
- **On failure:** Log warning, mark items as processed with a `clarify_error` flag (don't retry indefinitely, don't block)

---

## TypeScript — New File

**File:** `extensions/memory-lancedb/slow-clarify.ts`

```typescript
export class SlowClarify {
  constructor(
    private readonly db: DatabaseSync,
    private readonly store: WorldModelStore,
    private readonly callLLM: (prompt: string) => Promise<string>,
  ) {}

  async shouldRun(): Promise<boolean> {
    const count = (
      this.db.prepare("SELECT COUNT(*) as cnt FROM inbox WHERE processed = 0").get() as any
    ).cnt;
    if (count === 0) return false;
    if (count >= 5) return true;
    const meta = this.store.readMeta();
    const elapsed = Date.now() - (meta.lastSlowClarify ?? 0);
    return elapsed > 30 * 60 * 1000;
  }

  async run(): Promise<{ processed: number; updated: string[] }> {
    // ... implementation per above
  }

  private async processGroup(projectId: string, items: InboxItem[]): Promise<void>;
  private async processReferenceItems(items: InboxItem[]): Promise<void>;
  private async processUnattached(items: InboxItem[]): Promise<void>;
}
```

---

## Done When

- [ ] `SlowClarify` class implemented with `shouldRun()` and `run()`
- [ ] Cron job registered in plugin (fires every 5 min, checks conditions)
- [ ] Sequential processing per group (not parallel)
- [ ] World model patches applied correctly — spot-check: AMF inbox items about run results update `lastRun`
- [ ] Reference items appended to correct reference file
- [ ] Processed items marked in inbox (no double-processing)
- [ ] `meta.lastSlowClarify` updated after each run
- [ ] Milestone transition detection + suggestion creation
- [ ] Graceful error handling — slow Clarify failure doesn't crash plugin
- [ ] 300/300 tests pass (same skip pattern)

---

## Tests

- Unit: `SlowClarify.shouldRun()` returns true at ≥5 items
- Unit: `SlowClarify.shouldRun()` returns true at >30 min with any items
- Unit: `SlowClarify.shouldRun()` returns false with 0 items
- Unit: `SlowClarify.processGroup()` applies patch to world model
- Unit: Milestone transition creates pending suggestion
- Unit: LLM failure marks items processed with error flag, does not throw
- Integration: 5 AMF inbox items → slow Clarify runs → AMF project state updated → inbox drained

---

## Read-First Preamble (for agent)

Before implementing:

1. Read `cr/CR_OPENCLOODA_PHASE1_INBOX_FAST_CLARIFY.md` — understand inbox schema and InboxItem interface
2. Read `cr/CR_OPENCLOODA_PHASE2_WORLD_MODEL.md` — understand WorldModelStore interface and patchProject()
3. Read `extensions/memory-lancedb/index.ts` — understand how LLM calls are made (embeddings client pattern), how cron is registered if already done in Phase 1
4. Read `extensions/memory-ooda/index.ts` — understand how isolated sessions are triggered
5. Describe in 2-3 sentences how the plugin currently handles background/async work before adding SlowClarify
