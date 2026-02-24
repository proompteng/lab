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
from http.client import HTTPConnection, HTTPSConnection
from typing import Any, Mapping, cast
from urllib.parse import quote, urljoin, urlparse

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

def _http_request_bytes(
    url: str,
    *,
    method: str,
    headers: Mapping[str, str] | None = None,
    body: bytes | None = None,
    timeout_seconds: int,
    max_response_bytes: int | None = None,
    follow_redirects: bool = False,
    max_redirects: int = 5,
) -> tuple[int, dict[str, str], bytes]:
    current_url = url
    current_method = method
    current_body = body
    request_headers = dict(headers or {})
    redirect_statuses = {301, 302, 303, 307, 308}
    max_allowed_redirects = max(max_redirects, 0)

    for redirect_index in range(max_allowed_redirects + 1):
        parsed = urlparse(current_url)
        scheme = parsed.scheme.lower()
        if scheme not in {'http', 'https'}:
            raise RuntimeError(f'unsupported_url_scheme:{scheme or "missing"}')
        if not parsed.hostname:
            raise RuntimeError('invalid_url_host')

        path = parsed.path or '/'
        if parsed.query:
            path = f'{path}?{parsed.query}'
        connection_class = HTTPSConnection if scheme == 'https' else HTTPConnection
        connection = connection_class(parsed.hostname, parsed.port, timeout=max(timeout_seconds, 1))
        try:
            connection.request(current_method, path, body=current_body, headers=request_headers)
            response = connection.getresponse()
            read_limit = None
            if max_response_bytes is not None:
                read_limit = max(max_response_bytes, 0) + 1
            payload = response.read(read_limit)
            response_headers = {key: value for key, value in response.getheaders()}
            status_code = int(response.status)
        finally:
            connection.close()

        if not follow_redirects or status_code not in redirect_statuses:
            return status_code, response_headers, payload

        location = response_headers.get('Location') or response_headers.get('location')
        if not location:
            return status_code, response_headers, payload
        if redirect_index >= max_allowed_redirects:
            raise RuntimeError('http_redirect_limit_exceeded')

        next_url = urljoin(current_url, location)
        next_parsed = urlparse(next_url)
        if (
            parsed.scheme.lower(),
            parsed.hostname,
            parsed.port,
        ) != (
            next_parsed.scheme.lower(),
            next_parsed.hostname,
            next_parsed.port,
        ):
            request_headers.pop('Authorization', None)
            request_headers.pop('authorization', None)
            request_headers.pop('Cookie', None)
            request_headers.pop('cookie', None)

        if status_code == 303 or (status_code in {301, 302} and current_method.upper() not in {'GET', 'HEAD'}):
            current_method = 'GET'
            current_body = None

        current_url = next_url

    raise RuntimeError('http_redirect_processing_failed')


_GITHUB_ISSUE_ACTIONS = {"opened", "edited", "reopened", "labeled"}
_GITHUB_ISSUE_COMMENT_ACTIONS = {"created", "edited"}
_RETRYABLE_AGENTRUN_STATUSES = {"failed", "error", "cancelled", "canceled", "timeout", "timed_out"}


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
    comment_body: str | None = None
    requeue_requested: bool = False


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
    return _bool_env("WHITEPAPER_KAFKA_ENABLED", default=False)


def whitepaper_requeue_comment_keyword() -> str:
    return _str_env("WHITEPAPER_REQUEUE_COMMENT_KEYWORD", "research whitepaper") or "research whitepaper"


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


def normalize_attachment_url(url: str) -> str:
    raw = url.strip()
    if not raw:
        return ""

    parsed = urlparse(raw)
    if not parsed.scheme or not parsed.netloc:
        return raw

    normalized = parsed._replace(
        scheme=parsed.scheme.lower(),
        netloc=parsed.netloc.lower(),
        fragment="",
    )
    return normalized.geturl()


def build_whitepaper_run_id(*, source_identifier: str, attachment_url: str) -> str:
    run_seed = f"{source_identifier}|{normalize_attachment_url(attachment_url)}"
    return f"wp-{hashlib.sha256(run_seed.encode('utf-8')).hexdigest()[:24]}"


def comment_requests_requeue(comment_body: str) -> bool:
    keyword = whitepaper_requeue_comment_keyword().strip().lower()
    if not keyword:
        return False
    return keyword in comment_body.lower()


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


def _extract_github_event_metadata(envelope: Mapping[str, Any]) -> tuple[str | None, str | None]:
    headers_raw = envelope.get("headers")
    if not isinstance(headers_raw, Mapping):
        return None, None
    headers = cast(dict[str, Any], headers_raw)
    event_name = str(
        headers.get("x-github-event")
        or headers.get("X-GitHub-Event")
        or headers.get("github_event")
        or ""
    ).strip() or None
    delivery_id = str(
        headers.get("x-github-delivery")
        or headers.get("X-GitHub-Delivery")
        or headers.get("github_delivery")
        or ""
    ).strip() or None
    return event_name, delivery_id


def _extract_github_issue_payload(envelope: Mapping[str, Any]) -> dict[str, Any]:
    body_raw = envelope.get("body")
    if isinstance(body_raw, Mapping):
        return cast(dict[str, Any], body_raw)
    return cast(dict[str, Any], envelope)


def _coerce_issue_number(value: Any) -> int:
    if isinstance(value, (int, float)):
        return int(value)
    return 0


def _extract_sender_login(sender: object) -> str | None:
    if not isinstance(sender, Mapping):
        return None
    return str(cast(dict[str, Any], sender).get("login") or "").strip() or None


def normalize_github_issue_event(payload: Mapping[str, Any]) -> GithubIssueEvent | None:
    envelope = cast(dict[str, Any], payload)
    event_name, delivery_id = _extract_github_event_metadata(envelope)
    if not event_name:
        event_name = str(envelope.get("event") or envelope.get("event_name") or "").strip() or None

    github_payload = _extract_github_issue_payload(envelope)
    if not event_name:
        if "comment" in github_payload and "issue" in github_payload and "repository" in github_payload:
            event_name = "issue_comment"
        elif "issue" in github_payload and "repository" in github_payload:
            event_name = "issues"

    if event_name == "issues":
        allowed_actions = _GITHUB_ISSUE_ACTIONS
    elif event_name == "issue_comment":
        allowed_actions = _GITHUB_ISSUE_COMMENT_ACTIONS
    else:
        return None

    action = str(github_payload.get("action") or "").strip().lower()
    if action not in allowed_actions:
        return None

    issue = github_payload.get("issue")
    repository = github_payload.get("repository")
    if not isinstance(issue, Mapping) or not isinstance(repository, Mapping):
        return None

    issue_payload = cast(dict[str, Any], issue)
    repository_payload = cast(dict[str, Any], repository)
    repo_full_name = str(repository_payload.get("full_name") or "").strip()
    issue_number = _coerce_issue_number(issue_payload.get("number"))
    if not repo_full_name or issue_number <= 0:
        return None

    issue_title = str(issue_payload.get("title") or "").strip()
    issue_body = str(issue_payload.get("body") or "")
    issue_url = str(issue_payload.get("html_url") or issue_payload.get("url") or "").strip()
    comment_body: str | None = None
    if event_name == "issue_comment":
        comment = github_payload.get("comment")
        if not isinstance(comment, Mapping):
            return None
        comment_body = str(cast(dict[str, Any], comment).get("body") or "")

    actor = _extract_sender_login(github_payload.get("sender"))

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
        comment_body=comment_body,
        requeue_requested=bool(comment_body and comment_requests_requeue(comment_body)),
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
        status, response_headers, _ = _http_request_bytes(
            url,
            method='PUT',
            headers={
                'Host': host,
                'Content-Type': content_type,
                'Authorization': authorization,
                'x-amz-date': amz_date,
                'x-amz-content-sha256': payload_hash,
            },
            body=body,
            timeout_seconds=self.timeout_seconds,
        )
        if status < 200 or status >= 300:
            raise RuntimeError(f'ceph_upload_http_{status}')
        etag = str(response_headers.get('ETag') or '').strip().strip('"') or None

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


@dataclass(frozen=True)
class _IssueRunIdentity:
    run_id: str
    retry_of_run_id: str | None
    marker_hash: str


@dataclass(frozen=True)
class _PdfStorageOutcome:
    ceph_bucket: str
    ceph_key: str
    checksum: str
    ceph_etag: str | None
    file_size: int | None
    parse_status: str
    parse_error: str | None


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

        marker_rejection, marker, attachment_url = self._resolve_marker_and_attachment(issue_event.issue_body)
        if marker_rejection is not None or marker is None:
            return marker_rejection or IssueKickoffResult(accepted=False, reason="marker_missing")

        if issue_event.event_name == "issue_comment" and not issue_event.requeue_requested:
            return IssueKickoffResult(accepted=False, reason="comment_without_requeue_keyword")

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
            select(WhitepaperAnalysisRun).where(WhitepaperAnalysisRun.run_id == run_id_seed)
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

        document = self._upsert_issue_document(
            session=session,
            source_identifier=source_identifier,
            issue_event=issue_event,
        )
        storage = self._store_issue_pdf(
            issue_event=issue_event,
            run_id=run_identity.run_id,
            attachment_url=attachment_url,
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
            run_id=run_identity.run_id,
            document_key=document.document_key,
            parse_error=storage.parse_error,
        )

        document.status = "queued" if run_row.status == "queued" else "failed"
        document.last_processed_at = datetime.now(timezone.utc)
        session.add(document)

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
            return IssueKickoffResult(accepted=False, reason="unsupported_workflow_marker"), None, ""

        attachments = extract_pdf_urls(issue_body)
        attachment_url = normalize_attachment_url(
            str(marker.get("attachment_url") or (attachments[0] if attachments else ""))
        )
        if not attachment_url:
            return IssueKickoffResult(accepted=False, reason="pdf_attachment_missing"), None, ""

        return None, marker, attachment_url

    @staticmethod
    def _idempotent_kickoff_result(run: WhitepaperAnalysisRun) -> IssueKickoffResult:
        return IssueKickoffResult(
            accepted=True,
            reason="idempotent_replay",
            run_id=run.run_id,
            document_key=str(run.document.document_key) if run.document else None,
        )

    def _upsert_issue_document(
        self,
        *,
        session: Session,
        source_identifier: str,
        issue_event: Any,
    ) -> WhitepaperDocument:
        metadata = {
            "repository": issue_event.repository,
            "issue_number": issue_event.issue_number,
            "issue_url": issue_event.issue_url,
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
                ingested_by=issue_event.actor,
            )
            session.add(document)
            session.flush()
            return document

        document.title = issue_event.issue_title or document.title
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
        issue_event: Any,
        run_id: str,
        attachment_url: str,
    ) -> _PdfStorageOutcome:
        download_error: str | None = None
        pdf_bytes: bytes | None = None
        try:
            pdf_bytes = self._download_pdf(attachment_url)
        except Exception as exc:
            download_error = f"download_failed:{type(exc).__name__}:{exc}"

        ceph_bucket = _str_env("WHITEPAPER_CEPH_BUCKET") or _str_env("BUCKET_NAME") or "torghut-whitepapers"
        key_repository = issue_event.repository.replace("/", "-")
        ceph_key = f"raw/github/{key_repository}/issue-{issue_event.issue_number}/{run_id}/source.pdf"
        checksum = (
            hashlib.sha256(pdf_bytes).hexdigest()
            if pdf_bytes is not None
            else hashlib.sha256(attachment_url.encode("utf-8")).hexdigest()
        )
        file_size = len(pdf_bytes) if pdf_bytes is not None else None

        parse_status = "pending"
        parse_error = download_error
        ceph_etag: str | None = None
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
        run_row = WhitepaperAnalysisRun(
            run_id=run_identity.run_id,
            document_id=document.id,
            document_version_id=version_row.id,
            status=run_status,
            trigger_source="github_issue_kafka" if source == "kafka" else "github_issue_api",
            trigger_actor=issue_event.actor,
            retry_of_run_id=run_identity.retry_of_run_id,
            inngest_event_id=issue_event.delivery_id,
            orchestration_context_json={
                "repository": issue_event.repository,
                "issue_number": issue_event.issue_number,
                "issue_url": issue_event.issue_url,
                "marker": marker,
                "attachment_url": attachment_url,
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
        if run_row.status != "queued" or not _bool_env("WHITEPAPER_AGENTRUN_AUTO_DISPATCH", True):
            return None

        try:
            dispatched = self.dispatch_codex_agentrun(session, run_row.run_id)
        except Exception as exc:
            run_row.status = "failed"
            run_row.failure_reason = f"agentrun_dispatch_failed:{type(exc).__name__}:{exc}"
            session.add(run_row)
            return None
        return cast(str | None, dispatched.get("agentrun_name"))

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

        latest_agentrun = session.execute(
            select(WhitepaperCodexAgentRun)
            .where(WhitepaperCodexAgentRun.analysis_run_id == run.id)
            .order_by(WhitepaperCodexAgentRun.created_at.desc())
        ).scalars().first()
        if latest_agentrun and not self._is_retryable_agentrun_status(latest_agentrun.status):
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
        run.trigger_source = "github_issue_comment_kafka" if source == "kafka" else "github_issue_comment_api"
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

        try:
            dispatch_result = self.dispatch_codex_agentrun(session, run.run_id, allow_retry=True)
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

    def dispatch_codex_agentrun(self, session: Session, run_id: str, *, allow_retry: bool = False) -> dict[str, Any]:
        run = session.execute(
            select(WhitepaperAnalysisRun).where(WhitepaperAnalysisRun.run_id == run_id)
        ).scalar_one_or_none()
        if run is None:
            raise ValueError("whitepaper_run_not_found")

        existing = session.execute(
            select(WhitepaperCodexAgentRun)
            .where(WhitepaperCodexAgentRun.analysis_run_id == run.id)
            .order_by(WhitepaperCodexAgentRun.created_at.desc())
        ).scalars().first()
        if existing is not None:
            if not allow_retry or not self._is_retryable_agentrun_status(existing.status):
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
        repository = str(context.get("repository") or _str_env("WHITEPAPER_DEFAULT_REPOSITORY", "proompteng/lab"))
        issue_number = str(context.get("issue_number") or "0")
        issue_url = str(context.get("issue_url") or "")
        issue_title = str((run.document.title if run.document else "") or "Whitepaper analysis")
        attachment_url = str(context.get("attachment_url") or "")
        marker = cast(dict[str, Any], context.get("marker") or {})

        base_branch = str(marker.get("base_branch") or _str_env("WHITEPAPER_DEFAULT_BASE_BRANCH", "main"))
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
        )

        payload: dict[str, Any] = {
            "namespace": _str_env("WHITEPAPER_AGENTRUN_NAMESPACE", "agents"),
            "idempotencyKey": run.run_id if dispatch_attempt == 1 else f"{run.run_id}-retry-{dispatch_attempt}",
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

        idempotency_key = cast(str, payload["idempotencyKey"])
        response_payload = self._submit_jangar_agentrun(payload, idempotency_key=idempotency_key)
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
        self._upsert_design_pull_requests(session, run, payload.get("design_pull_request"))
        self._ingest_artifacts(session, run, payload.get("artifacts"))
        self._upsert_steps(session, run, payload.get("steps"))
        self._complete_run(session, run, payload)

        return {
            "run_id": run.run_id,
            "status": run.status,
            "completed_at": run.completed_at.isoformat() if run.completed_at else None,
        }

    @staticmethod
    def _get_run_or_raise(session: Session, run_id: str) -> WhitepaperAnalysisRun:
        run = session.execute(
            select(WhitepaperAnalysisRun).where(WhitepaperAnalysisRun.run_id == run_id)
        ).scalar_one_or_none()
        if run is None:
            raise ValueError("whitepaper_run_not_found")
        return run

    def _upsert_synthesis(
        self,
        session: Session,
        run: WhitepaperAnalysisRun,
        synthesis_payload_raw: Any,
    ) -> None:
        if not isinstance(synthesis_payload_raw, Mapping):
            return
        synthesis_payload = cast(dict[str, Any], synthesis_payload_raw)
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
                synthesis_json=coerce_json_payload(synthesis_payload),
            )
            session.add(synthesis)
            return

        synthesis.executive_summary = executive_summary
        synthesis.problem_statement = self._optional_text(synthesis_payload.get("problem_statement"))
        synthesis.methodology_summary = self._optional_text(synthesis_payload.get("methodology_summary"))
        synthesis.key_findings_json = self._optional_json(synthesis_payload.get("key_findings"))
        synthesis.novelty_claims_json = self._optional_json(synthesis_payload.get("novelty_claims"))
        synthesis.risk_assessment_json = self._optional_json(synthesis_payload.get("risk_assessment"))
        synthesis.citations_json = self._optional_json(synthesis_payload.get("citations"))
        synthesis.implementation_plan_md = self._optional_text(synthesis_payload.get("implementation_plan_md"))
        synthesis.confidence = self._optional_decimal(synthesis_payload.get("confidence"))
        synthesis.synthesis_json = coerce_json_payload(synthesis_payload)
        session.add(synthesis)

    def _upsert_verdict(
        self,
        session: Session,
        run: WhitepaperAnalysisRun,
        verdict_payload_raw: Any,
    ) -> None:
        if not isinstance(verdict_payload_raw, Mapping):
            return
        verdict_payload = cast(dict[str, Any], verdict_payload_raw)
        verdict = session.execute(
            select(WhitepaperViabilityVerdict).where(WhitepaperViabilityVerdict.analysis_run_id == run.id)
        ).scalar_one_or_none()
        verdict_text = self._optional_text(verdict_payload.get("verdict")) or "needs_review"
        approved_by = self._optional_text(verdict_payload.get("approved_by"))

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
                approved_by=approved_by,
                approved_at=datetime.now(timezone.utc) if approved_by else None,
            )
            session.add(verdict)
            return

        verdict.verdict = verdict_text
        verdict.score = self._optional_decimal(verdict_payload.get("score"))
        verdict.confidence = self._optional_decimal(verdict_payload.get("confidence"))
        verdict.decision_policy = self._optional_text(verdict_payload.get("decision_policy"))
        verdict.gating_json = self._optional_json(verdict_payload.get("gating"))
        verdict.rationale = self._optional_text(verdict_payload.get("rationale"))
        verdict.rejection_reasons_json = self._optional_json(verdict_payload.get("rejection_reasons"))
        verdict.recommendations_json = self._optional_json(verdict_payload.get("recommendations"))
        verdict.requires_followup = bool(verdict_payload.get("requires_followup"))
        verdict.approved_by = approved_by
        verdict.approved_at = datetime.now(timezone.utc) if approved_by else verdict.approved_at
        session.add(verdict)

    @staticmethod
    def _coerce_pr_payloads(pr_payload_raw: Any) -> list[dict[str, Any]]:
        if isinstance(pr_payload_raw, Mapping):
            return [cast(dict[str, Any], pr_payload_raw)]
        if isinstance(pr_payload_raw, list):
            return [cast(dict[str, Any], item) for item in pr_payload_raw if isinstance(item, Mapping)]
        return []

    def _upsert_design_pull_requests(
        self,
        session: Session,
        run: WhitepaperAnalysisRun,
        pr_payload_raw: Any,
    ) -> None:
        for index, pr_payload in enumerate(self._coerce_pr_payloads(pr_payload_raw), start=1):
            self._upsert_design_pull_request(session, run, pr_payload, index)

    def _upsert_design_pull_request(
        self,
        session: Session,
        run: WhitepaperAnalysisRun,
        pr_payload: dict[str, Any],
        index: int,
    ) -> None:
        attempt = int(pr_payload.get("attempt") or index)
        pr_row = session.execute(
            select(WhitepaperDesignPullRequest).where(
                WhitepaperDesignPullRequest.analysis_run_id == run.id,
                WhitepaperDesignPullRequest.attempt == attempt,
            )
        ).scalar_one_or_none()

        if pr_row is None:
            repository = (
                self._optional_text(pr_payload.get("repository"))
                or self._optional_text(cast(dict[str, Any], run.orchestration_context_json or {}).get("repository"))
                or "proompteng/lab"
            )
            pr_row = WhitepaperDesignPullRequest(
                analysis_run_id=run.id,
                attempt=attempt,
                status=self._optional_text(pr_payload.get("status")) or "opened",
                repository=repository,
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
                metadata_json=coerce_json_payload(pr_payload),
            )
            session.add(pr_row)
            return

        pr_row.status = self._optional_text(pr_payload.get("status")) or pr_row.status
        pr_row.pr_number = self._optional_int(pr_payload.get("pr_number")) or pr_row.pr_number
        pr_row.pr_url = self._optional_text(pr_payload.get("pr_url")) or pr_row.pr_url
        pr_row.title = self._optional_text(pr_payload.get("title")) or pr_row.title
        pr_row.body = self._optional_text(pr_payload.get("body")) or pr_row.body
        pr_row.commit_sha = self._optional_text(pr_payload.get("commit_sha")) or pr_row.commit_sha
        pr_row.merge_commit_sha = self._optional_text(pr_payload.get("merge_commit_sha")) or pr_row.merge_commit_sha
        pr_row.checks_url = self._optional_text(pr_payload.get("checks_url")) or pr_row.checks_url
        pr_row.ci_status = self._optional_text(pr_payload.get("ci_status")) or pr_row.ci_status
        pr_row.is_merged = bool(pr_payload.get("is_merged"))
        if pr_row.is_merged and pr_row.merged_at is None:
            pr_row.merged_at = datetime.now(timezone.utc)
        pr_row.metadata_json = coerce_json_payload(pr_payload)
        session.add(pr_row)

    def _ingest_artifacts(
        self,
        session: Session,
        run: WhitepaperAnalysisRun,
        artifact_payload_raw: Any,
    ) -> None:
        if not isinstance(artifact_payload_raw, list):
            return

        for item in artifact_payload_raw:
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

    def _upsert_steps(
        self,
        session: Session,
        run: WhitepaperAnalysisRun,
        steps_raw: Any,
    ) -> None:
        if not isinstance(steps_raw, list):
            return

        for index, step_raw in enumerate(steps_raw, start=1):
            if not isinstance(step_raw, Mapping):
                continue
            self._upsert_single_step(session, run, cast(dict[str, Any], step_raw), index)

    def _upsert_single_step(
        self,
        session: Session,
        run: WhitepaperAnalysisRun,
        step_payload: dict[str, Any],
        index: int,
    ) -> None:
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
            return

        step.status = self._optional_text(step_payload.get("status")) or step.status
        step.duration_ms = self._optional_int(step_payload.get("duration_ms")) or step.duration_ms
        step.input_json = self._optional_json(step_payload.get("input_json")) or step.input_json
        step.output_json = self._optional_json(step_payload.get("output_json")) or step.output_json
        step.error_json = self._optional_json(step_payload.get("error_json")) or step.error_json
        step.completed_at = datetime.now(timezone.utc)
        session.add(step)

    def _complete_run(
        self,
        session: Session,
        run: WhitepaperAnalysisRun,
        payload: Mapping[str, Any],
    ) -> None:
        target_status = self._optional_text(payload.get("status")) or "completed"
        run.status = target_status
        run.result_payload_json = coerce_json_payload(cast(dict[str, Any], payload))
        run.completed_at = datetime.now(timezone.utc)
        run.failure_reason = None if target_status == "completed" else self._optional_text(payload.get("failure_reason"))
        session.add(run)

        if run.document is None:
            return
        run.document.status = "analyzed" if target_status == "completed" else "failed"
        run.document.last_processed_at = datetime.now(timezone.utc)
        session.add(run.document)

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
        timeout = _int_env("WHITEPAPER_DOWNLOAD_TIMEOUT_SECONDS", 30)
        status, _, payload = _http_request_bytes(
            url,
            method='GET',
            headers={
                "Accept": "application/pdf,application/octet-stream;q=0.9,*/*;q=0.8",
                **({"Authorization": f"Bearer {token}"} if token else {}),
            },
            timeout_seconds=timeout,
            max_response_bytes=max_bytes,
            follow_redirects=True,
        )
        if status < 200 or status >= 300:
            raise RuntimeError(f'pdf_download_http_{status}')
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
        timeout = _int_env("WHITEPAPER_AGENTRUN_TIMEOUT_SECONDS", 20)
        status, _, raw_bytes = _http_request_bytes(
            submit_url,
            method='POST',
            headers={
                "Content-Type": "application/json",
                "Idempotency-Key": idempotency_key,
                **({"Authorization": f"Bearer {auth_token}"} if auth_token else {}),
            },
            body=json.dumps(payload).encode('utf-8'),
            timeout_seconds=timeout,
        )
        raw = raw_bytes.decode('utf-8', errors='replace')
        if status < 200 or status >= 300:
            raise RuntimeError(f'jangar_submit_http_{status}:{raw[:200]}')
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

        if counters["failed_total"] == 0:
            self._commit_consumer(consumer)
        else:
            logger.warning(
                "Whitepaper issue intake had %s failed messages; skipping offset commit",
                counters["failed_total"],
            )
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
            logger.debug('whitepaper kafka worker cancelled')
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


__all__ = [
    "IssueKickoffResult",
    "WhitepaperKafkaIssueIngestor",
    "WhitepaperKafkaWorker",
    "WhitepaperWorkflowService",
    "build_whitepaper_run_id",
    "comment_requests_requeue",
    "extract_pdf_urls",
    "normalize_github_issue_event",
    "parse_marker_block",
    "whitepaper_kafka_enabled",
    "whitepaper_workflow_enabled",
]
