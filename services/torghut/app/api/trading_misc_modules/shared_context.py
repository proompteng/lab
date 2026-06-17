# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
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
    paper_route_target_plan_success_cache as _paper_route_target_plan_success_cache,
    retryable_tca_recompute_error as _retryable_tca_recompute_error,
    shared_mapping_items as _shared_mapping_items,
    shared_paper_route_target_plan_from_payload as _shared_paper_route_target_plan_from_payload,
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

router = APIRouter()


def _consumer_evidence_dependency_quorum() -> JangarDependencyQuorumStatus:
    dependency_quorum = load_jangar_dependency_quorum(
        omit_torghut_consumer_evidence=True,
    )
    if dependency_quorum.reasons != ["jangar_control_plane_status_url_missing"]:
        return dependency_quorum

    return JangarDependencyQuorumStatus(
        decision="allow",
        reasons=[],
        message=CONSUMER_EVIDENCE_CONTROL_PLANE_DEPENDENCY_MESSAGE,
    )


def _build_consumer_evidence_receipt_projection(
    *,
    forecast_service_status: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    serving_revision: str | None,
) -> tuple[dict[str, object], dict[str, object]]:
    consumer_evidence_receipt = build_torghut_consumer_evidence_receipt(
        forecast_service_status=forecast_service_status,
        empirical_jobs_status=empirical_jobs_status,
        proof_floor=proof_floor,
        live_submission_gate=live_submission_gate,
    )
    route_proven_profit_receipt = build_route_proven_profit_receipt(
        consumer_evidence_receipt=consumer_evidence_receipt,
        proof_floor=proof_floor,
        source_commit=main_runtime_value("BUILD_COMMIT"),
        serving_revision=serving_revision,
        image_digest=BUILD_IMAGE_DIGEST,
    )
    return consumer_evidence_receipt, route_proven_profit_receipt


def _consumer_evidence_summary_view(view: str | None) -> bool:
    return (view or "").strip().lower() in {"compact", "summary", "jangar"}


def _revenue_repair_topline_fields(
    revenue_repair_digest: Mapping[str, Any],
) -> dict[str, object]:
    keys = (
        "business_state",
        "revenue_ready",
        "capital_state",
        "capital_stage",
        "live_submission_allowed",
        "max_notional",
        "top_repair_queue_item",
        "selected_value_gate",
        "required_output_receipt",
        "required_receipts",
        "routeable_candidate_count_before",
        "routeable_candidate_count_after",
        "accepted_routeable_candidate_count",
        "routeable_candidate_delta",
        "alpha_no_delta_release_key",
        "no_delta_reentry_decision",
        "no_delta_reentry_reason_codes",
        "field_unavailable_reason_codes",
        "validation_commands",
        "rollback_target",
    )
    return {
        "revenue_repair_digest_ref": "/trading/revenue-repair",
        **{key: revenue_repair_digest.get(key) for key in keys},
    }


def _build_trading_consumer_evidence_payload(
    *, summary: bool = False
) -> dict[str, object]:
    scheduler: TradingScheduler | None = getattr(app.state, "trading_scheduler", None)
    if scheduler is None:
        scheduler = TradingScheduler()
        app.state.trading_scheduler = scheduler
    state = scheduler.state
    dependency_quorum = _consumer_evidence_dependency_quorum()
    empirical_jobs = _empirical_jobs_status()
    quant_evidence = load_quant_evidence_status(
        account_label=settings.trading_account_label,
    )
    forecast_service_status = _forecast_service_status(empirical_jobs)
    lean_authority_status = _lean_authority_status()
    with SessionLocal() as session:
        tca_summary = _load_tca_summary(session, scheduler=scheduler)
        readiness_dependencies, _readiness_checked_at, _readiness_cache_used = (
            _readiness_dependency_snapshot(
                session,
                include_database_contract=True,
                allow_stale_dependency_cache=True,
            )
        )
    market_context_status = scheduler.market_context_status()
    hypothesis_payload, hypothesis_summary, _dependency_quorum = (
        _build_hypothesis_runtime_payload(
            scheduler,
            tca_summary=tca_summary,
            market_context_status=market_context_status,
            dependency_quorum=dependency_quorum,
        )
    )
    with SessionLocal() as session:
        live_submission_gate = _build_live_submission_gate_payload(
            state,
            session=session,
            hypothesis_summary=hypothesis_payload,
            empirical_jobs_status=empirical_jobs,
            dspy_runtime_status=cast(
                dict[str, object],
                scheduler.llm_status().get("dspy_runtime", {}),
            ),
            quant_health_status=quant_evidence,
        )
    simple_lane_status = _build_simple_lane_status_payload()
    shadow_first_runtime = _build_shadow_first_runtime_payload(
        state=state,
        hypothesis_summary=hypothesis_summary,
    )
    build_payload = {
        "version": BUILD_VERSION,
        "commit": main_runtime_value("BUILD_COMMIT"),
        "image_digest": BUILD_IMAGE_DIGEST,
        "active_revision": shadow_first_runtime["active_revision"],
    }
    proof_floor = _build_profitability_proof_floor_payload(
        state=state,
        torghut_revision=str(shadow_first_runtime["active_revision"]),
        live_submission_gate=live_submission_gate,
        hypothesis_payload=hypothesis_payload,
        empirical_jobs_status=empirical_jobs,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        tca_summary=tca_summary,
        simple_lane_status=simple_lane_status,
    )
    consumer_evidence_receipt, route_proven_profit_receipt = (
        _build_consumer_evidence_receipt_projection(
            forecast_service_status=forecast_service_status,
            empirical_jobs_status=empirical_jobs,
            proof_floor=proof_floor,
            live_submission_gate=live_submission_gate,
            serving_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        )
    )
    control_plane_dependency_mode = (
        "caller_evaluated"
        if dependency_quorum.message
        == CONSUMER_EVIDENCE_CONTROL_PLANE_DEPENDENCY_MESSAGE
        else "jangar_status_non_recursive"
    )
    if summary:
        return {
            "schema_version": "torghut.consumer-evidence-status.v1",
            "view": "summary",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "enabled": settings.trading_enabled,
            "mode": settings.trading_mode,
            "running": state.running,
            "build": build_payload,
            "control_plane_dependency_mode": control_plane_dependency_mode,
            "dependency_quorum": dependency_quorum.as_payload(),
            "forecast_service": forecast_service_status,
            "lean_authority": lean_authority_status,
            "empirical_jobs": empirical_jobs,
            "market_context": market_context_status,
            "quant_evidence": quant_evidence,
            "live_submission_gate": live_submission_gate,
            "proof_floor": proof_floor,
            "simple_lane_status": simple_lane_status,
            "torghut_consumer_evidence_receipt": consumer_evidence_receipt,
            "route_proven_profit_receipt": route_proven_profit_receipt,
            "consumer_evidence_canary": route_proven_profit_receipt.get("route_canary"),
        }
    route_reacquisition_board = build_route_reacquisition_board(
        proof_floor_receipt=proof_floor,
        route_reacquisition_book=cast(
            Mapping[str, Any] | None,
            proof_floor.get("route_reacquisition_book"),
        ),
        active_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        jangar_continuity=_consumer_evidence_jangar_continuity_packet(
            dependency_quorum.as_payload()
        ),
    )
    capital_replay_projection = _build_capital_replay_projection_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        dependency_quorum=dependency_quorum.as_payload(),
        live_submission_gate=live_submission_gate,
        proof_floor=proof_floor,
        route_reacquisition_board=route_reacquisition_board,
        empirical_jobs_status=empirical_jobs,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
    )
    profit_signal_quorum = _build_profit_signal_quorum_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        dependency_quorum=dependency_quorum.as_payload(),
        hypothesis_payload=hypothesis_payload,
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
    capital_reentry_cohort_ledger = _build_capital_reentry_cohort_ledger_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        dependency_quorum=dependency_quorum.as_payload(),
        consumer_evidence_receipt=consumer_evidence_receipt,
        proof_floor=proof_floor,
        route_reacquisition_board=route_reacquisition_board,
    )
    quality_adjusted_profit_frontier = _build_quality_adjusted_profit_frontier_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        live_submission_gate=live_submission_gate,
        proof_floor=proof_floor,
        route_reacquisition_board=route_reacquisition_board,
        hypothesis_payload=hypothesis_payload,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        active_simulation_context=active_simulation_runtime_context(),
    )
    profit_repair_settlement_ledger = _build_profit_repair_settlement_ledger_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        dependency_quorum=dependency_quorum.as_payload(),
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
            torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
            dependency_quorum=dependency_quorum.as_payload(),
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
    clickhouse_ta_status = _load_clickhouse_ta_status(scheduler)
    route_evidence_clearinghouse_packet = _build_route_evidence_clearinghouse_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        source_commit=main_runtime_value("BUILD_COMMIT"),
        dependency_quorum=dependency_quorum.as_payload(),
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
    profit_freshness_frontier = _build_profit_freshness_frontier_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        dependency_quorum=dependency_quorum.as_payload(),
        proof_floor=proof_floor,
        routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
        quality_adjusted_profit_frontier=quality_adjusted_profit_frontier,
        route_reacquisition_board=route_reacquisition_board,
        live_submission_gate=live_submission_gate,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        empirical_jobs_status=empirical_jobs,
        hypothesis_payload=hypothesis_payload,
    )
    repair_bid_settlement_ledger = _build_repair_bid_settlement_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        source_commit=main_runtime_value("BUILD_COMMIT"),
        dependency_quorum=dependency_quorum.as_payload(),
        build=build_payload,
        route_evidence_clearinghouse_packet=route_evidence_clearinghouse_packet,
        routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
        quant_evidence=quant_evidence,
        profit_freshness_frontier=profit_freshness_frontier,
    )
    revenue_repair_digest = build_revenue_repair_digest(
        readyz_payload={
            "status": "degraded"
            if live_submission_gate.get("allowed") is not True
            else "ok",
            "proof_floor": proof_floor,
            "live_submission_gate": live_submission_gate,
            "quant_evidence": quant_evidence,
            "dependencies": readiness_dependencies,
        },
        status_payload={
            "mode": settings.trading_mode,
            "pipeline_mode": "simple",
            "build": build_payload,
            "dependency_quorum": dependency_quorum.as_payload(),
            "live_submission_gate": live_submission_gate,
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
            "controller_ingestion_settlement": dependency_quorum.as_payload().get(
                "controller_ingestion_settlement"
            ),
            "verify_trust_foreclosure_board": dependency_quorum.as_payload().get(
                "verify_trust_foreclosure_board"
            ),
            "repair_slot_escrow": dependency_quorum.as_payload().get(
                "repair_slot_escrow"
            ),
            "stage_debt_repair_admission": dependency_quorum.as_payload().get(
                "stage_debt_repair_admission"
            ),
            "foreclosure_carry_rollout_witness": dependency_quorum.as_payload().get(
                "foreclosure_carry_rollout_witness"
            ),
        },
        generated_at=datetime.now(timezone.utc),
    )
    evidence_clock_arbiter, routeable_profit_candidate_exchange = (
        _build_evidence_clock_payloads(
            torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
            dependency_quorum=dependency_quorum.as_payload(),
            hypothesis_payload=hypothesis_payload,
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
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
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
            dependency_quorum=dependency_quorum.as_payload(),
        ),
    )
    route_warrant_exchange = _build_route_warrant_exchange_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
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
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
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
    profit_carry_passport_ledger = _build_profit_carry_passport_ledger_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        capital_replay_board=cast(
            Mapping[str, Any],
            capital_replay_projection["capital_replay_board"],
        ),
        route_reacquisition_board=route_reacquisition_board,
        proof_floor=proof_floor,
        market_context_status=market_context_status,
        hypothesis_payload=hypothesis_payload,
        repair_outcome_dividend_ledger=repair_outcome_dividend_ledger,
    )
    return {
        "schema_version": "torghut.consumer-evidence-status.v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "enabled": settings.trading_enabled,
        "mode": settings.trading_mode,
        "running": state.running,
        "build": build_payload,
        "control_plane_dependency_mode": control_plane_dependency_mode,
        "dependency_quorum": dependency_quorum.as_payload(),
        "forecast_service": forecast_service_status,
        "lean_authority": lean_authority_status,
        "empirical_jobs": empirical_jobs,
        "market_context": market_context_status,
        "quant_evidence": quant_evidence,
        "live_submission_gate": live_submission_gate,
        "proof_floor": proof_floor,
        "simple_lane_status": simple_lane_status,
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
        "alpha_readiness_strike_ledger": revenue_repair_digest.get(
            "alpha_readiness_strike_ledger"
        ),
        "executable_alpha_repair_receipts": revenue_repair_digest.get(
            "executable_alpha_repair_receipts"
        ),
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
        "route_warrant_exchange": route_warrant_exchange,
        "source_serving_repair_receipt_ledger": source_serving_repair_receipt_ledger,
        "freshness_carry_ledger": freshness_carry_ledger,
        "repair_receipt_frontier": repair_receipt_frontier,
        "repair_outcome_dividend_ledger": repair_outcome_dividend_ledger,
        "profit_carry_passport_ledger": profit_carry_passport_ledger,
    }


@router.get("/trading/consumer-evidence")
def trading_consumer_evidence(
    view: str | None = Query(default=None),
) -> dict[str, object]:
    """Return Jangar-facing Torghut evidence without recursive Jangar status fetches."""

    return _build_trading_consumer_evidence_payload(
        summary=_consumer_evidence_summary_view(view)
    )


@router.get("/trading/metrics")
def trading_metrics(session: Session = Depends(get_session)) -> dict[str, object]:
    """Expose trading metrics counters."""

    scheduler: TradingScheduler | None = getattr(app.state, "trading_scheduler", None)
    if scheduler is None:
        scheduler = TradingScheduler()
        app.state.trading_scheduler = scheduler
    metrics = scheduler.state.metrics
    market_context_status = scheduler.market_context_status()
    tca_summary = _load_tca_summary(session, scheduler=scheduler)
    _hypothesis_payload, hypothesis_summary, hypothesis_dependency_quorum = (
        _build_hypothesis_runtime_payload(
            scheduler,
            tca_summary=tca_summary,
            market_context_status=market_context_status,
        )
    )
    shadow_first_runtime = _build_shadow_first_runtime_payload(
        state=scheduler.state,
        hypothesis_summary=hypothesis_summary,
    )
    return {
        "metrics": metrics.__dict__,
        "build": {
            "version": BUILD_VERSION,
            "commit": main_runtime_value("BUILD_COMMIT"),
            "image_digest": BUILD_IMAGE_DIGEST,
            "active_revision": shadow_first_runtime["active_revision"],
        },
        "shadow_first": shadow_first_runtime,
        "tca": tca_summary,
        "control_plane_contract": _build_control_plane_contract(
            scheduler.state,
            hypothesis_summary=hypothesis_summary,
            dependency_quorum=hypothesis_dependency_quorum,
        ),
    }


@router.get("/trading/simulation/progress")
def trading_simulation_progress(
    run_id: str | None = Query(default=None),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Expose durable simulation progress for the current or requested run."""

    snapshot = simulation_progress_snapshot(session, run_id=run_id)
    active_runtime_context = active_simulation_runtime_context(session)
    snapshot["requested_run_id"] = run_id
    snapshot["active_run_id"] = (active_runtime_context or {}).get(
        "run_id"
    ) or settings.trading_simulation_run_id
    snapshot["simulation_enabled"] = settings.trading_simulation_enabled
    return cast(dict[str, object], snapshot)


@router.post("/trading/lean/backtests")
def submit_lean_backtest(
    payload: dict[str, object] = Body(default={}),
    requested_by: str | None = Query(default=None),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Submit an asynchronous LEAN backtest and persist metadata for governance."""

    if settings.trading_lean_lane_disable_switch:
        raise HTTPException(status_code=409, detail="lean_lane_disabled")
    if not settings.trading_lean_backtest_enabled:
        raise HTTPException(status_code=409, detail="lean_backtest_lane_disabled")
    lane = str(payload.get("lane") or "research").strip() or "research"
    config_payload = payload.get("config")
    if not isinstance(config_payload, dict):
        raise HTTPException(status_code=400, detail="config_must_be_object")
    config = {
        str(key): value
        for key, value in cast(dict[object, Any], config_payload).items()
    }
    try:
        row = LEAN_LANE_MANAGER.submit_backtest(
            session,
            config=config,
            lane=lane,
            requested_by=requested_by,
            correlation_id=f"torghut-backtest-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}",
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "backtest_id": row.backtest_id,
        "status": row.status,
        "lane": row.lane,
        "reproducibility_hash": row.reproducibility_hash,
        "requested_by": row.requested_by,
        "created_at": row.created_at,
    }


@router.get("/trading/lean/backtests/{backtest_id}")
def get_lean_backtest(
    backtest_id: str, session: Session = Depends(get_session)
) -> dict[str, object]:
    """Refresh and return LEAN backtest lifecycle state and reproducibility evidence."""

    try:
        row = LEAN_LANE_MANAGER.refresh_backtest(session, backtest_id=backtest_id)
    except RuntimeError as exc:
        detail = str(exc)
        status = 404 if detail == "lean_backtest_not_found" else 502
        raise HTTPException(status_code=status, detail=detail) from exc
    return {
        "backtest_id": row.backtest_id,
        "status": row.status,
        "lane": row.lane,
        "result": row.result_json,
        "artifacts": row.artifacts_json,
        "reproducibility_hash": row.reproducibility_hash,
        "replay_hash": row.replay_hash,
        "deterministic_replay_passed": row.deterministic_replay_passed,
        "failure_taxonomy": row.failure_taxonomy,
        "completed_at": row.completed_at,
    }


@router.get("/trading/lean/shadow/parity")
def get_lean_shadow_parity(
    lookback_hours: int = Query(default=24, ge=1, le=168),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Return LEAN shadow execution parity summary for drift detection and governance."""

    summary = LEAN_LANE_MANAGER.parity_summary(
        session,
        lookback_hours=lookback_hours,
    )
    return summary


__all__ = [name for name in globals() if not name.startswith("__")]

# Public aliases used by split modules.
ACCOUNT_SCOPE_STATEMENT_TIMEOUT_MS = _ACCOUNT_SCOPE_STATEMENT_TIMEOUT_MS
ALPACA_HEALTH_CACHE_LOCK = _ALPACA_HEALTH_CACHE_LOCK
ALPACA_HEALTH_STATE = _ALPACA_HEALTH_STATE
build_consumer_evidence_receipt_projection = _build_consumer_evidence_receipt_projection
build_trading_consumer_evidence_payload = _build_trading_consumer_evidence_payload
consumer_evidence_dependency_quorum = _consumer_evidence_dependency_quorum
consumer_evidence_summary_view = _consumer_evidence_summary_view
OPTIONS_CATALOG_FRESHNESS_CACHE = _OPTIONS_CATALOG_FRESHNESS_CACHE
OPTIONS_CATALOG_FRESHNESS_CACHE_LOCK = _OPTIONS_CATALOG_FRESHNESS_CACHE_LOCK
PAPER_ROUTE_BOUNDED_COLLECTION_ACCOUNT_LABEL = (
    _PAPER_ROUTE_BOUNDED_COLLECTION_ACCOUNT_LABEL
)
PAPER_ROUTE_TARGET_PLAN_STALE_SUCCESS_SECONDS = (
    _PAPER_ROUTE_TARGET_PLAN_STALE_SUCCESS_SECONDS
)
paper_route_target_plan_success_cache = _paper_route_target_plan_success_cache
PAPER_ROUTE_TARGET_PLAN_SUCCESS_CACHE_LOCK = _PAPER_ROUTE_TARGET_PLAN_SUCCESS_CACHE_LOCK
READINESS_PROMOTION_AUTHORITY_KEYS = _READINESS_PROMOTION_AUTHORITY_KEYS
retryable_tca_recompute_error = _retryable_tca_recompute_error
RETRYABLE_TCA_RECOMPUTE_SQLSTATES = _RETRYABLE_TCA_RECOMPUTE_SQLSTATES
revenue_repair_topline_fields = _revenue_repair_topline_fields
shared_mapping_items = _shared_mapping_items
shared_paper_route_target_plan_from_payload = (
    _shared_paper_route_target_plan_from_payload
)
SIMPLE_LANE_ALLOWED_REJECT_REASONS = _SIMPLE_LANE_ALLOWED_REJECT_REASONS
TRADING_DEPENDENCY_HEALTH_CACHE = _TRADING_DEPENDENCY_HEALTH_CACHE
TRADING_DEPENDENCY_HEALTH_CACHE_LOCK = _TRADING_DEPENDENCY_HEALTH_CACHE_LOCK
TRADING_HEALTH_SURFACE_EVALUATION_EXECUTOR = _TRADING_HEALTH_SURFACE_EVALUATION_EXECUTOR
TRADING_HEALTH_SURFACE_EVALUATION_LOCK = _TRADING_HEALTH_SURFACE_EVALUATION_LOCK
TRADING_HEALTH_SURFACE_EVALUATIONS = _TRADING_HEALTH_SURFACE_EVALUATIONS
TRADING_HEALTH_SURFACE_PAYLOAD_CACHE = _TRADING_HEALTH_SURFACE_PAYLOAD_CACHE
TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS = _TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS
TRADING_STATUS_READ_BUDGET_SECONDS = _TRADING_STATUS_READ_BUDGET_SECONDS
ZERO_NOTIONAL_TCA_RECOMPUTE_MAX_ATTEMPTS = _ZERO_NOTIONAL_TCA_RECOMPUTE_MAX_ATTEMPTS
