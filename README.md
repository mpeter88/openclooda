# OpenClOODA

Cognitive OODA agent layer for [OpenClaw](https://github.com/openclaw/openclaw). Transforms the flat Observe-Plan-Act agent loop into a stateful, goal-oriented system with tri-tier memory, structured decision-making, and self-correcting learning.

## What it does

OpenClaw is a multi-channel AI gateway that connects to WhatsApp, Telegram, Discord, Slack, and 30+ other surfaces. By default, every turn runs one model call: observe input, plan, act.

OpenClOODA adds a reasoning chain on top:

```
Observation
    |
    v
[Triage] -----> priority < threshold? --> skip, fast response
    |
    v
[Strategy] --> 2-4 candidates scored on alignment x efficiency x risk
    |
    v
[Executive] --> acts with outcome tracking
    |
    v
[Meta-Reviewer] <-- learns from failures, adjusts weights
    |
    v
[Archivist] <-- distills episodic memory into permanent facts
```

Low-priority messages get fast, cheap responses. High-priority work goes through the full reasoning chain with structured decision-making and outcome tracking.

## Key concepts

### Tri-tier memory

| Tier         | Store             | Lifetime         | Updated by     |
| ------------ | ----------------- | ---------------- | -------------- |
| **Working**  | In-context (RAM)  | Current turn     | Agent          |
| **Episodic** | LanceDB vector DB | 90 days (pruned) | Agent          |
| **Semantic** | `KNOWLEDGE.json`  | Permanent        | Archivist only |

The semantic tier accumulates a distilled model of the user: tech stack, projects, people, preferences, commitments. The agent remembers who you are, not just what you said last session.

### VALUATION_ENGINE

Every non-trivial action is one of four strategy archetypes, scored on three axes:

```
V = (alignment x 0.40) + (efficiency x 0.35) + (risk x 0.25)
```

- **aggressive_fix** -- Act immediately with full effort
- **delegate_task** -- Route to another person or agent
- **strategic_delay** -- Defer until a better moment
- **minimal_viable_action** -- Do the smallest unblocking thing

### Double-loop learning

**Archivist** (every N turns): Reads episodic events from LanceDB, extracts stable patterns, upserts them into KNOWLEDGE.json.

**Meta-Reviewer** (on critical failures): Detects when the agent's decisions consistently fail, proposes policy changes, adjusts domain weights. All policy changes require explicit user approval.

## Project structure

```
extensions/memory-ooda/
  index.ts              # Plugin entry point (hooks, CLI, service)
  semantic-memory.ts    # KNOWLEDGE.json read/write/format
  priorities.ts         # PRIORITIES.json read/write/weight updates
  snapshot.ts           # Timestamped backup/restore for safe writes
  proposals.ts          # Policy proposal CRUD
  archivist.ts          # Tier 2 -> Tier 3 distillation
  cli.ts                # `openclaw workspace` commands
  types.ts              # Canonical type definitions

src/agents/ooda/
  triage.ts             # Phase A: lightweight model produces SITREP
  strategy.ts           # Phase B: decision matrix + scoring
  valuation-engine.ts   # V = sum(Si x Wi) scoring math
  meta-reviewer.ts      # Double-loop: outcome tracking + weight adjustment
  parse-utils.ts        # Shared JSON parsing utilities

cr/
  CR_FULL_SYSTEM_PEER_REVIEW.md   # 24-finding peer review
  STATUS.md                        # CR tracking
```

## Setup

OpenClOODA is built as a plugin for OpenClaw. It requires the OpenClaw repo as a baseline.

```bash
git clone https://github.com/mpeter88/openclooda.git
cd openclooda
pnpm install
pnpm build
```

### Run tests

```bash
# OODA-specific tests (279 tests)
pnpm test -- extensions/memory-ooda/ src/agents/ooda/

# Full suite
pnpm test
```

### Configuration

The plugin is enabled by default. Configure in `openclaw.json`:

```json
{
  "extensions": {
    "memory-ooda": {
      "enabled": true,
      "workspacePath": "~/.openclaw/workspace",
      "notifyPendingProposals": true
    }
  }
}
```

### CLI commands

```bash
openclaw workspace status                    # Health overview
openclaw workspace proposals list --pending  # Review pending policy proposals
openclaw workspace proposals approve <id>    # Approve a proposal
openclaw workspace proposals reject <id>     # Reject a proposal
openclaw workspace rollback list             # Show available snapshots
openclaw workspace rollback restore knowledge  # Restore KNOWLEDGE.json
openclaw workspace rollback restore priorities # Restore PRIORITIES.json
```

## Runtime files

```
~/.openclaw/workspace/
  KNOWLEDGE.json            # Tier 3 semantic memory
  PRIORITIES.json           # Domain weights + scoring rubric
  .archivist-state.json     # Archivist execution state
  .policy-proposals.json    # Pending policy proposals
  .snapshots/               # Timestamped backups
```

## Safety invariants

- The Executive model never writes to KNOWLEDGE.json or PRIORITIES.json
- The Archivist never writes to PRIORITIES.json
- The Meta-Reviewer never writes to KNOWLEDGE.json
- The Meta-Reviewer never modifies SOUL.md without user approval
- All writes are snapshot-protected; auto-restores on corruption
- Weights are clamped [0.1, 1.0] with max delta 0.05 per adjustment
- Minimum 10 observations required before any weight change

## Implementation status

All 7 PRs from the spec are implemented. A 24-finding peer review has been completed and all findings addressed.

| PR  | Description                        | Status      |
| --- | ---------------------------------- | ----------- |
| 1   | Tier 3 semantic memory (extension) | Done        |
| 2   | Tier 2 episodic memory extensions  | Done        |
| 3   | Triage phase (core)                | Done        |
| 4   | Decision matrix + VALUATION_ENGINE | Done        |
| 5   | Archivist cron                     | Done        |
| 6   | Meta-Reviewer + outcome tracking   | Done        |
| 7   | Feature flag removal + CLI         | Done        |
| CR  | Peer review (24 findings)          | Implemented |

## Spec

The full specification is in [OODA-AGENT-SPEC.md](OODA-AGENT-SPEC.md).

## License

MIT
