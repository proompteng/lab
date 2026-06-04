"""Preview-only cost-aware forecast filter stress for replay ranking.

This module converts recent 2025-2026 walk-forward forecasting and
transaction-cost/slippage papers into deterministic replay-ranking inputs.  It
never rewrites realized PnL, simulates fills, authorizes promotion, or enables
live capital.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from math import isfinite
from statistics import median
from typing import Any, cast

from app.trading.models import SignalEnvelope

COST_AWARE_FORECAST_FILTER_STRESS_SCHEMA_VERSION = (
    "torghut.cost-aware-forecast-filter-stress.v1"
)
COST_AWARE_FORECAST_FILTER_STRESS_CONTRACT_SCHEMA_VERSION = (
    "torghut.cost-aware-forecast-filter-stress-contract.v1"
)
COST_AWARE_FORECAST_FILTER_STRESS_PROOF_SEMANTICS_LABEL = (
    "cost_aware_forecast_filter_stress_preview_only_exact_replay_route_tca_"
    "order_lifecycle_runtime_ledger_required"
)
COST_AWARE_FORECAST_FILTER_STRESS_PRIMARY_SOURCES: tuple[Mapping[str, str], ...] = (
    {
        "source_id": "arxiv-2606.00060",
        "url": "https://arxiv.org/abs/2606.00060",
        "title": "Machine Learning-Based Bitcoin Trading Under Transaction Costs: Evidence From Walk-Forward Forecasting",
        "date": "2026-05-19",
        "mechanism": "walk_forward_forecasts_require_cost_threshold_trade_filter_to_avoid_turnover_destroying_gross_alpha",
    },
    {
        "source_id": "arxiv-2512.12727",
        "url": "https://arxiv.org/abs/2512.12727",
        "title": "EXFormer: A Multi-Scale Trend-Aware Transformer with Dynamic Variable Selection for Foreign Exchange Returns Prediction",
        "date": "2026-01-19",
        "mechanism": "multi_scale_trend_forecasts_need_out_of_sample_slippage_cost_survival_and_variable_selection_coverage",
    },
)

_FORECAST_BPS_FIELDS = (
    "forecast_return_bps",
    "predicted_return_bps",
    "expected_return_bps",
    "alpha_forecast_bps",
    "signal_return_bps",
    "model_prediction_bps",
    "edge_bps",
    "forecast_edge_bps",
    "expected_edge_bps",
)
_TOTAL_COST_BPS_FIELDS = (
    "total_cost_bps",
    "transaction_cost_bps",
    "estimated_total_cost_bps",
    "execution_cost_bps",
    "round_trip_cost_bps",
    "cost_threshold_bps",
)
_COST_COMPONENT_BPS_FIELDS = (
    "fee_bps",
    "commission_bps",
    "slippage_bps",
    "impact_cost_bps",
    "market_impact_cost_bps",
    "borrow_cost_bps",
)
_SPREAD_BPS_FIELDS = (
    "spread_bps",
    "quoted_spread_bps",
    "effective_spread_bps",
    "nbbo_spread_bps",
)
_ACTION_FIELDS = (
    "cost_filtered_action",
    "trade_action",
    "action",
    "decision",
    "side",
    "signal_side",
    "target_side",
)
_POSITION_FIELDS = (
    "target_position",
    "position_target",
    "desired_position",
    "target_weight",
    "order_qty",
    "trade_qty",
)
_FOLD_FIELDS = (
    "walk_forward_fold",
    "walk_forward_fold_id",
    "oos_fold_id",
    "validation_fold",
    "fold_id",
    "test_fold_id",
    "sliding_window_id",
)
_MULTI_SCALE_FIELDS = (
    "multi_scale_trend_score",
    "multi_scale_features",
    "trend_scales",
    "short_horizon_trend_bps",
    "medium_horizon_trend_bps",
    "long_horizon_trend_bps",
)
_VARIABLE_SELECTION_FIELDS = (
    "dynamic_variable_weights",
    "variable_selection_weights",
    "selected_variable_count",
    "exogenous_feature_weight_count",
    "feature_importance_snapshot",
)


@dataclass(frozen=True)
class CostAwareForecastFilterStressSummary:
    row_count: int
    forecast_observation_count: int
    cost_observation_count: int
    action_observation_count: int
    fold_observation_count: int
    distinct_walk_forward_fold_count: int
    multi_scale_feature_count: int
    variable_selection_feature_count: int
    median_abs_forecast_bps: float
    median_total_cost_bps: float
    median_cost_clearance_bps: float
    cost_clearance_share: float
    weak_forecast_trade_share: float
    cost_filtered_action_agreement_share: float
    turnover_churn_score: float
    walk_forward_coverage_score: float
    multi_scale_feature_coverage: float
    dynamic_variable_selection_coverage: float
    replay_rank_penalty_bps: float
    warnings: tuple[str, ...]
    feature_schema_hash: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": COST_AWARE_FORECAST_FILTER_STRESS_SCHEMA_VERSION,
            "feature_schema_hash": self.feature_schema_hash,
            "status": "preview_only_cost_aware_forecast_filter_stress_ranking",
            "source_papers": [
                dict(item) for item in COST_AWARE_FORECAST_FILTER_STRESS_PRIMARY_SOURCES
            ],
            "row_count": self.row_count,
            "forecast_observation_count": self.forecast_observation_count,
            "cost_observation_count": self.cost_observation_count,
            "action_observation_count": self.action_observation_count,
            "fold_observation_count": self.fold_observation_count,
            "distinct_walk_forward_fold_count": self.distinct_walk_forward_fold_count,
            "multi_scale_feature_count": self.multi_scale_feature_count,
            "variable_selection_feature_count": self.variable_selection_feature_count,
            "median_abs_forecast_bps": _stable_float(self.median_abs_forecast_bps),
            "median_total_cost_bps": _stable_float(self.median_total_cost_bps),
            "median_cost_clearance_bps": _stable_float(self.median_cost_clearance_bps),
            "cost_clearance_share": _stable_float(self.cost_clearance_share),
            "weak_forecast_trade_share": _stable_float(self.weak_forecast_trade_share),
            "cost_filtered_action_agreement_share": _stable_float(
                self.cost_filtered_action_agreement_share
            ),
            "turnover_churn_score": _stable_float(self.turnover_churn_score),
            "walk_forward_coverage_score": _stable_float(
                self.walk_forward_coverage_score
            ),
            "multi_scale_feature_coverage": _stable_float(
                self.multi_scale_feature_coverage
            ),
            "dynamic_variable_selection_coverage": _stable_float(
                self.dynamic_variable_selection_coverage
            ),
            "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            "warnings": list(self.warnings),
            "ranking_features": {
                "cost_clearance_share": _stable_float(self.cost_clearance_share),
                "weak_forecast_trade_share": _stable_float(
                    self.weak_forecast_trade_share
                ),
                "cost_filtered_action_agreement_share": _stable_float(
                    self.cost_filtered_action_agreement_share
                ),
                "turnover_churn_score": _stable_float(self.turnover_churn_score),
                "walk_forward_coverage_score": _stable_float(
                    self.walk_forward_coverage_score
                ),
                "multi_scale_feature_coverage": _stable_float(
                    self.multi_scale_feature_coverage
                ),
                "dynamic_variable_selection_coverage": _stable_float(
                    self.dynamic_variable_selection_coverage
                ),
                "median_cost_clearance_bps": _stable_float(
                    self.median_cost_clearance_bps
                ),
                "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            },
            "resource_scope": "local_offline_replay_tape_or_fixture_rows_only",
            "walk_forward_cost_filter_preview": True,
            "cost_threshold_trade_filter_preview": True,
            "turnover_churn_preview": True,
            "multi_scale_trend_feature_coverage_preview": True,
            "dynamic_variable_selection_coverage_preview": True,
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_authority_ok": False,
            "proof_semantics_label": (
                COST_AWARE_FORECAST_FILTER_STRESS_PROOF_SEMANTICS_LABEL
            ),
        }


def cost_aware_forecast_filter_stress_contract() -> dict[str, Any]:
    return {
        "schema_version": COST_AWARE_FORECAST_FILTER_STRESS_CONTRACT_SCHEMA_VERSION,
        "feature_schema_version": COST_AWARE_FORECAST_FILTER_STRESS_SCHEMA_VERSION,
        "source_papers": [
            dict(item) for item in COST_AWARE_FORECAST_FILTER_STRESS_PRIMARY_SOURCES
        ],
        "stress_policy": "walk_forward_cost_threshold_forecast_to_trade_filter_stress",
        "stress_components": [
            "cost_clearance_share",
            "weak_forecast_trade_share",
            "cost_filtered_action_agreement_share",
            "turnover_churn_score",
            "walk_forward_coverage_score",
            "multi_scale_feature_coverage",
            "dynamic_variable_selection_coverage",
        ],
        "forecast_fields": list(_FORECAST_BPS_FIELDS),
        "cost_fields": list(_TOTAL_COST_BPS_FIELDS),
        "cost_component_fields": list(_COST_COMPONENT_BPS_FIELDS),
        "spread_fields": list(_SPREAD_BPS_FIELDS),
        "action_fields": list(_ACTION_FIELDS),
        "fold_fields": list(_FOLD_FIELDS),
        "output_scope": "preview_replay_ranking_only",
        "proof_neutrality": {
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "requires_exact_replay": True,
            "requires_route_tca": True,
            "requires_order_lifecycle_fill_evidence": True,
            "requires_runtime_ledger": True,
            "rejects_gross_forecast_return_as_pnl_proof": True,
            "rejects_cost_filtered_preview_as_promotion_authority": True,
            "rejects_walk_forward_backtest_without_runtime_ledger": True,
        },
    }


def build_cost_aware_forecast_filter_stress_schema_hash() -> str:
    return _stable_hash(cost_aware_forecast_filter_stress_contract())


def extract_cost_aware_forecast_filter_stress(
    records: Sequence[SignalEnvelope],
    *,
    cost_multiplier: float = 1.0,
) -> CostAwareForecastFilterStressSummary:
    """Extract deterministic cost-threshold forecast-to-trade stress."""

    row_count = len(records)
    forecasts: list[float] = []
    costs: list[float] = []
    clearances: list[float] = []
    fold_ids: set[str] = set()
    action_signs: list[int] = []
    multi_scale_count = 0
    variable_selection_count = 0
    comparable_count = 0
    cost_clear_count = 0
    weak_forecast_trade_count = 0
    action_agreement_count = 0
    warnings: list[str] = []

    for row in records:
        forecast = _forecast_bps(row)
        cost = _total_cost_bps(row)
        action = _action_sign(row)
        fold_id = _fold_id(row)
        has_multi_scale = _has_any_payload_field(row, _MULTI_SCALE_FIELDS)
        has_variable_selection = _has_any_payload_field(row, _VARIABLE_SELECTION_FIELDS)

        if forecast is not None:
            forecasts.append(forecast)
        if cost is not None:
            costs.append(cost)
        if action is not None:
            action_signs.append(action)
        if fold_id is not None:
            fold_ids.add(fold_id)
        if has_multi_scale:
            multi_scale_count += 1
        if has_variable_selection:
            variable_selection_count += 1

        if forecast is None or cost is None:
            continue

        threshold = max(0.0, cost * cost_multiplier)
        clearance = abs(forecast) - threshold
        clearances.append(clearance)
        comparable_count += 1
        expected_trade = clearance > 0.0
        if expected_trade:
            cost_clear_count += 1
        if action is not None:
            actual_trade = action != 0
            if actual_trade and not expected_trade:
                weak_forecast_trade_count += 1
            if actual_trade == expected_trade:
                action_agreement_count += 1

    if not forecasts:
        warnings.append("missing_forecast_magnitude_inputs")
    if not costs:
        warnings.append("missing_transaction_cost_or_spread_inputs")
    if not action_signs:
        warnings.append("missing_trade_action_inputs")
    if not fold_ids:
        warnings.append("missing_walk_forward_fold_inputs")
    if multi_scale_count == 0:
        warnings.append("missing_multi_scale_trend_feature_inputs")
    if variable_selection_count == 0:
        warnings.append("missing_dynamic_variable_selection_inputs")

    forecast_count = len(forecasts)
    cost_count = len(costs)
    action_count = len(action_signs)
    fold_count = sum(1 for row in records if _fold_id(row) is not None)
    distinct_fold_count = len(fold_ids)
    median_abs_forecast = (
        median(abs(value) for value in forecasts) if forecasts else 0.0
    )
    median_cost = median(costs) if costs else 0.0
    median_clearance = median(clearances) if clearances else 0.0
    cost_clearance_share = _safe_ratio(cost_clear_count, comparable_count)
    weak_forecast_trade_share = _safe_ratio(weak_forecast_trade_count, action_count)
    cost_filtered_action_agreement_share = _safe_ratio(
        action_agreement_count,
        sum(
            1
            for row in records
            if _forecast_bps(row) is not None
            and _total_cost_bps(row) is not None
            and _action_sign(row) is not None
        ),
        default=0.0 if action_count else 1.0,
    )
    turnover_churn = _turnover_churn_score(action_signs)
    walk_forward_coverage = min(1.0, distinct_fold_count / 3.0) if row_count else 0.0
    multi_scale_coverage = _safe_ratio(multi_scale_count, row_count)
    variable_selection_coverage = _safe_ratio(variable_selection_count, row_count)
    missing_input_penalty = 0.0
    if not forecasts:
        missing_input_penalty += 4.0
    if not costs:
        missing_input_penalty += 3.0
    if not action_signs:
        missing_input_penalty += 1.5
    if not fold_ids:
        missing_input_penalty += 1.5

    replay_rank_penalty_bps = max(
        0.0,
        (1.0 - cost_clearance_share) * 4.0
        + weak_forecast_trade_share * 5.0
        + (1.0 - cost_filtered_action_agreement_share) * 3.0
        + turnover_churn * 2.0
        + (1.0 - walk_forward_coverage) * 2.0
        + (1.0 - multi_scale_coverage) * 1.0
        + (1.0 - variable_selection_coverage) * 1.0
        + max(0.0, -median_clearance) * 0.15
        + missing_input_penalty,
    )

    return CostAwareForecastFilterStressSummary(
        row_count=row_count,
        forecast_observation_count=forecast_count,
        cost_observation_count=cost_count,
        action_observation_count=action_count,
        fold_observation_count=fold_count,
        distinct_walk_forward_fold_count=distinct_fold_count,
        multi_scale_feature_count=multi_scale_count,
        variable_selection_feature_count=variable_selection_count,
        median_abs_forecast_bps=median_abs_forecast,
        median_total_cost_bps=median_cost,
        median_cost_clearance_bps=median_clearance,
        cost_clearance_share=cost_clearance_share,
        weak_forecast_trade_share=weak_forecast_trade_share,
        cost_filtered_action_agreement_share=cost_filtered_action_agreement_share,
        turnover_churn_score=turnover_churn,
        walk_forward_coverage_score=walk_forward_coverage,
        multi_scale_feature_coverage=multi_scale_coverage,
        dynamic_variable_selection_coverage=variable_selection_coverage,
        replay_rank_penalty_bps=replay_rank_penalty_bps,
        warnings=tuple(sorted(set(warnings))),
        feature_schema_hash=build_cost_aware_forecast_filter_stress_schema_hash(),
    )


def _forecast_bps(row: SignalEnvelope) -> float | None:
    return _first_float(row.payload, _FORECAST_BPS_FIELDS)


def _total_cost_bps(row: SignalEnvelope) -> float | None:
    explicit = _first_float(row.payload, _TOTAL_COST_BPS_FIELDS)
    if explicit is not None:
        return max(0.0, explicit)

    component_values = [
        value
        for field in _COST_COMPONENT_BPS_FIELDS
        if (value := _float_or_none(row.payload.get(field))) is not None
    ]
    spread = _first_float(row.payload, _SPREAD_BPS_FIELDS)
    if component_values or spread is not None:
        return max(0.0, sum(component_values) + max(0.0, spread or 0.0) * 0.5)
    return None


def _action_sign(row: SignalEnvelope) -> int | None:
    for field in _ACTION_FIELDS:
        value = row.payload.get(field)
        if value is None:
            continue
        sign = _action_value_sign(value)
        if sign is not None:
            return sign
    for field in _POSITION_FIELDS:
        value = _float_or_none(row.payload.get(field))
        if value is None:
            continue
        if value > 0.0:
            return 1
        if value < 0.0:
            return -1
        return 0
    return None


def _action_value_sign(value: Any) -> int | None:
    if isinstance(value, bool):
        return 1 if value else 0
    numeric = _float_or_none(value)
    if numeric is not None:
        if numeric > 0.0:
            return 1
        if numeric < 0.0:
            return -1
        return 0
    text = str(value).strip().lower()
    if text in {"buy", "long", "bid", "enter_long", "cover"}:
        return 1
    if text in {"sell", "short", "ask", "enter_short"}:
        return -1
    if text in {"hold", "none", "flat", "wait", "skip", "no_trade", "0"}:
        return 0
    return None


def _fold_id(row: SignalEnvelope) -> str | None:
    for field in _FOLD_FIELDS:
        value = row.payload.get(field)
        if value is not None and str(value).strip():
            return str(value).strip()
    return None


def _has_any_payload_field(row: SignalEnvelope, fields: Sequence[str]) -> bool:
    for field in fields:
        value = row.payload.get(field)
        if value is None:
            continue
        if isinstance(value, Mapping):
            if len(cast(Mapping[Any, Any], value)) > 0:
                return True
            continue
        if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
            if len(cast(Sequence[Any], value)) > 0:
                return True
            continue
        return True
    return False


def _turnover_churn_score(action_signs: Sequence[int]) -> float:
    trade_signs = [sign for sign in action_signs if sign != 0]
    if not action_signs:
        return 0.0
    trade_rate = len(trade_signs) / len(action_signs)
    if len(trade_signs) <= 1:
        flip_rate = 0.0
    else:
        flips = sum(
            1
            for previous, current in zip(trade_signs, trade_signs[1:])
            if previous != current
        )
        flip_rate = flips / (len(trade_signs) - 1)
    return min(1.0, trade_rate * 0.6 + flip_rate * 0.4)


def _first_float(payload: Mapping[str, Any], fields: Sequence[str]) -> float | None:
    for field in fields:
        value = _float_or_none(payload.get(field))
        if value is not None:
            return value
    return None


def _float_or_none(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    if not isfinite(result):
        return None
    return result


def _safe_ratio(
    numerator: int | float, denominator: int | float, *, default: float = 0.0
) -> float:
    if denominator <= 0:
        return default
    return max(0.0, min(1.0, float(numerator) / float(denominator)))


def _stable_float(value: float) -> float:
    if not isfinite(value):
        return 0.0
    return round(float(value), 10)


def _stable_hash(payload: Mapping[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode(
            "utf-8"
        )
    ).hexdigest()


__all__ = [
    "COST_AWARE_FORECAST_FILTER_STRESS_PRIMARY_SOURCES",
    "COST_AWARE_FORECAST_FILTER_STRESS_SCHEMA_VERSION",
    "CostAwareForecastFilterStressSummary",
    "build_cost_aware_forecast_filter_stress_schema_hash",
    "cost_aware_forecast_filter_stress_contract",
    "extract_cost_aware_forecast_filter_stress",
]
