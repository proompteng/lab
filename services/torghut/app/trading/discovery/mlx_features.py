"""Candidate descriptor helpers for MLX-backed local autoresearch."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any, Mapping, cast

from app.trading.discovery.autoresearch import FamilyAutoresearchPlan
from app.trading.discovery.family_templates import FamilyTemplate


def _string(value: Any) -> str:
    return str(value or '').strip()


def _mapping(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    mapping_value = cast(Mapping[Any, Any], value)
    return {str(key): item for key, item in mapping_value.items()}


def _first_value(raw: Any) -> Any:
    if isinstance(raw, list):
        raw_values = cast(list[Any], raw)
        return raw_values[0] if raw_values else None
    return raw


def _param_value(config: Mapping[str, Any], key: str) -> Any:
    return _first_value(_mapping(config.get('parameters')).get(key))


def _override_value(config: Mapping[str, Any], key: str) -> Any:
    return _first_value(_mapping(config.get('strategy_overrides')).get(key))


def _infer_side_policy(template: FamilyTemplate) -> str:
    runtime = _mapping(template.runtime_harness)
    joined = ' '.join(
        [
            template.family_id,
            _string(runtime.get('family')),
            _string(runtime.get('strategy_name')),
            template.economic_mechanism,
        ]
    ).lower()
    if 'short' in joined:
        return 'short'
    if 'long' in joined:
        return 'long'
    return 'long_short'


def _infer_entry_window_start(config: Mapping[str, Any]) -> int:
    for key in (
        'entry_start_minutes_since_open',
        'leader_reclaim_start_minutes_since_open',
        'open_window_start_minutes_since_open',
        'start_minutes_since_open',
    ):
        value = _param_value(config, key)
        if value is not None:
            try:
                return int(float(str(value)))
            except ValueError:
                continue
    return 0


def _infer_entry_window_end(config: Mapping[str, Any], start_minute: int) -> int:
    for key in (
        'entry_end_minutes_since_open',
        'open_window_end_minutes_since_open',
        'end_minutes_since_open',
    ):
        value = _param_value(config, key)
        if value is not None:
            try:
                return int(float(str(value)))
            except ValueError:
                continue
    hold_seconds = _param_value(config, 'max_hold_seconds')
    if hold_seconds is not None:
        try:
            return start_minute + max(1, int(float(str(hold_seconds)) // 60))
        except ValueError:
            pass
    return start_minute + 30


def _infer_max_hold_minutes(config: Mapping[str, Any], start_minute: int, end_minute: int) -> int:
    hold_seconds = _param_value(config, 'max_hold_seconds')
    if hold_seconds is not None:
        try:
            return max(1, int(float(str(hold_seconds)) // 60))
        except ValueError:
            pass
    return max(1, end_minute - start_minute)


def _infer_rank_policy(config: Mapping[str, Any], template: FamilyTemplate) -> str:
    params = _mapping(config.get('parameters'))
    for key in params:
        if 'cross_section' in key:
            return 'cross_sectional_rank'
        if 'rank' in key:
            return 'rank'
    if template.entry_motifs:
        return template.entry_motifs[0]
    return 'none'


def _infer_rank_count(config: Mapping[str, Any]) -> int:
    for key in ('max_entries_per_session', 'rank_count'):
        value = _param_value(config, key)
        if value is not None:
            try:
                return max(1, int(float(str(value))))
            except ValueError:
                continue
    return 1


def _infer_budget(value: Any, default: str = '0') -> str:
    normalized = _string(value)
    return normalized or default


def _descriptor_id(payload: Mapping[str, Any]) -> str:
    digest = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(',', ':')).encode('utf-8')
    ).hexdigest()
    return f'desc-{digest[:24]}'


@dataclass(frozen=True)
class MlxCandidateDescriptor:
    descriptor_id: str
    candidate_id: str
    family_template_id: str
    runtime_family: str
    strategy_name: str
    side_policy: str
    entry_window_start_minute: int
    entry_window_end_minute: int
    max_hold_minutes: int
    entry_type: str
    exit_type: str
    rank_policy: str
    rank_count: int
    gross_budget_usd: str
    per_leg_budget_usd: str
    normalization_regime: str
    regime_gate_id: str
    requires_prev_day_features: bool
    requires_cross_sectional_features: bool
    requires_quote_quality_gate: bool
    expected_fill_mode: str
    approval_path: str

    def to_payload(self) -> dict[str, Any]:
        return {
            'descriptor_id': self.descriptor_id,
            'candidate_id': self.candidate_id,
            'family_template_id': self.family_template_id,
            'runtime_family': self.runtime_family,
            'strategy_name': self.strategy_name,
            'side_policy': self.side_policy,
            'entry_window_start_minute': self.entry_window_start_minute,
            'entry_window_end_minute': self.entry_window_end_minute,
            'max_hold_minutes': self.max_hold_minutes,
            'entry_type': self.entry_type,
            'exit_type': self.exit_type,
            'rank_policy': self.rank_policy,
            'rank_count': self.rank_count,
            'gross_budget_usd': self.gross_budget_usd,
            'per_leg_budget_usd': self.per_leg_budget_usd,
            'normalization_regime': self.normalization_regime,
            'regime_gate_id': self.regime_gate_id,
            'requires_prev_day_features': self.requires_prev_day_features,
            'requires_cross_sectional_features': self.requires_cross_sectional_features,
            'requires_quote_quality_gate': self.requires_quote_quality_gate,
            'expected_fill_mode': self.expected_fill_mode,
            'approval_path': self.approval_path,
        }


def descriptor_from_sweep_config(
    *,
    candidate_id: str,
    family_plan: FamilyAutoresearchPlan,
    sweep_config: Mapping[str, Any],
) -> MlxCandidateDescriptor:
    template = family_plan.family_template
    runtime = _mapping(template.runtime_harness)
    start_minute = _infer_entry_window_start(sweep_config)
    end_minute = _infer_entry_window_end(sweep_config, start_minute)
    runtime_family = _string(runtime.get('family'))
    strategy_name = _string(runtime.get('strategy_name'))
    side_policy = _infer_side_policy(template)
    max_hold_minutes = _infer_max_hold_minutes(sweep_config, start_minute, end_minute)
    entry_type = template.entry_motifs[0] if template.entry_motifs else 'unknown'
    exit_type = template.exit_motifs[0] if template.exit_motifs else 'unknown'
    rank_policy = _infer_rank_policy(sweep_config, template)
    rank_count = _infer_rank_count(sweep_config)
    gross_budget_usd = _infer_budget(_override_value(sweep_config, 'max_notional_per_trade'))
    per_leg_budget_usd = _infer_budget(_override_value(sweep_config, 'max_notional_per_trade'))
    normalization_regime = _string(_override_value(sweep_config, 'normalization_regime')) or 'runtime_default'
    regime_gate_id = (
        _string(template.regime_activation_rules[0].get('rule_id')) if template.regime_activation_rules else 'none'
    )
    requires_prev_day_features = any(
        term in feature for feature in template.required_features for term in ('prev_day', 'prior_day')
    )
    requires_cross_sectional_features = any('cross_section' in feature for feature in template.required_features)
    requires_quote_quality_gate = bool(template.liquidity_assumptions)
    expected_fill_mode = _string(_override_value(sweep_config, 'entry_order_type')) or 'runtime_default'
    approval_path = 'scheduler_v3'
    descriptor_payload: dict[str, Any] = {
        'candidate_id': candidate_id,
        'family_template_id': template.family_id,
        'runtime_family': runtime_family,
        'strategy_name': strategy_name,
        'side_policy': side_policy,
        'entry_window_start_minute': start_minute,
        'entry_window_end_minute': end_minute,
        'max_hold_minutes': max_hold_minutes,
        'entry_type': entry_type,
        'exit_type': exit_type,
        'rank_policy': rank_policy,
        'rank_count': rank_count,
        'gross_budget_usd': gross_budget_usd,
        'per_leg_budget_usd': per_leg_budget_usd,
        'normalization_regime': normalization_regime,
        'regime_gate_id': regime_gate_id,
        'requires_prev_day_features': requires_prev_day_features,
        'requires_cross_sectional_features': requires_cross_sectional_features,
        'requires_quote_quality_gate': requires_quote_quality_gate,
        'expected_fill_mode': expected_fill_mode,
        'approval_path': approval_path,
    }
    return MlxCandidateDescriptor(
        descriptor_id=_descriptor_id(descriptor_payload),
        candidate_id=candidate_id,
        family_template_id=template.family_id,
        runtime_family=runtime_family,
        strategy_name=strategy_name,
        side_policy=side_policy,
        entry_window_start_minute=start_minute,
        entry_window_end_minute=end_minute,
        max_hold_minutes=max_hold_minutes,
        entry_type=entry_type,
        exit_type=exit_type,
        rank_policy=rank_policy,
        rank_count=rank_count,
        gross_budget_usd=gross_budget_usd,
        per_leg_budget_usd=per_leg_budget_usd,
        normalization_regime=normalization_regime,
        regime_gate_id=regime_gate_id,
        requires_prev_day_features=requires_prev_day_features,
        requires_cross_sectional_features=requires_cross_sectional_features,
        requires_quote_quality_gate=requires_quote_quality_gate,
        expected_fill_mode=expected_fill_mode,
        approval_path=approval_path,
    )


def descriptor_from_candidate_payload(
    *,
    candidate_payload: Mapping[str, Any],
    family_plan: FamilyAutoresearchPlan,
) -> MlxCandidateDescriptor:
    replay_config = _mapping(candidate_payload.get('replay_config'))
    compiled_config = {
        'parameters': _mapping(replay_config.get('params')),
        'strategy_overrides': _mapping(replay_config.get('strategy_overrides')),
    }
    return descriptor_from_sweep_config(
        candidate_id=_string(candidate_payload.get('candidate_id')) or 'candidate',
        family_plan=family_plan,
        sweep_config=compiled_config,
    )


def descriptor_numeric_vector(descriptor: MlxCandidateDescriptor) -> list[float]:
    return [
        float(descriptor.entry_window_start_minute),
        float(descriptor.entry_window_end_minute),
        float(descriptor.max_hold_minutes),
        float(descriptor.rank_count),
        float(descriptor.requires_prev_day_features),
        float(descriptor.requires_cross_sectional_features),
        float(descriptor.requires_quote_quality_gate),
    ]
