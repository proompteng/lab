#!/usr/bin/env python3
"""Run a whitepaper-driven autoresearch epoch targeting a portfolio profit objective."""

from __future__ import annotations

from typing import Any, Mapping, Sequence


from app.trading.discovery.candidate_specs import (
    CandidateSpec,
)
from app.trading.discovery.evidence_bundles import (
    CandidateEvidenceBundle,
)
from app.trading.discovery.mlx_training_data import build_mlx_training_rows
from app.trading.discovery.mlx_training_data import (
    rank_training_rows_with_lift_policy,
    train_mlx_ranker,
)
from app.trading.discovery.profit_target_oracle import (
    ProfitTargetOraclePolicy,
)


from scripts.whitepaper_autoresearch_runner.candidate_board_fields import (
    _candidate_board_int_field,
)
from scripts.whitepaper_autoresearch_runner.common import (
    _decimal,
    _mapping,
    _string,
    _list_of_mappings,
    _rank_sort_value,
    _proposal_sort_value,
    _string_list_from_value,
    _oracle_blockers,
)

from scripts.whitepaper_autoresearch_runner.oracle_policy import (
    _risk_adjusted_drawdown_passes,
    _scorecard_profit_factor,
    _scorecard_start_equity,
    _scorecard_total_net_pnl,
)

from scripts.whitepaper_autoresearch_runner.proposal_building import (
    _selection_reason_blocks_replay,
)

_DEFAULT_RANKER_BACKEND_PREFERENCE = "mlx"


def _proposal_model_and_rows(
    *,
    specs: Sequence[CandidateSpec],
    evidence_bundles: Sequence[CandidateEvidenceBundle],
    ranker_backend_preference: str = _DEFAULT_RANKER_BACKEND_PREFERENCE,
    replay_selection_by_spec: Mapping[str, Mapping[str, Any]] | None = None,
) -> tuple[Mapping[str, Any], list[dict[str, Any]]]:
    training_rows = build_mlx_training_rows(
        candidate_specs=specs, evidence_bundles=evidence_bundles
    )
    model = train_mlx_ranker(
        training_rows, backend_preference=ranker_backend_preference
    )
    feature_by_spec = {
        row.candidate_spec_id: row.to_payload()["features"] for row in training_rows
    }
    net_by_spec = {
        bundle.candidate_spec_id: float(
            _decimal(bundle.objective_scorecard.get("net_pnl_per_day"))
        )
        for bundle in evidence_bundles
    }
    policy_result = rank_training_rows_with_lift_policy(
        model=model,
        rows=training_rows,
        metric_name="net_pnl_per_day",
        outcome_by_spec=net_by_spec,
    )
    proposal_rows = [
        {
            "candidate_spec_id": item.candidate_spec_id,
            "proposal_score": item.score,
            "rank": item.rank,
            "backend": item.backend,
            "model_id": item.model_id,
            "selection_reason": policy_result.selection_reason,
            "replay_selection_reason": _mapping(
                replay_selection_by_spec.get(item.candidate_spec_id)
                if replay_selection_by_spec is not None
                else None
            ).get("selection_reason", "not_selected_budget"),
            "selected_for_replay": bool(
                _mapping(
                    replay_selection_by_spec.get(item.candidate_spec_id)
                    if replay_selection_by_spec is not None
                    else None
                ).get("selected_for_replay")
            ),
            "feature_hash": item.feature_hash,
            "features": feature_by_spec.get(item.candidate_spec_id, {}),
        }
        for item in policy_result.ranked_rows
    ]
    model_payload = {
        **model.to_payload(),
        "rank_bucket_lift": policy_result.rank_bucket_lift.to_payload(),
        "model_status": policy_result.model_status,
    }
    return model_payload, proposal_rows


def _candidate_quality_gate_failures(
    scorecard: Mapping[str, Any], *, oracle_policy: ProfitTargetOraclePolicy
) -> list[str]:
    failures: list[str] = []
    start_equity = _scorecard_start_equity(scorecard, oracle_policy=oracle_policy)
    total_net_pnl = _scorecard_total_net_pnl(scorecard)
    if _decimal(scorecard.get("net_pnl_per_day")) <= 0:
        failures.append("non_positive_net_pnl_per_day")
    if _decimal(scorecard.get("active_day_ratio")) < oracle_policy.min_active_day_ratio:
        failures.append("active_day_ratio_below_oracle")
    if (
        _decimal(scorecard.get("positive_day_ratio"))
        < oracle_policy.min_positive_day_ratio
    ):
        failures.append("positive_day_ratio_below_oracle")
    if _scorecard_profit_factor(scorecard) < oracle_policy.min_profit_factor:
        failures.append("profit_factor_below_oracle")
    if (
        _decimal(scorecard.get("best_day_share"), default="1")
        > oracle_policy.max_best_day_share
    ):
        failures.append("best_day_share_above_oracle")
    if not _risk_adjusted_drawdown_passes(
        observed=_decimal(scorecard.get("worst_day_loss"), default="999999"),
        start_equity=start_equity,
        normal_pct=oracle_policy.max_worst_day_loss_pct_equity,
        extended_pct=oracle_policy.extended_max_worst_day_loss_pct_equity,
        absolute_cap=oracle_policy.max_worst_day_loss,
        total_net_pnl=total_net_pnl,
        min_total_net_pnl_to_drawdown_ratio=oracle_policy.min_total_net_pnl_to_drawdown_ratio,
    ):
        failures.append("worst_day_loss_above_oracle")
    if not _risk_adjusted_drawdown_passes(
        observed=_decimal(scorecard.get("max_drawdown"), default="999999"),
        start_equity=start_equity,
        normal_pct=oracle_policy.max_drawdown_pct_equity,
        extended_pct=oracle_policy.extended_max_drawdown_pct_equity,
        absolute_cap=oracle_policy.max_drawdown,
        total_net_pnl=total_net_pnl,
        min_total_net_pnl_to_drawdown_ratio=oracle_policy.min_total_net_pnl_to_drawdown_ratio,
    ):
        failures.append("max_drawdown_above_oracle")
    if (
        _decimal(scorecard.get("max_gross_exposure_pct_equity"))
        > oracle_policy.max_gross_exposure_pct_equity
    ):
        failures.append("max_gross_exposure_above_oracle")
    if _decimal(scorecard.get("min_cash")) < oracle_policy.min_cash:
        failures.append("min_cash_below_oracle")
    if (
        int(_decimal(scorecard.get("negative_cash_observation_count")))
        > oracle_policy.max_negative_cash_observation_count
    ):
        failures.append("negative_cash_observed")
    if (
        _decimal(scorecard.get("avg_filled_notional_per_day"))
        < oracle_policy.min_avg_filled_notional_per_day
    ):
        failures.append("avg_filled_notional_per_day_below_oracle")
    if (
        _decimal(scorecard.get("regime_slice_pass_rate"))
        < oracle_policy.min_regime_slice_pass_rate
    ):
        failures.append("regime_slice_pass_rate_below_oracle")
    if (
        _decimal(scorecard.get("posterior_edge_lower"))
        <= oracle_policy.min_posterior_edge_lower
    ):
        failures.append("posterior_edge_lower_non_positive")
    if _string(scorecard.get("shadow_parity_status")) != "within_budget":
        failures.append("shadow_parity_status_not_within_budget")
    if oracle_policy.require_executable_replay:
        if str(scorecard.get("executable_replay_passed")).lower() != "true":
            failures.append("executable_replay_not_passed")
        if not _string(scorecard.get("executable_replay_artifact_ref")):
            failures.append("executable_replay_artifact_missing")
        executable_order_count = int(
            _decimal(
                scorecard.get("executable_replay_order_count")
                or scorecard.get("executable_replay_submitted_order_count")
                or scorecard.get("executable_replay_orders_submitted_total")
            )
        )
        if executable_order_count < oracle_policy.min_executable_order_count:
            failures.append("executable_replay_order_count_below_oracle")
        replay_buying_power = _decimal(
            scorecard.get("executable_replay_account_buying_power")
            or scorecard.get("executable_replay_buying_power")
        )
        replay_max_notional = _decimal(
            scorecard.get("executable_replay_max_notional_per_trade")
            or scorecard.get("executable_replay_max_notional_per_order")
        )
        if replay_buying_power <= 0:
            failures.append("executable_replay_account_buying_power_missing")
        if replay_max_notional <= 0:
            failures.append("executable_replay_max_notional_missing")
        if (
            oracle_policy.require_executable_replay_notional_within_buying_power
            and replay_max_notional > replay_buying_power
        ):
            failures.append("executable_replay_notional_exceeds_buying_power")
    for blocker in sorted(_oracle_blockers(scorecard)):
        if blocker not in failures:
            failures.append(blocker)
    return failures


def _false_positive_table(
    *,
    proposal_rows: Sequence[Mapping[str, Any]],
    evidence_bundles: Sequence[CandidateEvidenceBundle],
    oracle_policy: ProfitTargetOraclePolicy,
    limit: int = 16,
) -> list[dict[str, Any]]:
    evidence_by_spec = {bundle.candidate_spec_id: bundle for bundle in evidence_bundles}
    rows: list[dict[str, Any]] = []
    for proposal in _list_of_mappings(list(proposal_rows)):
        candidate_spec_id = _string(proposal.get("candidate_spec_id"))
        if not candidate_spec_id or not bool(proposal.get("selected_for_replay")):
            continue
        evidence = evidence_by_spec.get(candidate_spec_id)
        if evidence is None:
            rows.append(
                {
                    "candidate_spec_id": candidate_spec_id,
                    "candidate_id": None,
                    "rank": _rank_sort_value(proposal.get("rank")),
                    "proposal_score": proposal.get("proposal_score"),
                    "replay_selection_reason": _string(
                        proposal.get("replay_selection_reason")
                    )
                    or "selected_for_replay",
                    "evidence_status": "missing",
                    "failure_reasons": ["replay_evidence_missing"],
                }
            )
            continue
        scorecard = evidence.objective_scorecard
        failure_reasons = _candidate_quality_gate_failures(
            scorecard, oracle_policy=oracle_policy
        )
        if not failure_reasons:
            continue
        rows.append(
            {
                "candidate_spec_id": candidate_spec_id,
                "candidate_id": evidence.candidate_id,
                "rank": _rank_sort_value(proposal.get("rank")),
                "proposal_score": proposal.get("proposal_score"),
                "replay_selection_reason": _string(
                    proposal.get("replay_selection_reason")
                )
                or "selected_for_replay",
                "evidence_status": "replayed",
                "net_pnl_per_day": _string(scorecard.get("net_pnl_per_day")),
                "active_day_ratio": _string(scorecard.get("active_day_ratio")),
                "positive_day_ratio": _string(scorecard.get("positive_day_ratio")),
                "best_day_share": _string(scorecard.get("best_day_share")),
                "worst_day_loss": _string(scorecard.get("worst_day_loss")),
                "max_drawdown": _string(scorecard.get("max_drawdown")),
                "avg_filled_notional_per_day": _string(
                    scorecard.get("avg_filled_notional_per_day")
                ),
                "regime_slice_pass_rate": _string(
                    scorecard.get("regime_slice_pass_rate")
                ),
                "posterior_edge_lower": _string(scorecard.get("posterior_edge_lower")),
                "shadow_parity_status": _string(scorecard.get("shadow_parity_status")),
                "failure_reasons": failure_reasons,
            }
        )
    rows.sort(
        key=lambda row: (
            _rank_sort_value(row.get("rank")),
            -_proposal_sort_value(row.get("proposal_score")),
            _string(row.get("candidate_spec_id")),
        )
    )
    return rows[: max(0, limit)]


def _replay_diagnostic_proposal_rows(
    *,
    candidate_selection: Mapping[str, Any],
    pre_replay_proposal_rows: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    pre_replay_by_spec = {
        _string(row.get("candidate_spec_id")): row
        for row in _list_of_mappings(list(pre_replay_proposal_rows))
        if _string(row.get("candidate_spec_id"))
    }
    rows: list[dict[str, Any]] = []
    for selection in _list_of_mappings(candidate_selection.get("rows")):
        candidate_spec_id = _string(selection.get("candidate_spec_id"))
        if not candidate_spec_id:
            continue
        pre_replay = pre_replay_by_spec.get(candidate_spec_id, {})
        rows.append(
            {
                **dict(pre_replay),
                "candidate_spec_id": candidate_spec_id,
                "proposal_score": pre_replay.get("proposal_score"),
                "rank": _rank_sort_value(selection.get("rank")),
                "pre_replay_score": _string(selection.get("pre_replay_score")),
                "paper_contract_prior_score": _string(
                    selection.get("paper_contract_prior_score")
                ),
                "paper_mechanism_overlay_ids": _string_list_from_value(
                    selection.get("paper_mechanism_overlay_ids")
                ),
                "paper_required_evidence_tokens": _string_list_from_value(
                    selection.get("paper_required_evidence_tokens")
                ),
                "paper_required_evidence_count": _candidate_board_int_field(
                    selection, "paper_required_evidence_count"
                ),
                "selected_for_replay": bool(selection.get("selected_for_replay")),
                "replay_selection_reason": _string(selection.get("selection_reason"))
                or "not_selected_budget",
            }
        )
    return rows


def _best_false_negative_table(
    *,
    candidate_selection: Mapping[str, Any],
    pre_replay_proposal_rows: Sequence[Mapping[str, Any]],
    evidence_bundles: Sequence[CandidateEvidenceBundle],
    limit: int = 16,
) -> list[dict[str, Any]]:
    evidence_by_spec = {bundle.candidate_spec_id: bundle for bundle in evidence_bundles}
    pre_replay_by_spec = {
        _string(row.get("candidate_spec_id")): row
        for row in _list_of_mappings(list(pre_replay_proposal_rows))
        if _string(row.get("candidate_spec_id"))
    }
    rows: list[dict[str, Any]] = []
    for selection in _list_of_mappings(candidate_selection.get("rows")):
        candidate_spec_id = _string(selection.get("candidate_spec_id"))
        if (
            not candidate_spec_id
            or bool(selection.get("selected_for_replay"))
            or candidate_spec_id in evidence_by_spec
            or _string(selection.get("selection_reason"))
            == "duplicate_execution_signature"
            or _selection_reason_blocks_replay(
                _string(selection.get("selection_reason"))
            )
        ):
            continue
        pre_replay = pre_replay_by_spec.get(candidate_spec_id, {})
        rows.append(
            {
                "candidate_spec_id": candidate_spec_id,
                "candidate_id": None,
                "rank": _rank_sort_value(selection.get("rank")),
                "pre_replay_score": _string(selection.get("pre_replay_score")),
                "paper_contract_prior_score": _string(
                    selection.get("paper_contract_prior_score")
                ),
                "paper_mechanism_overlay_ids": _string_list_from_value(
                    selection.get("paper_mechanism_overlay_ids")
                ),
                "paper_required_evidence_tokens": _string_list_from_value(
                    selection.get("paper_required_evidence_tokens")
                ),
                "paper_required_evidence_count": _candidate_board_int_field(
                    selection, "paper_required_evidence_count"
                ),
                "proposal_score": pre_replay.get("proposal_score"),
                "selection_reason": _string(selection.get("selection_reason"))
                or "not_selected_budget",
                "selected_for_replay": False,
                "evidence_status": "not_replayed",
                "reason": "not_replayed_budget",
            }
        )
    rows.sort(
        key=lambda row: (
            _rank_sort_value(row.get("rank")),
            -_proposal_sort_value(row.get("proposal_score")),
            _string(row.get("candidate_spec_id")),
        )
    )
    return rows[: max(0, limit)]


def _recent_trading_days_shortfall(failure_reason: str) -> dict[str, int] | None:
    marker = "insufficient_recent_trading_days:"
    marker_index = failure_reason.find(marker)
    if marker_index < 0:
        return None
    remainder = failure_reason[marker_index + len(marker) :]
    token = remainder.splitlines()[0].split()[0] if remainder.strip() else ""
    available_text, separator, required_text = token.partition("<")
    if separator != "<":
        return None
    try:
        available = int(available_text)
        required = int(required_text)
    except ValueError:
        return None
    return {
        "available_recent_trading_days": available,
        "required_recent_trading_days": required,
        "missing_recent_trading_days": max(0, required - available),
    }


def _stale_tape_diagnostics(failure_reason: str) -> dict[str, str] | None:
    marker = "stale_tape:"
    marker_index = failure_reason.find(marker)
    if marker_index < 0:
        return None
    remainder = failure_reason[marker_index + len(marker) :].splitlines()[0]
    fields: dict[str, str] = {}
    for token in remainder.split(":"):
        key, separator, value = token.partition("=")
        if separator == "=" and key and value:
            fields[key] = value
    expected = fields.get("expected_last_trading_day")
    end_day = fields.get("end_day")
    if not expected or not end_day:
        return None
    return {
        "expected_last_trading_day": expected,
        "available_end_day": end_day,
    }


__all__ = [
    "_proposal_model_and_rows",
    "_candidate_quality_gate_failures",
    "_false_positive_table",
    "_replay_diagnostic_proposal_rows",
    "_best_false_negative_table",
    "_recent_trading_days_shortfall",
    "_stale_tape_diagnostics",
]
