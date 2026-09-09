from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models import (
    AutoresearchCandidateSpec,
    AutoresearchEpoch,
    AutoresearchPortfolioCandidate,
    AutoresearchProposalScore,
    Base,
    ResearchAttempt,
    ResearchCandidate,
    ResearchCostCalibration,
    ResearchFoldMetrics,
    ResearchPromotion,
    ResearchRun,
    ResearchSequentialTrial,
    ResearchStressMetrics,
    ResearchValidationTest,
)
from app.trading.autonomy.evidence import evaluate_evidence_continuity


def _passing_autoresearch_scorecard() -> dict[str, object]:
    return {
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
        "exact_replay_ledger_artifact_ref": "s3://proof/current-ready-ledger.json",
        "exact_replay_ledger_artifact_row_count": 20,
        "exact_replay_ledger_artifact_fill_count": 20,
        "portfolio_post_cost_net_pnl_basis": "realized_strategy_pnl_after_explicit_costs",
        "portfolio_post_cost_net_pnl_source": "exact_replay_runtime_ledger",
        "runtime_ledger_pnl_basis": "realized_strategy_pnl_after_explicit_costs",
        "runtime_ledger_pnl_source": "runtime_ledger",
        "market_impact_stress_passed": True,
        "market_impact_stress_artifact_ref": "s3://proof/current-ready-impact.json",
        "market_impact_stress_model": "square_root",
        "market_impact_stress_cost_bps": "6",
        "market_impact_liquidity_evidence_present": True,
        "market_impact_stress_net_pnl_per_day": "535",
        "delay_adjusted_depth_stress_passed": True,
        "delay_adjusted_depth_stress_artifact_ref": (
            "s3://proof/current-ready-delay-depth.json"
        ),
        "delay_adjusted_depth_stress_model": "latency_depth_haircut",
        "delay_adjusted_depth_stress_ms": "250",
        "delay_adjusted_depth_liquidity_evidence_present": True,
        "delay_adjusted_depth_liquidity_missing_day_count": 0,
        "delay_adjusted_depth_latency_grid_ms": ["50", "150", "250"],
        "delay_adjusted_depth_grid_max_stress_ms": "250",
        "delay_adjusted_depth_fillable_notional_per_day": "300000",
        "delay_adjusted_depth_tail_coverage_passed": True,
        "delay_adjusted_depth_worst_active_day_fillable_notional": "300000",
        "delay_adjusted_depth_p10_active_day_fillable_notional": "300000",
        "delay_adjusted_depth_fill_survival_evidence_present": True,
        "delay_adjusted_depth_fill_survival_sample_count": 20,
        "delay_adjusted_depth_fill_survival_rate": "0.85",
        "queue_position_survival_fill_curve_evidence_present": True,
        "queue_position_survival_sample_count": 20,
        "queue_position_survival_fill_rate": "0.85",
        "queue_position_survival_queue_ratio_p95": "0.25",
        "queue_position_survival_queue_ahead_depletion_evidence_present": True,
        "queue_position_survival_queue_ahead_depletion_sample_count": 20,
        "delay_adjusted_depth_queue_ahead_depletion_evidence_present": True,
        "delay_adjusted_depth_queue_ahead_depletion_sample_count": 20,
        "queue_ahead_depletion_evidence_present": True,
        "queue_ahead_depletion_sample_count": 20,
        "delay_adjusted_depth_stress_net_pnl_per_day": "525",
        "post_cost_net_pnl_after_queue_position_survival_fill_stress": "525",
        "double_oos_passed": True,
        "double_oos_artifact_ref": "s3://proof/current-ready-double-oos.json",
        "double_oos_independent_window_count": 2,
        "double_oos_pass_rate": "1.00",
        "double_oos_net_pnl_per_day": "540",
        "double_oos_cost_shock_net_pnl_per_day": "515",
    }


class TestEvidenceContinuity(TestCase):
    def setUp(self) -> None:
        self.engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
        )
        Base.metadata.create_all(self.engine)
        self.session_factory = sessionmaker(
            bind=self.engine, expire_on_commit=False, future=True
        )

    def tearDown(self) -> None:
        self.engine.dispose()

    def test_reports_missing_research_chain_rows(self) -> None:
        with self.session_factory() as session:
            session.add(ResearchRun(run_id="run-missing", status="passed"))
            session.commit()

            report = evaluate_evidence_continuity(session, run_limit=5)

        self.assertEqual(report.checked_runs, 1)
        self.assertEqual(report.failed_runs, 1)
        self.assertEqual(report.missing_runs[0]["run_id"], "run-missing")
        self.assertIn("research_candidates", report.missing_runs[0]["missing_tables"])
        self.assertFalse(report.to_payload()["ok"])

    def test_passes_with_full_research_chain(self) -> None:
        now = datetime(2026, 2, 19, 0, 0, tzinfo=timezone.utc)
        with self.session_factory() as session:
            session.add(ResearchRun(run_id="run-ok", status="passed"))
            session.add(
                ResearchCandidate(
                    run_id="run-ok",
                    candidate_id="cand-ok",
                    decision_count=1,
                    trade_count=1,
                    promotion_target="paper",
                )
            )
            session.add(
                ResearchFoldMetrics(
                    candidate_id="cand-ok",
                    fold_name="fold-1",
                    fold_order=1,
                    train_start=now,
                    train_end=now,
                    test_start=now,
                    test_end=now,
                    decision_count=1,
                    trade_count=1,
                    gross_pnl=Decimal("1"),
                    net_pnl=Decimal("1"),
                    max_drawdown=Decimal("0.1"),
                    turnover_ratio=Decimal("0.2"),
                    cost_bps=Decimal("1"),
                    regime_label="neutral",
                )
            )
            session.add(
                ResearchStressMetrics(
                    candidate_id="cand-ok",
                    stress_case="spread",
                    metric_bundle={"ok": True},
                )
            )
            session.add(
                ResearchPromotion(
                    candidate_id="cand-ok",
                    requested_mode="paper",
                    approved_mode="paper",
                    approver="scheduler",
                    approver_role="system",
                    decision_action="promote",
                    decision_rationale="promotion_allowed",
                    evidence_bundle={
                        "fold_metrics_count": 1,
                        "stress_metrics_count": 1,
                    },
                )
            )
            session.commit()

            report = evaluate_evidence_continuity(session, run_limit=5)

        self.assertEqual(report.checked_runs, 1)
        self.assertEqual(report.failed_runs, 0)
        self.assertEqual(report.missing_runs, [])
        self.assertTrue(report.to_payload()["ok"])

    def test_ignores_skipped_runs(self) -> None:
        with self.session_factory() as session:
            session.add(ResearchRun(run_id="run-skipped", status="skipped"))
            session.commit()
            report = evaluate_evidence_continuity(session, run_limit=5)

        self.assertEqual(report.checked_runs, 0)
        self.assertEqual(report.failed_runs, 0)

    def test_blocked_autoresearch_ledgers_fail_without_false_legacy_table_reasons(
        self,
    ) -> None:
        now = datetime(2026, 5, 20, 0, 0, tzinfo=timezone.utc)
        with self.session_factory() as session:
            session.add(
                AutoresearchEpoch(
                    epoch_id="epoch-blocked",
                    status="no_profit_target_candidate",
                    target_net_pnl_per_day=Decimal("500"),
                    paper_run_ids_json=[],
                    snapshot_manifest_json={},
                    runner_config_json={},
                    summary_json={},
                    started_at=now,
                    completed_at=now,
                )
            )
            session.add(
                AutoresearchCandidateSpec(
                    candidate_spec_id="spec-blocked",
                    epoch_id="epoch-blocked",
                    hypothesis_id="H-CONT-01",
                    candidate_kind="sleeve",
                    family_template_id="late_day_continuation_v1",
                    payload_json={"candidate_spec_id": "spec-blocked"},
                    payload_hash="hash-blocked",
                    status="eligible",
                    blockers_json=[],
                )
            )
            session.add(
                AutoresearchProposalScore(
                    epoch_id="epoch-blocked",
                    candidate_spec_id="spec-blocked",
                    model_id="mlx-ranker",
                    backend="mlx",
                    proposal_score=Decimal("12.5"),
                    rank=1,
                    selection_reason="exploitation",
                    feature_hash="feature-hash",
                    payload_json={},
                )
            )
            session.add(
                AutoresearchPortfolioCandidate(
                    portfolio_candidate_id="portfolio-blocked",
                    epoch_id="epoch-blocked",
                    source_candidate_ids_json=["spec-blocked"],
                    target_net_pnl_per_day=Decimal("500"),
                    objective_scorecard_json={
                        "net_pnl_per_day": "9373",
                        "active_day_ratio": "1.0",
                        "positive_day_ratio": "0.50",
                        "best_day_share": "1.0",
                        "max_cluster_contribution_share": "1.0",
                    },
                    optimizer_report_json={"selected_count": 1},
                    payload_json={"portfolio_candidate_id": "portfolio-blocked"},
                    status="blocked",
                )
            )
            session.commit()

            report = evaluate_evidence_continuity(session, run_limit=5)

        self.assertEqual(report.checked_runs, 1)
        self.assertEqual(report.failed_runs, 1)
        missing = set(report.missing_runs[0]["missing_tables"])
        self.assertIn("autoresearch_portfolio_ready", missing)
        self.assertIn("autoresearch_portfolio_candidates_blocked", missing)
        self.assertNotIn("research_candidates", missing)
        self.assertNotIn("research_promotions", missing)
        self.assertEqual(
            report.missing_runs[0]["counts"]["autoresearch_candidate_specs"], 1
        )

    def test_research_run_with_autoresearch_ledgers_reports_autoresearch_blockers(
        self,
    ) -> None:
        now = datetime(2026, 5, 20, 0, 0, tzinfo=timezone.utc)
        with self.session_factory() as session:
            session.add(
                ResearchRun(
                    run_id="run-autoresearch",
                    status="passed",
                    discovery_mode="whitepaper_autoresearch_profit_target",
                )
            )
            session.add(
                AutoresearchEpoch(
                    epoch_id="epoch-run-blocked",
                    status="no_profit_target_candidate",
                    target_net_pnl_per_day=Decimal("500"),
                    paper_run_ids_json=["run-autoresearch"],
                    snapshot_manifest_json={},
                    runner_config_json={},
                    summary_json={},
                    started_at=now,
                    completed_at=now,
                )
            )
            session.add(
                AutoresearchCandidateSpec(
                    candidate_spec_id="spec-run-blocked",
                    epoch_id="epoch-run-blocked",
                    hypothesis_id="H-CONT-01",
                    candidate_kind="sleeve",
                    family_template_id="late_day_continuation_v1",
                    payload_json={"candidate_spec_id": "spec-run-blocked"},
                    payload_hash="hash-run-blocked",
                    status="eligible",
                    blockers_json=[],
                )
            )
            session.add(
                AutoresearchProposalScore(
                    epoch_id="epoch-run-blocked",
                    candidate_spec_id="spec-run-blocked",
                    model_id="mlx-ranker",
                    backend="mlx",
                    proposal_score=Decimal("12.5"),
                    rank=1,
                    selection_reason="exploitation",
                    feature_hash="feature-hash",
                    payload_json={},
                )
            )
            session.add(
                AutoresearchPortfolioCandidate(
                    portfolio_candidate_id="portfolio-run-blocked",
                    epoch_id="epoch-run-blocked",
                    source_candidate_ids_json=["spec-run-blocked"],
                    target_net_pnl_per_day=Decimal("500"),
                    objective_scorecard_json={"net_pnl_per_day": "450"},
                    optimizer_report_json={"selected_count": 1},
                    payload_json={"portfolio_candidate_id": "portfolio-run-blocked"},
                    status="blocked",
                )
            )
            session.commit()

            report = evaluate_evidence_continuity(session, run_limit=5)

        self.assertEqual(report.checked_runs, 1)
        self.assertEqual(report.failed_runs, 1)
        missing = set(report.missing_runs[0]["missing_tables"])
        self.assertIn("autoresearch_portfolio_ready", missing)
        self.assertNotIn("research_candidates", missing)
        self.assertNotIn("research_fold_metrics", missing)
        self.assertNotIn("research_promotions", missing)

    def test_current_oracle_ready_autoresearch_portfolio_passes_without_legacy_rows(
        self,
    ) -> None:
        now = datetime(2026, 5, 20, 0, 0, tzinfo=timezone.utc)
        with self.session_factory() as session:
            session.add(
                AutoresearchEpoch(
                    epoch_id="epoch-ready",
                    status="target_met",
                    target_net_pnl_per_day=Decimal("500"),
                    paper_run_ids_json=[],
                    snapshot_manifest_json={},
                    runner_config_json={},
                    summary_json={},
                    started_at=now,
                    completed_at=now,
                )
            )
            session.add(
                AutoresearchCandidateSpec(
                    candidate_spec_id="spec-ready",
                    epoch_id="epoch-ready",
                    hypothesis_id="H-CONT-01",
                    candidate_kind="sleeve",
                    family_template_id="late_day_continuation_v1",
                    payload_json={"candidate_spec_id": "spec-ready"},
                    payload_hash="hash-ready",
                    status="eligible",
                    blockers_json=[],
                )
            )
            session.add(
                AutoresearchProposalScore(
                    epoch_id="epoch-ready",
                    candidate_spec_id="spec-ready",
                    model_id="mlx-ranker",
                    backend="mlx",
                    proposal_score=Decimal("18.5"),
                    rank=1,
                    selection_reason="exploitation",
                    feature_hash="feature-hash",
                    payload_json={},
                )
            )
            session.add(
                AutoresearchPortfolioCandidate(
                    portfolio_candidate_id="portfolio-ready",
                    epoch_id="epoch-ready",
                    source_candidate_ids_json=["spec-ready"],
                    target_net_pnl_per_day=Decimal("500"),
                    objective_scorecard_json=_passing_autoresearch_scorecard(),
                    optimizer_report_json={"selected_count": 1},
                    payload_json={"portfolio_candidate_id": "portfolio-ready"},
                    status="target_met",
                )
            )
            session.commit()

            report = evaluate_evidence_continuity(session, run_limit=5)

        self.assertEqual(report.checked_runs, 1)
        self.assertEqual(report.failed_runs, 0)
        self.assertEqual(report.missing_runs, [])
        self.assertTrue(report.to_payload()["ok"])

    def test_flags_missing_promotion_audit_bundle(self) -> None:
        now = datetime(2026, 2, 19, 0, 0, tzinfo=timezone.utc)
        with self.session_factory() as session:
            session.add(ResearchRun(run_id="run-audit-missing", status="passed"))
            session.add(
                ResearchCandidate(
                    run_id="run-audit-missing",
                    candidate_id="cand-audit-missing",
                    decision_count=1,
                    trade_count=1,
                    promotion_target="paper",
                )
            )
            session.add(
                ResearchFoldMetrics(
                    candidate_id="cand-audit-missing",
                    fold_name="fold-1",
                    fold_order=1,
                    train_start=now,
                    train_end=now,
                    test_start=now,
                    test_end=now,
                    decision_count=1,
                    trade_count=1,
                    gross_pnl=Decimal("1"),
                    net_pnl=Decimal("1"),
                    max_drawdown=Decimal("0.1"),
                    turnover_ratio=Decimal("0.2"),
                    cost_bps=Decimal("1"),
                    regime_label="neutral",
                )
            )
            session.add(
                ResearchStressMetrics(
                    candidate_id="cand-audit-missing",
                    stress_case="spread",
                    metric_bundle={"ok": True},
                )
            )
            session.add(
                ResearchPromotion(
                    candidate_id="cand-audit-missing",
                    requested_mode="paper",
                    approved_mode="paper",
                    approver="scheduler",
                    approver_role="system",
                )
            )
            session.commit()

            report = evaluate_evidence_continuity(session, run_limit=5)

        self.assertEqual(report.failed_runs, 1)
        self.assertIn(
            "promotion_decision_audit", report.missing_runs[0]["missing_tables"]
        )

    def test_flags_missing_strategy_factory_chain_rows(self) -> None:
        now = datetime(2026, 2, 19, 0, 0, tzinfo=timezone.utc)
        with self.session_factory() as session:
            session.add(
                ResearchRun(
                    run_id="run-strategy-factory-missing",
                    status="passed",
                    discovery_mode="strategy_factory_alpha_v1",
                )
            )
            session.add(
                ResearchCandidate(
                    run_id="run-strategy-factory-missing",
                    candidate_id="cand-strategy-factory-missing",
                    decision_count=1,
                    trade_count=1,
                    promotion_target="paper",
                    candidate_family="tsmom",
                )
            )
            session.add(
                ResearchFoldMetrics(
                    candidate_id="cand-strategy-factory-missing",
                    fold_name="fold-1",
                    fold_order=1,
                    train_start=now,
                    train_end=now,
                    test_start=now,
                    test_end=now,
                    decision_count=1,
                    trade_count=1,
                    gross_pnl=Decimal("1"),
                    net_pnl=Decimal("1"),
                    max_drawdown=Decimal("0.1"),
                    turnover_ratio=Decimal("0.2"),
                    cost_bps=Decimal("1"),
                    regime_label="neutral",
                )
            )
            session.add(
                ResearchStressMetrics(
                    candidate_id="cand-strategy-factory-missing",
                    stress_case="spread",
                    metric_bundle={"ok": True},
                )
            )
            session.add(
                ResearchPromotion(
                    candidate_id="cand-strategy-factory-missing",
                    requested_mode="paper",
                    approved_mode="paper",
                    approver="scheduler",
                    approver_role="system",
                    decision_action="promote",
                    decision_rationale="promotion_allowed",
                    evidence_bundle={
                        "fold_metrics_count": 1,
                        "stress_metrics_count": 1,
                    },
                )
            )
            session.commit()

            report = evaluate_evidence_continuity(session, run_limit=5)

        self.assertEqual(report.failed_runs, 1)
        missing = set(report.missing_runs[0]["missing_tables"])
        self.assertIn("research_attempts", missing)
        self.assertIn("research_validation_tests", missing)
        self.assertIn("research_sequential_trials", missing)
        self.assertIn("research_cost_calibrations", missing)
        self.assertIn("candidate_economic_validity_card", missing)

    def test_passes_with_full_strategy_factory_chain(self) -> None:
        now = datetime(2026, 2, 19, 0, 0, tzinfo=timezone.utc)
        with self.session_factory() as session:
            session.add(
                ResearchRun(
                    run_id="run-strategy-factory-ok",
                    status="passed",
                    discovery_mode="strategy_factory_alpha_v1",
                )
            )
            session.add(
                ResearchCandidate(
                    run_id="run-strategy-factory-ok",
                    candidate_id="cand-strategy-factory-ok",
                    decision_count=1,
                    trade_count=1,
                    promotion_target="paper",
                    candidate_family="tsmom",
                    economic_validity_card={"status": "pass"},
                )
            )
            session.add(
                ResearchFoldMetrics(
                    candidate_id="cand-strategy-factory-ok",
                    fold_name="fold-1",
                    fold_order=1,
                    train_start=now,
                    train_end=now,
                    test_start=now,
                    test_end=now,
                    decision_count=1,
                    trade_count=1,
                    gross_pnl=Decimal("1"),
                    net_pnl=Decimal("1"),
                    max_drawdown=Decimal("0.1"),
                    turnover_ratio=Decimal("0.2"),
                    cost_bps=Decimal("1"),
                    regime_label="neutral",
                )
            )
            session.add(
                ResearchStressMetrics(
                    candidate_id="cand-strategy-factory-ok",
                    stress_case="spread",
                    metric_bundle={"ok": True},
                )
            )
            session.add(
                ResearchAttempt(
                    attempt_id="att-ok-001",
                    run_id="run-strategy-factory-ok",
                    candidate_hash="hash-1",
                    generator_family="tsmom_grid_v1",
                    attempt_stage="offline_search",
                    status="selected",
                )
            )
            session.add(
                ResearchValidationTest(
                    candidate_id="cand-strategy-factory-ok",
                    test_name="formal_validity",
                    status="pass",
                    metric_bundle={"lookahead_safe": True},
                    computed_at=now,
                )
            )
            session.add(
                ResearchSequentialTrial(
                    candidate_id="cand-strategy-factory-ok",
                    trial_stage="paper_canary",
                    account="paper",
                    start_at=now,
                    last_update_at=now,
                    sample_count=20,
                    confidence_sequence_lower=Decimal("0.01"),
                    confidence_sequence_upper=Decimal("0.02"),
                    posterior_edge_mean=Decimal("0.01"),
                    posterior_edge_lower=Decimal("0.005"),
                    status="paper_ready",
                    reason_codes=[],
                )
            )
            session.add(
                ResearchCostCalibration(
                    calibration_id="cal-ok-001",
                    scope_type="candidate_family",
                    scope_id="tsmom",
                    window_start=now,
                    window_end=now,
                    modeled_slippage_bps=Decimal("5"),
                    realized_slippage_bps=Decimal("5"),
                    modeled_shortfall_bps=Decimal("5"),
                    realized_shortfall_bps=Decimal("5"),
                    calibration_error_bundle={"slippage_error_bps": 0},
                    status="calibrated",
                    computed_at=now,
                )
            )
            session.add(
                ResearchPromotion(
                    candidate_id="cand-strategy-factory-ok",
                    requested_mode="paper",
                    approved_mode="paper",
                    approver="scheduler",
                    approver_role="system",
                    decision_action="promote",
                    decision_rationale="promotion_allowed",
                    evidence_bundle={
                        "fold_metrics_count": 1,
                        "stress_metrics_count": 1,
                        "strategy_factory": {"ok": True},
                    },
                )
            )
            session.commit()

            report = evaluate_evidence_continuity(session, run_limit=5)

        self.assertEqual(report.failed_runs, 0)

    def test_requires_candidate_family_scoped_cost_calibration(self) -> None:
        now = datetime(2026, 2, 19, 0, 0, tzinfo=timezone.utc)
        with self.session_factory() as session:
            session.add(
                ResearchRun(
                    run_id="run-strategy-factory-wrong-calibration-scope",
                    status="passed",
                    discovery_mode="strategy_factory_alpha_v1",
                )
            )
            session.add(
                ResearchCandidate(
                    run_id="run-strategy-factory-wrong-calibration-scope",
                    candidate_id="cand-strategy-factory-wrong-calibration-scope",
                    decision_count=1,
                    trade_count=1,
                    promotion_target="paper",
                    candidate_family="tsmom",
                    economic_validity_card={"status": "pass"},
                )
            )
            session.add(
                ResearchFoldMetrics(
                    candidate_id="cand-strategy-factory-wrong-calibration-scope",
                    fold_name="fold-1",
                    fold_order=1,
                    train_start=now,
                    train_end=now,
                    test_start=now,
                    test_end=now,
                    decision_count=1,
                    trade_count=1,
                    gross_pnl=Decimal("1"),
                    net_pnl=Decimal("1"),
                    max_drawdown=Decimal("0.1"),
                    turnover_ratio=Decimal("0.2"),
                    cost_bps=Decimal("1"),
                    regime_label="neutral",
                )
            )
            session.add(
                ResearchStressMetrics(
                    candidate_id="cand-strategy-factory-wrong-calibration-scope",
                    stress_case="spread",
                    metric_bundle={"ok": True},
                )
            )
            session.add(
                ResearchAttempt(
                    attempt_id="att-wrong-scope-001",
                    run_id="run-strategy-factory-wrong-calibration-scope",
                    candidate_hash="hash-1",
                    generator_family="tsmom_grid_v1",
                    attempt_stage="offline_search",
                    status="selected",
                )
            )
            session.add(
                ResearchValidationTest(
                    candidate_id="cand-strategy-factory-wrong-calibration-scope",
                    test_name="formal_validity",
                    status="pass",
                    metric_bundle={"lookahead_safe": True},
                    computed_at=now,
                )
            )
            session.add(
                ResearchSequentialTrial(
                    candidate_id="cand-strategy-factory-wrong-calibration-scope",
                    trial_stage="paper_canary",
                    account="paper",
                    start_at=now,
                    last_update_at=now,
                    sample_count=20,
                    confidence_sequence_lower=Decimal("0.01"),
                    confidence_sequence_upper=Decimal("0.02"),
                    posterior_edge_mean=Decimal("0.01"),
                    posterior_edge_lower=Decimal("0.005"),
                    status="paper_ready",
                    reason_codes=[],
                )
            )
            session.add(
                ResearchCostCalibration(
                    calibration_id="cal-wrong-scope-001",
                    scope_type="strategy",
                    scope_id="tsmom",
                    window_start=now,
                    window_end=now,
                    modeled_slippage_bps=Decimal("5"),
                    realized_slippage_bps=Decimal("5"),
                    modeled_shortfall_bps=Decimal("5"),
                    realized_shortfall_bps=Decimal("5"),
                    calibration_error_bundle={"slippage_error_bps": 0},
                    status="calibrated",
                    computed_at=now,
                )
            )
            session.add(
                ResearchPromotion(
                    candidate_id="cand-strategy-factory-wrong-calibration-scope",
                    requested_mode="paper",
                    approved_mode="paper",
                    approver="scheduler",
                    approver_role="system",
                    decision_action="promote",
                    decision_rationale="promotion_allowed",
                    evidence_bundle={
                        "fold_metrics_count": 1,
                        "stress_metrics_count": 1,
                        "strategy_factory": {"ok": True},
                    },
                )
            )
            session.commit()

            report = evaluate_evidence_continuity(session, run_limit=5)

        self.assertEqual(report.failed_runs, 1)
        missing = set(report.missing_runs[0]["missing_tables"])
        self.assertIn("research_cost_calibrations", missing)

    def test_accepts_legacy_promotion_audit_reason_fields(self) -> None:
        now = datetime(2026, 2, 19, 0, 0, tzinfo=timezone.utc)
        with self.session_factory() as session:
            session.add(ResearchRun(run_id="run-legacy-audit", status="passed"))
            session.add(
                ResearchCandidate(
                    run_id="run-legacy-audit",
                    candidate_id="cand-legacy-audit",
                    decision_count=1,
                    trade_count=1,
                    promotion_target="paper",
                )
            )
            session.add(
                ResearchFoldMetrics(
                    candidate_id="cand-legacy-audit",
                    fold_name="fold-1",
                    fold_order=1,
                    train_start=now,
                    train_end=now,
                    test_start=now,
                    test_end=now,
                    decision_count=1,
                    trade_count=1,
                    gross_pnl=Decimal("1"),
                    net_pnl=Decimal("1"),
                    max_drawdown=Decimal("0.1"),
                    turnover_ratio=Decimal("0.2"),
                    cost_bps=Decimal("1"),
                    regime_label="neutral",
                )
            )
            session.add(
                ResearchStressMetrics(
                    candidate_id="cand-legacy-audit",
                    stress_case="spread",
                    metric_bundle={"ok": True},
                )
            )
            session.add(
                ResearchPromotion(
                    candidate_id="cand-legacy-audit",
                    requested_mode="paper",
                    approved_mode="paper",
                    approver="scheduler",
                    approver_role="system",
                    approve_reason="legacy_promotion_allowed",
                )
            )
            session.commit()

            report = evaluate_evidence_continuity(session, run_limit=5)

        self.assertEqual(report.failed_runs, 0)
