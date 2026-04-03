/**
 * OpenClaw Memory (OODA) Plugin
 *
 * Cognitive OODA agent — Tier 3 semantic memory with knowledge injection,
 * workspace CLI commands, and pending proposal notifications.
 *
 * OODA chain is enabled by default. Set `enabled: false` in plugin config
 * to disable.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/memory-ooda";
import {
  readState,
  writeState,
  shouldRunArchivist,
  runArchivist,
  type EpisodicStore,
  type EpisodicEvent,
  type SemanticStore,
} from "./archivist.js";
import { registerWorkspaceCli } from "./cli.js";
import { runCouncil, type CouncilMode } from "./council.js";
import { runMetaReviewer, type PrioritiesStore, type ProposalStore } from "./meta-reviewer.js";
import { getPriorities, updateDomainWeight } from "./priorities.js";
import { countPending, getProposals, addProposal } from "./proposals.js";
import {
  getFacts,
  formatFactsForContext,
  upsertFact,
  appendArchivistLog,
} from "./semantic-memory.js";
import { runStrategy } from "./strategy.js";
import {
  dispatchTask,
  getTaskStatus,
  listTasks,
  cancelTask,
  wakeSync,
  evaluateDispatch,
} from "./task-bridge.js";
import { runTriage, shouldRunFullOODA, type ModelCallFn } from "./triage.js";

// ============================================================================
// Config
// ============================================================================

export type OodaConfig = {
  /** Path to the OODA workspace directory. Default: ~/.openclaw/workspace */
  workspacePath?: string;
  /** Enable the OODA chain. Default: true */
  enabled?: boolean;
  /** Inject pending proposal count into agent preamble. Default: true */
  notifyPendingProposals?: boolean;
  /**
   * Show a compact OODA summary line in each reply (visible in TUI/chat).
   * "off"     — silent (default)
   * "inline"  — one-line SITREP+strategy summary prepended to each reply
   * "verbose" — inline + council trace when system2 fired
   */
  debugMode?: "off" | "inline" | "verbose";
};

function resolveWorkspacePath(cfg: OodaConfig): string {
  return cfg.workspacePath || join(homedir(), ".openclaw", "workspace");
}

// ============================================================================
// LanceDB EpisodicStore Builder
// ============================================================================

/**
 * Resolve the lancedb dbPath from memory-lancedb plugin config or agent workspace fallback.
 */
function resolveLanceDbPath(api: OpenClawPluginApi): string {
  // Try memory-lancedb plugin config
  const lancedbEntry = api.config.plugins?.entries?.["memory-lancedb"];
  if (lancedbEntry?.config?.dbPath && typeof lancedbEntry.config.dbPath === "string") {
    return lancedbEntry.config.dbPath;
  }

  // Fall back to agent workspace + /../memory/lancedb
  // memory-lancedb writes to <stateDir>/memory/lancedb by default.
  const agentWorkspace = api.config.agents?.defaults?.workspace;
  if (agentWorkspace) {
    return join(agentWorkspace, "..", "memory", "lancedb");
  }

  // Default
  return join(homedir(), ".openclaw", "memory", "lancedb");
}

const TABLE_NAME = "memories";

/**
 * Build an EpisodicStore backed by the sqlite-vec fallback database.
 *
 * memory-lancedb's SqliteVecMemoryDB writes to `memories.sqlite` in the same
 * dbPath directory. We open it here with node:sqlite (no vector extension
 * needed — archivist only needs sequential reads and status updates, not ANN
 * search). This runs on Intel Mac where @lancedb/lancedb-darwin-x64 is absent.
 */
async function buildSqliteEpisodicStore(dbPath: string): Promise<EpisodicStore> {
  const { DatabaseSync } = await import("node:sqlite");
  const { join: pathJoin } = await import("node:path");
  const sqlitePath = pathJoin(dbPath, "memories.sqlite");
  const db = new DatabaseSync(sqlitePath);

  return {
    async retrieveSince(sinceTimestamp: number, limit = 1000): Promise<EpisodicEvent[]> {
      const rows = db
        .prepare(
          `SELECT id, text, category, importance, createdAt, source, actionId, archivistProcessed
           FROM memories
           WHERE createdAt > ?
           ORDER BY createdAt ASC
           LIMIT ?`,
        )
        .all(sinceTimestamp, limit) as Array<Record<string, unknown>>;

      return rows.map((row) => ({
        id: row.id as string,
        text: row.text as string,
        category: row.category as string,
        importance: row.importance as number,
        createdAt: row.createdAt as number,
        source: (row.source as string) || undefined,
        actionId: (row.actionId as string) || undefined,
        archivistProcessed: row.archivistProcessed === 1 || row.archivistProcessed === true,
      }));
    },

    async markProcessed(id: string): Promise<void> {
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(id)) {
        throw new Error(`Invalid memory ID format: ${id}`);
      }
      db.prepare("UPDATE memories SET archivistProcessed = 1 WHERE id = ?").run(id);
    },

    async prune(olderThanMs: number, onlyProcessed = false): Promise<number> {
      const stmt = onlyProcessed
        ? db.prepare("DELETE FROM memories WHERE createdAt < ? AND archivistProcessed = 1")
        : db.prepare("DELETE FROM memories WHERE createdAt < ?");
      const result = stmt.run(olderThanMs) as { changes: number };
      return result.changes ?? 0;
    },
  };
}

async function buildEpisodicStore(api: OpenClawPluginApi): Promise<EpisodicStore | null> {
  const dbPath = resolveLanceDbPath(api);

  // ── Path 1: LanceDB (preferred, ARM Mac / Linux / Windows) ──────────────
  try {
    const lancedb = await import("@lancedb/lancedb");
    const db = await lancedb.connect(dbPath);
    const tables = await db.tableNames();

    if (!tables.includes(TABLE_NAME)) {
      api.logger.warn("memory-ooda: lancedb 'memories' table not found — archivist skipped");
      return null;
    }

    const table = await db.openTable(TABLE_NAME);

    return {
      async retrieveSince(sinceTimestamp: number, limit = 1000): Promise<EpisodicEvent[]> {
        // eslint-disable-next-line -- lancedb Table typing lacks .filter(); cast to any
        const rows: Record<string, unknown>[] = await (table as any)
          .filter(`createdAt > ${sinceTimestamp}`)
          .limit(limit)
          .toArray();
        return rows
          .map((row: Record<string, unknown>) => ({
            id: row.id as string,
            text: row.text as string,
            category: row.category as string,
            importance: row.importance as number,
            createdAt: row.createdAt as number,
            source: (row.source as string) || undefined,
            actionId: (row.actionId as string) || undefined,
            archivistProcessed: (row.archivistProcessed as boolean) || false,
          }))
          .sort((a: EpisodicEvent, b: EpisodicEvent) => a.createdAt - b.createdAt);
      },

      async markProcessed(id: string): Promise<void> {
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(id)) {
          throw new Error(`Invalid memory ID format: ${id}`);
        }
        // eslint-disable-next-line -- lancedb Table typing lacks .filter()
        const rows: Record<string, unknown>[] = await (table as any)
          .filter(`id = '${id}'`)
          .toArray();
        if (rows.length === 0) return;
        const row = rows[0];
        await table.delete(`id = '${id}'`);
        await table.add([{ ...row, archivistProcessed: true }]);
      },

      async prune(olderThanMs: number, onlyProcessed = false): Promise<number> {
        let filter = `createdAt < ${olderThanMs}`;
        if (onlyProcessed) {
          filter += " AND archivistProcessed = true";
        }
        // eslint-disable-next-line -- lancedb Table typing lacks .filter()
        const rows: unknown[] = await (table as any).filter(filter).toArray();
        if (rows.length === 0) return 0;
        await table.delete(filter);
        return rows.length;
      },
    };
  } catch (_lanceErr) {
    // LanceDB unavailable (e.g. Intel Mac missing @lancedb/lancedb-darwin-x64).
    // Fall through to sqlite-vec fallback.
  }

  // ── Path 2: sqlite-vec fallback (Intel Mac / no native LanceDB binding) ──
  try {
    const { existsSync } = await import("node:fs");
    const { join: pathJoin } = await import("node:path");
    const sqlitePath = pathJoin(dbPath, "memories.sqlite");

    if (!existsSync(sqlitePath)) {
      // memory-lancedb hasn't written anything yet — nothing to read
      api.logger.warn(
        "memory-ooda: sqlite-vec fallback selected but memories.sqlite not found — archivist skipped until memory-lancedb captures first event",
      );
      return null;
    }

    api.logger.info(
      `memory-ooda: LanceDB unavailable — using sqlite-vec fallback (db: ${sqlitePath})`,
    );
    return await buildSqliteEpisodicStore(dbPath);
  } catch (err) {
    api.logger.warn(`memory-ooda: sqlite-vec fallback also failed: ${String(err)}`);
    return null;
  }
}

// ============================================================================
// Plugin
// ============================================================================

let registered = false;

const oodaPlugin = {
  id: "memory-ooda",
  name: "Memory (OODA)",
  description: "Cognitive OODA agent — Tier 3 semantic memory with knowledge injection",
  // No kind — memory-ooda is slotless. memory-lancedb owns the memory slot (Tier 2).
  // memory-ooda runs alongside as a cognitive layer (Tier 3 distillation + context injection).

  register(api: OpenClawPluginApi) {
    if (registered) return;

    const cfg = (api.pluginConfig ?? {}) as OodaConfig;
    const enabled = cfg.enabled !== false; // enabled by default
    const workspacePath = resolveWorkspacePath(cfg);
    const notifyProposals = cfg.notifyPendingProposals !== false; // enabled by default
    const debugMode = cfg.debugMode ?? "off";

    if (!enabled) {
      api.logger.info("memory-ooda: disabled via config");
      return;
    }

    registered = true;
    api.logger.info(`memory-ooda: registered (workspace: ${workspacePath})`);

    // ========================================================================
    // Shared callModel helper (subagent pattern)
    // ========================================================================

    const callModel: ModelCallFn = async (prompt: string): Promise<string> => {
      const sessionKey = `ooda-${Date.now()}`;
      try {
        const { runId } = await api.runtime.subagent.run({
          sessionKey,
          message: prompt,
          extraSystemPrompt:
            "You are an OODA reasoning agent. Respond with raw JSON only. No explanation.",
          deliver: false,
        });

        const waitResult = await api.runtime.subagent.waitForRun({
          runId,
          timeoutMs: 120_000,
        });

        if (waitResult.status !== "ok") {
          throw new Error(`subagent run failed: ${waitResult.status} ${waitResult.error ?? ""}`);
        }

        const { messages } = await api.runtime.subagent.getSessionMessages({
          sessionKey,
          limit: 10,
        });

        // Extract last assistant message text
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i] as Record<string, unknown>;
          if (msg.role === "assistant" && typeof msg.content === "string") {
            return msg.content;
          }
          // Handle array content (tool_use / text blocks)
          if (msg.role === "assistant" && Array.isArray(msg.content)) {
            for (let j = (msg.content as unknown[]).length - 1; j >= 0; j--) {
              const block = (msg.content as Record<string, unknown>[])[j];
              if (block.type === "text" && typeof block.text === "string") {
                return block.text;
              }
            }
          }
        }

        throw new Error("No assistant reply found in subagent session");
      } finally {
        // Clean up isolated session
        try {
          await api.runtime.subagent.deleteSession({ sessionKey });
        } catch {
          // best-effort cleanup
        }
      }
    };

    // ========================================================================
    // Context Injection + OODA Triage/Strategy
    // ========================================================================

    api.on("before_agent_start", async (event, ctx) => {
      try {
        const knowledge = getFacts(workspacePath);
        const context = formatFactsForContext(knowledge);
        const parts: string[] = [];

        if (context) {
          parts.push(context);
        }

        // Notify about pending proposals (enhanced: show text inline when only 1)
        if (notifyProposals) {
          const allProposals = getProposals(workspacePath);
          const pendingProposals = allProposals.filter((p) => p.status === "pending");
          const pending = pendingProposals.length;
          if (pending === 1) {
            const p = pendingProposals[0];
            const tag = p.autoGenerated ? "🤖 Auto-proposal" : "📋 Proposal";
            const conf = p.autoGenerated ? ` (${Math.round(p.confidence * 100)}% confidence)` : "";
            parts.push(
              `<ooda-notice>${tag} [${p.rule}]: ${p.proposal}${conf} — run \`openclaw workspace proposals list\` to review.</ooda-notice>`,
            );
          } else if (pending > 1) {
            const autoCount = pendingProposals.filter((p) => p.autoGenerated).length;
            const autoNote = autoCount > 0 ? ` (${autoCount} auto-generated)` : "";
            parts.push(
              `<ooda-notice>You have ${pending} pending proposal${pending === 1 ? "" : "s"}${autoNote}. Run \`openclaw workspace proposals list --pending\` to review.</ooda-notice>`,
            );
          }
        }

        // ==================================================================
        // OODA Triage + Strategy
        // ==================================================================

        // Read thinkingLevel from hook context (exposed via PluginHookAgentContext.thinkingLevel).
        // Normalise to the three levels the OODA chain recognises; anything ≤ "low" stays "low".
        const rawLevel = ctx?.thinkingLevel ?? "off";
        const thinkingLevel: "low" | "medium" | "high" =
          rawLevel === "high" || rawLevel === "xhigh"
            ? "high"
            : rawLevel === "medium" || rawLevel === "adaptive"
              ? "medium"
              : "low";

        let priorities;
        try {
          priorities = getPriorities(workspacePath);
        } catch (err) {
          api.logger.warn(`memory-ooda: failed to load priorities: ${String(err)}`);
          if (parts.length === 0) return;
          return { prependSystemContext: parts.join("\n\n") };
        }

        // Refs for debug summary (hoisted so the summary block below can read them)
        let triageResult: Awaited<ReturnType<typeof runTriage>> | undefined;
        let councilResultRef: import("./council.js").CouncilResult | undefined;

        try {
          triageResult = await runTriage(
            { observation: event.prompt, facts: knowledge, priorities },
            callModel,
          );

          const sitrep = triageResult.sitrep;

          // Format SITREP — attention field bolded at top when present
          const sitrepLines: string[] = [];
          if (sitrep.attention) {
            sitrepLines.push(`**ATTENTION:** ${sitrep.attention}`);
          }
          sitrepLines.push(
            `Priority: ${sitrep.priority}/10 | ${sitrep.summary} | Domains: ${sitrep.recommendedDomains.join(", ") || "none"}`,
          );
          const sitrepBlock = `<ooda-sitrep>${sitrepLines.join("\n")}</ooda-sitrep>`;

          if (!shouldRunFullOODA(sitrep, priorities, thinkingLevel)) {
            parts.push(sitrepBlock);
          } else {
            // Full OODA: run strategy
            parts.push(sitrepBlock);

            try {
              const strategyInput = {
                sitrep,
                priorities,
                observation: event.prompt,
                neverDo: knowledge.preferences.never_do,
              };

              // Determine council mode
              const thinkingRank = { low: 0, medium: 1, high: 2 };
              let councilMode: CouncilMode = "none";
              if (
                priorities.thresholds.council_system2_enabled &&
                sitrep.priority >= (priorities.thresholds.council_priority_threshold ?? 7) &&
                thinkingRank[thinkingLevel] >= thinkingRank.medium
              ) {
                councilMode = "system2";
              } else if (priorities.thresholds.council_system1_enabled) {
                councilMode = "system1";
              }

              const councilResult = await runCouncil(strategyInput, councilMode, callModel);
              councilResultRef = councilResult;
              const winner = councilResult.winner;

              parts.push(
                `<ooda-strategy>Action: ${winner.label} | ${winner.reasoning}</ooda-strategy>`,
              );

              // System 2: inject council block
              if (
                councilResult.mode === "system2" &&
                Object.keys(councilResult.council_trace).length > 0
              ) {
                const traceLines = Object.entries(councilResult.council_trace)
                  .map(([role, output]) => `[${role}]: ${output}`)
                  .join("\n");
                parts.push(`<ooda-council>${traceLines}</ooda-council>`);
              }

              // Log dissent
              if (councilResult.dissent) {
                api.logger.info(
                  `memory-ooda: council dissent — chair overrode strategist (mode=${councilResult.mode}, winner=${winner.label})`,
                );
              }

              // OODA_DEBUG: show raw council output for calibration
              if (process.env.OODA_DEBUG === "true") {
                parts.push(
                  `<ooda-strategy-debug>${JSON.stringify(councilResult, null, 2)}</ooda-strategy-debug>`,
                );
              }
            } catch (err) {
              api.logger.warn(`memory-ooda: strategy/council failed, skipping: ${String(err)}`);
            }
          }
        } catch (err) {
          api.logger.warn(`memory-ooda: triage failed, skipping: ${String(err)}`);
        }

        if (parts.length === 0) return;

        // Build optional visible OODA summary for TUI/chat
        let oodaSummary: string | undefined;
        if (debugMode !== "off") {
          // Always show: priority + strategy winner
          const sitrepStr = `P${triageResult?.sitrep?.priority ?? "?"}/10`;
          const strategyStr = councilResultRef?.winner?.label ?? "—";
          const councilStr =
            councilResultRef?.mode === "system2"
              ? ` | council:S2${councilResultRef.dissent ? "⚠️dissent" : ""}`
              : councilResultRef?.mode === "system1"
                ? " | council:S1"
                : "";
          const summaryLine = `\`[OODA ${sitrepStr} | ${strategyStr}${councilStr}]\``;

          if (
            debugMode === "verbose" &&
            councilResultRef?.mode === "system2" &&
            Object.keys(councilResultRef.council_trace).length > 0
          ) {
            const traceStr = Object.entries(councilResultRef.council_trace)
              .map(([role, out]) => `  **${role}:** ${(out as string).slice(0, 120)}`)
              .join("\n");
            oodaSummary = `${summaryLine}\n${traceStr}`;
          } else {
            oodaSummary = summaryLine;
          }
        }

        return {
          prependSystemContext: parts.join("\n\n"),
          ...(oodaSummary ? { prependContext: oodaSummary } : {}),
        };
      } catch (err) {
        api.logger.warn(`memory-ooda: failed to inject context: ${String(err)}`);
      }
    });

    // ========================================================================
    // Archivist — async Tier 2 → Tier 3 distillation on agent_end
    // ========================================================================

    let turnCount = 0;
    try {
      const initialState = readState(workspacePath);
      turnCount = initialState.last_processed_turn;
    } catch {
      // Fresh workspace or corrupt state — start from 0
    }

    api.on("agent_end", (event) => {
      if (!event.success) return;

      turnCount++;

      // Increment turns_since_last_archivist and persist. The archivist resets
      // it to 0 after a successful run. No two-counter subtraction, no drift.
      let currentState: ReturnType<typeof readState>;
      try {
        currentState = readState(workspacePath);
        writeState(workspacePath, {
          ...currentState,
          last_processed_turn: turnCount,
          turns_since_last_archivist: currentState.turns_since_last_archivist + 1,
        });
        currentState = {
          ...currentState,
          turns_since_last_archivist: currentState.turns_since_last_archivist + 1,
        };
      } catch (err) {
        api.logger.warn(`memory-ooda: failed to persist turn count: ${String(err)}`);
        return;
      }

      // Check if archivist is due
      let turnInterval: number;
      try {
        turnInterval = getPriorities(workspacePath).thresholds.archivist_turn_interval;
      } catch {
        turnInterval = 15;
      }

      if (!shouldRunArchivist(currentState, turnInterval)) return;

      // Fire archivist non-blocking
      setImmediate(() => {
        void (async () => {
          try {
            // Build EpisodicStore from lancedb
            const episodicStore = await buildEpisodicStore(api);
            if (!episodicStore) {
              api.logger.warn("memory-ooda: archivist skipped — lancedb unavailable");
              return;
            }

            // Build SemanticStore
            const semanticStore: SemanticStore = {
              upsertFact: (section, key, value) => upsertFact(workspacePath, section, key, value),
              appendArchivistLog: (action, reason) =>
                appendArchivistLog(workspacePath, action, reason),
            };

            const result = await runArchivist(
              workspacePath,
              turnCount,
              episodicStore,
              semanticStore,
              callModel,
              { turnInterval },
            );

            api.logger.info(
              `memory-ooda: archivist completed — ${result.eventsProcessed} events, ${result.patternsExtracted.length} patterns`,
            );

            // ── Meta-reviewer trigger ───────────────────────────────────────
            // Fire after every N archivist completions (archivist_runs_since_meta_review
            // is incremented inside runArchivist before we read it here).
            try {
              const updatedState = readState(workspacePath);
              const metaInterval =
                getPriorities(workspacePath).thresholds.meta_reviewer_archivist_interval ?? 5;
              if (
                metaInterval > 0 &&
                updatedState.archivist_runs_since_meta_review >= metaInterval
              ) {
                api.logger.info(
                  `memory-ooda: meta-reviewer triggered (${updatedState.archivist_runs_since_meta_review} archivist runs since last review)`,
                );
                const priorities = getPriorities(workspacePath);
                const prioritiesStore: PrioritiesStore = {
                  getPriorities: () => getPriorities(workspacePath),
                  updateDomainWeight: (domain, newWeight, reason) =>
                    updateDomainWeight(workspacePath, domain, newWeight, reason),
                };
                const proposalStore: ProposalStore = {
                  addProposal: (p) => addProposal(workspacePath, p),
                };
                const metaResult = await runMetaReviewer(
                  { failures: [], priorities },
                  prioritiesStore,
                  proposalStore,
                  callModel,
                );
                // Reset counter
                const stateAfterMeta = readState(workspacePath);
                writeState(workspacePath, {
                  ...stateAfterMeta,
                  archivist_runs_since_meta_review: 0,
                });
                api.logger.info(
                  `memory-ooda: meta-reviewer completed — ${metaResult.weightsAdjusted.length} weight adjustments, ${metaResult.proposalsCreated.length} proposals`,
                );
              }
            } catch (metaErr) {
              api.logger.warn(`memory-ooda: meta-reviewer failed: ${String(metaErr)}`);
            }
          } catch (err) {
            api.logger.warn(`memory-ooda: archivist failed: ${String(err)}`);
          }
        })();
      });
    });

    // ========================================================================
    // Wake Sync — surface completed cloud tasks on session start
    // ========================================================================

    api.on("session_start", async () => {
      try {
        const completed = wakeSync(workspacePath);
        if (completed.length === 0) return;

        const lines = completed.map((t) => {
          const status = t.status === "failed" ? "❌ failed" : "✅ done";
          const result = t.result ? ` — ${t.result.split("\n")[0].slice(0, 120)}` : "";
          return `• [${status}] ${t.title}${result}`;
        });

        const msg =
          completed.length === 1
            ? `While you were away, a cloud task completed:\n${lines[0]}`
            : `While you were away, ${completed.length} cloud tasks completed:\n${lines.join("\n")}`;

        api.logger.info(`memory-ooda: wake sync — ${completed.length} task(s) surfaced`);

        return { prependSystemContext: `<ooda-notice>${msg}</ooda-notice>` };
      } catch (err) {
        api.logger.warn(`memory-ooda: wake sync failed: ${String(err)}`);
      }
    });

    // ========================================================================
    // Task Bridge — expose dispatch/status/cancel/list as plugin methods
    // ========================================================================

    // Attach task bridge methods to plugin API for use by agent and CLI
    (api as unknown as Record<string, unknown>).tasks = {
      dispatch: (spec: Parameters<typeof dispatchTask>[1]) => dispatchTask(workspacePath, spec),
      status: (query: string) => getTaskStatus(workspacePath, query),
      list: (filter?: Parameters<typeof listTasks>[1]) => listTasks(workspacePath, filter),
      cancel: (query: string) => cancelTask(workspacePath, query),
      evaluateDispatch: (params: Parameters<typeof evaluateDispatch>[0]) =>
        evaluateDispatch(params),
    };

    // ========================================================================
    // CLI Commands
    // ========================================================================

    api.registerCli(
      ({ program }) => {
        registerWorkspaceCli(program, workspacePath);

        // Task bridge CLI
        const tasks = program.command("tasks").description("Cloud task queue");

        tasks
          .command("list")
          .description("List all tasks")
          .option("--pending", "Only pending tasks")
          .option("--active", "Only active tasks")
          .option("--done", "Only completed tasks")
          .action((opts) => {
            const filter = opts.pending
              ? "pending"
              : opts.active
                ? "active"
                : opts.done
                  ? "done"
                  : undefined;
            const items = listTasks(workspacePath, filter);
            if (items.length === 0) {
              console.log("No tasks found.");
              return;
            }
            for (const { task } of items) {
              const age = Math.round((Date.now() - new Date(task.createdAt).getTime()) / 60000);
              console.log(`[${task.status}] ${task.id}: ${task.title} (${age}m ago)`);
            }
          });

        tasks
          .command("status <query>")
          .description("Get status of a task by ID or title")
          .action((query: string) => {
            const found = getTaskStatus(workspacePath, query);
            if (!found) {
              console.log(`No task found matching: ${query}`);
              return;
            }
            const { task } = found;
            console.log(`ID:      ${task.id}`);
            console.log(`Title:   ${task.title}`);
            console.log(`Status:  ${task.status}`);
            console.log(`Created: ${task.createdAt}`);
            if (task.claimedAt) console.log(`Claimed: ${task.claimedAt} by ${task.claimedBy}`);
            if (task.completedAt) console.log(`Done:    ${task.completedAt}`);
            if (task.log.length > 0) {
              console.log(`\nLast log entries:`);
              for (const e of task.log.slice(-5)) {
                console.log(`  ${e.timestamp} [${e.source}] ${e.message}`);
              }
            }
            if (task.result) {
              console.log(`\nResult:\n${task.result.slice(0, 500)}`);
            }
          });

        tasks
          .command("cancel <query>")
          .description("Cancel a pending or active task")
          .action((query: string) => {
            const ok = cancelTask(workspacePath, query);
            console.log(ok ? `Task cancelled.` : `No cancellable task found matching: ${query}`);
          });
      },
      { commands: ["workspace", "tasks"] },
    );

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: "memory-ooda",
      start: () => {
        // Ensure templates exist on startup
        getFacts(workspacePath);
        getPriorities(workspacePath);
        api.logger.info(`memory-ooda: initialized (workspace: ${workspacePath})`);
      },
      stop: () => {
        api.logger.info("memory-ooda: stopped");
      },
    });
  },
};

export default oodaPlugin;
