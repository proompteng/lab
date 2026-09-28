#!/usr/bin/env python3
"""Candidate identity helpers for whitepaper autoresearch orchestration."""

from __future__ import annotations

from app.trading.discovery.candidate_specs import CandidateSpec

from scripts.whitepaper_autoresearch_runner.common import _stable_hash


def _candidate_spec_execution_signature(spec: CandidateSpec) -> str:
    vnext_payload = spec.to_vnext_experiment_payload()
    return _stable_hash(
        {
            "family_template_id": spec.family_template_id,
            "runtime_family": spec.runtime_family,
            "runtime_strategy_name": spec.runtime_strategy_name,
            "template_overrides": vnext_payload.get("template_overrides", {}),
            "feature_variants": vnext_payload.get("feature_variants", []),
            "veto_controller_variants": vnext_payload.get(
                "veto_controller_variants", []
            ),
            "selection_objectives": vnext_payload.get("selection_objectives", {}),
            "hard_vetoes": vnext_payload.get("hard_vetoes", {}),
        }
    )


__all__ = ["_candidate_spec_execution_signature"]
