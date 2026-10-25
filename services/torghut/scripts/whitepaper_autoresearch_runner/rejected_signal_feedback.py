#!/usr/bin/env python3
"""Run a whitepaper-driven autoresearch epoch targeting a portfolio profit objective."""

from __future__ import annotations

from typing import Any, Mapping, Sequence, cast


from app.models import (
    AutoresearchPortfolioCandidate,
    RejectedSignalOutcomeEvent,
)
from app.trading.discovery.evidence_bundles import (
    CandidateEvidenceBundle,
    evidence_bundle_from_frontier_candidate,
    evidence_bundle_from_payload,
)


from scripts.whitepaper_autoresearch_runner.common import (
    _stable_hash,
    _mapping,
    _string,
    _list_of_mappings,
    _string_list_from_value,
    _oracle_blockers,
)

from scripts.whitepaper_autoresearch_runner.feedback_risk_profiles import (
    _feedback_risk_profile_key_payload,
)

from scripts.whitepaper_autoresearch_runner.feedback_loading import (
    _outcome_payload_has_complete_rejected_signal_fields,
)

_PORTFOLIO_FEEDBACK_STATUSES = frozenset({"blocked", "paper_probation", "target_met"})


def _rejected_signal_outcome_payload_to_feedback_bundle(
    row: RejectedSignalOutcomeEvent,
    *,
    code_commit: str = "unknown",
) -> CandidateEvidenceBundle | None:
    outcome_payload = _mapping(row.outcome_payload_json)
    if not outcome_payload:
        return None
    if not _outcome_payload_has_complete_rejected_signal_fields(
        outcome_payload, cast(Sequence[Any], row.required_outcome_fields_json or ())
    ):
        return None

    embedded_bundle = _mapping(outcome_payload.get("candidate_evidence_bundle_payload"))
    if embedded_bundle:
        return evidence_bundle_from_payload(embedded_bundle)
    if (
        _string(outcome_payload.get("schema_version"))
        == "torghut.candidate-evidence-bundle.v1"
    ):
        return evidence_bundle_from_payload(outcome_payload)

    event_payload = _mapping(row.event_payload_json)
    scorecard = _mapping(outcome_payload.get("objective_scorecard"))
    if not scorecard:
        scorecard = {}
    for key in (
        "net_pnl_per_day",
        "active_day_ratio",
        "positive_day_ratio",
        "best_day_share",
        "max_drawdown",
        "worst_day_loss",
        "avg_filled_notional_per_day",
        "market_impact_stress_net_pnl_per_day",
        "delay_adjusted_depth_stress_net_pnl_per_day",
        "counterfactual_return",
        "route_tca",
        "post_cost_net_pnl",
        "executable_quote",
    ):
        if key in outcome_payload and key not in scorecard:
            scorecard = {**scorecard, key: outcome_payload[key]}
    scorecard = {
        **scorecard,
        "rejected_signal_event_id": row.event_id,
        "rejected_signal_symbol": row.symbol,
        "rejected_signal_reason": row.reject_reason,
        "rejected_signal_outcome_label_status": row.outcome_label_status,
    }

    candidate_spec_id = _string(outcome_payload.get("candidate_spec_id")) or _string(
        event_payload.get("candidate_spec_id")
    )
    family_template_id = _string(outcome_payload.get("family_template_id")) or _string(
        event_payload.get("family_template_id")
    )
    runtime_family = _string(outcome_payload.get("runtime_family")) or _string(
        event_payload.get("runtime_family")
    )
    runtime_strategy_name = _string(
        outcome_payload.get("runtime_strategy_name")
    ) or _string(event_payload.get("runtime_strategy_name"))
    execution_signature = _string(
        outcome_payload.get("execution_signature")
    ) or _string(event_payload.get("execution_signature"))
    feedback_shape_key = _string(outcome_payload.get("feedback_shape_key")) or _string(
        event_payload.get("feedback_shape_key")
    )
    feedback_risk_profile_key = _string(
        outcome_payload.get("feedback_risk_profile_key")
    ) or _string(event_payload.get("feedback_risk_profile_key"))
    if not (
        candidate_spec_id
        or family_template_id
        or execution_signature
        or feedback_shape_key
        or feedback_risk_profile_key
    ):
        return None

    candidate_id = (
        _string(outcome_payload.get("candidate_id"))
        or _string(event_payload.get("candidate_id"))
        or f"rejected-signal-{row.event_id}"
    )
    candidate = {
        "candidate_id": candidate_id,
        "family_template_id": family_template_id,
        "runtime_family": runtime_family,
        "runtime_strategy_name": runtime_strategy_name,
        "execution_signature": execution_signature,
        "feedback_shape_key": feedback_shape_key,
        "feedback_risk_profile_key": feedback_risk_profile_key,
        "objective_scorecard": scorecard,
        "hard_vetoes": outcome_payload.get("hard_vetoes")
        or outcome_payload.get("veto_reasons")
        or scorecard.get("hard_vetoes")
        or scorecard.get("veto_reasons")
        or (),
        "promotion_readiness": _mapping(outcome_payload.get("promotion_readiness"))
        or {
            "stage": "research_candidate",
            "status": "blocked_by_rejected_signal_counterfactual_feedback",
            "promotable": False,
            "blockers": [
                "requires_full_replay_validation",
                "requires_live_paper_parity",
            ],
        },
    }
    return evidence_bundle_from_frontier_candidate(
        candidate_spec_id=candidate_spec_id,
        candidate=candidate,
        dataset_snapshot_id=f"rejected-signal-outcome:{row.event_id}",
        result_path=f"db://rejected_signal_outcome_events/{row.event_id}",
        code_commit=code_commit,
    )


def _ordered_unique_strings(values: Sequence[Any]) -> tuple[str, ...]:
    seen: set[str] = set()
    unique: list[str] = []
    for value in values:
        text = _string(value)
        if not text or text in seen:
            continue
        seen.add(text)
        unique.append(text)
    return tuple(unique)


def _portfolio_candidate_feedback_blockers(
    *,
    scorecard: Mapping[str, Any],
    payload: Mapping[str, Any],
) -> tuple[str, ...]:
    blockers: list[Any] = list(_oracle_blockers(scorecard))
    promotion_readiness = _mapping(payload.get("promotion_readiness"))
    for source in (scorecard, promotion_readiness):
        for key in ("hard_vetoes", "veto_reasons", "blockers"):
            raw = source.get(key)
            if isinstance(raw, Sequence) and not isinstance(raw, str):
                blockers.extend(cast(Sequence[Any], raw))
    return _ordered_unique_strings(blockers)


def _portfolio_sleeve_feedback_metadata(
    sleeve: Mapping[str, Any],
) -> dict[str, Any]:
    params = _mapping(sleeve.get("params"))
    universe_symbols = [
        symbol.upper()
        for symbol in _string_list_from_value(sleeve.get("universe_symbols"))
    ]
    universe_key = ",".join(sorted(universe_symbols))
    signal_key = "|".join(
        part
        for part in (
            _string(params.get("signal_motif")) or _string(sleeve.get("signal")),
            _string(params.get("selection_mode")),
            _string(params.get("rank_feature")),
        )
        if part
    )
    family_template_id = _string(sleeve.get("family_template_id"))
    runtime_family = _string(sleeve.get("runtime_family"))
    runtime_strategy_name = _string(sleeve.get("runtime_strategy_name"))
    execution_profile_id = _string(sleeve.get("execution_profile_id"))
    risk_profile_payload = _feedback_risk_profile_key_payload(
        family_template_id=family_template_id,
        runtime_strategy_name=runtime_strategy_name,
        execution_profile_id=execution_profile_id,
        universe_key=universe_key,
        signal_key=signal_key,
    )
    shape_payload = {
        "family_template_id": family_template_id,
        "runtime_family": runtime_family,
        "runtime_strategy_name": runtime_strategy_name,
        "execution_profile_id": execution_profile_id,
        "universe_key": universe_key,
        "signal_key": signal_key,
        "capital_profile": _string(params.get("capital_profile")),
        "entry_minute_after_open": _string(params.get("entry_minute_after_open")),
        "exit_minute_after_open": _string(params.get("exit_minute_after_open")),
        "entry_start_minute_utc": _string(params.get("entry_start_minute_utc")),
        "entry_end_minute_utc": _string(params.get("entry_end_minute_utc")),
        "max_entries_per_session": _string(params.get("max_entries_per_session")),
        "max_concurrent_positions": _string(params.get("max_concurrent_positions")),
        "top_n": _string(params.get("top_n")),
        "max_pair_legs": _string(params.get("max_pair_legs")),
        "long_stop_loss_bps": _string(params.get("long_stop_loss_bps")),
        "short_stop_loss_bps": _string(params.get("short_stop_loss_bps")),
        "max_session_negative_exit_bps": _string(
            params.get("max_session_negative_exit_bps")
        ),
    }
    metadata: dict[str, Any] = {
        "family_template_id": family_template_id,
        "runtime_family": runtime_family,
        "runtime_strategy_name": runtime_strategy_name,
        "execution_signature": _string(sleeve.get("execution_signature")),
        "execution_profile_id": execution_profile_id,
        "universe_key": universe_key,
        "signal_key": signal_key,
        "runtime_params": dict(params),
        "universe_symbols": universe_symbols,
    }
    if any(_string(value) for value in risk_profile_payload.values()):
        metadata["feedback_risk_profile_key"] = _stable_hash(risk_profile_payload)
    if any(_string(value) for value in shape_payload.values()):
        metadata["feedback_shape_key"] = _stable_hash(shape_payload)
    return metadata


def _portfolio_candidate_row_to_feedback_bundles(
    row: AutoresearchPortfolioCandidate,
    *,
    code_commit: str = "unknown",
) -> tuple[CandidateEvidenceBundle, ...]:
    status = _string(row.status)
    if status not in _PORTFOLIO_FEEDBACK_STATUSES:
        return ()
    payload = _mapping(row.payload_json)
    scorecard = _mapping(row.objective_scorecard_json) or _mapping(
        payload.get("objective_scorecard")
    )
    if not scorecard:
        return ()
    blockers = _portfolio_candidate_feedback_blockers(
        scorecard=scorecard, payload=payload
    )
    sleeves = _list_of_mappings(payload.get("sleeves"))
    if not sleeves:
        sleeves = [
            {"candidate_id": candidate_id, "candidate_spec_id": candidate_id}
            for candidate_id in _string_list_from_value(row.source_candidate_ids_json)
        ]
    bundles: list[CandidateEvidenceBundle] = []
    dataset_snapshot_id = (
        f"autoresearch-portfolio-candidate:{row.epoch_id}:{row.portfolio_candidate_id}"
    )
    promotion_readiness = _mapping(payload.get("promotion_readiness")) or {
        "stage": "research_portfolio",
        "status": f"blocked_by_prior_portfolio_candidate:{status}",
        "promotable": False,
        "blockers": list(blockers),
    }
    for index, sleeve in enumerate(sleeves, start=1):
        candidate_id = _string(sleeve.get("candidate_id")) or _string(
            sleeve.get("candidate_spec_id")
        )
        candidate_spec_id = _string(sleeve.get("candidate_spec_id")) or candidate_id
        if not candidate_spec_id:
            continue
        metadata = _portfolio_sleeve_feedback_metadata(sleeve)
        sleeve_scorecard = {
            **scorecard,
            **metadata,
            "candidate_id": candidate_id or candidate_spec_id,
            "candidate_spec_id": candidate_spec_id,
            "portfolio_candidate_id": row.portfolio_candidate_id,
            "portfolio_epoch_id": row.epoch_id,
            "portfolio_status": status,
            "portfolio_target_net_pnl_per_day": str(row.target_net_pnl_per_day),
            "portfolio_blockers": list(blockers),
            "hard_vetoes": list(blockers),
            "veto_reasons": list(blockers),
            "sleeve_weight": _string(sleeve.get("weight")),
            "sleeve_expected_net_pnl_per_day": _string(
                sleeve.get("expected_net_pnl_per_day")
            ),
            "source_expected_net_pnl_per_day": _string(
                sleeve.get("source_expected_net_pnl_per_day")
            ),
            "sleeve_risk_contribution": _string(sleeve.get("risk_contribution")),
            "source_risk_contribution": _string(sleeve.get("source_risk_contribution")),
            "correlation_cluster": _string(sleeve.get("correlation_cluster")),
        }
        candidate = {
            "candidate_id": candidate_id or candidate_spec_id,
            **metadata,
            "objective_scorecard": sleeve_scorecard,
            "hard_vetoes": blockers,
            "promotion_readiness": promotion_readiness,
        }
        bundles.append(
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=candidate_spec_id,
                candidate=candidate,
                dataset_snapshot_id=dataset_snapshot_id,
                result_path=(
                    f"db://autoresearch_portfolio_candidates/"
                    f"{row.portfolio_candidate_id}/sleeves/{index}"
                ),
                code_commit=code_commit,
            )
        )
    return tuple(bundles)


__all__ = [
    "_rejected_signal_outcome_payload_to_feedback_bundle",
    "_ordered_unique_strings",
    "_portfolio_candidate_feedback_blockers",
    "_portfolio_sleeve_feedback_metadata",
    "_portfolio_candidate_row_to_feedback_bundles",
]
