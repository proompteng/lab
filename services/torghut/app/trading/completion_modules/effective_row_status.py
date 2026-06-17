# fmt: off
"""Traceability helpers for doc 29 completion gates."""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping, cast

from sqlalchemy.orm import Session

from ...models import (
    VNextCompletionGateResult,
)
from ..empirical_jobs import build_empirical_jobs_status
from ..promotion_authority import capital_blocked_authority


from .runtime_matrix_path import (
    DOC29_EMPIRICAL_JOBS_GATE,
    DOC29_LIVE_CANARY_GATE,
    DOC29_LIVE_SCALE_GATE,
    DOC29_PAPER_GATE,
    DOC29_SIMULATION_FULL_DAY_GATE,
    TRACE_STATUSES,
    TRACE_STATUS_BLOCKED,
    TRACE_STATUS_REGRESSED,
    TRACE_STATUS_SATISFIED,
    TRACE_STATUS_STALE,
    as_dict as _as_dict,
    as_list as _as_list,
    as_text as _as_text,
    latest_completion_rows as _latest_completion_rows,
    latest_completion_rows_filtered as _latest_completion_rows_filtered,
    latest_empirical_rows as _latest_empirical_rows,
    latest_hypothesis_windows as _latest_hypothesis_windows,
    load_doc29_completion_matrix,
    promotion_decision_keys_for_windows as _promotion_decision_keys_for_windows,
    safe_int as _safe_int,
)
from .runtime_ledger_bucket_existing_blockers import (
    evaluate_empirical_jobs_gate as _evaluate_empirical_jobs_gate,
    evaluate_live_canary_gate as _evaluate_live_canary_gate,
    evaluate_live_scale_gate as _evaluate_live_scale_gate,
    evaluate_paper_gate as _evaluate_paper_gate,
)


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
        **capital_blocked_authority(blockers=final_promotion_blockers).as_target_fields(),
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

__all__ = (
    "build_doc29_completion_status",
)
