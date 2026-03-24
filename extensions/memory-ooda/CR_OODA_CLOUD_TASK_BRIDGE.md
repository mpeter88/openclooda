# CR: OODA Cloud Task Bridge

**Date:** 2026-03-21
**Status:** IMPLEMENTED
**Priority:** HIGH — enables always-on async work independent of laptop sleep state
**Author:** Design session with michaelpeter

---

## Problem

When the laptop closes, all in-flight work stops. Claude Code sessions die. Cron jobs that
depend on the local gateway stall. Long-horizon tasks (code review, pipeline monitoring,
background research) can only run when the user is present.

The VPS gateway (`openclooda-infra`) is always on, but there's no mechanism to:

1. Hand off a task from a local session to the VPS
2. Track status transparently
3. Receive results when the laptop wakes back up

The user should be able to say "review the AMF translation CRs while I sleep" and wake
up to a notification with the result — without ever thinking about where or how it ran.

---

## Design Principles

1. **Transparent to the user.** Git push/pull, claim files, task IDs — all invisible.
   The interface is natural language in and notification out.

2. **Automatic dispatch decisions.** The agent decides cloud-bound vs local-bound.
   The user never chooses. Heuristics encode the decision.

3. **Task files are the source of truth.** Human-readable markdown. Doubles as spec,
   log, and result. Git-diffable. No database, no new service.

4. **Git is the transport.** Both sides already have git. No new infrastructure needed.
   Push to dispatch; pull to claim; push to report.

5. **Graceful degradation.** If VPS is unreachable, tasks queue up and run when it
   reconnects. If git push fails, task stays local until retry. Nothing is lost.

---

## Architecture

```
Laptop Session                  Private Git Repo              VPS Gateway
──────────────                  ────────────────              ───────────
Agent decides task              tasks/pending/                Cron (5 min)
is cloud-bound         push →   TASK-xxx.md        ← pull    git pull
                                                              scan pending/
                                tasks/active/                 claim task
                                TASK-xxx.md        ← push    write claim
                                                              spawn agent
                                tasks/active/                 agent runs
                                TASK-xxx.md        ← push    append log
                                                              write result
                                tasks/done/                   move to done
                                TASK-xxx.md        ← push    announce notify
Laptop wakes           pull →   tasks/done/
                                TASK-xxx.md
Agent reads result,
delivers to user
```

---

## Task File Format

Location: `tasks/` directory in the workspace private git repo.

```markdown
# TASK-2026-03-21T2125-001: Review AMF translation phase CRs

**Status:** IMPLEMENTED
**Created:** 2026-03-21T21:25:00Z
**Origin:** laptop (main session)
**Claimed:** —
**Claimed-by:** —
**Completed:** —
**Notify:** announce (webchat)

## Spec

Review all open CRs in /amf-platform/cr/ for the translation phase.
Identify gaps, write a summary. Open a GitHub issue if actionable.

## Context

- Repo: github.com/michaelpeter/10xd (SSH access configured on VPS)
- Branch: main
- Related: CR_GRADLE_VERSION_CATALOG_RESOLUTION

## Heuristics

cloud-bound: true
estimated-duration: long
local-deps: none

## Result

<!-- Written by agent on completion -->

## Log

2026-03-21T21:25:00Z [laptop] Task created
```

**Status lifecycle:**

```
pending → active → done
                → failed
                → cancelled
```

**Directory layout:**

```
tasks/
  pending/    ← new tasks waiting to be claimed
  active/     ← claimed and in-flight
  done/       ← completed (success or failure)
  archive/    ← older done tasks (pruned periodically)
```

---

## Dispatch Heuristics

The agent evaluates every substantial task against these rules. No user input required.

### Cloud-bound (dispatch to VPS) when:

```typescript
const isCloudBound = (task: TaskSpec): boolean => {
  // Explicit async signals from user
  if (/while i sleep|in the background|when you get a chance|no rush/i.test(task.userMessage))
    return true;

  // Estimated long duration
  if (task.estimatedMinutes > 10) return true;

  // Requires remote git operations (clone, PR, push)
  if (task.requiresGit && !task.localRepo) return true;

  // No local filesystem dependency
  if (!task.localDeps) return true;

  return false;
};
```

### Local-bound (run in current session) when:

- Touches local filesystem (`~/Downloads`, local DB, local credentials)
- Needs browser, calendar, screenshot, Spotlight
- Uses local `gcloud`/`firebase` CLI auth sessions
- User is clearly present and waiting (short, conversational task)
- Estimated duration < 5 minutes

### Ambiguous → default to local

User is present; don't dispatch without a signal. If they say "do this now" or "quick",
always local regardless of other signals.

---

## Components

### C1 — Task Dispatch Skill (runs on laptop / any session)

**Trigger:** Agent decides a task is cloud-bound.

**Actions:**

1. Generate task ID: `TASK-{ISO8601}-{seq}`
2. Write task file to `tasks/pending/TASK-xxx.md`
3. `git add tasks/pending/TASK-xxx.md && git commit -m "task: dispatch TASK-xxx" && git push`
4. (Optional) Register a cron job to poll for completion and notify
5. Return task ID to agent context

**User-visible:** Nothing. Agent says: "I've handed that off — I'll notify you when it's done."

**API:**

```typescript
async function dispatchTask(spec: {
  title: string;
  body: string; // full spec text
  context?: string; // extra context (repo, branch, related CRs)
  estimatedMinutes?: number;
  notify?: "announce" | "silent";
}): Promise<{ taskId: string; taskFile: string }>;
```

---

### C2 — Task Runner (runs on VPS, triggered by cron)

**Schedule:** Every 5 minutes via OpenClaw cron.

**Actions:**

1. `git pull` workspace repo
2. Scan `tasks/pending/` for unclaimed tasks
3. For each: write claim (hostname + timestamp) to task file header
4. Move file to `tasks/active/`
5. `git commit -m "task: claim TASK-xxx" && git push`
6. Spawn isolated `sessions_spawn` agent with task spec as prompt
7. Agent runs, appends to `## Log` section periodically, writes `## Result` on completion
8. Move file to `tasks/done/`
9. `git commit -m "task: complete TASK-xxx" && git push`
10. Send announce notification to origin session's delivery channel

**Claim mutex:** Task file header written + pushed before agent spawns.
If two VPS instances race (future), the second `git push` will fail on conflict —
it pulls, sees the existing claim, skips. Git's conflict detection is the mutex.

---

### C3 — Status Query (runs on either side)

When user asks "what's the status of that task?" or "how's the AMF review going?":

1. `git pull` tasks repo
2. Scan `tasks/active/` for matching task (by ID or fuzzy title match)
3. Read `## Log` section — last N lines
4. Report status naturally: "Still running — claimed 2 hours ago. Last entry: cloning repo, reading CRs."

**User-visible:** Natural language status. No task IDs unless asked.

---

### C4 — Completion Notification

When VPS agent completes a task:

1. Announce notification fires to the origin delivery channel
2. Message: "Done — [task title]. [one-line result summary]. Full result in tasks/done/TASK-xxx.md"
3. If laptop is awake: delivered immediately via webchat/TUI
4. If laptop is asleep: queued, delivered on next connection

---

### C5 — Task Cancellation

User says "cancel that" or "forget the AMF review":

1. Agent identifies the task (active or pending)
2. Writes `cancelled` status to task file
3. `git push` — VPS sees the cancellation on next pull
4. VPS runner: if task is active, the spawned agent is steered to stop
5. Move to `tasks/done/` with `Status: cancelled`

---

### C6 — Laptop Wake Sync

On session start (main session `before_agent_start`):

1. `git pull` workspace repo (fast, non-blocking)
2. Scan `tasks/done/` for tasks completed since last pull
3. If any: surface to user: "While you were away, 2 tasks completed: [titles]. Results are in tasks/done/."
4. Mark as surfaced (add `Surfaced: timestamp` to task file header)

---

## Workspace Repo Structure

The workspace private git repo (`~/.openclaw/workspace/`) gains a `tasks/` directory:

```
~/.openclaw/workspace/
  SOUL.md
  MEMORY.md
  KNOWLEDGE.json
  AGENTS.md
  memory/
  tasks/
    pending/
    active/
    done/
    archive/
    .gitkeep          ← keeps dirs tracked in git
```

**Repo:** Private GitHub repo, SSH key-based auth on both laptop and VPS.
**Push/pull:** Non-interactive (SSH key, no passphrase on VPS key).

---

## VPS Setup Requirements

For the task runner to work on the VPS (`openclooda-infra`):

1. **GitHub SSH key** — generate on VPS, add to GitHub as deploy key (read/write on workspace repo)
2. **Git identity** — `git config user.name/email` on VPS
3. **OpenClaw configured** — `openclaw.json` with valid API keys (copied from laptop or re-configured)
4. **Cron job** — registered in OpenClaw cron: `task-runner` every 5 minutes
5. **GitHub SSH access to work repos** — separate deploy key per repo the task runner needs to clone

---

## Implementation Order

### Phase 1 — Foundation (no VPS required yet)

1. Create `tasks/` directory structure in workspace repo
2. Write `dispatchTask()` function in a new `task-bridge.ts` in `memory-ooda`
3. Write task file creation + git commit/push logic
4. Test: manually create a task file, push, verify format

### Phase 2 — Laptop-side dispatch

5. Add dispatch heuristics evaluator
6. Wire into `before_agent_start` context: agent is aware of cloud-bound option
7. Add `dispatchTask` as a callable from agent turns (via `registerCli` or tool)
8. Wake sync: scan `tasks/done/` on session start, surface results

### Phase 3 — VPS runner

9. Write task runner cron payload (isolated `agentTurn` job)
10. Agent prompt for task execution: reads task file, runs spec, writes result
11. Claim + move logic with git push
12. Announce notification on completion

### Phase 4 — Status + cancellation

13. Status query: `git pull` + scan active tasks
14. Cancellation: write cancelled status, VPS detects on next pull
15. `openclaw workspace tasks list` CLI command

---

## Acceptance Criteria

### Dispatch

- [ ] Agent correctly identifies cloud-bound tasks from user message
- [ ] Task file created with correct format in `tasks/pending/`
- [ ] `git push` succeeds silently — no user-visible git output
- [ ] Agent responds naturally: "I've handed that off — I'll notify you when done"
- [ ] Task ID is tracked in agent context for status queries

### Runner (VPS)

- [ ] Cron fires every 5 minutes, pulls repo, scans pending
- [ ] Task claimed atomically (git push as mutex)
- [ ] Isolated agent spawned with task spec
- [ ] Log entries written periodically during execution
- [ ] Result written to `## Result` section on completion
- [ ] Task moved to `tasks/done/` and pushed
- [ ] Announce notification fires to origin channel

### Status

- [ ] "What's the status?" returns natural language from log section
- [ ] No task IDs in user-facing output unless explicitly requested

### Wake sync

- [ ] On session start, completed tasks since last pull are surfaced
- [ ] Tasks only surfaced once (marked after delivery)

### Cancellation

- [ ] "Cancel it" writes cancelled status and pushes
- [ ] VPS detects cancellation within one poll cycle (5 min)

### Resilience

- [ ] Git push failure → task stays local, retried next turn
- [ ] VPS offline → tasks queue in pending/ until VPS reconnects
- [ ] Agent crash → task stays in active/ with last log entry; can be retried manually
- [ ] Duplicate claim race → git conflict detection prevents double-execution

---

## Open Questions

1. **Workspace repo identity:** Should `tasks/` live in the existing workspace repo
   (`~/.openclaw/workspace/`) or a separate `openclooda-tasks` repo? Separate is cleaner
   (no sensitive MEMORY.md next to task logs), but adds another repo to manage.
   **Recommendation:** Separate `openclooda-tasks` private repo — tasks aren't secrets,
   and the workspace repo already has enough responsibility.

2. **VPS agent model:** Should the task runner use the same model as the main session,
   or a cheaper/faster model for routine tasks? Probably configurable per-task via a
   `model:` field in the task file header.

3. **Task file retention:** How long do `tasks/done/` files live before archiving?
   Suggest 30 days in done/, then move to archive/ (or prune). KNOWLEDGE.json Archivist
   can summarize completed tasks periodically.

4. **Multi-VPS future:** If two VPS instances exist, the git claim mutex handles
   deduplication. But load distribution is random (first to pull wins). Fine for now.

---

## Notes

- The AMF watcher cron is already this pattern — except it's imperative (check + act)
  rather than declarative (task spec + result). The task bridge generalizes it.
- OpenClaw's existing `sessions_spawn` + `announce` delivery handles the execution
  and notification layers. The new work is the task file format, git transport,
  dispatch heuristics, and wake sync.
- This is the foundation for "omniclooda" — the agent that persists and works
  regardless of whether the laptop is open.
