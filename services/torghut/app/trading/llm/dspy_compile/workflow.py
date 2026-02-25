"""DSPy compile/eval/promotion workflow helpers with Jangar-compatible contracts."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from http.client import HTTPConnection, HTTPSConnection
from pathlib import Path
from typing import Any, Literal, Mapping, cast
from urllib.parse import urlsplit

from sqlalchemy import select
from sqlalchemy.orm import Session

from ....models import LLMDSPyWorkflowArtifact, coerce_json_payload
from .hashing import hash_payload
from .schemas import DSPyArtifactBundle, DSPyCompileResult, DSPyEvalReport, DSPyPromotionRecord

DSPyWorkflowLane = Literal["dataset-build", "compile", "eval", "gepa-experiment", "promote"]

_IMPLEMENTATION_SPEC_BY_LANE: dict[DSPyWorkflowLane, str] = {
    "dataset-build": "torghut-dspy-dataset-build-v1",
    "compile": "torghut-dspy-compile-mipro-v1",
    "eval": "torghut-dspy-eval-v1",
    "gepa-experiment": "torghut-dspy-gepa-experiment-v1",
    "promote": "torghut-dspy-promote-artifact-v1",
}


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
    promotion_recommendation: Literal["hold", "paper", "shadow", "constrained_live", "scaled_live"],
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
        "dspy-compile-result.json": compile_result.model_dump(mode="json", by_alias=True),
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
        encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
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
        select(LLMDSPyWorkflowArtifact).where(LLMDSPyWorkflowArtifact.run_key == run_key)
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
    row.request_payload_json = coerce_json_payload(dict(request_payload)) if request_payload is not None else None
    row.response_payload_json = coerce_json_payload(dict(response_payload)) if response_payload is not None else None
    row.metadata_json = coerce_json_payload(dict(metadata)) if metadata is not None else None

    if compile_result is not None:
        row.program_name = compile_result.program_name
        row.signature_version = ",".join(
            f"{key}:{value}" for key, value in sorted(compile_result.signature_versions.items())
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
        row.agentrun_namespace = str(metadata_payload.get("namespace") or "").strip() or None
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
    namespace: str = "agents",
    agent_name: str = "codex-agent",
    vcs_ref_name: str = "github",
    secret_binding_ref: str = "codex-whitepaper-github-token",
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
    }
    for key, value in parameter_overrides.items():
        normalized_key = str(key).strip()
        if not normalized_key:
            continue
        parameters[normalized_key] = _normalize_string_parameter(
            key=normalized_key,
            value=value,
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
        body=json.dumps(dict(payload), sort_keys=True).encode("utf-8"),
        timeout_seconds=timeout_seconds,
    )
    if status < 200 or status >= 300:
        raise RuntimeError(f"jangar_submit_http_{status}:{body[:200]}")
    parsed = json.loads(body)
    if not isinstance(parsed, dict):
        raise RuntimeError("invalid_jangar_response")
    return cast(dict[str, Any], parsed)


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
    connection = connection_class(parsed.hostname, parsed.port, timeout=max(timeout_seconds, 1))
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
    "build_promotion_record",
    "bundle_artifacts",
    "submit_jangar_agentrun",
    "upsert_workflow_artifact_record",
    "write_artifact_bundle",
]
