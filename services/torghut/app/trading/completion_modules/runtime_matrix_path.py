# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
# fmt: off
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

from ...models import (
    StrategyHypothesisMetricWindow,
    StrategyPromotionDecision,
    StrategyRuntimeLedgerBucket,
    VNextCompletionGateResult,
    VNextEmpiricalJobRun,
)
from ..empirical_jobs import EMPIRICAL_JOB_TYPES, build_empirical_jobs_status
from ..hypotheses import HypothesisManifest, load_hypothesis_registry
from ..runtime_cost_authority import (
    cost_basis_counts_have_non_promotion_grade_costs,
    is_non_promotion_grade_runtime_cost_basis,
)
from ..runtime_ledger import POST_COST_PNL_BASIS
from ..runtime_ledger_source_authority import (
    build_runtime_ledger_profit_distance_readback,
    runtime_ledger_promotion_source_authority_blockers,
)

# ruff: noqa: F401,F403,F405,F811,F821


def _runtime_matrix_path() -> Path:
    for parent in Path(__file__).resolve().parents:
        if (parent / 'pyproject.toml').is_file() and (parent / 'app').is_dir():
            return parent / 'config' / 'completion' / 'doc29-completion-matrix.yaml'
    return Path(__file__).resolve().parents[3] / 'config' / 'completion' / 'doc29-completion-matrix.yaml'

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

def _runtime_ledger_bucket_promotion_payload(
    bucket: StrategyRuntimeLedgerBucket,
) -> dict[str, Any]:
    payload = _as_dict(bucket.payload_json)
    canonical_fields = {
        'run_id': bucket.run_id,
        'candidate_id': bucket.candidate_id,
        'hypothesis_id': bucket.hypothesis_id,
        'observed_stage': bucket.observed_stage,
        'account_label': bucket.account_label,
        'runtime_strategy_name': bucket.runtime_strategy_name,
        'strategy_family': bucket.strategy_family,
        'fill_count': bucket.fill_count,
        'decision_count': bucket.decision_count,
        'submitted_order_count': bucket.submitted_order_count,
        'cancelled_order_count': bucket.cancelled_order_count,
        'rejected_order_count': bucket.rejected_order_count,
        'unfilled_order_count': bucket.unfilled_order_count,
        'closed_trade_count': bucket.closed_trade_count,
        'open_position_count': bucket.open_position_count,
        'filled_notional': bucket.filled_notional,
        'gross_strategy_pnl': bucket.gross_strategy_pnl,
        'cost_amount': bucket.cost_amount,
        'net_strategy_pnl_after_costs': bucket.net_strategy_pnl_after_costs,
        'post_cost_expectancy_bps': bucket.post_cost_expectancy_bps,
        'ledger_schema_version': bucket.ledger_schema_version,
        'pnl_basis': bucket.pnl_basis,
        'execution_policy_hash_counts': bucket.execution_policy_hash_counts,
        'cost_model_hash_counts': bucket.cost_model_hash_counts,
        'lineage_hash_counts': bucket.lineage_hash_counts,
    }
    return {**payload, **canonical_fields}


__all__ = [name for name in globals() if not name.startswith("__")]
