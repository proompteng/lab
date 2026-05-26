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
    _runtime_ledger_bucket_blockers,
    _runtime_ledger_bucket_payloads,
    _runtime_ledger_daily_summary_from_observed_buckets,
    _runtime_window_import_proof_blockers,
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


def _runtime_ledger_bucket(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "fill_count": 2,
        "decision_count": 2,
        "submitted_order_count": 2,
        "closed_trade_count": 1,
        "open_position_count": 0,
        "filled_notional": "200",
        "gross_strategy_pnl": "1",
        "cost_amount": "0.20",
        "net_strategy_pnl_after_costs": "0.80",
        "post_cost_expectancy_bps": "40",
        "ledger_schema_version": "torghut.exact_replay_ledger.v1",
        "pnl_basis": "realized_strategy_pnl_after_explicit_costs",
        "execution_policy_hash_counts": {"policy-sha": 2},
        "cost_model_hash_counts": {"cost-sha": 2},
        "lineage_hash_counts": {"lineage-sha": 2},
        "blockers": [],
    }
    payload.update(overrides)
    return payload


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

    def test_runtime_window_import_proof_blockers_dedupe_blank_and_authority_reason(
        self,
    ) -> None:
        blockers = _runtime_window_import_proof_blockers(
            promotion_blocking_reasons=[
                "",
                "paper_stage_evidence_collection_only",
                "paper_stage_evidence_collection_only",
            ],
            runtime_payload={
                "authoritative": False,
                "authority_reason": "runtime_without_runtime_ledger_profit_proof",
                "promotion_authority": "blocked",
                "runtime_ledger_profit_proof_present": False,
            },
            candidate_id="cand-paper-route",
            hypothesis_id="H-PAIRS-01",
            observed_stage="paper",
            window_start=datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc),
            window_end=datetime(2026, 5, 26, 20, 0, tzinfo=timezone.utc),
        )

        self.assertEqual(
            [item["blocker"] for item in blockers],
            [
                "paper_stage_evidence_collection_only",
                "runtime_without_runtime_ledger_profit_proof",
            ],
        )
        self.assertEqual(blockers[0]["promotion_authority"], "blocked")
        self.assertFalse(blockers[0]["runtime_ledger_profit_proof_present"])

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

    def test_build_observed_runtime_buckets_rejects_legacy_realized_pnl_basis(
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
                    "post_cost_expectancy_basis": "realized_strategy_pnl",
                    "post_cost_promotion_eligible": True,
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
            {"realized_strategy_pnl": 1},
        )

    def test_build_observed_runtime_buckets_requires_runtime_ledger_bucket_for_pnl_basis(
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
                    **_runtime_pnl_basis(),
                }
            ],
            continuity_ok=True,
            drift_ok=True,
            dependency_quorum_decision="allow",
        )

        self.assertEqual(buckets[0].post_cost_expectancy_bps, Decimal("0"))
        self.assertEqual(buckets[0].post_cost_promotion_sample_count, 0)
        self.assertEqual(
            buckets[0].payload_json["post_cost_expectancy_aggregation"],
            "no_runtime_ledger_post_cost_rows",
        )
        self.assertEqual(
            buckets[0].post_cost_basis_counts,
            {"realized_strategy_pnl_after_explicit_costs": 1},
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
                    "runtime_ledger_bucket": _runtime_ledger_bucket(
                        filled_notional="100",
                        net_strategy_pnl_after_costs="1",
                        cost_amount="0.01",
                        post_cost_expectancy_bps="100",
                    ),
                    **_runtime_pnl_basis(),
                },
                {
                    "computed_at": datetime(2026, 3, 6, 14, 41, tzinfo=timezone.utc),
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

    def test_runtime_ledger_bucket_blockers_require_complete_lifecycle_proof(
        self,
    ) -> None:
        missing_blockers = _runtime_ledger_bucket_blockers({})

        self.assertIn("runtime_ledger_schema_version_missing", missing_blockers)
        self.assertIn("runtime_ledger_pnl_basis_missing", missing_blockers)
        self.assertIn("runtime_ledger_open_position_count_missing", missing_blockers)

        invalid_blockers = _runtime_ledger_bucket_blockers(
            {
                "ledger_schema_version": "torghut.loose_runtime_ledger.v0",
                "pnl_basis": "simulation_report_net_pnl",
                "fill_count": 0,
                "decision_count": 0,
                "submitted_order_count": 0,
                "closed_trade_count": 0,
                "open_position_count": 1,
                "filled_notional": "0",
                "cost_amount": "-0.01",
                "post_cost_expectancy_bps": None,
                "execution_policy_hash_counts": "not-a-map",
                "cost_model_hash_counts": {},
                "lineage_hash_counts": {},
            }
        )

        self.assertIn("runtime_ledger_schema_version_invalid", invalid_blockers)
        self.assertIn("runtime_ledger_pnl_basis_invalid", invalid_blockers)
        self.assertIn("runtime_fills_missing", invalid_blockers)
        self.assertIn("runtime_decision_lifecycle_missing", invalid_blockers)
        self.assertIn("submitted_order_lifecycle_missing", invalid_blockers)
        self.assertIn("closed_round_trip_missing", invalid_blockers)
        self.assertIn("unclosed_position", invalid_blockers)
        self.assertIn("filled_notional_missing", invalid_blockers)
        self.assertIn("explicit_cost_missing", invalid_blockers)
        self.assertIn("runtime_ledger_expectancy_missing", invalid_blockers)
        self.assertIn("runtime_ledger_execution_policy_hash_missing", invalid_blockers)
        self.assertIn("runtime_ledger_cost_model_hash_missing", invalid_blockers)
        self.assertIn("runtime_ledger_lineage_hash_missing", invalid_blockers)

    def test_runtime_ledger_bucket_payloads_accept_single_bucket_payload(
        self,
    ) -> None:
        payloads = _runtime_ledger_bucket_payloads(
            {"runtime_ledger_bucket": _runtime_ledger_bucket()}
        )

        self.assertEqual(len(payloads), 1)
        self.assertEqual(payloads[0]["blockers"], [])

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
        self.assertEqual(summary["proof_status"], "blocked")
        self.assertIn(
            "sample_count_below_canary_minimum",
            [item["blocker"] for item in summary["proof_blockers"]],
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
        assert decision.payload_json is not None
        self.assertEqual(
            decision.payload_json["runtime_ledger_mean_daily_net_pnl_after_costs"],
            "300",
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

        self.assertEqual(
            summary["runtime_ledger_net_pnl_by_trading_day"]["2026-03-06"], "-30"
        )
        self.assertEqual(
            summary["runtime_ledger_mean_daily_net_pnl_after_costs"], "-10"
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
        self.assertEqual(
            summary["promotion_blocking_reasons"],
            ["paper_stage_evidence_collection_only"],
        )
        self.assertEqual(summary["proof_status"], "blocked")
        self.assertEqual(
            [item["blocker"] for item in summary["proof_blockers"]],
            ["paper_stage_evidence_collection_only"],
        )
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
