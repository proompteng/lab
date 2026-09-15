#!/usr/bin/env python3
"""Run a whitepaper-driven autoresearch epoch targeting a portfolio profit objective."""

from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Sequence, cast


from app.trading.discovery.autoresearch import (
    run_id,
)
from app.trading.discovery.whitepaper_candidate_compiler import (
    compile_whitepaper_candidate_specs,
)
from app.whitepapers.claim_compiler import (
    RECENT_WHITEPAPER_SEEDS,
    compile_sources_to_hypothesis_cards,
)

from scripts.whitepaper_autoresearch_runner.common import (
    _decimal,
    _list_of_mappings,
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


from scripts.whitepaper_autoresearch_runner.queue_metadata import (
    _maybe_preflight_materialized_replay_tape_window,
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
