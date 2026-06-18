"""Extracted Torghut API route and support functions."""

from __future__ import annotations

from .shared_context import (
    Future,
    Mapping,
    TRADING_HEALTH_SURFACE_EVALUATION_EXECUTOR as _TRADING_HEALTH_SURFACE_EVALUATION_EXECUTOR,
    TRADING_HEALTH_SURFACE_EVALUATION_LOCK as _TRADING_HEALTH_SURFACE_EVALUATION_LOCK,
    TRADING_HEALTH_SURFACE_EVALUATIONS as _TRADING_HEALTH_SURFACE_EVALUATIONS,
    TRADING_HEALTH_SURFACE_PAYLOAD_CACHE as _TRADING_HEALTH_SURFACE_PAYLOAD_CACHE,
    TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS as _TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS,
    TimeoutError,
    cache_completed_trading_health_surface_payload as _cache_completed_trading_health_surface_payload,
    cast,
    deepcopy,
    guard_live_submission_gate_for_readiness as _guard_live_submission_gate_for_readiness,
    health_surface_timeout_fallback_payload as _health_surface_timeout_fallback_payload,
    logger,
    main_runtime_value,
    readiness_dependency_degradation_reason_codes as _readiness_dependency_degradation_reason_codes,
    record_trading_health_surface_completion as _record_trading_health_surface_completion,
    strip_promotion_authority_claims_for_readiness as _strip_promotion_authority_claims_for_readiness,
    trading_health_surface_cache_key as _trading_health_surface_cache_key,
)


def evaluate_trading_health_payload_bounded(
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
        from .evaluate_trading_health_payload import evaluate_trading_health_payload

        refresh_future = _TRADING_HEALTH_SURFACE_EVALUATION_EXECUTOR.submit(
            evaluate_trading_health_payload,
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
