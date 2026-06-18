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


MAX_ALLOWED_PAIRWISE_CORRELATION = Decimal("0.85")

CONFORMAL_TAIL_RISK_ALPHA = Decimal("0.20")

PORTFOLIO_SEARCH_BEAM_WIDTH = 256

PORTFOLIO_WEIGHTING_EQUAL_COUNT = "equal_count"

PORTFOLIO_WEIGHTING_GROSS_EXPOSURE_BUDGET = "gross_exposure_budget"

PORTFOLIO_WEIGHTING_EDGE_RISK_GROSS_EXPOSURE_BUDGET = "edge_risk_gross_exposure_budget"

PORTFOLIO_RUNTIME_LEDGER_PNL_SOURCE = "exact_replay_runtime_ledger"

ACCEPTED_LEDGER_PNL_SOURCES = frozenset(
    {
        "exact_replay_ledger",
        "exact_replay_runtime_ledger",
        "runtime_execution_ledger",
        "runtime_ledger",
        "strategy_runtime_ledger",
        "strategy_runtime_ledger_bucket",
        "strategy_runtime_ledger_buckets",
    }
)

PORTFOLIO_COMPOSABLE_SINGLE_SLEEVE_VETOES = frozenset(
    {
        "active_day_ratio_below_min",
        "active_day_ratio_below_oracle",
        "avg_daily_notional_below_min",
        "avg_filled_notional_per_day_below_oracle",
        "best_day_share_above_max",
        "best_day_share_above_oracle",
        "conformal_tail_risk_below_target",
        "daily_net_below_min",
        "max_drawdown_above_max",
        "max_drawdown_above_oracle",
        "positive_day_ratio_below_oracle",
        "train_active_ratio_below_screen",
        "train_net_per_day_below_screen",
        "train_worst_day_loss_above_screen",
        "worst_day_loss_above_max",
        "worst_day_loss_above_oracle",
    }
)


def decimal(value: Any, *, default: str = "0") -> Decimal:
    try:
        return Decimal(str(value if value is not None else default))
    except Exception:
        return Decimal(default)


def string(value: Any) -> str:
    return str(value or "").strip()


def mapping(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): item for key, item in cast(Mapping[Any, Any], value).items()}


def boolish(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return string(value).lower() in {"1", "true", "yes", "y", "passed"}


def scorecard(bundle: CandidateEvidenceBundle) -> Mapping[str, Any]:
    return bundle.objective_scorecard


def scorecard_runtime_params(bundle: CandidateEvidenceBundle) -> Mapping[str, Any]:
    return mapping(scorecard(bundle).get("runtime_params"))


def scorecard_universe_symbols(bundle: CandidateEvidenceBundle) -> list[str]:
    raw_symbols = scorecard(bundle).get("universe_symbols")
    if not isinstance(raw_symbols, Sequence) or isinstance(raw_symbols, str):
        return []
    return [
        symbol
        for symbol in (
            string(item).upper() for item in cast(Sequence[Any], raw_symbols)
        )
        if symbol
    ]


def scorecard_primary_symbol(bundle: CandidateEvidenceBundle) -> str:
    raw_symbol_shares = scorecard(bundle).get("symbol_contribution_shares")
    if isinstance(raw_symbol_shares, Mapping):
        rows = cast(Mapping[Any, Any], raw_symbol_shares)
        symbols = [
            (string(symbol).upper(), decimal(share))
            for symbol, share in rows.items()
            if string(symbol)
        ]
        if symbols:
            symbols.sort(key=lambda item: (item[1], item[0]), reverse=True)
            return symbols[0][0]
    symbol = string(scorecard(bundle).get("symbol")).upper()
    if symbol:
        return symbol
    universe_symbols = scorecard_universe_symbols(bundle)
    if universe_symbols:
        return universe_symbols[0]
    return "UNKNOWN"


def _diversification_sleeve_score(bundle: CandidateEvidenceBundle) -> Decimal:
    scorecard_payload = scorecard(bundle)
    deployable_lower_bound = deployable_lower_bound_net_pnl_per_day(scorecard_payload)
    return (
        (
            deployable_lower_bound
            if deployable_lower_bound is not None
            else net_per_day(bundle)
        )
        + (active_ratio(bundle) * Decimal("300"))
        + (positive_ratio(bundle) * Decimal("150"))
        - (worst_day_loss(bundle) * Decimal("0.50"))
        - (max_drawdown(bundle) * Decimal("0.10"))
        - (best_day_share(bundle) * Decimal("300"))
    )


def diversified_candidate_order(
    candidates: Sequence[CandidateEvidenceBundle],
) -> list[CandidateEvidenceBundle]:
    """Interleave sleeves by primary symbol before the bounded beam search.

    Autoresearch proposal scores can produce a long prefix of high raw-PnL sleeves
    from a single symbol or concentration cluster. The optimizer's beam is bounded,
    so that prefix can evict the empty/partial states before lower-scoring but
    diversifying sleeves are ever considered. Interleaving preserves each symbol's
    internal quality order while ensuring risk-diversifying sleeves enter the beam
    early enough to prove (or disprove) an oracle-passing portfolio.
    """

    buckets: dict[str, list[CandidateEvidenceBundle]] = {}
    for candidate in candidates:
        buckets.setdefault(scorecard_primary_symbol(candidate), []).append(candidate)
    ordered_buckets = sorted(
        buckets.values(),
        key=lambda bucket: (
            _diversification_sleeve_score(bucket[0]),
            net_per_day(bucket[0]),
            bucket[0].candidate_id,
        ),
        reverse=True,
    )
    diversified: list[CandidateEvidenceBundle] = []
    while ordered_buckets:
        next_buckets: list[list[CandidateEvidenceBundle]] = []
        for bucket in ordered_buckets:
            diversified.append(bucket.pop(0))
            if bucket:
                next_buckets.append(bucket)
        ordered_buckets = sorted(
            next_buckets,
            key=lambda bucket: (
                _diversification_sleeve_score(bucket[0]),
                net_per_day(bucket[0]),
                bucket[0].candidate_id,
            ),
            reverse=True,
        )
    return diversified


def scorecard_sleeve_runtime_limits(bundle: CandidateEvidenceBundle) -> dict[str, str]:
    limits: dict[str, str] = {}
    scorecard_payload = scorecard(bundle)
    for key in ("max_notional_per_trade", "max_position_pct_equity"):
        value = string(scorecard_payload.get(key))
        if value:
            limits[key] = value
    return limits


def scorecard_signal(bundle: CandidateEvidenceBundle) -> str:
    params = scorecard_runtime_params(bundle)
    signal = string(params.get("signal_motif"))
    if signal:
        return signal
    signal_key = string(scorecard(bundle).get("signal_key"))
    return signal_key.split("|", 1)[0] if signal_key else ""


def net_per_day(bundle: CandidateEvidenceBundle) -> Decimal:
    return decimal(scorecard(bundle).get("net_pnl_per_day"))


def active_ratio(bundle: CandidateEvidenceBundle) -> Decimal:
    return decimal(scorecard(bundle).get("active_day_ratio"))


def positive_ratio(bundle: CandidateEvidenceBundle) -> Decimal:
    return decimal(scorecard(bundle).get("positive_day_ratio"))


def best_day_share(bundle: CandidateEvidenceBundle) -> Decimal:
    return decimal(scorecard(bundle).get("best_day_share"))


def max_drawdown(bundle: CandidateEvidenceBundle) -> Decimal:
    return decimal(scorecard(bundle).get("max_drawdown"))


def worst_day_loss(bundle: CandidateEvidenceBundle) -> Decimal:
    return decimal(scorecard(bundle).get("worst_day_loss"))


def max_gross_exposure_pct_equity(bundle: CandidateEvidenceBundle) -> Decimal:
    return decimal(scorecard(bundle).get("max_gross_exposure_pct_equity"))


def min_cash(bundle: CandidateEvidenceBundle) -> Decimal:
    return decimal(scorecard(bundle).get("min_cash"))


def negative_cash_observation_count(bundle: CandidateEvidenceBundle) -> int:
    try:
        return max(
            0,
            int(decimal(scorecard(bundle).get("negative_cash_observation_count"))),
        )
    except Exception:
        return 0


def hard_vetoes(bundle: CandidateEvidenceBundle) -> tuple[str, ...]:
    raw_hard_vetoes = scorecard(bundle).get("hard_vetoes")
    if isinstance(raw_hard_vetoes, str):
        return (raw_hard_vetoes,) if raw_hard_vetoes.strip() else ()
    if not isinstance(raw_hard_vetoes, Sequence):
        return ()
    vetoes: list[str] = []
    for raw_value in cast(Sequence[object], raw_hard_vetoes):
        veto = string(raw_value)
        if veto:
            vetoes.append(veto)
    return tuple(vetoes)


def non_composable_hard_vetoes(bundle: CandidateEvidenceBundle) -> tuple[str, ...]:
    return tuple(
        veto
        for veto in hard_vetoes(bundle)
        if veto not in PORTFOLIO_COMPOSABLE_SINGLE_SLEEVE_VETOES
    )


def capital_safety_rejection(
    bundle: CandidateEvidenceBundle,
    *,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> dict[str, Any] | None:
    policy = oracle_policy or ProfitTargetOraclePolicy()
    max_gross = max_gross_exposure_pct_equity(bundle)
    minimum_cash = min_cash(bundle)
    negative_cash_observations = negative_cash_observation_count(bundle)
    if max_gross > policy.max_gross_exposure_pct_equity:
        return {
            "candidate_id": bundle.candidate_id,
            "reason": "frontier_capital_violation",
            "max_gross_exposure_pct_equity": str(max_gross),
            "limit": str(policy.max_gross_exposure_pct_equity),
        }
    if minimum_cash < policy.min_cash:
        return {
            "candidate_id": bundle.candidate_id,
            "reason": "frontier_negative_cash",
            "min_cash": str(minimum_cash),
            "limit": str(policy.min_cash),
        }
    if negative_cash_observations > policy.max_negative_cash_observation_count:
        return {
            "candidate_id": bundle.candidate_id,
            "reason": "frontier_negative_cash_observed",
            "negative_cash_observation_count": negative_cash_observations,
            "limit": policy.max_negative_cash_observation_count,
        }
    return None


def candidate_passes_minimums(
    bundle: CandidateEvidenceBundle,
    *,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> bool:
    if not evidence_bundle_is_valid(bundle):
        return False
    if non_composable_hard_vetoes(bundle):
        return False
    if capital_safety_rejection(bundle, oracle_policy=oracle_policy) is not None:
        return False
    if net_per_day(bundle) <= 0:
        return False
    if active_ratio(bundle) <= 0 or positive_ratio(bundle) <= 0:
        return False
    if bool(bundle.promotion_readiness.get("promotable")):
        return True
    blockers = cast(Sequence[Any], bundle.promotion_readiness.get("blockers") or [])
    blocking = {str(item) for item in blockers}
    allowed_blockers = {
        "scheduler_v3_parity_missing",
        "scheduler_v3_approval_missing",
        "shadow_validation_missing",
        "validation_contract_pending",
        "validation_live_paper_parity_pending",
    }
    if blocking - allowed_blockers:
        return False
    return True


def daily_net(bundle: CandidateEvidenceBundle) -> dict[str, Decimal]:
    raw_daily = scorecard(bundle).get("daily_net")
    if isinstance(raw_daily, Mapping):
        daily_mapping = cast(Mapping[Any, Any], raw_daily)
        return {str(day): decimal(value) for day, value in daily_mapping.items()}
    return {}


def daily_filled_notional(bundle: CandidateEvidenceBundle) -> dict[str, Decimal]:
    raw_daily = scorecard(bundle).get("daily_filled_notional")
    if isinstance(raw_daily, Mapping):
        daily_mapping = cast(Mapping[Any, Any], raw_daily)
        return {str(day): decimal(value) for day, value in daily_mapping.items()}
    notional = decimal(scorecard(bundle).get("avg_filled_notional_per_day"))
    return {"synthetic": notional} if notional > 0 else {}


def trading_day_count(bundle: CandidateEvidenceBundle) -> int:
    try:
        expected = int(decimal(scorecard(bundle).get("trading_day_count")))
    except Exception:
        expected = 0
    if (
        expected <= 0
        and scorecard(bundle).get("daily_net") is None
        and net_per_day(bundle) != 0
    ):
        expected = 1
    return max(expected, len(daily_net(bundle)))


def mean(values: Sequence[Decimal]) -> Decimal:
    if not values:
        return Decimal("0")
    return sum(values, Decimal("0")) / Decimal(len(values))


def correlation(left: Mapping[str, Decimal], right: Mapping[str, Decimal]) -> Decimal:
    common_days = sorted(set(left) & set(right))
    if len(common_days) < 2:
        return Decimal("0")
    left_values = [left[day] for day in common_days]
    right_values = [right[day] for day in common_days]
    left_mean = mean(left_values)
    right_mean = mean(right_values)
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


def _equal_weights(selected: Sequence[CandidateEvidenceBundle]) -> tuple[Decimal, ...]:
    if not selected:
        return ()
    weight = Decimal("1") / Decimal(len(selected))
    return tuple(weight for _ in selected)


def _gross_exposure_allocation_edge_net_per_day(
    bundle: CandidateEvidenceBundle,
) -> Decimal:
    scorecard_payload = scorecard(bundle)
    lower_bound = deployable_lower_bound_net_pnl_per_day(scorecard_payload)
    edge_candidates: list[Decimal] = [
        net_per_day(bundle),
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
        if key in scorecard_payload:
            edge_candidates.append(decimal(scorecard_payload.get(key)))
    return min(edge_candidates, default=Decimal("0"))


def _gross_exposure_allocation_priority(bundle: CandidateEvidenceBundle) -> Decimal:
    edge = _gross_exposure_allocation_edge_net_per_day(bundle)
    if edge <= 0:
        return Decimal("0")
    downside_risk = max(
        worst_day_loss(bundle),
        max_drawdown(bundle),
        Decimal("1"),
    )
    concentration_penalty = Decimal("1") + max(
        best_day_share(bundle),
        Decimal("0"),
    )
    quality = max(active_ratio(bundle), Decimal("0")) * max(
        positive_ratio(bundle),
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
    exposures = tuple(max_gross_exposure_pct_equity(bundle) for bundle in selected)
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


def portfolio_daily_net(
    selected: Sequence[CandidateEvidenceBundle],
    *,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> dict[str, Decimal]:
    weights = _portfolio_weights(selected, oracle_policy=oracle_policy)
    daily_totals: dict[str, Decimal] = {}
    for bundle, weight in zip(selected, weights, strict=True):
        for day, value in daily_net(bundle).items():
            daily_totals[day] = daily_totals.get(day, Decimal("0")) + (value * weight)
    return daily_totals


def portfolio_daily_filled_notional(
    selected: Sequence[CandidateEvidenceBundle],
    *,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> dict[str, Decimal]:
    weights = _portfolio_weights(selected, oracle_policy=oracle_policy)
    daily_totals: dict[str, Decimal] = {}
    for bundle, weight in zip(selected, weights, strict=True):
        for day, value in daily_filled_notional(bundle).items():
            daily_totals[day] = daily_totals.get(day, Decimal("0")) + (value * weight)
    return daily_totals


def executable_replay_passed(bundle: CandidateEvidenceBundle) -> bool:
    return boolish(scorecard(bundle).get("executable_replay_passed"))


def executable_replay_order_count(bundle: CandidateEvidenceBundle) -> int:
    scorecard_payload = scorecard(bundle)
    try:
        return max(
            0,
            int(
                decimal(
                    scorecard_payload.get("executable_replay_order_count")
                    or scorecard_payload.get("executable_replay_submitted_order_count")
                    or scorecard_payload.get("executable_replay_orders_submitted_total")
                )
            ),
        )
    except Exception:
        return 0


def executable_replay_artifact_ref(bundle: CandidateEvidenceBundle) -> str:
    scorecard_payload = scorecard(bundle)
    return string(scorecard_payload.get("executable_replay_artifact_ref"))


def artifact_refs_from_scorecard(scorecard: Mapping[str, Any], *keys: str) -> list[str]:
    refs: list[str] = []
    for key in keys:
        value = scorecard.get(key)
        if isinstance(value, Sequence) and not isinstance(value, str):
            refs.extend(
                normalized
                for normalized in (string(item) for item in cast(Sequence[Any], value))
                if normalized
            )
            continue
        normalized = string(value)
        if normalized:
            refs.append(normalized)
    return list(dict.fromkeys(refs))


def exact_replay_ledger_artifact_refs(bundle: CandidateEvidenceBundle) -> list[str]:
    scorecard_payload = scorecard(bundle)
    return artifact_refs_from_scorecard(
        scorecard_payload,
        "exact_replay_ledger_artifact_ref",
        "exact_replay_ledger_artifact_refs",
    )


def exact_replay_ledger_row_count(bundle: CandidateEvidenceBundle) -> int:
    scorecard_payload = scorecard(bundle)
    return max(
        0,
        int(decimal(scorecard_payload.get("exact_replay_ledger_artifact_row_count"))),
    )


def exact_replay_ledger_fill_count(bundle: CandidateEvidenceBundle) -> int:
    scorecard_payload = scorecard(bundle)
    return max(
        0,
        int(decimal(scorecard_payload.get("exact_replay_ledger_artifact_fill_count"))),
    )


def first_normalized_scorecard_text(scorecard: Mapping[str, Any], *keys: str) -> str:
    for key in keys:
        normalized = string(scorecard.get(key)).lower()
        if normalized:
            return normalized
    return ""


def ledger_pnl_basis(bundle: CandidateEvidenceBundle) -> str:
    return first_normalized_scorecard_text(
        scorecard(bundle),
        "portfolio_post_cost_net_pnl_basis",
        "portfolio_post_cost_net_pnl_per_day_basis",
        "post_cost_net_pnl_basis",
        "net_pnl_basis",
        "runtime_ledger_pnl_basis",
        "exact_replay_ledger_pnl_basis",
        "post_cost_expectancy_basis",
        "pnl_basis",
    )


def ledger_pnl_source(bundle: CandidateEvidenceBundle) -> str:
    return first_normalized_scorecard_text(
        scorecard(bundle),
        "portfolio_post_cost_net_pnl_source",
        "portfolio_post_cost_net_pnl_per_day_source",
        "post_cost_net_pnl_source",
        "net_pnl_source",
        "runtime_ledger_pnl_source",
        "exact_replay_ledger_pnl_source",
        "post_cost_expectancy_source",
        "pnl_source",
    )


def executable_replay_buying_power(bundle: CandidateEvidenceBundle) -> Decimal:
    scorecard_payload = scorecard(bundle)
    return decimal(
        scorecard_payload.get("executable_replay_account_buying_power")
        or scorecard_payload.get("executable_replay_buying_power")
    )


def executable_replay_max_notional(bundle: CandidateEvidenceBundle) -> Decimal:
    scorecard_payload = scorecard(bundle)
    return decimal(
        scorecard_payload.get("executable_replay_max_notional_per_trade")
        or scorecard_payload.get("executable_replay_max_notional_per_order")
    )


def market_impact_stress_passed(bundle: CandidateEvidenceBundle) -> bool:
    scorecard_payload = scorecard(bundle)
    return boolish(
        scorecard_payload.get("nonlinear_market_impact_stress_passed")
        or scorecard_payload.get("market_impact_stress_passed")
        or scorecard_payload.get("cost_shock_stress_passed")
    )


def market_impact_stress_model(bundle: CandidateEvidenceBundle) -> str:
    scorecard_payload = scorecard(bundle)
    return string(
        scorecard_payload.get("nonlinear_market_impact_stress_model")
        or scorecard_payload.get("market_impact_stress_model")
    )


def market_impact_stress_components(
    bundle: CandidateEvidenceBundle,
) -> Mapping[str, Any]:
    return mapping(scorecard(bundle).get("market_impact_stress_components"))


def market_impact_stress_artifact_ref(bundle: CandidateEvidenceBundle) -> str:
    scorecard_payload = scorecard(bundle)
    return string(
        scorecard_payload.get("market_impact_stress_artifact_ref")
        or scorecard_payload.get("impact_stress_artifact_ref")
        or scorecard_payload.get("cost_shock_artifact_ref")
    )


def market_impact_stress_net_per_day(bundle: CandidateEvidenceBundle) -> Decimal:
    scorecard_payload = scorecard(bundle)
    return decimal(
        scorecard_payload.get("market_impact_stress_net_pnl_per_day")
        or scorecard_payload.get("post_impact_net_pnl_per_day")
        or scorecard_payload.get("cost_shock_net_pnl_per_day")
    )


def market_impact_stress_cost_bps(bundle: CandidateEvidenceBundle) -> Decimal:
    scorecard_payload = scorecard(bundle)
    return decimal(
        scorecard_payload.get("market_impact_stress_cost_bps")
        or scorecard_payload.get("market_impact_cost_bps")
        or scorecard_payload.get("cost_shock_bps")
    )


def market_impact_liquidity_evidence_present(
    bundle: CandidateEvidenceBundle,
) -> bool:
    scorecard_payload = scorecard(bundle)
    return boolish(
        scorecard_payload.get("market_impact_liquidity_evidence_present")
        or scorecard_payload.get("liquidity_evidence_present")
    )


def implementation_uncertainty_required(bundle: CandidateEvidenceBundle) -> bool:
    return boolish(scorecard(bundle).get("implementation_uncertainty_required"))


def implementation_uncertainty_stability_passed(
    bundle: CandidateEvidenceBundle,
) -> bool:
    scorecard_payload = scorecard(bundle)
    if not implementation_uncertainty_required(bundle):
        return True
    return boolish(scorecard_payload.get("implementation_uncertainty_stability_passed"))


def implementation_uncertainty_model_count(bundle: CandidateEvidenceBundle) -> int:
    return int(decimal(scorecard(bundle).get("implementation_uncertainty_model_count")))


def implementation_uncertainty_lower_net_per_day(
    bundle: CandidateEvidenceBundle,
) -> Decimal:
    return decimal(
        scorecard(bundle).get("implementation_uncertainty_lower_net_pnl_per_day")
    )


def implementation_uncertainty_upper_net_per_day(
    bundle: CandidateEvidenceBundle,
) -> Decimal:
    return decimal(
        scorecard(bundle).get("implementation_uncertainty_upper_net_pnl_per_day")
    )


def implementation_uncertainty_interval_width_per_day(
    bundle: CandidateEvidenceBundle,
) -> Decimal:
    return decimal(
        scorecard(bundle).get("implementation_uncertainty_interval_width_per_day")
    )


def conformal_tail_risk_required(bundle: CandidateEvidenceBundle) -> bool:
    return boolish(scorecard(bundle).get("conformal_tail_risk_required"))


def conformal_tail_loss_buffer(values: Sequence[Decimal]) -> Decimal:
    losses = sorted(max(Decimal("0"), -value) for value in values)
    if not losses:
        return Decimal("0")
    tail_count = max(
        1,
        int(
            (Decimal(len(losses)) * CONFORMAL_TAIL_RISK_ALPHA).to_integral_value(
                rounding=ROUND_CEILING
            )
        ),
    )
    tail_count = min(tail_count, len(losses))
    return max(losses[-tail_count:], default=Decimal("0"))


__all__ = (
    "MAX_ALLOWED_PAIRWISE_CORRELATION",
    "CONFORMAL_TAIL_RISK_ALPHA",
    "PORTFOLIO_SEARCH_BEAM_WIDTH",
    "PORTFOLIO_WEIGHTING_EQUAL_COUNT",
    "PORTFOLIO_WEIGHTING_GROSS_EXPOSURE_BUDGET",
    "PORTFOLIO_WEIGHTING_EDGE_RISK_GROSS_EXPOSURE_BUDGET",
    "PORTFOLIO_RUNTIME_LEDGER_PNL_SOURCE",
    "PORTFOLIO_COMPOSABLE_SINGLE_SLEEVE_VETOES",
)


# Explicit barrel exports; keeps re-export imports intentional without file-level Ruff ignores.
__all__: tuple[str, ...] = (
    "ACCEPTED_LEDGER_PNL_SOURCES",
    "Any",
    "CONFORMAL_TAIL_RISK_ALPHA",
    "CandidateEvidenceBundle",
    "Decimal",
    "MAX_ALLOWED_PAIRWISE_CORRELATION",
    "Mapping",
    "PORTFOLIO_CANDIDATE_SCHEMA_VERSION",
    "PORTFOLIO_COMPOSABLE_SINGLE_SLEEVE_VETOES",
    "PORTFOLIO_RUNTIME_LEDGER_PNL_SOURCE",
    "PORTFOLIO_SEARCH_BEAM_WIDTH",
    "PORTFOLIO_WEIGHTING_EDGE_RISK_GROSS_EXPOSURE_BUDGET",
    "PORTFOLIO_WEIGHTING_EQUAL_COUNT",
    "PORTFOLIO_WEIGHTING_GROSS_EXPOSURE_BUDGET",
    "POST_COST_PNL_BASIS",
    "PortfolioCandidateSpec",
    "ProfitTargetOraclePolicy",
    "ROUND_CEILING",
    "Sequence",
    "ACCEPTED_LEDGER_PNL_SOURCES",
    "active_ratio",
    "artifact_refs_from_scorecard",
    "best_day_share",
    "boolish",
    "candidate_passes_minimums",
    "capital_safety_rejection",
    "conformal_tail_loss_buffer",
    "conformal_tail_risk_required",
    "correlation",
    "daily_filled_notional",
    "daily_net",
    "decimal",
    "_diversification_sleeve_score",
    "diversified_candidate_order",
    "_edge_risk_gross_exposure_budget_weights",
    "_equal_weights",
    "exact_replay_ledger_artifact_refs",
    "exact_replay_ledger_fill_count",
    "exact_replay_ledger_row_count",
    "executable_replay_artifact_ref",
    "executable_replay_buying_power",
    "executable_replay_max_notional",
    "executable_replay_order_count",
    "executable_replay_passed",
    "first_normalized_scorecard_text",
    "_gross_exposure_allocation_edge_net_per_day",
    "_gross_exposure_allocation_priority",
    "_gross_exposure_budget_weights",
    "hard_vetoes",
    "implementation_uncertainty_interval_width_per_day",
    "implementation_uncertainty_lower_net_per_day",
    "implementation_uncertainty_model_count",
    "implementation_uncertainty_required",
    "implementation_uncertainty_stability_passed",
    "implementation_uncertainty_upper_net_per_day",
    "ledger_pnl_basis",
    "ledger_pnl_source",
    "mapping",
    "market_impact_liquidity_evidence_present",
    "market_impact_stress_artifact_ref",
    "market_impact_stress_components",
    "market_impact_stress_cost_bps",
    "market_impact_stress_model",
    "market_impact_stress_net_per_day",
    "market_impact_stress_passed",
    "max_drawdown",
    "max_gross_exposure_pct_equity",
    "mean",
    "min_cash",
    "negative_cash_observation_count",
    "net_per_day",
    "non_composable_hard_vetoes",
    "portfolio_daily_filled_notional",
    "portfolio_daily_net",
    "_portfolio_weights",
    "positive_ratio",
    "scorecard",
    "scorecard_primary_symbol",
    "scorecard_runtime_params",
    "scorecard_signal",
    "scorecard_sleeve_runtime_limits",
    "scorecard_universe_symbols",
    "string",
    "trading_day_count",
    "worst_day_loss",
    "active_ratio",
    "annotations",
    "artifact_refs_from_scorecard",
    "best_day_share",
    "boolish",
    "candidate_passes_minimums",
    "capital_safety_rejection",
    "cast",
    "conformal_tail_loss_buffer",
    "conformal_tail_risk_required",
    "correlation",
    "daily_filled_notional",
    "daily_net",
    "decimal",
    "deployable_lower_bound_net_pnl_per_day",
    "diversified_candidate_order",
    "evaluate_profit_target_oracle",
    "evidence_bundle_blockers",
    "evidence_bundle_is_valid",
    "exact_replay_ledger_artifact_refs",
    "exact_replay_ledger_fill_count",
    "exact_replay_ledger_row_count",
    "executable_replay_artifact_ref",
    "executable_replay_buying_power",
    "executable_replay_max_notional",
    "executable_replay_order_count",
    "executable_replay_passed",
    "first_normalized_scorecard_text",
    "hard_vetoes",
    "implementation_uncertainty_interval_width_per_day",
    "implementation_uncertainty_lower_net_per_day",
    "implementation_uncertainty_model_count",
    "implementation_uncertainty_required",
    "implementation_uncertainty_stability_passed",
    "implementation_uncertainty_upper_net_per_day",
    "ledger_pnl_basis",
    "ledger_pnl_source",
    "mapping",
    "market_impact_liquidity_evidence_present",
    "market_impact_stress_artifact_ref",
    "market_impact_stress_components",
    "market_impact_stress_cost_bps",
    "market_impact_stress_model",
    "market_impact_stress_net_per_day",
    "market_impact_stress_passed",
    "max_drawdown",
    "max_gross_exposure_pct_equity",
    "mean",
    "min_cash",
    "negative_cash_observation_count",
    "net_per_day",
    "non_composable_hard_vetoes",
    "portfolio_candidate_id_for_payload",
    "portfolio_daily_filled_notional",
    "portfolio_daily_net",
    "positive_ratio",
    "scorecard",
    "scorecard_primary_symbol",
    "scorecard_runtime_params",
    "scorecard_signal",
    "scorecard_sleeve_runtime_limits",
    "scorecard_universe_symbols",
    "string",
    "trading_day_count",
    "worst_day_loss",
)
