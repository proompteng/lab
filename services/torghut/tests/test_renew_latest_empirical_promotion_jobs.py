from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.models import Base, StrategyRuntimeLedgerBucket
from app.trading.runtime_window_import import (
    build_observed_runtime_buckets,
    persist_observed_runtime_windows,
)
from scripts import renew_latest_empirical_promotion_jobs as renew


def _runtime_pnl_basis() -> dict[str, object]:
    return {
        "post_cost_expectancy_basis": "realized_strategy_pnl_after_explicit_costs",
        "post_cost_promotion_eligible": True,
    }


def _source_backed_runtime_ledger_bucket(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "bucket_started_at": "2026-03-06T14:35:00+00:00",
        "bucket_ended_at": "2026-03-06T14:36:00+00:00",
        "account_label": "TORGHUT_SIM",
        "strategy_id": "microbar-cross-sectional-pairs-v1",
        "symbol": "AAPL",
        "fill_count": 2,
        "decision_count": 2,
        "submitted_order_count": 2,
        "cancelled_order_count": 0,
        "rejected_order_count": 0,
        "unfilled_order_count": 0,
        "closed_trade_count": 1,
        "open_position_count": 0,
        "filled_notional": "200",
        "gross_strategy_pnl": "1",
        "cost_amount": "0.20",
        "net_strategy_pnl_after_costs": "0.80",
        "post_cost_expectancy_bps": "40",
        "ledger_schema_version": "torghut.runtime-ledger-bucket.v1",
        "pnl_basis": "realized_strategy_pnl_after_explicit_costs",
        "execution_policy_hash_counts": {"policy-sha": 2},
        "cost_model_hash_counts": {"cost-sha": 2},
        "lineage_hash_counts": {"lineage-sha": 2},
        "source_decision_mode_counts": {"strategy_signal_paper": 2},
        "profit_proof_eligible": True,
        "source_window_start": "2026-03-06T14:30:00+00:00",
        "source_window_end": "2026-03-06T15:00:00+00:00",
        "source_refs": [
            "postgres:trade_decisions",
            "postgres:executions",
            "postgres:execution_order_events",
            "postgres:order_feed_source_windows",
        ],
        "source_row_counts": {
            "trade_decisions": 2,
            "executions": 2,
            "execution_order_events": 2,
            "order_feed_source_windows": 2,
        },
        "trade_decision_ids": ["decision-buy", "decision-sell"],
        "execution_ids": ["execution-buy", "execution-sell"],
        "execution_order_event_ids": ["event-fill-buy", "event-fill-sell"],
        "source_window_ids": ["source-window-buy", "source-window-sell"],
        "source_offsets": [
            {"topic": "alpaca.trade_updates", "partition": 0, "offset": 100},
            {"topic": "alpaca.trade_updates", "partition": 0, "offset": 101},
        ],
        "source_materialization": "execution_order_events",
        "authority_class": "runtime_order_feed_execution_source",
        "blockers": [],
    }
    payload.update(overrides)
    return payload


def _observed_bucket_for_ledger_payload(
    ledger_payload: dict[str, object],
):
    return build_observed_runtime_buckets(
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
                "runtime_ledger_bucket": ledger_payload,
                **_runtime_pnl_basis(),
            }
        ],
        continuity_ok=True,
        drift_ok=True,
        dependency_quorum_decision="allow",
    )


class TestRenewLatestEmpiricalPromotionJobsRuntimeLedger(TestCase):
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

    def test_hpairs_source_proof_census_status_is_non_authority_renewal_evidence(
        self,
    ) -> None:
        status = renew._hpairs_source_proof_census_status(
            {
                "schema_version": "torghut.hpairs-source-proof-census.v1",
                "identity": {"hypothesis_id": "H-PAIRS-01"},
                "window": {},
                "runtime_authority": {
                    "final_authority_ok": False,
                    "blockers": ["runtime_ledger_source_materialization_missing"],
                },
                "missing_requirement_categories": {
                    "submitted_orders": False,
                    "filled_notional": False,
                },
                "missing_source_ref_categories": {
                    "runtime_ledger_source_materialization_missing": True,
                },
                "blocker_ladder": [
                    {
                        "step": "runtime_ledger_source_materialization_present",
                        "status": "blocked",
                        "blocker_codes": [
                            "runtime_ledger_source_materialization_missing"
                        ],
                    }
                ],
                "blockers": ["runtime_ledger_source_materialization_missing"],
                "verdict": {
                    "classification": "source_refs_missing",
                    "authority_candidate_ready": False,
                    "next_blocker": {
                        "step": "runtime_ledger_source_materialization_present"
                    },
                    "next_action": "backfill runtime-ledger source refs",
                },
                "totals": {"runtime_ledger_source_materialization_count": 0},
            }
        )

        self.assertTrue(status["present"])
        self.assertTrue(status["non_authority_status_only"])
        self.assertFalse(status["promotion_allowed"])
        self.assertFalse(status["final_authority_ok"])
        self.assertEqual(
            status["blockers"],
            ["runtime_ledger_source_materialization_missing"],
        )
        self.assertEqual(
            status["next_blocker"]["step"],
            "runtime_ledger_source_materialization_present",
        )

    def test_runtime_bucket_materialization_rerun_is_idempotent_for_same_scope(
        self,
    ) -> None:
        first_payload = _source_backed_runtime_ledger_bucket(
            net_strategy_pnl_after_costs="0.80"
        )
        second_payload = _source_backed_runtime_ledger_bucket(
            net_strategy_pnl_after_costs="1.25"
        )

        with self.session_local() as session:
            first_summary = persist_observed_runtime_windows(
                session=session,
                run_id="hpairs-runtime-import",
                candidate_id="c88421d619759b2cfaa6f4d0",
                hypothesis_id="H-PAIRS-01",
                observed_stage="paper",
                strategy_family="microbar_cross_sectional_pairs",
                source_manifest_ref="config/trading/hypotheses/h-pairs-01.json",
                buckets=_observed_bucket_for_ledger_payload(first_payload),
                runtime_observation_payload={
                    "account_label": "TORGHUT_SIM",
                    "strategy_name": "microbar-cross-sectional-pairs-v1",
                    "runtime_ledger_profit_proof_present": True,
                },
            )
            second_summary = persist_observed_runtime_windows(
                session=session,
                run_id="hpairs-runtime-import",
                candidate_id="c88421d619759b2cfaa6f4d0",
                hypothesis_id="H-PAIRS-01",
                observed_stage="paper",
                strategy_family="microbar_cross_sectional_pairs",
                source_manifest_ref="config/trading/hypotheses/h-pairs-01.json",
                buckets=_observed_bucket_for_ledger_payload(second_payload),
                runtime_observation_payload={
                    "account_label": "TORGHUT_SIM",
                    "strategy_name": "microbar-cross-sectional-pairs-v1",
                    "runtime_ledger_profit_proof_present": True,
                },
            )
            session.commit()
            rows = session.execute(select(StrategyRuntimeLedgerBucket)).scalars().all()

        self.assertEqual(
            first_summary["current_runtime_ledger_bucket_replacement_count"], 0
        )
        self.assertEqual(
            second_summary["current_runtime_ledger_bucket_replacement_count"], 1
        )
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].account_label, "TORGHUT_SIM")
        self.assertEqual(
            rows[0].runtime_strategy_name,
            "microbar-cross-sectional-pairs-v1",
        )
        self.assertEqual(rows[0].net_strategy_pnl_after_costs, Decimal("1.25"))

    def test_runtime_bucket_materialization_keeps_hpairs_account_identity_separate(
        self,
    ) -> None:
        torghut_sim_payload = _source_backed_runtime_ledger_bucket(
            account_label="TORGHUT_SIM",
            net_strategy_pnl_after_costs="0.80",
        )
        alternate_account_payload = _source_backed_runtime_ledger_bucket(
            account_label="TORGHUT_SIM_ALT",
            net_strategy_pnl_after_costs="0.55",
            trade_decision_ids=["alt-decision-buy", "alt-decision-sell"],
            execution_ids=["alt-execution-buy", "alt-execution-sell"],
            execution_order_event_ids=["alt-event-fill-buy", "alt-event-fill-sell"],
            source_window_ids=["alt-source-window-buy", "alt-source-window-sell"],
            source_offsets=[
                {"topic": "alpaca.trade_updates", "partition": 1, "offset": 200},
                {"topic": "alpaca.trade_updates", "partition": 1, "offset": 201},
            ],
        )

        with self.session_local() as session:
            persist_observed_runtime_windows(
                session=session,
                run_id="hpairs-runtime-import",
                candidate_id="c88421d619759b2cfaa6f4d0",
                hypothesis_id="H-PAIRS-01",
                observed_stage="paper",
                strategy_family="microbar_cross_sectional_pairs",
                source_manifest_ref="config/trading/hypotheses/h-pairs-01.json",
                buckets=_observed_bucket_for_ledger_payload(torghut_sim_payload),
                runtime_observation_payload={
                    "account_label": "TORGHUT_SIM",
                    "strategy_name": "microbar-cross-sectional-pairs-v1",
                    "runtime_ledger_profit_proof_present": True,
                },
            )
            persist_observed_runtime_windows(
                session=session,
                run_id="hpairs-runtime-import",
                candidate_id="c88421d619759b2cfaa6f4d0",
                hypothesis_id="H-PAIRS-01",
                observed_stage="paper",
                strategy_family="microbar_cross_sectional_pairs",
                source_manifest_ref="config/trading/hypotheses/h-pairs-01.json",
                buckets=_observed_bucket_for_ledger_payload(alternate_account_payload),
                runtime_observation_payload={
                    "account_label": "TORGHUT_SIM_ALT",
                    "strategy_name": "microbar-cross-sectional-pairs-v1",
                    "runtime_ledger_profit_proof_present": True,
                },
            )
            session.commit()
            rows = (
                session.execute(
                    select(StrategyRuntimeLedgerBucket).order_by(
                        StrategyRuntimeLedgerBucket.account_label
                    )
                )
                .scalars()
                .all()
            )

        self.assertEqual(
            [row.account_label for row in rows], ["TORGHUT_SIM", "TORGHUT_SIM_ALT"]
        )
        self.assertEqual(
            [row.observed_stage for row in rows],
            ["paper", "paper"],
        )
        self.assertEqual(
            [row.runtime_strategy_name for row in rows],
            [
                "microbar-cross-sectional-pairs-v1",
                "microbar-cross-sectional-pairs-v1",
            ],
        )
