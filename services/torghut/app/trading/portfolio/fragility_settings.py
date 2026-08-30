"""Settings-backed fragility monitor factory."""

from __future__ import annotations

from decimal import Decimal

from ...config import settings
from ..fragility import FragilityMonitor, FragilityMonitorConfig
from .allocation_helpers import (
    fragility_decimal_map,
    optional_decimal,
    tighten_multiplier,
)


def fragility_monitor_from_settings() -> FragilityMonitor:
    return FragilityMonitor(
        FragilityMonitorConfig(
            mode=settings.trading_fragility_mode,
            unknown_state=settings.trading_fragility_unknown_state,
            elevated_threshold=optional_decimal(
                settings.trading_fragility_elevated_threshold
            )
            or Decimal("0.35"),
            stress_threshold=optional_decimal(
                settings.trading_fragility_stress_threshold
            )
            or Decimal("0.55"),
            crisis_threshold=optional_decimal(
                settings.trading_fragility_crisis_threshold
            )
            or Decimal("0.80"),
            state_budget_multipliers={
                key: tighten_multiplier(value)
                for key, value in fragility_decimal_map(
                    settings.trading_fragility_state_budget_multipliers
                ).items()
            },
            state_capacity_multipliers={
                key: tighten_multiplier(value)
                for key, value in fragility_decimal_map(
                    settings.trading_fragility_state_capacity_multipliers
                ).items()
            },
            state_participation_clamps={
                key: tighten_multiplier(value)
                for key, value in fragility_decimal_map(
                    settings.trading_fragility_state_participation_clamps
                ).items()
            },
            state_abstain_bias={
                key: tighten_multiplier(value)
                for key, value in fragility_decimal_map(
                    settings.trading_fragility_state_abstain_bias
                ).items()
            },
        )
    )


__all__ = ["fragility_monitor_from_settings"]
