# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Extracted Torghut API route and support functions."""

# ruff: noqa: F401, F821
from __future__ import annotations

from fastapi import APIRouter
from typing import Any, TYPE_CHECKING

# ruff: noqa: F401, F821

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
    build_capital_reentry_cohort_ledger_payload as _build_capital_reentry_cohort_ledger_payload,
    build_capital_replay_projection_payload as _build_capital_replay_projection_payload,
    build_clock_settlement_payload as _build_clock_settlement_payload,
    build_evidence_clock_payloads as _build_evidence_clock_payloads,
    build_freshness_carry_ledger_payload as _build_freshness_carry_ledger_payload,
    build_jangar_contract_graduation_ref as _build_jangar_contract_graduation_ref,
    build_jangar_execution_trust_admission_ref as _build_jangar_execution_trust_admission_ref,
    build_jangar_material_verdict_ref as _build_jangar_material_verdict_ref,
    build_profit_carry_passport_ledger_payload as _build_profit_carry_passport_ledger_payload,
    build_profit_freshness_frontier_payload as _build_profit_freshness_frontier_payload,
    build_profit_repair_settlement_ledger_payload as _build_profit_repair_settlement_ledger_payload,
    build_profitability_proof_floor_payload as _build_profitability_proof_floor_payload,
    build_renewal_bond_profit_escrow_payload as _build_renewal_bond_profit_escrow_payload,
    build_repair_bid_settlement_payload as _build_repair_bid_settlement_payload,
    build_repair_outcome_dividend_ledger_payload as _build_repair_outcome_dividend_ledger_payload,
    build_repair_receipt_frontier_payload as _build_repair_receipt_frontier_payload,
    build_route_evidence_clearinghouse_payload as _build_route_evidence_clearinghouse_payload,
    build_route_image_proof_summary as _build_route_image_proof_summary,
    build_route_reacquisition_board_payload as _build_route_reacquisition_board_payload,
    build_route_warrant_exchange_payload as _build_route_warrant_exchange_payload,
    build_routeability_repair_acceptance_ledger_payload as _build_routeability_repair_acceptance_ledger_payload,
    build_source_serving_repair_receipt_payload as _build_source_serving_repair_receipt_payload,
    consumer_evidence_jangar_continuity_packet as _consumer_evidence_jangar_continuity_packet,
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


def _build_jangar_reliability_settlement_ref(
    dependency_quorum: Mapping[str, Any],
) -> dict[str, object]:
    raw_settlement = (
        dependency_quorum.get("reliability_settlement_ledger")
        or dependency_quorum.get("reliability_settlement")
        or dependency_quorum.get("rollout_slo_escrow")
    )
    settlement: Mapping[str, Any] = (
        cast(Mapping[str, Any], raw_settlement)
        if isinstance(raw_settlement, Mapping)
        else {}
    )
    decision = (
        str(
            settlement.get("decision")
            or settlement.get("state")
            or dependency_quorum.get("decision")
            or "missing"
        )
        .strip()
        .lower()
    )
    state = (
        str(
            settlement.get("state")
            or settlement.get("status")
            or ("current" if decision == "allow" else "missing")
        )
        .strip()
        .lower()
    )
    raw_reasons: object = (
        settlement.get("reason_codes")
        or settlement.get("blocking_reasons")
        or dependency_quorum.get("reasons")
        or []
    )
    reason_items: Sequence[object] = (
        cast(Sequence[object], raw_reasons)
        if isinstance(raw_reasons, Sequence)
        and not isinstance(raw_reasons, (str, bytes, bytearray))
        else ()
    )
    reasons = [str(item).strip() for item in reason_items if str(item).strip()]
    ref_suffix = decision if not reasons else f"{decision}:{','.join(sorted(reasons))}"
    return {
        "settlement_ref": settlement.get("ledger_id")
        or settlement.get("settlement_ref")
        or f"jangar-reliability-settlement:dependency-quorum:{ref_suffix}",
        "ledger_id": settlement.get("ledger_id"),
        "decision": decision,
        "state": state,
        "reason_codes": reasons,
        "source": "reliability_settlement_ledger"
        if settlement.get("ledger_id") or settlement.get("settlement_ref")
        else "dependency_quorum_proxy",
        "generated_at": settlement.get("generated_at")
        or dependency_quorum.get("generated_at"),
        "fresh_until": settlement.get("fresh_until")
        or dependency_quorum.get("fresh_until"),
        "action_classes": ["torghut_observe", "paper_canary"],
    }


def _build_torghut_routeability_admission_ref(
    dependency_quorum: Mapping[str, Any],
) -> dict[str, object]:
    raw_admission = dependency_quorum.get("routeability_admission")
    empty_admission: Mapping[str, Any] = {}
    admission: Mapping[str, Any] = (
        cast(Mapping[str, Any], raw_admission)
        if isinstance(raw_admission, Mapping)
        else empty_admission
    )
    decision = (
        str(
            admission.get("decision")
            or admission.get("state")
            or dependency_quorum.get("decision")
            or "missing"
        )
        .strip()
        .lower()
    )
    state = (
        str(
            admission.get("state")
            or admission.get("status")
            or ("current" if decision == "allow" else "missing")
        )
        .strip()
        .lower()
    )
    raw_reasons: object = (
        admission.get("reason_codes")
        or admission.get("blocking_reasons")
        or dependency_quorum.get("reasons")
        or []
    )
    reason_items: Sequence[object] = (
        cast(Sequence[object], raw_reasons)
        if isinstance(raw_reasons, Sequence)
        and not isinstance(raw_reasons, (str, bytes, bytearray))
        else ()
    )
    reasons = [str(item).strip() for item in reason_items if str(item).strip()]
    ref_suffix = decision if not reasons else f"{decision}:{','.join(sorted(reasons))}"
    return {
        "admission_ref": f"jangar-routeability-admission:dependency-quorum:{ref_suffix}",
        "decision": decision,
        "state": state,
        "reason_codes": reasons,
        "source": "routeability_admission"
        if admission.get("admission_ref") or admission.get("id")
        else "dependency_quorum_proxy",
        "action_classes": ["torghut_observe", "paper_canary"],
        "generated_at": admission.get("generated_at")
        or dependency_quorum.get("generated_at"),
        "fresh_until": admission.get("fresh_until")
        or dependency_quorum.get("fresh_until"),
    }


def _build_torghut_stage_clearance_packet_ref(
    dependency_quorum: Mapping[str, Any],
) -> dict[str, object]:
    raw_packet = dependency_quorum.get("stage_clearance_packet")
    packet: Mapping[str, Any] = (
        cast(Mapping[str, Any], raw_packet) if isinstance(raw_packet, Mapping) else {}
    )
    decision = (
        str(
            packet.get("decision")
            or packet.get("state")
            or dependency_quorum.get("decision")
            or "missing"
        )
        .strip()
        .lower()
    )
    raw_reasons: object = (
        packet.get("reason_codes")
        or packet.get("blocking_reasons")
        or dependency_quorum.get("reasons")
        or []
    )
    reason_items: Sequence[object] = (
        cast(Sequence[object], raw_reasons)
        if isinstance(raw_reasons, Sequence)
        and not isinstance(raw_reasons, (str, bytes, bytearray))
        else ()
    )
    return {
        "packet_id": packet.get("packet_id") or packet.get("id"),
        "decision": decision,
        "state": packet.get("state")
        or ("current" if decision == "allow" else "missing"),
        "action_class": packet.get("action_class") or "torghut_capital",
        "reason_codes": [
            str(item).strip() for item in reason_items if str(item).strip()
        ],
        "source": "stage_clearance_packet"
        if packet.get("packet_id") or packet.get("id")
        else "dependency_quorum_proxy",
        "generated_at": packet.get("generated_at")
        or dependency_quorum.get("generated_at"),
        "fresh_until": packet.get("fresh_until")
        or dependency_quorum.get("fresh_until"),
    }


def _build_profit_signal_quorum_payload(
    *,
    torghut_revision: str | None,
    dependency_quorum: Mapping[str, Any],
    hypothesis_payload: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
) -> dict[str, object]:
    return build_profit_signal_quorum(
        account_label=settings.trading_account_label,
        trading_mode=settings.trading_mode,
        torghut_revision=torghut_revision,
        hypothesis_payload=hypothesis_payload,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        proof_floor_receipt=proof_floor,
        route_reacquisition_board=route_reacquisition_board,
        live_submission_gate=live_submission_gate,
        torghut_stage_clearance_packet=_build_torghut_stage_clearance_packet_ref(
            dependency_quorum
        ),
    )


def _simulation_cache_status_payload(
    active_simulation_context: Mapping[str, Any] | None,
) -> dict[str, object]:
    context = active_simulation_context or {}
    return {
        "enabled": settings.trading_simulation_enabled,
        "run_id": context.get("run_id") or settings.trading_simulation_run_id,
        "dataset_id": context.get("dataset_id")
        or settings.trading_simulation_dataset_id,
        "window_start": context.get("window_start")
        or settings.trading_simulation_window_start,
        "window_end": context.get("window_end")
        or settings.trading_simulation_window_end,
        "last_updated_at": context.get("last_updated_at") or context.get("updated_at"),
    }


def _build_quality_adjusted_profit_frontier_payload(
    *,
    torghut_revision: str | None,
    live_submission_gate: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    hypothesis_payload: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    active_simulation_context: Mapping[str, Any] | None,
) -> dict[str, object]:
    return build_quality_adjusted_profit_frontier(
        account_label=settings.trading_account_label,
        trading_mode=settings.trading_mode,
        torghut_revision=torghut_revision,
        proof_floor_receipt=proof_floor,
        route_reacquisition_board=route_reacquisition_board,
        live_submission_gate=live_submission_gate,
        hypothesis_payload=hypothesis_payload,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        simulation_cache_status=_simulation_cache_status_payload(
            active_simulation_context
        ),
        jangar_evidence_quality=_route_continuity_packet_for_proof_floor(proof_floor),
    )


def _build_autonomy_capital_replay_projection(
    scheduler: TradingScheduler,
) -> dict[str, object]:
    dependency_quorum = resolve_hypothesis_dependency_quorum(load_hypothesis_registry())
    try:
        empirical_jobs = _empirical_jobs_status()
        quant_evidence = load_quant_evidence_status(
            account_label=settings.trading_account_label,
        )
        market_context_status = scheduler.market_context_status()
        with SessionLocal() as session:
            tca_summary = _load_tca_summary(session, scheduler=scheduler)
        hypothesis_payload, _hypothesis_summary, dependency_quorum = (
            _build_hypothesis_runtime_payload(
                scheduler,
                tca_summary=tca_summary,
                market_context_status=market_context_status,
                dependency_quorum=dependency_quorum,
            )
        )
        with SessionLocal() as session:
            live_submission_gate = _build_live_submission_gate_payload(
                scheduler.state,
                session=session,
                hypothesis_summary=hypothesis_payload,
                empirical_jobs_status=empirical_jobs,
                dspy_runtime_status=cast(
                    dict[str, object],
                    scheduler.llm_status().get("dspy_runtime", {}),
                ),
                quant_health_status=quant_evidence,
            )
        proof_floor = _build_profitability_proof_floor_payload(
            state=scheduler.state,
            torghut_revision=main_runtime_value("BUILD_COMMIT"),
            live_submission_gate=live_submission_gate,
            hypothesis_payload=hypothesis_payload,
            empirical_jobs_status=empirical_jobs,
            quant_evidence=quant_evidence,
            market_context_status=market_context_status,
            tca_summary=tca_summary,
        )
        route_reacquisition_board = _build_route_reacquisition_board_payload(
            proof_floor=proof_floor,
            active_revision=main_runtime_value("BUILD_COMMIT"),
        )
        return _build_capital_replay_projection_payload(
            torghut_revision=main_runtime_value("BUILD_COMMIT"),
            dependency_quorum=dependency_quorum.as_payload(),
            live_submission_gate=live_submission_gate,
            proof_floor=proof_floor,
            route_reacquisition_board=route_reacquisition_board,
            empirical_jobs_status=empirical_jobs,
            quant_evidence=quant_evidence,
            market_context_status=market_context_status,
        )
    except Exception as exc:  # pragma: no cover - additive autonomy surface only
        return build_capital_replay_projection(
            account_label=settings.trading_account_label,
            trading_mode=settings.trading_mode,
            torghut_revision=main_runtime_value("BUILD_COMMIT"),
            proof_floor_receipt={
                "route_state": "unavailable",
                "capital_state": "zero_notional",
                "blocking_reasons": [
                    f"capital_replay_projection_unavailable:{type(exc).__name__}"
                ],
            },
            route_reacquisition_board={"rows": []},
            live_submission_gate={
                "blocked_reasons": ["capital_replay_projection_unavailable"]
            },
            empirical_jobs_status={},
            quant_evidence={},
            market_context_status={},
            jangar_contract_graduation_ref=_build_jangar_contract_graduation_ref(
                dependency_quorum.as_payload()
            ),
        )


def _route_continuity_packet_for_proof_floor(
    proof_floor: Mapping[str, Any],
) -> dict[str, object]:
    registry = load_hypothesis_registry()
    if hypothesis_registry_requires_dependency_capability(
        registry,
        "jangar_dependency_quorum",
    ):
        return load_jangar_route_continuity_packet(action_class="paper_canary")

    continuity_ref = (
        str(proof_floor.get("generated_at") or "").strip()
        or str(proof_floor.get("torghut_revision") or "").strip()
        or "unknown"
    )
    return {
        "epoch_id": f"torghut-self-continuity:{continuity_ref}",
        "state": "present",
        "decision": "allow",
        "fresh_until": proof_floor.get("fresh_until"),
        "blocking_reasons": [],
        "source": "torghut_hypothesis_registry",
        "action_class": "paper_canary",
    }


def _simple_lane_reject_reason_totals(state: object) -> dict[str, int]:
    metrics = getattr(state, "metrics", None)
    totals = getattr(metrics, "decision_reject_reason_total", {})
    if not isinstance(totals, Mapping):
        return {}
    payload: dict[str, int] = {}
    for key, value in cast(Mapping[object, Any], totals).items():
        normalized = str(key)
        if normalized not in _SIMPLE_LANE_ALLOWED_REJECT_REASONS:
            continue
        payload[normalized] = int(value)
    return payload


def _build_rejected_signal_outcome_learning_payload(
    state: object,
    *,
    persisted_summary: Mapping[str, object] | None = None,
) -> dict[str, object]:
    metrics = getattr(state, "metrics", None)
    total = max(0, int(getattr(metrics, "rejected_signal_events_total", 0) or 0))
    pending = max(
        0,
        int(getattr(metrics, "rejected_signal_outcome_label_pending_total", 0) or 0),
    )
    raw_reasons = getattr(metrics, "rejected_signal_reason_total", {})
    reasons: dict[str, int] = {}
    if isinstance(raw_reasons, Mapping):
        for key, value in cast(Mapping[object, Any], raw_reasons).items():
            reasons[str(key)] = max(0, int(value))
    latest_event = getattr(state, "last_rejected_signal_outcome_event", None)
    latest_payload: dict[str, object] | None = None
    if isinstance(latest_event, Mapping):
        latest_payload = {
            str(key): value
            for key, value in cast(Mapping[object, object], latest_event).items()
        }
    labeled_count = 0
    incomplete_count = 0
    outcome_label_status_total: dict[str, int] = {}
    persistence_state = "not_configured"
    if persisted_summary is not None:
        persistence_state = str(persisted_summary.get("persistence_state") or "ok")
        persisted_total = cast(Any, persisted_summary.get("events_total"))
        total = max(total, int(persisted_total or 0))
        persisted_pending = cast(
            Any, persisted_summary.get("outcome_label_pending_total")
        )
        pending = max(
            pending,
            int(persisted_pending or 0),
        )
        persisted_labeled = cast(Any, persisted_summary.get("labeled_count"))
        labeled_count = max(0, int(persisted_labeled or 0))
        persisted_incomplete = cast(Any, persisted_summary.get("incomplete_count"))
        incomplete_count = max(0, int(persisted_incomplete or 0))
        persisted_status_total = persisted_summary.get("outcome_label_status_total")
        if isinstance(persisted_status_total, Mapping):
            outcome_label_status_total = {
                str(key): max(0, int(value))
                for key, value in cast(
                    Mapping[object, Any], persisted_status_total
                ).items()
            }
        persisted_reasons = persisted_summary.get("reason_total")
        if isinstance(persisted_reasons, Mapping):
            for key, value in cast(Mapping[object, Any], persisted_reasons).items():
                reasons[str(key)] = max(reasons.get(str(key), 0), int(value))
        persisted_latest = persisted_summary.get("latest_event")
        if isinstance(persisted_latest, Mapping):
            latest_payload = {
                str(key): value
                for key, value in cast(
                    Mapping[object, object], persisted_latest
                ).items()
            }
    blockers = ["counterfactual_outcome_labels_pending"] if pending > 0 else []
    state_label = "pending_outcome_labels"
    if pending <= 0:
        state_label = "labeled_outcomes_available" if labeled_count > 0 else "empty"
    return {
        "schema_version": "torghut.rejected-signal-outcome-learning.v1",
        "source": "runtime_quote_quality_gate",
        "paper_source": "paper-arxiv-2605.12151",
        "paper_claim_id": "rejection-event-outcome-labels",
        "state": state_label,
        "events_total": total,
        "outcome_label_pending_total": pending,
        "labeled_count": labeled_count,
        "incomplete_count": incomplete_count,
        "outcome_label_status_total": outcome_label_status_total,
        "reason_total": reasons,
        "latest_event": latest_payload,
        "persistence_state": persistence_state,
        "required_outcome_fields": [
            "counterfactual_return",
            "route_tca",
            "post_cost_net_pnl",
            "executable_quote",
        ],
        "promotion_impact": "repair_only_until_labeled",
        "blocking_reasons": blockers,
    }


def _load_rejected_signal_outcome_learning_summary(
    session: Session,
) -> dict[str, object] | None:
    try:
        total = int(
            session.execute(
                select(func.count(RejectedSignalOutcomeEvent.id))
            ).scalar_one()
            or 0
        )
        pending = int(
            session.execute(
                select(func.count(RejectedSignalOutcomeEvent.id)).where(
                    RejectedSignalOutcomeEvent.outcome_label_status == "pending"
                )
            ).scalar_one()
            or 0
        )
        status_rows = session.execute(
            select(
                RejectedSignalOutcomeEvent.outcome_label_status,
                func.count(RejectedSignalOutcomeEvent.id),
            ).group_by(RejectedSignalOutcomeEvent.outcome_label_status)
        ).all()
        outcome_label_status_total = {
            str(status or "unknown"): int(count or 0) for status, count in status_rows
        }
        reason_rows = session.execute(
            select(
                RejectedSignalOutcomeEvent.reject_reason,
                func.count(RejectedSignalOutcomeEvent.id),
            ).group_by(RejectedSignalOutcomeEvent.reject_reason)
        ).all()
        reason_total = {
            str(reason or "unknown"): int(count or 0) for reason, count in reason_rows
        }
        latest = session.execute(
            select(RejectedSignalOutcomeEvent)
            .order_by(
                RejectedSignalOutcomeEvent.event_ts.desc(),
                RejectedSignalOutcomeEvent.created_at.desc(),
            )
            .limit(1)
        ).scalar_one_or_none()
        latest_payload: dict[str, object] | None = None
        if latest is not None:
            latest_payload = {
                "event_id": latest.event_id,
                "schema_version": "torghut.rejected-signal-outcome-event.v1",
                "source": latest.source,
                "paper_source": latest.paper_source,
                "paper_claim_id": latest.paper_claim_id,
                "account_label": latest.account_label,
                "symbol": latest.symbol,
                "event_ts": latest.event_ts.isoformat(),
                "timeframe": latest.timeframe,
                "seq": latest.seq,
                "reject_reason": latest.reject_reason,
                "spread_bps": str(latest.spread_bps)
                if latest.spread_bps is not None
                else None,
                "jump_bps": str(latest.jump_bps)
                if latest.jump_bps is not None
                else None,
                "outcome_label_status": latest.outcome_label_status,
                "counterfactual_required": latest.counterfactual_required,
                "required_outcome_fields": latest.required_outcome_fields_json,
            }
        return {
            "persistence_state": "ok",
            "events_total": total,
            "outcome_label_pending_total": pending,
            "labeled_count": outcome_label_status_total.get("labeled", 0),
            "incomplete_count": outcome_label_status_total.get("incomplete", 0),
            "outcome_label_status_total": outcome_label_status_total,
            "reason_total": reason_total,
            "latest_event": latest_payload,
        }
    except SQLAlchemyError:
        logger.exception("Failed to load rejected signal outcome learning summary")
        return {"persistence_state": "unavailable"}


def _load_route_provenance_summary(session: Session) -> dict[str, object]:
    window_start = datetime.now(timezone.utc) - timedelta(hours=24)
    row = session.execute(
        select(
            func.count(Execution.id),
            func.count(Execution.id).filter(
                (Execution.execution_expected_adapter.is_(None))
                | (func.btrim(Execution.execution_expected_adapter) == "")
                | (Execution.execution_actual_adapter.is_(None))
                | (func.btrim(Execution.execution_actual_adapter) == "")
            ),
            func.count(Execution.id).filter(
                (func.lower(Execution.execution_expected_adapter) == "unknown")
                | (func.lower(Execution.execution_actual_adapter) == "unknown")
            ),
            func.count(Execution.id).filter(
                func.lower(Execution.execution_expected_adapter)
                != func.lower(Execution.execution_actual_adapter)
            ),
        ).where(Execution.created_at >= window_start)
    ).one()
    total = int(row[0] or 0)
    missing = int(row[1] or 0)
    unknown = int(row[2] or 0)
    mismatch = int(row[3] or 0)
    if total <= 0:
        return {
            "total": 0,
            "missing": 0,
            "unknown": 0,
            "mismatch": 0,
            "coverage_ratio": 0.0,
            "unknown_ratio": 0.0,
            "mismatch_ratio": 0.0,
        }
    safe_total = float(total)
    coverage = max(0.0, (total - missing) / safe_total)
    return {
        "total": total,
        "missing": missing,
        "unknown": unknown,
        "mismatch": mismatch,
        "coverage_ratio": coverage,
        "unknown_ratio": unknown / safe_total,
        "mismatch_ratio": mismatch / safe_total,
    }


build_jangar_reliability_settlement_ref = _build_jangar_reliability_settlement_ref
build_torghut_stage_clearance_packet_ref = _build_torghut_stage_clearance_packet_ref


__all__ = [
    "_build_profitability_proof_floor_payload",
    "_build_renewal_bond_profit_escrow_payload",
    "_build_route_reacquisition_board_payload",
    "_build_jangar_contract_graduation_ref",
    "_build_jangar_material_verdict_ref",
    "_build_jangar_execution_trust_admission_ref",
    "_consumer_evidence_jangar_continuity_packet",
    "_build_capital_replay_projection_payload",
    "_build_profit_carry_passport_ledger_payload",
    "_build_capital_reentry_cohort_ledger_payload",
    "_build_profit_repair_settlement_ledger_payload",
    "_build_profit_freshness_frontier_payload",
    "_build_routeability_repair_acceptance_ledger_payload",
    "_build_evidence_clock_payloads",
    "_build_clock_settlement_payload",
    "_build_route_image_proof_summary",
    "_build_route_evidence_clearinghouse_payload",
    "_build_repair_bid_settlement_payload",
    "_build_route_warrant_exchange_payload",
    "_build_source_serving_repair_receipt_payload",
    "_build_freshness_carry_ledger_payload",
    "_build_repair_receipt_frontier_payload",
    "_build_repair_outcome_dividend_ledger_payload",
    "_build_jangar_reliability_settlement_ref",
    "_build_torghut_routeability_admission_ref",
    "_build_torghut_stage_clearance_packet_ref",
    "_build_profit_signal_quorum_payload",
    "_simulation_cache_status_payload",
    "_build_quality_adjusted_profit_frontier_payload",
    "_build_autonomy_capital_replay_projection",
    "_route_continuity_packet_for_proof_floor",
    "_simple_lane_reject_reason_totals",
    "_build_rejected_signal_outcome_learning_payload",
    "_load_rejected_signal_outcome_learning_summary",
    "_load_route_provenance_summary",
    "build_jangar_reliability_settlement_ref",
    "build_torghut_stage_clearance_packet_ref",
]

capture_module_exports(globals(), __all__)


__all__ = (
    "build_jangar_reliability_settlement_ref",
    "build_torghut_stage_clearance_packet_ref",
)
