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
from contextlib import contextmanager
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterator, Mapping, Sequence, cast
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
import scripts.whitepaper_autoresearch_runner.artifact_io as artifact_io_module
import scripts.whitepaper_autoresearch_runner.persisted_feedback_sources as persisted_feedback_sources_module
import scripts.whitepaper_autoresearch_runner.preview_narrowing as preview_narrowing_module
import scripts.whitepaper_autoresearch_runner.proposal_building as proposal_building_module
import scripts.whitepaper_autoresearch_runner.proposal_training as proposal_training_module
import scripts.whitepaper_autoresearch_runner.replay_execution as replay_execution_module
import scripts.whitepaper_autoresearch_runner.replay_shards as replay_shards_module

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
    _program_claim_type,
    _program_research_source_to_whitepaper_source,
    _program_whitepaper_sources,
    _dedupe_whitepaper_sources,
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
    _proposal_score_confidence,
    _selection_reason_blocks_replay,
)
from scripts.whitepaper_autoresearch_runner.candidate_identity import (
    _candidate_spec_execution_signature,
)

from scripts.whitepaper_autoresearch_runner.preview_narrowing import (
    _candidate_selection_for_direct_replay,
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

from scripts.whitepaper_autoresearch_runner.replay_execution import (
    _synthetic_net_for_spec,
    _synthetic_symbol_contribution_shares,
    _synthetic_candidate_payload,
    _dedupe_replay_evidence,
    _candidate_spec_id_from_experiment_result_path,
)

from scripts.whitepaper_autoresearch_runner.replay_shards import (
    _build_real_replay_shards,
    _failed_shard_spec_ids,
    _evidenced_spec_ids,
    _replay_shard_frontier_candidate_budget,
    _bounded_real_replay_shard_workers,
    _bounded_real_replay_shard_timeout_seconds,
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

_EXACT_REPLAY_LEDGER_ARTIFACT_KIND = "exact_replay_ledger"

_EXACT_REPLAY_LEDGER_SCHEMA_VERSIONS = frozenset(
    {
        "torghut.exact_replay_ledger.rows.v1",
        "torghut.exact_replay_ledger.v1",
    }
)

_EXACT_REPLAY_RUNTIME_LEDGER_PNL_SOURCE = "exact_replay_runtime_ledger"

_BASE_CURRENT_CODE_COMMIT = artifact_io_module._current_code_commit
_BASE_RUN_SYNTHETIC_REPLAY = replay_execution_module._run_synthetic_replay
_BASE_RUN_REAL_REPLAY = replay_execution_module._run_real_replay
_BASE_REAL_REPLAY_RESULT_FROM_FACTORY_PAYLOAD = (
    replay_execution_module._real_replay_result_from_factory_payload
)
_BASE_COLLECT_PARTIAL_REAL_REPLAY = replay_execution_module._collect_partial_real_replay
_BASE_REAL_REPLAY_WORKER = replay_execution_module._real_replay_worker
_BASE_TERMINATE_PROCESS = replay_execution_module._terminate_process
_BASE_RUN_REAL_REPLAY_ONCE_WITH_OPTIONAL_TIMEOUT = (
    replay_execution_module._run_real_replay_once_with_optional_timeout
)
_BASE_RUN_REAL_REPLAY_ONCE_IN_CHILD_PROCESS = (
    replay_execution_module._run_real_replay_once_in_child_process
)
_BASE_APPLY_FAST_REPLAY_PREVIEW_NARROWING = (
    preview_narrowing_module._apply_fast_replay_preview_narrowing
)
_BASE_EXECUTE_REAL_REPLAY_SHARD = replay_shards_module._execute_real_replay_shard
_BASE_RETRY_REAL_REPLAY_FAILED_SHARD_SPECS = (
    replay_shards_module._retry_real_replay_failed_shard_specs
)
_BASE_RUN_REAL_REPLAY_SHARDS = replay_shards_module._run_real_replay_shards
_BASE_RUN_REPLAY_WITH_OPTIONAL_TIMEOUT = (
    replay_shards_module._run_replay_with_optional_timeout
)


@contextmanager
def _temporary_module_attr(module: Any, name: str, value: Any) -> Iterator[None]:
    original = getattr(module, name)
    setattr(module, name, value)
    try:
        yield
    finally:
        setattr(module, name, original)


def _current_code_commit() -> str:
    with _temporary_module_attr(artifact_io_module, "__file__", __file__):
        return _BASE_CURRENT_CODE_COMMIT()


def _load_recent_persisted_feedback_evidence_bundles(*args: Any, **kwargs: Any) -> Any:
    with _temporary_module_attr(
        persisted_feedback_sources_module, "SessionLocal", SessionLocal
    ):
        return persisted_feedback_sources_module._load_recent_persisted_feedback_evidence_bundles(
            *args, **kwargs
        )


def _load_autoresearch_feedback_evidence_bundles(*args: Any, **kwargs: Any) -> Any:
    with _temporary_module_attr(
        persisted_feedback_sources_module, "SessionLocal", SessionLocal
    ):
        return persisted_feedback_sources_module._load_autoresearch_feedback_evidence_bundles(
            *args, **kwargs
        )


def _load_sources_from_db(*args: Any, **kwargs: Any) -> Any:
    with _temporary_module_attr(
        persisted_feedback_sources_module, "SessionLocal", SessionLocal
    ):
        return persisted_feedback_sources_module._load_sources_from_db(*args, **kwargs)


def _persist_vnext_specs(*args: Any, **kwargs: Any) -> Any:
    with _temporary_module_attr(
        persisted_feedback_sources_module, "SessionLocal", SessionLocal
    ):
        return persisted_feedback_sources_module._persist_vnext_specs(*args, **kwargs)


def _persist_epoch_ledgers(*args: Any, **kwargs: Any) -> Any:
    with _temporary_module_attr(
        persisted_feedback_sources_module, "SessionLocal", SessionLocal
    ):
        return persisted_feedback_sources_module._persist_epoch_ledgers(*args, **kwargs)


def _pre_replay_proposal_model_and_rows(*args: Any, **kwargs: Any) -> Any:
    with _temporary_module_attr(
        proposal_building_module, "train_mlx_ranker", train_mlx_ranker
    ):
        return proposal_building_module._pre_replay_proposal_model_and_rows(
            *args, **kwargs
        )


def _proposal_model_and_rows(*args: Any, **kwargs: Any) -> Any:
    with _temporary_module_attr(
        proposal_training_module, "train_mlx_ranker", train_mlx_ranker
    ):
        return proposal_training_module._proposal_model_and_rows(*args, **kwargs)


def _run_synthetic_replay(*args: Any, **kwargs: Any) -> Any:
    with _temporary_module_attr(
        replay_execution_module, "_current_code_commit", _current_code_commit
    ):
        return _BASE_RUN_SYNTHETIC_REPLAY(*args, **kwargs)


def _run_real_replay(*args: Any, **kwargs: Any) -> Any:
    with _temporary_module_attr(
        replay_execution_module, "_current_code_commit", _current_code_commit
    ):
        return _BASE_RUN_REAL_REPLAY(*args, **kwargs)


def _real_replay_result_from_factory_payload(*args: Any, **kwargs: Any) -> Any:
    with _temporary_module_attr(
        replay_execution_module, "_current_code_commit", _current_code_commit
    ):
        return _BASE_REAL_REPLAY_RESULT_FROM_FACTORY_PAYLOAD(*args, **kwargs)


def _collect_partial_real_replay(*args: Any, **kwargs: Any) -> Any:
    with _temporary_module_attr(
        replay_execution_module,
        "_real_replay_result_from_factory_payload",
        _real_replay_result_from_factory_payload,
    ):
        return _BASE_COLLECT_PARTIAL_REAL_REPLAY(*args, **kwargs)


def _run_real_replay_once_with_optional_timeout(*args: Any, **kwargs: Any) -> Any:
    with (
        _temporary_module_attr(replay_execution_module, "signal", signal),
        _temporary_module_attr(
            replay_execution_module, "_run_real_replay", _run_real_replay
        ),
        _temporary_module_attr(
            replay_execution_module,
            "_run_real_replay_once_in_child_process",
            _run_real_replay_once_in_child_process,
        ),
    ):
        return _BASE_RUN_REAL_REPLAY_ONCE_WITH_OPTIONAL_TIMEOUT(*args, **kwargs)


def _real_replay_worker(*args: Any, **kwargs: Any) -> Any:
    with _temporary_module_attr(
        replay_execution_module, "_run_real_replay", _run_real_replay
    ):
        return _BASE_REAL_REPLAY_WORKER(*args, **kwargs)


def _terminate_process(*args: Any, **kwargs: Any) -> Any:
    return _BASE_TERMINATE_PROCESS(*args, **kwargs)


def _run_real_replay_once_in_child_process(*args: Any, **kwargs: Any) -> Any:
    with (
        _temporary_module_attr(
            replay_execution_module, "_real_replay_worker", _real_replay_worker
        ),
        _temporary_module_attr(
            replay_execution_module, "_terminate_process", _terminate_process
        ),
        _temporary_module_attr(
            replay_execution_module, "multiprocessing", multiprocessing
        ),
        _temporary_module_attr(replay_execution_module, "queue", queue),
        _temporary_module_attr(
            replay_execution_module, "monotonic_time", monotonic_time
        ),
    ):
        return _BASE_RUN_REAL_REPLAY_ONCE_IN_CHILD_PROCESS(*args, **kwargs)


def _execute_real_replay_shard(*args: Any, **kwargs: Any) -> Any:
    with (
        _temporary_module_attr(
            replay_shards_module,
            "_run_real_replay_once_with_optional_timeout",
            _run_real_replay_once_with_optional_timeout,
        ),
        _temporary_module_attr(
            replay_shards_module,
            "_collect_partial_real_replay",
            _collect_partial_real_replay,
        ),
    ):
        return _BASE_EXECUTE_REAL_REPLAY_SHARD(*args, **kwargs)


def _retry_real_replay_failed_shard_specs(*args: Any, **kwargs: Any) -> Any:
    with _temporary_module_attr(
        replay_shards_module, "_execute_real_replay_shard", _execute_real_replay_shard
    ):
        return _BASE_RETRY_REAL_REPLAY_FAILED_SHARD_SPECS(*args, **kwargs)


def _run_real_replay_shards(*args: Any, **kwargs: Any) -> Any:
    with (
        _temporary_module_attr(
            replay_shards_module,
            "_execute_real_replay_shard",
            _execute_real_replay_shard,
        ),
        _temporary_module_attr(
            replay_shards_module,
            "_retry_real_replay_failed_shard_specs",
            _retry_real_replay_failed_shard_specs,
        ),
        _temporary_module_attr(
            replay_shards_module, "ProcessPoolExecutor", ProcessPoolExecutor
        ),
        _temporary_module_attr(replay_shards_module, "as_completed", as_completed),
    ):
        return _BASE_RUN_REAL_REPLAY_SHARDS(*args, **kwargs)


def _run_replay_with_optional_timeout(*args: Any, **kwargs: Any) -> Any:
    with (
        _temporary_module_attr(
            replay_shards_module, "_run_synthetic_replay", _run_synthetic_replay
        ),
        _temporary_module_attr(
            replay_shards_module,
            "_run_real_replay_once_with_optional_timeout",
            _run_real_replay_once_with_optional_timeout,
        ),
        _temporary_module_attr(
            replay_shards_module, "_run_real_replay_shards", _run_real_replay_shards
        ),
    ):
        return _BASE_RUN_REPLAY_WITH_OPTIONAL_TIMEOUT(*args, **kwargs)


def _apply_fast_replay_preview_narrowing(*args: Any, **kwargs: Any) -> Any:
    with _temporary_module_attr(
        preview_narrowing_module, "build_fast_replay_preview", build_fast_replay_preview
    ):
        return _BASE_APPLY_FAST_REPLAY_PREVIEW_NARROWING(*args, **kwargs)


def _select_candidate_specs_for_replay(
    *,
    specs: Sequence[CandidateSpec],
    proposal_rows: Sequence[Mapping[str, Any]],
    top_k: int,
    exploration_slots: int,
    max_candidates: int,
    portfolio_size_min: int,
    feedback_block_reaudit_slots: int = 0,
) -> tuple[list[CandidateSpec], dict[str, Any]]:
    if not specs:
        return [], {
            "schema_version": "torghut.whitepaper-autoresearch-selection.v1",
            "selected_candidate_spec_ids": [],
            "rows": [],
        }
    spec_by_id = {spec.candidate_spec_id: spec for spec in specs}
    execution_signature_by_spec = {
        spec.candidate_spec_id: _candidate_spec_execution_signature(spec)
        for spec in specs
    }
    capital_features_by_spec = {
        spec.candidate_spec_id: dict(candidate_spec_capital_features(spec))
        for spec in specs
    }
    proposal_by_spec = {
        _string(row.get("candidate_spec_id")): row
        for row in _list_of_mappings(list(proposal_rows))
        if _string(row.get("candidate_spec_id"))
    }
    capital_block_reason = "pre_replay_capital_budget_blocked"

    def proposal_score(candidate_spec_id: str) -> Decimal:
        return _decimal(
            proposal_by_spec.get(candidate_spec_id, {}).get("proposal_score")
        )

    def proposal_training_source(candidate_spec_id: str) -> str:
        return (
            _string(proposal_by_spec.get(candidate_spec_id, {}).get("training_source"))
            or "unknown"
        )

    def proposal_feedback_context_count(candidate_spec_id: str) -> int:
        try:
            return int(
                proposal_by_spec.get(candidate_spec_id, {}).get(
                    "feedback_evidence_context_count", 0
                )
                or 0
            )
        except (TypeError, ValueError):
            return 0

    def proposal_selection_reason(candidate_spec_id: str) -> str:
        return _string(
            proposal_by_spec.get(candidate_spec_id, {}).get("selection_reason")
        )

    def proposal_feature(candidate_spec_id: str, key: str) -> Decimal:
        features = _mapping(proposal_by_spec.get(candidate_spec_id, {}).get("features"))
        return _decimal(features.get(key))

    def proposal_has_feature(candidate_spec_id: str, key: str) -> bool:
        features = _mapping(proposal_by_spec.get(candidate_spec_id, {}).get("features"))
        return key in features

    def capital_blocked(spec: CandidateSpec) -> bool:
        features = capital_features_by_spec.get(spec.candidate_spec_id, {})
        oracle_policy = _mapping(
            spec.promotion_contract.get("profit_target_oracle_policy")
        )
        max_gross_exposure = _decimal(
            oracle_policy.get("max_gross_exposure_pct_equity"), default="1.0"
        )
        return (
            _decimal(features.get("capital_feasible_flag")) < Decimal("1")
            or _decimal(features.get("capital_budget_overage_ratio")) > Decimal("0")
            or _decimal(features.get("estimated_max_gross_exposure_pct_equity"))
            > max_gross_exposure
        )

    def pre_replay_block_reason(spec: CandidateSpec) -> str:
        proposal = proposal_by_spec.get(spec.candidate_spec_id, {})
        selection_reason = _string(proposal.get("selection_reason"))
        if selection_reason in _PRE_REPLAY_FEEDBACK_BLOCK_REASONS:
            if (
                selection_reason == "pre_replay_mlx_family_feedback_blocked"
                and _candidate_spec_is_false_negative_rescue(spec)
            ):
                return ""
            return selection_reason
        if capital_blocked(spec):
            return capital_block_reason
        score = proposal_score(spec.candidate_spec_id)
        if proposal.get("proposal_score") is not None and score <= Decimal("-999999"):
            return "pre_replay_mlx_feedback_blocked"
        if (
            proposal_training_source(spec.candidate_spec_id) == "synthetic_prior"
            and proposal_feedback_context_count(spec.candidate_spec_id) > 0
            and proposal.get("proposal_score") is not None
            and score <= Decimal("0")
        ):
            if proposal_has_feature(
                spec.candidate_spec_id,
                "configured_daily_notional_required_ratio",
            ) and proposal_feature(
                spec.candidate_spec_id,
                "configured_daily_notional_required_ratio",
            ) < Decimal("1"):
                return "pre_replay_synthetic_capacity_insufficient"
            return "pre_replay_mlx_synthetic_nonpositive_expected_value"
        return ""

    def is_feedback_block_reason(reason: str) -> bool:
        return (
            reason in _PRE_REPLAY_FEEDBACK_BLOCK_REASONS
            or reason == "pre_replay_mlx_feedback_blocked"
        )

    def capital_sort_key(candidate_spec_id: str) -> tuple[int, Decimal, str]:
        features = capital_features_by_spec.get(candidate_spec_id, {})
        feasible = Decimal(str(features.get("capital_feasible_flag", 0)))
        overage = Decimal(str(features.get("capital_budget_overage_ratio", 0)))
        return (0 if feasible >= Decimal("1") else 1, overage, candidate_spec_id)

    max_budget = max(1, int(max_candidates))
    model_confidence = _proposal_score_confidence(proposal_rows)
    requested_exploration_slots = max(0, int(exploration_slots))
    effective_exploration_slots = requested_exploration_slots + (
        1 if model_confidence["confidence"] == "low" else 0
    )
    requested_budget = max(0, int(top_k)) + effective_exploration_slots
    diversification_floor = min(len(specs), 3)
    replay_budget = min(
        max_budget,
        max(1, int(portfolio_size_min), requested_budget, diversification_floor),
    )
    ranked_ids = [
        str(row.get("candidate_spec_id"))
        for row in sorted(
            _list_of_mappings(list(proposal_rows)),
            key=lambda row: (
                *capital_sort_key(str(row.get("candidate_spec_id") or ""))[:2],
                int(row.get("rank") or 10**9),
                -float(row.get("proposal_score") or 0.0),
                str(row.get("candidate_spec_id") or ""),
            ),
        )
        if str(row.get("candidate_spec_id")) in spec_by_id
    ]
    ranked_ids.extend(
        spec.candidate_spec_id
        for spec in sorted(
            specs,
            key=lambda item: (*capital_sort_key(item.candidate_spec_id),),
        )
        if spec.candidate_spec_id not in set(ranked_ids)
    )
    ordered = [spec_by_id[candidate_spec_id] for candidate_spec_id in ranked_ids]
    representative_by_signature: dict[str, CandidateSpec] = {}
    ordered_unique: list[CandidateSpec] = []
    for spec in ordered:
        execution_signature = execution_signature_by_spec[spec.candidate_spec_id]
        if execution_signature in representative_by_signature:
            continue
        representative_by_signature[execution_signature] = spec
        ordered_unique.append(spec)
    block_reason_by_spec = {
        spec.candidate_spec_id: reason
        for spec in ordered_unique
        if (reason := pre_replay_block_reason(spec))
    }
    ordered_eligible = [
        spec
        for spec in ordered_unique
        if spec.candidate_spec_id not in block_reason_by_spec
    ]
    synthetic_prior_probe_candidates = [
        spec
        for spec in ordered_unique
        if block_reason_by_spec.get(spec.candidate_spec_id)
        == "pre_replay_mlx_synthetic_nonpositive_expected_value"
    ]
    feedback_block_reaudit_candidates = [
        spec
        for spec in ordered_unique
        if is_feedback_block_reason(
            block_reason_by_spec.get(spec.candidate_spec_id, "")
        )
        and block_reason_by_spec.get(spec.candidate_spec_id)
        != "pre_replay_mlx_no_activity_feedback_blocked"
    ]
    rank_position_by_spec = {
        spec.candidate_spec_id: index for index, spec in enumerate(ordered, start=1)
    }
    synthetic_prior_probe_capacity = min(
        requested_exploration_slots,
        len(synthetic_prior_probe_candidates),
    )
    requested_feedback_block_reaudit_slots = max(0, int(feedback_block_reaudit_slots))
    feedback_block_reaudit_capacity = min(
        requested_feedback_block_reaudit_slots,
        len(feedback_block_reaudit_candidates),
    )
    replay_budget = min(
        replay_budget,
        len(ordered_eligible)
        + synthetic_prior_probe_capacity
        + feedback_block_reaudit_capacity,
    )

    def spec_source_run_id(spec: CandidateSpec) -> str:
        return _string(spec.feature_contract.get("source_run_id")) or spec.hypothesis_id

    def spec_universe_key(spec: CandidateSpec) -> str:
        universe = spec.strategy_overrides.get("universe_symbols")
        if not isinstance(universe, Sequence) or isinstance(universe, str):
            return ""
        return ",".join(
            sorted(_string(item).upper() for item in universe if _string(item))
        )

    def spec_signal_key(spec: CandidateSpec) -> str:
        params = _mapping(spec.strategy_overrides.get("params"))
        return "|".join(
            part
            for part in (
                _string(params.get("signal_motif")),
                _string(params.get("selection_mode")),
                _string(params.get("rank_feature")),
            )
            if part
        )

    def spec_param_text(spec: CandidateSpec, key: str) -> str:
        params = _mapping(spec.strategy_overrides.get("params"))
        return _string(params.get(key))

    def diversity_key(
        spec: CandidateSpec, selected_so_far: Sequence[CandidateSpec]
    ) -> tuple[bool, bool, bool, bool, bool, int, int, str]:
        selected_families = {item.family_template_id for item in selected_so_far}
        selected_runtime_strategies = {
            item.runtime_strategy_name for item in selected_so_far
        }
        selected_universes = {spec_universe_key(item) for item in selected_so_far}
        selected_signals = {spec_signal_key(item) for item in selected_so_far}
        selected_sources = {spec_source_run_id(item) for item in selected_so_far}
        family_selection = _mapping(spec.feature_contract.get("family_selection"))
        return (
            spec.family_template_id in selected_families,
            spec.runtime_strategy_name in selected_runtime_strategies,
            bool(spec_universe_key(spec))
            and spec_universe_key(spec) in selected_universes,
            bool(spec_signal_key(spec)) and spec_signal_key(spec) in selected_signals,
            spec_source_run_id(spec) in selected_sources,
            rank_position_by_spec.get(spec.candidate_spec_id, 10**6),
            int(family_selection.get("rank") or 10**6),
            spec.candidate_spec_id,
        )

    def take_diverse(
        candidates: Sequence[CandidateSpec],
        *,
        count: int,
        selected_so_far: Sequence[CandidateSpec],
    ) -> list[CandidateSpec]:
        pool = list(candidates)
        picked: list[CandidateSpec] = []
        while pool and len(picked) < count:
            best = min(
                pool,
                key=lambda spec: diversity_key(spec, [*selected_so_far, *picked]),
            )
            picked.append(best)
            pool.remove(best)
        return picked

    def interleave_replay_segments(
        *segments: Sequence[CandidateSpec],
    ) -> list[CandidateSpec]:
        interleaved: list[CandidateSpec] = []
        max_length = max((len(segment) for segment in segments), default=0)
        for index in range(max_length):
            for segment in segments:
                if index < len(segment):
                    interleaved.append(segment[index])
        return interleaved

    active_loss_counter_candidates = [
        spec
        for spec in ordered_eligible
        if proposal_selection_reason(spec.candidate_spec_id)
        == "pre_replay_mlx_active_loss_counter_candidate"
    ]
    active_loss_counter_cap = 4
    if replay_budget <= 4:
        active_loss_counter_cap = max(1, replay_budget // 2)
    active_loss_counter_count = min(
        active_loss_counter_cap,
        max(0, requested_exploration_slots),
        replay_budget,
        len(active_loss_counter_candidates),
    )
    active_loss_counter = take_diverse(
        active_loss_counter_candidates,
        count=active_loss_counter_count,
        selected_so_far=(),
    )
    active_loss_counter_ids = {spec.candidate_spec_id for spec in active_loss_counter}
    consistency_repair_candidates = [
        spec
        for spec in ordered_eligible
        if spec.candidate_spec_id not in active_loss_counter_ids
        if proposal_selection_reason(spec.candidate_spec_id)
        == "pre_replay_mlx_consistency_repair_candidate"
    ]
    consistency_repair_cap = 4
    if replay_budget <= 4:
        consistency_repair_cap = max(1, replay_budget // 2)
    consistency_repair_count = min(
        consistency_repair_cap,
        max(0, requested_exploration_slots - len(active_loss_counter)),
        replay_budget - len(active_loss_counter),
        len(consistency_repair_candidates),
    )
    consistency_repair = take_diverse(
        consistency_repair_candidates,
        count=consistency_repair_count,
        selected_so_far=active_loss_counter,
    )
    consistency_repair_ids = {spec.candidate_spec_id for spec in consistency_repair}

    runtime_strategy_floor_priority = {
        "intraday-tsmom-profit-v3": 0,
        "late-day-continuation-long-v1": 1,
        "microbar-cross-sectional-pairs-v1": 2,
        "breakout-continuation-long-v1": 3,
    }
    runtime_strategy_representatives: dict[str, CandidateSpec] = {}
    for spec in sorted(
        ordered_eligible,
        key=lambda item: (
            runtime_strategy_floor_priority.get(item.runtime_strategy_name, 100),
            rank_position_by_spec.get(item.candidate_spec_id, 10**6),
            item.candidate_spec_id,
        ),
    ):
        if spec.candidate_spec_id in active_loss_counter_ids | consistency_repair_ids:
            continue
        if spec.runtime_strategy_name not in runtime_strategy_representatives:
            runtime_strategy_representatives[spec.runtime_strategy_name] = spec
    runtime_strategy_floor = (
        list(runtime_strategy_representatives.values())[
            : min(4, replay_budget - len(active_loss_counter) - len(consistency_repair))
        ]
        if len(runtime_strategy_representatives) > 1
        and replay_budget > len(active_loss_counter) + len(consistency_repair)
        else []
    )
    runtime_strategy_floor_ids = {
        spec.candidate_spec_id for spec in runtime_strategy_floor
    }
    paper_contract_candidates = [
        spec
        for spec in ordered_eligible
        if spec.candidate_spec_id not in active_loss_counter_ids
        if spec.candidate_spec_id not in consistency_repair_ids
        if spec.candidate_spec_id not in runtime_strategy_floor_ids
        if _paper_mechanism_prior_score(spec) > Decimal("0")
    ]
    paper_contract_count = min(
        3,
        max(
            0,
            requested_exploration_slots
            - len(active_loss_counter)
            - len(consistency_repair),
        ),
        replay_budget
        - len(active_loss_counter)
        - len(consistency_repair)
        - len(runtime_strategy_floor),
        len(paper_contract_candidates),
    )
    paper_contract_exploration = take_diverse(
        paper_contract_candidates,
        count=paper_contract_count,
        selected_so_far=[
            *active_loss_counter,
            *consistency_repair,
            *runtime_strategy_floor,
        ],
    )
    paper_contract_exploration_ids = {
        spec.candidate_spec_id for spec in paper_contract_exploration
    }
    false_negative_rescue_candidates = [
        spec
        for spec in ordered_eligible
        if spec.candidate_spec_id not in runtime_strategy_floor_ids
        if spec.candidate_spec_id not in active_loss_counter_ids
        if spec.candidate_spec_id not in consistency_repair_ids
        if spec.candidate_spec_id not in paper_contract_exploration_ids
        if _candidate_spec_is_false_negative_rescue(spec)
    ]
    false_negative_rescue_count = min(
        3,
        max(0, requested_exploration_slots - len(consistency_repair)),
        replay_budget
        - len(active_loss_counter)
        - len(consistency_repair)
        - len(runtime_strategy_floor)
        - len(paper_contract_exploration),
        len(false_negative_rescue_candidates),
    )
    false_negative_rescue_exploration = take_diverse(
        false_negative_rescue_candidates,
        count=false_negative_rescue_count,
        selected_so_far=[
            *active_loss_counter,
            *consistency_repair,
            *runtime_strategy_floor,
            *paper_contract_exploration,
        ],
    )
    false_negative_rescue_ids = {
        spec.candidate_spec_id for spec in false_negative_rescue_exploration
    }
    exploitation_candidates = [
        spec
        for spec in ordered_eligible
        if spec.candidate_spec_id
        not in active_loss_counter_ids
        | consistency_repair_ids
        | runtime_strategy_floor_ids
        | paper_contract_exploration_ids
        | false_negative_rescue_ids
    ]
    exploitation_count = min(
        max(0, int(top_k)),
        replay_budget
        - len(active_loss_counter)
        - len(consistency_repair)
        - len(runtime_strategy_floor)
        - len(paper_contract_exploration)
        - len(false_negative_rescue_exploration),
        len(exploitation_candidates),
    )
    exploitation = take_diverse(
        exploitation_candidates,
        count=exploitation_count,
        selected_so_far=[
            *active_loss_counter,
            *consistency_repair,
            *runtime_strategy_floor,
            *paper_contract_exploration,
            *false_negative_rescue_exploration,
        ],
    )
    remaining = [
        item
        for item in sorted(
            ordered_eligible,
            key=lambda spec: diversity_key(
                spec,
                [
                    *active_loss_counter,
                    *consistency_repair,
                    *runtime_strategy_floor,
                    *paper_contract_exploration,
                    *false_negative_rescue_exploration,
                    *exploitation,
                ],
            ),
        )
        if item.candidate_spec_id
        not in {
            spec.candidate_spec_id
            for spec in (
                *runtime_strategy_floor,
                *active_loss_counter,
                *consistency_repair,
                *paper_contract_exploration,
                *false_negative_rescue_exploration,
                *exploitation,
            )
        }
    ]
    exploration_count = min(
        effective_exploration_slots,
        replay_budget
        - len(active_loss_counter)
        - len(consistency_repair)
        - len(runtime_strategy_floor)
        - len(paper_contract_exploration)
        - len(false_negative_rescue_exploration)
        - len(exploitation),
        len(remaining),
    )
    exploration = take_diverse(
        remaining,
        count=exploration_count,
        selected_so_far=[
            *runtime_strategy_floor,
            *active_loss_counter,
            *consistency_repair,
            *paper_contract_exploration,
            *false_negative_rescue_exploration,
            *exploitation,
        ],
    )
    synthetic_prior_probe_exploration_count = min(
        max(0, requested_exploration_slots - len(exploration)),
        replay_budget
        - len(active_loss_counter)
        - len(consistency_repair)
        - len(runtime_strategy_floor)
        - len(paper_contract_exploration)
        - len(false_negative_rescue_exploration)
        - len(exploitation)
        - len(exploration),
        len(synthetic_prior_probe_candidates),
    )
    synthetic_prior_probe_exploration = take_diverse(
        synthetic_prior_probe_candidates,
        count=synthetic_prior_probe_exploration_count,
        selected_so_far=[
            *runtime_strategy_floor,
            *active_loss_counter,
            *consistency_repair,
            *paper_contract_exploration,
            *false_negative_rescue_exploration,
            *exploitation,
            *exploration,
        ],
    )
    feedback_block_reaudit_count = min(
        requested_feedback_block_reaudit_slots,
        replay_budget
        - len(active_loss_counter)
        - len(consistency_repair)
        - len(runtime_strategy_floor)
        - len(paper_contract_exploration)
        - len(false_negative_rescue_exploration)
        - len(exploitation)
        - len(exploration)
        - len(synthetic_prior_probe_exploration),
        len(feedback_block_reaudit_candidates),
    )
    feedback_block_reaudit = take_diverse(
        feedback_block_reaudit_candidates,
        count=feedback_block_reaudit_count,
        selected_so_far=[
            *runtime_strategy_floor,
            *active_loss_counter,
            *consistency_repair,
            *paper_contract_exploration,
            *false_negative_rescue_exploration,
            *exploitation,
            *exploration,
            *synthetic_prior_probe_exploration,
        ],
    )
    if (
        len(runtime_strategy_floor)
        + len(active_loss_counter)
        + len(consistency_repair)
        + len(paper_contract_exploration)
        + len(false_negative_rescue_exploration)
        + len(exploitation)
        + len(exploration)
        < replay_budget
    ):
        selected_ids = {
            item.candidate_spec_id
            for item in (
                *runtime_strategy_floor,
                *active_loss_counter,
                *consistency_repair,
                *paper_contract_exploration,
                *false_negative_rescue_exploration,
                *exploitation,
                *exploration,
                *synthetic_prior_probe_exploration,
                *feedback_block_reaudit,
            )
        }
        backfill_candidates = [
            item
            for item in ordered_eligible
            if item.candidate_spec_id not in selected_ids
        ]
        backfill = take_diverse(
            backfill_candidates,
            count=replay_budget
            - len(active_loss_counter)
            - len(consistency_repair)
            - len(runtime_strategy_floor)
            - len(paper_contract_exploration)
            - len(false_negative_rescue_exploration)
            - len(exploitation)
            - len(exploration)
            - len(synthetic_prior_probe_exploration)
            - len(feedback_block_reaudit),
            selected_so_far=[
                *runtime_strategy_floor,
                *active_loss_counter,
                *consistency_repair,
                *paper_contract_exploration,
                *false_negative_rescue_exploration,
                *exploitation,
                *exploration,
                *synthetic_prior_probe_exploration,
                *feedback_block_reaudit,
            ],
        )
    else:
        backfill = []
    selected_reason = (
        {
            item.candidate_spec_id: "active_loss_counter_candidate"
            for item in active_loss_counter
        }
        | {
            item.candidate_spec_id: "consistency_repair_candidate"
            for item in consistency_repair
        }
        | {
            item.candidate_spec_id: "runtime_strategy_floor"
            for item in runtime_strategy_floor
        }
        | {
            item.candidate_spec_id: "paper_contract_exploration"
            for item in paper_contract_exploration
        }
        | {
            item.candidate_spec_id: "false_negative_rescue_exploration"
            for item in false_negative_rescue_exploration
        }
        | {item.candidate_spec_id: "exploitation" for item in exploitation}
        | {item.candidate_spec_id: "exploration" for item in exploration}
    )
    selected_reason.update(
        {
            item.candidate_spec_id: "synthetic_prior_exploration"
            for item in synthetic_prior_probe_exploration
        }
    )
    selected_reason.update(
        {
            item.candidate_spec_id: "feedback_block_reaudit"
            for item in feedback_block_reaudit
        }
    )
    selected_reason.update(
        {item.candidate_spec_id: "budget_backfill" for item in backfill}
    )
    selected = [
        *active_loss_counter,
        *consistency_repair,
        *runtime_strategy_floor,
        *paper_contract_exploration,
        *false_negative_rescue_exploration,
        *exploitation,
        *exploration,
        *interleave_replay_segments(
            feedback_block_reaudit,
            synthetic_prior_probe_exploration,
        ),
        *backfill,
    ]
    selected_ids = {item.candidate_spec_id for item in selected}
    selected_pre_replay_blocked_ids = {
        item.candidate_spec_id for item in synthetic_prior_probe_exploration
    } | {item.candidate_spec_id for item in feedback_block_reaudit}
    replay_order_by_spec = {
        item.candidate_spec_id: index for index, item in enumerate(selected, start=1)
    }

    def row_selection_reason(spec: CandidateSpec) -> str:
        if spec.candidate_spec_id in selected_reason:
            return selected_reason[spec.candidate_spec_id]
        representative = representative_by_signature[
            execution_signature_by_spec[spec.candidate_spec_id]
        ]
        if representative.candidate_spec_id != spec.candidate_spec_id:
            return "duplicate_execution_signature"
        block_reason = block_reason_by_spec.get(spec.candidate_spec_id)
        if block_reason:
            return block_reason
        return "not_selected_budget"

    rows = [
        {
            "candidate_spec_id": spec.candidate_spec_id,
            "family_template_id": spec.family_template_id,
            "runtime_family": spec.runtime_family,
            "runtime_strategy_name": spec.runtime_strategy_name,
            "capital_profile": spec_param_text(spec, "capital_profile") or None,
            "feedback_remediation_profile": spec_param_text(
                spec, "feedback_remediation_profile"
            )
            or None,
            "universe_key": spec_universe_key(spec),
            "signal_key": spec_signal_key(spec),
            "execution_signature": execution_signature_by_spec[spec.candidate_spec_id],
            "duplicate_of_candidate_spec_id": representative_by_signature[
                execution_signature_by_spec[spec.candidate_spec_id]
            ].candidate_spec_id
            if representative_by_signature[
                execution_signature_by_spec[spec.candidate_spec_id]
            ].candidate_spec_id
            != spec.candidate_spec_id
            else None,
            "pre_replay_score": str(_pre_replay_candidate_score(spec)),
            "paper_contract_prior_score": str(_paper_mechanism_prior_score(spec)),
            "paper_mechanism_overlay_ids": sorted(
                _candidate_spec_mechanism_overlay_ids(spec)
            ),
            "paper_required_evidence_tokens": sorted(
                _candidate_spec_required_evidence_tokens(spec)
            ),
            "paper_required_evidence_count": len(
                _candidate_spec_required_evidence_tokens(spec)
            ),
            "proposal_score": proposal_by_spec.get(spec.candidate_spec_id, {}).get(
                "proposal_score"
            ),
            "proposal_training_source": proposal_training_source(
                spec.candidate_spec_id
            ),
            "capital_budget": {
                "max_notional_per_trade": str(
                    capital_features_by_spec[spec.candidate_spec_id][
                        "max_notional_per_trade"
                    ]
                ),
                "max_notional_pct_start_equity": str(
                    capital_features_by_spec[spec.candidate_spec_id][
                        "max_notional_pct_start_equity"
                    ]
                ),
                "max_position_pct_equity": str(
                    capital_features_by_spec[spec.candidate_spec_id][
                        "max_position_pct_equity"
                    ]
                ),
                "max_trade_pct_equity": str(
                    capital_features_by_spec[spec.candidate_spec_id][
                        "max_trade_pct_equity"
                    ]
                ),
                "estimated_max_gross_exposure_pct_equity": str(
                    capital_features_by_spec[spec.candidate_spec_id][
                        "estimated_max_gross_exposure_pct_equity"
                    ]
                ),
                "estimated_capital_slot_count": str(
                    capital_features_by_spec[spec.candidate_spec_id][
                        "estimated_capital_slot_count"
                    ]
                ),
                "entry_notional_max_multiplier": str(
                    capital_features_by_spec[spec.candidate_spec_id][
                        "entry_notional_max_multiplier"
                    ]
                ),
                "configured_daily_notional_capacity": str(
                    capital_features_by_spec[spec.candidate_spec_id][
                        "configured_daily_notional_capacity"
                    ]
                ),
                "capital_budget_overage_ratio": str(
                    capital_features_by_spec[spec.candidate_spec_id][
                        "capital_budget_overage_ratio"
                    ]
                ),
                "capital_feasible": bool(
                    capital_features_by_spec[spec.candidate_spec_id][
                        "capital_feasible_flag"
                    ]
                ),
            },
            "rank": index,
            "selected_for_replay": spec.candidate_spec_id in selected_ids,
            "selection_reason": row_selection_reason(spec),
            "replay_order": replay_order_by_spec.get(spec.candidate_spec_id),
            "selection_hash": _stable_hash(
                {
                    "candidate_spec_id": spec.candidate_spec_id,
                    "score": str(_pre_replay_candidate_score(spec)),
                    "selected": spec.candidate_spec_id in selected_ids,
                    "replay_order": replay_order_by_spec.get(spec.candidate_spec_id),
                }
            ),
        }
        for index, spec in enumerate(ordered, start=1)
    ]
    return selected, {
        "schema_version": "torghut.whitepaper-autoresearch-selection.v1",
        "budget": {
            "max_candidates": max_budget,
            "top_k": max(0, int(top_k)),
            "exploration_slots_requested": requested_exploration_slots,
            "exploration_slots_effective": effective_exploration_slots,
            "exploration_slots": effective_exploration_slots,
            "feedback_block_reaudit_slots_requested": requested_feedback_block_reaudit_slots,
            "feedback_block_reaudit_slots_effective": feedback_block_reaudit_capacity,
            "feedback_block_reaudit_selected_count": len(feedback_block_reaudit),
            "active_loss_counter_candidate_selected_count": len(active_loss_counter),
            "consistency_repair_candidate_selected_count": len(consistency_repair),
            "runtime_strategy_floor_selected_count": len(runtime_strategy_floor),
            "paper_contract_candidate_selected_count": len(paper_contract_exploration),
            "portfolio_size_min": max(1, int(portfolio_size_min)),
            "selected_count": len(selected),
            "compiled_candidate_count": len(specs),
            "unique_execution_signature_count": len(ordered_unique),
            "eligible_candidate_count": len(ordered_eligible),
            "pre_replay_feedback_blocked_candidate_count": sum(
                1
                for reason in block_reason_by_spec.values()
                if is_feedback_block_reason(reason)
            ),
            "pre_replay_nonpositive_synthetic_candidate_count": sum(
                1
                for reason in block_reason_by_spec.values()
                if reason == "pre_replay_mlx_synthetic_nonpositive_expected_value"
            ),
            "pre_replay_synthetic_capacity_insufficient_candidate_count": sum(
                1
                for reason in block_reason_by_spec.values()
                if reason == "pre_replay_synthetic_capacity_insufficient"
            ),
            "pre_replay_nonpositive_synthetic_exploration_count": len(
                synthetic_prior_probe_exploration
            ),
            "pre_replay_capital_blocked_candidate_count": sum(
                1
                for reason in block_reason_by_spec.values()
                if reason == capital_block_reason
            ),
            "pre_replay_blocked_candidate_count": sum(
                1
                for candidate_spec_id in block_reason_by_spec
                if candidate_spec_id not in selected_pre_replay_blocked_ids
            ),
            "replay_order_policy": "quality_gated_diversity_pick_order_with_consistency_repair_paper_contract_probe_synthetic_prior_probe_and_feedback_reaudit",
            "capital_feasible_candidate_count": sum(
                1
                for features in capital_features_by_spec.values()
                if Decimal(str(features.get("capital_feasible_flag", 0)))
                >= Decimal("1")
            ),
        },
        "proposal_score_confidence": model_confidence,
        "selected_candidate_spec_ids": [item.candidate_spec_id for item in selected],
        "rows": rows,
    }


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
    args = argparse.Namespace(
        **{
            **vars(args),
            "min_active_day_ratio": str(
                max(
                    _decimal(getattr(args, "min_active_day_ratio", "0.90")),
                    objective.min_active_day_ratio,
                )
            ),
            "min_positive_day_ratio": str(
                max(
                    _decimal(getattr(args, "min_positive_day_ratio", "0.60")),
                    objective.min_positive_day_ratio,
                )
            ),
            "min_daily_net_pnl": str(
                max(
                    _decimal_arg_or_default(
                        args,
                        "min_daily_net_pnl",
                        objective.min_daily_net_pnl,
                    ),
                    objective.min_daily_net_pnl,
                )
            ),
            "min_profit_factor": str(
                max(
                    _decimal(getattr(args, "min_profit_factor", "1.50")),
                    objective.min_profit_factor,
                )
            ),
            "max_worst_day_loss": str(
                min(
                    _decimal(getattr(args, "max_worst_day_loss", "999999999")),
                    objective.max_worst_day_loss,
                )
            ),
            "max_drawdown": str(
                min(
                    _decimal(getattr(args, "max_drawdown", "999999999")),
                    objective.max_drawdown,
                )
            ),
            "max_best_day_share": str(
                min(
                    _decimal(getattr(args, "max_best_day_share", "0.25")),
                    objective.max_best_day_share,
                )
            ),
            "min_avg_filled_notional_per_day": str(
                max(
                    _decimal(
                        getattr(args, "min_avg_filled_notional_per_day", "300000")
                    ),
                    objective.min_daily_notional,
                )
            ),
            "max_worst_day_loss_pct_equity": str(
                min(
                    _decimal(getattr(args, "max_worst_day_loss_pct_equity", "0.05")),
                    objective.max_worst_day_loss_pct_equity,
                )
            ),
            "max_drawdown_pct_equity": str(
                min(
                    _decimal(getattr(args, "max_drawdown_pct_equity", "0.08")),
                    objective.max_drawdown_pct_equity,
                )
            ),
            "extended_max_worst_day_loss_pct_equity": str(
                min(
                    _decimal(
                        getattr(args, "extended_max_worst_day_loss_pct_equity", "0.08")
                    ),
                    objective.extended_max_worst_day_loss_pct_equity,
                )
            ),
            "extended_max_drawdown_pct_equity": str(
                min(
                    _decimal(getattr(args, "extended_max_drawdown_pct_equity", "0.12")),
                    objective.extended_max_drawdown_pct_equity,
                )
            ),
            "min_total_net_pnl_to_drawdown_ratio": str(
                max(
                    _decimal(
                        getattr(args, "min_total_net_pnl_to_drawdown_ratio", "3.00")
                    ),
                    objective.min_total_net_pnl_to_drawdown_ratio,
                )
            ),
            "max_gross_exposure_pct_equity": str(
                min(
                    _decimal(getattr(args, "max_gross_exposure_pct_equity", "1.0")),
                    objective.max_gross_exposure_pct_equity,
                )
            ),
            "min_cash": str(
                max(_decimal(getattr(args, "min_cash", "0")), objective.min_cash)
            ),
            "no_require_double_oos": bool(getattr(args, "no_require_double_oos", False))
            or not bool(getattr(objective, "require_double_oos", True)),
            "min_double_oos_independent_window_count": max(
                _int_arg(args, "min_double_oos_independent_window_count", 2),
                int(getattr(objective, "min_double_oos_independent_window_count", 2)),
            ),
            "min_double_oos_pass_rate": str(
                max(
                    _decimal(getattr(args, "min_double_oos_pass_rate", "1.00")),
                    _decimal(
                        getattr(objective, "min_double_oos_pass_rate", "1.00"),
                        default="1.00",
                    ),
                )
            ),
            "staged_train_screen_multiplier": _resolved_staged_train_screen_multiplier(
                args, program
            ),
            **_resolved_real_replay_frontier_controls(args, program),
        }
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
    if direct_candidate_specs_replay:
        sources: list[WhitepaperResearchSource] = []
        hypothesis_cards: list[HypothesisCard] = []
        try:
            candidate_specs = list(_load_candidate_specs_jsonl(candidate_specs_paths))
        except ValueError as exc:
            return _write_failure_summary(
                output_dir=output_dir,
                epoch_id=epoch_id,
                status="invalid_candidate_specs",
                reason=str(exc),
                started_at=started_at,
                extra={
                    "candidate_specs": [str(path) for path in candidate_specs_paths]
                },
            )
        candidate_compilation_blockers: tuple[CandidateCompilationBlocker, ...] = ()
        candidate_compiler_report: dict[str, Any] = {
            "schema_version": "torghut.whitepaper-candidate-compiler-report.v1",
            "status": "loaded_candidate_specs_for_direct_replay",
            "candidate_specs_artifacts": [str(path) for path in candidate_specs_paths],
            "candidate_spec_count": len(candidate_specs),
            "executable_spec_count": len(candidate_specs),
            "blockers": [],
        }
    else:
        explicit_source_inputs = bool(
            args.seed_recent_whitepapers
            or getattr(args, "source_jsonl", [])
            or getattr(args, "paper_run_id", [])
        )
        sources = (
            list(_program_whitepaper_sources(program))
            if not explicit_source_inputs
            else []
        )
        if args.seed_recent_whitepapers:
            sources.extend(_program_whitepaper_sources(program))
            sources.extend(RECENT_WHITEPAPER_SEEDS)
        for source_jsonl in getattr(args, "source_jsonl", []):
            sources.extend(sources_from_jsonl(source_jsonl))
        sources.extend(_load_sources_from_db(args.paper_run_id))
        sources = _dedupe_whitepaper_sources(sources)
        if not sources:
            return _write_failure_summary(
                output_dir=output_dir,
                epoch_id=epoch_id,
                status="no_sources",
                reason="no_whitepaper_sources",
                started_at=started_at,
            )

        hypothesis_cards = compile_sources_to_hypothesis_cards(sources)
        compilation = compile_whitepaper_candidate_specs(
            hypothesis_cards=hypothesis_cards,
            target_net_pnl_per_day=target,
            family_template_dir=args.family_template_dir.resolve(),
            seed_sweep_dir=args.seed_sweep_dir.resolve(),
            universe_symbols=candidate_universe_symbols,
        )
        candidate_specs = list(compilation.executable_specs)
        candidate_specs = _candidate_specs_with_oracle_policy(
            candidate_specs, oracle_policy=oracle_policy
        )
        candidate_compilation_blockers = tuple(compilation.blockers)
        candidate_compiler_report = compilation.to_payload()
    blocker_by_spec: dict[str, list[CandidateCompilationBlocker]] = {}
    for blocker in candidate_compilation_blockers:
        blocker_by_spec.setdefault(blocker.candidate_spec_id, []).append(blocker)
    if (
        args.persist_results
        and args.replay_mode == "real"
        and not selection_only
        and not direct_candidate_specs_replay
    ):
        for source in sources:
            source_specs = [
                spec
                for spec in candidate_specs
                if spec.feature_contract.get("source_run_id") == source.run_id
            ]
            _persist_vnext_specs(source_run_id=source.run_id, specs=source_specs)

    _write_json(
        output_dir / "epoch-manifest.json",
        {
            "epoch_id": epoch_id,
            "started_at": datetime.now(UTC).isoformat(),
            "target_net_pnl_per_day": str(target),
            "replay_mode": args.replay_mode,
            "source_count": len(sources),
            "paper_sources": [source.to_payload() for source in sources],
        },
    )
    _write_jsonl(
        output_dir / "whitepaper-sources.jsonl",
        [source.to_payload() for source in sources],
    )
    _write_jsonl(
        output_dir / "hypothesis-cards.jsonl",
        [card.to_payload() for card in hypothesis_cards],
    )
    _write_jsonl(
        output_dir / "candidate-specs.jsonl",
        [spec.to_payload() for spec in candidate_specs],
    )
    _write_json(
        output_dir / "candidate-compiler-report.json", candidate_compiler_report
    )

    if not candidate_specs:
        return _write_failure_summary(
            output_dir=output_dir,
            epoch_id=epoch_id,
            status="no_eligible_candidates",
            reason="candidate_compiler_produced_no_executable_specs",
            started_at=started_at,
        )
    try:
        (
            feedback_evidence_bundles,
            feedback_evidence_source_manifest,
        ) = _load_autoresearch_feedback_evidence_bundles(
            cast(Sequence[Path], getattr(args, "feedback_evidence_jsonl", ()) or ()),
            include_persisted=bool(getattr(args, "persist_results", False))
            and not selection_only,
        )
    except ValueError as exc:
        return _write_failure_summary(
            output_dir=output_dir,
            epoch_id=epoch_id,
            status="invalid_feedback_evidence",
            reason=str(exc),
            started_at=started_at,
        )
    _write_json(
        output_dir / "feedback-evidence-source-manifest.json",
        feedback_evidence_source_manifest,
    )
    pre_replay_model, pre_replay_proposal_rows = _pre_replay_proposal_model_and_rows(
        specs=candidate_specs,
        feedback_evidence_bundles=feedback_evidence_bundles,
        oracle_policy=oracle_policy,
        ranker_backend_preference=ranker_backend_preference,
    )
    _write_json(output_dir / "pre-replay-mlx-ranker-model.json", pre_replay_model)
    _write_jsonl(
        output_dir / "pre-replay-mlx-proposal-scores.jsonl",
        pre_replay_proposal_rows,
    )
    if direct_candidate_specs_replay:
        replay_candidate_specs = list(candidate_specs)
        candidate_selection = _candidate_selection_for_direct_replay(
            specs=replay_candidate_specs,
            proposal_rows=pre_replay_proposal_rows,
            candidate_specs_paths=candidate_specs_paths,
        )
    else:
        replay_candidate_specs, candidate_selection = (
            _select_candidate_specs_for_replay(
                specs=candidate_specs,
                proposal_rows=pre_replay_proposal_rows,
                top_k=int(args.top_k),
                exploration_slots=int(args.exploration_slots),
                feedback_block_reaudit_slots=int(
                    getattr(args, "feedback_block_reaudit_slots", 0) or 0
                ),
                max_candidates=int(args.max_candidates),
                portfolio_size_min=int(args.portfolio_size_min),
            )
        )
    candidate_selection = {
        **candidate_selection,
        "proposal_model": {
            "schema_version": pre_replay_model.get("schema_version"),
            "model_id": pre_replay_model.get("model_id"),
            "backend": pre_replay_model.get("backend"),
            "proposal_stage": "pre_replay",
        },
        "proposal_scores_artifact": str(
            output_dir / "pre-replay-mlx-proposal-scores.jsonl"
        ),
        "selected_candidate_specs_artifact": str(
            output_dir / "selected-candidate-specs.jsonl"
        ),
    }
    materialized_replay_tape_receipt: dict[str, Any] | None = None
    try:
        args, materialized_replay_tape_receipt = _maybe_materialize_epoch_replay_tape(
            args=args,
            output_dir=output_dir,
            epoch_id=epoch_id,
        )
    except Exception as exc:
        return _write_failure_summary(
            output_dir=output_dir,
            epoch_id=epoch_id,
            status="replay_tape_materialization_failed",
            reason=str(exc),
            started_at=started_at,
        )
    if materialized_replay_tape_receipt is not None:
        candidate_selection = {
            **candidate_selection,
            "replay_tape_materialization": materialized_replay_tape_receipt,
        }
    if replay_source_window_preflight is not None:
        candidate_selection = {
            **candidate_selection,
            "replay_tape_source_window_preflight": replay_source_window_preflight,
        }
    try:
        replay_candidate_specs, candidate_selection = (
            _apply_fast_replay_preview_narrowing(
                args=args,
                output_dir=output_dir,
                specs=replay_candidate_specs,
                candidate_selection=candidate_selection,
            )
        )
    except ValueError as exc:
        return _write_failure_summary(
            output_dir=output_dir,
            epoch_id=epoch_id,
            status="invalid_replay_tape_preview",
            reason=str(exc),
            started_at=started_at,
        )
    _write_json(output_dir / "candidate-selection-manifest.json", candidate_selection)
    _write_jsonl(
        output_dir / "selected-candidate-specs.jsonl",
        [spec.to_payload() for spec in replay_candidate_specs],
    )
    if selection_only:
        selected_candidate_spec_ids = [
            spec.candidate_spec_id for spec in replay_candidate_specs
        ]
        summary = {
            "status": "selection_only",
            "status_reason": "pre_replay_selection_only",
            "epoch_id": epoch_id,
            "run_root": str(output_dir),
            "started_at": started_at.isoformat(),
            "completed_at": datetime.now(UTC).isoformat(),
            "target_net_pnl_per_day": str(target),
            "profit_target_oracle_policy": oracle_policy.to_payload(),
            "source_count": len(sources),
            "hypothesis_count": len(hypothesis_cards),
            "candidate_spec_count": len(candidate_specs),
            "candidate_compiler_blocker_count": len(candidate_compilation_blockers),
            "feedback_evidence_bundle_count": len(feedback_evidence_bundles),
            "pre_replay_proposal_score_count": len(pre_replay_proposal_rows),
            "replay_candidate_spec_count": len(replay_candidate_specs),
            "selected_candidate_spec_ids": selected_candidate_spec_ids,
            "claim_count": sum(len(source.claims) for source in sources),
            "oracle_candidate_found": False,
            "profit_target_oracle": {
                "status": "not_run",
                "reason": "selection_only",
                "target_met": False,
                "blockers": [
                    "real_replay_not_run",
                    "portfolio_optimizer_not_run",
                    "runtime_ledger_proof_missing",
                ],
            },
            "promotion_readiness": {
                "status": "selection_only_not_promotion_proof",
                "promotable": False,
                "blockers": [
                    "real_replay_not_run",
                    "portfolio_optimizer_not_run",
                    "runtime_ledger_proof_missing",
                    "live_paper_parity_missing",
                ],
            },
            "runtime_closure": {
                "status": "not_run",
                "reason": "selection_only",
            },
            "artifacts": {
                "epoch_manifest": str(output_dir / "epoch-manifest.json"),
                "hypothesis_cards": str(output_dir / "hypothesis-cards.jsonl"),
                "whitepaper_sources": str(output_dir / "whitepaper-sources.jsonl"),
                "candidate_specs": str(output_dir / "candidate-specs.jsonl"),
                "candidate_selection_manifest": str(
                    output_dir / "candidate-selection-manifest.json"
                ),
                "selected_candidate_specs": str(
                    output_dir / "selected-candidate-specs.jsonl"
                ),
                "pre_replay_proposal_scores": str(
                    output_dir / "pre-replay-mlx-proposal-scores.jsonl"
                ),
                "pre_replay_proposal_model": str(
                    output_dir / "pre-replay-mlx-ranker-model.json"
                ),
                "feedback_evidence_source_manifest": str(
                    output_dir / "feedback-evidence-source-manifest.json"
                ),
                "candidate_compiler_report": str(
                    output_dir / "candidate-compiler-report.json"
                ),
                "summary": str(output_dir / "summary.json"),
                "diagnostics_notebook": str(
                    output_dir / "whitepaper-autoresearch-diagnostics.ipynb"
                ),
            },
        }
        _write_json(output_dir / "summary.json", summary)
        write_whitepaper_autoresearch_diagnostics_notebook(
            output_dir / "whitepaper-autoresearch-diagnostics.ipynb",
            summary=summary,
        )
        return summary
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
        failure_reason = f"{type(exc).__name__}:{exc}"
        partial_replay_result = (
            _collect_partial_real_replay(
                output_dir=output_dir, specs=replay_candidate_specs
            )
            if args.replay_mode == "real"
            else EpochReplayResult(evidence_bundles=(), replay_results=())
        )
        partial_artifact_path = output_dir / "candidate-evidence-bundles.partial.jsonl"
        if partial_replay_result.evidence_bundles:
            _write_jsonl(
                partial_artifact_path,
                [
                    bundle.to_payload()
                    for bundle in partial_replay_result.evidence_bundles
                ],
            )
        replay_diagnostic_rows = _replay_diagnostic_proposal_rows(
            candidate_selection=candidate_selection,
            pre_replay_proposal_rows=pre_replay_proposal_rows,
        )
        false_positive_table = _false_positive_table(
            proposal_rows=replay_diagnostic_rows,
            evidence_bundles=partial_replay_result.evidence_bundles,
            oracle_policy=oracle_policy,
        )
        best_false_negative_table = _best_false_negative_table(
            candidate_selection=candidate_selection,
            pre_replay_proposal_rows=pre_replay_proposal_rows,
            evidence_bundles=partial_replay_result.evidence_bundles,
        )
        remediation = _candidate_search_remediation(
            failure_reason=failure_reason,
            candidate_selection=candidate_selection,
            evidence_bundles=partial_replay_result.evidence_bundles,
            false_positive_table=false_positive_table,
            best_false_negative_table=best_false_negative_table,
            replay_timeout_seconds=int(
                getattr(args, "real_replay_timeout_seconds", 0) or 0
            ),
            max_frontier_candidates_per_spec=int(
                getattr(
                    args,
                    "max_frontier_candidates_per_spec",
                    _DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC,
                )
                or _DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC
            ),
            current_top_k=int(getattr(args, "top_k", 16) or 16),
            current_exploration_slots=int(getattr(args, "exploration_slots", 8) or 8),
            current_portfolio_size_min=int(getattr(args, "portfolio_size_min", 2) or 2),
            current_max_candidates=int(getattr(args, "max_candidates", 64) or 64),
            current_max_total_frontier_candidates=int(
                getattr(args, "max_total_frontier_candidates", 0) or 0
            ),
            current_train_days=int(getattr(args, "train_days", 6) or 6),
            current_holdout_days=int(getattr(args, "holdout_days", 3) or 3),
            current_second_oos_days=int(getattr(args, "second_oos_days", 2) or 2),
        )
        remediation_path = output_dir / "candidate-search-remediation.json"
        _write_json(remediation_path, remediation)
        profitability_goal = _profitability_search_goal(
            args=args,
            output_dir=output_dir,
            status="replay_failed",
            status_reason=failure_reason,
            target=target,
            program=program,
            sources=sources,
            hypothesis_cards=hypothesis_cards,
            candidate_specs=candidate_specs,
            candidate_selection=candidate_selection,
            pre_replay_model=pre_replay_model,
            proposal_model=None,
            evidence_bundles=partial_replay_result.evidence_bundles,
            false_positive_table=false_positive_table,
            best_false_negative_table=best_false_negative_table,
            portfolio=None,
            oracle_candidate_found=False,
            profit_target_oracle=None,
            promotion_blockers=["replay_failed", failure_reason],
            remediation=remediation,
        )
        profitability_goal_path = output_dir / "profitability-search-goal.json"
        _write_json(profitability_goal_path, profitability_goal)
        return _write_failure_summary(
            output_dir=output_dir,
            epoch_id=epoch_id,
            status="replay_failed",
            reason=failure_reason,
            started_at=started_at,
            extra={
                "partial_evidence_bundle_count": len(
                    partial_replay_result.evidence_bundles
                ),
                "partial_replay_result_count": len(
                    partial_replay_result.replay_results
                ),
                "partial_artifacts": {
                    "candidate_evidence_bundles": str(partial_artifact_path)
                    if partial_replay_result.evidence_bundles
                    else None,
                    "strategy_factory_dir": str(output_dir / "strategy-factory"),
                },
                "false_positive_table": false_positive_table,
                "best_false_negative_table": best_false_negative_table,
                "candidate_search_remediation": remediation,
                "profitability_search_goal": profitability_goal,
                "artifacts": {
                    "candidate_search_remediation": str(remediation_path),
                    "profitability_search_goal": str(profitability_goal_path),
                    "candidate_selection_manifest": str(
                        output_dir / "candidate-selection-manifest.json"
                    ),
                    "selected_candidate_specs": str(
                        output_dir / "selected-candidate-specs.jsonl"
                    ),
                    "feedback_evidence_source_manifest": str(
                        output_dir / "feedback-evidence-source-manifest.json"
                    ),
                    "partial_candidate_evidence_bundles": str(partial_artifact_path)
                    if partial_replay_result.evidence_bundles
                    else None,
                    "summary": str(output_dir / "summary.json"),
                    "diagnostics_notebook": str(
                        output_dir / "whitepaper-autoresearch-diagnostics.ipynb"
                    ),
                },
            },
        )
    proposal_model, proposal_rows = _proposal_model_and_rows(
        specs=candidate_specs,
        evidence_bundles=replay_result.evidence_bundles,
        ranker_backend_preference=ranker_backend_preference,
        replay_selection_by_spec=selection_by_spec,
    )
    _write_json(output_dir / "mlx-ranker-model.json", proposal_model)
    _write_jsonl(output_dir / "mlx-proposal-scores.jsonl", proposal_rows)
    _write_jsonl(
        output_dir / "candidate-evidence-bundles.jsonl",
        [bundle.to_payload() for bundle in replay_result.evidence_bundles],
    )

    portfolio = optimize_portfolio_candidate(
        evidence_bundles=replay_result.evidence_bundles,
        target_net_pnl_per_day=target,
        oracle_policy=oracle_policy,
        portfolio_size_min=int(args.portfolio_size_min),
        portfolio_size_max=int(args.portfolio_size_max),
    )
    portfolio_rows = [portfolio.to_payload()] if portfolio is not None else []
    _write_jsonl(output_dir / "portfolio-candidates.jsonl", portfolio_rows)
    _write_json(
        output_dir / "portfolio-optimizer-report.json",
        portfolio.optimizer_report
        if portfolio is not None
        else {"status": "no_portfolio_candidate"},
    )
    mlx_snapshot_manifest = _epoch_mlx_snapshot_manifest(
        args=args,
        output_dir=output_dir,
        epoch_id=epoch_id,
        program=program,
        source_count=len(sources),
        hypothesis_count=len(hypothesis_cards),
        candidate_spec_count=len(candidate_specs),
        pre_replay_proposal_score_count=len(pre_replay_proposal_rows),
        replay_candidate_spec_count=len(replay_candidate_specs),
        evidence_bundle_count=len(replay_result.evidence_bundles),
        proposal_score_count=len(proposal_rows),
        portfolio_candidate_count=len(portfolio_rows),
    )
    write_mlx_snapshot_manifest(
        output_dir / "mlx-snapshot-manifest.json", mlx_snapshot_manifest
    )
    initial_oracle_candidate_found = bool(
        portfolio is not None
        and portfolio.objective_scorecard.get("oracle_passed") is True
        and not replay_result.incomplete
    )
    runtime_closure_program = _runtime_closure_program_for_candidate(
        program=program,
        manifest=mlx_snapshot_manifest,
        portfolio=portfolio,
        oracle_candidate_found=initial_oracle_candidate_found,
    )
    runtime_closure = _runtime_closure_payload(
        args=args,
        output_dir=output_dir,
        epoch_id=epoch_id,
        program=runtime_closure_program,
        manifest=mlx_snapshot_manifest,
        portfolio=portfolio,
    )
    if portfolio is not None:
        portfolio = _portfolio_with_runtime_closure_proof(
            portfolio=portfolio,
            runtime_closure=runtime_closure,
            target=target,
            oracle_policy=oracle_policy,
        )
        portfolio_rows = [portfolio.to_payload()]
        _write_jsonl(output_dir / "portfolio-candidates.jsonl", portfolio_rows)
        _write_json(
            output_dir / "portfolio-optimizer-report.json", portfolio.optimizer_report
        )

    oracle_candidate_found = bool(
        portfolio is not None
        and portfolio.objective_scorecard.get("oracle_passed") is True
        and not replay_result.incomplete
    )
    replay_failure_reasons = list(replay_result.failure_reasons)
    profit_target_oracle = (
        portfolio.objective_scorecard.get("profit_target_oracle")
        if portfolio is not None
        else None
    )
    if portfolio is None:
        promotion_status = "no_candidate"
        promotion_blockers: list[str] = []
    elif replay_result.incomplete:
        promotion_status = "blocked_pending_complete_replay"
        promotion_blockers = ["selected_replay_incomplete", *replay_failure_reasons]
    elif oracle_candidate_found:
        runtime_status = _string(runtime_closure.get("status"))
        promotion_status = runtime_status or "ready_for_promotion_review"
        promotion_blockers = [
            _string(item)
            for item in cast(
                Sequence[Any], runtime_closure.get("next_required_steps") or ()
            )
            if _string(item) and _string(item) != "promotion_review"
        ]
    else:
        runtime_next_steps = [
            _string(item)
            for item in cast(
                Sequence[Any], runtime_closure.get("next_required_steps") or ()
            )
            if _string(item)
        ]
        promotion_status = "blocked_pending_runtime_closure_or_oracle"
        promotion_blockers = list(
            dict.fromkeys(
                (
                    *sorted(_oracle_blockers(_mapping(portfolio.objective_scorecard))),
                    *runtime_next_steps,
                )
            )
        ) or [
            "scheduler_v3_parity_missing",
            "shadow_validation_missing",
        ]
    promotion_readiness = _promotion_readiness_payload(
        oracle_candidate_found=oracle_candidate_found,
        status=promotion_status,
        blockers=promotion_blockers,
        runtime_closure=runtime_closure,
    )
    status = "ok" if oracle_candidate_found else "no_profit_target_candidate"
    status_reason = None
    if not oracle_candidate_found:
        if replay_result.incomplete:
            status_reason = "selected_replay_incomplete"
        elif portfolio is None:
            status_reason = "portfolio_optimizer_produced_no_candidate"
        else:
            status_reason = "portfolio_candidate_failed_profit_target_oracle"
    false_positive_table = _false_positive_table(
        proposal_rows=proposal_rows,
        evidence_bundles=replay_result.evidence_bundles,
        oracle_policy=oracle_policy,
    )
    best_false_negative_table = _best_false_negative_table(
        candidate_selection=candidate_selection,
        pre_replay_proposal_rows=pre_replay_proposal_rows,
        evidence_bundles=replay_result.evidence_bundles,
    )
    candidate_search_remediation: dict[str, Any] | None = None
    remediation_path = output_dir / "candidate-search-remediation.json"
    if not oracle_candidate_found:
        candidate_search_remediation = _candidate_search_remediation(
            failure_reason=status_reason or status,
            candidate_selection=candidate_selection,
            evidence_bundles=replay_result.evidence_bundles,
            false_positive_table=false_positive_table,
            best_false_negative_table=best_false_negative_table,
            replay_timeout_seconds=int(
                getattr(args, "real_replay_timeout_seconds", 0) or 0
            ),
            max_frontier_candidates_per_spec=int(
                getattr(
                    args,
                    "max_frontier_candidates_per_spec",
                    _DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC,
                )
                or _DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC
            ),
            current_top_k=int(getattr(args, "top_k", 16) or 16),
            current_exploration_slots=int(getattr(args, "exploration_slots", 8) or 8),
            current_portfolio_size_min=int(getattr(args, "portfolio_size_min", 2) or 2),
            current_max_candidates=int(getattr(args, "max_candidates", 64) or 64),
            current_max_total_frontier_candidates=int(
                getattr(args, "max_total_frontier_candidates", 0) or 0
            ),
            current_train_days=int(getattr(args, "train_days", 6) or 6),
            current_holdout_days=int(getattr(args, "holdout_days", 3) or 3),
            current_second_oos_days=int(getattr(args, "second_oos_days", 2) or 2),
        )
        _write_json(remediation_path, candidate_search_remediation)
    candidate_board = _candidate_board_payload(
        epoch_id=epoch_id,
        output_dir=output_dir,
        target=target,
        candidate_specs=candidate_specs,
        candidate_selection=candidate_selection,
        pre_replay_proposal_rows=pre_replay_proposal_rows,
        proposal_rows=proposal_rows,
        evidence_bundles=replay_result.evidence_bundles,
        portfolio=portfolio,
        promotion_readiness=promotion_readiness,
        runtime_closure=runtime_closure,
        paper_probation_target_limit=program.replay_budget.exploration_slots,
    )
    candidate_board_path = output_dir / "candidate-board.json"
    _write_json(candidate_board_path, candidate_board)
    paper_probation_handoff = _paper_probation_handoff_payload(candidate_board)
    paper_probation_handoff_path = output_dir / "paper-probation-handoff.json"
    _write_json(paper_probation_handoff_path, paper_probation_handoff)
    profitability_goal = _profitability_search_goal(
        args=args,
        output_dir=output_dir,
        status=status,
        status_reason=status_reason,
        target=target,
        program=program,
        sources=sources,
        hypothesis_cards=hypothesis_cards,
        candidate_specs=candidate_specs,
        candidate_selection=candidate_selection,
        pre_replay_model=pre_replay_model,
        proposal_model=proposal_model,
        evidence_bundles=replay_result.evidence_bundles,
        false_positive_table=false_positive_table,
        best_false_negative_table=best_false_negative_table,
        portfolio=portfolio,
        oracle_candidate_found=oracle_candidate_found,
        profit_target_oracle=cast(Mapping[str, Any], profit_target_oracle)
        if isinstance(profit_target_oracle, Mapping)
        else None,
        promotion_blockers=promotion_blockers,
        remediation=candidate_search_remediation,
    )
    profitability_goal_path = output_dir / "profitability-search-goal.json"
    _write_json(profitability_goal_path, profitability_goal)
    summary = {
        "status": status,
        "status_reason": status_reason,
        "epoch_id": epoch_id,
        "run_root": str(output_dir),
        "target_net_pnl_per_day": str(target),
        "profit_target_oracle_policy": oracle_policy.to_payload(),
        "source_count": len(sources),
        "hypothesis_count": len(hypothesis_cards),
        "candidate_spec_count": len(candidate_specs),
        "candidate_compiler_blocker_count": len(candidate_compilation_blockers),
        "evidence_bundle_count": len(replay_result.evidence_bundles),
        "candidate_evidence_bundle_payloads": _evidence_bundle_payloads_for_epoch_summary(
            replay_result.evidence_bundles
        ),
        "candidate_evidence_bundle_payload_count": min(
            len(replay_result.evidence_bundles),
            _MAX_PERSISTED_FEEDBACK_EVIDENCE_BUNDLES,
        ),
        "replay_candidate_spec_count": len(replay_candidate_specs),
        "selected_candidate_spec_ids": [
            spec.candidate_spec_id for spec in replay_candidate_specs
        ],
        "replay_incomplete": replay_result.incomplete,
        "replay_failure_reasons": replay_failure_reasons,
        "replay_tape_materialization": materialized_replay_tape_receipt,
        "pre_replay_proposal_score_count": len(pre_replay_proposal_rows),
        "proposal_score_count": len(proposal_rows),
        "portfolio_candidate_count": len(portfolio_rows),
        "claim_count": sum(len(source.claims) for source in sources),
        "mlx_rank_bucket_lift": proposal_model.get("rank_bucket_lift", {}),
        "false_positive_table": false_positive_table,
        "best_false_negative_table": best_false_negative_table,
        "candidate_board": candidate_board,
        "paper_probation_handoff": paper_probation_handoff,
        "candidate_search_remediation": candidate_search_remediation,
        "profitability_search_goal": profitability_goal,
        "best_portfolio_candidate": portfolio.to_payload()
        if portfolio is not None
        else None,
        "oracle_candidate_found": oracle_candidate_found,
        "profit_target_oracle": profit_target_oracle,
        "promotion_readiness": promotion_readiness,
        "runtime_closure": runtime_closure,
        "artifacts": {
            "epoch_manifest": str(output_dir / "epoch-manifest.json"),
            "hypothesis_cards": str(output_dir / "hypothesis-cards.jsonl"),
            "whitepaper_sources": str(output_dir / "whitepaper-sources.jsonl"),
            "candidate_specs": str(output_dir / "candidate-specs.jsonl"),
            "candidate_selection_manifest": str(
                output_dir / "candidate-selection-manifest.json"
            ),
            "selected_candidate_specs": str(
                output_dir / "selected-candidate-specs.jsonl"
            ),
            "pre_replay_proposal_scores": str(
                output_dir / "pre-replay-mlx-proposal-scores.jsonl"
            ),
            "pre_replay_proposal_model": str(
                output_dir / "pre-replay-mlx-ranker-model.json"
            ),
            "feedback_evidence_source_manifest": str(
                output_dir / "feedback-evidence-source-manifest.json"
            ),
            "mlx_snapshot_manifest": str(output_dir / "mlx-snapshot-manifest.json"),
            "candidate_compiler_report": str(
                output_dir / "candidate-compiler-report.json"
            ),
            "proposal_scores": str(output_dir / "mlx-proposal-scores.jsonl"),
            "proposal_model": str(output_dir / "mlx-ranker-model.json"),
            "candidate_evidence_bundles": str(
                output_dir / "candidate-evidence-bundles.jsonl"
            ),
            "portfolio_candidates": str(output_dir / "portfolio-candidates.jsonl"),
            "portfolio_optimizer_report": str(
                output_dir / "portfolio-optimizer-report.json"
            ),
            "candidate_board": str(candidate_board_path),
            "paper_probation_handoff": str(paper_probation_handoff_path),
            "candidate_search_remediation": str(remediation_path)
            if candidate_search_remediation is not None
            else None,
            "profitability_search_goal": str(profitability_goal_path),
            "replay_tape": (
                materialized_replay_tape_receipt.get("tape_path")
                if materialized_replay_tape_receipt is not None
                else None
            ),
            "replay_tape_manifest": (
                materialized_replay_tape_receipt.get("manifest_path")
                if materialized_replay_tape_receipt is not None
                else None
            ),
            "replay_tape_receipt": (
                materialized_replay_tape_receipt.get("receipt_path")
                if materialized_replay_tape_receipt is not None
                else None
            ),
            "summary": str(output_dir / "summary.json"),
            "diagnostics_notebook": str(
                output_dir / "whitepaper-autoresearch-diagnostics.ipynb"
            ),
        },
    }
    _write_json(output_dir / "summary.json", summary)
    write_whitepaper_autoresearch_diagnostics_notebook(
        output_dir / "whitepaper-autoresearch-diagnostics.ipynb",
        summary=summary,
    )
    if args.persist_results:
        runner_config = {
            "replay_mode": args.replay_mode,
            "max_candidates": int(args.max_candidates),
            "top_k": int(args.top_k),
            "exploration_slots": int(args.exploration_slots),
            "feedback_block_reaudit_slots": int(
                getattr(args, "feedback_block_reaudit_slots", 0) or 0
            ),
            "replay_candidate_spec_count": len(replay_candidate_specs),
            "replay_incomplete": replay_result.incomplete,
            "replay_failure_reasons": replay_failure_reasons,
            "portfolio_size_min": int(args.portfolio_size_min),
            "portfolio_size_max": int(args.portfolio_size_max),
            "real_replay_shard_size": int(
                getattr(args, "real_replay_shard_size", 0) or 0
            ),
            "real_replay_shard_timeout_seconds": int(
                _bounded_real_replay_shard_timeout_seconds(
                    getattr(
                        args,
                        "real_replay_shard_timeout_seconds",
                        _DEFAULT_REAL_REPLAY_SHARD_TIMEOUT_SECONDS,
                    )
                )
            ),
            "real_replay_shard_workers": int(
                getattr(
                    args,
                    "real_replay_shard_workers",
                    _DEFAULT_REAL_REPLAY_SHARD_WORKERS,
                )
                or _DEFAULT_REAL_REPLAY_SHARD_WORKERS
            ),
            "real_replay_max_parallel_frontier_candidates": int(
                getattr(
                    args,
                    "real_replay_max_parallel_frontier_candidates",
                    _DEFAULT_REAL_REPLAY_MAX_PARALLEL_FRONTIER_CANDIDATES,
                )
                or _DEFAULT_REAL_REPLAY_MAX_PARALLEL_FRONTIER_CANDIDATES
            ),
            "real_replay_failed_spec_retries": int(
                getattr(args, "real_replay_failed_spec_retries", 1) or 0
            ),
            "real_replay_retry_timeout_seconds": int(
                getattr(args, "real_replay_retry_timeout_seconds", 0) or 0
            ),
            "real_replay_retry_max_frontier_candidates_per_spec": int(
                getattr(args, "real_replay_retry_max_frontier_candidates_per_spec", 1)
                or 1
            ),
            "replay_tape_preview_top_k": int(
                getattr(args, "replay_tape_preview_top_k", 0) or 0
            ),
            "replay_tape_preview_min_rows": int(
                getattr(args, "replay_tape_preview_min_rows", 2) or 2
            ),
            "materialize_replay_tape": bool(
                getattr(args, "materialize_replay_tape", False)
            ),
            "replay_tape_path": str(getattr(args, "replay_tape_path", "") or ""),
            "replay_tape_manifest": str(
                getattr(args, "replay_tape_manifest", "") or ""
            ),
            "source_jsonl": [str(path) for path in getattr(args, "source_jsonl", [])],
        }
        try:
            _persist_epoch_ledgers(
                epoch_id=epoch_id,
                status=status,
                target_net_pnl_per_day=target,
                paper_run_ids=[str(item) for item in args.paper_run_id],
                sources=sources,
                candidate_specs=candidate_specs,
                candidate_blockers=blocker_by_spec,
                proposal_rows=proposal_rows,
                portfolio=portfolio,
                summary=summary,
                runner_config=runner_config,
                started_at=started_at,
                completed_at=datetime.now(UTC),
            )
            summary["persistence_status"] = "persisted"
            _write_json(output_dir / "summary.json", summary)
        except Exception as exc:
            summary["pre_persistence_status"] = status
            summary["status"] = "persistence_failed"
            summary["status_reason"] = "epoch_ledger_persistence_failed"
            summary["persistence_status"] = "failed"
            summary["persistence_error"] = str(exc)
            summary["persistence_runner_config"] = runner_config
            _write_json(output_dir / "persistence-error-summary.json", summary)
            _write_json(output_dir / "error-summary.json", summary)
            _write_json(output_dir / "summary.json", summary)
            write_whitepaper_autoresearch_diagnostics_notebook(
                output_dir / "whitepaper-autoresearch-diagnostics.ipynb",
                summary=summary,
            )
    return summary


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

__all__ = [
    "Any",
    "AutoresearchCandidateSpec",
    "AutoresearchEpoch",
    "AutoresearchPortfolioCandidate",
    "AutoresearchProposalScore",
    "CandidateCompilationBlocker",
    "CandidateEvidenceBundle",
    "CandidateSpec",
    "Decimal",
    "EpochReplayResult",
    "FAST_REPLAY_PROOF_SEMANTICS_LABEL",
    "FAST_REPLAY_WHITEPAPER_MECHANISMS",
    "HypothesisCard",
    "LIVE_SIGNAL_COVERED_SEMICONDUCTOR_UNIVERSE",
    "Mapping",
    "MlxSnapshotManifest",
    "POST_COST_PNL_BASIS",
    "Path",
    "PortfolioCandidateSpec",
    "ProcessPoolExecutor",
    "ProfitTargetOraclePolicy",
    "RECENT_WHITEPAPER_SEEDS",
    "RejectedSignalOutcomeEvent",
    "ReplayTapeManifest",
    "ResearchClaim",
    "ResearchSource",
    "RuntimeClosureExecutionContext",
    "RuntimeLedgerBucket",
    "Sequence",
    "SessionLocal",
    "StrategyAutoresearchProgram",
    "UTC",
    "VNextExperimentSpec",
    "WhitepaperAnalysisRun",
    "WhitepaperResearchSource",
    "ZoneInfo",
    "_CANDIDATE_BOARD_RUNTIME_SESSION_CLOSE",
    "_CANDIDATE_BOARD_RUNTIME_SESSION_OPEN",
    "_CANDIDATE_BOARD_RUNTIME_SESSION_TZ",
    "_CODE_COMMIT_ENV_VARS",
    "_DEFAULT_CHIP_UNIVERSE_CSV",
    "_DEFAULT_CLICKHOUSE_HTTP_URL",
    "_DEFAULT_DAILY_PROFIT_TARGET",
    "_DEFAULT_FAST_REPLAY_EXACT_CANDIDATE_CAP",
    "_DEFAULT_FAST_REPLAY_EXPLOITATION_SLOTS",
    "_DEFAULT_FAST_REPLAY_EXPLORATION_SLOTS",
    "_DEFAULT_FAST_REPLAY_PREVIEW_TOP_K",
    "_DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC",
    "_DEFAULT_PORTFOLIO_PROFIT_PROGRAM",
    "_DEFAULT_RANKER_BACKEND_PREFERENCE",
    "_DEFAULT_REAL_REPLAY_MAX_PARALLEL_FRONTIER_CANDIDATES",
    "_DEFAULT_REAL_REPLAY_SHARD_TIMEOUT_SECONDS",
    "_DEFAULT_REAL_REPLAY_SHARD_WORKERS",
    "_EXACT_REPLAY_LEDGER_ARTIFACT_KIND",
    "_EXACT_REPLAY_LEDGER_SCHEMA_VERSIONS",
    "_EXACT_REPLAY_RUNTIME_LEDGER_PNL_SOURCE",
    "_FAMILY_PRIOR_HARD_BLOCK_ORACLE_BLOCKERS",
    "_LOSS_ADAPTIVE_FEEDBACK_REMEDIATION_PROFILES",
    "_MAX_PERSISTED_FEEDBACK_EVIDENCE_BUNDLES",
    "_MAX_PERSISTED_FEEDBACK_EVIDENCE_EPOCHS",
    "_PAPER_EVIDENCE_REQUIREMENT_PRIOR_WEIGHTS",
    "_PAPER_MECHANISM_PRIOR_SCORE_CAP",
    "_PAPER_MECHANISM_PRIOR_WEIGHTS",
    "_PAPER_PROBATION_LIVE_PAPER_EVIDENCE_REQUIREMENTS",
    "_PAPER_PROBATION_SAFE_EVIDENCE_COLLECTION_PATH",
    "_PORTFOLIO_FEEDBACK_STATUSES",
    "_PRE_REPLAY_FEEDBACK_BLOCK_REASONS",
    "_PRE_REPLAY_SELECTION_BLOCK_REASONS",
    "_PROGRAM_SOURCE_DEFAULT_CONFIDENCE",
    "_RANKER_BACKEND_CHOICES",
    "_REJECTED_SIGNAL_OUTCOME_REQUIRED_FIELDS",
    "_REPLAY_ACTIVITY_COUNT_KEYS",
    "_RISK_PROFILE_FEEDBACK_ORACLE_BLOCKERS",
    "_RUNTIME_CLOSURE_PROOF_ORACLE_BLOCKERS",
    "_ReplayShardOutcome",
    "_ReplayShardPlan",
    "_SECOND_OOS_WINDOW_ID",
    "_UNSAFE_NEXT_EPOCH_REMEDIATION_FLAG_MARKERS",
    "_active_loss_counter_proposal_score",
    "_apply_fast_replay_preview_narrowing",
    "_auto_materialize_staged_replay_tape",
    "_best_false_negative_table",
    "_boolish",
    "_bounded_real_replay_shard_timeout_seconds",
    "_bounded_real_replay_shard_workers",
    "_bounded_sim_target_queue_metadata",
    "_build_real_replay_shards",
    "_candidate_board_activity_count",
    "_candidate_board_best_executed_candidate",
    "_candidate_board_blockers",
    "_candidate_board_closest_promotion_candidate",
    "_candidate_board_date_only",
    "_candidate_board_decimal_field",
    "_candidate_board_double_oos_summary",
    "_candidate_board_evidence_lineage_summary",
    "_candidate_board_exact_replay_ledger_refs",
    "_candidate_board_factor_acceptance_summary",
    "_candidate_board_first_int_field",
    "_candidate_board_hypothesis_manifest_ref",
    "_candidate_board_int_field",
    "_candidate_board_lower_bound_net_pnl",
    "_candidate_board_market_impact_proof_summary",
    "_candidate_board_net_pnl",
    "_candidate_board_oracle_blocker_count",
    "_candidate_board_order_type_execution_quality_summary",
    "_candidate_board_paper_probation_admission_blockers",
    "_candidate_board_paper_probation_candidate",
    "_candidate_board_paper_probation_candidates",
    "_candidate_board_payload",
    "_candidate_board_portfolio_promotion_subject",
    "_candidate_board_predictability_decay_summary",
    "_candidate_board_queue_position_survival_summary",
    "_candidate_board_regime_specialist_summary",
    "_candidate_board_regular_session_bound",
    "_candidate_board_rejected_signal_outcome_summary",
    "_candidate_board_replay_window_coverage_summary",
    "_candidate_board_required_notional_repair_scale",
    "_candidate_board_runtime_import_args",
    "_candidate_board_runtime_ledger_lineage_handoff",
    "_candidate_board_runtime_ledger_required_materialized_artifacts",
    "_candidate_board_runtime_window_bounds",
    "_candidate_board_runtime_window_import_bounds",
    "_candidate_board_runtime_window_import_plan",
    "_candidate_board_score_rows",
    "_candidate_board_scorecard_with_evidence_blockers",
    "_candidate_board_scorecard_with_lineage_blockers",
    "_candidate_board_scorecard_with_order_type_blockers",
    "_candidate_board_scorecard_with_predictability_decay_blockers",
    "_candidate_board_scorecard_with_queue_position_survival_blockers",
    "_candidate_board_scorecard_with_rejected_signal_blockers",
    "_candidate_board_scorecard_with_replay_window_blockers",
    "_candidate_board_status",
    "_candidate_board_status_digest",
    "_candidate_board_target_progress_ratio",
    "_candidate_factor_acceptance_replay_metadata",
    "_candidate_family_goal_rows",
    "_candidate_payload_with_feedback_metadata",
    "_candidate_quality_gate_failures",
    "_candidate_search_remediation",
    "_candidate_selection_for_direct_replay",
    "_candidate_sleeve_goal_proof_handoff_fields",
    "_candidate_sleeve_goal_rows",
    "_candidate_spec_active_loss_counter_tags",
    "_candidate_spec_execution_profile",
    "_candidate_spec_execution_signature",
    "_candidate_spec_feedback_metadata",
    "_candidate_spec_feedback_risk_profile_key",
    "_candidate_spec_feedback_shape_key",
    "_candidate_spec_from_payload",
    "_candidate_spec_id_from_experiment_result_path",
    "_candidate_spec_is_false_negative_rescue",
    "_candidate_spec_is_loss_adaptive_feedback_escape",
    "_candidate_spec_matches_active_loss_counter_feedback",
    "_candidate_spec_matches_consistency_repair_feedback",
    "_candidate_spec_mechanism_overlay_ids",
    "_candidate_spec_required_evidence_tokens",
    "_candidate_spec_requires_order_type_execution_quality",
    "_candidate_spec_requires_predictability_decay_stress",
    "_candidate_spec_requires_queue_position_survival",
    "_candidate_spec_requires_rejected_signal_outcome_learning",
    "_candidate_spec_signal_key",
    "_candidate_spec_universe_key",
    "_candidate_spec_with_oracle_policy",
    "_candidate_specs_with_oracle_policy",
    "_candidate_universe_symbols_for_compilation",
    "_candidate_universe_symbols_from_args",
    "_clickhouse_endpoint_preflight_failure",
    "_clickhouse_host_requires_dns_preflight",
    "_collect_partial_real_replay",
    "_consistency_repair_proposal_score",
    "_current_code_commit",
    "_decimal",
    "_decimal_arg_or_default",
    "_decimal_payload",
    "_dedupe_feedback_evidence_bundles",
    "_dedupe_replay_evidence",
    "_dedupe_whitepaper_sources",
    "_default_clickhouse_http_url",
    "_default_strategy_config_path",
    "_epoch_mlx_snapshot_manifest",
    "_evidence_bundle_payloads_for_epoch_summary",
    "_evidenced_spec_ids",
    "_execute_real_replay_shard",
    "_execution_signature_feedback_bundle_for_spec",
    "_failed_shard_spec_ids",
    "_false_positive_table",
    "_family_feedback_bundle_for_spec",
    "_fast_replay_discovery_stage_semantics",
    "_fast_replay_exact_handoff_lineage",
    "_fast_replay_preview_date_arg",
    "_fast_replay_preview_proof_semantics",
    "_fast_replay_queue_stage_metadata",
    "_feedback_active_loss_counter_candidate_reasons",
    "_feedback_bundle_sort_value",
    "_feedback_consistency_repair_candidate_reasons",
    "_feedback_daily_net_has_loss",
    "_feedback_execution_signature",
    "_feedback_family_prior_has_hard_block",
    "_feedback_family_template_id",
    "_feedback_has_no_replay_activity",
    "_feedback_has_nonpositive_expected_value",
    "_feedback_has_policy_penalty",
    "_feedback_is_blocked",
    "_feedback_risk_profile_has_penalty",
    "_feedback_risk_profile_has_terminal_block",
    "_feedback_risk_profile_key",
    "_feedback_risk_profile_key_from_scorecard",
    "_feedback_risk_profile_key_payload",
    "_feedback_scorecard_has_hard_veto",
    "_feedback_shape_key",
    "_flag_int",
    "_int_arg",
    "_list_of_mappings",
    "_load_autoresearch_feedback_evidence_bundles",
    "_load_candidate_specs_jsonl",
    "_load_epoch_program",
    "_load_feedback_evidence_bundles",
    "_load_json_mapping_artifact",
    "_load_recent_persisted_feedback_evidence_bundles",
    "_load_sources_from_db",
    "_mapping",
    "_market_impact_default_source_markers",
    "_materialized_replay_tape_cost_model_hash",
    "_materialized_replay_tape_date_arg",
    "_materialized_replay_tape_feature_schema_hash",
    "_materialized_replay_tape_source_query_digest",
    "_materialized_replay_tape_strategy_family",
    "_maybe_materialize_epoch_replay_tape",
    "_maybe_preflight_materialized_replay_tape_window",
    "_oracle_blockers",
    "_oracle_policy_from_args",
    "_ordered_unique_strings",
    "_outcome_payload_has_complete_rejected_signal_fields",
    "_paper_mechanism_prior_score",
    "_paper_probation_candidate_payload",
    "_paper_probation_handoff_payload",
    "_parse_args",
    "_persist_epoch_ledgers",
    "_persist_vnext_specs",
    "_portfolio_candidate_feedback_blockers",
    "_portfolio_candidate_row_to_feedback_bundles",
    "_portfolio_executable_max_notional",
    "_portfolio_needs_runtime_closure_proof",
    "_portfolio_sleeve_feedback_metadata",
    "_portfolio_with_runtime_closure_proof",
    "_pre_replay_candidate_score",
    "_pre_replay_prior_bundle",
    "_pre_replay_proposal_model_and_rows",
    "_profitability_next_epoch_flags",
    "_profitability_next_epoch_plan",
    "_profitability_search_goal",
    "_profitability_system_change_backlog",
    "_program_claim_type",
    "_program_research_source_to_whitepaper_source",
    "_program_whitepaper_sources",
    "_promotion_readiness_payload",
    "_proposal_model_and_rows",
    "_proposal_score_confidence",
    "_proposal_sort_value",
    "_rank_sort_value",
    "_ranker_backend_preference",
    "_real_replay_result_from_factory_payload",
    "_real_replay_worker",
    "_recent_trading_days_shortfall",
    "_rejected_signal_outcome_payload_to_feedback_bundle",
    "_replay_diagnostic_proposal_rows",
    "_replay_shard_frontier_candidate_budget",
    "_resolve_existing_path",
    "_resolved_clickhouse_password",
    "_resolved_fast_replay_exact_candidate_cap",
    "_resolved_fast_replay_preview_top_k",
    "_resolved_program_family_int_arg",
    "_resolved_real_replay_frontier_controls",
    "_resolved_staged_train_screen_multiplier",
    "_retry_real_replay_failed_shard_specs",
    "_risk_adjusted_drawdown_passes",
    "_risk_profile_feedback_bundle_for_spec",
    "_run_real_replay",
    "_run_real_replay_once_in_child_process",
    "_run_real_replay_once_with_optional_timeout",
    "_run_real_replay_shards",
    "_run_replay_with_optional_timeout",
    "_run_synthetic_replay",
    "_runtime_closure_artifact_refs",
    "_runtime_closure_delay_adjusted_depth_stress_update",
    "_runtime_closure_double_oos_update",
    "_runtime_closure_exact_replay_bucket",
    "_runtime_closure_exact_replay_bucket_range",
    "_runtime_closure_exact_replay_ledger_update",
    "_runtime_closure_ledger_datetime",
    "_runtime_closure_market_impact_stress_update",
    "_runtime_closure_payload",
    "_runtime_closure_pending_promotion_steps",
    "_runtime_closure_program_for_candidate",
    "_runtime_closure_promotion_prerequisite_blockers",
    "_runtime_closure_replay_bucket_has_authority",
    "_runtime_closure_scorecard_update",
    "_runtime_closure_start_equity",
    "_runtime_report_int",
    "_runtime_report_source_markers",
    "_runtime_report_summary_int",
    "_scorecard_is_false_negative_rescue_feedback",
    "_scorecard_profit_factor",
    "_scorecard_start_equity",
    "_scorecard_total_net_pnl",
    "_select_candidate_specs_for_replay",
    "_selected_candidate_spec_ids",
    "_selection_reason_blocks_replay",
    "_sequence_of_mappings",
    "_shape_feedback_bundle_for_spec",
    "_stable_hash",
    "_stale_tape_diagnostics",
    "_string",
    "_string_list_from_value",
    "_summary_scorecard_feedback_bundles_for_epoch",
    "_synthetic_candidate_payload",
    "_synthetic_net_for_spec",
    "_synthetic_symbol_contribution_shares",
    "_terminate_process",
    "_unsafe_next_epoch_remediation_flag",
    "_write_failure_summary",
    "_write_json",
    "_write_jsonl",
    "argparse",
    "as_completed",
    "build_factor_acceptance_artifact_from_scorecard",
    "build_fast_replay_preview",
    "build_mlx_snapshot_manifest",
    "build_mlx_training_rows",
    "build_runtime_ledger_buckets",
    "build_source_query_digest",
    "candidate_spec_capital_features",
    "candidate_spec_from_payload",
    "candidate_spec_id_for_payload",
    "capital_budget_penalty",
    "cast",
    "compile_sources_to_hypothesis_cards",
    "compile_whitepaper_candidate_specs",
    "dataclass",
    "date",
    "datetime",
    "deployable_lower_bound_missing_count",
    "deployable_lower_bound_net_pnl_per_day",
    "deployable_proof_failed_gate_count",
    "evaluate_profit_target_oracle",
    "evidence_bundle_blockers",
    "evidence_bundle_from_frontier_candidate",
    "evidence_bundle_from_payload",
    "hashlib",
    "json",
    "load_replay_tape",
    "load_strategy_autoresearch_program",
    "main",
    "materialize_signal_tape",
    "monotonic_time",
    "multiprocessing",
    "optimize_portfolio_candidate",
    "os",
    "queue",
    "rank_training_rows",
    "rank_training_rows_with_lift_policy",
    "replace",
    "replay_materializer",
    "replay_mod",
    "run_id",
    "run_whitepaper_autoresearch_profit_target",
    "select",
    "signal",
    "slice_tape_by_symbols",
    "slice_tape_by_window",
    "socket",
    "sources_from_jsonl",
    "strategy_factory_runner",
    "subprocess",
    "time",
    "timedelta",
    "train_mlx_ranker",
    "urlparse",
    "validate_tape_freshness",
    "write_mlx_snapshot_manifest",
    "write_runtime_closure_bundle",
    "write_whitepaper_autoresearch_diagnostics_notebook",
]
