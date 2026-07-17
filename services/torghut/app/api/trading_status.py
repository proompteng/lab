"""Bounded operational status for the live trading runtime."""

from __future__ import annotations

import os
from collections.abc import Callable
from datetime import datetime, timezone
from typing import TypeVar

from fastapi import APIRouter
from fastapi.responses import Response
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.alpaca_client import classify_alpaca_trading_endpoint
from app.api.build_metadata import BUILD_COMMIT, BUILD_IMAGE_DIGEST, BUILD_VERSION
from app.config import settings
from app.db import SessionLocal
from app.trading.action_authority import reduce_runtime_action_authority
from app.trading.broker_account_activities import load_broker_account_activity_status
from app.trading.broker_mutation_receipts import fingerprint_broker_endpoint
from app.trading.broker_mutation_receipts.runtime_status import (
    load_broker_mutation_runtime_status,
    unavailable_broker_mutation_runtime_status,
)
from app.trading.economic_ledger import LedgerScope, load_broker_economic_ledger_status
from app.trading.execution_runtime import build_execution_status_payload
from app.trading.order_lineage_runs import load_order_lineage_repair_status
from app.trading.scheduler import TradingScheduler
from app.trading.scheduler.runtime_health import scheduler_readiness_payload
from app.trading.strategy_capital_authority_store import (
    strategy_capital_authority_status,
)
from app.trading.submission_council import build_live_submission_gate_payload

from .application import get_app, runtime_owner_for_role
from .health_checks import (
    build_tigerbeetle_ledger_status,
    load_clickhouse_ta_status,
    load_last_decision_at,
    load_tca_summary,
)
from .runtime_ledger_status import daily_runtime_ledger_portfolio_summary
from .scheduler_proxy import proxy_scheduler_response

router = APIRouter()
T = TypeVar("T")


def get_trading_scheduler() -> TradingScheduler:
    scheduler = getattr(get_app().state, "trading_scheduler", None)
    if isinstance(scheduler, TradingScheduler):
        return scheduler
    scheduler = TradingScheduler()
    get_app().state.trading_scheduler = scheduler
    return scheduler


def _read_with_session(
    reader: Callable[[Session], T],
    *,
    unavailable: T,
) -> T:
    try:
        with SessionLocal() as session:
            return reader(session)
    except SQLAlchemyError:
        return unavailable


def _configured_broker_endpoint() -> str:
    endpoint = str(settings.apca_api_base_url or "").strip().rstrip("/")
    if endpoint.endswith("/v2"):
        endpoint = endpoint[:-3]
    if endpoint:
        return endpoint
    return (
        "https://api.alpaca.markets"
        if settings.trading_mode == "live"
        else "https://paper-api.alpaca.markets"
    )


def configured_broker_environment() -> str:
    try:
        return classify_alpaca_trading_endpoint(_configured_broker_endpoint())
    except ValueError:
        return "unknown"


def _capital_controls(state: object) -> dict[str, object]:
    return {
        "new_exposure_allowed": getattr(state, "capital_new_exposure_allowed", False),
        "current_equity": getattr(state, "capital_current_equity", None),
        "daily_start_equity": getattr(state, "capital_daily_start_equity", None),
        "high_water_equity": getattr(state, "capital_high_water_equity", None),
        "daily_loss_ratio": getattr(state, "capital_daily_loss_ratio", None),
        "drawdown_ratio": getattr(state, "capital_drawdown_ratio", None),
        "daily_loss_limit": settings.trading_daily_loss_stop_pct_equity,
        "drawdown_limit": settings.trading_persistent_drawdown_stop_pct_equity,
        "gross_limit": settings.trading_simple_max_gross_exposure_pct_equity,
        "net_limit": settings.trading_simple_max_net_exposure_pct_equity,
        "symbol_limit": settings.trading_simple_max_symbol_pct_equity,
        "buying_power_reserve_bps": (settings.trading_simple_buying_power_reserve_bps),
        "closeout_reason": getattr(state, "capital_closeout_reason", None),
        "closeout_attempts": getattr(state, "capital_closeout_attempts", 0),
        "flat_confirmed_at": getattr(state, "capital_flat_confirmed_at", None),
        "last_evaluated_at": getattr(state, "capital_last_evaluated_at", None),
        "ledger_state": getattr(state, "capital_ledger_state", None),
        "ledger_reason": getattr(state, "capital_ledger_reason", None),
        "ledger_checked_at": getattr(state, "capital_ledger_checked_at", None),
    }


def _signal_continuity(state: object) -> dict[str, object]:
    return {
        "universe_source": settings.trading_universe_source,
        "universe_status": getattr(state, "universe_source_status", None),
        "universe_reason": getattr(state, "universe_source_reason", None),
        "universe_symbols_count": getattr(state, "universe_symbols_count", None),
        "universe_cache_age_seconds": getattr(
            state, "universe_cache_age_seconds", None
        ),
        "universe_fail_safe_blocked": getattr(
            state, "universe_fail_safe_blocked", False
        ),
        "market_session_open": getattr(state, "market_session_open", None),
        "last_state": getattr(state, "last_signal_continuity_state", None),
        "last_reason": getattr(state, "last_signal_continuity_reason", None),
        "alert_active": getattr(state, "signal_continuity_alert_active", False),
        "alert_reason": getattr(state, "signal_continuity_alert_reason", None),
    }


def _market_context(scheduler: TradingScheduler) -> dict[str, object]:
    try:
        return dict(scheduler.market_context_status())
    except (RuntimeError, ValueError, TypeError):
        return {"status": "unavailable", "alert_active": True}


def _runtime_ledger(session: Session) -> dict[str, object]:
    return daily_runtime_ledger_portfolio_summary(
        session=session,
        account_label=settings.trading_account_label,
        stage_scope=settings.trading_mode,
        observed_at=datetime.now(timezone.utc),
    )


@router.get("/trading/status", response_model=None)
def trading_status() -> dict[str, object] | Response:
    if settings.process_role == "api":
        return proxy_scheduler_response(
            path="/trading/status",
            accept="application/json",
        )

    scheduler = get_trading_scheduler()
    state = scheduler.state
    accepted_source = load_clickhouse_ta_status(scheduler)
    live_gate = build_live_submission_gate_payload(
        state,
        clickhouse_ta_status=accepted_source,
    )
    broker_mutation = _read_with_session(
        load_broker_mutation_runtime_status,
        unavailable=unavailable_broker_mutation_runtime_status(),
    )
    action_authority = reduce_runtime_action_authority(
        service_status=scheduler_readiness_payload(scheduler),
        live_submission_gate=live_gate,
        broker_mutation_status=broker_mutation,
        state=state,
    )
    tigerbeetle = _read_with_session(
        build_tigerbeetle_ledger_status,
        unavailable={"ok": False, "reason_codes": ["tigerbeetle_status_unavailable"]},
    )
    runtime_ledger = _read_with_session(
        _runtime_ledger,
        unavailable={
            "status": "unavailable",
            "reason_codes": ["runtime_ledger_status_unavailable"],
        },
    )
    strategy_authorities = _read_with_session(
        lambda session: strategy_capital_authority_status(
            session,
            observed_at=datetime.now(timezone.utc),
            runtime_code_commit=BUILD_COMMIT,
            runtime_image_digest=BUILD_IMAGE_DIGEST,
        ),
        unavailable={
            "schema_version": "torghut.strategy-capital-authority-status.v1",
            "status": "unavailable",
            "reason_codes": ["strategy_capital_authority_status_unavailable"],
        },
    )
    broker_economic_activities = _read_with_session(
        lambda session: load_broker_account_activity_status(
            session,
            account_label=settings.trading_account_label,
            environment=configured_broker_environment(),
            observed_at=datetime.now(timezone.utc),
        ),
        unavailable={
            "schema_version": "torghut.broker-account-activity-status.v1",
            "state": "unavailable",
            "current": False,
            "reason_codes": ["broker_account_activity_status_unavailable"],
        },
    )
    broker_economic_ledger = _read_with_session(
        lambda session: load_broker_economic_ledger_status(
            session,
            scope=LedgerScope(
                provider="alpaca",
                environment=configured_broker_environment(),
                account_label=settings.trading_account_label,
                endpoint_fingerprint=fingerprint_broker_endpoint(
                    _configured_broker_endpoint()
                ),
            ),
            observed_at=datetime.now(timezone.utc),
        ),
        unavailable={
            "schema_version": "torghut.broker-economic-ledger-status.v1",
            "state": "unavailable",
            "current": False,
            "reconciled": False,
            "diagnostic_only": True,
            "capital_authority": False,
            "reason_codes": ["economic_reconciliation_status_unavailable"],
        },
    )
    order_lineage = _read_with_session(
        lambda session: load_order_lineage_repair_status(
            session,
            provider="alpaca",
            environment=configured_broker_environment(),
            account_label=settings.trading_account_label,
        ),
        unavailable={
            "schema_version": "torghut.order-lineage-repair-status.v1",
            "state": "unavailable",
            "closed_census": False,
            "current_version": False,
            "diagnostic_only": True,
            "promotion_authority_eligible": False,
            "reason_codes": ["order_lineage_status_unavailable"],
        },
    )
    tca = _read_with_session(
        lambda session: load_tca_summary(session, scheduler=scheduler),
        unavailable={"status": "unavailable", "reason_codes": ["tca_unavailable"]},
    )
    last_decision_at = _read_with_session(
        load_last_decision_at,
        unavailable=None,
    )
    return {
        "service": "torghut",
        "process_role": settings.process_role,
        "runtime_owner": runtime_owner_for_role(settings.process_role),
        "build": {
            "version": BUILD_VERSION,
            "commit": BUILD_COMMIT,
            "image_digest": BUILD_IMAGE_DIGEST,
            "active_revision": os.getenv("K_REVISION", "").strip() or BUILD_COMMIT,
        },
        "mode": settings.trading_mode,
        "pipeline_mode": settings.trading_pipeline_mode,
        "enabled": settings.trading_enabled,
        "running": state.running,
        "last_run_at": state.last_run_at,
        "last_reconcile_at": state.last_reconcile_at,
        "last_decision_at": last_decision_at,
        "last_error": state.last_error,
        "accepted_source_freshness": accepted_source,
        "live_submission_gate": live_gate,
        "action_authority": action_authority.to_payload(),
        "broker_mutation_safety": broker_mutation,
        "broker_economic_activities": broker_economic_activities,
        "broker_economic_ledger": broker_economic_ledger,
        "order_lineage": order_lineage,
        "capital_controls": _capital_controls(state),
        "execution": build_execution_status_payload(
            state=state,
            live_submission_gate=live_gate,
        ),
        "signal_continuity": _signal_continuity(state),
        "market_context": _market_context(scheduler),
        "shorting_metadata": scheduler.shorting_metadata_status(),
        "tigerbeetle_ledger": tigerbeetle,
        "runtime_ledger": runtime_ledger,
        "strategy_capital_authorities": strategy_authorities,
        "tca": tca,
        "metrics": state.metrics.to_payload(),
        "llm": scheduler.llm_status(),
    }


__all__ = ("configured_broker_environment", "router", "trading_status")
