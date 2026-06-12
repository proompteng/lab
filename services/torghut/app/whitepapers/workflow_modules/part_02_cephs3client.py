# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
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

# ruff: noqa: F401,F403,F405,F811,F821

from .part_01_statements_54 import *


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


class _WhitepaperWorkflowServiceFieldsPart1:
    """State transitions and persistence for whitepaper analysis workflow."""


__all__ = [name for name in globals() if not name.startswith("__")]
