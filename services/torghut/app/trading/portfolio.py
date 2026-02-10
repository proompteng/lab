"""Deterministic portfolio sizing helpers."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_DOWN, Decimal
from typing import Any, Iterable, Optional

from ..config import settings
from ..models import Strategy
from .models import StrategyDecision


@dataclass(frozen=True)
class PortfolioSizingConfig:
    notional_per_position: Optional[Decimal]
    volatility_target: Optional[Decimal]
    volatility_floor: Decimal
    max_positions: Optional[int]
    max_notional_per_symbol: Optional[Decimal]
    max_position_pct_equity: Optional[Decimal]
    max_gross_exposure: Optional[Decimal]
    max_net_exposure: Optional[Decimal]


@dataclass(frozen=True)
class PortfolioSizingResult:
    decision: StrategyDecision
    approved: bool
    reasons: list[str]
    audit: dict[str, Any]


class PortfolioSizer:
    """Apply deterministic portfolio sizing rules."""

    def __init__(self, config: PortfolioSizingConfig) -> None:
        self.config = config

    def size(
        self,
        decision: StrategyDecision,
        *,
        account: dict[str, str],
        positions: Iterable[dict[str, Any]],
    ) -> PortfolioSizingResult:
        price = _extract_decision_price(decision)
        volatility = _optional_decimal(decision.params.get("volatility"))
        equity = _optional_decimal(account.get("equity"))

        current_positions = list(positions)
        current_count = _count_positions(current_positions)
        current_qty, current_value = _position_summary(decision.symbol, current_positions)
        gross_exposure, net_exposure = _portfolio_exposure(current_positions)

        audit: dict[str, Any] = {
            "inputs": {
                "symbol": decision.symbol,
                "action": decision.action,
                "base_qty": str(decision.qty),
                "price": _decimal_str(price),
                "volatility": _decimal_str(volatility),
                "equity": _decimal_str(equity),
                "current_positions": current_count,
                "current_symbol_qty": _decimal_str(current_qty),
                "current_symbol_value": _decimal_str(current_value),
                "gross_exposure": _decimal_str(gross_exposure),
                "net_exposure": _decimal_str(net_exposure),
            },
            "config": _config_payload(self.config),
            "output": {},
        }

        if price is None or price <= 0:
            audit["output"] = {"status": "skipped", "reason": "missing_price"}
            return PortfolioSizingResult(decision=decision, approved=True, reasons=[], audit=audit)

        base_notional = price * decision.qty
        notional = self._resolve_base_notional(base_notional)
        if notional is None or notional <= 0:
            audit["output"] = {"status": "skipped", "reason": "missing_notional"}
            return PortfolioSizingResult(decision=decision, approved=True, reasons=[], audit=audit)

        notional, vol_method = self._apply_volatility_scaling(notional, volatility)
        applied_methods = [method for method in (vol_method,) if method]

        reasons: list[str] = []
        if _should_block_new_position(self.config.max_positions, current_count, current_qty):
            reasons.append("max_positions_exceeded")

        caps: dict[str, Optional[Decimal]] = {}
        symbol_cap = _min_decimal(
            self.config.max_notional_per_symbol,
            _pct_equity_cap(self.config.max_position_pct_equity, equity),
        )
        if symbol_cap is not None:
            caps["per_symbol"] = symbol_cap

        gross_cap = _gross_cap_for_symbol(
            self.config.max_gross_exposure,
            gross_exposure,
            current_value,
            decision.action,
        )
        if gross_cap is not None:
            caps["gross_exposure"] = gross_cap

        net_cap = _net_cap_for_trade(self.config.max_net_exposure, net_exposure, decision.action)
        if net_cap is not None:
            caps["net_exposure"] = net_cap

        if caps:
            notional, cap_methods = _apply_caps(notional, caps)
            applied_methods.extend(cap_methods)

        qty = (notional / price).quantize(Decimal("1"), rounding=ROUND_DOWN)
        if qty < 1:
            reasons.append("qty_below_min")

        approved = len(reasons) == 0
        if not approved:
            qty = Decimal("0")
            notional = Decimal("0")

        audit["output"] = {
            "status": "approved" if approved else "rejected",
            "final_qty": _decimal_str(qty),
            "final_notional": _decimal_str(notional),
            "methods": applied_methods,
            "caps": {key: _decimal_str(value) for key, value in caps.items()},
            "reasons": list(reasons),
        }

        updated_params = dict(decision.params)
        updated_params["portfolio_sizing"] = audit
        updated_decision = decision.model_copy(update={"qty": qty, "params": updated_params})
        return PortfolioSizingResult(decision=updated_decision, approved=approved, reasons=reasons, audit=audit)

    def _resolve_base_notional(self, base_notional: Decimal) -> Optional[Decimal]:
        if self.config.notional_per_position is not None and self.config.notional_per_position > 0:
            return self.config.notional_per_position
        return base_notional

    def _apply_volatility_scaling(
        self, notional: Decimal, volatility: Optional[Decimal]
    ) -> tuple[Decimal, Optional[str]]:
        if self.config.volatility_target is None or self.config.volatility_target <= 0:
            return notional, None
        if volatility is None or volatility <= 0:
            return notional, "volatility_missing"
        effective_vol = max(volatility, self.config.volatility_floor)
        if effective_vol <= 0:
            return notional, "volatility_floor_zero"
        scaled = notional * (self.config.volatility_target / effective_vol)
        return scaled, "volatility_scaled"


def sizer_from_settings(strategy: Strategy, equity: Optional[Decimal]) -> PortfolioSizer:
    return PortfolioSizer(_config_from_settings(strategy, equity))


def _config_from_settings(strategy: Strategy, equity: Optional[Decimal]) -> PortfolioSizingConfig:
    max_notional = _min_decimal(
        _optional_decimal(strategy.max_notional_per_trade),
        _optional_decimal(settings.trading_max_notional_per_trade),
        _optional_decimal(settings.trading_portfolio_max_notional_per_symbol),
    )
    max_pct_equity = _min_decimal(
        _optional_decimal(strategy.max_position_pct_equity),
        _optional_decimal(settings.trading_max_position_pct_equity),
    )
    gross_cap = _min_decimal(
        _optional_decimal(settings.trading_portfolio_max_gross_exposure),
        _pct_equity_cap(_optional_decimal(settings.trading_portfolio_max_gross_exposure_pct_equity), equity),
    )
    net_cap = _min_decimal(
        _optional_decimal(settings.trading_portfolio_max_net_exposure),
        _pct_equity_cap(_optional_decimal(settings.trading_portfolio_max_net_exposure_pct_equity), equity),
    )
    return PortfolioSizingConfig(
        notional_per_position=_optional_decimal(settings.trading_portfolio_notional_per_position),
        volatility_target=_optional_decimal(settings.trading_portfolio_volatility_target),
        volatility_floor=_optional_decimal(settings.trading_portfolio_volatility_floor) or Decimal("0"),
        max_positions=settings.trading_portfolio_max_positions,
        max_notional_per_symbol=max_notional,
        max_position_pct_equity=max_pct_equity,
        max_gross_exposure=gross_cap,
        max_net_exposure=net_cap,
    )


def _should_block_new_position(
    max_positions: Optional[int], current_count: int, current_qty: Decimal
) -> bool:
    if max_positions is None or max_positions <= 0:
        return False
    if current_qty != 0:
        return False
    return current_count >= max_positions


def _count_positions(positions: Iterable[dict[str, Any]]) -> int:
    count = 0
    for position in positions:
        qty = _optional_decimal(position.get("qty") or position.get("quantity"))
        if qty is None or qty == 0:
            continue
        count += 1
    return count


def _portfolio_exposure(positions: Iterable[dict[str, Any]]) -> tuple[Decimal, Decimal]:
    gross = Decimal("0")
    net = Decimal("0")
    for position in positions:
        value = _optional_decimal(position.get("market_value"))
        if value is None:
            continue
        gross += abs(value)
        net += value
    return gross, net


def _position_summary(symbol: str, positions: Iterable[dict[str, Any]]) -> tuple[Decimal, Decimal]:
    total_qty = Decimal("0")
    total_value = Decimal("0")
    for position in positions:
        if position.get("symbol") != symbol:
            continue
        qty = _optional_decimal(position.get("qty") or position.get("quantity"))
        side = str(position.get("side") or "").lower()
        if qty is not None and side == "short":
            qty = -abs(qty)
        if qty is not None:
            total_qty += qty
        value = _optional_decimal(position.get("market_value"))
        if value is not None:
            total_value += value
    return total_qty, total_value


def _gross_cap_for_symbol(
    max_gross: Optional[Decimal],
    current_gross: Decimal,
    current_value: Decimal,
    action: str,
) -> Optional[Decimal]:
    if max_gross is None or max_gross <= 0:
        return None
    gross_cap_for_symbol = max_gross - (current_gross - abs(current_value))
    if gross_cap_for_symbol <= 0:
        return Decimal("0")
    if action == "buy":
        return gross_cap_for_symbol - current_value
    return gross_cap_for_symbol + current_value


def _net_cap_for_trade(max_net: Optional[Decimal], current_net: Decimal, action: str) -> Optional[Decimal]:
    if max_net is None or max_net <= 0:
        return None
    if action == "buy":
        return max_net - current_net
    return max_net + current_net


def _apply_caps(
    notional: Decimal, caps: dict[str, Optional[Decimal]]
) -> tuple[Decimal, list[str]]:
    methods: list[str] = []
    capped = notional
    for key, value in caps.items():
        if value is None:
            continue
        if value <= 0:
            capped = Decimal("0")
            methods.append(f"cap_{key}_zero")
            continue
        if capped > value:
            capped = value
            methods.append(f"cap_{key}")
    return capped, methods


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


def _config_payload(config: PortfolioSizingConfig) -> dict[str, Any]:
    return {
        "notional_per_position": _decimal_str(config.notional_per_position),
        "volatility_target": _decimal_str(config.volatility_target),
        "volatility_floor": _decimal_str(config.volatility_floor),
        "max_positions": config.max_positions,
        "max_notional_per_symbol": _decimal_str(config.max_notional_per_symbol),
        "max_position_pct_equity": _decimal_str(config.max_position_pct_equity),
        "max_gross_exposure": _decimal_str(config.max_gross_exposure),
        "max_net_exposure": _decimal_str(config.max_net_exposure),
    }


def _pct_equity_cap(max_pct: Optional[Decimal], equity: Optional[Decimal]) -> Optional[Decimal]:
    if max_pct is None or equity is None:
        return None
    if max_pct <= 0 or equity <= 0:
        return None
    return equity * max_pct


def _min_decimal(*values: Optional[Decimal]) -> Optional[Decimal]:
    result: Optional[Decimal] = None
    for value in values:
        if value is None:
            continue
        if value <= 0:
            continue
        if result is None or value < result:
            result = value
    return result


def _optional_decimal(value: Optional[Decimal | str | float]) -> Optional[Decimal]:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (ArithmeticError, ValueError):
        return None


def _decimal_str(value: Optional[Decimal]) -> Optional[str]:
    if value is None:
        return None
    return str(value)


__all__ = ["PortfolioSizingConfig", "PortfolioSizingResult", "PortfolioSizer", "sizer_from_settings"]
