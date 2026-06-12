# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Transaction cost analytics (TCA) derivation for execution rows."""

from __future__ import annotations

import logging
import hashlib
import json
from collections.abc import Collection, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import ROUND_CEILING, Decimal
from typing import Any, Optional, cast

from sqlalchemy import func, or_, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, load_only

from ...config import settings
from ...models import Execution, ExecutionTCAMetric, TradeDecision
from ..prices import resolve_execution_reference_price
from ..tigerbeetle_journal import (
    TIGERBEETLE_BLOCKER_JOURNAL_ERROR,
    TIGERBEETLE_BLOCKER_TRANSFER_REF_CONFLICT,
    TigerBeetleLedgerJournal,
)

# ruff: noqa: F401,F403,F405,F811,F821

from .part_01_statements_27 import *
from .part_02_observed_broker_order_policy_hash import *


def _execution_lineage_summary(executions: Collection[Execution]) -> dict[str, object]:
    blocker_counts: dict[str, int] = {}
    source_backed_count = 0
    filled_notional_count = 0
    explicit_cost_count = 0
    execution_policy_hash_count = 0
    cost_model_hash_count = 0
    post_cost_pnl_basis_count = 0
    sample_blockers: list[dict[str, object]] = []
    for execution in executions:
        audit_payload = _mapping_from_any(execution.execution_audit_json)
        lineage = _mapping_from_any(
            audit_payload.get("runtime_ledger_lineage")
            or audit_payload.get("execution_tca_cost_lineage")
        )
        blockers = [
            str(item).strip()
            for item in cast(Collection[object], lineage.get("blockers") or [])
            if str(item).strip()
        ]
        if not lineage:
            blockers = ["runtime_tca_cost_lineage_readback_missing"]
        if lineage.get("source_backed") is True and not blockers:
            source_backed_count += 1
        if lineage.get("filled_notional") is not None:
            filled_notional_count += 1
        if lineage.get("explicit_cost_amount") is not None:
            explicit_cost_count += 1
        if lineage.get("execution_policy_hash") is not None:
            execution_policy_hash_count += 1
        if lineage.get("cost_model_hash") is not None:
            cost_model_hash_count += 1
        if lineage.get("pnl_basis") == POST_COST_PNL_BASIS:
            post_cost_pnl_basis_count += 1
        for blocker in blockers:
            blocker_counts[blocker] = blocker_counts.get(blocker, 0) + 1
        if blockers and len(sample_blockers) < 10:
            sample_blockers.append(
                {
                    "execution_id": str(execution.id),
                    "alpaca_order_id": execution.alpaca_order_id,
                    "symbol": execution.symbol,
                    "blockers": blockers,
                }
            )

    execution_count = len(executions)
    blockers = sorted(blocker_counts)
    return {
        "schema_version": EXECUTION_TCA_COST_LINEAGE_SCHEMA_VERSION,
        "status": "source_backed"
        if execution_count > 0
        and source_backed_count == execution_count
        and not blockers
        else "blocked"
        if execution_count > 0
        else "missing",
        "promotion_authority": False,
        "promotion_authority_reason": "lineage_dimension_only_not_promotion_authority",
        "execution_count": execution_count,
        "source_backed_count": source_backed_count,
        "blocked_count": max(0, execution_count - source_backed_count),
        "filled_notional_count": filled_notional_count,
        "explicit_cost_count": explicit_cost_count,
        "execution_policy_hash_count": execution_policy_hash_count,
        "cost_model_hash_count": cost_model_hash_count,
        "post_cost_pnl_basis_count": post_cost_pnl_basis_count,
        "blockers": blockers,
        "blocker_counts": dict(sorted(blocker_counts.items())),
        "sample_blockers": sample_blockers,
    }


def _normalize_tca_symbols(symbols: Collection[str] | None) -> tuple[str, ...]:
    if symbols is None:
        return ()
    return tuple(
        sorted(
            {str(symbol).strip().upper() for symbol in symbols if str(symbol).strip()}
        )
    )


def _unavailable_tca_symbol_breakdown(
    *,
    symbols: tuple[str, ...],
    reason: str,
) -> list[dict[str, object]]:
    return [
        {
            "symbol": symbol,
            "order_count": 0,
            "avg_abs_slippage_bps": None,
            "max_abs_slippage_bps": None,
            "avg_realized_shortfall_bps": None,
            "last_computed_at": None,
            "read_model_unavailable": True,
            "read_model_status": "timeout",
            "reason_codes": [reason],
        }
        for symbol in symbols
    ]


def _build_tca_symbol_breakdown(
    session: Session,
    *,
    strategy_id: str | None,
    account_label: str,
    symbols: tuple[str, ...],
) -> list[dict[str, object]]:
    if not symbols:
        return []

    stmt = (
        select(
            ExecutionTCAMetric.symbol,
            func.count(ExecutionTCAMetric.id),
            func.avg(func.abs(ExecutionTCAMetric.slippage_bps)),
            func.max(func.abs(ExecutionTCAMetric.slippage_bps)),
            func.max(ExecutionTCAMetric.computed_at),
            func.avg(ExecutionTCAMetric.realized_shortfall_bps),
        )
        .where(ExecutionTCAMetric.symbol.in_(symbols))
        .group_by(ExecutionTCAMetric.symbol)
    )
    if strategy_id:
        stmt = stmt.where(ExecutionTCAMetric.strategy_id == strategy_id)
    if account_label:
        stmt = stmt.where(ExecutionTCAMetric.alpaca_account_label == account_label)

    rows_by_symbol = {str(row[0]).upper(): row for row in session.execute(stmt).all()}
    breakdown: list[dict[str, object]] = []
    for symbol in symbols:
        row = rows_by_symbol.get(symbol)
        if row is None:
            breakdown.append(
                {
                    "symbol": symbol,
                    "order_count": 0,
                    "avg_abs_slippage_bps": None,
                    "max_abs_slippage_bps": None,
                    "avg_realized_shortfall_bps": None,
                    "last_computed_at": None,
                }
            )
            continue
        breakdown.append(
            {
                "symbol": symbol,
                "order_count": int(row[1] or 0),
                "avg_abs_slippage_bps": _decimal_or_none(row[2]),
                "max_abs_slippage_bps": _decimal_or_none(row[3]),
                "last_computed_at": row[4],
                "avg_realized_shortfall_bps": _decimal_or_none(row[5]),
            }
        )
    return breakdown


def derive_adaptive_execution_policy(
    session: Session,
    *,
    symbol: str,
    regime_label: str | None,
) -> AdaptiveExecutionPolicyDecision:
    normalized_symbol = symbol.strip().upper()
    normalized_regime = _normalize_regime_label(regime_label)
    key = f"{normalized_symbol}:{normalized_regime}"
    generated_at = datetime.now(timezone.utc)

    if not normalized_symbol:
        return _empty_adaptive_execution_policy(
            key=key,
            symbol=normalized_symbol,
            regime_label=normalized_regime,
            generated_at=generated_at,
        )

    rows = _load_recent_tca_rows(
        session, symbol=normalized_symbol, regime_label=normalized_regime
    )
    window_summary = _collect_adaptive_windows(rows)
    baseline_slippage, recent_slippage = _split_window_average(window_summary.slippages)
    baseline_shortfall, recent_shortfall = _split_window_average(
        window_summary.shortfalls
    )
    effect_size_bps, degradation_bps = _derive_effect_size(
        baseline_slippage=baseline_slippage,
        recent_slippage=recent_slippage,
    )
    fallback_active, fallback_reason = _resolve_fallback_state(
        sample_size=window_summary.sample_size,
        adaptive_samples=window_summary.adaptive_samples,
        expected_shortfall_coverage=window_summary.expected_shortfall_coverage,
        degradation_bps=degradation_bps,
    )
    (
        prefer_limit,
        participation_rate_scale,
        execution_seconds_scale,
        aggressiveness,
    ) = _resolve_adaptive_controls(
        sample_size=window_summary.sample_size,
        fallback_active=fallback_active,
        recent_slippage=recent_slippage,
        recent_shortfall=recent_shortfall,
    )

    return AdaptiveExecutionPolicyDecision(
        key=key,
        symbol=normalized_symbol,
        regime_label=normalized_regime,
        sample_size=window_summary.sample_size,
        adaptive_samples=window_summary.adaptive_samples,
        baseline_slippage_bps=baseline_slippage,
        recent_slippage_bps=recent_slippage,
        baseline_shortfall_notional=baseline_shortfall,
        recent_shortfall_notional=recent_shortfall,
        effect_size_bps=effect_size_bps,
        degradation_bps=degradation_bps,
        expected_shortfall_coverage=window_summary.expected_shortfall_coverage,
        expected_shortfall_sample_count=window_summary.expected_shortfall_sample_count,
        fallback_active=fallback_active,
        fallback_reason=fallback_reason,
        prefer_limit=prefer_limit,
        participation_rate_scale=participation_rate_scale,
        execution_seconds_scale=execution_seconds_scale,
        aggressiveness=aggressiveness,
        generated_at=generated_at,
    )


def _empty_adaptive_execution_policy(
    *,
    key: str,
    symbol: str,
    regime_label: str,
    generated_at: datetime,
) -> AdaptiveExecutionPolicyDecision:
    return AdaptiveExecutionPolicyDecision(
        key=key,
        symbol=symbol,
        regime_label=regime_label,
        sample_size=0,
        adaptive_samples=0,
        expected_shortfall_coverage=Decimal("0"),
        expected_shortfall_sample_count=0,
        baseline_slippage_bps=None,
        recent_slippage_bps=None,
        baseline_shortfall_notional=None,
        recent_shortfall_notional=None,
        effect_size_bps=None,
        degradation_bps=None,
        fallback_active=False,
        fallback_reason=None,
        prefer_limit=None,
        participation_rate_scale=Decimal("1"),
        execution_seconds_scale=Decimal("1"),
        aggressiveness="neutral",
        generated_at=generated_at,
    )


def _collect_adaptive_windows(rows: list[dict[str, Any]]) -> _AdaptiveWindowSummary:
    adaptive_samples = 0
    expected_shortfall_sample_count = 0
    slippages: list[Decimal] = []
    shortfalls: list[Decimal] = []
    for row in rows:
        if row["adaptive_applied"]:
            adaptive_samples += 1
        slippage = row["slippage_bps"]
        shortfall = row["shortfall_notional"]
        if row["expected_shortfall_bps_p50"] is not None:
            expected_shortfall_sample_count += 1
        if slippage is not None:
            slippages.append(abs(slippage))
        if shortfall is not None:
            shortfalls.append(abs(shortfall))
    sample_size = len(rows)
    expected_shortfall_coverage = (
        Decimal(expected_shortfall_sample_count) / Decimal(sample_size)
        if sample_size > 0
        else Decimal("0")
    )
    return _AdaptiveWindowSummary(
        sample_size=sample_size,
        adaptive_samples=adaptive_samples,
        expected_shortfall_sample_count=expected_shortfall_sample_count,
        expected_shortfall_coverage=expected_shortfall_coverage,
        slippages=slippages,
        shortfalls=shortfalls,
    )


def _derive_effect_size(
    *,
    baseline_slippage: Decimal | None,
    recent_slippage: Decimal | None,
) -> tuple[Decimal | None, Decimal | None]:
    if baseline_slippage is None or recent_slippage is None:
        return None, None
    return baseline_slippage - recent_slippage, recent_slippage - baseline_slippage


def _resolve_fallback_state(
    *,
    sample_size: int,
    adaptive_samples: int,
    expected_shortfall_coverage: Decimal,
    degradation_bps: Decimal | None,
) -> tuple[bool, str | None]:
    if (
        sample_size >= ADAPTIVE_MIN_SAMPLE_SIZE
        and expected_shortfall_coverage < ADAPTIVE_MIN_EXPECTED_SHORTFALL_COVERAGE
    ):
        if expected_shortfall_coverage == Decimal("0"):
            return True, "adaptive_policy_expected_shortfall_coverage_missing"
        return True, "adaptive_policy_expected_shortfall_coverage_low"
    fallback_required = (
        adaptive_samples >= max(2, ADAPTIVE_MIN_SAMPLE_SIZE // 2)
        and degradation_bps is not None
        and degradation_bps >= ADAPTIVE_DEGRADE_FALLBACK_BPS
    )
    if fallback_required:
        return True, "adaptive_policy_degraded"
    return False, None


def _resolve_adaptive_controls(
    *,
    sample_size: int,
    fallback_active: bool,
    recent_slippage: Decimal | None,
    recent_shortfall: Decimal | None,
) -> tuple[bool | None, Decimal, Decimal, str]:
    prefer_limit: bool | None = None
    participation_rate_scale = Decimal("1")
    execution_seconds_scale = Decimal("1")
    aggressiveness = "neutral"
    if sample_size < ADAPTIVE_MIN_SAMPLE_SIZE or fallback_active:
        return (
            prefer_limit,
            participation_rate_scale,
            execution_seconds_scale,
            aggressiveness,
        )
    if (
        recent_slippage is not None
        and recent_shortfall is not None
        and (
            recent_slippage > ADAPTIVE_MAX_SLIPPAGE_BPS
            or recent_shortfall > ADAPTIVE_MAX_SHORTFALL
        )
    ):
        return (
            True,
            ADAPTIVE_PARTICIPATION_TIGHTEN,
            ADAPTIVE_EXECUTION_SLOWDOWN,
            "defensive",
        )
    if (
        recent_slippage is not None
        and recent_shortfall is not None
        and recent_slippage <= ADAPTIVE_TARGET_SLIPPAGE_BPS
        and recent_shortfall <= ADAPTIVE_MAX_SHORTFALL
    ):
        return (
            False,
            ADAPTIVE_PARTICIPATION_RELAX,
            ADAPTIVE_EXECUTION_SPEEDUP,
            "offensive",
        )
    return (
        prefer_limit,
        participation_rate_scale,
        execution_seconds_scale,
        aggressiveness,
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
        return Decimal("0"), None

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
    prior_signed = _decimal_or_none(
        session.execute(prior_signed_sum_stmt).scalar_one()
    ) or Decimal("0")

    if prior_signed == 0:
        return Decimal("0"), Decimal("0")
    if (prior_signed > 0 and signed_qty > 0) or (prior_signed < 0 and signed_qty < 0):
        return Decimal("0"), Decimal("0")

    churn_qty = min(abs(prior_signed), abs(signed_qty))
    churn_ratio = churn_qty / filled_qty if filled_qty > 0 else None
    return churn_qty, churn_ratio


def _resolve_arrival_price(
    *, decision: TradeDecision | None, execution: Execution
) -> Decimal | None:
    decision_payload: dict[str, Any] = {}
    decision_json = decision.decision_json if decision is not None else None
    if isinstance(decision_json, Mapping):
        decision_payload = {
            str(key): value
            for key, value in cast(Mapping[object, object], decision_json).items()
        }
    params = decision_payload.get("params")
    params_payload: dict[str, Any] = {}
    if isinstance(params, Mapping):
        params_payload = {
            str(key): value
            for key, value in cast(Mapping[object, object], params).items()
        }

    raw_order_payload: dict[str, Any] = {}
    raw_order = execution.raw_order
    if isinstance(raw_order, Mapping):
        raw_order_payload = {
            str(key): value
            for key, value in cast(Mapping[object, object], raw_order).items()
        }

    for candidate in (
        params_payload.get("arrival_price"),
        params_payload.get("reference_price"),
        decision_payload.get("arrival_price"),
        decision_payload.get("reference_price"),
        raw_order_payload.get("arrival_price"),
        raw_order_payload.get("reference_price"),
    ):
        resolved = _positive_decimal(candidate)
        if resolved is not None:
            return resolved
    return resolve_execution_reference_price(
        params=params_payload,
        limit_price=raw_order_payload.get("limit_price"),
    )


def _load_trade_decision(
    session: Session, execution: Execution
) -> TradeDecision | None:
    if execution.trade_decision_id is not None:
        decision = session.get(TradeDecision, execution.trade_decision_id)
        if decision is not None:
            return decision
    if execution.client_order_id is None:
        return None
    return session.execute(
        select(TradeDecision).where(
            TradeDecision.decision_hash == execution.client_order_id
        )
    ).scalar_one_or_none()


def _load_recent_tca_rows(
    session: Session,
    *,
    symbol: str,
    regime_label: str,
) -> list[dict[str, Any]]:
    stmt = (
        select(ExecutionTCAMetric, TradeDecision.decision_json)
        .outerjoin(
            TradeDecision, TradeDecision.id == ExecutionTCAMetric.trade_decision_id
        )
        .where(ExecutionTCAMetric.symbol == symbol)
        .order_by(ExecutionTCAMetric.computed_at.desc())
        .limit(ADAPTIVE_LOOKBACK_WINDOW * 3)
    )
    rows = session.execute(stmt).all()

    filtered: list[dict[str, Any]] = []
    for metric, decision_json in rows:
        params = _decision_params(decision_json)
        row_regime = _normalize_regime_label(
            params.get("regime_label") or params.get("regime")
        )
        if regime_label != "all" and row_regime != regime_label:
            continue
        execution_policy = params.get("execution_policy")
        execution_policy_map: Mapping[str, Any] = (
            cast(Mapping[str, Any], execution_policy)
            if isinstance(execution_policy, Mapping)
            else {}
        )
        adaptive = execution_policy_map.get("adaptive")
        adaptive_map: Mapping[str, Any] = (
            cast(Mapping[str, Any], adaptive) if isinstance(adaptive, Mapping) else {}
        )
        filtered.append(
            {
                "slippage_bps": _decimal_or_none(metric.slippage_bps),
                "shortfall_notional": _decimal_or_none(metric.shortfall_notional),
                "expected_shortfall_bps_p50": _decimal_or_none(
                    metric.expected_shortfall_bps_p50
                ),
                "adaptive_applied": bool(adaptive_map.get("applied", False)),
            }
        )
        if len(filtered) >= ADAPTIVE_LOOKBACK_WINDOW:
            break
    return filtered


def _decision_params(raw_decision_json: Any) -> dict[str, Any]:
    if not isinstance(raw_decision_json, Mapping):
        return {}
    decision_map = cast(Mapping[str, Any], raw_decision_json)
    raw_params = decision_map.get("params")
    if not isinstance(raw_params, Mapping):
        return {}
    params = cast(Mapping[str, Any], raw_params)
    return {str(key): value for key, value in params.items()}


def _split_window_average(
    values: list[Decimal],
) -> tuple[Decimal | None, Decimal | None]:
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
    total = sum(values, start=Decimal("0"))
    return total / Decimal(len(values))


def _normalize_regime_label(value: Any) -> str:
    text = str(value).strip().lower() if value is not None else ""
    return text or "all"


def _resolve_simulator_expectations(
    decision: TradeDecision | None,
) -> tuple[Decimal | None, Decimal | None, str | None]:
    if decision is None:
        return None, None, None
    decision_json = decision.decision_json
    if not isinstance(decision_json, Mapping):
        return None, None, None
    params_raw = cast(Mapping[object, object], decision_json).get("params")
    if not isinstance(params_raw, Mapping):
        return None, None, None
    params = cast(Mapping[object, object], params_raw)
    advice_payloads: list[Mapping[object, object]] = []
    for key in ("execution_advice", "execution_advisor"):
        raw_payload = params.get(key)
        if isinstance(raw_payload, Mapping):
            advice_payloads.append(cast(Mapping[object, object], raw_payload))
    if not advice_payloads:
        return None, None, None

    expected_p50: Decimal | None = None
    expected_p95: Decimal | None = None
    simulator_version: str | None = None
    for advice in advice_payloads:
        if expected_p50 is None:
            expected_p50 = _decimal_or_none(advice.get("expected_shortfall_bps_p50"))
        if expected_p95 is None:
            expected_p95 = _decimal_or_none(advice.get("expected_shortfall_bps_p95"))
        if simulator_version is None:
            simulator_version_raw = advice.get("simulator_version")
            if simulator_version_raw is not None:
                text = str(simulator_version_raw).strip()
                simulator_version = text or None
    return expected_p50, expected_p95, simulator_version


def _signed_qty(*, side: str, qty: Decimal) -> Decimal:
    normalized = (side or "").strip().lower()
    if normalized == "buy":
        return qty
    if normalized == "sell":
        return -qty
    return Decimal("0")


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
    "AdaptiveExecutionPolicyDecision",
    "build_tca_gate_inputs",
    "derive_adaptive_execution_policy",
    "refresh_execution_tca_metrics",
    "upsert_execution_tca_metric",
]


__all__ = [name for name in globals() if not name.startswith("__")]
