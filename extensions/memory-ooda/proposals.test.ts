import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addProposal,
  countPending,
  getPendingProposals,
  getProposals,
  proposalsPath,
  updateProposalStatus,
} from "./proposals.js";
import type { PolicyProposal } from "./types.js";

// ============================================================================
// Fixtures
// ============================================================================

function createTestProposal(overrides?: Partial<PolicyProposal>): Omit<PolicyProposal, "status"> {
  return {
    id: "prop-001",
    timestamp: "2026-03-16T12:00:00Z",
    rule: "always_ask_before_delete",
    proposal: "Relax delete confirmation for temp files",
    reasoning: "User never rejected temp file deletions in 50 observations",
    evidence: ["action-001", "action-002", "action-003"],
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("proposals", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-proposals-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("getProposals", () => {
    it("returns empty array when file does not exist", () => {
      expect(getProposals(tmpDir)).toEqual([]);
    });

    it("reads existing proposals", () => {
      const proposals: PolicyProposal[] = [{ ...createTestProposal(), status: "pending" }];
      fs.writeFileSync(proposalsPath(tmpDir), JSON.stringify(proposals));

      const result = getProposals(tmpDir);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("prop-001");
    });

    it("throws on malformed JSON", () => {
      fs.writeFileSync(proposalsPath(tmpDir), "not json");
      expect(() => getProposals(tmpDir)).toThrow();
    });

    it("throws on non-array JSON", () => {
      fs.writeFileSync(proposalsPath(tmpDir), '{"not": "array"}');
      expect(() => getProposals(tmpDir)).toThrow("expected an array");
    });
  });

  describe("addProposal", () => {
    it("creates file and adds proposal with pending status", () => {
      const proposal = addProposal(tmpDir, createTestProposal());

      expect(proposal.status).toBe("pending");
      expect(proposal.id).toBe("prop-001");

      const stored = getProposals(tmpDir);
      expect(stored).toHaveLength(1);
      expect(stored[0].status).toBe("pending");
    });

    it("appends to existing proposals", () => {
      addProposal(tmpDir, createTestProposal({ id: "prop-001" }));
      addProposal(tmpDir, createTestProposal({ id: "prop-002" }));

      const stored = getProposals(tmpDir);
      expect(stored).toHaveLength(2);
      expect(stored[0].id).toBe("prop-001");
      expect(stored[1].id).toBe("prop-002");
    });

    it("creates parent directories if needed", () => {
      const deepPath = path.join(tmpDir, "deep", "nested");
      addProposal(deepPath, createTestProposal());
      expect(fs.existsSync(proposalsPath(deepPath))).toBe(true);
    });
  });

  describe("getPendingProposals", () => {
    it("returns only pending proposals", () => {
      addProposal(tmpDir, createTestProposal({ id: "prop-001" }));
      addProposal(tmpDir, createTestProposal({ id: "prop-002" }));
      updateProposalStatus(tmpDir, "prop-001", "approved");

      const pending = getPendingProposals(tmpDir);
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe("prop-002");
    });

    it("returns empty when no pending proposals", () => {
      addProposal(tmpDir, createTestProposal({ id: "prop-001" }));
      updateProposalStatus(tmpDir, "prop-001", "rejected");

      expect(getPendingProposals(tmpDir)).toHaveLength(0);
    });
  });

  describe("updateProposalStatus", () => {
    it("updates status to approved", () => {
      addProposal(tmpDir, createTestProposal({ id: "prop-001" }));
      const result = updateProposalStatus(tmpDir, "prop-001", "approved");

      expect(result).not.toBeNull();
      expect(result!.status).toBe("approved");

      const stored = getProposals(tmpDir);
      expect(stored[0].status).toBe("approved");
    });

    it("updates status to rejected", () => {
      addProposal(tmpDir, createTestProposal({ id: "prop-001" }));
      const result = updateProposalStatus(tmpDir, "prop-001", "rejected");

      expect(result).not.toBeNull();
      expect(result!.status).toBe("rejected");
    });

    it("returns null for non-existent proposal", () => {
      addProposal(tmpDir, createTestProposal({ id: "prop-001" }));
      const result = updateProposalStatus(tmpDir, "nonexistent", "approved");
      expect(result).toBeNull();
    });
  });

  describe("countPending", () => {
    it("returns 0 when no proposals exist", () => {
      expect(countPending(tmpDir)).toBe(0);
    });

    it("counts only pending proposals", () => {
      addProposal(tmpDir, createTestProposal({ id: "prop-001" }));
      addProposal(tmpDir, createTestProposal({ id: "prop-002" }));
      addProposal(tmpDir, createTestProposal({ id: "prop-003" }));
      updateProposalStatus(tmpDir, "prop-001", "approved");

      expect(countPending(tmpDir)).toBe(2);
    });
  });
});
