"""Risk checks for trade decisions."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Iterable, Mapping, Optional, cast

from sqlalchemy import desc, select
from sqlalchemy.orm import Session

from ..config import settings
from ..models import Strategy, TradeDecision
from .models import RiskCheckResult, StrategyDecision

FINAL_STATUSES = {"filled", "canceled", "rejected", "expired"}


class RiskEngine:
    """Apply trading risk constraints before execution."""

    def evaluate(
        self,
        session: Session,
        decision: StrategyDecision,
        strategy: Strategy,
        account: dict[str, str],
        positions: Iterable[dict[str, str]],
        allowed_symbols: Optional[set[str]] = None,
    ) -> RiskCheckResult:
        reasons: list[str] = []

        if not settings.trading_enabled:
            reasons.append("trading_disabled")
        if settings.trading_mode == "live" and not settings.trading_live_enabled:
            reasons.append("live_trading_disabled")

        if not strategy.enabled:
            reasons.append("strategy_disabled")

        if allowed_symbols is not None and decision.symbol not in allowed_symbols:
            reasons.append("symbol_not_allowed")

        price = _extract_decision_price(decision)
        if price is None:
            reasons.append("missing_price")

        qty = Decimal(str(decision.qty))
        notional = price * qty if price is not None else None
        position_qty, position_value = _position_summary(decision.symbol, positions)
        short_increasing = _is_short_increasing(decision.action, qty, position_qty)
        allocator_meta = _allocator_payload(decision)
        fragility_state = _fragility_state_from_allocator(allocator_meta)
        stability_mode_active = bool(allocator_meta.get("stability_mode_active", False))
        if settings.trading_fragility_mode == "enforce":
            if fragility_state in {"stress", "crisis"} and not stability_mode_active:
                reasons.append("fragility_stability_mode_mismatch")
            if fragility_state == "crisis" and _is_risk_increasing_trade(
                decision.action, qty, position_qty, short_increasing
            ):
                reasons.append("fragility_crisis_entry_blocked")

        max_notional = _resolve_decimal(strategy.max_notional_per_trade) or _resolve_decimal(
            settings.trading_max_notional_per_trade
        )
        enforce_notional = decision.action == "buy" or short_increasing
        if enforce_notional and notional is not None and max_notional is not None and notional > max_notional:
            reasons.append("max_notional_exceeded")

        equity = _resolve_decimal(account.get("equity"))
        buying_power = _resolve_decimal(account.get("buying_power"))
        if enforce_notional and notional is not None and buying_power is not None and notional > buying_power:
            reasons.append("insufficient_buying_power")

        max_pct = _resolve_decimal(strategy.max_position_pct_equity) or _resolve_decimal(
            settings.trading_max_position_pct_equity
        )
        if max_pct is not None and equity is not None and notional is not None:
            delta = notional if decision.action == "buy" else -notional
            projected_value = position_value + delta
            current_abs = abs(position_value)
            projected_abs = abs(projected_value)
            if projected_abs > equity * max_pct and projected_abs >= current_abs:
                reasons.append("max_position_pct_exceeded")

        allocator_cap_notional = _allocator_approved_notional(decision)
        if (
            enforce_notional
            and allocator_cap_notional is not None
            and notional is not None
            and notional > allocator_cap_notional
        ):
            reasons.append("allocator_notional_invariant_breached")

        if short_increasing and not settings.trading_allow_shorts:
            reasons.append("shorts_not_allowed")

        cooldown_seconds = settings.trading_cooldown_seconds
        if cooldown_seconds > 0:
            recent_cutoff = datetime.now(timezone.utc) - timedelta(seconds=cooldown_seconds)
            stmt = (
                select(TradeDecision)
                .where(TradeDecision.symbol == decision.symbol)
                .where(TradeDecision.created_at >= recent_cutoff)
                .order_by(desc(TradeDecision.created_at))
                .limit(1)
            )
            recent = session.execute(stmt).scalar_one_or_none()
            if recent and recent.status != "rejected":
                reasons.append("cooldown_active")

        return RiskCheckResult(approved=len(reasons) == 0, reasons=reasons)


def _extract_decision_price(decision: StrategyDecision) -> Optional[Decimal]:
    for key in ("price", "limit_price", "stop_price"):
        value = decision.params.get(key)
        if value is None:
            value = getattr(decision, key, None)
        if value is not None:
            try:
                return Decimal(str(value))
            except (ArithmeticError, ValueError):
                continue
    return None


def _resolve_decimal(value: Optional[Decimal | str | float]) -> Optional[Decimal]:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (ArithmeticError, ValueError):
        return None


def _position_summary(symbol: str, positions: Iterable[dict[str, str]]) -> tuple[Decimal, Decimal]:
    total_qty = Decimal("0")
    total_value = Decimal("0")
    for position in positions:
        if position.get("symbol") != symbol:
            continue
        qty = _optional_decimal(position.get("qty"))
        if qty is None:
            qty = _optional_decimal(position.get("quantity"))
        side = str(position.get("side") or "").lower()
        if qty is not None and side == "short":
            qty = -abs(qty)
        if qty is not None:
            total_qty += qty

        market_value = _optional_decimal(position.get("market_value"))
        if market_value is None:
            continue
        total_value += market_value
    return total_qty, total_value


def _is_short_increasing(action: str, qty: Decimal, position_qty: Decimal) -> bool:
    if action == "buy":
        return False
    if position_qty <= 0:
        return True
    return qty > position_qty


def _optional_decimal(value: Optional[Decimal | str | float]) -> Optional[Decimal]:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (ArithmeticError, ValueError):
        return None


def _allocator_payload(decision: StrategyDecision) -> dict[str, object]:
    raw = decision.params.get("allocator")
    if not isinstance(raw, dict):
        return {}
    payload = cast(dict[object, object], raw)
    return {str(key): value for key, value in payload.items()}


def _fragility_state_from_allocator(allocator: dict[str, object]) -> str:
    raw = allocator.get("fragility_state")
    if not isinstance(raw, str):
        return "elevated"
    normalized = raw.strip().lower()
    if normalized in {"normal", "elevated", "stress", "crisis"}:
        return normalized
    return "elevated"


def _is_risk_increasing_trade(
    action: str, qty: Decimal, position_qty: Decimal, short_increasing: bool
) -> bool:
    if action == "buy":
        if position_qty < 0:
            return qty > abs(position_qty)
        return qty > 0
    return short_increasing


def _allocator_approved_notional(decision: StrategyDecision) -> Optional[Decimal]:
    allocator = decision.params.get("allocator")
    if not isinstance(allocator, Mapping):
        return None
    payload = cast(Mapping[str, object], allocator)
    return _resolve_decimal(cast(Decimal | str | float | None, payload.get("approved_notional")))


__all__ = ["RiskEngine", "FINAL_STATUSES"]
