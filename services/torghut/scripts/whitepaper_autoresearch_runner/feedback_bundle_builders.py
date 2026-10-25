#!/usr/bin/env python3
"""Run a whitepaper-driven autoresearch epoch targeting a portfolio profit objective."""

from __future__ import annotations

from dataclasses import replace


from app.trading.discovery.candidate_specs import (
    CandidateSpec,
)
from app.trading.discovery.evidence_bundles import (
    CandidateEvidenceBundle,
    evidence_bundle_from_frontier_candidate,
)


from scripts.whitepaper_autoresearch_runner.candidate_prior_scoring import (
    _candidate_payload_with_feedback_metadata,
    _candidate_spec_feedback_metadata,
    _pre_replay_candidate_score,
)


def _pre_replay_prior_bundle(spec: CandidateSpec) -> CandidateEvidenceBundle:
    prior_score = _pre_replay_candidate_score(spec)
    return evidence_bundle_from_frontier_candidate(
        candidate_spec_id=spec.candidate_spec_id,
        candidate=_candidate_payload_with_feedback_metadata(
            spec=spec,
            candidate={
                "candidate_id": f"pre-replay-prior-{spec.candidate_spec_id}",
                "objective_scorecard": {
                    "net_pnl_per_day": str(prior_score),
                    "active_day_ratio": "0.50",
                    "positive_day_ratio": "0.50",
                    "regime_slice_pass_rate": "0.45",
                    "posterior_edge_lower": "0.001",
                    "shadow_parity_status": "pending",
                },
                "promotion_readiness": {
                    "stage": "research_candidate",
                    "status": "pre_replay_prior",
                    "promotable": False,
                    "blockers": ["runtime_replay_required"],
                },
            },
        ),
        dataset_snapshot_id="pre-replay-proposal-priors",
        result_path=f"pre-replay-proposal-priors://{spec.candidate_spec_id}",
    )


def _execution_signature_feedback_bundle_for_spec(
    *,
    spec: CandidateSpec,
    bundle: CandidateEvidenceBundle,
) -> CandidateEvidenceBundle:
    scorecard = {
        **dict(bundle.objective_scorecard),
        **_candidate_spec_feedback_metadata(spec),
        "feedback_match_scope": "execution_signature",
        "feedback_source_candidate_spec_id": bundle.candidate_spec_id,
    }
    return replace(
        bundle,
        candidate_spec_id=spec.candidate_spec_id,
        candidate_id=f"signature-feedback-{bundle.candidate_id}",
        objective_scorecard=scorecard,
    )


def _shape_feedback_bundle_for_spec(
    *,
    spec: CandidateSpec,
    bundle: CandidateEvidenceBundle,
) -> CandidateEvidenceBundle:
    scorecard = {
        **dict(bundle.objective_scorecard),
        **_candidate_spec_feedback_metadata(spec),
        "feedback_match_scope": "feedback_shape_key",
        "feedback_source_candidate_spec_id": bundle.candidate_spec_id,
    }
    return replace(
        bundle,
        candidate_spec_id=spec.candidate_spec_id,
        candidate_id=f"shape-feedback-{bundle.candidate_id}",
        objective_scorecard=scorecard,
    )


def _risk_profile_feedback_bundle_for_spec(
    *,
    spec: CandidateSpec,
    bundle: CandidateEvidenceBundle,
) -> CandidateEvidenceBundle:
    scorecard = {
        **dict(bundle.objective_scorecard),
        **_candidate_spec_feedback_metadata(spec),
        "feedback_match_scope": "feedback_risk_profile_key",
        "feedback_source_candidate_spec_id": bundle.candidate_spec_id,
    }
    return replace(
        bundle,
        candidate_spec_id=spec.candidate_spec_id,
        candidate_id=f"risk-profile-feedback-{bundle.candidate_id}",
        objective_scorecard=scorecard,
    )


def _family_feedback_bundle_for_spec(
    *,
    spec: CandidateSpec,
    bundle: CandidateEvidenceBundle,
) -> CandidateEvidenceBundle:
    scorecard = {
        **dict(bundle.objective_scorecard),
        **_candidate_spec_feedback_metadata(spec),
        "feedback_match_scope": "family_template_id",
        "feedback_source_candidate_spec_id": bundle.candidate_spec_id,
    }
    return replace(
        bundle,
        candidate_spec_id=spec.candidate_spec_id,
        candidate_id=f"family-feedback-{bundle.candidate_id}",
        objective_scorecard=scorecard,
    )


__all__ = [
    "_pre_replay_prior_bundle",
    "_execution_signature_feedback_bundle_for_spec",
    "_shape_feedback_bundle_for_spec",
    "_risk_profile_feedback_bundle_for_spec",
    "_family_feedback_bundle_for_spec",
]
