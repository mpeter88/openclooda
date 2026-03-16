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
import { registerWorkspaceCli } from "./cli.js";
import { getPriorities } from "./priorities.js";
import { countPending } from "./proposals.js";
import { getFacts, formatFactsForContext } from "./semantic-memory.js";

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
// Plugin
// ============================================================================

const oodaPlugin = {
  id: "memory-ooda",
  name: "Memory (OODA)",
  description: "Cognitive OODA agent — Tier 3 semantic memory with knowledge injection",
  kind: "memory" as const,

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
    // Context Injection
    // ========================================================================

    api.on("before_agent_start", (_event) => {
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

        if (parts.length === 0) return;

        return { prependSystemContext: parts.join("\n\n") };
      } catch (err) {
        api.logger.warn(`memory-ooda: failed to inject context: ${String(err)}`);
      }
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
