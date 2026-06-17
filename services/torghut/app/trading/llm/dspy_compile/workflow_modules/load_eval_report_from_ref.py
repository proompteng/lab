# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
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
from ..hashing import hash_payload
from ..schemas import (
    DSPyArtifactBundle,
    DSPyCompileResult,
    DSPyEvalReport,
    DSPyPromotionRecord,
)

# ruff: noqa: F401,F811,F821

from .shared_context import (
    DSPyWorkflowExecutionMode,
    DSPyWorkflowLane,
    DEFAULT_DSPY_AGENT_NAME as _DEFAULT_DSPY_AGENT_NAME,
    IDEMPOTENCY_HASH_HEX_LENGTH as _IDEMPOTENCY_HASH_HEX_LENGTH,
    IMPLEMENTATION_SPEC_BY_LANE as _IMPLEMENTATION_SPEC_BY_LANE,
    K8S_LABEL_VALUE_MAX_LENGTH as _K8S_LABEL_VALUE_MAX_LENGTH,
    PROMOTION_EVAL_REPORT_MAX_AGE_SECONDS as _PROMOTION_EVAL_REPORT_MAX_AGE_SECONDS,
    PROMOTION_EVIDENCE_OVERRIDE_KEYS as _PROMOTION_EVIDENCE_OVERRIDE_KEYS,
    PROMOTION_MAX_FALLBACK_RATE as _PROMOTION_MAX_FALLBACK_RATE,
    PROMOTION_MIN_SCHEMA_VALID_RATE as _PROMOTION_MIN_SCHEMA_VALID_RATE,
    TERMINAL_PHASES as _TERMINAL_PHASES,
    extract_submitted_agentrun_id as _extract_submitted_agentrun_id,
    json_copy as _json_copy,
    lane_overrides_with_defaults as _lane_overrides_with_defaults,
    load_eval_gate_snapshot as _load_eval_gate_snapshot,
    load_local_artifact_payload as _load_local_artifact_payload,
    normalize_local_path as _normalize_local_path,
    parse_iso_datetime as _parse_iso_datetime,
    sanitize_idempotency_key as _sanitize_idempotency_key,
    to_bool as _to_bool,
    to_float as _to_float,
    build_compile_result,
    build_dspy_agentrun_payload,
    build_eval_report,
    build_promotion_record,
    bundle_artifacts,
    get_agents_agentrun,
    resolve_default_dspy_universe_ref,
    submit_agents_agentrun,
    upsert_workflow_artifact_record,
    wait_for_agents_agentrun_terminal_status,
    write_artifact_bundle,
)
from .resolve_promotion_gate_snapshot import (
    DSPyLaneContext as _DSPyLaneContext,
    DSPyWorkflowRequest as _DSPyWorkflowRequest,
    DSPyWorkflowSnapshots as _DSPyWorkflowSnapshots,
    DSPyWorkflowState as _DSPyWorkflowState,
    artifact_root_normalized as _artifact_root_normalized,
    build_dspy_lane_context as _build_dspy_lane_context,
    build_dspy_lane_payload as _build_dspy_lane_payload,
    compile_result_for_lane as _compile_result_for_lane,
    dspy_lane_idempotency_key as _dspy_lane_idempotency_key,
    dspy_lane_run_key as _dspy_lane_run_key,
    dspy_lane_terminal_metadata as _dspy_lane_terminal_metadata,
    dspy_workflow_lanes as _dspy_workflow_lanes,
    dspy_workflow_request_from_kwargs as _dspy_workflow_request_from_kwargs,
    ensure_promotion_artifact_hash as _ensure_promotion_artifact_hash,
    eval_report_for_lane as _eval_report_for_lane,
    execute_and_persist_local_dspy_lane as _execute_and_persist_local_dspy_lane,
    load_dspy_model_snapshot as _load_dspy_model_snapshot,
    load_eval_snapshot_for_promotion as _load_eval_snapshot_for_promotion,
    orchestrate_dspy_workflow as _orchestrate_dspy_workflow,
    orchestrate_dspy_workflow_lane as _orchestrate_dspy_workflow_lane,
    persist_blocked_promotion_lane as _persist_blocked_promotion_lane,
    pop_required_workflow_kwarg as _pop_required_workflow_kwarg,
    prepare_promotion_gate_snapshot as _prepare_promotion_gate_snapshot,
    promotion_gate_compatibility_failures as _promotion_gate_compatibility_failures,
    promotion_gate_created_at_failures as _promotion_gate_created_at_failures,
    promotion_gate_determinism_failures as _promotion_gate_determinism_failures,
    promotion_gate_failures as _promotion_gate_failures,
    promotion_gate_fallback_failures as _promotion_gate_fallback_failures,
    promotion_gate_schema_failures as _promotion_gate_schema_failures,
    promotion_gate_trust_failures as _promotion_gate_trust_failures,
    promotion_record_for_lane as _promotion_record_for_lane,
    refresh_dspy_workflow_snapshots as _refresh_dspy_workflow_snapshots,
    requested_eval_report_ref_rejection as _requested_eval_report_ref_rejection,
    resolve_promotion_gate_snapshot as _resolve_promotion_gate_snapshot,
    resolved_eval_report_ref_rejection as _resolved_eval_report_ref_rejection,
    submit_and_persist_remote_dspy_lane as _submit_and_persist_remote_dspy_lane,
    untrusted_eval_snapshot as _untrusted_eval_snapshot,
    upsert_dspy_lane_submitted_record as _upsert_dspy_lane_submitted_record,
    upsert_dspy_lane_terminal_record as _upsert_dspy_lane_terminal_record,
    validate_dspy_workflow_request as _validate_dspy_workflow_request,
    wait_for_dspy_lane_terminal_phase as _wait_for_dspy_lane_terminal_phase,
    dataclass,
    orchestrate_dspy_agentrun_workflow,
)


def _load_eval_report_from_ref(ref: object) -> DSPyEvalReport | None:
    if ref is None:
        return None
    payload = _load_local_artifact_payload(str(ref))
    if payload is None:
        return None
    try:
        return DSPyEvalReport.model_validate(payload)
    except Exception:
        return None


def _normalize_optional_string(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _coerce_optional_float(value: object) -> float | None:
    normalized = _normalize_optional_string(value)
    if normalized is None:
        return None
    return float(normalized)


def _coerce_optional_int(value: object) -> int | None:
    normalized = _normalize_optional_string(value)
    if normalized is None:
        return None
    return int(normalized)


def _normalize_string_parameter(*, key: str, value: Any) -> str:
    if value is None:
        raise ValueError(f"parameter_{key}_must_be_non_null")
    if isinstance(value, (dict, list, tuple, set)):
        raise ValueError(f"parameter_{key}_must_be_string_coercible_scalar")
    text = str(value).strip()
    if not text:
        raise ValueError(f"parameter_{key}_must_be_non_empty")
    return text


def _execute_local_dspy_lane(
    *,
    session: Session,
    lane: DSPyWorkflowLane,
    repository: str,
    base: str,
    head: str,
    artifact_path: str,
    lane_overrides: Mapping[str, Any],
    compile_result_snapshot: DSPyCompileResult | None,
    eval_report_snapshot: DSPyEvalReport | None,
    promotion_record_snapshot: DSPyPromotionRecord | None,
) -> dict[str, Any]:
    output_dir = Path(artifact_path).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    if lane == "dataset-build":
        return _execute_local_dataset_build_lane(
            session=session,
            repository=repository,
            base=base,
            head=head,
            output_dir=output_dir,
            lane_overrides=lane_overrides,
        )
    if lane == "compile":
        return _execute_local_compile_lane(
            repository=repository,
            base=base,
            head=head,
            output_dir=output_dir,
            lane_overrides=lane_overrides,
        )
    if lane == "eval":
        return _execute_local_eval_lane(
            repository=repository,
            base=base,
            head=head,
            output_dir=output_dir,
            lane_overrides=lane_overrides,
        )
    if lane == "promote":
        return _execute_local_promote_lane(
            output_dir=output_dir,
            lane_overrides=lane_overrides,
            compile_result_snapshot=compile_result_snapshot,
            eval_report_snapshot=eval_report_snapshot,
            promotion_record_snapshot=promotion_record_snapshot,
        )
    raise RuntimeError(f"dspy_local_lane_unsupported:{lane}")


def _execute_local_dataset_build_lane(
    *,
    session: Session,
    repository: str,
    base: str,
    head: str,
    output_dir: Path,
    lane_overrides: Mapping[str, Any],
) -> dict[str, Any]:
    from ..dataset import build_dspy_dataset_artifacts

    result = build_dspy_dataset_artifacts(
        session,
        repository=repository,
        base=base,
        head=head,
        artifact_path=output_dir,
        dataset_window=_normalize_string_parameter(
            key="datasetWindow",
            value=lane_overrides.get("datasetWindow"),
        ),
        universe_ref=_normalize_string_parameter(
            key="universeRef",
            value=lane_overrides.get("universeRef"),
        ),
        window_end=_parse_iso_datetime(lane_overrides.get("windowEnd")),
    )
    return {
        "mode": "local",
        "lane": "dataset-build",
        "ok": True,
        "datasetHash": result.dataset_hash,
        "totalRows": result.total_rows,
        "rowCountsBySplit": result.row_counts_by_split,
        "datasetPath": str(result.dataset_path),
        "metadataPath": str(result.metadata_path),
    }


def _execute_local_compile_lane(
    *,
    repository: str,
    base: str,
    head: str,
    output_dir: Path,
    lane_overrides: Mapping[str, Any],
) -> dict[str, Any]:
    from ..compiler import compile_dspy_program_artifacts

    result = compile_dspy_program_artifacts(
        repository=repository,
        base=base,
        head=head,
        artifact_path=output_dir,
        dataset_ref=_normalize_string_parameter(
            key="datasetRef",
            value=lane_overrides.get("datasetRef"),
        ),
        metric_policy_ref=_normalize_string_parameter(
            key="metricPolicyRef",
            value=lane_overrides.get("metricPolicyRef"),
        ),
        optimizer=_normalize_string_parameter(
            key="optimizer",
            value=lane_overrides.get("optimizer"),
        ),
        schema_valid_rate=_coerce_optional_float(lane_overrides.get("schemaValidRate")),
        veto_alignment_rate=_coerce_optional_float(
            lane_overrides.get("vetoAlignmentRate")
        ),
        false_veto_rate=_coerce_optional_float(lane_overrides.get("falseVetoRate")),
        fallback_rate=_coerce_optional_float(lane_overrides.get("fallbackRate")),
        latency_p95_ms=_coerce_optional_int(lane_overrides.get("latencyP95Ms")),
    )
    return {
        "mode": "local",
        "lane": "compile",
        "ok": True,
        "artifactHash": result.compile_result.artifact_hash,
        "reproducibilityHash": result.compile_result.reproducibility_hash,
        "compileResultRef": str(result.compile_result_path),
        "compiledArtifactUri": result.compiled_artifact_uri,
        "compiledArtifactPath": str(result.compiled_artifact_path),
        "compileMetricsRef": str(result.compile_metrics_path),
    }


def _execute_local_eval_lane(
    *,
    repository: str,
    base: str,
    head: str,
    output_dir: Path,
    lane_overrides: Mapping[str, Any],
) -> dict[str, Any]:
    from ..evaluator import evaluate_dspy_compile_artifact

    result = evaluate_dspy_compile_artifact(
        repository=repository,
        base=base,
        head=head,
        artifact_path=output_dir,
        compile_result_ref=_normalize_string_parameter(
            key="compileResultRef",
            value=lane_overrides.get("compileResultRef"),
        ),
        gate_policy_ref=_normalize_string_parameter(
            key="gatePolicyRef",
            value=lane_overrides.get("gatePolicyRef"),
        ),
    )
    return {
        "mode": "local",
        "lane": "eval",
        "ok": True,
        "artifactHash": result.eval_report.artifact_hash,
        "evalHash": result.eval_report.eval_hash,
        "gateCompatibility": result.eval_report.gate_compatibility,
        "promotionRecommendation": result.eval_report.promotion_recommendation,
        "evalReportRef": str(result.eval_report_path),
    }


def _execute_local_promote_lane(
    *,
    output_dir: Path,
    lane_overrides: Mapping[str, Any],
    compile_result_snapshot: DSPyCompileResult | None,
    eval_report_snapshot: DSPyEvalReport | None,
    promotion_record_snapshot: DSPyPromotionRecord | None,
) -> dict[str, Any]:
    promotion_record = promotion_record_snapshot or _build_local_promotion_record(
        output_dir=output_dir,
        lane_overrides=lane_overrides,
        compile_result_snapshot=compile_result_snapshot,
        eval_report_snapshot=eval_report_snapshot,
    )
    return {
        "mode": "local",
        "lane": "promote",
        "ok": True,
        "artifactHash": promotion_record.artifact_hash,
        "promotionHash": promotion_record.promotion_hash,
        "promotionTarget": promotion_record.promotion_target,
        "approved": promotion_record.approved,
        "promotionRecordRef": str(output_dir / "dspy-promotion-record.json"),
    }


def _build_local_promotion_record(
    *,
    output_dir: Path,
    lane_overrides: Mapping[str, Any],
    compile_result_snapshot: DSPyCompileResult | None,
    eval_report_snapshot: DSPyEvalReport | None,
) -> DSPyPromotionRecord:
    compile_result = compile_result_snapshot or _load_compile_result_from_artifact_root(
        output_dir.parent
    )
    if compile_result is None:
        raise RuntimeError("dspy_promote_compile_result_missing")
    eval_report = eval_report_snapshot or _load_eval_report_from_ref(
        lane_overrides.get("evalReportRef")
    )
    if eval_report is None:
        raise RuntimeError("dspy_promote_eval_report_missing")
    promotion_record = build_promotion_record(
        eval_report=eval_report,
        promotion_target=cast(
            Literal["paper", "shadow", "constrained_live", "scaled_live"],
            _normalize_string_parameter(
                key="promotionTarget",
                value=lane_overrides.get("promotionTarget"),
            ),
        ),
        approved=True,
        approval_token_ref=_normalize_optional_string(
            lane_overrides.get("approvalRef")
        ),
        promoted_by="run_dspy_workflow.local",
    )
    write_artifact_bundle(
        output_dir,
        compile_result=compile_result,
        eval_report=eval_report,
        promotion_record=promotion_record,
    )
    return promotion_record


def _load_compile_result_from_artifact_root(
    artifact_root: Path,
) -> DSPyCompileResult | None:
    payload = _load_local_artifact_payload(
        str(artifact_root / "compile" / "dspy-compile-result.json")
    )
    if payload is None:
        return None
    try:
        return DSPyCompileResult.model_validate(payload)
    except Exception:
        return None


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
    "get_agents_agentrun",
    "wait_for_agents_agentrun_terminal_status",
    "submit_agents_agentrun",
    "upsert_workflow_artifact_record",
    "write_artifact_bundle",
]


__all__ = [name for name in globals() if not name.startswith("__")]
