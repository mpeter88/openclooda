# OpenCLOODA

Cognitive OODA agent layer for [OpenClaw](https://github.com/openclaw/openclaw). Transforms the flat Observe-Plan-Act agent loop into a stateful, goal-oriented system with tri-tier memory, structured decision-making, and self-correcting learning.

## What it does

OpenClaw is a multi-channel AI gateway that connects to WhatsApp, Telegram, Discord, Slack, and 30+ other surfaces. By default, every turn runs one model call: observe input, plan, act.

OpenCLOODA adds a reasoning chain on top:

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
  types.ts              # Canonical type definitions
  triage.ts             # Phase A: lightweight model produces SITREP
  strategy.ts           # Phase B: decision matrix + scoring
  valuation-engine.ts   # V = sum(Si x Wi) scoring math
  meta-reviewer.ts      # Double-loop: outcome tracking + weight adjustment
  archivist.ts          # Tier 2 -> Tier 3 distillation
  semantic-memory.ts    # KNOWLEDGE.json read/write/format
  priorities.ts         # PRIORITIES.json read/write/weight updates
  snapshot.ts           # Timestamped backup/restore for safe writes
  proposals.ts          # Policy proposal CRUD
  parse-utils.ts        # Shared JSON parsing utilities
  cli.ts                # `openclaw workspace` commands

cr/
  CR_FULL_SYSTEM_PEER_REVIEW.md   # 24-finding peer review
  STATUS.md                        # CR tracking
```

## Architecture

All OODA code lives in a single directory (`extensions/memory-ooda/`) and integrates with OpenClaw through the plugin hook system:

- `before_agent_start` -- runs triage, injects SITREP + strategy into context
- `agent_end` -- outcome tracking, meta-reviewer
- Timer/interval -- archivist distillation (Tier 2 to Tier 3)

OpenCLOODA depends on the `memory-lancedb` plugin for Tier 2 episodic storage and embedding (OpenAI `text-embedding-3-small`).

> **Future goal:** Extract into a standalone installable plugin (`npm install openclooda`). Currently developed as a fork of the OpenClaw repo.

## Setup

This is a fork of OpenClaw with the OODA layer added. Clone and run it like OpenClaw:

```bash
git clone https://github.com/mpeter88/openclooda.git
cd openclooda
pnpm install
pnpm build
```

### Run tests

```bash
# OODA-specific tests (279 tests)
pnpm test -- extensions/memory-ooda/

# Full suite
pnpm test
```

### Configuration

OpenCLOODA uses two plugins that need configuration in `openclaw.json`:

**1. memory-ooda** -- the OODA reasoning chain and semantic memory (Tier 3)

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

**2. memory-lancedb** -- episodic memory (Tier 2) with vector embeddings

The episodic tier stores conversation memories as vectors in LanceDB and retrieves them via similarity search. It needs an embedding provider:

```json
{
  "extensions": {
    "memory-lancedb": {
      "embedding": {
        "apiKey": "${OPENAI_API_KEY}",
        "model": "text-embedding-3-small"
      },
      "autoCapture": true,
      "autoRecall": true
    }
  }
}
```

**Embedding options:**

| Setting                | Default                      | Description                                |
| ---------------------- | ---------------------------- | ------------------------------------------ |
| `embedding.apiKey`     | (required)                   | OpenAI API key, or use `${ENV_VAR}` syntax |
| `embedding.model`      | `text-embedding-3-small`     | Embedding model (1536 dims)                |
| `embedding.baseUrl`    | OpenAI API                   | Override for compatible providers          |
| `embedding.dimensions` | Auto from model              | Required for non-standard models           |
| `dbPath`               | `~/.openclaw/memory/lancedb` | LanceDB storage location                   |

**Using a local/alternative embedding provider:**

Any OpenAI-compatible embeddings endpoint works. For example, with Ollama:

```json
{
  "extensions": {
    "memory-lancedb": {
      "embedding": {
        "apiKey": "not-needed",
        "model": "nomic-embed-text",
        "baseUrl": "http://localhost:11434/v1",
        "dimensions": 768
      }
    }
  }
}
```

**Agent model configuration** is handled by OpenClaw's standard provider system -- configure your preferred LLM provider (Anthropic, OpenAI, Ollama, etc.) in the `connections` section of `openclaw.json`. The OODA triage and strategy phases use whatever model OpenClaw routes to. See the [OpenClaw docs](https://docs.openclaw.ai/configuration) for provider setup.

**Archivist model (required):** The archivist runs outside the gateway request context (in `setImmediate` after `agent_end`) and therefore cannot use the gateway's model stack. It calls the Anthropic API directly using `claude-3-haiku-20240307`. You must have a direct Anthropic API key configured in OpenClaw's auth profiles:

```bash
# Check if you already have one:
cat ~/.openclaw/agents/main/agent/auth-profiles.json | grep -A2 'anthropic:default'
```

If not, run `openclaw setup` or add it via the OpenClaw connections wizard. The key is stored at `~/.openclaw/agents/main/agent/auth-profiles.json` under `profiles.anthropic:default.key`. Note: this is separate from any Vertex AI or other provider you may use for the main agent.

### CLI commands

```bash
# Health check — run this first if anything seems off
openclaw ooda doctor                         # Full health report (green/yellow/red per subsystem)
openclaw ooda doctor --json                  # Machine-readable output
openclaw ooda doctor --alert-only            # Silent if healthy, output only on problems

# Workspace
openclaw workspace status                    # Knowledge + priorities overview
openclaw workspace proposals list --pending  # Review pending policy proposals
openclaw workspace proposals approve <id>    # Approve a proposal
openclaw workspace proposals reject <id>     # Reject a proposal
openclaw workspace rollback list             # Show available snapshots
openclaw workspace rollback restore knowledge  # Restore KNOWLEDGE.json
openclaw workspace rollback restore priorities # Restore PRIORITIES.json
```

**Tip:** If `openclaw ooda doctor` shows subsystems as "never fired" after setup, the most common cause is a plugin loading issue. Check `openclaw plugins list` and verify `memory-ooda` shows status `loaded`. If it shows `error`, run `openclaw gateway restart` and check the logs.

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

All 7 PRs from the spec are implemented, peer-reviewed (24 findings addressed), and consolidated into a single plugin directory.

| PR  | Description                        | Status |
| --- | ---------------------------------- | ------ |
| 1   | Tier 3 semantic memory             | Done   |
| 2   | Tier 2 episodic memory extensions  | Done   |
| 3   | Triage phase                       | Done   |
| 4   | Decision matrix + VALUATION_ENGINE | Done   |
| 5   | Archivist cron                     | Done   |
| 6   | Meta-Reviewer + outcome tracking   | Done   |
| 7   | Feature flag removal + CLI         | Done   |
| CR  | Peer review (24 findings)          | Done   |
| --  | Plugin extraction (standalone)     | Done   |

## Spec

The full specification is in [OODA-AGENT-SPEC.md](OODA-AGENT-SPEC.md).

## License

MIT
