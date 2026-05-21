"""Distribution-aware objectives and ranking for Harness v2."""

from __future__ import annotations

from dataclasses import dataclass, replace
from decimal import Decimal, InvalidOperation
from typing import Iterable, Mapping, Any


DEPLOYABLE_LOWER_BOUND_SCORECARD_KEYS = (
    "net_pnl_per_day",
    "market_impact_stress_net_pnl_per_day",
    "delay_adjusted_depth_stress_net_pnl_per_day",
    "double_oos_cost_shock_net_pnl_per_day",
    "implementation_uncertainty_lower_net_pnl_per_day",
)

DEPLOYABLE_PROOF_GATE_KEYS = (
    "market_impact_stress_passed",
    "delay_adjusted_depth_stress_passed",
    "double_oos_passed",
    "implementation_uncertainty_stability_passed",
)


@dataclass(frozen=True)
class ObjectiveVetoPolicy:
    required_min_active_day_ratio: Decimal = Decimal("0")
    required_min_daily_notional: Decimal = Decimal("0")
    required_max_best_day_share: Decimal = Decimal("1")
    required_max_worst_day_loss: Decimal = Decimal("999999999")
    required_max_drawdown: Decimal = Decimal("999999999")
    required_min_regime_slice_pass_rate: Decimal = Decimal("0")
    required_max_gross_exposure_pct_equity: Decimal = Decimal("999999999")
    required_min_cash: Decimal = Decimal("-999999999")

    def to_payload(self) -> dict[str, str]:
        return {
            "required_min_active_day_ratio": str(self.required_min_active_day_ratio),
            "required_min_daily_notional": str(self.required_min_daily_notional),
            "required_max_best_day_share": str(self.required_max_best_day_share),
            "required_max_worst_day_loss": str(self.required_max_worst_day_loss),
            "required_max_drawdown": str(self.required_max_drawdown),
            "required_min_regime_slice_pass_rate": str(
                self.required_min_regime_slice_pass_rate
            ),
            "required_max_gross_exposure_pct_equity": str(
                self.required_max_gross_exposure_pct_equity
            ),
            "required_min_cash": str(self.required_min_cash),
        }


@dataclass(frozen=True)
class CandidateObjectiveScorecard:
    candidate_id: str
    net_pnl_per_day: Decimal
    active_day_ratio: Decimal
    positive_day_ratio: Decimal
    avg_filled_notional_per_day: Decimal
    avg_filled_notional_per_active_day: Decimal
    worst_day_loss: Decimal
    max_drawdown: Decimal
    best_day_share: Decimal
    negative_day_count: int
    rolling_3d_lower_bound: Decimal
    rolling_5d_lower_bound: Decimal
    regime_slice_pass_rate: Decimal
    symbol_concentration_share: Decimal
    entry_family_contribution_share: Decimal
    max_gross_exposure_pct_equity: Decimal = Decimal("0")
    min_cash: Decimal = Decimal("0")
    negative_cash_observation_count: int = 0
    deployable_lower_bound_net_pnl_per_day: Decimal | None = None
    veto_reasons: tuple[str, ...] = ()
    pareto_tier: int | None = None
    tie_breaker_score: Decimal | None = None

    def with_ranking(
        self,
        *,
        veto_reasons: tuple[str, ...],
        pareto_tier: int,
        tie_breaker_score: Decimal,
    ) -> "CandidateObjectiveScorecard":
        return replace(
            self,
            veto_reasons=veto_reasons,
            pareto_tier=pareto_tier,
            tie_breaker_score=tie_breaker_score,
        )

    def to_payload(self) -> dict[str, object]:
        return {
            "candidate_id": self.candidate_id,
            "net_pnl_per_day": str(self.net_pnl_per_day),
            "active_day_ratio": str(self.active_day_ratio),
            "positive_day_ratio": str(self.positive_day_ratio),
            "avg_filled_notional_per_day": str(self.avg_filled_notional_per_day),
            "avg_filled_notional_per_active_day": str(
                self.avg_filled_notional_per_active_day
            ),
            "worst_day_loss": str(self.worst_day_loss),
            "max_drawdown": str(self.max_drawdown),
            "best_day_share": str(self.best_day_share),
            "negative_day_count": self.negative_day_count,
            "rolling_3d_lower_bound": str(self.rolling_3d_lower_bound),
            "rolling_5d_lower_bound": str(self.rolling_5d_lower_bound),
            "regime_slice_pass_rate": str(self.regime_slice_pass_rate),
            "symbol_concentration_share": str(self.symbol_concentration_share),
            "entry_family_contribution_share": str(
                self.entry_family_contribution_share
            ),
            "max_gross_exposure_pct_equity": str(self.max_gross_exposure_pct_equity),
            "min_cash": str(self.min_cash),
            "negative_cash_observation_count": self.negative_cash_observation_count,
            "deployable_lower_bound_net_pnl_per_day": (
                str(self.deployable_lower_bound_net_pnl_per_day)
                if self.deployable_lower_bound_net_pnl_per_day is not None
                else None
            ),
            "veto_reasons": list(self.veto_reasons),
            "pareto_tier": self.pareto_tier,
            "tie_breaker_score": str(self.tie_breaker_score)
            if self.tie_breaker_score is not None
            else None,
        }


def _decimal_or_none(value: Any) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, str) and not value.strip():
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    normalized = str(value or "").strip().lower()
    return normalized in {"1", "true", "yes", "pass", "passed"}


def deployable_lower_bound_net_pnl_per_day(
    scorecard: Mapping[str, Any],
) -> Decimal | None:
    values = tuple(
        value
        for key in DEPLOYABLE_LOWER_BOUND_SCORECARD_KEYS
        if (value := _decimal_or_none(scorecard.get(key))) is not None
    )
    if not values:
        return None
    return min(values)


def deployable_lower_bound_missing_count(scorecard: Mapping[str, Any]) -> int:
    if not scorecard:
        return 0
    return sum(
        1
        for key in DEPLOYABLE_LOWER_BOUND_SCORECARD_KEYS
        if _decimal_or_none(scorecard.get(key)) is None
    )


def deployable_proof_failed_gate_count(scorecard: Mapping[str, Any]) -> int:
    if not scorecard:
        return 0
    return sum(
        1 for key in DEPLOYABLE_PROOF_GATE_KEYS if not _truthy(scorecard.get(key))
    )


def _ranking_profitability(scorecard: CandidateObjectiveScorecard) -> Decimal:
    return (
        scorecard.deployable_lower_bound_net_pnl_per_day
        if scorecard.deployable_lower_bound_net_pnl_per_day is not None
        else scorecard.net_pnl_per_day
    )


def build_scorecard(
    *,
    candidate_id: str,
    trading_day_count: int,
    net_pnl_per_day: Decimal,
    active_days: int,
    positive_days: int,
    avg_filled_notional_per_day: Decimal,
    avg_filled_notional_per_active_day: Decimal,
    worst_day_loss: Decimal,
    max_drawdown: Decimal,
    best_day_share: Decimal,
    negative_day_count: int,
    rolling_3d_lower_bound: Decimal,
    rolling_5d_lower_bound: Decimal,
    regime_slice_pass_rate: Decimal,
    symbol_concentration_share: Decimal,
    entry_family_contribution_share: Decimal,
    max_gross_exposure_pct_equity: Decimal = Decimal("0"),
    min_cash: Decimal = Decimal("0"),
    negative_cash_observation_count: int = 0,
    deployable_lower_bound_net_pnl_per_day: Decimal | None = None,
) -> CandidateObjectiveScorecard:
    day_count = max(trading_day_count, 1)
    return CandidateObjectiveScorecard(
        candidate_id=candidate_id,
        net_pnl_per_day=net_pnl_per_day,
        active_day_ratio=Decimal(active_days) / Decimal(day_count),
        positive_day_ratio=Decimal(positive_days) / Decimal(day_count),
        avg_filled_notional_per_day=avg_filled_notional_per_day,
        avg_filled_notional_per_active_day=avg_filled_notional_per_active_day,
        worst_day_loss=worst_day_loss,
        max_drawdown=max_drawdown,
        best_day_share=best_day_share,
        negative_day_count=negative_day_count,
        rolling_3d_lower_bound=rolling_3d_lower_bound,
        rolling_5d_lower_bound=rolling_5d_lower_bound,
        regime_slice_pass_rate=regime_slice_pass_rate,
        symbol_concentration_share=symbol_concentration_share,
        entry_family_contribution_share=entry_family_contribution_share,
        max_gross_exposure_pct_equity=max_gross_exposure_pct_equity,
        min_cash=min_cash,
        negative_cash_observation_count=negative_cash_observation_count,
        deployable_lower_bound_net_pnl_per_day=deployable_lower_bound_net_pnl_per_day,
    )


def evaluate_vetoes(
    scorecard: CandidateObjectiveScorecard,
    *,
    policy: ObjectiveVetoPolicy,
    is_fresh: bool,
) -> tuple[str, ...]:
    reasons: list[str] = []
    if scorecard.active_day_ratio < policy.required_min_active_day_ratio:
        reasons.append("active_day_ratio_below_min")
    if scorecard.avg_filled_notional_per_day < policy.required_min_daily_notional:
        reasons.append("avg_daily_notional_below_min")
    if scorecard.best_day_share > policy.required_max_best_day_share:
        reasons.append("best_day_share_above_max")
    if scorecard.worst_day_loss > policy.required_max_worst_day_loss:
        reasons.append("worst_day_loss_above_max")
    if scorecard.max_drawdown > policy.required_max_drawdown:
        reasons.append("max_drawdown_above_max")
    if scorecard.regime_slice_pass_rate < policy.required_min_regime_slice_pass_rate:
        reasons.append("regime_slice_pass_rate_below_min")
    if (
        scorecard.max_gross_exposure_pct_equity
        > policy.required_max_gross_exposure_pct_equity
    ):
        reasons.append("gross_exposure_pct_equity_above_max")
    if scorecard.min_cash < policy.required_min_cash:
        reasons.append("min_cash_below_min")
    if not is_fresh:
        reasons.append("stale_tape")
    return tuple(reasons)


def _maximize_metrics(scorecard: CandidateObjectiveScorecard) -> tuple[Decimal, ...]:
    return (
        _ranking_profitability(scorecard),
        scorecard.active_day_ratio,
        scorecard.positive_day_ratio,
        scorecard.avg_filled_notional_per_day,
        scorecard.avg_filled_notional_per_active_day,
        scorecard.rolling_3d_lower_bound,
        scorecard.rolling_5d_lower_bound,
        scorecard.regime_slice_pass_rate,
        scorecard.min_cash,
    )


def _minimize_metrics(scorecard: CandidateObjectiveScorecard) -> tuple[Decimal, ...]:
    return (
        scorecard.worst_day_loss,
        scorecard.max_drawdown,
        scorecard.best_day_share,
        Decimal(scorecard.negative_day_count),
        scorecard.symbol_concentration_share,
        scorecard.entry_family_contribution_share,
        scorecard.max_gross_exposure_pct_equity,
        Decimal(scorecard.negative_cash_observation_count),
    )


def dominates(
    left: CandidateObjectiveScorecard, right: CandidateObjectiveScorecard
) -> bool:
    left_max = _maximize_metrics(left)
    right_max = _maximize_metrics(right)
    left_min = _minimize_metrics(left)
    right_min = _minimize_metrics(right)
    not_worse = all(
        left_value >= right_value
        for left_value, right_value in zip(left_max, right_max, strict=True)
    ) and all(
        left_value <= right_value
        for left_value, right_value in zip(left_min, right_min, strict=True)
    )
    strictly_better = any(
        left_value > right_value
        for left_value, right_value in zip(left_max, right_max, strict=True)
    ) or any(
        left_value < right_value
        for left_value, right_value in zip(left_min, right_min, strict=True)
    )
    return not_worse and strictly_better


def tie_breaker(scorecard: CandidateObjectiveScorecard) -> Decimal:
    return (
        _ranking_profitability(scorecard)
        + (scorecard.active_day_ratio * Decimal("300"))
        + (scorecard.positive_day_ratio * Decimal("150"))
        + (scorecard.avg_filled_notional_per_day / Decimal("10000"))
        + (scorecard.regime_slice_pass_rate * Decimal("100"))
        + scorecard.rolling_3d_lower_bound
        + scorecard.rolling_5d_lower_bound
        + (scorecard.min_cash / Decimal("10000"))
        - (scorecard.worst_day_loss * Decimal("0.5"))
        - (scorecard.max_drawdown * Decimal("0.1"))
        - (scorecard.best_day_share * Decimal("500"))
        - (scorecard.symbol_concentration_share * Decimal("100"))
        - (scorecard.entry_family_contribution_share * Decimal("25"))
        - (scorecard.max_gross_exposure_pct_equity * Decimal("50"))
        - (Decimal(scorecard.negative_day_count) * Decimal("20"))
        - (Decimal(scorecard.negative_cash_observation_count) * Decimal("5"))
    )


def rank_scorecards(
    scorecards: Iterable[CandidateObjectiveScorecard],
    *,
    veto_lookup: Mapping[str, tuple[str, ...]],
) -> list[CandidateObjectiveScorecard]:
    scorecard_list = list(scorecards)
    viable: list[CandidateObjectiveScorecard] = []
    for scorecard in scorecard_list:
        if not veto_lookup.get(scorecard.candidate_id):
            viable.append(scorecard)
    remaining: list[CandidateObjectiveScorecard] = list(viable)
    tier_lookup: dict[str, int] = {}
    tier = 1
    while remaining:
        frontier: list[CandidateObjectiveScorecard] = []
        for candidate in remaining:
            dominated = False
            for other in remaining:
                if other.candidate_id == candidate.candidate_id:
                    continue
                if dominates(other, candidate):
                    dominated = True
                    break
            if dominated:
                continue
            frontier.append(candidate)
        for candidate in frontier:
            tier_lookup[candidate.candidate_id] = tier
        next_remaining: list[CandidateObjectiveScorecard] = []
        for candidate in remaining:
            if candidate.candidate_id not in tier_lookup:
                next_remaining.append(candidate)
        remaining = next_remaining
        tier += 1

    ranked: list[CandidateObjectiveScorecard] = []
    for scorecard in scorecard_list:
        reasons = veto_lookup.get(scorecard.candidate_id, ())
        resolved_tier = tier_lookup.get(
            scorecard.candidate_id, 999 if reasons else tier
        )
        ranked.append(
            scorecard.with_ranking(
                veto_reasons=tuple(reasons),
                pareto_tier=resolved_tier,
                tie_breaker_score=tie_breaker(scorecard),
            )
        )
    ranked.sort(
        key=lambda item: (
            len(item.veto_reasons) > 0,
            item.pareto_tier if item.pareto_tier is not None else 999,
            -(item.tie_breaker_score or Decimal("0")),
            -_ranking_profitability(item),
        )
    )
    return ranked
