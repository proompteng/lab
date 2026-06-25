"""Tests for Hyperliquid v2 operator maintenance tools."""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

from app.hyperliquid_execution.config import HyperliquidExecutionConfig
from app.hyperliquid_execution.maintenance import close_excluded_positions
from app.hyperliquid_execution.models import AccountSnapshot, AccountState, OrderResult


def test_reduce_only_close_dry_run_selects_excluded_positions_only() -> None:
    exchange = _MaintenanceExchange()

    report = close_excluded_positions(
        config=HyperliquidExecutionConfig.from_env({}),
        exchange=exchange,
    )

    assert report["execute_requested"] is False
    assert report["requested_symbols"] == ["SPX"]
    assert report["candidates"] == [
        {
            "coin": "SPX",
            "size": "275.2",
            "entry_price": "0.36221",
            "notional_usd": "99.094016",
            "unrealized_pnl_usd": "-0.58",
        }
    ]
    assert report["actions"][0]["status"] == "dry_run"
    assert exchange.closed == []


def test_reduce_only_close_requires_explicit_maintenance_flag() -> None:
    exchange = _MaintenanceExchange()

    report = close_excluded_positions(
        config=HyperliquidExecutionConfig.from_env(
            {
                "HYPERLIQUID_EXECUTION_TRADING_ENABLED": "true",
                "HYPERLIQUID_EXECUTION_ACCOUNT_ADDRESS": "0xabc",
                "HYPERLIQUID_EXECUTION_API_WALLET_PRIVATE_KEY": "0x1",
            }
        ),
        exchange=exchange,
        requested_coins=("SPX",),
        execute=True,
    )

    assert report["blockers"] == ["maintenance_reduce_only_close_disabled"]
    assert report["actions"][0]["status"] == "blocked"
    assert exchange.closed == []


def test_reduce_only_close_executes_when_flag_enabled() -> None:
    exchange = _MaintenanceExchange()

    report = close_excluded_positions(
        config=HyperliquidExecutionConfig.from_env(
            {
                "HYPERLIQUID_EXECUTION_TRADING_ENABLED": "true",
                "HYPERLIQUID_EXECUTION_ACCOUNT_ADDRESS": "0xabc",
                "HYPERLIQUID_EXECUTION_API_WALLET_PRIVATE_KEY": "0x1",
                "HYPERLIQUID_EXECUTION_MAINTENANCE_REDUCE_ONLY_CLOSE_ENABLED": "true",
            }
        ),
        exchange=exchange,
        requested_coins=("SPX",),
        execute=True,
        slippage=Decimal("0.02"),
    )

    assert report["blockers"] == []
    assert report["actions"][0]["status"] == "filled"
    assert report["actions"][0]["exchange_order_id"] == "789"
    assert exchange.closed == [("SPX", Decimal("275.2"), Decimal("0.02"))]


class _MaintenanceExchange:
    def __init__(self) -> None:
        self.closed: list[tuple[str, Decimal | None, Decimal]] = []

    def reconcile_account(self, _market_id_by_coin: dict[str, str]) -> AccountState:
        now = datetime(2026, 6, 20, tzinfo=timezone.utc)
        return AccountState(
            account=AccountSnapshot(
                observed_at=now,
                account_value_usd=Decimal("998.2"),
                withdrawable_usd=Decimal("899.1"),
                gross_exposure_usd=Decimal("99.094016"),
                raw_payload={
                    "dexStates": {
                        "default": {
                            "assetPositions": [
                                {
                                    "position": {
                                        "coin": "SPX",
                                        "szi": "275.2",
                                        "entryPx": "0.36221",
                                        "positionValue": "99.094016",
                                        "unrealizedPnl": "-0.58",
                                    }
                                },
                                {
                                    "position": {
                                        "coin": "NVDA",
                                        "szi": "0.1",
                                        "entryPx": "100",
                                        "positionValue": "10",
                                    }
                                },
                            ]
                        }
                    }
                },
            ),
            positions=(),
        )

    def close_position_reduce_only(
        self,
        coin: str,
        *,
        size: Decimal | None = None,
        slippage: Decimal = Decimal("0.05"),
    ) -> OrderResult:
        self.closed.append((coin, size, slippage))
        return OrderResult(
            status="filled",
            exchange_order_id="789",
            raw_response={
                "response": {"data": {"statuses": [{"filled": {"oid": 789}}]}}
            },
        )
