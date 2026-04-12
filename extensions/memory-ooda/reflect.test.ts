import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorldModelStore } from "../memory-lancedb/world-model-store.js";
import type { EpisodicStore, EpisodicEvent } from "./archivist.js";
import { Reflect, renderReflectNotification } from "./reflect.js";

function createMockEpisodicStore(events: EpisodicEvent[] = []): EpisodicStore {
  return {
    async retrieveSince(_since: number, _limit?: number) {
      return events;
    },
    async markProcessed() {},
    async prune() {
      return 0;
    },
  };
}

describe("Reflect", () => {
  let tmpDir: string;
  let store: WorldModelStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(import.meta.dirname ?? "/tmp", "reflect-test-"));
    store = new WorldModelStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("shouldRun", () => {
    it("returns true with >= 50 events", () => {
      store.writeMeta({
        bootstrapComplete: true,
        eventsSinceLastReflect: 50,
        pendingProjectSuggestions: [],
      });
      const reflect = new Reflect(store, createMockEpisodicStore(), vi.fn());
      expect(reflect.shouldRun()).toBe(true);
    });

    it("returns true after 7+ days with events", () => {
      store.writeMeta({
        bootstrapComplete: true,
        lastReflect: Date.now() - 8 * 24 * 60 * 60 * 1000,
        eventsSinceLastReflect: 5,
        pendingProjectSuggestions: [],
      });
      const reflect = new Reflect(store, createMockEpisodicStore(), vi.fn());
      expect(reflect.shouldRun()).toBe(true);
    });

    it("returns false with < 50 events and < 7 days", () => {
      store.writeMeta({
        bootstrapComplete: true,
        lastReflect: Date.now() - 1000,
        eventsSinceLastReflect: 10,
        pendingProjectSuggestions: [],
      });
      const reflect = new Reflect(store, createMockEpisodicStore(), vi.fn());
      expect(reflect.shouldRun()).toBe(false);
    });

    it("returns false with 7+ days but 0 events", () => {
      store.writeMeta({
        bootstrapComplete: true,
        lastReflect: Date.now() - 8 * 24 * 60 * 60 * 1000,
        eventsSinceLastReflect: 0,
        pendingProjectSuggestions: [],
      });
      const reflect = new Reflect(store, createMockEpisodicStore(), vi.fn());
      expect(reflect.shouldRun()).toBe(false);
    });
  });

  describe("run", () => {
    it("applies project patch correctly", async () => {
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
      store.writeMeta({
        bootstrapComplete: true,
        eventsSinceLastReflect: 50,
        pendingProjectSuggestions: [],
      });

      const callLLM = vi.fn().mockResolvedValue(
        JSON.stringify({
          patches: [
            {
              type: "project",
              id: "amf",
              patch: { milestoneBlocking: [] },
              reason: "fix-1 resolved per recent events",
            },
          ],
          new_reference_entries: [],
          review_items: [],
          summary: "Removed resolved blocker from AMF project.",
        }),
      );

      const reflect = new Reflect(store, createMockEpisodicStore(), callLLM);
      const result = await reflect.run();

      expect(result.patches.length).toBe(1);
      expect(result.fromFallback).toBe(false);

      const project = store.readProject("amf");
      expect(project!.milestoneBlocking).toEqual([]);
    });

    it("appends new reference entry", async () => {
      store.writeMeta({
        bootstrapComplete: true,
        eventsSinceLastReflect: 50,
        pendingProjectSuggestions: [],
      });

      const callLLM = vi.fn().mockResolvedValue(
        JSON.stringify({
          patches: [],
          new_reference_entries: [
            {
              filename: "patterns.md",
              title: "Patterns",
              content: "Always check parity before merging.",
            },
          ],
          review_items: [],
          summary: "Added pattern to reference.",
        }),
      );

      const reflect = new Reflect(store, createMockEpisodicStore(), callLLM);
      await reflect.run();

      const ref = store.readReference("patterns.md");
      expect(ref).toContain("Always check parity before merging");
      expect(ref).toContain("Added by Reflect");
    });

    it("handles LLM failure gracefully", async () => {
      store.writeMeta({
        bootstrapComplete: true,
        eventsSinceLastReflect: 50,
        pendingProjectSuggestions: [],
      });

      const callLLM = vi.fn().mockRejectedValue(new Error("timeout"));
      const reflect = new Reflect(store, createMockEpisodicStore(), callLLM);
      const result = await reflect.run();

      expect(result.fromFallback).toBe(true);
      expect(result.lastError).toContain("timeout");

      // Meta should still be updated
      const meta = store.readMeta();
      expect(meta.eventsSinceLastReflect).toBe(0);
      expect(meta.lastReflect).toBeGreaterThan(0);
    });

    it("updates meta after run", async () => {
      store.writeMeta({
        bootstrapComplete: true,
        eventsSinceLastReflect: 55,
        pendingProjectSuggestions: [],
      });

      const callLLM = vi.fn().mockResolvedValue(
        JSON.stringify({
          patches: [],
          new_reference_entries: [],
          review_items: [],
          summary: "All clear.",
        }),
      );

      const reflect = new Reflect(store, createMockEpisodicStore(), callLLM);
      await reflect.run();

      const meta = store.readMeta();
      expect(meta.eventsSinceLastReflect).toBe(0);
      expect(meta.lastReflectSummary).toBe("All clear.");
      expect(meta.lastReflect).toBeGreaterThan(0);
    });
  });

  describe("renderReflectNotification", () => {
    it("returns null when no patches and no review items", () => {
      const result = renderReflectNotification({
        patches: [],
        newReferenceEntries: [],
        reviewItems: [],
        summary: "Nothing changed.",
        fromFallback: false,
      });
      expect(result).toBeNull();
    });

    it("renders high-severity items", () => {
      const result = renderReflectNotification({
        patches: [{ type: "project", id: "amf", patch: {}, reason: "test" }],
        newReferenceEntries: [],
        reviewItems: [
          { severity: "high", message: "AMF milestone stale for 14 days", actionRequired: true },
        ],
        summary: "AMF project needs attention.",
        fromFallback: false,
      });
      expect(result).toContain("Items Needing Attention");
      expect(result).toContain("AMF milestone stale");
      expect(result).toContain("1 world model updates applied");
    });
  });
});
