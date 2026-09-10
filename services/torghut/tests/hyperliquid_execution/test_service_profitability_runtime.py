"""Profitability and reduce-only service regressions."""

from __future__ import annotations

from decimal import Decimal

from app.hyperliquid_execution.config import HyperliquidExecutionConfig
from app.hyperliquid_execution.service import HyperliquidExecutionService

from tests.hyperliquid_execution.test_runtime_surfaces import (
    _FakeSession,
    _LowEdgeServiceFeed,
    _ServiceExchange,
    _ServiceFeed,
    _MUTATION_COORDINATOR,
    _TwoExecutableServiceFeed,
    _account_state,
    _now,
    _ready_recovery_worker,
)


def test_service_cycle_submits_at_most_one_order() -> None:
    now = _now()
    config = HyperliquidExecutionConfig.from_env(
        {
            "HYPERLIQUID_EXECUTION_TRADING_ENABLED": "true",
            "HYPERLIQUID_EXECUTION_API_WALLET_PRIVATE_KEY": "0x1",
            "HYPERLIQUID_EXECUTION_ACCOUNT_ADDRESS": "0xabc",
            "HYPERLIQUID_EXECUTION_TRADE_COINS": "xyz:NVDA,xyz:MU",
        }
    )
    session = _FakeSession()
    exchange = _ServiceExchange(now)
    service = HyperliquidExecutionService(
        config=config,
        feed=_TwoExecutableServiceFeed(now),
        exchange=exchange,
        mutation_coordinator=_MUTATION_COORDINATOR,
        recovery_worker=_ready_recovery_worker(),
    )

    result = service.run_once(session)

    assert result.signals_written == 1
    assert result.orders_submitted == 1
    assert exchange.submitted_coins == ["NVDA"]
    gate = result.universe_details["profitability_gate"]
    assert isinstance(gate, dict)
    assert gate["allowed"] is True


def test_service_blocks_low_after_cost_edge_before_exchange_submission() -> None:
    now = _now()
    config = HyperliquidExecutionConfig.from_env(
        {
            "HYPERLIQUID_EXECUTION_TRADING_ENABLED": "true",
            "HYPERLIQUID_EXECUTION_API_WALLET_PRIVATE_KEY": "0x1",
            "HYPERLIQUID_EXECUTION_ACCOUNT_ADDRESS": "0xabc",
            "HYPERLIQUID_EXECUTION_TRADE_COINS": "xyz:NVDA",
        }
    )
    session = _FakeSession()
    exchange = _ServiceExchange(now)
    service = HyperliquidExecutionService(
        config=config,
        feed=_LowEdgeServiceFeed(now),
        exchange=exchange,
        mutation_coordinator=_MUTATION_COORDINATOR,
        recovery_worker=_ready_recovery_worker(),
    )

    result = service.run_once(session)

    assert result.signals_written == 1
    assert result.orders_submitted == 0
    assert exchange.submitted_coins == []
    gate = result.universe_details["profitability_gate"]
    assert isinstance(gate, dict)
    assert gate["allowed"] is False
    assert result.universe_details["risk_blocks_by_reason"] == {
        "profitability_after_cost_edge_below_floor": 1
    }


def test_service_reduces_opposite_position_before_profitability_gate() -> None:
    now = _now()
    config = HyperliquidExecutionConfig.from_env(
        {
            "HYPERLIQUID_EXECUTION_TRADING_ENABLED": "true",
            "HYPERLIQUID_EXECUTION_API_WALLET_PRIVATE_KEY": "0x1",
            "HYPERLIQUID_EXECUTION_ACCOUNT_ADDRESS": "0xabc",
            "HYPERLIQUID_EXECUTION_TRADE_COINS": "xyz:NVDA",
        }
    )
    session = _FakeSession(position_size=Decimal("-0.1"))
    exchange = _ServiceExchange(
        now,
        account_state=_account_state(now, position_size=Decimal("-0.1")),
    )
    service = HyperliquidExecutionService(
        config=config,
        feed=_LowEdgeServiceFeed(now),
        exchange=exchange,
        mutation_coordinator=_MUTATION_COORDINATOR,
        recovery_worker=_ready_recovery_worker(),
    )

    result = service.run_once(session)

    assert result.signals_written == 1
    assert result.orders_submitted == 1
    assert exchange.submitted_coins == []
    assert exchange.reduce_only_closes == [("NVDA", Decimal("0.1"), Decimal("0.05"))]
    assert "profitability_gate" not in result.universe_details
    assert result.universe_details["risk_blocks_by_reason"] == {
        "reduce_only_close_before_opposite_entry": 1
    }


def test_service_closes_opposite_position_reduce_only_before_new_entry() -> None:
    now = _now()
    config = HyperliquidExecutionConfig.from_env(
        {
            "HYPERLIQUID_EXECUTION_TRADING_ENABLED": "true",
            "HYPERLIQUID_EXECUTION_API_WALLET_PRIVATE_KEY": "0x1",
            "HYPERLIQUID_EXECUTION_ACCOUNT_ADDRESS": "0xabc",
            "HYPERLIQUID_EXECUTION_TRADE_COINS": "xyz:NVDA",
        }
    )
    session = _FakeSession(position_size=Decimal("-0.1"))
    exchange = _ServiceExchange(
        now,
        account_state=_account_state(now, position_size=Decimal("-0.1")),
    )
    service = HyperliquidExecutionService(
        config=config,
        feed=_ServiceFeed(now),
        exchange=exchange,
        mutation_coordinator=_MUTATION_COORDINATOR,
        recovery_worker=_ready_recovery_worker(),
    )

    result = service.run_once(session)

    assert result.signals_written == 1
    assert result.orders_submitted == 1
    assert exchange.submitted_coins == []
    assert exchange.reduce_only_closes == [("NVDA", Decimal("0.1"), Decimal("0.05"))]
    position_reduce_only = result.universe_details["position_reduce_only"]
    assert isinstance(position_reduce_only, dict)
    assert position_reduce_only["reason"] == "reduce_only_close_before_opposite_entry"
    assert result.universe_details["risk_blocks_by_reason"] == {
        "reduce_only_close_before_opposite_entry": 1
    }


def test_service_closes_scoped_opposite_position_reduce_only() -> None:
    now = _now()
    config = HyperliquidExecutionConfig.from_env(
        {
            "HYPERLIQUID_EXECUTION_TRADING_ENABLED": "true",
            "HYPERLIQUID_EXECUTION_API_WALLET_PRIVATE_KEY": "0x1",
            "HYPERLIQUID_EXECUTION_ACCOUNT_ADDRESS": "0xabc",
            "HYPERLIQUID_EXECUTION_TRADE_COINS": "xyz:NVDA",
        }
    )
    session = _FakeSession(
        position_size=Decimal("-0.1"),
        position_sdk_coin="xyz:NVDA",
    )
    exchange = _ServiceExchange(
        now,
        account_state=_account_state(
            now,
            position_size=Decimal("-0.1"),
            position_sdk_coin="xyz:NVDA",
        ),
    )
    service = HyperliquidExecutionService(
        config=config,
        feed=_ServiceFeed(now),
        exchange=exchange,
        mutation_coordinator=_MUTATION_COORDINATOR,
        recovery_worker=_ready_recovery_worker(),
    )

    result = service.run_once(session)

    assert result.orders_submitted == 1
    assert exchange.submitted_coins == []
    assert exchange.reduce_only_closes == [
        ("xyz:NVDA", Decimal("0.1"), Decimal("0.05"))
    ]
    position_reduce_only = result.universe_details["position_reduce_only"]
    assert isinstance(position_reduce_only, dict)
    assert position_reduce_only["coin"] == "NVDA"
    assert position_reduce_only["sdk_coin"] == "xyz:NVDA"


def test_service_stops_cycle_after_submitted_reduce_only_close() -> None:
    now = _now()
    config = HyperliquidExecutionConfig.from_env(
        {
            "HYPERLIQUID_EXECUTION_TRADING_ENABLED": "true",
            "HYPERLIQUID_EXECUTION_API_WALLET_PRIVATE_KEY": "0x1",
            "HYPERLIQUID_EXECUTION_ACCOUNT_ADDRESS": "0xabc",
            "HYPERLIQUID_EXECUTION_TRADE_COINS": "xyz:NVDA,xyz:MU",
        }
    )
    session = _PositionOnceSession(position_size=Decimal("-0.1"))
    exchange = _ServiceExchange(
        now,
        account_state=_account_state(now, position_size=Decimal("-0.1")),
    )
    service = HyperliquidExecutionService(
        config=config,
        feed=_TwoExecutableServiceFeed(now),
        exchange=exchange,
        mutation_coordinator=_MUTATION_COORDINATOR,
        recovery_worker=_ready_recovery_worker(),
    )

    result = service.run_once(session)

    assert result.signals_written == 1
    assert result.orders_submitted == 1
    assert exchange.reduce_only_closes == [("NVDA", Decimal("0.1"), Decimal("0.05"))]
    assert exchange.submitted_coins == []


def test_service_over_cap_runs_reduce_only_before_normal_orders() -> None:
    now = _now()
    config = HyperliquidExecutionConfig.from_env(
        {
            "HYPERLIQUID_EXECUTION_TRADING_ENABLED": "true",
            "HYPERLIQUID_EXECUTION_API_WALLET_PRIVATE_KEY": "0x1",
            "HYPERLIQUID_EXECUTION_ACCOUNT_ADDRESS": "0xabc",
            "HYPERLIQUID_EXECUTION_TRADE_COINS": "xyz:NVDA",
            "HYPERLIQUID_EXECUTION_TARGET_MARGIN_UTILIZATION": "0.20",
            "HYPERLIQUID_EXECUTION_MAX_SYMBOL_MARGIN_UTILIZATION": "0.05",
            "HYPERLIQUID_EXECUTION_MAX_ORDER_MARGIN_UTILIZATION": "0.02",
            "HYPERLIQUID_EXECUTION_MAINTENANCE_REDUCE_ONLY_CLOSE_ENABLED": "true",
        }
    )
    session = _FakeSession(
        risk_gross_exposure_usd=Decimal("1200"),
        risk_exposure_usd=Decimal("1200"),
    )
    exchange = _ServiceExchange(
        now,
        account_state=_account_state(
            now,
            gross_exposure_usd=Decimal("1200"),
            position_size=Decimal("12"),
            position_notional_usd=Decimal("1200"),
        ),
    )
    service = HyperliquidExecutionService(
        config=config,
        feed=_ServiceFeed(now),
        exchange=exchange,
        mutation_coordinator=_MUTATION_COORDINATOR,
        recovery_worker=_ready_recovery_worker(),
    )

    result = service.run_once(session)

    assert result.signals_written == 0
    assert result.orders_submitted == 1
    assert exchange.submitted_coins == []
    assert exchange.reduce_only_closes == [("NVDA", Decimal("12"), Decimal("0.05"))]
    maintenance = result.universe_details["maintenance_reduce_only"]
    assert isinstance(maintenance, dict)
    assert maintenance["over_cap"] is True
    assert maintenance["actions"][0]["reason"] == "symbol_margin_budget_exhausted"
    assert maintenance["actions"][0]["status"] == "filled"


class _PositionOnceSession(_FakeSession):
    def __init__(self, *, position_size: Decimal) -> None:
        super().__init__(position_size=position_size)
        self._position_reads = 0

    def _position_rows(self) -> list[dict[str, object]]:
        self._position_reads += 1
        if self._position_reads == 1:
            return super()._position_rows()
        return []
