from __future__ import annotations

from decimal import Decimal
from typing import Any, Mapping, Sequence, cast

from app.trading.discovery.candidate_specs import CandidateSpec
from app.trading.discovery.evidence_bundles import (
    CandidateEvidenceBundle,
    evidence_bundle_blockers,
)
from scripts.whitepaper_autoresearch_runner.candidate_board_fields import (
    _candidate_board_decimal_field,
    _candidate_board_first_int_field,
    _candidate_board_int_field,
)
from scripts.whitepaper_autoresearch_runner.common import (
    _SECOND_OOS_WINDOW_ID,
    _boolish,
    _candidate_spec_requires_rejected_signal_outcome_learning,
    _decimal,
    _list_of_mappings,
    _mapping,
    _string,
    _string_list_from_value,
)


def _candidate_board_rejected_signal_outcome_summary(
    spec: CandidateSpec, scorecard: Mapping[str, Any]
) -> dict[str, Any]:
    required = _candidate_spec_requires_rejected_signal_outcome_learning(spec)
    required_fields = tuple(
        _string_list_from_value(
            spec.hard_vetoes.get("required_rejected_signal_counterfactual_fields")
        )
        or (
            "counterfactual_return",
            "route_tca",
            "post_cost_net_pnl",
            "executable_quote",
        )
    )
    observed_fields = set(
        _string_list_from_value(
            scorecard.get("rejected_signal_counterfactual_fields")
            or scorecard.get("rejected_signal_outcome_counterfactual_fields")
            or scorecard.get("rejected_signal_counterfactual_fields_present")
        )
    )
    if _boolish(scorecard.get("rejected_signal_counterfactual_fields_present")):
        observed_fields.update(required_fields)
    min_label_count = _candidate_board_int_field(
        spec.hard_vetoes, "required_min_rejected_signal_outcome_label_count"
    )
    if min_label_count <= 0:
        min_label_count = 120
    max_pending_ratio = _decimal(
        spec.hard_vetoes.get("required_max_rejected_signal_outcome_pending_ratio"),
        default="0.05",
    )
    min_reason_coverage = _decimal(
        spec.hard_vetoes.get("required_min_rejected_signal_reason_coverage"),
        default="0.80",
    )
    required_persistence_state = _string(
        spec.hard_vetoes.get("required_rejected_signal_outcome_persistence_state")
        or "ok"
    ).lower()
    label_count = _candidate_board_first_int_field(
        scorecard,
        (
            "rejected_signal_outcome_labeled_count",
            "rejected_signal_outcome_label_count",
            "rejected_signal_outcome_labeled_event_count",
        ),
    )
    pending_ratio = _decimal(
        scorecard.get("rejected_signal_outcome_pending_ratio"), default="1"
    )
    reason_coverage = _decimal(
        scorecard.get("rejected_signal_reason_coverage")
        or scorecard.get("rejected_signal_outcome_reason_coverage")
    )
    persistence_state = _string(
        scorecard.get("rejected_signal_outcome_persistence_state")
        or scorecard.get("rejected_signal_persistence_state")
    ).lower()
    blockers: list[str] = []
    if required:
        if label_count < min_label_count:
            blockers.append("rejected_signal_outcome_labeled_count_failed")
        if pending_ratio > max_pending_ratio:
            blockers.append("rejected_signal_outcome_pending_ratio_failed")
        if reason_coverage < min_reason_coverage:
            blockers.append("rejected_signal_reason_coverage_failed")
        if not set(required_fields).issubset(observed_fields):
            blockers.append("rejected_signal_counterfactual_fields_present_failed")
        if persistence_state != required_persistence_state:
            blockers.append("rejected_signal_outcome_persistence_state_failed")
    return {
        "required": required,
        "passed": not blockers,
        "blockers": blockers,
        "labeled_count": label_count,
        "min_labeled_count": min_label_count,
        "pending_ratio": str(pending_ratio),
        "max_pending_ratio": str(max_pending_ratio),
        "reason_coverage": str(reason_coverage),
        "min_reason_coverage": str(min_reason_coverage),
        "persistence_state": persistence_state,
        "required_persistence_state": required_persistence_state,
        "counterfactual_fields": sorted(observed_fields),
        "required_counterfactual_fields": list(required_fields),
    }


def _candidate_spec_requires_order_type_execution_quality(spec: CandidateSpec) -> bool:
    overlay_ids = set(
        _string_list_from_value(spec.parameter_space.get("mechanism_overlay_ids"))
    )
    return (
        "mixed_market_limit_execution_policy" in overlay_ids
        or _boolish(
            spec.promotion_contract.get("requires_order_type_execution_quality")
        )
        or _boolish(spec.promotion_contract.get("requires_order_type_ablation"))
        or _boolish(spec.promotion_contract.get("requires_market_limit_order_mix"))
        or "required_order_type_ablation_passed" in spec.hard_vetoes
        or "required_market_limit_order_mix_evidence" in spec.hard_vetoes
    )


def _candidate_spec_requires_predictability_decay_stress(
    spec: CandidateSpec,
) -> bool:
    overlay_ids = set(
        _string_list_from_value(spec.parameter_space.get("mechanism_overlay_ids"))
    )
    return (
        "alpha_decay_predictability_stress" in overlay_ids
        or _boolish(spec.promotion_contract.get("requires_predictability_decay_stress"))
        or _boolish(spec.promotion_contract.get("requires_horizon_decay_curve"))
        or _boolish(
            spec.promotion_contract.get("requires_spread_adjusted_label_replay")
        )
        or "required_predictability_decay_stress" in spec.hard_vetoes
        or "required_horizon_decay_curve" in spec.hard_vetoes
        or "required_spread_adjusted_label_replay" in spec.hard_vetoes
    )


def _candidate_board_predictability_decay_summary(
    spec: CandidateSpec, scorecard: Mapping[str, Any], *, target: Decimal
) -> dict[str, Any]:
    required = _candidate_spec_requires_predictability_decay_stress(spec)
    artifact_refs = _string_list_from_value(
        scorecard.get("predictability_decay_stress_artifact_refs")
        or scorecard.get("predictability_decay_stress_artifact_ref")
        or scorecard.get("alpha_decay_stress_artifact_ref")
    )
    available_refs = set(
        _string_list_from_value(scorecard.get("replay_artifact_refs"))
        or _string_list_from_value(scorecard.get("artifact_refs"))
    )
    horizon_count = _candidate_board_first_int_field(
        scorecard,
        (
            "predictability_decay_stress_horizon_count",
            "horizon_decay_curve_horizon_count",
        ),
    )
    tight_spread_count = _candidate_board_first_int_field(
        scorecard,
        ("tight_spread_regime_slice_count", "tight_spread_regime_count"),
    )
    split_pass_rate = _decimal(
        scorecard.get("predictability_decay_stress_split_pass_rate")
        or scorecard.get("decay_stress_split_pass_rate")
    )
    best_split_share = _decimal(
        scorecard.get("predictability_decay_stress_best_split_share")
        or scorecard.get("decay_stress_best_split_share"),
        default="1",
    )
    stress_net_pnl_per_day = _decimal(
        scorecard.get("post_cost_net_pnl_after_predictability_decay_stress")
        or scorecard.get("predictability_decay_stress_net_pnl_per_day")
    )
    min_horizon_count = _candidate_board_int_field(
        spec.hard_vetoes, "required_min_decay_stress_horizon_count"
    )
    if min_horizon_count <= 0:
        min_horizon_count = 3
    min_tight_spread_count = _candidate_board_int_field(
        spec.hard_vetoes, "required_min_tight_spread_regime_count"
    )
    if min_tight_spread_count <= 0:
        min_tight_spread_count = 20
    min_split_pass_rate = _decimal(
        spec.hard_vetoes.get("required_min_decay_stress_split_pass_rate"),
        default="0.60",
    )
    max_best_split_share = _decimal(
        spec.hard_vetoes.get("required_max_decay_stress_best_split_share"),
        default="0.35",
    )
    blockers: list[str] = []
    missing_artifact_refs: list[str] = []
    if required:
        if not _boolish(
            scorecard.get("predictability_decay_stress_passed")
            or scorecard.get("alpha_decay_stress_passed")
        ):
            blockers.append("predictability_decay_stress_passed_failed")
        if not artifact_refs:
            blockers.append("predictability_decay_stress_artifact_present_failed")
        missing_artifact_refs = [
            ref for ref in artifact_refs if available_refs and ref not in available_refs
        ]
        if missing_artifact_refs:
            blockers.append(
                "predictability_decay_stress_artifact_ref_missing_from_bundle"
            )
        if not _boolish(
            scorecard.get("horizon_decay_curve_present")
            or scorecard.get("predictability_horizon_decay_curve_present")
        ):
            blockers.append("horizon_decay_curve_present_failed")
        if not _boolish(
            scorecard.get("spread_adjusted_label_replay_present")
            or scorecard.get("spread_adjusted_labels_present")
        ):
            blockers.append("spread_adjusted_label_replay_present_failed")
        if horizon_count < min_horizon_count:
            blockers.append("predictability_decay_stress_horizon_count_failed")
        if tight_spread_count < min_tight_spread_count:
            blockers.append("tight_spread_regime_slice_count_failed")
        if split_pass_rate < min_split_pass_rate:
            blockers.append("predictability_decay_stress_split_pass_rate_failed")
        if best_split_share > max_best_split_share:
            blockers.append("predictability_decay_stress_best_split_share_failed")
        if stress_net_pnl_per_day < target:
            blockers.append(
                "post_cost_net_pnl_after_predictability_decay_stress_failed"
            )
    return {
        "required": required,
        "passed": not blockers,
        "blockers": blockers,
        "artifact_refs": artifact_refs,
        "missing_replay_artifact_refs": missing_artifact_refs
        if required and artifact_refs
        else [],
        "horizon_count": horizon_count,
        "min_horizon_count": min_horizon_count,
        "tight_spread_regime_slice_count": tight_spread_count,
        "min_tight_spread_regime_slice_count": min_tight_spread_count,
        "split_pass_rate": str(split_pass_rate),
        "min_split_pass_rate": str(min_split_pass_rate),
        "best_split_share": str(best_split_share),
        "max_best_split_share": str(max_best_split_share),
        "stress_net_pnl_per_day": str(stress_net_pnl_per_day),
        "target_net_pnl_per_day": str(target),
        "source_marker": "tkan_lob_alpha_decay_arxiv_2601_02310_2026",
    }


def _candidate_board_scorecard_with_predictability_decay_blockers(
    spec: CandidateSpec, scorecard: Mapping[str, Any], *, target: Decimal
) -> tuple[dict[str, Any], dict[str, Any]]:
    summary = _candidate_board_predictability_decay_summary(
        spec, scorecard, target=target
    )
    updated_scorecard = dict(scorecard)
    blockers = [
        _string(blocker)
        for blocker in cast(Sequence[Any], summary.get("blockers") or ())
        if _string(blocker)
    ]
    if blockers:
        updated_scorecard["oracle_passed"] = False
        oracle_payload = dict(_mapping(updated_scorecard.get("profit_target_oracle")))
        oracle_blockers = [
            _string(blocker)
            for blocker in cast(Sequence[Any], oracle_payload.get("blockers") or ())
            if _string(blocker)
        ]
        oracle_payload["blockers"] = list(dict.fromkeys([*oracle_blockers, *blockers]))
        updated_scorecard["profit_target_oracle"] = oracle_payload
    return updated_scorecard, summary


def _candidate_board_order_type_execution_quality_summary(
    spec: CandidateSpec, scorecard: Mapping[str, Any]
) -> dict[str, Any]:
    required = _candidate_spec_requires_order_type_execution_quality(spec)
    min_sample_count = _candidate_board_int_field(
        spec.hard_vetoes, "required_min_order_type_ablation_sample_count"
    )
    if min_sample_count <= 0:
        min_sample_count = 60
    max_opportunity_cost_bps = _decimal(
        spec.hard_vetoes.get("required_max_order_type_opportunity_cost_bps"),
        default="8",
    )
    max_market_order_spread_bps = _decimal(
        spec.hard_vetoes.get("required_max_market_order_spread_bps"),
        default="8",
    )
    order_type_ablation_passed = _boolish(
        scorecard.get("order_type_ablation_passed")
        or scorecard.get("market_limit_execution_policy_passed")
    )
    raw_artifact_refs = scorecard.get(
        "order_type_ablation_artifact_refs"
    ) or scorecard.get("order_type_ablation_artifact_ref")
    artifact_refs = _string_list_from_value(raw_artifact_refs)
    if not artifact_refs and _string(raw_artifact_refs):
        artifact_refs = [_string(raw_artifact_refs)]
    raw_execution_artifact_refs = (
        scorecard.get("order_type_execution_artifact_refs")
        or scorecard.get("market_limit_order_mix_artifact_refs")
        or scorecard.get("order_type_execution_artifact_ref")
        or scorecard.get("market_limit_order_mix_artifact_ref")
    )
    execution_artifact_refs = _string_list_from_value(raw_execution_artifact_refs)
    if not execution_artifact_refs and _string(raw_execution_artifact_refs):
        execution_artifact_refs = [_string(raw_execution_artifact_refs)]
    sample_count = _candidate_board_first_int_field(
        scorecard,
        (
            "order_type_ablation_sample_count",
            "market_limit_order_mix_sample_count",
            "limit_fill_probability_sample_count",
        ),
    )
    opportunity_cost_bps = _decimal(
        scorecard.get("order_type_opportunity_cost_bps")
        or scorecard.get("market_limit_order_mix_opportunity_cost_bps"),
        default="999999",
    )
    market_order_spread_bps = _decimal(
        scorecard.get("market_order_spread_bps")
        or scorecard.get("market_limit_order_mix_market_spread_bps"),
        default="999999",
    )
    blockers: list[str] = []
    if required:
        if not order_type_ablation_passed:
            blockers.append("order_type_ablation_passed_failed")
        if not artifact_refs:
            blockers.append("order_type_ablation_artifact_present_failed")
        if sample_count < min_sample_count:
            blockers.append("order_type_ablation_sample_count_failed")
        if not _boolish(
            scorecard.get("market_limit_order_mix_evidence_present")
            or scorecard.get("market_limit_order_mix_present")
        ):
            blockers.append("market_limit_order_mix_evidence_present_failed")
        if not _boolish(
            scorecard.get("limit_fill_probability_evidence_present")
            or scorecard.get("limit_fill_probability_present")
        ):
            blockers.append("limit_fill_probability_evidence_present_failed")
        if not _boolish(
            scorecard.get("price_improvement_evidence_present")
            or scorecard.get("route_price_improvement_evidence_present")
        ):
            blockers.append("price_improvement_evidence_present_failed")
        if not _boolish(
            scorecard.get("opportunity_cost_evidence_present")
            or scorecard.get("order_type_opportunity_cost_evidence_present")
        ):
            blockers.append("opportunity_cost_evidence_present_failed")
        if not _boolish(
            scorecard.get("execution_shortfall_evidence_present")
            or scorecard.get("order_type_execution_shortfall_evidence_present")
        ):
            blockers.append("execution_shortfall_evidence_present_failed")
        raw_route_tca_refs = scorecard.get("route_tca_artifact_refs") or scorecard.get(
            "route_tca_artifact_ref"
        )
        route_tca_refs = _string_list_from_value(raw_route_tca_refs)
        if not route_tca_refs and _string(raw_route_tca_refs):
            route_tca_refs = [_string(raw_route_tca_refs)]
        if not route_tca_refs:
            blockers.append("route_tca_evidence_present_failed")
        if opportunity_cost_bps > max_opportunity_cost_bps:
            blockers.append("order_type_opportunity_cost_bps_failed")
        if market_order_spread_bps > max_market_order_spread_bps:
            blockers.append("market_order_spread_bps_failed")
    return {
        "required": required,
        "passed": not blockers,
        "blockers": blockers,
        "artifact_refs": artifact_refs,
        "execution_artifact_refs": execution_artifact_refs,
        "route_tca_artifact_refs": route_tca_refs if required else [],
        "sample_count": sample_count,
        "min_sample_count": min_sample_count,
        "opportunity_cost_bps": str(opportunity_cost_bps),
        "max_opportunity_cost_bps": str(max_opportunity_cost_bps),
        "market_order_spread_bps": str(market_order_spread_bps),
        "max_market_order_spread_bps": str(max_market_order_spread_bps),
    }


def _candidate_board_scorecard_with_order_type_blockers(
    spec: CandidateSpec,
    scorecard: Mapping[str, Any],
    *,
    replay_artifact_refs: Sequence[Any] = (),
) -> tuple[dict[str, Any], dict[str, Any]]:
    summary = _candidate_board_order_type_execution_quality_summary(spec, scorecard)
    updated_scorecard = dict(scorecard)
    blockers = [
        _string(blocker)
        for blocker in cast(Sequence[Any], summary.get("blockers") or ())
        if _string(blocker)
    ]
    required_artifact_refs = tuple(
        dict.fromkeys(
            item
            for item in (
                *cast(Sequence[Any], summary.get("artifact_refs") or ()),
                *cast(Sequence[Any], summary.get("execution_artifact_refs") or ()),
                *cast(Sequence[Any], summary.get("route_tca_artifact_refs") or ()),
            )
            if _string(item)
        )
    )
    available_artifact_refs = {
        _string(item) for item in replay_artifact_refs if _string(item)
    }
    missing_artifact_refs = [
        _string(item)
        for item in required_artifact_refs
        if _string(item) not in available_artifact_refs
    ]
    if bool(summary.get("required")) and missing_artifact_refs:
        blockers.append("order_type_proof_artifact_ref_missing_from_bundle")
        summary = {
            **summary,
            "passed": False,
            "blockers": list(dict.fromkeys(blockers)),
            "missing_replay_artifact_refs": missing_artifact_refs,
            "replay_artifact_refs_checked": sorted(available_artifact_refs),
        }
    if blockers:
        updated_scorecard["oracle_passed"] = False
        oracle_payload = dict(_mapping(updated_scorecard.get("profit_target_oracle")))
        oracle_blockers = [
            _string(blocker)
            for blocker in cast(Sequence[Any], oracle_payload.get("blockers") or ())
            if _string(blocker)
        ]
        oracle_payload["blockers"] = list(dict.fromkeys([*oracle_blockers, *blockers]))
        updated_scorecard["profit_target_oracle"] = oracle_payload
    return updated_scorecard, summary


def _candidate_spec_requires_queue_position_survival(spec: CandidateSpec) -> bool:
    overlay_ids = set(
        _string_list_from_value(spec.parameter_space.get("mechanism_overlay_ids"))
    )
    return (
        "queue_position_survival_fill_curve" in overlay_ids
        or _boolish(
            spec.promotion_contract.get("requires_queue_position_survival_fill_curve")
        )
        or _boolish(spec.promotion_contract.get("requires_nonfill_opportunity_cost"))
        or _boolish(spec.promotion_contract.get("requires_time_to_fill_quantiles"))
        or "required_queue_position_survival_fill_curve" in spec.hard_vetoes
        or "required_min_queue_position_survival_sample_count" in spec.hard_vetoes
        or "required_max_queue_position_nonfill_opportunity_cost_bps"
        in spec.hard_vetoes
    )


def _candidate_board_queue_position_survival_summary(
    spec: CandidateSpec, scorecard: Mapping[str, Any]
) -> dict[str, Any]:
    required = _candidate_spec_requires_queue_position_survival(spec)
    min_sample_count = _candidate_board_int_field(
        spec.hard_vetoes, "required_min_queue_position_survival_sample_count"
    )
    if min_sample_count <= 0:
        min_sample_count = 60
    max_nonfill_opportunity_cost_bps = _decimal(
        spec.hard_vetoes.get(
            "required_max_queue_position_nonfill_opportunity_cost_bps"
        ),
        default="8",
    )
    evidence_present = _boolish(
        scorecard.get("queue_position_survival_fill_curve_evidence_present")
        or scorecard.get("queue_position_survival_evidence_present")
    )
    sample_count = _candidate_board_first_int_field(
        scorecard,
        (
            "queue_position_survival_sample_count",
            "queue_position_survival_fill_sample_count",
        ),
    )
    fill_rate = _decimal(scorecard.get("queue_position_survival_fill_rate"))
    queue_ratio_p95 = _decimal(scorecard.get("queue_position_survival_queue_ratio_p95"))
    queue_ahead_evidence_present = _boolish(
        scorecard.get("queue_position_survival_queue_ahead_depletion_evidence_present")
        or scorecard.get("delay_adjusted_depth_queue_ahead_depletion_evidence_present")
        or scorecard.get("queue_ahead_depletion_evidence_present")
    )
    queue_ahead_sample_count = _candidate_board_first_int_field(
        scorecard,
        (
            "queue_position_survival_queue_ahead_depletion_sample_count",
            "delay_adjusted_depth_queue_ahead_depletion_sample_count",
            "queue_ahead_depletion_sample_count",
        ),
    )
    nonfill_opportunity_cost_raw = scorecard.get(
        "queue_position_survival_nonfill_opportunity_cost_bps"
    ) or scorecard.get("queue_position_nonfill_opportunity_cost_bps")
    nonfill_opportunity_cost_present = nonfill_opportunity_cost_raw not in (None, "")
    nonfill_opportunity_cost_bps = _decimal(
        nonfill_opportunity_cost_raw,
        default="999999",
    )
    require_time_to_fill_quantiles = _boolish(
        spec.hard_vetoes.get("required_time_to_fill_quantiles")
    ) or _boolish(spec.promotion_contract.get("requires_time_to_fill_quantiles"))
    time_to_fill_quantiles_present = scorecard.get("fill_time_ms_p50") not in (
        None,
        "",
    ) and scorecard.get("fill_time_ms_p95") not in (None, "")
    blockers: list[str] = []
    if required:
        if not evidence_present:
            blockers.append(
                "queue_position_survival_fill_curve_evidence_present_failed"
            )
        if sample_count < min_sample_count:
            blockers.append("queue_position_survival_sample_count_failed")
        if fill_rate <= 0:
            blockers.append("queue_position_survival_fill_rate_failed")
        if not queue_ahead_evidence_present:
            blockers.append("queue_ahead_depletion_evidence_present_failed")
        if queue_ahead_sample_count <= 0:
            blockers.append("queue_ahead_depletion_sample_count_failed")
        if not nonfill_opportunity_cost_present:
            blockers.append(
                "queue_position_survival_nonfill_opportunity_cost_present_failed"
            )
        elif nonfill_opportunity_cost_bps > max_nonfill_opportunity_cost_bps:
            blockers.append(
                "queue_position_survival_nonfill_opportunity_cost_bps_failed"
            )
        if require_time_to_fill_quantiles and not time_to_fill_quantiles_present:
            blockers.append("time_to_fill_quantiles_present_failed")
    return {
        "required": required,
        "passed": not blockers,
        "blockers": blockers,
        "evidence_present": evidence_present,
        "sample_count": sample_count,
        "min_sample_count": min_sample_count,
        "fill_rate": str(fill_rate),
        "queue_ratio_p95": str(queue_ratio_p95),
        "queue_ahead_depletion_evidence_present": queue_ahead_evidence_present,
        "queue_ahead_depletion_sample_count": queue_ahead_sample_count,
        "nonfill_opportunity_cost_present": nonfill_opportunity_cost_present,
        "nonfill_opportunity_cost_bps": str(nonfill_opportunity_cost_bps),
        "max_nonfill_opportunity_cost_bps": str(max_nonfill_opportunity_cost_bps),
        "time_to_fill_quantiles_required": require_time_to_fill_quantiles,
        "time_to_fill_quantiles_present": time_to_fill_quantiles_present,
        "source_marker": "queue_position_survival_fill_probability_arxiv_2512_05734_2025",
    }


def _candidate_board_scorecard_with_queue_position_survival_blockers(
    spec: CandidateSpec, scorecard: Mapping[str, Any]
) -> tuple[dict[str, Any], dict[str, Any]]:
    summary = _candidate_board_queue_position_survival_summary(spec, scorecard)
    updated_scorecard = dict(scorecard)
    blockers = [
        _string(blocker)
        for blocker in cast(Sequence[Any], summary.get("blockers") or ())
        if _string(blocker)
    ]
    if blockers:
        updated_scorecard["oracle_passed"] = False
        oracle_payload = dict(_mapping(updated_scorecard.get("profit_target_oracle")))
        oracle_blockers = [
            _string(blocker)
            for blocker in cast(Sequence[Any], oracle_payload.get("blockers") or ())
            if _string(blocker)
        ]
        oracle_payload["blockers"] = list(dict.fromkeys([*oracle_blockers, *blockers]))
        updated_scorecard["profit_target_oracle"] = oracle_payload
    return updated_scorecard, summary


def _candidate_board_scorecard_with_rejected_signal_blockers(
    spec: CandidateSpec, scorecard: Mapping[str, Any]
) -> tuple[dict[str, Any], dict[str, Any]]:
    summary = _candidate_board_rejected_signal_outcome_summary(spec, scorecard)
    updated_scorecard = dict(scorecard)
    blockers = [
        _string(blocker)
        for blocker in cast(Sequence[Any], summary.get("blockers") or ())
        if _string(blocker)
    ]
    if blockers:
        updated_scorecard["oracle_passed"] = False
        oracle_payload = dict(_mapping(updated_scorecard.get("profit_target_oracle")))
        oracle_blockers = [
            _string(blocker)
            for blocker in cast(Sequence[Any], oracle_payload.get("blockers") or ())
            if _string(blocker)
        ]
        oracle_payload["blockers"] = list(dict.fromkeys([*oracle_blockers, *blockers]))
        updated_scorecard["profit_target_oracle"] = oracle_payload
    return updated_scorecard, summary


def _candidate_board_evidence_lineage_summary(
    evidence: CandidateEvidenceBundle | None,
) -> dict[str, Any]:
    if evidence is None:
        return {
            "present": False,
            "passed": False,
            "blockers": ["evidence_bundle_missing"],
            "dataset_snapshot_id": "",
            "feature_spec_hash": "",
            "code_commit": "",
            "replay_artifact_ref_count": 0,
        }

    blockers: list[str] = []
    dataset_snapshot_id = _string(evidence.dataset_snapshot_id)
    feature_spec_hash = _string(evidence.feature_spec_hash)
    code_commit = _string(evidence.code_commit)
    replay_artifact_refs = [
        _string(item) for item in evidence.replay_artifact_refs if _string(item)
    ]

    if not dataset_snapshot_id:
        blockers.append("dataset_snapshot_missing")
    if not feature_spec_hash:
        blockers.append("feature_spec_hash_missing")
    if not code_commit or code_commit.lower() == "unknown":
        blockers.append("code_commit_missing_or_unknown")
    elif code_commit.endswith("-dirty"):
        blockers.append("code_commit_dirty")
    if not replay_artifact_refs:
        blockers.append("replay_artifact_missing")

    return {
        "present": True,
        "passed": not blockers,
        "blockers": blockers,
        "dataset_snapshot_id": dataset_snapshot_id,
        "feature_spec_hash": feature_spec_hash,
        "code_commit": code_commit,
        "replay_artifact_ref_count": len(replay_artifact_refs),
        "sample_replay_artifact_refs": replay_artifact_refs[:5],
    }


def _candidate_board_scorecard_with_lineage_blockers(
    scorecard: Mapping[str, Any], evidence: CandidateEvidenceBundle | None
) -> tuple[dict[str, Any], dict[str, Any]]:
    summary = _candidate_board_evidence_lineage_summary(evidence)
    updated_scorecard = dict(scorecard)
    blockers = [
        _string(blocker)
        for blocker in cast(Sequence[Any], summary.get("blockers") or ())
        if _string(blocker)
    ]
    if blockers:
        updated_scorecard["oracle_passed"] = False
        oracle_payload = dict(_mapping(updated_scorecard.get("profit_target_oracle")))
        oracle_blockers = [
            _string(blocker)
            for blocker in cast(Sequence[Any], oracle_payload.get("blockers") or ())
            if _string(blocker)
        ]
        oracle_payload["blockers"] = list(dict.fromkeys([*oracle_blockers, *blockers]))
        updated_scorecard["profit_target_oracle"] = oracle_payload
    return updated_scorecard, summary


def _candidate_board_replay_window_coverage_summary(
    scorecard: Mapping[str, Any],
) -> dict[str, Any]:
    required = _boolish(scorecard.get("target_met")) or _boolish(
        scorecard.get("oracle_passed")
    )
    replay_lineage = _mapping(scorecard.get("replay_lineage"))
    coverage = _mapping(scorecard.get("replay_window_coverage"))
    expected_windows = _string_list_from_value(
        coverage.get("expected_windows") or replay_lineage.get("expected_windows")
    )
    present_windows = _string_list_from_value(
        coverage.get("present_windows") or replay_lineage.get("present_windows")
    )
    missing_windows = _string_list_from_value(
        coverage.get("missing_windows") or replay_lineage.get("missing_windows")
    )
    if (
        _candidate_board_int_field(scorecard, "double_oos_independent_window_count")
        >= 2
        and _SECOND_OOS_WINDOW_ID not in expected_windows
    ):
        expected_windows.append(_SECOND_OOS_WINDOW_ID)
    for required_window in ("train", "holdout", "full_window"):
        if required_window not in expected_windows:
            expected_windows.append(required_window)

    blockers: list[str] = []
    lineage_hash = _string(replay_lineage.get("lineage_hash"))
    coverage_hash = _string(coverage.get("lineage_hash"))
    if required:
        if not replay_lineage:
            blockers.append("replay_lineage_missing")
        if not coverage:
            blockers.append("replay_window_coverage_missing")
        if not lineage_hash:
            blockers.append("replay_lineage_hash_missing")
        if not coverage_hash:
            blockers.append("replay_window_coverage_hash_missing")
        if lineage_hash and coverage_hash and lineage_hash != coverage_hash:
            blockers.append("replay_lineage_hash_mismatch")
        missing_required_windows = [
            window_id
            for window_id in expected_windows
            if window_id not in present_windows or window_id in missing_windows
        ]
        if missing_required_windows:
            blockers.append("replay_window_missing")
    else:
        missing_required_windows = []

    return {
        "required": required,
        "passed": not blockers,
        "blockers": blockers,
        "lineage_hash": lineage_hash,
        "coverage_hash": coverage_hash,
        "expected_windows": expected_windows,
        "present_windows": present_windows,
        "missing_windows": missing_windows,
        "missing_required_windows": missing_required_windows,
    }


def _candidate_board_market_impact_proof_summary(
    scorecard: Mapping[str, Any],
) -> dict[str, Any]:
    components = _mapping(scorecard.get("market_impact_stress_components"))
    source_marker = _string(components.get("source_marker"))
    source_marker_candidates = [
        *_string_list_from_value(scorecard.get("market_impact_stress_source_markers")),
        *_string_list_from_value(components.get("source_markers")),
        *([source_marker] if source_marker else []),
    ]
    source_markers = sorted({marker for marker in source_marker_candidates if marker})
    model = _string(
        scorecard.get("nonlinear_market_impact_stress_model")
        or scorecard.get("market_impact_stress_model")
    )
    artifact_ref = _string(
        scorecard.get("market_impact_stress_artifact_ref")
        or scorecard.get("impact_stress_artifact_ref")
        or scorecard.get("cost_shock_artifact_ref")
    )
    cost_bps = _candidate_board_decimal_field(
        scorecard, "nonlinear_market_impact_stress_cost_bps"
    ) or _candidate_board_decimal_field(scorecard, "market_impact_stress_cost_bps")
    net_pnl_per_day = _candidate_board_decimal_field(
        scorecard, "nonlinear_market_impact_stress_net_pnl_per_day"
    ) or _candidate_board_decimal_field(
        scorecard, "market_impact_stress_net_pnl_per_day"
    )
    nonlinear_passed = _boolish(
        scorecard.get("nonlinear_market_impact_stress_passed")
        or scorecard.get("market_impact_stress_passed")
    )
    blockers: list[str] = []
    if not artifact_ref:
        blockers.append("market_impact_stress_artifact_missing")
    if not model:
        blockers.append("market_impact_stress_model_missing")
    if not cost_bps or _decimal(cost_bps) <= 0:
        blockers.append("market_impact_stress_cost_bps_missing")
    if not net_pnl_per_day:
        blockers.append("market_impact_stress_net_pnl_missing")
    if not source_marker:
        blockers.append("nonlinear_market_impact_components_missing")
    if model and artifact_ref and cost_bps and not nonlinear_passed:
        blockers.append("nonlinear_market_impact_stress_failed")
    if not scorecard:
        state = "not_replayed"
    elif blockers:
        state = "blocked"
    else:
        state = "passed"
    return {
        "state": state,
        "passed": state == "passed",
        "model": model,
        "cost_bps": cost_bps,
        "net_pnl_per_day": net_pnl_per_day,
        "artifact_ref": artifact_ref,
        "component_source_marker": source_marker,
        "source_markers": source_markers,
        "selected_component_model": _string(components.get("selected_model")),
        "selected_component_cost_bps": _string(components.get("selected_cost_bps")),
        "blockers": blockers,
        "source_marker": "realistic_market_impact_arxiv_2603_29086_2026",
    }


def _candidate_board_regime_specialist_summary(
    spec: CandidateSpec,
    scorecard: Mapping[str, Any],
) -> dict[str, Any]:
    required_rate = _decimal(
        spec.hard_vetoes.get("required_min_regime_slice_pass_rate")
        or spec.promotion_contract.get("required_min_regime_slice_pass_rate")
    )
    observed_rate = _decimal(scorecard.get("regime_slice_pass_rate"))
    source_claims = _list_of_mappings(spec.feature_contract.get("source_claims"))
    regime_claim_ids = [
        _string(claim.get("claim_id"))
        for claim in source_claims
        if _string(claim.get("claim_type"))
        in {"market_regime", "validation_requirement", "risk_constraint"}
    ]
    blockers: list[str] = []
    if scorecard and required_rate > 0 and "regime_slice_pass_rate" not in scorecard:
        blockers.append("regime_slice_pass_rate_missing")
    if scorecard and required_rate > 0 and observed_rate < required_rate:
        blockers.append("regime_slice_pass_rate_below_specialist_threshold")
    if not scorecard:
        state = "not_replayed"
    elif blockers:
        state = "blocked"
    else:
        state = "passed"
    return {
        "state": state,
        "passed": state == "passed",
        "regime_slice_pass_rate": str(observed_rate) if scorecard else "",
        "required_min_regime_slice_pass_rate": str(required_rate)
        if required_rate > 0
        else "",
        "regime_claim_ids": [claim_id for claim_id in regime_claim_ids if claim_id],
        "blockers": blockers,
        "source_markers": [
            "risk_sensitive_specialist_routing_arxiv_2604_10402_2026",
            "validated_vvg_classifier_arxiv_2605_11423_2026",
        ],
    }


def _candidate_board_scorecard_with_replay_window_blockers(
    scorecard: Mapping[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    summary = _candidate_board_replay_window_coverage_summary(scorecard)
    updated_scorecard = dict(scorecard)
    blockers = [
        _string(blocker)
        for blocker in cast(Sequence[Any], summary.get("blockers") or ())
        if _string(blocker)
    ]
    if blockers:
        updated_scorecard["oracle_passed"] = False
        oracle_payload = dict(_mapping(updated_scorecard.get("profit_target_oracle")))
        oracle_blockers = [
            _string(blocker)
            for blocker in cast(Sequence[Any], oracle_payload.get("blockers") or ())
            if _string(blocker)
        ]
        oracle_payload["blockers"] = list(dict.fromkeys([*oracle_blockers, *blockers]))
        updated_scorecard["profit_target_oracle"] = oracle_payload
    return updated_scorecard, summary


def _candidate_board_scorecard_with_evidence_blockers(
    scorecard: Mapping[str, Any], evidence: CandidateEvidenceBundle | None
) -> dict[str, Any]:
    if evidence is None:
        return dict(scorecard)
    blockers = [
        _string(blocker)
        for blocker in (
            *evidence_bundle_blockers(evidence),
            *cast(
                Sequence[Any],
                evidence.promotion_readiness.get("blockers") or (),
            ),
        )
        if _string(blocker)
    ]
    if not blockers:
        return dict(scorecard)
    updated_scorecard = dict(scorecard)
    updated_scorecard["oracle_passed"] = False
    oracle_payload = dict(_mapping(updated_scorecard.get("profit_target_oracle")))
    oracle_blockers = [
        _string(blocker)
        for blocker in cast(Sequence[Any], oracle_payload.get("blockers") or ())
        if _string(blocker)
    ]
    oracle_payload["blockers"] = list(dict.fromkeys([*oracle_blockers, *blockers]))
    updated_scorecard["profit_target_oracle"] = oracle_payload
    return updated_scorecard


__all__ = [
    "_candidate_board_rejected_signal_outcome_summary",
    "_candidate_spec_requires_order_type_execution_quality",
    "_candidate_spec_requires_predictability_decay_stress",
    "_candidate_board_predictability_decay_summary",
    "_candidate_board_scorecard_with_predictability_decay_blockers",
    "_candidate_board_order_type_execution_quality_summary",
    "_candidate_board_scorecard_with_order_type_blockers",
    "_candidate_spec_requires_queue_position_survival",
    "_candidate_board_queue_position_survival_summary",
    "_candidate_board_scorecard_with_queue_position_survival_blockers",
    "_candidate_board_scorecard_with_rejected_signal_blockers",
    "_candidate_board_evidence_lineage_summary",
    "_candidate_board_scorecard_with_lineage_blockers",
    "_candidate_board_replay_window_coverage_summary",
    "_candidate_board_market_impact_proof_summary",
    "_candidate_board_regime_specialist_summary",
    "_candidate_board_scorecard_with_replay_window_blockers",
    "_candidate_board_scorecard_with_evidence_blockers",
]
