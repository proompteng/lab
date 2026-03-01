# Torghut Design-System Corpus Audit Iteration 1

- Date: `2026-03-01`
- Branch: `codex/torghut-design-system-corpus-refresh`
- Base: `main`
- Scope: `docs/torghut/design-system/**` and associated runtime artifacts under `services/**` + `argocd/**`

## Docs reviewed / updated

Reviewed all 157 markdown documents under `docs/torghut/design-system/**` and updated statuses for:

- `docs/torghut/design-system/implementation-status-matrix-2026-02-21.md`
- `docs/torghut/design-system/implementation-audit.md`
- `docs/torghut/design-system/v1/historical-dataset-simulation.md`
- `docs/torghut/design-system/v1/trading-day-simulation-automation.md`
- `docs/torghut/design-system/v3/current-state-baseline-2026-02-11.md`
- `docs/torghut/design-system/v3/current-state-snapshot-2026-02-12.md`
- `docs/torghut/design-system/v5/index.md`
- `docs/torghut/design-system/v6/01-beyond-tsmom-system-architecture-and-latency-model.md`
- `docs/torghut/design-system/v6/02-regime-adaptive-expert-router-design.md`
- `docs/torghut/design-system/v6/03-dspy-llm-decision-layer-over-jangar.md`
- `docs/torghut/design-system/v6/04-alpha-discovery-and-autonomous-improvement-pipeline.md`
- `docs/torghut/design-system/v6/05-evaluation-benchmark-and-contamination-control-standard.md`
- `docs/torghut/design-system/v6/06-production-rollout-operations-and-governance.md`
- `docs/torghut/design-system/v6/07-hmm-regime-state-and-autonomous-llm-control-plane-2026-02-28.md`
- `docs/torghut/design-system/v6/index.md`

Status-normalization updates also touched additional versioned docs (v1/v3) that were previously tagged with inconsistent labels; these are currently visible in the matrix and audit output.

## Evidence checked in code/runtime

- Torghut runtime and trading artifacts: `services/torghut/app/**`
- LLM runtime artifacts: `services/torghut/app/trading/llm/**`
- Dorvud ingestion/gateway stack: `services/dorvud/**`
- Jangar services and routes: `services/jangar/**`
- Governance/config runtime manifests: `argocd/applications/torghut/**`
- Migrations and schema artifacts: `services/torghut/migrations/versions/**`
- Test suites used for evidence:
  - `services/torghut/tests/test_llm_guardrails.py`
  - `services/torghut/tests/test_llm_review_engine.py`
  - `services/torghut/tests/test_order_idempotency.py`
  - `services/torghut/tests/test_models.py`
  - `services/torghut/tests/test_trading_pipeline.py`
  - `services/torghut/tests/test_walkforward.py`
  - `services/torghut/tests/test_tca_adaptive_policy.py`
  - `services/torghut/tests/test_profitability_evidence_v4.py`
  - `services/torghut/tests/test_autonomy_evidence.py`
  - plus targeted v1/v6 stack validation tests referenced in updated doc rows

## Status changes made this iteration

- Normalized status vocabulary to only `Implemented`, `Partial`, `Planned`.
- Reclassified `v3` baseline/snapshot docs as `Planned` where they are index-like states.
- Added explicit implementation status and evidence/gaps to v1 historical simulation docs.
- Added implementation readout sections for newly introduced v6 files.
- Marked missing v1/v6 status coverage in matrix and generated matching `implementation-audit.md` with 157 design docs audited.

## Remaining gaps

- Matrix currently shows high partial/planned surface; only 15 docs are `Implemented` today.
- Planned items still requiring runtime evidence before promotion:
  - `v6/04-alpha-discovery-and-autonomous-improvement-pipeline.md`
  - `v6/06-production-rollout-operations-and-governance.md`
- Remaining v1/v2/v3/v4/v5/v6 `Partial` docs require acceptance criteria expansion before upgrade.
- Additional hardening desired before completion:
  - automate a periodic diff check across matrix + audit totals
  - add explicit evidence artifact IDs per `Partial`/`Planned` row for test reproducibility
