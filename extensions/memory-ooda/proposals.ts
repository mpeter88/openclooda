/**
 * Policy Proposal Storage
 *
 * Manages `.policy-proposals.json` — the append-only store for
 * Meta-Reviewer suggestions that require user approval before
 * modifying SOUL.md or other policy files.
 *
 * The Meta-Reviewer never auto-updates SOUL.md.
 */

import fs from "node:fs";
import path from "node:path";
import type { PolicyProposal } from "./types.js";

const PROPOSALS_FILENAME = ".policy-proposals.json";

// ============================================================================
// Path Resolution
// ============================================================================

export function proposalsPath(workspacePath: string): string {
  return path.join(workspacePath, PROPOSALS_FILENAME);
}

// ============================================================================
// Read / Write
// ============================================================================

/**
 * Read all policy proposals from disk.
 * Returns an empty array if the file doesn't exist.
 */
export function getProposals(workspacePath: string): PolicyProposal[] {
  const filePath = proposalsPath(workspacePath);

  if (!fs.existsSync(filePath)) {
    return [];
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error("Invalid .policy-proposals.json: expected an array");
  }

  return parsed as PolicyProposal[];
}

/**
 * Write proposals to disk, replacing the current file.
 */
function writeProposals(workspacePath: string, proposals: PolicyProposal[]): void {
  const filePath = proposalsPath(workspacePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(proposals, null, 2) + "\n", "utf-8");
}

// ============================================================================
// Operations
// ============================================================================

/**
 * Append a new policy proposal. Returns the full proposal object.
 */
export function addProposal(
  workspacePath: string,
  proposal: Omit<PolicyProposal, "status">,
): PolicyProposal {
  const proposals = getProposals(workspacePath);

  const full: PolicyProposal = {
    ...proposal,
    status: "pending",
  };

  proposals.push(full);
  writeProposals(workspacePath, proposals);
  return full;
}

/**
 * Get all pending proposals.
 */
export function getPendingProposals(workspacePath: string): PolicyProposal[] {
  return getProposals(workspacePath).filter((p) => p.status === "pending");
}

/**
 * Update the status of a proposal by ID.
 * Returns the updated proposal or null if not found.
 */
export function updateProposalStatus(
  workspacePath: string,
  proposalId: string,
  status: "approved" | "rejected",
): PolicyProposal | null {
  const proposals = getProposals(workspacePath);
  const proposal = proposals.find((p) => p.id === proposalId);

  if (!proposal) return null;

  proposal.status = status;
  writeProposals(workspacePath, proposals);
  return proposal;
}

/**
 * Count pending proposals (for preamble notification).
 */
export function countPending(workspacePath: string): number {
  return getPendingProposals(workspacePath).length;
}
