"""torghut FastAPI application entrypoint."""

# pyright: reportUnusedFunction=false
# ruff: noqa: F401,F403,F405
from __future__ import annotations

import sys

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy.exc import SQLAlchemyError

from .api.common import *
from .api.proxy import export_api_symbols, install_main_compat_proxies
from .api import status_helpers as status_helpers_api
from .api import readiness_helpers as readiness_helpers_api
from .api import readiness as readiness_api
from .api import maintenance as maintenance_api
from .api import whitepaper as whitepaper_api
from .api import trading_status as trading_status_api
from .api import trading_misc as trading_misc_api
from .api import runtime_profitability as runtime_profitability_api
from .api import proofs as proofs_api
from .api import trading_health as trading_health_api
from .api import health_checks as health_checks_api
from .api import proof_floor_payloads as proof_floor_payloads_api
from .api import runtime_profitability_helpers as runtime_profitability_helpers_api
from .api import vnext_helpers as vnext_helpers_api


def _extract_bearer_token(authorization_header: str | None) -> str | None:
    if not authorization_header:
        return None
    prefix = "bearer "
    if not authorization_header.lower().startswith(prefix):
        return None
    token = authorization_header[len(prefix) :].strip()
    return token or None


def _require_whitepaper_control_token(request: Request) -> None:
    expected_token = (
        os.getenv("WHITEPAPER_WORKFLOW_API_TOKEN", "").strip()
        or os.getenv("WHITEPAPER_AGENTRUN_API_TOKEN", "").strip()
        or os.getenv("AGENTS_API_KEY", "").strip()
        or os.getenv("JANGAR_API_KEY", "").strip()
    )
    if not expected_token:
        return

    provided_token = _extract_bearer_token(request.headers.get("authorization")) or (
        request.headers.get("x-whitepaper-token", "").strip() or None
    )
    if provided_token != expected_token:
        raise HTTPException(status_code=401, detail="whitepaper_control_auth_required")


def _env_or_none(name: str) -> str | None:
    value = os.getenv(name, "").strip()
    return value or None


def _env_csv(name: str) -> tuple[str, ...]:
    raw_value = os.getenv(name, "")
    return tuple(item.strip() for item in raw_value.split(",") if item.strip())


def _env_json_string_list(name: str) -> tuple[str, ...]:
    raw_value = os.getenv(name, "").strip()
    if not raw_value:
        return ()
    try:
        decoded = json.loads(raw_value)
    except json.JSONDecodeError:
        return (raw_value,)
    if not isinstance(decoded, list):
        return ()
    decoded_items = cast(list[object], decoded)
    return tuple(item for raw_item in decoded_items if (item := str(raw_item).strip()))


def _evaluate_scheduler_status(
    scheduler: TradingScheduler,
) -> tuple[bool, dict[str, object]]:
    scheduler_ok = True
    scheduler_detail = "ok"

    startup_grace_seconds = max(0, settings.trading_startup_readiness_grace_seconds)
    in_startup_grace = False
    startup_started_at = scheduler.state.startup_started_at
    if settings.trading_enabled and not scheduler.state.running:
        if (
            startup_started_at is not None
            and startup_grace_seconds > 0
            and datetime.now(timezone.utc) - startup_started_at
            <= timedelta(seconds=startup_grace_seconds)
        ):
            in_startup_grace = True
            scheduler_ok = True
            scheduler_detail = f"trading loop starting (within {startup_grace_seconds}s readiness grace)"
        else:
            scheduler_ok = False
            scheduler_detail = (
                "trading loop not started"
                if scheduler.state.last_run_at is None
                else "trading loop not running"
            )

    scheduler_payload: dict[str, object] = {
        "ok": scheduler_ok,
        "detail": scheduler_detail,
        "running": scheduler.state.running,
    }
    if startup_started_at is not None:
        scheduler_payload["startup_started_at"] = startup_started_at.isoformat()
        scheduler_payload["startup_readiness_grace_seconds"] = startup_grace_seconds
        scheduler_payload["startup_readiness_grace_active"] = in_startup_grace

    return scheduler_ok, scheduler_payload


def _assert_dspy_cutover_migration_guard() -> None:
    allowed, reasons = settings.llm_dspy_cutover_migration_guard()
    if allowed:
        return
    reason_summary = "|".join(reasons) if reasons else "unknown"
    raise RuntimeError(f"dspy_cutover_migration_guard_failed:{reason_summary}")


def _register_whitepaper_inngest_routes(app: FastAPI) -> inngest.Inngest | None:
    if not whitepaper_workflow_enabled() or not whitepaper_inngest_enabled():
        app.state.whitepaper_inngest_registered = False
        WHITEPAPER_WORKFLOW.set_inngest_client(None)
        return None

    app_id = _env_or_none("INNGEST_APP_ID") or "torghut"
    try:
        client = inngest.Inngest(
            app_id=app_id,
            api_base_url=_env_or_none("INNGEST_BASE_URL"),
            event_api_base_url=_env_or_none("INNGEST_EVENT_API_BASE_URL"),
            event_key=_env_or_none("INNGEST_EVENT_KEY"),
            signing_key=_env_or_none("INNGEST_SIGNING_KEY"),
        )
    except Exception as exc:  # pragma: no cover - configuration/runtime dependent
        logger.warning(
            "Failed to initialize Inngest client for whitepaper workflow: %s", exc
        )
        app.state.whitepaper_inngest_registered = False
        WHITEPAPER_WORKFLOW.set_inngest_client(None)
        return None

    requested_event_name = (
        _env_or_none("WHITEPAPER_INNGEST_EVENT_NAME")
        or "torghut/whitepaper.analysis.requested"
    )
    requested_fn_id = (
        _env_or_none("WHITEPAPER_INNGEST_FUNCTION_ID")
        or "torghut-whitepaper-analysis-v1"
    )
    finalized_event_name = (
        _env_or_none("WHITEPAPER_INNGEST_FINALIZED_EVENT_NAME")
        or "torghut/whitepaper.analysis.finalized"
    )
    finalized_fn_id = (
        _env_or_none("WHITEPAPER_INNGEST_FINALIZE_FUNCTION_ID")
        or "torghut-whitepaper-synthesis-index-v1"
    )

    @client.create_function(
        fn_id=requested_fn_id,
        idempotency="event.data.enqueue_key",
        trigger=inngest.TriggerEvent(event=requested_event_name),
    )
    def _whitepaper_requested_fn(ctx: inngest.ContextSync) -> dict[str, Any]:
        run_id = str(ctx.event.data.get("run_id") or "").strip()
        if not run_id:
            raise ValueError("run_id_required")
        with SessionLocal() as session:
            try:
                result = WHITEPAPER_WORKFLOW.process_requested_run(
                    session,
                    run_id=run_id,
                    inngest_function_id=requested_fn_id,
                    inngest_run_id=ctx.run_id,
                )
                session.commit()
                return result
            except Exception:
                session.rollback()
                logger.exception(
                    "Inngest requested whitepaper run failed for run_id=%s", run_id
                )
                raise

    @client.create_function(
        fn_id=finalized_fn_id,
        idempotency="event.data.run_id",
        trigger=inngest.TriggerEvent(event=finalized_event_name),
    )
    def _whitepaper_finalized_fn(ctx: inngest.ContextSync) -> dict[str, Any]:
        run_id = str(ctx.event.data.get("run_id") or "").strip()
        if not run_id:
            raise ValueError("run_id_required")
        if not whitepaper_semantic_indexing_enabled():
            return {
                "run_id": run_id,
                "skipped": True,
                "reason": "semantic_indexing_disabled",
            }
        with SessionLocal() as session:
            try:
                result = WHITEPAPER_WORKFLOW.index_synthesis_semantic_content(
                    session,
                    run_id=run_id,
                )
                session.commit()
                return result
            except Exception:
                session.rollback()
                logger.exception(
                    "Inngest finalized whitepaper indexing failed for run_id=%s", run_id
                )
                raise

    try:
        inngest_fastapi_serve(
            app,
            client,
            [_whitepaper_requested_fn, _whitepaper_finalized_fn],
            serve_path="/api/inngest",
        )
    except Exception as exc:  # pragma: no cover - registration/runtime dependent
        logger.warning("Failed to register whitepaper Inngest FastAPI routes: %s", exc)
        app.state.whitepaper_inngest_registered = False
        WHITEPAPER_WORKFLOW.set_inngest_client(None)
        return None

    app.state.whitepaper_inngest_registered = True
    WHITEPAPER_WORKFLOW.set_inngest_client(client)
    logger.info(
        "Registered whitepaper Inngest routes app_id=%s requested_fn_id=%s finalized_fn_id=%s",
        app_id,
        requested_fn_id,
        finalized_fn_id,
    )
    return client


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Run startup/shutdown tasks using FastAPI lifespan hooks."""

    scheduler = TradingScheduler()
    whitepaper_worker = WhitepaperKafkaWorker(session_factory=SessionLocal)
    app.state.trading_scheduler = scheduler
    app.state.whitepaper_worker = whitepaper_worker
    logger.info(
        "Torghut startup initiated build_version=%s build_commit=%s app_env=%s log_level=%s log_format=%s trading_enabled=%s whitepaper_workflow_enabled=%s",
        BUILD_VERSION,
        BUILD_COMMIT,
        settings.app_env,
        settings.log_level,
        settings.log_format,
        settings.trading_enabled,
        whitepaper_workflow_enabled(),
    )

    try:
        ensure_schema()
    except SQLAlchemyError as exc:  # pragma: no cover - defensive for startup only
        logger.warning("Database not reachable during startup: %s", exc)

    if settings.trading_autonomy_enabled:
        assert_runtime_gate_policy_contract(settings.trading_autonomy_gate_policy_path)

    if settings.trading_enabled:
        _assert_dspy_cutover_migration_guard()
        validate_hypothesis_registry_from_settings()
        await scheduler.start()
    if whitepaper_workflow_enabled():
        await whitepaper_worker.start()

    logger.info(
        "Torghut startup complete trading_scheduler_started=%s whitepaper_worker_started=%s inngest_registered=%s",
        bool(getattr(scheduler, "_task", None)),
        bool(getattr(whitepaper_worker, "_task", None)),
        bool(getattr(app.state, "whitepaper_inngest_registered", False)),
    )

    yield

    logger.info("Torghut shutdown initiated")
    await whitepaper_worker.stop()
    await scheduler.stop()
    shutdown_posthog_telemetry()
    logger.info("Torghut shutdown complete")


app = FastAPI(title="torghut", lifespan=lifespan)
app.state.settings = settings
app.state.whitepaper_inngest_registered = False
app.include_router(autoresearch_router)

API_MODULES = (
    status_helpers_api,
    readiness_helpers_api,
    readiness_api,
    maintenance_api,
    whitepaper_api,
    trading_status_api,
    trading_misc_api,
    runtime_profitability_api,
    proofs_api,
    trading_health_api,
    health_checks_api,
    proof_floor_payloads_api,
    runtime_profitability_helpers_api,
    vnext_helpers_api,
)
export_api_symbols(sys.modules[__name__], API_MODULES)
install_main_compat_proxies(
    API_MODULES,
    [
        "app",
        "HTTPConnection",
        "HTTPSConnection",
        "SessionLocal",
        "TorghutAlpacaClient",
        "_TRADING_STATUS_READ_BUDGET_SECONDS",
        "_TradingStatusReadBudget",
        "_active_runtime_revision",
        "_aggregate_tca_rows",
        "_alpaca_cached_last_good",
        "_alpaca_endpoint_class",
        "_alpaca_failure_status",
        "_alpaca_probe_account",
        "_append_unique_reason",
        "_apply_status_read_statement_timeout",
        "_assert_dspy_cutover_migration_guard",
        "_budget_exhausted_live_submission_gate_payload",
        "_budget_exhausted_options_catalog_freshness_payload",
        "_budget_unavailable_hypothesis_runtime_payload",
        "_budget_unavailable_llm_evaluation_payload",
        "_budget_unavailable_tca_summary_payload",
        "_budget_unavailable_tigerbeetle_ledger_payload",
        "_build_autonomy_bridge_status",
        "_build_autonomy_capital_replay_projection",
        "_build_capital_reentry_cohort_ledger_payload",
        "_build_capital_replay_projection_payload",
        "_build_clock_settlement_payload",
        "_build_consumer_evidence_receipt_projection",
        "_build_control_plane_contract",
        "_build_current_evidence_epoch",
        "_build_evidence_clock_payloads",
        "_build_freshness_carry_ledger_payload",
        "_build_hypothesis_runtime_payload",
        "_build_jangar_contract_graduation_ref",
        "_build_jangar_execution_trust_admission_ref",
        "_build_jangar_material_verdict_ref",
        "_build_jangar_reliability_settlement_ref",
        "_build_live_submission_gate_payload",
        "_build_persisted_vnext_status",
        "_build_profit_carry_passport_ledger_payload",
        "_build_profit_freshness_frontier_payload",
        "_build_profit_repair_settlement_ledger_payload",
        "_build_profit_signal_quorum_payload",
        "_build_profitability_proof_floor_payload",
        "_build_quality_adjusted_profit_frontier_payload",
        "_build_rejected_signal_outcome_learning_payload",
        "_build_renewal_bond_profit_escrow_payload",
        "_build_repair_bid_settlement_payload",
        "_build_repair_outcome_dividend_ledger_payload",
        "_build_repair_receipt_frontier_payload",
        "_build_route_evidence_clearinghouse_payload",
        "_build_route_image_proof_summary",
        "_build_route_reacquisition_board_payload",
        "_build_route_warrant_exchange_payload",
        "_build_routeability_repair_acceptance_ledger_payload",
        "_build_shadow_first_runtime_payload",
        "_build_shadow_first_toggle_parity",
        "_build_simple_lane_status_payload",
        "_build_source_serving_repair_receipt_payload",
        "_build_tigerbeetle_ledger_status",
        "_build_torghut_routeability_admission_ref",
        "_build_torghut_stage_clearance_packet_ref",
        "_build_trading_consumer_evidence_payload",
        "_build_trading_proofs_payload",
        "_cache_completed_trading_health_surface_payload",
        "_cached_external_paper_route_target_plan_success",
        "_cached_readiness_dependencies_for_health_surface",
        "_cached_trading_health_surface_payload",
        "_check_account_scope_invariants_bounded",
        "_check_alpaca",
        "_check_clickhouse",
        "_check_postgres",
        "_check_tigerbeetle_protocol_health",
        "_consumer_evidence_dependency_quorum",
        "_consumer_evidence_jangar_continuity_packet",
        "_consumer_evidence_summary_view",
        "_core_readiness_live_submission_gate",
        "_daily_runtime_ledger_portfolio_summary",
        "_decimal_average",
        "_decimal_or_none",
        "_decimal_percentile",
        "_decimal_to_string",
        "_deferred_hypothesis_payload_for_live_submission_gate",
        "_empirical_jobs_status",
        "_empty_tigerbeetle_ref_counts",
        "_ensure_utc_datetime",
        "_env_csv",
        "_env_json_string_list",
        "_env_or_none",
        "_evaluate_core_readiness_payload",
        "_evaluate_database_contract",
        "_evaluate_scheduler_status",
        "_evaluate_trading_health_payload",
        "_evaluate_trading_health_payload_bounded",
        "_evaluate_universe_dependency",
        "_execute_readiness_account_scope_query",
        "_extract_bearer_token",
        "_extract_gate_result",
        "_fail_closed_health_evaluation_gate",
        "_fetch_paper_route_target_plan_url",
        "_finalize_tca_aggregates",
        "_forecast_service_status",
        "_guard_live_submission_gate_for_readiness",
        "_health_surface_timeout_dependency_placeholder",
        "_health_surface_timeout_fallback_payload",
        "_hypothesis_payload_read_model_unavailable",
        "_latest_reconciliation_ref_counts",
        "_lean_authority_status",
        "_load_bounded_options_catalog_freshness_summary",
        "_load_cached_options_catalog_freshness_summary",
        "_load_clickhouse_ta_status",
        "_load_external_paper_route_target_plan",
        "_load_jangar_dependency_quorum_payload",
        "_load_jangar_verify_trust_foreclosure_board",
        "_load_json_artifact_payload",
        "_load_last_decision_at",
        "_load_llm_evaluation",
        "_load_options_catalog_freshness_summary",
        "_load_rejected_signal_outcome_learning_summary",
        "_load_route_provenance_summary",
        "_load_runtime_profitability_decisions",
        "_load_runtime_profitability_executions",
        "_load_runtime_profitability_gate_rollback_attribution",
        "_load_runtime_profitability_realized_pnl_summary",
        "_load_tca_summary",
        "_load_trading_status_hypothesis_runtime",
        "_load_trading_status_llm_evaluation",
        "_load_trading_status_runtime_ledger_portfolio_summary",
        "_load_trading_status_tca_summary",
        "_load_trading_status_tigerbeetle_ledger",
        "_mapping_items",
        "_merge_external_paper_route_target_plan",
        "_minimal_health_surface_timeout_live_submission_gate",
        "_minimal_health_surface_timeout_payload",
        "_minimal_health_surface_timeout_proof_floor",
        "_new_tca_aggregate",
        "_normalized_adapter_name",
        "_normalized_paper_route_text",
        "_paper_route_mapping_targets_sim_account",
        "_paper_route_probe_book_from_target_plan",
        "_paper_route_probe_symbol_values_from_mapping",
        "_paper_route_probe_symbols_from_target_plan_strategies",
        "_paper_route_source_collection_target_cache_safe",
        "_paper_route_target_account_audit_available",
        "_paper_route_target_plan_audit_mode_value",
        "_paper_route_target_plan_cache_safe_for_live",
        "_paper_route_target_plan_from_payload",
        "_paper_route_target_plan_probe_notional",
        "_paper_route_target_plan_probe_symbols",
        "_paper_route_target_plan_targets",
        "_paper_route_target_plan_truthy",
        "_paper_route_target_plan_url_points_to_self",
        "_paper_route_target_strategy_lookup_names",
        "_proof_kind_value",
        "_proof_window_value",
        "_readiness_authority_truthy",
        "_readiness_dependency_cache_key",
        "_readiness_dependency_checks",
        "_readiness_dependency_degradation_reason_codes",
        "_readiness_dependency_snapshot",
        "_record_trading_health_surface_completion",
        "_refresh_universe_state_for_readiness",
        "_register_whitepaper_inngest_routes",
        "_remember_alpaca_success",
        "_remember_external_paper_route_target_plan_success",
        "_require_whitepaper_control_token",
        "_resolve_active_capital_stage",
        "_resolve_tca_scope_symbols",
        "_resolve_universe_resolver_for_readiness",
        "_retryable_tca_recompute_error",
        "_revenue_repair_topline_fields",
        "_rollback_status_read_session",
        "_route_claim_symbols",
        "_route_continuity_packet_for_proof_floor",
        "_runtime_ledger_bucket_evidence_grade",
        "_safe_float",
        "_safe_int",
        "_simple_lane_reject_reason_totals",
        "_simulation_cache_status_payload",
        "_sqlalchemy_error_indicates_statement_timeout",
        "_store_options_catalog_freshness_summary",
        "_strip_promotion_authority_claims_for_readiness",
        "_tca_as_float",
        "_tca_as_int",
        "_tca_row_payload",
        "_tigerbeetle_status_int",
        "_to_str_map",
        "_trading_health_surface_cache_key",
        "_trading_scheduler_for_proofs",
        "_unavailable_runtime_ledger_portfolio_summary",
        "_unavailable_tigerbeetle_reconciliation_payload",
        "_update_tca_aggregate",
        "approve_whitepaper_for_engineering",
        "build_capital_replay_projection",
        "build_empirical_jobs_status",
        "build_hypothesis_runtime_summary",
        "build_live_submission_gate_payload",
        "build_llm_evaluation_metrics",
        "build_profit_signal_quorum",
        "build_profitability_proof_floor_receipt",
        "build_quality_adjusted_profit_frontier",
        "build_renewal_bond_profit_escrow",
        "build_revenue_repair_digest",
        "build_tca_gate_inputs",
        "check_schema_current",
        "check_tigerbeetle_health",
        "db_check",
        "dispatch_whitepaper_agentrun",
        "evaluate_feature_batch_quality",
        "finalize_whitepaper_run",
        "get_lean_backtest",
        "get_lean_shadow_parity",
        "get_whitepaper_run",
        "healthz",
        "hypothesis_registry_requires_dependency_capability",
        "ingest_whitepaper_github_issue",
        "latest_tigerbeetle_reconciliation_payload",
        "lifespan",
        "load_hypothesis_registry",
        "load_jangar_dependency_quorum",
        "load_jangar_route_continuity_packet",
        "load_quant_evidence_status",
        "persist_evidence_epoch",
        "prometheus_metrics",
        "readyz",
        "refresh_execution_tca_metrics",
        "resolve_hypothesis_dependency_quorum",
        "root",
        "search_whitepapers",
        "sqlalchemy_exception_handler",
        "submit_lean_backtest",
        "tigerbeetle_ref_counts",
        "trading_autonomy",
        "trading_autonomy_evidence_continuity",
        "trading_completion_doc29",
        "trading_completion_doc29_gate",
        "trading_consumer_evidence",
        "trading_decisions",
        "trading_empirical_jobs",
        "trading_evidence_epoch_detail",
        "trading_evidence_epoch_latest",
        "trading_executions",
        "trading_health",
        "trading_llm_evaluation",
        "trading_metrics",
        "trading_paper_route_evidence",
        "trading_paper_route_target_plan",
        "trading_profit_freshness_zero_notional_repair",
        "trading_proofs",
        "trading_revenue_repair",
        "trading_runtime_profitability",
        "trading_simulation_progress",
        "trading_status",
        "trading_tca",
        "whitepaper_kafka_enabled",
        "whitepaper_semantic_indexing_enabled",
        "whitepaper_status",
        "whitepaper_workflow_enabled",
    ],
)

for api_module in API_MODULES:
    router = getattr(api_module, "router", None)
    if router is not None:
        app.include_router(router)

_register_whitepaper_inngest_routes(app)


@app.exception_handler(SQLAlchemyError)
def sqlalchemy_exception_handler(
    _request: Request,
    exc: SQLAlchemyError,
) -> JSONResponse:
    """Convert unhandled DB exceptions into explicit service-unavailable responses."""

    message = str(getattr(exc, "orig", exc)).lower()
    if "undefinedcolumn" in message or (
        "column" in message and "does not exist" in message
    ):
        detail = "database schema mismatch; migrations pending"
    else:
        detail = "database unavailable"
    capture_posthog_event(
        "torghut.runtime.db_exception",
        severity="error",
        properties={
            "loop": "http",
            "error_class": type(exc).__name__,
            "detail": detail,
        },
    )
    logger.error("Unhandled database exception: %s", exc)
    return JSONResponse(status_code=503, content={"detail": detail})


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    """Liveness endpoint for Kubernetes/Knative probes."""

    return {"status": "ok", "service": "torghut"}
