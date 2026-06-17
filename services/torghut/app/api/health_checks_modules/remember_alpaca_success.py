# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Extracted Torghut API route and support functions."""

# ruff: noqa: F401,F811,F821
from __future__ import annotations

from fastapi import APIRouter
from typing import Any, TYPE_CHECKING

# ruff: noqa: F401,F821,F821,F821

from .shared_context import (
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
    ACCOUNT_SCOPE_STATEMENT_TIMEOUT_MS as _ACCOUNT_SCOPE_STATEMENT_TIMEOUT_MS,
    ALPACA_HEALTH_CACHE_LOCK as _ALPACA_HEALTH_CACHE_LOCK,
    ALPACA_HEALTH_STATE as _ALPACA_HEALTH_STATE,
    OPTIONS_CATALOG_FRESHNESS_CACHE as _OPTIONS_CATALOG_FRESHNESS_CACHE,
    OPTIONS_CATALOG_FRESHNESS_CACHE_LOCK as _OPTIONS_CATALOG_FRESHNESS_CACHE_LOCK,
    PAPER_ROUTE_BOUNDED_COLLECTION_ACCOUNT_LABEL as _PAPER_ROUTE_BOUNDED_COLLECTION_ACCOUNT_LABEL,
    PAPER_ROUTE_TARGET_PLAN_STALE_SUCCESS_SECONDS as _PAPER_ROUTE_TARGET_PLAN_STALE_SUCCESS_SECONDS,
    PAPER_ROUTE_TARGET_PLAN_SUCCESS_CACHE_LOCK as _PAPER_ROUTE_TARGET_PLAN_SUCCESS_CACHE_LOCK,
    READINESS_PROMOTION_AUTHORITY_KEYS as _READINESS_PROMOTION_AUTHORITY_KEYS,
    RETRYABLE_TCA_RECOMPUTE_SQLSTATES as _RETRYABLE_TCA_RECOMPUTE_SQLSTATES,
    SIMPLE_LANE_ALLOWED_REJECT_REASONS as _SIMPLE_LANE_ALLOWED_REJECT_REASONS,
    TRADING_DEPENDENCY_HEALTH_CACHE as _TRADING_DEPENDENCY_HEALTH_CACHE,
    TRADING_DEPENDENCY_HEALTH_CACHE_LOCK as _TRADING_DEPENDENCY_HEALTH_CACHE_LOCK,
    TRADING_HEALTH_SURFACE_EVALUATIONS as _TRADING_HEALTH_SURFACE_EVALUATIONS,
    TRADING_HEALTH_SURFACE_EVALUATION_EXECUTOR as _TRADING_HEALTH_SURFACE_EVALUATION_EXECUTOR,
    TRADING_HEALTH_SURFACE_EVALUATION_LOCK as _TRADING_HEALTH_SURFACE_EVALUATION_LOCK,
    TRADING_HEALTH_SURFACE_PAYLOAD_CACHE as _TRADING_HEALTH_SURFACE_PAYLOAD_CACHE,
    TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS as _TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS,
    TRADING_STATUS_READ_BUDGET_SECONDS as _TRADING_STATUS_READ_BUDGET_SECONDS,
    ZERO_NOTIONAL_TCA_RECOMPUTE_MAX_ATTEMPTS as _ZERO_NOTIONAL_TCA_RECOMPUTE_MAX_ATTEMPTS,
    active_runtime_revision as _active_runtime_revision,
    alpaca_endpoint_class as _alpaca_endpoint_class,
    alpaca_failure_status as _alpaca_failure_status,
    alpaca_probe_account as _alpaca_probe_account,
    build_control_plane_contract as _build_control_plane_contract,
    build_shadow_first_runtime_payload as _build_shadow_first_runtime_payload,
    build_shadow_first_toggle_parity as _build_shadow_first_toggle_parity,
    build_tigerbeetle_ledger_status as _build_tigerbeetle_ledger_status,
    check_clickhouse as _check_clickhouse,
    check_postgres as _check_postgres,
    check_tigerbeetle_protocol_health as _check_tigerbeetle_protocol_health,
    empirical_jobs_status as _empirical_jobs_status,
    empty_tigerbeetle_ref_counts as _empty_tigerbeetle_ref_counts,
    forecast_service_status as _forecast_service_status,
    latest_reconciliation_ref_counts as _latest_reconciliation_ref_counts,
    lean_authority_status as _lean_authority_status,
    paper_route_target_plan_success_cache as _paper_route_target_plan_success_cache,
    resolve_active_capital_stage as _resolve_active_capital_stage,
    retryable_tca_recompute_error as _retryable_tca_recompute_error,
    shared_mapping_items as _shared_mapping_items,
    shared_paper_route_target_plan_from_payload as _shared_paper_route_target_plan_from_payload,
    tigerbeetle_status_int as _tigerbeetle_status_int,
    unavailable_tigerbeetle_reconciliation_payload as _unavailable_tigerbeetle_reconciliation_payload,
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
    capture_module_exports,
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
    main_runtime_value,
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


def _rollback_status_read_session(session: Session, *, context: str) -> None:
    from ..status_helpers import rollback_status_read_session as rollback

    rollback(session, context=context)


def _apply_status_read_statement_timeout(
    session: Session,
    *,
    milliseconds: int,
) -> None:
    from ..status_helpers import (
        apply_status_read_statement_timeout as apply_statement_timeout,
    )

    apply_statement_timeout(session, milliseconds=milliseconds)


def _ensure_utc_datetime(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _resolve_tca_scope_symbols(
    scheduler: TradingScheduler | None,
) -> tuple[str, ...] | None:
    if scheduler is None:
        return None
    from ..readiness_helpers import resolve_universe_resolver_for_readiness

    resolver = resolve_universe_resolver_for_readiness(scheduler)
    if resolver is None:
        return None
    try:
        resolution = resolver.get_resolution()
    except Exception:  # pragma: no cover - diagnostic scope should not break routes
        logger.exception("Failed to resolve universe symbols for TCA scope")
        return None
    raw_symbols = getattr(resolution, "symbols", None)
    if not isinstance(raw_symbols, set):
        return None
    raw_symbol_set = cast(set[object], raw_symbols)
    symbols = tuple(
        sorted(
            {
                str(symbol).strip().upper()
                for symbol in raw_symbol_set
                if str(symbol).strip()
            }
        )
    )
    return symbols or None


def _budget_unavailable_tca_summary_payload(reason: str) -> dict[str, object]:
    from ..status_helpers import (
        budget_unavailable_tca_summary_payload as unavailable_payload,
    )

    return unavailable_payload(reason)


def _remember_alpaca_success(
    *,
    account: Mapping[str, Any],
    endpoint_class: str,
) -> None:
    with _ALPACA_HEALTH_CACHE_LOCK:
        _ALPACA_HEALTH_STATE.clear()
        _ALPACA_HEALTH_STATE.update(
            {
                "last_ok_at": datetime.now(timezone.utc),
                "account_label": str(
                    account.get("account_number")
                    or settings.trading_account_label
                    or ""
                ).strip()
                or None,
                "account_status": str(account.get("status") or "").strip() or None,
                "endpoint_class": endpoint_class,
            }
        )


def _alpaca_cached_last_good(
    *,
    failure_status: str,
    failure_detail: str,
    endpoint_class: str,
) -> dict[str, object] | None:
    if failure_status not in {"broker_slow", "network_unreachable"}:
        return None
    ttl_seconds = max(0, settings.trading_alpaca_healthcheck_last_good_ttl_seconds)
    if ttl_seconds <= 0:
        return None
    with _ALPACA_HEALTH_CACHE_LOCK:
        last_ok_at = cast(datetime | None, _ALPACA_HEALTH_STATE.get("last_ok_at"))
        account_label = cast(str | None, _ALPACA_HEALTH_STATE.get("account_label"))
        account_status = cast(str | None, _ALPACA_HEALTH_STATE.get("account_status"))
        cached_endpoint_class = cast(
            str | None,
            _ALPACA_HEALTH_STATE.get("endpoint_class"),
        )
    if last_ok_at is None:
        return None
    age_seconds = max(
        0.0,
        round((datetime.now(timezone.utc) - last_ok_at).total_seconds(), 3),
    )
    if age_seconds > ttl_seconds:
        return None
    return {
        "ok": True,
        "detail": (
            f"{failure_detail}; using cached last known good Alpaca probe from "
            f"{last_ok_at.isoformat()}"
        ),
        "broker_status": failure_status,
        "endpoint_class": cached_endpoint_class or endpoint_class,
        "cache_used": True,
        "last_ok_at": last_ok_at.isoformat(),
        "cache_age_seconds": age_seconds,
        "account_label": account_label,
        "account_status": account_status,
    }


def _check_alpaca() -> dict[str, object]:
    if not settings.apca_api_key_id or not settings.apca_api_secret_key:
        return {
            "ok": False,
            "detail": "alpaca keys missing",
            "broker_status": "credentials_missing",
            "endpoint_class": _alpaca_endpoint_class(),
            "cache_used": False,
        }
    client = TorghutAlpacaClient()
    timeout_seconds = max(0.1, settings.trading_alpaca_healthcheck_timeout_seconds)
    retries = max(1, settings.trading_alpaca_healthcheck_retries)
    backoff_seconds = max(0.0, settings.trading_alpaca_healthcheck_backoff_seconds)
    endpoint_class = (
        str(getattr(client, "endpoint_class", _alpaca_endpoint_class())).strip()
        or _alpaca_endpoint_class()
    )

    last_failure: dict[str, object] | None = None
    for attempt in range(retries):
        probe = _alpaca_probe_account(client, timeout_seconds=timeout_seconds)
        if bool(probe.get("ok")):
            account = cast(Mapping[str, Any], probe.get("account") or {})
            _remember_alpaca_success(
                account=account,
                endpoint_class=endpoint_class,
            )
            return {
                "ok": True,
                "detail": "ok",
                "broker_status": "broker_ok",
                "endpoint_class": endpoint_class,
                "cache_used": False,
                "account_label": str(
                    account.get("account_number")
                    or settings.trading_account_label
                    or ""
                ).strip()
                or None,
                "account_status": str(account.get("status") or "").strip() or None,
            }
        last_failure = probe
        if probe.get("status") == "credentials_invalid":
            break
        if attempt < retries - 1 and backoff_seconds > 0:
            time.sleep(backoff_seconds * float(attempt + 1))

    failure_status = str(last_failure.get("status") if last_failure else "broker_error")
    failure_detail = str(
        last_failure.get("detail") if last_failure else "alpaca probe failed"
    )
    cached = _alpaca_cached_last_good(
        failure_status=failure_status,
        failure_detail=failure_detail,
        endpoint_class=endpoint_class,
    )
    if cached is not None:
        return cached
    return {
        "ok": False,
        "detail": failure_detail,
        "broker_status": failure_status,
        "endpoint_class": endpoint_class,
        "cache_used": False,
    }


def _tca_row_payload(row: ExecutionTCAMetric | None) -> dict[str, object] | None:
    if row is None:
        return None
    return {
        "arrival_price": row.arrival_price,
        "avg_fill_price": row.avg_fill_price,
        "slippage_bps": row.slippage_bps,
        "shortfall_notional": row.shortfall_notional,
        "expected_shortfall_bps_p50": row.expected_shortfall_bps_p50,
        "expected_shortfall_bps_p95": row.expected_shortfall_bps_p95,
        "realized_shortfall_bps": row.realized_shortfall_bps,
        "divergence_bps": row.divergence_bps,
        "simulator_version": row.simulator_version,
        "churn_qty": row.churn_qty,
        "churn_ratio": row.churn_ratio,
        "computed_at": row.computed_at,
    }


def _load_tca_summary(
    session: Session,
    *,
    scheduler: TradingScheduler | None = None,
) -> dict[str, object]:
    try:
        _apply_status_read_statement_timeout(session, milliseconds=750)
        return build_tca_gate_inputs(
            session=session,
            account_label=settings.trading_account_label,
            symbols=_resolve_tca_scope_symbols(scheduler),
        )
    except SQLAlchemyError as exc:
        logger.warning("Execution TCA status summary unavailable: %s", exc)
        _rollback_status_read_session(session, context="execution TCA summary")
        reason = (
            "execution_tca_summary_query_timeout"
            if _sqlalchemy_error_indicates_statement_timeout(exc)
            else "execution_tca_summary_unavailable"
        )
        return _budget_unavailable_tca_summary_payload(reason)


def _load_clickhouse_ta_status(
    scheduler: TradingScheduler | None = None,
) -> dict[str, object]:
    pipeline = getattr(scheduler, "_pipeline", None) if scheduler is not None else None
    ingestor = getattr(pipeline, "ingestor", None)
    if isinstance(ingestor, ClickHouseSignalIngestor):
        return ingestor.latest_signal_status()
    return ClickHouseSignalIngestor(
        account_label=settings.trading_account_label
    ).latest_signal_status()


def _budget_exhausted_live_submission_gate_payload(
    *,
    reason: str,
    empirical_jobs_status: Mapping[str, Any],
    quant_health_status: Mapping[str, Any],
) -> dict[str, object]:
    simple_lane_blockers = [reason]
    if settings.trading_pipeline_mode == "simple":
        if not settings.trading_simple_submit_enabled:
            simple_lane_blockers.append("simple_submit_disabled")
    return {
        "allowed": False,
        "reason": reason,
        "blocked_reasons": list(dict.fromkeys(simple_lane_blockers)),
        "reason_codes": [reason],
        "read_model_unavailable": True,
        "read_model_status": "timeout",
        "capital_stage": "shadow",
        "active_capital_stage": "shadow",
        "capital_state": "observe",
        "configured_live_promotion": bool(
            settings.trading_autonomy_allow_live_promotion
        ),
        "autonomy_promotion_eligible": False,
        "autonomy_promotion_action": None,
        "drift_live_promotion_eligible": False,
        "promotion_eligible_total": 0,
        "paper_probation_eligible_total": 0,
        "dependency_quorum_decision": "unknown",
        "continuity_ok": False,
        "continuity_reason": reason,
        "drift_ok": False,
        "drift_reason": reason,
        "empirical_jobs_ready": empirical_jobs_status.get("ready"),
        "dspy_live_ready": None,
        "critical_toggle_parity": _build_shadow_first_toggle_parity(),
        "critical_toggle_parity_blocking_mismatches": [],
        "quant_evidence": dict(quant_health_status),
        "quant_health_ref": {
            "account": quant_health_status.get("account"),
            "window": quant_health_status.get("window"),
            "status": quant_health_status.get("status"),
            "source_url": quant_health_status.get("source_url"),
        },
        "segment_summary": {
            "state": "blocked",
            "reason_codes": [reason],
            "read_model_unavailable": True,
        },
        "lineage_ref": {
            "source": "trading_status",
            "status": "unavailable",
            "reason_codes": [reason],
            "read_model_unavailable": True,
        },
        "evaluated_tuples": [],
        "runtime_ledger_repair_candidates": [],
        "runtime_ledger_paper_probation_candidates": [],
        "runtime_ledger_source_collection_candidates": [],
        "runtime_ledger_source_collection_candidate_total": 0,
        "runtime_ledger_paper_probation_eligible_total": 0,
        "runtime_ledger_paper_probation_import_plan": {
            "state": "unavailable",
            "reason_codes": [reason],
            "read_model_unavailable": True,
        },
        "profit_window_contract": {
            "state": "blocked",
            "reason_codes": [reason],
            "read_model_unavailable": True,
        },
        "profit_lease_projection": {
            "state": "blocked",
            "blocking_reason_codes": [reason],
            "read_model_unavailable": True,
        },
        "pipeline_mode": settings.trading_pipeline_mode,
        "simple_lane": {
            "submit_enabled": settings.trading_simple_submit_enabled,
            "shared_gate_enforced": True,
            "blocked_reasons": simple_lane_blockers,
        },
    }


def _budget_exhausted_options_catalog_freshness_payload(
    *,
    reason: str,
    route_symbols: Sequence[str],
) -> dict[str, object]:
    scoped_symbols = tuple(
        sorted(
            {
                str(symbol).strip().upper()
                for symbol in route_symbols
                if str(symbol).strip()
            }
        )
    )
    return {
        "status": "unavailable",
        "scope": "route_symbols" if scoped_symbols else "global",
        "route_symbols": list(scoped_symbols),
        "reason_codes": [reason],
        "read_model_unavailable": True,
    }


def _route_claim_symbols(profit_signal_quorum: Mapping[str, Any]) -> tuple[str, ...]:
    raw_quorums = profit_signal_quorum.get("quorums")
    if not isinstance(raw_quorums, Sequence) or isinstance(
        raw_quorums, (str, bytes, bytearray)
    ):
        return ()
    symbols: set[str] = set()

    def add_symbols(raw_symbols: object) -> None:
        if not isinstance(raw_symbols, Sequence) or isinstance(
            raw_symbols, (str, bytes, bytearray)
        ):
            return
        for raw_symbol in cast(Sequence[object], raw_symbols):
            symbol = str(raw_symbol or "").strip().upper()
            if symbol:
                symbols.add(symbol)

    for raw_quorum_item in cast(Sequence[object], raw_quorums):
        if not isinstance(raw_quorum_item, Mapping):
            continue
        raw_quorum = cast(Mapping[str, Any], raw_quorum_item)
        add_symbols(raw_quorum.get("symbols"))
        raw_signal = raw_quorum.get("route_tca_signal")
        if not isinstance(raw_signal, Mapping):
            continue
        route_tca_signal = cast(Mapping[str, Any], raw_signal)
        raw_details = route_tca_signal.get("details")
        if not isinstance(raw_details, Mapping):
            continue
        details = cast(Mapping[str, Any], raw_details)
        add_symbols(details.get("symbols"))
        raw_nested_details = details.get("details")
        if isinstance(raw_nested_details, Mapping):
            add_symbols(cast(Mapping[str, Any], raw_nested_details).get("symbols"))
    return tuple(sorted(symbols))


def _load_cached_options_catalog_freshness_summary(
    cache_key: tuple[str, ...],
) -> dict[str, object] | None:
    ttl_seconds = max(0, settings.trading_options_catalog_freshness_cache_seconds)
    if ttl_seconds <= 0:
        return None
    now = datetime.now(timezone.utc)
    with _OPTIONS_CATALOG_FRESHNESS_CACHE_LOCK:
        cache_entry = _OPTIONS_CATALOG_FRESHNESS_CACHE.get(cache_key)
        if cache_entry is None:
            return None
        cached_at, cached_payload = cache_entry
        age_seconds = (now - cached_at).total_seconds()
        if age_seconds >= ttl_seconds:
            _OPTIONS_CATALOG_FRESHNESS_CACHE.pop(cache_key, None)
            return None
    payload = deepcopy(cached_payload)
    payload["cache"] = {
        "hit": True,
        "cached_at": cached_at,
        "age_seconds": age_seconds,
        "ttl_seconds": ttl_seconds,
    }
    return payload


def _store_options_catalog_freshness_summary(
    cache_key: tuple[str, ...],
    payload: dict[str, object],
) -> dict[str, object]:
    ttl_seconds = max(0, settings.trading_options_catalog_freshness_cache_seconds)
    if ttl_seconds <= 0:
        return payload
    cached_at = datetime.now(timezone.utc)
    cache_payload = deepcopy(payload)
    cache_payload.pop("cache", None)
    with _OPTIONS_CATALOG_FRESHNESS_CACHE_LOCK:
        _OPTIONS_CATALOG_FRESHNESS_CACHE[cache_key] = (cached_at, cache_payload)
    payload = deepcopy(cache_payload)
    payload["cache"] = {
        "hit": False,
        "cached_at": cached_at,
        "age_seconds": 0.0,
        "ttl_seconds": ttl_seconds,
    }
    return payload


def _decimal_or_none(value: object) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except Exception:
        return None


def _sqlalchemy_error_indicates_statement_timeout(exc: SQLAlchemyError) -> bool:
    message = str(exc).lower()
    return (
        "statement timeout" in message
        or "querycanceled" in message
        or "query canceled" in message
    )


def _load_bounded_options_catalog_freshness_summary(
    session: Session,
    scoped_symbols: tuple[str, ...],
    *,
    reason: str,
    reason_codes: list[str] | None = None,
) -> dict[str, object] | None:
    if not scoped_symbols:
        return None
    fallback_reason_codes = reason_codes if reason_codes is not None else [reason]
    if reason not in fallback_reason_codes:
        fallback_reason_codes.append(reason)
    rows: list[Mapping[str, object]] = []
    bounded_query = text(
        """
SELECT
  underlying_symbol,
  last_seen_ts,
  provider_updated_ts,
  close_price,
  open_interest
FROM torghut_options_contract_catalog
WHERE underlying_symbol = :route_symbol
  AND status = 'active'
LIMIT 1
"""
    )
    try:
        session.execute(text("SET LOCAL statement_timeout = 500"))
        for symbol in scoped_symbols:
            row = (
                session.execute(
                    bounded_query,
                    {"route_symbol": symbol},
                )
                .mappings()
                .first()
            )
            if row is not None:
                rows.append(cast(Mapping[str, object], row))
    except SQLAlchemyError as bounded_exc:
        logger.warning(
            "Options catalog bounded freshness fallback unavailable: %s",
            bounded_exc,
        )
        fallback_reason_codes.append(
            "options_catalog_freshness_bounded_route_scope_timeout"
            if _sqlalchemy_error_indicates_statement_timeout(bounded_exc)
            else "options_catalog_freshness_bounded_route_scope_unavailable"
        )
        return None

    route_symbol_freshness: dict[str, dict[str, object]] = {}
    for row in rows:
        symbol = str(row.get("underlying_symbol") or "").strip().upper()
        if not symbol:
            continue
        route_symbol_freshness[symbol] = {
            "status": "current",
            "active_contracts": 1,
            "active_contracts_exact": False,
            "coverage_exact": False,
            "bounded": True,
            "newest_last_seen_ts": _ensure_utc_datetime(
                cast(datetime | None, row.get("last_seen_ts"))
            ),
            "missing_provider_updated_ts_count": 1,
            "provider_updated_ts_present": False,
            "newest_provider_updated_ts": _ensure_utc_datetime(
                cast(datetime | None, row.get("provider_updated_ts"))
            ),
            "missing_close_price_count": 1 if row.get("close_price") is None else 0,
            "zero_open_interest_count": 1
            if (_decimal_or_none(row.get("open_interest")) or Decimal("0")) <= 0
            else 0,
            "reason_codes": [
                "options_catalog_freshness_bounded_route_scope",
                *fallback_reason_codes,
            ],
        }

    newest_last_seen_values = [
        value
        for value in (
            _ensure_utc_datetime(cast(datetime | None, row.get("last_seen_ts")))
            for row in rows
        )
        if value is not None
    ]
    newest_provider_updated_values = [
        value
        for value in (
            _ensure_utc_datetime(cast(datetime | None, row.get("provider_updated_ts")))
            for row in rows
        )
        if value is not None
    ]
    active_contracts = len(rows)
    return {
        "status": "current" if active_contracts > 0 else "missing",
        "scope": "route_symbols",
        "bounded": True,
        "coverage_exact": False,
        "active_contracts_exact": False,
        "active_contracts": active_contracts,
        "newest_last_seen_ts": max(newest_last_seen_values)
        if newest_last_seen_values
        else None,
        "missing_provider_updated_ts_count": active_contracts,
        "provider_updated_ts_present": False,
        "newest_provider_updated_ts": max(newest_provider_updated_values)
        if newest_provider_updated_values
        else None,
        "missing_close_price_count": sum(
            1 for row in rows if row.get("close_price") is None
        ),
        "zero_open_interest_count": sum(
            1
            for row in rows
            if (_decimal_or_none(row.get("open_interest")) or Decimal("0")) <= 0
        ),
        "route_symbols": list(scoped_symbols),
        "route_symbol_freshness": route_symbol_freshness,
        "reason_codes": [
            "options_catalog_freshness_bounded_route_scope",
            *fallback_reason_codes,
        ],
    }


__all__ = [name for name in globals() if not name.startswith("__")]

# Public aliases used by split modules.
alpaca_cached_last_good = _alpaca_cached_last_good
budget_exhausted_live_submission_gate_payload = (
    _budget_exhausted_live_submission_gate_payload
)
budget_exhausted_options_catalog_freshness_payload = (
    _budget_exhausted_options_catalog_freshness_payload
)
check_alpaca = _check_alpaca
decimal_or_none = _decimal_or_none
load_bounded_options_catalog_freshness_summary = (
    _load_bounded_options_catalog_freshness_summary
)
load_cached_options_catalog_freshness_summary = (
    _load_cached_options_catalog_freshness_summary
)
load_clickhouse_ta_status = _load_clickhouse_ta_status
load_tca_summary = _load_tca_summary
remember_alpaca_success = _remember_alpaca_success
route_claim_symbols = _route_claim_symbols
sqlalchemy_error_indicates_statement_timeout = (
    _sqlalchemy_error_indicates_statement_timeout
)
store_options_catalog_freshness_summary = _store_options_catalog_freshness_summary
tca_row_payload = _tca_row_payload
