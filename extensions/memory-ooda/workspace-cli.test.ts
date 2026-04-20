import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveAdmissionCase } from "./admission-gate.js";
import { formBelief } from "./beliefs.js";
import {
  registerAdmissionCommands,
  registerBeliefsCommands,
  registerKnowledgeCommands,
  registerSoulCommands,
  type CLICommand,
} from "./cli.js";
import type { AdmissionCase } from "./types.js";

// ============================================================================
// Mock CLI harness
// ============================================================================

type ActionFn = (...args: unknown[]) => void | Promise<void>;

interface MockCommand {
  name: string;
  actionFn: ActionFn | null;
  children: Map<string, MockCommand>;
}

function createMockCommand(name = "root"): CLICommand & { _mock: MockCommand } {
  const mock: MockCommand = { name, actionFn: null, children: new Map() };
  const cmd: CLICommand & { _mock: MockCommand } = {
    _mock: mock,
    command(n: string) {
      const child = createMockCommand(n);
      mock.children.set(n, child._mock);
      return child;
    },
    description() {
      return cmd;
    },
    argument() {
      return cmd;
    },
    option() {
      return cmd;
    },
    action(fn: ActionFn) {
      mock.actionFn = fn;
      return cmd;
    },
  };
  return cmd;
}

function getAction(parent: MockCommand, ...p: string[]): ActionFn {
  let current = parent;
  for (const name of p) {
    const child = current.children.get(name);
    if (!child) throw new Error(`missing ${name}`);
    current = child;
  }
  if (!current.actionFn) throw new Error(`no action on ${current.name}`);
  return current.actionFn;
}

// ============================================================================
// admission
// ============================================================================

describe("admission CLI", () => {
  let tmp: string;
  let workspace: ReturnType<typeof createMockCommand>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-cli-admission-"));
    workspace = createMockCommand("workspace");
    registerAdmissionCommands(workspace, tmp);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("list empty corpus suggests capture command", () => {
    getAction(workspace._mock, "admission", "list")({});
    const out = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toMatch(/No admission cases yet/);
  });

  it("list --json on populated corpus returns array", () => {
    saveAdmissionCase(tmp, {
      id: "c1",
      label: "deploy staging ok",
      fixture: {
        observation: "",
        knowledge: {} as AdmissionCase["fixture"]["knowledge"],
        priorities: {} as AdmissionCase["fixture"]["priorities"],
      },
      expected: {
        actionId: "c1",
        description: "",
        successSignal: "",
        failureSignal: "",
        domain: "ops",
      },
      priorOutcome: "success",
      capturedAt: new Date().toISOString(),
    });
    getAction(workspace._mock, "admission", "list")({ json: true });
    const parsed = JSON.parse(logSpy.mock.calls.map((c) => String(c[0])).join(""));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("c1");
  });

  it("capture writes a stub case file", () => {
    getAction(workspace._mock, "admission", "capture")("c-new", "fresh case", {
      domain: "ops",
      priorOutcome: "failure",
      observation: "obs",
    });
    const dir = path.join(tmp, ".admission-cases");
    expect(fs.existsSync(path.join(dir, "c-new.json"))).toBe(true);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, "c-new.json"), "utf-8"));
    expect(stored.id).toBe("c-new");
    expect(stored.priorOutcome).toBe("failure");
    expect(stored.expected.domain).toBe("ops");
  });

  it("capture rejects bad ids", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const originalExit = process.exitCode;
    getAction(workspace._mock, "admission", "capture")("bad id with spaces", "x", {});
    expect(errSpy).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    process.exitCode = originalExit;
    errSpy.mockRestore();
  });
});

// ============================================================================
// knowledge
// ============================================================================

function seedKnowledge(tmp: string): void {
  fs.writeFileSync(
    path.join(tmp, "KNOWLEDGE.json"),
    JSON.stringify({
      _meta: {
        version: 1,
        updated_at: "2026-04-01T00:00:00Z",
        updated_by: "user",
        turn_count_at_last_update: 0,
        description: "test",
      },
      identity: {
        name: "",
        timezone: "",
        location_primary: "",
        language_primary: "",
        communication_style: "",
      },
      stack: {},
      projects: {},
      people: {},
      commitments: [],
      domain_context: {},
      lessons_learned: {},
      preferences: { never_do: [], always_ask_before: [] },
      preferences_notes: {},
      _archivist_log: [
        { timestamp: "2026-04-01T10:00:00Z", action: "upsert_fact", reason: "testA" },
        { timestamp: "2026-04-01T11:00:00Z", action: "upsert_fact", reason: "testB" },
      ],
      _temporal: {},
    }),
  );
}

describe("knowledge CLI", () => {
  let tmp: string;
  let workspace: ReturnType<typeof createMockCommand>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-cli-knowledge-"));
    seedKnowledge(tmp);
    workspace = createMockCommand("workspace");
    registerKnowledgeCommands(workspace, tmp);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("history prints newest entries first", () => {
    getAction(workspace._mock, "knowledge", "history")({});
    const out = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out.indexOf("testB")).toBeLessThan(out.indexOf("testA"));
  });

  it("history --json returns array", () => {
    getAction(workspace._mock, "knowledge", "history")({ json: true });
    const parsed = JSON.parse(logSpy.mock.calls.map((c) => String(c[0])).join(""));
    expect(parsed).toHaveLength(2);
  });

  it("asof emits raw JSON snapshot", () => {
    getAction(workspace._mock, "knowledge", "asof")("2026-05-01T00:00:00Z", {});
    const parsed = JSON.parse(logSpy.mock.calls.map((c) => String(c[0])).join(""));
    expect(parsed._meta).toBeDefined();
  });
});

// ============================================================================
// beliefs
// ============================================================================

describe("beliefs CLI", () => {
  let tmp: string;
  let workspace: ReturnType<typeof createMockCommand>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-cli-beliefs-"));
    workspace = createMockCommand("workspace");
    registerBeliefsCommands(workspace, tmp);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("list --json on empty state returns []", () => {
    getAction(workspace._mock, "beliefs", "list")({ json: true });
    const parsed = JSON.parse(logSpy.mock.calls.map((c) => String(c[0])).join(""));
    expect(parsed).toEqual([]);
  });

  it("form creates a belief", () => {
    getAction(workspace._mock, "beliefs", "form")("b1", "async replies outperform sync", {
      domain: "comms",
      confidence: "0.7",
    });
    // Reset spy so the list output isn't concatenated with form's log line.
    logSpy.mockClear();
    getAction(workspace._mock, "beliefs", "list")({ json: true });
    const parsed = JSON.parse(logSpy.mock.calls.map((c) => String(c[0])).join(""));
    const last = parsed[parsed.length - 1];
    expect(last.id).toBe("b1");
    expect(last.confidence).toBeCloseTo(0.7, 5);
  });

  it("retire flips retired field", () => {
    formBelief(tmp, {
      id: "b2",
      claim: "x",
      domain: "general",
      confidence: 0.6,
    });
    getAction(workspace._mock, "beliefs", "retire")("b2", "superseded by b3");
    getAction(workspace._mock, "beliefs", "show")("b2");
    const combined = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(combined).toContain("superseded by b3");
    expect(combined).toMatch(/retired/);
  });

  it("show unknown id sets exit code 1", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const before = process.exitCode;
    getAction(workspace._mock, "beliefs", "show")("nope");
    expect(process.exitCode).toBe(1);
    process.exitCode = before;
    errSpy.mockRestore();
  });
});

// ============================================================================
// soul — only the --path branch is unit-testable without spawning $EDITOR
// ============================================================================

describe("soul CLI", () => {
  let tmp: string;
  let workspace: ReturnType<typeof createMockCommand>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-cli-soul-"));
    workspace = createMockCommand("workspace");
    registerSoulCommands(workspace, tmp);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("--path prints the resolved SOUL.md location without editing", async () => {
    await getAction(workspace._mock, "soul")({ path: true });
    const out = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("SOUL.md");
    // Should NOT have created the file (path-only mode).
    expect(fs.existsSync(path.join(tmp, "SOUL.md"))).toBe(false);
  });
});
