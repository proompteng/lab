from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
import json
from types import SimpleNamespace
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Mapping, cast
from unittest import TestCase
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.models import Base, StrategyRuntimeLedgerBucket
from app.trading.runtime_ledger import RuntimeLedgerBucket
from scripts.import_hypothesis_runtime_windows import (
    EXECUTION_ELIGIBLE_DECISION_STATUSES,
    POST_COST_BASIS_EXECUTION_RECONSTRUCTION,
    POST_COST_BASIS_RUNTIME_LEDGER,
    _alpaca_2026_equity_fee_schedule_hash,
    _active_carry_in_ledger_rows,
    _build_realized_strategy_pnl_rows,
    _execution_signed_qty,
    _flat_start_position_snapshot_authority,
    _flat_start_position_snapshot_from_cursor,
    _filter_carry_in_source_rows_for_active_lots,
    _fill_quantity_basis,
    _first_bool,
    _first_lineage_digest,
    _load_json_artifact,
    _order_feed_fill_delta_blockers,
    _nonnegative_int,
    _order_lifecycle_query_row,
    _parse_args,
    _parse_dt_or_none,
    _parse_target_metadata,
    _query_timestamps,
    _row_payloads,
    _runtime_ledger_bucket_profit_proof_blockers,
    _runtime_ledger_bucket_profit_proof_present,
    _runtime_ledger_event_type,
    _runtime_lifecycle_ledger_row,
    _runtime_ledger_profit_proof_present,
    _runtime_observation_authority_payload,
    _runtime_decision_rows_before_bucket,
    _runtime_execution_ledger_fill_from_row,
    _runtime_ledger_target_metadata_blockers,
    _runtime_ledger_tca_row_from_bucket,
    _runtime_ledger_tca_materialization_metadata,
    _runtime_ledger_tca_rows_from_durable_buckets,
    _runtime_ledger_tca_rows_from_source_dsn,
    _runtime_ledger_tca_rows_from_artifacts,
    _runtime_window_import_proof_hygiene_blockers,
    _runtime_window_source_kind_is_informational,
    _source_kind_allows_runtime_ledger_materialization,
    _source_activity_diagnostics_blockers,
    _source_row_matches_lineage,
    _persistence_session,
    _source_activity_missing_summary,
    _source_backed_fill_lifecycle_rows,
    _source_backed_order_lifecycle_rows,
    _source_decision_target_notional_sizing_summary,
    _source_decision_mode,
    _source_decision_mode_counts,
    _source_decision_rows_profit_proof_eligible,
    _source_decision_action_offsets_open_qty,
    _source_row_lineage_missing_or_matches,
    _filter_source_rows_for_runtime_window,
    _runtime_open_qtys_by_symbol_from_execution_rows,
    _source_runtime_ledger_payload_from_row,
    _source_order_feed_payload_delta_fill,
    _required_order_lifecycle_source_row_count,
    _source_window_classification_counts,
    _source_window_gap_count,
    _source_window_gap_ranges,
    _source_window_query_context,
    _source_window_status_counts,
    _stable_payload_digest,
    _strategy_name_candidates,
    _sqlalchemy_dsn,
    _target_persistence_dsn,
    _with_runtime_ledger_source_authority_context,
    main,
)


class _FakeCursor:
    def __init__(self) -> None:
        self.executed: list[tuple[str, tuple[object, ...]]] = []
        self._results = [
            [
                (
                    "decision-id-1",
                    datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                    "AAPL",
                    "TORGHUT_SIM",
                    "intraday_tsmom_v1@paper",
                    "decision-sha",
                    {},
                )
            ],
            [
                (
                    "execution-id-1",
                    "decision-id-1",
                    datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    "AAPL",
                    "buy",
                    Decimal("1"),
                    Decimal("100"),
                    Decimal("0.01"),
                    {
                        "cost_amount": "0.01",
                        "cost_basis": "broker_reported_commission_and_fees",
                    },
                    {},
                    "TORGHUT_SIM",
                    "intraday_tsmom_v1@paper",
                    "decision-sha",
                    {},
                    "alpaca-order-1",
                    "client-order-1",
                    "filled",
                    "tca-id-1",
                )
            ],
            [
                (
                    "event-id-1",
                    "decision-id-1",
                    "execution-id-1",
                    datetime(2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc),
                    "AAPL",
                    "TORGHUT_SIM",
                    "intraday_tsmom_v1@paper",
                    "decision-sha",
                    {},
                    "alpaca-order-1",
                    "client-order-1",
                    "new",
                    "new",
                    "event-fingerprint-1",
                    "alpaca-trade-updates",
                    0,
                    1,
                    {
                        "execution_policy": {"selected_order_type": "market"},
                        "cost_model": {"source": "broker_reported"},
                    },
                    {
                        "cost_amount": "0.01",
                        "cost_basis": "broker_reported_commission_and_fees",
                    },
                    {
                        "execution_policy_hash": "policy-sha",
                        "cost_model_hash": "cost-sha",
                        "lineage_hash": "lineage-sha",
                    },
                )
            ],
        ]

    def __enter__(self) -> _FakeCursor:
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None

    def execute(self, query: str, params: tuple[object, ...]) -> None:
        self.executed.append((query, params))

    def fetchall(self) -> list[tuple[object, ...]]:
        return self._results.pop(0)


class _FakeConnection:
    def __init__(self, cursor: _FakeCursor) -> None:
        self._cursor = cursor

    def __enter__(self) -> _FakeConnection:
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None

    def cursor(self) -> _FakeCursor:
        return self._cursor


class _SourceLedgerCursor:
    def __init__(self) -> None:
        self.executed: list[tuple[str, tuple[object, ...]]] = []
        self._results = [
            [
                (
                    "source-runtime-ledger-bucket-1",
                    "runtime-proof-source",
                    "H-TSMOM-LIQ-01",
                    "H-TSMOM-LIQ-01",
                    "paper",
                    datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    "TORGHUT_SIM",
                    "intraday-tsmom-profit-v3",
                    "intraday_tsmom_consistent",
                    2,
                    2,
                    2,
                    0,
                    0,
                    0,
                    1,
                    0,
                    Decimal("200"),
                    Decimal("1"),
                    Decimal("0.20"),
                    Decimal("0.80"),
                    Decimal("40"),
                    {"policy-sha": 2},
                    {"cost-sha": 2},
                    {"lineage-sha": 2},
                    [],
                    "torghut.exact_replay_ledger.v1",
                    POST_COST_BASIS_RUNTIME_LEDGER,
                    {
                        "cost_basis_counts": {"broker_reported_commission_and_fees": 2},
                        "source_decision_mode_counts": {"strategy_signal_paper": 2},
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
                            "execution_order_events": 4,
                            "order_feed_source_windows": 4,
                        },
                        "source_window_ids": [
                            "source-window-new-buy",
                            "source-window-fill-buy",
                            "source-window-new-sell",
                            "source-window-fill-sell",
                        ],
                        "trade_decision_ids": ["decision-buy", "decision-sell"],
                        "execution_ids": ["execution-buy", "execution-sell"],
                        "execution_order_event_ids": [
                            "event-new-buy",
                            "event-fill-buy",
                            "event-new-sell",
                            "event-fill-sell",
                        ],
                        "source_offsets": [
                            {
                                "topic": "alpaca.trade_updates",
                                "partition": 0,
                                "offset": 100,
                            },
                            {
                                "topic": "alpaca.trade_updates",
                                "partition": 0,
                                "offset": 101,
                            },
                            {
                                "topic": "alpaca.trade_updates",
                                "partition": 0,
                                "offset": 102,
                            },
                            {
                                "topic": "alpaca.trade_updates",
                                "partition": 0,
                                "offset": 103,
                            },
                        ],
                        "source_materialization": "execution_order_events",
                        "authority_class": "runtime_order_feed_execution_source",
                        "authority_reason": "event_sourced_runtime_ledger_profit_proof",
                        "profit_proof_eligible": True,
                    },
                )
            ]
        ]

    def __enter__(self) -> _SourceLedgerCursor:
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None

    def execute(self, query: str, params: tuple[object, ...]) -> None:
        self.executed.append((query, params))

    def fetchall(self) -> list[tuple[object, ...]]:
        return self._results.pop(0)


class _SourceLedgerConnection:
    def __init__(self, cursor: _SourceLedgerCursor) -> None:
        self._cursor = cursor

    def __enter__(self) -> _SourceLedgerConnection:
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None

    def cursor(self) -> _SourceLedgerCursor:
        return self._cursor


class _FakeSession:
    def __init__(self) -> None:
        self.committed = False

    def __enter__(self) -> _FakeSession:
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None

    def commit(self) -> None:
        self.committed = True


def _complete_runtime_ledger_bucket(**overrides: object) -> dict[str, object]:
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
        "pnl_basis": POST_COST_BASIS_RUNTIME_LEDGER,
        "execution_policy_hash_counts": {"policy-sha": 2},
        "cost_model_hash_counts": {"cost-sha": 2},
        "cost_basis_counts": {"broker_reported": 2},
        "lineage_hash_counts": {"lineage-sha": 2},
        "source_decision_mode_counts": {"strategy_signal_paper": 2},
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
            "execution_order_events": 4,
            "order_feed_source_windows": 4,
        },
        "source_window_ids": [
            "source-window-new-buy",
            "source-window-fill-buy",
            "source-window-new-sell",
            "source-window-fill-sell",
        ],
        "trade_decision_ids": ["decision-buy", "decision-sell"],
        "execution_ids": ["execution-buy", "execution-sell"],
        "execution_tca_metric_ids": ["tca-buy", "tca-sell"],
        "execution_order_event_ids": [
            "event-new-buy",
            "event-fill-buy",
            "event-new-sell",
            "event-fill-sell",
        ],
        "source_offsets": [
            {"topic": "alpaca.trade_updates", "partition": 0, "offset": 100},
            {"topic": "alpaca.trade_updates", "partition": 0, "offset": 101},
            {"topic": "alpaca.trade_updates", "partition": 0, "offset": 102},
            {"topic": "alpaca.trade_updates", "partition": 0, "offset": 103},
        ],
        "source_materialization": "execution_order_events",
        "authority_class": "runtime_order_feed_execution_source",
        "authority_reason": "event_sourced_runtime_ledger_profit_proof",
        "pnl_derivation": "execution_order_events_runtime_ledger",
        "profit_proof_eligible": True,
        "blockers": [],
    }
    payload.update(overrides)
    return payload


def _runtime_split_ts(minutes: int) -> datetime:
    return datetime(2026, 5, 21, 14, 30, tzinfo=timezone.utc) + timedelta(
        minutes=minutes
    )


def _source_backed_runtime_split_rows(
    *,
    include_execution_economics: bool = True,
    include_order_lifecycle: bool = True,
    include_submitted_lifecycle: bool = True,
) -> tuple[list[dict[str, object]], list[dict[str, object]], list[dict[str, object]]]:
    common: dict[str, object] = {
        "account_label": "paper",
        "strategy_id": "strategy-1",
        "symbol": "NVDA",
        "lineage_hash": "lineage",
        "source_decision_mode": "strategy_signal_paper",
    }
    decision_rows = [
        {
            **common,
            "trade_decision_id": "decision-buy",
            "computed_at": _runtime_split_ts(0),
            "decision_hash": "decision-buy",
            "decision_json": {"source_decision_mode": "strategy_signal_paper"},
        },
        {
            **common,
            "trade_decision_id": "decision-sell",
            "computed_at": _runtime_split_ts(10),
            "decision_hash": "decision-sell",
            "decision_json": {"source_decision_mode": "strategy_signal_paper"},
        },
    ]
    order_rows: list[dict[str, object]] = []
    if include_order_lifecycle:
        for side, order_id, decision_id, minute, offset, is_fill in (
            ("buy", "order-buy", "decision-buy", 1, 100, False),
            ("buy", "order-buy", "decision-buy", 2, 101, True),
            ("sell", "order-sell", "decision-sell", 11, 102, False),
            ("sell", "order-sell", "decision-sell", 12, 103, True),
        ):
            if not include_submitted_lifecycle and not is_fill:
                continue
            event_name = "fill" if is_fill else "new"
            order_rows.append(
                {
                    **common,
                    "trade_decision_id": decision_id,
                    "event_ts": _runtime_split_ts(minute),
                    "event_type": event_name,
                    "order_status": "filled" if is_fill else "new",
                    "side": side,
                    "alpaca_order_id": order_id,
                    "client_order_id": order_id,
                    "execution_order_event_id": f"event-{event_name}-{order_id}",
                    "source_window_id": f"window-{event_name}-{order_id}",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": offset,
                    "source": "order_feed_lifecycle",
                    "execution_policy_hash": "policy",
                    "cost_model_hash": "cost-model",
                    "lineage_hash": "lineage",
                }
            )

    execution_rows: list[dict[str, object]] = []
    if include_execution_economics:
        for side, order_id, decision_id, execution_id, minute, price in (
            ("buy", "order-buy", "decision-buy", "execution-buy", 2, "100"),
            ("sell", "order-sell", "decision-sell", "execution-sell", 12, "101"),
        ):
            execution_rows.append(
                {
                    **common,
                    "trade_decision_id": decision_id,
                    "computed_at": _runtime_split_ts(minute),
                    "execution_event_at": _runtime_split_ts(minute),
                    "execution_created_at": _runtime_split_ts(minute),
                    "execution_id": execution_id,
                    "execution_tca_metric_id": f"tca-{execution_id}",
                    "side": side,
                    "filled_qty": "1",
                    "avg_fill_price": price,
                    "cost_amount": "0.01",
                    "cost_basis": "broker_reported_commission_and_fees",
                    "alpaca_order_id": order_id,
                    "client_order_id": order_id,
                    "execution_policy_hash": "policy",
                    "cost_model_hash": "cost-model",
                    "lineage_hash": "lineage",
                }
            )
    return decision_rows, order_rows, execution_rows


__all__: tuple[str, ...] = ()

__all__: tuple[str, ...] = (
    "Base",
    "Decimal",
    "EXECUTION_ELIGIBLE_DECISION_STATUSES",
    "Mapping",
    "POST_COST_BASIS_EXECUTION_RECONSTRUCTION",
    "POST_COST_BASIS_RUNTIME_LEDGER",
    "Path",
    "RuntimeLedgerBucket",
    "SimpleNamespace",
    "StaticPool",
    "StrategyRuntimeLedgerBucket",
    "TemporaryDirectory",
    "TestCase",
    "_FakeConnection",
    "_FakeCursor",
    "_FakeSession",
    "_SourceLedgerConnection",
    "_SourceLedgerCursor",
    "_active_carry_in_ledger_rows",
    "_alpaca_2026_equity_fee_schedule_hash",
    "_build_realized_strategy_pnl_rows",
    "_complete_runtime_ledger_bucket",
    "_execution_signed_qty",
    "_fill_quantity_basis",
    "_filter_carry_in_source_rows_for_active_lots",
    "_filter_source_rows_for_runtime_window",
    "_first_bool",
    "_first_lineage_digest",
    "_flat_start_position_snapshot_authority",
    "_flat_start_position_snapshot_from_cursor",
    "_load_json_artifact",
    "_nonnegative_int",
    "_order_feed_fill_delta_blockers",
    "_order_lifecycle_query_row",
    "_parse_args",
    "_parse_dt_or_none",
    "_parse_target_metadata",
    "_persistence_session",
    "_query_timestamps",
    "_required_order_lifecycle_source_row_count",
    "_row_payloads",
    "_runtime_decision_rows_before_bucket",
    "_runtime_execution_ledger_fill_from_row",
    "_runtime_ledger_bucket_profit_proof_blockers",
    "_runtime_ledger_bucket_profit_proof_present",
    "_runtime_ledger_event_type",
    "_runtime_ledger_profit_proof_present",
    "_runtime_ledger_target_metadata_blockers",
    "_runtime_ledger_tca_materialization_metadata",
    "_runtime_ledger_tca_row_from_bucket",
    "_runtime_ledger_tca_rows_from_artifacts",
    "_runtime_ledger_tca_rows_from_durable_buckets",
    "_runtime_ledger_tca_rows_from_source_dsn",
    "_runtime_lifecycle_ledger_row",
    "_runtime_observation_authority_payload",
    "_runtime_open_qtys_by_symbol_from_execution_rows",
    "_runtime_split_ts",
    "_runtime_window_import_proof_hygiene_blockers",
    "_runtime_window_source_kind_is_informational",
    "_source_activity_diagnostics_blockers",
    "_source_activity_missing_summary",
    "_source_backed_fill_lifecycle_rows",
    "_source_backed_order_lifecycle_rows",
    "_source_backed_runtime_split_rows",
    "_source_decision_action_offsets_open_qty",
    "_source_decision_mode",
    "_source_decision_mode_counts",
    "_source_decision_rows_profit_proof_eligible",
    "_source_decision_target_notional_sizing_summary",
    "_source_kind_allows_runtime_ledger_materialization",
    "_source_order_feed_payload_delta_fill",
    "_source_row_lineage_missing_or_matches",
    "_source_row_matches_lineage",
    "_source_runtime_ledger_payload_from_row",
    "_source_window_classification_counts",
    "_source_window_gap_count",
    "_source_window_gap_ranges",
    "_source_window_query_context",
    "_source_window_status_counts",
    "_sqlalchemy_dsn",
    "_stable_payload_digest",
    "_strategy_name_candidates",
    "_target_persistence_dsn",
    "_with_runtime_ledger_source_authority_context",
    "cast",
    "create_engine",
    "datetime",
    "json",
    "main",
    "patch",
    "sessionmaker",
    "timedelta",
    "timezone",
)
