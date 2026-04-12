import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendSitrepLog, readSitrepLog, type SitrepLogEntry } from "./sitrep-log.js";
import type { SITREP } from "./types.js";

describe("sitrep-log", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(import.meta.dirname ?? "/tmp", "sitrep-log-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const makeSitrep = (overrides: Partial<SITREP> = {}): SITREP => ({
    priority: 5,
    summary: "Test observation",
    conflictsDetected: [],
    relevantFacts: [],
    recommendedDomains: ["operations"],
    ...overrides,
  });

  describe("appendSitrepLog", () => {
    it("creates sitrep-log directory and file", () => {
      appendSitrepLog(tmpDir, makeSitrep(), "sess-1", "low");
      const logDir = path.join(tmpDir, "sitrep-log");
      expect(fs.existsSync(logDir)).toBe(true);

      const files = fs.readdirSync(logDir);
      expect(files.length).toBe(1);
      expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/);
    });

    it("appends multiple entries without overwriting", () => {
      appendSitrepLog(tmpDir, makeSitrep({ priority: 3 }), "sess-1", "low");
      appendSitrepLog(tmpDir, makeSitrep({ priority: 7 }), "sess-2", "medium");

      const today = new Date().toISOString().slice(0, 10);
      const content = fs.readFileSync(path.join(tmpDir, "sitrep-log", `${today}.jsonl`), "utf-8");
      const lines = content.trim().split("\n");
      expect(lines.length).toBe(2);

      const entry1 = JSON.parse(lines[0]) as SitrepLogEntry;
      const entry2 = JSON.parse(lines[1]) as SitrepLogEntry;
      expect(entry1.priority).toBe(3);
      expect(entry1.sessionKey).toBe("sess-1");
      expect(entry2.priority).toBe(7);
      expect(entry2.sessionKey).toBe("sess-2");
    });

    it("includes attention and domains in the entry", () => {
      appendSitrepLog(
        tmpDir,
        makeSitrep({
          priority: 8,
          attention: "Focus on blockers",
          recommendedDomains: ["ops", "dev"],
        }),
        "sess-3",
        "high",
      );

      const entries = readSitrepLog(tmpDir);
      expect(entries.length).toBe(1);
      expect(entries[0].attention).toBe("Focus on blockers");
      expect(entries[0].domains.recommended).toEqual(["ops", "dev"]);
      expect(entries[0].thinkingLevel).toBe("high");
    });

    it("sets attention to null when SITREP has no attention", () => {
      appendSitrepLog(tmpDir, makeSitrep(), "sess-4", "low");
      const entries = readSitrepLog(tmpDir);
      expect(entries[0].attention).toBeNull();
    });
  });

  describe("readSitrepLog", () => {
    it("returns empty array for non-existent log", () => {
      const entries = readSitrepLog(tmpDir, "2020-01-01");
      expect(entries).toEqual([]);
    });

    it("returns empty array for non-existent directory", () => {
      const entries = readSitrepLog("/tmp/nonexistent-sitrep-test-dir-12345", "2020-01-01");
      expect(entries).toEqual([]);
    });

    it("reads entries for today by default", () => {
      appendSitrepLog(tmpDir, makeSitrep({ priority: 6 }), "sess-5", "medium");
      const entries = readSitrepLog(tmpDir);
      expect(entries.length).toBe(1);
      expect(entries[0].priority).toBe(6);
    });

    it("skips malformed lines gracefully", () => {
      const today = new Date().toISOString().slice(0, 10);
      const logDir = path.join(tmpDir, "sitrep-log");
      fs.mkdirSync(logDir, { recursive: true });
      const logFile = path.join(logDir, `${today}.jsonl`);
      fs.writeFileSync(
        logFile,
        '{"timestamp":"2026-04-05T00:00:00Z","sessionKey":"s1","priority":5,"domains":{},"attention":null,"thinkingLevel":"low"}\nBAD LINE\n{"timestamp":"2026-04-05T00:01:00Z","sessionKey":"s2","priority":7,"domains":{},"attention":null,"thinkingLevel":"high"}\n',
      );

      const entries = readSitrepLog(tmpDir, today);
      expect(entries.length).toBe(2);
      expect(entries[0].sessionKey).toBe("s1");
      expect(entries[1].sessionKey).toBe("s2");
    });
  });
});
