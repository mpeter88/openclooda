# CR Status Log

**Last updated:** 2026-03-16 (CR findings implemented)
**Branch:** `main`

## Status Key

| Status        | Meaning                             |
| ------------- | ----------------------------------- |
| `WRITTEN`     | Spec delivered, not yet implemented |
| `VERIFIED`    | Claims verified against source code |
| `IMPLEMENTED` | All items implemented               |
| `PARTIAL`     | Some items done, some deferred      |
| `SUPERSEDED`  | Replaced by newer CR                |
| `REJECTED`    | Claims verified as incorrect        |

## Active CRs

| CR                           | Date       | Status        | Items                         | Notes                                                             |
| ---------------------------- | ---------- | ------------- | ----------------------------- | ----------------------------------------------------------------- |
| `CR_FULL_SYSTEM_PEER_REVIEW` | 2026-03-16 | `IMPLEMENTED` | 24 findings (3C, 6H, 11M, 4L) | All 24 findings fixed. 279 tests pass (was 256). M6/M11 deferred. |

## Deferred Items

- **M6** (`upsertFact` turn count): Adding `currentTurn` param would break the SemanticStore interface across all callers. Deferred to next API iteration.
- **M11** (logger injection): Requires threading an `OodaLogger` interface through all `run*()` functions. Deferred as a cross-cutting concern for post-MVP.

## Verification Protocol

At session start:

- [ ] `pnpm test -- extensions/memory-ooda/` — all 279 tests pass
- [ ] `git log --oneline` — PRs 1-7 present on `main`
- [ ] Review `STATUS.md` for outstanding items
