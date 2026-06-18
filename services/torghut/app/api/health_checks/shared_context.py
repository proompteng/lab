"""Extracted Torghut API route and support functions."""

from __future__ import annotations

from fastapi import APIRouter
from typing import Any, TYPE_CHECKING


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
    ACCOUNT_SCOPE_STATEMENT_TIMEOUT_MS as ACCOUNT_SCOPE_STATEMENT_TIMEOUT_MS,
    ALPACA_HEALTH_CACHE_LOCK as ALPACA_HEALTH_CACHE_LOCK,
    ALPACA_HEALTH_STATE as ALPACA_HEALTH_STATE,
    OPTIONS_CATALOG_FRESHNESS_CACHE as OPTIONS_CATALOG_FRESHNESS_CACHE,
    OPTIONS_CATALOG_FRESHNESS_CACHE_LOCK as OPTIONS_CATALOG_FRESHNESS_CACHE_LOCK,
    PAPER_ROUTE_BOUNDED_COLLECTION_ACCOUNT_LABEL as PAPER_ROUTE_BOUNDED_COLLECTION_ACCOUNT_LABEL,
    PAPER_ROUTE_TARGET_PLAN_STALE_SUCCESS_SECONDS as PAPER_ROUTE_TARGET_PLAN_STALE_SUCCESS_SECONDS,
    PAPER_ROUTE_TARGET_PLAN_SUCCESS_CACHE_LOCK as PAPER_ROUTE_TARGET_PLAN_SUCCESS_CACHE_LOCK,
    READINESS_PROMOTION_AUTHORITY_KEYS as READINESS_PROMOTION_AUTHORITY_KEYS,
    RETRYABLE_TCA_RECOMPUTE_SQLSTATES as RETRYABLE_TCA_RECOMPUTE_SQLSTATES,
    SIMPLE_LANE_ALLOWED_REJECT_REASONS as SIMPLE_LANE_ALLOWED_REJECT_REASONS,
    TRADING_DEPENDENCY_HEALTH_CACHE as TRADING_DEPENDENCY_HEALTH_CACHE,
    TRADING_DEPENDENCY_HEALTH_CACHE_LOCK as TRADING_DEPENDENCY_HEALTH_CACHE_LOCK,
    TRADING_HEALTH_SURFACE_EVALUATIONS as TRADING_HEALTH_SURFACE_EVALUATIONS,
    TRADING_HEALTH_SURFACE_EVALUATION_EXECUTOR as TRADING_HEALTH_SURFACE_EVALUATION_EXECUTOR,
    TRADING_HEALTH_SURFACE_EVALUATION_LOCK as TRADING_HEALTH_SURFACE_EVALUATION_LOCK,
    TRADING_HEALTH_SURFACE_PAYLOAD_CACHE as TRADING_HEALTH_SURFACE_PAYLOAD_CACHE,
    TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS as TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS,
    TRADING_STATUS_READ_BUDGET_SECONDS as TRADING_STATUS_READ_BUDGET_SECONDS,
    ZERO_NOTIONAL_TCA_RECOMPUTE_MAX_ATTEMPTS as ZERO_NOTIONAL_TCA_RECOMPUTE_MAX_ATTEMPTS,
    paper_route_target_plan_success_cache as paper_route_target_plan_success_cache,
    retryable_tca_recompute_error as retryable_tca_recompute_error,
    shared_mapping_items as shared_mapping_items,
    shared_paper_route_target_plan_from_payload as shared_paper_route_target_plan_from_payload,
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


def _apply_status_read_statement_timeout(
    session: Session,
    *,
    milliseconds: int,
) -> None:
    from ..status_helpers import (
        apply_status_read_statement_timeout as apply_statement_timeout,
    )

    apply_statement_timeout(session, milliseconds=milliseconds)


def _sqlalchemy_error_indicates_statement_timeout(exc: SQLAlchemyError) -> bool:
    message = str(exc).lower()
    return (
        "statement timeout" in message
        or "querycanceled" in message
        or "query canceled" in message
    )


def check_postgres(session: Session) -> dict[str, object]:
    try:
        ping(session)
    except SQLAlchemyError as exc:
        return {"ok": False, "detail": f"postgres error: {exc}"}
    return {"ok": True, "detail": "ok"}


def check_tigerbeetle_protocol_health() -> dict[str, object]:
    if not settings.tigerbeetle_enabled:
        health = check_tigerbeetle_health(settings)
        payload = health.as_dict()
        payload["protocol_ok"] = True
        payload["protocol_probe_skipped"] = False
        return payload

    replica_addresses = [
        item.strip()
        for item in settings.tigerbeetle_replica_addresses.split(",")
        if item.strip()
    ]
    if not (settings.tigerbeetle_required or settings.tigerbeetle_reconcile_required):
        return {
            "enabled": True,
            "required": settings.tigerbeetle_required,
            "ok": True,
            "protocol_ok": False,
            "protocol_probe_skipped": True,
            "cluster_id": settings.tigerbeetle_cluster_id,
            "replica_addresses": replica_addresses,
            "last_error": None,
        }

    timeout_seconds = max(0.1, float(settings.tigerbeetle_health_timeout_seconds))
    executor = ThreadPoolExecutor(max_workers=1)
    future = executor.submit(check_tigerbeetle_health, settings)
    try:
        health = future.result(timeout=timeout_seconds)
    except TimeoutError:
        return {
            "enabled": True,
            "required": settings.tigerbeetle_required,
            "ok": not settings.tigerbeetle_required,
            "protocol_ok": False,
            "protocol_probe_skipped": False,
            "cluster_id": settings.tigerbeetle_cluster_id,
            "replica_addresses": replica_addresses,
            "last_error": (
                f"TimeoutError: tigerbeetle protocol health timed out after "
                f"{timeout_seconds:.2f}s"
            ),
        }
    finally:
        executor.shutdown(wait=False, cancel_futures=True)

    payload = health.as_dict()
    protocol_ok = bool(payload.get("ok"))
    payload["protocol_ok"] = protocol_ok
    payload["protocol_probe_skipped"] = False
    payload["ok"] = protocol_ok or not settings.tigerbeetle_required
    return payload


def tigerbeetle_status_int(value: object) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return 0


def empty_tigerbeetle_ref_counts(
    *,
    reason_codes: Sequence[str],
    last_error: str | None = None,
) -> dict[str, object]:
    return {
        "schema_version": "torghut.tigerbeetle-ref-counts.v1",
        "cluster_id": settings.tigerbeetle_cluster_id,
        "ref_counts_unavailable": True,
        "reason_codes": list(reason_codes),
        "last_error": last_error,
        "account_ref_count": 0,
        "transfer_ref_count": 0,
        "by_source_type": {},
        "order_event_ref_count": 0,
        "execution_ref_count": 0,
        "cost_ref_count": 0,
        "runtime_ledger_ref_count": 0,
        "stable_ref_count": 0,
        "stable_ref_missing_count": 0,
        "stable_ref_mismatch_count": 0,
        "stable_ref_diagnostic_bounded": True,
        "stable_ref_sample_size": 0,
        "runtime_ledger_required_bucket_count": 0,
        "runtime_ledger_signed_ref_count": 0,
        "runtime_ledger_missing_signed_ref_count": 0,
        "runtime_ledger_account_ref_count": 0,
        "runtime_ledger_missing_account_ref_count": 0,
        "runtime_ledger_missing_account_ids": [],
        "runtime_ledger_source_ids": [],
        "runtime_ledger_transfer_ids": [],
        "runtime_ledger_signed_bucket_ids": [],
        "runtime_ledger_ref_coverage_bounded": True,
        "runtime_ledger_ref_sample_size": 0,
        "source_materialization": {
            "account_ref_table": "tigerbeetle_account_refs",
            "transfer_ref_table": "tigerbeetle_transfer_refs",
            "reconciliation_run_table": "tigerbeetle_reconciliation_runs",
            "runtime_ledger_source_table": "strategy_runtime_ledger_buckets",
            "runtime_ledger_source_type": "strategy_runtime_ledger_bucket",
            "runtime_ledger_transfer_kind": "runtime_net_pnl",
        },
    }


def latest_reconciliation_ref_counts(
    latest_reconciliation: Mapping[str, object] | None,
) -> dict[str, object] | None:
    if latest_reconciliation is None:
        return None
    raw_ref_counts = latest_reconciliation.get("ref_counts")
    if not isinstance(raw_ref_counts, Mapping):
        return None
    ref_counts = dict(cast(Mapping[str, object], raw_ref_counts))
    required_keys = (
        "account_ref_count",
        "transfer_ref_count",
        "runtime_ledger_ref_count",
        "runtime_ledger_signed_ref_count",
        "runtime_ledger_missing_signed_ref_count",
        "runtime_ledger_missing_account_ref_count",
    )
    trusted_top_level_keys: set[str] | None = None
    raw_field_names = latest_reconciliation.get("ref_count_field_names")
    if isinstance(raw_field_names, Sequence) and not isinstance(
        raw_field_names,
        (str, bytes, bytearray),
    ):
        trusted_top_level_keys = {
            str(item) for item in cast(Sequence[object], raw_field_names)
        }
    for key in required_keys:
        if key in ref_counts or key not in latest_reconciliation:
            continue
        if trusted_top_level_keys is not None and key not in trusted_top_level_keys:
            continue
        if key not in ref_counts and key in latest_reconciliation:
            ref_counts[key] = latest_reconciliation[key]
    if not all(key in ref_counts for key in required_keys):
        return None
    ref_counts.setdefault("schema_version", "torghut.tigerbeetle-ref-counts.v1")
    ref_counts["source"] = "latest_tigerbeetle_reconciliation"
    ref_counts["source_reconciliation_status"] = latest_reconciliation.get("status")
    ref_counts["source_reconciliation_ok"] = bool(latest_reconciliation.get("ok"))
    ref_counts["source_reconciliation_age_seconds"] = latest_reconciliation.get(
        "age_seconds"
    )
    ref_counts["source_reconciliation_stale"] = bool(
        latest_reconciliation.get("reconciliation_stale")
    )
    ref_counts["bounded_status_live_query_skipped"] = True
    return ref_counts


def unavailable_tigerbeetle_reconciliation_payload(
    *,
    reason_codes: Sequence[str],
    last_error: str | None = None,
) -> dict[str, object]:
    return {
        "schema_version": "torghut.tigerbeetle-reconciliation-status.v1",
        "ok": False,
        "cluster_id": settings.tigerbeetle_cluster_id,
        "status": "unavailable",
        "age_seconds": None,
        "reconciliation_freshness": {
            "observed_at": None,
            "age_seconds": None,
            "max_age_seconds": max(
                1,
                int(settings.tigerbeetle_reconcile_max_age_seconds),
            ),
            "stale": True,
        },
        "authority": "accounting_parity_only",
        "promotion_authority": False,
        "overrides_runtime_ledger_authority": False,
        "reason_codes": list(reason_codes),
        "last_error": last_error,
        "blockers": list(reason_codes),
        "ref_counts": {},
    }


def build_tigerbeetle_ledger_status(session: Session) -> dict[str, object]:
    protocol = check_tigerbeetle_protocol_health()
    blockers: list[str] = []
    latest_reconciliation: dict[str, object] | None
    reconciliation_status_available = True
    try:
        _apply_status_read_statement_timeout(session, milliseconds=750)
        latest_reconciliation = latest_tigerbeetle_reconciliation_status_payload(
            session,
            cluster_id=settings.tigerbeetle_cluster_id,
        )
        if latest_reconciliation is None:
            latest_reconciliation = latest_tigerbeetle_reconciliation_payload(
                session,
                cluster_id=settings.tigerbeetle_cluster_id,
            )
    except SQLAlchemyError as exc:
        logger.warning("TigerBeetle reconciliation status unavailable: %s", exc)
        session.rollback()
        reconciliation_status_available = False
        reason_codes = ["tigerbeetle_reconciliation_status_unavailable"]
        if _sqlalchemy_error_indicates_statement_timeout(exc):
            reason_codes.append("tigerbeetle_reconciliation_status_query_timeout")
        blockers.extend(reason_codes)
        latest_reconciliation = unavailable_tigerbeetle_reconciliation_payload(
            reason_codes=reason_codes,
            last_error=str(exc),
        )

    ref_counts: dict[str, object]
    ref_counts_available = True
    latest_ref_counts = latest_reconciliation_ref_counts(latest_reconciliation)
    if latest_ref_counts is not None:
        ref_counts = latest_ref_counts
    else:
        try:
            _apply_status_read_statement_timeout(session, milliseconds=750)
            ref_counts = tigerbeetle_ref_counts(
                session,
                cluster_id=settings.tigerbeetle_cluster_id,
                full_ref_scan=False,
            )
        except SQLAlchemyError as exc:
            logger.warning("TigerBeetle ref-count status unavailable: %s", exc)
            session.rollback()
            ref_counts_available = False
            reason_codes = ["tigerbeetle_ref_counts_unavailable"]
            if _sqlalchemy_error_indicates_statement_timeout(exc):
                reason_codes.append("tigerbeetle_ref_counts_query_timeout")
            blockers.extend(reason_codes)
            ref_counts = empty_tigerbeetle_ref_counts(
                reason_codes=reason_codes,
                last_error=str(exc),
            )
    runtime_ledger_ref_count = tigerbeetle_status_int(
        ref_counts.get("runtime_ledger_ref_count")
    )
    runtime_ledger_signed_ref_count = tigerbeetle_status_int(
        ref_counts.get("runtime_ledger_signed_ref_count")
    )
    runtime_ledger_missing_signed_ref_count = tigerbeetle_status_int(
        ref_counts.get("runtime_ledger_missing_signed_ref_count")
    )
    runtime_ledger_missing_account_ref_count = tigerbeetle_status_int(
        ref_counts.get("runtime_ledger_missing_account_ref_count")
    )
    claimed_by_runtime_evidence = runtime_ledger_ref_count > 0
    if (
        settings.tigerbeetle_enabled
        and not bool(protocol.get("protocol_ok"))
        and not bool(protocol.get("protocol_probe_skipped"))
    ):
        blockers.append("tigerbeetle_protocol_unhealthy")
    reconciliation_ok = True
    reconciliation_required = bool(
        settings.tigerbeetle_required or settings.tigerbeetle_reconcile_required
    )
    if latest_reconciliation is None:
        if reconciliation_required:
            reconciliation_ok = False
            blockers.append("tigerbeetle_reconciliation_missing")
    else:
        reconciliation_ok = bool(latest_reconciliation.get("ok"))
        reconciliation_age_seconds = tigerbeetle_status_int(
            latest_reconciliation.get("age_seconds")
        )
        reconciliation_max_age_seconds = max(
            1,
            int(settings.tigerbeetle_reconcile_max_age_seconds),
        )
        if reconciliation_age_seconds > reconciliation_max_age_seconds:
            reconciliation_ok = False
            blockers.append(BLOCKER_RECONCILIATION_STALE)
        raw_blockers = latest_reconciliation.get("blockers")
        if isinstance(raw_blockers, Sequence) and not isinstance(
            raw_blockers, (str, bytes, bytearray)
        ):
            blocker_items = cast(Sequence[object], raw_blockers)
            blockers.extend(str(item) for item in blocker_items)
    if not reconciliation_status_available:
        reconciliation_ok = False
    if not ref_counts_available:
        reconciliation_ok = False
    reconciliation_age_seconds = (
        tigerbeetle_status_int(latest_reconciliation.get("age_seconds"))
        if latest_reconciliation is not None
        else None
    )
    reconciliation_max_age_seconds = max(
        1,
        int(settings.tigerbeetle_reconcile_max_age_seconds),
    )
    reconciliation_stale = (
        reconciliation_age_seconds is not None
        and reconciliation_age_seconds > reconciliation_max_age_seconds
    )
    if runtime_ledger_missing_signed_ref_count:
        reconciliation_ok = False
        blockers.append("tigerbeetle_runtime_ledger_signed_refs_missing")
    if runtime_ledger_ref_count and runtime_ledger_signed_ref_count <= 0:
        reconciliation_ok = False
        blockers.append("tigerbeetle_runtime_ledger_signed_refs_missing")
    if runtime_ledger_missing_account_ref_count:
        reconciliation_ok = False
        blockers.append("tigerbeetle_runtime_ledger_account_refs_missing")

    protocol_gate_ok = bool(protocol.get("ok"))
    reconcile_gate_ok = reconciliation_ok or not reconciliation_required
    return {
        "schema_version": "torghut.tigerbeetle-ledger-status.v1",
        "enabled": settings.tigerbeetle_enabled,
        "journal_enabled": settings.tigerbeetle_journal_enabled,
        "required": settings.tigerbeetle_required,
        "reconcile_required": settings.tigerbeetle_reconcile_required,
        "claimed_by_runtime_evidence": claimed_by_runtime_evidence,
        "reconciliation_required": reconciliation_required,
        "ok": protocol_gate_ok and reconcile_gate_ok,
        "protocol_ok": bool(protocol.get("protocol_ok")),
        "protocol_probe_skipped": bool(protocol.get("protocol_probe_skipped")),
        "reconciliation_ok": reconciliation_ok,
        "reconciliation_age_seconds": reconciliation_age_seconds,
        "reconciliation_max_age_seconds": reconciliation_max_age_seconds,
        "reconciliation_stale": reconciliation_stale,
        "cluster_id": settings.tigerbeetle_cluster_id,
        "replica_addresses": protocol.get("replica_addresses", []),
        "last_error": protocol.get("last_error"),
        "ref_counts": ref_counts,
        "account_ref_count": ref_counts.get("account_ref_count", 0),
        "transfer_ref_count": ref_counts.get("transfer_ref_count", 0),
        "runtime_ledger_ref_count": runtime_ledger_ref_count,
        "runtime_ledger_signed_ref_count": runtime_ledger_signed_ref_count,
        "runtime_ledger_missing_signed_ref_count": (
            runtime_ledger_missing_signed_ref_count
        ),
        "runtime_ledger_missing_account_ref_count": (
            runtime_ledger_missing_account_ref_count
        ),
        "source_materialization": ref_counts.get("source_materialization", {}),
        "latest_reconciliation": latest_reconciliation,
        "blockers": sorted(set(blockers)),
    }


def build_control_plane_contract(
    state: object,
    *,
    hypothesis_summary: Mapping[str, Any] | None = None,
    dependency_quorum: JangarDependencyQuorumStatus | None = None,
) -> dict[str, object]:
    metrics = getattr(state, "metrics", None)
    signal_lag_seconds = getattr(metrics, "signal_lag_seconds", None)
    no_signal_reason_streak = getattr(metrics, "no_signal_reason_streak", None)
    signal_staleness_alert_total = getattr(
        metrics, "signal_staleness_alert_total", None
    )
    signal_continuity_actionable = getattr(
        metrics, "signal_continuity_actionable", None
    )
    market_session_open = getattr(state, "market_session_open", None)
    last_run_at = getattr(state, "last_run_at", None)
    last_reconcile_at = getattr(state, "last_reconcile_at", None)
    summary: dict[str, Any] = (
        dict(hypothesis_summary) if hypothesis_summary is not None else {}
    )
    raw_state_totals = summary.get("state_totals")
    state_totals: dict[str, Any] = (
        dict(cast(Mapping[str, Any], raw_state_totals))
        if isinstance(raw_state_totals, Mapping)
        else {}
    )
    capital_stage_totals = (
        dict(cast(Mapping[str, Any], summary.get("capital_stage_totals", {})))
        if isinstance(summary.get("capital_stage_totals"), Mapping)
        else {}
    )
    return {
        "contract_version": "torghut.quant-producer.v1",
        "active_revision": active_runtime_revision(),
        "signal_lag_seconds": signal_lag_seconds,
        "signal_continuity_state": getattr(state, "last_signal_continuity_state", None),
        "signal_continuity_reason": getattr(
            state, "last_signal_continuity_reason", None
        ),
        "signal_continuity_actionable": signal_continuity_actionable,
        "signal_continuity_alert_active": getattr(
            state, "signal_continuity_alert_active", None
        ),
        "signal_continuity_alert_reason": getattr(
            state, "signal_continuity_alert_reason", None
        ),
        "signal_continuity_alert_started_at": getattr(
            state, "signal_continuity_alert_started_at", None
        ),
        "signal_continuity_recovery_streak": getattr(
            state, "signal_continuity_recovery_streak", None
        ),
        "signal_continuity_promotion_block_total": getattr(
            metrics, "signal_continuity_promotion_block_total", None
        ),
        "market_session_open": market_session_open,
        "no_signal_reason_streak": no_signal_reason_streak,
        "signal_staleness_alert_total": signal_staleness_alert_total,
        "signal_expected_staleness_total": getattr(
            metrics, "signal_expected_staleness_total", None
        ),
        "signal_actionable_staleness_total": getattr(
            metrics, "signal_actionable_staleness_total", None
        ),
        "universe_status": getattr(state, "universe_source_status", None),
        "universe_reason": getattr(state, "universe_source_reason", None),
        "universe_symbols_count": getattr(state, "universe_symbols_count", None),
        "universe_cache_age_seconds": getattr(
            state, "universe_cache_age_seconds", None
        ),
        "universe_resolution_total": getattr(
            metrics, "universe_resolution_total", None
        ),
        "universe_fail_safe_blocked": getattr(
            state, "universe_fail_safe_blocked", None
        ),
        "universe_fail_safe_block_reason": getattr(
            state, "universe_fail_safe_block_reason", None
        ),
        "running": bool(getattr(state, "running", False)),
        "last_run_at": last_run_at,
        "last_reconcile_at": last_reconcile_at,
        "submission_block_total": getattr(metrics, "submission_block_total", None),
        "decision_state_total": getattr(metrics, "decision_state_total", None),
        "planned_decision_age_seconds": getattr(
            metrics, "planned_decision_age_seconds", None
        ),
        "last_autonomy_recommendation_trace_id": getattr(
            state, "last_autonomy_recommendation_trace_id", None
        ),
        "domain_telemetry_event_total": getattr(
            metrics, "domain_telemetry_event_total", None
        ),
        "domain_telemetry_dropped_total": getattr(
            metrics, "domain_telemetry_dropped_total", None
        ),
        "alpha_readiness_hypotheses_total": summary.get("hypotheses_total", 0),
        "alpha_readiness_blocked_total": state_totals.get("blocked", 0),
        "alpha_readiness_shadow_total": state_totals.get("shadow", 0),
        "alpha_readiness_canary_live_total": state_totals.get("canary_live", 0),
        "alpha_readiness_scaled_live_total": state_totals.get("scaled_live", 0),
        "capital_stage_totals": capital_stage_totals,
        "active_capital_stage": _resolve_active_capital_stage(summary),
        "alpha_readiness_promotion_eligible_total": summary.get(
            "promotion_eligible_total", 0
        ),
        "alpha_readiness_rollback_required_total": summary.get(
            "rollback_required_total", 0
        ),
        "alpha_readiness_dependency_quorum_decision": (
            dependency_quorum.decision if dependency_quorum is not None else "unknown"
        ),
        "critical_toggle_parity": _build_shadow_first_toggle_parity(),
        "market_context_required": settings.trading_market_context_required,
        "market_context_max_staleness_seconds": settings.trading_market_context_max_staleness_seconds,
    }


def active_runtime_revision() -> str | None:
    revision = os.getenv("K_REVISION", "").strip()
    return revision or None


def _build_shadow_first_toggle_parity() -> dict[str, object]:
    return build_shadow_first_toggle_parity()


def _resolve_active_capital_stage(
    hypothesis_summary: Mapping[str, Any] | None,
) -> str | None:
    return resolve_active_capital_stage(hypothesis_summary)


def build_shadow_first_runtime_payload(
    *,
    state: object,
    hypothesis_summary: Mapping[str, Any] | None,
) -> dict[str, object]:
    metrics = getattr(state, "metrics", None)
    return {
        "active_revision": active_runtime_revision(),
        "capital_stage": _resolve_active_capital_stage(hypothesis_summary),
        "capital_stage_totals": (
            dict(
                cast(
                    Mapping[str, Any],
                    hypothesis_summary.get("capital_stage_totals", {}),
                )
            )
            if isinstance(hypothesis_summary, Mapping)
            and isinstance(hypothesis_summary.get("capital_stage_totals"), Mapping)
            else {}
        ),
        "submission_block_total": dict(
            cast(
                Mapping[str, int],
                getattr(metrics, "submission_block_total", {}) or {},
            )
        ),
        "decision_state_total": dict(
            cast(Mapping[str, int], getattr(metrics, "decision_state_total", {}) or {})
        ),
        "planned_decision_age_seconds": getattr(
            metrics, "planned_decision_age_seconds", 0
        ),
        "critical_toggle_parity": _build_shadow_first_toggle_parity(),
    }


def check_clickhouse() -> dict[str, object]:
    if not settings.trading_clickhouse_url:
        return {"ok": False, "detail": "clickhouse url missing"}
    query = "SELECT 1 FORMAT JSONEachRow"
    params = {"query": query}
    url = f"{settings.trading_clickhouse_url.rstrip('/')}/?{urlencode(params)}"
    parsed = urlsplit(url)
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"}:
        return {
            "ok": False,
            "detail": f"clickhouse invalid url scheme: {scheme or 'missing'}",
        }
    if not parsed.hostname:
        return {"ok": False, "detail": "clickhouse invalid url host"}

    headers: dict[str, str] = {"Content-Type": "text/plain"}
    if settings.trading_clickhouse_username:
        headers["X-ClickHouse-User"] = settings.trading_clickhouse_username
    if settings.trading_clickhouse_password:
        headers["X-ClickHouse-Key"] = settings.trading_clickhouse_password

    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"
    connection_class = HTTPSConnection if scheme == "https" else HTTPConnection
    connection = connection_class(
        parsed.hostname,
        parsed.port,
        timeout=settings.trading_clickhouse_timeout_seconds,
    )

    try:
        connection.request("GET", path, headers=headers)
        response = connection.getresponse()
        if response.status < 200 or response.status >= 300:
            return {"ok": False, "detail": f"clickhouse http status {response.status}"}
        payload = response.read().decode("utf-8")
    except Exception as exc:  # pragma: no cover - depends on network
        return {"ok": False, "detail": f"clickhouse error: {exc}"}
    finally:
        connection.close()

    if not payload.strip():
        return {"ok": False, "detail": "clickhouse empty response"}
    return {"ok": True, "detail": "ok"}


def forecast_service_status(
    empirical_jobs_status: Mapping[str, Any] | None = None,
) -> dict[str, object]:
    return cast(
        dict[str, object],
        forecast_status_from_empirical_jobs(empirical_jobs_status),
    )


def _lean_authority_status() -> dict[str, object]:
    return cast(dict[str, object], lean_authority_status())


def empirical_jobs_status() -> dict[str, object]:
    try:
        with SessionLocal() as session:
            return build_empirical_jobs_status(
                session=session,
                stale_after_seconds=settings.trading_empirical_job_stale_after_seconds,
            )
    except Exception as exc:
        return {
            "status": "degraded",
            "authority": "blocked",
            "stale_after_seconds": settings.trading_empirical_job_stale_after_seconds,
            "jobs": {},
            "message": f"empirical job status unavailable: {type(exc).__name__}",
        }


def alpaca_endpoint_class(*, paper: bool | None = None) -> str:
    use_paper = settings.trading_mode != "live" if paper is None else paper
    return "paper" if use_paper else "live"


def alpaca_failure_status(detail: str) -> str:
    message = detail.strip().lower()
    if "keys missing" in message:
        return "credentials_missing"
    if any(
        token in message
        for token in (
            "unauthorized",
            "forbidden",
            "invalid api",
            "authentication",
            "not authorized",
            "insufficient scope",
            "access key",
            "secret key",
            "credentials",
        )
    ):
        return "credentials_invalid"
    if any(
        token in message
        for token in (
            "timeout",
            "timed out",
            "deadline exceeded",
            "read timed out",
        )
    ):
        return "broker_slow"
    if any(
        token in message
        for token in (
            "connection refused",
            "connection reset",
            "name or service not known",
            "temporary failure in name resolution",
            "nodename nor servname",
            "network is unreachable",
            "no route to host",
            "failed to establish a new connection",
            "max retries exceeded",
            "dns",
        )
    ):
        return "network_unreachable"
    return "broker_error"


def alpaca_probe_account(
    client: TorghutAlpacaClient,
    *,
    timeout_seconds: float,
) -> dict[str, object]:
    executor = ThreadPoolExecutor(max_workers=1)
    future = None
    try:
        future = executor.submit(client.get_account)
        account = future.result(timeout=timeout_seconds)
    except TimeoutError:
        if future is not None:
            future.cancel()
        return {
            "ok": False,
            "status": "broker_slow",
            "detail": f"alpaca account probe timed out after {timeout_seconds:.2f}s",
        }
    except Exception as exc:  # pragma: no cover - depends on network
        detail = str(exc).strip() or type(exc).__name__
        return {
            "ok": False,
            "status": alpaca_failure_status(detail),
            "detail": detail,
        }
    finally:
        executor.shutdown(wait=False, cancel_futures=True)
    return {
        "ok": True,
        "status": "broker_ok",
        "detail": "ok",
        "account": account,
    }


__all__: tuple[str, ...] = ()


# Explicit barrel exports; keeps re-export imports intentional without file-level Ruff ignores.
__all__: tuple[str, ...] = (
    "ACCOUNT_SCOPE_STATEMENT_TIMEOUT_MS",
    "ALPACA_HEALTH_CACHE_LOCK",
    "ALPACA_HEALTH_STATE",
    "APIRouter",
    "Any",
    "BLOCKER_RECONCILIATION_STALE",
    "BUILD_ARGO_HEALTH",
    "BUILD_ARGO_SYNC_REVISION",
    "BUILD_COMMIT",
    "BUILD_IMAGE_DIGEST",
    "BUILD_MANIFEST_COMMIT",
    "BUILD_MANIFEST_IMAGE_DIGEST",
    "BUILD_SOURCE_CI_REF",
    "BUILD_VERSION",
    "Body",
    "CONSUMER_EVIDENCE_CONTROL_PLANE_DEPENDENCY_MESSAGE",
    "ClickHouseSignalIngestor",
    "DEFAULT_PAPER_ROUTE_EVIDENCE_LOOKBACK_HOURS",
    "DEFAULT_PAPER_ROUTE_EVIDENCE_TARGET_LIMIT",
    "Decimal",
    "Depends",
    "EvidenceEpoch",
    "EvidenceReceipt",
    "Execution",
    "ExecutionTCAMetric",
    "FastAPI",
    "FeatureQualityThresholds",
    "Future",
    "HTTPConnection",
    "HTTPException",
    "HTTPSConnection",
    "JSONResponse",
    "JangarDependencyQuorumStatus",
    "LEAN_LANE_MANAGER",
    "LeanLaneManager",
    "Lock",
    "MAX_PAPER_ROUTE_EVIDENCE_LOOKBACK_HOURS",
    "MAX_PAPER_ROUTE_EVIDENCE_TARGET_LIMIT",
    "Mapping",
    "OPTIONS_CATALOG_FRESHNESS_CACHE",
    "OPTIONS_CATALOG_FRESHNESS_CACHE_LOCK",
    "OperationalError",
    "PAPER_ROUTE_BOUNDED_COLLECTION_ACCOUNT_LABEL",
    "PAPER_ROUTE_RUNTIME_ACCOUNT_LABEL",
    "PAPER_ROUTE_TARGET_PLAN_STALE_SUCCESS_SECONDS",
    "PAPER_ROUTE_TARGET_PLAN_SUCCESS_CACHE_LOCK",
    "PROFITABILITY_PROOF_FLOOR_TCA_MAX_AGE_SECONDS",
    "Path",
    "ProofKind",
    "ProofWindowSelector",
    "Query",
    "READINESS_PROMOTION_AUTHORITY_KEYS",
    "RETRYABLE_TCA_RECOMPUTE_SQLSTATES",
    "RUNTIME_PROFITABILITY_LOOKBACK_HOURS",
    "RUNTIME_PROFITABILITY_SCHEMA_VERSION",
    "RejectedSignalOutcomeEvent",
    "Request",
    "Response",
    "SIMPLE_LANE_ALLOWED_REJECT_REASONS",
    "SQLAlchemyError",
    "Sequence",
    "Session",
    "SessionLocal",
    "SignalEnvelope",
    "Strategy",
    "StrategyRuntimeLedgerBucket",
    "TRADING_DEPENDENCY_HEALTH_CACHE",
    "TRADING_DEPENDENCY_HEALTH_CACHE_LOCK",
    "TRADING_HEALTH_SURFACE_EVALUATIONS",
    "TRADING_HEALTH_SURFACE_EVALUATION_EXECUTOR",
    "TRADING_HEALTH_SURFACE_EVALUATION_LOCK",
    "TRADING_HEALTH_SURFACE_PAYLOAD_CACHE",
    "TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS",
    "TRADING_STATUS_READ_BUDGET_SECONDS",
    "TYPE_CHECKING",
    "ThreadPoolExecutor",
    "TimeoutError",
    "TorghutAlpacaClient",
    "TradeDecision",
    "TradingScheduler",
    "VNextDatasetSnapshot",
    "VNextExperimentRun",
    "VNextExperimentSpec",
    "VNextFeatureViewSpec",
    "VNextModelArtifact",
    "VNextPromotionDecision",
    "VNextShadowLiveDeviation",
    "VNextSimulationCalibration",
    "WHITEPAPER_WORKFLOW",
    "WhitepaperAnalysisRun",
    "WhitepaperCodexAgentRun",
    "WhitepaperDesignPullRequest",
    "WhitepaperEngineeringTrigger",
    "WhitepaperKafkaWorker",
    "WhitepaperRolloutTransition",
    "WhitepaperWorkflowService",
    "ZERO_NOTIONAL_TCA_RECOMPUTE_MAX_ATTEMPTS",
    "ACCOUNT_SCOPE_STATEMENT_TIMEOUT_MS",
    "ALPACA_HEALTH_CACHE_LOCK",
    "ALPACA_HEALTH_STATE",
    "OPTIONS_CATALOG_FRESHNESS_CACHE",
    "OPTIONS_CATALOG_FRESHNESS_CACHE_LOCK",
    "PAPER_ROUTE_BOUNDED_COLLECTION_ACCOUNT_LABEL",
    "PAPER_ROUTE_TARGET_PLAN_STALE_SUCCESS_SECONDS",
    "PAPER_ROUTE_TARGET_PLAN_SUCCESS_CACHE_LOCK",
    "READINESS_PROMOTION_AUTHORITY_KEYS",
    "RETRYABLE_TCA_RECOMPUTE_SQLSTATES",
    "SIMPLE_LANE_ALLOWED_REJECT_REASONS",
    "TRADING_DEPENDENCY_HEALTH_CACHE",
    "TRADING_DEPENDENCY_HEALTH_CACHE_LOCK",
    "TRADING_HEALTH_SURFACE_EVALUATIONS",
    "TRADING_HEALTH_SURFACE_EVALUATION_EXECUTOR",
    "TRADING_HEALTH_SURFACE_EVALUATION_LOCK",
    "TRADING_HEALTH_SURFACE_PAYLOAD_CACHE",
    "TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS",
    "TRADING_STATUS_READ_BUDGET_SECONDS",
    "ZERO_NOTIONAL_TCA_RECOMPUTE_MAX_ATTEMPTS",
    "active_runtime_revision",
    "alpaca_endpoint_class",
    "alpaca_failure_status",
    "alpaca_probe_account",
    "_apply_status_read_statement_timeout",
    "build_control_plane_contract",
    "build_shadow_first_runtime_payload",
    "_build_shadow_first_toggle_parity",
    "build_tigerbeetle_ledger_status",
    "check_clickhouse",
    "check_postgres",
    "check_tigerbeetle_protocol_health",
    "empirical_jobs_status",
    "empty_tigerbeetle_ref_counts",
    "forecast_service_status",
    "latest_reconciliation_ref_counts",
    "_lean_authority_status",
    "paper_route_target_plan_success_cache",
    "_resolve_active_capital_stage",
    "retryable_tca_recompute_error",
    "shared_mapping_items",
    "shared_paper_route_target_plan_from_payload",
    "_sqlalchemy_error_indicates_statement_timeout",
    "tigerbeetle_status_int",
    "unavailable_tigerbeetle_reconciliation_payload",
    "active_runtime_revision",
    "active_simulation_runtime_context",
    "alpaca_endpoint_class",
    "alpaca_failure_status",
    "alpaca_probe_account",
    "annotations",
    "assert_runtime_gate_policy_contract",
    "asynccontextmanager",
    "autoresearch_router",
    "bindparam",
    "build_alpha_closure_dividend_slo",
    "build_artifact_parity_receipt",
    "build_capital_reentry_cohort_ledger",
    "build_capital_replay_projection",
    "build_clock_settlement_receipt",
    "build_control_plane_contract",
    "build_data_freshness_receipt",
    "build_doc29_completion_status",
    "build_empirical_jobs_receipt",
    "build_empirical_jobs_status",
    "build_evidence_clock_arbiter_and_exchange",
    "build_freshness_carry_ledger",
    "build_hypothesis_runtime_summary",
    "build_jangar_authority_receipt",
    "build_live_submission_gate_payload",
    "build_llm_evaluation_metrics",
    "build_portfolio_proof_receipt",
    "build_profit_carry_passport_ledger",
    "build_profit_freshness_frontier",
    "build_profit_repair_settlement_ledger",
    "build_profit_signal_quorum",
    "build_profitability_proof_floor_receipt",
    "build_proofs_payload",
    "build_quality_adjusted_profit_frontier",
    "build_renewal_bond_profit_escrow",
    "build_repair_bid_settlement_ledger",
    "build_repair_outcome_dividend_ledger",
    "build_repair_receipt_frontier",
    "build_revenue_repair_digest",
    "build_route_evidence_clearinghouse_packet",
    "build_route_proven_profit_receipt",
    "build_route_reacquisition_board",
    "build_route_warrant_exchange",
    "build_routeability_repair_acceptance_ledger",
    "build_runtime_ledger_profit_distance_readback",
    "build_schema_receipt",
    "build_service_health_receipt",
    "build_shadow_first_runtime_payload",
    "build_shadow_first_toggle_parity",
    "build_source_serving_repair_receipt_ledger",
    "build_tca_gate_inputs",
    "build_tigerbeetle_ledger_status",
    "build_torghut_consumer_evidence_receipt",
    "capture_posthog_event",
    "cast",
    "check_clickhouse",
    "check_postgres",
    "check_schema_current",
    "check_tigerbeetle_health",
    "check_tigerbeetle_protocol_health",
    "compact_alpha_evidence_foundry",
    "compact_alpha_readiness_settlement_conveyor",
    "compact_alpha_repair_closure_board",
    "compact_alpha_repair_dividend_ledger",
    "compact_executable_alpha_settlement_slots",
    "compact_jangar_controller_ingestion_carry",
    "compact_no_delta_repair_reentry_auction",
    "compile_evidence_epoch",
    "cost_basis_counts_have_non_promotion_grade_costs",
    "datetime",
    "deepcopy",
    "empirical_jobs_status",
    "empty_tigerbeetle_ref_counts",
    "ensure_schema",
    "evaluate_evidence_continuity",
    "evaluate_feature_batch_quality",
    "forecast_service_status",
    "forecast_status_from_empirical_jobs",
    "func",
    "get_session",
    "hypothesis_registry_requires_dependency_capability",
    "inngest",
    "inngest_fastapi_serve",
    "json",
    "jsonable_encoder",
    "latest_reconciliation_ref_counts",
    "latest_tigerbeetle_reconciliation_payload",
    "latest_tigerbeetle_reconciliation_status_payload",
    "lean_authority_status",
    "load_evidence_epoch_payload",
    "load_hypothesis_registry",
    "load_jangar_dependency_quorum",
    "load_jangar_route_continuity_packet",
    "load_latest_evidence_epoch_payload",
    "load_quant_evidence_status",
    "logger",
    "logging",
    "main_runtime_value",
    "os",
    "paper_route_target_plan_success_cache",
    "persist_evidence_epoch",
    "ping",
    "refresh_execution_tca_metrics",
    "render_trading_metrics",
    "resolve_active_capital_stage",
    "resolve_hypothesis_dependency_quorum",
    "retryable_tca_recompute_error",
    "run_zero_notional_repair",
    "runtime_ledger_promotion_source_authority_blockers",
    "select",
    "settings",
    "shared_mapping_items",
    "shared_paper_route_target_plan_from_payload",
    "shutdown_posthog_telemetry",
    "simulation_progress_snapshot",
    "sys",
    "text",
    "tigerbeetle_ref_counts",
    "tigerbeetle_status_int",
    "time",
    "timedelta",
    "timezone",
    "trading_time_status",
    "unavailable_tigerbeetle_reconciliation_payload",
    "urlencode",
    "urlsplit",
    "validate_hypothesis_registry_from_settings",
    "whitepaper_inngest_enabled",
    "whitepaper_kafka_enabled",
    "whitepaper_semantic_indexing_enabled",
    "whitepaper_workflow_enabled",
)
