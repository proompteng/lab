"""Transaction cost analytics (TCA) derivation for execution rows."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Optional, cast

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import Execution, ExecutionTCAMetric, TradeDecision

ADAPTIVE_LOOKBACK_WINDOW = 24
ADAPTIVE_MIN_SAMPLE_SIZE = 6
ADAPTIVE_DEGRADE_FALLBACK_BPS = Decimal('4')
ADAPTIVE_TARGET_SLIPPAGE_BPS = Decimal('12')
ADAPTIVE_MAX_SLIPPAGE_BPS = Decimal('20')
ADAPTIVE_MAX_SHORTFALL = Decimal('15')
ADAPTIVE_PARTICIPATION_TIGHTEN = Decimal('0.75')
ADAPTIVE_PARTICIPATION_RELAX = Decimal('1.0')
ADAPTIVE_EXECUTION_SLOWDOWN = Decimal('1.40')
ADAPTIVE_EXECUTION_SPEEDUP = Decimal('0.85')


@dataclass(frozen=True)
class AdaptiveExecutionPolicyDecision:
    key: str
    symbol: str
    regime_label: str
    sample_size: int
    adaptive_samples: int
    baseline_slippage_bps: Decimal | None
    recent_slippage_bps: Decimal | None
    baseline_shortfall_notional: Decimal | None
    recent_shortfall_notional: Decimal | None
    effect_size_bps: Decimal | None
    degradation_bps: Decimal | None
    fallback_active: bool
    fallback_reason: str | None
    prefer_limit: bool | None
    participation_rate_scale: Decimal
    execution_seconds_scale: Decimal
    aggressiveness: str
    generated_at: datetime

    @property
    def has_override(self) -> bool:
        return self.prefer_limit is not None

    def as_payload(self) -> dict[str, Any]:
        return {
            'key': self.key,
            'symbol': self.symbol,
            'regime_label': self.regime_label,
            'sample_size': self.sample_size,
            'adaptive_samples': self.adaptive_samples,
            'baseline_slippage_bps': _decimal_str(self.baseline_slippage_bps),
            'recent_slippage_bps': _decimal_str(self.recent_slippage_bps),
            'baseline_shortfall_notional': _decimal_str(self.baseline_shortfall_notional),
            'recent_shortfall_notional': _decimal_str(self.recent_shortfall_notional),
            'effect_size_bps': _decimal_str(self.effect_size_bps),
            'degradation_bps': _decimal_str(self.degradation_bps),
            'fallback_active': self.fallback_active,
            'fallback_reason': self.fallback_reason,
            'prefer_limit': self.prefer_limit,
            'participation_rate_scale': _decimal_str(self.participation_rate_scale),
            'execution_seconds_scale': _decimal_str(self.execution_seconds_scale),
            'aggressiveness': self.aggressiveness,
            'generated_at': self.generated_at.isoformat(),
        }


def upsert_execution_tca_metric(session: Session, execution: Execution) -> ExecutionTCAMetric:
    """Derive deterministic TCA metrics for an execution and upsert a single row."""

    decision = _load_trade_decision(session, execution)
    strategy_id = decision.strategy_id if decision is not None else None
    account_label = decision.alpaca_account_label if decision is not None else None

    arrival_price = _resolve_arrival_price(decision=decision, execution=execution)
    avg_fill_price = _positive_decimal(execution.avg_fill_price)
    filled_qty = _positive_decimal(execution.filled_qty) or Decimal('0')
    signed_qty = _signed_qty(side=execution.side, qty=filled_qty)

    slippage_bps: Decimal | None = None
    shortfall_notional: Decimal | None = None
    if arrival_price is not None and avg_fill_price is not None and filled_qty > 0 and signed_qty != 0:
        price_delta = avg_fill_price - arrival_price
        direction = Decimal('1') if signed_qty > 0 else Decimal('-1')
        slippage_bps = (direction * price_delta / arrival_price) * Decimal('10000')
        shortfall_notional = direction * price_delta * filled_qty

    churn_qty, churn_ratio = _derive_churn(
        session=session,
        execution=execution,
        strategy_id=strategy_id,
        account_label=account_label,
        signed_qty=signed_qty,
        filled_qty=filled_qty,
    )

    existing = session.execute(
        select(ExecutionTCAMetric).where(ExecutionTCAMetric.execution_id == execution.id)
    ).scalar_one_or_none()
    if existing is None:
        row = ExecutionTCAMetric(
            execution_id=execution.id,
            trade_decision_id=execution.trade_decision_id,
            strategy_id=strategy_id,
            alpaca_account_label=account_label,
            symbol=execution.symbol,
            side=execution.side,
            arrival_price=arrival_price,
            avg_fill_price=avg_fill_price,
            filled_qty=filled_qty,
            signed_qty=signed_qty,
            slippage_bps=slippage_bps,
            shortfall_notional=shortfall_notional,
            churn_qty=churn_qty,
            churn_ratio=churn_ratio,
        )
        session.add(row)
        return row

    existing.trade_decision_id = execution.trade_decision_id
    existing.strategy_id = strategy_id
    existing.alpaca_account_label = account_label
    existing.symbol = execution.symbol
    existing.side = execution.side
    existing.arrival_price = arrival_price
    existing.avg_fill_price = avg_fill_price
    existing.filled_qty = filled_qty
    existing.signed_qty = signed_qty
    existing.slippage_bps = slippage_bps
    existing.shortfall_notional = shortfall_notional
    existing.churn_qty = churn_qty
    existing.churn_ratio = churn_ratio
    session.add(existing)
    return existing


def build_tca_gate_inputs(session: Session, *, strategy_id: str | None = None) -> dict[str, Decimal | int]:
    """Build aggregate TCA inputs used by autonomy gate thresholds."""

    stmt = select(
        func.count(ExecutionTCAMetric.id),
        func.avg(ExecutionTCAMetric.slippage_bps),
        func.avg(ExecutionTCAMetric.shortfall_notional),
        func.avg(ExecutionTCAMetric.churn_ratio),
    )
    if strategy_id:
        stmt = stmt.where(ExecutionTCAMetric.strategy_id == strategy_id)

    row = session.execute(stmt).one()
    order_count = int(row[0] or 0)
    avg_slippage = _decimal_or_none(row[1])
    avg_shortfall = _decimal_or_none(row[2])
    avg_churn = _decimal_or_none(row[3])
    return {
        'order_count': order_count,
        'avg_slippage_bps': avg_slippage if avg_slippage is not None else Decimal('0'),
        'avg_shortfall_notional': avg_shortfall if avg_shortfall is not None else Decimal('0'),
        'avg_churn_ratio': avg_churn if avg_churn is not None else Decimal('0'),
    }


def derive_adaptive_execution_policy(
    session: Session,
    *,
    symbol: str,
    regime_label: str | None,
) -> AdaptiveExecutionPolicyDecision:
    normalized_symbol = symbol.strip().upper()
    normalized_regime = _normalize_regime_label(regime_label)
    key = f'{normalized_symbol}:{normalized_regime}'
    generated_at = datetime.now(timezone.utc)

    if not normalized_symbol:
        return AdaptiveExecutionPolicyDecision(
            key=key,
            symbol=normalized_symbol,
            regime_label=normalized_regime,
            sample_size=0,
            adaptive_samples=0,
            baseline_slippage_bps=None,
            recent_slippage_bps=None,
            baseline_shortfall_notional=None,
            recent_shortfall_notional=None,
            effect_size_bps=None,
            degradation_bps=None,
            fallback_active=False,
            fallback_reason=None,
            prefer_limit=None,
            participation_rate_scale=Decimal('1'),
            execution_seconds_scale=Decimal('1'),
            aggressiveness='neutral',
            generated_at=generated_at,
        )

    rows = _load_recent_tca_rows(session, symbol=normalized_symbol, regime_label=normalized_regime)
    sample_size = len(rows)
    adaptive_samples = 0
    slippages: list[Decimal] = []
    shortfalls: list[Decimal] = []
    for row in rows:
        if row['adaptive_applied']:
            adaptive_samples += 1
        slippage = row['slippage_bps']
        shortfall = row['shortfall_notional']
        if slippage is not None:
            slippages.append(abs(slippage))
        if shortfall is not None:
            shortfalls.append(abs(shortfall))

    baseline_slippage, recent_slippage = _split_window_average(slippages)
    baseline_shortfall, recent_shortfall = _split_window_average(shortfalls)

    effect_size_bps: Decimal | None = None
    degradation_bps: Decimal | None = None
    if baseline_slippage is not None and recent_slippage is not None:
        effect_size_bps = baseline_slippage - recent_slippage
        degradation_bps = recent_slippage - baseline_slippage

    fallback_active = False
    fallback_reason: str | None = None
    if (
        adaptive_samples >= max(2, ADAPTIVE_MIN_SAMPLE_SIZE // 2)
        and degradation_bps is not None
        and degradation_bps >= ADAPTIVE_DEGRADE_FALLBACK_BPS
    ):
        fallback_active = True
        fallback_reason = 'adaptive_policy_degraded'

    prefer_limit: bool | None = None
    participation_rate_scale = Decimal('1')
    execution_seconds_scale = Decimal('1')
    aggressiveness = 'neutral'
    if sample_size >= ADAPTIVE_MIN_SAMPLE_SIZE and not fallback_active:
        if (
            recent_slippage is not None
            and recent_shortfall is not None
            and (recent_slippage > ADAPTIVE_MAX_SLIPPAGE_BPS or recent_shortfall > ADAPTIVE_MAX_SHORTFALL)
        ):
            prefer_limit = True
            participation_rate_scale = ADAPTIVE_PARTICIPATION_TIGHTEN
            execution_seconds_scale = ADAPTIVE_EXECUTION_SLOWDOWN
            aggressiveness = 'defensive'
        elif (
            recent_slippage is not None
            and recent_shortfall is not None
            and recent_slippage <= ADAPTIVE_TARGET_SLIPPAGE_BPS
            and recent_shortfall <= ADAPTIVE_MAX_SHORTFALL
        ):
            prefer_limit = False
            participation_rate_scale = ADAPTIVE_PARTICIPATION_RELAX
            execution_seconds_scale = ADAPTIVE_EXECUTION_SPEEDUP
            aggressiveness = 'offensive'

    return AdaptiveExecutionPolicyDecision(
        key=key,
        symbol=normalized_symbol,
        regime_label=normalized_regime,
        sample_size=sample_size,
        adaptive_samples=adaptive_samples,
        baseline_slippage_bps=baseline_slippage,
        recent_slippage_bps=recent_slippage,
        baseline_shortfall_notional=baseline_shortfall,
        recent_shortfall_notional=recent_shortfall,
        effect_size_bps=effect_size_bps,
        degradation_bps=degradation_bps,
        fallback_active=fallback_active,
        fallback_reason=fallback_reason,
        prefer_limit=prefer_limit,
        participation_rate_scale=participation_rate_scale,
        execution_seconds_scale=execution_seconds_scale,
        aggressiveness=aggressiveness,
        generated_at=generated_at,
    )


def _derive_churn(
    *,
    session: Session,
    execution: Execution,
    strategy_id: Any,
    account_label: str | None,
    signed_qty: Decimal,
    filled_qty: Decimal,
) -> tuple[Decimal, Optional[Decimal]]:
    if strategy_id is None or filled_qty <= 0 or signed_qty == 0:
        return Decimal('0'), None

    prior_where = [
        ExecutionTCAMetric.strategy_id == strategy_id,
        ExecutionTCAMetric.symbol == execution.symbol,
        Execution.created_at < execution.created_at,
    ]
    if account_label is None:
        prior_where.append(ExecutionTCAMetric.alpaca_account_label.is_(None))
    else:
        prior_where.append(ExecutionTCAMetric.alpaca_account_label == account_label)

    prior_signed_sum_stmt = (
        select(func.coalesce(func.sum(ExecutionTCAMetric.signed_qty), 0))
        .select_from(ExecutionTCAMetric)
        .join(Execution, Execution.id == ExecutionTCAMetric.execution_id)
        .where(*prior_where)
    )
    prior_signed = _decimal_or_none(session.execute(prior_signed_sum_stmt).scalar_one()) or Decimal('0')

    if prior_signed == 0:
        return Decimal('0'), Decimal('0')
    if (prior_signed > 0 and signed_qty > 0) or (prior_signed < 0 and signed_qty < 0):
        return Decimal('0'), Decimal('0')

    churn_qty = min(abs(prior_signed), abs(signed_qty))
    churn_ratio = churn_qty / filled_qty if filled_qty > 0 else None
    return churn_qty, churn_ratio


def _resolve_arrival_price(*, decision: TradeDecision | None, execution: Execution) -> Decimal | None:
    decision_payload: dict[str, Any] = {}
    decision_json = decision.decision_json if decision is not None else None
    if isinstance(decision_json, Mapping):
        decision_payload = {
            str(key): value for key, value in cast(Mapping[object, object], decision_json).items()
        }
    params = decision_payload.get('params')
    params_payload: dict[str, Any] = {}
    if isinstance(params, Mapping):
        params_payload = {str(key): value for key, value in cast(Mapping[object, object], params).items()}

    raw_order_payload: dict[str, Any] = {}
    raw_order = execution.raw_order
    if isinstance(raw_order, Mapping):
        raw_order_payload = {
            str(key): value for key, value in cast(Mapping[object, object], raw_order).items()
        }

    for candidate in (
        params_payload.get('arrival_price'),
        params_payload.get('reference_price'),
        params_payload.get('price'),
        decision_payload.get('arrival_price'),
        decision_payload.get('reference_price'),
        raw_order_payload.get('arrival_price'),
        raw_order_payload.get('reference_price'),
        raw_order_payload.get('limit_price'),
    ):
        resolved = _positive_decimal(candidate)
        if resolved is not None:
            return resolved
    return None


def _load_trade_decision(session: Session, execution: Execution) -> TradeDecision | None:
    if execution.trade_decision_id is not None:
        decision = session.get(TradeDecision, execution.trade_decision_id)
        if decision is not None:
            return decision
    if execution.client_order_id is None:
        return None
    return session.execute(
        select(TradeDecision).where(TradeDecision.decision_hash == execution.client_order_id)
    ).scalar_one_or_none()


def _load_recent_tca_rows(
    session: Session,
    *,
    symbol: str,
    regime_label: str,
) -> list[dict[str, Any]]:
    stmt = (
        select(ExecutionTCAMetric, TradeDecision.decision_json)
        .outerjoin(TradeDecision, TradeDecision.id == ExecutionTCAMetric.trade_decision_id)
        .where(ExecutionTCAMetric.symbol == symbol)
        .order_by(ExecutionTCAMetric.computed_at.desc())
        .limit(ADAPTIVE_LOOKBACK_WINDOW * 3)
    )
    rows = session.execute(stmt).all()

    filtered: list[dict[str, Any]] = []
    for metric, decision_json in rows:
        params = _decision_params(decision_json)
        row_regime = _normalize_regime_label(params.get('regime_label') or params.get('regime'))
        if regime_label != 'all' and row_regime != regime_label:
            continue
        execution_policy = params.get('execution_policy')
        execution_policy_map: Mapping[str, Any] = (
            cast(Mapping[str, Any], execution_policy) if isinstance(execution_policy, Mapping) else {}
        )
        adaptive = execution_policy_map.get('adaptive')
        adaptive_map: Mapping[str, Any] = (
            cast(Mapping[str, Any], adaptive) if isinstance(adaptive, Mapping) else {}
        )
        filtered.append(
            {
                'slippage_bps': _decimal_or_none(metric.slippage_bps),
                'shortfall_notional': _decimal_or_none(metric.shortfall_notional),
                'adaptive_applied': bool(adaptive_map.get('applied', False)),
            }
        )
        if len(filtered) >= ADAPTIVE_LOOKBACK_WINDOW:
            break
    return filtered


def _decision_params(raw_decision_json: Any) -> dict[str, Any]:
    if not isinstance(raw_decision_json, Mapping):
        return {}
    decision_map = cast(Mapping[str, Any], raw_decision_json)
    raw_params = decision_map.get('params')
    if not isinstance(raw_params, Mapping):
        return {}
    params = cast(Mapping[str, Any], raw_params)
    return {str(key): value for key, value in params.items()}


def _split_window_average(values: list[Decimal]) -> tuple[Decimal | None, Decimal | None]:
    if len(values) < ADAPTIVE_MIN_SAMPLE_SIZE:
        return None, None
    midpoint = len(values) // 2
    if midpoint == 0 or midpoint == len(values):
        return None, None
    recent = values[:midpoint]
    baseline = values[midpoint:]
    if not recent or not baseline:
        return None, None
    return _mean(baseline), _mean(recent)


def _mean(values: list[Decimal]) -> Decimal | None:
    if not values:
        return None
    total = sum(values, start=Decimal('0'))
    return total / Decimal(len(values))


def _normalize_regime_label(value: Any) -> str:
    text = str(value).strip().lower() if value is not None else ''
    return text or 'all'


def _signed_qty(*, side: str, qty: Decimal) -> Decimal:
    normalized = (side or '').strip().lower()
    if normalized == 'buy':
        return qty
    if normalized == 'sell':
        return -qty
    return Decimal('0')


def _positive_decimal(value: Any) -> Decimal | None:
    parsed = _decimal_or_none(value)
    if parsed is None or parsed <= 0:
        return None
    return parsed


def _decimal_or_none(value: Any) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (ArithmeticError, TypeError, ValueError):
        return None


def _decimal_str(value: Decimal | None) -> str | None:
    if value is None:
        return None
    return str(value)


__all__ = [
    'AdaptiveExecutionPolicyDecision',
    'build_tca_gate_inputs',
    'derive_adaptive_execution_policy',
    'upsert_execution_tca_metric',
]
