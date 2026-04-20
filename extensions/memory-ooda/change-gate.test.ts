import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendGateHistory,
  isOverrideAllowed,
  policyForKind,
  readGateHistory,
  runChangeGate,
} from "./change-gate.js";
import type { ActualOutcome, AdmissionCase, ChangeRequest } from "./types.js";

const mockCase = (id: string): AdmissionCase => ({
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
    domain: "x",
  },
  priorOutcome: "success",
  capturedAt: new Date().toISOString(),
});

const alwaysSuccess = async (): Promise<ActualOutcome> => ({
  source: "tool_result",
  success: true,
  toolName: "t",
  summary: "",
});
const alwaysFail = async (): Promise<ActualOutcome> => ({
  source: "tool_result",
  success: false,
  toolName: "t",
  summary: "",
});

const req = (overrides: Partial<ChangeRequest> = {}): ChangeRequest => ({
  kind: "policy_proposal",
  id: "c1",
  summary: "test",
  diff: "",
  initiator: "meta_reviewer",
  ...overrides,
});

describe("policyForKind", () => {
  it("returns default floor for known kind", () => {
    expect(policyForKind("policy_proposal").passRateFloor).toBe(0.6);
    expect(policyForKind("soul_md_edit").overrideAllowed).toBe(true);
    expect(policyForKind("council_mode").overrideAllowed).toBe(false);
  });

  it("applies overrides from passk_by_kind", () => {
    const p = policyForKind("policy_proposal", { policy_proposal: 0.8 });
    expect(p.passRateFloor).toBe(0.8);
  });
});

describe("runChangeGate", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-gate-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("admits when all cases pass", async () => {
    const cases = [mockCase("a"), mockCase("b"), mockCase("c"), mockCase("d"), mockCase("e")];
    const outcome = await runChangeGate(req(), cases, alwaysSuccess, {}, tmp);
    expect(outcome.admit).toBe(true);
  });

  it("rejects on regression against prior-success case", async () => {
    const cases = [mockCase("a"), mockCase("b"), mockCase("c"), mockCase("d"), mockCase("e")];
    const outcome = await runChangeGate(req(), cases, alwaysFail, {}, tmp);
    expect(outcome.admit).toBe(false);
  });

  it("bootstrap falls open when corpus too small", async () => {
    const cases = [mockCase("a"), mockCase("b")];
    const outcome = await runChangeGate(req(), cases, alwaysFail, {}, tmp);
    expect(outcome.admit).toBe(true);
    expect(outcome.reason).toContain("no_corpus_bootstrap");
  });

  it("override not allowed for council_mode", async () => {
    const outcome = await runChangeGate(
      req({
        kind: "council_mode",
        skipPassK: { reason: "emergency", approver: "mpeter88" },
      }),
      [mockCase("a")],
      alwaysFail,
      { overrideApprovers: ["mpeter88"] },
      tmp,
    );
    expect(outcome.admit).toBe(false);
    expect(outcome.reason).toContain("not allowed");
  });

  it("override granted for soul_md_edit with approved approver", async () => {
    const outcome = await runChangeGate(
      req({
        kind: "soul_md_edit",
        skipPassK: { reason: "incident", approver: "mpeter88" },
      }),
      [],
      alwaysFail,
      { overrideApprovers: ["mpeter88"] },
      tmp,
    );
    expect(outcome.admit).toBe(true);
    expect(outcome.override).toBe(true);
    expect(outcome.approver).toBe("mpeter88");
  });

  it("override blocked when approver not on allowlist", async () => {
    const outcome = await runChangeGate(
      req({
        kind: "soul_md_edit",
        skipPassK: { reason: "incident", approver: "stranger" },
      }),
      [],
      alwaysFail,
      { overrideApprovers: ["mpeter88"] },
      tmp,
    );
    expect(outcome.admit).toBe(false);
    expect(outcome.reason).toContain("allowlist");
  });

  it("records history row on every gate call", async () => {
    await runChangeGate(
      req({ kind: "soul_md_edit", skipPassK: { reason: "x", approver: "mpeter88" } }),
      [],
      alwaysSuccess,
      { overrideApprovers: ["mpeter88"] },
      tmp,
    );
    const history = readGateHistory(tmp);
    expect(history).toHaveLength(1);
    expect(history[0].kind).toBe("soul_md_edit");
  });
});

describe("isOverrideAllowed rate limit", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-gate-rate-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("allowed when under quota", () => {
    expect(isOverrideAllowed(tmp, "mpeter88").allowed).toBe(true);
  });

  it("blocks after max overrides in window", () => {
    for (let i = 0; i < 3; i++) {
      appendGateHistory(tmp, {
        timestamp: new Date().toISOString(),
        kind: "soul_md_edit",
        changeId: `c${i}`,
        summary: "",
        admit: true,
        reason: "ok",
        ranCases: 0,
        duration_ms: 0,
        override: true,
        approver: "mpeter88",
      });
    }
    const result = isOverrideAllowed(tmp, "mpeter88");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("3 overrides");
  });
});
