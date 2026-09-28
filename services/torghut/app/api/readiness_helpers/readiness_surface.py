"""Readiness evaluation for the live trading runtime."""

from __future__ import annotations

import logging
import os
from collections.abc import Mapping, Sequence
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from typing import cast

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.api.build_metadata import BUILD_COMMIT, BUILD_IMAGE_DIGEST, BUILD_VERSION
from app.api.health_cache_state import (
    TRADING_DEPENDENCY_HEALTH_CACHE,
    TRADING_DEPENDENCY_HEALTH_CACHE_LOCK,
)
from app.config import settings
from app.db import SessionLocal
from app.trading.scheduler import TradingScheduler

from ...bootstrap import evaluate_scheduler_status
from .. import health_checks as health_checks_api
from ..trading_scheduler_state import get_trading_scheduler
from .readiness_live_submission_gate_dependency import (
    readiness_live_submission_gate_dependency,
    startup_readiness_grace_suppresses_live_gate,
)
from .universe_dependency import evaluate_universe_dependency

logger = logging.getLogger(__name__)

_READINESS_GATE_EXCEPTIONS = (
    RuntimeError,
    ValueError,
    KeyError,
    TypeError,
    SQLAlchemyError,
)


def active_runtime_revision() -> str | None:
    revision = os.getenv("K_REVISION", "").strip()
    return revision or None


def readiness_dependency_cache_key(include_database_contract: bool) -> str:
    tigerbeetle_contract = ":".join(
        str(int(value))
        for value in (
            settings.tigerbeetle_enabled,
            settings.tigerbeetle_required,
            settings.tigerbeetle_reconcile_required,
            settings.tigerbeetle_reconcile_max_age_seconds,
        )
    )
    return ":".join(
        (
            "readyz",
            str(int(settings.trading_enabled)),
            str(int(settings.trading_readiness_dependency_cache_enabled)),
            str(int(include_database_contract)),
            tigerbeetle_contract,
        )
    )


def readiness_dependency_checks(
    session: Session,
    *,
    include_database_contract: bool,
) -> tuple[dict[str, object], datetime]:
    if settings.trading_enabled:
        clickhouse = health_checks_api.check_clickhouse_dependency()
        alpaca = health_checks_api.check_alpaca_dependency()
    else:
        clickhouse = {"ok": True, "detail": "skipped (trading disabled)"}
        alpaca = {"ok": True, "detail": "skipped (trading disabled)"}

    dependencies: dict[str, object] = {
        "postgres": health_checks_api.check_postgres_dependency(session),
        "clickhouse": clickhouse,
        "alpaca": alpaca,
        "tigerbeetle": health_checks_api.build_tigerbeetle_ledger_status(session),
    }
    if include_database_contract:
        from .refresh_universe_state_for_readiness import evaluate_database_contract

        database = evaluate_database_contract(session)
        database_payload = dict(database)
        database_payload["ok"] = bool(database.get("ok"))
        database_payload["detail"] = _database_contract_detail(database)
        dependencies["database"] = database_payload
    return dependencies, datetime.now(timezone.utc)


def _database_contract_detail(database: Mapping[str, object]) -> str:
    lineage_errors = database.get("schema_graph_lineage_errors")
    if isinstance(lineage_errors, Sequence) and not isinstance(
        lineage_errors,
        (str, bytes, bytearray),
    ):
        errors = [
            str(value) for value in cast(Sequence[object], lineage_errors) if str(value)
        ]
        if errors:
            return errors[0]
    return "ok" if bool(database.get("ok")) else "database contract failed"


def readiness_dependency_snapshot(
    session: Session,
    *,
    include_database_contract: bool,
    allow_stale_dependency_cache: bool = False,
) -> tuple[dict[str, object], datetime, bool]:
    if (
        not settings.trading_readiness_dependency_cache_enabled
        or settings.trading_readiness_dependency_cache_ttl_seconds <= 0
    ):
        dependencies, checked_at = readiness_dependency_checks(
            session,
            include_database_contract=include_database_contract,
        )
        return dependencies, checked_at, False

    now = datetime.now(timezone.utc)
    cache_key = readiness_dependency_cache_key(include_database_contract)
    cache_ttl = timedelta(
        seconds=settings.trading_readiness_dependency_cache_ttl_seconds
    )
    stale_tolerance = timedelta(
        seconds=max(
            0,
            settings.trading_readiness_dependency_cache_stale_tolerance_seconds,
        )
    )
    with TRADING_DEPENDENCY_HEALTH_CACHE_LOCK:
        entry = TRADING_DEPENDENCY_HEALTH_CACHE.get(cache_key)
        if entry is not None:
            checked_at = cast(datetime, entry["checked_at"])
            age = now - checked_at
            cache_valid = age < cache_ttl or (
                allow_stale_dependency_cache and age <= cache_ttl + stale_tolerance
            )
            if cache_valid:
                return (
                    deepcopy(cast(dict[str, object], entry["dependencies"])),
                    checked_at,
                    True,
                )

    dependencies, checked_at = readiness_dependency_checks(
        session,
        include_database_contract=include_database_contract,
    )
    with TRADING_DEPENDENCY_HEALTH_CACHE_LOCK:
        TRADING_DEPENDENCY_HEALTH_CACHE[cache_key] = {
            "checked_at": checked_at,
            "dependencies": deepcopy(dependencies),
        }
    return dependencies, checked_at, False


def append_unique_reason(target: list[object], reason: str) -> list[object]:
    if reason not in {str(item) for item in target}:
        target.append(reason)
    return target


def readiness_dependency_degradation_reason_codes(
    dependencies: Mapping[str, object],
    *,
    scheduler_ok: bool,
) -> list[str]:
    reason_codes = [] if scheduler_ok else ["scheduler_degraded"]
    for name, raw_status in dependencies.items():
        if name in {"readiness_cache", "live_submission_gate"}:
            continue
        if isinstance(raw_status, Mapping):
            status = cast(Mapping[str, object], raw_status)
            if not bool(status.get("ok", True)):
                reason_codes.append(f"{name}_degraded")
    return sorted(set(reason_codes))


def readiness_live_submission_gate(
    scheduler: TradingScheduler,
) -> dict[str, object]:
    from . import status_dependencies

    try:
        freshness = status_dependencies.load_clickhouse_ta_status(scheduler)
        gate = status_dependencies.build_live_submission_gate_payload(
            scheduler.state,
            clickhouse_ta_status=freshness,
        )
    except _READINESS_GATE_EXCEPTIONS as exc:
        logger.warning("Readiness live-submission gate unavailable: %s", exc)
        reason = "readiness_live_submission_gate_unavailable"
        gate = {
            "schema_version": "torghut.operational-submission-gate.v2",
            "allowed": False,
            "reason": reason,
            "reason_codes": [reason],
            "blocked_reasons": [reason],
            "read_model_unavailable": True,
            "detail": f"{type(exc).__name__}: {exc}",
            "capital_stage": "blocked",
            "capital_state": "blocked",
            "authority_scope": "operational_submission",
        }
    gate = dict(gate)
    gate["readiness_surface"] = "core_dependencies_and_live_submission_gate"
    return gate


def _readiness_cache_payload(
    *,
    checked_at: datetime,
    cache_used: bool,
) -> dict[str, object]:
    age_seconds = max(
        0.0,
        round((datetime.now(timezone.utc) - checked_at).total_seconds(), 3),
    )
    cache_ttl = settings.trading_readiness_dependency_cache_ttl_seconds
    return {
        "checked_at": checked_at.isoformat(),
        "cache_ttl_seconds": cache_ttl,
        "cache_stale_tolerance_seconds": (
            settings.trading_readiness_dependency_cache_stale_tolerance_seconds
        ),
        "cache_used": cache_used,
        "cache_age_seconds": age_seconds,
        "cache_stale": cache_used and age_seconds > cache_ttl,
    }


def _core_readiness_dependencies(
    scheduler: TradingScheduler,
    *,
    scheduler_ok: bool,
    include_database_contract: bool,
    allow_stale_dependency_cache: bool,
) -> tuple[dict[str, object], list[str]]:
    with SessionLocal() as session:
        dependencies, checked_at, cache_used = readiness_dependency_snapshot(
            session,
            include_database_contract=include_database_contract,
            allow_stale_dependency_cache=allow_stale_dependency_cache,
        )
    dependencies = dict(dependencies)
    dependencies["universe"] = evaluate_universe_dependency(scheduler)
    dependencies["readiness_cache"] = _readiness_cache_payload(
        checked_at=checked_at,
        cache_used=cache_used,
    )
    return dependencies, readiness_dependency_degradation_reason_codes(
        dependencies,
        scheduler_ok=scheduler_ok,
    )


def evaluate_core_readiness_payload(
    *,
    include_database_contract: bool = False,
    allow_stale_dependency_cache: bool = False,
) -> tuple[dict[str, object], int]:
    scheduler = get_trading_scheduler()
    scheduler_ok, scheduler_payload = evaluate_scheduler_status(scheduler)
    dependencies, dependency_reasons = _core_readiness_dependencies(
        scheduler,
        scheduler_ok=scheduler_ok,
        include_database_contract=include_database_contract,
        allow_stale_dependency_cache=allow_stale_dependency_cache,
    )
    gate = readiness_live_submission_gate(scheduler)
    startup_grace_active = bool(scheduler_payload.get("startup_readiness_grace_active"))
    dependencies["live_submission_gate"] = readiness_live_submission_gate_dependency(
        gate,
        startup_readiness_grace_active=startup_grace_active,
    )
    gate_allowed = bool(gate.get("allowed"))
    startup_grace_suppressed = startup_readiness_grace_suppresses_live_gate(
        gate,
        startup_readiness_grace_active=startup_grace_active,
    )
    ready = (
        scheduler_ok
        and not dependency_reasons
        and (gate_allowed or startup_grace_suppressed)
    )
    reason_codes: list[object] = list(dependency_reasons)
    if not gate_allowed and not startup_grace_suppressed:
        append_unique_reason(
            reason_codes,
            str(gate.get("reason") or "live_submission_gate_blocked"),
        )
    payload: dict[str, object] = {
        "status": "ok" if ready else "degraded",
        "reason_codes": reason_codes,
        "scheduler": scheduler_payload,
        "dependencies": dependencies,
        "build": {
            "version": BUILD_VERSION,
            "commit": BUILD_COMMIT,
            "image_digest": BUILD_IMAGE_DIGEST,
            "active_revision": active_runtime_revision() or BUILD_COMMIT,
        },
        "mode": settings.trading_mode,
        "pipeline_mode": settings.trading_pipeline_mode,
        "trading_enabled": settings.trading_enabled,
        "readiness_surface": "core_dependencies_and_live_submission_gate",
        "live_submission_gate": gate,
    }
    return payload, 200 if ready else 503


__all__ = (
    "active_runtime_revision",
    "append_unique_reason",
    "evaluate_core_readiness_payload",
    "readiness_dependency_cache_key",
    "readiness_dependency_checks",
    "readiness_dependency_degradation_reason_codes",
    "readiness_dependency_snapshot",
    "readiness_live_submission_gate",
)
