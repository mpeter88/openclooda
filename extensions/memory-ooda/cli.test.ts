import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerProposalsCommands,
  registerRollbackCommands,
  registerStatusCommand,
  type CLICommand,
} from "./cli.js";
import { addProposal } from "./proposals.js";
import { createSnapshot } from "./snapshot.js";

// ============================================================================
// CLI Mock
// ============================================================================

type ActionFn = (...args: unknown[]) => void | Promise<void>;

interface MockCommand {
  name: string;
  desc: string;
  args: Array<{ name: string; desc: string }>;
  opts: Array<{ flags: string; desc: string }>;
  actionFn: ActionFn | null;
  children: Map<string, MockCommand>;
}

function createMockCommand(name = "root"): CLICommand & { _mock: MockCommand } {
  const mock: MockCommand = {
    name,
    desc: "",
    args: [],
    opts: [],
    actionFn: null,
    children: new Map(),
  };

  const cmd: CLICommand & { _mock: MockCommand } = {
    _mock: mock,
    command(n: string) {
      const child = createMockCommand(n);
      mock.children.set(n, child._mock);
      return child;
    },
    description(d: string) {
      mock.desc = d;
      return cmd;
    },
    argument(n: string, d: string) {
      mock.args.push({ name: n, desc: d });
      return cmd;
    },
    option(f: string, d: string) {
      mock.opts.push({ flags: f, desc: d });
      return cmd;
    },
    action(fn: ActionFn) {
      mock.actionFn = fn;
      return cmd;
    },
  };

  return cmd;
}

function getAction(parent: MockCommand, ...path: string[]): ActionFn {
  let current = parent;
  for (const name of path) {
    const child = current.children.get(name);
    if (!child) throw new Error(`Command "${name}" not found under "${current.name}"`);
    current = child;
  }
  if (!current.actionFn) throw new Error(`No action for "${current.name}"`);
  return current.actionFn;
}

// ============================================================================
// Proposals CLI
// ============================================================================

describe("proposals CLI", () => {
  let tmpDir: string;
  let workspace: ReturnType<typeof createMockCommand>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-cli-test-"));
    workspace = createMockCommand("workspace");
    registerProposalsCommands(workspace, tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registers proposals subcommands", () => {
    const proposals = workspace._mock.children.get("proposals");
    expect(proposals).toBeDefined();
    expect(proposals!.children.has("list")).toBe(true);
    expect(proposals!.children.has("approve")).toBe(true);
    expect(proposals!.children.has("reject")).toBe(true);
    expect(proposals!.children.has("count")).toBe(true);
  });

  it("list shows no proposals message when empty", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const action = getAction(workspace._mock, "proposals", "list");
    action({});
    expect(spy).toHaveBeenCalledWith("No proposals found.");
    spy.mockRestore();
  });

  it("list shows proposals when present", () => {
    addProposal(tmpDir, {
      id: "prop-001",
      timestamp: "2026-03-16T12:00:00Z",
      rule: "test_rule",
      proposal: "Change the rule",
      reasoning: "It causes failures",
      evidence: ["action-001"],
    });

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const action = getAction(workspace._mock, "proposals", "list");
    action({});

    const output = spy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("[PENDING]");
    expect(output).toContain("prop-001");
    expect(output).toContain("Change the rule");
    spy.mockRestore();
  });

  it("approve updates proposal status", () => {
    addProposal(tmpDir, {
      id: "prop-001",
      timestamp: "2026-03-16T12:00:00Z",
      rule: "test_rule",
      proposal: "Change the rule",
      reasoning: "It causes failures",
      evidence: ["action-001"],
    });

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const action = getAction(workspace._mock, "proposals", "approve");
    action("prop-001");

    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Approved"));
    spy.mockRestore();
  });

  it("approve shows error for non-existent proposal", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const action = getAction(workspace._mock, "proposals", "approve");
    action("nonexistent");

    expect(spy).toHaveBeenCalledWith(expect.stringContaining("not found"));
    spy.mockRestore();
  });

  it("reject updates proposal status", () => {
    addProposal(tmpDir, {
      id: "prop-001",
      timestamp: "2026-03-16T12:00:00Z",
      rule: "test_rule",
      proposal: "Change the rule",
      reasoning: "It causes failures",
      evidence: ["action-001"],
    });

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const action = getAction(workspace._mock, "proposals", "reject");
    action("prop-001");

    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Rejected"));
    spy.mockRestore();
  });

  it("count shows pending count", () => {
    addProposal(tmpDir, {
      id: "prop-001",
      timestamp: "2026-03-16T12:00:00Z",
      rule: "r",
      proposal: "p",
      reasoning: "r",
      evidence: ["a"],
    });
    addProposal(tmpDir, {
      id: "prop-002",
      timestamp: "2026-03-16T12:00:00Z",
      rule: "r",
      proposal: "p",
      reasoning: "r",
      evidence: ["a"],
    });

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const action = getAction(workspace._mock, "proposals", "count");
    action();

    expect(spy).toHaveBeenCalledWith("2 pending proposals");
    spy.mockRestore();
  });

  it("count uses singular when 1 pending", () => {
    addProposal(tmpDir, {
      id: "prop-001",
      timestamp: "2026-03-16T12:00:00Z",
      rule: "r",
      proposal: "p",
      reasoning: "r",
      evidence: ["a"],
    });

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const action = getAction(workspace._mock, "proposals", "count");
    action();

    expect(spy).toHaveBeenCalledWith("1 pending proposal");
    spy.mockRestore();
  });
});

// ============================================================================
// Rollback CLI
// ============================================================================

describe("rollback CLI", () => {
  let tmpDir: string;
  let workspace: ReturnType<typeof createMockCommand>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-cli-rollback-"));
    workspace = createMockCommand("workspace");
    registerRollbackCommands(workspace, tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registers rollback subcommands", () => {
    const rollback = workspace._mock.children.get("rollback");
    expect(rollback).toBeDefined();
    expect(rollback!.children.has("list")).toBe(true);
    expect(rollback!.children.has("restore")).toBe(true);
  });

  it("list shows no snapshots message when empty", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const action = getAction(workspace._mock, "rollback", "list");
    action();

    expect(spy).toHaveBeenCalledWith("No snapshots available.");
    spy.mockRestore();
  });

  it("list shows snapshots when present", () => {
    // Create a file and snapshot it
    fs.writeFileSync(path.join(tmpDir, "KNOWLEDGE.json"), "{}");
    createSnapshot(tmpDir, "KNOWLEDGE.json");

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const action = getAction(workspace._mock, "rollback", "list");
    action();

    const output = spy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("KNOWLEDGE.json");
    spy.mockRestore();
  });

  it("restore restores knowledge snapshot", () => {
    // Write original, snapshot, then overwrite
    const filePath = path.join(tmpDir, "KNOWLEDGE.json");
    fs.writeFileSync(filePath, '{"original": true}');
    createSnapshot(tmpDir, "KNOWLEDGE.json");
    fs.writeFileSync(filePath, '{"modified": true}');

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const action = getAction(workspace._mock, "rollback", "restore");
    action("knowledge");

    expect(spy).toHaveBeenCalledWith("Restored latest snapshot of KNOWLEDGE.json");
    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(content.original).toBe(true);
    spy.mockRestore();
  });

  it("restore restores priorities snapshot", () => {
    const filePath = path.join(tmpDir, "PRIORITIES.json");
    fs.writeFileSync(filePath, '{"original": true}');
    createSnapshot(tmpDir, "PRIORITIES.json");
    fs.writeFileSync(filePath, '{"modified": true}');

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const action = getAction(workspace._mock, "rollback", "restore");
    action("priorities");

    expect(spy).toHaveBeenCalledWith("Restored latest snapshot of PRIORITIES.json");
    spy.mockRestore();
  });

  it("restore shows error for unknown target", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const action = getAction(workspace._mock, "rollback", "restore");
    action("unknown");

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('Unknown target "unknown"'));
    spy.mockRestore();
  });

  it("restore shows error when no snapshot available", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const action = getAction(workspace._mock, "rollback", "restore");
    action("knowledge");

    expect(spy).toHaveBeenCalledWith(expect.stringContaining("No snapshots available"));
    spy.mockRestore();
  });
});

// ============================================================================
// Status CLI
// ============================================================================

describe("status CLI", () => {
  let tmpDir: string;
  let workspace: ReturnType<typeof createMockCommand>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-cli-status-"));
    workspace = createMockCommand("workspace");
    registerStatusCommand(workspace, tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("shows overview with zero counts", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const action = getAction(workspace._mock, "status");
    action();

    const output = spy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("OODA Workspace Status");
    expect(output).toContain("Pending proposals: 0");
    expect(output).toContain("KNOWLEDGE.json snapshots: 0");
    expect(output).toContain("PRIORITIES.json snapshots: 0");
    spy.mockRestore();
  });

  it("shows non-zero counts", () => {
    // Add a proposal
    addProposal(tmpDir, {
      id: "prop-001",
      timestamp: "2026-03-16T12:00:00Z",
      rule: "r",
      proposal: "p",
      reasoning: "r",
      evidence: ["a"],
    });

    // Create a snapshot
    fs.writeFileSync(path.join(tmpDir, "KNOWLEDGE.json"), "{}");
    createSnapshot(tmpDir, "KNOWLEDGE.json");

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const action = getAction(workspace._mock, "status");
    action();

    const output = spy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Pending proposals: 1");
    expect(output).toContain("KNOWLEDGE.json snapshots: 1");
    spy.mockRestore();
  });
});
