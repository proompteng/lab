#!/usr/bin/env python3
"""Run an autoresearch-style outer loop for Torghut strategy discovery."""

from __future__ import annotations

import argparse
import json
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping, cast

import yaml

from app.trading.discovery.autoresearch import (
    FamilyAutoresearchPlan,
)
from app.trading.discovery.mlx_features import (
    MlxCandidateDescriptor,
)
from app.trading.discovery.mlx_proposal_models import (
    ProposalScore,
)
from app.trading.discovery.mlx_snapshot import (
    MlxSignalBundleStats,
    write_mlx_signal_bundle,
)
from app.trading.discovery.objectives import (
    deployable_lower_bound_missing_count,
    deployable_lower_bound_net_pnl_per_day,
    deployable_proof_failed_gate_count,
)
from app.trading.discovery.replay_tape import (
    ReplayTapeManifest,
    build_source_query_digest,
    default_manifest_path,
    materialize_signal_tape,
)
import scripts.local_intraday_tsmom_replay as replay_mod

from .shared_context import (
    LatestCompleteWindowRequirement,
    _mapping,
    _promotion_readiness_payload,
    _select_effective_replay_tape_window,
    _string,
)


def _load_yaml(path: Path) -> dict[str, Any]:
    payload = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        raise ValueError(f"sweep_config_not_mapping:{path}")
    return json.loads(json.dumps(payload))


def _default_full_window_day_count(args: argparse.Namespace) -> int | None:
    # Only stamp count-based full-window constraints when the full window is the same
    # exact window as train + holdout. If the caller widens the full window, ratios remain
    # safe but hard counts would become biased unless we resolve the real trading-day set.
    if _string(args.full_window_start_date) or _string(args.full_window_end_date):
        return None
    return max(1, int(args.train_days)) + max(1, int(args.holdout_days))


def _iso_date(value: str) -> date:
    return date.fromisoformat(value)


def _full_window_signal_config(
    *,
    args: argparse.Namespace,
    snapshot_symbols: tuple[str, ...],
    full_window_start_date: str,
    full_window_end_date: str,
) -> replay_mod.ReplayConfig | None:
    if not full_window_start_date or not full_window_end_date or not snapshot_symbols:
        return None
    return replay_mod.ReplayConfig(
        strategy_configmap_path=args.strategy_configmap.resolve(),
        clickhouse_http_url=str(args.clickhouse_http_url),
        clickhouse_username=(str(args.clickhouse_username).strip() or None),
        clickhouse_password=(str(args.clickhouse_password).strip() or None),
        start_date=_iso_date(full_window_start_date),
        end_date=_iso_date(full_window_end_date),
        chunk_minutes=max(1, int(args.chunk_minutes)),
        flatten_eod=True,
        start_equity=Decimal(str(args.start_equity)),
        symbols=snapshot_symbols,
        replay_tape_path=(
            Path(replay_tape_path).resolve()
            if (replay_tape_path := getattr(args, "replay_tape_path", None)) is not None
            else None
        ),
        replay_tape_manifest_path=(
            Path(replay_tape_manifest).resolve()
            if (replay_tape_manifest := getattr(args, "replay_tape_manifest", None))
            is not None
            else None
        ),
        allow_stale_tape=bool(getattr(args, "allow_stale_tape", False)),
        progress_log_interval_seconds=max(1, int(args.progress_log_seconds)),
    )


def _replay_tape_source_query_digest(
    *,
    args: argparse.Namespace,
    snapshot_symbols: tuple[str, ...],
    full_window_start_date: str,
    full_window_end_date: str,
) -> str:
    return build_source_query_digest(
        {
            "query_family": "torghut.autoresearch_full_window_pt1s",
            "clickhouse_http_url": str(args.clickhouse_http_url),
            "start_date": full_window_start_date,
            "end_date": full_window_end_date,
            "chunk_minutes": max(1, int(args.chunk_minutes)),
            "symbols": list(snapshot_symbols),
            "source": "ta",
            "window_size": "PT1S",
            "join": "torghut.ta_microbars",
        }
    )


def _replay_tape_receipt(
    *,
    status: str,
    tape_path: Path,
    manifest_path: Path,
    manifest: ReplayTapeManifest,
) -> dict[str, Any]:
    return {
        "schema_version": "torghut.autoresearch-replay-tape-receipt.v1",
        "status": status,
        "tape_path": str(tape_path),
        "manifest_path": str(manifest_path),
        "dataset_snapshot_ref": manifest.dataset_snapshot_ref,
        "row_count": manifest.row_count,
        "trading_day_count": manifest.trading_day_count,
        "row_symbols": list(manifest.row_symbols),
        "content_sha256": manifest.content_sha256,
        "source_query_digest": manifest.source_query_digest,
    }


def _provided_replay_tape_receipt(
    *,
    tape_path: Path,
    manifest_path: Path | None,
) -> dict[str, Any] | None:
    resolved_manifest_path = manifest_path or default_manifest_path(tape_path)
    if not resolved_manifest_path.exists():
        return None
    manifest = ReplayTapeManifest.from_payload(
        json.loads(resolved_manifest_path.read_text(encoding="utf-8"))
    )
    return _replay_tape_receipt(
        status="provided",
        tape_path=tape_path,
        manifest_path=resolved_manifest_path,
        manifest=manifest,
    )


def _maybe_write_signal_bundle(
    *,
    args: argparse.Namespace,
    snapshot_symbols: tuple[str, ...],
    bundle_paths: Mapping[str, str],
    full_window_start_date: str,
    full_window_end_date: str,
    existing: MlxSignalBundleStats | None,
) -> MlxSignalBundleStats | None:
    if existing is not None:
        return existing
    signal_bundle_config = _full_window_signal_config(
        args=args,
        snapshot_symbols=snapshot_symbols,
        full_window_start_date=full_window_start_date,
        full_window_end_date=full_window_end_date,
    )
    if signal_bundle_config is None:
        return existing
    return write_mlx_signal_bundle(
        Path(bundle_paths["signal_rows_jsonl"]),
        replay_mod._iter_signal_rows(signal_bundle_config),
    )


def _latest_complete_window_requirement(
    args: argparse.Namespace,
    *,
    objective_min_observed_trading_days: int,
) -> LatestCompleteWindowRequirement:
    cli_min_days = max(0, int(getattr(args, "latest_complete_window_min_days", 0) or 0))
    objective_min_days = max(0, int(objective_min_observed_trading_days or 0))
    min_days = max(cli_min_days, objective_min_days)
    if min_days <= 0:
        return LatestCompleteWindowRequirement(
            min_days=0,
            source="disabled",
            cli_min_days=cli_min_days,
            objective_min_days=objective_min_days,
        )
    if cli_min_days > 0 and cli_min_days >= objective_min_days:
        return LatestCompleteWindowRequirement(
            min_days=min_days,
            source="cli",
            cli_min_days=cli_min_days,
            objective_min_days=objective_min_days,
        )
    if cli_min_days > 0 and cli_min_days < objective_min_days:
        return LatestCompleteWindowRequirement(
            min_days=min_days,
            source="objective_min_observed_trading_days_floor",
            cli_min_days=cli_min_days,
            objective_min_days=objective_min_days,
        )
    return LatestCompleteWindowRequirement(
        min_days=min_days,
        source="objective_min_observed_trading_days",
        cli_min_days=cli_min_days,
        objective_min_days=objective_min_days,
    )


def _maybe_materialize_run_replay_tape(
    *,
    args: argparse.Namespace,
    runner_run_id: str,
    snapshot_symbols: tuple[str, ...],
    bundle_paths: Mapping[str, str],
    full_window_start_date: str,
    full_window_end_date: str,
    existing_signal_bundle: MlxSignalBundleStats | None,
    objective_min_observed_trading_days: int = 0,
) -> tuple[MlxSignalBundleStats | None, dict[str, Any] | None]:
    if not bool(getattr(args, "materialize_replay_tape", False)):
        return existing_signal_bundle, None
    if getattr(args, "replay_tape_path", None) is not None:
        return existing_signal_bundle, None
    requested_full_window_start_date = full_window_start_date
    requested_full_window_end_date = full_window_end_date
    window_requirement = _latest_complete_window_requirement(
        args,
        objective_min_observed_trading_days=objective_min_observed_trading_days,
    )
    latest_window_receipt: dict[str, Any] | None = None
    if (
        window_requirement.min_days > 0
        and full_window_start_date
        and full_window_end_date
    ):
        window_args = argparse.Namespace(
            **{
                **vars(args),
                "latest_complete_window_min_days": window_requirement.min_days,
                "latest_complete_window_receipt_output": (
                    getattr(args, "latest_complete_window_receipt_output", None)
                    or Path(
                        bundle_paths["replay_tape_latest_complete_window_receipt_json"]
                    )
                ),
                "coverage_diagnostic_output": (
                    getattr(args, "coverage_diagnostic_output", None)
                    or Path(bundle_paths["replay_tape_coverage_diagnostics_json"])
                ),
            }
        )
        selected_start, selected_end, latest_window_receipt = (
            _select_effective_replay_tape_window(
                args=window_args,
                symbols=snapshot_symbols,
                requested_start_date=_iso_date(full_window_start_date),
                requested_end_date=_iso_date(full_window_end_date),
            )
        )
        full_window_start_date = selected_start.isoformat()
        full_window_end_date = selected_end.isoformat()
    signal_bundle_config = _full_window_signal_config(
        args=args,
        snapshot_symbols=snapshot_symbols,
        full_window_start_date=full_window_start_date,
        full_window_end_date=full_window_end_date,
    )
    if signal_bundle_config is None:
        return existing_signal_bundle, None
    rows = tuple(replay_mod._iter_signal_rows(signal_bundle_config))
    tape_path = Path(bundle_paths["replay_tape_jsonl"])
    manifest_path = Path(bundle_paths["replay_tape_manifest_json"])
    manifest = materialize_signal_tape(
        rows=rows,
        tape_path=tape_path,
        manifest_path=manifest_path,
        dataset_snapshot_ref=runner_run_id,
        symbols=snapshot_symbols,
        start_date=_iso_date(full_window_start_date),
        end_date=_iso_date(full_window_end_date),
        source_query_digest=_replay_tape_source_query_digest(
            args=args,
            snapshot_symbols=snapshot_symbols,
            full_window_start_date=full_window_start_date,
            full_window_end_date=full_window_end_date,
        ),
        require_complete_coverage=not bool(getattr(args, "allow_stale_tape", False)),
    )
    signal_bundle_stats = existing_signal_bundle or write_mlx_signal_bundle(
        Path(bundle_paths["signal_rows_jsonl"]),
        rows,
    )
    receipt = _replay_tape_receipt(
        status="materialized",
        tape_path=tape_path,
        manifest_path=manifest_path,
        manifest=manifest,
    )
    receipt["requested_full_window_start_date"] = requested_full_window_start_date
    receipt["requested_full_window_end_date"] = requested_full_window_end_date
    receipt["effective_full_window_start_date"] = full_window_start_date
    receipt["effective_full_window_end_date"] = full_window_end_date
    receipt["objective_min_observed_trading_days"] = max(
        0, int(objective_min_observed_trading_days or 0)
    )
    receipt["latest_complete_window_min_days"] = window_requirement.min_days
    receipt["latest_complete_window_min_days_source"] = window_requirement.source
    receipt["latest_complete_window_cli_min_days"] = window_requirement.cli_min_days
    receipt["latest_complete_window_objective_min_days"] = (
        window_requirement.objective_min_days
    )
    if latest_window_receipt is not None:
        receipt["latest_complete_window"] = latest_window_receipt
    return signal_bundle_stats, receipt


def _history_record(
    *,
    runner_run_id: str,
    experiment_index: int,
    family_plan: FamilyAutoresearchPlan,
    iteration: int,
    mutation_label: str,
    parent_candidate_id: str | None,
    sweep_config_path: Path,
    result_path: Path,
    candidate_payload: Mapping[str, Any],
    rank: int,
    status: str,
    objective_met: bool,
    dataset_snapshot_id: str,
    descriptor: MlxCandidateDescriptor | None = None,
    proposal_score: ProposalScore | None = None,
    proposal_selected: bool = False,
    proposal_selection_reason: str = "",
    disable_other_strategies: bool = True,
) -> dict[str, Any]:
    full_window = _mapping(candidate_payload.get("full_window"))
    scorecard = _mapping(candidate_payload.get("objective_scorecard"))
    ranking = _mapping(candidate_payload.get("ranking"))
    replay_config = _mapping(candidate_payload.get("replay_config"))
    staged_search = _mapping(candidate_payload.get("staged_search"))
    exact_replay_ranking = _mapping(
        candidate_payload.get("exact_replay_ledger_ranking")
    )
    execution_quality = _mapping(
        candidate_payload.get("execution_quality") or scorecard.get("execution_quality")
    )
    execution_quality_blockers = [
        _string(item)
        for item in cast(
            list[Any],
            candidate_payload.get("execution_quality_blockers")
            or scorecard.get("execution_quality_blockers")
            or [],
        )
        if _string(item)
    ]
    promotion_readiness = _promotion_readiness_payload(family_plan=family_plan)
    deployable_lower_bound = deployable_lower_bound_net_pnl_per_day(scorecard)
    return {
        "runner_run_id": runner_run_id,
        "experiment_index": experiment_index,
        "iteration": iteration,
        "rank": rank,
        "family_template_id": family_plan.family_template.family_id,
        "candidate_id": _string(candidate_payload.get("candidate_id")),
        "parent_candidate_id": parent_candidate_id,
        "status": status,
        "objective_met": objective_met,
        "mutation_label": mutation_label,
        "dataset_snapshot_id": dataset_snapshot_id,
        "sweep_config_path": str(sweep_config_path),
        "result_path": str(result_path),
        "candidate_params": _mapping(replay_config.get("params")),
        "candidate_strategy_overrides": _mapping(
            replay_config.get("strategy_overrides")
        ),
        "disable_other_strategies": disable_other_strategies,
        "train_start_date": _string(replay_config.get("train_start_date")),
        "train_end_date": _string(replay_config.get("train_end_date")),
        "holdout_start_date": _string(replay_config.get("holdout_start_date")),
        "holdout_end_date": _string(replay_config.get("holdout_end_date")),
        "full_window_start_date": _string(replay_config.get("full_window_start_date")),
        "full_window_end_date": _string(replay_config.get("full_window_end_date")),
        "normalization_regime": _string(candidate_payload.get("normalization_regime")),
        "net_pnl_per_day": _string(
            scorecard.get("net_pnl_per_day") or full_window.get("net_per_day")
        ),
        "deployable_lower_bound_net_pnl_per_day": (
            str(deployable_lower_bound) if deployable_lower_bound is not None else ""
        ),
        "deployable_lower_bound_missing_count": deployable_lower_bound_missing_count(
            scorecard
        ),
        "deployable_lower_bound_failed_gate_count": (
            deployable_proof_failed_gate_count(scorecard)
        ),
        "market_impact_stress_passed": bool(
            scorecard.get("market_impact_stress_passed")
        ),
        "market_impact_stress_net_pnl_per_day": _string(
            scorecard.get("market_impact_stress_net_pnl_per_day")
        ),
        "delay_adjusted_depth_stress_passed": bool(
            scorecard.get("delay_adjusted_depth_stress_passed")
        ),
        "delay_adjusted_depth_stress_net_pnl_per_day": _string(
            scorecard.get("delay_adjusted_depth_stress_net_pnl_per_day")
        ),
        "delay_adjusted_depth_fill_survival_evidence_present": bool(
            scorecard.get("delay_adjusted_depth_fill_survival_evidence_present")
            or scorecard.get("fill_survival_evidence_present")
        ),
        "delay_adjusted_depth_fill_survival_sample_count": _string(
            scorecard.get("delay_adjusted_depth_fill_survival_sample_count")
            or scorecard.get("fill_survival_sample_count")
        ),
        "delay_adjusted_depth_fill_survival_rate": _string(
            scorecard.get("delay_adjusted_depth_fill_survival_rate")
            or scorecard.get("fill_survival_fill_rate")
            or scorecard.get("fill_survival_rate")
        ),
        "queue_position_survival_fill_curve_evidence_present": bool(
            scorecard.get("queue_position_survival_fill_curve_evidence_present")
        ),
        "queue_position_survival_sample_count": _string(
            scorecard.get("queue_position_survival_sample_count")
        ),
        "queue_position_survival_fill_rate": _string(
            scorecard.get("queue_position_survival_fill_rate")
        ),
        "queue_position_survival_queue_ratio_p95": _string(
            scorecard.get("queue_position_survival_queue_ratio_p95")
        ),
        "queue_position_survival_queue_ahead_depletion_evidence_present": bool(
            scorecard.get(
                "queue_position_survival_queue_ahead_depletion_evidence_present"
            )
        ),
        "queue_position_survival_queue_ahead_depletion_sample_count": _string(
            scorecard.get("queue_position_survival_queue_ahead_depletion_sample_count")
        ),
        "delay_adjusted_depth_queue_ahead_depletion_evidence_present": bool(
            scorecard.get("delay_adjusted_depth_queue_ahead_depletion_evidence_present")
        ),
        "delay_adjusted_depth_queue_ahead_depletion_sample_count": _string(
            scorecard.get("delay_adjusted_depth_queue_ahead_depletion_sample_count")
        ),
        "queue_ahead_depletion_evidence_present": bool(
            scorecard.get("queue_ahead_depletion_evidence_present")
        ),
        "queue_ahead_depletion_sample_count": _string(
            scorecard.get("queue_ahead_depletion_sample_count")
        ),
        "post_cost_net_pnl_after_queue_position_survival_fill_stress": _string(
            scorecard.get("post_cost_net_pnl_after_queue_position_survival_fill_stress")
        ),
        "double_oos_passed": bool(scorecard.get("double_oos_passed")),
        "double_oos_net_pnl_per_day": _string(
            scorecard.get("double_oos_net_pnl_per_day")
        ),
        "double_oos_cost_shock_net_pnl_per_day": _string(
            scorecard.get("double_oos_cost_shock_net_pnl_per_day")
        ),
        "implementation_uncertainty_stability_passed": bool(
            scorecard.get("implementation_uncertainty_stability_passed")
        ),
        "implementation_uncertainty_lower_net_pnl_per_day": _string(
            scorecard.get("implementation_uncertainty_lower_net_pnl_per_day")
        ),
        "conformal_tail_risk_required": bool(
            scorecard.get("conformal_tail_risk_required")
        ),
        "conformal_tail_risk_passed": bool(scorecard.get("conformal_tail_risk_passed")),
        "conformal_tail_risk_adjusted_net_pnl_per_day": _string(
            scorecard.get("conformal_tail_risk_adjusted_net_pnl_per_day")
        ),
        "conformal_tail_risk_buffer_per_day": _string(
            scorecard.get("conformal_tail_risk_buffer_per_day")
        ),
        "active_day_ratio": _string(scorecard.get("active_day_ratio")),
        "positive_day_ratio": _string(scorecard.get("positive_day_ratio")),
        "avg_filled_notional_per_day": _string(
            scorecard.get("avg_filled_notional_per_day")
        ),
        "avg_filled_notional_per_active_day": _string(
            scorecard.get("avg_filled_notional_per_active_day")
        ),
        "worst_day_loss": _string(scorecard.get("worst_day_loss")),
        "max_drawdown": _string(scorecard.get("max_drawdown")),
        "best_day_share": _string(scorecard.get("best_day_share")),
        "regime_slice_pass_rate": _string(scorecard.get("regime_slice_pass_rate")),
        "pareto_tier": int(ranking.get("pareto_tier") or 999),
        "tie_breaker_score": _string(ranking.get("tie_breaker_score")),
        "hard_vetoes": list(
            cast(list[str], candidate_payload.get("hard_vetoes") or [])
        ),
        "daily_net": _mapping(full_window.get("daily_net")),
        "daily_filled_notional": _mapping(full_window.get("daily_filled_notional")),
        "pruned_symbol": _string(candidate_payload.get("pruned_symbol")),
        "staged_search_stage": _string(staged_search.get("stage")),
        "staged_train_screen_multiplier": int(
            staged_search.get("train_screen_multiplier") or 1
        ),
        "staged_full_replay_candidate_budget": _string(
            staged_search.get("full_replay_candidate_budget")
        ),
        "staged_full_replay_candidates_started": int(
            staged_search.get("full_replay_candidates_started") or 0
        ),
        "objective_scope": "research_only",
        "promotion_stage": promotion_readiness["stage"],
        "promotion_status": promotion_readiness["status"],
        "promotable": promotion_readiness["promotable"],
        "promotion_reason": promotion_readiness["reason"],
        "promotion_blockers": list(cast(list[str], promotion_readiness["blockers"])),
        "promotion_required_evidence": list(
            cast(list[str], promotion_readiness["required_evidence"])
        ),
        "runtime_family": _string(
            _mapping(promotion_readiness["runtime_harness"]).get("family")
        ),
        "runtime_strategy_name": _string(
            _mapping(promotion_readiness["runtime_harness"]).get("strategy_name")
        ),
        "descriptor_id": _string(descriptor.descriptor_id)
        if descriptor is not None
        else "",
        "entry_window_start_minute": descriptor.entry_window_start_minute
        if descriptor is not None
        else 0,
        "entry_window_end_minute": descriptor.entry_window_end_minute
        if descriptor is not None
        else 0,
        "max_hold_minutes": descriptor.max_hold_minutes
        if descriptor is not None
        else 0,
        "rank_count": descriptor.rank_count if descriptor is not None else 0,
        "requires_prev_day_features": descriptor.requires_prev_day_features
        if descriptor is not None
        else False,
        "requires_cross_sectional_features": (
            descriptor.requires_cross_sectional_features
            if descriptor is not None
            else False
        ),
        "requires_quote_quality_gate": descriptor.requires_quote_quality_gate
        if descriptor is not None
        else False,
        "max_position_pct_equity": (
            _string(descriptor.max_position_pct_equity)
            if descriptor is not None
            else ""
        ),
        "configured_max_gross_exposure_pct_equity": (
            _string(descriptor.configured_max_gross_exposure_pct_equity)
            if descriptor is not None
            else ""
        ),
        "estimated_max_gross_exposure_pct_equity": (
            _string(descriptor.estimated_max_gross_exposure_pct_equity)
            if descriptor is not None
            else ""
        ),
        "capital_budget_overage_ratio": (
            _string(descriptor.capital_budget_overage_ratio)
            if descriptor is not None
            else ""
        ),
        "capital_feasible": descriptor.capital_feasible
        if descriptor is not None
        else True,
        "max_gross_exposure_pct_equity": _string(
            scorecard.get("max_gross_exposure_pct_equity")
            or full_window.get("max_gross_exposure_pct_equity")
        ),
        "min_cash": _string(scorecard.get("min_cash") or full_window.get("min_cash")),
        "exact_replay_ledger_artifact_ref": _string(
            scorecard.get("exact_replay_ledger_artifact_ref")
            or candidate_payload.get("exact_replay_ledger_artifact_ref")
        ),
        "exact_replay_ledger_artifact_row_count": _string(
            scorecard.get("exact_replay_ledger_artifact_row_count")
            or candidate_payload.get("exact_replay_ledger_artifact_row_count")
        ),
        "exact_replay_ledger_artifact_fill_count": _string(
            scorecard.get("exact_replay_ledger_artifact_fill_count")
            or candidate_payload.get("exact_replay_ledger_artifact_fill_count")
        ),
        "exact_replay_ledger_ranking_authority": _string(
            exact_replay_ranking.get("authority")
        ),
        "exact_replay_ledger_ranking_artifact_ref": _string(
            exact_replay_ranking.get("artifact_ref")
        ),
        "execution_quality": execution_quality,
        "execution_quality_blockers": execution_quality_blockers,
        "execution_quality_blocker_count": len(execution_quality_blockers),
        "execution_quality_penalty_bps": _string(
            candidate_payload.get("execution_quality_penalty_bps")
            or scorecard.get("execution_quality_penalty_bps")
        ),
        "execution_quality_penalty_amount": _string(
            candidate_payload.get("execution_quality_penalty_amount")
            or scorecard.get("execution_quality_penalty_amount")
        ),
        "execution_quality_adjusted_window_net_pnl_per_day": _string(
            candidate_payload.get("execution_quality_adjusted_window_net_pnl_per_day")
            or scorecard.get("execution_quality_adjusted_window_net_pnl_per_day")
        ),
        "runtime_ledger_pnl_basis": _string(
            scorecard.get("runtime_ledger_pnl_basis")
            or candidate_payload.get("runtime_ledger_pnl_basis")
        ),
        "runtime_ledger_pnl_source": _string(
            scorecard.get("runtime_ledger_pnl_source")
            or candidate_payload.get("runtime_ledger_pnl_source")
        ),
        "negative_cash_observation_count": int(
            scorecard.get("negative_cash_observation_count")
            or full_window.get("negative_cash_observation_count")
            or 0
        ),
        "proposal_score": proposal_score.score if proposal_score is not None else 0.0,
        "proposal_rank": proposal_score.rank if proposal_score is not None else 0,
        "proposal_backend": _string(proposal_score.backend)
        if proposal_score is not None
        else "",
        "proposal_mode": _string(proposal_score.mode)
        if proposal_score is not None
        else "",
        "proposal_selected": proposal_selected,
        "proposal_selection_reason": proposal_selection_reason,
    }


def _write_history_jsonl(path: Path, history: list[dict[str, Any]]) -> None:
    lines = [json.dumps(item, sort_keys=True) for item in history]
    path.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")


def _sanitize_tsv_field(value: Any) -> str:
    return str(value).replace("\t", " ").replace("\n", " ").strip()


__all__: tuple[str, ...] = ()
