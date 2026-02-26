"""Whitepaper workflow ingestion, orchestration, and persistence helpers."""
# pyright: reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownVariableType=false, reportUnknownParameterType=false, reportOptionalMemberAccess=false, reportUnnecessaryComparison=false

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
from subprocess import CalledProcessError, run
from typing import Any, Mapping, cast
from urllib.parse import quote, urljoin, urlparse

import inngest
from sqlalchemy import case, func, select, text
from sqlalchemy.orm import Session

from ..models import (
    WhitepaperAnalysisRun,
    WhitepaperAnalysisStep,
    WhitepaperArtifact,
    WhitepaperCodexAgentRun,
    WhitepaperContent,
    WhitepaperDesignPullRequest,
    WhitepaperDocument,
    WhitepaperDocumentVersion,
    WhitepaperEngineeringTrigger,
    WhitepaperRolloutTransition,
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
_ELIGIBLE_AUTO_VERDICTS = {"implement", "conditional_implement"}
_REJECT_VERDICTS = {"reject", "not_viable", "not-viable"}
_PASS_GATE_STATUSES = {"pass", "passed", "ok", "true", "green"}
_MAX_SEMANTIC_RELEVANT_DISTANCE = 0.62
_SEMANTIC_RELATIVE_DISTANCE_WINDOW = 0.18


@dataclass(frozen=True)
class EngineeringGradeDecision:
    implementation_grade: str
    decision: str
    reason_codes: list[str]
    policy_ref: str
    rollout_profile: str
    gate_snapshot_hash: str | None
    gate_snapshot: dict[str, Any] | None
    hypothesis_id: str | None
    approval_token: str


@dataclass(frozen=True)
class ManualApprovalPayload:
    approved_by: str
    approval_reason: str
    approval_source: str
    target_scope: str | None
    repository: str | None
    base: str | None
    head: str | None
    rollout_profile: str | None


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


def _float_env(name: str, default: float) -> float:
    raw = _str_env(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _normalize_identifier(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "_", value.strip().lower()).strip("_")
    return normalized or "unknown"


def _sorted_unique(values: list[str]) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    for value in values:
        item = value.strip()
        if not item or item in seen:
            continue
        seen.add(item)
        ordered.append(item)
    return ordered


def whitepaper_workflow_enabled() -> bool:
    return _bool_env("WHITEPAPER_WORKFLOW_ENABLED", default=False)


def whitepaper_inngest_enabled() -> bool:
    return _bool_env("WHITEPAPER_INNGEST_ENABLED", default=False)


def whitepaper_kafka_enabled() -> bool:
    return _bool_env("WHITEPAPER_KAFKA_ENABLED", default=False)


def whitepaper_semantic_indexing_enabled() -> bool:
    return _bool_env("WHITEPAPER_SEMANTIC_INDEXING_ENABLED", default=False)


def whitepaper_semantic_required() -> bool:
    return _bool_env("WHITEPAPER_SEMANTIC_REQUIRED", default=False)


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


def normalize_analysis_mode(value: str | None) -> str:
    normalized = _normalize_identifier(value or "")
    if normalized in {"implementation", "analysis_only"}:
        return normalized
    return "implementation"


def parse_marker_tags(value: str | None) -> list[str]:
    raw = value or ""
    if not raw.strip():
        return []
    return _sorted_unique(
        [
            _normalize_identifier(item)
            for item in re.split(r"[,\n]", raw)
            if item and item.strip()
        ]
    )


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
        self.inngest_client: inngest.Inngest | None = None

    def set_inngest_client(self, client: inngest.Inngest | None) -> None:
        self.inngest_client = client

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
            return IssueKickoffResult(accepted=False, reason="unsupported_workflow_marker"), None, ""

        attachments = extract_pdf_urls(issue_body)
        attachment_url = normalize_attachment_url(
            str(marker.get("attachment_url") or (attachments[0] if attachments else ""))
        )
        if not attachment_url:
            return IssueKickoffResult(accepted=False, reason="pdf_attachment_missing"), None, ""

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
                    WhitepaperDocumentVersion.id == WhitepaperAnalysisRun.document_version_id,
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
        subject = self._optional_text(marker.get("subject"))
        marker_tags = parse_marker_tags(self._optional_text(marker.get("tags")))
        metadata = {
            "repository": issue_event.repository,
            "issue_number": issue_event.issue_number,
            "issue_url": issue_event.issue_url,
            "subject": subject,
            "analysis_mode": normalize_analysis_mode(self._optional_text(marker.get("analysis_mode"))),
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
        if isinstance(document.tags_json, list):
            merged_tags.extend(
                [self._optional_text(item) or "" for item in cast(list[Any], document.tags_json)]
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
        ceph_bucket = _str_env("WHITEPAPER_CEPH_BUCKET") or _str_env("BUCKET_NAME") or "torghut-whitepapers"
        ceph_key = f"raw/checksum/{checksum[:2]}/{checksum}/source.pdf"
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
        subject = self._optional_text(marker.get("subject"))
        tags = parse_marker_tags(self._optional_text(marker.get("tags")))
        analysis_mode = normalize_analysis_mode(self._optional_text(marker.get("analysis_mode")))
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
            _str_env("WHITEPAPER_INNGEST_EVENT_NAME", "torghut/whitepaper.analysis.requested")
            or "torghut/whitepaper.analysis.requested"
        )
        context = cast(dict[str, Any], run_row.orchestration_context_json or {})
        enqueue_attempt = (self._optional_int(context.get("inngest_enqueue_attempt")) or 0) + 1
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
            run_row.failure_reason = f"inngest_enqueue_failed:{type(exc).__name__}:{exc}"
            run_row.status = "failed"
            session.add(run_row)
            return False

        run_row.inngest_event_id = event_ids[0] if event_ids else run_row.inngest_event_id
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
        if not whitepaper_inngest_enabled() or not whitepaper_semantic_indexing_enabled():
            return False
        if self.inngest_client is None:
            return False
        event_name = (
            _str_env("WHITEPAPER_INNGEST_FINALIZED_EVENT_NAME", "torghut/whitepaper.analysis.finalized")
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
        analysis_profile = cast(dict[str, Any], run.analysis_profile_json or {})
        subject = self._optional_text(analysis_profile.get("subject")) or self._optional_text(context.get("subject"))
        tags = self._coerce_tag_list(analysis_profile.get("tags") or context.get("tags"))
        analysis_mode = normalize_analysis_mode(
            self._optional_text(analysis_profile.get("analysis_mode") or context.get("analysis_mode"))
        )

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
            "idempotencyKey": run.run_id if dispatch_attempt == 1 else f"{run.run_id}-retry-{dispatch_attempt}",
            "agentRef": {"name": _str_env("WHITEPAPER_AGENT_NAME", "codex-whitepaper-agent")},
            "runtime": {"type": "job"},
            "implementation": {
                "summary": f"Whitepaper analysis {run.run_id}",
                "text": prompt,
                "source": {"provider": "github", "url": issue_url or f"https://github.com/{repository}/issues/{issue_number}"},
                "vcsRef": {"name": _str_env("WHITEPAPER_AGENTRUN_VCS_REF", "github")},
                "labels": labels,
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
                "subject": subject or "",
                "tags": ",".join(tags),
                "analysisMode": analysis_mode,
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
        trigger_result = self._evaluate_and_process_engineering_trigger(
            session,
            run,
            manual_approval=None,
        )
        if run.status == "completed" and whitepaper_semantic_indexing_enabled():
            queued_for_async_indexing = False
            if whitepaper_inngest_enabled():
                queued_for_async_indexing = self._enqueue_finalized_inngest_event(session, run=run)

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
                run.failure_reason = f"semantic_extract_failed:{type(exc).__name__}:{exc}"
                session.add(run)
                raise

        if whitepaper_semantic_indexing_enabled() and full_text.strip():
            self.index_full_text_semantic_content(session, run_id=run.run_id, full_text=full_text)

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
            return {"run_id": run.run_id, "indexed_chunks": 0, "source_scope": "synthesis"}

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

    def search_semantic(
        self,
        session: Session,
        *,
        query: str,
        limit: int,
        offset: int,
        status: str,
        scope: str,
        subject: str | None,
    ) -> dict[str, Any]:
        clean_query = query.strip()
        if not clean_query:
            raise ValueError("query_required")

        semantic_limit = min(max(limit * 4, limit), 250)
        lexical_limit = min(max(limit * 4, limit), 250)
        embedding_model, embedding_dimension, query_embedding = self._embed_texts([clean_query])
        vector_text = self._vector_to_text(query_embedding[0])

        scope_filter = None if scope == "all" else scope
        status_filter = status.strip() if status.strip() else "completed"
        subject_filter = subject.strip() if subject else None
        lexical_query = clean_query

        semantic_rows = session.execute(
            text(
                """
                SELECT
                  sc.id::text AS chunk_id,
                  r.run_id AS run_id,
                  r.status AS run_status,
                  r.created_at AS run_created_at,
                  r.completed_at AS run_completed_at,
                  d.document_key AS document_key,
                  d.title AS document_title,
                  d.source_identifier AS source_identifier,
                  sc.source_scope AS source_scope,
                  sc.section_key AS section_key,
                  sc.chunk_index AS chunk_index,
                  sc.content AS content,
                  (se.embedding <=> CAST(:query_vector AS vector)) AS semantic_distance
                FROM whitepaper_semantic_embeddings se
                JOIN whitepaper_semantic_chunks sc ON sc.id = se.semantic_chunk_id
                JOIN whitepaper_analysis_runs r ON r.id = sc.analysis_run_id
                JOIN whitepaper_documents d ON d.id = r.document_id
                WHERE se.model = :embedding_model
                  AND se.dimension = :embedding_dimension
                  AND (:status_filter IS NULL OR r.status = :status_filter)
                  AND (:scope_filter IS NULL OR sc.source_scope = :scope_filter)
                  AND (:subject_filter IS NULL OR (d.metadata_json ->> 'subject') = :subject_filter)
                ORDER BY se.embedding <=> CAST(:query_vector AS vector) ASC
                LIMIT :semantic_limit
                """
            ),
            {
                "query_vector": vector_text,
                "embedding_model": embedding_model,
                "embedding_dimension": embedding_dimension,
                "status_filter": status_filter,
                "scope_filter": scope_filter,
                "subject_filter": subject_filter,
                "semantic_limit": semantic_limit,
            },
        ).mappings().all()

        lexical_rows = session.execute(
            text(
                """
                SELECT
                  sc.id::text AS chunk_id,
                  r.run_id AS run_id,
                  r.status AS run_status,
                  r.created_at AS run_created_at,
                  r.completed_at AS run_completed_at,
                  d.document_key AS document_key,
                  d.title AS document_title,
                  d.source_identifier AS source_identifier,
                  sc.source_scope AS source_scope,
                  sc.section_key AS section_key,
                  sc.chunk_index AS chunk_index,
                  sc.content AS content,
                  ts_rank_cd(
                    sc.text_tsvector,
                    websearch_to_tsquery('simple', :lexical_query)
                  ) AS lexical_score
                FROM whitepaper_semantic_chunks sc
                JOIN whitepaper_analysis_runs r ON r.id = sc.analysis_run_id
                JOIN whitepaper_documents d ON d.id = r.document_id
                WHERE (:status_filter IS NULL OR r.status = :status_filter)
                  AND (:scope_filter IS NULL OR sc.source_scope = :scope_filter)
                  AND (:subject_filter IS NULL OR (d.metadata_json ->> 'subject') = :subject_filter)
                  AND sc.text_tsvector @@ websearch_to_tsquery('simple', :lexical_query)
                ORDER BY lexical_score DESC
                LIMIT :lexical_limit
                """
            ),
            {
                "lexical_query": lexical_query,
                "status_filter": status_filter,
                "scope_filter": scope_filter,
                "subject_filter": subject_filter,
                "lexical_limit": lexical_limit,
            },
        ).mappings().all()

        semantic_rank: dict[str, int] = {}
        lexical_rank: dict[str, int] = {}
        merged: dict[str, dict[str, Any]] = {}

        for idx, row in enumerate(semantic_rows, start=1):
            chunk_id = str(row["chunk_id"])
            semantic_rank[chunk_id] = idx
            merged[chunk_id] = {
                **dict(row),
                "semantic_distance": float(row["semantic_distance"]) if row["semantic_distance"] is not None else None,
                "lexical_score": None,
            }

        for idx, row in enumerate(lexical_rows, start=1):
            chunk_id = str(row["chunk_id"])
            lexical_rank[chunk_id] = idx
            entry = merged.get(chunk_id)
            lexical_score = float(row["lexical_score"]) if row["lexical_score"] is not None else None
            if entry is None:
                merged[chunk_id] = {
                    **dict(row),
                    "semantic_distance": None,
                    "lexical_score": lexical_score,
                }
            else:
                entry["lexical_score"] = lexical_score

        best_semantic_distance = min(
            [d for d in [cast(float | None, row.get("semantic_distance")) for row in merged.values()] if d is not None],
            default=None,
        )
        semantic_ceiling = None
        if best_semantic_distance is not None:
            semantic_ceiling = min(
                _MAX_SEMANTIC_RELEVANT_DISTANCE,
                best_semantic_distance + _SEMANTIC_RELATIVE_DISTANCE_WINDOW,
            )

        ranked: list[dict[str, Any]] = []
        for chunk_id, row in merged.items():
            sem_rank = semantic_rank.get(chunk_id)
            lex_rank = lexical_rank.get(chunk_id)
            hybrid_score = 0.0
            if sem_rank is not None:
                hybrid_score += 1.0 / (60.0 + sem_rank)
            if lex_rank is not None:
                hybrid_score += 1.0 / (60.0 + lex_rank)
            semantic_distance = cast(float | None, row.get("semantic_distance"))
            lexical_score = cast(float | None, row.get("lexical_score"))
            if semantic_distance is not None and semantic_ceiling is not None:
                if semantic_distance > semantic_ceiling and lexical_score is None:
                    continue
            row["hybrid_score"] = hybrid_score
            ranked.append(row)

        ranked.sort(
            key=lambda item: (
                -self._coerce_float(item.get("hybrid_score"), default=0.0),
                self._coerce_float(item.get("semantic_distance"), default=999.0),
                -self._coerce_float(item.get("lexical_score"), default=0.0),
            )
        )
        total = len(ranked)
        paged = ranked[offset : offset + limit]
        items = [
            {
                "run_id": str(item["run_id"]),
                "run_status": str(item["run_status"]),
                "run_created_at": item["run_created_at"],
                "run_completed_at": item["run_completed_at"],
                "document": {
                    "document_key": item["document_key"],
                    "title": item["document_title"],
                    "source_identifier": item["source_identifier"],
                },
                "chunk": {
                    "source_scope": item["source_scope"],
                    "section_key": item["section_key"],
                    "chunk_index": int(item["chunk_index"]),
                    "snippet": self._build_search_snippet(str(item["content"]), clean_query),
                },
                "semantic_distance": item.get("semantic_distance"),
                "lexical_score": item.get("lexical_score"),
                "hybrid_score": item.get("hybrid_score"),
            }
            for item in paged
        ]

        return {
            "items": items,
            "total": total,
            "limit": limit,
            "offset": offset,
            "query": clean_query,
            "scope": scope,
            "status": status_filter,
            "subject": subject_filter,
        }

    @staticmethod
    def _coerce_string_list(value: Any) -> list[str]:
        if isinstance(value, list):
            result: list[str] = []
            for item in value:
                text = str(item).strip() if item is not None else ""
                if text:
                    result.append(text)
            return result
        if isinstance(value, str):
            text = value.strip()
            return [text] if text else []
        return []

    @staticmethod
    def _coerce_float(value: Any, *, default: float) -> float:
        if value is None:
            return default
        if isinstance(value, bool):
            return default
        if isinstance(value, (int, float)):
            return float(value)
        if isinstance(value, str):
            text = value.strip()
            if not text:
                return default
            try:
                return float(text)
            except ValueError:
                return default
        return default

    def _coerce_tag_list(self, value: Any) -> list[str]:
        if isinstance(value, list):
            return _sorted_unique(
                [
                    _normalize_identifier(str(item))
                    for item in value
                    if item is not None and str(item).strip()
                ]
            )
        if isinstance(value, str):
            return parse_marker_tags(value)
        return []

    def _extract_pdf_text(self, pdf_bytes: bytes) -> dict[str, Any]:
        pdftotext_result = self._extract_pdf_text_with_pdftotext(pdf_bytes)
        if pdftotext_result is not None:
            return pdftotext_result

        pypdf_result = self._extract_pdf_text_with_pypdf(pdf_bytes)
        if pypdf_result is not None:
            return pypdf_result

        raise RuntimeError("pdf_text_extract_unavailable")

    def _extract_pdf_text_with_pdftotext(self, pdf_bytes: bytes) -> dict[str, Any] | None:
        with tempfile.TemporaryDirectory(prefix="torghut-wp-") as temp_dir:
            pdf_path = os.path.join(temp_dir, "input.pdf")
            txt_path = os.path.join(temp_dir, "output.txt")
            with open(pdf_path, "wb") as handle:
                handle.write(pdf_bytes)

            try:
                run(
                    ["pdftotext", "-layout", "-enc", "UTF-8", pdf_path, txt_path],
                    check=True,
                    capture_output=True,
                    text=True,
                )
            except FileNotFoundError:
                return None
            except CalledProcessError as exc:
                raise RuntimeError(f"pdftotext_failed:{exc.stderr.strip()[:200]}") from exc

            full_text = ""
            if os.path.exists(txt_path):
                with open(txt_path, "r", encoding="utf-8", errors="replace") as handle:
                    full_text = handle.read()

            page_count: int | None = None
            try:
                pdfinfo = run(
                    ["pdfinfo", pdf_path],
                    check=True,
                    capture_output=True,
                    text=True,
                )
                for raw_line in pdfinfo.stdout.splitlines():
                    line = raw_line.strip()
                    if not line.lower().startswith("pages:"):
                        continue
                    _, raw_value = line.split(":", 1)
                    page_count = int(raw_value.strip())
                    break
            except (FileNotFoundError, CalledProcessError, ValueError):
                page_count = None

            return {
                "full_text": full_text,
                "metadata": {
                    "extract_method": "pdftotext",
                    "page_count": page_count,
                },
            }

    @staticmethod
    def _extract_pdf_text_with_pypdf(pdf_bytes: bytes) -> dict[str, Any] | None:
        try:
            from pypdf import PdfReader  # type: ignore[import-not-found]
        except Exception:
            return None

        try:
            reader = PdfReader(io.BytesIO(pdf_bytes))
            pages: list[str] = []
            for page in reader.pages:
                page_text = page.extract_text() or ""
                pages.append(page_text)
        except Exception as exc:  # pragma: no cover - parser internals vary by input
            raise RuntimeError(f"pypdf_extract_failed:{type(exc).__name__}:{exc}") from exc

        return {
            "full_text": "\n\n".join(pages),
            "metadata": {
                "extract_method": "pypdf",
                "page_count": len(pages),
            },
        }

    def _upsert_whitepaper_content(
        self,
        session: Session,
        *,
        run: WhitepaperAnalysisRun,
        full_text: str,
        extraction_meta: Mapping[str, Any] | None,
    ) -> None:
        version = run.document_version
        if version is None:
            raise RuntimeError("whitepaper_version_missing")

        normalized_text = full_text.strip()
        full_text_sha256 = hashlib.sha256(normalized_text.encode("utf-8")).hexdigest()
        token_count = len(normalized_text.split()) if normalized_text else 0
        page_count = self._optional_int((extraction_meta or {}).get("page_count"))

        content = session.execute(
            select(WhitepaperContent).where(WhitepaperContent.document_version_id == version.id)
        ).scalar_one_or_none()
        if content is None:
            content = WhitepaperContent(
                document_version_id=version.id,
                text_source="pdf_extract",
                full_text=normalized_text,
                full_text_sha256=full_text_sha256,
                section_index_json=None,
                chunk_manifest_json=None,
                extraction_warnings_json=None,
            )
            session.add(content)
        else:
            content.text_source = "pdf_extract"
            content.full_text = normalized_text
            content.full_text_sha256 = full_text_sha256
            session.add(content)

        version.parse_status = "parsed" if normalized_text else "stored"
        version.parse_error = None
        version.page_count = page_count
        version.char_count = len(normalized_text)
        version.token_count = token_count
        version.processed_at = datetime.now(timezone.utc)
        version.extraction_metadata_json = coerce_json_payload(cast(dict[str, Any], extraction_meta or {}))
        session.add(version)

    def _build_chunks(self, text_content: str, *, source_scope: str) -> list[dict[str, Any]]:
        normalized = text_content.strip()
        if not normalized:
            return []

        chunk_size = max(_int_env("WHITEPAPER_CHUNK_SIZE_CHARS", 2400), 400)
        overlap = max(_int_env("WHITEPAPER_CHUNK_OVERLAP_CHARS", 300), 0)
        if overlap >= chunk_size:
            overlap = max(0, chunk_size // 5)
        stride = max(chunk_size - overlap, 1)

        chunks: list[dict[str, Any]] = []
        chunk_index = 0
        cursor = 0
        total_length = len(normalized)
        while cursor < total_length:
            end = min(total_length, cursor + chunk_size)
            chunk_text = normalized[cursor:end].strip()
            if chunk_text:
                chunks.append(
                    {
                        "source_scope": source_scope,
                        "section_key": None,
                        "chunk_index": chunk_index,
                        "content": chunk_text,
                        "token_count": len(chunk_text.split()),
                        "metadata_json": {
                            "start_char": cursor,
                            "end_char": end,
                            "chunk_size_chars": len(chunk_text),
                        },
                    }
                )
                chunk_index += 1
            if end >= total_length:
                break
            cursor += stride

        return chunks

    def _persist_semantic_chunks_and_embeddings(
        self,
        session: Session,
        *,
        run: WhitepaperAnalysisRun,
        source_scope: str,
        chunks: list[dict[str, Any]],
    ) -> dict[str, Any]:
        normalized_scope = source_scope.strip().lower()
        if normalized_scope not in {"full_text", "synthesis"}:
            raise ValueError("invalid_source_scope")
        if run.document_version is None:
            raise RuntimeError("whitepaper_version_missing")

        if not chunks:
            session.execute(
                text(
                    """
                    DELETE FROM whitepaper_semantic_chunks
                    WHERE analysis_run_id = :analysis_run_id
                      AND source_scope = :source_scope
                    """
                ),
                {
                    "analysis_run_id": run.id,
                    "source_scope": normalized_scope,
                },
            )
            return {
                "run_id": run.run_id,
                "source_scope": normalized_scope,
                "indexed_chunks": 0,
                "model": None,
                "dimension": None,
            }

        for index, chunk in enumerate(chunks):
            chunk["chunk_index"] = index

        embeddings_model, embedding_dimension, embeddings = self._embed_texts(
            [str(chunk.get("content") or "") for chunk in chunks]
        )

        indexed_chunks = 0
        for chunk, embedding in zip(chunks, embeddings, strict=True):
            content = str(chunk.get("content") or "").strip()
            if not content:
                continue
            section_key = self._optional_text(chunk.get("section_key"))
            token_count = self._optional_int(chunk.get("token_count"))
            metadata_json = self._optional_json(chunk.get("metadata_json"))
            chunk_index = int(chunk.get("chunk_index") or 0)
            content_sha256 = hashlib.sha256(content.encode("utf-8")).hexdigest()
            vector_text = self._vector_to_text(embedding)

            chunk_row = session.execute(
                text(
                    """
                    INSERT INTO whitepaper_semantic_chunks (
                      id,
                      analysis_run_id,
                      document_version_id,
                      source_scope,
                      section_key,
                      chunk_index,
                      content,
                      content_sha256,
                      token_count,
                      metadata_json,
                      text_tsvector,
                      created_at,
                      updated_at
                    )
                    VALUES (
                      :id,
                      :analysis_run_id,
                      :document_version_id,
                      :source_scope,
                      :section_key,
                      :chunk_index,
                      :content,
                      :content_sha256,
                      :token_count,
                      CAST(:metadata_json AS JSONB),
                      to_tsvector('simple', :content),
                      now(),
                      now()
                    )
                    ON CONFLICT (analysis_run_id, source_scope, chunk_index)
                    DO UPDATE SET
                      section_key = EXCLUDED.section_key,
                      content = EXCLUDED.content,
                      content_sha256 = EXCLUDED.content_sha256,
                      token_count = EXCLUDED.token_count,
                      metadata_json = EXCLUDED.metadata_json,
                      text_tsvector = EXCLUDED.text_tsvector,
                      updated_at = now()
                    RETURNING id::text
                    """
                ),
                {
                    "id": str(uuid.uuid4()),
                    "analysis_run_id": run.id,
                    "document_version_id": run.document_version_id,
                    "source_scope": normalized_scope,
                    "section_key": section_key,
                    "chunk_index": chunk_index,
                    "content": content,
                    "content_sha256": content_sha256,
                    "token_count": token_count,
                    "metadata_json": json.dumps(metadata_json or {}),
                },
            ).mappings().first()
            if chunk_row is None:
                continue

            semantic_chunk_id = str(chunk_row["id"])
            session.execute(
                text(
                    """
                    INSERT INTO whitepaper_semantic_embeddings (
                      id,
                      semantic_chunk_id,
                      model,
                      dimension,
                      embedding,
                      created_at
                    )
                    VALUES (
                      :id,
                      CAST(:semantic_chunk_id AS uuid),
                      :model,
                      :dimension,
                      CAST(:embedding AS vector),
                      now()
                    )
                    ON CONFLICT (semantic_chunk_id, model, dimension)
                    DO UPDATE SET
                      embedding = EXCLUDED.embedding,
                      created_at = now()
                    """
                ),
                {
                    "id": str(uuid.uuid4()),
                    "semantic_chunk_id": semantic_chunk_id,
                    "model": embeddings_model,
                    "dimension": embedding_dimension,
                    "embedding": vector_text,
                },
            )
            indexed_chunks += 1

        session.execute(
            text(
                """
                DELETE FROM whitepaper_semantic_chunks
                WHERE analysis_run_id = :analysis_run_id
                  AND source_scope = :source_scope
                  AND chunk_index >= :chunk_count
                """
            ),
            {
                "analysis_run_id": run.id,
                "source_scope": normalized_scope,
                "chunk_count": len(chunks),
            },
        )

        index_step = WhitepaperAnalysisStep(
            analysis_run_id=run.id,
            step_name=f"semantic_index_{normalized_scope}",
            step_order=30 if normalized_scope == "full_text" else 60,
            attempt=self._next_step_attempt(
                session,
                analysis_run_id=run.id,
                step_name=f"semantic_index_{normalized_scope}",
            ),
            status="completed",
            executor="torghut",
            started_at=datetime.now(timezone.utc),
            completed_at=datetime.now(timezone.utc),
            output_json={
                "source_scope": normalized_scope,
                "indexed_chunks": indexed_chunks,
                "model": embeddings_model,
                "dimension": embedding_dimension,
            },
        )
        session.add(index_step)

        return {
            "run_id": run.run_id,
            "source_scope": normalized_scope,
            "indexed_chunks": indexed_chunks,
            "model": embeddings_model,
            "dimension": embedding_dimension,
        }

    def _embed_texts(self, texts: list[str]) -> tuple[str, int, list[list[float]]]:
        if not texts:
            raise ValueError("embedding_texts_required")

        base_url = (
            _str_env("WHITEPAPER_EMBEDDING_API_BASE_URL")
            or _str_env("OPENAI_BASE_URL")
            or "https://api.openai.com/v1"
        ).rstrip("/")
        if not base_url:
            raise RuntimeError("embedding_api_base_url_missing")

        api_key = _str_env("WHITEPAPER_EMBEDDING_API_KEY") or _str_env("OPENAI_API_KEY")
        embedding_model = (
            _str_env("WHITEPAPER_EMBEDDING_MODEL")
            or _str_env("OPENAI_EMBEDDING_MODEL")
            or "text-embedding-3-large"
        )
        configured_dimension = _int_env("WHITEPAPER_EMBEDDING_DIMENSION", 1024)
        timeout_seconds = max(1, _int_env("WHITEPAPER_EMBEDDING_TIMEOUT_MS", 20_000) // 1000)
        batch_size = max(1, _int_env("WHITEPAPER_EMBEDDING_BATCH_SIZE", 32))
        is_ollama_embed = base_url.endswith("/api")
        endpoint = f"{base_url}/{'embed' if is_ollama_embed else 'embeddings'}"
        embedding_truncate = _str_env("WHITEPAPER_EMBEDDING_TRUNCATE")
        embedding_keep_alive = _str_env("WHITEPAPER_EMBEDDING_KEEP_ALIVE")

        headers = {
            "Content-Type": "application/json",
            **({"Authorization": f"Bearer {api_key}"} if api_key else {}),
        }

        ordered_embeddings: list[list[float]] = []
        observed_dimension: int | None = None
        for batch_start in range(0, len(texts), batch_size):
            batch = texts[batch_start : batch_start + batch_size]
            payload: dict[str, Any]
            if is_ollama_embed:
                payload = {
                    "model": embedding_model,
                    "input": batch,
                }
                if embedding_truncate is not None:
                    payload["truncate"] = embedding_truncate.lower() in {"1", "true", "yes", "on"}
                if embedding_keep_alive is not None:
                    payload["keep_alive"] = embedding_keep_alive
            else:
                payload = {
                    "model": embedding_model,
                    "input": batch,
                    "encoding_format": "float",
                }
                if configured_dimension > 0:
                    payload["dimensions"] = configured_dimension

            status, _, raw = _http_request_bytes(
                endpoint,
                method="POST",
                headers=headers,
                body=json.dumps(payload).encode("utf-8"),
                timeout_seconds=timeout_seconds,
                max_response_bytes=15 * 1024 * 1024,
            )
            body = raw.decode("utf-8", errors="replace")
            if status < 200 or status >= 300:
                raise RuntimeError(f"embedding_http_{status}:{body[:220]}")

            parsed = json.loads(body)
            if not isinstance(parsed, dict):
                raise RuntimeError("embedding_invalid_response")
            if is_ollama_embed:
                raw_embeddings = parsed.get("embeddings")
                if raw_embeddings is None:
                    raw_embeddings = parsed.get("embedding")
                if not isinstance(raw_embeddings, list):
                    raise RuntimeError("embedding_invalid_data")
                if raw_embeddings and isinstance(raw_embeddings[0], list):
                    matrix = raw_embeddings
                else:
                    matrix = [raw_embeddings]
                if len(matrix) != len(batch):
                    raise RuntimeError("embedding_missing_row")
                for row in matrix:
                    if not isinstance(row, list):
                        raise RuntimeError("embedding_invalid_data")
                    embedding_values = [float(value) for value in row]
                    if observed_dimension is None:
                        observed_dimension = len(embedding_values)
                    elif observed_dimension != len(embedding_values):
                        raise RuntimeError("embedding_dimension_mismatch")
                    ordered_embeddings.append(embedding_values)
            else:
                data = parsed.get("data")
                if not isinstance(data, list):
                    raise RuntimeError("embedding_invalid_data")

                indexed_batch_embeddings: dict[int, list[float]] = {}
                for row in data:
                    if not isinstance(row, Mapping):
                        continue
                    index_raw = row.get("index")
                    embedding_raw = row.get("embedding")
                    if not isinstance(index_raw, int) or not isinstance(embedding_raw, list):
                        continue
                    embedding_values = [float(value) for value in embedding_raw]
                    if observed_dimension is None:
                        observed_dimension = len(embedding_values)
                    elif observed_dimension != len(embedding_values):
                        raise RuntimeError("embedding_dimension_mismatch")
                    indexed_batch_embeddings[index_raw] = embedding_values

                for local_index in range(len(batch)):
                    embedding_values = indexed_batch_embeddings.get(local_index)
                    if embedding_values is None:
                        raise RuntimeError("embedding_missing_row")
                    ordered_embeddings.append(embedding_values)

        dimension = observed_dimension or configured_dimension
        if dimension <= 0:
            raise RuntimeError("embedding_dimension_unresolved")
        if configured_dimension > 0 and configured_dimension != dimension:
            raise RuntimeError(
                f"embedding_dimension_config_mismatch:expected_{configured_dimension}:actual_{dimension}"
            )

        return embedding_model, dimension, ordered_embeddings

    @staticmethod
    def _vector_to_text(values: list[float]) -> str:
        serialized = ",".join(format(float(value), ".12g") for value in values)
        return f"[{serialized}]"

    @staticmethod
    def _build_search_snippet(content: str, query: str) -> str:
        normalized_content = content.strip()
        if not normalized_content:
            return ""

        terms = [part.strip() for part in re.split(r"\s+", query) if part.strip()]
        focus_term = None
        for term in terms:
            if len(term) >= 3:
                focus_term = re.escape(term)
                break

        if focus_term is None:
            return normalized_content[:220] + ("…" if len(normalized_content) > 220 else "")

        match = re.search(focus_term, normalized_content, re.IGNORECASE)
        if match is None:
            return normalized_content[:220] + ("…" if len(normalized_content) > 220 else "")

        start = max(0, match.start() - 120)
        end = min(len(normalized_content), match.end() + 120)
        snippet = normalized_content[start:end].strip()
        prefix = "…" if start > 0 else ""
        suffix = "…" if end < len(normalized_content) else ""
        return f"{prefix}{snippet}{suffix}"

    def _evaluate_and_process_engineering_trigger(
        self,
        session: Session,
        run: WhitepaperAnalysisRun,
        *,
        manual_approval: ManualApprovalPayload | None,
    ) -> dict[str, Any]:
        verdict = run.viability_verdict
        decision = self._compute_engineering_grade_decision(run, verdict, manual_approval=manual_approval)
        existing_trigger = session.execute(
            select(WhitepaperEngineeringTrigger).where(
                WhitepaperEngineeringTrigger.analysis_run_id == run.id
            )
        ).scalar_one_or_none()
        already_dispatched = bool(
            existing_trigger is not None and self._optional_text(existing_trigger.dispatched_agentrun_name)
        )
        trigger = self._upsert_engineering_trigger(
            session,
            run=run,
            verdict=verdict,
            decision=decision,
            manual_approval=manual_approval,
        )

        should_dispatch = decision.decision == "queued"
        if already_dispatched:
            should_dispatch = False
            trigger.decision = "dispatched"

        if should_dispatch:
            try:
                dispatch_result = self._dispatch_engineering_agentrun(
                    session,
                    run=run,
                    trigger=trigger,
                    manual_approval=manual_approval,
                )
                trigger.decision = "dispatched"
                trigger.dispatched_agentrun_name = self._optional_text(
                    dispatch_result.get("agentrun_name")
                )
            except Exception as exc:
                reason_codes = list(cast(list[str], trigger.reason_codes_json or []))
                reason_codes.append(
                    f"engineering_dispatch_failed_{_normalize_identifier(type(exc).__name__)}"
                )
                trigger.decision = "failed"
                trigger.reason_codes_json = _sorted_unique(reason_codes)
            session.add(trigger)

        rollout_transitions: list[WhitepaperRolloutTransition] = []
        if trigger.decision == "dispatched" and trigger.rollout_profile == "automatic":
            rollout_transitions = self._run_auto_rollout_controller(
                session,
                trigger=trigger,
            )

        return self._build_engineering_trigger_payload(trigger, rollout_transitions)

    def _compute_engineering_grade_decision(
        self,
        run: WhitepaperAnalysisRun,
        verdict: WhitepaperViabilityVerdict | None,
        *,
        manual_approval: ManualApprovalPayload | None,
    ) -> EngineeringGradeDecision:
        policy_ref = (
            _str_env("WHITEPAPER_ENGINEERING_TRIGGER_POLICY_REF", "torghut-v5-high-confidence-trigger-v1")
            or "torghut-v5-high-confidence-trigger-v1"
        )
        rollout_profile = self._normalize_rollout_profile(
            manual_approval.rollout_profile if manual_approval is not None else None
        )
        if manual_approval is None:
            rollout_profile = self._normalize_rollout_profile(
                _str_env("WHITEPAPER_ENGINEERING_ROLLOUT_PROFILE", rollout_profile)
            )

        reason_codes: list[str] = []
        min_confidence = _float_env("WHITEPAPER_ENGINEERING_MIN_CONFIDENCE", 0.80)
        min_score = _float_env("WHITEPAPER_ENGINEERING_MIN_SCORE", 0.75)
        priority_confidence = _float_env(
            "WHITEPAPER_ENGINEERING_PRIORITY_MIN_CONFIDENCE",
            max(min_confidence, 0.90),
        )
        priority_score = _float_env("WHITEPAPER_ENGINEERING_PRIORITY_MIN_SCORE", max(min_score, 0.90))
        auto_dispatch_enabled = _bool_env("WHITEPAPER_ENGINEERING_AUTO_DISPATCH_ENABLED", default=True)

        gate_snapshot = self._as_json_record(verdict.gating_json if verdict is not None else None)
        gate_snapshot_hash = self._compute_json_hash(gate_snapshot) if gate_snapshot is not None else None
        gate_statuses = self._extract_gate_statuses(gate_snapshot)
        gate_missing_codes = self._missing_gate_reason_codes(
            gate_statuses,
            required=("g1", "g2", "g3", "g4", "g5"),
        )
        blocking_reason_codes = self._gating_blocking_reason_codes(gate_snapshot, gate_statuses)
        reason_codes.extend(gate_missing_codes)
        reason_codes.extend(blocking_reason_codes)

        verdict_text = (
            self._optional_text(verdict.verdict).lower() if verdict is not None and verdict.verdict else "missing"
        )
        score_value = float(verdict.score) if verdict is not None and verdict.score is not None else None
        confidence_value = float(verdict.confidence) if verdict is not None and verdict.confidence is not None else None
        requires_followup = bool(verdict.requires_followup) if verdict is not None else True
        hypothesis_id = self._derive_hypothesis_id(run)

        if run.status != "completed":
            reason_codes.append("run_status_not_completed")
            implementation_grade = "research_only"
            dispatch_decision = "suppressed"
        elif verdict is None:
            reason_codes.append("verdict_missing")
            implementation_grade = "reject"
            dispatch_decision = "suppressed"
        else:
            if verdict_text not in _ELIGIBLE_AUTO_VERDICTS:
                reason_codes.append(f"verdict_not_auto_eligible_{_normalize_identifier(verdict_text)}")
            if confidence_value is None:
                reason_codes.append("confidence_missing")
            elif confidence_value < min_confidence:
                reason_codes.append("confidence_below_min")
            if score_value is None:
                reason_codes.append("score_missing")
            elif score_value < min_score:
                reason_codes.append("score_below_min")
            if requires_followup:
                reason_codes.append("requires_followup_true")

            if verdict_text in _REJECT_VERDICTS or (
                confidence_value is not None and confidence_value < min_confidence
            ):
                implementation_grade = "reject"
                dispatch_decision = "suppressed"
            elif requires_followup or gate_snapshot is None or bool(gate_missing_codes) or bool(blocking_reason_codes):
                if gate_snapshot is None:
                    reason_codes.append("gating_json_missing")
                implementation_grade = "research_only"
                dispatch_decision = "suppressed"
            elif (
                verdict_text in _ELIGIBLE_AUTO_VERDICTS
                and confidence_value is not None
                and confidence_value >= min_confidence
                and score_value is not None
                and score_value >= min_score
            ):
                if confidence_value >= priority_confidence and score_value >= priority_score:
                    implementation_grade = "engineering_priority"
                else:
                    implementation_grade = "engineering_candidate"
                dispatch_decision = "queued" if auto_dispatch_enabled else "suppressed"
            else:
                implementation_grade = "research_only"
                dispatch_decision = "suppressed"

        if manual_approval is not None:
            if self._manual_approval_allowed(rollout_profile):
                reason_codes.append("manual_override_applied")
                reason_codes.append(
                    f"manual_override_source_{_normalize_identifier(manual_approval.approval_source)}"
                )
                dispatch_decision = "queued"
            else:
                reason_codes.append("manual_override_not_allowed_for_profile")
                dispatch_decision = "suppressed"

        if dispatch_decision == "queued":
            reason_codes.append("engineering_dispatch_queued")
        elif not auto_dispatch_enabled and manual_approval is None:
            reason_codes.append("auto_dispatch_disabled")

        approval_seed = {
            "run_id": run.run_id,
            "grade": implementation_grade,
            "decision": dispatch_decision,
            "policy_ref": policy_ref,
            "gate_snapshot_hash": gate_snapshot_hash,
            "manual_override": bool(manual_approval is not None),
        }
        approval_token = "wpat-" + hashlib.sha256(
            json.dumps(approval_seed, sort_keys=True).encode("utf-8")
        ).hexdigest()[:24]

        return EngineeringGradeDecision(
            implementation_grade=implementation_grade,
            decision=dispatch_decision,
            reason_codes=_sorted_unique(reason_codes),
            policy_ref=policy_ref,
            rollout_profile=rollout_profile,
            gate_snapshot_hash=gate_snapshot_hash,
            gate_snapshot=gate_snapshot,
            hypothesis_id=hypothesis_id,
            approval_token=approval_token,
        )

    def _upsert_engineering_trigger(
        self,
        session: Session,
        *,
        run: WhitepaperAnalysisRun,
        verdict: WhitepaperViabilityVerdict | None,
        decision: EngineeringGradeDecision,
        manual_approval: ManualApprovalPayload | None,
    ) -> WhitepaperEngineeringTrigger:
        trigger = session.execute(
            select(WhitepaperEngineeringTrigger).where(
                WhitepaperEngineeringTrigger.analysis_run_id == run.id
            )
        ).scalar_one_or_none()
        if trigger is None:
            trigger = WhitepaperEngineeringTrigger(
                trigger_id=f"wptrig-{hashlib.sha256(run.run_id.encode('utf-8')).hexdigest()[:24]}",
                whitepaper_run_id=run.run_id,
                analysis_run_id=run.id,
                verdict_id=verdict.id if verdict is not None else None,
                hypothesis_id=decision.hypothesis_id,
                implementation_grade=decision.implementation_grade,
                decision=decision.decision,
                reason_codes_json=decision.reason_codes,
                approval_token=decision.approval_token,
                rollout_profile=decision.rollout_profile,
                policy_ref=decision.policy_ref,
                gate_snapshot_hash=decision.gate_snapshot_hash,
                gate_snapshot_json=decision.gate_snapshot,
            )
            if manual_approval is not None:
                trigger.approval_source = manual_approval.approval_source
                trigger.approved_by = manual_approval.approved_by
                trigger.approval_reason = manual_approval.approval_reason
                trigger.approved_at = datetime.now(timezone.utc)
            session.add(trigger)
            session.flush()
            return trigger

        trigger.verdict_id = verdict.id if verdict is not None else None
        trigger.hypothesis_id = decision.hypothesis_id
        trigger.implementation_grade = decision.implementation_grade
        trigger.decision = decision.decision
        trigger.reason_codes_json = decision.reason_codes
        trigger.approval_token = decision.approval_token
        trigger.rollout_profile = decision.rollout_profile
        trigger.policy_ref = decision.policy_ref
        trigger.gate_snapshot_hash = decision.gate_snapshot_hash
        trigger.gate_snapshot_json = decision.gate_snapshot
        if manual_approval is not None:
            trigger.approval_source = manual_approval.approval_source
            trigger.approved_by = manual_approval.approved_by
            trigger.approved_at = datetime.now(timezone.utc)
            trigger.approval_reason = manual_approval.approval_reason
        session.add(trigger)
        session.flush()
        return trigger

    def _run_auto_rollout_controller(
        self,
        session: Session,
        *,
        trigger: WhitepaperEngineeringTrigger,
    ) -> list[WhitepaperRolloutTransition]:
        existing_with_hash = session.execute(
            select(WhitepaperRolloutTransition)
            .where(
                WhitepaperRolloutTransition.trigger_id == trigger.id,
                WhitepaperRolloutTransition.evidence_hash == trigger.gate_snapshot_hash,
            )
            .order_by(WhitepaperRolloutTransition.created_at.asc())
        ).scalars().all()
        if existing_with_hash:
            return list(existing_with_hash)

        gate_snapshot = self._as_json_record(trigger.gate_snapshot_json)
        gate_statuses = self._extract_gate_statuses(gate_snapshot)
        transitions: list[WhitepaperRolloutTransition] = []
        current_stage: str | None = None
        stage_requirements: tuple[tuple[str, tuple[str, ...]], ...] = (
            ("paper", ("g1", "g2", "g3", "g4", "g5")),
            ("shadow", ("g1", "g2", "g3", "g4", "g5", "g6")),
            ("constrained_live", ("g1", "g2", "g3", "g4", "g5", "g6")),
            ("scaled_live", ("g1", "g2", "g3", "g4", "g5", "g6", "g7")),
        )

        for target_stage, required_gates in stage_requirements:
            gate_failures = self._required_gate_failures(gate_statuses, required=required_gates)
            if not gate_failures:
                transitions.append(
                    self._append_rollout_transition(
                        session,
                        trigger=trigger,
                        from_stage=current_stage,
                        to_stage=target_stage,
                        transition_type="advance",
                        status="passed",
                        reason_codes=["all_required_gates_pass"],
                        gate_results={"required_gates": list(required_gates), "gate_statuses": gate_statuses},
                        blocking_gate=None,
                    )
                )
                current_stage = target_stage
                continue

            blocking_gate = self._first_blocking_gate_id(gate_failures)
            if current_stage in {"shadow", "constrained_live", "scaled_live"}:
                rollback_target = self._rollback_target_stage(current_stage)
                transitions.append(
                    self._append_rollout_transition(
                        session,
                        trigger=trigger,
                        from_stage=current_stage,
                        to_stage=rollback_target,
                        transition_type="rollback",
                        status="rolled_back",
                        reason_codes=gate_failures,
                        gate_results={"required_gates": list(required_gates), "gate_statuses": gate_statuses},
                        blocking_gate=blocking_gate,
                    )
                )
                current_stage = rollback_target

            transitions.append(
                self._append_rollout_transition(
                    session,
                    trigger=trigger,
                    from_stage=current_stage,
                    to_stage=current_stage,
                    transition_type="halt",
                    status="halted",
                    reason_codes=gate_failures,
                    gate_results={"required_gates": list(required_gates), "gate_statuses": gate_statuses},
                    blocking_gate=blocking_gate,
                )
            )
            return transitions

        return transitions

    def _append_rollout_transition(
        self,
        session: Session,
        *,
        trigger: WhitepaperEngineeringTrigger,
        from_stage: str | None,
        to_stage: str | None,
        transition_type: str,
        status: str,
        reason_codes: list[str],
        gate_results: dict[str, Any],
        blocking_gate: str | None,
    ) -> WhitepaperRolloutTransition:
        sequence = self._next_rollout_sequence(session, trigger.id)
        transition_seed = (
            f"{trigger.trigger_id}:{trigger.gate_snapshot_hash}:{transition_type}:{from_stage or ''}:"
            f"{to_stage or ''}:{sequence}"
        )
        transition = WhitepaperRolloutTransition(
            transition_id=f"wprt-{hashlib.sha256(transition_seed.encode('utf-8')).hexdigest()[:24]}",
            trigger_id=trigger.id,
            whitepaper_run_id=trigger.whitepaper_run_id,
            from_stage=from_stage,
            to_stage=to_stage,
            transition_type=transition_type,
            status=status,
            gate_results_json=coerce_json_payload(gate_results),
            reason_codes_json=_sorted_unique(reason_codes),
            blocking_gate=blocking_gate,
            evidence_hash=trigger.gate_snapshot_hash,
        )
        session.add(transition)
        session.flush()
        return transition

    def _next_rollout_sequence(self, session: Session, trigger_id: Any) -> int:
        existing_count = session.execute(
            select(func.count())
            .select_from(WhitepaperRolloutTransition)
            .where(WhitepaperRolloutTransition.trigger_id == trigger_id)
        ).scalar_one()
        return int(existing_count or 0) + 1

    def _dispatch_engineering_agentrun(
        self,
        session: Session,
        *,
        run: WhitepaperAnalysisRun,
        trigger: WhitepaperEngineeringTrigger,
        manual_approval: ManualApprovalPayload | None,
    ) -> dict[str, Any]:
        context = cast(dict[str, Any], run.orchestration_context_json or {})
        marker = cast(dict[str, Any], context.get("marker") or {})
        repository = (
            self._optional_text(
                manual_approval.repository if manual_approval is not None else None
            )
            or self._optional_text(context.get("repository"))
            or _str_env("WHITEPAPER_DEFAULT_REPOSITORY", "proompteng/lab")
            or "proompteng/lab"
        )
        base_branch = (
            self._optional_text(
                manual_approval.base if manual_approval is not None else None
            )
            or self._optional_text(marker.get("base_branch"))
            or _str_env("WHITEPAPER_DEFAULT_BASE_BRANCH", "main")
            or "main"
        )
        head_branch = (
            self._optional_text(
                manual_approval.head if manual_approval is not None else None
            )
            or self._default_engineering_head_branch(
                run.run_id,
                suffix="manual" if manual_approval is not None else "auto",
            )
        )
        artifact_path = f"docs/whitepapers/{run.run_id}"
        issue_url = self._optional_text(context.get("issue_url")) or ""
        issue_title = self._optional_text((run.document.title if run.document else None)) or "Whitepaper analysis"
        prompt = self._build_engineering_trigger_prompt(
            run_id=run.run_id,
            repository=repository,
            issue_url=issue_url,
            issue_title=issue_title,
            implementation_grade=trigger.implementation_grade,
            rollout_profile=trigger.rollout_profile,
            artifact_path=artifact_path,
            approval_reason=manual_approval.approval_reason if manual_approval is not None else None,
        )
        idempotency_key = (
            f"{run.run_id}-engineering-"
            f"{'manual' if manual_approval is not None else 'auto'}"
        )
        policy_ref = trigger.policy_ref or "torghut-v5-high-confidence-trigger-v1"
        payload: dict[str, Any] = {
            "namespace": _str_env("WHITEPAPER_ENGINEERING_AGENTRUN_NAMESPACE", "agents"),
            "idempotencyKey": idempotency_key,
            "agentRef": {"name": _str_env("WHITEPAPER_ENGINEERING_AGENT_NAME", "codex-whitepaper-agent")},
            "runtime": {"type": "job"},
            "implementation": {
                "summary": f"Whitepaper engineering candidate {run.run_id}",
                "text": prompt,
                "source": {
                    "provider": "github",
                    "url": issue_url or f"https://github.com/{repository}",
                },
                "vcsRef": {"name": _str_env("WHITEPAPER_ENGINEERING_AGENTRUN_VCS_REF", "github")},
                "labels": ["whitepaper", "engineering-candidate", "torghut", "b1"],
            },
            "vcsRef": {"name": _str_env("WHITEPAPER_ENGINEERING_AGENTRUN_VCS_REF", "github")},
            "vcsPolicy": {"required": True, "mode": "read-write"},
            "parameters": {
                "runId": run.run_id,
                "hypothesisRef": trigger.hypothesis_id or run.run_id,
                "policyRef": policy_ref,
                "repository": repository,
                "base": base_branch,
                "head": head_branch,
                "artifactPath": artifact_path,
                "rolloutProfile": trigger.rollout_profile,
                "approvalToken": trigger.approval_token,
                "approvalSource": trigger.approval_source or "policy_auto",
                "implementationGrade": trigger.implementation_grade,
            },
            "policy": {
                "secretBindingRef": _str_env(
                    "WHITEPAPER_ENGINEERING_AGENTRUN_SECRET_BINDING",
                    "codex-whitepaper-github-token",
                )
            },
            "ttlSecondsAfterFinished": _int_env("WHITEPAPER_ENGINEERING_AGENTRUN_TTL_SECONDS", 7200),
        }
        if manual_approval is not None:
            payload["parameters"]["approvedBy"] = manual_approval.approved_by
            payload["parameters"]["approvalReason"] = manual_approval.approval_reason
            payload["parameters"]["targetScope"] = manual_approval.target_scope or ""

        response_payload = self._submit_jangar_agentrun(payload, idempotency_key=idempotency_key)
        resource = cast(dict[str, Any], response_payload.get("resource") or {})
        metadata = cast(dict[str, Any], resource.get("metadata") or {})
        status = cast(dict[str, Any], resource.get("status") or {})
        agentrun_name = str(metadata.get("name") or "").strip()
        agentrun_uid = str(metadata.get("uid") or "").strip() or None
        phase = str(status.get("phase") or "queued").strip().lower() or "queued"
        if not agentrun_name:
            raise RuntimeError("engineering_dispatch_missing_agentrun_name")

        step = WhitepaperAnalysisStep(
            analysis_run_id=run.id,
            step_name="engineering_dispatch",
            step_order=50,
            attempt=self._next_step_attempt(
                session,
                analysis_run_id=run.id,
                step_name="engineering_dispatch",
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
            agentrun_namespace=_str_env("WHITEPAPER_ENGINEERING_AGENTRUN_NAMESPACE", "agents"),
            agentrun_uid=agentrun_uid,
            status=phase,
            execution_mode="engineering_candidate",
            requested_by=manual_approval.approved_by if manual_approval is not None else "policy_auto",
            vcs_provider="github",
            vcs_repository=repository,
            vcs_base_branch=base_branch,
            vcs_head_branch=head_branch,
            workspace_context_json={
                "issue_url": issue_url,
                "artifact_path": artifact_path,
                "trigger_id": trigger.trigger_id,
                "approval_source": trigger.approval_source or "policy_auto",
            },
            prompt_text=prompt,
            prompt_hash=hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
            input_context_json={"request": payload},
            output_context_json=response_payload,
            started_at=datetime.now(timezone.utc),
        )
        session.add(agentrun_row)
        session.flush()
        return {
            "agentrun_name": agentrun_name,
            "agentrun_uid": agentrun_uid,
            "status": phase,
        }

    def _default_engineering_head_branch(self, run_id: str, *, suffix: str) -> str:
        return f"codex/whitepaper-b1-{run_id[-16:]}-{suffix}"

    def _build_engineering_trigger_payload(
        self,
        trigger: WhitepaperEngineeringTrigger,
        rollout_transitions: list[WhitepaperRolloutTransition],
    ) -> dict[str, Any]:
        transitions_payload = [
            {
                "transition_id": item.transition_id,
                "from_stage": item.from_stage,
                "to_stage": item.to_stage,
                "transition_type": item.transition_type,
                "status": item.status,
                "reason_codes": item.reason_codes_json or [],
                "blocking_gate": item.blocking_gate,
                "created_at": item.created_at.isoformat() if item.created_at else None,
            }
            for item in rollout_transitions
        ]
        return {
            "trigger_id": trigger.trigger_id,
            "run_id": trigger.whitepaper_run_id,
            "implementation_grade": trigger.implementation_grade,
            "decision": trigger.decision,
            "reason_codes": trigger.reason_codes_json or [],
            "approval_token": trigger.approval_token,
            "dispatched_agentrun_name": trigger.dispatched_agentrun_name,
            "rollout_profile": trigger.rollout_profile,
            "approval_source": trigger.approval_source,
            "approved_by": trigger.approved_by,
            "approved_at": trigger.approved_at.isoformat() if trigger.approved_at else None,
            "approval_reason": trigger.approval_reason,
            "policy_ref": trigger.policy_ref,
            "gate_snapshot_hash": trigger.gate_snapshot_hash,
            "rollout_transitions": transitions_payload,
        }

    def _build_engineering_trigger_prompt(
        self,
        *,
        run_id: str,
        repository: str,
        issue_url: str,
        issue_title: str,
        implementation_grade: str,
        rollout_profile: str,
        artifact_path: str,
        approval_reason: str | None,
    ) -> str:
        manual_line = (
            f"Manual approval rationale: {approval_reason}"
            if approval_reason
            else "Dispatch source: policy_auto"
        )
        return "\n".join(
            [
                f"Objective: Execute B1 engineering candidate implementation for whitepaper run {run_id}.",
                f"Repository: {repository}",
                f"Issue: {issue_url}",
                f"Issue title: {issue_title}",
                f"Implementation grade: {implementation_grade}",
                f"Rollout profile: {rollout_profile}",
                f"Artifact path: {artifact_path}",
                manual_line,
                "",
                "Constraints:",
                "1) Implement only B1 engineering candidate work (RFC/code/tests).",
                "2) Do not perform any production rollout or bypass deterministic promotion gates.",
                "3) Keep outputs reproducible with explicit evidence pointers and deterministic reason codes.",
                "4) Preserve fail-closed behavior when required artifacts are missing.",
            ]
        )

    @staticmethod
    def _compute_json_hash(payload: dict[str, Any] | None) -> str | None:
        if payload is None:
            return None
        encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()

    @staticmethod
    def _as_json_record(value: Any) -> dict[str, Any] | None:
        if not isinstance(value, Mapping):
            return None
        return cast(dict[str, Any], coerce_json_payload(dict(cast(Mapping[str, Any], value))))

    def _extract_gate_statuses(self, gate_snapshot: dict[str, Any] | None) -> dict[str, str]:
        if gate_snapshot is None:
            return {}
        statuses: dict[str, str] = {}

        gates_raw = gate_snapshot.get("gates")
        if isinstance(gates_raw, Mapping):
            for gate_id_raw, gate_payload in cast(Mapping[Any, Any], gates_raw).items():
                gate_id = _normalize_identifier(str(gate_id_raw))
                if gate_id.startswith("gate"):
                    gate_id = gate_id.replace("gate", "g", 1)
                status_value = None
                if isinstance(gate_payload, Mapping):
                    status_value = self._optional_text(cast(Mapping[str, Any], gate_payload).get("status"))
                else:
                    status_value = self._optional_text(gate_payload)
                if status_value:
                    statuses[gate_id] = _normalize_identifier(status_value)
        elif isinstance(gates_raw, list):
            for entry in gates_raw:
                if not isinstance(entry, Mapping):
                    continue
                gate_id_raw = (
                    self._optional_text(cast(Mapping[str, Any], entry).get("gate_id"))
                    or self._optional_text(cast(Mapping[str, Any], entry).get("id"))
                    or self._optional_text(cast(Mapping[str, Any], entry).get("name"))
                )
                status_value = self._optional_text(cast(Mapping[str, Any], entry).get("status"))
                if not gate_id_raw or not status_value:
                    continue
                gate_id = _normalize_identifier(gate_id_raw)
                if gate_id.startswith("gate"):
                    gate_id = gate_id.replace("gate", "g", 1)
                statuses[gate_id] = _normalize_identifier(status_value)

        for key, value in gate_snapshot.items():
            normalized_key = _normalize_identifier(str(key))
            if normalized_key in {"g1", "g2", "g3", "g4", "g5", "g6", "g7"}:
                normalized_status = self._optional_text(value)
                if normalized_status:
                    statuses[normalized_key] = _normalize_identifier(normalized_status)
        return statuses

    def _missing_gate_reason_codes(
        self,
        gate_statuses: dict[str, str],
        *,
        required: tuple[str, ...],
    ) -> list[str]:
        reasons: list[str] = []
        for gate_id in required:
            if gate_id not in gate_statuses:
                reasons.append(f"{gate_id}_status_missing")
        return reasons

    def _gating_blocking_reason_codes(
        self,
        gate_snapshot: dict[str, Any] | None,
        gate_statuses: dict[str, str],
    ) -> list[str]:
        if gate_snapshot is None:
            return []
        reasons: list[str] = []

        blocked_flag = bool(gate_snapshot.get("blocked") or gate_snapshot.get("blocking"))
        if blocked_flag:
            reasons.append("gating_blocked_flag_true")

        blocking_lists = (
            gate_snapshot.get("blocking_reasons"),
            gate_snapshot.get("blockingReasons"),
            gate_snapshot.get("blockers"),
            gate_snapshot.get("blocking_reason_codes"),
        )
        for raw_list in blocking_lists:
            if isinstance(raw_list, list):
                for item in raw_list:
                    text = self._optional_text(item)
                    if text:
                        reasons.append(f"gating_blocker_{_normalize_identifier(text)}")

        for gate_id, status in gate_statuses.items():
            if status not in _PASS_GATE_STATUSES:
                reasons.append(f"{gate_id}_status_{status}")
        return _sorted_unique(reasons)

    def _required_gate_failures(
        self,
        gate_statuses: dict[str, str],
        *,
        required: tuple[str, ...],
    ) -> list[str]:
        failures: list[str] = []
        for gate_id in required:
            status = gate_statuses.get(gate_id)
            if status is None:
                failures.append(f"{gate_id}_status_missing")
                continue
            if status not in _PASS_GATE_STATUSES:
                failures.append(f"{gate_id}_status_{status}")
        return _sorted_unique(failures)

    @staticmethod
    def _first_blocking_gate_id(reason_codes: list[str]) -> str | None:
        for reason in reason_codes:
            if reason.startswith("g") and "_status_" in reason:
                return reason.split("_status_", 1)[0]
        return None

    @staticmethod
    def _rollback_target_stage(stage: str) -> str:
        if stage == "scaled_live":
            return "constrained_live"
        if stage == "constrained_live":
            return "shadow"
        return "paper"

    def _manual_approval_allowed(self, rollout_profile: str) -> bool:
        if not _bool_env("WHITEPAPER_ENGINEERING_MANUAL_OVERRIDE_ENABLED", default=True):
            return False
        allowed_profiles_raw = (
            _str_env("WHITEPAPER_ENGINEERING_MANUAL_ALLOWED_PROFILES", "manual,assisted,automatic")
            or "manual,assisted,automatic"
        )
        allowed_profiles = {
            self._normalize_rollout_profile(item)
            for item in allowed_profiles_raw.split(",")
            if item.strip()
        }
        return rollout_profile in allowed_profiles

    def _normalize_rollout_profile(self, value: str | None) -> str:
        profile = self._optional_text(value) or "manual"
        normalized = _normalize_identifier(profile)
        if normalized not in {"manual", "assisted", "automatic"}:
            return "manual"
        return normalized

    def _derive_hypothesis_id(self, run: WhitepaperAnalysisRun) -> str | None:
        synthesis_payload = run.synthesis.synthesis_json if run.synthesis is not None else None
        if isinstance(synthesis_payload, Mapping):
            explicit = self._optional_text(cast(Mapping[str, Any], synthesis_payload).get("hypothesis_id"))
            if explicit:
                return explicit
        return f"hyp-{run.run_id}"

    def _upsert_synthesis(
        self,
        session: Session,
        run: WhitepaperAnalysisRun,
        synthesis_payload_raw: Any,
    ) -> None:
        if not isinstance(synthesis_payload_raw, Mapping):
            return
        synthesis_payload = dict(cast(Mapping[str, Any], synthesis_payload_raw))
        self._populate_missing_implementation_plan_md(run.run_id, synthesis_payload)
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

    def _populate_missing_implementation_plan_md(self, run_id: str, synthesis_payload: dict[str, Any]) -> None:
        if self._optional_text(synthesis_payload.get("implementation_plan_md")):
            return
        derived_value = self._derive_implementation_plan_md(synthesis_payload.get("implementation_implications"))
        if not derived_value:
            return
        synthesis_payload["implementation_plan_md"] = derived_value
        logger.warning(
            "Whitepaper synthesis missing implementation_plan_md; auto-filled from implementation_implications "
            "(run_id=%s)",
            run_id,
        )

    @staticmethod
    def _derive_implementation_plan_md(value: Any) -> str | None:
        if isinstance(value, str):
            text = value.strip()
            return text or None
        if isinstance(value, list):
            bullet_points: list[str] = []
            for item in value:
                text = str(item).strip() if item is not None else ""
                if text:
                    bullet_points.append(f"- {text}")
            return "\n".join(bullet_points) if bullet_points else None
        return None

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
        gating_payload = self._build_verdict_gating_payload(verdict_payload)

        if verdict is None:
            verdict = WhitepaperViabilityVerdict(
                analysis_run_id=run.id,
                verdict=verdict_text,
                score=self._optional_decimal(verdict_payload.get("score")),
                confidence=self._optional_decimal(verdict_payload.get("confidence")),
                decision_policy=self._optional_text(verdict_payload.get("decision_policy")),
                gating_json=self._optional_json(gating_payload),
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
        verdict.gating_json = self._optional_json(gating_payload)
        verdict.rationale = self._optional_text(verdict_payload.get("rationale"))
        verdict.rejection_reasons_json = self._optional_json(verdict_payload.get("rejection_reasons"))
        verdict.recommendations_json = self._optional_json(verdict_payload.get("recommendations"))
        verdict.requires_followup = bool(verdict_payload.get("requires_followup"))
        verdict.approved_by = approved_by
        verdict.approved_at = datetime.now(timezone.utc) if approved_by else verdict.approved_at
        session.add(verdict)

    @staticmethod
    def _build_verdict_gating_payload(verdict_payload: Mapping[str, Any]) -> Any:
        base_gating = (
            verdict_payload.get("gating_json")
            if "gating_json" in verdict_payload
            else verdict_payload.get("gating")
        )
        dspy_eval_report = verdict_payload.get("dspy_eval_report")
        if not isinstance(dspy_eval_report, Mapping):
            return base_gating
        dspy_payload = coerce_json_payload(cast(dict[str, Any], dspy_eval_report))
        if isinstance(base_gating, Mapping):
            merged = dict(cast(dict[str, Any], base_gating))
            merged["dspy_eval_report"] = dspy_payload
            return merged
        if base_gating is None:
            return {"dspy_eval_report": dspy_payload}
        return {
            "gating": coerce_json_payload(base_gating),
            "dspy_eval_report": dspy_payload,
        }

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
        subject: str | None,
        tags: list[str],
        analysis_mode: str,
    ) -> str:
        normalized_mode = normalize_analysis_mode(analysis_mode)
        subject_line = f"Subject: {subject}" if subject else "Subject: not specified"
        tags_line = f"Tags: {', '.join(tags)}" if tags else "Tags: none"

        mode_specific_requirements = [
            "4) Create/update a design document in this repository under docs/whitepapers/<run-id>/design.md.",
            "5) Open a PR from a codex/* branch into main with a production-ready design document.",
            "6) Emit machine-readable outputs exactly as synthesis.json and verdict.json in your run artifacts.",
        ]
        if normalized_mode == "analysis_only":
            mode_specific_requirements = [
                "4) Do not open a PR in analysis-only mode.",
                "5) Keep outputs machine-readable exactly as synthesis.json and verdict.json in your run artifacts.",
                "6) Include explicit 'implementation candidates' and 'blocked_by' sections inside synthesis output.",
            ]

        return "\n".join(
            [
                f"Objective: Analyze whitepaper run {run_id} and deliver high-signal conclusions.",
                f"Repository: {repository}",
                f"Issue: {issue_url}",
                f"Issue title: {issue_title}",
                f"Primary PDF URL: {attachment_url}",
                f"Ceph object URI: {ceph_uri}",
                f"Analysis mode: {normalized_mode}",
                subject_line,
                tags_line,
                "",
                "Requirements:",
                "1) Read the full whitepaper end-to-end (no abstract-only shortcuts).",
                "2) Produce synthesis.json with required keys: executive_summary, problem_statement, methodology_summary, key_findings, novelty_claims, risk_assessment, citations, implementation_plan_md, confidence.",
                "3) Produce a viability verdict with score, confidence, rejection reasons (if any), and follow-up recommendations.",
                *mode_specific_requirements,
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
    "whitepaper_inngest_enabled",
    "whitepaper_kafka_enabled",
    "whitepaper_semantic_indexing_enabled",
    "whitepaper_workflow_enabled",
]
