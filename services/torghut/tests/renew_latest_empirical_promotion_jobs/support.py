from __future__ import annotations


import argparse
from datetime import datetime, timezone
from decimal import Decimal
import json
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

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


class _TestRenewLatestEmpiricalPromotionJobsRuntimeLedgerBase(TestCase):
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


__all__: tuple[str, ...] = ()

__all__: tuple[str, ...] = (
    "Base",
    "Decimal",
    "Path",
    "StaticPool",
    "StrategyRuntimeLedgerBucket",
    "TestCase",
    "_TestRenewLatestEmpiricalPromotionJobsRuntimeLedgerBase",
    "_observed_bucket_for_ledger_payload",
    "_runtime_pnl_basis",
    "_source_backed_runtime_ledger_bucket",
    "argparse",
    "build_observed_runtime_buckets",
    "create_engine",
    "datetime",
    "json",
    "patch",
    "persist_observed_runtime_windows",
    "renew",
    "select",
    "sessionmaker",
    "timezone",
)
