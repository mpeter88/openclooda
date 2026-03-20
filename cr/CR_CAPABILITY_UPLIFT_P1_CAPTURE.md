# CR: Capability Uplift — Phase 1: Episodic Capture Enrichment

**Date:** 2026-03-19
**Status:** WRITTEN
**Priority:** P0 — prerequisite for all subsequent phases
**Effort:** ~30 min
**Files:** `extensions/memory-lancedb/index.ts`

---

## Problem

`isSubstantiveAssistantTurn()` requires one of 10 specific regex patterns to fire.
A session like 2026-03-19 (architectural analysis, bug reports, code review, 8-hour
active session) produced **8 episodic memories**. A well-calibrated session should
produce 20-50. The consequence: `autoRecall` finds nothing relevant on subsequent
turns because the store is near-empty.

Two root causes:

1. Signal patterns are too narrow — miss most reasoning/recommendation turns
2. Assistant captures weighted at `importance: 0.5` — lower than user messages,
   first to be evicted on pruning passes

---

## Changes

### C1 — Broaden `isSubstantiveAssistantTurn`

**File:** `extensions/memory-lancedb/index.ts`  
**Function:** `isSubstantiveAssistantTurn(text: string): boolean`

Replace the existing 10-pattern list with 22 patterns across four categories,
plus a length-floor fallback:

```typescript
export function isSubstantiveAssistantTurn(text: string): boolean {
  if (text.length < 120) return false;
  if (text.includes("<relevant-memories>") || text.includes("<ooda-notice>")) return false;

  const INSIGHT_SIGNALS = [
    // --- existing: analysis + decisions ---
    /\broot cause\b/i,
    /\bdiscrepancy\b|\bmismatch\b|\bgap\b/i,
    /\bdecision\b|\bdecided\b|\bchose\b/i,
    /\bconfirmed\b|\bverified\b|\bfound\b/i,
    /\bthe (fix|issue|problem|bug|cause) is\b/i,
    /\bthis means\b|\bimplication\b/i,
    /\bpattern\b|\brecurring\b/i,
    /\barchitectural\b|\bdesign decision\b/i,

    // --- new: code-level reasoning ---
    /\bregression\b|\bviolation\b|\banti-pattern\b/i,
    /\bwired\b.{0,30}\bnot\b|\bnever.*called\b|\bsilently.*fail/i,
    /\bdeadlock\b|\brace condition\b|\btimeout\b/i,
    /\bblind spot\b|\bnever.*fires\b/i,

    // --- new: recommendations ---
    /\brecommend\b|\bsuggestion\b|\badvise\b/i,
    /\bthe right (approach|way|call|tool|pattern)\b/i,
    /\bbetter (to|approach|option|choice)\b/i,
    /\btrade.?off\b|\bconsequence of\b/i,

    // --- new: project-specific signal ---
    /\bparity (score|gap|check|fail)\b/i,
    /\bgenerat(ed|ion) (code|output|artifact)\b/i,
    /\bCR_\w+\b/,
    /\bPhase [1-9]\b|\bP[0-9] —\b/i,

    // --- new: bugs and lessons ---
    /\bshould (never|always|not)\b/i,
    /\bthe lesson\b|\bwhat this means\b|\bwhat happened\b/i,
  ];

  // Length floor: responses > 600 chars are substantive by definition
  return INSIGHT_SIGNALS.some((r) => r.test(text)) || text.length > 600;
}
```

### C2 — Raise assistant capture importance

**File:** `extensions/memory-lancedb/index.ts`  
**Location:** `agent_end` hook, assistant turn summary capture block (~line 1115)

```typescript
// BEFORE
importance: 0.5,

// AFTER
importance: 0.65,
```

Reasoning: A code review, architectural recommendation, or bug analysis is at least
as valuable as a user preference or conversational fact. The current 0.5 makes assistant
captures the first to be evicted during `prune()` passes.

---

## Tests

Add to `extensions/memory-lancedb/index.test.ts` (or a new
`memory-lancedb/capture.test.ts`):

```typescript
describe("isSubstantiveAssistantTurn", () => {
  it("captures regression analysis", () => {
    expect(
      isSubstantiveAssistantTurn(
        "This is a regression — the messages.stream() call was replaced with messages.create() which breaks large outputs.",
      ),
    ).toBe(true);
  });

  it("captures recommendations", () => {
    expect(
      isSubstantiveAssistantTurn(
        "The right approach here is to use the HAL dual-backend pattern rather than hardcoding the Honeywell SDK call.",
      ),
    ).toBe(true);
  });

  it("captures CR references", () => {
    expect(
      isSubstantiveAssistantTurn(
        "CR_MANIFEST_PEER_REVIEW_FIXES addresses the root cause of missing source classes.",
      ),
    ).toBe(true);
  });

  it("captures long responses regardless of signals", () => {
    const longText = "x".repeat(601);
    expect(isSubstantiveAssistantTurn(longText)).toBe(true);
  });

  it("still filters short acks", () => {
    expect(isSubstantiveAssistantTurn("Got it.")).toBe(false);
    expect(isSubstantiveAssistantTurn("Done.")).toBe(false);
  });

  it("still filters injected memory context", () => {
    expect(
      isSubstantiveAssistantTurn(
        "<relevant-memories>Some memory content here that is quite long.</relevant-memories>",
      ),
    ).toBe(false);
  });
});
```

---

## Acceptance Criteria

- [ ] A session of equivalent depth to 2026-03-19 produces ≥ 20 captures in sqlite-vec
- [ ] Short acks ("Got it", "Done", "HEARTBEAT_OK") still do not capture
- [ ] Injected memory context (`<relevant-memories>`, `<ooda-notice>`) still do not capture
- [ ] All existing 20/21 memory-lancedb tests still pass (1 skip: LanceDB native on Intel)
- [ ] `importance: 0.65` confirmed in sqlite-vec rows for assistant captures
