"""Promotion-readiness contracts for discovery outputs."""

from __future__ import annotations

from typing import Any, Mapping, cast

PROMOTION_STAGE_RESEARCH = 'research_candidate'
PROMOTION_STATUS_BLOCKED_PENDING_RUNTIME_PARITY = 'blocked_pending_runtime_parity'
PROMOTION_STATUS_BLOCKED_NO_CANDIDATE = 'blocked_no_candidate'
PROMOTION_REQUIRED_EVIDENCE = (
    'checked_in_runtime_family',
    'scheduler_v3_parity_replay',
    'scheduler_v3_approval_replay',
    'live_shadow_validation',
)


def _string(value: Any) -> str:
    return str(value or '').strip()


def runtime_harness_payload(runtime_harness: Mapping[str, Any]) -> dict[str, Any]:
    return {
        'family': _string(runtime_harness.get('family')),
        'strategy_name': _string(runtime_harness.get('strategy_name')),
        'disable_other_strategies': bool(runtime_harness.get('disable_other_strategies')),
    }


def blocked_research_candidate_promotion_readiness(
    *,
    candidate_id: str,
    family_template_id: str,
    runtime_harness: Mapping[str, Any],
) -> dict[str, Any]:
    resolved_runtime_harness = runtime_harness_payload(runtime_harness)
    blockers = [
        'scheduler_v3_parity_missing',
        'scheduler_v3_approval_missing',
        'shadow_validation_missing',
    ]
    if not resolved_runtime_harness['family'] or not resolved_runtime_harness['strategy_name']:
        blockers.insert(0, 'runtime_family_mapping_missing')
    return {
        'candidate_id': candidate_id,
        'family_template_id': family_template_id,
        'stage': PROMOTION_STAGE_RESEARCH,
        'status': PROMOTION_STATUS_BLOCKED_PENDING_RUNTIME_PARITY,
        'promotable': False,
        'reason': (
            'Discovery output is a research-only candidate until the same family is checked into '
            'runtime code/config, replayed through scheduler-v3 for parity, approved on '
            'scheduler-v3 metrics, and validated in shadow.'
        ),
        'required_evidence': list(PROMOTION_REQUIRED_EVIDENCE),
        'blockers': blockers,
        'runtime_family': resolved_runtime_harness['family'],
        'runtime_strategy_name': resolved_runtime_harness['strategy_name'],
        'runtime_harness': resolved_runtime_harness,
    }


def missing_candidate_promotion_readiness() -> dict[str, Any]:
    return {
        'candidate_id': '',
        'family_template_id': '',
        'stage': PROMOTION_STAGE_RESEARCH,
        'status': PROMOTION_STATUS_BLOCKED_NO_CANDIDATE,
        'promotable': False,
        'reason': (
            'No best candidate exists yet. Even once a research candidate appears, promotion remains '
            'blocked until runtime parity, scheduler-v3 approval replay, and shadow validation are complete.'
        ),
        'required_evidence': list(PROMOTION_REQUIRED_EVIDENCE),
        'blockers': [
            'best_candidate_missing',
            'checked_in_runtime_family_missing',
            'scheduler_v3_parity_missing',
            'scheduler_v3_approval_missing',
            'shadow_validation_missing',
        ],
        'runtime_family': '',
        'runtime_strategy_name': '',
        'runtime_harness': runtime_harness_payload({}),
    }


def summary_promotion_readiness(best_candidate: Mapping[str, Any] | None) -> dict[str, Any]:
    if best_candidate is None:
        return missing_candidate_promotion_readiness()
    return {
        'candidate_id': _string(best_candidate.get('candidate_id')),
        'family_template_id': _string(best_candidate.get('family_template_id')),
        'status': _string(best_candidate.get('promotion_status')),
        'stage': _string(best_candidate.get('promotion_stage')),
        'promotable': bool(best_candidate.get('promotable')),
        'reason': _string(best_candidate.get('promotion_reason')),
        'blockers': list(cast(list[str], best_candidate.get('promotion_blockers') or [])),
        'required_evidence': list(cast(list[str], best_candidate.get('promotion_required_evidence') or [])),
        'runtime_family': _string(best_candidate.get('runtime_family')),
        'runtime_strategy_name': _string(best_candidate.get('runtime_strategy_name')),
    }
