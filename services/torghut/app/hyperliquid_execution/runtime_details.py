"""Reportable runtime details for Hyperliquid execution."""

from __future__ import annotations

from typing import cast

from .config import HyperliquidExecutionConfig
from .models import ExecutionMarket, RiskState, RuntimeDependencyStatus
from .risk import effective_daily_loss_limit_usd


def risk_state_details(
    risk_state: RiskState,
    config: HyperliquidExecutionConfig,
) -> dict[str, object]:
    return {
        "account_value_usd": str(risk_state.account_value_usd),
        "withdrawable_usd": str(risk_state.withdrawable_usd),
        "gross_exposure_usd": str(risk_state.gross_exposure_usd),
        "daily_realized_pnl_usd": str(risk_state.daily_realized_pnl_usd),
        "configured_daily_loss_floor_usd": str(config.max_daily_loss_usd),
        "effective_daily_loss_limit_usd": str(
            effective_daily_loss_limit_usd(risk_state, config)
        ),
    }


def universe_details(
    feed_details: dict[str, object],
    execution_statuses: tuple[RuntimeDependencyStatus, RuntimeDependencyStatus],
    feature_status: RuntimeDependencyStatus,
    selected_markets: tuple[ExecutionMarket, ...],
    execution_metadata_details: dict[str, object],
) -> dict[str, object]:
    execution_status, liquidity_status = execution_statuses
    details = dict(feed_details)
    details.update(execution_status.details)
    details["liquidity"] = dict(liquidity_status.details)
    details.update(execution_metadata_details)
    details["selected_execution_metadata"] = _string_list_detail(
        details.get("selected")
    )
    details["selected"] = [market.coin for market in selected_markets]
    details["fresh_features"] = _string_list_detail(
        feature_status.details.get("features")
    )
    details["missing_fresh_features"] = _string_list_detail(
        feature_status.details.get("missing")
    )
    return details


def _string_list_detail(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item) for item in cast(list[object], value)]
