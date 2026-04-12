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
  WorldModelStore,
  BOOTSTRAP_PROMPT,
  renderWorldModelSection,
  renderSuggestions,
  type ProjectState,
  type AreaState,
} from "../memory-lancedb/world-model-store.js";
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
import {
  pingHealth,
  pingHealthError,
  buildDoctorReport,
  renderDoctorReport,
  buildHealthAlert,
  isHealthy,
  healthPath,
} from "./health.js";
import { runMetaReviewer, type PrioritiesStore, type ProposalStore } from "./meta-reviewer.js";
import { getPriorities, updateDomainWeight } from "./priorities.js";
import { countPending, getProposals, addProposal } from "./proposals.js";
import { Reflect, renderReflectNotification } from "./reflect.js";
import {
  getFacts,
  formatFactsForContext,
  upsertFact,
  appendArchivistLog,
} from "./semantic-memory.js";
import { appendSitrepLog } from "./sitrep-log.js";
import { SlowClarify, type InboxDb, type InboxItem } from "./slow-clarify.js";
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
           WHERE createdAt > ? AND archivistProcessed = 0
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

    async store(event: Omit<EpisodicEvent, "id" | "createdAt" | "archivistProcessed">) {
      const { randomUUID } = await import("node:crypto");
      db.prepare(
        `INSERT INTO memories (id, text, importance, category, createdAt, source, actionId, archivistProcessed)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      ).run(
        randomUUID(),
        event.text,
        event.importance,
        event.category,
        Date.now(),
        event.source ?? null,
        event.actionId ?? null,
      );
    },

    async labelOutcome(
      actionId: string,
      label: { outcome: string; observedAt: number; signal: string; detail?: string },
    ) {
      db.prepare(
        "UPDATE memories SET outcome = ?, outcomeSignal = ?, outcomeAt = ? WHERE actionId = ?",
      ).run(label.outcome, label.signal, label.observedAt, actionId);
    },

    async findRecentWithActionId(limit = 5): Promise<EpisodicEvent[]> {
      const rows = db
        .prepare(
          "SELECT id, text, category, importance, createdAt, source, actionId, archivistProcessed, outcome, outcomeSignal, outcomeAt FROM memories WHERE actionId IS NOT NULL AND actionId != '' ORDER BY createdAt DESC LIMIT ?",
        )
        .all(limit) as Array<Record<string, unknown>>;

      return rows.map((row) => ({
        id: row.id as string,
        text: row.text as string,
        category: row.category as string,
        importance: row.importance as number,
        createdAt: row.createdAt as number,
        source: (row.source as string) || undefined,
        actionId: (row.actionId as string) || undefined,
        archivistProcessed: row.archivistProcessed === 1 || row.archivistProcessed === true,
        outcome: (row.outcome as string) || undefined,
        outcomeSignal: (row.outcomeSignal as string) || undefined,
        outcomeAt: (row.outcomeAt as number) || undefined,
      })) as EpisodicEvent[];
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

      async store(event: Omit<EpisodicEvent, "id" | "createdAt" | "archivistProcessed">) {
        const { randomUUID } = await import("node:crypto");
        // Determine vector dimension from an existing row
        // eslint-disable-next-line -- lancedb Table typing lacks .filter()
        const sample: Record<string, unknown>[] = await (table as any)
          .filter("id IS NOT NULL")
          .limit(1)
          .toArray();
        const dim = Array.isArray(sample[0]?.vector) ? (sample[0].vector as number[]).length : 384;
        await table.add([
          {
            id: randomUUID(),
            text: event.text,
            vector: new Array(dim).fill(0),
            importance: event.importance,
            category: event.category,
            createdAt: Date.now(),
            source: event.source ?? "",
            actionId: event.actionId ?? "",
            archivistProcessed: false,
            outcome: "",
            outcomeSignal: "",
            outcomeAt: 0,
          },
        ]);
      },

      async labelOutcome(
        actionId: string,
        label: { outcome: string; observedAt: number; signal: string; detail?: string },
      ) {
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(actionId)) return;
        // eslint-disable-next-line -- lancedb Table typing lacks .filter()
        const rows: Record<string, unknown>[] = await (table as any)
          .filter(`actionId = '${actionId}'`)
          .toArray();
        if (rows.length === 0) return;
        const row = rows[0];
        await table.delete(`actionId = '${actionId}'`);
        await table.add([
          {
            ...row,
            outcome: label.outcome,
            outcomeSignal: label.signal,
            outcomeAt: label.observedAt,
          },
        ]);
      },

      async findRecentWithActionId(limit = 5): Promise<EpisodicEvent[]> {
        // eslint-disable-next-line -- lancedb Table typing lacks .filter()
        const rows: Record<string, unknown>[] = await (table as any)
          .filter("actionId != ''")
          .limit(limit * 3)
          .toArray();
        return rows
          .map((row) => ({
            id: row.id as string,
            text: row.text as string,
            category: row.category as string,
            importance: row.importance as number,
            createdAt: row.createdAt as number,
            source: (row.source as string) || undefined,
            actionId: (row.actionId as string) || undefined,
            archivistProcessed: (row.archivistProcessed as boolean) || false,
            outcome: (row.outcome as string) || undefined,
            outcomeSignal: (row.outcomeSignal as string) || undefined,
            outcomeAt: (row.outcomeAt as number) || undefined,
          }))
          .sort((a: EpisodicEvent, b: EpisodicEvent) => b.createdAt - a.createdAt)
          .slice(0, limit);
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
    const debugMode = cfg.debugMode ?? "off";

    if (!enabled) {
      api.logger.info("memory-ooda: disabled via config");
      return;
    }

    api.logger.info(`memory-ooda: registered (workspace: ${workspacePath})`);

    // ========================================================================
    // Shared EpisodicStore — single connection per plugin registration.
    // buildEpisodicStore opens a DatabaseSync (sqlite) connection. Opening
    // multiple connections from the same process against a non-WAL database
    // causes concurrent readers to see empty results. Cache the store after
    // first build so the same connection is reused across all hooks/calls.
    // ========================================================================

    let sharedEpisodicStore: EpisodicStore | null | undefined = undefined; // undefined = not yet built

    async function getEpisodicStore(): Promise<EpisodicStore | null> {
      if (sharedEpisodicStore !== undefined) return sharedEpisodicStore;
      sharedEpisodicStore = await buildEpisodicStore(api);
      // Enable WAL mode on first open so concurrent readers don't block
      if (sharedEpisodicStore) {
        try {
          const dbPath = resolveLanceDbPath(api);
          const { join: pathJoin } = await import("node:path");
          const { DatabaseSync } = await import("node:sqlite");
          const db = new DatabaseSync(pathJoin(dbPath, "memories.sqlite"));
          db.prepare("PRAGMA journal_mode=WAL").run();
          db.close();
          api.logger.info("memory-ooda: sqlite WAL mode enabled");
        } catch {
          /* best-effort */
        }
      }
      return sharedEpisodicStore;
    }

    // ========================================================================
    // Shared callModel helper (subagent pattern)
    // ========================================================================

    // callModel: direct Anthropic HTTP call.
    // Subagent methods are only available during a gateway request context,
    // but the archivist fires in setImmediate after agent_end (outside that
    // context). Direct HTTP avoids all request-scope constraints.
    const callModel: ModelCallFn = async (prompt: string): Promise<string> => {
      // Resolve key: env var first, then auth-profiles.json (where the gateway stores it)
      let apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        try {
          const { join: pjoin } = await import("node:path");
          const { homedir: phome } = await import("node:os");
          const { readFileSync: pread } = await import("node:fs");
          const profilesPath = pjoin(
            phome(),
            ".openclaw",
            "agents",
            "main",
            "agent",
            "auth-profiles.json",
          );
          const profiles = JSON.parse(pread(profilesPath, "utf-8")) as Record<string, unknown>;
          const p = profiles as Record<string, Record<string, Record<string, string>>>;
          const key = p?.profiles?.["anthropic:default"]?.key;
          if (key && key.startsWith("sk-")) apiKey = key;
        } catch {
          /* fallthrough */
        }
      }
      if (!apiKey) {
        throw new Error(
          "No Anthropic API key found (checked ANTHROPIC_API_KEY env + auth-profiles.json)",
        );
      }
      const model = "claude-3-haiku-20240307";

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          system:
            "You are an OODA reasoning agent. Respond with raw JSON only. No explanation, no code fences.",
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => "(unreadable)");
        throw new Error(`Anthropic API error ${response.status}: ${errText.slice(0, 200)}`);
      }

      const data = (await response.json()) as {
        content: Array<{ type: string; text: string }>;
      };
      const textBlock = data.content?.find((b) => b.type === "text");
      if (!textBlock?.text) {
        throw new Error("No text block in Anthropic response");
      }
      return textBlock.text;
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
        // K4: Cross-project AMF-context recall
        // ==================================================================

        try {
          const { isAMFContext } = await import("./cross-project.js");
          if (isAMFContext(event.prompt)) {
            const episodicStore = await getEpisodicStore();
            if (episodicStore) {
              const amfMemories = await episodicStore.retrieveSince(0, 10_000);
              const amfFiltered = amfMemories
                .filter((e) => e.source === "amf_harvester")
                .sort((a, b) => b.createdAt - a.createdAt)
                .slice(0, 5);

              if (amfFiltered.length > 0) {
                const recallLines = amfFiltered.map(
                  (e) => `- ${e.text} (importance: ${e.importance})`,
                );
                parts.push(
                  `<ooda-amf-recall>Cross-project knowledge (AMF pipeline):\n${recallLines.join("\n")}</ooda-amf-recall>`,
                );
              }
            }
          }
        } catch {
          // Best-effort — cross-project recall is supplementary
        }

        // ==================================================================
        // Phase 4: Orient — World Model first, episodic supplementary
        // ==================================================================

        try {
          const worldModelPath = join(homedir(), ".openclaw", "world-model");
          const worldModelStore = new WorldModelStore(worldModelPath);

          if (!worldModelStore.isBootstrapped()) {
            // Inject bootstrap prompt — agent conducts guided conversation
            parts.push(BOOTSTRAP_PROMPT);
          } else {
            const index = worldModelStore.readIndex();
            const incomingLower = event.prompt.toLowerCase();

            // Active projects always relevant; paused only if mentioned
            const activeProjects = index.projects.filter((p) => p.status === "active");
            const pausedMentioned = index.projects.filter(
              (p) => p.status === "paused" && incomingLower.includes(p.name.toLowerCase()),
            );
            const relevantProjectIds = [
              ...activeProjects.map((p) => p.id),
              ...pausedMentioned.map((p) => p.id),
            ];

            // Read full detail for relevant projects (capped at 5 for token budget)
            const projectDetails = relevantProjectIds
              .slice(0, 5)
              .map((p) => worldModelStore.readProject(p))
              .filter((p): p is ProjectState => p !== null);

            const allAreas = worldModelStore.listAreas().filter((a): a is AreaState => a !== null);

            const worldModelSection = renderWorldModelSection(projectDetails, allAreas);
            if (worldModelSection.trim().length > 0) {
              parts.push(worldModelSection);
            }

            // Engineering discipline excerpt (always relevant)
            const engDiscipline = worldModelStore.readReference("engineering-discipline.md");
            if (engDiscipline) {
              const excerpt = engDiscipline.slice(0, 500);
              parts.push(`<ooda-engineering-discipline>${excerpt}</ooda-engineering-discipline>`);
            }

            // Pending suggestions from world model meta (undismissed only)
            const meta = worldModelStore.readMeta();
            const activeSuggestions = meta.pendingProjectSuggestions.filter((s) => !s.dismissedAt);
            if (activeSuggestions.length > 0) {
              const suggestionsSection = renderSuggestions(activeSuggestions);
              if (suggestionsSection) {
                parts.push(suggestionsSection);
              }
            }
          }
        } catch (wmErr) {
          api.logger.warn(`memory-ooda: world model read failed: ${String(wmErr)}`);
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

          // Health ping — triage ran
          pingHealth(workspacePath, "triage", { priority: sitrep.priority });

          // S1: Persist SITREP to daily JSONL log
          try {
            appendSitrepLog(
              workspacePath,
              sitrep,
              ctx?.sessionKey ?? `anon-${Date.now()}`,
              thinkingLevel,
            );
          } catch (logErr) {
            api.logger.warn(`memory-ooda: failed to write sitrep log: ${String(logErr)}`);
          }

          // Format SITREP — attention field bolded at top when present
          const sitrepLines: string[] = [];
          if (sitrep.attention) {
            sitrepLines.push(`**ATTENTION:** ${sitrep.attention}`);
          }
          sitrepLines.push(
            `Priority: ${sitrep.priority}/10 | ${sitrep.summary} | Domains: ${sitrep.recommendedDomains.join(", ") || "none"}`,
          );
          // Phase 1: Append pending project suggestions from topic_tracker
          try {
            const dbPath = resolveLanceDbPath(api);
            const { existsSync } = await import("node:fs");
            const { join: pathJoin } = await import("node:path");
            const sqlitePath = pathJoin(dbPath, "memories.sqlite");
            if (existsSync(sqlitePath)) {
              const { DatabaseSync } = await import("node:sqlite");
              const suggestDb = new DatabaseSync(sqlitePath);
              try {
                const pendingSuggestions = suggestDb
                  .prepare(
                    "SELECT topic_key, sample_text FROM topic_tracker WHERE suggested_at IS NOT NULL AND dismissed_at IS NULL",
                  )
                  .all() as Array<{ topic_key: string; sample_text: string }>;
                if (pendingSuggestions.length > 0) {
                  sitrepLines.push("## Project Suggestions");
                  for (const s of pendingSuggestions) {
                    sitrepLines.push(
                      `- Suggestion: "${s.topic_key}" may warrant a project (based on recent activity). Confirm with user.`,
                    );
                  }
                }
              } finally {
                suggestDb.close();
              }
            }
          } catch (suggestErr) {
            api.logger.warn(
              `memory-ooda: failed to read project suggestions: ${String(suggestErr)}`,
            );
          }

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

              // Health pings — strategy + council
              pingHealth(workspacePath, "strategy", {
                action: winner.label,
                mode: councilResult.mode,
              });
              if (councilResult.mode !== "none") {
                pingHealth(workspacePath, "council", {
                  mode: councilResult.mode,
                  dissent: councilResult.dissent,
                });
              }

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

        // Health ping — before_agent_start fired successfully
        pingHealth(workspacePath, "before_agent_start", {
          triagePriority: triageResult?.sitrep?.priority,
          councilMode: councilResultRef?.mode,
        });

        return {
          prependSystemContext: parts.join("\n\n"),
          ...(oodaSummary ? { prependContext: oodaSummary } : {}),
        };
      } catch (err) {
        api.logger.warn(`memory-ooda: failed to inject context: ${String(err)}`);
        pingHealthError(workspacePath, "before_agent_start", String(err));
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

    api.on("agent_end", (_event, ctx) => {
      // Do NOT gate on event.success. The archivist reads from the episodic
      // store (prior events), not the current turn. A failed turn — e.g. Ollama
      // down, embedding error, prompt error — must not prevent distillation.
      turnCount++;
      // Health ping — agent_end hook is firing (proves loader fix is working)
      pingHealth(workspacePath, "agent_end", { turnCount });

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

      // Fire archivist non-blocking — callModel reads key from auth-profiles.json
      setImmediate(() => {
        void (async () => {
          try {
            const episodicStore = await getEpisodicStore();
            if (!episodicStore) {
              api.logger.warn("memory-ooda: archivist skipped — episodic store unavailable");
              return;
            }
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
            if (result.fromFallback) {
              api.logger.warn(
                `memory-ooda: archivist model failed — will retry. Error: ${result.lastError ?? "unknown"}`,
              );
              pingHealthError(workspacePath, "archivist", result.lastError ?? "model failed");
            } else {
              api.logger.info(
                `memory-ooda: archivist completed — ${result.eventsProcessed} events, ${result.patternsExtracted.length} patterns`,
              );
              pingHealth(workspacePath, "archivist", {
                eventsProcessed: result.eventsProcessed,
                patternsExtracted: result.patternsExtracted.length,
              });
            }
          } catch (err) {
            api.logger.warn(`memory-ooda: archivist failed: ${String(err)}`);
            pingHealthError(workspacePath, "archivist", String(err));
          }
        })();
      });
    });

    // ========================================================================
    // Phase 3: Slow Clarify — background inbox drain on agent_end
    // ========================================================================

    api.on("agent_end", () => {
      setImmediate(() => {
        void (async () => {
          try {
            const dbPath = resolveLanceDbPath(api);
            const { existsSync } = await import("node:fs");
            const { join: pathJoin } = await import("node:path");
            const sqlitePath = pathJoin(dbPath, "memories.sqlite");
            if (!existsSync(sqlitePath)) return;

            const { DatabaseSync } = await import("node:sqlite");
            const db = new DatabaseSync(sqlitePath);

            // Check if inbox table exists
            const tableCheck = db
              .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='inbox'")
              .get() as Record<string, unknown> | undefined;
            if (!tableCheck) {
              db.close();
              return;
            }

            const inboxDb: InboxDb = {
              getUnprocessed(): InboxItem[] {
                return db
                  .prepare("SELECT * FROM inbox WHERE processed = 0 ORDER BY capturedAt ASC")
                  .all() as InboxItem[];
              },
              markProcessed(ids: string[]) {
                if (ids.length === 0) return;
                const placeholders = ids.map(() => "?").join(",");
                db.prepare(`UPDATE inbox SET processed = 1 WHERE id IN (${placeholders})`).run(
                  ...ids,
                );
              },
            };

            const worldModelPath = join(homedir(), ".openclaw", "world-model");
            const worldModelStore = new WorldModelStore(worldModelPath);
            const sc = new SlowClarify(inboxDb, worldModelStore, callModel);

            if (!sc.shouldRun()) {
              db.close();
              return;
            }

            const result = await sc.run();
            db.close();

            if (result.processed > 0) {
              api.logger.info(
                `memory-ooda: slow clarify completed — ${result.processed} items processed, ${result.updated.length} entities updated`,
              );
            }
            // Health ping — slow clarify ran
            pingHealth(workspacePath, "slow_clarify", {
              processed: result.processed,
              updated: result.updated.length,
            });
          } catch (err) {
            api.logger.warn(`memory-ooda: slow clarify failed: ${String(err)}`);
          }
        })();
      });
    });

    // ========================================================================
    // Phase 5: Reflect — periodic world model review on agent_end
    // ========================================================================

    api.on("agent_end", () => {
      setImmediate(() => {
        void (async () => {
          try {
            const worldModelPath = join(homedir(), ".openclaw", "world-model");
            const worldModelStore = new WorldModelStore(worldModelPath);

            if (!worldModelStore.isBootstrapped()) return;

            const episodicStore = await getEpisodicStore();
            if (!episodicStore) return;

            const reflect = new Reflect(worldModelStore, episodicStore, callModel);
            if (!reflect.shouldRun()) return;

            const result = await reflect.run();
            api.logger.info(
              `memory-ooda: reflect completed — ${result.patches.length} patches, ${result.reviewItems.length} review items`,
            );
            // Health ping — reflect ran
            pingHealth(workspacePath, "reflect", {
              patches: result.patches.length,
              reviewItems: result.reviewItems.length,
            });

            // Deliver notification if review items exist
            const notification = renderReflectNotification(result);
            if (notification) {
              api.logger.info(`memory-ooda: reflect notification: ${notification.slice(0, 200)}`);
            }
          } catch (err) {
            api.logger.warn(`memory-ooda: reflect failed: ${String(err)}`);
          }
        })();
      });
    });

    // ========================================================================
    // C3: Structural Event Capture via after_tool_call
    // ========================================================================

    // Noisy tools to skip for structural capture — these fire constantly and add no structural signal
    // Note: "exec" is handled specially for outcome signal detection (O2)
    const NOISY_TOOLS = new Set(["read", "process", "web_search", "web_fetch", "image"]);

    // O2: Outcome signal patterns
    const POSITIVE_EXEC_SIGNALS = [
      /tests? pass(ed|ing)?/i,
      /BUILD SUCCESS/i,
      /all \d+ tests/i,
      /0 fail(ure|ed|ing)?s?\b/i,
      /✓|✔|passed/i,
    ];
    const NEGATIVE_EXEC_SIGNALS = [
      /FAIL(ED|URE|ING)?/i,
      /ERR(OR)?[\s:]/i,
      /exit code [1-9]/i,
      /non-zero exit/i,
      /command failed/i,
    ];

    function detectOutcomeSignal(
      toolName: string,
      params: Record<string, unknown>,
      error: string | undefined,
      result: string | undefined,
    ): { outcome: "success" | "failure"; signal: string; detail: string } | null {
      // exec tool: check output for test/build signals
      if (toolName === "exec") {
        const output = result ?? error ?? "";
        if (!output) return null;

        for (const pat of POSITIVE_EXEC_SIGNALS) {
          if (pat.test(output)) {
            return {
              outcome: "success",
              signal: /build/i.test(output) ? "build_passed" : "test_passed",
              detail: output.slice(0, 200),
            };
          }
        }
        // Only count as failure if there's a non-zero exit or explicit FAIL
        if (error) {
          for (const pat of NEGATIVE_EXEC_SIGNALS) {
            if (pat.test(output)) {
              return {
                outcome: "failure",
                signal: /build/i.test(output) ? "build_failed" : "runtime_error",
                detail: output.slice(0, 200),
              };
            }
          }
        }
      }

      // gateway tool: restart outcome
      if (toolName === "gateway") {
        const action = params.action as string | undefined;
        if (action === "restart" || action === "config.apply") {
          if (error) {
            return { outcome: "failure", signal: "gateway_error", detail: error.slice(0, 200) };
          }
          return {
            outcome: "success",
            signal: "gateway_ok",
            detail: `gateway ${action} succeeded`,
          };
        }
      }

      // cron completion
      if (toolName === "cron") {
        const action = params.action as string | undefined;
        if (action === "complete" || action === "done") {
          return { outcome: "success", signal: "cron_completed", detail: `cron task completed` };
        }
      }

      return null;
    }

    // Lazy-init episodic store for writing structural events
    let structuralStore: EpisodicStore | null | undefined;
    async function getStructuralStore(): Promise<EpisodicStore | null> {
      if (structuralStore !== undefined) return structuralStore;
      structuralStore = await getEpisodicStore();
      return structuralStore;
    }

    type StructuralEventType = {
      category: string;
      text: string;
      importance: number;
    };

    function classifyToolCall(
      toolName: string,
      params: Record<string, unknown>,
      error: string | undefined,
    ): StructuralEventType | null {
      // Tool errors at high importance
      if (error) {
        return {
          category: "structural_event",
          text: `tool_error: ${toolName} failed — ${String(error).slice(0, 200)}`,
          importance: 0.8,
        };
      }

      // Gateway config/restart actions
      if (toolName === "gateway") {
        const action = params.action as string | undefined;
        if (action === "config.apply" || action === "config.patch" || action === "restart") {
          return {
            category: "structural_event",
            text: `config_change: gateway ${action}${params.key ? ` key=${params.key}` : ""}`,
            importance: 0.7,
          };
        }
      }

      // Writes to cr/ or docs/ paths
      if (toolName === "write" || toolName === "edit") {
        const filePath = (params.path ?? params.file_path ?? params.filePath ?? "") as string;

        // M5: Prompt mutation tracking — write/edit touching memory-ooda/*.ts
        if (
          /extensions\/memory-ooda\/[^/]+\.ts$/.test(filePath) ||
          /extensions[/\\]memory-ooda[/\\][^/\\]+\.ts$/.test(filePath)
        ) {
          return {
            category: "structural_event",
            text: `prompt_mutation: ${toolName} ${filePath}`,
            importance: 0.8,
          };
        }

        if (/^(cr|docs)\//.test(filePath) || /\/(cr|docs)\//.test(filePath)) {
          return {
            category: "structural_event",
            text: `knowledge_write: ${toolName} ${filePath}`,
            importance: 0.7,
          };
        }
      }

      // Cron add/remove
      if (toolName === "cron") {
        const action = params.action as string | undefined;
        if (action === "add" || action === "remove" || action === "delete") {
          const name = (params.name ?? params.id ?? "") as string;
          return {
            category: "structural_event",
            text: `schedule_change: cron ${action}${name ? ` "${name}"` : ""}`,
            importance: 0.7,
          };
        }
      }

      return null;
    }

    api.on("after_tool_call", async (event) => {
      try {
        const store = await getStructuralStore();

        // O2: Outcome signal detection — applies even to exec (which is noisy for structural)
        const resultText =
          typeof (event as Record<string, unknown>).result === "string"
            ? ((event as Record<string, unknown>).result as string)
            : typeof (event as Record<string, unknown>).output === "string"
              ? ((event as Record<string, unknown>).output as string)
              : undefined;

        const outcomeSignal = detectOutcomeSignal(
          event.toolName,
          event.params,
          event.error,
          resultText,
        );

        if (outcomeSignal && store?.findRecentWithActionId && store.labelOutcome) {
          try {
            const recentDecisions = await store.findRecentWithActionId(1);
            // Only label decisions that haven't already been labeled
            const unlabeled = recentDecisions.find((d) => !d.outcome && d.actionId);
            if (unlabeled?.actionId) {
              await store.labelOutcome(unlabeled.actionId, {
                outcome: outcomeSignal.outcome,
                observedAt: Date.now(),
                signal: outcomeSignal.signal,
                detail: outcomeSignal.detail,
              });
            }
          } catch (err) {
            api.logger.warn(`memory-ooda: outcome labeling failed: ${String(err)}`);
          }
        }

        // Structural capture — skip noisy tools (exec handled above for outcomes only)
        if (NOISY_TOOLS.has(event.toolName) || event.toolName === "exec") return;

        const classified = classifyToolCall(event.toolName, event.params, event.error);
        if (!classified) return;

        if (!store?.store) return;

        await store.store({
          text: classified.text,
          category: classified.category,
          importance: classified.importance,
          source: "structural",
        });

        // Phase 5: Increment eventsSinceLastReflect for significant events
        if (classified.importance >= 0.6 || classified.category === "decision") {
          try {
            const wmPath = join(homedir(), ".openclaw", "world-model");
            const wmStore = new WorldModelStore(wmPath);
            const meta = wmStore.readMeta();
            wmStore.writeMeta({
              ...meta,
              eventsSinceLastReflect: (meta.eventsSinceLastReflect ?? 0) + 1,
            });
          } catch {
            // best-effort — don't block structural capture on reflect counter
          }
        }
      } catch (err) {
        api.logger.warn(`memory-ooda: structural capture failed: ${String(err)}`);
      }
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

        // OODA Doctor
        const ooda = program.command("ooda").description("OODA cognitive layer tools");
        ooda
          .command("doctor")
          .description("Health check — reports subsystem status and detects silent failures")
          .option("--json", "Output raw JSON instead of formatted report")
          .option("--alert-only", "Only output if there are warnings or errors")
          .action(async (opts: { json?: boolean; alertOnly?: boolean }) => {
            let archivistState:
              | { turnsSinceLast: number; interval: number; lastRunAt: string }
              | undefined;
            try {
              const state = readState(workspacePath);
              let interval = 15;
              try {
                interval = getPriorities(workspacePath).thresholds.archivist_turn_interval;
              } catch {
                /* default */
              }
              archivistState = {
                turnsSinceLast: state.turns_since_last_archivist,
                interval,
                lastRunAt: state.last_run_at,
              };
            } catch {
              /* best-effort */
            }

            let episodicStats: { total: number; processed: number } | undefined;
            try {
              const { existsSync } = await import("node:fs");
              const { join: pathJoin } = await import("node:path");
              const dbPath = resolveLanceDbPath(api);
              const sqlitePath = pathJoin(dbPath, "memories.sqlite");
              if (existsSync(sqlitePath)) {
                const { DatabaseSync } = await import("node:sqlite");
                const db = new DatabaseSync(sqlitePath);
                const row = db
                  .prepare(
                    "SELECT COUNT(*) as total, SUM(archivistProcessed) as processed FROM memories",
                  )
                  .get() as Record<string, unknown>;
                db.close();
                episodicStats = {
                  total: Number(row.total ?? 0),
                  processed: Number(row.processed ?? 0),
                };
              }
            } catch {
              /* best-effort */
            }

            const report = buildDoctorReport(workspacePath, archivistState, episodicStats);
            if (opts.json) {
              console.log(JSON.stringify(report, null, 2));
              return;
            }
            if (opts.alertOnly && isHealthy(report)) return;
            console.log(renderDoctorReport(report));
          });
      },
      { commands: ["workspace", "tasks", "ooda"] },
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
