#!/usr/bin/env python3
"""Run a whitepaper-driven autoresearch epoch targeting a portfolio profit objective."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
from collections.abc import Callable
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping, Sequence, TypeVar, cast


from app.trading.discovery.autoresearch import (
    run_id,
)
from app.trading.discovery.candidate_specs import (
    CandidateSpec,
)
from app.trading.discovery.fast_replay import (
    build_fast_replay_preview,
)
from app.trading.discovery.whitepaper_candidate_compiler import (
    compile_whitepaper_candidate_specs,
)
from app.whitepapers.claim_compiler import (
    RECENT_WHITEPAPER_SEEDS,
    compile_sources_to_hypothesis_cards,
)

from scripts.whitepaper_autoresearch_runner import (
    preview_narrowing as _preview_narrowing,
)
from scripts.whitepaper_autoresearch_runner import replay_execution as _replay_execution

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

from scripts.whitepaper_autoresearch_runner.cli_parsing import (
    _DEFAULT_DAILY_PROFIT_TARGET,
    _ranker_backend_preference,
    _parse_args,
)

from scripts.whitepaper_autoresearch_runner.artifact_io import (
    _write_failure_summary,
    _resolved_clickhouse_password,
    _clickhouse_endpoint_preflight_failure,
    _candidate_universe_symbols_for_compilation,
)


from scripts.whitepaper_autoresearch_runner.persisted_feedback_sources import (
    _program_whitepaper_sources,
    _persist_vnext_specs,
)

from scripts.whitepaper_autoresearch_runner.oracle_policy import (
    _oracle_policy_from_args,
)


from scripts.whitepaper_autoresearch_runner.preview_narrowing import (
    _apply_fast_replay_preview_narrowing as _preview_narrowing_apply_fast_replay_preview_narrowing,
)

from scripts.whitepaper_autoresearch_runner.queue_metadata import (
    _maybe_preflight_materialized_replay_tape_window,
)

from scripts.whitepaper_autoresearch_runner.replay_models import (
    EpochReplayResult,
)

from scripts.whitepaper_autoresearch_runner.run_arguments import (
    _args_with_objective_constraints,
)

from scripts.whitepaper_autoresearch_runner.run_candidate_preparation import (
    CandidatePreparationRequest,
    _prepare_candidates_for_replay,
)

from scripts.whitepaper_autoresearch_runner.replay_selection import (
    _select_candidate_specs_for_replay,
)

from scripts.whitepaper_autoresearch_runner.replay_execution import (
    _run_synthetic_replay as _replay_execution_run_synthetic_replay,
    _run_real_replay as _replay_execution_run_real_replay,
    _real_replay_result_from_factory_payload as _replay_execution_real_replay_result_from_factory_payload,
)

from scripts.whitepaper_autoresearch_runner.run_reporting import (
    ReplayFailureSummaryRequest,
    SuccessfulRunFinalizationRequest,
    _finalize_successful_run,
    _write_replay_failure_summary,
)
from scripts.whitepaper_autoresearch_runner.run_success_evaluation import (
    SuccessfulReplayEvaluationRequest,
    _evaluate_successful_replay,
)


from scripts.whitepaper_autoresearch_runner.replay_shards import (
    _run_replay_with_optional_timeout,
    _load_epoch_program,
)

_MAX_PERSISTED_FEEDBACK_EVIDENCE_BUNDLES = 512
_MAX_PERSISTED_FEEDBACK_EVIDENCE_EPOCHS = 12
_PORTFOLIO_FEEDBACK_STATUSES = frozenset({"blocked", "paper_probation", "target_met"})

_REJECTED_SIGNAL_OUTCOME_REQUIRED_FIELDS = (
    "counterfactual_return",
    "route_tca",
    "post_cost_net_pnl",
    "executable_quote",
)

_CODE_COMMIT_ENV_VARS = (
    "TORGHUT_CODE_COMMIT",
    "TORGHUT_COMMIT",
    "TORGHUT_SOURCE_CI_REF",
    "TORGHUT_IMAGE_COMMIT",
    "GITHUB_SHA",
    "BUILDKITE_COMMIT",
    "SOURCE_COMMIT",
    "GIT_COMMIT",
    "REVISION",
)

_PROGRAM_SOURCE_DEFAULT_CONFIDENCE = "0.70"

_FAMILY_PRIOR_HARD_BLOCK_ORACLE_BLOCKERS = frozenset(
    {
        "active_day_ratio_below_oracle",
        "positive_day_ratio_below_oracle",
        "best_day_share_above_oracle",
    }
)

_RISK_PROFILE_FEEDBACK_ORACLE_BLOCKERS = frozenset(
    {
        "active_day_ratio_below_oracle",
        "positive_day_ratio_below_oracle",
        "best_day_share_above_oracle",
        "active_day_ratio_failed",
        "positive_day_ratio_failed",
        "min_daily_net_pnl_failed",
        "daily_net_observed_day_count_failed",
        "best_day_share_failed",
        "max_single_day_contribution_share_failed",
        "max_single_symbol_contribution_share_failed",
        "max_cluster_contribution_share_failed",
    }
)

_PAPER_MECHANISM_PRIOR_SCORE_CAP = Decimal("42")

_PAPER_MECHANISM_PRIOR_WEIGHTS: Mapping[str, Decimal] = {
    "mixed_market_limit_execution_policy": Decimal("9"),
    "queue_position_survival_fill_curve": Decimal("9"),
    "mpc_dynamic_execution_schedule": Decimal("8"),
    "delay_adjusted_depth_stress": Decimal("8"),
    "simulation_reality_gap_implementation_risk": Decimal("8"),
    "implementation_risk_backtest_stability": Decimal("8"),
    "replay_paper_live_semantic_parity": Decimal("7"),
    "rejected_signal_outcome_calibration": Decimal("7"),
    "nonlinear_market_impact_tca": Decimal("6"),
    "ofi_lob_continuation_response": Decimal("6"),
    "order_flow_filtration_parent_trade_obi": Decimal("6"),
    "alpha_decay_predictability_stress": Decimal("5"),
    "cluster_lob_event_clustering": Decimal("5"),
    "intraday_volume_periodicity_execution": Decimal("5"),
    "macro_announcement_dvar_momentum": Decimal("4"),
    "ohlcv_only_falsification": Decimal("3"),
}

_PAPER_EVIDENCE_REQUIREMENT_PRIOR_WEIGHTS: Mapping[str, Decimal] = {
    "route_tca": Decimal("2"),
    "execution_shortfall": Decimal("2"),
    "market_impact_stress": Decimal("2"),
    "live_paper_parity": Decimal("2"),
    "runtime_ledger": Decimal("2"),
    "fill_outcomes": Decimal("2"),
    "order_lifecycle_fill_evidence": Decimal("2"),
    "queue_position_survival_fill_curve": Decimal("2"),
    "delay_adjusted_depth_stress": Decimal("2"),
    "implementation_uncertainty_interval": Decimal("2"),
    "implementation_uncertainty_stability": Decimal("2"),
    "rejected_signal_log": Decimal("2"),
    "counterfactual_return": Decimal("2"),
    "executable_quote": Decimal("1"),
}

_LOSS_ADAPTIVE_FEEDBACK_REMEDIATION_PROFILES = frozenset(
    {"adverse_selection_feedback_escape"}
)

_REPLAY_ACTIVITY_COUNT_KEYS = (
    "decision_count",
    "trade_decision_count",
    "paper_decision_count",
    "runtime_decision_count",
    "orders_submitted_count",
    "submitted_order_count",
    "filled_count",
    "fill_count",
    "filled_order_count",
)


_EXACT_REPLAY_LEDGER_ARTIFACT_KIND = "exact_replay_ledger"

_EXACT_REPLAY_LEDGER_SCHEMA_VERSIONS = frozenset(
    {
        "torghut.exact_replay_ledger.rows.v1",
        "torghut.exact_replay_ledger.v1",
    }
)

_EXACT_REPLAY_RUNTIME_LEDGER_PNL_SOURCE = "exact_replay_runtime_ledger"

_T = TypeVar("_T")


def _current_code_commit() -> str:
    for name in _CODE_COMMIT_ENV_VARS:
        value = _string(os.getenv(name))
        if value:
            return value

    script_path = Path(__file__).resolve()
    fallback_repo_root = (
        script_path.parents[3]
        if len(script_path.parents) > 3
        else script_path.parents[-1]
    )
    repo_root = next(
        (parent for parent in script_path.parents if (parent / ".git").exists()),
        fallback_repo_root,
    )
    try:
        rev = subprocess.run(
            ("git", "-C", str(repo_root), "rev-parse", "HEAD"),
            check=False,
            capture_output=True,
            text=True,
            timeout=3,
        )
    except (OSError, subprocess.TimeoutExpired):
        return "unknown"
    commit = _string(rev.stdout)
    if rev.returncode != 0 or not commit:
        return "unknown"

    dirty = False
    for args in (
        ("git", "-C", str(repo_root), "diff", "--quiet"),
        ("git", "-C", str(repo_root), "diff", "--cached", "--quiet"),
    ):
        try:
            result = subprocess.run(
                args,
                check=False,
                capture_output=True,
                text=True,
                timeout=3,
            )
        except (OSError, subprocess.TimeoutExpired):
            dirty = True
            break
        if result.returncode != 0:
            dirty = True
            break
    return f"{commit}-dirty" if dirty else commit


def _call_replay_execution_with_root_code_commit(
    function: Callable[..., _T],
    *args: Any,
    **kwargs: Any,
) -> _T:
    original = _replay_execution._current_code_commit
    _replay_execution._current_code_commit = _current_code_commit
    try:
        return function(*args, **kwargs)
    finally:
        _replay_execution._current_code_commit = original


def _run_synthetic_replay(
    *,
    specs: Sequence[CandidateSpec],
    output_dir: Path,
    max_candidates: int,
) -> EpochReplayResult:
    return _call_replay_execution_with_root_code_commit(
        _replay_execution_run_synthetic_replay,
        specs=specs,
        output_dir=output_dir,
        max_candidates=max_candidates,
    )


def _run_real_replay(
    args: argparse.Namespace,
    *,
    output_dir: Path,
    specs: Sequence[CandidateSpec] = (),
) -> EpochReplayResult:
    return _call_replay_execution_with_root_code_commit(
        _replay_execution_run_real_replay,
        args,
        output_dir=output_dir,
        specs=specs,
    )


def _real_replay_result_from_factory_payload(
    factory_payload: Mapping[str, Any],
    *,
    specs_by_id: Mapping[str, CandidateSpec] | None = None,
) -> EpochReplayResult:
    return _call_replay_execution_with_root_code_commit(
        _replay_execution_real_replay_result_from_factory_payload,
        factory_payload,
        specs_by_id=specs_by_id,
    )


def _apply_fast_replay_preview_narrowing(
    *,
    args: argparse.Namespace,
    output_dir: Path,
    specs: Sequence[CandidateSpec],
    candidate_selection: Mapping[str, Any],
) -> tuple[list[CandidateSpec], dict[str, Any]]:
    original = _preview_narrowing.build_fast_replay_preview
    _preview_narrowing.build_fast_replay_preview = build_fast_replay_preview
    try:
        return _preview_narrowing_apply_fast_replay_preview_narrowing(
            args=args,
            output_dir=output_dir,
            specs=specs,
            candidate_selection=candidate_selection,
        )
    finally:
        _preview_narrowing.build_fast_replay_preview = original


def run_whitepaper_autoresearch_profit_target(
    args: argparse.Namespace,
) -> dict[str, Any]:
    args = argparse.Namespace(
        **{
            **vars(args),
            "clickhouse_password": _resolved_clickhouse_password(args),
        }
    )
    epoch_id = str(getattr(args, "epoch_id", "") or "").strip() or run_id(
        "whitepaper-autoresearch"
    )
    started_at = datetime.now(UTC)
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    program = _load_epoch_program(args)
    objective = program.objective
    candidate_specs_paths = tuple(
        path.resolve()
        for path in cast(Sequence[Path], getattr(args, "candidate_specs", ()) or ())
    )
    direct_candidate_specs_replay = bool(candidate_specs_paths)
    if direct_candidate_specs_replay:
        candidate_universe_symbols: tuple[str, ...] = ()
    else:
        try:
            candidate_universe_symbols = _candidate_universe_symbols_for_compilation(
                args
            )
        except ValueError as exc:
            return _write_failure_summary(
                output_dir=output_dir,
                epoch_id=epoch_id,
                status="invalid_universe",
                reason=str(exc),
                started_at=started_at,
                extra={"symbols": str(getattr(args, "symbols", "") or "")},
            )
    args = _args_with_objective_constraints(
        args=args,
        objective=objective,
        program=program,
    )
    target = _decimal(args.target_net_pnl_per_day, default=_DEFAULT_DAILY_PROFIT_TARGET)
    replay_source_window_preflight: dict[str, Any] | None = None
    try:
        args, replay_source_window_preflight = (
            _maybe_preflight_materialized_replay_tape_window(
                args=args,
                output_dir=output_dir,
            )
        )
    except Exception as exc:
        return _write_failure_summary(
            output_dir=output_dir,
            epoch_id=epoch_id,
            status="replay_tape_source_window_preflight_failed",
            reason=str(exc),
            started_at=started_at,
            extra={
                "symbols": str(getattr(args, "symbols", "") or ""),
                "full_window_start_date": str(
                    getattr(args, "full_window_start_date", "") or ""
                ),
                "full_window_end_date": str(
                    getattr(args, "full_window_end_date", "") or ""
                ),
            },
        )
    oracle_policy = _oracle_policy_from_args(args)
    selection_only = bool(getattr(args, "selection_only", False))
    ranker_backend_preference = _ranker_backend_preference(args)
    candidate_preparation = _prepare_candidates_for_replay(
        CandidatePreparationRequest(
            args=args,
            output_dir=output_dir,
            epoch_id=epoch_id,
            started_at=started_at,
            program=program,
            direct_candidate_specs_replay=direct_candidate_specs_replay,
            candidate_specs_paths=candidate_specs_paths,
            candidate_universe_symbols=candidate_universe_symbols,
            target=target,
            oracle_policy=oracle_policy,
            selection_only=selection_only,
            ranker_backend_preference=ranker_backend_preference,
            replay_source_window_preflight=replay_source_window_preflight,
            recent_whitepaper_seeds=RECENT_WHITEPAPER_SEEDS,
            program_whitepaper_sources=_program_whitepaper_sources,
            compile_sources_to_hypothesis_cards=compile_sources_to_hypothesis_cards,
            compile_whitepaper_candidate_specs=compile_whitepaper_candidate_specs,
            persist_vnext_specs=_persist_vnext_specs,
            select_candidate_specs_for_replay=_select_candidate_specs_for_replay,
        )
    )
    if isinstance(candidate_preparation, dict):
        return candidate_preparation
    args = candidate_preparation.args
    sources = candidate_preparation.sources
    hypothesis_cards = candidate_preparation.hypothesis_cards
    candidate_specs = candidate_preparation.candidate_specs
    candidate_compilation_blockers = (
        candidate_preparation.candidate_compilation_blockers
    )
    blocker_by_spec = candidate_preparation.blocker_by_spec
    pre_replay_model = candidate_preparation.pre_replay_model
    pre_replay_proposal_rows = candidate_preparation.pre_replay_proposal_rows
    replay_candidate_specs = candidate_preparation.replay_candidate_specs
    candidate_selection = candidate_preparation.candidate_selection
    materialized_replay_tape_receipt = (
        candidate_preparation.materialized_replay_tape_receipt
    )
    selection_by_spec = {
        str(row.get("candidate_spec_id")): row
        for row in _list_of_mappings(candidate_selection.get("rows"))
    }
    replay_args = argparse.Namespace(
        **{
            **vars(args),
            "max_candidates": len(replay_candidate_specs),
            "top_k": min(int(args.top_k), len(replay_candidate_specs)),
        }
    )
    try:
        clickhouse_preflight_failure = _clickhouse_endpoint_preflight_failure(
            replay_args
        )
        if clickhouse_preflight_failure:
            raise RuntimeError(clickhouse_preflight_failure)
        replay_result = _run_replay_with_optional_timeout(
            args=replay_args,
            output_dir=output_dir,
            specs=replay_candidate_specs,
        )
    except Exception as exc:
        return _write_replay_failure_summary(
            ReplayFailureSummaryRequest(
                args=args,
                output_dir=output_dir,
                epoch_id=epoch_id,
                started_at=started_at,
                failure_reason=f"{type(exc).__name__}:{exc}",
                replay_candidate_specs=replay_candidate_specs,
                candidate_selection=candidate_selection,
                pre_replay_proposal_rows=pre_replay_proposal_rows,
                oracle_policy=oracle_policy,
                target=target,
                program=program,
                sources=sources,
                hypothesis_cards=hypothesis_cards,
                candidate_specs=candidate_specs,
                pre_replay_model=pre_replay_model,
            )
        )
    successful_replay = _evaluate_successful_replay(
        SuccessfulReplayEvaluationRequest(
            args=args,
            output_dir=output_dir,
            epoch_id=epoch_id,
            program=program,
            sources=sources,
            hypothesis_cards=hypothesis_cards,
            candidate_specs=candidate_specs,
            pre_replay_proposal_rows=pre_replay_proposal_rows,
            candidate_selection=candidate_selection,
            replay_candidate_specs=replay_candidate_specs,
            replay_result=replay_result,
            target=target,
            oracle_policy=oracle_policy,
            ranker_backend_preference=ranker_backend_preference,
            selection_by_spec=selection_by_spec,
        )
    )
    return _finalize_successful_run(
        SuccessfulRunFinalizationRequest(
            args=args,
            output_dir=output_dir,
            epoch_id=epoch_id,
            started_at=started_at,
            target=target,
            oracle_policy=oracle_policy,
            program=program,
            sources=sources,
            hypothesis_cards=hypothesis_cards,
            candidate_specs=candidate_specs,
            candidate_compilation_blockers=candidate_compilation_blockers,
            candidate_selection=candidate_selection,
            pre_replay_model=pre_replay_model,
            pre_replay_proposal_rows=pre_replay_proposal_rows,
            proposal_model=successful_replay.proposal_model,
            proposal_rows=successful_replay.proposal_rows,
            replay_result=replay_result,
            replay_candidate_specs=replay_candidate_specs,
            replay_failure_reasons=successful_replay.replay_failure_reasons,
            materialized_replay_tape_receipt=materialized_replay_tape_receipt,
            portfolio=successful_replay.portfolio,
            portfolio_rows=successful_replay.portfolio_rows,
            promotion_readiness=successful_replay.promotion_readiness,
            runtime_closure=successful_replay.runtime_closure,
            oracle_candidate_found=successful_replay.oracle_candidate_found,
            profit_target_oracle=successful_replay.profit_target_oracle,
            status=successful_replay.status,
            status_reason=successful_replay.status_reason,
            promotion_blockers=successful_replay.promotion_blockers,
            blocker_by_spec=blocker_by_spec,
        )
    )


def main() -> int:
    args = _parse_args()
    payload = run_whitepaper_autoresearch_profit_target(args)
    print(json.dumps(payload, indent=2, sort_keys=True))
    status = str(payload.get("status") or "")
    if status in {"ok", "selection_only"}:
        return 0
    if status == "persistence_failed":
        return 1
    if status == "replay_failed":
        return 3
    return 2


if __name__ == "__main__":
    raise SystemExit(main())

__all__ = ("main", "run_whitepaper_autoresearch_profit_target")
