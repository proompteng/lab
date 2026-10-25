"""Canonical scheduler liveness and Kubernetes readiness projections."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from ...config import settings
from .runtime import TradingScheduler


@dataclass(frozen=True, slots=True)
class _SchedulerSuccessFreshness:
    observed: bool
    observed_at: datetime | None
    age_seconds: float | None
    is_fresh: bool


def _scheduler_success_age_seconds(last_run_at: object) -> float | None:
    if not isinstance(last_run_at, datetime):
        return None
    normalized = last_run_at
    if normalized.tzinfo is None:
        normalized = normalized.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - normalized).total_seconds()


def _scheduler_success_freshness(
    last_success_at: object,
) -> _SchedulerSuccessFreshness:
    age_seconds = _scheduler_success_age_seconds(last_success_at)
    return _SchedulerSuccessFreshness(
        observed=last_success_at is not None,
        observed_at=last_success_at if isinstance(last_success_at, datetime) else None,
        age_seconds=age_seconds,
        is_fresh=(
            age_seconds is not None
            and 0 <= age_seconds <= settings.trading_scheduler_success_max_age_seconds
        ),
    )


def _scheduler_readiness_detail(
    *,
    running: bool,
    trading_success: _SchedulerSuccessFreshness,
    reconcile_success: _SchedulerSuccessFreshness,
    cycle_failed: bool,
    leadership_ok: bool,
) -> str:
    failed_conditions = (
        (not running, "scheduler_not_running"),
        (cycle_failed, "scheduler_cycle_failed"),
        (not trading_success.observed, "scheduler_success_missing"),
        (not trading_success.is_fresh, "scheduler_success_stale"),
        (not reconcile_success.observed, "scheduler_reconcile_success_missing"),
        (not reconcile_success.is_fresh, "scheduler_reconcile_success_stale"),
        (not leadership_ok, "scheduler_leadership_unhealthy"),
    )
    return next(
        (detail for failed, detail in failed_conditions if failed),
        "ok",
    )


def scheduler_readiness_payload(scheduler: TradingScheduler) -> dict[str, object]:
    """Require fresh trading and reconciliation success plus healthy leadership."""

    state = scheduler.state
    running = bool(getattr(state, "running", False))
    loop_errors = {
        "last_error": getattr(state, "last_error", None),
        "last_trading_error": getattr(state, "last_trading_error", None),
        "last_reconcile_error": getattr(state, "last_reconcile_error", None),
        "last_autonomy_error": getattr(state, "last_autonomy_error", None),
        "last_evidence_error": getattr(state, "last_evidence_error", None),
    }
    trading_success = _scheduler_success_freshness(getattr(state, "last_run_at", None))
    reconcile_success = _scheduler_success_freshness(
        getattr(state, "last_reconcile_at", None)
    )
    leadership = scheduler_liveness_payload(scheduler)
    leadership_ok = bool(leadership["ok"])
    cycle_failed = any(error is not None for error in loop_errors.values())
    ready = (
        running
        and trading_success.is_fresh
        and reconcile_success.is_fresh
        and not cycle_failed
        and leadership_ok
    )
    payload: dict[str, object] = {
        "ok": ready,
        "process_role": settings.process_role,
        "running": running,
        "detail": _scheduler_readiness_detail(
            running=running,
            trading_success=trading_success,
            reconcile_success=reconcile_success,
            cycle_failed=cycle_failed,
            leadership_ok=leadership_ok,
        ),
        "success_max_age_seconds": settings.trading_scheduler_success_max_age_seconds,
        "trading_success_is_fresh": trading_success.is_fresh,
        "reconcile_success_is_fresh": reconcile_success.is_fresh,
        "leadership": leadership.get("leadership"),
    }
    if trading_success.observed_at is not None:
        payload["last_run_at"] = trading_success.observed_at.isoformat()
    if trading_success.age_seconds is not None:
        payload["success_age_seconds"] = trading_success.age_seconds
        payload["trading_success_age_seconds"] = trading_success.age_seconds
    if reconcile_success.observed_at is not None:
        payload["last_reconcile_at"] = reconcile_success.observed_at.isoformat()
    if reconcile_success.age_seconds is not None:
        payload["reconcile_success_age_seconds"] = reconcile_success.age_seconds
    for key, error in loop_errors.items():
        if error is not None:
            payload[key] = str(error)
    return payload


def scheduler_liveness_payload(scheduler: TradingScheduler) -> dict[str, object]:
    """Require a healthy trading loop and leadership when trading is enabled."""

    trading_enabled = bool(settings.trading_enabled)
    running = bool(getattr(scheduler.state, "running", False))
    leadership_status = getattr(scheduler, "leadership_status", None)
    if callable(leadership_status):
        leadership_status = leadership_status()
    trading_payload = {
        "enabled": trading_enabled,
        "loop_required": trading_enabled,
        "running": running,
    }
    if leadership_status is None:
        if not trading_enabled:
            return {
                "ok": True,
                "process_role": settings.process_role,
                "detail": "trading_disabled",
                "trading": trading_payload,
            }
        return {
            "ok": False,
            "process_role": settings.process_role,
            "detail": "leadership_status_unavailable",
            "trading": trading_payload,
        }

    required = bool(getattr(leadership_status, "required", True))
    acquired = bool(getattr(leadership_status, "acquired", False))
    healthy = bool(getattr(leadership_status, "healthy", False))
    leadership_ok = healthy and (acquired or not required)
    leadership_payload = {
        "required": required,
        "acquired": acquired,
        "healthy": healthy,
        "failure_reason": getattr(leadership_status, "failure_reason", None),
    }
    if not trading_enabled:
        ok = True
        detail = "trading_disabled"
    elif not leadership_ok:
        ok = False
        detail = "scheduler_leadership_unhealthy"
    elif not running:
        ok = False
        detail = "scheduler_loop_not_running"
    else:
        ok = True
        detail = "ok"
    return {
        "ok": ok,
        "process_role": settings.process_role,
        "detail": detail,
        "trading": trading_payload,
        "leadership": leadership_payload,
    }


__all__ = ["scheduler_liveness_payload", "scheduler_readiness_payload"]
