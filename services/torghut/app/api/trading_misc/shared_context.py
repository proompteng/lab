"""Extracted Torghut API route and support functions."""

from __future__ import annotations

from ..health_checks import (
    build_control_plane_contract as _build_control_plane_contract,
    build_hypothesis_runtime_payload as _build_hypothesis_runtime_payload,
    build_shadow_first_runtime_payload as _build_shadow_first_runtime_payload,
    load_tca_summary as _load_tca_summary,
)
from fastapi import APIRouter
from typing import Any

from ..common import (
    BUILD_IMAGE_DIGEST,
    BUILD_VERSION,
    Body,
    Decimal,
    Depends,
    EvidenceEpoch,
    EvidenceReceipt,
    Execution,
    ExecutionTCAMetric,
    HTTPException,
    JSONResponse,
    LEAN_LANE_MANAGER,
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
    persist_evidence_epoch,
    render_trading_metrics,
    resolve_hypothesis_dependency_quorum,
    runtime_ledger_promotion_source_authority_blockers,
    select,
    settings,
    simulation_progress_snapshot,
    timezone,
    trading_time_status,
)

from ..common import main_runtime_value

from ..trading_scheduler_state import get_trading_scheduler
from .consumer_evidence_payload import (
    build_consumer_evidence_receipt_projection,
    build_trading_consumer_evidence_payload,
    consumer_evidence_summary_view,
    revenue_repair_topline_fields,
)

router = APIRouter()


@router.get("/trading/consumer-evidence")
def trading_consumer_evidence(
    view: str | None = Query(default=None),
) -> dict[str, object]:
    """Return Jangar-facing Torghut evidence without recursive Jangar status fetches."""

    return build_trading_consumer_evidence_payload(
        summary=consumer_evidence_summary_view(view)
    )


@router.get("/trading/metrics")
def trading_metrics(session: Session = Depends(get_session)) -> dict[str, object]:
    """Expose trading metrics counters."""

    scheduler = get_trading_scheduler()
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
        "metrics": metrics.to_payload(),
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


# Explicit barrel exports; keeps re-export imports intentional without file-level Ruff ignores.
__all__: tuple[str, ...] = (
    "BUILD_IMAGE_DIGEST",
    "Decimal",
    "Depends",
    "EvidenceEpoch",
    "EvidenceReceipt",
    "Execution",
    "ExecutionTCAMetric",
    "HTTPException",
    "JSONResponse",
    "Mapping",
    "Query",
    "Response",
    "SQLAlchemyError",
    "Sequence",
    "Session",
    "StrategyRuntimeLedgerBucket",
    "TradeDecision",
    "build_consumer_evidence_receipt_projection",
    "revenue_repair_topline_fields",
    "active_simulation_runtime_context",
    "build_artifact_parity_receipt",
    "build_consumer_evidence_receipt_projection",
    "build_data_freshness_receipt",
    "build_doc29_completion_status",
    "build_empirical_jobs_receipt",
    "build_empirical_jobs_status",
    "build_jangar_authority_receipt",
    "build_llm_evaluation_metrics",
    "build_portfolio_proof_receipt",
    "build_runtime_ledger_profit_distance_readback",
    "build_schema_receipt",
    "build_service_health_receipt",
    "cast",
    "compile_evidence_epoch",
    "cost_basis_counts_have_non_promotion_grade_costs",
    "datetime",
    "evaluate_evidence_continuity",
    "get_lean_backtest",
    "get_lean_shadow_parity",
    "get_session",
    "jsonable_encoder",
    "load_evidence_epoch_payload",
    "load_hypothesis_registry",
    "load_latest_evidence_epoch_payload",
    "logger",
    "main_runtime_value",
    "persist_evidence_epoch",
    "render_trading_metrics",
    "resolve_hypothesis_dependency_quorum",
    "revenue_repair_topline_fields",
    "router",
    "runtime_ledger_promotion_source_authority_blockers",
    "select",
    "settings",
    "submit_lean_backtest",
    "timezone",
    "trading_consumer_evidence",
    "trading_metrics",
    "trading_simulation_progress",
    "trading_time_status",
)
