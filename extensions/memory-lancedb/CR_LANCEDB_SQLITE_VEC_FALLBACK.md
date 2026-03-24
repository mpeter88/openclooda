# CR: LanceDB sqlite-vec Fallback for Intel Mac

**Date:** 2026-03-18  
**Status:** WRITTEN  
**Priority:** P0 — LanceDB is completely broken on Intel Mac; all Tier 2 capture and recall silently fails  
**Discovered:** OODA meta-check — `@lancedb/lancedb-darwin-x64` dropped after 0.22.3; machine is Intel Core i7

---

## Problem

`@lancedb/lancedb` 0.26.2 does not ship a `darwin-x64` native binding. The last version with Intel Mac support was 0.22.3. On an Intel Mac:

```
Error: memory-lancedb: failed to load LanceDB.
Error: Cannot find module '@lancedb/lancedb-darwin-x64'
```

This silently breaks all Tier 2 episodic memory:

- `autoCapture` — no events written, Archivist has nothing to read
- `autoRecall` — no memories recalled, context injection fails
- `memory_store` tool — fails silently
- `memory_recall` tool — fails silently

The Archivist fires every 10 turns but finds an empty store and writes nothing to KNOWLEDGE.json.

---

## Context

The OpenClaw core memory system (`src/memory/`) already uses `sqlite-vec` successfully on the same machine — `~/.openclaw/memory/main.sqlite` exists with 8 chunks, 23 cached embeddings. The `sqlite-vec` npm package is already a dependency. This is not a new dependency — it's infrastructure already proven to work on this hardware.

The spec (`OODA-AGENT-SPEC.md`, Open Question #6) anticipated this:

> "LanceDB macOS native bindings... If this is still a blocker on the target platform, we may need to consider sqlite-vec as a fallback."

---

## Fix

### F1 — Detect LanceDB availability at startup (CRITICAL)

In `extensions/memory-lancedb/index.ts`, the `loadLanceDB()` function already catches the import error. Extend it to set a module-level flag:

```typescript
let lancedbAvailable: boolean | null = null; // null = untested

const loadLanceDB = async () => {
  try {
    const mod = await import("@lancedb/lancedb");
    lancedbAvailable = true;
    return mod;
  } catch (err) {
    lancedbAvailable = false;
    throw new Error(`memory-lancedb: failed to load LanceDB. ${String(err)}`, { cause: err });
  }
};
```

### F2 — Implement SqliteVecDB as a drop-in MemoryDB replacement (CRITICAL)

Add a `SqliteVecMemoryDB` class alongside the existing `MemoryDB` class that implements the same interface using `sqlite-vec` + `node:sqlite`:

```typescript
class SqliteVecMemoryDB {
  // Same public interface as MemoryDB:
  // store(entry), search(vector, limit, threshold), delete(id),
  // retrieveSince(ts, limit), markProcessed(id), prune(ts, onlyProcessed), count()
  // Uses:
  // - node:sqlite (Node 22 built-in)
  // - sqlite-vec npm package (already in deps)
  // - Same dbPath from config, different filename: 'memories.sqlite' alongside main.sqlite
}
```

Key implementation details:

- DB file: `{dbPath}/memories.sqlite` (separate from `main.sqlite` to avoid schema conflicts)
- Vector table: `CREATE VIRTUAL TABLE memories_vec USING vec0(vector float[{dim}])`
- Metadata table: standard `memories` table with same columns as LanceDB schema
- `search()`: `SELECT * FROM memories_vec WHERE vector MATCH ? ORDER BY distance LIMIT ?`
- `retrieveSince()`: standard SQL `WHERE createdAt > ?`
- `markProcessed()` / `prune()`: standard SQL UPDATE/DELETE

### F3 — Factory function to select backend (CRITICAL)

```typescript
async function createMemoryBackend(
  dbPath: string,
  vectorDim: number,
): Promise<MemoryDB | SqliteVecMemoryDB> {
  try {
    await loadLanceDB();
    return new MemoryDB(dbPath, vectorDim);
  } catch {
    // LanceDB unavailable (Intel Mac, missing native binding, etc.)
    // Fall back to sqlite-vec — same functionality, pure JS + native sqlite
    return new SqliteVecMemoryDB(dbPath, vectorDim);
  }
}
```

### F4 — Log which backend is active (LOW)

On plugin startup, log the selected backend:

```
memory-lancedb: using LanceDB backend (db: /path/to/lancedb)
```

or

```
memory-lancedb: LanceDB unavailable on this platform, using sqlite-vec fallback (db: /path/to/memories.sqlite)
```

---

## Files Changed

| File                                 | Change                                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------- |
| `extensions/memory-lancedb/index.ts` | F1: detect availability flag; F2: SqliteVecMemoryDB class; F3: factory; F4: startup log |

No other files changed. The OODA interface methods (`retrieveSince`, `markProcessed`, `prune`) must be implemented on `SqliteVecMemoryDB` as well.

---

## Schema

`memories.sqlite` tables:

```sql
-- Metadata
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  importance REAL NOT NULL DEFAULT 0.7,
  category TEXT NOT NULL DEFAULT 'other',
  createdAt INTEGER NOT NULL,
  source TEXT,
  actionId TEXT,
  archivistProcessed INTEGER NOT NULL DEFAULT 0
);

-- Vector index (sqlite-vec)
CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
  vector float[{dim}]
);
```

Inserts maintain both tables in a transaction. Deletes cascade manually (sqlite-vec doesn't support foreign keys).

---

## Test Cases

1. **LanceDB available** — MemoryDB selected, existing behavior unchanged
2. **LanceDB unavailable** — SqliteVecMemoryDB selected, store/search/retrieve all work
3. **Round-trip** — store entry, search by vector, retrieve by timestamp, markProcessed, prune
4. **OODA fields** — `archivistProcessed`, `source`, `actionId` correctly persisted and queried
5. **Archivist integration** — after fix, Archivist finds events and writes to KNOWLEDGE.json

---

## Notes

- `sqlite-vec` is already in `package.json` (used by core memory system)
- `node:sqlite` is a Node 22 built-in — no new npm dep needed
- The existing `main.sqlite` uses a different schema (chunks/files model for document search) — do NOT use that file; create a new `memories.sqlite` with the simpler entry-per-memory schema
- After this CR, the `lancedbAvailable: false` log warning should be replaced by the sqlite-vec fallback log (F4) so it's informational rather than alarming
