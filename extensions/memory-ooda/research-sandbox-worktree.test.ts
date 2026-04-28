import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { experimentDir } from "./research-loop.js";
import {
  createWorktreeIsolation,
  type AsyncSpawnFn,
  type SpawnFn,
} from "./research-sandbox-worktree.js";

/** Mock spawn harness that records calls + returns injected results by command. */
function buildSpawns(
  script: Array<{ argsMatch: RegExp; exitCode: number; stdout?: string; stderr?: string }>,
) {
  const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
  const consume = (command: string, args: string[], cwd: string) => {
    calls.push({ cmd: command, args, cwd });
    const joined = `${command} ${args.join(" ")}`;
    for (const entry of script) {
      if (entry.argsMatch.test(joined)) {
        return {
          exitCode: entry.exitCode,
          stdout: entry.stdout ?? "",
          stderr: entry.stderr ?? "",
        };
      }
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const spawnFn: SpawnFn = (command, args, options) => consume(command, args, options.cwd);
  const spawnAsync: AsyncSpawnFn = async (command, args, options) =>
    consume(command, args, options.cwd);
  return { calls, spawnFn, spawnAsync };
}

function seedWorkspaceAndExpDir(tmp: string, expId: string): void {
  fs.mkdirSync(experimentDir(tmp, expId), { recursive: true });
}

const SAMPLE_DIFF = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1 +1 @@
-a
+b
`;

describe("createWorktreeIsolation.applyDiff", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-worktree-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("invokes git worktree add + git apply and returns a handle", async () => {
    seedWorkspaceAndExpDir(tmp, "exp-a");
    const { calls, spawnFn, spawnAsync } = buildSpawns([
      { argsMatch: /worktree add/, exitCode: 0 },
      { argsMatch: /apply --whitespace/, exitCode: 0 },
    ]);
    const iso = createWorktreeIsolation({
      workspacePath: tmp,
      repoRoot: "/fake/repo",
      spawnFn,
      asyncSpawnFn: spawnAsync,
    });
    const handle = await iso.applyDiff("exp-a", SAMPLE_DIFF);
    expect(handle.handle).toBe(path.join(experimentDir(tmp, "exp-a"), "worktree"));
    const sequence = calls.map((c) => `${c.cmd} ${c.args.slice(0, 2).join(" ")}`);
    expect(sequence.some((s) => s.startsWith("git worktree"))).toBe(true);
    expect(sequence.some((s) => s.startsWith("git apply"))).toBe(true);
    // Diff file should exist inside the worktree path (which we synthesized in tmp).
    expect(fs.existsSync(path.join(handle.worktreePath, ".experiment.diff"))).toBe(true);
  });

  it("throws on worktree add failure and does not run apply", async () => {
    seedWorkspaceAndExpDir(tmp, "exp-add-fail");
    const { calls, spawnFn, spawnAsync } = buildSpawns([
      { argsMatch: /worktree add/, exitCode: 1, stderr: "fatal: branch not found" },
    ]);
    const iso = createWorktreeIsolation({
      workspacePath: tmp,
      repoRoot: "/fake",
      spawnFn,
      asyncSpawnFn: spawnAsync,
    });
    await expect(iso.applyDiff("exp-add-fail", SAMPLE_DIFF)).rejects.toThrow(
      /git worktree add failed/,
    );
    expect(calls.some((c) => c.args.includes("apply"))).toBe(false);
  });

  it("cleans up the worktree when git apply fails", async () => {
    seedWorkspaceAndExpDir(tmp, "exp-apply-fail");
    const { calls, spawnFn, spawnAsync } = buildSpawns([
      { argsMatch: /worktree add/, exitCode: 0 },
      { argsMatch: /apply --whitespace/, exitCode: 1, stderr: "bad patch" },
      { argsMatch: /worktree remove/, exitCode: 0 },
    ]);
    const iso = createWorktreeIsolation({
      workspacePath: tmp,
      repoRoot: "/fake",
      spawnFn,
      asyncSpawnFn: spawnAsync,
    });
    await expect(iso.applyDiff("exp-apply-fail", SAMPLE_DIFF)).rejects.toThrow(/git apply failed/);
    expect(calls.some((c) => c.args.includes("remove"))).toBe(true);
  });
});

describe("createWorktreeIsolation.runCase", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-worktree-run-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function setup(
    script: Array<{ argsMatch: RegExp; exitCode: number; stdout?: string; stderr?: string }>,
  ) {
    seedWorkspaceAndExpDir(tmp, "exp-run");
    const spawns = buildSpawns(script);
    const iso = createWorktreeIsolation({
      workspacePath: tmp,
      repoRoot: "/fake",
      spawnFn: spawns.spawnFn,
      asyncSpawnFn: spawns.spawnAsync,
      evalCommand: { cmd: "pnpm", args: ["tsgo", "--noEmit"] },
    });
    const handle = await iso.applyDiff("exp-run", SAMPLE_DIFF);
    return { iso, handle, calls: spawns.calls };
  }

  it("returns success when the eval command exits 0", async () => {
    const { iso, handle } = await setup([
      { argsMatch: /worktree add/, exitCode: 0 },
      { argsMatch: /apply --whitespace/, exitCode: 0 },
      { argsMatch: /tsgo --noEmit/, exitCode: 0, stdout: "ok" },
    ]);
    const r = await iso.runCase(handle, { observation: "x" } as never);
    expect(r.source).toBe("tool_result");
    if (r.source === "tool_result") expect(r.success).toBe(true);
  });

  it("returns failure with stderr snippet on non-zero exit", async () => {
    const { iso, handle } = await setup([
      { argsMatch: /worktree add/, exitCode: 0 },
      { argsMatch: /apply --whitespace/, exitCode: 0 },
      {
        argsMatch: /tsgo --noEmit/,
        exitCode: 1,
        stderr: "error TS2322: Type 'string' is not assignable to 'number'",
      },
    ]);
    const r = await iso.runCase(handle, { observation: "x" } as never);
    if (r.source === "tool_result") {
      expect(r.success).toBe(false);
      expect(r.summary).toContain("TS2322");
    }
  });

  it("caches eval per sandbox handle so the staged-eval loop does not re-run tsgo per fixture", async () => {
    const { iso, handle, calls } = await setup([
      { argsMatch: /worktree add/, exitCode: 0 },
      { argsMatch: /apply --whitespace/, exitCode: 0 },
      { argsMatch: /tsgo --noEmit/, exitCode: 0 },
    ]);
    await iso.runCase(handle, { observation: "a" } as never);
    await iso.runCase(handle, { observation: "b" } as never);
    await iso.runCase(handle, { observation: "c" } as never);
    const tsgoCalls = calls.filter((c) => c.args.includes("tsgo"));
    expect(tsgoCalls).toHaveLength(1);
  });
});

describe("createWorktreeIsolation.cleanup", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-worktree-cleanup-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("invokes git worktree remove + rmSync and never throws", async () => {
    seedWorkspaceAndExpDir(tmp, "exp-cleanup");
    const removeCalls = vi.fn();
    const spawnFn: SpawnFn = (command, args, _options) => {
      const joined = `${command} ${args.join(" ")}`;
      if (joined.includes("worktree add")) return { exitCode: 0, stdout: "", stderr: "" };
      if (joined.includes("apply")) return { exitCode: 0, stdout: "", stderr: "" };
      if (joined.includes("worktree remove")) {
        removeCalls();
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const spawnAsync: AsyncSpawnFn = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const iso = createWorktreeIsolation({
      workspacePath: tmp,
      repoRoot: "/fake",
      spawnFn,
      asyncSpawnFn: spawnAsync,
    });
    const handle = await iso.applyDiff("exp-cleanup", SAMPLE_DIFF);
    await handle.cleanup();
    expect(removeCalls).toHaveBeenCalled();
  });
});
