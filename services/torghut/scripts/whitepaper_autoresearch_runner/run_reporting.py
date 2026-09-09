#!/usr/bin/env python3
"""Reporting branches for the whitepaper autoresearch runner."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Mapping, Sequence
from typing import cast

from app.trading.discovery.portfolio_optimizer import PortfolioCandidateSpec

from scripts.whitepaper_autoresearch_runner.candidate_board_payloads import (
    _candidate_board_payload,
    _paper_probation_handoff_payload,
)
from scripts.whitepaper_autoresearch_runner.feedback_loading import (
    _MAX_PERSISTED_FEEDBACK_EVIDENCE_BUNDLES,
    _evidence_bundle_payloads_for_epoch_summary,
)
from scripts.whitepaper_autoresearch_runner.persisted_feedback_sources import (
    _persist_epoch_ledgers,
)
from scripts.whitepaper_autoresearch_runner.replay_shards import (
    _DEFAULT_REAL_REPLAY_MAX_PARALLEL_FRONTIER_CANDIDATES,
    _DEFAULT_REAL_REPLAY_SHARD_TIMEOUT_SECONDS,
    _DEFAULT_REAL_REPLAY_SHARD_WORKERS,
    _bounded_real_replay_shard_timeout_seconds,
)

from app.trading.discovery.autoresearch import StrategyAutoresearchProgram
from app.trading.discovery.candidate_specs import CandidateSpec
from app.trading.discovery.evidence_bundles import CandidateEvidenceBundle
from app.trading.discovery.hypothesis_cards import HypothesisCard
from app.trading.discovery.whitepaper_autoresearch_notebooks import (
    write_whitepaper_autoresearch_diagnostics_notebook,
)
from app.whitepapers.claim_compiler import WhitepaperResearchSource

from scripts.whitepaper_autoresearch_runner.artifact_io import (
    _write_failure_summary,
    _write_json,
    _write_jsonl,
)
from scripts.whitepaper_autoresearch_runner.candidate_remediation import (
    _candidate_search_remediation,
)
from scripts.whitepaper_autoresearch_runner.next_epoch_planning import (
    _profitability_search_goal,
)
from scripts.whitepaper_autoresearch_runner.proposal_training import (
    _best_false_negative_table,
    _false_positive_table,
    _replay_diagnostic_proposal_rows,
)
from scripts.whitepaper_autoresearch_runner.replay_execution import (
    _collect_partial_real_replay,
)
from scripts.whitepaper_autoresearch_runner.replay_models import EpochReplayResult
from scripts.whitepaper_autoresearch_runner.replay_shards import (
    _DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC,
)


@dataclass(frozen=True)
class SelectionOnlySummaryRequest:
    args: argparse.Namespace
    output_dir: Path
    epoch_id: str
    started_at: datetime
    target: Any
    oracle_policy: Any
    sources: Sequence[WhitepaperResearchSource]
    hypothesis_cards: Sequence[HypothesisCard]
    candidate_specs: Sequence[CandidateSpec]
    candidate_compilation_blockers: Sequence[Any]
    feedback_evidence_bundles: Sequence[CandidateEvidenceBundle]
    pre_replay_proposal_rows: Sequence[Mapping[str, Any]]
    replay_candidate_specs: Sequence[CandidateSpec]


@dataclass(frozen=True)
class ReplayFailureSummaryRequest:
    args: argparse.Namespace
    output_dir: Path
    epoch_id: str
    started_at: datetime
    failure_reason: str
    replay_candidate_specs: Sequence[CandidateSpec]
    candidate_selection: Mapping[str, Any]
    pre_replay_proposal_rows: Sequence[Mapping[str, Any]]
    oracle_policy: Any
    target: Any
    program: StrategyAutoresearchProgram
    sources: Sequence[WhitepaperResearchSource]
    hypothesis_cards: Sequence[HypothesisCard]
    candidate_specs: Sequence[CandidateSpec]
    pre_replay_model: Mapping[str, Any]


@dataclass(frozen=True)
class SuccessfulRunFinalizationRequest:
    args: argparse.Namespace
    output_dir: Path
    epoch_id: str
    started_at: datetime
    target: Any
    oracle_policy: Any
    program: StrategyAutoresearchProgram
    sources: Sequence[WhitepaperResearchSource]
    hypothesis_cards: Sequence[HypothesisCard]
    candidate_specs: Sequence[CandidateSpec]
    candidate_compilation_blockers: Sequence[Any]
    candidate_selection: Mapping[str, Any]
    pre_replay_model: Mapping[str, Any]
    pre_replay_proposal_rows: Sequence[Mapping[str, Any]]
    proposal_model: Mapping[str, Any]
    proposal_rows: Sequence[Mapping[str, Any]]
    replay_result: EpochReplayResult
    replay_candidate_specs: Sequence[CandidateSpec]
    replay_failure_reasons: Sequence[str]
    materialized_replay_tape_receipt: Mapping[str, Any] | None
    portfolio: PortfolioCandidateSpec | None
    portfolio_rows: Sequence[Mapping[str, Any]]
    promotion_readiness: Mapping[str, Any]
    runtime_closure: Mapping[str, Any]
    oracle_candidate_found: bool
    profit_target_oracle: object
    status: str
    status_reason: str | None
    promotion_blockers: Sequence[str]
    blocker_by_spec: Mapping[str, Sequence[Any]]


def _write_selection_only_summary(
    request: SelectionOnlySummaryRequest,
) -> dict[str, Any]:
    r = request
    selected_candidate_spec_ids = [
        spec.candidate_spec_id for spec in r.replay_candidate_specs
    ]
    summary = {
        "status": "selection_only",
        "status_reason": "pre_replay_selection_only",
        "epoch_id": r.epoch_id,
        "run_root": str(r.output_dir),
        "started_at": r.started_at.isoformat(),
        "completed_at": datetime.now(UTC).isoformat(),
        "target_net_pnl_per_day": str(r.target),
        "profit_target_oracle_policy": r.oracle_policy.to_payload(),
        "source_count": len(r.sources),
        "hypothesis_count": len(r.hypothesis_cards),
        "candidate_spec_count": len(r.candidate_specs),
        "candidate_compiler_blocker_count": len(r.candidate_compilation_blockers),
        "feedback_evidence_bundle_count": len(r.feedback_evidence_bundles),
        "pre_replay_proposal_score_count": len(r.pre_replay_proposal_rows),
        "replay_candidate_spec_count": len(r.replay_candidate_specs),
        "selected_candidate_spec_ids": selected_candidate_spec_ids,
        "claim_count": sum(len(source.claims) for source in r.sources),
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
            "epoch_manifest": str(r.output_dir / "epoch-manifest.json"),
            "hypothesis_cards": str(r.output_dir / "hypothesis-cards.jsonl"),
            "whitepaper_sources": str(r.output_dir / "whitepaper-sources.jsonl"),
            "candidate_specs": str(r.output_dir / "candidate-specs.jsonl"),
            "candidate_selection_manifest": str(
                r.output_dir / "candidate-selection-manifest.json"
            ),
            "selected_candidate_specs": str(
                r.output_dir / "selected-candidate-specs.jsonl"
            ),
            "pre_replay_proposal_scores": str(
                r.output_dir / "pre-replay-mlx-proposal-scores.jsonl"
            ),
            "pre_replay_proposal_model": str(
                r.output_dir / "pre-replay-mlx-ranker-model.json"
            ),
            "feedback_evidence_source_manifest": str(
                r.output_dir / "feedback-evidence-source-manifest.json"
            ),
            "candidate_compiler_report": str(
                r.output_dir / "candidate-compiler-report.json"
            ),
            "summary": str(r.output_dir / "summary.json"),
            "diagnostics_notebook": str(
                r.output_dir / "whitepaper-autoresearch-diagnostics.ipynb"
            ),
        },
    }
    _write_json(r.output_dir / "summary.json", summary)
    write_whitepaper_autoresearch_diagnostics_notebook(
        r.output_dir / "whitepaper-autoresearch-diagnostics.ipynb",
        summary=summary,
    )
    return summary


def _write_replay_failure_summary(
    request: ReplayFailureSummaryRequest,
) -> dict[str, Any]:
    r = request
    partial_replay_result = (
        _collect_partial_real_replay(
            output_dir=r.output_dir, specs=r.replay_candidate_specs
        )
        if r.args.replay_mode == "real"
        else EpochReplayResult(evidence_bundles=(), replay_results=())
    )
    partial_artifact_path = r.output_dir / "candidate-evidence-bundles.partial.jsonl"
    if partial_replay_result.evidence_bundles:
        _write_jsonl(
            partial_artifact_path,
            [bundle.to_payload() for bundle in partial_replay_result.evidence_bundles],
        )
    replay_diagnostic_rows = _replay_diagnostic_proposal_rows(
        candidate_selection=r.candidate_selection,
        pre_replay_proposal_rows=r.pre_replay_proposal_rows,
    )
    false_positive_table = _false_positive_table(
        proposal_rows=replay_diagnostic_rows,
        evidence_bundles=partial_replay_result.evidence_bundles,
        oracle_policy=r.oracle_policy,
    )
    best_false_negative_table = _best_false_negative_table(
        candidate_selection=r.candidate_selection,
        pre_replay_proposal_rows=r.pre_replay_proposal_rows,
        evidence_bundles=partial_replay_result.evidence_bundles,
    )
    remediation = _candidate_search_remediation(
        failure_reason=r.failure_reason,
        candidate_selection=r.candidate_selection,
        evidence_bundles=partial_replay_result.evidence_bundles,
        false_positive_table=false_positive_table,
        best_false_negative_table=best_false_negative_table,
        replay_timeout_seconds=int(
            getattr(r.args, "real_replay_timeout_seconds", 0) or 0
        ),
        max_frontier_candidates_per_spec=int(
            getattr(
                r.args,
                "max_frontier_candidates_per_spec",
                _DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC,
            )
            or _DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC
        ),
        current_top_k=int(getattr(r.args, "top_k", 16) or 16),
        current_exploration_slots=int(getattr(r.args, "exploration_slots", 8) or 8),
        current_portfolio_size_min=int(getattr(r.args, "portfolio_size_min", 2) or 2),
        current_max_candidates=int(getattr(r.args, "max_candidates", 64) or 64),
        current_max_total_frontier_candidates=int(
            getattr(r.args, "max_total_frontier_candidates", 0) or 0
        ),
        current_train_days=int(getattr(r.args, "train_days", 6) or 6),
        current_holdout_days=int(getattr(r.args, "holdout_days", 3) or 3),
        current_second_oos_days=int(getattr(r.args, "second_oos_days", 2) or 2),
    )
    remediation_path = r.output_dir / "candidate-search-remediation.json"
    _write_json(remediation_path, remediation)
    profitability_goal = _profitability_search_goal(
        args=r.args,
        output_dir=r.output_dir,
        status="replay_failed",
        status_reason=r.failure_reason,
        target=r.target,
        program=r.program,
        sources=r.sources,
        hypothesis_cards=r.hypothesis_cards,
        candidate_specs=r.candidate_specs,
        candidate_selection=r.candidate_selection,
        pre_replay_model=r.pre_replay_model,
        proposal_model=None,
        evidence_bundles=partial_replay_result.evidence_bundles,
        false_positive_table=false_positive_table,
        best_false_negative_table=best_false_negative_table,
        portfolio=None,
        oracle_candidate_found=False,
        profit_target_oracle=None,
        promotion_blockers=["replay_failed", r.failure_reason],
        remediation=remediation,
    )
    profitability_goal_path = r.output_dir / "profitability-search-goal.json"
    _write_json(profitability_goal_path, profitability_goal)
    return _write_failure_summary(
        output_dir=r.output_dir,
        epoch_id=r.epoch_id,
        status="replay_failed",
        reason=r.failure_reason,
        started_at=r.started_at,
        extra={
            "partial_evidence_bundle_count": len(
                partial_replay_result.evidence_bundles
            ),
            "partial_replay_result_count": len(partial_replay_result.replay_results),
            "partial_artifacts": {
                "candidate_evidence_bundles": str(partial_artifact_path)
                if partial_replay_result.evidence_bundles
                else None,
                "strategy_factory_dir": str(r.output_dir / "strategy-factory"),
            },
            "false_positive_table": false_positive_table,
            "best_false_negative_table": best_false_negative_table,
            "candidate_search_remediation": remediation,
            "profitability_search_goal": profitability_goal,
            "artifacts": {
                "candidate_search_remediation": str(remediation_path),
                "profitability_search_goal": str(profitability_goal_path),
                "candidate_selection_manifest": str(
                    r.output_dir / "candidate-selection-manifest.json"
                ),
                "selected_candidate_specs": str(
                    r.output_dir / "selected-candidate-specs.jsonl"
                ),
                "feedback_evidence_source_manifest": str(
                    r.output_dir / "feedback-evidence-source-manifest.json"
                ),
                "partial_candidate_evidence_bundles": str(partial_artifact_path)
                if partial_replay_result.evidence_bundles
                else None,
                "summary": str(r.output_dir / "summary.json"),
                "diagnostics_notebook": str(
                    r.output_dir / "whitepaper-autoresearch-diagnostics.ipynb"
                ),
            },
        },
    )


def _finalize_successful_run(
    request: SuccessfulRunFinalizationRequest,
) -> dict[str, Any]:
    r = request
    false_positive_table = _false_positive_table(
        proposal_rows=r.proposal_rows,
        evidence_bundles=r.replay_result.evidence_bundles,
        oracle_policy=r.oracle_policy,
    )
    best_false_negative_table = _best_false_negative_table(
        candidate_selection=r.candidate_selection,
        pre_replay_proposal_rows=r.pre_replay_proposal_rows,
        evidence_bundles=r.replay_result.evidence_bundles,
    )
    candidate_search_remediation: dict[str, Any] | None = None
    remediation_path = r.output_dir / "candidate-search-remediation.json"
    if not r.oracle_candidate_found:
        candidate_search_remediation = _candidate_search_remediation(
            failure_reason=r.status_reason or r.status,
            candidate_selection=r.candidate_selection,
            evidence_bundles=r.replay_result.evidence_bundles,
            false_positive_table=false_positive_table,
            best_false_negative_table=best_false_negative_table,
            replay_timeout_seconds=int(
                getattr(r.args, "real_replay_timeout_seconds", 0) or 0
            ),
            max_frontier_candidates_per_spec=int(
                getattr(
                    r.args,
                    "max_frontier_candidates_per_spec",
                    _DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC,
                )
                or _DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC
            ),
            current_top_k=int(getattr(r.args, "top_k", 16) or 16),
            current_exploration_slots=int(getattr(r.args, "exploration_slots", 8) or 8),
            current_portfolio_size_min=int(
                getattr(r.args, "portfolio_size_min", 2) or 2
            ),
            current_max_candidates=int(getattr(r.args, "max_candidates", 64) or 64),
            current_max_total_frontier_candidates=int(
                getattr(r.args, "max_total_frontier_candidates", 0) or 0
            ),
            current_train_days=int(getattr(r.args, "train_days", 6) or 6),
            current_holdout_days=int(getattr(r.args, "holdout_days", 3) or 3),
            current_second_oos_days=int(getattr(r.args, "second_oos_days", 2) or 2),
        )
        _write_json(remediation_path, candidate_search_remediation)
    candidate_board = _candidate_board_payload(
        epoch_id=r.epoch_id,
        output_dir=r.output_dir,
        target=r.target,
        candidate_specs=r.candidate_specs,
        candidate_selection=r.candidate_selection,
        pre_replay_proposal_rows=r.pre_replay_proposal_rows,
        proposal_rows=r.proposal_rows,
        evidence_bundles=r.replay_result.evidence_bundles,
        portfolio=r.portfolio,
        promotion_readiness=r.promotion_readiness,
        runtime_closure=r.runtime_closure,
        paper_probation_target_limit=r.program.replay_budget.exploration_slots,
    )
    candidate_board_path = r.output_dir / "candidate-board.json"
    _write_json(candidate_board_path, candidate_board)
    paper_probation_handoff = _paper_probation_handoff_payload(candidate_board)
    paper_probation_handoff_path = r.output_dir / "paper-probation-handoff.json"
    _write_json(paper_probation_handoff_path, paper_probation_handoff)
    profitability_goal = _profitability_search_goal(
        args=r.args,
        output_dir=r.output_dir,
        status=r.status,
        status_reason=r.status_reason,
        target=r.target,
        program=r.program,
        sources=r.sources,
        hypothesis_cards=r.hypothesis_cards,
        candidate_specs=r.candidate_specs,
        candidate_selection=r.candidate_selection,
        pre_replay_model=r.pre_replay_model,
        proposal_model=r.proposal_model,
        evidence_bundles=r.replay_result.evidence_bundles,
        false_positive_table=false_positive_table,
        best_false_negative_table=best_false_negative_table,
        portfolio=r.portfolio,
        oracle_candidate_found=r.oracle_candidate_found,
        profit_target_oracle=cast(Mapping[str, Any], r.profit_target_oracle)
        if isinstance(r.profit_target_oracle, Mapping)
        else None,
        promotion_blockers=r.promotion_blockers,
        remediation=candidate_search_remediation,
    )
    profitability_goal_path = r.output_dir / "profitability-search-goal.json"
    _write_json(profitability_goal_path, profitability_goal)
    summary = {
        "status": r.status,
        "status_reason": r.status_reason,
        "epoch_id": r.epoch_id,
        "run_root": str(r.output_dir),
        "target_net_pnl_per_day": str(r.target),
        "profit_target_oracle_policy": r.oracle_policy.to_payload(),
        "source_count": len(r.sources),
        "hypothesis_count": len(r.hypothesis_cards),
        "candidate_spec_count": len(r.candidate_specs),
        "candidate_compiler_blocker_count": len(r.candidate_compilation_blockers),
        "evidence_bundle_count": len(r.replay_result.evidence_bundles),
        "candidate_evidence_bundle_payloads": _evidence_bundle_payloads_for_epoch_summary(
            r.replay_result.evidence_bundles
        ),
        "candidate_evidence_bundle_payload_count": min(
            len(r.replay_result.evidence_bundles),
            _MAX_PERSISTED_FEEDBACK_EVIDENCE_BUNDLES,
        ),
        "replay_candidate_spec_count": len(r.replay_candidate_specs),
        "selected_candidate_spec_ids": [
            spec.candidate_spec_id for spec in r.replay_candidate_specs
        ],
        "replay_incomplete": r.replay_result.incomplete,
        "replay_failure_reasons": r.replay_failure_reasons,
        "replay_tape_materialization": r.materialized_replay_tape_receipt,
        "pre_replay_proposal_score_count": len(r.pre_replay_proposal_rows),
        "proposal_score_count": len(r.proposal_rows),
        "portfolio_candidate_count": len(r.portfolio_rows),
        "claim_count": sum(len(source.claims) for source in r.sources),
        "mlx_rank_bucket_lift": r.proposal_model.get("rank_bucket_lift", {}),
        "false_positive_table": false_positive_table,
        "best_false_negative_table": best_false_negative_table,
        "candidate_board": candidate_board,
        "paper_probation_handoff": paper_probation_handoff,
        "candidate_search_remediation": candidate_search_remediation,
        "profitability_search_goal": profitability_goal,
        "best_portfolio_candidate": r.portfolio.to_payload()
        if r.portfolio is not None
        else None,
        "oracle_candidate_found": r.oracle_candidate_found,
        "profit_target_oracle": r.profit_target_oracle,
        "promotion_readiness": r.promotion_readiness,
        "runtime_closure": r.runtime_closure,
        "artifacts": {
            "epoch_manifest": str(r.output_dir / "epoch-manifest.json"),
            "hypothesis_cards": str(r.output_dir / "hypothesis-cards.jsonl"),
            "whitepaper_sources": str(r.output_dir / "whitepaper-sources.jsonl"),
            "candidate_specs": str(r.output_dir / "candidate-specs.jsonl"),
            "candidate_selection_manifest": str(
                r.output_dir / "candidate-selection-manifest.json"
            ),
            "selected_candidate_specs": str(
                r.output_dir / "selected-candidate-specs.jsonl"
            ),
            "pre_replay_proposal_scores": str(
                r.output_dir / "pre-replay-mlx-proposal-scores.jsonl"
            ),
            "pre_replay_proposal_model": str(
                r.output_dir / "pre-replay-mlx-ranker-model.json"
            ),
            "feedback_evidence_source_manifest": str(
                r.output_dir / "feedback-evidence-source-manifest.json"
            ),
            "mlx_snapshot_manifest": str(r.output_dir / "mlx-snapshot-manifest.json"),
            "candidate_compiler_report": str(
                r.output_dir / "candidate-compiler-report.json"
            ),
            "proposal_scores": str(r.output_dir / "mlx-proposal-scores.jsonl"),
            "proposal_model": str(r.output_dir / "mlx-ranker-model.json"),
            "candidate_evidence_bundles": str(
                r.output_dir / "candidate-evidence-bundles.jsonl"
            ),
            "portfolio_candidates": str(r.output_dir / "portfolio-candidates.jsonl"),
            "portfolio_optimizer_report": str(
                r.output_dir / "portfolio-optimizer-report.json"
            ),
            "candidate_board": str(candidate_board_path),
            "paper_probation_handoff": str(paper_probation_handoff_path),
            "candidate_search_remediation": str(remediation_path)
            if candidate_search_remediation is not None
            else None,
            "profitability_search_goal": str(profitability_goal_path),
            "replay_tape": (
                r.materialized_replay_tape_receipt.get("tape_path")
                if r.materialized_replay_tape_receipt is not None
                else None
            ),
            "replay_tape_manifest": (
                r.materialized_replay_tape_receipt.get("manifest_path")
                if r.materialized_replay_tape_receipt is not None
                else None
            ),
            "replay_tape_receipt": (
                r.materialized_replay_tape_receipt.get("receipt_path")
                if r.materialized_replay_tape_receipt is not None
                else None
            ),
            "summary": str(r.output_dir / "summary.json"),
            "diagnostics_notebook": str(
                r.output_dir / "whitepaper-autoresearch-diagnostics.ipynb"
            ),
        },
    }
    _write_json(r.output_dir / "summary.json", summary)
    write_whitepaper_autoresearch_diagnostics_notebook(
        r.output_dir / "whitepaper-autoresearch-diagnostics.ipynb",
        summary=summary,
    )
    if r.args.persist_results:
        runner_config = {
            "replay_mode": r.args.replay_mode,
            "max_candidates": int(r.args.max_candidates),
            "top_k": int(r.args.top_k),
            "exploration_slots": int(r.args.exploration_slots),
            "feedback_block_reaudit_slots": int(
                getattr(r.args, "feedback_block_reaudit_slots", 0) or 0
            ),
            "replay_candidate_spec_count": len(r.replay_candidate_specs),
            "replay_incomplete": r.replay_result.incomplete,
            "replay_failure_reasons": r.replay_failure_reasons,
            "portfolio_size_min": int(r.args.portfolio_size_min),
            "portfolio_size_max": int(r.args.portfolio_size_max),
            "real_replay_shard_size": int(
                getattr(r.args, "real_replay_shard_size", 0) or 0
            ),
            "real_replay_shard_timeout_seconds": int(
                _bounded_real_replay_shard_timeout_seconds(
                    getattr(
                        r.args,
                        "real_replay_shard_timeout_seconds",
                        _DEFAULT_REAL_REPLAY_SHARD_TIMEOUT_SECONDS,
                    )
                )
            ),
            "real_replay_shard_workers": int(
                getattr(
                    r.args,
                    "real_replay_shard_workers",
                    _DEFAULT_REAL_REPLAY_SHARD_WORKERS,
                )
                or _DEFAULT_REAL_REPLAY_SHARD_WORKERS
            ),
            "real_replay_max_parallel_frontier_candidates": int(
                getattr(
                    r.args,
                    "real_replay_max_parallel_frontier_candidates",
                    _DEFAULT_REAL_REPLAY_MAX_PARALLEL_FRONTIER_CANDIDATES,
                )
                or _DEFAULT_REAL_REPLAY_MAX_PARALLEL_FRONTIER_CANDIDATES
            ),
            "real_replay_failed_spec_retries": int(
                getattr(r.args, "real_replay_failed_spec_retries", 1) or 0
            ),
            "real_replay_retry_timeout_seconds": int(
                getattr(r.args, "real_replay_retry_timeout_seconds", 0) or 0
            ),
            "real_replay_retry_max_frontier_candidates_per_spec": int(
                getattr(r.args, "real_replay_retry_max_frontier_candidates_per_spec", 1)
                or 1
            ),
            "replay_tape_preview_top_k": int(
                getattr(r.args, "replay_tape_preview_top_k", 0) or 0
            ),
            "replay_tape_preview_min_rows": int(
                getattr(r.args, "replay_tape_preview_min_rows", 2) or 2
            ),
            "materialize_replay_tape": bool(
                getattr(r.args, "materialize_replay_tape", False)
            ),
            "replay_tape_path": str(getattr(r.args, "replay_tape_path", "") or ""),
            "replay_tape_manifest": str(
                getattr(r.args, "replay_tape_manifest", "") or ""
            ),
            "source_jsonl": [str(path) for path in getattr(r.args, "source_jsonl", [])],
        }
        try:
            _persist_epoch_ledgers(
                epoch_id=r.epoch_id,
                status=r.status,
                target_net_pnl_per_day=r.target,
                paper_run_ids=[str(item) for item in r.args.paper_run_id],
                sources=r.sources,
                candidate_specs=r.candidate_specs,
                candidate_blockers=r.blocker_by_spec,
                proposal_rows=r.proposal_rows,
                portfolio=r.portfolio,
                summary=summary,
                runner_config=runner_config,
                started_at=r.started_at,
                completed_at=datetime.now(UTC),
            )
            summary["persistence_status"] = "persisted"
            _write_json(r.output_dir / "summary.json", summary)
        except Exception as exc:
            summary["pre_persistence_status"] = r.status
            summary["status"] = "persistence_failed"
            summary["status_reason"] = "epoch_ledger_persistence_failed"
            summary["persistence_status"] = "failed"
            summary["persistence_error"] = str(exc)
            summary["persistence_runner_config"] = runner_config
            _write_json(r.output_dir / "persistence-error-summary.json", summary)
            _write_json(r.output_dir / "error-summary.json", summary)
            _write_json(r.output_dir / "summary.json", summary)
            write_whitepaper_autoresearch_diagnostics_notebook(
                r.output_dir / "whitepaper-autoresearch-diagnostics.ipynb",
                summary=summary,
            )
    return summary
