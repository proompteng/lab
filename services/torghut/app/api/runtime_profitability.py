"""Extracted Torghut API route and support functions."""

from __future__ import annotations

from fastapi import APIRouter
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    pass

from .common import (
    Decimal,
    Depends,
    Execution,
    ExecutionTCAMetric,
    JSONResponse,
    RUNTIME_PROFITABILITY_LOOKBACK_HOURS,
    RUNTIME_PROFITABILITY_SCHEMA_VERSION,
    Sequence,
    Session,
    Strategy,
    TradeDecision,
    TradingScheduler,
    cast,
    datetime,
    get_session,
    jsonable_encoder,
    load_quant_evidence_status,
    select,
    settings,
    timedelta,
    timezone,
)
from .application import get_app
from .health_checks import (
    build_api_live_submission_gate_payload,
    build_hypothesis_runtime_payload,
    empirical_jobs_status,
    load_tca_summary,
)
from .proxy import capture_module_exports
from .runtime_profitability_helpers import (
    load_runtime_profitability_gate_rollback_attribution as _load_runtime_profitability_gate_rollback_attribution,
)
from .vnext_helpers import (
    decimal_average as _decimal_average,
    decimal_percentile as _decimal_percentile,
    decimal_to_string as _decimal_to_string,
    normalized_adapter_name as _normalized_adapter_name,
    safe_int as _safe_int,
)

_build_hypothesis_runtime_payload = build_hypothesis_runtime_payload
_build_live_submission_gate_payload = build_api_live_submission_gate_payload
_empirical_jobs_status = empirical_jobs_status
_load_tca_summary = load_tca_summary
router = APIRouter()


@router.get("/trading/profitability/runtime")
def trading_runtime_profitability(
    session: Session = Depends(get_session),
) -> JSONResponse:
    """Return bounded runtime profitability evidence for operator dashboards."""

    current_app = get_app()
    scheduler: TradingScheduler | None = getattr(
        current_app.state, "trading_scheduler", None
    )
    if scheduler is None:
        scheduler = TradingScheduler()
        current_app.state.trading_scheduler = scheduler

    empirical_jobs = _empirical_jobs_status()
    quant_evidence = load_quant_evidence_status(
        account_label=settings.trading_account_label,
    )
    window_end = datetime.now(timezone.utc)
    window_start = window_end - timedelta(hours=RUNTIME_PROFITABILITY_LOOKBACK_HOURS)
    decisions, decision_total = _load_runtime_profitability_decisions(
        session, window_start
    )
    executions, execution_total, fallback_reason_totals = (
        _load_runtime_profitability_executions(session, window_start)
    )
    realized_pnl_summary = _load_runtime_profitability_realized_pnl_summary(
        session, window_start
    )
    gate_rollback_attribution = _load_runtime_profitability_gate_rollback_attribution(
        scheduler.state
    )
    tca_summary = _load_tca_summary(session, scheduler=scheduler)
    market_context_status = scheduler.market_context_status()
    hypothesis_payload, _hypothesis_summary, _dependency_quorum = (
        _build_hypothesis_runtime_payload(
            scheduler,
            tca_summary=tca_summary,
            market_context_status=market_context_status,
        )
    )
    live_submission_gate = _build_live_submission_gate_payload(
        scheduler.state,
        session=session,
        hypothesis_summary=hypothesis_payload,
        empirical_jobs_status=empirical_jobs,
        dspy_runtime_status=cast(
            dict[str, object],
            scheduler.llm_status().get("dspy_runtime", {}),
        ),
        quant_health_status=quant_evidence,
    )

    caveats = [
        {
            "code": "evidence_only_no_profitability_certainty",
            "message": (
                "Runtime profitability is observational evidence only and does not establish future or guaranteed profitability."
            ),
        },
        {
            "code": "realized_pnl_proxy_from_tca_shortfall",
            "message": (
                "realized_pnl_proxy_notional is derived from TCA shortfall notional and excludes full portfolio mark-to-market effects."
            ),
        },
    ]
    tca_samples = _safe_int(realized_pnl_summary.get("tca_sample_count", 0))
    if decision_total == 0 and execution_total == 0 and tca_samples == 0:
        caveats.append(
            {
                "code": "empty_window_no_runtime_evidence",
                "message": (
                    "No decisions, executions, or TCA samples were recorded in the fixed lookback window."
                ),
            }
        )

    payload = {
        "schema_version": RUNTIME_PROFITABILITY_SCHEMA_VERSION,
        "generated_at": window_end,
        "window": {
            "lookback_hours": RUNTIME_PROFITABILITY_LOOKBACK_HOURS,
            "start": window_start,
            "end": window_end,
            "decision_count": decision_total,
            "execution_count": execution_total,
            "tca_sample_count": tca_samples,
            "empty": decision_total == 0 and execution_total == 0 and tca_samples == 0,
        },
        "decisions_by_symbol_strategy": decisions,
        "executions": {
            "by_adapter": executions,
            "fallback_reason_totals": fallback_reason_totals,
        },
        "realized_pnl_summary": realized_pnl_summary,
        "gate_rollback_attribution": gate_rollback_attribution,
        "live_submission_gate": live_submission_gate,
        "caveats": caveats,
    }
    return JSONResponse(status_code=200, content=jsonable_encoder(payload))


def _aggregate_tca_rows(
    rows: Sequence[ExecutionTCAMetric],
) -> dict[str, list[dict[str, object]]]:
    by_strategy: dict[tuple[str, str], dict[str, object]] = {}
    by_symbol: dict[tuple[str, str, str], dict[str, object]] = {}
    for row in rows:
        strategy_key = str(row.strategy_id) if row.strategy_id else "unknown"
        account_key = row.alpaca_account_label or "unknown"
        symbol_key = row.symbol

        strategy_agg = by_strategy.setdefault(
            (strategy_key, account_key),
            _new_tca_aggregate(strategy_key, account_key),
        )
        symbol_agg = by_symbol.setdefault(
            (strategy_key, account_key, symbol_key),
            _new_tca_aggregate(strategy_key, account_key, symbol=symbol_key),
        )
        _update_tca_aggregate(strategy_agg, row)
        _update_tca_aggregate(symbol_agg, row)

    return {
        "strategy": _finalize_tca_aggregates(list(by_strategy.values())),
        "symbol": _finalize_tca_aggregates(list(by_symbol.values())),
    }


def _new_tca_aggregate(
    strategy_key: str,
    account_key: str,
    *,
    symbol: str | None = None,
) -> dict[str, object]:
    aggregate: dict[str, object] = {
        "strategy_id": strategy_key,
        "alpaca_account_label": account_key,
        "order_count": 0,
        "_slippage_sum": 0.0,
        "_slippage_count": 0,
        "_shortfall_sum": 0.0,
        "_shortfall_count": 0,
        "_churn_sum": 0.0,
        "_churn_count": 0,
    }
    if symbol is not None:
        aggregate["symbol"] = symbol
    return aggregate


def _update_tca_aggregate(
    aggregate: dict[str, object],
    row: ExecutionTCAMetric,
) -> None:
    aggregate["order_count"] = _tca_as_int(aggregate["order_count"]) + 1
    metric_updates = (
        ("slippage", row.slippage_bps),
        ("shortfall", row.shortfall_notional),
        ("churn", row.churn_ratio),
    )
    for prefix, metric_value in metric_updates:
        if metric_value is None:
            continue
        aggregate[f"_{prefix}_sum"] = _tca_as_float(
            aggregate[f"_{prefix}_sum"]
        ) + float(metric_value)
        aggregate[f"_{prefix}_count"] = _tca_as_int(aggregate[f"_{prefix}_count"]) + 1


def _finalize_tca_aggregates(
    aggregates: list[dict[str, object]],
) -> list[dict[str, object]]:
    payload: list[dict[str, object]] = []
    for aggregate in aggregates:
        slippage_count = _tca_as_int(aggregate.pop("_slippage_count"))
        slippage_sum = _tca_as_float(aggregate.pop("_slippage_sum"))
        shortfall_count = _tca_as_int(aggregate.pop("_shortfall_count"))
        shortfall_sum = _tca_as_float(aggregate.pop("_shortfall_sum"))
        churn_count = _tca_as_int(aggregate.pop("_churn_count"))
        churn_sum = _tca_as_float(aggregate.pop("_churn_sum"))
        aggregate["avg_slippage_bps"] = (
            (slippage_sum / slippage_count) if slippage_count else None
        )
        aggregate["avg_shortfall_notional"] = (
            (shortfall_sum / shortfall_count) if shortfall_count else None
        )
        aggregate["avg_churn_ratio"] = (
            (churn_sum / churn_count) if churn_count else None
        )
        payload.append(aggregate)
    return payload


def _tca_as_int(value: object) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    return 0


def _tca_as_float(value: object) -> float:
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        return float(value)
    return 0.0


def _load_runtime_profitability_decisions(
    session: Session,
    window_start: datetime,
) -> tuple[list[dict[str, object]], int]:
    stmt = (
        select(TradeDecision, Strategy.name)
        .join(Strategy, TradeDecision.strategy_id == Strategy.id, isouter=True)
        .where(TradeDecision.created_at >= window_start)
    )
    rows = session.execute(stmt).all()
    grouped: dict[tuple[str, str], dict[str, object]] = {}
    for decision, strategy_name in rows:
        strategy_id = str(decision.strategy_id)
        symbol = decision.symbol
        status = str(decision.status or "unknown").strip() or "unknown"
        bucket = grouped.setdefault(
            (strategy_id, symbol),
            {
                "strategy_id": strategy_id,
                "strategy_name": strategy_name,
                "symbol": symbol,
                "decision_count": 0,
                "executed_count": 0,
                "status_counts": {},
                "last_decision_at": None,
                "last_executed_at": None,
            },
        )
        bucket["decision_count"] = _safe_int(bucket.get("decision_count")) + 1
        status_counts = cast(dict[str, int], bucket["status_counts"])
        status_counts[status] = status_counts.get(status, 0) + 1
        if decision.executed_at is not None:
            bucket["executed_count"] = _safe_int(bucket.get("executed_count")) + 1
            previous_executed_at = cast(datetime | None, bucket.get("last_executed_at"))
            if (
                previous_executed_at is None
                or decision.executed_at > previous_executed_at
            ):
                bucket["last_executed_at"] = decision.executed_at
        previous_created_at = cast(datetime | None, bucket.get("last_decision_at"))
        if previous_created_at is None or decision.created_at > previous_created_at:
            bucket["last_decision_at"] = decision.created_at

    payload = sorted(
        grouped.values(),
        key=lambda item: (
            str(item.get("strategy_id") or ""),
            str(item.get("symbol") or ""),
        ),
    )
    return payload, len(rows)


def _load_runtime_profitability_executions(
    session: Session,
    window_start: datetime,
) -> tuple[list[dict[str, object]], int, dict[str, int]]:
    executions = (
        session.execute(select(Execution).where(Execution.created_at >= window_start))
        .scalars()
        .all()
    )
    grouped: dict[tuple[str, str], dict[str, object]] = {}
    fallback_reason_totals: dict[str, int] = {}
    for execution in executions:
        expected_adapter = _normalized_adapter_name(
            execution.execution_expected_adapter
        )
        actual_adapter = _normalized_adapter_name(execution.execution_actual_adapter)
        fallback_reason = (
            str(execution.execution_fallback_reason).strip()
            if execution.execution_fallback_reason is not None
            else ""
        )
        fallback_count = max(0, int(execution.execution_fallback_count or 0))
        fallback_applied = bool(
            fallback_reason or fallback_count > 0 or expected_adapter != actual_adapter
        )
        status = str(execution.status or "unknown").strip() or "unknown"

        bucket = grouped.setdefault(
            (expected_adapter, actual_adapter),
            {
                "expected_adapter": expected_adapter,
                "actual_adapter": actual_adapter,
                "execution_count": 0,
                "fallback_execution_count": 0,
                "fallback_count_total": 0,
                "fallback_reason_counts": {},
                "status_counts": {},
                "last_execution_at": None,
            },
        )
        bucket["execution_count"] = _safe_int(bucket.get("execution_count")) + 1
        if fallback_applied:
            bucket["fallback_execution_count"] = (
                _safe_int(bucket.get("fallback_execution_count")) + 1
            )
        bucket["fallback_count_total"] = (
            _safe_int(bucket.get("fallback_count_total")) + fallback_count
        )
        status_counts = cast(dict[str, int], bucket["status_counts"])
        status_counts[status] = status_counts.get(status, 0) + 1
        previous_created_at = cast(datetime | None, bucket.get("last_execution_at"))
        if previous_created_at is None or execution.created_at > previous_created_at:
            bucket["last_execution_at"] = execution.created_at

        if fallback_reason:
            reason_counts = cast(dict[str, int], bucket["fallback_reason_counts"])
            reason_counts[fallback_reason] = reason_counts.get(fallback_reason, 0) + 1
            fallback_reason_totals[fallback_reason] = (
                fallback_reason_totals.get(fallback_reason, 0) + 1
            )

    payload = sorted(
        grouped.values(),
        key=lambda item: (
            str(item.get("expected_adapter") or ""),
            str(item.get("actual_adapter") or ""),
        ),
    )
    return payload, len(executions), dict(sorted(fallback_reason_totals.items()))


def _load_runtime_profitability_realized_pnl_summary(
    session: Session,
    window_start: datetime,
) -> dict[str, object]:
    rows = (
        session.execute(
            select(ExecutionTCAMetric).where(
                ExecutionTCAMetric.computed_at >= window_start
            )
        )
        .scalars()
        .all()
    )
    shortfall_total = Decimal("0")
    realized_shortfall_values: list[Decimal] = []
    adverse_proxy_values: list[Decimal] = []
    by_symbol: dict[str, dict[str, object]] = {}
    for row in rows:
        shortfall = row.shortfall_notional
        if shortfall is not None:
            shortfall_total += shortfall
            symbol_bucket = by_symbol.setdefault(
                row.symbol,
                {
                    "symbol": row.symbol,
                    "samples": 0,
                    "shortfall_notional_total": Decimal("0"),
                },
            )
            symbol_bucket["samples"] = _safe_int(symbol_bucket.get("samples")) + 1
            symbol_bucket["shortfall_notional_total"] = (
                cast(Decimal, symbol_bucket["shortfall_notional_total"]) + shortfall
            )

        realized_shortfall = row.realized_shortfall_bps
        if realized_shortfall is not None:
            realized_shortfall_values.append(realized_shortfall)
            adverse_proxy_values.append(abs(realized_shortfall))
        elif row.slippage_bps is not None:
            adverse_proxy_values.append(abs(row.slippage_bps))

    by_symbol_payload: list[dict[str, object]] = []
    for symbol_key in sorted(by_symbol):
        symbol_row = by_symbol[symbol_key]
        by_symbol_payload.append(
            {
                "symbol": symbol_row["symbol"],
                "samples": symbol_row["samples"],
                "shortfall_notional_total": _decimal_to_string(
                    cast(Decimal, symbol_row["shortfall_notional_total"])
                ),
            }
        )

    return {
        "tca_sample_count": len(rows),
        "realized_pnl_proxy_notional": _decimal_to_string(-shortfall_total),
        "shortfall_notional_total": _decimal_to_string(shortfall_total),
        "avg_realized_shortfall_bps": _decimal_to_string(
            _decimal_average(realized_shortfall_values)
        ),
        "adverse_excursion_proxy_bps_p95": _decimal_to_string(
            _decimal_percentile(adverse_proxy_values, 95)
        ),
        "adverse_excursion_proxy_bps_max": _decimal_to_string(
            max(adverse_proxy_values) if adverse_proxy_values else None
        ),
        "by_symbol": by_symbol_payload,
    }


aggregate_tca_rows = _aggregate_tca_rows


__all__ = [
    "trading_runtime_profitability",
    "_aggregate_tca_rows",
    "aggregate_tca_rows",
    "_new_tca_aggregate",
    "_update_tca_aggregate",
    "_finalize_tca_aggregates",
    "_tca_as_int",
    "_tca_as_float",
    "_load_runtime_profitability_decisions",
    "_load_runtime_profitability_executions",
    "_load_runtime_profitability_realized_pnl_summary",
]
capture_module_exports(globals(), __all__)
