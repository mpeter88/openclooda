# CR_OPENCLOODA_PHASE4_ORIENT_WORLD_MODEL

**Status:** WRITTEN  
**Priority:** P1  
**Estimated effort:** 3-4 hours  
**Phase:** 4 of 5 (see OPENCLOODA-ARCH-v2-SPEC.md)  
**Depends on:** Phase 1 (inbox), Phase 2 (world model store + bootstrap), Phase 3 (slow Clarify keeping world model current)  
**Spec reference:** `docs/OPENCLOODA-ARCH-v2-SPEC.md` — Flow 3 (Orient reads World Model)

---

## What This Builds

Orient's upgrade from raw episodic recall to compiled world model. Before assembling the SITREP, Orient reads the world model index and relevant project/area details. Episodic memory becomes supplementary — used for detail queries ("what exactly happened on run 9?"), not for structural context.

This is the phase that makes the system actually useful. After Phase 4, Orient knows where we are without having to reconstruct it.

---

## Current vs Target

**Current (Phase 3 and before):**

```
before_agent_start:
  1. Triage runs — priority/domain/thinking level
  2. Strategy runs — SITREP from episodic memory recall
  3. SITREP injected into context
```

**After Phase 4:**

```
before_agent_start:
  1. Triage runs — priority/domain/thinking level
  2. [NEW] World model read — index + relevant project files
  3. Strategy runs — SITREP from world model (primary) + episodic (supplementary)
  4. SITREP injected into context
```

---

## World Model Read Logic

**File:** `extensions/memory-ooda/index.ts` — in `before_agent_start` hook, before strategy call.

```typescript
async function readWorldModelContext(
  store: WorldModelStore,
  incomingMessage: string,
): Promise<WorldModelContext> {
  if (!store.isBootstrapped()) {
    return { bootstrapRequired: true, projects: [], areas: [], suggestions: [] };
  }

  const index = store.readIndex();
  const meta = store.readMeta();

  // Determine relevant projects:
  // 1. All active projects (always relevant)
  // 2. Paused projects only if mentioned in incoming message
  const activeProjects = index.projects.filter((p) => p.status === "active");
  const pausedMentioned = index.projects.filter(
    (p) => p.status === "paused" && incomingMessage.toLowerCase().includes(p.name.toLowerCase()),
  );
  const relevantProjectIds = [
    ...activeProjects.map((p) => p.id),
    ...pausedMentioned.map((p) => p.id),
  ];

  // Read full project details (cap at 5 for token budget)
  const projects = relevantProjectIds
    .slice(0, 5)
    .map((id) => store.readProject(id))
    .filter((p): p is ProjectState => p !== null);

  // All areas (small, always relevant)
  const areas = index.areas
    .map((a) => store.readArea(a.id))
    .filter((a): a is AreaState => a !== null);

  // Pending suggestions
  const suggestions = meta.pendingProjectSuggestions.filter((s) => !s.dismissedAt);

  // Always-relevant reference pages
  const engineeringDiscipline = store.readReference("engineering-discipline.md");

  return { projects, areas, suggestions, engineeringDiscipline, bootstrapRequired: false };
}
```

---

## SITREP Rendering

**World model section injected into SITREP before episodic context:**

```typescript
function renderWorldModelContext(ctx: WorldModelContext): string {
  if (ctx.bootstrapRequired) {
    return BOOTSTRAP_PROMPT; // handled separately
  }

  let out = "";

  if (ctx.projects.length > 0) {
    out += "\n## Active Projects\n";
    for (const p of ctx.projects) {
      out += `\n**${p.name}**\n`;
      out += `Goal: ${p.goal}\n`;
      out += `Milestone: ${p.milestone}\n`;

      if (p.milestoneBlocking.length > 0) {
        out += `Blocking: ${p.milestoneBlocking.join("; ")}\n`;
      } else {
        out += `Blocking: none\n`;
      }

      if (p.lastRun) {
        out += `Last run: ${p.lastRun.label} — ${p.lastRun.result}`;
        if (p.lastRun.rootCause) out += ` (${p.lastRun.rootCause})`;
        out += "\n";
      }

      out += `Next action: ${p.nextAction}\n`;

      const openCRs = p.openCRs.filter((cr) => cr.status !== "IMPLEMENTED");
      if (openCRs.length > 0) {
        out += `Open CRs: ${openCRs.map((cr) => `${cr.name} (${cr.status})`).join(", ")}\n`;
      }
    }
  }

  if (ctx.areas.length > 0) {
    out += "\n## Areas\n";
    for (const a of ctx.areas) {
      out += `- **${a.name}**: ${a.currentStatus}\n`;
    }
  }

  if (ctx.engineeringDiscipline) {
    out += "\n## Engineering Discipline\n";
    // Trim to key rules only — full file is too long for every turn
    out += extractKeyRules(ctx.engineeringDiscipline); // first 500 chars
  }

  if (ctx.suggestions.length > 0) {
    out += "\n## Suggestions\n";
    for (const s of ctx.suggestions) {
      out += `- ${s.sampleText}\n`;
    }
  }

  return out;
}
```

---

## Episodic Memory — Supplementary Role

Episodic memory (`memory_recall`) is NOT removed. It shifts to:

1. **Detail queries** — when someone asks "what exactly happened on run 9?" or "what did we decide about ProfileManager?" → episodic recall provides the verbatim record
2. **Gap filling** — when world model has no entry for something mentioned → fall back to episodic
3. **Bootstrap** — when world model bootstrap hasn't happened yet → episodic is still primary

**Change to strategy.ts / triage.ts:**

```typescript
// OLD: episodic recall first, always
const memories = await recallEpisodic(incomingMessage);
const sitrep = buildSitrep(memories);

// NEW: world model first, episodic supplementary
const worldCtx = await readWorldModelContext(store, incomingMessage);
const worldSection = renderWorldModelContext(worldCtx);

// Episodic only for detail/gap-fill, or if world model not bootstrapped
let episodicSection = "";
if (worldCtx.bootstrapRequired || thinkingLevel === "high") {
  const memories = await recallEpisodic(incomingMessage);
  episodicSection = renderEpisodicSection(memories);
}

const sitrep = worldSection + episodicSection;
```

At `thinking: medium` — world model only (fast, cheap).
At `thinking: high` — world model + episodic recall (thorough).
Bootstrap required — episodic primary (fallback until world model exists).

---

## Token Budget

World model context token estimate per turn:

- Index: ~200 tokens (small, always read)
- 3 active projects × ~300 tokens each = ~900 tokens
- Areas: ~100 tokens
- Engineering discipline excerpt: ~200 tokens
- Suggestions: ~100 tokens
- **Total: ~1,500 tokens**

This is acceptable. It's always-fresh structured data vs ~1,000 tokens of fuzzy episodic recall that may or may not be relevant.

---

## Bootstrap Handling

If `isBootstrapped() === false`:

1. Inject bootstrap prompt into SITREP (see Phase 2 CR for prompt text)
2. Skip world model read (nothing to read)
3. Skip episodic recall for structural context (bootstrap takes priority)
4. Agent conducts bootstrap conversation as part of normal response

Bootstrap is a one-time event. After it completes, every subsequent session gets full world model context.

---

## Done When

- [ ] `readWorldModelContext()` function reads index + relevant projects + areas + suggestions
- [ ] `renderWorldModelContext()` produces clean markdown section
- [ ] World model section appears before episodic in SITREP
- [ ] Episodic recall only at `thinking: high` or bootstrap-required
- [ ] Bootstrap prompt injected when `isBootstrapped() === false`
- [ ] Token budget respected — world model section ≤ 2,000 tokens
- [ ] Engineering discipline excerpt (first 500 chars) always included
- [ ] Suggestions surfaced from meta.json (upgraded from Phase 1's DB query)
- [ ] 300/300 tests pass

---

## Tests

- Unit: `readWorldModelContext()` returns correct projects for active status
- Unit: `renderWorldModelContext()` produces valid markdown with all sections
- Unit: paused project included only when mentioned in incoming message
- Unit: bootstrap prompt returned when `isBootstrapped() === false`
- Unit: `thinking: medium` → no episodic recall; `thinking: high` → episodic included
- Integration: after Phase 3 update, SITREP reflects updated project state

---

## Read-First Preamble (for agent)

Before implementing:

1. Read `extensions/memory-ooda/index.ts` — understand exactly where SITREP is assembled, what `strategy.ts` and `triage.ts` do, and where context injection happens
2. Read `cr/CR_OPENCLOODA_PHASE2_WORLD_MODEL.md` — understand `WorldModelStore` interface, specifically `readIndex()`, `readProject()`, `readArea()`, `readMeta()`
3. Read `cr/CR_OPENCLOODA_PHASE3_SLOW_CLARIFY.md` — understand what slow Clarify writes to the world model so Orient reads fresh data
4. Describe in 2-3 sentences how the current SITREP injection works (what goes in, in what order) before modifying it
