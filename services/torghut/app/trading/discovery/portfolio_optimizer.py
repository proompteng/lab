"""Deterministic portfolio sleeve optimizer for autoresearch candidates."""

from __future__ import annotations

from decimal import Decimal
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
from app.trading.discovery.profit_target_oracle import evaluate_profit_target_oracle
from app.trading.discovery.profit_target_oracle import ProfitTargetOraclePolicy

MAX_CLUSTER_CONTRIBUTION_SHARE = Decimal("0.40")
MAX_SINGLE_SYMBOL_CONTRIBUTION_SHARE = Decimal("0.35")
MAX_ALLOWED_PAIRWISE_CORRELATION = Decimal("0.85")


def _decimal(value: Any, *, default: str = "0") -> Decimal:
    try:
        return Decimal(str(value if value is not None else default))
    except Exception:
        return Decimal(default)


def _string(value: Any) -> str:
    return str(value or "").strip()


def _scorecard(bundle: CandidateEvidenceBundle) -> Mapping[str, Any]:
    return bundle.objective_scorecard


def _net_per_day(bundle: CandidateEvidenceBundle) -> Decimal:
    return _decimal(_scorecard(bundle).get("net_pnl_per_day"))


def _active_ratio(bundle: CandidateEvidenceBundle) -> Decimal:
    return _decimal(_scorecard(bundle).get("active_day_ratio"))


def _positive_ratio(bundle: CandidateEvidenceBundle) -> Decimal:
    return _decimal(_scorecard(bundle).get("positive_day_ratio"))


def _best_day_share(bundle: CandidateEvidenceBundle) -> Decimal:
    return _decimal(_scorecard(bundle).get("best_day_share"))


def _max_drawdown(bundle: CandidateEvidenceBundle) -> Decimal:
    return _decimal(_scorecard(bundle).get("max_drawdown"))


def _worst_day_loss(bundle: CandidateEvidenceBundle) -> Decimal:
    return _decimal(_scorecard(bundle).get("worst_day_loss"))


def _candidate_passes_minimums(bundle: CandidateEvidenceBundle) -> bool:
    if not evidence_bundle_is_valid(bundle):
        return False
    if bool(bundle.promotion_readiness.get("promotable")):
        return True
    blockers = cast(Sequence[Any], bundle.promotion_readiness.get("blockers") or [])
    blocking = {str(item) for item in blockers}
    allowed_blockers = {"scheduler_v3_parity_missing", "shadow_validation_missing"}
    if blocking - allowed_blockers:
        return False
    return _net_per_day(bundle) > 0 and _active_ratio(bundle) >= Decimal("0.50")


def _daily_net(bundle: CandidateEvidenceBundle) -> dict[str, Decimal]:
    raw_daily = _scorecard(bundle).get("daily_net")
    if isinstance(raw_daily, Mapping):
        daily_mapping = cast(Mapping[Any, Any], raw_daily)
        return {str(day): _decimal(value) for day, value in daily_mapping.items()}
    return {"synthetic": _net_per_day(bundle)}


def _daily_filled_notional(bundle: CandidateEvidenceBundle) -> dict[str, Decimal]:
    raw_daily = _scorecard(bundle).get("daily_filled_notional")
    if isinstance(raw_daily, Mapping):
        daily_mapping = cast(Mapping[Any, Any], raw_daily)
        return {str(day): _decimal(value) for day, value in daily_mapping.items()}
    notional = _decimal(_scorecard(bundle).get("avg_filled_notional_per_day"))
    return {"synthetic": notional} if notional > 0 else {}


def _mean(values: Sequence[Decimal]) -> Decimal:
    if not values:
        return Decimal("0")
    return sum(values, Decimal("0")) / Decimal(len(values))


def _correlation(left: Mapping[str, Decimal], right: Mapping[str, Decimal]) -> Decimal:
    common_days = sorted(set(left) & set(right))
    if len(common_days) < 2:
        return Decimal("0")
    left_values = [left[day] for day in common_days]
    right_values = [right[day] for day in common_days]
    left_mean = _mean(left_values)
    right_mean = _mean(right_values)
    numerator: Decimal = sum(
        (
            (left_value - left_mean) * (right_value - right_mean)
            for left_value, right_value in zip(left_values, right_values, strict=True)
        ),
        Decimal("0"),
    )
    left_var: Decimal = sum(
        ((value - left_mean) ** 2 for value in left_values), Decimal("0")
    )
    right_var: Decimal = sum(
        ((value - right_mean) ** 2 for value in right_values), Decimal("0")
    )
    if left_var <= 0 or right_var <= 0:
        return Decimal("0")
    return numerator / (left_var.sqrt() * right_var.sqrt())


def _portfolio_daily_net(
    selected: Sequence[CandidateEvidenceBundle],
) -> dict[str, Decimal]:
    daily_totals: dict[str, Decimal] = {}
    for bundle in selected:
        for day, value in _daily_net(bundle).items():
            daily_totals[day] = daily_totals.get(day, Decimal("0")) + value
    return daily_totals


def _portfolio_daily_filled_notional(
    selected: Sequence[CandidateEvidenceBundle],
) -> dict[str, Decimal]:
    daily_totals: dict[str, Decimal] = {}
    for bundle in selected:
        for day, value in _daily_filled_notional(bundle).items():
            daily_totals[day] = daily_totals.get(day, Decimal("0")) + value
    return daily_totals


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
) -> dict[str, Decimal]:
    contributions: dict[str, Decimal] = {}
    for bundle in selected:
        cluster = _cluster_id(bundle)
        contributions[cluster] = contributions.get(
            cluster, Decimal("0")
        ) + _positive_net_contribution(bundle)
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
) -> dict[str, Decimal]:
    contributions: dict[str, Decimal] = {}
    for bundle in selected:
        bundle_positive_net = _positive_net_contribution(bundle)
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


def _portfolio_scorecard(
    *,
    selected: Sequence[CandidateEvidenceBundle],
    target_net_pnl_per_day: Decimal,
    oracle_policy: ProfitTargetOraclePolicy,
) -> dict[str, Any]:
    daily_net = _portfolio_daily_net(selected)
    values = [daily_net[day] for day in sorted(daily_net)]
    net_per_day = _mean(values)
    active_day_ratio = (
        Decimal(sum(1 for value in values if value != 0)) / Decimal(len(values))
        if values
        else Decimal("0")
    )
    positive_day_ratio = (
        Decimal(sum(1 for value in values if value > 0)) / Decimal(len(values))
        if values
        else Decimal("0")
    )
    positive_total = sum((value for value in values if value > 0), Decimal("0"))
    best_day_share = (
        max(values, default=Decimal("0")) / positive_total
        if positive_total > 0
        else Decimal("0")
    )
    cluster_shares = _cluster_contribution_shares(selected)
    symbol_shares = _symbol_contribution_shares(selected)
    min_day = min(values, default=Decimal("0"))
    worst_day_loss = abs(min_day) if min_day < 0 else Decimal("0")
    daily_notional = _portfolio_daily_filled_notional(selected)
    notional_values = [daily_notional[day] for day in sorted(daily_notional)]
    regime_pass_rates = [
        _decimal(_scorecard(bundle).get("regime_slice_pass_rate"))
        for bundle in selected
    ]
    posterior_lowers = [
        _decimal(_scorecard(bundle).get("posterior_edge_lower")) for bundle in selected
    ]
    shadow_statuses = {
        _string(_scorecard(bundle).get("shadow_parity_status")) for bundle in selected
    }
    scorecard = {
        "net_pnl_per_day": str(net_per_day),
        "portfolio_post_cost_net_pnl_per_day": str(net_per_day),
        "target_net_pnl_per_day": str(target_net_pnl_per_day),
        "target_met": net_per_day >= target_net_pnl_per_day,
        "active_day_ratio": str(active_day_ratio),
        "positive_day_ratio": str(positive_day_ratio),
        "worst_day_loss": str(worst_day_loss),
        "max_drawdown": str(_max_drawdown_from_daily(daily_net)),
        "best_day_share": str(best_day_share),
        "max_single_day_contribution_share": str(best_day_share),
        "cluster_contribution_shares": {
            cluster: str(share) for cluster, share in sorted(cluster_shares.items())
        },
        "max_cluster_contribution_share": str(_max_share(cluster_shares)),
        "symbol_contribution_shares": {
            symbol: str(share) for symbol, share in sorted(symbol_shares.items())
        },
        "max_single_symbol_contribution_share": str(_max_share(symbol_shares)),
        "avg_filled_notional_per_day": str(_mean(notional_values)),
        "regime_slice_pass_rate": str(_mean(regime_pass_rates)),
        "posterior_edge_lower": str(min(posterior_lowers, default=Decimal("0"))),
        "shadow_parity_status": "within_budget"
        if shadow_statuses == {"within_budget"}
        else "missing",
        "daily_net": {day: str(value) for day, value in sorted(daily_net.items())},
        "daily_filled_notional": {
            day: str(value) for day, value in sorted(daily_notional.items())
        },
    }
    scorecard["profit_target_oracle"] = evaluate_profit_target_oracle(
        scorecard,
        target_net_pnl_per_day=target_net_pnl_per_day,
        policy=oracle_policy,
    )
    scorecard["oracle_passed"] = bool(scorecard["profit_target_oracle"]["passed"])
    return scorecard


def _sleeve_score(bundle: CandidateEvidenceBundle) -> Decimal:
    return (
        _net_per_day(bundle)
        + (_active_ratio(bundle) * Decimal("300"))
        + (_positive_ratio(bundle) * Decimal("150"))
        - (_worst_day_loss(bundle) * Decimal("0.50"))
        - (_max_drawdown(bundle) * Decimal("0.10"))
        - (_best_day_share(bundle) * Decimal("500"))
    )


def _portfolio_candidate_id(
    source_candidate_ids: Sequence[str], target: Decimal
) -> str:
    return portfolio_candidate_id_for_payload(
        {"source_candidate_ids": list(source_candidate_ids), "target": str(target)}
    )


def optimize_portfolio_candidate(
    *,
    evidence_bundles: Sequence[CandidateEvidenceBundle],
    target_net_pnl_per_day: Decimal = Decimal("500"),
    oracle_policy: ProfitTargetOraclePolicy | None = None,
    portfolio_size_min: int = 2,
    portfolio_size_max: int = 8,
) -> PortfolioCandidateSpec | None:
    oracle_policy = oracle_policy or ProfitTargetOraclePolicy()
    invalid_evidence_rejections = [
        {
            "candidate_id": bundle.candidate_id,
            "reason": "invalid_evidence_bundle",
            "blockers": list(evidence_bundle_blockers(bundle)),
        }
        for bundle in evidence_bundles
        if not evidence_bundle_is_valid(bundle)
    ]
    eligible = [
        bundle for bundle in evidence_bundles if _candidate_passes_minimums(bundle)
    ]
    ordered = sorted(
        eligible,
        key=lambda item: (_sleeve_score(item), _net_per_day(item), item.candidate_id),
        reverse=True,
    )
    selected: list[CandidateEvidenceBundle] = []
    selected_clusters: set[str] = set()
    rejected: list[dict[str, Any]] = list(invalid_evidence_rejections)
    max_allowed_correlation = MAX_ALLOWED_PAIRWISE_CORRELATION
    for bundle in ordered:
        cluster = _cluster_id(bundle)
        if cluster in selected_clusters and len(selected) >= portfolio_size_min:
            rejected.append(
                {
                    "candidate_id": bundle.candidate_id,
                    "reason": "cluster_cap",
                    "cluster": cluster,
                }
            )
            continue
        max_correlation = _max_pairwise_correlation(bundle, selected)
        if (
            max_correlation > max_allowed_correlation
            and len(selected) >= portfolio_size_min
        ):
            rejected.append(
                {
                    "candidate_id": bundle.candidate_id,
                    "reason": "correlation_cap",
                    "max_pairwise_correlation": str(max_correlation),
                }
            )
            continue
        selected.append(bundle)
        selected_clusters.add(cluster)
        if len(selected) >= max(1, portfolio_size_max):
            break
        if len(selected) >= portfolio_size_min:
            candidate_scorecard = _portfolio_scorecard(
                selected=selected,
                target_net_pnl_per_day=target_net_pnl_per_day,
                oracle_policy=oracle_policy,
            )
            if bool(candidate_scorecard.get("oracle_passed")):
                break
    if not selected:
        return None

    source_candidate_ids = tuple(item.candidate_id for item in selected)
    objective_scorecard = _portfolio_scorecard(
        selected=selected,
        target_net_pnl_per_day=target_net_pnl_per_day,
        oracle_policy=oracle_policy,
    )
    max_drawdown = _decimal(objective_scorecard.get("max_drawdown"))
    sleeves: list[Mapping[str, Any]] = []
    equal_weight = Decimal("1") / Decimal(len(selected))
    for sleeve_index, bundle in enumerate(selected, start=1):
        base_runtime_strategy_name = (
            _string(_scorecard(bundle).get("runtime_strategy_name"))
            or f"whitepaper-autoresearch-sleeve-{sleeve_index}"
        )
        sleeves.append(
            {
                "candidate_id": bundle.candidate_id,
                "candidate_spec_id": bundle.candidate_spec_id,
                "family_template_id": _string(
                    _scorecard(bundle).get("family_template_id")
                ),
                "runtime_family": _string(_scorecard(bundle).get("runtime_family")),
                "runtime_strategy_name": f"{base_runtime_strategy_name}-sleeve-{sleeve_index}",
                "weight": str(equal_weight),
                "expected_net_pnl_per_day": str(_net_per_day(bundle)),
                "risk_contribution": str(_max_drawdown(bundle)),
                "correlation_cluster": _string(
                    _scorecard(bundle).get("correlation_cluster")
                )
                or bundle.candidate_spec_id,
                "daily_net": {
                    day: str(value) for day, value in sorted(_daily_net(bundle).items())
                },
                "promotion_status": bundle.promotion_readiness.get("status"),
            }
        )
    pairwise_correlations = [
        {
            "left_candidate_id": left.candidate_id,
            "right_candidate_id": right.candidate_id,
            "correlation": str(_correlation(_daily_net(left), _daily_net(right))),
        }
        for left_index, left in enumerate(selected)
        for right in selected[left_index + 1 :]
    ]
    optimizer_report = {
        "eligible_count": len(eligible),
        "selected_count": len(selected),
        "rejected_count": max(0, len(evidence_bundles) - len(selected)),
        "rejections": rejected,
        "pairwise_correlations": pairwise_correlations,
        "cluster_contribution_shares": objective_scorecard.get(
            "cluster_contribution_shares", {}
        ),
        "symbol_contribution_shares": objective_scorecard.get(
            "symbol_contribution_shares", {}
        ),
        "max_cluster_contribution_share": objective_scorecard.get(
            "max_cluster_contribution_share"
        ),
        "max_single_day_contribution_share": objective_scorecard.get(
            "max_single_day_contribution_share"
        ),
        "max_single_symbol_contribution_share": objective_scorecard.get(
            "max_single_symbol_contribution_share"
        ),
        "method": "deterministic_greedy_pareto_v1",
        "target_met": bool(objective_scorecard["target_met"]),
        "oracle_passed": bool(objective_scorecard["oracle_passed"]),
    }
    return PortfolioCandidateSpec(
        schema_version=PORTFOLIO_CANDIDATE_SCHEMA_VERSION,
        portfolio_candidate_id=_portfolio_candidate_id(
            source_candidate_ids, target_net_pnl_per_day
        ),
        source_candidate_ids=source_candidate_ids,
        target_net_pnl_per_day=target_net_pnl_per_day,
        sleeves=tuple(sleeves),
        capital_budget={
            "mode": "equal_weight_initial",
            "max_sleeves": portfolio_size_max,
        },
        correlation_budget={
            "mode": "cluster_cap",
            "selected_cluster_count": len(selected_clusters),
            "max_allowed_pairwise_correlation": str(max_allowed_correlation),
            "max_cluster_contribution_share": objective_scorecard.get(
                "max_cluster_contribution_share"
            ),
            "max_single_symbol_contribution_share": objective_scorecard.get(
                "max_single_symbol_contribution_share"
            ),
            "cluster_contribution_shares": objective_scorecard.get(
                "cluster_contribution_shares", {}
            ),
            "symbol_contribution_shares": objective_scorecard.get(
                "symbol_contribution_shares", {}
            ),
        },
        drawdown_budget={"max_drawdown": str(max_drawdown)},
        evidence_refs=tuple(item.evidence_bundle_id for item in selected),
        objective_scorecard=objective_scorecard,
        optimizer_report=optimizer_report,
    )
