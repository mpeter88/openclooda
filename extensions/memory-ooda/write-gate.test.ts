import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveAdmissionCase } from "./admission-gate.js";
import type { AdmissionRunnable } from "./pass-k.js";
import type { ActualOutcome, AdmissionCase } from "./types.js";
import { gateWrite } from "./write-gate.js";

const mkCase = (id: string): AdmissionCase => ({
  id,
  label: id,
  fixture: {
    observation: "",
    knowledge: {} as AdmissionCase["fixture"]["knowledge"],
    priorities: {} as AdmissionCase["fixture"]["priorities"],
  },
  expected: {
    actionId: id,
    description: "",
    successSignal: "",
    failureSignal: "",
    domain: "test",
  },
  priorOutcome: "success",
  capturedAt: new Date().toISOString(),
});

const alwaysSuccess: AdmissionRunnable = async (): Promise<ActualOutcome> => ({
  source: "tool_result",
  success: true,
  toolName: "t",
  summary: "",
});
const alwaysFail: AdmissionRunnable = async (): Promise<ActualOutcome> => ({
  source: "tool_result",
  success: false,
  toolName: "t",
  summary: "",
});

describe("gateWrite", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-write-gate-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("falls open with empty admission corpus (bootstrap)", async () => {
    const outcome = await gateWrite({
      kind: "knowledge_edit",
      id: "k1",
      summary: "ADD stack.rust",
      diff: "{}",
      workspacePath: tmp,
    });
    expect(outcome.admit).toBe(true);
    expect(outcome.reason).toMatch(/no_corpus_bootstrap/);
  });

  it("admits when runnable passes on a populated corpus", async () => {
    for (let i = 0; i < 5; i++) saveAdmissionCase(tmp, mkCase(`c${i}`));
    const outcome = await gateWrite({
      kind: "knowledge_edit",
      id: "k2",
      summary: "UPDATE projects.x",
      diff: "{}",
      workspacePath: tmp,
      runnable: alwaysSuccess,
    });
    expect(outcome.admit).toBe(true);
    expect(outcome.ranCases).toBe(5);
  });

  it("rejects when runnable regresses a prior-success case", async () => {
    for (let i = 0; i < 5; i++) saveAdmissionCase(tmp, mkCase(`c${i}`));
    const outcome = await gateWrite({
      kind: "knowledge_edit",
      id: "k3",
      summary: "DELETE projects.x",
      diff: "{}",
      workspacePath: tmp,
      runnable: alwaysFail,
    });
    expect(outcome.admit).toBe(false);
    expect(outcome.reason).toMatch(/regression|pass_rate/);
  });

  it("fails open on unexpected runnable exception", async () => {
    for (let i = 0; i < 5; i++) saveAdmissionCase(tmp, mkCase(`c${i}`));
    const thrower: AdmissionRunnable = async () => {
      throw new Error("boom");
    };
    const outcome = await gateWrite({
      kind: "knowledge_edit",
      id: "k4",
      summary: "UPDATE",
      diff: "{}",
      workspacePath: tmp,
      runnable: thrower,
    });
    // runChangeGate catches runnable errors and marks cases failed rather than admitting.
    // The fail-open is reserved for gate-level exceptions, not runnable-level failures.
    expect(outcome.admit).toBe(false);
  });
});
