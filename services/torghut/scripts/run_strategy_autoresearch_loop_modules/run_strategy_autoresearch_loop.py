# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false
#!/usr/bin/env python3
"""Run an autoresearch-style outer loop for Torghut strategy discovery."""

from __future__ import annotations

import argparse
import json
import os
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation, ROUND_DOWN
from pathlib import Path
from typing import Any, Mapping, cast

import yaml

from app.trading.discovery.autoresearch import (
    FamilyAutoresearchPlan,
    ProposalModelPolicy,
    StrategyAutoresearchProgram,
    apply_program_objective,
    build_mutated_sweep_config,
    candidate_meets_objective,
    load_strategy_autoresearch_program,
    run_id,
    stable_payload_hash,
)
from app.trading.discovery.autoresearch_notebooks import write_autoresearch_notebooks
from app.trading.discovery.evidence_bundles import (
    CandidateEvidenceBundle,
    evidence_bundle_from_frontier_candidate,
)
from app.trading.discovery.family_templates import family_template_dir
from app.trading.discovery.mlx_features import (
    MlxCandidateDescriptor,
    descriptor_from_candidate_payload,
    descriptor_from_sweep_config,
)
from app.trading.discovery.mlx_notebook_exports import write_mlx_notebook_exports
from app.trading.discovery.mlx_proposal_models import (
    ProposalDiagnostics,
    ProposalScore,
    ProposalSelectionEntry,
    build_proposal_diagnostics,
    rank_candidate_descriptors,
    select_proposal_batch,
)
from app.trading.discovery.mlx_snapshot import (
    MlxSignalBundleStats,
    MlxSnapshotManifest,
    build_mlx_snapshot_manifest,
    write_mlx_signal_bundle,
    write_mlx_snapshot_manifest,
)
from app.trading.discovery.objectives import (
    deployable_lower_bound_missing_count,
    deployable_lower_bound_net_pnl_per_day,
    deployable_proof_failed_gate_count,
)
from app.trading.discovery.promotion_contract import (
    blocked_research_candidate_promotion_readiness,
    summary_promotion_readiness,
)
from app.trading.discovery.portfolio_candidates import PortfolioCandidateSpec
from app.trading.discovery.portfolio_optimizer import optimize_portfolio_candidate
from app.trading.discovery.profit_target_oracle import ProfitTargetOraclePolicy
from app.trading.discovery.replay_ledger_ranker import (
    build_replay_ledger_ranking_report,
    default_replay_ledger_ranking_policy,
)
from app.trading.discovery.replay_ledger_guided_search import (
    apply_replay_ledger_remediation_guidance,
)
from app.trading.discovery.replay_ledger_remediation import (
    build_replay_ledger_remediation_report,
)
from app.trading.discovery.replay_tape import (
    ReplayTapeManifest,
    build_source_query_digest,
    default_manifest_path,
    materialize_signal_tape,
)
from app.trading.discovery.runtime_closure import write_runtime_closure_bundle
from app.trading.discovery.runtime_closure import RuntimeClosureExecutionContext
import scripts.local_intraday_tsmom_replay as replay_mod
from scripts.search_consistent_profitability_frontier import (
    run_consistent_profitability_frontier,
)
from scripts.materialize_replay_tape import (
    _DEFAULT_MAX_COVERAGE_SPREAD_BPS,
    _DEFAULT_MAX_EXECUTABLE_GAP_SECONDS,
    _DEFAULT_MIN_EXECUTABLE_ROWS_PER_SYMBOL_DAY,
    _DEFAULT_MIN_QUOTE_VALID_RATIO,
    _select_effective_window as _select_effective_replay_tape_window,
)

# ruff: noqa: F401,F403,F405,F811,F821

from .shared_context import (
    LatestCompleteWindowRequirement,
    WorkItem,
    _CAPITAL_LIMIT_SAFETY_MULTIPLIER,
    _DEFAULT_CLICKHOUSE_HTTP_URL,
    _REPO_ROOT,
    _apply_exact_replay_guidance_to_next_sweep,
    _apply_objective_capital_limits,
    _as_grid_values,
    _capped_numeric_grid,
    _decimal,
    _default_clickhouse_http_url,
    _default_clickhouse_password,
    _find_repo_root,
    _float,
    _format_decimal,
    _frontier_args,
    _frontier_candidate_budget,
    _iter_symbols,
    _json_clone,
    _keep_candidate_limit,
    _mapping,
    _max_entry_count,
    _maybe_decimal,
    _mlx_bundle_paths,
    _parse_args,
    _positive_decimal_grid_values,
    _promotion_readiness_payload,
    _runtime_missing_candidate_payload,
    _runtime_missing_frontier_payload,
    _slug,
    _snapshot_symbols,
    _string,
    _work_item_candidate_id,
)
from .load_yaml import (
    _default_full_window_day_count,
    _full_window_signal_config,
    _history_record,
    _iso_date,
    _latest_complete_window_requirement,
    _load_yaml,
    _maybe_materialize_run_replay_tape,
    _maybe_write_signal_bundle,
    _provided_replay_tape_receipt,
    _replay_tape_receipt,
    _replay_tape_source_query_digest,
    _sanitize_tsv_field,
    _write_history_jsonl,
)
from .write_results_tsv import (
    _best_history_record,
    _candidate_spec_id_for_portfolio_payload,
    _dedupe_nonempty_strings,
    _exact_replay_history_row,
    _exact_replay_runtime_window_blockers,
    _hypothesis_manifest_for_history_row,
    _hypothesis_manifest_rows,
    _portfolio_evidence_bundles_from_results,
    _portfolio_is_runtime_closure_candidate,
    _portfolio_objective_scorecard,
    _portfolio_oracle_policy,
    _portfolio_promotion_readiness,
    _research_ranking_net_pnl_per_day,
    _runtime_closure_candidate,
    _runtime_closure_pending_promotion_steps,
    _runtime_closure_promotion_prerequisite_blockers,
    _runtime_closure_subject,
    _strategy_autoresearch_runtime_window_import_plan,
    _strategy_name_from_strategy_id,
    _summary_promotion_readiness_for_outputs,
    _write_results_tsv,
)
from .write_portfolio_outputs import (
    _EXACT_REPLAY_EXECUTION_QUALITY_FIELDS,
    _best_experiment_snapshot,
    _exact_replay_candidate_for_payload,
    _exact_replay_ledger_paths,
    _exact_replay_ledger_refs,
    _exact_replay_ranking_by_candidate,
    _experiment_snapshot_from_payload,
    _live_progress_payload,
    _load_experiment_snapshots,
    _persist_run_outputs,
    _proposal_diagnostics,
    _resolve_run_artifact_ref,
    _with_exact_replay_execution_quality,
    _write_exact_replay_ledger_ranking,
    _write_exact_replay_ledger_remediation,
    _write_portfolio_outputs,
)


def run_strategy_autoresearch_loop(args: argparse.Namespace) -> dict[str, Any]:
    program = load_strategy_autoresearch_program(
        args.program.resolve(),
        family_dir=args.family_template_dir.resolve(),
    )
    runner_run_id = run_id("strategy-autoresearch")
    run_root = args.output_dir.resolve() / runner_run_id
    run_root.mkdir(parents=True, exist_ok=True)
    (run_root / "experiments").mkdir(parents=True, exist_ok=True)

    worklist: list[WorkItem] = []
    seen_sweeps: set[str] = set()
    for family_plan in program.families:
        seed_sweep = _load_yaml(family_plan.seed_sweep_config)
        seed_sweep = apply_program_objective(
            sweep_config=seed_sweep,
            objective=program.objective,
            holdout_day_count=max(1, int(args.holdout_days)),
            full_window_day_count=_default_full_window_day_count(args),
        )
        seed_sweep = _apply_objective_capital_limits(
            sweep_config=seed_sweep,
            max_gross_exposure_pct_equity=program.objective.max_gross_exposure_pct_equity,
            start_equity=Decimal(str(args.start_equity)),
        )
        worklist.append(
            WorkItem(
                family_plan=family_plan,
                iteration=1,
                sweep_config=seed_sweep,
                mutation_label="seed",
                parent_candidate_id=None,
            )
        )

    history: list[dict[str, Any]] = []
    descriptors: list[MlxCandidateDescriptor] = []
    proposal_scores: list[ProposalScore] = []
    tape_freshness_receipts: list[dict[str, Any]] = []
    snapshot_symbols = _snapshot_symbols(args=args, worklist=worklist)
    bundle_paths = _mlx_bundle_paths(run_root)
    resolved_full_window_start_date = _string(args.full_window_start_date)
    resolved_full_window_end_date = _string(args.full_window_end_date)
    signal_bundle_stats: MlxSignalBundleStats | None = None
    effective_replay_tape_path = (
        Path(replay_tape_path).resolve()
        if (replay_tape_path := getattr(args, "replay_tape_path", None)) is not None
        else None
    )
    effective_replay_tape_manifest = (
        Path(replay_tape_manifest).resolve()
        if (replay_tape_manifest := getattr(args, "replay_tape_manifest", None))
        is not None
        else None
    )
    if effective_replay_tape_path is not None:
        provided_receipt = _provided_replay_tape_receipt(
            tape_path=effective_replay_tape_path,
            manifest_path=effective_replay_tape_manifest,
        )
        if provided_receipt is not None:
            tape_freshness_receipts.append(provided_receipt)
    closure_execution_context = RuntimeClosureExecutionContext(
        strategy_configmap_path=args.strategy_configmap.resolve(),
        clickhouse_http_url=str(args.clickhouse_http_url),
        clickhouse_username=(_string(args.clickhouse_username) or None),
        clickhouse_password=(_string(args.clickhouse_password) or None),
        start_equity=Decimal(str(args.start_equity)),
        chunk_minutes=max(1, int(args.chunk_minutes)),
        symbols=snapshot_symbols,
        progress_log_interval_seconds=max(1, int(args.progress_log_seconds)),
        shadow_validation_artifact_path=(
            args.shadow_validation_artifact.resolve()
            if args.shadow_validation_artifact is not None
            else None
        ),
    )

    def _refresh_manifest() -> MlxSnapshotManifest:
        latest_receipt = tape_freshness_receipts[-1] if tape_freshness_receipts else {}
        return build_mlx_snapshot_manifest(
            runner_run_id=runner_run_id,
            program=program,
            symbols=",".join(snapshot_symbols),
            train_days=int(args.train_days),
            holdout_days=int(args.holdout_days),
            full_window_start_date=resolved_full_window_start_date,
            full_window_end_date=resolved_full_window_end_date,
            tape_freshness_receipts=tuple(tape_freshness_receipts),
            row_counts={
                "receipt_count": len(tape_freshness_receipts),
                "latest_receipt_row_count": int(latest_receipt.get("row_count") or 0),
                "signal_row_count": signal_bundle_stats.row_count
                if signal_bundle_stats is not None
                else 0,
                "signal_symbol_count": (
                    signal_bundle_stats.symbol_count
                    if signal_bundle_stats is not None
                    else len(snapshot_symbols)
                ),
            },
            tensor_bundle_paths=bundle_paths,
        )

    manifest = _refresh_manifest()
    frontier_runs = 0
    objective_met = False
    summary = _persist_run_outputs(
        run_root=run_root,
        program=program,
        program_payload=program.to_payload(),
        runner_run_id=runner_run_id,
        program_id=program.program_id,
        frontier_runs=frontier_runs,
        objective_met=objective_met,
        history=history,
        manifest=manifest,
        descriptors=descriptors,
        proposal_scores=proposal_scores,
        worklist=worklist,
        status="running",
        closure_execution_context=closure_execution_context,
    )
    latest_exact_replay_ledger_remediation = _mapping(
        summary.get("exact_replay_ledger_remediation")
    )
    signal_bundle_stats, materialized_replay_tape_receipt = (
        _maybe_materialize_run_replay_tape(
            args=args,
            runner_run_id=runner_run_id,
            snapshot_symbols=snapshot_symbols,
            bundle_paths=bundle_paths,
            full_window_start_date=resolved_full_window_start_date,
            full_window_end_date=resolved_full_window_end_date,
            existing_signal_bundle=signal_bundle_stats,
            objective_min_observed_trading_days=program.objective.min_observed_trading_days,
        )
    )
    if materialized_replay_tape_receipt is not None:
        tape_freshness_receipts.append(materialized_replay_tape_receipt)
        effective_replay_tape_path = Path(materialized_replay_tape_receipt["tape_path"])
        effective_replay_tape_manifest = Path(
            materialized_replay_tape_receipt["manifest_path"]
        )
        resolved_full_window_start_date = (
            _string(
                materialized_replay_tape_receipt.get("effective_full_window_start_date")
            )
            or resolved_full_window_start_date
        )
        resolved_full_window_end_date = (
            _string(
                materialized_replay_tape_receipt.get("effective_full_window_end_date")
            )
            or resolved_full_window_end_date
        )
    signal_bundle_stats = _maybe_write_signal_bundle(
        args=args,
        snapshot_symbols=snapshot_symbols,
        bundle_paths=bundle_paths,
        full_window_start_date=resolved_full_window_start_date,
        full_window_end_date=resolved_full_window_end_date,
        existing=signal_bundle_stats,
    )
    frontier_base_args = argparse.Namespace(
        **{
            **vars(args),
            "full_window_start_date": resolved_full_window_start_date,
            "full_window_end_date": resolved_full_window_end_date,
            "expected_last_trading_day": (
                resolved_full_window_end_date
                if materialized_replay_tape_receipt is not None
                else str(args.expected_last_trading_day)
            ),
            "replay_tape_path": effective_replay_tape_path,
            "replay_tape_manifest": effective_replay_tape_manifest,
        }
    )
    manifest = _refresh_manifest()
    summary = _persist_run_outputs(
        run_root=run_root,
        program=program,
        program_payload=program.to_payload(),
        runner_run_id=runner_run_id,
        program_id=program.program_id,
        frontier_runs=frontier_runs,
        objective_met=objective_met,
        history=history,
        manifest=manifest,
        descriptors=descriptors,
        proposal_scores=proposal_scores,
        worklist=worklist,
        status="running",
        closure_execution_context=closure_execution_context,
    )
    latest_exact_replay_ledger_remediation = _mapping(
        summary.get("exact_replay_ledger_remediation")
    )
    try:
        while worklist:
            if int(args.max_frontier_runs) > 0 and frontier_runs >= int(
                args.max_frontier_runs
            ):
                break
            pending_descriptors = [
                descriptor_from_sweep_config(
                    candidate_id=_work_item_candidate_id(item),
                    family_plan=item.family_plan,
                    sweep_config=item.sweep_config,
                )
                for item in worklist
            ]
            pending_scores = rank_candidate_descriptors(
                descriptors=pending_descriptors,
                history_rows=history,
                policy=cast(ProposalModelPolicy, program.proposal_model_policy),
            )
            proposal_scores.extend(pending_scores)
            score_by_candidate = {item.candidate_id: item for item in pending_scores}
            ordered_pending = sorted(
                zip(worklist, pending_descriptors, strict=False),
                key=lambda item: (
                    not item[1].capital_feasible,
                    _float(item[1].capital_budget_overage_ratio),
                    score_by_candidate[item[1].candidate_id].rank,
                    -score_by_candidate[item[1].candidate_id].score,
                    item[0].family_plan.family_template.family_id,
                ),
            )
            current, current_descriptor = ordered_pending[0]
            descriptors.append(current_descriptor)
            worklist = [item for item, _ in ordered_pending[1:]]
            sweep_hash = stable_payload_hash(current.sweep_config)
            if sweep_hash in seen_sweeps:
                continue
            seen_sweeps.add(sweep_hash)
            frontier_runs += 1
            experiment_index = frontier_runs
            experiment_slug = _slug(
                f"{experiment_index:03d}-{current.family_plan.family_template.family_id}-iter-{current.iteration}"
            )
            experiment_root = run_root / "experiments" / experiment_slug
            experiment_root.mkdir(parents=True, exist_ok=True)
            sweep_config_path = experiment_root / "sweep.yaml"
            sweep_config_path.write_text(
                yaml.safe_dump(current.sweep_config, sort_keys=False),
                encoding="utf-8",
            )
            result_path = experiment_root / "result.json"
            selected_score = score_by_candidate.get(current_descriptor.candidate_id)
            selected_for_replay = (
                ProposalSelectionEntry(
                    candidate_id=current_descriptor.candidate_id,
                    descriptor_id=current_descriptor.descriptor_id,
                    selection_reason="frontier_seed",
                    score=selected_score.score,
                    rank=selected_score.rank,
                    family_template_id=current_descriptor.family_template_id,
                    side_policy=current_descriptor.side_policy,
                    capital_feasible=current_descriptor.capital_feasible,
                    capital_budget_overage_ratio=_float(
                        current_descriptor.capital_budget_overage_ratio
                    ),
                )
                if selected_score is not None
                else None
            )
            summary = _persist_run_outputs(
                run_root=run_root,
                program=program,
                program_payload=program.to_payload(),
                runner_run_id=runner_run_id,
                program_id=program.program_id,
                frontier_runs=frontier_runs,
                objective_met=objective_met,
                history=history,
                manifest=manifest,
                descriptors=descriptors,
                proposal_scores=proposal_scores,
                worklist=worklist,
                status="running",
                selected_for_replay=selected_for_replay,
                selected_descriptor=current_descriptor,
                closure_execution_context=closure_execution_context,
            )
            latest_exact_replay_ledger_remediation = _mapping(
                summary.get("exact_replay_ledger_remediation")
            )
            try:
                frontier_payload = run_consistent_profitability_frontier(
                    _frontier_args(
                        args=frontier_base_args,
                        program=program,
                        family_plan=current.family_plan,
                        sweep_config_path=sweep_config_path,
                        json_output_path=result_path,
                    )
                )
            except ValueError as exc:
                status_reason = str(exc)
                if not status_reason.startswith("strategy_not_found:"):
                    raise
                candidate_payload = _runtime_missing_candidate_payload(
                    candidate_id=current_descriptor.candidate_id,
                    family_plan=current.family_plan,
                    sweep_config=current.sweep_config,
                    reason=status_reason,
                )
                frontier_payload = _runtime_missing_frontier_payload(
                    candidate_payload=candidate_payload,
                    family_plan=current.family_plan,
                    status_reason=status_reason,
                )
                history.append(
                    _history_record(
                        runner_run_id=runner_run_id,
                        experiment_index=experiment_index,
                        family_plan=current.family_plan,
                        iteration=current.iteration,
                        mutation_label=current.mutation_label,
                        parent_candidate_id=current.parent_candidate_id,
                        sweep_config_path=sweep_config_path,
                        result_path=result_path,
                        candidate_payload=candidate_payload,
                        rank=1,
                        status="skip",
                        objective_met=False,
                        dataset_snapshot_id="",
                        descriptor=current_descriptor,
                        proposal_score=selected_score,
                        proposal_selected=False,
                        proposal_selection_reason="runtime_strategy_missing",
                        disable_other_strategies=bool(
                            current.sweep_config.get("disable_other_strategies", True)
                        ),
                    )
                )
                result_path.write_text(
                    json.dumps(frontier_payload, indent=2, sort_keys=True),
                    encoding="utf-8",
                )
                summary = _persist_run_outputs(
                    run_root=run_root,
                    program=program,
                    program_payload=program.to_payload(),
                    runner_run_id=runner_run_id,
                    program_id=program.program_id,
                    frontier_runs=frontier_runs,
                    objective_met=objective_met,
                    history=history,
                    manifest=manifest,
                    descriptors=descriptors,
                    proposal_scores=proposal_scores,
                    worklist=worklist,
                    status="running",
                    closure_execution_context=closure_execution_context,
                )
                latest_exact_replay_ledger_remediation = _mapping(
                    summary.get("exact_replay_ledger_remediation")
                )
                continue
            result_path.write_text(
                json.dumps(frontier_payload, indent=2, sort_keys=True),
                encoding="utf-8",
            )
            exact_replay_ledger_ranking = _write_exact_replay_ledger_ranking(
                run_root=run_root,
                program=program,
            )
            exact_replay_ledger_remediation = _write_exact_replay_ledger_remediation(
                run_root=run_root,
                ranking_report=cast(
                    Mapping[str, Any], exact_replay_ledger_ranking["report"]
                ),
            )
            latest_exact_replay_ledger_remediation = _mapping(
                exact_replay_ledger_remediation["report"]
            )
            dataset_snapshot_id = _string(
                _mapping(frontier_payload.get("dataset_snapshot_receipt")).get(
                    "snapshot_id"
                )
            )
            receipt_payload = _mapping(frontier_payload.get("dataset_snapshot_receipt"))
            if receipt_payload:
                tape_freshness_receipts.append(receipt_payload)
            frontier_window = _mapping(frontier_payload.get("window"))
            resolved_full_window_start_date = (
                _string(frontier_window.get("full_window_start_date"))
                or resolved_full_window_start_date
            )
            resolved_full_window_end_date = (
                _string(frontier_window.get("full_window_end_date"))
                or resolved_full_window_end_date
            )
            signal_bundle_stats = _maybe_write_signal_bundle(
                args=args,
                snapshot_symbols=snapshot_symbols,
                bundle_paths=bundle_paths,
                full_window_start_date=resolved_full_window_start_date,
                full_window_end_date=resolved_full_window_end_date,
                existing=signal_bundle_stats,
            )
            manifest = _refresh_manifest()
            exact_replay_by_candidate = _exact_replay_ranking_by_candidate(
                cast(Mapping[str, Any], exact_replay_ledger_ranking["report"])
            )
            top_candidates = cast(
                list[dict[str, Any]], frontier_payload.get("top") or []
            )
            top_candidates = [
                _with_exact_replay_execution_quality(
                    candidate,
                    _exact_replay_candidate_for_payload(
                        candidate_payload=candidate,
                        by_candidate=exact_replay_by_candidate,
                    ),
                )
                for candidate in top_candidates
            ]
            if top_candidates:
                frontier_payload = {**frontier_payload, "top": top_candidates}
            keep_candidates = [
                candidate
                for candidate in top_candidates
                if not bool(_mapping(candidate.get("ranking")).get("vetoed"))
            ]
            frontier_descriptors = [
                descriptor_from_candidate_payload(
                    candidate_payload=candidate,
                    family_plan=current.family_plan,
                )
                for candidate in top_candidates
            ]
            descriptors.extend(frontier_descriptors)
            frontier_candidate_scores = rank_candidate_descriptors(
                descriptors=frontier_descriptors,
                history_rows=history,
                policy=cast(ProposalModelPolicy, program.proposal_model_policy),
            )
            proposal_scores.extend(frontier_candidate_scores)
            frontier_descriptor_by_candidate = {
                item.candidate_id: item for item in frontier_descriptors
            }
            frontier_score_by_candidate = {
                item.candidate_id: item for item in frontier_candidate_scores
            }
            keep_limit = _keep_candidate_limit(
                family_plan=current.family_plan,
                replay_budget_max_candidates_per_round=int(
                    program.replay_budget.max_candidates_per_round
                ),
            )
            non_vetoed_descriptors = [
                frontier_descriptor_by_candidate[_string(candidate.get("candidate_id"))]
                for candidate in keep_candidates
                if _string(candidate.get("candidate_id"))
                in frontier_descriptor_by_candidate
            ]
            non_vetoed_scores = [
                frontier_score_by_candidate[_string(candidate.get("candidate_id"))]
                for candidate in keep_candidates
                if _string(candidate.get("candidate_id")) in frontier_score_by_candidate
            ]
            exploration_slots = min(
                max(0, int(program.proposal_model_policy.exploration_slots)),
                max(0, int(program.replay_budget.exploration_slots)),
            )
            selected_keep_entries = select_proposal_batch(
                descriptors=non_vetoed_descriptors,
                proposal_scores=non_vetoed_scores,
                limit=keep_limit,
                top_k=max(1, int(program.proposal_model_policy.top_k)),
                exploration_slots=exploration_slots,
            )
            if (
                not selected_keep_entries
                and current.family_plan.force_keep_top_candidate_if_all_vetoed
                and top_candidates
            ):
                first_candidate = top_candidates[0]
                first_candidate_id = _string(first_candidate.get("candidate_id"))
                descriptor = frontier_descriptor_by_candidate.get(first_candidate_id)
                score = frontier_score_by_candidate.get(first_candidate_id)
                if descriptor is not None and score is not None:
                    selected_keep_entries = [
                        ProposalSelectionEntry(
                            candidate_id=first_candidate_id,
                            descriptor_id=descriptor.descriptor_id,
                            selection_reason="fallback_force_keep",
                            score=score.score,
                            rank=score.rank,
                            family_template_id=descriptor.family_template_id,
                            side_policy=descriptor.side_policy,
                        )
                    ]
            keep_ids = {item.candidate_id for item in selected_keep_entries}
            keep_reason_by_candidate = {
                item.candidate_id: item.selection_reason
                for item in selected_keep_entries
            }
            for rank, candidate in enumerate(top_candidates, start=1):
                candidate_id = _string(candidate.get("candidate_id"))
                candidate_status = "keep" if candidate_id in keep_ids else "discard"
                candidate_objective_met = candidate_meets_objective(
                    candidate, objective=program.objective
                )
                candidate_descriptor = frontier_descriptor_by_candidate[candidate_id]
                history.append(
                    _history_record(
                        runner_run_id=runner_run_id,
                        experiment_index=experiment_index,
                        family_plan=current.family_plan,
                        iteration=current.iteration,
                        mutation_label=current.mutation_label,
                        parent_candidate_id=current.parent_candidate_id,
                        sweep_config_path=sweep_config_path,
                        result_path=result_path,
                        candidate_payload=candidate,
                        rank=rank,
                        status=candidate_status,
                        objective_met=candidate_objective_met,
                        dataset_snapshot_id=dataset_snapshot_id,
                        descriptor=candidate_descriptor,
                        proposal_score=frontier_score_by_candidate.get(candidate_id),
                        proposal_selected=candidate_id in keep_ids,
                        proposal_selection_reason=keep_reason_by_candidate.get(
                            candidate_id, ""
                        ),
                        disable_other_strategies=bool(
                            current.sweep_config.get("disable_other_strategies", True)
                        ),
                    )
                )
                if candidate_objective_met:
                    objective_met = True
                if candidate_status != "keep":
                    continue
                if current.iteration >= current.family_plan.max_iterations:
                    continue
                next_sweep_config, mutation_label = build_mutated_sweep_config(
                    base_sweep_config=current.sweep_config,
                    candidate_payload=candidate,
                    family_plan=current.family_plan,
                )
                next_sweep_config = apply_program_objective(
                    sweep_config=next_sweep_config,
                    objective=program.objective,
                    holdout_day_count=max(1, int(args.holdout_days)),
                    full_window_day_count=_default_full_window_day_count(args),
                )
                (
                    next_sweep_config,
                    mutation_label,
                ) = _apply_exact_replay_guidance_to_next_sweep(
                    sweep_config=next_sweep_config,
                    mutation_label=mutation_label,
                    remediation_report=latest_exact_replay_ledger_remediation,
                )
                next_sweep_config = _apply_objective_capital_limits(
                    sweep_config=next_sweep_config,
                    max_gross_exposure_pct_equity=program.objective.max_gross_exposure_pct_equity,
                    start_equity=Decimal(str(args.start_equity)),
                )
                worklist.append(
                    WorkItem(
                        family_plan=current.family_plan,
                        iteration=current.iteration + 1,
                        sweep_config=next_sweep_config,
                        mutation_label=mutation_label,
                        parent_candidate_id=candidate_id,
                    )
                )
            summary = _persist_run_outputs(
                run_root=run_root,
                program=program,
                program_payload=program.to_payload(),
                runner_run_id=runner_run_id,
                program_id=program.program_id,
                frontier_runs=frontier_runs,
                objective_met=objective_met,
                history=history,
                manifest=manifest,
                descriptors=descriptors,
                proposal_scores=proposal_scores,
                worklist=worklist,
                status="running",
                closure_execution_context=closure_execution_context,
            )
            latest_exact_replay_ledger_remediation = _mapping(
                summary.get("exact_replay_ledger_remediation")
            )
            if objective_met and program.objective.stop_when_objective_met:
                break
    except Exception as exc:
        return _persist_run_outputs(
            run_root=run_root,
            program=program,
            program_payload=program.to_payload(),
            runner_run_id=runner_run_id,
            program_id=program.program_id,
            frontier_runs=frontier_runs,
            objective_met=objective_met,
            history=history,
            manifest=manifest,
            descriptors=descriptors,
            proposal_scores=proposal_scores,
            worklist=worklist,
            status="error",
            closure_execution_context=closure_execution_context,
            error={
                "type": exc.__class__.__name__,
                "message": str(exc),
            },
        )

    return _persist_run_outputs(
        run_root=run_root,
        program=program,
        program_payload=program.to_payload(),
        runner_run_id=runner_run_id,
        program_id=program.program_id,
        frontier_runs=frontier_runs,
        objective_met=objective_met,
        history=history,
        manifest=manifest,
        descriptors=descriptors,
        proposal_scores=proposal_scores,
        worklist=worklist,
        status="ok",
        closure_execution_context=closure_execution_context,
    )


__all__ = [name for name in globals() if not name.startswith("__")]
