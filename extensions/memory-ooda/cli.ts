/**
 * OODA Workspace CLI Commands
 *
 * Registered under `openclaw workspace` via the plugin CLI API.
 *
 * Commands:
 *   workspace proposals          — list pending policy proposals
 *   workspace proposals approve <id> — approve a proposal
 *   workspace proposals reject <id>  — reject a proposal
 *   workspace rollback [knowledge|priorities] — restore latest snapshot
 *   workspace rollback --list    — show available snapshots
 *   workspace status             — OODA system health overview
 */

import fs from "node:fs";
import path from "node:path";
import { listAdmissionCases, saveAdmissionCase } from "./admission-gate.js";
import type { EpisodicEvent } from "./archivist.js";
import { formBelief, getActiveBeliefs, getBeliefs, retireBelief, canPromote } from "./beliefs.js";
import { findAntecedents, formatAntecedents } from "./causal-retrieval.js";
import { gateHistoryPath, readGateHistory, type GateHistoryRow } from "./change-gate.js";
import {
  computeDistortion,
  distortionHistoryPath,
  readDistortionHistory,
} from "./distortion-index.js";
import { getPriorities } from "./priorities.js";
import {
  countPending,
  getPendingProposals,
  getProposals,
  updateProposalStatus,
} from "./proposals.js";
import { getFacts, getFactsAsOf } from "./semantic-memory.js";
import { listSnapshots, restoreLatestSnapshot } from "./snapshot.js";
import {
  auditPath as trajectoryAuditPath,
  evaluateTrajectoryScaling,
  readTrajectoryAudit,
} from "./trajectory-audit.js";
import type {
  DistortionReading,
  DistortionSample,
  ErrorAxisPriorStats,
  ErrorTag,
  TrajectoryAuditRow,
} from "./types.js";

// ============================================================================
// Types
// ============================================================================

/** Minimal Commander-like interface for testability. */
export interface CLICommand {
  command(name: string): CLICommand;
  description(desc: string): CLICommand;
  argument(name: string, desc: string): CLICommand;
  option(flags: string, desc: string): CLICommand;
  action(fn: (...args: unknown[]) => void | Promise<void>): CLICommand;
}

export interface CLIProgram {
  command(name: string): CLICommand;
  description(desc: string): CLICommand;
}

// ============================================================================
// Proposals Commands
// ============================================================================

export function registerProposalsCommands(workspace: CLICommand, workspacePath: string): void {
  const proposals = workspace.command("proposals").description("Manage policy proposals");

  proposals
    .command("list")
    .description("List all policy proposals")
    .option("--pending", "Show only pending proposals")
    .action((_opts: unknown) => {
      const opts = (_opts ?? {}) as { pending?: boolean };
      const items = opts.pending ? getPendingProposals(workspacePath) : getProposals(workspacePath);

      if (items.length === 0) {
        console.log("No proposals found.");
        return;
      }

      for (const p of items) {
        const status = p.status === "pending" ? "[PENDING]" : `[${p.status.toUpperCase()}]`;
        console.log(`${status} ${p.id}: ${p.proposal}`);
        console.log(`  Rule: ${p.rule}`);
        console.log(`  Reasoning: ${p.reasoning}`);
        console.log(`  Evidence: ${p.evidence.join(", ")}`);
        console.log();
      }
    });

  proposals
    .command("approve")
    .description("Approve a pending proposal")
    .argument("<id>", "Proposal ID")
    .action((id: unknown) => {
      const result = updateProposalStatus(workspacePath, id as string, "approved");
      if (!result) {
        console.error(`Proposal "${id as string}" not found.`);
        return;
      }
      console.log(`Approved: ${result.proposal}`);
    });

  proposals
    .command("reject")
    .description("Reject a pending proposal")
    .argument("<id>", "Proposal ID")
    .action((id: unknown) => {
      const result = updateProposalStatus(workspacePath, id as string, "rejected");
      if (!result) {
        console.error(`Proposal "${id as string}" not found.`);
        return;
      }
      console.log(`Rejected: ${result.proposal}`);
    });

  proposals
    .command("count")
    .description("Count pending proposals")
    .action(() => {
      const count = countPending(workspacePath);
      console.log(`${count} pending proposal${count === 1 ? "" : "s"}`);
    });
}

// ============================================================================
// Rollback Commands
// ============================================================================

const ROLLBACK_TARGETS = ["KNOWLEDGE.json", "PRIORITIES.json"] as const;
type RollbackTarget = (typeof ROLLBACK_TARGETS)[number];

function resolveTarget(name: string): RollbackTarget | null {
  const lower = name.toLowerCase();
  if (lower === "knowledge") return "KNOWLEDGE.json";
  if (lower === "priorities") return "PRIORITIES.json";
  return null;
}

export function registerRollbackCommands(workspace: CLICommand, workspacePath: string): void {
  const rollback = workspace.command("rollback").description("Restore OODA workspace snapshots");

  rollback
    .command("list")
    .description("List available snapshots")
    .action(() => {
      let found = false;
      for (const filename of ROLLBACK_TARGETS) {
        const snapshots = listSnapshots(workspacePath, filename);
        if (snapshots.length > 0) {
          console.log(`${filename}:`);
          for (const s of snapshots) {
            const date = new Date(s.timestamp * 1000).toISOString();
            console.log(`  ${date} — ${s.path}`);
          }
          found = true;
        }
      }
      if (!found) {
        console.log("No snapshots available.");
      }
    });

  rollback
    .command("restore")
    .description("Restore the latest snapshot for a target")
    .argument("<target>", "Target file: knowledge or priorities")
    .action((target: unknown) => {
      const filename = resolveTarget(target as string);
      if (!filename) {
        console.error(`Unknown target "${target as string}". Use: knowledge or priorities`);
        return;
      }

      const restored = restoreLatestSnapshot(workspacePath, filename);
      if (restored) {
        console.log(`Restored latest snapshot of ${filename}`);
      } else {
        console.error(`No snapshots available for ${filename}`);
      }
    });
}

// ============================================================================
// Status Command
// ============================================================================

export function registerStatusCommand(workspace: CLICommand, workspacePath: string): void {
  workspace
    .command("status")
    .description("OODA system health overview")
    .action(() => {
      const pendingCount = countPending(workspacePath);
      const knowledgeSnapshots = listSnapshots(workspacePath, "KNOWLEDGE.json");
      const prioritiesSnapshots = listSnapshots(workspacePath, "PRIORITIES.json");

      console.log("OODA Workspace Status");
      console.log("=====================");
      console.log(`Pending proposals: ${pendingCount}`);
      console.log(`KNOWLEDGE.json snapshots: ${knowledgeSnapshots.length}`);
      console.log(`PRIORITIES.json snapshots: ${prioritiesSnapshots.length}`);
    });
}

// ============================================================================
// Gate Commands (CR_OODA_PASS_K_ACCEPTANCE_GATE + Path C)
// ============================================================================

export interface GateStatusSummary {
  historyPath: string;
  totalRuns: number;
  admits: number;
  rejects: number;
  overrides: number;
  byKind: Record<string, { admits: number; rejects: number }>;
  recent: GateHistoryRow[];
}

/** Pure function — compute summary stats from a history rows list. Exposed for tests. */
export function summarizeGateHistory(
  rows: GateHistoryRow[],
  historyPath: string,
  recentLimit = 5,
): GateStatusSummary {
  const byKind: Record<string, { admits: number; rejects: number }> = {};
  let admits = 0;
  let rejects = 0;
  let overrides = 0;
  for (const row of rows) {
    const bucket = byKind[row.kind] ?? { admits: 0, rejects: 0 };
    if (row.admit) {
      admits++;
      bucket.admits++;
    } else {
      rejects++;
      bucket.rejects++;
    }
    if (row.override) overrides++;
    byKind[row.kind] = bucket;
  }
  const recent = rows.slice(-recentLimit).reverse();
  return { historyPath, totalRuns: rows.length, admits, rejects, overrides, byKind, recent };
}

function renderGateStatus(summary: GateStatusSummary): string {
  const lines: string[] = [];
  lines.push("Admission Gate Status");
  lines.push("=====================");
  lines.push(`History file: ${summary.historyPath}`);
  lines.push(`Total runs:   ${summary.totalRuns}`);
  lines.push(`  Admitted:   ${summary.admits}`);
  lines.push(`  Rejected:   ${summary.rejects}`);
  lines.push(`  Overrides:  ${summary.overrides}`);
  const kinds = Object.keys(summary.byKind).sort();
  if (kinds.length > 0) {
    lines.push("");
    lines.push("By kind:");
    for (const k of kinds) {
      const b = summary.byKind[k];
      lines.push(`  ${k.padEnd(24)} admit=${b.admits} reject=${b.rejects}`);
    }
  }
  if (summary.recent.length > 0) {
    lines.push("");
    lines.push(`Recent (last ${summary.recent.length}):`);
    for (const r of summary.recent) {
      const flag = r.admit ? "✓" : "✗";
      const override = r.override ? " [override]" : "";
      lines.push(`  ${flag} ${r.timestamp} [${r.kind}] ${r.changeId}${override} — ${r.reason}`);
    }
  }
  return lines.join("\n");
}

export function registerGateCommands(workspace: CLICommand, workspacePath: string): void {
  const gate = workspace.command("gate").description("CR_OODA_PASS_K_ACCEPTANCE_GATE inspection");

  gate
    .command("status")
    .description("Summarize admission-gate history (admits/rejects/overrides by kind)")
    .option("--json", "Output raw JSON instead of the formatted summary")
    .option("--recent <n>", "Number of recent rows to include (default: 5)")
    .action((opts: { json?: boolean; recent?: string }) => {
      const rows = readGateHistory(workspacePath);
      const recentLimit = opts.recent ? Math.max(0, Number.parseInt(opts.recent, 10) || 0) : 5;
      const summary = summarizeGateHistory(rows, gateHistoryPath(workspacePath), recentLimit);
      if (opts.json) {
        console.log(JSON.stringify(summary, null, 2));
        return;
      }
      console.log(renderGateStatus(summary));
    });

  gate
    .command("history")
    .description("Dump raw gate-history.jsonl rows, newest first")
    .option("--limit <n>", "Cap the number of rows shown (default: 20)")
    .option("--kind <k>", "Filter by ChangeKind (policy_proposal, knowledge_edit, ...)")
    .option("--only-rejected", "Show only rows where the gate rejected the change")
    .option("--json", "Output raw JSON array instead of one-line summary per row")
    .action((opts: { limit?: string; kind?: string; onlyRejected?: boolean; json?: boolean }) => {
      let rows = readGateHistory(workspacePath).slice().reverse();
      if (opts.kind) rows = rows.filter((r) => r.kind === opts.kind);
      if (opts.onlyRejected) rows = rows.filter((r) => !r.admit);
      const limit = opts.limit ? Math.max(0, Number.parseInt(opts.limit, 10) || 0) : 20;
      rows = rows.slice(0, limit);
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (rows.length === 0) {
        console.log("No gate history rows match the given filters.");
        return;
      }
      for (const r of rows) {
        const flag = r.admit ? "✓" : "✗";
        const override = r.override ? " [override]" : "";
        console.log(`${flag} ${r.timestamp} [${r.kind.padEnd(22)}] ${r.changeId}${override}`);
        console.log(`    reason: ${r.reason}`);
        if (r.passK) {
          const ks = Object.entries(r.passK.passRates)
            .map(([k, v]) => `pass^${k}=${(v * 100).toFixed(0)}%`)
            .join(", ");
          if (ks) console.log(`    passK:  ${ks}`);
        }
        console.log(`    summary: ${r.summary}`);
      }
    });
}

// ============================================================================
// Distortion Commands (CR_OODA_GROUNDED_EVAL_HARNESS_V2)
// ============================================================================

export interface DistortionSummary {
  historyPath: string;
  totalSamples: number;
  byDomain: Record<
    string,
    {
      samples: number;
      regime: DistortionReading["regime"];
      goodhartIndex: number;
      campbellIndex: number;
      evidence: string[];
    }
  >;
}

export function summarizeDistortion(
  samples: DistortionSample[],
  historyPath: string,
  window = { days: 30, minSamples: 10 },
): DistortionSummary {
  const byDomain = new Map<string, DistortionSample[]>();
  for (const s of samples) {
    const arr = byDomain.get(s.domain) ?? [];
    arr.push(s);
    byDomain.set(s.domain, arr);
  }
  const out: DistortionSummary = {
    historyPath,
    totalSamples: samples.length,
    byDomain: {},
  };
  for (const [domain, rows] of byDomain) {
    const reading = computeDistortion(rows, window);
    out.byDomain[domain] = {
      samples: rows.length,
      regime: reading.regime,
      goodhartIndex: reading.goodhartIndex,
      campbellIndex: reading.campbellIndex,
      evidence: reading.evidence,
    };
  }
  return out;
}

function renderDistortion(summary: DistortionSummary): string {
  const lines: string[] = [];
  lines.push("Distortion Regime (grounded vs measured)");
  lines.push("=========================================");
  lines.push(`History file:  ${summary.historyPath}`);
  lines.push(`Total samples: ${summary.totalSamples}`);
  const domains = Object.keys(summary.byDomain).sort();
  if (domains.length === 0) {
    lines.push("");
    lines.push("No samples yet. Archivist populates .distortion-history.jsonl per run.");
    return lines.join("\n");
  }
  lines.push("");
  for (const d of domains) {
    const r = summary.byDomain[d];
    lines.push(
      `[${r.regime.padEnd(20)}] ${d.padEnd(16)} samples=${r.samples} goodhart=${r.goodhartIndex.toFixed(2)} campbell=${r.campbellIndex.toFixed(2)}`,
    );
    for (const e of r.evidence) lines.push(`  ${e}`);
  }
  return lines.join("\n");
}

export function registerDistortionCommands(workspace: CLICommand, workspacePath: string): void {
  workspace
    .command("distortion")
    .description("Show per-domain Goodhart/Campbell regime diagnosis from distortion history")
    .option("--json", "Output raw JSON instead of formatted summary")
    .option("--window-days <n>", "Rolling window in days (default: 30)")
    .option("--min-samples <n>", "Minimum samples per domain before classifying (default: 10)")
    .action((opts: { json?: boolean; windowDays?: string; minSamples?: string }) => {
      const days = opts.windowDays ? Number.parseInt(opts.windowDays, 10) || 30 : 30;
      const minSamples = opts.minSamples ? Number.parseInt(opts.minSamples, 10) || 10 : 10;
      const samples = readDistortionHistory(workspacePath);
      const summary = summarizeDistortion(samples, distortionHistoryPath(workspacePath), {
        days,
        minSamples,
      });
      if (opts.json) {
        console.log(JSON.stringify(summary, null, 2));
        return;
      }
      console.log(renderDistortion(summary));
    });
}

// ============================================================================
// Trajectory Commands (CR_OODA_TRAJECTORY_AWARE_TRIAGE_V2)
// ============================================================================

function renderTrajectoryReport(
  auditPath: string,
  rows: TrajectoryAuditRow[],
  report: ReturnType<typeof evaluateTrajectoryScaling> | null,
): string {
  const lines: string[] = [];
  lines.push("Trajectory-Aware Triage Audit");
  lines.push("=============================");
  lines.push(`Audit file:    ${auditPath}`);
  lines.push(`Total rows:    ${rows.length}`);
  const modes = new Map<string, number>();
  for (const r of rows) modes.set(r.mode, (modes.get(r.mode) ?? 0) + 1);
  if (modes.size > 0) {
    const parts = [...modes.entries()].map(([m, n]) => `${m}=${n}`).join(", ");
    lines.push(`By mode:       ${parts}`);
  }
  if (report) {
    lines.push("");
    lines.push(`Verdict:  ${report.verdict}`);
    lines.push(`Reason:   ${report.reason}`);
    lines.push(`Window:   ${report.window.days}d (${report.window.rows} rows)`);
    lines.push("By quadrant:");
    for (const [q, stats] of Object.entries(report.byQuadrant)) {
      lines.push(
        `  ${q.padEnd(8)} rows=${String(stats.rows).padEnd(4)} scaled=${(stats.scaledSuccessRate * 100).toFixed(0)}%  baseline=${(stats.matchedBaselineSuccessRate * 100).toFixed(0)}%  lift=${(stats.lift * 100).toFixed(1)}%`,
      );
    }
  }
  return lines.join("\n");
}

export function registerTrajectoryCommands(workspace: CLICommand, workspacePath: string): void {
  const trajectory = workspace
    .command("trajectory")
    .description("Trajectory scaling audit + matched-control lift evaluator");

  trajectory
    .command("report")
    .description("Show audit log summary + per-quadrant lift verdict")
    .option("--json", "Output raw JSON instead of formatted summary")
    .option("--window-days <n>", "Lift evaluator window in days (default: 30)")
    .action((opts: { json?: boolean; windowDays?: string }) => {
      const rows = readTrajectoryAudit(workspacePath);
      const days = opts.windowDays ? Number.parseInt(opts.windowDays, 10) || 30 : 30;
      // evaluateTrajectoryScaling needs an episodic events list to join outcomes. CLI runs
      // without plugin context, so we feed in [] — the evaluator still classifies by quadrant
      // row counts and mode distribution, which is useful on its own.
      let report: ReturnType<typeof evaluateTrajectoryScaling> | null = null;
      try {
        const priorities = getPriorities(workspacePath);
        const trajConfig = priorities.thresholds.trajectory_scaling;
        if (trajConfig) {
          report = evaluateTrajectoryScaling(rows, [], trajConfig, days);
        }
      } catch {
        // No priorities or bad config — fall through to row-only summary.
      }
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              auditPath: trajectoryAuditPath(workspacePath),
              totalRows: rows.length,
              report,
            },
            null,
            2,
          ),
        );
        return;
      }
      console.log(renderTrajectoryReport(trajectoryAuditPath(workspacePath), rows, report));
    });
}

// ============================================================================
// Errors Commands (CR_OODA_ERROR_TAXONOMY)
// ============================================================================

interface AxisPriorsFile {
  generatedAt: string;
  windowDays: number;
  priors: ErrorAxisPriorStats[];
}

function readAxisPriors(workspacePath: string): AxisPriorsFile | null {
  const file = path.join(workspacePath, ".axis-priors.json");
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as AxisPriorsFile;
  } catch {
    return null;
  }
}

interface ErrorTagSidecarRow {
  eventId: string;
  tags: ErrorTag[];
  at: string;
}

function readErrorTagSidecar(workspacePath: string, limit = 20): ErrorTagSidecarRow[] {
  const file = path.join(workspacePath, ".error-tags.jsonl");
  if (!fs.existsSync(file)) return [];
  const out: ErrorTagSidecarRow[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as ErrorTagSidecarRow);
    } catch {
      // skip
    }
  }
  return out.slice(-limit).reverse();
}

/**
 * Read episodic events from memory-lancedb's sqlite file so CLI can run causal
 * lookups without plugin-api access. Best-effort — returns [] on any failure.
 */
async function readEpisodicForCli(defaultDbPath: string, limit = 1000): Promise<EpisodicEvent[]> {
  const candidates = [
    defaultDbPath,
    path.join(process.env.HOME ?? "", ".openclaw", "memory", "lancedb"),
  ];
  for (const dir of candidates) {
    const sqlitePath = path.join(dir, "memories.sqlite");
    if (!fs.existsSync(sqlitePath)) continue;
    try {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(sqlitePath);
      const rows = db
        .prepare(
          "SELECT id, text, category, importance, createdAt, source, actionId, archivistProcessed, outcome, outcomeSignal, outcomeAt FROM memories ORDER BY createdAt DESC LIMIT ?",
        )
        .all(limit) as Array<Record<string, unknown>>;
      db.close();
      return rows.map((row) => ({
        id: row.id as string,
        text: row.text as string,
        category: row.category as string,
        importance: row.importance as number,
        createdAt: row.createdAt as number,
        source: (row.source as string) || undefined,
        actionId: (row.actionId as string) || undefined,
        archivistProcessed: row.archivistProcessed === 1,
        outcome: (row.outcome as EpisodicEvent["outcome"]) || undefined,
        outcomeSignal: (row.outcomeSignal as string) || undefined,
        outcomeAt: (row.outcomeAt as number) || undefined,
      }));
    } catch {
      // continue
    }
  }
  return [];
}

export function registerErrorsCommands(workspace: CLICommand, workspacePath: string): void {
  const errors = workspace
    .command("errors")
    .description("Failure-axis taxonomy stats + recent classifications");

  errors
    .command("stats")
    .description("Show per-domain/axis prior stats from .axis-priors.json")
    .option("--json", "Output raw JSON instead of formatted summary")
    .action((opts: { json?: boolean }) => {
      const data = readAxisPriors(workspacePath);
      if (opts.json) {
        console.log(JSON.stringify(data ?? { priors: [], generatedAt: null }, null, 2));
        return;
      }
      if (!data) {
        console.log(
          "No axis priors yet. Archivist populates .axis-priors.json after classifying failed events.",
        );
        return;
      }
      console.log(`Axis priors (window=${data.windowDays}d, generated=${data.generatedAt})`);
      console.log("===========================================================");
      for (const p of data.priors) {
        console.log(
          `  ${p.domain.padEnd(16)} ${p.axis.padEnd(11)} rate=${(p.axisRate * 100).toFixed(0)}%  crit=${p.countCritical} maj=${p.countMajor} min=${p.countMinor}`,
        );
        for (const s of p.topSignals) {
          console.log(`     · ${s.signal} (${s.count}×)`);
        }
      }
    });

  errors
    .command("recent")
    .description("Show recent error-tag classifications from sidecar")
    .option("--limit <n>", "Number of rows to show (default: 20)")
    .option("--json", "Output raw JSON array")
    .action((opts: { limit?: string; json?: boolean }) => {
      const limit = opts.limit ? Math.max(1, Number.parseInt(opts.limit, 10) || 20) : 20;
      const rows = readErrorTagSidecar(workspacePath, limit);
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (rows.length === 0) {
        console.log("No error tags yet.");
        return;
      }
      for (const r of rows) {
        console.log(`${r.at}  event=${r.eventId}`);
        for (const t of r.tags) {
          console.log(
            `  [${t.severity.padEnd(8)}] ${t.axis.padEnd(11)} ${t.signal} (conf=${t.confidence.toFixed(2)})`,
          );
        }
      }
    });

  errors
    .command("causes")
    .argument("<signal>", "Outcome signal to trace back (e.g. build_failed, pipeline_fail)")
    .description(
      "Show decisions that preceded events with the given outcomeSignal (CR_OODA_CAUSAL_RETRIEVAL)",
    )
    .option("--limit <n>", "Max antecedents to show (default: 10)")
    .option("--within-hours <n>", "Lookback window in hours (default: unlimited)")
    .option("--json", "Output raw JSON")
    .action(
      async (signal: string, opts: { limit?: string; withinHours?: string; json?: boolean }) => {
        const dbPath = path.join(process.env.HOME ?? "", ".openclaw", "memory", "lancedb");
        const events = await readEpisodicForCli(dbPath, 2000);
        const limit = opts.limit ? Math.max(1, Number.parseInt(opts.limit, 10) || 10) : 10;
        const withinMs = opts.withinHours
          ? Math.max(0, Number.parseInt(opts.withinHours, 10) || 0) * 60 * 60 * 1000
          : undefined;
        const rows = findAntecedents(events, {
          outcomeSignal: signal,
          limit,
          ...(withinMs ? { withinMs } : {}),
        });
        if (opts.json) {
          console.log(JSON.stringify(rows, null, 2));
          return;
        }
        if (rows.length === 0) {
          console.log(`No decision antecedents found for signal "${signal}".`);
          return;
        }
        const lines = formatAntecedents(rows);
        console.log(`Antecedents for "${signal}" (${rows.length})`);
        console.log("==========================================");
        for (const l of lines) console.log(l);
      },
    );
}

// ============================================================================
// Admission corpus CLI (CR_OODA_PASS_K_ACCEPTANCE_GATE)
// ============================================================================

export function registerAdmissionCommands(workspace: CLICommand, workspacePath: string): void {
  const admission = workspace
    .command("admission")
    .description("Inspect + populate the admission corpus used by the change gate");

  admission
    .command("list")
    .description("List admission cases on disk")
    .option("--json", "Output raw JSON")
    .action((opts: { json?: boolean }) => {
      const cases = listAdmissionCases(workspacePath);
      if (opts.json) {
        console.log(JSON.stringify(cases, null, 2));
        return;
      }
      if (cases.length === 0) {
        console.log(
          "No admission cases yet. Capture one with `openclaw workspace admission capture`.",
        );
        return;
      }
      for (const c of cases) {
        console.log(`${c.id.padEnd(16)} [${c.priorOutcome.padEnd(7)}] ${c.label}`);
      }
      console.log(`\n${cases.length} case(s).`);
    });

  admission
    .command("capture")
    .argument("<id>", "Case id (stable handle)")
    .argument("<label>", "Human-readable label")
    .option("--domain <d>", "Domain tag", "general")
    .option("--prior-outcome <o>", "prior outcome: success | failure | partial", "success")
    .option("--observation <text>", "Observation text", "")
    .description(
      "Save a minimal admission case stub — operator edits .admission-cases/<id>.json to add fixture detail.",
    )
    .action(
      (
        id: string,
        label: string,
        opts: { domain?: string; priorOutcome?: string; observation?: string },
      ) => {
        if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) {
          console.error(`Invalid case id: ${id}`);
          process.exitCode = 1;
          return;
        }
        const priorOutcome = ["success", "failure", "partial"].includes(opts.priorOutcome ?? "")
          ? (opts.priorOutcome as "success" | "failure" | "partial")
          : "success";
        saveAdmissionCase(workspacePath, {
          id,
          label,
          fixture: {
            observation: opts.observation ?? "",
            knowledge: {} as never,
            priorities: {} as never,
          },
          expected: {
            actionId: id,
            description: label,
            successSignal: "",
            failureSignal: "",
            domain: opts.domain ?? "general",
          },
          priorOutcome,
          capturedAt: new Date().toISOString(),
        });
        console.log(`Captured admission case "${id}".`);
      },
    );
}

// ============================================================================
// Knowledge CLI (CR_OODA_BITEMPORAL_KNOWLEDGE)
// ============================================================================

export function registerKnowledgeCommands(workspace: CLICommand, workspacePath: string): void {
  const knowledge = workspace
    .command("knowledge")
    .description("Inspect the bitemporal KNOWLEDGE.json store");

  knowledge
    .command("history")
    .description("Show the archivist activity log")
    .option("--limit <n>", "Number of entries to show (newest first, default: 20)")
    .option("--json", "Output raw JSON")
    .action((opts: { limit?: string; json?: boolean }) => {
      const k = getFacts(workspacePath);
      const log = (k._archivist_log ?? []).slice().reverse();
      const limit = opts.limit ? Math.max(1, Number.parseInt(opts.limit, 10) || 20) : 20;
      const rows = log.slice(0, limit);
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (rows.length === 0) {
        console.log("No archivist log entries yet.");
        return;
      }
      for (const r of rows) {
        console.log(`${r.timestamp}  [${r.action.padEnd(24)}] ${r.reason}`);
      }
    });

  knowledge
    .command("asof")
    .argument("<timestamp>", "ISO timestamp (e.g. 2026-03-01T00:00:00Z)")
    .description("Print KNOWLEDGE.json as it was at the given timestamp (bitemporal)")
    .option("--json", "Output raw JSON (default)")
    .action((timestamp: string, _opts: { json?: boolean }) => {
      try {
        const snap = getFactsAsOf(workspacePath, timestamp);
        console.log(JSON.stringify(snap, null, 2));
      } catch (err) {
        console.error(`getFactsAsOf failed: ${String(err)}`);
        process.exitCode = 1;
      }
    });
}

// ============================================================================
// Beliefs CLI (CR_OODA_BELIEFS_TIER)
// ============================================================================

export function registerBeliefsCommands(workspace: CLICommand, workspacePath: string): void {
  const beliefs = workspace
    .command("beliefs")
    .description("Inspect + mutate the Tier 4 belief store");

  beliefs
    .command("list")
    .description("List active beliefs (non-retired) sorted by confidence × recency")
    .option("--min-confidence <n>", "Minimum confidence (0-1)", "0")
    .option("--domain <d>", "Filter by domain")
    .option("--limit <n>", "Cap output (default: 20)")
    .option("--json", "Output raw JSON")
    .action((opts: { minConfidence?: string; domain?: string; limit?: string; json?: boolean }) => {
      const minConfidence = opts.minConfidence ? Number.parseFloat(opts.minConfidence) || 0 : 0;
      const limit = opts.limit ? Math.max(1, Number.parseInt(opts.limit, 10) || 20) : 20;
      const active = getActiveBeliefs(workspacePath, {
        minConfidence,
        domain: opts.domain,
        limit,
      });
      if (opts.json) {
        console.log(JSON.stringify(active, null, 2));
        return;
      }
      if (active.length === 0) {
        console.log("No active beliefs match.");
        return;
      }
      for (const b of active) {
        console.log(
          `${b.id.padEnd(24)} [${b.confidence.toFixed(2)}] ${b.domain.padEnd(12)} ${b.claim}`,
        );
      }
    });

  beliefs
    .command("show")
    .argument("<id>", "Belief id")
    .description("Show the full belief record, including evidence + retirement")
    .action((id: string) => {
      const all = getBeliefs(workspacePath);
      const b = all.beliefs[id];
      if (!b) {
        console.error(`No belief with id "${id}".`);
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify(b, null, 2));
      const eligibility = canPromote(b);
      console.log(
        `\nPromotion eligibility: ${eligibility.eligible ? "YES" : "NO"} — ${eligibility.reason}`,
      );
    });

  beliefs
    .command("form")
    .argument("<id>", "Belief id (snake_case, stable handle)")
    .argument("<claim>", "Claim text (one sentence)")
    .option("--domain <d>", "Domain tag", "general")
    .option("--confidence <n>", "Initial confidence 0-1", "0.6")
    .description("Form a new belief (Archivist-like path; bypasses LLM)")
    .action((id: string, claim: string, opts: { domain?: string; confidence?: string }) => {
      const confidence = opts.confidence ? Number.parseFloat(opts.confidence) || 0.6 : 0.6;
      try {
        const b = formBelief(workspacePath, {
          id,
          claim,
          domain: opts.domain ?? "general",
          confidence,
        });
        console.log(`Formed belief "${b.id}" with confidence ${b.confidence.toFixed(2)}.`);
      } catch (err) {
        console.error(`formBelief failed: ${String(err)}`);
        process.exitCode = 1;
      }
    });

  beliefs
    .command("retire")
    .argument("<id>", "Belief id")
    .argument("<reason>", "Reason for retirement (shown in belief log)")
    .description("Retire a belief — no longer considered active; history preserved")
    .action((id: string, reason: string) => {
      try {
        const b = retireBelief(workspacePath, id, reason);
        console.log(`Retired belief "${b.id}" at ${b.retired?.at}: ${b.retired?.reason}`);
      } catch (err) {
        console.error(`retireBelief failed: ${String(err)}`);
        process.exitCode = 1;
      }
    });
}

// ============================================================================
// Soul CLI — open SOUL.md in $EDITOR
// ============================================================================

export function registerSoulCommands(workspace: CLICommand, workspacePath: string): void {
  workspace
    .command("soul")
    .description("Open SOUL.md in $EDITOR for manual edits")
    .option("--path", "Print the resolved SOUL.md path and exit (no edit)")
    .action(async (opts: { path?: boolean }) => {
      const soulPath = path.join(workspacePath, "SOUL.md");
      if (opts.path) {
        console.log(soulPath);
        return;
      }
      if (!fs.existsSync(soulPath)) {
        fs.mkdirSync(path.dirname(soulPath), { recursive: true });
        fs.writeFileSync(
          soulPath,
          "# SOUL.md\n\nOperator-authored agent identity, values, and standing instructions.\n",
        );
        console.log(`Created ${soulPath}`);
      }
      const editor = process.env.EDITOR || process.env.VISUAL || "vi";
      const { spawn } = await import("node:child_process");
      await new Promise<void>((resolve, reject) => {
        const child = spawn(editor, [soulPath], { stdio: "inherit" });
        child.on("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`${editor} exited with code ${code}`));
        });
        child.on("error", reject);
      });
    });
}

// ============================================================================
// Registration Entry Point
// ============================================================================

/**
 * Register all OODA workspace CLI commands under a parent command.
 * Called from the plugin's register() method.
 */
export function registerWorkspaceCli(program: CLIProgram, workspacePath: string): void {
  const workspace = program.command("workspace").description("OODA workspace management commands");

  registerProposalsCommands(workspace, workspacePath);
  registerRollbackCommands(workspace, workspacePath);
  registerStatusCommand(workspace, workspacePath);
  registerGateCommands(workspace, workspacePath);
  registerDistortionCommands(workspace, workspacePath);
  registerTrajectoryCommands(workspace, workspacePath);
  registerErrorsCommands(workspace, workspacePath);
  registerAdmissionCommands(workspace, workspacePath);
  registerKnowledgeCommands(workspace, workspacePath);
  registerBeliefsCommands(workspace, workspacePath);
  registerSoulCommands(workspace, workspacePath);
}
