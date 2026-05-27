"""Traceability helpers for doc 29 completion gates."""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from functools import lru_cache
from pathlib import Path
from typing import Any, Mapping, Sequence, cast
from zoneinfo import ZoneInfo

import yaml
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import (
    StrategyHypothesisMetricWindow,
    StrategyPromotionDecision,
    StrategyRuntimeLedgerBucket,
    VNextCompletionGateResult,
    VNextEmpiricalJobRun,
)
from .empirical_jobs import EMPIRICAL_JOB_TYPES, build_empirical_jobs_status
from .hypotheses import HypothesisManifest, load_hypothesis_registry
from .runtime_ledger import EXACT_REPLAY_LEDGER_SCHEMA_VERSION, POST_COST_PNL_BASIS


def _runtime_matrix_path() -> Path:
    return Path(__file__).resolve().parents[2] / 'config' / 'completion' / 'doc29-completion-matrix.yaml'


def _doc_matrix_path() -> Path:
    current = Path(__file__).resolve()
    for parent in current.parents:
        candidate = parent / 'docs' / 'torghut' / 'design-system' / 'v6' / '29-completion-matrix-2026-03-07.yaml'
        if candidate.exists():
            return candidate
    return _runtime_matrix_path()


DOC29_COMPLETION_MATRIX_RUNTIME_PATH = _runtime_matrix_path()
DOC29_COMPLETION_MATRIX_DOC_PATH = _doc_matrix_path()

DOC29_COMPLETION_ENDPOINT = '/trading/completion/doc29'

TRACE_STATUS_SATISFIED = 'satisfied'
TRACE_STATUS_BLOCKED = 'blocked'
TRACE_STATUS_STALE = 'stale'
TRACE_STATUS_REGRESSED = 'regressed'
TRACE_STATUSES = {
    TRACE_STATUS_SATISFIED,
    TRACE_STATUS_BLOCKED,
    TRACE_STATUS_STALE,
    TRACE_STATUS_REGRESSED,
}

DOC29_SIMULATION_SMOKE_GATE = 'simulation_smoke_execution_funnel'
DOC29_SIMULATION_FULL_DAY_GATE = 'simulation_full_day_coverage'
DOC29_EMPIRICAL_MANIFEST_GATE = 'empirical_manifest_schema_valid'
DOC29_EMPIRICAL_JOBS_GATE = 'empirical_jobs_persisted'
DOC29_PAPER_GATE = 'paper_gate_satisfied'
DOC29_LIVE_CANARY_GATE = 'live_canary_observed'
DOC29_LIVE_SCALE_GATE = 'live_scale_observed'
US_EQUITIES_REGULAR_TIMEZONE = 'America/New_York'


def _as_dict(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): item for key, item in cast(Mapping[str, Any], value).items()}


def _as_list(value: Any) -> list[Any]:
    if not isinstance(value, list):
        return []
    return [item for item in cast(list[Any], value)]


def _as_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return text


def _safe_int(value: Any, *, default: int = 0) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        stripped = value.strip()
        if stripped:
            try:
                return int(stripped)
            except ValueError:
                return default
    return default


def _safe_float(value: Any, *, default: float = 0.0) -> float:
    if isinstance(value, bool):
        return float(int(value))
    if isinstance(value, (Decimal, int, float)):
        return float(value)
    if isinstance(value, str):
        stripped = value.strip()
        if stripped:
            try:
                return float(stripped)
            except ValueError:
                return default
    return default


def _runtime_ledger_trading_day_key(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(ZoneInfo(US_EQUITIES_REGULAR_TIMEZONE)).date().isoformat()


def _median_decimal(values: Sequence[Decimal]) -> Decimal:
    if not values:
        return Decimal('0')
    sorted_values = sorted(values)
    middle = len(sorted_values) // 2
    if len(sorted_values) % 2:
        return sorted_values[middle]
    return (sorted_values[middle - 1] + sorted_values[middle]) / Decimal('2')


def _p10_decimal(values: Sequence[Decimal]) -> Decimal:
    if not values:
        return Decimal('0')
    sorted_values = sorted(values)
    index = max(0, ((len(sorted_values) + 9) // 10) - 1)
    return sorted_values[index]


def _gate_policy_parameters(
    gate_definition: Mapping[str, Any] | None,
) -> dict[str, Any]:
    if gate_definition is None:
        return {}
    return _as_dict(gate_definition.get('policy_parameters'))


def _policy_int(
    policy_parameters: Mapping[str, Any],
    key: str,
    *,
    default: int,
) -> int:
    value = _safe_int(policy_parameters.get(key), default=default)
    return value if value > 0 else default


def _load_hypothesis_manifests_by_id() -> dict[str, HypothesisManifest]:
    try:
        registry = load_hypothesis_registry(raise_on_error=True)
    except Exception:
        return {}
    return {item.hypothesis_id: item for item in registry.items}


def _candidate_hypothesis_manifests(
    *,
    candidate_id: str | None,
    rows: Sequence[StrategyHypothesisMetricWindow] = (),
) -> list[HypothesisManifest]:
    manifests_by_id = _load_hypothesis_manifests_by_id()
    selected: dict[str, HypothesisManifest] = {}
    for row in rows:
        manifest = manifests_by_id.get(row.hypothesis_id)
        if manifest is not None:
            selected[manifest.hypothesis_id] = manifest
    if candidate_id:
        for manifest in manifests_by_id.values():
            if manifest.candidate_id == candidate_id:
                selected[manifest.hypothesis_id] = manifest
    return list(selected.values())


def _manifest_runtime_session_threshold(
    *,
    candidate_id: str | None,
    rows: Sequence[StrategyHypothesisMetricWindow],
    policy_parameters: Mapping[str, Any],
    fallback_key: str,
    default: int,
    manifest_attr: str,
) -> int:
    threshold = _policy_int(policy_parameters, fallback_key, default=default)
    manifests = _candidate_hypothesis_manifests(candidate_id=candidate_id, rows=rows)
    manifest_thresholds = [
        int(value) for manifest in manifests if (value := getattr(manifest, manifest_attr, None)) is not None
    ]
    if manifest_thresholds:
        threshold = max(threshold, max(manifest_thresholds))
    return threshold


def _load_yaml_mapping(path: Path) -> dict[str, Any]:
    payload = yaml.safe_load(path.read_text(encoding='utf-8'))
    if not isinstance(payload, Mapping):
        raise RuntimeError(f'completion matrix must be a mapping: {path}')
    return {str(key): value for key, value in cast(Mapping[str, Any], payload).items()}


def _normalize_gate_definition(payload: Mapping[str, Any]) -> dict[str, Any]:
    definition = {str(key): value for key, value in payload.items()}
    required_keys = {
        'gate_id',
        'requirement_summary',
        'source_design_doc_section',
        'acceptance_rule',
        'required_artifacts',
        'required_db_queries',
        'required_status_fields',
        'required_cluster_resources',
        'blocking_conditions',
        'evidence_freshness_rule',
    }
    missing = sorted(key for key in required_keys if key not in definition)
    if missing:
        raise RuntimeError(
            f'completion matrix gate missing keys: {",".join(missing)} gate={definition.get("gate_id")!r}'
        )
    gate_id = _as_text(definition.get('gate_id'))
    if gate_id is None:
        raise RuntimeError('completion matrix gate_id must be non-empty')
    normalized = {
        'gate_id': gate_id,
        'requirement_summary': _as_text(definition.get('requirement_summary')) or '',
        'source_design_doc_section': _as_text(definition.get('source_design_doc_section')) or '',
        'acceptance_rule': _as_text(definition.get('acceptance_rule')) or '',
        'required_artifacts': [str(item) for item in _as_list(definition.get('required_artifacts'))],
        'required_db_queries': [str(item) for item in _as_list(definition.get('required_db_queries'))],
        'required_status_fields': [str(item) for item in _as_list(definition.get('required_status_fields'))],
        'required_cluster_resources': [str(item) for item in _as_list(definition.get('required_cluster_resources'))],
        'blocking_conditions': [str(item) for item in _as_list(definition.get('blocking_conditions'))],
        'evidence_freshness_rule': _as_dict(definition.get('evidence_freshness_rule')),
        'dependencies': [str(item) for item in _as_list(definition.get('dependencies'))],
        'evaluation_mode': _as_text(definition.get('evaluation_mode')) or 'recorded',
    }
    return normalized


def validate_doc29_completion_matrix(payload: Mapping[str, Any]) -> dict[str, Any]:
    matrix = {str(key): value for key, value in payload.items()}
    gates_raw = matrix.get('gates')
    if not isinstance(gates_raw, list):
        raise RuntimeError('completion matrix must contain a gates list')
    gates_list = cast(list[Any], gates_raw)
    gates = [_normalize_gate_definition(_as_dict(item)) for item in gates_list]
    gate_ids = [str(item['gate_id']) for item in gates]
    duplicates = sorted({gate_id for gate_id in gate_ids if gate_ids.count(gate_id) > 1})
    if duplicates:
        raise RuntimeError(f'duplicate completion matrix gate ids: {",".join(duplicates)}')
    known_gate_ids = set(gate_ids)
    for gate in gates:
        for dependency in cast(list[str], gate['dependencies']):
            if dependency not in known_gate_ids:
                raise RuntimeError(
                    f'completion matrix gate {gate["gate_id"]!r} references unknown dependency {dependency!r}'
                )
    return {
        'doc_id': _as_text(matrix.get('doc_id')) or 'doc29',
        'design_doc_path': _as_text(matrix.get('design_doc_path'))
        or 'docs/torghut/design-system/v6/29-code-investigated-vnext-architecture-reset-2026-03-06.md',
        'matrix_version': _as_text(matrix.get('matrix_version')) or '2026-03-07',
        'gates': gates,
    }


@lru_cache(maxsize=1)
def load_doc29_completion_matrix() -> dict[str, Any]:
    runtime_payload = _load_yaml_mapping(DOC29_COMPLETION_MATRIX_RUNTIME_PATH)
    return validate_doc29_completion_matrix(runtime_payload)


def runtime_and_doc_completion_matrices_match() -> bool:
    runtime_payload = validate_doc29_completion_matrix(_load_yaml_mapping(DOC29_COMPLETION_MATRIX_RUNTIME_PATH))
    doc_payload = validate_doc29_completion_matrix(_load_yaml_mapping(DOC29_COMPLETION_MATRIX_DOC_PATH))
    return runtime_payload == doc_payload


def build_completion_trace(
    *,
    doc_id: str,
    gate_ids_attempted: Sequence[str],
    run_id: str,
    dataset_snapshot_ref: str | None,
    candidate_id: str | None,
    workflow_name: str | None,
    analysis_run_names: Sequence[str],
    artifact_refs: Sequence[str],
    db_row_refs: Mapping[str, Any],
    status_snapshot: Mapping[str, Any],
    result_by_gate: Mapping[str, Mapping[str, Any]],
    blocked_reasons: Mapping[str, str],
    git_revision: str | None = None,
    image_digest: str | None = None,
    workflow_template_revision: str | None = None,
) -> dict[str, Any]:
    return {
        'doc_id': doc_id,
        'gate_ids_attempted': [str(item) for item in gate_ids_attempted if str(item).strip()],
        'run_id': run_id,
        'dataset_snapshot_ref': dataset_snapshot_ref,
        'candidate_id': candidate_id,
        'git_revision': git_revision or os.getenv('TORGHUT_COMMIT', 'unknown').strip() or 'unknown',
        'image_digest': image_digest or _as_text(os.getenv('TORGHUT_IMAGE_DIGEST')),
        'workflow_name': workflow_name or _as_text(os.getenv('ARGO_WORKFLOW_NAME')),
        'workflow_template_revision': workflow_template_revision
        or _as_text(os.getenv('TORGHUT_WORKFLOW_TEMPLATE_REVISION')),
        'analysis_run_names': [str(item) for item in analysis_run_names if str(item).strip()],
        'artifact_refs': [str(item) for item in artifact_refs if str(item).strip()],
        'db_row_refs': dict(db_row_refs),
        'status_snapshot': dict(status_snapshot),
        'result_by_gate': {str(key): dict(value) for key, value in result_by_gate.items()},
        'blocked_reasons': {str(key): str(value) for key, value in blocked_reasons.items()},
        'measured_at': datetime.now(timezone.utc).isoformat(),
    }


def upsert_completion_gate_result(
    *,
    session: Session,
    gate_id: str,
    run_id: str,
    candidate_id: str | None,
    dataset_snapshot_ref: str | None,
    git_revision: str | None,
    image_digest: str | None,
    status: str,
    artifact_ref: str | None,
    blocked_reason: str | None,
    details_json: Mapping[str, Any],
    workflow_name: str | None,
    measured_at: datetime | None = None,
) -> VNextCompletionGateResult:
    if status not in TRACE_STATUSES:
        raise RuntimeError(f'invalid completion gate result status: {status}')
    existing = session.execute(
        select(VNextCompletionGateResult).where(
            VNextCompletionGateResult.gate_id == gate_id,
            VNextCompletionGateResult.run_id == run_id,
        )
    ).scalar_one_or_none()
    record = existing or VNextCompletionGateResult(
        gate_id=gate_id,
        run_id=run_id,
        candidate_id=candidate_id,
        dataset_snapshot_ref=dataset_snapshot_ref,
        git_revision=git_revision,
        image_digest=image_digest,
        workflow_name=workflow_name,
        status=status,
        artifact_ref=artifact_ref,
        blocked_reason=blocked_reason,
        details_json=dict(details_json),
        measured_at=measured_at or datetime.now(timezone.utc),
    )
    record.gate_id = gate_id
    record.run_id = run_id
    record.candidate_id = candidate_id
    record.dataset_snapshot_ref = dataset_snapshot_ref
    record.git_revision = git_revision
    record.image_digest = image_digest
    record.workflow_name = workflow_name
    record.status = status
    record.artifact_ref = artifact_ref
    record.blocked_reason = blocked_reason
    record.details_json = dict(details_json)
    record.measured_at = measured_at or datetime.now(timezone.utc)
    session.add(record)
    session.flush()
    return record


def persist_completion_trace(
    *,
    session: Session,
    trace_payload: Mapping[str, Any],
    default_artifact_ref: str | None = None,
) -> dict[str, str]:
    gate_row_ids: dict[str, str] = {}
    result_by_gate = _as_dict(trace_payload.get('result_by_gate'))
    artifact_refs = [str(item) for item in _as_list(trace_payload.get('artifact_refs')) if str(item).strip()]
    measured_at = datetime.now(timezone.utc)
    measured_at_raw = _as_text(trace_payload.get('measured_at'))
    if measured_at_raw is not None:
        try:
            measured_at = datetime.fromisoformat(measured_at_raw.replace('Z', '+00:00')).astimezone(timezone.utc)
        except ValueError:
            measured_at = datetime.now(timezone.utc)
    for gate_id, result in result_by_gate.items():
        result_payload = _as_dict(result)
        status = _as_text(result_payload.get('status')) or TRACE_STATUS_BLOCKED
        blocked_reason = _as_text(result_payload.get('blocked_reason'))
        artifact_ref = _as_text(result_payload.get('artifact_ref')) or default_artifact_ref
        if artifact_ref is None and artifact_refs:
            artifact_ref = artifact_refs[0]
        record = upsert_completion_gate_result(
            session=session,
            gate_id=gate_id,
            run_id=_as_text(trace_payload.get('run_id')) or '',
            candidate_id=_as_text(trace_payload.get('candidate_id')),
            dataset_snapshot_ref=_as_text(trace_payload.get('dataset_snapshot_ref')),
            git_revision=_as_text(trace_payload.get('git_revision')),
            image_digest=_as_text(trace_payload.get('image_digest')),
            workflow_name=_as_text(trace_payload.get('workflow_name')),
            status=status,
            artifact_ref=artifact_ref,
            blocked_reason=blocked_reason,
            details_json={
                'gate_id': gate_id,
                'doc_id': _as_text(trace_payload.get('doc_id')) or 'doc29',
                'artifact_refs': artifact_refs,
                'db_row_refs': _as_dict(trace_payload.get('db_row_refs')),
                'status_snapshot': _as_dict(trace_payload.get('status_snapshot')),
                'gate_result': result_payload,
                'analysis_run_names': _as_list(trace_payload.get('analysis_run_names')),
                'blocked_reasons': _as_dict(trace_payload.get('blocked_reasons')),
            },
            measured_at=measured_at,
        )
        gate_row_ids[gate_id] = str(record.id)
    return gate_row_ids


def _latest_completion_rows(session: Session) -> dict[str, VNextCompletionGateResult]:
    return _latest_completion_rows_filtered(session)


def _latest_completion_rows_filtered(
    session: Session,
    *,
    candidate_id: str | None = None,
    dataset_snapshot_ref: str | None = None,
) -> dict[str, VNextCompletionGateResult]:
    rows = session.execute(
        select(VNextCompletionGateResult).order_by(VNextCompletionGateResult.measured_at.desc())
    ).scalars()
    latest: dict[str, VNextCompletionGateResult] = {}
    for row in rows:
        if candidate_id is not None and row.candidate_id != candidate_id:
            continue
        if dataset_snapshot_ref is not None and row.dataset_snapshot_ref != dataset_snapshot_ref:
            continue
        if row.gate_id in latest:
            continue
        latest[row.gate_id] = row
    return latest


def _latest_empirical_rows(session: Session) -> dict[str, VNextEmpiricalJobRun]:
    rows = session.execute(select(VNextEmpiricalJobRun).order_by(VNextEmpiricalJobRun.created_at.desc())).scalars()
    latest: dict[str, VNextEmpiricalJobRun] = {}
    for row in rows:
        if row.job_type not in EMPIRICAL_JOB_TYPES or row.job_type in latest:
            continue
        latest[row.job_type] = row
    return latest


def _latest_hypothesis_windows(
    session: Session,
    *,
    observed_stage: str,
    max_age_seconds: int | None = None,
) -> list[StrategyHypothesisMetricWindow]:
    rows = session.execute(
        select(StrategyHypothesisMetricWindow)
        .where(StrategyHypothesisMetricWindow.observed_stage == observed_stage)
        .order_by(
            StrategyHypothesisMetricWindow.window_ended_at.desc().nullslast(),
            StrategyHypothesisMetricWindow.created_at.desc(),
        )
    ).scalars()
    if max_age_seconds is None or max_age_seconds <= 0:
        return [row for row in rows]
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=max_age_seconds)
    filtered: list[StrategyHypothesisMetricWindow] = []
    for row in rows:
        measured_at = row.window_ended_at or row.created_at
        if measured_at.tzinfo is None:
            measured_at = measured_at.replace(tzinfo=timezone.utc)
        if measured_at >= cutoff:
            filtered.append(row)
    return filtered


_PromotionDecisionKey = tuple[str, str, str, str]


def _promotion_decision_key(
    *,
    run_id: object,
    hypothesis_id: object,
    candidate_id: object,
    promotion_target: object,
) -> _PromotionDecisionKey | None:
    run_text = _as_text(run_id)
    hypothesis_text = _as_text(hypothesis_id)
    candidate_text = _as_text(candidate_id)
    target_text = _as_text(promotion_target)
    if run_text is None or hypothesis_text is None or candidate_text is None or target_text is None:
        return None
    return run_text, hypothesis_text, candidate_text, target_text


def _promotion_decision_key_for_window(
    row: StrategyHypothesisMetricWindow,
) -> _PromotionDecisionKey | None:
    return _promotion_decision_key(
        run_id=row.run_id,
        hypothesis_id=row.hypothesis_id,
        candidate_id=row.candidate_id,
        promotion_target=row.observed_stage,
    )


def _promotion_decision_key_for_decision(
    row: StrategyPromotionDecision,
) -> _PromotionDecisionKey | None:
    return _promotion_decision_key(
        run_id=row.run_id,
        hypothesis_id=row.hypothesis_id,
        candidate_id=row.candidate_id,
        promotion_target=row.promotion_target,
    )


def _promotion_decision_keys_for_windows(
    session: Session,
    rows: Sequence[StrategyHypothesisMetricWindow],
) -> tuple[set[_PromotionDecisionKey], set[_PromotionDecisionKey]]:
    hypothesis_ids = sorted(
        {hypothesis_id for row in rows if (hypothesis_id := _as_text(row.hypothesis_id)) is not None}
    )
    if not hypothesis_ids:
        return set(), set()
    decision_rows = session.execute(
        select(StrategyPromotionDecision)
        .where(StrategyPromotionDecision.hypothesis_id.in_(hypothesis_ids))
        .order_by(StrategyPromotionDecision.created_at.desc())
    ).scalars()
    allowed: set[_PromotionDecisionKey] = set()
    denied: set[_PromotionDecisionKey] = set()
    for row in decision_rows:
        key = _promotion_decision_key_for_decision(row)
        if key is None:
            continue
        if bool(row.allowed):
            allowed.add(key)
        else:
            denied.add(key)
    return allowed, denied


def _promotion_decision_blocked_reason(
    rows: Sequence[StrategyHypothesisMetricWindow],
    *,
    allowed_keys: set[_PromotionDecisionKey],
    denied_keys: set[_PromotionDecisionKey],
) -> str | None:
    if not rows:
        return None
    has_denied_match = False
    for row in rows:
        key = _promotion_decision_key_for_window(row)
        if key is None:
            continue
        if key in allowed_keys:
            return None
        if key in denied_keys:
            has_denied_match = True
    return 'promotion_decision_not_allowed' if has_denied_match else 'promotion_decision_evidence_missing'


def _windows_with_allowed_promotion_decisions(
    rows: Sequence[StrategyHypothesisMetricWindow],
    *,
    allowed_keys: set[_PromotionDecisionKey],
) -> list[StrategyHypothesisMetricWindow]:
    return [row for row in rows if (key := _promotion_decision_key_for_window(row)) is not None and key in allowed_keys]


_RUNTIME_LEDGER_BUCKET_SCHEMAS = frozenset(
    {
        EXACT_REPLAY_LEDGER_SCHEMA_VERSION,
        'torghut.runtime-ledger-bucket.v1',
    }
)


def _utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _positive_hash_count(value: Any) -> bool:
    mapping = _as_dict(value)
    return bool(mapping) and any(_safe_int(count) > 0 for count in mapping.values())


def _runtime_ledger_bucket_matches_window(
    bucket: StrategyRuntimeLedgerBucket,
    window: StrategyHypothesisMetricWindow,
) -> bool:
    identity_matches = (
        _as_text(bucket.run_id) == _as_text(window.run_id)
        and _as_text(bucket.hypothesis_id) == _as_text(window.hypothesis_id)
        and _as_text(bucket.candidate_id) == _as_text(window.candidate_id)
        and _as_text(bucket.observed_stage) == _as_text(window.observed_stage)
    )
    if not identity_matches:
        return False
    window_started = _utc(window.window_started_at)
    window_ended = _utc(window.window_ended_at)
    bucket_started = _utc(bucket.bucket_started_at)
    bucket_ended = _utc(bucket.bucket_ended_at)
    if window_started is None or window_ended is None or bucket_started is None or bucket_ended is None:
        return False
    return bucket_started <= window_started and bucket_ended >= window_ended


def _runtime_ledger_bucket_window_match_key(
    bucket: StrategyRuntimeLedgerBucket,
    window: StrategyHypothesisMetricWindow,
) -> tuple[int, float, float, float, str]:
    window_started = _utc(window.window_started_at)
    window_ended = _utc(window.window_ended_at)
    bucket_started = _utc(bucket.bucket_started_at)
    bucket_ended = _utc(bucket.bucket_ended_at)
    if window_started is None or window_ended is None or bucket_started is None or bucket_ended is None:
        return (1, float('inf'), 0.0, 0.0, str(bucket.id))
    exact_boundary_miss = int(bucket_started != window_started or bucket_ended != window_ended)
    bucket_duration = max(0.0, (bucket_ended - bucket_started).total_seconds())
    window_duration = max(0.0, (window_ended - window_started).total_seconds())
    overcoverage_seconds = max(0.0, bucket_duration - window_duration)
    created_at = _utc(bucket.created_at)
    return (
        exact_boundary_miss,
        overcoverage_seconds,
        -bucket_ended.timestamp(),
        -created_at.timestamp() if created_at is not None else 0.0,
        str(bucket.id),
    )


def _runtime_ledger_bucket_is_promotion_grade(
    bucket: StrategyRuntimeLedgerBucket,
) -> bool:
    blockers = [item for item in _as_list(bucket.blockers_json) if str(item).strip()]
    return (
        _as_text(bucket.ledger_schema_version) in _RUNTIME_LEDGER_BUCKET_SCHEMAS
        and _as_text(bucket.pnl_basis) == POST_COST_PNL_BASIS
        and not blockers
        and _safe_int(bucket.fill_count) > 0
        and _safe_int(bucket.decision_count) > 0
        and _safe_int(bucket.submitted_order_count) > 0
        and _safe_int(bucket.closed_trade_count) > 0
        and _safe_int(bucket.open_position_count) == 0
        and bucket.filled_notional > 0
        and _positive_hash_count(bucket.execution_policy_hash_counts)
        and _positive_hash_count(bucket.cost_model_hash_counts)
        and _positive_hash_count(bucket.lineage_hash_counts)
    )


def _runtime_ledger_bucket_summary(
    rows: Sequence[StrategyRuntimeLedgerBucket],
) -> dict[str, Any]:
    total_filled_notional = sum(
        (row.filled_notional for row in rows),
        Decimal('0'),
    )
    total_net_pnl = sum(
        (row.net_strategy_pnl_after_costs for row in rows),
        Decimal('0'),
    )
    expectancy_bps = (
        float((total_net_pnl / total_filled_notional) * Decimal('10000')) if total_filled_notional > 0 else 0.0
    )
    daily_summary = _runtime_ledger_daily_summary(rows)
    return {
        'runtime_ledger_bucket_count': len(rows),
        'runtime_ledger_fill_count': sum(max(0, _safe_int(row.fill_count)) for row in rows),
        'runtime_ledger_submitted_order_count': sum(max(0, _safe_int(row.submitted_order_count)) for row in rows),
        'runtime_ledger_closed_trade_count': sum(max(0, _safe_int(row.closed_trade_count)) for row in rows),
        'runtime_ledger_filled_notional': float(total_filled_notional),
        'runtime_ledger_net_strategy_pnl_after_costs': float(total_net_pnl),
        'runtime_ledger_post_cost_expectancy_bps': expectancy_bps,
        **daily_summary,
        'db_row_refs': [str(row.id) for row in rows],
    }


def _runtime_ledger_daily_summary(
    rows: Sequence[StrategyRuntimeLedgerBucket],
) -> dict[str, Any]:
    persisted = _runtime_ledger_persisted_daily_summary(rows)
    if persisted:
        return persisted
    trading_days = sorted({_runtime_ledger_trading_day_key(row.bucket_started_at) for row in rows})
    net_pnl_by_day = {day: Decimal('0') for day in trading_days}
    filled_notional_by_day = {day: Decimal('0') for day in trading_days}
    closed_trade_count_by_day = {day: 0 for day in trading_days}
    cumulative_by_day = {day: Decimal('0') for day in trading_days}
    peak_by_day = {day: Decimal('0') for day in trading_days}
    max_intraday_drawdown = Decimal('0')
    for row in sorted(rows, key=lambda item: item.bucket_started_at or item.created_at):
        day = _runtime_ledger_trading_day_key(row.bucket_started_at)
        net_pnl = row.net_strategy_pnl_after_costs or Decimal('0')
        net_pnl_by_day[day] += net_pnl
        filled_notional_by_day[day] += row.filled_notional or Decimal('0')
        closed_trade_count_by_day[day] += max(0, _safe_int(row.closed_trade_count))
        cumulative_by_day[day] += net_pnl
        if cumulative_by_day[day] > peak_by_day[day]:
            peak_by_day[day] = cumulative_by_day[day]
        drawdown = peak_by_day[day] - cumulative_by_day[day]
        if drawdown > max_intraday_drawdown:
            max_intraday_drawdown = drawdown
    day_count = len(trading_days)
    daily_net_values = [net_pnl_by_day[day] for day in trading_days]
    total_daily_net_pnl = sum(daily_net_values, Decimal('0'))
    total_filled_notional = sum(
        (filled_notional_by_day[day] for day in trading_days),
        Decimal('0'),
    )
    mean_daily_net_pnl = total_daily_net_pnl / Decimal(day_count) if day_count > 0 else Decimal('0')
    avg_daily_filled_notional = total_filled_notional / Decimal(day_count) if day_count > 0 else Decimal('0')
    return {
        'runtime_ledger_observed_trading_day_count': day_count,
        'runtime_ledger_net_pnl_by_trading_day': {day: str(net_pnl_by_day[day]) for day in trading_days},
        'runtime_ledger_mean_daily_net_pnl_after_costs': str(mean_daily_net_pnl),
        'runtime_ledger_median_daily_net_pnl_after_costs': str(_median_decimal(daily_net_values)),
        'runtime_ledger_p10_daily_net_pnl_after_costs': str(_p10_decimal(daily_net_values)),
        'runtime_ledger_worst_day_net_pnl_after_costs': str(
            min(daily_net_values) if daily_net_values else Decimal('0')
        ),
        'runtime_ledger_max_intraday_drawdown': str(max_intraday_drawdown),
        'runtime_ledger_avg_daily_filled_notional': str(avg_daily_filled_notional),
        'runtime_ledger_closed_trade_count_by_day': {day: closed_trade_count_by_day[day] for day in trading_days},
    }


def _runtime_ledger_persisted_daily_summary(
    rows: Sequence[StrategyRuntimeLedgerBucket],
) -> dict[str, Any]:
    selected: dict[str, Any] = {}
    selected_day_count = -1
    for row in rows:
        payload = _as_dict(row.payload_json)
        summary = _as_dict(payload.get('runtime_ledger_daily_summary'))
        if not summary:
            continue
        day_count = _safe_int(summary.get('runtime_ledger_observed_trading_day_count'))
        if day_count > selected_day_count:
            selected = summary
            selected_day_count = day_count
    return dict(selected)


def _runtime_ledger_bucket_refs_for_windows(
    session: Session,
    rows: Sequence[StrategyHypothesisMetricWindow],
) -> tuple[list[StrategyHypothesisMetricWindow], list[StrategyRuntimeLedgerBucket], list[str]]:
    hypothesis_ids = sorted(
        {hypothesis_id for row in rows if (hypothesis_id := _as_text(row.hypothesis_id)) is not None}
    )
    run_ids = sorted({run_id for row in rows if (run_id := _as_text(row.run_id)) is not None})
    if not hypothesis_ids or not run_ids:
        return [], [], [str(row.id) for row in rows]
    buckets = list(
        session.execute(
            select(StrategyRuntimeLedgerBucket)
            .where(StrategyRuntimeLedgerBucket.hypothesis_id.in_(hypothesis_ids))
            .where(StrategyRuntimeLedgerBucket.run_id.in_(run_ids))
            .order_by(
                StrategyRuntimeLedgerBucket.bucket_ended_at.desc(),
                StrategyRuntimeLedgerBucket.created_at.desc(),
            )
        ).scalars()
    )
    backed_windows: list[StrategyHypothesisMetricWindow] = []
    matched_buckets: list[StrategyRuntimeLedgerBucket] = []
    unbacked_window_refs: list[str] = []
    used_bucket_ids: set[str] = set()
    for window in rows:
        candidates = [
            bucket
            for bucket in buckets
            if str(bucket.id) not in used_bucket_ids
            and _runtime_ledger_bucket_matches_window(bucket, window)
            and _runtime_ledger_bucket_is_promotion_grade(bucket)
        ]
        matched_bucket = (
            min(candidates, key=lambda bucket: _runtime_ledger_bucket_window_match_key(bucket, window))
            if candidates
            else None
        )
        if matched_bucket is None:
            unbacked_window_refs.append(str(window.id))
            continue
        used_bucket_ids.add(str(matched_bucket.id))
        backed_windows.append(window)
        matched_buckets.append(matched_bucket)
    return backed_windows, matched_buckets, unbacked_window_refs


def _window_gate_summary(
    rows: Sequence[StrategyHypothesisMetricWindow],
) -> dict[str, Any]:
    total_sessions = sum(max(0, int(row.market_session_count or 0)) for row in rows)
    total_windows = len(rows)
    weighted_alignment = 0.0
    weighted_slippage = 0.0
    weighted_expectancy = 0.0
    total_weight = 0.0
    latest_rows = sorted(
        rows,
        key=lambda row: (
            row.window_ended_at or row.created_at,
            row.created_at,
        ),
        reverse=True,
    )
    latest_three = latest_rows[:3]
    for row in rows:
        weight = float(max(1, int(row.market_session_count or 0)))
        total_weight += weight
        weighted_alignment += _safe_float(row.decision_alignment_ratio) * weight
        weighted_slippage += _safe_float(row.avg_abs_slippage_bps) * weight
        weighted_expectancy += _safe_float(row.post_cost_expectancy_bps) * weight
    alignment_ratio = (weighted_alignment / total_weight) if total_weight > 0 else 0.0
    avg_slippage_bps = (weighted_slippage / total_weight) if total_weight > 0 else 0.0
    avg_expectancy_bps = (weighted_expectancy / total_weight) if total_weight > 0 else 0.0
    latest_three_within_budget = (
        all(_safe_float(row.avg_abs_slippage_bps) <= _safe_float(row.slippage_budget_bps) for row in latest_three)
        if latest_three
        else False
    )
    continuity_ok = all(bool(row.continuity_ok) for row in rows)
    drift_ok = all(bool(row.drift_ok) for row in rows)
    dependency_allow = all((_as_text(row.dependency_quorum_decision) or 'unknown') == 'allow' for row in rows)
    return {
        'market_session_count': total_sessions,
        'window_count': total_windows,
        'decision_alignment_ratio': alignment_ratio,
        'avg_abs_slippage_bps': avg_slippage_bps,
        'avg_post_cost_expectancy_bps': avg_expectancy_bps,
        'latest_three_within_budget': latest_three_within_budget,
        'continuity_ok': continuity_ok,
        'drift_ok': drift_ok,
        'dependency_allow': dependency_allow,
        'hypothesis_ids': sorted({row.hypothesis_id for row in rows}),
        'db_row_refs': [str(row.id) for row in rows],
    }


def _evaluate_empirical_jobs_gate(
    *,
    empirical_jobs_status: Mapping[str, Any],
    empirical_rows: Mapping[str, VNextEmpiricalJobRun],
) -> dict[str, Any]:
    jobs = _as_dict(empirical_jobs_status.get('jobs'))
    missing = [
        job_type
        for job_type in EMPIRICAL_JOB_TYPES
        if job_type not in jobs
        or not bool(_as_dict(jobs.get(job_type)).get('promotion_authority_eligible'))
        or _as_text(_as_dict(jobs.get(job_type)).get('authority')) != 'empirical'
        or not _as_text(_as_dict(jobs.get(job_type)).get('dataset_snapshot_ref'))
        or bool(_as_dict(jobs.get(job_type)).get('stale', False))
    ]
    status = TRACE_STATUS_SATISFIED if not missing else TRACE_STATUS_BLOCKED
    blocked_reason = None if not missing else f'empirical_jobs_missing_or_ineligible:{",".join(sorted(missing))}'
    dataset_snapshot_ref = None
    candidate_id = None
    artifact_refs: list[str] = []
    db_row_refs: dict[str, Any] = {}
    dataset_refs: set[str] = set()
    candidate_ids: set[str] = set()
    for job_type, row in empirical_rows.items():
        if dataset_snapshot_ref is None:
            dataset_snapshot_ref = row.dataset_snapshot_ref
        if candidate_id is None:
            candidate_id = row.candidate_id
        dataset_ref = _as_text(row.dataset_snapshot_ref)
        if dataset_ref is not None:
            dataset_refs.add(dataset_ref)
        empirical_candidate = _as_text(row.candidate_id)
        if empirical_candidate is not None:
            candidate_ids.add(empirical_candidate)
        artifact_refs.extend(str(item) for item in cast(list[object], row.artifact_refs or []) if str(item).strip())
        db_row_refs[job_type] = {
            'row_id': str(row.id),
            'job_run_id': row.job_run_id,
        }
    if status == TRACE_STATUS_SATISFIED and len(dataset_refs) != 1:
        status = TRACE_STATUS_BLOCKED
        blocked_reason = 'empirical_dataset_snapshot_ref_mismatch'
    if status == TRACE_STATUS_SATISFIED and len(candidate_ids) != 1:
        status = TRACE_STATUS_BLOCKED
        blocked_reason = 'empirical_candidate_id_mismatch'
    return {
        'status': status,
        'blocked_reason': blocked_reason,
        'dataset_snapshot_ref': dataset_snapshot_ref,
        'candidate_id': candidate_id,
        'artifact_refs': sorted(set(artifact_refs)),
        'db_row_refs': db_row_refs,
    }


def _evaluate_paper_gate(
    *,
    empirical_gate: Mapping[str, Any],
    full_day_row: VNextCompletionGateResult | None,
    empirical_rows: Mapping[str, VNextEmpiricalJobRun],
    gate_definition: Mapping[str, Any] | None,
) -> dict[str, Any]:
    if empirical_gate.get('status') != TRACE_STATUS_SATISFIED:
        return {
            'status': TRACE_STATUS_BLOCKED,
            'blocked_reason': 'empirical_jobs_not_satisfied',
            'artifact_refs': [],
            'db_row_refs': {},
            'dataset_snapshot_ref': empirical_gate.get('dataset_snapshot_ref'),
            'candidate_id': empirical_gate.get('candidate_id'),
        }
    if full_day_row is None:
        return {
            'status': TRACE_STATUS_BLOCKED,
            'blocked_reason': 'missing_full_day_simulation_trace',
            'artifact_refs': [],
            'db_row_refs': {},
            'dataset_snapshot_ref': empirical_gate.get('dataset_snapshot_ref'),
            'candidate_id': empirical_gate.get('candidate_id'),
        }
    empirical_candidate_id = _as_text(empirical_gate.get('candidate_id'))
    empirical_dataset_snapshot_ref = _as_text(empirical_gate.get('dataset_snapshot_ref'))
    if empirical_candidate_id is not None and full_day_row.candidate_id != empirical_candidate_id:
        return {
            'status': TRACE_STATUS_BLOCKED,
            'blocked_reason': 'full_day_candidate_id_mismatch',
            'artifact_refs': cast(list[str], empirical_gate.get('artifact_refs') or []),
            'db_row_refs': {'simulation_full_day_coverage': str(full_day_row.id)},
            'dataset_snapshot_ref': empirical_dataset_snapshot_ref,
            'candidate_id': empirical_candidate_id,
        }
    if (
        empirical_dataset_snapshot_ref is not None
        and full_day_row.dataset_snapshot_ref != empirical_dataset_snapshot_ref
    ):
        return {
            'status': TRACE_STATUS_BLOCKED,
            'blocked_reason': 'full_day_dataset_snapshot_ref_mismatch',
            'artifact_refs': cast(list[str], empirical_gate.get('artifact_refs') or []),
            'db_row_refs': {'simulation_full_day_coverage': str(full_day_row.id)},
            'dataset_snapshot_ref': empirical_dataset_snapshot_ref,
            'candidate_id': empirical_candidate_id,
        }
    full_day_details = _as_dict(full_day_row.details_json)
    gate_result = _as_dict(full_day_details.get('gate_result'))
    acceptance = _as_dict(gate_result.get('acceptance_snapshot'))
    trade_decisions = _safe_int(acceptance.get('trade_decisions'))
    min_simulated_decisions = _policy_int(
        _gate_policy_parameters(gate_definition),
        'min_simulated_decisions',
        default=500,
    )
    if trade_decisions < min_simulated_decisions:
        return {
            'status': TRACE_STATUS_BLOCKED,
            'blocked_reason': 'insufficient_simulated_decisions',
            'artifact_refs': cast(list[str], empirical_gate.get('artifact_refs') or []),
            'db_row_refs': {'simulation_full_day_coverage': str(full_day_row.id)},
            'dataset_snapshot_ref': empirical_gate.get('dataset_snapshot_ref'),
            'candidate_id': empirical_gate.get('candidate_id'),
        }
    benchmark_row = empirical_rows.get('benchmark_parity')
    if benchmark_row is None:
        return {
            'status': TRACE_STATUS_BLOCKED,
            'blocked_reason': 'missing_benchmark_parity_row',
            'artifact_refs': cast(list[str], empirical_gate.get('artifact_refs') or []),
            'db_row_refs': {'simulation_full_day_coverage': str(full_day_row.id)},
            'dataset_snapshot_ref': empirical_gate.get('dataset_snapshot_ref'),
            'candidate_id': empirical_gate.get('candidate_id'),
        }
    benchmark_payload = _as_dict(benchmark_row.payload_json)
    missing_families = _as_list(_as_dict(benchmark_payload.get('lineage')).get('missing_families'))
    if missing_families:
        return {
            'status': TRACE_STATUS_BLOCKED,
            'blocked_reason': f'benchmark_family_coverage_incomplete:{",".join(str(item) for item in missing_families)}',
            'artifact_refs': cast(list[str], empirical_gate.get('artifact_refs') or []),
            'db_row_refs': {
                'simulation_full_day_coverage': str(full_day_row.id),
                'benchmark_parity': str(benchmark_row.id),
            },
            'dataset_snapshot_ref': empirical_gate.get('dataset_snapshot_ref'),
            'candidate_id': empirical_gate.get('candidate_id'),
        }
    fill_price_status = _as_text(acceptance.get('fill_price_error_budget_status')) or 'missing'
    if fill_price_status != 'within_budget':
        blocked_reason = {
            'missing': 'fill_price_error_budget_not_recorded',
            'pending_runtime_observation': 'fill_price_error_budget_pending_runtime_observation',
            'out_of_budget': 'fill_price_error_budget_exceeded',
        }.get(fill_price_status, f'fill_price_error_budget_{fill_price_status}')
        return {
            'status': TRACE_STATUS_BLOCKED,
            'blocked_reason': blocked_reason,
            'artifact_refs': cast(list[str], empirical_gate.get('artifact_refs') or []),
            'db_row_refs': {
                'simulation_full_day_coverage': str(full_day_row.id),
                'benchmark_parity': str(benchmark_row.id),
            },
            'dataset_snapshot_ref': empirical_gate.get('dataset_snapshot_ref'),
            'candidate_id': empirical_gate.get('candidate_id'),
        }
    artifact_refs = cast(list[str], empirical_gate.get('artifact_refs') or [])
    fill_price_ref = _as_text(acceptance.get('fill_price_error_budget_artifact_ref'))
    if fill_price_ref and fill_price_ref not in artifact_refs:
        artifact_refs = [*artifact_refs, fill_price_ref]
    return {
        'status': TRACE_STATUS_SATISFIED,
        'blocked_reason': None,
        'artifact_refs': artifact_refs,
        'db_row_refs': {
            'simulation_full_day_coverage': str(full_day_row.id),
            'benchmark_parity': str(benchmark_row.id),
        },
        'dataset_snapshot_ref': empirical_gate.get('dataset_snapshot_ref'),
        'candidate_id': empirical_gate.get('candidate_id'),
    }


def _evaluate_live_canary_gate(
    *,
    paper_gate: Mapping[str, Any],
    paper_rows: Sequence[StrategyHypothesisMetricWindow],
    allowed_promotion_decision_keys: set[_PromotionDecisionKey],
    denied_promotion_decision_keys: set[_PromotionDecisionKey],
    gate_definition: Mapping[str, Any] | None,
) -> dict[str, Any]:
    if paper_gate.get('status') != TRACE_STATUS_SATISFIED:
        return {
            'status': TRACE_STATUS_BLOCKED,
            'blocked_reason': 'paper_gate_not_satisfied',
            'artifact_refs': cast(list[str], paper_gate.get('artifact_refs') or []),
            'db_row_refs': {},
            'dataset_snapshot_ref': paper_gate.get('dataset_snapshot_ref'),
            'candidate_id': paper_gate.get('candidate_id'),
        }
    candidate_id = _as_text(paper_gate.get('candidate_id'))
    candidate_rows = [
        row
        for row in paper_rows
        if candidate_id is None or row.candidate_id == candidate_id
        if (_as_text(row.evidence_provenance) == 'paper_runtime_observed')
        and (_as_text(row.evidence_maturity) == 'empirically_validated')
    ]
    promotion_decision_blocked_reason = _promotion_decision_blocked_reason(
        candidate_rows,
        allowed_keys=allowed_promotion_decision_keys,
        denied_keys=denied_promotion_decision_keys,
    )
    if promotion_decision_blocked_reason is not None:
        return {
            'status': TRACE_STATUS_BLOCKED,
            'blocked_reason': promotion_decision_blocked_reason,
            'artifact_refs': cast(list[str], paper_gate.get('artifact_refs') or []),
            'db_row_refs': {'hypothesis_metric_windows': [str(row.id) for row in candidate_rows]},
            'dataset_snapshot_ref': paper_gate.get('dataset_snapshot_ref'),
            'candidate_id': paper_gate.get('candidate_id'),
        }
    qualifying = _windows_with_allowed_promotion_decisions(
        candidate_rows,
        allowed_keys=allowed_promotion_decision_keys,
    )
    summary = _window_gate_summary(qualifying)
    min_market_session_samples = _manifest_runtime_session_threshold(
        candidate_id=candidate_id,
        rows=qualifying,
        policy_parameters=_gate_policy_parameters(gate_definition),
        fallback_key='fallback_min_market_session_samples',
        default=40,
        manifest_attr='min_sample_count_for_live_canary',
    )
    if summary['market_session_count'] < min_market_session_samples:
        blocked_reason = 'insufficient_paper_runtime_sessions'
    elif summary['decision_alignment_ratio'] < 0.95:
        blocked_reason = 'shadow_live_alignment_below_threshold'
    elif not summary['dependency_allow']:
        blocked_reason = 'dependency_quorum_not_allow'
    elif not summary['continuity_ok']:
        blocked_reason = 'continuity_gate_failed'
    elif summary['avg_abs_slippage_bps'] > max(
        (_safe_float(row.slippage_budget_bps) for row in qualifying),
        default=0.0,
    ):
        blocked_reason = 'slippage_budget_exceeded'
    else:
        blocked_reason = None
    return {
        'status': TRACE_STATUS_SATISFIED if blocked_reason is None else TRACE_STATUS_BLOCKED,
        'blocked_reason': blocked_reason,
        'artifact_refs': cast(list[str], paper_gate.get('artifact_refs') or []),
        'db_row_refs': {'hypothesis_metric_windows': summary['db_row_refs']},
        'dataset_snapshot_ref': paper_gate.get('dataset_snapshot_ref'),
        'candidate_id': paper_gate.get('candidate_id'),
    }


def _evaluate_live_scale_gate(
    *,
    session: Session,
    canary_gate: Mapping[str, Any],
    live_rows: Sequence[StrategyHypothesisMetricWindow],
    allowed_promotion_decision_keys: set[_PromotionDecisionKey],
    denied_promotion_decision_keys: set[_PromotionDecisionKey],
    gate_definition: Mapping[str, Any] | None,
) -> dict[str, Any]:
    if canary_gate.get('status') != TRACE_STATUS_SATISFIED:
        return {
            'status': TRACE_STATUS_BLOCKED,
            'blocked_reason': 'live_canary_not_satisfied',
            'artifact_refs': cast(list[str], canary_gate.get('artifact_refs') or []),
            'db_row_refs': {},
            'dataset_snapshot_ref': canary_gate.get('dataset_snapshot_ref'),
            'candidate_id': canary_gate.get('candidate_id'),
        }
    candidate_id = _as_text(canary_gate.get('candidate_id'))
    candidate_rows = [
        row
        for row in live_rows
        if candidate_id is None or row.candidate_id == candidate_id
        if (_as_text(row.evidence_provenance) == 'live_runtime_observed')
        and (_as_text(row.evidence_maturity) == 'empirically_validated')
    ]
    promotion_decision_blocked_reason = _promotion_decision_blocked_reason(
        candidate_rows,
        allowed_keys=allowed_promotion_decision_keys,
        denied_keys=denied_promotion_decision_keys,
    )
    if promotion_decision_blocked_reason is not None:
        return {
            'status': TRACE_STATUS_BLOCKED,
            'blocked_reason': promotion_decision_blocked_reason,
            'artifact_refs': cast(list[str], canary_gate.get('artifact_refs') or []),
            'db_row_refs': {'hypothesis_metric_windows': [str(row.id) for row in candidate_rows]},
            'dataset_snapshot_ref': canary_gate.get('dataset_snapshot_ref'),
            'candidate_id': canary_gate.get('candidate_id'),
        }
    qualifying = _windows_with_allowed_promotion_decisions(
        candidate_rows,
        allowed_keys=allowed_promotion_decision_keys,
    )
    ledger_qualifying, runtime_ledger_buckets, unbacked_window_refs = _runtime_ledger_bucket_refs_for_windows(
        session,
        qualifying,
    )
    summary = _window_gate_summary(ledger_qualifying)
    ledger_summary = _runtime_ledger_bucket_summary(runtime_ledger_buckets)
    summary['avg_post_cost_expectancy_bps'] = ledger_summary['runtime_ledger_post_cost_expectancy_bps']
    min_market_session_samples = _manifest_runtime_session_threshold(
        candidate_id=candidate_id,
        rows=ledger_qualifying,
        policy_parameters=_gate_policy_parameters(gate_definition),
        fallback_key='fallback_min_market_session_samples',
        default=120,
        manifest_attr='min_sample_count_for_scale_up',
    )
    if not ledger_qualifying:
        blocked_reason = 'runtime_ledger_profit_proof_missing'
    elif summary['market_session_count'] < min_market_session_samples:
        blocked_reason = 'insufficient_live_runtime_sessions'
    elif summary['window_count'] < 10:
        blocked_reason = 'insufficient_live_runtime_windows'
    elif summary['avg_post_cost_expectancy_bps'] <= 0:
        blocked_reason = 'post_cost_expectancy_non_positive'
    elif not summary['latest_three_within_budget']:
        blocked_reason = 'slippage_budget_not_stable'
    elif not summary['continuity_ok']:
        blocked_reason = 'continuity_gate_failed'
    elif not summary['drift_ok']:
        blocked_reason = 'drift_gate_failed'
    elif not summary['dependency_allow']:
        blocked_reason = 'dependency_quorum_not_allow'
    else:
        blocked_reason = None
    return {
        'status': TRACE_STATUS_SATISFIED if blocked_reason is None else TRACE_STATUS_BLOCKED,
        'blocked_reason': blocked_reason,
        'artifact_refs': cast(list[str], canary_gate.get('artifact_refs') or []),
        'db_row_refs': {
            'hypothesis_metric_windows': summary['db_row_refs'],
            'strategy_runtime_ledger_buckets': ledger_summary['db_row_refs'],
            'runtime_ledger_unbacked_hypothesis_metric_windows': unbacked_window_refs,
        },
        'runtime_ledger_summary': ledger_summary,
        'dataset_snapshot_ref': canary_gate.get('dataset_snapshot_ref'),
        'candidate_id': canary_gate.get('candidate_id'),
    }


def _effective_row_status(
    *,
    gate_definition: Mapping[str, Any],
    row: VNextCompletionGateResult | None,
    current_git_revision: str | None,
) -> tuple[str, str | None]:
    if row is None:
        return TRACE_STATUS_BLOCKED, 'no_proving_result_recorded'
    status = row.status if row.status in TRACE_STATUSES else TRACE_STATUS_BLOCKED
    blocked_reason = row.blocked_reason
    freshness = _as_dict(gate_definition.get('evidence_freshness_rule'))
    if status == TRACE_STATUS_SATISFIED:
        max_age_seconds = _safe_int(freshness.get('max_age_seconds'), default=0)
        if max_age_seconds > 0:
            measured_at = row.measured_at
            if measured_at.tzinfo is None:
                measured_at = measured_at.replace(tzinfo=timezone.utc)
            if measured_at < datetime.now(timezone.utc) - timedelta(seconds=max_age_seconds):
                return TRACE_STATUS_STALE, 'evidence_exceeded_freshness_window'
        if bool(freshness.get('stale_on_git_change')) and current_git_revision:
            row_revision = _as_text(row.git_revision)
            if row_revision and row_revision != current_git_revision:
                return TRACE_STATUS_STALE, 'git_revision_changed_since_proof'
    return status, blocked_reason


def build_doc29_completion_status(
    *,
    session: Session,
    stale_after_seconds: int,
    current_git_revision: str | None,
    current_image_digest: str | None,
) -> dict[str, Any]:
    matrix = load_doc29_completion_matrix()
    gate_definition_by_id = {str(gate['gate_id']): gate for gate in cast(list[dict[str, Any]], matrix['gates'])}
    latest_rows = _latest_completion_rows(session)
    empirical_jobs_status = build_empirical_jobs_status(
        session=session,
        stale_after_seconds=stale_after_seconds,
    )
    empirical_rows = _latest_empirical_rows(session)
    derived_empirical = _evaluate_empirical_jobs_gate(
        empirical_jobs_status=empirical_jobs_status,
        empirical_rows=empirical_rows,
    )
    empirical_candidate_id = _as_text(derived_empirical.get('candidate_id'))
    empirical_dataset_snapshot_ref = _as_text(derived_empirical.get('dataset_snapshot_ref'))
    lineage_rows = (
        _latest_completion_rows_filtered(
            session,
            candidate_id=empirical_candidate_id,
            dataset_snapshot_ref=empirical_dataset_snapshot_ref,
        )
        if empirical_candidate_id is not None and empirical_dataset_snapshot_ref is not None
        else latest_rows
    )
    paper_windows = _latest_hypothesis_windows(
        session,
        observed_stage='paper',
        max_age_seconds=_safe_int(
            _as_dict(_as_dict(gate_definition_by_id.get(DOC29_LIVE_CANARY_GATE)).get('evidence_freshness_rule')).get(
                'max_age_seconds'
            ),
            default=0,
        ),
    )
    live_windows = _latest_hypothesis_windows(
        session,
        observed_stage='live',
        max_age_seconds=_safe_int(
            _as_dict(_as_dict(gate_definition_by_id.get(DOC29_LIVE_SCALE_GATE)).get('evidence_freshness_rule')).get(
                'max_age_seconds'
            ),
            default=0,
        ),
    )
    paper_allowed_promotion_decisions, paper_denied_promotion_decisions = _promotion_decision_keys_for_windows(
        session,
        paper_windows,
    )
    live_allowed_promotion_decisions, live_denied_promotion_decisions = _promotion_decision_keys_for_windows(
        session,
        live_windows,
    )
    gate_status_map: dict[str, dict[str, Any]] = {}

    for gate_definition in cast(list[dict[str, Any]], matrix['gates']):
        gate_id = str(gate_definition['gate_id'])
        if gate_id == DOC29_EMPIRICAL_JOBS_GATE:
            derived = derived_empirical
            gate_status_map[gate_id] = {
                **gate_definition,
                'status': str(derived['status']),
                'blocked_reason': derived.get('blocked_reason'),
                'latest_run': None,
                'dataset_snapshot_ref': derived.get('dataset_snapshot_ref'),
                'candidate_id': derived.get('candidate_id'),
                'artifact_refs': cast(list[str], derived.get('artifact_refs') or []),
                'db_row_refs': cast(dict[str, Any], derived.get('db_row_refs') or {}),
                'persisted_result_id': None,
                'measured_at': None,
                'freshness_state': 'fresh' if derived['status'] == TRACE_STATUS_SATISFIED else 'blocked',
                'source': 'derived_from_empirical_jobs',
            }
            continue

        if gate_id == DOC29_PAPER_GATE:
            paper = _evaluate_paper_gate(
                empirical_gate=gate_status_map.get(DOC29_EMPIRICAL_JOBS_GATE) or derived_empirical,
                full_day_row=lineage_rows.get(DOC29_SIMULATION_FULL_DAY_GATE),
                empirical_rows=empirical_rows,
                gate_definition=gate_definition,
            )
            freshness_state = 'fresh' if paper['status'] == TRACE_STATUS_SATISFIED else 'blocked'
            gate_status_map[gate_id] = {
                **gate_definition,
                'status': str(paper['status']),
                'blocked_reason': paper.get('blocked_reason'),
                'latest_run': _as_text(getattr(lineage_rows.get(DOC29_SIMULATION_FULL_DAY_GATE), 'run_id', None)),
                'dataset_snapshot_ref': paper.get('dataset_snapshot_ref'),
                'candidate_id': paper.get('candidate_id'),
                'artifact_refs': cast(list[str], paper.get('artifact_refs') or []),
                'db_row_refs': cast(dict[str, Any], paper.get('db_row_refs') or {}),
                'persisted_result_id': None,
                'measured_at': None,
                'freshness_state': freshness_state,
                'source': 'derived_from_full_day_and_empirical_jobs',
            }
            continue

        if gate_id == DOC29_LIVE_CANARY_GATE:
            derived_paper = gate_status_map.get(DOC29_PAPER_GATE) or _evaluate_paper_gate(
                empirical_gate=gate_status_map.get(DOC29_EMPIRICAL_JOBS_GATE)
                or _evaluate_empirical_jobs_gate(
                    empirical_jobs_status=empirical_jobs_status,
                    empirical_rows=empirical_rows,
                ),
                full_day_row=lineage_rows.get(DOC29_SIMULATION_FULL_DAY_GATE),
                empirical_rows=empirical_rows,
                gate_definition=gate_definition_by_id.get(DOC29_PAPER_GATE),
            )
            canary = _evaluate_live_canary_gate(
                paper_gate=derived_paper,
                paper_rows=paper_windows,
                allowed_promotion_decision_keys=paper_allowed_promotion_decisions,
                denied_promotion_decision_keys=paper_denied_promotion_decisions,
                gate_definition=gate_definition,
            )
            gate_status_map[gate_id] = {
                **gate_definition,
                'status': str(canary['status']),
                'blocked_reason': canary.get('blocked_reason'),
                'latest_run': None,
                'dataset_snapshot_ref': canary.get('dataset_snapshot_ref'),
                'candidate_id': canary.get('candidate_id'),
                'artifact_refs': cast(list[str], canary.get('artifact_refs') or []),
                'db_row_refs': cast(dict[str, Any], canary.get('db_row_refs') or {}),
                'persisted_result_id': None,
                'measured_at': None,
                'freshness_state': 'fresh' if canary['status'] == TRACE_STATUS_SATISFIED else 'blocked',
                'source': 'derived_from_hypothesis_metric_windows',
            }
            continue

        if gate_id == DOC29_LIVE_SCALE_GATE:
            derived_canary = gate_status_map.get(DOC29_LIVE_CANARY_GATE) or _evaluate_live_canary_gate(
                paper_gate=gate_status_map.get(DOC29_PAPER_GATE)
                or _evaluate_paper_gate(
                    empirical_gate=gate_status_map.get(DOC29_EMPIRICAL_JOBS_GATE)
                    or _evaluate_empirical_jobs_gate(
                        empirical_jobs_status=empirical_jobs_status,
                        empirical_rows=empirical_rows,
                    ),
                    full_day_row=lineage_rows.get(DOC29_SIMULATION_FULL_DAY_GATE),
                    empirical_rows=empirical_rows,
                    gate_definition=gate_definition_by_id.get(DOC29_PAPER_GATE),
                ),
                paper_rows=paper_windows,
                allowed_promotion_decision_keys=paper_allowed_promotion_decisions,
                denied_promotion_decision_keys=paper_denied_promotion_decisions,
                gate_definition=gate_definition_by_id.get(DOC29_LIVE_CANARY_GATE),
            )
            scale = _evaluate_live_scale_gate(
                session=session,
                canary_gate=derived_canary,
                live_rows=live_windows,
                allowed_promotion_decision_keys=live_allowed_promotion_decisions,
                denied_promotion_decision_keys=live_denied_promotion_decisions,
                gate_definition=gate_definition,
            )
            gate_status_map[gate_id] = {
                **gate_definition,
                'status': str(scale['status']),
                'blocked_reason': scale.get('blocked_reason'),
                'latest_run': None,
                'dataset_snapshot_ref': scale.get('dataset_snapshot_ref'),
                'candidate_id': scale.get('candidate_id'),
                'artifact_refs': cast(list[str], scale.get('artifact_refs') or []),
                'db_row_refs': cast(dict[str, Any], scale.get('db_row_refs') or {}),
                'runtime_ledger_summary': cast(dict[str, Any], scale.get('runtime_ledger_summary') or {}),
                'persisted_result_id': None,
                'measured_at': None,
                'freshness_state': 'fresh' if scale['status'] == TRACE_STATUS_SATISFIED else 'blocked',
                'source': 'derived_from_hypothesis_metric_windows',
            }
            continue

        row = latest_rows.get(gate_id)
        status, blocked_reason = _effective_row_status(
            gate_definition=gate_definition,
            row=row,
            current_git_revision=current_git_revision,
        )
        details = _as_dict(row.details_json) if row is not None else {}
        artifact_refs = [str(item) for item in _as_list(details.get('artifact_refs')) if str(item).strip()]
        if row is not None and row.artifact_ref and row.artifact_ref not in artifact_refs:
            artifact_refs.insert(0, row.artifact_ref)
        freshness_state = (
            'missing'
            if row is None
            else 'fresh'
            if status == TRACE_STATUS_SATISFIED
            else 'stale'
            if status == TRACE_STATUS_STALE
            else 'regressed'
            if status == TRACE_STATUS_REGRESSED
            else 'blocked'
        )
        gate_status_map[gate_id] = {
            **gate_definition,
            'status': status,
            'blocked_reason': blocked_reason,
            'latest_run': row.run_id if row is not None else None,
            'dataset_snapshot_ref': row.dataset_snapshot_ref if row is not None else None,
            'artifact_refs': artifact_refs,
            'db_row_refs': _as_dict(details.get('db_row_refs')),
            'persisted_result_id': str(row.id) if row is not None else None,
            'measured_at': row.measured_at.isoformat() if row is not None else None,
            'freshness_state': freshness_state,
            'source': 'persisted_completion_trace' if row is not None else 'matrix_only',
        }

    gates = [gate_status_map[str(gate['gate_id'])] for gate in cast(list[dict[str, Any]], matrix['gates'])]
    status_counts: dict[str, int] = {item: 0 for item in TRACE_STATUSES}
    for gate in gates:
        gate_status = str(gate['status'])
        status_counts[gate_status] = status_counts.get(gate_status, 0) + 1
    return {
        'doc_id': matrix['doc_id'],
        'design_doc_path': matrix['design_doc_path'],
        'matrix_version': matrix['matrix_version'],
        'git_revision': current_git_revision,
        'image_digest': current_image_digest,
        'empirical_jobs': empirical_jobs_status,
        'summary': {
            'total': len(gates),
            'status_counts': status_counts,
            'all_satisfied': all(str(gate['status']) == TRACE_STATUS_SATISFIED for gate in gates),
        },
        'gates': gates,
    }


__all__ = [
    'DOC29_COMPLETION_ENDPOINT',
    'DOC29_COMPLETION_MATRIX_DOC_PATH',
    'DOC29_COMPLETION_MATRIX_RUNTIME_PATH',
    'DOC29_EMPIRICAL_JOBS_GATE',
    'DOC29_EMPIRICAL_MANIFEST_GATE',
    'DOC29_LIVE_CANARY_GATE',
    'DOC29_LIVE_SCALE_GATE',
    'DOC29_PAPER_GATE',
    'DOC29_SIMULATION_FULL_DAY_GATE',
    'DOC29_SIMULATION_SMOKE_GATE',
    'TRACE_STATUS_BLOCKED',
    'TRACE_STATUS_REGRESSED',
    'TRACE_STATUS_SATISFIED',
    'TRACE_STATUS_STALE',
    'build_completion_trace',
    'build_doc29_completion_status',
    'load_doc29_completion_matrix',
    'persist_completion_trace',
    'runtime_and_doc_completion_matrices_match',
    'upsert_completion_gate_result',
    'validate_doc29_completion_matrix',
]
