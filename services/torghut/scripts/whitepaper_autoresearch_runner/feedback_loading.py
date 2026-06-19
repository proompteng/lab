#!/usr/bin/env python3
"""Run a whitepaper-driven autoresearch epoch targeting a portfolio profit objective."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping, Sequence, cast


from app.models import (
    AutoresearchEpoch,
)
from app.trading.discovery.candidate_specs import (
    CandidateSpec,
)
from app.trading.discovery.candidate_specs import candidate_spec_from_payload
from app.trading.discovery.evidence_bundles import (
    CandidateEvidenceBundle,
    evidence_bundle_from_frontier_candidate,
    evidence_bundle_from_payload,
)


from scripts.whitepaper_autoresearch_runner.candidate_board_fields import (
    _candidate_board_score_rows as _candidate_board_score_rows,
    _candidate_board_decimal_field as _candidate_board_decimal_field,
    _candidate_board_int_field as _candidate_board_int_field,
    _candidate_board_first_int_field as _candidate_board_first_int_field,
)
from scripts.whitepaper_autoresearch_runner.candidate_board_paper_probation import (
    _paper_probation_candidate_payload as _paper_probation_candidate_payload,
    _candidate_board_paper_probation_candidates as _candidate_board_paper_probation_candidates,
    _candidate_board_paper_probation_candidate as _candidate_board_paper_probation_candidate,
    _candidate_board_status_digest as _candidate_board_status_digest,
    _candidate_board_double_oos_summary as _candidate_board_double_oos_summary,
    _candidate_board_portfolio_promotion_subject as _candidate_board_portfolio_promotion_subject,
)
from scripts.whitepaper_autoresearch_runner.candidate_board_payloads import (
    _candidate_board_factor_acceptance_summary as _candidate_board_factor_acceptance_summary,
    _candidate_board_payload as _candidate_board_payload,
    _paper_probation_handoff_payload as _paper_probation_handoff_payload,
    _portfolio_with_runtime_closure_proof as _portfolio_with_runtime_closure_proof,
    _runtime_closure_program_for_candidate as _runtime_closure_program_for_candidate,
)
from scripts.whitepaper_autoresearch_runner.candidate_board_runtime_windows import (
    _candidate_board_hypothesis_manifest_ref as _candidate_board_hypothesis_manifest_ref,
    _candidate_board_runtime_window_bounds as _candidate_board_runtime_window_bounds,
    _candidate_board_date_only as _candidate_board_date_only,
    _candidate_board_regular_session_bound as _candidate_board_regular_session_bound,
    _candidate_board_runtime_window_import_bounds as _candidate_board_runtime_window_import_bounds,
    _candidate_board_exact_replay_ledger_refs as _candidate_board_exact_replay_ledger_refs,
    _candidate_board_runtime_import_args as _candidate_board_runtime_import_args,
    _candidate_board_runtime_window_import_plan as _candidate_board_runtime_window_import_plan,
    _candidate_factor_acceptance_replay_metadata as _candidate_factor_acceptance_replay_metadata,
)
from scripts.whitepaper_autoresearch_runner.candidate_board_summaries import (
    _candidate_board_rejected_signal_outcome_summary as _candidate_board_rejected_signal_outcome_summary,
    _candidate_spec_requires_order_type_execution_quality as _candidate_spec_requires_order_type_execution_quality,
    _candidate_spec_requires_predictability_decay_stress as _candidate_spec_requires_predictability_decay_stress,
    _candidate_board_predictability_decay_summary as _candidate_board_predictability_decay_summary,
    _candidate_board_scorecard_with_predictability_decay_blockers as _candidate_board_scorecard_with_predictability_decay_blockers,
    _candidate_board_order_type_execution_quality_summary as _candidate_board_order_type_execution_quality_summary,
    _candidate_board_scorecard_with_order_type_blockers as _candidate_board_scorecard_with_order_type_blockers,
    _candidate_spec_requires_queue_position_survival as _candidate_spec_requires_queue_position_survival,
    _candidate_board_queue_position_survival_summary as _candidate_board_queue_position_survival_summary,
    _candidate_board_scorecard_with_queue_position_survival_blockers as _candidate_board_scorecard_with_queue_position_survival_blockers,
    _candidate_board_scorecard_with_rejected_signal_blockers as _candidate_board_scorecard_with_rejected_signal_blockers,
    _candidate_board_evidence_lineage_summary as _candidate_board_evidence_lineage_summary,
    _candidate_board_scorecard_with_lineage_blockers as _candidate_board_scorecard_with_lineage_blockers,
    _candidate_board_replay_window_coverage_summary as _candidate_board_replay_window_coverage_summary,
    _candidate_board_market_impact_proof_summary as _candidate_board_market_impact_proof_summary,
    _candidate_board_regime_specialist_summary as _candidate_board_regime_specialist_summary,
    _candidate_board_scorecard_with_replay_window_blockers as _candidate_board_scorecard_with_replay_window_blockers,
    _candidate_board_scorecard_with_evidence_blockers as _candidate_board_scorecard_with_evidence_blockers,
)
from scripts.whitepaper_autoresearch_runner.candidate_board_status import (
    _candidate_board_blockers as _candidate_board_blockers,
    _candidate_board_status as _candidate_board_status,
    _candidate_board_activity_count as _candidate_board_activity_count,
    _candidate_board_oracle_blocker_count as _candidate_board_oracle_blocker_count,
    _candidate_board_net_pnl as _candidate_board_net_pnl,
    _candidate_board_lower_bound_net_pnl as _candidate_board_lower_bound_net_pnl,
    _candidate_board_target_progress_ratio as _candidate_board_target_progress_ratio,
    _candidate_board_required_notional_repair_scale as _candidate_board_required_notional_repair_scale,
    _candidate_board_best_executed_candidate as _candidate_board_best_executed_candidate,
    _candidate_board_closest_promotion_candidate as _candidate_board_closest_promotion_candidate,
    _candidate_board_paper_probation_admission_blockers as _candidate_board_paper_probation_admission_blockers,
)
from scripts.whitepaper_autoresearch_runner.common import (
    _CANDIDATE_BOARD_RUNTIME_SESSION_TZ as _CANDIDATE_BOARD_RUNTIME_SESSION_TZ,
    _CANDIDATE_BOARD_RUNTIME_SESSION_OPEN as _CANDIDATE_BOARD_RUNTIME_SESSION_OPEN,
    _CANDIDATE_BOARD_RUNTIME_SESSION_CLOSE as _CANDIDATE_BOARD_RUNTIME_SESSION_CLOSE,
    _PAPER_PROBATION_LIVE_PAPER_EVIDENCE_REQUIREMENTS as _PAPER_PROBATION_LIVE_PAPER_EVIDENCE_REQUIREMENTS,
    _PAPER_PROBATION_SAFE_EVIDENCE_COLLECTION_PATH as _PAPER_PROBATION_SAFE_EVIDENCE_COLLECTION_PATH,
    _SECOND_OOS_WINDOW_ID as _SECOND_OOS_WINDOW_ID,
    _RUNTIME_CLOSURE_PROOF_ORACLE_BLOCKERS as _RUNTIME_CLOSURE_PROOF_ORACLE_BLOCKERS,
    _resolve_existing_path as _resolve_existing_path,
    _stable_hash as _stable_hash,
    _decimal as _decimal,
    _decimal_payload as _decimal_payload,
    _mapping as _mapping,
    _string as _string,
    _list_of_mappings as _list_of_mappings,
    _sequence_of_mappings as _sequence_of_mappings,
    _rank_sort_value as _rank_sort_value,
    _proposal_sort_value as _proposal_sort_value,
    _string_list_from_value as _string_list_from_value,
    _candidate_board_runtime_ledger_lineage_handoff as _candidate_board_runtime_ledger_lineage_handoff,
    _candidate_board_runtime_ledger_required_materialized_artifacts as _candidate_board_runtime_ledger_required_materialized_artifacts,
    _candidate_spec_requires_rejected_signal_outcome_learning as _candidate_spec_requires_rejected_signal_outcome_learning,
    _boolish as _boolish,
    _oracle_blockers as _oracle_blockers,
)
from scripts.whitepaper_autoresearch_runner.runtime_closure import (
    _runtime_closure_payload as _runtime_closure_payload,
    _portfolio_needs_runtime_closure_proof as _portfolio_needs_runtime_closure_proof,
    _load_json_mapping_artifact as _load_json_mapping_artifact,
    _runtime_closure_artifact_refs as _runtime_closure_artifact_refs,
    _runtime_report_summary_int as _runtime_report_summary_int,
    _runtime_report_int as _runtime_report_int,
    _runtime_closure_ledger_datetime as _runtime_closure_ledger_datetime,
    _runtime_closure_exact_replay_bucket_range as _runtime_closure_exact_replay_bucket_range,
    _runtime_closure_replay_bucket_has_authority as _runtime_closure_replay_bucket_has_authority,
    _runtime_closure_exact_replay_bucket as _runtime_closure_exact_replay_bucket,
    _runtime_report_source_markers as _runtime_report_source_markers,
    _market_impact_default_source_markers as _market_impact_default_source_markers,
    _runtime_closure_start_equity as _runtime_closure_start_equity,
    _portfolio_executable_max_notional as _portfolio_executable_max_notional,
    _runtime_closure_exact_replay_ledger_update as _runtime_closure_exact_replay_ledger_update,
    _runtime_closure_market_impact_stress_update as _runtime_closure_market_impact_stress_update,
    _runtime_closure_delay_adjusted_depth_stress_update as _runtime_closure_delay_adjusted_depth_stress_update,
    _runtime_closure_double_oos_update as _runtime_closure_double_oos_update,
    _runtime_closure_scorecard_update as _runtime_closure_scorecard_update,
    _runtime_closure_pending_promotion_steps as _runtime_closure_pending_promotion_steps,
    _runtime_closure_promotion_prerequisite_blockers as _runtime_closure_promotion_prerequisite_blockers,
    _promotion_readiness_payload as _promotion_readiness_payload,
)

from scripts.whitepaper_autoresearch_runner.candidate_identity import (
    _candidate_spec_execution_signature,
)

_MAX_PERSISTED_FEEDBACK_EVIDENCE_BUNDLES = 512

_REJECTED_SIGNAL_OUTCOME_REQUIRED_FIELDS = (
    "counterfactual_return",
    "route_tca",
    "post_cost_net_pnl",
    "executable_quote",
)


def _load_feedback_evidence_bundles(
    paths: Sequence[Path],
) -> tuple[CandidateEvidenceBundle, ...]:
    bundles: list[CandidateEvidenceBundle] = []
    for raw_path in paths:
        path = _resolve_existing_path(raw_path)
        if not path.exists():
            raise ValueError(f"feedback_evidence_jsonl_missing:{raw_path}")
        for line_number, line in enumerate(
            path.read_text(encoding="utf-8").splitlines(), start=1
        ):
            text = line.strip()
            if not text:
                continue
            try:
                payload = json.loads(text)
                if not isinstance(payload, Mapping):
                    raise ValueError("payload_not_object")
                bundles.append(evidence_bundle_from_payload(payload))
            except Exception as exc:
                raise ValueError(
                    f"feedback_evidence_jsonl_invalid:{raw_path}:{line_number}:{exc}"
                ) from exc
    return tuple(bundles)


def _dedupe_feedback_evidence_bundles(
    bundles: Sequence[CandidateEvidenceBundle],
) -> tuple[CandidateEvidenceBundle, ...]:
    seen: set[str] = set()
    deduped: list[CandidateEvidenceBundle] = []
    for bundle in bundles:
        key = bundle.evidence_bundle_id or _stable_hash(bundle.to_payload())
        if key in seen:
            continue
        seen.add(key)
        deduped.append(bundle)
    return tuple(deduped)


def _evidence_bundle_payloads_for_epoch_summary(
    evidence_bundles: Sequence[CandidateEvidenceBundle],
) -> list[dict[str, Any]]:
    return [
        bundle.to_payload()
        for bundle in evidence_bundles[:_MAX_PERSISTED_FEEDBACK_EVIDENCE_BUNDLES]
    ]


def _candidate_spec_from_payload(payload: Mapping[str, Any]) -> CandidateSpec:
    return candidate_spec_from_payload(payload)


def _load_candidate_specs_jsonl(paths: Sequence[Path]) -> tuple[CandidateSpec, ...]:
    specs: list[CandidateSpec] = []
    seen: set[str] = set()
    for path in paths:
        if not path.exists():
            raise ValueError(f"candidate_specs_jsonl_missing:{path}")
        for line_number, line in enumerate(
            path.read_text(encoding="utf-8").splitlines(), start=1
        ):
            if not line.strip():
                continue
            try:
                payload = json.loads(line)
                spec = _candidate_spec_from_payload(_mapping(payload))
            except Exception as exc:
                raise ValueError(
                    f"candidate_specs_jsonl_invalid:{path}:{line_number}:{exc}"
                ) from exc
            if spec.candidate_spec_id in seen:
                raise ValueError(
                    f"candidate_specs_jsonl_duplicate_candidate_spec_id:{path}:{line_number}:{spec.candidate_spec_id}"
                )
            seen.add(spec.candidate_spec_id)
            specs.append(spec)
    if not specs:
        raise ValueError("candidate_specs_jsonl_empty")
    return tuple(specs)


def _summary_scorecard_feedback_bundles_for_epoch(
    epoch: AutoresearchEpoch,
    candidate_specs: Sequence[CandidateSpec],
) -> tuple[tuple[CandidateEvidenceBundle, ...], dict[str, int]]:
    stats = {
        "scorecard_count": 0,
        "matched_scorecard_count": 0,
        "unmatched_scorecard_count": 0,
        "bundle_count": 0,
    }
    summary = _mapping(epoch.summary_json)
    remediation = _mapping(summary.get("candidate_search_remediation"))
    scorecards = _list_of_mappings(remediation.get("partial_scorecards"))
    stats["scorecard_count"] = len(scorecards)
    if not scorecards or not candidate_specs:
        return (), stats

    spec_by_id = {spec.candidate_spec_id: spec for spec in candidate_specs}
    spec_by_signature = {
        _candidate_spec_execution_signature(spec): spec for spec in candidate_specs
    }
    build = _mapping(summary.get("build"))
    code_commit = _string(build.get("commit")) or "unknown"
    bundles: list[CandidateEvidenceBundle] = []
    for index, scorecard in enumerate(scorecards, start=1):
        candidate_spec_id = _string(scorecard.get("candidate_spec_id"))
        execution_signature = _string(scorecard.get("execution_signature"))
        spec = spec_by_id.get(candidate_spec_id) or spec_by_signature.get(
            execution_signature
        )
        if spec is None:
            stats["unmatched_scorecard_count"] += 1
            continue
        stats["matched_scorecard_count"] += 1
        candidate_id = _string(scorecard.get("candidate_id")) or spec.candidate_spec_id
        candidate = {
            "candidate_id": candidate_id,
            "family_template_id": _string(scorecard.get("family_template_id"))
            or spec.family_template_id,
            "runtime_family": _string(scorecard.get("runtime_family"))
            or spec.runtime_family,
            "runtime_strategy_name": _string(scorecard.get("runtime_strategy_name"))
            or spec.runtime_strategy_name,
            "execution_signature": execution_signature
            or _candidate_spec_execution_signature(spec),
            "objective_scorecard": scorecard,
            "hard_vetoes": scorecard.get("hard_vetoes")
            or scorecard.get("veto_reasons")
            or (),
            "promotion_readiness": {
                "stage": "research_candidate",
                "status": "blocked_by_prior_replay_scorecard",
                "promotable": False,
                "blockers": list(
                    str(item)
                    for item in cast(
                        Sequence[Any],
                        scorecard.get("hard_vetoes")
                        or scorecard.get("veto_reasons")
                        or (),
                    )
                    if str(item).strip()
                ),
            },
        }
        bundles.append(
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=spec.candidate_spec_id,
                candidate=candidate,
                dataset_snapshot_id=f"autoresearch-epoch:{epoch.epoch_id}:summary-scorecards",
                result_path=(
                    f"db://autoresearch_epochs/{epoch.epoch_id}/"
                    f"candidate_search_remediation/partial_scorecards/{index}"
                ),
                code_commit=code_commit,
            )
        )
    stats["bundle_count"] = len(bundles)
    return tuple(bundles), stats


def _outcome_payload_has_complete_rejected_signal_fields(
    payload: Mapping[str, Any],
    required_fields: Sequence[Any],
) -> bool:
    required = tuple(_string(field) for field in required_fields if _string(field))
    if not required:
        required = _REJECTED_SIGNAL_OUTCOME_REQUIRED_FIELDS
    for field in required:
        if field not in payload:
            return False
        value = payload.get(field)
        if value is None:
            return False
        if isinstance(value, str) and not value.strip():
            return False
        if isinstance(value, Mapping) and not value:
            return False
    return True


__all__ = [
    "_load_feedback_evidence_bundles",
    "_dedupe_feedback_evidence_bundles",
    "_evidence_bundle_payloads_for_epoch_summary",
    "_candidate_spec_from_payload",
    "_load_candidate_specs_jsonl",
    "_summary_scorecard_feedback_bundles_for_epoch",
    "_outcome_payload_has_complete_rejected_signal_fields",
]
