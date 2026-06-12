from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.runtime_window_import.support import *


class TestRuntimeWindowImportPart4(_TestRuntimeWindowImportBase):
    def test_persist_source_backed_paper_window_returns_deterministic_readback(
        self,
    ) -> None:
        buckets = build_observed_runtime_buckets(
            bucket_ranges=[
                (
                    datetime(2026, 6, 1, 13, 30, tzinfo=timezone.utc),
                    datetime(2026, 6, 1, 14, 0, tzinfo=timezone.utc),
                    6,
                )
            ],
            decision_times=[
                datetime(2026, 6, 1, 13, 41, tzinfo=timezone.utc),
                datetime(2026, 6, 1, 13, 45, tzinfo=timezone.utc),
            ],
            execution_times=[
                datetime(2026, 6, 1, 13, 42, tzinfo=timezone.utc),
                datetime(2026, 6, 1, 13, 46, tzinfo=timezone.utc),
            ],
            tca_rows=[
                {
                    "computed_at": datetime(2026, 6, 1, 13, 46, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("1"),
                    "post_cost_expectancy_bps": Decimal("40"),
                    "runtime_ledger_bucket": _runtime_ledger_bucket(
                        ledger_schema_version="torghut.runtime-ledger-bucket.v1",
                        bucket_started_at="2026-06-01T13:41:00+00:00",
                        bucket_ended_at="2026-06-01T13:46:00+00:00",
                        source_window_start="2026-06-01T13:41:00+00:00",
                        source_window_end="2026-06-01T13:46:00+00:00",
                        account_label="TORGHUT_SIM",
                        strategy_id="microbar-cross-sectional-pairs-v1",
                        cost_basis_counts={"broker_reported_commission_and_fees": 2},
                        net_strategy_pnl_after_costs="0.80",
                    ),
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
                run_id="import-hpairs-source-backed-readback",
                candidate_id="cand-hpairs-source-backed",
                hypothesis_id="H-PAIRS-01",
                observed_stage="paper",
                strategy_family="microbar_cross_sectional_pairs",
                source_manifest_ref="config/trading/hypotheses/h-pairs-01.json",
                buckets=buckets,
                runtime_observation_payload={
                    "authoritative": True,
                    "authority_reason": "runtime_ledger_profit_proof",
                    "promotion_authority": "runtime_ledger",
                    "runtime_ledger_profit_proof_present": True,
                    "account_label": "TORGHUT_SIM",
                    "strategy_name": "microbar-cross-sectional-pairs-v1",
                    "source_kind": "runtime_ledger_source_collection_candidate",
                },
            )
            ledger_row = session.execute(
                select(StrategyRuntimeLedgerBucket).where(
                    StrategyRuntimeLedgerBucket.run_id
                    == "import-hpairs-source-backed-readback"
                )
            ).scalar_one()
            ledger_payload = ledger_row.payload_json
            self.assertEqual(ledger_row.hypothesis_id, "H-PAIRS-01")
            self.assertEqual(ledger_row.candidate_id, "cand-hpairs-source-backed")
            self.assertEqual(ledger_row.observed_stage, "paper")
            self.assertEqual(ledger_row.account_label, "TORGHUT_SIM")
            self.assertEqual(
                ledger_row.runtime_strategy_name,
                "microbar-cross-sectional-pairs-v1",
            )
            self.assertEqual(
                ledger_payload["trade_decision_ids"],
                ["decision-buy", "decision-sell"],
            )
            self.assertEqual(
                ledger_payload["execution_ids"],
                ["execution-buy", "execution-sell"],
            )
            self.assertEqual(
                ledger_payload["execution_order_event_ids"],
                ["event-fill-buy", "event-fill-sell"],
            )
            self.assertEqual(
                ledger_payload["source_window_ids"],
                ["source-window-buy", "source-window-sell"],
            )
            self.assertEqual(
                ledger_payload["source_offsets"],
                [
                    {"topic": "alpaca.trade_updates", "partition": 0, "offset": 100},
                    {"topic": "alpaca.trade_updates", "partition": 0, "offset": 101},
                ],
            )
            self.assertEqual(
                ledger_payload["source_materialization"], "execution_order_events"
            )
            self.assertEqual(ledger_payload["blockers"], [])
            session.commit()

        readback = summary["runtime_window_import_readback"]
        self.assertEqual(
            readback["schema_version"], "torghut.runtime-window-import-readback.v1"
        )
        self.assertEqual(readback["metric_window_count"], 1)
        self.assertEqual(readback["promotion_decision_count"], 1)
        self.assertEqual(readback["runtime_ledger_bucket_count"], 1)
        self.assertEqual(readback["evidence_grade_runtime_ledger_bucket_count"], 1)
        self.assertEqual(readback["runtime_ledger_closed_trade_count"], 1)
        self.assertEqual(readback["runtime_ledger_open_position_count"], 0)
        self.assertEqual(readback["runtime_ledger_filled_notional"], "200")
        self.assertEqual(
            readback["runtime_ledger_bucket_refs"],
            [
                "strategy_runtime_ledger_buckets:"
                f"{summary['runtime_materialization_target']['runtime_ledger_bucket_ids'][0]}"
            ],
        )
        self.assertEqual(
            readback["evidence_grade_runtime_ledger_bucket_refs"],
            [
                "strategy_runtime_ledger_buckets:"
                f"{summary['runtime_materialization_target']['evidence_grade_runtime_ledger_bucket_ids'][0]}"
            ],
        )
        self.assertIn("postgres:trade_decisions", readback["source_refs"])
        self.assertIn(
            "runtime_order_feed_execution_source", readback["authority_classes"]
        )
        self.assertIn(
            "event_sourced_runtime_ledger_profit_proof", readback["authority_reasons"]
        )
        self.assertEqual(summary["proof_status"], "ok")
        self.assertEqual(summary["proof_blockers"], [])
        self.assertFalse(summary["promotion_allowed"])
        self.assertIn(
            "paper_stage_evidence_collection_only",
            summary["promotion_blocking_reasons"],
        )
        self.assertEqual(
            summary["runtime_materialization_target"]["readback"], readback
        )

    def test_persist_observed_runtime_windows_uses_notional_weighted_ledger_summary(
        self,
    ) -> None:
        buckets = build_observed_runtime_buckets(
            bucket_ranges=[
                (
                    datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    6,
                ),
                (
                    datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 15, 30, tzinfo=timezone.utc),
                    6,
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
                    "post_cost_expectancy_bps": Decimal("100"),
                    "runtime_ledger_bucket": _runtime_ledger_bucket(
                        filled_notional="100",
                        net_strategy_pnl_after_costs="1",
                        cost_amount="0.01",
                        post_cost_expectancy_bps="100",
                    ),
                    **_runtime_pnl_basis(),
                },
                {
                    "computed_at": datetime(2026, 3, 6, 15, 6, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("1"),
                    "post_cost_expectancy_bps": Decimal("1"),
                    "runtime_ledger_bucket": _runtime_ledger_bucket(
                        filled_notional="10000",
                        net_strategy_pnl_after_costs="1",
                        cost_amount="0.01",
                        post_cost_expectancy_bps="1",
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
                run_id="import-live-weighted",
                candidate_id="cand-weighted",
                hypothesis_id="H-CONT-01",
                observed_stage="live",
                strategy_family="intraday_continuation",
                source_manifest_ref="config/trading/hypotheses/h-cont-01.json",
                buckets=buckets,
                runtime_observation_payload={
                    "dataset_snapshot_ref": "torghut-runtime-window-weighted",
                    "source_kind": "live_runtime_observed",
                },
            )
            session.commit()

            decision = session.execute(select(StrategyPromotionDecision)).scalar_one()

        expected = (Decimal("2") / Decimal("10100")) * Decimal("10000")
        self.assertEqual(summary["avg_post_cost_expectancy_bps"], str(expected))
        self.assertEqual(
            summary["post_cost_expectancy_aggregation"],
            "runtime_ledger_notional_weighted",
        )
        assert decision.payload_json is not None
        self.assertEqual(
            decision.payload_json["avg_post_cost_expectancy_bps"], str(expected)
        )
        self.assertEqual(
            decision.payload_json["runtime_ledger_filled_notional"], "10100"
        )

    def test_persist_observed_runtime_windows_daily_pnl_counts_idle_days(
        self,
    ) -> None:
        buckets = build_observed_runtime_buckets(
            bucket_ranges=[
                (
                    datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    6,
                ),
                (
                    datetime(2026, 3, 9, 13, 30, tzinfo=timezone.utc),
                    datetime(2026, 3, 9, 14, 0, tzinfo=timezone.utc),
                    6,
                ),
            ],
            decision_times=[datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc)],
            execution_times=[datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc)],
            tca_rows=[
                {
                    "computed_at": datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("1"),
                    "post_cost_expectancy_bps": Decimal("600"),
                    "runtime_ledger_bucket": _runtime_ledger_bucket(
                        filled_notional="10000",
                        net_strategy_pnl_after_costs="600",
                        cost_amount="1",
                        post_cost_expectancy_bps="600",
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
                run_id="import-live-daily-dollar-proof",
                candidate_id="cand-daily-proof",
                hypothesis_id="H-CONT-01",
                observed_stage="live",
                strategy_family="intraday_continuation",
                source_manifest_ref="config/trading/hypotheses/h-cont-01.json",
                buckets=buckets,
            )
            session.commit()
            decision = session.execute(select(StrategyPromotionDecision)).scalar_one()
            ledger_bucket = session.execute(
                select(StrategyRuntimeLedgerBucket)
            ).scalar_one()

        self.assertEqual(summary["raw_window_count"], 2)
        self.assertEqual(summary["window_count"], 1)
        self.assertEqual(summary["skipped_zero_activity_window_count"], 1)
        self.assertEqual(summary["runtime_ledger_observed_trading_day_count"], 2)
        self.assertEqual(
            summary["runtime_ledger_net_pnl_by_trading_day"],
            {"2026-03-06": "600", "2026-03-09": "0"},
        )
        self.assertEqual(
            summary["runtime_ledger_mean_daily_net_pnl_after_costs"], "300"
        )
        self.assertEqual(
            summary["runtime_ledger_median_daily_net_pnl_after_costs"], "300"
        )
        self.assertEqual(summary["runtime_ledger_p10_daily_net_pnl_after_costs"], "0")
        self.assertEqual(summary["runtime_ledger_worst_day_net_pnl_after_costs"], "0")
        self.assertEqual(summary["runtime_ledger_avg_daily_filled_notional"], "5000")
        self.assertEqual(
            summary["runtime_ledger_filled_notional_by_trading_day"],
            {"2026-03-06": "10000", "2026-03-09": "0"},
        )
        readback = summary["runtime_ledger_profit_distance_readback"]
        self.assertEqual(readback["required_daily_net_pnl"], "500")
        self.assertEqual(readback["observed_mean_daily_net_pnl"], "300")
        self.assertEqual(readback["missing_to_target"]["daily_net_pnl"], "200")
        self.assertEqual(
            readback["daily_post_cost_distribution"],
            {"2026-03-06": "600", "2026-03-09": "0"},
        )
        self.assertEqual(readback["filled_notional"]["average_daily"], "5000")
        self.assertEqual(readback["source_authority"]["source_backed_bucket_count"], 1)
        assert decision.payload_json is not None
        self.assertEqual(
            decision.payload_json["runtime_ledger_mean_daily_net_pnl_after_costs"],
            "300",
        )
        self.assertEqual(
            decision.payload_json["runtime_ledger_profit_distance_readback"][
                "missing_to_target"
            ]["daily_net_pnl"],
            "200",
        )
        assert ledger_bucket.payload_json is not None
        self.assertEqual(
            ledger_bucket.payload_json["runtime_ledger_daily_summary"][
                "runtime_ledger_observed_trading_day_count"
            ],
            2,
        )

    def test_runtime_ledger_daily_summary_from_observed_buckets_tracks_drawdown(
        self,
    ) -> None:
        self.assertEqual(
            _runtime_ledger_daily_summary_from_observed_buckets([])[
                "runtime_ledger_median_daily_net_pnl_after_costs"
            ],
            "0",
        )
        buckets = build_observed_runtime_buckets(
            bucket_ranges=[
                (
                    datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    1,
                ),
                (
                    datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 15, 30, tzinfo=timezone.utc),
                    1,
                ),
                (
                    datetime(2026, 3, 9, 14, 30, tzinfo=timezone.utc),
                    datetime(2026, 3, 9, 15, 0, tzinfo=timezone.utc),
                    1,
                ),
            ],
            decision_times=[],
            execution_times=[],
            tca_rows=[
                {
                    "computed_at": datetime(2026, 3, 6, 14, 45, tzinfo=timezone.utc),
                    "post_cost_expectancy_basis": "realized_strategy_pnl_after_explicit_costs",
                    "post_cost_promotion_eligible": True,
                    "runtime_ledger_bucket": _runtime_ledger_bucket(
                        net_strategy_pnl_after_costs="100",
                        filled_notional="1000",
                        closed_trade_count=2,
                        account_equity="1000",
                        symbol="AAPL",
                    ),
                },
                {
                    "computed_at": datetime(2026, 3, 6, 15, 15, tzinfo=timezone.utc),
                    "post_cost_expectancy_basis": "realized_strategy_pnl_after_explicit_costs",
                    "post_cost_promotion_eligible": True,
                    "runtime_ledger_bucket": _runtime_ledger_bucket(
                        net_strategy_pnl_after_costs="-130",
                        filled_notional="500",
                        closed_trade_count=1,
                        account_equity="1000",
                        symbol="AAPL",
                    ),
                },
                {
                    "computed_at": datetime(2026, 3, 9, 14, 45, tzinfo=timezone.utc),
                    "post_cost_expectancy_basis": "realized_strategy_pnl_after_explicit_costs",
                    "post_cost_promotion_eligible": True,
                    "runtime_ledger_bucket": _runtime_ledger_bucket(
                        net_strategy_pnl_after_costs="10",
                        filled_notional="100",
                        closed_trade_count=1,
                        account_equity="1000",
                        symbol="AMZN",
                    ),
                },
            ],
            continuity_ok=True,
            drift_ok=True,
            dependency_quorum_decision="allow",
        )

        summary = _runtime_ledger_daily_summary_from_observed_buckets(buckets)

        self.assertEqual(summary["runtime_ledger_observed_trading_day_count"], 2)
        self.assertEqual(
            summary["runtime_ledger_net_pnl_by_trading_day"]["2026-03-06"], "-30"
        )
        self.assertEqual(
            summary["runtime_ledger_mean_daily_net_pnl_after_costs"], "-10"
        )
        self.assertEqual(
            summary["runtime_ledger_median_daily_net_pnl_after_costs"], "-10"
        )
        self.assertEqual(summary["runtime_ledger_p10_daily_net_pnl_after_costs"], "-30")
        self.assertEqual(summary["runtime_ledger_max_intraday_drawdown"], "130")
        self.assertEqual(summary["runtime_ledger_drawdown_pct_equity"], "0.13")
        self.assertEqual(summary["runtime_ledger_max_drawdown_pct_equity"], "0.13")
        self.assertEqual(summary["runtime_ledger_best_day_share"], "1")
        self.assertEqual(summary["runtime_ledger_symbol_concentration_share"], "0.75")
        self.assertEqual(
            summary["runtime_ledger_net_pnl_by_symbol"],
            {"AAPL": "-30", "AMZN": "10"},
        )
        self.assertEqual(
            summary["runtime_ledger_closed_trade_count_by_day"],
            {"2026-03-06": 3, "2026-03-09": 1},
        )

    def test_runtime_ledger_daily_summary_emits_zero_drawdown_pct_with_equity(
        self,
    ) -> None:
        buckets = build_observed_runtime_buckets(
            bucket_ranges=[
                (
                    datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    1,
                ),
            ],
            decision_times=[],
            execution_times=[],
            tca_rows=[
                {
                    "computed_at": datetime(2026, 3, 6, 14, 45, tzinfo=timezone.utc),
                    "post_cost_expectancy_basis": "realized_strategy_pnl_after_explicit_costs",
                    "post_cost_promotion_eligible": True,
                    "runtime_ledger_bucket": _runtime_ledger_bucket(
                        net_strategy_pnl_after_costs="100",
                        filled_notional="1000",
                        closed_trade_count=2,
                        account_equity="1000",
                        symbol="AAPL",
                    ),
                },
            ],
            continuity_ok=True,
            drift_ok=True,
            dependency_quorum_decision="allow",
        )

        summary = _runtime_ledger_daily_summary_from_observed_buckets(buckets)

        self.assertEqual(summary["runtime_ledger_max_intraday_drawdown"], "0")
        self.assertEqual(summary["runtime_ledger_drawdown_pct_equity"], "0")
        self.assertEqual(summary["runtime_ledger_max_drawdown_pct_equity"], "0")
        self.assertEqual(
            summary["runtime_ledger_drawdown_pct_equity_source"], "account_equity"
        )

    def test_persist_observed_runtime_windows_blocks_missing_health_gate_evidence(
        self,
    ) -> None:
        buckets = build_observed_runtime_buckets(
            bucket_ranges=[
                (
                    datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    6,
                )
            ],
            decision_times=[datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc)],
            execution_times=[datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc)],
            tca_rows=[
                {
                    "computed_at": datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("1"),
                    "post_cost_expectancy_bps": Decimal("40"),
                    "runtime_ledger_bucket": _runtime_ledger_bucket(),
                    **_runtime_pnl_basis(),
                }
            ],
            continuity_ok=False,
            drift_ok=False,
            dependency_quorum_decision="missing",
        )

        with self.session_local() as session:
            summary = persist_observed_runtime_windows(
                session=session,
                run_id="import-live-health-gates",
                candidate_id="cand-health-gates",
                hypothesis_id="H-CONT-01",
                observed_stage="live",
                strategy_family="intraday_continuation",
                source_manifest_ref="config/trading/hypotheses/h-cont-01.json",
                buckets=buckets,
                runtime_observation_payload={
                    "dataset_snapshot_ref": "torghut-runtime-window-health-gates",
                    "source_kind": "live_runtime_observed",
                },
            )

        self.assertFalse(summary["promotion_allowed"])
        self.assertIn(
            "evidence_continuity_not_ok",
            summary["promotion_blocking_reasons"],
        )
        self.assertIn("drift_checks_not_ok", summary["promotion_blocking_reasons"])
        self.assertIn(
            "dependency_quorum_not_allow",
            summary["promotion_blocking_reasons"],
        )

    def test_persist_observed_runtime_windows_does_not_promote_bucket_early(
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
                    "runtime_ledger_bucket": _runtime_ledger_bucket(
                        filled_notional="1000",
                        net_strategy_pnl_after_costs="0.8",
                        cost_amount="0.40",
                        post_cost_expectancy_bps="8",
                    ),
                    **_runtime_pnl_basis(),
                },
                {
                    "computed_at": datetime(2026, 3, 6, 15, 6, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("5"),
                    "post_cost_expectancy_bps": Decimal("8"),
                    "runtime_ledger_bucket": _runtime_ledger_bucket(
                        filled_notional="1000",
                        net_strategy_pnl_after_costs="0.8",
                        cost_amount="0.50",
                        post_cost_expectancy_bps="8",
                    ),
                    **_runtime_pnl_basis(),
                },
            ],
            continuity_ok=True,
            drift_ok=True,
            dependency_quorum_decision="allow",
        )

        with self.session_local() as session:
            persist_observed_runtime_windows(
                session=session,
                run_id="import-live-threshold",
                candidate_id="cand-1",
                hypothesis_id="H-CONT-01",
                observed_stage="live",
                strategy_family="intraday_continuation",
                source_manifest_ref="config/trading/hypotheses/h-cont-01.json",
                buckets=buckets,
            )
            session.commit()
            windows = (
                session.execute(
                    select(StrategyHypothesisMetricWindow).order_by(
                        StrategyHypothesisMetricWindow.window_started_at
                    )
                )
                .scalars()
                .all()
            )
            decision = session.execute(select(StrategyPromotionDecision)).scalar_one()

        self.assertEqual(
            [window.capital_stage for window in windows], ["shadow", "shadow"]
        )
        self.assertEqual(decision.allowed, False)
        assert decision.payload_json is not None
        self.assertIn(
            "runtime_ledger_observed_trading_day_count_below_authority_minimum",
            decision.payload_json["promotion_blocking_reasons"],
        )
        self.assertIn(
            "runtime_ledger_mean_daily_net_pnl_after_costs_below_target",
            decision.payload_json["promotion_blocking_reasons"],
        )
        self.assertIn(
            "runtime_ledger_avg_daily_filled_notional_below_target_implied_floor",
            decision.payload_json["promotion_blocking_reasons"],
        )
        self.assertEqual(
            decision.payload_json["runtime_ledger_promotion_gate_targets"][
                "target_implied_avg_daily_filled_notional"
            ],
            "625000",
        )

    def test_runtime_ledger_bucket_blocks_missing_source_authority(self) -> None:
        missing_window = _runtime_ledger_bucket(
            source_window_start=None,
            source_window_end=None,
        )
        self.assertIn(
            "runtime_ledger_source_window_missing",
            _runtime_ledger_bucket_blockers(missing_window),
        )

        missing_refs = _runtime_ledger_bucket(source_refs=[], source_row_counts={})
        self.assertIn(
            "runtime_ledger_source_refs_missing",
            _runtime_ledger_bucket_blockers(missing_refs),
        )

        complete = _runtime_ledger_bucket()
        self.assertNotIn(
            "runtime_ledger_source_window_missing",
            _runtime_ledger_bucket_blockers(complete),
        )
        self.assertNotIn(
            "runtime_ledger_source_refs_missing",
            _runtime_ledger_bucket_blockers(complete),
        )

        missing_source_window_ids = _runtime_ledger_bucket(source_window_ids=[])
        self.assertIn(
            "runtime_ledger_source_window_ids_missing",
            _runtime_ledger_bucket_blockers(missing_source_window_ids),
        )

        missing_trade_decision_ids = _runtime_ledger_bucket(trade_decision_ids=[])
        self.assertIn(
            "runtime_ledger_trade_decision_refs_missing",
            _runtime_ledger_bucket_blockers(missing_trade_decision_ids),
        )

        missing_execution_ids = _runtime_ledger_bucket(execution_ids=[])
        self.assertIn(
            "runtime_ledger_execution_refs_missing",
            _runtime_ledger_bucket_blockers(missing_execution_ids),
        )

        missing_execution_order_event_ids = _runtime_ledger_bucket(
            execution_order_event_ids=[]
        )
        self.assertIn(
            "runtime_ledger_execution_order_event_refs_missing",
            _runtime_ledger_bucket_blockers(missing_execution_order_event_ids),
        )

        missing_source_offsets = _runtime_ledger_bucket(source_offsets=[])
        self.assertIn(
            "runtime_ledger_source_offsets_missing",
            _runtime_ledger_bucket_blockers(missing_source_offsets),
        )

        legacy_ref_aliases = _runtime_ledger_bucket(
            source_window_ids=[],
            source_window_refs=["postgres:order_feed_source_windows:source-window-buy"],
            trade_decision_ids=[],
            trade_decision_refs=["postgres:trade_decisions:decision-buy"],
            execution_ids=[],
            execution_refs=["postgres:executions:execution-buy"],
            execution_order_event_ids=[],
            execution_order_event_refs=[
                "postgres:execution_order_events:event-fill-buy"
            ],
        )
        alias_blockers = _runtime_ledger_bucket_blockers(legacy_ref_aliases)
        self.assertIn("runtime_ledger_source_window_ids_missing", alias_blockers)
        self.assertIn("runtime_ledger_trade_decision_refs_missing", alias_blockers)
        self.assertIn("runtime_ledger_execution_refs_missing", alias_blockers)
        self.assertIn(
            "runtime_ledger_execution_order_event_refs_missing", alias_blockers
        )

    def test_runtime_ledger_bucket_tca_refs_accept_readback_aliases(
        self,
    ) -> None:
        readback_alias_bucket = _runtime_ledger_bucket(
            execution_tca_metric_ids=[],
            runtime_ledger_execution_tca_metric_ids=["tca-buy", "tca-sell"],
        )
        readback_alias_blockers = _runtime_ledger_bucket_blockers(readback_alias_bucket)
        self.assertNotIn("execution_tca_missing", readback_alias_blockers)
        self.assertNotIn(
            "runtime_ledger_execution_tca_refs_missing",
            readback_alias_blockers,
        )

        split_alias_bucket = _runtime_ledger_bucket(
            execution_tca_metric_ids=["tca-buy"],
            runtime_ledger_execution_tca_metric_ids=["tca-sell"],
        )
        split_alias_blockers = _runtime_ledger_bucket_blockers(split_alias_bucket)
        self.assertNotIn("execution_tca_missing", split_alias_blockers)
        self.assertNotIn(
            "runtime_ledger_execution_tca_refs_missing",
            split_alias_blockers,
        )

        mapping_alias_bucket = _runtime_ledger_bucket(
            execution_tca_metric_ids={"id": "tca-buy"},
            runtime_ledger_execution_tca_metric_ids=[{"ref": "tca-sell"}],
        )
        mapping_alias_blockers = _runtime_ledger_bucket_blockers(mapping_alias_bucket)
        self.assertNotIn("execution_tca_missing", mapping_alias_blockers)
        self.assertNotIn(
            "runtime_ledger_execution_tca_refs_missing",
            mapping_alias_blockers,
        )

        missing_ref_bucket = _runtime_ledger_bucket(
            execution_tca_metric_ids={"ignored": "not-a-ref"},
            execution_tca_metric_refs=["tca-buy"],
        )
        missing_ref_blockers = _runtime_ledger_bucket_blockers(missing_ref_bucket)
        self.assertIn("execution_tca_missing", missing_ref_blockers)
        self.assertIn(
            "runtime_ledger_execution_tca_refs_missing",
            missing_ref_blockers,
        )
