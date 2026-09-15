from __future__ import annotations


import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from app.trading.runtime_authority_verifier import (
    AUTHORITY_EXPLICIT_COSTS_BLOCKER,
    AUTHORITY_OPEN_POSITIONS_BLOCKER,
    AUTHORITY_RUNTIME_DECISIONS_MISSING_BLOCKER,
    AUTHORITY_RUNTIME_FILLS_MISSING_BLOCKER,
    DEFAULT_HPAIRS_ACCOUNT_LABEL,
    DEFAULT_HPAIRS_CANDIDATE_ID,
    DEFAULT_HPAIRS_HYPOTHESIS_ID,
    DEFAULT_HPAIRS_RUNTIME_STRATEGY,
    RUNTIME_LEDGER_EXECUTION_ORDER_EVENT_REFS_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_OFFSETS_MISSING_BLOCKER,
    RUNTIME_LEDGER_TRADE_DECISION_REFS_MISSING_BLOCKER,
)
from app.trading.runtime_ledger import (
    EXACT_REPLAY_LEDGER_SCHEMA_VERSION,
    POST_COST_PNL_BASIS,
)
from scripts import audit_hpairs_source_proof_census as census


def _iso(day_index: int, hour: int = 14) -> str:
    return (
        (datetime(2026, 5, 1, hour, tzinfo=timezone.utc) + timedelta(days=day_index))
        .isoformat()
        .replace("+00:00", "Z")
    )


def _source_payload(day_index: int) -> dict[str, object]:
    return {
        "source_window_start": _iso(day_index, 14),
        "source_window_end": _iso(day_index, 21),
        "source_refs": [
            "postgres:trade_decisions",
            "postgres:executions",
            "postgres:execution_order_events",
            "postgres:order_feed_source_windows",
        ],
        "source_row_counts": {
            "trade_decisions": 1,
            "executions": 1,
            "execution_order_events": 1,
            "order_feed_source_windows": 1,
        },
        "trade_decision_ids": [f"decision-{day_index}"],
        "execution_ids": [f"execution-{day_index}"],
        "execution_order_event_ids": [f"event-{day_index}"],
        "source_window_ids": [f"window-{day_index}"],
        "source_offsets": [
            {"topic": "alpaca.trade_updates", "partition": 0, "offset": day_index}
        ],
        "source_materialization": "execution_order_events",
        "authority_class": "runtime_order_feed_execution_source",
        "authority_reason": "event_sourced_runtime_ledger_profit_proof",
        "order_feed_lifecycle_complete": True,
        "execution_economics_complete": True,
        "cost_basis_counts": {"explicit_broker_fee_runtime": 1},
    }


def _ledger_bucket(
    day_index: int, *, source_backed: bool = True, open_positions: int = 0
) -> dict[str, object]:
    start = _iso(day_index, 14)
    return {
        "id": f"ledger-{day_index}",
        "run_id": "hpairs-runtime-run",
        "candidate_id": DEFAULT_HPAIRS_CANDIDATE_ID,
        "hypothesis_id": DEFAULT_HPAIRS_HYPOTHESIS_ID,
        "observed_stage": "paper",
        "bucket_started_at": start,
        "bucket_ended_at": _iso(day_index, 21),
        "account_label": DEFAULT_HPAIRS_ACCOUNT_LABEL,
        "runtime_strategy_name": DEFAULT_HPAIRS_RUNTIME_STRATEGY,
        "strategy_family": "pairs",
        "fill_count": 20,
        "decision_count": 20,
        "submitted_order_count": 20,
        "cancelled_order_count": 0,
        "rejected_order_count": 0,
        "unfilled_order_count": 0,
        "closed_trade_count": 20,
        "open_position_count": open_positions,
        "filled_notional": "600000",
        "gross_strategy_pnl": "610",
        "cost_amount": "10",
        "net_strategy_pnl_after_costs": "600",
        "post_cost_expectancy_bps": "10",
        "ledger_schema_version": EXACT_REPLAY_LEDGER_SCHEMA_VERSION,
        "pnl_basis": POST_COST_PNL_BASIS,
        "execution_policy_hash_counts": {"policy-hash": 1},
        "cost_model_hash_counts": {"cost-hash": 1},
        "lineage_hash_counts": {"lineage-hash": 1},
        "blockers": [],
        "payload": _source_payload(day_index) if source_backed else {},
    }


def _fixture(*, days: int = 20, source_backed: bool = True) -> dict[str, object]:
    return {
        "trade_decisions": [
            {
                "id": f"decision-{day}",
                "strategy_name": DEFAULT_HPAIRS_RUNTIME_STRATEGY,
                "alpaca_account_label": DEFAULT_HPAIRS_ACCOUNT_LABEL,
                "status": "executed",
                "created_at": _iso(day, 14),
            }
            for day in range(days)
        ],
        "executions": [
            {
                "id": f"execution-{day}",
                "trade_decision_id": f"decision-{day}",
                "alpaca_account_label": DEFAULT_HPAIRS_ACCOUNT_LABEL,
                "status": "filled",
                "filled_qty": "10",
                "avg_fill_price": "100",
                "created_at": _iso(day, 15),
            }
            for day in range(days)
        ],
        "execution_order_events": [
            {
                "id": f"event-{day}",
                "execution_id": f"execution-{day}",
                "trade_decision_id": f"decision-{day}",
                "source_window_id": f"window-{day}",
                "source_topic": "alpaca.trade_updates",
                "source_partition": 0,
                "source_offset": day,
                "alpaca_account_label": DEFAULT_HPAIRS_ACCOUNT_LABEL,
                "event_type": "fill",
                "status": "filled",
                "filled_qty_delta": "10",
                "avg_fill_price": "100",
                "filled_notional_delta": "1000",
                "event_ts": _iso(day, 15),
            }
            for day in range(days)
        ],
        "execution_tca_metrics": [
            {
                "id": f"tca-{day}",
                "execution_id": f"execution-{day}",
                "trade_decision_id": f"decision-{day}",
                "alpaca_account_label": DEFAULT_HPAIRS_ACCOUNT_LABEL,
                "filled_qty": "10",
                "shortfall_notional": "1",
                "computed_at": _iso(day, 16),
            }
            for day in range(days)
        ],
        "order_feed_source_windows": [
            {
                "id": f"window-{day}",
                "alpaca_account_label": DEFAULT_HPAIRS_ACCOUNT_LABEL,
                "source_topic": "alpaca.trade_updates",
                "source_partition": 0,
                "window_started_at": _iso(day, 14),
                "window_ended_at": _iso(day, 21),
                "start_offset": day,
                "end_offset": day + 1,
                "status": "complete",
            }
            for day in range(days)
        ],
        "runtime_ledger_buckets": [
            _ledger_bucket(day, source_backed=source_backed) for day in range(days)
        ],
    }


def _report(
    payload: dict[str, object],
    *,
    source_account_label: str | None = None,
) -> dict[str, object]:
    rows = census.CensusSourceRows(
        trade_decisions=census._row_list(payload.get("trade_decisions")),
        executions=census._row_list(payload.get("executions")),
        execution_order_events=census._row_list(payload.get("execution_order_events")),
        execution_tca_metrics=census._row_list(payload.get("execution_tca_metrics")),
        order_feed_source_windows=census._row_list(
            payload.get("order_feed_source_windows")
        ),
        runtime_ledger_buckets=census._row_list(payload.get("runtime_ledger_buckets")),
    )
    return census.build_source_proof_census(
        rows,
        identity=census.CensusIdentity(
            hypothesis_id=DEFAULT_HPAIRS_HYPOTHESIS_ID,
            candidate_id=DEFAULT_HPAIRS_CANDIDATE_ID,
            runtime_strategy_name=DEFAULT_HPAIRS_RUNTIME_STRATEGY,
            account_label=DEFAULT_HPAIRS_ACCOUNT_LABEL,
            observed_stage="paper",
            source_account_label=source_account_label,
        ),
    )


def _ladder_step(report: dict[str, object], step: str) -> dict[str, object]:
    ladder = report["blocker_ladder"]
    assert isinstance(ladder, list)
    for item in ladder:
        assert isinstance(item, dict)
        if item["step"] == step:
            return item
    raise AssertionError(f"missing ladder step {step}")


class _FakeResult:
    def __init__(self, rows: list[object]) -> None:
        self._rows = rows

    def mappings(self) -> "_FakeResult":
        return self

    def all(self) -> list[object]:
        return self._rows


class _FakeReadSession:
    def __init__(
        self,
        *,
        decision_pairs: list[object],
        scalar_results: list[list[object]],
    ) -> None:
        self._decision_pairs = decision_pairs
        self._scalar_results = scalar_results

    def execute(self, _stmt: object) -> _FakeResult:
        return _FakeResult(self._decision_pairs)

    def scalars(self, _stmt: object) -> _FakeResult:
        return _FakeResult(self._scalar_results.pop(0))


__all__: tuple[str, ...] = (
    "AUTHORITY_EXPLICIT_COSTS_BLOCKER",
    "AUTHORITY_OPEN_POSITIONS_BLOCKER",
    "AUTHORITY_RUNTIME_DECISIONS_MISSING_BLOCKER",
    "AUTHORITY_RUNTIME_FILLS_MISSING_BLOCKER",
    "DEFAULT_HPAIRS_ACCOUNT_LABEL",
    "DEFAULT_HPAIRS_CANDIDATE_ID",
    "DEFAULT_HPAIRS_HYPOTHESIS_ID",
    "DEFAULT_HPAIRS_RUNTIME_STRATEGY",
    "EXACT_REPLAY_LEDGER_SCHEMA_VERSION",
    "POST_COST_PNL_BASIS",
    "Path",
    "RUNTIME_LEDGER_EXECUTION_ORDER_EVENT_REFS_MISSING_BLOCKER",
    "RUNTIME_LEDGER_SOURCE_OFFSETS_MISSING_BLOCKER",
    "RUNTIME_LEDGER_TRADE_DECISION_REFS_MISSING_BLOCKER",
    "SimpleNamespace",
    "_FakeReadSession",
    "_FakeResult",
    "_fixture",
    "_iso",
    "_ladder_step",
    "_ledger_bucket",
    "_report",
    "_source_payload",
    "census",
    "datetime",
    "json",
    "patch",
    "timedelta",
    "timezone",
)
