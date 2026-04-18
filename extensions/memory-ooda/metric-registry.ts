/**
 * MetricRegistry — Grounded Evaluation Harness for OODA
 *
 * Provides measurable, non-LLM-assessed metrics per domain. These metrics
 * are computed from observable system state (health files, archivist state,
 * world model project data) — not from model inference.
 *
 * Purpose: the feedback loop (archivist → valuation engine → weight proposals
 * → meta-reviewer) needs a ground truth signal to optimize against. Without
 * grounded metrics, the system optimizes against its own LLM-generated
 * outcome labels — equivalent to an evolutionary search where the evolved
 * algorithm writes its own fitness function.
 *
 * Inspired by: AlphaEvolve's fixed evaluation harness (DeepMind, 2602.16928v2).
 */

import fs from "node:fs";
import path from "node:path";
import type { WorldModelStore } from "../memory-lancedb/world-model-store.js";
import type { EpisodicStore } from "./archivist.js";

// ============================================================================
// Types
// ============================================================================

export interface MetricContext {
  workspacePath: string;
  episodicStore: EpisodicStore;
  worldModelStore: WorldModelStore;
}

export interface MetricResult {
  domainId: string;
  /** Grounded metric score in [0.0, 1.0]. */
  score: number;
  /** Human-readable description of what this metric measures. */
  description: string;
  computedAt: number;
}

export interface DomainMetric {
  domainId: string;
  description: string;
  compute: (ctx: MetricContext) => Promise<number>;
}

// ============================================================================
// Registry
// ============================================================================

export class MetricRegistry {
  private metrics = new Map<string, DomainMetric>();

  register(metric: DomainMetric): void {
    this.metrics.set(metric.domainId, metric);
  }

  /** Compute metric for a domain. Returns null for unregistered domains. */
  async compute(domainId: string, ctx: MetricContext): Promise<MetricResult | null> {
    const metric = this.metrics.get(domainId);
    if (!metric) return null;

    try {
      const score = await metric.compute(ctx);
      return {
        domainId,
        score: Math.max(0, Math.min(1, score)),
        description: metric.description,
        computedAt: Date.now(),
      };
    } catch {
      return null;
    }
  }

  /** Compute all registered metrics. */
  async computeAll(ctx: MetricContext): Promise<MetricResult[]> {
    const results: MetricResult[] = [];
    for (const [domainId] of this.metrics) {
      const result = await this.compute(domainId, ctx);
      if (result) results.push(result);
    }
    return results;
  }

  /** Check if a domain has a registered metric. */
  has(domainId: string): boolean {
    return this.metrics.has(domainId);
  }
}

// ============================================================================
// Built-in Metric Resolvers
// ============================================================================

const HEALTH_FILENAME = "ooda-health.json";
const ARCHIVIST_STATE_FILENAME = ".archivist-state.json";

/**
 * openclooda domain: archivist health score.
 * (completions / expected_completions) × (1 - error_rate) over last 7 days.
 */
const opencloodaMetric: DomainMetric = {
  domainId: "openclooda",
  description: "Archivist health: completion rate × (1 - error rate) over last 7 days",
  async compute(ctx: MetricContext): Promise<number> {
    const healthFile = path.join(ctx.workspacePath, HEALTH_FILENAME);
    const stateFile = path.join(ctx.workspacePath, ARCHIVIST_STATE_FILENAME);

    let completions = 0;
    let errors = 0;

    // Read health state for archivist telemetry
    try {
      const raw = fs.readFileSync(healthFile, "utf-8");
      const health = JSON.parse(raw);
      const archivist = health.subsystems?.archivist;
      if (archivist) {
        completions = archivist.totalFires ?? 0;
        errors = archivist.lastError ? 1 : 0;
      }
    } catch {
      // No health file — archivist hasn't run
      return 0;
    }

    // Read archivist state for turn counter health
    try {
      const raw = fs.readFileSync(stateFile, "utf-8");
      const state = JSON.parse(raw);
      const turnsSinceLast = state.turns_since_last_archivist ?? 0;
      const interval = 15; // default turn interval

      // If the archivist is heavily overdue, that's a health signal
      const overdueRatio = Math.min(1, turnsSinceLast / (interval * 3));
      const overdueScore = 1 - overdueRatio;

      if (completions === 0) return 0;
      const errorRate = errors / completions;
      return overdueScore * (1 - errorRate);
    } catch {
      return completions > 0 ? 0.5 : 0;
    }
  },
};

/**
 * amf_pipeline domain: latest parity score from world model project state.
 * Reads the AMF Platform project's lastRun.parity field.
 */
const amfPipelineMetric: DomainMetric = {
  domainId: "amf_pipeline",
  description: "AMF pipeline parity score from latest gauntlet run",
  async compute(ctx: MetricContext): Promise<number> {
    const project = ctx.worldModelStore.readProject("amf-platform");
    if (!project?.lastRun?.parity) return 0;

    // Parity is typically 0–100; normalize to [0, 1]
    return Math.max(0, Math.min(1, project.lastRun.parity / 100));
  },
};

/**
 * Create a MetricRegistry with the built-in domain resolvers.
 */
export function createDefaultRegistry(): MetricRegistry {
  const registry = new MetricRegistry();
  registry.register(opencloodaMetric);
  registry.register(amfPipelineMetric);
  return registry;
}
