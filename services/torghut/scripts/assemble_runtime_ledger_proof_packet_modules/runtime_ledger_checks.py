"""Runtime-ledger completion and quality checks for proof packet assembly."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from scripts.assemble_runtime_ledger_proof_packet_modules.common import (
    DEFAULT_RUNTIME_LEDGER_PROOF_POLICY,
    _decimal,
    _decimal_text,
    _first_decimal,
    _int,
    _mapping,
    _text,
    _text_list,
)
from scripts.assemble_runtime_ledger_proof_packet_modules.hpairs import _extend_unique
from scripts.assemble_runtime_ledger_proof_packet_modules.paper_route import (
    _check,
    _completion_live_scale_gate,
    _runtime_ledger_refs,
    _runtime_ledger_trading_day_count,
)


@dataclass(frozen=True)
class RuntimeLedgerThresholds:
    min_net_pnl: Decimal
    min_daily_net_pnl: Decimal
    min_trading_days: int
    min_closed_round_trips: int
    min_filled_notional: Decimal
    max_drawdown_pct_equity: Decimal
    max_best_day_share: Decimal
    max_symbol_concentration_share: Decimal


@dataclass(frozen=True)
class RuntimeLedgerCheckContext:
    runtime_import_due: bool
    deferred_until_runtime_import_due: str
    final_authority_mode: bool
    thresholds: RuntimeLedgerThresholds

    @property
    def deferred_status(self) -> str | None:
        if self.runtime_import_due:
            return None
        return self.deferred_until_runtime_import_due

    @property
    def authority_due(self) -> bool:
        return self.runtime_import_due and self.final_authority_mode


@dataclass(frozen=True)
class RuntimeLedgerCheckResult:
    live_scale_gate: Mapping[str, Any]
    runtime_summary: Mapping[str, Any]
    ledger_refs: list[str]
    unbacked_refs: list[str]
    target_implied_avg_daily_filled_notional: Decimal | None


@dataclass
class _RuntimeLedgerCheckState:
    checks: dict[str, dict[str, Any]]
    blockers: list[str]
    context: RuntimeLedgerCheckContext


@dataclass(frozen=True)
class _RuntimeLedgerMetrics:
    bucket_count: int
    fill_count: int
    closed_trade_count: int
    closed_round_trip_count: int
    open_position_count_present: bool
    open_position_count: int
    filled_notional: Decimal | None
    cost_amount: Decimal | None
    net_pnl: Decimal | None
    expectancy_bps: Decimal | None
    trading_days: int
    explicit_mean_daily_net_pnl: Decimal | None
    daily_net_pnl: Decimal | None
    median_daily_net_pnl: Decimal | None
    p10_daily_net_pnl: Decimal | None
    worst_day_net_pnl: Decimal | None
    drawdown_pct: Decimal | None
    drawdown_source: str
    max_intraday_drawdown: Decimal | None
    max_intraday_drawdown_source: str
    best_day_share: Decimal | None
    best_day_share_source: str
    symbol_concentration_share: Decimal | None
    symbol_concentration_source: str
    avg_daily_filled_notional: Decimal | None
    source_authority_bucket_count: int
    source_authority_blockers: list[str]
    authority_blockers_from_summary: list[str]
    ledger_schema_versions: list[str]
    cost_basis_counts: Mapping[str, Any]
    cost_model_hash_count: int
    target_implied_avg_daily_filled_notional: Decimal | None

    @property
    def observed_open_position_count(self) -> int | None:
        if self.open_position_count_present:
            return self.open_position_count
        return None


@dataclass(frozen=True)
class _RuntimeLedgerRiskMetricSnapshot:
    drawdown_pct: Decimal | None
    drawdown_source: str
    max_intraday_drawdown: Decimal | None
    max_intraday_drawdown_source: str
    best_day_share: Decimal | None
    best_day_share_source: str
    symbol_concentration_share: Decimal | None
    symbol_concentration_source: str


def _completion_blockers(gate: Mapping[str, Any]) -> list[str]:
    blockers = _text_list(gate.get("blocking_reasons"))
    blocked_reason = _text(gate.get("blocked_reason"))
    if blocked_reason:
        _extend_unique(blockers, [blocked_reason])
    return blockers


def _runtime_ledger_risk_metrics(
    runtime_summary: Mapping[str, Any],
) -> _RuntimeLedgerRiskMetricSnapshot:
    drawdown_pct, drawdown_source = _first_decimal(
        runtime_summary,
        (
            "runtime_ledger_max_drawdown_pct_equity",
            "runtime_ledger_drawdown_pct_equity",
            "max_drawdown_pct_equity",
            "drawdown_pct_equity",
        ),
    )
    max_intraday_drawdown, max_intraday_drawdown_source = _first_decimal(
        runtime_summary,
        ("runtime_ledger_max_intraday_drawdown", "max_intraday_drawdown"),
    )
    best_day_share, best_day_share_source = _first_decimal(
        runtime_summary,
        (
            "runtime_ledger_best_day_share",
            "runtime_ledger_max_single_day_contribution_share",
            "best_day_share",
            "max_single_day_contribution_share",
        ),
    )
    symbol_concentration_share, symbol_concentration_source = _first_decimal(
        runtime_summary,
        ("runtime_ledger_symbol_concentration_share", "symbol_concentration_share"),
    )
    return _RuntimeLedgerRiskMetricSnapshot(
        drawdown_pct=drawdown_pct,
        drawdown_source=drawdown_source,
        max_intraday_drawdown=max_intraday_drawdown,
        max_intraday_drawdown_source=max_intraday_drawdown_source,
        best_day_share=best_day_share,
        best_day_share_source=best_day_share_source,
        symbol_concentration_share=symbol_concentration_share,
        symbol_concentration_source=symbol_concentration_source,
    )


def _runtime_ledger_metrics(
    runtime_summary: Mapping[str, Any],
    thresholds: RuntimeLedgerThresholds,
) -> _RuntimeLedgerMetrics:
    net_pnl = _decimal(
        runtime_summary.get("runtime_ledger_net_strategy_pnl_after_costs")
    )
    expectancy_bps = _decimal(
        runtime_summary.get("runtime_ledger_post_cost_expectancy_bps")
    )
    trading_days = _runtime_ledger_trading_day_count(runtime_summary)
    explicit_mean_daily_net_pnl = _decimal(
        runtime_summary.get("runtime_ledger_mean_daily_net_pnl_after_costs")
    )
    daily_net_pnl = explicit_mean_daily_net_pnl or (
        net_pnl / Decimal(trading_days)
        if net_pnl is not None and trading_days > 0
        else None
    )
    risk_metrics = _runtime_ledger_risk_metrics(runtime_summary)
    authority_blockers = _text_list(
        runtime_summary.get("runtime_ledger_authority_blockers")
    )
    _extend_unique(
        authority_blockers,
        _text_list(runtime_summary.get("runtime_ledger_profit_authority_blockers")),
    )
    target_implied_avg_daily_filled_notional = (
        thresholds.min_daily_net_pnl * Decimal("10000") / expectancy_bps
        if expectancy_bps is not None and expectancy_bps > 0
        else None
    )
    return _RuntimeLedgerMetrics(
        bucket_count=_int(runtime_summary.get("runtime_ledger_bucket_count")),
        fill_count=_int(runtime_summary.get("runtime_ledger_fill_count")),
        closed_trade_count=_int(
            runtime_summary.get("runtime_ledger_closed_trade_count")
        ),
        closed_round_trip_count=_int(
            runtime_summary.get(
                "runtime_ledger_closed_round_trip_count",
                runtime_summary.get("runtime_ledger_closed_trade_count"),
            )
        ),
        open_position_count_present="runtime_ledger_open_position_count"
        in runtime_summary,
        open_position_count=_int(
            runtime_summary.get("runtime_ledger_open_position_count")
        ),
        filled_notional=_decimal(runtime_summary.get("runtime_ledger_filled_notional")),
        cost_amount=_decimal(runtime_summary.get("runtime_ledger_cost_amount")),
        net_pnl=net_pnl,
        expectancy_bps=expectancy_bps,
        trading_days=trading_days,
        explicit_mean_daily_net_pnl=explicit_mean_daily_net_pnl,
        daily_net_pnl=daily_net_pnl,
        median_daily_net_pnl=_decimal(
            runtime_summary.get("runtime_ledger_median_daily_net_pnl_after_costs")
        ),
        p10_daily_net_pnl=_decimal(
            runtime_summary.get("runtime_ledger_p10_daily_net_pnl_after_costs")
        ),
        worst_day_net_pnl=_decimal(
            runtime_summary.get("runtime_ledger_worst_day_net_pnl_after_costs")
        ),
        drawdown_pct=risk_metrics.drawdown_pct,
        drawdown_source=risk_metrics.drawdown_source,
        max_intraday_drawdown=risk_metrics.max_intraday_drawdown,
        max_intraday_drawdown_source=risk_metrics.max_intraday_drawdown_source,
        best_day_share=risk_metrics.best_day_share,
        best_day_share_source=risk_metrics.best_day_share_source,
        symbol_concentration_share=risk_metrics.symbol_concentration_share,
        symbol_concentration_source=risk_metrics.symbol_concentration_source,
        avg_daily_filled_notional=_decimal(
            runtime_summary.get("runtime_ledger_avg_daily_filled_notional")
        ),
        source_authority_bucket_count=_int(
            runtime_summary.get("runtime_ledger_source_authority_bucket_count")
        ),
        source_authority_blockers=_text_list(
            runtime_summary.get("runtime_ledger_source_authority_blockers")
        ),
        authority_blockers_from_summary=authority_blockers,
        ledger_schema_versions=_text_list(
            runtime_summary.get("runtime_ledger_schema_versions")
        ),
        cost_basis_counts=_mapping(
            runtime_summary.get("runtime_ledger_cost_basis_counts")
        ),
        cost_model_hash_count=_int(
            runtime_summary.get("runtime_ledger_cost_model_hash_count")
        ),
        target_implied_avg_daily_filled_notional=target_implied_avg_daily_filled_notional,
    )


def _check_doc29_live_scale_gate(
    state: _RuntimeLedgerCheckState,
    live_scale_gate: Mapping[str, Any],
    completion_gate_blockers: list[str],
    gate_satisfied: bool,
) -> None:
    context = state.context
    _check(
        state.checks,
        "doc29_live_scale_gate",
        passed=(not context.runtime_import_due)
        or (gate_satisfied and not completion_gate_blockers),
        observed={
            "gate_present": bool(live_scale_gate),
            "status": _text(live_scale_gate.get("status"), "missing"),
            "runtime_import_due": context.runtime_import_due,
            "blockers": completion_gate_blockers,
        },
        expected="doc29 live_scale_observed gate satisfied",
        blockers=completion_gate_blockers
        or (
            []
            if gate_satisfied or not context.runtime_import_due
            else ["doc29_live_scale_gate_not_satisfied"]
        ),
        status=context.deferred_status,
    )
    if context.runtime_import_due and completion_gate_blockers:
        _extend_unique(state.blockers, completion_gate_blockers)
    elif context.runtime_import_due and not gate_satisfied:
        _extend_unique(state.blockers, ["doc29_live_scale_gate_not_satisfied"])


def _check_runtime_ledger_refs(
    state: _RuntimeLedgerCheckState,
    ledger_refs: list[str],
    unbacked_refs: list[str],
) -> None:
    context = state.context
    refs_ok = bool(ledger_refs) and not unbacked_refs
    _check(
        state.checks,
        "runtime_ledger_db_refs",
        passed=(not context.runtime_import_due) or refs_ok,
        observed={
            "runtime_import_due": context.runtime_import_due,
            "strategy_runtime_ledger_buckets": ledger_refs,
            "unbacked_metric_windows": unbacked_refs,
        },
        expected="runtime ledger bucket db refs present and unbacked windows empty",
        blockers=[]
        if refs_ok or not context.runtime_import_due
        else ["runtime_ledger_db_refs_missing_or_unbacked"],
        status=context.deferred_status,
    )
    if context.runtime_import_due and not refs_ok:
        _extend_unique(state.blockers, ["runtime_ledger_db_refs_missing_or_unbacked"])


def _lifecycle_blockers(
    context: RuntimeLedgerCheckContext,
    metrics: _RuntimeLedgerMetrics,
) -> list[str]:
    blockers: list[str] = []
    if context.runtime_import_due and metrics.bucket_count <= 0:
        blockers.append("runtime_ledger_bucket_count_zero")
    if context.runtime_import_due and metrics.fill_count <= 0:
        blockers.append("runtime_ledger_fill_count_zero")
    if context.runtime_import_due and metrics.closed_trade_count <= 0:
        blockers.append("runtime_ledger_closed_trade_count_zero")
    if context.runtime_import_due and (
        metrics.filled_notional is None or metrics.filled_notional <= 0
    ):
        blockers.append("runtime_ledger_filled_notional_missing")
    if context.runtime_import_due and (
        metrics.expectancy_bps is None or metrics.expectancy_bps <= 0
    ):
        blockers.append("runtime_ledger_post_cost_expectancy_not_positive")
    return blockers


def _check_lifecycle_counts(
    state: _RuntimeLedgerCheckState,
    metrics: _RuntimeLedgerMetrics,
) -> None:
    lifecycle_blockers = _lifecycle_blockers(state.context, metrics)
    _check(
        state.checks,
        "runtime_ledger_lifecycle_counts",
        passed=not lifecycle_blockers,
        observed={
            "runtime_import_due": state.context.runtime_import_due,
            "bucket_count": metrics.bucket_count,
            "fill_count": metrics.fill_count,
            "closed_trade_count": metrics.closed_trade_count,
            "closed_round_trip_count": metrics.closed_round_trip_count,
            "open_position_count": metrics.observed_open_position_count,
            "filled_notional": _decimal_text(metrics.filled_notional),
            "cost_amount": _decimal_text(metrics.cost_amount),
            "post_cost_expectancy_bps": _decimal_text(metrics.expectancy_bps),
        },
        expected="positive buckets, fills, closed trips, filled notional, and post-cost expectancy",
        blockers=lifecycle_blockers,
        status=state.context.deferred_status,
    )
    _extend_unique(state.blockers, lifecycle_blockers)


def _authority_mechanical_blockers(
    context: RuntimeLedgerCheckContext,
    metrics: _RuntimeLedgerMetrics,
) -> list[str]:
    blockers: list[str] = []
    thresholds = context.thresholds
    if not context.authority_due:
        return blockers
    if metrics.closed_round_trip_count < thresholds.min_closed_round_trips:
        blockers.append("runtime_ledger_closed_round_trips_below_authority_floor")
    if (
        metrics.filled_notional is None
        or metrics.filled_notional < thresholds.min_filled_notional
    ):
        blockers.append("runtime_ledger_filled_notional_below_authority_floor")
    if not metrics.open_position_count_present:
        blockers.append("runtime_ledger_open_position_count_missing")
    elif metrics.open_position_count != 0:
        blockers.append("runtime_ledger_open_position_count_nonzero")
    if metrics.cost_amount is None or (
        not metrics.cost_basis_counts and metrics.cost_model_hash_count <= 0
    ):
        blockers.append("runtime_ledger_explicit_costs_missing")
    if metrics.source_authority_bucket_count < max(1, metrics.bucket_count):
        blockers.append("runtime_ledger_source_authority_missing")
    _extend_unique(blockers, metrics.source_authority_blockers)
    if metrics.authority_blockers_from_summary:
        blockers.append("runtime_ledger_authority_blockers_present")
    if "torghut.exact_replay_ledger.v1" in metrics.ledger_schema_versions:
        blockers.append("runtime_ledger_exact_replay_schema_not_authority")
    return blockers


def _check_authority_mechanical_floor(
    state: _RuntimeLedgerCheckState,
    metrics: _RuntimeLedgerMetrics,
) -> None:
    thresholds = state.context.thresholds
    authority_mechanical_blockers = _authority_mechanical_blockers(
        state.context,
        metrics,
    )
    _check(
        state.checks,
        "runtime_ledger_authority_mechanical_floor",
        passed=not authority_mechanical_blockers,
        observed={
            "runtime_import_due": state.context.runtime_import_due,
            "final_authority": state.context.final_authority_mode,
            "closed_round_trip_count": metrics.closed_round_trip_count,
            "filled_notional": _decimal_text(metrics.filled_notional),
            "open_position_count": metrics.observed_open_position_count,
            "cost_amount": _decimal_text(metrics.cost_amount),
            "cost_basis_counts": dict(metrics.cost_basis_counts),
            "cost_model_hash_count": metrics.cost_model_hash_count,
            "source_authority_bucket_count": metrics.source_authority_bucket_count,
            "source_authority_blockers": metrics.source_authority_blockers,
            "authority_blockers": metrics.authority_blockers_from_summary,
            "ledger_schema_versions": metrics.ledger_schema_versions,
        },
        expected={
            "min_closed_round_trips": thresholds.min_closed_round_trips,
            "min_filled_notional": _decimal_text(thresholds.min_filled_notional),
            "open_position_count": 0,
            "explicit_costs": True,
            "source_backed_runtime_ledger_refs": True,
            "authority_blockers": [],
            "non_authority_schema_versions": ["torghut.exact_replay_ledger.v1"],
        },
        blockers=authority_mechanical_blockers,
        status=state.context.deferred_status,
    )
    _extend_unique(state.blockers, authority_mechanical_blockers)


def _pnl_blockers(
    context: RuntimeLedgerCheckContext,
    metrics: _RuntimeLedgerMetrics,
) -> list[str]:
    blockers: list[str] = []
    thresholds = context.thresholds
    if context.runtime_import_due and (
        metrics.net_pnl is None or metrics.net_pnl < thresholds.min_net_pnl
    ):
        blockers.append("runtime_ledger_net_pnl_below_target")
    if (
        context.runtime_import_due
        and metrics.trading_days < thresholds.min_trading_days
    ):
        blockers.append("runtime_ledger_trading_days_below_target")
    if context.runtime_import_due and (
        metrics.daily_net_pnl is None
        or metrics.daily_net_pnl < thresholds.min_daily_net_pnl
    ):
        blockers.append("runtime_ledger_mean_daily_net_pnl_after_costs_below_floor")
    return blockers


def _check_post_cost_profit_target(
    state: _RuntimeLedgerCheckState,
    metrics: _RuntimeLedgerMetrics,
) -> None:
    thresholds = state.context.thresholds
    pnl_blockers = _pnl_blockers(state.context, metrics)
    _check(
        state.checks,
        "runtime_ledger_post_cost_profit_target",
        passed=not pnl_blockers,
        observed={
            "runtime_import_due": state.context.runtime_import_due,
            "net_pnl_after_costs": _decimal_text(metrics.net_pnl),
            "trading_days": metrics.trading_days,
            "mean_daily_net_pnl_after_costs": _decimal_text(metrics.daily_net_pnl),
            "mean_daily_net_pnl_after_costs_source": (
                "runtime_ledger_mean_daily_net_pnl_after_costs"
                if metrics.explicit_mean_daily_net_pnl is not None
                else "computed_from_total_net_pnl"
                if metrics.daily_net_pnl is not None
                else "missing"
            ),
        },
        expected={
            "min_net_pnl_after_costs": _decimal_text(thresholds.min_net_pnl),
            "min_trading_days": thresholds.min_trading_days,
            "min_daily_net_pnl_after_costs": _decimal_text(
                thresholds.min_daily_net_pnl
            ),
        },
        blockers=pnl_blockers,
        status=state.context.deferred_status,
    )
    _extend_unique(state.blockers, pnl_blockers)


def _daily_distribution_blockers(
    context: RuntimeLedgerCheckContext,
    metrics: _RuntimeLedgerMetrics,
) -> list[str]:
    blockers: list[str] = []
    policy = DEFAULT_RUNTIME_LEDGER_PROOF_POLICY
    if not context.authority_due:
        return blockers
    if metrics.median_daily_net_pnl is None:
        blockers.append("runtime_ledger_median_daily_net_pnl_after_costs_missing")
    elif (
        metrics.median_daily_net_pnl
        < policy.authority_min_median_daily_net_pnl_after_costs
    ):
        blockers.append("runtime_ledger_median_daily_net_pnl_after_costs_below_floor")
    if metrics.p10_daily_net_pnl is None:
        blockers.append("runtime_ledger_p10_daily_net_pnl_after_costs_missing")
    elif metrics.p10_daily_net_pnl < policy.authority_min_p10_daily_net_pnl_after_costs:
        blockers.append("runtime_ledger_p10_daily_net_pnl_after_costs_below_floor")
    if metrics.worst_day_net_pnl is None:
        blockers.append("runtime_ledger_worst_day_net_pnl_after_costs_missing")
    elif metrics.worst_day_net_pnl < policy.authority_min_worst_day_net_pnl_after_costs:
        blockers.append("runtime_ledger_worst_day_net_pnl_after_costs_below_floor")
    return blockers


def _check_daily_distribution_authority(
    state: _RuntimeLedgerCheckState,
    metrics: _RuntimeLedgerMetrics,
) -> None:
    policy = DEFAULT_RUNTIME_LEDGER_PROOF_POLICY
    daily_distribution_blockers = _daily_distribution_blockers(
        state.context,
        metrics,
    )
    _check(
        state.checks,
        "runtime_ledger_daily_distribution_authority",
        passed=not daily_distribution_blockers,
        observed={
            "runtime_import_due": state.context.runtime_import_due,
            "final_authority": state.context.final_authority_mode,
            "median_daily_net_pnl_after_costs": _decimal_text(
                metrics.median_daily_net_pnl
            ),
            "p10_daily_net_pnl_after_costs": _decimal_text(metrics.p10_daily_net_pnl),
            "worst_day_net_pnl_after_costs": _decimal_text(metrics.worst_day_net_pnl),
        },
        expected={
            "min_median_daily_net_pnl_after_costs": _decimal_text(
                policy.authority_min_median_daily_net_pnl_after_costs
            ),
            "min_p10_daily_net_pnl_after_costs": _decimal_text(
                policy.authority_min_p10_daily_net_pnl_after_costs
            ),
            "min_worst_day_net_pnl_after_costs": _decimal_text(
                policy.authority_min_worst_day_net_pnl_after_costs
            ),
        },
        blockers=daily_distribution_blockers,
        status=state.context.deferred_status,
    )
    _extend_unique(state.blockers, daily_distribution_blockers)


def _scale_blockers(
    context: RuntimeLedgerCheckContext,
    metrics: _RuntimeLedgerMetrics,
) -> list[str]:
    blockers: list[str] = []
    if not context.authority_due:
        return blockers
    if metrics.avg_daily_filled_notional is None:
        blockers.append("runtime_ledger_avg_daily_filled_notional_missing")
    elif (
        metrics.target_implied_avg_daily_filled_notional is not None
        and metrics.avg_daily_filled_notional
        < metrics.target_implied_avg_daily_filled_notional
    ):
        blockers.append(
            "runtime_ledger_avg_daily_filled_notional_below_target_implied_floor"
        )
    return blockers


def _check_target_implied_scale(
    state: _RuntimeLedgerCheckState,
    metrics: _RuntimeLedgerMetrics,
) -> None:
    thresholds = state.context.thresholds
    scale_blockers = _scale_blockers(state.context, metrics)
    _check(
        state.checks,
        "runtime_ledger_target_implied_scale",
        passed=not scale_blockers,
        observed={
            "runtime_import_due": state.context.runtime_import_due,
            "final_authority": state.context.final_authority_mode,
            "post_cost_expectancy_bps": _decimal_text(metrics.expectancy_bps),
            "avg_daily_filled_notional": _decimal_text(
                metrics.avg_daily_filled_notional
            ),
            "target_implied_avg_daily_filled_notional": _decimal_text(
                metrics.target_implied_avg_daily_filled_notional
            ),
            "target_implied_avg_daily_filled_notional_basis": (
                "min_runtime_ledger_daily_net_pnl_after_costs / "
                "observed_post_cost_expectancy_bps"
                if metrics.target_implied_avg_daily_filled_notional is not None
                else None
            ),
        },
        expected={
            "min_runtime_ledger_daily_net_pnl_after_costs": _decimal_text(
                thresholds.min_daily_net_pnl
            ),
            "formula": (
                "required_daily_notional = min_daily_net_pnl_after_costs "
                "/ (observed_post_cost_expectancy_bps / 10000)"
            ),
        },
        blockers=scale_blockers,
        status=state.context.deferred_status,
    )
    _extend_unique(state.blockers, scale_blockers)


def _authority_drawdown_blockers(
    metrics: _RuntimeLedgerMetrics,
    drawdown_pct_ok: bool,
    intraday_drawdown_ok: bool,
) -> list[str]:
    blockers: list[str] = []
    if drawdown_pct_ok or intraday_drawdown_ok:
        return blockers
    if metrics.max_intraday_drawdown is None:
        blockers.append("runtime_ledger_max_intraday_drawdown_missing")
    elif (
        metrics.max_intraday_drawdown
        > DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.authority_max_intraday_drawdown
    ):
        blockers.append("runtime_ledger_max_intraday_drawdown_above_limit")
    if metrics.drawdown_pct is None:
        blockers.append("runtime_ledger_drawdown_pct_equity_missing")
    elif (
        metrics.drawdown_pct
        > DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.max_drawdown_pct_equity
    ):
        blockers.append("runtime_ledger_drawdown_pct_equity_above_limit")
    return blockers


def _non_authority_drawdown_blockers(
    metrics: _RuntimeLedgerMetrics,
    thresholds: RuntimeLedgerThresholds,
) -> list[str]:
    if metrics.drawdown_pct is None:
        return ["runtime_ledger_drawdown_pct_equity_missing"]
    if metrics.drawdown_pct > thresholds.max_drawdown_pct_equity:
        return ["runtime_ledger_drawdown_pct_equity_above_limit"]
    return []


def _risk_blockers(
    context: RuntimeLedgerCheckContext,
    metrics: _RuntimeLedgerMetrics,
) -> list[str]:
    blockers: list[str] = []
    thresholds = context.thresholds
    drawdown_pct_ok = (
        metrics.drawdown_pct is not None
        and metrics.drawdown_pct <= thresholds.max_drawdown_pct_equity
    )
    intraday_drawdown_ok = (
        metrics.max_intraday_drawdown is not None
        and metrics.max_intraday_drawdown
        <= DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.authority_max_intraday_drawdown
    )
    if context.authority_due:
        _extend_unique(
            blockers,
            _authority_drawdown_blockers(
                metrics,
                drawdown_pct_ok,
                intraday_drawdown_ok,
            ),
        )
    elif context.runtime_import_due:
        _extend_unique(blockers, _non_authority_drawdown_blockers(metrics, thresholds))
    if context.runtime_import_due and metrics.best_day_share is None:
        blockers.append("runtime_ledger_best_day_share_missing")
    elif (
        context.runtime_import_due
        and metrics.best_day_share is not None
        and metrics.best_day_share > thresholds.max_best_day_share
    ):
        blockers.append("runtime_ledger_best_day_share_above_limit")
    if context.runtime_import_due and metrics.symbol_concentration_share is None:
        blockers.append("runtime_ledger_symbol_concentration_share_missing")
    elif (
        context.runtime_import_due
        and metrics.symbol_concentration_share is not None
        and metrics.symbol_concentration_share
        > thresholds.max_symbol_concentration_share
    ):
        blockers.append("runtime_ledger_symbol_concentration_share_above_limit")
    return blockers


def _check_risk_quality(
    state: _RuntimeLedgerCheckState,
    metrics: _RuntimeLedgerMetrics,
) -> None:
    thresholds = state.context.thresholds
    risk_blockers = _risk_blockers(state.context, metrics)
    drawdown_pct_ok = (
        metrics.drawdown_pct is not None
        and metrics.drawdown_pct <= thresholds.max_drawdown_pct_equity
    )
    intraday_drawdown_ok = (
        metrics.max_intraday_drawdown is not None
        and metrics.max_intraday_drawdown
        <= DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.authority_max_intraday_drawdown
    )
    _check(
        state.checks,
        "runtime_ledger_risk_quality",
        passed=not risk_blockers,
        observed={
            "runtime_import_due": state.context.runtime_import_due,
            "drawdown_pct_equity": _decimal_text(metrics.drawdown_pct),
            "drawdown_pct_equity_source": metrics.drawdown_source,
            "max_intraday_drawdown": _decimal_text(metrics.max_intraday_drawdown),
            "max_intraday_drawdown_source": metrics.max_intraday_drawdown_source,
            "best_day_share": _decimal_text(metrics.best_day_share),
            "best_day_share_source": metrics.best_day_share_source,
            "symbol_concentration_share": _decimal_text(
                metrics.symbol_concentration_share
            ),
            "symbol_concentration_share_source": metrics.symbol_concentration_source,
            "authority_drawdown_limit_satisfied": (
                drawdown_pct_ok or intraday_drawdown_ok
            )
            if state.context.final_authority_mode
            else None,
        },
        expected={
            "max_drawdown_pct_equity": _decimal_text(
                thresholds.max_drawdown_pct_equity
            ),
            "max_intraday_drawdown": _decimal_text(
                DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.authority_max_intraday_drawdown
            ),
            "max_best_day_share": _decimal_text(thresholds.max_best_day_share),
            "max_symbol_concentration_share": _decimal_text(
                thresholds.max_symbol_concentration_share
            ),
        },
        blockers=risk_blockers,
        status=state.context.deferred_status,
    )
    _extend_unique(state.blockers, risk_blockers)


def evaluate_runtime_ledger_checks(
    *,
    checks: dict[str, dict[str, Any]],
    blockers: list[str],
    completion_status: Mapping[str, Any] | None,
    context: RuntimeLedgerCheckContext,
) -> RuntimeLedgerCheckResult:
    live_scale_gate = _completion_live_scale_gate(completion_status or {})
    completion_gate_blockers = _completion_blockers(live_scale_gate)
    runtime_summary = _mapping(live_scale_gate.get("runtime_ledger_summary"))
    ledger_refs = _runtime_ledger_refs(
        live_scale_gate, "strategy_runtime_ledger_buckets"
    )
    unbacked_refs = _runtime_ledger_refs(
        live_scale_gate, "runtime_ledger_unbacked_hypothesis_metric_windows"
    )
    gate_satisfied = _text(live_scale_gate.get("status")) == "satisfied"
    metrics = _runtime_ledger_metrics(runtime_summary, context.thresholds)
    state = _RuntimeLedgerCheckState(
        checks=checks,
        blockers=blockers,
        context=context,
    )
    _check_doc29_live_scale_gate(
        state,
        live_scale_gate,
        completion_gate_blockers,
        gate_satisfied,
    )
    _check_runtime_ledger_refs(state, ledger_refs, unbacked_refs)
    _check_lifecycle_counts(state, metrics)
    _check_authority_mechanical_floor(state, metrics)
    _check_post_cost_profit_target(state, metrics)
    _check_daily_distribution_authority(state, metrics)
    _check_target_implied_scale(state, metrics)
    _check_risk_quality(state, metrics)
    return RuntimeLedgerCheckResult(
        live_scale_gate=live_scale_gate,
        runtime_summary=runtime_summary,
        ledger_refs=ledger_refs,
        unbacked_refs=unbacked_refs,
        target_implied_avg_daily_filled_notional=metrics.target_implied_avg_daily_filled_notional,
    )


__all__ = (
    "RuntimeLedgerCheckContext",
    "RuntimeLedgerCheckResult",
    "RuntimeLedgerThresholds",
    "evaluate_runtime_ledger_checks",
    "_completion_blockers",
)
