"""Dependency snapshot helpers for the Torghut trading health surface."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from contextlib import AbstractContextManager
from dataclasses import dataclass
from datetime import datetime
from typing import cast

from app.config import settings

from .trading_health_context import TradingHealthContext

_PROOF_LANE_DEPENDENCY_KEYS = frozenset(
    {
        "empirical_jobs",
        "live_submission_gate",
        "profitability_proof_floor",
    }
)


@dataclass(frozen=True)
class TradingHealthDependencyDependencies:
    session_factory: Callable[[], AbstractContextManager[object]]
    readiness_dependency_snapshot: Callable[
        ..., tuple[Mapping[str, object], datetime, bool]
    ]
    evaluate_universe_dependency: Callable[..., dict[str, object]]


@dataclass(frozen=True)
class TradingHealthDependencySnapshot:
    dependencies: dict[str, object]
    checked_at: datetime
    cache_used: bool
    cache_age_seconds: float
    cache_stale: bool


def load_trading_health_dependency_snapshot(
    context: TradingHealthContext,
    *,
    include_database_contract: bool,
    allow_stale_dependency_cache: bool,
    deps: TradingHealthDependencyDependencies,
) -> TradingHealthDependencySnapshot:
    with deps.session_factory() as session:
        dependencies, checked_at, cache_used = deps.readiness_dependency_snapshot(
            session,
            include_database_contract=include_database_contract,
            allow_stale_dependency_cache=allow_stale_dependency_cache,
        )
    dependency_payload = dict(dependencies)
    dependency_payload["universe"] = deps.evaluate_universe_dependency(
        context.scheduler
    )
    cache_age_seconds = _cache_age_seconds(context.observed_at, checked_at)
    cache_stale = (
        cache_used
        and cache_age_seconds > settings.trading_readiness_dependency_cache_ttl_seconds
    )
    dependency_payload["readiness_cache"] = {
        "checked_at": checked_at.isoformat(),
        "cache_ttl_seconds": settings.trading_readiness_dependency_cache_ttl_seconds,
        "cache_stale_tolerance_seconds": (
            settings.trading_readiness_dependency_cache_stale_tolerance_seconds
        ),
        "cache_used": cache_used,
        "cache_age_seconds": cache_age_seconds,
        "cache_stale": cache_stale,
    }
    return TradingHealthDependencySnapshot(
        dependencies=dependency_payload,
        checked_at=checked_at,
        cache_used=cache_used,
        cache_age_seconds=cache_age_seconds,
        cache_stale=cache_stale,
    )


def split_runtime_and_proof_lane_dependencies(
    dependencies: Mapping[str, object],
    *,
    scheduler_ok: bool,
) -> dict[str, object]:
    runtime_dependencies = runtime_dependencies_for_health_surface(dependencies)
    proof_dependencies = {
        key: value
        for key, value in dependencies.items()
        if key in _PROOF_LANE_DEPENDENCY_KEYS
    }
    runtime_ok = scheduler_ok and all(
        _dependency_ok(value) for value in runtime_dependencies.values()
    )
    proof_lane_ok = all(_dependency_ok(value) for value in proof_dependencies.values())
    return {
        "runtime": {
            "status": "ok" if runtime_ok else "degraded",
            "ok": runtime_ok,
            "scheduler_ok": scheduler_ok,
            "dependency_count": len(runtime_dependencies),
            "dependencies": dict(runtime_dependencies),
        },
        "proof_lane": {
            "status": "ok" if proof_lane_ok else "degraded",
            "ok": proof_lane_ok,
            "hot_path_authority": False,
            "required_for_runtime_health": False,
            "dependencies": dict(proof_dependencies),
        },
    }


def runtime_dependencies_for_health_surface(
    dependencies: Mapping[str, object],
) -> dict[str, object]:
    return {
        key: value
        for key, value in dependencies.items()
        if key != "readiness_cache" and key not in _PROOF_LANE_DEPENDENCY_KEYS
    }


def _cache_age_seconds(observed_at: datetime, checked_at: datetime) -> float:
    cache_age_seconds = (observed_at - checked_at).total_seconds()
    return 0.0 if cache_age_seconds < 0 else round(cache_age_seconds, 3)


def _dependency_ok(value: object) -> bool:
    if isinstance(value, Mapping):
        return bool(cast(Mapping[str, object], value).get("ok", True))
    return True


__all__ = [
    "TradingHealthDependencyDependencies",
    "TradingHealthDependencySnapshot",
    "load_trading_health_dependency_snapshot",
    "runtime_dependencies_for_health_surface",
    "split_runtime_and_proof_lane_dependencies",
]
