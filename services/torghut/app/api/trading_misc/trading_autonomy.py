"""Extracted Torghut API route and support functions."""

from __future__ import annotations

from ...bootstrap import (
    env_csv as _env_csv,
    env_json_string_list as _env_json_string_list,
    evaluate_scheduler_status as _evaluate_scheduler_status,
)
from ..health_checks import (
    build_hypothesis_runtime_payload as _build_hypothesis_runtime_payload,
    empirical_jobs_status as _empirical_jobs_status,
    forecast_service_status as _forecast_service_status,
    lean_authority_status as _lean_authority_status,
    load_tca_summary as _load_tca_summary,
)
from ..readiness_helpers import (
    evaluate_database_contract as _evaluate_database_contract,
)
from ..trading_scheduler_state import get_trading_scheduler
from ..vnext_helpers import (
    build_autonomy_bridge_status as _build_autonomy_bridge_status,
    safe_float as _safe_float,
    safe_int as _safe_int,
)


from .shared_context import (
    BUILD_IMAGE_DIGEST,
    Decimal,
    Depends,
    EvidenceEpoch,
    EvidenceReceipt,
    HTTPException,
    JSONResponse,
    Mapping,
    Query,
    Response,
    SQLAlchemyError,
    Sequence,
    Session,
    StrategyRuntimeLedgerBucket,
    TradeDecision,
    active_simulation_runtime_context,
    build_artifact_parity_receipt,
    build_data_freshness_receipt,
    build_doc29_completion_status,
    build_empirical_jobs_receipt,
    build_empirical_jobs_status,
    build_jangar_authority_receipt,
    build_llm_evaluation_metrics,
    build_portfolio_proof_receipt,
    build_runtime_ledger_profit_distance_readback,
    build_schema_receipt,
    build_service_health_receipt,
    cast,
    compile_evidence_epoch,
    cost_basis_counts_have_non_promotion_grade_costs,
    datetime,
    evaluate_evidence_continuity,
    get_session,
    jsonable_encoder,
    load_evidence_epoch_payload,
    load_hypothesis_registry,
    load_latest_evidence_epoch_payload,
    logger,
    main_runtime_value,
    persist_evidence_epoch,
    render_trading_metrics,
    resolve_hypothesis_dependency_quorum,
    router,
    runtime_ledger_promotion_source_authority_blockers,
    select,
    settings,
    timezone,
    trading_time_status,
)
from .autonomy_dependencies import (
    apply_status_read_statement_timeout as _apply_status_read_statement_timeout,
    build_autonomy_capital_replay_projection as _build_autonomy_capital_replay_projection,
    load_route_provenance_summary as _load_route_provenance_summary,
    rollback_status_read_session as _rollback_status_read_session,
    sqlalchemy_error_indicates_statement_timeout as _sqlalchemy_error_indicates_statement_timeout,
    unavailable_runtime_ledger_portfolio_summary as _unavailable_runtime_ledger_portfolio_summary,
)


@router.get("/trading/autonomy")
def trading_autonomy() -> dict[str, object]:
    """Return autonomous control-plane status and last lane artifacts."""

    scheduler = get_trading_scheduler()
    state = scheduler.state
    active_simulation_context = active_simulation_runtime_context()
    capital_replay_projection = _build_autonomy_capital_replay_projection(scheduler)
    empirical_jobs = _empirical_jobs_status()
    return {
        "enabled": settings.trading_autonomy_enabled,
        "gate_policy_path": settings.trading_autonomy_gate_policy_path,
        "artifact_dir": settings.trading_autonomy_artifact_dir,
        "poll_interval_seconds": settings.trading_autonomy_interval_seconds,
        "signal_lookback_minutes": settings.trading_autonomy_signal_lookback_minutes,
        "runs_total": state.autonomy_runs_total,
        "signals_total": state.autonomy_signals_total,
        "patches_total": state.autonomy_patches_total,
        "no_signal_streak": state.autonomy_no_signal_streak,
        "last_run_at": state.last_autonomy_run_at,
        "last_run_id": state.last_autonomy_run_id,
        "last_gates": state.last_autonomy_gates,
        "last_actuation_intent": state.last_autonomy_actuation_intent,
        "last_patch": state.last_autonomy_patch,
        "last_recommendation": state.last_autonomy_recommendation,
        "last_recommendation_trace_id": state.last_autonomy_recommendation_trace_id,
        "last_error": state.last_autonomy_error,
        "last_reason": state.last_autonomy_reason,
        "last_ingest_signal_count": state.last_ingest_signals_total,
        "last_ingest_reason": state.last_ingest_reason,
        "last_ingest_window_start": state.last_ingest_window_start,
        "last_ingest_window_end": state.last_ingest_window_end,
        "failure_streak": state.autonomy_failure_streak,
        "forecast_service": _forecast_service_status(empirical_jobs),
        "lean_authority": _lean_authority_status(),
        "empirical_jobs": empirical_jobs,
        "capital_replay_board": capital_replay_projection["capital_replay_board"],
        "executable_alpha_receipts": capital_replay_projection[
            "executable_alpha_receipts"
        ],
        "simulation": {
            "enabled": settings.trading_simulation_enabled,
            "run_id": (active_simulation_context or {}).get("run_id")
            or settings.trading_simulation_run_id,
            "dataset_id": (active_simulation_context or {}).get("dataset_id")
            or settings.trading_simulation_dataset_id,
            "window_start": (active_simulation_context or {}).get("window_start")
            or settings.trading_simulation_window_start,
            "window_end": (active_simulation_context or {}).get("window_end")
            or settings.trading_simulation_window_end,
            "time_source": trading_time_status(
                account_label=settings.trading_account_label
            ),
        },
        "bridge_status": _build_autonomy_bridge_status(scheduler),
        "signal_continuity": {
            "universe_source": settings.trading_universe_source,
            "universe_status": state.universe_source_status,
            "universe_reason": state.universe_source_reason,
            "universe_symbols_count": state.universe_symbols_count,
            "universe_cache_age_seconds": state.universe_cache_age_seconds,
            "universe_fail_safe_blocked": state.universe_fail_safe_blocked,
            "universe_fail_safe_block_reason": state.universe_fail_safe_block_reason,
            "market_session_open": state.market_session_open,
            "last_state": state.last_signal_continuity_state,
            "last_reason": state.last_signal_continuity_reason,
            "last_actionable": state.last_signal_continuity_actionable,
            "alert_active": state.signal_continuity_alert_active,
            "alert_reason": state.signal_continuity_alert_reason,
            "alert_started_at": state.signal_continuity_alert_started_at,
            "alert_last_seen_at": state.signal_continuity_alert_last_seen_at,
            "alert_recovery_streak": state.signal_continuity_recovery_streak,
            "no_signal_reason_streak": dict(state.metrics.no_signal_reason_streak),
            "signal_staleness_alert_total": dict(
                state.metrics.signal_staleness_alert_total
            ),
            "signal_continuity_promotion_block_total": state.metrics.signal_continuity_promotion_block_total,
            "no_signal_streak_alert_threshold": settings.trading_signal_no_signal_streak_alert_threshold,
            "signal_lag_alert_threshold_seconds": settings.trading_signal_stale_lag_alert_seconds,
            "signal_continuity_recovery_cycles": settings.trading_signal_continuity_recovery_cycles,
        },
        "rollback": {
            "emergency_stop_active": state.emergency_stop_active,
            "emergency_stop_reason": state.emergency_stop_reason,
            "emergency_stop_triggered_at": state.emergency_stop_triggered_at,
            "emergency_stop_resolved_at": state.emergency_stop_resolved_at,
            "emergency_stop_recovery_streak": state.emergency_stop_recovery_streak,
            "incidents_total": state.rollback_incidents_total,
            "incident_evidence_path": state.rollback_incident_evidence_path,
        },
        "evidence_continuity": state.last_evidence_continuity_report,
    }


def _runtime_ledger_bucket_evidence_grade(row: StrategyRuntimeLedgerBucket) -> bool:
    raw_blockers = cast(Sequence[object], row.blockers_json or [])
    blockers = [str(item).strip() for item in raw_blockers if str(item).strip()]
    raw_payload_json = cast(object, row.payload_json)
    payload_json = (
        {
            str(key): item
            for key, item in cast(Mapping[object, object], raw_payload_json).items()
        }
        if isinstance(raw_payload_json, Mapping)
        else {}
    )
    return (
        row.pnl_basis == "realized_strategy_pnl_after_explicit_costs"
        and int(row.fill_count or 0) > 0
        and int(row.submitted_order_count or 0) > 0
        and int(row.closed_trade_count or 0) > 0
        and int(row.open_position_count or 0) == 0
        and row.filled_notional > 0
        and bool(row.execution_policy_hash_counts)
        and bool(row.cost_model_hash_counts)
        and bool(row.lineage_hash_counts)
        and not cost_basis_counts_have_non_promotion_grade_costs(
            payload_json.get("cost_basis_counts")
        )
        and not runtime_ledger_promotion_source_authority_blockers(payload_json)
        and not blockers
    )


def _daily_runtime_ledger_portfolio_summary(
    *,
    session: Session,
    account_label: str,
    stage_scope: str,
    observed_at: datetime,
) -> dict[str, object]:
    observed = (
        observed_at.astimezone(timezone.utc)
        if observed_at.tzinfo
        else observed_at.replace(tzinfo=timezone.utc)
    )
    day_start = observed.replace(hour=0, minute=0, second=0, microsecond=0)
    stage = stage_scope.strip()
    account = account_label.strip()
    stmt = (
        select(StrategyRuntimeLedgerBucket)
        .where(StrategyRuntimeLedgerBucket.bucket_ended_at >= day_start)
        .where(StrategyRuntimeLedgerBucket.bucket_ended_at <= observed)
        .where(StrategyRuntimeLedgerBucket.account_label == account)
        .order_by(
            StrategyRuntimeLedgerBucket.bucket_ended_at.desc(),
            StrategyRuntimeLedgerBucket.created_at.desc(),
        )
    )
    if stage in {"paper", "live"}:
        stmt = stmt.where(StrategyRuntimeLedgerBucket.observed_stage == stage)
    else:
        stmt = stmt.where(StrategyRuntimeLedgerBucket.observed_stage == "__missing__")
    try:
        _apply_status_read_statement_timeout(session, milliseconds=500)
        rows = list(session.execute(stmt.limit(200)).scalars())
    except SQLAlchemyError as exc:
        logger.warning("Portfolio runtime-ledger daily summary unavailable: %s", exc)
        _rollback_status_read_session(
            session,
            context="portfolio runtime-ledger summary",
        )
        reason_code = (
            "portfolio_runtime_ledger_summary_query_timeout"
            if _sqlalchemy_error_indicates_statement_timeout(exc)
            else "portfolio_runtime_ledger_summary_unavailable"
        )
        return _unavailable_runtime_ledger_portfolio_summary(
            account_label=account,
            stage_scope=stage,
            observed_at=observed,
            reason=reason_code,
        )
    evidence_rows = [row for row in rows if _runtime_ledger_bucket_evidence_grade(row)]
    net_pnl = sum(
        (row.net_strategy_pnl_after_costs for row in evidence_rows),
        Decimal("0"),
    )
    filled_notional = sum(
        (row.filled_notional for row in evidence_rows),
        Decimal("0"),
    )
    closed_trade_count = sum(
        max(0, int(row.closed_trade_count or 0)) for row in evidence_rows
    )
    open_position_count = sum(
        max(0, int(row.open_position_count or 0)) for row in evidence_rows
    )
    source_authority_blockers: list[str] = []
    source_authority_bucket_count = 0
    for row in rows:
        raw_payload = cast(object, row.payload_json)
        payload = (
            {
                str(key): item
                for key, item in cast(Mapping[object, object], raw_payload).items()
            }
            if isinstance(raw_payload, Mapping)
            else {}
        )
        row_source_blockers = runtime_ledger_promotion_source_authority_blockers(
            payload
        )
        if row_source_blockers:
            for blocker in row_source_blockers:
                if blocker not in source_authority_blockers:
                    source_authority_blockers.append(blocker)
        else:
            source_authority_bucket_count += 1
    net_pnl_by_day = {
        day_start.date().isoformat(): str(net_pnl),
    }
    filled_notional_by_day = {
        day_start.date().isoformat(): str(filled_notional),
    }
    daily_summary = {
        "runtime_ledger_observed_trading_day_count": 1 if rows else 0,
        "runtime_ledger_net_pnl_by_trading_day": net_pnl_by_day if rows else {},
        "runtime_ledger_mean_daily_net_pnl_after_costs": str(net_pnl),
        "runtime_ledger_median_daily_net_pnl_after_costs": str(net_pnl),
        "runtime_ledger_p10_daily_net_pnl_after_costs": str(net_pnl),
        "runtime_ledger_worst_day_net_pnl_after_costs": str(net_pnl),
        "runtime_ledger_max_intraday_drawdown": "0",
        "runtime_ledger_avg_daily_filled_notional": str(filled_notional),
        "runtime_ledger_filled_notional_by_trading_day": filled_notional_by_day
        if rows
        else {},
        "runtime_ledger_closed_trade_count_by_day": {
            day_start.date().isoformat(): closed_trade_count,
        }
        if rows
        else {},
        "runtime_ledger_filled_notional": str(filled_notional),
    }
    candidate_ids = sorted(
        {
            str(row.candidate_id).strip()
            for row in evidence_rows
            if str(row.candidate_id or "").strip()
        }
    )
    blockers: list[str] = []
    if not rows:
        blockers.append("portfolio_runtime_ledger_summary_missing")
    elif not evidence_rows:
        blockers.append("portfolio_runtime_ledger_summary_not_evidence_grade")
    for blocker in source_authority_blockers:
        if blocker not in blockers:
            blockers.append(blocker)
    profit_distance_readback = build_runtime_ledger_profit_distance_readback(
        summary=daily_summary,
        candidate_id=",".join(candidate_ids) if candidate_ids else None,
        observed_stage=stage if stage in {"paper", "live"} else None,
        runtime_ledger_bucket_count=len(rows),
        evidence_grade_runtime_ledger_bucket_count=len(evidence_rows),
        source_authority_bucket_count=source_authority_bucket_count,
        source_authority_blockers=source_authority_blockers,
        blockers=blockers,
        total_filled_notional=filled_notional,
        total_closed_trade_count=closed_trade_count,
        open_position_count=open_position_count,
    )
    return {
        "summary_basis": "runtime_ledger_daily_stage_account_scope",
        "day_start": day_start.isoformat(),
        "observed_at": observed.isoformat(),
        "filters": {
            "account_label": account,
            "stage_scope": stage,
            "observed_stage": stage if stage in {"paper", "live"} else "__missing__",
        },
        "bucket_count": len(rows),
        "evidence_grade_bucket_count": len(evidence_rows),
        "post_cost_net_pnl_per_day": str(net_pnl),
        "filled_notional": str(filled_notional),
        "closed_trade_count": closed_trade_count,
        "open_position_count": open_position_count,
        "source_authority_bucket_count": source_authority_bucket_count,
        "source_authority_blockers": source_authority_blockers,
        "runtime_ledger_profit_distance_readback": profit_distance_readback,
        "candidate_ids": candidate_ids,
        "db_row_refs": [str(row.id) for row in evidence_rows],
        "blockers": blockers,
        "query_limit": 200,
    }


def _build_current_evidence_epoch(
    *,
    session: Session,
    account_label: str,
    stage_scope: str,
) -> EvidenceEpoch:
    observed_at = datetime.now(timezone.utc)
    receipts: list[EvidenceReceipt] = []
    scheduler = get_trading_scheduler()
    trading_status_ok, _scheduler_payload = _evaluate_scheduler_status(scheduler)

    try:
        database_contract = _evaluate_database_contract(session)
        database_ok = bool(database_contract.get("ok"))
        schema_current = bool(database_contract.get("schema_current"))
        schema_lineage_ready = bool(database_contract.get("schema_graph_lineage_ready"))
        schema_reasons = [
            str(item)
            for item in cast(
                Sequence[object],
                database_contract.get("schema_graph_lineage_errors") or [],
            )
            if str(item).strip()
        ]
        schema_head_signature = (
            str(database_contract.get("schema_head_signature"))
            if database_contract.get("schema_head_signature") is not None
            else None
        )
    except Exception as exc:
        database_ok = False
        schema_current = False
        schema_lineage_ready = False
        schema_reasons = [f"database_contract_unavailable:{type(exc).__name__}"]
        schema_head_signature = None

    receipts.append(
        build_jangar_authority_receipt(
            quorum_payload=resolve_hypothesis_dependency_quorum(
                load_hypothesis_registry()
            ).as_payload(),
            observed_at=observed_at,
        )
    )
    receipts.append(
        build_service_health_receipt(
            role="torghut-live",
            liveness_ok=True,
            readiness_ok=database_ok,
            db_check_ok=database_ok,
            trading_status_ok=trading_status_ok,
            image_digest=BUILD_IMAGE_DIGEST,
            revision=main_runtime_value("BUILD_COMMIT"),
            observed_at=observed_at,
        )
    )
    receipts.append(
        build_schema_receipt(
            schema_current=schema_current,
            lineage_ready=schema_lineage_ready,
            schema_head_signature=schema_head_signature,
            reason_codes=schema_reasons,
            observed_at=observed_at,
        )
    )
    receipts.append(
        build_data_freshness_receipt(
            source="database_contract",
            fresh=database_ok,
            as_of=observed_at,
            observed_at=observed_at,
            max_age_seconds=settings.trading_empirical_job_stale_after_seconds,
            reason_codes=[] if database_ok else ["database_contract_not_ready"],
        )
    )

    empirical_status: dict[str, object]
    try:
        empirical_status = build_empirical_jobs_status(
            session=session,
            stale_after_seconds=settings.trading_empirical_job_stale_after_seconds,
        )
    except Exception as exc:
        empirical_status = {
            "ready": False,
            "status": "unknown",
            "authority": "blocked",
            "stale_after_seconds": settings.trading_empirical_job_stale_after_seconds,
            "message": "empirical jobs status unavailable",
            "eligible_jobs": [],
            "missing_jobs": [],
            "stale_jobs": [],
            "ineligible_jobs": [],
            "candidate_ids": [],
            "dataset_snapshot_refs": [],
            "blocked_reasons": [
                f"empirical_jobs_status_unavailable:{type(exc).__name__}"
            ],
            "jobs": {},
        }
    receipts.append(
        build_empirical_jobs_receipt(
            empirical_status=empirical_status,
            observed_at=observed_at,
            ttl_seconds=settings.trading_empirical_job_stale_after_seconds,
        )
    )
    receipts.append(
        build_artifact_parity_receipt(
            consumer_ref="torghut-live",
            image_ref=BUILD_IMAGE_DIGEST,
            required_platforms=_env_csv("TORGHUT_REQUIRED_IMAGE_PLATFORMS"),
            observed_platforms=_env_csv("TORGHUT_OBSERVED_IMAGE_PLATFORMS"),
            runtime_pull_failures=_env_json_string_list(
                "TORGHUT_RUNTIME_PULL_FAILURES_JSON"
            ),
            observed_at=observed_at,
        )
    )
    portfolio_runtime_ledger_summary = _daily_runtime_ledger_portfolio_summary(
        session=session,
        account_label=account_label,
        stage_scope=stage_scope,
        observed_at=observed_at,
    )
    candidate_ids_raw = portfolio_runtime_ledger_summary.get("candidate_ids")
    candidate_id_items: Sequence[object]
    if isinstance(candidate_ids_raw, Sequence) and not isinstance(
        candidate_ids_raw, (str, bytes, bytearray)
    ):
        candidate_id_items = cast(Sequence[object], candidate_ids_raw)
    else:
        candidate_id_items = ()
    portfolio_candidate_ids = [
        str(item).strip() for item in candidate_id_items if str(item).strip()
    ]
    portfolio_runtime_ledger_bucket_count = int(
        Decimal(str(portfolio_runtime_ledger_summary.get("bucket_count") or "0"))
    )
    receipts.append(
        build_portfolio_proof_receipt(
            portfolio_candidate_id=(
                ",".join(portfolio_candidate_ids) if portfolio_candidate_ids else ""
            ),
            target_net_pnl_per_day=Decimal("500"),
            post_cost_net_pnl_per_day=Decimal(
                str(
                    portfolio_runtime_ledger_summary.get("post_cost_net_pnl_per_day")
                    or "0"
                )
            ),
            holdout_result=None,
            runtime_closure_artifact_refs=(),
            runtime_ledger_summary=portfolio_runtime_ledger_summary
            if portfolio_runtime_ledger_bucket_count > 0
            else None,
            require_runtime_ledger_summary=True,
            observed_at=observed_at,
        )
    )
    return compile_evidence_epoch(
        account_label=account_label,
        stage_scope=stage_scope,
        receipts=receipts,
        created_at=observed_at,
    )


@router.get("/trading/evidence-epochs/latest")
def trading_evidence_epoch_latest(
    stage_scope: str = Query("shadow", min_length=1, max_length=32),
    account_label: str = Query(
        settings.trading_account_label, min_length=1, max_length=64
    ),
    refresh: bool = Query(True),
    persist: bool = Query(True),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Compile or return the latest cross-plane evidence epoch for operators."""

    if not refresh:
        persisted_payload = load_latest_evidence_epoch_payload(
            session,
            account_label=account_label,
            stage_scope=stage_scope,
        )
        if persisted_payload is not None:
            return persisted_payload

    epoch = _build_current_evidence_epoch(
        session=session,
        account_label=account_label,
        stage_scope=stage_scope,
    )
    payload = epoch.to_payload()
    if persist:
        try:
            persist_evidence_epoch(session, epoch)
            session.commit()
            payload["persisted"] = True
        except SQLAlchemyError as exc:
            session.rollback()
            logger.warning("Failed to persist evidence epoch: %s", exc)
            payload["persisted"] = False
            payload["persist_error"] = type(exc).__name__
    else:
        payload["persisted"] = False
    return payload


@router.get("/trading/evidence-epochs/{evidence_epoch_id}")
def trading_evidence_epoch_detail(
    evidence_epoch_id: str,
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Return one persisted cross-plane evidence epoch."""

    payload = load_evidence_epoch_payload(session, evidence_epoch_id)
    if payload is None:
        raise HTTPException(status_code=404, detail="evidence_epoch_not_found")
    return payload


@router.get("/trading/empirical-jobs")
def trading_empirical_jobs() -> dict[str, object]:
    """Return freshness and authority status for empirical parity and Janus workflows."""

    return _empirical_jobs_status()


@router.get("/trading/completion/doc29")
def trading_completion_doc29(
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Return traceable completion status for doc 29 gates."""

    return build_doc29_completion_status(
        session=session,
        stale_after_seconds=settings.trading_empirical_job_stale_after_seconds,
        current_git_revision=main_runtime_value("BUILD_COMMIT"),
        current_image_digest=BUILD_IMAGE_DIGEST,
    )


@router.get("/trading/completion/doc29/{gate_id}")
def trading_completion_doc29_gate(
    gate_id: str,
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Return traceable completion status for one doc 29 gate."""

    payload = build_doc29_completion_status(
        session=session,
        stale_after_seconds=settings.trading_empirical_job_stale_after_seconds,
        current_git_revision=main_runtime_value("BUILD_COMMIT"),
        current_image_digest=BUILD_IMAGE_DIGEST,
    )
    for gate in cast(list[dict[str, object]], payload.get("gates", [])):
        if str(gate.get("gate_id")) == gate_id:
            return gate
    raise HTTPException(status_code=404, detail=f"unknown_doc29_gate:{gate_id}")


@router.get("/trading/autonomy/evidence-continuity")
def trading_autonomy_evidence_continuity(
    refresh: bool = Query(default=False),
    run_limit: int | None = Query(default=None, ge=1, le=50),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Return latest evidence continuity check and optionally force a refresh."""

    scheduler = get_trading_scheduler()

    if refresh:
        report = evaluate_evidence_continuity(
            session,
            run_limit=run_limit or settings.trading_evidence_continuity_run_limit,
        )
        payload = report.to_payload()
        scheduler.state.last_evidence_continuity_report = payload
        return {
            "enabled": settings.trading_evidence_continuity_enabled,
            "interval_seconds": settings.trading_evidence_continuity_interval_seconds,
            "default_run_limit": settings.trading_evidence_continuity_run_limit,
            "report": payload,
        }

    return {
        "enabled": settings.trading_evidence_continuity_enabled,
        "interval_seconds": settings.trading_evidence_continuity_interval_seconds,
        "default_run_limit": settings.trading_evidence_continuity_run_limit,
        "report": scheduler.state.last_evidence_continuity_report,
    }


@router.get("/trading/llm-evaluation")
def trading_llm_evaluation(session: Session = Depends(get_session)) -> JSONResponse:
    """Return today's LLM evaluation metrics in America/New_York time."""

    try:
        payload = build_llm_evaluation_metrics(session)
    except SQLAlchemyError as exc:
        raise HTTPException(status_code=503, detail="database unavailable") from exc
    return JSONResponse(status_code=200, content=jsonable_encoder(payload))


@router.get("/metrics")
def prometheus_metrics(session: Session = Depends(get_session)) -> Response:
    """Expose Prometheus-formatted trading metrics counters."""

    scheduler = get_trading_scheduler()
    metrics = scheduler.state.metrics
    market_context_status = scheduler.market_context_status()
    shorting_metadata_status = scheduler.shorting_metadata_status()
    rejection_alert_status = scheduler.rejection_alert_status()
    tca_summary = _load_tca_summary(session, scheduler=scheduler)
    _hypothesis_payload, hypothesis_summary, _hypothesis_dependency_quorum = (
        _build_hypothesis_runtime_payload(
            scheduler,
            tca_summary=tca_summary,
            market_context_status=market_context_status,
        )
    )
    payload = render_trading_metrics(
        {
            **metrics.__dict__,
            "tca_summary": tca_summary,
            "route_provenance": _load_route_provenance_summary(session),
            "hypothesis_state_total": hypothesis_summary.get("state_totals", {}),
            "hypothesis_capital_stage_total": hypothesis_summary.get(
                "capital_stage_totals", {}
            ),
            "alpha_readiness_hypotheses_total": _safe_int(
                hypothesis_summary.get("hypotheses_total")
            ),
            "alpha_readiness_promotion_eligible_total": _safe_int(
                hypothesis_summary.get("promotion_eligible_total")
            ),
            "alpha_readiness_rollback_required_total": _safe_int(
                hypothesis_summary.get("rollback_required_total")
            ),
            "market_context_alert_active": int(
                bool(market_context_status.get("alert_active"))
            ),
            "market_context_last_freshness_seconds": _safe_int(
                market_context_status.get("last_freshness_seconds")
            ),
            "market_context_last_quality_score": _safe_float(
                market_context_status.get("last_quality_score")
            ),
            "llm_runtime_fallback_ratio": _safe_float(
                rejection_alert_status.get("runtime_fallback_ratio")
            ),
            "llm_runtime_fallback_alert_active": int(
                bool(rejection_alert_status.get("runtime_fallback_alert_active"))
            ),
            "shorting_metadata_account_ready": int(
                shorting_metadata_status.get("account_ready") is True
            ),
            "shorting_metadata_alert_active": int(
                bool(rejection_alert_status.get("shorting_metadata_alert_active"))
            ),
        }
    )
    return Response(content=payload, media_type="text/plain; version=0.0.4")


@router.get("/trading/decisions")
def trading_decisions(
    symbol: str | None = None,
    since: datetime | None = None,
    limit: int = Query(default=200, ge=1, le=500),
    session: Session = Depends(get_session),
) -> list[dict[str, object]]:
    """Return recent trade decisions."""

    stmt = select(TradeDecision).order_by(TradeDecision.created_at.desc())
    if symbol:
        stmt = stmt.where(TradeDecision.symbol == symbol)
    if since:
        stmt = stmt.where(TradeDecision.created_at >= since)
    stmt = stmt.limit(limit)
    decisions = session.execute(stmt).scalars().all()
    payload = [
        {
            "id": str(decision.id),
            "strategy_id": str(decision.strategy_id),
            "symbol": decision.symbol,
            "timeframe": decision.timeframe,
            "status": decision.status,
            "rationale": decision.rationale,
            "decision": decision.decision_json,
            "created_at": decision.created_at,
            "executed_at": decision.executed_at,
            "alpaca_account_label": decision.alpaca_account_label,
        }
        for decision in decisions
    ]
    return jsonable_encoder(payload)


__all__ = (
    "trading_autonomy",
    "trading_evidence_epoch_latest",
    "trading_evidence_epoch_detail",
    "trading_empirical_jobs",
    "trading_completion_doc29",
    "trading_completion_doc29_gate",
    "trading_autonomy_evidence_continuity",
    "trading_llm_evaluation",
    "prometheus_metrics",
    "trading_decisions",
)

# Public aliases used by split modules.
build_current_evidence_epoch = _build_current_evidence_epoch
daily_runtime_ledger_portfolio_summary = _daily_runtime_ledger_portfolio_summary
runtime_ledger_bucket_evidence_grade = _runtime_ledger_bucket_evidence_grade
