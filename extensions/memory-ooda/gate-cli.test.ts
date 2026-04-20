import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendGateHistory, type GateHistoryRow } from "./change-gate.js";
import { registerGateCommands, summarizeGateHistory, type CLICommand } from "./cli.js";

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

function mkRow(overrides: Partial<GateHistoryRow> = {}): GateHistoryRow {
  return {
    timestamp: new Date().toISOString(),
    kind: "policy_proposal",
    changeId: "c-1",
    summary: "test change",
    admit: true,
    reason: "ok",
    ranCases: 0,
    duration_ms: 1,
    ...overrides,
  };
}

describe("summarizeGateHistory", () => {
  it("aggregates admits/rejects and per-kind buckets", () => {
    const rows: GateHistoryRow[] = [
      mkRow({ changeId: "a", admit: true, kind: "policy_proposal" }),
      mkRow({ changeId: "b", admit: false, kind: "policy_proposal" }),
      mkRow({ changeId: "c", admit: true, kind: "knowledge_edit", override: true, approver: "mp" }),
    ];
    const s = summarizeGateHistory(rows, "/x/.gate-history.jsonl", 2);
    expect(s.totalRuns).toBe(3);
    expect(s.admits).toBe(2);
    expect(s.rejects).toBe(1);
    expect(s.overrides).toBe(1);
    expect(s.byKind.policy_proposal).toEqual({ admits: 1, rejects: 1 });
    expect(s.byKind.knowledge_edit).toEqual({ admits: 1, rejects: 0 });
    expect(s.recent).toHaveLength(2);
    expect(s.recent[0].changeId).toBe("c");
  });

  it("handles empty history", () => {
    const s = summarizeGateHistory([], "/x/.gate-history.jsonl");
    expect(s.totalRuns).toBe(0);
    expect(s.admits + s.rejects + s.overrides).toBe(0);
    expect(s.recent).toEqual([]);
  });
});

describe("gate CLI", () => {
  let tmp: string;
  let workspace: ReturnType<typeof createMockCommand>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-gate-cli-"));
    workspace = createMockCommand("workspace");
    registerGateCommands(workspace, tmp);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("registers gate status + gate history", () => {
    const gate = workspace._mock.children.get("gate");
    expect(gate).toBeDefined();
    expect(gate!.children.has("status")).toBe(true);
    expect(gate!.children.has("history")).toBe(true);
  });

  it("status prints zero-state header when history is empty", () => {
    const action = getAction(workspace._mock, "gate", "status");
    action({});
    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Total runs:   0");
    expect(output).toContain("Admitted:   0");
  });

  it("status --json returns machine-readable summary", () => {
    appendGateHistory(tmp, mkRow({ admit: false, kind: "knowledge_edit", reason: "regression" }));
    const action = getAction(workspace._mock, "gate", "status");
    action({ json: true });
    const output = logSpy.mock.calls.map((c) => String(c[0])).join("");
    const parsed = JSON.parse(output);
    expect(parsed.totalRuns).toBe(1);
    expect(parsed.rejects).toBe(1);
    expect(parsed.byKind.knowledge_edit.rejects).toBe(1);
  });

  it("history --only-rejected filters to rejected rows", () => {
    appendGateHistory(tmp, mkRow({ changeId: "a", admit: true }));
    appendGateHistory(tmp, mkRow({ changeId: "b", admit: false, reason: "fail" }));
    const action = getAction(workspace._mock, "gate", "history");
    action({ onlyRejected: true, json: true });
    const output = logSpy.mock.calls.map((c) => String(c[0])).join("");
    const parsed = JSON.parse(output) as GateHistoryRow[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0].changeId).toBe("b");
  });

  it("history --kind filters by ChangeKind", () => {
    appendGateHistory(tmp, mkRow({ changeId: "a", kind: "policy_proposal" }));
    appendGateHistory(tmp, mkRow({ changeId: "b", kind: "knowledge_edit" }));
    appendGateHistory(tmp, mkRow({ changeId: "c", kind: "policy_proposal" }));
    const action = getAction(workspace._mock, "gate", "history");
    action({ kind: "policy_proposal", json: true });
    const output = logSpy.mock.calls.map((c) => String(c[0])).join("");
    const parsed = JSON.parse(output) as GateHistoryRow[];
    expect(parsed).toHaveLength(2);
    expect(parsed.every((r) => r.kind === "policy_proposal")).toBe(true);
  });

  it("history --limit caps output", () => {
    for (let i = 0; i < 10; i++) {
      appendGateHistory(tmp, mkRow({ changeId: `c${i}` }));
    }
    const action = getAction(workspace._mock, "gate", "history");
    action({ limit: "3", json: true });
    const output = logSpy.mock.calls.map((c) => String(c[0])).join("");
    const parsed = JSON.parse(output) as GateHistoryRow[];
    expect(parsed).toHaveLength(3);
  });

  it("history (formatted) prints 'no match' when filters exclude everything", () => {
    appendGateHistory(tmp, mkRow({ kind: "policy_proposal" }));
    const action = getAction(workspace._mock, "gate", "history");
    action({ kind: "soul_md_edit" });
    const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("No gate history rows match");
  });
});
