"""Extracted Torghut API route and support functions."""

from __future__ import annotations

from fastapi import APIRouter
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    pass

from .common import (
    Body,
    Depends,
    HTTPException,
    JSONResponse,
    Query,
    Request,
    Sequence,
    Session,
    WHITEPAPER_WORKFLOW,
    WhitepaperAnalysisRun,
    WhitepaperCodexAgentRun,
    WhitepaperDesignPullRequest,
    WhitepaperEngineeringTrigger,
    WhitepaperKafkaWorker,
    WhitepaperRolloutTransition,
    cast,
    get_session,
    jsonable_encoder,
    logger,
    os,
    select,
    whitepaper_inngest_enabled,
    whitepaper_kafka_enabled,
    whitepaper_semantic_indexing_enabled,
    whitepaper_workflow_enabled,
)
from ..bootstrap import (
    require_whitepaper_control_token as _require_whitepaper_control_token,
)
from .proxy import capture_module_exports

router = APIRouter()


@router.get("/whitepapers/status")
def whitepaper_status(request: Request) -> dict[str, object]:
    """Return whitepaper workflow enablement and runtime status."""

    worker: WhitepaperKafkaWorker | None = getattr(
        request.app.state, "whitepaper_worker", None
    )
    task = getattr(worker, "_task", None) if worker is not None else None
    worker_running = bool(task is not None and not task.done())
    control_token = (
        os.getenv("WHITEPAPER_WORKFLOW_API_TOKEN", "").strip()
        or os.getenv("WHITEPAPER_AGENTRUN_API_TOKEN", "").strip()
        or os.getenv("AGENTS_API_KEY", "").strip()
        or os.getenv("JANGAR_API_KEY", "").strip()
    )
    return {
        "workflow_enabled": whitepaper_workflow_enabled(),
        "kafka_enabled": whitepaper_kafka_enabled(),
        "inngest_enabled": whitepaper_inngest_enabled(),
        "inngest_registered": bool(
            getattr(request.app.state, "whitepaper_inngest_registered", False)
        ),
        "inngest_event_name": os.getenv(
            "WHITEPAPER_INNGEST_EVENT_NAME",
            "torghut/whitepaper.analysis.requested",
        ),
        "inngest_function_id": os.getenv(
            "WHITEPAPER_INNGEST_FUNCTION_ID",
            "torghut-whitepaper-analysis-v1",
        ),
        "inngest_finalized_event_name": os.getenv(
            "WHITEPAPER_INNGEST_FINALIZED_EVENT_NAME",
            "torghut/whitepaper.analysis.finalized",
        ),
        "inngest_finalize_function_id": os.getenv(
            "WHITEPAPER_INNGEST_FINALIZE_FUNCTION_ID",
            "torghut-whitepaper-synthesis-index-v1",
        ),
        "semantic_indexing_enabled": whitepaper_semantic_indexing_enabled(),
        "worker_running": worker_running,
        "requeue_comment_keyword": os.getenv(
            "WHITEPAPER_REQUEUE_COMMENT_KEYWORD",
            "research whitepaper",
        ),
        "control_auth_enabled": bool(control_token),
    }


@router.post("/whitepapers/events/github-issue")
def ingest_whitepaper_github_issue(
    request: Request,
    payload: dict[str, object] = Body(default={}),
    session: Session = Depends(get_session),
) -> JSONResponse:
    """Ingest a GitHub issue webhook payload and create/update whitepaper workflow state."""

    _require_whitepaper_control_token(request)

    try:
        result = WHITEPAPER_WORKFLOW.ingest_github_issue_event(
            session=session,
            payload=cast(dict[str, Any], payload),
            source="api",
        )
        if result.accepted:
            session.commit()
            return JSONResponse(
                status_code=202,
                content={
                    "accepted": True,
                    "reason": result.reason,
                    "run_id": result.run_id,
                    "document_key": result.document_key,
                    "agentrun_name": result.agentrun_name,
                },
            )
        session.rollback()
        return JSONResponse(
            status_code=200,
            content={
                "accepted": False,
                "reason": result.reason,
            },
        )
    except Exception as exc:
        session.rollback()
        logger.exception("Whitepaper issue intake failed")
        raise HTTPException(
            status_code=500, detail=f"whitepaper_issue_intake_failed:{exc}"
        ) from exc


@router.post("/whitepapers/runs/{run_id}/dispatch-agentrun")
def dispatch_whitepaper_agentrun(
    run_id: str,
    request: Request,
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Dispatch Codex AgentRun for an existing whitepaper analysis run."""

    _require_whitepaper_control_token(request)

    try:
        result = WHITEPAPER_WORKFLOW.dispatch_codex_agentrun(session, run_id)
    except ValueError as exc:
        session.rollback()
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        session.rollback()
        logger.exception("Whitepaper AgentRun dispatch failed for run_id=%s", run_id)
        raise HTTPException(
            status_code=502, detail=f"whitepaper_agentrun_dispatch_failed:{exc}"
        ) from exc
    session.commit()
    return cast(dict[str, object], result)


@router.post("/whitepapers/runs/{run_id}/finalize")
def finalize_whitepaper_run(
    run_id: str,
    request: Request,
    payload: dict[str, object] = Body(default={}),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Finalize run outputs from Inngest/AgentRun synthesis and verdict payloads."""

    _require_whitepaper_control_token(request)

    try:
        result = WHITEPAPER_WORKFLOW.finalize_run(
            session,
            run_id=run_id,
            payload=cast(dict[str, Any], payload),
        )
    except ValueError as exc:
        session.rollback()
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        session.rollback()
        logger.exception("Whitepaper finalize failed for run_id=%s", run_id)
        raise HTTPException(
            status_code=500, detail=f"whitepaper_finalize_failed:{exc}"
        ) from exc
    session.commit()
    return cast(dict[str, object], result)


@router.post("/whitepapers/runs/{run_id}/approve-implementation")
def approve_whitepaper_for_engineering(
    run_id: str,
    request: Request,
    payload: dict[str, object] = Body(default={}),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Manually approve a completed whitepaper for B1 engineering dispatch."""

    _require_whitepaper_control_token(request)

    approved_by = str(
        payload.get("approved_by") or payload.get("approvedBy") or ""
    ).strip()
    approval_reason = str(
        payload.get("approval_reason") or payload.get("approvalReason") or ""
    ).strip()
    approval_source = str(
        payload.get("approval_source") or payload.get("approvalSource") or "jangar_ui"
    ).strip()
    target_scope = (
        str(payload.get("target_scope") or payload.get("targetScope") or "").strip()
        or None
    )
    repository = str(payload.get("repository") or "").strip() or None
    base = str(payload.get("base") or "").strip() or None
    head = str(payload.get("head") or "").strip() or None
    rollout_profile = (
        str(
            payload.get("rollout_profile") or payload.get("rolloutProfile") or ""
        ).strip()
        or None
    )

    try:
        result = WHITEPAPER_WORKFLOW.approve_for_engineering(
            session,
            run_id=run_id,
            approved_by=approved_by,
            approval_reason=approval_reason,
            approval_source=approval_source or "jangar_ui",
            target_scope=target_scope,
            repository=repository,
            base=base,
            head=head,
            rollout_profile=rollout_profile,
        )
    except ValueError as exc:
        session.rollback()
        detail = str(exc)
        status = 404 if detail == "whitepaper_run_not_found" else 400
        raise HTTPException(status_code=status, detail=detail) from exc
    except Exception as exc:
        session.rollback()
        logger.exception("Whitepaper manual approval failed for run_id=%s", run_id)
        raise HTTPException(
            status_code=500, detail=f"whitepaper_manual_approval_failed:{exc}"
        ) from exc
    session.commit()
    return cast(dict[str, object], result)


@router.get("/whitepapers/runs/{run_id}")
def get_whitepaper_run(
    run_id: str,
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Return whitepaper run state, linked AgentRun status, and design PR metadata."""

    row = session.execute(
        select(WhitepaperAnalysisRun).where(WhitepaperAnalysisRun.run_id == run_id)
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="whitepaper_run_not_found")

    agentrun = (
        session.execute(
            select(WhitepaperCodexAgentRun)
            .where(WhitepaperCodexAgentRun.analysis_run_id == row.id)
            .order_by(WhitepaperCodexAgentRun.created_at.desc())
        )
        .scalars()
        .first()
    )

    pr_rows = (
        session.execute(
            select(WhitepaperDesignPullRequest)
            .where(WhitepaperDesignPullRequest.analysis_run_id == row.id)
            .order_by(WhitepaperDesignPullRequest.attempt.asc())
        )
        .scalars()
        .all()
    )
    trigger_row = session.execute(
        select(WhitepaperEngineeringTrigger).where(
            WhitepaperEngineeringTrigger.analysis_run_id == row.id
        )
    ).scalar_one_or_none()
    rollout_rows: Sequence[WhitepaperRolloutTransition] = []
    if trigger_row is not None:
        rollout_rows = (
            session.execute(
                select(WhitepaperRolloutTransition)
                .where(WhitepaperRolloutTransition.trigger_id == trigger_row.id)
                .order_by(WhitepaperRolloutTransition.created_at.asc())
            )
            .scalars()
            .all()
        )

    return jsonable_encoder(
        {
            "run_id": row.run_id,
            "status": row.status,
            "trigger_source": row.trigger_source,
            "trigger_actor": row.trigger_actor,
            "failure_reason": row.failure_reason,
            "created_at": row.created_at,
            "started_at": row.started_at,
            "completed_at": row.completed_at,
            "document": {
                "document_key": row.document.document_key if row.document else None,
                "source_identifier": row.document.source_identifier
                if row.document
                else None,
                "title": row.document.title if row.document else None,
                "status": row.document.status if row.document else None,
            },
            "document_version": {
                "version_number": row.document_version.version_number
                if row.document_version
                else None,
                "checksum_sha256": row.document_version.checksum_sha256
                if row.document_version
                else None,
                "ceph_bucket": row.document_version.ceph_bucket
                if row.document_version
                else None,
                "ceph_object_key": row.document_version.ceph_object_key
                if row.document_version
                else None,
                "parse_status": row.document_version.parse_status
                if row.document_version
                else None,
                "parse_error": row.document_version.parse_error
                if row.document_version
                else None,
            },
            "agentrun": {
                "name": agentrun.agentrun_name if agentrun else None,
                "namespace": agentrun.agentrun_namespace if agentrun else None,
                "status": agentrun.status if agentrun else None,
                "head_branch": agentrun.vcs_head_branch if agentrun else None,
                "started_at": agentrun.started_at if agentrun else None,
                "completed_at": agentrun.completed_at if agentrun else None,
            },
            "design_pull_requests": [
                {
                    "attempt": pr.attempt,
                    "status": pr.status,
                    "pr_number": pr.pr_number,
                    "pr_url": pr.pr_url,
                    "head_branch": pr.head_branch,
                    "base_branch": pr.base_branch,
                    "is_merged": pr.is_merged,
                    "merged_at": pr.merged_at,
                    "ci_status": pr.ci_status,
                }
                for pr in pr_rows
            ],
            "engineering_trigger": (
                {
                    "trigger_id": trigger_row.trigger_id,
                    "implementation_grade": trigger_row.implementation_grade,
                    "decision": trigger_row.decision,
                    "reason_codes": trigger_row.reason_codes_json,
                    "approval_token": trigger_row.approval_token,
                    "dispatched_agentrun_name": trigger_row.dispatched_agentrun_name,
                    "rollout_profile": trigger_row.rollout_profile,
                    "approval_source": trigger_row.approval_source,
                    "approved_by": trigger_row.approved_by,
                    "approved_at": trigger_row.approved_at,
                    "approval_reason": trigger_row.approval_reason,
                    "policy_ref": trigger_row.policy_ref,
                    "gate_snapshot_hash": trigger_row.gate_snapshot_hash,
                    "created_at": trigger_row.created_at,
                    "updated_at": trigger_row.updated_at,
                }
                if trigger_row is not None
                else None
            ),
            "rollout_transitions": [
                {
                    "transition_id": transition.transition_id,
                    "from_stage": transition.from_stage,
                    "to_stage": transition.to_stage,
                    "transition_type": transition.transition_type,
                    "status": transition.status,
                    "gate_results": transition.gate_results_json,
                    "reason_codes": transition.reason_codes_json,
                    "blocking_gate": transition.blocking_gate,
                    "evidence_hash": transition.evidence_hash,
                    "created_at": transition.created_at,
                }
                for transition in rollout_rows
            ],
        }
    )


@router.get("/whitepapers/search")
def search_whitepapers(
    q: str = Query(..., min_length=1),
    limit: int = Query(default=15, ge=1, le=50),
    offset: int = Query(default=0, ge=0),
    status: str = Query(default="completed"),
    scope: str = Query(default="all"),
    subject: str | None = Query(default=None),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Hybrid semantic + lexical whitepaper search over indexed chunks."""

    if not whitepaper_semantic_indexing_enabled():
        raise HTTPException(
            status_code=409, detail="whitepaper_semantic_search_disabled"
        )

    normalized_scope = scope.strip().lower()
    if normalized_scope not in {"all", "full_text", "synthesis"}:
        raise HTTPException(status_code=400, detail="whitepaper_search_invalid_scope")

    try:
        result = WHITEPAPER_WORKFLOW.search_semantic(
            session,
            query=q,
            limit=limit,
            offset=offset,
            status=status,
            scope=normalized_scope,
            subject=subject,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Whitepaper search failed")
        raise HTTPException(
            status_code=500, detail=f"whitepaper_search_failed:{exc}"
        ) from exc

    return cast(dict[str, object], jsonable_encoder(result))


__all__ = [
    "whitepaper_status",
    "ingest_whitepaper_github_issue",
    "dispatch_whitepaper_agentrun",
    "finalize_whitepaper_run",
    "approve_whitepaper_for_engineering",
    "get_whitepaper_run",
    "search_whitepapers",
]
capture_module_exports(globals(), __all__)
