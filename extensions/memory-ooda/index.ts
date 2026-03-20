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
import { getPriorities } from "./priorities.js";
import { countPending } from "./proposals.js";
import {
  getFacts,
  formatFactsForContext,
  upsertFact,
  appendArchivistLog,
} from "./semantic-memory.js";
import { runStrategy } from "./strategy.js";
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

  // Fall back to agent workspace + /../memory
  const agentWorkspace = api.config.agents?.defaults?.workspace;
  if (agentWorkspace) {
    return join(agentWorkspace, "..", "memory");
  }

  // Default
  return join(homedir(), ".openclaw", "memory", "lancedb");
}

const TABLE_NAME = "memories";

async function buildEpisodicStore(api: OpenClawPluginApi): Promise<EpisodicStore | null> {
  try {
    const lancedb = await import("@lancedb/lancedb");
    const dbPath = resolveLanceDbPath(api);
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
  } catch (err) {
    api.logger.warn(`memory-ooda: failed to initialize lancedb: ${String(err)}`);
    return null;
  }
}

// ============================================================================
// Plugin
// ============================================================================

const oodaPlugin = {
  id: "memory-ooda",
  name: "Memory (OODA)",
  description: "Cognitive OODA agent — Tier 3 semantic memory with knowledge injection",
  // No kind — memory-ooda is slotless. memory-lancedb owns the memory slot (Tier 2).
  // memory-ooda runs alongside as a cognitive layer (Tier 3 distillation + context injection).

  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as OodaConfig;
    const enabled = cfg.enabled !== false; // enabled by default
    const workspacePath = resolveWorkspacePath(cfg);
    const notifyProposals = cfg.notifyPendingProposals !== false; // enabled by default

    if (!enabled) {
      api.logger.info("memory-ooda: disabled via config");
      return;
    }

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

        // Notify about pending policy proposals
        if (notifyProposals) {
          const pending = countPending(workspacePath);
          if (pending > 0) {
            parts.push(
              `<ooda-notice>You have ${pending} pending policy proposal${pending === 1 ? "" : "s"}. Run \`openclaw workspace proposals list --pending\` to review.</ooda-notice>`,
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

        try {
          const triageResult = await runTriage(
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
              const strategyResult = await runStrategy(
                {
                  sitrep,
                  priorities,
                  observation: event.prompt,
                  neverDo: knowledge.preferences.never_do,
                },
                callModel,
              );

              const winner = strategyResult.winner;
              parts.push(
                `<ooda-strategy>Action: ${winner.label} | ${winner.reasoning}</ooda-strategy>`,
              );
              // OODA_DEBUG: show raw strategy output for calibration
              if (process.env.OODA_DEBUG === "true") {
                parts.push(
                  `<ooda-strategy-debug>${JSON.stringify(strategyResult, null, 2)}</ooda-strategy-debug>`,
                );
              }
            } catch (err) {
              api.logger.warn(`memory-ooda: strategy failed, skipping: ${String(err)}`);
            }
          }
        } catch (err) {
          api.logger.warn(`memory-ooda: triage failed, skipping: ${String(err)}`);
        }

        if (parts.length === 0) return;

        return { prependSystemContext: parts.join("\n\n") };
      } catch (err) {
        api.logger.warn(`memory-ooda: failed to inject context: ${String(err)}`);
      }
    });

    // ========================================================================
    // Archivist — async Tier 2 → Tier 3 distillation on agent_end
    // ========================================================================

    let turnCount = 0;
    try {
      turnCount = readState(workspacePath).last_run_turn;
    } catch {
      // Fresh workspace or corrupt state — start from 0
    }

    api.on("agent_end", (event) => {
      if (!event.success) return;

      turnCount++;

      try {
        writeState(workspacePath, {
          last_run_turn: turnCount,
          last_run_at: new Date().toISOString(),
        });
      } catch (err) {
        api.logger.warn(`memory-ooda: failed to persist turn count: ${String(err)}`);
      }

      // Check if archivist is due
      let turnInterval: number;
      try {
        turnInterval = getPriorities(workspacePath).thresholds.archivist_turn_interval;
      } catch {
        turnInterval = 100;
      }

      const state = { last_run_turn: turnCount - 1, last_run_at: new Date().toISOString() };
      try {
        Object.assign(state, readState(workspacePath));
      } catch {
        // use defaults
      }

      if (!shouldRunArchivist(turnCount, state, turnInterval)) return;

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
          } catch (err) {
            api.logger.warn(`memory-ooda: archivist failed: ${String(err)}`);
          }
        })();
      });
    });

    // ========================================================================
    // CLI Commands
    // ========================================================================

    api.registerCli(
      ({ program }) => {
        registerWorkspaceCli(program, workspacePath);
      },
      { commands: ["workspace"] },
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
