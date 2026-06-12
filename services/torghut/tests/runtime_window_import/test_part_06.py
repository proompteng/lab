from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.runtime_window_import.support import *


class TestRuntimeWindowImportPart6(_TestRuntimeWindowImportBase):
    def test_persist_observed_runtime_windows_keeps_paper_probation_evidence_only(
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
                    **_runtime_pnl_basis(),
                },
                {
                    "computed_at": datetime(2026, 3, 6, 15, 6, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("5"),
                    "post_cost_expectancy_bps": Decimal("12"),
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
                run_id="import-h-micro-paper-probation",
                candidate_id="cand-paper-probation",
                hypothesis_id="H-MICRO-01",
                observed_stage="paper",
                strategy_family="microstructure_breakout",
                source_manifest_ref="config/trading/hypotheses/h-micro-01.json",
                buckets=buckets,
                runtime_observation_payload={
                    "runtime_ledger_target_metadata_blockers": [
                        "runtime_ledger_artifact_refs_mismatch"
                    ],
                    "target_metadata": {
                        "paper_probation_authorized": True,
                        "evidence_collection_stage": "paper",
                        "promotion_allowed": False,
                        "final_promotion_authorized": False,
                        "final_promotion_allowed": False,
                    },
                    "delay_adjusted_depth_stress_report": {
                        "passed": True,
                        "case_count": 1,
                        "generated_at": "2026-03-06T15:20:00+00:00",
                        "artifact_ref": "proof/h-micro-delay-depth.json",
                        "worst_grid_fillable_notional_per_day": "450000",
                        "worst_active_day_fillable_notional": "350000",
                        "p10_active_day_fillable_notional": "325000",
                        "tail_coverage_passed": True,
                        "stress_net_pnl_per_day": "620",
                        "fill_survival_evidence_present": True,
                        "fill_survival_sample_count": 44,
                    },
                },
            )
            session.commit()
            decision = session.execute(select(StrategyPromotionDecision)).scalar_one()

        self.assertEqual(summary["promotion_allowed"], False)
        self.assertIn(
            "paper_probation_evidence_collection_only",
            summary["promotion_blocking_reasons"],
        )
        self.assertIn(
            "runtime_ledger_artifact_refs_mismatch",
            summary["promotion_blocking_reasons"],
        )
        self.assertIn(
            "final_promotion_not_authorized",
            summary["promotion_blocking_reasons"],
        )
        self.assertEqual(decision.allowed, False)
        self.assertEqual(
            decision.payload_json["runtime_observation"]["target_metadata"][
                "paper_probation_authorized"
            ],
            True,
        )

    def test_persist_observed_runtime_windows_clears_import_pending_after_ledger_proof(
        self,
    ) -> None:
        buckets = build_observed_runtime_buckets(
            bucket_ranges=[
                (
                    datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    30,
                ),
            ],
            decision_times=[],
            execution_times=[],
            tca_rows=[
                {
                    "computed_at": datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("4"),
                    "post_cost_expectancy_bps": Decimal("40"),
                    **_runtime_pnl_basis(),
                    "runtime_ledger_bucket": _runtime_ledger_bucket(),
                },
            ],
            continuity_ok=True,
            drift_ok=True,
            dependency_quorum_decision="allow",
        )

        with self.session_local() as session:
            summary = persist_observed_runtime_windows(
                session=session,
                run_id="import-source-ledger-paper-route",
                candidate_id="cand-paper-route",
                hypothesis_id="H-PAIRS-01",
                observed_stage="paper",
                strategy_family="microbar_cross_sectional_pairs",
                source_manifest_ref="config/trading/hypotheses/h-pairs-01.json",
                buckets=buckets,
                runtime_observation_payload={
                    "runtime_ledger_profit_proof_present": True,
                    "runtime_ledger_target_metadata_blockers": [
                        "paper_route_runtime_ledger_import_pending",
                        "live_runtime_ledger_required",
                    ],
                    "target_metadata": {
                        "paper_probation_authorized": True,
                        "evidence_collection_stage": "paper",
                        "runtime_ledger_target_metadata_blockers": [
                            "paper_route_runtime_ledger_import_pending"
                        ],
                        "promotion_allowed": False,
                        "final_promotion_authorized": False,
                    },
                },
            )
            session.commit()

        self.assertNotIn(
            "paper_route_runtime_ledger_import_pending",
            summary["promotion_blocking_reasons"],
        )
        self.assertIn(
            "live_runtime_ledger_required",
            summary["promotion_blocking_reasons"],
        )
        self.assertIn(
            "paper_probation_evidence_collection_only",
            summary["promotion_blocking_reasons"],
        )
        target = summary["runtime_materialization_target"]
        self.assertEqual(target["candidate_id"], "cand-paper-route")
        self.assertEqual(target["hypothesis_id"], "H-PAIRS-01")
        self.assertTrue(target["runtime_ledger_profit_proof_present"])
        self.assertEqual(target["runtime_ledger_notional_weighted_sample_count"], 1)
        self.assertEqual(target["runtime_ledger_filled_notional"], "200")
        self.assertEqual(
            target["runtime_ledger_net_strategy_pnl_after_costs"],
            "0.80",
        )
        self.assertEqual(target["metric_window_count"], 1)
        self.assertEqual(target["promotion_decision_count"], 1)
        self.assertEqual(target["runtime_ledger_bucket_count"], 1)
        self.assertEqual(target["evidence_grade_runtime_ledger_bucket_count"], 1)
        self.assertEqual(target["runtime_ledger_fill_count"], 2)
        self.assertEqual(target["runtime_ledger_submitted_order_count"], 2)
        self.assertEqual(target["runtime_ledger_closed_trade_count"], 1)
        self.assertEqual(target["runtime_ledger_open_position_count"], 0)
        self.assertEqual(target["materialization_blockers"], [])
        self.assertEqual(target["proof_status"], "ok")
        self.assertEqual(target["proof_blockers"], [])
        self.assertEqual(target["evidence_blocking_reasons"], [])
        self.assertFalse(target["capital_promotion_allowed"])
        self.assertIn(
            "live_runtime_ledger_required",
            target["capital_promotion_blocking_reasons"],
        )
        self.assertIn(
            "paper_probation_evidence_collection_only",
            target["capital_promotion_blocking_reasons"],
        )
        self.assertEqual(len(target["metric_window_ids"]), 1)
        self.assertIsNotNone(target["promotion_decision_id"])
        self.assertEqual(len(target["runtime_ledger_bucket_ids"]), 1)
        self.assertEqual(len(target["evidence_grade_runtime_ledger_bucket_ids"]), 1)
        self.assertTrue(target["materialized"])
        self.assertFalse(summary["promotion_allowed"])
        self.assertIn(
            "live_runtime_ledger_required",
            summary["promotion_blocking_reasons"],
        )
        self.assertEqual(summary["proof_status"], "ok")
        self.assertEqual(summary["proof_blockers"], [])

    def test_persist_observed_runtime_windows_blocks_claimed_ledger_proof_without_rows(
        self,
    ) -> None:
        buckets = build_observed_runtime_buckets(
            bucket_ranges=[
                (
                    datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    30,
                ),
            ],
            decision_times=[datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc)],
            execution_times=[datetime(2026, 3, 6, 14, 37, tzinfo=timezone.utc)],
            tca_rows=[
                {
                    "computed_at": datetime(2026, 3, 6, 14, 38, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("4"),
                    "post_cost_expectancy_bps": Decimal("40"),
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
                run_id="import-claimed-ledger-proof-without-rows",
                candidate_id="cand-claimed-ledger",
                hypothesis_id="H-PAIRS-01",
                observed_stage="paper",
                strategy_family="microbar_cross_sectional_pairs",
                source_manifest_ref="config/trading/hypotheses/h-pairs-01.json",
                buckets=buckets,
                runtime_observation_payload={
                    "runtime_ledger_profit_proof_present": True,
                    "promotion_authority": "runtime_ledger",
                },
            )
            session.commit()

        target = summary["runtime_materialization_target"]
        self.assertEqual(target["metric_window_count"], 1)
        self.assertEqual(target["promotion_decision_count"], 1)
        self.assertEqual(target["runtime_ledger_bucket_count"], 0)
        self.assertEqual(target["evidence_grade_runtime_ledger_bucket_count"], 0)
        self.assertEqual(target["readback"]["runtime_ledger_bucket_count"], 0)
        self.assertEqual(
            target["readback"]["evidence_grade_runtime_ledger_bucket_count"], 0
        )
        self.assertIn(
            "runtime_window_import_runtime_ledger_bucket_missing",
            target["materialization_blockers"],
        )
        self.assertIn(
            "runtime_window_import_evidence_grade_runtime_ledger_bucket_missing",
            target["materialization_blockers"],
        )
        self.assertIn(
            "runtime_window_import_runtime_ledger_bucket_missing",
            [item["blocker"] for item in target["proof_blockers"]],
        )
        self.assertFalse(target["materialized"])

    def test_persist_observed_runtime_windows_blocks_zero_activity_evidence(
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
            decision_times=[],
            execution_times=[],
            tca_rows=[
                {
                    "computed_at": datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("4"),
                    "post_cost_expectancy_bps": Decimal("8"),
                },
                {
                    "computed_at": datetime(2026, 3, 6, 15, 6, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("5"),
                    "post_cost_expectancy_bps": Decimal("8"),
                },
            ],
            continuity_ok=True,
            drift_ok=True,
            dependency_quorum_decision="allow",
        )

        with self.session_local() as session:
            summary = persist_observed_runtime_windows(
                session=session,
                run_id="import-live-zero-activity",
                candidate_id="cand-zero-activity",
                hypothesis_id="H-CONT-01",
                observed_stage="live",
                strategy_family="intraday_continuation",
                source_manifest_ref="config/trading/hypotheses/h-cont-01.json",
                buckets=buckets,
            )
            session.commit()
            decision = session.execute(select(StrategyPromotionDecision)).scalar_one()
            windows = (
                session.execute(select(StrategyHypothesisMetricWindow)).scalars().all()
            )

        self.assertEqual(summary["raw_window_count"], 2)
        self.assertEqual(summary["window_count"], 0)
        self.assertEqual(summary["skipped_zero_activity_window_count"], 2)
        self.assertEqual(summary["market_session_samples"], 0)
        self.assertEqual(summary["decision_count"], 0)
        self.assertEqual(summary["trade_count"], 0)
        self.assertEqual(summary["order_count"], 0)
        self.assertEqual(summary["promotion_allowed"], False)
        self.assertIn(
            "runtime_window_evidence_missing",
            summary["promotion_blocking_reasons"],
        )
        self.assertIn(
            "runtime_decision_count_zero",
            summary["promotion_blocking_reasons"],
        )
        self.assertIn(
            "runtime_order_count_zero",
            summary["promotion_blocking_reasons"],
        )
        self.assertIn(
            "runtime_trade_count_zero",
            summary["promotion_blocking_reasons"],
        )
        self.assertEqual(decision.allowed, False)
        self.assertEqual(decision.payload_json["decision_count"], 0)
        self.assertEqual(decision.payload_json["raw_window_count"], 2)
        self.assertEqual(decision.payload_json["skipped_zero_activity_window_count"], 2)
        self.assertEqual(windows, [])

    def test_persist_observed_runtime_windows_rejects_weak_paper_receipt(
        self,
    ) -> None:
        buckets = build_observed_runtime_buckets(
            bucket_ranges=[
                (
                    datetime(2026, 5, 6, 17, 25, tzinfo=timezone.utc),
                    datetime(2026, 5, 6, 17, 40, tzinfo=timezone.utc),
                    15,
                ),
                (
                    datetime(2026, 5, 6, 17, 40, tzinfo=timezone.utc),
                    datetime(2026, 5, 6, 17, 55, tzinfo=timezone.utc),
                    15,
                ),
                (
                    datetime(2026, 5, 6, 17, 55, tzinfo=timezone.utc),
                    datetime(2026, 5, 6, 18, 1, tzinfo=timezone.utc),
                    6,
                ),
            ],
            decision_times=[
                datetime(2026, 5, 6, 17, 26, tzinfo=timezone.utc),
                datetime(2026, 5, 6, 17, 27, tzinfo=timezone.utc),
                datetime(2026, 5, 6, 17, 56, tzinfo=timezone.utc),
                datetime(2026, 5, 6, 17, 57, tzinfo=timezone.utc),
                datetime(2026, 5, 6, 17, 58, tzinfo=timezone.utc),
                datetime(2026, 5, 6, 17, 59, tzinfo=timezone.utc),
                datetime(2026, 5, 6, 18, 0, tzinfo=timezone.utc),
            ],
            execution_times=[
                datetime(2026, 5, 6, 17, 26, tzinfo=timezone.utc),
                datetime(2026, 5, 6, 17, 27, tzinfo=timezone.utc),
                datetime(2026, 5, 6, 17, 56, tzinfo=timezone.utc),
                datetime(2026, 5, 6, 17, 57, tzinfo=timezone.utc),
                datetime(2026, 5, 6, 17, 58, tzinfo=timezone.utc),
                datetime(2026, 5, 6, 17, 59, tzinfo=timezone.utc),
                datetime(2026, 5, 6, 18, 0, tzinfo=timezone.utc),
            ],
            tca_rows=[
                {
                    "computed_at": datetime(2026, 5, 6, 17, 26, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("0.24359349"),
                    "post_cost_expectancy_bps": Decimal("-0.24359349"),
                    **_runtime_pnl_basis(),
                },
                {
                    "computed_at": datetime(2026, 5, 6, 17, 56, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("24.304747534"),
                    "post_cost_expectancy_bps": Decimal("24.304747534"),
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
                run_id="import-paper-weak-chip",
                candidate_id="chip-paper-microbar-composite@execution-proof",
                hypothesis_id="H-MICRO-01",
                observed_stage="paper",
                strategy_family="microstructure_breakout",
                source_manifest_ref="config/trading/hypotheses/h-micro-01.json",
                buckets=buckets,
            )
            session.commit()
            decision = session.execute(select(StrategyPromotionDecision)).scalar_one()

        self.assertEqual(summary["raw_window_count"], 3)
        self.assertEqual(summary["window_count"], 2)
        self.assertEqual(summary["skipped_zero_activity_window_count"], 1)
        self.assertEqual(summary["market_session_samples"], 21)
        self.assertEqual(summary["promotion_allowed"], False)
        self.assertIn(
            "sample_count_below_canary_minimum",
            summary["promotion_blocking_reasons"],
        )
        self.assertIn(
            "recent_slippage_budget_exceeded",
            summary["promotion_blocking_reasons"],
        )
        self.assertIn(
            "runtime_ledger_pnl_basis_missing",
            summary["promotion_blocking_reasons"],
        )
        self.assertIn(
            "post_cost_expectancy_non_positive",
            summary["promotion_blocking_reasons"],
        )
        self.assertEqual(summary["avg_post_cost_expectancy_bps"], "0")
        self.assertEqual(
            summary["post_cost_expectancy_aggregation"],
            "no_runtime_ledger_post_cost_rows",
        )
        self.assertEqual(decision.allowed, False)
        self.assertEqual(decision.state, "shadow")
