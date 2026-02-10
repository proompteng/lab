"""Evaluation report generation and governance gates for walk-forward runs."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterable, Literal, Optional

from ..models import Strategy
from .costs import CostModelConfig, CostModelInputs, OrderIntent, TransactionCostModel
from .evaluation import WalkForwardDecision, WalkForwardResults


@dataclass(frozen=True)
class EvaluationReportConfig:
    evaluation_start: datetime
    evaluation_end: datetime
    signal_source: str
    strategies: list[Strategy]
    git_sha: Optional[str] = None
    cost_model_config: CostModelConfig = field(default_factory=CostModelConfig)
    run_id: Optional[str] = None
    strategy_config_path: Optional[str] = None

    def to_payload(self) -> dict[str, object]:
        return {
            "evaluation_start": self.evaluation_start.isoformat(),
            "evaluation_end": self.evaluation_end.isoformat(),
            "signal_source": self.signal_source,
            "strategies": [_strategy_payload(strategy) for strategy in self.strategies],
            "cost_model": _cost_model_payload(self.cost_model_config),
            "run_id": self.run_id,
            "strategy_config_path": self.strategy_config_path,
        }


@dataclass(frozen=True)
class EvaluationMetrics:
    decision_count: int
    trade_count: int
    gross_pnl: Decimal
    net_pnl: Decimal
    total_cost: Decimal
    max_drawdown: Decimal
    turnover_notional: Decimal
    turnover_ratio: Decimal
    average_exposure: Decimal
    cost_bps: Decimal

    def to_payload(self) -> dict[str, object]:
        return {
            "decision_count": self.decision_count,
            "trade_count": self.trade_count,
            "gross_pnl": str(self.gross_pnl),
            "net_pnl": str(self.net_pnl),
            "total_cost": str(self.total_cost),
            "max_drawdown": str(self.max_drawdown),
            "turnover_notional": str(self.turnover_notional),
            "turnover_ratio": str(self.turnover_ratio),
            "average_exposure": str(self.average_exposure),
            "cost_bps": str(self.cost_bps),
        }


@dataclass(frozen=True)
class EvaluationGatePolicy:
    policy_version: str = "v1"
    promotion_enabled: bool = False
    allow_live: bool = False
    min_trades: int = 1
    min_net_pnl: Decimal = Decimal("0")
    max_drawdown: Decimal = Decimal("100")
    max_turnover_ratio: Decimal = Decimal("5")

    @classmethod
    def from_path(cls, path: Path) -> "EvaluationGatePolicy":
        raw = path.read_text(encoding="utf-8")
        payload = json.loads(raw)
        return cls(
            policy_version=str(payload.get("policy_version", "v1")),
            promotion_enabled=bool(payload.get("promotion_enabled", False)),
            allow_live=bool(payload.get("allow_live", False)),
            min_trades=int(payload.get("min_trades", 1)),
            min_net_pnl=_decimal(payload.get("min_net_pnl", "0")) or Decimal("0"),
            max_drawdown=_decimal(payload.get("max_drawdown", "100")) or Decimal("100"),
            max_turnover_ratio=_decimal(payload.get("max_turnover_ratio", "5")) or Decimal("5"),
        )

    def to_payload(self) -> dict[str, object]:
        return {
            "policy_version": self.policy_version,
            "promotion_enabled": self.promotion_enabled,
            "allow_live": self.allow_live,
            "min_trades": self.min_trades,
            "min_net_pnl": str(self.min_net_pnl),
            "max_drawdown": str(self.max_drawdown),
            "max_turnover_ratio": str(self.max_turnover_ratio),
        }


@dataclass(frozen=True)
class EvaluationGateOutcome:
    policy_version: str
    promotion_requested: bool
    promotion_target: Literal["shadow", "paper", "live"]
    promotion_allowed: bool
    recommended_mode: Literal["shadow", "paper", "live"]
    reasons: list[str]

    def to_payload(self) -> dict[str, object]:
        return {
            "policy_version": self.policy_version,
            "promotion_requested": self.promotion_requested,
            "promotion_target": self.promotion_target,
            "promotion_allowed": self.promotion_allowed,
            "recommended_mode": self.recommended_mode,
            "reasons": list(self.reasons),
        }


@dataclass(frozen=True)
class EvaluationReport:
    report_version: str
    generated_at: datetime
    config: EvaluationReportConfig
    metrics: EvaluationMetrics
    gates: EvaluationGateOutcome
    git_sha: Optional[str] = None

    def to_payload(self) -> dict[str, object]:
        return {
            "report_version": self.report_version,
            "generated_at": self.generated_at.isoformat(),
            "config": self.config.to_payload(),
            "versions": {"git_sha": self.git_sha},
            "metrics": self.metrics.to_payload(),
            "gates": self.gates.to_payload(),
        }


@dataclass
class _PositionState:
    qty: Decimal = Decimal("0")
    avg_price: Optional[Decimal] = None


def generate_evaluation_report(
    results: WalkForwardResults,
    *,
    config: EvaluationReportConfig,
    gate_policy: Optional[EvaluationGatePolicy] = None,
    promotion_target: Literal["shadow", "paper", "live"] = "shadow",
    cost_model: Optional[TransactionCostModel] = None,
) -> EvaluationReport:
    decisions = _flatten_decisions(results)
    metrics = _evaluate_metrics(decisions, cost_model or TransactionCostModel(config.cost_model_config))
    gates = _evaluate_gates(metrics, gate_policy or EvaluationGatePolicy(), promotion_target)
    generated_at = datetime.now(timezone.utc)
    return EvaluationReport(
        report_version="v1",
        generated_at=generated_at,
        config=config,
        metrics=metrics,
        gates=gates,
        git_sha=config.git_sha,
    )


def write_evaluation_report(report: EvaluationReport, output_path: Path) -> None:
    output_path.write_text(json.dumps(report.to_payload(), indent=2), encoding="utf-8")


def _flatten_decisions(results: WalkForwardResults) -> list[WalkForwardDecision]:
    decisions: list[WalkForwardDecision] = []
    for fold in results.folds:
        decisions.extend(fold.decisions)
    decisions.sort(key=lambda item: item.decision.event_ts)
    return decisions


def _evaluate_metrics(
    decisions: list[WalkForwardDecision],
    cost_model: TransactionCostModel,
) -> EvaluationMetrics:
    positions: dict[tuple[str, str], _PositionState] = {}
    last_prices: dict[tuple[str, str], Decimal] = {}
    realized_pnl = Decimal("0")
    total_cost = Decimal("0")
    turnover_notional = Decimal("0")
    exposure_sum = Decimal("0")
    exposure_count = 0
    max_equity = Decimal("0")
    max_drawdown = Decimal("0")
    trade_count = 0

    for item in decisions:
        decision = item.decision
        key = (decision.strategy_id, decision.symbol)
        state = positions.setdefault(key, _PositionState())
        price = _resolve_price(decision, item)
        qty = _decimal(decision.qty) or Decimal("0")
        if price is not None and qty > 0:
            turnover_notional += abs(price * qty)
            last_prices[key] = price
            total_cost += _estimate_cost(cost_model, decision, price)

        realized_pnl, trade_count = _apply_fill(
            state=state,
            action=decision.action,
            qty=qty,
            price=price,
            realized_pnl=realized_pnl,
            trade_count=trade_count,
        )

        equity = realized_pnl + _unrealized_pnl(positions, last_prices) - total_cost
        if equity > max_equity:
            max_equity = equity
        drawdown = equity - max_equity
        if drawdown < max_drawdown:
            max_drawdown = drawdown

        exposure = _exposure_notional(positions, last_prices)
        exposure_sum += exposure
        exposure_count += 1

    average_exposure = exposure_sum / Decimal(str(exposure_count)) if exposure_count > 0 else Decimal("0")
    gross_pnl = realized_pnl + _unrealized_pnl(positions, last_prices)
    net_pnl = gross_pnl - total_cost
    turnover_ratio = (
        turnover_notional / average_exposure if average_exposure > 0 else Decimal("0")
    )
    cost_bps = _bps_from_cost(total_cost, turnover_notional)

    return EvaluationMetrics(
        decision_count=len(decisions),
        trade_count=trade_count,
        gross_pnl=gross_pnl,
        net_pnl=net_pnl,
        total_cost=total_cost,
        max_drawdown=abs(max_drawdown),
        turnover_notional=turnover_notional,
        turnover_ratio=turnover_ratio,
        average_exposure=average_exposure,
        cost_bps=cost_bps,
    )


def _evaluate_gates(
    metrics: EvaluationMetrics,
    policy: EvaluationGatePolicy,
    promotion_target: Literal["shadow", "paper", "live"],
) -> EvaluationGateOutcome:
    reasons: list[str] = []
    if metrics.trade_count < policy.min_trades:
        reasons.append("insufficient_trades")
    if metrics.net_pnl < policy.min_net_pnl:
        reasons.append("net_pnl_below_minimum")
    if metrics.max_drawdown > policy.max_drawdown:
        reasons.append("drawdown_exceeds_max")
    if metrics.turnover_ratio > policy.max_turnover_ratio:
        reasons.append("turnover_exceeds_max")

    promotion_requested = promotion_target != "shadow"
    gates_pass = len(reasons) == 0
    promotion_allowed = False
    recommended_mode: Literal["shadow", "paper", "live"] = "shadow"

    if promotion_requested and policy.promotion_enabled and gates_pass:
        if promotion_target == "paper":
            promotion_allowed = True
            recommended_mode = "paper"
        elif promotion_target == "live":
            if policy.allow_live:
                promotion_allowed = True
                recommended_mode = "live"
            else:
                reasons.append("live_promotion_disabled")
        else:
            promotion_allowed = True
            recommended_mode = "shadow"

    if promotion_requested and not policy.promotion_enabled:
        reasons.append("promotion_disabled")

    return EvaluationGateOutcome(
        policy_version=policy.policy_version,
        promotion_requested=promotion_requested,
        promotion_target=promotion_target,
        promotion_allowed=promotion_allowed,
        recommended_mode=recommended_mode,
        reasons=reasons,
    )


def _apply_fill(
    *,
    state: _PositionState,
    action: str,
    qty: Decimal,
    price: Optional[Decimal],
    realized_pnl: Decimal,
    trade_count: int,
) -> tuple[Decimal, int]:
    if qty <= 0 or price is None:
        return realized_pnl, trade_count

    if action == "buy":
        if state.qty >= 0:
            realized_pnl, trade_count = _open_long(state, qty, price, realized_pnl, trade_count)
        else:
            realized_pnl, trade_count = _cover_short(state, qty, price, realized_pnl, trade_count)
    elif action == "sell":
        if state.qty <= 0:
            realized_pnl, trade_count = _open_short(state, qty, price, realized_pnl, trade_count)
        else:
            realized_pnl, trade_count = _close_long(state, qty, price, realized_pnl, trade_count)
    return realized_pnl, trade_count


def _open_long(
    state: _PositionState,
    qty: Decimal,
    price: Decimal,
    realized_pnl: Decimal,
    trade_count: int,
) -> tuple[Decimal, int]:
    new_qty = state.qty + qty
    if state.qty > 0 and state.avg_price is not None:
        state.avg_price = ((state.qty * state.avg_price) + (qty * price)) / new_qty
    else:
        state.avg_price = price
    state.qty = new_qty
    return realized_pnl, trade_count


def _close_long(
    state: _PositionState,
    qty: Decimal,
    price: Decimal,
    realized_pnl: Decimal,
    trade_count: int,
) -> tuple[Decimal, int]:
    closing_qty = min(qty, state.qty)
    if state.avg_price is not None:
        realized_pnl += (price - state.avg_price) * closing_qty
        trade_count += 1
    state.qty -= closing_qty
    if state.qty == 0:
        state.avg_price = None
    remaining = qty - closing_qty
    if remaining > 0:
        return _open_short(state, remaining, price, realized_pnl, trade_count)
    return realized_pnl, trade_count


def _open_short(
    state: _PositionState,
    qty: Decimal,
    price: Decimal,
    realized_pnl: Decimal,
    trade_count: int,
) -> tuple[Decimal, int]:
    new_qty = state.qty - qty
    if state.qty < 0 and state.avg_price is not None:
        state.avg_price = ((abs(state.qty) * state.avg_price) + (qty * price)) / abs(new_qty)
    else:
        state.avg_price = price
    state.qty = new_qty
    return realized_pnl, trade_count


def _cover_short(
    state: _PositionState,
    qty: Decimal,
    price: Decimal,
    realized_pnl: Decimal,
    trade_count: int,
) -> tuple[Decimal, int]:
    closing_qty = min(qty, abs(state.qty))
    if state.avg_price is not None:
        realized_pnl += (state.avg_price - price) * closing_qty
        trade_count += 1
    state.qty += closing_qty
    if state.qty == 0:
        state.avg_price = None
    remaining = qty - closing_qty
    if remaining > 0:
        return _open_long(state, remaining, price, realized_pnl, trade_count)
    return realized_pnl, trade_count


def _unrealized_pnl(
    positions: dict[tuple[str, str], _PositionState],
    last_prices: dict[tuple[str, str], Decimal],
) -> Decimal:
    unrealized = Decimal("0")
    for key, state in positions.items():
        if state.qty == 0 or state.avg_price is None:
            continue
        price = last_prices.get(key, state.avg_price)
        if state.qty > 0:
            unrealized += (price - state.avg_price) * state.qty
        else:
            unrealized += (state.avg_price - price) * abs(state.qty)
    return unrealized


def _exposure_notional(
    positions: dict[tuple[str, str], _PositionState],
    last_prices: dict[tuple[str, str], Decimal],
) -> Decimal:
    exposure = Decimal("0")
    for key, state in positions.items():
        if state.qty == 0:
            continue
        price = last_prices.get(key, state.avg_price)
        if price is None:
            continue
        exposure += abs(state.qty * price)
    return exposure


def _estimate_cost(cost_model: TransactionCostModel, decision: Any, price: Decimal) -> Decimal:
    order = OrderIntent(
        symbol=decision.symbol,
        side="buy" if decision.action == "buy" else "sell",
        qty=_decimal(decision.qty) or Decimal("0"),
        price=price,
        order_type=decision.order_type,
    )
    inputs = CostModelInputs(
        price=price,
        spread=_decimal(decision.params.get("spread")),
        volatility=_decimal(decision.params.get("volatility")),
        adv=_decimal(decision.params.get("adv")),
        execution_seconds=int(decision.params.get("execution_seconds", 60)),
    )
    estimate = cost_model.estimate_costs(order, inputs)
    return estimate.total_cost


def _resolve_price(decision: Any, item: WalkForwardDecision) -> Optional[Decimal]:
    if item.features.price is not None:
        return item.features.price
    candidate = decision.params.get("price")
    if candidate is None:
        candidate = decision.params.get("limit_price")
    if candidate is None:
        candidate = decision.params.get("stop_price")
    return _decimal(candidate)


def _cost_model_payload(config: CostModelConfig) -> dict[str, str]:
    return {
        "commission_bps": str(config.commission_bps),
        "commission_per_share": str(config.commission_per_share),
        "min_commission": str(config.min_commission),
        "max_participation_rate": str(config.max_participation_rate),
        "impact_bps_at_full_participation": str(config.impact_bps_at_full_participation),
    }


def _strategy_payload(strategy: Strategy) -> dict[str, object]:
    return {
        "id": str(strategy.id),
        "name": strategy.name,
        "base_timeframe": strategy.base_timeframe,
        "universe_type": strategy.universe_type,
        "universe_symbols": strategy.universe_symbols,
    }


def _decimal(value: Any) -> Optional[Decimal]:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (ArithmeticError, TypeError, ValueError):
        return None


def _bps_from_cost(cost: Decimal, notional: Decimal) -> Decimal:
    if notional <= 0:
        return Decimal("0")
    return (cost / notional) * Decimal("10000")


__all__ = [
    "EvaluationGateOutcome",
    "EvaluationGatePolicy",
    "EvaluationMetrics",
    "EvaluationReport",
    "EvaluationReportConfig",
    "generate_evaluation_report",
    "write_evaluation_report",
]
