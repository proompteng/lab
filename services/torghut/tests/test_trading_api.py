from __future__ import annotations

import json
import inspect
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from typing import Any
from unittest import TestCase
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.pool import StaticPool
from sqlalchemy.orm import Session, sessionmaker

from app.db import get_session
from app.main import (
    _ALPACA_HEALTH_STATE,
    _TRADING_DEPENDENCY_HEALTH_CACHE,
    _assert_dspy_cutover_migration_guard,
    _build_live_submission_gate_payload,
    _check_alpaca,
    healthz,
    _readiness_dependency_cache_key,
    _readiness_dependency_checks,
    _route_continuity_packet_for_proof_floor,
    app,
)
from app.trading.scheduler import TradingScheduler
from app.trading.completion import (
    DOC29_SIMULATION_FULL_DAY_GATE,
    TRACE_STATUS_SATISFIED,
    build_completion_trace,
    persist_completion_trace,
)
from app.trading.execution import OrderExecutor
from app.config import settings
from app.models import (
    AutoresearchCandidateSpec,
    AutoresearchEpoch,
    AutoresearchPortfolioCandidate,
    AutoresearchProposalScore,
    Base,
    Execution,
    ExecutionTCAMetric,
    LLMDecisionReview,
    Strategy,
    StrategyHypothesisMetricWindow,
    StrategyPromotionDecision,
    TradeDecision,
    VNextEmpiricalJobRun,
)


def _truthful_empirical_payload(
    *,
    job_run_id: str,
    dataset_snapshot_ref: str,
) -> dict[str, object]:
    return {
        "promotion_authority_eligible": True,
        "artifact_authority": {
            "provenance": "historical_market_replay",
            "maturity": "empirically_validated",
            "authoritative": True,
            "placeholder": False,
        },
        "lineage": {
            "dataset_snapshot_ref": dataset_snapshot_ref,
            "job_run_id": job_run_id,
            "runtime_version_refs": ["services/torghut@sha256:abc"],
            "model_refs": ["models/candidate@sha256:def"],
        },
    }


def _install_pipeline_universe_resolver(
    scheduler: TradingScheduler,
    resolver: object,
) -> None:
    setattr(scheduler, "_pipeline", SimpleNamespace(universe_resolver=resolver))


def _mark_static_universe_loaded(scheduler: TradingScheduler) -> None:
    scheduler.state.universe_source_status = "ok"
    scheduler.state.universe_source_reason = "static_symbols_loaded"
    scheduler.state.universe_symbols_count = 2
    scheduler.state.universe_cache_age_seconds = 0


class TestTradingApi(TestCase):
    def setUp(self) -> None:
        _TRADING_DEPENDENCY_HEALTH_CACHE.clear()
        _ALPACA_HEALTH_STATE.clear()
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        self.session_local = sessionmaker(
            bind=engine, expire_on_commit=False, future=True
        )
        session_local_patch = patch("app.main.SessionLocal", self.session_local)
        session_local_patch.start()
        self.addCleanup(session_local_patch.stop)

        def _override_session() -> Session:
            with self.session_local() as session:
                yield session

        app.dependency_overrides[get_session] = _override_session
        self.client = TestClient(app)

        with self.session_local() as session:
            strategy = Strategy(
                name="demo",
                description="demo",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)

            decision = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={"action": "buy", "qty": "1", "params": {"price": "100"}},
                rationale="demo",
                status="planned",
                created_at=datetime.now(timezone.utc),
            )
            session.add(decision)
            session.commit()
            session.refresh(decision)

            execution = Execution(
                trade_decision_id=decision.id,
                alpaca_order_id="order-1",
                client_order_id="client-1",
                symbol="AAPL",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("0"),
                avg_fill_price=None,
                execution_correlation_id="corr-1",
                execution_idempotency_key="idem-1",
                status="accepted",
                raw_order={},
                last_update_at=datetime.now(timezone.utc),
            )
            session.add(execution)
            session.commit()
            session.refresh(execution)

            tca = ExecutionTCAMetric(
                execution_id=execution.id,
                trade_decision_id=decision.id,
                strategy_id=strategy.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                side="buy",
                arrival_price=Decimal("100"),
                avg_fill_price=Decimal("101"),
                filled_qty=Decimal("1"),
                signed_qty=Decimal("1"),
                slippage_bps=Decimal("100"),
                shortfall_notional=Decimal("1"),
                expected_shortfall_bps_p50=Decimal("3.5"),
                expected_shortfall_bps_p95=Decimal("5.0"),
                realized_shortfall_bps=Decimal("1.2"),
                divergence_bps=Decimal("0.7"),
                churn_qty=Decimal("0"),
                churn_ratio=Decimal("0"),
            )
            session.add(tca)
            session.commit()

            review = LLMDecisionReview(
                trade_decision_id=decision.id,
                model="demo",
                prompt_version="v1",
                input_json={"decision": "demo"},
                response_json={"verdict": "approve"},
                verdict="approve",
                confidence=Decimal("0.7"),
                adjusted_qty=None,
                adjusted_order_type=None,
                rationale="ok",
                risk_flags=["demo_flag"],
                tokens_prompt=120,
                tokens_completion=45,
                created_at=datetime.now(timezone.utc),
            )
            session.add(review)
            session.commit()

    def tearDown(self) -> None:
        _TRADING_DEPENDENCY_HEALTH_CACHE.clear()
        _ALPACA_HEALTH_STATE.clear()
        app.dependency_overrides.clear()
        if hasattr(app.state, "trading_scheduler"):
            delattr(app.state, "trading_scheduler")

    def test_healthz_handler_stays_async_for_liveness_probe(self) -> None:
        self.assertTrue(inspect.iscoroutinefunction(healthz))

        response = self.client.get("/healthz")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok", "service": "torghut"})

    def test_trading_decisions_endpoint(self) -> None:
        response = self.client.get("/trading/decisions?symbol=AAPL")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(len(payload), 1)
        self.assertEqual(payload[0]["symbol"], "AAPL")

    def test_autoresearch_epoch_endpoints(self) -> None:
        with self.session_local() as session:
            session.add(
                AutoresearchEpoch(
                    epoch_id="epoch-1",
                    status="ok",
                    target_net_pnl_per_day=Decimal("500"),
                    paper_run_ids_json=["paper-1"],
                    snapshot_manifest_json={"source_count": 1},
                    runner_config_json={"replay_mode": "synthetic"},
                    summary_json={
                        "best": "portfolio-1",
                        "claim_count": 2,
                        "hypothesis_count": 1,
                        "candidate_spec_count": 1,
                        "evidence_bundle_count": 1,
                        "portfolio_candidate_count": 1,
                        "mlx_rank_bucket_lift": {"lift_net_pnl_per_day": "10"},
                        "false_positive_table": [{"candidate_spec_id": "spec-fp"}],
                        "best_false_negative_table": [{"candidate_spec_id": "spec-fn"}],
                        "promotion_readiness": {
                            "blockers": ["scheduler_v3_parity_missing"]
                        },
                    },
                    started_at=datetime.now(timezone.utc),
                    completed_at=datetime.now(timezone.utc),
                )
            )
            session.add(
                AutoresearchCandidateSpec(
                    candidate_spec_id="spec-1",
                    epoch_id="epoch-1",
                    hypothesis_id="hyp-1",
                    candidate_kind="sleeve",
                    family_template_id="microbar_cross_sectional_pairs_v1",
                    payload_json={"candidate_spec_id": "spec-1"},
                    payload_hash="hash",
                    status="eligible",
                    blockers_json=[],
                )
            )
            session.add(
                AutoresearchProposalScore(
                    epoch_id="epoch-1",
                    candidate_spec_id="spec-1",
                    model_id="model-1",
                    backend="numpy-fallback",
                    proposal_score=Decimal("12.5"),
                    rank=1,
                    selection_reason="exploitation",
                    feature_hash="feature-hash",
                    payload_json={"rank": 1},
                )
            )
            session.add(
                AutoresearchPortfolioCandidate(
                    portfolio_candidate_id="portfolio-1",
                    epoch_id="epoch-1",
                    source_candidate_ids_json=["cand-1"],
                    target_net_pnl_per_day=Decimal("500"),
                    objective_scorecard_json={
                        "target_met": True,
                        "net_pnl_per_day": "535",
                        "active_day_ratio": "1",
                        "positive_day_ratio": "1",
                    },
                    optimizer_report_json={"selected_count": 1},
                    payload_json={
                        "portfolio_candidate_id": "portfolio-1",
                        "sleeves": [{"candidate_id": "cand-1"}],
                    },
                    status="target_met",
                )
            )
            session.commit()

        list_response = self.client.get("/trading/autoresearch/epochs")
        self.assertEqual(list_response.status_code, 200)
        list_payload = list_response.json()
        self.assertEqual(list_payload["count"], 1)
        self.assertEqual(list_payload["epochs"][0]["epoch_id"], "epoch-1")
        self.assertEqual(
            list_payload["epochs"][0]["best_portfolio_net_pnl_per_day"], "535"
        )
        self.assertEqual(list_payload["epochs"][0]["claim_count"], 2)
        self.assertEqual(
            list_payload["epochs"][0]["false_positive_table"][0]["candidate_spec_id"],
            "spec-fp",
        )
        self.assertEqual(
            list_payload["epochs"][0]["blocked_promotion_reasons"],
            ["scheduler_v3_parity_missing"],
        )

        detail_response = self.client.get("/trading/autoresearch/epochs/epoch-1")
        self.assertEqual(detail_response.status_code, 200)
        detail_payload = detail_response.json()
        self.assertEqual(detail_payload["epoch"]["epoch_id"], "epoch-1")
        self.assertEqual(
            detail_payload["candidate_specs"][0]["candidate_spec_id"], "spec-1"
        )
        self.assertEqual(detail_payload["proposal_scores"][0]["rank"], 1)
        self.assertEqual(
            detail_payload["portfolio_candidates"][0]["portfolio_candidate_id"],
            "portfolio-1",
        )
        self.assertEqual(
            detail_payload["dashboard"]["blocked_promotion_reasons"],
            ["scheduler_v3_parity_missing"],
        )
        self.assertEqual(
            detail_payload["dashboard"]["best_false_negative_table"][0][
                "candidate_spec_id"
            ],
            "spec-fn",
        )

        missing_response = self.client.get("/trading/autoresearch/epochs/missing")
        self.assertEqual(missing_response.status_code, 404)

    def test_dspy_cutover_migration_guard_assertion_raises_for_legacy_toggles(
        self,
    ) -> None:
        original_runtime_mode = settings.llm_dspy_runtime_mode
        original_fail_mode_enforcement = settings.llm_fail_mode_enforcement
        original_fail_mode = settings.llm_fail_mode
        original_abstain_fail_mode = settings.llm_abstain_fail_mode
        original_escalate_fail_mode = settings.llm_escalate_fail_mode
        original_quality_fail_mode = settings.llm_quality_fail_mode
        original_shadow_mode = settings.llm_shadow_mode
        settings.llm_dspy_runtime_mode = "active"
        settings.llm_fail_mode_enforcement = "configured"
        settings.llm_fail_mode = "veto"
        settings.llm_abstain_fail_mode = "pass_through"
        settings.llm_escalate_fail_mode = "veto"
        settings.llm_quality_fail_mode = "veto"
        settings.llm_shadow_mode = False
        try:
            with self.assertRaisesRegex(
                RuntimeError,
                "dspy_cutover_migration_guard_failed",
            ):
                _assert_dspy_cutover_migration_guard()
        finally:
            settings.llm_dspy_runtime_mode = original_runtime_mode
            settings.llm_fail_mode_enforcement = original_fail_mode_enforcement
            settings.llm_fail_mode = original_fail_mode
            settings.llm_abstain_fail_mode = original_abstain_fail_mode
            settings.llm_escalate_fail_mode = original_escalate_fail_mode
            settings.llm_quality_fail_mode = original_quality_fail_mode
            settings.llm_shadow_mode = original_shadow_mode

    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
            "schema_graph_signature": "graph-signature-demo",
            "schema_graph_roots": ["0001_initial_torghut_schema"],
            "schema_graph_branch_count": 1,
            "schema_graph_parent_forks": {},
            "schema_graph_duplicate_revisions": {},
            "schema_graph_orphan_parents": [],
            "schema_missing_heads": [],
            "schema_unexpected_heads": [],
            "schema_head_count_expected": 1,
            "schema_head_count_current": 1,
            "schema_head_delta_count": 0,
        },
    )
    @patch(
        "app.main.check_account_scope_invariants",
        return_value={"account_scope_ready": True},
    )
    def test_db_check_reports_schema_heads(
        self,
        _mock_account_scope: object,
        _mock_schema: object,
    ) -> None:
        response = self.client.get("/db-check")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["schema_current"])
        self.assertEqual(payload["current_heads"], payload["expected_heads"])
        self.assertTrue(payload["account_scope_ready"])
        self.assertEqual(payload["schema_head_signature"], "7f8e4d0")
        self.assertEqual(payload["schema_missing_heads"], [])
        self.assertEqual(payload["schema_unexpected_heads"], [])
        self.assertEqual(payload["schema_head_count_expected"], 1)
        self.assertEqual(payload["schema_head_count_current"], 1)
        self.assertEqual(payload["schema_head_delta_count"], 0)
        self.assertEqual(payload["schema_graph_signature"], "graph-signature-demo")
        self.assertEqual(payload["schema_graph_roots"], ["0001_initial_torghut_schema"])
        self.assertEqual(payload["schema_graph_branch_count"], 1)
        self.assertEqual(payload["schema_graph_parent_forks"], {})
        self.assertEqual(payload["schema_graph_lineage_errors"], [])
        self.assertIn("checked_at", payload)

    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0017_whitepaper_semantic_indexing"],
            "expected_heads": ["0017_whitepaper_semantic_indexing"],
            "schema_head_signature": "sig-divergent",
            "schema_graph_signature": "graph-divergent",
            "schema_graph_roots": ["0001_initial_torghut_schema"],
            "schema_graph_branch_count": 3,
            "schema_graph_parent_forks": {
                "0015_whitepaper_workflow_tables": [
                    "0016_llm_dspy_workflow_artifacts",
                    "0016_whitepaper_engineering_triggers_and_rollout",
                ]
            },
            "schema_graph_duplicate_revisions": {},
            "schema_graph_orphan_parents": [],
            "schema_missing_heads": [],
            "schema_unexpected_heads": [],
            "schema_head_count_expected": 1,
            "schema_head_count_current": 1,
            "schema_head_delta_count": 0,
        },
    )
    @patch(
        "app.main.check_account_scope_invariants",
        return_value={"account_scope_ready": True},
    )
    def test_db_check_schema_lineage_divergence_returns_503_when_override_disabled(
        self,
        _mock_account_scope: object,
        _mock_schema: object,
    ) -> None:
        original_tolerance = settings.trading_db_schema_graph_branch_tolerance
        original_allow = settings.trading_db_schema_graph_allow_divergence_roots
        settings.trading_db_schema_graph_branch_tolerance = 1
        settings.trading_db_schema_graph_allow_divergence_roots = False
        try:
            response = self.client.get("/db-check")
        finally:
            settings.trading_db_schema_graph_branch_tolerance = original_tolerance
            settings.trading_db_schema_graph_allow_divergence_roots = original_allow

        self.assertEqual(response.status_code, 503)
        payload = response.json()
        self.assertEqual(
            payload["detail"]["error"], "database schema lineage divergence"
        )
        self.assertFalse(payload["detail"]["schema_graph_lineage_ready"])
        self.assertIn("schema_graph_lineage_errors", payload["detail"])
        self.assertIn("schema_graph_branch_count", payload["detail"])

    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0017_whitepaper_semantic_indexing"],
            "expected_heads": ["0017_whitepaper_semantic_indexing"],
            "schema_head_signature": "sig-override",
            "schema_graph_signature": "graph-override",
            "schema_graph_roots": ["0001_initial_torghut_schema"],
            "schema_graph_branch_count": 2,
            "schema_graph_parent_forks": {
                "0015_whitepaper_workflow_tables": [
                    "0016_llm_dspy_workflow_artifacts",
                    "0017_whitepaper_semantic_indexing",
                ]
            },
            "schema_graph_duplicate_revisions": {},
            "schema_graph_orphan_parents": [],
            "schema_missing_heads": [],
            "schema_unexpected_heads": [],
            "schema_head_count_expected": 1,
            "schema_head_count_current": 1,
            "schema_head_delta_count": 0,
        },
    )
    @patch(
        "app.main.check_account_scope_invariants",
        return_value={"account_scope_ready": True},
    )
    def test_db_check_schema_lineage_warning_returns_200_when_override_enabled(
        self,
        _mock_account_scope: object,
        _mock_schema: object,
    ) -> None:
        original_tolerance = settings.trading_db_schema_graph_branch_tolerance
        original_allow = settings.trading_db_schema_graph_allow_divergence_roots
        settings.trading_db_schema_graph_branch_tolerance = 1
        settings.trading_db_schema_graph_allow_divergence_roots = True
        try:
            response = self.client.get("/db-check")
        finally:
            settings.trading_db_schema_graph_branch_tolerance = original_tolerance
            settings.trading_db_schema_graph_allow_divergence_roots = original_allow

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["schema_graph_lineage_ready"])
        self.assertEqual(payload["schema_graph_branch_count"], 2)
        self.assertEqual(
            payload["schema_graph_lineage_errors"],
            [],
        )
        self.assertEqual(
            payload["schema_graph_lineage_warnings"],
            [
                "migration parent forks detected: 0015_whitepaper_workflow_tables -> "
                "[0016_llm_dspy_workflow_artifacts, 0017_whitepaper_semantic_indexing]",
                "migration graph branch count 2 exceeds tolerance 1; allowed by "
                "TRADING_DB_SCHEMA_GRAPH_ALLOW_DIVERGENCE_ROOTS=true",
            ],
        )

    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": False,
            "current_heads": ["0010_execution_provenance_and_governance_trace"],
            "expected_heads": [
                "0011_autonomy_lifecycle_and_promotion_audit",
                "0011_execution_tca_simulator_divergence",
            ],
            "schema_head_signature": "7f8e4d0",
            "schema_missing_heads": [
                "0011_autonomy_lifecycle_and_promotion_audit",
                "0011_execution_tca_simulator_divergence",
            ],
            "schema_unexpected_heads": [
                "0010_execution_provenance_and_governance_trace"
            ],
            "schema_head_count_expected": 2,
            "schema_head_count_current": 1,
            "schema_head_delta_count": 3,
        },
    )
    @patch(
        "app.main.check_account_scope_invariants",
        return_value={"account_scope_ready": True},
    )
    def test_db_check_schema_mismatch_returns_503(
        self,
        _mock_account_scope: object,
        _mock_schema: object,
    ) -> None:
        response = self.client.get("/db-check")
        self.assertEqual(response.status_code, 503)
        payload = response.json()
        self.assertEqual(payload["detail"]["error"], "database schema mismatch")
        self.assertFalse(payload["detail"]["schema_current"])
        self.assertEqual(
            payload["detail"]["schema_missing_heads"],
            [
                "0011_autonomy_lifecycle_and_promotion_audit",
                "0011_execution_tca_simulator_divergence",
            ],
        )
        self.assertEqual(
            payload["detail"]["schema_unexpected_heads"],
            ["0010_execution_provenance_and_governance_trace"],
        )
        self.assertEqual(payload["detail"]["schema_head_count_expected"], 2)
        self.assertEqual(payload["detail"]["schema_head_count_current"], 1)
        self.assertEqual(payload["detail"]["schema_head_delta_count"], 3)
        self.assertEqual(payload["detail"]["schema_head_signature"], "7f8e4d0")
        self.assertIn("checked_at", payload["detail"])

    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
            "schema_missing_heads": [],
            "schema_unexpected_heads": [],
            "schema_head_count_expected": 1,
            "schema_head_count_current": 1,
            "schema_head_delta_count": 0,
        },
    )
    def test_db_check_enforces_account_scope_when_multi_account_enabled(
        self,
        _mock_check: object,
    ) -> None:
        original_multi = settings.trading_multi_account_enabled
        settings.trading_multi_account_enabled = True
        try:
            with patch(
                "app.main.check_account_scope_invariants",
                return_value={
                    "account_scope_ready": False,
                    "account_scope_errors": [
                        "legacy unique constraint/index detected for executions.alpaca_order_id",
                    ],
                },
            ):
                response = self.client.get("/db-check")
        finally:
            settings.trading_multi_account_enabled = original_multi

        self.assertEqual(response.status_code, 503)
        payload = response.json()
        self.assertEqual(
            payload["detail"]["error"], "database account scope schema mismatch"
        )
        self.assertIn("account_scope_errors", payload["detail"])
        self.assertEqual(payload["detail"]["schema_head_signature"], "7f8e4d0")
        self.assertIn("checked_at", payload["detail"])

    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
            "schema_missing_heads": [],
            "schema_unexpected_heads": [],
            "schema_head_count_expected": 1,
            "schema_head_count_current": 1,
            "schema_head_delta_count": 0,
        },
    )
    def test_db_check_allows_account_scope_issues_when_multi_account_disabled(
        self,
        _mock_check: object,
    ) -> None:
        original_multi = settings.trading_multi_account_enabled
        settings.trading_multi_account_enabled = False
        try:
            with patch(
                "app.main.check_account_scope_invariants",
                return_value={
                    "account_scope_ready": False,
                    "account_scope_errors": ["legacy unique constraint/index detected"],
                },
            ):
                response = self.client.get("/db-check")
        finally:
            settings.trading_multi_account_enabled = original_multi

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["account_scope_ready"], True)
        self.assertIn(
            "account_scope_warnings",
            payload["account_scope_checks"],
        )
        self.assertEqual(
            payload["account_scope_checks"]["account_scope_warnings"],
            [
                "account scope checks are bypassed when trading_multi_account_enabled is false"
            ],
        )
        self.assertEqual(payload["schema_head_signature"], "7f8e4d0")
        self.assertIn("checked_at", payload)

    def test_trading_executions_endpoint(self) -> None:
        response = self.client.get("/trading/executions?symbol=AAPL")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(len(payload), 1)
        self.assertEqual(payload[0]["symbol"], "AAPL")
        self.assertEqual(payload[0]["execution_correlation_id"], "corr-1")
        self.assertEqual(payload[0]["execution_idempotency_key"], "idem-1")
        self.assertIsNotNone(payload[0]["tca"])
        self.assertEqual(payload[0]["tca"]["slippage_bps"], 100.0)

    def test_trading_tca_endpoint(self) -> None:
        response = self.client.get("/trading/tca?symbol=AAPL")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["summary"]["order_count"], 1)
        self.assertEqual(payload["summary"]["expected_shortfall_sample_count"], 1)
        self.assertAlmostEqual(
            float(payload["summary"]["expected_shortfall_coverage"]), 1.0
        )
        self.assertEqual(len(payload["rows"]), 1)
        self.assertEqual(payload["rows"][0]["symbol"], "AAPL")

    def test_trading_status_includes_tca_calibration_summary(self) -> None:
        response = self.client.get("/trading/status")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        tca_summary = payload["tca"]
        self.assertEqual(tca_summary["order_count"], 1)
        self.assertEqual(tca_summary["expected_shortfall_sample_count"], 1)
        self.assertEqual(float(tca_summary["expected_shortfall_coverage"]), 1.0)
        self.assertEqual(float(tca_summary["avg_expected_shortfall_bps_p50"]), 3.5)
        self.assertEqual(float(tca_summary["avg_expected_shortfall_bps_p95"]), 5.0)
        self.assertEqual(float(tca_summary["avg_realized_shortfall_bps"]), 1.2)
        self.assertEqual(float(tca_summary["avg_divergence_bps"]), 0.7)

    def test_trading_status_reports_latest_persisted_decision_timestamp(self) -> None:
        with self.session_local() as session:
            strategy = session.execute(select(Strategy)).scalars().first()
            assert strategy is not None
            latest_created_at = datetime.now(timezone.utc) + timedelta(minutes=5)
            session.add(
                TradeDecision(
                    strategy_id=strategy.id,
                    alpaca_account_label="paper",
                    symbol="MSFT",
                    timeframe="5Min",
                    decision_json={"action": "sell", "qty": "2"},
                    rationale="latest",
                    status="planned",
                    created_at=latest_created_at,
                )
            )
            session.commit()

        response = self.client.get("/trading/status")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(
            datetime.fromisoformat(payload["last_decision_at"]),
            latest_created_at,
        )

    def test_trading_status_does_not_fetch_jangar_dependency_for_self_governed_registry(
        self,
    ) -> None:
        call_order: list[str] = []

        def _load_llm_evaluation(_session: Session) -> dict[str, object]:
            call_order.append("llm_evaluation")
            return {"ok": True, "metrics": {"total_reviews": 1}}

        def _load_tca(_session: Session, **_kwargs: object) -> dict[str, object]:
            call_order.append("tca")
            return {}

        with (
            patch("app.trading.hypotheses.urlopen") as jangar_status_fetch,
            patch("app.main._load_llm_evaluation", side_effect=_load_llm_evaluation),
            patch("app.main._load_tca_summary", side_effect=_load_tca),
            patch("app.main.SessionLocal", self.session_local),
        ):
            response = self.client.get("/trading/status")

        self.assertEqual(response.status_code, 200)
        self.assertIn("llm_evaluation", call_order)
        self.assertIn("tca", call_order)
        jangar_status_fetch.assert_not_called()

    def test_trading_consumer_evidence_avoids_recursive_jangar_status_fetch(
        self,
    ) -> None:
        proof_floor = {
            "schema_version": "torghut.profitability-proof-floor.v1",
            "generated_at": "2026-05-08T03:54:41.769374+00:00",
            "account_label": "PA3SX7FYNUTF",
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "max_notional": "0",
            "blocking_reasons": ["simple_submit_disabled"],
            "proof_dimensions": [],
            "repair_ladder": [],
        }
        live_submission_gate = {
            "allowed": False,
            "reason": "simple_submit_disabled",
            "blocked_reasons": ["simple_submit_disabled"],
            "capital_stage": "shadow",
            "dependency_quorum_decision": "allow",
        }

        with (
            patch("app.main.resolve_hypothesis_dependency_quorum") as dependency_fetch,
            patch("app.main.load_jangar_route_continuity_packet") as continuity_fetch,
            patch(
                "app.main._forecast_service_status",
                return_value={
                    "status": "healthy",
                    "authority": "empirical",
                    "promotion_authority_eligible_models": ["candidate-a"],
                },
            ),
            patch(
                "app.main._lean_authority_status",
                return_value={"status": "healthy", "authority": "empirical"},
            ),
            patch(
                "app.main._empirical_jobs_status",
                return_value={
                    "status": "healthy",
                    "ready": True,
                    "candidate_ids": ["candidate-a"],
                    "dataset_snapshot_refs": ["dataset-a"],
                },
            ),
            patch(
                "app.main.load_quant_evidence_status",
                return_value={"ok": True, "required": False},
            ),
            patch("app.main._load_tca_summary", return_value={}),
            patch(
                "app.main._build_live_submission_gate_payload",
                return_value=live_submission_gate,
            ),
            patch(
                "app.main.build_profitability_proof_floor_receipt",
                return_value=proof_floor,
            ),
            patch("app.main.SessionLocal", self.session_local),
        ):
            response = self.client.get("/trading/consumer-evidence")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(
            payload["schema_version"], "torghut.consumer-evidence-status.v1"
        )
        self.assertEqual(payload["control_plane_dependency_mode"], "caller_evaluated")
        self.assertEqual(payload["dependency_quorum"]["decision"], "allow")
        self.assertEqual(payload["proof_floor"], proof_floor)
        self.assertNotIn("route_reacquisition_board", payload)
        receipt = payload["torghut_consumer_evidence_receipt"]
        self.assertEqual(
            receipt["schema_version"],
            "torghut.consumer-evidence-receipt.v1",
        )
        self.assertEqual(receipt["paper_readiness_state"], "blocked")
        self.assertIn("simple_submit_disabled", receipt["reason_codes"])
        route_proven_receipt = payload["route_proven_profit_receipt"]
        self.assertEqual(
            route_proven_receipt["schema_version"],
            "torghut.route-proven-profit-receipt.v1",
        )
        self.assertEqual(route_proven_receipt["decision"], "repair")
        self.assertEqual(route_proven_receipt["capital_state"], "zero_notional")
        self.assertEqual(
            route_proven_receipt["consumer_evidence_receipt_id"],
            receipt["receipt_id"],
        )
        self.assertEqual(
            payload["consumer_evidence_canary"],
            route_proven_receipt["route_canary"],
        )
        self.assertEqual(
            payload["consumer_evidence_canary"]["expected_schema"],
            "torghut.consumer-evidence-status.v1",
        )
        ledger = payload["capital_reentry_cohort_ledger"]
        self.assertEqual(
            ledger["schema_version"],
            "torghut.capital-reentry-cohort-ledger.v1",
        )
        self.assertEqual(
            ledger["consumer_evidence_receipt_id"],
            receipt["receipt_id"],
        )
        self.assertEqual(ledger["summary"]["zero_notional_cohort_count"], 5)
        profit_repair = payload["profit_repair_settlement_ledger"]
        self.assertEqual(
            profit_repair["schema_version"],
            "torghut.profit-repair-settlement-ledger.v1",
        )
        self.assertEqual(
            profit_repair["consumer_evidence_receipt_id"],
            receipt["receipt_id"],
        )
        self.assertEqual(profit_repair["summary"]["zero_notional_lot_count"], 7)
        dependency_fetch.assert_not_called()
        continuity_fetch.assert_not_called()

    def test_route_continuity_delegates_to_jangar_when_registry_requires_it(
        self,
    ) -> None:
        expected_packet = {
            "epoch_id": "jangar-epoch",
            "state": "present",
            "decision": "allow",
            "fresh_until": "2026-05-08T21:00:00+00:00",
            "blocking_reasons": [],
            "action_class": "paper_canary",
        }

        with (
            patch(
                "app.main.hypothesis_registry_requires_dependency_capability",
                return_value=True,
            ) as requires_capability,
            patch(
                "app.main.load_jangar_route_continuity_packet",
                return_value=expected_packet,
            ) as continuity_fetch,
        ):
            packet = _route_continuity_packet_for_proof_floor(
                {"generated_at": "2026-05-08T20:00:00+00:00"}
            )

        self.assertEqual(packet, expected_packet)
        requires_capability.assert_called_once()
        continuity_fetch.assert_called_once_with(action_class="paper_canary")

    def test_trading_status_uses_isolated_db_sessions_for_late_reads(self) -> None:
        observed_sessions: list[Session] = []

        def _load_llm_evaluation(session: Session) -> dict[str, object]:
            observed_sessions.append(session)
            return {"ok": True, "metrics": {"total_reviews": 1}}

        def _load_tca(session: Session, **_kwargs: object) -> dict[str, object]:
            observed_sessions.append(session)
            return {}

        def _load_last_decision_at(session: Session) -> None:
            observed_sessions.append(session)
            return None

        def _build_live_submission_gate(
            *args: object, **kwargs: object
        ) -> dict[str, object]:
            session = kwargs["session"]
            assert isinstance(session, Session)
            observed_sessions.append(session)
            return {"allowed": True, "reason": "ready", "blocked_reasons": []}

        with (
            patch("app.main._load_llm_evaluation", side_effect=_load_llm_evaluation),
            patch("app.main._load_tca_summary", side_effect=_load_tca),
            patch(
                "app.main._load_last_decision_at", side_effect=_load_last_decision_at
            ),
            patch(
                "app.main._build_live_submission_gate_payload",
                side_effect=_build_live_submission_gate,
            ),
            patch("app.main.SessionLocal", self.session_local),
        ):
            response = self.client.get("/trading/status")

        self.assertEqual(response.status_code, 200)
        self.assertGreaterEqual(len(observed_sessions), 4)
        self.assertIs(observed_sessions[0], observed_sessions[1])
        self.assertIsNot(observed_sessions[0], observed_sessions[2])
        self.assertIsNot(observed_sessions[2], observed_sessions[3])

    def test_readiness_checks_external_dependencies_before_postgres_session(
        self,
    ) -> None:
        call_order: list[str] = []
        original_trading_enabled = settings.trading_enabled
        settings.trading_enabled = True
        try:
            with (
                patch(
                    "app.main._check_clickhouse",
                    side_effect=lambda: (
                        call_order.append("clickhouse") or {"ok": True, "detail": "ok"}
                    ),
                ),
                patch(
                    "app.main._check_alpaca",
                    side_effect=lambda: (
                        call_order.append("alpaca") or {"ok": True, "detail": "ok"}
                    ),
                ),
                patch(
                    "app.main._check_postgres",
                    side_effect=lambda _session: (
                        call_order.append("postgres") or {"ok": True, "detail": "ok"}
                    ),
                ),
            ):
                with self.session_local() as session:
                    _readiness_dependency_checks(
                        session,
                        include_database_contract=False,
                    )
        finally:
            settings.trading_enabled = original_trading_enabled

        self.assertEqual(call_order, ["clickhouse", "alpaca", "postgres"])

    def test_trading_status_surfaces_simple_lane_fields(self) -> None:
        original_pipeline_mode = settings.trading_pipeline_mode
        original_trading_enabled = settings.trading_enabled
        original_trading_mode = settings.trading_mode
        original_simple_submit_enabled = settings.trading_simple_submit_enabled
        original_kill_switch_enabled = settings.trading_kill_switch_enabled

        settings.trading_pipeline_mode = "simple"
        settings.trading_enabled = True
        settings.trading_mode = "live"
        settings.trading_simple_submit_enabled = True
        settings.trading_kill_switch_enabled = False
        try:
            scheduler = TradingScheduler()
            scheduler.state.metrics.orders_submitted_total = 7
            scheduler.state.metrics.decision_reject_reason_total = {
                "broker_submit_failed": 2,
                "capital_stage_shadow": 9,
            }
            scheduler.state.metrics.strategy_intent_suppression_total = {
                "strategy-1|exit_only_sell_without_long_position": 4,
            }
            app.state.trading_scheduler = scheduler

            response = self.client.get("/trading/status")
            self.assertEqual(response.status_code, 200)
            payload = response.json()

            self.assertEqual(payload["pipeline_mode"], "simple")
            self.assertEqual(payload["execution_lane"], "simple")
            self.assertFalse(payload["live_submission_gate"]["allowed"])
            self.assertEqual(
                payload["live_submission_gate"]["reason"],
                "alpha_readiness_not_promotion_eligible",
            )
            self.assertTrue(
                payload["live_submission_gate"]["simple_lane"]["shared_gate_enforced"]
            )
            self.assertIn(
                "profit_window_contract",
                payload["live_submission_gate"],
            )
            self.assertEqual(payload["simple_lane_orders_submitted_total"], 7)
            self.assertEqual(
                payload["simple_lane_reject_reason_totals"],
                {"broker_submit_failed": 2},
            )
            self.assertEqual(
                payload["rejections"]["strategy_intent_suppression_total"],
                {"strategy-1|exit_only_sell_without_long_position": 4},
            )
            self.assertTrue(payload["simple_lane_status"]["enabled"])
            self.assertTrue(
                payload["simple_lane_status"]["route_symbol_filter_enabled"]
            )
            self.assertEqual(
                payload["simple_lane_status"]["allowed_reject_reasons"][0],
                "broker_precheck_failed",
            )
        finally:
            settings.trading_pipeline_mode = original_pipeline_mode
            settings.trading_enabled = original_trading_enabled
            settings.trading_mode = original_trading_mode
            settings.trading_simple_submit_enabled = original_simple_submit_enabled
            settings.trading_kill_switch_enabled = original_kill_switch_enabled

    def test_simple_lane_shared_gate_applies_local_block_reason(self) -> None:
        original = {
            "trading_pipeline_mode": settings.trading_pipeline_mode,
            "trading_enabled": settings.trading_enabled,
            "trading_mode": settings.trading_mode,
            "trading_simple_submit_enabled": settings.trading_simple_submit_enabled,
            "trading_kill_switch_enabled": settings.trading_kill_switch_enabled,
            "trading_emergency_stop_enabled": settings.trading_emergency_stop_enabled,
        }
        settings.trading_pipeline_mode = "simple"
        settings.trading_enabled = False
        settings.trading_mode = "live"
        settings.trading_simple_submit_enabled = True
        settings.trading_kill_switch_enabled = False
        settings.trading_emergency_stop_enabled = False
        try:
            with patch(
                "app.main.build_live_submission_gate_payload",
                return_value={
                    "allowed": True,
                    "reason": "ready",
                    "blocked_reasons": [],
                    "capital_stage": "live",
                    "capital_state": "live",
                },
            ):
                gate = _build_live_submission_gate_payload(
                    SimpleNamespace(emergency_stop_active=False),
                    session=None,
                    hypothesis_summary={},
                )
        finally:
            settings.trading_pipeline_mode = original["trading_pipeline_mode"]
            settings.trading_enabled = original["trading_enabled"]
            settings.trading_mode = original["trading_mode"]
            settings.trading_simple_submit_enabled = original[
                "trading_simple_submit_enabled"
            ]
            settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            settings.trading_emergency_stop_enabled = original[
                "trading_emergency_stop_enabled"
            ]

        self.assertFalse(gate["allowed"])
        self.assertEqual(gate["reason"], "trading_disabled")
        self.assertEqual(gate["capital_stage"], "shadow")
        self.assertEqual(gate["capital_state"], "observe")
        self.assertEqual(gate["blocked_reasons"], ["trading_disabled"])
        self.assertEqual(
            gate["simple_lane"],
            {
                "submit_enabled": True,
                "shared_gate_enforced": True,
                "blocked_reasons": ["trading_disabled"],
            },
        )

    def test_trading_status_and_health_include_profitability_proof_floor(
        self,
    ) -> None:
        proof_floor = {
            "schema_version": "torghut.profitability-proof-floor.v1",
            "generated_at": "2026-05-07T22:11:12.125118+00:00",
            "account_label": "PA3SX7FYNUTF",
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "repair_ladder": [{"code": "repair_execution_tca"}],
            "route_reacquisition_book": {
                "schema_version": "torghut.route-reacquisition-book.v1",
                "account_label": "PA3SX7FYNUTF",
                "trading_mode": "live",
                "records": [
                    {
                        "symbol": "NVDA",
                        "state": "blocked",
                        "reason": "execution_tca_route_universe_incomplete",
                        "filled_execution_count": 12,
                        "next_repair_action": "repair_route_evidence_before_paper_probe",
                    }
                ],
                "summary": {"blocked_symbol_count": 1},
            },
        }

        with patch(
            "app.main.build_profitability_proof_floor_receipt",
            return_value=proof_floor,
        ):
            status_response = self.client.get("/trading/status")
            health_response = self.client.get("/trading/health")

        self.assertEqual(status_response.status_code, 200)
        self.assertIn(health_response.status_code, {200, 503})
        self.assertEqual(status_response.json()["proof_floor"], proof_floor)
        status_consumer_evidence = status_response.json()[
            "torghut_consumer_evidence_receipt"
        ]
        self.assertEqual(
            status_consumer_evidence["schema_version"],
            "torghut.consumer-evidence-receipt.v1",
        )
        self.assertEqual(status_consumer_evidence["paper_readiness_state"], "blocked")
        self.assertIn(
            "forecast_registry_degraded", status_consumer_evidence["reason_codes"]
        )
        status_route_receipt = status_response.json()["route_proven_profit_receipt"]
        self.assertEqual(
            status_route_receipt["schema_version"],
            "torghut.route-proven-profit-receipt.v1",
        )
        self.assertEqual(status_route_receipt["decision"], "repair")
        self.assertEqual(
            status_route_receipt["consumer_evidence_receipt_id"],
            status_consumer_evidence["receipt_id"],
        )
        self.assertEqual(
            status_response.json()["consumer_evidence_canary"],
            status_route_receipt["route_canary"],
        )
        self.assertEqual(
            status_response.json()["route_reacquisition_book"],
            proof_floor["route_reacquisition_book"],
        )
        status_board = status_response.json()["route_reacquisition_board"]
        self.assertEqual(
            status_board["schema_version"],
            "torghut.route-reacquisition-board.v1",
        )
        self.assertEqual(status_board["state"], "repair_only")
        self.assertEqual(status_board["summary"]["zero_notional_row_count"], 1)
        self.assertEqual(status_board["rows"][0]["symbol"], "NVDA")
        self.assertEqual(status_board["rows"][0]["max_notional"], "0")
        self.assertEqual(health_response.json()["proof_floor"], proof_floor)
        self.assertEqual(
            health_response.json()["torghut_consumer_evidence_receipt"][
                "schema_version"
            ],
            "torghut.consumer-evidence-receipt.v1",
        )
        self.assertEqual(
            health_response.json()["route_proven_profit_receipt"]["schema_version"],
            "torghut.route-proven-profit-receipt.v1",
        )
        self.assertEqual(
            health_response.json()["route_reacquisition_book"],
            proof_floor["route_reacquisition_book"],
        )
        health_board = health_response.json()["route_reacquisition_board"]
        self.assertEqual(
            health_board["schema_version"],
            "torghut.route-reacquisition-board.v1",
        )
        self.assertEqual(health_board["state"], status_board["state"])
        self.assertEqual(health_board["summary"], status_board["summary"])
        self.assertEqual(health_board["rows"], status_board["rows"])
        self.assertEqual(
            health_response.json()["dependencies"]["profitability_proof_floor"][
                "detail"
            ],
            "repair_only",
        )
        status_ledger = status_response.json()["capital_reentry_cohort_ledger"]
        health_ledger = health_response.json()["capital_reentry_cohort_ledger"]
        self.assertEqual(
            status_ledger["schema_version"],
            "torghut.capital-reentry-cohort-ledger.v1",
        )
        self.assertEqual(status_ledger["aggregate_state"], "repair")
        self.assertEqual(status_ledger["summary"]["zero_notional_cohort_count"], 5)
        self.assertEqual(
            health_ledger["schema_version"], status_ledger["schema_version"]
        )
        self.assertTrue(
            str(health_ledger["consumer_evidence_receipt_id"]).startswith(
                "torghut-consumer-evidence:"
            )
        )
        status_profit_repair = status_response.json()["profit_repair_settlement_ledger"]
        health_profit_repair = health_response.json()["profit_repair_settlement_ledger"]
        self.assertEqual(
            status_profit_repair["schema_version"],
            "torghut.profit-repair-settlement-ledger.v1",
        )
        self.assertEqual(status_profit_repair["summary"]["zero_notional_lot_count"], 7)
        self.assertEqual(
            health_profit_repair["schema_version"],
            status_profit_repair["schema_version"],
        )

    def test_trading_status_and_health_include_renewal_bond_profit_escrow(
        self,
    ) -> None:
        escrow = {
            "schema_version": "torghut.renewal-bond-profit-escrow.v1",
            "receipt_id": "rbpe-test",
            "escrow_verdict": "repair_only",
            "capital_state": "zero_notional",
            "max_notional": "0",
            "selected_zero_notional_repairs": [
                {"code": "refresh_execution_tca_settlement"}
            ],
        }

        with patch(
            "app.main.build_renewal_bond_profit_escrow",
            return_value=escrow,
        ):
            status_response = self.client.get("/trading/status")
            health_response = self.client.get("/trading/health")

        self.assertEqual(status_response.status_code, 200)
        self.assertIn(health_response.status_code, {200, 503})
        self.assertEqual(status_response.json()["renewal_bond_profit_escrow"], escrow)
        self.assertEqual(health_response.json()["renewal_bond_profit_escrow"], escrow)

    def test_trading_status_health_and_autonomy_include_alpha_replay_projection(
        self,
    ) -> None:
        projection = {
            "capital_replay_board": {
                "schema_version": "torghut.capital-replay-board.v1",
                "board_id": "capital-replay:test",
                "summary": {"replay_item_count": 1},
                "replay_items": [{"max_notional": "0"}],
            },
            "executable_alpha_receipts": {
                "schema_version": "torghut.executable-alpha-receipts.v1",
                "summary": {"receipts_total": 1},
                "receipts": [{"graduation_state": "candidate"}],
            },
        }

        with (
            patch(
                "app.main.build_capital_replay_projection",
                return_value=projection,
            ),
            patch(
                "app.main._build_autonomy_capital_replay_projection",
                return_value=projection,
            ),
        ):
            status_response = self.client.get("/trading/status")
            health_response = self.client.get("/trading/health")
            autonomy_response = self.client.get("/trading/autonomy")

        self.assertEqual(status_response.status_code, 200)
        self.assertIn(health_response.status_code, {200, 503})
        self.assertEqual(autonomy_response.status_code, 200)
        for response in (status_response, health_response, autonomy_response):
            payload = response.json()
            self.assertEqual(
                payload["capital_replay_board"],
                projection["capital_replay_board"],
            )
            self.assertEqual(
                payload["executable_alpha_receipts"],
                projection["executable_alpha_receipts"],
            )

    def test_trading_status_and_health_include_quality_adjusted_frontier(
        self,
    ) -> None:
        frontier = {
            "schema_version": "torghut.quality-adjusted-profit-frontier.v1",
            "frontier_id": "quality-frontier:test",
            "summary": {"packet_count": 1, "capital_ready": False},
            "packets": [{"repair_class": "quant", "max_notional": "0"}],
            "paper_probe_notional_limit": "0",
        }

        with patch(
            "app.main.build_quality_adjusted_profit_frontier",
            return_value=frontier,
        ):
            status_response = self.client.get("/trading/status")
            health_response = self.client.get("/trading/health")

        self.assertEqual(status_response.status_code, 200)
        self.assertIn(health_response.status_code, {200, 503})
        self.assertEqual(
            status_response.json()["quality_adjusted_profit_frontier"],
            frontier,
        )
        self.assertEqual(
            health_response.json()["quality_adjusted_profit_frontier"],
            frontier,
        )

    def test_trading_health_requires_profitability_proof_floor_in_live(self) -> None:
        original_enabled = settings.trading_enabled
        original_mode = settings.trading_mode
        original_source = settings.trading_universe_source
        original_empirical_required = settings.trading_empirical_jobs_health_required
        settings.trading_enabled = True
        settings.trading_mode = "live"
        settings.trading_universe_source = "static"
        settings.trading_empirical_jobs_health_required = False
        try:
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            app.state.trading_scheduler = scheduler

            with (
                patch("app.main._check_alpaca", return_value={"ok": True}),
                patch("app.main._check_clickhouse", return_value={"ok": True}),
                patch("app.main._check_postgres", return_value={"ok": True}),
                patch(
                    "app.main.check_account_scope_invariants",
                    return_value={
                        "account_scope_ready": True,
                        "account_scope_errors": [],
                    },
                ),
                patch(
                    "app.main.check_schema_current",
                    return_value={
                        "schema_current": True,
                        "current_heads": ["0011_execution_tca_simulator_divergence"],
                        "expected_heads": ["0011_execution_tca_simulator_divergence"],
                        "schema_head_signature": "7f8e4d0",
                    },
                ),
                patch(
                    "app.main._build_live_submission_gate_payload",
                    return_value={
                        "allowed": True,
                        "reason": "ready",
                        "blocked_reasons": [],
                        "capital_stage": "live",
                    },
                ),
                patch(
                    "app.main._empirical_jobs_status",
                    return_value={"ready": False, "status": "degraded"},
                ),
                patch(
                    "app.main.load_quant_evidence_status",
                    return_value={
                        "required": False,
                        "ok": True,
                        "status": "not_required",
                        "reason": "quant_health_not_configured",
                    },
                ),
                patch(
                    "app.main._build_profitability_proof_floor_payload",
                    return_value={
                        "route_state": "repair_only",
                        "capital_state": "zero_notional",
                    },
                ),
            ):
                response = self.client.get("/trading/health")

            self.assertEqual(response.status_code, 503)
            dependency = response.json()["dependencies"]["profitability_proof_floor"]
            self.assertFalse(dependency["ok"])
            self.assertEqual(dependency["detail"], "repair_only")
            self.assertTrue(dependency["required"])
        finally:
            settings.trading_enabled = original_enabled
            settings.trading_mode = original_mode
            settings.trading_universe_source = original_source
            settings.trading_empirical_jobs_health_required = (
                original_empirical_required
            )

    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": True, "detail": "ok"})
    @patch(
        "app.main.check_account_scope_invariants",
        return_value={"account_scope_ready": True, "account_scope_errors": []},
    )
    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
        },
    )
    def test_trading_health_ok(
        self,
        _mock_schema: object,
        _mock_account_scope: object,
        _mock_clickhouse: object,
        _mock_alpaca: object,
    ) -> None:
        original = settings.trading_enabled
        original_mode = settings.trading_mode
        original_source = settings.trading_universe_source
        settings.trading_enabled = True
        settings.trading_mode = "paper"
        settings.trading_universe_source = "jangar"
        try:
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            scheduler.state.universe_source_status = "ok"
            scheduler.state.universe_source_reason = "jangar_fetch_ok"
            scheduler.state.universe_symbols_count = 2
            scheduler.state.universe_cache_age_seconds = 0
            app.state.trading_scheduler = scheduler
            response = self.client.get("/trading/health")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertEqual(payload["status"], "ok")
            self.assertTrue(payload["dependencies"]["postgres"]["ok"])
            self.assertTrue(payload["dependencies"]["clickhouse"]["ok"])
            self.assertTrue(payload["dependencies"]["alpaca"]["ok"])
            self.assertIn("universe", payload["dependencies"])
            self.assertTrue(payload["dependencies"]["universe"]["ok"])
            self.assertEqual(payload["dependencies"]["universe"]["status"], "ok")
            self.assertEqual(
                payload["dependencies"]["universe"]["detail"], "jangar universe fresh"
            )
        finally:
            settings.trading_enabled = original
            settings.trading_mode = original_mode
            settings.trading_universe_source = original_source

    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": True, "detail": "ok"})
    @patch(
        "app.main.check_account_scope_invariants",
        return_value={"account_scope_ready": True, "account_scope_errors": []},
    )
    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
        },
    )
    def test_trading_health_resolves_jangar_universe_before_reporting_ok(
        self,
        _mock_schema: object,
        _mock_account_scope: object,
        _mock_clickhouse: object,
        _mock_alpaca: object,
    ) -> None:
        original = settings.trading_enabled
        original_mode = settings.trading_mode
        original_source = settings.trading_universe_source
        original_require_non_empty = settings.trading_universe_require_non_empty_jangar
        settings.trading_enabled = True
        settings.trading_mode = "paper"
        settings.trading_universe_source = "jangar"
        settings.trading_universe_require_non_empty_jangar = True
        try:
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            scheduler.state.universe_source_status = "not_evaluated"
            scheduler.state.universe_symbols_count = 0
            _install_pipeline_universe_resolver(
                scheduler,
                SimpleNamespace(
                    get_resolution=lambda: SimpleNamespace(
                        symbols={"AMD", "NVDA"},
                        status="ok",
                        reason="jangar_fetch_ok",
                        cache_age_seconds=0,
                    )
                ),
            )
            app.state.trading_scheduler = scheduler

            response = self.client.get("/trading/health")

            self.assertEqual(response.status_code, 200)
            payload = response.json()
            universe_dependency = payload["dependencies"]["universe"]
            self.assertTrue(universe_dependency["ok"])
            self.assertEqual(universe_dependency["status"], "ok")
            self.assertEqual(universe_dependency["symbols_count"], 2)
            self.assertEqual(scheduler.state.universe_symbols_count, 2)
        finally:
            settings.trading_enabled = original
            settings.trading_mode = original_mode
            settings.trading_universe_source = original_source
            settings.trading_universe_require_non_empty_jangar = (
                original_require_non_empty
            )

    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": True, "detail": "ok"})
    @patch(
        "app.main.check_account_scope_invariants",
        return_value={"account_scope_ready": True, "account_scope_errors": []},
    )
    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
        },
    )
    def test_trading_health_resolves_static_universe_before_reporting_ok(
        self,
        _mock_schema: object,
        _mock_account_scope: object,
        _mock_clickhouse: object,
        _mock_alpaca: object,
    ) -> None:
        original = settings.trading_enabled
        original_mode = settings.trading_mode
        original_source = settings.trading_universe_source
        settings.trading_enabled = True
        settings.trading_mode = "paper"
        settings.trading_universe_source = "static"
        try:
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            scheduler.state.universe_source_status = "not_evaluated"
            scheduler.state.universe_symbols_count = 0
            _install_pipeline_universe_resolver(
                scheduler,
                SimpleNamespace(
                    get_resolution=lambda: SimpleNamespace(
                        symbols={"AAPL", "NVDA"},
                        status="ok",
                        reason="static_symbols_loaded",
                        cache_age_seconds=None,
                    )
                ),
            )
            app.state.trading_scheduler = scheduler

            response = self.client.get("/trading/health")

            self.assertEqual(response.status_code, 200)
            payload = response.json()
            universe_dependency = payload["dependencies"]["universe"]
            self.assertTrue(universe_dependency["ok"])
            self.assertEqual(universe_dependency["source"], "static")
            self.assertEqual(universe_dependency["status"], "ok")
            self.assertEqual(universe_dependency["reason"], "static_symbols_loaded")
            self.assertEqual(universe_dependency["symbols_count"], 2)
            self.assertEqual(universe_dependency["detail"], "static universe loaded")
            self.assertTrue(universe_dependency["require_non_empty"])
            self.assertEqual(scheduler.state.universe_symbols_count, 2)
            self.assertFalse(scheduler.state.universe_fail_safe_blocked)
        finally:
            settings.trading_enabled = original
            settings.trading_mode = original_mode
            settings.trading_universe_source = original_source

    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_postgres", return_value={"ok": True, "detail": "ok"})
    @patch(
        "app.main.check_account_scope_invariants",
        return_value={"account_scope_ready": True, "account_scope_errors": []},
    )
    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
        },
    )
    def test_trading_health_fails_closed_when_static_universe_probe_is_empty(
        self,
        _mock_schema: object,
        _mock_account_scope: object,
        _mock_postgres: object,
        _mock_clickhouse: object,
        _mock_alpaca: object,
    ) -> None:
        original = settings.trading_enabled
        original_mode = settings.trading_mode
        original_source = settings.trading_universe_source
        settings.trading_enabled = True
        settings.trading_mode = "paper"
        settings.trading_universe_source = "static"
        try:
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            scheduler.state.universe_source_status = "not_evaluated"
            scheduler.state.universe_symbols_count = 0
            _install_pipeline_universe_resolver(
                scheduler,
                SimpleNamespace(
                    get_resolution=lambda: SimpleNamespace(
                        symbols=set(),
                        status="empty",
                        reason="static_symbols_empty",
                        cache_age_seconds=None,
                    )
                ),
            )
            app.state.trading_scheduler = scheduler

            response = self.client.get("/trading/health")

            self.assertEqual(response.status_code, 503)
            payload = response.json()
            universe_dependency = payload["dependencies"]["universe"]
            self.assertFalse(universe_dependency["ok"])
            self.assertEqual(universe_dependency["source"], "static")
            self.assertEqual(universe_dependency["status"], "empty")
            self.assertEqual(universe_dependency["reason"], "static_symbols_empty")
            self.assertEqual(universe_dependency["detail"], "static universe empty")
            self.assertTrue(universe_dependency["require_non_empty"])
            self.assertEqual(scheduler.state.universe_symbols_count, 0)
            self.assertTrue(scheduler.state.universe_fail_safe_blocked)
            self.assertEqual(
                scheduler.state.universe_fail_safe_block_reason,
                "static_symbols_empty",
            )
        finally:
            settings.trading_enabled = original
            settings.trading_mode = original_mode
            settings.trading_universe_source = original_source

    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_postgres", return_value={"ok": True, "detail": "ok"})
    @patch(
        "app.main.check_account_scope_invariants",
        return_value={"account_scope_ready": True, "account_scope_errors": []},
    )
    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
        },
    )
    def test_trading_health_fails_closed_when_universe_probe_is_empty(
        self,
        _mock_schema: object,
        _mock_account_scope: object,
        _mock_postgres: object,
        _mock_clickhouse: object,
        _mock_alpaca: object,
    ) -> None:
        original = settings.trading_enabled
        original_mode = settings.trading_mode
        original_source = settings.trading_universe_source
        original_require_non_empty = settings.trading_universe_require_non_empty_jangar
        settings.trading_enabled = True
        settings.trading_mode = "paper"
        settings.trading_universe_source = "jangar"
        settings.trading_universe_require_non_empty_jangar = True
        try:
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            scheduler.state.universe_source_status = "not_evaluated"
            scheduler.state.universe_symbols_count = 0
            _install_pipeline_universe_resolver(
                scheduler,
                SimpleNamespace(
                    get_resolution=lambda: SimpleNamespace(
                        symbols=set(),
                        status="empty",
                        reason="jangar_empty_response_cache_stale",
                        cache_age_seconds=None,
                    )
                ),
            )
            app.state.trading_scheduler = scheduler

            response = self.client.get("/trading/health")

            self.assertEqual(response.status_code, 503)
            payload = response.json()
            universe_dependency = payload["dependencies"]["universe"]
            self.assertFalse(universe_dependency["ok"])
            self.assertEqual(universe_dependency["status"], "empty")
            self.assertEqual(universe_dependency["detail"], "jangar universe empty")
            self.assertEqual(scheduler.state.universe_symbols_count, 0)
            self.assertTrue(scheduler.state.universe_fail_safe_blocked)
        finally:
            settings.trading_enabled = original
            settings.trading_mode = original_mode
            settings.trading_universe_source = original_source
            settings.trading_universe_require_non_empty_jangar = (
                original_require_non_empty
            )

    @patch("app.main.load_quant_evidence_status")
    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": True, "detail": "ok"})
    @patch(
        "app.main.check_account_scope_invariants",
        return_value={"account_scope_ready": True, "account_scope_errors": []},
    )
    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
        },
    )
    def test_trading_health_treats_quant_evidence_as_informational_outside_live_mode(
        self,
        _mock_schema: object,
        _mock_account_scope: object,
        _mock_clickhouse: object,
        _mock_alpaca: object,
        mock_quant_evidence: object,
    ) -> None:
        original = settings.trading_enabled
        original_mode = settings.trading_mode
        original_source = settings.trading_universe_source
        settings.trading_enabled = True
        settings.trading_mode = "paper"
        settings.trading_universe_source = "jangar"
        try:
            mock_quant_evidence.return_value = {
                "required": True,
                "ok": False,
                "status": "unknown",
                "reason": "quant_health_fetch_failed",
                "blocking_reasons": ["quant_health_fetch_failed"],
                "account": "paper",
                "window": "15m",
                "source_url": "https://jangar.example/custom/proxy/quant/health?account=paper&window=15m",
            }
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            scheduler.state.universe_source_status = "ok"
            scheduler.state.universe_source_reason = "jangar_fetch_ok"
            scheduler.state.universe_symbols_count = 2
            scheduler.state.universe_cache_age_seconds = 0
            app.state.trading_scheduler = scheduler

            response = self.client.get("/trading/health")

            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertEqual(payload["status"], "ok")
            self.assertTrue(payload["dependencies"]["quant_evidence"]["ok"])
            self.assertEqual(
                payload["dependencies"]["quant_evidence"]["detail"],
                "not_required_in_non_live_mode",
            )
            self.assertFalse(payload["quant_evidence"]["ok"])
            self.assertEqual(
                payload["quant_evidence"]["reason"], "quant_health_fetch_failed"
            )
        finally:
            settings.trading_enabled = original
            settings.trading_mode = original_mode
            settings.trading_universe_source = original_source

    @patch(
        "app.main._build_live_submission_gate_payload",
        return_value={
            "allowed": True,
            "reason": "ready",
            "blocked_reasons": [],
            "capital_stage": "live",
        },
    )
    @patch("app.main._empirical_jobs_status")
    @patch("app.main.load_quant_evidence_status")
    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": True, "detail": "ok"})
    @patch(
        "app.main.check_account_scope_invariants",
        return_value={"account_scope_ready": True, "account_scope_errors": []},
    )
    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
        },
    )
    def test_trading_health_live_external_authorities_are_informational_when_not_required(
        self,
        _mock_schema: object,
        _mock_account_scope: object,
        _mock_clickhouse: object,
        _mock_alpaca: object,
        mock_quant_evidence: object,
        mock_empirical_jobs: object,
        _mock_submission_gate: object,
    ) -> None:
        original_enabled = settings.trading_enabled
        original_mode = settings.trading_mode
        original_source = settings.trading_universe_source
        original_empirical_required = settings.trading_empirical_jobs_health_required
        settings.trading_enabled = True
        settings.trading_mode = "live"
        settings.trading_universe_source = "static"
        settings.trading_empirical_jobs_health_required = False
        try:
            mock_empirical_jobs.return_value = {
                "ready": False,
                "status": "degraded",
                "authority": "blocked",
            }
            mock_quant_evidence.return_value = {
                "required": False,
                "ok": True,
                "status": "not_required",
                "reason": "quant_health_not_configured",
                "blocking_reasons": [],
                "account": "live",
                "window": "15m",
                "source_url": None,
            }
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            _mark_static_universe_loaded(scheduler)
            app.state.trading_scheduler = scheduler

            with patch(
                "app.main._build_profitability_proof_floor_payload",
                return_value={
                    "route_state": "live_micro_candidate",
                    "capital_state": "live_allowed",
                },
            ):
                response = self.client.get("/trading/health")

            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertEqual(payload["status"], "ok")
            self.assertTrue(payload["dependencies"]["empirical_jobs"]["ok"])
            self.assertFalse(payload["dependencies"]["empirical_jobs"]["required"])
            self.assertTrue(payload["dependencies"]["quant_evidence"]["ok"])
            self.assertFalse(payload["dependencies"]["quant_evidence"]["required"])
            self.assertTrue(payload["dependencies"]["profitability_proof_floor"]["ok"])
        finally:
            settings.trading_enabled = original_enabled
            settings.trading_mode = original_mode
            settings.trading_universe_source = original_source
            settings.trading_empirical_jobs_health_required = (
                original_empirical_required
            )

    @patch(
        "app.main._evaluate_database_contract",
        return_value={
            "ok": True,
            "schema_current": True,
            "schema_current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
            "checked_at": "2026-03-04T00:00:00+00:00",
            "account_scope_ready": True,
            "account_scope_errors": [],
        },
    )
    @patch("app.main._check_postgres", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    def test_readyz_reuses_dependency_checks_within_cache_ttl(
        self,
        _mock_alpaca: object,
        _mock_clickhouse: object,
        _mock_postgres: object,
        _mock_contract: object,
    ) -> None:
        original = settings.trading_enabled
        original_mode = settings.trading_mode
        original_cache_enabled = settings.trading_readiness_dependency_cache_enabled
        original_cache_ttl = settings.trading_readiness_dependency_cache_ttl_seconds
        settings.trading_enabled = True
        settings.trading_mode = "paper"
        settings.trading_readiness_dependency_cache_enabled = True
        settings.trading_readiness_dependency_cache_ttl_seconds = 8
        try:
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            _mark_static_universe_loaded(scheduler)
            app.state.trading_scheduler = scheduler
            response = self.client.get("/readyz")
            self.assertEqual(response.status_code, 200)
            response = self.client.get("/readyz")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(_mock_postgres.call_count, 1)
            self.assertEqual(_mock_clickhouse.call_count, 1)
            self.assertEqual(_mock_alpaca.call_count, 1)
            payload = response.json()
            self.assertEqual(
                payload["dependencies"]["readiness_cache"]["cache_used"], True
            )
            self.assertIn("checked_at", payload["dependencies"]["readiness_cache"])
        finally:
            settings.trading_enabled = original
            settings.trading_mode = original_mode
            settings.trading_readiness_dependency_cache_enabled = original_cache_enabled
            settings.trading_readiness_dependency_cache_ttl_seconds = original_cache_ttl

    @patch(
        "app.main._evaluate_database_contract",
        return_value={
            "ok": True,
            "schema_current": True,
            "schema_current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
            "checked_at": "2026-03-04T00:00:00+00:00",
            "account_scope_ready": True,
            "account_scope_errors": [],
        },
    )
    @patch("app.main._check_postgres", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    def test_readyz_refreshes_dependency_checks_after_cache_ttl(
        self,
        _mock_alpaca: object,
        _mock_clickhouse: object,
        _mock_postgres: object,
        _mock_contract: object,
    ) -> None:
        original = settings.trading_enabled
        original_mode = settings.trading_mode
        original_cache_enabled = settings.trading_readiness_dependency_cache_enabled
        original_cache_ttl = settings.trading_readiness_dependency_cache_ttl_seconds
        settings.trading_enabled = True
        settings.trading_mode = "paper"
        settings.trading_readiness_dependency_cache_enabled = True
        settings.trading_readiness_dependency_cache_ttl_seconds = 8
        try:
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            _mark_static_universe_loaded(scheduler)
            app.state.trading_scheduler = scheduler
            response = self.client.get("/readyz")
            self.assertEqual(response.status_code, 200)

            cache_key = _readiness_dependency_cache_key(include_database_contract=True)
            _TRADING_DEPENDENCY_HEALTH_CACHE[cache_key]["checked_at"] = datetime.now(
                timezone.utc
            ) - timedelta(seconds=120)
            response = self.client.get("/readyz")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(_mock_postgres.call_count, 2)
            self.assertEqual(_mock_clickhouse.call_count, 2)
            self.assertEqual(_mock_alpaca.call_count, 2)
            payload = response.json()
            self.assertEqual(
                payload["dependencies"]["readiness_cache"]["cache_used"], False
            )
        finally:
            settings.trading_enabled = original
            settings.trading_mode = original_mode
            settings.trading_readiness_dependency_cache_enabled = original_cache_enabled
            settings.trading_readiness_dependency_cache_ttl_seconds = original_cache_ttl

    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": False, "detail": "down"})
    @patch(
        "app.main.check_account_scope_invariants",
        return_value={"account_scope_ready": True, "account_scope_errors": []},
    )
    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
        },
    )
    def test_trading_health_dependency_failure(
        self,
        _mock_schema: object,
        _mock_account_scope: object,
        _mock_clickhouse: object,
        _mock_alpaca: object,
    ) -> None:
        original = settings.trading_enabled
        original_source = settings.trading_universe_source
        settings.trading_enabled = True
        settings.trading_universe_source = "jangar"
        try:
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            app.state.trading_scheduler = scheduler
            response = self.client.get("/trading/health")
            self.assertEqual(response.status_code, 503)
            payload = response.json()
            self.assertEqual(payload["status"], "degraded")
            self.assertFalse(payload["dependencies"]["clickhouse"]["ok"])
            self.assertIn("universe", payload["dependencies"])
        finally:
            settings.trading_enabled = original
            settings.trading_universe_source = original_source

    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_postgres", return_value={"ok": True, "detail": "ok"})
    @patch(
        "app.main.check_account_scope_invariants",
        return_value={"account_scope_ready": True, "account_scope_errors": []},
    )
    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
        },
    )
    def test_trading_health_flags_universe_blocking(
        self,
        _mock_schema: object,
        _mock_account_scope: object,
        _mock_postgres: object,
        _mock_clickhouse: object,
        _mock_alpaca: object,
    ) -> None:
        original = settings.trading_enabled
        original_source = settings.trading_universe_source
        settings.trading_enabled = True
        settings.trading_universe_source = "jangar"
        try:
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            scheduler.state.universe_source_status = "error"
            scheduler.state.universe_source_reason = "jangar_fetch_failed_cache_stale"
            scheduler.state.universe_symbols_count = 0
            scheduler.state.universe_cache_age_seconds = 600
            scheduler.state.universe_fail_safe_blocked = True
            scheduler.state.universe_fail_safe_block_reason = (
                "jangar_fetch_failed_cache_stale"
            )
            app.state.trading_scheduler = scheduler
            response = self.client.get("/trading/health")
            self.assertEqual(response.status_code, 503)
            payload = response.json()
            self.assertEqual(payload["status"], "degraded")
            universe_dependency = payload["dependencies"]["universe"]
            self.assertFalse(universe_dependency["ok"])
            self.assertEqual(universe_dependency["status"], "error")
            self.assertEqual(
                universe_dependency["detail"], "jangar universe unavailable"
            )
            self.assertEqual(
                universe_dependency["reason"], "jangar_fetch_failed_cache_stale"
            )
        finally:
            settings.trading_enabled = original
            settings.trading_universe_source = original_source

    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_postgres", return_value={"ok": True, "detail": "ok"})
    @patch(
        "app.main.check_account_scope_invariants",
        return_value={"account_scope_ready": True, "account_scope_errors": []},
    )
    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
        },
    )
    def test_trading_health_reports_static_fallback_universe_as_degraded_not_blocked(
        self,
        _mock_schema: object,
        _mock_account_scope: object,
        _mock_postgres: object,
        _mock_clickhouse: object,
        _mock_alpaca: object,
    ) -> None:
        original = settings.trading_enabled
        original_mode = settings.trading_mode
        original_source = settings.trading_universe_source
        settings.trading_enabled = True
        settings.trading_mode = "paper"
        settings.trading_universe_source = "jangar"
        try:
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            scheduler.state.universe_source_status = "degraded"
            scheduler.state.universe_source_reason = (
                "jangar_fetch_failed_cache_stale_using_static_fallback"
            )
            scheduler.state.universe_symbols_count = 8
            scheduler.state.universe_cache_age_seconds = 900
            scheduler.state.universe_fail_safe_blocked = False
            app.state.trading_scheduler = scheduler
            response = self.client.get("/trading/health")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertEqual(payload["status"], "ok")
            universe_dependency = payload["dependencies"]["universe"]
            self.assertTrue(universe_dependency["ok"])
            self.assertEqual(universe_dependency["status"], "degraded")
            self.assertEqual(
                universe_dependency["detail"], "jangar static fallback in use"
            )
        finally:
            settings.trading_enabled = original
            settings.trading_mode = original_mode
            settings.trading_universe_source = original_source

    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": True, "detail": "ok"})
    @patch(
        "app.main.check_account_scope_invariants",
        return_value={"account_scope_ready": True, "account_scope_errors": []},
    )
    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
        },
    )
    def test_readyz_returns_200_when_dependencies_are_healthy(
        self,
        _mock_schema: object,
        _mock_account_scope: object,
        _mock_clickhouse: object,
        _mock_alpaca: object,
    ) -> None:
        original = settings.trading_enabled
        original_source = settings.trading_universe_source
        settings.trading_enabled = True
        settings.trading_universe_source = "jangar"
        try:
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            scheduler.state.universe_source_status = "ok"
            scheduler.state.universe_source_reason = "jangar_fetch_ok"
            scheduler.state.universe_symbols_count = 2
            scheduler.state.universe_cache_age_seconds = 0
            app.state.trading_scheduler = scheduler
            response = self.client.get("/readyz")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertEqual(payload["status"], "ok")
            self.assertTrue(payload["dependencies"]["postgres"]["ok"])
            self.assertTrue(payload["dependencies"]["clickhouse"]["ok"])
            self.assertTrue(payload["dependencies"]["alpaca"]["ok"])
            self.assertIn("universe", payload["dependencies"])
            self.assertTrue(payload["dependencies"]["universe"]["ok"])
            self.assertTrue(payload["dependencies"]["database"]["schema_current"])
            self.assertEqual(
                payload["dependencies"]["database"]["schema_head_signature"], "7f8e4d0"
            )
            self.assertIn("checked_at", payload["dependencies"]["database"])
            self.assertIn("readiness_cache", payload["dependencies"])
            self.assertIn("cache_used", payload["dependencies"]["readiness_cache"])
            self.assertFalse(payload["dependencies"]["readiness_cache"]["cache_stale"])
        finally:
            settings.trading_enabled = original
            settings.trading_universe_source = original_source

    @patch(
        "app.main._alpaca_probe_account",
        side_effect=[
            {
                "ok": True,
                "status": "broker_ok",
                "detail": "ok",
                "account": {
                    "account_number": "PA3SX7FYNUTF",
                    "status": "ACTIVE",
                },
            },
            {
                "ok": False,
                "status": "broker_slow",
                "detail": "alpaca account probe timed out after 2.00s",
            },
        ],
    )
    @patch("app.main.TorghutAlpacaClient")
    def test_check_alpaca_uses_cached_last_known_good_for_slow_probe(
        self,
        mock_client: Any,
        _mock_probe: object,
    ) -> None:
        original_key = settings.apca_api_key_id
        original_secret = settings.apca_api_secret_key
        original_ttl = settings.trading_alpaca_healthcheck_last_good_ttl_seconds
        original_retries = settings.trading_alpaca_healthcheck_retries
        try:
            settings.apca_api_key_id = "demo-key"
            settings.apca_api_secret_key = "demo-secret"
            settings.trading_alpaca_healthcheck_last_good_ttl_seconds = 120
            settings.trading_alpaca_healthcheck_retries = 1
            mock_client.return_value.endpoint_class = "live"

            first = _check_alpaca()
            second = _check_alpaca()
        finally:
            settings.apca_api_key_id = original_key
            settings.apca_api_secret_key = original_secret
            settings.trading_alpaca_healthcheck_last_good_ttl_seconds = original_ttl
            settings.trading_alpaca_healthcheck_retries = original_retries

        self.assertTrue(first["ok"])
        self.assertEqual(first["broker_status"], "broker_ok")
        self.assertFalse(first["cache_used"])
        self.assertTrue(second["ok"])
        self.assertTrue(second["cache_used"])
        self.assertEqual(second["broker_status"], "broker_slow")
        self.assertEqual(second["endpoint_class"], "live")
        self.assertEqual(second["account_label"], "PA3SX7FYNUTF")

    @patch(
        "app.main._evaluate_database_contract",
        return_value={
            "ok": True,
            "schema_current": True,
            "schema_current_heads": ["0017_whitepaper_semantic_indexing"],
            "expected_heads": ["0017_whitepaper_semantic_indexing"],
            "schema_head_signature": "sig-override",
            "schema_graph_signature": "graph-override",
            "schema_graph_roots": ["0001_initial_torghut_schema"],
            "schema_graph_branch_count": 2,
            "schema_graph_branch_tolerance": 1,
            "schema_graph_allow_divergence_roots": True,
            "schema_graph_parent_forks": {
                "0015_whitepaper_workflow_tables": [
                    "0016_llm_dspy_workflow_artifacts",
                    "0017_whitepaper_semantic_indexing",
                ]
            },
            "schema_graph_duplicate_revisions": {},
            "schema_graph_orphan_parents": [],
            "schema_graph_lineage_ready": True,
            "schema_graph_lineage_errors": [],
            "schema_graph_lineage_warnings": [
                "migration graph branch count 2 exceeds tolerance 1; allowed by "
                "TRADING_DB_SCHEMA_GRAPH_ALLOW_DIVERGENCE_ROOTS=true"
            ],
            "checked_at": "2026-03-06T00:00:00+00:00",
            "account_scope_ready": True,
            "account_scope_errors": [],
            "account_scope_warnings": [],
        },
    )
    @patch("app.main._check_postgres", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    def test_readyz_returns_200_with_schema_lineage_warning_override(
        self,
        _mock_alpaca: object,
        _mock_clickhouse: object,
        _mock_postgres: object,
        _mock_contract: object,
    ) -> None:
        original = settings.trading_enabled
        original_mode = settings.trading_mode
        original_source = settings.trading_universe_source
        settings.trading_enabled = True
        settings.trading_mode = "paper"
        settings.trading_universe_source = "jangar"
        try:
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            scheduler.state.universe_source_status = "ok"
            scheduler.state.universe_source_reason = "jangar_fetch_ok"
            scheduler.state.universe_symbols_count = 2
            scheduler.state.universe_cache_age_seconds = 0
            app.state.trading_scheduler = scheduler
            response = self.client.get("/readyz")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertEqual(payload["status"], "ok")
            self.assertTrue(payload["dependencies"]["database"]["ok"])
            self.assertTrue(
                payload["dependencies"]["database"]["schema_graph_lineage_ready"]
            )
            self.assertEqual(
                payload["dependencies"]["database"]["schema_graph_lineage_warnings"],
                [
                    "migration graph branch count 2 exceeds tolerance 1; allowed by "
                    "TRADING_DB_SCHEMA_GRAPH_ALLOW_DIVERGENCE_ROOTS=true"
                ],
            )
            self.assertEqual(payload["dependencies"]["database"]["detail"], "ok")
        finally:
            settings.trading_enabled = original
            settings.trading_mode = original_mode
            settings.trading_universe_source = original_source

    @patch(
        "app.main._evaluate_database_contract",
        return_value={
            "ok": True,
            "schema_current": True,
            "schema_current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
            "checked_at": "2026-03-04T00:00:00+00:00",
            "account_scope_ready": True,
            "account_scope_errors": [],
        },
    )
    @patch("app.main._check_postgres", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    def test_readyz_reuses_stale_dependency_cache_within_stale_tolerance(
        self,
        _mock_alpaca: object,
        _mock_clickhouse: object,
        _mock_postgres: object,
        _mock_contract: object,
    ) -> None:
        original = settings.trading_enabled
        original_mode = settings.trading_mode
        original_cache_enabled = settings.trading_readiness_dependency_cache_enabled
        original_cache_ttl = settings.trading_readiness_dependency_cache_ttl_seconds
        original_stale_tolerance = (
            settings.trading_readiness_dependency_cache_stale_tolerance_seconds
        )
        settings.trading_enabled = True
        settings.trading_mode = "paper"
        settings.trading_readiness_dependency_cache_enabled = True
        settings.trading_readiness_dependency_cache_ttl_seconds = 8
        settings.trading_readiness_dependency_cache_stale_tolerance_seconds = 20
        try:
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            _mark_static_universe_loaded(scheduler)
            app.state.trading_scheduler = scheduler
            response = self.client.get("/readyz")
            self.assertEqual(response.status_code, 200)
            cache_key = _readiness_dependency_cache_key(include_database_contract=True)
            _TRADING_DEPENDENCY_HEALTH_CACHE[cache_key]["checked_at"] = datetime.now(
                timezone.utc
            ) - timedelta(seconds=22)
            response = self.client.get("/readyz")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(_mock_postgres.call_count, 1)
            self.assertEqual(_mock_clickhouse.call_count, 1)
            self.assertEqual(_mock_alpaca.call_count, 1)
            payload = response.json()
            cache = payload["dependencies"]["readiness_cache"]
            self.assertTrue(cache["cache_used"])
            self.assertTrue(cache["cache_stale"])
            self.assertGreater(cache["cache_age_seconds"], 8)
            self.assertLessEqual(cache["cache_age_seconds"], 28)
        finally:
            settings.trading_enabled = original
            settings.trading_mode = original_mode
            settings.trading_readiness_dependency_cache_enabled = original_cache_enabled
            settings.trading_readiness_dependency_cache_ttl_seconds = original_cache_ttl
            settings.trading_readiness_dependency_cache_stale_tolerance_seconds = (
                original_stale_tolerance
            )
            _TRADING_DEPENDENCY_HEALTH_CACHE.clear()

    @patch(
        "app.main._evaluate_database_contract",
        return_value={
            "ok": True,
            "schema_current": True,
            "schema_current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
            "checked_at": "2026-03-04T00:00:00+00:00",
            "account_scope_ready": True,
            "account_scope_errors": [],
        },
    )
    @patch("app.main._check_postgres", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    def test_trading_health_refreshes_stale_readiness_cache_without_tolerance(
        self,
        _mock_alpaca: object,
        _mock_clickhouse: object,
        _mock_postgres: object,
        _mock_contract: object,
    ) -> None:
        original = settings.trading_enabled
        original_mode = settings.trading_mode
        original_cache_enabled = settings.trading_readiness_dependency_cache_enabled
        original_cache_ttl = settings.trading_readiness_dependency_cache_ttl_seconds
        original_stale_tolerance = (
            settings.trading_readiness_dependency_cache_stale_tolerance_seconds
        )
        original_source = settings.trading_universe_source
        settings.trading_enabled = True
        settings.trading_mode = "paper"
        settings.trading_readiness_dependency_cache_enabled = True
        settings.trading_readiness_dependency_cache_ttl_seconds = 8
        settings.trading_readiness_dependency_cache_stale_tolerance_seconds = 20
        settings.trading_universe_source = "jangar"
        try:
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            scheduler.state.universe_source_status = "ok"
            scheduler.state.universe_source_reason = "jangar_fetch_ok"
            scheduler.state.universe_symbols_count = 2
            scheduler.state.universe_cache_age_seconds = 0
            app.state.trading_scheduler = scheduler
            response = self.client.get("/trading/health")
            self.assertEqual(response.status_code, 200)
            cache_key = _readiness_dependency_cache_key(include_database_contract=False)
            _TRADING_DEPENDENCY_HEALTH_CACHE[cache_key]["checked_at"] = datetime.now(
                timezone.utc
            ) - timedelta(seconds=30)
            response = self.client.get("/trading/health")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(_mock_postgres.call_count, 2)
            self.assertEqual(_mock_clickhouse.call_count, 2)
            self.assertEqual(_mock_alpaca.call_count, 2)
            payload = response.json()
            self.assertFalse(payload["dependencies"]["readiness_cache"]["cache_stale"])
        finally:
            settings.trading_enabled = original
            settings.trading_mode = original_mode
            settings.trading_readiness_dependency_cache_enabled = original_cache_enabled
            settings.trading_readiness_dependency_cache_ttl_seconds = original_cache_ttl
            settings.trading_readiness_dependency_cache_stale_tolerance_seconds = (
                original_stale_tolerance
            )
            settings.trading_universe_source = original_source
            _TRADING_DEPENDENCY_HEALTH_CACHE.clear()

    @patch(
        "app.main._evaluate_database_contract",
        return_value={
            "ok": True,
            "schema_current": True,
            "schema_current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
            "checked_at": "2026-03-04T00:00:00+00:00",
            "account_scope_ready": True,
            "account_scope_errors": [],
        },
    )
    @patch("app.main._check_postgres", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    def test_readyz_allows_startup_grace_window(
        self,
        _mock_alpaca: object,
        _mock_clickhouse: object,
        _mock_postgres: object,
        _mock_contract: object,
    ) -> None:
        original = settings.trading_enabled
        original_source = settings.trading_universe_source
        original_grace = settings.trading_startup_readiness_grace_seconds
        settings.trading_enabled = True
        settings.trading_universe_source = "jangar"
        settings.trading_startup_readiness_grace_seconds = 45
        try:
            scheduler = TradingScheduler()
            scheduler.state.running = False
            scheduler.state.startup_started_at = datetime.now(timezone.utc)
            scheduler.state.universe_source_status = "ok"
            scheduler.state.universe_source_reason = "jangar_fetch_ok"
            scheduler.state.universe_symbols_count = 2
            scheduler.state.universe_cache_age_seconds = 0
            app.state.trading_scheduler = scheduler
            response = self.client.get("/readyz")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertEqual(payload["status"], "ok")
            self.assertTrue(payload["scheduler"]["ok"])
            self.assertIn("readiness grace", payload["scheduler"]["detail"])
            self.assertTrue(payload["scheduler"]["startup_readiness_grace_active"])
        finally:
            settings.trading_enabled = original
            settings.trading_universe_source = original_source
            settings.trading_startup_readiness_grace_seconds = original_grace
            _TRADING_DEPENDENCY_HEALTH_CACHE.clear()

    @patch(
        "app.main._evaluate_database_contract",
        return_value={
            "ok": True,
            "schema_current": True,
            "schema_current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
            "checked_at": "2026-03-04T00:00:00+00:00",
            "account_scope_ready": True,
            "account_scope_errors": [],
        },
    )
    @patch("app.main._check_postgres", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    def test_readyz_rejects_after_startup_grace_expires(
        self,
        _mock_alpaca: object,
        _mock_clickhouse: object,
        _mock_postgres: object,
        _mock_contract: object,
    ) -> None:
        original = settings.trading_enabled
        original_source = settings.trading_universe_source
        original_grace = settings.trading_startup_readiness_grace_seconds
        settings.trading_enabled = True
        settings.trading_universe_source = "jangar"
        settings.trading_startup_readiness_grace_seconds = 30
        try:
            scheduler = TradingScheduler()
            scheduler.state.running = False
            scheduler.state.startup_started_at = datetime.now(timezone.utc) - timedelta(
                seconds=61
            )
            app.state.trading_scheduler = scheduler
            response = self.client.get("/readyz")
            self.assertEqual(response.status_code, 503)
            payload = response.json()
            self.assertEqual(payload["status"], "degraded")
            self.assertFalse(payload["scheduler"]["ok"])
            self.assertIn("trading loop", payload["scheduler"]["detail"])
            self.assertFalse(payload["scheduler"]["startup_readiness_grace_active"])
        finally:
            settings.trading_enabled = original
            settings.trading_universe_source = original_source
            settings.trading_startup_readiness_grace_seconds = original_grace
            _TRADING_DEPENDENCY_HEALTH_CACHE.clear()

    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_postgres", return_value={"ok": False, "detail": "down"})
    @patch(
        "app.main.check_account_scope_invariants",
        return_value={"account_scope_ready": True, "account_scope_errors": []},
    )
    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
        },
    )
    def test_readyz_returns_503_when_dependency_degraded(
        self,
        _mock_schema: object,
        _mock_account_scope: object,
        _mock_postgres: object,
        _mock_alpaca: object,
    ) -> None:
        original = settings.trading_enabled
        original_source = settings.trading_universe_source
        original_require_non_empty = settings.trading_universe_require_non_empty_jangar
        settings.trading_enabled = True
        settings.trading_universe_source = "jangar"
        settings.trading_universe_require_non_empty_jangar = True
        try:
            scheduler = TradingScheduler()
            _install_pipeline_universe_resolver(
                scheduler,
                SimpleNamespace(
                    get_resolution=lambda: SimpleNamespace(
                        symbols={"AMD", "NVDA"},
                        status="ok",
                        reason="jangar_fetch_ok",
                        cache_age_seconds=0,
                    ),
                ),
            )
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            app.state.trading_scheduler = scheduler
            response = self.client.get("/readyz")
            self.assertEqual(response.status_code, 503)
            payload = response.json()
            self.assertEqual(payload["status"], "degraded")
            self.assertFalse(payload["dependencies"]["postgres"]["ok"])
            self.assertEqual(payload["dependencies"]["postgres"]["detail"], "down")
            self.assertIn("database", payload["dependencies"])
            self.assertIn("checked_at", payload["dependencies"]["database"])
            self.assertIn("universe", payload["dependencies"])
            self.assertTrue(payload["dependencies"]["universe"]["ok"])
            self.assertEqual(payload["dependencies"]["universe"]["symbols_count"], 2)
        finally:
            settings.trading_enabled = original
            settings.trading_universe_source = original_source
            settings.trading_universe_require_non_empty_jangar = (
                original_require_non_empty
            )

    @patch(
        "app.main.check_account_scope_invariants",
        return_value={"account_scope_ready": True, "account_scope_errors": []},
    )
    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": False,
            "current_heads": ["0010_execution_provenance_and_governance_trace"],
            "expected_heads": ["0011_autonomy_lifecycle_and_promotion_audit"],
            "schema_head_signature": "7f8e4d0",
            "schema_missing_heads": ["0011_autonomy_lifecycle_and_promotion_audit"],
            "schema_unexpected_heads": [
                "0010_execution_provenance_and_governance_trace"
            ],
            "schema_head_count_expected": 1,
            "schema_head_count_current": 1,
            "schema_head_delta_count": 2,
        },
    )
    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_postgres", return_value={"ok": True, "detail": "ok"})
    def test_readyz_returns_503_when_schema_contract_fails(
        self,
        _mock_postgres: object,
        _mock_clickhouse: object,
        _mock_alpaca: object,
        _mock_schema: object,
        _mock_account_scope: object,
    ) -> None:
        original = settings.trading_enabled
        settings.trading_enabled = True
        try:
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            app.state.trading_scheduler = scheduler
            response = self.client.get("/readyz")
            self.assertEqual(response.status_code, 503)
            payload = response.json()
            self.assertEqual(payload["status"], "degraded")
            self.assertFalse(payload["dependencies"]["database"]["ok"])
            self.assertFalse(payload["dependencies"]["database"]["schema_current"])
            self.assertEqual(
                payload["dependencies"]["database"]["account_scope_errors"], []
            )
            self.assertEqual(
                payload["dependencies"]["database"]["schema_missing_heads"],
                ["0011_autonomy_lifecycle_and_promotion_audit"],
            )
            self.assertEqual(
                payload["dependencies"]["database"]["schema_unexpected_heads"],
                ["0010_execution_provenance_and_governance_trace"],
            )
            self.assertEqual(
                payload["dependencies"]["database"]["schema_head_count_expected"], 1
            )
            self.assertEqual(
                payload["dependencies"]["database"]["schema_head_count_current"], 1
            )
            self.assertEqual(
                payload["dependencies"]["database"]["schema_head_delta_count"], 2
            )
            self.assertEqual(
                payload["dependencies"]["database"]["schema_head_signature"], "7f8e4d0"
            )
            self.assertIn("checked_at", payload["dependencies"]["database"])
        finally:
            settings.trading_enabled = original

    @patch("app.main._evaluate_database_contract")
    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_postgres", return_value={"ok": True, "detail": "ok"})
    def test_readyz_surface_schema_head_drift_fields(
        self,
        _mock_postgres: object,
        _mock_clickhouse: object,
        _mock_alpaca: object,
        _mock_contract: object,
    ) -> None:
        original = settings.trading_enabled
        settings.trading_enabled = True
        try:
            app.state.trading_scheduler = TradingScheduler()
            app.state.trading_scheduler.state.running = True
            app.state.trading_scheduler.state.last_run_at = datetime.now(timezone.utc)
            _mock_contract.return_value = {
                "ok": False,
                "schema_current": False,
                "schema_current_heads": ["0012_demo_beta"],
                "expected_heads": ["0011_demo_alpha"],
                "schema_missing_heads": ["0011_demo_alpha"],
                "schema_unexpected_heads": ["0012_demo_beta"],
                "schema_head_count_expected": 1,
                "schema_head_count_current": 1,
                "schema_head_delta_count": 2,
                "schema_head_signature": "sig-20260304",
                "checked_at": "2026-03-04T00:00:00+00:00",
                "account_scope_ready": True,
                "account_scope_errors": [],
                "account_scope_warnings": [],
            }
            response = self.client.get("/readyz")

            self.assertEqual(response.status_code, 503)
            payload = response.json()
            self.assertEqual(payload["status"], "degraded")
            self.assertFalse(payload["dependencies"]["database"]["ok"])
            self.assertEqual(
                payload["dependencies"]["database"]["schema_missing_heads"],
                ["0011_demo_alpha"],
            )
            self.assertEqual(
                payload["dependencies"]["database"]["schema_unexpected_heads"],
                ["0012_demo_beta"],
            )
            self.assertEqual(
                payload["dependencies"]["database"]["schema_head_count_expected"],
                1,
            )
            self.assertEqual(
                payload["dependencies"]["database"]["schema_head_count_current"],
                1,
            )
            self.assertEqual(
                payload["dependencies"]["database"]["schema_head_delta_count"], 2
            )
        finally:
            settings.trading_enabled = original

    @patch(
        "app.main.check_account_scope_invariants",
        return_value={
            "account_scope_ready": False,
            "account_scope_errors": ["legacy unique index detected"],
        },
    )
    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
        },
    )
    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_postgres", return_value={"ok": True, "detail": "ok"})
    def test_readyz_returns_503_when_account_scope_contract_fails(
        self,
        _mock_postgres: object,
        _mock_clickhouse: object,
        _mock_alpaca: object,
        _mock_schema: object,
        _mock_account_scope: object,
    ) -> None:
        original = settings.trading_enabled
        original_multi = settings.trading_multi_account_enabled
        settings.trading_enabled = True
        settings.trading_multi_account_enabled = True
        try:
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            app.state.trading_scheduler = scheduler
            response = self.client.get("/readyz")
            self.assertEqual(response.status_code, 503)
            payload = response.json()
            self.assertEqual(payload["status"], "degraded")
            self.assertFalse(payload["dependencies"]["database"]["ok"])
            self.assertEqual(
                payload["dependencies"]["database"]["schema_current"], True
            )
            self.assertFalse(payload["dependencies"]["database"]["account_scope_ready"])
            self.assertIn(
                "legacy unique index detected",
                payload["dependencies"]["database"]["account_scope_errors"][0],
            )
            self.assertEqual(
                payload["dependencies"]["database"]["schema_head_signature"], "7f8e4d0"
            )
            self.assertIn("checked_at", payload["dependencies"]["database"])
        finally:
            settings.trading_enabled = original
            settings.trading_multi_account_enabled = original_multi

    def test_trading_status_includes_llm_evaluation(self) -> None:
        with patch("app.main.SessionLocal", self.session_local):
            response = self.client.get("/trading/status")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIn("hypotheses", payload)
        self.assertIn("llm_evaluation", payload)
        self.assertIn("control_plane_contract", payload)
        self.assertIn("build", payload)
        self.assertIn("shadow_first", payload)
        self.assertIn("forecast_service", payload)
        self.assertIn("lean_authority", payload)
        self.assertIn("empirical_jobs", payload)
        self.assertIn("profit_lease_projection", payload)
        self.assertIn("renewal_bond_profit_escrow", payload)
        self.assertEqual(
            payload["profit_lease_projection"]["schema_version"],
            "torghut.profit-lease-provenance.v1",
        )
        self.assertEqual(
            payload["renewal_bond_profit_escrow"]["schema_version"],
            "torghut.renewal-bond-profit-escrow.v1",
        )
        self.assertEqual(
            payload["profit_lease_projection"]["jangar_consumer"]["action_class"],
            "torghut_capital",
        )
        evaluation = payload["llm_evaluation"]
        self.assertTrue(evaluation["ok"])
        self.assertGreaterEqual(evaluation["metrics"]["total_reviews"], 1)
        hypotheses = payload["hypotheses"]
        self.assertTrue(hypotheses["registry_loaded"])
        self.assertEqual(len(hypotheses["items"]), 3)
        self.assertEqual(hypotheses["dependency_quorum"]["decision"], "allow")
        self.assertEqual(
            hypotheses["dependency_quorum"]["reasons"],
            ["jangar_dependency_quorum_not_required"],
        )
        control_plane_contract = payload["control_plane_contract"]
        self.assertEqual(
            control_plane_contract["contract_version"], "torghut.quant-producer.v1"
        )
        self.assertIn("signal_lag_seconds", control_plane_contract)
        self.assertIn("signal_continuity_state", control_plane_contract)
        self.assertIn("signal_continuity_alert_active", control_plane_contract)
        self.assertIn("signal_continuity_promotion_block_total", control_plane_contract)
        self.assertIn("signal_expected_staleness_total", control_plane_contract)
        self.assertIn("submission_block_total", control_plane_contract)
        self.assertIn("decision_state_total", control_plane_contract)
        self.assertIn("planned_decision_age_seconds", control_plane_contract)
        self.assertIn("market_session_open", control_plane_contract)
        self.assertIn("universe_fail_safe_blocked", control_plane_contract)
        self.assertIn("domain_telemetry_event_total", control_plane_contract)
        self.assertIn("domain_telemetry_dropped_total", control_plane_contract)
        self.assertEqual(control_plane_contract["alpha_readiness_hypotheses_total"], 3)
        self.assertEqual(control_plane_contract["alpha_readiness_blocked_total"], 1)
        self.assertEqual(control_plane_contract["alpha_readiness_shadow_total"], 2)
        self.assertIn(control_plane_contract["active_capital_stage"], {"shadow", None})
        self.assertIn("critical_toggle_parity", control_plane_contract)
        self.assertIn(
            payload["shadow_first"]["critical_toggle_parity"]["status"],
            {"aligned", "diverged"},
        )
        self.assertEqual(
            payload["build"]["active_revision"],
            control_plane_contract["active_revision"],
        )
        self.assertEqual(
            control_plane_contract["alpha_readiness_dependency_quorum_decision"],
            "allow",
        )
        self.assertIn(
            payload["forecast_service"]["authority"], {"empirical", "blocked"}
        )
        self.assertIn(payload["lean_authority"]["authority"], {"empirical", "blocked"})
        self.assertIn(payload["empirical_jobs"]["authority"], {"empirical", "blocked"})

    def test_trading_status_blocks_live_submission_on_critical_toggle_parity_divergence(
        self,
    ) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        original = {
            "trading_enabled": settings.trading_enabled,
            "trading_mode": settings.trading_mode,
            "trading_autonomy_enabled": settings.trading_autonomy_enabled,
            "trading_autonomy_allow_live_promotion": settings.trading_autonomy_allow_live_promotion,
            "trading_kill_switch_enabled": settings.trading_kill_switch_enabled,
        }
        try:
            settings.trading_enabled = True
            settings.trading_mode = "live"
            settings.trading_autonomy_enabled = False
            settings.trading_autonomy_allow_live_promotion = False
            settings.trading_kill_switch_enabled = True

            scheduler = TradingScheduler()
            app.state.trading_scheduler = scheduler

            hypothesis_summary = {
                "promotion_eligible_total": 1,
                "capital_stage_totals": {"shadow": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            }
            dependency_quorum = SimpleNamespace(
                decision="allow",
                as_payload=lambda: {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            )

            with (
                patch(
                    "app.main._build_hypothesis_runtime_payload",
                    return_value=(
                        {
                            "registry_loaded": True,
                            "registry_path": "test",
                            "registry_errors": [],
                            "dependency_quorum": hypothesis_summary[
                                "dependency_quorum"
                            ],
                            "summary": hypothesis_summary,
                            "items": [],
                        },
                        hypothesis_summary,
                        dependency_quorum,
                    ),
                ),
                patch(
                    "app.main._empirical_jobs_status",
                    return_value={"ready": True, "status": "healthy"},
                ),
            ):
                response = self.client.get("/trading/status")

            self.assertEqual(response.status_code, 200)
            payload = response.json()
            gate = payload["live_submission_gate"]
            self.assertFalse(gate["allowed"])
            self.assertEqual(gate["reason"], "critical_toggle_parity_diverged")
            self.assertIn(
                "critical_toggle_parity_diverged",
                gate["blocked_reasons"],
            )
            self.assertEqual(gate["critical_toggle_parity"]["status"], "diverged")
        finally:
            settings.trading_enabled = original["trading_enabled"]
            settings.trading_mode = original["trading_mode"]
            settings.trading_autonomy_enabled = original["trading_autonomy_enabled"]
            settings.trading_autonomy_allow_live_promotion = original[
                "trading_autonomy_allow_live_promotion"
            ]
            settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            if original_scheduler is None:
                if hasattr(app.state, "trading_scheduler"):
                    del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_trading_status_blocks_live_submission_when_quant_latest_store_is_empty(
        self,
    ) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        original = {
            "trading_enabled": settings.trading_enabled,
            "trading_mode": settings.trading_mode,
            "trading_autonomy_enabled": settings.trading_autonomy_enabled,
            "trading_autonomy_allow_live_promotion": settings.trading_autonomy_allow_live_promotion,
            "trading_kill_switch_enabled": settings.trading_kill_switch_enabled,
        }
        try:
            settings.trading_enabled = True
            settings.trading_mode = "live"
            settings.trading_autonomy_enabled = False
            settings.trading_autonomy_allow_live_promotion = True
            settings.trading_kill_switch_enabled = False

            scheduler = TradingScheduler()
            app.state.trading_scheduler = scheduler

            hypothesis_summary = {
                "promotion_eligible_total": 1,
                "capital_stage_totals": {"shadow": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            }
            dependency_quorum = SimpleNamespace(
                decision="allow",
                as_payload=lambda: {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            )

            with (
                patch(
                    "app.main._build_hypothesis_runtime_payload",
                    return_value=(
                        {
                            "registry_loaded": True,
                            "registry_path": "test",
                            "registry_errors": [],
                            "dependency_quorum": hypothesis_summary[
                                "dependency_quorum"
                            ],
                            "summary": hypothesis_summary,
                            "items": [],
                        },
                        hypothesis_summary,
                        dependency_quorum,
                    ),
                ),
                patch(
                    "app.main._empirical_jobs_status",
                    return_value={"ready": True, "status": "healthy"},
                ),
                patch(
                    "app.main.load_quant_evidence_status",
                    return_value={
                        "required": True,
                        "ok": False,
                        "status": "degraded",
                        "reason": "quant_latest_metrics_empty",
                        "blocking_reasons": [
                            "quant_latest_metrics_empty",
                            "quant_latest_store_alarm",
                        ],
                        "account": "paper",
                        "window": "15m",
                        "source_url": "http://jangar.test/api/torghut/trading/control-plane/quant/health?account=paper&window=15m",
                        "latest_metrics_count": 0,
                        "latest_metrics_updated_at": None,
                        "empty_latest_store_alarm": True,
                        "missing_update_alarm": False,
                        "metrics_pipeline_lag_seconds": None,
                        "stage_count": 0,
                        "max_stage_lag_seconds": 0,
                        "stages": [],
                    },
                ),
            ):
                response = self.client.get("/trading/status")

            self.assertEqual(response.status_code, 200)
            payload = response.json()
            gate = payload["live_submission_gate"]
            self.assertFalse(gate["allowed"])
            self.assertEqual(gate["reason"], "quant_latest_metrics_empty")
            self.assertEqual(gate["capital_state"], "observe")
            self.assertIn("quant_latest_store_alarm", gate["blocked_reasons"])
            self.assertEqual(payload["quant_evidence"]["window"], "15m")
            self.assertFalse(payload["quant_evidence"]["ok"])
        finally:
            settings.trading_enabled = original["trading_enabled"]
            settings.trading_mode = original["trading_mode"]
            settings.trading_autonomy_enabled = original["trading_autonomy_enabled"]
            settings.trading_autonomy_allow_live_promotion = original[
                "trading_autonomy_allow_live_promotion"
            ]
            settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            if original_scheduler is None:
                if hasattr(app.state, "trading_scheduler"):
                    del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_live_submission_gate_matches_status_health_and_readyz(self) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        original_mode = settings.trading_mode
        original_enabled = settings.trading_enabled
        try:
            settings.trading_enabled = True
            settings.trading_mode = "live"
            scheduler = TradingScheduler()
            app.state.trading_scheduler = scheduler
            shared_gate = {
                "allowed": False,
                "reason": "promotion_certificate_missing",
                "blocked_reasons": [
                    "promotion_certificate_missing",
                    "hypothesis_window_evidence_missing",
                ],
                "certificate_id": None,
                "capital_stage": "shadow",
                "capital_state": "observe",
                "issued_at": None,
                "expires_at": None,
                "reason_codes": [
                    "promotion_certificate_missing",
                    "hypothesis_window_evidence_missing",
                ],
                "segment_summary": {
                    "segments": {
                        "execution": {"state": "ok", "reason_codes": []},
                        "empirical": {"state": "ok", "reason_codes": []},
                        "llm-review": {"state": "ok", "reason_codes": []},
                        "market-context": {"state": "ok", "reason_codes": []},
                        "ta-core": {"state": "ok", "reason_codes": []},
                    },
                    "evaluated_hypotheses": [],
                },
                "quant_health_ref": {
                    "account": "paper",
                    "window": "15m",
                    "status": "healthy",
                    "source_url": "http://jangar.test/quant/health",
                    "latest_metrics_updated_at": "2026-03-20T10:00:00Z",
                },
                "market_context_ref": {"last_freshness_seconds": 30},
                "evidence_tuple": {
                    "hypothesis_id": None,
                    "candidate_id": None,
                    "strategy_id": None,
                    "account": "paper",
                    "window": "15m",
                    "capital_state": "observe",
                },
                "lineage_ref": {
                    "status": "unverified",
                    "candidate_id": None,
                    "hypothesis_id": None,
                    "dataset_snapshot_count": 0,
                    "dataset_snapshot_id": None,
                    "dataset_snapshot_ref": None,
                    "dataset_snapshot_run_id": None,
                    "strategy_hypothesis_count": 0,
                    "strategy_hypothesis_id": None,
                    "lane_id": None,
                    "strategy_family": None,
                },
                "evaluated_tuples": [],
            }

            with (
                patch(
                    "app.main._build_hypothesis_runtime_payload",
                    return_value=(
                        {
                            "registry_loaded": True,
                            "registry_path": "test",
                            "registry_errors": [],
                            "dependency_quorum": {
                                "decision": "allow",
                                "reasons": [],
                                "message": "ready",
                            },
                            "summary": {
                                "promotion_eligible_total": 1,
                                "capital_stage_totals": {"shadow": 1},
                                "dependency_quorum": {
                                    "decision": "allow",
                                    "reasons": [],
                                    "message": "ready",
                                },
                            },
                            "items": [],
                        },
                        {
                            "promotion_eligible_total": 1,
                            "capital_stage_totals": {"shadow": 1},
                            "dependency_quorum": {
                                "decision": "allow",
                                "reasons": [],
                                "message": "ready",
                            },
                        },
                        SimpleNamespace(
                            decision="allow",
                            as_payload=lambda: {
                                "decision": "allow",
                                "reasons": [],
                                "message": "ready",
                            },
                        ),
                    ),
                ),
                patch(
                    "app.main._empirical_jobs_status",
                    return_value={"ready": True, "status": "healthy"},
                ),
                patch(
                    "app.main.load_quant_evidence_status",
                    return_value={
                        "required": True,
                        "ok": True,
                        "status": "healthy",
                        "reason": "ready",
                        "blocking_reasons": [],
                        "account": "paper",
                        "window": "15m",
                        "source_url": "http://jangar.test/quant/health",
                        "latest_metrics_updated_at": "2026-03-20T10:00:00Z",
                    },
                ),
                patch(
                    "app.main._build_live_submission_gate_payload",
                    return_value=shared_gate,
                ),
            ):
                status_response = self.client.get("/trading/status")
                health_response = self.client.get("/trading/health")
                ready_response = self.client.get("/readyz")
                runtime_response = self.client.get("/trading/profitability/runtime")

            self.assertEqual(status_response.status_code, 200)
            self.assertEqual(health_response.status_code, 503)
            self.assertEqual(ready_response.status_code, 503)
            self.assertEqual(runtime_response.status_code, 200)
            self.assertEqual(
                status_response.json()["live_submission_gate"], shared_gate
            )
            self.assertEqual(
                health_response.json()["live_submission_gate"], shared_gate
            )
            self.assertEqual(ready_response.json()["live_submission_gate"], shared_gate)
            self.assertEqual(
                runtime_response.json()["live_submission_gate"],
                shared_gate,
            )
        finally:
            settings.trading_mode = original_mode
            settings.trading_enabled = original_enabled
            if original_scheduler is None:
                if hasattr(app.state, "trading_scheduler"):
                    del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_trading_revenue_repair_endpoint_returns_business_digest(self) -> None:
        readyz_payload: dict[str, object] = {
            "status": "degraded",
            "dependencies": {
                "profitability_proof_floor": {
                    "ok": False,
                    "detail": "repair_only",
                    "capital_state": "zero_notional",
                },
                "live_submission_gate": {
                    "ok": False,
                    "detail": "simple_submit_disabled",
                    "capital_stage": "shadow",
                },
            },
        }
        status_payload: dict[str, object] = {
            "mode": "live",
            "pipeline_mode": "simple",
            "build": {"active_revision": "torghut-00254"},
            "live_submission_gate": {
                "allowed": False,
                "reason": "simple_submit_disabled",
                "blocked_reasons": ["simple_submit_disabled"],
                "capital_stage": "shadow",
                "configured_live_promotion": False,
            },
            "proof_floor": {
                "route_state": "repair_only",
                "capital_state": "zero_notional",
                "max_notional": "0",
                "blocking_reasons": [
                    "alpha_readiness_not_promotion_eligible",
                    "execution_tca_stale",
                    "simple_submit_disabled",
                ],
                "repair_ladder": [
                    {
                        "code": "repair_execution_tca",
                        "reason": "execution_tca_stale",
                        "dimension": "execution_tca",
                        "priority": 65,
                        "expected_unblock_value": 3,
                    }
                ],
                "proof_dimensions": [
                    {
                        "dimension": "execution_tca",
                        "state": "stale",
                        "reason": "execution_tca_stale",
                        "freshness_seconds": 2_988_327,
                        "threshold_seconds": 86_400,
                        "source_ref": {
                            "order_count": 13_775,
                            "last_computed_at": "2026-04-02T20:59:45.136640+00:00",
                            "avg_abs_slippage_bps": "568.6138848199565249",
                        },
                    }
                ],
            },
            "alpha_readiness": {
                "summary": {
                    "promotion_eligible_total": 0,
                    "rollback_required_total": 3,
                    "state_totals": {"blocked": 1, "shadow": 2},
                }
            },
            "quant_evidence": {"ok": True, "status": "healthy", "reason": "ready"},
        }
        with (
            patch(
                "app.main._evaluate_trading_health_payload",
                return_value=(readyz_payload, 503),
            ),
            patch("app.main.trading_status", return_value=status_payload),
        ):
            response = self.client.get("/trading/revenue-repair")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["schema_version"], "torghut.revenue-repair-digest.v1")
        self.assertFalse(payload["revenue_ready"])
        self.assertEqual(payload["business_state"], "repair_only")
        self.assertEqual(payload["capital"]["capital_state"], "zero_notional")
        self.assertIn(
            "execution_tca_stale",
            {item["reason"] for item in payload["blockers"]},
        )
        self.assertEqual(payload["repair_queue"][0]["code"], "repair_alpha_readiness")
        self.assertEqual(
            payload["evidence"]["execution_tca"]["last_computed_at"],
            "2026-04-02T20:59:45.136640+00:00",
        )

    def test_trading_status_blocks_live_submission_when_lineage_tables_are_empty(
        self,
    ) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        original = {
            "trading_enabled": settings.trading_enabled,
            "trading_mode": settings.trading_mode,
            "trading_autonomy_enabled": settings.trading_autonomy_enabled,
            "trading_autonomy_allow_live_promotion": settings.trading_autonomy_allow_live_promotion,
            "trading_kill_switch_enabled": settings.trading_kill_switch_enabled,
        }
        try:
            settings.trading_enabled = True
            settings.trading_mode = "live"
            settings.trading_autonomy_enabled = False
            settings.trading_autonomy_allow_live_promotion = False
            settings.trading_kill_switch_enabled = False

            scheduler = TradingScheduler()
            scheduler.state.last_market_context_freshness_seconds = 30
            app.state.trading_scheduler = scheduler

            with self.session_local() as session:
                observed_at = datetime.now(timezone.utc)
                session.add(
                    StrategyHypothesisMetricWindow(
                        run_id="run-1",
                        candidate_id="cand-1",
                        hypothesis_id="H-CONT-01",
                        observed_stage="live",
                        window_started_at=observed_at - timedelta(minutes=15),
                        window_ended_at=observed_at,
                        market_session_count=1,
                        decision_count=1,
                        trade_count=1,
                        order_count=1,
                        continuity_ok=True,
                        drift_ok=True,
                        dependency_quorum_decision="allow",
                        capital_stage="0.10x canary",
                    )
                )
                session.add(
                    StrategyPromotionDecision(
                        run_id="run-1",
                        candidate_id="cand-1",
                        hypothesis_id="H-CONT-01",
                        promotion_target="live",
                        state="0.10x canary",
                        allowed=True,
                        reason_summary="ready",
                    )
                )
                session.commit()

            registry_item = SimpleNamespace(
                hypothesis_id="H-CONT-01",
                model_dump=lambda mode="json": {
                    "hypothesis_id": "H-CONT-01",
                    "lane_id": "lane-cand-1",
                    "strategy_family": "demo",
                    "segment_dependencies": [],
                },
            )

            with (
                patch(
                    "app.main._build_hypothesis_runtime_payload",
                    return_value=(
                        {
                            "summary": {
                                "promotion_eligible_total": 1,
                                "capital_stage_totals": {"0.10x canary": 1},
                                "dependency_quorum": {
                                    "decision": "allow",
                                    "reasons": [],
                                    "message": "ready",
                                },
                            },
                            "items": [
                                {
                                    "hypothesis_id": "H-CONT-01",
                                    "promotion_eligible": True,
                                    "capital_stage": "0.10x canary",
                                    "reasons": [],
                                    "segment_dependencies": [],
                                }
                            ],
                        },
                        {
                            "promotion_eligible_total": 1,
                            "capital_stage_totals": {"0.10x canary": 1},
                            "dependency_quorum": {
                                "decision": "allow",
                                "reasons": [],
                                "message": "ready",
                            },
                        },
                        SimpleNamespace(
                            decision="allow",
                            as_payload=lambda: {
                                "decision": "allow",
                                "reasons": [],
                                "message": "ready",
                            },
                        ),
                    ),
                ),
                patch(
                    "app.trading.submission_council.load_hypothesis_registry",
                    return_value=SimpleNamespace(items=[registry_item]),
                ),
                patch(
                    "app.main._empirical_jobs_status",
                    return_value={"ready": True, "status": "healthy"},
                ),
                patch(
                    "app.main.load_quant_evidence_status",
                    return_value={
                        "required": True,
                        "ok": True,
                        "status": "healthy",
                        "reason": "ready",
                        "blocking_reasons": [],
                        "account": "paper",
                        "window": "15m",
                        "source_url": "http://jangar.test/api/torghut/trading/control-plane/quant/health?account=paper&window=15m",
                    },
                ),
            ):
                response = self.client.get("/trading/status")

            self.assertEqual(response.status_code, 200)
            gate = response.json()["live_submission_gate"]
            self.assertFalse(gate["allowed"])
            self.assertEqual(gate["capital_state"], "observe")
            self.assertIn("dataset_snapshot_missing", gate["blocked_reasons"])
            self.assertIn("strategy_hypothesis_missing", gate["blocked_reasons"])
            self.assertEqual(gate["lineage_ref"]["status"], "missing")
            self.assertEqual(gate["lineage_ref"]["dataset_snapshot_count"], 0)
            self.assertEqual(gate["lineage_ref"]["strategy_hypothesis_count"], 0)
        finally:
            settings.trading_enabled = original["trading_enabled"]
            settings.trading_mode = original["trading_mode"]
            settings.trading_autonomy_enabled = original["trading_autonomy_enabled"]
            settings.trading_autonomy_allow_live_promotion = original[
                "trading_autonomy_allow_live_promotion"
            ]
            settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            if original_scheduler is None:
                if hasattr(app.state, "trading_scheduler"):
                    del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_trading_status_exposes_rejection_and_market_context_controls(self) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        try:
            scheduler = TradingScheduler()
            scheduler.state.metrics.llm_policy_veto_total = 3
            scheduler.state.metrics.llm_runtime_fallback_total = 5
            scheduler.state.metrics.llm_requests_total = 100
            scheduler.state.metrics.llm_market_context_block_total = 7
            scheduler.state.metrics.pre_llm_capacity_reject_total = 11
            scheduler.state.metrics.pre_llm_qty_below_min_total = 13
            scheduler.state.market_session_open = True
            scheduler.state.last_market_context_symbol = "AAPL"
            scheduler.state.last_market_context_checked_at = datetime(
                2026, 3, 5, 15, 30, tzinfo=timezone.utc
            )
            scheduler.state.last_market_context_freshness_seconds = 120
            scheduler.state.last_market_context_quality_score = 0.92
            scheduler.state.last_market_context_domain_states = {
                "technicals": "ok",
                "fundamentals": "stale",
                "news": "ok",
                "regime": "ok",
            }
            scheduler.state.last_market_context_risk_flags = ["fundamentals_stale"]
            scheduler.state.last_market_context_allow_llm = False
            scheduler.state.last_market_context_reason = "market_context_stale"
            scheduler.state.market_context_alert_active = True
            scheduler.state.market_context_alert_reason = "market_context_stale"
            executor = OrderExecutor()
            executor._shorting_metadata_status.update(  # noqa: SLF001
                {
                    "account_ready": False,
                    "last_refresh_at": "2026-03-05T15:30:00+00:00",
                    "last_error": "account lookup unavailable",
                }
            )
            scheduler._pipeline = type(  # noqa: SLF001
                "PipelineStub",
                (),
                {"executor": executor, "llm_review_engine": None},
            )()
            app.state.trading_scheduler = scheduler

            response = self.client.get("/trading/status")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertEqual(payload["market_context"]["fail_mode"], "shadow_only")
            self.assertFalse(payload["market_context"]["required"])
            self.assertEqual(payload["market_context"]["last_symbol"], "AAPL")
            self.assertEqual(
                payload["market_context"]["last_reason"], "market_context_stale"
            )
            self.assertTrue(payload["market_context"]["alert_active"])
            self.assertEqual(payload["rejections"]["policy_veto_total"], 3)
            self.assertEqual(payload["rejections"]["runtime_fallback_total"], 5)
            self.assertAlmostEqual(
                payload["rejections"]["runtime_fallback_ratio"], 0.05
            )
            self.assertEqual(
                payload["rejections"]["runtime_fallback_alert_ratio_threshold"], 0.01
            )
            self.assertTrue(payload["rejections"]["runtime_fallback_alert_active"])
            self.assertEqual(payload["rejections"]["market_context_block_total"], 7)
            self.assertEqual(payload["rejections"]["pre_llm_capacity_reject_total"], 11)
            self.assertEqual(payload["rejections"]["pre_llm_qty_below_min_total"], 13)
            self.assertFalse(payload["shorting_metadata"]["account_ready"])
            self.assertTrue(payload["shorting_metadata"]["alert_active"])
            self.assertEqual(
                payload["shorting_metadata"]["last_error"],
                "account lookup unavailable",
            )
            self.assertTrue(payload["alerts"]["market_context_alert_active"])
            self.assertTrue(payload["alerts"]["runtime_fallback_alert_active"])
            self.assertTrue(payload["alerts"]["shorting_metadata_alert_active"])
        finally:
            if original_scheduler is None:
                if hasattr(app.state, "trading_scheduler"):
                    del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_trading_metrics_includes_control_plane_contract(self) -> None:
        response = self.client.get("/trading/metrics")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIn("control_plane_contract", payload)
        self.assertIn("build", payload)
        self.assertIn("shadow_first", payload)
        self.assertEqual(
            payload["control_plane_contract"]["contract_version"],
            "torghut.quant-producer.v1",
        )
        self.assertEqual(
            payload["control_plane_contract"]["alpha_readiness_hypotheses_total"], 3
        )
        self.assertEqual(
            payload["control_plane_contract"]["alpha_readiness_blocked_total"], 1
        )
        self.assertEqual(
            payload["control_plane_contract"]["alpha_readiness_shadow_total"], 2
        )
        self.assertIn("critical_toggle_parity", payload["control_plane_contract"])
        self.assertIn("active_revision", payload["build"])

    def test_trading_status_and_metrics_expose_execution_advisor_counters(self) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        try:
            scheduler = TradingScheduler()
            scheduler.state.metrics.execution_advisor_usage_total = {
                "advisory_only": 2,
                "fallback": 3,
            }
            scheduler.state.metrics.execution_advisor_fallback_total = {
                "advisor_disabled": 1,
                "advisor_timeout": 2,
            }
            app.state.trading_scheduler = scheduler

            status_response = self.client.get("/trading/status")
            self.assertEqual(status_response.status_code, 200)
            status_payload = status_response.json()
            advisor = status_payload["execution_advisor"]
            self.assertIn("enabled", advisor)
            self.assertIn("live_apply_enabled", advisor)
            self.assertEqual(advisor["usage_total"]["advisory_only"], 2)
            self.assertEqual(advisor["fallback_total"]["advisor_timeout"], 2)

            with patch("app.main._load_route_provenance_summary", return_value={}):
                metrics_response = self.client.get("/metrics")
            self.assertEqual(metrics_response.status_code, 200)
            metrics_payload = metrics_response.text
            self.assertIn(
                'torghut_trading_execution_advisor_usage_total{status="advisory_only"} 2',
                metrics_payload,
            )
            self.assertIn(
                'torghut_trading_execution_advisor_fallback_total{reason="advisor_disabled"} 1',
                metrics_payload,
            )
            self.assertIn(
                'torghut_trading_hypothesis_state_total{state="blocked"} 1',
                metrics_payload,
            )
            self.assertIn(
                'torghut_trading_hypothesis_state_total{state="shadow"} 2',
                metrics_payload,
            )
            self.assertIn(
                'torghut_trading_hypothesis_capital_stage_total{stage="shadow"} 3',
                metrics_payload,
            )
            self.assertIn(
                "torghut_trading_alpha_readiness_hypotheses_total 3",
                metrics_payload,
            )
            self.assertIn("torghut_trading_llm_runtime_fallback_ratio", metrics_payload)
            self.assertIn(
                "torghut_trading_market_context_alert_active", metrics_payload
            )
        finally:
            if original_scheduler is None:
                del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    @patch("app.main._load_tca_summary", side_effect=SQLAlchemyError("boom"))
    def test_trading_status_maps_unhandled_db_errors_to_503(
        self, _mock_tca: object
    ) -> None:
        response = self.client.get("/trading/status")
        self.assertEqual(response.status_code, 503)
        payload = response.json()
        self.assertEqual(payload["detail"], "database unavailable")

    def test_trading_status_includes_signal_ingest_metadata(self) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        try:
            scheduler = TradingScheduler()
            scheduler.state.last_ingest_reason = "cursor_ahead_of_stream"
            scheduler.state.last_ingest_signals_total = 0
            scheduler.state.autonomy_no_signal_streak = 4
            scheduler.state.last_autonomy_recommendation_trace_id = "trace-123"
            scheduler.state.last_signal_continuity_state = (
                "expected_market_closed_staleness"
            )
            scheduler.state.last_signal_continuity_reason = "no_signals_in_window"
            scheduler.state.last_signal_continuity_actionable = False
            scheduler.state.market_session_open = False
            scheduler.state.signal_continuity_alert_active = True
            scheduler.state.signal_continuity_alert_reason = "cursor_ahead_of_stream"
            scheduler.state.signal_continuity_recovery_streak = 1
            app.state.trading_scheduler = scheduler

            response = self.client.get("/trading/status")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            autonomy = payload["autonomy"]
            self.assertEqual(autonomy["last_ingest_signal_count"], 0)
            self.assertEqual(autonomy["last_ingest_reason"], "cursor_ahead_of_stream")
            self.assertEqual(autonomy["no_signal_streak"], 4)
            self.assertEqual(autonomy["last_recommendation_trace_id"], "trace-123")
            continuity = payload["signal_continuity"]
            self.assertEqual(
                continuity["last_state"], "expected_market_closed_staleness"
            )
            self.assertEqual(continuity["last_reason"], "no_signals_in_window")
            self.assertFalse(continuity["last_actionable"])
            self.assertFalse(continuity["market_session_open"])
            self.assertTrue(continuity["alert_active"])
            self.assertEqual(continuity["alert_reason"], "cursor_ahead_of_stream")
            self.assertEqual(continuity["alert_recovery_streak"], 1)
            self.assertIsNone(payload["autonomy"]["last_actuation_intent"])
        finally:
            if original_scheduler is None:
                del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_trading_status_surfaces_universe_fail_safe_state(self) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        try:
            scheduler = TradingScheduler()
            scheduler.state.universe_source_status = "unavailable"
            scheduler.state.universe_source_reason = "jangar_symbols_fetch_failed"
            scheduler.state.universe_fail_safe_blocked = True
            scheduler.state.universe_fail_safe_block_reason = (
                "jangar_symbols_fetch_failed"
            )
            app.state.trading_scheduler = scheduler

            response = self.client.get("/trading/status")
            self.assertEqual(response.status_code, 200)
            continuity = response.json()["signal_continuity"]
            self.assertTrue(continuity["universe_fail_safe_blocked"])
            self.assertEqual(
                continuity["universe_fail_safe_block_reason"],
                "jangar_symbols_fetch_failed",
            )
            self.assertEqual(continuity["universe_status"], "unavailable")
        finally:
            if original_scheduler is None:
                del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_trading_status_includes_emergency_stop_recovery_fields(self) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        try:
            scheduler = TradingScheduler()
            scheduler.state.emergency_stop_active = True
            scheduler.state.emergency_stop_reason = "signal_lag_exceeded:900"
            scheduler.state.emergency_stop_triggered_at = datetime.now(timezone.utc)
            scheduler.state.emergency_stop_recovery_streak = 2
            scheduler.state.emergency_stop_resolved_at = datetime.now(timezone.utc)
            app.state.trading_scheduler = scheduler

            response = self.client.get("/trading/status")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            rollback = payload["rollback"]
            self.assertIn("emergency_stop_recovery_streak", rollback)
            self.assertIn("emergency_stop_resolved_at", rollback)
            self.assertEqual(rollback["emergency_stop_recovery_streak"], 2)
        finally:
            if original_scheduler is None:
                del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_trading_status_includes_last_actuation_intent(self) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        with TemporaryDirectory() as tmpdir:
            actuation_path = Path(tmpdir) / "actuation-intent.json"
            actuation_path.write_text(json.dumps({}), encoding="utf-8")
            try:
                scheduler = TradingScheduler()
                scheduler.state.last_autonomy_actuation_intent = str(actuation_path)
                app.state.trading_scheduler = scheduler
                response = self.client.get("/trading/status")
                self.assertEqual(response.status_code, 200)
                self.assertEqual(
                    response.json()["autonomy"]["last_actuation_intent"],
                    str(actuation_path),
                )
            finally:
                if original_scheduler is None:
                    if hasattr(app.state, "trading_scheduler"):
                        del app.state.trading_scheduler
                else:
                    app.state.trading_scheduler = original_scheduler

    def test_trading_autonomy_includes_no_signal_streak(self) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        try:
            scheduler = TradingScheduler()
            scheduler.state.autonomy_no_signal_streak = 7
            scheduler.state.last_autonomy_reason = "cursor_ahead_of_stream"
            scheduler.state.last_autonomy_recommendation_trace_id = "autonomy-trace-1"
            app.state.trading_scheduler = scheduler

            response = self.client.get("/trading/autonomy")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertEqual(payload["no_signal_streak"], 7)
            self.assertEqual(payload["last_reason"], "cursor_ahead_of_stream")
            self.assertEqual(
                payload["last_recommendation_trace_id"], "autonomy-trace-1"
            )
            self.assertIsNone(payload["last_actuation_intent"])
        finally:
            if original_scheduler is None:
                del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_trading_autonomy_exposes_bridge_status(self) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        with TemporaryDirectory() as tmpdir:
            gate_path = Path(tmpdir) / "gate-evaluation.json"
            gate_path.write_text(
                json.dumps(
                    {
                        "run_id": "run-bridge-1",
                        "promotion_evidence": {
                            "simulation_calibration": {
                                "artifact_ref": "gates/simulation-calibration-report-v1.json",
                                "status": "calibrated",
                                "order_count": 12,
                                "artifact_authority": {
                                    "authoritative": True,
                                    "provenance": "paper_runtime_observed",
                                },
                            },
                            "shadow_live_deviation": {
                                "artifact_ref": "gates/shadow-live-deviation-report-v1.json",
                                "status": "within_budget",
                                "avg_abs_slippage_bps": "6",
                                "artifact_authority": {
                                    "authoritative": True,
                                    "provenance": "paper_runtime_observed",
                                },
                            },
                        },
                        "provenance": {
                            "gate_report_trace_id": "gate-trace-bridge-1",
                            "recommendation_trace_id": "rec-trace-bridge-1",
                            "promotion_evidence_authority": {
                                "simulation_calibration": {
                                    "authoritative": True,
                                },
                                "shadow_live_deviation": {
                                    "authoritative": True,
                                },
                            },
                        },
                        "dependency_quorum": {
                            "decision": "allow",
                            "reasons": [],
                            "message": "All upstream dependencies are healthy.",
                        },
                        "alpha_readiness": {
                            "promotion_eligible": True,
                            "strategy_families": ["intraday_tsmom_v1"],
                            "matched_hypothesis_ids": ["intraday-tsmom"],
                            "reasons": [],
                        },
                        "vnext": {
                            "strategy_compilation": [
                                {
                                    "strategy_id": "intraday-tsmom",
                                    "compiler_source": "spec_v2",
                                    "spec_compiled": True,
                                }
                            ]
                        },
                    }
                ),
                encoding="utf-8",
            )
            try:
                scheduler = TradingScheduler()
                scheduler.state.last_autonomy_gates = str(gate_path)
                scheduler.state.drift_status = "stable"
                app.state.trading_scheduler = scheduler

                with patch("app.main.SessionLocal", self.session_local):
                    response = self.client.get("/trading/autonomy")
                self.assertEqual(response.status_code, 200)
                payload = response.json()
                self.assertEqual(payload["bridge_status"]["source"], "gate_report")
                self.assertIn(
                    payload["forecast_service"]["authority"], {"empirical", "blocked"}
                )
                self.assertIn(
                    payload["lean_authority"]["authority"], {"empirical", "blocked"}
                )
                self.assertIn(
                    payload["empirical_jobs"]["authority"], {"empirical", "blocked"}
                )
                self.assertEqual(
                    payload["bridge_status"]["strategy_compilation"]["spec_compiled"],
                    1,
                )
                self.assertEqual(
                    payload["bridge_status"]["simulation_calibration"]["status"],
                    "calibrated",
                )
                self.assertEqual(
                    payload["bridge_status"]["shadow_live_deviation"]["drift_status"],
                    "stable",
                )
                self.assertEqual(
                    payload["bridge_status"]["evidence_authority"][
                        "authoritative_count"
                    ],
                    2,
                )
                self.assertEqual(
                    payload["bridge_status"]["dependency_quorum"]["decision"],
                    "allow",
                )
                self.assertTrue(
                    payload["bridge_status"]["alpha_readiness"]["promotion_eligible"]
                )
            finally:
                if original_scheduler is None:
                    del app.state.trading_scheduler
                else:
                    app.state.trading_scheduler = original_scheduler

    def test_trading_empirical_jobs_endpoint_exposes_latest_job_freshness(self) -> None:
        with self.session_local() as session:
            session.add(
                VNextEmpiricalJobRun(
                    run_id="run-empirical-1",
                    candidate_id="cand-empirical-1",
                    job_name="benchmark parity",
                    job_type="benchmark_parity",
                    job_run_id="job-benchmark-1",
                    status="completed",
                    authority="empirical",
                    promotion_authority_eligible=True,
                    dataset_snapshot_ref="s3://datasets/run-empirical-1.json",
                    artifact_refs=["s3://artifacts/benchmark.json"],
                    payload_json=_truthful_empirical_payload(
                        job_run_id="job-benchmark-1",
                        dataset_snapshot_ref="s3://datasets/run-empirical-1.json",
                    ),
                )
            )
            session.commit()

        with patch("app.main.SessionLocal", self.session_local):
            response = self.client.get("/trading/empirical-jobs")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIn("jobs", payload)
        self.assertEqual(
            payload["message"],
            "missing empirical jobs: foundation_router_parity, janus_event_car, janus_hgrm_reward",
        )
        self.assertEqual(payload["eligible_jobs"], ["benchmark_parity"])
        self.assertEqual(
            payload["missing_jobs"],
            ["foundation_router_parity", "janus_event_car", "janus_hgrm_reward"],
        )
        self.assertEqual(payload["jobs"]["benchmark_parity"]["authority"], "empirical")
        self.assertEqual(
            payload["jobs"]["benchmark_parity"]["job_run_id"], "job-benchmark-1"
        )

    def test_trading_completion_doc29_endpoint_exposes_traceable_gate_status(
        self,
    ) -> None:
        with self.session_local() as session:
            trace = build_completion_trace(
                doc_id="doc29",
                gate_ids_attempted=[DOC29_SIMULATION_FULL_DAY_GATE],
                run_id="sim-2026-03-06-full-day",
                dataset_snapshot_ref="snapshot-1",
                candidate_id="cand-1",
                workflow_name="torghut-historical-simulation",
                analysis_run_names=[],
                artifact_refs=["s3://artifacts/run-full-lifecycle-manifest.json"],
                db_row_refs={},
                status_snapshot={},
                result_by_gate={
                    DOC29_SIMULATION_FULL_DAY_GATE: {
                        "status": TRACE_STATUS_SATISFIED,
                        "artifact_ref": "s3://artifacts/run-full-lifecycle-manifest.json",
                        "acceptance_snapshot": {
                            "trade_decisions": 640,
                            "executions": 320,
                            "execution_tca_metrics": 320,
                            "execution_order_events": 320,
                            "coverage_ratio": 0.99,
                        },
                    }
                },
                blocked_reasons={},
                git_revision="abc123",
                image_digest="sha256:test",
            )
            persist_completion_trace(
                session=session,
                trace_payload=trace,
                default_artifact_ref="s3://artifacts/completion-trace.json",
            )
            session.commit()

        with (
            patch("app.main.SessionLocal", self.session_local),
            patch("app.main.BUILD_COMMIT", "abc123"),
        ):
            response = self.client.get("/trading/completion/doc29")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["doc_id"], "doc29")
        gate = next(
            item
            for item in payload["gates"]
            if item["gate_id"] == DOC29_SIMULATION_FULL_DAY_GATE
        )
        self.assertEqual(gate["status"], "satisfied")
        self.assertEqual(gate["latest_run"], "sim-2026-03-06-full-day")

        with (
            patch("app.main.SessionLocal", self.session_local),
            patch("app.main.BUILD_COMMIT", "abc123"),
        ):
            gate_response = self.client.get(
                f"/trading/completion/doc29/{DOC29_SIMULATION_FULL_DAY_GATE}"
            )
        self.assertEqual(gate_response.status_code, 200)
        self.assertEqual(
            gate_response.json()["gate_id"], DOC29_SIMULATION_FULL_DAY_GATE
        )

    def test_trading_autonomy_evidence_continuity_endpoint_returns_state_report(
        self,
    ) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        try:
            scheduler = TradingScheduler()
            scheduler.state.last_evidence_continuity_report = {
                "checked_runs": 2,
                "failed_runs": 0,
                "ok": True,
            }
            app.state.trading_scheduler = scheduler
            response = self.client.get("/trading/autonomy/evidence-continuity")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertIn("report", payload)
            self.assertEqual(payload["report"]["checked_runs"], 2)
            self.assertEqual(payload["report"]["failed_runs"], 0)
        finally:
            if original_scheduler is None:
                del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_trading_autonomy_evidence_continuity_endpoint_supports_refresh(
        self,
    ) -> None:
        response = self.client.get(
            "/trading/autonomy/evidence-continuity?refresh=true&run_limit=5"
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIn("report", payload)
        self.assertEqual(payload["report"]["checked_runs"], 0)
        self.assertEqual(payload["report"]["failed_runs"], 0)

    def test_trading_status_reports_effective_llm_guardrails(self) -> None:
        original = {
            "llm_shadow_mode": settings.llm_shadow_mode,
            "llm_enabled": settings.llm_enabled,
            "llm_rollout_stage": settings.llm_rollout_stage,
            "trading_mode": settings.trading_mode,
            "trading_live_enabled": settings.trading_live_enabled,
            "llm_fail_mode": settings.llm_fail_mode,
            "llm_fail_mode_enforcement": settings.llm_fail_mode_enforcement,
            "llm_fail_open_live_approved": settings.llm_fail_open_live_approved,
            "llm_allowed_models_raw": settings.llm_allowed_models_raw,
            "llm_evaluation_report": settings.llm_evaluation_report,
            "llm_effective_challenge_id": settings.llm_effective_challenge_id,
            "llm_shadow_completed_at": settings.llm_shadow_completed_at,
            "llm_model_version_lock": settings.llm_model_version_lock,
        }
        settings.llm_enabled = True
        settings.llm_rollout_stage = "stage3"
        settings.llm_shadow_mode = False
        settings.trading_mode = "live"
        settings.trading_live_enabled = True
        settings.llm_fail_mode = "pass_through"
        settings.llm_fail_mode_enforcement = "configured"
        settings.llm_fail_open_live_approved = True
        settings.llm_allowed_models_raw = None
        settings.llm_evaluation_report = None
        settings.llm_effective_challenge_id = None
        settings.llm_shadow_completed_at = None
        settings.llm_model_version_lock = None

        try:
            response = self.client.get("/trading/status")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            llm = payload["llm"]
            self.assertEqual(llm["rollout_stage"], "stage3")
            self.assertFalse(llm["shadow_mode"])
            self.assertTrue(llm["effective_shadow_mode"])
            self.assertEqual(llm["fail_mode_enforcement"], "configured")
            self.assertIn("configured_fail_mode_enabled", llm["policy_exceptions"])
            self.assertIn("policy_resolution", llm)
            self.assertIn("policy_resolution_counters", llm)
            self.assertEqual(llm["policy_resolution"]["classification"], "compliant")
            self.assertFalse(llm["policy_resolution"]["fail_mode_exception_active"])
            self.assertFalse(llm["policy_resolution"]["fail_mode_violation_active"])
            self.assertIn("guardrails", llm)
            self.assertTrue(llm["guardrails"]["allow_requests"])
            self.assertIn("llm_evaluation_report_missing", llm["guardrails"]["reasons"])
            self.assertIn(
                "llm_model_version_lock_missing", llm["guardrails"]["reasons"]
            )
        finally:
            settings.llm_shadow_mode = original["llm_shadow_mode"]
            settings.llm_enabled = original["llm_enabled"]
            settings.llm_rollout_stage = original["llm_rollout_stage"]
            settings.trading_mode = original["trading_mode"]
            settings.trading_live_enabled = original["trading_live_enabled"]
            settings.llm_fail_mode = original["llm_fail_mode"]
            settings.llm_fail_mode_enforcement = original["llm_fail_mode_enforcement"]
            settings.llm_fail_open_live_approved = original[
                "llm_fail_open_live_approved"
            ]
            settings.llm_allowed_models_raw = original["llm_allowed_models_raw"]
            settings.llm_evaluation_report = original["llm_evaluation_report"]
            settings.llm_effective_challenge_id = original["llm_effective_challenge_id"]
            settings.llm_shadow_completed_at = original["llm_shadow_completed_at"]
            settings.llm_model_version_lock = original["llm_model_version_lock"]

    def test_trading_runtime_profitability_endpoint_happy_path(self) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        with self.session_local() as session:
            decision = session.execute(select(TradeDecision)).scalars().first()
            strategy = session.execute(select(Strategy)).scalars().first()
            self.assertIsNotNone(decision)
            self.assertIsNotNone(strategy)
            execution = Execution(
                trade_decision_id=decision.id if decision is not None else None,
                alpaca_order_id="order-2",
                client_order_id="client-2",
                symbol="AAPL",
                side="buy",
                order_type="limit",
                time_in_force="day",
                submitted_qty=Decimal("2"),
                filled_qty=Decimal("2"),
                avg_fill_price=Decimal("102"),
                status="filled",
                execution_expected_adapter="lean",
                execution_actual_adapter="alpaca_fallback",
                execution_fallback_reason="lean_submit_failed",
                execution_fallback_count=2,
                raw_order={},
                created_at=datetime.now(timezone.utc),
                last_update_at=datetime.now(timezone.utc),
            )
            session.add(execution)
            session.commit()
            session.refresh(execution)
            tca = ExecutionTCAMetric(
                execution_id=execution.id,
                trade_decision_id=decision.id if decision is not None else None,
                strategy_id=strategy.id if strategy is not None else None,
                alpaca_account_label="paper",
                symbol="AAPL",
                side="buy",
                arrival_price=Decimal("100"),
                avg_fill_price=Decimal("102"),
                filled_qty=Decimal("2"),
                signed_qty=Decimal("2"),
                slippage_bps=Decimal("200"),
                shortfall_notional=Decimal("2"),
                realized_shortfall_bps=Decimal("150"),
                churn_qty=Decimal("0"),
                churn_ratio=Decimal("0"),
                computed_at=datetime.now(timezone.utc),
            )
            session.add(tca)
            session.commit()

        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            gate_path = root / "gate-evaluation.json"
            rollback_path = root / "rollback-incident.json"
            gate_path.write_text(
                json.dumps(
                    {
                        "run_id": "run-demo",
                        "gates": [
                            {
                                "gate_id": "gate6_profitability_evidence",
                                "status": "pass",
                                "reasons": [],
                                "artifact_refs": [
                                    str(root / "profitability-evidence-v4.json")
                                ],
                            }
                        ],
                        "promotion_decision": {
                            "promotion_target": "paper",
                            "recommended_mode": "paper",
                            "promotion_allowed": True,
                            "reason_codes": [],
                            "promotion_gate_artifact": str(
                                root / "promotion-evidence-gate.json"
                            ),
                        },
                        "promotion_recommendation": {
                            "action": "promote",
                            "trace_id": "recommendation-trace-demo",
                        },
                        "provenance": {
                            "gate_report_trace_id": "gate-trace-demo",
                            "recommendation_trace_id": "recommendation-trace-demo",
                            "profitability_benchmark_artifact": str(
                                root / "profitability-benchmark-v4.json"
                            ),
                            "profitability_evidence_artifact": str(
                                root / "profitability-evidence-v4.json"
                            ),
                            "profitability_validation_artifact": str(
                                root / "profitability-evidence-validation.json"
                            ),
                        },
                    }
                ),
                encoding="utf-8",
            )
            actuation_path = root / "actuation-intent.json"
            actuation_path.write_text(
                json.dumps(
                    {
                        "schema_version": "torghut.autonomy.actuation-intent.v1",
                        "run_id": "run-demo",
                        "candidate_id": "candidate-demo",
                        "gates": {
                            "recommendation_trace_id": "act-rec-trace-demo",
                            "gate_report_trace_id": "act-gate-trace-demo",
                            "promotion_allowed": True,
                        },
                        "artifact_refs": [str(root / "profitability-evidence-v4.json")],
                        "audit": {
                            "rollback_readiness_readout": {
                                "kill_switch_dry_run_passed": True,
                                "gitops_revert_dry_run_passed": True,
                                "strategy_disable_dry_run_passed": False,
                                "human_approved": False,
                                "rollback_target": "rollback-target",
                                "dry_run_completed_at": "",
                            },
                            "rollback_evidence_missing_checks": [
                                "strategy_disable_dry_run_failed"
                            ],
                        },
                    }
                ),
                encoding="utf-8",
            )
            rollback_path.write_text(
                json.dumps(
                    {
                        "reasons": ["signal_lag_exceeded:900"],
                        "verification": {"incident_evidence_complete": True},
                    }
                ),
                encoding="utf-8",
            )

            try:
                scheduler = TradingScheduler()
                scheduler.state.last_autonomy_gates = str(gate_path)
                scheduler.state.rollback_incident_evidence_path = str(rollback_path)
                scheduler.state.rollback_incidents_total = 3
                scheduler.state.emergency_stop_active = True
                scheduler.state.emergency_stop_reason = "signal_lag_exceeded:900"
                scheduler.state.metrics.signal_continuity_promotion_block_total = 2
                scheduler.state.last_autonomy_actuation_intent = str(actuation_path)
                app.state.trading_scheduler = scheduler

                response = self.client.get("/trading/profitability/runtime")
                self.assertEqual(response.status_code, 200)
                payload = response.json()
                self.assertEqual(
                    payload["schema_version"], "torghut.runtime-profitability.v1"
                )
                self.assertEqual(payload["window"]["lookback_hours"], 72)
                self.assertEqual(payload["window"]["decision_count"], 1)
                self.assertEqual(payload["window"]["execution_count"], 2)
                self.assertEqual(
                    payload["executions"]["fallback_reason_totals"][
                        "lean_submit_failed"
                    ],
                    1,
                )
                self.assertEqual(
                    payload["realized_pnl_summary"]["shortfall_notional_total"], "3"
                )
                self.assertEqual(
                    payload["realized_pnl_summary"]["realized_pnl_proxy_notional"],
                    "-3",
                )
                self.assertEqual(
                    payload["gate_rollback_attribution"]["gate_report_trace_id"],
                    "act-gate-trace-demo",
                )
                self.assertTrue(
                    payload["gate_rollback_attribution"][
                        "gate6_profitability_evidence"
                    ]["status"]
                    == "pass"
                )
                self.assertEqual(
                    payload["gate_rollback_attribution"]["actuation_intent"][
                        "artifact_path"
                    ],
                    str(actuation_path),
                )
                self.assertFalse(
                    payload["gate_rollback_attribution"]["actuation_intent"][
                        "actuation_allowed"
                    ]
                )
                self.assertEqual(
                    payload["gate_rollback_attribution"]["actuation_intent"][
                        "rollback_readiness"
                    ]["missing_checks"],
                    ["strategy_disable_dry_run_failed"],
                )
            finally:
                if original_scheduler is None:
                    if hasattr(app.state, "trading_scheduler"):
                        del app.state.trading_scheduler
                else:
                    app.state.trading_scheduler = original_scheduler

    def test_trading_runtime_profitability_endpoint_empty_window(self) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        try:
            with self.session_local() as session:
                old_ts = datetime.now(timezone.utc) - timedelta(days=10)
                for decision in session.execute(select(TradeDecision)).scalars().all():
                    decision.created_at = old_ts
                    decision.executed_at = old_ts
                for execution in session.execute(select(Execution)).scalars().all():
                    execution.created_at = old_ts
                    execution.last_update_at = old_ts
                for tca in session.execute(select(ExecutionTCAMetric)).scalars().all():
                    tca.computed_at = old_ts
                session.commit()

            scheduler = TradingScheduler()
            app.state.trading_scheduler = scheduler
            response = self.client.get("/trading/profitability/runtime")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertTrue(payload["window"]["empty"])
            self.assertEqual(payload["window"]["decision_count"], 0)
            self.assertEqual(payload["window"]["execution_count"], 0)
            self.assertEqual(payload["decisions_by_symbol_strategy"], [])
            self.assertEqual(payload["executions"]["by_adapter"], [])
            self.assertEqual(payload["realized_pnl_summary"]["tca_sample_count"], 0)
            caveat_codes = {item["code"] for item in payload["caveats"]}
            self.assertIn("empty_window_no_runtime_evidence", caveat_codes)
        finally:
            if original_scheduler is None:
                if hasattr(app.state, "trading_scheduler"):
                    del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_trading_llm_evaluation_endpoint(self) -> None:
        response = self.client.get("/trading/llm-evaluation")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["ok"])
        metrics = payload["metrics"]
        self.assertEqual(metrics["tokens"]["prompt"], 120)
        self.assertEqual(metrics["tokens"]["completion"], 45)
