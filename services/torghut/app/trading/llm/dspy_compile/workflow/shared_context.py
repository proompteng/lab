"""DSPy compile/eval/promotion workflow helpers with Jangar-compatible contracts."""

from __future__ import annotations

import hashlib
import json
import re
import time
from datetime import datetime, timezone
from http.client import HTTPConnection, HTTPSConnection
from pathlib import Path
from typing import Any, Literal, Mapping, Sequence, cast
from urllib.parse import quote, urlencode, unquote, urlsplit

from sqlalchemy import select
from sqlalchemy.orm import Session

from .....config import settings
from .....models import LLMDSPyWorkflowArtifact, coerce_json_payload
from ..hashing import (
    canonical_artifact_uri_for_hash,
    canonical_metric_bundle_for_hash,
    hash_payload,
)
from ..schemas import (
    DSPyArtifactBundle,
    DSPyCompileResult,
    DSPyEvalReport,
    DSPyPromotionRecord,
)


DSPyWorkflowLane = Literal[
    "dataset-build", "compile", "eval", "gepa-experiment", "promote"
]

DSPyWorkflowExecutionMode = Literal["agentrun", "local"]

DEFAULT_DSPY_AGENT_NAME = "codex-spark-agent"
SIGNATURE_VERSIONS_METADATA_KEY = "signature_versions"

IMPLEMENTATION_SPEC_BY_LANE: dict[DSPyWorkflowLane, str] = {
    "dataset-build": "torghut-dspy-dataset-build-v1",
    "compile": "torghut-dspy-compile-mipro-v1",
    "eval": "torghut-dspy-eval-v1",
    "gepa-experiment": "torghut-dspy-gepa-experiment-v1",
    "promote": "torghut-dspy-promote-artifact-v1",
}

TERMINAL_PHASES = {"succeeded", "failed", "cancelled"}

K8S_LABEL_VALUE_MAX_LENGTH = 63

IDEMPOTENCY_HASH_HEX_LENGTH = 10

PROMOTION_MIN_SCHEMA_VALID_RATE = 0.995

PROMOTION_MAX_FALLBACK_RATE = 0.05

PROMOTION_EVAL_REPORT_MAX_AGE_SECONDS = 60 * 60 * 24

PROMOTION_EVIDENCE_OVERRIDE_KEYS = {
    "gateCompatibility",
    "schemaValidRate",
    "deterministicCompatibility",
    "fallbackRate",
    "evalReportRef",
}


def normalize_local_path(candidate_ref: str) -> Path | None:
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


def load_local_artifact_payload(path_ref: str) -> dict[str, Any] | None:
    candidate = normalize_local_path(path_ref)
    if candidate is None:
        return None
    if not candidate.exists() or not candidate.is_file():
        return None
    try:
        payload = json.loads(candidate.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    return cast(dict[str, Any], payload)


def parse_iso_datetime(value: object) -> datetime | None:
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


def _normalize_string_parameter(*, key: str, value: Any) -> str:
    if value is None:
        raise ValueError(f"parameter_{key}_must_be_non_null")
    if isinstance(value, (dict, list, tuple, set)):
        raise ValueError(f"parameter_{key}_must_be_string_coercible_scalar")
    text = str(value).strip()
    if not text:
        raise ValueError(f"parameter_{key}_must_be_non_empty")
    return text


def resolve_default_dspy_universe_ref(
    symbols: Sequence[str] | None = None,
) -> str:
    configured_symbols = list(
        symbols or settings.trading_universe_static_fallback_symbols
    )
    resolved_symbols: list[str] = []
    seen: set[str] = set()
    for raw_symbol in configured_symbols:
        normalized_symbol = str(raw_symbol).strip().upper()
        if not normalized_symbol or normalized_symbol in seen:
            continue
        seen.add(normalized_symbol)
        resolved_symbols.append(normalized_symbol)
    if resolved_symbols:
        return f"symbols:{','.join(resolved_symbols)}"
    return "torghut:equity:enabled"


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
            "metric_bundle": canonical_metric_bundle_for_hash(metric_bundle),
        }
    )
    artifact_hash = hash_payload(
        {
            "program_name": program_name,
            "signature_versions": dict(signature_versions),
            "optimizer": optimizer,
            "dataset_hash": dataset_hash,
            "compiled_prompt_hash": compiled_prompt_hash,
            "compiled_artifact_uri": canonical_artifact_uri_for_hash(
                compiled_artifact_uri
            ),
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
    metadata_payload = dict(metadata) if metadata is not None else {}
    if compile_result is not None and "executor" not in metadata_payload:
        metadata_payload["executor"] = "dspy_live"

    if compile_result is not None:
        signature_versions = {
            str(key).strip(): str(value).strip()
            for key, value in compile_result.signature_versions.items()
            if str(key).strip() and str(value).strip()
        }
        metadata_payload[SIGNATURE_VERSIONS_METADATA_KEY] = signature_versions
        row.program_name = compile_result.program_name
        row.signature_version = hash_payload(
            {SIGNATURE_VERSIONS_METADATA_KEY: signature_versions}
        )
        row.optimizer = compile_result.optimizer
        row.artifact_uri = compile_result.compiled_artifact_uri
        row.artifact_hash = compile_result.artifact_hash
        row.dataset_hash = compile_result.dataset_hash
        row.compiled_prompt_hash = compile_result.compiled_prompt_hash
        row.reproducibility_hash = compile_result.reproducibility_hash
        row.metric_bundle = coerce_json_payload(compile_result.metric_bundle)

    row.metadata_json = (
        coerce_json_payload(metadata_payload) if metadata_payload else None
    )

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
    resource_metadata = cast(dict[str, Any], resource.get("metadata") or {})
    if resource_metadata:
        row.agentrun_name = str(resource_metadata.get("name") or "").strip() or None
        row.agentrun_namespace = (
            str(resource_metadata.get("namespace") or "").strip() or None
        )
        row.agentrun_uid = str(resource_metadata.get("uid") or "").strip() or None

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
    agent_name: str = DEFAULT_DSPY_AGENT_NAME,
    vcs_ref_name: str = "github",
    secret_binding_ref: str = "codex-github-token",
    ttl_seconds_after_finished: int = 14_400,
) -> dict[str, Any]:
    normalized_idempotency = idempotency_key.strip()
    if not normalized_idempotency:
        raise ValueError("idempotency_key_required")
    implementation_spec_ref = IMPLEMENTATION_SPEC_BY_LANE[lane]

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
        "agentRef": {"name": agent_name.strip() or DEFAULT_DSPY_AGENT_NAME},
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
    if len(normalized) <= K8S_LABEL_VALUE_MAX_LENGTH:
        return normalized

    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[
        :IDEMPOTENCY_HASH_HEX_LENGTH
    ]
    max_head_length = K8S_LABEL_VALUE_MAX_LENGTH - IDEMPOTENCY_HASH_HEX_LENGTH - 1
    head = normalized[:max_head_length].rstrip("-.")
    if not head:
        return digest
    return f"{head}-{digest}"


def submit_agents_agentrun(
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
        raise RuntimeError(f"agents_submit_http_{status}:{body[:200]}")
    parsed = json.loads(body)
    if not isinstance(parsed, dict):
        raise RuntimeError("invalid_agents_response")
    return cast(dict[str, Any], parsed)


def get_agents_agentrun(
    *,
    base_url: str,
    agent_run_id: str,
    namespace: str,
    auth_token: str | None,
    timeout_seconds: int = 20,
) -> dict[str, Any]:
    normalized_agent_run_id = agent_run_id.strip()
    if not normalized_agent_run_id:
        raise RuntimeError("agents_agentrun_id_required")

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
        raise RuntimeError(f"agents_get_agentrun_http_{status}:{body[:200]}")
    parsed = json.loads(body)
    if not isinstance(parsed, dict):
        raise RuntimeError("invalid_agents_agentrun_response")
    return cast(dict[str, Any], parsed)


def wait_for_agents_agentrun_terminal_status(
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
        response = get_agents_agentrun(
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
        if phase in TERMINAL_PHASES:
            return phase
        if time.monotonic() >= deadline:
            raise RuntimeError(
                f"agents_agentrun_terminal_wait_timeout:last_phase={last_phase}:agent_run_id={agent_run_id}"
            )
        time.sleep(normalized_poll)


def extract_submitted_agentrun_id(submit_response: Mapping[str, Any]) -> str:
    agent_run = cast(dict[str, Any], submit_response.get("agentRun") or {})
    run_id = str(agent_run.get("id") or "").strip()
    if run_id:
        return run_id
    raise RuntimeError("jangar_submit_missing_agent_run_id")


def lane_overrides_with_defaults(
    *,
    lane: DSPyWorkflowLane,
    lane_overrides: Mapping[str, Any],
    artifact_root: str,
) -> tuple[dict[str, Any], str]:
    normalized = dict(lane_overrides)
    requested_eval_report_ref = ""
    if lane == "promote":
        eval_report_ref = normalized.get("evalReportRef")
        if eval_report_ref:
            requested_eval_report_ref = str(eval_report_ref).strip()
        for key in PROMOTION_EVIDENCE_OVERRIDE_KEYS:
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
    elif lane == "promote":
        normalized.setdefault(
            "evalReportRef",
            f"{artifact_root}/eval/dspy-eval-report.json",
        )
    return normalized, requested_eval_report_ref


def to_float(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def to_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    text = str(value or "").strip().lower()
    if text in {"true", "pass", "passed", "1", "yes", "y"}:
        return True
    if text in {"false", "fail", "failed", "0", "no", "n"}:
        return False
    return None


def json_copy(payload: Mapping[str, Any]) -> dict[str, Any]:
    return json.loads(json.dumps(dict(payload), sort_keys=True, default=str))


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


def load_eval_gate_snapshot(eval_report_ref: str) -> dict[str, Any] | None:
    candidate = normalize_local_path(eval_report_ref)
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
    created_at = parse_iso_datetime(
        payload.get("createdAt") or payload.get("created_at")
    )
    return {
        "created_at": created_at,
        "gate_compatibility": str(payload.get("gateCompatibility") or "")
        .strip()
        .lower(),
        "schema_valid_rate": to_float(payload.get("schemaValidRate")),
        "deterministic_compatibility": to_bool(
            deterministic_compatibility.get("passed")
        ),
        "fallback_rate": to_float(observed_metrics.get("fallbackRate")),
    }


sanitize_idempotency_key = _sanitize_idempotency_key

__all__ = (
    "DSPyWorkflowLane",
    "DSPyWorkflowExecutionMode",
    "resolve_default_dspy_universe_ref",
    "build_compile_result",
    "build_eval_report",
    "build_promotion_record",
    "bundle_artifacts",
    "write_artifact_bundle",
    "upsert_workflow_artifact_record",
    "build_dspy_agentrun_payload",
    "submit_agents_agentrun",
    "get_agents_agentrun",
    "wait_for_agents_agentrun_terminal_status",
    "sanitize_idempotency_key",
)

# Public aliases used by split-module consumers.
http_json_request = _http_json_request
normalize_string_parameter = _normalize_string_parameter
