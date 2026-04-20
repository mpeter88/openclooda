import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerDistortionCommands,
  registerErrorsCommands,
  registerTrajectoryCommands,
  summarizeDistortion,
  type CLICommand,
} from "./cli.js";
import { appendDistortionSample } from "./distortion-index.js";
import { appendTrajectoryAudit } from "./trajectory-audit.js";
import type { DistortionSample, TrajectoryAuditRow } from "./types.js";

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

describe("summarizeDistortion", () => {
  it("classifies healthy regime with balanced samples", () => {
    const now = Date.now();
    const samples: DistortionSample[] = [];
    // 20 samples, measured tracks grounded closely → healthy
    for (let i = 0; i < 20; i++) {
      samples.push({
        domain: "ops",
        timestamp: now - (20 - i) * 60_000,
        measured: 0.7 + i * 0.005,
        grounded: 0.68 + i * 0.005,
        approvalCount: 1,
        overrideCount: 0,
      });
    }
    const s = summarizeDistortion(samples, "/x", { days: 30, minSamples: 10 });
    expect(s.totalSamples).toBe(20);
    expect(s.byDomain.ops.regime).toBe("healthy");
  });

  it("returns insufficient_data with too few samples", () => {
    const s = summarizeDistortion(
      [
        {
          domain: "ops",
          timestamp: Date.now(),
          measured: 0.5,
          grounded: 0.5,
          approvalCount: 0,
          overrideCount: 0,
        },
      ],
      "/x",
      { days: 30, minSamples: 10 },
    );
    expect(s.byDomain.ops.regime).toBe("insufficient_data");
  });
});

describe("distortion CLI", () => {
  let tmp: string;
  let workspace: ReturnType<typeof createMockCommand>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-distortion-cli-"));
    workspace = createMockCommand("workspace");
    registerDistortionCommands(workspace, tmp);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("renders an empty-state message when no history exists", () => {
    getAction(workspace._mock, "distortion")({});
    const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("No samples yet");
  });

  it("--json reports per-domain regime from actual samples", () => {
    const now = Date.now();
    for (let i = 0; i < 15; i++) {
      appendDistortionSample(tmp, {
        domain: "ops",
        timestamp: now - (15 - i) * 60_000,
        measured: 0.5 + i * 0.01,
        grounded: 0.5 + i * 0.01,
        approvalCount: 1,
        overrideCount: 0,
      });
    }
    getAction(workspace._mock, "distortion")({ json: true });
    const out = logSpy.mock.calls.map((c) => String(c[0])).join("");
    const parsed = JSON.parse(out);
    expect(parsed.totalSamples).toBe(15);
    expect(parsed.byDomain.ops.regime).toBe("healthy");
  });
});

describe("trajectory CLI", () => {
  let tmp: string;
  let workspace: ReturnType<typeof createMockCommand>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-trajectory-cli-"));
    workspace = createMockCommand("workspace");
    registerTrajectoryCommands(workspace, tmp);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("reports totalRows=0 when no audit data exists", () => {
    getAction(workspace._mock, "trajectory", "report")({ json: true });
    const out = logSpy.mock.calls.map((c) => String(c[0])).join("");
    const parsed = JSON.parse(out);
    expect(parsed.totalRows).toBe(0);
  });

  it("counts audit rows from the audit log", () => {
    const row = (mode: TrajectoryAuditRow["mode"]): TrajectoryAuditRow => ({
      timestamp: Date.now(),
      sitrepSummary: "t",
      rawPriority: 5,
      scaledPriority: 5,
      quadrant: "neutral",
      scaleApplied: 1,
      domains: [],
      avgTrajectory: 0,
      mode,
    });
    appendTrajectoryAudit(tmp, row("live"));
    appendTrajectoryAudit(tmp, row("shadow"));
    appendTrajectoryAudit(tmp, row("shadow"));
    getAction(workspace._mock, "trajectory", "report")({ json: true });
    const out = logSpy.mock.calls.map((c) => String(c[0])).join("");
    const parsed = JSON.parse(out);
    expect(parsed.totalRows).toBe(3);
  });
});

describe("errors CLI", () => {
  let tmp: string;
  let workspace: ReturnType<typeof createMockCommand>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-errors-cli-"));
    workspace = createMockCommand("workspace");
    registerErrorsCommands(workspace, tmp);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("stats --json returns empty shape when no axis-priors file exists", () => {
    getAction(workspace._mock, "errors", "stats")({ json: true });
    const out = logSpy.mock.calls.map((c) => String(c[0])).join("");
    const parsed = JSON.parse(out);
    expect(parsed.priors).toEqual([]);
  });

  it("stats prints priors when .axis-priors.json is populated", () => {
    fs.writeFileSync(
      path.join(tmp, ".axis-priors.json"),
      JSON.stringify({
        generatedAt: "2026-04-19T00:00:00Z",
        windowDays: 30,
        priors: [
          {
            domain: "ops",
            axis: "planning",
            countCritical: 1,
            countMajor: 2,
            countMinor: 0,
            axisRate: 0.25,
            topSignals: [{ signal: "wrong_strategy", count: 2 }],
          },
        ],
      }),
    );
    getAction(workspace._mock, "errors", "stats")({});
    const out = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("ops");
    expect(out).toContain("planning");
    expect(out).toContain("wrong_strategy");
  });

  it("recent prints 'No error tags' when sidecar missing", () => {
    getAction(workspace._mock, "errors", "recent")({});
    const out = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("No error tags yet");
  });

  it("recent shows tags from .error-tags.jsonl", () => {
    fs.appendFileSync(
      path.join(tmp, ".error-tags.jsonl"),
      JSON.stringify({
        eventId: "evt-1",
        tags: [
          {
            axis: "action",
            severity: "major",
            signal: "tool_timeout",
            confidence: 0.8,
          },
        ],
        at: "2026-04-19T00:00:00Z",
      }) + "\n",
    );
    getAction(workspace._mock, "errors", "recent")({ json: true });
    const out = logSpy.mock.calls.map((c) => String(c[0])).join("");
    const parsed = JSON.parse(out);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].tags[0].signal).toBe("tool_timeout");
  });
});
