"""DSPy compile/eval/promotion workflow helpers with Jangar-compatible contracts."""

from __future__ import annotations

import hashlib
import json
import re
import time
from datetime import datetime, timezone
from http.client import HTTPConnection, HTTPSConnection
from pathlib import Path
from typing import Any, Literal, Mapping, cast
from urllib.parse import quote, urlencode, unquote, urlsplit

from sqlalchemy import select
from sqlalchemy.orm import Session

from ....models import LLMDSPyWorkflowArtifact, coerce_json_payload
from .hashing import hash_payload
from .schemas import (
    DSPyArtifactBundle,
    DSPyCompileResult,
    DSPyEvalReport,
    DSPyPromotionRecord,
)

DSPyWorkflowLane = Literal[
    "dataset-build", "compile", "eval", "gepa-experiment", "promote"
]

_IMPLEMENTATION_SPEC_BY_LANE: dict[DSPyWorkflowLane, str] = {
    "dataset-build": "torghut-dspy-dataset-build-v1",
    "compile": "torghut-dspy-compile-mipro-v1",
    "eval": "torghut-dspy-eval-v1",
    "gepa-experiment": "torghut-dspy-gepa-experiment-v1",
    "promote": "torghut-dspy-promote-artifact-v1",
}
_TERMINAL_PHASES = {"succeeded", "failed", "cancelled"}
_K8S_LABEL_VALUE_MAX_LENGTH = 63
_IDEMPOTENCY_HASH_HEX_LENGTH = 10
_PROMOTION_MIN_SCHEMA_VALID_RATE = 0.995
_PROMOTION_MAX_FALLBACK_RATE = 0.05
_PROMOTION_EVAL_REPORT_MAX_AGE_SECONDS = 60 * 60 * 24
_PROMOTION_EVIDENCE_OVERRIDE_KEYS = {
    "evalReportRef",
    "gateCompatibility",
    "schemaValidRate",
    "deterministicCompatibility",
    "fallbackRate",
}


def _normalize_local_path(candidate_ref: str) -> Path | None:
    parsed_ref = urlsplit(candidate_ref)
    if parsed_ref.scheme not in {"", "file"}:
        return None
    if parsed_ref.scheme == "file":
        candidate = Path(unquote(parsed_ref.path))
    else:
        candidate = Path(candidate_ref)
    if not candidate.is_absolute():
        candidate = Path.cwd() / candidate
    return candidate.resolve()


def _parse_iso_datetime(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    parsed = value.strip()
    if not parsed:
        return None
    if parsed.endswith("Z"):
        parsed = f"{parsed[:-1]}+00:00"
    try:
        parsed_dt = datetime.fromisoformat(parsed)
    except ValueError:
        return None
    if parsed_dt.tzinfo is None:
        parsed_dt = parsed_dt.replace(tzinfo=timezone.utc)
    return parsed_dt.astimezone(timezone.utc)


def build_compile_result(
    *,
    program_name: str,
    signature_versions: Mapping[str, str],
    optimizer: str,
    dataset_payload: Any,
    metric_bundle: Mapping[str, Any],
    compiled_prompt_payload: Any,
    compiled_artifact_uri: str,
    seed: str,
    created_at: datetime | None = None,
) -> DSPyCompileResult:
    dataset_hash = hash_payload(dataset_payload)
    compiled_prompt_hash = hash_payload(compiled_prompt_payload)
    reproducibility_hash = hash_payload(
        {
            "program_name": program_name,
            "signature_versions": dict(signature_versions),
            "optimizer": optimizer,
            "dataset_hash": dataset_hash,
            "compiled_prompt_hash": compiled_prompt_hash,
            "seed": seed,
            "metric_bundle": dict(metric_bundle),
        }
    )
    artifact_hash = hash_payload(
        {
            "program_name": program_name,
            "signature_versions": dict(signature_versions),
            "optimizer": optimizer,
            "dataset_hash": dataset_hash,
            "compiled_prompt_hash": compiled_prompt_hash,
            "compiled_artifact_uri": compiled_artifact_uri,
            "reproducibility_hash": reproducibility_hash,
        }
    )
    return DSPyCompileResult.model_validate(
        {
            "programName": program_name,
            "signatureVersions": dict(signature_versions),
            "optimizer": optimizer,
            "datasetHash": dataset_hash,
            "metricBundle": dict(metric_bundle),
            "compiledPromptHash": compiled_prompt_hash,
            "compiledArtifactUri": compiled_artifact_uri,
            "artifactHash": artifact_hash,
            "reproducibilityHash": reproducibility_hash,
            "createdAt": created_at or datetime.now(timezone.utc),
        }
    )


def build_eval_report(
    *,
    compile_result: DSPyCompileResult,
    schema_valid_rate: float,
    veto_alignment_rate: float,
    false_veto_rate: float,
    latency_p95_ms: int,
    gate_compatibility: Literal["pass", "fail"],
    promotion_recommendation: Literal[
        "hold", "paper", "shadow", "constrained_live", "scaled_live"
    ],
    metric_bundle: Mapping[str, Any],
    created_at: datetime | None = None,
) -> DSPyEvalReport:
    eval_hash = hash_payload(
        {
            "artifact_hash": compile_result.artifact_hash,
            "schema_valid_rate": schema_valid_rate,
            "veto_alignment_rate": veto_alignment_rate,
            "false_veto_rate": false_veto_rate,
            "latency_p95_ms": latency_p95_ms,
            "gate_compatibility": gate_compatibility,
            "promotion_recommendation": promotion_recommendation,
            "metric_bundle": dict(metric_bundle),
        }
    )
    return DSPyEvalReport.model_validate(
        {
            "artifactHash": compile_result.artifact_hash,
            "schemaValidRate": schema_valid_rate,
            "vetoAlignmentRate": veto_alignment_rate,
            "falseVetoRate": false_veto_rate,
            "latencyP95Ms": latency_p95_ms,
            "gateCompatibility": gate_compatibility,
            "promotionRecommendation": promotion_recommendation,
            "metricBundle": dict(metric_bundle),
            "evalHash": eval_hash,
            "createdAt": created_at or datetime.now(timezone.utc),
        }
    )


def build_promotion_record(
    *,
    eval_report: DSPyEvalReport,
    promotion_target: Literal["paper", "shadow", "constrained_live", "scaled_live"],
    approved: bool,
    approval_token_ref: str | None,
    promoted_by: str | None,
    created_at: datetime | None = None,
) -> DSPyPromotionRecord:
    promotion_hash = hash_payload(
        {
            "artifact_hash": eval_report.artifact_hash,
            "eval_hash": eval_report.eval_hash,
            "promotion_target": promotion_target,
            "approved": approved,
            "approval_token_ref": approval_token_ref,
            "promoted_by": promoted_by,
        }
    )
    return DSPyPromotionRecord.model_validate(
        {
            "artifactHash": eval_report.artifact_hash,
            "evalHash": eval_report.eval_hash,
            "promotionTarget": promotion_target,
            "approved": approved,
            "approvalTokenRef": approval_token_ref,
            "promotedBy": promoted_by,
            "promotionHash": promotion_hash,
            "createdAt": created_at or datetime.now(timezone.utc),
        }
    )


def bundle_artifacts(
    *,
    compile_result: DSPyCompileResult,
    eval_report: DSPyEvalReport,
    promotion_record: DSPyPromotionRecord | None,
) -> DSPyArtifactBundle:
    payload: dict[str, Any] = {
        "compileResult": compile_result.model_dump(mode="json", by_alias=True),
        "evalReport": eval_report.model_dump(mode="json", by_alias=True),
        "promotionRecord": (
            promotion_record.model_dump(mode="json", by_alias=True)
            if promotion_record is not None
            else None
        ),
    }
    artifact_hashes = {
        "compile_result": hash_payload(payload["compileResult"]),
        "eval_report": hash_payload(payload["evalReport"]),
    }
    if payload["promotionRecord"] is not None:
        artifact_hashes["promotion_record"] = hash_payload(payload["promotionRecord"])
    payload["artifactHashes"] = artifact_hashes
    payload["manifestHash"] = hash_payload(payload["artifactHashes"])
    return DSPyArtifactBundle.model_validate(payload)


def write_artifact_bundle(
    output_dir: Path,
    *,
    compile_result: DSPyCompileResult,
    eval_report: DSPyEvalReport,
    promotion_record: DSPyPromotionRecord | None = None,
) -> dict[str, str]:
    output_dir.mkdir(parents=True, exist_ok=True)
    bundle = bundle_artifacts(
        compile_result=compile_result,
        eval_report=eval_report,
        promotion_record=promotion_record,
    )

    files: dict[str, Any] = {
        "dspy-compile-result.json": compile_result.model_dump(
            mode="json", by_alias=True
        ),
        "dspy-eval-report.json": eval_report.model_dump(mode="json", by_alias=True),
        "dspy-bundle.json": bundle.model_dump(mode="json", by_alias=True),
    }
    if promotion_record is not None:
        files["dspy-promotion-record.json"] = promotion_record.model_dump(
            mode="json",
            by_alias=True,
        )

    written_hashes: dict[str, str] = {}
    for file_name, payload in files.items():
        path = output_dir / file_name
        encoded = json.dumps(
            payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True
        )
        path.write_text(encoded + "\n", encoding="utf-8")
        written_hashes[file_name] = hash_payload(payload)
    return written_hashes


def upsert_workflow_artifact_record(
    session: Session,
    *,
    run_key: str,
    lane: DSPyWorkflowLane,
    status: str,
    implementation_spec_ref: str,
    idempotency_key: str | None,
    request_payload: Mapping[str, Any] | None,
    response_payload: Mapping[str, Any] | None,
    compile_result: DSPyCompileResult | None,
    eval_report: DSPyEvalReport | None,
    promotion_record: DSPyPromotionRecord | None,
    metadata: Mapping[str, Any] | None = None,
) -> LLMDSPyWorkflowArtifact:
    row = session.execute(
        select(LLMDSPyWorkflowArtifact).where(
            LLMDSPyWorkflowArtifact.run_key == run_key
        )
    ).scalar_one_or_none()
    if row is None:
        row = LLMDSPyWorkflowArtifact(
            run_key=run_key,
            lane=lane,
            status=status,
            implementation_spec_ref=implementation_spec_ref,
        )

    row.lane = lane
    row.status = status
    row.implementation_spec_ref = implementation_spec_ref
    row.idempotency_key = idempotency_key
    row.request_payload_json = (
        coerce_json_payload(dict(request_payload))
        if request_payload is not None
        else None
    )
    row.response_payload_json = (
        coerce_json_payload(dict(response_payload))
        if response_payload is not None
        else None
    )
    row.metadata_json = (
        coerce_json_payload(dict(metadata)) if metadata is not None else None
    )

    if compile_result is not None:
        row.program_name = compile_result.program_name
        row.signature_version = ",".join(
            f"{key}:{value}"
            for key, value in sorted(compile_result.signature_versions.items())
        )
        row.optimizer = compile_result.optimizer
        row.artifact_uri = compile_result.compiled_artifact_uri
        row.artifact_hash = compile_result.artifact_hash
        row.dataset_hash = compile_result.dataset_hash
        row.compiled_prompt_hash = compile_result.compiled_prompt_hash
        row.reproducibility_hash = compile_result.reproducibility_hash
        row.metric_bundle = coerce_json_payload(compile_result.metric_bundle)

    if eval_report is not None:
        row.gate_compatibility = eval_report.gate_compatibility
        row.promotion_recommendation = eval_report.promotion_recommendation
        metric_bundle = cast(dict[str, Any], row.metric_bundle or {})
        metric_bundle.update(eval_report.metric_bundle)
        metric_bundle["eval_hash"] = eval_report.eval_hash
        row.metric_bundle = coerce_json_payload(metric_bundle)

    if promotion_record is not None:
        row.promotion_target = promotion_record.promotion_target
        metric_bundle = cast(dict[str, Any], row.metric_bundle or {})
        metric_bundle["promotion_hash"] = promotion_record.promotion_hash
        metric_bundle["promotion_approved"] = promotion_record.approved
        row.metric_bundle = coerce_json_payload(metric_bundle)

    resource = cast(dict[str, Any], (response_payload or {}).get("resource") or {})
    metadata_payload = cast(dict[str, Any], resource.get("metadata") or {})
    if metadata_payload:
        row.agentrun_name = str(metadata_payload.get("name") or "").strip() or None
        row.agentrun_namespace = (
            str(metadata_payload.get("namespace") or "").strip() or None
        )
        row.agentrun_uid = str(metadata_payload.get("uid") or "").strip() or None

    session.add(row)
    session.flush()
    return row


def build_dspy_agentrun_payload(
    *,
    lane: DSPyWorkflowLane,
    idempotency_key: str,
    repository: str,
    base: str,
    head: str,
    artifact_path: str,
    parameter_overrides: Mapping[str, Any],
    issue_number: str = "0",
    priority_id: str | None = None,
    namespace: str = "agents",
    agent_name: str = "codex-agent",
    vcs_ref_name: str = "github",
    secret_binding_ref: str = "codex-github-token",
    ttl_seconds_after_finished: int = 14_400,
) -> dict[str, Any]:
    normalized_idempotency = idempotency_key.strip()
    if not normalized_idempotency:
        raise ValueError("idempotency_key_required")
    implementation_spec_ref = _IMPLEMENTATION_SPEC_BY_LANE[lane]

    parameters: dict[str, str] = {
        "repository": repository.strip(),
        "base": base.strip(),
        "head": head.strip(),
        "artifactPath": artifact_path.strip(),
        "issueNumber": _normalize_string_parameter(
            key="issueNumber",
            value=issue_number,
        ),
    }
    for key, value in parameter_overrides.items():
        normalized_key = str(key).strip()
        if not normalized_key:
            continue
        parameters[normalized_key] = _normalize_string_parameter(
            key=normalized_key,
            value=value,
        )
    if priority_id is not None:
        parameters["priorityId"] = _normalize_string_parameter(
            key="priorityId",
            value=priority_id,
        )
    if not parameters["repository"] or not parameters["base"] or not parameters["head"]:
        raise ValueError("repository_base_head_required")

    return {
        "namespace": namespace.strip() or "agents",
        "idempotencyKey": normalized_idempotency,
        "agentRef": {"name": agent_name.strip() or "codex-agent"},
        "implementationSpecRef": {"name": implementation_spec_ref},
        "runtime": {"type": "job"},
        "vcsRef": {"name": vcs_ref_name.strip() or "github"},
        "vcsPolicy": {"required": True, "mode": "read-write"},
        "parameters": parameters,
        "policy": {"secretBindingRef": secret_binding_ref.strip()},
        "ttlSecondsAfterFinished": max(int(ttl_seconds_after_finished), 0),
    }


def _sanitize_idempotency_key(value: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9_.-]+", "-", value.strip())
    normalized = normalized.strip("-.")
    if not normalized:
        raise ValueError("idempotency_key_invalid")
    if len(normalized) <= _K8S_LABEL_VALUE_MAX_LENGTH:
        return normalized

    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[
        :_IDEMPOTENCY_HASH_HEX_LENGTH
    ]
    max_head_length = _K8S_LABEL_VALUE_MAX_LENGTH - _IDEMPOTENCY_HASH_HEX_LENGTH - 1
    head = normalized[:max_head_length].rstrip("-.")
    if not head:
        return digest
    return f"{head}-{digest}"


def submit_jangar_agentrun(
    *,
    base_url: str,
    payload: Mapping[str, Any],
    idempotency_key: str,
    auth_token: str | None,
    timeout_seconds: int = 20,
) -> dict[str, Any]:
    submit_url = f"{base_url.rstrip('/')}/v1/agent-runs"
    status, body = _http_json_request(
        submit_url,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Idempotency-Key": idempotency_key,
            **({"Authorization": f"Bearer {auth_token}"} if auth_token else {}),
        },
        body=json.dumps(dict(payload), sort_keys=True, default=str).encode("utf-8"),
        timeout_seconds=timeout_seconds,
    )
    if status < 200 or status >= 300:
        raise RuntimeError(f"jangar_submit_http_{status}:{body[:200]}")
    parsed = json.loads(body)
    if not isinstance(parsed, dict):
        raise RuntimeError("invalid_jangar_response")
    return cast(dict[str, Any], parsed)


def get_jangar_agentrun(
    *,
    base_url: str,
    agent_run_id: str,
    namespace: str,
    auth_token: str | None,
    timeout_seconds: int = 20,
) -> dict[str, Any]:
    normalized_agent_run_id = agent_run_id.strip()
    if not normalized_agent_run_id:
        raise RuntimeError("jangar_agentrun_id_required")

    query = urlencode({"namespace": namespace.strip() or "agents"})
    status_url = (
        f"{base_url.rstrip('/')}/v1/agent-runs/{quote(normalized_agent_run_id, safe='')}"
        f"?{query}"
    )
    status, body = _http_json_request(
        status_url,
        method="GET",
        headers={**({"Authorization": f"Bearer {auth_token}"} if auth_token else {})},
        body=b"",
        timeout_seconds=timeout_seconds,
    )
    if status < 200 or status >= 300:
        raise RuntimeError(f"jangar_get_agentrun_http_{status}:{body[:200]}")
    parsed = json.loads(body)
    if not isinstance(parsed, dict):
        raise RuntimeError("invalid_jangar_agentrun_response")
    return cast(dict[str, Any], parsed)


def wait_for_jangar_agentrun_terminal_status(
    *,
    base_url: str,
    agent_run_id: str,
    namespace: str,
    auth_token: str | None,
    timeout_seconds: int = 20,
    poll_interval_seconds: int = 5,
    max_wait_seconds: int = 3600,
) -> str:
    normalized_poll = max(int(poll_interval_seconds), 1)
    deadline = time.monotonic() + max(int(max_wait_seconds), normalized_poll)
    last_phase = "unknown"

    while True:
        response = get_jangar_agentrun(
            base_url=base_url,
            agent_run_id=agent_run_id,
            namespace=namespace,
            auth_token=auth_token,
            timeout_seconds=timeout_seconds,
        )
        phase_raw = (
            cast(dict[str, Any], response.get("agentRun") or {}).get("status")
            or cast(dict[str, Any], response.get("resource") or {}).get("status")
            or ""
        )
        phase = str(phase_raw).strip().lower()
        if phase:
            last_phase = phase
        if phase in _TERMINAL_PHASES:
            return phase
        if time.monotonic() >= deadline:
            raise RuntimeError(
                f"jangar_agentrun_terminal_wait_timeout:last_phase={last_phase}:agent_run_id={agent_run_id}"
            )
        time.sleep(normalized_poll)


def _extract_submitted_agentrun_id(submit_response: Mapping[str, Any]) -> str:
    agent_run = cast(dict[str, Any], submit_response.get("agentRun") or {})
    run_id = str(agent_run.get("id") or "").strip()
    if run_id:
        return run_id
    raise RuntimeError("jangar_submit_missing_agent_run_id")


def _lane_overrides_with_defaults(
    *,
    lane: DSPyWorkflowLane,
    lane_overrides: Mapping[str, Any],
    artifact_root: str,
) -> dict[str, Any]:
    normalized = dict(lane_overrides)
    if lane == "promote":
        for key in _PROMOTION_EVIDENCE_OVERRIDE_KEYS:
            normalized.pop(key, None)
    if lane == "compile":
        normalized.setdefault(
            "datasetRef",
            f"{artifact_root}/dataset-build/dspy-dataset.json",
        )
    elif lane == "eval":
        normalized.setdefault(
            "compileResultRef",
            f"{artifact_root}/compile/dspy-compile-result.json",
        )
    return normalized


def _to_float(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _to_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    text = str(value or "").strip().lower()
    if text in {"true", "pass", "passed", "1", "yes", "y"}:
        return True
    if text in {"false", "fail", "failed", "0", "no", "n"}:
        return False
    return None


def _json_copy(payload: Mapping[str, Any]) -> dict[str, Any]:
    return json.loads(
        json.dumps(dict(payload), sort_keys=True, default=str)
    )


def _load_eval_gate_snapshot(eval_report_ref: str) -> dict[str, Any] | None:
    candidate = _normalize_local_path(eval_report_ref)
    if candidate is None:
        return None
    if not candidate.exists() or not candidate.is_file():
        return None
    try:
        payload_raw = json.loads(candidate.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    if not isinstance(payload_raw, dict):
        return None
    payload = cast(dict[str, Any], payload_raw)
    metric_bundle = cast(dict[str, Any], payload.get("metricBundle") or {})
    deterministic_compatibility = cast(
        dict[str, Any], metric_bundle.get("deterministicCompatibility") or {}
    )
    observed_metrics = cast(dict[str, Any], metric_bundle.get("observed") or {})
    created_at = _parse_iso_datetime(payload.get("createdAt") or payload.get("created_at"))
    return {
        "created_at": created_at,
        "gate_compatibility": str(payload.get("gateCompatibility") or "")
        .strip()
        .lower(),
        "schema_valid_rate": _to_float(payload.get("schemaValidRate")),
        "deterministic_compatibility": _to_bool(
            deterministic_compatibility.get("passed")
        ),
        "fallback_rate": _to_float(observed_metrics.get("fallbackRate")),
    }


def _resolve_promotion_gate_snapshot(
    lane_overrides: Mapping[str, Any],
    *,
    artifact_root: str,
) -> dict[str, Any]:
    expected_eval_report_ref = f"{artifact_root.rstrip('/')}/eval/dspy-eval-report.json"
    requested_eval_report_ref = str(lane_overrides.get("evalReportRef") or "").strip()
    snapshot = _load_eval_snapshot_for_promotion(
        expected_eval_report_ref,
        artifact_root=artifact_root,
        requested_eval_report_ref=requested_eval_report_ref,
    )
    snapshot["expected_eval_report_ref"] = expected_eval_report_ref
    snapshot["requested_eval_report_ref"] = requested_eval_report_ref
    return snapshot


def _load_eval_snapshot_for_promotion(
    eval_report_ref: str,
    *,
    artifact_root: str,
    requested_eval_report_ref: str,
) -> dict[str, Any]:
    snapshot: dict[str, Any] = {
        "eval_report_ref": eval_report_ref,
        "eval_report_trusted": True,
    }
    snapshot["requested_eval_report_ref"] = requested_eval_report_ref

    artifact_root_path = Path(artifact_root).resolve()
    expected_path = artifact_root_path / "eval" / "dspy-eval-report.json"

    if requested_eval_report_ref:
        requested_ref_path = _normalize_local_path(requested_eval_report_ref)
        if requested_ref_path is None:
            snapshot["eval_report_trusted"] = False
            snapshot["eval_report_trust_reason"] = "reference_not_local"
            snapshot["eval_report_loaded"] = False
            return snapshot
        if requested_ref_path != expected_path:
            if not requested_ref_path.is_relative_to(artifact_root_path):
                snapshot["eval_report_trusted"] = False
                snapshot["eval_report_trust_reason"] = "outside_artifact_root"
            else:
                snapshot["eval_report_trusted"] = False
                snapshot["eval_report_trust_reason"] = "reference_override_disallowed"
            snapshot["eval_report_path"] = str(requested_ref_path)
            snapshot["eval_report_loaded"] = False
            return snapshot

    resolved_ref_path = _normalize_local_path(eval_report_ref)
    if resolved_ref_path is None:
        snapshot["eval_report_trusted"] = False
        snapshot["eval_report_trust_reason"] = "reference_not_local"
        snapshot["eval_report_loaded"] = False
        return snapshot

    if not resolved_ref_path.is_relative_to(artifact_root_path):
        snapshot["eval_report_trusted"] = False
        snapshot["eval_report_trust_reason"] = "outside_artifact_root"
        snapshot["eval_report_loaded"] = False
        return snapshot

    if resolved_ref_path != expected_path:
        snapshot["eval_report_trusted"] = False
        snapshot["eval_report_trust_reason"] = "reference_override_disallowed"
        snapshot["eval_report_loaded"] = False
        return snapshot

    if not resolved_ref_path.exists() or not resolved_ref_path.is_file():
        snapshot["eval_report_loaded"] = False
        snapshot["eval_report_path"] = str(resolved_ref_path)
        snapshot["eval_report_trust_reason"] = "missing_artifact"
        return snapshot

    snapshot["eval_report_path"] = str(resolved_ref_path)
    artifact_snapshot = _load_eval_gate_snapshot(str(resolved_ref_path))
    snapshot["eval_report_loaded"] = artifact_snapshot is not None
    if artifact_snapshot is None:
        snapshot["eval_report_trusted"] = False
        snapshot["eval_report_trust_reason"] = "invalid_artifact"
        return snapshot
    snapshot.update(artifact_snapshot)
    return snapshot


def _promotion_gate_failures(
    gate_snapshot: Mapping[str, Any], *, now: datetime
) -> list[str]:
    failures: list[str] = []
    if not gate_snapshot.get("eval_report_trusted", False):
        trust_reason = str(gate_snapshot.get("eval_report_trust_reason") or "")
        if trust_reason == "outside_artifact_root":
            failures.append("eval_report_outside_artifact_root")
        elif trust_reason == "reference_not_local":
            failures.append("eval_report_reference_not_local")
        elif trust_reason == "reference_override_disallowed":
            failures.append("eval_report_reference_override_disallowed")
        elif trust_reason == "missing_artifact":
            failures.append("eval_report_not_found")
        elif trust_reason == "invalid_artifact":
            failures.append("eval_report_invalid_payload")
        else:
            failures.append("eval_report_not_trusted")
    elif not gate_snapshot.get("eval_report_loaded", False):
        failures.append("eval_report_not_found")

    created_at = gate_snapshot.get("created_at")
    if created_at is None:
        failures.append("eval_report_created_at_missing")
    elif not isinstance(created_at, datetime):
        failures.append("eval_report_created_at_invalid")
    elif (now - created_at).total_seconds() > _PROMOTION_EVAL_REPORT_MAX_AGE_SECONDS:
        failures.append("eval_report_stale")

    gate_compatibility = (
        str(gate_snapshot.get("gate_compatibility") or "").strip().lower()
    )
    if gate_compatibility != "pass":
        failures.append("gate_compatibility_not_pass")

    schema_valid_rate = _to_float(gate_snapshot.get("schema_valid_rate"))
    if schema_valid_rate is None:
        failures.append("schema_valid_rate_missing")
    elif schema_valid_rate < _PROMOTION_MIN_SCHEMA_VALID_RATE:
        failures.append("schema_valid_rate_below_min")

    deterministic_compatibility = _to_bool(
        gate_snapshot.get("deterministic_compatibility")
    )
    if deterministic_compatibility is None:
        failures.append("deterministic_compatibility_missing")
    elif not deterministic_compatibility:
        failures.append("deterministic_compatibility_failed")

    fallback_rate = _to_float(gate_snapshot.get("fallback_rate"))
    if fallback_rate is None:
        failures.append("fallback_rate_missing")
    elif fallback_rate > _PROMOTION_MAX_FALLBACK_RATE:
        failures.append("fallback_rate_above_max")
    return failures


def orchestrate_dspy_agentrun_workflow(
    session: Session,
    *,
    base_url: str,
    repository: str,
    base: str,
    head: str,
    artifact_root: str,
    run_prefix: str,
    auth_token: str | None,
    issue_number: str = "0",
    priority_id: str | None = None,
    lane_parameter_overrides: Mapping[DSPyWorkflowLane, Mapping[str, Any]]
    | None = None,
    include_gepa_experiment: bool = False,
    namespace: str = "agents",
    agent_name: str = "codex-agent",
    vcs_ref_name: str = "github",
    secret_binding_ref: str = "codex-github-token",
    ttl_seconds_after_finished: int = 14_400,
    timeout_seconds: int = 20,
    poll_interval_seconds: int = 5,
    max_wait_seconds: int = 3600,
) -> dict[DSPyWorkflowLane, dict[str, Any]]:
    """Submit dataset-build -> compile -> eval -> [gepa] -> promote AgentRuns and persist lineage rows."""

    normalized_run_prefix = run_prefix.strip()
    if not normalized_run_prefix:
        raise ValueError("run_prefix_required")

    artifact_root_normalized = artifact_root.strip().rstrip("/")
    if not artifact_root_normalized:
        raise ValueError("artifact_root_required")

    lanes: list[DSPyWorkflowLane] = ["dataset-build", "compile", "eval"]
    if include_gepa_experiment:
        lanes.append("gepa-experiment")
    lanes.append("promote")

    overrides_by_lane = lane_parameter_overrides or {}
    responses: dict[DSPyWorkflowLane, dict[str, Any]] = {}
    lineage_by_lane: dict[str, dict[str, Any]] = {}

    for lane_index, lane in enumerate(lanes):
        raw_lane_overrides = overrides_by_lane.get(lane, {})
        lane_overrides = _lane_overrides_with_defaults(
            lane=lane,
            lane_overrides=raw_lane_overrides,
            artifact_root=artifact_root_normalized,
        )
        gate_snapshot: dict[str, Any] | None = None

        if lane == "promote":
            gate_snapshot = _resolve_promotion_gate_snapshot(
                raw_lane_overrides,
                artifact_root=artifact_root_normalized,
            )
            gate_failures = _promotion_gate_failures(
                gate_snapshot,
                now=datetime.now(timezone.utc),
            )
            if gate_failures:
                run_key = f"{normalized_run_prefix}:{lane}"
                idempotency_key = _sanitize_idempotency_key(
                    f"{normalized_run_prefix}-{lane}"
                )
                upsert_workflow_artifact_record(
                    session,
                    run_key=run_key,
                    lane=lane,
                    status="blocked",
                    implementation_spec_ref=_IMPLEMENTATION_SPEC_BY_LANE[lane],
                    idempotency_key=idempotency_key,
                    request_payload=None,
                    response_payload=None,
                    compile_result=None,
                    eval_report=None,
                    promotion_record=None,
                    metadata={
                        "orchestration": {
                            "runPrefix": normalized_run_prefix,
                            "laneOrder": lane_index,
                            "blockedAt": datetime.now(timezone.utc).isoformat(),
                            "priorityId": priority_id,
                            "lineageByLane": _json_copy(lineage_by_lane),
                            "gateSnapshot": gate_snapshot,
                            "gateFailures": gate_failures,
                        }
                    },
                )
                session.commit()
                raise RuntimeError(
                    f"dspy_promotion_gate_blocked:{','.join(gate_failures)}"
                )

        run_key = f"{normalized_run_prefix}:{lane}"
        idempotency_key = _sanitize_idempotency_key(f"{normalized_run_prefix}-{lane}")
        artifact_path = f"{artifact_root_normalized}/{lane}"
        payload = build_dspy_agentrun_payload(
            lane=lane,
            idempotency_key=idempotency_key,
            repository=repository,
            base=base,
            head=head,
            artifact_path=artifact_path,
            parameter_overrides=lane_overrides,
            issue_number=issue_number,
            priority_id=priority_id,
            namespace=namespace,
            agent_name=agent_name,
            vcs_ref_name=vcs_ref_name,
            secret_binding_ref=secret_binding_ref,
            ttl_seconds_after_finished=ttl_seconds_after_finished,
        )
        lineage_by_lane[lane] = {
            "artifactPath": artifact_path,
            "parameterOverrides": lane_overrides,
            "implementationSpecRef": _IMPLEMENTATION_SPEC_BY_LANE[lane],
            "gateSnapshot": gate_snapshot,
        }

        try:
            response_payload = submit_jangar_agentrun(
                base_url=base_url,
                payload=payload,
                idempotency_key=idempotency_key,
                auth_token=auth_token,
                timeout_seconds=timeout_seconds,
            )
            responses[lane] = response_payload

            upsert_workflow_artifact_record(
                session,
                run_key=run_key,
                lane=lane,
                status="submitted",
                implementation_spec_ref=_IMPLEMENTATION_SPEC_BY_LANE[lane],
                idempotency_key=idempotency_key,
                request_payload=payload,
                response_payload=response_payload,
                compile_result=None,
                eval_report=None,
                promotion_record=None,
                metadata={
                    "orchestration": {
                        "runPrefix": normalized_run_prefix,
                        "laneOrder": lane_index,
                        "submittedAt": datetime.now(timezone.utc).isoformat(),
                        "priorityId": priority_id,
                        "lineageByLane": _json_copy(lineage_by_lane),
                    }
                },
            )

            # Persist each accepted submission immediately so partial orchestration runs remain auditable.
            session.commit()

            terminal_phase = wait_for_jangar_agentrun_terminal_status(
                base_url=base_url,
                agent_run_id=_extract_submitted_agentrun_id(response_payload),
                namespace=namespace,
                auth_token=auth_token,
                timeout_seconds=timeout_seconds,
                poll_interval_seconds=poll_interval_seconds,
                max_wait_seconds=max_wait_seconds,
            )
            upsert_workflow_artifact_record(
                session,
                run_key=run_key,
                lane=lane,
                status=terminal_phase,
                implementation_spec_ref=_IMPLEMENTATION_SPEC_BY_LANE[lane],
                idempotency_key=idempotency_key,
                request_payload=payload,
                response_payload=response_payload,
                compile_result=None,
                eval_report=None,
                promotion_record=None,
                metadata={
                    "orchestration": {
                        "runPrefix": normalized_run_prefix,
                        "laneOrder": lane_index,
                        "terminalPhase": terminal_phase,
                        "terminalObservedAt": datetime.now(timezone.utc).isoformat(),
                        "priorityId": priority_id,
                        "lineageByLane": _json_copy(lineage_by_lane),
                    }
                },
            )
            session.commit()
            if terminal_phase != "succeeded":
                raise RuntimeError(
                    f"jangar_agentrun_not_succeeded:{lane}:{terminal_phase}"
                )
        except Exception:
            session.rollback()
            raise

    return responses


def _normalize_string_parameter(*, key: str, value: Any) -> str:
    if value is None:
        raise ValueError(f"parameter_{key}_must_be_non_null")
    if isinstance(value, (dict, list, tuple, set)):
        raise ValueError(f"parameter_{key}_must_be_string_coercible_scalar")
    text = str(value).strip()
    if not text:
        raise ValueError(f"parameter_{key}_must_be_non_empty")
    return text


def _http_json_request(
    url: str,
    *,
    method: str,
    headers: Mapping[str, str],
    body: bytes,
    timeout_seconds: int,
) -> tuple[int, str]:
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"}:
        raise RuntimeError("invalid_http_scheme")
    if not parsed.hostname:
        raise RuntimeError("invalid_http_host")
    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"
    connection_class = HTTPSConnection if parsed.scheme == "https" else HTTPConnection
    connection = connection_class(
        parsed.hostname, parsed.port, timeout=max(timeout_seconds, 1)
    )
    try:
        connection.request(method, path, body=body, headers=dict(headers))
        response = connection.getresponse()
        payload = response.read().decode("utf-8", errors="replace")
        return int(response.status), payload
    finally:
        connection.close()


__all__ = [
    "DSPyWorkflowLane",
    "build_compile_result",
    "build_dspy_agentrun_payload",
    "build_eval_report",
    "orchestrate_dspy_agentrun_workflow",
    "build_promotion_record",
    "bundle_artifacts",
    "get_jangar_agentrun",
    "wait_for_jangar_agentrun_terminal_status",
    "submit_jangar_agentrun",
    "upsert_workflow_artifact_record",
    "write_artifact_bundle",
]
