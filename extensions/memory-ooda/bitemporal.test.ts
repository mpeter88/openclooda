/**
 * CR_OODA_BITEMPORAL_KNOWLEDGE — Temporal envelope behavior tests.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteFact,
  getCurrentFacts,
  getFactHistory,
  getFactsAsOf,
  getFacts,
  invalidateFact,
  knowledgePath,
  upsertFact,
} from "./semantic-memory.js";

describe("bitemporal knowledge envelopes", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-bitemporal-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("upsertFact", () => {
    it("creates a fresh envelope on first write (ADD)", () => {
      upsertFact(tmpDir, "stack", "node", "22.3.0");
      const history = getFactHistory(tmpDir, "stack", "node");
      expect(history).toHaveLength(1);
      expect(history[0].valid_to).toBeNull();
      expect(history[0].ingested_by).toBe("archivist");
    });

    it("reconfirms identical value without new envelope", () => {
      upsertFact(tmpDir, "stack", "node", "22.3.0");
      upsertFact(tmpDir, "stack", "node", "22.3.0");
      const history = getFactHistory(tmpDir, "stack", "node");
      expect(history).toHaveLength(1);
      expect(history[0].reconfirmations).toHaveLength(1);
    });

    it("supersedes on different value (seals predecessor, adds new)", () => {
      upsertFact(tmpDir, "stack", "node", "22.3.0");
      upsertFact(tmpDir, "stack", "node", "22.4.0", { invalidation_reason: "upgraded" });
      const history = getFactHistory(tmpDir, "stack", "node");
      expect(history).toHaveLength(2);
      expect(history[0].valid_to).not.toBeNull();
      expect(history[0].invalidation_reason).toBe("upgraded");
      expect(history[1].valid_to).toBeNull();
      expect(history[1].supersedes).toBe(history[0].ingested_at);
    });

    it("respects confidence option", () => {
      upsertFact(tmpDir, "stack", "node", "22.3.0", { confidence: 0.5 });
      const history = getFactHistory(tmpDir, "stack", "node");
      expect(history[0].confidence).toBe(0.5);
    });

    it("stamps ingested_by from options", () => {
      upsertFact(tmpDir, "stack", "node", "22.3.0", { ingested_by: "user" });
      const history = getFactHistory(tmpDir, "stack", "node");
      expect(history[0].ingested_by).toBe("user");
    });
  });

  describe("invalidateFact", () => {
    it("seals currently-valid envelope without removing flat value", () => {
      upsertFact(tmpDir, "stack", "node", "22.3.0");
      invalidateFact(tmpDir, "stack", "node", "removed from stack");
      const history = getFactHistory(tmpDir, "stack", "node");
      expect(history).toHaveLength(1);
      expect(history[0].valid_to).not.toBeNull();
      expect(history[0].invalidation_reason).toBe("removed from stack");

      const raw = getFacts(tmpDir);
      expect(raw.stack.node).toBe("22.3.0");
    });

    it("is a no-op when key does not exist", () => {
      expect(() => invalidateFact(tmpDir, "stack", "nonexistent", "x")).not.toThrow();
    });
  });

  describe("getCurrentFacts", () => {
    it("filters out invalidated facts from flat section", () => {
      upsertFact(tmpDir, "stack", "node", "22.3.0");
      upsertFact(tmpDir, "stack", "python", "3.12");
      invalidateFact(tmpDir, "stack", "node", "removed");

      const current = getCurrentFacts(tmpDir);
      expect(current.stack.node).toBeUndefined();
      expect(current.stack.python).toBe("3.12");
    });

    it("retains all facts when no invalidations", () => {
      upsertFact(tmpDir, "stack", "node", "22.3.0");
      const current = getCurrentFacts(tmpDir);
      expect(current.stack.node).toBe("22.3.0");
    });
  });

  describe("getFactsAsOf", () => {
    it("returns facts valid at the given timestamp", () => {
      upsertFact(tmpDir, "stack", "node", "22.3.0");
      // simulate 10ms gap so envelope timestamps differ
      const beforeInvalidation = new Date().toISOString();
      // minor synchronous busy-wait to make envelopes' timestamps distinct
      const start = Date.now();
      while (Date.now() - start < 5) {}
      invalidateFact(tmpDir, "stack", "node", "removed");

      const past = getFactsAsOf(tmpDir, beforeInvalidation);
      expect(past.stack.node).toBeDefined();

      const nowFacts = getFactsAsOf(tmpDir, new Date().toISOString());
      expect(nowFacts.stack.node).toBeUndefined();
    });
  });

  describe("getFactHistory", () => {
    it("returns envelopes sorted oldest first", () => {
      upsertFact(tmpDir, "stack", "node", "22.3.0");
      const start = Date.now();
      while (Date.now() - start < 5) {}
      upsertFact(tmpDir, "stack", "node", "22.4.0");
      const start2 = Date.now();
      while (Date.now() - start2 < 5) {}
      upsertFact(tmpDir, "stack", "node", "22.5.0");

      const history = getFactHistory(tmpDir, "stack", "node");
      expect(history).toHaveLength(3);
      expect(history[0].ingested_at < history[1].ingested_at).toBe(true);
      expect(history[1].ingested_at < history[2].ingested_at).toBe(true);
      expect(history[history.length - 1].valid_to).toBeNull();
    });

    it("returns empty array when no envelopes exist", () => {
      expect(getFactHistory(tmpDir, "stack", "nothing")).toEqual([]);
    });
  });

  describe("deleteFact", () => {
    it("removes flat value and invalidates envelope", () => {
      upsertFact(tmpDir, "stack", "node", "22.3.0");
      deleteFact(tmpDir, "stack", "node");
      const facts = getFacts(tmpDir);
      expect(facts.stack.node).toBeUndefined();
      const history = getFactHistory(tmpDir, "stack", "node");
      expect(history[0].valid_to).not.toBeNull();
      expect(history[0].invalidation_reason).toBe("deleted");
    });

    it("is idempotent on missing keys", () => {
      expect(() => deleteFact(tmpDir, "stack", "absent")).not.toThrow();
    });
  });

  describe("invariant violation recovery", () => {
    it("restores snapshot when two envelopes have valid_to=null", () => {
      upsertFact(tmpDir, "stack", "node", "22.3.0");
      // Manually break the invariant: inject a second valid_to=null envelope.
      const file = knowledgePath(tmpDir);
      const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
      parsed._temporal["stack.node"].push({
        valid_from: new Date().toISOString(),
        valid_to: null,
        ingested_at: new Date().toISOString(),
        ingested_by: "archivist",
        confidence: 0.9,
      });
      fs.writeFileSync(file, JSON.stringify(parsed, null, 2));

      // Next write should detect the invariant violation and throw.
      expect(() => upsertFact(tmpDir, "stack", "node", "22.5.0")).toThrow(/invariant/);
    });
  });
});
