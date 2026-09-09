"""After-cost profitability guard for Hyperliquid execution."""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime
from decimal import Decimal

from .config import HyperliquidExecutionConfig
from .models import OrderSide, RiskVerdict, Signal


@dataclass(frozen=True)
class SymbolProfitabilityState:
    """Rolling execution quality for one symbol."""

    coin: str
    account_value_usd: Decimal
    net_pnl_after_fees_usd_24h: Decimal
    notional_usd_1h: Decimal
    last_entry_at: datetime | None = None
    last_side: OrderSide | None = None
    last_side_at: datetime | None = None
    last_position_close_side: OrderSide | None = None
    last_position_close_at: datetime | None = None


@dataclass(frozen=True)
class ProfitabilityGateResult:
    """Pre-submit profitability gate result."""

    allowed: bool
    reason: str
    expected_edge_bps: Decimal
    expected_cost_bps: Decimal
    after_cost_edge_bps: Decimal
    edge_cost_ratio: Decimal
    net_pnl_after_fees_usd_24h: Decimal
    notional_usd_1h: Decimal
    turnover_equity_multiple_1h: Decimal
    last_entry_age_seconds: int | None
    last_side: str | None
    last_side_age_seconds: int | None
    last_position_close_side: str | None
    last_position_close_age_seconds: int | None

    def to_details(self) -> dict[str, object]:
        return {
            "allowed": self.allowed,
            "reason": self.reason,
            "expected_edge_bps": str(self.expected_edge_bps),
            "expected_cost_bps": str(self.expected_cost_bps),
            "after_cost_edge_bps": str(self.after_cost_edge_bps),
            "edge_cost_ratio": str(self.edge_cost_ratio),
            "net_pnl_after_fees_usd_24h": str(self.net_pnl_after_fees_usd_24h),
            "notional_usd_1h": str(self.notional_usd_1h),
            "turnover_equity_multiple_1h": str(self.turnover_equity_multiple_1h),
            "last_entry_age_seconds": self.last_entry_age_seconds,
            "last_side": self.last_side,
            "last_side_age_seconds": self.last_side_age_seconds,
            "last_position_close_side": self.last_position_close_side,
            "last_position_close_age_seconds": self.last_position_close_age_seconds,
        }


def evaluate_profitability_gate(
    *,
    signal: Signal,
    verdict: RiskVerdict,
    state: SymbolProfitabilityState,
    config: HyperliquidExecutionConfig,
    now: datetime,
) -> ProfitabilityGateResult:
    """Return whether a normal entry has positive enough after-cost evidence."""

    expected_edge = abs(signal.edge_bps)
    expected_cost = _expected_cost_bps(verdict, config)
    after_cost_edge = expected_edge - expected_cost
    edge_cost_ratio = _edge_cost_ratio(expected_edge, expected_cost)
    turnover_multiple = _turnover_multiple(state)
    last_entry_age = _age_seconds(now, state.last_entry_at)
    last_side_age = _age_seconds(now, state.last_side_at)
    last_position_close_age = _age_seconds(now, state.last_position_close_at)
    reason = _blocked_reason(
        signal=signal,
        state=state,
        config=config,
        after_cost_edge=after_cost_edge,
        edge_cost_ratio=edge_cost_ratio,
        turnover_multiple=turnover_multiple,
        last_entry_age=last_entry_age,
        last_side_age=last_side_age,
        last_position_close_age=last_position_close_age,
    )
    return ProfitabilityGateResult(
        allowed=reason is None,
        reason=reason or "allowed",
        expected_edge_bps=expected_edge,
        expected_cost_bps=expected_cost,
        after_cost_edge_bps=after_cost_edge,
        edge_cost_ratio=edge_cost_ratio,
        net_pnl_after_fees_usd_24h=state.net_pnl_after_fees_usd_24h,
        notional_usd_1h=state.notional_usd_1h,
        turnover_equity_multiple_1h=turnover_multiple,
        last_entry_age_seconds=last_entry_age,
        last_side=state.last_side,
        last_side_age_seconds=last_side_age,
        last_position_close_side=state.last_position_close_side,
        last_position_close_age_seconds=last_position_close_age,
    )


def profitability_blocked_verdict(
    verdict: RiskVerdict,
    reason: str,
) -> RiskVerdict:
    """Preserve risk diagnostics while blocking the portfolio target."""

    blocked_target = verdict.portfolio_target
    if blocked_target is not None:
        blocked_target = replace(
            blocked_target,
            target_notional_usd=Decimal("0"),
            delta_notional_usd=Decimal("0"),
            clip_reason=reason,
        )
    return RiskVerdict(
        "blocked",
        reason,
        Decimal("0"),
        verdict.risk_forecast,
        blocked_target,
    )


def _expected_cost_bps(
    verdict: RiskVerdict,
    config: HyperliquidExecutionConfig,
) -> Decimal:
    if verdict.portfolio_target is None:
        return config.cost_buffer_bps
    return verdict.portfolio_target.expected_cost_bps


def _edge_cost_ratio(edge_bps: Decimal, cost_bps: Decimal) -> Decimal:
    if cost_bps <= Decimal("0"):
        return Decimal("999999") if edge_bps > Decimal("0") else Decimal("0")
    return (edge_bps / cost_bps).quantize(Decimal("0.000001"))


def _turnover_multiple(state: SymbolProfitabilityState) -> Decimal:
    if state.account_value_usd <= Decimal("0"):
        return Decimal("0")
    return (state.notional_usd_1h / state.account_value_usd).quantize(
        Decimal("0.000001")
    )


def _age_seconds(now: datetime, observed_at: datetime | None) -> int | None:
    if observed_at is None:
        return None
    return max(0, int((now - observed_at).total_seconds()))


def _blocked_reason(
    *,
    signal: Signal,
    state: SymbolProfitabilityState,
    config: HyperliquidExecutionConfig,
    after_cost_edge: Decimal,
    edge_cost_ratio: Decimal,
    turnover_multiple: Decimal,
    last_entry_age: int | None,
    last_side_age: int | None,
    last_position_close_age: int | None,
) -> str | None:
    if state.account_value_usd <= Decimal("0"):
        return "profitability_account_value_unavailable"
    if after_cost_edge < config.min_after_cost_edge_bps:
        return "profitability_after_cost_edge_below_floor"
    if edge_cost_ratio < config.min_edge_cost_ratio:
        return "profitability_edge_cost_ratio_below_floor"
    if state.net_pnl_after_fees_usd_24h < Decimal("0"):
        return "profitability_symbol_net_pnl_24h_negative"
    if turnover_multiple >= config.max_symbol_turnover_equity_multiple_1h:
        return "profitability_symbol_turnover_cap"
    if (
        last_entry_age is not None
        and last_entry_age < config.min_seconds_between_symbol_entries
    ):
        return "profitability_symbol_entry_cooldown"
    if (
        state.last_position_close_side is not None
        and state.last_position_close_side == signal.action
        and last_position_close_age is not None
        and last_position_close_age < config.min_seconds_between_side_flip
    ):
        return "profitability_side_flip_cooldown"
    if (
        state.last_side is not None
        and state.last_side != signal.action
        and last_side_age is not None
        and last_side_age < config.min_seconds_between_side_flip
    ):
        return "profitability_side_flip_cooldown"
    return None
