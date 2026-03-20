# CR: Capability Uplift — Phase 3: SITREP Attention Field + Strategy Visibility

**Date:** 2026-03-19
**Status:** WRITTEN
**Priority:** HIGH — makes triage output actually shape responses
**Effort:** ~3 hours
**Dependency:** None (can run in parallel with Phase 2)
**Files:** `extensions/memory-ooda/types.ts`, `extensions/memory-ooda/triage.ts`,
`extensions/memory-ooda/index.ts`

---

## Problem

The SITREP is injected before every turn as `<ooda-sitrep>` context, but there's
no evidence it's materially changing response quality. Two issues:

**Issue 1: SITREP is summary-heavy, not signal-heavy**

Current output:

```json
{
  "priority": 6,
  "summary": "User asking about AMF pipeline status",
  "conflictsDetected": [],
  "relevantFacts": ["AMF Platform: active project"],
  "recommendedDomains": ["engineering"]
}
```

This is a summary of what was already in the prompt. What the executive model needs
is an _action directive_ — what to emphasize, what to watch for, what mode to be in.
That's the `attention` field.

**Issue 2: Strategy output is invisible**

Strategy fires at medium+ thinking but there's no way to confirm it's producing
useful output vs. timing out or returning empty. During development and calibration,
the raw strategy output must be inspectable.

---

## Changes

### S1 — Add `attention` field to SITREP type

**File:** `extensions/memory-ooda/types.ts`

```typescript
export interface SITREP {
  priority: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
  summary: string;
  conflictsDetected: string[];
  relevantFacts: string[];
  recommendedDomains: string[];
  /** Single imperative sentence (≤15 words) directing the executive on
   *  what to emphasize or watch for this turn. Only present when priority >= 6. */
  attention?: string;
}
```

### S2 — Update triage prompt to produce `attention`

**File:** `extensions/memory-ooda/triage.ts`  
**Function:** the prompt template string in `buildTriagePrompt()`

Add to the output format section:

```
OUTPUT FORMAT — respond with valid JSON only, no markdown fences:
{
  "priority": <1-10>,
  "summary": "<2-3 sentence description of what this turn is about>",
  "conflictsDetected": ["<conflict>" | ...],
  "relevantFacts": ["<fact from context>" | ...],
  "recommendedDomains": ["<domain>" | ...],
  "attention": "<optional — only when priority >= 6: single imperative, ≤15 words>"
}

The "attention" field is a directive to the responding model. Examples:
  "Deadline pressure is high — surface blockers before context."
  "User is debugging a live run — skip theory, go straight to cause."
  "This is client-facing — cite evidence, not opinion."
  "Pattern matches a known failure mode — check for the documented fix first."
  "Multiple open CRs in flight — confirm which is being addressed before proceeding."

Only include "attention" when you have a specific, actionable directive.
Leave it out if the turn is routine.
```

### S3 — Update `parseSITREP` to handle `attention`

**File:** `extensions/memory-ooda/triage.ts`

```typescript
export function parseSITREP(raw: string): SITREP {
  // ... existing parse logic ...
  const sitrep = parsed as SITREP;

  // attention is optional — validate if present
  if (sitrep.attention !== undefined) {
    if (typeof sitrep.attention !== "string" || sitrep.attention.trim().length === 0) {
      delete sitrep.attention; // discard malformed
    }
    // Trim to 15 words max
    const words = sitrep.attention.split(/\s+/);
    if (words.length > 15) {
      sitrep.attention = words.slice(0, 15).join(" ") + "…";
    }
  }

  return sitrep;
}
```

### S4 — Inject `attention` prominently in context

**File:** `extensions/memory-ooda/index.ts`  
**Location:** `before_agent_start` handler, SITREP formatting block

Format the `attention` field as a bolded directive above the SITREP body so it
stands out from the rest of the injected context:

```typescript
// Build SITREP context string
function formatSitrepContext(sitrep: SITREP): string {
  const lines: string[] = [];

  if (sitrep.attention) {
    lines.push(`**ATTENTION:** ${sitrep.attention}`);
    lines.push("");
  }

  lines.push(`Priority: ${sitrep.priority}/10`);
  lines.push(`Summary: ${sitrep.summary}`);

  if (sitrep.relevantFacts.length > 0) {
    lines.push(`Relevant context:`);
    sitrep.relevantFacts.forEach((f) => lines.push(`  - ${f}`));
  }

  if (sitrep.conflictsDetected.length > 0) {
    lines.push(`Conflicts: ${sitrep.conflictsDetected.join(", ")}`);
  }

  return lines.join("\n");
}
```

### S5 — `OODA_DEBUG` strategy output visibility

**File:** `extensions/memory-ooda/index.ts`  
**Location:** `before_agent_start` handler, after strategy runs

When `OODA_DEBUG=true`, append raw strategy output as a visible (but clearly marked)
debug block so it can be inspected during calibration:

```typescript
// After strategyResult is obtained:
if (process.env.OODA_DEBUG === "true" && strategyResult) {
  parts.push(
    `<ooda-strategy-debug>\n${JSON.stringify(strategyResult, null, 2)}\n</ooda-strategy-debug>`,
  );
  api.logger.debug("OODA_DEBUG: strategy output injected into context");
}
```

---

## Tests

Add to `extensions/memory-ooda/triage.test.ts`:

```typescript
describe("SITREP attention field", () => {
  it("parseSITREP accepts attention when present", () => {
    const raw = JSON.stringify({
      priority: 8,
      summary: "Debugging live run",
      conflictsDetected: [],
      relevantFacts: [],
      recommendedDomains: ["engineering"],
      attention: "Go straight to cause — user is debugging live.",
    });
    const sitrep = parseSITREP(raw);
    expect(sitrep.attention).toBe("Go straight to cause — user is debugging live.");
  });

  it("parseSITREP accepts missing attention", () => {
    const raw = JSON.stringify({
      priority: 4,
      summary: "Routine question",
      conflictsDetected: [],
      relevantFacts: [],
      recommendedDomains: [],
    });
    const sitrep = parseSITREP(raw);
    expect(sitrep.attention).toBeUndefined();
  });

  it("parseSITREP trims attention to 15 words", () => {
    const raw = JSON.stringify({
      priority: 7,
      summary: "Test",
      conflictsDetected: [],
      relevantFacts: [],
      recommendedDomains: [],
      attention:
        "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen",
    });
    const sitrep = parseSITREP(raw);
    const words = sitrep.attention!.replace("…", "").trim().split(/\s+/);
    expect(words.length).toBeLessThanOrEqual(15);
  });

  it("parseSITREP discards empty attention string", () => {
    const raw = JSON.stringify({
      priority: 7,
      summary: "Test",
      conflictsDetected: [],
      relevantFacts: [],
      recommendedDomains: [],
      attention: "",
    });
    const sitrep = parseSITREP(raw);
    expect(sitrep.attention).toBeUndefined();
  });
});
```

---

## Acceptance Criteria

- [ ] `parseSITREP` passes all new tests + all 41 existing triage tests
- [ ] `attention` field present in SITREP output for high-priority turns (priority >= 6) in manual test
- [ ] `attention` absent for routine low-priority turns
- [ ] `OODA_DEBUG=true ./openclaw` shows strategy JSON in injected context
- [ ] `OODA_DEBUG` unset (default) shows no debug block — no noise in production
- [ ] 279 OODA tests pass
