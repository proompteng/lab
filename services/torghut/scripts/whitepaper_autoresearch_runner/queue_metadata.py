#!/usr/bin/env python3
"""Run a whitepaper-driven autoresearch epoch targeting a portfolio profit objective."""

from __future__ import annotations

import argparse
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping, Sequence, cast


from app.trading.discovery.fast_replay import (
    FAST_REPLAY_PROOF_SEMANTICS_LABEL,
    FAST_REPLAY_WHITEPAPER_MECHANISMS,
)
from app.trading.runtime_ledger import (
    POST_COST_PNL_BASIS,
)
from app.trading.discovery.replay_tape import (
    ReplayTapeManifest,
    build_source_query_digest,
    materialize_signal_tape,
)

import scripts.local_intraday_tsmom_replay as replay_mod
import scripts.materialize_replay_tape as replay_materializer

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

from scripts.whitepaper_autoresearch_runner.artifact_io import (
    _candidate_universe_symbols_from_args,
    _write_json,
)

_DEFAULT_REAL_REPLAY_SHARD_TIMEOUT_SECONDS = 900

_DEFAULT_REAL_REPLAY_SHARD_WORKERS = 2

_DEFAULT_REAL_REPLAY_MAX_PARALLEL_FRONTIER_CANDIDATES = 6

_DEFAULT_FAST_REPLAY_EXACT_CANDIDATE_CAP = 6


def _fast_replay_preview_proof_semantics() -> dict[str, Any]:
    return {
        "schema_version": "torghut.fast-replay-proof-semantics.v1",
        "label": FAST_REPLAY_PROOF_SEMANTICS_LABEL,
        "promotion_proof": False,
        "proof_authority": False,
        "promotion_authority": False,
        "promotion_allowed": False,
        "final_promotion_allowed": False,
        "final_authority_ok": False,
        "authority": "preview_prefilter_only",
        "prefilter_only": True,
        "no_kubernetes_fanout": True,
        "default_local_worker_cap": _DEFAULT_REAL_REPLAY_SHARD_WORKERS,
        "default_shard_timeout_seconds": _DEFAULT_REAL_REPLAY_SHARD_TIMEOUT_SECONDS,
        "default_parallel_frontier_candidate_cap": (
            _DEFAULT_REAL_REPLAY_MAX_PARALLEL_FRONTIER_CANDIDATES
        ),
        "safe_exact_replay_candidate_cap": _DEFAULT_FAST_REPLAY_EXACT_CANDIDATE_CAP,
        "ranking_authority_boundary": {
            "preview_rank_score_field": "preview_rank_score",
            "ranking_only_reasons_field": "ranking_only_reasons",
            "risk_veto_reasons_field": "risk_veto_reasons",
            "exact_replay_required": True,
            "runtime_ledger_required": True,
            "promotion_allowed": False,
            "ranking_output_can_authorize_promotion": False,
        },
        "final_promotion_requires": [
            "exact_replay_evidence",
            "source_backed_runtime_ledger",
            "live_paper_runtime_evidence",
            "adaptive_signal_falsification_if_adaptive_factor_or_signal_source",
            "unchanged_promotion_gates",
        ],
        "whitepaper_gpu_fast_replay_policy": (
            "whitepaper-derived fast/GPU preview signals rank candidates only and cannot unlock final promotion"
        ),
    }


def _fast_replay_discovery_stage_semantics() -> dict[str, Any]:
    return {
        "schema_version": "torghut.hpairs-discovery-stage-semantics.v1",
        "preview_only_status": "preview_only_ranked",
        "exact_replay_qualified_status": "exact_replay_qualified_frontier",
        "evidence_collection_candidate_status": (
            "bounded_sim_evidence_collection_candidate"
        ),
        "authority": "candidate_discovery_only",
        "preview_output_can_authorize_promotion": False,
        "exact_replay_frontier_can_authorize_promotion": False,
        "requires_runtime_ledger_for_promotion": True,
        "requires_live_paper_evidence_for_final_promotion": True,
        "promotion_allowed": False,
        "final_promotion_allowed": False,
        "final_authority_ok": False,
    }


def _fast_replay_queue_stage_metadata(
    *,
    frontier_bucket: str,
    exact_replay_selection_blocked: bool,
    exact_replay_selection_blockers: Sequence[Any],
) -> dict[str, Any]:
    exact_replay_qualified = not exact_replay_selection_blocked
    return {
        "schema_version": "torghut.hpairs-discovery-stage-metadata.v1",
        "preview_status": "preview_only_ranked",
        "preview_only": True,
        "exact_replay_status": (
            "exact_replay_qualified_frontier"
            if exact_replay_qualified
            else "not_exact_replay_qualified"
        ),
        "exact_replay_qualified": exact_replay_qualified,
        "evidence_collection_status": (
            "bounded_sim_evidence_collection_candidate"
            if exact_replay_qualified
            else "not_evidence_collection_candidate"
        ),
        "evidence_collection_candidate": exact_replay_qualified,
        "selected_for_bounded_frontier": True,
        "frontier_bucket": frontier_bucket,
        "blockers": list(exact_replay_selection_blockers),
        "authority": "candidate_discovery_only",
        "resource_scope": "local_offline_bounded_queue_metadata_only",
        "promotion_proof": False,
        "proof_authority": False,
        "promotion_authority": False,
        "promotion_allowed": False,
        "final_promotion_allowed": False,
        "final_authority_ok": False,
    }


def _bounded_sim_target_queue_metadata(
    *,
    preview_rows: Sequence[Mapping[str, Any]],
    replay_tape_manifest: ReplayTapeManifest,
    exact_replay_candidate_cap: int,
    exploitation_slots: int,
    exploration_slots: int,
) -> dict[str, Any]:
    selected_preview_rows = [
        dict(row) for row in preview_rows if bool(row.get("selected"))
    ]
    selected_rows: list[dict[str, Any]] = []
    duplicate_filtered_candidate_spec_ids: list[str] = []
    seen_frontier_keys: set[str] = set()
    for row in selected_preview_rows:
        frontier_key = (
            _string(row.get("exact_replay_frontier_key"))
            or _string(row.get("candidate_frontier_hash"))
            or _string(row.get("candidate_spec_id"))
        )
        if frontier_key in seen_frontier_keys:
            duplicate_filtered_candidate_spec_ids.append(
                _string(row.get("candidate_spec_id"))
            )
            continue
        seen_frontier_keys.add(frontier_key)
        selected_rows.append(row)
        if len(selected_rows) >= exact_replay_candidate_cap:
            break
    entries: list[dict[str, Any]] = []
    for index, row in enumerate(selected_rows, start=1):
        candidate_spec_id = _string(row.get("candidate_spec_id"))
        frontier_bucket = _string(row.get("frontier_bucket"))
        exact_replay_selection_blockers = list(
            cast(
                Sequence[Any],
                row.get("exact_replay_selection_blockers") or (),
            )
        )
        stage_metadata = _fast_replay_queue_stage_metadata(
            frontier_bucket=frontier_bucket,
            exact_replay_selection_blocked=bool(
                row.get("exact_replay_selection_blocked")
            ),
            exact_replay_selection_blockers=exact_replay_selection_blockers,
        )
        handoff_lineage = _fast_replay_exact_handoff_lineage(
            row=row,
            replay_tape_manifest=replay_tape_manifest,
            queue_priority=index,
            candidate_spec_id=candidate_spec_id,
            frontier_bucket=frontier_bucket,
            stage_metadata=stage_metadata,
        )
        handoff_lineage_hash = _string(handoff_lineage.get("lineage_hash"))
        entries.append(
            {
                "queue_priority": index,
                "candidate_spec_id": candidate_spec_id,
                "frontier_bucket": frontier_bucket,
                "discovery_stage_metadata": stage_metadata,
                "candidate_frontier_hash": row.get("candidate_frontier_hash"),
                "exact_replay_frontier_key": row.get("exact_replay_frontier_key"),
                "frontier_dedupe_status": row.get("frontier_dedupe_status"),
                "frontier_dedupe_metadata": row.get("frontier_dedupe_metadata"),
                "preview_rank": row.get("rank"),
                "preview_score": row.get("preview_score"),
                "preview_rank_score": row.get("preview_rank_score")
                or row.get("preview_score"),
                "ranking_only_reasons": list(
                    cast(Sequence[Any], row.get("ranking_only_reasons") or ())
                ),
                "risk_veto_reasons": list(
                    cast(Sequence[Any], row.get("risk_veto_reasons") or ())
                ),
                "robust_lower_percentile_post_cost_utility_bps": row.get(
                    "robust_lower_percentile_post_cost_utility_bps"
                ),
                "bootstrap_lower_percentile_post_cost_utility_bps": row.get(
                    "bootstrap_lower_percentile_post_cost_utility_bps"
                ),
                "exact_replay_required": True,
                "runtime_ledger_required": True,
                "observed_post_cost_expectancy_bps": row.get(
                    "observed_post_cost_expectancy_bps"
                ),
                "required_daily_notional": row.get("required_daily_notional"),
                "target_implied_notional_context": row.get(
                    "target_implied_notional_context"
                ),
                "exact_replay_selection_blocked": row.get(
                    "exact_replay_selection_blocked"
                ),
                "exact_replay_selection_blockers": exact_replay_selection_blockers,
                "reproducibility_metadata": {
                    "dataset_snapshot_ref": replay_tape_manifest.dataset_snapshot_ref,
                    "replay_tape_content_sha256": replay_tape_manifest.content_sha256,
                    "replay_cache_key": replay_tape_manifest.replay_cache_key,
                    "source_query_digest": replay_tape_manifest.source_query_digest,
                    "source_table_versions": dict(
                        replay_tape_manifest.source_table_versions
                    ),
                    "feature_schema_hash": replay_tape_manifest.feature_schema_hash,
                    "cost_model_hash": replay_tape_manifest.cost_model_hash,
                    "strategy_family": replay_tape_manifest.strategy_family,
                    "cache_identity": (
                        replay_tape_manifest.cache_identity_diagnostics()
                    ),
                    "preview_score": row.get("preview_score"),
                    "preview_rank_score": row.get("preview_rank_score")
                    or row.get("preview_score"),
                    "robust_lower_percentile_post_cost_utility_bps": row.get(
                        "robust_lower_percentile_post_cost_utility_bps"
                    ),
                    "frontier_bucket": row.get("frontier_bucket"),
                    "handoff_lineage_hash": handoff_lineage_hash,
                },
                "exact_replay_handoff_lineage": handoff_lineage,
                "handoff_lineage_hash": handoff_lineage_hash,
                "cost_impact_lineage": row.get("cost_impact_lineage"),
                "impact_capacity_lineage": row.get("impact_capacity_lineage"),
                "hpairs_macro_window_stress": row.get("hpairs_macro_window_stress"),
                "hpairs_impact_capacity_lineage": row.get(
                    "hpairs_impact_capacity_lineage"
                ),
                "adv_capacity_context": row.get("adv_capacity_context"),
                "lineage_blockers": list(
                    cast(Sequence[Any], row.get("lineage_blockers") or ())
                ),
                "risk_flags": list(cast(Sequence[Any], row.get("risk_flags") or ())),
                "proof_semantics_label": row.get("proof_semantics_label"),
                "hpairs_microstructure_prefilter": row.get(
                    "hpairs_microstructure_prefilter"
                )
                or row.get("microstructure_prefilter"),
                "promotion_proof": False,
                "proof_authority": False,
                "promotion_authority": False,
                "promotion_allowed": False,
                "final_promotion_allowed": False,
                "final_authority_ok": False,
            }
        )
    return {
        "schema_version": "torghut.fast-replay-bounded-sim-target-queue.v4",
        "status": "metadata_only_preview_to_exact_replay_queue",
        "discovery_stage_semantics": _fast_replay_discovery_stage_semantics(),
        "authority": "not_promotion_proof",
        "prefilter_only": True,
        "promotion_proof": False,
        "proof_authority": False,
        "promotion_authority": False,
        "promotion_allowed": False,
        "final_promotion_allowed": False,
        "final_authority_ok": False,
        "proof_semantics": _fast_replay_preview_proof_semantics(),
        "whitepaper_mechanisms": list(FAST_REPLAY_WHITEPAPER_MECHANISMS),
        "queue_policy": "top_exploitation_plus_exploration_exact_replay_cap",
        "ranking_authority_boundary": {
            "schema_version": "torghut.fast-replay-queue-ranking-authority-boundary.v1",
            "preview_rank_score_field": "preview_rank_score",
            "ranking_only_reasons_field": "ranking_only_reasons",
            "risk_veto_reasons_field": "risk_veto_reasons",
            "exact_replay_required": True,
            "runtime_ledger_required": True,
            "promotion_allowed": False,
            "ranking_output_can_authorize_promotion": False,
        },
        "dedupe_policy": {
            "schema_version": "torghut.fast-replay-sim-target-queue-dedupe.v1",
            "status": "enabled",
            "dedupe_scope": "same_replay_tape_cache_and_execution_identity",
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_authority_ok": False,
        },
        "runner_policy": {
            "default_shard_timeout_seconds": _DEFAULT_REAL_REPLAY_SHARD_TIMEOUT_SECONDS,
            "default_worker_cap": _DEFAULT_REAL_REPLAY_SHARD_WORKERS,
            "default_parallel_frontier_candidate_cap": (
                _DEFAULT_REAL_REPLAY_MAX_PARALLEL_FRONTIER_CANDIDATES
            ),
            "kubernetes_fanout_enabled": False,
            "handoff_mode": "metadata_only_no_live_submit",
        },
        "exact_replay_command_policy": {
            "schema_version": "torghut.fast-replay-exact-command-policy.v1",
            "generation_scope": "bounded_frontier_only",
            "max_exact_replay_candidates": _DEFAULT_FAST_REPLAY_EXACT_CANDIDATE_CAP,
            "effective_exact_replay_candidate_cap": exact_replay_candidate_cap,
            "max_local_workers": _DEFAULT_REAL_REPLAY_SHARD_WORKERS,
            "shard_timeout_seconds": _DEFAULT_REAL_REPLAY_SHARD_TIMEOUT_SECONDS,
            "proof_packet_upload_allowed": False,
            "db_writes_allowed": False,
            "cluster_fanout_allowed": False,
            "kubernetes_fanout_allowed": False,
            "promotion_writes_allowed": False,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_authority_ok": False,
        },
        "target_queue": {
            "sim_account_label": "TORGHUT_SIM",
            "live_paper_account_label": "TORGHUT_LIVE_PAPER_AFTER_PROBATION",
            "status": "sim_target_queue_ready_live_paper_blocked",
            "candidate_stage": "bounded_sim_evidence_collection_candidate",
            "live_paper_blockers": [
                "exact_replay_probation_required",
                "source_backed_runtime_ledger_required",
                "operator_enablement_required",
            ],
        },
        "replay_tape": {
            "dataset_snapshot_ref": replay_tape_manifest.dataset_snapshot_ref,
            "content_sha256": replay_tape_manifest.content_sha256,
            "replay_cache_key": replay_tape_manifest.replay_cache_key,
            "source_query_digest": replay_tape_manifest.source_query_digest,
            "source_table_versions": dict(replay_tape_manifest.source_table_versions),
            "feature_schema_hash": replay_tape_manifest.feature_schema_hash,
            "cost_model_hash": replay_tape_manifest.cost_model_hash,
            "strategy_family": replay_tape_manifest.strategy_family,
            "cache_identity": replay_tape_manifest.cache_identity_diagnostics(),
        },
        "exact_replay_candidate_cap": exact_replay_candidate_cap,
        "exploitation_slots": exploitation_slots,
        "exploration_slots": exploration_slots,
        "exact_replay_candidate_count": len(entries),
        "pre_dedupe_selected_candidate_count": len(selected_preview_rows),
        "deduped_candidate_count": len(entries),
        "duplicate_filtered_candidate_spec_ids": duplicate_filtered_candidate_spec_ids,
        "candidate_spec_ids": [entry["candidate_spec_id"] for entry in entries],
        "exact_replay_frontier_keys": [
            entry["exact_replay_frontier_key"] for entry in entries
        ],
        "handoff_lineage_hashes": [entry["handoff_lineage_hash"] for entry in entries],
        "entries": entries,
    }


def _fast_replay_exact_handoff_lineage(
    *,
    row: Mapping[str, Any],
    replay_tape_manifest: ReplayTapeManifest,
    queue_priority: int,
    candidate_spec_id: str,
    frontier_bucket: str,
    stage_metadata: Mapping[str, Any],
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "schema_version": "torghut.fast-replay-exact-handoff-lineage.v3",
        "status": "preview_only_exact_replay_handoff",
        "discovery_stage_metadata": dict(stage_metadata),
        "authority": "not_promotion_proof",
        "prefilter_only": True,
        "promotion_proof": False,
        "proof_authority": False,
        "promotion_authority": False,
        "promotion_allowed": False,
        "final_promotion_allowed": False,
        "final_authority_ok": False,
        "candidate_spec_id": candidate_spec_id,
        "queue_priority": queue_priority,
        "frontier_bucket": frontier_bucket,
        "candidate_frontier_hash": row.get("candidate_frontier_hash"),
        "exact_replay_frontier_key": row.get("exact_replay_frontier_key"),
        "frontier_dedupe_status": row.get("frontier_dedupe_status"),
        "frontier_dedupe_metadata": row.get("frontier_dedupe_metadata"),
        "preview_rank": row.get("rank"),
        "preview_score": row.get("preview_score"),
        "preview_rank_score": row.get("preview_rank_score") or row.get("preview_score"),
        "ranking_only_reasons": list(
            cast(Sequence[Any], row.get("ranking_only_reasons") or ())
        ),
        "risk_veto_reasons": list(
            cast(Sequence[Any], row.get("risk_veto_reasons") or ())
        ),
        "robust_lower_percentile_post_cost_utility_bps": row.get(
            "robust_lower_percentile_post_cost_utility_bps"
        ),
        "exact_replay_required": True,
        "runtime_ledger_required": True,
        "proof_semantics_label": row.get("proof_semantics_label"),
        "replay_tape": {
            "dataset_snapshot_ref": replay_tape_manifest.dataset_snapshot_ref,
            "content_sha256": replay_tape_manifest.content_sha256,
            "replay_cache_key": replay_tape_manifest.replay_cache_key,
            "source_query_digest": replay_tape_manifest.source_query_digest,
            "source_table_versions": dict(replay_tape_manifest.source_table_versions),
            "feature_schema_hash": replay_tape_manifest.feature_schema_hash,
            "cost_model_hash": replay_tape_manifest.cost_model_hash,
            "strategy_family": replay_tape_manifest.strategy_family,
            "cache_identity": replay_tape_manifest.cache_identity_diagnostics(),
        },
        "cost_impact_lineage": row.get("cost_impact_lineage"),
        "hpairs_microstructure_prefilter": row.get("hpairs_microstructure_prefilter")
        or row.get("microstructure_prefilter"),
    }
    payload["lineage_hash"] = build_source_query_digest(payload)
    return payload


def _maybe_materialize_epoch_replay_tape(
    *,
    args: argparse.Namespace,
    output_dir: Path,
    epoch_id: str,
) -> tuple[argparse.Namespace, dict[str, Any] | None]:
    explicit_materialize = bool(getattr(args, "materialize_replay_tape", False))
    auto_materialize = _auto_materialize_staged_replay_tape(args)
    if not explicit_materialize and not auto_materialize:
        return args, None
    if getattr(args, "replay_tape_path", None) is not None:
        return args, None
    if str(getattr(args, "replay_mode", "") or "") != "real":
        raise ValueError("replay_tape_materialization_requires_real_replay")
    if bool(getattr(args, "selection_only", False)):
        raise ValueError("replay_tape_materialization_requires_replay_execution")

    start_date = _materialized_replay_tape_date_arg(args, "full_window_start_date")
    end_date = _materialized_replay_tape_date_arg(args, "full_window_end_date")
    symbols = _candidate_universe_symbols_from_args(args)
    tape_path = output_dir / "replay-tape.jsonl"
    manifest_path = output_dir / "replay-tape.jsonl.manifest.json"
    config = replay_mod.ReplayConfig(
        strategy_configmap_path=_resolve_existing_path(args.strategy_configmap),
        clickhouse_http_url=str(getattr(args, "clickhouse_http_url", "")),
        clickhouse_username=(_string(getattr(args, "clickhouse_username", "")) or None),
        clickhouse_password=(_string(getattr(args, "clickhouse_password", "")) or None),
        start_date=start_date,
        end_date=end_date,
        chunk_minutes=max(1, int(getattr(args, "chunk_minutes", 10) or 10)),
        flatten_eod=True,
        start_equity=Decimal(str(getattr(args, "start_equity", "31590.02"))),
        symbols=symbols,
    )
    rows = tuple(replay_mod._iter_signal_rows(config))
    source_query_digest = _materialized_replay_tape_source_query_digest(
        args=args,
        symbols=symbols,
        start_date=start_date,
        end_date=end_date,
    )
    manifest = materialize_signal_tape(
        rows=rows,
        tape_path=tape_path,
        manifest_path=manifest_path,
        dataset_snapshot_ref=epoch_id,
        symbols=symbols,
        start_date=start_date,
        end_date=end_date,
        source_query_digest=source_query_digest,
        feature_schema_hash=_materialized_replay_tape_feature_schema_hash(args),
        cost_model_hash=_materialized_replay_tape_cost_model_hash(args),
        strategy_family=_materialized_replay_tape_strategy_family(args),
        require_complete_coverage=not bool(getattr(args, "allow_stale_tape", False)),
    )
    receipt_path = output_dir / "replay-tape-receipt.json"
    receipt = {
        "schema_version": "torghut.whitepaper-autoresearch-replay-tape-receipt.v1",
        "status": "materialized",
        "tape_path": str(tape_path),
        "manifest_path": str(manifest_path),
        "receipt_path": str(receipt_path),
        "dataset_snapshot_ref": manifest.dataset_snapshot_ref,
        "row_count": manifest.row_count,
        "trading_day_count": manifest.trading_day_count,
        "row_symbols": list(manifest.row_symbols),
        "content_sha256": manifest.content_sha256,
        "source_query_digest": manifest.source_query_digest,
        "replay_cache_key": manifest.replay_cache_key,
        "feature_schema_hash": manifest.feature_schema_hash,
        "cost_model_hash": manifest.cost_model_hash,
        "strategy_family": manifest.strategy_family,
        "cache_identity": manifest.cache_identity_diagnostics(),
    }
    _write_json(receipt_path, receipt)
    updated_args = argparse.Namespace(
        **{
            **vars(args),
            "replay_tape_path": tape_path,
            "replay_tape_manifest": manifest_path,
            "replay_tape_dataset_snapshot_ref": manifest.dataset_snapshot_ref,
        }
    )
    return updated_args, receipt


def _auto_materialize_staged_replay_tape(args: argparse.Namespace) -> bool:
    if not bool(getattr(args, "staged_replay_frontier_default", False)):
        return False
    if bool(getattr(args, "disable_staged_replay_frontier", False)):
        return False
    if str(getattr(args, "replay_mode", "") or "") != "real":
        return False
    if bool(getattr(args, "selection_only", False)):
        return False
    if getattr(args, "replay_tape_path", None) is not None:
        return False
    if not str(getattr(args, "full_window_start_date", "") or "").strip():
        return False
    if not str(getattr(args, "full_window_end_date", "") or "").strip():
        return False
    return True


def _maybe_preflight_materialized_replay_tape_window(
    *,
    args: argparse.Namespace,
    output_dir: Path,
) -> tuple[argparse.Namespace, dict[str, Any] | None]:
    explicit_materialize = bool(getattr(args, "materialize_replay_tape", False))
    auto_materialize = _auto_materialize_staged_replay_tape(args)
    if not explicit_materialize and not auto_materialize:
        return args, None
    if getattr(args, "replay_tape_path", None) is not None:
        return args, None
    if str(getattr(args, "replay_mode", "") or "") != "real":
        return args, None
    if bool(getattr(args, "selection_only", False)):
        return args, None
    min_days = max(0, int(getattr(args, "latest_complete_window_min_days", 0) or 0))
    if min_days <= 0:
        return args, None

    requested_start_date = _materialized_replay_tape_date_arg(
        args, "full_window_start_date"
    )
    requested_end_date = _materialized_replay_tape_date_arg(
        args, "full_window_end_date"
    )
    coverage_diagnostic_output = (
        Path(getattr(args, "coverage_diagnostic_output")).resolve()
        if getattr(args, "coverage_diagnostic_output", None) is not None
        else output_dir / "replay-source-coverage-diagnostics.json"
    )
    latest_window_receipt_output = (
        Path(getattr(args, "latest_complete_window_receipt_output")).resolve()
        if getattr(args, "latest_complete_window_receipt_output", None) is not None
        else output_dir / "replay-source-latest-complete-window.json"
    )
    preflight_args = argparse.Namespace(
        **{
            **vars(args),
            "coverage_diagnostic_output": coverage_diagnostic_output,
            "latest_complete_window_receipt_output": latest_window_receipt_output,
        }
    )
    symbols = _candidate_universe_symbols_from_args(args)
    selected_start, selected_end, receipt = (
        replay_materializer._select_effective_window(
            args=preflight_args,
            symbols=symbols,
            requested_start_date=requested_start_date,
            requested_end_date=requested_end_date,
        )
    )
    updated_args = argparse.Namespace(
        **{
            **vars(args),
            "full_window_start_date": selected_start.isoformat(),
            "full_window_end_date": selected_end.isoformat(),
            "expected_last_trading_day": selected_end.isoformat(),
            "coverage_diagnostic_output": coverage_diagnostic_output,
            "latest_complete_window_receipt_output": latest_window_receipt_output,
        }
    )
    return updated_args, receipt


def _materialized_replay_tape_date_arg(
    args: argparse.Namespace,
    key: str,
) -> date:
    value = str(getattr(args, key, "") or "").strip()
    if not value:
        raise ValueError(f"replay_tape_materialization_requires_{key}")
    return date.fromisoformat(value)


def _materialized_replay_tape_source_query_digest(
    *,
    args: argparse.Namespace,
    symbols: Sequence[str],
    start_date: date,
    end_date: date,
) -> str:
    return build_source_query_digest(
        {
            "query_family": "torghut.ta_signals_pt1s_with_microbars",
            "clickhouse_http_url": str(getattr(args, "clickhouse_http_url", "")),
            "start_date": start_date.isoformat(),
            "end_date": end_date.isoformat(),
            "chunk_minutes": max(1, int(getattr(args, "chunk_minutes", 10) or 10)),
            "symbols": list(symbols),
            "source": "ta",
            "window_size": "PT1S",
            "join": "torghut.ta_microbars",
        }
    )


def _materialized_replay_tape_feature_schema_hash(args: argparse.Namespace) -> str:
    return _stable_hash(
        {
            "schema_version": "torghut.replay-tape-feature-schema.v1",
            "signal_schema": "SignalEnvelope",
            "source": "ta",
            "window_size": "PT1S",
            "microbar_join": "torghut.ta_microbars",
            "chunk_minutes": max(1, int(getattr(args, "chunk_minutes", 10) or 10)),
        }
    )


def _materialized_replay_tape_cost_model_hash(args: argparse.Namespace) -> str:
    return _stable_hash(
        {
            "schema_version": "torghut.replay-tape-cost-model.v1",
            "pnl_basis": POST_COST_PNL_BASIS,
            "start_equity": str(getattr(args, "start_equity", "31590.02")),
            "preview_cost_lineage": "spread_plus_square_root_impact_prefilter",
        }
    )


def _materialized_replay_tape_strategy_family(args: argparse.Namespace) -> str:
    path = Path(getattr(args, "strategy_configmap", "strategy-configmap.yaml"))
    return f"whitepaper-autoresearch:{path.name}"


def _fast_replay_preview_date_arg(args: argparse.Namespace, key: str) -> date:
    value = str(getattr(args, key, "") or "").strip()
    if not value:
        raise ValueError(f"fast_replay_preview_requires_{key}")
    return date.fromisoformat(value)


__all__ = [
    "_fast_replay_preview_proof_semantics",
    "_fast_replay_discovery_stage_semantics",
    "_fast_replay_queue_stage_metadata",
    "_bounded_sim_target_queue_metadata",
    "_fast_replay_exact_handoff_lineage",
    "_maybe_materialize_epoch_replay_tape",
    "_auto_materialize_staged_replay_tape",
    "_maybe_preflight_materialized_replay_tape_window",
    "_materialized_replay_tape_date_arg",
    "_materialized_replay_tape_source_query_digest",
    "_materialized_replay_tape_feature_schema_hash",
    "_materialized_replay_tape_cost_model_hash",
    "_materialized_replay_tape_strategy_family",
    "_fast_replay_preview_date_arg",
]
