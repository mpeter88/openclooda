# CR_ARCHIVIST_REQUEST_CONTEXT

**Status:** PENDING  
**Priority:** P1  
**Problem:** The archivist currently calls the Anthropic API directly via raw HTTP using a hardcoded `sk-ant-...` key read from `auth-profiles.json`. This is wrong for three reasons:

1. **Provider coupling** — only works with direct Anthropic. Users on Vertex, OpenAI, Ollama, or any other provider will fail silently.
2. **Bypasses gateway routing** — cost tracking, rate limiting, fallbacks, and model overrides are all skipped.
3. **Hardcoded model** — `claude-3-haiku-20240307` ignores whatever the operator has configured.

**Root cause:** `api.runtime.subagent` is only available during a gateway request context. The archivist fires in `setImmediate` after `agent_end` — outside that context. Direct HTTP was the expedient workaround.

**Decision:** Use `before_agent_start` + `enqueueSystemEvent` to run the archivist inside the request context.

---

## Design

### Trigger (agent_end)

When the archivist is due, instead of firing `setImmediate`, enqueue a system event into the current session:

```ts
api.runtime.system.enqueueSystemEvent("[OODA_ARCHIVIST_RUN]", { sessionKey });
```

This injects a silent system event into the next prompt. The user never sees it — `before_agent_start` intercepts and handles it before normal context injection.

### Handler (before_agent_start)

At the very top of the `before_agent_start` hook, before any context assembly:

```ts
if (event.prompt.includes("[OODA_ARCHIVIST_RUN]")) {
  await runArchivistInContext(workspacePath, callModel, ...);
  return undefined; // no context injection, no user-visible output
}
```

Returning `undefined` from `before_agent_start` means no `prependSystemContext` — the agent model receives a normal empty-prompt turn, processes it, and returns. The user sees nothing unusual.

### callModel inside request context

With execution inside `before_agent_start`, `api.runtime.subagent` is available:

```ts
const callModel: ModelCallFn = async (prompt) => {
  const sessionKey = `ooda-archivist-${Date.now()}`;
  const { runId } = await api.runtime.subagent.run({
    sessionKey,
    idempotencyKey: sessionKey,
    message: prompt,
    extraSystemPrompt: "You are an OODA reasoning agent. Respond with raw JSON only.",
    deliver: false,
  });
  const result = await api.runtime.subagent.waitForRun({ runId, timeoutMs: 120_000 });
  if (result.status !== "ok") throw new Error(`subagent failed: ${result.status}`);
  const { messages } = await api.runtime.subagent.getSessionMessages({ sessionKey, limit: 5 });
  // extract last assistant text block
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown>;
    if (msg.role === "assistant") {
      if (typeof msg.content === "string") return msg.content;
      if (Array.isArray(msg.content)) {
        for (const block of [...(msg.content as unknown[])].reverse()) {
          const b = block as Record<string, unknown>;
          if (b.type === "text" && typeof b.text === "string") return b.text;
        }
      }
    }
  }
  throw new Error("No assistant reply in subagent session");
};
```

This routes through Vertex (or whatever the gateway uses). No raw HTTP, no provider coupling, no hardcoded keys.

---

## Files Changed

| File                              | Change                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| `extensions/memory-ooda/index.ts` | `agent_end`: replace `setImmediate(runArchivist)` with `enqueueSystemEvent`          |
| `extensions/memory-ooda/index.ts` | `before_agent_start`: add marker intercept at top, run archivist, return `undefined` |
| `extensions/memory-ooda/index.ts` | `callModel`: replace direct HTTP fetch with `api.runtime.subagent` pattern           |
| `README.md`                       | Remove "archivist requires direct Anthropic key" section — no longer true            |

---

## What doesn't change

- `runArchivist()` in `archivist.ts` — unchanged. Pure function, takes `callModel` as param.
- The trigger logic (`shouldRunArchivist`, `turns_since_last_archivist`) — unchanged.
- All other hooks (triage, strategy, council, meta-reviewer) — unchanged. They already use `callModel` inside `before_agent_start` where subagent is available.
- Health telemetry (`pingHealth`, `pingHealthError`) — unchanged.

---

## Edge cases

**What if the user sends a message that contains `[OODA_ARCHIVIST_RUN]`?**  
Archivist runs silently instead of the normal response. Acceptable — this string is unlikely in practice. If it becomes a concern, use a UUID-tagged marker: `[OODA_ARCHIVIST_RUN:${randomUUID()}]` stored in a module-level Set and validated.

**What if the session ends before the system event is consumed?**  
The event is in-memory only (`enqueueSystemEvent` is ephemeral). It's lost on gateway restart. The archivist will retry on the next trigger (next time `turns_since_last_archivist >= interval`). No data loss.

**What if the subagent call times out or fails?**  
Same as current behavior — `fromFallback: true`, events stay unprocessed, retry on next trigger.

---

## Why not Option A (cron-based isolated session)?

The write-back problem: in a fully isolated cron session, the archivist's results need to be communicated back to the plugin. The current architecture has `runArchivist()` write KNOWLEDGE.json directly — that works because it's in-process. A cron session would need to call `openclaw workspace` CLI commands or write files directly from within an agent turn, which is messier and harder to test.

The system-event approach keeps `runArchivist()` in-process (it executes inside `before_agent_start` on the same gateway process) while still using the request-scoped `api.runtime.subagent` for the LLM call.
