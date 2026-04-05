import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDefaultKnowledge,
  formatFactsForContext,
  getFacts,
  knowledgePath,
  upsertFact,
  appendArchivistLog,
} from "./semantic-memory.js";
import type { KnowledgeFile } from "./types.js";

describe("semantic-memory", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-semantic-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("createDefaultKnowledge", () => {
    it("returns a valid KnowledgeFile with all required fields", () => {
      const defaults = createDefaultKnowledge();
      expect(defaults._meta.version).toBe(1);
      expect(defaults._meta.updated_by).toBe("user");
      expect(defaults.identity.language_primary).toBe("en");
      expect(defaults.preferences.response_length).toBe("concise");
      expect(defaults._archivist_log).toEqual([]);
    });
  });

  describe("getFacts", () => {
    it("creates KNOWLEDGE.json template when file does not exist", () => {
      const facts = getFacts(tmpDir);
      expect(facts._meta.version).toBe(1);
      expect(fs.existsSync(knowledgePath(tmpDir))).toBe(true);
    });

    it("reads existing KNOWLEDGE.json", () => {
      const custom: KnowledgeFile = {
        ...createDefaultKnowledge(),
        stack: { myproject: "TypeScript + Node" },
      };
      fs.writeFileSync(knowledgePath(tmpDir), JSON.stringify(custom, null, 2));

      const facts = getFacts(tmpDir);
      expect(facts.stack.myproject).toBe("TypeScript + Node");
    });

    it("throws on malformed JSON", () => {
      fs.writeFileSync(knowledgePath(tmpDir), "not json");
      expect(() => getFacts(tmpDir)).toThrow();
    });

    it("throws on missing _meta block", () => {
      fs.writeFileSync(knowledgePath(tmpDir), JSON.stringify({ identity: {} }));
      expect(() => getFacts(tmpDir)).toThrow("missing or malformed _meta");
    });

    it("creates parent directories if needed", () => {
      const deepPath = path.join(tmpDir, "deep", "nested", "workspace");
      const facts = getFacts(deepPath);
      expect(facts._meta.version).toBe(1);
      expect(fs.existsSync(knowledgePath(deepPath))).toBe(true);
    });
  });

  describe("upsertFact", () => {
    it("upserts a stack entry", () => {
      getFacts(tmpDir); // create template
      upsertFact(tmpDir, "stack", "openclaw", "TypeScript + ESM");

      const facts = getFacts(tmpDir);
      expect(facts.stack.openclaw).toBe("TypeScript + ESM");
      expect(facts._meta.updated_by).toBe("archivist");
    });

    it("upserts a project entry", () => {
      getFacts(tmpDir);
      upsertFact(tmpDir, "projects", "ooda-agent", {
        status: "active",
        priority_domain: "core_project",
        key_constraint: "Must ship Q2",
        notes: "",
      });

      const facts = getFacts(tmpDir);
      expect(facts.projects["ooda-agent"].status).toBe("active");
    });

    it("upserts a domain_context entry", () => {
      getFacts(tmpDir);
      upsertFact(tmpDir, "domain_context", "deployment", "Fly.io + Docker");

      const facts = getFacts(tmpDir);
      expect(facts.domain_context.deployment).toBe("Fly.io + Docker");
    });

    it("overwrites existing values", () => {
      getFacts(tmpDir);
      upsertFact(tmpDir, "stack", "lang", "Python");
      upsertFact(tmpDir, "stack", "lang", "TypeScript");

      const facts = getFacts(tmpDir);
      expect(facts.stack.lang).toBe("TypeScript");
    });

    it("upserts lessons_learned via upsertFact", () => {
      getFacts(tmpDir);
      upsertFact(
        tmpDir,
        "lessons_learned",
        "claude_streaming_required",
        "Always use streaming for Claude calls.",
      );

      const facts = getFacts(tmpDir);
      expect(facts.lessons_learned["claude_streaming_required"]).toBe(
        "Always use streaming for Claude calls.",
      );
    });

    it("rejects invalid section names", () => {
      getFacts(tmpDir);
      expect(() => upsertFact(tmpDir, "preferences", "key", "val")).toThrow(
        'Cannot upsert into section "preferences"',
      );
    });

    it("creates a snapshot before writing", () => {
      getFacts(tmpDir); // create template
      upsertFact(tmpDir, "stack", "test", "value");

      const snapshotsDir = path.join(tmpDir, ".snapshots");
      expect(fs.existsSync(snapshotsDir)).toBe(true);
      const files = fs.readdirSync(snapshotsDir);
      expect(files.length).toBeGreaterThanOrEqual(1);
      expect(files[0]).toMatch(/^KNOWLEDGE\.json\.\d+\.bak$/);
    });
  });

  describe("appendArchivistLog", () => {
    it("appends log entries", () => {
      getFacts(tmpDir);
      appendArchivistLog(tmpDir, "upsert stack.lang", "Seen TypeScript in 12/15 recent sessions");
      appendArchivistLog(tmpDir, "upsert preferences.never_do", "Pattern: user rejected 5 times");

      const facts = getFacts(tmpDir);
      expect(facts._archivist_log).toHaveLength(2);
      expect(facts._archivist_log[0].action).toBe("upsert stack.lang");
      expect(facts._archivist_log[1].reason).toContain("Pattern");
    });
  });

  describe("formatFactsForContext", () => {
    it("returns empty string for empty knowledge", () => {
      const result = formatFactsForContext(createDefaultKnowledge());
      expect(result).toBe("");
    });

    it("formats identity section", () => {
      const knowledge = createDefaultKnowledge();
      knowledge.identity.name = "Michael";
      knowledge.identity.timezone = "US/Central";

      const result = formatFactsForContext(knowledge);
      expect(result).toContain("<semantic-memory>");
      expect(result).toContain("Name: Michael");
      expect(result).toContain("Timezone: US/Central");
      expect(result).toContain("</semantic-memory>");
    });

    it("formats stack entries", () => {
      const knowledge = createDefaultKnowledge();
      knowledge.stack = { openclaw: "TypeScript + ESM", backend: "FastAPI" };

      const result = formatFactsForContext(knowledge);
      expect(result).toContain("Tech Stack:");
      expect(result).toContain("openclaw: TypeScript + ESM");
      expect(result).toContain("backend: FastAPI");
    });

    it("formats projects with status and constraints", () => {
      const knowledge = createDefaultKnowledge();
      knowledge.projects = {
        "ooda-agent": {
          status: "active",
          priority_domain: "core_project",
          key_constraint: "Ship Q2",
          notes: "",
        },
      };

      const result = formatFactsForContext(knowledge);
      expect(result).toContain("Projects:");
      expect(result).toContain("ooda-agent:");
      expect(result).toContain("status=active");
      expect(result).toContain("constraint: Ship Q2");
    });

    it("formats preferences including never_do", () => {
      const knowledge = createDefaultKnowledge();
      knowledge.preferences.never_do = ["delete production data", "merge without review"];

      const result = formatFactsForContext(knowledge);
      expect(result).toContain("Preferences:");
      expect(result).toContain("Never do: delete production data; merge without review");
    });

    it("formats commitments", () => {
      const knowledge = createDefaultKnowledge();
      knowledge.commitments = [
        {
          label: "standup",
          recurrence: "daily",
          time: "09:00",
          timezone: "US/Central",
          blocking: true,
        },
      ];

      const result = formatFactsForContext(knowledge);
      expect(result).toContain("Commitments:");
      expect(result).toContain("standup: daily 09:00 (blocking)");
    });

    it("formats lessons_learned entries", () => {
      const knowledge = createDefaultKnowledge();
      knowledge.lessons_learned = {
        claude_streaming_required: "Always use streaming for Claude calls.",
        check_all_branches: "Check worktree branches too when auditing.",
      };

      const result = formatFactsForContext(knowledge);
      expect(result).toContain("Lessons Learned:");
      expect(result).toContain("claude_streaming_required: Always use streaming for Claude calls.");
      expect(result).toContain("check_all_branches: Check worktree branches too when auditing.");
    });

    it("omits empty sections", () => {
      const knowledge = createDefaultKnowledge();
      knowledge.identity.name = "Test";
      // all other sections empty

      const result = formatFactsForContext(knowledge);
      expect(result).toContain("Identity:");
      expect(result).not.toContain("Tech Stack:");
      expect(result).not.toContain("Projects:");
      expect(result).not.toContain("People:");
    });
  });
});
