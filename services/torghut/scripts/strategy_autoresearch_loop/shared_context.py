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
import scripts.materialize_replay_tape as materialize_replay_tape
from scripts.search_consistent_profitability_frontier import (
    run_consistent_profitability_frontier,
)


def _find_repo_root(path: Path) -> Path:
    for parent in path.resolve().parents:
        if (parent / "services/torghut/config/trading/hypotheses").exists():
            return parent
    return path.resolve().parents[4]


_REPO_ROOT = _find_repo_root(Path(__file__))

_CAPITAL_LIMIT_SAFETY_MULTIPLIER = Decimal("0.98")

_DEFAULT_MIN_EXECUTABLE_ROWS_PER_SYMBOL_DAY = 18_000
_DEFAULT_MIN_QUOTE_VALID_RATIO = Decimal("0.90")
_DEFAULT_MAX_COVERAGE_SPREAD_BPS = Decimal("50")
_DEFAULT_MAX_EXECUTABLE_GAP_SECONDS = 120

_DEFAULT_CLICKHOUSE_HTTP_URL = (
    "http://torghut-clickhouse.torghut.svc.cluster.local:8123"
)


def _select_effective_replay_tape_window(*args: Any, **kwargs: Any) -> Any:
    selector = getattr(materialize_replay_tape, "_select_effective_window")
    return selector(*args, **kwargs)


def _default_clickhouse_http_url() -> str:
    return (
        os.environ.get("CLICKHOUSE_HTTP_URL")
        or os.environ.get("TA_CLICKHOUSE_URL")
        or _DEFAULT_CLICKHOUSE_HTTP_URL
    )


def _default_clickhouse_password() -> str:
    return os.environ.get(
        "TA_CLICKHOUSE_PASSWORD",
        os.environ.get("CLICKHOUSE_PASSWORD", ""),
    )


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run an autoresearch-style strategy discovery loop and emit notebooks.",
    )
    parser.add_argument(
        "--program",
        type=Path,
        required=True,
        help="Path to the strategy autoresearch program YAML.",
    )
    run_destination = parser.add_mutually_exclusive_group(required=True)
    run_destination.add_argument(
        "--output-dir",
        type=Path,
        help="Directory that will receive a timestamped run folder.",
    )
    run_destination.add_argument(
        "--resume-run-root",
        type=Path,
        help="Existing run folder whose last committed checkpoint should be resumed.",
    )
    parser.add_argument(
        "--strategy-configmap",
        type=Path,
        default=_REPO_ROOT / "argocd/applications/torghut/strategy-configmap.yaml",
    )
    parser.add_argument(
        "--family-template-dir",
        type=Path,
        default=family_template_dir(),
    )
    parser.add_argument(
        "--clickhouse-http-url",
        default=_default_clickhouse_http_url(),
    )
    parser.add_argument(
        "--clickhouse-username",
        default=os.environ.get(
            "TA_CLICKHOUSE_USERNAME",
            os.environ.get("CLICKHOUSE_USERNAME", "torghut"),
        ),
    )
    parser.add_argument("--clickhouse-password", default=_default_clickhouse_password())
    parser.add_argument("--start-equity", default="31590.02")
    parser.add_argument("--chunk-minutes", type=int, default=10)
    parser.add_argument("--symbols", default="")
    parser.add_argument("--progress-log-seconds", type=int, default=30)
    parser.add_argument(
        "--shadow-validation-artifact",
        type=Path,
        default=None,
        help="Optional path to an existing shadow-live-deviation-report-v1 artifact.",
    )
    parser.add_argument("--train-days", type=int, default=6)
    parser.add_argument("--holdout-days", type=int, default=3)
    parser.add_argument(
        "--second-oos-days",
        type=int,
        default=0,
        help="Optional independent second-OOS trading-day count forwarded into frontier validation.",
    )
    parser.add_argument("--full-window-start-date", default="")
    parser.add_argument("--full-window-end-date", default="")
    parser.add_argument("--expected-last-trading-day", default="")
    parser.add_argument("--allow-stale-tape", action="store_true")
    parser.add_argument("--prefetch-full-window-rows", action="store_true")
    parser.add_argument(
        "--replay-tape-path",
        type=Path,
        default=None,
        help="Optional manifest-verified replay tape reused by each frontier run.",
    )
    parser.add_argument(
        "--replay-tape-manifest",
        type=Path,
        default=None,
        help="Optional manifest path for --replay-tape-path.",
    )
    parser.add_argument(
        "--materialize-replay-tape",
        action="store_true",
        help=(
            "Fetch the resolved full-window signal rows once, write a run-scoped "
            "replay tape, and pass it into every exact frontier run."
        ),
    )
    parser.add_argument(
        "--latest-complete-window-min-days",
        type=int,
        default=0,
        help=(
            "When materializing a replay tape, select the latest consecutive complete "
            "sub-window with at least this many trading days."
        ),
    )
    parser.add_argument(
        "--latest-complete-window-receipt-output",
        type=Path,
        default=None,
        help="Optional JSON receipt path for latest complete replay-window selection.",
    )
    parser.add_argument(
        "--coverage-diagnostic-output",
        type=Path,
        default=None,
        help="Optional JSON diagnostics path for replay source coverage.",
    )
    parser.add_argument(
        "--min-executable-rows-per-symbol-day",
        type=int,
        default=int(
            os.environ.get(
                "TORGHUT_REPLAY_MIN_EXECUTABLE_ROWS_PER_SYMBOL_DAY",
                str(_DEFAULT_MIN_EXECUTABLE_ROWS_PER_SYMBOL_DAY),
            )
        ),
        help="Minimum executable quote-backed rows per symbol/day for complete-window selection.",
    )
    parser.add_argument(
        "--min-quote-valid-ratio",
        default=os.environ.get(
            "TORGHUT_REPLAY_MIN_QUOTE_VALID_RATIO",
            str(_DEFAULT_MIN_QUOTE_VALID_RATIO),
        ),
        help="Minimum spread-sane/executable quote ratio for complete-window selection.",
    )
    parser.add_argument(
        "--max-coverage-spread-bps",
        default=os.environ.get(
            "TORGHUT_REPLAY_MAX_COVERAGE_SPREAD_BPS",
            str(_DEFAULT_MAX_COVERAGE_SPREAD_BPS),
        ),
        help="Maximum bid/ask spread in bps for coverage rows to count as quote-valid.",
    )
    parser.add_argument(
        "--max-executable-gap-seconds",
        type=int,
        default=int(
            os.environ.get(
                "TORGHUT_REPLAY_MAX_EXECUTABLE_GAP_SECONDS",
                str(_DEFAULT_MAX_EXECUTABLE_GAP_SECONDS),
            )
        ),
        help="Maximum quote-valid row gap per symbol/day for complete-window selection.",
    )
    parser.add_argument(
        "--max-frontier-runs",
        type=int,
        default=0,
        help="Optional overall cap on frontier executions. 0 means use the family budgets only.",
    )
    parser.add_argument(
        "--max-candidates-per-frontier-run",
        type=int,
        default=0,
        help=(
            "Optional local research cap for candidates evaluated inside each frontier "
            "execution. 0 uses the program replay budget."
        ),
    )
    parser.add_argument(
        "--staged-train-screen-multiplier",
        type=int,
        default=0,
        help=(
            "Optional override for cheap train-screen candidate breadth per frontier "
            "run. 0 uses the program replay budget."
        ),
    )
    parser.add_argument("--json-output", type=Path)
    return parser.parse_args()


@dataclass(frozen=True)
class WorkItem:
    family_plan: FamilyAutoresearchPlan
    iteration: int
    sweep_config: dict[str, Any]
    mutation_label: str
    parent_candidate_id: str | None


@dataclass(frozen=True)
class LatestCompleteWindowRequirement:
    min_days: int
    source: str
    cli_min_days: int = 0
    objective_min_days: int = 0


def _mapping(value: Any) -> dict[str, Any]:
    return (
        {str(key): item for key, item in value.items()}
        if isinstance(value, Mapping)
        else {}
    )


def _string(value: Any) -> str:
    return str(value or "").strip()


def _float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _decimal(value: Any, *, default: Decimal = Decimal("0")) -> Decimal:
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return default


def _maybe_decimal(value: Any) -> Decimal | None:
    if value in (None, ""):
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return None


def _json_clone(payload: Mapping[str, Any]) -> dict[str, Any]:
    return cast(dict[str, Any], json.loads(json.dumps(payload, default=str)))


def _as_grid_values(value: Any) -> list[Any]:
    if isinstance(value, list):
        return list(value)
    if value is None:
        return []
    return [value]


def _format_decimal(value: Decimal) -> str:
    if value == 0:
        return "0"
    formatted = format(value.normalize(), "f")
    if "." in formatted:
        return formatted.rstrip("0").rstrip(".") or "0"
    return formatted


def _positive_decimal_grid_values(value: Any) -> list[Decimal]:
    decimals: list[Decimal] = []
    for item in _as_grid_values(value):
        parsed = _decimal(item)
        if parsed > 0:
            decimals.append(parsed)
    return decimals


def _max_entry_count(parameters: Mapping[str, Any]) -> int:
    for key in ("max_concurrent_positions", "max_pair_legs", "top_n", "rank_count"):
        values = _positive_decimal_grid_values(parameters.get(key))
        if values:
            return max(1, int(max(values)))
    return 1


def _capped_numeric_grid(
    *,
    existing: Any,
    maximum: Decimal,
    fallback: Decimal,
) -> list[str]:
    kept = [
        value for value in _positive_decimal_grid_values(existing) if value <= maximum
    ]
    if not kept:
        kept = [fallback]
    return [_format_decimal(value) for value in kept]


def _apply_objective_capital_limits(
    *,
    sweep_config: Mapping[str, Any],
    max_gross_exposure_pct_equity: Decimal,
    start_equity: Decimal,
) -> dict[str, Any]:
    payload = _json_clone(sweep_config)
    parameters = _mapping(payload.get("parameters"))
    strategy_overrides = _mapping(payload.get("strategy_overrides"))
    max_gross = max(Decimal("0"), max_gross_exposure_pct_equity)
    effective_max_gross = (max_gross * _CAPITAL_LIMIT_SAFETY_MULTIPLIER).quantize(
        Decimal("0.000001"),
        rounding=ROUND_DOWN,
    )
    max_entries = _max_entry_count(parameters)
    per_entry_pct_cap = (
        (effective_max_gross / Decimal(max_entries)).quantize(
            Decimal("0.000001"),
            rounding=ROUND_DOWN,
        )
        if effective_max_gross > 0
        else Decimal("0")
    )
    per_trade_notional_cap = (
        (start_equity * effective_max_gross / Decimal(max_entries)).quantize(
            Decimal("0.01"),
            rounding=ROUND_DOWN,
        )
        if start_equity > 0 and effective_max_gross > 0
        else Decimal("0")
    )
    if effective_max_gross > 0:
        parameters["max_gross_exposure_pct_equity"] = _capped_numeric_grid(
            existing=parameters.get("max_gross_exposure_pct_equity"),
            maximum=effective_max_gross,
            fallback=effective_max_gross,
        )
        strategy_overrides["max_position_pct_equity"] = _capped_numeric_grid(
            existing=strategy_overrides.get("max_position_pct_equity"),
            maximum=per_entry_pct_cap,
            fallback=per_entry_pct_cap,
        )
    if per_trade_notional_cap > 0:
        strategy_overrides["max_notional_per_trade"] = _capped_numeric_grid(
            existing=strategy_overrides.get("max_notional_per_trade"),
            maximum=per_trade_notional_cap,
            fallback=per_trade_notional_cap,
        )
    payload["parameters"] = parameters
    payload["strategy_overrides"] = strategy_overrides
    return payload


def _apply_exact_replay_guidance_to_next_sweep(
    *,
    sweep_config: Mapping[str, Any],
    mutation_label: str,
    remediation_report: Mapping[str, Any],
) -> tuple[dict[str, Any], str]:
    guided_sweep = apply_replay_ledger_remediation_guidance(
        sweep_config=sweep_config,
        remediation_report=remediation_report,
    )
    if not guided_sweep.applied:
        return guided_sweep.sweep_config, mutation_label
    return (
        guided_sweep.sweep_config,
        f"{mutation_label}; replay-guidance={guided_sweep.mutation_label_suffix}",
    )


def _slug(value: str) -> str:
    normalized = "".join(char if char.isalnum() else "-" for char in value.lower())
    return "-".join(part for part in normalized.split("-") if part)


def _iter_symbols(value: Any) -> list[str]:
    if isinstance(value, str):
        normalized = value.strip().upper()
        return [normalized] if normalized else []
    if isinstance(value, (list, tuple)):
        resolved: list[str] = []
        for item in value:
            resolved.extend(_iter_symbols(item))
        return resolved
    return []


def _snapshot_symbols(
    *, args: argparse.Namespace, worklist: list[WorkItem]
) -> tuple[str, ...]:
    cli_symbols = tuple(
        symbol.strip().upper()
        for symbol in str(args.symbols or "").split(",")
        if symbol.strip()
    )
    if cli_symbols:
        return cli_symbols
    ordered: list[str] = []
    seen: set[str] = set()
    for item in worklist:
        strategy_overrides = _mapping(item.sweep_config.get("strategy_overrides"))
        for symbol in _iter_symbols(strategy_overrides.get("universe_symbols")):
            if symbol in seen:
                continue
            seen.add(symbol)
            ordered.append(symbol)
    return tuple(ordered)


def _mlx_bundle_paths(run_root: Path) -> dict[str, str]:
    return {
        "signal_rows_jsonl": str(run_root / "mlx-snapshot-signals.jsonl"),
        "replay_tape_jsonl": str(run_root / "replay-tape.jsonl"),
        "replay_tape_manifest_json": str(run_root / "replay-tape.jsonl.manifest.json"),
        "replay_tape_latest_complete_window_receipt_json": str(
            run_root / "latest-complete-window-receipt.json"
        ),
        "replay_tape_coverage_diagnostics_json": str(
            run_root / "replay-tape-coverage-diagnostics.json"
        ),
        "descriptors_jsonl": str(run_root / "mlx-candidate-descriptors.jsonl"),
        "proposal_scores_jsonl": str(run_root / "mlx-proposal-scores.jsonl"),
        "history_jsonl": str(run_root / "history.jsonl"),
        "results_tsv": str(run_root / "results.tsv"),
    }


def _keep_candidate_limit(
    *, family_plan: FamilyAutoresearchPlan, replay_budget_max_candidates_per_round: int
) -> int:
    if replay_budget_max_candidates_per_round <= 0:
        return max(1, family_plan.keep_top_candidates)
    return max(
        1, min(family_plan.keep_top_candidates, replay_budget_max_candidates_per_round)
    )


def _frontier_candidate_budget(
    *,
    family_plan: FamilyAutoresearchPlan,
    replay_budget_max_candidates_per_frontier_run: int,
) -> int:
    if replay_budget_max_candidates_per_frontier_run <= 0:
        return 0
    minimum_budget = max(
        family_plan.frontier_top_n,
        family_plan.keep_top_candidates,
        family_plan.symbol_prune_candidates + 1,
        family_plan.loss_repair_candidates + 1,
        family_plan.consistency_repair_candidates + 1,
    )
    return max(minimum_budget, replay_budget_max_candidates_per_frontier_run)


def _work_item_candidate_id(work_item: WorkItem) -> str:
    return _slug(
        f"{work_item.family_plan.family_template.family_id}-iter-{work_item.iteration}-{work_item.mutation_label}"
    )


def _runtime_missing_candidate_payload(
    *,
    candidate_id: str,
    family_plan: FamilyAutoresearchPlan,
    sweep_config: Mapping[str, Any],
    reason: str,
) -> dict[str, Any]:
    runtime_harness = _mapping(family_plan.family_template.runtime_harness)
    return {
        "candidate_id": candidate_id,
        "family_template_id": family_plan.family_template.family_id,
        "hard_vetoes": ["runtime_strategy_missing"],
        "ranking": {
            "method": "runtime_availability_preflight",
            "pareto_tier": 999,
            "tie_breaker_score": "0",
            "vetoed": True,
        },
        "objective_scorecard": {
            "net_pnl_per_day": "0",
            "active_day_ratio": "0",
            "positive_day_ratio": "0",
            "avg_filled_notional_per_day": "0",
            "avg_filled_notional_per_active_day": "0",
            "best_day_share": "1",
            "worst_day_loss": "0",
            "max_drawdown": "0",
            "regime_slice_pass_rate": "0",
        },
        "full_window": {
            "net_per_day": "0",
            "trading_day_count": 0,
            "active_days": 0,
            "daily_net": {},
            "daily_filled_notional": {},
        },
        "replay_config": {
            "params": _mapping(sweep_config.get("parameters")),
            "strategy_overrides": _mapping(sweep_config.get("strategy_overrides")),
        },
        "runtime_availability": {
            "schema_version": "torghut.runtime-availability.v1",
            "status": "missing",
            "reason": reason,
            "runtime_family": _string(runtime_harness.get("family")),
            "runtime_strategy_name": _string(runtime_harness.get("strategy_name")),
        },
    }


def _runtime_missing_frontier_payload(
    *,
    candidate_payload: Mapping[str, Any],
    family_plan: FamilyAutoresearchPlan,
    status_reason: str,
) -> dict[str, Any]:
    return {
        "schema_version": "torghut.replay-frontier-sweep.v1",
        "status": "skipped_runtime_strategy_missing",
        "status_reason": status_reason,
        "family": _string(family_plan.family_template.runtime_harness.get("family")),
        "strategy_name": _string(
            family_plan.family_template.runtime_harness.get("strategy_name")
        ),
        "family_template": family_plan.family_template.to_payload(),
        "candidate_count": 1,
        "progress": {"evaluated_candidates": 0, "pending_candidates": 0},
        "top": [dict(candidate_payload)],
    }


def _promotion_readiness_payload(
    *, family_plan: FamilyAutoresearchPlan
) -> dict[str, Any]:
    return blocked_research_candidate_promotion_readiness(
        candidate_id="",
        family_template_id=family_plan.family_template.family_id,
        runtime_harness=family_plan.family_template.runtime_harness,
    )


def _frontier_args(
    *,
    args: argparse.Namespace,
    program: StrategyAutoresearchProgram,
    family_plan: FamilyAutoresearchPlan,
    sweep_config_path: Path,
    json_output_path: Path,
) -> argparse.Namespace:
    top_n = max(family_plan.frontier_top_n, family_plan.keep_top_candidates)
    replay_budget_max_candidates_per_frontier_run = (
        int(args.max_candidates_per_frontier_run)
        if int(getattr(args, "max_candidates_per_frontier_run", 0)) > 0
        else int(program.replay_budget.max_candidates_per_frontier_run)
    )
    max_candidates_to_evaluate = (
        max(1, int(args.max_candidates_per_frontier_run))
        if int(getattr(args, "max_candidates_per_frontier_run", 0)) > 0
        else _frontier_candidate_budget(
            family_plan=family_plan,
            replay_budget_max_candidates_per_frontier_run=replay_budget_max_candidates_per_frontier_run,
        )
    )
    staged_train_screen_multiplier = (
        max(1, int(args.staged_train_screen_multiplier))
        if int(getattr(args, "staged_train_screen_multiplier", 0)) > 0
        else max(1, int(program.replay_budget.staged_train_screen_multiplier))
    )
    return argparse.Namespace(
        strategy_configmap=args.strategy_configmap.resolve(),
        sweep_config=sweep_config_path,
        clickhouse_http_url=str(args.clickhouse_http_url),
        clickhouse_username=str(args.clickhouse_username),
        clickhouse_password=str(args.clickhouse_password),
        start_equity=str(args.start_equity),
        chunk_minutes=int(args.chunk_minutes),
        symbols=str(args.symbols),
        progress_log_seconds=int(args.progress_log_seconds),
        train_days=int(args.train_days),
        holdout_days=int(args.holdout_days),
        second_oos_days=max(0, int(getattr(args, "second_oos_days", 0) or 0)),
        full_window_start_date=str(args.full_window_start_date),
        full_window_end_date=str(args.full_window_end_date),
        expected_last_trading_day=str(args.expected_last_trading_day),
        allow_stale_tape=bool(args.allow_stale_tape),
        family_template_dir=args.family_template_dir.resolve(),
        prefetch_full_window_rows=bool(args.prefetch_full_window_rows),
        replay_tape_path=(
            Path(replay_tape_path).resolve()
            if (replay_tape_path := getattr(args, "replay_tape_path", None)) is not None
            else None
        ),
        replay_tape_manifest=(
            Path(replay_tape_manifest).resolve()
            if (replay_tape_manifest := getattr(args, "replay_tape_manifest", None))
            is not None
            else None
        ),
        top_n=top_n,
        max_candidates_to_evaluate=max_candidates_to_evaluate,
        staged_train_screen_multiplier=staged_train_screen_multiplier,
        json_output=json_output_path,
        symbol_prune_iterations=family_plan.symbol_prune_iterations,
        symbol_prune_candidates=family_plan.symbol_prune_candidates,
        symbol_prune_min_universe_size=family_plan.symbol_prune_min_universe_size,
        loss_repair_iterations=family_plan.loss_repair_iterations,
        loss_repair_candidates=family_plan.loss_repair_candidates,
        consistency_repair_iterations=family_plan.consistency_repair_iterations,
        consistency_repair_candidates=family_plan.consistency_repair_candidates,
    )


# Explicit barrel exports; keeps re-export imports intentional without file-level Ruff ignores.
__all__: tuple[str, ...] = (
    "Any",
    "CandidateEvidenceBundle",
    "Decimal",
    "FamilyAutoresearchPlan",
    "InvalidOperation",
    "LatestCompleteWindowRequirement",
    "Mapping",
    "MlxCandidateDescriptor",
    "MlxSignalBundleStats",
    "MlxSnapshotManifest",
    "Path",
    "PortfolioCandidateSpec",
    "ProfitTargetOraclePolicy",
    "ProposalDiagnostics",
    "ProposalModelPolicy",
    "ProposalScore",
    "ProposalSelectionEntry",
    "ROUND_DOWN",
    "ReplayTapeManifest",
    "RuntimeClosureExecutionContext",
    "StrategyAutoresearchProgram",
    "WorkItem",
    "_CAPITAL_LIMIT_SAFETY_MULTIPLIER",
    "_DEFAULT_CLICKHOUSE_HTTP_URL",
    "_DEFAULT_MAX_COVERAGE_SPREAD_BPS",
    "_DEFAULT_MAX_EXECUTABLE_GAP_SECONDS",
    "_DEFAULT_MIN_EXECUTABLE_ROWS_PER_SYMBOL_DAY",
    "_DEFAULT_MIN_QUOTE_VALID_RATIO",
    "_REPO_ROOT",
    "_apply_exact_replay_guidance_to_next_sweep",
    "_apply_objective_capital_limits",
    "_as_grid_values",
    "_capped_numeric_grid",
    "_decimal",
    "_default_clickhouse_http_url",
    "_default_clickhouse_password",
    "_find_repo_root",
    "_float",
    "_format_decimal",
    "_frontier_args",
    "_frontier_candidate_budget",
    "_iter_symbols",
    "_json_clone",
    "_keep_candidate_limit",
    "_mapping",
    "_max_entry_count",
    "_maybe_decimal",
    "_mlx_bundle_paths",
    "_parse_args",
    "_positive_decimal_grid_values",
    "_promotion_readiness_payload",
    "_runtime_missing_candidate_payload",
    "_runtime_missing_frontier_payload",
    "_select_effective_replay_tape_window",
    "_slug",
    "_snapshot_symbols",
    "_string",
    "_work_item_candidate_id",
    "annotations",
    "apply_program_objective",
    "apply_replay_ledger_remediation_guidance",
    "argparse",
    "blocked_research_candidate_promotion_readiness",
    "build_mlx_snapshot_manifest",
    "build_mutated_sweep_config",
    "build_proposal_diagnostics",
    "build_replay_ledger_ranking_report",
    "build_replay_ledger_remediation_report",
    "build_source_query_digest",
    "candidate_meets_objective",
    "cast",
    "dataclass",
    "date",
    "default_manifest_path",
    "default_replay_ledger_ranking_policy",
    "deployable_lower_bound_missing_count",
    "deployable_lower_bound_net_pnl_per_day",
    "deployable_proof_failed_gate_count",
    "descriptor_from_candidate_payload",
    "descriptor_from_sweep_config",
    "evidence_bundle_from_frontier_candidate",
    "family_template_dir",
    "json",
    "load_strategy_autoresearch_program",
    "materialize_replay_tape",
    "materialize_signal_tape",
    "optimize_portfolio_candidate",
    "os",
    "rank_candidate_descriptors",
    "replay_mod",
    "run_consistent_profitability_frontier",
    "run_id",
    "select_proposal_batch",
    "stable_payload_hash",
    "summary_promotion_readiness",
    "write_autoresearch_notebooks",
    "write_mlx_notebook_exports",
    "write_mlx_signal_bundle",
    "write_mlx_snapshot_manifest",
    "write_runtime_closure_bundle",
    "yaml",
)
