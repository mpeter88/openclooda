import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorldModelStore } from "../memory-lancedb/world-model-store.js";
import { SlowClarify, type InboxDb, type InboxItem } from "./slow-clarify.js";

function makeInboxItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: `inbox-${Math.random().toString(36).slice(2, 8)}`,
    capturedAt: Date.now(),
    sessionId: "test-session",
    text: "Test observation",
    type: "project",
    pertiansTo: null,
    nextTouchpoint: null,
    processed: 0,
    ...overrides,
  };
}

function createMockInboxDb(items: InboxItem[]): InboxDb {
  return {
    getUnprocessed: () => items.filter((i) => i.processed === 0),
    markProcessed: (ids: string[]) => {
      for (const item of items) {
        if (ids.includes(item.id)) item.processed = 1;
      }
    },
  };
}

describe("SlowClarify", () => {
  let tmpDir: string;
  let store: WorldModelStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(import.meta.dirname ?? "/tmp", "slow-clarify-test-"));
    store = new WorldModelStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("shouldRun", () => {
    it("returns false with 0 items", () => {
      const db = createMockInboxDb([]);
      const sc = new SlowClarify(db, store, vi.fn());
      expect(sc.shouldRun()).toBe(false);
    });

    it("returns true with >= 5 items", () => {
      const items = Array.from({ length: 5 }, () => makeInboxItem());
      const db = createMockInboxDb(items);
      const sc = new SlowClarify(db, store, vi.fn());
      expect(sc.shouldRun()).toBe(true);
    });

    it("returns true with < 5 items and > 30 min since last run", () => {
      const items = [makeInboxItem()];
      const db = createMockInboxDb(items);
      // Meta has no lastSlowClarify — defaults to 0, so elapsed > 30min
      const sc = new SlowClarify(db, store, vi.fn());
      expect(sc.shouldRun()).toBe(true);
    });

    it("returns false with < 5 items and recent lastSlowClarify", () => {
      const items = [makeInboxItem()];
      const db = createMockInboxDb(items);
      store.writeMeta({
        bootstrapComplete: true,
        lastSlowClarify: Date.now(),
        pendingProjectSuggestions: [],
      });
      const sc = new SlowClarify(db, store, vi.fn());
      expect(sc.shouldRun()).toBe(false);
    });
  });

  describe("run", () => {
    it("applies patch to world model project", async () => {
      const now = Date.now();
      store.writeProject({
        id: "amf",
        name: "AMF Platform",
        goal: "Build AMF",
        successCriteria: [],
        milestone: "M1",
        milestoneBlocking: ["fix-1"],
        openCRs: [],
        nextAction: "run tests",
        createdAt: now,
        updatedAt: now,
        status: "active",
      });

      const items = [
        makeInboxItem({
          text: "AMF run completed with 95% parity",
          type: "project",
          pertiansTo: "amf",
        }),
      ];
      const db = createMockInboxDb(items);

      const callLLM = vi.fn().mockResolvedValue(
        JSON.stringify({
          patch: { nextAction: "verify parity", milestoneBlocking: [] },
          summary: "Updated next action based on run results",
        }),
      );

      const sc = new SlowClarify(db, store, callLLM);
      // Force shouldRun by having no lastSlowClarify
      const result = await sc.run();

      expect(result.processed).toBe(1);
      expect(result.updated).toContain("amf");

      const project = store.readProject("amf");
      expect(project!.nextAction).toBe("verify parity");
      expect(project!.milestoneBlocking).toEqual([]);
    });

    it("creates milestone transition suggestion on milestone signal", async () => {
      const now = Date.now();
      store.writeProject({
        id: "amf",
        name: "AMF Platform",
        goal: "Build AMF",
        successCriteria: [],
        milestone: "M1: Core pipeline",
        milestoneBlocking: [],
        openCRs: [],
        nextAction: "run tests",
        createdAt: now,
        updatedAt: now,
        status: "active",
      });

      const items = [
        makeInboxItem({
          text: "All tests verified and parity >= 100%",
          type: "project",
          pertiansTo: "amf",
        }),
      ];
      const db = createMockInboxDb(items);

      const callLLM = vi.fn().mockResolvedValue(
        JSON.stringify({
          patch: { milestone: "M2: Optimization", nextAction: "plan M2" },
          summary: "Milestone M1 complete, transitioning to M2",
        }),
      );

      const sc = new SlowClarify(db, store, callLLM);
      await sc.run();

      const meta = store.readMeta();
      expect(meta.pendingProjectSuggestions.length).toBeGreaterThan(0);
      expect(meta.pendingProjectSuggestions[0].topicKey).toBe("milestone-transition:amf");
    });

    it("marks items processed on LLM failure", async () => {
      const now = Date.now();
      store.writeProject({
        id: "proj1",
        name: "Project 1",
        goal: "test",
        successCriteria: [],
        milestone: "M1",
        milestoneBlocking: [],
        openCRs: [],
        nextAction: "test",
        createdAt: now,
        updatedAt: now,
        status: "active",
      });

      const items = [
        makeInboxItem({ text: "some observation", type: "project", pertiansTo: "proj1" }),
      ];
      const db = createMockInboxDb(items);

      const callLLM = vi.fn().mockRejectedValue(new Error("LLM timeout"));
      const sc = new SlowClarify(db, store, callLLM);
      const result = await sc.run();

      expect(result.processed).toBe(1);
      expect(result.errors.length).toBe(1);
      expect(items[0].processed).toBe(1);
    });

    it("processes reference items into reference wiki", async () => {
      const items = [
        makeInboxItem({
          text: "We decided to use PostgreSQL for the data layer",
          type: "reference",
          pertiansTo: "amf",
        }),
      ];
      const db = createMockInboxDb(items);

      const sc = new SlowClarify(db, store, vi.fn());
      await sc.run();

      const ref = store.readReference("amf-decisions.md");
      expect(ref).toContain("PostgreSQL");
    });

    it("updates meta.lastSlowClarify after run", async () => {
      const db = createMockInboxDb([makeInboxItem({ type: "reference", pertiansTo: null })]);
      const sc = new SlowClarify(db, store, vi.fn());
      const before = Date.now();
      await sc.run();

      const meta = store.readMeta();
      expect(meta.lastSlowClarify).toBeGreaterThanOrEqual(before);
    });

    it("returns early with 0 items", async () => {
      const db = createMockInboxDb([]);
      const sc = new SlowClarify(db, store, vi.fn());
      const result = await sc.run();
      expect(result.processed).toBe(0);
    });
  });
});
