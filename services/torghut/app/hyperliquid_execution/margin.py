"""Margin-aware sizing helpers for Hyperliquid execution."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from .config import HyperliquidExecutionConfig
from .models import RiskState


_ZERO = Decimal("0")
_ONE = Decimal("1")
_USD_QUANTUM = Decimal("0.000001")


@dataclass(frozen=True)
class MarginBudget:
    """Resolved margin budget for one candidate order."""

    coin: str
    equity_basis_usd: Decimal
    withdrawable_usd: Decimal
    max_leverage: Decimal
    target_margin_budget_usd: Decimal
    gross_margin_used_usd: Decimal
    remaining_gross_margin_usd: Decimal
    symbol_margin_budget_usd: Decimal
    symbol_margin_used_usd: Decimal
    remaining_symbol_margin_usd: Decimal
    order_margin_budget_usd: Decimal
    order_notional_capacity_usd: Decimal

    @property
    def over_budget(self) -> bool:
        return (
            self.remaining_gross_margin_usd <= _ZERO
            or self.remaining_symbol_margin_usd <= _ZERO
        )


@dataclass(frozen=True)
class _EquityBasis:
    equity_basis_usd: Decimal
    withdrawable_usd: Decimal


@dataclass(frozen=True)
class _MarginUse:
    target_budget_usd: Decimal
    gross_used_usd: Decimal
    remaining_gross_usd: Decimal
    symbol_budget_usd: Decimal
    symbol_used_usd: Decimal
    remaining_symbol_usd: Decimal
    order_budget_usd: Decimal
    order_notional_capacity_usd: Decimal


def resolve_margin_budget(
    *,
    coin: str,
    state: RiskState,
    config: HyperliquidExecutionConfig,
) -> tuple[MarginBudget | None, str | None]:
    """Return the margin-derived order capacity or a concrete blocker."""

    max_leverage = state.max_leverage_by_coin.get(coin)
    if max_leverage is None or max_leverage <= _ZERO:
        return None, "symbol_margin_metadata_missing"

    equity_basis, equity_blocker = _resolve_equity_basis(state)
    if equity_basis is None:
        return None, equity_blocker

    margin_use = _resolve_margin_use(
        coin=coin,
        state=state,
        config=config,
        max_leverage=max_leverage,
        equity_basis=equity_basis,
    )
    budget = _build_budget(
        coin=coin,
        max_leverage=max_leverage,
        equity_basis=equity_basis,
        margin_use=margin_use,
    )
    if margin_use.order_notional_capacity_usd < config.min_order_notional_usd:
        return budget, "margin_capacity_below_min_order"
    return budget, None


def gross_margin_used_usd(state: RiskState) -> Decimal:
    """Estimate current margin used from exposure and per-symbol max leverage."""

    used = _ZERO
    mapped_position_notional = _ZERO
    position_exposure_by_coin = state.position_exposure_usd_by_coin
    if position_exposure_by_coin is None:
        position_exposure_by_coin = state.symbol_exposure_usd_by_coin
    for coin, exposure_usd in state.symbol_exposure_usd_by_coin.items():
        leverage = state.max_leverage_by_coin.get(coin, _ONE)
        if leverage <= _ZERO:
            leverage = _ONE
        mapped_position_notional += abs(position_exposure_by_coin.get(coin, _ZERO))
        used += margin_for_notional(exposure_usd, leverage)

    raw_gross_exposure = _quantize_usd(abs(state.gross_exposure_usd))
    unmapped_notional = _nonnegative(raw_gross_exposure - mapped_position_notional)
    if unmapped_notional > _ZERO:
        used += margin_for_notional(
            unmapped_notional,
            _fallback_leverage_for_unmapped_exposure(state),
        )
    return _quantize_usd(used)


def margin_for_notional(notional_usd: Decimal, max_leverage: Decimal) -> Decimal:
    """Convert absolute notional into margin at the symbol's max leverage."""

    if max_leverage <= _ZERO:
        return _quantize_usd(abs(notional_usd))
    return _quantize_usd(abs(notional_usd) / max_leverage)


def over_budget_coins(
    *,
    state: RiskState,
    config: HyperliquidExecutionConfig,
) -> set[str]:
    """Return coins whose margin budget is already exhausted."""

    result: set[str] = set()
    for coin in state.symbol_exposure_usd_by_coin:
        budget, blocker = resolve_margin_budget(coin=coin, state=state, config=config)
        if blocker == "symbol_margin_metadata_missing":
            continue
        if budget is not None and budget.over_budget:
            result.add(coin)
    return result


def gross_margin_over_budget(
    *,
    state: RiskState,
    config: HyperliquidExecutionConfig,
) -> bool:
    """Return whether total margin use is at or above the configured budget."""

    equity_basis_usd = max(state.account_value_usd, state.withdrawable_usd)
    if equity_basis_usd <= _ZERO:
        return False
    target_margin_budget = _quantize_usd(
        equity_basis_usd * config.target_margin_utilization
    )
    return gross_margin_used_usd(state) >= target_margin_budget


def _resolve_equity_basis(state: RiskState) -> tuple[_EquityBasis | None, str | None]:
    equity_basis_usd = max(state.account_value_usd, state.withdrawable_usd)
    if equity_basis_usd <= _ZERO:
        return None, "account_equity_missing"
    withdrawable_usd = max(state.withdrawable_usd, _ZERO)
    return (
        _EquityBasis(
            equity_basis_usd=_quantize_usd(equity_basis_usd),
            withdrawable_usd=_quantize_usd(withdrawable_usd),
        ),
        None,
    )


def _resolve_margin_use(
    *,
    coin: str,
    state: RiskState,
    config: HyperliquidExecutionConfig,
    max_leverage: Decimal,
    equity_basis: _EquityBasis,
) -> _MarginUse:
    target_budget = _quantize_usd(
        equity_basis.equity_basis_usd * config.target_margin_utilization
    )
    gross_used = gross_margin_used_usd(state)
    remaining_gross = _nonnegative(target_budget - gross_used)
    symbol_used = margin_for_notional(
        state.symbol_exposure_usd_by_coin.get(coin, _ZERO),
        max_leverage,
    )
    symbol_budget = _quantize_usd(
        equity_basis.equity_basis_usd * config.max_symbol_margin_utilization
    )
    remaining_symbol = _nonnegative(symbol_budget - symbol_used)
    order_budget = _quantize_usd(
        equity_basis.equity_basis_usd * config.max_order_margin_utilization
    )
    order_margin = min(
        order_budget,
        remaining_gross,
        remaining_symbol,
        equity_basis.withdrawable_usd,
    )
    return _MarginUse(
        target_budget_usd=target_budget,
        gross_used_usd=gross_used,
        remaining_gross_usd=remaining_gross,
        symbol_budget_usd=symbol_budget,
        symbol_used_usd=symbol_used,
        remaining_symbol_usd=remaining_symbol,
        order_budget_usd=order_budget,
        order_notional_capacity_usd=_quantize_usd(order_margin * max_leverage),
    )


def _build_budget(
    *,
    coin: str,
    max_leverage: Decimal,
    equity_basis: _EquityBasis,
    margin_use: _MarginUse,
) -> MarginBudget:
    return MarginBudget(
        coin=coin,
        equity_basis_usd=equity_basis.equity_basis_usd,
        withdrawable_usd=equity_basis.withdrawable_usd,
        max_leverage=max_leverage,
        target_margin_budget_usd=margin_use.target_budget_usd,
        gross_margin_used_usd=margin_use.gross_used_usd,
        remaining_gross_margin_usd=margin_use.remaining_gross_usd,
        symbol_margin_budget_usd=margin_use.symbol_budget_usd,
        symbol_margin_used_usd=margin_use.symbol_used_usd,
        remaining_symbol_margin_usd=margin_use.remaining_symbol_usd,
        order_margin_budget_usd=margin_use.order_budget_usd,
        order_notional_capacity_usd=margin_use.order_notional_capacity_usd,
    )


def _nonnegative(value: Decimal) -> Decimal:
    return _quantize_usd(max(value, _ZERO))


def _fallback_leverage_for_unmapped_exposure(state: RiskState) -> Decimal:
    return _ONE


def _quantize_usd(value: Decimal) -> Decimal:
    return value.quantize(_USD_QUANTUM)
