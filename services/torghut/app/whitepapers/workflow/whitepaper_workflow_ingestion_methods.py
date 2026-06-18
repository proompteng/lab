"""Whitepaper workflow ingestion, orchestration, and persistence helpers."""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Mapping, cast

import inngest
from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from ...models import (
    WhitepaperAnalysisRun,
    WhitepaperAnalysisStep,
    WhitepaperDocument,
    WhitepaperDocumentVersion,
    coerce_json_payload,
)


from .shared_context import (
    RETRYABLE_AGENTRUN_STATUSES as _RETRYABLE_AGENTRUN_STATUSES,
    bool_env as _bool_env,
    normalize_identifier as _normalize_identifier,
    optional_int as _optional_int,
    optional_text as _optional_text,
    sorted_unique as _sorted_unique,
    str_env as _str_env,
    whitepaper_ceph_bucket_name as _whitepaper_ceph_bucket_name,
    build_whitepaper_run_id,
    extract_pdf_urls,
    logger,
    normalize_analysis_mode,
    normalize_attachment_url,
    normalize_github_issue_event,
    parse_marker_block,
    parse_marker_tags,
    whitepaper_inngest_enabled,
    whitepaper_semantic_indexing_enabled,
    whitepaper_workflow_enabled,
)
from .ceph_s3_client import (
    CephS3Client,
    IssueKickoffResult,
    IssueRunIdentity as _IssueRunIdentity,
    PdfStorageOutcome as _PdfStorageOutcome,
    WhitepaperWorkflowServiceContract as _WhitepaperWorkflowServiceContract,
)


if TYPE_CHECKING:
    _WhitepaperWorkflowIngestionBase = _WhitepaperWorkflowServiceContract
else:
    _WhitepaperWorkflowIngestionBase = object


class _WhitepaperWorkflowIngestionMethods(_WhitepaperWorkflowIngestionBase):
    def __init__(self) -> None:
        self.ceph_client: Any | None = CephS3Client.from_env()
        self.inngest_client: inngest.Inngest | None = None

    def set_inngest_client(self, client: inngest.Inngest | None) -> None:
        self.inngest_client = client

    def _resolve_ceph_client(self) -> CephS3Client | Any | None:
        if self.ceph_client is not None and not isinstance(
            self.ceph_client, CephS3Client
        ):
            return self.ceph_client
        self.ceph_client = CephS3Client.from_env()
        return self.ceph_client

    def ingest_github_issue_event(
        self,
        session: Session,
        payload: Mapping[str, Any],
        *,
        source: str,
    ) -> IssueKickoffResult:
        if not whitepaper_workflow_enabled():
            return IssueKickoffResult(accepted=False, reason="workflow_disabled")

        issue_event = normalize_github_issue_event(payload)
        if issue_event is None:
            return IssueKickoffResult(accepted=False, reason="ignored_event")

        marker_rejection, marker, attachment_url = self._resolve_marker_and_attachment(
            issue_event.issue_body
        )
        if marker_rejection is not None or marker is None:
            return marker_rejection or IssueKickoffResult(
                accepted=False, reason="marker_missing"
            )

        if (
            issue_event.event_name == "issue_comment"
            and not issue_event.requeue_requested
        ):
            return IssueKickoffResult(
                accepted=False, reason="comment_without_requeue_keyword"
            )

        source_identifier = f"{issue_event.repository}#{issue_event.issue_number}"
        run_id_seed = build_whitepaper_run_id(
            source_identifier=source_identifier,
            attachment_url=attachment_url,
        )
        trace_seed = f"{source_identifier}|{attachment_url}"
        run_identity = _IssueRunIdentity(
            run_id=run_id_seed,
            retry_of_run_id=None,
            marker_hash=hashlib.sha256(trace_seed.encode("utf-8")).hexdigest()[:32],
        )

        existing_run = session.execute(
            select(WhitepaperAnalysisRun).where(
                WhitepaperAnalysisRun.run_id == run_id_seed
            )
        ).scalar_one_or_none()
        if existing_run is not None:
            if issue_event.requeue_requested:
                return self._requeue_existing_run(
                    session,
                    run=existing_run,
                    issue_event=issue_event,
                    attachment_url=attachment_url,
                    marker=marker,
                    source=source,
                )
            return self._idempotent_kickoff_result(existing_run)

        storage = self._store_issue_pdf(
            attachment_url=attachment_url,
        )
        if storage.parse_status == "stored":
            existing_file_run = self._find_existing_run_by_checksum(
                session,
                checksum=storage.checksum,
            )
            if existing_file_run is not None:
                return self._idempotent_kickoff_result(
                    existing_file_run,
                    reason="idempotent_file_replay",
                )

        document = self._upsert_issue_document(
            session=session,
            source_identifier=source_identifier,
            issue_event=issue_event,
            marker=marker,
        )
        version_row = self._create_issue_document_version(
            session=session,
            document=document,
            issue_event=issue_event,
            source=source,
            attachment_url=attachment_url,
            storage=storage,
        )
        run_row = self._create_issue_run_row(
            session=session,
            issue_event=issue_event,
            source=source,
            marker=marker,
            attachment_url=attachment_url,
            run_identity=run_identity,
            document=document,
            version_row=version_row,
            storage=storage,
        )
        self._record_issue_intake_step(
            session=session,
            run_row=run_row,
            issue_event=issue_event,
            source=source,
            marker_hash=run_identity.marker_hash,
            run_id=run_row.run_id,
            document_key=document.document_key,
            parse_error=storage.parse_error,
        )

        document.status = "queued" if run_row.status == "queued" else "failed"
        document.last_processed_at = datetime.now(timezone.utc)
        session.add(document)

        agentrun_name = None
        if run_row.status == "queued" and whitepaper_inngest_enabled():
            enqueue_result = self._enqueue_requested_inngest_event(
                session,
                run_row=run_row,
            )
            if not enqueue_result:
                run_row.status = "failed"
                run_row.failure_reason = "inngest_enqueue_failed"
                session.add(run_row)
        else:
            agentrun_name = self._dispatch_agentrun_if_enabled(session, run_row)

        session.flush()
        return IssueKickoffResult(
            accepted=True,
            reason="queued" if run_row.status != "failed" else "failed",
            run_id=run_row.run_id,
            document_key=document.document_key,
            agentrun_name=agentrun_name,
        )

    @staticmethod
    def _resolve_marker_and_attachment(
        issue_body: str,
    ) -> tuple[IssueKickoffResult | None, dict[str, Any] | None, str]:
        marker = parse_marker_block(issue_body)
        if marker is None:
            return IssueKickoffResult(accepted=False, reason="marker_missing"), None, ""

        workflow_name = str(marker.get("workflow") or "").strip().lower()
        if workflow_name and workflow_name != "whitepaper-analysis-v1":
            return (
                IssueKickoffResult(
                    accepted=False, reason="unsupported_workflow_marker"
                ),
                None,
                "",
            )

        attachments = extract_pdf_urls(issue_body)
        attachment_url = normalize_attachment_url(
            str(marker.get("attachment_url") or (attachments[0] if attachments else ""))
        )
        if not attachment_url:
            return (
                IssueKickoffResult(accepted=False, reason="pdf_attachment_missing"),
                None,
                "",
            )

        return None, marker, attachment_url

    @staticmethod
    def _idempotent_kickoff_result(
        run: WhitepaperAnalysisRun,
        *,
        reason: str = "idempotent_replay",
    ) -> IssueKickoffResult:
        return IssueKickoffResult(
            accepted=True,
            reason=reason,
            run_id=run.run_id,
            document_key=str(run.document.document_key) if run.document else None,
        )

    @staticmethod
    def _find_existing_run_by_checksum(
        session: Session,
        *,
        checksum: str,
    ) -> WhitepaperAnalysisRun | None:
        status_rank = case(
            (WhitepaperAnalysisRun.status == "completed", 0),
            (WhitepaperAnalysisRun.status == "agentrun_dispatched", 1),
            (WhitepaperAnalysisRun.status == "queued", 2),
            else_=3,
        )
        return (
            session.execute(
                select(WhitepaperAnalysisRun)
                .join(
                    WhitepaperDocumentVersion,
                    WhitepaperDocumentVersion.id
                    == WhitepaperAnalysisRun.document_version_id,
                )
                .where(WhitepaperDocumentVersion.checksum_sha256 == checksum)
                .order_by(status_rank.asc(), WhitepaperAnalysisRun.created_at.desc())
            )
            .scalars()
            .first()
        )

    def _upsert_issue_document(
        self,
        *,
        session: Session,
        source_identifier: str,
        issue_event: Any,
        marker: Mapping[str, Any],
    ) -> WhitepaperDocument:
        subject = _optional_text(marker.get("subject"))
        marker_tags = parse_marker_tags(_optional_text(marker.get("tags")))
        metadata = {
            "repository": issue_event.repository,
            "issue_number": issue_event.issue_number,
            "issue_url": issue_event.issue_url,
            "subject": subject,
            "analysis_mode": normalize_analysis_mode(
                _optional_text(marker.get("analysis_mode"))
            ),
        }
        document = session.execute(
            select(WhitepaperDocument).where(
                WhitepaperDocument.source == "github_issue",
                WhitepaperDocument.source_identifier == source_identifier,
            )
        ).scalar_one_or_none()
        if document is None:
            document = WhitepaperDocument(
                source="github_issue",
                source_identifier=source_identifier,
                title=issue_event.issue_title,
                status="uploaded",
                metadata_json=metadata,
                tags_json=marker_tags or None,
                ingested_by=issue_event.actor,
            )
            session.add(document)
            session.flush()
            return document

        document.title = issue_event.issue_title or document.title
        merged_tags: list[str] = []
        document_tags_raw: object = document.tags_json
        if isinstance(document_tags_raw, list):
            merged_tags.extend(
                [
                    _optional_text(item) or ""
                    for item in cast(list[object], document_tags_raw)
                ]
            )
        merged_tags.extend(marker_tags)
        normalized_tags = _sorted_unique(
            [_normalize_identifier(tag) for tag in merged_tags if tag and tag.strip()]
        )
        document.tags_json = normalized_tags or None
        document.metadata_json = coerce_json_payload(
            {
                **cast(dict[str, Any], document.metadata_json or {}),
                **metadata,
            }
        )
        session.add(document)
        return document

    def _store_issue_pdf(
        self,
        *,
        attachment_url: str,
    ) -> _PdfStorageOutcome:
        download_error: str | None = None
        pdf_bytes: bytes | None = None
        try:
            pdf_bytes = self._download_pdf(attachment_url)
        except Exception as exc:
            download_error = f"download_failed:{type(exc).__name__}:{exc}"

        checksum = (
            hashlib.sha256(pdf_bytes).hexdigest()
            if pdf_bytes is not None
            else hashlib.sha256(attachment_url.encode("utf-8")).hexdigest()
        )
        ceph_bucket = _whitepaper_ceph_bucket_name()
        ceph_key = f"raw/checksum/{checksum[:2]}/{checksum}/source.pdf"
        file_size = len(pdf_bytes) if pdf_bytes is not None else None

        parse_status = "pending"
        parse_error = download_error
        ceph_etag: str | None = None
        ceph_client = self._resolve_ceph_client()
        if pdf_bytes is not None and ceph_client is not None:
            try:
                upload_result = ceph_client.put_object(
                    bucket=ceph_bucket,
                    key=ceph_key,
                    body=pdf_bytes,
                    content_type="application/pdf",
                )
                ceph_etag = cast(str | None, upload_result.get("etag"))
                parse_status = "stored"
                parse_error = None
            except Exception as exc:
                parse_status = "failed"
                parse_error = f"ceph_upload_failed:{type(exc).__name__}:{exc}"
        elif pdf_bytes is None:
            parse_status = "failed"
        else:
            parse_status = "failed"
            parse_error = "ceph_client_not_configured"

        return _PdfStorageOutcome(
            ceph_bucket=ceph_bucket,
            ceph_key=ceph_key,
            checksum=checksum,
            ceph_etag=ceph_etag,
            file_size=file_size,
            parse_status=parse_status,
            parse_error=parse_error,
        )

    def _create_issue_document_version(
        self,
        *,
        session: Session,
        document: WhitepaperDocument,
        issue_event: Any,
        source: str,
        attachment_url: str,
        storage: _PdfStorageOutcome,
    ) -> WhitepaperDocumentVersion:
        max_version = session.execute(
            select(func.max(WhitepaperDocumentVersion.version_number)).where(
                WhitepaperDocumentVersion.document_id == document.id
            )
        ).scalar_one()
        next_version = int(max_version or 0) + 1

        version_row = WhitepaperDocumentVersion(
            document_id=document.id,
            version_number=next_version,
            trigger_reason="github_issue",
            file_name=f"issue-{issue_event.issue_number}.pdf",
            mime_type="application/pdf",
            file_size_bytes=storage.file_size,
            checksum_sha256=storage.checksum,
            ceph_bucket=storage.ceph_bucket,
            ceph_object_key=storage.ceph_key,
            ceph_etag=storage.ceph_etag,
            parse_status=storage.parse_status,
            parse_error=storage.parse_error,
            upload_metadata_json={
                "attachment_url": attachment_url,
                "source": source,
                "delivery_id": issue_event.delivery_id,
            },
            uploaded_by=issue_event.actor,
            processed_at=datetime.now(timezone.utc),
        )
        session.add(version_row)
        session.flush()
        return version_row

    def _create_issue_run_row(
        self,
        *,
        session: Session,
        issue_event: Any,
        source: str,
        marker: Mapping[str, Any],
        attachment_url: str,
        run_identity: _IssueRunIdentity,
        document: WhitepaperDocument,
        version_row: WhitepaperDocumentVersion,
        storage: _PdfStorageOutcome,
    ) -> WhitepaperAnalysisRun:
        run_status = "queued" if storage.parse_status == "stored" else "failed"
        subject = _optional_text(marker.get("subject"))
        tags = parse_marker_tags(_optional_text(marker.get("tags")))
        analysis_mode = normalize_analysis_mode(
            _optional_text(marker.get("analysis_mode"))
        )
        run_row = WhitepaperAnalysisRun(
            run_id=run_identity.run_id,
            document_id=document.id,
            document_version_id=version_row.id,
            status=run_status,
            trigger_source="github_issue_kafka"
            if source == "kafka"
            else "github_issue_api",
            trigger_actor=issue_event.actor,
            retry_of_run_id=run_identity.retry_of_run_id,
            inngest_event_id=issue_event.delivery_id,
            orchestration_context_json={
                "repository": issue_event.repository,
                "issue_number": issue_event.issue_number,
                "issue_url": issue_event.issue_url,
                "marker": marker,
                "attachment_url": attachment_url,
                "subject": subject,
                "tags": tags,
                "analysis_mode": analysis_mode,
            },
            analysis_profile_json={
                "subject": subject,
                "tags": tags,
                "analysis_mode": analysis_mode,
            },
            request_payload_json=issue_event.raw_payload,
            failure_reason=storage.parse_error,
            started_at=datetime.now(timezone.utc),
        )
        session.add(run_row)
        session.flush()
        return run_row

    @staticmethod
    def _record_issue_intake_step(
        *,
        session: Session,
        run_row: WhitepaperAnalysisRun,
        issue_event: Any,
        source: str,
        marker_hash: str,
        run_id: str,
        document_key: str,
        parse_error: str | None,
    ) -> None:
        session.add(
            WhitepaperAnalysisStep(
                analysis_run_id=run_row.id,
                step_name="issue_intake",
                step_order=1,
                attempt=1,
                status="completed" if run_row.status == "queued" else "failed",
                executor="torghut",
                idempotency_key=issue_event.delivery_id,
                trace_id=marker_hash[:32],
                started_at=datetime.now(timezone.utc),
                completed_at=datetime.now(timezone.utc),
                input_json={"source": source, "delivery_id": issue_event.delivery_id},
                output_json={"run_id": run_id, "document_key": document_key},
                error_json={"error": parse_error} if parse_error else None,
            )
        )

    def _dispatch_agentrun_if_enabled(
        self,
        session: Session,
        run_row: WhitepaperAnalysisRun,
    ) -> str | None:
        if run_row.status != "queued" or not _bool_env(
            "WHITEPAPER_AGENTRUN_AUTO_DISPATCH", True
        ):
            return None

        try:
            dispatched = self.dispatch_codex_agentrun(session, run_row.run_id)
        except Exception as exc:
            run_row.status = "failed"
            run_row.failure_reason = (
                f"agentrun_dispatch_failed:{type(exc).__name__}:{exc}"
            )
            session.add(run_row)
            return None
        return cast(str | None, dispatched.get("agentrun_name"))

    def _enqueue_requested_inngest_event(
        self,
        session: Session,
        *,
        run_row: WhitepaperAnalysisRun,
    ) -> bool:
        if not whitepaper_inngest_enabled():
            return False
        if self.inngest_client is None:
            run_row.failure_reason = "inngest_client_not_configured"
            run_row.status = "failed"
            session.add(run_row)
            return False

        event_name = (
            _str_env(
                "WHITEPAPER_INNGEST_EVENT_NAME", "torghut/whitepaper.analysis.requested"
            )
            or "torghut/whitepaper.analysis.requested"
        )
        context = dict(
            cast(Mapping[str, Any], run_row.orchestration_context_json or {})
        )
        enqueue_attempt = (
            _optional_int(context.get("inngest_enqueue_attempt")) or 0
        ) + 1
        enqueue_key = f"{run_row.run_id}:{enqueue_attempt}"
        try:
            event_ids = self.inngest_client.send_sync(
                inngest.Event(
                    name=event_name,
                    data={
                        "run_id": run_row.run_id,
                        "enqueue_key": enqueue_key,
                        "enqueue_attempt": enqueue_attempt,
                    },
                )
            )
        except Exception as exc:
            run_row.failure_reason = (
                f"inngest_enqueue_failed:{type(exc).__name__}:{exc}"
            )
            run_row.status = "failed"
            session.add(run_row)
            return False

        run_row.inngest_event_id = (
            event_ids[0] if event_ids else run_row.inngest_event_id
        )
        context["inngest_enqueue_attempt"] = enqueue_attempt
        context["inngest_enqueue_key"] = enqueue_key
        run_row.orchestration_context_json = coerce_json_payload(context)
        run_row.status = "queued"
        run_row.failure_reason = None
        session.add(run_row)
        return True

    def _enqueue_finalized_inngest_event(
        self,
        session: Session,
        *,
        run: WhitepaperAnalysisRun,
    ) -> bool:
        if (
            not whitepaper_inngest_enabled()
            or not whitepaper_semantic_indexing_enabled()
        ):
            return False
        if self.inngest_client is None:
            return False
        event_name = (
            _str_env(
                "WHITEPAPER_INNGEST_FINALIZED_EVENT_NAME",
                "torghut/whitepaper.analysis.finalized",
            )
            or "torghut/whitepaper.analysis.finalized"
        )
        try:
            event_ids = self.inngest_client.send_sync(
                inngest.Event(
                    name=event_name,
                    data={
                        "run_id": run.run_id,
                    },
                )
            )
            if event_ids:
                run.inngest_event_id = event_ids[0]
                session.add(run)
        except Exception as exc:
            logger.warning(
                "Failed to enqueue finalized whitepaper semantic event for run_id=%s: %s",
                run.run_id,
                exc,
            )
            return False
        return True

    def _next_step_attempt(
        self,
        session: Session,
        *,
        analysis_run_id: Any,
        step_name: str,
    ) -> int:
        max_attempt = session.execute(
            select(func.max(WhitepaperAnalysisStep.attempt)).where(
                WhitepaperAnalysisStep.analysis_run_id == analysis_run_id,
                WhitepaperAnalysisStep.step_name == step_name,
            )
        ).scalar_one()
        return int(max_attempt or 0) + 1

    @staticmethod
    def _is_retryable_agentrun_status(status: str | None) -> bool:
        if not status:
            return False
        return status.strip().lower() in _RETRYABLE_AGENTRUN_STATUSES


__all__: tuple[str, ...] = ()

# Public aliases used by split modules.
WhitepaperWorkflowIngestionMethods = _WhitepaperWorkflowIngestionMethods
