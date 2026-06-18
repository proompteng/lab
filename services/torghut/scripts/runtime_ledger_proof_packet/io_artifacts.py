"""JSON loading and durable artifact upload helpers for proof packet assembly."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from collections.abc import Mapping
from pathlib import Path
from typing import Any, cast
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import urlopen

from scripts.runtime_ledger_proof_packet.common import (
    ARTIFACT_SCHEMA_VERSION,
    COMPLETION_DOC29_ENDPOINT,
    DOC29_LIVE_SCALE_GATE,
    PAPER_ROUTE_EVIDENCE_ENDPOINT,
    STATUS_ENDPOINT,
    _ObjectStoreClient,
    _mapping,
    _text,
    _utc_now,
)


def _load_json_object(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        raise ValueError(f"json_object_required:{path}")
    return {str(key): value for key, value in cast(Mapping[str, Any], payload).items()}


def _urlopen(url: str, *, timeout_seconds: float) -> Any:
    return urlopen(url, timeout=timeout_seconds)


def _load_json_url(url: str, *, timeout_seconds: float) -> dict[str, Any]:
    try:
        with _urlopen(url, timeout_seconds=timeout_seconds) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        body = exc.read()
        if body:
            try:
                payload = json.loads(body.decode("utf-8"))
            except json.JSONDecodeError:
                raise exc from None
            if isinstance(payload, Mapping):
                result = {
                    str(key): value
                    for key, value in cast(Mapping[str, Any], payload).items()
                }
                result["source_load"] = {
                    "source_url": url,
                    "http_status": exc.code,
                    "http_reason": str(exc.reason),
                    "http_error": True,
                }
                return result
        raise
    if not isinstance(payload, Mapping):
        raise ValueError(f"json_object_required:{url}")
    return {str(key): value for key, value in cast(Mapping[str, Any], payload).items()}


def _source_fetch_error_payload(
    *,
    source_name: str,
    url: str,
    error: BaseException,
) -> dict[str, Any]:
    blocker = f"{source_name}_fetch_failed"
    http_status = getattr(error, "code", None)
    reason = getattr(error, "reason", None)
    error_payload: dict[str, Any] = {
        "source_url": url,
        "blocker": blocker,
        "error_type": type(error).__name__,
        "error": str(error),
    }
    if http_status is not None:
        error_payload["http_status"] = http_status
    if reason is not None:
        error_payload["http_reason"] = str(reason)
    return {
        "schema_version": f"torghut.{source_name}.unavailable.v1",
        "status": "unavailable",
        "summary": {
            "status": "unavailable",
            "blockers": [blocker],
        },
        "runtime_window_import_audit": {
            "state": blocker,
            "next_action": f"retry_{source_name}_fetch",
            "import_ready": False,
            "blockers": [blocker],
            "target_blockers": [blocker],
            "counts": {},
        },
        "gates": [
            {
                "gate_id": DOC29_LIVE_SCALE_GATE,
                "status": "blocked",
                "blocking_reasons": [blocker],
                "blocked_reason": blocker,
            }
        ],
        "source_load_error": error_payload,
    }


def _ceph_client_from_env() -> tuple[_ObjectStoreClient | None, str]:
    endpoint = os.getenv("TORGHUT_EMPIRICAL_CEPH_ENDPOINT", "").strip()
    bucket_host = os.getenv("TORGHUT_EMPIRICAL_CEPH_BUCKET_HOST", "").strip()
    bucket_port = os.getenv("TORGHUT_EMPIRICAL_CEPH_BUCKET_PORT", "").strip()
    access_key = (
        os.getenv("TORGHUT_EMPIRICAL_CEPH_ACCESS_KEY", "").strip()
        or os.getenv(
            "AWS_ACCESS_KEY_ID",
            "",
        ).strip()
    )
    secret_key = (
        os.getenv(
            "TORGHUT_EMPIRICAL_CEPH_SECRET_KEY",
            "",
        ).strip()
        or os.getenv(
            "AWS_SECRET_ACCESS_KEY",
            "",
        ).strip()
    )
    bucket = (
        os.getenv("TORGHUT_EMPIRICAL_CEPH_BUCKET", "").strip()
        or os.getenv(
            "BUCKET_NAME",
            "",
        ).strip()
        or "torghut-empirical-artifacts"
    )
    if not endpoint and bucket_host:
        scheme = (
            "https"
            if os.getenv("TORGHUT_EMPIRICAL_CEPH_USE_TLS", "").strip() == "true"
            else "http"
        )
        endpoint = f"{scheme}://{bucket_host}"
        if bucket_port:
            endpoint = f"{endpoint}:{bucket_port}"
    if not endpoint or not access_key or not secret_key:
        return None, bucket
    from app.whitepapers.workflow import CephS3Client

    return (
        CephS3Client(
            endpoint=endpoint,
            access_key=access_key,
            secret_key=secret_key,
            region=os.getenv("TORGHUT_EMPIRICAL_CEPH_REGION", "us-east-1").strip()
            or "us-east-1",
            timeout_seconds=max(
                int(os.getenv("TORGHUT_EMPIRICAL_CEPH_TIMEOUT_SECONDS", "20") or "20"),
                1,
            ),
        ),
        bucket,
    )


def _resolve_ceph_client_from_env() -> tuple[_ObjectStoreClient | None, str]:
    return _ceph_client_from_env()


def _safe_artifact_path_part(value: object, *, default: str) -> str:
    text = _text(value, default)
    cleaned = "".join(
        char if char.isalnum() or char in {"-", "_", "."} else "-" for char in text
    ).strip("-._")
    return cleaned or default


def _runtime_window_import_run_id(raw_payload: Mapping[str, Any] | None) -> str:
    payload = _mapping(raw_payload)
    candidates = [
        payload.get("run_id"),
        _mapping(payload.get("runtime_window_import")).get("run_id"),
        _mapping(payload.get("runtime_window_import")).get(
            "runtime_window_import_run_id"
        ),
    ]
    for candidate in candidates:
        text = _text(candidate)
        if text:
            return _safe_artifact_path_part(text, default="unknown-run")
    return "unknown-run"


def _resolve_artifact_prefix(
    raw_prefix: str,
    *,
    runtime_window_import: Mapping[str, Any] | None,
    generated_at: str,
) -> str:
    run_id = _runtime_window_import_run_id(runtime_window_import)
    generated_at_part = _safe_artifact_path_part(generated_at, default="unknown-time")
    prefix = raw_prefix.format(run_id=run_id, generated_at=generated_at_part)
    return "/".join(
        _safe_artifact_path_part(part, default="artifact")
        for part in prefix.split("/")
        if part.strip("/")
    )


def _artifact_key(*, prefix: str, artifact_name: str) -> str:
    name = _safe_artifact_path_part(
        artifact_name, default="runtime-ledger-proof-packet.json"
    )
    return "/".join(part.strip("/") for part in (prefix, name) if part.strip("/"))


def _attach_and_upload_artifact(
    packet: dict[str, Any],
    *,
    artifact_prefix: str,
    artifact_name: str,
    require_artifact_upload: bool,
    runtime_window_import: Mapping[str, Any] | None,
) -> bytes:
    if require_artifact_upload and not artifact_prefix.strip():
        raise SystemExit("runtime_ledger_proof_artifact_upload_prefix_missing")
    client, bucket = _resolve_ceph_client_from_env()
    if client is None and require_artifact_upload:
        raise SystemExit("runtime_ledger_proof_artifact_upload_not_configured")
    run_id = _runtime_window_import_run_id(runtime_window_import)
    prefix = _resolve_artifact_prefix(
        artifact_prefix,
        runtime_window_import=runtime_window_import,
        generated_at=_text(packet.get("generated_at"), _utc_now()),
    )
    key = _artifact_key(prefix=prefix, artifact_name=artifact_name)
    packet["artifact"] = {
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "uri": f"s3://{bucket}/{key}" if client is not None else None,
        "bucket": bucket,
        "key": key,
        "prefix": prefix,
        "artifact_name": _safe_artifact_path_part(
            artifact_name, default="runtime-ledger-proof-packet.json"
        ),
        "runtime_window_import_run_id": run_id,
        "content_type": "application/json",
        "uploaded": client is not None,
        "upload_required": require_artifact_upload,
    }
    canonical_body = json.dumps(packet, indent=2, sort_keys=True).encode("utf-8")
    packet["artifact"]["payload_sha256"] = hashlib.sha256(canonical_body).hexdigest()
    packet["artifact"]["payload_digest_scope"] = (
        "packet_before_artifact_digest_and_upload_receipt"
    )
    packet["artifact"]["payload_size_bytes"] = len(canonical_body)
    encoded = json.dumps(packet, indent=2, sort_keys=True).encode("utf-8")
    if client is not None:
        try:
            receipt = client.put_object(
                bucket=bucket,
                key=key,
                body=encoded,
                content_type="application/json",
            )
        except Exception as exc:
            raise SystemExit(
                f"runtime_ledger_proof_artifact_upload_failed:{type(exc).__name__}"
            ) from exc
        receipt_mapping = _mapping(receipt)
        receipt_blockers = _artifact_upload_receipt_blockers(
            receipt_mapping,
            expected_bucket=bucket,
            expected_key=key,
        )
        if receipt_blockers:
            raise SystemExit(
                "runtime_ledger_proof_artifact_upload_receipt_incomplete:"
                + ",".join(receipt_blockers)
            )
        packet["artifact"]["upload_receipt"] = dict(receipt_mapping)
        packet["artifact"]["receipt_verified"] = True
        lineage = _mapping(packet.get("lineage"))
        if lineage:
            lineage_copy = dict(lineage)
            lineage_copy["artifact"] = {
                "uri": packet["artifact"]["uri"],
                "bucket": bucket,
                "key": key,
                "payload_sha256": packet["artifact"]["payload_sha256"],
                "receipt_verified": True,
            }
            packet["lineage"] = lineage_copy
        encoded = json.dumps(packet, indent=2, sort_keys=True).encode("utf-8")
    return encoded


def _artifact_upload_receipt_blockers(
    receipt: Mapping[str, Any],
    *,
    expected_bucket: str,
    expected_key: str,
) -> list[str]:
    blockers: list[str] = []
    if not receipt:
        return ["runtime_ledger_proof_artifact_upload_receipt_missing"]
    receipt_bucket = _text(receipt.get("bucket"))
    receipt_key = _text(receipt.get("key"))
    receipt_uri = _text(receipt.get("uri"))
    if not receipt_bucket:
        blockers.append("runtime_ledger_proof_artifact_upload_receipt_bucket_missing")
    elif receipt_bucket != expected_bucket:
        blockers.append("runtime_ledger_proof_artifact_upload_receipt_bucket_mismatch")
    if not receipt_key:
        blockers.append("runtime_ledger_proof_artifact_upload_receipt_key_missing")
    elif receipt_key != expected_key:
        blockers.append("runtime_ledger_proof_artifact_upload_receipt_key_mismatch")
    if not receipt_uri:
        blockers.append("runtime_ledger_proof_artifact_upload_receipt_uri_missing")
    return blockers


def _load_optional_json_object(
    *,
    path: Path | None,
    url: str | None,
    timeout_seconds: float,
    unavailable_source_name: str | None = None,
) -> dict[str, Any] | None:
    if path is not None:
        return _load_json_object(path)
    if url:
        try:
            return _load_json_url(url, timeout_seconds=timeout_seconds)
        except (HTTPError, URLError, TimeoutError) as exc:
            if unavailable_source_name is None:
                raise
            return _source_fetch_error_payload(
                source_name=unavailable_source_name,
                url=url,
                error=exc,
            )
    return None


def _service_endpoint_url(service_base_url: str, endpoint: str) -> str:
    base = service_base_url.strip()
    if not base:
        raise SystemExit("--service-base-url must not be empty")
    return urljoin(f"{base.rstrip('/')}/", endpoint.lstrip("/"))


def _apply_service_base_url_defaults(args: argparse.Namespace) -> dict[str, str]:
    shared_service_base_url = _text(getattr(args, "service_base_url", None))
    status_service_base_url = (
        _text(getattr(args, "status_service_base_url", None)) or shared_service_base_url
    )
    paper_route_service_base_url = (
        _text(getattr(args, "paper_route_service_base_url", None))
        or shared_service_base_url
    )
    completion_service_base_url = (
        _text(getattr(args, "completion_service_base_url", None))
        or shared_service_base_url
    )
    defaults = {}
    if status_service_base_url:
        defaults["status_url"] = _service_endpoint_url(
            status_service_base_url, STATUS_ENDPOINT
        )
    if paper_route_service_base_url:
        defaults["paper_route_evidence_url"] = _service_endpoint_url(
            paper_route_service_base_url,
            PAPER_ROUTE_EVIDENCE_ENDPOINT,
        )
    if completion_service_base_url:
        defaults["completion_url"] = _service_endpoint_url(
            completion_service_base_url,
            COMPLETION_DOC29_ENDPOINT,
        )
    if args.status_file is None and not args.status_url:
        args.status_url = defaults.get("status_url")
    if args.paper_route_evidence_file is None and not args.paper_route_evidence_url:
        args.paper_route_evidence_url = defaults.get("paper_route_evidence_url")
    if args.completion_file is None and not args.completion_url:
        args.completion_url = defaults.get("completion_url")
    return defaults


__all__ = (
    "_load_json_object",
    "_load_json_url",
    "_source_fetch_error_payload",
    "_ceph_client_from_env",
    "_safe_artifact_path_part",
    "_runtime_window_import_run_id",
    "_resolve_artifact_prefix",
    "_artifact_key",
    "_attach_and_upload_artifact",
    "_artifact_upload_receipt_blockers",
    "_load_optional_json_object",
    "_service_endpoint_url",
    "_apply_service_base_url_defaults",
)
