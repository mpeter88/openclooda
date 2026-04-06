#!/usr/bin/env bun
/**
 * M1: Weekly Meta-Review Script
 *
 * Runs the full meta-review analysis against the last 30 days of episodic
 * memories, KNOWLEDGE.json, and proposal history. Writes a structured report
 * to `meta-review/YYYY-MM-DD.md` in the workspace.
 *
 * Usage:
 *   bun scripts/meta-review.ts [--workspace <path>] [--window-days <n>] [--create-proposals]
 *
 * Schedule: weekly (Sunday 23:00) or on-demand via CLI.
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { EpisodicEvent, EpisodicStore } from "../extensions/memory-ooda/archivist.js";
import { runWeeklyMetaReview } from "../extensions/memory-ooda/meta-reviewer.js";
import type { ProposalStore } from "../extensions/memory-ooda/meta-reviewer.js";
import { getProposals, addProposal } from "../extensions/memory-ooda/proposals.js";
import { getFacts } from "../extensions/memory-ooda/semantic-memory.js";
import type { PolicyProposal } from "../extensions/memory-ooda/types.js";

// ============================================================================
// CLI Argument Parsing
// ============================================================================

const { values } = parseArgs({
  options: {
    workspace: { type: "string", short: "w" },
    "window-days": { type: "string", short: "d" },
    "create-proposals": { type: "boolean", short: "p", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: false,
});

if (values.help) {
  console.log(`Usage: bun scripts/meta-review.ts [options]

Options:
  -w, --workspace <path>    OODA workspace path (default: ~/.openclaw/workspace)
  -d, --window-days <n>     Days of history to analyze (default: 30)
  -p, --create-proposals    Convert recommended actions to proposals
  -h, --help                Show this help
`);
  process.exit(0);
}

const workspacePath = (values.workspace as string) ?? join(homedir(), ".openclaw", "workspace");
const windowDays = values["window-days"] ? Number(values["window-days"]) : 30;
const createProposals = (values["create-proposals"] as boolean) ?? false;

// ============================================================================
// Build Episodic Store (read-only, from sqlite)
// ============================================================================

async function buildReadOnlyStore(dbPath: string): Promise<EpisodicStore> {
  const { DatabaseSync } = await import("node:sqlite");
  const sqlitePath = join(dbPath, "memories.sqlite");

  if (!existsSync(sqlitePath)) {
    console.error(`No episodic database found at ${sqlitePath}`);
    process.exit(1);
  }

  const db = new DatabaseSync(sqlitePath);

  return {
    async retrieveSince(sinceTimestamp: number, limit?: number): Promise<EpisodicEvent[]> {
      const maxRows = limit ?? 10_000;
      const rows = db
        .prepare(
          `SELECT id, text, importance, category, createdAt, source, actionId,
                  archivistProcessed, outcome, outcomeSignal, outcomeAt
           FROM memories
           WHERE createdAt >= ?
           ORDER BY createdAt DESC
           LIMIT ?`,
        )
        .all(sinceTimestamp, maxRows) as Array<Record<string, unknown>>;

      return rows.map((r) => ({
        id: r.id as string,
        text: r.text as string,
        importance: r.importance as number,
        category: r.category as string,
        createdAt: r.createdAt as number,
        source: r.source as string | undefined,
        actionId: r.actionId as string | undefined,
        archivistProcessed: (r.archivistProcessed as number) === 1,
        outcome: r.outcome as EpisodicEvent["outcome"],
        outcomeSignal: r.outcomeSignal as string | undefined,
        outcomeAt: r.outcomeAt as number | undefined,
      }));
    },
    async markProcessed() {
      /* read-only */
    },
    async prune() {
      return 0; /* read-only */
    },
  };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log(`Meta-Review: analyzing last ${windowDays} days from ${workspacePath}`);

  mkdirSync(workspacePath, { recursive: true });

  const episodicStore = await buildReadOnlyStore(workspacePath);
  const knowledge = getFacts(workspacePath);
  const proposals = getProposals(workspacePath);

  const proposalStore: ProposalStore | null = createProposals
    ? {
        addProposal: (p: Omit<PolicyProposal, "status">) => addProposal(workspacePath, p),
      }
    : null;

  const result = await runWeeklyMetaReview(
    workspacePath,
    episodicStore,
    knowledge,
    proposals,
    proposalStore,
    { windowDays, createProposals },
  );

  console.log(`\nReport written to: ${result.reportPath}`);
  console.log(`  Domain audits: ${result.domainAudits.length}`);
  console.log(`  Knowledge gaps: ${result.knowledgeGaps.length}`);
  console.log(`  Prompt mutations: ${result.promptMutations}`);
  console.log(`  SITREP drift days: ${result.sitrepDrift.length}`);
  console.log(`  Recommended actions: ${result.recommendedActions.length}`);

  if (result.recommendedActions.length > 0) {
    console.log("\nRecommended Actions:");
    for (const action of result.recommendedActions) {
      console.log(`  - ${action}`);
    }
  }
}

main().catch((err) => {
  console.error("Meta-review failed:", err);
  process.exit(1);
});
