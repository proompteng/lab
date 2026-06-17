# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
# fmt: off
"""Traceability helpers for doc 29 completion gates."""

from __future__ import annotations

import os
import sys
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

from .runtime_matrix_path import (
    DOC29_COMPLETION_ENDPOINT,
    DOC29_COMPLETION_MATRIX_DOC_PATH,
    DOC29_COMPLETION_MATRIX_RUNTIME_PATH,
    DOC29_EMPIRICAL_JOBS_GATE,
    DOC29_EMPIRICAL_MANIFEST_GATE,
    DOC29_LIVE_CANARY_GATE,
    DOC29_LIVE_SCALE_GATE,
    DOC29_PAPER_GATE,
    DOC29_SIMULATION_FULL_DAY_GATE,
    DOC29_SIMULATION_SMOKE_GATE,
    TRACE_STATUSES,
    TRACE_STATUS_BLOCKED,
    TRACE_STATUS_REGRESSED,
    TRACE_STATUS_SATISFIED,
    TRACE_STATUS_STALE,
    US_EQUITIES_REGULAR_TIMEZONE,
    build_completion_trace,
    load_doc29_completion_matrix,
    persist_completion_trace,
    runtime_and_doc_completion_matrices_match,
    upsert_completion_gate_result,
    validate_doc29_completion_matrix,
)
from . import runtime_matrix_path as _runtime_matrix_path_private_41
from .runtime_ledger_bucket_existing_blockers import (
    dataclass,
)
from . import runtime_ledger_bucket_existing_blockers as _runtime_ledger_bucket_existing_blockers_private_97

_PromotionDecisionKey = getattr(_runtime_matrix_path_private_41, '_PromotionDecisionKey')
_RUNTIME_LEDGER_BUCKET_SCHEMAS = getattr(_runtime_matrix_path_private_41, '_RUNTIME_LEDGER_BUCKET_SCHEMAS')
_as_dict = getattr(_runtime_matrix_path_private_41, '_as_dict')
_as_list = getattr(_runtime_matrix_path_private_41, '_as_list')
_as_text = getattr(_runtime_matrix_path_private_41, '_as_text')
_candidate_hypothesis_manifests = getattr(_runtime_matrix_path_private_41, '_candidate_hypothesis_manifests')
_doc_matrix_path = getattr(_runtime_matrix_path_private_41, '_doc_matrix_path')
_gate_policy_parameters = getattr(_runtime_matrix_path_private_41, '_gate_policy_parameters')
_latest_completion_rows = getattr(_runtime_matrix_path_private_41, '_latest_completion_rows')
_latest_completion_rows_filtered = getattr(_runtime_matrix_path_private_41, '_latest_completion_rows_filtered')
_latest_empirical_rows = getattr(_runtime_matrix_path_private_41, '_latest_empirical_rows')
_latest_hypothesis_windows = getattr(_runtime_matrix_path_private_41, '_latest_hypothesis_windows')
_load_hypothesis_manifests_by_id = getattr(_runtime_matrix_path_private_41, '_load_hypothesis_manifests_by_id')
_load_yaml_mapping = getattr(_runtime_matrix_path_private_41, '_load_yaml_mapping')
_manifest_runtime_session_threshold = getattr(_runtime_matrix_path_private_41, '_manifest_runtime_session_threshold')
_median_decimal = getattr(_runtime_matrix_path_private_41, '_median_decimal')
_normalize_gate_definition = getattr(_runtime_matrix_path_private_41, '_normalize_gate_definition')
_p10_decimal = getattr(_runtime_matrix_path_private_41, '_p10_decimal')
_policy_int = getattr(_runtime_matrix_path_private_41, '_policy_int')
_positive_hash_count = getattr(_runtime_matrix_path_private_41, '_positive_hash_count')
_promotion_decision_blocked_reason = getattr(_runtime_matrix_path_private_41, '_promotion_decision_blocked_reason')
_promotion_decision_key = getattr(_runtime_matrix_path_private_41, '_promotion_decision_key')
_promotion_decision_key_for_decision = getattr(_runtime_matrix_path_private_41, '_promotion_decision_key_for_decision')
_promotion_decision_key_for_window = getattr(_runtime_matrix_path_private_41, '_promotion_decision_key_for_window')
_promotion_decision_keys_for_windows = getattr(_runtime_matrix_path_private_41, '_promotion_decision_keys_for_windows')
_runtime_ledger_bucket_promotion_payload = getattr(_runtime_matrix_path_private_41, '_runtime_ledger_bucket_promotion_payload')
_runtime_ledger_trading_day_key = getattr(_runtime_matrix_path_private_41, '_runtime_ledger_trading_day_key')
_runtime_matrix_path = getattr(_runtime_matrix_path_private_41, '_runtime_matrix_path')
_safe_float = getattr(_runtime_matrix_path_private_41, '_safe_float')
_safe_int = getattr(_runtime_matrix_path_private_41, '_safe_int')
_utc = getattr(_runtime_matrix_path_private_41, '_utc')
_windows_with_allowed_promotion_decisions = getattr(_runtime_matrix_path_private_41, '_windows_with_allowed_promotion_decisions')
_EmpiricalJobsGateEvidence = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_EmpiricalJobsGateEvidence')
_LiveScaleRuntimeSummary = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_LiveScaleRuntimeSummary')
_RuntimeLedgerBucketTotals = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_RuntimeLedgerBucketTotals')
_RuntimeLedgerDailySeries = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_RuntimeLedgerDailySeries')
_RuntimeLedgerSourceAuthoritySummary = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_RuntimeLedgerSourceAuthoritySummary')
_TraceGateRefs = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_TraceGateRefs')
_WindowWeightedMetrics = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_WindowWeightedMetrics')
_benchmark_missing_families = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_benchmark_missing_families')
_blocked_trace_gate_result = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_blocked_trace_gate_result')
_empirical_jobs_consistency_status = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_empirical_jobs_consistency_status')
_empirical_jobs_gate_evidence = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_empirical_jobs_gate_evidence')
_evaluate_empirical_jobs_gate = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_evaluate_empirical_jobs_gate')
_evaluate_live_canary_gate = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_evaluate_live_canary_gate')
_evaluate_live_scale_gate = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_evaluate_live_scale_gate')
_evaluate_paper_gate = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_evaluate_paper_gate')
_latest_three_within_budget = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_latest_three_within_budget')
_live_scale_blocked_reason = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_live_scale_blocked_reason')
_live_scale_gate_result = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_live_scale_gate_result')
_live_scale_runtime_summary = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_live_scale_runtime_summary')
_missing_or_ineligible_empirical_jobs = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_missing_or_ineligible_empirical_jobs')
_paper_gate_acceptance = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_paper_gate_acceptance')
_paper_gate_benchmark_blocked_reason = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_paper_gate_benchmark_blocked_reason')
_paper_gate_has_insufficient_decisions = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_paper_gate_has_insufficient_decisions')
_paper_gate_identity_result = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_paper_gate_identity_result')
_paper_gate_precondition_result = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_paper_gate_precondition_result')
_paper_gate_refs_with_fill_price_artifact = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_paper_gate_refs_with_fill_price_artifact')
_promotion_decision_blocked_gate_result = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_promotion_decision_blocked_gate_result')
_runtime_ledger_bucket_existing_blockers = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_runtime_ledger_bucket_existing_blockers')
_runtime_ledger_bucket_is_promotion_grade = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_runtime_ledger_bucket_is_promotion_grade')
_runtime_ledger_bucket_matches_window = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_runtime_ledger_bucket_matches_window')
_runtime_ledger_bucket_refs_for_windows = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_runtime_ledger_bucket_refs_for_windows')
_runtime_ledger_bucket_summary = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_runtime_ledger_bucket_summary')
_runtime_ledger_bucket_totals = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_runtime_ledger_bucket_totals')
_runtime_ledger_bucket_window_match_key = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_runtime_ledger_bucket_window_match_key')
_runtime_ledger_daily_series = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_runtime_ledger_daily_series')
_runtime_ledger_daily_summary = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_runtime_ledger_daily_summary')
_runtime_ledger_persisted_daily_summary = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_runtime_ledger_persisted_daily_summary')
_runtime_ledger_schema_versions = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_runtime_ledger_schema_versions')
_runtime_ledger_source_authority_summary = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_runtime_ledger_source_authority_summary')
_runtime_observed_rows_for_candidate = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_runtime_observed_rows_for_candidate')
_satisfied_trace_gate_result = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_satisfied_trace_gate_result')
_trace_gate_refs_from_gate = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_trace_gate_refs_from_gate')
_trace_gate_result = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_trace_gate_result')
_window_gate_summary = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_window_gate_summary')
_window_weighted_metrics = getattr(_runtime_ledger_bucket_existing_blockers_private_97, '_window_weighted_metrics')


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
    completion_root = sys.modules.get('app.trading.completion')
    matrix_loader = (
        getattr(completion_root, 'load_doc29_completion_matrix', load_doc29_completion_matrix)
        if completion_root is not None
        else load_doc29_completion_matrix
    )
    matrix = matrix_loader()
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
    all_satisfied = all(str(gate['status']) == TRACE_STATUS_SATISFIED for gate in gates)
    blocked_gate_ids = [
        str(gate['gate_id'])
        for gate in gates
        if str(gate['status']) != TRACE_STATUS_SATISFIED
    ]
    final_promotion_blockers = list(blocked_gate_ids)
    if all_satisfied:
        final_promotion_blockers.append('completion_trace_not_runtime_ledger_authority')
    promotion_authority = {
        'evidence_collection_ok': (
            str(gate_status_map.get(DOC29_LIVE_CANARY_GATE, {}).get('status'))
            == TRACE_STATUS_SATISFIED
        ),
        'canary_collection_authorized': (
            str(gate_status_map.get(DOC29_LIVE_CANARY_GATE, {}).get('status'))
            == TRACE_STATUS_SATISFIED
        ),
        'paper_probation_satisfied_for_bounded_live_paper_collection': (
            str(gate_status_map.get(DOC29_PAPER_GATE, {}).get('status'))
            == TRACE_STATUS_SATISFIED
        ),
        'capital_promotion_allowed': False,
        'promotion_allowed': False,
        'final_authority_ok': False,
        'final_promotion_allowed': False,
        'final_promotion_blockers': final_promotion_blockers,
        'completion_trace_all_satisfied': all_satisfied,
        'authority_source': 'completion_trace_status_only',
    }
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
            'all_satisfied': all_satisfied,
        },
        'promotion_authority': promotion_authority,
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


__all__ = [name for name in globals() if not name.startswith("__")]
