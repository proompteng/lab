"""Extracted Torghut API route and support functions."""

from __future__ import annotations

from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    pass

from .common import (
    JangarDependencyQuorumStatus,
    Mapping,
    SQLAlchemyError,
    SessionLocal,
    TRADING_STATUS_READ_BUDGET_SECONDS,
    TradingScheduler,
    cast,
    datetime,
    load_hypothesis_registry,
    logger,
    resolve_hypothesis_dependency_quorum,
    settings,
    text,
    time,
    timezone,
)
from .health_checks import (
    build_hypothesis_runtime_payload,
    build_tigerbeetle_ledger_status,
    empty_tigerbeetle_ref_counts,
    load_tca_summary,
    unavailable_tigerbeetle_reconciliation_payload,
)
from .trading_misc import daily_runtime_ledger_portfolio_summary
from .vnext_helpers import load_llm_evaluation

_build_hypothesis_runtime_payload = build_hypothesis_runtime_payload
_build_tigerbeetle_ledger_status = build_tigerbeetle_ledger_status
_daily_runtime_ledger_portfolio_summary = daily_runtime_ledger_portfolio_summary
_empty_tigerbeetle_ref_counts = empty_tigerbeetle_ref_counts
_load_llm_evaluation = load_llm_evaluation
_load_tca_summary = load_tca_summary
_unavailable_tigerbeetle_reconciliation_payload = (
    unavailable_tigerbeetle_reconciliation_payload
)


class _TradingStatusReadBudget:
    def __init__(self, *, max_seconds: float | None = None):
        configured_seconds = (
            TRADING_STATUS_READ_BUDGET_SECONDS if max_seconds is None else max_seconds
        )
        self.max_seconds = max(0.0, float(configured_seconds))
        self._started_at = time.monotonic()
        self.skipped_reads: list[str] = []

    def elapsed_seconds(self) -> float:
        return max(0.0, time.monotonic() - self._started_at)

    def remaining_seconds(self) -> float:
        return max(0.0, self.max_seconds - self.elapsed_seconds())

    def exhausted(self) -> bool:
        return self.elapsed_seconds() >= self.max_seconds

    def skip_reason(
        self,
        read_name: str,
        *,
        reason_code: str = "status_read_budget_exhausted",
    ) -> str:
        if read_name not in self.skipped_reads:
            self.skipped_reads.append(read_name)
        return f"{read_name}_{reason_code}"

    def skip_reason_if_unavailable(
        self,
        read_name: str,
        *,
        min_remaining_seconds: float = 0.0,
    ) -> str | None:
        if self.exhausted():
            return self.skip_reason(read_name)
        if self.remaining_seconds() < max(0.0, min_remaining_seconds):
            return self.skip_reason(
                read_name,
                reason_code="status_read_budget_insufficient_remaining",
            )
        return None

    def as_payload(self) -> dict[str, object]:
        return {
            "max_seconds": self.max_seconds,
            "elapsed_seconds": round(self.elapsed_seconds(), 3),
            "remaining_seconds": round(self.remaining_seconds(), 3),
            "exhausted": self.exhausted(),
            "skipped_reads": list(self.skipped_reads),
        }


def _rollback_status_read_session(session: object, *, context: str) -> None:
    rollback = getattr(session, "rollback", None)
    if not callable(rollback):
        return
    try:
        rollback()
    except SQLAlchemyError:
        logger.warning("Failed to roll back %s status-read session", context)


def _apply_status_read_statement_timeout(
    session: object,
    *,
    milliseconds: int,
) -> None:
    get_bind = getattr(session, "get_bind", None)
    if not callable(get_bind):
        return
    try:
        bind = get_bind()
        dialect = getattr(getattr(bind, "dialect", None), "name", "")
        if dialect == "postgresql":
            timeout_ms = max(1, int(milliseconds))
            execute = getattr(session, "execute", None)
            if callable(execute):
                execute(text(f"SET LOCAL statement_timeout = {timeout_ms}"))
    except SQLAlchemyError:
        raise
    except Exception:
        return


def _budget_unavailable_llm_evaluation_payload(reason: str) -> dict[str, object]:
    return {
        "ok": False,
        "error": reason,
        "read_model_unavailable": True,
        "read_model_status": "timeout",
        "reason_codes": [reason],
    }


def _budget_unavailable_tca_summary_payload(reason: str) -> dict[str, object]:
    return {
        "account_label": settings.trading_account_label,
        "order_count": 0,
        "filled_execution_count": 0,
        "expected_shortfall_sample_count": 0,
        "expected_shortfall_coverage": "0",
        "avg_abs_slippage_bps": None,
        "avg_realized_shortfall_bps": None,
        "avg_divergence_bps": None,
        "latest_execution_created_at": None,
        "last_computed_at": None,
        "scope_symbols": [],
        "scope_symbol_count": 0,
        "symbol_breakdown": [],
        "missing_symbols": [],
        "read_model_unavailable": True,
        "read_model_status": "timeout",
        "reason_codes": [reason],
    }


def _budget_unavailable_tigerbeetle_ledger_payload(reason: str) -> dict[str, object]:
    reconciliation_required = bool(
        settings.tigerbeetle_required or settings.tigerbeetle_reconcile_required
    )
    latest_reconciliation = _unavailable_tigerbeetle_reconciliation_payload(
        reason_codes=[reason],
        last_error=reason,
    )
    ref_counts = _empty_tigerbeetle_ref_counts(
        reason_codes=[reason],
        last_error=reason,
    )
    return {
        "schema_version": "torghut.tigerbeetle-ledger-status.v1",
        "enabled": settings.tigerbeetle_enabled,
        "journal_enabled": settings.tigerbeetle_journal_enabled,
        "required": settings.tigerbeetle_required,
        "reconcile_required": settings.tigerbeetle_reconcile_required,
        "claimed_by_runtime_evidence": False,
        "reconciliation_required": reconciliation_required,
        "ok": False,
        "protocol_ok": False,
        "protocol_probe_skipped": True,
        "reconciliation_ok": False,
        "reconciliation_age_seconds": None,
        "reconciliation_max_age_seconds": max(
            1,
            int(settings.tigerbeetle_reconcile_max_age_seconds),
        ),
        "reconciliation_stale": False,
        "cluster_id": settings.tigerbeetle_cluster_id,
        "replica_addresses": [],
        "last_error": reason,
        "ref_counts": ref_counts,
        "account_ref_count": 0,
        "transfer_ref_count": 0,
        "runtime_ledger_ref_count": 0,
        "runtime_ledger_signed_ref_count": 0,
        "runtime_ledger_missing_signed_ref_count": 0,
        "runtime_ledger_missing_account_ref_count": 0,
        "source_materialization": {},
        "latest_reconciliation": latest_reconciliation,
        "blockers": [reason],
        "read_model_unavailable": True,
        "reason_codes": [reason],
    }


def _unavailable_runtime_ledger_portfolio_summary(
    *,
    account_label: str,
    stage_scope: str,
    observed_at: datetime,
    reason: str,
) -> dict[str, object]:
    observed = (
        observed_at.astimezone(timezone.utc)
        if observed_at.tzinfo
        else observed_at.replace(tzinfo=timezone.utc)
    )
    day_start = observed.replace(hour=0, minute=0, second=0, microsecond=0)
    stage = stage_scope.strip()
    account = account_label.strip()
    return {
        "summary_basis": "runtime_ledger_daily_stage_account_scope",
        "day_start": day_start.isoformat(),
        "observed_at": observed.isoformat(),
        "filters": {
            "account_label": account,
            "stage_scope": stage,
            "observed_stage": stage if stage in {"paper", "live"} else "__missing__",
        },
        "bucket_count": 0,
        "evidence_grade_bucket_count": 0,
        "post_cost_net_pnl_per_day": "0",
        "filled_notional": "0",
        "candidate_ids": [],
        "db_row_refs": [],
        "blockers": [reason],
        "read_model_unavailable": True,
        "query_limit": 200,
    }


def _budget_unavailable_hypothesis_runtime_payload(
    *,
    reason: str,
) -> tuple[dict[str, object], dict[str, object], JangarDependencyQuorumStatus]:
    registry = load_hypothesis_registry()
    dependency_quorum = resolve_hypothesis_dependency_quorum(registry)
    summary: dict[str, object] = {
        "hypotheses_total": len(registry.items),
        "state_totals": {},
        "capital_stage_totals": {},
        "promotion_eligible_total": 0,
        "paper_probation_eligible_total": 0,
        "rollback_required_total": 0,
        "read_model_unavailable": True,
        "read_model_status": "timeout",
        "reason_codes": [reason],
        "runtime_ledger_read_status": {
            "status": "unavailable",
            "reason_codes": [reason],
            "query_limit": None,
            "query_limit_per_hypothesis": None,
        },
        "runtime_ledger_read_model": {
            "query_scope": "hypothesis_runtime_status",
            "query_limit_per_hypothesis": None,
            "reason_codes": [reason],
            "read_model_unavailable": True,
        },
        "certificate_evidence_read_status": {
            "status": "degraded",
            "reason_codes": [reason],
            "read_model_unavailable": True,
        },
    }
    return (
        {
            "registry_loaded": registry.loaded,
            "registry_path": registry.path,
            "registry_errors": list(registry.errors),
            "dependency_quorum": dependency_quorum.as_payload(),
            "summary": summary,
            "items": [],
        },
        summary,
        dependency_quorum,
    )


def _deferred_hypothesis_payload_for_live_submission_gate() -> dict[str, object]:
    payload, _summary, _dependency_quorum = (
        _budget_unavailable_hypothesis_runtime_payload(
            reason="hypothesis_runtime_deferred_until_after_live_submission_gate"
        )
    )
    dependency_quorum = payload.get("dependency_quorum")
    if not isinstance(dependency_quorum, Mapping):
        return payload

    nested_summary = payload.get("summary")
    summary_payload: dict[str, object] = (
        dict(cast(Mapping[str, object], nested_summary))
        if isinstance(nested_summary, Mapping)
        else {}
    )
    if "dependency_quorum" not in summary_payload:
        payload = dict(payload)
        summary_payload["dependency_quorum"] = dict(
            cast(Mapping[str, object], dependency_quorum)
        )
        payload["summary"] = summary_payload
    return payload


def _hypothesis_payload_read_model_unavailable(
    payload: Mapping[str, object] | None,
) -> bool:
    if not isinstance(payload, Mapping):
        return True
    summary = payload.get("summary")
    if not isinstance(summary, Mapping):
        return True
    summary_payload = cast(Mapping[str, object], summary)
    return bool(summary_payload.get("read_model_unavailable"))


def _load_trading_status_llm_evaluation(
    status_read_budget: _TradingStatusReadBudget,
) -> dict[str, object]:
    skip_reason = status_read_budget.skip_reason_if_unavailable(
        "llm_evaluation",
        min_remaining_seconds=0.75,
    )
    if skip_reason is not None:
        return _budget_unavailable_llm_evaluation_payload(skip_reason)
    with SessionLocal() as session:
        return _load_llm_evaluation(session)


def _load_trading_status_tca_summary(
    status_read_budget: _TradingStatusReadBudget,
    *,
    scheduler: TradingScheduler,
) -> dict[str, object]:
    skip_reason = status_read_budget.skip_reason_if_unavailable(
        "tca_summary",
        min_remaining_seconds=1.0,
    )
    if skip_reason is not None:
        return _budget_unavailable_tca_summary_payload(skip_reason)
    with SessionLocal() as session:
        return _load_tca_summary(session, scheduler=scheduler)


def _load_trading_status_tigerbeetle_ledger(
    status_read_budget: _TradingStatusReadBudget,
) -> dict[str, object]:
    skip_reason = status_read_budget.skip_reason_if_unavailable(
        "tigerbeetle_ledger",
        min_remaining_seconds=2.0,
    )
    if skip_reason is not None:
        return _budget_unavailable_tigerbeetle_ledger_payload(skip_reason)
    with SessionLocal() as session:
        return _build_tigerbeetle_ledger_status(session)


def _load_trading_status_runtime_ledger_portfolio_summary(
    status_read_budget: _TradingStatusReadBudget,
    *,
    account_label: str,
    stage_scope: str,
    observed_at: datetime,
) -> dict[str, object]:
    skip_reason = status_read_budget.skip_reason_if_unavailable(
        "runtime_ledger_portfolio_summary",
        min_remaining_seconds=1.0,
    )
    if skip_reason is not None:
        return _unavailable_runtime_ledger_portfolio_summary(
            account_label=account_label,
            stage_scope=stage_scope,
            observed_at=observed_at,
            reason=skip_reason,
        )
    with SessionLocal() as session:
        return _daily_runtime_ledger_portfolio_summary(
            session=session,
            account_label=account_label,
            stage_scope=stage_scope,
            observed_at=observed_at,
        )


def _load_trading_status_hypothesis_runtime(
    status_read_budget: _TradingStatusReadBudget,
    scheduler: TradingScheduler,
    *,
    tca_summary: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    feature_readiness: Mapping[str, Any],
) -> tuple[dict[str, object], dict[str, object], JangarDependencyQuorumStatus]:
    skip_reason = status_read_budget.skip_reason_if_unavailable(
        "hypothesis_runtime",
        min_remaining_seconds=1.5,
    )
    if skip_reason is not None:
        return _budget_unavailable_hypothesis_runtime_payload(reason=skip_reason)
    return _build_hypothesis_runtime_payload(
        scheduler,
        tca_summary=tca_summary,
        market_context_status=market_context_status,
        feature_readiness=feature_readiness,
    )


TradingStatusReadBudget = _TradingStatusReadBudget
rollback_status_read_session = _rollback_status_read_session
apply_status_read_statement_timeout = _apply_status_read_statement_timeout
budget_unavailable_hypothesis_runtime_payload = (
    _budget_unavailable_hypothesis_runtime_payload
)
budget_unavailable_llm_evaluation_payload = _budget_unavailable_llm_evaluation_payload
budget_unavailable_tca_summary_payload = _budget_unavailable_tca_summary_payload
budget_unavailable_tigerbeetle_ledger_payload = (
    _budget_unavailable_tigerbeetle_ledger_payload
)
deferred_hypothesis_payload_for_live_submission_gate = (
    _deferred_hypothesis_payload_for_live_submission_gate
)
hypothesis_payload_read_model_unavailable = _hypothesis_payload_read_model_unavailable
load_trading_status_llm_evaluation = _load_trading_status_llm_evaluation
load_trading_status_tca_summary = _load_trading_status_tca_summary
load_trading_status_tigerbeetle_ledger = _load_trading_status_tigerbeetle_ledger
load_trading_status_runtime_ledger_portfolio_summary = (
    _load_trading_status_runtime_ledger_portfolio_summary
)
load_trading_status_hypothesis_runtime = _load_trading_status_hypothesis_runtime
unavailable_runtime_ledger_portfolio_summary = (
    _unavailable_runtime_ledger_portfolio_summary
)


__all__ = [
    "_TradingStatusReadBudget",
    "_rollback_status_read_session",
    "_apply_status_read_statement_timeout",
    "_budget_unavailable_llm_evaluation_payload",
    "_budget_unavailable_tca_summary_payload",
    "_budget_unavailable_tigerbeetle_ledger_payload",
    "_unavailable_runtime_ledger_portfolio_summary",
    "_budget_unavailable_hypothesis_runtime_payload",
    "_deferred_hypothesis_payload_for_live_submission_gate",
    "_hypothesis_payload_read_model_unavailable",
    "_load_trading_status_llm_evaluation",
    "_load_trading_status_tca_summary",
    "_load_trading_status_tigerbeetle_ledger",
    "_load_trading_status_runtime_ledger_portfolio_summary",
    "_load_trading_status_hypothesis_runtime",
    "TradingStatusReadBudget",
    "rollback_status_read_session",
    "apply_status_read_statement_timeout",
    "budget_unavailable_hypothesis_runtime_payload",
    "budget_unavailable_llm_evaluation_payload",
    "budget_unavailable_tca_summary_payload",
    "budget_unavailable_tigerbeetle_ledger_payload",
    "deferred_hypothesis_payload_for_live_submission_gate",
    "hypothesis_payload_read_model_unavailable",
    "load_trading_status_llm_evaluation",
    "load_trading_status_tca_summary",
    "load_trading_status_tigerbeetle_ledger",
    "load_trading_status_runtime_ledger_portfolio_summary",
    "load_trading_status_hypothesis_runtime",
    "unavailable_runtime_ledger_portfolio_summary",
]
