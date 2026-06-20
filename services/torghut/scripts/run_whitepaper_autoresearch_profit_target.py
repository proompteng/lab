#!/usr/bin/env python3
"""Run a whitepaper-driven autoresearch epoch targeting a portfolio profit objective."""

from __future__ import annotations

import argparse
import hashlib
import json
import multiprocessing
import os
import queue
import signal
import socket
import subprocess
import time as monotonic_time
from collections.abc import Callable
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping, Sequence, TypeVar, cast
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

from sqlalchemy import select

from app.db import SessionLocal
from app.models import (
    AutoresearchCandidateSpec,
    AutoresearchEpoch,
    AutoresearchPortfolioCandidate,
    AutoresearchProposalScore,
    RejectedSignalOutcomeEvent,
    WhitepaperAnalysisRun,
    VNextExperimentSpec,
)
from app.trading.discovery.autoresearch import (
    ResearchClaim,
    ResearchSource,
    StrategyAutoresearchProgram,
    load_strategy_autoresearch_program,
    run_id,
)
from app.trading.discovery.candidate_specs import (
    LIVE_SIGNAL_COVERED_SEMICONDUCTOR_UNIVERSE,
    CandidateSpec,
)
from app.trading.discovery.candidate_specs import candidate_spec_id_for_payload
from app.trading.discovery.candidate_specs import candidate_spec_from_payload
from app.trading.discovery.evidence_bundles import (
    CandidateEvidenceBundle,
    evidence_bundle_blockers,
    evidence_bundle_from_frontier_candidate,
    evidence_bundle_from_payload,
)
from app.trading.discovery.factor_acceptance import (
    build_factor_acceptance_artifact_from_scorecard,
)
from app.trading.discovery.fast_replay import (
    FAST_REPLAY_PROOF_SEMANTICS_LABEL,
    FAST_REPLAY_WHITEPAPER_MECHANISMS,
    build_fast_replay_preview,
)
from app.trading.discovery.hypothesis_cards import HypothesisCard
from app.trading.discovery.mlx_snapshot import build_mlx_snapshot_manifest
from app.trading.discovery.mlx_snapshot import MlxSnapshotManifest
from app.trading.discovery.mlx_snapshot import write_mlx_snapshot_manifest
from app.trading.discovery.mlx_training_data import build_mlx_training_rows
from app.trading.discovery.mlx_training_data import (
    capital_budget_penalty,
    candidate_spec_capital_features,
    rank_training_rows,
    rank_training_rows_with_lift_policy,
    train_mlx_ranker,
)
from app.trading.discovery.objectives import (
    deployable_lower_bound_missing_count,
    deployable_lower_bound_net_pnl_per_day,
    deployable_proof_failed_gate_count,
)
from app.trading.discovery.portfolio_optimizer import (
    PortfolioCandidateSpec,
    optimize_portfolio_candidate,
)
from app.trading.discovery.profit_target_oracle import (
    ProfitTargetOraclePolicy,
    evaluate_profit_target_oracle,
)
from app.trading.runtime_ledger import (
    POST_COST_PNL_BASIS,
    RuntimeLedgerBucket,
    build_runtime_ledger_buckets,
)
from app.trading.discovery.replay_tape import (
    ReplayTapeManifest,
    build_source_query_digest,
    load_replay_tape,
    materialize_signal_tape,
    slice_tape_by_symbols,
    slice_tape_by_window,
    validate_tape_freshness,
)
from app.trading.discovery.runtime_closure import (
    RuntimeClosureExecutionContext,
    write_runtime_closure_bundle,
)
from app.trading.discovery.whitepaper_autoresearch_notebooks import (
    write_whitepaper_autoresearch_diagnostics_notebook,
)
from app.trading.discovery.whitepaper_candidate_compiler import (
    CandidateCompilationBlocker,
    compile_whitepaper_candidate_specs,
)
from app.whitepapers.claim_compiler import (
    RECENT_WHITEPAPER_SEEDS,
    WhitepaperResearchSource,
    compile_sources_to_hypothesis_cards,
    sources_from_jsonl,
)

import scripts.local_intraday_tsmom_replay as replay_mod
import scripts.materialize_replay_tape as replay_materializer
import scripts.run_strategy_factory_v2 as strategy_factory_runner
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
    _default_strategy_config_path,
    _default_clickhouse_http_url,
    _ranker_backend_preference,
    _parse_args,
)

from scripts.whitepaper_autoresearch_runner.artifact_io import (
    _write_json,
    _write_jsonl,
    _write_failure_summary,
    _resolved_clickhouse_password,
    _clickhouse_host_requires_dns_preflight,
    _clickhouse_endpoint_preflight_failure,
    _candidate_universe_symbols_from_args,
    _candidate_universe_symbols_for_compilation,
)

from scripts.whitepaper_autoresearch_runner.feedback_loading import (
    _load_feedback_evidence_bundles,
    _dedupe_feedback_evidence_bundles,
    _evidence_bundle_payloads_for_epoch_summary,
    _candidate_spec_from_payload,
    _load_candidate_specs_jsonl,
    _summary_scorecard_feedback_bundles_for_epoch,
    _outcome_payload_has_complete_rejected_signal_fields,
)

from scripts.whitepaper_autoresearch_runner.rejected_signal_feedback import (
    _rejected_signal_outcome_payload_to_feedback_bundle,
    _ordered_unique_strings,
    _portfolio_candidate_feedback_blockers,
    _portfolio_sleeve_feedback_metadata,
    _portfolio_candidate_row_to_feedback_bundles,
)

from scripts.whitepaper_autoresearch_runner.persisted_feedback_sources import (
    _load_recent_persisted_feedback_evidence_bundles,
    _load_autoresearch_feedback_evidence_bundles,
    _program_claim_type,
    _program_research_source_to_whitepaper_source,
    _program_whitepaper_sources,
    _dedupe_whitepaper_sources,
    _load_sources_from_db,
    _persist_vnext_specs,
    _persist_epoch_ledgers,
)

from scripts.whitepaper_autoresearch_runner.oracle_policy import (
    _scorecard_start_equity,
    _scorecard_total_net_pnl,
    _scorecard_profit_factor,
    _risk_adjusted_drawdown_passes,
    _oracle_policy_from_args,
    _candidate_spec_with_oracle_policy,
    _candidate_specs_with_oracle_policy,
)

from scripts.whitepaper_autoresearch_runner.proposal_training import (
    _proposal_model_and_rows,
    _candidate_quality_gate_failures,
    _false_positive_table,
    _replay_diagnostic_proposal_rows,
    _best_false_negative_table,
    _recent_trading_days_shortfall,
    _stale_tape_diagnostics,
)

from scripts.whitepaper_autoresearch_runner.candidate_remediation import (
    _candidate_search_remediation,
)

from scripts.whitepaper_autoresearch_runner.candidate_goal_metadata import (
    _selected_candidate_spec_ids,
    _candidate_family_goal_rows,
    _candidate_sleeve_goal_proof_handoff_fields,
    _candidate_sleeve_goal_rows,
)

from scripts.whitepaper_autoresearch_runner.next_epoch_planning import (
    _profitability_system_change_backlog,
    _profitability_next_epoch_flags,
    _int_arg,
    _flag_int,
    _unsafe_next_epoch_remediation_flag,
    _decimal_arg_or_default,
    _profitability_next_epoch_plan,
    _profitability_search_goal,
)

from scripts.whitepaper_autoresearch_runner.feedback_blocking_rules import (
    _feedback_scorecard_has_hard_veto,
    _feedback_daily_net_has_loss,
    _feedback_has_no_replay_activity,
    _feedback_family_prior_has_hard_block,
    _feedback_risk_profile_has_penalty,
    _feedback_risk_profile_has_terminal_block,
    _feedback_has_policy_penalty,
    _feedback_is_blocked,
    _feedback_has_nonpositive_expected_value,
    _feedback_bundle_sort_value,
    _feedback_family_template_id,
    _feedback_execution_signature,
    _feedback_shape_key,
    _feedback_risk_profile_key_from_scorecard,
    _feedback_risk_profile_key,
)

from scripts.whitepaper_autoresearch_runner.candidate_prior_scoring import (
    _pre_replay_candidate_score,
    _candidate_spec_mechanism_overlay_ids,
    _candidate_spec_required_evidence_tokens,
    _paper_mechanism_prior_score,
    _candidate_spec_universe_key,
    _candidate_spec_signal_key,
    _candidate_spec_is_false_negative_rescue,
    _candidate_spec_is_loss_adaptive_feedback_escape,
    _candidate_spec_active_loss_counter_tags,
    _feedback_active_loss_counter_candidate_reasons,
    _candidate_spec_matches_active_loss_counter_feedback,
    _feedback_consistency_repair_candidate_reasons,
    _candidate_spec_matches_consistency_repair_feedback,
    _active_loss_counter_proposal_score,
    _consistency_repair_proposal_score,
    _scorecard_is_false_negative_rescue_feedback,
    _candidate_spec_execution_profile,
    _candidate_spec_feedback_risk_profile_key,
    _candidate_spec_feedback_shape_key,
    _candidate_spec_feedback_metadata,
    _candidate_payload_with_feedback_metadata,
)
from scripts.whitepaper_autoresearch_runner.feedback_risk_profiles import (
    _feedback_risk_profile_key_payload,
)

from scripts.whitepaper_autoresearch_runner.feedback_bundle_builders import (
    _pre_replay_prior_bundle,
    _execution_signature_feedback_bundle_for_spec,
    _shape_feedback_bundle_for_spec,
    _risk_profile_feedback_bundle_for_spec,
    _family_feedback_bundle_for_spec,
)

from scripts.whitepaper_autoresearch_runner.proposal_building import (
    _PRE_REPLAY_FEEDBACK_BLOCK_REASONS,
    _PRE_REPLAY_SELECTION_BLOCK_REASONS,
    _pre_replay_proposal_model_and_rows,
    _proposal_score_confidence,
    _selection_reason_blocks_replay,
)
from scripts.whitepaper_autoresearch_runner.candidate_identity import (
    _candidate_spec_execution_signature,
)

from scripts.whitepaper_autoresearch_runner.preview_narrowing import (
    _candidate_selection_for_direct_replay,
    _apply_fast_replay_preview_narrowing as _preview_narrowing_apply_fast_replay_preview_narrowing,
    _resolved_fast_replay_preview_top_k,
    _resolved_fast_replay_exact_candidate_cap,
)

from scripts.whitepaper_autoresearch_runner.queue_metadata import (
    _fast_replay_preview_proof_semantics,
    _fast_replay_discovery_stage_semantics,
    _fast_replay_queue_stage_metadata,
    _bounded_sim_target_queue_metadata,
    _fast_replay_exact_handoff_lineage,
    _maybe_materialize_epoch_replay_tape,
    _auto_materialize_staged_replay_tape,
    _maybe_preflight_materialized_replay_tape_window,
    _materialized_replay_tape_date_arg,
    _materialized_replay_tape_source_query_digest,
    _materialized_replay_tape_feature_schema_hash,
    _materialized_replay_tape_cost_model_hash,
    _materialized_replay_tape_strategy_family,
    _fast_replay_preview_date_arg,
)

from scripts.whitepaper_autoresearch_runner.replay_models import (
    EpochReplayResult,
    _ReplayShardPlan,
    _ReplayShardOutcome,
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
    _synthetic_net_for_spec,
    _synthetic_symbol_contribution_shares,
    _synthetic_candidate_payload,
    _run_synthetic_replay as _replay_execution_run_synthetic_replay,
    _run_real_replay as _replay_execution_run_real_replay,
    _real_replay_result_from_factory_payload as _replay_execution_real_replay_result_from_factory_payload,
    _dedupe_replay_evidence,
    _candidate_spec_id_from_experiment_result_path,
    _collect_partial_real_replay,
    _run_real_replay_once_with_optional_timeout,
    _real_replay_worker,
    _terminate_process,
    _run_real_replay_once_in_child_process,
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
    _build_real_replay_shards,
    _execute_real_replay_shard,
    _failed_shard_spec_ids,
    _evidenced_spec_ids,
    _retry_real_replay_failed_shard_specs,
    _replay_shard_frontier_candidate_budget,
    _bounded_real_replay_shard_workers,
    _bounded_real_replay_shard_timeout_seconds,
    _run_real_replay_shards,
    _load_epoch_program,
    _resolved_staged_train_screen_multiplier,
    _resolved_program_family_int_arg,
    _resolved_real_replay_frontier_controls,
    _epoch_mlx_snapshot_manifest,
)

_DEFAULT_CHIP_UNIVERSE_CSV = ",".join(LIVE_SIGNAL_COVERED_SEMICONDUCTOR_UNIVERSE)
_DEFAULT_DAILY_PROFIT_TARGET = "500"
_DEFAULT_RANKER_BACKEND_PREFERENCE = "mlx"
_RANKER_BACKEND_CHOICES = (
    "mlx",
    "numpy",
    "numpy-fallback",
    "torch",
    "torch-cuda",
    "cuda",
)
_DEFAULT_PORTFOLIO_PROFIT_PROGRAM = Path(
    "config/trading/research-programs/portfolio-profit-autoresearch-500-v1.yaml"
)
_DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC = 8
_DEFAULT_REAL_REPLAY_SHARD_TIMEOUT_SECONDS = 900
_DEFAULT_REAL_REPLAY_SHARD_WORKERS = 2
_DEFAULT_REAL_REPLAY_MAX_PARALLEL_FRONTIER_CANDIDATES = 6
_DEFAULT_FAST_REPLAY_PREVIEW_TOP_K = 48
_DEFAULT_FAST_REPLAY_EXACT_CANDIDATE_CAP = 6
_DEFAULT_FAST_REPLAY_EXPLOITATION_SLOTS = 4
_DEFAULT_FAST_REPLAY_EXPLORATION_SLOTS = 2

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
_DEFAULT_CLICKHOUSE_HTTP_URL = (
    "http://torghut-clickhouse.torghut.svc.cluster.local:8123"
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

# fmt: off
__all__ = ('Any', 'AutoresearchCandidateSpec', 'AutoresearchEpoch', 'AutoresearchPortfolioCandidate', 'AutoresearchProposalScore', 'CandidateCompilationBlocker', 'CandidateEvidenceBundle', 'CandidateSpec', 'Decimal', 'EpochReplayResult', 'FAST_REPLAY_PROOF_SEMANTICS_LABEL', 'FAST_REPLAY_WHITEPAPER_MECHANISMS', 'HypothesisCard', 'LIVE_SIGNAL_COVERED_SEMICONDUCTOR_UNIVERSE', 'Mapping', 'MlxSnapshotManifest', 'POST_COST_PNL_BASIS', 'Path', 'PortfolioCandidateSpec', 'ProcessPoolExecutor', 'ProfitTargetOraclePolicy', 'RECENT_WHITEPAPER_SEEDS', 'RejectedSignalOutcomeEvent', 'ReplayTapeManifest', 'ResearchClaim', 'ResearchSource', 'RuntimeClosureExecutionContext', 'RuntimeLedgerBucket', 'Sequence', 'SessionLocal', 'StrategyAutoresearchProgram', 'UTC', 'VNextExperimentSpec', 'WhitepaperAnalysisRun', 'WhitepaperResearchSource', 'ZoneInfo', '_CANDIDATE_BOARD_RUNTIME_SESSION_CLOSE', '_CANDIDATE_BOARD_RUNTIME_SESSION_OPEN', '_CANDIDATE_BOARD_RUNTIME_SESSION_TZ', '_CODE_COMMIT_ENV_VARS', '_DEFAULT_CHIP_UNIVERSE_CSV', '_DEFAULT_CLICKHOUSE_HTTP_URL', '_DEFAULT_DAILY_PROFIT_TARGET', '_DEFAULT_FAST_REPLAY_EXACT_CANDIDATE_CAP', '_DEFAULT_FAST_REPLAY_EXPLOITATION_SLOTS', '_DEFAULT_FAST_REPLAY_EXPLORATION_SLOTS', '_DEFAULT_FAST_REPLAY_PREVIEW_TOP_K', '_DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC', '_DEFAULT_PORTFOLIO_PROFIT_PROGRAM', '_DEFAULT_RANKER_BACKEND_PREFERENCE', '_DEFAULT_REAL_REPLAY_MAX_PARALLEL_FRONTIER_CANDIDATES', '_DEFAULT_REAL_REPLAY_SHARD_TIMEOUT_SECONDS', '_DEFAULT_REAL_REPLAY_SHARD_WORKERS', '_EXACT_REPLAY_LEDGER_ARTIFACT_KIND', '_EXACT_REPLAY_LEDGER_SCHEMA_VERSIONS', '_EXACT_REPLAY_RUNTIME_LEDGER_PNL_SOURCE', '_FAMILY_PRIOR_HARD_BLOCK_ORACLE_BLOCKERS', '_LOSS_ADAPTIVE_FEEDBACK_REMEDIATION_PROFILES', '_MAX_PERSISTED_FEEDBACK_EVIDENCE_BUNDLES', '_MAX_PERSISTED_FEEDBACK_EVIDENCE_EPOCHS', '_PAPER_EVIDENCE_REQUIREMENT_PRIOR_WEIGHTS', '_PAPER_MECHANISM_PRIOR_SCORE_CAP', '_PAPER_MECHANISM_PRIOR_WEIGHTS', '_PAPER_PROBATION_LIVE_PAPER_EVIDENCE_REQUIREMENTS', '_PAPER_PROBATION_SAFE_EVIDENCE_COLLECTION_PATH', '_PORTFOLIO_FEEDBACK_STATUSES', '_PRE_REPLAY_FEEDBACK_BLOCK_REASONS', '_PRE_REPLAY_SELECTION_BLOCK_REASONS', '_PROGRAM_SOURCE_DEFAULT_CONFIDENCE', '_RANKER_BACKEND_CHOICES', '_REJECTED_SIGNAL_OUTCOME_REQUIRED_FIELDS', '_REPLAY_ACTIVITY_COUNT_KEYS', '_RISK_PROFILE_FEEDBACK_ORACLE_BLOCKERS', '_RUNTIME_CLOSURE_PROOF_ORACLE_BLOCKERS', '_ReplayShardOutcome', '_ReplayShardPlan', '_SECOND_OOS_WINDOW_ID', '_UNSAFE_NEXT_EPOCH_REMEDIATION_FLAG_MARKERS', '_active_loss_counter_proposal_score', '_apply_fast_replay_preview_narrowing', '_auto_materialize_staged_replay_tape', '_best_false_negative_table', '_boolish', '_bounded_real_replay_shard_timeout_seconds', '_bounded_real_replay_shard_workers', '_bounded_sim_target_queue_metadata', '_build_real_replay_shards', '_candidate_board_activity_count', '_candidate_board_best_executed_candidate', '_candidate_board_blockers', '_candidate_board_closest_promotion_candidate', '_candidate_board_date_only', '_candidate_board_decimal_field', '_candidate_board_double_oos_summary', '_candidate_board_evidence_lineage_summary', '_candidate_board_exact_replay_ledger_refs', '_candidate_board_factor_acceptance_summary', '_candidate_board_first_int_field', '_candidate_board_hypothesis_manifest_ref', '_candidate_board_int_field', '_candidate_board_lower_bound_net_pnl', '_candidate_board_market_impact_proof_summary', '_candidate_board_net_pnl', '_candidate_board_oracle_blocker_count', '_candidate_board_order_type_execution_quality_summary', '_candidate_board_paper_probation_admission_blockers', '_candidate_board_paper_probation_candidate', '_candidate_board_paper_probation_candidates', '_candidate_board_payload', '_candidate_board_portfolio_promotion_subject', '_candidate_board_predictability_decay_summary', '_candidate_board_queue_position_survival_summary', '_candidate_board_regime_specialist_summary', '_candidate_board_regular_session_bound', '_candidate_board_rejected_signal_outcome_summary', '_candidate_board_replay_window_coverage_summary', '_candidate_board_required_notional_repair_scale', '_candidate_board_runtime_import_args', '_candidate_board_runtime_ledger_lineage_handoff', '_candidate_board_runtime_ledger_required_materialized_artifacts', '_candidate_board_runtime_window_bounds', '_candidate_board_runtime_window_import_bounds', '_candidate_board_runtime_window_import_plan', '_candidate_board_score_rows', '_candidate_board_scorecard_with_evidence_blockers', '_candidate_board_scorecard_with_lineage_blockers', '_candidate_board_scorecard_with_order_type_blockers', '_candidate_board_scorecard_with_predictability_decay_blockers', '_candidate_board_scorecard_with_queue_position_survival_blockers', '_candidate_board_scorecard_with_rejected_signal_blockers', '_candidate_board_scorecard_with_replay_window_blockers', '_candidate_board_status', '_candidate_board_status_digest', '_candidate_board_target_progress_ratio', '_candidate_factor_acceptance_replay_metadata', '_candidate_family_goal_rows', '_candidate_payload_with_feedback_metadata', '_candidate_quality_gate_failures', '_candidate_search_remediation', '_candidate_selection_for_direct_replay', '_candidate_sleeve_goal_proof_handoff_fields', '_candidate_sleeve_goal_rows', '_candidate_spec_active_loss_counter_tags', '_candidate_spec_execution_profile', '_candidate_spec_execution_signature', '_candidate_spec_feedback_metadata', '_candidate_spec_feedback_risk_profile_key', '_candidate_spec_feedback_shape_key', '_candidate_spec_from_payload', '_candidate_spec_id_from_experiment_result_path', '_candidate_spec_is_false_negative_rescue', '_candidate_spec_is_loss_adaptive_feedback_escape', '_candidate_spec_matches_active_loss_counter_feedback', '_candidate_spec_matches_consistency_repair_feedback', '_candidate_spec_mechanism_overlay_ids', '_candidate_spec_required_evidence_tokens', '_candidate_spec_requires_order_type_execution_quality', '_candidate_spec_requires_predictability_decay_stress', '_candidate_spec_requires_queue_position_survival', '_candidate_spec_requires_rejected_signal_outcome_learning', '_candidate_spec_signal_key', '_candidate_spec_universe_key', '_candidate_spec_with_oracle_policy', '_candidate_specs_with_oracle_policy', '_candidate_universe_symbols_for_compilation', '_candidate_universe_symbols_from_args', '_clickhouse_endpoint_preflight_failure', '_clickhouse_host_requires_dns_preflight', '_collect_partial_real_replay', '_consistency_repair_proposal_score', '_current_code_commit', '_decimal', '_decimal_arg_or_default', '_decimal_payload', '_dedupe_feedback_evidence_bundles', '_dedupe_replay_evidence', '_dedupe_whitepaper_sources', '_default_clickhouse_http_url', '_default_strategy_config_path', '_epoch_mlx_snapshot_manifest', '_evidence_bundle_payloads_for_epoch_summary', '_evidenced_spec_ids', '_execute_real_replay_shard', '_execution_signature_feedback_bundle_for_spec', '_failed_shard_spec_ids', '_false_positive_table', '_family_feedback_bundle_for_spec', '_fast_replay_discovery_stage_semantics', '_fast_replay_exact_handoff_lineage', '_fast_replay_preview_date_arg', '_fast_replay_preview_proof_semantics', '_fast_replay_queue_stage_metadata', '_feedback_active_loss_counter_candidate_reasons', '_feedback_bundle_sort_value', '_feedback_consistency_repair_candidate_reasons', '_feedback_daily_net_has_loss', '_feedback_execution_signature', '_feedback_family_prior_has_hard_block', '_feedback_family_template_id', '_feedback_has_no_replay_activity', '_feedback_has_nonpositive_expected_value', '_feedback_has_policy_penalty', '_feedback_is_blocked', '_feedback_risk_profile_has_penalty', '_feedback_risk_profile_has_terminal_block', '_feedback_risk_profile_key', '_feedback_risk_profile_key_from_scorecard', '_feedback_risk_profile_key_payload', '_feedback_scorecard_has_hard_veto', '_feedback_shape_key', '_flag_int', '_int_arg', '_list_of_mappings', '_load_autoresearch_feedback_evidence_bundles', '_load_candidate_specs_jsonl', '_load_epoch_program', '_load_feedback_evidence_bundles', '_load_json_mapping_artifact', '_load_recent_persisted_feedback_evidence_bundles', '_load_sources_from_db', '_mapping', '_market_impact_default_source_markers', '_materialized_replay_tape_cost_model_hash', '_materialized_replay_tape_date_arg', '_materialized_replay_tape_feature_schema_hash', '_materialized_replay_tape_source_query_digest', '_materialized_replay_tape_strategy_family', '_maybe_materialize_epoch_replay_tape', '_maybe_preflight_materialized_replay_tape_window', '_oracle_blockers', '_oracle_policy_from_args', '_ordered_unique_strings', '_outcome_payload_has_complete_rejected_signal_fields', '_paper_mechanism_prior_score', '_paper_probation_candidate_payload', '_paper_probation_handoff_payload', '_parse_args', '_persist_epoch_ledgers', '_persist_vnext_specs', '_portfolio_candidate_feedback_blockers', '_portfolio_candidate_row_to_feedback_bundles', '_portfolio_executable_max_notional', '_portfolio_needs_runtime_closure_proof', '_portfolio_sleeve_feedback_metadata', '_portfolio_with_runtime_closure_proof', '_pre_replay_candidate_score', '_pre_replay_prior_bundle', '_pre_replay_proposal_model_and_rows', '_profitability_next_epoch_flags', '_profitability_next_epoch_plan', '_profitability_search_goal', '_profitability_system_change_backlog', '_program_claim_type', '_program_research_source_to_whitepaper_source', '_program_whitepaper_sources', '_promotion_readiness_payload', '_proposal_model_and_rows', '_proposal_score_confidence', '_proposal_sort_value', '_rank_sort_value', '_ranker_backend_preference', '_real_replay_result_from_factory_payload', '_real_replay_worker', '_recent_trading_days_shortfall', '_rejected_signal_outcome_payload_to_feedback_bundle', '_replay_diagnostic_proposal_rows', '_replay_shard_frontier_candidate_budget', '_resolve_existing_path', '_resolved_clickhouse_password', '_resolved_fast_replay_exact_candidate_cap', '_resolved_fast_replay_preview_top_k', '_resolved_program_family_int_arg', '_resolved_real_replay_frontier_controls', '_resolved_staged_train_screen_multiplier', '_retry_real_replay_failed_shard_specs', '_risk_adjusted_drawdown_passes', '_risk_profile_feedback_bundle_for_spec', '_run_real_replay', '_run_real_replay_once_in_child_process', '_run_real_replay_once_with_optional_timeout', '_run_real_replay_shards', '_run_replay_with_optional_timeout', '_run_synthetic_replay', '_runtime_closure_artifact_refs', '_runtime_closure_delay_adjusted_depth_stress_update', '_runtime_closure_double_oos_update', '_runtime_closure_exact_replay_bucket', '_runtime_closure_exact_replay_bucket_range', '_runtime_closure_exact_replay_ledger_update', '_runtime_closure_ledger_datetime', '_runtime_closure_market_impact_stress_update', '_runtime_closure_payload', '_runtime_closure_pending_promotion_steps', '_runtime_closure_program_for_candidate', '_runtime_closure_promotion_prerequisite_blockers', '_runtime_closure_replay_bucket_has_authority', '_runtime_closure_scorecard_update', '_runtime_closure_start_equity', '_runtime_report_int', '_runtime_report_source_markers', '_runtime_report_summary_int', '_scorecard_is_false_negative_rescue_feedback', '_scorecard_profit_factor', '_scorecard_start_equity', '_scorecard_total_net_pnl', '_select_candidate_specs_for_replay', '_selected_candidate_spec_ids', '_selection_reason_blocks_replay', '_sequence_of_mappings', '_shape_feedback_bundle_for_spec', '_stable_hash', '_stale_tape_diagnostics', '_string', '_string_list_from_value', '_summary_scorecard_feedback_bundles_for_epoch', '_synthetic_candidate_payload', '_synthetic_net_for_spec', '_synthetic_symbol_contribution_shares', '_terminate_process', '_unsafe_next_epoch_remediation_flag', '_write_failure_summary', '_write_json', '_write_jsonl', 'argparse', 'as_completed', 'build_factor_acceptance_artifact_from_scorecard', 'build_fast_replay_preview', 'build_mlx_snapshot_manifest', 'build_mlx_training_rows', 'build_runtime_ledger_buckets', 'build_source_query_digest', 'candidate_spec_capital_features', 'candidate_spec_from_payload', 'candidate_spec_id_for_payload', 'capital_budget_penalty', 'cast', 'compile_sources_to_hypothesis_cards', 'compile_whitepaper_candidate_specs', 'dataclass', 'date', 'datetime', 'deployable_lower_bound_missing_count', 'deployable_lower_bound_net_pnl_per_day', 'deployable_proof_failed_gate_count', 'evaluate_profit_target_oracle', 'evidence_bundle_blockers', 'evidence_bundle_from_frontier_candidate', 'evidence_bundle_from_payload', 'hashlib', 'json', 'load_replay_tape', 'load_strategy_autoresearch_program', 'main', 'materialize_signal_tape', 'monotonic_time', 'multiprocessing', 'optimize_portfolio_candidate', 'os', 'queue', 'rank_training_rows', 'rank_training_rows_with_lift_policy', 'replace', 'replay_materializer', 'replay_mod', 'run_id', 'run_whitepaper_autoresearch_profit_target', 'select', 'signal', 'slice_tape_by_symbols', 'slice_tape_by_window', 'socket', 'sources_from_jsonl', 'strategy_factory_runner', 'subprocess', 'time', 'timedelta', 'train_mlx_ranker', 'urlparse', 'validate_tape_freshness', 'write_mlx_snapshot_manifest', 'write_runtime_closure_bundle', 'write_whitepaper_autoresearch_diagnostics_notebook')
# fmt: on
