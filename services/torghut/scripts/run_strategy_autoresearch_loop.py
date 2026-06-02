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

_REPO_ROOT = Path(__file__).resolve().parents[3]
_CAPITAL_LIMIT_SAFETY_MULTIPLIER = Decimal("0.98")
_DEFAULT_CLICKHOUSE_HTTP_URL = (
    "http://torghut-clickhouse.torghut.svc.cluster.local:8123"
)


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
    parser.add_argument(
        "--output-dir",
        type=Path,
        required=True,
        help="Directory that will receive a timestamped run folder.",
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


def _write_results_tsv(path: Path, history: list[dict[str, Any]]) -> None:
    header = [
        "experiment",
        "iteration",
        "family_template_id",
        "candidate_id",
        "net_pnl_per_day",
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


def _best_history_record(history: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not history:
        return None
    sorted_history = sorted(
        history,
        key=lambda item: (
            item["status"] != "keep",
            bool(item["hard_vetoes"]),
            int(item["pareto_tier"]),
            -float(
                item.get("deployable_lower_bound_net_pnl_per_day")
                or item["net_pnl_per_day"]
                or "0"
            ),
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


def run_strategy_autoresearch_loop(args: argparse.Namespace) -> dict[str, Any]:
    program = load_strategy_autoresearch_program(
        args.program.resolve(),
        family_dir=args.family_template_dir.resolve(),
    )
    runner_run_id = run_id("strategy-autoresearch")
    run_root = args.output_dir.resolve() / runner_run_id
    run_root.mkdir(parents=True, exist_ok=True)
    (run_root / "experiments").mkdir(parents=True, exist_ok=True)

    worklist: list[WorkItem] = []
    seen_sweeps: set[str] = set()
    for family_plan in program.families:
        seed_sweep = _load_yaml(family_plan.seed_sweep_config)
        seed_sweep = apply_program_objective(
            sweep_config=seed_sweep,
            objective=program.objective,
            holdout_day_count=max(1, int(args.holdout_days)),
            full_window_day_count=_default_full_window_day_count(args),
        )
        seed_sweep = _apply_objective_capital_limits(
            sweep_config=seed_sweep,
            max_gross_exposure_pct_equity=program.objective.max_gross_exposure_pct_equity,
            start_equity=Decimal(str(args.start_equity)),
        )
        worklist.append(
            WorkItem(
                family_plan=family_plan,
                iteration=1,
                sweep_config=seed_sweep,
                mutation_label="seed",
                parent_candidate_id=None,
            )
        )

    history: list[dict[str, Any]] = []
    descriptors: list[MlxCandidateDescriptor] = []
    proposal_scores: list[ProposalScore] = []
    tape_freshness_receipts: list[dict[str, Any]] = []
    snapshot_symbols = _snapshot_symbols(args=args, worklist=worklist)
    bundle_paths = _mlx_bundle_paths(run_root)
    resolved_full_window_start_date = _string(args.full_window_start_date)
    resolved_full_window_end_date = _string(args.full_window_end_date)
    signal_bundle_stats: MlxSignalBundleStats | None = None
    effective_replay_tape_path = (
        Path(replay_tape_path).resolve()
        if (replay_tape_path := getattr(args, "replay_tape_path", None)) is not None
        else None
    )
    effective_replay_tape_manifest = (
        Path(replay_tape_manifest).resolve()
        if (replay_tape_manifest := getattr(args, "replay_tape_manifest", None))
        is not None
        else None
    )
    if effective_replay_tape_path is not None:
        provided_receipt = _provided_replay_tape_receipt(
            tape_path=effective_replay_tape_path,
            manifest_path=effective_replay_tape_manifest,
        )
        if provided_receipt is not None:
            tape_freshness_receipts.append(provided_receipt)
    closure_execution_context = RuntimeClosureExecutionContext(
        strategy_configmap_path=args.strategy_configmap.resolve(),
        clickhouse_http_url=str(args.clickhouse_http_url),
        clickhouse_username=(_string(args.clickhouse_username) or None),
        clickhouse_password=(_string(args.clickhouse_password) or None),
        start_equity=Decimal(str(args.start_equity)),
        chunk_minutes=max(1, int(args.chunk_minutes)),
        symbols=snapshot_symbols,
        progress_log_interval_seconds=max(1, int(args.progress_log_seconds)),
        shadow_validation_artifact_path=(
            args.shadow_validation_artifact.resolve()
            if args.shadow_validation_artifact is not None
            else None
        ),
    )

    def _refresh_manifest() -> MlxSnapshotManifest:
        latest_receipt = tape_freshness_receipts[-1] if tape_freshness_receipts else {}
        return build_mlx_snapshot_manifest(
            runner_run_id=runner_run_id,
            program=program,
            symbols=",".join(snapshot_symbols),
            train_days=int(args.train_days),
            holdout_days=int(args.holdout_days),
            full_window_start_date=resolved_full_window_start_date,
            full_window_end_date=resolved_full_window_end_date,
            tape_freshness_receipts=tuple(tape_freshness_receipts),
            row_counts={
                "receipt_count": len(tape_freshness_receipts),
                "latest_receipt_row_count": int(latest_receipt.get("row_count") or 0),
                "signal_row_count": signal_bundle_stats.row_count
                if signal_bundle_stats is not None
                else 0,
                "signal_symbol_count": (
                    signal_bundle_stats.symbol_count
                    if signal_bundle_stats is not None
                    else len(snapshot_symbols)
                ),
            },
            tensor_bundle_paths=bundle_paths,
        )

    manifest = _refresh_manifest()
    frontier_runs = 0
    objective_met = False
    summary = _persist_run_outputs(
        run_root=run_root,
        program=program,
        program_payload=program.to_payload(),
        runner_run_id=runner_run_id,
        program_id=program.program_id,
        frontier_runs=frontier_runs,
        objective_met=objective_met,
        history=history,
        manifest=manifest,
        descriptors=descriptors,
        proposal_scores=proposal_scores,
        worklist=worklist,
        status="running",
        closure_execution_context=closure_execution_context,
    )
    latest_exact_replay_ledger_remediation = _mapping(
        summary.get("exact_replay_ledger_remediation")
    )
    signal_bundle_stats, materialized_replay_tape_receipt = (
        _maybe_materialize_run_replay_tape(
            args=args,
            runner_run_id=runner_run_id,
            snapshot_symbols=snapshot_symbols,
            bundle_paths=bundle_paths,
            full_window_start_date=resolved_full_window_start_date,
            full_window_end_date=resolved_full_window_end_date,
            existing_signal_bundle=signal_bundle_stats,
            objective_min_observed_trading_days=program.objective.min_observed_trading_days,
        )
    )
    if materialized_replay_tape_receipt is not None:
        tape_freshness_receipts.append(materialized_replay_tape_receipt)
        effective_replay_tape_path = Path(materialized_replay_tape_receipt["tape_path"])
        effective_replay_tape_manifest = Path(
            materialized_replay_tape_receipt["manifest_path"]
        )
        resolved_full_window_start_date = (
            _string(
                materialized_replay_tape_receipt.get("effective_full_window_start_date")
            )
            or resolved_full_window_start_date
        )
        resolved_full_window_end_date = (
            _string(
                materialized_replay_tape_receipt.get("effective_full_window_end_date")
            )
            or resolved_full_window_end_date
        )
    signal_bundle_stats = _maybe_write_signal_bundle(
        args=args,
        snapshot_symbols=snapshot_symbols,
        bundle_paths=bundle_paths,
        full_window_start_date=resolved_full_window_start_date,
        full_window_end_date=resolved_full_window_end_date,
        existing=signal_bundle_stats,
    )
    frontier_base_args = argparse.Namespace(
        **{
            **vars(args),
            "full_window_start_date": resolved_full_window_start_date,
            "full_window_end_date": resolved_full_window_end_date,
            "expected_last_trading_day": (
                resolved_full_window_end_date
                if materialized_replay_tape_receipt is not None
                else str(args.expected_last_trading_day)
            ),
            "replay_tape_path": effective_replay_tape_path,
            "replay_tape_manifest": effective_replay_tape_manifest,
        }
    )
    manifest = _refresh_manifest()
    summary = _persist_run_outputs(
        run_root=run_root,
        program=program,
        program_payload=program.to_payload(),
        runner_run_id=runner_run_id,
        program_id=program.program_id,
        frontier_runs=frontier_runs,
        objective_met=objective_met,
        history=history,
        manifest=manifest,
        descriptors=descriptors,
        proposal_scores=proposal_scores,
        worklist=worklist,
        status="running",
        closure_execution_context=closure_execution_context,
    )
    latest_exact_replay_ledger_remediation = _mapping(
        summary.get("exact_replay_ledger_remediation")
    )
    try:
        while worklist:
            if int(args.max_frontier_runs) > 0 and frontier_runs >= int(
                args.max_frontier_runs
            ):
                break
            pending_descriptors = [
                descriptor_from_sweep_config(
                    candidate_id=_work_item_candidate_id(item),
                    family_plan=item.family_plan,
                    sweep_config=item.sweep_config,
                )
                for item in worklist
            ]
            pending_scores = rank_candidate_descriptors(
                descriptors=pending_descriptors,
                history_rows=history,
                policy=cast(ProposalModelPolicy, program.proposal_model_policy),
            )
            proposal_scores.extend(pending_scores)
            score_by_candidate = {item.candidate_id: item for item in pending_scores}
            ordered_pending = sorted(
                zip(worklist, pending_descriptors, strict=False),
                key=lambda item: (
                    not item[1].capital_feasible,
                    _float(item[1].capital_budget_overage_ratio),
                    score_by_candidate[item[1].candidate_id].rank,
                    -score_by_candidate[item[1].candidate_id].score,
                    item[0].family_plan.family_template.family_id,
                ),
            )
            current, current_descriptor = ordered_pending[0]
            descriptors.append(current_descriptor)
            worklist = [item for item, _ in ordered_pending[1:]]
            sweep_hash = stable_payload_hash(current.sweep_config)
            if sweep_hash in seen_sweeps:
                continue
            seen_sweeps.add(sweep_hash)
            frontier_runs += 1
            experiment_index = frontier_runs
            experiment_slug = _slug(
                f"{experiment_index:03d}-{current.family_plan.family_template.family_id}-iter-{current.iteration}"
            )
            experiment_root = run_root / "experiments" / experiment_slug
            experiment_root.mkdir(parents=True, exist_ok=True)
            sweep_config_path = experiment_root / "sweep.yaml"
            sweep_config_path.write_text(
                yaml.safe_dump(current.sweep_config, sort_keys=False),
                encoding="utf-8",
            )
            result_path = experiment_root / "result.json"
            selected_score = score_by_candidate.get(current_descriptor.candidate_id)
            selected_for_replay = (
                ProposalSelectionEntry(
                    candidate_id=current_descriptor.candidate_id,
                    descriptor_id=current_descriptor.descriptor_id,
                    selection_reason="frontier_seed",
                    score=selected_score.score,
                    rank=selected_score.rank,
                    family_template_id=current_descriptor.family_template_id,
                    side_policy=current_descriptor.side_policy,
                    capital_feasible=current_descriptor.capital_feasible,
                    capital_budget_overage_ratio=_float(
                        current_descriptor.capital_budget_overage_ratio
                    ),
                )
                if selected_score is not None
                else None
            )
            summary = _persist_run_outputs(
                run_root=run_root,
                program=program,
                program_payload=program.to_payload(),
                runner_run_id=runner_run_id,
                program_id=program.program_id,
                frontier_runs=frontier_runs,
                objective_met=objective_met,
                history=history,
                manifest=manifest,
                descriptors=descriptors,
                proposal_scores=proposal_scores,
                worklist=worklist,
                status="running",
                selected_for_replay=selected_for_replay,
                selected_descriptor=current_descriptor,
                closure_execution_context=closure_execution_context,
            )
            latest_exact_replay_ledger_remediation = _mapping(
                summary.get("exact_replay_ledger_remediation")
            )
            try:
                frontier_payload = run_consistent_profitability_frontier(
                    _frontier_args(
                        args=frontier_base_args,
                        program=program,
                        family_plan=current.family_plan,
                        sweep_config_path=sweep_config_path,
                        json_output_path=result_path,
                    )
                )
            except ValueError as exc:
                status_reason = str(exc)
                if not status_reason.startswith("strategy_not_found:"):
                    raise
                candidate_payload = _runtime_missing_candidate_payload(
                    candidate_id=current_descriptor.candidate_id,
                    family_plan=current.family_plan,
                    sweep_config=current.sweep_config,
                    reason=status_reason,
                )
                frontier_payload = _runtime_missing_frontier_payload(
                    candidate_payload=candidate_payload,
                    family_plan=current.family_plan,
                    status_reason=status_reason,
                )
                history.append(
                    _history_record(
                        runner_run_id=runner_run_id,
                        experiment_index=experiment_index,
                        family_plan=current.family_plan,
                        iteration=current.iteration,
                        mutation_label=current.mutation_label,
                        parent_candidate_id=current.parent_candidate_id,
                        sweep_config_path=sweep_config_path,
                        result_path=result_path,
                        candidate_payload=candidate_payload,
                        rank=1,
                        status="skip",
                        objective_met=False,
                        dataset_snapshot_id="",
                        descriptor=current_descriptor,
                        proposal_score=selected_score,
                        proposal_selected=False,
                        proposal_selection_reason="runtime_strategy_missing",
                        disable_other_strategies=bool(
                            current.sweep_config.get("disable_other_strategies", True)
                        ),
                    )
                )
                result_path.write_text(
                    json.dumps(frontier_payload, indent=2, sort_keys=True),
                    encoding="utf-8",
                )
                summary = _persist_run_outputs(
                    run_root=run_root,
                    program=program,
                    program_payload=program.to_payload(),
                    runner_run_id=runner_run_id,
                    program_id=program.program_id,
                    frontier_runs=frontier_runs,
                    objective_met=objective_met,
                    history=history,
                    manifest=manifest,
                    descriptors=descriptors,
                    proposal_scores=proposal_scores,
                    worklist=worklist,
                    status="running",
                    closure_execution_context=closure_execution_context,
                )
                latest_exact_replay_ledger_remediation = _mapping(
                    summary.get("exact_replay_ledger_remediation")
                )
                continue
            result_path.write_text(
                json.dumps(frontier_payload, indent=2, sort_keys=True),
                encoding="utf-8",
            )
            exact_replay_ledger_ranking = _write_exact_replay_ledger_ranking(
                run_root=run_root,
                program=program,
            )
            exact_replay_ledger_remediation = _write_exact_replay_ledger_remediation(
                run_root=run_root,
                ranking_report=cast(
                    Mapping[str, Any], exact_replay_ledger_ranking["report"]
                ),
            )
            latest_exact_replay_ledger_remediation = _mapping(
                exact_replay_ledger_remediation["report"]
            )
            dataset_snapshot_id = _string(
                _mapping(frontier_payload.get("dataset_snapshot_receipt")).get(
                    "snapshot_id"
                )
            )
            receipt_payload = _mapping(frontier_payload.get("dataset_snapshot_receipt"))
            if receipt_payload:
                tape_freshness_receipts.append(receipt_payload)
            frontier_window = _mapping(frontier_payload.get("window"))
            resolved_full_window_start_date = (
                _string(frontier_window.get("full_window_start_date"))
                or resolved_full_window_start_date
            )
            resolved_full_window_end_date = (
                _string(frontier_window.get("full_window_end_date"))
                or resolved_full_window_end_date
            )
            signal_bundle_stats = _maybe_write_signal_bundle(
                args=args,
                snapshot_symbols=snapshot_symbols,
                bundle_paths=bundle_paths,
                full_window_start_date=resolved_full_window_start_date,
                full_window_end_date=resolved_full_window_end_date,
                existing=signal_bundle_stats,
            )
            manifest = _refresh_manifest()
            top_candidates = cast(
                list[dict[str, Any]], frontier_payload.get("top") or []
            )
            keep_candidates = [
                candidate
                for candidate in top_candidates
                if not bool(_mapping(candidate.get("ranking")).get("vetoed"))
            ]
            frontier_descriptors = [
                descriptor_from_candidate_payload(
                    candidate_payload=candidate,
                    family_plan=current.family_plan,
                )
                for candidate in top_candidates
            ]
            descriptors.extend(frontier_descriptors)
            frontier_candidate_scores = rank_candidate_descriptors(
                descriptors=frontier_descriptors,
                history_rows=history,
                policy=cast(ProposalModelPolicy, program.proposal_model_policy),
            )
            proposal_scores.extend(frontier_candidate_scores)
            frontier_descriptor_by_candidate = {
                item.candidate_id: item for item in frontier_descriptors
            }
            frontier_score_by_candidate = {
                item.candidate_id: item for item in frontier_candidate_scores
            }
            keep_limit = _keep_candidate_limit(
                family_plan=current.family_plan,
                replay_budget_max_candidates_per_round=int(
                    program.replay_budget.max_candidates_per_round
                ),
            )
            non_vetoed_descriptors = [
                frontier_descriptor_by_candidate[_string(candidate.get("candidate_id"))]
                for candidate in keep_candidates
                if _string(candidate.get("candidate_id"))
                in frontier_descriptor_by_candidate
            ]
            non_vetoed_scores = [
                frontier_score_by_candidate[_string(candidate.get("candidate_id"))]
                for candidate in keep_candidates
                if _string(candidate.get("candidate_id")) in frontier_score_by_candidate
            ]
            exploration_slots = min(
                max(0, int(program.proposal_model_policy.exploration_slots)),
                max(0, int(program.replay_budget.exploration_slots)),
            )
            selected_keep_entries = select_proposal_batch(
                descriptors=non_vetoed_descriptors,
                proposal_scores=non_vetoed_scores,
                limit=keep_limit,
                top_k=max(1, int(program.proposal_model_policy.top_k)),
                exploration_slots=exploration_slots,
            )
            if (
                not selected_keep_entries
                and current.family_plan.force_keep_top_candidate_if_all_vetoed
                and top_candidates
            ):
                first_candidate = top_candidates[0]
                first_candidate_id = _string(first_candidate.get("candidate_id"))
                descriptor = frontier_descriptor_by_candidate.get(first_candidate_id)
                score = frontier_score_by_candidate.get(first_candidate_id)
                if descriptor is not None and score is not None:
                    selected_keep_entries = [
                        ProposalSelectionEntry(
                            candidate_id=first_candidate_id,
                            descriptor_id=descriptor.descriptor_id,
                            selection_reason="fallback_force_keep",
                            score=score.score,
                            rank=score.rank,
                            family_template_id=descriptor.family_template_id,
                            side_policy=descriptor.side_policy,
                        )
                    ]
            keep_ids = {item.candidate_id for item in selected_keep_entries}
            keep_reason_by_candidate = {
                item.candidate_id: item.selection_reason
                for item in selected_keep_entries
            }
            for rank, candidate in enumerate(top_candidates, start=1):
                candidate_id = _string(candidate.get("candidate_id"))
                candidate_status = "keep" if candidate_id in keep_ids else "discard"
                candidate_objective_met = candidate_meets_objective(
                    candidate, objective=program.objective
                )
                candidate_descriptor = frontier_descriptor_by_candidate[candidate_id]
                history.append(
                    _history_record(
                        runner_run_id=runner_run_id,
                        experiment_index=experiment_index,
                        family_plan=current.family_plan,
                        iteration=current.iteration,
                        mutation_label=current.mutation_label,
                        parent_candidate_id=current.parent_candidate_id,
                        sweep_config_path=sweep_config_path,
                        result_path=result_path,
                        candidate_payload=candidate,
                        rank=rank,
                        status=candidate_status,
                        objective_met=candidate_objective_met,
                        dataset_snapshot_id=dataset_snapshot_id,
                        descriptor=candidate_descriptor,
                        proposal_score=frontier_score_by_candidate.get(candidate_id),
                        proposal_selected=candidate_id in keep_ids,
                        proposal_selection_reason=keep_reason_by_candidate.get(
                            candidate_id, ""
                        ),
                        disable_other_strategies=bool(
                            current.sweep_config.get("disable_other_strategies", True)
                        ),
                    )
                )
                if candidate_objective_met:
                    objective_met = True
                if candidate_status != "keep":
                    continue
                if current.iteration >= current.family_plan.max_iterations:
                    continue
                next_sweep_config, mutation_label = build_mutated_sweep_config(
                    base_sweep_config=current.sweep_config,
                    candidate_payload=candidate,
                    family_plan=current.family_plan,
                )
                next_sweep_config = apply_program_objective(
                    sweep_config=next_sweep_config,
                    objective=program.objective,
                    holdout_day_count=max(1, int(args.holdout_days)),
                    full_window_day_count=_default_full_window_day_count(args),
                )
                (
                    next_sweep_config,
                    mutation_label,
                ) = _apply_exact_replay_guidance_to_next_sweep(
                    sweep_config=next_sweep_config,
                    mutation_label=mutation_label,
                    remediation_report=latest_exact_replay_ledger_remediation,
                )
                next_sweep_config = _apply_objective_capital_limits(
                    sweep_config=next_sweep_config,
                    max_gross_exposure_pct_equity=program.objective.max_gross_exposure_pct_equity,
                    start_equity=Decimal(str(args.start_equity)),
                )
                worklist.append(
                    WorkItem(
                        family_plan=current.family_plan,
                        iteration=current.iteration + 1,
                        sweep_config=next_sweep_config,
                        mutation_label=mutation_label,
                        parent_candidate_id=candidate_id,
                    )
                )
            summary = _persist_run_outputs(
                run_root=run_root,
                program=program,
                program_payload=program.to_payload(),
                runner_run_id=runner_run_id,
                program_id=program.program_id,
                frontier_runs=frontier_runs,
                objective_met=objective_met,
                history=history,
                manifest=manifest,
                descriptors=descriptors,
                proposal_scores=proposal_scores,
                worklist=worklist,
                status="running",
                closure_execution_context=closure_execution_context,
            )
            latest_exact_replay_ledger_remediation = _mapping(
                summary.get("exact_replay_ledger_remediation")
            )
            if objective_met and program.objective.stop_when_objective_met:
                break
    except Exception as exc:
        return _persist_run_outputs(
            run_root=run_root,
            program=program,
            program_payload=program.to_payload(),
            runner_run_id=runner_run_id,
            program_id=program.program_id,
            frontier_runs=frontier_runs,
            objective_met=objective_met,
            history=history,
            manifest=manifest,
            descriptors=descriptors,
            proposal_scores=proposal_scores,
            worklist=worklist,
            status="error",
            closure_execution_context=closure_execution_context,
            error={
                "type": exc.__class__.__name__,
                "message": str(exc),
            },
        )

    return _persist_run_outputs(
        run_root=run_root,
        program=program,
        program_payload=program.to_payload(),
        runner_run_id=runner_run_id,
        program_id=program.program_id,
        frontier_runs=frontier_runs,
        objective_met=objective_met,
        history=history,
        manifest=manifest,
        descriptors=descriptors,
        proposal_scores=proposal_scores,
        worklist=worklist,
        status="ok",
        closure_execution_context=closure_execution_context,
    )


def main() -> int:
    args = _parse_args()
    payload = run_strategy_autoresearch_loop(args)
    if args.json_output is not None:
        args.json_output.write_text(
            json.dumps(payload, indent=2, sort_keys=True),
            encoding="utf-8",
        )
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0 if payload.get("status") == "ok" else 1


if __name__ == "__main__":
    raise SystemExit(main())
