#!/usr/bin/env python3
"""Build and write consistent profitability frontier workflow payloads."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from typing import Any

from scripts.consistent_profitability_frontier.candidate_loading import (
    _staged_search_budget_payload,
)
from scripts.consistent_profitability_frontier.common import _write_json_output
from scripts.consistent_profitability_frontier.frontier_payload import (
    _build_frontier_payload,
)
from scripts.consistent_profitability_frontier.workflow_setup import (
    FrontierRunSetup,
)


@dataclass(frozen=True)
class FrontierPayloadProgress:
    pending_candidates: int
    candidate_budget: int
    train_screen_candidates_started: int
    full_replay_candidates_started: int
    train_screen_only_candidates: int
    full_replay_budget_discarded_candidates: int
    proof_only_full_window_replay_captures: int


def _frontier_payload(
    *,
    args: argparse.Namespace,
    setup: FrontierRunSetup,
    scored: list[dict[str, Any]],
    status: str,
    progress: FrontierPayloadProgress,
) -> dict[str, Any]:
    return _build_frontier_payload(
        scored=scored,
        family=setup.family,
        strategy_name=setup.strategy_name,
        family_template=setup.family_template,
        dataset_snapshot_receipt=setup.dataset_snapshot_receipt,
        window=setup.window,
        full_window_start=setup.full_window_start,
        full_window_end=setup.full_window_end,
        holdout_policy=setup.holdout_policy,
        consistency_policy=setup.consistency_policy,
        objective_veto_policy=setup.objective_veto_policy,
        top_n=max(1, int(args.top_n)),
        status=status,
        pending_candidates=progress.pending_candidates,
        replay_tape_validation=setup.replay_tape_validation,
        staged_search=_staged_search_budget_payload(
            args=args,
            candidate_budget=progress.candidate_budget,
            train_screen_candidates_started=progress.train_screen_candidates_started,
            full_replay_candidates_started=progress.full_replay_candidates_started,
            train_screen_only_candidates=progress.train_screen_only_candidates,
            full_replay_budget_discarded_candidates=(
                progress.full_replay_budget_discarded_candidates
            ),
            proof_only_full_window_replay_captures=(
                progress.proof_only_full_window_replay_captures
            ),
        ),
    )


def write_running_frontier_payload(
    *,
    args: argparse.Namespace,
    setup: FrontierRunSetup,
    scored: list[dict[str, Any]],
    progress: FrontierPayloadProgress,
) -> None:
    if args.json_output is None:
        return
    _write_json_output(
        args.json_output,
        _frontier_payload(
            args=args,
            setup=setup,
            scored=scored,
            status="running",
            progress=progress,
        ),
    )


def write_final_frontier_payload(
    *,
    args: argparse.Namespace,
    setup: FrontierRunSetup,
    scored: list[dict[str, Any]],
    budget_exhausted: bool,
    progress: FrontierPayloadProgress,
) -> dict[str, Any]:
    payload = _frontier_payload(
        args=args,
        setup=setup,
        scored=scored,
        status=(
            "candidate_budget_exhausted"
            if budget_exhausted
            and (
                progress.pending_candidates > 0
                or progress.full_replay_budget_discarded_candidates > 0
            )
            else "completed"
        ),
        progress=progress,
    )
    if args.json_output is not None:
        _write_json_output(args.json_output, payload)
    return payload


__all__ = [
    "FrontierPayloadProgress",
    "write_final_frontier_payload",
    "write_running_frontier_payload",
]
