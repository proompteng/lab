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
    VNextDatasetSnapshot,
)
from app.trading.runtime_window_import import (
    _delay_adjusted_depth_stress_blocking_reasons,
    _observation_bool,
    _observation_int,
    _parse_observation_datetime,
    build_observed_runtime_buckets,
    build_regular_session_buckets,
    persist_observed_runtime_windows,
    resolve_hypothesis_manifest,
)


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
                },
                {
                    "computed_at": datetime(2026, 3, 6, 15, 6, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("5"),
                    "post_cost_expectancy_bps": Decimal("2"),
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
            datasets = session.execute(select(VNextDatasetSnapshot)).scalars().all()

        self.assertEqual(len(hypotheses), 1)
        self.assertEqual(len(versions), 1)
        self.assertEqual(len(windows), 2)
        self.assertEqual(len(allocations), 1)
        self.assertEqual(len(decisions), 1)
        self.assertEqual(len(datasets), 1)
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
            "post_cost_expectancy_below_manifest_threshold",
            summary["promotion_blocking_reasons"],
        )
        self.assertEqual(decisions[0].allowed, False)
        self.assertEqual(decisions[0].state, "shadow")

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
                },
                {
                    "computed_at": datetime(2026, 3, 6, 15, 6, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("5"),
                    "post_cost_expectancy_bps": Decimal("12"),
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
                },
                {
                    "computed_at": datetime(2026, 3, 6, 15, 6, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("5"),
                    "post_cost_expectancy_bps": Decimal("12"),
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
                    }
                },
            )
            session.commit()
            decision = session.execute(select(StrategyPromotionDecision)).scalar_one()

        self.assertEqual(summary["promotion_allowed"], True)
        self.assertEqual(summary["promotion_blocking_reasons"], [])
        self.assertEqual(decision.allowed, True)

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

        self.assertEqual(summary["market_session_samples"], 80)
        self.assertEqual(summary["decision_count"], 0)
        self.assertEqual(summary["trade_count"], 0)
        self.assertEqual(summary["order_count"], 0)
        self.assertEqual(summary["promotion_allowed"], False)
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
                },
                {
                    "computed_at": datetime(2026, 5, 6, 17, 56, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("24.304747534"),
                    "post_cost_expectancy_bps": Decimal("24.304747534"),
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

        self.assertEqual(summary["market_session_samples"], 36)
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
