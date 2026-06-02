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
_ACCEPTED_LEDGER_PNL_SOURCES = frozenset(
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


def _decimal(value: Any, *, default: str = "0") -> Decimal:
    try:
        return Decimal(str(value if value is not None else default))
    except Exception:
        return Decimal(default)


def _string(value: Any) -> str:
    return str(value or "").strip()


def _mapping(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): item for key, item in cast(Mapping[Any, Any], value).items()}


def _boolish(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return _string(value).lower() in {"1", "true", "yes", "y", "passed"}


def _scorecard(bundle: CandidateEvidenceBundle) -> Mapping[str, Any]:
    return bundle.objective_scorecard


def _scorecard_runtime_params(bundle: CandidateEvidenceBundle) -> Mapping[str, Any]:
    return _mapping(_scorecard(bundle).get("runtime_params"))


def _scorecard_universe_symbols(bundle: CandidateEvidenceBundle) -> list[str]:
    raw_symbols = _scorecard(bundle).get("universe_symbols")
    if not isinstance(raw_symbols, Sequence) or isinstance(raw_symbols, str):
        return []
    return [
        symbol
        for symbol in (
            _string(item).upper() for item in cast(Sequence[Any], raw_symbols)
        )
        if symbol
    ]


def _scorecard_primary_symbol(bundle: CandidateEvidenceBundle) -> str:
    raw_symbol_shares = _scorecard(bundle).get("symbol_contribution_shares")
    if isinstance(raw_symbol_shares, Mapping):
        rows = cast(Mapping[Any, Any], raw_symbol_shares)
        symbols = [
            (_string(symbol).upper(), _decimal(share))
            for symbol, share in rows.items()
            if _string(symbol)
        ]
        if symbols:
            symbols.sort(key=lambda item: (item[1], item[0]), reverse=True)
            return symbols[0][0]
    symbol = _string(_scorecard(bundle).get("symbol")).upper()
    if symbol:
        return symbol
    universe_symbols = _scorecard_universe_symbols(bundle)
    if universe_symbols:
        return universe_symbols[0]
    return "UNKNOWN"


def _diversified_candidate_order(
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
        buckets.setdefault(_scorecard_primary_symbol(candidate), []).append(candidate)
    ordered_buckets = sorted(
        buckets.values(),
        key=lambda bucket: (
            _sleeve_score(bucket[0]),
            _net_per_day(bucket[0]),
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
                _sleeve_score(bucket[0]),
                _net_per_day(bucket[0]),
                bucket[0].candidate_id,
            ),
            reverse=True,
        )
    return diversified


def _scorecard_sleeve_runtime_limits(bundle: CandidateEvidenceBundle) -> dict[str, str]:
    limits: dict[str, str] = {}
    scorecard = _scorecard(bundle)
    for key in ("max_notional_per_trade", "max_position_pct_equity"):
        value = _string(scorecard.get(key))
        if value:
            limits[key] = value
    return limits


def _scorecard_signal(bundle: CandidateEvidenceBundle) -> str:
    params = _scorecard_runtime_params(bundle)
    signal = _string(params.get("signal_motif"))
    if signal:
        return signal
    signal_key = _string(_scorecard(bundle).get("signal_key"))
    return signal_key.split("|", 1)[0] if signal_key else ""


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


def _max_gross_exposure_pct_equity(bundle: CandidateEvidenceBundle) -> Decimal:
    return _decimal(_scorecard(bundle).get("max_gross_exposure_pct_equity"))


def _min_cash(bundle: CandidateEvidenceBundle) -> Decimal:
    return _decimal(_scorecard(bundle).get("min_cash"))


def _negative_cash_observation_count(bundle: CandidateEvidenceBundle) -> int:
    try:
        return max(
            0,
            int(_decimal(_scorecard(bundle).get("negative_cash_observation_count"))),
        )
    except Exception:
        return 0


def _hard_vetoes(bundle: CandidateEvidenceBundle) -> tuple[str, ...]:
    raw_hard_vetoes = _scorecard(bundle).get("hard_vetoes")
    if isinstance(raw_hard_vetoes, str):
        return (raw_hard_vetoes,) if raw_hard_vetoes.strip() else ()
    if not isinstance(raw_hard_vetoes, Sequence):
        return ()
    vetoes: list[str] = []
    for raw_value in cast(Sequence[object], raw_hard_vetoes):
        veto = _string(raw_value)
        if veto:
            vetoes.append(veto)
    return tuple(vetoes)


def _non_composable_hard_vetoes(bundle: CandidateEvidenceBundle) -> tuple[str, ...]:
    return tuple(
        veto
        for veto in _hard_vetoes(bundle)
        if veto not in PORTFOLIO_COMPOSABLE_SINGLE_SLEEVE_VETOES
    )


def _capital_safety_rejection(
    bundle: CandidateEvidenceBundle,
    *,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> dict[str, Any] | None:
    policy = oracle_policy or ProfitTargetOraclePolicy()
    max_gross = _max_gross_exposure_pct_equity(bundle)
    min_cash = _min_cash(bundle)
    negative_cash_observations = _negative_cash_observation_count(bundle)
    if max_gross > policy.max_gross_exposure_pct_equity:
        return {
            "candidate_id": bundle.candidate_id,
            "reason": "frontier_capital_violation",
            "max_gross_exposure_pct_equity": str(max_gross),
            "limit": str(policy.max_gross_exposure_pct_equity),
        }
    if min_cash < policy.min_cash:
        return {
            "candidate_id": bundle.candidate_id,
            "reason": "frontier_negative_cash",
            "min_cash": str(min_cash),
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


def _candidate_passes_minimums(
    bundle: CandidateEvidenceBundle,
    *,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> bool:
    if not evidence_bundle_is_valid(bundle):
        return False
    if _non_composable_hard_vetoes(bundle):
        return False
    if _capital_safety_rejection(bundle, oracle_policy=oracle_policy) is not None:
        return False
    if _net_per_day(bundle) <= 0:
        return False
    if _active_ratio(bundle) <= 0 or _positive_ratio(bundle) <= 0:
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


def _daily_net(bundle: CandidateEvidenceBundle) -> dict[str, Decimal]:
    raw_daily = _scorecard(bundle).get("daily_net")
    if isinstance(raw_daily, Mapping):
        daily_mapping = cast(Mapping[Any, Any], raw_daily)
        return {str(day): _decimal(value) for day, value in daily_mapping.items()}
    return {}


def _daily_filled_notional(bundle: CandidateEvidenceBundle) -> dict[str, Decimal]:
    raw_daily = _scorecard(bundle).get("daily_filled_notional")
    if isinstance(raw_daily, Mapping):
        daily_mapping = cast(Mapping[Any, Any], raw_daily)
        return {str(day): _decimal(value) for day, value in daily_mapping.items()}
    notional = _decimal(_scorecard(bundle).get("avg_filled_notional_per_day"))
    return {"synthetic": notional} if notional > 0 else {}


def _trading_day_count(bundle: CandidateEvidenceBundle) -> int:
    try:
        expected = int(_decimal(_scorecard(bundle).get("trading_day_count")))
    except Exception:
        expected = 0
    if (
        expected <= 0
        and _scorecard(bundle).get("daily_net") is None
        and _net_per_day(bundle) != 0
    ):
        expected = 1
    return max(expected, len(_daily_net(bundle)))


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
    *,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> dict[str, Decimal]:
    weights = _portfolio_weights(selected, oracle_policy=oracle_policy)
    daily_totals: dict[str, Decimal] = {}
    for bundle, weight in zip(selected, weights, strict=True):
        for day, value in _daily_net(bundle).items():
            daily_totals[day] = daily_totals.get(day, Decimal("0")) + (value * weight)
    return daily_totals


def _portfolio_daily_filled_notional(
    selected: Sequence[CandidateEvidenceBundle],
    *,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> dict[str, Decimal]:
    weights = _portfolio_weights(selected, oracle_policy=oracle_policy)
    daily_totals: dict[str, Decimal] = {}
    for bundle, weight in zip(selected, weights, strict=True):
        for day, value in _daily_filled_notional(bundle).items():
            daily_totals[day] = daily_totals.get(day, Decimal("0")) + (value * weight)
    return daily_totals


def _executable_replay_passed(bundle: CandidateEvidenceBundle) -> bool:
    return _boolish(_scorecard(bundle).get("executable_replay_passed"))


def _executable_replay_order_count(bundle: CandidateEvidenceBundle) -> int:
    scorecard = _scorecard(bundle)
    try:
        return max(
            0,
            int(
                _decimal(
                    scorecard.get("executable_replay_order_count")
                    or scorecard.get("executable_replay_submitted_order_count")
                    or scorecard.get("executable_replay_orders_submitted_total")
                )
            ),
        )
    except Exception:
        return 0


def _executable_replay_artifact_ref(bundle: CandidateEvidenceBundle) -> str:
    scorecard = _scorecard(bundle)
    return _string(scorecard.get("executable_replay_artifact_ref"))


def _artifact_refs_from_scorecard(
    scorecard: Mapping[str, Any], *keys: str
) -> list[str]:
    refs: list[str] = []
    for key in keys:
        value = scorecard.get(key)
        if isinstance(value, Sequence) and not isinstance(value, str):
            refs.extend(
                normalized
                for normalized in (_string(item) for item in cast(Sequence[Any], value))
                if normalized
            )
            continue
        normalized = _string(value)
        if normalized:
            refs.append(normalized)
    return list(dict.fromkeys(refs))


def _exact_replay_ledger_artifact_refs(bundle: CandidateEvidenceBundle) -> list[str]:
    scorecard = _scorecard(bundle)
    return _artifact_refs_from_scorecard(
        scorecard,
        "exact_replay_ledger_artifact_ref",
        "exact_replay_ledger_artifact_refs",
    )


def _exact_replay_ledger_row_count(bundle: CandidateEvidenceBundle) -> int:
    scorecard = _scorecard(bundle)
    return max(
        0,
        int(
            _decimal(
                scorecard.get("exact_replay_ledger_artifact_row_count")
            )
        ),
    )


def _exact_replay_ledger_fill_count(bundle: CandidateEvidenceBundle) -> int:
    scorecard = _scorecard(bundle)
    return max(
        0,
        int(
            _decimal(
                scorecard.get("exact_replay_ledger_artifact_fill_count")
            )
        ),
    )


def _first_normalized_scorecard_text(scorecard: Mapping[str, Any], *keys: str) -> str:
    for key in keys:
        normalized = _string(scorecard.get(key)).lower()
        if normalized:
            return normalized
    return ""


def _ledger_pnl_basis(bundle: CandidateEvidenceBundle) -> str:
    return _first_normalized_scorecard_text(
        _scorecard(bundle),
        "portfolio_post_cost_net_pnl_basis",
        "portfolio_post_cost_net_pnl_per_day_basis",
        "post_cost_net_pnl_basis",
        "net_pnl_basis",
        "runtime_ledger_pnl_basis",
        "exact_replay_ledger_pnl_basis",
        "post_cost_expectancy_basis",
        "pnl_basis",
    )


def _ledger_pnl_source(bundle: CandidateEvidenceBundle) -> str:
    return _first_normalized_scorecard_text(
        _scorecard(bundle),
        "portfolio_post_cost_net_pnl_source",
        "portfolio_post_cost_net_pnl_per_day_source",
        "post_cost_net_pnl_source",
        "net_pnl_source",
        "runtime_ledger_pnl_source",
        "exact_replay_ledger_pnl_source",
        "post_cost_expectancy_source",
        "pnl_source",
    )


def _executable_replay_buying_power(bundle: CandidateEvidenceBundle) -> Decimal:
    scorecard = _scorecard(bundle)
    return _decimal(
        scorecard.get("executable_replay_account_buying_power")
        or scorecard.get("executable_replay_buying_power")
    )


def _executable_replay_max_notional(bundle: CandidateEvidenceBundle) -> Decimal:
    scorecard = _scorecard(bundle)
    return _decimal(
        scorecard.get("executable_replay_max_notional_per_trade")
        or scorecard.get("executable_replay_max_notional_per_order")
    )


def _market_impact_stress_passed(bundle: CandidateEvidenceBundle) -> bool:
    scorecard = _scorecard(bundle)
    return _boolish(
        scorecard.get("nonlinear_market_impact_stress_passed")
        or scorecard.get("market_impact_stress_passed")
        or scorecard.get("cost_shock_stress_passed")
    )


def _market_impact_stress_model(bundle: CandidateEvidenceBundle) -> str:
    scorecard = _scorecard(bundle)
    return _string(
        scorecard.get("nonlinear_market_impact_stress_model")
        or scorecard.get("market_impact_stress_model")
    )


def _market_impact_stress_components(
    bundle: CandidateEvidenceBundle,
) -> Mapping[str, Any]:
    return _mapping(_scorecard(bundle).get("market_impact_stress_components"))


def _market_impact_stress_artifact_ref(bundle: CandidateEvidenceBundle) -> str:
    scorecard = _scorecard(bundle)
    return _string(
        scorecard.get("market_impact_stress_artifact_ref")
        or scorecard.get("impact_stress_artifact_ref")
        or scorecard.get("cost_shock_artifact_ref")
    )


def _market_impact_stress_net_per_day(bundle: CandidateEvidenceBundle) -> Decimal:
    scorecard = _scorecard(bundle)
    return _decimal(
        scorecard.get("market_impact_stress_net_pnl_per_day")
        or scorecard.get("post_impact_net_pnl_per_day")
        or scorecard.get("cost_shock_net_pnl_per_day")
    )


def _market_impact_stress_cost_bps(bundle: CandidateEvidenceBundle) -> Decimal:
    scorecard = _scorecard(bundle)
    return _decimal(
        scorecard.get("market_impact_stress_cost_bps")
        or scorecard.get("market_impact_cost_bps")
        or scorecard.get("cost_shock_bps")
    )


def _market_impact_liquidity_evidence_present(
    bundle: CandidateEvidenceBundle,
) -> bool:
    scorecard = _scorecard(bundle)
    return _boolish(
        scorecard.get("market_impact_liquidity_evidence_present")
        or scorecard.get("liquidity_evidence_present")
    )


def _implementation_uncertainty_required(bundle: CandidateEvidenceBundle) -> bool:
    return _boolish(_scorecard(bundle).get("implementation_uncertainty_required"))


def _implementation_uncertainty_stability_passed(
    bundle: CandidateEvidenceBundle,
) -> bool:
    scorecard = _scorecard(bundle)
    if not _implementation_uncertainty_required(bundle):
        return True
    return _boolish(scorecard.get("implementation_uncertainty_stability_passed"))


def _implementation_uncertainty_model_count(bundle: CandidateEvidenceBundle) -> int:
    return int(
        _decimal(_scorecard(bundle).get("implementation_uncertainty_model_count"))
    )


def _implementation_uncertainty_lower_net_per_day(
    bundle: CandidateEvidenceBundle,
) -> Decimal:
    return _decimal(
        _scorecard(bundle).get("implementation_uncertainty_lower_net_pnl_per_day")
    )


def _implementation_uncertainty_upper_net_per_day(
    bundle: CandidateEvidenceBundle,
) -> Decimal:
    return _decimal(
        _scorecard(bundle).get("implementation_uncertainty_upper_net_pnl_per_day")
    )


def _implementation_uncertainty_interval_width_per_day(
    bundle: CandidateEvidenceBundle,
) -> Decimal:
    return _decimal(
        _scorecard(bundle).get("implementation_uncertainty_interval_width_per_day")
    )


def _conformal_tail_risk_required(bundle: CandidateEvidenceBundle) -> bool:
    return _boolish(_scorecard(bundle).get("conformal_tail_risk_required"))


def _conformal_tail_loss_buffer(values: Sequence[Decimal]) -> Decimal:
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


def _portfolio_trading_day_count(
    selected: Sequence[CandidateEvidenceBundle],
    daily_net: Mapping[str, Decimal],
) -> int:
    expected = max((_trading_day_count(bundle) for bundle in selected), default=0)
    return max(expected, len(daily_net))


def _portfolio_scorecard(
    *,
    selected: Sequence[CandidateEvidenceBundle],
    target_net_pnl_per_day: Decimal,
    oracle_policy: ProfitTargetOraclePolicy,
) -> dict[str, Any]:
    weights = _portfolio_weights(selected, oracle_policy=oracle_policy)
    daily_net = _portfolio_daily_net(selected, oracle_policy=oracle_policy)
    trading_day_count = _portfolio_trading_day_count(selected, daily_net)
    missing_day_count = max(0, trading_day_count - len(daily_net))
    missing_sleeve_daily_net_count = _missing_sleeve_daily_net_count(
        selected, daily_net
    )
    values = [daily_net[day] for day in sorted(daily_net)] + (
        [Decimal("0")] * missing_day_count
    )
    net_per_day = _mean(values)
    conformal_tail_risk_buffer_per_day = _conformal_tail_loss_buffer(values)
    conformal_tail_risk_adjusted_net_pnl_per_day = (
        net_per_day - conformal_tail_risk_buffer_per_day
    )
    conformal_tail_risk_required = bool(selected) and (
        conformal_tail_risk_buffer_per_day > 0
        or any(_conformal_tail_risk_required(bundle) for bundle in selected)
    )
    conformal_tail_risk_passed = (
        bool(values)
        and conformal_tail_risk_adjusted_net_pnl_per_day >= target_net_pnl_per_day
    )
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
    cluster_shares = _cluster_contribution_shares(selected, oracle_policy=oracle_policy)
    symbol_shares = _symbol_contribution_shares(selected, oracle_policy=oracle_policy)
    min_day = min(values, default=Decimal("0"))
    worst_day_loss = abs(min_day) if min_day < 0 else Decimal("0")
    daily_notional = _portfolio_daily_filled_notional(
        selected, oracle_policy=oracle_policy
    )
    notional_missing_day_count = max(0, trading_day_count - len(daily_notional))
    notional_values = [daily_notional[day] for day in sorted(daily_notional)] + (
        [Decimal("0")] * notional_missing_day_count
    )
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
    executable_artifact_refs = [
        ref
        for ref in (_executable_replay_artifact_ref(bundle) for bundle in selected)
        if ref
    ]
    exact_replay_ledger_artifact_refs = list(
        dict.fromkeys(
            ref
            for bundle in selected
            for ref in _exact_replay_ledger_artifact_refs(bundle)
        )
    )
    exact_replay_ledger_row_count = sum(
        _exact_replay_ledger_row_count(bundle) for bundle in selected
    )
    exact_replay_ledger_fill_count = sum(
        _exact_replay_ledger_fill_count(bundle) for bundle in selected
    )
    all_selected_have_ledger_pnl_basis = bool(selected) and all(
        _ledger_pnl_basis(bundle) == POST_COST_PNL_BASIS for bundle in selected
    )
    all_selected_have_ledger_pnl_source = bool(selected) and all(
        _ledger_pnl_source(bundle) in _ACCEPTED_LEDGER_PNL_SOURCES
        for bundle in selected
    )
    executable_order_count = sum(
        _executable_replay_order_count(bundle) for bundle in selected
    )
    executable_buying_powers = [
        _executable_replay_buying_power(bundle) for bundle in selected
    ]
    executable_max_notionals = [
        _executable_replay_max_notional(bundle) for bundle in selected
    ]
    market_impact_artifact_refs = [
        ref
        for ref in (_market_impact_stress_artifact_ref(bundle) for bundle in selected)
        if ref
    ]
    market_impact_stress_net_pnl_per_day = sum(
        (
            _market_impact_stress_net_per_day(bundle) * weight
            for bundle, weight in zip(selected, weights, strict=True)
        ),
        Decimal("0"),
    )
    delay_depth_artifact_refs = [
        ref
        for ref in (
            _delay_adjusted_depth_stress_artifact_ref(bundle) for bundle in selected
        )
        if ref
    ]
    delay_depth_stress_net_pnl_per_day = sum(
        (
            _delay_adjusted_depth_stress_net_per_day(bundle) * weight
            for bundle, weight in zip(selected, weights, strict=True)
        ),
        Decimal("0"),
    )
    delay_depth_fillable_notional_per_day = sum(
        (
            _delay_adjusted_depth_fillable_notional_per_day(bundle) * weight
            for bundle, weight in zip(selected, weights, strict=True)
        ),
        Decimal("0"),
    )
    delay_depth_worst_active_day_fillable_notional = sum(
        (
            _delay_adjusted_depth_worst_active_day_fillable_notional(bundle) * weight
            for bundle, weight in zip(selected, weights, strict=True)
        ),
        Decimal("0"),
    )
    delay_depth_p10_active_day_fillable_notional = sum(
        (
            _delay_adjusted_depth_p10_active_day_fillable_notional(bundle) * weight
            for bundle, weight in zip(selected, weights, strict=True)
        ),
        Decimal("0"),
    )
    fill_survival_evidence_present = bool(selected) and all(
        _fill_survival_evidence_present(bundle) for bundle in selected
    )
    fill_survival_sample_count = sum(
        _fill_survival_sample_count(bundle) for bundle in selected
    )
    fill_survival_rate = min(
        (_fill_survival_rate(bundle) for bundle in selected),
        default=Decimal("0"),
    )
    queue_position_survival_evidence_present = bool(selected) and all(
        _queue_position_survival_evidence_present(bundle) for bundle in selected
    )
    queue_position_survival_sample_count = sum(
        _queue_position_survival_sample_count(bundle) for bundle in selected
    )
    queue_position_survival_fill_rate = min(
        (_queue_position_survival_fill_rate(bundle) for bundle in selected),
        default=Decimal("0"),
    )
    queue_position_survival_queue_ratio_p95 = max(
        (_queue_position_survival_queue_ratio_p95(bundle) for bundle in selected),
        default=Decimal("0"),
    )
    queue_ahead_depletion_evidence_present = bool(selected) and all(
        _queue_ahead_depletion_evidence_present(bundle) for bundle in selected
    )
    queue_ahead_depletion_sample_count = sum(
        _queue_ahead_depletion_sample_count(bundle) for bundle in selected
    )
    queue_position_survival_stress_net_pnl_per_day = sum(
        (
            _queue_position_survival_stress_net_per_day(bundle) * weight
            for bundle, weight in zip(selected, weights, strict=True)
        ),
        Decimal("0"),
    )
    double_oos_artifact_refs = [
        ref for ref in (_double_oos_artifact_ref(bundle) for bundle in selected) if ref
    ]
    double_oos_independent_window_count = min(
        (_double_oos_independent_window_count(bundle) for bundle in selected),
        default=0,
    )
    double_oos_pass_rate = min(
        (_double_oos_pass_rate(bundle) for bundle in selected),
        default=Decimal("0"),
    )
    double_oos_net_pnl_per_day = sum(
        (
            _double_oos_net_per_day(bundle) * weight
            for bundle, weight in zip(selected, weights, strict=True)
        ),
        Decimal("0"),
    )
    double_oos_cost_shock_net_pnl_per_day = sum(
        (
            _double_oos_cost_shock_net_per_day(bundle) * weight
            for bundle, weight in zip(selected, weights, strict=True)
        ),
        Decimal("0"),
    )
    market_impact_models = sorted(
        {
            model
            for model in (_market_impact_stress_model(bundle) for bundle in selected)
            if model
        }
    )
    market_impact_components_by_sleeve = {
        bundle.candidate_id: dict(_market_impact_stress_components(bundle))
        for bundle in selected
        if _market_impact_stress_components(bundle)
    }
    market_impact_max_cost_bps = max(
        (_market_impact_stress_cost_bps(bundle) for bundle in selected),
        default=Decimal("0"),
    )
    implementation_uncertainty_required = any(
        _implementation_uncertainty_required(bundle) for bundle in selected
    )
    implementation_uncertainty_model_count = sum(
        _implementation_uncertainty_model_count(bundle) for bundle in selected
    )
    implementation_uncertainty_lower_net_pnl_per_day = sum(
        (
            _implementation_uncertainty_lower_net_per_day(bundle) * weight
            for bundle, weight in zip(selected, weights, strict=True)
        ),
        Decimal("0"),
    )
    implementation_uncertainty_upper_net_pnl_per_day = sum(
        (
            _implementation_uncertainty_upper_net_per_day(bundle) * weight
            for bundle, weight in zip(selected, weights, strict=True)
        ),
        Decimal("0"),
    )
    implementation_uncertainty_interval_width_per_day = sum(
        (
            _implementation_uncertainty_interval_width_per_day(bundle) * weight
            for bundle, weight in zip(selected, weights, strict=True)
        ),
        Decimal("0"),
    )
    sleeve_promotion_blockers: dict[str, list[str]] = {}
    promotion_contract_blockers: list[str] = []
    promotion_contract_blocker_observations: list[str] = []
    for bundle in selected:
        blockers = [
            str(blocker)
            for blocker in (
                *evidence_bundle_blockers(bundle),
                *cast(
                    Sequence[Any],
                    bundle.promotion_readiness.get("blockers") or (),
                ),
            )
            if str(blocker)
        ]
        if blockers:
            unique_blockers = list(dict.fromkeys(blockers))
            sleeve_promotion_blockers[bundle.candidate_id] = unique_blockers
            promotion_contract_blocker_observations.extend(blockers)
            promotion_contract_blockers.extend(unique_blockers)
    promotion_contract_blockers = list(dict.fromkeys(promotion_contract_blockers))
    scorecard = {
        "net_pnl_per_day": str(net_per_day),
        "portfolio_post_cost_net_pnl_per_day": str(net_per_day),
        "portfolio_post_cost_net_pnl_basis": POST_COST_PNL_BASIS
        if all_selected_have_ledger_pnl_basis
        else "",
        "portfolio_post_cost_net_pnl_source": PORTFOLIO_RUNTIME_LEDGER_PNL_SOURCE
        if all_selected_have_ledger_pnl_source
        else "",
        "runtime_ledger_pnl_basis": POST_COST_PNL_BASIS
        if all_selected_have_ledger_pnl_basis
        else "",
        "runtime_ledger_pnl_source": PORTFOLIO_RUNTIME_LEDGER_PNL_SOURCE
        if all_selected_have_ledger_pnl_source
        else "",
        "target_net_pnl_per_day": str(target_net_pnl_per_day),
        "target_met": net_per_day >= target_net_pnl_per_day,
        "portfolio_weighting_mode": _portfolio_weighting_mode(
            selected, oracle_policy=oracle_policy
        ),
        "portfolio_sleeve_weights": {
            bundle.candidate_id: str(weight)
            for bundle, weight in zip(selected, weights, strict=True)
        },
        "active_day_ratio": str(active_day_ratio),
        "positive_day_ratio": str(positive_day_ratio),
        "min_daily_net_pnl": str(min_day),
        "worst_day_loss": str(worst_day_loss),
        "max_drawdown": str(_max_drawdown_from_daily(daily_net)),
        "max_gross_exposure_pct_equity": str(
            _portfolio_max_gross_exposure_pct_equity(
                selected, oracle_policy=oracle_policy
            )
        ),
        "min_cash": str(_portfolio_min_cash(selected, oracle_policy=oracle_policy)),
        "negative_cash_observation_count": _portfolio_negative_cash_observation_count(
            selected
        ),
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
        "trading_day_count": trading_day_count,
        "daily_net_observed_day_count": len(daily_net),
        "missing_daily_net_count": missing_day_count,
        "missing_sleeve_daily_net_count": missing_sleeve_daily_net_count,
        "regime_slice_pass_rate": str(_mean(regime_pass_rates)),
        "posterior_edge_lower": str(min(posterior_lowers, default=Decimal("0"))),
        "shadow_parity_status": "within_budget"
        if shadow_statuses == {"within_budget"}
        else "missing",
        "executable_replay_passed": bool(selected)
        and all(_executable_replay_passed(bundle) for bundle in selected),
        "executable_replay_order_count": executable_order_count,
        "executable_replay_artifact_refs": executable_artifact_refs,
        "executable_replay_artifact_ref": executable_artifact_refs[0]
        if executable_artifact_refs
        else "",
        "exact_replay_ledger_artifact_refs": exact_replay_ledger_artifact_refs,
        "exact_replay_ledger_artifact_ref": exact_replay_ledger_artifact_refs[0]
        if exact_replay_ledger_artifact_refs
        else "",
        "exact_replay_ledger_artifact_row_count": exact_replay_ledger_row_count,
        "exact_replay_ledger_artifact_fill_count": exact_replay_ledger_fill_count,
        "executable_replay_account_buying_power": str(
            min(executable_buying_powers, default=Decimal("0"))
        ),
        "executable_replay_max_notional_per_trade": str(
            max(executable_max_notionals, default=Decimal("0"))
        ),
        "market_impact_stress_passed": bool(selected)
        and all(_market_impact_stress_passed(bundle) for bundle in selected),
        "market_impact_stress_artifact_refs": market_impact_artifact_refs,
        "market_impact_stress_artifact_ref": market_impact_artifact_refs[0]
        if market_impact_artifact_refs
        else "",
        "market_impact_stress_model": "portfolio_nonlinear_impact",
        "market_impact_stress_models": market_impact_models,
        "market_impact_stress_cost_bps": str(market_impact_max_cost_bps),
        "market_impact_stress_components": {
            "selected_models": market_impact_models,
            "max_selected_cost_bps": str(market_impact_max_cost_bps),
            "sleeves": market_impact_components_by_sleeve,
            "source_marker": "realistic_market_impact_arxiv_2603_29086_2026",
        },
        "nonlinear_market_impact_stress_passed": bool(selected)
        and all(_market_impact_stress_passed(bundle) for bundle in selected),
        "nonlinear_market_impact_stress_model": "portfolio_nonlinear_impact",
        "nonlinear_market_impact_stress_cost_bps": str(market_impact_max_cost_bps),
        "nonlinear_market_impact_stress_net_pnl_per_day": str(
            market_impact_stress_net_pnl_per_day
        ),
        "market_impact_liquidity_evidence_present": bool(selected)
        and all(
            _market_impact_liquidity_evidence_present(bundle) for bundle in selected
        ),
        "market_impact_stress_net_pnl_per_day": str(
            market_impact_stress_net_pnl_per_day
        ),
        "implementation_uncertainty_required": implementation_uncertainty_required,
        "implementation_uncertainty_model": "portfolio_impact_latency_cost_interval",
        "implementation_uncertainty_model_count": implementation_uncertainty_model_count,
        "implementation_uncertainty_stability_passed": bool(selected)
        and all(
            _implementation_uncertainty_stability_passed(bundle) for bundle in selected
        )
        and (
            not implementation_uncertainty_required
            or implementation_uncertainty_lower_net_pnl_per_day
            >= target_net_pnl_per_day
        ),
        "implementation_uncertainty_lower_net_pnl_per_day": str(
            implementation_uncertainty_lower_net_pnl_per_day
        ),
        "implementation_uncertainty_upper_net_pnl_per_day": str(
            implementation_uncertainty_upper_net_pnl_per_day
        ),
        "implementation_uncertainty_interval_width_per_day": str(
            implementation_uncertainty_interval_width_per_day
        ),
        "implementation_uncertainty_target_net_pnl_per_day": str(
            target_net_pnl_per_day
        ),
        "implementation_uncertainty_source_markers": [
            "lob_simulation_reality_gap_arxiv_2603_24137_2026",
            "order_flow_market_impact_volatility_arxiv_2601_23172_2026",
            "implementation_risk_backtesting_arxiv_2603_20319_2026",
        ],
        "conformal_tail_risk_required": conformal_tail_risk_required,
        "conformal_tail_risk_model": "portfolio_empirical_daily_loss_conformal_buffer",
        "conformal_tail_risk_alpha": str(CONFORMAL_TAIL_RISK_ALPHA),
        "conformal_tail_risk_sample_count": len(values),
        "conformal_tail_risk_buffer_per_day": str(conformal_tail_risk_buffer_per_day),
        "conformal_tail_risk_adjusted_net_pnl_per_day": str(
            conformal_tail_risk_adjusted_net_pnl_per_day
        ),
        "conformal_tail_risk_target_net_pnl_per_day": str(target_net_pnl_per_day),
        "conformal_tail_risk_passed": conformal_tail_risk_passed,
        "conformal_tail_risk_source_markers": [
            "regime_weighted_conformal_var_arxiv_2602_03903_2026"
        ],
        "delay_adjusted_depth_stress_passed": bool(selected)
        and all(_delay_adjusted_depth_stress_passed(bundle) for bundle in selected),
        "delay_adjusted_depth_liquidity_evidence_present": bool(selected)
        and all(
            _delay_adjusted_depth_liquidity_evidence_present(bundle)
            for bundle in selected
        ),
        "delay_adjusted_depth_liquidity_missing_day_count": sum(
            _delay_adjusted_depth_liquidity_missing_day_count(bundle)
            for bundle in selected
        ),
        "delay_adjusted_depth_tail_coverage_passed": bool(selected)
        and all(
            _delay_adjusted_depth_tail_coverage_passed(bundle) for bundle in selected
        ),
        "delay_adjusted_depth_fill_survival_evidence_present": fill_survival_evidence_present,
        "delay_adjusted_depth_fill_survival_sample_count": fill_survival_sample_count,
        "delay_adjusted_depth_fill_survival_rate": str(fill_survival_rate),
        "fill_survival_evidence_present": fill_survival_evidence_present,
        "fill_survival_sample_count": fill_survival_sample_count,
        "fill_survival_fill_rate": str(fill_survival_rate),
        "queue_position_survival_fill_curve_evidence_present": (
            queue_position_survival_evidence_present
        ),
        "queue_position_survival_sample_count": (queue_position_survival_sample_count),
        "queue_position_survival_fill_rate": str(queue_position_survival_fill_rate),
        "queue_position_survival_queue_ratio_p95": str(
            queue_position_survival_queue_ratio_p95
        ),
        "queue_position_survival_queue_ahead_depletion_evidence_present": (
            queue_ahead_depletion_evidence_present
        ),
        "queue_position_survival_queue_ahead_depletion_sample_count": (
            queue_ahead_depletion_sample_count
        ),
        "delay_adjusted_depth_queue_ahead_depletion_evidence_present": (
            queue_ahead_depletion_evidence_present
        ),
        "delay_adjusted_depth_queue_ahead_depletion_sample_count": (
            queue_ahead_depletion_sample_count
        ),
        "queue_ahead_depletion_evidence_present": (
            queue_ahead_depletion_evidence_present
        ),
        "queue_ahead_depletion_sample_count": queue_ahead_depletion_sample_count,
        "delay_adjusted_depth_stress_artifact_refs": delay_depth_artifact_refs,
        "delay_adjusted_depth_stress_artifact_ref": delay_depth_artifact_refs[0]
        if delay_depth_artifact_refs
        else "",
        "delay_adjusted_depth_stress_model": "portfolio_latency_depth_haircut",
        "delay_adjusted_depth_stress_ms": str(
            max(
                (_delay_adjusted_depth_stress_ms(bundle) for bundle in selected),
                default=Decimal("0"),
            )
        ),
        "delay_adjusted_depth_latency_grid_ms": ["50", "150", "250"],
        "delay_adjusted_depth_grid_max_stress_ms": "250",
        "delay_adjusted_depth_fillable_notional_per_day": str(
            delay_depth_fillable_notional_per_day
        ),
        "delay_adjusted_depth_worst_active_day_fillable_notional": str(
            delay_depth_worst_active_day_fillable_notional
        ),
        "delay_adjusted_depth_p10_active_day_fillable_notional": str(
            delay_depth_p10_active_day_fillable_notional
        ),
        "delay_adjusted_depth_stress_net_pnl_per_day": str(
            delay_depth_stress_net_pnl_per_day
        ),
        "post_cost_net_pnl_after_queue_position_survival_fill_stress": str(
            queue_position_survival_stress_net_pnl_per_day
        ),
        "double_oos_passed": bool(selected)
        and all(_double_oos_passed(bundle) for bundle in selected),
        "double_oos_artifact_refs": double_oos_artifact_refs,
        "double_oos_artifact_ref": double_oos_artifact_refs[0]
        if double_oos_artifact_refs
        else "",
        "double_oos_independent_window_count": double_oos_independent_window_count,
        "double_oos_pass_rate": str(double_oos_pass_rate),
        "double_oos_net_pnl_per_day": str(double_oos_net_pnl_per_day),
        "double_oos_cost_shock_net_pnl_per_day": str(
            double_oos_cost_shock_net_pnl_per_day
        ),
        "daily_net": {day: str(value) for day, value in sorted(daily_net.items())},
        "daily_filled_notional": {
            day: str(value) for day, value in sorted(daily_notional.items())
        },
        "sleeve_promotion_readiness_blockers": sleeve_promotion_blockers,
        "promotion_contract_blockers": promotion_contract_blockers,
        "validation_contract_pending_count": sum(
            1
            for blocker in promotion_contract_blocker_observations
            if blocker == "validation_contract_pending"
        ),
        "validation_live_paper_parity_pending_count": sum(
            1
            for blocker in promotion_contract_blocker_observations
            if blocker == "validation_live_paper_parity_pending"
        ),
        "synthetic_evidence_not_promotion_proof_count": sum(
            1
            for blocker in promotion_contract_blocker_observations
            if blocker == "synthetic_evidence_not_promotion_proof"
        ),
    }
    scorecard["profit_target_oracle"] = evaluate_profit_target_oracle(
        scorecard,
        target_net_pnl_per_day=target_net_pnl_per_day,
        policy=oracle_policy,
    )
    scorecard["oracle_passed"] = bool(scorecard["profit_target_oracle"]["passed"])
    return scorecard


def _sleeve_score(bundle: CandidateEvidenceBundle) -> Decimal:
    scorecard = _scorecard(bundle)
    deployable_lower_bound = deployable_lower_bound_net_pnl_per_day(scorecard)
    return (
        (
            deployable_lower_bound
            if deployable_lower_bound is not None
            else _net_per_day(bundle)
        )
        + (_active_ratio(bundle) * Decimal("300"))
        + (_positive_ratio(bundle) * Decimal("150"))
        - (_worst_day_loss(bundle) * Decimal("0.50"))
        - (_max_drawdown(bundle) * Decimal("0.10"))
        - (_best_day_share(bundle) * Decimal("300"))
    )


def _scorecard_decimal(scorecard: Mapping[str, Any], field: str) -> Decimal:
    return _decimal(scorecard.get(field))


def _oracle_blocker_count(scorecard: Mapping[str, Any]) -> Decimal:
    oracle = scorecard.get("profit_target_oracle")
    if not isinstance(oracle, Mapping):
        return Decimal("0")
    oracle_mapping = cast(Mapping[Any, Any], oracle)
    blockers = oracle_mapping.get("blockers")
    if isinstance(blockers, Sequence) and not isinstance(blockers, str):
        return Decimal(len(cast(Sequence[Any], blockers)))
    return Decimal("0")


def _portfolio_selection_key(
    *,
    selected: Sequence[CandidateEvidenceBundle],
    scorecard: Mapping[str, Any],
) -> tuple[Decimal, ...]:
    # Once no portfolio fully passes the oracle, the next best promotion target is
    # the one with the smallest repair surface, not the one with the largest raw PnL.
    return (
        Decimal(1 if bool(scorecard.get("oracle_passed")) else 0),
        -_oracle_blocker_count(scorecard),
        Decimal(1 if bool(scorecard.get("target_met")) else 0),
        _scorecard_decimal(scorecard, "active_day_ratio"),
        _scorecard_decimal(scorecard, "positive_day_ratio"),
        _scorecard_decimal(scorecard, "min_daily_net_pnl"),
        (
            deployable_lower_bound_net_pnl_per_day(scorecard)
            or _scorecard_decimal(scorecard, "net_pnl_per_day")
        ),
        Decimal(1 if bool(scorecard.get("market_impact_stress_passed")) else 0),
        _scorecard_decimal(scorecard, "market_impact_stress_net_pnl_per_day"),
        -_scorecard_decimal(scorecard, "market_impact_stress_cost_bps"),
        Decimal(1 if bool(scorecard.get("delay_adjusted_depth_stress_passed")) else 0),
        _scorecard_decimal(scorecard, "delay_adjusted_depth_stress_net_pnl_per_day"),
        _scorecard_decimal(scorecard, "delay_adjusted_depth_fillable_notional_per_day"),
        -_scorecard_decimal(scorecard, "delay_adjusted_depth_stress_ms"),
        Decimal(
            1
            if bool(scorecard.get("implementation_uncertainty_stability_passed"))
            else 0
        ),
        _scorecard_decimal(
            scorecard, "implementation_uncertainty_lower_net_pnl_per_day"
        ),
        -_scorecard_decimal(
            scorecard, "implementation_uncertainty_interval_width_per_day"
        ),
        Decimal(1 if bool(scorecard.get("conformal_tail_risk_passed")) else 0),
        _scorecard_decimal(scorecard, "conformal_tail_risk_adjusted_net_pnl_per_day"),
        -_scorecard_decimal(scorecard, "conformal_tail_risk_buffer_per_day"),
        Decimal(1 if bool(scorecard.get("double_oos_passed")) else 0),
        _scorecard_decimal(scorecard, "double_oos_independent_window_count"),
        _scorecard_decimal(scorecard, "double_oos_pass_rate"),
        _scorecard_decimal(scorecard, "double_oos_net_pnl_per_day"),
        _scorecard_decimal(scorecard, "double_oos_cost_shock_net_pnl_per_day"),
        -_scorecard_decimal(scorecard, "missing_sleeve_daily_net_count"),
        -_scorecard_decimal(scorecard, "best_day_share"),
        -_scorecard_decimal(scorecard, "max_single_symbol_contribution_share"),
        -_scorecard_decimal(scorecard, "max_cluster_contribution_share"),
        _scorecard_decimal(scorecard, "avg_filled_notional_per_day"),
        _scorecard_decimal(scorecard, "net_pnl_per_day"),
        -_scorecard_decimal(scorecard, "max_gross_exposure_pct_equity"),
        _scorecard_decimal(scorecard, "min_cash"),
        -_scorecard_decimal(scorecard, "negative_cash_observation_count"),
        -_scorecard_decimal(scorecard, "worst_day_loss"),
        -_scorecard_decimal(scorecard, "max_drawdown"),
        Decimal(len(selected)),
        sum((_sleeve_score(bundle) for bundle in selected), Decimal("0")),
    )


def _empty_selection_key() -> tuple[Decimal, ...]:
    return (
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
    )


def _portfolio_addition_rejection(
    *,
    bundle: CandidateEvidenceBundle,
    selected: Sequence[CandidateEvidenceBundle],
    requested_portfolio_size_min: int,
    max_allowed_correlation: Decimal,
) -> dict[str, Any] | None:
    max_correlation = _max_pairwise_correlation(bundle, selected)
    if selected and max_correlation > max_allowed_correlation:
        return {
            "candidate_id": bundle.candidate_id,
            "reason": "correlation_cap",
            "max_pairwise_correlation": str(max_correlation),
        }
    return None


def _record_unique_rejection(
    rejected: list[dict[str, Any]],
    seen_rejections: set[tuple[str, str]],
    rejection: Mapping[str, Any],
) -> None:
    key = (_string(rejection.get("candidate_id")), _string(rejection.get("reason")))
    if key in seen_rejections:
        return
    seen_rejections.add(key)
    rejected.append(dict(rejection))


def _selected_from_state(
    ordered: Sequence[CandidateEvidenceBundle],
    state: tuple[int, ...],
) -> tuple[CandidateEvidenceBundle, ...]:
    return tuple(ordered[index] for index in state)


def _select_portfolio_bundles(
    *,
    ordered: Sequence[CandidateEvidenceBundle],
    rejected: list[dict[str, Any]],
    target_net_pnl_per_day: Decimal,
    oracle_policy: ProfitTargetOraclePolicy,
    requested_portfolio_size_min: int,
    requested_portfolio_size_max: int,
    max_allowed_correlation: Decimal,
) -> tuple[list[CandidateEvidenceBundle], dict[str, Any]] | None:
    if len(ordered) < requested_portfolio_size_min:
        return None

    seen_rejections = {
        (_string(item.get("candidate_id")), _string(item.get("reason")))
        for item in rejected
    }
    scorecard_cache: dict[tuple[int, ...], dict[str, Any]] = {}

    def state_scorecard(state: tuple[int, ...]) -> dict[str, Any]:
        cached = scorecard_cache.get(state)
        if cached is not None:
            return cached
        scorecard = _portfolio_scorecard(
            selected=_selected_from_state(ordered, state),
            target_net_pnl_per_day=target_net_pnl_per_day,
            oracle_policy=oracle_policy,
        )
        scorecard_cache[state] = scorecard
        return scorecard

    def state_sort_key(state: tuple[int, ...]) -> tuple[tuple[Decimal, ...], str]:
        selected = _selected_from_state(ordered, state)
        if not selected:
            quality_key = _empty_selection_key()
        else:
            quality_key = _portfolio_selection_key(
                selected=selected,
                scorecard=state_scorecard(state),
            )
        return (quality_key, "|".join(bundle.candidate_id for bundle in selected))

    beam: list[tuple[int, ...]] = [()]
    candidate_state_count = 0
    pruned_state_count = 0
    for bundle_index, bundle in enumerate(ordered):
        next_states = list(beam)
        for state in beam:
            if len(state) >= requested_portfolio_size_max:
                continue
            selected = _selected_from_state(ordered, state)
            rejection = _portfolio_addition_rejection(
                bundle=bundle,
                selected=selected,
                requested_portfolio_size_min=requested_portfolio_size_min,
                max_allowed_correlation=max_allowed_correlation,
            )
            if rejection is not None:
                _record_unique_rejection(rejected, seen_rejections, rejection)
                continue
            next_states.append((*state, bundle_index))
            candidate_state_count += 1
        unique_next_states = list(dict.fromkeys(next_states))
        unique_next_states.sort(key=state_sort_key, reverse=True)
        if len(unique_next_states) > PORTFOLIO_SEARCH_BEAM_WIDTH:
            pruned_state_count += len(unique_next_states) - PORTFOLIO_SEARCH_BEAM_WIDTH
        beam = unique_next_states[:PORTFOLIO_SEARCH_BEAM_WIDTH]

    finalists: list[tuple[tuple[tuple[Decimal, ...], str], tuple[int, ...]]] = []
    for state in beam:
        if len(state) < requested_portfolio_size_min:
            continue
        finalists.append((state_sort_key(state), state))
    if not finalists:
        return None
    finalists.sort(key=lambda item: item[0], reverse=True)
    selected_state = finalists[0][1]
    selected = list(_selected_from_state(ordered, selected_state))
    return selected, {
        "beam_width": PORTFOLIO_SEARCH_BEAM_WIDTH,
        "candidate_state_count": candidate_state_count,
        "portfolio_state_count": len(scorecard_cache),
        "pruned_state_count": pruned_state_count,
        "finalist_state_count": len(finalists),
        "search_input_count": len(ordered),
    }


def _portfolio_candidate_id(
    source_candidate_ids: Sequence[str], target: Decimal
) -> str:
    return portfolio_candidate_id_for_payload(
        {"source_candidate_ids": list(source_candidate_ids), "target": str(target)}
    )


def optimize_portfolio_candidate(
    *,
    evidence_bundles: Sequence[CandidateEvidenceBundle],
    target_net_pnl_per_day: Decimal = Decimal("300"),
    oracle_policy: ProfitTargetOraclePolicy | None = None,
    portfolio_size_min: int = 2,
    portfolio_size_max: int = 8,
) -> PortfolioCandidateSpec | None:
    oracle_policy = oracle_policy or ProfitTargetOraclePolicy()
    requested_portfolio_size_min = max(1, int(portfolio_size_min))
    requested_portfolio_size_max = max(1, int(portfolio_size_max))
    invalid_evidence_rejections = [
        {
            "candidate_id": bundle.candidate_id,
            "reason": "invalid_evidence_bundle",
            "blockers": list(evidence_bundle_blockers(bundle)),
        }
        for bundle in evidence_bundles
        if not evidence_bundle_is_valid(bundle)
    ]
    hard_veto_rejections = [
        {
            "candidate_id": bundle.candidate_id,
            "reason": "frontier_non_composable_hard_veto",
            "hard_vetoes": list(_non_composable_hard_vetoes(bundle)),
        }
        for bundle in evidence_bundles
        if evidence_bundle_is_valid(bundle) and _non_composable_hard_vetoes(bundle)
    ]
    capital_safety_rejections = [
        rejection
        for rejection in (
            _capital_safety_rejection(bundle, oracle_policy=oracle_policy)
            for bundle in evidence_bundles
            if evidence_bundle_is_valid(bundle)
        )
        if rejection is not None
    ]
    eligible = [
        bundle
        for bundle in evidence_bundles
        if _candidate_passes_minimums(bundle, oracle_policy=oracle_policy)
    ]
    ordered = _diversified_candidate_order(
        sorted(
            eligible,
            key=lambda item: (
                _sleeve_score(item),
                _net_per_day(item),
                item.candidate_id,
            ),
            reverse=True,
        )
    )
    rejected: list[dict[str, Any]] = [
        *invalid_evidence_rejections,
        *hard_veto_rejections,
        *capital_safety_rejections,
    ]
    max_allowed_correlation = MAX_ALLOWED_PAIRWISE_CORRELATION
    selection_result = _select_portfolio_bundles(
        ordered=ordered,
        rejected=rejected,
        target_net_pnl_per_day=target_net_pnl_per_day,
        oracle_policy=oracle_policy,
        requested_portfolio_size_min=requested_portfolio_size_min,
        requested_portfolio_size_max=requested_portfolio_size_max,
        max_allowed_correlation=max_allowed_correlation,
    )
    if selection_result is None:
        return None
    selected, search_report = selection_result
    selected_clusters = {_cluster_id(bundle) for bundle in selected}

    source_candidate_ids = tuple(item.candidate_id for item in selected)
    objective_scorecard = _portfolio_scorecard(
        selected=selected,
        target_net_pnl_per_day=target_net_pnl_per_day,
        oracle_policy=oracle_policy,
    )
    max_drawdown = _decimal(objective_scorecard.get("max_drawdown"))
    sleeves: list[Mapping[str, Any]] = []
    weights = _portfolio_weights(selected, oracle_policy=oracle_policy)
    for sleeve_index, bundle in enumerate(selected, start=1):
        weight = weights[sleeve_index - 1]
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
                "weight": str(weight),
                "signal": _scorecard_signal(bundle),
                "params": dict(_scorecard_runtime_params(bundle)),
                "universe_symbols": _scorecard_universe_symbols(bundle),
                **_scorecard_sleeve_runtime_limits(bundle),
                "expected_net_pnl_per_day": str(_net_per_day(bundle) * weight),
                "source_expected_net_pnl_per_day": str(_net_per_day(bundle)),
                "risk_contribution": str(_max_drawdown(bundle) * weight),
                "source_risk_contribution": str(_max_drawdown(bundle)),
                "correlation_cluster": _string(
                    _scorecard(bundle).get("correlation_cluster")
                )
                or bundle.candidate_spec_id,
                "daily_net": {
                    day: str(value) for day, value in sorted(_daily_net(bundle).items())
                },
                "double_oos": {
                    "passed": _double_oos_passed(bundle),
                    "independent_window_count": _double_oos_independent_window_count(
                        bundle
                    ),
                    "pass_rate": str(_double_oos_pass_rate(bundle)),
                    "net_pnl_per_day": str(_double_oos_net_per_day(bundle)),
                    "cost_shock_net_pnl_per_day": str(
                        _double_oos_cost_shock_net_per_day(bundle)
                    ),
                    "artifact_ref": _double_oos_artifact_ref(bundle),
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
        "method": "deterministic_beam_promotion_ready_search_v2",
        "selection_priority": "oracle_passed_then_blocker_minimized_then_target_met",
        **search_report,
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
            "mode": _portfolio_weighting_mode(selected, oracle_policy=oracle_policy),
            "max_sleeves": portfolio_size_max,
            "sleeve_weights": {
                bundle.candidate_id: str(weight)
                for bundle, weight in zip(selected, weights, strict=True)
            },
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
