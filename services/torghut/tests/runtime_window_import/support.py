from __future__ import annotations

# ruff: noqa: F401

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest import TestCase
from unittest.mock import patch
from uuid import uuid4

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
    TigerBeetleAccountRef,
    TigerBeetleTransferRef,
    VNextDatasetSnapshot,
)
from app.trading.tigerbeetle_client import FakeTigerBeetleClient
from app.trading.runtime_cost_authority import (
    cost_basis_counts_have_non_promotion_grade_costs,
)
from app.trading.runtime_decision_authority import (
    source_decision_mode_counts_have_non_profit_proof_modes,
)
from app.trading import runtime_window_import as runtime_window_import_module
from app.trading.runtime_window_import import (
    _delay_adjusted_depth_stress_blocking_reasons,
    _journal_tigerbeetle_runtime_ledger_bucket,
    _observation_bool,
    _observation_decimal,
    _observation_int,
    _parse_observation_datetime,
    _persisted_runtime_ledger_bucket_evidence_grade,
    _runtime_ledger_bucket_blockers,
    _runtime_ledger_bucket_payloads,
    _runtime_ledger_daily_summary_from_observed_buckets,
    _runtime_window_import_readback_from_rows,
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
        "cost_basis_counts": {"broker_reported_commission_and_fees": 2},
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
            "execution_tca_metrics": 2,
            "execution_order_events": 2,
            "order_feed_source_windows": 2,
        },
        "trade_decision_ids": ["decision-buy", "decision-sell"],
        "execution_ids": ["execution-buy", "execution-sell"],
        "execution_tca_metric_ids": ["tca-buy", "tca-sell"],
        "execution_order_event_ids": ["event-fill-buy", "event-fill-sell"],
        "source_window_ids": ["source-window-buy", "source-window-sell"],
        "source_offsets": [
            {"topic": "alpaca.trade_updates", "partition": 0, "offset": 100},
            {"topic": "alpaca.trade_updates", "partition": 0, "offset": 101},
        ],
        "source_materialization": "execution_order_events",
        "authority_class": "runtime_order_feed_execution_source",
        "authority_reason": "event_sourced_runtime_ledger_profit_proof",
        "blockers": [],
    }
    payload.update(overrides)
    return payload


class _TestRuntimeWindowImportBase(TestCase):
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


__all__ = [name for name in globals() if not name.startswith("__")]
