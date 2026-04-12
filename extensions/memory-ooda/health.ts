/**
 * OODA Health Telemetry
 *
 * Lightweight write-on-fire telemetry for the OODA chain subsystems.
 * Each subsystem pings its entry here on every execution. The doctor
 * CLI reads this file to report system health without needing to
 * introspect live gateway state.
 *
 * File: <workspacePath>/ooda-health.json
 */

import fs from "node:fs";
import path from "node:path";

export type SubsystemId =
  | "before_agent_start"
  | "agent_end"
  | "archivist"
  | "triage"
  | "strategy"
  | "council"
  | "meta_reviewer"
  | "slow_clarify"
  | "reflect";

export type SubsystemHealth = {
  /** ISO timestamp of last successful execution */
  lastFiredAt: string;
  /** Total number of times fired since state was last reset */
  totalFires: number;
  /** Last error message, if any */
  lastError?: string;
  /** Subsystem-specific metadata (e.g. eventsProcessed, patternsExtracted) */
  meta?: Record<string, unknown>;
};

export type OodaHealthState = {
  /** Schema version for forward-compat */
  version: 1;
  /** Last time any subsystem wrote to this file */
  updatedAt: string;
  subsystems: Partial<Record<SubsystemId, SubsystemHealth>>;
};

const HEALTH_FILENAME = "ooda-health.json";

export function healthPath(workspacePath: string): string {
  return path.join(workspacePath, HEALTH_FILENAME);
}

function readHealthRaw(workspacePath: string): OodaHealthState {
  const filePath = healthPath(workspacePath);
  if (!fs.existsSync(filePath)) {
    return { version: 1, updatedAt: new Date().toISOString(), subsystems: {} };
  }
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as OodaHealthState;
    if (!parsed.subsystems) parsed.subsystems = {};
    return parsed;
  } catch {
    return { version: 1, updatedAt: new Date().toISOString(), subsystems: {} };
  }
}

/**
 * Record a successful execution of a subsystem.
 * Best-effort: never throws, never blocks the caller.
 */
export function pingHealth(
  workspacePath: string,
  id: SubsystemId,
  meta?: Record<string, unknown>,
): void {
  try {
    const state = readHealthRaw(workspacePath);
    const prev = state.subsystems[id];
    state.subsystems[id] = {
      lastFiredAt: new Date().toISOString(),
      totalFires: (prev?.totalFires ?? 0) + 1,
      meta: meta ?? prev?.meta,
    };
    state.updatedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(healthPath(workspacePath)), { recursive: true });
    fs.writeFileSync(healthPath(workspacePath), JSON.stringify(state, null, 2) + "\n", "utf-8");
  } catch {
    // Best-effort — health telemetry must never break the main path
  }
}

/**
 * Record an error for a subsystem (does not overwrite lastFiredAt).
 */
export function pingHealthError(workspacePath: string, id: SubsystemId, error: string): void {
  try {
    const state = readHealthRaw(workspacePath);
    const prev = state.subsystems[id] ?? {
      lastFiredAt: "never",
      totalFires: 0,
    };
    state.subsystems[id] = { ...prev, lastError: error.slice(0, 200) };
    state.updatedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(healthPath(workspacePath)), { recursive: true });
    fs.writeFileSync(healthPath(workspacePath), JSON.stringify(state, null, 2) + "\n", "utf-8");
  } catch {
    // Best-effort
  }
}

/**
 * Read the current health state (for the doctor CLI).
 */
export function readHealth(workspacePath: string): OodaHealthState {
  return readHealthRaw(workspacePath);
}

// ============================================================================
// Doctor Report
// ============================================================================

export type SubsystemReport = {
  id: SubsystemId;
  label: string;
  status: "ok" | "warn" | "error" | "unknown";
  lastFiredAt: string | null;
  totalFires: number;
  ageMs: number | null;
  detail: string;
  lastError?: string;
};

export type DoctorReport = {
  subsystems: SubsystemReport[];
  summary: { ok: number; warn: number; error: number; unknown: number };
  generatedAt: string;
  archivistState?: {
    turnsSinceLast: number;
    interval: number;
    lastRunAt: string;
    episodicRows?: number;
    processedRows?: number;
  };
};

const SUBSYSTEM_LABELS: Record<SubsystemId, string> = {
  before_agent_start: "Context injection (before_agent_start)",
  agent_end: "Turn hook (agent_end)",
  archivist: "Archivist (Tier 2→3 distillation)",
  triage: "Triage (OODA orient)",
  strategy: "Strategy / Council",
  council: "Council (system1/system2)",
  meta_reviewer: "Meta-reviewer",
  slow_clarify: "Slow Clarify",
  reflect: "Reflect",
};

// How stale is too stale for each subsystem (ms)
const WARN_THRESHOLDS_MS: Record<SubsystemId, number> = {
  before_agent_start: 24 * 60 * 60 * 1000, // 24h — only fires when agent runs
  agent_end: 24 * 60 * 60 * 1000, // 24h
  archivist: 7 * 24 * 60 * 60 * 1000, // 7d — interval-based, not per-turn
  triage: 24 * 60 * 60 * 1000,
  strategy: 48 * 60 * 60 * 1000,
  council: 7 * 24 * 60 * 60 * 1000, // council only fires on high-priority turns
  meta_reviewer: 30 * 24 * 60 * 60 * 1000, // monthly cadence is fine
  slow_clarify: 7 * 24 * 60 * 60 * 1000,
  reflect: 7 * 24 * 60 * 60 * 1000,
};

const ERROR_THRESHOLDS_MS: Record<SubsystemId, number> = {
  before_agent_start: 48 * 60 * 60 * 1000,
  agent_end: 48 * 60 * 60 * 1000,
  archivist: 14 * 24 * 60 * 60 * 1000,
  triage: 48 * 60 * 60 * 1000,
  strategy: 7 * 24 * 60 * 60 * 1000,
  council: 30 * 24 * 60 * 60 * 1000,
  meta_reviewer: 60 * 24 * 60 * 60 * 1000,
  slow_clarify: 14 * 24 * 60 * 60 * 1000,
  reflect: 14 * 24 * 60 * 60 * 1000,
};

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

export function buildDoctorReport(
  workspacePath: string,
  archivistState?: { turnsSinceLast: number; interval: number; lastRunAt: string },
  episodicStats?: { total: number; processed: number },
): DoctorReport {
  const health = readHealth(workspacePath);
  const now = Date.now();
  const subsystemIds = Object.keys(SUBSYSTEM_LABELS) as SubsystemId[];

  const subsystems: SubsystemReport[] = subsystemIds.map((id) => {
    const data = health.subsystems[id];
    const label = SUBSYSTEM_LABELS[id];

    if (!data || data.lastFiredAt === "never" || !data.lastFiredAt) {
      return {
        id,
        label,
        status: "unknown",
        lastFiredAt: null,
        totalFires: 0,
        ageMs: null,
        detail: "never fired",
        lastError: data?.lastError,
      };
    }

    const firedAt = new Date(data.lastFiredAt).getTime();
    const ageMs = isNaN(firedAt) ? null : now - firedAt;

    let status: SubsystemReport["status"] = "ok";
    let detail = ageMs !== null ? formatAge(ageMs) : "unknown age";

    if (ageMs !== null) {
      if (ageMs > ERROR_THRESHOLDS_MS[id]) status = "error";
      else if (ageMs > WARN_THRESHOLDS_MS[id]) status = "warn";
    }

    if (data.lastError) {
      detail += ` | last error: ${data.lastError}`;
    }

    if (data.meta) {
      const metaParts = Object.entries(data.meta)
        .slice(0, 3)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      if (metaParts) detail += ` | ${metaParts}`;
    }

    return {
      id,
      label,
      status,
      lastFiredAt: data.lastFiredAt,
      totalFires: data.totalFires,
      ageMs,
      detail,
      lastError: data.lastError,
    };
  });

  const summary = { ok: 0, warn: 0, error: 0, unknown: 0 };
  for (const s of subsystems) summary[s.status]++;

  return {
    subsystems,
    summary,
    generatedAt: new Date().toISOString(),
    archivistState: archivistState
      ? {
          ...archivistState,
          episodicRows: episodicStats?.total,
          processedRows: episodicStats?.processed,
        }
      : undefined,
  };
}

export function renderDoctorReport(report: DoctorReport): string {
  const ICON: Record<SubsystemReport["status"], string> = {
    ok: "✅",
    warn: "⚠️ ",
    error: "❌",
    unknown: "❓",
  };

  const lines: string[] = [];
  lines.push("OODA Health Check");
  lines.push("─".repeat(60));

  for (const s of report.subsystems) {
    const fires = s.totalFires > 0 ? ` (${s.totalFires}×)` : "";
    lines.push(`${ICON[s.status]} ${s.label}`);
    lines.push(`   ${s.detail}${fires}`);
  }

  if (report.archivistState) {
    const a = report.archivistState;
    lines.push("─".repeat(60));
    lines.push("Archivist state");
    lines.push(`   turns since last run : ${a.turnsSinceLast} / ${a.interval}`);
    lines.push(`   last_run_at          : ${a.lastRunAt}`);
    if (a.episodicRows !== undefined) {
      const unprocessed = (a.episodicRows ?? 0) - (a.processedRows ?? 0);
      lines.push(`   episodic store       : ${a.episodicRows} rows, ${unprocessed} unprocessed`);
    }
  }

  lines.push("─".repeat(60));
  const { ok, warn, error, unknown } = report.summary;
  const parts = [];
  if (ok) parts.push(`${ok} ok`);
  if (warn) parts.push(`${warn} warn`);
  if (error) parts.push(`${error} error`);
  if (unknown) parts.push(`${unknown} unknown`);
  lines.push(parts.join("  |  "));

  return lines.join("\n");
}

/**
 * Returns true if the report has any non-ok subsystems — used by the watchdog.
 */
export function isHealthy(report: DoctorReport): boolean {
  return report.summary.error === 0 && report.summary.warn === 0;
}

/**
 * Returns a compact one-line alert string for watchdog notifications.
 */
export function buildHealthAlert(report: DoctorReport): string {
  const problems = report.subsystems.filter((s) => s.status === "error" || s.status === "warn");
  if (problems.length === 0) return "OODA: all systems nominal";
  const parts = problems.map((s) => `${s.id}(${s.status}: ${s.detail.split("|")[0]?.trim()})`);
  return `⚠️ OODA health: ${parts.join(", ")}`;
}
