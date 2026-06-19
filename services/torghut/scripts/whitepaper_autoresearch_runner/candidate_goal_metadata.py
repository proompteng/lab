#!/usr/bin/env python3
"""Run a whitepaper-driven autoresearch epoch targeting a portfolio profit objective."""

from __future__ import annotations

from typing import Any, Mapping, Sequence, cast


from app.trading.discovery.candidate_specs import (
    CandidateSpec,
)
from app.trading.discovery.evidence_bundles import (
    CandidateEvidenceBundle,
)
from app.trading.discovery.portfolio_optimizer import (
    PortfolioCandidateSpec,
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

from scripts.whitepaper_autoresearch_runner.candidate_prior_scoring import (
    _candidate_spec_mechanism_overlay_ids,
    _candidate_spec_required_evidence_tokens,
    _paper_mechanism_prior_score,
)


def _selected_candidate_spec_ids(
    candidate_selection: Mapping[str, Any],
) -> set[str]:
    explicit_ids = set(
        _string_list_from_value(candidate_selection.get("selected_candidate_spec_ids"))
    )
    selected_rows = {
        _string(row.get("candidate_spec_id"))
        for row in _list_of_mappings(candidate_selection.get("rows"))
        if bool(row.get("selected_for_replay"))
        and _string(row.get("candidate_spec_id"))
    }
    return explicit_ids | selected_rows


def _candidate_family_goal_rows(
    *,
    candidate_specs: Sequence[CandidateSpec],
    candidate_selection: Mapping[str, Any],
    evidence_bundles: Sequence[CandidateEvidenceBundle],
) -> list[dict[str, Any]]:
    selected_ids = _selected_candidate_spec_ids(candidate_selection)
    evidence_by_spec = {bundle.candidate_spec_id: bundle for bundle in evidence_bundles}
    rows_by_family: dict[str, dict[str, Any]] = {}
    for spec in candidate_specs:
        family_id = spec.family_template_id
        row = rows_by_family.setdefault(
            family_id,
            {
                "family_template_id": family_id,
                "runtime_families": set(),
                "runtime_strategy_names": set(),
                "candidate_spec_count": 0,
                "selected_for_replay_count": 0,
                "evidence_bundle_count": 0,
                "sample_candidate_spec_ids": [],
                "sample_selected_candidate_spec_ids": [],
            },
        )
        row["candidate_spec_count"] = int(row["candidate_spec_count"]) + 1
        cast(set[str], row["runtime_families"]).add(spec.runtime_family)
        cast(set[str], row["runtime_strategy_names"]).add(spec.runtime_strategy_name)
        if len(cast(list[str], row["sample_candidate_spec_ids"])) < 3:
            cast(list[str], row["sample_candidate_spec_ids"]).append(
                spec.candidate_spec_id
            )
        if spec.candidate_spec_id in selected_ids:
            row["selected_for_replay_count"] = int(row["selected_for_replay_count"]) + 1
            if len(cast(list[str], row["sample_selected_candidate_spec_ids"])) < 3:
                cast(list[str], row["sample_selected_candidate_spec_ids"]).append(
                    spec.candidate_spec_id
                )
        if spec.candidate_spec_id in evidence_by_spec:
            row["evidence_bundle_count"] = int(row["evidence_bundle_count"]) + 1

    payload_rows: list[dict[str, Any]] = []
    for row in rows_by_family.values():
        payload_rows.append(
            {
                **row,
                "runtime_families": sorted(cast(set[str], row["runtime_families"])),
                "runtime_strategy_names": sorted(
                    cast(set[str], row["runtime_strategy_names"])
                ),
            }
        )
    payload_rows.sort(
        key=lambda row: (
            -int(row.get("selected_for_replay_count") or 0),
            -int(row.get("candidate_spec_count") or 0),
            _string(row.get("family_template_id")),
        )
    )
    return payload_rows


def _candidate_sleeve_goal_proof_handoff_fields(
    *,
    selection: Mapping[str, Any],
    spec: CandidateSpec | None,
    scorecard: Mapping[str, Any],
    evidence: CandidateEvidenceBundle | None,
    selected_for_replay: bool,
) -> dict[str, Any]:
    artifact_refs = list(evidence.replay_artifact_refs) if evidence is not None else []
    runtime_ledger_row = {**dict(scorecard), "replay_artifact_refs": artifact_refs}
    exact_replay_ledger_artifact_refs = _candidate_board_exact_replay_ledger_refs(
        runtime_ledger_row
    )
    exact_replay_ledger_artifact_ref = _string(
        scorecard.get("exact_replay_ledger_artifact_ref")
    )
    if not exact_replay_ledger_artifact_ref and exact_replay_ledger_artifact_refs:
        exact_replay_ledger_artifact_ref = exact_replay_ledger_artifact_refs[0]
    runtime_window_start, runtime_window_end = _candidate_board_runtime_window_bounds(
        scorecard
    )
    paper_contract_prior_score = _string(selection.get("paper_contract_prior_score"))
    if not paper_contract_prior_score and spec is not None:
        paper_contract_prior_score = str(_paper_mechanism_prior_score(spec))
    paper_mechanism_overlay_ids = _string_list_from_value(
        selection.get("paper_mechanism_overlay_ids")
    )
    if not paper_mechanism_overlay_ids and spec is not None:
        paper_mechanism_overlay_ids = sorted(
            _candidate_spec_mechanism_overlay_ids(spec)
        )
    paper_required_evidence_tokens = _string_list_from_value(
        selection.get("paper_required_evidence_tokens")
    )
    if not paper_required_evidence_tokens and spec is not None:
        paper_required_evidence_tokens = sorted(
            _candidate_spec_required_evidence_tokens(spec)
        )
    paper_required_evidence_count = _candidate_board_int_field(
        selection, "paper_required_evidence_count"
    )
    if paper_required_evidence_count <= 0:
        paper_required_evidence_count = len(paper_required_evidence_tokens)
    paper_contract_candidate = bool(
        _decimal(paper_contract_prior_score) > 0
        or paper_mechanism_overlay_ids
        or paper_required_evidence_tokens
    )
    runtime_ledger_lineage_handoff = _candidate_board_runtime_ledger_lineage_handoff(
        scorecard=scorecard,
        evidence=evidence,
    )
    runtime_ledger_required_materialized_artifacts = (
        _candidate_board_runtime_ledger_required_materialized_artifacts(
            runtime_ledger_lineage_handoff
        )
    )
    proof_handoff: dict[str, Any] = {
        "replay_selection_reason": _string(selection.get("selection_reason"))
        or ("selected_for_replay" if selected_for_replay else "not_selected_budget"),
        "paper_contract_candidate": paper_contract_candidate,
        "paper_contract_selected_for_replay": bool(
            selected_for_replay and paper_contract_candidate
        ),
        "paper_contract_prior_score": paper_contract_prior_score,
        "paper_mechanism_overlay_ids": paper_mechanism_overlay_ids,
        "paper_required_evidence_tokens": paper_required_evidence_tokens,
        "paper_required_evidence_count": paper_required_evidence_count,
        "runtime_window_start": runtime_window_start,
        "runtime_window_end": runtime_window_end,
        "exact_replay_ledger_artifact_refs": list(exact_replay_ledger_artifact_refs),
        "exact_replay_ledger_artifact_ref": exact_replay_ledger_artifact_ref,
        "exact_replay_ledger_artifact_row_count": _candidate_board_first_int_field(
            scorecard,
            ("exact_replay_ledger_artifact_row_count",),
        ),
        "exact_replay_ledger_artifact_fill_count": _candidate_board_first_int_field(
            scorecard,
            ("exact_replay_ledger_artifact_fill_count",),
        ),
    }
    if runtime_ledger_lineage_handoff:
        proof_handoff["runtime_ledger_lineage_materialization_handoff"] = dict(
            runtime_ledger_lineage_handoff
        )
        proof_handoff["runtime_ledger_required_materialized_artifacts"] = (
            runtime_ledger_required_materialized_artifacts
        )
        materialization_status = _string(
            runtime_ledger_lineage_handoff.get("materialization_status")
            or runtime_ledger_lineage_handoff.get("status")
        )
        if materialization_status:
            proof_handoff["runtime_ledger_materialization_status"] = (
                materialization_status
            )
        if _boolish(
            runtime_ledger_lineage_handoff.get(
                "zero_authoritative_daily_pnl_until_materialized"
            )
        ):
            proof_handoff["zero_authoritative_daily_pnl_until_materialized"] = True
    return proof_handoff


def _candidate_sleeve_goal_rows(
    *,
    candidate_specs: Sequence[CandidateSpec],
    candidate_selection: Mapping[str, Any],
    evidence_bundles: Sequence[CandidateEvidenceBundle],
    false_positive_table: Sequence[Mapping[str, Any]],
    best_false_negative_table: Sequence[Mapping[str, Any]],
    portfolio: PortfolioCandidateSpec | None,
    limit: int = 16,
) -> list[dict[str, Any]]:
    spec_by_id = {spec.candidate_spec_id: spec for spec in candidate_specs}
    evidence_by_spec = {bundle.candidate_spec_id: bundle for bundle in evidence_bundles}
    selection_by_spec = {
        _string(row.get("candidate_spec_id")): row
        for row in _list_of_mappings(candidate_selection.get("rows"))
        if _string(row.get("candidate_spec_id"))
    }
    if portfolio is not None:
        rows: list[dict[str, Any]] = []
        for sleeve in portfolio.sleeves[:limit]:
            row = dict(sleeve)
            candidate_spec_id = _string(row.get("candidate_spec_id"))
            spec = spec_by_id.get(candidate_spec_id)
            evidence = evidence_by_spec.get(candidate_spec_id)
            scorecard = evidence.objective_scorecard if evidence is not None else {}
            selection = selection_by_spec.get(candidate_spec_id, {})
            if spec is not None:
                row["family_template_id"] = spec.family_template_id
                row["runtime_family"] = spec.runtime_family
                row["runtime_strategy_name"] = spec.runtime_strategy_name
                row["market_impact_proof"] = (
                    _candidate_board_market_impact_proof_summary(scorecard)
                )
                row["regime_specialist_validation"] = (
                    _candidate_board_regime_specialist_summary(spec, scorecard)
                )
                row["order_type_execution_quality"] = (
                    _candidate_board_order_type_execution_quality_summary(
                        spec, scorecard
                    )
                )
                row["queue_position_survival_fill_quality"] = (
                    _candidate_board_queue_position_survival_summary(spec, scorecard)
                )
            row["evidence_status"] = "replayed" if evidence is not None else "missing"
            row["evidence_lineage"] = _candidate_board_evidence_lineage_summary(
                evidence
            )
            row["replay_window_coverage"] = (
                _candidate_board_replay_window_coverage_summary(scorecard)
            )
            row["replay_artifact_refs"] = (
                list(evidence.replay_artifact_refs) if evidence is not None else []
            )
            row.update(
                _candidate_sleeve_goal_proof_handoff_fields(
                    selection=selection,
                    spec=spec,
                    scorecard=scorecard,
                    evidence=evidence,
                    selected_for_replay=True,
                )
            )
            rows.append(row)
        return rows

    failure_by_spec = {
        _string(row.get("candidate_spec_id")): list(
            cast(Sequence[Any], row.get("failure_reasons") or ())
        )
        for row in _list_of_mappings(list(false_positive_table))
        if _string(row.get("candidate_spec_id"))
    }
    rows: list[dict[str, Any]] = []
    for selection in _list_of_mappings(candidate_selection.get("rows")):
        candidate_spec_id = _string(selection.get("candidate_spec_id"))
        if not candidate_spec_id or not bool(selection.get("selected_for_replay")):
            continue
        spec = spec_by_id.get(candidate_spec_id)
        evidence = evidence_by_spec.get(candidate_spec_id)
        scorecard = evidence.objective_scorecard if evidence is not None else {}
        order_type_summary = (
            _candidate_board_order_type_execution_quality_summary(spec, scorecard)
            if spec is not None
            else {"required": False, "passed": True, "blockers": []}
        )
        queue_position_survival_summary = (
            _candidate_board_queue_position_survival_summary(spec, scorecard)
            if spec is not None
            else {"required": False, "passed": True, "blockers": []}
        )
        evidence_lineage = _candidate_board_evidence_lineage_summary(evidence)
        replay_window_coverage = _candidate_board_replay_window_coverage_summary(
            scorecard
        )
        proof_handoff = _candidate_sleeve_goal_proof_handoff_fields(
            selection=selection,
            spec=spec,
            scorecard=scorecard,
            evidence=evidence,
            selected_for_replay=True,
        )
        rows.append(
            {
                "candidate_spec_id": candidate_spec_id,
                "candidate_id": evidence.candidate_id if evidence is not None else None,
                "family_template_id": spec.family_template_id
                if spec is not None
                else None,
                "runtime_family": spec.runtime_family if spec is not None else None,
                "runtime_strategy_name": spec.runtime_strategy_name
                if spec is not None
                else None,
                "rank": _rank_sort_value(selection.get("rank")),
                "pre_replay_score": _string(selection.get("pre_replay_score")),
                "evidence_status": "replayed" if evidence is not None else "missing",
                "net_pnl_per_day": _string(scorecard.get("net_pnl_per_day")),
                "active_day_ratio": _string(scorecard.get("active_day_ratio")),
                "positive_day_ratio": _string(scorecard.get("positive_day_ratio")),
                "replay_artifact_refs": list(evidence.replay_artifact_refs)
                if evidence is not None
                else [],
                "evidence_lineage": evidence_lineage,
                "replay_window_coverage": replay_window_coverage,
                "order_type_execution_quality": order_type_summary,
                "queue_position_survival_fill_quality": (
                    queue_position_survival_summary
                ),
                **proof_handoff,
                "failure_reasons": [
                    _string(item)
                    for item in failure_by_spec.get(candidate_spec_id, ())
                    if _string(item)
                ],
            }
        )
        if len(rows) >= limit:
            break

    if len(rows) < limit:
        for row in _list_of_mappings(list(best_false_negative_table)):
            candidate_spec_id = _string(row.get("candidate_spec_id"))
            if not candidate_spec_id:
                continue
            spec = spec_by_id.get(candidate_spec_id)
            selection = selection_by_spec.get(candidate_spec_id, row)
            rows.append(
                {
                    "candidate_spec_id": candidate_spec_id,
                    "candidate_id": None,
                    "family_template_id": spec.family_template_id
                    if spec is not None
                    else None,
                    "runtime_family": spec.runtime_family if spec is not None else None,
                    "runtime_strategy_name": spec.runtime_strategy_name
                    if spec is not None
                    else None,
                    "rank": _rank_sort_value(row.get("rank")),
                    "pre_replay_score": _string(row.get("pre_replay_score")),
                    "evidence_status": "not_replayed",
                    "reason": _string(row.get("reason")) or "not_replayed_budget",
                    **_candidate_sleeve_goal_proof_handoff_fields(
                        selection=selection,
                        spec=spec,
                        scorecard={},
                        evidence=None,
                        selected_for_replay=False,
                    ),
                    "failure_reasons": ["not_replayed_budget"],
                }
            )
            if len(rows) >= limit:
                break
    return rows


__all__ = [
    "_selected_candidate_spec_ids",
    "_candidate_family_goal_rows",
    "_candidate_sleeve_goal_proof_handoff_fields",
    "_candidate_sleeve_goal_rows",
]
