"""Tests for Hyperliquid execution reporting query assembly."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Iterable, Mapping

from app.hyperliquid_execution.reporting import (
    build_operational_report,
    build_performance_metrics,
)


def test_operational_report_external_account_position_defensive_parsing() -> None:
    assert _external_positions([]) == []
    assert _external_positions([_account_row({"assetPositions": "not-a-list"})]) == []
    assert _external_positions([_account_row("{not-json")]) == []

    positions = _external_positions(
        [
            _account_row(
                json.dumps(
                    {
                        "assetPositions": [
                            "bad-position-row",
                            {"position": {"szi": "1"}},
                            {
                                "position": {
                                    "coin": "NOENTRY",
                                    "szi": "2",
                                    "unrealizedPnl": "0",
                                }
                            },
                            {
                                "position": {
                                    "coin": "FALLBACK",
                                    "szi": "2",
                                    "entryPx": "3.5",
                                    "unrealizedPnl": "1.2",
                                }
                            },
                        ]
                    },
                    sort_keys=True,
                )
            )
        ]
    )

    assert [position["coin"] for position in positions] == ["FALLBACK", "NOENTRY"]
    assert positions[0]["notional_usd"] == "7.0"
    assert positions[1]["notional_usd"] == "0"


def test_performance_metrics_zero_order_ratios() -> None:
    metrics = build_performance_metrics(
        _ReportingSession(
            performance_summary={
                "fills_24h": 0,
                "notional_24h": "0",
                "fees_24h": "0",
                "net_pnl_24h": "0",
                "fills_7d": 0,
                "notional_7d": "0",
                "fees_7d": "0",
                "net_pnl_7d": "0",
                "orders_24h": 0,
                "filled_orders_24h": 0,
                "cancelled_orders_24h": 0,
                "rejected_orders_24h": 0,
                "all_fills": 0,
            },
        )
    )

    assert metrics["maker_fill_rate_24h"] == "0"
    assert metrics["cancel_rate_24h"] == "0"
    assert metrics["reject_rate_24h"] == "0"
    assert metrics["sample_ready"] is False


def _external_positions(
    account_rows: Iterable[Mapping[str, object]],
) -> list[dict[str, object]]:
    report = build_operational_report(
        _ReportingSession(account_rows=account_rows),
        runtime_payload={},
        config_payload={},
    )
    external_positions = report["external_account_positions"]
    assert isinstance(external_positions, list)
    return external_positions


def _account_row(raw_payload: object) -> dict[str, object]:
    return {
        "observed_at": datetime.now(timezone.utc),
        "account_value_usd": "0",
        "withdrawable_usd": "0",
        "gross_exposure_usd": "0",
        "raw_payload": raw_payload,
    }


class _ReportingSession:
    def __init__(
        self,
        *,
        account_rows: Iterable[Mapping[str, object]] = (),
        performance_summary: Mapping[str, object] | None = None,
    ) -> None:
        self.account_rows = [dict(row) for row in account_rows]
        self.performance_summary = dict(performance_summary or _performance_summary())

    def execute(
        self,
        statement: object,
        parameters: Mapping[str, object] | None = None,
    ) -> "_ReportingResult":
        query = str(statement)
        if "WITH" in query and "fills_24h" in query:
            return _ReportingResult([self.performance_summary])
        if (
            "FROM hyperliquid_execution_account_snapshots" in query
            and "raw_payload" in query
        ):
            return _ReportingResult(self.account_rows)
        return _ReportingResult([])


class _ReportingResult:
    def __init__(self, rows: Iterable[Mapping[str, object]]) -> None:
        self._rows = [dict(row) for row in rows]

    def mappings(self) -> "_ReportingRows":
        return _ReportingRows(self._rows)


class _ReportingRows:
    def __init__(self, rows: list[dict[str, object]]) -> None:
        self._rows = rows

    def one(self) -> dict[str, object]:
        return self._rows[0]

    def all(self) -> list[dict[str, object]]:
        return self._rows


def _performance_summary() -> dict[str, object]:
    return {
        "fills_24h": 1,
        "notional_24h": "10",
        "fees_24h": "0.01",
        "net_pnl_24h": "0.50",
        "fills_7d": 1,
        "notional_7d": "10",
        "fees_7d": "0.01",
        "net_pnl_7d": "0.50",
        "orders_24h": 1,
        "filled_orders_24h": 1,
        "cancelled_orders_24h": 0,
        "rejected_orders_24h": 0,
        "all_fills": 41,
    }
