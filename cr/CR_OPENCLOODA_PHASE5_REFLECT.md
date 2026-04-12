# CR_OPENCLOODA_PHASE5_REFLECT

**Status:** WRITTEN  
**Priority:** P2  
**Estimated effort:** 3-4 hours  
**Phase:** 5 of 5 (see OPENCLOODA-ARCH-v2-SPEC.md)  
**Depends on:** All prior phases  
**Spec reference:** `docs/OPENCLOODA-ARCH-v2-SPEC.md` — Flow 4 (Reflect)

---

## What This Builds

The world model's immune system. Reflect is a heavier, periodic review that checks the world model for staleness, contradictions, and missed transitions. It surfaces items needing human review and keeps the world model healthy over time.

**The system is only as good as its Reflect cycle.** Without Reflect, the world model drifts from reality as fast as it's maintained.

---

## Trigger Conditions

Activity-triggered — NOT time-triggered as primary:

**Fire when either:**

- 50 significant episodic events since `meta.lastReflect`, OR
- 7 days since `meta.lastReflect` (safety net — prevents silent drift during low-activity periods)

**Significant events** = episodic memories with `category IN ('decision', 'fact')` OR `importance >= 0.7`.

Count tracked in `meta.json.eventsSinceLastReflect` — incremented by Archivist on each store.

Runs in an **isolated session** (not blocking conversation). Delivers result as proactive notification.

---

## Reflect Process

### Step 1 — Collect inputs

```typescript
const worldModel = {
  projects: store.listProjects(),
  areas: store.listAreas(),
  reference: store.listReference(),
};

// Recent episodic events since last Reflect
const recentEvents = await episodicStore.query(
  { since: meta.lastReflect ?? 0, minImportance: 0.6 },
  { limit: 100 }, // cap — don't feed everything
);

const lastReflectSummary = meta.lastReflectSummary ?? "No previous reflect.";
```

### Step 2 — Reflect LLM call

**Model:** Claude Sonnet or Gemini Pro — quality matters here. This is the expensive call.

```typescript
const prompt = `
You are reviewing a personal knowledge management system's world model for accuracy and currency.

Last reflect summary: ${lastReflectSummary}

Current world model:
${JSON.stringify(worldModel, null, 2)}

Recent events (since last reflect):
${recentEvents.map((e) => `- [${e.category}] ${e.text}`).join("\n")}

Review the world model against recent events. For each project:
1. Is the milestone still accurate based on recent events?
2. Is the next action still correct?
3. Are any open CRs actually implemented (evidence in recent events)?
4. Are there patterns worth adding to the reference wiki?
5. Are any blockers now resolved?

For each area:
1. Is the status still current?

Also check: are there any pending project suggestions that should be confirmed or dismissed?

Return JSON:
{
  "patches": [
    { "type": "project", "id": "...", "patch": { ...only changed fields... }, "reason": "..." },
    { "type": "area", "id": "...", "patch": {...}, "reason": "..." }
  ],
  "new_reference_entries": [
    { "filename": "...", "title": "...", "content": "..." }
  ],
  "review_items": [
    { "severity": "high|medium|low", "message": "...", "action_required": true|false }
  ],
  "summary": "one paragraph summary of what changed and why"
}
`;
```

### Step 3 — Apply patches

```typescript
for (const patch of result.patches) {
  if (patch.type === "project") {
    store.patchProject(patch.id, { ...patch.patch, updatedAt: Date.now() });
    logger.info(`Reflect: updated project ${patch.id} — ${patch.reason}`);
  } else if (patch.type === "area") {
    store.patchArea(patch.id, { ...patch.patch, updatedAt: Date.now() });
  }
}

for (const entry of result.new_reference_entries) {
  const existing = store.readReference(entry.filename) ?? "";
  store.writeReference(
    entry.filename,
    entry.title,
    existing +
      `\n\n## Added by Reflect ${new Date().toISOString().split("T")[0]}\n\n${entry.content}`,
  );
}
```

### Step 4 — Surface review items and update meta

```typescript
// Update meta
store.writeMeta({
  ...meta,
  lastReflect: Date.now(),
  eventsSinceLastReflect: 0,
  lastReflectSummary: result.summary,
});

// Deliver notification if review items exist
if (result.review_items.length > 0) {
  const highItems = result.review_items.filter((i) => i.severity === "high");
  const notification = [
    `## Reflect Complete`,
    result.summary,
    "",
    ...(highItems.length > 0
      ? [
          "### Items Needing Attention",
          ...highItems.map((i) => `- [${i.severity.toUpperCase()}] ${i.message}`),
        ]
      : []),
    "",
    `${result.patches.length} world model updates applied.`,
  ].join("\n");

  // Send notification to user's active channel
  await api.sendNotification(notification);
} else {
  // Silent if nothing notable
  logger.info(`Reflect: complete, ${result.patches.length} patches, no review items`);
}
```

---

## Cron Registration

```typescript
api.cron.add({
  name: "memory-lancedb-reflect",
  schedule: { kind: "every", everyMs: 60 * 60 * 1000 }, // check every hour
  payload: {
    kind: "agentTurn",
    message:
      "Check Reflect conditions: read meta.json.eventsSinceLastReflect and meta.json.lastReflect. Run Reflect if ≥50 events since last reflect OR 7+ days since last reflect. If conditions not met, HEARTBEAT_OK.",
    timeoutSeconds: 300, // Reflect is a longer operation
  },
  sessionTarget: "isolated",
  delivery: { mode: "announce" }, // announce because Reflect produces user-visible output
});
```

**Archivist event counter update (in Phase 1's Archivist code):**

```typescript
// After storing to episodic memory, increment reflect counter
if (importance >= 0.6 || category === "decision") {
  const meta = store.readMeta();
  store.writeMeta({
    ...meta,
    eventsSinceLastReflect: (meta.eventsSinceLastReflect ?? 0) + 1,
  });
}
```

---

## What Reflect Does NOT Do

- Does NOT delete world model entries (only patches and additions)
- Does NOT make decisions for the user (proposes, doesn't apply milestone transitions)
- Does NOT run slowly on every turn (isolated, async, infrequent)
- Does NOT replace Slow Clarify (Slow Clarify handles inbox drain; Reflect handles strategic review)

---

## Reflect vs Slow Clarify — Distinction

|                  | Slow Clarify                          | Reflect                                        |
| ---------------- | ------------------------------------- | ---------------------------------------------- |
| **Frequency**    | Every 30 min (when inbox ≥5)          | Every ~50 events or 7 days                     |
| **Input**        | Inbox items                           | Full world model + recent episodic             |
| **Output**       | World model patches from observations | Strategic review + staleness detection         |
| **Model**        | gemini-flash (cheap)                  | claude-sonnet / gemini-pro (quality)           |
| **Scope**        | Tactical (what changed today)         | Strategic (is the world model still accurate?) |
| **Notification** | Silent                                | Announce if review items                       |

---

## Done When

- [ ] `Reflect` class with `shouldRun()` and `run()` implemented
- [ ] Cron job registered (hourly check, condition gated)
- [ ] Archivist increments `eventsSinceLastReflect` on significant events
- [ ] Reflect fires at 50 events and 7-day safety net
- [ ] World model patches applied correctly
- [ ] New reference entries written
- [ ] Notification delivered when review items exist
- [ ] `meta.lastReflect` and `lastReflectSummary` updated
- [ ] 300/300 tests pass

---

## Tests

- Unit: `Reflect.shouldRun()` returns true at ≥50 events
- Unit: `Reflect.shouldRun()` returns true at >7 days
- Unit: `Reflect.shouldRun()` returns false at <50 events and <7 days
- Unit: Reflect patch applied correctly to world model
- Unit: New reference entry appended correctly
- Unit: No notification sent when review_items empty
- Integration: 50 simulated events → Reflect fires → world model updated → notification if needed

---

## Read-First Preamble (for agent)

Before implementing:

1. Read all prior phase CRs (1-4) to understand what exists
2. Read `extensions/memory-lancedb/index.ts` — understand how cron is registered and how notifications are sent
3. Read `extensions/memory-ooda/index.ts` — understand isolated session patterns already used
4. Describe in 2-3 sentences how the existing Archivist stores events and what `importance` field is used for
