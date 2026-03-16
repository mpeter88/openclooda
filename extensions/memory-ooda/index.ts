/**
 * OpenClaw Memory (OODA) Plugin
 *
 * Tier 3 semantic memory for the Cognitive OODA Agent.
 * Injects distilled KNOWLEDGE.json facts into the agent's system context
 * via the before_agent_start lifecycle hook.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/memory-ooda";
import { getFacts, formatFactsForContext } from "./semantic-memory.js";

type OodaConfig = {
  workspacePath?: string;
};

function resolveWorkspacePath(cfg: OodaConfig): string {
  return cfg.workspacePath || join(homedir(), ".openclaw", "workspace");
}

const oodaPlugin = {
  id: "memory-ooda",
  name: "Memory (OODA)",
  description: "Cognitive OODA agent — Tier 3 semantic memory with knowledge injection",
  kind: "memory" as const,

  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as OodaConfig;
    const workspacePath = resolveWorkspacePath(cfg);

    api.logger.info(`memory-ooda: registered (workspace: ${workspacePath})`);

    // Inject KNOWLEDGE.json facts into the agent's system context.
    // Uses prependSystemContext for cache-friendly static injection —
    // facts change infrequently (only via Archivist cron, not per-turn).
    api.on("before_agent_start", (_event) => {
      try {
        const knowledge = getFacts(workspacePath);
        const context = formatFactsForContext(knowledge);

        if (!context) return;

        return { prependSystemContext: context };
      } catch (err) {
        api.logger.warn(`memory-ooda: failed to inject facts: ${String(err)}`);
      }
    });

    // Register service for lifecycle management
    api.registerService({
      id: "memory-ooda",
      start: () => {
        // Ensure KNOWLEDGE.json template exists on startup
        getFacts(workspacePath);
        api.logger.info(`memory-ooda: initialized (workspace: ${workspacePath})`);
      },
      stop: () => {
        api.logger.info("memory-ooda: stopped");
      },
    });
  },
};

export default oodaPlugin;
