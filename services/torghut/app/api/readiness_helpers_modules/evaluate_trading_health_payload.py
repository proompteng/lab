# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Extracted Torghut API route and support functions."""

# ruff: noqa: F401,F811,F821
from __future__ import annotations

from ...bootstrap import evaluate_scheduler_status as _evaluate_scheduler_status
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
    append_unique_reason as _append_unique_reason,
    cache_completed_trading_health_surface_payload as _cache_completed_trading_health_surface_payload,
    cached_readiness_dependencies_for_health_surface as _cached_readiness_dependencies_for_health_surface,
    cached_trading_health_surface_payload as _cached_trading_health_surface_payload,
    core_readiness_live_submission_gate as _core_readiness_live_submission_gate,
    evaluate_core_readiness_payload as _evaluate_core_readiness_payload,
    fail_closed_health_evaluation_gate as _fail_closed_health_evaluation_gate,
    guard_live_submission_gate_for_readiness as _guard_live_submission_gate_for_readiness,
    health_surface_timeout_dependency_placeholder as _health_surface_timeout_dependency_placeholder,
    health_surface_timeout_fallback_payload as _health_surface_timeout_fallback_payload,
    minimal_health_surface_timeout_live_submission_gate as _minimal_health_surface_timeout_live_submission_gate,
    minimal_health_surface_timeout_payload as _minimal_health_surface_timeout_payload,
    minimal_health_surface_timeout_proof_floor as _minimal_health_surface_timeout_proof_floor,
    paper_route_target_plan_success_cache as _paper_route_target_plan_success_cache,
    readiness_authority_truthy as _readiness_authority_truthy,
    readiness_dependency_cache_key as _readiness_dependency_cache_key,
    readiness_dependency_checks as _readiness_dependency_checks,
    readiness_dependency_degradation_reason_codes as _readiness_dependency_degradation_reason_codes,
    readiness_dependency_snapshot as _readiness_dependency_snapshot,
    record_trading_health_surface_completion as _record_trading_health_surface_completion,
    retryable_tca_recompute_error as _retryable_tca_recompute_error,
    shared_mapping_items as _shared_mapping_items,
    shared_paper_route_target_plan_from_payload as _shared_paper_route_target_plan_from_payload,
    strip_promotion_authority_claims_for_readiness as _strip_promotion_authority_claims_for_readiness,
    trading_health_surface_cache_key as _trading_health_surface_cache_key,
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
from .evaluate_trading_health_payload_bounded import (
    evaluate_trading_health_payload_bounded as _evaluate_trading_health_payload_bounded,
)
from . import status_dependencies as _status_dependencies
from .universe_dependency import (
    evaluate_universe_dependency as _evaluate_universe_dependency,
)
from ..trading_scheduler_state import get_trading_scheduler


def _evaluate_trading_health_payload(
    *,
    include_database_contract: bool = False,
    allow_stale_dependency_cache: bool = False,
) -> tuple[dict[str, object], int]:
    """Build shared trading health payload and status code."""

    scheduler = get_trading_scheduler()
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
            tca_summary = _status_dependencies.load_tca_summary(
                session,
                scheduler=scheduler,
            )
        _hypothesis_payload, hypothesis_summary, _dependency_quorum = (
            _status_dependencies.build_hypothesis_runtime_payload(
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
    empirical_jobs = _status_dependencies.empirical_jobs_status()
    quant_evidence = load_quant_evidence_status(
        account_label=settings.trading_account_label,
    )
    with SessionLocal() as session:
        live_submission_gate = (
            _status_dependencies.build_api_live_submission_gate_payload(
                scheduler.state,
                session=session,
                hypothesis_summary=_hypothesis_payload,
                empirical_jobs_status=empirical_jobs,
                dspy_runtime_status=dspy_runtime,
                quant_health_status=quant_evidence,
            )
        )
    proof_floor = _status_dependencies.build_profitability_proof_floor_payload(
        state=scheduler.state,
        torghut_revision=main_runtime_value("BUILD_COMMIT"),
        live_submission_gate=live_submission_gate,
        hypothesis_payload=_hypothesis_payload,
        empirical_jobs_status=empirical_jobs,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        tca_summary=tca_summary,
    )
    renewal_bond_profit_escrow = (
        _status_dependencies.build_renewal_bond_profit_escrow_payload(
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
    )
    route_reacquisition_board = (
        _status_dependencies.build_route_reacquisition_board_payload(
            proof_floor=proof_floor,
            active_revision=main_runtime_value("BUILD_COMMIT"),
        )
    )
    profit_signal_quorum = _status_dependencies.build_profit_signal_quorum_payload(
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
        options_catalog_freshness = (
            _status_dependencies.load_options_catalog_freshness_summary(
                session,
                route_symbols=_status_dependencies.route_claim_symbols(
                    profit_signal_quorum
                ),
            )
        )
    capital_replay_projection = (
        _status_dependencies.build_capital_replay_projection_payload(
            torghut_revision=main_runtime_value("BUILD_COMMIT"),
            dependency_quorum=_dependency_quorum.as_payload(),
            live_submission_gate=live_submission_gate,
            proof_floor=proof_floor,
            route_reacquisition_board=route_reacquisition_board,
            empirical_jobs_status=empirical_jobs,
            quant_evidence=quant_evidence,
            market_context_status=market_context_status,
        )
    )
    quality_adjusted_profit_frontier = (
        _status_dependencies.build_quality_adjusted_profit_frontier_payload(
            torghut_revision=main_runtime_value("BUILD_COMMIT"),
            live_submission_gate=live_submission_gate,
            proof_floor=proof_floor,
            route_reacquisition_board=route_reacquisition_board,
            hypothesis_payload=_hypothesis_payload,
            quant_evidence=quant_evidence,
            market_context_status=market_context_status,
            active_simulation_context=active_simulation_runtime_context(),
        )
    )
    consumer_evidence_receipt, route_proven_profit_receipt = (
        _status_dependencies.build_consumer_evidence_receipt_projection(
            forecast_service_status=_status_dependencies.forecast_service_status(
                empirical_jobs
            ),
            empirical_jobs_status=empirical_jobs,
            proof_floor=proof_floor,
            live_submission_gate=live_submission_gate,
            serving_revision=_status_dependencies.active_runtime_revision()
            or main_runtime_value("BUILD_COMMIT"),
        )
    )
    capital_reentry_cohort_ledger = (
        _status_dependencies.build_capital_reentry_cohort_ledger_payload(
            torghut_revision=main_runtime_value("BUILD_COMMIT"),
            dependency_quorum=_dependency_quorum.as_payload(),
            consumer_evidence_receipt=consumer_evidence_receipt,
            proof_floor=proof_floor,
            route_reacquisition_board=route_reacquisition_board,
        )
    )
    profit_repair_settlement_ledger = (
        _status_dependencies.build_profit_repair_settlement_ledger_payload(
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
    )
    routeability_repair_acceptance_ledger = (
        _status_dependencies.build_routeability_repair_acceptance_ledger_payload(
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
    profit_freshness_frontier = (
        _status_dependencies.build_profit_freshness_frontier_payload(
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
    )
    build_payload = {
        "version": BUILD_VERSION,
        "commit": main_runtime_value("BUILD_COMMIT"),
        "image_digest": BUILD_IMAGE_DIGEST,
        "active_revision": _status_dependencies.active_runtime_revision()
        or main_runtime_value("BUILD_COMMIT"),
    }
    clickhouse_ta_status = _status_dependencies.load_clickhouse_ta_status(scheduler)
    evidence_clock_arbiter, routeable_profit_candidate_exchange = (
        _status_dependencies.build_evidence_clock_payloads(
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
    clock_settlement_receipt = _status_dependencies.build_clock_settlement_payload(
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
        rollout_status=_status_dependencies.build_route_image_proof_summary(
            build=build_payload,
            dependency_quorum=_dependency_quorum.as_payload(),
        ),
    )
    route_evidence_clearinghouse_packet = (
        _status_dependencies.build_route_evidence_clearinghouse_payload(
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
    )
    repair_bid_settlement_ledger = (
        _status_dependencies.build_repair_bid_settlement_payload(
            torghut_revision=main_runtime_value("BUILD_COMMIT"),
            source_commit=main_runtime_value("BUILD_COMMIT"),
            dependency_quorum=_dependency_quorum.as_payload(),
            build=build_payload,
            route_evidence_clearinghouse_packet=route_evidence_clearinghouse_packet,
            routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
            quant_evidence=quant_evidence,
            profit_freshness_frontier=profit_freshness_frontier,
        )
    )
    route_warrant_exchange = _status_dependencies.build_route_warrant_exchange_payload(
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
    source_serving_repair_receipt_ledger = (
        _status_dependencies.build_source_serving_repair_receipt_payload(
            source_commit=main_runtime_value("BUILD_COMMIT"),
            build=build_payload,
            consumer_evidence_receipt=consumer_evidence_receipt,
            route_evidence_clearinghouse_packet=route_evidence_clearinghouse_packet,
            repair_bid_settlement_ledger=repair_bid_settlement_ledger,
            route_warrant_exchange=route_warrant_exchange,
        )
    )
    freshness_carry_ledger = _status_dependencies.build_freshness_carry_ledger_payload(
        source_serving_repair_receipt_ledger=source_serving_repair_receipt_ledger,
        route_warrant_exchange=route_warrant_exchange,
        clickhouse_ta_status=clickhouse_ta_status,
        tca_summary=tca_summary,
        empirical_jobs_status=empirical_jobs,
        market_context_status=market_context_status,
        quant_evidence=quant_evidence,
        live_submission_gate=live_submission_gate,
    )
    repair_receipt_frontier = (
        _status_dependencies.build_repair_receipt_frontier_payload(
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
    )
    repair_outcome_dividend_ledger = (
        _status_dependencies.build_repair_outcome_dividend_ledger_payload(
            repair_bid_settlement_ledger=repair_bid_settlement_ledger,
            repair_receipt_frontier=repair_receipt_frontier,
            freshness_carry_ledger=freshness_carry_ledger,
            route_warrant_exchange=route_warrant_exchange,
            live_submission_gate=live_submission_gate,
        )
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
        **_status_dependencies.revenue_repair_topline_fields(revenue_repair_digest),
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


__all__ = [name for name in globals() if not name.startswith("__")]

# Public aliases used by split modules.
evaluate_trading_health_payload = _evaluate_trading_health_payload
evaluate_universe_dependency = _evaluate_universe_dependency
