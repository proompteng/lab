#!/usr/bin/env python3
"""Run a whitepaper-driven autoresearch epoch targeting a portfolio profit objective."""

from __future__ import annotations

import argparse
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import replace
from pathlib import Path
from typing import Any, Mapping, Sequence


from app.trading.discovery.autoresearch import (
    StrategyAutoresearchProgram,
    load_strategy_autoresearch_program,
)
from app.trading.discovery.candidate_specs import (
    CandidateSpec,
)
from app.trading.discovery.evidence_bundles import (
    CandidateEvidenceBundle,
)
from app.trading.discovery.mlx_snapshot import build_mlx_snapshot_manifest
from app.trading.discovery.mlx_snapshot import MlxSnapshotManifest


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

from scripts.whitepaper_autoresearch_runner.replay_execution import (
    _collect_partial_real_replay,
    _dedupe_replay_evidence,
    _run_real_replay_once_with_optional_timeout,
    _run_synthetic_replay,
)

from scripts.whitepaper_autoresearch_runner.replay_models import (
    EpochReplayResult,
    _ReplayShardOutcome,
    _ReplayShardPlan,
)

_DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC = 8

_DEFAULT_REAL_REPLAY_SHARD_TIMEOUT_SECONDS = 900

_DEFAULT_REAL_REPLAY_SHARD_WORKERS = 2

_DEFAULT_REAL_REPLAY_MAX_PARALLEL_FRONTIER_CANDIDATES = 6


def _run_replay_with_optional_timeout(
    *,
    args: argparse.Namespace,
    output_dir: Path,
    specs: Sequence[CandidateSpec],
) -> EpochReplayResult:
    timeout_seconds = max(0, int(getattr(args, "real_replay_timeout_seconds", 0) or 0))
    if args.replay_mode == "synthetic":
        return _run_synthetic_replay(
            specs=specs,
            output_dir=output_dir,
            max_candidates=len(specs),
        )

    shard_size = max(0, int(getattr(args, "real_replay_shard_size", 0) or 0))
    if shard_size > 0 and len(specs) > shard_size:
        shard_timeout_seconds = _bounded_real_replay_shard_timeout_seconds(
            getattr(
                args,
                "real_replay_shard_timeout_seconds",
                _DEFAULT_REAL_REPLAY_SHARD_TIMEOUT_SECONDS,
            )
        )
        return _run_real_replay_shards(
            args=args,
            output_dir=output_dir,
            specs=specs,
            shard_size=shard_size,
            shard_timeout_seconds=shard_timeout_seconds
            or timeout_seconds
            or _DEFAULT_REAL_REPLAY_SHARD_TIMEOUT_SECONDS,
        )

    return _run_real_replay_once_with_optional_timeout(
        args=args,
        output_dir=output_dir,
        specs=specs,
        timeout_seconds=timeout_seconds,
    )


def _build_real_replay_shards(
    *,
    args: argparse.Namespace,
    output_dir: Path,
    specs: Sequence[CandidateSpec],
    shard_size: int,
    shard_timeout_seconds: int,
) -> tuple[_ReplayShardPlan, ...]:
    ordered_specs = list(specs)
    bounded_shard_size = max(1, int(shard_size))
    bounded_shard_timeout_seconds = _bounded_real_replay_shard_timeout_seconds(
        shard_timeout_seconds
    )
    max_frontier_candidates_per_spec = max(
        1,
        int(
            getattr(
                args,
                "max_frontier_candidates_per_spec",
                _DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC,
            )
            or _DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC
        ),
    )
    configured_total_frontier_budget = max(
        1,
        int(
            getattr(args, "max_total_frontier_candidates", 0)
            or getattr(args, "max_candidates", 1)
        ),
    )
    per_spec_total_frontier_cap = max(
        1,
        (configured_total_frontier_budget + len(ordered_specs) - 1)
        // max(1, len(ordered_specs)),
    )
    plans: list[_ReplayShardPlan] = []
    for shard_index, start in enumerate(
        range(0, len(ordered_specs), bounded_shard_size), start=1
    ):
        shard_specs = tuple(ordered_specs[start : start + bounded_shard_size])
        shard_frontier_budget = max(
            1,
            len(shard_specs)
            * min(max_frontier_candidates_per_spec, per_spec_total_frontier_cap),
        )
        shard_args = argparse.Namespace(
            **{
                **vars(args),
                "max_candidates": len(shard_specs),
                "top_k": min(
                    int(getattr(args, "top_k", len(shard_specs))), len(shard_specs)
                ),
                "max_total_frontier_candidates": shard_frontier_budget,
            }
        )
        plans.append(
            _ReplayShardPlan(
                shard_index=shard_index,
                args=shard_args,
                output_dir=output_dir
                / "strategy-factory-shards"
                / f"shard-{shard_index:03d}",
                specs=shard_specs,
                timeout_seconds=bounded_shard_timeout_seconds,
            )
        )
    return tuple(plans)


def _execute_real_replay_shard(plan: _ReplayShardPlan) -> _ReplayShardOutcome:
    candidate_spec_ids = tuple(spec.candidate_spec_id for spec in plan.specs)
    try:
        result = _run_real_replay_once_with_optional_timeout(
            args=plan.args,
            output_dir=plan.output_dir,
            specs=plan.specs,
            timeout_seconds=plan.timeout_seconds,
        )
    except TimeoutError as exc:
        partial_result = _collect_partial_real_replay(
            output_dir=plan.output_dir,
            specs=plan.specs,
        )
        return _ReplayShardOutcome(
            shard_index=plan.shard_index,
            candidate_spec_ids=candidate_spec_ids,
            result=partial_result,
            failure={
                "shard_index": plan.shard_index,
                "candidate_spec_ids": list(candidate_spec_ids),
                "reason": f"{type(exc).__name__}:{exc}",
                "partial_evidence_bundle_count": len(partial_result.evidence_bundles),
                "shard_timeout_seconds": plan.timeout_seconds,
            },
        )

    failure: dict[str, Any] | None = None
    if result.incomplete:
        failure = {
            "shard_index": plan.shard_index,
            "candidate_spec_ids": list(candidate_spec_ids),
            "reason": ";".join(result.failure_reasons) or "nested_shard_incomplete",
        }
    return _ReplayShardOutcome(
        shard_index=plan.shard_index,
        candidate_spec_ids=candidate_spec_ids,
        result=result,
        failure=failure,
    )


def _failed_shard_spec_ids(
    shard_failures: Sequence[Mapping[str, Any]],
) -> tuple[str, ...]:
    spec_ids: list[str] = []
    seen: set[str] = set()
    for failure in shard_failures:
        raw_ids = failure.get("candidate_spec_ids")
        if not isinstance(raw_ids, Sequence) or isinstance(raw_ids, str):
            continue
        for raw_id in raw_ids:
            candidate_spec_id = _string(raw_id)
            if not candidate_spec_id or candidate_spec_id in seen:
                continue
            seen.add(candidate_spec_id)
            spec_ids.append(candidate_spec_id)
    return tuple(spec_ids)


def _evidenced_spec_ids(
    evidence_bundles: Sequence[CandidateEvidenceBundle],
) -> frozenset[str]:
    return frozenset(
        candidate_spec_id
        for candidate_spec_id in (
            _string(bundle.candidate_spec_id) for bundle in evidence_bundles
        )
        if candidate_spec_id
    )


def _retry_real_replay_failed_shard_specs(
    *,
    args: argparse.Namespace,
    output_dir: Path,
    specs: Sequence[CandidateSpec],
    shard_failures: Sequence[Mapping[str, Any]],
    shard_timeout_seconds: int,
    starting_shard_index: int,
) -> tuple[
    tuple[CandidateEvidenceBundle, ...],
    tuple[Mapping[str, Any], ...],
    tuple[Mapping[str, Any], ...],
    Mapping[str, Any] | None,
]:
    retry_limit = max(0, int(getattr(args, "real_replay_failed_spec_retries", 1) or 0))
    failed_spec_ids = _failed_shard_spec_ids(shard_failures)
    if retry_limit <= 0 or not failed_spec_ids:
        return (), (), tuple(shard_failures), None

    spec_by_id = {spec.candidate_spec_id: spec for spec in specs}
    retry_specs = tuple(
        spec_by_id[candidate_spec_id]
        for candidate_spec_id in failed_spec_ids
        if candidate_spec_id in spec_by_id
    )
    if not retry_specs:
        return (), (), tuple(shard_failures), None

    configured_timeout = max(
        0, int(getattr(args, "real_replay_retry_timeout_seconds", 0) or 0)
    )
    retry_timeout_seconds = configured_timeout
    if retry_timeout_seconds <= 0 and shard_timeout_seconds > 0:
        retry_timeout_seconds = max(shard_timeout_seconds * 2, 900)
    retry_frontier_budget = max(
        1,
        int(
            getattr(args, "real_replay_retry_max_frontier_candidates_per_spec", 1) or 1
        ),
    )

    evidence_bundles: list[CandidateEvidenceBundle] = []
    replay_results: list[Mapping[str, Any]] = []
    completed_spec_ids: set[str] = set()
    last_failure_by_spec: dict[str, Mapping[str, Any]] = {}
    attempt_summaries: list[dict[str, Any]] = []
    next_shard_index = starting_shard_index

    for attempt in range(1, retry_limit + 1):
        pending_specs = tuple(
            spec
            for spec in retry_specs
            if spec.candidate_spec_id not in completed_spec_ids
        )
        if not pending_specs:
            break
        attempt_failures: list[dict[str, Any]] = []
        attempt_completed: list[str] = []
        attempt_evidence_before = len(evidence_bundles)
        for retry_index, spec in enumerate(pending_specs, start=1):
            next_shard_index += 1
            retry_args = argparse.Namespace(
                **{
                    **vars(args),
                    "max_candidates": 1,
                    "top_k": 1,
                    "max_frontier_candidates_per_spec": retry_frontier_budget,
                    "max_total_frontier_candidates": retry_frontier_budget,
                }
            )
            outcome = _execute_real_replay_shard(
                _ReplayShardPlan(
                    shard_index=next_shard_index,
                    args=retry_args,
                    output_dir=output_dir
                    / "strategy-factory-failed-spec-retries"
                    / f"attempt-{attempt:02d}"
                    / f"retry-{retry_index:03d}-{spec.candidate_spec_id}",
                    specs=(spec,),
                    timeout_seconds=retry_timeout_seconds,
                )
            )
            evidence_bundles.extend(outcome.result.evidence_bundles)
            replay_results.extend(outcome.result.replay_results)
            if outcome.failure is not None:
                failure = {
                    **dict(outcome.failure),
                    "retry_attempt": attempt,
                    "retry_candidate_spec_id": spec.candidate_spec_id,
                    "retry_timeout_seconds": retry_timeout_seconds,
                    "retry_max_frontier_candidates_per_spec": retry_frontier_budget,
                }
                attempt_failures.append(failure)
                last_failure_by_spec[spec.candidate_spec_id] = failure
                continue
            completed_spec_ids.add(spec.candidate_spec_id)
            last_failure_by_spec.pop(spec.candidate_spec_id, None)
            attempt_completed.append(spec.candidate_spec_id)
        attempt_summaries.append(
            {
                "attempt": attempt,
                "requested_candidate_spec_ids": [
                    spec.candidate_spec_id for spec in pending_specs
                ],
                "completed_candidate_spec_ids": attempt_completed,
                "failure_count": len(attempt_failures),
                "failures": attempt_failures,
                "new_evidence_bundle_count": len(evidence_bundles)
                - attempt_evidence_before,
            }
        )

    deduped_retry_evidence = _dedupe_replay_evidence(evidence_bundles)
    remaining_failures = tuple(last_failure_by_spec.values())
    summary = {
        "status": "failed_shard_specs_retried",
        "schema_version": "torghut.whitepaper-autoresearch-shard-retry.v1",
        "retry_limit": retry_limit,
        "retry_timeout_seconds": retry_timeout_seconds,
        "retry_max_frontier_candidates_per_spec": retry_frontier_budget,
        "original_failure_count": len(shard_failures),
        "requested_candidate_spec_ids": [
            spec.candidate_spec_id for spec in retry_specs
        ],
        "completed_candidate_spec_ids": sorted(completed_spec_ids),
        "evidence_candidate_spec_ids": sorted(
            _evidenced_spec_ids(deduped_retry_evidence)
        ),
        "remaining_failed_candidate_spec_ids": [
            _string(failure.get("retry_candidate_spec_id"))
            for failure in remaining_failures
            if _string(failure.get("retry_candidate_spec_id"))
        ],
        "attempts": attempt_summaries,
    }
    return deduped_retry_evidence, tuple(replay_results), remaining_failures, summary


def _replay_shard_frontier_candidate_budget(plan: _ReplayShardPlan) -> int:
    return max(1, int(getattr(plan.args, "max_total_frontier_candidates", 1) or 1))


def _bounded_real_replay_shard_workers(
    *,
    args: argparse.Namespace,
    plans: Sequence[_ReplayShardPlan],
) -> int:
    requested_workers = max(
        1,
        min(
            len(plans) or 1,
            _DEFAULT_REAL_REPLAY_SHARD_WORKERS,
            int(
                getattr(
                    args,
                    "real_replay_shard_workers",
                    _DEFAULT_REAL_REPLAY_SHARD_WORKERS,
                )
                or _DEFAULT_REAL_REPLAY_SHARD_WORKERS
            ),
        ),
    )
    max_parallel_frontier_candidates = max(
        0,
        int(
            getattr(
                args,
                "real_replay_max_parallel_frontier_candidates",
                _DEFAULT_REAL_REPLAY_MAX_PARALLEL_FRONTIER_CANDIDATES,
            )
            or 0
        ),
    )
    if not plans or max_parallel_frontier_candidates <= 0:
        return requested_workers
    largest_shard_budget = max(
        _replay_shard_frontier_candidate_budget(plan) for plan in plans
    )
    budget_capped_workers = max(
        1, max_parallel_frontier_candidates // largest_shard_budget
    )
    return max(1, min(requested_workers, budget_capped_workers))


def _bounded_real_replay_shard_timeout_seconds(raw_timeout_seconds: object) -> int:
    requested_timeout_seconds = max(
        0,
        int(raw_timeout_seconds or _DEFAULT_REAL_REPLAY_SHARD_TIMEOUT_SECONDS),
    )
    if requested_timeout_seconds <= 0:
        return _DEFAULT_REAL_REPLAY_SHARD_TIMEOUT_SECONDS
    return min(requested_timeout_seconds, _DEFAULT_REAL_REPLAY_SHARD_TIMEOUT_SECONDS)


def _run_real_replay_shards(
    *,
    args: argparse.Namespace,
    output_dir: Path,
    specs: Sequence[CandidateSpec],
    shard_size: int,
    shard_timeout_seconds: int,
) -> EpochReplayResult:
    evidence_bundles: list[CandidateEvidenceBundle] = []
    replay_results: list[Mapping[str, Any]] = []
    shard_failures: list[dict[str, Any]] = []
    bounded_shard_timeout_seconds = _bounded_real_replay_shard_timeout_seconds(
        shard_timeout_seconds
    )
    plans = _build_real_replay_shards(
        args=args,
        output_dir=output_dir,
        specs=specs,
        shard_size=shard_size,
        shard_timeout_seconds=bounded_shard_timeout_seconds,
    )
    bounded_shard_size = max(1, int(shard_size))
    shard_workers = _bounded_real_replay_shard_workers(
        args=args,
        plans=plans,
    )
    if shard_workers <= 1:
        outcomes = [_execute_real_replay_shard(plan) for plan in plans]
    else:
        outcomes = []
        with ProcessPoolExecutor(max_workers=shard_workers) as executor:
            future_by_plan = {
                executor.submit(_execute_real_replay_shard, plan): plan
                for plan in plans
            }
            for future in as_completed(future_by_plan):
                outcomes.append(future.result())

    for outcome in sorted(outcomes, key=lambda item: item.shard_index):
        evidence_bundles.extend(outcome.result.evidence_bundles)
        replay_results.extend(outcome.result.replay_results)
        if outcome.failure is not None:
            shard_failures.append(dict(outcome.failure))

    deduped_evidence = _dedupe_replay_evidence(evidence_bundles)
    if shard_failures:
        (
            retry_evidence,
            retry_replay_results,
            remaining_failures,
            retry_summary,
        ) = _retry_real_replay_failed_shard_specs(
            args=args,
            output_dir=output_dir,
            specs=specs,
            shard_failures=shard_failures,
            shard_timeout_seconds=bounded_shard_timeout_seconds,
            starting_shard_index=len(plans),
        )
        if retry_evidence:
            evidence_bundles.extend(retry_evidence)
            deduped_evidence = _dedupe_replay_evidence(evidence_bundles)
        replay_results.extend(retry_replay_results)
        if retry_summary is not None:
            replay_results.append(dict(retry_summary))
        shard_failures = [dict(item) for item in remaining_failures]
    if shard_failures and not deduped_evidence:
        raise TimeoutError(f"real_replay_shards_failed:{len(shard_failures)}")
    if shard_failures:
        replay_results.append(
            {
                "status": "partial_replay_shards_interrupted",
                "schema_version": "torghut.whitepaper-autoresearch-shards.v1",
                "shard_size": bounded_shard_size,
                "shard_workers": shard_workers,
                "shard_timeout_seconds": bounded_shard_timeout_seconds,
                "selected_candidate_spec_count": len(specs),
                "evidence_bundle_count": len(deduped_evidence),
                "failures": shard_failures,
            }
        )
    return EpochReplayResult(
        evidence_bundles=deduped_evidence,
        replay_results=tuple(replay_results),
        incomplete=bool(shard_failures),
        failure_reasons=tuple(
            _string(item.get("reason")) for item in shard_failures if item.get("reason")
        ),
    )


def _load_epoch_program(args: argparse.Namespace) -> StrategyAutoresearchProgram:
    program = load_strategy_autoresearch_program(
        _resolve_existing_path(args.program),
        family_dir=_resolve_existing_path(args.family_template_dir),
    )
    if args.replay_mode == "synthetic":
        return replace(
            program,
            runtime_closure_policy=replace(
                program.runtime_closure_policy,
                execute_parity_replay=False,
                execute_approval_replay=False,
            ),
        )
    return program


def _resolved_staged_train_screen_multiplier(
    args: argparse.Namespace, program: StrategyAutoresearchProgram
) -> int:
    override = int(getattr(args, "staged_train_screen_multiplier", 0) or 0)
    if override > 0:
        return max(1, override)
    return max(1, int(program.replay_budget.staged_train_screen_multiplier))


def _resolved_program_family_int_arg(
    args: argparse.Namespace,
    program: StrategyAutoresearchProgram,
    name: str,
    *,
    default: int,
    minimum: int,
) -> int:
    override = int(getattr(args, name, 0) or 0)
    if override > 0:
        return max(minimum, override)
    program_value = max(
        (int(getattr(family, name, default)) for family in program.families),
        default=default,
    )
    return max(minimum, program_value)


def _resolved_real_replay_frontier_controls(
    args: argparse.Namespace, program: StrategyAutoresearchProgram
) -> dict[str, Any]:
    return {
        "symbol_prune_iterations": _resolved_program_family_int_arg(
            args, program, "symbol_prune_iterations", default=0, minimum=0
        ),
        "symbol_prune_candidates": _resolved_program_family_int_arg(
            args, program, "symbol_prune_candidates", default=1, minimum=1
        ),
        "symbol_prune_min_universe_size": _resolved_program_family_int_arg(
            args, program, "symbol_prune_min_universe_size", default=2, minimum=1
        ),
        "loss_repair_iterations": _resolved_program_family_int_arg(
            args, program, "loss_repair_iterations", default=0, minimum=0
        ),
        "loss_repair_candidates": _resolved_program_family_int_arg(
            args, program, "loss_repair_candidates", default=1, minimum=1
        ),
        "consistency_repair_iterations": _resolved_program_family_int_arg(
            args, program, "consistency_repair_iterations", default=0, minimum=0
        ),
        "consistency_repair_candidates": _resolved_program_family_int_arg(
            args, program, "consistency_repair_candidates", default=2, minimum=1
        ),
        "capture_rejected_seed_full_window_ledger": bool(
            getattr(args, "capture_rejected_seed_full_window_ledger", False)
        ),
        "capture_positive_rejected_full_window_ledgers": max(
            0,
            int(getattr(args, "capture_positive_rejected_full_window_ledgers", 0) or 0),
        ),
    }


def _epoch_mlx_snapshot_manifest(
    *,
    args: argparse.Namespace,
    output_dir: Path,
    epoch_id: str,
    program: StrategyAutoresearchProgram,
    source_count: int,
    hypothesis_count: int,
    candidate_spec_count: int,
    pre_replay_proposal_score_count: int,
    replay_candidate_spec_count: int,
    evidence_bundle_count: int,
    proposal_score_count: int,
    portfolio_candidate_count: int,
) -> MlxSnapshotManifest:
    return build_mlx_snapshot_manifest(
        runner_run_id=epoch_id,
        program=program,
        symbols=str(args.symbols),
        train_days=int(args.train_days),
        holdout_days=int(args.holdout_days),
        full_window_start_date=str(args.full_window_start_date),
        full_window_end_date=str(args.full_window_end_date),
        tensor_bundle_paths={
            "hypothesis_cards_jsonl": str(output_dir / "hypothesis-cards.jsonl"),
            "candidate_specs_jsonl": str(output_dir / "candidate-specs.jsonl"),
            "candidate_selection_manifest_json": str(
                output_dir / "candidate-selection-manifest.json"
            ),
            "pre_replay_proposal_scores_jsonl": str(
                output_dir / "pre-replay-mlx-proposal-scores.jsonl"
            ),
            "proposal_scores_jsonl": str(output_dir / "mlx-proposal-scores.jsonl"),
            "candidate_evidence_bundles_jsonl": str(
                output_dir / "candidate-evidence-bundles.jsonl"
            ),
            "portfolio_candidates_jsonl": str(
                output_dir / "portfolio-candidates.jsonl"
            ),
        },
        row_counts={
            "sources": source_count,
            "hypothesis_cards": hypothesis_count,
            "candidate_specs": candidate_spec_count,
            "pre_replay_proposal_scores": pre_replay_proposal_score_count,
            "replay_candidate_specs": replay_candidate_spec_count,
            "candidate_evidence_bundles": evidence_bundle_count,
            "proposal_scores": proposal_score_count,
            "portfolio_candidates": portfolio_candidate_count,
        },
    )


__all__ = [
    "_run_replay_with_optional_timeout",
    "_build_real_replay_shards",
    "_execute_real_replay_shard",
    "_failed_shard_spec_ids",
    "_evidenced_spec_ids",
    "_retry_real_replay_failed_shard_specs",
    "_replay_shard_frontier_candidate_budget",
    "_bounded_real_replay_shard_workers",
    "_bounded_real_replay_shard_timeout_seconds",
    "_run_real_replay_shards",
    "_load_epoch_program",
    "_resolved_staged_train_screen_multiplier",
    "_resolved_program_family_int_arg",
    "_resolved_real_replay_frontier_controls",
    "_epoch_mlx_snapshot_manifest",
]
