# CR: OpenClaw Skills + Hooks Context Hygiene

**Date:** 2026-04-18
**Status:** WRITTEN
**Priority:** HIGH — kills the "is the gateway up?" / "what's the status?" preamble from every session; makes CLAUDE.md leaner by scoping context per task
**Sources:**

- Claude Code skill docs — `paths:` auto-activation, `!` command dynamic context, skill-scoped hooks.
- `disler/claude-code-hooks-mastery` — practical UserPromptSubmit + SessionStart injector patterns.
- Lance Martin, "Agent Design Patterns" (Jan 2026) — context offload + progressive disclosure.

---

## Current State

1. **`~/.claude/CLAUDE.md` and `openclaw/CLAUDE.md` are huge.** Every session loads the full global + project CLAUDE.md. Most rules in them are **contextual** — they apply only when editing docs, or only when touching channels, or only when cutting a release. Today all rules load every turn regardless.
2. **Status-check preamble.** Sessions working on gateway / channels / plugins routinely open with "check `openclaw status --all`". This burns tokens and roundtrips that a hook could serve for free.
3. **No skill auto-activation.** Skills exist globally but require the user or model to pick them. Mintlify-linking conventions, Parallels-smoke playbook, Discord config rules — each should auto-activate only on relevant file paths.
4. **Memory curation is manual.** `MEMORY.md` and `feedback_*.md` files are hand-written. Nothing auto-captures "user corrected me" / "I verified X" moments.

## Design

### C1 — `paths:`-Scoped Skills

For each scoped rule block currently in `openclaw/CLAUDE.md`, extract into a skill with `paths:` frontmatter:

| Skill (new)                  | Paths                                                                                                            | Contents                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `openclaw-docs-mintlify`     | `docs/**/*.{md,mdx}`                                                                                             | Mintlify linking rules, anchor rules, alphabetical ordering |
| `openclaw-docs-i18n`         | `docs/zh-CN/**`, `docs/.i18n/**`                                                                                 | zh-CN generated; glossary pipeline                          |
| `openclaw-channels`          | `src/{telegram,discord,slack,signal,imessage,web}/**`, `extensions/{msteams,matrix,zalo,zalouser,voice-call}/**` | Channel-routing patterns, extension conventions             |
| `openclaw-parallels-macos`   | `scripts/package-mac-app.sh`, `apps/macos/**`, anything matching `parallels-macos`                               | macOS smoke playbook, snapshot naming, log paths            |
| `openclaw-parallels-windows` | (similar to macos)                                                                                               | Windows smoke notes                                         |
| `openclaw-parallels-linux`   | (similar)                                                                                                        | Linux smoke notes                                           |
| `openclaw-release`           | `CHANGELOG.md`, `package.json` version lines, `appcast.xml`                                                      | Release gates, beta naming, publish flow                    |
| `openclaw-ghsa`              | `.github/security-advisories/**`, SECURITY.md                                                                    | GHSA patch/publish rules                                    |
| `openclaw-exedev`            | (none — manual trigger only)                                                                                     | exe.dev VM ops                                              |
| `openclaw-voice`             | `VoiceWakeForwarder*`, `apps/macos/**/Voice*`                                                                    | Voice wake forwarding tips                                  |

Each skill is a markdown file under `~/.claude/skills/<skill-name>/SKILL.md`. Frontmatter:

```markdown
---
name: openclaw-docs-mintlify
description: Mintlify linking rules for OpenClaw docs — root-relative internal links, no .md suffix, anchor conventions, alphabetical ordering
paths:
  - "docs/**/*.md"
  - "docs/**/*.mdx"
---

# Body content moves here verbatim from CLAUDE.md
```

Result: `CLAUDE.md` shrinks to "What we work on, what matters, what never to do" — the always-on rules. Contextual rules load only when the model touches matching files.

### C2 — Dynamic Context via `!`command`` Injection

Skills can embed shell commands in backticks prefixed with `!`. The command runs before the model sees the prompt, and the output replaces the backticks.

Proposed skills with dynamic injection:

**`openclaw-status-live`** — `paths: ["src/**", "extensions/**"]`:

```markdown
---
name: openclaw-status-live
description: Live openclaw gateway and channel status — use when diagnosing service issues
paths:
  - "src/gateway/**"
  - "src/channels/**"
  - "extensions/**"
---

## Current Gateway Status

!`openclaw gateway status --deep --require-rpc 2>&1 | head -30`

## Channel Status

!`openclaw channels status --probe 2>&1 | head -40`

## Recent Gateway Log

!`tail -n 40 /tmp/openclaw-gateway.log 2>/dev/null || echo "no local gateway log"`
```

**`openclooda-memory-health`** — `paths: ["extensions/memory-ooda/**", "extensions/memory-lancedb/**"]`:

```markdown
---
name: openclooda-memory-health
description: Current OODA memory health — archivist state, knowledge counts, pending proposals
paths:
  - "extensions/memory-ooda/**"
  - "extensions/memory-lancedb/**"
---

## Archivist State

!`cat ~/.openclaw/workspace/.archivist-state.json 2>/dev/null | jq .`

## Pending Proposals

!`openclaw workspace proposals list --pending 2>&1 | head -20`

## Memory Store Stats

!`openclaw ltm stats 2>&1`
```

Security note: `!`command``injection is disabled for third-party skills via the existing`disableSkillShellExecution` setting. These skills ship first-party.

### C3 — UserPromptSubmit Status Hook

New hook in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "bash $HOME/.claude/hooks/openclaw-status-inject.sh"
          }
        ]
      }
    ]
  }
}
```

Script `~/.claude/hooks/openclaw-status-inject.sh` emits a small context block only when the current `cwd` contains an openclaw or openclooda checkout:

```bash
#!/usr/bin/env bash
cwd="$(pwd)"
case "$cwd" in
  */openclaw*|*/openclooda*) ;;
  *) exit 0 ;;
esac

gateway=$(openclaw gateway status --require-rpc 2>/dev/null | head -1 || echo "unknown")
pending=$(openclaw workspace proposals list --pending 2>/dev/null | grep -c "^-" || echo 0)
archivist_due=$(jq -r '.turns_since_last_archivist // 0' ~/.openclaw/workspace/.archivist-state.json 2>/dev/null || echo 0)

cat <<EOF
<openclaw-ambient>
gateway=$gateway, pending_proposals=$pending, archivist_turns_since_last=$archivist_due
</openclaw-ambient>
EOF
```

Limits:

- Only fires in relevant cwds — avoids polluting unrelated projects.
- Output capped at 6 lines.
- Non-blocking: timeout 500 ms, fails silent.

### C4 — SessionStart Hook for Repo Snapshot

Complement UserPromptSubmit with a once-per-session SessionStart injector that reports: branch, uncommitted-file count, top 3 recent commits. Eliminates the "what's the branch state?" preamble on every new session.

### C5 — Stop Hook for Auto-Memory Capture

New Stop hook in settings.json invokes `~/.claude/hooks/openclaw-memory-capture.sh` which:

1. Reads the last N turns of the session transcript.
2. Runs a lightweight regex/extractor looking for "you corrected me" / "I verified" / "wrong, actually" / explicit `[saves memory:...]` patterns.
3. Appends any findings to `~/.claude/projects/-Users-michaelpeter-Projects-src-openclaw/memory/MEMORY.md` via `openclaw workspace memory capture <file>`.

Guards:

- Never runs if `MEMORY.md` last-modified-time is within 30 seconds (avoids double-capture on quick session restart).
- Rate-limited: at most one capture per 5-minute window.
- Dry-run mode available via `OPENCLAW_MEMORY_CAPTURE_DRY=1` env var for debugging.

### C6 — Skill-Scoped Hooks for `/commit` and `/release`

Leverage the new skill-scoped hook feature (Claude Code 2025-2026):

```markdown
---
name: commit-with-check
description: Stage and commit with automatic pnpm check gate
hooks:
  PreToolUse:
    - matcher: "Bash"
      if_tool_input_contains: "git commit"
      run: "pnpm check"
      on_fail: block
---
```

Activated by explicit invocation (`/commit`). Runs `pnpm check` before any `git commit` proceeds; blocks on failure. Doesn't touch global settings.

Similar pattern for `/release`: pre-tag hook runs `pnpm test:install:smoke` and `node --import tsx scripts/release-check.ts`.

### C7 — CLAUDE.md Slim-Down

After C1–C6 land, `openclaw/CLAUDE.md` should shrink to sections:

1. What OpenClaw is (one paragraph).
2. Hard rules (never amend; never force-push main; never edit security CODEOWNERS).
3. Always-on conventions (American spelling; Conventional Commits).
4. Pointer list: "Docs rules: see `openclaw-docs-mintlify` skill. Channels: see `openclaw-channels`. Release: see `openclaw-release`. etc."

Target size: **under 200 lines** (from current ~700+).

### C8 — Rollout

Stage over 3 phases:

**Phase 1 (reversible):** Add UserPromptSubmit + SessionStart + Stop hooks. No CLAUDE.md changes yet. Validate that ambient context + auto-capture work.

**Phase 2:** Extract one scoped section (docs/Mintlify) into a skill with `paths:`. Observe context usage. Iterate on frontmatter until activation is reliable.

**Phase 3:** Migrate the remaining sections in waves. Update CLAUDE.md to remove extracted content.

Each phase is reversible — skills are additive, hooks can be disabled per-user in settings.

---

## Acceptance Criteria

- [ ] At least 8 of the skills from C1 exist under `~/.claude/skills/` with valid frontmatter.
- [ ] `openclaw-status-live` and `openclooda-memory-health` demonstrably include live output when activated.
- [ ] UserPromptSubmit hook injects `<openclaw-ambient>` block in openclaw/openclooda cwds, does not inject elsewhere.
- [ ] SessionStart hook fires once per session; output ≤6 lines.
- [ ] Stop hook captures "you were right" / "I verified" moments to MEMORY.md in dry-run; live mode gated behind user opt-in.
- [ ] `/commit` skill runs `pnpm check` before `git commit` and blocks on non-zero exit.
- [ ] `openclaw/CLAUDE.md` reduced to ≤200 lines without losing enforcement of any current rule (all rules either remain global or moved to an activated skill).

---

## Risk and Open Questions

1. **Skill activation reliability.** `paths:` matching is best-effort. A glob pattern that should activate a skill may miss. Mitigation: log skill activations to `~/.claude/logs/skill-activation.jsonl` during rollout; review after 14 days and tighten patterns.
2. **Hook latency.** SessionStart + UserPromptSubmit + Stop hooks add wall-clock time to every turn boundary. Each script has a 500 ms timeout; if any hook consistently breaches, demote to a less frequent schedule (e.g. Stop hook runs only on long sessions).
3. **Shell-out security.** `!`command``and hooks execute shell commands. All scripts under`~/.claude/hooks/`should be readable-only by owner,`chmod 700`. Audit monthly. Never ship third-party hooks without review.
4. **Cross-device.** This CR modifies `~/.claude/` which doesn't sync across machines. Ship a bootstrap script `scripts/setup-claude-dir.sh` in openclooda that idempotently installs skills + hooks from a repo-checked-in source tree (`tools/claude/`).
5. **Breakage of existing manual workflows.** Users relying on the current CLAUDE.md for at-a-glance rules will need to adapt. Mitigation: `openclaw-rules` skill with `paths: ["**/*"]` acts as a lightweight "pointer index" — tells the model where to look when confused.
6. **MCP and subagent skills still out of scope.** Followup CR for `context: fork` forked subagent skills is deferred. This CR focuses on always-on context discipline.
