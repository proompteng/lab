"""Whitepaper workflow ingestion, orchestration, and persistence helpers."""

from __future__ import annotations

import hashlib
import hmac
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Mapping, Protocol
from urllib.parse import quote, urlparse

from sqlalchemy.orm import Session

from ...models import (
    WhitepaperAnalysisRun,
    WhitepaperEngineeringTrigger,
    WhitepaperRolloutTransition,
)

from .shared_context import (
    GithubIssueEvent,
    ManualApprovalPayload,
    WHITEPAPER_CEPH_DEFAULT_CONFIG_DIR as _WHITEPAPER_CEPH_DEFAULT_CONFIG_DIR,
    WHITEPAPER_CEPH_DEFAULT_SECRET_DIR as _WHITEPAPER_CEPH_DEFAULT_SECRET_DIR,
    bool_env as _bool_env,
    http_request_bytes as _http_request_bytes,
    int_env as _int_env,
    mounted_or_env_value as _mounted_or_env_value,
    str_env as _str_env,
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
        access_key = _mounted_or_env_value(
            env_name="WHITEPAPER_CEPH_ACCESS_KEY",
            mounted_key="AWS_ACCESS_KEY_ID",
            dir_env_name="WHITEPAPER_CEPH_SECRET_DIR",
            default_dir=_WHITEPAPER_CEPH_DEFAULT_SECRET_DIR,
            fallback_env_names=("AWS_ACCESS_KEY_ID",),
        )
        secret_key = _mounted_or_env_value(
            env_name="WHITEPAPER_CEPH_SECRET_KEY",
            mounted_key="AWS_SECRET_ACCESS_KEY",
            dir_env_name="WHITEPAPER_CEPH_SECRET_DIR",
            default_dir=_WHITEPAPER_CEPH_DEFAULT_SECRET_DIR,
            fallback_env_names=("AWS_SECRET_ACCESS_KEY",),
        )
        region = _str_env("WHITEPAPER_CEPH_REGION", "us-east-1") or "us-east-1"

        if endpoint is None:
            bucket_host = _mounted_or_env_value(
                env_name="WHITEPAPER_CEPH_BUCKET_HOST",
                mounted_key="BUCKET_HOST",
                dir_env_name="WHITEPAPER_CEPH_CONFIG_DIR",
                default_dir=_WHITEPAPER_CEPH_DEFAULT_CONFIG_DIR,
                fallback_env_names=("BUCKET_HOST",),
            )
            bucket_port = _mounted_or_env_value(
                env_name="WHITEPAPER_CEPH_BUCKET_PORT",
                mounted_key="BUCKET_PORT",
                dir_env_name="WHITEPAPER_CEPH_CONFIG_DIR",
                default_dir=_WHITEPAPER_CEPH_DEFAULT_CONFIG_DIR,
                fallback_env_names=("BUCKET_PORT",),
            )
            if bucket_host:
                scheme = (
                    "https" if _bool_env("WHITEPAPER_CEPH_USE_TLS", False) else "http"
                )
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
            f"host:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n"
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
        signature = hmac.new(
            signing_key, string_to_sign.encode("utf-8"), hashlib.sha256
        ).hexdigest()
        authorization = (
            f"{algorithm} "
            f"Credential={self.access_key}/{credential_scope}, "
            f"SignedHeaders={signed_headers}, "
            f"Signature={signature}"
        )

        url = f"{self.endpoint}{canonical_uri}"
        status, response_headers, _ = _http_request_bytes(
            url,
            method="PUT",
            headers={
                "Host": host,
                "Content-Type": content_type,
                "Authorization": authorization,
                "x-amz-date": amz_date,
                "x-amz-content-sha256": payload_hash,
            },
            body=body,
            timeout_seconds=self.timeout_seconds,
        )
        if status < 200 or status >= 300:
            raise RuntimeError(f"ceph_upload_http_{status}")
        etag = str(response_headers.get("ETag") or "").strip().strip('"') or None

        return {
            "bucket": bucket,
            "key": key,
            "etag": etag,
            "size_bytes": len(body),
            "sha256": payload_hash,
            "uri": f"s3://{bucket}/{key}",
        }

    def get_object(
        self,
        *,
        bucket: str,
        key: str,
    ) -> bytes:
        now = datetime.now(timezone.utc)
        amz_date = now.strftime("%Y%m%dT%H%M%SZ")
        datestamp = now.strftime("%Y%m%d")

        parsed = urlparse(self.endpoint)
        if not parsed.scheme or not parsed.netloc:
            raise RuntimeError("invalid_ceph_endpoint")

        canonical_uri = f"/{quote(bucket, safe='')}/{quote(key, safe='/-_.~')}"
        payload_hash = hashlib.sha256(b"").hexdigest()
        host = parsed.netloc

        canonical_headers = (
            f"host:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n"
        )
        signed_headers = "host;x-amz-content-sha256;x-amz-date"
        canonical_request = "\n".join(
            [
                "GET",
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
        signature = hmac.new(
            signing_key, string_to_sign.encode("utf-8"), hashlib.sha256
        ).hexdigest()
        authorization = (
            f"{algorithm} "
            f"Credential={self.access_key}/{credential_scope}, "
            f"SignedHeaders={signed_headers}, "
            f"Signature={signature}"
        )

        url = f"{self.endpoint}{canonical_uri}"
        status, _response_headers, payload = _http_request_bytes(
            url,
            method="GET",
            headers={
                "Host": host,
                "Authorization": authorization,
                "x-amz-date": amz_date,
                "x-amz-content-sha256": payload_hash,
            },
            timeout_seconds=self.timeout_seconds,
        )
        if status < 200 or status >= 300:
            raise RuntimeError(f"ceph_download_http_{status}")
        return payload

    def _signing_key(self, datestamp: str) -> bytes:
        date_key = hmac.new(
            ("AWS4" + self.secret_key).encode("utf-8"),
            datestamp.encode("utf-8"),
            hashlib.sha256,
        )
        region_key = hmac.new(
            date_key.digest(), self.region.encode("utf-8"), hashlib.sha256
        )
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
class IssueRunIdentity:
    run_id: str
    retry_of_run_id: str | None
    marker_hash: str


@dataclass(frozen=True)
class PdfStorageOutcome:
    ceph_bucket: str
    ceph_key: str
    checksum: str
    ceph_etag: str | None
    file_size: int | None
    parse_status: str
    parse_error: str | None


class WhitepaperWorkflowServiceFields:
    """State transitions and persistence for whitepaper analysis workflow."""

    ceph_client: Any | None
    inngest_client: Any | None


class WhitepaperWorkflowServiceContract(Protocol):
    ceph_client: Any | None
    inngest_client: Any | None

    def _structured_output_list(
        self, payload: Mapping[str, Any], *, key: str
    ) -> list[dict[str, Any]]: ...

    def _build_chunks(
        self, text_content: str, *, source_scope: str
    ) -> list[dict[str, Any]]: ...

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
    ) -> str: ...

    @staticmethod
    def _coerce_string_list(value: Any) -> list[str]: ...

    def _coerce_tag_list(self, value: Any) -> list[str]: ...

    def _complete_run(
        self,
        session: Session,
        run: WhitepaperAnalysisRun,
        payload: Mapping[str, Any],
    ) -> None: ...

    @staticmethod
    def _download_pdf(url: str) -> bytes: ...

    def _enqueue_finalized_inngest_event(
        self,
        session: Session,
        *,
        run: WhitepaperAnalysisRun,
    ) -> bool: ...

    def _enqueue_requested_inngest_event(
        self,
        session: Session,
        *,
        run_row: WhitepaperAnalysisRun,
    ) -> bool: ...

    def _evaluate_and_process_engineering_trigger(
        self,
        session: Session,
        run: WhitepaperAnalysisRun,
        *,
        manual_approval: ManualApprovalPayload | None,
    ) -> dict[str, Any]: ...

    def _extract_pdf_text(self, pdf_bytes: bytes) -> dict[str, Any]: ...

    def _ingest_artifacts(
        self,
        session: Session,
        run: WhitepaperAnalysisRun,
        artifact_payload_raw: Any,
    ) -> None: ...

    @staticmethod
    def _is_retryable_agentrun_status(status: str | None) -> bool: ...

    def _next_step_attempt(
        self,
        session: Session,
        *,
        analysis_run_id: Any,
        step_name: str,
    ) -> int: ...

    def _persist_semantic_chunks_and_embeddings(
        self,
        session: Session,
        *,
        run: WhitepaperAnalysisRun,
        source_scope: str,
        chunks: list[dict[str, Any]],
    ) -> dict[str, Any]: ...

    def _submit_agents_agentrun(
        self,
        payload: Mapping[str, Any],
        *,
        idempotency_key: str,
    ) -> dict[str, Any]: ...

    def _sync_structured_research_outputs(
        self,
        session: Session,
        run: WhitepaperAnalysisRun,
        payload: Mapping[str, Any],
    ) -> None: ...

    def _upsert_design_pull_requests(
        self,
        session: Session,
        run: WhitepaperAnalysisRun,
        pr_payload_raw: Any,
    ) -> None: ...

    def _upsert_steps(
        self,
        session: Session,
        run: WhitepaperAnalysisRun,
        steps_raw: Any,
    ) -> None: ...

    def _upsert_synthesis(
        self,
        session: Session,
        run: WhitepaperAnalysisRun,
        synthesis_payload_raw: Any,
    ) -> None: ...

    def _upsert_verdict(
        self,
        session: Session,
        run: WhitepaperAnalysisRun,
        verdict_payload_raw: Any,
    ) -> None: ...

    def _upsert_whitepaper_content(
        self,
        session: Session,
        *,
        run: WhitepaperAnalysisRun,
        full_text: str,
        extraction_meta: Mapping[str, Any] | None,
    ) -> None: ...

    @staticmethod
    def _build_search_snippet(content: str, query: str) -> str: ...

    def _embed_texts(self, texts: list[str]) -> tuple[str, int, list[list[float]]]: ...

    @staticmethod
    def _vector_to_text(values: list[float]) -> str: ...

    @staticmethod
    def _as_json_record(value: Any) -> dict[str, Any] | None: ...

    def _build_engineering_trigger_payload(
        self,
        trigger: WhitepaperEngineeringTrigger,
        rollout_transitions: list[WhitepaperRolloutTransition],
    ) -> dict[str, Any]: ...

    @staticmethod
    def _compute_json_hash(payload: dict[str, Any] | None) -> str | None: ...

    def _derive_hypothesis_id(self, run: WhitepaperAnalysisRun) -> str | None: ...

    def _dispatch_engineering_agentrun(
        self,
        session: Session,
        *,
        run: WhitepaperAnalysisRun,
        trigger: WhitepaperEngineeringTrigger,
        manual_approval: ManualApprovalPayload | None,
    ) -> dict[str, Any]: ...

    def _extract_gate_statuses(
        self, gate_snapshot: dict[str, Any] | None
    ) -> dict[str, str]: ...

    @staticmethod
    def _first_blocking_gate_id(reason_codes: list[str]) -> str | None: ...

    def _gating_blocking_reason_codes(
        self,
        gate_snapshot: dict[str, Any] | None,
        gate_statuses: dict[str, str],
    ) -> list[str]: ...

    def _manual_approval_allowed(self, rollout_profile: str) -> bool: ...

    def _missing_gate_reason_codes(
        self,
        gate_statuses: dict[str, str],
        *,
        required: tuple[str, ...],
    ) -> list[str]: ...

    def _normalize_rollout_profile(self, value: str | None) -> str: ...

    def _required_gate_failures(
        self,
        gate_statuses: dict[str, str],
        *,
        required: tuple[str, ...],
    ) -> list[str]: ...

    @staticmethod
    def _rollback_target_stage(stage: str) -> str: ...

    def _requeue_existing_run(
        self,
        session: Session,
        *,
        run: WhitepaperAnalysisRun,
        issue_event: GithubIssueEvent,
        attachment_url: str,
        marker: Mapping[str, Any],
        source: str,
    ) -> IssueKickoffResult: ...

    def dispatch_codex_agentrun(
        self,
        session: Session,
        run_id: str,
        *,
        force: bool = False,
        allow_retry: bool = False,
    ) -> dict[str, Any]: ...


__all__ = (
    "CephS3Client",
    "IssueKickoffResult",
    "WhitepaperWorkflowServiceContract",
)
