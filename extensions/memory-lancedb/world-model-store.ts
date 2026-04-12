/**
 * WorldModelStore — structured file-based world model for OpenCLOODA Phase 2.
 *
 * Stores projects, areas, reference wiki, and an index under ~/.openclaw/world-model/.
 * All writes are atomic (write .tmp then fs.renameSync) to prevent partial reads.
 */

import fs from "node:fs";
import path from "node:path";

// ============================================================================
// Types
// ============================================================================

export interface ProjectState {
  id: string;
  name: string;
  goal: string;
  successCriteria: string[];
  milestone: string;
  milestoneBlocking: string[];
  openCRs: {
    name: string;
    status: "WRITTEN" | "PARTIAL" | "IMPLEMENTED";
    fixes?: { n: number; done: boolean }[];
  }[];
  lastRun?: {
    id: string;
    label: string;
    result: string;
    parity?: number;
    rootCause?: string;
  };
  nextAction: string;
  createdAt: number;
  updatedAt: number;
  status: "active" | "paused" | "complete";
}

export interface AreaState {
  id: string;
  name: string;
  description: string;
  currentStatus: string;
  lastChecked: number;
  updatedAt: number;
}

export interface WorldModelIndex {
  version: number;
  updatedAt: number;
  projects: {
    id: string;
    name: string;
    status: "active" | "paused" | "complete";
    milestone: string;
    nextAction: string;
    updatedAt: number;
  }[];
  areas: {
    id: string;
    name: string;
    currentStatus: string;
    updatedAt: number;
  }[];
  reference: {
    filename: string;
    title: string;
    updatedAt: number;
  }[];
}

export interface WorldModelMeta {
  bootstrapComplete: boolean;
  bootstrapCompletedAt?: number;
  lastReflect?: number;
  lastSlowClarify?: number;
  /** Count of significant episodic events since last Reflect run. */
  eventsSinceLastReflect?: number;
  /** Summary paragraph from the last Reflect run. */
  lastReflectSummary?: string;
  pendingProjectSuggestions: {
    topicKey: string;
    sampleText: string;
    suggestedAt: number;
    dismissedAt?: number;
  }[];
}

// ============================================================================
// Constants
// ============================================================================

export const BOOTSTRAP_PROMPT = `## World Model Bootstrap Required

Your world model is empty. Before we start, let's set it up — it will take about 5 minutes and will make every future session significantly better.

I'll ask you about each of your active projects, one at a time.

**First project: AMF Platform**

1. What is the overall goal? (one sentence)
2. What are the success criteria? (what does "done" look like?)
3. What is the current milestone?
4. What's blocking the current milestone? (or "nothing" if unblocked)
5. What's the next action?

(You can say "skip" for any project or "done" to finish early)`;

const ENGINEERING_DISCIPLINE_CONTENT = `# Engineering Discipline

## Branch = Hypothesis, Main = Certified

- main only receives merges validated end-to-end
- Feature branches are hypotheses — never merge incomplete features
- Merge = parity certificate, not a time gate

## Five-Why Rule

Never stop at the proximate cause. Keep asking "why" until you hit a structural/design gap.
Coherence ≠ correctness — a confident fluent answer is not a verified one.

## Verify Before Commit

- Partial fix ≠ full fix — state explicitly which fixes are in before running
- After Claude Code returns: verify each fix against the CR's list, not just "tests pass"
- Never mark a CR IMPLEMENTED until all fixes confirmed in code
- Never start a validation run until all CRs targeting that failure are fully implemented

## CR Discipline

- CRs are the spec. Agents read the CR file directly — never paraphrase.
- Read existing code before implementing — agents must know what already exists.
- Root cause before writing the fix.
`;

// ============================================================================
// WorldModelStore
// ============================================================================

export class WorldModelStore {
  private readonly basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
    fs.mkdirSync(path.join(basePath, "projects"), { recursive: true });
    fs.mkdirSync(path.join(basePath, "areas"), { recursive: true });
    fs.mkdirSync(path.join(basePath, "reference"), { recursive: true });
    fs.mkdirSync(path.join(basePath, "someday"), { recursive: true });
  }

  // --------------------------------------------------------------------------
  // Projects
  // --------------------------------------------------------------------------

  readProject(id: string): ProjectState | null {
    const fp = this.filePath("projects", id);
    try {
      const raw = fs.readFileSync(fp, "utf8");
      return JSON.parse(raw) as ProjectState;
    } catch {
      return null;
    }
  }

  writeProject(project: ProjectState): void {
    const fp = this.filePath("projects", project.id);
    this.atomicWrite(fp, JSON.stringify(project, null, 2));
    this.rebuildIndex();
  }

  listProjects(status?: "active" | "paused" | "complete"): ProjectState[] {
    const dir = path.join(this.basePath, "projects");
    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
      const projects: ProjectState[] = [];
      for (const f of files) {
        try {
          const raw = fs.readFileSync(path.join(dir, f), "utf8");
          const p = JSON.parse(raw) as ProjectState;
          if (!status || p.status === status) {
            projects.push(p);
          }
        } catch {
          // skip corrupt files
        }
      }
      return projects;
    } catch {
      return [];
    }
  }

  patchProject(id: string, patch: Partial<ProjectState>): void {
    const existing = this.readProject(id);
    if (!existing) {
      throw new Error(`Project not found: ${id}`);
    }
    const updated = { ...existing, ...patch, id: existing.id, updatedAt: Date.now() };
    this.writeProject(updated);
  }

  // --------------------------------------------------------------------------
  // Areas
  // --------------------------------------------------------------------------

  readArea(id: string): AreaState | null {
    const fp = this.filePath("areas", id);
    try {
      const raw = fs.readFileSync(fp, "utf8");
      return JSON.parse(raw) as AreaState;
    } catch {
      return null;
    }
  }

  writeArea(area: AreaState): void {
    const fp = this.filePath("areas", area.id);
    this.atomicWrite(fp, JSON.stringify(area, null, 2));
    this.rebuildIndex();
  }

  patchArea(id: string, patch: Partial<AreaState>): void {
    const existing = this.readArea(id);
    if (!existing) {
      throw new Error(`Area not found: ${id}`);
    }
    const updated = { ...existing, ...patch, id: existing.id, updatedAt: Date.now() };
    this.writeArea(updated);
  }

  listAreas(): AreaState[] {
    const dir = path.join(this.basePath, "areas");
    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
      const areas: AreaState[] = [];
      for (const f of files) {
        try {
          const raw = fs.readFileSync(path.join(dir, f), "utf8");
          areas.push(JSON.parse(raw) as AreaState);
        } catch {
          // skip corrupt files
        }
      }
      return areas;
    } catch {
      return [];
    }
  }

  // --------------------------------------------------------------------------
  // Reference
  // --------------------------------------------------------------------------

  readReference(filename: string): string | null {
    const fp = path.join(this.basePath, "reference", filename);
    try {
      return fs.readFileSync(fp, "utf8");
    } catch {
      return null;
    }
  }

  writeReference(filename: string, title: string, content: string): void {
    const fp = path.join(this.basePath, "reference", filename);
    this.atomicWrite(fp, content);
    // Rebuild index to include reference listing
    this.rebuildIndex();
  }

  listReference(): { filename: string; title: string; updatedAt: number }[] {
    const dir = path.join(this.basePath, "reference");
    try {
      const files = fs.readdirSync(dir).filter((f) => !f.endsWith(".tmp"));
      return files.map((f) => {
        const fp = path.join(dir, f);
        const stat = fs.statSync(fp);
        // Extract title from first line (# Title) or use filename
        let title = f;
        try {
          const raw = fs.readFileSync(fp, "utf8");
          const match = raw.match(/^#\s+(.+)/m);
          if (match) title = match[1];
        } catch {
          // use filename as title
        }
        return { filename: f, title, updatedAt: stat.mtimeMs };
      });
    } catch {
      return [];
    }
  }

  // --------------------------------------------------------------------------
  // Index
  // --------------------------------------------------------------------------

  readIndex(): WorldModelIndex {
    const fp = path.join(this.basePath, "index.json");
    try {
      const raw = fs.readFileSync(fp, "utf8");
      return JSON.parse(raw) as WorldModelIndex;
    } catch {
      return { version: 1, updatedAt: Date.now(), projects: [], areas: [], reference: [] };
    }
  }

  private rebuildIndex(): void {
    const projects = this.listProjects();
    const areas = this.listAreas();
    const reference = this.listReference();

    const index: WorldModelIndex = {
      version: 1,
      updatedAt: Date.now(),
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        status: p.status,
        milestone: p.milestone,
        nextAction: p.nextAction,
        updatedAt: p.updatedAt,
      })),
      areas: areas.map((a) => ({
        id: a.id,
        name: a.name,
        currentStatus: a.currentStatus,
        updatedAt: a.updatedAt,
      })),
      reference,
    };

    const fp = path.join(this.basePath, "index.json");
    this.atomicWrite(fp, JSON.stringify(index, null, 2));
  }

  // --------------------------------------------------------------------------
  // Meta
  // --------------------------------------------------------------------------

  readMeta(): WorldModelMeta {
    const fp = path.join(this.basePath, "meta.json");
    try {
      const raw = fs.readFileSync(fp, "utf8");
      return JSON.parse(raw) as WorldModelMeta;
    } catch {
      return { bootstrapComplete: false, pendingProjectSuggestions: [] };
    }
  }

  writeMeta(meta: WorldModelMeta): void {
    const fp = path.join(this.basePath, "meta.json");
    this.atomicWrite(fp, JSON.stringify(meta, null, 2));
  }

  // --------------------------------------------------------------------------
  // Bootstrap
  // --------------------------------------------------------------------------

  isBootstrapped(): boolean {
    return this.readMeta().bootstrapComplete;
  }

  /**
   * Seed the reference wiki with engineering-discipline.md on bootstrap completion.
   */
  seedReferenceWiki(): void {
    this.writeReference(
      "engineering-discipline.md",
      "Engineering Discipline",
      ENGINEERING_DISCIPLINE_CONTENT,
    );
  }

  // --------------------------------------------------------------------------
  // Utilities
  // --------------------------------------------------------------------------

  private filePath(category: string, id: string): string {
    return path.join(this.basePath, category, `${id}.json`);
  }

  private atomicWrite(filePath: string, content: string): void {
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, content, "utf8");
    fs.renameSync(tmpPath, filePath);
  }
}

// ============================================================================
// Renderers (for Orient SITREP injection)
// ============================================================================

export function renderWorldModelSection(projects: ProjectState[], areas: AreaState[]): string {
  let out = "\n## World Model\n";

  if (projects.length > 0) {
    out += "\n### Active Projects\n";
    for (const p of projects) {
      out += `**${p.name}**\n`;
      out += `Goal: ${p.goal}\n`;
      out += `Milestone: ${p.milestone}\n`;
      if (p.milestoneBlocking.length > 0) {
        out += `Blocking: ${p.milestoneBlocking.join("; ")}\n`;
      }
      if (p.lastRun) {
        out += `Last run: ${p.lastRun.label} — ${p.lastRun.result}`;
        if (p.lastRun.rootCause) out += ` (${p.lastRun.rootCause})`;
        out += "\n";
      }
      out += `Next action: ${p.nextAction}\n`;
      if (p.openCRs.length > 0) {
        const openCRs = p.openCRs.filter((cr) => cr.status !== "IMPLEMENTED");
        if (openCRs.length > 0) {
          out += `Open CRs: ${openCRs.map((cr) => `${cr.name} (${cr.status})`).join(", ")}\n`;
        }
      }
      out += "\n";
    }
  }

  if (areas.length > 0) {
    out += "### Areas\n";
    for (const a of areas) {
      out += `**${a.name}**: ${a.currentStatus}\n`;
    }
    out += "\n";
  }

  return out;
}

export function renderSuggestions(
  suggestions: WorldModelMeta["pendingProjectSuggestions"],
): string {
  if (suggestions.length === 0) return "";
  let out = "\n## Pending Project Suggestions\n";
  for (const s of suggestions) {
    out += `- "${s.topicKey}" may warrant a project (sample: "${s.sampleText.slice(0, 80)}"). Confirm with user.\n`;
  }
  return out;
}
