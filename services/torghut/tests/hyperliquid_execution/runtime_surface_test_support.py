"""Shared lightweight runtime-surface test values."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from datetime import datetime, timedelta, timezone
from decimal import Decimal


class _FakeResult:
    def __init__(self, rows: Iterable[Mapping[str, object]]) -> None:
        self.rows = [dict(row) for row in rows]

    def mappings(self) -> "_FakeResult":
        return self

    def __iter__(self) -> Iterable[dict[str, object]]:
        return iter(self.rows)

    def one(self) -> dict[str, object]:
        return self.rows[0]

    def all(self) -> list[dict[str, object]]:
        return self.rows

    def scalar_one_or_none(self) -> object | None:
        if not self.rows:
            return None
        if len(self.rows) != 1 or len(self.rows[0]) != 1:
            raise AssertionError("fake scalar result is not exactly one value")
        return next(iter(self.rows[0].values()))


def _now() -> datetime:
    return datetime(2026, 6, 19, 12, tzinfo=timezone.utc)


class _FakeSession:
    def __init__(
        self,
        *,
        reject_count: int = 0,
        risk_open_coin: bool = False,
        risk_gross_exposure_usd: Decimal = Decimal("10"),
        risk_exposure_usd: Decimal = Decimal("0"),
        risk_cooldown: bool = False,
        profitability_net_pnl_24h: Decimal = Decimal("1"),
        profitability_notional_1h: Decimal = Decimal("10"),
        position_size: Decimal = Decimal("0"),
        position_sdk_coin: str | None = None,
        open_order_market_id: str = "hl:perp:xyz:NVDA",
    ) -> None:
        self.reject_count = reject_count
        self.risk_open_coin = risk_open_coin
        self.risk_gross_exposure_usd = risk_gross_exposure_usd
        self.risk_exposure_usd = risk_exposure_usd
        self.risk_cooldown = risk_cooldown
        self.profitability_net_pnl_24h = profitability_net_pnl_24h
        self.profitability_notional_1h = profitability_notional_1h
        self.position_size = position_size
        self.position_sdk_coin = position_sdk_coin
        self.open_order_market_id = open_order_market_id
        self.calls: list[tuple[str, Mapping[str, object] | None]] = []
        self.closed = False
        self.committed = False
        self.rolled_back = False

    def execute(
        self,
        statement: object,
        params: Mapping[str, object] | None = None,
    ) -> _FakeResult:
        sql = str(statement)
        self.calls.append((sql, params))
        return _FakeResult(self._rows_for(sql))

    def commit(self) -> None:
        self.committed = True

    def rollback(self) -> None:
        self.rolled_back = True

    def close(self) -> None:
        self.closed = True

    def _rows_for(self, sql: str) -> list[dict[str, object]]:
        if "INSERT INTO hyperliquid_execution_orders" in sql and "RETURNING id" in sql:
            return [{"id": "order-1"}]
        if "SELECT count(*) AS rejects" in sql:
            return [{"rejects": self.reject_count}]
        if "daily_realized_pnl_usd" in sql:
            return [
                {
                    "account_value_usd": "1000",
                    "withdrawable_usd": "900",
                    "gross_exposure_usd": str(self.risk_gross_exposure_usd),
                    "daily_realized_pnl_usd": "1",
                }
            ]
        if "SELECT DISTINCT coin" in sql:
            return [{"coin": "NVDA"}] if self.risk_open_coin else []
        if "SUM(ABS(notional_usd))" in sql:
            return [{"coin": "NVDA", "exposure_usd": str(self.risk_exposure_usd)}]
        if "GROUP BY coin" in sql and "exposures" in sql:
            return [{"coin": "NVDA", "exposure_usd": str(self.risk_exposure_usd)}]
        if "cooldown_reason" in sql and "cooldown_until > now()" in sql:
            if self.risk_cooldown:
                return [{"coin": "NVDA", "cooldown_reason": "symbol_reject_cooldown"}]
            return []
        if "net_pnl_after_fees_usd_24h" in sql and "notional_usd_1h" in sql:
            return self._profitability_rows()
        if "FROM hyperliquid_execution_positions" in sql and "LIMIT 1" in sql:
            return self._position_rows()
        if "expires_at <= :now" in sql:
            return [
                {
                    "id": "order-1",
                    "market_id": self.open_order_market_id,
                    "coin": "NVDA",
                    "exchange_order_id": "123",
                    "cloid": "0xabc",
                    "status": "accepted",
                    "expires_at": _now() - timedelta(seconds=1),
                }
            ]
        if "WITH" in sql and "fills_24h" in sql:
            return [
                {
                    "fills_24h": 1,
                    "notional_24h": "10",
                    "fees_24h": "0.01",
                    "net_pnl_24h": "0.50",
                    "fills_7d": 1,
                    "notional_7d": "10",
                    "fees_7d": "0.01",
                    "net_pnl_7d": "0.50",
                    "orders_24h": 2,
                    "filled_orders_24h": 1,
                    "cancelled_orders_24h": 1,
                    "rejected_orders_24h": 0,
                    "all_fills": 41,
                }
            ]
        if "FROM hyperliquid_execution_fills" in sql and "GROUP BY coin" in sql:
            return [
                {
                    "coin": "NVDA",
                    "fills": 1,
                    "notional_usd": "10",
                    "fees_usd": "0.01",
                    "net_pnl_after_fees_usd": "0.50",
                }
            ]
        if (
            "FROM hyperliquid_execution_account_snapshots" in sql
            and "raw_payload" in sql
        ):
            return [
                {
                    "observed_at": str(_now()),
                    "account_value_usd": "1000",
                    "withdrawable_usd": "900",
                    "gross_exposure_usd": "99.32",
                    "raw_payload": {
                        "assetPositions": [
                            {
                                "position": {
                                    "coin": "SPX",
                                    "szi": "275.2",
                                    "entryPx": "0.36091",
                                    "positionValue": "99.32",
                                    "unrealizedPnl": "-0.1",
                                }
                            }
                        ]
                    },
                }
            ]
        return [{"coin": "NVDA", "value": Decimal("1"), "observed_at": _now()}]

    def _profitability_rows(self) -> list[dict[str, object]]:
        return [
            {
                "net_pnl_after_fees_usd_24h": str(self.profitability_net_pnl_24h),
                "notional_usd_1h": str(self.profitability_notional_1h),
                "last_entry_at": None,
                "last_side": None,
                "last_side_at": None,
                "last_position_close_side": None,
                "last_position_close_at": None,
            }
        ]

    def _position_rows(self) -> list[dict[str, object]]:
        if self.position_size == Decimal("0"):
            return []
        return [
            {
                "market_id": "hl:perp:xyz:NVDA",
                "coin": "NVDA",
                "size": str(self.position_size),
                "entry_price": "100",
                "notional_usd": "10",
                "unrealized_pnl_usd": "0.25",
                "observed_at": _now(),
                "raw_payload": {"coin": self.position_sdk_coin or "NVDA"},
            }
        ]
