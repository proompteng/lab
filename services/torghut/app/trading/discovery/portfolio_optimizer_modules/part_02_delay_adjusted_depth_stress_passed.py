# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Deterministic portfolio sleeve optimizer for autoresearch candidates."""

from __future__ import annotations

from decimal import Decimal, ROUND_CEILING
from typing import Any, Mapping, Sequence, cast

from app.trading.discovery.evidence_bundles import (
    CandidateEvidenceBundle,
    evidence_bundle_blockers,
    evidence_bundle_is_valid,
)
from app.trading.discovery.portfolio_candidates import (
    PORTFOLIO_CANDIDATE_SCHEMA_VERSION,
    PortfolioCandidateSpec,
    portfolio_candidate_id_for_payload,
)
from app.trading.discovery.objectives import deployable_lower_bound_net_pnl_per_day
from app.trading.discovery.profit_target_oracle import evaluate_profit_target_oracle
from app.trading.discovery.profit_target_oracle import ProfitTargetOraclePolicy
from app.trading.runtime_ledger import POST_COST_PNL_BASIS

# ruff: noqa: F401,F403,F405,F811,F821

from .part_01_statements_23 import *


def _delay_adjusted_depth_stress_passed(bundle: CandidateEvidenceBundle) -> bool:
    scorecard = _scorecard(bundle)
    return _boolish(
        scorecard.get("delay_adjusted_depth_stress_passed")
        or scorecard.get("delay_depth_stress_passed")
        or scorecard.get("latency_depth_stress_passed")
    )


def _delay_adjusted_depth_liquidity_evidence_present(
    bundle: CandidateEvidenceBundle,
) -> bool:
    scorecard = _scorecard(bundle)
    return _boolish(
        scorecard.get("delay_adjusted_depth_liquidity_evidence_present")
        or scorecard.get("delay_depth_liquidity_evidence_present")
        or scorecard.get("latency_depth_liquidity_evidence_present")
    )


def _delay_adjusted_depth_liquidity_missing_day_count(
    bundle: CandidateEvidenceBundle,
) -> int:
    scorecard = _scorecard(bundle)
    return int(
        _decimal(
            scorecard.get("delay_adjusted_depth_liquidity_missing_day_count")
            or scorecard.get("delay_depth_liquidity_missing_day_count")
            or scorecard.get("latency_depth_liquidity_missing_day_count")
        )
    )


def _delay_adjusted_depth_tail_coverage_passed(
    bundle: CandidateEvidenceBundle,
) -> bool:
    scorecard = _scorecard(bundle)
    return _boolish(
        scorecard.get("delay_adjusted_depth_tail_coverage_passed")
        or scorecard.get("delay_depth_tail_coverage_passed")
        or scorecard.get("latency_depth_tail_coverage_passed")
    )


def _fill_survival_evidence_present(bundle: CandidateEvidenceBundle) -> bool:
    scorecard = _scorecard(bundle)
    return _boolish(
        scorecard.get("delay_adjusted_depth_fill_survival_evidence_present")
        or scorecard.get("fill_survival_evidence_present")
    )


def _fill_survival_sample_count(bundle: CandidateEvidenceBundle) -> int:
    scorecard = _scorecard(bundle)
    return int(
        max(
            _decimal(scorecard.get("delay_adjusted_depth_fill_survival_sample_count")),
            _decimal(scorecard.get("fill_survival_sample_count")),
        )
    )


def _fill_survival_rate(bundle: CandidateEvidenceBundle) -> Decimal:
    scorecard = _scorecard(bundle)
    return max(
        _decimal(scorecard.get("delay_adjusted_depth_fill_survival_rate")),
        _decimal(scorecard.get("fill_survival_fill_rate")),
        _decimal(scorecard.get("fill_survival_rate")),
    )


def _queue_position_survival_evidence_present(
    bundle: CandidateEvidenceBundle,
) -> bool:
    scorecard = _scorecard(bundle)
    return _boolish(
        scorecard.get("queue_position_survival_fill_curve_evidence_present")
    )


def _queue_position_survival_sample_count(bundle: CandidateEvidenceBundle) -> int:
    return int(_decimal(_scorecard(bundle).get("queue_position_survival_sample_count")))


def _queue_position_survival_fill_rate(bundle: CandidateEvidenceBundle) -> Decimal:
    return _decimal(_scorecard(bundle).get("queue_position_survival_fill_rate"))


def _queue_position_survival_queue_ratio_p95(
    bundle: CandidateEvidenceBundle,
) -> Decimal:
    return _decimal(_scorecard(bundle).get("queue_position_survival_queue_ratio_p95"))


def _queue_ahead_depletion_evidence_present(bundle: CandidateEvidenceBundle) -> bool:
    scorecard = _scorecard(bundle)
    return _boolish(
        scorecard.get("queue_position_survival_queue_ahead_depletion_evidence_present")
        or scorecard.get("delay_adjusted_depth_queue_ahead_depletion_evidence_present")
        or scorecard.get("queue_ahead_depletion_evidence_present")
    )


def _queue_ahead_depletion_sample_count(bundle: CandidateEvidenceBundle) -> int:
    scorecard = _scorecard(bundle)
    return int(
        max(
            _decimal(
                scorecard.get(
                    "queue_position_survival_queue_ahead_depletion_sample_count"
                )
            ),
            _decimal(
                scorecard.get("delay_adjusted_depth_queue_ahead_depletion_sample_count")
            ),
            _decimal(scorecard.get("queue_ahead_depletion_sample_count")),
        )
    )


def _queue_position_survival_stress_net_per_day(
    bundle: CandidateEvidenceBundle,
) -> Decimal:
    scorecard = _scorecard(bundle)
    return _decimal(
        scorecard.get("post_cost_net_pnl_after_queue_position_survival_fill_stress")
        or scorecard.get("queue_position_survival_stress_net_pnl_per_day")
    )


def _delay_adjusted_depth_stress_artifact_ref(
    bundle: CandidateEvidenceBundle,
) -> str:
    scorecard = _scorecard(bundle)
    return _string(
        scorecard.get("delay_adjusted_depth_stress_artifact_ref")
        or scorecard.get("delay_depth_stress_artifact_ref")
        or scorecard.get("latency_depth_stress_artifact_ref")
    )


def _delay_adjusted_depth_stress_net_per_day(
    bundle: CandidateEvidenceBundle,
) -> Decimal:
    scorecard = _scorecard(bundle)
    return _decimal(
        scorecard.get("delay_adjusted_depth_stress_net_pnl_per_day")
        or scorecard.get("delay_depth_stress_net_pnl_per_day")
        or scorecard.get("latency_depth_stress_net_pnl_per_day")
    )


def _delay_adjusted_depth_stress_ms(bundle: CandidateEvidenceBundle) -> Decimal:
    scorecard = _scorecard(bundle)
    return _decimal(
        scorecard.get("delay_adjusted_depth_stress_ms")
        or scorecard.get("delay_depth_stress_delay_ms")
        or scorecard.get("latency_depth_stress_ms")
    )


def _delay_adjusted_depth_fillable_notional_per_day(
    bundle: CandidateEvidenceBundle,
) -> Decimal:
    scorecard = _scorecard(bundle)
    return _decimal(
        scorecard.get("delay_adjusted_depth_fillable_notional_per_day")
        or scorecard.get("delay_depth_stress_fillable_notional_per_day")
        or scorecard.get("latency_depth_fillable_notional_per_day")
    )


def _delay_adjusted_depth_worst_active_day_fillable_notional(
    bundle: CandidateEvidenceBundle,
) -> Decimal:
    scorecard = _scorecard(bundle)
    return _decimal(
        scorecard.get("delay_adjusted_depth_worst_active_day_fillable_notional")
        or scorecard.get("delay_depth_worst_active_day_fillable_notional")
        or scorecard.get("latency_depth_worst_active_day_fillable_notional")
    )


def _delay_adjusted_depth_p10_active_day_fillable_notional(
    bundle: CandidateEvidenceBundle,
) -> Decimal:
    scorecard = _scorecard(bundle)
    return _decimal(
        scorecard.get("delay_adjusted_depth_p10_active_day_fillable_notional")
        or scorecard.get("delay_depth_p10_active_day_fillable_notional")
        or scorecard.get("latency_depth_p10_active_day_fillable_notional")
    )


def _double_oos_fold_metrics(
    bundle: CandidateEvidenceBundle,
) -> tuple[Mapping[str, Any], ...]:
    folds: list[Mapping[str, Any]] = []
    for fold in bundle.fold_metrics:
        source = _string(fold.get("source")).lower()
        method = _string(
            fold.get("validation_type")
            or fold.get("method")
            or fold.get("fold_type")
            or fold.get("window_role")
            or fold.get("split")
        ).lower()
        if (
            source == "double_oos_walkforward_arxiv_2602_10785_2026"
            or "double_oos" in method
            or "double-out-of-sample" in method
            or "out_of_sample" in method
            or method == "holdout"
            or bool(fold.get("out_of_sample"))
        ):
            folds.append(fold)
    return tuple(folds)


def _fold_passed(fold: Mapping[str, Any]) -> bool:
    if "passed" in fold:
        return _boolish(fold.get("passed"))
    return _boolish(fold.get("status"))


def _double_oos_independent_window_count(bundle: CandidateEvidenceBundle) -> int:
    scorecard = _scorecard(bundle)
    explicit = _decimal(
        scorecard.get("double_oos_independent_window_count")
        or scorecard.get("double_oos_fold_count")
        or scorecard.get("oos_fold_count")
    )
    if explicit > 0:
        return int(explicit)
    folds = _double_oos_fold_metrics(bundle)
    if not folds:
        return 0
    window_ids = {
        _string(
            fold.get("window_id")
            or fold.get("fold_id")
            or fold.get("period")
            or fold.get("name")
        )
        for fold in folds
    }
    window_ids.discard("")
    return len(window_ids) if window_ids else len(folds)


def _double_oos_pass_rate(bundle: CandidateEvidenceBundle) -> Decimal:
    scorecard = _scorecard(bundle)
    explicit = _decimal(
        scorecard.get("double_oos_pass_rate")
        or scorecard.get("double_out_of_sample_pass_rate")
        or scorecard.get("walk_forward_oos_pass_rate"),
        default="-1",
    )
    if explicit >= 0:
        return explicit
    folds = _double_oos_fold_metrics(bundle)
    if not folds:
        return Decimal("0")
    passed = sum(1 for fold in folds if _fold_passed(fold))
    return Decimal(passed) / Decimal(len(folds))


def _double_oos_passed(bundle: CandidateEvidenceBundle) -> bool:
    scorecard = _scorecard(bundle)
    if any(
        key in scorecard
        for key in (
            "double_oos_passed",
            "double_out_of_sample_passed",
            "walk_forward_oos_passed",
        )
    ):
        return _boolish(
            scorecard.get("double_oos_passed")
            or scorecard.get("double_out_of_sample_passed")
            or scorecard.get("walk_forward_oos_passed")
        )
    folds = _double_oos_fold_metrics(bundle)
    return bool(folds) and all(_fold_passed(fold) for fold in folds)


def _double_oos_net_per_day(bundle: CandidateEvidenceBundle) -> Decimal:
    scorecard = _scorecard(bundle)
    explicit = _decimal(
        scorecard.get("double_oos_net_pnl_per_day")
        or scorecard.get("double_out_of_sample_net_pnl_per_day")
        or scorecard.get("walk_forward_oos_net_pnl_per_day"),
        default="-999999999",
    )
    if explicit != Decimal("-999999999"):
        return explicit
    folds = _double_oos_fold_metrics(bundle)
    fold_net = [
        _decimal(
            fold.get("net_pnl_per_day")
            or fold.get("post_cost_net_pnl_per_day")
            or fold.get("portfolio_post_cost_net_pnl_per_day")
        )
        for fold in folds
    ]
    return min(fold_net, default=Decimal("0"))


def _double_oos_cost_shock_net_per_day(bundle: CandidateEvidenceBundle) -> Decimal:
    scorecard = _scorecard(bundle)
    explicit = _decimal(
        scorecard.get("double_oos_cost_shock_net_pnl_per_day")
        or scorecard.get("double_oos_market_impact_stress_net_pnl_per_day")
        or scorecard.get("double_oos_cost_sensitivity_net_pnl_per_day"),
        default="-999999999",
    )
    if explicit != Decimal("-999999999"):
        return explicit
    folds = _double_oos_fold_metrics(bundle)
    fold_net = [
        _decimal(
            fold.get("cost_shock_net_pnl_per_day")
            or fold.get("market_impact_stress_net_pnl_per_day")
            or fold.get("cost_sensitivity_net_pnl_per_day")
        )
        for fold in folds
    ]
    return min(fold_net, default=Decimal("0"))


def _double_oos_artifact_ref(bundle: CandidateEvidenceBundle) -> str:
    scorecard = _scorecard(bundle)
    direct = _string(
        scorecard.get("double_oos_artifact_ref")
        or scorecard.get("double_oos_report_ref")
        or scorecard.get("walk_forward_oos_artifact_ref")
    )
    if direct:
        return direct
    raw_refs = scorecard.get("double_oos_artifact_refs")
    if isinstance(raw_refs, Sequence) and not isinstance(raw_refs, str):
        for item in cast(Sequence[Any], raw_refs):
            normalized = _string(item)
            if normalized:
                return normalized
    for fold in _double_oos_fold_metrics(bundle):
        normalized = _string(fold.get("artifact_ref") or fold.get("report_ref"))
        if normalized:
            return normalized
    return ""


def _positive_net_contribution(bundle: CandidateEvidenceBundle) -> Decimal:
    return max(_net_per_day(bundle), Decimal("0"))


def _cluster_id(bundle: CandidateEvidenceBundle) -> str:
    return (
        _string(_scorecard(bundle).get("correlation_cluster"))
        or bundle.candidate_spec_id
    )


def _contribution_shares(values: Mapping[str, Decimal]) -> dict[str, Decimal]:
    total = sum(values.values(), Decimal("0"))
    if total <= 0:
        return {}
    return {key: value / total for key, value in values.items()}


def _cluster_contribution_shares(
    selected: Sequence[CandidateEvidenceBundle],
    *,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> dict[str, Decimal]:
    weights = _portfolio_weights(selected, oracle_policy=oracle_policy)
    contributions: dict[str, Decimal] = {}
    for bundle, weight in zip(selected, weights, strict=True):
        cluster = _cluster_id(bundle)
        contributions[cluster] = contributions.get(cluster, Decimal("0")) + (
            _positive_net_contribution(bundle) * weight
        )
    return _contribution_shares(contributions)


def _bundle_symbol_shares(bundle: CandidateEvidenceBundle) -> dict[str, Decimal]:
    raw_symbol_shares = _scorecard(bundle).get("symbol_contribution_shares")
    if isinstance(raw_symbol_shares, Mapping):
        rows = cast(Mapping[Any, Any], raw_symbol_shares)
        shares = {
            _string(symbol).upper(): max(_decimal(value), Decimal("0"))
            for symbol, value in rows.items()
            if _string(symbol)
        }
        if shares:
            return _contribution_shares(shares)
    symbol = _string(_scorecard(bundle).get("symbol")).upper()
    if symbol:
        return {symbol: Decimal("1")}
    return {"UNKNOWN": Decimal("1")}


def _symbol_contribution_shares(
    selected: Sequence[CandidateEvidenceBundle],
    *,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> dict[str, Decimal]:
    weights = _portfolio_weights(selected, oracle_policy=oracle_policy)
    contributions: dict[str, Decimal] = {}
    for bundle, weight in zip(selected, weights, strict=True):
        bundle_positive_net = _positive_net_contribution(bundle) * weight
        for symbol, share in _bundle_symbol_shares(bundle).items():
            contributions[symbol] = contributions.get(symbol, Decimal("0")) + (
                bundle_positive_net * share
            )
    return _contribution_shares(contributions)


def _max_pairwise_correlation(
    bundle: CandidateEvidenceBundle,
    selected: Sequence[CandidateEvidenceBundle],
) -> Decimal:
    if not selected:
        return Decimal("0")
    candidate_daily = _daily_net(bundle)
    return max(
        (_correlation(candidate_daily, _daily_net(item)) for item in selected),
        default=Decimal("0"),
    )


def _max_share(shares: Mapping[str, Decimal]) -> Decimal:
    return max(shares.values(), default=Decimal("0"))


def _max_drawdown_from_daily(daily_net: Mapping[str, Decimal]) -> Decimal:
    peak = Decimal("0")
    cumulative = Decimal("0")
    drawdown = Decimal("0")
    for day in sorted(daily_net):
        cumulative += daily_net[day]
        peak = max(peak, cumulative)
        drawdown = max(drawdown, peak - cumulative)
    return drawdown


def _equal_weights(selected: Sequence[CandidateEvidenceBundle]) -> tuple[Decimal, ...]:
    if not selected:
        return ()
    weight = Decimal("1") / Decimal(len(selected))
    return tuple(weight for _ in selected)


def _gross_exposure_allocation_edge_net_per_day(
    bundle: CandidateEvidenceBundle,
) -> Decimal:
    scorecard = _scorecard(bundle)
    lower_bound = deployable_lower_bound_net_pnl_per_day(scorecard)
    edge_candidates: list[Decimal] = [
        _net_per_day(bundle),
    ]
    if lower_bound is not None:
        edge_candidates.append(lower_bound)
    for key in (
        "market_impact_stress_net_pnl_per_day",
        "delay_adjusted_depth_stress_net_pnl_per_day",
        "delay_adjusted_depth_net_pnl_per_day",
        "implementation_uncertainty_lower_net_pnl_per_day",
        "double_oos_cost_shock_net_pnl_per_day",
        "double_oos_net_pnl_per_day",
        "conformal_tail_risk_adjusted_net_pnl_per_day",
    ):
        if key in scorecard:
            edge_candidates.append(_decimal(scorecard.get(key)))
    return min(edge_candidates, default=Decimal("0"))


def _gross_exposure_allocation_priority(bundle: CandidateEvidenceBundle) -> Decimal:
    edge = _gross_exposure_allocation_edge_net_per_day(bundle)
    if edge <= 0:
        return Decimal("0")
    downside_risk = max(
        _worst_day_loss(bundle),
        _max_drawdown(bundle),
        Decimal("1"),
    )
    concentration_penalty = Decimal("1") + max(
        _best_day_share(bundle),
        Decimal("0"),
    )
    quality = max(_active_ratio(bundle), Decimal("0")) * max(
        _positive_ratio(bundle),
        Decimal("0"),
    )
    if quality <= 0:
        return Decimal("0")
    return (edge * quality) / (downside_risk * concentration_penalty)


def _edge_risk_gross_exposure_budget_weights(
    exposures: Sequence[Decimal],
    priorities: Sequence[Decimal],
    *,
    max_gross_exposure_pct_equity: Decimal,
    equal_scale: Decimal,
) -> tuple[Decimal, ...] | None:
    positive_priorities = tuple(max(priority, Decimal("0")) for priority in priorities)
    if (
        not positive_priorities
        or sum(positive_priorities, Decimal("0")) <= 0
        or max(positive_priorities) == min(positive_priorities)
    ):
        return None

    weights = [equal_scale * Decimal("0.50") for _ in exposures]
    used_exposure = sum(
        exposure * weight for exposure, weight in zip(exposures, weights, strict=True)
    )
    remaining_exposure = max_gross_exposure_pct_equity - used_exposure
    active_indexes = {
        index
        for index, (exposure, weight, priority) in enumerate(
            zip(exposures, weights, positive_priorities, strict=True)
        )
        if exposure > 0 and weight < Decimal("1") and priority > 0
    }

    while remaining_exposure > 0 and active_indexes:
        total_priority = sum(
            (positive_priorities[index] for index in active_indexes),
            Decimal("0"),
        )
        used_this_round = Decimal("0")
        saturated_indexes: set[int] = set()
        for index in sorted(active_indexes):
            desired_additional_exposure = (
                remaining_exposure * positive_priorities[index] / total_priority
            )
            max_additional_exposure = exposures[index] * (Decimal("1") - weights[index])
            additional_exposure = min(
                desired_additional_exposure,
                max_additional_exposure,
            )
            weights[index] += additional_exposure / exposures[index]
            used_this_round += additional_exposure
            if weights[index] >= Decimal("1"):
                weights[index] = Decimal("1")
                saturated_indexes.add(index)
        remaining_exposure -= used_this_round
        active_indexes.difference_update(saturated_indexes)

    if tuple(weights) == tuple(equal_scale for _ in exposures):
        return None
    return tuple(weights)


def _gross_exposure_budget_weights(
    selected: Sequence[CandidateEvidenceBundle],
    *,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> tuple[Decimal, ...] | None:
    policy = oracle_policy or ProfitTargetOraclePolicy()
    exposures = tuple(_max_gross_exposure_pct_equity(bundle) for bundle in selected)
    if not exposures or any(exposure <= 0 for exposure in exposures):
        return None
    total_exposure = sum(exposures, Decimal("0"))
    if total_exposure <= 0:
        return None
    scale = min(
        Decimal("1"),
        policy.max_gross_exposure_pct_equity / total_exposure,
    )
    if scale < Decimal("1"):
        edge_risk_weights = _edge_risk_gross_exposure_budget_weights(
            exposures,
            tuple(_gross_exposure_allocation_priority(bundle) for bundle in selected),
            max_gross_exposure_pct_equity=policy.max_gross_exposure_pct_equity,
            equal_scale=scale,
        )
        if edge_risk_weights is not None:
            return edge_risk_weights
    return tuple(scale for _ in selected)


def _portfolio_weights(
    selected: Sequence[CandidateEvidenceBundle],
    *,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> tuple[Decimal, ...]:
    gross_budget_weights = _gross_exposure_budget_weights(
        selected, oracle_policy=oracle_policy
    )
    if gross_budget_weights is not None:
        return gross_budget_weights
    return _equal_weights(selected)


def _portfolio_weighting_mode(
    selected: Sequence[CandidateEvidenceBundle],
    *,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> str:
    weights = _gross_exposure_budget_weights(selected, oracle_policy=oracle_policy)
    if weights is not None:
        policy = oracle_policy or ProfitTargetOraclePolicy()
        exposures = tuple(_max_gross_exposure_pct_equity(bundle) for bundle in selected)
        if exposures and all(exposure > 0 for exposure in exposures):
            total_exposure = sum(exposures, Decimal("0"))
            if total_exposure > policy.max_gross_exposure_pct_equity:
                equal_scale = policy.max_gross_exposure_pct_equity / total_exposure
                if weights != tuple(equal_scale for _ in selected):
                    return PORTFOLIO_WEIGHTING_EDGE_RISK_GROSS_EXPOSURE_BUDGET
        return PORTFOLIO_WEIGHTING_GROSS_EXPOSURE_BUDGET
    return PORTFOLIO_WEIGHTING_EQUAL_COUNT


def _portfolio_max_gross_exposure_pct_equity(
    selected: Sequence[CandidateEvidenceBundle],
    *,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> Decimal:
    weights = _portfolio_weights(selected, oracle_policy=oracle_policy)
    return sum(
        (
            _max_gross_exposure_pct_equity(bundle) * weight
            for bundle, weight in zip(selected, weights, strict=True)
        ),
        Decimal("0"),
    )


def _portfolio_min_cash(
    selected: Sequence[CandidateEvidenceBundle],
    *,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> Decimal:
    weights = _portfolio_weights(selected, oracle_policy=oracle_policy)
    return sum(
        (
            _min_cash(bundle) * weight
            for bundle, weight in zip(selected, weights, strict=True)
        ),
        Decimal("0"),
    )


def _portfolio_negative_cash_observation_count(
    selected: Sequence[CandidateEvidenceBundle],
) -> int:
    return sum(_negative_cash_observation_count(bundle) for bundle in selected)


def _missing_sleeve_daily_net_count(
    selected: Sequence[CandidateEvidenceBundle],
    daily_net: Mapping[str, Decimal],
) -> int:
    if not selected:
        return 0
    portfolio_days = set(daily_net)
    missing = 0
    for bundle in selected:
        bundle_daily = _daily_net(bundle)
        expected_count = max(_trading_day_count(bundle), len(portfolio_days))
        missing += len(portfolio_days.difference(bundle_daily))
        missing += max(0, expected_count - len(portfolio_days))
    return missing


__all__ = [name for name in globals() if not name.startswith("__")]
