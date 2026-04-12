import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  WorldModelStore,
  BOOTSTRAP_PROMPT,
  renderWorldModelSection,
  renderSuggestions,
  type ProjectState,
  type AreaState,
} from "./world-model-store.js";

function makeProject(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    id: "test-project",
    name: "Test Project",
    goal: "Build the thing",
    successCriteria: ["It works", "It ships"],
    milestone: "MVP",
    milestoneBlocking: [],
    openCRs: [],
    nextAction: "Write code",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: "active",
    ...overrides,
  };
}

function makeArea(overrides: Partial<AreaState> = {}): AreaState {
  return {
    id: "test-area",
    name: "Test Area",
    description: "Keep it running",
    currentStatus: "Healthy",
    lastChecked: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("WorldModelStore", () => {
  let tmpDir: string;
  let store: WorldModelStore;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "wm-test-"));
    store = new WorldModelStore(tmpDir);
  });

  afterEach(async () => {
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("constructor creates directory structure", () => {
    expect(fs.existsSync(path.join(tmpDir, "projects"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "areas"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "reference"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "someday"))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Projects
  // --------------------------------------------------------------------------

  test("writeProject creates file and updates index", () => {
    const project = makeProject();
    store.writeProject(project);

    const fp = path.join(tmpDir, "projects", "test-project.json");
    expect(fs.existsSync(fp)).toBe(true);

    const raw = JSON.parse(fs.readFileSync(fp, "utf8"));
    expect(raw.id).toBe("test-project");
    expect(raw.name).toBe("Test Project");

    // Index should be updated
    const index = store.readIndex();
    expect(index.projects).toHaveLength(1);
    expect(index.projects[0].id).toBe("test-project");
  });

  test("readProject returns null for missing project", () => {
    expect(store.readProject("nonexistent")).toBeNull();
  });

  test("readProject returns stored project", () => {
    const project = makeProject();
    store.writeProject(project);
    const read = store.readProject("test-project");
    expect(read).not.toBeNull();
    expect(read!.name).toBe("Test Project");
  });

  test("listProjects filters by status", () => {
    store.writeProject(makeProject({ id: "p1", status: "active" }));
    store.writeProject(makeProject({ id: "p2", status: "paused" }));
    store.writeProject(makeProject({ id: "p3", status: "active" }));

    expect(store.listProjects("active")).toHaveLength(2);
    expect(store.listProjects("paused")).toHaveLength(1);
    expect(store.listProjects("complete")).toHaveLength(0);
    expect(store.listProjects()).toHaveLength(3);
  });

  test("patchProject only changes specified fields", () => {
    const project = makeProject({ milestone: "Alpha", nextAction: "Design" });
    store.writeProject(project);

    store.patchProject("test-project", { milestone: "Beta" });

    const patched = store.readProject("test-project")!;
    expect(patched.milestone).toBe("Beta");
    expect(patched.nextAction).toBe("Design"); // unchanged
    expect(patched.id).toBe("test-project"); // id preserved
  });

  test("patchProject throws for missing project", () => {
    expect(() => store.patchProject("nonexistent", { milestone: "X" })).toThrow(
      "Project not found",
    );
  });

  // --------------------------------------------------------------------------
  // Areas
  // --------------------------------------------------------------------------

  test("writeArea creates file and updates index", () => {
    const area = makeArea();
    store.writeArea(area);

    const fp = path.join(tmpDir, "areas", "test-area.json");
    expect(fs.existsSync(fp)).toBe(true);

    const index = store.readIndex();
    expect(index.areas).toHaveLength(1);
    expect(index.areas[0].id).toBe("test-area");
  });

  test("readArea returns null for missing area", () => {
    expect(store.readArea("nonexistent")).toBeNull();
  });

  test("listAreas returns all areas", () => {
    store.writeArea(makeArea({ id: "a1" }));
    store.writeArea(makeArea({ id: "a2" }));
    expect(store.listAreas()).toHaveLength(2);
  });

  // --------------------------------------------------------------------------
  // Reference
  // --------------------------------------------------------------------------

  test("writeReference creates file and includes in index", () => {
    store.writeReference("test.md", "Test Doc", "# Test Doc\n\nContent here.");

    const content = store.readReference("test.md");
    expect(content).toBe("# Test Doc\n\nContent here.");

    const index = store.readIndex();
    expect(index.reference).toHaveLength(1);
    expect(index.reference[0].filename).toBe("test.md");
    expect(index.reference[0].title).toBe("Test Doc");
  });

  test("readReference returns null for missing file", () => {
    expect(store.readReference("nonexistent.md")).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Atomic writes
  // --------------------------------------------------------------------------

  test("atomic write leaves no .tmp files", () => {
    store.writeProject(makeProject());
    const files = fs.readdirSync(path.join(tmpDir, "projects"));
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Meta + Bootstrap
  // --------------------------------------------------------------------------

  test("isBootstrapped returns false when meta.json missing", () => {
    expect(store.isBootstrapped()).toBe(false);
  });

  test("isBootstrapped returns true after writeMeta with bootstrapComplete", () => {
    store.writeMeta({
      bootstrapComplete: true,
      bootstrapCompletedAt: Date.now(),
      pendingProjectSuggestions: [],
    });
    expect(store.isBootstrapped()).toBe(true);
  });

  test("readMeta returns default when file missing", () => {
    const meta = store.readMeta();
    expect(meta.bootstrapComplete).toBe(false);
    expect(meta.pendingProjectSuggestions).toEqual([]);
  });

  test("seedReferenceWiki creates engineering-discipline.md", () => {
    store.seedReferenceWiki();
    const content = store.readReference("engineering-discipline.md");
    expect(content).not.toBeNull();
    expect(content).toContain("# Engineering Discipline");
    expect(content).toContain("Five-Why Rule");
    expect(content).toContain("CR Discipline");
  });

  // --------------------------------------------------------------------------
  // Index rebuild
  // --------------------------------------------------------------------------

  test("index.json rebuilt after every writeProject and writeArea call", () => {
    store.writeProject(makeProject({ id: "p1" }));
    let index = store.readIndex();
    expect(index.projects).toHaveLength(1);
    expect(index.areas).toHaveLength(0);

    store.writeArea(makeArea({ id: "a1" }));
    index = store.readIndex();
    expect(index.projects).toHaveLength(1);
    expect(index.areas).toHaveLength(1);

    store.writeProject(makeProject({ id: "p2" }));
    index = store.readIndex();
    expect(index.projects).toHaveLength(2);
    expect(index.areas).toHaveLength(1);
  });
});

// ============================================================================
// Renderer tests
// ============================================================================

describe("renderWorldModelSection", () => {
  test("renders active projects correctly", () => {
    const projects: ProjectState[] = [
      {
        id: "amf",
        name: "AMF Platform",
        goal: "Migrate apps",
        successCriteria: ["100% parity"],
        milestone: "KDMS certification",
        milestoneBlocking: ["ProfileManager gap"],
        openCRs: [
          { name: "CR_GRADLE", status: "WRITTEN" },
          { name: "CR_DONE", status: "IMPLEMENTED" },
        ],
        lastRun: { id: "r1", label: "gen16c", result: "47 files", rootCause: "DI regression" },
        nextAction: "Fix gen16 coverage",
        createdAt: 0,
        updatedAt: 0,
        status: "active",
      },
    ];

    const output = renderWorldModelSection(projects, []);
    expect(output).toContain("## World Model");
    expect(output).toContain("**AMF Platform**");
    expect(output).toContain("Goal: Migrate apps");
    expect(output).toContain("Milestone: KDMS certification");
    expect(output).toContain("Blocking: ProfileManager gap");
    expect(output).toContain("Last run: gen16c — 47 files (DI regression)");
    expect(output).toContain("Next action: Fix gen16 coverage");
    expect(output).toContain("CR_GRADLE (WRITTEN)");
    // IMPLEMENTED CRs should be filtered out
    expect(output).not.toContain("CR_DONE");
  });

  test("renders areas", () => {
    const areas: AreaState[] = [
      {
        id: "gw",
        name: "OpenClaw Gateway",
        description: "Keep it stable",
        currentStatus: "Healthy, 99.9% uptime",
        lastChecked: 0,
        updatedAt: 0,
      },
    ];

    const output = renderWorldModelSection([], areas);
    expect(output).toContain("### Areas");
    expect(output).toContain("**OpenClaw Gateway**: Healthy, 99.9% uptime");
  });

  test("renders empty when no projects or areas", () => {
    const output = renderWorldModelSection([], []);
    expect(output).toContain("## World Model");
    expect(output).not.toContain("### Active Projects");
  });
});

describe("renderSuggestions", () => {
  test("renders pending suggestions", () => {
    const suggestions = [
      { topicKey: "new-tool", sampleText: "Been using this tool a lot lately", suggestedAt: 0 },
    ];
    const output = renderSuggestions(suggestions);
    expect(output).toContain("## Pending Project Suggestions");
    expect(output).toContain('"new-tool" may warrant a project');
  });

  test("returns empty string for no suggestions", () => {
    expect(renderSuggestions([])).toBe("");
  });
});

describe("BOOTSTRAP_PROMPT", () => {
  test("contains expected content", () => {
    expect(BOOTSTRAP_PROMPT).toContain("World Model Bootstrap Required");
    expect(BOOTSTRAP_PROMPT).toContain("AMF Platform");
    expect(BOOTSTRAP_PROMPT).toContain("skip");
    expect(BOOTSTRAP_PROMPT).toContain("done");
  });
});
