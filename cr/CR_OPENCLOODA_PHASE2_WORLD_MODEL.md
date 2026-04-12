# CR_OPENCLOODA_PHASE2_WORLD_MODEL

**Status:** WRITTEN  
**Priority:** P1  
**Estimated effort:** 4-5 hours  
**Phase:** 2 of 5 (see OPENCLOODA-ARCH-v2-SPEC.md)  
**Depends on:** CR_OPENCLOODA_PHASE1_INBOX_FAST_CLARIFY (inbox + topic_tracker tables exist)  
**Spec reference:** `docs/OPENCLOODA-ARCH-v2-SPEC.md` — World Model Store + Bootstrap + Flow 3 (partial)

---

## What This Builds

The world model store — structured files representing projects, areas, reference wiki, and an index. A conversation-driven bootstrap flow that populates the initial state by asking the user about each active project. After this phase, the world model exists and is human-readable; it just isn't updated automatically yet (that's Phase 3).

Also upgrades Phase 1's `pertains_to` from KNOWLEDGE.json IDs to world model project IDs.

---

## Directory Structure

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
  reference/
    engineering-discipline.md
    [project-id]-decisions.md     (created on demand)
  someday/
    ideas.json
  index.json                      ← flat index, always current
  meta.json                       ← last reflect, pending suggestions, bootstrap status
```

Path: `~/.openclaw/world-model/` — hardcoded, same convention as `~/.openclaw/memory/`.

---

## Schemas

### Project (`.json`)

```typescript
interface ProjectState {
  id: string; // "amf-platform"
  name: string; // "AMF Platform"

  // Stable
  goal: string;
  successCriteria: string[];

  // Milestone
  milestone: string;
  milestoneBlocking: string[];

  // Tactical
  openCRs: {
    name: string;
    status: "WRITTEN" | "PARTIAL" | "IMPLEMENTED";
    fixes?: { n: number; done: boolean }[];
  }[];
  lastRun?: {
    id: string;
    label: string;
    result: string;
    parity?: number;
    rootCause?: string;
  };
  nextAction: string;

  // Metadata
  createdAt: number;
  updatedAt: number;
  status: "active" | "paused" | "complete";
}
```

### Area (`.json`)

```typescript
interface AreaState {
  id: string; // "openclaw-gateway"
  name: string; // "OpenClaw Gateway"
  description: string; // what "healthy" looks like
  currentStatus: string; // brief current state
  lastChecked: number;
  updatedAt: number;
}
```

### Index (`index.json`)

```typescript
interface WorldModelIndex {
  version: number;
  updatedAt: number;
  projects: {
    id: string;
    name: string;
    status: "active" | "paused" | "complete";
    milestone: string;
    nextAction: string;
    updatedAt: number;
  }[];
  areas: {
    id: string;
    name: string;
    currentStatus: string;
    updatedAt: number;
  }[];
  reference: {
    filename: string;
    title: string;
    updatedAt: number;
  }[];
}
```

### Meta (`meta.json`)

```typescript
interface WorldModelMeta {
  bootstrapComplete: boolean;
  bootstrapCompletedAt?: number;
  lastReflect?: number;
  lastSlowClarify?: number;
  pendingProjectSuggestions: {
    topicKey: string;
    sampleText: string;
    suggestedAt: number;
  }[];
}
```

---

## Bootstrap Flow

**Trigger:** On first `before_agent_start` call when `meta.json.bootstrapComplete === false` (or meta.json doesn't exist).

**Behavior:** Agent enters a guided conversation to populate the world model. Not a tool call — the agent conducts this as part of its normal response.

**Bootstrap prompt injected into SITREP:**

```
## World Model Bootstrap Required

Your world model is empty. Before we start, let's set it up — it will take about 5 minutes and will make every future session significantly better.

I'll ask you about each of your active projects, one at a time.

**First project: AMF Platform**

1. What is the overall goal? (one sentence)
2. What are the success criteria? (what does "done" look like?)
3. What is the current milestone?
4. What's blocking the current milestone? (or "nothing" if unblocked)
5. What's the next action?

(You can say "skip" for any project or "done" to finish early)
```

**Bootstrap conversation loop:**

- Agent collects answers, writes project JSON after each project is confirmed
- Updates index.json after each write
- Moves to next project
- After all projects: asks about areas ("What ongoing responsibilities should I track?")
- Writes meta.json with `bootstrapComplete: true` when finished
- Notifies user: "World model bootstrapped. I'll keep it current from here."

**Known projects to bootstrap (from KNOWLEDGE.json + memory):**

- AMF Platform
- Dreamboard
- IEP Champion
- OpenCLOODA
- OpenClaw (as area, not project)

---

## WorldModelStore — TypeScript class

**File:** `extensions/memory-lancedb/world-model-store.ts`

```typescript
class WorldModelStore {
  private readonly basePath: string; // ~/.openclaw/world-model

  constructor(basePath: string) {
    this.basePath = basePath;
    fs.mkdirSync(path.join(basePath, "projects"), { recursive: true });
    fs.mkdirSync(path.join(basePath, "areas"), { recursive: true });
    fs.mkdirSync(path.join(basePath, "reference"), { recursive: true });
    fs.mkdirSync(path.join(basePath, "someday"), { recursive: true });
  }

  // Projects
  readProject(id: string): ProjectState | null;
  writeProject(project: ProjectState): void; // updates index + file
  listProjects(status?: "active" | "paused" | "complete"): ProjectState[];
  patchProject(id: string, patch: Partial<ProjectState>): void;

  // Areas
  readArea(id: string): AreaState | null;
  writeArea(area: AreaState): void;
  listAreas(): AreaState[];

  // Reference
  readReference(filename: string): string | null;
  writeReference(filename: string, title: string, content: string): void;
  listReference(): { filename: string; title: string; updatedAt: number }[];

  // Index
  readIndex(): WorldModelIndex;
  private rebuildIndex(): void; // called after every write

  // Meta
  readMeta(): WorldModelMeta;
  writeMeta(meta: WorldModelMeta): void;

  // Bootstrap
  isBootstrapped(): boolean; // meta.bootstrapComplete

  // Utilities
  private filePath(category: string, id: string): string;
  private atomicWrite(filePath: string, content: string): void; // write to .tmp then rename
}
```

**Atomic writes:** All writes go to `.tmp` file first, then `fs.renameSync` — prevents partial reads if a session is killed mid-write.

---

## Orient Integration (Phase 2 upgrade)

Phase 1 only surfaced project suggestions. Phase 2 upgrades Orient to read the full world model index + active project details.

In `extensions/memory-ooda/index.ts` (or strategy/triage):

```typescript
// Before assembling SITREP:
const store = new WorldModelStore(worldModelPath);

if (!store.isBootstrapped()) {
  // Inject bootstrap prompt — handled by agent conversation
  sitrep += BOOTSTRAP_PROMPT;
} else {
  const index = store.readIndex();
  const activeProjects = index.projects.filter((p) => p.status === "active");

  // Read full detail for relevant projects (all active, capped at 3 for token budget)
  const projectDetails = activeProjects
    .slice(0, 3)
    .map((p) => store.readProject(p.id))
    .filter(Boolean);

  sitrep += renderWorldModelSection(projectDetails, index.areas);

  // Pending suggestions (upgraded from Phase 1's DB query)
  const meta = store.readMeta();
  if (meta.pendingProjectSuggestions.length > 0) {
    sitrep += renderSuggestions(meta.pendingProjectSuggestions);
  }
}
```

**Renderer:**

```typescript
function renderWorldModelSection(projects: ProjectState[], areas: AreaState[]): string {
  let out = "\n## World Model\n";

  if (projects.length > 0) {
    out += "\n### Active Projects\n";
    for (const p of projects) {
      out += `**${p.name}**\n`;
      out += `Goal: ${p.goal}\n`;
      out += `Milestone: ${p.milestone}\n`;
      if (p.milestoneBlocking.length > 0) {
        out += `Blocking: ${p.milestoneBlocking.join("; ")}\n`;
      }
      if (p.lastRun) {
        out += `Last run: ${p.lastRun.label} — ${p.lastRun.result}`;
        if (p.lastRun.rootCause) out += ` (${p.lastRun.rootCause})`;
        out += "\n";
      }
      out += `Next action: ${p.nextAction}\n`;
      if (p.openCRs.length > 0) {
        const openCRs = p.openCRs.filter((cr) => cr.status !== "IMPLEMENTED");
        if (openCRs.length > 0) {
          out += `Open CRs: ${openCRs.map((cr) => `${cr.name} (${cr.status})`).join(", ")}\n`;
        }
      }
      out += "\n";
    }
  }

  return out;
}
```

**Also upgrade fast Clarify in Phase 1:** Replace KNOWLEDGE.json project ID list with `store.listProjects('active').map(p => p.id)`.

---

## Reference Wiki — Seed Content

On bootstrap completion, create initial reference files:

**`engineering-discipline.md`** — seeded with:

```markdown
# Engineering Discipline

## Branch = Hypothesis, Main = Certified

- main only receives merges validated end-to-end
- Feature branches are hypotheses — never merge incomplete features
- Merge = parity certificate, not a time gate

## Five-Why Rule

Never stop at the proximate cause. Keep asking "why" until you hit a structural/design gap.
Coherence ≠ correctness — a confident fluent answer is not a verified one.

## Verify Before Commit

- Partial fix ≠ full fix — state explicitly which fixes are in before running
- After Claude Code returns: verify each fix against the CR's list, not just "tests pass"
- Never mark a CR IMPLEMENTED until all fixes confirmed in code
- Never start a validation run until all CRs targeting that failure are fully implemented

## CR Discipline

- CRs are the spec. Agents read the CR file directly — never paraphrase.
- Read existing code before implementing — agents must know what already exists.
- Root cause before writing the fix.
```

---

## Done When

- [ ] `~/.openclaw/world-model/` directory structure created on init
- [ ] `WorldModelStore` class with all read/write/patch methods
- [ ] Atomic writes (`.tmp` + rename) on all file writes
- [ ] `index.json` rebuilt after every project/area write
- [ ] Bootstrap conversation triggers on first session without world model
- [ ] Bootstrap produces valid project JSON files
- [ ] Orient reads world model index + active projects in SITREP
- [ ] `engineering-discipline.md` seeded on bootstrap completion
- [ ] Fast Clarify (Phase 1) upgraded to use world model project IDs instead of KNOWLEDGE.json
- [ ] 300/300 tests pass (or same skip pattern)

---

## Tests

- Unit: `WorldModelStore.writeProject` → file exists, index updated
- Unit: `WorldModelStore.patchProject` → only patched fields change
- Unit: `WorldModelStore.atomicWrite` → no partial file on simulated crash
- Unit: `renderWorldModelSection` → correct markdown output for known project
- Unit: `isBootstrapped()` returns false when meta.json missing
- Integration: bootstrap conversation → world model files created for 2+ projects
- Integration: Orient SITREP contains world model section with correct project data

---

## Read-First Preamble (for agent)

Before implementing:

1. Read `extensions/memory-lancedb/index.ts` — understand existing store, Archivist, and how `memories.sqlite` path is derived (same parent dir as world model)
2. Read `extensions/memory-ooda/index.ts` — understand where SITREP is assembled and how context is injected
3. Read `~/.openclaw/memory/lancedb/` to confirm path conventions
4. Read `cr/CR_OPENCLOODA_PHASE1_INBOX_FAST_CLARIFY.md` to understand Phase 1 changes this builds on
5. Describe existing SITREP assembly in 2-3 sentences before adding to it
