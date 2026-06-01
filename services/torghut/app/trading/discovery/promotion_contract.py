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
FINAL_AUTHORITY_MIN_SOURCE_BACKED_TRADING_DAYS = 20
FINAL_AUTHORITY_TARGET_DAILY_NET_PNL = '500'
FINAL_AUTHORITY_MEDIAN_DAILY_NET_PNL_FLOOR = '250'
FINAL_AUTHORITY_P10_DAILY_NET_PNL_FLOOR = '-250'
FINAL_AUTHORITY_WORST_DAY_FLOOR = '-750'
FINAL_AUTHORITY_MAX_DRAWDOWN_ABSOLUTE = '1500'
FINAL_AUTHORITY_MAX_DRAWDOWN_SLEEVE_EQUITY_PCT = '0.03'
FINAL_AUTHORITY_MAX_BEST_DAY_SHARE = '0.25'
FINAL_AUTHORITY_MAX_CONCENTRATION_SHARE = '0.35'
FINAL_AUTHORITY_MIN_CLOSED_TRADES = 300
FINAL_AUTHORITY_FILLED_NOTIONAL_FLOOR = 'target_implied_notional_x_source_backed_days'


def final_authority_parameter_contract() -> dict[str, Any]:
    return {
        'authority': 'final_runtime_ledger_live_paper_authority',
        'promotion_authority': True,
        'source_backed_runtime_ledger_required': True,
        'min_source_backed_trading_days': FINAL_AUTHORITY_MIN_SOURCE_BACKED_TRADING_DAYS,
        'mean_daily_net_pnl_floor': FINAL_AUTHORITY_TARGET_DAILY_NET_PNL,
        'median_daily_net_pnl_floor': FINAL_AUTHORITY_MEDIAN_DAILY_NET_PNL_FLOOR,
        'p10_daily_net_pnl_floor': FINAL_AUTHORITY_P10_DAILY_NET_PNL_FLOOR,
        'worst_day_floor': FINAL_AUTHORITY_WORST_DAY_FLOOR,
        'max_drawdown_absolute': FINAL_AUTHORITY_MAX_DRAWDOWN_ABSOLUTE,
        'max_drawdown_sleeve_equity_pct': FINAL_AUTHORITY_MAX_DRAWDOWN_SLEEVE_EQUITY_PCT,
        'max_best_day_share': FINAL_AUTHORITY_MAX_BEST_DAY_SHARE,
        'max_concentration_share': FINAL_AUTHORITY_MAX_CONCENTRATION_SHARE,
        'min_closed_trades': FINAL_AUTHORITY_MIN_CLOSED_TRADES,
        'filled_notional_floor': FINAL_AUTHORITY_FILLED_NOTIONAL_FLOOR,
    }


def probation_evidence_collection_contract(label: str = 'probation') -> dict[str, Any]:
    return {
        'authority': 'evidence_collection_only',
        'promotion_authority': False,
        'label': _string(label) or 'probation',
        'may_rank_candidates': True,
        'may_collect_bounded_evidence': True,
        'may_set_final_promotion_authority': False,
        'final_authority_required_contract': final_authority_parameter_contract(),
    }



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
        'probation_evidence_collection': probation_evidence_collection_contract(),
        'final_authority_contract': final_authority_parameter_contract(),
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
        'probation_evidence_collection': probation_evidence_collection_contract(),
        'final_authority_contract': final_authority_parameter_contract(),
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
        'probation_evidence_collection': probation_evidence_collection_contract(
            _string(best_candidate.get('probation_label')) or 'probation'
        ),
        'final_authority_contract': final_authority_parameter_contract(),
    }
