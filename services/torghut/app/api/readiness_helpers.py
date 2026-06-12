"""Extracted Torghut API route and support functions."""

# pyright: reportUnusedImport=false
# ruff: noqa: F401,F403,F405
from __future__ import annotations

from fastapi import APIRouter
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from .compat_typing import *

from .common import *
from .common import main_runtime_value
from .proxy import capture_module_exports


def _readiness_dependency_cache_key(include_database_contract: bool) -> str:
    trading_mode = int(settings.trading_enabled)
    cache_mode = int(settings.trading_readiness_dependency_cache_enabled)
    tigerbeetle_mode = ":".join(
        str(int(value))
        for value in (
            settings.tigerbeetle_enabled,
            settings.tigerbeetle_required,
            settings.tigerbeetle_reconcile_required,
            settings.tigerbeetle_reconcile_max_age_seconds,
        )
    )
    return f"readyz:{trading_mode}:{cache_mode}:{int(include_database_contract)}:{tigerbeetle_mode}"


def _readiness_dependency_checks(
    session: Session,
    *,
    include_database_contract: bool,
) -> tuple[dict[str, object], datetime]:
    if settings.trading_enabled:
        clickhouse_status = _check_clickhouse()
        alpaca_status = _check_alpaca()
    else:
        clickhouse_status = {"ok": True, "detail": "skipped (trading disabled)"}
        alpaca_status = {"ok": True, "detail": "skipped (trading disabled)"}
    postgres_status = _check_postgres(session)

    dependencies: dict[str, object] = {
        "postgres": postgres_status,
        "clickhouse": clickhouse_status,
        "alpaca": alpaca_status,
        "tigerbeetle": _build_tigerbeetle_ledger_status(session),
    }

    if include_database_contract:
        database_contract = _evaluate_database_contract(session)
        lineage_errors = cast(
            list[str],
            database_contract.get("schema_graph_lineage_errors", []),
        )
        detail = (
            "ok" if bool(database_contract.get("ok")) else "database contract failed"
        )
        if lineage_errors:
            detail = lineage_errors[0]
        dependencies["database"] = {
            "ok": bool(database_contract.get("ok")),
            "detail": detail,
            "schema_current": bool(database_contract.get("schema_current")),
            "schema_current_heads": database_contract.get("schema_current_heads"),
            "expected_heads": database_contract.get("expected_heads"),
            "schema_missing_heads": database_contract.get(
                "schema_missing_heads",
                [],
            ),
            "schema_unexpected_heads": database_contract.get(
                "schema_unexpected_heads",
                [],
            ),
            "schema_head_count_expected": database_contract.get(
                "schema_head_count_expected",
            ),
            "schema_head_count_current": database_contract.get(
                "schema_head_count_current",
            ),
            "schema_head_delta_count": database_contract.get(
                "schema_head_delta_count",
            ),
            "schema_head_signature": database_contract.get("schema_head_signature"),
            "schema_graph_signature": database_contract.get("schema_graph_signature"),
            "schema_graph_roots": database_contract.get("schema_graph_roots", []),
            "schema_graph_branch_count": database_contract.get(
                "schema_graph_branch_count",
            ),
            "schema_graph_branch_tolerance": database_contract.get(
                "schema_graph_branch_tolerance",
            ),
            "schema_graph_allow_divergence_roots": database_contract.get(
                "schema_graph_allow_divergence_roots",
            ),
            "schema_graph_parent_forks": database_contract.get(
                "schema_graph_parent_forks",
                {},
            ),
            "schema_graph_duplicate_revisions": database_contract.get(
                "schema_graph_duplicate_revisions",
                {},
            ),
            "schema_graph_orphan_parents": database_contract.get(
                "schema_graph_orphan_parents",
                [],
            ),
            "schema_graph_lineage_ready": database_contract.get(
                "schema_graph_lineage_ready",
            ),
            "schema_graph_lineage_errors": lineage_errors,
            "schema_graph_lineage_warnings": database_contract.get(
                "schema_graph_lineage_warnings",
                [],
            ),
            "checked_at": database_contract.get("checked_at"),
            "account_scope_ready": bool(database_contract.get("account_scope_ready")),
            "account_scope_errors": database_contract.get("account_scope_errors", []),
            "account_scope_warnings": database_contract.get(
                "account_scope_warnings",
                [],
            ),
        }

    return dependencies, datetime.now(timezone.utc)


def _readiness_dependency_snapshot(
    session: Session,
    *,
    include_database_contract: bool,
    allow_stale_dependency_cache: bool = False,
) -> tuple[dict[str, object], datetime, bool]:
    if (
        not settings.trading_readiness_dependency_cache_enabled
        or settings.trading_readiness_dependency_cache_ttl_seconds <= 0
    ):
        dependencies, checked_at = _readiness_dependency_checks(
            session,
            include_database_contract=include_database_contract,
        )
        return dependencies, checked_at, False

    cache_ttl = timedelta(
        seconds=settings.trading_readiness_dependency_cache_ttl_seconds
    )
    stale_tolerance = max(
        0,
        int(settings.trading_readiness_dependency_cache_stale_tolerance_seconds),
    )
    now = datetime.now(timezone.utc)
    cache_key = _readiness_dependency_cache_key(include_database_contract)

    with _TRADING_DEPENDENCY_HEALTH_CACHE_LOCK:
        cache_entry = _TRADING_DEPENDENCY_HEALTH_CACHE.get(cache_key)
        if cache_entry:
            cache_checked_at = cast(datetime, cache_entry["checked_at"])
            cache_age = now - cache_checked_at
            if cache_age < cache_ttl:
                return (
                    cast(dict[str, object], cache_entry["dependencies"]),
                    cache_checked_at,
                    True,
                )
            if (
                allow_stale_dependency_cache
                and stale_tolerance > 0
                and cache_age <= cache_ttl + timedelta(seconds=stale_tolerance)
            ):
                return (
                    cast(dict[str, object], cache_entry["dependencies"]),
                    cache_checked_at,
                    True,
                )

    dependencies, checked_at = _readiness_dependency_checks(
        session,
        include_database_contract=include_database_contract,
    )
    with _TRADING_DEPENDENCY_HEALTH_CACHE_LOCK:
        _TRADING_DEPENDENCY_HEALTH_CACHE[cache_key] = {
            "checked_at": checked_at,
            "dependencies": dependencies,
        }
    return dependencies, checked_at, False


def _readiness_authority_truthy(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, int | float | Decimal):
        return bool(value)
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _append_unique_reason(target: list[object], reason: str) -> list[object]:
    if reason not in {str(item) for item in target}:
        target.append(reason)
    return target


def _readiness_dependency_degradation_reason_codes(
    dependencies: Mapping[str, object],
    *,
    scheduler_ok: bool,
) -> list[str]:
    reason_codes: list[str] = []
    if not scheduler_ok:
        reason_codes.append("scheduler_degraded")
    for name, checks in dependencies.items():
        if name in {"readiness_cache", "live_submission_gate"}:
            continue
        if not isinstance(checks, Mapping):
            continue
        dependency_checks = cast(Mapping[str, object], checks)
        if bool(dependency_checks.get("ok", True)):
            continue
        reason_codes.append(f"{name}_degraded")
    return sorted(set(reason_codes))


def _guard_live_submission_gate_for_readiness(
    live_submission_gate: Mapping[str, object],
    *,
    readiness_dependency_reasons: Sequence[str],
) -> dict[str, object]:
    gate = deepcopy(dict(live_submission_gate))
    if not readiness_dependency_reasons:
        return gate

    authority_keys = (
        "allowed",
        "promotion_authority",
        "promotion_authority_ok",
        "final_authority_ok",
        "final_promotion_allowed",
        "final_promotion_authorized",
    )
    claims_authority = any(
        _readiness_authority_truthy(gate.get(key)) for key in authority_keys
    )
    if not claims_authority:
        return gate

    guard_reason = "readiness_dependency_degraded"
    gate["allowed"] = False
    gate["promotion_authority"] = False
    gate["promotion_authority_ok"] = False
    gate["final_authority_ok"] = False
    gate["final_promotion_allowed"] = False
    gate["final_promotion_authorized"] = False
    gate["readiness_dependency_guard_active"] = True
    gate["readiness_dependency_guard_original_allowed"] = bool(
        live_submission_gate.get("allowed")
    )
    gate["readiness_dependency_guard_reasons"] = list(readiness_dependency_reasons)
    gate["reason"] = guard_reason

    blocked_reasons = list(cast(Sequence[object], gate.get("blocked_reasons") or []))
    gate["blocked_reasons"] = _append_unique_reason(blocked_reasons, guard_reason)
    reason_codes = list(cast(Sequence[object], gate.get("reason_codes") or []))
    gate["reason_codes"] = _append_unique_reason(reason_codes, guard_reason)

    plan = gate.get("runtime_ledger_paper_probation_import_plan")
    if isinstance(plan, Mapping):
        guarded_plan = deepcopy(dict(cast(Mapping[str, object], plan)))
        guarded_plan["promotion_allowed"] = False
        guarded_plan["final_promotion_allowed"] = False
        guarded_plan["final_promotion_authorized"] = False
        raw_targets = guarded_plan.get("targets")
        if isinstance(raw_targets, Sequence) and not isinstance(
            raw_targets,
            (str, bytes, bytearray),
        ):
            targets: list[object] = []
            for raw_target in cast(Sequence[object], raw_targets):
                if isinstance(raw_target, Mapping):
                    target = deepcopy(dict(cast(Mapping[str, object], raw_target)))
                    target["promotion_allowed"] = False
                    target["final_promotion_allowed"] = False
                    target["final_promotion_authorized"] = False
                    targets.append(target)
                else:
                    targets.append(raw_target)
            guarded_plan["targets"] = targets
        gate["runtime_ledger_paper_probation_import_plan"] = guarded_plan

    return gate


def _strip_promotion_authority_claims_for_readiness(value: object) -> object:
    if isinstance(value, Mapping):
        payload: dict[str, object] = {}
        mapping_value = cast(Mapping[object, object], value)
        for raw_key, raw_child in mapping_value.items():
            key = str(raw_key)
            if key in _READINESS_PROMOTION_AUTHORITY_KEYS and raw_child is True:
                payload[key] = False
            else:
                payload[key] = _strip_promotion_authority_claims_for_readiness(
                    raw_child
                )
        return payload
    if isinstance(value, list):
        list_value = cast(list[object], value)
        return [
            _strip_promotion_authority_claims_for_readiness(item) for item in list_value
        ]
    return value


def _core_readiness_live_submission_gate() -> dict[str, object]:
    blocked_reasons: list[str] = ["readyz_core_dependencies_only"]
    if settings.trading_mode == "live":
        if not settings.trading_enabled:
            blocked_reasons.append("trading_disabled")
        if settings.trading_kill_switch_enabled:
            blocked_reasons.append("kill_switch_enabled")
        if (
            settings.trading_pipeline_mode == "simple"
            and not settings.trading_simple_submit_enabled
        ):
            blocked_reasons.append("simple_submit_disabled")

    return {
        "allowed": False,
        "promotion_authority": False,
        "promotion_authority_ok": False,
        "final_authority_ok": False,
        "final_promotion_allowed": False,
        "final_promotion_authorized": False,
        "reason": blocked_reasons[0],
        "reason_codes": blocked_reasons,
        "blocked_reasons": blocked_reasons,
        "capital_stage": "shadow",
        "capital_state": "observe",
        "read_model_evaluated": False,
        "readiness_surface": "core_dependencies_only",
    }


def _evaluate_core_readiness_payload(
    *,
    include_database_contract: bool = False,
    allow_stale_dependency_cache: bool = False,
) -> tuple[dict[str, object], int]:
    scheduler: TradingScheduler | None = getattr(app.state, "trading_scheduler", None)
    if scheduler is None:
        scheduler = TradingScheduler()
        app.state.trading_scheduler = scheduler
    scheduler_ok, scheduler_payload = _evaluate_scheduler_status(scheduler)

    now = datetime.now(timezone.utc)
    with SessionLocal() as session:
        dependencies, checked_at, cache_used = _readiness_dependency_snapshot(
            session,
            include_database_contract=include_database_contract,
            allow_stale_dependency_cache=allow_stale_dependency_cache,
        )
    dependencies = dict(dependencies)
    dependencies["universe"] = _evaluate_universe_dependency(scheduler)
    cache_age_seconds = (now - checked_at).total_seconds() if checked_at else 0.0
    cache_age_seconds = 0.0 if cache_age_seconds < 0 else round(cache_age_seconds, 3)
    cache_stale = (
        cache_used
        and cache_age_seconds > settings.trading_readiness_dependency_cache_ttl_seconds
    )
    dependencies["readiness_cache"] = {
        "checked_at": checked_at.isoformat(),
        "cache_ttl_seconds": settings.trading_readiness_dependency_cache_ttl_seconds,
        "cache_stale_tolerance_seconds": settings.trading_readiness_dependency_cache_stale_tolerance_seconds,
        "cache_used": cache_used,
        "cache_age_seconds": cache_age_seconds,
        "cache_stale": cache_stale,
    }

    readiness_dependency_reasons = _readiness_dependency_degradation_reason_codes(
        dependencies,
        scheduler_ok=scheduler_ok,
    )
    overall_ok = scheduler_ok and not readiness_dependency_reasons
    status = "ok" if overall_ok else "degraded"
    status_code = 200 if overall_ok else 503
    payload: dict[str, object] = {
        "status": status,
        "reason_codes": readiness_dependency_reasons,
        "scheduler": scheduler_payload,
        "dependencies": dependencies,
        "build": {
            "version": BUILD_VERSION,
            "commit": main_runtime_value("BUILD_COMMIT"),
            "image_digest": BUILD_IMAGE_DIGEST,
            "active_revision": _active_runtime_revision()
            or main_runtime_value("BUILD_COMMIT"),
        },
        "mode": settings.trading_mode,
        "pipeline_mode": settings.trading_pipeline_mode,
        "trading_enabled": settings.trading_enabled,
        "readiness_surface": "core_dependencies_only",
        "live_submission_gate": _core_readiness_live_submission_gate(),
    }
    return cast(
        dict[str, object],
        _strip_promotion_authority_claims_for_readiness(payload),
    ), status_code


def _trading_health_surface_cache_key(
    *,
    include_database_contract: bool,
    allow_stale_dependency_cache: bool,
) -> str:
    return (
        f"health-surface:{int(include_database_contract)}:"
        f"{int(allow_stale_dependency_cache)}"
    )


def _cache_completed_trading_health_surface_payload(
    cache_key: str,
    payload: dict[str, object],
    status_code: int,
) -> None:
    with _TRADING_HEALTH_SURFACE_EVALUATION_LOCK:
        _TRADING_HEALTH_SURFACE_PAYLOAD_CACHE[cache_key] = {
            "payload": deepcopy(payload),
            "status_code": status_code,
            "checked_at": datetime.now(timezone.utc),
        }


def _record_trading_health_surface_completion(
    cache_key: str,
    future: Future[tuple[dict[str, object], int]],
) -> None:
    with _TRADING_HEALTH_SURFACE_EVALUATION_LOCK:
        current = _TRADING_HEALTH_SURFACE_EVALUATIONS.get(cache_key)
        if current is not future:
            return
        _TRADING_HEALTH_SURFACE_EVALUATIONS.pop(cache_key, None)

    try:
        payload, status_code = future.result()
    except Exception as exc:  # pragma: no cover - defensive callback surface
        logger.warning(
            "Trading health surface evaluation failed asynchronously: %s", exc
        )
        return

    _cache_completed_trading_health_surface_payload(cache_key, payload, status_code)


def _cached_trading_health_surface_payload(
    cache_key: str,
) -> tuple[dict[str, object], datetime] | None:
    with _TRADING_HEALTH_SURFACE_EVALUATION_LOCK:
        cache_entry = _TRADING_HEALTH_SURFACE_PAYLOAD_CACHE.get(cache_key)
        if cache_entry is None:
            return None
        payload = deepcopy(cast(dict[str, object], cache_entry["payload"]))
        checked_at = cast(datetime, cache_entry["checked_at"])
    return payload, checked_at


def _cached_readiness_dependencies_for_health_surface(
    *,
    include_database_contract: bool,
) -> tuple[dict[str, object], datetime] | None:
    cache_key = _readiness_dependency_cache_key(include_database_contract)
    with _TRADING_DEPENDENCY_HEALTH_CACHE_LOCK:
        cache_entry = _TRADING_DEPENDENCY_HEALTH_CACHE.get(cache_key)
        if cache_entry is None:
            return None
        dependencies = deepcopy(cast(dict[str, object], cache_entry["dependencies"]))
        checked_at = cast(datetime, cache_entry["checked_at"])
    return dependencies, checked_at


def _fail_closed_health_evaluation_gate(
    *,
    reason_code: str,
    detail: str,
) -> dict[str, object]:
    return {
        "allowed": False,
        "promotion_authority": False,
        "promotion_authority_ok": False,
        "final_authority_ok": False,
        "final_promotion_allowed": False,
        "final_promotion_authorized": False,
        "reason": reason_code,
        "reason_codes": [reason_code],
        "blocked_reasons": [reason_code],
        "detail": detail,
    }


def _health_surface_timeout_dependency_placeholder(
    *,
    reason_code: str,
    detail: str,
) -> dict[str, object]:
    return {
        "ok": False,
        "detail": detail,
        "reason": reason_code,
        "reason_codes": [reason_code],
    }


def _minimal_health_surface_timeout_live_submission_gate(
    *,
    reason_code: str,
    detail: str,
) -> dict[str, object]:
    blocked_reasons: list[str] = []
    if settings.trading_mode == "live":
        if not settings.trading_enabled:
            blocked_reasons.append("trading_disabled")
        if settings.trading_kill_switch_enabled:
            blocked_reasons.append("kill_switch_enabled")
        if (
            settings.trading_pipeline_mode == "simple"
            and not settings.trading_simple_submit_enabled
        ):
            blocked_reasons.append("simple_submit_disabled")

    reason = blocked_reasons[0] if blocked_reasons else reason_code

    return {
        "allowed": False,
        "promotion_authority": False,
        "promotion_authority_ok": False,
        "final_authority_ok": False,
        "final_promotion_allowed": False,
        "final_promotion_authorized": False,
        "reason": reason,
        "reason_codes": blocked_reasons or [reason_code],
        "blocked_reasons": blocked_reasons or [reason_code],
        "detail": detail if reason == reason_code else reason,
        "capital_stage": "shadow",
        "capital_state": "observe",
        "health_evaluation_timeout": {
            "ok": False,
            "reason": reason_code,
            "reason_codes": [reason_code],
            "detail": detail,
        },
    }


def _minimal_health_surface_timeout_proof_floor() -> dict[str, object]:
    return {
        "route_state": "repair_only",
        "capital_state": "zero_notional",
        "promotion_authority": False,
        "final_authority_ok": False,
        "final_promotion_allowed": False,
        "final_promotion_authorized": False,
    }


def _minimal_health_surface_timeout_payload(
    *,
    include_database_contract: bool,
    reason_code: str,
    detail: str,
) -> dict[str, object]:
    cached_dependencies = _cached_readiness_dependencies_for_health_surface(
        include_database_contract=include_database_contract,
    )
    if cached_dependencies is None:
        dependencies: dict[str, object] = {}
        unavailable_detail = f"not evaluated before {reason_code}"
        for dependency_name in ("postgres", "clickhouse", "alpaca", "tigerbeetle"):
            dependencies[dependency_name] = (
                _health_surface_timeout_dependency_placeholder(
                    reason_code=reason_code,
                    detail=unavailable_detail,
                )
            )
        if include_database_contract:
            dependencies["database"] = _health_surface_timeout_dependency_placeholder(
                reason_code=reason_code,
                detail=unavailable_detail,
            )
    else:
        dependencies, checked_at = cached_dependencies
        now = datetime.now(timezone.utc)
        cache_age_seconds = round(max(0.0, (now - checked_at).total_seconds()), 3)
        cache_ttl_seconds = settings.trading_readiness_dependency_cache_ttl_seconds
        dependencies["readiness_cache"] = {
            "checked_at": checked_at.isoformat(),
            "cache_ttl_seconds": cache_ttl_seconds,
            "cache_stale_tolerance_seconds": settings.trading_readiness_dependency_cache_stale_tolerance_seconds,
            "cache_used": True,
            "cache_age_seconds": cache_age_seconds,
            "cache_stale": cache_age_seconds > cache_ttl_seconds,
            "health_surface_timeout_fallback": True,
        }

    dependencies["health_evaluation"] = {
        "ok": False,
        "detail": detail,
        "reason_codes": [reason_code],
    }
    scheduler: TradingScheduler | None = getattr(app.state, "trading_scheduler", None)
    if scheduler is None:
        scheduler = TradingScheduler()
        app.state.trading_scheduler = scheduler
    _scheduler_ok, scheduler_payload = _evaluate_scheduler_status(scheduler)
    live_submission_gate = _minimal_health_surface_timeout_live_submission_gate(
        reason_code=reason_code,
        detail=detail,
    )
    proof_floor = _minimal_health_surface_timeout_proof_floor()
    live_mode = settings.trading_mode == "live"
    dependencies["live_submission_gate"] = {
        "ok": bool(live_submission_gate.get("allowed", False)),
        "detail": str(live_submission_gate.get("reason") or reason_code),
        "capital_stage": live_submission_gate.get("capital_stage"),
    }
    dependencies["profitability_proof_floor"] = {
        "ok": False if live_mode else True,
        "detail": str(proof_floor.get("route_state") or "repair_only"),
        "capital_state": proof_floor.get("capital_state"),
        "required": live_mode,
    }
    return cast(
        dict[str, object],
        _strip_promotion_authority_claims_for_readiness(
            {
                "status": "degraded",
                "reason": reason_code,
                "reason_codes": [reason_code],
                "scheduler": scheduler_payload,
                "dependencies": dependencies,
                "live_submission_gate": live_submission_gate,
                "proof_floor": proof_floor,
            }
        ),
    )


def _health_surface_timeout_fallback_payload(
    *,
    cache_key: str,
    include_database_contract: bool,
    reason_code: str,
    detail: str,
) -> dict[str, object]:
    cached = _cached_trading_health_surface_payload(cache_key)
    if cached is None:
        return _minimal_health_surface_timeout_payload(
            include_database_contract=include_database_contract,
            reason_code=reason_code,
            detail=detail,
        )

    payload, checked_at = cached
    payload["status"] = "degraded"
    payload["reason"] = reason_code
    reason_codes = list(cast(Sequence[object], payload.get("reason_codes") or []))
    payload["reason_codes"] = _append_unique_reason(reason_codes, reason_code)
    payload["health_evaluation_timeout"] = {
        "ok": False,
        "detail": detail,
        "reason_codes": [reason_code],
        "cached_payload_checked_at": checked_at.isoformat(),
    }
    dependencies = payload.get("dependencies")
    if isinstance(dependencies, Mapping):
        dependencies_payload = deepcopy(dict(cast(Mapping[str, object], dependencies)))
    else:
        dependencies_payload = {}
    dependencies_payload["health_evaluation"] = {
        "ok": False,
        "detail": detail,
        "reason_codes": [reason_code],
        "cached_payload_checked_at": checked_at.isoformat(),
    }
    payload["dependencies"] = dependencies_payload
    live_submission_gate = payload.get("live_submission_gate")
    if isinstance(live_submission_gate, Mapping):
        payload["live_submission_gate"] = _guard_live_submission_gate_for_readiness(
            cast(Mapping[str, object], live_submission_gate),
            readiness_dependency_reasons=[reason_code],
        )
    else:
        payload["live_submission_gate"] = _fail_closed_health_evaluation_gate(
            reason_code=reason_code,
            detail=detail,
        )
    return cast(
        dict[str, object],
        _strip_promotion_authority_claims_for_readiness(payload),
    )


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
        refresh_future = _TRADING_HEALTH_SURFACE_EVALUATION_EXECUTOR.submit(
            _evaluate_trading_health_payload,
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
                "_TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS",
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


def _evaluate_trading_health_payload(
    *,
    include_database_contract: bool = False,
    allow_stale_dependency_cache: bool = False,
) -> tuple[dict[str, object], int]:
    """Build shared trading health payload and status code."""

    scheduler: TradingScheduler | None = getattr(app.state, "trading_scheduler", None)
    if scheduler is None:
        scheduler = TradingScheduler()
        app.state.trading_scheduler = scheduler
    scheduler_ok, scheduler_payload = _evaluate_scheduler_status(scheduler)

    now = datetime.now(timezone.utc)
    with SessionLocal() as session:
        dependencies, checked_at, cache_used = _readiness_dependency_snapshot(
            session,
            include_database_contract=include_database_contract,
            allow_stale_dependency_cache=allow_stale_dependency_cache,
        )
    dependencies = dict(dependencies)
    dependencies["universe"] = _evaluate_universe_dependency(scheduler)
    cache_age_seconds = (now - checked_at).total_seconds() if checked_at else 0.0
    cache_age_seconds = 0.0 if cache_age_seconds < 0 else round(cache_age_seconds, 3)
    cache_stale = (
        cache_used
        and cache_age_seconds > settings.trading_readiness_dependency_cache_ttl_seconds
    )
    dependencies["readiness_cache"] = {
        "checked_at": checked_at.isoformat(),
        "cache_ttl_seconds": settings.trading_readiness_dependency_cache_ttl_seconds,
        "cache_stale_tolerance_seconds": settings.trading_readiness_dependency_cache_stale_tolerance_seconds,
        "cache_used": cache_used,
        "cache_age_seconds": cache_age_seconds,
        "cache_stale": cache_stale,
    }

    alpha_readiness: dict[str, object]
    tca_summary: dict[str, object] = {}
    market_context_status = scheduler.market_context_status()
    _hypothesis_payload: Mapping[str, object] = {}
    _dependency_quorum = JangarDependencyQuorumStatus(
        decision="unknown",
        reasons=["alpha_readiness_not_evaluated"],
        message="alpha readiness not evaluated",
    )
    try:
        with SessionLocal() as session:
            tca_summary = _load_tca_summary(session, scheduler=scheduler)
        _hypothesis_payload, hypothesis_summary, _dependency_quorum = (
            _build_hypothesis_runtime_payload(
                scheduler,
                tca_summary=tca_summary,
                market_context_status=market_context_status,
            )
        )
        alpha_readiness = {
            "hypotheses_total": hypothesis_summary.get("hypotheses_total", 0),
            "state_totals": hypothesis_summary.get("state_totals", {}),
            "promotion_eligible_total": hypothesis_summary.get(
                "promotion_eligible_total", 0
            ),
            "rollback_required_total": hypothesis_summary.get(
                "rollback_required_total", 0
            ),
            "dependency_quorum": hypothesis_summary.get("dependency_quorum", {}),
        }
    except Exception as exc:  # pragma: no cover - additive status surface only
        alpha_readiness = {
            "hypotheses_total": 0,
            "state_totals": {},
            "promotion_eligible_total": 0,
            "rollback_required_total": 0,
            "dependency_quorum": {
                "decision": "unknown",
                "reasons": ["alpha_readiness_unavailable"],
                "message": str(exc),
            },
        }
        _dependency_quorum = JangarDependencyQuorumStatus(
            decision="unknown",
            reasons=["alpha_readiness_unavailable"],
            message=str(exc),
        )
        hypothesis_summary = {}

    llm_status = scheduler.llm_status()
    dspy_runtime = (
        cast(dict[str, object], llm_status.get("dspy_runtime"))
        if isinstance(llm_status.get("dspy_runtime"), dict)
        else {}
    )
    empirical_jobs = _empirical_jobs_status()
    quant_evidence = load_quant_evidence_status(
        account_label=settings.trading_account_label,
    )
    with SessionLocal() as session:
        live_submission_gate = _build_live_submission_gate_payload(
            scheduler.state,
            session=session,
            hypothesis_summary=_hypothesis_payload,
            empirical_jobs_status=empirical_jobs,
            dspy_runtime_status=dspy_runtime,
            quant_health_status=quant_evidence,
        )
    proof_floor = _build_profitability_proof_floor_payload(
        state=scheduler.state,
        torghut_revision=main_runtime_value("BUILD_COMMIT"),
        live_submission_gate=live_submission_gate,
        hypothesis_payload=_hypothesis_payload,
        empirical_jobs_status=empirical_jobs,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        tca_summary=tca_summary,
    )
    renewal_bond_profit_escrow = _build_renewal_bond_profit_escrow_payload(
        state=scheduler.state,
        torghut_revision=main_runtime_value("BUILD_COMMIT"),
        dependency_quorum=_dependency_quorum.as_payload(),
        live_submission_gate=live_submission_gate,
        proof_floor=proof_floor,
        hypothesis_payload=_hypothesis_payload,
        empirical_jobs_status=empirical_jobs,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        tca_summary=tca_summary,
    )
    route_reacquisition_board = _build_route_reacquisition_board_payload(
        proof_floor=proof_floor,
        active_revision=main_runtime_value("BUILD_COMMIT"),
    )
    profit_signal_quorum = _build_profit_signal_quorum_payload(
        torghut_revision=main_runtime_value("BUILD_COMMIT"),
        dependency_quorum=_dependency_quorum.as_payload(),
        hypothesis_payload=_hypothesis_payload,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        proof_floor=proof_floor,
        route_reacquisition_board=route_reacquisition_board,
        live_submission_gate=live_submission_gate,
    )
    with SessionLocal() as session:
        options_catalog_freshness = _load_options_catalog_freshness_summary(
            session,
            route_symbols=_route_claim_symbols(profit_signal_quorum),
        )
    capital_replay_projection = _build_capital_replay_projection_payload(
        torghut_revision=main_runtime_value("BUILD_COMMIT"),
        dependency_quorum=_dependency_quorum.as_payload(),
        live_submission_gate=live_submission_gate,
        proof_floor=proof_floor,
        route_reacquisition_board=route_reacquisition_board,
        empirical_jobs_status=empirical_jobs,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
    )
    quality_adjusted_profit_frontier = _build_quality_adjusted_profit_frontier_payload(
        torghut_revision=main_runtime_value("BUILD_COMMIT"),
        live_submission_gate=live_submission_gate,
        proof_floor=proof_floor,
        route_reacquisition_board=route_reacquisition_board,
        hypothesis_payload=_hypothesis_payload,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        active_simulation_context=active_simulation_runtime_context(),
    )
    consumer_evidence_receipt, route_proven_profit_receipt = (
        _build_consumer_evidence_receipt_projection(
            forecast_service_status=_forecast_service_status(empirical_jobs),
            empirical_jobs_status=empirical_jobs,
            proof_floor=proof_floor,
            live_submission_gate=live_submission_gate,
            serving_revision=_active_runtime_revision()
            or main_runtime_value("BUILD_COMMIT"),
        )
    )
    capital_reentry_cohort_ledger = _build_capital_reentry_cohort_ledger_payload(
        torghut_revision=main_runtime_value("BUILD_COMMIT"),
        dependency_quorum=_dependency_quorum.as_payload(),
        consumer_evidence_receipt=consumer_evidence_receipt,
        proof_floor=proof_floor,
        route_reacquisition_board=route_reacquisition_board,
    )
    profit_repair_settlement_ledger = _build_profit_repair_settlement_ledger_payload(
        torghut_revision=main_runtime_value("BUILD_COMMIT"),
        dependency_quorum=_dependency_quorum.as_payload(),
        consumer_evidence_receipt=consumer_evidence_receipt,
        proof_floor=proof_floor,
        capital_reentry_cohort_ledger=capital_reentry_cohort_ledger,
        quality_adjusted_profit_frontier=quality_adjusted_profit_frontier,
        route_reacquisition_board=route_reacquisition_board,
        live_submission_gate=live_submission_gate,
        quant_evidence=quant_evidence,
    )
    routeability_repair_acceptance_ledger = (
        _build_routeability_repair_acceptance_ledger_payload(
            torghut_revision=main_runtime_value("BUILD_COMMIT"),
            dependency_quorum=_dependency_quorum.as_payload(),
            consumer_evidence_receipt=consumer_evidence_receipt,
            proof_floor=proof_floor,
            capital_reentry_cohort_ledger=capital_reentry_cohort_ledger,
            quality_adjusted_profit_frontier=quality_adjusted_profit_frontier,
            profit_repair_settlement_ledger=profit_repair_settlement_ledger,
            route_reacquisition_board=route_reacquisition_board,
            live_submission_gate=live_submission_gate,
            quant_evidence=quant_evidence,
            market_context_status=market_context_status,
        )
    )
    profit_freshness_frontier = _build_profit_freshness_frontier_payload(
        torghut_revision=main_runtime_value("BUILD_COMMIT"),
        dependency_quorum=_dependency_quorum.as_payload(),
        proof_floor=proof_floor,
        routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
        quality_adjusted_profit_frontier=quality_adjusted_profit_frontier,
        route_reacquisition_board=route_reacquisition_board,
        live_submission_gate=live_submission_gate,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        empirical_jobs_status=empirical_jobs,
        hypothesis_payload=_hypothesis_payload,
    )
    build_payload = {
        "version": BUILD_VERSION,
        "commit": main_runtime_value("BUILD_COMMIT"),
        "image_digest": BUILD_IMAGE_DIGEST,
        "active_revision": _active_runtime_revision()
        or main_runtime_value("BUILD_COMMIT"),
    }
    clickhouse_ta_status = _load_clickhouse_ta_status(scheduler)
    evidence_clock_arbiter, routeable_profit_candidate_exchange = (
        _build_evidence_clock_payloads(
            torghut_revision=main_runtime_value("BUILD_COMMIT"),
            dependency_quorum=_dependency_quorum.as_payload(),
            hypothesis_payload=_hypothesis_payload,
            quant_evidence=quant_evidence,
            market_context_status=market_context_status,
            tca_summary=tca_summary,
            empirical_jobs_status=empirical_jobs,
            proof_floor=proof_floor,
            routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
            profit_signal_quorum=profit_signal_quorum,
            live_submission_gate=live_submission_gate,
            build=build_payload,
            clickhouse_ta_status=clickhouse_ta_status,
        )
    )
    clock_settlement_receipt = _build_clock_settlement_payload(
        torghut_revision=main_runtime_value("BUILD_COMMIT"),
        source_commit=main_runtime_value("BUILD_COMMIT"),
        build=build_payload,
        evidence_clock_arbiter=evidence_clock_arbiter,
        routeable_profit_candidate_exchange=routeable_profit_candidate_exchange,
        clickhouse_ta_status=clickhouse_ta_status,
        quant_evidence=quant_evidence,
        tca_summary=tca_summary,
        empirical_jobs_status=empirical_jobs,
        profit_signal_quorum=profit_signal_quorum,
        rollout_status=_build_route_image_proof_summary(
            build=build_payload,
            dependency_quorum=_dependency_quorum.as_payload(),
        ),
    )
    route_evidence_clearinghouse_packet = _build_route_evidence_clearinghouse_payload(
        torghut_revision=main_runtime_value("BUILD_COMMIT"),
        source_commit=main_runtime_value("BUILD_COMMIT"),
        dependency_quorum=_dependency_quorum.as_payload(),
        build=build_payload,
        proof_floor=proof_floor,
        profit_signal_quorum=profit_signal_quorum,
        profit_repair_settlement_ledger=profit_repair_settlement_ledger,
        route_reacquisition_board=route_reacquisition_board,
        routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
        live_submission_gate=live_submission_gate,
        tca_summary=tca_summary,
        options_catalog_freshness=options_catalog_freshness,
    )
    repair_bid_settlement_ledger = _build_repair_bid_settlement_payload(
        torghut_revision=main_runtime_value("BUILD_COMMIT"),
        source_commit=main_runtime_value("BUILD_COMMIT"),
        dependency_quorum=_dependency_quorum.as_payload(),
        build=build_payload,
        route_evidence_clearinghouse_packet=route_evidence_clearinghouse_packet,
        routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
        quant_evidence=quant_evidence,
        profit_freshness_frontier=profit_freshness_frontier,
    )
    route_warrant_exchange = _build_route_warrant_exchange_payload(
        torghut_revision=main_runtime_value("BUILD_COMMIT"),
        source_commit=main_runtime_value("BUILD_COMMIT"),
        build=build_payload,
        consumer_evidence_receipt=consumer_evidence_receipt,
        evidence_clock_arbiter=evidence_clock_arbiter,
        routeable_profit_candidate_exchange=routeable_profit_candidate_exchange,
        routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
        profit_freshness_frontier=profit_freshness_frontier,
        live_submission_gate=live_submission_gate,
        quant_evidence=quant_evidence,
        tca_summary=tca_summary,
        empirical_jobs_status=empirical_jobs,
        market_context_status=market_context_status,
    )
    source_serving_repair_receipt_ledger = _build_source_serving_repair_receipt_payload(
        source_commit=main_runtime_value("BUILD_COMMIT"),
        build=build_payload,
        consumer_evidence_receipt=consumer_evidence_receipt,
        route_evidence_clearinghouse_packet=route_evidence_clearinghouse_packet,
        repair_bid_settlement_ledger=repair_bid_settlement_ledger,
        route_warrant_exchange=route_warrant_exchange,
    )
    freshness_carry_ledger = _build_freshness_carry_ledger_payload(
        source_serving_repair_receipt_ledger=source_serving_repair_receipt_ledger,
        route_warrant_exchange=route_warrant_exchange,
        clickhouse_ta_status=clickhouse_ta_status,
        tca_summary=tca_summary,
        empirical_jobs_status=empirical_jobs,
        market_context_status=market_context_status,
        quant_evidence=quant_evidence,
        live_submission_gate=live_submission_gate,
    )
    repair_receipt_frontier = _build_repair_receipt_frontier_payload(
        torghut_revision=main_runtime_value("BUILD_COMMIT"),
        source_commit=main_runtime_value("BUILD_COMMIT"),
        source_serving_repair_receipt_ledger=source_serving_repair_receipt_ledger,
        freshness_carry_ledger=freshness_carry_ledger,
        repair_bid_settlement_ledger=repair_bid_settlement_ledger,
        profit_freshness_frontier=profit_freshness_frontier,
        route_warrant_exchange=route_warrant_exchange,
        live_submission_gate=live_submission_gate,
        proof_floor=proof_floor,
    )
    repair_outcome_dividend_ledger = _build_repair_outcome_dividend_ledger_payload(
        repair_bid_settlement_ledger=repair_bid_settlement_ledger,
        repair_receipt_frontier=repair_receipt_frontier,
        freshness_carry_ledger=freshness_carry_ledger,
        route_warrant_exchange=route_warrant_exchange,
        live_submission_gate=live_submission_gate,
    )
    live_mode = settings.trading_mode == "live"
    empirical_jobs_required = (
        live_mode and settings.trading_empirical_jobs_health_required
    )
    dependencies["empirical_jobs"] = {
        "ok": bool(empirical_jobs.get("ready")) if empirical_jobs_required else True,
        "detail": (
            str(empirical_jobs.get("status") or "unknown")
            if live_mode
            else "not_required_in_non_live_mode"
        ),
        "authority": empirical_jobs.get("authority"),
        "required": empirical_jobs_required,
    }
    dependencies["dspy_runtime"] = {
        "ok": bool(dspy_runtime.get("live_ready", False))
        if str(dspy_runtime.get("mode") or "").strip().lower() == "active"
        else True,
        "detail": (
            "ready"
            if bool(dspy_runtime.get("live_ready", False))
            else ", ".join(
                [
                    str(item).strip()
                    for item in cast(
                        list[object], dspy_runtime.get("readiness_reasons") or []
                    )
                    if str(item).strip()
                ]
            )
            or "not_ready"
        ),
        "artifact_hash": dspy_runtime.get("artifact_hash"),
    }
    dependencies["live_submission_gate"] = {
        "ok": bool(live_submission_gate.get("allowed", False)),
        "detail": str(live_submission_gate.get("reason") or "unknown"),
        "capital_stage": live_submission_gate.get("capital_stage"),
    }
    dependencies["profitability_proof_floor"] = {
        "ok": (
            str(proof_floor.get("route_state") or "") != "repair_only"
            if live_mode
            else True
        ),
        "detail": str(proof_floor.get("route_state") or "unknown"),
        "capital_state": proof_floor.get("capital_state"),
        "required": live_mode,
    }
    dependencies["quant_evidence"] = {
        "ok": (
            bool(quant_evidence.get("ok", True))
            if live_mode and bool(quant_evidence.get("required", False))
            else True
        ),
        "detail": (
            str(quant_evidence.get("reason") or "unknown")
            if live_mode
            else "not_required_in_non_live_mode"
        ),
        "required": bool(quant_evidence.get("required", False)),
        "window": quant_evidence.get("window"),
    }
    readiness_dependency_reasons = _readiness_dependency_degradation_reason_codes(
        dependencies,
        scheduler_ok=scheduler_ok,
    )
    live_submission_gate_for_readiness = _guard_live_submission_gate_for_readiness(
        live_submission_gate,
        readiness_dependency_reasons=readiness_dependency_reasons,
    )
    if bool(
        live_submission_gate_for_readiness.get("readiness_dependency_guard_active")
    ):
        dependencies["live_submission_gate"] = {
            "ok": False,
            "detail": str(
                live_submission_gate_for_readiness.get("reason")
                or "readiness_dependency_degraded"
            ),
            "capital_stage": live_submission_gate_for_readiness.get("capital_stage"),
            "readiness_dependency_guard_active": True,
            "readiness_dependency_guard_reasons": readiness_dependency_reasons,
        }
    revenue_repair_digest = build_revenue_repair_digest(
        readyz_payload={
            "status": (
                "degraded"
                if live_submission_gate_for_readiness.get("allowed") is not True
                else "ok"
            ),
            "proof_floor": proof_floor,
            "live_submission_gate": live_submission_gate_for_readiness,
            "quant_evidence": quant_evidence,
            "dependencies": dependencies,
        },
        status_payload={
            "mode": settings.trading_mode,
            "pipeline_mode": settings.trading_pipeline_mode,
            "build": build_payload,
            "dependency_quorum": _dependency_quorum.as_payload(),
            "live_submission_gate": live_submission_gate_for_readiness,
            "proof_floor": proof_floor,
            "quant_evidence": quant_evidence,
            "routeability_repair_acceptance_ledger": routeability_repair_acceptance_ledger,
            "route_evidence_clearinghouse_packet": route_evidence_clearinghouse_packet,
            "repair_bid_settlement_ledger": repair_bid_settlement_ledger,
            "capital_replay_board": capital_replay_projection.get(
                "capital_replay_board"
            ),
            "executable_alpha_receipts": capital_replay_projection.get(
                "executable_alpha_receipts"
            ),
            "controller_ingestion_settlement": _dependency_quorum.as_payload().get(
                "controller_ingestion_settlement"
            ),
            "verify_trust_foreclosure_board": _dependency_quorum.as_payload().get(
                "verify_trust_foreclosure_board"
            ),
            "repair_slot_escrow": _dependency_quorum.as_payload().get(
                "repair_slot_escrow"
            ),
            "stage_debt_repair_admission": _dependency_quorum.as_payload().get(
                "stage_debt_repair_admission"
            ),
            "foreclosure_carry_rollout_witness": _dependency_quorum.as_payload().get(
                "foreclosure_carry_rollout_witness"
            ),
            "source_serving_repair_receipt_ledger": source_serving_repair_receipt_ledger,
        },
        generated_at=now,
    )
    dependency_statuses = [
        cast(dict[str, object], checks).get("ok", True)
        for name, checks in dependencies.items()
        if name != "readiness_cache"
    ]

    overall_ok = scheduler_ok and all(bool(dep) for dep in dependency_statuses)
    status = "ok" if overall_ok else "degraded"
    status_code = 200 if overall_ok else 503

    response_payload = {
        "status": status,
        "scheduler": scheduler_payload,
        "dependencies": dependencies,
        "alpha_readiness": alpha_readiness,
        "live_submission_gate": live_submission_gate_for_readiness,
        "proof_floor": proof_floor,
        "renewal_bond_profit_escrow": renewal_bond_profit_escrow,
        "capital_replay_board": capital_replay_projection["capital_replay_board"],
        "executable_alpha_receipts": capital_replay_projection[
            "executable_alpha_receipts"
        ],
        "quality_adjusted_profit_frontier": quality_adjusted_profit_frontier,
        "torghut_consumer_evidence_receipt": consumer_evidence_receipt,
        "route_proven_profit_receipt": route_proven_profit_receipt,
        "consumer_evidence_canary": route_proven_profit_receipt.get("route_canary"),
        "capital_reentry_cohort_ledger": capital_reentry_cohort_ledger,
        "profit_repair_settlement_ledger": profit_repair_settlement_ledger,
        "routeability_repair_acceptance_ledger": routeability_repair_acceptance_ledger,
        "profit_freshness_frontier": profit_freshness_frontier,
        "profit_signal_quorum": profit_signal_quorum,
        "evidence_clock_arbiter": evidence_clock_arbiter,
        "routeable_profit_candidate_exchange": routeable_profit_candidate_exchange,
        "clock_settlement_receipt": clock_settlement_receipt,
        "route_evidence_clearinghouse_packet": route_evidence_clearinghouse_packet,
        "repair_bid_settlement_ledger": repair_bid_settlement_ledger,
        **_revenue_repair_topline_fields(revenue_repair_digest),
        "route_warrant_exchange": route_warrant_exchange,
        "source_serving_repair_receipt_ledger": source_serving_repair_receipt_ledger,
        "freshness_carry_ledger": freshness_carry_ledger,
        "repair_receipt_frontier": repair_receipt_frontier,
        "repair_outcome_dividend_ledger": repair_outcome_dividend_ledger,
        "executable_alpha_settlement_slots": compact_executable_alpha_settlement_slots(
            cast(
                Mapping[str, Any],
                revenue_repair_digest.get("executable_alpha_settlement_slots"),
            )
        ),
        "alpha_repair_closure_board": compact_alpha_repair_closure_board(
            cast(
                Mapping[str, Any],
                revenue_repair_digest.get("alpha_repair_closure_board"),
            )
        ),
        "alpha_evidence_foundry": compact_alpha_evidence_foundry(
            cast(
                Mapping[str, Any],
                revenue_repair_digest.get("alpha_evidence_foundry"),
            )
        ),
        "alpha_readiness_settlement_conveyor": compact_alpha_readiness_settlement_conveyor(
            cast(
                Mapping[str, Any],
                revenue_repair_digest.get("alpha_readiness_settlement_conveyor"),
            )
        ),
        "alpha_repair_dividend_ledger": compact_alpha_repair_dividend_ledger(
            cast(
                Mapping[str, Any],
                revenue_repair_digest.get("alpha_repair_dividend_ledger"),
            )
        ),
        "alpha_closure_dividend_slo": build_alpha_closure_dividend_slo(
            generated_at=datetime.now(timezone.utc),
            alpha_repair_closure_board=cast(
                Mapping[str, Any] | None,
                revenue_repair_digest.get("alpha_repair_closure_board"),
            ),
            alpha_repair_dividend_ledger=cast(
                Mapping[str, Any] | None,
                revenue_repair_digest.get("alpha_repair_dividend_ledger"),
            ),
        ),
        "jangar_controller_ingestion_carry": compact_jangar_controller_ingestion_carry(
            cast(
                Mapping[str, Any],
                revenue_repair_digest.get("jangar_controller_ingestion_carry"),
            )
        ),
        "no_delta_repair_reentry_auction": compact_no_delta_repair_reentry_auction(
            cast(
                Mapping[str, Any],
                revenue_repair_digest.get("no_delta_repair_reentry_auction"),
            )
        ),
        "route_reacquisition_book": proof_floor.get("route_reacquisition_book"),
        "route_reacquisition_board": route_reacquisition_board,
        "quant_evidence": quant_evidence,
        "profit_lease_projection": live_submission_gate_for_readiness.get(
            "profit_lease_projection"
        ),
    }
    if readiness_dependency_reasons:
        response_payload = cast(
            dict[str, object],
            _strip_promotion_authority_claims_for_readiness(response_payload),
        )

    return response_payload, status_code


def _evaluate_universe_dependency(
    scheduler: TradingScheduler | None,
) -> dict[str, object]:
    require_non_empty = (
        settings.trading_universe_source == "static"
        or settings.trading_universe_require_non_empty_jangar
    )
    if scheduler is None:
        return {
            "ok": not require_non_empty,
            "detail": "universe state unavailable",
            "source": settings.trading_universe_source,
            "status": None,
            "reason": None,
            "symbols_count": None,
            "cache_age_seconds": None,
            "require_non_empty": require_non_empty,
        }

    state = getattr(scheduler, "state", None)
    if state is None:
        return {
            "ok": True,
            "detail": "universe state unavailable",
            "source": settings.trading_universe_source,
            "status": None,
            "reason": None,
            "symbols_count": None,
            "cache_age_seconds": None,
            "require_non_empty": require_non_empty,
        }

    universe_status = getattr(state, "universe_source_status", None)
    universe_symbols_count = getattr(state, "universe_symbols_count", None)
    if universe_status in {"unknown", "not_evaluated", None} or (
        require_non_empty and not universe_symbols_count
    ):
        _refresh_universe_state_for_readiness(scheduler=scheduler, state=state)

    universe_status = getattr(state, "universe_source_status", None)
    universe_reason = getattr(state, "universe_source_reason", None)
    universe_symbols_count = getattr(state, "universe_symbols_count", None)
    universe_cache_age_seconds = getattr(state, "universe_cache_age_seconds", None)
    universe_fail_safe_blocked = bool(
        getattr(state, "universe_fail_safe_blocked", False)
    )
    max_stale_seconds = max(1, settings.trading_universe_max_stale_seconds)

    if universe_status == "error":
        return {
            "ok": False,
            "detail": f"{settings.trading_universe_source} universe unavailable",
            "source": settings.trading_universe_source,
            "status": universe_status,
            "reason": universe_reason,
            "symbols_count": universe_symbols_count,
            "cache_age_seconds": universe_cache_age_seconds,
            "max_stale_seconds": max_stale_seconds,
            "require_non_empty": require_non_empty,
        }

    if universe_status == "empty" and (universe_fail_safe_blocked or require_non_empty):
        return {
            "ok": False,
            "detail": f"{settings.trading_universe_source} universe empty",
            "source": settings.trading_universe_source,
            "status": universe_status,
            "reason": universe_reason,
            "symbols_count": universe_symbols_count,
            "cache_age_seconds": universe_cache_age_seconds,
            "max_stale_seconds": max_stale_seconds,
            "require_non_empty": require_non_empty,
        }

    if universe_status == "degraded":
        degraded_detail = "jangar stale cache in use"
        if isinstance(universe_reason, str) and "static_fallback" in universe_reason:
            degraded_detail = "jangar static fallback in use"
        return {
            "ok": not universe_fail_safe_blocked,
            "detail": degraded_detail,
            "source": settings.trading_universe_source,
            "status": universe_status,
            "reason": universe_reason,
            "symbols_count": universe_symbols_count,
            "cache_age_seconds": universe_cache_age_seconds,
            "max_stale_seconds": max_stale_seconds,
            "require_non_empty": require_non_empty,
        }

    if universe_status == "ok":
        detail = f"{settings.trading_universe_source} universe fresh"
        if settings.trading_universe_source == "static":
            detail = "static universe loaded"
        return {
            "ok": True,
            "detail": detail,
            "source": settings.trading_universe_source,
            "status": universe_status,
            "reason": universe_reason,
            "symbols_count": universe_symbols_count,
            "cache_age_seconds": universe_cache_age_seconds,
            "max_stale_seconds": max_stale_seconds,
            "require_non_empty": require_non_empty,
        }

    if universe_status in {"unknown", "not_evaluated", None}:
        return {
            "ok": not require_non_empty,
            "detail": "universe not yet evaluated",
            "source": settings.trading_universe_source,
            "status": universe_status,
            "reason": universe_reason,
            "symbols_count": universe_symbols_count,
            "cache_age_seconds": universe_cache_age_seconds,
            "max_stale_seconds": max_stale_seconds,
            "require_non_empty": require_non_empty,
        }

    if universe_fail_safe_blocked:
        return {
            "ok": False,
            "detail": f"jangar universe blocked: {universe_reason}",
            "source": settings.trading_universe_source,
            "status": universe_status,
            "reason": universe_reason,
            "symbols_count": universe_symbols_count,
            "cache_age_seconds": universe_cache_age_seconds,
            "max_stale_seconds": max_stale_seconds,
            "require_non_empty": require_non_empty,
        }

    return {
        "ok": True,
        "detail": f"{settings.trading_universe_source} universe ok",
        "source": settings.trading_universe_source,
        "status": universe_status,
        "reason": universe_reason,
        "symbols_count": universe_symbols_count,
        "cache_age_seconds": universe_cache_age_seconds,
        "max_stale_seconds": max_stale_seconds,
        "require_non_empty": require_non_empty,
    }


def _refresh_universe_state_for_readiness(
    *,
    scheduler: TradingScheduler,
    state: object,
) -> None:
    resolver = _resolve_universe_resolver_for_readiness(scheduler)
    if resolver is None:
        return
    try:
        resolution = resolver.get_resolution()
    except Exception as exc:  # pragma: no cover - defensive readiness surface
        setattr(state, "universe_source_status", "error")
        setattr(
            state,
            "universe_source_reason",
            f"jangar_readiness_probe_failed:{type(exc).__name__}",
        )
        setattr(state, "universe_symbols_count", 0)
        setattr(state, "universe_cache_age_seconds", None)
        setattr(state, "universe_fail_safe_blocked", True)
        setattr(
            state,
            "universe_fail_safe_block_reason",
            f"jangar_readiness_probe_failed:{type(exc).__name__}",
        )
        return

    symbols_count = len(resolution.symbols)
    setattr(state, "universe_source_status", resolution.status)
    setattr(state, "universe_source_reason", resolution.reason)
    setattr(state, "universe_symbols_count", symbols_count)
    setattr(state, "universe_cache_age_seconds", resolution.cache_age_seconds)
    fail_safe_blocked = symbols_count == 0 and (
        settings.trading_universe_source == "static"
        or (
            settings.trading_universe_source == "jangar"
            and settings.trading_universe_require_non_empty_jangar
        )
    )
    setattr(state, "universe_fail_safe_blocked", fail_safe_blocked)
    setattr(
        state,
        "universe_fail_safe_block_reason",
        resolution.reason if fail_safe_blocked else None,
    )
    metrics = getattr(state, "metrics", None)
    if metrics is not None:
        metrics.record_universe_resolution(
            status=resolution.status,
            reason=resolution.reason,
            symbols_count=symbols_count,
            cache_age_seconds=resolution.cache_age_seconds,
        )


def _resolve_universe_resolver_for_readiness(scheduler: TradingScheduler) -> Any | None:
    pipeline = getattr(scheduler, "_pipeline", None)
    pipeline_resolver = getattr(pipeline, "universe_resolver", None)
    if callable(getattr(pipeline_resolver, "get_resolution", None)):
        return pipeline_resolver

    return None


def _execute_readiness_account_scope_query(
    session: Session,
    sql: str,
    *,
    table_names: Sequence[str] | None = None,
) -> list[Mapping[str, object]]:
    statement = text(sql)
    params: dict[str, object] = {}
    if table_names is not None:
        statement = statement.bindparams(bindparam("table_names", expanding=True))
        params["table_names"] = list(table_names)
    return [
        cast(Mapping[str, object], row)
        for row in session.execute(statement, params).mappings().all()
    ]


def _check_account_scope_invariants_bounded(session: Session) -> dict[str, object]:
    """Validate account-scope invariants using bounded catalog reads only.

    SQLAlchemy's generic inspector can reflect PostgreSQL domains while reading
    unique constraints. In production that path can exceed the readiness
    statement timeout before /readyz reaches the actual accounting blockers. This
    helper keeps the same account-scope truth table but queries only the narrow
    pg_catalog/information_schema rows required by the readiness contract.
    """

    session.execute(
        text(f"SET LOCAL statement_timeout = {_ACCOUNT_SCOPE_STATEMENT_TIMEOUT_MS}")
    )
    required_columns: dict[str, tuple[str, list[str]]] = {
        "executions_have_account_label": (
            "executions",
            ["alpaca_account_label"],
        ),
        "trade_decisions_have_account_label": (
            "trade_decisions",
            ["alpaca_account_label"],
        ),
        "trade_cursor_has_account_label": ("trade_cursor", ["account_label"]),
        "execution_order_events_have_account_label": (
            "execution_order_events",
            ["alpaca_account_label"],
        ),
    }
    table_names = sorted(
        {table for table, _columns in required_columns.values()}
        | {"executions", "trade_decisions", "trade_cursor"}
    )

    column_rows = _execute_readiness_account_scope_query(
        session,
        """
        SELECT tbl.relname AS table_name, att.attname AS column_name
        FROM pg_catalog.pg_class tbl
        JOIN pg_catalog.pg_namespace ns ON ns.oid = tbl.relnamespace
        JOIN pg_catalog.pg_attribute att ON att.attrelid = tbl.oid
        WHERE ns.nspname = current_schema()
          AND tbl.relname IN :table_names
          AND tbl.relkind IN ('r', 'p')
          AND att.attnum > 0
          AND NOT att.attisdropped
        """,
        table_names=table_names,
    )
    columns_by_table: dict[str, set[str]] = {}
    for row in column_rows:
        table = str(row["table_name"]).strip().lower()
        column = str(row["column_name"]).strip().lower()
        columns_by_table.setdefault(table, set()).add(column)

    unique_index_rows = _execute_readiness_account_scope_query(
        session,
        """
        SELECT
          tbl.relname AS table_name,
          idx.relname AS index_name,
          array_agg(att.attname ORDER BY ord.ordinality) AS column_names
        FROM pg_catalog.pg_index ix
        JOIN pg_catalog.pg_class idx ON idx.oid = ix.indexrelid
        JOIN pg_catalog.pg_class tbl ON tbl.oid = ix.indrelid
        JOIN pg_catalog.pg_namespace ns ON ns.oid = tbl.relnamespace
        JOIN unnest(ix.indkey) WITH ORDINALITY AS ord(attnum, ordinality) ON true
        JOIN pg_catalog.pg_attribute att
          ON att.attrelid = tbl.oid
         AND att.attnum = ord.attnum
        WHERE ns.nspname = current_schema()
          AND tbl.relname IN :table_names
          AND ix.indisunique
          AND ix.indpred IS NULL
        GROUP BY tbl.relname, idx.relname
        """,
        table_names=table_names,
    )
    unique_indexes_by_table: dict[str, list[tuple[str, set[str]]]] = {}
    for row in unique_index_rows:
        table = str(row["table_name"]).strip().lower()
        index_name = str(row["index_name"]).strip().lower()
        raw_columns = cast(Sequence[object], row["column_names"] or [])
        column_names = {str(column).strip().lower() for column in raw_columns}
        unique_indexes_by_table.setdefault(table, []).append((index_name, column_names))

    all_index_rows = _execute_readiness_account_scope_query(
        session,
        """
        SELECT tbl.relname AS table_name, idx.relname AS index_name
        FROM pg_catalog.pg_index ix
        JOIN pg_catalog.pg_class idx ON idx.oid = ix.indexrelid
        JOIN pg_catalog.pg_class tbl ON tbl.oid = ix.indrelid
        JOIN pg_catalog.pg_namespace ns ON ns.oid = tbl.relnamespace
        WHERE ns.nspname = current_schema()
          AND tbl.relname IN :table_names
          AND tbl.relkind IN ('r', 'p')
          AND idx.relkind IN ('i', 'I')
        """,
        table_names=table_names,
    )
    index_names_by_table: dict[str, list[str]] = {}
    for row in all_index_rows:
        table = str(row["table_name"]).strip().lower()
        index_name = str(row["index_name"]).strip().lower()
        index_names_by_table.setdefault(table, []).append(index_name)

    legacy_constraint_rows = _execute_readiness_account_scope_query(
        session,
        """
        SELECT tbl.relname AS table_name, con.conname AS constraint_name
        FROM pg_catalog.pg_constraint con
        JOIN pg_catalog.pg_class tbl ON tbl.oid = con.conrelid
        JOIN pg_catalog.pg_namespace ns ON ns.oid = tbl.relnamespace
        WHERE ns.nspname = current_schema()
          AND tbl.relname IN :table_names
          AND con.contype = 'u'
        """,
        table_names=table_names,
    )
    legacy_constraints_by_table: dict[str, set[str]] = {}
    for row in legacy_constraint_rows:
        table = str(row["table_name"]).strip().lower()
        constraint_name = str(row["constraint_name"]).strip().lower()
        legacy_constraints_by_table.setdefault(table, set()).add(constraint_name)

    def _has_columns(table: str, columns: Sequence[str]) -> bool:
        available = columns_by_table.get(table, set())
        return all(str(column).strip().lower() in available for column in columns)

    def _has_unique_index(table: str, columns: Sequence[str]) -> bool:
        expected = {str(column).strip().lower() for column in columns}
        return any(
            index_columns == expected
            for _index_name, index_columns in unique_indexes_by_table.get(table, [])
        )

    def _named_unique_constraint_present(table: str, names: set[str]) -> bool:
        normalized_names = {name.strip().lower() for name in names}
        return bool(
            legacy_constraints_by_table.get(table, set()).intersection(normalized_names)
        )

    checks: dict[str, object] = {}
    errors: list[str] = []

    for key, (table, columns) in required_columns.items():
        ok = _has_columns(table, columns)
        checks[key] = ok
        if not ok:
            errors.append(f"{table} missing required columns: {columns}")

    checks["execution_has_account_scoped_unique_order_id"] = _has_unique_index(
        "executions",
        ["alpaca_account_label", "alpaca_order_id"],
    )
    if not checks["execution_has_account_scoped_unique_order_id"]:
        errors.append(
            "executions missing unique index on (alpaca_account_label, alpaca_order_id)"
        )

    checks["execution_has_account_scoped_unique_client_order_id"] = _has_unique_index(
        "executions",
        ["alpaca_account_label", "client_order_id"],
    )
    if not checks["execution_has_account_scoped_unique_client_order_id"]:
        errors.append(
            "executions missing unique index on (alpaca_account_label, client_order_id)"
        )

    checks["trade_decision_has_account_scoped_unique_decision_hash"] = (
        _has_unique_index(
            "trade_decisions",
            ["alpaca_account_label", "decision_hash"],
        )
    )
    if not checks["trade_decision_has_account_scoped_unique_decision_hash"]:
        errors.append(
            "trade_decisions missing unique index on "
            "(alpaca_account_label, decision_hash)"
        )

    checks["trade_cursor_has_account_scoped_source_index"] = _has_unique_index(
        "trade_cursor",
        ["source", "account_label"],
    )
    if not checks["trade_cursor_has_account_scoped_source_index"]:
        errors.append("trade_cursor missing unique index on (source, account_label)")

    checks["legacy_executions_single_account_order_id_index_detected"] = (
        _has_unique_index("executions", ["alpaca_order_id"])
        or _named_unique_constraint_present(
            "executions",
            {"executions_alpaca_order_id_key"},
        )
    )
    if checks["legacy_executions_single_account_order_id_index_detected"]:
        errors.append(
            "legacy unique constraint/index detected for executions.alpaca_order_id"
        )

    checks["legacy_executions_single_account_client_order_id_index_detected"] = (
        _has_unique_index("executions", ["client_order_id"])
        or _named_unique_constraint_present(
            "executions",
            {"executions_client_order_id_key"},
        )
    )
    if checks["legacy_executions_single_account_client_order_id_index_detected"]:
        errors.append(
            "legacy unique constraint/index detected for executions.client_order_id"
        )

    checks["legacy_trade_cursor_source_only_source_index_detected"] = _has_unique_index(
        "trade_cursor", ["source"]
    ) or _named_unique_constraint_present(
        "trade_cursor",
        {"trade_cursor_source_key"},
    )
    if checks["legacy_trade_cursor_source_only_source_index_detected"]:
        errors.append("legacy unique constraint/index detected for trade_cursor.source")

    checks["legacy_executions_single_account_indexes_present"] = (
        checks["legacy_executions_single_account_order_id_index_detected"]
        or checks["legacy_executions_single_account_client_order_id_index_detected"]
    )
    checks["legacy_trade_cursor_source_only_index_present"] = checks[
        "legacy_trade_cursor_source_only_source_index_detected"
    ]
    checks["account_scope_ready"] = not errors
    checks["account_scope_index_names"] = {
        "execution_indexes": sorted(index_names_by_table.get("executions", [])),
        "trade_decision_indexes": sorted(
            index_names_by_table.get("trade_decisions", [])
        ),
        "trade_cursor_indexes": sorted(index_names_by_table.get("trade_cursor", [])),
    }
    checks["account_scope_errors"] = errors
    checks["account_scope_check_mode"] = "bounded_catalog"

    if errors and not settings.trading_multi_account_enabled:
        checks["account_scope_ready"] = True
        checks["account_scope_errors"] = []
    return checks


def _evaluate_database_contract(session: Session) -> dict[str, object]:
    """Collect schema and account-scope readiness checks used by /readyz and /db-check."""
    checked_at = datetime.now(timezone.utc).isoformat()

    try:
        schema_status = check_schema_current(session)
    except SQLAlchemyError as exc:
        return {
            "ok": False,
            "error": f"database unavailable: {exc}",
            "schema_current": False,
            "schema_current_heads": [],
            "expected_heads": [],
            "schema_head_signature": None,
            "checked_at": checked_at,
            "account_scope_ready": False,
            "account_scope_errors": [str(exc)],
        }
    except RuntimeError as exc:
        return {
            "ok": False,
            "error": str(exc),
            "schema_current": False,
            "schema_current_heads": [],
            "expected_heads": [],
            "schema_head_signature": None,
            "checked_at": checked_at,
            "account_scope_ready": False,
            "account_scope_errors": [str(exc)],
        }

    try:
        account_scope_status = _check_account_scope_invariants_bounded(session)
    except (SQLAlchemyError, RuntimeError) as exc:
        account_scope_status = {
            "account_scope_ready": False,
            "account_scope_errors": [str(exc)],
            "account_scope_check_mode": "bounded_catalog",
            "account_scope_check_failed": True,
        }

    account_scope_checks = dict(account_scope_status)
    account_scope_warnings: list[str] = []
    if not settings.trading_multi_account_enabled:
        raw_account_scope_errors = [
            str(error)
            for error in cast(
                list[object],
                account_scope_checks.get("account_scope_errors", []),
            )
        ]
        account_scope_checks["account_scope_ready"] = True
        account_scope_checks["account_scope_errors"] = []
        account_scope_warnings.append(
            "account scope checks are bypassed when trading_multi_account_enabled is false"
        )
        if account_scope_checks.get("account_scope_check_failed"):
            account_scope_checks["account_scope_bypassed_errors"] = (
                raw_account_scope_errors
            )
            account_scope_warnings.append(
                "account scope catalog check failed but is non-blocking while trading_multi_account_enabled is false"
            )

    schema_current = bool(schema_status.get("schema_current"))
    account_scope_ready = bool(account_scope_checks.get("account_scope_ready"))
    schema_graph_roots = [
        str(root)
        for root in cast(list[object], schema_status.get("schema_graph_roots", []))
    ]
    schema_graph_parent_forks = {
        str(parent): sorted(str(child) for child in cast(list[object], children))
        for parent, children in cast(
            Mapping[object, object],
            schema_status.get("schema_graph_parent_forks", {}),
        ).items()
        if isinstance(children, list)
    }
    schema_graph_duplicate_revisions = {
        str(revision): sorted(str(path) for path in cast(list[object], files))
        for revision, files in cast(
            Mapping[object, object],
            schema_status.get("schema_graph_duplicate_revisions", {}),
        ).items()
        if isinstance(files, list)
    }
    schema_graph_orphan_parents = [
        str(parent)
        for parent in cast(
            list[object],
            schema_status.get("schema_graph_orphan_parents", []),
        )
    ]
    schema_graph_branch_tolerance = max(
        0,
        int(settings.trading_db_schema_graph_branch_tolerance),
    )
    schema_graph_allow_divergence_roots = bool(
        settings.trading_db_schema_graph_allow_divergence_roots,
    )

    raw_branch_count = schema_status.get("schema_graph_branch_count")
    schema_graph_branch_count: int
    if isinstance(raw_branch_count, bool):
        schema_graph_branch_count = int(raw_branch_count)
    elif isinstance(raw_branch_count, int):
        schema_graph_branch_count = raw_branch_count
    elif isinstance(raw_branch_count, str):
        try:
            schema_graph_branch_count = int(raw_branch_count)
        except ValueError:
            schema_graph_branch_count = 0
    else:
        schema_graph_branch_count = 0

    schema_graph_lineage_errors: list[str] = []
    schema_graph_lineage_warnings: list[str] = []

    if schema_graph_duplicate_revisions:
        duplicate_summary = ", ".join(sorted(schema_graph_duplicate_revisions))
        schema_graph_lineage_errors.append(
            f"duplicate migration revision identifiers detected: {duplicate_summary}"
        )

    if schema_graph_orphan_parents:
        schema_graph_lineage_errors.append(
            "orphan migration parents detected: "
            + ", ".join(schema_graph_orphan_parents)
        )

    if schema_graph_parent_forks:
        parent_summary = ", ".join(
            f"{parent} -> [{', '.join(children)}]"
            for parent, children in sorted(schema_graph_parent_forks.items())
        )
        schema_graph_lineage_warnings.append(
            f"migration parent forks detected: {parent_summary}"
        )

    if schema_graph_branch_count > schema_graph_branch_tolerance:
        divergence_message = (
            "migration graph branch count "
            f"{schema_graph_branch_count} exceeds tolerance {schema_graph_branch_tolerance}"
        )
        if schema_graph_allow_divergence_roots:
            schema_graph_lineage_warnings.append(
                divergence_message
                + "; allowed by TRADING_DB_SCHEMA_GRAPH_ALLOW_DIVERGENCE_ROOTS=true"
            )
        else:
            schema_graph_lineage_errors.append(
                divergence_message
                + "; set TRADING_DB_SCHEMA_GRAPH_ALLOW_DIVERGENCE_ROOTS=true for temporary override"
            )

    schema_graph_lineage_ready = len(schema_graph_lineage_errors) == 0
    return {
        "ok": schema_current and account_scope_ready and schema_graph_lineage_ready,
        "schema_current": schema_current,
        "schema_current_heads": schema_status.get("current_heads", []),
        "expected_heads": schema_status.get("expected_heads", []),
        "schema_missing_heads": schema_status.get("schema_missing_heads", []),
        "schema_unexpected_heads": schema_status.get("schema_unexpected_heads", []),
        "schema_head_count_expected": schema_status.get("schema_head_count_expected"),
        "schema_head_count_current": schema_status.get("schema_head_count_current"),
        "schema_head_delta_count": schema_status.get("schema_head_delta_count"),
        "schema_head_signature": schema_status.get(
            "expected_heads_signature",
            schema_status.get("schema_head_signature"),
        ),
        "schema_graph_signature": schema_status.get("schema_graph_signature"),
        "schema_graph_roots": schema_graph_roots,
        "schema_graph_branch_count": schema_graph_branch_count,
        "schema_graph_parent_forks": schema_graph_parent_forks,
        "schema_graph_duplicate_revisions": schema_graph_duplicate_revisions,
        "schema_graph_orphan_parents": schema_graph_orphan_parents,
        "schema_graph_branch_tolerance": schema_graph_branch_tolerance,
        "schema_graph_allow_divergence_roots": schema_graph_allow_divergence_roots,
        "schema_graph_lineage_ready": schema_graph_lineage_ready,
        "schema_graph_lineage_errors": schema_graph_lineage_errors,
        "schema_graph_lineage_warnings": schema_graph_lineage_warnings,
        "checked_at": checked_at,
        "account_scope_ready": account_scope_ready,
        "account_scope_errors": account_scope_checks.get("account_scope_errors", []),
        "account_scope_warnings": account_scope_warnings,
    }


__all__ = [
    "_readiness_dependency_cache_key",
    "_readiness_dependency_checks",
    "_readiness_dependency_snapshot",
    "_readiness_authority_truthy",
    "_append_unique_reason",
    "_readiness_dependency_degradation_reason_codes",
    "_guard_live_submission_gate_for_readiness",
    "_strip_promotion_authority_claims_for_readiness",
    "_core_readiness_live_submission_gate",
    "_evaluate_core_readiness_payload",
    "_trading_health_surface_cache_key",
    "_cache_completed_trading_health_surface_payload",
    "_record_trading_health_surface_completion",
    "_cached_trading_health_surface_payload",
    "_cached_readiness_dependencies_for_health_surface",
    "_fail_closed_health_evaluation_gate",
    "_health_surface_timeout_dependency_placeholder",
    "_minimal_health_surface_timeout_live_submission_gate",
    "_minimal_health_surface_timeout_proof_floor",
    "_minimal_health_surface_timeout_payload",
    "_health_surface_timeout_fallback_payload",
    "_evaluate_trading_health_payload_bounded",
    "_evaluate_trading_health_payload",
    "_evaluate_universe_dependency",
    "_refresh_universe_state_for_readiness",
    "_resolve_universe_resolver_for_readiness",
    "_execute_readiness_account_scope_query",
    "_check_account_scope_invariants_bounded",
    "_evaluate_database_contract",
]
capture_module_exports(globals(), __all__)
