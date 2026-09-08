from __future__ import annotations

from dataclasses import replace
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping, Sequence, cast

from app.trading.discovery.autoresearch import StrategyAutoresearchProgram
from app.trading.discovery.candidate_specs import CandidateSpec
from app.trading.discovery.evidence_bundles import CandidateEvidenceBundle
from app.trading.discovery.mlx_snapshot import MlxSnapshotManifest
from app.trading.discovery.portfolio_optimizer import PortfolioCandidateSpec
from app.trading.discovery.profit_target_oracle import (
    ProfitTargetOraclePolicy,
    evaluate_profit_target_oracle,
)
from scripts.whitepaper_autoresearch_runner.candidate_board_fields import (
    _candidate_board_decimal_field,
    _candidate_board_first_int_field,
    _candidate_board_int_field,
    _candidate_board_score_rows,
)
from scripts.whitepaper_autoresearch_runner.candidate_board_paper_probation import (
    _candidate_board_double_oos_summary,
    _candidate_board_paper_probation_candidates,
    _candidate_board_portfolio_promotion_subject,
    _candidate_board_status_digest,
)
from scripts.whitepaper_autoresearch_runner.candidate_board_runtime_windows import (
    _candidate_board_runtime_window_bounds,
    _candidate_board_runtime_window_import_plan,
    _candidate_factor_acceptance_replay_metadata,
)
from scripts.whitepaper_autoresearch_runner.candidate_board_summaries import (
    _candidate_board_market_impact_proof_summary,
    _candidate_board_regime_specialist_summary,
    _candidate_board_scorecard_with_evidence_blockers,
    _candidate_board_scorecard_with_lineage_blockers,
    _candidate_board_scorecard_with_order_type_blockers,
    _candidate_board_scorecard_with_predictability_decay_blockers,
    _candidate_board_scorecard_with_queue_position_survival_blockers,
    _candidate_board_scorecard_with_rejected_signal_blockers,
    _candidate_board_scorecard_with_replay_window_blockers,
)
from scripts.whitepaper_autoresearch_runner.candidate_board_status import (
    _candidate_board_best_executed_candidate,
    _candidate_board_blockers,
    _candidate_board_closest_promotion_candidate,
    _candidate_board_status,
)
from scripts.whitepaper_autoresearch_runner.common import (
    _boolish,
    _candidate_board_runtime_ledger_lineage_handoff,
    _candidate_board_runtime_ledger_required_materialized_artifacts,
    _decimal,
    _list_of_mappings,
    _mapping,
    _proposal_sort_value,
    _rank_sort_value,
    _string,
    _string_list_from_value,
)
from scripts.whitepaper_autoresearch_runner.runtime_closure import (
    _portfolio_needs_runtime_closure_proof,
    _runtime_closure_scorecard_update,
)


def _candidate_board_factor_acceptance_summary(
    rows: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    metadata_rows = [
        _mapping(row.get("factor_acceptance_replay_metadata"))
        for row in rows
        if _mapping(row.get("factor_acceptance_replay_metadata"))
    ]
    accepted = [
        row for row in metadata_rows if _string(row.get("status")) == "accepted"
    ]
    return {
        "schema_version": "torghut.factor-acceptance-board-summary.v1",
        "candidate_count": len(metadata_rows),
        "accepted_count": len(accepted),
        "rejected_count": len(metadata_rows) - len(accepted),
        "promotion_allowed": False,
        "final_promotion_authorized": False,
        "scope": "research_paper_probation_only",
        "accepted_candidate_spec_ids": [
            _string(row.get("candidate_spec_id")) for row in accepted
        ],
    }


def _candidate_board_payload(
    *,
    epoch_id: str,
    output_dir: Path,
    target: Decimal,
    candidate_specs: Sequence[CandidateSpec],
    candidate_selection: Mapping[str, Any],
    pre_replay_proposal_rows: Sequence[Mapping[str, Any]],
    proposal_rows: Sequence[Mapping[str, Any]],
    evidence_bundles: Sequence[CandidateEvidenceBundle],
    portfolio: PortfolioCandidateSpec | None,
    promotion_readiness: Mapping[str, Any],
    runtime_closure: Mapping[str, Any],
    paper_probation_target_limit: int = 1,
) -> dict[str, Any]:
    pre_replay_by_spec = _candidate_board_score_rows(pre_replay_proposal_rows)
    proposal_by_spec = _candidate_board_score_rows(proposal_rows)
    selection_by_spec = _candidate_board_score_rows(
        _list_of_mappings(candidate_selection.get("rows"))
    )
    evidence_by_spec = {bundle.candidate_spec_id: bundle for bundle in evidence_bundles}
    portfolio_payload = portfolio.to_payload() if portfolio is not None else {}
    portfolio_scorecard = _mapping(portfolio_payload.get("objective_scorecard"))
    portfolio_oracle_passed = _boolish(portfolio_scorecard.get("oracle_passed"))
    portfolio_sleeve_spec_ids = {
        _string(sleeve.get("candidate_spec_id"))
        for sleeve in _list_of_mappings(portfolio_payload.get("sleeves"))
        if _string(sleeve.get("candidate_spec_id"))
    }
    factor_acceptance_candidate_count = max(
        _candidate_board_int_field(
            _mapping(candidate_selection.get("budget")),
            "compiled_candidate_count",
        ),
        len(candidate_specs),
        len(evidence_bundles),
        1,
    )
    rows: list[dict[str, Any]] = []
    for spec in candidate_specs:
        selection = selection_by_spec.get(spec.candidate_spec_id, {})
        pre_replay = pre_replay_by_spec.get(spec.candidate_spec_id, {})
        proposal = proposal_by_spec.get(spec.candidate_spec_id, pre_replay)
        evidence = evidence_by_spec.get(spec.candidate_spec_id)
        raw_scorecard = (
            dict(evidence.objective_scorecard) if evidence is not None else {}
        )
        mechanism_overlay_ids = _string_list_from_value(
            spec.parameter_space.get("mechanism_overlay_ids")
        )
        if mechanism_overlay_ids:
            raw_scorecard.setdefault("mechanism_overlay_ids", mechanism_overlay_ids)
        if evidence is not None:
            raw_scorecard.setdefault(
                "replay_artifact_refs", list(evidence.replay_artifact_refs)
            )
        scorecard = _candidate_board_scorecard_with_evidence_blockers(
            raw_scorecard, evidence
        )
        scorecard, evidence_lineage = _candidate_board_scorecard_with_lineage_blockers(
            scorecard, evidence
        )
        scorecard, replay_window_coverage = (
            _candidate_board_scorecard_with_replay_window_blockers(scorecard)
        )
        market_impact_proof = _candidate_board_market_impact_proof_summary(scorecard)
        regime_specialist_validation = _candidate_board_regime_specialist_summary(
            spec, scorecard
        )
        scorecard, rejected_signal_summary = (
            _candidate_board_scorecard_with_rejected_signal_blockers(spec, scorecard)
        )
        scorecard, order_type_summary = (
            _candidate_board_scorecard_with_order_type_blockers(
                spec,
                scorecard,
                replay_artifact_refs=evidence.replay_artifact_refs
                if evidence is not None
                else (),
            )
        )
        scorecard, queue_position_survival_summary = (
            _candidate_board_scorecard_with_queue_position_survival_blockers(
                spec, scorecard
            )
        )
        scorecard, predictability_decay_summary = (
            _candidate_board_scorecard_with_predictability_decay_blockers(
                spec, scorecard, target=target
            )
        )
        selected_for_replay = bool(selection.get("selected_for_replay"))
        replay_selection_reason = _string(selection.get("selection_reason")) or (
            "not_selected_budget"
        )
        paper_contract_prior_score = _string(
            selection.get("paper_contract_prior_score")
        )
        paper_mechanism_overlay_ids = _string_list_from_value(
            selection.get("paper_mechanism_overlay_ids")
        )
        if not paper_mechanism_overlay_ids:
            paper_mechanism_overlay_ids = mechanism_overlay_ids
        paper_required_evidence_tokens = _string_list_from_value(
            selection.get("paper_required_evidence_tokens")
        )
        paper_required_evidence_count = _candidate_board_int_field(
            selection, "paper_required_evidence_count"
        )
        if paper_required_evidence_tokens and paper_required_evidence_count == 0:
            paper_required_evidence_count = len(paper_required_evidence_tokens)
        paper_contract_candidate = bool(
            _decimal(paper_contract_prior_score) > 0
            or paper_required_evidence_tokens
            or paper_mechanism_overlay_ids
        )
        in_best_portfolio = spec.candidate_spec_id in portfolio_sleeve_spec_ids
        blockers = _candidate_board_blockers(
            selected_for_replay=selected_for_replay,
            evidence=evidence,
            scorecard=scorecard,
        )
        runtime_window_start, runtime_window_end = (
            _candidate_board_runtime_window_bounds(scorecard)
        )
        exact_replay_ledger_artifact_ref = _string(
            scorecard.get("exact_replay_ledger_artifact_ref")
        )
        runtime_ledger_lineage_handoff = (
            _candidate_board_runtime_ledger_lineage_handoff(
                scorecard=scorecard,
                evidence=evidence,
            )
        )
        runtime_ledger_required_materialized_artifacts = (
            _candidate_board_runtime_ledger_required_materialized_artifacts(
                runtime_ledger_lineage_handoff
            )
        )
        runtime_ledger_materialization_status = _string(
            runtime_ledger_lineage_handoff.get("materialization_status")
            or runtime_ledger_lineage_handoff.get("status")
        )
        factor_acceptance_replay_metadata = (
            _candidate_factor_acceptance_replay_metadata(
                spec=spec,
                evidence=evidence,
                candidate_count=factor_acceptance_candidate_count,
            )
        )
        rows.append(
            {
                "epoch_id": epoch_id,
                "candidate_spec_id": spec.candidate_spec_id,
                "candidate_id": evidence.candidate_id if evidence is not None else "",
                "hypothesis_id": spec.hypothesis_id,
                "family_template_id": spec.family_template_id,
                "runtime_family": spec.runtime_family,
                "runtime_strategy_name": spec.runtime_strategy_name,
                "mechanism_overlay_ids": mechanism_overlay_ids,
                "pre_replay_rank": _rank_sort_value(pre_replay.get("rank")),
                "pre_replay_proposal_score": str(
                    pre_replay.get("proposal_score") or ""
                ),
                "rank": _rank_sort_value(proposal.get("rank")),
                "proposal_score": str(proposal.get("proposal_score") or ""),
                "selected_for_replay": selected_for_replay,
                "replay_selection_reason": replay_selection_reason,
                "paper_contract_candidate": paper_contract_candidate,
                "paper_contract_selected_for_replay": bool(
                    selected_for_replay and paper_contract_candidate
                ),
                "paper_contract_prior_score": paper_contract_prior_score,
                "paper_mechanism_overlay_ids": paper_mechanism_overlay_ids,
                "paper_required_evidence_tokens": paper_required_evidence_tokens,
                "paper_required_evidence_count": paper_required_evidence_count,
                "has_replay_evidence": evidence is not None,
                "in_best_portfolio": in_best_portfolio,
                "dataset_snapshot_id": evidence.dataset_snapshot_id
                if evidence is not None
                else "",
                "status": _candidate_board_status(
                    selected_for_replay=selected_for_replay,
                    evidence=evidence,
                    scorecard=scorecard,
                    in_best_portfolio=in_best_portfolio,
                    portfolio_oracle_passed=portfolio_oracle_passed,
                ),
                "target_met": _boolish(scorecard.get("target_met")),
                "oracle_passed": _boolish(scorecard.get("oracle_passed")),
                "net_pnl_per_day": _candidate_board_decimal_field(
                    scorecard, "net_pnl_per_day"
                )
                or _candidate_board_decimal_field(
                    scorecard, "portfolio_post_cost_net_pnl_per_day"
                ),
                "market_impact_stress_passed": _boolish(
                    scorecard.get("market_impact_stress_passed")
                ),
                "market_impact_stress_net_pnl_per_day": _candidate_board_decimal_field(
                    scorecard, "market_impact_stress_net_pnl_per_day"
                ),
                "delay_adjusted_depth_stress_passed": _boolish(
                    scorecard.get("delay_adjusted_depth_stress_passed")
                ),
                "delay_adjusted_depth_stress_net_pnl_per_day": _candidate_board_decimal_field(
                    scorecard, "delay_adjusted_depth_stress_net_pnl_per_day"
                ),
                "delay_adjusted_depth_fill_survival_evidence_present": _boolish(
                    scorecard.get("delay_adjusted_depth_fill_survival_evidence_present")
                    or scorecard.get("fill_survival_evidence_present")
                ),
                "delay_adjusted_depth_fill_survival_sample_count": _candidate_board_first_int_field(
                    scorecard,
                    (
                        "delay_adjusted_depth_fill_survival_sample_count",
                        "fill_survival_sample_count",
                    ),
                ),
                "delay_adjusted_depth_fill_survival_rate": _candidate_board_decimal_field(
                    scorecard, "delay_adjusted_depth_fill_survival_rate"
                )
                or _candidate_board_decimal_field(scorecard, "fill_survival_fill_rate")
                or _candidate_board_decimal_field(scorecard, "fill_survival_rate"),
                "queue_position_survival_fill_curve_evidence_present": _boolish(
                    scorecard.get("queue_position_survival_fill_curve_evidence_present")
                ),
                "queue_position_survival_sample_count": _candidate_board_int_field(
                    scorecard, "queue_position_survival_sample_count"
                ),
                "queue_position_survival_fill_rate": _candidate_board_decimal_field(
                    scorecard, "queue_position_survival_fill_rate"
                ),
                "queue_position_survival_queue_ratio_p95": _candidate_board_decimal_field(
                    scorecard, "queue_position_survival_queue_ratio_p95"
                ),
                "queue_position_survival_queue_ahead_depletion_evidence_present": _boolish(
                    scorecard.get(
                        "queue_position_survival_queue_ahead_depletion_evidence_present"
                    )
                ),
                "queue_position_survival_queue_ahead_depletion_sample_count": (
                    _candidate_board_int_field(
                        scorecard,
                        "queue_position_survival_queue_ahead_depletion_sample_count",
                    )
                ),
                "queue_position_survival_nonfill_opportunity_cost_bps": (
                    _candidate_board_decimal_field(
                        scorecard,
                        "queue_position_survival_nonfill_opportunity_cost_bps",
                    )
                    or _candidate_board_decimal_field(
                        scorecard, "queue_position_nonfill_opportunity_cost_bps"
                    )
                ),
                "fill_time_ms_p50": _candidate_board_decimal_field(
                    scorecard, "fill_time_ms_p50"
                ),
                "fill_time_ms_p95": _candidate_board_decimal_field(
                    scorecard, "fill_time_ms_p95"
                ),
                "delay_adjusted_depth_queue_ahead_depletion_evidence_present": _boolish(
                    scorecard.get(
                        "delay_adjusted_depth_queue_ahead_depletion_evidence_present"
                    )
                ),
                "delay_adjusted_depth_queue_ahead_depletion_sample_count": (
                    _candidate_board_int_field(
                        scorecard,
                        "delay_adjusted_depth_queue_ahead_depletion_sample_count",
                    )
                ),
                "queue_ahead_depletion_evidence_present": _boolish(
                    scorecard.get("queue_ahead_depletion_evidence_present")
                ),
                "queue_ahead_depletion_sample_count": _candidate_board_int_field(
                    scorecard, "queue_ahead_depletion_sample_count"
                ),
                "post_cost_net_pnl_after_queue_position_survival_fill_stress": (
                    _candidate_board_decimal_field(
                        scorecard,
                        "post_cost_net_pnl_after_queue_position_survival_fill_stress",
                    )
                ),
                "implementation_uncertainty_stability_passed": _boolish(
                    scorecard.get("implementation_uncertainty_stability_passed")
                ),
                "implementation_uncertainty_lower_net_pnl_per_day": _candidate_board_decimal_field(
                    scorecard, "implementation_uncertainty_lower_net_pnl_per_day"
                ),
                "conformal_tail_risk_required": _boolish(
                    scorecard.get("conformal_tail_risk_required")
                ),
                "conformal_tail_risk_passed": _boolish(
                    scorecard.get("conformal_tail_risk_passed")
                ),
                "conformal_tail_risk_adjusted_net_pnl_per_day": _candidate_board_decimal_field(
                    scorecard, "conformal_tail_risk_adjusted_net_pnl_per_day"
                ),
                "conformal_tail_risk_buffer_per_day": _candidate_board_decimal_field(
                    scorecard, "conformal_tail_risk_buffer_per_day"
                ),
                "breakeven_transaction_cost_buffer_passed": _boolish(
                    scorecard.get("breakeven_transaction_cost_buffer_passed")
                ),
                "breakeven_transaction_cost_buffer_bps": _candidate_board_decimal_field(
                    scorecard, "breakeven_transaction_cost_buffer_bps"
                ),
                "transaction_cost_buffer_bps": _candidate_board_decimal_field(
                    scorecard, "transaction_cost_buffer_bps"
                ),
                "post_cost_net_pnl_after_breakeven_transaction_cost_buffer": (
                    _candidate_board_decimal_field(
                        scorecard,
                        "post_cost_net_pnl_after_breakeven_transaction_cost_buffer",
                    )
                ),
                "required_seed_model_family_robustness": _boolish(
                    scorecard.get("required_seed_model_family_robustness")
                ),
                "seed_model_family_robustness_status": str(
                    scorecard.get("seed_model_family_robustness_status") or ""
                ),
                "seed_robustness_passed": _boolish(
                    scorecard.get("seed_robustness_passed")
                ),
                "seed_robustness_sample_count": _candidate_board_int_field(
                    scorecard, "seed_robustness_sample_count"
                ),
                "model_family_robustness_passed": _boolish(
                    scorecard.get("model_family_robustness_passed")
                ),
                "model_family_robustness_family_count": _candidate_board_int_field(
                    scorecard, "model_family_robustness_family_count"
                ),
                "trading_day_count": _candidate_board_int_field(
                    scorecard, "trading_day_count"
                ),
                "decision_count": _candidate_board_first_int_field(
                    scorecard,
                    (
                        "decision_count",
                        "trade_decision_count",
                        "paper_decision_count",
                        "runtime_decision_count",
                    ),
                ),
                "submitted_order_count": _candidate_board_first_int_field(
                    scorecard,
                    (
                        "submitted_order_count",
                        "order_count",
                        "orders_submitted_count",
                        "paper_order_count",
                        "runtime_order_count",
                    ),
                ),
                "filled_order_count": _candidate_board_first_int_field(
                    scorecard,
                    (
                        "filled_count",
                        "filled_order_count",
                        "executions_filled_count",
                        "execution_filled_count",
                        "paper_filled_order_count",
                        "trade_count",
                        "runtime_trade_count",
                    ),
                ),
                "executable_replay_order_count": _candidate_board_first_int_field(
                    scorecard,
                    (
                        "executable_replay_order_count",
                        "executable_replay_submitted_order_count",
                        "executable_replay_orders_submitted_total",
                    ),
                ),
                "double_oos_passed": _boolish(scorecard.get("double_oos_passed")),
                "double_oos_artifact_ref": _string(
                    scorecard.get("double_oos_artifact_ref")
                    or scorecard.get("double_oos_report_ref")
                    or scorecard.get("walk_forward_oos_artifact_ref")
                ),
                "double_oos_independent_window_count": _candidate_board_first_int_field(
                    scorecard,
                    (
                        "double_oos_independent_window_count",
                        "double_oos_fold_count",
                        "oos_fold_count",
                    ),
                ),
                "double_oos_pass_rate": _candidate_board_decimal_field(
                    scorecard, "double_oos_pass_rate"
                ),
                "double_oos_net_pnl_per_day": _candidate_board_decimal_field(
                    scorecard, "double_oos_net_pnl_per_day"
                ),
                "double_oos_cost_shock_net_pnl_per_day": _candidate_board_decimal_field(
                    scorecard, "double_oos_cost_shock_net_pnl_per_day"
                ),
                "active_day_ratio": _candidate_board_decimal_field(
                    scorecard, "active_day_ratio"
                ),
                "positive_day_ratio": _candidate_board_decimal_field(
                    scorecard, "positive_day_ratio"
                ),
                "best_day_share": _candidate_board_decimal_field(
                    scorecard, "best_day_share"
                ),
                "worst_day_loss": _candidate_board_decimal_field(
                    scorecard, "worst_day_loss"
                ),
                "avg_filled_notional_per_day": _candidate_board_decimal_field(
                    scorecard, "avg_filled_notional_per_day"
                ),
                "market_impact_proof": market_impact_proof,
                "regime_specialist_validation": regime_specialist_validation,
                "rejected_signal_outcome_learning": rejected_signal_summary,
                "order_type_execution_quality": order_type_summary,
                "queue_position_survival_fill_quality": (
                    queue_position_survival_summary
                ),
                "predictability_decay_stress": predictability_decay_summary,
                "factor_acceptance_replay_metadata": (
                    factor_acceptance_replay_metadata
                ),
                "factor_acceptance_status": _string(
                    factor_acceptance_replay_metadata.get("status")
                ),
                "factor_acceptance_promotion_allowed": False,
                "evidence_lineage": evidence_lineage,
                "replay_window_coverage": replay_window_coverage,
                "blockers": blockers,
                "runtime_window_start": runtime_window_start,
                "runtime_window_end": runtime_window_end,
                "account_label": _string(scorecard.get("account_label"))
                or ("TORGHUT_REPLAY" if exact_replay_ledger_artifact_ref else ""),
                "exact_replay_ledger_artifact_ref": exact_replay_ledger_artifact_ref,
                "exact_replay_ledger_artifact_row_count": (
                    _candidate_board_first_int_field(
                        scorecard,
                        ("exact_replay_ledger_artifact_row_count",),
                    )
                ),
                "exact_replay_ledger_artifact_fill_count": (
                    _candidate_board_first_int_field(
                        scorecard,
                        ("exact_replay_ledger_artifact_fill_count",),
                    )
                ),
                "runtime_ledger_lineage_materialization_handoff": dict(
                    runtime_ledger_lineage_handoff
                ),
                "runtime_ledger_required_materialized_artifacts": (
                    runtime_ledger_required_materialized_artifacts
                ),
                "runtime_ledger_materialization_status": (
                    runtime_ledger_materialization_status
                ),
                "zero_authoritative_daily_pnl_until_materialized": _boolish(
                    runtime_ledger_lineage_handoff.get(
                        "zero_authoritative_daily_pnl_until_materialized"
                    )
                ),
                "replay_artifact_refs": list(evidence.replay_artifact_refs)
                if evidence is not None
                else [],
            }
        )
    rows.sort(
        key=lambda row: (
            _rank_sort_value(row.get("rank")),
            -_proposal_sort_value(row.get("proposal_score")),
            _string(row.get("candidate_spec_id")),
        )
    )
    best_research_candidate = rows[0] if rows else None
    best_executed_candidate = _candidate_board_best_executed_candidate(rows)
    closest_promotion_candidate = _candidate_board_closest_promotion_candidate(rows)
    paper_probation_candidates = _candidate_board_paper_probation_candidates(
        rows,
        target=target,
        limit=paper_probation_target_limit,
    )
    paper_probation_candidate = (
        paper_probation_candidates[0] if paper_probation_candidates else None
    )
    promotion_ready = _boolish(promotion_readiness.get("promotable"))
    promotion_subject = _candidate_board_portfolio_promotion_subject(
        portfolio=portfolio,
        portfolio_payload=portfolio_payload,
        portfolio_scorecard=portfolio_scorecard,
        promotion_readiness=promotion_readiness,
        runtime_closure=runtime_closure,
        rows=rows,
    )
    promotion_candidate_found = (
        promotion_ready and portfolio_oracle_passed and promotion_subject is not None
    ) or (
        promotion_ready
        and closest_promotion_candidate is not None
        and bool(closest_promotion_candidate.get("oracle_passed"))
    )
    return {
        "schema_version": "torghut.profit-candidate-board.v1",
        "epoch_id": epoch_id,
        "run_root": str(output_dir),
        "target_net_pnl_per_day": str(target),
        "status_digest": _candidate_board_status_digest(rows),
        "current_answer": "promotion_candidate_found"
        if promotion_candidate_found
        else "no_promotion_ready_candidate",
        "promotion_readiness": dict(promotion_readiness),
        "best_research_candidate": best_research_candidate,
        "best_executed_candidate": best_executed_candidate,
        "closest_promotion_candidate": closest_promotion_candidate,
        "paper_probation_candidate": paper_probation_candidate,
        "paper_probation_candidates": list(paper_probation_candidates),
        "paper_probation_target_limit": max(1, int(paper_probation_target_limit)),
        "promotion_subject": promotion_subject,
        "runtime_window_import_plan": _candidate_board_runtime_window_import_plan(
            rows=rows,
            paper_probation_candidate=None,
            paper_probation_candidates=paper_probation_candidates,
            promotion_subject=promotion_subject,
        ),
        "factor_acceptance_summary": _candidate_board_factor_acceptance_summary(rows),
        "double_oos_summary": _candidate_board_double_oos_summary(rows),
        "best_portfolio_candidate_id": _string(
            portfolio_payload.get("portfolio_candidate_id")
        ),
        "best_portfolio_oracle_passed": portfolio_oracle_passed,
        "runtime_closure_status": _string(runtime_closure.get("status")),
        "row_count": len(rows),
        "rows": rows,
    }


def _paper_probation_handoff_payload(
    candidate_board: Mapping[str, Any],
) -> dict[str, Any]:
    candidates = _list_of_mappings(candidate_board.get("paper_probation_candidates"))
    import_plan = _mapping(candidate_board.get("runtime_window_import_plan"))
    import_plan_ready = _string(import_plan.get("status")) == "ready"
    blockers: list[str] = []
    if not candidates:
        blockers.append("paper_probation_candidate_missing")
    if not import_plan_ready:
        blockers.append("runtime_window_import_plan_not_ready")
    status = "ready" if candidates and import_plan_ready else "not_ready"
    return {
        "schema_version": "torghut.paper-probation-handoff.v1",
        "status": status,
        "current_answer": _string(candidate_board.get("current_answer")),
        "evidence_collection_stage": "paper",
        "authorization_scope": "evidence_collection_only",
        "paper_probation_authorized": status == "ready",
        "probation_allowed": status == "ready",
        "promotion_allowed": False,
        "final_promotion_authorized": False,
        "final_promotion_allowed": False,
        "promotion_gate": "existing_runtime_governance_fail_closed",
        "blockers": blockers,
        "candidate_count": len(candidates),
        "candidates": candidates,
        "runtime_window_import_plan": import_plan,
    }


def _portfolio_with_runtime_closure_proof(
    *,
    portfolio: PortfolioCandidateSpec,
    runtime_closure: Mapping[str, Any],
    target: Decimal,
    oracle_policy: ProfitTargetOraclePolicy,
) -> PortfolioCandidateSpec:
    proof_update = _runtime_closure_scorecard_update(
        portfolio=portfolio, runtime_closure=runtime_closure
    )
    proof_payload = _mapping(proof_update.get("runtime_closure_proof"))
    if not proof_payload.get("executable_replay_artifact_refs") and proof_payload.get(
        "shadow_status"
    ) not in {"within_budget", "invalid_artifact"}:
        return portfolio

    scorecard = {**dict(portfolio.objective_scorecard), **proof_update}
    scorecard["profit_target_oracle"] = evaluate_profit_target_oracle(
        scorecard,
        target_net_pnl_per_day=target,
        policy=oracle_policy,
    )
    scorecard["oracle_passed"] = bool(scorecard["profit_target_oracle"]["passed"])
    runtime_refs = tuple(
        ref
        for ref in cast(
            Sequence[Any], scorecard.get("runtime_closure_artifact_refs") or ()
        )
        if _string(ref)
    )
    evidence_refs = tuple(dict.fromkeys((*portfolio.evidence_refs, *runtime_refs)))
    optimizer_report = {
        **dict(portfolio.optimizer_report),
        "runtime_closure_proof_status": proof_payload.get("status"),
        "runtime_closure_artifact_count": len(runtime_refs),
        "oracle_passed_after_runtime_closure": scorecard["oracle_passed"],
    }
    return replace(
        portfolio,
        objective_scorecard=scorecard,
        evidence_refs=evidence_refs,
        optimizer_report=optimizer_report,
    )


def _runtime_closure_program_for_candidate(
    *,
    program: StrategyAutoresearchProgram,
    manifest: MlxSnapshotManifest,
    portfolio: PortfolioCandidateSpec | None,
    oracle_candidate_found: bool,
) -> StrategyAutoresearchProgram:
    runtime_window_available = bool(manifest.source_window_start) and bool(
        manifest.source_window_end
    )
    if portfolio is None:
        return program
    if runtime_window_available and (
        oracle_candidate_found or _portfolio_needs_runtime_closure_proof(portfolio)
    ):
        return program
    return replace(
        program,
        runtime_closure_policy=replace(
            program.runtime_closure_policy,
            execute_parity_replay=False,
            execute_approval_replay=False,
        ),
    )


__all__ = [
    "_candidate_board_factor_acceptance_summary",
    "_candidate_board_payload",
    "_paper_probation_handoff_payload",
    "_portfolio_with_runtime_closure_proof",
    "_runtime_closure_program_for_candidate",
]
