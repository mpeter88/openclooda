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
import {
  childrenOf,
  lineageTo,
  markValidParent,
  readArchive,
  findGeneration,
  meanScore,
} from "./agent-archive.js";
import type { EpisodicEvent } from "./archivist.js";
import { formBelief, getActiveBeliefs, getBeliefs, retireBelief, canPromote } from "./beliefs.js";
import { findAntecedents, formatAntecedents } from "./causal-retrieval.js";
import { gateHistoryPath, readGateHistory, type GateHistoryRow } from "./change-gate.js";
import { concludeExperiment, readCloseOuts } from "./conclusion.js";
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
import { runResearchBackfill } from "./research-backfill.js";
import {
  listExperiments,
  readExperimentRecord,
  readResearchLog,
  readRolloutQueue,
  transitionStage,
} from "./research-loop.js";
import {
  appendEpic,
  bootstrapRoadmap,
  latestEpicStates,
  listEpics,
  pendingEpics,
  resolveProposedEpic,
  type Horizon,
} from "./roadmap.js";
import { getFacts, getFactsAsOf } from "./semantic-memory.js";
import { listSnapshots, restoreLatestSnapshot } from "./snapshot.js";
import {
  auditPath as trajectoryAuditPath,
  evaluateTrajectoryScaling,
  readTrajectoryAudit,
} from "./trajectory-audit.js";
import type { ModelCallFn } from "./triage.js";
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
// Agent archive CLI (CR_OODA_AGENT_ARCHIVE)
// ============================================================================

export function registerArchiveCommands(workspace: CLICommand, workspacePath: string): void {
  const archive = workspace
    .command("archive")
    .description("Inspect the per-generation plugin lineage");

  archive
    .command("list")
    .description("List archive rows, newest first")
    .option("--limit <n>", "Cap rows (default: 20)")
    .option("--invalid-only", "Show only valid_parent=false rows")
    .option("--json", "Output raw JSON")
    .action((opts: { limit?: string; invalidOnly?: boolean; json?: boolean }) => {
      const limit = opts.limit ? Math.max(1, Number.parseInt(opts.limit, 10) || 20) : 20;
      let rows = readArchive(workspacePath).slice().reverse();
      if (opts.invalidOnly) rows = rows.filter((r) => !r.valid_parent);
      rows = rows.slice(0, limit);
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (rows.length === 0) {
        console.log("Archive is empty.");
        return;
      }
      for (const r of rows) {
        const valid = r.valid_parent ? "✓" : "✗";
        const mean = meanScore(r);
        const score = mean !== null ? `mean=${mean.toFixed(2)}` : "no-score";
        const depth = `d=${r.lineage_depth}`;
        const parent = r.parent_genid.slice(0, 8);
        console.log(
          `${valid} ${r.genid} ← ${parent} ${depth} ${score.padEnd(12)} [${r.admission.kind}] ${r.summary ?? ""}`,
        );
      }
    });

  archive
    .command("show")
    .argument("<genid>", "Generation id")
    .description("Show a single archive row in full")
    .action((genid: string) => {
      const row = findGeneration(workspacePath, genid);
      if (!row) {
        console.error(`No generation with id "${genid}".`);
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify(row, null, 2));
    });

  archive
    .command("lineage")
    .argument("<genid>", "Generation id (walks back to 'initial')")
    .description("Print the ancestry path from the given genid back to the initial node")
    .action((genid: string) => {
      const chain = lineageTo(workspacePath, genid);
      if (chain.length === 0) {
        console.error(`No lineage found for "${genid}".`);
        process.exitCode = 1;
        return;
      }
      for (const r of chain) {
        const valid = r.valid_parent ? "✓" : "✗";
        console.log(
          `${valid} ${r.genid} (${r.created_at}) [${r.admission.kind}] ${r.summary ?? ""}`,
        );
      }
    });

  archive
    .command("children")
    .argument("<genid>", "Parent generation id")
    .description("List direct children of the given generation")
    .action((genid: string) => {
      const kids = childrenOf(workspacePath, genid);
      if (kids.length === 0) {
        console.log("(no children)");
        return;
      }
      for (const k of kids) {
        const valid = k.valid_parent ? "✓" : "✗";
        console.log(`${valid} ${k.genid} [${k.admission.kind}] ${k.summary ?? ""}`);
      }
    });

  archive
    .command("mark-invalid")
    .argument("<genid>", "Generation id")
    .argument("<reason>", "Short reason for invalidation")
    .description("Flag a generation as an ineligible parent (soft signal)")
    .action((genid: string, reason: string) => {
      const ok = markValidParent(workspacePath, genid, false, reason);
      if (!ok) {
        console.error(`No generation with id "${genid}".`);
        process.exitCode = 1;
        return;
      }
      console.log(`Marked ${genid} as valid_parent=false (${reason}).`);
    });
}

// ============================================================================
// Research loop CLI (CR_OODA_RESEARCH_LOOP)
// ============================================================================

export function registerResearchCommands(workspace: CLICommand, workspacePath: string): void {
  const research = workspace
    .command("research")
    .description("Autonomous literature-to-experiment pipeline (CR_OODA_RESEARCH_LOOP)");

  research
    .command("list")
    .description("List experiments, newest first")
    .option("--status <s>", "Filter by status (discovered|proposed|...)")
    .option("--limit <n>", "Cap rows (default: 20)")
    .option("--json", "Output raw JSON")
    .action((opts: { status?: string; limit?: string; json?: boolean }) => {
      const limit = opts.limit ? Math.max(1, Number.parseInt(opts.limit, 10) || 20) : 20;
      let rows = listExperiments(workspacePath).slice().reverse();
      if (opts.status) rows = rows.filter((r) => r.status === opts.status);
      rows = rows.slice(0, limit);
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (rows.length === 0) {
        console.log("No experiments yet.");
        return;
      }
      for (const r of rows) {
        const delta = r.scores.delta?.mean;
        const deltaStr = typeof delta === "number" ? `Δ=${delta.toFixed(3)}` : "Δ=n/a";
        console.log(
          `${r.status.padEnd(16)} ${r.exp_id.padEnd(32)} parent=${r.parent_genid.slice(0, 8)} ${deltaStr} ${r.source.citation ?? r.source.ref}`,
        );
      }
    });

  research
    .command("show")
    .argument("<exp-id>", "Experiment id")
    .description("Show a single experiment record in full")
    .action((expId: string) => {
      const rec = readExperimentRecord(workspacePath, expId);
      if (!rec) {
        console.error(`No experiment with id "${expId}".`);
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify(rec, null, 2));
    });

  research
    .command("log")
    .description("Dump the research discovery log (candidates scored by relevance)")
    .option("--json", "Output raw JSON")
    .option("--min-relevance <n>", "Filter by minimum relevance_score")
    .action((opts: { json?: boolean; minRelevance?: string }) => {
      const floor = opts.minRelevance ? Number.parseFloat(opts.minRelevance) || 0 : 0;
      const rows = readResearchLog(workspacePath).filter((c) => c.relevance_score >= floor);
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (rows.length === 0) {
        console.log("Research log empty.");
        return;
      }
      for (const c of rows) {
        console.log(`${c.relevance_score.toFixed(2)} ${c.id.padEnd(32)} ${c.title ?? ""}`);
      }
    });

  research
    .command("reject")
    .argument("<exp-id>", "Experiment id")
    .argument("<reason>", "Why the experiment is being rejected")
    .description("Manually reject an experiment (hard terminate)")
    .action((expId: string, reason: string) => {
      const updated = transitionStage(workspacePath, expId, "rejected", reason);
      if (!updated) {
        console.error(`Cannot reject ${expId} — illegal transition or not found.`);
        process.exitCode = 1;
        return;
      }
      console.log(`Rejected ${expId}: ${reason}`);
    });

  research
    .command("backfill")
    .description(
      "One-shot historical arxiv sweep (cat × kw × date range). Uses ANTHROPIC_API_KEY from env. Dedup-safe; re-runs skip already-seen ids.",
    )
    .option("--since <iso>", "Earliest submittedDate (YYYY-MM-DD). Default 2024-01-01")
    .option("--until <iso>", "Latest submittedDate (YYYY-MM-DD). Default today")
    .option("--max-per-query <n>", "arxiv API cap per (cat,kw). Default 50")
    .option("--max-total <n>", "Hard cap on LLM-scored items (controls bill). Default 100")
    .option(
      "--floor <n>",
      "Relevance score cutoff. Default PRIORITIES.research_candidate_floor or 0.45",
    )
    .option("--dry-run", "Fetch + keyword-filter only, skip LLM scoring")
    .action(
      async (opts: {
        since?: string;
        until?: string;
        maxPerQuery?: string;
        maxTotal?: string;
        floor?: string;
        dryRun?: boolean;
      }) => {
        let priorities: ReturnType<typeof getPriorities> | undefined;
        try {
          priorities = getPriorities(workspacePath);
        } catch {
          priorities = undefined;
        }
        const thresholds = (priorities?.thresholds ?? {}) as Record<string, unknown>;
        const categories = (
          (thresholds.research_feed_urls as string[] | undefined) ?? [
            "http://export.arxiv.org/rss/cs.AI",
          ]
        )
          .map((u) => {
            const m = /\/rss\/([^/?#]+)/.exec(u);
            return m?.[1];
          })
          .filter((c): c is string => typeof c === "string");
        const keywords = (thresholds.research_keywords as string[] | undefined) ?? [];
        if (categories.length === 0 || keywords.length === 0) {
          console.error(
            "backfill: PRIORITIES.json must set thresholds.research_feed_urls and thresholds.research_keywords",
          );
          process.exitCode = 1;
          return;
        }
        const floor = opts.floor
          ? Number.parseFloat(opts.floor)
          : ((thresholds.research_candidate_floor as number | undefined) ?? 0.45);

        const callModel: ModelCallFn = opts.dryRun
          ? async () => JSON.stringify({ score: 0, rationale: "dry-run" })
          : async (prompt: string) => {
              const apiKey = process.env.ANTHROPIC_API_KEY;
              if (!apiKey) {
                throw new Error("backfill: ANTHROPIC_API_KEY env var required (or pass --dry-run)");
              }
              const res = await fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "x-api-key": apiKey,
                  "anthropic-version": "2023-06-01",
                },
                body: JSON.stringify({
                  model: "claude-sonnet-4-6",
                  max_tokens: 4096,
                  system:
                    "You are an OODA reasoning agent. Respond with raw JSON only. No explanation, no code fences.",
                  messages: [{ role: "user", content: prompt }],
                }),
              });
              if (!res.ok) {
                const body = await res.text().catch(() => "");
                throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 200)}`);
              }
              const data = (await res.json()) as {
                content: Array<{ type: string; text?: string }>;
              };
              return data.content?.find((b) => b.type === "text")?.text ?? "";
            };

        const architectureSummary =
          "openclooda is a cognitive OODA agent with dual-process council, triage, archivist, beliefs, DMN, admission gate, pattern separation, emotional tagging, causal retrieval, learned forgetting, evolutionary agent archive, and git-worktree sandboxed self-modification. " +
          "Capability gaps we want research on: curiosity-driven exploration, metacognition / calibrated uncertainty, richer reasoning shapes (tree/graph-of-thought, debate, verification), theory of mind, generative world models, tool discovery & skill-library acquisition, hierarchical planning, graph-RAG / hierarchical memory, continual and lifelong learning, benchmarks beyond pass^k, self-critique / constitutional AI / RLAIF, predictive coding / free-energy / global workspace, POMDP / bandits / sequential decision / optimal stopping. " +
          "Score high (>=0.6) for concrete, testable mechanisms filling a gap; medium (0.4-0.6) for adjacent ideas; low (<0.4) for pure theory, domain-specific, or incremental engineering.";

        console.log(
          `backfill: ${categories.length} cats × ${keywords.length} kws = ${categories.length * keywords.length} queries; floor=${floor}${opts.dryRun ? " (dry-run)" : ""}`,
        );

        const r = await runResearchBackfill(
          workspacePath,
          { callModel },
          {
            categories,
            keywords,
            architectureSummary,
            since: opts.since,
            until: opts.until,
            maxPerQuery: opts.maxPerQuery ? Number.parseInt(opts.maxPerQuery, 10) : undefined,
            maxCandidatesTotal: opts.maxTotal ? Number.parseInt(opts.maxTotal, 10) : undefined,
            candidateFloor: floor,
            onProgress: (p) => {
              process.stderr.write(`  [${p.done}/${p.total}]\r`);
            },
          },
        );
        process.stderr.write("\n");
        console.log(
          `backfill complete: queries=${r.queries_issued} scanned=${r.scanned} scored=${r.scored} accepted=${r.accepted} skipped_existing=${r.skipped_existing} failed=${r.queries_failed}`,
        );
      },
    );

  research
    .command("rollout-queue")
    .description("Show experiments awaiting human approval after the research gate admitted them")
    .option("--json", "Output raw JSON")
    .action((opts: { json?: boolean }) => {
      const rows = readRolloutQueue(workspacePath);
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (rows.length === 0) {
        console.log("Rollout queue is empty.");
        return;
      }
      for (const r of rows) {
        console.log(
          `${r.queued_at}  ${r.exp_id.padEnd(32)} proposal=${r.proposal_id}  ${r.summary}`,
        );
      }
    });

  // ==========================================================================
  // CR_OODA_HYPOTHESIS_DISCIPLINE — hypothesis + roadmap subcommands
  // ==========================================================================

  const hypothesis = research
    .command("hypothesis")
    .description("Hypothesis-level inspection (CR_OODA_HYPOTHESIS_DISCIPLINE)");

  hypothesis
    .command("list")
    .description("List experiments keyed by hypothesis id")
    .option("--json", "Output raw JSON")
    .action((opts: { json?: boolean }) => {
      const rows = listExperiments(workspacePath)
        .filter((e) => e.hypothesis_obj)
        .map((e) => ({
          hypothesis_id: e.hypothesis_obj!.id,
          exp_id: e.exp_id,
          status: e.status,
          claim: e.hypothesis_obj!.claim,
          runs: e.runs?.length ?? 0,
          verdict: e.conclusion?.verdict ?? e.runs?.[e.runs.length - 1]?.verdict ?? "pending",
          epic:
            e.value?.roadmap_link.mode === "existing"
              ? e.value.roadmap_link.epic
              : e.value?.roadmap_link.mode === "propose"
                ? `(proposed) ${e.value.roadmap_link.epic_id}`
                : "(none)",
        }));
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (rows.length === 0) {
        console.log("No hypothesis-tracked experiments yet.");
        return;
      }
      for (const r of rows) {
        console.log(
          `${r.hypothesis_id}  ${r.status.padEnd(22)} runs=${r.runs} verdict=${r.verdict.padEnd(8)} epic=${r.epic}`,
        );
        console.log(`  claim: ${r.claim}`);
      }
    });

  hypothesis
    .command("show")
    .argument("<hypothesis-id>", "H-NNN identifier")
    .description("Show the full experiment record for a hypothesis id")
    .action((hId: string) => {
      const match = listExperiments(workspacePath).find((e) => e.hypothesis_obj?.id === hId);
      if (!match) {
        console.error(`No experiment with hypothesis id "${hId}".`);
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify(match, null, 2));
    });

  hypothesis
    .command("conclude")
    .argument("<exp-id>", "Experiment id")
    .argument("<verdict>", "stage | dump | inconclusive")
    .argument("<learning>", "One-line learning note")
    .description("Manually conclude an experiment (authored_by=human)")
    .action((expId: string, verdict: string, learning: string) => {
      if (!["stage", "dump", "inconclusive"].includes(verdict)) {
        console.error(`Invalid verdict: ${verdict}`);
        process.exitCode = 1;
        return;
      }
      const r = concludeExperiment(workspacePath, expId, {
        verdict: verdict as "stage" | "dump" | "inconclusive",
        learning,
        authored_by: "human",
      });
      if (!r.record) {
        console.error(`No record found for ${expId}`);
        process.exitCode = 1;
        return;
      }
      transitionStage(workspacePath, expId, "concluded-dump", learning);
      console.log(`Concluded ${expId} as ${verdict}: ${learning}`);
    });

  hypothesis
    .command("close-outs")
    .description("Show close-out entries from the research log (terminal experiment outcomes)")
    .option("--json", "Output raw JSON")
    .action((opts: { json?: boolean }) => {
      const rows = readCloseOuts(workspacePath);
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (rows.length === 0) {
        console.log("No close-out rows yet.");
        return;
      }
      for (const r of rows) {
        console.log(
          `${r.concluded_at}  ${r.hypothesis_id.padEnd(8)} ${r.verdict.padEnd(12)} ${r.exp_id}`,
        );
        console.log(`  learning: ${r.learning}`);
      }
    });

  // --- Roadmap subcommands -------------------------------------------------

  const roadmap = research
    .command("roadmap")
    .description("ROADMAP.md inspection + draft-epic review");

  roadmap
    .command("list")
    .description("List epics currently in ROADMAP.md")
    .option("--json", "Output raw JSON")
    .action((opts: { json?: boolean }) => {
      const epics = listEpics(workspacePath);
      if (opts.json) {
        console.log(JSON.stringify(epics, null, 2));
        return;
      }
      if (epics.length === 0) {
        console.log("ROADMAP.md is empty or missing. Run `workspace research roadmap bootstrap`.");
        return;
      }
      for (const e of epics) {
        console.log(`${e.horizon.padEnd(8)} ${e.id.padEnd(28)} ${e.title}`);
      }
    });

  roadmap
    .command("bootstrap")
    .description(
      "Write a starter ROADMAP.md populated from the default gap list (no-op if already present)",
    )
    .action(() => {
      const wrote = bootstrapRoadmap(workspacePath);
      console.log(wrote ? "ROADMAP.md written" : "ROADMAP.md already exists — leaving untouched");
    });

  roadmap
    .command("pending")
    .description("Show draft epics proposed by the research loop awaiting operator review")
    .option("--json", "Output raw JSON")
    .action((opts: { json?: boolean }) => {
      const rows = pendingEpics(workspacePath);
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (rows.length === 0) {
        console.log("No pending epic proposals.");
        return;
      }
      for (const r of rows) {
        console.log(
          `${r.epic_id.padEnd(28)} horizon=${r.horizon.padEnd(8)} by=${r.proposed_by_hypothesis_id}`,
        );
        console.log(`  title: ${r.title}`);
        console.log(`  rationale: ${r.rationale}`);
      }
    });

  roadmap
    .command("accept")
    .argument("<epic-id>", "Draft epic id")
    .argument("[reason]", "Optional reason", "accepted")
    .description("Accept a draft epic — appends to ROADMAP.md + unblocks its experiment")
    .action((epicId: string, reason: string) => {
      const resolved = resolveProposedEpic(workspacePath, epicId, "accepted", reason);
      if (!resolved) {
        console.error(`No pending epic with id "${epicId}"`);
        process.exitCode = 1;
        return;
      }
      appendEpic(workspacePath, {
        id: resolved.epic_id,
        title: resolved.title,
        horizon: resolved.horizon as Horizon,
      });
      // Unblock the experiment.
      const waiting = listExperiments(workspacePath).find(
        (e) =>
          e.status === "awaiting-epic-approval" &&
          e.value?.roadmap_link.mode === "propose" &&
          e.value.roadmap_link.epic_id === epicId,
      );
      if (waiting) {
        transitionStage(workspacePath, waiting.exp_id, "sandboxed", `epic ${epicId} accepted`);
      }
      console.log(
        `Accepted ${epicId}. ROADMAP.md updated.${waiting ? ` Experiment ${waiting.exp_id} unblocked.` : ""}`,
      );
    });

  roadmap
    .command("reject")
    .argument("<epic-id>", "Draft epic id")
    .argument("<reason>", "Reason for rejection")
    .description("Reject a draft epic — concludes its experiment as dump")
    .action((epicId: string, reason: string) => {
      const resolved = resolveProposedEpic(workspacePath, epicId, "rejected", reason);
      if (!resolved) {
        console.error(`No pending epic with id "${epicId}"`);
        process.exitCode = 1;
        return;
      }
      const waiting = listExperiments(workspacePath).find(
        (e) =>
          e.status === "awaiting-epic-approval" &&
          e.value?.roadmap_link.mode === "propose" &&
          e.value.roadmap_link.epic_id === epicId,
      );
      if (waiting) {
        concludeExperiment(workspacePath, waiting.exp_id, {
          verdict: "dump",
          learning: `epic rejected: ${reason}`,
          authored_by: "human",
        });
        transitionStage(
          workspacePath,
          waiting.exp_id,
          "concluded-dump",
          `epic rejected: ${reason}`,
        );
      }
      console.log(
        `Rejected ${epicId}: ${reason}.${waiting ? ` Experiment ${waiting.exp_id} concluded as dump.` : ""}`,
      );
    });

  // Reference variable so listEpicStates is retained even if we later collapse
  // the pending-only path. Silences the unused-import warning for the
  // currently-unused export without removing it from the module surface.
  void latestEpicStates;
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
  registerArchiveCommands(workspace, workspacePath);
  registerResearchCommands(workspace, workspacePath);
}
