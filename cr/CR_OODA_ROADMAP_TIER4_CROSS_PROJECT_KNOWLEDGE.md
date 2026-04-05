# CR_OODA_ROADMAP_TIER4_CROSS_PROJECT_KNOWLEDGE

**Priority:** P1  
**Date:** 2026-04-05  
**Status:** WRITTEN  
**Tier:** 4 — Cross-project knowledge  
**Depends on:** Tier 2 (outcome labeling for quality signals)  
**Goal:** AMF pipeline knowledge informs OODA decisions and vice versa. The KnowledgeHarvester (wired into AMF) produces structured findings; OODA should consume them at Orient time.

---

## Problem

Knowledge is siloed. AMF pipeline runs produce forensic reports, CR retrospectives, parity patterns — all in `amf-platform/cr/`. The OODA agent's KNOWLEDGE.json has hand-curated facts about projects but doesn't pull from live run data. If KohlsCore consistently fails on module scoping (as it did today with the colon prefix bug), that pattern should surface in the OODA SITREP for the next AMF session — not have to be rediscovered.

Conversely, OODA `lessons_learned` about architecture decisions should be surfaceable to the AMF KnowledgeHarvester so the pipeline agents benefit from cross-run learning.

---

## Design

### K1 — AMF KnowledgeHarvester → OODA episodic import

The KnowledgeHarvester in AMF (`forensic_orchestrator.py` post-report, `worker.py` post-assembly) already produces structured JSON at the end of each run. Create an import bridge:

**New file:** `scripts/import-amf-knowledge.ts`

```typescript
// Reads AMF output dir for completed runs, extracts:
// - CR STATUS.md (IMPLEMENTED entries → lessons)
// - parity_report.json (score, gaps)
// - ARCHITECTURE_REPORT.md (key findings)
// Stores each as episodic memory with source="amf_harvester", category="domain_context"

async function importAMFKnowledge(amfOutputDir: string): Promise<number> {
  const runs = await findCompletedRuns(amfOutputDir);
  let imported = 0;
  for (const run of runs) {
    if (await alreadyImported(run.appId)) continue;
    const findings = await extractRunFindings(run);
    for (const finding of findings) {
      await episodic.store({
        text: finding.text,
        importance: finding.importance,
        category: "domain_context",
        source: "amf_harvester",
        actionId: finding.crId, // link to CR for outcome tracking
      });
      imported++;
    }
    await markImported(run.appId);
  }
  return imported;
}
```

### K2 — Trigger: cron job for AMF import

Add a daily cron (or on-demand via `memory_backfill` tool variant) that runs `import-amf-knowledge.ts` and imports new findings since last run.

### K3 — OODA → AMF knowledge export

When the Archivist updates `lessons_learned` with patterns relevant to AMF (detected by keyword: "pipeline", "forensic", "gradle", "kotlin", "parity", "agent"), write a summary to a shared knowledge file:

**New file:** `amf-platform/knowledge/ooda-lessons.json`

```json
{
  "lastUpdated": "2026-04-05T...",
  "lessons": [
    {
      "id": "lesson-001",
      "text": "TOML catalog pollution from concurrent agent writes — use exact alias dedup not substring",
      "source": "ooda_archivist",
      "confidence": 0.9,
      "outcomeLabeled": true
    }
  ]
}
```

AMF agents can optionally read this at prompt injection time (Phase 5 knowledge injection in orchestrator).

### K4 — Orient phase: cross-project recall

In `before_agent_start`, when `domain` context is AMF-related (detected from user message keywords), explicitly recall memories tagged `source="amf_harvester"` in addition to the standard semantic recall:

```typescript
if (isAMFContext(userMessage)) {
  const amfMemories = await episodic.search("amf pipeline parity compile error", {
    source: "amf_harvester",
    limit: 5,
  });
  // Prepend to recall context
}
```

### K5 — KNOWLEDGE.json auto-update from imports

When significant AMF findings are imported (high importance, outcome-labeled success), the Archivist's next run should consider them for `KNOWLEDGE.json` promotion:

- parity score improvement pattern → `domain_context.amf_pipeline`
- recurring failure mode → `lessons_learned`
- architectural decision that held across runs → `domain_context`

---

## Files to Change

| File                                  | Change                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------- |
| `scripts/import-amf-knowledge.ts`     | NEW — AMF run findings → episodic memory importer                           |
| `extensions/memory-ooda/index.ts`     | K4: AMF-context recall in before_agent_start                                |
| `extensions/memory-ooda/archivist.ts` | K3: Write amf-platform/knowledge/ooda-lessons.json for AMF-relevant lessons |
| `package.json` / cron config          | K2: Daily import cron                                                       |

---

## Tests Required

1. `importAMFKnowledge` correctly parses a parity_report.json and CR STATUS.md
2. `alreadyImported` prevents duplicate imports on re-run
3. AMF-context recall returns amf_harvester-sourced memories
4. Archivist writes ooda-lessons.json when AMF-relevant lessons exist
5. Idempotency: running import twice doesn't create duplicates
