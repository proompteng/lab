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

from .part_01_statements_97 import *
from .part_02_load_yaml import *
from .part_03_write_results_tsv import *


def _write_portfolio_outputs(
    *,
    run_root: Path,
    program: StrategyAutoresearchProgram,
) -> tuple[PortfolioCandidateSpec | None, dict[str, Any]]:
    evidence_bundles = _portfolio_evidence_bundles_from_results(run_root)
    portfolio = optimize_portfolio_candidate(
        evidence_bundles=evidence_bundles,
        target_net_pnl_per_day=program.objective.target_net_pnl_per_day,
        oracle_policy=_portfolio_oracle_policy(program),
        portfolio_size_min=2,
        portfolio_size_max=8,
    )
    portfolio_rows = [portfolio.to_payload()] if portfolio is not None else []
    portfolio_path = run_root / "portfolio-candidates.jsonl"
    portfolio_path.write_text(
        "\n".join(json.dumps(item, sort_keys=True) for item in portfolio_rows)
        + ("\n" if portfolio_rows else ""),
        encoding="utf-8",
    )
    evidence_path = run_root / "candidate-evidence-bundles.jsonl"
    evidence_path.write_text(
        "\n".join(
            json.dumps(bundle.to_payload(), sort_keys=True)
            for bundle in evidence_bundles
        )
        + ("\n" if evidence_bundles else ""),
        encoding="utf-8",
    )
    optimizer_report = (
        dict(portfolio.optimizer_report)
        if portfolio is not None
        else {
            "status": "no_portfolio_candidate",
            "evidence_bundle_count": len(evidence_bundles),
        }
    )
    optimizer_report_path = run_root / "portfolio-optimizer-report.json"
    optimizer_report_path.write_text(
        json.dumps(optimizer_report, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    return portfolio, {
        "portfolio_candidates_path": str(portfolio_path),
        "candidate_evidence_bundles_path": str(evidence_path),
        "portfolio_optimizer_report_path": str(optimizer_report_path),
        "portfolio_candidate_count": len(portfolio_rows),
        "candidate_evidence_bundle_count": len(evidence_bundles),
        "portfolio_optimizer_report": optimizer_report,
    }


def _proposal_diagnostics(
    *,
    descriptors: list[MlxCandidateDescriptor],
    proposal_scores: list[ProposalScore],
    history: list[dict[str, Any]],
) -> ProposalDiagnostics:
    selected_entries = [
        {
            "candidate_id": _string(item.get("candidate_id")),
            "descriptor_id": _string(item.get("descriptor_id")),
            "selection_reason": _string(item.get("proposal_selection_reason"))
            or "exploitation",
            "score": float(item.get("proposal_score") or 0.0),
            "rank": int(item.get("proposal_rank") or 0),
            "family_template_id": _string(item.get("family_template_id")),
            "side_policy": "unknown",
        }
        for item in history
        if bool(item.get("proposal_selected"))
    ]
    selected_by_candidate: dict[str, dict[str, Any]] = {}
    descriptor_by_candidate = {item.candidate_id: item for item in descriptors}
    for item in selected_entries:
        candidate_id = item["candidate_id"]
        descriptor = descriptor_by_candidate.get(candidate_id)
        if descriptor is not None:
            item["side_policy"] = descriptor.side_policy
        selected_by_candidate[candidate_id] = item
    return build_proposal_diagnostics(
        descriptors=descriptors,
        proposal_scores=proposal_scores,
        history_rows=history,
        selected_candidates=[
            ProposalSelectionEntry(
                candidate_id=item["candidate_id"],
                descriptor_id=item["descriptor_id"],
                selection_reason=item["selection_reason"],
                score=float(item["score"]),
                rank=int(item["rank"]),
                family_template_id=item["family_template_id"],
                side_policy=item["side_policy"],
                capital_feasible=bool(
                    next(
                        (
                            history_item.get("capital_feasible")
                            for history_item in history
                            if _string(history_item.get("candidate_id"))
                            == item["candidate_id"]
                        ),
                        True,
                    )
                ),
                capital_budget_overage_ratio=_float(
                    next(
                        (
                            history_item.get("capital_budget_overage_ratio")
                            for history_item in history
                            if _string(history_item.get("candidate_id"))
                            == item["candidate_id"]
                        ),
                        0,
                    )
                ),
            )
            for item in selected_by_candidate.values()
        ],
    )


def _experiment_snapshot_from_payload(
    *,
    payload: Mapping[str, Any],
    experiment: str,
    result_path: Path,
) -> dict[str, Any] | None:
    top_candidates = cast(list[dict[str, Any]], payload.get("top") or [])
    if not top_candidates:
        return None
    top_row = _mapping(top_candidates[0])
    scorecard = _mapping(top_row.get("objective_scorecard"))
    progress = _mapping(payload.get("progress"))
    return {
        "experiment": experiment,
        "path": str(result_path),
        "status": _string(payload.get("status")),
        "candidate_count": int(payload.get("candidate_count") or 0),
        "evaluated_candidates": int(progress.get("evaluated_candidates") or 0),
        "pending_candidates": int(progress.get("pending_candidates") or 0),
        "top_candidate_id": _string(top_row.get("candidate_id")),
        "top_net_pnl_per_day": _string(scorecard.get("net_pnl_per_day")),
        "top_active_day_ratio": _string(scorecard.get("active_day_ratio")),
        "top_best_day_share": _string(scorecard.get("best_day_share")),
        "top_hard_vetoes": list(cast(list[str], top_row.get("hard_vetoes") or [])),
    }


def _load_experiment_snapshots(run_root: Path) -> list[dict[str, Any]]:
    snapshots: list[dict[str, Any]] = []
    for result_path in sorted((run_root / "experiments").glob("*/result.json")):
        try:
            payload = json.loads(result_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            continue
        if not isinstance(payload, Mapping):
            continue
        snapshot = _experiment_snapshot_from_payload(
            payload=cast(Mapping[str, Any], payload),
            experiment=result_path.parent.name,
            result_path=result_path,
        )
        if snapshot is not None:
            snapshots.append(snapshot)
    return snapshots


def _best_experiment_snapshot(snapshots: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not snapshots:
        return None
    return max(
        snapshots,
        key=lambda item: (
            Decimal(_string(item.get("top_net_pnl_per_day")) or "0"),
            Decimal(_string(item.get("top_active_day_ratio")) or "0"),
            -Decimal(_string(item.get("top_best_day_share")) or "0"),
            -int(item.get("pending_candidates") or 0),
        ),
    )


def _live_progress_payload(
    *,
    run_root: Path,
    frontier_runs: int,
    worklist: list[WorkItem],
    history: list[dict[str, Any]],
    descriptors: list[MlxCandidateDescriptor],
    proposal_scores: list[ProposalScore],
    best_exact_replay_ledger_candidate: Mapping[str, Any] | None = None,
    exact_replay_ledger_remediation: Mapping[str, Any] | None = None,
    selected_for_replay: ProposalSelectionEntry | None = None,
    selected_descriptor: MlxCandidateDescriptor | None = None,
) -> dict[str, Any]:
    snapshots = _load_experiment_snapshots(run_root)
    payload: dict[str, Any] = {
        "frontier_runs_started": frontier_runs,
        "pending_work_items": len(worklist),
        "history_row_count": len(history),
        "descriptor_count": len(descriptors),
        "proposal_score_count": len(proposal_scores),
        "experiment_result_count": len(snapshots),
        "latest_experiment": snapshots[-1] if snapshots else None,
        "best_experiment_candidate": _best_experiment_snapshot(snapshots),
        "best_exact_replay_ledger_candidate": (
            dict(best_exact_replay_ledger_candidate)
            if best_exact_replay_ledger_candidate is not None
            else None
        ),
        "exact_replay_ledger_remediation": (
            dict(exact_replay_ledger_remediation)
            if exact_replay_ledger_remediation is not None
            else None
        ),
    }
    if selected_for_replay is not None:
        payload["selected_for_replay"] = {
            "candidate_id": selected_for_replay.candidate_id,
            "descriptor_id": selected_for_replay.descriptor_id,
            "selection_reason": selected_for_replay.selection_reason,
            "score": selected_for_replay.score,
            "rank": selected_for_replay.rank,
            "family_template_id": selected_for_replay.family_template_id,
            "side_policy": selected_for_replay.side_policy,
            "entry_window_start_minute": (
                selected_descriptor.entry_window_start_minute
                if selected_descriptor is not None
                else 0
            ),
            "entry_window_end_minute": (
                selected_descriptor.entry_window_end_minute
                if selected_descriptor is not None
                else 0
            ),
        }
    return payload


def _exact_replay_ledger_refs(value: Any) -> list[str]:
    refs: list[str] = []
    if isinstance(value, Mapping):
        for key, item in value.items():
            if key == "exact_replay_ledger_artifact_ref":
                ref = _string(item)
                if ref:
                    refs.append(ref)
                continue
            if key == "exact_replay_ledger_artifact_refs":
                if isinstance(item, (list, tuple)):
                    refs.extend(ref for raw in item if (ref := _string(raw)))
                else:
                    ref = _string(item)
                    if ref:
                        refs.append(ref)
                continue
            refs.extend(_exact_replay_ledger_refs(item))
    elif isinstance(value, (list, tuple)):
        for item in value:
            refs.extend(_exact_replay_ledger_refs(item))
    return refs


def _resolve_run_artifact_ref(ref: str, *, base_dir: Path) -> Path:
    path = Path(ref).expanduser()
    if path.is_absolute():
        return path
    return base_dir / path


def _exact_replay_ledger_paths(run_root: Path) -> tuple[Path, ...]:
    paths: list[Path] = []
    seen: set[str] = set()

    def add(path: Path) -> None:
        key = str(path.expanduser().resolve(strict=False))
        if key in seen:
            return
        seen.add(key)
        paths.append(path)

    for path in sorted(run_root.glob("**/*exact-replay-ledger.json")):
        if path.is_file():
            add(path)

    for result_path in sorted((run_root / "experiments").glob("*/result.json")):
        try:
            payload = json.loads(result_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            continue
        for ref in _exact_replay_ledger_refs(payload):
            add(_resolve_run_artifact_ref(ref, base_dir=result_path.parent))
    return tuple(paths)


def _write_exact_replay_ledger_ranking(
    *,
    run_root: Path,
    program: StrategyAutoresearchProgram,
) -> dict[str, Any]:
    path = run_root / "exact-replay-ledger-ranking.json"
    policy = default_replay_ledger_ranking_policy(
        target_net_pnl_per_day=program.objective.target_net_pnl_per_day,
        start_equity=program.objective.default_start_equity,
    )
    report = build_replay_ledger_ranking_report(
        _exact_replay_ledger_paths(run_root),
        policy=policy,
        limit=20,
    )
    path.write_text(json.dumps(report, indent=2, sort_keys=True), encoding="utf-8")
    candidates = cast(list[dict[str, Any]], report.get("candidates") or [])
    return {
        "path": str(path),
        "report": report,
        "best_candidate": candidates[0] if candidates else None,
    }


_EXACT_REPLAY_EXECUTION_QUALITY_FIELDS = (
    "artifact_ref",
    "window_start",
    "window_end",
    "execution_quality",
    "execution_quality_blockers",
    "execution_quality_penalty_bps",
    "execution_quality_penalty_amount",
    "execution_quality_adjusted_window_net_pnl_per_day",
)


def _exact_replay_ranking_by_candidate(
    ranking_report: Mapping[str, Any],
) -> dict[str, dict[str, Any]]:
    candidates = cast(list[Any], ranking_report.get("candidates") or [])
    by_candidate: dict[str, dict[str, Any]] = {}
    for item in candidates:
        candidate = _mapping(item)
        candidate_id = _string(candidate.get("candidate_id"))
        if candidate_id and candidate_id not in by_candidate:
            by_candidate[candidate_id] = candidate
    return by_candidate


def _with_exact_replay_execution_quality(
    candidate_payload: Mapping[str, Any],
    exact_replay_candidate: Mapping[str, Any] | None,
) -> dict[str, Any]:
    payload = _json_clone(candidate_payload)
    if exact_replay_candidate is None:
        return payload
    exact_payload = _mapping(exact_replay_candidate)
    metadata = _mapping(payload.get("exact_replay_ledger_ranking"))
    for field in _EXACT_REPLAY_EXECUTION_QUALITY_FIELDS:
        if field in exact_payload:
            payload[field] = (
                _json_clone(_mapping(exact_payload[field]))
                if isinstance(exact_payload[field], Mapping)
                else exact_payload[field]
            )
            metadata[field] = payload[field]
    if metadata:
        metadata["authority"] = "research_ranking_only_not_promotion_proof"
        payload["exact_replay_ledger_ranking"] = metadata
    return payload


def _exact_replay_candidate_for_payload(
    *,
    candidate_payload: Mapping[str, Any],
    by_candidate: Mapping[str, Mapping[str, Any]],
) -> Mapping[str, Any] | None:
    candidate_id = _string(candidate_payload.get("candidate_id"))
    if not candidate_id:
        return None
    exact_candidate = by_candidate.get(candidate_id)
    if exact_candidate is None:
        return None
    payload_refs = {
        str(Path(ref).expanduser().resolve(strict=False))
        for ref in _exact_replay_ledger_refs(candidate_payload)
    }
    if not payload_refs:
        return exact_candidate
    exact_ref = _string(exact_candidate.get("artifact_ref"))
    if not exact_ref:
        return None
    if str(Path(exact_ref).expanduser().resolve(strict=False)) not in payload_refs:
        return None
    return exact_candidate


def _write_exact_replay_ledger_remediation(
    *,
    run_root: Path,
    ranking_report: Mapping[str, Any],
) -> dict[str, Any]:
    path = run_root / "exact-replay-ledger-remediation.json"
    report = build_replay_ledger_remediation_report(ranking_report)
    path.write_text(json.dumps(report, indent=2, sort_keys=True), encoding="utf-8")
    return {
        "path": str(path),
        "report": report,
    }


def _persist_run_outputs(
    *,
    run_root: Path,
    program: StrategyAutoresearchProgram,
    program_payload: Mapping[str, Any],
    runner_run_id: str,
    program_id: str,
    frontier_runs: int,
    objective_met: bool,
    history: list[dict[str, Any]],
    manifest: MlxSnapshotManifest,
    descriptors: list[MlxCandidateDescriptor],
    proposal_scores: list[ProposalScore],
    worklist: list[WorkItem],
    status: str,
    selected_for_replay: ProposalSelectionEntry | None = None,
    selected_descriptor: MlxCandidateDescriptor | None = None,
    closure_execution_context: RuntimeClosureExecutionContext | None = None,
    error: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    history_path = run_root / "history.jsonl"
    results_tsv_path = run_root / "results.tsv"
    research_dossier_path = run_root / "research_dossier.json"
    summary_path = run_root / "summary.json"
    promotion_readiness_path = run_root / "promotion_readiness.json"
    snapshot_manifest_path = run_root / "mlx-snapshot-manifest.json"
    _write_history_jsonl(history_path, history)
    _write_results_tsv(results_tsv_path, history)
    research_dossier_path.write_text(
        json.dumps(program_payload, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    write_mlx_snapshot_manifest(snapshot_manifest_path, manifest)
    proposal_diagnostics = _proposal_diagnostics(
        descriptors=descriptors,
        proposal_scores=proposal_scores,
        history=history,
    )
    mlx_exports = write_mlx_notebook_exports(
        run_root=run_root,
        manifest=manifest,
        descriptors=descriptors,
        proposal_scores=proposal_scores,
        proposal_diagnostics=proposal_diagnostics,
    )
    notebook_paths = write_autoresearch_notebooks(run_root)
    exact_replay_ledger_ranking = _write_exact_replay_ledger_ranking(
        run_root=run_root,
        program=program,
    )
    exact_replay_ledger_remediation = _write_exact_replay_ledger_remediation(
        run_root=run_root,
        ranking_report=cast(Mapping[str, Any], exact_replay_ledger_ranking["report"]),
    )
    summary: dict[str, Any] = {
        "status": status,
        "runner_run_id": runner_run_id,
        "program_id": program_id,
        "run_root": str(run_root),
        "frontier_run_count": frontier_runs,
        "objective_met": objective_met,
        "objective_scope": "research_only",
        "history_path": str(history_path),
        "results_tsv_path": str(results_tsv_path),
        "research_dossier_path": str(research_dossier_path),
        "promotion_readiness_path": str(promotion_readiness_path),
        "snapshot_manifest_path": str(snapshot_manifest_path),
        "exact_replay_ledger_ranking_path": exact_replay_ledger_ranking["path"],
        "exact_replay_ledger_ranking": exact_replay_ledger_ranking["report"],
        "exact_replay_ledger_remediation_path": exact_replay_ledger_remediation["path"],
        "exact_replay_ledger_remediation": exact_replay_ledger_remediation["report"],
        "best_exact_replay_ledger_candidate": exact_replay_ledger_ranking[
            "best_candidate"
        ],
        "mlx_exports": dict(mlx_exports),
        "notebooks": [str(path) for path in notebook_paths],
        "best_candidate": _best_history_record(history),
        "live_progress": _live_progress_payload(
            run_root=run_root,
            frontier_runs=frontier_runs,
            worklist=worklist,
            history=history,
            descriptors=descriptors,
            proposal_scores=proposal_scores,
            best_exact_replay_ledger_candidate=cast(
                Mapping[str, Any] | None,
                exact_replay_ledger_ranking["best_candidate"],
            ),
            exact_replay_ledger_remediation=cast(
                Mapping[str, Any] | None,
                exact_replay_ledger_remediation["report"],
            ),
            selected_for_replay=selected_for_replay,
            selected_descriptor=selected_descriptor,
        ),
    }
    best_candidate = cast(dict[str, Any] | None, summary["best_candidate"])
    portfolio, portfolio_outputs = _write_portfolio_outputs(
        run_root=run_root,
        program=program,
    )
    summary.update(portfolio_outputs)
    summary["best_portfolio_candidate"] = (
        portfolio.to_payload() if portfolio is not None else None
    )
    runtime_closure = write_runtime_closure_bundle(
        run_root=run_root,
        runner_run_id=runner_run_id,
        program=program,
        best_candidate=_runtime_closure_subject(
            best_candidate=best_candidate,
            portfolio=portfolio,
        ),
        manifest=manifest,
        execution_context=closure_execution_context,
    )
    summary["runtime_closure"] = runtime_closure.to_payload()
    summary["promotion_readiness"] = _summary_promotion_readiness_for_outputs(
        best_candidate=best_candidate,
        portfolio=portfolio,
        runtime_closure=summary["runtime_closure"],
    )
    runtime_window_import_plan = _strategy_autoresearch_runtime_window_import_plan(
        history=history,
        best_exact_replay_ledger_candidate=cast(
            Mapping[str, Any] | None,
            exact_replay_ledger_ranking["best_candidate"],
        ),
        exact_replay_ledger_remediation=cast(
            Mapping[str, Any],
            exact_replay_ledger_remediation["report"],
        ),
    )
    summary["runtime_window_import_plan"] = runtime_window_import_plan
    summary["candidate_board"] = {
        "schema_version": "torghut.strategy-autoresearch-candidate-board.v1",
        "current_answer": "promotion_candidate_found"
        if bool(_mapping(summary["promotion_readiness"]).get("promotable"))
        else "no_promotion_ready_candidate",
        "promotion_allowed": False,
        "best_research_candidate": best_candidate,
        "best_exact_replay_ledger_candidate": summary[
            "best_exact_replay_ledger_candidate"
        ],
        "exact_replay_ledger_remediation": summary["exact_replay_ledger_remediation"],
        "runtime_window_import_plan": runtime_window_import_plan,
    }
    if error is not None:
        summary["error"] = dict(error)
    promotion_readiness_path.write_text(
        json.dumps(summary["promotion_readiness"], indent=2, sort_keys=True),
        encoding="utf-8",
    )
    summary_path.write_text(
        json.dumps(summary, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    return summary


__all__ = [name for name in globals() if not name.startswith("__")]
