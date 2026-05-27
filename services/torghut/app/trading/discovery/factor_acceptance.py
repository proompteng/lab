"""Deterministic acceptance artifacts for mined alpha factors."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any, Mapping, Sequence

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


def _string_sequence(value: Sequence[str] | None) -> tuple[str, ...]:
    if not value:
        return ()
    return tuple(
        dict.fromkeys(str(item).strip() for item in value if str(item).strip())
    )


def _stable_hash(payload: Mapping[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


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
    payload["lineage_hash"] = _stable_hash(payload)
    return payload
