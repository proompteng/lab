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
import os
import json
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Protocol, cast
from urllib.parse import urljoin
from urllib.request import urlopen


SCHEMA_VERSION = "torghut.runtime-ledger-live-paper-proof-packet.v1"
DOC29_LIVE_SCALE_GATE = "live_scale_observed"
DEFAULT_MIN_RUNTIME_LEDGER_NET_PNL = Decimal("500")
DEFAULT_MIN_RUNTIME_LEDGER_DAILY_NET_PNL = Decimal("500")
DEFAULT_MIN_RUNTIME_LEDGER_TRADING_DAYS = 1
DEFAULT_MAX_RUNTIME_LEDGER_DRAWDOWN_PCT_EQUITY = Decimal("0.08")
DEFAULT_MAX_RUNTIME_LEDGER_BEST_DAY_SHARE = Decimal("0.25")
DEFAULT_MAX_RUNTIME_LEDGER_SYMBOL_CONCENTRATION_SHARE = Decimal("0.50")
STATUS_ENDPOINT = "/trading/status"
PAPER_ROUTE_EVIDENCE_ENDPOINT = "/trading/paper-route-evidence"
COMPLETION_DOC29_ENDPOINT = "/trading/completion/doc29"
ARTIFACT_SCHEMA_VERSION = "torghut.runtime-ledger-proof-packet-artifact.v1"
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
    }
)
CAPITAL_PROMOTION_STATUS_BLOCKER_PREFIXES = (
    "alpha_",
    "promotion_",
    "paper_probation_",
)


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
    with urlopen(url, timeout=timeout_seconds) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, Mapping):
        raise ValueError(f"json_object_required:{url}")
    return {str(key): value for key, value in cast(Mapping[str, Any], payload).items()}


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
    encoded = json.dumps(packet, indent=2, sort_keys=True).encode("utf-8")
    if client is not None:
        client.put_object(
            bucket=bucket,
            key=key,
            body=encoded,
            content_type="application/json",
        )
    return encoded


def _load_optional_json_object(
    *,
    path: Path | None,
    url: str | None,
    timeout_seconds: float,
) -> dict[str, Any] | None:
    if path is not None:
        return _load_json_object(path)
    if url:
        return _load_json_url(url, timeout_seconds=timeout_seconds)
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
    plan = _mapping(evidence.get("next_paper_route_runtime_window_targets"))
    if plan:
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
            "runtime_ledger_bucket_missing",
            "paper_route_runtime_ledger_import_pending",
        }:
            _extend_unique(
                actions, ["run_runtime_window_import_from_paper_route_target_plan"]
            )
        elif blocker in {
            "runtime_ledger_net_pnl_below_target",
            "runtime_ledger_daily_net_pnl_below_target",
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
        }:
            _extend_unique(
                actions,
                ["improve_runtime_ledger_drawdown_concentration_or_position_sizing"],
            )
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
    paper_route_evidence: Mapping[str, Any] | None = None,
    runtime_window_import: Mapping[str, Any] | None = None,
    completion_status: Mapping[str, Any] | None = None,
    min_runtime_ledger_net_pnl: Decimal = DEFAULT_MIN_RUNTIME_LEDGER_NET_PNL,
    min_runtime_ledger_daily_net_pnl: Decimal = DEFAULT_MIN_RUNTIME_LEDGER_DAILY_NET_PNL,
    min_runtime_ledger_trading_days: int = DEFAULT_MIN_RUNTIME_LEDGER_TRADING_DAYS,
    max_runtime_ledger_drawdown_pct_equity: Decimal = (
        DEFAULT_MAX_RUNTIME_LEDGER_DRAWDOWN_PCT_EQUITY
    ),
    max_runtime_ledger_best_day_share: Decimal = (
        DEFAULT_MAX_RUNTIME_LEDGER_BEST_DAY_SHARE
    ),
    max_runtime_ledger_symbol_concentration_share: Decimal = (
        DEFAULT_MAX_RUNTIME_LEDGER_SYMBOL_CONCENTRATION_SHARE
    ),
    generated_at: str | None = None,
) -> dict[str, Any]:
    checks: dict[str, dict[str, Any]] = {}
    blockers: list[str] = []
    generated_at = generated_at or _utc_now()

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
    if completion_gate_blockers:
        _extend_unique(blockers, completion_gate_blockers)
    elif runtime_import_due and not gate_satisfied:
        _extend_unique(blockers, ["doc29_live_scale_gate_not_satisfied"])

    bucket_count = _int(runtime_summary.get("runtime_ledger_bucket_count"))
    fill_count = _int(runtime_summary.get("runtime_ledger_fill_count"))
    closed_trade_count = _int(runtime_summary.get("runtime_ledger_closed_trade_count"))
    filled_notional = _decimal(runtime_summary.get("runtime_ledger_filled_notional"))
    net_pnl = _decimal(
        runtime_summary.get("runtime_ledger_net_strategy_pnl_after_costs")
    )
    expectancy_bps = _decimal(
        runtime_summary.get("runtime_ledger_post_cost_expectancy_bps")
    )
    trading_days = _runtime_ledger_trading_day_count(runtime_summary)
    daily_net_pnl = (
        net_pnl / Decimal(trading_days)
        if net_pnl is not None and trading_days > 0
        else None
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
            "filled_notional": _decimal_text(filled_notional),
            "post_cost_expectancy_bps": _decimal_text(expectancy_bps),
        },
        expected="positive buckets, fills, closed trips, filled notional, and post-cost expectancy",
        blockers=lifecycle_blockers,
        status=None if runtime_import_due else deferred_until_runtime_import_due,
    )
    _extend_unique(blockers, lifecycle_blockers)
    pnl_blockers: list[str] = []
    if runtime_import_due and (net_pnl is None or net_pnl < min_runtime_ledger_net_pnl):
        pnl_blockers.append("runtime_ledger_net_pnl_below_target")
    if runtime_import_due and trading_days < min_runtime_ledger_trading_days:
        pnl_blockers.append("runtime_ledger_trading_days_below_target")
    if runtime_import_due and (
        daily_net_pnl is None or daily_net_pnl < min_runtime_ledger_daily_net_pnl
    ):
        pnl_blockers.append("runtime_ledger_daily_net_pnl_below_target")
    _check(
        checks,
        "runtime_ledger_post_cost_profit_target",
        passed=not pnl_blockers,
        observed={
            "runtime_import_due": runtime_import_due,
            "net_pnl_after_costs": _decimal_text(net_pnl),
            "trading_days": trading_days,
            "daily_net_pnl_after_costs": _decimal_text(daily_net_pnl),
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
    risk_blockers: list[str] = []
    if runtime_import_due and drawdown_pct is None:
        risk_blockers.append("runtime_ledger_drawdown_pct_equity_missing")
    elif (
        runtime_import_due
        and drawdown_pct is not None
        and drawdown_pct > max_runtime_ledger_drawdown_pct_equity
    ):
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
            "best_day_share": _decimal_text(best_day_share),
            "best_day_share_source": best_day_share_source,
            "symbol_concentration_share": _decimal_text(symbol_concentration_share),
            "symbol_concentration_share_source": symbol_concentration_source,
        },
        expected={
            "max_drawdown_pct_equity": _decimal_text(
                max_runtime_ledger_drawdown_pct_equity
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

    failed_checks = [key for key, value in checks.items() if not value["passed"]]
    post_cost_proof_allowed = not failed_checks
    promotion_prerequisite_blockers = list(capital_status_blockers)
    _extend_unique(promotion_prerequisite_blockers, health_gate_promotion_blockers)
    capital_promotion_allowed = (
        post_cost_proof_allowed and not promotion_prerequisite_blockers
    )
    capital_promotion_failed_checks: list[str] = []
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
    if post_cost_proof_allowed and not capital_status_blockers:
        verdict = "promotion_authority_allowed"
        reason = "runtime_ledger_live_paper_post_cost_proof_satisfied"
        promotion_reason = reason
        capital_reason = "live_capital_promotion_gate_clear"
    elif post_cost_proof_allowed:
        verdict = "post_cost_proof_authority_allowed_capital_promotion_blocked"
        reason = (
            "runtime_ledger_live_paper_post_cost_proof_satisfied_"
            "capital_promotion_blocked"
        )
        promotion_reason = "live_capital_promotion_gate_blocked"
        capital_reason = "live_capital_promotion_gate_blocked"
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

    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": generated_at,
        "verdict": verdict,
        "ok": post_cost_proof_allowed,
        "post_cost_proof_authority": {
            "allowed": post_cost_proof_allowed,
            "reason": reason,
            "blocking_reasons": blockers,
            "failed_checks": failed_checks,
        },
        "capital_promotion_authority": {
            "allowed": capital_promotion_allowed,
            "reason": capital_reason,
            "blocking_reasons": promotion_prerequisite_blockers,
            "proof_prerequisite_blocking_reasons": blockers,
            "failed_checks": capital_promotion_failed_checks
            if post_cost_proof_allowed
            else promotion_failed_checks,
        },
        "promotion_authority": {
            "allowed": capital_promotion_allowed,
            "reason": promotion_reason,
            "blocking_reasons": promotion_blockers,
            "failed_checks": promotion_failed_checks,
        },
        "target": {
            "min_runtime_ledger_net_pnl_after_costs": _decimal_text(
                min_runtime_ledger_net_pnl
            ),
            "min_runtime_ledger_daily_net_pnl_after_costs": _decimal_text(
                min_runtime_ledger_daily_net_pnl
            ),
            "min_runtime_ledger_trading_days": min_runtime_ledger_trading_days,
            "max_runtime_ledger_drawdown_pct_equity": _decimal_text(
                max_runtime_ledger_drawdown_pct_equity
            ),
            "max_runtime_ledger_best_day_share": _decimal_text(
                max_runtime_ledger_best_day_share
            ),
            "max_runtime_ledger_symbol_concentration_share": _decimal_text(
                max_runtime_ledger_symbol_concentration_share
            ),
        },
        "candidate": _first_identity(
            paper_targets=paper_targets,
            runtime_import=runtime_import,
            completion_gate=live_scale_gate,
        ),
        "required_actions": _required_actions(promotion_blockers, verdict=verdict),
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
                "counts": dict(import_audit_counts),
            },
            "runtime_window_import": {
                "present": bool(runtime_import),
                "proof_status": runtime_import.get("proof_status"),
                "target_count": len(runtime_import_items),
                "proof_blockers": runtime_import_blockers,
                "authoritative_observation_count": authoritative_observation_count,
                "lineage": runtime_import_lineage,
            },
            "completion_live_scale": {
                "gate_status": live_scale_gate.get("status"),
                "runtime_ledger_summary": dict(runtime_summary),
                "strategy_runtime_ledger_bucket_refs": ledger_refs,
                "unbacked_metric_window_refs": unbacked_refs,
            },
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
        "--completion-file",
        type=Path,
        help="Path to a /trading/completion/doc29 JSON payload.",
    )
    parser.add_argument(
        "--completion-url", help="URL returning /trading/completion/doc29 JSON."
    )
    parser.add_argument(
        "--min-runtime-ledger-net-pnl",
        default=str(DEFAULT_MIN_RUNTIME_LEDGER_NET_PNL),
        help="Minimum total runtime-ledger net strategy PnL after costs.",
    )
    parser.add_argument(
        "--min-runtime-ledger-daily-net-pnl",
        default=str(DEFAULT_MIN_RUNTIME_LEDGER_DAILY_NET_PNL),
        help="Minimum runtime-ledger net strategy PnL after costs per observed trading day.",
    )
    parser.add_argument(
        "--min-runtime-ledger-trading-days",
        type=int,
        default=DEFAULT_MIN_RUNTIME_LEDGER_TRADING_DAYS,
        help="Minimum observed runtime-ledger trading days.",
    )
    parser.add_argument(
        "--max-runtime-ledger-drawdown-pct-equity",
        default=str(DEFAULT_MAX_RUNTIME_LEDGER_DRAWDOWN_PCT_EQUITY),
        help="Maximum observed runtime-ledger drawdown as a fraction of equity.",
    )
    parser.add_argument(
        "--max-runtime-ledger-best-day-share",
        default=str(DEFAULT_MAX_RUNTIME_LEDGER_BEST_DAY_SHARE),
        help="Maximum share of post-cost runtime-ledger PnL attributable to one trading day.",
    )
    parser.add_argument(
        "--max-runtime-ledger-symbol-concentration-share",
        default=str(DEFAULT_MAX_RUNTIME_LEDGER_SYMBOL_CONCENTRATION_SHARE),
        help="Maximum share of post-cost runtime-ledger PnL attributable to one symbol.",
    )
    parser.add_argument("--generated-at", default=None)
    parser.add_argument("--timeout-seconds", type=float, default=10.0)
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
            "Fail closed when --artifact-prefix is set but empirical artifact "
            "object-store credentials are unavailable."
        ),
    )
    parser.add_argument(
        "--allow-blocked-exit-zero",
        action="store_true",
        help=(
            "Exit 0 after writing a blocked/waiting packet. Source load and "
            "schema errors still fail; this is for scheduled evidence collection "
            "where a blocked verdict is expected proof state, not job failure."
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
    )
    runtime_window_import = _load_optional_json_object(
        path=args.runtime_window_import_file,
        url=args.runtime_window_import_url,
        timeout_seconds=args.timeout_seconds,
    )
    completion_status = _load_optional_json_object(
        path=args.completion_file,
        url=args.completion_url,
        timeout_seconds=args.timeout_seconds,
    )
    assert status is not None
    packet = build_runtime_ledger_proof_packet(
        status,
        paper_route_evidence=paper_route_evidence,
        runtime_window_import=runtime_window_import,
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
        if artifact_prefix
        else json.dumps(packet, indent=2, sort_keys=True).encode("utf-8")
    )
    if args.output_file is not None:
        args.output_file.parent.mkdir(parents=True, exist_ok=True)
        args.output_file.write_bytes(encoded_body + b"\n")
    print(encoded_body.decode("utf-8"))
    return 0 if packet["ok"] or args.allow_blocked_exit_zero else 1


if __name__ == "__main__":
    raise SystemExit(main())
