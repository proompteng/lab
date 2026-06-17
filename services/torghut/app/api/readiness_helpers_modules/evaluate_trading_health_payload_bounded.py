"""Extracted Torghut API route and support functions."""

from __future__ import annotations


from . import shared_context as shared_context_api
from .shared_context import (
    Future,
    Mapping,
    TimeoutError,
    cast,
    deepcopy,
    logger,
    main_runtime_value,
)

_SHARED_CONTEXT_EXPORTS = shared_context_api.__dict__
_ACCOUNT_SCOPE_STATEMENT_TIMEOUT_MS = _SHARED_CONTEXT_EXPORTS[
    "ACCOUNT_SCOPE_STATEMENT_TIMEOUT_MS"
]
_ALPACA_HEALTH_CACHE_LOCK = _SHARED_CONTEXT_EXPORTS["ALPACA_HEALTH_CACHE_LOCK"]
_ALPACA_HEALTH_STATE = _SHARED_CONTEXT_EXPORTS["ALPACA_HEALTH_STATE"]
_OPTIONS_CATALOG_FRESHNESS_CACHE = _SHARED_CONTEXT_EXPORTS[
    "OPTIONS_CATALOG_FRESHNESS_CACHE"
]
_OPTIONS_CATALOG_FRESHNESS_CACHE_LOCK = _SHARED_CONTEXT_EXPORTS[
    "OPTIONS_CATALOG_FRESHNESS_CACHE_LOCK"
]
_PAPER_ROUTE_BOUNDED_COLLECTION_ACCOUNT_LABEL = _SHARED_CONTEXT_EXPORTS[
    "PAPER_ROUTE_BOUNDED_COLLECTION_ACCOUNT_LABEL"
]
_PAPER_ROUTE_TARGET_PLAN_STALE_SUCCESS_SECONDS = _SHARED_CONTEXT_EXPORTS[
    "PAPER_ROUTE_TARGET_PLAN_STALE_SUCCESS_SECONDS"
]
_PAPER_ROUTE_TARGET_PLAN_SUCCESS_CACHE_LOCK = _SHARED_CONTEXT_EXPORTS[
    "PAPER_ROUTE_TARGET_PLAN_SUCCESS_CACHE_LOCK"
]
_READINESS_PROMOTION_AUTHORITY_KEYS = _SHARED_CONTEXT_EXPORTS[
    "READINESS_PROMOTION_AUTHORITY_KEYS"
]
_RETRYABLE_TCA_RECOMPUTE_SQLSTATES = _SHARED_CONTEXT_EXPORTS[
    "RETRYABLE_TCA_RECOMPUTE_SQLSTATES"
]
_SIMPLE_LANE_ALLOWED_REJECT_REASONS = _SHARED_CONTEXT_EXPORTS[
    "SIMPLE_LANE_ALLOWED_REJECT_REASONS"
]
_TRADING_DEPENDENCY_HEALTH_CACHE = _SHARED_CONTEXT_EXPORTS[
    "TRADING_DEPENDENCY_HEALTH_CACHE"
]
_TRADING_DEPENDENCY_HEALTH_CACHE_LOCK = _SHARED_CONTEXT_EXPORTS[
    "TRADING_DEPENDENCY_HEALTH_CACHE_LOCK"
]
_TRADING_HEALTH_SURFACE_EVALUATIONS = _SHARED_CONTEXT_EXPORTS[
    "TRADING_HEALTH_SURFACE_EVALUATIONS"
]
_TRADING_HEALTH_SURFACE_EVALUATION_EXECUTOR = _SHARED_CONTEXT_EXPORTS[
    "TRADING_HEALTH_SURFACE_EVALUATION_EXECUTOR"
]
_TRADING_HEALTH_SURFACE_EVALUATION_LOCK = _SHARED_CONTEXT_EXPORTS[
    "TRADING_HEALTH_SURFACE_EVALUATION_LOCK"
]
_TRADING_HEALTH_SURFACE_PAYLOAD_CACHE = _SHARED_CONTEXT_EXPORTS[
    "TRADING_HEALTH_SURFACE_PAYLOAD_CACHE"
]
_TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS = _SHARED_CONTEXT_EXPORTS[
    "TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS"
]
_TRADING_STATUS_READ_BUDGET_SECONDS = _SHARED_CONTEXT_EXPORTS[
    "TRADING_STATUS_READ_BUDGET_SECONDS"
]
_ZERO_NOTIONAL_TCA_RECOMPUTE_MAX_ATTEMPTS = _SHARED_CONTEXT_EXPORTS[
    "ZERO_NOTIONAL_TCA_RECOMPUTE_MAX_ATTEMPTS"
]
_append_unique_reason = _SHARED_CONTEXT_EXPORTS["append_unique_reason"]
_cache_completed_trading_health_surface_payload = _SHARED_CONTEXT_EXPORTS[
    "cache_completed_trading_health_surface_payload"
]
_cached_readiness_dependencies_for_health_surface = _SHARED_CONTEXT_EXPORTS[
    "cached_readiness_dependencies_for_health_surface"
]
_cached_trading_health_surface_payload = _SHARED_CONTEXT_EXPORTS[
    "cached_trading_health_surface_payload"
]
_core_readiness_live_submission_gate = _SHARED_CONTEXT_EXPORTS[
    "core_readiness_live_submission_gate"
]
_evaluate_core_readiness_payload = _SHARED_CONTEXT_EXPORTS[
    "evaluate_core_readiness_payload"
]
_fail_closed_health_evaluation_gate = _SHARED_CONTEXT_EXPORTS[
    "fail_closed_health_evaluation_gate"
]
_guard_live_submission_gate_for_readiness = _SHARED_CONTEXT_EXPORTS[
    "guard_live_submission_gate_for_readiness"
]
_health_surface_timeout_dependency_placeholder = _SHARED_CONTEXT_EXPORTS[
    "health_surface_timeout_dependency_placeholder"
]
_health_surface_timeout_fallback_payload = _SHARED_CONTEXT_EXPORTS[
    "health_surface_timeout_fallback_payload"
]
_minimal_health_surface_timeout_live_submission_gate = _SHARED_CONTEXT_EXPORTS[
    "minimal_health_surface_timeout_live_submission_gate"
]
_minimal_health_surface_timeout_payload = _SHARED_CONTEXT_EXPORTS[
    "minimal_health_surface_timeout_payload"
]
_minimal_health_surface_timeout_proof_floor = _SHARED_CONTEXT_EXPORTS[
    "minimal_health_surface_timeout_proof_floor"
]
_paper_route_target_plan_success_cache = _SHARED_CONTEXT_EXPORTS[
    "paper_route_target_plan_success_cache"
]
_readiness_authority_truthy = _SHARED_CONTEXT_EXPORTS["readiness_authority_truthy"]
_readiness_dependency_cache_key = _SHARED_CONTEXT_EXPORTS[
    "readiness_dependency_cache_key"
]
_readiness_dependency_checks = _SHARED_CONTEXT_EXPORTS["readiness_dependency_checks"]
_readiness_dependency_degradation_reason_codes = _SHARED_CONTEXT_EXPORTS[
    "readiness_dependency_degradation_reason_codes"
]
_readiness_dependency_snapshot = _SHARED_CONTEXT_EXPORTS[
    "readiness_dependency_snapshot"
]
_record_trading_health_surface_completion = _SHARED_CONTEXT_EXPORTS[
    "record_trading_health_surface_completion"
]
_retryable_tca_recompute_error = _SHARED_CONTEXT_EXPORTS[
    "retryable_tca_recompute_error"
]
_shared_mapping_items = _SHARED_CONTEXT_EXPORTS["shared_mapping_items"]
_shared_paper_route_target_plan_from_payload = _SHARED_CONTEXT_EXPORTS[
    "shared_paper_route_target_plan_from_payload"
]
_strip_promotion_authority_claims_for_readiness = _SHARED_CONTEXT_EXPORTS[
    "strip_promotion_authority_claims_for_readiness"
]
_trading_health_surface_cache_key = _SHARED_CONTEXT_EXPORTS[
    "trading_health_surface_cache_key"
]


def _evaluate_trading_health_payload_bounded(
    *,
    include_database_contract: bool = False,
    allow_stale_dependency_cache: bool = False,
    surface: str,
) -> tuple[dict[str, object], int]:
    cache_key = _trading_health_surface_cache_key(
        include_database_contract=include_database_contract,
        allow_stale_dependency_cache=allow_stale_dependency_cache,
    )
    callback_future: Future[tuple[dict[str, object], int]] | None = None
    cached_result: tuple[dict[str, object], int] | None = None

    def _cached_result_from_entry(
        cache_entry: Mapping[str, object] | None,
    ) -> tuple[dict[str, object], int] | None:
        if cache_entry is None:
            return None
        payload = deepcopy(cast(dict[str, object], cache_entry["payload"]))
        dependencies = payload.get("dependencies")
        if isinstance(dependencies, Mapping):
            readiness_dependency_reasons = (
                _readiness_dependency_degradation_reason_codes(
                    cast(Mapping[str, object], dependencies),
                    scheduler_ok=True,
                )
            )
            live_submission_gate = payload.get("live_submission_gate")
            if isinstance(live_submission_gate, Mapping):
                guarded_live_submission_gate = (
                    _guard_live_submission_gate_for_readiness(
                        cast(Mapping[str, object], live_submission_gate),
                        readiness_dependency_reasons=readiness_dependency_reasons,
                    )
                )
                payload["live_submission_gate"] = guarded_live_submission_gate
                if bool(
                    guarded_live_submission_gate.get(
                        "readiness_dependency_guard_active"
                    )
                ):
                    dependencies_payload = deepcopy(
                        dict(cast(Mapping[str, object], dependencies))
                    )
                    dependencies_payload["live_submission_gate"] = {
                        "ok": False,
                        "detail": str(
                            guarded_live_submission_gate.get("reason")
                            or "readiness_dependency_degraded"
                        ),
                        "capital_stage": guarded_live_submission_gate.get(
                            "capital_stage"
                        ),
                        "readiness_dependency_guard_active": True,
                        "readiness_dependency_guard_reasons": (
                            readiness_dependency_reasons
                        ),
                    }
                    payload["dependencies"] = dependencies_payload
        status_value = cache_entry.get("status_code")
        status_code = status_value if isinstance(status_value, int) else 503
        return (
            cast(
                dict[str, object],
                _strip_promotion_authority_claims_for_readiness(payload),
            ),
            status_code,
        )

    def _start_refresh_locked() -> Future[tuple[dict[str, object], int]]:
        from . import evaluate_trading_health_payload as trading_health_payload_api

        refresh_future = _TRADING_HEALTH_SURFACE_EVALUATION_EXECUTOR.submit(
            trading_health_payload_api.__dict__["_evaluate_trading_health_payload"],
            include_database_contract=include_database_contract,
            allow_stale_dependency_cache=allow_stale_dependency_cache,
        )
        _TRADING_HEALTH_SURFACE_EVALUATIONS[cache_key] = refresh_future
        return refresh_future

    with _TRADING_HEALTH_SURFACE_EVALUATION_LOCK:
        future = _TRADING_HEALTH_SURFACE_EVALUATIONS.get(cache_key)
        if future is not None and future.done():
            _TRADING_HEALTH_SURFACE_EVALUATIONS.pop(cache_key, None)
            cached_result = _cached_result_from_entry(
                _TRADING_HEALTH_SURFACE_PAYLOAD_CACHE.get(cache_key)
            )
            if cached_result is not None:
                callback_future = _start_refresh_locked()
            else:
                future = None
        elif future is not None:
            cached_result = _cached_result_from_entry(
                _TRADING_HEALTH_SURFACE_PAYLOAD_CACHE.get(cache_key)
            )
        if future is None and cached_result is None:
            cached_result = _cached_result_from_entry(
                _TRADING_HEALTH_SURFACE_PAYLOAD_CACHE.get(cache_key)
            )
            future = _start_refresh_locked()
            callback_future = future

    if callback_future is not None:
        callback_future.add_done_callback(
            lambda completed, key=cache_key: _record_trading_health_surface_completion(
                key,
                completed,
            )
        )
    if cached_result is not None:
        return cached_result

    assert future is not None
    timeout_seconds = max(
        0.1,
        float(
            main_runtime_value(
                "TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS",
                _TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS,
            )
        ),
    )
    try:
        payload, status_code = future.result(timeout=timeout_seconds)
    except TimeoutError:
        reason_code = f"{surface}_evaluation_timeout"
        detail = (
            f"{surface} evaluation exceeded {timeout_seconds:.1f}s; "
            "returning fail-closed cached/degraded health"
        )
        return (
            _health_surface_timeout_fallback_payload(
                cache_key=cache_key,
                include_database_contract=include_database_contract,
                reason_code=reason_code,
                detail=detail,
            ),
            503,
        )
    except Exception as exc:
        logger.warning("Trading health surface evaluation failed: %s", exc)
        reason_code = f"{surface}_evaluation_unavailable"
        return (
            _health_surface_timeout_fallback_payload(
                cache_key=cache_key,
                include_database_contract=include_database_contract,
                reason_code=reason_code,
                detail=str(exc),
            ),
            503,
        )

    _cache_completed_trading_health_surface_payload(cache_key, payload, status_code)
    return payload, status_code


__all__: tuple[str, ...] = ()

# Public aliases used by split modules.
evaluate_trading_health_payload_bounded = _evaluate_trading_health_payload_bounded
