"""Trading pipeline implementation."""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import TYPE_CHECKING


from ...autonomy.phase_manifest_contract import AUTONOMY_PHASE_ORDER


logger = logging.getLogger(__name__)

REJECTED_SIGNAL_OUTCOME_FOLLOWUP_HORIZON = timedelta(minutes=5)

REJECTED_SIGNAL_OUTCOME_LABEL_LIMIT = 25

AUTONOMY_PHASE_ORDER_VALUES: tuple[str, ...] = AUTONOMY_PHASE_ORDER

RUNTIME_UNCERTAINTY_DEGRADE_QTY_MULTIPLIER = Decimal("0.50")

RUNTIME_UNCERTAINTY_DEGRADE_MAX_PARTICIPATION_RATE = Decimal("0.05")

RUNTIME_UNCERTAINTY_DEGRADE_MIN_EXECUTION_SECONDS = 120

RUNTIME_REGIME_CONFIDENCE_DEFAULT_THRESHOLDS = (Decimal("0.75"), Decimal("0.55"))

STRATEGY_POSITION_TAG_TOLERANCE = Decimal("0.0001")

STRATEGY_POSITION_TAG_LOOKBACK = timedelta(days=7)


def normalized_symbol(symbol: object) -> str:
    return str(symbol or "").strip().upper()


def aware_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def same_side_position_exposure(position_qty: Decimal, exposure_qty: Decimal) -> bool:
    if position_qty == 0 or exposure_qty == 0:
        return False
    return (position_qty > 0 and exposure_qty > 0) or (
        position_qty < 0 and exposure_qty < 0
    )


if TYPE_CHECKING:
    from .runtime_contract import TradingPipelineInteractions as TradingPipelineRuntime
else:
    TradingPipelineRuntime = object

__all__ = [
    "AUTONOMY_PHASE_ORDER_VALUES",
    "REJECTED_SIGNAL_OUTCOME_FOLLOWUP_HORIZON",
    "REJECTED_SIGNAL_OUTCOME_LABEL_LIMIT",
    "RUNTIME_REGIME_CONFIDENCE_DEFAULT_THRESHOLDS",
    "RUNTIME_UNCERTAINTY_DEGRADE_MAX_PARTICIPATION_RATE",
    "RUNTIME_UNCERTAINTY_DEGRADE_MIN_EXECUTION_SECONDS",
    "RUNTIME_UNCERTAINTY_DEGRADE_QTY_MULTIPLIER",
    "STRATEGY_POSITION_TAG_LOOKBACK",
    "STRATEGY_POSITION_TAG_TOLERANCE",
    "TradingPipelineRuntime",
    "aware_utc",
    "normalized_symbol",
    "same_side_position_exposure",
]
