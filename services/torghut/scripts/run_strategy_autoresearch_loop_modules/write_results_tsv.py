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


def _write_results_tsv(path: Path, history: list[dict[str, Any]]) -> None:
    header = [
        "experiment",
        "iteration",
        "family_template_id",
        "candidate_id",
        "net_pnl_per_day",
        "execution_quality_adjusted_window_net_pnl_per_day",
        "execution_quality_penalty_bps",
        "execution_quality_blocker_count",
        "active_day_ratio",
        "best_day_share",
        "max_drawdown",
        "status",
        "staged_search_stage",
        "staged_full_replay_candidates_started",
        "description",
    ]
    rows = ["\t".join(header)]
    for item in history:
        rows.append(
            "\t".join(
                [
                    _sanitize_tsv_field(item["experiment_index"]),
                    _sanitize_tsv_field(item["iteration"]),
                    _sanitize_tsv_field(item["family_template_id"]),
                    _sanitize_tsv_field(item["candidate_id"]),
                    _sanitize_tsv_field(item["net_pnl_per_day"]),
                    _sanitize_tsv_field(
                        item.get(
                            "execution_quality_adjusted_window_net_pnl_per_day", ""
                        )
                    ),
                    _sanitize_tsv_field(item.get("execution_quality_penalty_bps", "")),
                    _sanitize_tsv_field(
                        item.get("execution_quality_blocker_count", "")
                    ),
                    _sanitize_tsv_field(item["active_day_ratio"]),
                    _sanitize_tsv_field(item["best_day_share"]),
                    _sanitize_tsv_field(item["max_drawdown"]),
                    _sanitize_tsv_field(item["status"]),
                    _sanitize_tsv_field(item.get("staged_search_stage", "")),
                    _sanitize_tsv_field(
                        item.get("staged_full_replay_candidates_started", "")
                    ),
                    _sanitize_tsv_field(item["mutation_label"]),
                ]
            )
        )
    path.write_text("\n".join(rows) + "\n", encoding="utf-8")


def _research_ranking_net_pnl_per_day(item: Mapping[str, Any]) -> float:
    base = (
        _maybe_decimal(item.get("deployable_lower_bound_net_pnl_per_day"))
        or _maybe_decimal(item.get("net_pnl_per_day"))
        or Decimal("0")
    )
    adjusted = _maybe_decimal(
        item.get("execution_quality_adjusted_window_net_pnl_per_day")
    )
    if adjusted is not None:
        base = min(base, adjusted)
    return float(base)


def _best_history_record(history: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not history:
        return None
    sorted_history = sorted(
        history,
        key=lambda item: (
            item["status"] != "keep",
            bool(item["hard_vetoes"]),
            int(item["pareto_tier"]),
            -_research_ranking_net_pnl_per_day(item),
            -float(item["net_pnl_per_day"] or "0"),
            -float(item["active_day_ratio"] or "0"),
        ),
    )
    return sorted_history[0]


def _strategy_name_from_strategy_id(strategy_id: str) -> str:
    base = strategy_id.split("@", 1)[0].strip()
    return base.replace("_", "-") if base else ""


def _hypothesis_manifest_rows() -> list[dict[str, str]]:
    hypothesis_dir = _REPO_ROOT / "services/torghut/config/trading/hypotheses"
    rows: list[dict[str, str]] = []
    if not hypothesis_dir.exists():
        return rows
    for path in sorted(hypothesis_dir.glob("*.json")):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        data = _mapping(payload)
        hypothesis_id = _string(data.get("hypothesis_id"))
        if not hypothesis_id:
            continue
        strategy_id = _string(data.get("strategy_id"))
        rows.append(
            {
                "hypothesis_id": hypothesis_id,
                "strategy_id": strategy_id,
                "strategy_id_base": strategy_id.split("@", 1)[0].strip(),
                "strategy_name": _string(data.get("strategy_name"))
                or _strategy_name_from_strategy_id(strategy_id),
                "strategy_family": _string(data.get("strategy_family")),
                "candidate_id": _string(data.get("candidate_id")),
                "dataset_snapshot_ref": _string(data.get("dataset_snapshot_ref")),
                "source_manifest_ref": str(path),
            }
        )
    return rows


def _hypothesis_manifest_for_history_row(
    row: Mapping[str, Any],
) -> dict[str, str]:
    family_template_id = _string(row.get("family_template_id"))
    runtime_family = _string(row.get("runtime_family"))
    runtime_strategy_name = _string(row.get("runtime_strategy_name"))
    for manifest in _hypothesis_manifest_rows():
        if family_template_id and manifest["strategy_id_base"] == family_template_id:
            return manifest
    for manifest in _hypothesis_manifest_rows():
        if runtime_family and manifest["strategy_family"] == runtime_family:
            return manifest
    for manifest in _hypothesis_manifest_rows():
        if runtime_strategy_name and manifest["strategy_name"] == runtime_strategy_name:
            return manifest
    return {}


def _dedupe_nonempty_strings(values: list[Any]) -> list[str]:
    items: list[str] = []
    seen: set[str] = set()
    for value in values:
        text = _string(value)
        if not text:
            continue
        key = (
            str(Path(text).expanduser().resolve(strict=False))
            if text.startswith("/")
            else text
        )
        if key in seen:
            continue
        seen.add(key)
        items.append(text)
    return items


def _exact_replay_history_row(
    *,
    history: list[dict[str, Any]],
    candidate_id: str,
) -> dict[str, Any] | None:
    for row in history:
        if _string(row.get("candidate_id")) == candidate_id:
            return row
    return None


def _exact_replay_runtime_window_blockers(
    *,
    best_exact_replay_ledger_candidate: Mapping[str, Any] | None,
    history_row: Mapping[str, Any] | None,
    hypothesis_manifest: Mapping[str, str],
    artifact_refs: list[str],
    promotion_blockers: list[str],
    runtime_ledger_blockers: list[str],
) -> list[dict[str, Any]]:
    blockers: list[dict[str, Any]] = []
    if best_exact_replay_ledger_candidate is None:
        blockers.append(
            {
                "blocker": "exact_replay_ledger_candidate_missing",
                "remediation": "produce_exact_replay_ledger_artifacts",
            }
        )
        return blockers
    candidate_id = _string(best_exact_replay_ledger_candidate.get("candidate_id"))
    if history_row is None:
        blockers.append(
            {
                "blocker": "candidate_history_row_missing",
                "candidate_id": candidate_id,
                "remediation": "rerun_strategy_autoresearch_with_history_persistence",
            }
        )
    if not hypothesis_manifest:
        blockers.append(
            {
                "blocker": "hypothesis_manifest_missing",
                "candidate_id": candidate_id,
                "remediation": (
                    "add or select a checked-in hypothesis manifest before runtime "
                    "paper evidence can be imported"
                ),
            }
        )
    if history_row is not None:
        missing_fields = [
            field
            for field in ("runtime_family", "runtime_strategy_name")
            if not _string(history_row.get(field))
        ]
        if missing_fields:
            blockers.append(
                {
                    "blocker": "runtime_harness_metadata_missing",
                    "candidate_id": candidate_id,
                    "missing_fields": missing_fields,
                }
            )
    if not artifact_refs:
        blockers.append(
            {
                "blocker": "exact_replay_ledger_artifact_ref_missing",
                "candidate_id": candidate_id,
                "remediation": "enable exact replay ledger artifact output",
            }
        )
    blocker_names = _dedupe_nonempty_strings(
        [*promotion_blockers, *runtime_ledger_blockers]
    )
    search_blockers = [
        blocker
        for blocker in blocker_names
        if blocker != "replay_artifact_only_not_live"
    ]
    if search_blockers:
        blockers.append(
            {
                "blocker": "exact_replay_search_blockers_remaining",
                "candidate_id": candidate_id,
                "blocking_reasons": search_blockers,
                "remediation": (
                    "keep search remediation active; any runtime-window target is "
                    "evidence collection only and cannot authorize promotion"
                ),
            }
        )
    return blockers


def _strategy_autoresearch_runtime_window_import_plan(
    *,
    history: list[dict[str, Any]],
    best_exact_replay_ledger_candidate: Mapping[str, Any] | None,
    exact_replay_ledger_remediation: Mapping[str, Any],
) -> dict[str, Any]:
    candidate_id = (
        _string(best_exact_replay_ledger_candidate.get("candidate_id"))
        if best_exact_replay_ledger_candidate is not None
        else ""
    )
    history_row = (
        _exact_replay_history_row(history=history, candidate_id=candidate_id)
        if candidate_id
        else None
    )
    hypothesis_manifest = (
        _hypothesis_manifest_for_history_row(history_row)
        if history_row is not None
        else {}
    )
    promotion_blockers = [
        _string(item)
        for item in cast(
            list[Any],
            exact_replay_ledger_remediation.get("promotion_blockers") or [],
        )
        if _string(item)
    ]
    runtime_ledger_blockers = [
        _string(item)
        for item in cast(
            list[Any],
            exact_replay_ledger_remediation.get("runtime_ledger_blockers") or [],
        )
        if _string(item)
    ]
    artifact_refs = _dedupe_nonempty_strings(
        [
            best_exact_replay_ledger_candidate.get("artifact_ref")
            if best_exact_replay_ledger_candidate is not None
            else "",
            history_row.get("exact_replay_ledger_artifact_ref") if history_row else "",
        ]
    )
    blockers = _exact_replay_runtime_window_blockers(
        best_exact_replay_ledger_candidate=best_exact_replay_ledger_candidate,
        history_row=history_row,
        hypothesis_manifest=hypothesis_manifest,
        artifact_refs=artifact_refs,
        promotion_blockers=promotion_blockers,
        runtime_ledger_blockers=runtime_ledger_blockers,
    )
    targets: list[dict[str, Any]] = []
    if (
        best_exact_replay_ledger_candidate is not None
        and history_row is not None
        and hypothesis_manifest
        and artifact_refs
    ):
        target_metadata_blockers = _dedupe_nonempty_strings(
            [
                *promotion_blockers,
                *runtime_ledger_blockers,
                "paper_probation_evidence_collection_only",
            ]
        )
        row_count = _string(history_row.get("exact_replay_ledger_artifact_row_count"))
        fill_count = _string(history_row.get("exact_replay_ledger_artifact_fill_count"))
        search_blockers = [
            blocker
            for blocker in _dedupe_nonempty_strings(
                [*promotion_blockers, *runtime_ledger_blockers]
            )
            if blocker != "replay_artifact_only_not_live"
        ]
        probation_allowed = not search_blockers
        window_start = _string(best_exact_replay_ledger_candidate.get("window_start"))
        window_end = _string(best_exact_replay_ledger_candidate.get("window_end"))
        target = {
            "run_id": _string(history_row.get("runner_run_id"))
            or "strategy-autoresearch-runtime-window-import",
            "candidate_id": candidate_id,
            "hypothesis_id": hypothesis_manifest["hypothesis_id"],
            "observed_stage": "paper",
            "strategy_family": _string(history_row.get("runtime_family")),
            "strategy_name": _string(history_row.get("runtime_strategy_name")),
            "account_label": "TORGHUT_REPLAY",
            "source_kind": "simulation_exact_replay_runtime_ledger",
            "source_manifest_ref": hypothesis_manifest["source_manifest_ref"],
            "dataset_snapshot_ref": _string(history_row.get("dataset_snapshot_id"))
            or hypothesis_manifest["dataset_snapshot_ref"],
            "artifact_refs": artifact_refs,
            "exact_replay_ledger_artifact_refs": artifact_refs,
            "exact_replay_ledger_artifact_ref": artifact_refs[0],
            "window_start": window_start,
            "window_end": window_end,
            "candidate_selection": "exact_replay_ledger_best_candidate",
            "selected_by": "strategy_autoresearch_exact_replay_ledger_ranking",
            "selection_reason": _string(exact_replay_ledger_remediation.get("status")),
            "paper_probation_authorized": probation_allowed,
            "paper_probation_authorization_scope": "evidence_collection_only",
            "evidence_collection_stage": "paper",
            "probation_allowed": probation_allowed,
            "probation_reason": "exact_replay_policy_checks_passed"
            if probation_allowed
            else "exact_replay_search_blockers_remaining",
            "promotion_allowed": False,
            "final_promotion_authorized": False,
            "final_promotion_allowed": False,
            "final_promotion_blockers": target_metadata_blockers,
            "runtime_ledger_target_metadata_blockers": target_metadata_blockers,
            "handoff": "runtime_window_import_from_exact_replay_ledger",
            "promotion_gate": "runtime_ledger_live_or_live_paper_required",
        }
        if row_count:
            target["exact_replay_ledger_artifact_row_count"] = row_count
        if fill_count:
            target["exact_replay_ledger_artifact_fill_count"] = fill_count
        targets.append(target)
    return {
        "schema_version": "torghut.runtime-window-import-plan.v1",
        "source": "strategy_autoresearch_exact_replay_ledger",
        "purpose": (
            "handoff exact replay-ledger winners into bounded paper/runtime-window "
            "evidence collection without authorizing final promotion"
        ),
        "promotion_allowed": False,
        "targets": targets,
        "blockers": blockers,
    }


def _runtime_closure_candidate(
    best_candidate: Mapping[str, Any] | None,
) -> Mapping[str, Any] | None:
    if best_candidate is None:
        return None
    if not bool(best_candidate.get("objective_met")):
        return None
    if cast(list[Any], best_candidate.get("hard_vetoes") or []):
        return None
    return best_candidate


def _portfolio_objective_scorecard(
    portfolio: PortfolioCandidateSpec | None,
) -> Mapping[str, Any]:
    return portfolio.objective_scorecard if portfolio is not None else {}


def _portfolio_is_runtime_closure_candidate(
    portfolio: PortfolioCandidateSpec | None,
) -> bool:
    scorecard = _portfolio_objective_scorecard(portfolio)
    return bool(scorecard.get("target_met")) and bool(scorecard.get("oracle_passed"))


def _runtime_closure_subject(
    *,
    best_candidate: Mapping[str, Any] | None,
    portfolio: PortfolioCandidateSpec | None,
) -> Mapping[str, Any] | PortfolioCandidateSpec | None:
    if _portfolio_is_runtime_closure_candidate(portfolio):
        return portfolio
    return _runtime_closure_candidate(best_candidate)


def _runtime_closure_pending_promotion_steps(
    runtime_closure: Mapping[str, Any],
) -> tuple[str, ...]:
    return tuple(
        step
        for step in (
            _string(item)
            for item in cast(
                list[Any], runtime_closure.get("next_required_steps") or []
            )
        )
        if step and step != "promotion_review"
    )


def _runtime_closure_promotion_prerequisite_blockers(
    runtime_closure: Mapping[str, Any],
) -> tuple[str, ...]:
    prerequisites = _mapping(runtime_closure.get("promotion_prerequisites"))
    if not prerequisites:
        return ("promotion_prerequisites_missing",)
    if bool(prerequisites.get("allowed")):
        return ()
    reasons = tuple(
        reason
        for reason in (
            _string(item)
            for item in cast(list[Any], prerequisites.get("reasons") or [])
        )
        if reason
    )
    return reasons or ("promotion_prerequisites_denied",)


def _portfolio_promotion_readiness(
    *,
    portfolio: PortfolioCandidateSpec,
    runtime_closure: Mapping[str, Any],
) -> dict[str, Any]:
    blockers = list(
        dict.fromkeys(
            (
                *_runtime_closure_pending_promotion_steps(runtime_closure),
                *_runtime_closure_promotion_prerequisite_blockers(runtime_closure),
            )
        )
    )
    if not blockers:
        status = "promotion_ready"
        promotable = True
        reason = (
            "Portfolio candidate has passed oracle and runtime promotion prerequisites."
        )
    else:
        status = "blocked_pending_promotion_prerequisites"
        promotable = False
        reason = (
            "Portfolio candidate passed the profit oracle, but promotion still requires "
            "runtime closure evidence before it can be activated."
        )
    return {
        "candidate_id": portfolio.portfolio_candidate_id,
        "portfolio_candidate_id": portfolio.portfolio_candidate_id,
        "source_candidate_ids": list(portfolio.source_candidate_ids),
        "family_template_id": "portfolio_whitepaper_autoresearch_v1",
        "stage": "portfolio_candidate",
        "status": status,
        "promotable": promotable,
        "reason": reason,
        "blockers": blockers,
        "required_evidence": [
            "portfolio_optimizer_evidence",
            "scheduler_v3_parity_replay",
            "scheduler_v3_approval_replay",
            "live_shadow_validation",
            "promotion_prerequisites",
        ],
        "runtime_closure_status": _string(runtime_closure.get("status")),
        "runtime_family": "",
        "runtime_strategy_name": "",
        "runtime_strategy_names": list(
            cast(
                list[str], _mapping(runtime_closure).get("runtime_strategy_names") or []
            )
        ),
    }


def _summary_promotion_readiness_for_outputs(
    *,
    best_candidate: Mapping[str, Any] | None,
    portfolio: PortfolioCandidateSpec | None,
    runtime_closure: Mapping[str, Any],
) -> dict[str, Any]:
    if _portfolio_is_runtime_closure_candidate(portfolio):
        if portfolio is None:
            raise ValueError("portfolio_runtime_closure_candidate_missing")
        return _portfolio_promotion_readiness(
            portfolio=portfolio,
            runtime_closure=runtime_closure,
        )
    return summary_promotion_readiness(best_candidate)


def _portfolio_oracle_policy(
    program: StrategyAutoresearchProgram,
) -> ProfitTargetOraclePolicy:
    objective = program.objective
    return ProfitTargetOraclePolicy(
        min_active_day_ratio=objective.min_active_day_ratio,
        min_positive_day_ratio=objective.min_positive_day_ratio,
        min_profit_factor=objective.min_profit_factor,
        min_daily_net_pnl=objective.min_daily_net_pnl,
        max_best_day_share=objective.max_best_day_share,
        max_cluster_contribution_share=Decimal("0.40"),
        max_single_symbol_contribution_share=Decimal("0.35"),
        max_worst_day_loss=objective.max_worst_day_loss,
        max_drawdown=objective.max_drawdown,
        default_start_equity=objective.default_start_equity,
        max_worst_day_loss_pct_equity=objective.max_worst_day_loss_pct_equity,
        max_drawdown_pct_equity=objective.max_drawdown_pct_equity,
        extended_max_worst_day_loss_pct_equity=(
            objective.extended_max_worst_day_loss_pct_equity
        ),
        extended_max_drawdown_pct_equity=objective.extended_max_drawdown_pct_equity,
        min_total_net_pnl_to_drawdown_ratio=(
            objective.min_total_net_pnl_to_drawdown_ratio
        ),
        max_gross_exposure_pct_equity=objective.max_gross_exposure_pct_equity,
        min_cash=objective.min_cash,
        min_avg_filled_notional_per_day=objective.min_daily_notional,
        min_observed_trading_days=objective.min_observed_trading_days,
        min_regime_slice_pass_rate=objective.min_regime_slice_pass_rate,
        require_shadow_parity_within_budget=True,
        require_executable_replay=True,
    )


def _candidate_spec_id_for_portfolio_payload(
    *,
    candidate: Mapping[str, Any],
    result_path: Path,
) -> str:
    return (
        _string(candidate.get("candidate_spec_id"))
        or _string(candidate.get("descriptor_id"))
        or _string(candidate.get("candidate_id"))
        or result_path.parent.name
    )


def _portfolio_evidence_bundles_from_results(
    run_root: Path,
) -> tuple[CandidateEvidenceBundle, ...]:
    bundles: list[CandidateEvidenceBundle] = []
    seen_bundle_ids: set[str] = set()
    for result_path in sorted((run_root / "experiments").glob("*/result.json")):
        try:
            payload = json.loads(result_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            continue
        if not isinstance(payload, Mapping):
            continue
        dataset_snapshot_id = _string(
            _mapping(payload.get("dataset_snapshot_receipt")).get("snapshot_id")
        )
        for candidate in cast(list[Mapping[str, Any]], payload.get("top") or []):
            if not isinstance(candidate, Mapping):
                continue
            bundle = evidence_bundle_from_frontier_candidate(
                candidate_spec_id=_candidate_spec_id_for_portfolio_payload(
                    candidate=candidate,
                    result_path=result_path,
                ),
                candidate=candidate,
                dataset_snapshot_id=dataset_snapshot_id,
                result_path=str(result_path),
            )
            if bundle.evidence_bundle_id in seen_bundle_ids:
                continue
            seen_bundle_ids.add(bundle.evidence_bundle_id)
            bundles.append(bundle)
    return tuple(bundles)


__all__ = [name for name in globals() if not name.startswith("__")]
