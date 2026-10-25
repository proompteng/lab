"""Shared coercion and metric helpers for the profit-target oracle."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Mapping, Sequence, cast

from .policy import (
    ACCEPTED_LEDGER_PNL_BASES,
    ACCEPTED_LEDGER_PNL_SOURCES,
    AVG_FILLED_NOTIONAL_PER_DAY_KEYS,
    POST_COST_EXPECTANCY_BPS_KEYS,
    ProfitTargetOraclePolicy,
)


@dataclass(frozen=True)
class _PnlAuthorityStatus:
    basis_accepted: bool
    source_accepted: bool


@dataclass(frozen=True)
class _ObservedExpectancy:
    value: Decimal | None
    source: str


@dataclass(frozen=True)
class TargetImpliedNotionalInputs:
    scorecard: Mapping[str, Any]
    target_net_pnl_per_day: Decimal
    baseline_min_avg_filled_notional_per_day: Decimal
    post_cost_net_pnl_per_day: Decimal
    post_cost_pnl_basis: str
    post_cost_pnl_source: str


@dataclass(frozen=True)
class RiskAdjustedDrawdownInputs:
    metric: str
    observed: Decimal
    start_equity: Decimal
    normal_pct: Decimal
    extended_pct: Decimal
    total_net_pnl: Decimal
    min_total_net_pnl_to_drawdown_ratio: Decimal
    absolute_cap: Decimal


def decimal_value(value: Any, *, default: str = "0") -> Decimal:
    try:
        return Decimal(str(value if value is not None else default))
    except Exception:
        return Decimal(default)


def nonnegative_int(value: Any, *, default: int = 0) -> int:
    try:
        return max(0, int(Decimal(str(value if value is not None else default))))
    except Exception:
        return default


def boolish(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value if value is not None else "").strip().lower() in {
        "1",
        "true",
        "yes",
        "y",
        "passed",
    }


def string_value(value: Any) -> str:
    return str(value if value is not None else "").strip()


def first_normalized_scorecard_text(scorecard: Mapping[str, Any], *keys: str) -> str:
    for key in keys:
        normalized = string_value(scorecard.get(key)).lower()
        if normalized:
            return normalized
    return ""


def numeric_check(
    *,
    metric: str,
    observed: Decimal,
    operator: str,
    threshold: Decimal,
) -> dict[str, Any]:
    if operator == "gte":
        passed = observed >= threshold
    elif operator == "lte":
        passed = observed <= threshold
    elif operator == "gt":
        passed = observed > threshold
    else:
        raise ValueError(f"oracle_operator_unsupported:{operator}")
    return {
        "metric": metric,
        "observed": str(observed),
        "operator": operator,
        "threshold": str(threshold),
        "passed": passed,
    }


def decimal_payload(value: Decimal | None) -> str | None:
    if value is None:
        return None
    return format(value, "f")


def _first_positive_decimal(
    scorecard: Mapping[str, Any], keys: tuple[str, ...]
) -> tuple[Decimal, str]:
    for key in keys:
        value = decimal_value(scorecard.get(key))
        if value > 0:
            return value, key
    return Decimal("0"), ""


def _first_decimal_or_none(
    scorecard: Mapping[str, Any], keys: tuple[str, ...]
) -> tuple[Decimal | None, str]:
    for key in keys:
        raw_value = scorecard.get(key)
        if raw_value is None or (isinstance(raw_value, str) and not raw_value.strip()):
            continue
        return decimal_value(raw_value), key
    return None, ""


def _pnl_authority_status(*, basis: str, source: str) -> _PnlAuthorityStatus:
    return _PnlAuthorityStatus(
        basis_accepted=basis in ACCEPTED_LEDGER_PNL_BASES,
        source_accepted=source in ACCEPTED_LEDGER_PNL_SOURCES,
    )


def _observed_expectancy_bps(
    *,
    authority: _PnlAuthorityStatus,
    avg_filled_notional_per_day: Decimal,
    explicit_expectancy: tuple[Decimal | None, str],
    post_cost_net_pnl_per_day: Decimal,
) -> _ObservedExpectancy:
    if (
        not authority.basis_accepted
        or not authority.source_accepted
        or avg_filled_notional_per_day <= 0
    ):
        return _ObservedExpectancy(value=None, source="")

    explicit_expectancy_bps, explicit_expectancy_source = explicit_expectancy
    if explicit_expectancy_bps is not None:
        return _ObservedExpectancy(
            value=explicit_expectancy_bps,
            source=explicit_expectancy_source,
        )
    if post_cost_net_pnl_per_day <= 0:
        return _ObservedExpectancy(value=None, source="")
    return _ObservedExpectancy(
        value=post_cost_net_pnl_per_day
        / avg_filled_notional_per_day
        * Decimal("10000"),
        source="derived_from_post_cost_net_pnl_per_day_and_avg_filled_notional_per_day",
    )


def _target_implied_min_notional(
    *,
    target_net_pnl_per_day: Decimal,
    observed_expectancy_bps: Decimal | None,
) -> Decimal | None:
    if observed_expectancy_bps is None or observed_expectancy_bps <= 0:
        return None
    return target_net_pnl_per_day * Decimal("10000") / observed_expectancy_bps


def _target_implied_blockers(
    *,
    authority: _PnlAuthorityStatus,
    avg_filled_notional_per_day: Decimal,
    observed_expectancy_bps: Decimal | None,
) -> list[str]:
    blockers: list[str] = []
    if not authority.basis_accepted:
        blockers.append("target_implied_post_cost_pnl_basis_missing_or_unsupported")
    if not authority.source_accepted:
        blockers.append("target_implied_post_cost_pnl_source_missing_or_unsupported")
    if avg_filled_notional_per_day <= 0:
        blockers.append(
            "target_implied_avg_filled_notional_per_day_missing_or_non_positive"
        )
    if observed_expectancy_bps is None or observed_expectancy_bps <= 0:
        blockers.append(
            "target_implied_post_cost_expectancy_bps_missing_or_non_positive"
        )
    return blockers


def target_implied_notional_gate_payload(
    inputs: TargetImpliedNotionalInputs,
) -> dict[str, Any]:
    avg_filled_notional = _first_positive_decimal(
        inputs.scorecard,
        AVG_FILLED_NOTIONAL_PER_DAY_KEYS,
    )
    authority = _pnl_authority_status(
        basis=inputs.post_cost_pnl_basis,
        source=inputs.post_cost_pnl_source,
    )
    observed_expectancy = _observed_expectancy_bps(
        authority=authority,
        avg_filled_notional_per_day=avg_filled_notional[0],
        explicit_expectancy=_first_decimal_or_none(
            inputs.scorecard,
            POST_COST_EXPECTANCY_BPS_KEYS,
        ),
        post_cost_net_pnl_per_day=inputs.post_cost_net_pnl_per_day,
    )
    target_implied_min_avg_filled_notional_per_day = _target_implied_min_notional(
        target_net_pnl_per_day=inputs.target_net_pnl_per_day,
        observed_expectancy_bps=observed_expectancy.value,
    )
    effective_min_avg_filled_notional_per_day = (
        inputs.baseline_min_avg_filled_notional_per_day
    )
    if target_implied_min_avg_filled_notional_per_day is not None:
        effective_min_avg_filled_notional_per_day = max(
            inputs.baseline_min_avg_filled_notional_per_day,
            target_implied_min_avg_filled_notional_per_day,
        )

    return {
        "target_daily_net_pnl": decimal_payload(inputs.target_net_pnl_per_day),
        "post_cost_net_pnl_per_day": decimal_payload(inputs.post_cost_net_pnl_per_day),
        "post_cost_pnl_basis": inputs.post_cost_pnl_basis,
        "post_cost_pnl_source": inputs.post_cost_pnl_source,
        "post_cost_basis_accepted": authority.basis_accepted,
        "post_cost_source_accepted": authority.source_accepted,
        "avg_filled_notional_per_day": decimal_payload(avg_filled_notional[0]),
        "avg_filled_notional_per_day_source": avg_filled_notional[1],
        "observed_post_cost_expectancy_bps": decimal_payload(observed_expectancy.value),
        "observed_post_cost_expectancy_bps_source": observed_expectancy.source,
        "baseline_min_avg_filled_notional_per_day": decimal_payload(
            inputs.baseline_min_avg_filled_notional_per_day
        ),
        "target_implied_min_avg_filled_notional_per_day": decimal_payload(
            target_implied_min_avg_filled_notional_per_day
        ),
        "effective_min_avg_filled_notional_per_day": decimal_payload(
            effective_min_avg_filled_notional_per_day
        ),
        "target_implied_min_notional_formula": (
            "target_daily_net_pnl / (observed_post_cost_expectancy_bps / 10000)"
        ),
        "blockers": _target_implied_blockers(
            authority=authority,
            avg_filled_notional_per_day=avg_filled_notional[0],
            observed_expectancy_bps=observed_expectancy.value,
        ),
    }


def artifact_refs(scorecard: Mapping[str, Any], *keys: str) -> list[str]:
    refs: list[str] = []
    for key in keys:
        raw_value = scorecard.get(key)
        if isinstance(raw_value, list):
            for item in cast(list[Any], raw_value):
                normalized = string_value(item)
                if normalized:
                    refs.append(normalized)
            continue
        normalized = string_value(raw_value)
        if normalized:
            refs.append(normalized)
    return refs


def string_sequence(value: Any) -> list[str]:
    if isinstance(value, (list, tuple)):
        return [
            normalized
            for item in cast(Sequence[Any], value)
            if (normalized := string_value(item))
        ]
    raw_value = string_value(value)
    if not raw_value:
        return []
    if "," in raw_value:
        return [item.strip() for item in raw_value.split(",") if item.strip()]
    return [raw_value]


def requires_rejected_signal_outcome_learning(
    scorecard: Mapping[str, Any], policy: ProfitTargetOraclePolicy
) -> bool:
    if policy.require_rejected_signal_outcome_learning:
        return True
    if boolish(
        scorecard.get("requires_rejected_signal_outcome_learning")
        or scorecard.get("rejected_signal_outcome_learning_required")
        or scorecard.get("requires_rejected_signal_outcome_calibration")
        or scorecard.get("rejected_signal_outcome_calibration_required")
    ):
        return True
    overlay_ids = set(
        string_sequence(
            scorecard.get("mechanism_overlay_ids")
            or scorecard.get("mechanism_overlays")
            or scorecard.get("overlay_ids")
        )
    )
    return "rejected_signal_outcome_calibration" in overlay_ids


def requires_order_type_execution_quality(
    scorecard: Mapping[str, Any], policy: ProfitTargetOraclePolicy
) -> bool:
    if policy.require_order_type_execution_quality:
        return True
    if boolish(
        scorecard.get("requires_order_type_execution_quality")
        or scorecard.get("order_type_execution_quality_required")
        or scorecard.get("requires_order_type_ablation")
        or scorecard.get("requires_market_limit_order_mix")
        or scorecard.get("market_limit_order_mix_required")
    ):
        return True
    overlay_ids = set(
        string_sequence(
            scorecard.get("mechanism_overlay_ids")
            or scorecard.get("mechanism_overlays")
            or scorecard.get("overlay_ids")
        )
    )
    return "mixed_market_limit_execution_policy" in overlay_ids


def requires_mpc_dynamic_execution_schedule(
    scorecard: Mapping[str, Any], policy: ProfitTargetOraclePolicy
) -> bool:
    if policy.require_mpc_dynamic_execution_schedule:
        return True
    if boolish(
        scorecard.get("requires_mpc_dynamic_execution_schedule")
        or scorecard.get("required_mpc_dynamic_execution_schedule")
        or scorecard.get("requires_dynamic_execution_schedule")
    ):
        return True
    overlay_ids = set(
        string_sequence(
            scorecard.get("mechanism_overlay_ids")
            or scorecard.get("mechanism_overlays")
            or scorecard.get("overlay_ids")
        )
    )
    return "mpc_dynamic_execution_schedule" in overlay_ids


def requires_implementation_uncertainty_stability(
    scorecard: Mapping[str, Any], policy: ProfitTargetOraclePolicy
) -> bool:
    if policy.require_implementation_uncertainty_stability:
        return True
    if boolish(
        scorecard.get("implementation_uncertainty_required")
        or scorecard.get("requires_implementation_uncertainty_stability")
        or scorecard.get("requires_implementation_risk_backtest_stability")
    ):
        return True
    overlay_ids = set(
        string_sequence(
            scorecard.get("mechanism_overlay_ids")
            or scorecard.get("mechanism_overlays")
            or scorecard.get("overlay_ids")
        )
    )
    return bool(
        {
            "execution_reality_gap_stability",
            "implementation_risk_backtest_stability",
            "order_flow_impact_stability",
        }
        & overlay_ids
    )


def requires_conformal_tail_risk(
    scorecard: Mapping[str, Any], policy: ProfitTargetOraclePolicy
) -> bool:
    if policy.require_conformal_tail_risk:
        return True
    if boolish(
        scorecard.get("conformal_tail_risk_required")
        or scorecard.get("requires_conformal_tail_risk")
        or scorecard.get("requires_conformal_var_cost_buffer")
    ):
        return True
    overlay_ids = set(
        string_sequence(
            scorecard.get("mechanism_overlay_ids")
            or scorecard.get("mechanism_overlays")
            or scorecard.get("overlay_ids")
        )
    )
    return bool(
        {
            "conformal_tail_risk",
            "conformal_var_cost_buffer",
            "regime_weighted_conformal_var",
        }
        & overlay_ids
    )


def requires_predictability_decay_stress(
    scorecard: Mapping[str, Any], policy: ProfitTargetOraclePolicy
) -> bool:
    if policy.require_predictability_decay_stress:
        return True
    if boolish(
        scorecard.get("predictability_decay_stress_required")
        or scorecard.get("requires_predictability_decay_stress")
        or scorecard.get("requires_horizon_decay_curve")
        or scorecard.get("requires_spread_adjusted_label_replay")
    ):
        return True
    overlay_ids = set(
        string_sequence(
            scorecard.get("mechanism_overlay_ids")
            or scorecard.get("mechanism_overlays")
            or scorecard.get("overlay_ids")
        )
    )
    return "alpha_decay_predictability_stress" in overlay_ids


def start_equity(
    scorecard: Mapping[str, Any], policy: ProfitTargetOraclePolicy
) -> Decimal:
    for key in (
        "start_equity",
        "account_start_equity",
        "execution_start_equity",
        "executable_replay_start_equity",
        "runtime_start_equity",
    ):
        value = decimal_value(scorecard.get(key))
        if value > 0:
            return value
    return policy.default_start_equity


def total_net_pnl(
    *,
    daily_net: Mapping[str, Any] | None,
    net_pnl_per_day: Decimal,
    trading_day_count: int,
) -> Decimal:
    if daily_net:
        return sum((decimal_value(value) for value in daily_net.values()), Decimal("0"))
    return net_pnl_per_day * Decimal(max(1, trading_day_count))


def profit_factor(
    scorecard: Mapping[str, Any],
    *,
    daily_net: Mapping[str, Any] | None,
    total_net_pnl: Decimal,
    worst_day_loss: Decimal,
) -> Decimal:
    explicit = scorecard.get("profit_factor")
    if explicit is not None:
        return decimal_value(explicit)
    if daily_net:
        positive_total = sum(
            (
                decimal_value(value)
                for value in daily_net.values()
                if decimal_value(value) > 0
            ),
            Decimal("0"),
        )
        negative_total = sum(
            (
                -decimal_value(value)
                for value in daily_net.values()
                if decimal_value(value) < 0
            ),
            Decimal("0"),
        )
        if negative_total > 0:
            return positive_total / negative_total
        return Decimal("999999999") if positive_total > 0 else Decimal("0")
    if worst_day_loss <= 0 and total_net_pnl > 0:
        return Decimal("999999999")
    return Decimal("0")


def risk_adjusted_drawdown_check(inputs: RiskAdjustedDrawdownInputs) -> dict[str, Any]:
    normal_limit = max(Decimal("0"), inputs.start_equity * inputs.normal_pct)
    extended_limit = max(normal_limit, inputs.start_equity * inputs.extended_pct)
    absolute_limit = (
        extended_limit
        if inputs.absolute_cap <= 0
        else min(inputs.absolute_cap, extended_limit)
    )
    ratio = (
        Decimal("999999999")
        if inputs.observed <= 0
        else inputs.total_net_pnl / inputs.observed
    )
    if inputs.observed <= normal_limit:
        passed = True
        mode = "normal_pct"
    elif inputs.observed <= absolute_limit and inputs.observed > 0:
        passed = ratio >= inputs.min_total_net_pnl_to_drawdown_ratio
        mode = "return_adjusted"
    else:
        passed = inputs.observed <= absolute_limit
        mode = "hard_cap"
    return {
        "metric": inputs.metric,
        "observed": str(inputs.observed),
        "operator": "risk_adjusted_lte",
        "threshold": str(normal_limit),
        "extended_threshold": str(absolute_limit),
        "start_equity": str(inputs.start_equity),
        "normal_pct_equity": str(inputs.normal_pct),
        "extended_pct_equity": str(inputs.extended_pct),
        "total_net_pnl_to_drawdown_ratio": str(ratio),
        "min_total_net_pnl_to_drawdown_ratio": str(
            inputs.min_total_net_pnl_to_drawdown_ratio
        ),
        "mode": mode,
        "passed": passed,
    }
