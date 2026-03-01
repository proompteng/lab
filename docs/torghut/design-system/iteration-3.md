# Torghut Design-System Corpus Audit Iteration 3

- Date: `2026-03-01`
- Branch: `codex/torghut-design-system-corpus-refresh`
- Base: `main`
- Scope: `docs/torghut/design-system/**` and source/runtime evidence in `services/torghut/**`, `services/dorvud/**`, `argocd/**`

## Docs reviewed / updated

Reviewed all status-bearing design documents and normalized implementation metadata across version indexes.

- `docs/torghut/design-system/implementation-status-matrix-2026-02-21.md` (status source-of-truth verification only)
- `docs/torghut/design-system/implementation-audit.md` (iteration sync note)
- `docs/torghut/design-system/v2/index.md`
- `docs/torghut/design-system/v3/index.md`
- `docs/torghut/design-system/v4/index.md`
- `docs/torghut/design-system/v5/index.md`
- `docs/torghut/design-system/v6/index.md`
- `docs/torghut/design-system/README.md`
- `docs/torghut/design-system/iteration-3.md`

## Code evidence checked

All 15 `Implemented` documents in the matrix were revalidated against concrete anchors:

- `services/torghut/app/trading/llm/circuit.py`
- `services/torghut/tests/test_llm_guardrails.py`
- `argocd/applications/torghut/knative-service.yaml`
- `services/torghut/app/trading/llm/review_engine.py`
- `services/torghut/tests/test_llm_review_engine.py`
- `services/dorvud/technical-analysis-flink/src/main/kotlin/ai/proompteng/dorvud/ta/flink/FlinkTechnicalAnalysisJob.kt`
- `services/dorvud/technical-analysis-flink/src/test/kotlin/ai/proompteng/dorvud/ta/flink/ParseEnvelopeFlatMapTest.kt`
- `services/torghut/app/trading/execution.py`
- `services/torghut/tests/test_order_idempotency.py`
- `services/torghut/migrations/versions/0001_initial_torghut_schema.py`
- `services/torghut/tests/test_models.py`
- `argocd/applications/torghut/postgres-cluster.yaml`
- `services/torghut/app/trading/reconcile.py`
- `services/torghut/app/trading/scheduler.py`
- `services/torghut/tests/test_trading_pipeline.py`
- `argocd/applications/torghut/strategy-configmap.yaml`
- `argocd/applications/torghut/knative-service.yaml`
- `services/dorvud/websockets/src/main/kotlin/ai/proompteng/dorvud/ws/ForwarderApp.kt`
- `services/dorvud/websockets/src/test/kotlin/ai/proompteng/dorvud/ws/ForwarderConfigTest.kt`
- `argocd/applications/torghut/ws/deployment.yaml`
- `services/torghut/app/config.py`
- `services/torghut/tests/test_trading_scheduler_safety.py`
- `services/torghut/app/trading/backtest.py`
- `services/torghut/tests/test_walkforward.py`
- `services/torghut/migrations/versions/0011_autonomy_lifecycle_and_promotion_audit.py`
- `services/torghut/app/trading/tca.py`
- `services/torghut/tests/test_tca_adaptive_policy.py`
- `services/torghut/app/trading/features.py`
- `services/torghut/tests/test_feature_contract_v3.py`
- `argocd/applications/torghut/ta/configmap.yaml`
- `services/torghut/app/trading/autonomy/evidence.py`
- `services/torghut/tests/test_autonomy_evidence.py`
- `services/torghut/app/trading/autonomy/lane.py`

## Status changes made

- Added explicit per-version status snapshots to `v2`, `v3`, `v4`, `v5`, `v6` index files using matrix totals.
- Added `docs/torghut/design-system/iteration-3.md` with evidence checks and remaining gap notes.
- Added an iteration synchronization note to `implementation-audit.md`.

## Remaining gaps

- No status class changes in this iteration; the corpus remains dominated by `Partial` and `Planned`.
- `Partial`/`Planned` docs still need full implementation-ready acceptance criteria, explicit architecture/risk closure, and verification evidence to move to implementation-complete status.
- Full implementation evidence remains blocked for several high-impact v4/v6 docs without closed production control-plane, model-operations, and cutover manifests.
