/**
 * Integration tests for content-hash wiring into KNOWLEDGE/BELIEFS/PRIORITIES
 * readers and writers (Path C raw-edit detection).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formBelief, getBeliefs } from "./beliefs.js";
import { getPriorities, writePriorities } from "./priorities.js";
import { getFacts, upsertFact } from "./semantic-memory.js";

describe("content-hash integration (Path C)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-hash-int-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe("KNOWLEDGE.json", () => {
    it("stamps content_hash on first-write (template creation)", () => {
      const k = getFacts(tmp);
      expect(typeof k._meta.content_hash).toBe("string");
      expect(k._meta.content_hash).toHaveLength(64);
    });

    it("updates content_hash after upsertFact", () => {
      const before = getFacts(tmp);
      const firstHash = before._meta.content_hash;
      upsertFact(tmp, "stack", "node", "22.3.0");
      const after = getFacts(tmp);
      expect(after._meta.content_hash).not.toBe(firstHash);
    });

    it("detects raw edits and appends a row to .raw-edit-warnings.jsonl", () => {
      upsertFact(tmp, "stack", "node", "22.3.0");
      // Tamper with the file directly, leaving content_hash as-is.
      const filePath = path.join(tmp, "KNOWLEDGE.json");
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      parsed.stack.node = "24.0.0-tampered";
      fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2) + "\n");

      getFacts(tmp); // triggers verify
      const warnFile = path.join(tmp, ".raw-edit-warnings.jsonl");
      expect(fs.existsSync(warnFile)).toBe(true);
      const row = JSON.parse(fs.readFileSync(warnFile, "utf-8").trim().split("\n")[0]);
      expect(row.filename).toBe("KNOWLEDGE.json");
    });
  });

  describe("BELIEFS.json", () => {
    it("stamps content_hash on first-write and after formBelief", () => {
      const b0 = getBeliefs(tmp);
      expect(typeof b0._meta.content_hash).toBe("string");
      const h0 = b0._meta.content_hash;
      formBelief(tmp, {
        id: "belief-1",
        claim: "Users prefer asynchronous replies",
        domain: "comms",
        confidence: 0.7,
      });
      const b1 = getBeliefs(tmp);
      expect(b1._meta.content_hash).not.toBe(h0);
    });
  });

  describe("PRIORITIES.json", () => {
    it("stamps content_hash on first-write and after writePriorities", () => {
      const p0 = getPriorities(tmp);
      const h0 = p0._meta.content_hash;
      expect(typeof h0).toBe("string");
      p0._meta.description = "modified test description";
      writePriorities(tmp, p0);
      const p1 = getPriorities(tmp);
      expect(p1._meta.content_hash).not.toBe(h0);
    });
  });
});
