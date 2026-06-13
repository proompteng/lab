from __future__ import annotations

from tests.runtime_window_import.support import (
    Decimal,
    StrategyHypothesisMetricWindow,
    StrategyPromotionDecision,
    _runtime_ledger_bucket,
    runtime_ledger_bucket_blockers,
    _runtime_pnl_basis,
    _simulation_report_pnl_basis,
    _TestRuntimeWindowImportBase,
    build_observed_runtime_buckets,
    datetime,
    persist_observed_runtime_windows,
    select,
    timedelta,
    timezone,
)


class TestRuntimeWindowPromotionQuality(_TestRuntimeWindowImportBase):
    def test_runtime_ledger_bucket_requires_structured_source_offsets(self) -> None:
        for malformed_offsets in (
            ["alpaca.trade_updates:0:100"],
            [{"topic": "alpaca.trade_updates", "offset": 100}],
            [{"topic": "alpaca.trade_updates", "partition": 0}],
            {"topic": "alpaca.trade_updates", "offset": 100},
        ):
            bucket = _runtime_ledger_bucket(source_offsets=malformed_offsets)
            self.assertIn(
                "runtime_ledger_source_offsets_missing",
                runtime_ledger_bucket_blockers(bucket),
            )

    def test_runtime_ledger_bucket_requires_explicit_source_authority_class(
        self,
    ) -> None:
        bucket = _runtime_ledger_bucket(
            authority_class=None,
            authority_reason=None,
            pnl_derivation="execution_order_events_runtime_ledger",
        )

        self.assertIn(
            "runtime_ledger_authority_class_missing",
            runtime_ledger_bucket_blockers(bucket),
        )
        for marker_field in ("authority_class", "authority_reason"):
            marker_only = _runtime_ledger_bucket(**{marker_field: None})
            self.assertIn(
                "runtime_ledger_authority_class_missing",
                runtime_ledger_bucket_blockers(marker_only),
            )

    def test_runtime_ledger_bucket_requires_explicit_cost_basis_and_amount(
        self,
    ) -> None:
        for bucket in (
            _runtime_ledger_bucket(cost_amount=None),
            _runtime_ledger_bucket(cost_basis_counts={}, cost_basis=None),
            _runtime_ledger_bucket(
                cost_basis_counts={"modeled_paper_cost_budget": 2},
                cost_basis=None,
            ),
            _runtime_ledger_bucket(cost_basis="modeled_paper_cost_budget"),
            _runtime_ledger_bucket(
                cost_basis_counts={"broker_reported_commission_and_fees": "bad"},
                cost_basis=None,
            ),
        ):
            self.assertIn(
                "runtime_ledger_explicit_costs_missing",
                runtime_ledger_bucket_blockers(bucket),
            )

        blockers = runtime_ledger_bucket_blockers(
            _runtime_ledger_bucket(
                cost_basis_counts={},
                post_cost_basis_counts={"broker_reported_commission_and_fees": 2},
                cost_basis=None,
            )
        )
        self.assertNotIn("runtime_ledger_explicit_costs_missing", blockers)

    def test_persist_observed_runtime_windows_allows_authority_grade_live_ledger(
        self,
    ) -> None:
        base_start = datetime(2026, 3, 2, 14, 30, tzinfo=timezone.utc)
        bucket_ranges = []
        tca_rows = []
        decision_times = []
        execution_times = []
        for day_index in range(20):
            window_start = base_start + timedelta(days=day_index)
            window_end = window_start + timedelta(minutes=30)
            computed_at = window_start + timedelta(minutes=5)
            bucket_ranges.append((window_start, window_end, 40))
            decision_times.append(computed_at)
            execution_times.append(computed_at + timedelta(minutes=1))
            tca_rows.append(
                {
                    "computed_at": computed_at,
                    "abs_slippage_bps": Decimal("1"),
                    "post_cost_expectancy_bps": Decimal("600"),
                    "runtime_ledger_bucket": _runtime_ledger_bucket(
                        filled_notional="10000",
                        gross_strategy_pnl="601",
                        cost_amount="1",
                        net_strategy_pnl_after_costs="600",
                        post_cost_expectancy_bps="600",
                    ),
                    **_runtime_pnl_basis(),
                }
            )
        buckets = build_observed_runtime_buckets(
            bucket_ranges=bucket_ranges,
            decision_times=decision_times,
            execution_times=execution_times,
            tca_rows=tca_rows,
            continuity_ok=True,
            drift_ok=True,
            dependency_quorum_decision="allow",
        )

        with self.session_local() as session:
            summary = persist_observed_runtime_windows(
                session=session,
                run_id="import-live-authority-grade",
                candidate_id="cand-authority-grade",
                hypothesis_id="H-CONT-01",
                observed_stage="live",
                strategy_family="intraday_continuation",
                source_manifest_ref="config/trading/hypotheses/h-cont-01.json",
                buckets=buckets,
            )
            session.commit()
            decision = session.execute(select(StrategyPromotionDecision)).scalar_one()

        self.assertEqual(summary["promotion_allowed"], True)
        self.assertEqual(summary["runtime_ledger_observed_trading_day_count"], 20)
        self.assertEqual(
            summary["runtime_ledger_mean_daily_net_pnl_after_costs"], "600"
        )
        self.assertEqual(
            summary["runtime_ledger_median_daily_net_pnl_after_costs"], "600"
        )
        self.assertEqual(summary["runtime_ledger_p10_daily_net_pnl_after_costs"], "600")
        self.assertEqual(summary["runtime_ledger_worst_day_net_pnl_after_costs"], "600")
        self.assertEqual(summary["runtime_ledger_best_day_share"], "0.05")
        self.assertEqual(summary["runtime_ledger_avg_daily_filled_notional"], "10000")
        self.assertEqual(
            summary["runtime_ledger_promotion_gate_targets"][
                "target_implied_avg_daily_filled_notional"
            ],
            "8333.333333333333333333333333",
        )
        self.assertEqual(decision.allowed, True)
        self.assertEqual(
            decision.reason_summary, "runtime_evidence_thresholds_satisfied"
        )

    def test_persist_observed_runtime_windows_blocks_live_simulation_report_pnl(
        self,
    ) -> None:
        buckets = build_observed_runtime_buckets(
            bucket_ranges=[
                (
                    datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    40,
                ),
                (
                    datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 15, 30, tzinfo=timezone.utc),
                    40,
                ),
            ],
            decision_times=[
                datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                datetime(2026, 3, 6, 15, 5, tzinfo=timezone.utc),
            ],
            execution_times=[
                datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                datetime(2026, 3, 6, 15, 6, tzinfo=timezone.utc),
            ],
            tca_rows=[
                {
                    "computed_at": datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("4"),
                    "post_cost_expectancy_bps": Decimal("8"),
                    **_simulation_report_pnl_basis(),
                },
                {
                    "computed_at": datetime(2026, 3, 6, 15, 6, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("5"),
                    "post_cost_expectancy_bps": Decimal("8"),
                    **_simulation_report_pnl_basis(),
                },
            ],
            continuity_ok=True,
            drift_ok=True,
            dependency_quorum_decision="allow",
        )

        with self.session_local() as session:
            summary = persist_observed_runtime_windows(
                session=session,
                run_id="import-live-simulation-report-pnl",
                candidate_id="cand-sim-report",
                hypothesis_id="H-CONT-01",
                observed_stage="live",
                strategy_family="intraday_continuation",
                source_manifest_ref="config/trading/hypotheses/h-cont-01.json",
                buckets=buckets,
            )

        self.assertEqual(summary["promotion_allowed"], False)
        self.assertEqual(
            summary["post_cost_basis_counts"], {"simulation_report_net_pnl": 2}
        )
        self.assertIn(
            "runtime_ledger_pnl_basis_missing",
            summary["promotion_blocking_reasons"],
        )

    def test_persist_observed_runtime_windows_blocks_tca_shortfall_expectancy(
        self,
    ) -> None:
        buckets = build_observed_runtime_buckets(
            bucket_ranges=[
                (
                    datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    40,
                ),
                (
                    datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 15, 30, tzinfo=timezone.utc),
                    40,
                ),
            ],
            decision_times=[
                datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                datetime(2026, 3, 6, 15, 5, tzinfo=timezone.utc),
            ],
            execution_times=[
                datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                datetime(2026, 3, 6, 15, 6, tzinfo=timezone.utc),
            ],
            tca_rows=[
                {
                    "computed_at": datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("4"),
                    "post_cost_expectancy_bps": Decimal("80"),
                    "post_cost_expectancy_basis": "broker_tca_shortfall_estimate",
                    "post_cost_promotion_eligible": False,
                },
                {
                    "computed_at": datetime(2026, 3, 6, 15, 6, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("5"),
                    "post_cost_expectancy_bps": Decimal("80"),
                    "post_cost_expectancy_basis": "broker_tca_shortfall_estimate",
                    "post_cost_promotion_eligible": False,
                },
            ],
            continuity_ok=True,
            drift_ok=True,
            dependency_quorum_decision="allow",
        )

        with self.session_local() as session:
            summary = persist_observed_runtime_windows(
                session=session,
                run_id="import-live-tca-shortfall",
                candidate_id="cand-tca-shortfall",
                hypothesis_id="H-CONT-01",
                observed_stage="live",
                strategy_family="intraday_continuation",
                source_manifest_ref="config/trading/hypotheses/h-cont-01.json",
                buckets=buckets,
            )
            session.commit()
            decision = session.execute(select(StrategyPromotionDecision)).scalar_one()

        self.assertEqual(summary["promotion_allowed"], False)
        self.assertEqual(summary["post_cost_promotion_sample_count"], 0)
        self.assertEqual(
            summary["post_cost_basis_counts"],
            {"broker_tca_shortfall_estimate": 2},
        )
        self.assertIn(
            "post_cost_pnl_basis_missing",
            summary["promotion_blocking_reasons"],
        )
        self.assertIn(
            "post_cost_expectancy_non_positive",
            summary["promotion_blocking_reasons"],
        )
        self.assertEqual(decision.allowed, False)

    def test_persist_observed_runtime_windows_blocks_paper_without_runtime_ledger_pnl(
        self,
    ) -> None:
        buckets = build_observed_runtime_buckets(
            bucket_ranges=[
                (
                    datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    40,
                ),
                (
                    datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 15, 30, tzinfo=timezone.utc),
                    40,
                ),
            ],
            decision_times=[
                datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                datetime(2026, 3, 6, 15, 5, tzinfo=timezone.utc),
            ],
            execution_times=[
                datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                datetime(2026, 3, 6, 15, 6, tzinfo=timezone.utc),
            ],
            tca_rows=[
                {
                    "computed_at": datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("1"),
                    "post_cost_expectancy_bps": Decimal("80"),
                    **_runtime_pnl_basis(),
                },
                {
                    "computed_at": datetime(2026, 3, 6, 15, 6, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("1"),
                    "post_cost_expectancy_bps": Decimal("80"),
                    **_runtime_pnl_basis(),
                },
            ],
            continuity_ok=True,
            drift_ok=True,
            dependency_quorum_decision="allow",
        )

        with self.session_local() as session:
            summary = persist_observed_runtime_windows(
                session=session,
                run_id="import-paper-no-runtime-ledger-pnl",
                candidate_id="cand-paper-no-runtime-ledger",
                hypothesis_id="H-CONT-01",
                observed_stage="paper",
                strategy_family="intraday_continuation",
                source_manifest_ref="config/trading/hypotheses/h-cont-01.json",
                buckets=buckets,
            )
            session.commit()
            decision = session.execute(select(StrategyPromotionDecision)).scalar_one()

        self.assertEqual(summary["promotion_allowed"], False)
        self.assertEqual(summary["post_cost_promotion_sample_count"], 0)
        self.assertEqual(summary["avg_post_cost_expectancy_bps"], "0")
        self.assertEqual(
            summary["post_cost_expectancy_aggregation"],
            "no_runtime_ledger_post_cost_rows",
        )
        self.assertIn(
            "runtime_ledger_pnl_basis_missing",
            summary["promotion_blocking_reasons"],
        )
        self.assertEqual(decision.allowed, False)

    def test_build_observed_runtime_buckets_cannot_upgrade_tca_basis_to_promotion_grade(
        self,
    ) -> None:
        buckets = build_observed_runtime_buckets(
            bucket_ranges=[
                (
                    datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    40,
                )
            ],
            decision_times=[datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc)],
            execution_times=[datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc)],
            tca_rows=[
                {
                    "computed_at": datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("4"),
                    "post_cost_expectancy_bps": Decimal("80"),
                    "post_cost_expectancy_basis": "broker_tca_shortfall_estimate",
                    "post_cost_promotion_eligible": True,
                }
            ],
            continuity_ok=True,
            drift_ok=True,
            dependency_quorum_decision="allow",
        )

        self.assertEqual(buckets[0].post_cost_promotion_sample_count, 0)
        self.assertEqual(buckets[0].post_cost_expectancy_bps, Decimal("0"))
        self.assertEqual(
            buckets[0].post_cost_basis_counts,
            {"broker_tca_shortfall_estimate": 1},
        )

    def test_persist_observed_runtime_windows_skips_idle_buckets(self) -> None:
        buckets = build_observed_runtime_buckets(
            bucket_ranges=[
                (
                    datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    40,
                ),
                (
                    datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 15, 30, tzinfo=timezone.utc),
                    40,
                ),
            ],
            decision_times=[datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc)],
            execution_times=[datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc)],
            tca_rows=[
                {
                    "computed_at": datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("4"),
                    "post_cost_expectancy_bps": Decimal("8"),
                    **_runtime_pnl_basis(),
                }
            ],
            continuity_ok=True,
            drift_ok=True,
            dependency_quorum_decision="allow",
        )

        with self.session_local() as session:
            summary = persist_observed_runtime_windows(
                session=session,
                run_id="import-live-skip-idle",
                candidate_id="cand-1",
                hypothesis_id="H-CONT-01",
                observed_stage="live",
                strategy_family="intraday_continuation",
                source_manifest_ref="config/trading/hypotheses/h-cont-01.json",
                buckets=buckets,
            )
            session.commit()
            windows = (
                session.execute(select(StrategyHypothesisMetricWindow)).scalars().all()
            )
            decision = session.execute(select(StrategyPromotionDecision)).scalar_one()

        self.assertEqual(summary["raw_window_count"], 2)
        self.assertEqual(summary["window_count"], 1)
        self.assertEqual(summary["skipped_zero_activity_window_count"], 1)
        self.assertEqual(summary["market_session_samples"], 40)
        self.assertEqual(len(windows), 1)
        self.assertEqual(windows[0].decision_count, 1)
        self.assertEqual(decision.payload_json["raw_window_count"], 2)
        self.assertEqual(decision.payload_json["skipped_zero_activity_window_count"], 1)

    def test_persist_observed_runtime_windows_blocks_h_micro_without_delay_depth_stress(
        self,
    ) -> None:
        buckets = build_observed_runtime_buckets(
            bucket_ranges=[
                (
                    datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    30,
                ),
                (
                    datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 15, 30, tzinfo=timezone.utc),
                    30,
                ),
            ],
            decision_times=[
                datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                datetime(2026, 3, 6, 15, 5, tzinfo=timezone.utc),
            ],
            execution_times=[
                datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                datetime(2026, 3, 6, 15, 6, tzinfo=timezone.utc),
            ],
            tca_rows=[
                {
                    "computed_at": datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("4"),
                    "post_cost_expectancy_bps": Decimal("12"),
                    "runtime_ledger_bucket": _runtime_ledger_bucket(
                        filled_notional="1000",
                        gross_strategy_pnl="1.4",
                        cost_amount="0.2",
                        net_strategy_pnl_after_costs="1.2",
                        post_cost_expectancy_bps="12",
                    ),
                    **_runtime_pnl_basis(),
                },
                {
                    "computed_at": datetime(2026, 3, 6, 15, 6, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("5"),
                    "post_cost_expectancy_bps": Decimal("12"),
                    "runtime_ledger_bucket": _runtime_ledger_bucket(
                        filled_notional="1000",
                        gross_strategy_pnl="1.4",
                        cost_amount="0.2",
                        net_strategy_pnl_after_costs="1.2",
                        post_cost_expectancy_bps="12",
                    ),
                    **_runtime_pnl_basis(),
                },
            ],
            continuity_ok=True,
            drift_ok=True,
            dependency_quorum_decision="allow",
        )

        with self.session_local() as session:
            summary = persist_observed_runtime_windows(
                session=session,
                run_id="import-h-micro-no-depth",
                candidate_id="chip-paper-microbar-composite@execution-proof",
                hypothesis_id="H-MICRO-01",
                observed_stage="paper",
                strategy_family="microstructure_breakout",
                source_manifest_ref="config/trading/hypotheses/h-micro-01.json",
                buckets=buckets,
            )
            session.commit()
            decision = session.execute(select(StrategyPromotionDecision)).scalar_one()

        self.assertEqual(summary["promotion_allowed"], False)
        self.assertIn(
            "delay_adjusted_depth_stress_missing",
            summary["promotion_blocking_reasons"],
        )
        self.assertEqual(decision.allowed, False)

    def test_persist_observed_runtime_windows_keeps_paper_depth_evidence_only(
        self,
    ) -> None:
        buckets = build_observed_runtime_buckets(
            bucket_ranges=[
                (
                    datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    30,
                ),
                (
                    datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 15, 30, tzinfo=timezone.utc),
                    30,
                ),
            ],
            decision_times=[
                datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                datetime(2026, 3, 6, 15, 5, tzinfo=timezone.utc),
            ],
            execution_times=[
                datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                datetime(2026, 3, 6, 15, 6, tzinfo=timezone.utc),
            ],
            tca_rows=[
                {
                    "computed_at": datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("4"),
                    "post_cost_expectancy_bps": Decimal("12"),
                    "runtime_ledger_bucket": _runtime_ledger_bucket(
                        filled_notional="1000",
                        gross_strategy_pnl="1.4",
                        cost_amount="0.2",
                        net_strategy_pnl_after_costs="1.2",
                        post_cost_expectancy_bps="12",
                    ),
                    **_runtime_pnl_basis(),
                },
                {
                    "computed_at": datetime(2026, 3, 6, 15, 6, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("5"),
                    "post_cost_expectancy_bps": Decimal("12"),
                    "runtime_ledger_bucket": _runtime_ledger_bucket(
                        filled_notional="1000",
                        gross_strategy_pnl="1.4",
                        cost_amount="0.2",
                        net_strategy_pnl_after_costs="1.2",
                        post_cost_expectancy_bps="12",
                    ),
                    **_runtime_pnl_basis(),
                },
            ],
            continuity_ok=True,
            drift_ok=True,
            dependency_quorum_decision="allow",
        )

        with self.session_local() as session:
            summary = persist_observed_runtime_windows(
                session=session,
                run_id="import-h-micro-depth",
                candidate_id="chip-paper-microbar-composite@execution-proof",
                hypothesis_id="H-MICRO-01",
                observed_stage="paper",
                strategy_family="microstructure_breakout",
                source_manifest_ref="config/trading/hypotheses/h-micro-01.json",
                buckets=buckets,
                runtime_observation_payload={
                    "delay_adjusted_depth_stress_report": {
                        "passed": True,
                        "case_count": 1,
                        "generated_at": "2026-03-06T15:20:00+00:00",
                        "artifact_ref": "proof/h-micro-delay-depth.json",
                        "latency_grid_ms": [50, 150, 250],
                        "grid_max_stress_ms": 250,
                        "worst_grid_fillable_notional_per_day": "450000",
                        "worst_active_day_fillable_notional": "350000",
                        "p10_active_day_fillable_notional": "325000",
                        "tail_coverage_passed": True,
                        "fillable_ratio": "0.90",
                        "survival_adjusted_fillable_ratio": "0.81",
                        "unfillable_notional_per_day": "50000",
                        "stress_net_pnl_per_day": "620",
                        "fill_survival_evidence_present": True,
                        "fill_survival_sample_count": 44,
                        "fill_survival_rate": "0.90",
                        "queue_ratio_p95": "0.12",
                        "queue_ahead_depletion_evidence_present": True,
                        "queue_ahead_depletion_sample_count": 44,
                    }
                },
            )
            session.commit()
            decision = session.execute(select(StrategyPromotionDecision)).scalar_one()

        self.assertEqual(summary["promotion_allowed"], False)
        self.assertIn(
            "paper_stage_evidence_collection_only",
            summary["promotion_blocking_reasons"],
        )
        self.assertIn(
            "runtime_ledger_observed_trading_day_count_below_authority_minimum",
            summary["promotion_blocking_reasons"],
        )
        self.assertNotIn(
            "delay_adjusted_depth_stress_missing",
            summary["promotion_blocking_reasons"],
        )
        self.assertEqual(summary["proof_status"], "ok")
        proof_blockers = {item["blocker"] for item in summary["proof_blockers"]}
        self.assertNotIn("paper_stage_evidence_collection_only", proof_blockers)
        self.assertNotIn(
            "runtime_ledger_mean_daily_net_pnl_after_costs_below_target",
            proof_blockers,
        )
        self.assertEqual(
            summary["runtime_materialization_target"]["proof_status"], "ok"
        )
        self.assertTrue(summary["runtime_materialization_target"]["materialized"])
        self.assertEqual(
            summary["delay_adjusted_depth_stress"],
            {
                "checks_total": 1,
                "passed": True,
                "checked_at": "2026-03-06T15:20:00+00:00",
                "artifact_ref": "proof/h-micro-delay-depth.json",
                "latency_grid_ms": ["50", "150", "250"],
                "grid_max_stress_ms": "250",
                "worst_grid_fillable_notional_per_day": "450000",
                "worst_active_day_fillable_notional": "350000",
                "p10_active_day_fillable_notional": "325000",
                "tail_coverage_passed": True,
                "fillable_ratio": "0.90",
                "survival_adjusted_fillable_ratio": "0.81",
                "unfillable_notional_per_day": "50000",
                "stress_net_pnl_per_day": "620",
                "fill_survival_evidence_present": True,
                "fill_survival_sample_count": 44,
                "fill_survival_rate": "0.90",
                "queue_ratio_p95": "0.12",
                "queue_ahead_depletion_evidence_present": True,
                "queue_ahead_depletion_sample_count": 44,
            },
        )
        self.assertEqual(decision.allowed, False)
        self.assertEqual(
            decision.payload_json["delay_adjusted_depth_stress"],
            summary["delay_adjusted_depth_stress"],
        )
