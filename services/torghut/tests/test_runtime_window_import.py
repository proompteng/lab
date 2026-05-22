from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.models import (
    Base,
    StrategyCapitalAllocation,
    StrategyHypothesis,
    StrategyHypothesisMetricWindow,
    StrategyHypothesisVersion,
    StrategyPromotionDecision,
    StrategyRuntimeLedgerBucket,
    VNextDatasetSnapshot,
)
from app.trading.runtime_window_import import (
    _delay_adjusted_depth_stress_blocking_reasons,
    _observation_bool,
    _observation_decimal,
    _observation_int,
    _parse_observation_datetime,
    build_observed_runtime_buckets,
    build_regular_session_buckets,
    persist_observed_runtime_windows,
    resolve_hypothesis_manifest,
)


def _runtime_pnl_basis() -> dict[str, object]:
    return {
        "post_cost_expectancy_basis": "realized_strategy_pnl_after_explicit_costs",
        "post_cost_promotion_eligible": True,
    }


def _simulation_report_pnl_basis() -> dict[str, object]:
    return {
        "post_cost_expectancy_basis": "simulation_report_net_pnl",
        "post_cost_promotion_eligible": True,
    }


class TestRuntimeWindowImport(TestCase):
    def setUp(self) -> None:
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

    def test_build_regular_session_buckets_counts_session_samples(self) -> None:
        buckets = build_regular_session_buckets(
            window_start=datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
            window_end=datetime(2026, 3, 6, 16, 30, tzinfo=timezone.utc),
            bucket_minutes=30,
            sample_minutes=5,
        )

        self.assertEqual(len(buckets), 4)
        self.assertEqual([item[2] for item in buckets], [6, 6, 6, 6])

    def test_build_observed_runtime_buckets_treats_idle_window_as_aligned(self) -> None:
        buckets = build_observed_runtime_buckets(
            bucket_ranges=[
                (
                    datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    6,
                )
            ],
            decision_times=[],
            execution_times=[],
            tca_rows=[],
            continuity_ok=True,
            drift_ok=True,
            dependency_quorum_decision="allow",
        )

        self.assertEqual(len(buckets), 1)
        self.assertEqual(buckets[0].decision_alignment_ratio, Decimal("1"))
        self.assertEqual(buckets[0].avg_abs_slippage_bps, Decimal("0"))
        self.assertEqual(buckets[0].post_cost_promotion_sample_count, 0)

    def test_build_observed_runtime_buckets_quarantines_simulation_report_pnl(
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
                    "abs_slippage_bps": Decimal("4"),
                    "post_cost_expectancy_bps": Decimal("50"),
                    **_simulation_report_pnl_basis(),
                }
            ],
            continuity_ok=True,
            drift_ok=True,
            dependency_quorum_decision="allow",
        )

        self.assertEqual(buckets[0].post_cost_expectancy_bps, Decimal("0"))
        self.assertEqual(buckets[0].post_cost_promotion_sample_count, 0)
        self.assertEqual(
            buckets[0].post_cost_basis_counts,
            {"simulation_report_net_pnl": 1},
        )

    def test_build_observed_runtime_buckets_weights_runtime_ledger_by_notional(
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
            decision_times=[
                datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
            ],
            execution_times=[
                datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                datetime(2026, 3, 6, 14, 41, tzinfo=timezone.utc),
            ],
            tca_rows=[
                {
                    "computed_at": datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("1"),
                    "post_cost_expectancy_bps": Decimal("100"),
                    "runtime_ledger_bucket": {
                        "filled_notional": "100",
                        "net_strategy_pnl_after_costs": "1",
                        "blockers": [],
                    },
                    **_runtime_pnl_basis(),
                },
                {
                    "computed_at": datetime(2026, 3, 6, 14, 41, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("1"),
                    "post_cost_expectancy_bps": Decimal("1"),
                    "runtime_ledger_bucket": {
                        "filled_notional": "10000",
                        "net_strategy_pnl_after_costs": "1",
                        "blockers": [],
                    },
                    **_runtime_pnl_basis(),
                },
            ],
            continuity_ok=True,
            drift_ok=True,
            dependency_quorum_decision="allow",
        )

        expected = (Decimal("2") / Decimal("10100")) * Decimal("10000")
        self.assertEqual(buckets[0].post_cost_expectancy_bps, expected)
        self.assertEqual(
            buckets[0].payload_json["post_cost_expectancy_aggregation"],
            "runtime_ledger_notional_weighted",
        )
        self.assertEqual(
            buckets[0].payload_json["runtime_ledger_filled_notional"], "10100"
        )
        self.assertEqual(
            buckets[0].payload_json["runtime_ledger_net_strategy_pnl_after_costs"],
            "2",
        )

    def test_runtime_observation_parsers_handle_edge_inputs(self) -> None:
        parsed = _parse_observation_datetime(
            datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc)
        )

        self.assertEqual(parsed, datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc))
        self.assertEqual(_parse_observation_datetime("not-a-date"), None)
        self.assertEqual(_observation_bool(1), True)
        self.assertEqual(_observation_bool(0), False)
        self.assertEqual(_observation_bool("passed"), True)
        self.assertEqual(_observation_bool("blocked"), False)
        self.assertEqual(_observation_bool("unclear"), None)
        self.assertEqual(_observation_decimal("bad"), Decimal("0"))
        self.assertEqual(_observation_int("-7"), 0)
        self.assertEqual(_observation_int("bad"), 0)

    def test_delay_adjusted_depth_stress_blockers_cover_failed_and_stale_proof(
        self,
    ) -> None:
        _, manifest = resolve_hypothesis_manifest(
            hypothesis_id="H-MICRO-01",
            strategy_family="microstructure_breakout",
        )
        now = datetime(2026, 3, 6, 15, 30, tzinfo=timezone.utc)

        failed_reasons = _delay_adjusted_depth_stress_blocking_reasons(
            manifest=manifest,
            runtime_payload={
                "delay_adjusted_depth_stress_checks_total": 1,
                "delay_adjusted_depth_stress_passed": "failed",
                "delay_adjusted_depth_stress_checked_at": now.isoformat(),
            },
            now=now,
        )
        stale_reasons = _delay_adjusted_depth_stress_blocking_reasons(
            manifest=manifest,
            runtime_payload={
                "delay_adjusted_depth_stress_report": {
                    "case_count": "1",
                    "passed": True,
                    "checked_at": "2026-03-06T13:00:00Z",
                }
            },
            now=now,
        )

        self.assertEqual(failed_reasons, ["delay_adjusted_depth_stress_failed"])
        self.assertEqual(stale_reasons, ["delay_adjusted_depth_stress_stale"])

    def test_delay_adjusted_depth_stress_blockers_require_survival_detail(
        self,
    ) -> None:
        _, manifest = resolve_hypothesis_manifest(
            hypothesis_id="H-MICRO-01",
            strategy_family="microstructure_breakout",
        )
        now = datetime(2026, 3, 6, 15, 30, tzinfo=timezone.utc)

        reasons = _delay_adjusted_depth_stress_blocking_reasons(
            manifest=manifest,
            runtime_payload={
                "delay_adjusted_depth_stress_report": {
                    "case_count": "1",
                    "passed": True,
                    "checked_at": now.isoformat(),
                    "tail_coverage_passed": "false",
                    "p10_active_day_fillable_notional": "0",
                    "worst_active_day_fillable_notional": "0",
                    "stress_net_pnl_per_day": "-1",
                    "fill_survival_evidence_present": "false",
                    "fill_survival_sample_count": "0",
                }
            },
            now=now,
        )

        self.assertEqual(
            reasons,
            [
                "delay_adjusted_depth_tail_coverage_missing",
                "delay_adjusted_depth_p10_fillable_non_positive",
                "delay_adjusted_depth_worst_fillable_non_positive",
                "delay_adjusted_depth_stress_net_pnl_non_positive",
                "fill_survival_evidence_missing",
                "fill_survival_sample_count_zero",
                "queue_ahead_depletion_evidence_missing",
                "queue_ahead_depletion_sample_count_zero",
            ],
        )

    def test_persist_observed_runtime_windows_creates_governance_rows(self) -> None:
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
                    "abs_slippage_bps": Decimal("4"),
                    "post_cost_expectancy_bps": Decimal("3"),
                    "runtime_ledger_bucket": {
                        "bucket_started_at": "2026-03-06T14:35:00+00:00",
                        "bucket_ended_at": "2026-03-06T14:36:00+00:00",
                        "account_label": "paper",
                        "strategy_id": "intraday_tsmom_v1@paper",
                        "fill_count": 2,
                        "decision_count": 2,
                        "submitted_order_count": 2,
                        "closed_trade_count": 1,
                        "filled_notional": "200",
                        "gross_strategy_pnl": "1",
                        "cost_amount": "0.10",
                        "net_strategy_pnl_after_costs": "0.90",
                        "post_cost_expectancy_bps": "45",
                        "ledger_schema_version": "torghut.exact_replay_ledger.v1",
                        "pnl_basis": "realized_strategy_pnl_after_explicit_costs",
                        "execution_policy_hash_counts": {"policy-sha": 2},
                        "cost_model_hash_counts": {"cost-sha": 2},
                        "lineage_hash_counts": {"lineage-sha": 2},
                        "blockers": [],
                    },
                    **_runtime_pnl_basis(),
                },
                {
                    "computed_at": datetime(2026, 3, 6, 15, 6, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("5"),
                    "post_cost_expectancy_bps": Decimal("2"),
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
                run_id="import-live-1",
                candidate_id="cand-1",
                hypothesis_id="H-CONT-01",
                observed_stage="live",
                strategy_family="intraday_continuation",
                source_manifest_ref="config/trading/hypotheses/h-cont-01.json",
                buckets=buckets,
                runtime_observation_payload={
                    "dataset_snapshot_ref": "torghut-runtime-window-cand-1",
                    "artifact_refs": ["s3://torghut-runtime/cand-1/report.json"],
                    "source_kind": "live_runtime_observed",
                },
            )
            session.commit()

            hypotheses = session.execute(select(StrategyHypothesis)).scalars().all()
            versions = (
                session.execute(select(StrategyHypothesisVersion)).scalars().all()
            )
            windows = (
                session.execute(select(StrategyHypothesisMetricWindow)).scalars().all()
            )
            allocations = (
                session.execute(select(StrategyCapitalAllocation)).scalars().all()
            )
            decisions = (
                session.execute(select(StrategyPromotionDecision)).scalars().all()
            )
            ledger_buckets = (
                session.execute(select(StrategyRuntimeLedgerBucket)).scalars().all()
            )
            datasets = session.execute(select(VNextDatasetSnapshot)).scalars().all()

        self.assertEqual(len(hypotheses), 1)
        self.assertEqual(len(versions), 1)
        self.assertEqual(len(windows), 2)
        self.assertEqual(len(allocations), 1)
        self.assertEqual(len(decisions), 1)
        self.assertEqual(len(ledger_buckets), 1)
        self.assertEqual(len(datasets), 1)
        self.assertEqual(
            ledger_buckets[0].pnl_basis,
            "realized_strategy_pnl_after_explicit_costs",
        )
        self.assertEqual(ledger_buckets[0].filled_notional, Decimal("200"))
        self.assertEqual(
            ledger_buckets[0].lineage_hash_counts,
            {"lineage-sha": 2},
        )
        self.assertEqual(datasets[0].candidate_id, "cand-1")
        self.assertEqual(datasets[0].artifact_ref, "torghut-runtime-window-cand-1")
        self.assertEqual(datasets[0].source, "live_runtime_observed")
        self.assertEqual(summary["market_session_samples"], 12)
        self.assertEqual(summary["latest_three_within_budget"], True)
        self.assertEqual(summary["promotion_allowed"], False)
        self.assertIn(
            "sample_count_below_canary_minimum",
            summary["promotion_blocking_reasons"],
        )
        self.assertIn(
            "runtime_ledger_pnl_basis_missing",
            summary["promotion_blocking_reasons"],
        )
        self.assertEqual(decisions[0].allowed, False)
        self.assertEqual(decisions[0].state, "shadow")

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
                    "runtime_ledger_bucket": {
                        "filled_notional": "100",
                        "net_strategy_pnl_after_costs": "1",
                        "pnl_basis": "realized_strategy_pnl_after_explicit_costs",
                        "blockers": [],
                    },
                    **_runtime_pnl_basis(),
                },
                {
                    "computed_at": datetime(2026, 3, 6, 15, 6, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("1"),
                    "post_cost_expectancy_bps": Decimal("1"),
                    "runtime_ledger_bucket": {
                        "filled_notional": "10000",
                        "net_strategy_pnl_after_costs": "1",
                        "pnl_basis": "realized_strategy_pnl_after_explicit_costs",
                        "blockers": [],
                    },
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
                    "runtime_ledger_bucket": {
                        "filled_notional": "1000",
                        "net_strategy_pnl_after_costs": "0.8",
                        "pnl_basis": "realized_strategy_pnl_after_explicit_costs",
                        "blockers": [],
                    },
                    **_runtime_pnl_basis(),
                },
                {
                    "computed_at": datetime(2026, 3, 6, 15, 6, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("5"),
                    "post_cost_expectancy_bps": Decimal("8"),
                    "runtime_ledger_bucket": {
                        "filled_notional": "1000",
                        "net_strategy_pnl_after_costs": "0.8",
                        "pnl_basis": "realized_strategy_pnl_after_explicit_costs",
                        "blockers": [],
                    },
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
            [window.capital_stage for window in windows], ["0.10x canary", "0.50x live"]
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

    def test_persist_observed_runtime_windows_blocks_tca_proxy_expectancy(self) -> None:
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
                    "post_cost_expectancy_basis": "tca_shortfall_proxy",
                    "post_cost_promotion_eligible": False,
                },
                {
                    "computed_at": datetime(2026, 3, 6, 15, 6, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("5"),
                    "post_cost_expectancy_bps": Decimal("80"),
                    "post_cost_expectancy_basis": "tca_shortfall_proxy",
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
                run_id="import-live-tca-proxy",
                candidate_id="cand-tca-proxy",
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
        self.assertEqual(summary["post_cost_basis_counts"], {"tca_shortfall_proxy": 2})
        self.assertIn(
            "post_cost_pnl_basis_missing",
            summary["promotion_blocking_reasons"],
        )
        self.assertIn(
            "post_cost_expectancy_non_positive",
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
                    "post_cost_expectancy_basis": "tca_shortfall_proxy",
                    "post_cost_promotion_eligible": True,
                }
            ],
            continuity_ok=True,
            drift_ok=True,
            dependency_quorum_decision="allow",
        )

        self.assertEqual(buckets[0].post_cost_promotion_sample_count, 0)
        self.assertEqual(buckets[0].post_cost_expectancy_bps, Decimal("0"))
        self.assertEqual(buckets[0].post_cost_basis_counts, {"tca_shortfall_proxy": 1})

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

    def test_persist_observed_runtime_windows_allows_h_micro_with_fresh_delay_depth_stress(
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

        self.assertEqual(summary["promotion_allowed"], True)
        self.assertEqual(summary["promotion_blocking_reasons"], [])
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
        self.assertEqual(decision.allowed, True)
        self.assertEqual(
            decision.payload_json["delay_adjusted_depth_stress"],
            summary["delay_adjusted_depth_stress"],
        )

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
            "post_cost_expectancy_below_manifest_threshold",
            summary["promotion_blocking_reasons"],
        )
        self.assertEqual(decision.allowed, False)
        self.assertEqual(decision.state, "shadow")
