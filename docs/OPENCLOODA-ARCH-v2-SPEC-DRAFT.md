# OpenCLOODA Architecture v2 — Draft Spec

_Captured: 2026-04-07 from design conversation_

---

## The Problem This Solves

The current OpenCLOODA is a reactive loop. It responds to what's in front of it rather than maintaining a persistent, accurate model of the world. Every session starts from episodic recall — fuzzy, ordered by recency, losing structural context.

Root cause of today's failure (AMF run 11): Orient was degraded because there was no trusted system telling me "here are all open CRs, here is what each covers, here is what's still open." I reconstructed context mid-loop from fragmented memory. Orient was slow, incomplete, and wrong.

---

## The Framework: GTD + OODA + World Model

### OODA — the cockpit

Fast, adaptive, in-the-moment. Boyd's insight: Orient is the dominant phase. If Orient is right, Decide is trivial. If Orient is wrong, no amount of good execution saves you.

**Orient doesn't just synthesize observations — it perceives them through a model.** A bad mental model makes you blind to the evidence that would falsify it. Today: I observed "EmdkModule in output" and my model said "sdk_integration is the source." I never looked for other sources because my model didn't include the manifest as a generative source. The evidence was in the log (line 694). I never looked.

### GTD — the logistics corps

GTD doesn't win battles. But without it, the pilot runs out of fuel, flies the wrong mission, or burns cognitive load in the cockpit wondering what he forgot.

GTD is the complete workflow:

- **Capture** — everything goes into an inbox, nothing gets lost or acted on immediately
- **Clarify** — is it actionable? What's the next action? Project or single action? Or reference?
- **Organize** — projects (outcome + next action), areas of responsibility, reference material, someday/maybe
- **Reflect** — regular review keeps the system trusted; without it, everything rots
- **Engage** — work from the trusted system, not from your head

**GTD is the workflow. OODA is the action.**

GTD runs on a slower cycle (daily/weekly review). OODA runs in real time, turn by turn. Different frequencies, different purposes.

### World Model (Karpathy's LLM Wiki)

Key insight: knowledge should be _compiled once and kept current_, not re-derived from raw sources on every query. The wiki is a persistent, compounding artifact. Cross-references already there, contradictions already flagged, synthesis already reflecting everything accumulated.

**The difference between current OpenCLOODA and the target:**

- Current: "recall what happened" (episodic retrieval, raw)
- Target: "the model of the system is already accurate before the question arrives" (compiled, maintained)

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    OODA (real-time)                     │
│  Observe → Orient → Decide → Act                        │
│                                                         │
│  Orient reads from: World Model (compiled, trusted)     │
│  Orient does NOT read from: raw episodic memory         │
└────────────────────────────┬────────────────────────────┘
                             │ reads
┌────────────────────────────▼────────────────────────────┐
│               World Model (GTD Organize layer)          │
│                                                         │
│  Projects    │ outcome, milestone, blocking, next action│
│  Areas       │ ongoing responsibilities (no end state)  │
│  Reference   │ wiki — compiled knowledge, maintained    │
│  Someday     │ ideas not yet active                     │
└────────────────────────────┬────────────────────────────┘
                             │ maintained by
┌────────────────────────────▼────────────────────────────┐
│               GTD Workflow (slower cycle)               │
│                                                         │
│  Capture   ← Archivist (agent_end hook, turn-by-turn)  │
│  Clarify   ← Orient processes inbox items              │
│  Organize  ← Archivist updates world model             │
│  Reflect   ← Periodic review (daily/weekly)            │
└─────────────────────────────────────────────────────────┘
```

---

## What the World Model Contains

### Projects (GTD: has an outcome, has a next action)

```
id: "amf-platform"
goal: "AI pipeline that reliably migrates any Zebra Android app to Honeywell with certified parity — no manual rework"
successCriteria:
  - BarcodeSample1 VERIFIED (parity ≥80, compiles clean)
  - KDMS parity ≥80
  - zero manual rework required
milestone: "BarcodeSample1 compiles clean, no source SDK in output"
milestoneBlocking:
  - "EMDK_LIFECYCLE in _derive_di_modules() generates EmdkModule"
  - "CR_TAXONOMY_DRIVEN_MANIFEST Fixes 1-3 not implemented"
openCRs:
  - name: CR_TAXONOMY_DRIVEN_MANIFEST
    status: PARTIAL
    fixes: [{n:1, done:false}, {n:2, done:false}, {n:3, done:false}, {n:4, done:true}]
lastRun:
  id: e0ca86cf
  label: run11
  result: ERROR
  rootCause: "EmdkModule from EMDK_LIFECYCLE in manifest, not TPRD feed"
nextAction: "Implement CR_TAXONOMY_DRIVEN_MANIFEST fixes 1-3 + EMDK_LIFECYCLE exclusion, then run 12"
```

### Areas of Responsibility (GTD: ongoing, no completion)

```
- OpenClaw: gateway stability, plugin health, test suite green
- OpenCLOODA: OODA cognitive layer, memory system
- AMF Platform: pipeline reliability
```

### Reference Wiki (Karpathy pattern)

Compiled knowledge, maintained by Archivist:

- System architecture docs (per project)
- Known failure modes + root causes
- Engineering discipline rules (branch = hypothesis, five-why, etc.)
- Key decisions and their rationale

---

## What Changes in OpenCLOODA

### Current gaps (verified today):

| GTD Phase | Current State                             | Missing                              |
| --------- | ----------------------------------------- | ------------------------------------ |
| Capture   | Archivist fires at agent_end              | ✅ exists                            |
| Clarify   | Not implemented                           | ❌ inbox items not processed         |
| Organize  | KNOWLEDGE.json + PRIORITIES.json (static) | ❌ no projects/areas/wiki            |
| Reflect   | Not implemented                           | ❌ no review cycle                   |
| Engage    | SITREP from episodic recall               | ❌ reads raw memory, not world model |

### What needs to be built:

1. **World Model store** — structured JSON/markdown files per GTD category (projects, areas, reference wiki, someday)
2. **Clarify step** — when Archivist captures something, process it: is it actionable? does it update a project? does it go to reference?
3. **Archivist updates world model** — after each significant event (run complete, CR status changed, blocker identified), update the relevant project entry
4. **Orient reads world model first** — before assembling SITREP, pull current project states, open CRs, known blockers
5. **Reflect cycle** — periodic (daily/weekly) review pass: are projects still valid? next actions still correct? what's stale?

### What does NOT change:

- The OODA loop structure (Triage → Strategy → SITREP injection)
- The episodic memory system (still useful for detailed recall)
- The thinking level gating

---

## Key Principle

**Orient is the dominant phase.** The quality of the world model determines the quality of every decision. A bad model makes you blind to evidence that would falsify it — you never look for what your model doesn't include.

The world model must be:

- **Maintained** (not assembled on demand)
- **Compiled** (already synthesized, not raw)
- **Structured** (GTD ontology: projects/areas/reference)
- **Current** (Archivist updates it, Reflect reviews it)

---

## What This Is Not

This is not a CR. It's a design document for the next evolution of OpenCLOODA. CRs will be written from it once the design is stable.

Next step: review this spec, refine, then write the CRs.

---

_References:_

- _Boyd: OODA Loop_
- _Allen: Getting Things Done_
- _Karpathy: LLM Wiki pattern (https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)_
