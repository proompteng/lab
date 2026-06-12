from __future__ import annotations

# ruff: noqa: F401

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase

from app import config
from app.trading.execution_policy import ExecutionPolicy, ExecutionPolicyConfig
from app.trading.prices import MarketSnapshot
from app.trading.tca import AdaptiveExecutionPolicyDecision
from app.trading.models import StrategyDecision


def _config(**overrides: object) -> ExecutionPolicyConfig:
    base = ExecutionPolicyConfig(
        min_notional=None,
        max_notional=None,
        max_participation_rate=Decimal("0.1"),
        allow_shorts=False,
        kill_switch_enabled=False,
        prefer_limit=False,
        max_retries=0,
        backoff_base_seconds=0.1,
        backoff_multiplier=2.0,
        backoff_max_seconds=1.0,
    )
    return ExecutionPolicyConfig(**{**base.__dict__, **overrides})


def _decision(
    *,
    action: str = "buy",
    qty: Decimal = Decimal("10"),
    price: Decimal | None = Decimal("100"),
    order_type: str = "market",
) -> StrategyDecision:
    return StrategyDecision(
        strategy_id="strategy-1",
        symbol="AAPL",
        event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
        timeframe="1Min",
        action=action,
        qty=qty,
        order_type=order_type,
        time_in_force="day",
        params={"price": price} if price is not None else {},
    )


def _with_simple_lane_quantity_resolution(
    decision: StrategyDecision,
    **overrides: object,
) -> StrategyDecision:
    resolution: dict[str, object] = {
        "action": "sell",
        "reason": "sell_reducing_long_fractional_allowed",
        "symbol": "AAPL",
        "position_qty": "184",
        "requested_qty": "184.0000",
        "short_increasing": False,
    }
    resolution.update(overrides)
    params = dict(decision.params)
    params["simple_lane"] = {"quantity_resolution": resolution}
    return decision.model_copy(update={"params": params})


class _TestExecutionPolicyBase(TestCase):
    def setUp(self) -> None:
        self._advisor_enabled = config.settings.trading_execution_advisor_enabled
        self._advisor_staleness = (
            config.settings.trading_execution_advisor_max_staleness_seconds
        )
        self._advisor_timeout_ms = config.settings.trading_execution_advisor_timeout_ms
        self._advisor_live_apply = (
            config.settings.trading_execution_advisor_live_apply_enabled
        )
        self._fractional_equities_enabled = (
            config.settings.trading_fractional_equities_enabled
        )
        config.settings.trading_execution_advisor_enabled = False
        config.settings.trading_execution_advisor_live_apply_enabled = True
        config.settings.trading_execution_advisor_max_staleness_seconds = 15
        config.settings.trading_execution_advisor_timeout_ms = 250
        config.settings.trading_fractional_equities_enabled = False

    def tearDown(self) -> None:
        config.settings.trading_execution_advisor_enabled = self._advisor_enabled
        config.settings.trading_execution_advisor_live_apply_enabled = (
            self._advisor_live_apply
        )
        config.settings.trading_execution_advisor_max_staleness_seconds = (
            self._advisor_staleness
        )
        config.settings.trading_execution_advisor_timeout_ms = self._advisor_timeout_ms
        config.settings.trading_fractional_equities_enabled = (
            self._fractional_equities_enabled
        )


__all__ = [name for name in globals() if not name.startswith("__")]
