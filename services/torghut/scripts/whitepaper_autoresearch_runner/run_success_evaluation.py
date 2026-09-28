#!/usr/bin/env python3
"""Successful replay evaluation for whitepaper autoresearch runs."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence, cast

from app.trading.discovery.candidate_specs import CandidateSpec
from app.trading.discovery.hypothesis_cards import HypothesisCard
from app.trading.discovery.mlx_snapshot import write_mlx_snapshot_manifest
from app.trading.discovery.portfolio_optimizer import (
    PortfolioCandidateSpec,
    optimize_portfolio_candidate,
)
from app.trading.discovery.autoresearch import StrategyAutoresearchProgram
from app.whitepapers.claim_compiler import WhitepaperResearchSource

from scripts.whitepaper_autoresearch_runner.artifact_io import _write_json, _write_jsonl
from scripts.whitepaper_autoresearch_runner.candidate_board_payloads import (
    _portfolio_with_runtime_closure_proof,
    _runtime_closure_program_for_candidate,
)
from scripts.whitepaper_autoresearch_runner.common import (
    _mapping,
    _oracle_blockers,
    _string,
)
from scripts.whitepaper_autoresearch_runner.proposal_training import (
    _proposal_model_and_rows,
)
from scripts.whitepaper_autoresearch_runner.replay_models import EpochReplayResult
from scripts.whitepaper_autoresearch_runner.replay_shards import (
    _epoch_mlx_snapshot_manifest,
)
from scripts.whitepaper_autoresearch_runner.runtime_closure import (
    _promotion_readiness_payload,
    _runtime_closure_payload,
)


@dataclass(frozen=True)
class SuccessfulReplayEvaluation:
    proposal_model: Mapping[str, Any]
    proposal_rows: Sequence[Mapping[str, Any]]
    portfolio: PortfolioCandidateSpec | None
    portfolio_rows: Sequence[Mapping[str, Any]]
    promotion_readiness: Mapping[str, Any]
    runtime_closure: Mapping[str, Any]
    oracle_candidate_found: bool
    replay_failure_reasons: Sequence[str]
    profit_target_oracle: object
    status: str
    status_reason: str | None
    promotion_blockers: Sequence[str]


@dataclass(frozen=True)
class SuccessfulReplayEvaluationRequest:
    args: argparse.Namespace
    output_dir: Path
    epoch_id: str
    program: StrategyAutoresearchProgram
    sources: Sequence[WhitepaperResearchSource]
    hypothesis_cards: Sequence[HypothesisCard]
    candidate_specs: Sequence[CandidateSpec]
    pre_replay_proposal_rows: Sequence[Mapping[str, Any]]
    candidate_selection: Mapping[str, Any]
    replay_candidate_specs: Sequence[CandidateSpec]
    replay_result: EpochReplayResult
    target: Any
    oracle_policy: Any
    ranker_backend_preference: str
    selection_by_spec: Mapping[str, Mapping[str, Any]]


@dataclass(frozen=True)
class _ReplayEvaluationArtifacts:
    proposal_model: Mapping[str, Any]
    proposal_rows: Sequence[Mapping[str, Any]]
    portfolio: PortfolioCandidateSpec | None
    portfolio_rows: Sequence[Mapping[str, Any]]
    runtime_closure: Mapping[str, Any]


@dataclass(frozen=True)
class _ReplayPromotionEvaluation:
    promotion_readiness: Mapping[str, Any]
    oracle_candidate_found: bool
    replay_failure_reasons: Sequence[str]
    profit_target_oracle: object
    status: str
    status_reason: str | None
    promotion_blockers: Sequence[str]


def _build_replay_evaluation_artifacts(
    request: SuccessfulReplayEvaluationRequest,
) -> _ReplayEvaluationArtifacts:
    r = request
    proposal_model, proposal_rows = _proposal_model_and_rows(
        specs=r.candidate_specs,
        evidence_bundles=r.replay_result.evidence_bundles,
        ranker_backend_preference=r.ranker_backend_preference,
        replay_selection_by_spec=r.selection_by_spec,
    )
    _write_json(r.output_dir / "mlx-ranker-model.json", proposal_model)
    _write_jsonl(r.output_dir / "mlx-proposal-scores.jsonl", proposal_rows)
    _write_jsonl(
        r.output_dir / "candidate-evidence-bundles.jsonl",
        [bundle.to_payload() for bundle in r.replay_result.evidence_bundles],
    )

    portfolio = optimize_portfolio_candidate(
        evidence_bundles=r.replay_result.evidence_bundles,
        target_net_pnl_per_day=r.target,
        oracle_policy=r.oracle_policy,
        portfolio_size_min=int(r.args.portfolio_size_min),
        portfolio_size_max=int(r.args.portfolio_size_max),
    )
    portfolio_rows = [portfolio.to_payload()] if portfolio is not None else []
    _write_jsonl(r.output_dir / "portfolio-candidates.jsonl", portfolio_rows)
    _write_json(
        r.output_dir / "portfolio-optimizer-report.json",
        portfolio.optimizer_report
        if portfolio is not None
        else {"status": "no_portfolio_candidate"},
    )
    mlx_snapshot_manifest = _epoch_mlx_snapshot_manifest(
        args=r.args,
        output_dir=r.output_dir,
        epoch_id=r.epoch_id,
        program=r.program,
        source_count=len(r.sources),
        hypothesis_count=len(r.hypothesis_cards),
        candidate_spec_count=len(r.candidate_specs),
        pre_replay_proposal_score_count=len(r.pre_replay_proposal_rows),
        replay_candidate_spec_count=len(r.replay_candidate_specs),
        evidence_bundle_count=len(r.replay_result.evidence_bundles),
        proposal_score_count=len(proposal_rows),
        portfolio_candidate_count=len(portfolio_rows),
    )
    write_mlx_snapshot_manifest(
        r.output_dir / "mlx-snapshot-manifest.json", mlx_snapshot_manifest
    )
    initial_oracle_candidate_found = bool(
        portfolio is not None
        and portfolio.objective_scorecard.get("oracle_passed") is True
        and not r.replay_result.incomplete
    )
    runtime_closure_program = _runtime_closure_program_for_candidate(
        program=r.program,
        manifest=mlx_snapshot_manifest,
        portfolio=portfolio,
        oracle_candidate_found=initial_oracle_candidate_found,
    )
    runtime_closure = _runtime_closure_payload(
        args=r.args,
        output_dir=r.output_dir,
        epoch_id=r.epoch_id,
        program=runtime_closure_program,
        manifest=mlx_snapshot_manifest,
        portfolio=portfolio,
    )
    if portfolio is not None:
        portfolio = _portfolio_with_runtime_closure_proof(
            portfolio=portfolio,
            runtime_closure=runtime_closure,
            target=r.target,
            oracle_policy=r.oracle_policy,
        )
        portfolio_rows = [portfolio.to_payload()]
        _write_jsonl(r.output_dir / "portfolio-candidates.jsonl", portfolio_rows)
        _write_json(
            r.output_dir / "portfolio-optimizer-report.json", portfolio.optimizer_report
        )

    return _ReplayEvaluationArtifacts(
        proposal_model=proposal_model,
        proposal_rows=proposal_rows,
        portfolio=portfolio,
        portfolio_rows=portfolio_rows,
        runtime_closure=runtime_closure,
    )


def _evaluate_replay_promotion_readiness(
    request: SuccessfulReplayEvaluationRequest,
    artifacts: _ReplayEvaluationArtifacts,
) -> _ReplayPromotionEvaluation:
    r = request
    portfolio = artifacts.portfolio
    oracle_candidate_found = bool(
        portfolio is not None
        and portfolio.objective_scorecard.get("oracle_passed") is True
        and not r.replay_result.incomplete
    )
    replay_failure_reasons = list(r.replay_result.failure_reasons)
    profit_target_oracle = (
        portfolio.objective_scorecard.get("profit_target_oracle")
        if portfolio is not None
        else None
    )
    if portfolio is None:
        promotion_status = "no_candidate"
        promotion_blockers: list[str] = []
    elif r.replay_result.incomplete:
        promotion_status = "blocked_pending_complete_replay"
        promotion_blockers = ["selected_replay_incomplete", *replay_failure_reasons]
    elif oracle_candidate_found:
        runtime_status = _string(artifacts.runtime_closure.get("status"))
        promotion_status = runtime_status or "ready_for_promotion_review"
        promotion_blockers = [
            _string(item)
            for item in cast(
                Sequence[Any],
                artifacts.runtime_closure.get("next_required_steps") or (),
            )
            if _string(item) and _string(item) != "promotion_review"
        ]
    else:
        runtime_next_steps = [
            _string(item)
            for item in cast(
                Sequence[Any],
                artifacts.runtime_closure.get("next_required_steps") or (),
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
        runtime_closure=artifacts.runtime_closure,
    )
    status = "ok" if oracle_candidate_found else "no_profit_target_candidate"
    status_reason = None
    if not oracle_candidate_found:
        if r.replay_result.incomplete:
            status_reason = "selected_replay_incomplete"
        elif portfolio is None:
            status_reason = "portfolio_optimizer_produced_no_candidate"
        else:
            status_reason = "portfolio_candidate_failed_profit_target_oracle"
    return _ReplayPromotionEvaluation(
        promotion_readiness=promotion_readiness,
        oracle_candidate_found=oracle_candidate_found,
        replay_failure_reasons=replay_failure_reasons,
        profit_target_oracle=profit_target_oracle,
        status=status,
        status_reason=status_reason,
        promotion_blockers=promotion_blockers,
    )


def _evaluate_successful_replay(
    request: SuccessfulReplayEvaluationRequest,
) -> SuccessfulReplayEvaluation:
    artifacts = _build_replay_evaluation_artifacts(request)
    promotion = _evaluate_replay_promotion_readiness(request, artifacts)
    return SuccessfulReplayEvaluation(
        proposal_model=artifacts.proposal_model,
        proposal_rows=artifacts.proposal_rows,
        portfolio=artifacts.portfolio,
        portfolio_rows=artifacts.portfolio_rows,
        promotion_readiness=promotion.promotion_readiness,
        runtime_closure=artifacts.runtime_closure,
        oracle_candidate_found=promotion.oracle_candidate_found,
        replay_failure_reasons=promotion.replay_failure_reasons,
        profit_target_oracle=promotion.profit_target_oracle,
        status=promotion.status,
        status_reason=promotion.status_reason,
        promotion_blockers=promotion.promotion_blockers,
    )
