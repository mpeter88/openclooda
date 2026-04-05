import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EpisodicEvent, EpisodicStore, SemanticStore } from "./archivist.js";
import type { PatternExtraction } from "./archivist.js";
import {
  alreadyImported,
  exportOodaLessons,
  extractArchitectureFindings,
  extractCRStatusFindings,
  extractParityFindings,
  extractRunFindings,
  findCompletedRuns,
  importAMFKnowledge,
  isAMFContext,
  isAMFRelevantPattern,
  markImported,
  promoteAMFFindings,
  type AMFRunFinding,
  type OodaLessonsFile,
} from "./cross-project.js";

// ============================================================================
// Fixtures
// ============================================================================

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cross-project-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createMockEpisodicStore(events: EpisodicEvent[] = []): EpisodicStore & {
  stored: Array<{
    text: string;
    importance: number;
    category: string;
    source?: string;
    actionId?: string;
  }>;
} {
  const stored: Array<{
    text: string;
    importance: number;
    category: string;
    source?: string;
    actionId?: string;
  }> = [];

  return {
    stored,
    async retrieveSince(_sinceTimestamp: number, _limit?: number) {
      return events;
    },
    async markProcessed() {},
    async prune() {
      return 0;
    },
    async store(event) {
      stored.push({
        text: event.text,
        importance: event.importance,
        category: event.category,
        source: event.source,
        actionId: event.actionId,
      });
    },
  };
}

function createMockSemanticStore(): SemanticStore & {
  upserts: Array<{ section: string; key: string; value: unknown }>;
} {
  const upserts: Array<{ section: string; key: string; value: unknown }> = [];

  return {
    upserts,
    upsertFact(section: string, key: string, value: unknown) {
      upserts.push({ section, key, value });
    },
    appendArchivistLog() {},
  };
}

function createTestEvent(overrides?: Partial<EpisodicEvent>): EpisodicEvent {
  return {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    text: "Test event",
    category: "domain_context",
    importance: 0.8,
    createdAt: Date.now() - 60_000,
    source: "amf_harvester",
    archivistProcessed: false,
    ...overrides,
  };
}

// ============================================================================
// K4: AMF Context Detection
// ============================================================================

describe("isAMFContext", () => {
  it("detects AMF-related messages", () => {
    expect(isAMFContext("Let's check the AMF pipeline output")).toBe(true);
    expect(isAMFContext("Review the parity_report for KohlsCore")).toBe(true);
    expect(isAMFContext("The forensic orchestrator found issues")).toBe(true);
    expect(isAMFContext("kotlin module scoping bug")).toBe(true);
    expect(isAMFContext("gradle build failed")).toBe(true);
  });

  it("returns false for non-AMF messages", () => {
    expect(isAMFContext("Fix the CSS styling on the homepage")).toBe(false);
    expect(isAMFContext("Update the README documentation")).toBe(false);
    expect(isAMFContext("Run the TypeScript compiler")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isAMFContext("PIPELINE FAILED")).toBe(true);
    expect(isAMFContext("Gradle Build")).toBe(true);
  });
});

// ============================================================================
// K1: Finding Extraction
// ============================================================================

describe("extractParityFindings", () => {
  it("extracts findings from parity_report.json", () => {
    const reportPath = path.join(tmpDir, "parity_report.json");
    fs.writeFileSync(
      reportPath,
      JSON.stringify({
        score: 0.65,
        gaps: ["Missing module: auth", "Incomplete: payments"],
      }),
    );

    const findings = extractParityFindings(reportPath);
    expect(findings.length).toBe(3); // 1 score summary + 2 gaps
    expect(findings[0].text).toContain("AMF parity score: 0.65");
    expect(findings[0].importance).toBe(0.9); // low score → high importance
    expect(findings[0].findingType).toBe("parity_gap");
    expect(findings[1].text).toContain("Missing module: auth");
  });

  it("handles high parity score with lower importance", () => {
    const reportPath = path.join(tmpDir, "parity_report.json");
    fs.writeFileSync(reportPath, JSON.stringify({ score: 0.95, gaps: [] }));

    const findings = extractParityFindings(reportPath);
    expect(findings.length).toBe(1);
    expect(findings[0].importance).toBe(0.6); // high score → lower importance
  });
});

describe("extractCRStatusFindings", () => {
  it("extracts IMPLEMENTED entries from CR STATUS.md", () => {
    const statusPath = path.join(tmpDir, "STATUS.md");
    fs.writeFileSync(
      statusPath,
      `# CR Status

| CR | Date | Status | Items | Notes |
| --- | --- | --- | --- | --- |
| \`CR_AUTH_FIX\` | 2026-04-01 | \`IMPLEMENTED\` | A1-A2 | Fixed token refresh logic for OAuth2 |
| \`CR_LOGGING\` | 2026-04-02 | \`WRITTEN\` | L1-L3 | Pending implementation |
| \`CR_PARITY_BOOST\` | 2026-04-03 | \`IMPLEMENTED\` | P1 | Improved module detection accuracy |
`,
    );

    const findings = extractCRStatusFindings(statusPath);
    expect(findings.length).toBe(2);
    expect(findings[0].crId).toBe("CR_AUTH_FIX");
    expect(findings[0].text).toContain("Fixed token refresh logic");
    expect(findings[0].findingType).toBe("cr_lesson");
    expect(findings[1].crId).toBe("CR_PARITY_BOOST");
  });

  it("returns empty array for no IMPLEMENTED entries", () => {
    const statusPath = path.join(tmpDir, "STATUS.md");
    fs.writeFileSync(statusPath, "| CR | Status |\n| --- | --- |\n| X | WRITTEN |");
    expect(extractCRStatusFindings(statusPath)).toEqual([]);
  });
});

describe("extractArchitectureFindings", () => {
  it("extracts key findings from ARCHITECTURE_REPORT.md", () => {
    const reportPath = path.join(tmpDir, "ARCHITECTURE_REPORT.md");
    fs.writeFileSync(
      reportPath,
      `# Architecture Report

## Module Structure
The application uses a layered architecture with clear separation of concerns between the data access layer and business logic.

## Key Dependencies
External dependencies include Firebase for auth and Retrofit for networking. Both are abstracted behind interfaces for testability.

## Potential Issues
The singleton pattern in NetworkManager creates tight coupling that complicates testing and may lead to race conditions under concurrent access.
`,
    );

    const findings = extractArchitectureFindings(reportPath);
    expect(findings.length).toBe(3);
    expect(findings[0].text).toContain("AMF architecture: Module Structure");
    expect(findings[0].findingType).toBe("architecture_finding");
    expect(findings[2].text).toContain("Potential Issues");
  });
});

// ============================================================================
// K1: Run Discovery and Import
// ============================================================================

describe("findCompletedRuns", () => {
  it("finds directories with AMF output artifacts", () => {
    // Create a run directory with parity report
    const runDir = path.join(tmpDir, "app-alpha");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "parity_report.json"), JSON.stringify({ score: 0.8 }));

    // Create a run with CR STATUS.md
    const runDir2 = path.join(tmpDir, "app-beta");
    fs.mkdirSync(path.join(runDir2, "cr"), { recursive: true });
    fs.writeFileSync(path.join(runDir2, "cr", "STATUS.md"), "# Status");

    // Create a directory with no artifacts (should be skipped)
    const emptyDir = path.join(tmpDir, "app-empty");
    fs.mkdirSync(emptyDir, { recursive: true });
    fs.writeFileSync(path.join(emptyDir, "random.txt"), "nothing");

    const runs = findCompletedRuns(tmpDir);
    expect(runs.length).toBe(2);
    expect(runs.map((r) => r.appId).sort()).toEqual(["app-alpha", "app-beta"]);
  });

  it("returns empty array for non-existent directory", () => {
    expect(findCompletedRuns("/nonexistent/path")).toEqual([]);
  });
});

describe("alreadyImported / markImported", () => {
  it("tracks import status via marker file", () => {
    const runDir = path.join(tmpDir, "test-run");
    fs.mkdirSync(runDir, { recursive: true });

    expect(alreadyImported(runDir)).toBe(false);
    markImported(runDir);
    expect(alreadyImported(runDir)).toBe(true);
  });
});

describe("importAMFKnowledge", () => {
  it("imports findings from AMF runs into episodic store", async () => {
    // Set up a run with a parity report
    const runDir = path.join(tmpDir, "test-app");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "parity_report.json"),
      JSON.stringify({ score: 0.6, gaps: ["Missing auth module"] }),
    );

    const store = createMockEpisodicStore();
    const imported = await importAMFKnowledge(tmpDir, store);

    expect(imported).toBe(2); // 1 score + 1 gap
    expect(store.stored.length).toBe(2);
    expect(store.stored[0].source).toBe("amf_harvester");
    expect(store.stored[0].category).toBe("domain_context");
  });

  it("prevents duplicate imports (idempotency)", async () => {
    const runDir = path.join(tmpDir, "test-app");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "parity_report.json"),
      JSON.stringify({ score: 0.8, gaps: [] }),
    );

    const store = createMockEpisodicStore();

    // First import
    const first = await importAMFKnowledge(tmpDir, store);
    expect(first).toBe(1);

    // Second import — should import nothing (already marked)
    const second = await importAMFKnowledge(tmpDir, store);
    expect(second).toBe(0);
    expect(store.stored.length).toBe(1); // only from first run
  });

  it("handles multiple runs correctly", async () => {
    // Run 1
    const run1 = path.join(tmpDir, "app-one");
    fs.mkdirSync(run1, { recursive: true });
    fs.writeFileSync(
      path.join(run1, "parity_report.json"),
      JSON.stringify({ score: 0.9, gaps: [] }),
    );

    // Run 2
    const run2 = path.join(tmpDir, "app-two");
    fs.mkdirSync(path.join(run2, "cr"), { recursive: true });
    fs.writeFileSync(
      path.join(run2, "cr", "STATUS.md"),
      `| CR | Date | Status | Items | Notes |
| --- | --- | --- | --- | --- |
| \`CR_FIX\` | 2026-04-01 | \`IMPLEMENTED\` | F1 | Fixed race condition |`,
    );

    const store = createMockEpisodicStore();
    const imported = await importAMFKnowledge(tmpDir, store);

    expect(imported).toBe(2); // 1 parity + 1 CR lesson
    expect(store.stored.map((s) => s.source)).toEqual(["amf_harvester", "amf_harvester"]);
  });
});

// ============================================================================
// K3: OODA → AMF Knowledge Export
// ============================================================================

describe("isAMFRelevantPattern", () => {
  it("identifies pipeline-related patterns", () => {
    const pattern: PatternExtraction = {
      section: "lessons_learned",
      key: "pipeline_module_scoping",
      value: "AMF pipeline module scoping needs exact alias dedup",
      reason: "Multiple events reference pipeline errors",
    };
    expect(isAMFRelevantPattern(pattern)).toBe(true);
  });

  it("rejects unrelated patterns", () => {
    const pattern: PatternExtraction = {
      section: "lessons_learned",
      key: "css_flexbox_centering",
      value: "Always use flexbox for vertical centering",
      reason: "CSS layout events",
    };
    expect(isAMFRelevantPattern(pattern)).toBe(false);
  });
});

describe("exportOodaLessons", () => {
  it("writes AMF-relevant lessons to ooda-lessons.json", () => {
    const outputPath = path.join(tmpDir, "ooda-lessons.json");
    const patterns: PatternExtraction[] = [
      {
        section: "lessons_learned",
        key: "gradle_module_detection",
        value: "Gradle module detection must use shortest qualifying package",
        reason: "pipeline assembly error",
      },
      {
        section: "stack",
        key: "typescript_version",
        value: "TypeScript 5.7",
        reason: "Mentioned in events",
      },
    ];

    const exported = exportOodaLessons(outputPath, patterns);
    expect(exported).toBe(1); // only the gradle one is AMF-relevant

    const file = JSON.parse(fs.readFileSync(outputPath, "utf-8")) as OodaLessonsFile;
    expect(file.lessons.length).toBe(1);
    expect(file.lessons[0].id).toBe("lesson-gradle_module_detection");
    expect(file.lessons[0].source).toBe("ooda_archivist");
    expect(file.lessons[0].confidence).toBe(0.8);
  });

  it("deduplicates by lesson ID on re-export", () => {
    const outputPath = path.join(tmpDir, "ooda-lessons.json");
    const patterns: PatternExtraction[] = [
      {
        section: "lessons_learned",
        key: "kotlin_parity_fix",
        value: "Kotlin parity requires explicit import resolution",
        reason: "parity failures",
      },
    ];

    exportOodaLessons(outputPath, patterns);
    const second = exportOodaLessons(outputPath, patterns);
    expect(second).toBe(0); // already exists

    const file = JSON.parse(fs.readFileSync(outputPath, "utf-8")) as OodaLessonsFile;
    expect(file.lessons.length).toBe(1);
  });

  it("returns 0 when no AMF-relevant patterns", () => {
    const outputPath = path.join(tmpDir, "ooda-lessons.json");
    const patterns: PatternExtraction[] = [
      {
        section: "stack",
        key: "node_version",
        value: "Node 22",
        reason: "events mention Node",
      },
    ];

    expect(exportOodaLessons(outputPath, patterns)).toBe(0);
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  it("detects outcome labels on exported lessons", () => {
    const outputPath = path.join(tmpDir, "ooda-lessons.json");
    const patterns: PatternExtraction[] = [
      {
        section: "lessons_learned",
        key: "agent_assembly_fix",
        value: "Agent assembly must verify module boundaries",
        reason: "pipeline failures",
      },
    ];
    const outcomeEvents: EpisodicEvent[] = [
      createTestEvent({
        source: "archivist",
        outcome: "success",
        text: "agent_assembly_fix: verified module boundary check",
      }),
    ];

    exportOodaLessons(outputPath, patterns, outcomeEvents);
    const file = JSON.parse(fs.readFileSync(outputPath, "utf-8")) as OodaLessonsFile;
    expect(file.lessons[0].outcomeLabeled).toBe(true);
  });
});

// ============================================================================
// K5: KNOWLEDGE.json Auto-Update from AMF Imports
// ============================================================================

describe("promoteAMFFindings", () => {
  it("promotes parity events to domain_context", () => {
    const store = createMockSemanticStore();
    const events: EpisodicEvent[] = [
      createTestEvent({
        text: "AMF parity score: 0.55 — 3 gap(s) detected",
        importance: 0.9,
        source: "amf_harvester",
      }),
    ];

    const promoted = promoteAMFFindings(events, store);
    expect(promoted).toBe(1);
    expect(store.upserts[0].section).toBe("domain_context");
    expect(store.upserts[0].key).toBe("amf_pipeline_parity");
  });

  it("promotes CR lessons with success outcome", () => {
    const store = createMockSemanticStore();
    const events: EpisodicEvent[] = [
      createTestEvent({
        text: "AMF CR CR_AUTH_FIX implemented: Fixed OAuth2 token refresh",
        importance: 0.8,
        source: "amf_harvester",
        outcome: "success",
        actionId: "CR_AUTH_FIX",
      }),
    ];

    const promoted = promoteAMFFindings(events, store);
    expect(promoted).toBeGreaterThanOrEqual(1);
    const lessonUpserts = store.upserts.filter((u) => u.section === "lessons_learned");
    expect(lessonUpserts.length).toBeGreaterThanOrEqual(1);
  });

  it("promotes recurring failure modes", () => {
    const store = createMockSemanticStore();
    const events: EpisodicEvent[] = [
      createTestEvent({
        id: "11111111-bbbb-cccc-dddd-eeeeeeeeeeee",
        text: "AMF parity gap: Missing module auth — interface not implemented",
        importance: 0.8,
        source: "amf_harvester",
      }),
      createTestEvent({
        id: "22222222-bbbb-cccc-dddd-eeeeeeeeeeee",
        text: "AMF parity gap: Missing module auth — interface not implemented",
        importance: 0.8,
        source: "amf_harvester",
      }),
    ];

    const promoted = promoteAMFFindings(events, store);
    // Should promote recurring gap + latest parity (both start with "AMF parity")
    expect(promoted).toBeGreaterThanOrEqual(1);
    const recurringUpserts = store.upserts.filter(
      (u) => u.section === "lessons_learned" && String(u.value).includes("Recurring"),
    );
    expect(recurringUpserts.length).toBe(1);
  });

  it("ignores low-importance events", () => {
    const store = createMockSemanticStore();
    const events: EpisodicEvent[] = [
      createTestEvent({
        text: "AMF parity score: 0.95",
        importance: 0.5, // below threshold
        source: "amf_harvester",
      }),
    ];

    expect(promoteAMFFindings(events, store)).toBe(0);
    expect(store.upserts.length).toBe(0);
  });

  it("ignores non-amf_harvester events", () => {
    const store = createMockSemanticStore();
    const events: EpisodicEvent[] = [
      createTestEvent({
        text: "AMF parity score: 0.5",
        importance: 0.9,
        source: "user", // not amf_harvester
      }),
    ];

    expect(promoteAMFFindings(events, store)).toBe(0);
  });
});
