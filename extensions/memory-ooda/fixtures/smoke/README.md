# Smoke Fixtures

Shared fixtures for CR_BATCH_A_TO_E_SMOKE_TESTS probes.

Fixtures are created on-demand by each test file (via `fs.mkdtempSync`) — this
directory stores **long-lived templates** for the more complex probes (admission
corpus, axis-fixtures, episodic seed, sitrep seed).

## Files

- `episodic-seed.jsonl` — 30-event seed covering all domains and outcomes. Used by
  archivist, trajectory, and axis-prior probes.
- `sitrep-seed.jsonl` — 15 SITREPs with known priorities. Used by trajectory
  shadow/live probes and council-simulate.
- `axis-fixtures.json` — 10 hand-labeled failure events per `ErrorAxis` (5 axes ×
  10 fixtures = 50 labeled rows). Used by `openclaw workspace errors classify --report`.

## Populating

Empty by default — smoke probes create their own synthetic data. Real fixtures
are captured from live sessions via `openclaw workspace admission capture` and
promoted here manually.
