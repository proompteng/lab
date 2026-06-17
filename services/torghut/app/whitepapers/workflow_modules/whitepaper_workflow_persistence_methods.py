# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Whitepaper workflow ingestion, orchestration, and persistence helpers."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import io
import json
import logging
import os
import re
import tempfile
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from http.client import HTTPConnection, HTTPSConnection
from pathlib import Path
from subprocess import CalledProcessError, run
from typing import Any, Mapping, cast
from urllib.parse import quote, urljoin, urlparse

import inngest
from sqlalchemy import case, delete, func, select, text
from sqlalchemy.orm import Session

from ...models import (
    VNextExperimentSpec,
    WhitepaperAnalysisRun,
    WhitepaperAnalysisStep,
    WhitepaperArtifact,
    WhitepaperClaim,
    WhitepaperClaimRelation,
    WhitepaperContradictionEvent,
    WhitepaperCodexAgentRun,
    WhitepaperContent,
    WhitepaperDesignPullRequest,
    WhitepaperDocument,
    WhitepaperDocumentVersion,
    WhitepaperEngineeringTrigger,
    WhitepaperExperimentSpec,
    WhitepaperRolloutTransition,
    WhitepaperStrategyTemplate,
    WhitepaperSynthesis,
    WhitepaperViabilityVerdict,
    coerce_json_payload,
)
from ...trading.discovery.whitepaper_candidate_compiler import (
    compile_claim_payloads_to_whitepaper_experiments,
)

# ruff: noqa: F401,F811,F821

from .shared_context import (
    EngineeringGradeDecision,
    GithubIssueEvent,
    ManualApprovalPayload,
    ELIGIBLE_AUTO_VERDICTS as _ELIGIBLE_AUTO_VERDICTS,
    GITHUB_ISSUE_ACTIONS as _GITHUB_ISSUE_ACTIONS,
    GITHUB_ISSUE_COMMENT_ACTIONS as _GITHUB_ISSUE_COMMENT_ACTIONS,
    MAX_SEMANTIC_RELEVANT_DISTANCE as _MAX_SEMANTIC_RELEVANT_DISTANCE,
    PASS_GATE_STATUSES as _PASS_GATE_STATUSES,
    REJECT_VERDICTS as _REJECT_VERDICTS,
    RETRYABLE_AGENTRUN_STATUSES as _RETRYABLE_AGENTRUN_STATUSES,
    SEMANTIC_RELATIVE_DISTANCE_WINDOW as _SEMANTIC_RELATIVE_DISTANCE_WINDOW,
    WHITEPAPER_CEPH_DEFAULT_CONFIG_DIR as _WHITEPAPER_CEPH_DEFAULT_CONFIG_DIR,
    WHITEPAPER_CEPH_DEFAULT_SECRET_DIR as _WHITEPAPER_CEPH_DEFAULT_SECRET_DIR,
    bool_env as _bool_env,
    coerce_issue_number as _coerce_issue_number,
    extract_github_event_metadata as _extract_github_event_metadata,
    extract_github_issue_payload as _extract_github_issue_payload,
    extract_sender_login as _extract_sender_login,
    float_env as _float_env,
    http_request_bytes as _http_request_bytes,
    int_env as _int_env,
    mounted_or_env_value as _mounted_or_env_value,
    normalize_identifier as _normalize_identifier,
    read_text_file as _read_text_file,
    sorted_unique as _sorted_unique,
    str_env as _str_env,
    whitepaper_ceph_bucket_name as _whitepaper_ceph_bucket_name,
    build_whitepaper_run_id,
    comment_requests_requeue,
    extract_pdf_urls,
    github_issue_number_from_url,
    logger,
    marker_end,
    marker_start,
    normalize_analysis_mode,
    normalize_attachment_url,
    normalize_github_issue_event,
    parse_marker_block,
    parse_marker_tags,
    whitepaper_inngest_enabled,
    whitepaper_kafka_enabled,
    whitepaper_requeue_comment_keyword,
    whitepaper_semantic_indexing_enabled,
    whitepaper_semantic_required,
    whitepaper_workflow_enabled,
)
from .ceph_s3_client import (
    CephS3Client,
    IssueKickoffResult,
    IssueRunIdentity as _IssueRunIdentity,
    PdfStorageOutcome as _PdfStorageOutcome,
    WhitepaperWorkflowServiceFields as _WhitepaperWorkflowServiceFields,
)
from .whitepaper_workflow_ingestion_methods import (
    WhitepaperWorkflowIngestionMethods as _WhitepaperWorkflowIngestionMethods,
)


class _WhitepaperWorkflowPersistenceMethods:
    def _requeue_existing_run(
        self,
        session: Session,
        *,
        run: WhitepaperAnalysisRun,
        issue_event: GithubIssueEvent,
        attachment_url: str,
        marker: Mapping[str, Any],
        source: str,
    ) -> IssueKickoffResult:
        document_key = str(run.document.document_key) if run.document else None
        if run.status == "completed":
            return IssueKickoffResult(
                accepted=False,
                reason="already_completed",
                run_id=run.run_id,
                document_key=document_key,
            )

        version = run.document_version
        if version is None or version.parse_status != "stored":
            return IssueKickoffResult(
                accepted=False,
                reason="requeue_not_ready",
                run_id=run.run_id,
                document_key=document_key,
            )

        latest_agentrun = (
            session.execute(
                select(WhitepaperCodexAgentRun)
                .where(WhitepaperCodexAgentRun.analysis_run_id == run.id)
                .order_by(WhitepaperCodexAgentRun.created_at.desc())
            )
            .scalars()
            .first()
        )
        if latest_agentrun and not self._is_retryable_agentrun_status(
            latest_agentrun.status
        ):
            return IssueKickoffResult(
                accepted=True,
                reason="already_dispatched",
                run_id=run.run_id,
                document_key=document_key,
                agentrun_name=latest_agentrun.agentrun_name,
            )

        context = cast(dict[str, Any], run.orchestration_context_json or {})
        context.update(
            {
                "repository": issue_event.repository,
                "issue_number": issue_event.issue_number,
                "issue_url": issue_event.issue_url,
                "attachment_url": attachment_url,
                "marker": coerce_json_payload(cast(dict[str, Any], marker)),
                "requeue_keyword": whitepaper_requeue_comment_keyword(),
            }
        )
        run.orchestration_context_json = coerce_json_payload(context)
        run.trigger_source = (
            "github_issue_comment_kafka"
            if source == "kafka"
            else "github_issue_comment_api"
        )
        run.trigger_actor = issue_event.actor
        run.failure_reason = None
        run.started_at = datetime.now(timezone.utc)
        session.add(run)

        requeue_attempt = self._next_step_attempt(
            session,
            analysis_run_id=run.id,
            step_name="requeue_request",
        )
        session.add(
            WhitepaperAnalysisStep(
                analysis_run_id=run.id,
                step_name="requeue_request",
                step_order=1,
                attempt=requeue_attempt,
                status="completed",
                executor="torghut",
                idempotency_key=issue_event.delivery_id,
                started_at=datetime.now(timezone.utc),
                completed_at=datetime.now(timezone.utc),
                input_json={
                    "source": source,
                    "event_name": issue_event.event_name,
                    "action": issue_event.action,
                    "comment_keyword": whitepaper_requeue_comment_keyword(),
                },
                output_json={
                    "run_id": run.run_id,
                    "reason": "requeue_requested",
                },
            )
        )

        if not _bool_env("WHITEPAPER_AGENTRUN_AUTO_DISPATCH", True):
            run.status = "queued"
            run.failure_reason = None
            session.add(run)
            return IssueKickoffResult(
                accepted=True,
                reason="requeued",
                run_id=run.run_id,
                document_key=document_key,
            )

        if whitepaper_inngest_enabled():
            run.status = "queued"
            run.failure_reason = None
            session.add(run)
            queued = self._enqueue_requested_inngest_event(session, run_row=run)
            return IssueKickoffResult(
                accepted=True,
                reason="requeued" if queued else "requeue_failed",
                run_id=run.run_id,
                document_key=document_key,
            )

        try:
            dispatch_result = self.dispatch_codex_agentrun(
                session, run.run_id, allow_retry=True
            )
            return IssueKickoffResult(
                accepted=True,
                reason="requeued",
                run_id=run.run_id,
                document_key=document_key,
                agentrun_name=cast(str | None, dispatch_result.get("agentrun_name")),
            )
        except Exception as exc:
            run.status = "failed"
            run.failure_reason = f"agentrun_dispatch_failed:{type(exc).__name__}:{exc}"
            session.add(run)
            return IssueKickoffResult(
                accepted=True,
                reason="requeue_failed",
                run_id=run.run_id,
                document_key=document_key,
            )

    def dispatch_codex_agentrun(
        self, session: Session, run_id: str, *, allow_retry: bool = False
    ) -> dict[str, Any]:
        run = session.execute(
            select(WhitepaperAnalysisRun).where(WhitepaperAnalysisRun.run_id == run_id)
        ).scalar_one_or_none()
        if run is None:
            raise ValueError("whitepaper_run_not_found")

        existing = (
            session.execute(
                select(WhitepaperCodexAgentRun)
                .where(WhitepaperCodexAgentRun.analysis_run_id == run.id)
                .order_by(WhitepaperCodexAgentRun.created_at.desc())
            )
            .scalars()
            .first()
        )
        if existing is not None:
            if not allow_retry or not self._is_retryable_agentrun_status(
                existing.status
            ):
                return {
                    "idempotent": True,
                    "agentrun_name": existing.agentrun_name,
                    "status": existing.status,
                }

        dispatch_count = session.execute(
            select(func.count())
            .select_from(WhitepaperCodexAgentRun)
            .where(WhitepaperCodexAgentRun.analysis_run_id == run.id)
        ).scalar_one()
        dispatch_attempt = int(dispatch_count or 0) + 1

        context = cast(dict[str, Any], run.orchestration_context_json or {})
        repository = str(
            context.get("repository")
            or _str_env("WHITEPAPER_DEFAULT_REPOSITORY", "proompteng/lab")
        )
        issue_url = str(context.get("issue_url") or "")
        issue_number = str(context.get("issue_number") or "0")
        github_issue_number = str(
            github_issue_number_from_url(issue_url, repository) or issue_number
        )
        issue_title = str(
            (run.document.title if run.document else "") or "Whitepaper analysis"
        )
        attachment_url = str(context.get("attachment_url") or "")
        marker = cast(dict[str, Any], context.get("marker") or {})
        analysis_profile = cast(dict[str, Any], run.analysis_profile_json or {})
        subject = self._optional_text(
            analysis_profile.get("subject")
        ) or self._optional_text(context.get("subject"))
        tags = self._coerce_tag_list(
            analysis_profile.get("tags") or context.get("tags")
        )
        analysis_mode = normalize_analysis_mode(
            self._optional_text(
                analysis_profile.get("analysis_mode") or context.get("analysis_mode")
            )
        )

        base_branch = str(
            marker.get("base_branch")
            or _str_env("WHITEPAPER_DEFAULT_BASE_BRANCH", "main")
        )
        default_head_branch = f"codex/whitepaper-{run.run_id[-16:]}"
        if dispatch_attempt > 1 and "head_branch" not in marker:
            default_head_branch = f"{default_head_branch}-retry-{dispatch_attempt}"
        head_branch = str(marker.get("head_branch") or default_head_branch)

        version = run.document_version
        if version is None:
            raise ValueError("whitepaper_version_missing")

        bucket = version.ceph_bucket
        key = version.ceph_object_key
        ceph_uri = f"s3://{bucket}/{key}"

        prompt = self._build_whitepaper_prompt(
            run_id=run.run_id,
            repository=repository,
            issue_url=issue_url,
            issue_title=issue_title,
            attachment_url=attachment_url,
            ceph_uri=ceph_uri,
            subject=subject,
            tags=tags,
            analysis_mode=analysis_mode,
        )
        labels = ["whitepaper", "torghut"]
        if analysis_mode == "implementation":
            labels.append("design-doc")
        else:
            labels.append("analysis-only")
        if subject:
            labels.append(f"subject-{_normalize_identifier(subject)}")
        for tag in tags[:5]:
            labels.append(f"tag-{_normalize_identifier(tag)}")
        labels = _sorted_unique(labels)

        payload: dict[str, Any] = {
            "namespace": _str_env("WHITEPAPER_AGENTRUN_NAMESPACE", "agents"),
            "idempotencyKey": run.run_id
            if dispatch_attempt == 1
            else f"{run.run_id}-retry-{dispatch_attempt}",
            "agentRef": {
                "name": _str_env("WHITEPAPER_AGENT_NAME", "codex-whitepaper-agent")
            },
            "runtime": {"type": "job"},
            "implementation": {
                "summary": f"Whitepaper analysis {run.run_id}",
                "text": prompt,
                "source": {
                    "provider": "github",
                    "url": issue_url
                    or f"https://github.com/{repository}/issues/{github_issue_number}",
                },
                "vcsRef": {"name": _str_env("WHITEPAPER_AGENTRUN_VCS_REF", "github")},
                "labels": labels,
            },
            "vcsRef": {"name": _str_env("WHITEPAPER_AGENTRUN_VCS_REF", "github")},
            "vcsPolicy": {"required": True, "mode": "read-write"},
            "parameters": {
                "repository": repository,
                "base": base_branch,
                "head": head_branch,
                "issueNumber": github_issue_number,
                "issueTitle": issue_title,
                "issueUrl": issue_url,
                "runId": run.run_id,
                "documentKey": run.document.document_key if run.document else "",
                "cephUri": ceph_uri,
                "attachmentUrl": attachment_url,
                "subject": subject or "",
                "tags": ",".join(tags),
                "analysisMode": analysis_mode,
            },
            "policy": {
                "secretBindingRef": _str_env(
                    "WHITEPAPER_AGENTRUN_SECRET_BINDING",
                    "codex-whitepaper-github-token",
                )
            },
            "ttlSecondsAfterFinished": _int_env(
                "WHITEPAPER_AGENTRUN_TTL_SECONDS", 7200
            ),
        }

        idempotency_key = cast(str, payload["idempotencyKey"])
        response_payload = self._submit_agents_agentrun(
            payload, idempotency_key=idempotency_key
        )
        resource = cast(dict[str, Any], response_payload.get("resource") or {})
        metadata = cast(dict[str, Any], resource.get("metadata") or {})
        status = cast(dict[str, Any], resource.get("status") or {})
        agentrun_name = str(metadata.get("name") or "").strip()
        agentrun_uid = str(metadata.get("uid") or "").strip() or None
        phase = str(status.get("phase") or "queued").strip().lower() or "queued"

        if not agentrun_name:
            raise RuntimeError("jangar_response_missing_agentrun_name")

        step = WhitepaperAnalysisStep(
            analysis_run_id=run.id,
            step_name="agentrun_dispatch",
            step_order=2,
            attempt=self._next_step_attempt(
                session,
                analysis_run_id=run.id,
                step_name="agentrun_dispatch",
            ),
            status="completed",
            executor="torghut",
            idempotency_key=idempotency_key,
            started_at=datetime.now(timezone.utc),
            completed_at=datetime.now(timezone.utc),
            input_json={"payload": payload},
            output_json=response_payload,
        )
        session.add(step)
        session.flush()

        agentrun_row = WhitepaperCodexAgentRun(
            analysis_run_id=run.id,
            analysis_step_id=step.id,
            agentrun_name=agentrun_name,
            agentrun_namespace=_str_env("WHITEPAPER_AGENTRUN_NAMESPACE", "agents"),
            agentrun_uid=agentrun_uid,
            status=phase,
            execution_mode="workflow",
            requested_by=run.trigger_actor,
            vcs_provider="github",
            vcs_repository=repository,
            vcs_base_branch=base_branch,
            vcs_head_branch=head_branch,
            vcs_base_commit_sha=None,
            vcs_head_commit_sha=None,
            workspace_context_json={
                "issue_url": issue_url,
                "attachment_url": attachment_url,
                "ceph_uri": ceph_uri,
            },
            prompt_text=prompt,
            prompt_hash=hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
            input_context_json={"request": payload},
            output_context_json=response_payload,
            started_at=datetime.now(timezone.utc),
        )
        session.add(agentrun_row)

        run.status = "agentrun_dispatched"
        run.failure_reason = None
        session.add(run)
        return {
            "agentrun_name": agentrun_name,
            "agentrun_uid": agentrun_uid,
            "status": phase,
        }

    def finalize_run(
        self,
        session: Session,
        *,
        run_id: str,
        payload: Mapping[str, Any],
    ) -> dict[str, Any]:
        run = self._get_run_or_raise(session, run_id)
        self._upsert_synthesis(session, run, payload.get("synthesis"))
        self._upsert_verdict(session, run, payload.get("verdict"))
        self._sync_structured_research_outputs(session, run, payload)
        self._upsert_design_pull_requests(
            session, run, payload.get("design_pull_request")
        )
        self._ingest_artifacts(session, run, payload.get("artifacts"))
        self._upsert_steps(session, run, payload.get("steps"))
        self._complete_run(session, run, payload)
        trigger_result = self._evaluate_and_process_engineering_trigger(
            session,
            run,
            manual_approval=None,
        )
        if run.status == "completed" and whitepaper_semantic_indexing_enabled():
            queued_for_async_indexing = False
            if whitepaper_inngest_enabled():
                queued_for_async_indexing = self._enqueue_finalized_inngest_event(
                    session, run=run
                )

            if not queued_for_async_indexing:
                self.index_synthesis_semantic_content(
                    session,
                    run_id=run.run_id,
                )

        return {
            "run_id": run.run_id,
            "status": run.status,
            "completed_at": run.completed_at.isoformat() if run.completed_at else None,
            "engineering_trigger": trigger_result,
        }

    def approve_for_engineering(
        self,
        session: Session,
        *,
        run_id: str,
        approved_by: str,
        approval_reason: str,
        approval_source: str = "jangar_ui",
        target_scope: str | None = None,
        repository: str | None = None,
        base: str | None = None,
        head: str | None = None,
        rollout_profile: str | None = None,
    ) -> dict[str, Any]:
        run = self._get_run_or_raise(session, run_id)
        approver = self._optional_text(approved_by)
        reason = self._optional_text(approval_reason)
        if run.status != "completed":
            raise ValueError("whitepaper_run_not_completed")
        if not approver:
            raise ValueError("approved_by_required")
        if not reason:
            raise ValueError("approval_reason_required")
        if run.synthesis is None:
            raise ValueError("whitepaper_synthesis_missing")
        if run.viability_verdict is None:
            raise ValueError("whitepaper_verdict_missing")

        trigger_result = self._evaluate_and_process_engineering_trigger(
            session,
            run,
            manual_approval=ManualApprovalPayload(
                approved_by=approver,
                approval_reason=reason,
                approval_source=self._optional_text(approval_source) or "jangar_ui",
                target_scope=target_scope,
                repository=repository,
                base=base,
                head=head,
                rollout_profile=rollout_profile,
            ),
        )
        return {
            "run_id": run.run_id,
            "status": run.status,
            "engineering_trigger": trigger_result,
        }

    @staticmethod
    def _get_run_or_raise(session: Session, run_id: str) -> WhitepaperAnalysisRun:
        run = session.execute(
            select(WhitepaperAnalysisRun).where(WhitepaperAnalysisRun.run_id == run_id)
        ).scalar_one_or_none()
        if run is None:
            raise ValueError("whitepaper_run_not_found")
        return run

    def process_requested_run(
        self,
        session: Session,
        *,
        run_id: str,
        inngest_function_id: str | None,
        inngest_run_id: str | None,
    ) -> dict[str, Any]:
        run = self._get_run_or_raise(session, run_id)
        if run.status == "completed":
            return {"run_id": run.run_id, "status": run.status, "idempotent": True}

        if inngest_function_id:
            run.inngest_function_id = inngest_function_id
        if inngest_run_id:
            run.inngest_run_id = inngest_run_id[:128]
        run.status = "queued"
        run.failure_reason = None
        run.started_at = datetime.now(timezone.utc)
        session.add(run)

        context = cast(dict[str, Any], run.orchestration_context_json or {})
        attachment_url = self._optional_text(context.get("attachment_url"))
        if not attachment_url:
            run.status = "failed"
            run.failure_reason = "attachment_url_missing"
            session.add(run)
            raise RuntimeError("attachment_url_missing")

        extraction_step_attempt = self._next_step_attempt(
            session,
            analysis_run_id=run.id,
            step_name="semantic_extract_full_text",
        )
        extraction_step = WhitepaperAnalysisStep(
            analysis_run_id=run.id,
            step_name="semantic_extract_full_text",
            step_order=2,
            attempt=extraction_step_attempt,
            status="queued",
            executor="torghut",
            started_at=datetime.now(timezone.utc),
            input_json={"attachment_url": attachment_url},
        )
        session.add(extraction_step)
        session.flush()

        full_text: str = ""
        extraction_meta: dict[str, Any] = {}
        try:
            pdf_bytes = self._download_pdf(attachment_url)
            extracted = self._extract_pdf_text(pdf_bytes)
            full_text = extracted["full_text"]
            extraction_meta = cast(dict[str, Any], extracted.get("metadata") or {})
            if not full_text.strip() and whitepaper_semantic_required():
                raise RuntimeError("full_text_empty")
            self._upsert_whitepaper_content(
                session,
                run=run,
                full_text=full_text,
                extraction_meta=extraction_meta,
            )
            extraction_step.status = "completed"
            extraction_step.completed_at = datetime.now(timezone.utc)
            extraction_step.output_json = {
                "char_count": len(full_text),
                "token_count": len(full_text.split()),
                "page_count": extraction_meta.get("page_count"),
                "method": extraction_meta.get("extract_method"),
            }
            session.add(extraction_step)
        except Exception as exc:
            extraction_step.status = "failed"
            extraction_step.completed_at = datetime.now(timezone.utc)
            extraction_step.error_json = {"error": str(exc)}
            session.add(extraction_step)
            if whitepaper_semantic_required():
                run.status = "failed"
                run.failure_reason = (
                    f"semantic_extract_failed:{type(exc).__name__}:{exc}"
                )
                session.add(run)
                raise

        if whitepaper_semantic_indexing_enabled() and full_text.strip():
            self.index_full_text_semantic_content(
                session, run_id=run.run_id, full_text=full_text
            )

        if _bool_env("WHITEPAPER_AGENTRUN_AUTO_DISPATCH", True):
            self.dispatch_codex_agentrun(session, run.run_id)

        return {"run_id": run.run_id, "status": run.status}

    def index_full_text_semantic_content(
        self,
        session: Session,
        *,
        run_id: str,
        full_text: str,
    ) -> dict[str, Any]:
        run = self._get_run_or_raise(session, run_id)
        chunks = self._build_chunks(full_text, source_scope="full_text")
        return self._persist_semantic_chunks_and_embeddings(
            session,
            run=run,
            source_scope="full_text",
            chunks=chunks,
        )

    def index_synthesis_semantic_content(
        self,
        session: Session,
        *,
        run_id: str,
    ) -> dict[str, Any]:
        run = self._get_run_or_raise(session, run_id)
        synthesis = run.synthesis
        if synthesis is None:
            return {
                "run_id": run.run_id,
                "indexed_chunks": 0,
                "source_scope": "synthesis",
            }

        sections: list[tuple[str, str]] = []
        section_candidates = [
            ("executive_summary", synthesis.executive_summary),
            ("problem_statement", synthesis.problem_statement),
            ("methodology_summary", synthesis.methodology_summary),
            ("implementation_plan", synthesis.implementation_plan_md),
        ]
        for section_key, section_text in section_candidates:
            if not section_text:
                continue
            stripped = section_text.strip()
            if stripped:
                sections.append((section_key, stripped))

        for finding in self._coerce_string_list(synthesis.key_findings_json):
            sections.append(("key_findings", finding))
        for novelty in self._coerce_string_list(synthesis.novelty_claims_json):
            sections.append(("novelty_claims", novelty))

        combined_chunks: list[dict[str, Any]] = []
        for section_key, section_text in sections:
            for chunk in self._build_chunks(section_text, source_scope="synthesis"):
                chunk["section_key"] = section_key
                combined_chunks.append(chunk)

        return self._persist_semantic_chunks_and_embeddings(
            session,
            run=run,
            source_scope="synthesis",
            chunks=combined_chunks,
        )


__all__: tuple[str, ...] = ()

# Public aliases used by split modules.
WhitepaperWorkflowPersistenceMethods = _WhitepaperWorkflowPersistenceMethods
