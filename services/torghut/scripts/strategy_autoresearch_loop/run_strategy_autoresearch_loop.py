#!/usr/bin/env python3
"""Run an autoresearch-style outer loop for Torghut strategy discovery."""

from __future__ import annotations

import argparse
import json
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping, cast

import yaml

from app.trading.discovery.autoresearch import (
    ProposalModelPolicy,
    apply_program_objective,
    load_strategy_autoresearch_program,
    run_id,
    stable_payload_hash,
)
from app.trading.discovery.mlx_features import (
    MlxCandidateDescriptor,
    descriptor_from_sweep_config,
)
from app.trading.discovery.mlx_proposal_models import (
    ProposalScore,
    ProposalSelectionEntry,
    rank_candidate_descriptors,
)
from app.trading.discovery.mlx_snapshot import (
    MlxSignalBundleStats,
    MlxSnapshotManifest,
    build_mlx_snapshot_manifest,
)
from app.trading.discovery.runtime_closure import RuntimeClosureExecutionContext
from scripts.search_consistent_profitability_frontier import (
    run_consistent_profitability_frontier,
)


from .candidate_processing import CandidateBatchRequest, process_candidate_batch
from .completion_semantics import append_search_decision
from .shared_context import (
    WorkItem,
    _apply_objective_capital_limits,
    _float,
    _frontier_args,
    _mapping,
    _mlx_bundle_paths,
    _runtime_missing_candidate_payload,
    _runtime_missing_frontier_payload,
    _slug,
    _snapshot_symbols,
    _string,
    _work_item_candidate_id,
)
from .load_yaml import (
    _default_full_window_day_count,
    _history_record,
    _load_yaml,
    _maybe_materialize_run_replay_tape,
    _maybe_write_signal_bundle,
    _provided_replay_tape_receipt,
)
from .run_checkpoint import (
    RunCheckpointSnapshot,
    execution_contract_digest,
    load_run_checkpoint,
    read_uncommitted_lifecycle_decisions,
    write_run_checkpoint,
)
from .write_portfolio_outputs import (
    _exact_replay_candidate_for_payload,
    _exact_replay_ranking_by_candidate,
    _persist_run_outputs,
    _with_exact_replay_execution_quality,
    _write_exact_replay_ledger_ranking,
    _write_exact_replay_ledger_remediation,
)


_EXPECTED_RUN_ERRORS = (
    ArithmeticError,
    OSError,
    RuntimeError,
    TypeError,
    ValueError,
    yaml.YAMLError,
)


def run_strategy_autoresearch_loop(args: argparse.Namespace) -> dict[str, Any]:
    program = load_strategy_autoresearch_program(
        args.program.resolve(),
        family_dir=args.family_template_dir.resolve(),
    )
    program_payload = program.to_payload()
    contract_digest = execution_contract_digest(
        args=args,
        program_payload=program_payload,
        family_plans=program.families,
    )
    resume_run_root = getattr(args, "resume_run_root", None)
    restored_state = None
    if resume_run_root is not None:
        run_root = Path(resume_run_root).resolve()
        restored_state = load_run_checkpoint(
            run_root=run_root,
            program_id=program.program_id,
            program_payload=program_payload,
            contract_digest=contract_digest,
            family_plans=program.families,
        )
        if restored_state.status == "completed":
            summary_path = run_root / "summary.json"
            if not summary_path.is_file():
                raise ValueError(
                    f"autoresearch_completed_summary_missing:{summary_path}"
                )
            return cast(
                dict[str, Any], json.loads(summary_path.read_text(encoding="utf-8"))
            )
        runner_run_id = restored_state.runner_run_id
    else:
        output_dir = getattr(args, "output_dir", None)
        if output_dir is None:
            raise ValueError("autoresearch_output_dir_missing")
        runner_run_id = run_id("strategy-autoresearch")
        run_root = Path(output_dir).resolve() / runner_run_id
    run_root.mkdir(parents=True, exist_ok=True)
    (run_root / "experiments").mkdir(parents=True, exist_ok=True)

    if restored_state is None:
        worklist: list[WorkItem] = []
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
                max_gross_exposure_pct_equity=(
                    program.objective.max_gross_exposure_pct_equity
                ),
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
        seen_sweeps: set[str] = set()
        seen_candidate_ids: set[str] = set()
        history: list[dict[str, Any]] = []
        descriptors: list[MlxCandidateDescriptor] = []
        proposal_scores: list[ProposalScore] = []
        search_decisions: list[dict[str, Any]] = []
        tape_freshness_receipts: list[dict[str, Any]] = []
        snapshot_symbols = _snapshot_symbols(args=args, worklist=worklist)
        resolved_full_window_start_date = _string(args.full_window_start_date)
        resolved_full_window_end_date = _string(args.full_window_end_date)
        effective_expected_last_trading_day = _string(args.expected_last_trading_day)
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
        checkpoint_generation = 0
        setup_complete = False
        if effective_replay_tape_path is not None:
            provided_receipt = _provided_replay_tape_receipt(
                tape_path=effective_replay_tape_path,
                manifest_path=effective_replay_tape_manifest,
            )
            if provided_receipt is not None:
                tape_freshness_receipts.append(provided_receipt)
    else:
        worklist = restored_state.worklist
        seen_sweeps = restored_state.seen_sweeps
        seen_candidate_ids = restored_state.seen_candidate_ids
        history = restored_state.history
        descriptors = restored_state.descriptors
        proposal_scores = restored_state.proposal_scores
        search_decisions = restored_state.search_decisions
        tape_freshness_receipts = restored_state.tape_freshness_receipts
        snapshot_symbols = restored_state.snapshot_symbols
        resolved_full_window_start_date = restored_state.resolved_full_window_start_date
        resolved_full_window_end_date = restored_state.resolved_full_window_end_date
        effective_expected_last_trading_day = (
            restored_state.effective_expected_last_trading_day
        )
        signal_bundle_stats = restored_state.signal_bundle_stats
        effective_replay_tape_path = restored_state.effective_replay_tape_path
        effective_replay_tape_manifest = restored_state.effective_replay_tape_manifest
        checkpoint_generation = restored_state.generation
        setup_complete = restored_state.setup_complete
        for lifecycle_record in read_uncommitted_lifecycle_decisions(
            run_root=run_root,
            committed_count=len(search_decisions),
        ):
            append_search_decision(
                search_decisions,
                event_type="run",
                action=str(lifecycle_record.get("action") or "stop"),
                reason=str(lifecycle_record.get("reason") or "run_interrupted"),
                context={
                    key: value
                    for key, value in lifecycle_record.items()
                    if key not in {"sequence", "event_type", "action", "reason"}
                },
            )
        append_search_decision(
            search_decisions,
            event_type="run",
            action="continue",
            reason="run_resumed_from_checkpoint",
            context={"checkpoint_generation": checkpoint_generation},
        )

    termination: dict[str, Any] = {
        "event_type": "run",
        "action": "continue",
        "reason": "run_in_progress",
    }
    bundle_paths = _mlx_bundle_paths(run_root)
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

    def _commit_checkpoint(*, status: str) -> Path:
        nonlocal checkpoint_generation
        checkpoint_generation += 1
        return write_run_checkpoint(
            run_root=run_root,
            snapshot=RunCheckpointSnapshot(
                status=status,
                generation=checkpoint_generation,
                setup_complete=setup_complete,
                program_id=program.program_id,
                program_payload=program_payload,
                contract_digest=contract_digest,
                runner_run_id=runner_run_id,
                frontier_runs=frontier_runs,
                objective_met=objective_met,
                worklist=worklist,
                seen_sweeps=seen_sweeps,
                seen_candidate_ids=seen_candidate_ids,
                history=history,
                descriptors=descriptors,
                proposal_scores=proposal_scores,
                search_decisions=search_decisions,
                termination=termination,
                tape_freshness_receipts=tape_freshness_receipts,
                snapshot_symbols=snapshot_symbols,
                resolved_full_window_start_date=resolved_full_window_start_date,
                resolved_full_window_end_date=resolved_full_window_end_date,
                effective_expected_last_trading_day=(
                    effective_expected_last_trading_day
                ),
                signal_bundle_stats=signal_bundle_stats,
                effective_replay_tape_path=effective_replay_tape_path,
                effective_replay_tape_manifest=effective_replay_tape_manifest,
            ),
        )

    manifest = _refresh_manifest()
    frontier_runs = restored_state.frontier_runs if restored_state is not None else 0
    objective_met = (
        restored_state.objective_met if restored_state is not None else False
    )
    latest_exact_replay_ledger_remediation: dict[str, Any] = {}
    _commit_checkpoint(status="running")

    def _persist_failure(
        *,
        status: str,
        reason: str,
        error: BaseException,
    ) -> dict[str, Any]:
        nonlocal termination
        context: dict[str, Any] = {"frontier_run_count": frontier_runs}
        if reason == "run_error":
            context["error_type"] = error.__class__.__name__
        termination = append_search_decision(
            search_decisions,
            event_type="run",
            action="stop",
            reason=reason,
            context=context,
        )
        return _persist_run_outputs(
            run_root=run_root,
            program=program,
            program_payload=program_payload,
            runner_run_id=runner_run_id,
            program_id=program.program_id,
            frontier_runs=frontier_runs,
            objective_met=objective_met,
            history=history,
            manifest=manifest,
            descriptors=descriptors,
            proposal_scores=proposal_scores,
            worklist=worklist,
            status=status,
            search_decisions=search_decisions,
            termination=termination,
            closure_execution_context=closure_execution_context,
            error={
                "type": error.__class__.__name__,
                "message": str(error),
            },
        )

    try:
        summary = _persist_run_outputs(
            run_root=run_root,
            program=program,
            program_payload=program_payload,
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
            search_decisions=search_decisions,
            termination=termination,
            closure_execution_context=closure_execution_context,
        )
        latest_exact_replay_ledger_remediation = _mapping(
            summary.get("exact_replay_ledger_remediation")
        )
        materialized_replay_tape_receipt: dict[str, Any] | None = None
        if not setup_complete:
            signal_bundle_stats, materialized_replay_tape_receipt = (
                _maybe_materialize_run_replay_tape(
                    args=args,
                    runner_run_id=runner_run_id,
                    snapshot_symbols=snapshot_symbols,
                    bundle_paths=bundle_paths,
                    full_window_start_date=resolved_full_window_start_date,
                    full_window_end_date=resolved_full_window_end_date,
                    existing_signal_bundle=signal_bundle_stats,
                    objective_min_observed_trading_days=(
                        program.objective.min_observed_trading_days
                    ),
                )
            )
        if materialized_replay_tape_receipt is not None:
            tape_freshness_receipts.append(materialized_replay_tape_receipt)
            effective_replay_tape_path = Path(
                materialized_replay_tape_receipt["tape_path"]
            )
            effective_replay_tape_manifest = Path(
                materialized_replay_tape_receipt["manifest_path"]
            )
            resolved_full_window_start_date = (
                _string(
                    materialized_replay_tape_receipt.get(
                        "effective_full_window_start_date"
                    )
                )
                or resolved_full_window_start_date
            )
            resolved_full_window_end_date = (
                _string(
                    materialized_replay_tape_receipt.get(
                        "effective_full_window_end_date"
                    )
                )
                or resolved_full_window_end_date
            )
            effective_expected_last_trading_day = resolved_full_window_end_date
        if not setup_complete:
            signal_bundle_stats = _maybe_write_signal_bundle(
                args=args,
                snapshot_symbols=snapshot_symbols,
                bundle_paths=bundle_paths,
                full_window_start_date=resolved_full_window_start_date,
                full_window_end_date=resolved_full_window_end_date,
                existing=signal_bundle_stats,
            )
        setup_complete = True
        frontier_base_args = argparse.Namespace(
            **{
                **vars(args),
                "full_window_start_date": resolved_full_window_start_date,
                "full_window_end_date": resolved_full_window_end_date,
                "expected_last_trading_day": effective_expected_last_trading_day,
                "replay_tape_path": effective_replay_tape_path,
                "replay_tape_manifest": effective_replay_tape_manifest,
            }
        )
        manifest = _refresh_manifest()
        summary = _persist_run_outputs(
            run_root=run_root,
            program=program,
            program_payload=program_payload,
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
            search_decisions=search_decisions,
            termination=termination,
            closure_execution_context=closure_execution_context,
        )
        latest_exact_replay_ledger_remediation = _mapping(
            summary.get("exact_replay_ledger_remediation")
        )
        _commit_checkpoint(status="running")
    except KeyboardInterrupt as exc:
        return _persist_failure(
            status="interrupted",
            reason="run_interrupted",
            error=exc,
        )
    except _EXPECTED_RUN_ERRORS as exc:
        return _persist_failure(status="error", reason="run_error", error=exc)
    try:
        while worklist:
            if int(args.max_frontier_runs) > 0 and frontier_runs >= int(
                args.max_frontier_runs
            ):
                termination = append_search_decision(
                    search_decisions,
                    event_type="loop",
                    action="stop",
                    reason="max_frontier_runs_reached",
                    context={
                        "frontier_run_count": frontier_runs,
                        "pending_work_item_count": len(worklist),
                    },
                )
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
                append_search_decision(
                    search_decisions,
                    event_type="sweep",
                    action="continue",
                    reason="duplicate_sweep_identity",
                    context={
                        "family_template_id": current.family_plan.family_template.family_id,
                        "iteration": current.iteration,
                        "sweep_hash": sweep_hash,
                    },
                )
                _commit_checkpoint(status="running")
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
                search_decisions=search_decisions,
                termination=termination,
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
                append_search_decision(
                    search_decisions,
                    event_type="frontier",
                    action="continue",
                    reason="runtime_strategy_missing",
                    context={
                        "experiment_index": experiment_index,
                        "candidate_id": current_descriptor.candidate_id,
                        "detail": status_reason,
                    },
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
                        raw_objective_met=False,
                        terminal_validation_status="invalid",
                        terminal_validation_reason="runtime_strategy_missing",
                        search_action="continue",
                        search_reason="runtime_strategy_missing",
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
                    search_decisions=search_decisions,
                    termination=termination,
                    closure_execution_context=closure_execution_context,
                )
                latest_exact_replay_ledger_remediation = _mapping(
                    summary.get("exact_replay_ledger_remediation")
                )
                _commit_checkpoint(status="running")
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
            candidate_outcome = process_candidate_batch(
                CandidateBatchRequest(
                    candidates=top_candidates,
                    current=current,
                    program=program,
                    existing_history=history,
                    existing_seen_candidate_ids=seen_candidate_ids,
                    search_decision_offset=len(search_decisions),
                    runner_run_id=runner_run_id,
                    experiment_index=experiment_index,
                    sweep_config_path=sweep_config_path,
                    result_path=result_path,
                    dataset_snapshot_id=dataset_snapshot_id,
                    latest_exact_replay_ledger_remediation=(
                        latest_exact_replay_ledger_remediation
                    ),
                    start_equity=Decimal(str(args.start_equity)),
                    holdout_days=int(args.holdout_days),
                    full_window_day_count=_default_full_window_day_count(args),
                )
            )
            descriptors.extend(candidate_outcome.descriptors)
            proposal_scores.extend(candidate_outcome.proposal_scores)
            history.extend(candidate_outcome.history_records)
            search_decisions.extend(candidate_outcome.search_decisions)
            worklist.extend(candidate_outcome.continuation_work)
            seen_candidate_ids.update(candidate_outcome.seen_candidate_ids)
            if candidate_outcome.objective_met:
                objective_met = True
            if candidate_outcome.termination is not None:
                termination = candidate_outcome.termination
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
                search_decisions=search_decisions,
                termination=termination,
                closure_execution_context=closure_execution_context,
            )
            latest_exact_replay_ledger_remediation = _mapping(
                summary.get("exact_replay_ledger_remediation")
            )
            _commit_checkpoint(status="running")
            if objective_met and program.objective.stop_when_objective_met:
                break
    except KeyboardInterrupt as exc:
        return _persist_failure(
            status="interrupted",
            reason="run_interrupted",
            error=exc,
        )
    except _EXPECTED_RUN_ERRORS as exc:
        return _persist_failure(status="error", reason="run_error", error=exc)

    if termination.get("reason") == "run_in_progress":
        termination = append_search_decision(
            search_decisions,
            event_type="loop",
            action="stop",
            reason="worklist_exhausted",
            context={"frontier_run_count": frontier_runs},
        )
    final_summary = _persist_run_outputs(
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
        search_decisions=search_decisions,
        termination=termination,
        closure_execution_context=closure_execution_context,
    )
    _commit_checkpoint(status="completed")
    return final_summary


__all__ = ("run_strategy_autoresearch_loop",)
