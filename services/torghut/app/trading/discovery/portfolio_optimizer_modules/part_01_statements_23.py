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
        int(_decimal(scorecard.get("exact_replay_ledger_artifact_row_count"))),
    )


def _exact_replay_ledger_fill_count(bundle: CandidateEvidenceBundle) -> int:
    scorecard = _scorecard(bundle)
    return max(
        0,
        int(_decimal(scorecard.get("exact_replay_ledger_artifact_fill_count"))),
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


__all__ = [name for name in globals() if not name.startswith("__")]
