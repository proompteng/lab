#!/usr/bin/env python3
"""Run a whitepaper-driven autoresearch epoch targeting a portfolio profit objective."""

from __future__ import annotations

from decimal import Decimal
from typing import Any, Mapping, Sequence


from app.trading.discovery.candidate_specs import (
    CandidateSpec,
)
from app.trading.discovery.evidence_bundles import (
    CandidateEvidenceBundle,
)
from app.trading.discovery.mlx_training_data import build_mlx_training_rows
from app.trading.discovery.mlx_training_data import (
    rank_training_rows,
    train_mlx_ranker,
)
from app.trading.discovery.profit_target_oracle import (
    ProfitTargetOraclePolicy,
)


from scripts.whitepaper_autoresearch_runner.common import (
    _string,
    _list_of_mappings,
)

from scripts.whitepaper_autoresearch_runner.candidate_identity import (
    _candidate_spec_execution_signature,
)
from scripts.whitepaper_autoresearch_runner.candidate_prior_scoring import (
    _active_loss_counter_proposal_score,
    _candidate_spec_active_loss_counter_tags,
    _candidate_spec_feedback_risk_profile_key,
    _candidate_spec_feedback_shape_key,
    _candidate_spec_is_false_negative_rescue,
    _candidate_spec_matches_active_loss_counter_feedback,
    _candidate_spec_matches_consistency_repair_feedback,
    _consistency_repair_proposal_score,
    _feedback_active_loss_counter_candidate_reasons,
    _feedback_consistency_repair_candidate_reasons,
    _scorecard_is_false_negative_rescue_feedback,
)

from scripts.whitepaper_autoresearch_runner.feedback_blocking_rules import (
    _feedback_bundle_sort_value,
    _feedback_execution_signature,
    _feedback_family_prior_has_hard_block,
    _feedback_family_template_id,
    _feedback_has_no_replay_activity,
    _feedback_has_nonpositive_expected_value,
    _feedback_has_policy_penalty,
    _feedback_is_blocked,
    _feedback_risk_profile_has_penalty,
    _feedback_risk_profile_has_terminal_block,
    _feedback_risk_profile_key,
    _feedback_shape_key,
)

from scripts.whitepaper_autoresearch_runner.feedback_bundle_builders import (
    _execution_signature_feedback_bundle_for_spec,
    _family_feedback_bundle_for_spec,
    _pre_replay_prior_bundle,
    _risk_profile_feedback_bundle_for_spec,
    _shape_feedback_bundle_for_spec,
)

_DEFAULT_RANKER_BACKEND_PREFERENCE = "mlx"

_PRE_REPLAY_FEEDBACK_BLOCK_REASONS = frozenset(
    {
        "pre_replay_mlx_feedback_blocked",
        "pre_replay_mlx_signature_feedback_blocked",
        "pre_replay_mlx_shape_feedback_blocked",
        "pre_replay_mlx_risk_profile_feedback_blocked",
        "pre_replay_mlx_family_feedback_blocked",
        "pre_replay_mlx_false_negative_rescue_feedback_blocked",
        "pre_replay_mlx_no_activity_feedback_blocked",
    }
)

_PRE_REPLAY_SELECTION_BLOCK_REASONS = frozenset(
    {
        *_PRE_REPLAY_FEEDBACK_BLOCK_REASONS,
        "pre_replay_capital_budget_blocked",
        "pre_replay_mlx_synthetic_nonpositive_expected_value",
        "pre_replay_synthetic_capacity_insufficient",
    }
)


def _pre_replay_proposal_model_and_rows(
    *,
    specs: Sequence[CandidateSpec],
    feedback_evidence_bundles: Sequence[CandidateEvidenceBundle] = (),
    oracle_policy: ProfitTargetOraclePolicy | None = None,
    ranker_backend_preference: str = _DEFAULT_RANKER_BACKEND_PREFERENCE,
) -> tuple[Mapping[str, Any], list[dict[str, Any]]]:
    policy = oracle_policy or ProfitTargetOraclePolicy()
    spec_by_id = {spec.candidate_spec_id: spec for spec in specs}
    spec_ids = {spec.candidate_spec_id for spec in specs}
    execution_signature_by_spec = {
        spec.candidate_spec_id: _candidate_spec_execution_signature(spec)
        for spec in specs
    }
    feedback_shape_key_by_spec = {
        spec.candidate_spec_id: _candidate_spec_feedback_shape_key(spec)
        for spec in specs
    }
    feedback_risk_profile_key_by_spec = {
        spec.candidate_spec_id: _candidate_spec_feedback_risk_profile_key(spec)
        for spec in specs
    }
    feedback_by_spec: dict[str, CandidateEvidenceBundle] = {}
    for bundle in feedback_evidence_bundles:
        if bundle.candidate_spec_id not in spec_ids:
            continue
        current = feedback_by_spec.get(bundle.candidate_spec_id)
        if current is None or _feedback_bundle_sort_value(
            bundle, oracle_policy=policy
        ) > _feedback_bundle_sort_value(current, oracle_policy=policy):
            feedback_by_spec[bundle.candidate_spec_id] = bundle

    feedback_by_execution_signature: dict[str, CandidateEvidenceBundle] = {}
    for bundle in feedback_evidence_bundles:
        execution_signature = _feedback_execution_signature(bundle)
        if not execution_signature:
            continue
        current = feedback_by_execution_signature.get(execution_signature)
        if current is None or _feedback_bundle_sort_value(
            bundle, oracle_policy=policy
        ) > _feedback_bundle_sort_value(current, oracle_policy=policy):
            feedback_by_execution_signature[execution_signature] = bundle
    signature_feedback_by_spec: dict[str, CandidateEvidenceBundle] = {}
    for spec in specs:
        if spec.candidate_spec_id in feedback_by_spec:
            continue
        signature = execution_signature_by_spec[spec.candidate_spec_id]
        bundle = feedback_by_execution_signature.get(signature)
        if bundle is not None:
            signature_feedback_by_spec[spec.candidate_spec_id] = (
                _execution_signature_feedback_bundle_for_spec(spec=spec, bundle=bundle)
            )

    feedback_by_shape: dict[str, CandidateEvidenceBundle] = {}
    for bundle in feedback_evidence_bundles:
        feedback_shape_key = _feedback_shape_key(bundle)
        if not feedback_shape_key:
            continue
        current = feedback_by_shape.get(feedback_shape_key)
        if current is None or _feedback_bundle_sort_value(
            bundle, oracle_policy=policy
        ) > _feedback_bundle_sort_value(current, oracle_policy=policy):
            feedback_by_shape[feedback_shape_key] = bundle
    shape_feedback_by_spec: dict[str, CandidateEvidenceBundle] = {}
    for spec in specs:
        if (
            spec.candidate_spec_id in feedback_by_spec
            or spec.candidate_spec_id in signature_feedback_by_spec
        ):
            continue
        bundle = feedback_by_shape.get(
            feedback_shape_key_by_spec[spec.candidate_spec_id]
        )
        if bundle is not None:
            shape_feedback_by_spec[spec.candidate_spec_id] = (
                _shape_feedback_bundle_for_spec(spec=spec, bundle=bundle)
            )

    feedback_by_risk_profile: dict[str, CandidateEvidenceBundle] = {}
    for bundle in feedback_evidence_bundles:
        if not _feedback_risk_profile_has_penalty(
            bundle.objective_scorecard, oracle_policy=policy
        ):
            continue
        risk_profile_key = _feedback_risk_profile_key(bundle)
        if not risk_profile_key:
            continue
        current = feedback_by_risk_profile.get(risk_profile_key)
        if current is None or _feedback_bundle_sort_value(
            bundle, oracle_policy=policy
        ) > _feedback_bundle_sort_value(current, oracle_policy=policy):
            feedback_by_risk_profile[risk_profile_key] = bundle
    risk_profile_feedback_by_spec: dict[str, CandidateEvidenceBundle] = {}
    for spec in specs:
        if (
            spec.candidate_spec_id in feedback_by_spec
            or spec.candidate_spec_id in signature_feedback_by_spec
            or spec.candidate_spec_id in shape_feedback_by_spec
        ):
            continue
        bundle = feedback_by_risk_profile.get(
            feedback_risk_profile_key_by_spec[spec.candidate_spec_id]
        )
        if bundle is not None:
            risk_profile_feedback_by_spec[spec.candidate_spec_id] = (
                _risk_profile_feedback_bundle_for_spec(spec=spec, bundle=bundle)
            )

    feedback_by_family: dict[str, CandidateEvidenceBundle] = {}
    for bundle in feedback_evidence_bundles:
        family_template_id = _feedback_family_template_id(bundle)
        if not family_template_id:
            continue
        current = feedback_by_family.get(family_template_id)
        if current is None or _feedback_bundle_sort_value(
            bundle, oracle_policy=policy
        ) > _feedback_bundle_sort_value(current, oracle_policy=policy):
            feedback_by_family[family_template_id] = bundle
    family_feedback_by_spec: dict[str, CandidateEvidenceBundle] = {}
    for spec in specs:
        if (
            spec.candidate_spec_id in feedback_by_spec
            or spec.candidate_spec_id in signature_feedback_by_spec
            or spec.candidate_spec_id in shape_feedback_by_spec
            or spec.candidate_spec_id in risk_profile_feedback_by_spec
        ):
            continue
        bundle = feedback_by_family.get(spec.family_template_id)
        if bundle is not None:
            family_feedback_by_spec[spec.candidate_spec_id] = (
                _family_feedback_bundle_for_spec(spec=spec, bundle=bundle)
            )

    prior_bundles = [_pre_replay_prior_bundle(spec) for spec in specs]
    training_bundles: list[CandidateEvidenceBundle] = []
    training_source_by_spec: dict[str, str] = {}
    feedback_source_candidate_spec_by_spec: dict[str, str | None] = {}
    feedback_match_scope_by_spec: dict[str, str | None] = {}
    for spec, prior_bundle in zip(specs, prior_bundles, strict=True):
        candidate_spec_id = spec.candidate_spec_id
        if candidate_spec_id in feedback_by_spec:
            bundle = feedback_by_spec[candidate_spec_id]
            training_source = "feedback_real_replay"
            match_scope = "candidate_spec_id"
            source_spec_id: str | None = bundle.candidate_spec_id
        elif candidate_spec_id in signature_feedback_by_spec:
            bundle = signature_feedback_by_spec[candidate_spec_id]
            training_source = "feedback_execution_signature_replay"
            match_scope = "execution_signature"
            source_spec_id = _string(
                bundle.objective_scorecard.get("feedback_source_candidate_spec_id")
            )
        elif candidate_spec_id in shape_feedback_by_spec:
            bundle = shape_feedback_by_spec[candidate_spec_id]
            training_source = "feedback_shape_prior"
            match_scope = "feedback_shape_key"
            source_spec_id = _string(
                bundle.objective_scorecard.get("feedback_source_candidate_spec_id")
            )
        elif candidate_spec_id in risk_profile_feedback_by_spec:
            bundle = risk_profile_feedback_by_spec[candidate_spec_id]
            training_source = "feedback_risk_profile_prior"
            match_scope = "feedback_risk_profile_key"
            source_spec_id = _string(
                bundle.objective_scorecard.get("feedback_source_candidate_spec_id")
            )
        elif candidate_spec_id in family_feedback_by_spec:
            bundle = family_feedback_by_spec[candidate_spec_id]
            training_source = "feedback_family_replay"
            match_scope = "family_template_id"
            source_spec_id = _string(
                bundle.objective_scorecard.get("feedback_source_candidate_spec_id")
            )
        else:
            bundle = prior_bundle
            training_source = "synthetic_prior"
            match_scope = None
            source_spec_id = None
        training_bundles.append(bundle)
        training_source_by_spec[candidate_spec_id] = training_source
        feedback_source_candidate_spec_by_spec[candidate_spec_id] = source_spec_id
        feedback_match_scope_by_spec[candidate_spec_id] = match_scope
    training_rows = build_mlx_training_rows(
        candidate_specs=specs, evidence_bundles=training_bundles
    )
    model = train_mlx_ranker(
        training_rows, backend_preference=ranker_backend_preference
    )
    ranked_rows = rank_training_rows(model=model, rows=training_rows)
    feature_by_spec = {
        row.candidate_spec_id: row.to_payload()["features"] for row in training_rows
    }
    target_by_spec = {row.candidate_spec_id: row.target for row in training_rows}
    feedback_bundle_by_spec = {
        **feedback_by_spec,
        **signature_feedback_by_spec,
        **shape_feedback_by_spec,
        **risk_profile_feedback_by_spec,
        **family_feedback_by_spec,
    }

    training_source_counts: dict[str, int] = {}
    for source in training_source_by_spec.values():
        training_source_counts[source] = training_source_counts.get(source, 0) + 1

    def row_selection_reason(candidate_spec_id: str) -> str:
        source = training_source_by_spec.get(candidate_spec_id, "synthetic_prior")
        bundle = feedback_bundle_by_spec.get(candidate_spec_id)
        is_blocked = bundle is not None and _feedback_is_blocked(
            bundle.objective_scorecard, oracle_policy=policy
        )
        has_policy_penalty = bundle is not None and _feedback_has_policy_penalty(
            bundle.objective_scorecard, oracle_policy=policy
        )
        if bundle is not None and _feedback_has_no_replay_activity(
            bundle.objective_scorecard
        ):
            return "pre_replay_mlx_no_activity_feedback_blocked"
        if source == "feedback_real_replay" and is_blocked:
            if bundle is not None and _feedback_has_nonpositive_expected_value(
                bundle.objective_scorecard
            ):
                return "pre_replay_mlx_feedback_blocked"
            return "pre_replay_mlx_feedback_penalized"
        if source == "feedback_real_replay" and has_policy_penalty:
            return "pre_replay_mlx_feedback_penalized"
        if source == "feedback_execution_signature_replay" and is_blocked:
            if bundle is not None and _feedback_has_nonpositive_expected_value(
                bundle.objective_scorecard
            ):
                return "pre_replay_mlx_signature_feedback_blocked"
            return "pre_replay_mlx_signature_feedback_penalized"
        if source == "feedback_execution_signature_replay" and has_policy_penalty:
            return "pre_replay_mlx_signature_feedback_penalized"
        if source == "feedback_shape_prior" and bundle is not None:
            if _feedback_family_prior_has_hard_block(
                bundle.objective_scorecard, oracle_policy=policy
            ):
                return "pre_replay_mlx_shape_feedback_blocked"
            if is_blocked:
                return "pre_replay_mlx_family_feedback_penalized"
        if (
            source == "feedback_risk_profile_prior"
            and bundle is not None
            and _feedback_risk_profile_has_penalty(
                bundle.objective_scorecard, oracle_policy=policy
            )
        ):
            if _feedback_risk_profile_has_terminal_block(
                bundle.objective_scorecard, oracle_policy=policy
            ):
                return "pre_replay_mlx_risk_profile_feedback_blocked"
            return "pre_replay_mlx_risk_profile_feedback_penalized"
        if (
            source == "feedback_family_replay"
            and bundle is not None
            and _feedback_has_nonpositive_expected_value(bundle.objective_scorecard)
        ):
            spec = spec_by_id.get(candidate_spec_id)
            if (
                spec is not None
                and _candidate_spec_is_false_negative_rescue(spec)
                and _scorecard_is_false_negative_rescue_feedback(
                    bundle.objective_scorecard
                )
            ):
                return "pre_replay_mlx_false_negative_rescue_feedback_blocked"
            if (
                spec is not None
                and _candidate_spec_matches_active_loss_counter_feedback(
                    spec,
                    bundle.objective_scorecard,
                    oracle_policy=policy,
                )
            ):
                return "pre_replay_mlx_active_loss_counter_candidate"
            return "pre_replay_mlx_family_feedback_blocked"
        if (
            source == "feedback_family_replay"
            and bundle is not None
            and (is_blocked or has_policy_penalty)
        ):
            spec = spec_by_id.get(candidate_spec_id)
            if spec is not None and _candidate_spec_matches_consistency_repair_feedback(
                spec,
                bundle.objective_scorecard,
                oracle_policy=policy,
            ):
                return "pre_replay_mlx_consistency_repair_candidate"
            return "pre_replay_mlx_family_feedback_penalized"
        return "pre_replay_mlx_rank"

    def proposal_score_for_item(candidate_spec_id: str, raw_score: float) -> float:
        source = training_source_by_spec.get(candidate_spec_id, "synthetic_prior")
        bundle = feedback_bundle_by_spec.get(candidate_spec_id)
        if (
            source in {"feedback_real_replay", "feedback_execution_signature_replay"}
            and bundle is not None
            and _feedback_has_nonpositive_expected_value(bundle.objective_scorecard)
        ):
            return min(-1_000_000.0, target_by_spec.get(candidate_spec_id, raw_score))
        if (
            source == "feedback_family_replay"
            and bundle is not None
            and _feedback_has_nonpositive_expected_value(bundle.objective_scorecard)
        ):
            spec = spec_by_id.get(candidate_spec_id)
            if (
                spec is not None
                and _candidate_spec_matches_active_loss_counter_feedback(
                    spec,
                    bundle.objective_scorecard,
                    oracle_policy=policy,
                )
            ):
                return _active_loss_counter_proposal_score(
                    spec,
                    bundle.objective_scorecard,
                    raw_score=raw_score,
                    target_score=target_by_spec.get(candidate_spec_id, raw_score),
                    oracle_policy=policy,
                )
            return min(-1_000_000.0, target_by_spec.get(candidate_spec_id, raw_score))
        if (
            source == "feedback_family_replay"
            and bundle is not None
            and (
                _feedback_is_blocked(bundle.objective_scorecard, oracle_policy=policy)
                or _feedback_has_policy_penalty(
                    bundle.objective_scorecard, oracle_policy=policy
                )
            )
        ):
            spec = spec_by_id.get(candidate_spec_id)
            if spec is not None and _candidate_spec_matches_consistency_repair_feedback(
                spec,
                bundle.objective_scorecard,
                oracle_policy=policy,
            ):
                return _consistency_repair_proposal_score(
                    spec,
                    bundle.objective_scorecard,
                    raw_score=raw_score,
                    target_score=target_by_spec.get(candidate_spec_id, raw_score),
                    oracle_policy=policy,
                )
        if (
            source == "feedback_shape_prior"
            and bundle is not None
            and _feedback_family_prior_has_hard_block(
                bundle.objective_scorecard, oracle_policy=policy
            )
        ):
            return min(-1_000_000.0, target_by_spec.get(candidate_spec_id, raw_score))
        if (
            source == "feedback_risk_profile_prior"
            and bundle is not None
            and _feedback_risk_profile_has_terminal_block(
                bundle.objective_scorecard, oracle_policy=policy
            )
        ):
            return min(-1_000_000.0, target_by_spec.get(candidate_spec_id, raw_score))
        if (
            source == "feedback_risk_profile_prior"
            and bundle is not None
            and _feedback_risk_profile_has_penalty(
                bundle.objective_scorecard, oracle_policy=policy
            )
        ):
            return min(-500_000.0, target_by_spec.get(candidate_spec_id, raw_score))
        if (
            source == "feedback_family_replay"
            and bundle is not None
            and _feedback_is_blocked(bundle.objective_scorecard, oracle_policy=policy)
        ):
            return min(-100_000.0, target_by_spec.get(candidate_spec_id, raw_score))
        return raw_score

    rows_unranked = [
        {
            "candidate_spec_id": item.candidate_spec_id,
            "proposal_score": proposal_score_for_item(
                item.candidate_spec_id, item.score
            ),
            "raw_mlx_proposal_score": item.score,
            "feedback_replay_target": target_by_spec.get(item.candidate_spec_id)
            if item.candidate_spec_id in feedback_bundle_by_spec
            else None,
            "backend": item.backend,
            "model_id": item.model_id,
            "selection_reason": row_selection_reason(item.candidate_spec_id),
            "training_source": training_source_by_spec.get(
                item.candidate_spec_id, "synthetic_prior"
            ),
            "feedback_source_candidate_spec_id": feedback_source_candidate_spec_by_spec.get(
                item.candidate_spec_id
            ),
            "feedback_match_scope": feedback_match_scope_by_spec.get(
                item.candidate_spec_id
            ),
            "active_loss_counter_tags": sorted(
                _candidate_spec_active_loss_counter_tags(
                    spec_by_id[item.candidate_spec_id]
                )
            )
            if row_selection_reason(item.candidate_spec_id)
            == "pre_replay_mlx_active_loss_counter_candidate"
            else [],
            "active_loss_counter_feedback_reasons": sorted(
                _feedback_active_loss_counter_candidate_reasons(
                    feedback_bundle_by_spec[item.candidate_spec_id].objective_scorecard,
                    oracle_policy=policy,
                )
            )
            if row_selection_reason(item.candidate_spec_id)
            == "pre_replay_mlx_active_loss_counter_candidate"
            and item.candidate_spec_id in feedback_bundle_by_spec
            else [],
            "consistency_repair_tags": sorted(
                _candidate_spec_active_loss_counter_tags(
                    spec_by_id[item.candidate_spec_id]
                )
            )
            if row_selection_reason(item.candidate_spec_id)
            == "pre_replay_mlx_consistency_repair_candidate"
            else [],
            "consistency_repair_feedback_reasons": sorted(
                _feedback_consistency_repair_candidate_reasons(
                    feedback_bundle_by_spec[item.candidate_spec_id].objective_scorecard,
                    oracle_policy=policy,
                )
            )
            if row_selection_reason(item.candidate_spec_id)
            == "pre_replay_mlx_consistency_repair_candidate"
            and item.candidate_spec_id in feedback_bundle_by_spec
            else [],
            "feedback_evidence_context_count": len(feedback_evidence_bundles),
            "feature_hash": item.feature_hash,
            "features": feature_by_spec.get(item.candidate_spec_id, {}),
        }
        for item in ranked_rows
    ]
    rows_unranked.sort(
        key=lambda row: (
            -float(row.get("proposal_score") or 0.0),
            _string(row.get("candidate_spec_id")),
        )
    )
    rows = [{**row, "rank": index} for index, row in enumerate(rows_unranked, start=1)]
    return {
        **model.to_payload(),
        "proposal_stage": "pre_replay",
        "model_status": "active",
        "rank_bucket_lift": {"status": "pending_replay_evidence"},
        "feedback_evidence_bundle_count": len(feedback_evidence_bundles),
        "feedback_matched_spec_count": len(feedback_by_spec),
        "feedback_execution_signature_matched_spec_count": len(
            signature_feedback_by_spec
        ),
        "feedback_shape_matched_spec_count": len(shape_feedback_by_spec),
        "feedback_risk_profile_matched_spec_count": len(risk_profile_feedback_by_spec),
        "feedback_family_matched_spec_count": len(family_feedback_by_spec),
        "training_source_counts": training_source_counts,
    }, rows


def _proposal_score_confidence(
    proposal_rows: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    scores = [
        Decimal(str(row.get("proposal_score")))
        for row in _list_of_mappings(list(proposal_rows))
        if row.get("proposal_score") is not None
    ]
    if len(scores) < 2:
        return {
            "confidence": "low",
            "score_spread": "0",
            "reason": "insufficient_ranked_candidates",
        }
    score_spread = max(scores) - min(scores)
    confidence = "low" if score_spread < Decimal("5") else "normal"
    return {
        "confidence": confidence,
        "score_spread": str(score_spread),
        "reason": "low_score_dispersion"
        if confidence == "low"
        else "score_dispersion_sufficient",
    }


def _selection_reason_blocks_replay(reason: str) -> bool:
    return reason in _PRE_REPLAY_SELECTION_BLOCK_REASONS


__all__ = [
    "_pre_replay_proposal_model_and_rows",
    "_proposal_score_confidence",
    "_candidate_spec_execution_signature",
    "_selection_reason_blocks_replay",
]
