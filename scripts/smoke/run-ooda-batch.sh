#!/usr/bin/env bash
# Smoke harness — runs the full memory-ooda unit test suite.
# Covers every module introduced in CR batches A–E.
#
# Usage: scripts/smoke/run-ooda-batch.sh [--json]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

JSON_OUT=""
if [ "${1:-}" = "--json" ]; then
  JSON_OUT="/tmp/ooda-smoke-$(date +%s).json"
fi

TESTS=(
  # Foundation
  "extensions/memory-ooda/semantic-memory.test.ts"
  "extensions/memory-ooda/bitemporal.test.ts"
  # Archivist + Beliefs
  "extensions/memory-ooda/archivist.test.ts"
  "extensions/memory-ooda/crud-classifier.test.ts"
  "extensions/memory-ooda/beliefs.test.ts"
  # Trajectory V2 + Triage
  "extensions/memory-ooda/triage.test.ts"
  "extensions/memory-ooda/trajectory-audit.test.ts"
  # Grounded Eval V2
  "extensions/memory-ooda/grounded-harness.test.ts"
  # Error Taxonomy
  "extensions/memory-ooda/error-classifier.test.ts"
  # Change Gate
  "extensions/memory-ooda/change-gate.test.ts"
  # Council + Adaptive Chair
  "extensions/memory-ooda/council.test.ts"
  "extensions/memory-ooda/council-discipline.test.ts"
  "extensions/memory-ooda/adaptive-chair.test.ts"
  # Path C: content-hash + write-gate
  "extensions/memory-ooda/content-hash.test.ts"
  "extensions/memory-ooda/content-hash-integration.test.ts"
  "extensions/memory-ooda/write-gate.test.ts"
  # Meta-reviewer gate path (CR_OODA_PASS_K_ACCEPTANCE_GATE task 3d)
  "extensions/memory-ooda/meta-reviewer.test.ts"
  # Gate CLI (workspace gate status/history)
  "extensions/memory-ooda/gate-cli.test.ts"
  # Observability CLI (distortion/trajectory/errors)
  "extensions/memory-ooda/observability-cli.test.ts"
  # Emotional tagging (priority-weighted memory)
  "extensions/memory-ooda/emotional-tagging.test.ts"
  # DMN integration loop (tapered idle-state work scheduler)
  "extensions/memory-ooda/dmn.test.ts"
  # Pattern separation (MinHash + band classifier + Discriminator)
  "extensions/memory-ooda/pattern-separation.test.ts"
  # Cross-plugin SITREP sidecar
  "extensions/memory-ooda/turn-sitrep-sidecar.test.ts"
  # Cross-plugin separation scan (near-duplicate lookup for Discriminator)
  "extensions/memory-ooda/separation-scan.test.ts"
  # DMN LLM-backed work units (retrospective chair, rehearsal, pattern distill)
  "extensions/memory-ooda/dmn-llm.test.ts"
  # MinHash cross-plugin byte-equivalence contract
  "extensions/memory-ooda/min-hash-contract.test.ts"
  # Integration harness — real disk, real modules, fake callModel
  "extensions/memory-ooda/integration.test.ts"
  # DMN scheduler timer lifecycle
  "extensions/memory-ooda/dmn-scheduler.test.ts"
  # Causal retrieval (antecedent lookup)
  "extensions/memory-ooda/causal-retrieval.test.ts"
  # Learned forgetting (usefulness-based prune)
  "extensions/memory-ooda/learned-forgetting.test.ts"
  # Workspace CLI — admission/knowledge/beliefs/soul
  "extensions/memory-ooda/workspace-cli.test.ts"
)

echo "→ Running OODA batch smoke test (${#TESTS[@]} suites)"
echo

if [ -n "$JSON_OUT" ]; then
  node_modules/.bin/vitest run --no-coverage --reporter=json --outputFile "$JSON_OUT" "${TESTS[@]}"
  echo
  echo "JSON report: $JSON_OUT"
else
  node_modules/.bin/vitest run --no-coverage "${TESTS[@]}"
fi
