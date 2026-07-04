"""Context loading for the Torghut trading status route."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import cast

from app.config import settings
from app.trading.market_context_domains import active_market_context_reasons
from app.trading.scheduler import TradingScheduler
from app.trading.scheduler.state import TradingState


@dataclass(frozen=True)
class TradingStatusContextDependencies:
    get_app: Callable[[], object]
    scheduler_factory: Callable[[], TradingScheduler]
    active_simulation_runtime_context: Callable[[], Mapping[str, object] | None]
    empirical_jobs_status: Callable[[], dict[str, object]]
    load_quant_evidence_status: Callable[..., dict[str, object]]
    forecast_service_status: Callable[[dict[str, object]], dict[str, object]]
    lean_authority_status: Callable[[], dict[str, object]]


@dataclass(frozen=True)
class TradingStatusContext:
    scheduler: TradingScheduler
    state: TradingState
    active_simulation_context: Mapping[str, object] | None
    empirical_jobs: dict[str, object]
    quant_evidence: dict[str, object]
    forecast_service_status: dict[str, object]
    lean_authority_status: dict[str, object]
    clickhouse_ta_deferred_reason: str
    trading_account_label: str
    status_observed_at: datetime
    status_stage_scope: str
    market_context_status: dict[str, object]


def load_trading_status_context(
    deps: TradingStatusContextDependencies,
) -> TradingStatusContext:
    scheduler = _get_or_create_scheduler(
        deps.get_app(),
        scheduler_factory=deps.scheduler_factory,
    )
    empirical_jobs = deps.empirical_jobs_status()
    quant_evidence = deps.load_quant_evidence_status(
        account_label=settings.trading_account_label,
    )
    return TradingStatusContext(
        scheduler=scheduler,
        state=scheduler.state,
        active_simulation_context=deps.active_simulation_runtime_context(),
        empirical_jobs=empirical_jobs,
        quant_evidence=quant_evidence,
        forecast_service_status=deps.forecast_service_status(empirical_jobs),
        lean_authority_status=deps.lean_authority_status(),
        clickhouse_ta_deferred_reason=(
            "clickhouse_ta_status_deferred_until_after_live_submission_gate"
        ),
        trading_account_label=settings.trading_account_label,
        status_observed_at=datetime.now(timezone.utc),
        status_stage_scope="live" if settings.trading_mode == "live" else "paper",
        market_context_status=_market_context_status_for_api(
            scheduler.market_context_status()
        ),
    )


def _get_or_create_scheduler(
    app: object,
    *,
    scheduler_factory: Callable[[], TradingScheduler],
) -> TradingScheduler:
    app_state = getattr(app, "state")
    scheduler = getattr(app_state, "trading_scheduler", None)
    if isinstance(scheduler, TradingScheduler):
        return scheduler
    scheduler = scheduler_factory()
    setattr(app_state, "trading_scheduler", scheduler)
    return scheduler


def _market_context_status_for_api(
    status: Mapping[str, object],
) -> dict[str, object]:
    payload = dict(status)
    if bool(payload.get("alert_active")) or not bool(
        payload.get("shadow_alert_active")
    ):
        return payload

    alert_reasons = active_market_context_reasons(
        [
            cast(
                str,
                payload.get("shadow_alert_reason")
                or payload.get("last_reason")
                or "market_context_alert_active",
            )
        ]
    )
    if not alert_reasons:
        return payload

    payload["alert_active"] = True
    payload["alert_reason"] = alert_reasons[0]
    return payload


__all__ = [
    "TradingStatusContext",
    "TradingStatusContextDependencies",
    "load_trading_status_context",
]
