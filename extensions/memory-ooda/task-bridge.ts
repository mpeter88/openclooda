/**
 * OODA Cloud Task Bridge
 *
 * Transparent dispatch of long-horizon, cloud-bound tasks to the VPS gateway.
 * Task files are written to tasks/pending/ in the workspace git repo, pushed
 * to the remote, and picked up by the VPS task runner cron.
 *
 * Users never interact with git or task IDs directly. The agent decides,
 * dispatches silently, and notifies on completion.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TaskStatus = "pending" | "active" | "done" | "failed" | "cancelled";

export type TaskSpec = {
  title: string;
  body: string;
  context?: string;
  estimatedMinutes?: number;
  notify?: "announce" | "silent";
  model?: string;
  origin?: string; // session key of dispatching session
};

export type Task = {
  id: string;
  title: string;
  status: TaskStatus;
  createdAt: string;
  claimedAt?: string;
  claimedBy?: string;
  completedAt?: string;
  notify: "announce" | "silent";
  model?: string;
  origin?: string;
  spec: string;
  context?: string;
  result?: string;
  log: Array<{ timestamp: string; source: string; message: string }>;
  surfaced?: string;
};

export type DispatchResult = {
  taskId: string;
  taskFile: string;
  pushed: boolean;
};

// ─── Paths ───────────────────────────────────────────────────────────────────

export function taskDir(workspacePath: string, status: TaskStatus | "all"): string {
  if (status === "all") return path.join(workspacePath, "tasks");
  return path.join(
    workspacePath,
    "tasks",
    status === "active"
      ? "active"
      : status === "done" || status === "failed" || status === "cancelled"
        ? "done"
        : status,
  );
}

function ensureTaskDirs(workspacePath: string): void {
  for (const dir of ["pending", "active", "done", "archive"]) {
    fs.mkdirSync(path.join(workspacePath, "tasks", dir), { recursive: true });
  }
}

// ─── ID generation ───────────────────────────────────────────────────────────

let _seq = 0;
function nextTaskId(): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[-:]/g, "").replace("T", "T").slice(0, 15);
  _seq = (_seq + 1) % 1000;
  return `TASK-${ts}-${String(_seq).padStart(3, "0")}`;
}

// ─── Serialization ───────────────────────────────────────────────────────────

function serializeTask(task: Task): string {
  const header = [
    `# ${task.id}: ${task.title}`,
    ``,
    `**Status:** ${task.status}`,
    `**Created:** ${task.createdAt}`,
    `**Origin:** ${task.origin ?? "unknown"}`,
    `**Claimed:** ${task.claimedAt ?? "—"}`,
    `**Claimed-by:** ${task.claimedBy ?? "—"}`,
    `**Completed:** ${task.completedAt ?? "—"}`,
    `**Notify:** ${task.notify}`,
    task.model ? `**Model:** ${task.model}` : null,
    task.surfaced ? `**Surfaced:** ${task.surfaced}` : null,
    ``,
    `## Spec`,
    ``,
    task.spec,
    ``,
  ]
    .filter((l) => l !== null)
    .join("\n");

  const contextSection = task.context ? `## Context\n\n${task.context}\n\n` : "";

  const resultSection = `## Result\n\n${task.result ?? "<!-- Written by agent on completion -->"}\n\n`;

  const logLines = task.log.map((e) => `${e.timestamp} [${e.source}] ${e.message}`);
  const logSection = `## Log\n\n${logLines.join("\n") || "*(no entries yet)*"}\n`;

  return header + contextSection + resultSection + logSection;
}

function parseTaskFile(content: string, filePath: string): Task | null {
  try {
    const lines = content.split("\n");

    // Extract ID + title from heading
    const headingMatch = lines[0]?.match(/^# (TASK-\S+): (.+)$/);
    if (!headingMatch) return null;
    const id = headingMatch[1];
    const title = headingMatch[2];

    const getField = (name: string): string | undefined => {
      const line = lines.find((l) => l.startsWith(`**${name}:**`));
      if (!line) return undefined;
      const val = line.replace(`**${name}:**`, "").trim();
      return val === "—" ? undefined : val;
    };

    const getSection = (name: string): string => {
      const start = lines.findIndex((l) => l === `## ${name}`);
      if (start === -1) return "";
      const end = lines.findIndex((l, i) => i > start + 1 && l.startsWith("## "));
      const sectionLines = end === -1 ? lines.slice(start + 2) : lines.slice(start + 2, end);
      return sectionLines.join("\n").trim();
    };

    const logSection = getSection("Log");
    const logEntries =
      logSection === "*(no entries yet)*" || !logSection
        ? []
        : logSection
            .split("\n")
            .map((line) => {
              const m = line.match(/^(\S+) \[(\S+)\] (.+)$/);
              if (!m) return null;
              return { timestamp: m[1], source: m[2], message: m[3] };
            })
            .filter((e): e is NonNullable<typeof e> => e !== null);

    const result = getSection("Result");

    return {
      id,
      title,
      status: (getField("Status") ?? "pending") as TaskStatus,
      createdAt: getField("Created") ?? new Date().toISOString(),
      claimedAt: getField("Claimed"),
      claimedBy: getField("Claimed-by"),
      completedAt: getField("Completed"),
      notify: (getField("Notify") ?? "announce") as "announce" | "silent",
      model: getField("Model"),
      origin: getField("Origin"),
      surfaced: getField("Surfaced"),
      spec: getSection("Spec"),
      context: getSection("Context") || undefined,
      result: result.includes("<!-- Written") ? undefined : result || undefined,
      log: logEntries,
    };
  } catch {
    return null;
  }
}

// ─── Git operations ───────────────────────────────────────────────────────────

function gitExec(workspacePath: string, cmd: string): { ok: boolean; output: string } {
  try {
    const output = execSync(cmd, {
      cwd: workspacePath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30_000,
    });
    return { ok: true, output: output.trim() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, output: msg };
  }
}

function isGitRepo(workspacePath: string): boolean {
  return gitExec(workspacePath, "git rev-parse --git-dir").ok;
}

function hasRemote(workspacePath: string): boolean {
  const result = gitExec(workspacePath, "git remote");
  return result.ok && result.output.trim().length > 0;
}

function gitPushTask(
  workspacePath: string,
  relPath: string,
  taskId: string,
  action: string,
): boolean {
  if (!isGitRepo(workspacePath)) return false;
  if (!hasRemote(workspacePath)) return false;

  gitExec(workspacePath, `git add "${relPath}"`);
  gitExec(workspacePath, `git commit -m "task: ${action} ${taskId}" --allow-empty`);
  const push = gitExec(workspacePath, "git push");
  return push.ok;
}

function gitPull(workspacePath: string): boolean {
  if (!isGitRepo(workspacePath) || !hasRemote(workspacePath)) return false;
  return gitExec(workspacePath, "git pull --rebase --quiet").ok;
}

// ─── Core API ────────────────────────────────────────────────────────────────

/**
 * Dispatch a task to the cloud task queue.
 * Writes a task file to tasks/pending/, commits, and pushes.
 * Silent — no user-visible output.
 */
export function dispatchTask(workspacePath: string, spec: TaskSpec): DispatchResult {
  ensureTaskDirs(workspacePath);

  const taskId = nextTaskId();
  const now = new Date().toISOString();

  const task: Task = {
    id: taskId,
    title: spec.title,
    status: "pending",
    createdAt: now,
    notify: spec.notify ?? "announce",
    model: spec.model,
    origin: spec.origin,
    spec: spec.body,
    context: spec.context,
    log: [{ timestamp: now, source: "laptop", message: "Task created" }],
  };

  const pendingDir = path.join(workspacePath, "tasks", "pending");
  const filename = `${taskId}.md`;
  const filePath = path.join(pendingDir, filename);
  const relPath = path.join("tasks", "pending", filename);

  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, serializeTask(task), "utf-8");
  fs.renameSync(tmpPath, filePath);

  const pushed = gitPushTask(workspacePath, relPath, taskId, "dispatch");

  return { taskId, taskFile: relPath, pushed };
}

/**
 * Get status of a task by ID or fuzzy title match.
 * Pulls latest from remote first.
 */
export function getTaskStatus(
  workspacePath: string,
  query: string,
): { task: Task; filePath: string } | null {
  gitPull(workspacePath);

  // Search all status dirs
  for (const dir of ["active", "pending", "done"]) {
    const dirPath = path.join(workspacePath, "tasks", dir);
    if (!fs.existsSync(dirPath)) continue;

    for (const file of fs.readdirSync(dirPath)) {
      if (!file.endsWith(".md")) continue;
      const filePath = path.join(dirPath, file);
      const content = fs.readFileSync(filePath, "utf-8");
      const task = parseTaskFile(content, filePath);
      if (!task) continue;

      // Match by ID or fuzzy title
      if (
        task.id.toLowerCase().includes(query.toLowerCase()) ||
        task.title.toLowerCase().includes(query.toLowerCase())
      ) {
        return { task, filePath };
      }
    }
  }

  return null;
}

/**
 * List all tasks, optionally filtered by status.
 * Pulls latest from remote first.
 */
export function listTasks(
  workspacePath: string,
  filter?: TaskStatus,
): Array<{ task: Task; filePath: string }> {
  gitPull(workspacePath);

  const dirs = filter
    ? [filter === "done" || filter === "failed" || filter === "cancelled" ? "done" : filter]
    : ["pending", "active", "done"];

  const results: Array<{ task: Task; filePath: string }> = [];

  for (const dir of dirs) {
    const dirPath = path.join(workspacePath, "tasks", dir);
    if (!fs.existsSync(dirPath)) continue;

    for (const file of fs.readdirSync(dirPath)) {
      if (!file.endsWith(".md")) continue;
      const filePath = path.join(dirPath, file);
      const content = fs.readFileSync(filePath, "utf-8");
      const task = parseTaskFile(content, filePath);
      if (task) results.push({ task, filePath });
    }
  }

  return results.sort((a, b) => b.task.createdAt.localeCompare(a.task.createdAt));
}

/**
 * Cancel a task.
 * Writes cancelled status, pushes.
 */
export function cancelTask(workspacePath: string, query: string): boolean {
  const found = getTaskStatus(workspacePath, query);
  if (!found) return false;
  if (found.task.status === "done" || found.task.status === "cancelled") return false;

  found.task.status = "cancelled";
  found.task.completedAt = new Date().toISOString();
  found.task.log.push({
    timestamp: new Date().toISOString(),
    source: "laptop",
    message: "Task cancelled by user",
  });

  const tmpPath = found.filePath + ".tmp";
  fs.writeFileSync(tmpPath, serializeTask(found.task), "utf-8");
  fs.renameSync(tmpPath, found.filePath);

  gitPushTask(workspacePath, path.relative(workspacePath, found.filePath), found.task.id, "cancel");

  return true;
}

/**
 * Scan tasks/done/ for tasks completed since last wake, not yet surfaced.
 * Called on session start (wake sync).
 * Returns unsurfaced completed tasks and marks them as surfaced.
 */
export function wakeSync(workspacePath: string): Task[] {
  gitPull(workspacePath);

  const doneDir = path.join(workspacePath, "tasks", "done");
  if (!fs.existsSync(doneDir)) return [];

  const unsurfaced: Task[] = [];

  for (const file of fs.readdirSync(doneDir)) {
    if (!file.endsWith(".md")) continue;
    const filePath = path.join(doneDir, file);
    const content = fs.readFileSync(filePath, "utf-8");
    const task = parseTaskFile(content, filePath);
    if (!task) continue;
    if (task.surfaced) continue;
    if (task.status !== "done" && task.status !== "failed") continue;

    unsurfaced.push(task);

    // Mark as surfaced
    task.surfaced = new Date().toISOString();
    const tmpPath = filePath + ".tmp";
    fs.writeFileSync(tmpPath, serializeTask(task), "utf-8");
    fs.renameSync(tmpPath, filePath);
  }

  if (unsurfaced.length > 0) {
    // Commit surfaced markers (best-effort, non-blocking)
    gitExec(workspacePath, "git add tasks/done/");
    gitExec(workspacePath, `git commit -m "task: mark ${unsurfaced.length} task(s) surfaced"`);
    gitExec(workspacePath, "git push");
  }

  return unsurfaced;
}

// ─── Dispatch heuristics ─────────────────────────────────────────────────────

export type DispatchHint = "cloud" | "local" | "unknown";

/**
 * Evaluate whether a task is cloud-bound or local-bound.
 * Returns a hint — the agent makes the final call.
 */
export function evaluateDispatch(params: {
  userMessage: string;
  estimatedMinutes?: number;
  requiresLocalFS?: boolean;
  requiresLocalAuth?: boolean;
}): { hint: DispatchHint; reason: string } {
  const { userMessage, estimatedMinutes, requiresLocalFS, requiresLocalAuth } = params;
  const msg = userMessage.toLowerCase();

  // Hard local signals
  if (requiresLocalFS) return { hint: "local", reason: "requires local filesystem" };
  if (requiresLocalAuth) return { hint: "local", reason: "requires local auth (gcloud/firebase)" };
  if (/\b(downloads?|desktop|finder|spotlight|calendar|browser|screenshot)\b/i.test(msg)) {
    return { hint: "local", reason: "references local-only resource" };
  }

  // Hard cloud signals
  if (
    /while (i|you) (sleep|travel|am away|are away)|in the background|no rush|when you get a chance|asynchronously/i.test(
      msg,
    )
  ) {
    return { hint: "cloud", reason: "explicit async signal from user" };
  }
  if (estimatedMinutes && estimatedMinutes > 15) {
    return { hint: "cloud", reason: `estimated duration ${estimatedMinutes}m exceeds threshold` };
  }
  if (
    /\b(review|analyze|implement|migrate|refactor|audit)\b.{0,40}\b(codebase|repo|repository|all|entire)\b/i.test(
      msg,
    )
  ) {
    return { hint: "cloud", reason: "large-scope code task" };
  }

  // Ambiguous — default local (user is present)
  return { hint: "local", reason: "ambiguous — defaulting to local (user present)" };
}

// ─── VPS Task Runner ─────────────────────────────────────────────────────────

/**
 * VPS-side: scan pending tasks, claim one, return it.
 * Called by the task runner cron agent.
 */
export function claimNextTask(
  workspacePath: string,
  claimedBy: string,
): { task: Task; filePath: string; newPath: string } | null {
  ensureTaskDirs(workspacePath);
  gitPull(workspacePath);

  const pendingDir = path.join(workspacePath, "tasks", "pending");
  if (!fs.existsSync(pendingDir)) return null;

  const files = fs
    .readdirSync(pendingDir)
    .filter((f) => f.endsWith(".md"))
    .sort();
  if (files.length === 0) return null;

  for (const file of files) {
    const filePath = path.join(pendingDir, file);
    const content = fs.readFileSync(filePath, "utf-8");
    const task = parseTaskFile(content, filePath);
    if (!task || task.status !== "pending") continue;

    // Claim it
    const now = new Date().toISOString();
    task.status = "active";
    task.claimedAt = now;
    task.claimedBy = claimedBy;
    task.log.push({ timestamp: now, source: claimedBy, message: "Task claimed" });

    // Move to active/
    const activeDir = path.join(workspacePath, "tasks", "active");
    const newPath = path.join(activeDir, file);

    const tmpPath = newPath + ".tmp";
    fs.writeFileSync(tmpPath, serializeTask(task), "utf-8");
    fs.renameSync(tmpPath, newPath);
    fs.unlinkSync(filePath);

    // Push claim (mutex: git conflict if two agents race)
    const pushed = gitPushTask(workspacePath, path.join("tasks", "active", file), task.id, "claim");

    if (!pushed) {
      // Conflict — another agent claimed it. Move back and try next.
      fs.renameSync(newPath, filePath);
      continue;
    }

    return { task, filePath: newPath, newPath };
  }

  return null;
}

/**
 * VPS-side: mark a task complete (or failed), write result, push.
 */
export function completeTask(
  workspacePath: string,
  taskId: string,
  result: string,
  status: "done" | "failed" = "done",
): boolean {
  const activeDir = path.join(workspacePath, "tasks", "active");
  if (!fs.existsSync(activeDir)) return false;

  const file = fs.readdirSync(activeDir).find((f) => f.startsWith(taskId));
  if (!file) return false;

  const filePath = path.join(activeDir, file);
  const content = fs.readFileSync(filePath, "utf-8");
  const task = parseTaskFile(content, filePath);
  if (!task) return false;

  const now = new Date().toISOString();
  task.status = status;
  task.completedAt = now;
  task.result = result;
  task.log.push({ timestamp: now, source: task.claimedBy ?? "vps", message: `Task ${status}` });

  const doneDir = path.join(workspacePath, "tasks", "done");
  const newPath = path.join(doneDir, file);

  const tmpPath = newPath + ".tmp";
  fs.writeFileSync(tmpPath, serializeTask(task), "utf-8");
  fs.renameSync(tmpPath, newPath);
  fs.unlinkSync(filePath);

  gitPushTask(workspacePath, path.join("tasks", "done", file), taskId, status);

  return true;
}

/**
 * VPS-side: append a log entry to an active task (for progress updates).
 */
export function appendTaskLog(
  workspacePath: string,
  taskId: string,
  message: string,
  source?: string,
): void {
  const activeDir = path.join(workspacePath, "tasks", "active");
  if (!fs.existsSync(activeDir)) return;

  const file = fs.readdirSync(activeDir).find((f) => f.startsWith(taskId));
  if (!file) return;

  const filePath = path.join(activeDir, file);
  const content = fs.readFileSync(filePath, "utf-8");
  const task = parseTaskFile(content, filePath);
  if (!task) return;

  task.log.push({
    timestamp: new Date().toISOString(),
    source: source ?? task.claimedBy ?? "vps",
    message,
  });

  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, serializeTask(task), "utf-8");
  fs.renameSync(tmpPath, filePath);

  // Push log update (best-effort)
  gitExec(workspacePath, `git add "${path.join("tasks", "active", file)}"`);
  gitExec(workspacePath, `git commit -m "task: log ${taskId}" --allow-empty`);
  gitExec(workspacePath, "git push");
}
