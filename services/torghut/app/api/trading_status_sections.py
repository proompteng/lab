"""Budgeted read-model sections for the Torghut trading status route."""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from contextlib import AbstractContextManager
from dataclasses import dataclass
from typing import cast

from app.trading.hypotheses import JangarDependencyQuorumStatus

from .status_helpers import TradingStatusReadBudget
from .trading_status_context import TradingStatusContext


@dataclass(frozen=True)
class TradingStatusSectionDependencies:
    session_factory: Callable[[], AbstractContextManager[object]]
    budget_exhausted_live_submission_gate_payload: Callable[..., dict[str, object]]
    budget_exhausted_options_catalog_freshness_payload: Callable[..., dict[str, object]]
    budget_unavailable_hypothesis_runtime_payload: Callable[
        ..., tuple[dict[str, object], dict[str, object], JangarDependencyQuorumStatus]
    ]
    budget_unavailable_llm_evaluation_payload: Callable[[str], dict[str, object]]
    budget_unavailable_tca_summary_payload: Callable[[str], dict[str, object]]
    build_live_submission_gate_payload: Callable[..., dict[str, object]]
    deferred_hypothesis_payload_for_live_submission_gate: Callable[
        [], dict[str, object]
    ]
    hypothesis_payload_read_model_unavailable: Callable[
        [Mapping[str, object] | None], bool
    ]
    load_clickhouse_ta_status: Callable[..., dict[str, object]]
    load_last_decision_at: Callable[..., object | None]
    load_options_catalog_freshness_summary: Callable[..., dict[str, object]]
    load_rejected_signal_outcome_learning_summary: Callable[..., object | None]
    load_trading_status_hypothesis_runtime: Callable[
        ...,
        tuple[dict[str, object], dict[str, object], JangarDependencyQuorumStatus],
    ]
    load_trading_status_llm_evaluation: Callable[..., dict[str, object]]
    load_trading_status_runtime_ledger_portfolio_summary: Callable[
        ..., dict[str, object]
    ]
    load_trading_status_tca_summary: Callable[..., dict[str, object]]
    load_trading_status_tigerbeetle_ledger: Callable[..., dict[str, object]]


@dataclass(frozen=True)
class TradingStatusCoreSections:
    clickhouse_ta_status: dict[str, object]
    live_submission_gate: dict[str, object]
    llm_evaluation: dict[str, object]
    tca_summary: dict[str, object]
    hypothesis_payload: dict[str, object]
    hypothesis_summary: dict[str, object]
    hypothesis_dependency_quorum: JangarDependencyQuorumStatus


@dataclass(frozen=True)
class TradingStatusLateReadSections:
    tigerbeetle_ledger: dict[str, object]
    runtime_ledger_portfolio_summary: dict[str, object]
    last_decision_at: object | None
    persisted_rejected_signal_outcome_learning: Mapping[str, object] | None


_FAST_STATUS_GATE_REASONS = {
    "broker_unavailable",
    "emergency_stop_active",
    "kill_switch_enabled",
    "live_submit_activation_expired",
    "live_submit_activation_expiry_invalid",
    "live_submit_activation_missing",
    "live_submit_disabled",
    "simple_submit_disabled",
    "testnet_after_hours_disabled",
    "trading_disabled",
}


def load_trading_status_core_sections(
    status_read_budget: TradingStatusReadBudget,
    context: TradingStatusContext,
    *,
    deps: TradingStatusSectionDependencies,
) -> TradingStatusCoreSections:
    clickhouse_ta_status = _deferred_clickhouse_ta_status(
        context.clickhouse_ta_deferred_reason
    )
    gate_hypothesis_payload = (
        deps.deferred_hypothesis_payload_for_live_submission_gate()
    )
    live_submission_gate_skip_reason = status_read_budget.skip_reason_if_unavailable(
        "live_submission_gate",
        min_remaining_seconds=2.0,
    )
    if live_submission_gate_skip_reason is not None:
        live_submission_gate = deps.budget_exhausted_live_submission_gate_payload(
            reason=live_submission_gate_skip_reason,
            empirical_jobs_status=context.empirical_jobs,
            quant_health_status=context.quant_evidence,
        )
    else:
        live_submission_gate = _build_live_submission_gate(
            context,
            clickhouse_ta_status=clickhouse_ta_status,
            hypothesis_payload=gate_hypothesis_payload,
            deps=deps,
        )
    fast_status_gate_reason = (
        None
        if live_submission_gate_skip_reason is not None
        else _fast_status_gate_reason(live_submission_gate)
    )
    if fast_status_gate_reason is not None:
        (
            llm_evaluation,
            tca_summary,
            hypothesis_payload,
            hypothesis_summary,
            hypothesis_dependency_quorum,
        ) = _skip_expensive_status_reads_after_closed_gate(
            status_read_budget,
            reason=fast_status_gate_reason,
            deps=deps,
        )
    else:
        clickhouse_ta_status = _load_clickhouse_ta_status_for_trading_status(
            status_read_budget,
            context,
            deps=deps,
        )
        llm_evaluation = deps.load_trading_status_llm_evaluation(status_read_budget)
        tca_summary = deps.load_trading_status_tca_summary(
            status_read_budget,
            scheduler=context.scheduler,
        )
        hypothesis_payload, hypothesis_summary, hypothesis_dependency_quorum = (
            deps.load_trading_status_hypothesis_runtime(
                status_read_budget,
                context.scheduler,
                tca_summary=tca_summary,
                market_context_status=context.market_context_status,
                feature_readiness=clickhouse_ta_status,
            )
        )
    if (
        live_submission_gate_skip_reason is None
        and fast_status_gate_reason is None
        and not deps.hypothesis_payload_read_model_unavailable(hypothesis_payload)
        and status_read_budget.remaining_seconds() >= 2.0
    ):
        live_submission_gate = _build_live_submission_gate(
            context,
            clickhouse_ta_status=clickhouse_ta_status,
            hypothesis_payload=hypothesis_payload,
            deps=deps,
        )
    return TradingStatusCoreSections(
        clickhouse_ta_status=clickhouse_ta_status,
        live_submission_gate=live_submission_gate,
        llm_evaluation=llm_evaluation,
        tca_summary=tca_summary,
        hypothesis_payload=hypothesis_payload,
        hypothesis_summary=hypothesis_summary,
        hypothesis_dependency_quorum=hypothesis_dependency_quorum,
    )


def load_trading_status_late_read_sections(
    status_read_budget: TradingStatusReadBudget,
    context: TradingStatusContext,
    *,
    deps: TradingStatusSectionDependencies,
) -> TradingStatusLateReadSections:
    tigerbeetle_ledger = deps.load_trading_status_tigerbeetle_ledger(status_read_budget)
    runtime_ledger_portfolio_summary = (
        deps.load_trading_status_runtime_ledger_portfolio_summary(
            status_read_budget,
            account_label=context.trading_account_label,
            stage_scope=context.status_stage_scope,
            observed_at=context.status_observed_at,
        )
    )
    last_decision_at = None
    last_decision_skip_reason = status_read_budget.skip_reason_if_unavailable(
        "last_decision",
        min_remaining_seconds=0.25,
    )
    if last_decision_skip_reason is None:
        with deps.session_factory() as session:
            last_decision_at = deps.load_last_decision_at(session)
    persisted_rejected_signal_outcome_learning: Mapping[str, object] | None = None
    rejected_signal_outcome_learning_skip_reason = (
        status_read_budget.skip_reason_if_unavailable(
            "rejected_signal_outcome_learning",
            min_remaining_seconds=0.5,
        )
    )
    if rejected_signal_outcome_learning_skip_reason is None:
        with deps.session_factory() as session:
            persisted_rejected_signal_outcome_learning = cast(
                Mapping[str, object] | None,
                deps.load_rejected_signal_outcome_learning_summary(session),
            )
    return TradingStatusLateReadSections(
        tigerbeetle_ledger=tigerbeetle_ledger,
        runtime_ledger_portfolio_summary=runtime_ledger_portfolio_summary,
        last_decision_at=last_decision_at,
        persisted_rejected_signal_outcome_learning=(
            persisted_rejected_signal_outcome_learning
        ),
    )


def load_trading_status_options_catalog_freshness(
    status_read_budget: TradingStatusReadBudget,
    route_symbols: Sequence[object],
    *,
    deps: TradingStatusSectionDependencies,
) -> dict[str, object]:
    options_catalog_freshness_skip_reason = (
        status_read_budget.skip_reason_if_unavailable(
            "options_catalog_freshness",
            min_remaining_seconds=2.0,
        )
    )
    if options_catalog_freshness_skip_reason is not None:
        return deps.budget_exhausted_options_catalog_freshness_payload(
            reason=options_catalog_freshness_skip_reason,
            route_symbols=route_symbols,
        )
    with deps.session_factory() as session:
        return deps.load_options_catalog_freshness_summary(
            session,
            route_symbols=route_symbols,
        )


def _build_live_submission_gate(
    context: TradingStatusContext,
    *,
    clickhouse_ta_status: Mapping[str, object],
    hypothesis_payload: Mapping[str, object],
    deps: TradingStatusSectionDependencies,
) -> dict[str, object]:
    with deps.session_factory() as session:
        live_submission_gate = deps.build_live_submission_gate_payload(
            context.state,
            session=session,
            hypothesis_summary=hypothesis_payload,
            empirical_jobs_status=context.empirical_jobs,
            dspy_runtime_status=context.scheduler.llm_status().get("dspy_runtime", {}),
            quant_health_status=context.quant_evidence,
            clickhouse_ta_status=clickhouse_ta_status,
        )
    if not bool(live_submission_gate.get("read_model_unavailable")):
        setattr(
            context.scheduler,
            "_last_live_submission_gate",
            dict(live_submission_gate),
        )
    return live_submission_gate


def _fast_status_gate_reason(live_submission_gate: Mapping[str, object]) -> str | None:
    raw_reasons: list[object] = [
        live_submission_gate.get("reason"),
        live_submission_gate.get("blocked_reason"),
    ]
    blocked_reasons = live_submission_gate.get("blocked_reasons")
    if isinstance(blocked_reasons, list):
        raw_reasons.extend(cast(list[object], blocked_reasons))
    for raw_reason in raw_reasons:
        reason = str(raw_reason or "").strip()
        if reason in _FAST_STATUS_GATE_REASONS:
            return reason
    return None


def _skip_expensive_status_reads_after_closed_gate(
    status_read_budget: TradingStatusReadBudget,
    *,
    reason: str,
    deps: TradingStatusSectionDependencies,
) -> tuple[
    dict[str, object],
    dict[str, object],
    dict[str, object],
    dict[str, object],
    JangarDependencyQuorumStatus,
]:
    llm_reason = status_read_budget.skip_reason(
        "llm_evaluation",
        reason_code=reason,
    )
    tca_reason = status_read_budget.skip_reason(
        "tca_summary",
        reason_code=reason,
    )
    hypothesis_reason = status_read_budget.skip_reason(
        "hypothesis_runtime",
        reason_code=reason,
    )
    hypothesis_payload, hypothesis_summary, hypothesis_dependency_quorum = (
        deps.budget_unavailable_hypothesis_runtime_payload(reason=hypothesis_reason)
    )
    return (
        deps.budget_unavailable_llm_evaluation_payload(llm_reason),
        deps.budget_unavailable_tca_summary_payload(tca_reason),
        hypothesis_payload,
        hypothesis_summary,
        hypothesis_dependency_quorum,
    )


def _deferred_clickhouse_ta_status(reason: str) -> dict[str, object]:
    return {
        "state": "deferred",
        "source_ref": "trading_status",
        "read_model_unavailable": True,
        "read_model_status": "deferred",
        "reason": reason,
        "reason_codes": [reason],
    }


def _load_clickhouse_ta_status_for_trading_status(
    status_read_budget: TradingStatusReadBudget,
    context: TradingStatusContext,
    *,
    deps: TradingStatusSectionDependencies,
) -> dict[str, object]:
    skip_reason = status_read_budget.skip_reason_if_unavailable(
        "clickhouse_ta_status",
        min_remaining_seconds=0.75,
    )
    if skip_reason is not None:
        return _deferred_clickhouse_ta_status(skip_reason)
    return deps.load_clickhouse_ta_status(context.scheduler)


__all__ = [
    "TradingStatusCoreSections",
    "TradingStatusLateReadSections",
    "TradingStatusSectionDependencies",
    "load_trading_status_core_sections",
    "load_trading_status_late_read_sections",
    "load_trading_status_options_catalog_freshness",
]
