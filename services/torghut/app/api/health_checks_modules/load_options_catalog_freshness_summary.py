# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Extracted Torghut API route and support functions."""

# ruff: noqa: F401,F811,F821
from __future__ import annotations

from ..application import get_app
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
from .remember_alpaca_success import (
    alpaca_cached_last_good as _alpaca_cached_last_good,
    budget_exhausted_live_submission_gate_payload as _budget_exhausted_live_submission_gate_payload,
    budget_exhausted_options_catalog_freshness_payload as _budget_exhausted_options_catalog_freshness_payload,
    check_alpaca as _check_alpaca,
    decimal_or_none as _decimal_or_none,
    load_bounded_options_catalog_freshness_summary as _load_bounded_options_catalog_freshness_summary,
    load_cached_options_catalog_freshness_summary as _load_cached_options_catalog_freshness_summary,
    load_clickhouse_ta_status as _load_clickhouse_ta_status,
    load_tca_summary as _load_tca_summary,
    remember_alpaca_success as _remember_alpaca_success,
    route_claim_symbols as _route_claim_symbols,
    sqlalchemy_error_indicates_statement_timeout as _sqlalchemy_error_indicates_statement_timeout,
    store_options_catalog_freshness_summary as _store_options_catalog_freshness_summary,
    tca_row_payload as _tca_row_payload,
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


def _budget_unavailable_hypothesis_runtime_payload(
    *,
    reason: str,
) -> tuple[dict[str, object], dict[str, object], JangarDependencyQuorumStatus]:
    from ..status_helpers import (
        budget_unavailable_hypothesis_runtime_payload as unavailable_payload,
    )

    return unavailable_payload(reason=reason)


def _resolve_universe_resolver_for_readiness(scheduler: TradingScheduler) -> Any | None:
    from ..readiness_helpers import (
        resolve_universe_resolver_for_readiness as resolve_universe_resolver,
    )

    return resolve_universe_resolver(scheduler)


def _load_options_catalog_freshness_summary(
    session: Session, *, route_symbols: Sequence[str] | None = None
) -> dict[str, object]:
    scoped_symbols = tuple(
        sorted(
            {
                str(symbol).strip().upper()
                for symbol in route_symbols or ()
                if str(symbol).strip()
            }
        )
    )
    cached_payload = _load_cached_options_catalog_freshness_summary(scoped_symbols)
    if cached_payload is not None:
        return cached_payload
    if (
        scoped_symbols
        and not settings.trading_options_catalog_freshness_exact_route_scope_enabled
    ):
        reason_codes = [
            "options_catalog_freshness_exact_route_scope_disabled",
        ]
        bounded_payload = _load_bounded_options_catalog_freshness_summary(
            session,
            scoped_symbols,
            reason=reason_codes[-1],
            reason_codes=reason_codes,
        )
        if bounded_payload is not None:
            return _store_options_catalog_freshness_summary(
                scoped_symbols,
                bounded_payload,
            )
        if (
            "options_catalog_freshness_bounded_route_scope_unavailable"
            not in reason_codes
        ):
            reason_codes.append(
                "options_catalog_freshness_bounded_route_scope_unavailable"
            )
        return _store_options_catalog_freshness_summary(
            scoped_symbols,
            {
                "status": "unavailable",
                "scope": "route_symbols",
                "route_symbols": list(scoped_symbols),
                "reason_codes": reason_codes,
            },
        )
    try:
        session.execute(text("SET LOCAL statement_timeout = 500"))
        if scoped_symbols:
            scoped_query = text(
                """
SELECT
  underlying_symbol,
  COUNT(*) AS active_contracts,
  MAX(last_seen_ts) AS newest_last_seen_ts,
  COUNT(*) FILTER (WHERE provider_updated_ts IS NULL) AS missing_provider_updated_ts_count,
  MAX(provider_updated_ts) AS newest_provider_updated_ts,
  COUNT(*) FILTER (WHERE close_price IS NULL) AS missing_close_price_count,
  COUNT(*) FILTER (WHERE COALESCE(open_interest, 0) <= 0) AS zero_open_interest_count
FROM torghut_options_contract_catalog
WHERE underlying_symbol IN :route_symbols
  AND status = 'active'
GROUP BY underlying_symbol
"""
            ).bindparams(bindparam("route_symbols", expanding=True))
            scoped_rows = list(
                session.execute(
                    scoped_query,
                    {"route_symbols": scoped_symbols},
                ).mappings()
            )
            active_contracts = sum(
                int(row["active_contracts"] or 0) for row in scoped_rows
            )
            newest_last_seen_values = [
                value
                for value in (
                    _ensure_utc_datetime(
                        cast(datetime | None, row["newest_last_seen_ts"])
                    )
                    for row in scoped_rows
                )
                if value is not None
            ]
            newest_last_seen_ts = (
                max(newest_last_seen_values) if newest_last_seen_values else None
            )
            missing_provider_updated_ts_count = sum(
                int(row["missing_provider_updated_ts_count"] or 0)
                for row in scoped_rows
            )
            newest_provider_updated_values = [
                value
                for value in (
                    _ensure_utc_datetime(
                        cast(datetime | None, row["newest_provider_updated_ts"])
                    )
                    for row in scoped_rows
                )
                if value is not None
            ]
            newest_provider_updated_ts = (
                max(newest_provider_updated_values)
                if newest_provider_updated_values
                else None
            )
            missing_close_price_count = sum(
                int(row["missing_close_price_count"] or 0) for row in scoped_rows
            )
            zero_open_interest_count = sum(
                int(row["zero_open_interest_count"] or 0) for row in scoped_rows
            )
        else:
            global_rows = list(
                session.execute(
                    text(
                        """
SELECT
  underlying_symbol,
  last_seen_ts,
  provider_updated_ts,
  close_price,
  open_interest
FROM torghut_options_contract_catalog
WHERE status = 'active'
ORDER BY last_seen_ts DESC NULLS LAST
LIMIT 200
"""
                    )
                ).mappings()
            )
            scoped_rows = []
            active_contracts = len(global_rows)
            newest_last_seen_values = [
                value
                for value in (
                    _ensure_utc_datetime(cast(datetime | None, row.get("last_seen_ts")))
                    for row in global_rows
                )
                if value is not None
            ]
            newest_last_seen_ts = (
                max(newest_last_seen_values) if newest_last_seen_values else None
            )
            missing_provider_updated_ts_count = sum(
                1 for row in global_rows if row.get("provider_updated_ts") is None
            )
            newest_provider_updated_values = [
                value
                for value in (
                    _ensure_utc_datetime(
                        cast(datetime | None, row.get("provider_updated_ts"))
                    )
                    for row in global_rows
                )
                if value is not None
            ]
            newest_provider_updated_ts = (
                max(newest_provider_updated_values)
                if newest_provider_updated_values
                else None
            )
            missing_close_price_count = sum(
                1 for row in global_rows if row.get("close_price") is None
            )
            zero_open_interest_count = sum(
                1
                for row in global_rows
                if (_decimal_or_none(row.get("open_interest")) or Decimal("0")) <= 0
            )
    except SQLAlchemyError as exc:
        logger.warning("Options catalog freshness summary unavailable: %s", exc)
        rollback = getattr(session, "rollback", None)
        if callable(rollback):
            try:
                rollback()
            except SQLAlchemyError:
                logger.warning("Failed to roll back options catalog freshness session")
        reason_codes = ["options_catalog_freshness_summary_unavailable"]
        if _sqlalchemy_error_indicates_statement_timeout(exc):
            reason_codes.append("options_catalog_freshness_query_timeout")
        bounded_payload = _load_bounded_options_catalog_freshness_summary(
            session,
            scoped_symbols,
            reason=reason_codes[-1],
            reason_codes=reason_codes,
        )
        if bounded_payload is not None:
            return _store_options_catalog_freshness_summary(
                scoped_symbols,
                bounded_payload,
            )
        return _store_options_catalog_freshness_summary(
            scoped_symbols,
            {
                "status": "unavailable",
                "scope": "route_symbols" if scoped_symbols else "global",
                "route_symbols": list(scoped_symbols),
                "reason_codes": reason_codes,
            },
        )

    route_symbol_freshness = {
        str(scoped_row["underlying_symbol"]).strip().upper(): {
            "status": "current"
            if int(scoped_row["active_contracts"] or 0) > 0
            else "missing",
            "active_contracts": int(scoped_row["active_contracts"] or 0),
            "newest_last_seen_ts": _ensure_utc_datetime(
                cast(datetime | None, scoped_row["newest_last_seen_ts"])
            ),
            "missing_provider_updated_ts_count": int(
                scoped_row["missing_provider_updated_ts_count"] or 0
            ),
            "provider_updated_ts_present": int(
                scoped_row["missing_provider_updated_ts_count"] or 0
            )
            == 0
            and scoped_row["newest_provider_updated_ts"] is not None,
            "newest_provider_updated_ts": _ensure_utc_datetime(
                cast(datetime | None, scoped_row["newest_provider_updated_ts"])
            ),
            "missing_close_price_count": int(
                scoped_row["missing_close_price_count"] or 0
            ),
            "zero_open_interest_count": int(
                scoped_row["zero_open_interest_count"] or 0
            ),
        }
        for scoped_row in scoped_rows
    }
    return _store_options_catalog_freshness_summary(
        scoped_symbols,
        {
            "status": "current" if active_contracts > 0 else "missing",
            "scope": "route_symbols" if scoped_symbols else "global",
            "active_contracts": active_contracts,
            "active_contracts_exact": bool(scoped_symbols),
            "coverage_exact": bool(scoped_symbols),
            "query_limit": None if scoped_symbols else 200,
            "newest_last_seen_ts": newest_last_seen_ts,
            "missing_provider_updated_ts_count": missing_provider_updated_ts_count,
            "provider_updated_ts_present": missing_provider_updated_ts_count == 0
            and newest_provider_updated_ts is not None,
            "newest_provider_updated_ts": newest_provider_updated_ts,
            "missing_close_price_count": missing_close_price_count,
            "zero_open_interest_count": zero_open_interest_count,
            "route_symbols": list(scoped_symbols),
            "route_symbol_freshness": route_symbol_freshness,
        },
    )


def _resolve_tca_scope_symbols(
    scheduler: TradingScheduler | None,
) -> tuple[str, ...] | None:
    if scheduler is None:
        return None
    resolver = _resolve_universe_resolver_for_readiness(scheduler)
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


def _ensure_utc_datetime(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _load_last_decision_at(session: Session) -> datetime | None:
    return _ensure_utc_datetime(
        session.execute(select(func.max(TradeDecision.created_at))).scalar_one()
    )


def _build_hypothesis_runtime_payload(
    scheduler: TradingScheduler,
    *,
    tca_summary: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    dependency_quorum: JangarDependencyQuorumStatus | None = None,
    feature_readiness: Mapping[str, Any] | None = None,
) -> tuple[dict[str, object], dict[str, object], JangarDependencyQuorumStatus]:
    registry = load_hypothesis_registry()
    if dependency_quorum is None:
        dependency_quorum = resolve_hypothesis_dependency_quorum(registry)
    resolved_feature_readiness = feature_readiness or _load_clickhouse_ta_status(
        scheduler
    )
    try:
        with SessionLocal() as session:
            _apply_status_read_statement_timeout(session, milliseconds=750)
            summary_with_items = build_hypothesis_runtime_summary(
                session,
                state=scheduler.state,
                tca_summary=tca_summary,
                market_context_status=market_context_status,
                dependency_quorum=dependency_quorum,
                feature_readiness=resolved_feature_readiness,
            )
    except SQLAlchemyError as exc:
        logger.warning("Hypothesis runtime status summary unavailable: %s", exc)
        reason = (
            "hypothesis_runtime_summary_query_timeout"
            if _sqlalchemy_error_indicates_statement_timeout(exc)
            else "hypothesis_runtime_summary_unavailable"
        )
        return _budget_unavailable_hypothesis_runtime_payload(reason=reason)
    items = list(
        cast(Sequence[Mapping[str, Any]], summary_with_items.get("items") or [])
    )
    summary = dict(summary_with_items)
    summary.pop("items", None)
    return (
        {
            "registry_loaded": registry.loaded,
            "registry_path": registry.path,
            "registry_errors": list(registry.errors),
            "dependency_quorum": dependency_quorum.as_payload(),
            "summary": summary,
            "items": items,
        },
        summary,
        dependency_quorum,
    )


def _build_live_submission_gate_payload(
    state: object,
    *,
    session: Session | None = None,
    hypothesis_summary: Mapping[str, Any] | None,
    empirical_jobs_status: Mapping[str, Any] | None = None,
    dspy_runtime_status: Mapping[str, Any] | None = None,
    quant_health_status: Mapping[str, Any] | None = None,
    clickhouse_ta_status: Mapping[str, Any] | None = None,
) -> dict[str, object]:
    resolved_clickhouse_ta_status = clickhouse_ta_status
    if resolved_clickhouse_ta_status is None:
        resolved_clickhouse_ta_status = _load_clickhouse_ta_status(
            cast(
                TradingScheduler | None,
                getattr(get_app().state, "trading_scheduler", None),
            )
        )
    if settings.trading_pipeline_mode == "simple":
        gate = build_live_submission_gate_payload(
            state,
            session=session,
            hypothesis_summary=hypothesis_summary,
            empirical_jobs_status=empirical_jobs_status,
            dspy_runtime_status=dspy_runtime_status,
            quant_health_status=quant_health_status,
            clickhouse_ta_status=resolved_clickhouse_ta_status,
        )
        if settings.trading_mode != "live":
            gate["pipeline_mode"] = "simple"
            gate["configured_live_promotion"] = settings.trading_simple_submit_enabled
            gate["simple_lane"] = {
                "submit_enabled": settings.trading_simple_submit_enabled,
                "shared_gate_enforced": True,
                "blocked_reasons": [],
            }
            return gate
        blocked_reasons: list[str] = []
        if not settings.trading_enabled:
            blocked_reasons.append("trading_disabled")
        if settings.trading_kill_switch_enabled:
            blocked_reasons.append("kill_switch_enabled")
        if not settings.trading_simple_submit_enabled:
            blocked_reasons.append("simple_submit_disabled")
        if settings.trading_emergency_stop_enabled and bool(
            getattr(state, "emergency_stop_active", False)
        ):
            blocked_reasons.append(
                str(
                    getattr(state, "emergency_stop_reason", "")
                    or "emergency_stop_active"
                )
            )
        merged_blocked_reasons = list(
            dict.fromkeys(
                [
                    *[
                        str(item).strip()
                        for item in cast(
                            Sequence[object],
                            gate.get("blocked_reasons") or [],
                        )
                        if str(item).strip()
                    ],
                    *blocked_reasons,
                ]
            )
        )
        gate["allowed"] = bool(gate.get("allowed", False)) and not blocked_reasons
        gate["blocked_reasons"] = merged_blocked_reasons
        if blocked_reasons:
            gate["reason"] = blocked_reasons[0]
            gate["capital_stage"] = "shadow"
            gate["capital_state"] = "observe"
        gate["pipeline_mode"] = "simple"
        gate["simple_lane"] = {
            "submit_enabled": settings.trading_simple_submit_enabled,
            "shared_gate_enforced": True,
            "blocked_reasons": blocked_reasons,
        }
        return gate
    return build_live_submission_gate_payload(
        state,
        session=session,
        hypothesis_summary=hypothesis_summary,
        empirical_jobs_status=empirical_jobs_status,
        dspy_runtime_status=dspy_runtime_status,
        quant_health_status=quant_health_status,
        clickhouse_ta_status=resolved_clickhouse_ta_status,
    )


def _build_simple_lane_status_payload() -> dict[str, object]:
    return {
        "enabled": settings.trading_pipeline_mode == "simple",
        "submit_enabled": settings.trading_simple_submit_enabled,
        "order_feed_telemetry_enabled": (
            settings.trading_simple_order_feed_telemetry_enabled
        ),
        "order_feed_ingestion_enabled": settings.trading_order_feed_enabled,
        "order_feed_bootstrap_configured": bool(
            settings.trading_order_feed_bootstrap_server_list
        ),
        "order_feed_topic_count": len(settings.trading_order_feed_topics),
        "order_feed_assignment_mode": settings.trading_order_feed_assignment_mode,
        "order_feed_auto_offset_reset": settings.trading_order_feed_auto_offset_reset,
        "order_feed_lifecycle_required": (
            settings.trading_pipeline_mode == "simple"
            and settings.trading_mode in {"paper", "live"}
        ),
        "order_feed_lifecycle_status": (
            "enabled"
            if settings.trading_simple_order_feed_telemetry_enabled
            else "disabled"
        ),
        "paper_route_probe_enabled": (
            settings.trading_simple_paper_route_probe_enabled
        ),
        "paper_route_probe_max_notional": (
            settings.trading_simple_paper_route_probe_max_notional
        ),
        "route_symbol_filter_enabled": settings.trading_pipeline_mode == "simple",
        "max_notional_per_order": settings.trading_simple_max_notional_per_order,
        "max_notional_per_symbol": settings.trading_simple_max_notional_per_symbol,
        "max_order_pct_equity": settings.trading_simple_max_order_pct_equity,
        "max_gross_exposure_pct_equity": (
            settings.trading_simple_max_gross_exposure_pct_equity
        ),
        "allowed_reject_reasons": sorted(_SIMPLE_LANE_ALLOWED_REJECT_REASONS),
    }


__all__ = [
    "_check_postgres",
    "_check_tigerbeetle_protocol_health",
    "_tigerbeetle_status_int",
    "_empty_tigerbeetle_ref_counts",
    "_latest_reconciliation_ref_counts",
    "_unavailable_tigerbeetle_reconciliation_payload",
    "_build_tigerbeetle_ledger_status",
    "_build_control_plane_contract",
    "_active_runtime_revision",
    "_build_shadow_first_toggle_parity",
    "_resolve_active_capital_stage",
    "_build_shadow_first_runtime_payload",
    "_check_clickhouse",
    "_forecast_service_status",
    "_lean_authority_status",
    "_empirical_jobs_status",
    "_alpaca_endpoint_class",
    "_alpaca_failure_status",
    "_alpaca_probe_account",
    "_remember_alpaca_success",
    "_alpaca_cached_last_good",
    "_check_alpaca",
    "_tca_row_payload",
    "_load_tca_summary",
    "_load_clickhouse_ta_status",
    "_budget_exhausted_live_submission_gate_payload",
    "_budget_exhausted_options_catalog_freshness_payload",
    "_route_claim_symbols",
    "_load_cached_options_catalog_freshness_summary",
    "_store_options_catalog_freshness_summary",
    "_decimal_or_none",
    "_sqlalchemy_error_indicates_statement_timeout",
    "_load_bounded_options_catalog_freshness_summary",
    "_load_options_catalog_freshness_summary",
    "_resolve_tca_scope_symbols",
    "_ensure_utc_datetime",
    "_load_last_decision_at",
    "_build_hypothesis_runtime_payload",
    "_build_live_submission_gate_payload",
    "_build_simple_lane_status_payload",
]

capture_module_exports(globals(), __all__)
