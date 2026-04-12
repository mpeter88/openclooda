/**
 * OODA Phase 5 — Reflect
 *
 * Periodic strategic review of the world model against recent episodic events.
 * Detects staleness, contradictions, missed transitions. Fires at 50+ significant
 * events or 7+ days since last Reflect. Produces patches, new reference entries,
 * and review items with optional notifications.
 */

import type {
  WorldModelStore,
  ProjectState,
  AreaState,
} from "../memory-lancedb/world-model-store.js";
import type { EpisodicStore, EpisodicEvent } from "./archivist.js";
import { stripCodeFences } from "./parse-utils.js";
import type { ModelCallFn } from "./triage.js";

// ============================================================================
// Types
// ============================================================================

export interface ReflectPatch {
  type: "project" | "area";
  id: string;
  patch: Record<string, unknown>;
  reason: string;
}

export interface ReflectReferenceEntry {
  filename: string;
  title: string;
  content: string;
}

export interface ReflectReviewItem {
  severity: "high" | "medium" | "low";
  message: string;
  actionRequired: boolean;
}

export interface ReflectResult {
  patches: ReflectPatch[];
  newReferenceEntries: ReflectReferenceEntry[];
  reviewItems: ReflectReviewItem[];
  summary: string;
  fromFallback: boolean;
  lastError?: string;
}

// ============================================================================
// Constants
// ============================================================================

const EVENT_THRESHOLD = 50;
const TIME_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_EPISODIC_EVENTS = 100;

// ============================================================================
// Reflect
// ============================================================================

export class Reflect {
  constructor(
    private readonly store: WorldModelStore,
    private readonly episodicStore: EpisodicStore,
    private readonly callLLM: ModelCallFn,
  ) {}

  shouldRun(): boolean {
    const meta = this.store.readMeta();
    const eventCount = meta.eventsSinceLastReflect ?? 0;
    if (eventCount >= EVENT_THRESHOLD) return true;

    const lastReflect = meta.lastReflect ?? 0;
    const elapsed = Date.now() - lastReflect;
    // Only fire the 7-day safety net if there are some events to review
    return elapsed > TIME_THRESHOLD_MS && eventCount > 0;
  }

  async run(): Promise<ReflectResult> {
    const meta = this.store.readMeta();
    const projects = this.store.listProjects();
    const areas = this.store.listAreas();
    const reference = this.store.listReference();

    // Retrieve recent episodic events since last Reflect
    const sinceTimestamp = meta.lastReflect ?? 0;
    let recentEvents: EpisodicEvent[];
    try {
      recentEvents = await this.episodicStore.retrieveSince(sinceTimestamp, MAX_EPISODIC_EVENTS);
    } catch {
      recentEvents = [];
    }

    const lastReflectSummary = meta.lastReflectSummary ?? "No previous reflect.";

    const worldModel = {
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        milestone: p.milestone,
        milestoneBlocking: p.milestoneBlocking,
        nextAction: p.nextAction,
        status: p.status,
        openCRs: p.openCRs,
        lastRun: p.lastRun,
      })),
      areas: areas.map((a) => ({
        id: a.id,
        name: a.name,
        currentStatus: a.currentStatus,
      })),
      reference: reference.map((r) => ({
        filename: r.filename,
        title: r.title,
      })),
    };

    const prompt = `You are reviewing a personal knowledge management system's world model for accuracy and currency.

Last reflect summary: ${lastReflectSummary}

Current world model:
${JSON.stringify(worldModel, null, 2)}

Recent events (since last reflect):
${recentEvents.map((e) => `- [${e.category}] ${e.text}`).join("\n") || "(no recent events)"}

Review the world model against recent events. For each project:
1. Is the milestone still accurate based on recent events?
2. Is the next action still correct?
3. Are any open CRs actually implemented (evidence in recent events)?
4. Are there patterns worth adding to the reference wiki?
5. Are any blockers now resolved?

For each area:
1. Is the status still current?

Also check: are there any pending project suggestions that should be confirmed or dismissed?

Return JSON:
{
  "patches": [
    { "type": "project", "id": "...", "patch": { ...only changed fields... }, "reason": "..." },
    { "type": "area", "id": "...", "patch": {...}, "reason": "..." }
  ],
  "new_reference_entries": [
    { "filename": "...", "title": "...", "content": "..." }
  ],
  "review_items": [
    { "severity": "high|medium|low", "message": "...", "action_required": true|false }
  ],
  "summary": "one paragraph summary of what changed and why"
}`;

    let result: ReflectResult;
    try {
      const raw = await this.callLLM(prompt);
      const cleaned = stripCodeFences(raw);
      const parsed = JSON.parse(cleaned);

      const patches: ReflectPatch[] = Array.isArray(parsed.patches)
        ? parsed.patches.filter(
            (p: Record<string, unknown>) =>
              (p.type === "project" || p.type === "area") &&
              typeof p.id === "string" &&
              typeof p.patch === "object",
          )
        : [];

      const newReferenceEntries: ReflectReferenceEntry[] = Array.isArray(
        parsed.new_reference_entries,
      )
        ? parsed.new_reference_entries.filter(
            (e: Record<string, unknown>) =>
              typeof e.filename === "string" &&
              typeof e.title === "string" &&
              typeof e.content === "string",
          )
        : [];

      const reviewItems: ReflectReviewItem[] = Array.isArray(parsed.review_items)
        ? parsed.review_items.map((item: Record<string, unknown>) => ({
            severity:
              item.severity === "high" || item.severity === "medium" ? item.severity : "low",
            message: typeof item.message === "string" ? item.message : String(item.message),
            actionRequired: item.action_required === true,
          }))
        : [];

      const summary = typeof parsed.summary === "string" ? parsed.summary : "Reflect completed.";

      result = { patches, newReferenceEntries, reviewItems, summary, fromFallback: false };
    } catch (err) {
      result = {
        patches: [],
        newReferenceEntries: [],
        reviewItems: [],
        summary: "Reflect failed — LLM call error.",
        fromFallback: true,
        lastError: String(err),
      };
    }

    // Apply patches
    for (const patch of result.patches) {
      try {
        if (patch.type === "project") {
          this.store.patchProject(patch.id, {
            ...(patch.patch as Partial<ProjectState>),
            updatedAt: Date.now(),
          });
        } else if (patch.type === "area") {
          this.store.patchArea(patch.id, {
            ...(patch.patch as Partial<AreaState>),
            updatedAt: Date.now(),
          });
        }
      } catch {
        // Skip patches for non-existent entities
      }
    }

    // Write new reference entries
    for (const entry of result.newReferenceEntries) {
      try {
        const existing = this.store.readReference(entry.filename) ?? "";
        const dateStamp = new Date().toISOString().split("T")[0];
        this.store.writeReference(
          entry.filename,
          entry.title,
          existing + `\n\n## Added by Reflect ${dateStamp}\n\n${entry.content}`,
        );
      } catch {
        // best-effort
      }
    }

    // Update meta
    this.store.writeMeta({
      ...meta,
      lastReflect: Date.now(),
      eventsSinceLastReflect: 0,
      lastReflectSummary: result.summary,
    });

    return result;
  }
}

// ============================================================================
// Notification Renderer
// ============================================================================

export function renderReflectNotification(result: ReflectResult): string | null {
  const highItems = result.reviewItems.filter((i) => i.severity === "high");

  if (result.reviewItems.length === 0 && result.patches.length === 0) {
    return null; // Silent — nothing notable
  }

  const lines = [`## Reflect Complete`, result.summary, ""];

  if (highItems.length > 0) {
    lines.push("### Items Needing Attention");
    for (const item of highItems) {
      lines.push(`- [${item.severity.toUpperCase()}] ${item.message}`);
    }
    lines.push("");
  }

  lines.push(`${result.patches.length} world model updates applied.`);
  return lines.join("\n");
}
