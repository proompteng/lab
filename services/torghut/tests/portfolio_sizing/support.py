from __future__ import annotations

# ruff: noqa: F401

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase

from app import config
from app.models import Strategy
from app.trading.models import StrategyDecision
from app.trading.portfolio import (
    ALLOCATOR_CLIP_CORRELATION_CAPACITY,
    ALLOCATOR_CLIP_SYMBOL_CAPACITY,
    ALLOCATOR_CLIP_SYMBOL_BUDGET,
    ALLOCATOR_CLIP_STRATEGY_BUDGET,
    ALLOCATOR_REJECT_CORRELATION_CAPACITY,
    ALLOCATOR_REJECT_GROSS_EXPOSURE,
    ALLOCATOR_REJECT_SYMBOL_CAPACITY,
    ALLOCATOR_REGIME_LOW_CONFIDENCE,
    ALLOCATOR_STRATEGY_FACTORY_BASELINE_FAIL,
    ALLOCATOR_STRATEGY_FACTORY_OBSERVE_ONLY,
    AllocationConfig,
    IntentAggregator,
    PortfolioAllocator,
    PortfolioSizingConfig,
    PortfolioSizer,
    allocator_from_settings,
    sizer_from_settings,
)


class _TestPortfolioSizingBase(TestCase):
    def setUp(self) -> None:
        self._original_fractional_equities_enabled = (
            config.settings.trading_fractional_equities_enabled
        )

    def tearDown(self) -> None:
        config.settings.trading_fractional_equities_enabled = (
            self._original_fractional_equities_enabled
        )


__all__ = [name for name in globals() if not name.startswith("__")]
