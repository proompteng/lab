#!/usr/bin/env python
"""Assemble the Torghut runtime-ledger proof packet.

The packet is deliberately stricter than a research scorecard. It only grants
post-cost proof authority when paper-route runtime-window import output and
doc29 runtime-ledger completion evidence agree on ledger proof. Capital
promotion authority stays separate so disabled submit lanes or shadow promotion
certificates cannot make valid proof look absent. Discovery/replay artifacts can
be included as lineage, but they do not make the packet promotable by
themselves.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Protocol, cast
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import urlopen

from app.trading.runtime_ledger_proof_policy import (
    DEFAULT_RUNTIME_LEDGER_PROOF_MODE,
    RUNTIME_LEDGER_PROOF_MODES,
    normalize_runtime_ledger_proof_mode,
    runtime_ledger_proof_policy_from_env,
)


SCHEMA_VERSION = "torghut.runtime-ledger-live-paper-proof-packet.v1"
DOC29_LIVE_SCALE_GATE = "live_scale_observed"
DEFAULT_RUNTIME_LEDGER_PROOF_POLICY = runtime_ledger_proof_policy_from_env()
RUNTIME_LEDGER_PROOF_MODE_NOT_AUTHORITY_BLOCKER = (
    "runtime_ledger_proof_mode_not_authority"
)
STATUS_ENDPOINT = "/trading/status"
PAPER_ROUTE_EVIDENCE_ENDPOINT = "/trading/paper-route-evidence"
COMPLETION_DOC29_ENDPOINT = "/trading/completion/doc29"
ARTIFACT_SCHEMA_VERSION = "torghut.runtime-ledger-proof-packet-artifact.v1"
HPAIRS_SOURCE_PROOF_CENSUS_STATUS_SCHEMA_VERSION = (
    "torghut.hpairs-source-proof-census-status.v1"
)
CAPITAL_PROMOTION_STATUS_BLOCKERS = frozenset(
    {
        "alpha_hypothesis_not_promotion_eligible",
        "alpha_hypothesis_shadow_only",
        "alpha_readiness_not_promotion_eligible",
        "drift_checks_not_ok",
        "hypothesis_window_evidence_stale",
        "paper_probation_evidence_collection_only",
        "post_cost_expectancy_below_manifest_threshold",
        "promotion_certificate_not_live_runtime",
        "promotion_certificate_shadow_only",
        "promotion_decision_not_allowed",
        "runtime_ledger_stage_not_live",
        "sample_count_below_canary_minimum",
        "simple_submit_disabled",
        "order_feed_lifecycle_disabled",
    }
)
CAPITAL_PROMOTION_STATUS_BLOCKER_PREFIXES = (
    "alpha_",
    "promotion_",
    "paper_probation_",
)
RUNTIME_IMPORT_MATERIALIZATION_PROMOTION_ONLY_BLOCKERS = frozenset(
    {
        "candidate_board_promotion_not_allowed",
        "final_promotion_not_authorized",
        "final_promotion_not_allowed",
        "live_runtime_ledger_required",
        "paper_probation_evidence_collection_only",
        "paper_route_runtime_ledger_import_pending",
        "paper_stage_evidence_collection_only",
        "runtime_ledger_stage_not_live",
    }
)
DEFAULT_SERVICE_FETCH_TIMEOUT_SECONDS = 30.0


class _ObjectStoreClient(Protocol):
    def put_object(
        self,
        *,
        bucket: str,
        key: str,
        body: bytes,
        content_type: str,
    ) -> Mapping[str, Any]: ...


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _text(value: object, default: str = "") -> str:
    if value is None:
        return default
    normalized = str(value).strip()
    return normalized or default


def _bool(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float, Decimal)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in {
            "1",
            "true",
            "yes",
            "y",
            "ok",
            "pass",
            "passed",
            "allowed",
            "satisfied",
        }
    return False


def _int(value: object, default: int = 0) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, Decimal):
        return int(value)
    if isinstance(value, str) and value.strip():
        try:
            return int(Decimal(value.strip()))
        except (InvalidOperation, ValueError):
            return default
    return default


def _decimal(value: object) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value).strip())
    except (InvalidOperation, ValueError):
        return None


def _decimal_text(value: Decimal | None) -> str | None:
    if value is None:
        return None
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def _first_decimal(
    payload: Mapping[str, Any],
    keys: Sequence[str],
) -> tuple[Decimal | None, str]:
    for key in keys:
        if key in payload:
            value = _decimal(payload.get(key))
            if value is not None:
                return value, key
    return None, ""


def _mapping(value: object) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return cast(Mapping[str, Any], value)
    return {}


def _contains_tigerbeetle_claim(value: object) -> bool:
    if isinstance(value, Mapping):
        for raw_key, raw_value in cast(Mapping[object, object], value).items():
            key = str(raw_key).lower()
            if key == "tigerbeetle" and _mapping(raw_value):
                return True
            if key.startswith("tigerbeetle_") and bool(raw_value):
                return True
            if _contains_tigerbeetle_claim(raw_value):
                return True
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return any(_contains_tigerbeetle_claim(item) for item in value)
    return False


def _sequence(value: object) -> Sequence[object]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return cast(Sequence[object], value)
    return []


def _text_list(value: object) -> list[str]:
    items: list[str] = []
    for item in _sequence(value):
        text = _text(item)
        if text and text not in items:
            items.append(text)
    return items


def _hpairs_source_proof_census_status(
    census: Mapping[str, Any] | None,
) -> dict[str, Any]:
    payload = _mapping(census)
    if not payload:
        return {
            "schema_version": HPAIRS_SOURCE_PROOF_CENSUS_STATUS_SCHEMA_VERSION,
            "present": False,
            "non_authority_status_only": True,
            "authority_source": False,
            "promotion_allowed": False,
            "final_authority_ok": False,
            "runtime_authority_final_ok": False,
            "census_ready": False,
            "blockers": [],
            "attachment_blockers": ["hpairs_source_proof_census_missing"],
            "blocker_ladder": [],
            "next_blocker": {
                "step": "hpairs_source_proof_census",
                "status": "missing",
                "blocker_codes": ["hpairs_source_proof_census_missing"],
                "next_action": "attach a fresh read-only H-PAIRS source-proof census artifact",
            },
        }
    verdict = _mapping(payload.get("verdict"))
    runtime_authority = _mapping(payload.get("runtime_authority"))
    blockers = _text_list(payload.get("blockers"))
    _extend_unique(blockers, _text_list(runtime_authority.get("blockers")))
    attachment_blockers = _hpairs_source_proof_census_attachment_blockers(payload)
    _extend_unique(blockers, attachment_blockers)
    next_blocker = _mapping(verdict.get("next_blocker"))
    runtime_authority_final_ok = bool(runtime_authority.get("final_authority_ok"))
    census_ready = bool(verdict.get("authority_candidate_ready")) and not blockers
    return {
        "schema_version": HPAIRS_SOURCE_PROOF_CENSUS_STATUS_SCHEMA_VERSION,
        "present": True,
        "non_authority_status_only": True,
        "authority_source": False,
        "source_schema_version": payload.get("schema_version"),
        "identity": dict(_mapping(payload.get("identity"))),
        "window": dict(_mapping(payload.get("window"))),
        "classification": verdict.get("classification"),
        "authority_candidate_ready": bool(verdict.get("authority_candidate_ready")),
        "promotion_allowed": False,
        "final_authority_ok": False,
        "runtime_authority_final_ok": runtime_authority_final_ok,
        "census_ready": census_ready,
        "blockers": blockers,
        "attachment_blockers": attachment_blockers,
        "missing_requirement_categories": dict(
            _mapping(payload.get("missing_requirement_categories"))
        ),
        "missing_source_ref_categories": dict(
            _mapping(payload.get("missing_source_ref_categories"))
        ),
        "blocker_ladder": list(_sequence(payload.get("blocker_ladder"))),
        "next_blocker": dict(next_blocker) if next_blocker else None,
        "next_action": verdict.get("next_action"),
        "totals": dict(_mapping(payload.get("totals"))),
    }


def _hpairs_source_proof_census_attachment_blockers(
    payload: Mapping[str, Any],
) -> list[str]:
    blockers: list[str] = []
    if _text(payload.get("schema_version")) != "torghut.hpairs-source-proof-census.v1":
        blockers.append("hpairs_source_proof_census_schema_mismatch")
    source = _mapping(payload.get("source"))
    if source.get("read_only") is not True:
        blockers.append("hpairs_source_proof_census_not_read_only")
    if source.get("writes_proof") is not False:
        blockers.append("hpairs_source_proof_census_writes_proof")
    if source.get("modifies_rows") is not False:
        blockers.append("hpairs_source_proof_census_modifies_rows")
    if source.get("replay_outputs_count_as_runtime_proof") is not False:
        blockers.append("hpairs_source_proof_census_replay_outputs_claim_runtime_proof")
    if source.get("synthetic_proof_created") is not False:
        blockers.append("hpairs_source_proof_census_synthetic_proof_created")
    return blockers


def _source_offsets(value: object) -> list[dict[str, object]]:
    raw_items: Sequence[object]
    if isinstance(value, Mapping):
        raw_items = [value]
    else:
        raw_items = _sequence(value)
    offsets: list[dict[str, object]] = []
    seen: set[tuple[str, str, str]] = set()
    for item in raw_items:
        offset = _mapping(item)
        topic = _text(offset.get("topic"))
        partition = offset.get("partition")
        source_offset = offset.get("offset")
        if topic is None or partition is None or source_offset is None:
            continue
        key = (topic, str(partition), str(source_offset))
        if key in seen:
            continue
        offsets.append(
            {
                "topic": topic,
                "partition": partition,
                "offset": source_offset,
            }
        )
        seen.add(key)
    return offsets


def _extend_unique(items: list[str], additions: Sequence[str]) -> None:
    for item in additions:
        text = _text(item)
        if text and text not in items:
            items.append(text)


def _load_json_object(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        raise ValueError(f"json_object_required:{path}")
    return {str(key): value for key, value in cast(Mapping[str, Any], payload).items()}


def _load_json_url(url: str, *, timeout_seconds: float) -> dict[str, Any]:
    try:
        with urlopen(url, timeout=timeout_seconds) as response:
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
    client, bucket = _ceph_client_from_env()
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


def _check(
    checks: dict[str, dict[str, Any]],
    key: str,
    *,
    passed: bool,
    observed: object,
    expected: object,
    blockers: Sequence[str] = (),
    detail: object | None = None,
    status: str | None = None,
) -> None:
    payload: dict[str, Any] = {
        "passed": bool(passed),
        "status": status or ("passed" if passed else "failed"),
        "observed": observed,
        "expected": expected,
    }
    if blockers:
        payload["blockers"] = list(blockers)
    if detail is not None:
        payload["detail"] = detail
    checks[key] = payload


def _completion_live_scale_gate(
    completion_status: Mapping[str, Any],
) -> Mapping[str, Any]:
    for raw_gate in _sequence(completion_status.get("gates")):
        gate = _mapping(raw_gate)
        if _text(gate.get("gate_id")) == DOC29_LIVE_SCALE_GATE:
            return gate
    gates_by_id = _mapping(completion_status.get("gates_by_id"))
    return _mapping(gates_by_id.get(DOC29_LIVE_SCALE_GATE))


def _runtime_ledger_refs(gate: Mapping[str, Any], key: str) -> list[str]:
    db_refs = _mapping(gate.get("db_row_refs"))
    refs = _text_list(db_refs.get(key))
    if refs:
        return refs
    return _text_list(gate.get(key))


def _runtime_ledger_trading_day_count(summary: Mapping[str, Any]) -> int:
    for key in (
        "runtime_ledger_observed_trading_day_count",
        "runtime_ledger_trading_day_count",
        "observed_trading_day_count",
        "trading_day_count",
        "runtime_ledger_session_count",
        "session_count",
    ):
        if key in summary:
            return _int(summary.get(key))
    return 0


def _paper_route_target_plan(
    paper_route_evidence: Mapping[str, Any] | None,
) -> Mapping[str, Any]:
    evidence = paper_route_evidence or {}
    for key in (
        "runtime_window_import_plan",
        "latest_closed_paper_route_runtime_window_targets",
        "next_paper_route_runtime_window_targets",
    ):
        plan = _mapping(evidence.get(key))
        if _paper_route_targets(plan):
            return plan
    return _mapping(evidence.get("runtime_window_import_plan"))


def _paper_route_import_blockers(plan: Mapping[str, Any]) -> list[str]:
    session_readiness = _mapping(plan.get("session_readiness"))
    handoff = _mapping(plan.get("runtime_window_import_handoff"))
    blockers = _text_list(session_readiness.get("import_blockers"))
    _extend_unique(blockers, _text_list(handoff.get("import_blockers")))
    for raw_target in _sequence(plan.get("targets")):
        target = _mapping(raw_target)
        _extend_unique(
            blockers, _text_list(target.get("paper_route_session_import_blockers"))
        )
    return blockers


def _paper_route_targets(plan: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    return [_mapping(item) for item in _sequence(plan.get("targets")) if _mapping(item)]


def _paper_route_runtime_window_import_audit(
    paper_route_evidence: Mapping[str, Any] | None,
) -> Mapping[str, Any]:
    return _mapping((paper_route_evidence or {}).get("runtime_window_import_audit"))


def _paper_route_runtime_window_import_audit_counts(
    audit: Mapping[str, Any],
) -> Mapping[str, Any]:
    return _mapping(audit.get("counts"))


def _paper_route_runtime_window_import_audit_blockers(
    audit: Mapping[str, Any],
) -> list[str]:
    return _text_list(audit.get("blockers"))


def _paper_route_runtime_window_import_target_blockers(
    audit: Mapping[str, Any],
) -> list[dict[str, Any]]:
    return [
        {str(key): value for key, value in item.items()}
        for item in (_mapping(raw) for raw in _sequence(audit.get("target_blockers")))
        if item
    ]


def _paper_route_source_activity_blockers(
    audit_blockers: Sequence[str],
) -> list[str]:
    source_blocker_names = {
        "paper_route_source_activity_missing",
        "strategy_name_missing",
        "source_decisions_missing",
        "source_executions_missing",
        "source_tca_missing",
    }
    return [
        blocker
        for blocker in audit_blockers
        if blocker in source_blocker_names or blocker.startswith("source_")
    ]


def _health_gate_bool(value: object) -> bool:
    if isinstance(value, bool):
        return value
    return _text(value).lower() == "true"


def _runtime_window_import_health_gate_summary(
    *,
    plan: Mapping[str, Any],
    targets: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    plan_gate = _mapping(plan.get("runtime_window_import_health_gate"))
    blockers = _text_list(plan_gate.get("blockers"))
    promotion_blockers = _text_list(plan_gate.get("promotion_blockers"))
    continuity_reasons = _text_list(plan_gate.get("continuity_reasons"))
    drift_reasons = _text_list(plan_gate.get("drift_reasons"))
    target_summaries: list[dict[str, Any]] = []
    ready_count = 0
    for index, target in enumerate(targets):
        gate = _mapping(target.get("runtime_window_import_health_gate"))
        target_blockers = _text_list(
            target.get("runtime_window_import_health_gate_blockers")
        )
        _extend_unique(target_blockers, _text_list(gate.get("blockers")))
        target_promotion_blockers = _text_list(
            target.get("runtime_window_import_promotion_blockers")
        )
        _extend_unique(
            target_promotion_blockers,
            _text_list(gate.get("promotion_blockers")),
        )
        dependency_quorum_decision = _text(
            target.get("dependency_quorum_decision")
            or gate.get("dependency_quorum_decision")
        )
        continuity_ok = target.get("continuity_ok", gate.get("continuity_ok"))
        drift_ok = target.get("drift_ok", gate.get("drift_ok"))
        continuity_reason = _text(
            target.get("continuity_reason") or gate.get("continuity_reason")
        )
        drift_reason = _text(target.get("drift_reason") or gate.get("drift_reason"))
        if not gate:
            _extend_unique(
                target_blockers, ["runtime_window_import_health_gate_missing"]
            )
        if dependency_quorum_decision != "allow":
            _extend_unique(target_blockers, ["dependency_quorum_not_allow"])
        if not _health_gate_bool(continuity_ok):
            _extend_unique(target_blockers, ["continuity_not_ok"])
        if not _health_gate_bool(drift_ok) and not target_promotion_blockers:
            _extend_unique(target_promotion_blockers, ["drift_not_ok"])
        ready = not target_blockers
        if ready:
            ready_count += 1
        _extend_unique(blockers, target_blockers)
        _extend_unique(promotion_blockers, target_promotion_blockers)
        _extend_unique(continuity_reasons, [continuity_reason])
        _extend_unique(drift_reasons, [drift_reason])
        target_summaries.append(
            {
                "index": index,
                "hypothesis_id": _text(target.get("hypothesis_id")),
                "candidate_id": _text(target.get("candidate_id")),
                "dependency_quorum_decision": dependency_quorum_decision,
                "continuity_ok": _text(continuity_ok),
                "continuity_reason": continuity_reason,
                "drift_ok": _text(drift_ok),
                "drift_reason": drift_reason,
                "ready": ready,
                "blockers": target_blockers,
                "promotion_blockers": target_promotion_blockers,
            }
        )
    target_count = len(targets)
    return {
        "schema_version": "torghut.runtime-window-import-health-gate-proof-summary.v1",
        "plan_schema_version": _text(plan_gate.get("schema_version")),
        "target_count": target_count,
        "ready_target_count": ready_count,
        "blocked_target_count": max(0, target_count - ready_count),
        "ready": target_count > 0 and ready_count == target_count and not blockers,
        "blockers": blockers,
        "promotion_blockers": promotion_blockers,
        "continuity_reasons": continuity_reasons,
        "drift_reasons": drift_reasons,
        "targets": target_summaries,
    }


def _missing_target_identity_count(targets: Sequence[Mapping[str, Any]]) -> int:
    required = (
        "hypothesis_id",
        "candidate_id",
        "strategy_family",
        "strategy_name",
        "source_manifest_ref",
        "window_start",
        "window_end",
    )
    missing_count = 0
    for target in targets:
        if any(not _text(target.get(key)) for key in required):
            missing_count += 1
    return missing_count


def _runtime_window_import_payload(
    runtime_window_import: Mapping[str, Any] | None,
) -> Mapping[str, Any]:
    payload = runtime_window_import or {}
    nested = _mapping(payload.get("runtime_window_import"))
    return nested if nested else payload


def _runtime_window_import_items(payload: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    imports = [
        _mapping(item) for item in _sequence(payload.get("imports")) if _mapping(item)
    ]
    if imports:
        return imports
    return [payload] if payload else []


def _runtime_window_import_lineage(
    *,
    raw_payload: Mapping[str, Any] | None,
    payload: Mapping[str, Any],
) -> dict[str, Any]:
    raw = _mapping(raw_payload)
    nested = _mapping(raw.get("runtime_window_import"))
    run_ids: list[str] = []
    for candidate in (
        raw.get("run_id"),
        raw.get("runtime_window_import_run_id"),
        nested.get("run_id"),
        payload.get("run_id"),
    ):
        _extend_unique(run_ids, [_text(candidate)])
    for item in _runtime_window_import_items(payload):
        _extend_unique(run_ids, [_text(item.get("run_id"))])

    empirical_promotion = _mapping(raw.get("empirical_promotion"))
    return {
        "run_id": run_ids[0] if run_ids else "",
        "run_ids": run_ids,
        "status": _text(raw.get("status") or payload.get("status")),
        "output_dir": _text(raw.get("output_dir") or payload.get("output_dir")),
        "manifest_path": _text(
            raw.get("manifest_path") or payload.get("manifest_path")
        ),
        "empirical_promotion_status": _text(empirical_promotion.get("status")),
        "wrapped_payload_present": bool(raw),
        "nested_runtime_window_import_present": bool(nested),
        "runtime_window_import_item_count": len(_runtime_window_import_items(payload)),
    }


def _runtime_import_blockers(payload: Mapping[str, Any]) -> list[str]:
    blockers: list[str] = []
    for raw_blocker in _sequence(payload.get("proof_blockers")):
        blocker = _mapping(raw_blocker)
        if blocker:
            _extend_unique(
                blockers, [_text(blocker.get("blocker") or blocker.get("type"))]
            )
        else:
            text = _text(raw_blocker)
            if text:
                _extend_unique(blockers, [text])
    for item in _runtime_window_import_items(payload):
        if item is payload:
            continue
        _extend_unique(blockers, _runtime_import_blockers(item))
    return blockers


def _runtime_import_authoritative_observation_count(payload: Mapping[str, Any]) -> int:
    count = 0
    for item in _runtime_window_import_items(payload):
        summary = _mapping(item.get("summary"))
        observation = _mapping(summary.get("runtime_observation"))
        if observation and observation.get("authoritative") is True:
            count += 1
    return count


def _runtime_import_runtime_observations(
    payload: Mapping[str, Any],
) -> list[Mapping[str, Any]]:
    observations: list[Mapping[str, Any]] = []
    for item in _runtime_window_import_items(payload):
        summary = _mapping(item.get("summary"))
        observation = _mapping(summary.get("runtime_observation"))
        if observation:
            observations.append(observation)
    return observations


def _runtime_import_target_materialization_ref(
    *,
    item: Mapping[str, Any],
    observation: Mapping[str, Any],
    profit_proof_count: int,
    materialized: bool,
    blockers: Sequence[str],
) -> dict[str, Any]:
    summary = _mapping(item.get("summary"))
    materialization_target = _mapping(summary.get("runtime_materialization_target"))
    materialization_counts = {
        "metric_window_count": _int(materialization_target.get("metric_window_count")),
        "promotion_decision_count": _int(
            materialization_target.get("promotion_decision_count")
        ),
        "runtime_ledger_bucket_count": _int(
            materialization_target.get("runtime_ledger_bucket_count")
        ),
        "evidence_grade_runtime_ledger_bucket_count": _int(
            materialization_target.get("evidence_grade_runtime_ledger_bucket_count")
        ),
    }

    def first_text(*keys: str) -> str:
        for source in (item, summary, materialization_target, observation):
            for key in keys:
                value = _text(source.get(key))
                if value:
                    return value
        return ""

    tigerbeetle_refs = _runtime_import_tigerbeetle_refs(
        item,
        summary,
        materialization_target,
        observation,
    )
    readback = _runtime_import_readback_payload(
        summary=summary,
        target=materialization_target,
    )
    ref: dict[str, Any] = {
        "materialized": materialized,
        "candidate_id": first_text("candidate_id"),
        "hypothesis_id": first_text("hypothesis_id"),
        "observed_stage": first_text("observed_stage"),
        "strategy_family": first_text("strategy_family"),
        "strategy_name": first_text("strategy_name", "runtime_strategy_name"),
        "account_label": first_text("account_label"),
        "window_start": first_text("window_start", "window_started_at"),
        "window_end": first_text("window_end", "window_ended_at"),
        "authoritative": observation.get("authoritative") is True,
        "authority_reason": _text(observation.get("authority_reason")),
        "source_kind": _text(observation.get("source_kind")),
        "runtime_ledger_profit_proof_count": profit_proof_count,
        "runtime_ledger_tca_row_count": _int(
            observation.get("runtime_ledger_tca_row_count")
        ),
        "runtime_ledger_tca_authoritative_bucket_count": _int(
            observation.get("runtime_ledger_tca_authoritative_bucket_count")
        ),
        "runtime_ledger_source_execution_materialized_bucket_count": _int(
            observation.get("runtime_ledger_source_execution_materialized_bucket_count")
        ),
        "runtime_ledger_filled_notional": _text(
            observation.get("runtime_ledger_filled_notional")
        ),
        "runtime_ledger_net_strategy_pnl_after_costs": _text(
            observation.get("runtime_ledger_net_strategy_pnl_after_costs")
        ),
        **materialization_counts,
        "metric_window_ids": _text_list(
            materialization_target.get("metric_window_ids")
        ),
        "promotion_decision_id": _text(
            materialization_target.get("promotion_decision_id")
        ),
        "runtime_ledger_bucket_ids": _text_list(
            materialization_target.get("runtime_ledger_bucket_ids")
        ),
        "evidence_grade_runtime_ledger_bucket_ids": _text_list(
            materialization_target.get("evidence_grade_runtime_ledger_bucket_ids")
        ),
        "blockers": list(blockers),
    }
    if readback:
        ref["readback"] = {
            "schema_version": _text(readback.get("schema_version")),
            "metric_window_count": _int(readback.get("metric_window_count")),
            "promotion_decision_count": _int(readback.get("promotion_decision_count")),
            "runtime_ledger_bucket_count": _int(
                readback.get("runtime_ledger_bucket_count")
            ),
            "evidence_grade_runtime_ledger_bucket_count": _int(
                readback.get("evidence_grade_runtime_ledger_bucket_count")
            ),
            "metric_window_refs": _text_list(readback.get("metric_window_refs")),
            "promotion_decision_refs": _text_list(
                readback.get("promotion_decision_refs")
            ),
            "runtime_ledger_bucket_refs": _text_list(
                readback.get("runtime_ledger_bucket_refs")
            ),
            "evidence_grade_runtime_ledger_bucket_refs": _text_list(
                readback.get("evidence_grade_runtime_ledger_bucket_refs")
            ),
            "source_refs": _text_list(readback.get("source_refs")),
            "source_window_ids": _text_list(
                readback.get("runtime_ledger_source_window_ids")
            )
            or _text_list(readback.get("source_window_ids")),
            "execution_order_event_ids": _text_list(
                readback.get("runtime_ledger_execution_order_event_ids")
            )
            or _text_list(readback.get("execution_order_event_ids")),
            "execution_ids": _text_list(readback.get("execution_ids")),
            "execution_tca_metric_ids": _text_list(
                readback.get("runtime_ledger_execution_tca_metric_ids")
            )
            or _text_list(readback.get("execution_tca_metric_ids")),
            "trade_decision_ids": _text_list(readback.get("trade_decision_ids")),
            "source_offsets": _source_offsets(readback.get("source_offsets")),
            "authority_classes": _text_list(readback.get("authority_classes")),
            "source_materializations": _text_list(
                readback.get("source_materializations")
            ),
            "cost_basis_counts": dict(_mapping(readback.get("cost_basis_counts"))),
        }
        profit_distance_readback = _mapping(
            readback.get("runtime_ledger_profit_distance_readback")
        )
        if profit_distance_readback:
            ref["readback"]["runtime_ledger_profit_distance_readback"] = dict(
                profit_distance_readback
            )
            ref["runtime_ledger_profit_distance_readback"] = dict(
                profit_distance_readback
            )
    if tigerbeetle_refs:
        ref["tigerbeetle"] = tigerbeetle_refs
    return {key: value for key, value in ref.items() if value not in ("", [], None)}


def _runtime_import_tigerbeetle_refs(
    *sources: Mapping[str, Any],
) -> dict[str, Any]:
    account_ids: list[str] = []
    account_keys: list[str] = []
    transfer_ids: list[str] = []
    source_refs: list[str] = []
    missing_account_ids: list[str] = []
    cluster_ids: list[str] = []
    bucket_refs: list[Mapping[str, Any]] = []

    def extend_unique(target: list[str], values: Sequence[str]) -> None:
        for value in values:
            if value and value not in target:
                target.append(value)

    for source in sources:
        refs = _mapping(source.get("tigerbeetle"))
        extend_unique(account_ids, _text_list(source.get("tigerbeetle_account_ids")))
        extend_unique(account_keys, _text_list(source.get("tigerbeetle_account_keys")))
        extend_unique(transfer_ids, _text_list(source.get("tigerbeetle_transfer_ids")))
        if refs:
            extend_unique(cluster_ids, _text_list(refs.get("cluster_ids")))
            extend_unique(account_ids, _text_list(refs.get("account_ids")))
            extend_unique(account_keys, _text_list(refs.get("account_keys")))
            extend_unique(transfer_ids, _text_list(refs.get("transfer_ids")))
            extend_unique(source_refs, _text_list(refs.get("source_refs")))
            extend_unique(
                missing_account_ids, _text_list(refs.get("missing_account_ids"))
            )
            for bucket_ref in _sequence(refs.get("runtime_ledger_buckets")):
                bucket_mapping = _mapping(bucket_ref)
                if bucket_mapping:
                    bucket_refs.append(bucket_mapping)

    if not account_ids and not account_keys and not transfer_ids:
        return {}
    return {
        "schema_version": "torghut.tigerbeetle-runtime-ledger-proof-refs.v1",
        "cluster_ids": cluster_ids,
        "account_count": len(account_ids),
        "transfer_count": len(transfer_ids),
        "account_ids": account_ids,
        "account_keys": account_keys,
        "transfer_ids": transfer_ids,
        "missing_account_ids": missing_account_ids,
        "source_refs": source_refs,
        "runtime_ledger_buckets": bucket_refs,
    }


def _runtime_import_target_blocker_codes(value: object) -> list[str]:
    blockers: list[str] = []
    for item in _sequence(value):
        if isinstance(item, Mapping):
            blocker = _text(item.get("blocker"))
        else:
            blocker = _text(item)
        if blocker:
            blockers.append(blocker)
    return blockers


_RUNTIME_LEDGER_PROMOTION_GRADE_SOURCE_MATERIALIZATIONS = frozenset(
    {
        "execution_order_events",
        "source_execution_lifecycle",
    }
)
_RUNTIME_LEDGER_PROMOTION_GRADE_AUTHORITY_MARKERS = frozenset(
    {
        "runtime_order_feed_execution_source",
        "event_sourced_runtime_ledger_profit_proof",
        "source_execution_runtime_ledger_materialized",
        "execution_order_events_runtime_ledger",
        "source_execution_lifecycle_materialized_runtime_ledger",
    }
)
_RUNTIME_LEDGER_NON_AUTHORITY_MATERIALIZATION_MARKERS = frozenset(
    {
        "aggregate_only",
        "artifact_only",
        "exact_replay",
        "replay_artifact",
        "simulation_source_replay_only",
    }
)


def _runtime_ledger_non_authority_marker_present(value: object) -> bool:
    text = _text(value)
    if text is None:
        return False
    normalized = text.lower().replace("-", "_")
    return any(
        marker in normalized
        for marker in _RUNTIME_LEDGER_NON_AUTHORITY_MATERIALIZATION_MARKERS
    )


def _runtime_ledger_readback_authority_markers_present(
    *,
    authority_classes: Sequence[str],
    authority_reasons: Sequence[str],
) -> bool:
    return (
        any(
            authority_class in _RUNTIME_LEDGER_PROMOTION_GRADE_AUTHORITY_MARKERS
            for authority_class in authority_classes
        )
        and any(
            authority_reason in _RUNTIME_LEDGER_PROMOTION_GRADE_AUTHORITY_MARKERS
            for authority_reason in authority_reasons
        )
        and not any(
            _runtime_ledger_non_authority_marker_present(marker)
            for marker in [*authority_classes, *authority_reasons]
        )
    )


def _runtime_import_materialization_metadata_blockers(
    observation: Mapping[str, Any],
) -> list[str]:
    blockers = [
        blocker
        for blocker in _text_list(
            observation.get("runtime_ledger_target_metadata_blockers")
        )
        if blocker not in RUNTIME_IMPORT_MATERIALIZATION_PROMOTION_ONLY_BLOCKERS
    ]
    proof_count = max(
        _int(observation.get("runtime_ledger_tca_profit_proof_count")),
        _int(observation.get("runtime_ledger_source_bucket_profit_proof_count")),
        _int(observation.get("runtime_ledger_durable_bucket_profit_proof_count")),
        1 if _bool(observation.get("runtime_ledger_profit_proof_present")) else 0,
    )
    if proof_count <= 0:
        return blockers

    source_materialized_count = _int(
        observation.get("runtime_ledger_source_execution_materialized_bucket_count")
    )
    if source_materialized_count < proof_count:
        blockers.append(
            "runtime_window_import_source_execution_materialization_missing"
        )

    source_materializations = _text_list(
        observation.get("runtime_ledger_source_materializations")
    )
    if not any(
        materialization in _RUNTIME_LEDGER_PROMOTION_GRADE_SOURCE_MATERIALIZATIONS
        for materialization in source_materializations
    ) or any(
        _runtime_ledger_non_authority_marker_present(materialization)
        for materialization in source_materializations
    ):
        blockers.append("runtime_window_import_source_materialization_missing")

    derivations = _text_list(
        observation.get("runtime_ledger_materialization_pnl_derivations")
    )
    authority_reasons = _text_list(
        observation.get("runtime_ledger_materialization_authority_reasons")
    )
    authority_reason = _text(observation.get("authority_reason"))
    if authority_reason is not None:
        authority_reasons.append(authority_reason)
    if any(
        _runtime_ledger_non_authority_marker_present(value)
        for value in [*derivations, *authority_reasons]
    ):
        blockers.append(
            "runtime_window_import_replay_or_artifact_derivation_not_authority"
        )
    return list(dict.fromkeys(blockers))


def _runtime_import_readback_payload(
    *,
    summary: Mapping[str, Any],
    target: Mapping[str, Any],
) -> Mapping[str, Any]:
    nested = _mapping(target.get("readback"))
    if nested:
        return nested
    return _mapping(summary.get("runtime_window_import_readback"))


def _runtime_import_readback_blockers(
    *,
    target: Mapping[str, Any],
    readback: Mapping[str, Any],
    profit_proof_count: int,
) -> list[str]:
    if not readback:
        return ["runtime_window_import_readback_missing"]

    blockers: list[str] = []
    count_pairs = (
        (
            "metric_window_count",
            "runtime_window_import_metric_window_readback_mismatch",
        ),
        (
            "promotion_decision_count",
            "runtime_window_import_promotion_decision_readback_mismatch",
        ),
        (
            "runtime_ledger_bucket_count",
            "runtime_window_import_runtime_ledger_bucket_readback_mismatch",
        ),
        (
            "evidence_grade_runtime_ledger_bucket_count",
            "runtime_window_import_evidence_grade_runtime_ledger_bucket_readback_mismatch",
        ),
    )
    for key, blocker in count_pairs:
        if _int(target.get(key)) != _int(readback.get(key)):
            blockers.append(blocker)

    ref_pairs = (
        (
            "metric_window_ids",
            "metric_window_refs",
            "runtime_window_import_metric_window_refs_readback_mismatch",
        ),
        (
            "runtime_ledger_bucket_ids",
            "runtime_ledger_bucket_refs",
            "runtime_window_import_runtime_ledger_bucket_refs_readback_mismatch",
        ),
        (
            "evidence_grade_runtime_ledger_bucket_ids",
            "evidence_grade_runtime_ledger_bucket_refs",
            "runtime_window_import_evidence_grade_runtime_ledger_bucket_refs_readback_mismatch",
        ),
    )
    for target_key, readback_key, blocker in ref_pairs:
        target_refs = _text_list(target.get(target_key))
        readback_refs = _text_list(readback.get(readback_key))
        if len(readback_refs) < len(target_refs):
            blockers.append(blocker)
    if _text(target.get("promotion_decision_id")) and not _text_list(
        readback.get("promotion_decision_refs")
    ):
        blockers.append("runtime_window_import_promotion_decision_ref_readback_missing")
    if profit_proof_count > 0:
        if not _text_list(readback.get("source_refs")):
            blockers.append("runtime_window_import_readback_source_refs_missing")
            blockers.append("runtime_ledger_source_refs_missing")
        if not (
            _text_list(readback.get("runtime_ledger_source_window_ids"))
            or _text_list(readback.get("source_window_ids"))
        ):
            blockers.append("runtime_ledger_source_window_missing")
        if not (
            _text_list(readback.get("runtime_ledger_execution_order_event_ids"))
            or _text_list(readback.get("execution_order_event_ids"))
        ):
            blockers.append("runtime_ledger_execution_order_event_refs_missing")
        if not _text_list(readback.get("execution_ids")):
            blockers.append("runtime_ledger_execution_refs_missing")
        if not (
            _text_list(readback.get("runtime_ledger_execution_tca_metric_ids"))
            or _text_list(readback.get("execution_tca_metric_ids"))
        ):
            blockers.append("runtime_ledger_execution_tca_refs_missing")
            blockers.append("execution_tca_missing")
        if not _text_list(readback.get("trade_decision_ids")):
            blockers.append("runtime_ledger_trade_decision_refs_missing")
        if not _source_offsets(readback.get("source_offsets")):
            blockers.append("runtime_ledger_source_offsets_missing")
        if not _text_list(readback.get("source_materializations")):
            blockers.append("runtime_ledger_source_materialization_missing")
        authority_classes = _text_list(readback.get("authority_classes"))
        authority_reasons = _text_list(readback.get("authority_reasons"))
        if not _runtime_ledger_readback_authority_markers_present(
            authority_classes=authority_classes,
            authority_reasons=authority_reasons,
        ):
            blockers.append("runtime_ledger_authority_class_missing")
        cost_amount = _decimal(readback.get("runtime_ledger_cost_amount"))
        if cost_amount is None or (
            not _mapping(readback.get("cost_basis_counts"))
            and not _mapping(readback.get("runtime_ledger_cost_basis_counts"))
        ):
            blockers.append("runtime_ledger_explicit_costs_missing")
    return list(dict.fromkeys(blockers))


def _runtime_import_target_surface_blockers(
    *,
    summary: Mapping[str, Any],
    profit_proof_count: int,
) -> list[str]:
    target = _mapping(summary.get("runtime_materialization_target"))
    if not target:
        return ["runtime_window_import_materialization_target_missing"]
    blockers = _text_list(target.get("materialization_blockers"))
    if _int(target.get("metric_window_count")) <= 0:
        blockers.append("runtime_window_import_metric_window_missing")
    elif not _text_list(target.get("metric_window_ids")):
        blockers.append("runtime_window_import_metric_window_refs_missing")
    if _int(target.get("promotion_decision_count")) <= 0:
        blockers.append("runtime_window_import_promotion_decision_missing")
    elif not _text(target.get("promotion_decision_id")):
        blockers.append("runtime_window_import_promotion_decision_ref_missing")
    if profit_proof_count > 0:
        runtime_ledger_bucket_count = _int(target.get("runtime_ledger_bucket_count"))
        evidence_grade_runtime_ledger_bucket_count = _int(
            target.get("evidence_grade_runtime_ledger_bucket_count")
        )
        if runtime_ledger_bucket_count <= 0:
            blockers.append("runtime_window_import_runtime_ledger_bucket_missing")
        elif (
            len(_text_list(target.get("runtime_ledger_bucket_ids")))
            < runtime_ledger_bucket_count
        ):
            blockers.append("runtime_window_import_runtime_ledger_bucket_refs_missing")
        if evidence_grade_runtime_ledger_bucket_count <= 0:
            blockers.append(
                "runtime_window_import_evidence_grade_runtime_ledger_bucket_missing"
            )
        elif (
            len(_text_list(target.get("evidence_grade_runtime_ledger_bucket_ids")))
            < evidence_grade_runtime_ledger_bucket_count
        ):
            blockers.append(
                "runtime_window_import_evidence_grade_runtime_ledger_bucket_refs_missing"
            )
    if target.get("materialized") is False:
        blockers.extend(
            _runtime_import_target_blocker_codes(target.get("proof_blockers"))
        )
    blockers.extend(
        _runtime_import_readback_blockers(
            target=target,
            readback=_runtime_import_readback_payload(summary=summary, target=target),
            profit_proof_count=profit_proof_count,
        )
    )
    return list(dict.fromkeys(blockers))


def _runtime_import_materialization_summary(
    payload: Mapping[str, Any],
) -> dict[str, Any]:
    items = _runtime_window_import_items(payload)
    observations = _runtime_import_runtime_observations(payload)
    source_kinds: list[str] = []
    authority_reasons: list[str] = []
    pnl_derivations: list[str] = []
    materialization_blockers: list[str] = []
    materialized_targets: list[dict[str, Any]] = []
    unmaterialized_targets: list[dict[str, Any]] = []
    counts = {
        "declared_target_count": _int(payload.get("target_count"), len(items)),
        "import_item_count": len(items),
        "runtime_observation_count": len(observations),
        "authoritative_observation_count": 0,
        "materialized_target_count": 0,
        "unmaterialized_target_count": 0,
        "missing_target_import_count": 0,
        "authoritative_runtime_ledger_profit_proof_count": 0,
        "non_authoritative_runtime_ledger_profit_proof_count": 0,
        "runtime_ledger_profit_proof_count": 0,
        "runtime_ledger_tca_row_count": 0,
        "runtime_ledger_tca_runtime_bucket_row_count": 0,
        "runtime_ledger_tca_authoritative_bucket_count": 0,
        "runtime_ledger_source_execution_materialized_bucket_count": 0,
        "runtime_ledger_execution_reconstruction_bucket_count": 0,
        "runtime_ledger_source_bucket_profit_proof_count": 0,
        "runtime_ledger_durable_bucket_profit_proof_count": 0,
        "runtime_ledger_artifact_tca_row_count": 0,
    }
    for item in items:
        summary = _mapping(item.get("summary"))
        observation = _mapping(summary.get("runtime_observation"))
        target_blockers: list[str] = []
        if not observation:
            target_blockers.append("runtime_window_import_runtime_observation_missing")
            unmaterialized_targets.append(
                _runtime_import_target_materialization_ref(
                    item=item,
                    observation={},
                    profit_proof_count=0,
                    materialized=False,
                    blockers=target_blockers,
                )
            )
            _extend_unique(materialization_blockers, target_blockers)
            continue
        if observation.get("authoritative") is True:
            counts["authoritative_observation_count"] += 1
        authority_reason = _text(observation.get("authority_reason"))
        tca_profit_proof_count = _int(
            observation.get("runtime_ledger_tca_profit_proof_count")
        )
        source_profit_proof_count = _int(
            observation.get("runtime_ledger_source_bucket_profit_proof_count")
        )
        durable_profit_proof_count = _int(
            observation.get("runtime_ledger_durable_bucket_profit_proof_count")
        )
        profit_proof_count = max(
            1 if _bool(observation.get("runtime_ledger_profit_proof_present")) else 0,
            tca_profit_proof_count,
            source_profit_proof_count,
            durable_profit_proof_count,
        )
        counts["runtime_ledger_profit_proof_count"] += profit_proof_count
        if observation.get("authoritative") is True:
            counts["authoritative_runtime_ledger_profit_proof_count"] += (
                profit_proof_count
            )
        else:
            counts["non_authoritative_runtime_ledger_profit_proof_count"] += (
                profit_proof_count
            )
        for key in (
            "runtime_ledger_tca_row_count",
            "runtime_ledger_tca_runtime_bucket_row_count",
            "runtime_ledger_tca_authoritative_bucket_count",
            "runtime_ledger_source_execution_materialized_bucket_count",
            "runtime_ledger_execution_reconstruction_bucket_count",
            "runtime_ledger_source_bucket_profit_proof_count",
            "runtime_ledger_durable_bucket_profit_proof_count",
            "runtime_ledger_artifact_tca_row_count",
        ):
            counts[key] += _int(observation.get(key))
        if observation.get("authoritative") is not True:
            target_blockers.append(
                "runtime_window_import_observation_not_authoritative"
            )
        if profit_proof_count <= 0:
            target_blockers.append("runtime_window_import_target_profit_proof_missing")
        _extend_unique(
            target_blockers,
            _text_list(observation.get("runtime_ledger_profit_proof_blockers")),
        )
        _extend_unique(
            target_blockers,
            _runtime_import_target_surface_blockers(
                summary=summary,
                profit_proof_count=profit_proof_count,
            ),
        )
        _extend_unique(source_kinds, [_text(observation.get("source_kind"))])
        _extend_unique(authority_reasons, [authority_reason])
        _extend_unique(
            pnl_derivations,
            _text_list(
                observation.get("runtime_ledger_materialization_pnl_derivations")
            ),
        )
        _extend_unique(
            materialization_blockers,
            _text_list(observation.get("runtime_ledger_materialization_blockers")),
        )
        _extend_unique(
            materialization_blockers,
            _text_list(observation.get("runtime_ledger_profit_proof_blockers")),
        )
        _extend_unique(
            materialization_blockers,
            _runtime_import_materialization_metadata_blockers(observation),
        )
        materialized = (
            observation.get("authoritative") is True
            and profit_proof_count > 0
            and not target_blockers
        )
        target_ref = _runtime_import_target_materialization_ref(
            item=item,
            observation=observation,
            profit_proof_count=profit_proof_count,
            materialized=materialized,
            blockers=target_blockers,
        )
        if materialized:
            counts["materialized_target_count"] += 1
            materialized_targets.append(target_ref)
        else:
            unmaterialized_targets.append(target_ref)
            _extend_unique(materialization_blockers, target_blockers)
    counts["unmaterialized_target_count"] = len(unmaterialized_targets)
    counts["missing_target_import_count"] = max(
        0,
        counts["declared_target_count"] - counts["import_item_count"],
    )
    if counts["missing_target_import_count"] > 0:
        _extend_unique(
            materialization_blockers,
            ["runtime_window_import_target_count_mismatch"],
        )
    if unmaterialized_targets:
        _extend_unique(
            materialization_blockers,
            ["runtime_window_import_target_materialization_missing"],
        )
    if (
        counts["authoritative_runtime_ledger_profit_proof_count"] <= 0
        or counts["unmaterialized_target_count"] > 0
        or counts["missing_target_import_count"] > 0
    ):
        _extend_unique(
            materialization_blockers,
            ["runtime_window_import_runtime_ledger_materialization_missing"],
        )
    return {
        "schema_version": "torghut.runtime-window-import-materialization-summary.v1",
        **counts,
        "materialized_targets": materialized_targets,
        "unmaterialized_targets": unmaterialized_targets,
        "source_kinds": source_kinds,
        "authority_reasons": authority_reasons,
        "pnl_derivations": pnl_derivations,
        "blockers": materialization_blockers,
    }


def _first_identity(
    *,
    paper_targets: Sequence[Mapping[str, Any]],
    runtime_import: Mapping[str, Any],
    completion_gate: Mapping[str, Any],
) -> dict[str, object]:
    candidates: list[Mapping[str, Any]] = []
    candidates.extend(paper_targets)
    candidates.extend(_runtime_window_import_items(runtime_import))
    if completion_gate:
        candidates.append(completion_gate)
    identity: dict[str, object] = {}
    for key in (
        "candidate_id",
        "hypothesis_id",
        "observed_stage",
        "strategy_family",
        "strategy_name",
        "account_label",
        "window_start",
        "window_end",
    ):
        for candidate in candidates:
            value = _text(candidate.get(key))
            if value:
                identity[key] = value
                break
    return identity


def _first_env_text(names: Sequence[str]) -> str:
    for name in names:
        value = _text(os.getenv(name))
        if value:
            return value
    return ""


def _runtime_ledger_immutable_lineage(
    *,
    identity: Mapping[str, object],
    paper_targets: Sequence[Mapping[str, Any]],
    runtime_import: Mapping[str, Any],
    runtime_summary: Mapping[str, Any],
    ledger_refs: Sequence[str],
    unbacked_refs: Sequence[str],
    materialization_summary: Mapping[str, Any],
) -> dict[str, Any]:
    source_row_ids: list[str] = []
    source_refs: list[str] = []
    strategy_ledger_refs: list[str] = []
    bucket_ids: list[str] = []
    metric_window_ids: list[str] = []
    promotion_decision_ids: list[str] = []
    _extend_unique(strategy_ledger_refs, list(ledger_refs))

    def collect_from(source: Mapping[str, Any]) -> None:
        for key in (
            "trade_decision_id",
            "trade_decision_ids",
            "execution_id",
            "execution_ids",
            "execution_order_event_id",
            "execution_order_event_ids",
            "runtime_ledger_execution_order_event_id",
            "runtime_ledger_execution_order_event_ids",
            "execution_tca_metric_id",
            "execution_tca_metric_ids",
            "runtime_ledger_execution_tca_metric_id",
            "runtime_ledger_execution_tca_metric_ids",
            "source_window_id",
            "source_window_ids",
            "runtime_ledger_source_window_id",
            "runtime_ledger_source_window_ids",
            "source_row_id",
            "source_row_ids",
            "source_execution_row_ids",
            "runtime_ledger_source_row_ids",
            "runtime_ledger_source_execution_row_ids",
        ):
            _extend_unique(source_row_ids, _text_list(source.get(key)))
            if not _sequence(source.get(key)):
                text = _text(source.get(key))
                if text:
                    _extend_unique(source_row_ids, [text])
        for key in (
            "source_ref",
            "source_refs",
            "source_window_ref",
            "source_window_refs",
            "runtime_ledger_source_ref",
            "runtime_ledger_source_refs",
            "runtime_ledger_source_window_refs",
            "source_manifest_ref",
        ):
            _extend_unique(source_refs, _text_list(source.get(key)))
            if not _sequence(source.get(key)):
                text = _text(source.get(key))
                if text:
                    _extend_unique(source_refs, [text])
        for key in (
            "runtime_ledger_bucket_id",
            "runtime_ledger_bucket_ids",
            "evidence_grade_runtime_ledger_bucket_ids",
        ):
            _extend_unique(bucket_ids, _text_list(source.get(key)))
            if not _sequence(source.get(key)):
                text = _text(source.get(key))
                if text:
                    _extend_unique(bucket_ids, [text])
        for key in (
            "runtime_ledger_bucket_ref",
            "runtime_ledger_bucket_refs",
            "strategy_runtime_ledger_bucket_ref",
            "strategy_runtime_ledger_bucket_refs",
            "evidence_grade_runtime_ledger_bucket_ref",
            "evidence_grade_runtime_ledger_bucket_refs",
        ):
            _extend_unique(strategy_ledger_refs, _text_list(source.get(key)))
            if not _sequence(source.get(key)):
                text = _text(source.get(key))
                if text:
                    _extend_unique(strategy_ledger_refs, [text])
        for key in (
            "metric_window_id",
            "metric_window_ids",
            "metric_window_ref",
            "metric_window_refs",
        ):
            _extend_unique(metric_window_ids, _text_list(source.get(key)))
            if not _sequence(source.get(key)):
                text = _text(source.get(key))
                if text:
                    _extend_unique(metric_window_ids, [text])
        promotion_decision_id = _text(source.get("promotion_decision_id"))
        if promotion_decision_id:
            _extend_unique(promotion_decision_ids, [promotion_decision_id])
        _extend_unique(
            promotion_decision_ids,
            _text_list(source.get("promotion_decision_refs")),
        )

    for target in paper_targets:
        collect_from(target)
    for item in _runtime_window_import_items(runtime_import):
        collect_from(item)
        summary = _mapping(item.get("summary"))
        collect_from(summary)
        collect_from(_mapping(summary.get("runtime_observation")))
        collect_from(_mapping(summary.get("runtime_window_import_readback")))
        materialization_target = _mapping(summary.get("runtime_materialization_target"))
        collect_from(materialization_target)
        collect_from(_mapping(materialization_target.get("readback")))
    collect_from(runtime_summary)
    for key in ("materialized_targets", "unmaterialized_targets"):
        for target in _sequence(materialization_summary.get(key)):
            materialized_target = _mapping(target)
            collect_from(materialized_target)
            collect_from(_mapping(materialized_target.get("readback")))
            tigerbeetle = _mapping(materialized_target.get("tigerbeetle"))
            _extend_unique(source_refs, _text_list(tigerbeetle.get("source_refs")))
            for bucket_ref in _sequence(tigerbeetle.get("runtime_ledger_buckets")):
                collect_from(_mapping(bucket_ref))

    runtime_strategy = _text(
        identity.get("runtime_strategy_name") or identity.get("strategy_name")
    )
    code_commit = _first_env_text(
        (
            "TORGHUT_IMAGE_COMMIT",
            "GIT_COMMIT",
            "SOURCE_COMMIT",
            "CODE_COMMIT",
            "COMMIT_SHA",
        )
    )
    image_digest = _first_env_text(
        (
            "TORGHUT_IMAGE_DIGEST",
            "IMAGE_DIGEST",
            "CONTAINER_IMAGE_DIGEST",
            "K_REVISION_IMAGE_DIGEST",
        )
    )
    image = _first_env_text(("TORGHUT_IMAGE", "CONTAINER_IMAGE", "IMAGE"))
    return {
        "schema_version": "torghut.runtime-ledger-proof-packet-lineage.v1",
        "hypothesis_id": _text(identity.get("hypothesis_id")),
        "candidate_id": _text(identity.get("candidate_id")),
        "runtime_strategy": runtime_strategy,
        "strategy_family": _text(identity.get("strategy_family")),
        "account_label": _text(identity.get("account_label")),
        "stage": _text(identity.get("observed_stage")),
        "window_start": _text(identity.get("window_start")),
        "window_end": _text(identity.get("window_end")),
        "source_row_ids": source_row_ids,
        "source_refs": source_refs,
        "strategy_runtime_ledger_bucket_refs": strategy_ledger_refs,
        "unbacked_metric_window_refs": list(unbacked_refs),
        "runtime_ledger_bucket_ids": bucket_ids,
        "metric_window_ids": metric_window_ids,
        "promotion_decision_ids": promotion_decision_ids,
        "counts": {
            "source_row_id_count": len(source_row_ids),
            "source_ref_count": len(source_refs),
            "strategy_runtime_ledger_bucket_ref_count": len(strategy_ledger_refs),
            "unbacked_metric_window_ref_count": len(unbacked_refs),
            "runtime_ledger_bucket_id_count": len(bucket_ids),
            "metric_window_id_count": len(metric_window_ids),
            "promotion_decision_id_count": len(promotion_decision_ids),
        },
        "code": {
            "commit": code_commit,
            "image": image,
            "image_digest": image_digest,
            "commit_available": bool(code_commit),
            "image_digest_available": bool(image_digest),
        },
    }


def _status_blockers(status: Mapping[str, Any]) -> list[str]:
    blockers: list[str] = []
    gate = (
        _mapping(status.get("live_submission_gate"))
        or _mapping(status.get("live_gate"))
        or _mapping(status.get("submission_gate"))
    )
    if gate:
        _extend_unique(blockers, _text_list(gate.get("blocked_reasons")))
        _extend_unique(blockers, _text_list(gate.get("blocking_reasons")))
        if gate.get("allowed") is False:
            _extend_unique(
                blockers,
                [_text(gate.get("reason"), "live_submission_gate_not_allowed")],
            )
    proof_floor = _mapping(status.get("proof_floor"))
    _extend_unique(blockers, _text_list(proof_floor.get("blocking_reasons")))
    return blockers


def _is_capital_promotion_status_blocker(blocker: str) -> bool:
    if blocker in CAPITAL_PROMOTION_STATUS_BLOCKERS:
        return True
    return any(
        blocker.startswith(prefix)
        for prefix in CAPITAL_PROMOTION_STATUS_BLOCKER_PREFIXES
    )


def _status_gate_blocker_summary(status: Mapping[str, Any]) -> dict[str, list[str]]:
    raw_blockers = _status_blockers(status)
    capital_blockers = [
        blocker
        for blocker in raw_blockers
        if _is_capital_promotion_status_blocker(blocker)
    ]
    proof_blockers = [
        blocker for blocker in raw_blockers if blocker not in capital_blockers
    ]
    return {
        "raw_blockers": raw_blockers,
        "proof_blockers": proof_blockers,
        "capital_promotion_blockers": capital_blockers,
    }


def _completion_blockers(gate: Mapping[str, Any]) -> list[str]:
    blockers = _text_list(gate.get("blocking_reasons"))
    blocked_reason = _text(gate.get("blocked_reason"))
    if blocked_reason:
        _extend_unique(blockers, [blocked_reason])
    return blockers


def _required_actions(blockers: Sequence[str], *, verdict: str) -> list[str]:
    actions: list[str] = []
    if verdict == "waiting_for_runtime_window":
        for blocker in blockers:
            if blocker in {
                "paper_route_session_window_not_open",
                "paper_route_session_window_not_closed",
                "paper_route_import_not_ready",
            }:
                _extend_unique(actions, ["wait_for_regular_session_runtime_window"])
            elif blocker == "paper_route_session_settlement_pending":
                _extend_unique(actions, ["wait_for_paper_route_settlement_grace"])
        if actions:
            return actions
    for blocker in blockers:
        if blocker in {
            "paper_route_session_window_not_open",
            "paper_route_session_window_not_closed",
        }:
            _extend_unique(actions, ["wait_for_regular_session_runtime_window"])
        elif blocker == "paper_route_session_settlement_pending":
            _extend_unique(actions, ["wait_for_paper_route_settlement_grace"])
        elif blocker in {
            "runtime_window_import_missing",
            "runtime_window_import_runtime_ledger_materialization_missing",
            "runtime_ledger_bucket_missing",
            "paper_route_runtime_ledger_import_pending",
        }:
            _extend_unique(
                actions, ["run_runtime_window_import_from_paper_route_target_plan"]
            )
        elif blocker in {
            "runtime_ledger_net_pnl_below_target",
            "runtime_ledger_daily_net_pnl_below_target",
            "runtime_ledger_mean_daily_net_pnl_after_costs_below_floor",
            "runtime_ledger_median_daily_net_pnl_after_costs_below_floor",
            "runtime_ledger_p10_daily_net_pnl_after_costs_below_floor",
            "runtime_ledger_worst_day_net_pnl_after_costs_below_floor",
        }:
            _extend_unique(
                actions, ["collect_or_improve_post_cost_runtime_profit_evidence"]
            )
        elif blocker in {
            "runtime_ledger_drawdown_pct_equity_missing",
            "runtime_ledger_drawdown_pct_equity_above_limit",
            "runtime_ledger_best_day_share_missing",
            "runtime_ledger_best_day_share_above_limit",
            "runtime_ledger_symbol_concentration_share_missing",
            "runtime_ledger_symbol_concentration_share_above_limit",
            "runtime_ledger_max_intraday_drawdown_missing",
            "runtime_ledger_max_intraday_drawdown_above_limit",
        }:
            _extend_unique(
                actions,
                ["improve_runtime_ledger_drawdown_concentration_or_position_sizing"],
            )
        elif blocker == RUNTIME_LEDGER_PROOF_MODE_NOT_AUTHORITY_BLOCKER:
            _extend_unique(actions, ["rerun_proof_packet_in_authority_mode"])
        elif blocker.startswith("runtime_ledger_") or blocker in {
            "filled_notional_missing",
            "closed_round_trip_missing",
            "submitted_order_lifecycle_missing",
            "runtime_decision_lifecycle_missing",
        }:
            _extend_unique(
                actions, ["repair_runtime_ledger_lifecycle_cost_or_lineage_evidence"]
            )
        elif blocker in {
            "runtime_ledger_trading_days_below_target",
        }:
            _extend_unique(actions, ["collect_more_runtime_ledger_trading_days"])
        elif blocker in {
            "paper_route_source_activity_missing",
            "strategy_name_missing",
            "source_decisions_missing",
            "source_executions_missing",
            "source_tca_missing",
        } or blocker.startswith("source_"):
            _extend_unique(
                actions, ["inspect_paper_route_source_activity_before_import"]
            )
        elif blocker == "runtime_window_import_audit_missing":
            _extend_unique(actions, ["inspect_paper_route_evidence_audit"])
        elif blocker in {"simple_submit_disabled", "live_submission_gate_not_allowed"}:
            _extend_unique(
                actions, ["keep_promotion_blocked_until_live_gate_and_proof_floor_pass"]
            )
        elif blocker in {
            "runtime_window_import_health_gate_missing",
            "dependency_quorum_not_allow",
            "continuity_not_ok",
            "drift_not_ok",
            "drift_checks_not_ok",
        } or blocker.startswith("runtime_window_import_health_gate"):
            _extend_unique(actions, ["repair_runtime_window_import_health_gate"])
    if not actions and verdict != "promotion_authority_allowed":
        actions.append("inspect_packet_checks_and_repair_failed_proof_dimension")
    return actions


def build_runtime_ledger_proof_packet(
    status: Mapping[str, Any],
    *,
    proof_mode: str = DEFAULT_RUNTIME_LEDGER_PROOF_MODE,
    paper_route_evidence: Mapping[str, Any] | None = None,
    runtime_window_import: Mapping[str, Any] | None = None,
    completion_status: Mapping[str, Any] | None = None,
    hpairs_source_proof_census: Mapping[str, Any] | None = None,
    min_runtime_ledger_net_pnl: Decimal = (
        DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.min_net_pnl_after_costs
    ),
    min_runtime_ledger_daily_net_pnl: Decimal = (
        DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.min_daily_net_pnl_after_costs
    ),
    min_runtime_ledger_trading_days: int = (
        DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.min_trading_days
    ),
    max_runtime_ledger_drawdown_pct_equity: Decimal = (
        DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.max_drawdown_pct_equity
    ),
    max_runtime_ledger_best_day_share: Decimal = (
        DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.max_best_day_share
    ),
    max_runtime_ledger_symbol_concentration_share: Decimal = (
        DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.max_symbol_concentration_share
    ),
    generated_at: str | None = None,
) -> dict[str, Any]:
    checks: dict[str, dict[str, Any]] = {}
    blockers: list[str] = []
    generated_at = generated_at or _utc_now()
    resolved_proof_mode = normalize_runtime_ledger_proof_mode(proof_mode)
    proof_mode_targets = DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.targets_for_mode(
        resolved_proof_mode
    )
    proof_mode_contract = DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.mode_contract(
        resolved_proof_mode
    )
    min_runtime_ledger_net_pnl = max(
        min_runtime_ledger_net_pnl,
        cast(Decimal, proof_mode_targets["min_net_pnl_after_costs"]),
    )
    min_runtime_ledger_daily_net_pnl = max(
        min_runtime_ledger_daily_net_pnl,
        cast(Decimal, proof_mode_targets["min_daily_net_pnl_after_costs"]),
    )
    min_runtime_ledger_trading_days = max(
        min_runtime_ledger_trading_days,
        cast(int, proof_mode_targets["min_trading_days"]),
    )
    max_runtime_ledger_drawdown_pct_equity = min(
        max_runtime_ledger_drawdown_pct_equity,
        cast(Decimal, proof_mode_targets["max_drawdown_pct_equity"]),
    )
    max_runtime_ledger_best_day_share = min(
        max_runtime_ledger_best_day_share,
        cast(Decimal, proof_mode_targets["max_best_day_share"]),
    )
    max_runtime_ledger_symbol_concentration_share = min(
        max_runtime_ledger_symbol_concentration_share,
        cast(Decimal, proof_mode_targets["max_symbol_concentration_share"]),
    )
    min_runtime_ledger_closed_round_trips = cast(
        int, proof_mode_targets["min_closed_round_trips"]
    )
    min_runtime_ledger_filled_notional = cast(
        Decimal, proof_mode_targets["min_filled_notional"]
    )
    final_authority_mode = bool(proof_mode_targets["final_authority"])
    evidence_collection_mode = not final_authority_mode
    mode_authority_blockers = (
        []
        if final_authority_mode
        else [RUNTIME_LEDGER_PROOF_MODE_NOT_AUTHORITY_BLOCKER]
    )
    mode_authority_failed_checks = (
        [] if final_authority_mode else ["runtime_ledger_proof_mode_authority_required"]
    )
    _check(
        checks,
        "runtime_ledger_proof_mode_contract",
        passed=True,
        observed={
            "proof_mode": resolved_proof_mode,
            "final_authority": final_authority_mode,
            "evidence_collection_only": evidence_collection_mode,
            "evidence_collection_ok": bool(
                proof_mode_targets["evidence_collection_ok"]
            ),
            "canary_collection_authorized": bool(
                proof_mode_targets["canary_collection_authorized"]
            ),
            "mode_contract": proof_mode_contract,
            "promotion_allowed": False,
            "capital_promotion_allowed": False,
            "final_promotion_allowed": False,
        },
        expected="explicit proof mode; only authority mode can grant promotion authority",
        blockers=[],
    )

    status_gate = _status_gate_blocker_summary(status)
    raw_live_blockers = status_gate["raw_blockers"]
    live_blockers = status_gate["proof_blockers"]
    capital_status_blockers = status_gate["capital_promotion_blockers"]
    _check(
        checks,
        "live_status_gate",
        passed=not live_blockers,
        observed={
            "proof_blockers": live_blockers,
            "capital_promotion_blockers": capital_status_blockers,
            "raw_blockers": raw_live_blockers,
        },
        expected=(
            "no live runtime/proof blockers; capital promotion blockers are "
            "reported separately"
        ),
        blockers=live_blockers,
    )
    _extend_unique(blockers, live_blockers)

    plan = _paper_route_target_plan(paper_route_evidence)
    paper_targets = _paper_route_targets(plan)
    paper_import_blockers = _paper_route_import_blockers(plan)
    import_audit = _paper_route_runtime_window_import_audit(paper_route_evidence)
    import_audit_counts = _paper_route_runtime_window_import_audit_counts(import_audit)
    import_audit_blockers = _paper_route_runtime_window_import_audit_blockers(
        import_audit
    )
    import_audit_target_blockers = _paper_route_runtime_window_import_target_blockers(
        import_audit
    )
    source_activity_blockers = _paper_route_source_activity_blockers(
        import_audit_blockers
    )
    health_gate_summary = _runtime_window_import_health_gate_summary(
        plan=plan,
        targets=paper_targets,
    )
    health_gate_blockers = _text_list(health_gate_summary.get("blockers"))
    health_gate_promotion_blockers = _text_list(
        health_gate_summary.get("promotion_blockers")
    )
    handoff = _mapping(plan.get("runtime_window_import_handoff"))
    session_readiness = _mapping(plan.get("session_readiness"))
    import_ready = _bool(session_readiness.get("import_ready")) or _bool(
        handoff.get("import_ready")
    )
    missing_identity_count = _missing_target_identity_count(paper_targets)
    _check(
        checks,
        "paper_route_target_plan_present",
        passed=bool(plan) and bool(paper_targets),
        observed={"plan_present": bool(plan), "target_count": len(paper_targets)},
        expected="paper-route runtime-window target plan with at least one target",
        blockers=[]
        if bool(plan) and bool(paper_targets)
        else ["paper_route_target_plan_missing"],
    )
    if not plan or not paper_targets:
        _extend_unique(blockers, ["paper_route_target_plan_missing"])
    _check(
        checks,
        "paper_route_target_identity",
        passed=bool(paper_targets) and missing_identity_count == 0,
        observed={"missing_identity_count": missing_identity_count},
        expected="all targets carry candidate, hypothesis, strategy, source manifest, and window identity",
        blockers=[]
        if missing_identity_count == 0
        else ["paper_route_target_identity_incomplete"],
    )
    if missing_identity_count:
        _extend_unique(blockers, ["paper_route_target_identity_incomplete"])
    _check(
        checks,
        "paper_route_import_health_gate",
        passed=bool(paper_targets) and bool(health_gate_summary.get("ready")),
        observed=health_gate_summary,
        expected="every paper-route runtime-window target has allow quorum, continuity_ok true, and drift_ok true",
        blockers=health_gate_blockers
        or (
            []
            if bool(paper_targets) and bool(health_gate_summary.get("ready"))
            else ["runtime_window_import_health_gate_missing"]
        ),
    )
    if health_gate_blockers:
        _extend_unique(blockers, health_gate_blockers)
    elif paper_targets and not bool(health_gate_summary.get("ready")):
        _extend_unique(blockers, ["runtime_window_import_health_gate_missing"])
    _check(
        checks,
        "paper_route_import_ready",
        passed=import_ready and not paper_import_blockers and not health_gate_blockers,
        observed={
            "import_ready": import_ready,
            "import_blockers": paper_import_blockers,
            "health_gate_blockers": health_gate_blockers,
        },
        expected="paper-route target window closed, settled, and import-ready",
        blockers=paper_import_blockers
        or health_gate_blockers
        or ([] if import_ready else ["paper_route_import_not_ready"]),
    )
    if paper_import_blockers:
        _extend_unique(blockers, paper_import_blockers)
    elif not import_ready:
        _extend_unique(blockers, ["paper_route_import_not_ready"])

    runtime_import_due = (
        import_ready and not paper_import_blockers and not health_gate_blockers
    )
    deferred_until_runtime_import_due = (
        "deferred_until_paper_route_runtime_window_import_is_due"
    )
    _check(
        checks,
        "paper_route_runtime_window_import_audit",
        passed=not runtime_import_due or bool(import_audit),
        observed={
            "present": bool(import_audit),
            "state": _text(import_audit.get("state"), "missing"),
            "next_action": _text(import_audit.get("next_action")),
            "import_ready": import_audit.get("import_ready"),
            "blockers": import_audit_blockers,
            "target_blockers": import_audit_target_blockers,
        },
        expected="paper-route evidence includes runtime_window_import_audit when import is due",
        blockers=[]
        if (not runtime_import_due or bool(import_audit))
        else ["runtime_window_import_audit_missing"],
        status=None if runtime_import_due else deferred_until_runtime_import_due,
    )
    if runtime_import_due and not import_audit:
        _extend_unique(blockers, ["runtime_window_import_audit_missing"])

    source_target_count = _int(import_audit_counts.get("source_plan_target_count"))
    targets_with_source_activity = _int(
        import_audit_counts.get("targets_with_source_activity")
    )
    source_activity_ok = (
        not runtime_import_due
        or not import_audit
        or (
            source_target_count > 0
            and targets_with_source_activity >= source_target_count
            and not source_activity_blockers
        )
    )
    _check(
        checks,
        "paper_route_source_activity",
        passed=source_activity_ok,
        observed={
            "runtime_import_due": runtime_import_due,
            "source_plan_target_count": source_target_count,
            "targets_with_source_activity": targets_with_source_activity,
            "blockers": source_activity_blockers,
        },
        expected="paper-route source decisions, executions, and TCA exist for every import target when runtime import is due",
        blockers=source_activity_blockers
        or ([] if source_activity_ok else ["paper_route_source_activity_missing"]),
        status=None if runtime_import_due else deferred_until_runtime_import_due,
    )
    if not source_activity_ok:
        _extend_unique(
            blockers,
            source_activity_blockers or ["paper_route_source_activity_missing"],
        )

    runtime_import = _runtime_window_import_payload(runtime_window_import)
    runtime_import_items = _runtime_window_import_items(runtime_import)
    runtime_import_lineage = _runtime_window_import_lineage(
        raw_payload=runtime_window_import,
        payload=runtime_import,
    )
    runtime_import_blockers = _runtime_import_blockers(runtime_import)
    runtime_import_check_blockers = list(runtime_import_blockers)
    if (
        runtime_import_due
        and import_audit
        and not runtime_import_check_blockers
        and import_audit_blockers
    ):
        runtime_import_check_blockers = list(import_audit_blockers)
    authoritative_observation_count = _runtime_import_authoritative_observation_count(
        runtime_import
    )
    materialization_summary = _runtime_import_materialization_summary(runtime_import)
    runtime_import_materialization_ok = not runtime_import_due or (
        _int(materialization_summary.get("authoritative_observation_count")) > 0
        and _int(
            materialization_summary.get(
                "authoritative_runtime_ledger_profit_proof_count"
            )
        )
        > 0
        and _int(materialization_summary.get("materialized_target_count")) > 0
        and _int(materialization_summary.get("unmaterialized_target_count")) == 0
        and _int(materialization_summary.get("missing_target_import_count")) == 0
        and not _text_list(materialization_summary.get("blockers"))
    )
    runtime_import_ok = (
        runtime_import_due
        and bool(runtime_import)
        and _text(runtime_import.get("proof_status"), "blocked") == "ok"
        and not runtime_import_blockers
        and authoritative_observation_count > 0
        and all(
            _text(item.get("proof_status"), "blocked") == "ok"
            for item in runtime_import_items
        )
    )
    _check(
        checks,
        "runtime_window_import_proof",
        passed=runtime_import_ok,
        observed={
            "present": bool(runtime_import),
            "proof_status": _text(runtime_import.get("proof_status"), "missing"),
            "target_count": len(runtime_import_items),
            "runtime_import_due": runtime_import_due,
            "authoritative_observation_count": authoritative_observation_count,
            "materialization": materialization_summary,
            "proof_blockers": runtime_import_blockers,
            "import_audit_state": _text(import_audit.get("state"), "missing"),
            "import_audit_blockers": import_audit_blockers,
        },
        expected="runtime-window import proof_status ok with authoritative runtime observations and no proof blockers",
        blockers=runtime_import_check_blockers
        or (
            []
            if runtime_import_ok or not runtime_import_due
            else ["runtime_window_import_missing"]
        ),
        status=None
        if runtime_import_due
        else "waiting_for_paper_route_runtime_window_import",
    )
    if runtime_import_blockers:
        _extend_unique(blockers, runtime_import_blockers)
    elif runtime_import_due and import_audit_blockers:
        _extend_unique(blockers, import_audit_blockers)
    elif runtime_import_due and not runtime_import_ok:
        _extend_unique(blockers, ["runtime_window_import_missing"])
    materialization_blockers = _text_list(materialization_summary.get("blockers"))
    _check(
        checks,
        "runtime_window_import_materialization",
        passed=runtime_import_materialization_ok,
        observed=materialization_summary,
        expected="every runtime-window import target contains authoritative runtime-ledger profit-proof materialization",
        blockers=materialization_blockers
        or (
            []
            if runtime_import_materialization_ok or not runtime_import_due
            else ["runtime_window_import_runtime_ledger_materialization_missing"]
        ),
        status=None
        if runtime_import_due
        else "waiting_for_paper_route_runtime_window_import",
    )
    if runtime_import_due and not runtime_import_materialization_ok:
        _extend_unique(
            blockers,
            materialization_blockers
            or ["runtime_window_import_runtime_ledger_materialization_missing"],
        )

    completion = completion_status or {}
    live_scale_gate = _completion_live_scale_gate(completion)
    completion_gate_blockers = _completion_blockers(live_scale_gate)
    runtime_summary = _mapping(live_scale_gate.get("runtime_ledger_summary"))
    ledger_refs = _runtime_ledger_refs(
        live_scale_gate, "strategy_runtime_ledger_buckets"
    )
    unbacked_refs = _runtime_ledger_refs(
        live_scale_gate, "runtime_ledger_unbacked_hypothesis_metric_windows"
    )
    gate_satisfied = _text(live_scale_gate.get("status")) == "satisfied"
    _check(
        checks,
        "doc29_live_scale_gate",
        passed=(not runtime_import_due)
        or (gate_satisfied and not completion_gate_blockers),
        observed={
            "gate_present": bool(live_scale_gate),
            "status": _text(live_scale_gate.get("status"), "missing"),
            "runtime_import_due": runtime_import_due,
            "blockers": completion_gate_blockers,
        },
        expected="doc29 live_scale_observed gate satisfied",
        blockers=completion_gate_blockers
        or (
            []
            if gate_satisfied or not runtime_import_due
            else ["doc29_live_scale_gate_not_satisfied"]
        ),
        status=None if runtime_import_due else deferred_until_runtime_import_due,
    )
    if runtime_import_due and completion_gate_blockers:
        _extend_unique(blockers, completion_gate_blockers)
    elif runtime_import_due and not gate_satisfied:
        _extend_unique(blockers, ["doc29_live_scale_gate_not_satisfied"])

    bucket_count = _int(runtime_summary.get("runtime_ledger_bucket_count"))
    fill_count = _int(runtime_summary.get("runtime_ledger_fill_count"))
    closed_trade_count = _int(runtime_summary.get("runtime_ledger_closed_trade_count"))
    closed_round_trip_count = _int(
        runtime_summary.get(
            "runtime_ledger_closed_round_trip_count",
            runtime_summary.get("runtime_ledger_closed_trade_count"),
        )
    )
    open_position_count_present = (
        "runtime_ledger_open_position_count" in runtime_summary
    )
    open_position_count = _int(
        runtime_summary.get("runtime_ledger_open_position_count")
    )
    filled_notional = _decimal(runtime_summary.get("runtime_ledger_filled_notional"))
    cost_amount = _decimal(runtime_summary.get("runtime_ledger_cost_amount"))
    net_pnl = _decimal(
        runtime_summary.get("runtime_ledger_net_strategy_pnl_after_costs")
    )
    expectancy_bps = _decimal(
        runtime_summary.get("runtime_ledger_post_cost_expectancy_bps")
    )
    trading_days = _runtime_ledger_trading_day_count(runtime_summary)
    explicit_mean_daily_net_pnl = _decimal(
        runtime_summary.get("runtime_ledger_mean_daily_net_pnl_after_costs")
    )
    daily_net_pnl = explicit_mean_daily_net_pnl or (
        net_pnl / Decimal(trading_days)
        if net_pnl is not None and trading_days > 0
        else None
    )
    median_daily_net_pnl = _decimal(
        runtime_summary.get("runtime_ledger_median_daily_net_pnl_after_costs")
    )
    p10_daily_net_pnl = _decimal(
        runtime_summary.get("runtime_ledger_p10_daily_net_pnl_after_costs")
    )
    worst_day_net_pnl = _decimal(
        runtime_summary.get("runtime_ledger_worst_day_net_pnl_after_costs")
    )
    drawdown_pct, drawdown_source = _first_decimal(
        runtime_summary,
        (
            "runtime_ledger_max_drawdown_pct_equity",
            "runtime_ledger_drawdown_pct_equity",
            "max_drawdown_pct_equity",
            "drawdown_pct_equity",
        ),
    )
    max_intraday_drawdown, max_intraday_drawdown_source = _first_decimal(
        runtime_summary,
        (
            "runtime_ledger_max_intraday_drawdown",
            "max_intraday_drawdown",
        ),
    )
    best_day_share, best_day_share_source = _first_decimal(
        runtime_summary,
        (
            "runtime_ledger_best_day_share",
            "runtime_ledger_max_single_day_contribution_share",
            "best_day_share",
            "max_single_day_contribution_share",
        ),
    )
    symbol_concentration_share, symbol_concentration_source = _first_decimal(
        runtime_summary,
        (
            "runtime_ledger_symbol_concentration_share",
            "symbol_concentration_share",
        ),
    )
    avg_daily_filled_notional = _decimal(
        runtime_summary.get("runtime_ledger_avg_daily_filled_notional")
    )
    source_authority_bucket_count = _int(
        runtime_summary.get("runtime_ledger_source_authority_bucket_count")
    )
    source_authority_blockers = _text_list(
        runtime_summary.get("runtime_ledger_source_authority_blockers")
    )
    authority_blockers_from_summary = _text_list(
        runtime_summary.get("runtime_ledger_authority_blockers")
    )
    _extend_unique(
        authority_blockers_from_summary,
        _text_list(runtime_summary.get("runtime_ledger_profit_authority_blockers")),
    )
    ledger_schema_versions = _text_list(
        runtime_summary.get("runtime_ledger_schema_versions")
    )
    cost_basis_counts = _mapping(
        runtime_summary.get("runtime_ledger_cost_basis_counts")
    )
    cost_model_hash_count = _int(
        runtime_summary.get("runtime_ledger_cost_model_hash_count")
    )
    target_implied_avg_daily_filled_notional = (
        min_runtime_ledger_daily_net_pnl * Decimal("10000") / expectancy_bps
        if expectancy_bps is not None and expectancy_bps > 0
        else None
    )
    _check(
        checks,
        "runtime_ledger_db_refs",
        passed=(not runtime_import_due) or (bool(ledger_refs) and not unbacked_refs),
        observed={
            "runtime_import_due": runtime_import_due,
            "strategy_runtime_ledger_buckets": ledger_refs,
            "unbacked_metric_windows": unbacked_refs,
        },
        expected="runtime ledger bucket db refs present and unbacked windows empty",
        blockers=[]
        if (bool(ledger_refs) and not unbacked_refs) or not runtime_import_due
        else ["runtime_ledger_db_refs_missing_or_unbacked"],
        status=None if runtime_import_due else deferred_until_runtime_import_due,
    )
    if runtime_import_due and (not ledger_refs or unbacked_refs):
        _extend_unique(blockers, ["runtime_ledger_db_refs_missing_or_unbacked"])
    lifecycle_blockers: list[str] = []
    if runtime_import_due and bucket_count <= 0:
        lifecycle_blockers.append("runtime_ledger_bucket_count_zero")
    if runtime_import_due and fill_count <= 0:
        lifecycle_blockers.append("runtime_ledger_fill_count_zero")
    if runtime_import_due and closed_trade_count <= 0:
        lifecycle_blockers.append("runtime_ledger_closed_trade_count_zero")
    if runtime_import_due and (filled_notional is None or filled_notional <= 0):
        lifecycle_blockers.append("runtime_ledger_filled_notional_missing")
    if runtime_import_due and (expectancy_bps is None or expectancy_bps <= 0):
        lifecycle_blockers.append("runtime_ledger_post_cost_expectancy_not_positive")
    _check(
        checks,
        "runtime_ledger_lifecycle_counts",
        passed=not lifecycle_blockers,
        observed={
            "runtime_import_due": runtime_import_due,
            "bucket_count": bucket_count,
            "fill_count": fill_count,
            "closed_trade_count": closed_trade_count,
            "closed_round_trip_count": closed_round_trip_count,
            "open_position_count": open_position_count
            if open_position_count_present
            else None,
            "filled_notional": _decimal_text(filled_notional),
            "cost_amount": _decimal_text(cost_amount),
            "post_cost_expectancy_bps": _decimal_text(expectancy_bps),
        },
        expected="positive buckets, fills, closed trips, filled notional, and post-cost expectancy",
        blockers=lifecycle_blockers,
        status=None if runtime_import_due else deferred_until_runtime_import_due,
    )
    _extend_unique(blockers, lifecycle_blockers)
    authority_mechanical_blockers: list[str] = []
    if runtime_import_due and final_authority_mode:
        if closed_round_trip_count < min_runtime_ledger_closed_round_trips:
            authority_mechanical_blockers.append(
                "runtime_ledger_closed_round_trips_below_authority_floor"
            )
        if (
            filled_notional is None
            or filled_notional < min_runtime_ledger_filled_notional
        ):
            authority_mechanical_blockers.append(
                "runtime_ledger_filled_notional_below_authority_floor"
            )
        if not open_position_count_present:
            authority_mechanical_blockers.append(
                "runtime_ledger_open_position_count_missing"
            )
        elif open_position_count != 0:
            authority_mechanical_blockers.append(
                "runtime_ledger_open_position_count_nonzero"
            )
        if cost_amount is None or (
            not cost_basis_counts and cost_model_hash_count <= 0
        ):
            authority_mechanical_blockers.append(
                "runtime_ledger_explicit_costs_missing"
            )
        if source_authority_bucket_count < max(1, bucket_count):
            authority_mechanical_blockers.append(
                "runtime_ledger_source_authority_missing"
            )
        _extend_unique(authority_mechanical_blockers, source_authority_blockers)
        if authority_blockers_from_summary:
            authority_mechanical_blockers.append(
                "runtime_ledger_authority_blockers_present"
            )
        if "torghut.exact_replay_ledger.v1" in ledger_schema_versions:
            authority_mechanical_blockers.append(
                "runtime_ledger_exact_replay_schema_not_authority"
            )
    _check(
        checks,
        "runtime_ledger_authority_mechanical_floor",
        passed=not authority_mechanical_blockers,
        observed={
            "runtime_import_due": runtime_import_due,
            "final_authority": final_authority_mode,
            "closed_round_trip_count": closed_round_trip_count,
            "filled_notional": _decimal_text(filled_notional),
            "open_position_count": open_position_count
            if open_position_count_present
            else None,
            "cost_amount": _decimal_text(cost_amount),
            "cost_basis_counts": dict(cost_basis_counts),
            "cost_model_hash_count": cost_model_hash_count,
            "source_authority_bucket_count": source_authority_bucket_count,
            "source_authority_blockers": source_authority_blockers,
            "authority_blockers": authority_blockers_from_summary,
            "ledger_schema_versions": ledger_schema_versions,
        },
        expected={
            "min_closed_round_trips": min_runtime_ledger_closed_round_trips,
            "min_filled_notional": _decimal_text(min_runtime_ledger_filled_notional),
            "open_position_count": 0,
            "explicit_costs": True,
            "source_backed_runtime_ledger_refs": True,
            "authority_blockers": [],
            "non_authority_schema_versions": ["torghut.exact_replay_ledger.v1"],
        },
        blockers=authority_mechanical_blockers,
        status=None if runtime_import_due else deferred_until_runtime_import_due,
    )
    _extend_unique(blockers, authority_mechanical_blockers)
    pnl_blockers: list[str] = []
    if runtime_import_due and (net_pnl is None or net_pnl < min_runtime_ledger_net_pnl):
        pnl_blockers.append("runtime_ledger_net_pnl_below_target")
    if runtime_import_due and trading_days < min_runtime_ledger_trading_days:
        pnl_blockers.append("runtime_ledger_trading_days_below_target")
    if runtime_import_due and (
        daily_net_pnl is None or daily_net_pnl < min_runtime_ledger_daily_net_pnl
    ):
        pnl_blockers.append("runtime_ledger_mean_daily_net_pnl_after_costs_below_floor")
    _check(
        checks,
        "runtime_ledger_post_cost_profit_target",
        passed=not pnl_blockers,
        observed={
            "runtime_import_due": runtime_import_due,
            "net_pnl_after_costs": _decimal_text(net_pnl),
            "trading_days": trading_days,
            "mean_daily_net_pnl_after_costs": _decimal_text(daily_net_pnl),
            "mean_daily_net_pnl_after_costs_source": (
                "runtime_ledger_mean_daily_net_pnl_after_costs"
                if explicit_mean_daily_net_pnl is not None
                else "computed_from_total_net_pnl"
                if daily_net_pnl is not None
                else "missing"
            ),
        },
        expected={
            "min_net_pnl_after_costs": _decimal_text(min_runtime_ledger_net_pnl),
            "min_trading_days": min_runtime_ledger_trading_days,
            "min_daily_net_pnl_after_costs": _decimal_text(
                min_runtime_ledger_daily_net_pnl
            ),
        },
        blockers=pnl_blockers,
        status=None if runtime_import_due else deferred_until_runtime_import_due,
    )
    _extend_unique(blockers, pnl_blockers)
    daily_distribution_blockers: list[str] = []
    if runtime_import_due and final_authority_mode:
        if median_daily_net_pnl is None:
            daily_distribution_blockers.append(
                "runtime_ledger_median_daily_net_pnl_after_costs_missing"
            )
        elif (
            median_daily_net_pnl
            < DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.authority_min_median_daily_net_pnl_after_costs
        ):
            daily_distribution_blockers.append(
                "runtime_ledger_median_daily_net_pnl_after_costs_below_floor"
            )
        if p10_daily_net_pnl is None:
            daily_distribution_blockers.append(
                "runtime_ledger_p10_daily_net_pnl_after_costs_missing"
            )
        elif (
            p10_daily_net_pnl
            < DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.authority_min_p10_daily_net_pnl_after_costs
        ):
            daily_distribution_blockers.append(
                "runtime_ledger_p10_daily_net_pnl_after_costs_below_floor"
            )
        if worst_day_net_pnl is None:
            daily_distribution_blockers.append(
                "runtime_ledger_worst_day_net_pnl_after_costs_missing"
            )
        elif (
            worst_day_net_pnl
            < DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.authority_min_worst_day_net_pnl_after_costs
        ):
            daily_distribution_blockers.append(
                "runtime_ledger_worst_day_net_pnl_after_costs_below_floor"
            )
    _check(
        checks,
        "runtime_ledger_daily_distribution_authority",
        passed=not daily_distribution_blockers,
        observed={
            "runtime_import_due": runtime_import_due,
            "final_authority": final_authority_mode,
            "median_daily_net_pnl_after_costs": _decimal_text(median_daily_net_pnl),
            "p10_daily_net_pnl_after_costs": _decimal_text(p10_daily_net_pnl),
            "worst_day_net_pnl_after_costs": _decimal_text(worst_day_net_pnl),
        },
        expected={
            "min_median_daily_net_pnl_after_costs": _decimal_text(
                DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.authority_min_median_daily_net_pnl_after_costs
            ),
            "min_p10_daily_net_pnl_after_costs": _decimal_text(
                DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.authority_min_p10_daily_net_pnl_after_costs
            ),
            "min_worst_day_net_pnl_after_costs": _decimal_text(
                DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.authority_min_worst_day_net_pnl_after_costs
            ),
        },
        blockers=daily_distribution_blockers,
        status=None if runtime_import_due else deferred_until_runtime_import_due,
    )
    _extend_unique(blockers, daily_distribution_blockers)
    scale_blockers: list[str] = []
    if runtime_import_due and final_authority_mode:
        if avg_daily_filled_notional is None:
            scale_blockers.append("runtime_ledger_avg_daily_filled_notional_missing")
        elif (
            target_implied_avg_daily_filled_notional is not None
            and avg_daily_filled_notional < target_implied_avg_daily_filled_notional
        ):
            scale_blockers.append(
                "runtime_ledger_avg_daily_filled_notional_below_target_implied_floor"
            )
    _check(
        checks,
        "runtime_ledger_target_implied_scale",
        passed=not scale_blockers,
        observed={
            "runtime_import_due": runtime_import_due,
            "final_authority": final_authority_mode,
            "post_cost_expectancy_bps": _decimal_text(expectancy_bps),
            "avg_daily_filled_notional": _decimal_text(avg_daily_filled_notional),
            "target_implied_avg_daily_filled_notional": _decimal_text(
                target_implied_avg_daily_filled_notional
            ),
            "target_implied_avg_daily_filled_notional_basis": (
                "min_runtime_ledger_daily_net_pnl_after_costs / "
                "observed_post_cost_expectancy_bps"
                if target_implied_avg_daily_filled_notional is not None
                else None
            ),
        },
        expected={
            "min_runtime_ledger_daily_net_pnl_after_costs": _decimal_text(
                min_runtime_ledger_daily_net_pnl
            ),
            "formula": (
                "required_daily_notional = min_daily_net_pnl_after_costs "
                "/ (observed_post_cost_expectancy_bps / 10000)"
            ),
        },
        blockers=scale_blockers,
        status=None if runtime_import_due else deferred_until_runtime_import_due,
    )
    _extend_unique(blockers, scale_blockers)
    risk_blockers: list[str] = []
    drawdown_pct_ok = (
        drawdown_pct is not None
        and drawdown_pct <= max_runtime_ledger_drawdown_pct_equity
    )
    intraday_drawdown_ok = (
        max_intraday_drawdown is not None
        and max_intraday_drawdown
        <= DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.authority_max_intraday_drawdown
    )
    if runtime_import_due and final_authority_mode:
        if not drawdown_pct_ok and not intraday_drawdown_ok:
            if max_intraday_drawdown is None:
                risk_blockers.append("runtime_ledger_max_intraday_drawdown_missing")
            elif (
                max_intraday_drawdown
                > DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.authority_max_intraday_drawdown
            ):
                risk_blockers.append("runtime_ledger_max_intraday_drawdown_above_limit")
            if drawdown_pct is None:
                risk_blockers.append("runtime_ledger_drawdown_pct_equity_missing")
            elif drawdown_pct > max_runtime_ledger_drawdown_pct_equity:
                risk_blockers.append("runtime_ledger_drawdown_pct_equity_above_limit")
    elif runtime_import_due:
        if drawdown_pct is None:
            risk_blockers.append("runtime_ledger_drawdown_pct_equity_missing")
        elif drawdown_pct > max_runtime_ledger_drawdown_pct_equity:
            risk_blockers.append("runtime_ledger_drawdown_pct_equity_above_limit")
    if runtime_import_due and best_day_share is None:
        risk_blockers.append("runtime_ledger_best_day_share_missing")
    elif (
        runtime_import_due
        and best_day_share is not None
        and best_day_share > max_runtime_ledger_best_day_share
    ):
        risk_blockers.append("runtime_ledger_best_day_share_above_limit")
    if runtime_import_due and symbol_concentration_share is None:
        risk_blockers.append("runtime_ledger_symbol_concentration_share_missing")
    elif (
        runtime_import_due
        and symbol_concentration_share is not None
        and symbol_concentration_share > max_runtime_ledger_symbol_concentration_share
    ):
        risk_blockers.append("runtime_ledger_symbol_concentration_share_above_limit")
    _check(
        checks,
        "runtime_ledger_risk_quality",
        passed=not risk_blockers,
        observed={
            "runtime_import_due": runtime_import_due,
            "drawdown_pct_equity": _decimal_text(drawdown_pct),
            "drawdown_pct_equity_source": drawdown_source,
            "max_intraday_drawdown": _decimal_text(max_intraday_drawdown),
            "max_intraday_drawdown_source": max_intraday_drawdown_source,
            "best_day_share": _decimal_text(best_day_share),
            "best_day_share_source": best_day_share_source,
            "symbol_concentration_share": _decimal_text(symbol_concentration_share),
            "symbol_concentration_share_source": symbol_concentration_source,
            "authority_drawdown_limit_satisfied": (
                drawdown_pct_ok or intraday_drawdown_ok
            )
            if final_authority_mode
            else None,
        },
        expected={
            "max_drawdown_pct_equity": _decimal_text(
                max_runtime_ledger_drawdown_pct_equity
            ),
            "max_intraday_drawdown": _decimal_text(
                DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.authority_max_intraday_drawdown
            ),
            "max_best_day_share": _decimal_text(max_runtime_ledger_best_day_share),
            "max_symbol_concentration_share": _decimal_text(
                max_runtime_ledger_symbol_concentration_share
            ),
        },
        blockers=risk_blockers,
        status=None if runtime_import_due else deferred_until_runtime_import_due,
    )
    _extend_unique(blockers, risk_blockers)

    hpairs_source_proof_census_status = _hpairs_source_proof_census_status(
        hpairs_source_proof_census
    )
    hpairs_census_blockers = _text_list(
        hpairs_source_proof_census_status.get("blockers")
    )
    hpairs_census_present = bool(hpairs_source_proof_census_status.get("present"))
    hpairs_census_ok = (not hpairs_census_present) or bool(
        hpairs_source_proof_census_status.get("census_ready")
    )
    _check(
        checks,
        "hpairs_source_proof_census_status",
        passed=hpairs_census_ok,
        observed=hpairs_source_proof_census_status,
        expected=(
            "attached read-only H-PAIRS source-proof census with no blockers; "
            "census is evidence/status only and cannot grant authority by itself"
        ),
        blockers=hpairs_census_blockers
        or (
            []
            if hpairs_census_ok or not hpairs_census_present
            else ["hpairs_source_proof_census_not_ready"]
        ),
        status="non_authority_evidence_status",
    )
    _extend_unique(
        blockers,
        hpairs_census_blockers
        or (
            []
            if hpairs_census_ok or not hpairs_census_present
            else ["hpairs_source_proof_census_not_ready"]
        ),
    )

    tigerbeetle_status = _mapping(
        status.get("tigerbeetle_ledger") or status.get("tigerbeetle")
    )
    latest_tigerbeetle_reconciliation = _mapping(
        tigerbeetle_status.get("latest_reconciliation")
    )
    tigerbeetle_ref_counts = _mapping(
        tigerbeetle_status.get("ref_counts")
        or latest_tigerbeetle_reconciliation.get("ref_counts")
    )
    tigerbeetle_claimed = (
        _bool(tigerbeetle_status.get("enabled"))
        or _bool(tigerbeetle_status.get("required"))
        or _bool(tigerbeetle_status.get("journal_enabled"))
        or _bool(tigerbeetle_status.get("reconcile_required"))
        # Runtime-import TigerBeetle refs are proof artifacts; require live
        # reconciliation status only when the status or completion gate claims
        # TigerBeetle authority.
        or _contains_tigerbeetle_claim(live_scale_gate)
    )
    tigerbeetle_required_for_authority = (
        final_authority_mode and tigerbeetle_claimed and runtime_import_due
    )
    tigerbeetle_blockers = _text_list(tigerbeetle_status.get("blockers"))
    if tigerbeetle_required_for_authority:
        if not latest_tigerbeetle_reconciliation:
            _extend_unique(tigerbeetle_blockers, ["tigerbeetle_reconciliation_missing"])
        elif not _bool(latest_tigerbeetle_reconciliation.get("ok")):
            _extend_unique(tigerbeetle_blockers, ["tigerbeetle_reconciliation_not_ok"])
        _extend_unique(
            tigerbeetle_blockers,
            _text_list(latest_tigerbeetle_reconciliation.get("blockers")),
        )
        required_runtime_ref_count = max(1, len(ledger_refs))
        runtime_ref_count = _int(tigerbeetle_ref_counts.get("runtime_ledger_ref_count"))
        signed_ref_count = _int(
            latest_tigerbeetle_reconciliation.get(
                "runtime_ledger_signed_transfer_count"
            )
        )
        if runtime_ref_count < required_runtime_ref_count:
            _extend_unique(
                tigerbeetle_blockers, ["tigerbeetle_runtime_ledger_refs_missing"]
            )
        if signed_ref_count < required_runtime_ref_count:
            _extend_unique(
                tigerbeetle_blockers,
                ["tigerbeetle_runtime_ledger_signed_refs_missing"],
            )
    else:
        required_runtime_ref_count = 0
        runtime_ref_count = _int(tigerbeetle_ref_counts.get("runtime_ledger_ref_count"))
        signed_ref_count = _int(
            latest_tigerbeetle_reconciliation.get(
                "runtime_ledger_signed_transfer_count"
            )
        )
    _check(
        checks,
        "tigerbeetle_runtime_pnl_authority_refs",
        passed=not tigerbeetle_required_for_authority or not tigerbeetle_blockers,
        observed={
            "claimed": tigerbeetle_claimed,
            "required_for_authority": tigerbeetle_required_for_authority,
            "runtime_import_due": runtime_import_due,
            "enabled": tigerbeetle_status.get("enabled"),
            "required": tigerbeetle_status.get("required"),
            "journal_enabled": tigerbeetle_status.get("journal_enabled"),
            "reconcile_required": tigerbeetle_status.get("reconcile_required"),
            "status_ok": tigerbeetle_status.get("ok"),
            "reconciliation_ok": tigerbeetle_status.get("reconciliation_ok"),
            "required_runtime_ledger_ref_count": required_runtime_ref_count,
            "runtime_ledger_ref_count": runtime_ref_count,
            "runtime_ledger_signed_transfer_count": signed_ref_count,
            "latest_reconciliation": dict(latest_tigerbeetle_reconciliation),
            "blockers": tigerbeetle_blockers,
        },
        expected=(
            "authority packets require reconciled signed TigerBeetle runtime-ledger "
            "PnL refs when TigerBeetle is enabled or claimed"
        ),
        blockers=tigerbeetle_blockers,
        status=None
        if tigerbeetle_required_for_authority
        else "not_claimed_not_due_or_not_authority_mode",
    )
    if tigerbeetle_required_for_authority:
        _extend_unique(blockers, tigerbeetle_blockers)

    failed_checks = [key for key, value in checks.items() if not value["passed"]]
    post_cost_proof_satisfied = not failed_checks
    post_cost_proof_authority_allowed = (
        post_cost_proof_satisfied and final_authority_mode
    )
    authority_blockers = list(blockers)
    _extend_unique(authority_blockers, mode_authority_blockers)
    authority_failed_checks = list(failed_checks)
    _extend_unique(authority_failed_checks, mode_authority_failed_checks)
    promotion_prerequisite_blockers = list(mode_authority_blockers)
    _extend_unique(promotion_prerequisite_blockers, capital_status_blockers)
    _extend_unique(promotion_prerequisite_blockers, health_gate_promotion_blockers)
    capital_promotion_allowed = (
        post_cost_proof_authority_allowed and not promotion_prerequisite_blockers
    )
    capital_promotion_failed_checks: list[str] = []
    if mode_authority_blockers:
        capital_promotion_failed_checks.append(
            "runtime_ledger_proof_mode_authority_required"
        )
    if capital_status_blockers:
        capital_promotion_failed_checks.append("capital_promotion_gate")
    if health_gate_promotion_blockers:
        capital_promotion_failed_checks.append("paper_route_promotion_health_gate")
    promotion_failed_checks = list(failed_checks)
    _extend_unique(promotion_failed_checks, capital_promotion_failed_checks)
    promotion_blockers = list(blockers)
    _extend_unique(promotion_blockers, promotion_prerequisite_blockers)
    waiting_blockers = {
        "paper_route_session_window_not_open",
        "paper_route_session_window_not_closed",
        "paper_route_session_settlement_pending",
        "paper_route_import_not_ready",
    }
    if post_cost_proof_authority_allowed and not promotion_prerequisite_blockers:
        verdict = "promotion_authority_allowed"
        reason = "runtime_ledger_live_paper_post_cost_proof_satisfied"
        promotion_reason = reason
        capital_reason = "live_capital_promotion_gate_clear"
    elif post_cost_proof_authority_allowed:
        verdict = "post_cost_proof_authority_allowed_capital_promotion_blocked"
        reason = (
            "runtime_ledger_live_paper_post_cost_proof_satisfied_"
            "capital_promotion_blocked"
        )
        promotion_reason = "live_capital_promotion_gate_blocked"
        capital_reason = "live_capital_promotion_gate_blocked"
    elif post_cost_proof_satisfied and not final_authority_mode:
        verdict = f"{resolved_proof_mode}_proof_satisfied_evidence_collection_only"
        reason = f"runtime_ledger_{resolved_proof_mode}_proof_satisfied"
        promotion_reason = RUNTIME_LEDGER_PROOF_MODE_NOT_AUTHORITY_BLOCKER
        capital_reason = RUNTIME_LEDGER_PROOF_MODE_NOT_AUTHORITY_BLOCKER
    elif set(blockers).issubset(waiting_blockers):
        verdict = "waiting_for_runtime_window"
        reason = "paper_route_runtime_window_not_importable_yet"
        promotion_reason = reason
        capital_reason = "post_cost_proof_not_satisfied"
    else:
        verdict = "blocked"
        reason = "runtime_ledger_live_paper_post_cost_proof_blocked"
        promotion_reason = reason
        capital_reason = "post_cost_proof_not_satisfied"
    required_actions = _required_actions(promotion_blockers, verdict=verdict)
    candidate_identity = _first_identity(
        paper_targets=paper_targets,
        runtime_import=runtime_import,
        completion_gate=live_scale_gate,
    )
    immutable_lineage = _runtime_ledger_immutable_lineage(
        identity=candidate_identity,
        paper_targets=paper_targets,
        runtime_import=runtime_import,
        runtime_summary=runtime_summary,
        ledger_refs=ledger_refs,
        unbacked_refs=unbacked_refs,
        materialization_summary=materialization_summary,
    )

    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": generated_at,
        "proof_mode": resolved_proof_mode,
        "proof_mode_contract": proof_mode_contract,
        "verdict": verdict,
        "ok": post_cost_proof_satisfied,
        "final_authority_ok": post_cost_proof_authority_allowed,
        "evidence_collection_only": evidence_collection_mode,
        "evidence_collection_ok": evidence_collection_mode
        and post_cost_proof_satisfied,
        "canary_collection_authorized": resolved_proof_mode == "probation"
        and post_cost_proof_satisfied,
        "promotion_allowed": capital_promotion_allowed,
        "capital_promotion_allowed": capital_promotion_allowed,
        "final_promotion_allowed": capital_promotion_allowed,
        "authority_blockers": authority_blockers,
        "blockers": promotion_blockers,
        "next_action": required_actions[0] if required_actions else "none",
        "post_cost_proof_authority": {
            "allowed": post_cost_proof_authority_allowed,
            "proof_satisfied": post_cost_proof_satisfied,
            "reason": reason,
            "blocking_reasons": authority_blockers,
            "failed_checks": authority_failed_checks,
        },
        "capital_promotion_authority": {
            "allowed": capital_promotion_allowed,
            "reason": capital_reason,
            "blocking_reasons": promotion_prerequisite_blockers,
            "proof_prerequisite_blocking_reasons": authority_blockers,
            "failed_checks": capital_promotion_failed_checks
            if post_cost_proof_authority_allowed
            else promotion_failed_checks,
        },
        "promotion_authority": {
            "allowed": capital_promotion_allowed,
            "reason": promotion_reason,
            "blocking_reasons": promotion_blockers,
            "failed_checks": promotion_failed_checks,
        },
        "target": {
            "proof_mode": resolved_proof_mode,
            "final_authority": final_authority_mode,
            "evidence_collection_only": evidence_collection_mode,
            "evidence_collection_ok": bool(
                proof_mode_targets["evidence_collection_ok"]
            ),
            "canary_collection_authorized": bool(
                proof_mode_targets["canary_collection_authorized"]
            ),
            "promotion_allowed": False,
            "capital_promotion_allowed": False,
            "final_promotion_allowed": False,
            "source_backed_runtime_ledger_proof_required": final_authority_mode,
            "non_empty_runtime_ledger_source_refs_required": final_authority_mode,
            "runtime_ledger_import_readback_required": final_authority_mode,
            "min_runtime_ledger_net_pnl_after_costs": _decimal_text(
                min_runtime_ledger_net_pnl
            ),
            "min_runtime_ledger_daily_net_pnl_after_costs": _decimal_text(
                min_runtime_ledger_daily_net_pnl
            ),
            "min_runtime_ledger_trading_days": min_runtime_ledger_trading_days,
            "min_runtime_ledger_closed_round_trips": (
                min_runtime_ledger_closed_round_trips
            ),
            "min_runtime_ledger_filled_notional": _decimal_text(
                min_runtime_ledger_filled_notional
            ),
            "min_runtime_ledger_median_daily_net_pnl_after_costs": _decimal_text(
                DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.authority_min_median_daily_net_pnl_after_costs
            ),
            "min_runtime_ledger_p10_daily_net_pnl_after_costs": _decimal_text(
                DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.authority_min_p10_daily_net_pnl_after_costs
            ),
            "min_runtime_ledger_worst_day_net_pnl_after_costs": _decimal_text(
                DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.authority_min_worst_day_net_pnl_after_costs
            ),
            "max_runtime_ledger_drawdown_pct_equity": _decimal_text(
                max_runtime_ledger_drawdown_pct_equity
            ),
            "max_runtime_ledger_intraday_drawdown": _decimal_text(
                DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.authority_max_intraday_drawdown
            ),
            "max_runtime_ledger_best_day_share": _decimal_text(
                max_runtime_ledger_best_day_share
            ),
            "max_runtime_ledger_symbol_concentration_share": _decimal_text(
                max_runtime_ledger_symbol_concentration_share
            ),
            "target_implied_avg_daily_filled_notional": _decimal_text(
                target_implied_avg_daily_filled_notional
            ),
        },
        "candidate": candidate_identity,
        "lineage": immutable_lineage,
        "required_actions": required_actions,
        "checks": checks,
        "evidence": {
            "status": {
                "mode": status.get("mode"),
                "running": status.get("running"),
                "live_status_blockers": live_blockers,
                "capital_promotion_blockers": promotion_prerequisite_blockers,
                "raw_live_status_blockers": raw_live_blockers,
            },
            "paper_route_target_plan": {
                "schema_version": plan.get("schema_version"),
                "target_count": len(paper_targets),
                "import_ready": import_ready,
                "import_blockers": paper_import_blockers,
                "session_window": _mapping(plan.get("session_window")),
                "runtime_window_import_health_gate": health_gate_summary,
            },
            "paper_route_runtime_window_import_audit": {
                "present": bool(import_audit),
                "state": import_audit.get("state"),
                "next_action": import_audit.get("next_action"),
                "import_ready": import_audit.get("import_ready"),
                "blockers": import_audit_blockers,
                "target_blockers": import_audit_target_blockers,
                "counts": dict(import_audit_counts),
            },
            "runtime_window_import": {
                "present": bool(runtime_import),
                "proof_status": runtime_import.get("proof_status"),
                "target_count": len(runtime_import_items),
                "proof_blockers": runtime_import_blockers,
                "authoritative_observation_count": authoritative_observation_count,
                "materialization": materialization_summary,
                "lineage": runtime_import_lineage,
            },
            "completion_live_scale": {
                "gate_status": live_scale_gate.get("status"),
                "runtime_ledger_summary": dict(runtime_summary),
                "strategy_runtime_ledger_bucket_refs": ledger_refs,
                "unbacked_metric_window_refs": unbacked_refs,
            },
            "hpairs_source_proof_census": hpairs_source_proof_census_status,
        },
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--service-base-url",
        help="Base Torghut service URL used for any source endpoint without a more specific service base URL.",
    )
    parser.add_argument(
        "--status-service-base-url",
        help="Base Torghut live service URL used to fetch /trading/status.",
    )
    parser.add_argument(
        "--paper-route-service-base-url",
        help="Base Torghut paper/sim service URL used to fetch /trading/paper-route-evidence.",
    )
    parser.add_argument(
        "--completion-service-base-url",
        help="Base Torghut live service URL used to fetch /trading/completion/doc29.",
    )
    parser.add_argument(
        "--status-file", type=Path, help="Path to a /trading/status JSON payload."
    )
    parser.add_argument(
        "--status-url", help="URL returning a /trading/status JSON payload."
    )
    parser.add_argument(
        "--paper-route-evidence-file",
        type=Path,
        help="Path to a /trading/paper-route-evidence JSON payload.",
    )
    parser.add_argument(
        "--paper-route-evidence-url",
        help="URL returning a /trading/paper-route-evidence JSON payload.",
    )
    parser.add_argument(
        "--runtime-window-import-file",
        type=Path,
        help="Path to renew_latest_empirical_promotion_jobs.py runtime_window_import JSON output.",
    )
    parser.add_argument(
        "--runtime-window-import-url",
        help="URL returning runtime-window import JSON output.",
    )
    parser.add_argument(
        "--hpairs-source-proof-census-file",
        type=Path,
        help="Path to a read-only audit_hpairs_source_proof_census.py JSON artifact.",
    )
    parser.add_argument(
        "--hpairs-source-proof-census-url",
        help="URL returning a read-only H-PAIRS source-proof census JSON artifact.",
    )
    parser.add_argument(
        "--completion-file",
        type=Path,
        help="Path to a /trading/completion/doc29 JSON payload.",
    )
    parser.add_argument(
        "--completion-url", help="URL returning /trading/completion/doc29 JSON."
    )
    parser.add_argument(
        "--proof-mode",
        choices=RUNTIME_LEDGER_PROOF_MODES,
        default=DEFAULT_RUNTIME_LEDGER_PROOF_MODE,
        help=(
            "Proof packet mode. smoke/probation prove plumbing or bounded "
            "evidence collection only; authority is required for promotion."
        ),
    )
    parser.add_argument(
        "--min-runtime-ledger-net-pnl",
        default=str(DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.min_net_pnl_after_costs),
        help="Minimum total runtime-ledger net strategy PnL after costs.",
    )
    parser.add_argument(
        "--min-runtime-ledger-daily-net-pnl",
        default=str(DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.min_daily_net_pnl_after_costs),
        help="Minimum runtime-ledger net strategy PnL after costs per observed trading day.",
    )
    parser.add_argument(
        "--min-runtime-ledger-trading-days",
        type=int,
        default=DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.min_trading_days,
        help="Minimum observed runtime-ledger trading days.",
    )
    parser.add_argument(
        "--max-runtime-ledger-drawdown-pct-equity",
        default=str(DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.max_drawdown_pct_equity),
        help="Maximum observed runtime-ledger drawdown as a fraction of equity.",
    )
    parser.add_argument(
        "--max-runtime-ledger-best-day-share",
        default=str(DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.max_best_day_share),
        help="Maximum share of post-cost runtime-ledger PnL attributable to one trading day.",
    )
    parser.add_argument(
        "--max-runtime-ledger-symbol-concentration-share",
        default=str(DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.max_symbol_concentration_share),
        help="Maximum share of post-cost runtime-ledger PnL attributable to one symbol.",
    )
    parser.add_argument("--generated-at", default=None)
    parser.add_argument(
        "--timeout-seconds",
        type=float,
        default=DEFAULT_SERVICE_FETCH_TIMEOUT_SECONDS,
        help=(
            "Timeout for service-backed status, paper-route, completion, and "
            "runtime-window import JSON reads."
        ),
    )
    parser.add_argument("--output-file", type=Path, default=None)
    parser.add_argument(
        "--artifact-prefix",
        default="",
        help=(
            "Optional object-store prefix for durable proof packet upload. "
            "Supports {run_id} from the runtime-window import payload and "
            "{generated_at} from the packet timestamp."
        ),
    )
    parser.add_argument(
        "--artifact-name",
        default="runtime-ledger-proof-packet.json",
        help="Object-store file name for --artifact-prefix uploads.",
    )
    parser.add_argument(
        "--require-artifact-upload",
        action="store_true",
        help=(
            "Fail closed unless an artifact prefix, object-store credentials, "
            "and a complete upload receipt are available."
        ),
    )
    parser.add_argument(
        "--allow-blocked-exit-zero",
        action="store_true",
        help=(
            "Exit 0 after writing a blocked/waiting packet. Required source "
            "schema errors still fail; degraded paper-route/completion service "
            "fetches are recorded as proof blockers so scheduled evidence "
            "collection still uploads an honest packet."
        ),
    )
    return parser


def _required_source_args(args: argparse.Namespace) -> None:
    if (args.status_file is None) == (not args.status_url):
        raise SystemExit("exactly_one_status_source_required")
    if (args.paper_route_evidence_file is None) == (not args.paper_route_evidence_url):
        raise SystemExit("exactly_one_paper_route_evidence_source_required")


def _source_kind(path: Path | None, url: str | None) -> str:
    if path is not None:
        return "file"
    if url:
        return "url"
    return "missing"


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    service_default_urls = _apply_service_base_url_defaults(args)
    _required_source_args(args)
    min_net_pnl = _decimal(args.min_runtime_ledger_net_pnl)
    if min_net_pnl is None:
        raise SystemExit(
            f"--min-runtime-ledger-net-pnl must be decimal: {args.min_runtime_ledger_net_pnl!r}"
        )
    min_daily_net_pnl = _decimal(args.min_runtime_ledger_daily_net_pnl)
    if min_daily_net_pnl is None:
        raise SystemExit(
            f"--min-runtime-ledger-daily-net-pnl must be decimal: {args.min_runtime_ledger_daily_net_pnl!r}"
        )
    max_drawdown_pct_equity = _decimal(args.max_runtime_ledger_drawdown_pct_equity)
    if max_drawdown_pct_equity is None:
        raise SystemExit(
            "--max-runtime-ledger-drawdown-pct-equity must be decimal: "
            f"{args.max_runtime_ledger_drawdown_pct_equity!r}"
        )
    max_best_day_share = _decimal(args.max_runtime_ledger_best_day_share)
    if max_best_day_share is None:
        raise SystemExit(
            "--max-runtime-ledger-best-day-share must be decimal: "
            f"{args.max_runtime_ledger_best_day_share!r}"
        )
    max_symbol_concentration_share = _decimal(
        args.max_runtime_ledger_symbol_concentration_share
    )
    if max_symbol_concentration_share is None:
        raise SystemExit(
            "--max-runtime-ledger-symbol-concentration-share must be decimal: "
            f"{args.max_runtime_ledger_symbol_concentration_share!r}"
        )
    status = _load_optional_json_object(
        path=args.status_file,
        url=args.status_url,
        timeout_seconds=args.timeout_seconds,
    )
    paper_route_evidence = _load_optional_json_object(
        path=args.paper_route_evidence_file,
        url=args.paper_route_evidence_url,
        timeout_seconds=args.timeout_seconds,
        unavailable_source_name="paper_route_evidence",
    )
    runtime_window_import = _load_optional_json_object(
        path=args.runtime_window_import_file,
        url=args.runtime_window_import_url,
        timeout_seconds=args.timeout_seconds,
    )
    hpairs_source_proof_census = _load_optional_json_object(
        path=args.hpairs_source_proof_census_file,
        url=args.hpairs_source_proof_census_url,
        timeout_seconds=args.timeout_seconds,
    )
    completion_status = _load_optional_json_object(
        path=args.completion_file,
        url=args.completion_url,
        timeout_seconds=args.timeout_seconds,
        unavailable_source_name="completion",
    )
    assert status is not None
    packet = build_runtime_ledger_proof_packet(
        status,
        proof_mode=args.proof_mode,
        paper_route_evidence=paper_route_evidence,
        runtime_window_import=runtime_window_import,
        hpairs_source_proof_census=hpairs_source_proof_census,
        completion_status=completion_status,
        min_runtime_ledger_net_pnl=min_net_pnl,
        min_runtime_ledger_daily_net_pnl=min_daily_net_pnl,
        min_runtime_ledger_trading_days=max(
            0, int(args.min_runtime_ledger_trading_days)
        ),
        max_runtime_ledger_drawdown_pct_equity=max_drawdown_pct_equity,
        max_runtime_ledger_best_day_share=max_best_day_share,
        max_runtime_ledger_symbol_concentration_share=max_symbol_concentration_share,
        generated_at=args.generated_at,
    )
    if service_default_urls:
        packet["assembly"] = {
            "service_base_url": args.service_base_url,
            "service_base_urls": {
                "status": args.status_service_base_url or args.service_base_url,
                "paper_route_evidence": (
                    args.paper_route_service_base_url or args.service_base_url
                ),
                "completion": args.completion_service_base_url or args.service_base_url,
            },
            "defaulted_urls": service_default_urls,
            "status_source": _source_kind(args.status_file, args.status_url),
            "paper_route_evidence_source": _source_kind(
                args.paper_route_evidence_file,
                args.paper_route_evidence_url,
            ),
            "runtime_window_import_source": _source_kind(
                args.runtime_window_import_file,
                args.runtime_window_import_url,
            ),
            "hpairs_source_proof_census_source": _source_kind(
                args.hpairs_source_proof_census_file,
                args.hpairs_source_proof_census_url,
            ),
            "completion_source": _source_kind(
                args.completion_file, args.completion_url
            ),
        }
    artifact_prefix = _text(args.artifact_prefix)
    encoded_body = (
        _attach_and_upload_artifact(
            packet,
            artifact_prefix=artifact_prefix,
            artifact_name=_text(
                args.artifact_name,
                "runtime-ledger-proof-packet.json",
            ),
            require_artifact_upload=bool(args.require_artifact_upload),
            runtime_window_import=runtime_window_import,
        )
        if artifact_prefix or args.require_artifact_upload
        else json.dumps(packet, indent=2, sort_keys=True).encode("utf-8")
    )
    if args.output_file is not None:
        args.output_file.parent.mkdir(parents=True, exist_ok=True)
        args.output_file.write_bytes(encoded_body + b"\n")
    print(encoded_body.decode("utf-8"))
    return 0 if packet["ok"] or args.allow_blocked_exit_zero else 1


if __name__ == "__main__":
    raise SystemExit(main())
