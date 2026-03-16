import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDefaultPriorities,
  getPriorities,
  prioritiesPath,
  updateDomainWeight,
  writePriorities,
} from "./priorities.js";

describe("priorities", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-priorities-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("createDefaultPriorities", () => {
    it("returns a valid PrioritiesFile with all required fields", () => {
      const defaults = createDefaultPriorities();
      expect(defaults._meta.version).toBe(1);
      expect(defaults._meta.updated_by).toBe("user");
      expect(Object.keys(defaults.domains).length).toBeGreaterThan(0);
      expect(defaults.strategy_labels.length).toBe(4);
      expect(defaults.scoring_rubric.alignment.weight).toBe(0.4);
      expect(defaults.scoring_rubric.efficiency.weight).toBe(0.35);
      expect(defaults.scoring_rubric.risk.weight).toBe(0.25);
    });

    it("has rubric weights that sum to 1.0", () => {
      const defaults = createDefaultPriorities();
      const sum =
        defaults.scoring_rubric.alignment.weight +
        defaults.scoring_rubric.efficiency.weight +
        defaults.scoring_rubric.risk.weight;
      expect(sum).toBeCloseTo(1.0, 4);
    });

    it("includes all four strategy archetypes", () => {
      const defaults = createDefaultPriorities();
      const labels = defaults.strategy_labels.map((s) => s.label);
      expect(labels).toContain("aggressive_fix");
      expect(labels).toContain("delegate_task");
      expect(labels).toContain("strategic_delay");
      expect(labels).toContain("minimal_viable_action");
    });
  });

  describe("getPriorities", () => {
    it("creates PRIORITIES.json template when file does not exist", () => {
      const priorities = getPriorities(tmpDir);
      expect(priorities._meta.version).toBe(1);
      expect(fs.existsSync(prioritiesPath(tmpDir))).toBe(true);
    });

    it("reads existing PRIORITIES.json", () => {
      const custom = createDefaultPriorities();
      custom.domains.custom_domain = {
        weight: 0.6,
        description: "Custom",
        examples: [],
        approval_count: 0,
        override_count: 0,
      };
      fs.writeFileSync(prioritiesPath(tmpDir), JSON.stringify(custom, null, 2));

      const priorities = getPriorities(tmpDir);
      expect(priorities.domains.custom_domain.weight).toBe(0.6);
    });

    it("throws on malformed JSON", () => {
      fs.writeFileSync(prioritiesPath(tmpDir), "not json");
      expect(() => getPriorities(tmpDir)).toThrow();
    });

    it("throws on missing _meta block", () => {
      fs.writeFileSync(prioritiesPath(tmpDir), JSON.stringify({ domains: {} }));
      expect(() => getPriorities(tmpDir)).toThrow("missing or malformed _meta");
    });

    it("throws on missing scoring_rubric", () => {
      fs.writeFileSync(prioritiesPath(tmpDir), JSON.stringify({ _meta: { version: 1 } }));
      expect(() => getPriorities(tmpDir)).toThrow("missing scoring_rubric");
    });

    it("creates parent directories if needed", () => {
      const deepPath = path.join(tmpDir, "deep", "nested");
      const priorities = getPriorities(deepPath);
      expect(priorities._meta.version).toBe(1);
      expect(fs.existsSync(prioritiesPath(deepPath))).toBe(true);
    });
  });

  describe("writePriorities", () => {
    it("writes valid JSON to disk", () => {
      getPriorities(tmpDir); // create template
      const priorities = createDefaultPriorities();
      priorities.domains.new_domain = {
        weight: 0.7,
        description: "New",
        examples: [],
        approval_count: 0,
        override_count: 0,
      };

      writePriorities(tmpDir, priorities);

      const reread = getPriorities(tmpDir);
      expect(reread.domains.new_domain.weight).toBe(0.7);
    });

    it("creates a snapshot before writing", () => {
      getPriorities(tmpDir); // create template
      writePriorities(tmpDir, createDefaultPriorities());

      const snapshotsDir = path.join(tmpDir, ".snapshots");
      expect(fs.existsSync(snapshotsDir)).toBe(true);
      const files = fs.readdirSync(snapshotsDir);
      expect(files.length).toBeGreaterThanOrEqual(1);
      expect(files[0]).toMatch(/^PRIORITIES\.json\.\d+\.bak$/);
    });

    it("updates the updated_at timestamp", () => {
      const priorities = createDefaultPriorities();
      priorities._meta.updated_at = "2020-01-01T00:00:00.000Z";

      writePriorities(tmpDir, priorities);

      const reread = getPriorities(tmpDir);
      expect(reread._meta.updated_at).not.toBe("2020-01-01T00:00:00.000Z");
    });
  });

  describe("updateDomainWeight", () => {
    it("updates weight and logs the change", () => {
      getPriorities(tmpDir); // create template with default domains

      updateDomainWeight(tmpDir, "core_project", 0.6, "Reduced priority after Q2");

      const priorities = getPriorities(tmpDir);
      expect(priorities.domains.core_project.weight).toBe(0.6);
      expect(priorities._meta.updated_by).toBe("meta_reviewer");
      expect(priorities._weight_adjustment_log).toHaveLength(1);
      expect(priorities._weight_adjustment_log[0].domain).toBe("core_project");
      expect(priorities._weight_adjustment_log[0].old_weight).toBe(0.8);
      expect(priorities._weight_adjustment_log[0].new_weight).toBe(0.6);
      expect(priorities._weight_adjustment_log[0].reason).toBe("Reduced priority after Q2");
    });

    it("throws for non-existent domain", () => {
      getPriorities(tmpDir);
      expect(() => updateDomainWeight(tmpDir, "nonexistent", 0.5, "test")).toThrow(
        'Domain "nonexistent" not found',
      );
    });

    it("rejects weight below 0.1", () => {
      getPriorities(tmpDir);
      expect(() => updateDomainWeight(tmpDir, "core_project", 0.05, "too low")).toThrow(
        "must be in [0.1, 1.0]",
      );
    });

    it("rejects weight above 1.0", () => {
      getPriorities(tmpDir);
      expect(() => updateDomainWeight(tmpDir, "core_project", 1.5, "too high")).toThrow(
        "must be in [0.1, 1.0]",
      );
    });

    it("accumulates multiple weight changes in the log", () => {
      getPriorities(tmpDir);
      updateDomainWeight(tmpDir, "core_project", 0.7, "First adjustment");
      updateDomainWeight(tmpDir, "core_project", 0.9, "Second adjustment");

      const priorities = getPriorities(tmpDir);
      expect(priorities._weight_adjustment_log).toHaveLength(2);
      expect(priorities.domains.core_project.weight).toBe(0.9);
    });
  });
});
