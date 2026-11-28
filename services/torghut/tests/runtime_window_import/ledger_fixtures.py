"""Paper-runtime rows with complete, explicit-cost provenance.

Each call returns a new row. Cases testing missing evidence still supply
incomplete rows directly; cases testing different authority override the
relevant fields at the call site.
"""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace


def execution_fill(**fields: object) -> dict[str, object]:
    return {
        "symbol": "AAPL",
        "filled_qty": Decimal("1"),
        "cost_basis": "broker_reported_commission_and_fees",
        "cost_model_hash": "cost-sha",
        "lineage_hash": "lineage-sha",
        **fields,
    }


def strategy_decision_row(**fields: object) -> dict[str, object]:
    return {
        "event_type": "decision",
        "symbol": "AAPL",
        "account_label": "TORGHUT_SIM",
        "strategy_id": "microbar-cross-sectional-pairs-v1",
        "source_decision_mode": "strategy_signal_paper",
        "lineage_hash": "lineage-sha",
        **fields,
    }


def paper_order_event(**fields: object) -> dict[str, object]:
    return {
        "symbol": "AAPL",
        "account_label": "TORGHUT_SIM",
        "strategy_id": "microbar-cross-sectional-pairs-v1",
        "lineage_hash": "lineage-sha",
        "source_topic": "alpaca.trade_updates",
        "source_partition": 0,
        **fields,
    }


def paper_order_fill(**fields: object) -> dict[str, object]:
    return paper_order_event(
        **{
            "filled_qty": Decimal("1"),
            "filled_qty_delta": Decimal("1"),
            "fill_quantity_basis": "cumulative_to_delta",
            "cost_basis": "broker_reported_commission_and_fees",
            "cost_model_hash": "cost-sha",
            **fields,
        }
    )


def paper_import_args(**overrides: object) -> SimpleNamespace:
    return SimpleNamespace(
        **{
            "observed_stage": "paper",
            "account_label": "TORGHUT_SIM",
            "window_start": "2026-03-06T14:30:00Z",
            "window_end": "2026-03-06T15:00:00Z",
            "bucket_minutes": 30,
            "sample_minutes": 5,
            "artifact_ref": [],
            "source_dsn_env": "DB_DSN",
            "dependency_quorum_decision": "allow",
            "continuity_ok": "true",
            "drift_ok": "true",
            "json": False,
            **overrides,
        }
    )


def march_6_market_hour(minute: int, second: int = 0) -> datetime:
    return datetime(2026, 3, 6, 14, minute, second, tzinfo=timezone.utc)
