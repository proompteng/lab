"""Settings-backed portfolio sizing and allocation factories."""

from __future__ import annotations

from decimal import Decimal
from typing import Optional

from ...config import settings
from ...models import Strategy
from .allocation_helpers import (
    decimal_map,
    min_decimal,
    normalize_regime_label,
    optional_decimal,
    pct_equity_cap,
)
from .allocation_types import (
    AllocationConfig,
    PortfolioSizer,
    PortfolioSizingConfig,
)
from .allocator import PortfolioAllocator
from .fragility_settings import fragility_monitor_from_settings


def sizer_from_settings(
    strategy: Strategy, equity: Optional[Decimal]
) -> PortfolioSizer:
    return PortfolioSizer(_config_from_settings(strategy, equity))


def allocator_from_settings(equity: Optional[Decimal]) -> PortfolioAllocator:
    max_gross_exposure = min_decimal(
        optional_decimal(settings.trading_portfolio_max_gross_exposure),
        pct_equity_cap(
            optional_decimal(settings.trading_portfolio_max_gross_exposure_pct_equity),
            equity,
        ),
    )
    correlation_group_caps = dict(settings.trading_allocator_correlation_group_caps)
    symbol_correlation_groups = dict(
        settings.trading_allocator_symbol_correlation_groups
    )
    return PortfolioAllocator(
        AllocationConfig(
            enabled=settings.trading_allocator_enabled,
            default_regime=normalize_regime_label(
                settings.trading_allocator_default_regime,
                default="neutral",
            ),
            default_budget_multiplier=optional_decimal(
                settings.trading_allocator_default_budget_multiplier
            )
            or Decimal("1"),
            default_capacity_multiplier=optional_decimal(
                settings.trading_allocator_default_capacity_multiplier
            )
            or Decimal("1"),
            regime_low_confidence_threshold=optional_decimal(
                settings.trading_allocator_regime_low_confidence_threshold
            )
            or Decimal("0.6"),
            regime_low_confidence_multiplier=optional_decimal(
                settings.trading_allocator_regime_low_confidence_multiplier
            )
            or Decimal("0.7"),
            min_multiplier=optional_decimal(settings.trading_allocator_min_multiplier)
            or Decimal("0"),
            max_multiplier=optional_decimal(settings.trading_allocator_max_multiplier)
            or Decimal("2"),
            max_symbol_pct_equity=min_decimal(
                optional_decimal(settings.trading_allocator_max_symbol_pct_equity),
                optional_decimal(settings.trading_max_position_pct_equity),
            ),
            max_symbol_notional=min_decimal(
                optional_decimal(settings.trading_allocator_max_symbol_notional),
                optional_decimal(settings.trading_portfolio_max_notional_per_symbol),
            ),
            max_gross_exposure=max_gross_exposure,
            strategy_notional_caps=decimal_map(
                settings.trading_allocator_strategy_notional_caps
            ),
            symbol_notional_caps=decimal_map(
                settings.trading_allocator_symbol_notional_caps,
                normalize_key=lambda key: key.strip().upper(),
            ),
            correlation_group_caps=decimal_map(
                correlation_group_caps,
                normalize_key=lambda key: key.strip().lower(),
            ),
            symbol_correlation_groups={
                str(key).strip().upper(): str(value).strip().lower()
                for key, value in symbol_correlation_groups.items()
                if str(key).strip() and str(value).strip()
            },
            regime_budget_multipliers=decimal_map(
                settings.trading_allocator_regime_budget_multipliers
            ),
            regime_capacity_multipliers=decimal_map(
                settings.trading_allocator_regime_capacity_multipliers
            ),
        )
    )


def _config_from_settings(
    strategy: Strategy, equity: Optional[Decimal]
) -> PortfolioSizingConfig:
    # Keep per-trade max-notional checks in RiskEngine; symbol caps should only
    # come from dedicated portfolio concentration settings.
    max_notional_per_symbol = optional_decimal(
        settings.trading_portfolio_max_notional_per_symbol
    )
    max_pct_equity = min_decimal(
        optional_decimal(strategy.max_position_pct_equity),
        optional_decimal(settings.trading_max_position_pct_equity),
    )
    gross_cap = min_decimal(
        optional_decimal(settings.trading_portfolio_max_gross_exposure),
        pct_equity_cap(
            optional_decimal(settings.trading_portfolio_max_gross_exposure_pct_equity),
            equity,
        ),
    )
    net_cap = min_decimal(
        optional_decimal(settings.trading_portfolio_max_net_exposure),
        pct_equity_cap(
            optional_decimal(settings.trading_portfolio_max_net_exposure_pct_equity),
            equity,
        ),
    )
    return PortfolioSizingConfig(
        notional_per_position=optional_decimal(
            settings.trading_portfolio_notional_per_position
        ),
        volatility_target=optional_decimal(
            settings.trading_portfolio_volatility_target
        ),
        volatility_floor=optional_decimal(settings.trading_portfolio_volatility_floor)
        or Decimal("0"),
        max_positions=settings.trading_portfolio_max_positions,
        max_notional_per_symbol=max_notional_per_symbol,
        max_position_pct_equity=max_pct_equity,
        max_gross_exposure=gross_cap,
        max_net_exposure=net_cap,
    )


__all__ = [
    "allocator_from_settings",
    "fragility_monitor_from_settings",
    "sizer_from_settings",
]
