"""Whitepaper workflow ingestion, orchestration, and persistence helpers."""
# pyright: reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownVariableType=false, reportUnknownParameterType=false, reportOptionalMemberAccess=false, reportUnnecessaryComparison=false

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Mapping, cast
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen

from fastapi import FastAPI
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import (
    WhitepaperAnalysisRun,
    WhitepaperAnalysisStep,
    WhitepaperArtifact,
    WhitepaperCodexAgentRun,
    WhitepaperDesignPullRequest,
    WhitepaperDocument,
    WhitepaperDocumentVersion,
    WhitepaperSynthesis,
    WhitepaperViabilityVerdict,
    coerce_json_payload,
)

logger = logging.getLogger(__name__)

_GITHUB_ISSUE_ACTIONS = {"opened", "edited", "reopened", "labeled"}

try:
    import inngest as inngest_sdk
    from inngest import fast_api as inngest_fast_api
except Exception:  # pragma: no cover - optional dependency at runtime
    inngest_sdk = None  # type: ignore[assignment]
    inngest_fast_api = None  # type: ignore[assignment]


@dataclass(frozen=True)
class GithubIssueEvent:
    event_name: str
    action: str
    repository: str
    issue_number: int
    issue_title: str
    issue_body: str
    issue_url: str
    actor: str | None
    delivery_id: str | None
    raw_payload: dict[str, Any]


def _bool_env(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _str_env(name: str, default: str | None = None) -> str | None:
    raw = os.getenv(name)
    if raw is None:
        return default
    normalized = raw.strip()
    return normalized or default


def _int_env(name: str, default: int) -> int:
    raw = _str_env(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def whitepaper_workflow_enabled() -> bool:
    return _bool_env("WHITEPAPER_WORKFLOW_ENABLED", default=False)


def whitepaper_kafka_enabled() -> bool:
    return True


def whitepaper_inngest_enabled() -> bool:
    return True


def whitepaper_inngest_event_name() -> str:
    return _str_env(
        "WHITEPAPER_INNGEST_EVENT_NAME",
        "torghut/whitepaper.analysis.requested",
    ) or "torghut/whitepaper.analysis.requested"


def whitepaper_inngest_function_id() -> str:
    return _str_env(
        "WHITEPAPER_INNGEST_FUNCTION_ID",
        "torghut-whitepaper-analysis-v1",
    ) or "torghut-whitepaper-analysis-v1"


def marker_start() -> str:
    return _str_env("WHITEPAPER_ISSUE_MARKER_START", "<!-- TORGHUT_WHITEPAPER:START -->") or ""


def marker_end() -> str:
    return _str_env("WHITEPAPER_ISSUE_MARKER_END", "<!-- TORGHUT_WHITEPAPER:END -->") or ""


def parse_marker_block(issue_body: str) -> dict[str, str] | None:
    start = marker_start()
    end = marker_end()
    start_index = issue_body.find(start)
    if start_index < 0:
        return None
    end_index = issue_body.find(end, start_index + len(start))
    if end_index < 0:
        return None

    block = issue_body[start_index + len(start) : end_index]
    parsed: dict[str, str] = {}
    for raw_line in block.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if ":" not in line:
            continue
        key, raw_value = line.split(":", 1)
        parsed[key.strip().lower()] = raw_value.strip()
    return parsed if parsed else None


def extract_pdf_urls(text: str) -> list[str]:
    urls: list[str] = []
    seen: set[str] = set()

    markdown_pattern = re.compile(r"\[[^\]]+\]\((https?://[^)\s]+)\)", re.IGNORECASE)
    plain_pattern = re.compile(r"(https?://[^\s)]+)", re.IGNORECASE)

    def _append(url: str) -> None:
        normalized = url.strip()
        if not normalized:
            return
        lower = normalized.lower()
        if ".pdf" not in lower:
            return
        if normalized in seen:
            return
        seen.add(normalized)
        urls.append(normalized)

    for match in markdown_pattern.finditer(text):
        _append(match.group(1))
    for match in plain_pattern.finditer(text):
        _append(match.group(1).rstrip(".,"))
    return urls


def normalize_github_issue_event(payload: Mapping[str, Any]) -> GithubIssueEvent | None:
    envelope = cast(dict[str, Any], payload)
    event_name: str | None = None
    delivery_id: str | None = None

    if isinstance(envelope.get("headers"), Mapping):
        headers = cast(dict[str, Any], envelope["headers"])
        event_name = str(
            headers.get("x-github-event")
            or headers.get("X-GitHub-Event")
            or headers.get("github_event")
            or ""
        ).strip()
        delivery_id = str(
            headers.get("x-github-delivery")
            or headers.get("X-GitHub-Delivery")
            or headers.get("github_delivery")
            or ""
        ).strip() or None

    if event_name is None:
        event_name = str(envelope.get("event") or envelope.get("event_name") or "").strip()

    github_payload = envelope
    if isinstance(envelope.get("body"), Mapping):
        github_payload = cast(dict[str, Any], envelope["body"])

    if not event_name:
        if "issue" in github_payload and "repository" in github_payload:
            event_name = "issues"

    if event_name != "issues":
        return None

    action = str(github_payload.get("action") or "").strip().lower()
    if action not in _GITHUB_ISSUE_ACTIONS:
        return None

    issue = github_payload.get("issue")
    repository = github_payload.get("repository")
    if not isinstance(issue, Mapping) or not isinstance(repository, Mapping):
        return None

    repo_full_name = str(cast(dict[str, Any], repository).get("full_name") or "").strip()
    issue_number_raw = cast(dict[str, Any], issue).get("number")
    issue_number = int(issue_number_raw) if isinstance(issue_number_raw, (int, float)) else 0
    if not repo_full_name or issue_number <= 0:
        return None

    issue_title = str(cast(dict[str, Any], issue).get("title") or "").strip()
    issue_body = str(cast(dict[str, Any], issue).get("body") or "")
    issue_url = str(
        cast(dict[str, Any], issue).get("html_url")
        or cast(dict[str, Any], issue).get("url")
        or ""
    ).strip()

    actor_raw = github_payload.get("sender")
    actor: str | None = None
    if isinstance(actor_raw, Mapping):
        actor = str(cast(dict[str, Any], actor_raw).get("login") or "").strip() or None

    return GithubIssueEvent(
        event_name=event_name,
        action=action,
        repository=repo_full_name,
        issue_number=issue_number,
        issue_title=issue_title,
        issue_body=issue_body,
        issue_url=issue_url,
        actor=actor,
        delivery_id=delivery_id,
        raw_payload=coerce_json_payload(github_payload),
    )


class CephS3Client:
    """Minimal S3-compatible client for Ceph RGW object uploads using SigV4."""

    def __init__(
        self,
        *,
        endpoint: str,
        access_key: str,
        secret_key: str,
        region: str,
        timeout_seconds: int,
    ) -> None:
        self.endpoint = endpoint.rstrip("/")
        self.access_key = access_key
        self.secret_key = secret_key
        self.region = region
        self.timeout_seconds = timeout_seconds

    @classmethod
    def from_env(cls) -> CephS3Client | None:
        endpoint = _str_env("WHITEPAPER_CEPH_ENDPOINT")
        access_key = _str_env("WHITEPAPER_CEPH_ACCESS_KEY") or _str_env("AWS_ACCESS_KEY_ID")
        secret_key = _str_env("WHITEPAPER_CEPH_SECRET_KEY") or _str_env("AWS_SECRET_ACCESS_KEY")
        region = _str_env("WHITEPAPER_CEPH_REGION", "us-east-1") or "us-east-1"

        if endpoint is None:
            bucket_host = _str_env("WHITEPAPER_CEPH_BUCKET_HOST") or _str_env("BUCKET_HOST")
            bucket_port = _str_env("WHITEPAPER_CEPH_BUCKET_PORT") or _str_env("BUCKET_PORT")
            if bucket_host:
                scheme = "https" if _bool_env("WHITEPAPER_CEPH_USE_TLS", False) else "http"
                endpoint = f"{scheme}://{bucket_host}"
                if bucket_port:
                    endpoint = f"{endpoint}:{bucket_port}"

        if not endpoint or not access_key or not secret_key:
            return None

        return cls(
            endpoint=endpoint,
            access_key=access_key,
            secret_key=secret_key,
            region=region,
            timeout_seconds=_int_env("WHITEPAPER_CEPH_TIMEOUT_SECONDS", 20),
        )

    def put_object(
        self,
        *,
        bucket: str,
        key: str,
        body: bytes,
        content_type: str,
    ) -> dict[str, Any]:
        now = datetime.now(timezone.utc)
        amz_date = now.strftime("%Y%m%dT%H%M%SZ")
        datestamp = now.strftime("%Y%m%d")

        parsed = urlparse(self.endpoint)
        if not parsed.scheme or not parsed.netloc:
            raise RuntimeError("invalid_ceph_endpoint")

        canonical_uri = f"/{quote(bucket, safe='')}/{quote(key, safe='/-_.~')}"
        payload_hash = hashlib.sha256(body).hexdigest()
        host = parsed.netloc

        canonical_headers = (
            f"host:{host}\n"
            f"x-amz-content-sha256:{payload_hash}\n"
            f"x-amz-date:{amz_date}\n"
        )
        signed_headers = "host;x-amz-content-sha256;x-amz-date"
        canonical_request = "\n".join(
            [
                "PUT",
                canonical_uri,
                "",
                canonical_headers,
                signed_headers,
                payload_hash,
            ]
        )

        algorithm = "AWS4-HMAC-SHA256"
        credential_scope = f"{datestamp}/{self.region}/s3/aws4_request"
        string_to_sign = "\n".join(
            [
                algorithm,
                amz_date,
                credential_scope,
                hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
            ]
        )

        signing_key = self._signing_key(datestamp)
        signature = hmac.new(signing_key, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
        authorization = (
            f"{algorithm} "
            f"Credential={self.access_key}/{credential_scope}, "
            f"SignedHeaders={signed_headers}, "
            f"Signature={signature}"
        )

        url = f"{self.endpoint}{canonical_uri}"
        request = Request(
            url,
            data=body,
            method="PUT",
            headers={
                "Host": host,
                "Content-Type": content_type,
                "Authorization": authorization,
                "x-amz-date": amz_date,
                "x-amz-content-sha256": payload_hash,
            },
        )

        with urlopen(request, timeout=self.timeout_seconds) as response:
            etag = str(response.headers.get("ETag") or "").strip().strip('"') or None

        return {
            "bucket": bucket,
            "key": key,
            "etag": etag,
            "size_bytes": len(body),
            "sha256": payload_hash,
            "uri": f"s3://{bucket}/{key}",
        }

    def _signing_key(self, datestamp: str) -> bytes:
        date_key = hmac.new(("AWS4" + self.secret_key).encode("utf-8"), datestamp.encode("utf-8"), hashlib.sha256)
        region_key = hmac.new(date_key.digest(), self.region.encode("utf-8"), hashlib.sha256)
        service_key = hmac.new(region_key.digest(), b"s3", hashlib.sha256)
        signing_key = hmac.new(service_key.digest(), b"aws4_request", hashlib.sha256)
        return signing_key.digest()


@dataclass(frozen=True)
class IssueKickoffResult:
    accepted: bool
    reason: str
    run_id: str | None = None
    document_key: str | None = None
    agentrun_name: str | None = None


class WhitepaperWorkflowService:
    """State transitions and persistence for whitepaper analysis workflow."""

    def __init__(self) -> None:
        self.ceph_client = CephS3Client.from_env()

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

        marker = parse_marker_block(issue_event.issue_body)
        if marker is None:
            return IssueKickoffResult(accepted=False, reason="marker_missing")

        workflow_name = marker.get("workflow", "").strip().lower()
        if workflow_name and workflow_name != "whitepaper-analysis-v1":
            return IssueKickoffResult(accepted=False, reason="unsupported_workflow_marker")

        attachments = extract_pdf_urls(issue_event.issue_body)
        attachment_url = marker.get("attachment_url") or (attachments[0] if attachments else "")
        attachment_url = attachment_url.strip()
        if not attachment_url:
            return IssueKickoffResult(accepted=False, reason="pdf_attachment_missing")

        source_identifier = f"{issue_event.repository}#{issue_event.issue_number}"
        marker_hash = hashlib.sha256(json.dumps(marker, sort_keys=True).encode("utf-8")).hexdigest()
        run_seed = f"{source_identifier}|{attachment_url}|{marker_hash}"
        run_id = f"wp-{hashlib.sha256(run_seed.encode('utf-8')).hexdigest()[:24]}"

        existing_run = session.execute(
            select(WhitepaperAnalysisRun).where(WhitepaperAnalysisRun.run_id == run_id)
        ).scalar_one_or_none()
        if existing_run is not None:
            return IssueKickoffResult(
                accepted=True,
                reason="idempotent_replay",
                run_id=existing_run.run_id,
                document_key=str(existing_run.document.document_key) if existing_run.document else None,
            )

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
                metadata_json={
                    "repository": issue_event.repository,
                    "issue_number": issue_event.issue_number,
                    "issue_url": issue_event.issue_url,
                },
                ingested_by=issue_event.actor,
            )
            session.add(document)
            session.flush()
        else:
            document.title = issue_event.issue_title or document.title
            document.metadata_json = coerce_json_payload(
                {
                    **cast(dict[str, Any], document.metadata_json or {}),
                    "repository": issue_event.repository,
                    "issue_number": issue_event.issue_number,
                    "issue_url": issue_event.issue_url,
                }
            )
            session.add(document)

        max_version = session.execute(
            select(func.max(WhitepaperDocumentVersion.version_number)).where(
                WhitepaperDocumentVersion.document_id == document.id
            )
        ).scalar_one()
        next_version = int(max_version or 0) + 1

        download_error: str | None = None
        pdf_bytes: bytes | None = None
        try:
            pdf_bytes = self._download_pdf(attachment_url)
        except Exception as exc:
            download_error = f"download_failed:{type(exc).__name__}:{exc}"

        ceph_bucket = (
            _str_env("WHITEPAPER_CEPH_BUCKET")
            or _str_env("BUCKET_NAME")
            or "torghut-whitepapers"
        )
        key_repository = issue_event.repository.replace("/", "-")
        ceph_key = f"raw/github/{key_repository}/issue-{issue_event.issue_number}/{run_id}/source.pdf"

        checksum = (
            hashlib.sha256(pdf_bytes).hexdigest()
            if pdf_bytes is not None
            else hashlib.sha256(attachment_url.encode("utf-8")).hexdigest()
        )

        parse_status = "pending"
        parse_error = download_error
        ceph_etag: str | None = None
        file_size = len(pdf_bytes) if pdf_bytes is not None else None

        if pdf_bytes is not None and self.ceph_client is not None:
            try:
                upload_result = self.ceph_client.put_object(
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

        version_row = WhitepaperDocumentVersion(
            document_id=document.id,
            version_number=next_version,
            trigger_reason="github_issue",
            file_name=f"issue-{issue_event.issue_number}.pdf",
            mime_type="application/pdf",
            file_size_bytes=file_size,
            checksum_sha256=checksum,
            ceph_bucket=ceph_bucket,
            ceph_object_key=ceph_key,
            ceph_etag=ceph_etag,
            parse_status=parse_status,
            parse_error=parse_error,
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

        run_status = "queued" if parse_status == "stored" else "failed"
        run_row = WhitepaperAnalysisRun(
            run_id=run_id,
            document_id=document.id,
            document_version_id=version_row.id,
            status=run_status,
            trigger_source="github_issue_kafka" if source == "kafka" else "github_issue_api",
            trigger_actor=issue_event.actor,
            inngest_event_id=None,
            orchestration_context_json={
                "repository": issue_event.repository,
                "issue_number": issue_event.issue_number,
                "issue_url": issue_event.issue_url,
                "marker": marker,
                "attachment_url": attachment_url,
            },
            request_payload_json=issue_event.raw_payload,
            failure_reason=parse_error,
            started_at=datetime.now(timezone.utc),
        )
        session.add(run_row)
        session.flush()

        session.add(
            WhitepaperAnalysisStep(
                analysis_run_id=run_row.id,
                step_name="issue_intake",
                step_order=1,
                attempt=1,
                status="completed" if run_status == "queued" else "failed",
                executor="torghut",
                idempotency_key=issue_event.delivery_id,
                trace_id=marker_hash[:32],
                started_at=datetime.now(timezone.utc),
                completed_at=datetime.now(timezone.utc),
                input_json={"source": source, "delivery_id": issue_event.delivery_id},
                output_json={"run_id": run_id, "document_key": document.document_key},
                error_json={"error": parse_error} if parse_error else None,
            )
        )

        document.status = "queued" if run_status == "queued" else "failed"
        document.last_processed_at = datetime.now(timezone.utc)
        session.add(document)

        agentrun_name: str | None = None
        if run_status == "queued" and _bool_env("WHITEPAPER_AGENTRUN_AUTO_DISPATCH", True):
            try:
                dispatch_result = self.enqueue_inngest_run(
                    run=run_row,
                    issue_event=issue_event,
                    attachment_url=attachment_url,
                )
                event_ids = cast(list[str], dispatch_result.get("event_ids") or [])
                run_row.inngest_event_id = event_ids[0] if event_ids else None
                run_row.inngest_function_id = whitepaper_inngest_function_id()
                run_row.status = "inngest_dispatched"
                session.add(run_row)
                session.add(
                    WhitepaperAnalysisStep(
                        analysis_run_id=run_row.id,
                        step_name="inngest_dispatch",
                        step_order=2,
                        attempt=1,
                        status="completed",
                        executor="torghut",
                        idempotency_key=run_row.run_id,
                        started_at=datetime.now(timezone.utc),
                        completed_at=datetime.now(timezone.utc),
                        input_json={
                            "event_name": whitepaper_inngest_event_name(),
                            "run_id": run_row.run_id,
                        },
                        output_json=dispatch_result,
                    )
                )
            except Exception as exc:
                run_row.status = "failed"
                run_row.failure_reason = f"inngest_dispatch_failed:{type(exc).__name__}:{exc}"
                session.add(run_row)

        session.flush()
        return IssueKickoffResult(
            accepted=True,
            reason="queued" if run_row.status != "failed" else "failed",
            run_id=run_row.run_id,
            document_key=document.document_key,
            agentrun_name=agentrun_name,
        )

    def dispatch_codex_agentrun(self, session: Session, run_id: str) -> dict[str, Any]:
        run = session.execute(
            select(WhitepaperAnalysisRun).where(WhitepaperAnalysisRun.run_id == run_id)
        ).scalar_one_or_none()
        if run is None:
            raise ValueError("whitepaper_run_not_found")

        existing = session.execute(
            select(WhitepaperCodexAgentRun).where(WhitepaperCodexAgentRun.analysis_run_id == run.id)
        ).scalar_one_or_none()
        if existing is not None:
            return {
                "idempotent": True,
                "agentrun_name": existing.agentrun_name,
                "status": existing.status,
            }

        context = cast(dict[str, Any], run.orchestration_context_json or {})
        repository = str(context.get("repository") or _str_env("WHITEPAPER_DEFAULT_REPOSITORY", "proompteng/lab"))
        issue_number = str(context.get("issue_number") or "0")
        issue_url = str(context.get("issue_url") or "")
        issue_title = str((run.document.title if run.document else "") or "Whitepaper analysis")
        attachment_url = str(context.get("attachment_url") or "")
        marker = cast(dict[str, Any], context.get("marker") or {})

        base_branch = str(marker.get("base_branch") or _str_env("WHITEPAPER_DEFAULT_BASE_BRANCH", "main"))
        head_branch = str(marker.get("head_branch") or f"codex/whitepaper-{run.run_id[-16:]}")

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
        )

        payload: dict[str, Any] = {
            "namespace": _str_env("WHITEPAPER_AGENTRUN_NAMESPACE", "agents"),
            "idempotencyKey": run.run_id,
            "agentRef": {"name": _str_env("WHITEPAPER_AGENT_NAME", "codex-whitepaper-agent")},
            "runtime": {"type": "job"},
            "implementation": {
                "summary": f"Whitepaper analysis {run.run_id}",
                "text": prompt,
                "source": {"provider": "github", "url": issue_url or f"https://github.com/{repository}/issues/{issue_number}"},
                "vcsRef": {"name": _str_env("WHITEPAPER_AGENTRUN_VCS_REF", "github")},
                "labels": ["whitepaper", "torghut", "design-doc"],
            },
            "vcsRef": {"name": _str_env("WHITEPAPER_AGENTRUN_VCS_REF", "github")},
            "vcsPolicy": {"required": True, "mode": "read-write"},
            "parameters": {
                "repository": repository,
                "base": base_branch,
                "head": head_branch,
                "issueNumber": issue_number,
                "issueTitle": issue_title,
                "issueUrl": issue_url,
                "runId": run.run_id,
                "documentKey": run.document.document_key if run.document else "",
                "cephUri": ceph_uri,
                "attachmentUrl": attachment_url,
            },
            "policy": {
                "secretBindingRef": _str_env(
                    "WHITEPAPER_AGENTRUN_SECRET_BINDING", "codex-whitepaper-github-token"
                )
            },
            "ttlSecondsAfterFinished": _int_env("WHITEPAPER_AGENTRUN_TTL_SECONDS", 7200),
        }

        response_payload = self._submit_jangar_agentrun(payload, idempotency_key=run.run_id)
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
            attempt=1,
            status="completed",
            executor="torghut",
            idempotency_key=run.run_id,
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
        session.add(run)
        return {
            "agentrun_name": agentrun_name,
            "agentrun_uid": agentrun_uid,
            "status": phase,
        }

    def enqueue_inngest_run(
        self,
        *,
        run: WhitepaperAnalysisRun,
        issue_event: GithubIssueEvent,
        attachment_url: str,
    ) -> dict[str, Any]:
        client = self.build_inngest_client()
        if client is None:
            raise RuntimeError("inngest_client_not_configured")

        repository = issue_event.repository
        issue_number = issue_event.issue_number
        issue_url = issue_event.issue_url
        event_name = whitepaper_inngest_event_name()
        event_payload = {
            "run_id": run.run_id,
            "repository": repository,
            "issue_number": issue_number,
            "issue_url": issue_url,
            "attachment_url": attachment_url,
            "github_delivery_id": issue_event.delivery_id,
        }
        event = inngest_sdk.Event(  # type: ignore[union-attr]
            name=event_name,
            id=run.run_id,
            data=event_payload,
        )
        event_ids = cast(list[str], client.send(event))
        return {
            "event_name": event_name,
            "event_ids": event_ids,
            "event_payload": event_payload,
        }

    @staticmethod
    def build_inngest_client() -> Any | None:
        if not whitepaper_inngest_enabled():
            return None
        if inngest_sdk is None:
            return None

        event_key = _str_env("INNGEST_EVENT_KEY")
        if not event_key:
            return None

        app_id = _str_env("INNGEST_APP_ID", "torghut") or "torghut"
        signing_key = _str_env("INNGEST_SIGNING_KEY")
        base_url = _str_env("INNGEST_BASE_URL", "http://inngest.inngest.svc.cluster.local:8288")
        timeout_seconds = max(1, _int_env("WHITEPAPER_INNGEST_TIMEOUT_SECONDS", 20))
        return inngest_sdk.Inngest(  # type: ignore[union-attr]
            app_id=app_id,
            event_key=event_key,
            signing_key=signing_key,
            event_api_base_url=base_url,
            api_base_url=base_url,
            request_timeout=timeout_seconds,
        )

    def finalize_run(
        self,
        session: Session,
        *,
        run_id: str,
        payload: Mapping[str, Any],
    ) -> dict[str, Any]:
        run = session.execute(
            select(WhitepaperAnalysisRun).where(WhitepaperAnalysisRun.run_id == run_id)
        ).scalar_one_or_none()
        if run is None:
            raise ValueError("whitepaper_run_not_found")

        synthesis_payload = payload.get("synthesis")
        if isinstance(synthesis_payload, Mapping):
            synthesis = session.execute(
                select(WhitepaperSynthesis).where(WhitepaperSynthesis.analysis_run_id == run.id)
            ).scalar_one_or_none()
            executive_summary = str(synthesis_payload.get("executive_summary") or "").strip()
            if not executive_summary:
                executive_summary = json.dumps(synthesis_payload, sort_keys=True)
            if synthesis is None:
                synthesis = WhitepaperSynthesis(
                    analysis_run_id=run.id,
                    synthesis_version=str(synthesis_payload.get("synthesis_version") or "v1"),
                    generated_by=str(synthesis_payload.get("generated_by") or "codex"),
                    model_name=self._optional_text(synthesis_payload.get("model_name")),
                    prompt_version=self._optional_text(synthesis_payload.get("prompt_version")),
                    executive_summary=executive_summary,
                    problem_statement=self._optional_text(synthesis_payload.get("problem_statement")),
                    methodology_summary=self._optional_text(synthesis_payload.get("methodology_summary")),
                    key_findings_json=self._optional_json(synthesis_payload.get("key_findings")),
                    novelty_claims_json=self._optional_json(synthesis_payload.get("novelty_claims")),
                    risk_assessment_json=self._optional_json(synthesis_payload.get("risk_assessment")),
                    citations_json=self._optional_json(synthesis_payload.get("citations")),
                    implementation_plan_md=self._optional_text(synthesis_payload.get("implementation_plan_md")),
                    confidence=self._optional_decimal(synthesis_payload.get("confidence")),
                    synthesis_json=coerce_json_payload(cast(dict[str, Any], synthesis_payload)),
                )
                session.add(synthesis)
            else:
                synthesis.executive_summary = executive_summary
                synthesis.problem_statement = self._optional_text(synthesis_payload.get("problem_statement"))
                synthesis.methodology_summary = self._optional_text(synthesis_payload.get("methodology_summary"))
                synthesis.key_findings_json = self._optional_json(synthesis_payload.get("key_findings"))
                synthesis.novelty_claims_json = self._optional_json(synthesis_payload.get("novelty_claims"))
                synthesis.risk_assessment_json = self._optional_json(synthesis_payload.get("risk_assessment"))
                synthesis.citations_json = self._optional_json(synthesis_payload.get("citations"))
                synthesis.implementation_plan_md = self._optional_text(
                    synthesis_payload.get("implementation_plan_md")
                )
                synthesis.confidence = self._optional_decimal(synthesis_payload.get("confidence"))
                synthesis.synthesis_json = coerce_json_payload(cast(dict[str, Any], synthesis_payload))
                session.add(synthesis)

        verdict_payload = payload.get("verdict")
        if isinstance(verdict_payload, Mapping):
            verdict = session.execute(
                select(WhitepaperViabilityVerdict).where(
                    WhitepaperViabilityVerdict.analysis_run_id == run.id
                )
            ).scalar_one_or_none()
            verdict_text = self._optional_text(verdict_payload.get("verdict")) or "needs_review"
            if verdict is None:
                verdict = WhitepaperViabilityVerdict(
                    analysis_run_id=run.id,
                    verdict=verdict_text,
                    score=self._optional_decimal(verdict_payload.get("score")),
                    confidence=self._optional_decimal(verdict_payload.get("confidence")),
                    decision_policy=self._optional_text(verdict_payload.get("decision_policy")),
                    gating_json=self._optional_json(verdict_payload.get("gating")),
                    rationale=self._optional_text(verdict_payload.get("rationale")),
                    rejection_reasons_json=self._optional_json(verdict_payload.get("rejection_reasons")),
                    recommendations_json=self._optional_json(verdict_payload.get("recommendations")),
                    requires_followup=bool(verdict_payload.get("requires_followup")),
                    approved_by=self._optional_text(verdict_payload.get("approved_by")),
                    approved_at=datetime.now(timezone.utc)
                    if verdict_payload.get("approved_by")
                    else None,
                )
                session.add(verdict)
            else:
                verdict.verdict = verdict_text
                verdict.score = self._optional_decimal(verdict_payload.get("score"))
                verdict.confidence = self._optional_decimal(verdict_payload.get("confidence"))
                verdict.decision_policy = self._optional_text(verdict_payload.get("decision_policy"))
                verdict.gating_json = self._optional_json(verdict_payload.get("gating"))
                verdict.rationale = self._optional_text(verdict_payload.get("rationale"))
                verdict.rejection_reasons_json = self._optional_json(
                    verdict_payload.get("rejection_reasons")
                )
                verdict.recommendations_json = self._optional_json(verdict_payload.get("recommendations"))
                verdict.requires_followup = bool(verdict_payload.get("requires_followup"))
                verdict.approved_by = self._optional_text(verdict_payload.get("approved_by"))
                verdict.approved_at = (
                    datetime.now(timezone.utc) if verdict.approved_by else verdict.approved_at
                )
                session.add(verdict)

        pr_payload_raw = payload.get("design_pull_request")
        pr_payloads: list[Mapping[str, Any]] = []
        if isinstance(pr_payload_raw, Mapping):
            pr_payloads = [cast(dict[str, Any], pr_payload_raw)]
        elif isinstance(pr_payload_raw, list):
            pr_payloads = [
                cast(dict[str, Any], item)
                for item in pr_payload_raw
                if isinstance(item, Mapping)
            ]

        for index, pr_payload in enumerate(pr_payloads, start=1):
            attempt = int(pr_payload.get("attempt") or index)
            pr_row = session.execute(
                select(WhitepaperDesignPullRequest).where(
                    WhitepaperDesignPullRequest.analysis_run_id == run.id,
                    WhitepaperDesignPullRequest.attempt == attempt,
                )
            ).scalar_one_or_none()
            if pr_row is None:
                pr_row = WhitepaperDesignPullRequest(
                    analysis_run_id=run.id,
                    attempt=attempt,
                    status=self._optional_text(pr_payload.get("status")) or "opened",
                    repository=self._optional_text(pr_payload.get("repository"))
                    or self._optional_text(cast(dict[str, Any], run.orchestration_context_json or {}).get("repository"))
                    or "proompteng/lab",
                    base_branch=self._optional_text(pr_payload.get("base_branch")) or "main",
                    head_branch=self._optional_text(pr_payload.get("head_branch")) or "codex/whitepaper",
                    pr_number=self._optional_int(pr_payload.get("pr_number")),
                    pr_url=self._optional_text(pr_payload.get("pr_url")),
                    title=self._optional_text(pr_payload.get("title")),
                    body=self._optional_text(pr_payload.get("body")),
                    commit_sha=self._optional_text(pr_payload.get("commit_sha")),
                    merge_commit_sha=self._optional_text(pr_payload.get("merge_commit_sha")),
                    checks_url=self._optional_text(pr_payload.get("checks_url")),
                    ci_status=self._optional_text(pr_payload.get("ci_status")),
                    is_merged=bool(pr_payload.get("is_merged")),
                    merged_at=datetime.now(timezone.utc) if pr_payload.get("is_merged") else None,
                    metadata_json=coerce_json_payload(cast(dict[str, Any], pr_payload)),
                )
                session.add(pr_row)
            else:
                pr_row.status = self._optional_text(pr_payload.get("status")) or pr_row.status
                pr_row.pr_number = self._optional_int(pr_payload.get("pr_number")) or pr_row.pr_number
                pr_row.pr_url = self._optional_text(pr_payload.get("pr_url")) or pr_row.pr_url
                pr_row.title = self._optional_text(pr_payload.get("title")) or pr_row.title
                pr_row.body = self._optional_text(pr_payload.get("body")) or pr_row.body
                pr_row.commit_sha = self._optional_text(pr_payload.get("commit_sha")) or pr_row.commit_sha
                pr_row.merge_commit_sha = (
                    self._optional_text(pr_payload.get("merge_commit_sha")) or pr_row.merge_commit_sha
                )
                pr_row.checks_url = self._optional_text(pr_payload.get("checks_url")) or pr_row.checks_url
                pr_row.ci_status = self._optional_text(pr_payload.get("ci_status")) or pr_row.ci_status
                pr_row.is_merged = bool(pr_payload.get("is_merged"))
                if pr_row.is_merged and pr_row.merged_at is None:
                    pr_row.merged_at = datetime.now(timezone.utc)
                pr_row.metadata_json = coerce_json_payload(cast(dict[str, Any], pr_payload))
                session.add(pr_row)

        artifact_payload = payload.get("artifacts")
        if isinstance(artifact_payload, list):
            for item in artifact_payload:
                if not isinstance(item, Mapping):
                    continue
                artifact = cast(dict[str, Any], item)
                bucket = self._optional_text(artifact.get("ceph_bucket"))
                key = self._optional_text(artifact.get("ceph_object_key"))
                if bucket and key:
                    existing_artifact = session.execute(
                        select(WhitepaperArtifact).where(
                            WhitepaperArtifact.ceph_bucket == bucket,
                            WhitepaperArtifact.ceph_object_key == key,
                        )
                    ).scalar_one_or_none()
                    if existing_artifact is not None:
                        continue

                session.add(
                    WhitepaperArtifact(
                        document_id=run.document_id,
                        document_version_id=run.document_version_id,
                        analysis_run_id=run.id,
                        artifact_scope=self._optional_text(artifact.get("artifact_scope")) or "run",
                        artifact_type=self._optional_text(artifact.get("artifact_type")) or "generic",
                        artifact_role=self._optional_text(artifact.get("artifact_role")),
                        ceph_bucket=bucket,
                        ceph_object_key=key,
                        artifact_uri=self._optional_text(artifact.get("artifact_uri")),
                        checksum_sha256=self._optional_text(artifact.get("checksum_sha256")),
                        size_bytes=self._optional_int(artifact.get("size_bytes")),
                        content_type=self._optional_text(artifact.get("content_type")),
                        metadata_json=coerce_json_payload(artifact),
                    )
                )

        steps_raw = payload.get("steps")
        if isinstance(steps_raw, list):
            for index, step_raw in enumerate(steps_raw, start=1):
                if not isinstance(step_raw, Mapping):
                    continue
                step_payload = cast(dict[str, Any], step_raw)
                step_name = self._optional_text(step_payload.get("step_name")) or f"step_{index}"
                attempt = int(step_payload.get("attempt") or 1)
                step = session.execute(
                    select(WhitepaperAnalysisStep).where(
                        WhitepaperAnalysisStep.analysis_run_id == run.id,
                        WhitepaperAnalysisStep.step_name == step_name,
                        WhitepaperAnalysisStep.attempt == attempt,
                    )
                ).scalar_one_or_none()
                if step is None:
                    step = WhitepaperAnalysisStep(
                        analysis_run_id=run.id,
                        step_name=step_name,
                        step_order=int(step_payload.get("step_order") or index),
                        attempt=attempt,
                        status=self._optional_text(step_payload.get("status")) or "completed",
                        executor=self._optional_text(step_payload.get("executor")),
                        idempotency_key=self._optional_text(step_payload.get("idempotency_key")),
                        trace_id=self._optional_text(step_payload.get("trace_id")),
                        started_at=datetime.now(timezone.utc),
                        completed_at=datetime.now(timezone.utc),
                        duration_ms=self._optional_int(step_payload.get("duration_ms")),
                        input_json=self._optional_json(step_payload.get("input_json")),
                        output_json=self._optional_json(step_payload.get("output_json")),
                        error_json=self._optional_json(step_payload.get("error_json")),
                    )
                    session.add(step)
                else:
                    step.status = self._optional_text(step_payload.get("status")) or step.status
                    step.duration_ms = self._optional_int(step_payload.get("duration_ms")) or step.duration_ms
                    step.input_json = self._optional_json(step_payload.get("input_json")) or step.input_json
                    step.output_json = self._optional_json(step_payload.get("output_json")) or step.output_json
                    step.error_json = self._optional_json(step_payload.get("error_json")) or step.error_json
                    step.completed_at = datetime.now(timezone.utc)
                    session.add(step)

        target_status = self._optional_text(payload.get("status")) or "completed"
        run.status = target_status
        run.result_payload_json = coerce_json_payload(cast(dict[str, Any], payload))
        run.completed_at = datetime.now(timezone.utc)
        run.failure_reason = None if target_status == "completed" else self._optional_text(payload.get("failure_reason"))
        session.add(run)

        if run.document is not None:
            run.document.status = "analyzed" if target_status == "completed" else "failed"
            run.document.last_processed_at = datetime.now(timezone.utc)
            session.add(run.document)

        return {
            "run_id": run.run_id,
            "status": run.status,
            "completed_at": run.completed_at.isoformat() if run.completed_at else None,
        }

    @staticmethod
    def _optional_text(value: Any) -> str | None:
        if value is None:
            return None
        text = str(value).strip()
        return text or None

    @staticmethod
    def _optional_int(value: Any) -> int | None:
        if value is None:
            return None
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _optional_decimal(value: Any) -> Decimal | None:
        if value is None:
            return None
        try:
            return Decimal(str(value))
        except Exception:
            return None

    @staticmethod
    def _optional_json(value: Any) -> Any:
        if value is None:
            return None
        return coerce_json_payload(value)

    @staticmethod
    def _download_pdf(url: str) -> bytes:
        token = _str_env("WHITEPAPER_GITHUB_TOKEN")
        max_bytes = _int_env("WHITEPAPER_MAX_PDF_BYTES", 50 * 1024 * 1024)
        request = Request(
            url,
            headers={
                "Accept": "application/pdf,application/octet-stream;q=0.9,*/*;q=0.8",
                **({"Authorization": f"Bearer {token}"} if token else {}),
            },
            method="GET",
        )
        timeout = _int_env("WHITEPAPER_DOWNLOAD_TIMEOUT_SECONDS", 30)
        with urlopen(request, timeout=timeout) as response:
            payload = response.read(max_bytes + 1)
            if len(payload) > max_bytes:
                raise RuntimeError("pdf_too_large")
            return payload

    def _submit_jangar_agentrun(self, payload: Mapping[str, Any], *, idempotency_key: str) -> dict[str, Any]:
        submit_url = _str_env("WHITEPAPER_AGENTRUN_SUBMIT_URL")
        if not submit_url:
            jangar_base_url = _str_env("JANGAR_BASE_URL", "http://agents.agents.svc.cluster.local")
            if not jangar_base_url:
                raise RuntimeError("jangar_endpoint_not_configured")
            submit_url = f"{jangar_base_url.rstrip('/')}/v1/agent-runs"

        auth_token = _str_env("JANGAR_API_KEY")
        request = Request(
            submit_url,
            data=json.dumps(payload).encode("utf-8"),
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Idempotency-Key": idempotency_key,
                **({"Authorization": f"Bearer {auth_token}"} if auth_token else {}),
            },
        )

        timeout = _int_env("WHITEPAPER_AGENTRUN_TIMEOUT_SECONDS", 20)
        with urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
        parsed = json.loads(raw)
        if not isinstance(parsed, dict):
            raise RuntimeError("invalid_jangar_response")
        return cast(dict[str, Any], parsed)

    @staticmethod
    def _build_whitepaper_prompt(
        *,
        run_id: str,
        repository: str,
        issue_url: str,
        issue_title: str,
        attachment_url: str,
        ceph_uri: str,
    ) -> str:
        return "\n".join(
            [
                f"Objective: Analyze whitepaper run {run_id} and deliver implementation-ready outcomes.",
                f"Repository: {repository}",
                f"Issue: {issue_url}",
                f"Issue title: {issue_title}",
                f"Primary PDF URL: {attachment_url}",
                f"Ceph object URI: {ceph_uri}",
                "",
                "Requirements:",
                "1) Read the full whitepaper end-to-end (no abstract-only shortcuts).",
                "2) Produce a structured synthesis: executive summary, methodology, key findings, novelty claims, risks, implementation implications.",
                "3) Produce a viability verdict with score, confidence, rejection reasons (if any), and follow-up recommendations.",
                "4) Create/update a design document in this repository under docs/whitepapers/<run-id>/design.md.",
                "5) Open a PR from a codex/* branch into main with a production-ready design document.",
                "6) Emit machine-readable outputs in JSON for synthesis and verdict in your run artifacts.",
                "",
                "Quality bar:",
                "- Be explicit about assumptions and unresolved risks.",
                "- Include concrete references to whitepaper sections/claims.",
                "- Keep behavior deterministic and auditable.",
            ]
        )


class WhitepaperKafkaIssueIngestor:
    """Kafka consumer for GitHub issue webhook events relayed by Froussard."""

    def __init__(self, *, workflow_service: WhitepaperWorkflowService | None = None) -> None:
        self.workflow_service = workflow_service or WhitepaperWorkflowService()
        self._consumer: Any | None = None

    def ingest_once(self, session: Session) -> dict[str, int]:
        counters = {
            "messages_total": 0,
            "accepted_total": 0,
            "ignored_total": 0,
            "failed_total": 0,
            "consumer_errors_total": 0,
        }

        if not whitepaper_workflow_enabled() or not whitepaper_kafka_enabled():
            return counters

        consumer = self._ensure_consumer()
        if consumer is None:
            counters["consumer_errors_total"] += 1
            return counters

        try:
            polled = consumer.poll(
                timeout_ms=_int_env("WHITEPAPER_KAFKA_POLL_MS", 500),
                max_records=_int_env("WHITEPAPER_KAFKA_BATCH_SIZE", 50),
            )
        except Exception as exc:  # pragma: no cover - external Kafka failure
            counters["consumer_errors_total"] += 1
            logger.warning("Whitepaper Kafka poll failed: %s", exc)
            return counters

        records = self._flatten_poll_records(polled)
        if not records:
            return counters

        for record in records:
            counters["messages_total"] += 1
            try:
                payload = self._decode_record_json(record)
            except Exception:
                counters["ignored_total"] += 1
                continue
            try:
                result = self.workflow_service.ingest_github_issue_event(
                    session,
                    payload,
                    source="kafka",
                )
                if result.accepted:
                    counters["accepted_total"] += 1
                    session.commit()
                else:
                    counters["ignored_total"] += 1
                    session.rollback()
            except Exception as exc:
                session.rollback()
                counters["failed_total"] += 1
                logger.warning("Whitepaper issue intake failed: %s", exc)

        self._commit_consumer(consumer)
        return counters

    def close(self) -> None:
        if self._consumer is None:
            return
        run_close = cast(Any, getattr(self._consumer, "close", None))
        consumer = self._consumer
        self._consumer = None
        if callable(run_close):
            try:
                run_close()
            except Exception:
                logger.debug("Whitepaper consumer close failed", exc_info=True)
        else:
            del consumer

    def _ensure_consumer(self) -> Any | None:
        if self._consumer is not None:
            return self._consumer
        try:
            self._consumer = self._build_consumer()
            return self._consumer
        except Exception as exc:  # pragma: no cover - depends on Kafka runtime
            logger.warning("Failed to initialize whitepaper kafka consumer: %s", exc)
            return None

    @staticmethod
    def _build_consumer() -> Any:
        from kafka import KafkaConsumer  # type: ignore[import-not-found]

        bootstrap = (
            _str_env("WHITEPAPER_KAFKA_BOOTSTRAP_SERVERS")
            or _str_env("TRADING_ORDER_FEED_BOOTSTRAP_SERVERS")
            or ""
        )
        if not bootstrap:
            raise RuntimeError("whitepaper_kafka_bootstrap_missing")

        topic = _str_env("WHITEPAPER_KAFKA_TOPIC", "github.webhook.events") or "github.webhook.events"
        security_protocol = _str_env("WHITEPAPER_KAFKA_SECURITY_PROTOCOL")
        sasl_mechanism = _str_env("WHITEPAPER_KAFKA_SASL_MECHANISM")
        sasl_username = _str_env("WHITEPAPER_KAFKA_SASL_USERNAME")
        sasl_password = _str_env("WHITEPAPER_KAFKA_SASL_PASSWORD")
        kwargs: dict[str, Any] = {}
        if security_protocol:
            kwargs["security_protocol"] = security_protocol
        if sasl_mechanism:
            kwargs["sasl_mechanism"] = sasl_mechanism
        if sasl_username:
            kwargs["sasl_plain_username"] = sasl_username
        if sasl_password:
            kwargs["sasl_plain_password"] = sasl_password
        return KafkaConsumer(
            topic,
            bootstrap_servers=[item.strip() for item in bootstrap.split(",") if item.strip()],
            group_id=_str_env("WHITEPAPER_KAFKA_GROUP_ID", "torghut-whitepaper-v1"),
            client_id=_str_env("WHITEPAPER_KAFKA_CLIENT_ID", "torghut-whitepaper"),
            enable_auto_commit=False,
            auto_offset_reset=_str_env("WHITEPAPER_KAFKA_AUTO_OFFSET_RESET", "latest"),
            consumer_timeout_ms=max(_int_env("WHITEPAPER_KAFKA_POLL_MS", 500), 1000),
            value_deserializer=None,
            key_deserializer=None,
            **kwargs,
        )

    @staticmethod
    def _flatten_poll_records(polled: Any) -> list[Any]:
        if isinstance(polled, Mapping):
            records: list[Any] = []
            for bucket in cast(Mapping[Any, Any], polled).values():
                if isinstance(bucket, list):
                    records.extend(bucket)
            return records
        if isinstance(polled, list):
            return cast(list[Any], polled)
        return []

    @staticmethod
    def _decode_record_json(record: Any) -> dict[str, Any]:
        value = getattr(record, "value", None)
        if value is None:
            raise ValueError("missing_value")
        if isinstance(value, bytes):
            payload = json.loads(value.decode("utf-8"))
        elif isinstance(value, str):
            payload = json.loads(value)
        elif isinstance(value, Mapping):
            payload = dict(cast(dict[str, Any], value))
        else:
            raise ValueError("unsupported_payload")
        if not isinstance(payload, dict):
            raise ValueError("payload_not_object")
        return cast(dict[str, Any], payload)

    @staticmethod
    def _commit_consumer(consumer: Any) -> None:
        run_commit = getattr(consumer, "commit", None)
        if callable(run_commit):
            try:
                run_commit()
            except Exception as exc:  # pragma: no cover - external Kafka runtime
                logger.warning("Whitepaper consumer commit failed: %s", exc)


class WhitepaperKafkaWorker:
    """Background worker that polls Kafka and triggers whitepaper issue intake."""

    def __init__(
        self,
        *,
        session_factory: Any,
        ingestor: WhitepaperKafkaIssueIngestor | None = None,
    ) -> None:
        self._session_factory = session_factory
        self._ingestor = ingestor or WhitepaperKafkaIssueIngestor()
        self._task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        if self._task is not None:
            return
        if not whitepaper_workflow_enabled() or not whitepaper_kafka_enabled():
            return
        self._task = asyncio.create_task(self._run(), name="whitepaper-kafka-worker")

    async def stop(self) -> None:
        if self._task is None:
            self._ingestor.close()
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        finally:
            self._task = None
            self._ingestor.close()

    async def _run(self) -> None:
        interval = max(0.25, float(_int_env("WHITEPAPER_KAFKA_LOOP_INTERVAL_MS", 1000)) / 1000.0)
        while True:
            try:
                await asyncio.to_thread(self._ingest_once)
            except Exception:
                logger.exception("Whitepaper kafka worker loop failure")
            await asyncio.sleep(interval)

    def _ingest_once(self) -> None:
        with self._session_factory() as session:
            self._ingestor.ingest_once(session)


def mount_inngest_whitepaper_function(
    app: FastAPI,
    *,
    session_factory: Any,
    workflow_service: WhitepaperWorkflowService,
) -> bool:
    if not whitepaper_inngest_enabled():
        return False
    if inngest_sdk is None or inngest_fast_api is None:
        logger.warning("Inngest SDK unavailable; whitepaper orchestration function not mounted")
        return False

    client = workflow_service.build_inngest_client()
    if client is None:
        logger.warning(
            "Inngest client configuration missing; whitepaper orchestration function not mounted"
        )
        return False

    function_id = whitepaper_inngest_function_id()
    event_name = whitepaper_inngest_event_name()

    @client.create_function(
        fn_id=function_id,
        trigger=inngest_sdk.TriggerEvent(event=event_name),  # type: ignore[union-attr]
    )
    async def whitepaper_inngest_orchestrator(ctx: Any) -> dict[str, Any]:
        event = getattr(ctx, "event", None)
        event_data = cast(dict[str, Any], getattr(event, "data", {}) or {})
        run_id = str(event_data.get("run_id") or "").strip()
        if not run_id:
            raise RuntimeError("whitepaper_run_id_missing")

        with session_factory() as session:
            row = session.execute(
                select(WhitepaperAnalysisRun).where(WhitepaperAnalysisRun.run_id == run_id)
            ).scalar_one_or_none()
            if row is None:
                raise RuntimeError("whitepaper_run_not_found")

            row.inngest_function_id = function_id
            incoming_run_id = str(getattr(ctx, "run_id", "") or "").strip()
            if incoming_run_id and (
                row.inngest_run_id is None or row.inngest_run_id == incoming_run_id
            ):
                row.inngest_run_id = incoming_run_id
            event_id = str(
                event_data.get("inngest_event_id")
                or event_data.get("event_id")
                or ""
            ).strip()
            if event_id and not row.inngest_event_id:
                row.inngest_event_id = event_id
            session.add(row)
            result = workflow_service.dispatch_codex_agentrun(session, run_id)
            session.commit()
            return {
                "run_id": run_id,
                "inngest_run_id": incoming_run_id or row.inngest_run_id,
                "agentrun": result,
            }

    serve_path = _str_env("WHITEPAPER_INNGEST_SERVE_PATH", "/api/inngest")
    inngest_fast_api.serve(
        app,
        client,
        [whitepaper_inngest_orchestrator],
        serve_path=serve_path,
    )
    return True


__all__ = [
    "IssueKickoffResult",
    "WhitepaperKafkaIssueIngestor",
    "WhitepaperKafkaWorker",
    "WhitepaperWorkflowService",
    "mount_inngest_whitepaper_function",
    "extract_pdf_urls",
    "normalize_github_issue_event",
    "parse_marker_block",
    "whitepaper_inngest_enabled",
    "whitepaper_kafka_enabled",
    "whitepaper_workflow_enabled",
]
