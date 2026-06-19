#!/usr/bin/env python3
"""Run a whitepaper-driven autoresearch epoch targeting a portfolio profit objective."""

from __future__ import annotations

import argparse
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping, Sequence, cast


from app.trading.discovery.autoresearch import (
    StrategyAutoresearchProgram,
)
from app.trading.discovery.candidate_specs import (
    CandidateSpec,
)
from app.trading.discovery.evidence_bundles import (
    CandidateEvidenceBundle,
)
from app.trading.discovery.hypothesis_cards import HypothesisCard
from app.trading.discovery.portfolio_optimizer import (
    PortfolioCandidateSpec,
)
from app.whitepapers.claim_compiler import (
    WhitepaperResearchSource,
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

from scripts.whitepaper_autoresearch_runner.candidate_goal_metadata import (
    _candidate_family_goal_rows,
    _candidate_sleeve_goal_rows,
    _selected_candidate_spec_ids,
)

from scripts.whitepaper_autoresearch_runner.replay_shards import (
    _bounded_real_replay_shard_timeout_seconds,
)

_DEFAULT_PORTFOLIO_PROFIT_PROGRAM = Path(
    "config/trading/research-programs/portfolio-profit-autoresearch-500-v1.yaml"
)

_DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC = 8

_DEFAULT_REAL_REPLAY_SHARD_TIMEOUT_SECONDS = 900

_DEFAULT_REAL_REPLAY_SHARD_WORKERS = 2

_UNSAFE_NEXT_EPOCH_REMEDIATION_FLAG_MARKERS = (
    "agentrun",
    "agent-run",
    "broker",
    "fanout",
    "kubectl",
    "kubernetes",
    "live-trading",
    "promotion",
)


def _profitability_system_change_backlog(
    *,
    oracle_candidate_found: bool,
    status_reason: str | None,
    remediation: Mapping[str, Any] | None,
    promotion_blockers: Sequence[str],
    replay_mode: str,
) -> list[dict[str, Any]]:
    backlog: list[dict[str, Any]] = []
    for action in _list_of_mappings(
        remediation.get("next_actions") if remediation else []
    ):
        backlog.append(
            {
                "priority": int(action.get("priority") or len(backlog) + 1),
                "scope": "autoresearch_pipeline",
                "change": _string(action.get("action"))
                or "inspect_autoresearch_artifacts",
                "reason": _string(action.get("reason")),
                "recommended_flags": dict(_mapping(action.get("recommended_flags"))),
                "candidate_spec_ids": _string_list_from_value(
                    action.get("candidate_spec_ids")
                ),
                "blocking_failure_counts": dict(
                    _mapping(action.get("blocking_failure_counts"))
                ),
            }
        )
    if replay_mode != "real":
        backlog.append(
            {
                "priority": len(backlog) + 1,
                "scope": "replay_evidence",
                "change": "rerun_with_real_replay_before_any_promotion",
                "reason": "synthetic replay is only a pipeline smoke test and cannot establish standalone profitability",
                "recommended_flags": {"--replay-mode": "real"},
            }
        )
    if not oracle_candidate_found and status_reason:
        backlog.append(
            {
                "priority": len(backlog) + 1,
                "scope": "portfolio_oracle",
                "change": "continue_search_until_portfolio_oracle_passes",
                "reason": status_reason,
                "required_result": "portfolio oracle passes the configured daily target without relaxing gates",
            }
        )
    if promotion_blockers:
        backlog.append(
            {
                "priority": len(backlog) + 1,
                "scope": "runtime_closure",
                "change": "produce_runtime_closure_and_shadow_promotion_evidence",
                "reason": "candidate evidence is not enough for standalone trading",
                "promotion_blockers": list(promotion_blockers),
            }
        )
    backlog.append(
        {
            "priority": len(backlog) + 1,
            "scope": "live_submission_controls",
            "change": "keep_live_submission_disabled_until_profit_and_promotion_gates_pass",
            "reason": "standalone money-making requires evidence first, then explicit deployer approval; no gate bypass",
        }
    )
    backlog.sort(key=lambda row: int(row.get("priority") or 10**6))
    return backlog


def _profitability_next_epoch_flags(
    *,
    args: argparse.Namespace,
    target: Decimal,
    remediation: Mapping[str, Any] | None,
) -> dict[str, str]:
    return cast(
        dict[str, str],
        _profitability_next_epoch_plan(
            args=args, target=target, remediation=remediation
        )["flags"],
    )


def _int_arg(args: argparse.Namespace, name: str, default: int) -> int:
    try:
        return int(getattr(args, name, default) or default)
    except (TypeError, ValueError):
        return default


def _flag_int(value: Any) -> int | None:
    text = _string(value)
    if not text:
        return None
    try:
        return int(text)
    except ValueError:
        return None


def _unsafe_next_epoch_remediation_flag(key: str) -> bool:
    normalized = key.strip().lower()
    return any(
        marker in normalized for marker in _UNSAFE_NEXT_EPOCH_REMEDIATION_FLAG_MARKERS
    )


def _decimal_arg_or_default(
    args: argparse.Namespace,
    name: str,
    default: Decimal,
) -> Decimal:
    raw_value = getattr(args, name, None)
    if raw_value is None or _string(raw_value) == "":
        return default
    return _decimal(raw_value, default=str(default))


def _profitability_next_epoch_plan(
    *,
    args: argparse.Namespace,
    target: Decimal,
    remediation: Mapping[str, Any] | None,
) -> dict[str, Any]:
    direct_candidate_specs_artifacts = [
        str(path)
        for path in cast(Sequence[Path], getattr(args, "candidate_specs", ()) or ())
        if str(path)
    ]
    flags: dict[str, str] = {
        "--target-net-pnl-per-day": str(target),
        "--program": str(getattr(args, "program", _DEFAULT_PORTFOLIO_PROFIT_PROGRAM)),
        "--replay-mode": "real",
        "--max-candidates": str(max(64, _int_arg(args, "max_candidates", 64))),
        "--top-k": str(max(16, _int_arg(args, "top_k", 16))),
        "--exploration-slots": str(max(8, _int_arg(args, "exploration_slots", 8))),
        "--feedback-block-reaudit-slots": str(
            max(0, _int_arg(args, "feedback_block_reaudit_slots", 0))
        ),
        "--portfolio-size-min": str(max(2, _int_arg(args, "portfolio_size_min", 2))),
        "--portfolio-size-max": str(max(8, _int_arg(args, "portfolio_size_max", 8))),
        "--max-frontier-candidates-per-spec": str(
            max(
                1,
                _int_arg(
                    args,
                    "max_frontier_candidates_per_spec",
                    _DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC,
                ),
            )
        ),
    }
    max_total_frontier_candidates = _int_arg(args, "max_total_frontier_candidates", 0)
    if max_total_frontier_candidates > 0:
        flags["--max-total-frontier-candidates"] = str(max_total_frontier_candidates)
    real_replay_timeout_seconds = _int_arg(args, "real_replay_timeout_seconds", 0)
    if real_replay_timeout_seconds > 0:
        flags["--real-replay-timeout-seconds"] = str(real_replay_timeout_seconds)
    real_replay_shard_size = _int_arg(args, "real_replay_shard_size", 0)
    if real_replay_shard_size > 0:
        flags["--real-replay-shard-size"] = str(real_replay_shard_size)
    requested_real_replay_shard_timeout_seconds = _int_arg(
        args,
        "real_replay_shard_timeout_seconds",
        _DEFAULT_REAL_REPLAY_SHARD_TIMEOUT_SECONDS,
    )
    real_replay_shard_timeout_seconds = _bounded_real_replay_shard_timeout_seconds(
        requested_real_replay_shard_timeout_seconds
    )
    if real_replay_shard_timeout_seconds > 0:
        flags["--real-replay-shard-timeout-seconds"] = str(
            real_replay_shard_timeout_seconds
        )
    capped_runtime_flags: list[dict[str, str]] = []
    if requested_real_replay_shard_timeout_seconds != real_replay_shard_timeout_seconds:
        capped_runtime_flags.append(
            {
                "flag": "--real-replay-shard-timeout-seconds",
                "requested_value": str(requested_real_replay_shard_timeout_seconds),
                "capped_value": str(real_replay_shard_timeout_seconds),
                "reason": "capped_to_local_shard_timeout_no_cluster_fanout",
            }
        )
    requested_real_replay_shard_workers = _int_arg(
        args, "real_replay_shard_workers", _DEFAULT_REAL_REPLAY_SHARD_WORKERS
    )
    real_replay_shard_workers = max(
        1,
        min(
            requested_real_replay_shard_workers,
            _DEFAULT_REAL_REPLAY_SHARD_WORKERS,
        ),
    )
    if real_replay_shard_workers != requested_real_replay_shard_workers:
        capped_runtime_flags.append(
            {
                "flag": "--real-replay-shard-workers",
                "requested_value": str(requested_real_replay_shard_workers),
                "capped_value": str(real_replay_shard_workers),
                "reason": "capped_to_local_worker_limit_no_kubernetes_fanout",
            }
        )
    if real_replay_shard_workers > 1:
        flags["--real-replay-shard-workers"] = str(real_replay_shard_workers)
    real_replay_failed_spec_retries = _int_arg(
        args, "real_replay_failed_spec_retries", 1
    )
    if real_replay_failed_spec_retries > 0:
        flags["--real-replay-failed-spec-retries"] = str(
            real_replay_failed_spec_retries
        )
    real_replay_retry_timeout_seconds = _int_arg(
        args, "real_replay_retry_timeout_seconds", 0
    )
    if real_replay_retry_timeout_seconds > 0:
        flags["--real-replay-retry-timeout-seconds"] = str(
            real_replay_retry_timeout_seconds
        )
    real_replay_retry_frontier_candidates = _int_arg(
        args, "real_replay_retry_max_frontier_candidates_per_spec", 1
    )
    if real_replay_retry_frontier_candidates > 1:
        flags["--real-replay-retry-max-frontier-candidates-per-spec"] = str(
            real_replay_retry_frontier_candidates
        )
    shadow_validation_artifact = getattr(args, "shadow_validation_artifact", None)
    if shadow_validation_artifact is not None:
        flags["--shadow-validation-artifact"] = str(shadow_validation_artifact)

    applied_recommended_flags: list[dict[str, str]] = []
    rejected_recommended_flags: list[dict[str, str]] = []
    monotonic_int_flags = {
        "--max-candidates",
        "--top-k",
        "--exploration-slots",
        "--feedback-block-reaudit-slots",
        "--portfolio-size-min",
        "--portfolio-size-max",
        "--max-total-frontier-candidates",
        "--real-replay-timeout-seconds",
    }
    if remediation is not None:
        for action in _list_of_mappings(remediation.get("next_actions")):
            action_name = _string(action.get("action"))
            for key, value in _mapping(action.get("recommended_flags")).items():
                if key.startswith("--") and _string(value):
                    if _unsafe_next_epoch_remediation_flag(key):
                        rejected_recommended_flags.append(
                            {
                                "action": action_name,
                                "flag": key,
                                "current_value": str(flags.get(key, "")),
                                "recommended_value": _string(value),
                                "reason": "rejected_unsafe_cluster_fanout_or_promotion_flag",
                            }
                        )
                        continue
                    current_value = flags.get(key)
                    current_int = _flag_int(current_value)
                    recommended_int = _flag_int(value)
                    if key == "--real-replay-shard-workers" and (
                        recommended_int is None
                        or recommended_int > _DEFAULT_REAL_REPLAY_SHARD_WORKERS
                    ):
                        rejected_recommended_flags.append(
                            {
                                "action": action_name,
                                "flag": key,
                                "current_value": str(current_value or ""),
                                "recommended_value": _string(value),
                                "reason": "rejected_broad_replay_worker_fanout",
                            }
                        )
                        continue
                    if key == "--real-replay-shard-timeout-seconds":
                        if recommended_int is None:
                            rejected_recommended_flags.append(
                                {
                                    "action": action_name,
                                    "flag": key,
                                    "current_value": str(current_value or ""),
                                    "recommended_value": _string(value),
                                    "reason": "rejected_invalid_numeric_remediation_flag",
                                }
                            )
                            continue
                        capped_timeout = _bounded_real_replay_shard_timeout_seconds(
                            recommended_int
                        )
                        if capped_timeout != recommended_int:
                            capped_runtime_flags.append(
                                {
                                    "action": action_name,
                                    "flag": key,
                                    "requested_value": str(recommended_int),
                                    "capped_value": str(capped_timeout),
                                    "reason": "capped_to_local_shard_timeout_no_cluster_fanout",
                                }
                            )
                        flags[key] = str(capped_timeout)
                        applied_recommended_flags.append(
                            {
                                "action": action_name,
                                "flag": key,
                                "value": str(capped_timeout),
                            }
                        )
                        continue
                    if key in monotonic_int_flags and recommended_int is None:
                        rejected_recommended_flags.append(
                            {
                                "action": action_name,
                                "flag": key,
                                "current_value": str(current_value or ""),
                                "recommended_value": _string(value),
                                "reason": "rejected_invalid_numeric_remediation_flag",
                            }
                        )
                        continue
                    if (
                        key in monotonic_int_flags
                        and current_int is not None
                        and recommended_int is not None
                        and recommended_int < current_int
                    ):
                        rejected_recommended_flags.append(
                            {
                                "action": action_name,
                                "flag": key,
                                "current_value": str(current_int),
                                "recommended_value": str(recommended_int),
                                "reason": (
                                    "rejected_to_preserve_or_increase_search_breadth"
                                ),
                            }
                        )
                        continue
                    flags[key] = _string(value)
                    applied_recommended_flags.append(
                        {
                            "action": action_name,
                            "flag": key,
                            "value": _string(value),
                        }
                    )
    argv: list[str] = [
        "python",
        "services/torghut/scripts/run_whitepaper_autoresearch_profit_target.py",
        "--output-dir",
        "<next-epoch-output-dir>",
    ]
    for path in direct_candidate_specs_artifacts:
        argv.extend(["--candidate-specs", path])
    for key, value in flags.items():
        argv.extend([key, value])
    return {
        "entrypoint": "services/torghut/scripts/run_whitepaper_autoresearch_profit_target.py",
        "flags": flags,
        "argv": argv,
        "direct_candidate_specs_artifacts": direct_candidate_specs_artifacts,
        "applied_recommended_flags": applied_recommended_flags,
        "rejected_recommended_flags": rejected_recommended_flags,
        "capped_runtime_flags": capped_runtime_flags,
        "no_fast_path_policy": {
            "target_net_pnl_per_day_is_fixed": str(target),
            "replay_mode": "real",
            "no_kubernetes_fanout": True,
            "max_generated_real_replay_shard_workers": (
                _DEFAULT_REAL_REPLAY_SHARD_WORKERS
            ),
            "monotonic_search_flags": sorted(monotonic_int_flags),
            "unsafe_remediation_flag_markers": sorted(
                _UNSAFE_NEXT_EPOCH_REMEDIATION_FLAG_MARKERS
            ),
            "allowed_decreases": [
                (
                    "timeout remediation may reduce "
                    "--max-frontier-candidates-per-spec only to finish complete evidence"
                )
            ],
        },
    }


def _profitability_search_goal(
    *,
    args: argparse.Namespace,
    output_dir: Path,
    status: str,
    status_reason: str | None,
    target: Decimal,
    program: StrategyAutoresearchProgram,
    sources: Sequence[WhitepaperResearchSource],
    hypothesis_cards: Sequence[HypothesisCard],
    candidate_specs: Sequence[CandidateSpec],
    candidate_selection: Mapping[str, Any],
    pre_replay_model: Mapping[str, Any],
    proposal_model: Mapping[str, Any] | None,
    evidence_bundles: Sequence[CandidateEvidenceBundle],
    false_positive_table: Sequence[Mapping[str, Any]],
    best_false_negative_table: Sequence[Mapping[str, Any]],
    portfolio: PortfolioCandidateSpec | None,
    oracle_candidate_found: bool,
    profit_target_oracle: Mapping[str, Any] | None,
    promotion_blockers: Sequence[str],
    remediation: Mapping[str, Any] | None,
) -> dict[str, Any]:
    replay_mode = _string(getattr(args, "replay_mode", "")) or "real"
    next_epoch_plan = _profitability_next_epoch_plan(
        args=args, target=target, remediation=remediation
    )
    return {
        "schema_version": "torghut.whitepaper-autoresearch-profitability-goal.v1",
        "objective": {
            "target_net_pnl_per_trading_day": str(target),
            "currency": "USD",
            "standalone_system": True,
            "status": status,
            "status_reason": status_reason,
            "oracle_candidate_found": oracle_candidate_found,
            "definition_of_done": [
                "portfolio oracle passes the target without lowering constraints",
                "real replay evidence is complete for selected sleeves",
                "runtime closure writes parity and approval replay evidence",
                "shadow/promotion evidence is persisted before live submission",
                "live submission gate remains blocked until evidence and explicit deployer controls allow it",
            ],
        },
        "candidate_framework": {
            "program_id": program.program_id,
            "program_path": str(
                getattr(args, "program", _DEFAULT_PORTFOLIO_PROFIT_PROGRAM)
            ),
            "replay_mode": replay_mode,
            "source_count": len(sources),
            "claim_count": sum(len(source.claims) for source in sources),
            "hypothesis_count": len(hypothesis_cards),
            "candidate_spec_count": len(candidate_specs),
            "selected_for_replay_count": len(
                _selected_candidate_spec_ids(candidate_selection)
            ),
            "evidence_bundle_count": len(evidence_bundles),
            "portfolio_candidate_count": 1 if portfolio is not None else 0,
            "pre_replay_model": {
                "schema_version": pre_replay_model.get("schema_version"),
                "model_id": pre_replay_model.get("model_id"),
                "backend": pre_replay_model.get("backend"),
                "proposal_stage": pre_replay_model.get("proposal_stage"),
            },
            "post_replay_model": {
                "schema_version": proposal_model.get("schema_version")
                if proposal_model
                else None,
                "model_id": proposal_model.get("model_id") if proposal_model else None,
                "backend": proposal_model.get("backend") if proposal_model else None,
            },
            "families": _candidate_family_goal_rows(
                candidate_specs=candidate_specs,
                candidate_selection=candidate_selection,
                evidence_bundles=evidence_bundles,
            ),
        },
        "sleeve_plan": {
            "source": "portfolio_candidate"
            if portfolio is not None
            else "candidate_selection",
            "rows": _candidate_sleeve_goal_rows(
                candidate_specs=candidate_specs,
                candidate_selection=candidate_selection,
                evidence_bundles=evidence_bundles,
                false_positive_table=false_positive_table,
                best_false_negative_table=best_false_negative_table,
                portfolio=portfolio,
            ),
        },
        "system_change_backlog": _profitability_system_change_backlog(
            oracle_candidate_found=oracle_candidate_found,
            status_reason=status_reason,
            remediation=remediation,
            promotion_blockers=promotion_blockers,
            replay_mode=replay_mode,
        ),
        "no_cheating_contract": {
            "forbidden": [
                "lowering target_net_pnl_per_day to make a candidate pass",
                "relaxing oracle, replay, drawdown, contribution, or promotion gates without a separate reviewed code change",
                "treating synthetic replay as production proof",
                "editing live strategy configuration inside an autoresearch epoch",
                "enabling live submission before promotion evidence and deployer approval exist",
            ],
            "program_forbidden_mutations": list(program.forbidden_mutations),
            "promotion_policy": program.promotion_policy,
        },
        "recommended_next_epoch": next_epoch_plan,
        "profit_target_oracle": dict(profit_target_oracle or {}),
        "candidate_search_remediation": dict(remediation or {}),
        "artifacts": {
            "candidate_selection_manifest": str(
                output_dir / "candidate-selection-manifest.json"
            ),
            "candidate_specs": str(output_dir / "candidate-specs.jsonl"),
            "candidate_evidence_bundles": str(
                output_dir / "candidate-evidence-bundles.jsonl"
            ),
            "portfolio_candidates": str(output_dir / "portfolio-candidates.jsonl"),
            "candidate_search_remediation": str(
                output_dir / "candidate-search-remediation.json"
            )
            if remediation is not None
            else None,
            "summary": str(output_dir / "summary.json"),
        },
    }


__all__ = [
    "_profitability_system_change_backlog",
    "_profitability_next_epoch_flags",
    "_int_arg",
    "_flag_int",
    "_unsafe_next_epoch_remediation_flag",
    "_decimal_arg_or_default",
    "_profitability_next_epoch_plan",
    "_profitability_search_goal",
]
