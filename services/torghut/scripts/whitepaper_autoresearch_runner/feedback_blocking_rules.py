#!/usr/bin/env python3
"""Run a whitepaper-driven autoresearch epoch targeting a portfolio profit objective."""

from __future__ import annotations

from decimal import Decimal
from typing import Any, Mapping, Sequence, cast


from app.trading.discovery.evidence_bundles import (
    CandidateEvidenceBundle,
)
from app.trading.discovery.profit_target_oracle import (
    ProfitTargetOraclePolicy,
)


from scripts.whitepaper_autoresearch_runner.common import (
    _stable_hash,
    _decimal,
    _string,
    _boolish,
    _oracle_blockers,
)

from scripts.whitepaper_autoresearch_runner.feedback_risk_profiles import (
    _feedback_risk_profile_key_payload,
)

_FAMILY_PRIOR_HARD_BLOCK_ORACLE_BLOCKERS = frozenset(
    {
        "active_day_ratio_below_oracle",
        "positive_day_ratio_below_oracle",
        "best_day_share_above_oracle",
    }
)

_RISK_PROFILE_FEEDBACK_ORACLE_BLOCKERS = frozenset(
    {
        "active_day_ratio_below_oracle",
        "positive_day_ratio_below_oracle",
        "best_day_share_above_oracle",
        "active_day_ratio_failed",
        "positive_day_ratio_failed",
        "min_daily_net_pnl_failed",
        "daily_net_observed_day_count_failed",
        "best_day_share_failed",
        "max_single_day_contribution_share_failed",
        "max_single_symbol_contribution_share_failed",
        "max_cluster_contribution_share_failed",
    }
)

_REPLAY_ACTIVITY_COUNT_KEYS = (
    "decision_count",
    "trade_decision_count",
    "paper_decision_count",
    "runtime_decision_count",
    "orders_submitted_count",
    "submitted_order_count",
    "filled_count",
    "fill_count",
    "filled_order_count",
)


def _feedback_scorecard_has_hard_veto(scorecard: Mapping[str, Any]) -> bool:
    if _oracle_blockers(scorecard):
        return True
    oracle_passed = scorecard.get("oracle_passed")
    if oracle_passed is not None and not _boolish(oracle_passed):
        return True
    hard_vetoes = scorecard.get("hard_vetoes") or scorecard.get("veto_reasons")
    if isinstance(hard_vetoes, str):
        return bool(hard_vetoes.strip())
    if isinstance(hard_vetoes, Sequence) and not isinstance(hard_vetoes, str):
        return any(_string(item) for item in hard_vetoes)
    return False


def _feedback_daily_net_has_loss(scorecard: Mapping[str, Any]) -> bool:
    daily_net = scorecard.get("daily_net")
    if not isinstance(daily_net, Mapping):
        return False
    return any(
        _decimal(value, default="0") <= Decimal("0")
        for value in cast(Mapping[Any, Any], daily_net).values()
    )


def _feedback_has_no_replay_activity(scorecard: Mapping[str, Any]) -> bool:
    explicit_activity = False
    for key in _REPLAY_ACTIVITY_COUNT_KEYS:
        if key not in scorecard:
            continue
        explicit_activity = True
        if _decimal(scorecard.get(key)) > Decimal("0"):
            return False
    if "avg_filled_notional_per_day" in scorecard:
        explicit_activity = True
        if _decimal(scorecard.get("avg_filled_notional_per_day")) > Decimal("0"):
            return False
    daily_filled_notional = scorecard.get("daily_filled_notional")
    if isinstance(daily_filled_notional, Mapping):
        explicit_activity = True
        if any(
            _decimal(value) > Decimal("0")
            for value in cast(Mapping[Any, Any], daily_filled_notional).values()
        ):
            return False
    return explicit_activity


def _feedback_family_prior_has_hard_block(
    scorecard: Mapping[str, Any],
    *,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> bool:
    policy = oracle_policy or ProfitTargetOraclePolicy()
    if _feedback_has_no_replay_activity(scorecard):
        return True
    oracle_blockers = _oracle_blockers(scorecard)
    if oracle_blockers & _FAMILY_PRIOR_HARD_BLOCK_ORACLE_BLOCKERS:
        return True
    if (
        _decimal(scorecard.get("active_day_ratio"), default="1")
        < policy.min_active_day_ratio
    ):
        return True
    if (
        _decimal(scorecard.get("positive_day_ratio"), default="1")
        < policy.min_positive_day_ratio
    ):
        return True
    if _decimal(scorecard.get("best_day_share")) > policy.max_best_day_share:
        return True
    return _feedback_has_nonpositive_expected_value(scorecard)


def _feedback_risk_profile_has_penalty(
    scorecard: Mapping[str, Any],
    *,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> bool:
    policy = oracle_policy or ProfitTargetOraclePolicy()
    if _feedback_has_no_replay_activity(scorecard):
        return True
    oracle_blockers = _oracle_blockers(scorecard)
    if oracle_blockers & _RISK_PROFILE_FEEDBACK_ORACLE_BLOCKERS:
        return True
    if (
        _decimal(scorecard.get("active_day_ratio"), default="1")
        < policy.min_active_day_ratio
    ):
        return True
    if (
        _decimal(scorecard.get("positive_day_ratio"), default="1")
        < policy.min_positive_day_ratio
    ):
        return True
    if _decimal(scorecard.get("best_day_share")) > policy.max_best_day_share:
        return True
    if (
        _decimal(scorecard.get("max_single_day_contribution_share"))
        > policy.max_best_day_share
    ):
        return True
    if (
        _decimal(scorecard.get("max_single_symbol_contribution_share"), default="1")
        > policy.max_single_symbol_contribution_share
    ):
        return True
    if (
        _decimal(scorecard.get("max_cluster_contribution_share"), default="1")
        > policy.max_cluster_contribution_share
    ):
        return True
    return False


def _feedback_risk_profile_has_terminal_block(
    scorecard: Mapping[str, Any],
    *,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> bool:
    if not scorecard:
        return False
    if _feedback_has_no_replay_activity(scorecard):
        return True
    policy = oracle_policy or ProfitTargetOraclePolicy()
    if not _feedback_risk_profile_has_penalty(scorecard, oracle_policy=policy):
        return False
    if _feedback_has_nonpositive_expected_value(scorecard):
        return True
    if (
        _decimal(scorecard.get("max_gross_exposure_pct_equity"))
        > policy.max_gross_exposure_pct_equity
    ):
        return True
    if _decimal(scorecard.get("min_cash")) < policy.min_cash:
        return True
    return _decimal(scorecard.get("negative_cash_observation_count")) > Decimal(
        max(0, policy.max_negative_cash_observation_count)
    )


def _feedback_has_policy_penalty(
    scorecard: Mapping[str, Any],
    *,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> bool:
    if _feedback_has_no_replay_activity(scorecard):
        return True
    return _feedback_risk_profile_has_penalty(
        scorecard, oracle_policy=oracle_policy
    ) or _feedback_daily_net_has_loss(scorecard)


def _feedback_is_blocked(
    scorecard: Mapping[str, Any],
    *,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> bool:
    policy = oracle_policy or ProfitTargetOraclePolicy()
    if _feedback_has_no_replay_activity(scorecard):
        return True
    if _feedback_scorecard_has_hard_veto(scorecard):
        return True
    if (
        _decimal(scorecard.get("max_gross_exposure_pct_equity"))
        > policy.max_gross_exposure_pct_equity
    ):
        return True
    if _decimal(scorecard.get("min_cash")) < policy.min_cash:
        return True
    if _decimal(scorecard.get("negative_cash_observation_count")) > Decimal(
        max(0, policy.max_negative_cash_observation_count)
    ):
        return True
    return _decimal(scorecard.get("net_pnl_per_day")) <= Decimal("0")


def _feedback_has_nonpositive_expected_value(scorecard: Mapping[str, Any]) -> bool:
    return _decimal(scorecard.get("net_pnl_per_day")) <= Decimal("0")


def _feedback_bundle_sort_value(
    bundle: CandidateEvidenceBundle,
    *,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> tuple[int, Decimal, str]:
    scorecard = bundle.objective_scorecard
    return (
        0 if _feedback_is_blocked(scorecard, oracle_policy=oracle_policy) else 1,
        _decimal(scorecard.get("net_pnl_per_day")),
        _string(bundle.candidate_id),
    )


def _feedback_family_template_id(bundle: CandidateEvidenceBundle) -> str:
    return _string(bundle.objective_scorecard.get("family_template_id"))


def _feedback_execution_signature(bundle: CandidateEvidenceBundle) -> str:
    return _string(bundle.objective_scorecard.get("execution_signature"))


def _feedback_shape_key(bundle: CandidateEvidenceBundle) -> str:
    return _string(bundle.objective_scorecard.get("feedback_shape_key"))


def _feedback_risk_profile_key_from_scorecard(scorecard: Mapping[str, Any]) -> str:
    direct_key = _string(scorecard.get("feedback_risk_profile_key"))
    if direct_key:
        return direct_key
    payload = _feedback_risk_profile_key_payload(
        family_template_id=_string(scorecard.get("family_template_id")),
        runtime_strategy_name=_string(scorecard.get("runtime_strategy_name")),
        execution_profile_id=_string(scorecard.get("execution_profile_id")),
        universe_key=_string(scorecard.get("universe_key")),
        signal_key=_string(scorecard.get("signal_key")),
    )
    if not any(_string(value) for value in payload.values()):
        return ""
    return _stable_hash(payload)


def _feedback_risk_profile_key(bundle: CandidateEvidenceBundle) -> str:
    return _feedback_risk_profile_key_from_scorecard(bundle.objective_scorecard)


__all__ = [
    "_feedback_scorecard_has_hard_veto",
    "_feedback_daily_net_has_loss",
    "_feedback_has_no_replay_activity",
    "_feedback_family_prior_has_hard_block",
    "_feedback_risk_profile_has_penalty",
    "_feedback_risk_profile_has_terminal_block",
    "_feedback_has_policy_penalty",
    "_feedback_is_blocked",
    "_feedback_has_nonpositive_expected_value",
    "_feedback_bundle_sort_value",
    "_feedback_family_template_id",
    "_feedback_execution_signature",
    "_feedback_shape_key",
    "_feedback_risk_profile_key_from_scorecard",
    "_feedback_risk_profile_key",
]
