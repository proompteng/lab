from __future__ import annotations

import json
from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.config import settings
from app.models import (
    AutoresearchCandidateSpec,
    AutoresearchEpoch,
    AutoresearchPortfolioCandidate,
    AutoresearchProposalScore,
    Base,
    Strategy,
    StrategyHypothesisMetricWindow,
    StrategyPromotionDecision,
    TradeDecision,
)
from app.trading.hypotheses import JangarDependencyQuorumStatus
from app.trading.submission_council import (
    _QUANT_HEALTH_CACHE,
    _coerce_aware_datetime,
    _load_profit_promotion_table_counts,
    _merge_runtime_certificate_evidence,
    build_hypothesis_runtime_summary,
    build_live_submission_gate_payload,
    load_quant_evidence_status,
    resolve_quant_health_url,
)


class _FakeQuantHealthResponse:
    def __init__(self, payload: dict[str, object], *, status: int = 200) -> None:
        self._payload = payload
        self.status = status

    def __enter__(self) -> "_FakeQuantHealthResponse":
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def read(self) -> bytes:
        return json.dumps(self._payload).encode("utf-8")


class TestSubmissionCouncil(TestCase):
    def setUp(self) -> None:
        self._settings_snapshot = {
            "trading_enabled": settings.trading_enabled,
            "trading_mode": settings.trading_mode,
            "trading_autonomy_enabled": settings.trading_autonomy_enabled,
            "trading_autonomy_allow_live_promotion": settings.trading_autonomy_allow_live_promotion,
            "trading_kill_switch_enabled": settings.trading_kill_switch_enabled,
            "trading_jangar_quant_health_url": settings.trading_jangar_quant_health_url,
            "trading_jangar_quant_health_required": settings.trading_jangar_quant_health_required,
            "trading_jangar_quant_window": settings.trading_jangar_quant_window,
            "trading_jangar_control_plane_cache_ttl_seconds": settings.trading_jangar_control_plane_cache_ttl_seconds,
            "trading_jangar_control_plane_status_url": settings.trading_jangar_control_plane_status_url,
            "trading_market_context_url": settings.trading_market_context_url,
            "trading_drift_live_promotion_max_evidence_age_seconds": settings.trading_drift_live_promotion_max_evidence_age_seconds,
        }
        _QUANT_HEALTH_CACHE.clear()
        settings.trading_enabled = True
        settings.trading_mode = "live"
        settings.trading_autonomy_enabled = False
        settings.trading_autonomy_allow_live_promotion = False
        settings.trading_kill_switch_enabled = False

    def tearDown(self) -> None:
        settings.trading_enabled = self._settings_snapshot["trading_enabled"]
        settings.trading_mode = self._settings_snapshot["trading_mode"]
        settings.trading_autonomy_enabled = self._settings_snapshot[
            "trading_autonomy_enabled"
        ]
        settings.trading_autonomy_allow_live_promotion = self._settings_snapshot[
            "trading_autonomy_allow_live_promotion"
        ]
        settings.trading_kill_switch_enabled = self._settings_snapshot[
            "trading_kill_switch_enabled"
        ]
        settings.trading_jangar_quant_health_url = self._settings_snapshot[
            "trading_jangar_quant_health_url"
        ]
        settings.trading_jangar_quant_health_required = self._settings_snapshot[
            "trading_jangar_quant_health_required"
        ]
        settings.trading_jangar_quant_window = self._settings_snapshot[
            "trading_jangar_quant_window"
        ]
        settings.trading_jangar_control_plane_cache_ttl_seconds = (
            self._settings_snapshot["trading_jangar_control_plane_cache_ttl_seconds"]
        )
        settings.trading_jangar_control_plane_status_url = self._settings_snapshot[
            "trading_jangar_control_plane_status_url"
        ]
        settings.trading_market_context_url = self._settings_snapshot[
            "trading_market_context_url"
        ]
        settings.trading_drift_live_promotion_max_evidence_age_seconds = (
            self._settings_snapshot[
                "trading_drift_live_promotion_max_evidence_age_seconds"
            ]
        )
        _QUANT_HEALTH_CACHE.clear()

    def _metric_window(self, capital_stage: str = "0.10x canary") -> SimpleNamespace:
        observed_at = datetime.now(timezone.utc)
        return SimpleNamespace(
            id="window-1",
            candidate_id="cand-1",
            capital_stage=capital_stage,
            window_ended_at=observed_at,
            created_at=observed_at,
            continuity_ok=True,
            drift_ok=True,
            dependency_quorum_decision="allow",
        )

    def _promotion_decision(
        self, capital_stage: str = "0.10x canary"
    ) -> SimpleNamespace:
        return SimpleNamespace(
            id="promo-1",
            candidate_id="cand-1",
            state=capital_stage,
        )

    def _healthy_quant_status(self) -> dict[str, object]:
        return {
            "required": True,
            "ok": True,
            "reason": "ready",
            "blocking_reasons": [],
            "account": "paper",
            "window": "15m",
            "status": "healthy",
            "source_url": "http://jangar.test/api/torghut/trading/control-plane/quant/health?account=paper&window=15m",
        }

    def test_runtime_certificate_merge_keeps_invalid_evidence_shadow(self) -> None:
        now = datetime.now(timezone.utc)
        base_item = {
            "hypothesis_id": "H-CONT-01",
            "candidate_id": None,
            "capital_stage": "shadow",
            "capital_multiplier": "0",
            "promotion_eligible": False,
            "rollback_required": False,
            "reasons": ["drift_checks_missing"],
            "informational_reasons": [],
            "observed": {},
        }

        def metric_window(**overrides: object) -> SimpleNamespace:
            payload: dict[str, object] = {
                "id": "window-invalid",
                "candidate_id": "cand-runtime",
                "capital_stage": "0.10x canary",
                "window_ended_at": now,
                "created_at": now,
                "continuity_ok": True,
                "drift_ok": True,
                "dependency_quorum_decision": "allow",
                "market_session_count": 3,
                "decision_count": 42,
                "trade_count": 42,
                "order_count": 42,
                "avg_abs_slippage_bps": "4.2",
                "post_cost_expectancy_bps": "8.5",
            }
            payload.update(overrides)
            return SimpleNamespace(**payload)

        def promotion(**overrides: object) -> SimpleNamespace:
            payload: dict[str, object] = {
                "id": "promo-invalid",
                "candidate_id": "cand-runtime",
                "state": "0.10x canary",
                "allowed": True,
            }
            payload.update(overrides)
            return SimpleNamespace(**payload)

        scenarios = [
            [],
            [
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": metric_window(
                        window_ended_at=None,
                        created_at=None,
                    ),
                    "promotion_decision": promotion(),
                }
            ],
            [
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": metric_window(),
                    "promotion_decision": promotion(allowed=False),
                }
            ],
            [
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": metric_window(
                        window_ended_at=now.replace(year=2020),
                    ),
                    "promotion_decision": promotion(),
                }
            ],
            [
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": metric_window(
                        dependency_quorum_decision="block",
                    ),
                    "promotion_decision": promotion(),
                }
            ],
            [
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": metric_window(capital_stage="observe"),
                    "promotion_decision": promotion(state="observe"),
                }
            ],
        ]

        for evidence in scenarios:
            with self.subTest(evidence=evidence):
                result = _merge_runtime_certificate_evidence(
                    [base_item],
                    evidence=evidence,
                    now=now,
                    max_age_seconds=3600,
                )

                self.assertFalse(result[0]["promotion_eligible"])
                self.assertEqual(result[0]["capital_stage"], "shadow")
                self.assertEqual(result[0]["reasons"], ["drift_checks_missing"])

    def test_hypothesis_runtime_summary_uses_fresh_imported_runtime_proof(
        self,
    ) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        now = datetime.now(timezone.utc)
        settings.trading_drift_live_promotion_max_evidence_age_seconds = 3600
        registry = SimpleNamespace(
            loaded=True,
            path="test-registry",
            errors=[],
            items=[SimpleNamespace(hypothesis_id="H-CONT-01")],
        )
        runtime_items = [
            {
                "hypothesis_id": "H-CONT-01",
                "candidate_id": None,
                "strategy_id": "intraday_continuation",
                "lane_id": "continuation",
                "strategy_family": "intraday_continuation",
                "state": "shadow",
                "capital_stage": "shadow",
                "capital_multiplier": "0",
                "promotion_eligible": False,
                "rollback_required": False,
                "reasons": ["drift_checks_missing", "post_cost_expectancy_below_edge"],
                "informational_reasons": [],
                "observed": {},
            }
        ]

        with session_local() as session:
            session.add(
                StrategyHypothesisMetricWindow(
                    run_id="runtime-proof-1",
                    candidate_id="cand-runtime",
                    hypothesis_id="H-CONT-01",
                    observed_stage="paper",
                    window_started_at=now,
                    window_ended_at=now,
                    market_session_count=3,
                    decision_count=42,
                    trade_count=42,
                    order_count=42,
                    avg_abs_slippage_bps="4.2",
                    slippage_budget_bps="12",
                    post_cost_expectancy_bps="8.5",
                    continuity_ok=True,
                    drift_ok=True,
                    dependency_quorum_decision="allow",
                    capital_stage="0.10x canary",
                )
            )
            session.add(
                StrategyPromotionDecision(
                    run_id="runtime-proof-1",
                    candidate_id="cand-runtime",
                    hypothesis_id="H-CONT-01",
                    promotion_target="paper",
                    state="0.10x canary",
                    allowed=True,
                    reason_summary="runtime_evidence_thresholds_satisfied",
                )
            )
            session.commit()

            with (
                patch(
                    "app.trading.submission_council.load_hypothesis_registry",
                    return_value=registry,
                ),
                patch(
                    "app.trading.submission_council.resolve_hypothesis_dependency_quorum",
                    return_value=JangarDependencyQuorumStatus(
                        decision="allow",
                        reasons=[],
                        message="ready",
                    ),
                ),
                patch(
                    "app.trading.submission_council.compile_hypothesis_runtime_statuses",
                    return_value=runtime_items,
                ),
                patch(
                    "app.trading.submission_council.build_tca_gate_inputs",
                    return_value={},
                ),
            ):
                result = build_hypothesis_runtime_summary(
                    session,
                    state=SimpleNamespace(market_session_open=True),
                    market_context_status={"last_freshness_seconds": 10},
                )

        self.assertEqual(result["promotion_eligible_total"], 1)
        item = result["items"][0]
        self.assertTrue(item["promotion_eligible"])
        self.assertEqual(item["candidate_id"], "cand-runtime")
        self.assertEqual(item["capital_stage"], "0.10x canary")
        self.assertEqual(item["reasons"], [])
        self.assertEqual(item["observed"]["metric_window_decision_count"], 42)
        self.assertEqual(
            item["observed"]["runtime_window_prior_reasons"],
            ["drift_checks_missing", "post_cost_expectancy_below_edge"],
        )
        self.assertEqual(
            item["informational_reasons"],
            ["runtime_window_certificate_applied"],
        )

    def test_hypothesis_runtime_summary_rejects_failed_runtime_proof(self) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        now = datetime.now(timezone.utc)
        settings.trading_drift_live_promotion_max_evidence_age_seconds = 3600
        registry = SimpleNamespace(
            loaded=True,
            path="test-registry",
            errors=[],
            items=[SimpleNamespace(hypothesis_id="H-CONT-01")],
        )
        runtime_items = [
            {
                "hypothesis_id": "H-CONT-01",
                "candidate_id": None,
                "strategy_id": "intraday_continuation",
                "lane_id": "continuation",
                "strategy_family": "intraday_continuation",
                "state": "shadow",
                "capital_stage": "shadow",
                "capital_multiplier": "0",
                "promotion_eligible": False,
                "rollback_required": False,
                "reasons": ["drift_checks_missing"],
                "informational_reasons": [],
                "observed": {},
            }
        ]

        with session_local() as session:
            session.add(
                StrategyHypothesisMetricWindow(
                    run_id="runtime-proof-2",
                    candidate_id="cand-runtime",
                    hypothesis_id="H-CONT-01",
                    observed_stage="paper",
                    window_started_at=now,
                    window_ended_at=now,
                    market_session_count=3,
                    decision_count=42,
                    trade_count=42,
                    order_count=42,
                    avg_abs_slippage_bps="4.2",
                    slippage_budget_bps="12",
                    post_cost_expectancy_bps="8.5",
                    continuity_ok=True,
                    drift_ok=False,
                    dependency_quorum_decision="allow",
                    capital_stage="0.10x canary",
                )
            )
            session.add(
                StrategyPromotionDecision(
                    run_id="runtime-proof-2",
                    candidate_id="cand-runtime",
                    hypothesis_id="H-CONT-01",
                    promotion_target="paper",
                    state="0.10x canary",
                    allowed=True,
                    reason_summary="runtime_evidence_thresholds_satisfied",
                )
            )
            session.commit()

            with (
                patch(
                    "app.trading.submission_council.load_hypothesis_registry",
                    return_value=registry,
                ),
                patch(
                    "app.trading.submission_council.resolve_hypothesis_dependency_quorum",
                    return_value=JangarDependencyQuorumStatus(
                        decision="allow",
                        reasons=[],
                        message="ready",
                    ),
                ),
                patch(
                    "app.trading.submission_council.compile_hypothesis_runtime_statuses",
                    return_value=runtime_items,
                ),
                patch(
                    "app.trading.submission_council.build_tca_gate_inputs",
                    return_value={},
                ),
            ):
                result = build_hypothesis_runtime_summary(
                    session,
                    state=SimpleNamespace(market_session_open=True),
                    market_context_status={"last_freshness_seconds": 10},
                )

        self.assertEqual(result["promotion_eligible_total"], 0)
        item = result["items"][0]
        self.assertFalse(item["promotion_eligible"])
        self.assertEqual(item["capital_stage"], "shadow")
        self.assertEqual(item["reasons"], ["drift_checks_missing"])

    def test_coerce_aware_datetime_normalizes_runtime_status_values(self) -> None:
        self.assertEqual(
            _coerce_aware_datetime(datetime(2026, 5, 13, 20, 56, 16)),
            datetime(2026, 5, 13, 20, 56, 16, tzinfo=timezone.utc),
        )
        self.assertEqual(
            _coerce_aware_datetime("2026-05-13T20:56:16Z"),
            datetime(2026, 5, 13, 20, 56, 16, tzinfo=timezone.utc),
        )
        self.assertIsNone(_coerce_aware_datetime("not-a-timestamp"))
        self.assertIsNone(_coerce_aware_datetime(None))

    def test_load_profit_promotion_counts_includes_autoresearch_ledgers(self) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        with session_local() as session:
            session.add(
                AutoresearchEpoch(
                    epoch_id="epoch-1",
                    status="no_profit_target_candidate",
                    target_net_pnl_per_day=Decimal("500"),
                    paper_run_ids_json=[],
                    snapshot_manifest_json={},
                    runner_config_json={},
                    summary_json={},
                    started_at=datetime.now(timezone.utc),
                    completed_at=datetime.now(timezone.utc),
                )
            )
            session.add(
                AutoresearchCandidateSpec(
                    candidate_spec_id="spec-1",
                    epoch_id="epoch-1",
                    hypothesis_id="H-CONT-01",
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
                    payload_json={},
                )
            )
            session.add(
                AutoresearchPortfolioCandidate(
                    portfolio_candidate_id="portfolio-1",
                    epoch_id="epoch-1",
                    source_candidate_ids_json=["spec-1"],
                    target_net_pnl_per_day=Decimal("500"),
                    objective_scorecard_json={"oracle_passed": False},
                    optimizer_report_json={"selected_count": 1},
                    payload_json={"portfolio_candidate_id": "portfolio-1"},
                    status="blocked",
                )
            )
            session.commit()

            counts = _load_profit_promotion_table_counts(session)

        self.assertEqual(counts["research_candidates"], 0)
        self.assertEqual(counts["autoresearch_epochs"], 1)
        self.assertEqual(counts["autoresearch_candidate_specs"], 1)
        self.assertEqual(counts["autoresearch_proposal_scores"], 1)
        self.assertEqual(counts["autoresearch_portfolio_candidates"], 1)
        self.assertEqual(counts["autoresearch_portfolio_blocked"], 1)
        self.assertEqual(counts["autoresearch_portfolio_ready"], 0)

    def test_load_profit_promotion_counts_rejudges_ready_autoresearch_portfolios(
        self,
    ) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        with session_local() as session:
            session.add(
                AutoresearchPortfolioCandidate(
                    portfolio_candidate_id="portfolio-stale-ready",
                    epoch_id="epoch-stale",
                    source_candidate_ids_json=["spec-1"],
                    target_net_pnl_per_day=Decimal("500"),
                    objective_scorecard_json={
                        "oracle_passed": True,
                        "net_pnl_per_day": "9373",
                        "active_day_ratio": "1.0",
                        "positive_day_ratio": "0.50",
                        "best_day_share": "1.0",
                        "max_cluster_contribution_share": "1.0",
                        "max_single_symbol_contribution_share": "0.90",
                        "worst_day_loss": "2978",
                        "max_drawdown": "2978",
                        "max_gross_exposure_pct_equity": "0.5",
                        "min_cash": "1000",
                        "negative_cash_observation_count": 0,
                        "avg_filled_notional_per_day": "300000",
                        "regime_slice_pass_rate": "0.5",
                        "posterior_edge_lower": "1",
                        "shadow_parity_status": "within_budget",
                        "executable_replay_passed": True,
                        "executable_replay_order_count": 1,
                        "executable_replay_account_buying_power": "31590",
                        "executable_replay_max_notional_per_trade": "5000",
                    },
                    optimizer_report_json={"method": "old_optimizer"},
                    payload_json={"portfolio_candidate_id": "portfolio-stale-ready"},
                    status="target_met",
                )
            )
            session.add(
                AutoresearchPortfolioCandidate(
                    portfolio_candidate_id="portfolio-current-ready",
                    epoch_id="epoch-current",
                    source_candidate_ids_json=["spec-2"],
                    target_net_pnl_per_day=Decimal("500"),
                    objective_scorecard_json={
                        "net_pnl_per_day": "600",
                        "trading_day_count": 20,
                        "daily_net": {
                            "2026-05-01": "600",
                            "2026-05-02": "575",
                            "2026-05-03": "610",
                            "2026-05-04": "590",
                            "2026-05-05": "620",
                            "2026-05-06": "605",
                            "2026-05-07": "615",
                            "2026-05-08": "585",
                            "2026-05-09": "595",
                            "2026-05-10": "605",
                            "2026-05-11": "600",
                            "2026-05-12": "575",
                            "2026-05-13": "610",
                            "2026-05-14": "590",
                            "2026-05-15": "620",
                            "2026-05-16": "605",
                            "2026-05-17": "615",
                            "2026-05-18": "585",
                            "2026-05-19": "595",
                            "2026-05-20": "605",
                        },
                        "active_day_ratio": "1.0",
                        "positive_day_ratio": "1.0",
                        "best_day_share": "0.12",
                        "max_single_day_contribution_share": "0.12",
                        "max_cluster_contribution_share": "0.20",
                        "max_single_symbol_contribution_share": "0.20",
                        "worst_day_loss": "500",
                        "max_drawdown": "1000",
                        "max_gross_exposure_pct_equity": "0.5",
                        "min_cash": "1000",
                        "negative_cash_observation_count": 0,
                        "avg_filled_notional_per_day": "300000",
                        "regime_slice_pass_rate": "0.80",
                        "posterior_edge_lower": "1",
                        "shadow_parity_status": "within_budget",
                        "executable_replay_passed": True,
                        "executable_replay_artifact_ref": "s3://proof/current-ready.json",
                        "executable_replay_order_count": 4,
                        "executable_replay_account_buying_power": "31590",
                        "executable_replay_max_notional_per_trade": "5000",
                        "market_impact_stress_passed": True,
                        "market_impact_stress_artifact_ref": "s3://proof/current-ready-impact.json",
                        "market_impact_stress_model": "square_root",
                        "market_impact_stress_cost_bps": "6",
                        "market_impact_stress_net_pnl_per_day": "535",
                    },
                    optimizer_report_json={"method": "current_optimizer"},
                    payload_json={"portfolio_candidate_id": "portfolio-current-ready"},
                    status="promotion_ready",
                )
            )
            session.add(
                AutoresearchPortfolioCandidate(
                    portfolio_candidate_id="portfolio-invalid-scorecard",
                    epoch_id="epoch-invalid",
                    source_candidate_ids_json=["spec-3"],
                    target_net_pnl_per_day=Decimal("500"),
                    objective_scorecard_json=["not", "a", "scorecard"],
                    optimizer_report_json={"method": "bad_writer"},
                    payload_json={
                        "portfolio_candidate_id": "portfolio-invalid-scorecard"
                    },
                    status="target_met",
                )
            )
            session.commit()

            counts = _load_profit_promotion_table_counts(session)

        self.assertEqual(counts["autoresearch_portfolio_candidates"], 3)
        self.assertEqual(counts["autoresearch_portfolio_ready"], 1)
        self.assertEqual(counts["autoresearch_portfolio_blocked"], 2)

    def test_profit_lease_projection_uses_runtime_feature_and_persisted_decision_evidence(
        self,
    ) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        now = datetime.now(timezone.utc)
        with session_local() as session:
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
            session.add_all(
                [
                    TradeDecision(
                        strategy_id=strategy.id,
                        alpaca_account_label="paper",
                        symbol="AAPL",
                        timeframe="1Min",
                        decision_json={"action": "buy"},
                        status="planned",
                        created_at=now,
                    ),
                    TradeDecision(
                        strategy_id=strategy.id,
                        alpaca_account_label="paper",
                        symbol="AAPL",
                        timeframe="1Min",
                        decision_json={"action": "sell"},
                        status="blocked",
                        created_at=now,
                    ),
                ]
            )
            session.commit()

            result = build_live_submission_gate_payload(
                SimpleNamespace(
                    last_autonomy_promotion_eligible=True,
                    last_autonomy_promotion_action="promote",
                    drift_live_promotion_eligible=False,
                    last_market_context_freshness_seconds=45,
                    metrics=SimpleNamespace(
                        feature_batch_rows_total=9,
                        feature_null_rate={"price": 0.0},
                        feature_staleness_ms_p95=250,
                        feature_duplicate_ratio=0.0,
                        decision_state_total={},
                    ),
                ),
                hypothesis_summary={
                    "summary": {
                        "promotion_eligible_total": 1,
                        "capital_stage_totals": {"shadow": 1},
                        "dependency_quorum": {
                            "decision": "allow",
                            "reasons": [],
                            "message": "ready",
                        },
                    },
                    "items": [
                        {
                            "hypothesis_id": "H-CONT-01",
                            "lane_id": "continuation",
                            "strategy_family": "intraday_continuation",
                            "promotion_eligible": True,
                            "capital_stage": "shadow",
                            "reasons": [],
                        }
                    ],
                },
                empirical_jobs_status={"ready": True, "status": "healthy"},
                quant_health_status=self._healthy_quant_status(),
                promotion_certificate_evidence=[
                    {
                        "hypothesis_id": "H-CONT-01",
                        "metric_window": self._metric_window(),
                        "promotion_decision": self._promotion_decision(),
                    }
                ],
                session=session,
            )

        projection = result["profit_lease_projection"]
        reasons = projection["torghut_capital"]["blocking_reason_codes"]
        self.assertNotIn("equity_ta_rows_missing", reasons)
        self.assertNotIn("rejection_drag_unmeasured", reasons)
        equity_source = next(
            source
            for source in projection["source_provenance"]
            if source["source_class"] == "equity_ta"
        )
        rejection_source = next(
            source
            for source in projection["source_provenance"]
            if source["source_class"] == "rejection_drag"
        )
        self.assertEqual(equity_source["rows"], 9)
        self.assertEqual(rejection_source["rows"], 2)
        self.assertEqual(rejection_source["source_ref"], "postgres:trade_decisions:7d")

    def test_profit_lease_projection_uses_clickhouse_ta_readiness_after_restart(
        self,
    ) -> None:
        result = build_live_submission_gate_payload(
            SimpleNamespace(
                last_autonomy_promotion_eligible=True,
                last_autonomy_promotion_action="promote",
                drift_live_promotion_eligible=False,
                last_market_context_freshness_seconds=45,
                metrics=SimpleNamespace(
                    feature_batch_rows_total=0,
                    feature_null_rate={},
                    feature_staleness_ms_p95=0,
                    feature_duplicate_ratio=None,
                    decision_state_total={},
                ),
            ),
            hypothesis_summary={
                "summary": {
                    "promotion_eligible_total": 1,
                    "capital_stage_totals": {"shadow": 1},
                    "dependency_quorum": {
                        "decision": "allow",
                        "reasons": [],
                        "message": "ready",
                    },
                },
                "items": [
                    {
                        "hypothesis_id": "H-CONT-01",
                        "lane_id": "continuation",
                        "strategy_family": "intraday_continuation",
                        "promotion_eligible": True,
                        "capital_stage": "shadow",
                        "reasons": [],
                    }
                ],
            },
            empirical_jobs_status={"ready": True, "status": "healthy"},
            quant_health_status=self._healthy_quant_status(),
            clickhouse_ta_status={
                "state": "current",
                "source_ref": "torghut.ta_signals",
                "latest_signal_at": "2026-05-13T20:56:16+00:00",
                "signal_rows": 12,
                "symbol_count": 6,
            },
        )

        projection = result["profit_lease_projection"]
        reasons = projection["torghut_capital"]["blocking_reason_codes"]
        self.assertNotIn("equity_ta_rows_missing", reasons)
        equity_source = next(
            source
            for source in projection["source_provenance"]
            if source["source_class"] == "equity_ta"
        )
        self.assertEqual(equity_source["rows"], 12)
        self.assertEqual(equity_source["symbols"], 6)
        self.assertEqual(equity_source["source_ref"], "torghut.ta_signals")

    def test_build_live_submission_gate_payload_fails_closed_on_empty_quant_evidence(
        self,
    ) -> None:
        result = build_live_submission_gate_payload(
            SimpleNamespace(
                last_autonomy_promotion_eligible=True,
                last_autonomy_promotion_action="promote",
                drift_live_promotion_eligible=False,
                last_market_context_freshness_seconds=45,
            ),
            hypothesis_summary={
                "promotion_eligible_total": 1,
                "capital_stage_totals": {"shadow": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            },
            empirical_jobs_status={"ready": True, "status": "healthy"},
            quant_health_status={
                "required": True,
                "ok": False,
                "reason": "quant_latest_metrics_empty",
                "blocking_reasons": [
                    "quant_latest_metrics_empty",
                    "quant_latest_store_alarm",
                ],
                "account": "paper",
                "window": "15m",
                "status": "degraded",
                "latest_metrics_count": 0,
                "latest_metrics_updated_at": None,
                "empty_latest_store_alarm": True,
                "missing_update_alarm": False,
                "source_url": "http://jangar.test/api/torghut/trading/control-plane/quant/health?account=paper&window=15m",
            },
            promotion_certificate_evidence=[
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": self._metric_window(),
                    "promotion_decision": self._promotion_decision(),
                }
            ],
        )

        self.assertFalse(result["allowed"])
        self.assertEqual(result["reason"], "quant_latest_metrics_empty")
        self.assertEqual(result["capital_state"], "observe")
        self.assertIn("quant_latest_store_alarm", result["blocked_reasons"])
        self.assertEqual(result["quant_health_ref"]["window"], "15m")

    def test_build_live_submission_gate_payload_requires_valid_certificate_evidence(
        self,
    ) -> None:
        result = build_live_submission_gate_payload(
            SimpleNamespace(
                last_autonomy_promotion_eligible=True,
                last_autonomy_promotion_action="promote",
                drift_live_promotion_eligible=False,
                last_market_context_freshness_seconds=45,
            ),
            hypothesis_summary={
                "promotion_eligible_total": 1,
                "capital_stage_totals": {"shadow": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            },
            empirical_jobs_status={"ready": True, "status": "healthy"},
            quant_health_status=self._healthy_quant_status(),
            promotion_certificate_evidence=[
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": self._metric_window(),
                    "promotion_decision": self._promotion_decision(),
                }
            ],
        )

        self.assertTrue(result["allowed"])
        self.assertEqual(result["capital_state"], "0.10x canary")
        self.assertEqual(result["reason_codes"], ["promotion_certificate_valid"])
        self.assertEqual(result["evidence_tuple"]["hypothesis_id"], "H-CONT-01")
        self.assertEqual(result["evidence_tuple"]["candidate_id"], "cand-1")

    def test_build_live_submission_gate_payload_blocks_without_certificate_evidence(
        self,
    ) -> None:
        result = build_live_submission_gate_payload(
            SimpleNamespace(
                last_autonomy_promotion_eligible=True,
                last_autonomy_promotion_action="promote",
                drift_live_promotion_eligible=False,
                last_market_context_freshness_seconds=45,
            ),
            hypothesis_summary={
                "promotion_eligible_total": 1,
                "capital_stage_totals": {"shadow": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            },
            empirical_jobs_status={"ready": True, "status": "healthy"},
            quant_health_status=self._healthy_quant_status(),
            promotion_certificate_evidence=[],
        )

        self.assertFalse(result["allowed"])
        self.assertEqual(result["capital_state"], "observe")
        self.assertEqual(result["reason"], "promotion_certificate_missing")
        self.assertIn("hypothesis_window_evidence_missing", result["blocked_reasons"])
        contract = result["profit_window_contract"]
        self.assertEqual(
            contract["schema_version"], "torghut.profit-window-contract.v1"
        )
        self.assertEqual(contract["summary"]["windows_total"], 0)

    def test_build_live_submission_gate_payload_blocks_when_hypothesis_runtime_item_is_shadow(
        self,
    ) -> None:
        result = build_live_submission_gate_payload(
            SimpleNamespace(
                last_autonomy_promotion_eligible=True,
                last_autonomy_promotion_action="promote",
                drift_live_promotion_eligible=False,
                last_market_context_freshness_seconds=45,
            ),
            hypothesis_summary={
                "summary": {
                    "promotion_eligible_total": 1,
                    "capital_stage_totals": {"shadow": 1},
                    "dependency_quorum": {
                        "decision": "allow",
                        "reasons": [],
                        "message": "ready",
                    },
                },
                "items": [
                    {
                        "hypothesis_id": "H-CONT-01",
                        "promotion_eligible": False,
                        "capital_stage": "shadow",
                        "reasons": ["signal_continuity_alert_active"],
                        "segment_dependencies": ["ta-core", "execution"],
                    }
                ],
            },
            empirical_jobs_status={"ready": True, "status": "healthy"},
            quant_health_status=self._healthy_quant_status(),
            promotion_certificate_evidence=[
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": self._metric_window(),
                    "promotion_decision": self._promotion_decision(),
                }
            ],
        )

        self.assertFalse(result["allowed"])
        self.assertEqual(result["capital_state"], "observe")
        self.assertIn(
            "alpha_hypothesis_not_promotion_eligible",
            result["blocked_reasons"],
        )
        self.assertIn("alpha_hypothesis_shadow_only", result["blocked_reasons"])

    def test_build_live_submission_gate_payload_blocks_when_quant_health_is_not_configured(
        self,
    ) -> None:
        result = build_live_submission_gate_payload(
            SimpleNamespace(
                last_autonomy_promotion_eligible=True,
                last_autonomy_promotion_action="promote",
                drift_live_promotion_eligible=False,
                last_market_context_freshness_seconds=45,
            ),
            hypothesis_summary={
                "promotion_eligible_total": 1,
                "capital_stage_totals": {"shadow": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            },
            empirical_jobs_status={"ready": True, "status": "healthy"},
            quant_health_status={
                "required": True,
                "ok": False,
                "reason": "quant_health_not_configured",
                "blocking_reasons": ["quant_health_not_configured"],
                "account": "paper",
                "window": "15m",
                "status": "unknown",
                "source_url": None,
            },
            promotion_certificate_evidence=[
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": self._metric_window(),
                    "promotion_decision": self._promotion_decision(),
                }
            ],
        )

        self.assertFalse(result["allowed"])
        self.assertEqual(result["reason"], "quant_health_not_configured")
        self.assertIn("quant_health_not_configured", result["blocked_reasons"])

    def test_profit_window_contract_prices_stale_empirical_and_market_context_per_lane(
        self,
    ) -> None:
        result = build_live_submission_gate_payload(
            SimpleNamespace(
                last_autonomy_promotion_eligible=False,
                last_autonomy_promotion_action=None,
                drift_live_promotion_eligible=False,
                last_market_context_freshness_seconds=900,
                last_market_context_domain_states={"technicals": "down"},
                market_context_alert_active=True,
                market_context_alert_reason="market_context_down",
                market_session_open=False,
            ),
            hypothesis_summary={
                "summary": {
                    "promotion_eligible_total": 0,
                    "capital_stage_totals": {"shadow": 2},
                    "dependency_quorum": {
                        "decision": "allow",
                        "reasons": [],
                        "message": "ready",
                    },
                },
                "items": [
                    {
                        "hypothesis_id": "H-CONT-01",
                        "lane_id": "continuation",
                        "strategy_family": "intraday_continuation",
                        "state": "shadow",
                        "capital_stage": "shadow",
                        "reasons": [],
                        "dependency_capabilities": {
                            "required": [
                                "jangar_dependency_quorum",
                                "signal_continuity",
                            ],
                            "unknown": [],
                        },
                    },
                    {
                        "hypothesis_id": "H-REV-01",
                        "lane_id": "event-reversion",
                        "strategy_family": "event_reversion",
                        "state": "shadow",
                        "capital_stage": "shadow",
                        "reasons": ["market_context_stale"],
                        "dependency_capabilities": {
                            "required": [
                                "jangar_dependency_quorum",
                                "market_context_freshness",
                            ],
                            "unknown": [],
                        },
                    },
                ],
            },
            empirical_jobs_status={
                "ready": False,
                "status": "degraded",
                "stale_jobs": ["benchmark_parity"],
                "missing_jobs": [],
                "ineligible_jobs": [],
                "dataset_snapshot_refs": ["s3://torghut/empirical/cand-1"],
            },
            quant_health_status=self._healthy_quant_status(),
            promotion_certificate_evidence=[],
        )

        contract = result["profit_window_contract"]
        self.assertEqual(contract["window_session_class"], "off_session")
        self.assertEqual(contract["summary"]["windows_total"], 2)
        escrows = contract["escrows"]
        empirical_escrows = [
            item for item in escrows if item["type"] == "empirical_jobs"
        ]
        self.assertTrue(empirical_escrows)
        self.assertTrue(all(item["status"] == "expired" for item in empirical_escrows))
        rev_market_escrow = next(
            item
            for item in escrows
            if item["type"] == "market_context"
            and item["hypothesis_id"] == "H-REV-01"
            and item["evidence_escrow_id"]
            in next(
                window
                for window in contract["windows"]
                if window["hypothesis_id"] == "H-REV-01"
            )["required_escrow_ids"]
        )
        rev_window = next(
            window
            for window in contract["windows"]
            if window["hypothesis_id"] == "H-REV-01"
        )
        cont_market_escrow = next(
            item
            for item in escrows
            if item["type"] == "market_context" and item["hypothesis_id"] == "H-CONT-01"
        )
        cont_window = next(
            window
            for window in contract["windows"]
            if window["hypothesis_id"] == "H-CONT-01"
        )
        self.assertTrue(rev_market_escrow["required"])
        self.assertIn(
            rev_market_escrow["evidence_escrow_id"],
            rev_window["blocking_escrow_ids"],
        )
        self.assertFalse(cont_market_escrow["required"])
        self.assertNotIn(
            cont_market_escrow["evidence_escrow_id"],
            cont_window["blocking_escrow_ids"],
        )

    def test_resolve_quant_health_url_accepts_typed_endpoint_with_query(self) -> None:
        settings.trading_jangar_quant_health_url = " https://jangar.example/api/torghut/trading/control-plane/quant/health?window=1h "
        settings.trading_jangar_control_plane_status_url = (
            "https://jangar.example/status"
        )
        settings.trading_market_context_url = "https://jangar.example/market/context"

        self.assertEqual(
            resolve_quant_health_url(),
            "https://jangar.example/api/torghut/trading/control-plane/quant/health?window=1h",
        )

    def test_resolve_quant_health_url_rejects_wrong_endpoint_path(self) -> None:
        settings.trading_jangar_quant_health_url = (
            "https://jangar.example/api/agents/control-plane/status?namespace=agents"
        )
        settings.trading_jangar_control_plane_status_url = (
            "https://jangar.example/status"
        )
        settings.trading_market_context_url = "https://jangar.example/market/context"

        self.assertIsNone(resolve_quant_health_url())

    def test_resolve_quant_health_url_does_not_fallback_to_control_plane_status(
        self,
    ) -> None:
        settings.trading_jangar_quant_health_url = ""
        settings.trading_jangar_control_plane_status_url = (
            "https://jangar.example/api/agents/control-plane/status?namespace=agents"
        )
        settings.trading_market_context_url = (
            "https://jangar.example/api/torghut/market-context/health?symbol=NVDA"
        )

        self.assertIsNone(resolve_quant_health_url())

    def test_resolve_quant_health_url_does_not_fallback_to_market_context(self) -> None:
        settings.trading_jangar_quant_health_url = ""
        settings.trading_jangar_control_plane_status_url = ""
        settings.trading_market_context_url = (
            "https://jangar.example/api/torghut/market-context/health?symbol=NVDA"
        )

        self.assertIsNone(resolve_quant_health_url())

    def test_load_quant_evidence_status_is_informational_when_quant_health_is_not_required(
        self,
    ) -> None:
        settings.trading_jangar_quant_health_url = ""
        settings.trading_jangar_quant_health_required = False

        status = load_quant_evidence_status(account_label="paper")

        self.assertTrue(status["ok"])
        self.assertFalse(status["required"])
        self.assertEqual(status["status"], "not_required")
        self.assertEqual(status["reason"], "quant_health_not_configured")
        self.assertEqual(status["blocking_reasons"], [])

    def test_load_quant_evidence_status_blocks_when_quant_health_is_required(
        self,
    ) -> None:
        settings.trading_jangar_quant_health_url = ""
        settings.trading_jangar_quant_health_required = True

        status = load_quant_evidence_status(account_label="paper")

        self.assertFalse(status["ok"])
        self.assertTrue(status["required"])
        self.assertEqual(status["status"], "unknown")
        self.assertEqual(status["reason"], "quant_health_not_configured")
        self.assertEqual(status["blocking_reasons"], ["quant_health_not_configured"])

    def test_load_quant_evidence_status_rejects_wrong_endpoint_authority(self) -> None:
        settings.trading_jangar_quant_health_url = (
            "https://jangar.example/api/agents/control-plane/status?namespace=agents"
        )
        settings.trading_jangar_quant_health_required = True

        status = load_quant_evidence_status(account_label="paper")

        self.assertFalse(status["ok"])
        self.assertTrue(status["required"])
        self.assertEqual(status["reason"], "quant_health_invalid_endpoint")
        self.assertEqual(status["blocking_reasons"], ["quant_health_invalid_endpoint"])
        self.assertEqual(
            status["source_url"],
            "https://jangar.example/api/agents/control-plane/status?namespace=agents",
        )
        self.assertIn(
            "/api/torghut/trading/control-plane/quant/health",
            str(status["message"]),
        )

    def test_load_quant_evidence_status_keeps_invalid_endpoint_informational_when_not_required(
        self,
    ) -> None:
        settings.trading_jangar_quant_health_url = (
            "https://jangar.example/api/agents/control-plane/status?namespace=agents"
        )
        settings.trading_jangar_quant_health_required = False

        status = load_quant_evidence_status(account_label="paper")

        self.assertTrue(status["ok"])
        self.assertFalse(status["required"])
        self.assertEqual(status["reason"], "quant_health_invalid_endpoint")
        self.assertEqual(status["blocking_reasons"], [])
        self.assertEqual(
            status["informational_reasons"], ["quant_health_invalid_endpoint"]
        )

    def test_load_quant_evidence_status_reads_typed_endpoint_and_uses_cache(
        self,
    ) -> None:
        settings.trading_jangar_quant_health_url = "https://jangar.example/api/torghut/trading/control-plane/quant/health?source=typed"
        settings.trading_jangar_quant_health_required = True
        settings.trading_jangar_quant_window = "15m"
        settings.trading_jangar_control_plane_cache_ttl_seconds = 60
        calls: list[str] = []

        def fake_urlopen(request: object, timeout: object) -> _FakeQuantHealthResponse:
            calls.append(str(getattr(request, "full_url")))
            self.assertEqual(
                timeout, settings.trading_jangar_control_plane_timeout_seconds
            )
            return _FakeQuantHealthResponse(
                {
                    "ok": True,
                    "status": "healthy",
                    "latestMetricsCount": 4,
                    "emptyLatestStoreAlarm": False,
                    "missingUpdateAlarm": False,
                    "stages": [{"name": "metrics", "ok": "yes"}],
                    "latestMetricsUpdatedAt": "2026-04-30T20:59:00Z",
                    "metricsPipelineLagSeconds": 3,
                    "maxStageLagSeconds": 5,
                    "asOf": "2026-04-30T20:59:03Z",
                }
            )

        with patch("app.trading.submission_council.urlopen", fake_urlopen):
            status = load_quant_evidence_status(account_label="paper")
            cached_status = load_quant_evidence_status(account_label="paper")

        self.assertEqual(len(calls), 1)
        self.assertIn("source=typed", calls[0])
        self.assertIn("account=paper", calls[0])
        self.assertIn("window=15m", calls[0])
        self.assertTrue(status["ok"])
        self.assertTrue(status["required"])
        self.assertEqual(status["reason"], "ready")
        self.assertEqual(status["stage_count"], 1)
        self.assertEqual(cached_status, status)

    def test_load_quant_evidence_status_reports_quant_pipeline_blockers(
        self,
    ) -> None:
        settings.trading_jangar_quant_health_url = (
            "https://jangar.example/api/torghut/trading/control-plane/quant/health"
        )
        settings.trading_jangar_quant_health_required = True
        settings.trading_jangar_control_plane_cache_ttl_seconds = 0

        payloads = [
            {
                "ok": True,
                "status": "healthy",
                "latestMetricsCount": 0,
                "emptyLatestStoreAlarm": True,
                "missingUpdateAlarm": True,
                "stages": [],
            },
            {
                "ok": True,
                "status": "healthy",
                "latestMetricsCount": 1,
                "emptyLatestStoreAlarm": False,
                "missingUpdateAlarm": False,
                "stages": [{"name": "metrics", "ok": "false"}],
            },
            {
                "ok": True,
                "status": "stale",
                "latestMetricsCount": 1,
                "emptyLatestStoreAlarm": False,
                "missingUpdateAlarm": False,
                "stages": [{"name": "metrics", "ok": True}],
            },
        ]

        def fake_urlopen(request: object, timeout: object) -> _FakeQuantHealthResponse:
            del request, timeout
            return _FakeQuantHealthResponse(payloads.pop(0))

        with patch("app.trading.submission_council.urlopen", fake_urlopen):
            empty_status = load_quant_evidence_status(account_label="paper")
            stage_status = load_quant_evidence_status(account_label="paper")
            stale_status = load_quant_evidence_status(account_label="paper")

        self.assertEqual(
            empty_status["blocking_reasons"],
            [
                "quant_latest_metrics_empty",
                "quant_latest_store_alarm",
                "quant_metrics_update_missing",
                "quant_pipeline_stages_missing",
            ],
        )
        self.assertEqual(stage_status["blocking_reasons"], ["quant_pipeline_degraded"])
        self.assertEqual(stale_status["blocking_reasons"], ["quant_health_degraded"])

    def test_load_quant_evidence_status_keeps_configured_degraded_endpoint_informational_when_not_required(
        self,
    ) -> None:
        settings.trading_jangar_quant_health_url = (
            "https://jangar.example/api/torghut/trading/control-plane/quant/health"
        )
        settings.trading_jangar_quant_health_required = False
        settings.trading_jangar_control_plane_cache_ttl_seconds = 0

        def fake_urlopen(request: object, timeout: object) -> _FakeQuantHealthResponse:
            del request, timeout
            return _FakeQuantHealthResponse(
                {
                    "ok": True,
                    "status": "healthy",
                    "latestMetricsCount": 0,
                    "emptyLatestStoreAlarm": True,
                    "missingUpdateAlarm": False,
                    "stages": [],
                }
            )

        with patch("app.trading.submission_council.urlopen", fake_urlopen):
            status = load_quant_evidence_status(account_label="paper")

        self.assertTrue(status["ok"])
        self.assertFalse(status["required"])
        self.assertEqual(status["status"], "degraded")
        self.assertEqual(status["reason"], "quant_latest_metrics_empty")
        self.assertEqual(status["blocking_reasons"], [])
        self.assertEqual(
            status["informational_reasons"],
            [
                "quant_latest_metrics_empty",
                "quant_latest_store_alarm",
                "quant_pipeline_stages_missing",
            ],
        )

    def test_load_quant_evidence_status_keeps_configured_fetch_failure_informational_when_not_required(
        self,
    ) -> None:
        settings.trading_jangar_quant_health_url = (
            "https://jangar.example/api/torghut/trading/control-plane/quant/health"
        )
        settings.trading_jangar_quant_health_required = False
        settings.trading_jangar_control_plane_cache_ttl_seconds = 0

        def fake_urlopen(request: object, timeout: object) -> _FakeQuantHealthResponse:
            del request, timeout
            raise RuntimeError("network unavailable")

        with patch("app.trading.submission_council.urlopen", fake_urlopen):
            status = load_quant_evidence_status(account_label="paper")

        self.assertTrue(status["ok"])
        self.assertFalse(status["required"])
        self.assertEqual(status["status"], "unknown")
        self.assertEqual(status["reason"], "quant_health_fetch_failed")
        self.assertEqual(status["blocking_reasons"], [])
        self.assertEqual(status["informational_reasons"], ["quant_health_fetch_failed"])
        self.assertEqual(status["message"], "network unavailable")
