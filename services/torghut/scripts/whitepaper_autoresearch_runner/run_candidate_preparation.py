#!/usr/bin/env python3
"""Candidate preparation and pre-replay selection for whitepaper autoresearch."""

from __future__ import annotations

import argparse
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Mapping, Sequence, cast

from app.trading.discovery.candidate_specs import CandidateSpec
from app.trading.discovery.hypothesis_cards import HypothesisCard
from app.trading.discovery.whitepaper_candidate_compiler import (
    CandidateCompilationBlocker,
    WhitepaperCandidateCompilation,
)
from app.whitepapers.claim_compiler import WhitepaperResearchSource, sources_from_jsonl

from scripts.whitepaper_autoresearch_runner.artifact_io import (
    _write_failure_summary,
    _write_json,
    _write_jsonl,
)
from scripts.whitepaper_autoresearch_runner.feedback_loading import (
    _load_candidate_specs_jsonl,
)
from scripts.whitepaper_autoresearch_runner.oracle_policy import (
    _candidate_specs_with_oracle_policy,
)
from scripts.whitepaper_autoresearch_runner.persisted_feedback_sources import (
    _dedupe_whitepaper_sources,
    _load_autoresearch_feedback_evidence_bundles,
    _load_sources_from_db,
)
from scripts.whitepaper_autoresearch_runner.preview_narrowing import (
    _apply_fast_replay_preview_narrowing,
    _candidate_selection_for_direct_replay,
)
from scripts.whitepaper_autoresearch_runner.proposal_building import (
    _pre_replay_proposal_model_and_rows,
)
from scripts.whitepaper_autoresearch_runner.queue_metadata import (
    _maybe_materialize_epoch_replay_tape,
)
from scripts.whitepaper_autoresearch_runner.run_reporting import (
    SelectionOnlySummaryRequest,
    _write_selection_only_summary,
)


@dataclass(frozen=True)
class CandidatePreparationResult:
    args: argparse.Namespace
    sources: Sequence[WhitepaperResearchSource]
    hypothesis_cards: Sequence[HypothesisCard]
    candidate_specs: Sequence[CandidateSpec]
    candidate_compilation_blockers: Sequence[CandidateCompilationBlocker]
    candidate_compiler_report: Mapping[str, Any]
    blocker_by_spec: Mapping[str, Sequence[CandidateCompilationBlocker]]
    feedback_evidence_bundles: Sequence[Any]
    pre_replay_model: Mapping[str, Any]
    pre_replay_proposal_rows: Sequence[Mapping[str, Any]]
    replay_candidate_specs: Sequence[CandidateSpec]
    candidate_selection: Mapping[str, Any]
    materialized_replay_tape_receipt: Mapping[str, Any] | None


@dataclass(frozen=True)
class CandidatePreparationRequest:
    args: argparse.Namespace
    output_dir: Path
    epoch_id: str
    started_at: datetime
    program: Any
    direct_candidate_specs_replay: bool
    candidate_specs_paths: Sequence[Path]
    candidate_universe_symbols: Sequence[str]
    target: Any
    oracle_policy: Any
    selection_only: bool
    ranker_backend_preference: str
    replay_source_window_preflight: Mapping[str, Any] | None
    recent_whitepaper_seeds: Sequence[WhitepaperResearchSource]
    program_whitepaper_sources: Callable[[Any], Sequence[WhitepaperResearchSource]]
    compile_sources_to_hypothesis_cards: Callable[
        [Sequence[WhitepaperResearchSource]], Sequence[HypothesisCard]
    ]
    compile_whitepaper_candidate_specs: Callable[..., WhitepaperCandidateCompilation]
    persist_vnext_specs: Callable[..., Any]
    select_candidate_specs_for_replay: Callable[
        ..., tuple[list[CandidateSpec], dict[str, Any]]
    ]


@dataclass(frozen=True)
class _CandidateCompilationState:
    sources: Sequence[WhitepaperResearchSource]
    hypothesis_cards: Sequence[HypothesisCard]
    candidate_specs: Sequence[CandidateSpec]
    candidate_compilation_blockers: Sequence[CandidateCompilationBlocker]
    candidate_compiler_report: Mapping[str, Any]


@dataclass(frozen=True)
class _ReplaySelectionState:
    args: argparse.Namespace
    replay_candidate_specs: Sequence[CandidateSpec]
    candidate_selection: Mapping[str, Any]
    materialized_replay_tape_receipt: Mapping[str, Any] | None


def _compile_candidate_sources(
    request: CandidatePreparationRequest,
) -> _CandidateCompilationState | dict[str, Any]:
    r = request
    if r.direct_candidate_specs_replay:
        sources: list[WhitepaperResearchSource] = []
        hypothesis_cards: list[HypothesisCard] = []
        try:
            candidate_specs = list(_load_candidate_specs_jsonl(r.candidate_specs_paths))
        except ValueError as exc:
            return _write_failure_summary(
                output_dir=r.output_dir,
                epoch_id=r.epoch_id,
                status="invalid_candidate_specs",
                reason=str(exc),
                started_at=r.started_at,
                extra={
                    "candidate_specs": [str(path) for path in r.candidate_specs_paths]
                },
            )
        candidate_compilation_blockers: tuple[CandidateCompilationBlocker, ...] = ()
        candidate_compiler_report: dict[str, Any] = {
            "schema_version": "torghut.whitepaper-candidate-compiler-report.v1",
            "status": "loaded_candidate_specs_for_direct_replay",
            "candidate_specs_artifacts": [
                str(path) for path in r.candidate_specs_paths
            ],
            "candidate_spec_count": len(candidate_specs),
            "executable_spec_count": len(candidate_specs),
            "blockers": [],
        }
    else:
        explicit_source_inputs = bool(
            r.args.seed_recent_whitepapers
            or getattr(r.args, "source_jsonl", [])
            or getattr(r.args, "paper_run_id", [])
        )
        sources = (
            list(r.program_whitepaper_sources(r.program))
            if not explicit_source_inputs
            else []
        )
        if r.args.seed_recent_whitepapers:
            sources.extend(r.program_whitepaper_sources(r.program))
            sources.extend(r.recent_whitepaper_seeds)
        for source_jsonl in getattr(r.args, "source_jsonl", []):
            sources.extend(sources_from_jsonl(source_jsonl))
        sources.extend(_load_sources_from_db(r.args.paper_run_id))
        sources = _dedupe_whitepaper_sources(sources)
        if not sources:
            return _write_failure_summary(
                output_dir=r.output_dir,
                epoch_id=r.epoch_id,
                status="no_sources",
                reason="no_whitepaper_sources",
                started_at=r.started_at,
            )

        hypothesis_cards = list(r.compile_sources_to_hypothesis_cards(sources))
        compilation = r.compile_whitepaper_candidate_specs(
            hypothesis_cards=hypothesis_cards,
            target_net_pnl_per_day=r.target,
            family_template_dir=r.args.family_template_dir.resolve(),
            seed_sweep_dir=r.args.seed_sweep_dir.resolve(),
            universe_symbols=r.candidate_universe_symbols,
        )
        candidate_specs = list(compilation.executable_specs)
        candidate_specs = _candidate_specs_with_oracle_policy(
            candidate_specs, oracle_policy=r.oracle_policy
        )
        candidate_compilation_blockers = tuple(compilation.blockers)
        candidate_compiler_report = compilation.to_payload()
    return _CandidateCompilationState(
        sources=sources,
        hypothesis_cards=hypothesis_cards,
        candidate_specs=candidate_specs,
        candidate_compilation_blockers=candidate_compilation_blockers,
        candidate_compiler_report=candidate_compiler_report,
    )


def _blockers_by_spec(
    blockers: Sequence[CandidateCompilationBlocker],
) -> dict[str, list[CandidateCompilationBlocker]]:
    blocker_by_spec: dict[str, list[CandidateCompilationBlocker]] = {}
    for blocker in blockers:
        blocker_by_spec.setdefault(blocker.candidate_spec_id, []).append(blocker)
    return blocker_by_spec


def _persist_vnext_specs_if_needed(
    request: CandidatePreparationRequest,
    state: _CandidateCompilationState,
) -> None:
    r = request
    if (
        r.args.persist_results
        and r.args.replay_mode == "real"
        and not r.selection_only
        and not r.direct_candidate_specs_replay
    ):
        for source in state.sources:
            source_specs = [
                spec
                for spec in state.candidate_specs
                if spec.feature_contract.get("source_run_id") == source.run_id
            ]
            r.persist_vnext_specs(source_run_id=source.run_id, specs=source_specs)


def _write_candidate_preparation_artifacts(
    request: CandidatePreparationRequest,
    state: _CandidateCompilationState,
) -> None:
    r = request
    _write_json(
        r.output_dir / "epoch-manifest.json",
        {
            "epoch_id": r.epoch_id,
            "started_at": datetime.now(UTC).isoformat(),
            "target_net_pnl_per_day": str(r.target),
            "replay_mode": r.args.replay_mode,
            "source_count": len(state.sources),
            "paper_sources": [source.to_payload() for source in state.sources],
        },
    )
    _write_jsonl(
        r.output_dir / "whitepaper-sources.jsonl",
        [source.to_payload() for source in state.sources],
    )
    _write_jsonl(
        r.output_dir / "hypothesis-cards.jsonl",
        [card.to_payload() for card in state.hypothesis_cards],
    )
    _write_jsonl(
        r.output_dir / "candidate-specs.jsonl",
        [spec.to_payload() for spec in state.candidate_specs],
    )
    _write_json(
        r.output_dir / "candidate-compiler-report.json",
        state.candidate_compiler_report,
    )


def _load_feedback_evidence_for_candidates(
    request: CandidatePreparationRequest,
    state: _CandidateCompilationState,
) -> tuple[Sequence[Any], Mapping[str, Any]] | dict[str, Any]:
    r = request
    if not state.candidate_specs:
        return _write_failure_summary(
            output_dir=r.output_dir,
            epoch_id=r.epoch_id,
            status="no_eligible_candidates",
            reason="candidate_compiler_produced_no_executable_specs",
            started_at=r.started_at,
        )
    try:
        return _load_autoresearch_feedback_evidence_bundles(
            cast(
                Sequence[Path],
                getattr(r.args, "feedback_evidence_jsonl", ()) or (),
            ),
            include_persisted=bool(getattr(r.args, "persist_results", False))
            and not r.selection_only,
        )
    except ValueError as exc:
        return _write_failure_summary(
            output_dir=r.output_dir,
            epoch_id=r.epoch_id,
            status="invalid_feedback_evidence",
            reason=str(exc),
            started_at=r.started_at,
        )


def _select_replay_candidates(
    request: CandidatePreparationRequest,
    state: _CandidateCompilationState,
    pre_replay_model: Mapping[str, Any],
    pre_replay_proposal_rows: Sequence[Mapping[str, Any]],
) -> _ReplaySelectionState | dict[str, Any]:
    r = request
    if r.direct_candidate_specs_replay:
        replay_candidate_specs = list(state.candidate_specs)
        candidate_selection = _candidate_selection_for_direct_replay(
            specs=replay_candidate_specs,
            proposal_rows=pre_replay_proposal_rows,
            candidate_specs_paths=r.candidate_specs_paths,
        )
    else:
        replay_candidate_specs, candidate_selection = (
            r.select_candidate_specs_for_replay(
                specs=state.candidate_specs,
                proposal_rows=pre_replay_proposal_rows,
                top_k=int(r.args.top_k),
                exploration_slots=int(r.args.exploration_slots),
                feedback_block_reaudit_slots=int(
                    getattr(r.args, "feedback_block_reaudit_slots", 0) or 0
                ),
                max_candidates=int(r.args.max_candidates),
                portfolio_size_min=int(r.args.portfolio_size_min),
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
            r.output_dir / "pre-replay-mlx-proposal-scores.jsonl"
        ),
        "selected_candidate_specs_artifact": str(
            r.output_dir / "selected-candidate-specs.jsonl"
        ),
    }
    try:
        args, materialized_replay_tape_receipt = _maybe_materialize_epoch_replay_tape(
            args=r.args,
            output_dir=r.output_dir,
            epoch_id=r.epoch_id,
        )
    except Exception as exc:
        return _write_failure_summary(
            output_dir=r.output_dir,
            epoch_id=r.epoch_id,
            status="replay_tape_materialization_failed",
            reason=str(exc),
            started_at=r.started_at,
        )
    if materialized_replay_tape_receipt is not None:
        candidate_selection = {
            **candidate_selection,
            "replay_tape_materialization": materialized_replay_tape_receipt,
        }
    if r.replay_source_window_preflight is not None:
        candidate_selection = {
            **candidate_selection,
            "replay_tape_source_window_preflight": r.replay_source_window_preflight,
        }
    try:
        replay_candidate_specs, candidate_selection = (
            _apply_fast_replay_preview_narrowing(
                args=args,
                output_dir=r.output_dir,
                specs=replay_candidate_specs,
                candidate_selection=candidate_selection,
            )
        )
    except ValueError as exc:
        return _write_failure_summary(
            output_dir=r.output_dir,
            epoch_id=r.epoch_id,
            status="invalid_replay_tape_preview",
            reason=str(exc),
            started_at=r.started_at,
        )
    return _ReplaySelectionState(
        args=args,
        replay_candidate_specs=replay_candidate_specs,
        candidate_selection=candidate_selection,
        materialized_replay_tape_receipt=materialized_replay_tape_receipt,
    )


def _prepare_candidates_for_replay(
    request: CandidatePreparationRequest,
) -> CandidatePreparationResult | dict[str, Any]:
    state = _compile_candidate_sources(request)
    if isinstance(state, dict):
        return state
    blocker_by_spec = _blockers_by_spec(state.candidate_compilation_blockers)
    _persist_vnext_specs_if_needed(request, state)
    _write_candidate_preparation_artifacts(request, state)
    feedback_evidence = _load_feedback_evidence_for_candidates(request, state)
    if isinstance(feedback_evidence, dict):
        return feedback_evidence
    feedback_evidence_bundles, feedback_evidence_source_manifest = feedback_evidence
    _write_json(
        request.output_dir / "feedback-evidence-source-manifest.json",
        feedback_evidence_source_manifest,
    )
    pre_replay_model, pre_replay_proposal_rows = _pre_replay_proposal_model_and_rows(
        specs=state.candidate_specs,
        feedback_evidence_bundles=feedback_evidence_bundles,
        oracle_policy=request.oracle_policy,
        ranker_backend_preference=request.ranker_backend_preference,
    )
    _write_json(
        request.output_dir / "pre-replay-mlx-ranker-model.json", pre_replay_model
    )
    _write_jsonl(
        request.output_dir / "pre-replay-mlx-proposal-scores.jsonl",
        pre_replay_proposal_rows,
    )
    replay_selection = _select_replay_candidates(
        request,
        state,
        pre_replay_model,
        pre_replay_proposal_rows,
    )
    if isinstance(replay_selection, dict):
        return replay_selection
    _write_json(
        request.output_dir / "candidate-selection-manifest.json",
        replay_selection.candidate_selection,
    )
    _write_jsonl(
        request.output_dir / "selected-candidate-specs.jsonl",
        [spec.to_payload() for spec in replay_selection.replay_candidate_specs],
    )
    if request.selection_only:
        return _write_selection_only_summary(
            SelectionOnlySummaryRequest(
                args=replay_selection.args,
                output_dir=request.output_dir,
                epoch_id=request.epoch_id,
                started_at=request.started_at,
                target=request.target,
                oracle_policy=request.oracle_policy,
                sources=state.sources,
                hypothesis_cards=state.hypothesis_cards,
                candidate_specs=state.candidate_specs,
                candidate_compilation_blockers=state.candidate_compilation_blockers,
                feedback_evidence_bundles=feedback_evidence_bundles,
                pre_replay_proposal_rows=pre_replay_proposal_rows,
                replay_candidate_specs=replay_selection.replay_candidate_specs,
            )
        )
    return CandidatePreparationResult(
        args=replay_selection.args,
        sources=state.sources,
        hypothesis_cards=state.hypothesis_cards,
        candidate_specs=state.candidate_specs,
        candidate_compilation_blockers=state.candidate_compilation_blockers,
        candidate_compiler_report=state.candidate_compiler_report,
        blocker_by_spec=blocker_by_spec,
        feedback_evidence_bundles=feedback_evidence_bundles,
        pre_replay_model=pre_replay_model,
        pre_replay_proposal_rows=pre_replay_proposal_rows,
        replay_candidate_specs=replay_selection.replay_candidate_specs,
        candidate_selection=replay_selection.candidate_selection,
        materialized_replay_tape_receipt=(
            replay_selection.materialized_replay_tape_receipt
        ),
    )
