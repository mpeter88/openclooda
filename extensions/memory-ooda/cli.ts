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

import {
  countPending,
  getPendingProposals,
  getProposals,
  updateProposalStatus,
} from "./proposals.js";
import { listSnapshots, restoreLatestSnapshot } from "./snapshot.js";

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
}
