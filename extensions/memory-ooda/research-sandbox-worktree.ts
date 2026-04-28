/**
 * CR_OODA_RESEARCH_LOOP — git-worktree isolation backend.
 *
 * First shippable IsolationDeps implementation. Creates a git worktree under
 * `.experiments/{exp-id}/worktree/`, applies the diff inside it, and invokes
 * an evaluator (defaults to `pnpm tsgo --noEmit`) to produce a pass/fail
 * outcome.
 *
 * Per-fixture semantic evaluation is the natural next iteration — the current
 * coarse eval ("does the diff still typecheck?") is a real no-regression
 * signal even though it's not per-case granular. Fixtures that aren't already
 * broken on main stay green; fixtures break only when the diff introduces a
 * type error or makes existing tests fail on the worktree.
 *
 * Docker isolation is a follow-up — same `IsolationDeps` interface, different
 * `applyDiff` implementation.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { experimentDir } from "./research-loop.js";
import type { IsolationDeps, SandboxIsolation } from "./research-sandbox.js";
import type { ActualOutcome, AdmissionCase } from "./types.js";

// ============================================================================
// Process helpers — small, injected for tests
// ============================================================================

export interface SpawnFn {
  (
    command: string,
    args: string[],
    options: { cwd: string; timeoutMs: number },
  ): { exitCode: number; stdout: string; stderr: string };
}

export interface AsyncSpawnFn {
  (
    command: string,
    args: string[],
    options: { cwd: string; timeoutMs: number },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

/** Real synchronous spawn used in production. Bounded by `timeoutMs`. */
export const defaultSpawn: SpawnFn = (command, args, options) => {
  const r = spawnSync(command, args, {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    encoding: "utf-8",
  });
  return {
    exitCode: typeof r.status === "number" ? r.status : r.signal ? 124 : -1,
    stdout: (r.stdout ?? "").toString(),
    stderr: (r.stderr ?? "").toString(),
  };
};

/** Async version — used for the eval command so long-running typechecks don't block the node event loop. */
export const defaultAsyncSpawn: AsyncSpawnFn = (command, args, options) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    const killer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // best-effort
      }
    }, options.timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(killer);
      resolve({
        exitCode: typeof code === "number" ? code : signal ? 124 : -1,
        stdout,
        stderr,
      });
    });
    child.on("error", () => {
      clearTimeout(killer);
      resolve({ exitCode: -1, stdout, stderr });
    });
  });

// ============================================================================
// Worktree isolation
// ============================================================================

export interface WorktreeIsolationOptions {
  workspacePath: string;
  /** Path to the openclooda repo root (for `git worktree add` origin). Defaults to process.cwd(). */
  repoRoot?: string;
  /** Branch name to base the worktree on. Defaults to "HEAD". */
  baseRef?: string;
  /** Eval command + args run inside the worktree. Default: `pnpm tsgo --noEmit`. */
  evalCommand?: { cmd: string; args: string[] };
  /** Timeout for each subprocess invocation in ms. Default: 120_000. */
  timeoutMs?: number;
  /** Injected for tests. */
  spawnFn?: SpawnFn;
  /** Injected for tests. */
  asyncSpawnFn?: AsyncSpawnFn;
}

export interface WorktreeIsolation extends SandboxIsolation {
  worktreePath: string;
  baseRef: string;
}

export interface WorktreeIsolationDeps extends IsolationDeps {
  applyDiff: (expId: string, diff: string) => Promise<WorktreeIsolation>;
}

/** Build IsolationDeps that use `git worktree` for sandbox isolation. */
export function createWorktreeIsolation(options: WorktreeIsolationOptions): WorktreeIsolationDeps {
  const repoRoot = options.repoRoot ?? process.cwd();
  const baseRef = options.baseRef ?? "HEAD";
  const evalCommand = options.evalCommand ?? { cmd: "pnpm", args: ["tsgo", "--noEmit"] };
  const timeoutMs = options.timeoutMs ?? 120_000;
  const spawnSync = options.spawnFn ?? defaultSpawn;
  const spawnAsync = options.asyncSpawnFn ?? defaultAsyncSpawn;
  // Track the eval result once per sandbox handle so we don't re-run the
  // typecheck for every fixture in a staged-eval pass.
  const cachedVerdict = new Map<string, ActualOutcome>();

  async function applyDiff(expId: string, diff: string): Promise<WorktreeIsolation> {
    const worktreePath = path.join(experimentDir(options.workspacePath, expId), "worktree");
    // Make sure prior state is clean — `git worktree remove --force` is
    // idempotent-ish but fails when the worktree dir doesn't exist, so guard.
    if (fs.existsSync(worktreePath)) {
      spawnSync("git", ["worktree", "remove", "--force", worktreePath], {
        cwd: repoRoot,
        timeoutMs,
      });
      if (fs.existsSync(worktreePath)) {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      }
    }
    const add = spawnSync("git", ["worktree", "add", "--detach", worktreePath, baseRef], {
      cwd: repoRoot,
      timeoutMs,
    });
    if (add.exitCode !== 0) {
      throw new Error(
        `git worktree add failed (exit=${add.exitCode}): ${add.stderr.slice(0, 200)}`,
      );
    }
    // Write diff to a temp file inside the worktree and apply it. Belt + suspenders:
    // git worktree add creates the dir in production, but mocked spawns in tests
    // do not — mkdirSync is idempotent and adds no runtime cost.
    fs.mkdirSync(worktreePath, { recursive: true });
    const diffFile = path.join(worktreePath, ".experiment.diff");
    fs.writeFileSync(diffFile, diff, "utf-8");
    const apply = spawnSync("git", ["apply", "--whitespace=nowarn", diffFile], {
      cwd: worktreePath,
      timeoutMs,
    });
    if (apply.exitCode !== 0) {
      // Clean up and surface the error — caller will transition experiment to rejected.
      spawnSync("git", ["worktree", "remove", "--force", worktreePath], {
        cwd: repoRoot,
        timeoutMs,
      });
      throw new Error(`git apply failed (exit=${apply.exitCode}): ${apply.stderr.slice(0, 300)}`);
    }

    return {
      handle: worktreePath,
      worktreePath,
      baseRef,
      cleanup: async () => {
        try {
          cachedVerdict.delete(worktreePath);
          spawnSync("git", ["worktree", "remove", "--force", worktreePath], {
            cwd: repoRoot,
            timeoutMs,
          });
          if (fs.existsSync(worktreePath)) {
            fs.rmSync(worktreePath, { recursive: true, force: true });
          }
        } catch {
          // best-effort — cleanup failure must not fail the experiment
        }
      },
    };
  }

  async function runCase(
    iso: SandboxIsolation,
    _fixture: AdmissionCase["fixture"],
  ): Promise<ActualOutcome> {
    // Structural eval: one run per sandbox handle, cached. Not per-fixture
    // semantic — but a real no-regression signal. A future backend will take
    // the fixture into account (e.g. run a specific admission test file).
    const cached = cachedVerdict.get(iso.handle);
    if (cached) return cached;
    const r = await spawnAsync(evalCommand.cmd, evalCommand.args, { cwd: iso.handle, timeoutMs });
    const outcome: ActualOutcome =
      r.exitCode === 0
        ? { source: "tool_result", success: true, toolName: evalCommand.cmd, summary: "passed" }
        : {
            source: "tool_result",
            success: false,
            toolName: evalCommand.cmd,
            summary: r.stderr.slice(0, 300) || `exit=${r.exitCode}`,
          };
    cachedVerdict.set(iso.handle, outcome);
    return outcome;
  }

  return { applyDiff, runCase };
}
