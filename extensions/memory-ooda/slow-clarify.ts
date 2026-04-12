/**
 * OODA Phase 3 — Slow Clarify
 *
 * Background worker that drains the inbox into the world model.
 * Groups unprocessed inbox items by project/area, calls LLM per group
 * to generate patches, applies them to WorldModelStore, handles reference
 * items, detects milestone transitions, and marks items processed.
 */

import type { WorldModelStore, WorldModelMeta } from "../memory-lancedb/world-model-store.js";
import { stripCodeFences } from "./parse-utils.js";
import type { ModelCallFn } from "./triage.js";

// ============================================================================
// Types
// ============================================================================

export interface InboxItem {
  id: string;
  capturedAt: number;
  sessionId: string;
  text: string;
  type: "project" | "area" | "reference" | "trash" | "someday";
  pertiansTo: string | null;
  nextTouchpoint: "now" | "today" | "this_week" | "someday" | null;
  processed: number;
}

/** Abstraction over the inbox SQLite database for testability. */
export interface InboxDb {
  getUnprocessed(): InboxItem[];
  markProcessed(ids: string[]): void;
}

export interface SlowClarifyResult {
  processed: number;
  updated: string[];
  errors: string[];
}

// ============================================================================
// Constants
// ============================================================================

const MAX_ITEMS_PER_GROUP = 10;
const MAX_GROUPS_PER_RUN = 5;
const INBOX_THRESHOLD = 5;
const TIME_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

// ============================================================================
// Milestone Detection
// ============================================================================

const MILESTONE_KEYWORDS = [
  "verified",
  "parity ≥",
  "parity >=",
  "certified",
  "milestone complete",
  "all tests pass",
];

function detectMilestoneSignal(items: InboxItem[]): boolean {
  return items.some((item) => {
    const lower = item.text.toLowerCase();
    return MILESTONE_KEYWORDS.some((kw) => lower.includes(kw));
  });
}

// ============================================================================
// SlowClarify
// ============================================================================

export class SlowClarify {
  constructor(
    private readonly inboxDb: InboxDb,
    private readonly store: WorldModelStore,
    private readonly callLLM: ModelCallFn,
  ) {}

  shouldRun(): boolean {
    const items = this.inboxDb.getUnprocessed();
    if (items.length === 0) return false;
    if (items.length >= INBOX_THRESHOLD) return true;

    const meta = this.store.readMeta();
    const elapsed = Date.now() - (meta.lastSlowClarify ?? 0);
    return elapsed > TIME_THRESHOLD_MS;
  }

  async run(): Promise<SlowClarifyResult> {
    const items = this.inboxDb.getUnprocessed();
    if (items.length === 0) {
      return { processed: 0, updated: [], errors: [] };
    }

    // Group by pertiansTo
    const groups = new Map<string, InboxItem[]>();
    for (const item of items) {
      const key = item.pertiansTo ?? "__unattached__";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(item);
    }

    const updated: string[] = [];
    const errors: string[] = [];
    const processedIds: string[] = [];
    let groupsProcessed = 0;

    for (const [key, groupItems] of groups) {
      if (groupsProcessed >= MAX_GROUPS_PER_RUN) break;

      // Reference items handled separately
      const referenceItems = groupItems.filter((i) => i.type === "reference");
      const nonReferenceItems = groupItems.filter((i) => i.type !== "reference");

      // Process reference items
      if (referenceItems.length > 0) {
        try {
          this.processReferenceItems(referenceItems, key);
          processedIds.push(...referenceItems.map((i) => i.id));
        } catch (err) {
          errors.push(`reference:${key}: ${String(err)}`);
          // Mark as processed anyway to avoid reprocessing
          processedIds.push(...referenceItems.map((i) => i.id));
        }
      }

      if (key === "__unattached__") {
        // Unattached items — mark processed, file as reference
        for (const item of nonReferenceItems) {
          try {
            this.processReferenceItems([item], "__unattached__");
          } catch {
            // best-effort
          }
          processedIds.push(item.id);
        }
        groupsProcessed++;
        continue;
      }

      if (nonReferenceItems.length === 0) {
        groupsProcessed++;
        continue;
      }

      // Process non-reference items for this project/area in batches
      const batches = [];
      for (let i = 0; i < nonReferenceItems.length; i += MAX_ITEMS_PER_GROUP) {
        batches.push(nonReferenceItems.slice(i, i + MAX_ITEMS_PER_GROUP));
      }

      for (const batch of batches) {
        try {
          const result = await this.processGroup(key, batch);
          if (result) {
            updated.push(key);
          }
          processedIds.push(...batch.map((i) => i.id));
        } catch (err) {
          errors.push(`${key}: ${String(err)}`);
          // Mark as processed to avoid infinite retry
          processedIds.push(...batch.map((i) => i.id));
        }
      }

      groupsProcessed++;
    }

    // Mark all processed
    if (processedIds.length > 0) {
      this.inboxDb.markProcessed(processedIds);
    }

    // Update meta
    const meta = this.store.readMeta();
    this.store.writeMeta({
      ...meta,
      lastSlowClarify: Date.now(),
    });

    return { processed: processedIds.length, updated, errors };
  }

  private async processGroup(projectId: string, items: InboxItem[]): Promise<boolean> {
    // Try to read as project first, then as area
    const project = this.store.readProject(projectId);
    const area = project ? null : this.store.readArea(projectId);
    const currentState = project ?? area;

    if (!currentState) {
      // Unknown target — treat as reference
      this.processReferenceItems(items, projectId);
      return false;
    }

    const prompt = `Current state of "${currentState.name}":
${JSON.stringify(currentState, null, 2)}

New observations (in chronological order):
${items.map((item, i) => `${i + 1}. [${item.type}] ${item.text}`).join("\n")}

Review these observations. Update the state to reflect what changed.
Return a JSON patch — only include fields that genuinely changed based on the observations.
Do not invent changes not evidenced in the observations.

Valid patch fields for projects: milestone, milestoneBlocking, nextAction, openCRs, lastRun, status
Valid patch fields for areas: currentStatus

Return JSON only:
{
  "patch": { ...only changed fields... },
  "summary": "one sentence describing what changed"
}`;

    const raw = await this.callLLM(prompt);
    const cleaned = stripCodeFences(raw);
    const { patch, summary } = JSON.parse(cleaned);

    if (!patch || typeof patch !== "object" || Object.keys(patch).length === 0) {
      return false;
    }

    // Apply patch
    if (project) {
      this.store.patchProject(projectId, { ...patch, updatedAt: Date.now() });

      // Milestone transition detection
      if (detectMilestoneSignal(items) && project.milestone !== patch.milestone) {
        const meta = this.store.readMeta();
        this.store.writeMeta({
          ...meta,
          pendingProjectSuggestions: [
            ...meta.pendingProjectSuggestions,
            {
              topicKey: `milestone-transition:${project.id}`,
              sampleText: `"${project.milestone}" may be complete — suggest transitioning to next milestone. ${summary ?? ""}`,
              suggestedAt: Date.now(),
            },
          ],
        });
      }
    } else if (area) {
      this.store.patchArea(projectId, { ...patch, updatedAt: Date.now() });
    }

    return true;
  }

  private processReferenceItems(items: InboxItem[], key: string): void {
    const filename = key !== "__unattached__" ? `${key}-decisions.md` : "general-reference.md";

    const existing = this.store.readReference(filename) ?? "";
    const entries = items
      .map(
        (item) => `\n## ${new Date(item.capturedAt).toISOString().split("T")[0]}\n\n${item.text}\n`,
      )
      .join("");

    this.store.writeReference(filename, filename.replace(".md", ""), existing + entries);
  }
}
