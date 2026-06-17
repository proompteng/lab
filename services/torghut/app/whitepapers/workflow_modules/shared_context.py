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
import sys
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


logger = logging.getLogger(__name__)

_WHITEPAPER_CEPH_DEFAULT_CONFIG_DIR = "/etc/torghut/whitepapers-config"

_WHITEPAPER_CEPH_DEFAULT_SECRET_DIR = "/etc/torghut/whitepapers-secret"


def _read_text_file(path: str | None) -> str | None:
    if path is None:
        return None
    normalized = path.strip()
    if not normalized:
        return None
    try:
        with open(normalized, encoding="utf-8") as handle:
            payload = handle.read().strip()
    except OSError:
        return None
    return payload or None


def _mounted_or_env_value(
    *,
    env_name: str,
    mounted_key: str,
    dir_env_name: str,
    default_dir: str,
    fallback_env_names: tuple[str, ...] = (),
) -> str | None:
    mounted_dir = _str_env(dir_env_name, default_dir) or default_dir
    mounted_value = _read_text_file(os.path.join(mounted_dir, mounted_key))
    if mounted_value is not None:
        return mounted_value

    direct_value = _str_env(env_name)
    if direct_value is not None:
        return direct_value

    for fallback_name in fallback_env_names:
        fallback_value = _str_env(fallback_name)
        if fallback_value is not None:
            return fallback_value
    return None


def _whitepaper_ceph_bucket_name() -> str:
    return (
        _mounted_or_env_value(
            env_name="WHITEPAPER_CEPH_BUCKET",
            mounted_key="BUCKET_NAME",
            dir_env_name="WHITEPAPER_CEPH_CONFIG_DIR",
            default_dir=_WHITEPAPER_CEPH_DEFAULT_CONFIG_DIR,
            fallback_env_names=("BUCKET_NAME",),
        )
        or "torghut-whitepapers"
    )


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
    root_http_request_bytes = _whitepaper_root_export("_http_request_bytes", None)
    if (
        root_http_request_bytes is not None
        and root_http_request_bytes is not _http_request_bytes
    ):
        return root_http_request_bytes(
            url,
            method=method,
            headers=headers,
            body=body,
            timeout_seconds=timeout_seconds,
            max_response_bytes=max_response_bytes,
            follow_redirects=follow_redirects,
            max_redirects=max_redirects,
        )

    current_url = url
    current_method = method
    current_body = body
    request_headers = dict(headers or {})
    redirect_statuses = {301, 302, 303, 307, 308}
    max_allowed_redirects = max(max_redirects, 0)

    for redirect_index in range(max_allowed_redirects + 1):
        parsed = urlparse(current_url)
        scheme = parsed.scheme.lower()
        if scheme not in {"http", "https"}:
            raise RuntimeError(f"unsupported_url_scheme:{scheme or 'missing'}")
        if not parsed.hostname:
            raise RuntimeError("invalid_url_host")

        path = parsed.path or "/"
        if parsed.query:
            path = f"{path}?{parsed.query}"
        connection_class = HTTPSConnection if scheme == "https" else HTTPConnection
        connection = connection_class(
            parsed.hostname, parsed.port, timeout=max(timeout_seconds, 1)
        )
        try:
            connection.request(
                current_method, path, body=current_body, headers=request_headers
            )
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

        location = response_headers.get("Location") or response_headers.get("location")
        if not location:
            return status_code, response_headers, payload
        if redirect_index >= max_allowed_redirects:
            raise RuntimeError("http_redirect_limit_exceeded")

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
            request_headers.pop("Authorization", None)
            request_headers.pop("authorization", None)
            request_headers.pop("Cookie", None)
            request_headers.pop("cookie", None)

        if status_code == 303 or (
            status_code in {301, 302} and current_method.upper() not in {"GET", "HEAD"}
        ):
            current_method = "GET"
            current_body = None

        current_url = next_url

    raise RuntimeError("http_redirect_processing_failed")


_GITHUB_ISSUE_ACTIONS = {"opened", "edited", "reopened", "labeled"}

_GITHUB_ISSUE_COMMENT_ACTIONS = {"created", "edited"}

_RETRYABLE_AGENTRUN_STATUSES = {
    "failed",
    "error",
    "cancelled",
    "canceled",
    "timeout",
    "timed_out",
}

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


def _whitepaper_root_export(name: str, fallback: Any) -> Any:
    root_module = sys.modules.get("app.whitepapers.workflow")
    if root_module is None:
        return fallback
    return getattr(root_module, name, fallback)


def _whitepaper_root_flag(name: str, env_name: str, *, default: bool) -> bool:
    root_value = _whitepaper_root_export(name, None)
    if root_value is not None and root_value is not globals().get(name):
        return bool(root_value())
    return _bool_env(env_name, default=default)


def whitepaper_workflow_enabled() -> bool:
    return _whitepaper_root_flag(
        "whitepaper_workflow_enabled",
        "WHITEPAPER_WORKFLOW_ENABLED",
        default=False,
    )


def whitepaper_inngest_enabled() -> bool:
    return _whitepaper_root_flag(
        "whitepaper_inngest_enabled",
        "WHITEPAPER_INNGEST_ENABLED",
        default=False,
    )


def whitepaper_kafka_enabled() -> bool:
    return _whitepaper_root_flag(
        "whitepaper_kafka_enabled",
        "WHITEPAPER_KAFKA_ENABLED",
        default=False,
    )


def whitepaper_semantic_indexing_enabled() -> bool:
    return _bool_env("WHITEPAPER_SEMANTIC_INDEXING_ENABLED", default=False)


def whitepaper_semantic_required() -> bool:
    return _bool_env("WHITEPAPER_SEMANTIC_REQUIRED", default=False)


def whitepaper_requeue_comment_keyword() -> str:
    return (
        _str_env("WHITEPAPER_REQUEUE_COMMENT_KEYWORD", "research whitepaper")
        or "research whitepaper"
    )


def marker_start() -> str:
    return (
        _str_env("WHITEPAPER_ISSUE_MARKER_START", "<!-- TORGHUT_WHITEPAPER:START -->")
        or ""
    )


def marker_end() -> str:
    return (
        _str_env("WHITEPAPER_ISSUE_MARKER_END", "<!-- TORGHUT_WHITEPAPER:END -->") or ""
    )


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


def github_issue_number_from_url(issue_url: str, repository: str) -> int | None:
    trimmed_url = issue_url.strip()
    trimmed_repository = repository.strip().strip("/")
    if not trimmed_url or not trimmed_repository:
        return None
    match = re.match(
        rf"^https://github\.com/{re.escape(trimmed_repository)}/issues/(\d+)(?:[/?#].*)?$",
        trimmed_url,
        flags=re.IGNORECASE,
    )
    if not match:
        return None
    try:
        number = int(match.group(1))
    except ValueError:
        return None
    return number if number > 0 else None


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


def _extract_github_event_metadata(
    envelope: Mapping[str, Any],
) -> tuple[str | None, str | None]:
    headers_raw = envelope.get("headers")
    if not isinstance(headers_raw, Mapping):
        return None, None
    headers = cast(dict[str, Any], headers_raw)
    event_name = (
        str(
            headers.get("x-github-event")
            or headers.get("X-GitHub-Event")
            or headers.get("github_event")
            or ""
        ).strip()
        or None
    )
    delivery_id = (
        str(
            headers.get("x-github-delivery")
            or headers.get("X-GitHub-Delivery")
            or headers.get("github_delivery")
            or ""
        ).strip()
        or None
    )
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
        event_name = (
            str(envelope.get("event") or envelope.get("event_name") or "").strip()
            or None
        )

    github_payload = _extract_github_issue_payload(envelope)
    if not event_name:
        if (
            "comment" in github_payload
            and "issue" in github_payload
            and "repository" in github_payload
        ):
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
    issue_url = str(
        issue_payload.get("html_url") or issue_payload.get("url") or ""
    ).strip()
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


__all__ = (
    "logger",
    "EngineeringGradeDecision",
    "ManualApprovalPayload",
    "GithubIssueEvent",
    "whitepaper_workflow_enabled",
    "whitepaper_inngest_enabled",
    "whitepaper_kafka_enabled",
    "whitepaper_semantic_indexing_enabled",
    "whitepaper_semantic_required",
    "whitepaper_requeue_comment_keyword",
    "marker_start",
    "marker_end",
    "parse_marker_block",
    "normalize_analysis_mode",
    "parse_marker_tags",
    "normalize_attachment_url",
    "github_issue_number_from_url",
    "build_whitepaper_run_id",
    "comment_requests_requeue",
    "extract_pdf_urls",
    "normalize_github_issue_event",
)

# Public aliases used by split modules.
bool_env = _bool_env
coerce_issue_number = _coerce_issue_number
ELIGIBLE_AUTO_VERDICTS = _ELIGIBLE_AUTO_VERDICTS
extract_github_event_metadata = _extract_github_event_metadata
extract_github_issue_payload = _extract_github_issue_payload
extract_sender_login = _extract_sender_login
float_env = _float_env
GITHUB_ISSUE_ACTIONS = _GITHUB_ISSUE_ACTIONS
GITHUB_ISSUE_COMMENT_ACTIONS = _GITHUB_ISSUE_COMMENT_ACTIONS
http_request_bytes = _http_request_bytes
int_env = _int_env
MAX_SEMANTIC_RELEVANT_DISTANCE = _MAX_SEMANTIC_RELEVANT_DISTANCE
mounted_or_env_value = _mounted_or_env_value
normalize_identifier = _normalize_identifier
PASS_GATE_STATUSES = _PASS_GATE_STATUSES
read_text_file = _read_text_file
REJECT_VERDICTS = _REJECT_VERDICTS
RETRYABLE_AGENTRUN_STATUSES = _RETRYABLE_AGENTRUN_STATUSES
SEMANTIC_RELATIVE_DISTANCE_WINDOW = _SEMANTIC_RELATIVE_DISTANCE_WINDOW
sorted_unique = _sorted_unique
str_env = _str_env
whitepaper_ceph_bucket_name = _whitepaper_ceph_bucket_name
WHITEPAPER_CEPH_DEFAULT_CONFIG_DIR = _WHITEPAPER_CEPH_DEFAULT_CONFIG_DIR
WHITEPAPER_CEPH_DEFAULT_SECRET_DIR = _WHITEPAPER_CEPH_DEFAULT_SECRET_DIR
