"""DSPy compile/eval/promotion workflow helpers with Jangar-compatible contracts."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, cast

from sqlalchemy.orm import Session

from ..schemas import (
    DSPyCompileResult,
    DSPyEvalReport,
    DSPyPromotionRecord,
)


from .shared_context import (
    DSPyWorkflowExecutionMode,
    DSPyWorkflowLane,
    build_dspy_agentrun_payload,
    submit_agents_agentrun,
    upsert_workflow_artifact_record,
    wait_for_agents_agentrun_terminal_status,
)
from . import shared_context as _shared_context_private_33

_DEFAULT_DSPY_AGENT_NAME = getattr(
    _shared_context_private_33, "_DEFAULT_DSPY_AGENT_NAME"
)
_IDEMPOTENCY_HASH_HEX_LENGTH = getattr(
    _shared_context_private_33, "_IDEMPOTENCY_HASH_HEX_LENGTH"
)
_IMPLEMENTATION_SPEC_BY_LANE = getattr(
    _shared_context_private_33, "_IMPLEMENTATION_SPEC_BY_LANE"
)
_K8S_LABEL_VALUE_MAX_LENGTH = getattr(
    _shared_context_private_33, "_K8S_LABEL_VALUE_MAX_LENGTH"
)
_PROMOTION_EVAL_REPORT_MAX_AGE_SECONDS = getattr(
    _shared_context_private_33, "_PROMOTION_EVAL_REPORT_MAX_AGE_SECONDS"
)
_PROMOTION_EVIDENCE_OVERRIDE_KEYS = getattr(
    _shared_context_private_33, "_PROMOTION_EVIDENCE_OVERRIDE_KEYS"
)
_PROMOTION_MAX_FALLBACK_RATE = getattr(
    _shared_context_private_33, "_PROMOTION_MAX_FALLBACK_RATE"
)
_PROMOTION_MIN_SCHEMA_VALID_RATE = getattr(
    _shared_context_private_33, "_PROMOTION_MIN_SCHEMA_VALID_RATE"
)
_TERMINAL_PHASES = getattr(_shared_context_private_33, "_TERMINAL_PHASES")
_extract_submitted_agentrun_id = getattr(
    _shared_context_private_33, "_extract_submitted_agentrun_id"
)
_json_copy = getattr(_shared_context_private_33, "_json_copy")
_lane_overrides_with_defaults = getattr(
    _shared_context_private_33, "_lane_overrides_with_defaults"
)
_load_eval_gate_snapshot = getattr(
    _shared_context_private_33, "_load_eval_gate_snapshot"
)
_load_local_artifact_payload = getattr(
    _shared_context_private_33, "_load_local_artifact_payload"
)
_normalize_local_path = getattr(_shared_context_private_33, "_normalize_local_path")
_parse_iso_datetime = getattr(_shared_context_private_33, "_parse_iso_datetime")
_sanitize_idempotency_key = getattr(
    _shared_context_private_33, "_sanitize_idempotency_key"
)
_to_bool = getattr(_shared_context_private_33, "_to_bool")
_to_float = getattr(_shared_context_private_33, "_to_float")


def _resolve_promotion_gate_snapshot(
    lane_overrides: Mapping[str, Any],
    requested_eval_report_ref: str,
    *,
    artifact_root: str,
) -> dict[str, Any]:
    expected_eval_report_ref = f"{artifact_root.rstrip('/')}/eval/dspy-eval-report.json"
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

    requested_rejection = _requested_eval_report_ref_rejection(
        snapshot,
        requested_eval_report_ref=requested_eval_report_ref,
        artifact_root_path=artifact_root_path,
        expected_path=expected_path,
    )
    if requested_rejection is not None:
        return requested_rejection

    resolved_ref_path = _normalize_local_path(eval_report_ref)
    resolved_rejection = _resolved_eval_report_ref_rejection(
        snapshot,
        resolved_ref_path=resolved_ref_path,
        artifact_root_path=artifact_root_path,
        expected_path=expected_path,
    )
    if resolved_rejection is not None:
        return resolved_rejection
    resolved_ref_path = cast(Path, resolved_ref_path)

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


def _requested_eval_report_ref_rejection(
    snapshot: dict[str, Any],
    *,
    requested_eval_report_ref: str,
    artifact_root_path: Path,
    expected_path: Path,
) -> dict[str, Any] | None:
    if not requested_eval_report_ref:
        return None
    requested_ref_path = _normalize_local_path(requested_eval_report_ref)
    if requested_ref_path is None:
        return _untrusted_eval_snapshot(snapshot, reason="reference_not_local")
    if requested_ref_path == expected_path:
        return None
    reason = (
        "outside_artifact_root"
        if not requested_ref_path.is_relative_to(artifact_root_path)
        else "reference_override_disallowed"
    )
    return _untrusted_eval_snapshot(
        snapshot,
        reason=reason,
        path=requested_ref_path,
    )


def _resolved_eval_report_ref_rejection(
    snapshot: dict[str, Any],
    *,
    resolved_ref_path: Path | None,
    artifact_root_path: Path,
    expected_path: Path,
) -> dict[str, Any] | None:
    if resolved_ref_path is None:
        return _untrusted_eval_snapshot(snapshot, reason="reference_not_local")
    if not resolved_ref_path.is_relative_to(artifact_root_path):
        return _untrusted_eval_snapshot(snapshot, reason="outside_artifact_root")
    if resolved_ref_path != expected_path:
        return _untrusted_eval_snapshot(
            snapshot,
            reason="reference_override_disallowed",
        )
    return None


def _untrusted_eval_snapshot(
    snapshot: dict[str, Any],
    *,
    reason: str,
    path: Path | None = None,
) -> dict[str, Any]:
    snapshot["eval_report_trusted"] = False
    snapshot["eval_report_trust_reason"] = reason
    snapshot["eval_report_loaded"] = False
    if path is not None:
        snapshot["eval_report_path"] = str(path)
    return snapshot


def _promotion_gate_failures(
    gate_snapshot: Mapping[str, Any], *, now: datetime
) -> list[str]:
    return [
        *_promotion_gate_trust_failures(gate_snapshot),
        *_promotion_gate_created_at_failures(gate_snapshot, now=now),
        *_promotion_gate_compatibility_failures(gate_snapshot),
        *_promotion_gate_schema_failures(gate_snapshot),
        *_promotion_gate_determinism_failures(gate_snapshot),
        *_promotion_gate_fallback_failures(gate_snapshot),
    ]


def _promotion_gate_trust_failures(gate_snapshot: Mapping[str, Any]) -> list[str]:
    if not gate_snapshot.get("eval_report_trusted", False):
        trust_reason = str(gate_snapshot.get("eval_report_trust_reason") or "")
        if trust_reason == "outside_artifact_root":
            return ["eval_report_outside_artifact_root"]
        reason_map = {
            "reference_not_local": "eval_report_reference_not_local",
            "reference_override_disallowed": "eval_report_reference_override_disallowed",
            "missing_artifact": "eval_report_not_found",
            "invalid_artifact": "eval_report_invalid_payload",
        }
        return [reason_map.get(trust_reason, "eval_report_not_trusted")]
    if not gate_snapshot.get("eval_report_loaded", False):
        return ["eval_report_not_found"]
    return []


def _promotion_gate_created_at_failures(
    gate_snapshot: Mapping[str, Any], *, now: datetime
) -> list[str]:
    created_at = gate_snapshot.get("created_at")
    if created_at is None:
        return ["eval_report_created_at_missing"]
    if not isinstance(created_at, datetime):
        return ["eval_report_created_at_invalid"]
    if (now - created_at).total_seconds() > _PROMOTION_EVAL_REPORT_MAX_AGE_SECONDS:
        return ["eval_report_stale"]
    return []


def _promotion_gate_compatibility_failures(
    gate_snapshot: Mapping[str, Any],
) -> list[str]:
    gate_compatibility = (
        str(gate_snapshot.get("gate_compatibility") or "").strip().lower()
    )
    if gate_compatibility != "pass":
        return ["gate_compatibility_not_pass"]
    return []


def _promotion_gate_schema_failures(gate_snapshot: Mapping[str, Any]) -> list[str]:
    schema_valid_rate = _to_float(gate_snapshot.get("schema_valid_rate"))
    if schema_valid_rate is None:
        return ["schema_valid_rate_missing"]
    if schema_valid_rate < _PROMOTION_MIN_SCHEMA_VALID_RATE:
        return ["schema_valid_rate_below_min"]
    return []


def _promotion_gate_determinism_failures(
    gate_snapshot: Mapping[str, Any],
) -> list[str]:
    deterministic_compatibility = _to_bool(
        gate_snapshot.get("deterministic_compatibility")
    )
    if deterministic_compatibility is None:
        return ["deterministic_compatibility_missing"]
    if not deterministic_compatibility:
        return ["deterministic_compatibility_failed"]
    return []


def _promotion_gate_fallback_failures(gate_snapshot: Mapping[str, Any]) -> list[str]:
    fallback_rate = _to_float(gate_snapshot.get("fallback_rate"))
    if fallback_rate is None:
        return ["fallback_rate_missing"]
    if fallback_rate > _PROMOTION_MAX_FALLBACK_RATE:
        return ["fallback_rate_above_max"]
    return []


@dataclass(frozen=True)
class _DSPyWorkflowRequest:
    session: Session
    base_url: str
    repository: str
    base: str
    head: str
    artifact_root: str
    run_prefix: str
    auth_token: str | None
    issue_number: str
    priority_id: str | None
    lane_parameter_overrides: Mapping[DSPyWorkflowLane, Mapping[str, Any]] | None
    include_gepa_experiment: bool
    namespace: str
    agent_name: str
    vcs_ref_name: str
    secret_binding_ref: str
    ttl_seconds_after_finished: int
    execution_mode: DSPyWorkflowExecutionMode
    timeout_seconds: int
    poll_interval_seconds: int
    max_wait_seconds: int


@dataclass
class _DSPyWorkflowSnapshots:
    compile_result: DSPyCompileResult | None
    eval_report: DSPyEvalReport | None
    promotion_record: DSPyPromotionRecord | None


@dataclass
class _DSPyWorkflowState:
    responses: dict[DSPyWorkflowLane, dict[str, Any]]
    lineage_by_lane: dict[str, dict[str, Any]]
    snapshots: _DSPyWorkflowSnapshots


@dataclass(frozen=True)
class _DSPyLaneContext:
    lane: DSPyWorkflowLane
    lane_index: int
    lane_overrides: dict[str, Any]
    gate_snapshot: dict[str, Any] | None
    run_key: str
    idempotency_key: str
    artifact_path: str
    payload: dict[str, Any]


def orchestrate_dspy_agentrun_workflow(
    session: Session,
    **kwargs: Any,
) -> dict[DSPyWorkflowLane, dict[str, Any]]:
    """Execute dataset-build -> compile -> eval -> [gepa] -> promote and persist lineage rows."""
    request = _dspy_workflow_request_from_kwargs(session, kwargs)
    return _orchestrate_dspy_workflow(request)


def _dspy_workflow_request_from_kwargs(
    session: Session,
    kwargs: Mapping[str, Any],
) -> _DSPyWorkflowRequest:
    options = dict(kwargs)
    request = _DSPyWorkflowRequest(
        session=session,
        base_url=str(_pop_required_workflow_kwarg(options, "base_url")),
        repository=str(_pop_required_workflow_kwarg(options, "repository")),
        base=str(_pop_required_workflow_kwarg(options, "base")),
        head=str(_pop_required_workflow_kwarg(options, "head")),
        artifact_root=str(_pop_required_workflow_kwarg(options, "artifact_root")),
        run_prefix=str(_pop_required_workflow_kwarg(options, "run_prefix")),
        auth_token=cast(str | None, options.pop("auth_token", None)),
        issue_number=str(options.pop("issue_number", "0")),
        priority_id=cast(str | None, options.pop("priority_id", None)),
        lane_parameter_overrides=cast(
            Mapping[DSPyWorkflowLane, Mapping[str, Any]] | None,
            options.pop("lane_parameter_overrides", None),
        ),
        include_gepa_experiment=bool(options.pop("include_gepa_experiment", False)),
        namespace=str(options.pop("namespace", "agents")),
        agent_name=str(options.pop("agent_name", _DEFAULT_DSPY_AGENT_NAME)),
        vcs_ref_name=str(options.pop("vcs_ref_name", "github")),
        secret_binding_ref=str(options.pop("secret_binding_ref", "codex-github-token")),
        ttl_seconds_after_finished=int(
            options.pop("ttl_seconds_after_finished", 14_400)
        ),
        execution_mode=cast(
            DSPyWorkflowExecutionMode,
            options.pop("execution_mode", "agentrun"),
        ),
        timeout_seconds=int(options.pop("timeout_seconds", 20)),
        poll_interval_seconds=int(options.pop("poll_interval_seconds", 5)),
        max_wait_seconds=int(options.pop("max_wait_seconds", 3600)),
    )
    if options:
        raise TypeError(f"unexpected workflow arguments: {','.join(sorted(options))}")
    return request


def _pop_required_workflow_kwarg(options: dict[str, Any], key: str) -> Any:
    if key not in options:
        raise TypeError(f"missing required workflow argument: {key}")
    return options.pop(key)


def _orchestrate_dspy_workflow(
    request: _DSPyWorkflowRequest,
) -> dict[DSPyWorkflowLane, dict[str, Any]]:
    _validate_dspy_workflow_request(request)
    state = _DSPyWorkflowState(
        responses={},
        lineage_by_lane={},
        snapshots=_DSPyWorkflowSnapshots(
            compile_result=None,
            eval_report=None,
            promotion_record=None,
        ),
    )
    for lane_index, lane in enumerate(_dspy_workflow_lanes(request)):
        try:
            _orchestrate_dspy_workflow_lane(request, state, lane, lane_index)
        except Exception:
            request.session.rollback()
            raise
    return state.responses


def _validate_dspy_workflow_request(request: _DSPyWorkflowRequest) -> None:
    normalized_run_prefix = request.run_prefix.strip()
    if not normalized_run_prefix:
        raise ValueError("run_prefix_required")
    artifact_root_normalized = request.artifact_root.strip().rstrip("/")
    if not artifact_root_normalized:
        raise ValueError("artifact_root_required")


def _dspy_workflow_lanes(request: _DSPyWorkflowRequest) -> list[DSPyWorkflowLane]:
    lanes: list[DSPyWorkflowLane] = ["dataset-build", "compile", "eval"]
    if request.include_gepa_experiment:
        lanes.append("gepa-experiment")
    lanes.append("promote")
    return lanes


def _orchestrate_dspy_workflow_lane(
    request: _DSPyWorkflowRequest,
    state: _DSPyWorkflowState,
    lane: DSPyWorkflowLane,
    lane_index: int,
) -> None:
    context = _build_dspy_lane_context(request, state, lane, lane_index)
    if request.execution_mode == "local":
        _execute_and_persist_local_dspy_lane(request, state, context)
        return
    _submit_and_persist_remote_dspy_lane(request, state, context)


def _build_dspy_lane_context(
    request: _DSPyWorkflowRequest,
    state: _DSPyWorkflowState,
    lane: DSPyWorkflowLane,
    lane_index: int,
) -> _DSPyLaneContext:
    lane_overrides, requested_eval_report_ref = _lane_overrides_with_defaults(
        lane=lane,
        lane_overrides=(request.lane_parameter_overrides or {}).get(lane, {}),
        artifact_root=artifact_root_normalized(request),
    )
    gate_snapshot = _prepare_promotion_gate_snapshot(
        request,
        state,
        lane=lane,
        lane_index=lane_index,
        lane_overrides=lane_overrides,
        requested_eval_report_ref=requested_eval_report_ref,
    )
    run_key = _dspy_lane_run_key(request, lane)
    idempotency_key = _dspy_lane_idempotency_key(request, lane)
    artifact_path = f"{artifact_root_normalized(request)}/{lane}"
    payload = _build_dspy_lane_payload(
        request,
        lane=lane,
        idempotency_key=idempotency_key,
        artifact_path=artifact_path,
        lane_overrides=lane_overrides,
    )
    state.lineage_by_lane[lane] = {
        "artifactPath": artifact_path,
        "parameterOverrides": lane_overrides,
        "implementationSpecRef": _IMPLEMENTATION_SPEC_BY_LANE[lane],
        "gateSnapshot": gate_snapshot,
    }
    return _DSPyLaneContext(
        lane=lane,
        lane_index=lane_index,
        lane_overrides=lane_overrides,
        gate_snapshot=gate_snapshot,
        run_key=run_key,
        idempotency_key=idempotency_key,
        artifact_path=artifact_path,
        payload=payload,
    )


def artifact_root_normalized(request: _DSPyWorkflowRequest) -> str:
    return request.artifact_root.strip().rstrip("/")


def _dspy_lane_run_key(request: _DSPyWorkflowRequest, lane: DSPyWorkflowLane) -> str:
    return f"{request.run_prefix.strip()}:{lane}"


def _dspy_lane_idempotency_key(
    request: _DSPyWorkflowRequest, lane: DSPyWorkflowLane
) -> str:
    return _sanitize_idempotency_key(f"{request.run_prefix.strip()}-{lane}")


def _build_dspy_lane_payload(
    request: _DSPyWorkflowRequest,
    *,
    lane: DSPyWorkflowLane,
    idempotency_key: str,
    artifact_path: str,
    lane_overrides: Mapping[str, Any],
) -> dict[str, Any]:
    return build_dspy_agentrun_payload(
        lane=lane,
        idempotency_key=idempotency_key,
        repository=request.repository,
        base=request.base,
        head=request.head,
        artifact_path=artifact_path,
        parameter_overrides=lane_overrides,
        issue_number=request.issue_number,
        priority_id=request.priority_id,
        namespace=request.namespace,
        agent_name=request.agent_name,
        vcs_ref_name=request.vcs_ref_name,
        secret_binding_ref=request.secret_binding_ref,
        ttl_seconds_after_finished=request.ttl_seconds_after_finished,
    )


def _prepare_promotion_gate_snapshot(
    request: _DSPyWorkflowRequest,
    state: _DSPyWorkflowState,
    *,
    lane: DSPyWorkflowLane,
    lane_index: int,
    lane_overrides: dict[str, Any],
    requested_eval_report_ref: str,
) -> dict[str, Any] | None:
    if lane != "promote":
        return None
    _ensure_promotion_artifact_hash(request, state, lane_index, lane_overrides)
    gate_snapshot = _resolve_promotion_gate_snapshot(
        lane_overrides,
        requested_eval_report_ref=requested_eval_report_ref,
        artifact_root=artifact_root_normalized(request),
    )
    gate_failures = _promotion_gate_failures(
        gate_snapshot, now=datetime.now(timezone.utc)
    )
    if gate_failures:
        _persist_blocked_promotion_lane(
            request,
            state,
            lane_index=lane_index,
            gate_snapshot=gate_snapshot,
            gate_failures=gate_failures,
        )
        raise RuntimeError(f"dspy_promotion_gate_blocked:{','.join(gate_failures)}")
    return gate_snapshot


def _ensure_promotion_artifact_hash(
    request: _DSPyWorkflowRequest,
    state: _DSPyWorkflowState,
    lane_index: int,
    lane_overrides: dict[str, Any],
) -> None:
    if str(lane_overrides.get("artifactHash") or "").strip():
        return
    _refresh_dspy_workflow_snapshots(
        state, lane="compile", artifact_root=request.artifact_root
    )
    if state.snapshots.compile_result is not None:
        lane_overrides["artifactHash"] = state.snapshots.compile_result.artifact_hash
        return
    _persist_blocked_promotion_lane(
        request,
        state,
        lane_index=lane_index,
        gate_failures=["artifact_hash_missing"],
    )
    raise RuntimeError("dspy_promote_artifact_hash_missing")


def _persist_blocked_promotion_lane(
    request: _DSPyWorkflowRequest,
    state: _DSPyWorkflowState,
    *,
    lane_index: int,
    gate_failures: list[str],
    gate_snapshot: Mapping[str, Any] | None = None,
) -> None:
    lane: DSPyWorkflowLane = "promote"
    upsert_workflow_artifact_record(
        request.session,
        run_key=_dspy_lane_run_key(request, lane),
        lane=lane,
        status="blocked",
        implementation_spec_ref=_IMPLEMENTATION_SPEC_BY_LANE[lane],
        idempotency_key=_dspy_lane_idempotency_key(request, lane),
        request_payload=None,
        response_payload=None,
        compile_result=None,
        eval_report=None,
        promotion_record=None,
        metadata={
            "orchestration": {
                "runPrefix": request.run_prefix.strip(),
                "laneOrder": lane_index,
                "blockedAt": datetime.now(timezone.utc).isoformat(),
                "priorityId": request.priority_id,
                "lineageByLane": _json_copy(state.lineage_by_lane),
                **(
                    {"gateSnapshot": gate_snapshot} if gate_snapshot is not None else {}
                ),
                "gateFailures": gate_failures,
            }
        },
    )
    request.session.commit()


def _execute_and_persist_local_dspy_lane(
    request: _DSPyWorkflowRequest,
    state: _DSPyWorkflowState,
    context: _DSPyLaneContext,
) -> None:
    response_payload = _execute_local_dspy_lane(
        session=request.session,
        lane=context.lane,
        repository=request.repository,
        base=request.base,
        head=request.head,
        artifact_path=context.artifact_path,
        lane_overrides=context.lane_overrides,
        compile_result_snapshot=state.snapshots.compile_result,
        eval_report_snapshot=state.snapshots.eval_report,
        promotion_record_snapshot=state.snapshots.promotion_record,
    )
    state.responses[context.lane] = response_payload
    _refresh_dspy_workflow_snapshots(
        state, lane=context.lane, artifact_root=request.artifact_root
    )
    _upsert_dspy_lane_terminal_record(
        request,
        state,
        context,
        status="succeeded",
        request_payload={
            "runtime": {"type": "local"},
            "parameters": context.payload.get("parameters", {}),
        },
        response_payload=response_payload,
    )
    request.session.commit()


def _submit_and_persist_remote_dspy_lane(
    request: _DSPyWorkflowRequest,
    state: _DSPyWorkflowState,
    context: _DSPyLaneContext,
) -> None:
    response_payload = submit_agents_agentrun(
        base_url=request.base_url,
        payload=context.payload,
        idempotency_key=context.idempotency_key,
        auth_token=request.auth_token,
        timeout_seconds=request.timeout_seconds,
    )
    state.responses[context.lane] = response_payload
    _upsert_dspy_lane_submitted_record(request, state, context, response_payload)
    request.session.commit()
    terminal_phase = _wait_for_dspy_lane_terminal_phase(request, response_payload)
    _refresh_dspy_workflow_snapshots(
        state, lane=context.lane, artifact_root=request.artifact_root
    )
    _upsert_dspy_lane_terminal_record(
        request,
        state,
        context,
        status=terminal_phase,
        request_payload=context.payload,
        response_payload=response_payload,
    )
    request.session.commit()
    if terminal_phase != "succeeded":
        raise RuntimeError(
            f"agents_agentrun_not_succeeded:{context.lane}:{terminal_phase}"
        )


def _wait_for_dspy_lane_terminal_phase(
    request: _DSPyWorkflowRequest,
    response_payload: Mapping[str, Any],
) -> str:
    return wait_for_agents_agentrun_terminal_status(
        base_url=request.base_url,
        agent_run_id=_extract_submitted_agentrun_id(response_payload),
        namespace=request.namespace,
        auth_token=request.auth_token,
        timeout_seconds=request.timeout_seconds,
        poll_interval_seconds=request.poll_interval_seconds,
        max_wait_seconds=request.max_wait_seconds,
    )


def _upsert_dspy_lane_submitted_record(
    request: _DSPyWorkflowRequest,
    state: _DSPyWorkflowState,
    context: _DSPyLaneContext,
    response_payload: Mapping[str, Any],
) -> None:
    upsert_workflow_artifact_record(
        request.session,
        run_key=context.run_key,
        lane=context.lane,
        status="submitted",
        implementation_spec_ref=_IMPLEMENTATION_SPEC_BY_LANE[context.lane],
        idempotency_key=context.idempotency_key,
        request_payload=context.payload,
        response_payload=response_payload,
        compile_result=None,
        eval_report=None,
        promotion_record=None,
        metadata={
            "orchestration": {
                "runPrefix": request.run_prefix.strip(),
                "laneOrder": context.lane_index,
                "executionMode": request.execution_mode,
                "submittedAt": datetime.now(timezone.utc).isoformat(),
                "priorityId": request.priority_id,
                "lineageByLane": _json_copy(state.lineage_by_lane),
            }
        },
    )


def _upsert_dspy_lane_terminal_record(
    request: _DSPyWorkflowRequest,
    state: _DSPyWorkflowState,
    context: _DSPyLaneContext,
    *,
    status: str,
    request_payload: Mapping[str, Any],
    response_payload: Mapping[str, Any],
) -> None:
    upsert_workflow_artifact_record(
        request.session,
        run_key=context.run_key,
        lane=context.lane,
        status=status,
        implementation_spec_ref=_IMPLEMENTATION_SPEC_BY_LANE[context.lane],
        idempotency_key=context.idempotency_key,
        request_payload=request_payload,
        response_payload=response_payload,
        compile_result=_compile_result_for_lane(state, context.lane),
        eval_report=_eval_report_for_lane(state, context.lane),
        promotion_record=_promotion_record_for_lane(state, context.lane),
        metadata=_dspy_lane_terminal_metadata(request, state, context, status),
    )


def _dspy_lane_terminal_metadata(
    request: _DSPyWorkflowRequest,
    state: _DSPyWorkflowState,
    context: _DSPyLaneContext,
    terminal_phase: str,
) -> dict[str, Any]:
    return {
        **(
            {"executor": "dspy_live"}
            if state.snapshots.compile_result is not None
            else {}
        ),
        "orchestration": {
            "runPrefix": request.run_prefix.strip(),
            "laneOrder": context.lane_index,
            "executionMode": request.execution_mode,
            "terminalPhase": terminal_phase,
            "terminalObservedAt": datetime.now(timezone.utc).isoformat(),
            "priorityId": request.priority_id,
            "lineageByLane": _json_copy(state.lineage_by_lane),
        },
    }


def _compile_result_for_lane(
    state: _DSPyWorkflowState, lane: DSPyWorkflowLane
) -> DSPyCompileResult | None:
    return (
        state.snapshots.compile_result
        if lane in {"compile", "eval", "promote"}
        else None
    )


def _eval_report_for_lane(
    state: _DSPyWorkflowState, lane: DSPyWorkflowLane
) -> DSPyEvalReport | None:
    return state.snapshots.eval_report if lane in {"eval", "promote"} else None


def _promotion_record_for_lane(
    state: _DSPyWorkflowState, lane: DSPyWorkflowLane
) -> DSPyPromotionRecord | None:
    return state.snapshots.promotion_record if lane == "promote" else None


def _refresh_dspy_workflow_snapshots(
    state: _DSPyWorkflowState,
    *,
    lane: DSPyWorkflowLane,
    artifact_root: str,
) -> None:
    if lane in {"compile", "eval", "promote"}:
        state.snapshots.compile_result = (
            state.snapshots.compile_result
            or _load_dspy_model_snapshot(
                f"{artifact_root.strip().rstrip('/')}/compile/dspy-compile-result.json",
                DSPyCompileResult,
            )
        )
    if lane in {"eval", "promote"}:
        state.snapshots.eval_report = (
            state.snapshots.eval_report
            or _load_dspy_model_snapshot(
                f"{artifact_root.strip().rstrip('/')}/eval/dspy-eval-report.json",
                DSPyEvalReport,
            )
        )
    if lane == "promote":
        state.snapshots.promotion_record = (
            state.snapshots.promotion_record
            or _load_dspy_model_snapshot(
                f"{artifact_root.strip().rstrip('/')}/promote/dspy-promotion-record.json",
                DSPyPromotionRecord,
            )
        )


def _load_dspy_model_snapshot(artifact_ref: str, model_type: Any) -> Any | None:
    payload = _load_local_artifact_payload(artifact_ref)
    if payload is None:
        return None
    try:
        return model_type.model_validate(payload)
    except Exception:
        return None


def _execute_local_dspy_lane(**kwargs: Any) -> dict[str, Any]:
    from . import load_eval_report_from_ref as _load_eval_report_from_ref_private_865

    execute_local_dspy_lane = getattr(
        _load_eval_report_from_ref_private_865, "_execute_local_dspy_lane"
    )

    return execute_local_dspy_lane(**kwargs)


__all__ = (
    "orchestrate_dspy_agentrun_workflow",
    "artifact_root_normalized",
)

# Public aliases used by split modules.
build_dspy_lane_context = _build_dspy_lane_context
build_dspy_lane_payload = _build_dspy_lane_payload
compile_result_for_lane = _compile_result_for_lane
dspy_lane_idempotency_key = _dspy_lane_idempotency_key
dspy_lane_run_key = _dspy_lane_run_key
dspy_lane_terminal_metadata = _dspy_lane_terminal_metadata
dspy_workflow_lanes = _dspy_workflow_lanes
dspy_workflow_request_from_kwargs = _dspy_workflow_request_from_kwargs
DSPyLaneContext = _DSPyLaneContext
DSPyWorkflowRequest = _DSPyWorkflowRequest
DSPyWorkflowSnapshots = _DSPyWorkflowSnapshots
DSPyWorkflowState = _DSPyWorkflowState
ensure_promotion_artifact_hash = _ensure_promotion_artifact_hash
eval_report_for_lane = _eval_report_for_lane
execute_and_persist_local_dspy_lane = _execute_and_persist_local_dspy_lane
load_dspy_model_snapshot = _load_dspy_model_snapshot
load_eval_snapshot_for_promotion = _load_eval_snapshot_for_promotion
orchestrate_dspy_workflow = _orchestrate_dspy_workflow
orchestrate_dspy_workflow_lane = _orchestrate_dspy_workflow_lane
persist_blocked_promotion_lane = _persist_blocked_promotion_lane
pop_required_workflow_kwarg = _pop_required_workflow_kwarg
prepare_promotion_gate_snapshot = _prepare_promotion_gate_snapshot
promotion_gate_compatibility_failures = _promotion_gate_compatibility_failures
promotion_gate_created_at_failures = _promotion_gate_created_at_failures
promotion_gate_determinism_failures = _promotion_gate_determinism_failures
promotion_gate_failures = _promotion_gate_failures
promotion_gate_fallback_failures = _promotion_gate_fallback_failures
promotion_gate_schema_failures = _promotion_gate_schema_failures
promotion_gate_trust_failures = _promotion_gate_trust_failures
promotion_record_for_lane = _promotion_record_for_lane
refresh_dspy_workflow_snapshots = _refresh_dspy_workflow_snapshots
requested_eval_report_ref_rejection = _requested_eval_report_ref_rejection
resolve_promotion_gate_snapshot = _resolve_promotion_gate_snapshot
resolved_eval_report_ref_rejection = _resolved_eval_report_ref_rejection
submit_and_persist_remote_dspy_lane = _submit_and_persist_remote_dspy_lane
untrusted_eval_snapshot = _untrusted_eval_snapshot
upsert_dspy_lane_submitted_record = _upsert_dspy_lane_submitted_record
upsert_dspy_lane_terminal_record = _upsert_dspy_lane_terminal_record
validate_dspy_workflow_request = _validate_dspy_workflow_request
wait_for_dspy_lane_terminal_phase = _wait_for_dspy_lane_terminal_phase
