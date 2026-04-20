import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EpisodicEvent } from "./archivist.js";
import {
  appendTrajectoryAudit,
  evaluateTrajectoryScaling,
  readTrajectoryAudit,
} from "./trajectory-audit.js";
import { classifyQuadrant, resolveTrajectoryMode } from "./triage.js";
import type { TrajectoryAuditRow, TrajectoryScalingConfig } from "./types.js";

const defaultConfig: TrajectoryScalingConfig = {
  mode: "live",
  pos_pos_scale: 0.9,
  pos_neg_scale: 0.7,
  neg_pos_scale: 0.8,
  neg_neg_scale: 1.3,
  trajectory_window_days: 30,
  min_outcomes_for_trajectory: 3,
};

describe("trajectory audit log", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-traj-audit-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("append + read roundtrip", () => {
    const row: TrajectoryAuditRow = {
      timestamp: Date.now(),
      sitrepSummary: "test",
      rawPriority: 7,
      scaledPriority: 9,
      quadrant: "neg_neg",
      scaleApplied: 1.3,
      domains: ["amf_pipeline"],
      avgTrajectory: -0.5,
      mode: "live",
    };
    appendTrajectoryAudit(tmpDir, row);
    const rows = readTrajectoryAudit(tmpDir);
    expect(rows).toHaveLength(1);
    expect(rows[0].rawPriority).toBe(7);
    expect(rows[0].scaledPriority).toBe(9);
  });

  it("readTrajectoryAudit returns empty array when no file", () => {
    expect(readTrajectoryAudit(tmpDir)).toEqual([]);
  });
});

describe("resolveTrajectoryMode", () => {
  it("defaults to shadow on missing config", () => {
    expect(resolveTrajectoryMode()).toBe("shadow");
    expect(resolveTrajectoryMode({})).toBe("shadow");
  });

  it("prefers mode when present", () => {
    expect(resolveTrajectoryMode({ mode: "live" })).toBe("live");
    expect(resolveTrajectoryMode({ mode: "off" })).toBe("off");
  });

  it("migrates enabled:true to live", () => {
    expect(resolveTrajectoryMode({ enabled: true })).toBe("live");
  });

  it("migrates enabled:false to off", () => {
    expect(resolveTrajectoryMode({ enabled: false })).toBe("off");
  });

  it("mode takes precedence over enabled", () => {
    expect(resolveTrajectoryMode({ mode: "shadow", enabled: true })).toBe("shadow");
  });
});

describe("classifyQuadrant", () => {
  it("priority 5 is neutral", () => {
    expect(classifyQuadrant(5, 0.5)).toBe("neutral");
  });

  it("low priority + positive trajectory is pos_pos", () => {
    expect(classifyQuadrant(3, 0.4)).toBe("pos_pos");
  });

  it("high priority + positive trajectory is pos_neg", () => {
    expect(classifyQuadrant(8, 0.4)).toBe("pos_neg");
  });

  it("low priority + negative trajectory is neg_pos", () => {
    expect(classifyQuadrant(3, -0.4)).toBe("neg_pos");
  });

  it("high priority + negative trajectory is neg_neg", () => {
    expect(classifyQuadrant(8, -0.4)).toBe("neg_neg");
  });
});

describe("evaluateTrajectoryScaling", () => {
  it("insufficient rows returns keep_shadow", () => {
    const rows: TrajectoryAuditRow[] = [];
    const report = evaluateTrajectoryScaling(rows, [], defaultConfig);
    expect(report.verdict).toBe("keep_shadow");
  });

  it("returns empty quadrant objects when no rows", () => {
    const report = evaluateTrajectoryScaling([], [], defaultConfig);
    expect(report.byQuadrant.pos_pos.rows).toBe(0);
  });

  it("revert_off when aggregate lift negative over 200+ rows", () => {
    const rows: TrajectoryAuditRow[] = [];
    const events: EpisodicEvent[] = [];
    // 100 live/scaled rows with failures, 150 shadow controls with successes
    for (let i = 0; i < 100; i++) {
      rows.push({
        timestamp: Date.now(),
        sitrepSummary: `t${i}`,
        rawPriority: 7,
        scaledPriority: 9,
        quadrant: "neg_neg",
        scaleApplied: 1.3,
        domains: ["x"],
        avgTrajectory: -0.5,
        mode: "live",
        actionId: `live-${i}`,
      });
      events.push({
        id: `live-${i}`,
        text: "",
        category: "",
        importance: 0,
        createdAt: Date.now(),
        actionId: `live-${i}`,
        outcome: "failure",
      });
    }
    for (let i = 0; i < 150; i++) {
      rows.push({
        timestamp: Date.now(),
        sitrepSummary: `s${i}`,
        rawPriority: 9,
        scaledPriority: 9,
        quadrant: "neg_neg",
        scaleApplied: 1.0,
        domains: ["x"],
        avgTrajectory: -0.5,
        mode: "shadow",
        actionId: `shadow-${i}`,
      });
      events.push({
        id: `shadow-${i}`,
        text: "",
        category: "",
        importance: 0,
        createdAt: Date.now(),
        actionId: `shadow-${i}`,
        outcome: "success",
      });
    }
    const report = evaluateTrajectoryScaling(rows, events, defaultConfig);
    expect(report.verdict).toBe("revert_off");
    expect(report.byQuadrant.neg_neg.lift).toBeLessThan(0);
  });
});
