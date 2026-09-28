#!/usr/bin/env python3
"""Orchestrate consistent profitability frontier candidate evaluation."""

from __future__ import annotations

import argparse
import contextlib
import tempfile
from collections import deque
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping, Sequence, cast

import yaml

from app.trading.reporting import score_replay_profitability_candidate
from scripts.local_intraday_tsmom_replay import run_replay
from scripts.search_profitability_frontier import _build_replay_config

from scripts.consistent_profitability_frontier.candidate_generation import (
    _candidate_evaluation_key_payload,
    _candidate_search_key,
    _candidate_symbols,
    _iter_initial_worklist_candidates,
)
from scripts.consistent_profitability_frontier.candidate_loading import (
    _SAFE_EXACT_REPLAY_CANDIDATE_CAP,
    _SAFE_LOCAL_EXACT_REPLAY_WORKERS,
    _WorklistItem,
    _candidate_replay_lineage_payload,
    _safe_exact_replay_candidate_budget,
    _staged_search_budget_payload,
)
from scripts.consistent_profitability_frontier.candidate_repairs import (
    _generate_consistency_repair_children,
    _generate_loss_repair_children,
    _generate_symbol_prune_children,
)
from scripts.consistent_profitability_frontier.candidate_scorecards import (
    CandidateScorecardInput,
    attach_candidate_objective_scorecard,
)
from scripts.consistent_profitability_frontier.common import _write_json_output
from scripts.consistent_profitability_frontier.handoff_diagnostics import (
    _train_gate_diagnostics_from_replay_payload,
)
from scripts.consistent_profitability_frontier.ledger_order import (
    _exact_replay_ledger_artifact_update,
    _order_type_ablation_artifact_dir,
    _order_type_ablation_payload,
)
from scripts.consistent_profitability_frontier.replay_data import (
    _cached_signal_rows_patch,
    _prefetch_signal_rows,
    apply_candidate_to_configmap_with_overrides,
)
from scripts.consistent_profitability_frontier.scoring_ranking import (
    _empty_replay_payload,
    _enqueue_ranked_train_screen_survivors,
    _positive_train_screen_candidate,
    _train_screen_failures,
)
from scripts.consistent_profitability_frontier.stress_metrics import (
    _consistency_penalty,
    _second_oos_summary,
)
from scripts.consistent_profitability_frontier.workflow_setup import (
    load_frontier_run_setup,
)
from scripts.consistent_profitability_frontier.workflow_output import (
    FrontierPayloadProgress,
    write_final_frontier_payload,
    write_running_frontier_payload,
)


def run_consistent_profitability_frontier(args: argparse.Namespace) -> dict[str, Any]:
    setup = load_frontier_run_setup(args)
    clickhouse_password = setup.clickhouse_password
    window = setup.window
    full_window_start = setup.full_window_start
    full_window_end = setup.full_window_end
    base_configmap = setup.base_configmap
    family = setup.family
    strategy_name = setup.strategy_name
    family_template = setup.family_template
    disable_other_strategies = setup.disable_other_strategies
    parameter_grid = setup.parameter_grid
    override_candidates = setup.override_candidates
    seed_candidates = setup.seed_candidates
    prefetch_symbols = setup.prefetch_symbols
    dataset_snapshot_receipt = setup.dataset_snapshot_receipt
    cached_rows = setup.cached_rows
    replay_tape_validation = setup.replay_tape_validation
    holdout_policy = setup.holdout_policy
    consistency_policy = setup.consistency_policy
    order_type_ablation_policy = setup.order_type_ablation_policy
    max_train_screen_worst_day_loss = setup.max_train_screen_worst_day_loss
    min_train_screen_net_per_day = setup.min_train_screen_net_per_day
    min_train_screen_active_ratio = setup.min_train_screen_active_ratio
    symbols = setup.symbols
    objective_veto_policy = setup.objective_veto_policy
    collect_train_gate_diagnostics = setup.collect_train_gate_diagnostics

    scored: list[dict[str, Any]] = []

    with tempfile.TemporaryDirectory(
        prefix="torghut-consistent-profitability-frontier-"
    ) as tmpdir:
        root = Path(tmpdir)
        order_type_ablation_artifact_dir = _order_type_ablation_artifact_dir(
            args=args,
            root=root,
        )
        order_type_ablation_evaluated = 0
        if cached_rows is None and args.prefetch_full_window_rows:
            cached_rows = _prefetch_signal_rows(
                strategy_configmap_path=args.strategy_configmap.resolve(),
                clickhouse_http_url=str(args.clickhouse_http_url),
                clickhouse_username=(str(args.clickhouse_username).strip() or None),
                clickhouse_password=clickhouse_password,
                start_date=full_window_start,
                end_date=full_window_end,
                start_equity=Decimal(str(args.start_equity)),
                chunk_minutes=max(1, int(args.chunk_minutes)),
                symbols=prefetch_symbols,
                progress_log_interval_seconds=max(1, int(args.progress_log_seconds)),
            )
        candidate_index = 0
        candidate_budget = _safe_exact_replay_candidate_budget(
            getattr(
                args, "max_candidates_to_evaluate", _SAFE_EXACT_REPLAY_CANDIDATE_CAP
            )
        )
        staged_search = _staged_search_budget_payload(
            args=args,
            candidate_budget=candidate_budget,
        )
        train_screen_candidate_budget = int(
            staged_search["train_screen_candidate_budget"]
        )
        full_replay_candidate_budget = int(
            staged_search["full_replay_candidate_budget"]
        )
        staged_train_survivor_ranking_enabled = bool(staged_search["enabled"])
        train_screen_candidates_started = 0
        full_replay_candidates_started = 0
        train_screen_only_candidates = 0
        full_replay_budget_discarded_candidates = 0
        proof_only_full_window_replay_captures = 0
        deferred_train_survivors: list[_WorklistItem] = []
        deferred_train_survivors_enqueued = False
        initial_candidates = _iter_initial_worklist_candidates(
            parameter_grid=parameter_grid,
            override_candidates=override_candidates,
            seed_candidates=seed_candidates,
        )
        initial_candidates_exhausted = False
        worklist: deque[_WorklistItem] = deque()
        seen_candidate_keys: set[str] = set()
        cache_context: contextlib.AbstractContextManager[None]
        cache_context = (
            _cached_signal_rows_patch(cached_rows)
            if cached_rows is not None
            else contextlib.nullcontext()
        )
        with cache_context:
            budget_exhausted = False
            while True:
                fresh_train_budget_exhausted = (
                    train_screen_candidate_budget > 0
                    and train_screen_candidates_started >= train_screen_candidate_budget
                )
                if (
                    staged_train_survivor_ranking_enabled
                    and not deferred_train_survivors_enqueued
                    and (
                        fresh_train_budget_exhausted
                        or (initial_candidates_exhausted and not worklist)
                    )
                ):
                    _enqueue_ranked_train_screen_survivors(
                        worklist=worklist,
                        survivors=deferred_train_survivors,
                        full_replay_candidate_budget=full_replay_candidate_budget,
                    )
                    deferred_train_survivors_enqueued = True
                    budget_exhausted = fresh_train_budget_exhausted

                allow_fresh_train_candidate = (
                    not staged_train_survivor_ranking_enabled
                    or not fresh_train_budget_exhausted
                )
                seed_initial_candidate = (
                    allow_fresh_train_candidate
                    and not initial_candidates_exhausted
                    and (not worklist or len(scored) % 2 == 0)
                )
                if seed_initial_candidate:
                    try:
                        next_initial = next(initial_candidates)
                    except StopIteration:
                        initial_candidates_exhausted = True
                    else:
                        if worklist:
                            worklist.appendleft(next_initial)
                        else:
                            worklist.append(next_initial)
                if not worklist:
                    break
                if (
                    staged_train_survivor_ranking_enabled
                    and fresh_train_budget_exhausted
                    and deferred_train_survivors_enqueued
                    and worklist[0].deferred_train_payload is None
                ):
                    budget_exhausted = True
                    break
                if (
                    not staged_train_survivor_ranking_enabled
                    and train_screen_candidate_budget > 0
                    and train_screen_candidates_started >= train_screen_candidate_budget
                ):
                    budget_exhausted = True
                    break
                worklist_item = worklist.popleft()
                params_candidate = worklist_item.params_candidate
                override_candidate = worklist_item.strategy_overrides
                deferred_train_survivor = (
                    worklist_item.deferred_train_payload is not None
                )
                candidate_key = (
                    str(worklist_item.deferred_candidate_key)
                    if deferred_train_survivor
                    and worklist_item.deferred_candidate_key is not None
                    else _candidate_search_key(
                        params_candidate=params_candidate,
                        strategy_overrides=override_candidate,
                    )
                )
                if deferred_train_survivor:
                    current_candidate_index = int(
                        worklist_item.deferred_candidate_index or candidate_index + 1
                    )
                else:
                    if candidate_key in seen_candidate_keys:
                        continue
                    seen_candidate_keys.add(candidate_key)
                    candidate_index += 1
                    current_candidate_index = candidate_index
                candidate_symbols = _candidate_symbols(
                    cli_symbols=symbols,
                    strategy_overrides=override_candidate,
                )
                candidate_configmap = apply_candidate_to_configmap_with_overrides(
                    configmap_payload=base_configmap,
                    strategy_name=strategy_name,
                    candidate_params=params_candidate,
                    strategy_overrides=override_candidate,
                    disable_other_strategies=disable_other_strategies,
                )
                candidate_configmap_path = (
                    root / f"candidate-{current_candidate_index:04d}.yaml"
                )
                candidate_configmap_path.write_text(
                    yaml.safe_dump(candidate_configmap, sort_keys=False),
                    encoding="utf-8",
                )

                if deferred_train_survivor:
                    train_payload = dict(
                        cast(Mapping[str, Any], worklist_item.deferred_train_payload)
                    )
                    train_screen_failures: list[str] = []
                else:
                    train_payload = run_replay(
                        _build_replay_config(
                            strategy_configmap_path=candidate_configmap_path,
                            clickhouse_http_url=str(args.clickhouse_http_url),
                            clickhouse_username=(
                                str(args.clickhouse_username).strip() or None
                            ),
                            clickhouse_password=clickhouse_password,
                            start_date=window.train_start,
                            end_date=window.train_end,
                            start_equity=Decimal(str(args.start_equity)),
                            chunk_minutes=max(1, int(args.chunk_minutes)),
                            symbols=candidate_symbols,
                            progress_log_interval_seconds=max(
                                1, int(args.progress_log_seconds)
                            ),
                            capture_trace_funnel=collect_train_gate_diagnostics,
                        )
                    )
                    train_screen_candidates_started += 1
                    train_screen_failures = (
                        _train_screen_failures(
                            train_payload=train_payload,
                            holdout_policy=holdout_policy,
                            consistency_policy=consistency_policy,
                            min_train_net_per_day=min_train_screen_net_per_day,
                            min_train_active_ratio=min_train_screen_active_ratio,
                            max_train_worst_day_loss=max_train_screen_worst_day_loss,
                        )
                        if bool(getattr(args, "train_screening", True))
                        else []
                    )
                    if (
                        staged_train_survivor_ranking_enabled
                        and not train_screen_failures
                    ):
                        deferred_train_survivors.append(
                            _WorklistItem(
                                params_candidate=dict(params_candidate),
                                strategy_overrides=dict(override_candidate),
                                candidate_record_seed=worklist_item.candidate_record_seed,
                                symbol_prune_iteration=(
                                    worklist_item.symbol_prune_iteration
                                ),
                                loss_repair_iteration=(
                                    worklist_item.loss_repair_iteration
                                ),
                                consistency_repair_iteration=(
                                    worklist_item.consistency_repair_iteration
                                ),
                                pruned_symbol=worklist_item.pruned_symbol,
                                repair_reason=worklist_item.repair_reason,
                                parent_candidate_id=worklist_item.parent_candidate_id,
                                deferred_candidate_index=current_candidate_index,
                                deferred_candidate_key=candidate_key,
                                deferred_train_payload=train_payload,
                            )
                        )
                        continue
                full_replay_budget_exhausted = (
                    not worklist_item.deferred_full_replay_selected
                    if deferred_train_survivor
                    else (
                        not train_screen_failures
                        and full_replay_candidate_budget > 0
                        and full_replay_candidates_started
                        >= full_replay_candidate_budget
                    )
                )
                full_replay_skip_reasons = (
                    ["full_replay_candidate_budget_exhausted"]
                    if full_replay_budget_exhausted
                    else []
                )
                holdout_replay_skipped = bool(
                    train_screen_failures or full_replay_skip_reasons
                )
                full_window_replay_skipped = bool(
                    train_screen_failures or full_replay_skip_reasons
                )
                proof_only_full_window_replay_captured = False
                proof_only_full_window_reason = ""
                if holdout_replay_skipped:
                    if train_screen_failures:
                        train_screen_only_candidates += 1
                    if full_replay_skip_reasons:
                        full_replay_budget_discarded_candidates += 1
                        budget_exhausted = True
                    second_oos_start = window.second_oos_start
                    second_oos_end = window.second_oos_end
                    holdout_payload = _empty_replay_payload(
                        start_date=window.holdout_start,
                        end_date=window.holdout_end,
                    )
                    second_oos_payload = (
                        _empty_replay_payload(
                            start_date=second_oos_start,
                            end_date=second_oos_end,
                        )
                        if second_oos_start is not None and second_oos_end is not None
                        else None
                    )
                    capture_rejected_seed_ledger = (
                        bool(
                            getattr(
                                args,
                                "capture_rejected_seed_full_window_ledger",
                                False,
                            )
                        )
                        and worklist_item.candidate_record_seed
                        and bool(train_screen_failures)
                    )
                    top_rejected_capture_budget = max(
                        0,
                        int(
                            getattr(
                                args,
                                "capture_positive_rejected_full_window_ledgers",
                                0,
                            )
                            or 0
                        ),
                    )
                    capture_ranked_rejected_ledger = (
                        proof_only_full_window_replay_captures
                        < top_rejected_capture_budget
                        and _positive_train_screen_candidate(train_payload)
                    )
                    if capture_rejected_seed_ledger or capture_ranked_rejected_ledger:
                        full_replay_candidates_started += 1
                        proof_only_full_window_replay_captures += 1
                        proof_only_full_window_replay_captured = True
                        full_window_replay_skipped = False
                        proof_only_full_window_reason = (
                            "train_screen_rejected_candidate_record_seed"
                            if capture_rejected_seed_ledger
                            else (
                                "full_replay_budget_exhausted_positive_train_screen"
                                if full_replay_skip_reasons
                                else "positive_train_screen_reject"
                            )
                        )
                        full_window_payload = run_replay(
                            _build_replay_config(
                                strategy_configmap_path=candidate_configmap_path,
                                clickhouse_http_url=str(args.clickhouse_http_url),
                                clickhouse_username=(
                                    str(args.clickhouse_username).strip() or None
                                ),
                                clickhouse_password=clickhouse_password,
                                start_date=full_window_start,
                                end_date=full_window_end,
                                start_equity=Decimal(str(args.start_equity)),
                                chunk_minutes=max(1, int(args.chunk_minutes)),
                                symbols=candidate_symbols,
                                progress_log_interval_seconds=max(
                                    1, int(args.progress_log_seconds)
                                ),
                                capture_trace_funnel=collect_train_gate_diagnostics,
                                capture_exact_replay_ledger=True,
                            )
                        )
                    else:
                        full_window_payload = train_payload
                else:
                    full_replay_candidates_started += 1
                    holdout_payload = run_replay(
                        _build_replay_config(
                            strategy_configmap_path=candidate_configmap_path,
                            clickhouse_http_url=str(args.clickhouse_http_url),
                            clickhouse_username=(
                                str(args.clickhouse_username).strip() or None
                            ),
                            clickhouse_password=clickhouse_password,
                            start_date=window.holdout_start,
                            end_date=window.holdout_end,
                            start_equity=Decimal(str(args.start_equity)),
                            chunk_minutes=max(1, int(args.chunk_minutes)),
                            symbols=candidate_symbols,
                            progress_log_interval_seconds=max(
                                1, int(args.progress_log_seconds)
                            ),
                            capture_trace_funnel=collect_train_gate_diagnostics,
                        )
                    )
                    second_oos_payload = None
                    if window.second_oos_days:
                        second_oos_start = window.second_oos_start
                        second_oos_end = window.second_oos_end
                        if second_oos_start is None or second_oos_end is None:
                            raise ValueError("second_oos_window_missing")
                        second_oos_payload = run_replay(
                            _build_replay_config(
                                strategy_configmap_path=candidate_configmap_path,
                                clickhouse_http_url=str(args.clickhouse_http_url),
                                clickhouse_username=(
                                    str(args.clickhouse_username).strip() or None
                                ),
                                clickhouse_password=clickhouse_password,
                                start_date=second_oos_start,
                                end_date=second_oos_end,
                                start_equity=Decimal(str(args.start_equity)),
                                chunk_minutes=max(1, int(args.chunk_minutes)),
                                symbols=candidate_symbols,
                                progress_log_interval_seconds=max(
                                    1, int(args.progress_log_seconds)
                                ),
                                capture_trace_funnel=collect_train_gate_diagnostics,
                            )
                        )
                    full_window_payload = run_replay(
                        _build_replay_config(
                            strategy_configmap_path=candidate_configmap_path,
                            clickhouse_http_url=str(args.clickhouse_http_url),
                            clickhouse_username=(
                                str(args.clickhouse_username).strip() or None
                            ),
                            clickhouse_password=clickhouse_password,
                            start_date=full_window_start,
                            end_date=full_window_end,
                            start_equity=Decimal(str(args.start_equity)),
                            chunk_minutes=max(1, int(args.chunk_minutes)),
                            symbols=candidate_symbols,
                            progress_log_interval_seconds=max(
                                1, int(args.progress_log_seconds)
                            ),
                            capture_trace_funnel=collect_train_gate_diagnostics,
                            capture_exact_replay_ledger=True,
                        )
                    )

                base_result = score_replay_profitability_candidate(
                    family=family,
                    strategy_name=strategy_name,
                    replay_config={
                        "candidate_index": current_candidate_index,
                        "params": params_candidate,
                        "strategy_overrides": override_candidate,
                        "train_start_date": window.train_start.isoformat(),
                        "train_end_date": window.train_end.isoformat(),
                        "holdout_start_date": window.holdout_start.isoformat(),
                        "holdout_end_date": window.holdout_end.isoformat(),
                        "full_window_start_date": full_window_start.isoformat(),
                        "full_window_end_date": full_window_end.isoformat(),
                    },
                    train_payload=train_payload,
                    holdout_payload=holdout_payload,
                    policy=holdout_policy,
                )
                consistency_penalty, full_window_summary = _consistency_penalty(
                    full_window_payload=full_window_payload,
                    policy=consistency_policy,
                )
                second_oos_penalty = Decimal("0")
                second_oos_summary: dict[str, Any] | None = None
                if second_oos_payload is not None:
                    second_oos_penalty, second_oos_summary = _second_oos_summary(
                        second_oos_payload=second_oos_payload,
                        policy=consistency_policy,
                    )
                adjusted_score = (
                    base_result.score
                    + Decimal(full_window_summary["net_per_day"])
                    - consistency_penalty
                    - second_oos_penalty
                )
                candidate_payload = base_result.to_payload()
                exact_replay_ledger_update: dict[str, Any] = {}
                order_type_ablation_update: dict[str, Any] = {}
                if (
                    order_type_ablation_policy.enabled
                    and not full_window_replay_skipped
                    and not proof_only_full_window_replay_captured
                    and order_type_ablation_evaluated
                    < order_type_ablation_policy.max_candidates
                ):
                    order_type_arm_payloads: dict[str, Mapping[str, Any]] = {}
                    for forced_order_type in ("market", "limit"):
                        arm_configmap = apply_candidate_to_configmap_with_overrides(
                            configmap_payload=base_configmap,
                            strategy_name=strategy_name,
                            candidate_params={
                                **params_candidate,
                                "entry_order_type": forced_order_type,
                            },
                            strategy_overrides=override_candidate,
                            disable_other_strategies=disable_other_strategies,
                        )
                        arm_configmap_path = (
                            root
                            / f"candidate-{current_candidate_index:04d}-order-type-{forced_order_type}.yaml"
                        )
                        arm_configmap_path.write_text(
                            yaml.safe_dump(arm_configmap, sort_keys=False),
                            encoding="utf-8",
                        )
                        order_type_arm_payloads[forced_order_type] = run_replay(
                            _build_replay_config(
                                strategy_configmap_path=arm_configmap_path,
                                clickhouse_http_url=str(args.clickhouse_http_url),
                                clickhouse_username=(
                                    str(args.clickhouse_username).strip() or None
                                ),
                                clickhouse_password=clickhouse_password,
                                start_date=full_window_start,
                                end_date=full_window_end,
                                start_equity=Decimal(str(args.start_equity)),
                                chunk_minutes=max(1, int(args.chunk_minutes)),
                                symbols=candidate_symbols,
                                progress_log_interval_seconds=max(
                                    1, int(args.progress_log_seconds)
                                ),
                            )
                        )
                    artifact_payload, order_type_ablation_update = (
                        _order_type_ablation_payload(
                            candidate_index=current_candidate_index,
                            candidate_id=str(candidate_payload["candidate_id"]),
                            policy=order_type_ablation_policy,
                            candidate_params=params_candidate,
                            strategy_overrides=override_candidate,
                            market_payload=order_type_arm_payloads["market"],
                            limit_payload=order_type_arm_payloads["limit"],
                            start_date=full_window_start,
                            end_date=full_window_end,
                        )
                    )
                    artifact_path = (
                        order_type_ablation_artifact_dir
                        / f"candidate-{current_candidate_index:04d}-order-type-ablation.json"
                    )
                    artifact_ref = str(artifact_path)
                    artifact_payload["artifact_ref"] = artifact_ref
                    _write_json_output(artifact_path, artifact_payload)
                    order_type_ablation_update["order_type_ablation_artifact_ref"] = (
                        artifact_ref
                    )
                    candidate_payload["order_type_ablation"] = {
                        "artifact_ref": artifact_ref,
                        "passed": artifact_payload["passed"],
                        "sample_count": artifact_payload["sample_count"],
                        "selected_order_type": artifact_payload["selected_order_type"],
                        "opportunity_cost_bps": artifact_payload[
                            "opportunity_cost_bps"
                        ],
                    }
                    order_type_ablation_evaluated += 1
                candidate_payload["full_window"] = full_window_summary
                if second_oos_summary is not None:
                    candidate_payload["second_oos"] = second_oos_summary
                candidate_payload["consistency_penalty"] = str(consistency_penalty)
                if second_oos_summary is not None:
                    candidate_payload["second_oos_penalty"] = str(second_oos_penalty)
                candidate_payload["adjusted_score"] = str(adjusted_score)
                candidate_payload["search_iteration"] = worklist_item.search_iteration
                candidate_payload["symbol_prune_iteration"] = (
                    worklist_item.symbol_prune_iteration
                )
                candidate_payload["loss_repair_iteration"] = (
                    worklist_item.loss_repair_iteration
                )
                candidate_payload["consistency_repair_iteration"] = (
                    worklist_item.consistency_repair_iteration
                )
                candidate_payload["family_template_id"] = family_template.family_id
                candidate_payload["dataset_snapshot_id"] = (
                    dataset_snapshot_receipt.snapshot_id
                )
                candidate_payload["dataset_snapshot_receipt"] = (
                    dataset_snapshot_receipt.to_payload()
                )
                if replay_tape_validation is not None:
                    candidate_payload["replay_tape"] = dict(replay_tape_validation)
                replay_lineage = _candidate_replay_lineage_payload(
                    candidate_configmap_path=candidate_configmap_path,
                    candidate_search_key=candidate_key,
                    dataset_snapshot_id=dataset_snapshot_receipt.snapshot_id,
                    train_payload=train_payload,
                    holdout_payload=holdout_payload,
                    full_window_payload=full_window_payload,
                    second_oos_payload=second_oos_payload,
                    window=window,
                    full_window_start=full_window_start,
                    full_window_end=full_window_end,
                    holdout_replay_skipped=holdout_replay_skipped,
                    full_window_replay_skipped=full_window_replay_skipped,
                )
                candidate_payload["replay_lineage"] = replay_lineage
                candidate_evaluation_key = _candidate_evaluation_key_payload(
                    candidate_search_key=candidate_key,
                    params_candidate=params_candidate,
                    strategy_overrides=override_candidate,
                    replay_lineage=replay_lineage,
                    replay_tape_validation=replay_tape_validation,
                    window=window,
                    full_window_start=full_window_start,
                    full_window_end=full_window_end,
                    full_window_summary=full_window_summary,
                )
                candidate_payload["candidate_evaluation_key"] = (
                    candidate_evaluation_key["candidate_evaluation_key"]
                )
                candidate_payload["candidate_evaluation_key_payload"] = (
                    candidate_evaluation_key
                )
                exact_replay_ledger_update = _exact_replay_ledger_artifact_update(
                    args=args,
                    root=root,
                    candidate_index=current_candidate_index,
                    candidate_id=str(candidate_payload["candidate_id"]),
                    full_window_payload=full_window_payload,
                    dataset_snapshot_id=dataset_snapshot_receipt.snapshot_id,
                    replay_lineage=replay_lineage,
                    candidate_evaluation_key=candidate_evaluation_key,
                    replay_tape_validation=replay_tape_validation,
                    candidate_search_key=candidate_key,
                    candidate_symbols=candidate_symbols,
                    full_window_start=full_window_start,
                    full_window_end=full_window_end,
                    proof_only_reason=(
                        proof_only_full_window_reason
                        if proof_only_full_window_replay_captured
                        else ""
                    ),
                )
                if exact_replay_ledger_update:
                    artifact_ref = str(
                        exact_replay_ledger_update["exact_replay_ledger_artifact_ref"]
                    )
                    candidate_payload.update(exact_replay_ledger_update)
                    candidate_payload["replay_artifact_refs"] = list(
                        dict.fromkeys(
                            [
                                *cast(
                                    Sequence[Any],
                                    candidate_payload.get("replay_artifact_refs") or (),
                                ),
                                artifact_ref,
                            ]
                        )
                    )
                candidate_payload["screening"] = {
                    "schema_version": "torghut.frontier-train-screen.v1",
                    "enabled": bool(getattr(args, "train_screening", True)),
                    "status": "rejected" if train_screen_failures else "passed",
                    "stage": "train",
                    "reasons": train_screen_failures,
                    "min_train_net_per_day": str(min_train_screen_net_per_day),
                    "min_train_active_ratio": str(min_train_screen_active_ratio),
                    "max_train_worst_day_loss": str(max_train_screen_worst_day_loss),
                    "holdout_replay_skipped": holdout_replay_skipped,
                    "full_window_replay_skipped": full_window_replay_skipped,
                    "full_replay_skip_reasons": full_replay_skip_reasons,
                    "proof_only_full_window_replay_captured": (
                        proof_only_full_window_replay_captured
                    ),
                    "second_oos_replay_skipped": bool(
                        (train_screen_failures or full_replay_skip_reasons)
                        and window.second_oos_days
                    ),
                }
                candidate_payload["staged_search"] = {
                    "schema_version": "torghut.frontier-candidate-staged-search.v1",
                    "stage": (
                        (
                            "full_replay_budget_exhausted_full_window_proof"
                            if full_replay_skip_reasons
                            else "train_screen_rejected_full_window_proof"
                        )
                        if proof_only_full_window_replay_captured
                        else (
                            "train_screen_passed_full_replay_budget_exhausted"
                            if full_replay_skip_reasons
                            else "train_screen_only"
                            if holdout_replay_skipped
                            else "full_replay"
                        )
                    ),
                    "train_screen_multiplier": int(
                        staged_search["train_screen_multiplier"]
                    ),
                    "full_replay_candidate_budget": full_replay_candidate_budget,
                    "full_replay_candidates_started": full_replay_candidates_started,
                    "full_replay_budget_discarded_candidates": (
                        full_replay_budget_discarded_candidates
                    ),
                    "proof_only_full_window_replay_captures": (
                        proof_only_full_window_replay_captures
                    ),
                    "candidate_record_seed": worklist_item.candidate_record_seed,
                    "ranked_train_screen_survivor": deferred_train_survivor,
                    "train_screen_survivor_rank": worklist_item.deferred_train_rank,
                    "full_replay_selected_after_train_rank": bool(
                        worklist_item.deferred_full_replay_selected
                    ),
                    "train_screen_economic_rank": (
                        worklist_item.deferred_train_economic_rank
                    ),
                    "full_replay_selection_reason": (
                        worklist_item.deferred_full_replay_selection_reason
                    ),
                    "safe_exact_replay_candidate_cap": (
                        _SAFE_EXACT_REPLAY_CANDIDATE_CAP
                    ),
                    "safe_local_exact_replay_worker_cap": (
                        _SAFE_LOCAL_EXACT_REPLAY_WORKERS
                    ),
                    "cluster_fanout_allowed": False,
                    "promotion_writes_allowed": False,
                }
                if worklist_item.pruned_symbol is not None:
                    candidate_payload["pruned_symbol"] = worklist_item.pruned_symbol
                if worklist_item.repair_reason is not None:
                    if worklist_item.repair_reason.startswith("consistency_"):
                        candidate_payload["consistency_repair_reason"] = (
                            worklist_item.repair_reason
                        )
                    else:
                        candidate_payload["loss_repair_reason"] = (
                            worklist_item.repair_reason
                        )
                if worklist_item.parent_candidate_id is not None:
                    candidate_payload["parent_candidate_id"] = (
                        worklist_item.parent_candidate_id
                    )
                scorecard_result = attach_candidate_objective_scorecard(
                    CandidateScorecardInput(
                        args=args,
                        candidate_payload=candidate_payload,
                        full_window_payload=full_window_payload,
                        full_window_summary=full_window_summary,
                        family_template=family_template,
                        override_candidate=override_candidate,
                        window=window,
                        dataset_snapshot_receipt=dataset_snapshot_receipt,
                        replay_tape_validation=replay_tape_validation,
                        replay_lineage=replay_lineage,
                        order_type_ablation_update=order_type_ablation_update,
                        exact_replay_ledger_update=exact_replay_ledger_update,
                        second_oos_summary=second_oos_summary,
                        holdout_payload=holdout_payload,
                        holdout_policy=holdout_policy,
                        train_screen_failures=train_screen_failures,
                        full_replay_skip_reasons=full_replay_skip_reasons,
                        consistency_policy=consistency_policy,
                        objective_veto_policy=objective_veto_policy,
                    )
                )
                symbol_contributions = scorecard_result.symbol_contributions
                hard_vetoes = scorecard_result.hard_vetoes
                if collect_train_gate_diagnostics:
                    candidate_payload["train_gate_diagnostics"] = (
                        _train_gate_diagnostics_from_replay_payload(train_payload)
                    )
                    if not holdout_replay_skipped:
                        candidate_payload["holdout_gate_diagnostics"] = (
                            _train_gate_diagnostics_from_replay_payload(holdout_payload)
                        )
                    if second_oos_payload is not None:
                        candidate_payload["second_oos_gate_diagnostics"] = (
                            _train_gate_diagnostics_from_replay_payload(
                                second_oos_payload
                            )
                        )
                    if not full_window_replay_skipped:
                        candidate_payload["full_window_gate_diagnostics"] = (
                            _train_gate_diagnostics_from_replay_payload(
                                full_window_payload
                            )
                        )
                if cached_rows is not None:
                    candidate_payload["prefetched_row_count"] = len(cached_rows)
                    candidate_payload["prefetched_symbols"] = list(prefetch_symbols)
                scored.append(candidate_payload)
                if worklist_item.symbol_prune_iteration < max(
                    0, int(args.symbol_prune_iterations)
                ):
                    for (
                        removed_symbol,
                        next_override,
                    ) in _generate_symbol_prune_children(
                        cli_symbols=symbols,
                        strategy_overrides=override_candidate,
                        configmap_payload=base_configmap,
                        strategy_name=strategy_name,
                        symbol_contributions=symbol_contributions,
                        branch_count=max(1, int(args.symbol_prune_candidates)),
                        min_universe_size=max(
                            1, int(args.symbol_prune_min_universe_size)
                        ),
                    ):
                        worklist.append(
                            _WorklistItem(
                                params_candidate=dict(params_candidate),
                                strategy_overrides=next_override,
                                symbol_prune_iteration=worklist_item.symbol_prune_iteration
                                + 1,
                                loss_repair_iteration=worklist_item.loss_repair_iteration,
                                consistency_repair_iteration=worklist_item.consistency_repair_iteration,
                                pruned_symbol=removed_symbol,
                                parent_candidate_id=str(
                                    candidate_payload["candidate_id"]
                                ),
                            )
                        )
                if worklist_item.loss_repair_iteration < max(
                    0, int(getattr(args, "loss_repair_iterations", 0))
                ):
                    for (
                        repair_reason,
                        next_params,
                        next_override,
                    ) in _generate_loss_repair_children(
                        params_candidate=params_candidate,
                        strategy_overrides=override_candidate,
                        candidate_configmap=candidate_configmap,
                        strategy_name=strategy_name,
                        hard_vetoes=hard_vetoes,
                        full_window_summary=full_window_summary,
                        branch_count=max(
                            1, int(getattr(args, "loss_repair_candidates", 1))
                        ),
                        policy_required_max_gross_exposure_pct_equity=(
                            objective_veto_policy.required_max_gross_exposure_pct_equity
                        ),
                        policy_required_min_cash=objective_veto_policy.required_min_cash,
                    ):
                        worklist.append(
                            _WorklistItem(
                                params_candidate=next_params,
                                strategy_overrides=next_override,
                                symbol_prune_iteration=worklist_item.symbol_prune_iteration,
                                loss_repair_iteration=worklist_item.loss_repair_iteration
                                + 1,
                                consistency_repair_iteration=worklist_item.consistency_repair_iteration,
                                repair_reason=repair_reason,
                                parent_candidate_id=str(
                                    candidate_payload["candidate_id"]
                                ),
                            )
                        )
                if worklist_item.consistency_repair_iteration < max(
                    0, int(getattr(args, "consistency_repair_iterations", 0))
                ):
                    for (
                        consistency_reason,
                        next_params,
                        next_override,
                    ) in _generate_consistency_repair_children(
                        params_candidate=params_candidate,
                        strategy_overrides=override_candidate,
                        candidate_configmap=candidate_configmap,
                        strategy_name=strategy_name,
                        hard_vetoes=hard_vetoes,
                        full_window_summary=full_window_summary,
                        branch_count=max(
                            1, int(getattr(args, "consistency_repair_candidates", 1))
                        ),
                    ):
                        worklist.append(
                            _WorklistItem(
                                params_candidate=next_params,
                                strategy_overrides=next_override,
                                symbol_prune_iteration=worklist_item.symbol_prune_iteration,
                                loss_repair_iteration=worklist_item.loss_repair_iteration,
                                consistency_repair_iteration=worklist_item.consistency_repair_iteration
                                + 1,
                                repair_reason=consistency_reason,
                                parent_candidate_id=str(
                                    candidate_payload["candidate_id"]
                                ),
                            )
                        )
                if args.json_output is not None:
                    write_running_frontier_payload(
                        args=args,
                        setup=setup,
                        scored=scored,
                        progress=FrontierPayloadProgress(
                            pending_candidates=len(worklist)
                            + (0 if initial_candidates_exhausted else 1),
                            candidate_budget=candidate_budget,
                            train_screen_candidates_started=(
                                train_screen_candidates_started
                            ),
                            full_replay_candidates_started=(
                                full_replay_candidates_started
                            ),
                            train_screen_only_candidates=train_screen_only_candidates,
                            full_replay_budget_discarded_candidates=(
                                full_replay_budget_discarded_candidates
                            ),
                            proof_only_full_window_replay_captures=(
                                proof_only_full_window_replay_captures
                            ),
                        ),
                    )

    return write_final_frontier_payload(
        args=args,
        setup=setup,
        scored=scored,
        budget_exhausted=budget_exhausted,
        progress=FrontierPayloadProgress(
            pending_candidates=len(worklist)
            + (0 if initial_candidates_exhausted else 1),
            candidate_budget=candidate_budget,
            train_screen_candidates_started=train_screen_candidates_started,
            full_replay_candidates_started=full_replay_candidates_started,
            train_screen_only_candidates=train_screen_only_candidates,
            full_replay_budget_discarded_candidates=(
                full_replay_budget_discarded_candidates
            ),
            proof_only_full_window_replay_captures=(
                proof_only_full_window_replay_captures
            ),
        ),
    )


__all__ = ["run_consistent_profitability_frontier"]
