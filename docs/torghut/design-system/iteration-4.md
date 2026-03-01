# Torghut Design-System Corpus Audit Iteration 4

- Date: `2026-03-01`
- Branch: `codex/torghut-design-system-corpus-refresh`
- Base: `main`
- Scope: `docs/torghut/design-system/**` plus implementation/runtime evidence in `services/torghut/**`, `services/dorvud/**`, `services/jangar/**`, and `argocd/**`

## Docs reviewed / updated

- All status-bearing version/index/matrix artifacts under `docs/torghut/design-system/**`.
- `docs/torghut/design-system/implementation-status-matrix-2026-02-21.md`
- `docs/torghut/design-system/implementation-audit.md`
- `docs/torghut/design-system/v1/index.md`
- `docs/torghut/design-system/v2/index.md`
- `docs/torghut/design-system/v3/index.md`
- `docs/torghut/design-system/v4/index.md`
- `docs/torghut/design-system/v5/index.md`
- `docs/torghut/design-system/v6/index.md`
- `docs/torghut/design-system/README.md`
- `docs/torghut/design-system/iteration-4.md`

## Code evidence checked

- `services/torghut/app/trading/llm/circuit.py`
- `services/torghut/tests/test_llm_guardrails.py`
- `services/torghut/app/trading/llm/review_engine.py`
- `services/torghut/tests/test_llm_review_engine.py`
- `services/dorvud/technical-analysis-flink/src/main/kotlin/ai/proompteng/dorvud/ta/flink/FlinkTechnicalAnalysisJob.kt`
- `services/dorvud/technical-analysis-flink/src/test/kotlin/ai/proompteng/dorvud/ta/flink/ParseEnvelopeFlatMapTest.kt`
- `services/dorvud/websockets/src/main/kotlin/ai/proompteng/dorvud/ws/ForwarderApp.kt`
- `services/dorvud/websockets/src/test/kotlin/ai/proompteng/dorvud/ws/ForwarderConfigTest.kt`
- `services/torghut/app/trading/execution.py`
- `services/torghut/tests/test_order_idempotency.py`
- `services/torghut/migrations/versions/0001_initial_torghut_schema.py`
- `services/torghut/tests/test_models.py`
- `services/torghut/app/trading/reconcile.py`
- `services/torghut/app/trading/scheduler.py`
- `services/torghut/tests/test_trading_pipeline.py`
- `services/dorvud/websockets/src/main/kotlin/ai/proompteng/dorvud/ws/ForwarderApp.kt`
- `services/dorvud/websockets/src/test/kotlin/ai/proompteng/dorvud/ws/ForwarderConfigTest.kt`
- `services/torghut/app/trading/autonomy/evidence.py`
- `services/torghut/tests/test_autonomy_evidence.py`
- `services/torghut/app/trading/backtest.py`
- `services/torghut/tests/test_walkforward.py`
- `services/torghut/migrations/versions/0011_autonomy_lifecycle_and_promotion_audit.py`
- `services/torghut/app/trading/tca.py`
- `services/torghut/tests/test_tca_adaptive_policy.py`
- `services/torghut/app/trading/features.py`
- `services/torghut/tests/test_feature_contract_v3.py`
- `services/torghut/app/config.py`
- `services/torghut/tests/test_trading_scheduler_safety.py`
- `services/torghut/app/trading/llm/dspy_programs/runtime.py`
- `services/torghut/app/trading/llm/dspy_compile/workflow.py`
- `services/torghut/tests/test_llm_dspy_workflow.py`
- `services/torghut/app/trading/autonomy/policy_checks.py`
- `services/torghut/tests/test_governance_policy_dry_run.py`
- `services/torghut/tests/test_profitability_evidence_v4.py`
- `services/torghut/app/trading/autonomy/gates.py`
- `services/torghut/app/trading/forecasting.py`
- `services/torghut/app/trading/decisions.py`
- `services/jangar/src/routes/torghut/trading.tsx`
- `services/jangar/src/routes/api/torghut/market-context/index.ts`

## Status changes made

- Updated `docs/torghut/design-system/implementation-audit.md` synchronization footer from `iteration-3.md` to `iteration-4.md`.
- Added `docs/torghut/design-system/iteration-4.md` to capture the latest verification pass.
- No status class migrations were made in this iteration; existing `Implemented`/`Partial`/`Planned` decisions remain unchanged after revalidation.

## Remaining gaps

- `Partial` and `Planned` docs still require full implementation-ready acceptance criteria before they can be promoted to `Implemented`.
- No new evidence has emerged since Iteration 3 to justify status promotion for non-implemented items.
- Remaining work continues to be hardening around full v6 cutover manifests, end-to-end DSPy+Jangar-only LLM runtime removal, and complete automated governance rollout evidence.
