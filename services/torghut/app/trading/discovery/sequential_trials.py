"""Sequential promotion helpers for strategy-factory candidates."""

from __future__ import annotations

# pyright: reportMissingTypeStubs=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false, reportAttributeAccessIssue=false

from dataclasses import dataclass
from datetime import datetime
from statistics import NormalDist
from typing import Any

import pandas as pd


def _z_value(confidence_level: float) -> float:
    bounded = min(max(float(confidence_level), 0.5), 0.999)
    return float(NormalDist().inv_cdf((1.0 + bounded) / 2.0))


def _series_bounds(
    values: pd.Series,
    *,
    confidence_level: float,
) -> tuple[float | None, float | None, float | None]:
    sample = values.dropna().astype('float64')
    if sample.empty:
        return None, None, None
    mean_value = float(sample.mean())
    if len(sample) < 2:
        return mean_value, mean_value, mean_value
    std_value = float(sample.std(ddof=0))
    stderr = std_value / max(len(sample) ** 0.5, 1.0)
    bound = _z_value(confidence_level) * stderr
    return mean_value, mean_value - bound, mean_value + bound


@dataclass(frozen=True)
class SequentialTrialSummary:
    trial_stage: str
    account: str
    start_at: datetime
    last_update_at: datetime
    sample_count: int
    confidence_sequence_lower: float | None
    confidence_sequence_upper: float | None
    posterior_edge_mean: float | None
    posterior_edge_lower: float | None
    status: str
    reason_codes: list[str]
    metric_contract: dict[str, Any]

    def to_payload(self) -> dict[str, Any]:
        return {
            'trial_stage': self.trial_stage,
            'account': self.account,
            'start_at': self.start_at.isoformat(),
            'last_update_at': self.last_update_at.isoformat(),
            'sample_count': self.sample_count,
            'confidence_sequence_lower': self.confidence_sequence_lower,
            'confidence_sequence_upper': self.confidence_sequence_upper,
            'posterior_edge_mean': self.posterior_edge_mean,
            'posterior_edge_lower': self.posterior_edge_lower,
            'status': self.status,
            'reason_codes': list(self.reason_codes),
            'metric_contract': dict(self.metric_contract),
        }


def build_sequential_trial_summary(
    *,
    net_returns: pd.Series,
    started_at: datetime,
    updated_at: datetime,
    confidence_level: float = 0.95,
    cost_calibration_status: str,
    baseline_outperformed: bool,
) -> SequentialTrialSummary:
    mean_value, lower_bound, upper_bound = _series_bounds(
        net_returns,
        confidence_level=confidence_level,
    )
    sample_count = int(net_returns.dropna().shape[0])
    reason_codes: list[str] = []
    status = 'observe_only'
    if sample_count <= 0:
        reason_codes.append('no_sequential_samples')
    elif lower_bound is None:
        reason_codes.append('sequential_bounds_unavailable')
    else:
        if cost_calibration_status != 'calibrated':
            reason_codes.append('cost_calibration_not_calibrated')
        if not baseline_outperformed:
            reason_codes.append('baseline_not_outperformed')
        if lower_bound <= 0:
            reason_codes.append('posterior_edge_not_positive')
        if not reason_codes:
            status = 'paper_ready'
        else:
            status = 'paper_only'

    metric_contract = {
        'schema_version': 'sequential-metric-contract-v1',
        'metric': 'daily_net_edge_after_cost',
        'stage': 'paper_canary',
        'confidence_level': confidence_level,
        'advance_rule': 'lower_bound_gt_zero_and_cost_calibration_calibrated',
        'demotion_rule': 'lower_bound_lte_zero_or_cost_calibration_stale',
        'sample_unit': 'trading_day',
    }
    return SequentialTrialSummary(
        trial_stage='paper_canary',
        account='paper',
        start_at=started_at,
        last_update_at=updated_at,
        sample_count=sample_count,
        confidence_sequence_lower=lower_bound,
        confidence_sequence_upper=upper_bound,
        posterior_edge_mean=mean_value,
        posterior_edge_lower=lower_bound,
        status=status,
        reason_codes=reason_codes,
        metric_contract=metric_contract,
    )


__all__ = ['SequentialTrialSummary', 'build_sequential_trial_summary']
