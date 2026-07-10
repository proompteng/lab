from __future__ import annotations


from tests.submission_council.support import (
    AutoresearchCandidateSpec,
    AutoresearchPortfolioCandidate,
    Base,
    Decimal,
    StaticPool,
    SubmissionCouncilTestCase,
    _load_profit_promotion_table_counts,
    create_engine,
    sessionmaker,
)


class TestSubmissionCouncilProfitReadinessB(SubmissionCouncilTestCase):
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
                AutoresearchCandidateSpec(
                    candidate_spec_id="spec-2",
                    epoch_id="epoch-current",
                    hypothesis_id="H-PORT-READY",
                    candidate_kind="strategy",
                    family_template_id="portfolio_ready_family",
                    payload_json={},
                    payload_hash="spec-2-hash",
                    status="scored",
                    blockers_json=[],
                )
            )
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
                        "delay_adjusted_depth_latency_grid_ms": ["50", "150", "250"],
                        "delay_adjusted_depth_grid_max_stress_ms": "250",
                        "delay_adjusted_depth_fillable_notional_per_day": "300000",
                        "delay_adjusted_depth_worst_grid_fillable_notional_per_day": "300000",
                        "delay_adjusted_depth_worst_active_day_fillable_notional": "300000",
                        "delay_adjusted_depth_p10_active_day_fillable_notional": "300000",
                        "delay_adjusted_depth_tail_coverage_passed": True,
                        "delay_adjusted_depth_stress_net_pnl_per_day": "525",
                        "delay_adjusted_depth_fill_survival_evidence_present": True,
                        "delay_adjusted_depth_fill_survival_sample_count": 20,
                        "delay_adjusted_depth_fill_survival_rate": "1.00",
                        "queue_position_survival_fill_curve_evidence_present": True,
                        "queue_position_survival_sample_count": 20,
                        "queue_position_survival_fill_rate": "1.00",
                        "queue_position_survival_queue_ratio_p95": "0.25",
                        "queue_position_survival_queue_ahead_depletion_evidence_present": True,
                        "queue_position_survival_queue_ahead_depletion_sample_count": 20,
                        "delay_adjusted_depth_queue_ahead_depletion_evidence_present": True,
                        "delay_adjusted_depth_queue_ahead_depletion_sample_count": 20,
                        "queue_ahead_depletion_evidence_present": True,
                        "queue_ahead_depletion_sample_count": 20,
                        "post_cost_net_pnl_after_queue_position_survival_fill_stress": "525",
                        "double_oos_passed": True,
                        "double_oos_artifact_ref": "s3://proof/current-ready-double-oos.json",
                        "double_oos_independent_window_count": 2,
                        "double_oos_pass_rate": "1.00",
                        "double_oos_net_pnl_per_day": "540",
                        "double_oos_cost_shock_net_pnl_per_day": "515",
                    },
                    optimizer_report_json={"method": "current_optimizer"},
                    payload_json={"portfolio_candidate_id": "portfolio-current-ready"},
                    status="target_met",
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
        self.assertEqual(
            counts["autoresearch_portfolio_ready_refs"],
            [
                "candidate_spec_id:spec-2",
                "hypothesis_id:H-PORT-READY",
                "portfolio_candidate_id:portfolio-current-ready",
                "source_candidate_id:spec-2",
            ],
        )
