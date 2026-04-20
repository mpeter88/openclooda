/**
 * CR_OODA_ARCHIVIST_CRUD_CLASSIFIER — applyPatternAction dispatch tests.
 */

import { describe, expect, it } from "vitest";
import { applyPatternAction, type PatternExtraction, type SemanticStore } from "./archivist.js";

function createMockSemanticStore(): SemanticStore & {
  upserts: Array<{ section: string; key: string; value: unknown }>;
  deletes: Array<{ section: string; key: string }>;
  invalidations: Array<{ section: string; key: string; reason: string }>;
  logs: Array<{ action: string; reason: string }>;
} {
  const upserts: Array<{ section: string; key: string; value: unknown }> = [];
  const deletes: Array<{ section: string; key: string }> = [];
  const invalidations: Array<{ section: string; key: string; reason: string }> = [];
  const logs: Array<{ action: string; reason: string }> = [];
  return {
    upserts,
    deletes,
    invalidations,
    logs,
    upsertFact(section, key, value) {
      upserts.push({ section, key, value });
    },
    appendArchivistLog(action, reason) {
      logs.push({ action, reason });
    },
    deleteFact(section, key) {
      deletes.push({ section, key });
    },
    invalidateFact(section, key, reason) {
      invalidations.push({ section, key, reason });
    },
  };
}

describe("applyPatternAction", () => {
  it("ADD on fresh key upserts the fact", async () => {
    const store = createMockSemanticStore();
    const pattern: PatternExtraction = {
      action: "ADD",
      section: "stack",
      key: "node",
      value: "22.3.0",
      reason: "seeded",
    };
    const result = await applyPatternAction("/tmp", pattern, store, undefined);
    expect(result).toEqual({ action: "ADD", applied: true });
    expect(store.upserts).toHaveLength(1);
  });

  it("ADD against existing identical value short-circuits to reconfirm (still applied)", async () => {
    const store = createMockSemanticStore();
    const pattern: PatternExtraction = {
      action: "ADD",
      section: "stack",
      key: "node",
      value: "22.3.0",
      reason: "seen again",
    };
    const result = await applyPatternAction("/tmp", pattern, store, "22.3.0");
    expect(result.applied).toBe(true);
    expect(store.upserts).toHaveLength(1);
  });

  it("ADD against existing different value is rejected as already_exists", async () => {
    const store = createMockSemanticStore();
    const pattern: PatternExtraction = {
      action: "ADD",
      section: "stack",
      key: "node",
      value: "22.4.0",
      reason: "seen new",
    };
    const result = await applyPatternAction("/tmp", pattern, store, "22.3.0");
    expect(result).toEqual({ action: "ADD", applied: false, rejectedReason: "already_exists" });
    expect(store.upserts).toHaveLength(0);
  });

  it("UPDATE with matching previousValue upserts with invalidation_reason", async () => {
    const store = createMockSemanticStore();
    const pattern: PatternExtraction = {
      action: "UPDATE",
      section: "stack",
      key: "node",
      value: "22.5.0",
      previousValue: "22.3.0",
      invalidation_reason: "upgraded",
      reason: "version bump",
    };
    const result = await applyPatternAction("/tmp", pattern, store, "22.3.0");
    expect(result.applied).toBe(true);
    expect(store.upserts).toHaveLength(1);
  });

  it("UPDATE with stale previousValue is rejected", async () => {
    const store = createMockSemanticStore();
    const pattern: PatternExtraction = {
      action: "UPDATE",
      section: "stack",
      key: "node",
      value: "22.5.0",
      previousValue: "20.0.0",
      invalidation_reason: "upgraded",
      reason: "version bump",
    };
    const result = await applyPatternAction("/tmp", pattern, store, "22.3.0");
    expect(result).toEqual({
      action: "UPDATE",
      applied: false,
      rejectedReason: "stale_previous_value",
    });
    expect(store.upserts).toHaveLength(0);
  });

  it("DELETE with reason calls invalidateFact", async () => {
    const store = createMockSemanticStore();
    const pattern: PatternExtraction = {
      action: "DELETE",
      section: "stack",
      key: "node",
      value: null,
      invalidation_reason: "removed from stack",
      reason: "no longer used",
    };
    const result = await applyPatternAction("/tmp", pattern, store, "22.3.0");
    expect(result.applied).toBe(true);
    expect(store.invalidations).toHaveLength(1);
    expect(store.invalidations[0].reason).toBe("removed from stack");
  });

  it("DELETE without reason is rejected", async () => {
    const store = createMockSemanticStore();
    const pattern: PatternExtraction = {
      action: "DELETE",
      section: "stack",
      key: "node",
      value: null,
      reason: "...",
    };
    const result = await applyPatternAction("/tmp", pattern, store, "22.3.0");
    expect(result.rejectedReason).toBe("missing_reason");
  });

  it("NOOP appends a log entry without storing", async () => {
    const store = createMockSemanticStore();
    const pattern: PatternExtraction = {
      action: "NOOP",
      section: "lessons_learned",
      key: "nothing",
      value: null,
      reason: "events were noise",
    };
    const result = await applyPatternAction("/tmp", pattern, store, undefined);
    expect(result.applied).toBe(true);
    expect(store.upserts).toHaveLength(0);
    expect(store.logs).toHaveLength(1);
    expect(store.logs[0].action).toContain("pattern_noop");
  });

  it("BELIEVE defers to beliefs tier (applied=false, logged)", async () => {
    const store = createMockSemanticStore();
    const pattern: PatternExtraction = {
      action: "BELIEVE",
      section: "preferences_notes",
      key: "delegates_infra",
      value: "seems to prefer delegating infra tasks",
      reason: "3 sessions showed this",
    };
    const result = await applyPatternAction("/tmp", pattern, store, undefined);
    expect(result.applied).toBe(false);
    expect(result.rejectedReason).toBe("deferred_to_beliefs_tier");
    expect(store.upserts).toHaveLength(0);
    expect(store.logs[0].action).toContain("pattern_believe");
  });

  it("missing action defaults to ADD", async () => {
    const store = createMockSemanticStore();
    const pattern: PatternExtraction = {
      section: "stack",
      key: "python",
      value: "3.12",
      reason: "seen",
    };
    const result = await applyPatternAction("/tmp", pattern, store, undefined);
    expect(result.action).toBe("ADD");
    expect(result.applied).toBe(true);
  });
});
