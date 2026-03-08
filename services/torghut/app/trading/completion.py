"""Traceability helpers for doc 29 completion gates."""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Mapping, Sequence, cast

import yaml
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import (
    StrategyHypothesisMetricWindow,
    VNextCompletionGateResult,
    VNextEmpiricalJobRun,
)
from .empirical_jobs import EMPIRICAL_JOB_TYPES, build_empirical_jobs_status


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
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        stripped = value.strip()
        if stripped:
            try:
                return float(stripped)
            except ValueError:
                return default
    return default


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
    rows = session.execute(
        select(VNextCompletionGateResult).order_by(VNextCompletionGateResult.measured_at.desc())
    ).scalars()
    latest: dict[str, VNextCompletionGateResult] = {}
    for row in rows:
        if row.gate_id in latest:
            continue
        latest[row.gate_id] = row
    return latest


def _latest_empirical_rows(session: Session) -> dict[str, VNextEmpiricalJobRun]:
    rows = session.execute(
        select(VNextEmpiricalJobRun).order_by(VNextEmpiricalJobRun.created_at.desc())
    ).scalars()
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
        select(StrategyHypothesisMetricWindow).where(
            StrategyHypothesisMetricWindow.observed_stage == observed_stage
        ).order_by(
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
    latest_three_within_budget = all(
        _safe_float(row.avg_abs_slippage_bps) <= _safe_float(row.slippage_budget_bps)
        for row in latest_three
    ) if latest_three else False
    continuity_ok = all(bool(row.continuity_ok) for row in rows)
    drift_ok = all(bool(row.drift_ok) for row in rows)
    dependency_allow = all(
        (_as_text(row.dependency_quorum_decision) or 'unknown') == 'allow'
        for row in rows
    )
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
    artifact_refs: list[str] = []
    db_row_refs: dict[str, Any] = {}
    for job_type, row in empirical_rows.items():
        if dataset_snapshot_ref is None:
            dataset_snapshot_ref = row.dataset_snapshot_ref
        artifact_refs.extend(str(item) for item in cast(list[object], row.artifact_refs or []) if str(item).strip())
        db_row_refs[job_type] = {
            'row_id': str(row.id),
            'job_run_id': row.job_run_id,
        }
    return {
        'status': status,
        'blocked_reason': blocked_reason,
        'dataset_snapshot_ref': dataset_snapshot_ref,
        'artifact_refs': sorted(set(artifact_refs)),
        'db_row_refs': db_row_refs,
    }


def _evaluate_paper_gate(
    *,
    empirical_gate: Mapping[str, Any],
    full_day_row: VNextCompletionGateResult | None,
    empirical_rows: Mapping[str, VNextEmpiricalJobRun],
) -> dict[str, Any]:
    if empirical_gate.get('status') != TRACE_STATUS_SATISFIED:
        return {
            'status': TRACE_STATUS_BLOCKED,
            'blocked_reason': 'empirical_jobs_not_satisfied',
            'artifact_refs': [],
            'db_row_refs': {},
            'dataset_snapshot_ref': empirical_gate.get('dataset_snapshot_ref'),
        }
    if full_day_row is None:
        return {
            'status': TRACE_STATUS_BLOCKED,
            'blocked_reason': 'missing_full_day_simulation_trace',
            'artifact_refs': [],
            'db_row_refs': {},
            'dataset_snapshot_ref': empirical_gate.get('dataset_snapshot_ref'),
        }
    full_day_details = _as_dict(full_day_row.details_json)
    gate_result = _as_dict(full_day_details.get('gate_result'))
    acceptance = _as_dict(gate_result.get('acceptance_snapshot'))
    trade_decisions = _safe_int(acceptance.get('trade_decisions'))
    if trade_decisions < 500:
        return {
            'status': TRACE_STATUS_BLOCKED,
            'blocked_reason': 'insufficient_simulated_decisions',
            'artifact_refs': cast(list[str], empirical_gate.get('artifact_refs') or []),
            'db_row_refs': {'simulation_full_day_coverage': str(full_day_row.id)},
            'dataset_snapshot_ref': empirical_gate.get('dataset_snapshot_ref'),
        }
    benchmark_row = empirical_rows.get('benchmark_parity')
    if benchmark_row is None:
        return {
            'status': TRACE_STATUS_BLOCKED,
            'blocked_reason': 'missing_benchmark_parity_row',
            'artifact_refs': cast(list[str], empirical_gate.get('artifact_refs') or []),
            'db_row_refs': {'simulation_full_day_coverage': str(full_day_row.id)},
            'dataset_snapshot_ref': empirical_gate.get('dataset_snapshot_ref'),
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
    }


def _evaluate_live_canary_gate(
    *,
    paper_gate: Mapping[str, Any],
    paper_rows: Sequence[StrategyHypothesisMetricWindow],
) -> dict[str, Any]:
    if paper_gate.get('status') != TRACE_STATUS_SATISFIED:
        return {
            'status': TRACE_STATUS_BLOCKED,
            'blocked_reason': 'paper_gate_not_satisfied',
            'artifact_refs': cast(list[str], paper_gate.get('artifact_refs') or []),
            'db_row_refs': {},
            'dataset_snapshot_ref': paper_gate.get('dataset_snapshot_ref'),
        }
    qualifying = [
        row
        for row in paper_rows
        if (_as_text(row.evidence_provenance) == 'paper_runtime_observed')
        and (_as_text(row.evidence_maturity) == 'empirically_validated')
    ]
    summary = _window_gate_summary(qualifying)
    if summary['market_session_count'] < 40:
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
    }


def _evaluate_live_scale_gate(
    *,
    canary_gate: Mapping[str, Any],
    live_rows: Sequence[StrategyHypothesisMetricWindow],
) -> dict[str, Any]:
    if canary_gate.get('status') != TRACE_STATUS_SATISFIED:
        return {
            'status': TRACE_STATUS_BLOCKED,
            'blocked_reason': 'live_canary_not_satisfied',
            'artifact_refs': cast(list[str], canary_gate.get('artifact_refs') or []),
            'db_row_refs': {},
            'dataset_snapshot_ref': canary_gate.get('dataset_snapshot_ref'),
        }
    qualifying = [
        row
        for row in live_rows
        if (_as_text(row.evidence_provenance) == 'live_runtime_observed')
        and (_as_text(row.evidence_maturity) == 'empirically_validated')
    ]
    summary = _window_gate_summary(qualifying)
    if summary['market_session_count'] < 120:
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
        'db_row_refs': {'hypothesis_metric_windows': summary['db_row_refs']},
        'dataset_snapshot_ref': canary_gate.get('dataset_snapshot_ref'),
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
    gate_definition_by_id = {
        str(gate['gate_id']): gate for gate in cast(list[dict[str, Any]], matrix['gates'])
    }
    latest_rows = _latest_completion_rows(session)
    empirical_jobs_status = build_empirical_jobs_status(
        session=session,
        stale_after_seconds=stale_after_seconds,
    )
    empirical_rows = _latest_empirical_rows(session)
    paper_windows = _latest_hypothesis_windows(
        session,
        observed_stage='paper',
        max_age_seconds=_safe_int(
            _as_dict(
                _as_dict(gate_definition_by_id.get(DOC29_LIVE_CANARY_GATE)).get('evidence_freshness_rule')
            ).get('max_age_seconds'),
            default=0,
        ),
    )
    live_windows = _latest_hypothesis_windows(
        session,
        observed_stage='live',
        max_age_seconds=_safe_int(
            _as_dict(
                _as_dict(gate_definition_by_id.get(DOC29_LIVE_SCALE_GATE)).get('evidence_freshness_rule')
            ).get('max_age_seconds'),
            default=0,
        ),
    )
    gate_status_map: dict[str, dict[str, Any]] = {}

    for gate_definition in cast(list[dict[str, Any]], matrix['gates']):
        gate_id = str(gate_definition['gate_id'])
        if gate_id == DOC29_EMPIRICAL_JOBS_GATE:
            derived = _evaluate_empirical_jobs_gate(
                empirical_jobs_status=empirical_jobs_status,
                empirical_rows=empirical_rows,
            )
            gate_status_map[gate_id] = {
                **gate_definition,
                'status': str(derived['status']),
                'blocked_reason': derived.get('blocked_reason'),
                'latest_run': None,
                'dataset_snapshot_ref': derived.get('dataset_snapshot_ref'),
                'artifact_refs': cast(list[str], derived.get('artifact_refs') or []),
                'db_row_refs': cast(dict[str, Any], derived.get('db_row_refs') or {}),
                'persisted_result_id': None,
                'measured_at': None,
                'freshness_state': 'fresh' if derived['status'] == TRACE_STATUS_SATISFIED else 'blocked',
                'source': 'derived_from_empirical_jobs',
            }
            continue

        if gate_id == DOC29_PAPER_GATE:
            derived_empirical = gate_status_map.get(DOC29_EMPIRICAL_JOBS_GATE) or _evaluate_empirical_jobs_gate(
                empirical_jobs_status=empirical_jobs_status,
                empirical_rows=empirical_rows,
            )
            paper = _evaluate_paper_gate(
                empirical_gate=derived_empirical,
                full_day_row=latest_rows.get(DOC29_SIMULATION_FULL_DAY_GATE),
                empirical_rows=empirical_rows,
            )
            freshness_state = 'fresh' if paper['status'] == TRACE_STATUS_SATISFIED else 'blocked'
            gate_status_map[gate_id] = {
                **gate_definition,
                'status': str(paper['status']),
                'blocked_reason': paper.get('blocked_reason'),
                'latest_run': _as_text(getattr(latest_rows.get(DOC29_SIMULATION_FULL_DAY_GATE), 'run_id', None)),
                'dataset_snapshot_ref': paper.get('dataset_snapshot_ref'),
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
                full_day_row=latest_rows.get(DOC29_SIMULATION_FULL_DAY_GATE),
                empirical_rows=empirical_rows,
            )
            canary = _evaluate_live_canary_gate(
                paper_gate=derived_paper,
                paper_rows=paper_windows,
            )
            gate_status_map[gate_id] = {
                **gate_definition,
                'status': str(canary['status']),
                'blocked_reason': canary.get('blocked_reason'),
                'latest_run': None,
                'dataset_snapshot_ref': canary.get('dataset_snapshot_ref'),
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
                    full_day_row=latest_rows.get(DOC29_SIMULATION_FULL_DAY_GATE),
                    empirical_rows=empirical_rows,
                ),
                paper_rows=paper_windows,
            )
            scale = _evaluate_live_scale_gate(
                canary_gate=derived_canary,
                live_rows=live_windows,
            )
            gate_status_map[gate_id] = {
                **gate_definition,
                'status': str(scale['status']),
                'blocked_reason': scale.get('blocked_reason'),
                'latest_run': None,
                'dataset_snapshot_ref': scale.get('dataset_snapshot_ref'),
                'artifact_refs': cast(list[str], scale.get('artifact_refs') or []),
                'db_row_refs': cast(dict[str, Any], scale.get('db_row_refs') or {}),
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
