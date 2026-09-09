"""Trading universe readiness dependency evaluation."""

from __future__ import annotations

from app.config import settings
from app.trading.scheduler import TradingScheduler

from . import status_dependencies

__all__ = ("evaluate_universe_dependency",)


def evaluate_universe_dependency(
    scheduler: TradingScheduler | None,
) -> dict[str, object]:
    require_non_empty = (
        settings.trading_universe_source == "static"
        or settings.trading_universe_require_non_empty_jangar
    )
    payload: dict[str, object]
    if scheduler is None:
        payload = {
            "ok": not require_non_empty,
            "detail": "universe state unavailable",
            "source": settings.trading_universe_source,
            "status": None,
            "reason": None,
            "symbols_count": None,
            "cache_age_seconds": None,
            "require_non_empty": require_non_empty,
        }
    elif (state := getattr(scheduler, "state", None)) is None:
        payload = {
            "ok": True,
            "detail": "universe state unavailable",
            "source": settings.trading_universe_source,
            "status": None,
            "reason": None,
            "symbols_count": None,
            "cache_age_seconds": None,
            "require_non_empty": require_non_empty,
        }
    else:
        universe_status = getattr(state, "universe_source_status", None)
        universe_symbols_count = getattr(state, "universe_symbols_count", None)
        if universe_status in {"unknown", "not_evaluated", None} or (
            require_non_empty and not universe_symbols_count
        ):
            status_dependencies.refresh_universe_state_for_readiness(
                scheduler=scheduler,
                state=state,
            )

        universe_status = getattr(state, "universe_source_status", None)
        universe_reason = getattr(state, "universe_source_reason", None)
        universe_symbols_count = getattr(state, "universe_symbols_count", None)
        universe_cache_age_seconds = getattr(state, "universe_cache_age_seconds", None)
        universe_fail_safe_blocked = bool(
            getattr(state, "universe_fail_safe_blocked", False)
        )
        max_stale_seconds = max(1, settings.trading_universe_max_stale_seconds)

        ok = True
        detail = f"{settings.trading_universe_source} universe ok"
        if universe_status == "error":
            ok = False
            detail = f"{settings.trading_universe_source} universe unavailable"
        elif universe_status == "empty" and (
            universe_fail_safe_blocked or require_non_empty
        ):
            ok = False
            detail = f"{settings.trading_universe_source} universe empty"
        elif universe_status == "degraded":
            ok = not universe_fail_safe_blocked
            detail = "jangar stale cache in use"
            if (
                isinstance(universe_reason, str)
                and "static_fallback" in universe_reason
            ):
                detail = "jangar static fallback in use"
        elif universe_status == "ok":
            detail = f"{settings.trading_universe_source} universe fresh"
            if settings.trading_universe_source == "static":
                detail = "static universe loaded"
        elif universe_status in {"unknown", "not_evaluated", None}:
            ok = not require_non_empty
            detail = "universe not yet evaluated"
        elif universe_fail_safe_blocked:
            ok = False
            detail = f"jangar universe blocked: {universe_reason}"

        payload = {
            "ok": ok,
            "detail": detail,
            "source": settings.trading_universe_source,
            "status": universe_status,
            "reason": universe_reason,
            "symbols_count": universe_symbols_count,
            "cache_age_seconds": universe_cache_age_seconds,
            "max_stale_seconds": max_stale_seconds,
            "require_non_empty": require_non_empty,
        }
    return payload
