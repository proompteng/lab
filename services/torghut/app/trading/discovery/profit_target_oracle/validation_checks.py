"""Final validation checks and result assembly for the profit-target oracle."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from .context import OracleEvaluationContext
from .parsing import (
    artifact_refs,
    boolish,
    decimal_value,
    numeric_check,
    nonnegative_int,
    requires_rejected_signal_outcome_learning,
    string_value,
    string_sequence,
)
from .policy import PROFIT_TARGET_ORACLE_SCHEMA_VERSION


def append_double_oos_checks(ctx: OracleEvaluationContext) -> None:
    scorecard = ctx.scorecard
    policy = ctx.policy
    checks = ctx.checks
    target_net_pnl_per_day = ctx.target_net_pnl_per_day
    double_oos_artifact_refs = artifact_refs(
        scorecard,
        "double_oos_artifact_ref",
        "double_oos_artifact_refs",
        "double_oos_report_ref",
        "walk_forward_oos_artifact_ref",
    )
    double_oos_artifact_present = bool(double_oos_artifact_refs)
    double_oos_passed = boolish(
        scorecard.get("double_oos_passed")
        or scorecard.get("double_out_of_sample_passed")
        or scorecard.get("walk_forward_oos_passed")
    )
    checks.append(
        {
            "metric": "double_oos_passed",
            "observed": str(double_oos_passed).lower(),
            "operator": "eq",
            "threshold": "true",
            "source_marker": "double_oos_walkforward_arxiv_2602_10785_2026",
            "passed": double_oos_passed if policy.require_double_oos else True,
        }
    )
    checks.append(
        {
            "metric": "double_oos_artifact_present",
            "observed": str(double_oos_artifact_present).lower(),
            "operator": "eq",
            "threshold": "true",
            "source_marker": "double_oos_walkforward_arxiv_2602_10785_2026",
            "passed": double_oos_artifact_present
            if policy.require_double_oos
            else True,
        }
    )
    checks.append(
        numeric_check(
            metric="double_oos_independent_window_count",
            observed=Decimal(
                nonnegative_int(
                    scorecard.get("double_oos_independent_window_count")
                    or scorecard.get("double_oos_fold_count")
                    or scorecard.get("oos_fold_count")
                )
            ),
            operator="gte",
            threshold=Decimal(max(0, policy.min_double_oos_independent_window_count))
            if policy.require_double_oos
            else Decimal("0"),
        )
    )
    checks.append(
        numeric_check(
            metric="double_oos_pass_rate",
            observed=decimal_value(
                scorecard.get("double_oos_pass_rate")
                or scorecard.get("double_out_of_sample_pass_rate")
                or scorecard.get("walk_forward_oos_pass_rate")
            ),
            operator="gte",
            threshold=policy.min_double_oos_pass_rate
            if policy.require_double_oos
            else Decimal("0"),
        )
    )
    double_oos_net_check = numeric_check(
        metric="double_oos_net_pnl_per_day",
        observed=decimal_value(
            scorecard.get("double_oos_net_pnl_per_day")
            or scorecard.get("double_out_of_sample_net_pnl_per_day")
            or scorecard.get("walk_forward_oos_net_pnl_per_day")
        ),
        operator="gte",
        threshold=target_net_pnl_per_day,
    )
    if not policy.require_double_oos:
        double_oos_net_check["passed"] = True
    checks.append(
        {
            **double_oos_net_check,
            "source_marker": "double_oos_walkforward_arxiv_2602_10785_2026",
        }
    )
    double_oos_cost_shock_net_check = numeric_check(
        metric="double_oos_cost_shock_net_pnl_per_day",
        observed=decimal_value(
            scorecard.get("double_oos_cost_shock_net_pnl_per_day")
            or scorecard.get("double_oos_market_impact_stress_net_pnl_per_day")
            or scorecard.get("double_oos_cost_sensitivity_net_pnl_per_day")
        ),
        operator="gte",
        threshold=target_net_pnl_per_day,
    )
    if not policy.require_double_oos:
        double_oos_cost_shock_net_check["passed"] = True
    checks.append(
        {
            **double_oos_cost_shock_net_check,
            "source_marker": "double_oos_cost_sensitivity_arxiv_2602_10785_2026",
        }
    )


def append_rejected_signal_learning_checks(ctx: OracleEvaluationContext) -> None:
    scorecard = ctx.scorecard
    policy = ctx.policy
    checks = ctx.checks
    require_rejected_signal_learning = requires_rejected_signal_outcome_learning(
        scorecard, policy
    )
    rejected_signal_labeled_count = nonnegative_int(
        scorecard.get("rejected_signal_outcome_labeled_count")
        or scorecard.get("rejected_signal_outcome_label_count")
        or scorecard.get("rejected_signal_outcome_labeled_event_count")
    )
    rejected_signal_pending_ratio = decimal_value(
        scorecard.get("rejected_signal_outcome_pending_ratio"), default="1"
    )
    rejected_signal_reason_coverage = decimal_value(
        scorecard.get("rejected_signal_reason_coverage")
        or scorecard.get("rejected_signal_outcome_reason_coverage")
    )
    rejected_signal_persistence_state = string_value(
        scorecard.get("rejected_signal_outcome_persistence_state")
        or scorecard.get("rejected_signal_persistence_state")
    ).lower()
    observed_counterfactual_fields = set(
        string_sequence(
            scorecard.get("rejected_signal_counterfactual_fields")
            or scorecard.get("rejected_signal_counterfactual_fields_present")
            or scorecard.get("rejected_signal_outcome_counterfactual_fields")
        )
    )
    if boolish(scorecard.get("rejected_signal_counterfactual_fields_present")):
        observed_counterfactual_fields.update(
            policy.required_rejected_signal_counterfactual_fields
        )
    required_counterfactual_fields = set(
        policy.required_rejected_signal_counterfactual_fields
    )
    checks.extend(
        (
            numeric_check(
                metric="rejected_signal_outcome_labeled_count",
                observed=Decimal(rejected_signal_labeled_count),
                operator="gte",
                threshold=Decimal(policy.min_rejected_signal_outcome_label_count)
                if require_rejected_signal_learning
                else Decimal("0"),
            ),
            numeric_check(
                metric="rejected_signal_outcome_pending_ratio",
                observed=rejected_signal_pending_ratio,
                operator="lte",
                threshold=policy.max_rejected_signal_outcome_pending_ratio
                if require_rejected_signal_learning
                else Decimal("1"),
            ),
            numeric_check(
                metric="rejected_signal_reason_coverage",
                observed=rejected_signal_reason_coverage,
                operator="gte",
                threshold=policy.min_rejected_signal_reason_coverage
                if require_rejected_signal_learning
                else Decimal("0"),
            ),
            {
                "metric": "rejected_signal_counterfactual_fields_present",
                "observed": sorted(observed_counterfactual_fields),
                "operator": "contains",
                "threshold": sorted(required_counterfactual_fields),
                "source_marker": "rejected_signal_outcome_calibration",
                "passed": required_counterfactual_fields.issubset(
                    observed_counterfactual_fields
                )
                if require_rejected_signal_learning
                else True,
            },
            {
                "metric": "rejected_signal_outcome_persistence_state",
                "observed": rejected_signal_persistence_state,
                "operator": "eq",
                "threshold": policy.required_rejected_signal_outcome_persistence_state,
                "source_marker": "rejected_signal_outcome_calibration",
                "passed": (
                    rejected_signal_persistence_state
                    == policy.required_rejected_signal_outcome_persistence_state
                )
                if require_rejected_signal_learning
                else True,
            },
        )
    )


def build_oracle_result(ctx: OracleEvaluationContext) -> dict[str, Any]:
    checks = ctx.checks
    policy = ctx.policy
    target_implied_notional_gate = ctx.target_implied_notional_gate
    blockers = [
        f"{item['metric']}_failed" for item in checks if not bool(item["passed"])
    ]
    return {
        "schema_version": PROFIT_TARGET_ORACLE_SCHEMA_VERSION,
        "policy": policy.to_payload(),
        "target_implied_notional_gate": target_implied_notional_gate,
        "target_implied_min_avg_filled_notional_per_day": target_implied_notional_gate[
            "target_implied_min_avg_filled_notional_per_day"
        ],
        "effective_min_avg_filled_notional_per_day": target_implied_notional_gate[
            "effective_min_avg_filled_notional_per_day"
        ],
        "observed_post_cost_expectancy_bps": target_implied_notional_gate[
            "observed_post_cost_expectancy_bps"
        ],
        "passed": not blockers,
        "checks": checks,
        "blockers": blockers,
    }
