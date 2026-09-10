"""Deterministic acceptance artifacts for mined alpha factors."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any, Iterable, Mapping, Sequence, cast

from app.trading.features import FEATURE_VECTOR_V3_VALUE_FIELDS


FACTOR_ACCEPTANCE_SCHEMA_VERSION = "torghut.factor-acceptance-artifact.v1"


@dataclass(frozen=True)
class FactorAcceptanceThresholds:
    min_sample_count: int = 60
    min_rank_ic: Decimal = Decimal("0.03")
    min_rank_ir: Decimal = Decimal("0.25")
    max_deflated_p_value: Decimal = Decimal("0.05")
    min_cost_stressed_net_expectancy_bps: Decimal = Decimal("0.01")

    def to_payload(self) -> dict[str, Any]:
        return {
            "min_sample_count": self.min_sample_count,
            "min_rank_ic": str(self.min_rank_ic),
            "min_rank_ir": str(self.min_rank_ir),
            "max_deflated_p_value": str(self.max_deflated_p_value),
            "min_cost_stressed_net_expectancy_bps": str(
                self.min_cost_stressed_net_expectancy_bps
            ),
        }


def _decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def _int(value: Any) -> int:
    try:
        return int(float(str(value or 0)))
    except (TypeError, ValueError):
        return 0


def _mapping(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): item for key, item in cast(Mapping[Any, Any], value).items()}


def _string_sequence(value: Sequence[str] | None) -> tuple[str, ...]:
    if not value:
        return ()
    return tuple(
        dict.fromkeys(str(item).strip() for item in value if str(item).strip())
    )


def _stable_hash(payload: Mapping[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _scorecard_decimal(
    scorecard: Mapping[str, Any],
    fold_metrics: Sequence[Mapping[str, Any]],
    keys: Sequence[str],
) -> Decimal | None:
    for key in keys:
        value = _decimal(scorecard.get(key))
        if value is not None:
            return value
    fold_values = [
        value
        for fold in fold_metrics
        for key in keys
        if (value := _decimal(fold.get(key))) is not None
    ]
    if not fold_values:
        return None
    return sum(fold_values, Decimal("0")) / Decimal(len(fold_values))


def _scorecard_sample_count(
    scorecard: Mapping[str, Any],
    fold_metrics: Sequence[Mapping[str, Any]],
) -> int:
    sample_keys = (
        "factor_sample_count",
        "rank_ic_sample_count",
        "sample_count",
        "market_limit_order_mix_sample_count",
        "limit_fill_probability_sample_count",
        "decision_count",
        "trade_decision_count",
        "runtime_decision_count",
        "filled_count",
        "fill_count",
        "filled_order_count",
        "closed_trade_count",
        "trading_day_count",
    )
    scorecard_count = max(_int(scorecard.get(key)) for key in sample_keys)
    fold_count = sum(
        max(_int(fold.get(key)) for key in sample_keys) for fold in fold_metrics
    )
    return max(scorecard_count, fold_count)


def _rank_ir_from_folds(fold_metrics: Sequence[Mapping[str, Any]]) -> Decimal | None:
    rank_ic_values = [
        value
        for fold in fold_metrics
        if (
            value := _scorecard_decimal(
                fold,
                (),
                (
                    "rank_ic",
                    "rank_ic_mean",
                    "factor_rank_ic",
                    "holdout_rank_ic",
                    "information_coefficient",
                ),
            )
        )
        is not None
    ]
    if len(rank_ic_values) < 2:
        return None
    mean = sum(rank_ic_values, Decimal("0")) / Decimal(len(rank_ic_values))
    variance = sum((value - mean) ** 2 for value in rank_ic_values) / Decimal(
        len(rank_ic_values) - 1
    )
    if variance <= 0:
        return None
    return mean / variance.sqrt()


def _expectancy_bps_from_scorecard(scorecard: Mapping[str, Any]) -> Decimal | None:
    direct = _scorecard_decimal(
        scorecard,
        (),
        (
            "factor_post_cost_expectancy_bps",
            "post_cost_expectancy_bps",
            "net_expectancy_bps",
            "realized_strategy_pnl_after_explicit_costs_bps",
            "cost_stressed_net_expectancy_bps",
        ),
    )
    if direct is not None:
        return direct
    net_pnl_per_day = _scorecard_decimal(
        scorecard,
        (),
        (
            "net_pnl_per_day",
            "market_impact_stress_net_pnl_per_day",
            "delay_adjusted_depth_stress_net_pnl_per_day",
            "post_cost_net_pnl_after_queue_position_survival_fill_stress",
        ),
    )
    filled_notional_per_day = _scorecard_decimal(
        scorecard,
        (),
        (
            "avg_filled_notional_per_day",
            "daily_filled_notional",
            "filled_notional_per_day",
        ),
    )
    if net_pnl_per_day is None or filled_notional_per_day is None:
        return None
    if filled_notional_per_day <= 0:
        return None
    return (net_pnl_per_day / filled_notional_per_day) * Decimal("10000")


def _window_payload(
    scorecard: Mapping[str, Any], keys: Iterable[str]
) -> dict[str, Any]:
    for key in keys:
        value = _mapping(scorecard.get(key))
        if value:
            return value
    replay_lineage = _mapping(scorecard.get("replay_lineage"))
    replay_coverage = _mapping(
        scorecard.get("replay_window_coverage")
        or replay_lineage.get("replay_window_coverage")
    )
    if replay_coverage:
        return {
            "source": "replay_window_coverage",
            **replay_coverage,
        }
    return {"source": "scorecard_missing_window_metadata"}


def build_factor_acceptance_artifact(
    *,
    factor_expression: str,
    source_idea: str,
    allowed_feature_dependencies: Sequence[str],
    train_window: Mapping[str, Any] | None = None,
    test_window: Mapping[str, Any] | None = None,
    sample_count: int = 0,
    candidate_count: int = 1,
    rank_ic: Decimal | str | float | None = None,
    rank_ir: Decimal | str | float | None = None,
    p_value: Decimal | str | float | None = None,
    gross_expectancy_bps: Decimal | str | float | None = None,
    cost_stress_bps: Decimal | str | float | None = None,
    available_feature_fields: Sequence[str] = FEATURE_VECTOR_V3_VALUE_FIELDS,
    thresholds: FactorAcceptanceThresholds = FactorAcceptanceThresholds(),
    expectancy_basis: str | None = None,
    evidence_metadata: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a fail-closed factor acceptance artifact.

    This mirrors recent signal-discovery systems by accepting factor ideas only
    after deterministic feature availability, RankIC/RankIR, multiple-testing,
    and cost-stress checks. It never authorizes live promotion by itself.
    """

    dependencies = _string_sequence(allowed_feature_dependencies)
    available_features = set(_string_sequence(available_feature_fields))
    missing_dependencies = sorted(
        dependency
        for dependency in dependencies
        if dependency not in available_features
    )
    rank_ic_value = _decimal(rank_ic)
    rank_ir_value = _decimal(rank_ir)
    p_value_value = _decimal(p_value)
    gross_expectancy = _decimal(gross_expectancy_bps)
    cost_stress = _decimal(cost_stress_bps)
    resolved_candidate_count = max(int(candidate_count), 1)
    deflated_p_value = (
        p_value_value * Decimal(resolved_candidate_count)
        if p_value_value is not None
        else None
    )
    cost_stressed_net = (
        gross_expectancy - abs(cost_stress)
        if gross_expectancy is not None and cost_stress is not None
        else None
    )

    rejection_reasons: list[str] = []
    if missing_dependencies:
        rejection_reasons.append("feature_dependency_missing")
    if sample_count < thresholds.min_sample_count:
        rejection_reasons.append("sample_count_below_floor")
    if rank_ic_value is None or rank_ic_value < thresholds.min_rank_ic:
        rejection_reasons.append("rank_ic_below_floor")
    if rank_ir_value is None or rank_ir_value < thresholds.min_rank_ir:
        rejection_reasons.append("rank_ir_below_floor")
    if deflated_p_value is None or deflated_p_value > thresholds.max_deflated_p_value:
        rejection_reasons.append("deflated_p_value_above_floor")
    if (
        cost_stressed_net is None
        or cost_stressed_net < thresholds.min_cost_stressed_net_expectancy_bps
    ):
        rejection_reasons.append("cost_stressed_expectancy_non_positive")

    status = "accepted" if not rejection_reasons else "rejected"
    payload: dict[str, Any] = {
        "schema_version": FACTOR_ACCEPTANCE_SCHEMA_VERSION,
        "status": status,
        "factor_expression": factor_expression,
        "source_idea": source_idea,
        "allowed_feature_dependencies": list(dependencies),
        "missing_feature_dependencies": missing_dependencies,
        "train_window": dict(train_window or {}),
        "test_window": dict(test_window or {}),
        "sample_count": sample_count,
        "candidate_count": resolved_candidate_count,
        "rank_ic": str(rank_ic_value) if rank_ic_value is not None else None,
        "rank_ir": str(rank_ir_value) if rank_ir_value is not None else None,
        "p_value": str(p_value_value) if p_value_value is not None else None,
        "deflated_p_value": str(deflated_p_value)
        if deflated_p_value is not None
        else None,
        "gross_expectancy_bps": str(gross_expectancy)
        if gross_expectancy is not None
        else None,
        "cost_stress_bps": str(cost_stress) if cost_stress is not None else None,
        "cost_stressed_net_expectancy_bps": str(cost_stressed_net)
        if cost_stressed_net is not None
        else None,
        "thresholds": thresholds.to_payload(),
        "rejection_reasons": rejection_reasons,
        "acceptance_policy": "rankic_rankir_cost_stress_fail_closed",
        "promotion_scope": "research_paper_probation_only",
        "does_not_authorize_live_promotion": True,
    }
    if expectancy_basis:
        payload["expectancy_basis"] = expectancy_basis
    if evidence_metadata:
        payload["evidence_metadata"] = dict(evidence_metadata)
    payload["lineage_hash"] = _stable_hash(payload)
    return payload


def build_factor_acceptance_artifact_from_scorecard(
    *,
    factor_expression: str,
    source_idea: str,
    allowed_feature_dependencies: Sequence[str],
    scorecard: Mapping[str, Any],
    fold_metrics: Sequence[Mapping[str, Any]] = (),
    candidate_count: int = 1,
    candidate_spec_id: str | None = None,
    candidate_id: str | None = None,
    evidence_bundle_id: str | None = None,
    available_feature_fields: Sequence[str] = FEATURE_VECTOR_V3_VALUE_FIELDS,
    thresholds: FactorAcceptanceThresholds = FactorAcceptanceThresholds(),
) -> dict[str, Any]:
    """Build factor acceptance from replay/live-paper scorecard evidence.

    Missing RankIC/RankIR/p-value/cost inputs still reject. This function only
    upgrades the metadata source from static compile-time placeholders to real
    replay/runtime scorecards when those fields are present.
    """

    resolved_candidate_count = max(
        _int(scorecard.get("factor_candidate_count"))
        or _int(scorecard.get("tested_candidate_count"))
        or _int(scorecard.get("candidate_count"))
        or candidate_count,
        1,
    )
    p_value = _scorecard_decimal(
        scorecard,
        fold_metrics,
        (
            "factor_p_value",
            "rank_ic_p_value",
            "p_value_two_sided",
            "p_value",
        ),
    )
    if p_value is None:
        deflated_p_value = _scorecard_decimal(
            scorecard,
            fold_metrics,
            (
                "factor_deflated_p_value",
                "deflated_p_value",
            ),
        )
        if deflated_p_value is not None:
            p_value = deflated_p_value / Decimal(resolved_candidate_count)

    rank_ir = _scorecard_decimal(
        scorecard,
        fold_metrics,
        (
            "rank_ir",
            "rank_ic_ir",
            "factor_rank_ir",
            "holdout_rank_ir",
            "information_ratio",
        ),
    )
    if rank_ir is None:
        rank_ir = _rank_ir_from_folds(fold_metrics)

    cost_stress_bps = _scorecard_decimal(
        scorecard,
        fold_metrics,
        (
            "factor_cost_stress_bps",
            "cost_stress_bps",
            "nonlinear_market_impact_stress_cost_bps",
            "market_impact_stress_cost_bps",
            "order_type_opportunity_cost_bps",
        ),
    )
    artifact = build_factor_acceptance_artifact(
        factor_expression=factor_expression,
        source_idea=source_idea,
        allowed_feature_dependencies=allowed_feature_dependencies,
        train_window=_window_payload(scorecard, ("train_window", "training_window")),
        test_window=_window_payload(
            scorecard,
            (
                "test_window",
                "holdout_window",
                "second_oos_window",
                "live_paper_window",
            ),
        ),
        sample_count=_scorecard_sample_count(scorecard, fold_metrics),
        candidate_count=resolved_candidate_count,
        rank_ic=_scorecard_decimal(
            scorecard,
            fold_metrics,
            (
                "rank_ic",
                "rank_ic_mean",
                "factor_rank_ic",
                "holdout_rank_ic",
                "information_coefficient",
            ),
        ),
        rank_ir=rank_ir,
        p_value=p_value,
        gross_expectancy_bps=_expectancy_bps_from_scorecard(scorecard),
        cost_stress_bps=cost_stress_bps,
        available_feature_fields=available_feature_fields,
        thresholds=thresholds,
        expectancy_basis="scorecard_post_cost_expectancy_bps_minus_additional_stress",
        evidence_metadata={
            "source": "replay_or_live_paper_scorecard",
            "candidate_spec_id": candidate_spec_id,
            "candidate_id": candidate_id,
            "evidence_bundle_id": evidence_bundle_id,
            "scorecard_keys": sorted(str(key) for key in scorecard.keys()),
            "fold_metric_count": len(fold_metrics),
        },
    )
    artifact["lineage_hash"] = _stable_hash(
        {key: value for key, value in artifact.items() if key != "lineage_hash"}
    )
    return artifact
