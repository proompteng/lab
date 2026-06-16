# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Extracted Torghut API route and support functions."""

# ruff: noqa: F401,F403,F405,F811,F821
from __future__ import annotations

from fastapi import APIRouter
from typing import Any, TYPE_CHECKING

# ruff: noqa: F401,F403,F405,F821,F821,F821


if TYPE_CHECKING:
    pass

from ..common import (
    BLOCKER_RECONCILIATION_STALE,
    BUILD_ARGO_HEALTH,
    BUILD_ARGO_SYNC_REVISION,
    BUILD_COMMIT,
    BUILD_IMAGE_DIGEST,
    BUILD_MANIFEST_COMMIT,
    BUILD_MANIFEST_IMAGE_DIGEST,
    BUILD_SOURCE_CI_REF,
    BUILD_VERSION,
    Body,
    CONSUMER_EVIDENCE_CONTROL_PLANE_DEPENDENCY_MESSAGE,
    ClickHouseSignalIngestor,
    DEFAULT_PAPER_ROUTE_EVIDENCE_LOOKBACK_HOURS,
    DEFAULT_PAPER_ROUTE_EVIDENCE_TARGET_LIMIT,
    Decimal,
    Depends,
    EvidenceEpoch,
    EvidenceReceipt,
    Execution,
    ExecutionTCAMetric,
    FastAPI,
    FeatureQualityThresholds,
    Future,
    HTTPConnection,
    HTTPException,
    HTTPSConnection,
    JSONResponse,
    JangarDependencyQuorumStatus,
    LEAN_LANE_MANAGER,
    LeanLaneManager,
    Lock,
    MAX_PAPER_ROUTE_EVIDENCE_LOOKBACK_HOURS,
    MAX_PAPER_ROUTE_EVIDENCE_TARGET_LIMIT,
    Mapping,
    OperationalError,
    PAPER_ROUTE_RUNTIME_ACCOUNT_LABEL,
    PROFITABILITY_PROOF_FLOOR_TCA_MAX_AGE_SECONDS,
    Path,
    ProofKind,
    ProofWindowSelector,
    Query,
    RUNTIME_PROFITABILITY_LOOKBACK_HOURS,
    RUNTIME_PROFITABILITY_SCHEMA_VERSION,
    RejectedSignalOutcomeEvent,
    Request,
    Response,
    SQLAlchemyError,
    Sequence,
    Session,
    SessionLocal,
    SignalEnvelope,
    Strategy,
    StrategyRuntimeLedgerBucket,
    ThreadPoolExecutor,
    TimeoutError,
    TorghutAlpacaClient,
    TradeDecision,
    TradingScheduler,
    VNextDatasetSnapshot,
    VNextExperimentRun,
    VNextExperimentSpec,
    VNextFeatureViewSpec,
    VNextModelArtifact,
    VNextPromotionDecision,
    VNextShadowLiveDeviation,
    VNextSimulationCalibration,
    WHITEPAPER_WORKFLOW,
    WhitepaperAnalysisRun,
    WhitepaperCodexAgentRun,
    WhitepaperDesignPullRequest,
    WhitepaperEngineeringTrigger,
    WhitepaperKafkaWorker,
    WhitepaperRolloutTransition,
    WhitepaperWorkflowService,
    _ACCOUNT_SCOPE_STATEMENT_TIMEOUT_MS,
    _ALPACA_HEALTH_CACHE_LOCK,
    _ALPACA_HEALTH_STATE,
    _OPTIONS_CATALOG_FRESHNESS_CACHE,
    _OPTIONS_CATALOG_FRESHNESS_CACHE_LOCK,
    _PAPER_ROUTE_BOUNDED_COLLECTION_ACCOUNT_LABEL,
    _PAPER_ROUTE_TARGET_PLAN_STALE_SUCCESS_SECONDS,
    _PAPER_ROUTE_TARGET_PLAN_SUCCESS_CACHE_LOCK,
    _READINESS_PROMOTION_AUTHORITY_KEYS,
    _RETRYABLE_TCA_RECOMPUTE_SQLSTATES,
    _SIMPLE_LANE_ALLOWED_REJECT_REASONS,
    _TRADING_DEPENDENCY_HEALTH_CACHE,
    _TRADING_DEPENDENCY_HEALTH_CACHE_LOCK,
    _TRADING_HEALTH_SURFACE_EVALUATIONS,
    _TRADING_HEALTH_SURFACE_EVALUATION_EXECUTOR,
    _TRADING_HEALTH_SURFACE_EVALUATION_LOCK,
    _TRADING_HEALTH_SURFACE_PAYLOAD_CACHE,
    _TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS,
    _TRADING_STATUS_READ_BUDGET_SECONDS,
    _ZERO_NOTIONAL_TCA_RECOMPUTE_MAX_ATTEMPTS,
    _paper_route_target_plan_success_cache,
    _retryable_tca_recompute_error,
    _shared_mapping_items,
    _shared_paper_route_target_plan_from_payload,
    active_simulation_runtime_context,
    assert_runtime_gate_policy_contract,
    asynccontextmanager,
    autoresearch_router,
    bindparam,
    build_alpha_closure_dividend_slo,
    build_artifact_parity_receipt,
    build_capital_reentry_cohort_ledger,
    build_capital_replay_projection,
    build_clock_settlement_receipt,
    build_data_freshness_receipt,
    build_doc29_completion_status,
    build_empirical_jobs_receipt,
    build_empirical_jobs_status,
    build_evidence_clock_arbiter_and_exchange,
    build_freshness_carry_ledger,
    build_hypothesis_runtime_summary,
    build_jangar_authority_receipt,
    build_live_submission_gate_payload,
    build_llm_evaluation_metrics,
    build_portfolio_proof_receipt,
    build_profit_carry_passport_ledger,
    build_profit_freshness_frontier,
    build_profit_repair_settlement_ledger,
    build_profit_signal_quorum,
    build_profitability_proof_floor_receipt,
    build_proofs_payload,
    build_quality_adjusted_profit_frontier,
    build_renewal_bond_profit_escrow,
    build_repair_bid_settlement_ledger,
    build_repair_outcome_dividend_ledger,
    build_repair_receipt_frontier,
    build_revenue_repair_digest,
    build_route_evidence_clearinghouse_packet,
    build_route_proven_profit_receipt,
    build_route_reacquisition_board,
    build_route_warrant_exchange,
    build_routeability_repair_acceptance_ledger,
    build_runtime_ledger_profit_distance_readback,
    build_schema_receipt,
    build_service_health_receipt,
    build_shadow_first_toggle_parity,
    build_source_serving_repair_receipt_ledger,
    build_tca_gate_inputs,
    build_torghut_consumer_evidence_receipt,
    capture_posthog_event,
    cast,
    check_schema_current,
    check_tigerbeetle_health,
    compact_alpha_evidence_foundry,
    compact_alpha_readiness_settlement_conveyor,
    compact_alpha_repair_closure_board,
    compact_alpha_repair_dividend_ledger,
    compact_executable_alpha_settlement_slots,
    compact_jangar_controller_ingestion_carry,
    compact_no_delta_repair_reentry_auction,
    compile_evidence_epoch,
    cost_basis_counts_have_non_promotion_grade_costs,
    datetime,
    deepcopy,
    ensure_schema,
    evaluate_evidence_continuity,
    evaluate_feature_batch_quality,
    forecast_status_from_empirical_jobs,
    func,
    get_session,
    hypothesis_registry_requires_dependency_capability,
    inngest,
    inngest_fastapi_serve,
    json,
    jsonable_encoder,
    latest_tigerbeetle_reconciliation_payload,
    latest_tigerbeetle_reconciliation_status_payload,
    lean_authority_status,
    load_evidence_epoch_payload,
    load_hypothesis_registry,
    load_jangar_dependency_quorum,
    load_jangar_route_continuity_packet,
    load_latest_evidence_epoch_payload,
    load_quant_evidence_status,
    logger,
    logging,
    os,
    persist_evidence_epoch,
    ping,
    refresh_execution_tca_metrics,
    render_trading_metrics,
    resolve_active_capital_stage,
    resolve_hypothesis_dependency_quorum,
    run_zero_notional_repair,
    runtime_ledger_promotion_source_authority_blockers,
    select,
    settings,
    shutdown_posthog_telemetry,
    simulation_progress_snapshot,
    sys,
    text,
    tigerbeetle_ref_counts,
    time,
    timedelta,
    timezone,
    trading_time_status,
    urlencode,
    urlsplit,
    validate_hypothesis_registry_from_settings,
    whitepaper_inngest_enabled,
    whitepaper_kafka_enabled,
    whitepaper_semantic_indexing_enabled,
    whitepaper_workflow_enabled,
)

from ..common import main_runtime_value

from ..proxy import capture_module_exports


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


__all__ = [name for name in globals() if not name.startswith("__")]
