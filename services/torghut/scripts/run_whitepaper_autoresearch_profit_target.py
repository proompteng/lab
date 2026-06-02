#!/usr/bin/env python3
"""Run a whitepaper-driven autoresearch epoch targeting a portfolio profit objective."""

from __future__ import annotations

import argparse
import hashlib
import json
import multiprocessing
import os
import queue
import signal
import socket
import subprocess
import time as monotonic_time
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping, Sequence, cast
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

from sqlalchemy import select

from app.db import SessionLocal
from app.models import (
    AutoresearchCandidateSpec,
    AutoresearchEpoch,
    AutoresearchPortfolioCandidate,
    AutoresearchProposalScore,
    RejectedSignalOutcomeEvent,
    WhitepaperAnalysisRun,
    VNextExperimentSpec,
)
from app.trading.discovery.autoresearch import (
    ResearchClaim,
    ResearchSource,
    StrategyAutoresearchProgram,
    load_strategy_autoresearch_program,
    run_id,
)
from app.trading.discovery.candidate_specs import (
    LIVE_SIGNAL_COVERED_SEMICONDUCTOR_UNIVERSE,
    CandidateSpec,
)
from app.trading.discovery.candidate_specs import candidate_spec_id_for_payload
from app.trading.discovery.candidate_specs import candidate_spec_from_payload
from app.trading.discovery.evidence_bundles import (
    CandidateEvidenceBundle,
    evidence_bundle_blockers,
    evidence_bundle_from_frontier_candidate,
    evidence_bundle_from_payload,
)
from app.trading.discovery.factor_acceptance import (
    build_factor_acceptance_artifact_from_scorecard,
)
from app.trading.discovery.fast_replay import (
    FAST_REPLAY_PROOF_SEMANTICS_LABEL,
    FAST_REPLAY_WHITEPAPER_MECHANISMS,
    build_fast_replay_preview,
)
from app.trading.discovery.hypothesis_cards import HypothesisCard
from app.trading.discovery.mlx_snapshot import build_mlx_snapshot_manifest
from app.trading.discovery.mlx_snapshot import MlxSnapshotManifest
from app.trading.discovery.mlx_snapshot import write_mlx_snapshot_manifest
from app.trading.discovery.mlx_training_data import build_mlx_training_rows
from app.trading.discovery.mlx_training_data import (
    capital_budget_penalty,
    candidate_spec_capital_features,
    rank_training_rows,
    rank_training_rows_with_lift_policy,
    train_mlx_ranker,
)
from app.trading.discovery.objectives import (
    deployable_lower_bound_missing_count,
    deployable_lower_bound_net_pnl_per_day,
    deployable_proof_failed_gate_count,
)
from app.trading.discovery.portfolio_optimizer import (
    PortfolioCandidateSpec,
    optimize_portfolio_candidate,
)
from app.trading.discovery.profit_target_oracle import (
    ProfitTargetOraclePolicy,
    evaluate_profit_target_oracle,
)
from app.trading.runtime_ledger import (
    POST_COST_PNL_BASIS,
    RuntimeLedgerBucket,
    build_runtime_ledger_buckets,
)
from app.trading.discovery.replay_tape import (
    ReplayTapeManifest,
    build_source_query_digest,
    materialize_signal_tape,
    load_replay_tape,
    slice_tape_by_symbols,
    slice_tape_by_window,
    validate_tape_freshness,
)
from app.trading.discovery.runtime_closure import (
    RuntimeClosureExecutionContext,
    write_runtime_closure_bundle,
)
from app.trading.discovery.whitepaper_autoresearch_notebooks import (
    write_whitepaper_autoresearch_diagnostics_notebook,
)
from app.trading.discovery.whitepaper_candidate_compiler import (
    CandidateCompilationBlocker,
    compile_whitepaper_candidate_specs,
)
from app.whitepapers.claim_compiler import (
    RECENT_WHITEPAPER_SEEDS,
    WhitepaperResearchSource,
    compile_sources_to_hypothesis_cards,
    sources_from_jsonl,
)

import scripts.local_intraday_tsmom_replay as replay_mod
import scripts.materialize_replay_tape as replay_materializer
import scripts.run_strategy_factory_v2 as strategy_factory_runner


_DEFAULT_CHIP_UNIVERSE_CSV = ",".join(LIVE_SIGNAL_COVERED_SEMICONDUCTOR_UNIVERSE)
_DEFAULT_DAILY_PROFIT_TARGET = "500"
_DEFAULT_RANKER_BACKEND_PREFERENCE = "mlx"
_RANKER_BACKEND_CHOICES = (
    "mlx",
    "numpy",
    "numpy-fallback",
    "torch",
    "torch-cuda",
    "cuda",
)
_DEFAULT_PORTFOLIO_PROFIT_PROGRAM = Path(
    "config/trading/research-programs/portfolio-profit-autoresearch-500-v1.yaml"
)
_CANDIDATE_BOARD_RUNTIME_SESSION_TZ = ZoneInfo("America/New_York")
_CANDIDATE_BOARD_RUNTIME_SESSION_OPEN = time(hour=9, minute=30)
_CANDIDATE_BOARD_RUNTIME_SESSION_CLOSE = time(hour=16, minute=0)
_DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC = 8
_DEFAULT_REAL_REPLAY_SHARD_TIMEOUT_SECONDS = 900
_DEFAULT_REAL_REPLAY_SHARD_WORKERS = 2
_DEFAULT_REAL_REPLAY_MAX_PARALLEL_FRONTIER_CANDIDATES = 6
_DEFAULT_FAST_REPLAY_PREVIEW_TOP_K = 48
_DEFAULT_FAST_REPLAY_EXACT_CANDIDATE_CAP = 6
_DEFAULT_FAST_REPLAY_EXPLOITATION_SLOTS = 4
_DEFAULT_FAST_REPLAY_EXPLORATION_SLOTS = 2
_UNSAFE_NEXT_EPOCH_REMEDIATION_FLAG_MARKERS = (
    "agentrun",
    "agent-run",
    "broker",
    "fanout",
    "kubectl",
    "kubernetes",
    "live-trading",
    "promotion",
)
_DEFAULT_CLICKHOUSE_HTTP_URL = (
    "http://torghut-clickhouse.torghut.svc.cluster.local:8123"
)
_MAX_PERSISTED_FEEDBACK_EVIDENCE_BUNDLES = 512
_MAX_PERSISTED_FEEDBACK_EVIDENCE_EPOCHS = 12
_PORTFOLIO_FEEDBACK_STATUSES = frozenset({"blocked", "paper_probation", "target_met"})
_REJECTED_SIGNAL_OUTCOME_REQUIRED_FIELDS = (
    "counterfactual_return",
    "route_tca",
    "post_cost_net_pnl",
    "executable_quote",
)
_CODE_COMMIT_ENV_VARS = (
    "TORGHUT_CODE_COMMIT",
    "TORGHUT_COMMIT",
    "TORGHUT_SOURCE_CI_REF",
    "TORGHUT_IMAGE_COMMIT",
    "GITHUB_SHA",
    "BUILDKITE_COMMIT",
    "SOURCE_COMMIT",
    "GIT_COMMIT",
    "REVISION",
)
_PROGRAM_SOURCE_DEFAULT_CONFIDENCE = "0.70"
_SECOND_OOS_WINDOW_ID = "second_oos"
_RUNTIME_CLOSURE_PROOF_ORACLE_BLOCKERS = frozenset(
    {
        "shadow_parity_status_failed",
        "executable_replay_passed_failed",
        "executable_replay_artifact_present_failed",
        "executable_replay_order_count_failed",
        "executable_replay_account_buying_power_failed",
        "executable_replay_max_notional_per_trade_failed",
        "executable_replay_notional_within_buying_power_failed",
        "market_impact_stress_passed_failed",
        "market_impact_stress_artifact_present_failed",
        "market_impact_liquidity_evidence_present_failed",
        "market_impact_stress_model_failed",
        "market_impact_stress_cost_bps_failed",
        "market_impact_stress_net_pnl_per_day_failed",
        "delay_adjusted_depth_stress_passed_failed",
        "delay_adjusted_depth_stress_artifact_present_failed",
        "delay_adjusted_depth_stress_model_failed",
        "delay_adjusted_depth_stress_ms_failed",
        "delay_adjusted_depth_fillable_notional_per_day_failed",
        "delay_adjusted_depth_stress_net_pnl_per_day_failed",
        "double_oos_passed_failed",
        "double_oos_artifact_present_failed",
        "double_oos_independent_window_count_failed",
        "double_oos_pass_rate_failed",
        "double_oos_net_pnl_per_day_failed",
        "double_oos_cost_shock_net_pnl_per_day_failed",
    }
)
_FAMILY_PRIOR_HARD_BLOCK_ORACLE_BLOCKERS = frozenset(
    {
        "active_day_ratio_below_oracle",
        "positive_day_ratio_below_oracle",
        "best_day_share_above_oracle",
    }
)
_RISK_PROFILE_FEEDBACK_ORACLE_BLOCKERS = frozenset(
    {
        "active_day_ratio_below_oracle",
        "positive_day_ratio_below_oracle",
        "best_day_share_above_oracle",
        "active_day_ratio_failed",
        "positive_day_ratio_failed",
        "min_daily_net_pnl_failed",
        "daily_net_observed_day_count_failed",
        "best_day_share_failed",
        "max_single_day_contribution_share_failed",
        "max_single_symbol_contribution_share_failed",
        "max_cluster_contribution_share_failed",
    }
)
_PAPER_MECHANISM_PRIOR_SCORE_CAP = Decimal("42")
_PAPER_MECHANISM_PRIOR_WEIGHTS: Mapping[str, Decimal] = {
    "mixed_market_limit_execution_policy": Decimal("9"),
    "queue_position_survival_fill_curve": Decimal("9"),
    "mpc_dynamic_execution_schedule": Decimal("8"),
    "delay_adjusted_depth_stress": Decimal("8"),
    "simulation_reality_gap_implementation_risk": Decimal("8"),
    "implementation_risk_backtest_stability": Decimal("8"),
    "replay_paper_live_semantic_parity": Decimal("7"),
    "rejected_signal_outcome_calibration": Decimal("7"),
    "nonlinear_market_impact_tca": Decimal("6"),
    "ofi_lob_continuation_response": Decimal("6"),
    "order_flow_filtration_parent_trade_obi": Decimal("6"),
    "alpha_decay_predictability_stress": Decimal("5"),
    "cluster_lob_event_clustering": Decimal("5"),
    "intraday_volume_periodicity_execution": Decimal("5"),
    "macro_announcement_dvar_momentum": Decimal("4"),
    "ohlcv_only_falsification": Decimal("3"),
}
_PAPER_EVIDENCE_REQUIREMENT_PRIOR_WEIGHTS: Mapping[str, Decimal] = {
    "route_tca": Decimal("2"),
    "execution_shortfall": Decimal("2"),
    "market_impact_stress": Decimal("2"),
    "live_paper_parity": Decimal("2"),
    "runtime_ledger": Decimal("2"),
    "fill_outcomes": Decimal("2"),
    "order_lifecycle_fill_evidence": Decimal("2"),
    "queue_position_survival_fill_curve": Decimal("2"),
    "delay_adjusted_depth_stress": Decimal("2"),
    "implementation_uncertainty_interval": Decimal("2"),
    "implementation_uncertainty_stability": Decimal("2"),
    "rejected_signal_log": Decimal("2"),
    "counterfactual_return": Decimal("2"),
    "executable_quote": Decimal("1"),
}


def _default_strategy_config_path() -> Path:
    configured = str(os.getenv("TRADING_STRATEGY_CONFIG_PATH") or "").strip()
    if configured:
        return Path(configured)
    return Path("argocd/applications/torghut/strategy-configmap.yaml")


def _default_clickhouse_http_url() -> str:
    return (
        os.environ.get("CLICKHOUSE_HTTP_URL")
        or os.environ.get("TA_CLICKHOUSE_URL")
        or _DEFAULT_CLICKHOUSE_HTTP_URL
    )


def _ranker_backend_preference(args: argparse.Namespace) -> str:
    requested = (
        str(
            getattr(
                args, "ranker_backend_preference", _DEFAULT_RANKER_BACKEND_PREFERENCE
            )
            or _DEFAULT_RANKER_BACKEND_PREFERENCE
        )
        .strip()
        .lower()
    )
    if requested in _RANKER_BACKEND_CHOICES:
        return requested
    return _DEFAULT_RANKER_BACKEND_PREFERENCE


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run whitepaper autoresearch and assemble a portfolio candidate for a profit target.",
    )
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument(
        "--epoch-id",
        default="",
        help=(
            "Optional persisted autoresearch epoch id. Defaults to a generated "
            "whitepaper-autoresearch id when omitted."
        ),
    )
    parser.add_argument("--paper-run-id", action="append", default=[])
    parser.add_argument("--seed-recent-whitepapers", action="store_true")
    parser.add_argument(
        "--source-jsonl",
        action="append",
        default=[],
        type=Path,
        help="JSONL file of normalized WhitepaperResearchSource payloads.",
    )
    parser.add_argument(
        "--feedback-evidence-jsonl",
        action="append",
        default=[],
        type=Path,
        help=(
            "Prior real-replay candidate evidence bundles to feed back into the "
            "pre-replay MLX ranker for the next autoresearch epoch."
        ),
    )
    parser.add_argument(
        "--candidate-specs",
        action="append",
        default=[],
        type=Path,
        help=(
            "JSONL file of CandidateSpec payloads to replay directly. Use this "
            "with a prior selected-candidate-specs.jsonl artifact to skip "
            "whitepaper source compilation and pre-replay reselection."
        ),
    )
    parser.add_argument(
        "--target-net-pnl-per-day", default=_DEFAULT_DAILY_PROFIT_TARGET
    )
    parser.add_argument("--max-candidates", type=int, default=64)
    parser.add_argument("--top-k", type=int, default=16)
    parser.add_argument("--exploration-slots", type=int, default=8)
    parser.add_argument(
        "--feedback-block-reaudit-slots",
        type=int,
        default=0,
        help=(
            "Bounded slots for replaying candidates blocked only by prior "
            "feedback. These are diagnostic re-audits; capital blocks and final "
            "promotion/oracle gates still apply."
        ),
    )
    parser.add_argument(
        "--selection-only",
        action="store_true",
        help=(
            "Stop after source, hypothesis, candidate-spec, feedback, MLX "
            "pre-replay ranking, and candidate-selection artifacts are written. "
            "No replay, portfolio optimization, persistence, or promotion proof is run."
        ),
    )
    parser.add_argument(
        "--ranker-backend-preference",
        default=_DEFAULT_RANKER_BACKEND_PREFERENCE,
        choices=_RANKER_BACKEND_CHOICES,
        help=(
            "Array backend for advisory ranker training. CUDA choices only "
            "accelerate research ranking and do not change promotion gates."
        ),
    )
    parser.add_argument("--portfolio-size-min", type=int, default=2)
    parser.add_argument("--portfolio-size-max", type=int, default=8)
    parser.add_argument("--replay-mode", choices=("synthetic", "real"), default="real")
    parser.add_argument(
        "--program",
        type=Path,
        default=_DEFAULT_PORTFOLIO_PROFIT_PROGRAM,
    )
    parser.add_argument(
        "--strategy-configmap",
        type=Path,
        default=_default_strategy_config_path(),
    )
    parser.add_argument(
        "--family-template-dir",
        type=Path,
        default=Path("config/trading/families"),
    )
    parser.add_argument(
        "--seed-sweep-dir",
        type=Path,
        default=Path("config/trading"),
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
    parser.add_argument("--clickhouse-password", default="")
    parser.add_argument(
        "--clickhouse-password-env",
        default=os.environ.get("TA_CLICKHOUSE_PASSWORD_ENV", "TA_CLICKHOUSE_PASSWORD"),
        help=(
            "Environment variable that contains the ClickHouse password; ignored when "
            "--clickhouse-password is set."
        ),
    )
    parser.add_argument("--start-equity", default="31590.02")
    parser.add_argument("--chunk-minutes", type=int, default=10)
    parser.add_argument("--symbols", default=_DEFAULT_CHIP_UNIVERSE_CSV)
    parser.add_argument("--progress-log-seconds", type=int, default=30)
    parser.add_argument(
        "--shadow-validation-artifact",
        type=Path,
        default=None,
        help=(
            "Optional real shadow/live deviation artifact to attach to runtime "
            "closure. Missing or invalid artifacts stay fail-closed."
        ),
    )
    parser.add_argument(
        "--max-frontier-candidates-per-spec",
        type=int,
        default=_DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC,
    )
    parser.add_argument(
        "--max-total-frontier-candidates",
        type=int,
        default=0,
        help=(
            "Global real-replay frontier candidate budget across all selected "
            "candidate specs. Defaults to --max-candidates when omitted."
        ),
    )
    parser.add_argument(
        "--staged-train-screen-multiplier",
        type=int,
        default=0,
        help=(
            "Optional override for cheap train-screen candidate breadth per "
            "frontier run. 0 uses the research program replay budget."
        ),
    )
    parser.add_argument(
        "--capture-rejected-seed-full-window-ledger",
        action="store_true",
        help=(
            "Forward proof-only rejected seed ledger capture to strategy factory. "
            "Captured candidates remain non-promotable."
        ),
    )
    parser.add_argument(
        "--capture-positive-rejected-full-window-ledgers",
        dest="capture_positive_rejected_full_window_ledgers",
        type=int,
        default=0,
        help=(
            "Forward proof-only full-window ledger capture for positive train-screen "
            "rejects or over-budget positives. Captured candidates remain blocked."
        ),
    )
    parser.add_argument(
        "--capture-top-rejected-full-window-ledgers",
        dest="capture_positive_rejected_full_window_ledgers",
        type=int,
        default=argparse.SUPPRESS,
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--symbol-prune-iterations",
        type=int,
        default=0,
        help="Override program symbol-prune repair iterations for real replay.",
    )
    parser.add_argument("--symbol-prune-candidates", type=int, default=0)
    parser.add_argument("--symbol-prune-min-universe-size", type=int, default=0)
    parser.add_argument(
        "--loss-repair-iterations",
        type=int,
        default=0,
        help="Override program loss-repair iterations for real replay.",
    )
    parser.add_argument("--loss-repair-candidates", type=int, default=0)
    parser.add_argument(
        "--consistency-repair-iterations",
        type=int,
        default=0,
        help="Override program consistency-repair iterations for real replay.",
    )
    parser.add_argument("--consistency-repair-candidates", type=int, default=0)
    parser.add_argument("--real-replay-timeout-seconds", type=int, default=0)
    parser.add_argument(
        "--real-replay-shard-size",
        type=int,
        default=0,
        help=(
            "Replay selected candidate specs in bounded shards. A value <= 0 "
            "keeps the legacy single-batch replay path."
        ),
    )
    parser.add_argument(
        "--real-replay-shard-timeout-seconds",
        type=int,
        default=_DEFAULT_REAL_REPLAY_SHARD_TIMEOUT_SECONDS,
        help=(
            "Per-shard timeout for sharded real replay. Defaults to the "
            f"production-safe {_DEFAULT_REAL_REPLAY_SHARD_TIMEOUT_SECONDS}s cap."
        ),
    )
    parser.add_argument(
        "--real-replay-shard-workers",
        type=int,
        default=_DEFAULT_REAL_REPLAY_SHARD_WORKERS,
        help=(
            "Maximum number of bounded real-replay shards to run concurrently. "
            f"Defaults to {_DEFAULT_REAL_REPLAY_SHARD_WORKERS}; no Kubernetes fanout is created."
        ),
    )
    parser.add_argument(
        "--real-replay-max-parallel-frontier-candidates",
        type=int,
        default=_DEFAULT_REAL_REPLAY_MAX_PARALLEL_FRONTIER_CANDIDATES,
        help=(
            "Safety cap on concurrent exact-frontier candidate budget across "
            "real-replay shards. Requested workers are reduced when their "
            "combined shard budgets would exceed this value."
        ),
    )
    parser.add_argument(
        "--real-replay-failed-spec-retries",
        type=int,
        default=1,
        help=(
            "Retry candidate specs from timed-out real-replay shards individually "
            "before marking the epoch replay incomplete."
        ),
    )
    parser.add_argument(
        "--real-replay-retry-timeout-seconds",
        type=int,
        default=0,
        help=(
            "Timeout for missing-spec retry replays. Defaults to twice the shard "
            "timeout when omitted."
        ),
    )
    parser.add_argument(
        "--real-replay-retry-max-frontier-candidates-per-spec",
        type=int,
        default=1,
        help="Frontier candidate budget for each missing-spec retry replay.",
    )
    parser.add_argument("--train-days", type=int, default=6)
    parser.add_argument("--holdout-days", type=int, default=3)
    parser.add_argument("--second-oos-days", type=int, default=2)
    parser.add_argument("--full-window-start-date", default="")
    parser.add_argument("--full-window-end-date", default="")
    parser.add_argument("--expected-last-trading-day", default="")
    parser.add_argument("--allow-stale-tape", action="store_true")
    parser.add_argument(
        "--coverage-diagnostic-output",
        type=Path,
        default=None,
        help="Optional JSON path for cheap source-window coverage diagnostics before replay-tape materialization.",
    )
    parser.add_argument(
        "--latest-complete-window-min-days",
        type=int,
        default=0,
        help=(
            "When materializing a replay tape, preflight source coverage and retarget "
            "to the latest covered exchange-session sub-window with at least this many days."
        ),
    )
    parser.add_argument(
        "--latest-complete-window-receipt-output",
        type=Path,
        default=None,
        help="Optional JSON receipt path for replay source-window preflight selection.",
    )
    parser.add_argument(
        "--min-executable-rows-per-symbol-day",
        type=int,
        default=int(
            os.environ.get("TORGHUT_REPLAY_MIN_EXECUTABLE_ROWS_PER_SYMBOL_DAY", "1")
        ),
        help="Minimum executable rows per requested symbol/day for source-window preflight.",
    )
    parser.add_argument(
        "--min-quote-valid-ratio",
        default=os.environ.get("TORGHUT_REPLAY_MIN_QUOTE_VALID_RATIO", "0"),
        help="Minimum spread-sane/executable quote ratio for source-window preflight.",
    )
    parser.add_argument(
        "--max-coverage-spread-bps",
        default=os.environ.get("TORGHUT_REPLAY_MAX_COVERAGE_SPREAD_BPS", "1000000000"),
        help="Maximum spread in bps for a row to count as quote-valid in source-window preflight.",
    )
    parser.add_argument(
        "--max-executable-gap-seconds",
        type=int,
        default=int(
            os.environ.get("TORGHUT_REPLAY_MAX_EXECUTABLE_GAP_SECONDS", "999999")
        ),
        help="Maximum intra-symbol executable-row gap allowed by source-window preflight.",
    )
    parser.add_argument("--prefetch-full-window-rows", action="store_true")
    parser.add_argument(
        "--replay-tape-path",
        type=Path,
        default=None,
        help="Optional manifest-verified replay tape reused by real frontier runs.",
    )
    parser.add_argument(
        "--replay-tape-manifest",
        type=Path,
        default=None,
        help="Optional manifest path for --replay-tape-path.",
    )
    parser.add_argument(
        "--replay-tape-preview-top-k",
        type=int,
        default=0,
        help=(
            "Preview-only tape-vectorized narrowing budget before exact replay. "
            "When omitted, real H-PAIRS replay runs with a replay tape default "
            f"to {_DEFAULT_FAST_REPLAY_PREVIEW_TOP_K} preview candidates. "
            "Never counts as promotion proof."
        ),
    )
    parser.add_argument(
        "--replay-tape-preview-min-rows",
        type=int,
        default=2,
        help="Minimum manifest-verified tape rows required to score a candidate in preview narrowing.",
    )
    parser.add_argument(
        "--replay-tape-exact-candidate-cap",
        type=int,
        default=_DEFAULT_FAST_REPLAY_EXACT_CANDIDATE_CAP,
        help=(
            "Maximum candidate specs forwarded from preview ranking to exact replay. "
            "Defaults to a bounded 4 exploitation + 2 exploration frontier."
        ),
    )
    parser.add_argument(
        "--allow-unsafe-replay-tape-exact-cap-override",
        action="store_true",
        help=(
            "Deprecated no-op retained for CLI compatibility. Replay-tape preview "
            f"handoff is always capped at {_DEFAULT_FAST_REPLAY_EXACT_CANDIDATE_CAP} "
            "exact-replay candidates."
        ),
    )
    parser.add_argument(
        "--replay-tape-frontier-exploitation-slots",
        type=int,
        default=_DEFAULT_FAST_REPLAY_EXPLOITATION_SLOTS,
        help="Preview frontier exploitation slots forwarded to exact replay.",
    )
    parser.add_argument(
        "--replay-tape-frontier-exploration-slots",
        type=int,
        default=_DEFAULT_FAST_REPLAY_EXPLORATION_SLOTS,
        help="Preview frontier exploration slots forwarded to exact replay.",
    )
    parser.add_argument(
        "--materialize-replay-tape",
        action="store_true",
        help=(
            "Fetch the resolved full-window signal rows once, write a run-scoped "
            "manifest-verified replay tape, and use it for preview narrowing and exact replay."
        ),
    )
    parser.add_argument(
        "--disable-staged-replay-frontier",
        action="store_true",
        help=(
            "Disable the default bounded replay-tape -> fast-preview -> exact-top-six "
            "frontier when a replay tape is available."
        ),
    )
    parser.add_argument(
        "--collect-train-gate-diagnostics",
        dest="collect_train_gate_diagnostics",
        action="store_true",
        help="Persist aggregate train-window gate diagnostics for real replay candidates.",
    )
    parser.add_argument(
        "--no-collect-train-gate-diagnostics",
        dest="collect_train_gate_diagnostics",
        action="store_false",
        help="Disable aggregate train-window gate diagnostics.",
    )
    parser.add_argument("--min-active-day-ratio", default="0.90")
    parser.add_argument("--min-positive-day-ratio", default="0.60")
    parser.add_argument("--min-profit-factor", default="1.50")
    parser.add_argument("--min-daily-net-pnl", default=None)
    parser.add_argument("--max-worst-day-loss", default="999999999")
    parser.add_argument("--max-drawdown", default="999999999")
    parser.add_argument("--max-best-day-share", default="0.25")
    parser.add_argument("--max-cluster-contribution-share", default="0.40")
    parser.add_argument("--max-single-symbol-contribution-share", default="0.35")
    parser.add_argument("--max-worst-day-loss-pct-equity", default="0.05")
    parser.add_argument("--max-drawdown-pct-equity", default="0.08")
    parser.add_argument("--extended-max-worst-day-loss-pct-equity", default="0.08")
    parser.add_argument("--extended-max-drawdown-pct-equity", default="0.12")
    parser.add_argument("--min-total-net-pnl-to-drawdown-ratio", default="3.00")
    parser.add_argument("--max-gross-exposure-pct-equity", default="1.0")
    parser.add_argument("--min-cash", default="0")
    parser.add_argument("--max-negative-cash-observation-count", type=int, default=0)
    parser.add_argument("--min-avg-filled-notional-per-day", default="300000")
    parser.add_argument("--min-observed-trading-days", type=int, default=20)
    parser.add_argument("--min-regime-slice-pass-rate", default="0.45")
    parser.add_argument("--no-require-double-oos", action="store_true")
    parser.add_argument(
        "--min-double-oos-independent-window-count", type=int, default=2
    )
    parser.add_argument("--min-double-oos-pass-rate", default="1.00")
    parser.add_argument(
        "--require-no-flat-days",
        action="store_true",
        help="Require every evaluated trading day to be active and positive at portfolio oracle time.",
    )
    parser.add_argument(
        "--persist-results", dest="persist_results", action="store_true"
    )
    parser.add_argument(
        "--no-persist-results", dest="persist_results", action="store_false"
    )
    parser.set_defaults(
        persist_results=True,
        collect_train_gate_diagnostics=True,
        staged_replay_frontier_default=True,
    )
    return parser.parse_args()


@dataclass(frozen=True)
class EpochReplayResult:
    evidence_bundles: tuple[CandidateEvidenceBundle, ...]
    replay_results: tuple[Mapping[str, Any], ...]
    incomplete: bool = False
    failure_reasons: tuple[str, ...] = ()


@dataclass(frozen=True)
class _ReplayShardPlan:
    shard_index: int
    args: argparse.Namespace
    output_dir: Path
    specs: tuple[CandidateSpec, ...]
    timeout_seconds: int


@dataclass(frozen=True)
class _ReplayShardOutcome:
    shard_index: int
    candidate_spec_ids: tuple[str, ...]
    result: EpochReplayResult
    failure: Mapping[str, Any] | None = None


def _write_json(path: Path, payload: Mapping[str, Any]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    return path


def _write_jsonl(path: Path, rows: Sequence[Mapping[str, Any]]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "\n".join(json.dumps(row, sort_keys=True) for row in rows)
        + ("\n" if rows else ""),
        encoding="utf-8",
    )
    return path


def _load_feedback_evidence_bundles(
    paths: Sequence[Path],
) -> tuple[CandidateEvidenceBundle, ...]:
    bundles: list[CandidateEvidenceBundle] = []
    for raw_path in paths:
        path = _resolve_existing_path(raw_path)
        if not path.exists():
            raise ValueError(f"feedback_evidence_jsonl_missing:{raw_path}")
        for line_number, line in enumerate(
            path.read_text(encoding="utf-8").splitlines(), start=1
        ):
            text = line.strip()
            if not text:
                continue
            try:
                payload = json.loads(text)
                if not isinstance(payload, Mapping):
                    raise ValueError("payload_not_object")
                bundles.append(evidence_bundle_from_payload(payload))
            except Exception as exc:
                raise ValueError(
                    f"feedback_evidence_jsonl_invalid:{raw_path}:{line_number}:{exc}"
                ) from exc
    return tuple(bundles)


def _dedupe_feedback_evidence_bundles(
    bundles: Sequence[CandidateEvidenceBundle],
) -> tuple[CandidateEvidenceBundle, ...]:
    seen: set[str] = set()
    deduped: list[CandidateEvidenceBundle] = []
    for bundle in bundles:
        key = bundle.evidence_bundle_id or _stable_hash(bundle.to_payload())
        if key in seen:
            continue
        seen.add(key)
        deduped.append(bundle)
    return tuple(deduped)


def _evidence_bundle_payloads_for_epoch_summary(
    evidence_bundles: Sequence[CandidateEvidenceBundle],
) -> list[dict[str, Any]]:
    return [
        bundle.to_payload()
        for bundle in evidence_bundles[:_MAX_PERSISTED_FEEDBACK_EVIDENCE_BUNDLES]
    ]


def _candidate_spec_from_payload(payload: Mapping[str, Any]) -> CandidateSpec:
    return candidate_spec_from_payload(payload)


def _load_candidate_specs_jsonl(paths: Sequence[Path]) -> tuple[CandidateSpec, ...]:
    specs: list[CandidateSpec] = []
    seen: set[str] = set()
    for path in paths:
        if not path.exists():
            raise ValueError(f"candidate_specs_jsonl_missing:{path}")
        for line_number, line in enumerate(
            path.read_text(encoding="utf-8").splitlines(), start=1
        ):
            if not line.strip():
                continue
            try:
                payload = json.loads(line)
                spec = _candidate_spec_from_payload(_mapping(payload))
            except Exception as exc:
                raise ValueError(
                    f"candidate_specs_jsonl_invalid:{path}:{line_number}:{exc}"
                ) from exc
            if spec.candidate_spec_id in seen:
                raise ValueError(
                    f"candidate_specs_jsonl_duplicate_candidate_spec_id:{path}:{line_number}:{spec.candidate_spec_id}"
                )
            seen.add(spec.candidate_spec_id)
            specs.append(spec)
    if not specs:
        raise ValueError("candidate_specs_jsonl_empty")
    return tuple(specs)


def _summary_scorecard_feedback_bundles_for_epoch(
    epoch: AutoresearchEpoch,
    candidate_specs: Sequence[CandidateSpec],
) -> tuple[tuple[CandidateEvidenceBundle, ...], dict[str, int]]:
    stats = {
        "scorecard_count": 0,
        "matched_scorecard_count": 0,
        "unmatched_scorecard_count": 0,
        "bundle_count": 0,
    }
    summary = _mapping(epoch.summary_json)
    remediation = _mapping(summary.get("candidate_search_remediation"))
    scorecards = _list_of_mappings(remediation.get("partial_scorecards"))
    stats["scorecard_count"] = len(scorecards)
    if not scorecards or not candidate_specs:
        return (), stats

    spec_by_id = {spec.candidate_spec_id: spec for spec in candidate_specs}
    spec_by_signature = {
        _candidate_spec_execution_signature(spec): spec for spec in candidate_specs
    }
    build = _mapping(summary.get("build"))
    code_commit = _string(build.get("commit")) or "unknown"
    bundles: list[CandidateEvidenceBundle] = []
    for index, scorecard in enumerate(scorecards, start=1):
        candidate_spec_id = _string(scorecard.get("candidate_spec_id"))
        execution_signature = _string(scorecard.get("execution_signature"))
        spec = spec_by_id.get(candidate_spec_id) or spec_by_signature.get(
            execution_signature
        )
        if spec is None:
            stats["unmatched_scorecard_count"] += 1
            continue
        stats["matched_scorecard_count"] += 1
        candidate_id = _string(scorecard.get("candidate_id")) or spec.candidate_spec_id
        candidate = {
            "candidate_id": candidate_id,
            "family_template_id": _string(scorecard.get("family_template_id"))
            or spec.family_template_id,
            "runtime_family": _string(scorecard.get("runtime_family"))
            or spec.runtime_family,
            "runtime_strategy_name": _string(scorecard.get("runtime_strategy_name"))
            or spec.runtime_strategy_name,
            "execution_signature": execution_signature
            or _candidate_spec_execution_signature(spec),
            "objective_scorecard": scorecard,
            "hard_vetoes": scorecard.get("hard_vetoes")
            or scorecard.get("veto_reasons")
            or (),
            "promotion_readiness": {
                "stage": "research_candidate",
                "status": "blocked_by_prior_replay_scorecard",
                "promotable": False,
                "blockers": list(
                    str(item)
                    for item in cast(
                        Sequence[Any],
                        scorecard.get("hard_vetoes")
                        or scorecard.get("veto_reasons")
                        or (),
                    )
                    if str(item).strip()
                ),
            },
        }
        bundles.append(
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=spec.candidate_spec_id,
                candidate=candidate,
                dataset_snapshot_id=f"autoresearch-epoch:{epoch.epoch_id}:summary-scorecards",
                result_path=(
                    f"db://autoresearch_epochs/{epoch.epoch_id}/"
                    f"candidate_search_remediation/partial_scorecards/{index}"
                ),
                code_commit=code_commit,
            )
        )
    stats["bundle_count"] = len(bundles)
    return tuple(bundles), stats


def _outcome_payload_has_complete_rejected_signal_fields(
    payload: Mapping[str, Any],
    required_fields: Sequence[Any],
) -> bool:
    required = tuple(_string(field) for field in required_fields if _string(field))
    if not required:
        required = _REJECTED_SIGNAL_OUTCOME_REQUIRED_FIELDS
    for field in required:
        if field not in payload:
            return False
        value = payload.get(field)
        if value is None:
            return False
        if isinstance(value, str) and not value.strip():
            return False
        if isinstance(value, Mapping) and not value:
            return False
    return True


def _rejected_signal_outcome_payload_to_feedback_bundle(
    row: RejectedSignalOutcomeEvent,
    *,
    code_commit: str = "unknown",
) -> CandidateEvidenceBundle | None:
    outcome_payload = _mapping(row.outcome_payload_json)
    if not outcome_payload:
        return None
    if not _outcome_payload_has_complete_rejected_signal_fields(
        outcome_payload, cast(Sequence[Any], row.required_outcome_fields_json or ())
    ):
        return None

    embedded_bundle = _mapping(outcome_payload.get("candidate_evidence_bundle_payload"))
    if embedded_bundle:
        return evidence_bundle_from_payload(embedded_bundle)
    if (
        _string(outcome_payload.get("schema_version"))
        == "torghut.candidate-evidence-bundle.v1"
    ):
        return evidence_bundle_from_payload(outcome_payload)

    event_payload = _mapping(row.event_payload_json)
    scorecard = _mapping(outcome_payload.get("objective_scorecard"))
    if not scorecard:
        scorecard = {}
    for key in (
        "net_pnl_per_day",
        "active_day_ratio",
        "positive_day_ratio",
        "best_day_share",
        "max_drawdown",
        "worst_day_loss",
        "avg_filled_notional_per_day",
        "market_impact_stress_net_pnl_per_day",
        "delay_adjusted_depth_stress_net_pnl_per_day",
        "counterfactual_return",
        "route_tca",
        "post_cost_net_pnl",
        "executable_quote",
    ):
        if key in outcome_payload and key not in scorecard:
            scorecard = {**scorecard, key: outcome_payload[key]}
    scorecard = {
        **scorecard,
        "rejected_signal_event_id": row.event_id,
        "rejected_signal_symbol": row.symbol,
        "rejected_signal_reason": row.reject_reason,
        "rejected_signal_outcome_label_status": row.outcome_label_status,
    }

    candidate_spec_id = _string(outcome_payload.get("candidate_spec_id")) or _string(
        event_payload.get("candidate_spec_id")
    )
    family_template_id = _string(outcome_payload.get("family_template_id")) or _string(
        event_payload.get("family_template_id")
    )
    runtime_family = _string(outcome_payload.get("runtime_family")) or _string(
        event_payload.get("runtime_family")
    )
    runtime_strategy_name = _string(
        outcome_payload.get("runtime_strategy_name")
    ) or _string(event_payload.get("runtime_strategy_name"))
    execution_signature = _string(
        outcome_payload.get("execution_signature")
    ) or _string(event_payload.get("execution_signature"))
    feedback_shape_key = _string(outcome_payload.get("feedback_shape_key")) or _string(
        event_payload.get("feedback_shape_key")
    )
    feedback_risk_profile_key = _string(
        outcome_payload.get("feedback_risk_profile_key")
    ) or _string(event_payload.get("feedback_risk_profile_key"))
    if not (
        candidate_spec_id
        or family_template_id
        or execution_signature
        or feedback_shape_key
        or feedback_risk_profile_key
    ):
        return None

    candidate_id = (
        _string(outcome_payload.get("candidate_id"))
        or _string(event_payload.get("candidate_id"))
        or f"rejected-signal-{row.event_id}"
    )
    candidate = {
        "candidate_id": candidate_id,
        "family_template_id": family_template_id,
        "runtime_family": runtime_family,
        "runtime_strategy_name": runtime_strategy_name,
        "execution_signature": execution_signature,
        "feedback_shape_key": feedback_shape_key,
        "feedback_risk_profile_key": feedback_risk_profile_key,
        "objective_scorecard": scorecard,
        "hard_vetoes": outcome_payload.get("hard_vetoes")
        or outcome_payload.get("veto_reasons")
        or scorecard.get("hard_vetoes")
        or scorecard.get("veto_reasons")
        or (),
        "promotion_readiness": _mapping(outcome_payload.get("promotion_readiness"))
        or {
            "stage": "research_candidate",
            "status": "blocked_by_rejected_signal_counterfactual_feedback",
            "promotable": False,
            "blockers": [
                "requires_full_replay_validation",
                "requires_live_paper_parity",
            ],
        },
    }
    return evidence_bundle_from_frontier_candidate(
        candidate_spec_id=candidate_spec_id,
        candidate=candidate,
        dataset_snapshot_id=f"rejected-signal-outcome:{row.event_id}",
        result_path=f"db://rejected_signal_outcome_events/{row.event_id}",
        code_commit=code_commit,
    )


def _ordered_unique_strings(values: Sequence[Any]) -> tuple[str, ...]:
    seen: set[str] = set()
    unique: list[str] = []
    for value in values:
        text = _string(value)
        if not text or text in seen:
            continue
        seen.add(text)
        unique.append(text)
    return tuple(unique)


def _portfolio_candidate_feedback_blockers(
    *,
    scorecard: Mapping[str, Any],
    payload: Mapping[str, Any],
) -> tuple[str, ...]:
    blockers: list[Any] = list(_oracle_blockers(scorecard))
    promotion_readiness = _mapping(payload.get("promotion_readiness"))
    for source in (scorecard, promotion_readiness):
        for key in ("hard_vetoes", "veto_reasons", "blockers"):
            raw = source.get(key)
            if isinstance(raw, Sequence) and not isinstance(raw, str):
                blockers.extend(cast(Sequence[Any], raw))
    return _ordered_unique_strings(blockers)


def _portfolio_sleeve_feedback_metadata(
    sleeve: Mapping[str, Any],
) -> dict[str, Any]:
    params = _mapping(sleeve.get("params"))
    universe_symbols = [
        symbol.upper()
        for symbol in _string_list_from_value(sleeve.get("universe_symbols"))
    ]
    universe_key = ",".join(sorted(universe_symbols))
    signal_key = "|".join(
        part
        for part in (
            _string(params.get("signal_motif")) or _string(sleeve.get("signal")),
            _string(params.get("selection_mode")),
            _string(params.get("rank_feature")),
        )
        if part
    )
    family_template_id = _string(sleeve.get("family_template_id"))
    runtime_family = _string(sleeve.get("runtime_family"))
    runtime_strategy_name = _string(sleeve.get("runtime_strategy_name"))
    execution_profile_id = _string(sleeve.get("execution_profile_id"))
    risk_profile_payload = _feedback_risk_profile_key_payload(
        family_template_id=family_template_id,
        runtime_strategy_name=runtime_strategy_name,
        execution_profile_id=execution_profile_id,
        universe_key=universe_key,
        signal_key=signal_key,
    )
    shape_payload = {
        "family_template_id": family_template_id,
        "runtime_family": runtime_family,
        "runtime_strategy_name": runtime_strategy_name,
        "execution_profile_id": execution_profile_id,
        "universe_key": universe_key,
        "signal_key": signal_key,
        "capital_profile": _string(params.get("capital_profile")),
        "entry_minute_after_open": _string(params.get("entry_minute_after_open")),
        "exit_minute_after_open": _string(params.get("exit_minute_after_open")),
        "entry_start_minute_utc": _string(params.get("entry_start_minute_utc")),
        "entry_end_minute_utc": _string(params.get("entry_end_minute_utc")),
        "max_entries_per_session": _string(params.get("max_entries_per_session")),
        "max_concurrent_positions": _string(params.get("max_concurrent_positions")),
        "top_n": _string(params.get("top_n")),
        "max_pair_legs": _string(params.get("max_pair_legs")),
        "long_stop_loss_bps": _string(params.get("long_stop_loss_bps")),
        "short_stop_loss_bps": _string(params.get("short_stop_loss_bps")),
        "max_session_negative_exit_bps": _string(
            params.get("max_session_negative_exit_bps")
        ),
    }
    metadata: dict[str, Any] = {
        "family_template_id": family_template_id,
        "runtime_family": runtime_family,
        "runtime_strategy_name": runtime_strategy_name,
        "execution_signature": _string(sleeve.get("execution_signature")),
        "execution_profile_id": execution_profile_id,
        "universe_key": universe_key,
        "signal_key": signal_key,
        "runtime_params": dict(params),
        "universe_symbols": universe_symbols,
    }
    if any(_string(value) for value in risk_profile_payload.values()):
        metadata["feedback_risk_profile_key"] = _stable_hash(risk_profile_payload)
    if any(_string(value) for value in shape_payload.values()):
        metadata["feedback_shape_key"] = _stable_hash(shape_payload)
    return metadata


def _portfolio_candidate_row_to_feedback_bundles(
    row: AutoresearchPortfolioCandidate,
    *,
    code_commit: str = "unknown",
) -> tuple[CandidateEvidenceBundle, ...]:
    status = _string(row.status)
    if status not in _PORTFOLIO_FEEDBACK_STATUSES:
        return ()
    payload = _mapping(row.payload_json)
    scorecard = _mapping(row.objective_scorecard_json) or _mapping(
        payload.get("objective_scorecard")
    )
    if not scorecard:
        return ()
    blockers = _portfolio_candidate_feedback_blockers(
        scorecard=scorecard, payload=payload
    )
    sleeves = _list_of_mappings(payload.get("sleeves"))
    if not sleeves:
        sleeves = [
            {"candidate_id": candidate_id, "candidate_spec_id": candidate_id}
            for candidate_id in _string_list_from_value(row.source_candidate_ids_json)
        ]
    bundles: list[CandidateEvidenceBundle] = []
    dataset_snapshot_id = (
        f"autoresearch-portfolio-candidate:{row.epoch_id}:{row.portfolio_candidate_id}"
    )
    promotion_readiness = _mapping(payload.get("promotion_readiness")) or {
        "stage": "research_portfolio",
        "status": f"blocked_by_prior_portfolio_candidate:{status}",
        "promotable": False,
        "blockers": list(blockers),
    }
    for index, sleeve in enumerate(sleeves, start=1):
        candidate_id = _string(sleeve.get("candidate_id")) or _string(
            sleeve.get("candidate_spec_id")
        )
        candidate_spec_id = _string(sleeve.get("candidate_spec_id")) or candidate_id
        if not candidate_spec_id:
            continue
        metadata = _portfolio_sleeve_feedback_metadata(sleeve)
        sleeve_scorecard = {
            **scorecard,
            **metadata,
            "candidate_id": candidate_id or candidate_spec_id,
            "candidate_spec_id": candidate_spec_id,
            "portfolio_candidate_id": row.portfolio_candidate_id,
            "portfolio_epoch_id": row.epoch_id,
            "portfolio_status": status,
            "portfolio_target_net_pnl_per_day": str(row.target_net_pnl_per_day),
            "portfolio_blockers": list(blockers),
            "hard_vetoes": list(blockers),
            "veto_reasons": list(blockers),
            "sleeve_weight": _string(sleeve.get("weight")),
            "sleeve_expected_net_pnl_per_day": _string(
                sleeve.get("expected_net_pnl_per_day")
            ),
            "source_expected_net_pnl_per_day": _string(
                sleeve.get("source_expected_net_pnl_per_day")
            ),
            "sleeve_risk_contribution": _string(sleeve.get("risk_contribution")),
            "source_risk_contribution": _string(sleeve.get("source_risk_contribution")),
            "correlation_cluster": _string(sleeve.get("correlation_cluster")),
        }
        candidate = {
            "candidate_id": candidate_id or candidate_spec_id,
            **metadata,
            "objective_scorecard": sleeve_scorecard,
            "hard_vetoes": blockers,
            "promotion_readiness": promotion_readiness,
        }
        bundles.append(
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=candidate_spec_id,
                candidate=candidate,
                dataset_snapshot_id=dataset_snapshot_id,
                result_path=(
                    f"db://autoresearch_portfolio_candidates/"
                    f"{row.portfolio_candidate_id}/sleeves/{index}"
                ),
                code_commit=code_commit,
            )
        )
    return tuple(bundles)


def _load_recent_persisted_feedback_evidence_bundles(
    *,
    limit: int = _MAX_PERSISTED_FEEDBACK_EVIDENCE_BUNDLES,
    epoch_limit: int = _MAX_PERSISTED_FEEDBACK_EVIDENCE_EPOCHS,
) -> tuple[tuple[CandidateEvidenceBundle, ...], dict[str, Any]]:
    manifest: dict[str, Any] = {
        "source": "autoresearch_epochs.summary_json.candidate_evidence_bundle_payloads",
        "epoch_scan_limit": epoch_limit,
        "bundle_limit": limit,
        "scanned_epoch_count": 0,
        "loaded_bundle_count": 0,
        "invalid_payload_count": 0,
        "legacy_summary_scorecard_count": 0,
        "legacy_summary_matched_scorecard_count": 0,
        "legacy_summary_unmatched_scorecard_count": 0,
        "legacy_summary_bundle_count": 0,
        "legacy_summary_invalid_spec_count": 0,
        "rejected_signal_outcome_scanned_count": 0,
        "rejected_signal_outcome_bundle_count": 0,
        "rejected_signal_outcome_invalid_count": 0,
        "portfolio_candidate_scanned_count": 0,
        "portfolio_candidate_bundle_count": 0,
        "portfolio_candidate_invalid_count": 0,
    }
    try:
        with SessionLocal() as session:
            epochs = (
                session.execute(
                    select(AutoresearchEpoch)
                    .order_by(
                        AutoresearchEpoch.completed_at.desc(),
                        AutoresearchEpoch.created_at.desc(),
                    )
                    .limit(epoch_limit)
                )
                .scalars()
                .all()
            )
            epoch_ids = [epoch.epoch_id for epoch in epochs]
            spec_rows = (
                session.execute(
                    select(AutoresearchCandidateSpec).where(
                        AutoresearchCandidateSpec.epoch_id.in_(epoch_ids)
                    )
                )
                .scalars()
                .all()
                if epoch_ids
                else []
            )
            portfolio_candidate_rows = (
                session.execute(
                    select(AutoresearchPortfolioCandidate)
                    .where(
                        AutoresearchPortfolioCandidate.status.in_(
                            sorted(_PORTFOLIO_FEEDBACK_STATUSES)
                        )
                    )
                    .order_by(
                        AutoresearchPortfolioCandidate.created_at.desc(),
                        AutoresearchPortfolioCandidate.updated_at.desc(),
                    )
                    .limit(limit)
                )
                .scalars()
                .all()
            )
            rejected_signal_outcome_rows = (
                session.execute(
                    select(RejectedSignalOutcomeEvent)
                    .where(RejectedSignalOutcomeEvent.outcome_label_status == "labeled")
                    .order_by(
                        RejectedSignalOutcomeEvent.event_ts.desc(),
                        RejectedSignalOutcomeEvent.created_at.desc(),
                    )
                    .limit(limit)
                )
                .scalars()
                .all()
            )
    except Exception as exc:
        manifest["status"] = "unavailable"
        manifest["error"] = str(exc)
        return (), manifest

    manifest["scanned_epoch_count"] = len(epochs)
    manifest["rejected_signal_outcome_scanned_count"] = len(
        rejected_signal_outcome_rows
    )
    manifest["portfolio_candidate_scanned_count"] = len(portfolio_candidate_rows)
    bundles: list[CandidateEvidenceBundle] = []
    invalid_payload_count = 0
    rejected_signal_outcome_invalid_count = 0
    rejected_signal_outcome_bundle_count = 0
    portfolio_candidate_invalid_count = 0
    portfolio_candidate_bundle_count = 0
    source_epoch_ids: list[str] = []
    legacy_source_epoch_ids: list[str] = []
    rejected_signal_outcome_event_ids: list[str] = []
    portfolio_candidate_ids: list[str] = []
    candidate_specs_by_epoch: dict[str, list[CandidateSpec]] = {}
    invalid_spec_count = 0
    for row in rejected_signal_outcome_rows:
        if len(bundles) >= limit:
            break
        try:
            bundle = _rejected_signal_outcome_payload_to_feedback_bundle(row)
        except Exception:
            rejected_signal_outcome_invalid_count += 1
            continue
        if bundle is None:
            rejected_signal_outcome_invalid_count += 1
            continue
        bundles.append(bundle)
        rejected_signal_outcome_bundle_count += 1
        rejected_signal_outcome_event_ids.append(row.event_id)
    for row in portfolio_candidate_rows:
        if len(bundles) >= limit:
            break
        try:
            row_bundles = _portfolio_candidate_row_to_feedback_bundles(row)
        except Exception:
            portfolio_candidate_invalid_count += 1
            continue
        if not row_bundles:
            portfolio_candidate_invalid_count += 1
            continue
        remaining = limit - len(bundles)
        bundles.extend(row_bundles[:remaining])
        portfolio_candidate_bundle_count += min(len(row_bundles), remaining)
        portfolio_candidate_ids.append(row.portfolio_candidate_id)
    for row in spec_rows:
        try:
            spec = _candidate_spec_from_payload(_mapping(row.payload_json))
        except Exception:
            invalid_spec_count += 1
            continue
        if not spec.candidate_spec_id:
            invalid_spec_count += 1
            continue
        candidate_specs_by_epoch.setdefault(row.epoch_id, []).append(spec)
    for epoch in epochs:
        if len(bundles) >= limit:
            break
        summary = _mapping(epoch.summary_json)
        payloads = _list_of_mappings(summary.get("candidate_evidence_bundle_payloads"))
        if payloads:
            source_epoch_ids.append(epoch.epoch_id)
            for payload in payloads:
                if len(bundles) >= limit:
                    break
                try:
                    bundles.append(evidence_bundle_from_payload(payload))
                except Exception:
                    invalid_payload_count += 1
        if len(bundles) >= limit:
            break
        legacy_bundles, legacy_stats = _summary_scorecard_feedback_bundles_for_epoch(
            epoch, candidate_specs_by_epoch.get(epoch.epoch_id, ())
        )
        manifest["legacy_summary_scorecard_count"] += legacy_stats["scorecard_count"]
        manifest["legacy_summary_matched_scorecard_count"] += legacy_stats[
            "matched_scorecard_count"
        ]
        manifest["legacy_summary_unmatched_scorecard_count"] += legacy_stats[
            "unmatched_scorecard_count"
        ]
        if legacy_bundles:
            legacy_source_epoch_ids.append(epoch.epoch_id)
            remaining = limit - len(bundles)
            bundles.extend(legacy_bundles[:remaining])

    deduped = _dedupe_feedback_evidence_bundles(bundles)
    manifest["status"] = "loaded" if deduped else "empty"
    manifest["source_epoch_ids"] = source_epoch_ids
    manifest["legacy_summary_source_epoch_ids"] = legacy_source_epoch_ids
    manifest["loaded_bundle_count"] = len(deduped)
    manifest["invalid_payload_count"] = invalid_payload_count
    manifest["legacy_summary_bundle_count"] = len(
        _dedupe_feedback_evidence_bundles(
            tuple(
                bundle
                for bundle in bundles
                if bundle.dataset_snapshot_id.endswith(":summary-scorecards")
            )
        )
    )
    manifest["legacy_summary_invalid_spec_count"] = invalid_spec_count
    manifest["rejected_signal_outcome_bundle_count"] = (
        rejected_signal_outcome_bundle_count
    )
    manifest["rejected_signal_outcome_invalid_count"] = (
        rejected_signal_outcome_invalid_count
    )
    manifest["rejected_signal_outcome_event_ids"] = rejected_signal_outcome_event_ids
    manifest["portfolio_candidate_bundle_count"] = portfolio_candidate_bundle_count
    manifest["portfolio_candidate_invalid_count"] = portfolio_candidate_invalid_count
    manifest["portfolio_candidate_ids"] = portfolio_candidate_ids
    return deduped, manifest


def _load_autoresearch_feedback_evidence_bundles(
    paths: Sequence[Path],
    *,
    include_persisted: bool,
) -> tuple[tuple[CandidateEvidenceBundle, ...], dict[str, Any]]:
    explicit_bundles = _load_feedback_evidence_bundles(paths)
    persisted_bundles: tuple[CandidateEvidenceBundle, ...] = ()
    persisted_manifest: dict[str, Any] = {"status": "disabled"}
    if include_persisted:
        (
            persisted_bundles,
            persisted_manifest,
        ) = _load_recent_persisted_feedback_evidence_bundles()
    combined = _dedupe_feedback_evidence_bundles(
        (*explicit_bundles, *persisted_bundles)
    )
    return combined, {
        "schema_version": "torghut.feedback-evidence-source-manifest.v1",
        "explicit_jsonl_path_count": len(paths),
        "explicit_jsonl_bundle_count": len(explicit_bundles),
        "persisted": persisted_manifest,
        "combined_bundle_count": len(combined),
    }


def _program_claim_type(claim: ResearchClaim) -> str:
    explicit_claim_type = str(claim.claim_type or "").strip().lower()
    if explicit_claim_type:
        return explicit_claim_type
    text = f"{claim.summary} {claim.implication}".lower()
    if any(
        token in text
        for token in (
            "validate",
            "validation",
            "held-out",
            "replay",
            "shadow",
            "gate",
            "stress",
            "reject",
            "penalize",
        )
    ):
        return "validation_requirement"
    if any(
        token in text
        for token in (
            "risk",
            "liquidity",
            "cost",
            "spread",
            "drawdown",
            "inventory",
            "sizing",
        )
    ):
        return "risk_constraint"
    if any(
        token in text
        for token in (
            "feature",
            "normalization",
            "microprice",
            "order-flow",
            "order flow",
            "imbalance",
            "volume",
        )
    ):
        return "feature_recipe"
    return "signal_mechanism"


def _program_research_source_to_whitepaper_source(
    source: ResearchSource,
) -> WhitepaperResearchSource | None:
    run_id = str(source.source_id or "").strip()
    if not run_id:
        return None
    claims: list[dict[str, Any]] = []
    for claim in source.claims:
        claim_id = str(claim.claim_id or "").strip()
        claim_text = str(claim.claim_text or "").strip() or ". ".join(
            part
            for part in (
                str(claim.summary or "").strip(),
                str(claim.implication or "").strip(),
            )
            if part
        )
        if not claim_id or not claim_text:
            continue
        claim_type = _program_claim_type(claim)
        data_requirements = [
            item for item in claim.data_requirements if str(item or "").strip()
        ]
        expected_direction = str(claim.expected_direction or "").strip()
        if not expected_direction:
            expected_direction = (
                "neutral"
                if claim_type in {"risk_constraint", "validation_requirement"}
                else "positive"
            )
        claims.append(
            {
                "claim_id": claim_id,
                "claim_type": claim_type,
                "claim_text": claim_text,
                "asset_scope": str(claim.asset_scope or "").strip()
                or "us_equities_intraday",
                "horizon_scope": str(claim.horizon_scope or "").strip()
                or "intraday_microstructure",
                "expected_direction": expected_direction,
                "data_requirements": data_requirements,
                "confidence": _PROGRAM_SOURCE_DEFAULT_CONFIDENCE,
                "metadata": {
                    "program_source_id": run_id,
                    "program_implication": str(claim.implication or "").strip(),
                    "data_requirements": data_requirements,
                },
            }
        )
    if not claims:
        return None
    return WhitepaperResearchSource(
        run_id=run_id,
        title=str(source.title or "").strip() or run_id,
        source_url=str(source.url or "").strip(),
        published_at=str(source.published_at or "").strip(),
        claims=tuple(claims),
    )


def _program_whitepaper_sources(
    program: StrategyAutoresearchProgram,
) -> tuple[WhitepaperResearchSource, ...]:
    sources: list[WhitepaperResearchSource] = []
    for source in program.research_sources:
        converted = _program_research_source_to_whitepaper_source(source)
        if converted is not None:
            sources.append(converted)
    return tuple(sources)


def _dedupe_whitepaper_sources(
    sources: Sequence[WhitepaperResearchSource],
) -> list[WhitepaperResearchSource]:
    resolved: list[WhitepaperResearchSource] = []
    seen_run_ids: set[str] = set()
    for source in sources:
        run_id = str(source.run_id or "").strip()
        if not run_id or run_id in seen_run_ids:
            continue
        seen_run_ids.add(run_id)
        resolved.append(source)
    return resolved


def _resolve_existing_path(path: Path) -> Path:
    resolved = path.expanduser().resolve()
    if path.is_absolute() or resolved.exists():
        return resolved
    for parent in Path(__file__).resolve().parents:
        candidate = (parent / path).resolve()
        if candidate.exists():
            return candidate
    return resolved


def _write_failure_summary(
    *,
    output_dir: Path,
    epoch_id: str,
    status: str,
    reason: str,
    started_at: datetime,
    extra: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    summary = {
        "status": status,
        "epoch_id": epoch_id,
        "run_root": str(output_dir),
        "failure_reason": reason,
        "started_at": started_at.isoformat(),
        "completed_at": datetime.now(UTC).isoformat(),
    }
    if extra:
        summary.update(dict(extra))
    _write_json(output_dir / "error-summary.json", summary)
    _write_json(output_dir / "summary.json", summary)
    write_whitepaper_autoresearch_diagnostics_notebook(
        output_dir / "whitepaper-autoresearch-diagnostics.ipynb",
        summary=summary,
    )
    return summary


def _stable_hash(payload: Mapping[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _decimal(value: Any, *, default: str = "0") -> Decimal:
    try:
        return Decimal(str(value if value is not None else default))
    except Exception:
        return Decimal(default)


def _resolved_clickhouse_password(args: argparse.Namespace) -> str:
    direct_password = str(getattr(args, "clickhouse_password", "") or "").strip()
    if direct_password:
        return direct_password
    password_env = str(getattr(args, "clickhouse_password_env", "") or "").strip()
    if password_env:
        password = os.environ.get(password_env, "")
        if password:
            return password
    return os.environ.get("CLICKHOUSE_PASSWORD", "")


def _clickhouse_host_requires_dns_preflight(url: str) -> bool:
    parsed = urlparse(url)
    host = parsed.hostname or ""
    return host.endswith(".svc") or host.endswith(".svc.cluster.local")


def _clickhouse_endpoint_preflight_failure(args: argparse.Namespace) -> str:
    if str(getattr(args, "replay_mode", "") or "") != "real":
        return ""
    if bool(getattr(args, "selection_only", False)):
        return ""
    if getattr(args, "replay_tape_path", None) is not None:
        return ""
    url = str(getattr(args, "clickhouse_http_url", "") or "").strip()
    parsed = urlparse(url)
    host = parsed.hostname or ""
    if not host:
        return (
            "clickhouse_endpoint_invalid_url:"
            f"url={url or '<empty>'}; set TA_CLICKHOUSE_URL, CLICKHOUSE_HTTP_URL, "
            "or pass --clickhouse-http-url to a reachable ClickHouse HTTP endpoint"
        )
    if not _clickhouse_host_requires_dns_preflight(url):
        return ""
    port = parsed.port or (443 if parsed.scheme == "https" else 8123)
    try:
        socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError as exc:
        return (
            "clickhouse_endpoint_unreachable:"
            f"host={host};port={port};error={exc}; "
            "the default Kubernetes service DNS is only reachable in-cluster. "
            "Run from a cluster pod, set TA_CLICKHOUSE_URL or CLICKHOUSE_HTTP_URL, "
            "or pass --clickhouse-http-url to a local port-forward/HTTP endpoint."
        )
    return ""


def _candidate_universe_symbols_from_args(args: argparse.Namespace) -> tuple[str, ...]:
    symbols_raw = str(getattr(args, "symbols", "") or "")
    raw_symbols: list[str] = []
    raw_seen: set[str] = set()
    for item in symbols_raw.split(","):
        symbol = item.strip().upper()
        if not symbol or symbol in raw_seen:
            continue
        raw_symbols.append(symbol)
        raw_seen.add(symbol)
    if len(raw_symbols) > 12:
        raise ValueError(f"candidate_universe_too_large:{len(raw_symbols)}")

    allowed = set(LIVE_SIGNAL_COVERED_SEMICONDUCTOR_UNIVERSE)
    filtered_symbols = [symbol for symbol in raw_symbols if symbol in allowed]
    if not filtered_symbols:
        return LIVE_SIGNAL_COVERED_SEMICONDUCTOR_UNIVERSE
    return tuple(filtered_symbols)


def _candidate_universe_symbols_for_compilation(
    args: argparse.Namespace,
) -> tuple[str, ...]:
    symbols = _candidate_universe_symbols_from_args(args)
    if set(symbols) == set(LIVE_SIGNAL_COVERED_SEMICONDUCTOR_UNIVERSE) and len(
        symbols
    ) == len(LIVE_SIGNAL_COVERED_SEMICONDUCTOR_UNIVERSE):
        return ()
    return symbols


def _mapping(value: Any) -> dict[str, Any]:
    return (
        {str(key): item for key, item in value.items()}
        if isinstance(value, Mapping)
        else {}
    )


def _string(value: Any) -> str:
    return str(value if value is not None else "").strip()


def _current_code_commit() -> str:
    for name in _CODE_COMMIT_ENV_VARS:
        value = _string(os.getenv(name))
        if value:
            return value

    script_path = Path(__file__).resolve()
    fallback_repo_root = (
        script_path.parents[3]
        if len(script_path.parents) > 3
        else script_path.parents[-1]
    )
    repo_root = next(
        (parent for parent in script_path.parents if (parent / ".git").exists()),
        fallback_repo_root,
    )
    try:
        rev = subprocess.run(
            ("git", "-C", str(repo_root), "rev-parse", "HEAD"),
            check=False,
            capture_output=True,
            text=True,
            timeout=3,
        )
    except (OSError, subprocess.TimeoutExpired):
        return "unknown"
    commit = _string(rev.stdout)
    if rev.returncode != 0 or not commit:
        return "unknown"

    dirty = False
    for args in (
        ("git", "-C", str(repo_root), "diff", "--quiet"),
        ("git", "-C", str(repo_root), "diff", "--cached", "--quiet"),
    ):
        try:
            result = subprocess.run(
                args,
                check=False,
                capture_output=True,
                text=True,
                timeout=3,
            )
        except (OSError, subprocess.TimeoutExpired):
            dirty = True
            break
        if result.returncode != 0:
            dirty = True
            break
    return f"{commit}-dirty" if dirty else commit


def _list_of_mappings(value: Any) -> list[Mapping[str, Any]]:
    if not isinstance(value, list):
        return []
    return [
        cast(Mapping[str, Any], item) for item in value if isinstance(item, Mapping)
    ]


def _sequence_of_mappings(value: Any) -> list[Mapping[str, Any]]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return []
    return [
        cast(Mapping[str, Any], item)
        for item in cast(Sequence[Any], value)
        if isinstance(item, Mapping)
    ]


def _rank_sort_value(value: Any) -> int:
    try:
        return int(str(value))
    except Exception:
        return 10**9


def _proposal_sort_value(value: Any) -> float:
    try:
        return float(str(value))
    except Exception:
        return 0.0


def _scorecard_start_equity(
    scorecard: Mapping[str, Any], *, oracle_policy: ProfitTargetOraclePolicy
) -> Decimal:
    for key in (
        "start_equity",
        "account_start_equity",
        "execution_start_equity",
        "executable_replay_start_equity",
        "runtime_start_equity",
    ):
        value = _decimal(scorecard.get(key))
        if value > 0:
            return value
    return oracle_policy.default_start_equity


def _scorecard_total_net_pnl(scorecard: Mapping[str, Any]) -> Decimal:
    daily_net_payload = scorecard.get("daily_net")
    if isinstance(daily_net_payload, Mapping) and daily_net_payload:
        return sum(
            (_decimal(value) for value in daily_net_payload.values()), Decimal("0")
        )
    net_pnl_per_day = _decimal(scorecard.get("net_pnl_per_day"))
    trading_day_count = max(1, int(_decimal(scorecard.get("trading_day_count"))))
    return net_pnl_per_day * Decimal(trading_day_count)


def _scorecard_profit_factor(scorecard: Mapping[str, Any]) -> Decimal:
    explicit = scorecard.get("profit_factor")
    if explicit is not None:
        return _decimal(explicit)
    daily_net_payload = scorecard.get("daily_net")
    if isinstance(daily_net_payload, Mapping) and daily_net_payload:
        positive_total = sum(
            (
                _decimal(value)
                for value in daily_net_payload.values()
                if _decimal(value) > 0
            ),
            Decimal("0"),
        )
        negative_total = sum(
            (
                -_decimal(value)
                for value in daily_net_payload.values()
                if _decimal(value) < 0
            ),
            Decimal("0"),
        )
        if negative_total > 0:
            return positive_total / negative_total
        return Decimal("999999999") if positive_total > 0 else Decimal("0")
    if (
        _scorecard_total_net_pnl(scorecard) > 0
        and _decimal(scorecard.get("worst_day_loss")) <= 0
    ):
        return Decimal("999999999")
    return Decimal("0")


def _risk_adjusted_drawdown_passes(
    *,
    observed: Decimal,
    start_equity: Decimal,
    normal_pct: Decimal,
    extended_pct: Decimal,
    absolute_cap: Decimal,
    total_net_pnl: Decimal,
    min_total_net_pnl_to_drawdown_ratio: Decimal,
) -> bool:
    normal_limit = max(Decimal("0"), start_equity * normal_pct)
    percent_limit = max(normal_limit, start_equity * extended_pct)
    extended_limit = (
        percent_limit if absolute_cap <= 0 else min(absolute_cap, percent_limit)
    )
    if observed <= normal_limit:
        return True
    if observed <= extended_limit and observed > 0:
        return (total_net_pnl / observed) >= min_total_net_pnl_to_drawdown_ratio
    return observed <= extended_limit


def _oracle_policy_from_args(args: argparse.Namespace) -> ProfitTargetOraclePolicy:
    target_net_pnl_per_day = _decimal(
        getattr(args, "target_net_pnl_per_day", _DEFAULT_DAILY_PROFIT_TARGET),
        default=_DEFAULT_DAILY_PROFIT_TARGET,
    )
    min_active_day_ratio = _decimal(
        getattr(args, "min_active_day_ratio", "0.90"), default="0.90"
    )
    min_positive_day_ratio = _decimal(
        getattr(args, "min_positive_day_ratio", "0.60"), default="0.60"
    )
    min_daily_net_pnl = _decimal(
        getattr(args, "min_daily_net_pnl", "-999999999"),
        default="-999999999",
    )
    max_worst_day_loss = _decimal(
        getattr(args, "max_worst_day_loss", "999999999"), default="999999999"
    )
    max_drawdown = _decimal(
        getattr(args, "max_drawdown", "999999999"), default="999999999"
    )
    if bool(getattr(args, "require_no_flat_days", False)):
        min_active_day_ratio = max(min_active_day_ratio, Decimal("1"))
        min_positive_day_ratio = max(min_positive_day_ratio, Decimal("1"))
        min_daily_net_pnl = max(min_daily_net_pnl, target_net_pnl_per_day)
        max_worst_day_loss = min(max_worst_day_loss, Decimal("0"))
        max_drawdown = min(max_drawdown, Decimal("0"))
    return ProfitTargetOraclePolicy(
        min_active_day_ratio=min_active_day_ratio,
        min_positive_day_ratio=min_positive_day_ratio,
        min_profit_factor=_decimal(
            getattr(args, "min_profit_factor", "1.50"), default="1.50"
        ),
        min_daily_net_pnl=min_daily_net_pnl,
        max_worst_day_loss=max_worst_day_loss,
        max_drawdown=max_drawdown,
        max_best_day_share=_decimal(
            getattr(args, "max_best_day_share", "0.25"), default="0.25"
        ),
        max_cluster_contribution_share=_decimal(
            getattr(args, "max_cluster_contribution_share", "0.40"), default="0.40"
        ),
        max_single_symbol_contribution_share=_decimal(
            getattr(args, "max_single_symbol_contribution_share", "0.35"),
            default="0.35",
        ),
        min_avg_filled_notional_per_day=_decimal(
            getattr(args, "min_avg_filled_notional_per_day", "300000"),
            default="300000",
        ),
        min_observed_trading_days=max(
            0, _int_arg(args, "min_observed_trading_days", 20)
        ),
        min_regime_slice_pass_rate=_decimal(
            getattr(args, "min_regime_slice_pass_rate", "0.45"), default="0.45"
        ),
        default_start_equity=_decimal(
            getattr(args, "start_equity", "31590.02"), default="31590.02"
        ),
        max_worst_day_loss_pct_equity=_decimal(
            getattr(args, "max_worst_day_loss_pct_equity", "0.05"), default="0.05"
        ),
        max_drawdown_pct_equity=_decimal(
            getattr(args, "max_drawdown_pct_equity", "0.08"), default="0.08"
        ),
        extended_max_worst_day_loss_pct_equity=_decimal(
            getattr(args, "extended_max_worst_day_loss_pct_equity", "0.08"),
            default="0.08",
        ),
        extended_max_drawdown_pct_equity=_decimal(
            getattr(args, "extended_max_drawdown_pct_equity", "0.12"),
            default="0.12",
        ),
        min_total_net_pnl_to_drawdown_ratio=_decimal(
            getattr(args, "min_total_net_pnl_to_drawdown_ratio", "3.00"),
            default="3.00",
        ),
        max_gross_exposure_pct_equity=_decimal(
            getattr(args, "max_gross_exposure_pct_equity", "1.0"), default="1.0"
        ),
        min_cash=_decimal(getattr(args, "min_cash", "0"), default="0"),
        max_negative_cash_observation_count=max(
            0, _int_arg(args, "max_negative_cash_observation_count", 0)
        ),
        require_double_oos=not bool(getattr(args, "no_require_double_oos", False)),
        min_double_oos_independent_window_count=max(
            0, _int_arg(args, "min_double_oos_independent_window_count", 2)
        ),
        min_double_oos_pass_rate=_decimal(
            getattr(args, "min_double_oos_pass_rate", "1.00"), default="1.00"
        ),
    )


def _candidate_spec_with_oracle_policy(
    spec: CandidateSpec, *, oracle_policy: ProfitTargetOraclePolicy
) -> CandidateSpec:
    objective = {
        **dict(spec.objective),
        "require_positive_day_ratio": str(oracle_policy.min_positive_day_ratio),
        "require_profit_factor": str(oracle_policy.min_profit_factor),
    }
    hard_vetoes = {
        **dict(spec.hard_vetoes),
        "required_min_active_day_ratio": str(oracle_policy.min_active_day_ratio),
        "required_min_daily_notional": str(
            oracle_policy.min_avg_filled_notional_per_day
        ),
        "required_min_observed_trading_days": str(
            oracle_policy.min_observed_trading_days
        ),
        "required_max_best_day_share": str(oracle_policy.max_best_day_share),
        "required_min_profit_factor": str(oracle_policy.min_profit_factor),
        "required_max_worst_day_loss": str(oracle_policy.max_worst_day_loss),
        "required_max_drawdown": str(oracle_policy.max_drawdown),
        "required_max_gross_exposure_pct_equity": str(
            oracle_policy.max_gross_exposure_pct_equity
        ),
        "required_min_cash": str(oracle_policy.min_cash),
        "required_max_negative_cash_observation_count": str(
            oracle_policy.max_negative_cash_observation_count
        ),
        "required_max_worst_day_loss_pct_equity": str(
            oracle_policy.max_worst_day_loss_pct_equity
        ),
        "required_max_drawdown_pct_equity": str(oracle_policy.max_drawdown_pct_equity),
        "required_extended_max_worst_day_loss_pct_equity": str(
            oracle_policy.extended_max_worst_day_loss_pct_equity
        ),
        "required_extended_max_drawdown_pct_equity": str(
            oracle_policy.extended_max_drawdown_pct_equity
        ),
        "required_min_total_net_pnl_to_drawdown_ratio": str(
            oracle_policy.min_total_net_pnl_to_drawdown_ratio
        ),
        "required_min_regime_slice_pass_rate": str(
            oracle_policy.min_regime_slice_pass_rate
        ),
    }
    base_payload = {
        "hypothesis_id": spec.hypothesis_id,
        "family_template_id": spec.family_template_id,
        "feature_contract": dict(spec.feature_contract),
        "objective": objective,
    }
    return replace(
        spec,
        candidate_spec_id=candidate_spec_id_for_payload(base_payload),
        objective=objective,
        hard_vetoes=hard_vetoes,
        promotion_contract={
            **dict(spec.promotion_contract),
            "profit_target_oracle_policy": oracle_policy.to_payload(),
        },
    )


def _candidate_specs_with_oracle_policy(
    specs: Sequence[CandidateSpec], *, oracle_policy: ProfitTargetOraclePolicy
) -> list[CandidateSpec]:
    return [
        _candidate_spec_with_oracle_policy(spec, oracle_policy=oracle_policy)
        for spec in specs
    ]


def _load_sources_from_db(
    paper_run_ids: Sequence[str],
) -> list[WhitepaperResearchSource]:
    if not paper_run_ids:
        return []
    run_id_set = {item.strip() for item in paper_run_ids if item.strip()}
    with SessionLocal() as session:
        rows = session.execute(
            select(WhitepaperAnalysisRun).where(
                WhitepaperAnalysisRun.run_id.in_(sorted(run_id_set)),
                WhitepaperAnalysisRun.status == "completed",
            )
        ).scalars()
        sources: list[WhitepaperResearchSource] = []
        for row in rows:
            claims = [
                {
                    "claim_id": claim.claim_id,
                    "claim_type": claim.claim_type,
                    "claim_text": claim.claim_text,
                    "asset_scope": claim.asset_scope,
                    "horizon_scope": claim.horizon_scope,
                    "data_requirements": claim.data_requirements_json,
                    "expected_direction": claim.expected_direction,
                    "required_activity_conditions": claim.required_activity_conditions_json,
                    "liquidity_constraints": claim.liquidity_constraints_json,
                    "validation_notes": claim.validation_notes,
                    "confidence": str(claim.confidence)
                    if claim.confidence is not None
                    else None,
                    "metadata": claim.metadata_json,
                }
                for claim in row.claims
            ]
            relations = [
                {
                    "relation_id": relation.relation_id,
                    "relation_type": relation.relation_type,
                    "source_claim_id": relation.source_claim_id,
                    "target_claim_id": relation.target_claim_id,
                    "target_run_id": relation.target_run_id,
                    "rationale": relation.rationale,
                    "confidence": str(relation.confidence)
                    if relation.confidence is not None
                    else None,
                    "metadata": relation.metadata_json,
                }
                for relation in row.claim_relations
            ]
            sources.append(
                WhitepaperResearchSource(
                    run_id=row.run_id,
                    title=row.document.title or row.run_id,
                    source_url=str(
                        _mapping(row.document.metadata_json).get("source_url") or ""
                    ),
                    published_at=str(row.document.published_at or ""),
                    claims=tuple(claims),
                    claim_relations=tuple(relations),
                )
            )
        return sources


def _persist_vnext_specs(*, source_run_id: str, specs: Sequence[CandidateSpec]) -> None:
    with SessionLocal() as session:
        for spec in specs:
            session.add(
                VNextExperimentSpec(
                    run_id=source_run_id,
                    candidate_id=None,
                    experiment_id=f"{spec.candidate_spec_id}-exp",
                    payload_json=spec.to_vnext_experiment_payload(),
                )
            )
        session.commit()


def _persist_epoch_ledgers(
    *,
    epoch_id: str,
    status: str,
    target_net_pnl_per_day: Decimal,
    paper_run_ids: Sequence[str],
    sources: Sequence[WhitepaperResearchSource],
    candidate_specs: Sequence[CandidateSpec],
    candidate_blockers: Mapping[str, Sequence[CandidateCompilationBlocker]]
    | None = None,
    proposal_rows: Sequence[Mapping[str, Any]],
    portfolio: PortfolioCandidateSpec | None,
    summary: Mapping[str, Any],
    runner_config: Mapping[str, Any],
    started_at: datetime,
    completed_at: datetime,
    failure_reason: str | None = None,
) -> None:
    candidate_blockers = candidate_blockers or {}
    with SessionLocal() as session:
        session.add(
            AutoresearchEpoch(
                epoch_id=epoch_id,
                status=status,
                target_net_pnl_per_day=target_net_pnl_per_day,
                paper_run_ids_json=list(paper_run_ids),
                snapshot_manifest_json={
                    "source_count": len(sources),
                    "paper_sources": [source.to_payload() for source in sources],
                },
                runner_config_json=dict(runner_config),
                summary_json=dict(summary),
                started_at=started_at,
                completed_at=completed_at,
                failure_reason=failure_reason,
            )
        )
        for spec in candidate_specs:
            payload = spec.to_payload()
            blockers = [
                blocker.to_payload()
                for blocker in candidate_blockers.get(spec.candidate_spec_id, ())
            ]
            session.add(
                AutoresearchCandidateSpec(
                    candidate_spec_id=spec.candidate_spec_id,
                    epoch_id=epoch_id,
                    hypothesis_id=spec.hypothesis_id,
                    candidate_kind=spec.candidate_kind,
                    family_template_id=spec.family_template_id,
                    payload_json=payload,
                    payload_hash=_stable_hash(payload),
                    status="blocked" if blockers else "eligible",
                    blockers_json=blockers,
                )
            )
        for item in proposal_rows:
            candidate_spec_id = str(item.get("candidate_spec_id") or "").strip()
            if not candidate_spec_id:
                continue
            feature_payload = _mapping(item.get("features"))
            session.add(
                AutoresearchProposalScore(
                    epoch_id=epoch_id,
                    candidate_spec_id=candidate_spec_id,
                    model_id=str(item.get("model_id") or "unknown"),
                    backend=str(item.get("backend") or "unknown"),
                    proposal_score=_decimal(item.get("proposal_score")),
                    rank=int(item.get("rank") or 0),
                    selection_reason=str(item.get("selection_reason") or "unselected"),
                    feature_hash=_stable_hash(feature_payload)
                    if feature_payload
                    else None,
                    payload_json=dict(item),
                )
            )
        if portfolio is not None:
            portfolio_payload = portfolio.to_payload()
            promotion_readiness = _mapping(summary.get("promotion_readiness"))
            if promotion_readiness:
                portfolio_payload["promotion_readiness"] = dict(promotion_readiness)
            paper_probation_candidate = _mapping(
                _mapping(summary.get("candidate_board")).get(
                    "paper_probation_candidate"
                )
            )
            paper_probation_authorized = _boolish(
                paper_probation_candidate.get("paper_probation_authorized")
            )
            portfolio_status = "blocked"
            if bool(portfolio.objective_scorecard.get("oracle_passed")):
                portfolio_status = (
                    "promotion_ready"
                    if _boolish(promotion_readiness.get("promotable"))
                    else "target_met"
                )
            elif (
                _boolish(portfolio.objective_scorecard.get("target_met"))
                and paper_probation_authorized
            ):
                portfolio_status = "paper_probation"
            session.add(
                AutoresearchPortfolioCandidate(
                    portfolio_candidate_id=portfolio.portfolio_candidate_id,
                    epoch_id=epoch_id,
                    source_candidate_ids_json=list(portfolio.source_candidate_ids),
                    target_net_pnl_per_day=portfolio.target_net_pnl_per_day,
                    objective_scorecard_json=dict(portfolio.objective_scorecard),
                    optimizer_report_json=dict(portfolio.optimizer_report),
                    payload_json=portfolio_payload,
                    status=portfolio_status,
                )
            )
        session.commit()


def _proposal_model_and_rows(
    *,
    specs: Sequence[CandidateSpec],
    evidence_bundles: Sequence[CandidateEvidenceBundle],
    ranker_backend_preference: str = _DEFAULT_RANKER_BACKEND_PREFERENCE,
    replay_selection_by_spec: Mapping[str, Mapping[str, Any]] | None = None,
) -> tuple[Mapping[str, Any], list[dict[str, Any]]]:
    training_rows = build_mlx_training_rows(
        candidate_specs=specs, evidence_bundles=evidence_bundles
    )
    model = train_mlx_ranker(
        training_rows, backend_preference=ranker_backend_preference
    )
    feature_by_spec = {
        row.candidate_spec_id: row.to_payload()["features"] for row in training_rows
    }
    net_by_spec = {
        bundle.candidate_spec_id: float(
            _decimal(bundle.objective_scorecard.get("net_pnl_per_day"))
        )
        for bundle in evidence_bundles
    }
    policy_result = rank_training_rows_with_lift_policy(
        model=model,
        rows=training_rows,
        metric_name="net_pnl_per_day",
        outcome_by_spec=net_by_spec,
    )
    proposal_rows = [
        {
            "candidate_spec_id": item.candidate_spec_id,
            "proposal_score": item.score,
            "rank": item.rank,
            "backend": item.backend,
            "model_id": item.model_id,
            "selection_reason": policy_result.selection_reason,
            "replay_selection_reason": _mapping(
                replay_selection_by_spec.get(item.candidate_spec_id)
                if replay_selection_by_spec is not None
                else None
            ).get("selection_reason", "not_selected_budget"),
            "selected_for_replay": bool(
                _mapping(
                    replay_selection_by_spec.get(item.candidate_spec_id)
                    if replay_selection_by_spec is not None
                    else None
                ).get("selected_for_replay")
            ),
            "feature_hash": item.feature_hash,
            "features": feature_by_spec.get(item.candidate_spec_id, {}),
        }
        for item in policy_result.ranked_rows
    ]
    model_payload = {
        **model.to_payload(),
        "rank_bucket_lift": policy_result.rank_bucket_lift.to_payload(),
        "model_status": policy_result.model_status,
    }
    return model_payload, proposal_rows


def _candidate_quality_gate_failures(
    scorecard: Mapping[str, Any], *, oracle_policy: ProfitTargetOraclePolicy
) -> list[str]:
    failures: list[str] = []
    start_equity = _scorecard_start_equity(scorecard, oracle_policy=oracle_policy)
    total_net_pnl = _scorecard_total_net_pnl(scorecard)
    if _decimal(scorecard.get("net_pnl_per_day")) <= 0:
        failures.append("non_positive_net_pnl_per_day")
    if _decimal(scorecard.get("active_day_ratio")) < oracle_policy.min_active_day_ratio:
        failures.append("active_day_ratio_below_oracle")
    if (
        _decimal(scorecard.get("positive_day_ratio"))
        < oracle_policy.min_positive_day_ratio
    ):
        failures.append("positive_day_ratio_below_oracle")
    if _scorecard_profit_factor(scorecard) < oracle_policy.min_profit_factor:
        failures.append("profit_factor_below_oracle")
    if (
        _decimal(scorecard.get("best_day_share"), default="1")
        > oracle_policy.max_best_day_share
    ):
        failures.append("best_day_share_above_oracle")
    if not _risk_adjusted_drawdown_passes(
        observed=_decimal(scorecard.get("worst_day_loss"), default="999999"),
        start_equity=start_equity,
        normal_pct=oracle_policy.max_worst_day_loss_pct_equity,
        extended_pct=oracle_policy.extended_max_worst_day_loss_pct_equity,
        absolute_cap=oracle_policy.max_worst_day_loss,
        total_net_pnl=total_net_pnl,
        min_total_net_pnl_to_drawdown_ratio=oracle_policy.min_total_net_pnl_to_drawdown_ratio,
    ):
        failures.append("worst_day_loss_above_oracle")
    if not _risk_adjusted_drawdown_passes(
        observed=_decimal(scorecard.get("max_drawdown"), default="999999"),
        start_equity=start_equity,
        normal_pct=oracle_policy.max_drawdown_pct_equity,
        extended_pct=oracle_policy.extended_max_drawdown_pct_equity,
        absolute_cap=oracle_policy.max_drawdown,
        total_net_pnl=total_net_pnl,
        min_total_net_pnl_to_drawdown_ratio=oracle_policy.min_total_net_pnl_to_drawdown_ratio,
    ):
        failures.append("max_drawdown_above_oracle")
    if (
        _decimal(scorecard.get("max_gross_exposure_pct_equity"))
        > oracle_policy.max_gross_exposure_pct_equity
    ):
        failures.append("max_gross_exposure_above_oracle")
    if _decimal(scorecard.get("min_cash")) < oracle_policy.min_cash:
        failures.append("min_cash_below_oracle")
    if (
        int(_decimal(scorecard.get("negative_cash_observation_count")))
        > oracle_policy.max_negative_cash_observation_count
    ):
        failures.append("negative_cash_observed")
    if (
        _decimal(scorecard.get("avg_filled_notional_per_day"))
        < oracle_policy.min_avg_filled_notional_per_day
    ):
        failures.append("avg_filled_notional_per_day_below_oracle")
    if (
        _decimal(scorecard.get("regime_slice_pass_rate"))
        < oracle_policy.min_regime_slice_pass_rate
    ):
        failures.append("regime_slice_pass_rate_below_oracle")
    if (
        _decimal(scorecard.get("posterior_edge_lower"))
        <= oracle_policy.min_posterior_edge_lower
    ):
        failures.append("posterior_edge_lower_non_positive")
    if _string(scorecard.get("shadow_parity_status")) != "within_budget":
        failures.append("shadow_parity_status_not_within_budget")
    if oracle_policy.require_executable_replay:
        if str(scorecard.get("executable_replay_passed")).lower() != "true":
            failures.append("executable_replay_not_passed")
        if not _string(scorecard.get("executable_replay_artifact_ref")):
            failures.append("executable_replay_artifact_missing")
        executable_order_count = int(
            _decimal(
                scorecard.get("executable_replay_order_count")
                or scorecard.get("executable_replay_submitted_order_count")
                or scorecard.get("executable_replay_orders_submitted_total")
            )
        )
        if executable_order_count < oracle_policy.min_executable_order_count:
            failures.append("executable_replay_order_count_below_oracle")
        replay_buying_power = _decimal(
            scorecard.get("executable_replay_account_buying_power")
            or scorecard.get("executable_replay_buying_power")
        )
        replay_max_notional = _decimal(
            scorecard.get("executable_replay_max_notional_per_trade")
            or scorecard.get("executable_replay_max_notional_per_order")
        )
        if replay_buying_power <= 0:
            failures.append("executable_replay_account_buying_power_missing")
        if replay_max_notional <= 0:
            failures.append("executable_replay_max_notional_missing")
        if (
            oracle_policy.require_executable_replay_notional_within_buying_power
            and replay_max_notional > replay_buying_power
        ):
            failures.append("executable_replay_notional_exceeds_buying_power")
    for blocker in sorted(_oracle_blockers(scorecard)):
        if blocker not in failures:
            failures.append(blocker)
    return failures


def _false_positive_table(
    *,
    proposal_rows: Sequence[Mapping[str, Any]],
    evidence_bundles: Sequence[CandidateEvidenceBundle],
    oracle_policy: ProfitTargetOraclePolicy,
    limit: int = 16,
) -> list[dict[str, Any]]:
    evidence_by_spec = {bundle.candidate_spec_id: bundle for bundle in evidence_bundles}
    rows: list[dict[str, Any]] = []
    for proposal in _list_of_mappings(list(proposal_rows)):
        candidate_spec_id = _string(proposal.get("candidate_spec_id"))
        if not candidate_spec_id or not bool(proposal.get("selected_for_replay")):
            continue
        evidence = evidence_by_spec.get(candidate_spec_id)
        if evidence is None:
            rows.append(
                {
                    "candidate_spec_id": candidate_spec_id,
                    "candidate_id": None,
                    "rank": _rank_sort_value(proposal.get("rank")),
                    "proposal_score": proposal.get("proposal_score"),
                    "replay_selection_reason": _string(
                        proposal.get("replay_selection_reason")
                    )
                    or "selected_for_replay",
                    "evidence_status": "missing",
                    "failure_reasons": ["replay_evidence_missing"],
                }
            )
            continue
        scorecard = evidence.objective_scorecard
        failure_reasons = _candidate_quality_gate_failures(
            scorecard, oracle_policy=oracle_policy
        )
        if not failure_reasons:
            continue
        rows.append(
            {
                "candidate_spec_id": candidate_spec_id,
                "candidate_id": evidence.candidate_id,
                "rank": _rank_sort_value(proposal.get("rank")),
                "proposal_score": proposal.get("proposal_score"),
                "replay_selection_reason": _string(
                    proposal.get("replay_selection_reason")
                )
                or "selected_for_replay",
                "evidence_status": "replayed",
                "net_pnl_per_day": _string(scorecard.get("net_pnl_per_day")),
                "active_day_ratio": _string(scorecard.get("active_day_ratio")),
                "positive_day_ratio": _string(scorecard.get("positive_day_ratio")),
                "best_day_share": _string(scorecard.get("best_day_share")),
                "worst_day_loss": _string(scorecard.get("worst_day_loss")),
                "max_drawdown": _string(scorecard.get("max_drawdown")),
                "avg_filled_notional_per_day": _string(
                    scorecard.get("avg_filled_notional_per_day")
                ),
                "regime_slice_pass_rate": _string(
                    scorecard.get("regime_slice_pass_rate")
                ),
                "posterior_edge_lower": _string(scorecard.get("posterior_edge_lower")),
                "shadow_parity_status": _string(scorecard.get("shadow_parity_status")),
                "failure_reasons": failure_reasons,
            }
        )
    rows.sort(
        key=lambda row: (
            _rank_sort_value(row.get("rank")),
            -_proposal_sort_value(row.get("proposal_score")),
            _string(row.get("candidate_spec_id")),
        )
    )
    return rows[: max(0, limit)]


def _replay_diagnostic_proposal_rows(
    *,
    candidate_selection: Mapping[str, Any],
    pre_replay_proposal_rows: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    pre_replay_by_spec = {
        _string(row.get("candidate_spec_id")): row
        for row in _list_of_mappings(list(pre_replay_proposal_rows))
        if _string(row.get("candidate_spec_id"))
    }
    rows: list[dict[str, Any]] = []
    for selection in _list_of_mappings(candidate_selection.get("rows")):
        candidate_spec_id = _string(selection.get("candidate_spec_id"))
        if not candidate_spec_id:
            continue
        pre_replay = pre_replay_by_spec.get(candidate_spec_id, {})
        rows.append(
            {
                **dict(pre_replay),
                "candidate_spec_id": candidate_spec_id,
                "proposal_score": pre_replay.get("proposal_score"),
                "rank": _rank_sort_value(selection.get("rank")),
                "pre_replay_score": _string(selection.get("pre_replay_score")),
                "paper_contract_prior_score": _string(
                    selection.get("paper_contract_prior_score")
                ),
                "paper_mechanism_overlay_ids": _string_list_from_value(
                    selection.get("paper_mechanism_overlay_ids")
                ),
                "paper_required_evidence_tokens": _string_list_from_value(
                    selection.get("paper_required_evidence_tokens")
                ),
                "paper_required_evidence_count": _candidate_board_int_field(
                    selection, "paper_required_evidence_count"
                ),
                "selected_for_replay": bool(selection.get("selected_for_replay")),
                "replay_selection_reason": _string(selection.get("selection_reason"))
                or "not_selected_budget",
            }
        )
    return rows


def _best_false_negative_table(
    *,
    candidate_selection: Mapping[str, Any],
    pre_replay_proposal_rows: Sequence[Mapping[str, Any]],
    evidence_bundles: Sequence[CandidateEvidenceBundle],
    limit: int = 16,
) -> list[dict[str, Any]]:
    evidence_by_spec = {bundle.candidate_spec_id: bundle for bundle in evidence_bundles}
    pre_replay_by_spec = {
        _string(row.get("candidate_spec_id")): row
        for row in _list_of_mappings(list(pre_replay_proposal_rows))
        if _string(row.get("candidate_spec_id"))
    }
    rows: list[dict[str, Any]] = []
    for selection in _list_of_mappings(candidate_selection.get("rows")):
        candidate_spec_id = _string(selection.get("candidate_spec_id"))
        if (
            not candidate_spec_id
            or bool(selection.get("selected_for_replay"))
            or candidate_spec_id in evidence_by_spec
            or _string(selection.get("selection_reason"))
            == "duplicate_execution_signature"
            or _selection_reason_blocks_replay(
                _string(selection.get("selection_reason"))
            )
        ):
            continue
        pre_replay = pre_replay_by_spec.get(candidate_spec_id, {})
        rows.append(
            {
                "candidate_spec_id": candidate_spec_id,
                "candidate_id": None,
                "rank": _rank_sort_value(selection.get("rank")),
                "pre_replay_score": _string(selection.get("pre_replay_score")),
                "paper_contract_prior_score": _string(
                    selection.get("paper_contract_prior_score")
                ),
                "paper_mechanism_overlay_ids": _string_list_from_value(
                    selection.get("paper_mechanism_overlay_ids")
                ),
                "paper_required_evidence_tokens": _string_list_from_value(
                    selection.get("paper_required_evidence_tokens")
                ),
                "paper_required_evidence_count": _candidate_board_int_field(
                    selection, "paper_required_evidence_count"
                ),
                "proposal_score": pre_replay.get("proposal_score"),
                "selection_reason": _string(selection.get("selection_reason"))
                or "not_selected_budget",
                "selected_for_replay": False,
                "evidence_status": "not_replayed",
                "reason": "not_replayed_budget",
            }
        )
    rows.sort(
        key=lambda row: (
            _rank_sort_value(row.get("rank")),
            -_proposal_sort_value(row.get("proposal_score")),
            _string(row.get("candidate_spec_id")),
        )
    )
    return rows[: max(0, limit)]


def _recent_trading_days_shortfall(failure_reason: str) -> dict[str, int] | None:
    marker = "insufficient_recent_trading_days:"
    marker_index = failure_reason.find(marker)
    if marker_index < 0:
        return None
    remainder = failure_reason[marker_index + len(marker) :]
    token = remainder.splitlines()[0].split()[0] if remainder.strip() else ""
    available_text, separator, required_text = token.partition("<")
    if separator != "<":
        return None
    try:
        available = int(available_text)
        required = int(required_text)
    except ValueError:
        return None
    return {
        "available_recent_trading_days": available,
        "required_recent_trading_days": required,
        "missing_recent_trading_days": max(0, required - available),
    }


def _stale_tape_diagnostics(failure_reason: str) -> dict[str, str] | None:
    marker = "stale_tape:"
    marker_index = failure_reason.find(marker)
    if marker_index < 0:
        return None
    remainder = failure_reason[marker_index + len(marker) :].splitlines()[0]
    fields: dict[str, str] = {}
    for token in remainder.split(":"):
        key, separator, value = token.partition("=")
        if separator == "=" and key and value:
            fields[key] = value
    expected = fields.get("expected_last_trading_day")
    end_day = fields.get("end_day")
    if not expected or not end_day:
        return None
    return {
        "expected_last_trading_day": expected,
        "available_end_day": end_day,
    }


def _candidate_search_remediation(
    *,
    failure_reason: str,
    candidate_selection: Mapping[str, Any],
    evidence_bundles: Sequence[CandidateEvidenceBundle],
    false_positive_table: Sequence[Mapping[str, Any]],
    best_false_negative_table: Sequence[Mapping[str, Any]],
    replay_timeout_seconds: int,
    max_frontier_candidates_per_spec: int,
    current_top_k: int = 16,
    current_exploration_slots: int = 8,
    current_portfolio_size_min: int = 2,
    current_max_candidates: int = 64,
    current_max_total_frontier_candidates: int = 0,
    current_train_days: int = 6,
    current_holdout_days: int = 3,
    current_second_oos_days: int = 2,
) -> dict[str, Any]:
    failure_counts: dict[str, int] = {}
    for row in _list_of_mappings(list(false_positive_table)):
        for reason in cast(Sequence[Any], row.get("failure_reasons") or ()):
            reason_text = _string(reason)
            if reason_text:
                failure_counts[reason_text] = failure_counts.get(reason_text, 0) + 1

    partial_scorecards = [
        dict(bundle.objective_scorecard) for bundle in evidence_bundles
    ]
    selected_rows = [
        row
        for row in _list_of_mappings(candidate_selection.get("rows"))
        if bool(row.get("selected_for_replay"))
    ]
    selected_but_missing = [
        row
        for row in _list_of_mappings(list(false_positive_table))
        if row.get("evidence_status") == "missing"
    ]
    selection_budget = _mapping(candidate_selection.get("budget"))

    def budget_int(name: str, default: int = 0) -> int:
        try:
            return int(selection_budget.get(name, default) or default)
        except (TypeError, ValueError):
            return default

    observed_selection_budget = {
        "compiled_candidate_count": budget_int("compiled_candidate_count"),
        "unique_execution_signature_count": budget_int(
            "unique_execution_signature_count"
        ),
        "eligible_candidate_count": budget_int("eligible_candidate_count"),
        "pre_replay_feedback_blocked_candidate_count": budget_int(
            "pre_replay_feedback_blocked_candidate_count"
        ),
        "pre_replay_nonpositive_synthetic_candidate_count": budget_int(
            "pre_replay_nonpositive_synthetic_candidate_count"
        ),
        "pre_replay_blocked_candidate_count": budget_int(
            "pre_replay_blocked_candidate_count"
        ),
        "selected_count": budget_int("selected_count", len(selected_rows)),
        "max_candidates": budget_int("max_candidates", current_max_candidates),
        "top_k": budget_int("top_k", current_top_k),
        "exploration_slots": budget_int(
            "exploration_slots_effective",
            budget_int("exploration_slots", current_exploration_slots),
        ),
    }
    unique_execution_signature_count = observed_selection_budget[
        "unique_execution_signature_count"
    ]
    candidate_surface_exhausted = (
        unique_execution_signature_count > 0
        and observed_selection_budget["selected_count"]
        >= unique_execution_signature_count
        and observed_selection_budget["max_candidates"]
        >= unique_execution_signature_count
        and observed_selection_budget["top_k"]
        + observed_selection_budget["exploration_slots"]
        >= unique_execution_signature_count
    )
    replayable_candidate_surface_exhausted = (
        observed_selection_budget["eligible_candidate_count"] > 0
        and observed_selection_budget["selected_count"]
        >= observed_selection_budget["eligible_candidate_count"]
        and observed_selection_budget["max_candidates"]
        >= observed_selection_budget["eligible_candidate_count"]
        and observed_selection_budget["top_k"]
        + observed_selection_budget["exploration_slots"]
        >= observed_selection_budget["eligible_candidate_count"]
    )
    next_actions: list[dict[str, Any]] = []
    recent_day_shortfall = _recent_trading_days_shortfall(failure_reason)
    recent_day_diagnostics: dict[str, Any] | None = None
    if recent_day_shortfall is not None:
        signal_recent_days_query = (
            "SELECT toDate(event_ts) AS trading_day, count() AS rows, "
            "min(event_ts) AS first_event_ts, max(event_ts) AS last_event_ts "
            "FROM torghut.ta_signals WHERE source = 'ta' AND window_size = 'PT1S' "
            "GROUP BY trading_day ORDER BY trading_day DESC LIMIT 20"
        )
        signal_microbar_coverage_query = (
            "SELECT table_name, countDistinct(trading_day) AS days, "
            "min(trading_day) AS first_day, max(trading_day) AS last_day, sum(rows) AS rows "
            "FROM ("
            "SELECT 'ta_signals' AS table_name, toDate(event_ts) AS trading_day, count() AS rows "
            "FROM torghut.ta_signals WHERE source = 'ta' AND window_size = 'PT1S' "
            "GROUP BY trading_day UNION ALL "
            "SELECT 'ta_microbars' AS table_name, toDate(event_ts) AS trading_day, count() AS rows "
            "FROM torghut.ta_microbars WHERE source = 'ta' AND window_size = 'PT1S' "
            "GROUP BY trading_day"
            ") GROUP BY table_name ORDER BY table_name"
        )
        signal_microbar_day_gap_query = (
            "SELECT trading_day, "
            "sumIf(rows, table_name = 'ta_signals') AS signal_rows, "
            "sumIf(rows, table_name = 'ta_microbars') AS microbar_rows "
            "FROM ("
            "SELECT 'ta_signals' AS table_name, toDate(event_ts) AS trading_day, count() AS rows "
            "FROM torghut.ta_signals WHERE source = 'ta' AND window_size = 'PT1S' "
            "GROUP BY trading_day UNION ALL "
            "SELECT 'ta_microbars' AS table_name, toDate(event_ts) AS trading_day, count() AS rows "
            "FROM torghut.ta_microbars WHERE source = 'ta' AND window_size = 'PT1S' "
            "GROUP BY trading_day"
            ") GROUP BY trading_day ORDER BY trading_day DESC LIMIT 40"
        )
        recent_day_diagnostics = {
            **recent_day_shortfall,
            "required_window": {
                "train_days": max(1, int(current_train_days)),
                "holdout_days": max(1, int(current_holdout_days)),
                "second_oos_days": max(0, int(current_second_oos_days)),
            },
            "clickhouse_recent_days_query": signal_recent_days_query,
            "clickhouse_signal_microbar_coverage_query": signal_microbar_coverage_query,
            "clickhouse_signal_microbar_day_gap_query": signal_microbar_day_gap_query,
            "clickhouse_coverage_probe_queries": {
                "ta_signals_recent_days": signal_recent_days_query,
                "signal_microbar_coverage": signal_microbar_coverage_query,
                "signal_microbar_day_gap": signal_microbar_day_gap_query,
            },
        }
        next_actions.append(
            {
                "priority": 1,
                "action": "inspect_or_backfill_recent_ta_signal_days",
                "reason": (
                    "real replay cannot build the requested train/holdout/double-OOS "
                    "window from available TA PT1S signal days"
                ),
                "recent_trading_days": recent_day_diagnostics,
                "recommended_operator_probe": recent_day_diagnostics[
                    "clickhouse_recent_days_query"
                ],
                "recommended_coverage_probe": recent_day_diagnostics[
                    "clickhouse_signal_microbar_coverage_query"
                ],
                "recommended_day_gap_probe": recent_day_diagnostics[
                    "clickhouse_signal_microbar_day_gap_query"
                ],
                "recommended_archive_probe": (
                    "python services/torghut/scripts/archive_recent_kafka_trading_days.py "
                    "--archive-root $ARCHIVE_ROOT --scan-root $HISTORICAL_RUN_ROOT --json"
                ),
            }
        )
    stale_tape = _stale_tape_diagnostics(failure_reason)
    if stale_tape is not None:
        next_actions.append(
            {
                "priority": 1,
                "action": "inspect_or_backfill_latest_ta_signal_day",
                "reason": (
                    "real replay freshness gate rejected the tape because the latest "
                    "available TA day is older than the expected last trading day"
                ),
                "stale_tape": stale_tape,
                "recommended_operator_probe": (
                    "SELECT source, window_size, countDistinct(toDate(event_ts)) AS days, "
                    "min(toDate(event_ts)) AS first_day, max(toDate(event_ts)) AS last_day, "
                    "count() AS rows FROM torghut.ta_signals GROUP BY source, window_size "
                    "ORDER BY days DESC, rows DESC"
                ),
                "diagnostic_replay_note": (
                    "For a read-only stale-tape diagnostic replay, pass "
                    "--expected-last-trading-day "
                    f"{stale_tape['available_end_day']} instead of using live freshness proof."
                ),
            }
        )
    if (
        observed_selection_budget["selected_count"] <= 0
        and observed_selection_budget["pre_replay_feedback_blocked_candidate_count"] > 0
    ):
        next_actions.append(
            {
                "priority": 1,
                "action": "expand_or_mutate_strategy_surface_after_feedback_blocks_all_candidates",
                "reason": (
                    "pre-replay feedback vetoed every eligible execution profile; "
                    "the next epoch needs new sleeves or materially different execution signatures"
                ),
                "observed_selection_budget": observed_selection_budget,
                "recommended_code_change": (
                    "mutate strategy templates, sleeves, or execution/risk profiles before replaying "
                    "the same blocked signatures again"
                ),
            }
        )
    if (
        observed_selection_budget["selected_count"] <= 0
        and observed_selection_budget[
            "pre_replay_nonpositive_synthetic_candidate_count"
        ]
        > 0
    ):
        next_actions.append(
            {
                "priority": 2,
                "action": "expand_or_mutate_strategy_surface_after_negative_mlx_prior",
                "reason": (
                    "the pre-replay model assigned nonpositive expected value to every synthetic-prior "
                    "candidate; wider replay would only spend budget on unpromising candidates"
                ),
                "observed_selection_budget": observed_selection_budget,
                "recommended_code_change": (
                    "add new candidate families, sleeves, or feature/risk variants that can earn a "
                    "positive pre-replay expected value before real replay"
                ),
            }
        )
    if next_actions:
        next_actions.sort(key=lambda row: int(row.get("priority") or 10**6))
        return {
            "schema_version": "torghut.whitepaper-autoresearch-remediation.v1",
            "failure_reason": failure_reason,
            "partial_evidence_bundle_count": len(evidence_bundles),
            "selected_for_replay_count": len(selected_rows),
            "selected_missing_evidence_count": len(selected_but_missing),
            "failure_reason_counts": dict(sorted(failure_counts.items())),
            "partial_scorecards": partial_scorecards,
            "candidate_surface_exhausted": candidate_surface_exhausted,
            "replayable_candidate_surface_exhausted": replayable_candidate_surface_exhausted,
            "observed_selection_budget": observed_selection_budget,
            "recent_trading_days": recent_day_diagnostics,
            "stale_tape": stale_tape,
            "next_actions": next_actions,
        }
    if "TimeoutError:real_replay_timeout_seconds" in failure_reason:
        current_per_spec = max(1, int(max_frontier_candidates_per_spec))
        retry_per_spec = (
            max(1, min(4, current_per_spec // 4)) if current_per_spec > 2 else 1
        )
        next_actions.append(
            {
                "priority": 1,
                "action": "shrink_per_spec_frontier_or_extend_timeout",
                "reason": "real replay timed out before all selected candidate specs emitted evidence",
                "recommended_flags": {
                    "--max-frontier-candidates-per-spec": str(retry_per_spec),
                    "--real-replay-timeout-seconds": str(
                        max(replay_timeout_seconds * 2, 900)
                        if replay_timeout_seconds > 0
                        else 900
                    ),
                },
            }
        )
    if selected_but_missing:
        next_actions.append(
            {
                "priority": 2,
                "action": "replay_missing_selected_specs_individually",
                "reason": "some high-ranked specs were selected but did not produce replay evidence",
                "candidate_spec_ids": [
                    _string(row.get("candidate_spec_id"))
                    for row in selected_but_missing[:8]
                    if _string(row.get("candidate_spec_id"))
                ],
            }
        )
    promotion_proof_failures = (
        "shadow_parity_status_not_within_budget",
        "executable_replay_not_passed",
        "executable_replay_artifact_missing",
        "executable_replay_order_count_below_oracle",
        "executable_replay_account_buying_power_missing",
        "executable_replay_max_notional_missing",
        "executable_replay_notional_exceeds_buying_power",
        "market_impact_stress_passed_failed",
        "market_impact_stress_artifact_present_failed",
        "market_impact_liquidity_evidence_present_failed",
        "market_impact_stress_model_failed",
        "market_impact_stress_cost_bps_failed",
        "market_impact_stress_net_pnl_per_day_failed",
        "delay_adjusted_depth_stress_passed_failed",
        "delay_adjusted_depth_stress_artifact_present_failed",
        "delay_adjusted_depth_stress_model_failed",
        "delay_adjusted_depth_stress_ms_failed",
        "delay_adjusted_depth_fillable_notional_per_day_failed",
        "delay_adjusted_depth_stress_net_pnl_per_day_failed",
        "double_oos_passed_failed",
        "double_oos_artifact_present_failed",
        "double_oos_independent_window_count_failed",
        "double_oos_pass_rate_failed",
        "double_oos_net_pnl_per_day_failed",
        "double_oos_cost_shock_net_pnl_per_day_failed",
    )
    proof_failure_counts = {
        reason: count
        for reason, count in failure_counts.items()
        if reason in promotion_proof_failures
    }
    non_proof_failure_counts = {
        reason: count
        for reason, count in failure_counts.items()
        if reason not in promotion_proof_failures
    }
    if proof_failure_counts:
        proof_action: dict[str, Any] = {
            "priority": 3 if not non_proof_failure_counts else 7,
            "action": "complete_runtime_closure_double_oos_and_shadow_evidence",
            "reason": (
                "replayed candidates are missing runtime-closure double-OOS, cost-stressed, executable replay, or shadow evidence required by the oracle"
                if not non_proof_failure_counts
                else "runtime-closure double-OOS and promotion evidence is required, but current candidates still fail profit or risk gates"
            ),
            "blocking_failure_counts": proof_failure_counts,
            "required_scorecard_fields": [
                "shadow_parity_status",
                "executable_replay_passed",
                "executable_replay_artifact_ref",
                "executable_replay_order_count",
                "executable_replay_account_buying_power",
                "executable_replay_max_notional_per_trade",
                "market_impact_stress_passed",
                "market_impact_stress_artifact_ref",
                "market_impact_liquidity_evidence_present",
                "market_impact_stress_model",
                "market_impact_stress_cost_bps",
                "market_impact_stress_net_pnl_per_day",
                "delay_adjusted_depth_stress_passed",
                "delay_adjusted_depth_stress_artifact_ref",
                "delay_adjusted_depth_stress_model",
                "delay_adjusted_depth_stress_ms",
                "delay_adjusted_depth_fillable_notional_per_day",
                "delay_adjusted_depth_stress_net_pnl_per_day",
                "double_oos_passed",
                "double_oos_artifact_ref",
                "double_oos_independent_window_count",
                "double_oos_pass_rate",
                "double_oos_net_pnl_per_day",
                "double_oos_cost_shock_net_pnl_per_day",
            ],
        }
        if non_proof_failure_counts:
            proof_action["deferred_until"] = (
                "portfolio_profit_and_risk_oracle_failures_clear"
            )
            proof_action["blocked_by_non_proof_failure_counts"] = dict(
                sorted(non_proof_failure_counts.items())
            )
        next_actions.append(proof_action)
    if any(
        reason in failure_counts
        for reason in (
            "active_day_ratio_below_oracle",
            "positive_day_ratio_below_oracle",
        )
    ):
        if candidate_surface_exhausted or replayable_candidate_surface_exhausted:
            selected_families = sorted(
                {
                    _string(row.get("family_template_id"))
                    for row in selected_rows
                    if _string(row.get("family_template_id"))
                }
            )
            next_actions.append(
                {
                    "priority": 4,
                    "action": "expand_execution_profile_surface",
                    "reason": (
                        (
                            "candidate selection replayed every currently eligible execution signature; "
                            "pre-replay feedback, capital, or expected-value gates blocked the rest"
                        )
                        if replayable_candidate_surface_exhausted
                        and not candidate_surface_exhausted
                        else (
                            "candidate selection replayed every unique execution signature; "
                            "max-candidates, top-k, and exploration-slots are no longer binding"
                        )
                    ),
                    "observed_selection_budget": observed_selection_budget,
                    "target_family_template_ids": selected_families,
                    "recommended_code_change": (
                        "add risk-diversified execution profiles, sleeves, or family mappings "
                        "before spending another epoch on wider selection flags"
                    ),
                }
            )
        else:
            next_top_k = min(
                max(1, current_max_candidates),
                max(16, current_top_k + max(4, current_exploration_slots)),
            )
            next_exploration_slots = min(
                max(1, current_max_candidates),
                max(8, current_exploration_slots + max(4, current_exploration_slots)),
            )
            next_max_candidates = max(
                current_max_candidates,
                next_top_k + next_exploration_slots,
                min(128, current_max_candidates + 32),
            )
            recommended_flags = {
                "--max-candidates": str(next_max_candidates),
                "--top-k": str(next_top_k),
                "--exploration-slots": str(next_exploration_slots),
                "--portfolio-size-min": str(max(3, current_portfolio_size_min)),
            }
            if current_max_total_frontier_candidates > 0:
                recommended_flags["--max-total-frontier-candidates"] = str(
                    max(
                        current_max_total_frontier_candidates,
                        min(128, current_max_total_frontier_candidates * 2),
                    )
                )
            next_actions.append(
                {
                    "priority": 4,
                    "action": "increase_breadth_and_portfolio_diversity",
                    "reason": "replayed candidates had flat or non-positive days",
                    "recommended_flags": recommended_flags,
                }
            )
    if any(
        reason in failure_counts
        for reason in (
            "non_positive_net_pnl_per_day",
            "worst_day_loss_above_oracle",
            "max_drawdown_above_oracle",
        )
    ):
        next_actions.append(
            {
                "priority": 5,
                "action": "pivot_family_mix_away_from_failed_exposures",
                "reason": "partial replay evidence failed profit or risk gates",
                "recommended_review_fields": [
                    "family_template_id",
                    "runtime_strategy_name",
                    "daily_net",
                    "symbol_contribution_shares",
                ],
            }
        )
    if best_false_negative_table:
        next_actions.append(
            {
                "priority": 6,
                "action": "expand_exploration_for_unreplayed_high_ranked_specs",
                "reason": "ranked specs were not replayed because of budget",
                "candidate_spec_ids": [
                    _string(row.get("candidate_spec_id"))
                    for row in _list_of_mappings(list(best_false_negative_table))[:8]
                    if _string(row.get("candidate_spec_id"))
                ],
            }
        )
    if not next_actions:
        next_actions.append(
            {
                "priority": 1,
                "action": "inspect_partial_artifacts_before_next_epoch",
                "reason": "failure did not match a known replay remediation pattern",
            }
        )

    next_actions.sort(key=lambda row: int(row.get("priority") or 10**6))
    return {
        "schema_version": "torghut.whitepaper-autoresearch-remediation.v1",
        "failure_reason": failure_reason,
        "partial_evidence_bundle_count": len(evidence_bundles),
        "selected_for_replay_count": len(selected_rows),
        "selected_missing_evidence_count": len(selected_but_missing),
        "failure_reason_counts": dict(sorted(failure_counts.items())),
        "partial_scorecards": partial_scorecards,
        "candidate_surface_exhausted": candidate_surface_exhausted,
        "replayable_candidate_surface_exhausted": replayable_candidate_surface_exhausted,
        "observed_selection_budget": observed_selection_budget,
        "recent_trading_days": recent_day_diagnostics,
        "stale_tape": stale_tape,
        "next_actions": next_actions,
    }


def _string_list_from_value(value: Any) -> list[str]:
    if not isinstance(value, Sequence) or isinstance(value, str):
        return []
    rows = cast(Sequence[Any], value)
    return [text for item in rows if (text := _string(item))]


def _selected_candidate_spec_ids(
    candidate_selection: Mapping[str, Any],
) -> set[str]:
    explicit_ids = set(
        _string_list_from_value(candidate_selection.get("selected_candidate_spec_ids"))
    )
    selected_rows = {
        _string(row.get("candidate_spec_id"))
        for row in _list_of_mappings(candidate_selection.get("rows"))
        if bool(row.get("selected_for_replay"))
        and _string(row.get("candidate_spec_id"))
    }
    return explicit_ids | selected_rows


def _candidate_family_goal_rows(
    *,
    candidate_specs: Sequence[CandidateSpec],
    candidate_selection: Mapping[str, Any],
    evidence_bundles: Sequence[CandidateEvidenceBundle],
) -> list[dict[str, Any]]:
    selected_ids = _selected_candidate_spec_ids(candidate_selection)
    evidence_by_spec = {bundle.candidate_spec_id: bundle for bundle in evidence_bundles}
    rows_by_family: dict[str, dict[str, Any]] = {}
    for spec in candidate_specs:
        family_id = spec.family_template_id
        row = rows_by_family.setdefault(
            family_id,
            {
                "family_template_id": family_id,
                "runtime_families": set(),
                "runtime_strategy_names": set(),
                "candidate_spec_count": 0,
                "selected_for_replay_count": 0,
                "evidence_bundle_count": 0,
                "sample_candidate_spec_ids": [],
                "sample_selected_candidate_spec_ids": [],
            },
        )
        row["candidate_spec_count"] = int(row["candidate_spec_count"]) + 1
        cast(set[str], row["runtime_families"]).add(spec.runtime_family)
        cast(set[str], row["runtime_strategy_names"]).add(spec.runtime_strategy_name)
        if len(cast(list[str], row["sample_candidate_spec_ids"])) < 3:
            cast(list[str], row["sample_candidate_spec_ids"]).append(
                spec.candidate_spec_id
            )
        if spec.candidate_spec_id in selected_ids:
            row["selected_for_replay_count"] = int(row["selected_for_replay_count"]) + 1
            if len(cast(list[str], row["sample_selected_candidate_spec_ids"])) < 3:
                cast(list[str], row["sample_selected_candidate_spec_ids"]).append(
                    spec.candidate_spec_id
                )
        if spec.candidate_spec_id in evidence_by_spec:
            row["evidence_bundle_count"] = int(row["evidence_bundle_count"]) + 1

    payload_rows: list[dict[str, Any]] = []
    for row in rows_by_family.values():
        payload_rows.append(
            {
                **row,
                "runtime_families": sorted(cast(set[str], row["runtime_families"])),
                "runtime_strategy_names": sorted(
                    cast(set[str], row["runtime_strategy_names"])
                ),
            }
        )
    payload_rows.sort(
        key=lambda row: (
            -int(row.get("selected_for_replay_count") or 0),
            -int(row.get("candidate_spec_count") or 0),
            _string(row.get("family_template_id")),
        )
    )
    return payload_rows


def _candidate_sleeve_goal_proof_handoff_fields(
    *,
    selection: Mapping[str, Any],
    spec: CandidateSpec | None,
    scorecard: Mapping[str, Any],
    evidence: CandidateEvidenceBundle | None,
    selected_for_replay: bool,
) -> dict[str, Any]:
    artifact_refs = list(evidence.replay_artifact_refs) if evidence is not None else []
    runtime_ledger_row = {**dict(scorecard), "replay_artifact_refs": artifact_refs}
    runtime_ledger_artifact_refs = _candidate_board_runtime_ledger_refs(
        runtime_ledger_row
    )
    exact_replay_ledger_artifact_ref = _string(
        scorecard.get("exact_replay_ledger_artifact_ref")
    )
    runtime_ledger_artifact_ref = _string(
        scorecard.get("runtime_ledger_artifact_ref") or exact_replay_ledger_artifact_ref
    )
    runtime_window_start, runtime_window_end = _candidate_board_runtime_window_bounds(
        scorecard
    )
    paper_contract_prior_score = _string(selection.get("paper_contract_prior_score"))
    if not paper_contract_prior_score and spec is not None:
        paper_contract_prior_score = str(_paper_mechanism_prior_score(spec))
    paper_mechanism_overlay_ids = _string_list_from_value(
        selection.get("paper_mechanism_overlay_ids")
    )
    if not paper_mechanism_overlay_ids and spec is not None:
        paper_mechanism_overlay_ids = sorted(
            _candidate_spec_mechanism_overlay_ids(spec)
        )
    paper_required_evidence_tokens = _string_list_from_value(
        selection.get("paper_required_evidence_tokens")
    )
    if not paper_required_evidence_tokens and spec is not None:
        paper_required_evidence_tokens = sorted(
            _candidate_spec_required_evidence_tokens(spec)
        )
    paper_required_evidence_count = _candidate_board_int_field(
        selection, "paper_required_evidence_count"
    )
    if paper_required_evidence_count <= 0:
        paper_required_evidence_count = len(paper_required_evidence_tokens)
    paper_contract_candidate = bool(
        _decimal(paper_contract_prior_score) > 0
        or paper_mechanism_overlay_ids
        or paper_required_evidence_tokens
    )
    return {
        "replay_selection_reason": _string(selection.get("selection_reason"))
        or ("selected_for_replay" if selected_for_replay else "not_selected_budget"),
        "paper_contract_candidate": paper_contract_candidate,
        "paper_contract_selected_for_replay": bool(
            selected_for_replay and paper_contract_candidate
        ),
        "paper_contract_prior_score": paper_contract_prior_score,
        "paper_mechanism_overlay_ids": paper_mechanism_overlay_ids,
        "paper_required_evidence_tokens": paper_required_evidence_tokens,
        "paper_required_evidence_count": paper_required_evidence_count,
        "runtime_window_start": runtime_window_start,
        "runtime_window_end": runtime_window_end,
        "runtime_ledger_artifact_refs": list(runtime_ledger_artifact_refs),
        "exact_replay_ledger_artifact_ref": exact_replay_ledger_artifact_ref,
        "runtime_ledger_artifact_ref": runtime_ledger_artifact_ref,
        "runtime_ledger_artifact_row_count": _candidate_board_first_int_field(
            scorecard,
            (
                "runtime_ledger_artifact_row_count",
                "exact_replay_ledger_artifact_row_count",
            ),
        ),
        "runtime_ledger_artifact_fill_count": _candidate_board_first_int_field(
            scorecard,
            (
                "runtime_ledger_artifact_fill_count",
                "exact_replay_ledger_artifact_fill_count",
            ),
        ),
    }


def _candidate_sleeve_goal_rows(
    *,
    candidate_specs: Sequence[CandidateSpec],
    candidate_selection: Mapping[str, Any],
    evidence_bundles: Sequence[CandidateEvidenceBundle],
    false_positive_table: Sequence[Mapping[str, Any]],
    best_false_negative_table: Sequence[Mapping[str, Any]],
    portfolio: PortfolioCandidateSpec | None,
    limit: int = 16,
) -> list[dict[str, Any]]:
    spec_by_id = {spec.candidate_spec_id: spec for spec in candidate_specs}
    evidence_by_spec = {bundle.candidate_spec_id: bundle for bundle in evidence_bundles}
    selection_by_spec = {
        _string(row.get("candidate_spec_id")): row
        for row in _list_of_mappings(candidate_selection.get("rows"))
        if _string(row.get("candidate_spec_id"))
    }
    if portfolio is not None:
        rows: list[dict[str, Any]] = []
        for sleeve in portfolio.sleeves[:limit]:
            row = dict(sleeve)
            candidate_spec_id = _string(row.get("candidate_spec_id"))
            spec = spec_by_id.get(candidate_spec_id)
            evidence = evidence_by_spec.get(candidate_spec_id)
            scorecard = evidence.objective_scorecard if evidence is not None else {}
            selection = selection_by_spec.get(candidate_spec_id, {})
            if spec is not None:
                row["family_template_id"] = spec.family_template_id
                row["runtime_family"] = spec.runtime_family
                row["runtime_strategy_name"] = spec.runtime_strategy_name
                row["market_impact_proof"] = (
                    _candidate_board_market_impact_proof_summary(scorecard)
                )
                row["regime_specialist_validation"] = (
                    _candidate_board_regime_specialist_summary(spec, scorecard)
                )
                row["order_type_execution_quality"] = (
                    _candidate_board_order_type_execution_quality_summary(
                        spec, scorecard
                    )
                )
                row["queue_position_survival_fill_quality"] = (
                    _candidate_board_queue_position_survival_summary(spec, scorecard)
                )
            row["evidence_status"] = "replayed" if evidence is not None else "missing"
            row["evidence_lineage"] = _candidate_board_evidence_lineage_summary(
                evidence
            )
            row["replay_window_coverage"] = (
                _candidate_board_replay_window_coverage_summary(scorecard)
            )
            row["replay_artifact_refs"] = (
                list(evidence.replay_artifact_refs) if evidence is not None else []
            )
            row.update(
                _candidate_sleeve_goal_proof_handoff_fields(
                    selection=selection,
                    spec=spec,
                    scorecard=scorecard,
                    evidence=evidence,
                    selected_for_replay=True,
                )
            )
            rows.append(row)
        return rows

    failure_by_spec = {
        _string(row.get("candidate_spec_id")): list(
            cast(Sequence[Any], row.get("failure_reasons") or ())
        )
        for row in _list_of_mappings(list(false_positive_table))
        if _string(row.get("candidate_spec_id"))
    }
    rows: list[dict[str, Any]] = []
    for selection in _list_of_mappings(candidate_selection.get("rows")):
        candidate_spec_id = _string(selection.get("candidate_spec_id"))
        if not candidate_spec_id or not bool(selection.get("selected_for_replay")):
            continue
        spec = spec_by_id.get(candidate_spec_id)
        evidence = evidence_by_spec.get(candidate_spec_id)
        scorecard = evidence.objective_scorecard if evidence is not None else {}
        order_type_summary = (
            _candidate_board_order_type_execution_quality_summary(spec, scorecard)
            if spec is not None
            else {"required": False, "passed": True, "blockers": []}
        )
        queue_position_survival_summary = (
            _candidate_board_queue_position_survival_summary(spec, scorecard)
            if spec is not None
            else {"required": False, "passed": True, "blockers": []}
        )
        evidence_lineage = _candidate_board_evidence_lineage_summary(evidence)
        replay_window_coverage = _candidate_board_replay_window_coverage_summary(
            scorecard
        )
        proof_handoff = _candidate_sleeve_goal_proof_handoff_fields(
            selection=selection,
            spec=spec,
            scorecard=scorecard,
            evidence=evidence,
            selected_for_replay=True,
        )
        rows.append(
            {
                "candidate_spec_id": candidate_spec_id,
                "candidate_id": evidence.candidate_id if evidence is not None else None,
                "family_template_id": spec.family_template_id
                if spec is not None
                else None,
                "runtime_family": spec.runtime_family if spec is not None else None,
                "runtime_strategy_name": spec.runtime_strategy_name
                if spec is not None
                else None,
                "rank": _rank_sort_value(selection.get("rank")),
                "pre_replay_score": _string(selection.get("pre_replay_score")),
                "evidence_status": "replayed" if evidence is not None else "missing",
                "net_pnl_per_day": _string(scorecard.get("net_pnl_per_day")),
                "active_day_ratio": _string(scorecard.get("active_day_ratio")),
                "positive_day_ratio": _string(scorecard.get("positive_day_ratio")),
                "replay_artifact_refs": list(evidence.replay_artifact_refs)
                if evidence is not None
                else [],
                "evidence_lineage": evidence_lineage,
                "replay_window_coverage": replay_window_coverage,
                "order_type_execution_quality": order_type_summary,
                "queue_position_survival_fill_quality": (
                    queue_position_survival_summary
                ),
                **proof_handoff,
                "failure_reasons": [
                    _string(item)
                    for item in failure_by_spec.get(candidate_spec_id, ())
                    if _string(item)
                ],
            }
        )
        if len(rows) >= limit:
            break

    if len(rows) < limit:
        for row in _list_of_mappings(list(best_false_negative_table)):
            candidate_spec_id = _string(row.get("candidate_spec_id"))
            if not candidate_spec_id:
                continue
            spec = spec_by_id.get(candidate_spec_id)
            selection = selection_by_spec.get(candidate_spec_id, row)
            rows.append(
                {
                    "candidate_spec_id": candidate_spec_id,
                    "candidate_id": None,
                    "family_template_id": spec.family_template_id
                    if spec is not None
                    else None,
                    "runtime_family": spec.runtime_family if spec is not None else None,
                    "runtime_strategy_name": spec.runtime_strategy_name
                    if spec is not None
                    else None,
                    "rank": _rank_sort_value(row.get("rank")),
                    "pre_replay_score": _string(row.get("pre_replay_score")),
                    "evidence_status": "not_replayed",
                    "reason": _string(row.get("reason")) or "not_replayed_budget",
                    **_candidate_sleeve_goal_proof_handoff_fields(
                        selection=selection,
                        spec=spec,
                        scorecard={},
                        evidence=None,
                        selected_for_replay=False,
                    ),
                    "failure_reasons": ["not_replayed_budget"],
                }
            )
            if len(rows) >= limit:
                break
    return rows


def _profitability_system_change_backlog(
    *,
    oracle_candidate_found: bool,
    status_reason: str | None,
    remediation: Mapping[str, Any] | None,
    promotion_blockers: Sequence[str],
    replay_mode: str,
) -> list[dict[str, Any]]:
    backlog: list[dict[str, Any]] = []
    for action in _list_of_mappings(
        remediation.get("next_actions") if remediation else []
    ):
        backlog.append(
            {
                "priority": int(action.get("priority") or len(backlog) + 1),
                "scope": "autoresearch_pipeline",
                "change": _string(action.get("action"))
                or "inspect_autoresearch_artifacts",
                "reason": _string(action.get("reason")),
                "recommended_flags": dict(_mapping(action.get("recommended_flags"))),
                "candidate_spec_ids": _string_list_from_value(
                    action.get("candidate_spec_ids")
                ),
                "blocking_failure_counts": dict(
                    _mapping(action.get("blocking_failure_counts"))
                ),
            }
        )
    if replay_mode != "real":
        backlog.append(
            {
                "priority": len(backlog) + 1,
                "scope": "replay_evidence",
                "change": "rerun_with_real_replay_before_any_promotion",
                "reason": "synthetic replay is only a pipeline smoke test and cannot establish standalone profitability",
                "recommended_flags": {"--replay-mode": "real"},
            }
        )
    if not oracle_candidate_found and status_reason:
        backlog.append(
            {
                "priority": len(backlog) + 1,
                "scope": "portfolio_oracle",
                "change": "continue_search_until_portfolio_oracle_passes",
                "reason": status_reason,
                "required_result": "portfolio oracle passes the configured daily target without relaxing gates",
            }
        )
    if promotion_blockers:
        backlog.append(
            {
                "priority": len(backlog) + 1,
                "scope": "runtime_closure",
                "change": "produce_runtime_closure_and_shadow_promotion_evidence",
                "reason": "candidate evidence is not enough for standalone trading",
                "promotion_blockers": list(promotion_blockers),
            }
        )
    backlog.append(
        {
            "priority": len(backlog) + 1,
            "scope": "live_submission_controls",
            "change": "keep_live_submission_disabled_until_profit_and_promotion_gates_pass",
            "reason": "standalone money-making requires evidence first, then explicit deployer approval; no gate bypass",
        }
    )
    backlog.sort(key=lambda row: int(row.get("priority") or 10**6))
    return backlog


def _profitability_next_epoch_flags(
    *,
    args: argparse.Namespace,
    target: Decimal,
    remediation: Mapping[str, Any] | None,
) -> dict[str, str]:
    return cast(
        dict[str, str],
        _profitability_next_epoch_plan(
            args=args, target=target, remediation=remediation
        )["flags"],
    )


def _int_arg(args: argparse.Namespace, name: str, default: int) -> int:
    try:
        return int(getattr(args, name, default) or default)
    except (TypeError, ValueError):
        return default


def _flag_int(value: Any) -> int | None:
    text = _string(value)
    if not text:
        return None
    try:
        return int(text)
    except ValueError:
        return None


def _unsafe_next_epoch_remediation_flag(key: str) -> bool:
    normalized = key.strip().lower()
    return any(
        marker in normalized for marker in _UNSAFE_NEXT_EPOCH_REMEDIATION_FLAG_MARKERS
    )


def _decimal_arg_or_default(
    args: argparse.Namespace,
    name: str,
    default: Decimal,
) -> Decimal:
    raw_value = getattr(args, name, None)
    if raw_value is None or _string(raw_value) == "":
        return default
    return _decimal(raw_value, default=str(default))


def _profitability_next_epoch_plan(
    *,
    args: argparse.Namespace,
    target: Decimal,
    remediation: Mapping[str, Any] | None,
) -> dict[str, Any]:
    direct_candidate_specs_artifacts = [
        str(path)
        for path in cast(Sequence[Path], getattr(args, "candidate_specs", ()) or ())
        if str(path)
    ]
    flags: dict[str, str] = {
        "--target-net-pnl-per-day": str(target),
        "--program": str(getattr(args, "program", _DEFAULT_PORTFOLIO_PROFIT_PROGRAM)),
        "--replay-mode": "real",
        "--max-candidates": str(max(64, _int_arg(args, "max_candidates", 64))),
        "--top-k": str(max(16, _int_arg(args, "top_k", 16))),
        "--exploration-slots": str(max(8, _int_arg(args, "exploration_slots", 8))),
        "--feedback-block-reaudit-slots": str(
            max(0, _int_arg(args, "feedback_block_reaudit_slots", 0))
        ),
        "--portfolio-size-min": str(max(2, _int_arg(args, "portfolio_size_min", 2))),
        "--portfolio-size-max": str(max(8, _int_arg(args, "portfolio_size_max", 8))),
        "--max-frontier-candidates-per-spec": str(
            max(
                1,
                _int_arg(
                    args,
                    "max_frontier_candidates_per_spec",
                    _DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC,
                ),
            )
        ),
    }
    max_total_frontier_candidates = _int_arg(args, "max_total_frontier_candidates", 0)
    if max_total_frontier_candidates > 0:
        flags["--max-total-frontier-candidates"] = str(max_total_frontier_candidates)
    real_replay_timeout_seconds = _int_arg(args, "real_replay_timeout_seconds", 0)
    if real_replay_timeout_seconds > 0:
        flags["--real-replay-timeout-seconds"] = str(real_replay_timeout_seconds)
    real_replay_shard_size = _int_arg(args, "real_replay_shard_size", 0)
    if real_replay_shard_size > 0:
        flags["--real-replay-shard-size"] = str(real_replay_shard_size)
    requested_real_replay_shard_timeout_seconds = _int_arg(
        args,
        "real_replay_shard_timeout_seconds",
        _DEFAULT_REAL_REPLAY_SHARD_TIMEOUT_SECONDS,
    )
    real_replay_shard_timeout_seconds = _bounded_real_replay_shard_timeout_seconds(
        requested_real_replay_shard_timeout_seconds
    )
    if real_replay_shard_timeout_seconds > 0:
        flags["--real-replay-shard-timeout-seconds"] = str(
            real_replay_shard_timeout_seconds
        )
    capped_runtime_flags: list[dict[str, str]] = []
    if requested_real_replay_shard_timeout_seconds != real_replay_shard_timeout_seconds:
        capped_runtime_flags.append(
            {
                "flag": "--real-replay-shard-timeout-seconds",
                "requested_value": str(requested_real_replay_shard_timeout_seconds),
                "capped_value": str(real_replay_shard_timeout_seconds),
                "reason": "capped_to_local_shard_timeout_no_cluster_fanout",
            }
        )
    requested_real_replay_shard_workers = _int_arg(
        args, "real_replay_shard_workers", _DEFAULT_REAL_REPLAY_SHARD_WORKERS
    )
    real_replay_shard_workers = max(
        1,
        min(
            requested_real_replay_shard_workers,
            _DEFAULT_REAL_REPLAY_SHARD_WORKERS,
        ),
    )
    if real_replay_shard_workers != requested_real_replay_shard_workers:
        capped_runtime_flags.append(
            {
                "flag": "--real-replay-shard-workers",
                "requested_value": str(requested_real_replay_shard_workers),
                "capped_value": str(real_replay_shard_workers),
                "reason": "capped_to_local_worker_limit_no_kubernetes_fanout",
            }
        )
    if real_replay_shard_workers > 1:
        flags["--real-replay-shard-workers"] = str(real_replay_shard_workers)
    real_replay_failed_spec_retries = _int_arg(
        args, "real_replay_failed_spec_retries", 1
    )
    if real_replay_failed_spec_retries > 0:
        flags["--real-replay-failed-spec-retries"] = str(
            real_replay_failed_spec_retries
        )
    real_replay_retry_timeout_seconds = _int_arg(
        args, "real_replay_retry_timeout_seconds", 0
    )
    if real_replay_retry_timeout_seconds > 0:
        flags["--real-replay-retry-timeout-seconds"] = str(
            real_replay_retry_timeout_seconds
        )
    real_replay_retry_frontier_candidates = _int_arg(
        args, "real_replay_retry_max_frontier_candidates_per_spec", 1
    )
    if real_replay_retry_frontier_candidates > 1:
        flags["--real-replay-retry-max-frontier-candidates-per-spec"] = str(
            real_replay_retry_frontier_candidates
        )
    shadow_validation_artifact = getattr(args, "shadow_validation_artifact", None)
    if shadow_validation_artifact is not None:
        flags["--shadow-validation-artifact"] = str(shadow_validation_artifact)

    applied_recommended_flags: list[dict[str, str]] = []
    rejected_recommended_flags: list[dict[str, str]] = []
    monotonic_int_flags = {
        "--max-candidates",
        "--top-k",
        "--exploration-slots",
        "--feedback-block-reaudit-slots",
        "--portfolio-size-min",
        "--portfolio-size-max",
        "--max-total-frontier-candidates",
        "--real-replay-timeout-seconds",
    }
    if remediation is not None:
        for action in _list_of_mappings(remediation.get("next_actions")):
            action_name = _string(action.get("action"))
            for key, value in _mapping(action.get("recommended_flags")).items():
                if key.startswith("--") and _string(value):
                    if _unsafe_next_epoch_remediation_flag(key):
                        rejected_recommended_flags.append(
                            {
                                "action": action_name,
                                "flag": key,
                                "current_value": str(flags.get(key, "")),
                                "recommended_value": _string(value),
                                "reason": "rejected_unsafe_cluster_fanout_or_promotion_flag",
                            }
                        )
                        continue
                    current_value = flags.get(key)
                    current_int = _flag_int(current_value)
                    recommended_int = _flag_int(value)
                    if key == "--real-replay-shard-workers" and (
                        recommended_int is None
                        or recommended_int > _DEFAULT_REAL_REPLAY_SHARD_WORKERS
                    ):
                        rejected_recommended_flags.append(
                            {
                                "action": action_name,
                                "flag": key,
                                "current_value": str(current_value or ""),
                                "recommended_value": _string(value),
                                "reason": "rejected_broad_replay_worker_fanout",
                            }
                        )
                        continue
                    if key == "--real-replay-shard-timeout-seconds":
                        if recommended_int is None:
                            rejected_recommended_flags.append(
                                {
                                    "action": action_name,
                                    "flag": key,
                                    "current_value": str(current_value or ""),
                                    "recommended_value": _string(value),
                                    "reason": "rejected_invalid_numeric_remediation_flag",
                                }
                            )
                            continue
                        capped_timeout = _bounded_real_replay_shard_timeout_seconds(
                            recommended_int
                        )
                        if capped_timeout != recommended_int:
                            capped_runtime_flags.append(
                                {
                                    "action": action_name,
                                    "flag": key,
                                    "requested_value": str(recommended_int),
                                    "capped_value": str(capped_timeout),
                                    "reason": "capped_to_local_shard_timeout_no_cluster_fanout",
                                }
                            )
                        flags[key] = str(capped_timeout)
                        applied_recommended_flags.append(
                            {
                                "action": action_name,
                                "flag": key,
                                "value": str(capped_timeout),
                            }
                        )
                        continue
                    if key in monotonic_int_flags and recommended_int is None:
                        rejected_recommended_flags.append(
                            {
                                "action": action_name,
                                "flag": key,
                                "current_value": str(current_value or ""),
                                "recommended_value": _string(value),
                                "reason": "rejected_invalid_numeric_remediation_flag",
                            }
                        )
                        continue
                    if (
                        key in monotonic_int_flags
                        and current_int is not None
                        and recommended_int is not None
                        and recommended_int < current_int
                    ):
                        rejected_recommended_flags.append(
                            {
                                "action": action_name,
                                "flag": key,
                                "current_value": str(current_int),
                                "recommended_value": str(recommended_int),
                                "reason": (
                                    "rejected_to_preserve_or_increase_search_breadth"
                                ),
                            }
                        )
                        continue
                    flags[key] = _string(value)
                    applied_recommended_flags.append(
                        {
                            "action": action_name,
                            "flag": key,
                            "value": _string(value),
                        }
                    )
    argv: list[str] = [
        "python",
        "services/torghut/scripts/run_whitepaper_autoresearch_profit_target.py",
        "--output-dir",
        "<next-epoch-output-dir>",
    ]
    for path in direct_candidate_specs_artifacts:
        argv.extend(["--candidate-specs", path])
    for key, value in flags.items():
        argv.extend([key, value])
    return {
        "entrypoint": "services/torghut/scripts/run_whitepaper_autoresearch_profit_target.py",
        "flags": flags,
        "argv": argv,
        "direct_candidate_specs_artifacts": direct_candidate_specs_artifacts,
        "applied_recommended_flags": applied_recommended_flags,
        "rejected_recommended_flags": rejected_recommended_flags,
        "capped_runtime_flags": capped_runtime_flags,
        "no_fast_path_policy": {
            "target_net_pnl_per_day_is_fixed": str(target),
            "replay_mode": "real",
            "no_kubernetes_fanout": True,
            "max_generated_real_replay_shard_workers": (
                _DEFAULT_REAL_REPLAY_SHARD_WORKERS
            ),
            "monotonic_search_flags": sorted(monotonic_int_flags),
            "unsafe_remediation_flag_markers": sorted(
                _UNSAFE_NEXT_EPOCH_REMEDIATION_FLAG_MARKERS
            ),
            "allowed_decreases": [
                (
                    "timeout remediation may reduce "
                    "--max-frontier-candidates-per-spec only to finish complete evidence"
                )
            ],
        },
    }


def _profitability_search_goal(
    *,
    args: argparse.Namespace,
    output_dir: Path,
    status: str,
    status_reason: str | None,
    target: Decimal,
    program: StrategyAutoresearchProgram,
    sources: Sequence[WhitepaperResearchSource],
    hypothesis_cards: Sequence[HypothesisCard],
    candidate_specs: Sequence[CandidateSpec],
    candidate_selection: Mapping[str, Any],
    pre_replay_model: Mapping[str, Any],
    proposal_model: Mapping[str, Any] | None,
    evidence_bundles: Sequence[CandidateEvidenceBundle],
    false_positive_table: Sequence[Mapping[str, Any]],
    best_false_negative_table: Sequence[Mapping[str, Any]],
    portfolio: PortfolioCandidateSpec | None,
    oracle_candidate_found: bool,
    profit_target_oracle: Mapping[str, Any] | None,
    promotion_blockers: Sequence[str],
    remediation: Mapping[str, Any] | None,
) -> dict[str, Any]:
    replay_mode = _string(getattr(args, "replay_mode", "")) or "real"
    next_epoch_plan = _profitability_next_epoch_plan(
        args=args, target=target, remediation=remediation
    )
    return {
        "schema_version": "torghut.whitepaper-autoresearch-profitability-goal.v1",
        "objective": {
            "target_net_pnl_per_trading_day": str(target),
            "currency": "USD",
            "standalone_system": True,
            "status": status,
            "status_reason": status_reason,
            "oracle_candidate_found": oracle_candidate_found,
            "definition_of_done": [
                "portfolio oracle passes the target without lowering constraints",
                "real replay evidence is complete for selected sleeves",
                "runtime closure writes parity and approval replay evidence",
                "shadow/promotion evidence is persisted before live submission",
                "live submission gate remains blocked until evidence and explicit deployer controls allow it",
            ],
        },
        "candidate_framework": {
            "program_id": program.program_id,
            "program_path": str(
                getattr(args, "program", _DEFAULT_PORTFOLIO_PROFIT_PROGRAM)
            ),
            "replay_mode": replay_mode,
            "source_count": len(sources),
            "claim_count": sum(len(source.claims) for source in sources),
            "hypothesis_count": len(hypothesis_cards),
            "candidate_spec_count": len(candidate_specs),
            "selected_for_replay_count": len(
                _selected_candidate_spec_ids(candidate_selection)
            ),
            "evidence_bundle_count": len(evidence_bundles),
            "portfolio_candidate_count": 1 if portfolio is not None else 0,
            "pre_replay_model": {
                "schema_version": pre_replay_model.get("schema_version"),
                "model_id": pre_replay_model.get("model_id"),
                "backend": pre_replay_model.get("backend"),
                "proposal_stage": pre_replay_model.get("proposal_stage"),
            },
            "post_replay_model": {
                "schema_version": proposal_model.get("schema_version")
                if proposal_model
                else None,
                "model_id": proposal_model.get("model_id") if proposal_model else None,
                "backend": proposal_model.get("backend") if proposal_model else None,
            },
            "families": _candidate_family_goal_rows(
                candidate_specs=candidate_specs,
                candidate_selection=candidate_selection,
                evidence_bundles=evidence_bundles,
            ),
        },
        "sleeve_plan": {
            "source": "portfolio_candidate"
            if portfolio is not None
            else "candidate_selection",
            "rows": _candidate_sleeve_goal_rows(
                candidate_specs=candidate_specs,
                candidate_selection=candidate_selection,
                evidence_bundles=evidence_bundles,
                false_positive_table=false_positive_table,
                best_false_negative_table=best_false_negative_table,
                portfolio=portfolio,
            ),
        },
        "system_change_backlog": _profitability_system_change_backlog(
            oracle_candidate_found=oracle_candidate_found,
            status_reason=status_reason,
            remediation=remediation,
            promotion_blockers=promotion_blockers,
            replay_mode=replay_mode,
        ),
        "no_cheating_contract": {
            "forbidden": [
                "lowering target_net_pnl_per_day to make a candidate pass",
                "relaxing oracle, replay, drawdown, contribution, or promotion gates without a separate reviewed code change",
                "treating synthetic replay as production proof",
                "editing live strategy configuration inside an autoresearch epoch",
                "enabling live submission before promotion evidence and deployer approval exist",
            ],
            "program_forbidden_mutations": list(program.forbidden_mutations),
            "promotion_policy": program.promotion_policy,
        },
        "recommended_next_epoch": next_epoch_plan,
        "profit_target_oracle": dict(profit_target_oracle or {}),
        "candidate_search_remediation": dict(remediation or {}),
        "artifacts": {
            "candidate_selection_manifest": str(
                output_dir / "candidate-selection-manifest.json"
            ),
            "candidate_specs": str(output_dir / "candidate-specs.jsonl"),
            "candidate_evidence_bundles": str(
                output_dir / "candidate-evidence-bundles.jsonl"
            ),
            "portfolio_candidates": str(output_dir / "portfolio-candidates.jsonl"),
            "candidate_search_remediation": str(
                output_dir / "candidate-search-remediation.json"
            )
            if remediation is not None
            else None,
            "summary": str(output_dir / "summary.json"),
        },
    }


def _pre_replay_candidate_score(spec: CandidateSpec) -> Decimal:
    family_score = {
        "microbar_cross_sectional_pairs_v1": Decimal("70"),
        "intraday_tsmom_v2": Decimal("68"),
        "late_day_continuation_v1": Decimal("62"),
        "momentum_pullback_v1": Decimal("60"),
        "washout_rebound_v2": Decimal("55"),
        "microstructure_continuation_matched_filter_v1": Decimal("53"),
        "opening_drive_leader_reclaim_v1": Decimal("52"),
        "breakout_reclaim_v2": Decimal("50"),
        "end_of_day_reversal_v1": Decimal("48"),
        "mean_reversion_rebound_v1": Decimal("45"),
    }.get(spec.family_template_id, Decimal("40"))
    required_features = spec.feature_contract.get("required_features")
    feature_count = (
        len(cast(Sequence[Any], required_features))
        if isinstance(required_features, Sequence)
        and not isinstance(required_features, str)
        else 0
    )
    failure_penalty = Decimal(len(spec.expected_failure_modes)) * Decimal("0.25")
    capital_penalty = Decimal(
        str(capital_budget_penalty(candidate_spec_capital_features(spec)))
    )
    return (
        family_score
        + Decimal(feature_count)
        + _paper_mechanism_prior_score(spec)
        - failure_penalty
        - capital_penalty
    )


def _candidate_spec_mechanism_overlay_ids(spec: CandidateSpec) -> set[str]:
    overlay_ids = set(
        _string_list_from_value(spec.parameter_space.get("mechanism_overlay_ids"))
    )
    for overlay in _sequence_of_mappings(
        spec.feature_contract.get("mechanism_overlays")
    ):
        overlay_id = _string(overlay.get("overlay_id"))
        if overlay_id:
            overlay_ids.add(overlay_id)
    return overlay_ids


def _candidate_spec_required_evidence_tokens(spec: CandidateSpec) -> set[str]:
    tokens: set[str] = set()
    contract_rows = (
        *_sequence_of_mappings(spec.feature_contract.get("source_claims")),
        *_sequence_of_mappings(spec.feature_contract.get("validation_requirements")),
        *_sequence_of_mappings(spec.feature_contract.get("mechanism_overlays")),
    )
    for row in contract_rows:
        for key in ("data_requirements", "required_evidence"):
            tokens.update(
                _string(item) for item in _string_list_from_value(row.get(key))
            )
    for key, value in spec.promotion_contract.items():
        if key.startswith("requires_") and _boolish(value):
            tokens.add(key.removeprefix("requires_"))
    return {token for token in tokens if token}


def _paper_mechanism_prior_score(spec: CandidateSpec) -> Decimal:
    source_claims = _sequence_of_mappings(spec.feature_contract.get("source_claims"))
    validation_requirements = _sequence_of_mappings(
        spec.feature_contract.get("validation_requirements")
    )
    overlay_ids = _candidate_spec_mechanism_overlay_ids(spec)
    evidence_tokens = _candidate_spec_required_evidence_tokens(spec)
    promotion_requires_count = sum(
        1
        for key, value in spec.promotion_contract.items()
        if key.startswith("requires_") and _boolish(value)
    )
    promotion_rejects_count = sum(
        1
        for key, value in spec.promotion_contract.items()
        if key.startswith("rejects_") and _boolish(value)
    )
    score = (
        Decimal(min(len(source_claims), 8)) * Decimal("1.25")
        + Decimal(min(len(validation_requirements), 5)) * Decimal("2")
        + Decimal(min(promotion_requires_count, 8)) * Decimal("1.5")
        + Decimal(min(promotion_rejects_count, 6)) * Decimal("0.75")
    )
    for overlay_id in sorted(overlay_ids):
        score += _PAPER_MECHANISM_PRIOR_WEIGHTS.get(overlay_id, Decimal("1"))
    for token in sorted(evidence_tokens):
        score += _PAPER_EVIDENCE_REQUIREMENT_PRIOR_WEIGHTS.get(token, Decimal("0"))
    return min(_PAPER_MECHANISM_PRIOR_SCORE_CAP, score)


def _candidate_spec_universe_key(spec: CandidateSpec) -> str:
    universe = spec.strategy_overrides.get("universe_symbols")
    if not isinstance(universe, Sequence) or isinstance(universe, str):
        return ""
    return ",".join(sorted(_string(item).upper() for item in universe if _string(item)))


def _candidate_spec_signal_key(spec: CandidateSpec) -> str:
    params = _mapping(spec.strategy_overrides.get("params"))
    return "|".join(
        part
        for part in (
            _string(params.get("signal_motif")),
            _string(params.get("selection_mode")),
            _string(params.get("rank_feature")),
        )
        if part
    )


def _candidate_spec_is_false_negative_rescue(spec: CandidateSpec) -> bool:
    params = _mapping(spec.strategy_overrides.get("params"))
    overlays = spec.parameter_space.get("mechanism_overlay_ids", ())
    overlay_ids = set(_string_list_from_value(overlays))
    return (
        "rejected_signal_outcome_calibration" in overlay_ids
        and _string(params.get("veto_relaxation_scope"))
        == "labeled_false_negative_only"
        and _string(params.get("outcome_label_filter")) == "profitable_after_costs"
    )


def _candidate_spec_requires_rejected_signal_outcome_learning(
    spec: CandidateSpec,
) -> bool:
    overlays = spec.parameter_space.get("mechanism_overlay_ids", ())
    overlay_ids = set(_string_list_from_value(overlays))
    return (
        "rejected_signal_outcome_calibration" in overlay_ids
        or _boolish(
            spec.promotion_contract.get("requires_rejected_signal_outcome_learning")
        )
        or "required_min_rejected_signal_outcome_label_count" in spec.hard_vetoes
    )


_LOSS_ADAPTIVE_FEEDBACK_REMEDIATION_PROFILES = frozenset(
    {"adverse_selection_feedback_escape"}
)


def _candidate_spec_is_loss_adaptive_feedback_escape(spec: CandidateSpec) -> bool:
    params = _mapping(spec.strategy_overrides.get("params"))
    return (
        _string(params.get("feedback_remediation_profile"))
        in _LOSS_ADAPTIVE_FEEDBACK_REMEDIATION_PROFILES
    )


def _candidate_spec_active_loss_counter_tags(spec: CandidateSpec) -> set[str]:
    params = _mapping(spec.strategy_overrides.get("params"))
    profile = _string(params.get("feedback_remediation_profile"))
    if profile == "daily_coverage_feedback_escape":
        return {"daily_coverage_shortfall"}
    if profile in {
        "turnover_coverage_feedback_escape",
        "notional_throughput_feedback_escape",
    }:
        return {"notional_throughput_shortfall"}
    if profile == "consistency_guard_feedback_escape":
        return {"loss_control_shortfall"}
    if profile == "symbol_diversification_feedback_escape":
        return {"symbol_concentration_shortfall"}
    if profile == "adverse_selection_feedback_escape":
        return {
            "daily_coverage_shortfall",
            "notional_throughput_shortfall",
            "loss_control_shortfall",
            "adverse_selection_shortfall",
        }
    return set()


def _feedback_active_loss_counter_candidate_reasons(
    scorecard: Mapping[str, Any],
    *,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> set[str]:
    if not scorecard or _feedback_has_no_replay_activity(scorecard):
        return set()
    policy = oracle_policy or ProfitTargetOraclePolicy()
    if (
        _decimal(scorecard.get("max_gross_exposure_pct_equity"))
        > policy.max_gross_exposure_pct_equity
    ):
        return set()
    if _decimal(scorecard.get("min_cash")) < policy.min_cash:
        return set()
    if _decimal(scorecard.get("negative_cash_observation_count")) > Decimal(
        max(0, policy.max_negative_cash_observation_count)
    ):
        return set()
    if not (
        _feedback_has_nonpositive_expected_value(scorecard)
        or _feedback_daily_net_has_loss(scorecard)
    ):
        return set()
    reasons = {"adverse_selection_shortfall"}
    if (
        _decimal(scorecard.get("active_day_ratio"), default="1")
        < policy.min_active_day_ratio
    ):
        reasons.add("daily_coverage_shortfall")
    if (
        _decimal(scorecard.get("avg_filled_notional_per_day"))
        < policy.min_avg_filled_notional_per_day
    ):
        reasons.add("notional_throughput_shortfall")
    if (
        _decimal(scorecard.get("positive_day_ratio"), default="1")
        < policy.min_positive_day_ratio
        or _decimal(scorecard.get("negative_day_count")) > Decimal("0")
        or _decimal(scorecard.get("worst_day_loss")) > Decimal("0")
        or _decimal(scorecard.get("max_drawdown")) > Decimal("0")
    ):
        reasons.add("loss_control_shortfall")
    if (
        _decimal(scorecard.get("max_single_symbol_contribution_share"), default="0")
        > policy.max_single_symbol_contribution_share
        or _decimal(scorecard.get("symbol_concentration_share"), default="0")
        > policy.max_single_symbol_contribution_share
        or _decimal(scorecard.get("max_cluster_contribution_share"), default="0")
        > policy.max_cluster_contribution_share
    ):
        reasons.add("symbol_concentration_shortfall")
    return reasons


def _candidate_spec_matches_active_loss_counter_feedback(
    spec: CandidateSpec,
    scorecard: Mapping[str, Any],
    *,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> bool:
    candidate_tags = _candidate_spec_active_loss_counter_tags(spec)
    if not candidate_tags:
        return False
    feedback_reasons = _feedback_active_loss_counter_candidate_reasons(
        scorecard, oracle_policy=oracle_policy
    )
    return bool(candidate_tags & feedback_reasons)


def _feedback_consistency_repair_candidate_reasons(
    scorecard: Mapping[str, Any],
    *,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> set[str]:
    if (
        not scorecard
        or _feedback_has_no_replay_activity(scorecard)
        or _feedback_has_nonpositive_expected_value(scorecard)
    ):
        return set()
    policy = oracle_policy or ProfitTargetOraclePolicy()
    if (
        _decimal(scorecard.get("max_gross_exposure_pct_equity"))
        > policy.max_gross_exposure_pct_equity
    ):
        return set()
    if _decimal(scorecard.get("min_cash")) < policy.min_cash:
        return set()
    if _decimal(scorecard.get("negative_cash_observation_count")) > Decimal(
        max(0, policy.max_negative_cash_observation_count)
    ):
        return set()
    reasons: set[str] = set()
    if (
        _decimal(scorecard.get("active_day_ratio"), default="1")
        < policy.min_active_day_ratio
    ):
        reasons.add("daily_coverage_shortfall")
    if (
        _decimal(scorecard.get("avg_filled_notional_per_day"))
        < policy.min_avg_filled_notional_per_day
    ):
        reasons.add("notional_throughput_shortfall")
    if (
        _decimal(scorecard.get("positive_day_ratio"), default="1")
        < policy.min_positive_day_ratio
        or _decimal(scorecard.get("negative_day_count")) > Decimal("0")
        or _decimal(scorecard.get("worst_day_loss")) > Decimal("0")
        or _decimal(scorecard.get("max_drawdown")) > Decimal("0")
        or _decimal(scorecard.get("min_daily_net_pnl")) < policy.min_daily_net_pnl
    ):
        reasons.add("loss_control_shortfall")
    if (
        _decimal(scorecard.get("best_day_share"), default="0")
        > policy.max_best_day_share
    ):
        reasons.update({"daily_coverage_shortfall", "loss_control_shortfall"})
    if (
        _decimal(scorecard.get("max_single_symbol_contribution_share"), default="0")
        > policy.max_single_symbol_contribution_share
        or _decimal(scorecard.get("symbol_concentration_share"), default="0")
        > policy.max_single_symbol_contribution_share
        or _decimal(scorecard.get("max_cluster_contribution_share"), default="0")
        > policy.max_cluster_contribution_share
    ):
        reasons.add("symbol_concentration_shortfall")
    return reasons


def _candidate_spec_matches_consistency_repair_feedback(
    spec: CandidateSpec,
    scorecard: Mapping[str, Any],
    *,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> bool:
    candidate_tags = _candidate_spec_active_loss_counter_tags(spec)
    if not candidate_tags:
        return False
    feedback_reasons = _feedback_consistency_repair_candidate_reasons(
        scorecard, oracle_policy=oracle_policy
    )
    return bool(candidate_tags & feedback_reasons)


def _active_loss_counter_proposal_score(
    spec: CandidateSpec,
    scorecard: Mapping[str, Any],
    *,
    raw_score: float,
    target_score: float,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> float:
    policy = oracle_policy or ProfitTargetOraclePolicy()
    candidate_tags = _candidate_spec_active_loss_counter_tags(spec)
    feedback_reasons = _feedback_active_loss_counter_candidate_reasons(
        scorecard,
        oracle_policy=policy,
    )
    matched_tags = candidate_tags & feedback_reasons
    params = _mapping(spec.strategy_overrides.get("params"))
    remediation_profile = _string(params.get("feedback_remediation_profile"))
    profile_bonus = {
        "adverse_selection_feedback_escape": Decimal("160"),
        "notional_throughput_feedback_escape": Decimal("110"),
        "turnover_coverage_feedback_escape": Decimal("90"),
        "daily_coverage_feedback_escape": Decimal("70"),
        "consistency_guard_feedback_escape": Decimal("60"),
        "symbol_diversification_feedback_escape": Decimal("40"),
    }.get(remediation_profile, Decimal("0"))
    capital_features = candidate_spec_capital_features(spec)
    configured_daily_notional_capacity = _decimal(
        capital_features.get("configured_daily_notional_capacity")
    )
    required_daily_notional = max(policy.min_avg_filled_notional_per_day, Decimal("1"))
    capacity_ratio = min(
        Decimal("2"),
        configured_daily_notional_capacity / required_daily_notional,
    )
    loss_control_bonus = Decimal("0")
    if _string(params.get("max_stop_loss_exits_per_session")) == "1":
        loss_control_bonus += Decimal("20")
    if _decimal(params.get("stop_loss_lockout_seconds")) >= Decimal("1800"):
        loss_control_bonus += Decimal("20")
    activity_count = max(
        (_decimal(scorecard.get(key)) for key in _REPLAY_ACTIVITY_COUNT_KEYS),
        default=Decimal("0"),
    )
    activity_bonus = min(activity_count, Decimal("100")) * Decimal("2")
    avg_filled_notional_per_day = _decimal(scorecard.get("avg_filled_notional_per_day"))
    activity_bonus += min(
        Decimal("1"),
        avg_filled_notional_per_day / required_daily_notional,
    ) * Decimal("50")
    activity_bonus += min(
        Decimal("1"),
        max(Decimal("0"), _decimal(scorecard.get("active_day_ratio"))),
    ) * Decimal("50")
    mlx_relative_signal = max(
        Decimal("-250"),
        min(Decimal("250"), Decimal(str(raw_score)) - Decimal(str(target_score))),
    )
    return float(
        Decimal("-100000")
        + _pre_replay_candidate_score(spec)
        + (Decimal(len(matched_tags)) * Decimal("180"))
        + profile_bonus
        + (capacity_ratio * Decimal("40"))
        + loss_control_bonus
        + activity_bonus
        + mlx_relative_signal
    )


def _consistency_repair_proposal_score(
    spec: CandidateSpec,
    scorecard: Mapping[str, Any],
    *,
    raw_score: float,
    target_score: float,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> float:
    policy = oracle_policy or ProfitTargetOraclePolicy()
    candidate_tags = _candidate_spec_active_loss_counter_tags(spec)
    feedback_reasons = _feedback_consistency_repair_candidate_reasons(
        scorecard,
        oracle_policy=policy,
    )
    matched_tags = candidate_tags & feedback_reasons
    params = _mapping(spec.strategy_overrides.get("params"))
    remediation_profile = _string(params.get("feedback_remediation_profile"))
    profile_bonus = {
        "consistency_guard_feedback_escape": Decimal("180"),
        "daily_coverage_feedback_escape": Decimal("150"),
        "adverse_selection_feedback_escape": Decimal("130"),
        "symbol_diversification_feedback_escape": Decimal("120"),
        "notional_throughput_feedback_escape": Decimal("80"),
        "turnover_coverage_feedback_escape": Decimal("70"),
    }.get(remediation_profile, Decimal("40"))
    positive_shortfall = max(
        Decimal("0"),
        policy.min_positive_day_ratio
        - _decimal(scorecard.get("positive_day_ratio"), default="1"),
    )
    concentration_excess = max(
        Decimal("0"),
        _decimal(scorecard.get("best_day_share"), default="0")
        - policy.max_best_day_share,
        _decimal(scorecard.get("max_single_symbol_contribution_share"), default="0")
        - policy.max_single_symbol_contribution_share,
        _decimal(scorecard.get("symbol_concentration_share"), default="0")
        - policy.max_single_symbol_contribution_share,
        _decimal(scorecard.get("max_cluster_contribution_share"), default="0")
        - policy.max_cluster_contribution_share,
    )
    mlx_relative_signal = max(
        Decimal("-250"),
        min(Decimal("250"), Decimal(str(raw_score)) - Decimal(str(target_score))),
    )
    return float(
        Decimal("-50000")
        + _pre_replay_candidate_score(spec)
        + (Decimal(len(matched_tags)) * Decimal("120"))
        + profile_bonus
        + mlx_relative_signal
        - (positive_shortfall * Decimal("80"))
        - (concentration_excess * Decimal("80"))
    )


def _scorecard_is_false_negative_rescue_feedback(
    scorecard: Mapping[str, Any],
) -> bool:
    signal_key = _string(scorecard.get("signal_key"))
    if signal_key.startswith("rejected_signal_false_negative"):
        return True
    runtime_params = _mapping(scorecard.get("runtime_params"))
    return _string(runtime_params.get("signal_motif")).startswith(
        "rejected_signal_false_negative"
    )


def _candidate_spec_execution_profile(spec: CandidateSpec) -> Mapping[str, Any]:
    return _mapping(spec.feature_contract.get("execution_profile"))


def _feedback_risk_profile_key_payload(
    *,
    family_template_id: str,
    runtime_strategy_name: str,
    execution_profile_id: str,
    universe_key: str,
    signal_key: str,
) -> Mapping[str, Any]:
    return {
        "family_template_id": family_template_id,
        "runtime_strategy_name": runtime_strategy_name,
        "execution_profile_id": execution_profile_id,
        "universe_key": universe_key,
        "signal_key": signal_key,
    }


def _candidate_spec_feedback_risk_profile_key(spec: CandidateSpec) -> str:
    execution_profile = _candidate_spec_execution_profile(spec)
    return _stable_hash(
        _feedback_risk_profile_key_payload(
            family_template_id=spec.family_template_id,
            runtime_strategy_name=spec.runtime_strategy_name,
            execution_profile_id=_string(execution_profile.get("profile_id")),
            universe_key=_candidate_spec_universe_key(spec),
            signal_key=_candidate_spec_signal_key(spec),
        )
    )


def _candidate_spec_feedback_shape_key(spec: CandidateSpec) -> str:
    params = _mapping(spec.strategy_overrides.get("params"))
    execution_profile = _candidate_spec_execution_profile(spec)
    return _stable_hash(
        {
            "family_template_id": spec.family_template_id,
            "runtime_family": spec.runtime_family,
            "runtime_strategy_name": spec.runtime_strategy_name,
            "execution_profile_id": _string(execution_profile.get("profile_id")),
            "universe_key": _candidate_spec_universe_key(spec),
            "signal_key": _candidate_spec_signal_key(spec),
            "capital_profile": _string(params.get("capital_profile")),
            "entry_minute_after_open": _string(params.get("entry_minute_after_open")),
            "exit_minute_after_open": _string(params.get("exit_minute_after_open")),
            "entry_start_minute_utc": _string(params.get("entry_start_minute_utc")),
            "entry_end_minute_utc": _string(params.get("entry_end_minute_utc")),
            "max_entries_per_session": _string(params.get("max_entries_per_session")),
            "max_concurrent_positions": _string(params.get("max_concurrent_positions")),
            "top_n": _string(params.get("top_n")),
            "max_pair_legs": _string(params.get("max_pair_legs")),
            "long_stop_loss_bps": _string(params.get("long_stop_loss_bps")),
            "short_stop_loss_bps": _string(params.get("short_stop_loss_bps")),
            "max_session_negative_exit_bps": _string(
                params.get("max_session_negative_exit_bps")
            ),
        }
    )


def _candidate_spec_feedback_metadata(spec: CandidateSpec) -> dict[str, Any]:
    execution_profile = _candidate_spec_execution_profile(spec)
    params = _mapping(spec.strategy_overrides.get("params"))
    universe_symbols = [
        _string(symbol).upper()
        for symbol in cast(
            Sequence[Any], spec.strategy_overrides.get("universe_symbols") or []
        )
        if _string(symbol)
    ]
    return {
        "family_template_id": spec.family_template_id,
        "runtime_family": spec.runtime_family,
        "runtime_strategy_name": spec.runtime_strategy_name,
        "execution_signature": _candidate_spec_execution_signature(spec),
        "execution_profile_id": _string(execution_profile.get("profile_id")),
        "execution_profile_index": execution_profile.get("profile_index"),
        "feedback_risk_profile_key": _candidate_spec_feedback_risk_profile_key(spec),
        "feedback_shape_key": _candidate_spec_feedback_shape_key(spec),
        "universe_key": _candidate_spec_universe_key(spec),
        "signal_key": _candidate_spec_signal_key(spec),
        "runtime_params": dict(params),
        "universe_symbols": universe_symbols,
    }


def _candidate_payload_with_feedback_metadata(
    *, candidate: Mapping[str, Any], spec: CandidateSpec
) -> dict[str, Any]:
    metadata = _candidate_spec_feedback_metadata(spec)
    next_candidate = {**dict(candidate), **metadata}
    scorecard = _mapping(next_candidate.get("objective_scorecard"))
    next_candidate["objective_scorecard"] = {
        **metadata,
        **scorecard,
    }
    validation_requirements = _list_of_mappings(
        spec.feature_contract.get("validation_requirements")
    )
    validation_requirement_claim_ids = [
        _string(item.get("claim_id"))
        for item in validation_requirements
        if _string(item.get("claim_id"))
    ]
    if validation_requirements or spec.promotion_contract.get(
        "synthetic_evidence_policy"
    ):
        validation_contract = {
            "schema_version": "torghut.candidate-validation-contract.v1",
            "source": "candidate_spec",
            "validation_requirements": validation_requirements,
            "validation_requirement_claim_ids": validation_requirement_claim_ids,
            "requires_historical_replay": bool(
                spec.promotion_contract.get("requires_historical_replay")
            ),
            "requires_live_paper_parity": bool(
                spec.promotion_contract.get("requires_live_paper_parity")
            ),
            "synthetic_evidence_policy": _string(
                spec.promotion_contract.get("synthetic_evidence_policy")
            ),
        }
        next_candidate["objective_scorecard"] = {
            **_mapping(next_candidate.get("objective_scorecard")),
            "validation_contract": validation_contract,
        }
        readiness = _mapping(next_candidate.get("promotion_readiness"))
        blockers = _string_list_from_value(readiness.get("blockers"))
        blockers.append("validation_contract_pending")
        if validation_contract["requires_live_paper_parity"]:
            blockers.append("validation_live_paper_parity_pending")
        if validation_contract["synthetic_evidence_policy"]:
            blockers.append("synthetic_evidence_not_promotion_proof")
        next_candidate["promotion_readiness"] = {
            **readiness,
            "stage": _string(readiness.get("stage")) or "research_candidate",
            "status": _string(readiness.get("status"))
            or "blocked_pending_validation_contract",
            "promotable": False,
            "blockers": list(dict.fromkeys(blockers)),
            "validation_contract": validation_contract,
        }
    return next_candidate


def _pre_replay_prior_bundle(spec: CandidateSpec) -> CandidateEvidenceBundle:
    prior_score = _pre_replay_candidate_score(spec)
    return evidence_bundle_from_frontier_candidate(
        candidate_spec_id=spec.candidate_spec_id,
        candidate=_candidate_payload_with_feedback_metadata(
            spec=spec,
            candidate={
                "candidate_id": f"pre-replay-prior-{spec.candidate_spec_id}",
                "objective_scorecard": {
                    "net_pnl_per_day": str(prior_score),
                    "active_day_ratio": "0.50",
                    "positive_day_ratio": "0.50",
                    "regime_slice_pass_rate": "0.45",
                    "posterior_edge_lower": "0.001",
                    "shadow_parity_status": "pending",
                },
                "promotion_readiness": {
                    "stage": "research_candidate",
                    "status": "pre_replay_prior",
                    "promotable": False,
                    "blockers": ["runtime_replay_required"],
                },
            },
        ),
        dataset_snapshot_id="pre-replay-proposal-priors",
        result_path=f"pre-replay-proposal-priors://{spec.candidate_spec_id}",
    )


def _feedback_scorecard_has_hard_veto(scorecard: Mapping[str, Any]) -> bool:
    if _oracle_blockers(scorecard):
        return True
    oracle_passed = scorecard.get("oracle_passed")
    if oracle_passed is not None and not _boolish(oracle_passed):
        return True
    hard_vetoes = scorecard.get("hard_vetoes") or scorecard.get("veto_reasons")
    if isinstance(hard_vetoes, str):
        return bool(hard_vetoes.strip())
    if isinstance(hard_vetoes, Sequence) and not isinstance(hard_vetoes, str):
        return any(_string(item) for item in hard_vetoes)
    return False


def _feedback_daily_net_has_loss(scorecard: Mapping[str, Any]) -> bool:
    daily_net = scorecard.get("daily_net")
    if not isinstance(daily_net, Mapping):
        return False
    return any(
        _decimal(value, default="0") <= Decimal("0")
        for value in cast(Mapping[Any, Any], daily_net).values()
    )


_REPLAY_ACTIVITY_COUNT_KEYS = (
    "decision_count",
    "trade_decision_count",
    "paper_decision_count",
    "runtime_decision_count",
    "orders_submitted_count",
    "submitted_order_count",
    "filled_count",
    "fill_count",
    "filled_order_count",
)


def _feedback_has_no_replay_activity(scorecard: Mapping[str, Any]) -> bool:
    explicit_activity = False
    for key in _REPLAY_ACTIVITY_COUNT_KEYS:
        if key not in scorecard:
            continue
        explicit_activity = True
        if _decimal(scorecard.get(key)) > Decimal("0"):
            return False
    if "avg_filled_notional_per_day" in scorecard:
        explicit_activity = True
        if _decimal(scorecard.get("avg_filled_notional_per_day")) > Decimal("0"):
            return False
    daily_filled_notional = scorecard.get("daily_filled_notional")
    if isinstance(daily_filled_notional, Mapping):
        explicit_activity = True
        if any(
            _decimal(value) > Decimal("0")
            for value in cast(Mapping[Any, Any], daily_filled_notional).values()
        ):
            return False
    return explicit_activity


def _feedback_family_prior_has_hard_block(
    scorecard: Mapping[str, Any],
    *,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> bool:
    policy = oracle_policy or ProfitTargetOraclePolicy()
    if _feedback_has_no_replay_activity(scorecard):
        return True
    oracle_blockers = _oracle_blockers(scorecard)
    if oracle_blockers & _FAMILY_PRIOR_HARD_BLOCK_ORACLE_BLOCKERS:
        return True
    if (
        _decimal(scorecard.get("active_day_ratio"), default="1")
        < policy.min_active_day_ratio
    ):
        return True
    if (
        _decimal(scorecard.get("positive_day_ratio"), default="1")
        < policy.min_positive_day_ratio
    ):
        return True
    if _decimal(scorecard.get("best_day_share")) > policy.max_best_day_share:
        return True
    return _feedback_has_nonpositive_expected_value(scorecard)


def _feedback_risk_profile_has_penalty(
    scorecard: Mapping[str, Any],
    *,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> bool:
    policy = oracle_policy or ProfitTargetOraclePolicy()
    if _feedback_has_no_replay_activity(scorecard):
        return True
    oracle_blockers = _oracle_blockers(scorecard)
    if oracle_blockers & _RISK_PROFILE_FEEDBACK_ORACLE_BLOCKERS:
        return True
    if (
        _decimal(scorecard.get("active_day_ratio"), default="1")
        < policy.min_active_day_ratio
    ):
        return True
    if (
        _decimal(scorecard.get("positive_day_ratio"), default="1")
        < policy.min_positive_day_ratio
    ):
        return True
    if _decimal(scorecard.get("best_day_share")) > policy.max_best_day_share:
        return True
    if (
        _decimal(scorecard.get("max_single_day_contribution_share"))
        > policy.max_best_day_share
    ):
        return True
    if (
        _decimal(scorecard.get("max_single_symbol_contribution_share"), default="1")
        > policy.max_single_symbol_contribution_share
    ):
        return True
    if (
        _decimal(scorecard.get("max_cluster_contribution_share"), default="1")
        > policy.max_cluster_contribution_share
    ):
        return True
    return False


def _feedback_risk_profile_has_terminal_block(
    scorecard: Mapping[str, Any],
    *,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> bool:
    if not scorecard:
        return False
    if _feedback_has_no_replay_activity(scorecard):
        return True
    policy = oracle_policy or ProfitTargetOraclePolicy()
    if not _feedback_risk_profile_has_penalty(scorecard, oracle_policy=policy):
        return False
    if _feedback_has_nonpositive_expected_value(scorecard):
        return True
    if (
        _decimal(scorecard.get("max_gross_exposure_pct_equity"))
        > policy.max_gross_exposure_pct_equity
    ):
        return True
    if _decimal(scorecard.get("min_cash")) < policy.min_cash:
        return True
    return _decimal(scorecard.get("negative_cash_observation_count")) > Decimal(
        max(0, policy.max_negative_cash_observation_count)
    )


def _feedback_has_policy_penalty(
    scorecard: Mapping[str, Any],
    *,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> bool:
    if _feedback_has_no_replay_activity(scorecard):
        return True
    return _feedback_risk_profile_has_penalty(
        scorecard, oracle_policy=oracle_policy
    ) or _feedback_daily_net_has_loss(scorecard)


def _feedback_is_blocked(
    scorecard: Mapping[str, Any],
    *,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> bool:
    policy = oracle_policy or ProfitTargetOraclePolicy()
    if _feedback_has_no_replay_activity(scorecard):
        return True
    if _feedback_scorecard_has_hard_veto(scorecard):
        return True
    if (
        _decimal(scorecard.get("max_gross_exposure_pct_equity"))
        > policy.max_gross_exposure_pct_equity
    ):
        return True
    if _decimal(scorecard.get("min_cash")) < policy.min_cash:
        return True
    if _decimal(scorecard.get("negative_cash_observation_count")) > Decimal(
        max(0, policy.max_negative_cash_observation_count)
    ):
        return True
    return _decimal(scorecard.get("net_pnl_per_day")) <= Decimal("0")


def _feedback_has_nonpositive_expected_value(scorecard: Mapping[str, Any]) -> bool:
    return _decimal(scorecard.get("net_pnl_per_day")) <= Decimal("0")


def _feedback_bundle_sort_value(
    bundle: CandidateEvidenceBundle,
    *,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> tuple[int, Decimal, str]:
    scorecard = bundle.objective_scorecard
    return (
        0 if _feedback_is_blocked(scorecard, oracle_policy=oracle_policy) else 1,
        _decimal(scorecard.get("net_pnl_per_day")),
        _string(bundle.candidate_id),
    )


def _feedback_family_template_id(bundle: CandidateEvidenceBundle) -> str:
    return _string(bundle.objective_scorecard.get("family_template_id"))


def _feedback_execution_signature(bundle: CandidateEvidenceBundle) -> str:
    return _string(bundle.objective_scorecard.get("execution_signature"))


def _feedback_shape_key(bundle: CandidateEvidenceBundle) -> str:
    return _string(bundle.objective_scorecard.get("feedback_shape_key"))


def _feedback_risk_profile_key_from_scorecard(scorecard: Mapping[str, Any]) -> str:
    direct_key = _string(scorecard.get("feedback_risk_profile_key"))
    if direct_key:
        return direct_key
    payload = _feedback_risk_profile_key_payload(
        family_template_id=_string(scorecard.get("family_template_id")),
        runtime_strategy_name=_string(scorecard.get("runtime_strategy_name")),
        execution_profile_id=_string(scorecard.get("execution_profile_id")),
        universe_key=_string(scorecard.get("universe_key")),
        signal_key=_string(scorecard.get("signal_key")),
    )
    if not any(_string(value) for value in payload.values()):
        return ""
    return _stable_hash(payload)


def _feedback_risk_profile_key(bundle: CandidateEvidenceBundle) -> str:
    return _feedback_risk_profile_key_from_scorecard(bundle.objective_scorecard)


def _execution_signature_feedback_bundle_for_spec(
    *,
    spec: CandidateSpec,
    bundle: CandidateEvidenceBundle,
) -> CandidateEvidenceBundle:
    scorecard = {
        **dict(bundle.objective_scorecard),
        **_candidate_spec_feedback_metadata(spec),
        "feedback_match_scope": "execution_signature",
        "feedback_source_candidate_spec_id": bundle.candidate_spec_id,
    }
    return replace(
        bundle,
        candidate_spec_id=spec.candidate_spec_id,
        candidate_id=f"signature-feedback-{bundle.candidate_id}",
        objective_scorecard=scorecard,
    )


def _shape_feedback_bundle_for_spec(
    *,
    spec: CandidateSpec,
    bundle: CandidateEvidenceBundle,
) -> CandidateEvidenceBundle:
    scorecard = {
        **dict(bundle.objective_scorecard),
        **_candidate_spec_feedback_metadata(spec),
        "feedback_match_scope": "feedback_shape_key",
        "feedback_source_candidate_spec_id": bundle.candidate_spec_id,
    }
    return replace(
        bundle,
        candidate_spec_id=spec.candidate_spec_id,
        candidate_id=f"shape-feedback-{bundle.candidate_id}",
        objective_scorecard=scorecard,
    )


def _risk_profile_feedback_bundle_for_spec(
    *,
    spec: CandidateSpec,
    bundle: CandidateEvidenceBundle,
) -> CandidateEvidenceBundle:
    scorecard = {
        **dict(bundle.objective_scorecard),
        **_candidate_spec_feedback_metadata(spec),
        "feedback_match_scope": "feedback_risk_profile_key",
        "feedback_source_candidate_spec_id": bundle.candidate_spec_id,
    }
    return replace(
        bundle,
        candidate_spec_id=spec.candidate_spec_id,
        candidate_id=f"risk-profile-feedback-{bundle.candidate_id}",
        objective_scorecard=scorecard,
    )


def _family_feedback_bundle_for_spec(
    *,
    spec: CandidateSpec,
    bundle: CandidateEvidenceBundle,
) -> CandidateEvidenceBundle:
    scorecard = {
        **dict(bundle.objective_scorecard),
        **_candidate_spec_feedback_metadata(spec),
        "feedback_match_scope": "family_template_id",
        "feedback_source_candidate_spec_id": bundle.candidate_spec_id,
    }
    return replace(
        bundle,
        candidate_spec_id=spec.candidate_spec_id,
        candidate_id=f"family-feedback-{bundle.candidate_id}",
        objective_scorecard=scorecard,
    )


def _pre_replay_proposal_model_and_rows(
    *,
    specs: Sequence[CandidateSpec],
    feedback_evidence_bundles: Sequence[CandidateEvidenceBundle] = (),
    oracle_policy: ProfitTargetOraclePolicy | None = None,
    ranker_backend_preference: str = _DEFAULT_RANKER_BACKEND_PREFERENCE,
) -> tuple[Mapping[str, Any], list[dict[str, Any]]]:
    policy = oracle_policy or ProfitTargetOraclePolicy()
    spec_by_id = {spec.candidate_spec_id: spec for spec in specs}
    spec_ids = {spec.candidate_spec_id for spec in specs}
    execution_signature_by_spec = {
        spec.candidate_spec_id: _candidate_spec_execution_signature(spec)
        for spec in specs
    }
    feedback_shape_key_by_spec = {
        spec.candidate_spec_id: _candidate_spec_feedback_shape_key(spec)
        for spec in specs
    }
    feedback_risk_profile_key_by_spec = {
        spec.candidate_spec_id: _candidate_spec_feedback_risk_profile_key(spec)
        for spec in specs
    }
    feedback_by_spec: dict[str, CandidateEvidenceBundle] = {}
    for bundle in feedback_evidence_bundles:
        if bundle.candidate_spec_id not in spec_ids:
            continue
        current = feedback_by_spec.get(bundle.candidate_spec_id)
        if current is None or _feedback_bundle_sort_value(
            bundle, oracle_policy=policy
        ) > _feedback_bundle_sort_value(current, oracle_policy=policy):
            feedback_by_spec[bundle.candidate_spec_id] = bundle

    feedback_by_execution_signature: dict[str, CandidateEvidenceBundle] = {}
    for bundle in feedback_evidence_bundles:
        execution_signature = _feedback_execution_signature(bundle)
        if not execution_signature:
            continue
        current = feedback_by_execution_signature.get(execution_signature)
        if current is None or _feedback_bundle_sort_value(
            bundle, oracle_policy=policy
        ) > _feedback_bundle_sort_value(current, oracle_policy=policy):
            feedback_by_execution_signature[execution_signature] = bundle
    signature_feedback_by_spec: dict[str, CandidateEvidenceBundle] = {}
    for spec in specs:
        if spec.candidate_spec_id in feedback_by_spec:
            continue
        signature = execution_signature_by_spec[spec.candidate_spec_id]
        bundle = feedback_by_execution_signature.get(signature)
        if bundle is not None:
            signature_feedback_by_spec[spec.candidate_spec_id] = (
                _execution_signature_feedback_bundle_for_spec(spec=spec, bundle=bundle)
            )

    feedback_by_shape: dict[str, CandidateEvidenceBundle] = {}
    for bundle in feedback_evidence_bundles:
        feedback_shape_key = _feedback_shape_key(bundle)
        if not feedback_shape_key:
            continue
        current = feedback_by_shape.get(feedback_shape_key)
        if current is None or _feedback_bundle_sort_value(
            bundle, oracle_policy=policy
        ) > _feedback_bundle_sort_value(current, oracle_policy=policy):
            feedback_by_shape[feedback_shape_key] = bundle
    shape_feedback_by_spec: dict[str, CandidateEvidenceBundle] = {}
    for spec in specs:
        if (
            spec.candidate_spec_id in feedback_by_spec
            or spec.candidate_spec_id in signature_feedback_by_spec
        ):
            continue
        bundle = feedback_by_shape.get(
            feedback_shape_key_by_spec[spec.candidate_spec_id]
        )
        if bundle is not None:
            shape_feedback_by_spec[spec.candidate_spec_id] = (
                _shape_feedback_bundle_for_spec(spec=spec, bundle=bundle)
            )

    feedback_by_risk_profile: dict[str, CandidateEvidenceBundle] = {}
    for bundle in feedback_evidence_bundles:
        if not _feedback_risk_profile_has_penalty(
            bundle.objective_scorecard, oracle_policy=policy
        ):
            continue
        risk_profile_key = _feedback_risk_profile_key(bundle)
        if not risk_profile_key:
            continue
        current = feedback_by_risk_profile.get(risk_profile_key)
        if current is None or _feedback_bundle_sort_value(
            bundle, oracle_policy=policy
        ) > _feedback_bundle_sort_value(current, oracle_policy=policy):
            feedback_by_risk_profile[risk_profile_key] = bundle
    risk_profile_feedback_by_spec: dict[str, CandidateEvidenceBundle] = {}
    for spec in specs:
        if (
            spec.candidate_spec_id in feedback_by_spec
            or spec.candidate_spec_id in signature_feedback_by_spec
            or spec.candidate_spec_id in shape_feedback_by_spec
        ):
            continue
        bundle = feedback_by_risk_profile.get(
            feedback_risk_profile_key_by_spec[spec.candidate_spec_id]
        )
        if bundle is not None:
            risk_profile_feedback_by_spec[spec.candidate_spec_id] = (
                _risk_profile_feedback_bundle_for_spec(spec=spec, bundle=bundle)
            )

    feedback_by_family: dict[str, CandidateEvidenceBundle] = {}
    for bundle in feedback_evidence_bundles:
        family_template_id = _feedback_family_template_id(bundle)
        if not family_template_id:
            continue
        current = feedback_by_family.get(family_template_id)
        if current is None or _feedback_bundle_sort_value(
            bundle, oracle_policy=policy
        ) > _feedback_bundle_sort_value(current, oracle_policy=policy):
            feedback_by_family[family_template_id] = bundle
    family_feedback_by_spec: dict[str, CandidateEvidenceBundle] = {}
    for spec in specs:
        if (
            spec.candidate_spec_id in feedback_by_spec
            or spec.candidate_spec_id in signature_feedback_by_spec
            or spec.candidate_spec_id in shape_feedback_by_spec
            or spec.candidate_spec_id in risk_profile_feedback_by_spec
        ):
            continue
        bundle = feedback_by_family.get(spec.family_template_id)
        if bundle is not None:
            family_feedback_by_spec[spec.candidate_spec_id] = (
                _family_feedback_bundle_for_spec(spec=spec, bundle=bundle)
            )

    prior_bundles = [_pre_replay_prior_bundle(spec) for spec in specs]
    training_bundles: list[CandidateEvidenceBundle] = []
    training_source_by_spec: dict[str, str] = {}
    feedback_source_candidate_spec_by_spec: dict[str, str | None] = {}
    feedback_match_scope_by_spec: dict[str, str | None] = {}
    for spec, prior_bundle in zip(specs, prior_bundles, strict=True):
        candidate_spec_id = spec.candidate_spec_id
        if candidate_spec_id in feedback_by_spec:
            bundle = feedback_by_spec[candidate_spec_id]
            training_source = "feedback_real_replay"
            match_scope = "candidate_spec_id"
            source_spec_id: str | None = bundle.candidate_spec_id
        elif candidate_spec_id in signature_feedback_by_spec:
            bundle = signature_feedback_by_spec[candidate_spec_id]
            training_source = "feedback_execution_signature_replay"
            match_scope = "execution_signature"
            source_spec_id = _string(
                bundle.objective_scorecard.get("feedback_source_candidate_spec_id")
            )
        elif candidate_spec_id in shape_feedback_by_spec:
            bundle = shape_feedback_by_spec[candidate_spec_id]
            training_source = "feedback_shape_prior"
            match_scope = "feedback_shape_key"
            source_spec_id = _string(
                bundle.objective_scorecard.get("feedback_source_candidate_spec_id")
            )
        elif candidate_spec_id in risk_profile_feedback_by_spec:
            bundle = risk_profile_feedback_by_spec[candidate_spec_id]
            training_source = "feedback_risk_profile_prior"
            match_scope = "feedback_risk_profile_key"
            source_spec_id = _string(
                bundle.objective_scorecard.get("feedback_source_candidate_spec_id")
            )
        elif candidate_spec_id in family_feedback_by_spec:
            bundle = family_feedback_by_spec[candidate_spec_id]
            training_source = "feedback_family_replay"
            match_scope = "family_template_id"
            source_spec_id = _string(
                bundle.objective_scorecard.get("feedback_source_candidate_spec_id")
            )
        else:
            bundle = prior_bundle
            training_source = "synthetic_prior"
            match_scope = None
            source_spec_id = None
        training_bundles.append(bundle)
        training_source_by_spec[candidate_spec_id] = training_source
        feedback_source_candidate_spec_by_spec[candidate_spec_id] = source_spec_id
        feedback_match_scope_by_spec[candidate_spec_id] = match_scope
    training_rows = build_mlx_training_rows(
        candidate_specs=specs, evidence_bundles=training_bundles
    )
    model = train_mlx_ranker(
        training_rows, backend_preference=ranker_backend_preference
    )
    ranked_rows = rank_training_rows(model=model, rows=training_rows)
    feature_by_spec = {
        row.candidate_spec_id: row.to_payload()["features"] for row in training_rows
    }
    target_by_spec = {row.candidate_spec_id: row.target for row in training_rows}
    feedback_bundle_by_spec = {
        **feedback_by_spec,
        **signature_feedback_by_spec,
        **shape_feedback_by_spec,
        **risk_profile_feedback_by_spec,
        **family_feedback_by_spec,
    }

    training_source_counts: dict[str, int] = {}
    for source in training_source_by_spec.values():
        training_source_counts[source] = training_source_counts.get(source, 0) + 1

    def row_selection_reason(candidate_spec_id: str) -> str:
        source = training_source_by_spec.get(candidate_spec_id, "synthetic_prior")
        bundle = feedback_bundle_by_spec.get(candidate_spec_id)
        is_blocked = bundle is not None and _feedback_is_blocked(
            bundle.objective_scorecard, oracle_policy=policy
        )
        has_policy_penalty = bundle is not None and _feedback_has_policy_penalty(
            bundle.objective_scorecard, oracle_policy=policy
        )
        if bundle is not None and _feedback_has_no_replay_activity(
            bundle.objective_scorecard
        ):
            return "pre_replay_mlx_no_activity_feedback_blocked"
        if source == "feedback_real_replay" and is_blocked:
            if bundle is not None and _feedback_has_nonpositive_expected_value(
                bundle.objective_scorecard
            ):
                return "pre_replay_mlx_feedback_blocked"
            return "pre_replay_mlx_feedback_penalized"
        if source == "feedback_real_replay" and has_policy_penalty:
            return "pre_replay_mlx_feedback_penalized"
        if source == "feedback_execution_signature_replay" and is_blocked:
            if bundle is not None and _feedback_has_nonpositive_expected_value(
                bundle.objective_scorecard
            ):
                return "pre_replay_mlx_signature_feedback_blocked"
            return "pre_replay_mlx_signature_feedback_penalized"
        if source == "feedback_execution_signature_replay" and has_policy_penalty:
            return "pre_replay_mlx_signature_feedback_penalized"
        if source == "feedback_shape_prior" and bundle is not None:
            if _feedback_family_prior_has_hard_block(
                bundle.objective_scorecard, oracle_policy=policy
            ):
                return "pre_replay_mlx_shape_feedback_blocked"
            if is_blocked:
                return "pre_replay_mlx_family_feedback_penalized"
        if (
            source == "feedback_risk_profile_prior"
            and bundle is not None
            and _feedback_risk_profile_has_penalty(
                bundle.objective_scorecard, oracle_policy=policy
            )
        ):
            if _feedback_risk_profile_has_terminal_block(
                bundle.objective_scorecard, oracle_policy=policy
            ):
                return "pre_replay_mlx_risk_profile_feedback_blocked"
            return "pre_replay_mlx_risk_profile_feedback_penalized"
        if (
            source == "feedback_family_replay"
            and bundle is not None
            and _feedback_has_nonpositive_expected_value(bundle.objective_scorecard)
        ):
            spec = spec_by_id.get(candidate_spec_id)
            if (
                spec is not None
                and _candidate_spec_is_false_negative_rescue(spec)
                and _scorecard_is_false_negative_rescue_feedback(
                    bundle.objective_scorecard
                )
            ):
                return "pre_replay_mlx_false_negative_rescue_feedback_blocked"
            if (
                spec is not None
                and _candidate_spec_matches_active_loss_counter_feedback(
                    spec,
                    bundle.objective_scorecard,
                    oracle_policy=policy,
                )
            ):
                return "pre_replay_mlx_active_loss_counter_candidate"
            return "pre_replay_mlx_family_feedback_blocked"
        if (
            source == "feedback_family_replay"
            and bundle is not None
            and (is_blocked or has_policy_penalty)
        ):
            spec = spec_by_id.get(candidate_spec_id)
            if spec is not None and _candidate_spec_matches_consistency_repair_feedback(
                spec,
                bundle.objective_scorecard,
                oracle_policy=policy,
            ):
                return "pre_replay_mlx_consistency_repair_candidate"
            return "pre_replay_mlx_family_feedback_penalized"
        return "pre_replay_mlx_rank"

    def proposal_score_for_item(candidate_spec_id: str, raw_score: float) -> float:
        source = training_source_by_spec.get(candidate_spec_id, "synthetic_prior")
        bundle = feedback_bundle_by_spec.get(candidate_spec_id)
        if (
            source in {"feedback_real_replay", "feedback_execution_signature_replay"}
            and bundle is not None
            and _feedback_has_nonpositive_expected_value(bundle.objective_scorecard)
        ):
            return min(-1_000_000.0, target_by_spec.get(candidate_spec_id, raw_score))
        if (
            source == "feedback_family_replay"
            and bundle is not None
            and _feedback_has_nonpositive_expected_value(bundle.objective_scorecard)
        ):
            spec = spec_by_id.get(candidate_spec_id)
            if (
                spec is not None
                and _candidate_spec_matches_active_loss_counter_feedback(
                    spec,
                    bundle.objective_scorecard,
                    oracle_policy=policy,
                )
            ):
                return _active_loss_counter_proposal_score(
                    spec,
                    bundle.objective_scorecard,
                    raw_score=raw_score,
                    target_score=target_by_spec.get(candidate_spec_id, raw_score),
                    oracle_policy=policy,
                )
            return min(-1_000_000.0, target_by_spec.get(candidate_spec_id, raw_score))
        if (
            source == "feedback_family_replay"
            and bundle is not None
            and (
                _feedback_is_blocked(bundle.objective_scorecard, oracle_policy=policy)
                or _feedback_has_policy_penalty(
                    bundle.objective_scorecard, oracle_policy=policy
                )
            )
        ):
            spec = spec_by_id.get(candidate_spec_id)
            if spec is not None and _candidate_spec_matches_consistency_repair_feedback(
                spec,
                bundle.objective_scorecard,
                oracle_policy=policy,
            ):
                return _consistency_repair_proposal_score(
                    spec,
                    bundle.objective_scorecard,
                    raw_score=raw_score,
                    target_score=target_by_spec.get(candidate_spec_id, raw_score),
                    oracle_policy=policy,
                )
        if (
            source == "feedback_shape_prior"
            and bundle is not None
            and _feedback_family_prior_has_hard_block(
                bundle.objective_scorecard, oracle_policy=policy
            )
        ):
            return min(-1_000_000.0, target_by_spec.get(candidate_spec_id, raw_score))
        if (
            source == "feedback_risk_profile_prior"
            and bundle is not None
            and _feedback_risk_profile_has_terminal_block(
                bundle.objective_scorecard, oracle_policy=policy
            )
        ):
            return min(-1_000_000.0, target_by_spec.get(candidate_spec_id, raw_score))
        if (
            source == "feedback_risk_profile_prior"
            and bundle is not None
            and _feedback_risk_profile_has_penalty(
                bundle.objective_scorecard, oracle_policy=policy
            )
        ):
            return min(-500_000.0, target_by_spec.get(candidate_spec_id, raw_score))
        if (
            source == "feedback_family_replay"
            and bundle is not None
            and _feedback_is_blocked(bundle.objective_scorecard, oracle_policy=policy)
        ):
            return min(-100_000.0, target_by_spec.get(candidate_spec_id, raw_score))
        return raw_score

    rows_unranked = [
        {
            "candidate_spec_id": item.candidate_spec_id,
            "proposal_score": proposal_score_for_item(
                item.candidate_spec_id, item.score
            ),
            "raw_mlx_proposal_score": item.score,
            "feedback_replay_target": target_by_spec.get(item.candidate_spec_id)
            if item.candidate_spec_id in feedback_bundle_by_spec
            else None,
            "backend": item.backend,
            "model_id": item.model_id,
            "selection_reason": row_selection_reason(item.candidate_spec_id),
            "training_source": training_source_by_spec.get(
                item.candidate_spec_id, "synthetic_prior"
            ),
            "feedback_source_candidate_spec_id": feedback_source_candidate_spec_by_spec.get(
                item.candidate_spec_id
            ),
            "feedback_match_scope": feedback_match_scope_by_spec.get(
                item.candidate_spec_id
            ),
            "active_loss_counter_tags": sorted(
                _candidate_spec_active_loss_counter_tags(
                    spec_by_id[item.candidate_spec_id]
                )
            )
            if row_selection_reason(item.candidate_spec_id)
            == "pre_replay_mlx_active_loss_counter_candidate"
            else [],
            "active_loss_counter_feedback_reasons": sorted(
                _feedback_active_loss_counter_candidate_reasons(
                    feedback_bundle_by_spec[item.candidate_spec_id].objective_scorecard,
                    oracle_policy=policy,
                )
            )
            if row_selection_reason(item.candidate_spec_id)
            == "pre_replay_mlx_active_loss_counter_candidate"
            and item.candidate_spec_id in feedback_bundle_by_spec
            else [],
            "consistency_repair_tags": sorted(
                _candidate_spec_active_loss_counter_tags(
                    spec_by_id[item.candidate_spec_id]
                )
            )
            if row_selection_reason(item.candidate_spec_id)
            == "pre_replay_mlx_consistency_repair_candidate"
            else [],
            "consistency_repair_feedback_reasons": sorted(
                _feedback_consistency_repair_candidate_reasons(
                    feedback_bundle_by_spec[item.candidate_spec_id].objective_scorecard,
                    oracle_policy=policy,
                )
            )
            if row_selection_reason(item.candidate_spec_id)
            == "pre_replay_mlx_consistency_repair_candidate"
            and item.candidate_spec_id in feedback_bundle_by_spec
            else [],
            "feedback_evidence_context_count": len(feedback_evidence_bundles),
            "feature_hash": item.feature_hash,
            "features": feature_by_spec.get(item.candidate_spec_id, {}),
        }
        for item in ranked_rows
    ]
    rows_unranked.sort(
        key=lambda row: (
            -float(row.get("proposal_score") or 0.0),
            _string(row.get("candidate_spec_id")),
        )
    )
    rows = [{**row, "rank": index} for index, row in enumerate(rows_unranked, start=1)]
    return {
        **model.to_payload(),
        "proposal_stage": "pre_replay",
        "model_status": "active",
        "rank_bucket_lift": {"status": "pending_replay_evidence"},
        "feedback_evidence_bundle_count": len(feedback_evidence_bundles),
        "feedback_matched_spec_count": len(feedback_by_spec),
        "feedback_execution_signature_matched_spec_count": len(
            signature_feedback_by_spec
        ),
        "feedback_shape_matched_spec_count": len(shape_feedback_by_spec),
        "feedback_risk_profile_matched_spec_count": len(risk_profile_feedback_by_spec),
        "feedback_family_matched_spec_count": len(family_feedback_by_spec),
        "training_source_counts": training_source_counts,
    }, rows


def _proposal_score_confidence(
    proposal_rows: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    scores = [
        Decimal(str(row.get("proposal_score")))
        for row in _list_of_mappings(list(proposal_rows))
        if row.get("proposal_score") is not None
    ]
    if len(scores) < 2:
        return {
            "confidence": "low",
            "score_spread": "0",
            "reason": "insufficient_ranked_candidates",
        }
    score_spread = max(scores) - min(scores)
    confidence = "low" if score_spread < Decimal("5") else "normal"
    return {
        "confidence": confidence,
        "score_spread": str(score_spread),
        "reason": "low_score_dispersion"
        if confidence == "low"
        else "score_dispersion_sufficient",
    }


def _candidate_spec_execution_signature(spec: CandidateSpec) -> str:
    vnext_payload = spec.to_vnext_experiment_payload()
    return _stable_hash(
        {
            "family_template_id": spec.family_template_id,
            "runtime_family": spec.runtime_family,
            "runtime_strategy_name": spec.runtime_strategy_name,
            "template_overrides": vnext_payload.get("template_overrides", {}),
            "feature_variants": vnext_payload.get("feature_variants", []),
            "veto_controller_variants": vnext_payload.get(
                "veto_controller_variants", []
            ),
            "selection_objectives": vnext_payload.get("selection_objectives", {}),
            "hard_vetoes": vnext_payload.get("hard_vetoes", {}),
        }
    )


_PRE_REPLAY_FEEDBACK_BLOCK_REASONS = frozenset(
    {
        "pre_replay_mlx_feedback_blocked",
        "pre_replay_mlx_signature_feedback_blocked",
        "pre_replay_mlx_shape_feedback_blocked",
        "pre_replay_mlx_risk_profile_feedback_blocked",
        "pre_replay_mlx_family_feedback_blocked",
        "pre_replay_mlx_false_negative_rescue_feedback_blocked",
        "pre_replay_mlx_no_activity_feedback_blocked",
    }
)
_PRE_REPLAY_SELECTION_BLOCK_REASONS = frozenset(
    {
        *_PRE_REPLAY_FEEDBACK_BLOCK_REASONS,
        "pre_replay_capital_budget_blocked",
        "pre_replay_mlx_synthetic_nonpositive_expected_value",
        "pre_replay_synthetic_capacity_insufficient",
    }
)


def _selection_reason_blocks_replay(reason: str) -> bool:
    return reason in _PRE_REPLAY_SELECTION_BLOCK_REASONS


def _select_candidate_specs_for_replay(
    *,
    specs: Sequence[CandidateSpec],
    proposal_rows: Sequence[Mapping[str, Any]],
    top_k: int,
    exploration_slots: int,
    max_candidates: int,
    portfolio_size_min: int,
    feedback_block_reaudit_slots: int = 0,
) -> tuple[list[CandidateSpec], dict[str, Any]]:
    if not specs:
        return [], {
            "schema_version": "torghut.whitepaper-autoresearch-selection.v1",
            "selected_candidate_spec_ids": [],
            "rows": [],
        }
    spec_by_id = {spec.candidate_spec_id: spec for spec in specs}
    execution_signature_by_spec = {
        spec.candidate_spec_id: _candidate_spec_execution_signature(spec)
        for spec in specs
    }
    capital_features_by_spec = {
        spec.candidate_spec_id: dict(candidate_spec_capital_features(spec))
        for spec in specs
    }
    proposal_by_spec = {
        _string(row.get("candidate_spec_id")): row
        for row in _list_of_mappings(list(proposal_rows))
        if _string(row.get("candidate_spec_id"))
    }
    capital_block_reason = "pre_replay_capital_budget_blocked"

    def proposal_score(candidate_spec_id: str) -> Decimal:
        return _decimal(
            proposal_by_spec.get(candidate_spec_id, {}).get("proposal_score")
        )

    def proposal_training_source(candidate_spec_id: str) -> str:
        return (
            _string(proposal_by_spec.get(candidate_spec_id, {}).get("training_source"))
            or "unknown"
        )

    def proposal_feedback_context_count(candidate_spec_id: str) -> int:
        try:
            return int(
                proposal_by_spec.get(candidate_spec_id, {}).get(
                    "feedback_evidence_context_count", 0
                )
                or 0
            )
        except (TypeError, ValueError):
            return 0

    def proposal_selection_reason(candidate_spec_id: str) -> str:
        return _string(
            proposal_by_spec.get(candidate_spec_id, {}).get("selection_reason")
        )

    def proposal_feature(candidate_spec_id: str, key: str) -> Decimal:
        features = _mapping(proposal_by_spec.get(candidate_spec_id, {}).get("features"))
        return _decimal(features.get(key))

    def proposal_has_feature(candidate_spec_id: str, key: str) -> bool:
        features = _mapping(proposal_by_spec.get(candidate_spec_id, {}).get("features"))
        return key in features

    def capital_blocked(spec: CandidateSpec) -> bool:
        features = capital_features_by_spec.get(spec.candidate_spec_id, {})
        oracle_policy = _mapping(
            spec.promotion_contract.get("profit_target_oracle_policy")
        )
        max_gross_exposure = _decimal(
            oracle_policy.get("max_gross_exposure_pct_equity"), default="1.0"
        )
        return (
            _decimal(features.get("capital_feasible_flag")) < Decimal("1")
            or _decimal(features.get("capital_budget_overage_ratio")) > Decimal("0")
            or _decimal(features.get("estimated_max_gross_exposure_pct_equity"))
            > max_gross_exposure
        )

    def pre_replay_block_reason(spec: CandidateSpec) -> str:
        proposal = proposal_by_spec.get(spec.candidate_spec_id, {})
        selection_reason = _string(proposal.get("selection_reason"))
        if selection_reason in _PRE_REPLAY_FEEDBACK_BLOCK_REASONS:
            if (
                selection_reason == "pre_replay_mlx_family_feedback_blocked"
                and _candidate_spec_is_false_negative_rescue(spec)
            ):
                return ""
            return selection_reason
        if capital_blocked(spec):
            return capital_block_reason
        score = proposal_score(spec.candidate_spec_id)
        if proposal.get("proposal_score") is not None and score <= Decimal("-999999"):
            return "pre_replay_mlx_feedback_blocked"
        if (
            proposal_training_source(spec.candidate_spec_id) == "synthetic_prior"
            and proposal_feedback_context_count(spec.candidate_spec_id) > 0
            and proposal.get("proposal_score") is not None
            and score <= Decimal("0")
        ):
            if proposal_has_feature(
                spec.candidate_spec_id,
                "configured_daily_notional_required_ratio",
            ) and proposal_feature(
                spec.candidate_spec_id,
                "configured_daily_notional_required_ratio",
            ) < Decimal("1"):
                return "pre_replay_synthetic_capacity_insufficient"
            return "pre_replay_mlx_synthetic_nonpositive_expected_value"
        return ""

    def is_feedback_block_reason(reason: str) -> bool:
        return (
            reason in _PRE_REPLAY_FEEDBACK_BLOCK_REASONS
            or reason == "pre_replay_mlx_feedback_blocked"
        )

    def capital_sort_key(candidate_spec_id: str) -> tuple[int, Decimal, str]:
        features = capital_features_by_spec.get(candidate_spec_id, {})
        feasible = Decimal(str(features.get("capital_feasible_flag", 0)))
        overage = Decimal(str(features.get("capital_budget_overage_ratio", 0)))
        return (0 if feasible >= Decimal("1") else 1, overage, candidate_spec_id)

    max_budget = max(1, int(max_candidates))
    model_confidence = _proposal_score_confidence(proposal_rows)
    requested_exploration_slots = max(0, int(exploration_slots))
    effective_exploration_slots = requested_exploration_slots + (
        1 if model_confidence["confidence"] == "low" else 0
    )
    requested_budget = max(0, int(top_k)) + effective_exploration_slots
    diversification_floor = min(len(specs), 3)
    replay_budget = min(
        max_budget,
        max(1, int(portfolio_size_min), requested_budget, diversification_floor),
    )
    ranked_ids = [
        str(row.get("candidate_spec_id"))
        for row in sorted(
            _list_of_mappings(list(proposal_rows)),
            key=lambda row: (
                *capital_sort_key(str(row.get("candidate_spec_id") or ""))[:2],
                int(row.get("rank") or 10**9),
                -float(row.get("proposal_score") or 0.0),
                str(row.get("candidate_spec_id") or ""),
            ),
        )
        if str(row.get("candidate_spec_id")) in spec_by_id
    ]
    ranked_ids.extend(
        spec.candidate_spec_id
        for spec in sorted(
            specs,
            key=lambda item: (*capital_sort_key(item.candidate_spec_id),),
        )
        if spec.candidate_spec_id not in set(ranked_ids)
    )
    ordered = [spec_by_id[candidate_spec_id] for candidate_spec_id in ranked_ids]
    representative_by_signature: dict[str, CandidateSpec] = {}
    ordered_unique: list[CandidateSpec] = []
    for spec in ordered:
        execution_signature = execution_signature_by_spec[spec.candidate_spec_id]
        if execution_signature in representative_by_signature:
            continue
        representative_by_signature[execution_signature] = spec
        ordered_unique.append(spec)
    block_reason_by_spec = {
        spec.candidate_spec_id: reason
        for spec in ordered_unique
        if (reason := pre_replay_block_reason(spec))
    }
    ordered_eligible = [
        spec
        for spec in ordered_unique
        if spec.candidate_spec_id not in block_reason_by_spec
    ]
    synthetic_prior_probe_candidates = [
        spec
        for spec in ordered_unique
        if block_reason_by_spec.get(spec.candidate_spec_id)
        == "pre_replay_mlx_synthetic_nonpositive_expected_value"
    ]
    feedback_block_reaudit_candidates = [
        spec
        for spec in ordered_unique
        if is_feedback_block_reason(
            block_reason_by_spec.get(spec.candidate_spec_id, "")
        )
        and block_reason_by_spec.get(spec.candidate_spec_id)
        != "pre_replay_mlx_no_activity_feedback_blocked"
    ]
    rank_position_by_spec = {
        spec.candidate_spec_id: index for index, spec in enumerate(ordered, start=1)
    }
    synthetic_prior_probe_capacity = min(
        requested_exploration_slots,
        len(synthetic_prior_probe_candidates),
    )
    requested_feedback_block_reaudit_slots = max(0, int(feedback_block_reaudit_slots))
    feedback_block_reaudit_capacity = min(
        requested_feedback_block_reaudit_slots,
        len(feedback_block_reaudit_candidates),
    )
    replay_budget = min(
        replay_budget,
        len(ordered_eligible)
        + synthetic_prior_probe_capacity
        + feedback_block_reaudit_capacity,
    )

    def spec_source_run_id(spec: CandidateSpec) -> str:
        return _string(spec.feature_contract.get("source_run_id")) or spec.hypothesis_id

    def spec_universe_key(spec: CandidateSpec) -> str:
        universe = spec.strategy_overrides.get("universe_symbols")
        if not isinstance(universe, Sequence) or isinstance(universe, str):
            return ""
        return ",".join(
            sorted(_string(item).upper() for item in universe if _string(item))
        )

    def spec_signal_key(spec: CandidateSpec) -> str:
        params = _mapping(spec.strategy_overrides.get("params"))
        return "|".join(
            part
            for part in (
                _string(params.get("signal_motif")),
                _string(params.get("selection_mode")),
                _string(params.get("rank_feature")),
            )
            if part
        )

    def spec_param_text(spec: CandidateSpec, key: str) -> str:
        params = _mapping(spec.strategy_overrides.get("params"))
        return _string(params.get(key))

    def diversity_key(
        spec: CandidateSpec, selected_so_far: Sequence[CandidateSpec]
    ) -> tuple[bool, bool, bool, bool, bool, int, int, str]:
        selected_families = {item.family_template_id for item in selected_so_far}
        selected_runtime_strategies = {
            item.runtime_strategy_name for item in selected_so_far
        }
        selected_universes = {spec_universe_key(item) for item in selected_so_far}
        selected_signals = {spec_signal_key(item) for item in selected_so_far}
        selected_sources = {spec_source_run_id(item) for item in selected_so_far}
        family_selection = _mapping(spec.feature_contract.get("family_selection"))
        return (
            spec.family_template_id in selected_families,
            spec.runtime_strategy_name in selected_runtime_strategies,
            bool(spec_universe_key(spec))
            and spec_universe_key(spec) in selected_universes,
            bool(spec_signal_key(spec)) and spec_signal_key(spec) in selected_signals,
            spec_source_run_id(spec) in selected_sources,
            rank_position_by_spec.get(spec.candidate_spec_id, 10**6),
            int(family_selection.get("rank") or 10**6),
            spec.candidate_spec_id,
        )

    def take_diverse(
        candidates: Sequence[CandidateSpec],
        *,
        count: int,
        selected_so_far: Sequence[CandidateSpec],
    ) -> list[CandidateSpec]:
        pool = list(candidates)
        picked: list[CandidateSpec] = []
        while pool and len(picked) < count:
            best = min(
                pool,
                key=lambda spec: diversity_key(spec, [*selected_so_far, *picked]),
            )
            picked.append(best)
            pool.remove(best)
        return picked

    def interleave_replay_segments(
        *segments: Sequence[CandidateSpec],
    ) -> list[CandidateSpec]:
        interleaved: list[CandidateSpec] = []
        max_length = max((len(segment) for segment in segments), default=0)
        for index in range(max_length):
            for segment in segments:
                if index < len(segment):
                    interleaved.append(segment[index])
        return interleaved

    active_loss_counter_candidates = [
        spec
        for spec in ordered_eligible
        if proposal_selection_reason(spec.candidate_spec_id)
        == "pre_replay_mlx_active_loss_counter_candidate"
    ]
    active_loss_counter_cap = 4
    if replay_budget <= 4:
        active_loss_counter_cap = max(1, replay_budget // 2)
    active_loss_counter_count = min(
        active_loss_counter_cap,
        max(0, requested_exploration_slots),
        replay_budget,
        len(active_loss_counter_candidates),
    )
    active_loss_counter = take_diverse(
        active_loss_counter_candidates,
        count=active_loss_counter_count,
        selected_so_far=(),
    )
    active_loss_counter_ids = {spec.candidate_spec_id for spec in active_loss_counter}
    consistency_repair_candidates = [
        spec
        for spec in ordered_eligible
        if spec.candidate_spec_id not in active_loss_counter_ids
        if proposal_selection_reason(spec.candidate_spec_id)
        == "pre_replay_mlx_consistency_repair_candidate"
    ]
    consistency_repair_cap = 4
    if replay_budget <= 4:
        consistency_repair_cap = max(1, replay_budget // 2)
    consistency_repair_count = min(
        consistency_repair_cap,
        max(0, requested_exploration_slots - len(active_loss_counter)),
        replay_budget - len(active_loss_counter),
        len(consistency_repair_candidates),
    )
    consistency_repair = take_diverse(
        consistency_repair_candidates,
        count=consistency_repair_count,
        selected_so_far=active_loss_counter,
    )
    consistency_repair_ids = {spec.candidate_spec_id for spec in consistency_repair}

    runtime_strategy_floor_priority = {
        "intraday-tsmom-profit-v3": 0,
        "late-day-continuation-long-v1": 1,
        "microbar-cross-sectional-pairs-v1": 2,
        "breakout-continuation-long-v1": 3,
    }
    runtime_strategy_representatives: dict[str, CandidateSpec] = {}
    for spec in sorted(
        ordered_eligible,
        key=lambda item: (
            runtime_strategy_floor_priority.get(item.runtime_strategy_name, 100),
            rank_position_by_spec.get(item.candidate_spec_id, 10**6),
            item.candidate_spec_id,
        ),
    ):
        if spec.candidate_spec_id in active_loss_counter_ids | consistency_repair_ids:
            continue
        if spec.runtime_strategy_name not in runtime_strategy_representatives:
            runtime_strategy_representatives[spec.runtime_strategy_name] = spec
    runtime_strategy_floor = (
        list(runtime_strategy_representatives.values())[
            : min(4, replay_budget - len(active_loss_counter) - len(consistency_repair))
        ]
        if len(runtime_strategy_representatives) > 1
        and replay_budget > len(active_loss_counter) + len(consistency_repair)
        else []
    )
    runtime_strategy_floor_ids = {
        spec.candidate_spec_id for spec in runtime_strategy_floor
    }
    paper_contract_candidates = [
        spec
        for spec in ordered_eligible
        if spec.candidate_spec_id not in active_loss_counter_ids
        if spec.candidate_spec_id not in consistency_repair_ids
        if spec.candidate_spec_id not in runtime_strategy_floor_ids
        if _paper_mechanism_prior_score(spec) > Decimal("0")
    ]
    paper_contract_count = min(
        3,
        max(
            0,
            requested_exploration_slots
            - len(active_loss_counter)
            - len(consistency_repair),
        ),
        replay_budget
        - len(active_loss_counter)
        - len(consistency_repair)
        - len(runtime_strategy_floor),
        len(paper_contract_candidates),
    )
    paper_contract_exploration = take_diverse(
        paper_contract_candidates,
        count=paper_contract_count,
        selected_so_far=[
            *active_loss_counter,
            *consistency_repair,
            *runtime_strategy_floor,
        ],
    )
    paper_contract_exploration_ids = {
        spec.candidate_spec_id for spec in paper_contract_exploration
    }
    false_negative_rescue_candidates = [
        spec
        for spec in ordered_eligible
        if spec.candidate_spec_id not in runtime_strategy_floor_ids
        if spec.candidate_spec_id not in active_loss_counter_ids
        if spec.candidate_spec_id not in consistency_repair_ids
        if spec.candidate_spec_id not in paper_contract_exploration_ids
        if _candidate_spec_is_false_negative_rescue(spec)
    ]
    false_negative_rescue_count = min(
        3,
        max(0, requested_exploration_slots - len(consistency_repair)),
        replay_budget
        - len(active_loss_counter)
        - len(consistency_repair)
        - len(runtime_strategy_floor)
        - len(paper_contract_exploration),
        len(false_negative_rescue_candidates),
    )
    false_negative_rescue_exploration = take_diverse(
        false_negative_rescue_candidates,
        count=false_negative_rescue_count,
        selected_so_far=[
            *active_loss_counter,
            *consistency_repair,
            *runtime_strategy_floor,
            *paper_contract_exploration,
        ],
    )
    false_negative_rescue_ids = {
        spec.candidate_spec_id for spec in false_negative_rescue_exploration
    }
    exploitation_candidates = [
        spec
        for spec in ordered_eligible
        if spec.candidate_spec_id
        not in active_loss_counter_ids
        | consistency_repair_ids
        | runtime_strategy_floor_ids
        | paper_contract_exploration_ids
        | false_negative_rescue_ids
    ]
    exploitation_count = min(
        max(0, int(top_k)),
        replay_budget
        - len(active_loss_counter)
        - len(consistency_repair)
        - len(runtime_strategy_floor)
        - len(paper_contract_exploration)
        - len(false_negative_rescue_exploration),
        len(exploitation_candidates),
    )
    exploitation = take_diverse(
        exploitation_candidates,
        count=exploitation_count,
        selected_so_far=[
            *active_loss_counter,
            *consistency_repair,
            *runtime_strategy_floor,
            *paper_contract_exploration,
            *false_negative_rescue_exploration,
        ],
    )
    remaining = [
        item
        for item in sorted(
            ordered_eligible,
            key=lambda spec: diversity_key(
                spec,
                [
                    *active_loss_counter,
                    *consistency_repair,
                    *runtime_strategy_floor,
                    *paper_contract_exploration,
                    *false_negative_rescue_exploration,
                    *exploitation,
                ],
            ),
        )
        if item.candidate_spec_id
        not in {
            spec.candidate_spec_id
            for spec in (
                *runtime_strategy_floor,
                *active_loss_counter,
                *consistency_repair,
                *paper_contract_exploration,
                *false_negative_rescue_exploration,
                *exploitation,
            )
        }
    ]
    exploration_count = min(
        effective_exploration_slots,
        replay_budget
        - len(active_loss_counter)
        - len(consistency_repair)
        - len(runtime_strategy_floor)
        - len(paper_contract_exploration)
        - len(false_negative_rescue_exploration)
        - len(exploitation),
        len(remaining),
    )
    exploration = take_diverse(
        remaining,
        count=exploration_count,
        selected_so_far=[
            *runtime_strategy_floor,
            *active_loss_counter,
            *consistency_repair,
            *paper_contract_exploration,
            *false_negative_rescue_exploration,
            *exploitation,
        ],
    )
    synthetic_prior_probe_exploration_count = min(
        max(0, requested_exploration_slots - len(exploration)),
        replay_budget
        - len(active_loss_counter)
        - len(consistency_repair)
        - len(runtime_strategy_floor)
        - len(paper_contract_exploration)
        - len(false_negative_rescue_exploration)
        - len(exploitation)
        - len(exploration),
        len(synthetic_prior_probe_candidates),
    )
    synthetic_prior_probe_exploration = take_diverse(
        synthetic_prior_probe_candidates,
        count=synthetic_prior_probe_exploration_count,
        selected_so_far=[
            *runtime_strategy_floor,
            *active_loss_counter,
            *consistency_repair,
            *paper_contract_exploration,
            *false_negative_rescue_exploration,
            *exploitation,
            *exploration,
        ],
    )
    feedback_block_reaudit_count = min(
        requested_feedback_block_reaudit_slots,
        replay_budget
        - len(active_loss_counter)
        - len(consistency_repair)
        - len(runtime_strategy_floor)
        - len(paper_contract_exploration)
        - len(false_negative_rescue_exploration)
        - len(exploitation)
        - len(exploration)
        - len(synthetic_prior_probe_exploration),
        len(feedback_block_reaudit_candidates),
    )
    feedback_block_reaudit = take_diverse(
        feedback_block_reaudit_candidates,
        count=feedback_block_reaudit_count,
        selected_so_far=[
            *runtime_strategy_floor,
            *active_loss_counter,
            *consistency_repair,
            *paper_contract_exploration,
            *false_negative_rescue_exploration,
            *exploitation,
            *exploration,
            *synthetic_prior_probe_exploration,
        ],
    )
    if (
        len(runtime_strategy_floor)
        + len(active_loss_counter)
        + len(consistency_repair)
        + len(paper_contract_exploration)
        + len(false_negative_rescue_exploration)
        + len(exploitation)
        + len(exploration)
        < replay_budget
    ):
        selected_ids = {
            item.candidate_spec_id
            for item in (
                *runtime_strategy_floor,
                *active_loss_counter,
                *consistency_repair,
                *paper_contract_exploration,
                *false_negative_rescue_exploration,
                *exploitation,
                *exploration,
                *synthetic_prior_probe_exploration,
                *feedback_block_reaudit,
            )
        }
        backfill_candidates = [
            item
            for item in ordered_eligible
            if item.candidate_spec_id not in selected_ids
        ]
        backfill = take_diverse(
            backfill_candidates,
            count=replay_budget
            - len(active_loss_counter)
            - len(consistency_repair)
            - len(runtime_strategy_floor)
            - len(paper_contract_exploration)
            - len(false_negative_rescue_exploration)
            - len(exploitation)
            - len(exploration)
            - len(synthetic_prior_probe_exploration)
            - len(feedback_block_reaudit),
            selected_so_far=[
                *runtime_strategy_floor,
                *active_loss_counter,
                *consistency_repair,
                *paper_contract_exploration,
                *false_negative_rescue_exploration,
                *exploitation,
                *exploration,
                *synthetic_prior_probe_exploration,
                *feedback_block_reaudit,
            ],
        )
    else:
        backfill = []
    selected_reason = (
        {
            item.candidate_spec_id: "active_loss_counter_candidate"
            for item in active_loss_counter
        }
        | {
            item.candidate_spec_id: "consistency_repair_candidate"
            for item in consistency_repair
        }
        | {
            item.candidate_spec_id: "runtime_strategy_floor"
            for item in runtime_strategy_floor
        }
        | {
            item.candidate_spec_id: "paper_contract_exploration"
            for item in paper_contract_exploration
        }
        | {
            item.candidate_spec_id: "false_negative_rescue_exploration"
            for item in false_negative_rescue_exploration
        }
        | {item.candidate_spec_id: "exploitation" for item in exploitation}
        | {item.candidate_spec_id: "exploration" for item in exploration}
    )
    selected_reason.update(
        {
            item.candidate_spec_id: "synthetic_prior_exploration"
            for item in synthetic_prior_probe_exploration
        }
    )
    selected_reason.update(
        {
            item.candidate_spec_id: "feedback_block_reaudit"
            for item in feedback_block_reaudit
        }
    )
    selected_reason.update(
        {item.candidate_spec_id: "budget_backfill" for item in backfill}
    )
    selected = [
        *active_loss_counter,
        *consistency_repair,
        *runtime_strategy_floor,
        *paper_contract_exploration,
        *false_negative_rescue_exploration,
        *exploitation,
        *exploration,
        *interleave_replay_segments(
            feedback_block_reaudit,
            synthetic_prior_probe_exploration,
        ),
        *backfill,
    ]
    selected_ids = {item.candidate_spec_id for item in selected}
    selected_pre_replay_blocked_ids = {
        item.candidate_spec_id for item in synthetic_prior_probe_exploration
    } | {item.candidate_spec_id for item in feedback_block_reaudit}
    replay_order_by_spec = {
        item.candidate_spec_id: index for index, item in enumerate(selected, start=1)
    }

    def row_selection_reason(spec: CandidateSpec) -> str:
        if spec.candidate_spec_id in selected_reason:
            return selected_reason[spec.candidate_spec_id]
        representative = representative_by_signature[
            execution_signature_by_spec[spec.candidate_spec_id]
        ]
        if representative.candidate_spec_id != spec.candidate_spec_id:
            return "duplicate_execution_signature"
        block_reason = block_reason_by_spec.get(spec.candidate_spec_id)
        if block_reason:
            return block_reason
        return "not_selected_budget"

    rows = [
        {
            "candidate_spec_id": spec.candidate_spec_id,
            "family_template_id": spec.family_template_id,
            "runtime_family": spec.runtime_family,
            "runtime_strategy_name": spec.runtime_strategy_name,
            "capital_profile": spec_param_text(spec, "capital_profile") or None,
            "feedback_remediation_profile": spec_param_text(
                spec, "feedback_remediation_profile"
            )
            or None,
            "universe_key": spec_universe_key(spec),
            "signal_key": spec_signal_key(spec),
            "execution_signature": execution_signature_by_spec[spec.candidate_spec_id],
            "duplicate_of_candidate_spec_id": representative_by_signature[
                execution_signature_by_spec[spec.candidate_spec_id]
            ].candidate_spec_id
            if representative_by_signature[
                execution_signature_by_spec[spec.candidate_spec_id]
            ].candidate_spec_id
            != spec.candidate_spec_id
            else None,
            "pre_replay_score": str(_pre_replay_candidate_score(spec)),
            "paper_contract_prior_score": str(_paper_mechanism_prior_score(spec)),
            "paper_mechanism_overlay_ids": sorted(
                _candidate_spec_mechanism_overlay_ids(spec)
            ),
            "paper_required_evidence_tokens": sorted(
                _candidate_spec_required_evidence_tokens(spec)
            ),
            "paper_required_evidence_count": len(
                _candidate_spec_required_evidence_tokens(spec)
            ),
            "proposal_score": proposal_by_spec.get(spec.candidate_spec_id, {}).get(
                "proposal_score"
            ),
            "proposal_training_source": proposal_training_source(
                spec.candidate_spec_id
            ),
            "capital_budget": {
                "max_notional_per_trade": str(
                    capital_features_by_spec[spec.candidate_spec_id][
                        "max_notional_per_trade"
                    ]
                ),
                "max_notional_pct_start_equity": str(
                    capital_features_by_spec[spec.candidate_spec_id][
                        "max_notional_pct_start_equity"
                    ]
                ),
                "max_position_pct_equity": str(
                    capital_features_by_spec[spec.candidate_spec_id][
                        "max_position_pct_equity"
                    ]
                ),
                "max_trade_pct_equity": str(
                    capital_features_by_spec[spec.candidate_spec_id][
                        "max_trade_pct_equity"
                    ]
                ),
                "estimated_max_gross_exposure_pct_equity": str(
                    capital_features_by_spec[spec.candidate_spec_id][
                        "estimated_max_gross_exposure_pct_equity"
                    ]
                ),
                "estimated_capital_slot_count": str(
                    capital_features_by_spec[spec.candidate_spec_id][
                        "estimated_capital_slot_count"
                    ]
                ),
                "entry_notional_max_multiplier": str(
                    capital_features_by_spec[spec.candidate_spec_id][
                        "entry_notional_max_multiplier"
                    ]
                ),
                "configured_daily_notional_capacity": str(
                    capital_features_by_spec[spec.candidate_spec_id][
                        "configured_daily_notional_capacity"
                    ]
                ),
                "capital_budget_overage_ratio": str(
                    capital_features_by_spec[spec.candidate_spec_id][
                        "capital_budget_overage_ratio"
                    ]
                ),
                "capital_feasible": bool(
                    capital_features_by_spec[spec.candidate_spec_id][
                        "capital_feasible_flag"
                    ]
                ),
            },
            "rank": index,
            "selected_for_replay": spec.candidate_spec_id in selected_ids,
            "selection_reason": row_selection_reason(spec),
            "replay_order": replay_order_by_spec.get(spec.candidate_spec_id),
            "selection_hash": _stable_hash(
                {
                    "candidate_spec_id": spec.candidate_spec_id,
                    "score": str(_pre_replay_candidate_score(spec)),
                    "selected": spec.candidate_spec_id in selected_ids,
                    "replay_order": replay_order_by_spec.get(spec.candidate_spec_id),
                }
            ),
        }
        for index, spec in enumerate(ordered, start=1)
    ]
    return selected, {
        "schema_version": "torghut.whitepaper-autoresearch-selection.v1",
        "budget": {
            "max_candidates": max_budget,
            "top_k": max(0, int(top_k)),
            "exploration_slots_requested": requested_exploration_slots,
            "exploration_slots_effective": effective_exploration_slots,
            "exploration_slots": effective_exploration_slots,
            "feedback_block_reaudit_slots_requested": requested_feedback_block_reaudit_slots,
            "feedback_block_reaudit_slots_effective": feedback_block_reaudit_capacity,
            "feedback_block_reaudit_selected_count": len(feedback_block_reaudit),
            "active_loss_counter_candidate_selected_count": len(active_loss_counter),
            "consistency_repair_candidate_selected_count": len(consistency_repair),
            "runtime_strategy_floor_selected_count": len(runtime_strategy_floor),
            "paper_contract_candidate_selected_count": len(paper_contract_exploration),
            "portfolio_size_min": max(1, int(portfolio_size_min)),
            "selected_count": len(selected),
            "compiled_candidate_count": len(specs),
            "unique_execution_signature_count": len(ordered_unique),
            "eligible_candidate_count": len(ordered_eligible),
            "pre_replay_feedback_blocked_candidate_count": sum(
                1
                for reason in block_reason_by_spec.values()
                if is_feedback_block_reason(reason)
            ),
            "pre_replay_nonpositive_synthetic_candidate_count": sum(
                1
                for reason in block_reason_by_spec.values()
                if reason == "pre_replay_mlx_synthetic_nonpositive_expected_value"
            ),
            "pre_replay_synthetic_capacity_insufficient_candidate_count": sum(
                1
                for reason in block_reason_by_spec.values()
                if reason == "pre_replay_synthetic_capacity_insufficient"
            ),
            "pre_replay_nonpositive_synthetic_exploration_count": len(
                synthetic_prior_probe_exploration
            ),
            "pre_replay_capital_blocked_candidate_count": sum(
                1
                for reason in block_reason_by_spec.values()
                if reason == capital_block_reason
            ),
            "pre_replay_blocked_candidate_count": sum(
                1
                for candidate_spec_id in block_reason_by_spec
                if candidate_spec_id not in selected_pre_replay_blocked_ids
            ),
            "replay_order_policy": "quality_gated_diversity_pick_order_with_consistency_repair_paper_contract_probe_synthetic_prior_probe_and_feedback_reaudit",
            "capital_feasible_candidate_count": sum(
                1
                for features in capital_features_by_spec.values()
                if Decimal(str(features.get("capital_feasible_flag", 0)))
                >= Decimal("1")
            ),
        },
        "proposal_score_confidence": model_confidence,
        "selected_candidate_spec_ids": [item.candidate_spec_id for item in selected],
        "rows": rows,
    }


def _candidate_selection_for_direct_replay(
    *,
    specs: Sequence[CandidateSpec],
    proposal_rows: Sequence[Mapping[str, Any]],
    candidate_specs_paths: Sequence[Path],
) -> dict[str, Any]:
    proposal_by_spec = {
        _string(row.get("candidate_spec_id")): row
        for row in _list_of_mappings(list(proposal_rows))
        if _string(row.get("candidate_spec_id"))
    }
    rows: list[dict[str, Any]] = []
    for index, spec in enumerate(specs, start=1):
        params = _mapping(spec.strategy_overrides.get("params"))
        universe = spec.strategy_overrides.get("universe_symbols")
        universe_key = (
            ",".join(
                sorted(_string(item).upper() for item in universe if _string(item))
            )
            if isinstance(universe, Sequence) and not isinstance(universe, str)
            else ""
        )
        proposal = _mapping(proposal_by_spec.get(spec.candidate_spec_id))
        rows.append(
            {
                "candidate_spec_id": spec.candidate_spec_id,
                "family_template_id": spec.family_template_id,
                "runtime_family": spec.runtime_family,
                "runtime_strategy_name": spec.runtime_strategy_name,
                "capital_profile": _string(params.get("capital_profile")) or None,
                "feedback_remediation_profile": _string(
                    params.get("feedback_remediation_profile")
                )
                or None,
                "universe_key": universe_key,
                "signal_key": "|".join(
                    part
                    for part in (
                        _string(params.get("signal_motif")),
                        _string(params.get("selection_mode")),
                        _string(params.get("rank_feature")),
                    )
                    if part
                ),
                "execution_signature": _candidate_spec_execution_signature(spec),
                "duplicate_of_candidate_spec_id": None,
                "pre_replay_score": str(_pre_replay_candidate_score(spec)),
                "paper_contract_prior_score": str(_paper_mechanism_prior_score(spec)),
                "paper_mechanism_overlay_ids": sorted(
                    _candidate_spec_mechanism_overlay_ids(spec)
                ),
                "paper_required_evidence_tokens": sorted(
                    _candidate_spec_required_evidence_tokens(spec)
                ),
                "paper_required_evidence_count": len(
                    _candidate_spec_required_evidence_tokens(spec)
                ),
                "proposal_score": proposal.get("proposal_score"),
                "proposal_training_source": proposal.get("training_source")
                or "direct_candidate_specs_handoff",
                "rank": index,
                "selected_for_replay": True,
                "selection_reason": "direct_candidate_specs_handoff",
                "replay_order": index,
                "selection_hash": _stable_hash(
                    {
                        "candidate_spec_id": spec.candidate_spec_id,
                        "source_paths": [str(path) for path in candidate_specs_paths],
                        "replay_order": index,
                    }
                ),
            }
        )
    return {
        "schema_version": "torghut.whitepaper-autoresearch-selection.v1",
        "selection_mode": "direct_candidate_specs_handoff",
        "candidate_specs_artifacts": [str(path) for path in candidate_specs_paths],
        "budget": {
            "max_candidates": len(specs),
            "top_k": len(specs),
            "exploration_slots_requested": 0,
            "exploration_slots_effective": 0,
            "exploration_slots": 0,
            "feedback_block_reaudit_slots_requested": 0,
            "feedback_block_reaudit_slots_effective": 0,
            "feedback_block_reaudit_selected_count": 0,
            "portfolio_size_min": 1,
            "selected_count": len(specs),
            "compiled_candidate_count": len(specs),
            "unique_execution_signature_count": len(
                {_candidate_spec_execution_signature(spec) for spec in specs}
            ),
            "eligible_candidate_count": len(specs),
            "replay_order_policy": "preserve_candidate_specs_jsonl_order",
            "capital_feasible_candidate_count": sum(
                1
                for spec in specs
                if Decimal(
                    str(
                        candidate_spec_capital_features(spec).get(
                            "capital_feasible_flag", 0
                        )
                    )
                )
                >= Decimal("1")
            ),
        },
        "proposal_score_confidence": _proposal_score_confidence(proposal_rows),
        "selected_candidate_spec_ids": [spec.candidate_spec_id for spec in specs],
        "rows": rows,
    }


def _apply_fast_replay_preview_narrowing(
    *,
    args: argparse.Namespace,
    output_dir: Path,
    specs: Sequence[CandidateSpec],
    candidate_selection: Mapping[str, Any],
) -> tuple[list[CandidateSpec], dict[str, Any]]:
    preview_top_k = _resolved_fast_replay_preview_top_k(args)
    if preview_top_k <= 0:
        return list(specs), dict(candidate_selection)
    if str(getattr(args, "replay_mode", "") or "") != "real":
        raise ValueError("fast_replay_preview_requires_real_replay")
    tape_path = getattr(args, "replay_tape_path", None)
    if tape_path is None:
        raise ValueError("fast_replay_preview_requires_replay_tape_path")
    exact_replay_candidate_cap = _resolved_fast_replay_exact_candidate_cap(
        args,
        preview_top_k=preview_top_k,
    )
    exploitation_slots = max(
        0,
        int(
            getattr(
                args,
                "replay_tape_frontier_exploitation_slots",
                _DEFAULT_FAST_REPLAY_EXPLOITATION_SLOTS,
            )
            or 0
        ),
    )
    exploration_slots = max(
        0,
        int(
            getattr(
                args,
                "replay_tape_frontier_exploration_slots",
                _DEFAULT_FAST_REPLAY_EXPLORATION_SLOTS,
            )
            or 0
        ),
    )

    start_date = _fast_replay_preview_date_arg(args, "full_window_start_date")
    end_date = _fast_replay_preview_date_arg(args, "full_window_end_date")
    tape = load_replay_tape(
        Path(tape_path).resolve(),
        manifest_path=(
            Path(args.replay_tape_manifest).resolve()
            if getattr(args, "replay_tape_manifest", None) is not None
            else None
        ),
    )
    validation = validate_tape_freshness(
        tape.manifest,
        start_date=start_date,
        end_date=end_date,
        symbols=_candidate_universe_symbols_from_args(args),
        allow_stale_tape=bool(getattr(args, "allow_stale_tape", False)),
    )
    selected_rows = slice_tape_by_symbols(
        slice_tape_by_window(
            tape.rows,
            start_date=start_date,
            end_date=end_date,
        ),
        symbols=_candidate_universe_symbols_from_args(args),
    )
    preview = build_fast_replay_preview(
        specs=specs,
        rows=selected_rows,
        replay_tape_manifest=tape.manifest,
        top_k=preview_top_k,
        min_rows_per_candidate=max(
            1, int(getattr(args, "replay_tape_preview_min_rows", 2) or 2)
        ),
        exploitation_count=exploitation_slots,
        exploration_count=exploration_slots,
        exact_replay_candidate_cap=exact_replay_candidate_cap,
    )
    preview_scores_path = output_dir / "replay-tape-preview-scores.jsonl"
    preview_manifest_path = output_dir / "replay-tape-preview-manifest.json"
    _write_jsonl(preview_scores_path, [row.to_payload() for row in preview.rows])
    preview_manifest = {
        **preview.to_manifest_payload(),
        "validation": validation,
        "proof_semantics": _fast_replay_preview_proof_semantics(),
        "artifacts": {
            "scores_jsonl": str(preview_scores_path),
            "manifest_json": str(preview_manifest_path),
        },
    }
    _write_json(preview_manifest_path, preview_manifest)

    spec_by_id = {spec.candidate_spec_id: spec for spec in specs}
    narrowed_specs = [
        spec_by_id[candidate_spec_id]
        for candidate_spec_id in preview.selected_candidate_spec_ids
        if candidate_spec_id in spec_by_id
    ]
    if not narrowed_specs and specs and not preview.rows:
        narrowed_specs = [specs[0]]

    selected_ids = {spec.candidate_spec_id for spec in narrowed_specs}
    replay_order_by_spec = {
        spec.candidate_spec_id: index
        for index, spec in enumerate(narrowed_specs, start=1)
    }
    preview_row_by_spec = {
        row.candidate_spec_id: row.to_payload() for row in preview.rows
    }
    original_selected_ids = _selected_candidate_spec_ids(candidate_selection)
    updated_rows: list[dict[str, Any]] = []
    for row in _list_of_mappings(candidate_selection.get("rows")):
        candidate_spec_id = _string(row.get("candidate_spec_id"))
        updated = dict(row)
        preview_row = preview_row_by_spec.get(candidate_spec_id)
        if preview_row is not None:
            updated["fast_replay_preview_rank"] = preview_row["rank"]
            updated["fast_replay_preview_score"] = preview_row["preview_score"]
            updated["fast_replay_preview_selected"] = preview_row["selected"]
            updated["fast_replay_preview_selection_reason"] = preview_row[
                "selection_reason"
            ]
            updated["fast_replay_preview_matched_row_count"] = preview_row[
                "matched_row_count"
            ]
            updated["fast_replay_preview_ofi_pressure_score"] = preview_row[
                "ofi_pressure_score"
            ]
            updated["fast_replay_preview_microprice_bias_bps"] = preview_row[
                "microprice_bias_bps"
            ]
            updated["fast_replay_preview_spread_tail_bps"] = preview_row[
                "spread_tail_bps"
            ]
            updated["fast_replay_preview_return_tail_abs_bps"] = preview_row[
                "return_tail_abs_bps"
            ]
            updated["fast_replay_preview_impact_liquidity_penalty_bps"] = preview_row[
                "impact_liquidity_penalty_bps"
            ]
            updated["fast_replay_preview_observed_post_cost_expectancy_bps"] = (
                preview_row.get("observed_post_cost_expectancy_bps")
            )
            updated["fast_replay_preview_required_daily_notional"] = preview_row.get(
                "required_daily_notional"
            )
            updated["fast_replay_target_implied_notional_context"] = preview_row.get(
                "target_implied_notional_context"
            )
            updated["fast_replay_exact_replay_selection_blocked"] = preview_row.get(
                "exact_replay_selection_blocked"
            )
            updated["fast_replay_exact_replay_selection_blockers"] = list(
                cast(
                    Sequence[Any],
                    preview_row.get("exact_replay_selection_blockers") or (),
                )
            )
            updated["fast_replay_cost_impact_lineage"] = preview_row.get(
                "cost_impact_lineage"
            )
            updated["fast_replay_adv_capacity_context"] = preview_row.get(
                "adv_capacity_context"
            )
            updated["fast_replay_lineage_blockers"] = list(
                cast(Sequence[Any], preview_row.get("lineage_blockers") or ())
            )
            updated["fast_replay_risk_flags"] = list(
                cast(Sequence[Any], preview_row.get("risk_flags") or ())
            )
            updated["fast_replay_frontier_bucket"] = preview_row["frontier_bucket"]
            updated["fast_replay_candidate_frontier_hash"] = preview_row.get(
                "candidate_frontier_hash"
            )
            updated["fast_replay_exact_replay_frontier_key"] = preview_row.get(
                "exact_replay_frontier_key"
            )
            updated["fast_replay_frontier_dedupe_status"] = preview_row.get(
                "frontier_dedupe_status"
            )
            updated["fast_replay_frontier_dedupe_metadata"] = preview_row.get(
                "frontier_dedupe_metadata"
            )
            updated["fast_replay_proof_semantics_label"] = preview_row[
                "proof_semantics_label"
            ]
            updated["fast_replay_prefilter_only"] = True
            updated["fast_replay_promotion_proof"] = False
            updated["fast_replay_proof_authority"] = False
            updated["fast_replay_promotion_authority"] = False
            updated["fast_replay_promotion_allowed"] = False
            updated["fast_replay_final_promotion_allowed"] = False
            updated["fast_replay_final_authority_ok"] = False
            microstructure_prefilter = _mapping(
                preview_row.get("hpairs_microstructure_prefilter")
                or preview_row.get("microstructure_prefilter")
            )
            if microstructure_prefilter:
                updated["hpairs_microstructure_prefilter_rank"] = (
                    microstructure_prefilter.get("rank")
                )
                updated["hpairs_microstructure_prefilter_score"] = (
                    microstructure_prefilter.get("prefilter_score")
                )
                updated["hpairs_microstructure_behavior_bucket"] = _mapping(
                    microstructure_prefilter.get("cluster_behavior")
                ).get("behavior_bucket")
                updated["hpairs_microstructure_macro_window_stress"] = _mapping(
                    microstructure_prefilter.get("macro_window_stress")
                )
                updated["hpairs_microstructure_impact_capacity_lineage"] = _mapping(
                    microstructure_prefilter.get("impact_capacity_lineage")
                )
                updated["hpairs_microstructure_source_input_blockers"] = list(
                    cast(
                        Sequence[Any],
                        microstructure_prefilter.get("source_input_blockers") or (),
                    )
                )
                updated["hpairs_microstructure_proof_source"] = (
                    microstructure_prefilter.get("proof_source")
                )
        if candidate_spec_id in original_selected_ids:
            updated["pre_fast_replay_preview_selected_for_replay"] = bool(
                row.get("selected_for_replay")
            )
            updated["selected_for_replay"] = candidate_spec_id in selected_ids
            updated["replay_order"] = replay_order_by_spec.get(candidate_spec_id)
            if candidate_spec_id not in selected_ids:
                updated["selection_reason"] = "fast_replay_preview_filtered"
        updated_rows.append(updated)

    updated_selection = {
        **dict(candidate_selection),
        "budget": {
            **_mapping(candidate_selection.get("budget")),
            "fast_replay_preview_enabled": True,
            "fast_replay_preview_requested_top_k": preview_top_k,
            "fast_replay_exact_replay_candidate_cap": exact_replay_candidate_cap,
            "fast_replay_frontier_exploitation_slots": exploitation_slots,
            "fast_replay_frontier_exploration_slots": exploration_slots,
            "fast_replay_preview_selected_count": len(narrowed_specs),
            "pre_fast_replay_preview_selected_count": len(specs),
            "selected_count": len(narrowed_specs),
        },
        "selected_candidate_spec_ids": [
            spec.candidate_spec_id for spec in narrowed_specs
        ],
        "rows": updated_rows,
        "replay_tape_preview": {
            **preview_manifest,
            "scores_artifact": str(preview_scores_path),
            "manifest_artifact": str(preview_manifest_path),
        },
        "bounded_sim_target_queue": _bounded_sim_target_queue_metadata(
            preview_rows=[row.to_payload() for row in preview.rows],
            replay_tape_manifest=tape.manifest,
            exact_replay_candidate_cap=exact_replay_candidate_cap,
            exploitation_slots=exploitation_slots,
            exploration_slots=exploration_slots,
        ),
    }
    return narrowed_specs, updated_selection


def _resolved_fast_replay_preview_top_k(args: argparse.Namespace) -> int:
    explicit_top_k = max(
        0,
        int(getattr(args, "replay_tape_preview_top_k", 0) or 0),
    )
    if explicit_top_k > 0:
        return explicit_top_k
    if not bool(getattr(args, "staged_replay_frontier_default", False)):
        return 0
    if bool(getattr(args, "disable_staged_replay_frontier", False)):
        return 0
    if str(getattr(args, "replay_mode", "") or "") != "real":
        return 0
    if getattr(args, "replay_tape_path", None) is None:
        return 0
    return max(
        _DEFAULT_FAST_REPLAY_PREVIEW_TOP_K,
        int(getattr(args, "max_candidates", 0) or 0),
    )


def _resolved_fast_replay_exact_candidate_cap(
    args: argparse.Namespace,
    *,
    preview_top_k: int,
) -> int:
    requested_cap = max(
        1,
        int(
            getattr(
                args,
                "replay_tape_exact_candidate_cap",
                _DEFAULT_FAST_REPLAY_EXACT_CANDIDATE_CAP,
            )
            or _DEFAULT_FAST_REPLAY_EXACT_CANDIDATE_CAP
        ),
    )
    requested_cap = min(requested_cap, _DEFAULT_FAST_REPLAY_EXACT_CANDIDATE_CAP)
    return max(1, min(max(1, preview_top_k), requested_cap))


def _fast_replay_preview_proof_semantics() -> dict[str, Any]:
    return {
        "schema_version": "torghut.fast-replay-proof-semantics.v1",
        "label": FAST_REPLAY_PROOF_SEMANTICS_LABEL,
        "promotion_proof": False,
        "proof_authority": False,
        "promotion_authority": False,
        "promotion_allowed": False,
        "final_promotion_allowed": False,
        "final_authority_ok": False,
        "authority": "preview_prefilter_only",
        "prefilter_only": True,
        "no_kubernetes_fanout": True,
        "default_local_worker_cap": _DEFAULT_REAL_REPLAY_SHARD_WORKERS,
        "default_shard_timeout_seconds": _DEFAULT_REAL_REPLAY_SHARD_TIMEOUT_SECONDS,
        "default_parallel_frontier_candidate_cap": (
            _DEFAULT_REAL_REPLAY_MAX_PARALLEL_FRONTIER_CANDIDATES
        ),
        "safe_exact_replay_candidate_cap": _DEFAULT_FAST_REPLAY_EXACT_CANDIDATE_CAP,
        "final_promotion_requires": [
            "exact_replay_evidence",
            "source_backed_runtime_ledger",
            "live_paper_runtime_evidence",
            "unchanged_promotion_gates",
        ],
        "whitepaper_gpu_fast_replay_policy": (
            "whitepaper-derived fast/GPU preview signals rank candidates only and cannot unlock final promotion"
        ),
    }


def _bounded_sim_target_queue_metadata(
    *,
    preview_rows: Sequence[Mapping[str, Any]],
    replay_tape_manifest: ReplayTapeManifest,
    exact_replay_candidate_cap: int,
    exploitation_slots: int,
    exploration_slots: int,
) -> dict[str, Any]:
    selected_preview_rows = [
        dict(row) for row in preview_rows if bool(row.get("selected"))
    ]
    selected_rows: list[dict[str, Any]] = []
    duplicate_filtered_candidate_spec_ids: list[str] = []
    seen_frontier_keys: set[str] = set()
    for row in selected_preview_rows:
        frontier_key = (
            _string(row.get("exact_replay_frontier_key"))
            or _string(row.get("candidate_frontier_hash"))
            or _string(row.get("candidate_spec_id"))
        )
        if frontier_key in seen_frontier_keys:
            duplicate_filtered_candidate_spec_ids.append(
                _string(row.get("candidate_spec_id"))
            )
            continue
        seen_frontier_keys.add(frontier_key)
        selected_rows.append(row)
        if len(selected_rows) >= exact_replay_candidate_cap:
            break
    entries: list[dict[str, Any]] = []
    for index, row in enumerate(selected_rows, start=1):
        candidate_spec_id = _string(row.get("candidate_spec_id"))
        frontier_bucket = _string(row.get("frontier_bucket"))
        handoff_lineage = _fast_replay_exact_handoff_lineage(
            row=row,
            replay_tape_manifest=replay_tape_manifest,
            queue_priority=index,
            candidate_spec_id=candidate_spec_id,
            frontier_bucket=frontier_bucket,
        )
        handoff_lineage_hash = _string(handoff_lineage.get("lineage_hash"))
        entries.append(
            {
                "queue_priority": index,
                "candidate_spec_id": candidate_spec_id,
                "frontier_bucket": frontier_bucket,
                "candidate_frontier_hash": row.get("candidate_frontier_hash"),
                "exact_replay_frontier_key": row.get("exact_replay_frontier_key"),
                "frontier_dedupe_status": row.get("frontier_dedupe_status"),
                "frontier_dedupe_metadata": row.get("frontier_dedupe_metadata"),
                "preview_rank": row.get("rank"),
                "preview_score": row.get("preview_score"),
                "observed_post_cost_expectancy_bps": row.get(
                    "observed_post_cost_expectancy_bps"
                ),
                "required_daily_notional": row.get("required_daily_notional"),
                "target_implied_notional_context": row.get(
                    "target_implied_notional_context"
                ),
                "exact_replay_selection_blocked": row.get(
                    "exact_replay_selection_blocked"
                ),
                "exact_replay_selection_blockers": list(
                    cast(
                        Sequence[Any],
                        row.get("exact_replay_selection_blockers") or (),
                    )
                ),
                "reproducibility_metadata": {
                    "dataset_snapshot_ref": replay_tape_manifest.dataset_snapshot_ref,
                    "replay_tape_content_sha256": replay_tape_manifest.content_sha256,
                    "replay_cache_key": replay_tape_manifest.replay_cache_key,
                    "source_query_digest": replay_tape_manifest.source_query_digest,
                    "source_table_versions": dict(
                        replay_tape_manifest.source_table_versions
                    ),
                    "feature_schema_hash": replay_tape_manifest.feature_schema_hash,
                    "cost_model_hash": replay_tape_manifest.cost_model_hash,
                    "strategy_family": replay_tape_manifest.strategy_family,
                    "cache_identity": (
                        replay_tape_manifest.cache_identity_diagnostics()
                    ),
                    "preview_score": row.get("preview_score"),
                    "frontier_bucket": row.get("frontier_bucket"),
                    "handoff_lineage_hash": handoff_lineage_hash,
                },
                "exact_replay_handoff_lineage": handoff_lineage,
                "handoff_lineage_hash": handoff_lineage_hash,
                "cost_impact_lineage": row.get("cost_impact_lineage"),
                "impact_capacity_lineage": row.get("impact_capacity_lineage"),
                "hpairs_macro_window_stress": row.get("hpairs_macro_window_stress"),
                "hpairs_impact_capacity_lineage": row.get(
                    "hpairs_impact_capacity_lineage"
                ),
                "adv_capacity_context": row.get("adv_capacity_context"),
                "lineage_blockers": list(
                    cast(Sequence[Any], row.get("lineage_blockers") or ())
                ),
                "risk_flags": list(cast(Sequence[Any], row.get("risk_flags") or ())),
                "proof_semantics_label": row.get("proof_semantics_label"),
                "hpairs_microstructure_prefilter": row.get(
                    "hpairs_microstructure_prefilter"
                )
                or row.get("microstructure_prefilter"),
                "promotion_proof": False,
                "proof_authority": False,
                "promotion_authority": False,
                "promotion_allowed": False,
                "final_promotion_allowed": False,
                "final_authority_ok": False,
            }
        )
    return {
        "schema_version": "torghut.fast-replay-bounded-sim-target-queue.v3",
        "status": "metadata_only_preview_to_exact_replay_queue",
        "authority": "not_promotion_proof",
        "prefilter_only": True,
        "promotion_proof": False,
        "proof_authority": False,
        "promotion_authority": False,
        "promotion_allowed": False,
        "final_promotion_allowed": False,
        "final_authority_ok": False,
        "proof_semantics": _fast_replay_preview_proof_semantics(),
        "whitepaper_mechanisms": list(FAST_REPLAY_WHITEPAPER_MECHANISMS),
        "queue_policy": "top_exploitation_plus_exploration_exact_replay_cap",
        "dedupe_policy": {
            "schema_version": "torghut.fast-replay-sim-target-queue-dedupe.v1",
            "status": "enabled",
            "dedupe_scope": "same_replay_tape_cache_and_execution_identity",
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_authority_ok": False,
        },
        "runner_policy": {
            "default_shard_timeout_seconds": _DEFAULT_REAL_REPLAY_SHARD_TIMEOUT_SECONDS,
            "default_worker_cap": _DEFAULT_REAL_REPLAY_SHARD_WORKERS,
            "default_parallel_frontier_candidate_cap": (
                _DEFAULT_REAL_REPLAY_MAX_PARALLEL_FRONTIER_CANDIDATES
            ),
            "kubernetes_fanout_enabled": False,
            "handoff_mode": "metadata_only_no_live_submit",
        },
        "exact_replay_command_policy": {
            "schema_version": "torghut.fast-replay-exact-command-policy.v1",
            "generation_scope": "bounded_frontier_only",
            "max_exact_replay_candidates": _DEFAULT_FAST_REPLAY_EXACT_CANDIDATE_CAP,
            "effective_exact_replay_candidate_cap": exact_replay_candidate_cap,
            "max_local_workers": _DEFAULT_REAL_REPLAY_SHARD_WORKERS,
            "shard_timeout_seconds": _DEFAULT_REAL_REPLAY_SHARD_TIMEOUT_SECONDS,
            "proof_packet_upload_allowed": False,
            "db_writes_allowed": False,
            "cluster_fanout_allowed": False,
            "kubernetes_fanout_allowed": False,
            "promotion_writes_allowed": False,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_authority_ok": False,
        },
        "target_queue": {
            "sim_account_label": "TORGHUT_SIM",
            "live_paper_account_label": "TORGHUT_LIVE_PAPER_AFTER_PROBATION",
            "status": "sim_target_queue_ready_live_paper_blocked",
            "live_paper_blockers": [
                "exact_replay_probation_required",
                "source_backed_runtime_ledger_required",
                "operator_enablement_required",
            ],
        },
        "replay_tape": {
            "dataset_snapshot_ref": replay_tape_manifest.dataset_snapshot_ref,
            "content_sha256": replay_tape_manifest.content_sha256,
            "replay_cache_key": replay_tape_manifest.replay_cache_key,
            "source_query_digest": replay_tape_manifest.source_query_digest,
            "source_table_versions": dict(replay_tape_manifest.source_table_versions),
            "feature_schema_hash": replay_tape_manifest.feature_schema_hash,
            "cost_model_hash": replay_tape_manifest.cost_model_hash,
            "strategy_family": replay_tape_manifest.strategy_family,
            "cache_identity": replay_tape_manifest.cache_identity_diagnostics(),
        },
        "exact_replay_candidate_cap": exact_replay_candidate_cap,
        "exploitation_slots": exploitation_slots,
        "exploration_slots": exploration_slots,
        "exact_replay_candidate_count": len(entries),
        "pre_dedupe_selected_candidate_count": len(selected_preview_rows),
        "deduped_candidate_count": len(entries),
        "duplicate_filtered_candidate_spec_ids": duplicate_filtered_candidate_spec_ids,
        "candidate_spec_ids": [entry["candidate_spec_id"] for entry in entries],
        "exact_replay_frontier_keys": [
            entry["exact_replay_frontier_key"] for entry in entries
        ],
        "handoff_lineage_hashes": [entry["handoff_lineage_hash"] for entry in entries],
        "entries": entries,
    }


def _fast_replay_exact_handoff_lineage(
    *,
    row: Mapping[str, Any],
    replay_tape_manifest: ReplayTapeManifest,
    queue_priority: int,
    candidate_spec_id: str,
    frontier_bucket: str,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "schema_version": "torghut.fast-replay-exact-handoff-lineage.v2",
        "status": "preview_only_exact_replay_handoff",
        "authority": "not_promotion_proof",
        "prefilter_only": True,
        "promotion_proof": False,
        "proof_authority": False,
        "promotion_authority": False,
        "promotion_allowed": False,
        "final_promotion_allowed": False,
        "final_authority_ok": False,
        "candidate_spec_id": candidate_spec_id,
        "queue_priority": queue_priority,
        "frontier_bucket": frontier_bucket,
        "candidate_frontier_hash": row.get("candidate_frontier_hash"),
        "exact_replay_frontier_key": row.get("exact_replay_frontier_key"),
        "frontier_dedupe_status": row.get("frontier_dedupe_status"),
        "frontier_dedupe_metadata": row.get("frontier_dedupe_metadata"),
        "preview_rank": row.get("rank"),
        "preview_score": row.get("preview_score"),
        "proof_semantics_label": row.get("proof_semantics_label"),
        "replay_tape": {
            "dataset_snapshot_ref": replay_tape_manifest.dataset_snapshot_ref,
            "content_sha256": replay_tape_manifest.content_sha256,
            "replay_cache_key": replay_tape_manifest.replay_cache_key,
            "source_query_digest": replay_tape_manifest.source_query_digest,
            "source_table_versions": dict(replay_tape_manifest.source_table_versions),
            "feature_schema_hash": replay_tape_manifest.feature_schema_hash,
            "cost_model_hash": replay_tape_manifest.cost_model_hash,
            "strategy_family": replay_tape_manifest.strategy_family,
            "cache_identity": replay_tape_manifest.cache_identity_diagnostics(),
        },
        "cost_impact_lineage": row.get("cost_impact_lineage"),
        "hpairs_microstructure_prefilter": row.get("hpairs_microstructure_prefilter")
        or row.get("microstructure_prefilter"),
    }
    payload["lineage_hash"] = build_source_query_digest(payload)
    return payload


def _maybe_materialize_epoch_replay_tape(
    *,
    args: argparse.Namespace,
    output_dir: Path,
    epoch_id: str,
) -> tuple[argparse.Namespace, dict[str, Any] | None]:
    explicit_materialize = bool(getattr(args, "materialize_replay_tape", False))
    auto_materialize = _auto_materialize_staged_replay_tape(args)
    if not explicit_materialize and not auto_materialize:
        return args, None
    if getattr(args, "replay_tape_path", None) is not None:
        return args, None
    if str(getattr(args, "replay_mode", "") or "") != "real":
        raise ValueError("replay_tape_materialization_requires_real_replay")
    if bool(getattr(args, "selection_only", False)):
        raise ValueError("replay_tape_materialization_requires_replay_execution")

    start_date = _materialized_replay_tape_date_arg(args, "full_window_start_date")
    end_date = _materialized_replay_tape_date_arg(args, "full_window_end_date")
    symbols = _candidate_universe_symbols_from_args(args)
    tape_path = output_dir / "replay-tape.jsonl"
    manifest_path = output_dir / "replay-tape.jsonl.manifest.json"
    config = replay_mod.ReplayConfig(
        strategy_configmap_path=_resolve_existing_path(args.strategy_configmap),
        clickhouse_http_url=str(getattr(args, "clickhouse_http_url", "")),
        clickhouse_username=(_string(getattr(args, "clickhouse_username", "")) or None),
        clickhouse_password=(_string(getattr(args, "clickhouse_password", "")) or None),
        start_date=start_date,
        end_date=end_date,
        chunk_minutes=max(1, int(getattr(args, "chunk_minutes", 10) or 10)),
        flatten_eod=True,
        start_equity=Decimal(str(getattr(args, "start_equity", "31590.02"))),
        symbols=symbols,
    )
    rows = tuple(replay_mod._iter_signal_rows(config))
    source_query_digest = _materialized_replay_tape_source_query_digest(
        args=args,
        symbols=symbols,
        start_date=start_date,
        end_date=end_date,
    )
    manifest = materialize_signal_tape(
        rows=rows,
        tape_path=tape_path,
        manifest_path=manifest_path,
        dataset_snapshot_ref=epoch_id,
        symbols=symbols,
        start_date=start_date,
        end_date=end_date,
        source_query_digest=source_query_digest,
        feature_schema_hash=_materialized_replay_tape_feature_schema_hash(args),
        cost_model_hash=_materialized_replay_tape_cost_model_hash(args),
        strategy_family=_materialized_replay_tape_strategy_family(args),
        require_complete_coverage=not bool(getattr(args, "allow_stale_tape", False)),
    )
    receipt_path = output_dir / "replay-tape-receipt.json"
    receipt = {
        "schema_version": "torghut.whitepaper-autoresearch-replay-tape-receipt.v1",
        "status": "materialized",
        "tape_path": str(tape_path),
        "manifest_path": str(manifest_path),
        "receipt_path": str(receipt_path),
        "dataset_snapshot_ref": manifest.dataset_snapshot_ref,
        "row_count": manifest.row_count,
        "trading_day_count": manifest.trading_day_count,
        "row_symbols": list(manifest.row_symbols),
        "content_sha256": manifest.content_sha256,
        "source_query_digest": manifest.source_query_digest,
        "replay_cache_key": manifest.replay_cache_key,
        "feature_schema_hash": manifest.feature_schema_hash,
        "cost_model_hash": manifest.cost_model_hash,
        "strategy_family": manifest.strategy_family,
        "cache_identity": manifest.cache_identity_diagnostics(),
    }
    _write_json(receipt_path, receipt)
    updated_args = argparse.Namespace(
        **{
            **vars(args),
            "replay_tape_path": tape_path,
            "replay_tape_manifest": manifest_path,
        }
    )
    return updated_args, receipt


def _auto_materialize_staged_replay_tape(args: argparse.Namespace) -> bool:
    if not bool(getattr(args, "staged_replay_frontier_default", False)):
        return False
    if bool(getattr(args, "disable_staged_replay_frontier", False)):
        return False
    if str(getattr(args, "replay_mode", "") or "") != "real":
        return False
    if bool(getattr(args, "selection_only", False)):
        return False
    if getattr(args, "replay_tape_path", None) is not None:
        return False
    if not str(getattr(args, "full_window_start_date", "") or "").strip():
        return False
    if not str(getattr(args, "full_window_end_date", "") or "").strip():
        return False
    return True


def _maybe_preflight_materialized_replay_tape_window(
    *,
    args: argparse.Namespace,
    output_dir: Path,
) -> tuple[argparse.Namespace, dict[str, Any] | None]:
    explicit_materialize = bool(getattr(args, "materialize_replay_tape", False))
    auto_materialize = _auto_materialize_staged_replay_tape(args)
    if not explicit_materialize and not auto_materialize:
        return args, None
    if getattr(args, "replay_tape_path", None) is not None:
        return args, None
    if str(getattr(args, "replay_mode", "") or "") != "real":
        return args, None
    if bool(getattr(args, "selection_only", False)):
        return args, None
    min_days = max(0, int(getattr(args, "latest_complete_window_min_days", 0) or 0))
    if min_days <= 0:
        return args, None

    requested_start_date = _materialized_replay_tape_date_arg(
        args, "full_window_start_date"
    )
    requested_end_date = _materialized_replay_tape_date_arg(
        args, "full_window_end_date"
    )
    coverage_diagnostic_output = (
        Path(getattr(args, "coverage_diagnostic_output")).resolve()
        if getattr(args, "coverage_diagnostic_output", None) is not None
        else output_dir / "replay-source-coverage-diagnostics.json"
    )
    latest_window_receipt_output = (
        Path(getattr(args, "latest_complete_window_receipt_output")).resolve()
        if getattr(args, "latest_complete_window_receipt_output", None) is not None
        else output_dir / "replay-source-latest-complete-window.json"
    )
    preflight_args = argparse.Namespace(
        **{
            **vars(args),
            "coverage_diagnostic_output": coverage_diagnostic_output,
            "latest_complete_window_receipt_output": latest_window_receipt_output,
        }
    )
    symbols = _candidate_universe_symbols_from_args(args)
    selected_start, selected_end, receipt = (
        replay_materializer._select_effective_window(
            args=preflight_args,
            symbols=symbols,
            requested_start_date=requested_start_date,
            requested_end_date=requested_end_date,
        )
    )
    updated_args = argparse.Namespace(
        **{
            **vars(args),
            "full_window_start_date": selected_start.isoformat(),
            "full_window_end_date": selected_end.isoformat(),
            "expected_last_trading_day": selected_end.isoformat(),
            "coverage_diagnostic_output": coverage_diagnostic_output,
            "latest_complete_window_receipt_output": latest_window_receipt_output,
        }
    )
    return updated_args, receipt


def _materialized_replay_tape_date_arg(
    args: argparse.Namespace,
    key: str,
) -> date:
    value = str(getattr(args, key, "") or "").strip()
    if not value:
        raise ValueError(f"replay_tape_materialization_requires_{key}")
    return date.fromisoformat(value)


def _materialized_replay_tape_source_query_digest(
    *,
    args: argparse.Namespace,
    symbols: Sequence[str],
    start_date: date,
    end_date: date,
) -> str:
    return build_source_query_digest(
        {
            "query_family": "torghut.ta_signals_pt1s_with_microbars",
            "clickhouse_http_url": str(getattr(args, "clickhouse_http_url", "")),
            "start_date": start_date.isoformat(),
            "end_date": end_date.isoformat(),
            "chunk_minutes": max(1, int(getattr(args, "chunk_minutes", 10) or 10)),
            "symbols": list(symbols),
            "source": "ta",
            "window_size": "PT1S",
            "join": "torghut.ta_microbars",
        }
    )


def _materialized_replay_tape_feature_schema_hash(args: argparse.Namespace) -> str:
    return _stable_hash(
        {
            "schema_version": "torghut.replay-tape-feature-schema.v1",
            "signal_schema": "SignalEnvelope",
            "source": "ta",
            "window_size": "PT1S",
            "microbar_join": "torghut.ta_microbars",
            "chunk_minutes": max(1, int(getattr(args, "chunk_minutes", 10) or 10)),
        }
    )


def _materialized_replay_tape_cost_model_hash(args: argparse.Namespace) -> str:
    return _stable_hash(
        {
            "schema_version": "torghut.replay-tape-cost-model.v1",
            "pnl_basis": POST_COST_PNL_BASIS,
            "start_equity": str(getattr(args, "start_equity", "31590.02")),
            "preview_cost_lineage": "spread_plus_square_root_impact_prefilter",
        }
    )


def _materialized_replay_tape_strategy_family(args: argparse.Namespace) -> str:
    path = Path(getattr(args, "strategy_configmap", "strategy-configmap.yaml"))
    return f"whitepaper-autoresearch:{path.name}"


def _fast_replay_preview_date_arg(args: argparse.Namespace, key: str) -> date:
    value = str(getattr(args, key, "") or "").strip()
    if not value:
        raise ValueError(f"fast_replay_preview_requires_{key}")
    return date.fromisoformat(value)


def _synthetic_net_for_spec(spec: CandidateSpec, *, rank: int) -> Decimal:
    family_bonus = {
        "microbar_cross_sectional_pairs_v1": Decimal("215"),
        "microstructure_continuation_matched_filter_v1": Decimal("190"),
        "opening_drive_leader_reclaim_v1": Decimal("185"),
        "momentum_pullback_v1": Decimal("175"),
        "washout_rebound_v2": Decimal("165"),
        "breakout_reclaim_v2": Decimal("155"),
        "end_of_day_reversal_v1": Decimal("150"),
        "late_day_continuation_v1": Decimal("145"),
    }.get(spec.family_template_id, Decimal("125"))
    return family_bonus + Decimal(max(0, 12 - rank) * 5)


def _synthetic_symbol_contribution_shares(spec: CandidateSpec) -> dict[str, str]:
    symbols = [
        str(symbol).strip().upper()
        for symbol in cast(
            Sequence[Any], spec.strategy_overrides.get("universe_symbols") or []
        )
        if str(symbol).strip()
    ][:4]
    if not symbols:
        symbols = list(LIVE_SIGNAL_COVERED_SEMICONDUCTOR_UNIVERSE[:4])
    share = Decimal("1") / Decimal(len(symbols))
    return {symbol: str(share) for symbol in symbols}


def _synthetic_candidate_payload(spec: CandidateSpec, *, rank: int) -> dict[str, Any]:
    net = _synthetic_net_for_spec(spec, rank=rank)
    active = Decimal("0.92") if rank <= 3 else Decimal("0.82")
    positive = Decimal("0.64") if rank <= 3 else Decimal("0.58")
    symbol_contribution_shares = _synthetic_symbol_contribution_shares(spec)
    daily_net_profile = {
        1: (
            Decimal("0.80"),
            Decimal("1.10"),
            Decimal("0.90"),
            Decimal("1.05"),
            Decimal("1.15"),
        ),
        2: (
            Decimal("1.12"),
            Decimal("0.86"),
            Decimal("1.08"),
            Decimal("0.94"),
            Decimal("1.00"),
        ),
        3: (
            Decimal("0.95"),
            Decimal("1.14"),
            Decimal("0.84"),
            Decimal("1.10"),
            Decimal("0.97"),
        ),
    }.get(
        rank,
        (
            Decimal("1.05"),
            Decimal("0.90"),
            Decimal("1.15"),
            Decimal("0.82"),
            Decimal("1.08"),
        ),
    )
    trading_days = (
        "2026-02-23",
        "2026-02-24",
        "2026-02-25",
        "2026-02-26",
        "2026-02-27",
    )
    daily_filled_notional = {
        "2026-02-23": "350000",
        "2026-02-24": "350000",
        "2026-02-25": "350000",
        "2026-02-26": "350000",
        "2026-02-27": "350000",
    }
    return {
        "candidate_id": f"cand-{spec.candidate_spec_id}",
        "candidate_spec_id": spec.candidate_spec_id,
        "runtime_family": spec.runtime_family,
        "runtime_strategy_name": spec.runtime_strategy_name,
        "family_template_id": spec.family_template_id,
        "execution_signature": _candidate_spec_execution_signature(spec),
        "objective_scorecard": {
            "net_pnl_per_day": str(net),
            "active_day_ratio": str(active),
            "positive_day_ratio": str(positive),
            "avg_filled_notional_per_day": "350000",
            "worst_day_loss": "180",
            "max_drawdown": "520",
            "best_day_share": "0.20",
            "regime_slice_pass_rate": "0.55",
            "posterior_edge_lower": "0.01",
            "shadow_parity_status": "within_budget",
            "symbol_contribution_shares": symbol_contribution_shares,
            "daily_filled_notional": daily_filled_notional,
        },
        "full_window": {
            "net_per_day": str(net),
            "daily_net": {
                day: str(net * multiplier)
                for day, multiplier in zip(trading_days, daily_net_profile, strict=True)
            },
            "daily_filled_notional": daily_filled_notional,
        },
        "promotion_readiness": {
            "stage": "research_candidate",
            "status": "blocked_pending_runtime_parity",
            "promotable": False,
            "blockers": ["scheduler_v3_parity_missing", "shadow_validation_missing"],
        },
    }


def _run_synthetic_replay(
    *,
    specs: Sequence[CandidateSpec],
    output_dir: Path,
    max_candidates: int,
) -> EpochReplayResult:
    evidence_bundles: list[CandidateEvidenceBundle] = []
    replay_results: list[Mapping[str, Any]] = []
    code_commit = _current_code_commit()
    for rank, spec in enumerate(specs[: max(1, max_candidates)], start=1):
        candidate = _synthetic_candidate_payload(spec, rank=rank)
        result_path = (
            output_dir / "synthetic-replays" / f"{spec.candidate_spec_id}.json"
        )
        result_payload = {
            "schema_version": "torghut.synthetic-autoresearch-replay.v1",
            "dataset_snapshot_receipt": {
                "snapshot_id": "synthetic-recent-whitepaper-2025-2026"
            },
            "top": [candidate],
        }
        _write_json(result_path, result_payload)
        evidence_bundles.append(
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=spec.candidate_spec_id,
                candidate=candidate,
                dataset_snapshot_id="synthetic-recent-whitepaper-2025-2026",
                result_path=str(result_path),
                code_commit=code_commit,
            )
        )
        replay_results.append(result_payload)
    return EpochReplayResult(
        evidence_bundles=tuple(evidence_bundles), replay_results=tuple(replay_results)
    )


def _run_real_replay(
    args: argparse.Namespace,
    *,
    output_dir: Path,
    specs: Sequence[CandidateSpec] = (),
) -> EpochReplayResult:
    source_specs = [
        strategy_factory_runner.InMemoryExperimentSpec(
            run_id=_string(spec.feature_contract.get("source_run_id"))
            or "whitepaper-autoresearch",
            experiment_id=f"{spec.candidate_spec_id}-exp",
            payload_json=spec.to_vnext_experiment_payload(
                experiment_id=f"{spec.candidate_spec_id}-exp"
            ),
        )
        for spec in specs
    ]
    max_total_candidates_to_evaluate = max(
        1,
        int(
            getattr(args, "max_total_frontier_candidates", 0)
            or getattr(args, "max_candidates", 1)
        ),
    )
    max_candidates_to_evaluate = int(
        getattr(
            args,
            "max_frontier_candidates_per_spec",
            _DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC,
        )
    )
    if source_specs:
        per_spec_total_cap = max(
            1,
            (max_total_candidates_to_evaluate + len(source_specs) - 1)
            // len(source_specs),
        )
        max_candidates_to_evaluate = max(
            1, min(max_candidates_to_evaluate, per_spec_total_cap)
        )
    factory_args = argparse.Namespace(
        output_dir=output_dir / "strategy-factory",
        experiment_id=[],
        paper_run_id=args.paper_run_id,
        limit=max(1, int(args.max_candidates)),
        strategy_configmap=_resolve_existing_path(args.strategy_configmap),
        family_template_dir=_resolve_existing_path(args.family_template_dir),
        seed_sweep_dir=_resolve_existing_path(args.seed_sweep_dir),
        clickhouse_http_url=args.clickhouse_http_url,
        clickhouse_username=args.clickhouse_username,
        clickhouse_password=args.clickhouse_password,
        start_equity=args.start_equity,
        chunk_minutes=args.chunk_minutes,
        symbols="" if source_specs else args.symbols,
        progress_log_seconds=args.progress_log_seconds,
        train_days=args.train_days,
        holdout_days=args.holdout_days,
        second_oos_days=max(0, int(getattr(args, "second_oos_days", 0) or 0)),
        full_window_start_date=args.full_window_start_date,
        full_window_end_date=args.full_window_end_date,
        expected_last_trading_day=args.expected_last_trading_day,
        allow_stale_tape=args.allow_stale_tape,
        prefetch_full_window_rows=args.prefetch_full_window_rows,
        replay_tape_path=getattr(args, "replay_tape_path", None),
        replay_tape_manifest=getattr(args, "replay_tape_manifest", None),
        collect_train_gate_diagnostics=bool(
            getattr(args, "collect_train_gate_diagnostics", True)
        ),
        top_n=args.top_k,
        max_candidates_to_evaluate=max_candidates_to_evaluate,
        max_total_candidates_to_evaluate=max_total_candidates_to_evaluate,
        staged_train_screen_multiplier=max(
            1, int(getattr(args, "staged_train_screen_multiplier", 1) or 1)
        ),
        capture_rejected_seed_full_window_ledger=bool(
            getattr(args, "capture_rejected_seed_full_window_ledger", False)
        ),
        capture_positive_rejected_full_window_ledgers=max(
            0,
            int(getattr(args, "capture_positive_rejected_full_window_ledgers", 0) or 0),
        ),
        symbol_prune_iterations=max(
            0, int(getattr(args, "symbol_prune_iterations", 0) or 0)
        ),
        symbol_prune_candidates=max(
            1, int(getattr(args, "symbol_prune_candidates", 1) or 1)
        ),
        symbol_prune_min_universe_size=max(
            1, int(getattr(args, "symbol_prune_min_universe_size", 2) or 2)
        ),
        loss_repair_iterations=max(
            0, int(getattr(args, "loss_repair_iterations", 0) or 0)
        ),
        loss_repair_candidates=max(
            1, int(getattr(args, "loss_repair_candidates", 1) or 1)
        ),
        consistency_repair_iterations=max(
            0, int(getattr(args, "consistency_repair_iterations", 0) or 0)
        ),
        consistency_repair_candidates=max(
            1, int(getattr(args, "consistency_repair_candidates", 2) or 2)
        ),
        persist_results=args.persist_results,
    )
    factory_payload = (
        strategy_factory_runner.run_strategy_factory_v2_from_specs(
            factory_args,
            source_specs=source_specs,
        )
        if source_specs
        else strategy_factory_runner.run_strategy_factory_v2(factory_args)
    )
    return _real_replay_result_from_factory_payload(
        factory_payload,
        specs_by_id={spec.candidate_spec_id: spec for spec in specs},
    )


def _real_replay_result_from_factory_payload(
    factory_payload: Mapping[str, Any],
    *,
    specs_by_id: Mapping[str, CandidateSpec] | None = None,
) -> EpochReplayResult:
    specs_by_id = specs_by_id or {}
    evidence_bundles: list[CandidateEvidenceBundle] = []
    build = _mapping(factory_payload.get("build"))
    code_commit = _string(build.get("commit")) or _current_code_commit()
    for item in _list_of_mappings(factory_payload.get("experiments")):
        result_path = str(item.get("result_path") or "")
        if not result_path:
            continue
        result_payload = json.loads(Path(result_path).read_text(encoding="utf-8"))
        top = _list_of_mappings(result_payload.get("top"))
        if not top:
            continue
        experiment_spec_id = _string(item.get("candidate_spec_id"))
        fallback_spec_id = str(
            item.get("experiment_id") or item.get("top_candidate_id") or ""
        )
        dataset_snapshot_id = str(item.get("dataset_snapshot_id") or "")
        experiment_promotion_readiness = item.get("promotion_readiness")
        replay_summary = _mapping(result_payload.get("summary"))
        for frontier_candidate in top:
            candidate = dict(frontier_candidate)
            if replay_summary and "summary" not in candidate:
                candidate["summary"] = replay_summary
            candidate_spec_id = experiment_spec_id or _string(
                candidate.get("candidate_spec_id")
            )
            if candidate_spec_id:
                candidate["candidate_spec_id"] = candidate_spec_id
            spec = specs_by_id.get(candidate_spec_id)
            if spec is not None:
                candidate = _candidate_payload_with_feedback_metadata(
                    candidate=candidate,
                    spec=spec,
                )
            if (
                not candidate.get("promotion_readiness")
                and experiment_promotion_readiness
            ):
                candidate["promotion_readiness"] = experiment_promotion_readiness
            evidence_bundles.append(
                evidence_bundle_from_frontier_candidate(
                    candidate_spec_id=candidate_spec_id or fallback_spec_id,
                    candidate=candidate,
                    dataset_snapshot_id=dataset_snapshot_id,
                    result_path=result_path,
                    code_commit=code_commit,
                )
            )
    return EpochReplayResult(
        evidence_bundles=tuple(evidence_bundles), replay_results=(factory_payload,)
    )


def _dedupe_replay_evidence(
    bundles: Sequence[CandidateEvidenceBundle],
) -> tuple[CandidateEvidenceBundle, ...]:
    seen: set[str] = set()
    deduped: list[CandidateEvidenceBundle] = []
    for bundle in bundles:
        if bundle.evidence_bundle_id in seen:
            continue
        seen.add(bundle.evidence_bundle_id)
        deduped.append(bundle)
    return tuple(deduped)


def _candidate_spec_id_from_experiment_result_path(path: Path) -> str:
    name = path.parent.name
    return name[:-4] if name.endswith("-exp") else name


def _collect_partial_real_replay(
    *,
    output_dir: Path,
    specs: Sequence[CandidateSpec],
) -> EpochReplayResult:
    strategy_factory_root = output_dir / "strategy-factory"
    if not strategy_factory_root.exists():
        return EpochReplayResult(evidence_bundles=(), replay_results=())
    spec_by_id = {spec.candidate_spec_id: spec for spec in specs}
    experiments: list[dict[str, Any]] = []
    for result_path in sorted(strategy_factory_root.glob("*/result.json")):
        try:
            result_payload = json.loads(result_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        top = _list_of_mappings(result_payload.get("top"))
        if not top:
            continue
        top_candidate = top[0]
        candidate_spec_id = _string(
            top_candidate.get("candidate_spec_id")
        ) or _candidate_spec_id_from_experiment_result_path(result_path)
        spec = spec_by_id.get(candidate_spec_id)
        dataset_snapshot = _mapping(result_payload.get("dataset_snapshot_receipt"))
        experiments.append(
            {
                "source_run_id": _string(spec.feature_contract.get("source_run_id"))
                if spec is not None
                else "",
                "experiment_id": result_path.parent.name,
                "candidate_spec_id": candidate_spec_id,
                "family_template_id": _string(top_candidate.get("family_template_id"))
                or (spec.family_template_id if spec is not None else ""),
                "result_path": str(result_path),
                "dataset_snapshot_id": str(dataset_snapshot.get("snapshot_id") or ""),
                "top_candidate_id": _string(top_candidate.get("candidate_id")),
                "promotion_readiness": {
                    "stage": "research_candidate",
                    "status": "partial_replay_interrupted",
                    "promotable": False,
                    "blockers": ["real_replay_interrupted_before_epoch_summary"],
                },
            }
        )
    if not experiments:
        return EpochReplayResult(evidence_bundles=(), replay_results=())
    return _real_replay_result_from_factory_payload(
        {
            "status": "partial_replay_artifacts_collected",
            "count": len(experiments),
            "experiments": experiments,
        },
        specs_by_id=spec_by_id,
    )


def _run_replay_with_optional_timeout(
    *,
    args: argparse.Namespace,
    output_dir: Path,
    specs: Sequence[CandidateSpec],
) -> EpochReplayResult:
    timeout_seconds = max(0, int(getattr(args, "real_replay_timeout_seconds", 0) or 0))
    if args.replay_mode == "synthetic":
        return _run_synthetic_replay(
            specs=specs,
            output_dir=output_dir,
            max_candidates=len(specs),
        )

    shard_size = max(0, int(getattr(args, "real_replay_shard_size", 0) or 0))
    if shard_size > 0 and len(specs) > shard_size:
        shard_timeout_seconds = _bounded_real_replay_shard_timeout_seconds(
            getattr(
                args,
                "real_replay_shard_timeout_seconds",
                _DEFAULT_REAL_REPLAY_SHARD_TIMEOUT_SECONDS,
            )
        )
        return _run_real_replay_shards(
            args=args,
            output_dir=output_dir,
            specs=specs,
            shard_size=shard_size,
            shard_timeout_seconds=shard_timeout_seconds
            or timeout_seconds
            or _DEFAULT_REAL_REPLAY_SHARD_TIMEOUT_SECONDS,
        )

    return _run_real_replay_once_with_optional_timeout(
        args=args,
        output_dir=output_dir,
        specs=specs,
        timeout_seconds=timeout_seconds,
    )


def _run_real_replay_once_with_optional_timeout(
    *,
    args: argparse.Namespace,
    output_dir: Path,
    specs: Sequence[CandidateSpec],
    timeout_seconds: int,
) -> EpochReplayResult:
    if timeout_seconds <= 0:
        return _run_real_replay(args, output_dir=output_dir, specs=specs)
    if not all(
        hasattr(signal, attr) for attr in ("SIGALRM", "alarm", "getsignal", "signal")
    ):
        return _run_real_replay_once_in_child_process(
            args=args,
            output_dir=output_dir,
            specs=specs,
            timeout_seconds=timeout_seconds,
        )

    previous_handler = signal.getsignal(signal.SIGALRM)

    def _timeout_handler(_signum: int, _frame: Any) -> None:
        raise TimeoutError(f"real_replay_timeout_seconds:{timeout_seconds}")

    signal.signal(signal.SIGALRM, _timeout_handler)
    signal.alarm(timeout_seconds)
    try:
        return _run_real_replay(args, output_dir=output_dir, specs=specs)
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous_handler)


def _real_replay_worker(
    result_queue: Any,
    args: argparse.Namespace,
    output_dir: str,
    specs: tuple[CandidateSpec, ...],
) -> None:
    try:
        result_queue.put(
            ("ok", _run_real_replay(args, output_dir=Path(output_dir), specs=specs))
        )
    except BaseException as exc:
        try:
            result_queue.put(("error", exc))
        except Exception:
            result_queue.put(("error_payload", (type(exc).__name__, str(exc))))


def _terminate_process(process: Any) -> None:
    if not process.is_alive():
        return
    process.terminate()
    process.join(timeout=5)
    if process.is_alive():
        kill = getattr(process, "kill", None)
        if callable(kill):
            kill()
            process.join(timeout=5)


def _run_real_replay_once_in_child_process(
    *,
    args: argparse.Namespace,
    output_dir: Path,
    specs: Sequence[CandidateSpec],
    timeout_seconds: int,
) -> EpochReplayResult:
    context = multiprocessing.get_context("spawn")
    result_queue = context.Queue(maxsize=1)
    process = context.Process(
        target=_real_replay_worker,
        args=(result_queue, args, str(output_dir), tuple(specs)),
    )
    process.start()
    deadline = monotonic_time.monotonic() + timeout_seconds
    try:
        while True:
            remaining = deadline - monotonic_time.monotonic()
            if remaining <= 0:
                _terminate_process(process)
                raise TimeoutError(f"real_replay_timeout_seconds:{timeout_seconds}")
            try:
                status, payload = result_queue.get(timeout=min(remaining, 0.5))
                break
            except queue.Empty:
                if process.exitcode is not None:
                    raise RuntimeError("real_replay_worker_exited_without_result")
        process.join(timeout=5)
        if process.is_alive():
            _terminate_process(process)
        if status == "ok":
            return cast(EpochReplayResult, payload)
        if status == "error":
            raise cast(BaseException, payload)
        error_type, message = cast(tuple[str, str], payload)
        raise RuntimeError(f"{error_type}:{message}")
    finally:
        close = getattr(result_queue, "close", None)
        if callable(close):
            close()
        join_thread = getattr(result_queue, "join_thread", None)
        if callable(join_thread):
            join_thread()


def _build_real_replay_shards(
    *,
    args: argparse.Namespace,
    output_dir: Path,
    specs: Sequence[CandidateSpec],
    shard_size: int,
    shard_timeout_seconds: int,
) -> tuple[_ReplayShardPlan, ...]:
    ordered_specs = list(specs)
    bounded_shard_size = max(1, int(shard_size))
    bounded_shard_timeout_seconds = _bounded_real_replay_shard_timeout_seconds(
        shard_timeout_seconds
    )
    max_frontier_candidates_per_spec = max(
        1,
        int(
            getattr(
                args,
                "max_frontier_candidates_per_spec",
                _DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC,
            )
            or _DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC
        ),
    )
    configured_total_frontier_budget = max(
        1,
        int(
            getattr(args, "max_total_frontier_candidates", 0)
            or getattr(args, "max_candidates", 1)
        ),
    )
    per_spec_total_frontier_cap = max(
        1,
        (configured_total_frontier_budget + len(ordered_specs) - 1)
        // max(1, len(ordered_specs)),
    )
    plans: list[_ReplayShardPlan] = []
    for shard_index, start in enumerate(
        range(0, len(ordered_specs), bounded_shard_size), start=1
    ):
        shard_specs = tuple(ordered_specs[start : start + bounded_shard_size])
        shard_frontier_budget = max(
            1,
            len(shard_specs)
            * min(max_frontier_candidates_per_spec, per_spec_total_frontier_cap),
        )
        shard_args = argparse.Namespace(
            **{
                **vars(args),
                "max_candidates": len(shard_specs),
                "top_k": min(
                    int(getattr(args, "top_k", len(shard_specs))), len(shard_specs)
                ),
                "max_total_frontier_candidates": shard_frontier_budget,
            }
        )
        plans.append(
            _ReplayShardPlan(
                shard_index=shard_index,
                args=shard_args,
                output_dir=output_dir
                / "strategy-factory-shards"
                / f"shard-{shard_index:03d}",
                specs=shard_specs,
                timeout_seconds=bounded_shard_timeout_seconds,
            )
        )
    return tuple(plans)


def _execute_real_replay_shard(plan: _ReplayShardPlan) -> _ReplayShardOutcome:
    candidate_spec_ids = tuple(spec.candidate_spec_id for spec in plan.specs)
    try:
        result = _run_real_replay_once_with_optional_timeout(
            args=plan.args,
            output_dir=plan.output_dir,
            specs=plan.specs,
            timeout_seconds=plan.timeout_seconds,
        )
    except TimeoutError as exc:
        partial_result = _collect_partial_real_replay(
            output_dir=plan.output_dir,
            specs=plan.specs,
        )
        return _ReplayShardOutcome(
            shard_index=plan.shard_index,
            candidate_spec_ids=candidate_spec_ids,
            result=partial_result,
            failure={
                "shard_index": plan.shard_index,
                "candidate_spec_ids": list(candidate_spec_ids),
                "reason": f"{type(exc).__name__}:{exc}",
                "partial_evidence_bundle_count": len(partial_result.evidence_bundles),
                "shard_timeout_seconds": plan.timeout_seconds,
            },
        )

    failure: dict[str, Any] | None = None
    if result.incomplete:
        failure = {
            "shard_index": plan.shard_index,
            "candidate_spec_ids": list(candidate_spec_ids),
            "reason": ";".join(result.failure_reasons) or "nested_shard_incomplete",
        }
    return _ReplayShardOutcome(
        shard_index=plan.shard_index,
        candidate_spec_ids=candidate_spec_ids,
        result=result,
        failure=failure,
    )


def _failed_shard_spec_ids(
    shard_failures: Sequence[Mapping[str, Any]],
) -> tuple[str, ...]:
    spec_ids: list[str] = []
    seen: set[str] = set()
    for failure in shard_failures:
        raw_ids = failure.get("candidate_spec_ids")
        if not isinstance(raw_ids, Sequence) or isinstance(raw_ids, str):
            continue
        for raw_id in raw_ids:
            candidate_spec_id = _string(raw_id)
            if not candidate_spec_id or candidate_spec_id in seen:
                continue
            seen.add(candidate_spec_id)
            spec_ids.append(candidate_spec_id)
    return tuple(spec_ids)


def _evidenced_spec_ids(
    evidence_bundles: Sequence[CandidateEvidenceBundle],
) -> frozenset[str]:
    return frozenset(
        candidate_spec_id
        for candidate_spec_id in (
            _string(bundle.candidate_spec_id) for bundle in evidence_bundles
        )
        if candidate_spec_id
    )


def _retry_real_replay_failed_shard_specs(
    *,
    args: argparse.Namespace,
    output_dir: Path,
    specs: Sequence[CandidateSpec],
    shard_failures: Sequence[Mapping[str, Any]],
    shard_timeout_seconds: int,
    starting_shard_index: int,
) -> tuple[
    tuple[CandidateEvidenceBundle, ...],
    tuple[Mapping[str, Any], ...],
    tuple[Mapping[str, Any], ...],
    Mapping[str, Any] | None,
]:
    retry_limit = max(0, int(getattr(args, "real_replay_failed_spec_retries", 1) or 0))
    failed_spec_ids = _failed_shard_spec_ids(shard_failures)
    if retry_limit <= 0 or not failed_spec_ids:
        return (), (), tuple(shard_failures), None

    spec_by_id = {spec.candidate_spec_id: spec for spec in specs}
    retry_specs = tuple(
        spec_by_id[candidate_spec_id]
        for candidate_spec_id in failed_spec_ids
        if candidate_spec_id in spec_by_id
    )
    if not retry_specs:
        return (), (), tuple(shard_failures), None

    configured_timeout = max(
        0, int(getattr(args, "real_replay_retry_timeout_seconds", 0) or 0)
    )
    retry_timeout_seconds = configured_timeout
    if retry_timeout_seconds <= 0 and shard_timeout_seconds > 0:
        retry_timeout_seconds = max(shard_timeout_seconds * 2, 900)
    retry_frontier_budget = max(
        1,
        int(
            getattr(args, "real_replay_retry_max_frontier_candidates_per_spec", 1) or 1
        ),
    )

    evidence_bundles: list[CandidateEvidenceBundle] = []
    replay_results: list[Mapping[str, Any]] = []
    completed_spec_ids: set[str] = set()
    last_failure_by_spec: dict[str, Mapping[str, Any]] = {}
    attempt_summaries: list[dict[str, Any]] = []
    next_shard_index = starting_shard_index

    for attempt in range(1, retry_limit + 1):
        pending_specs = tuple(
            spec
            for spec in retry_specs
            if spec.candidate_spec_id not in completed_spec_ids
        )
        if not pending_specs:
            break
        attempt_failures: list[dict[str, Any]] = []
        attempt_completed: list[str] = []
        attempt_evidence_before = len(evidence_bundles)
        for retry_index, spec in enumerate(pending_specs, start=1):
            next_shard_index += 1
            retry_args = argparse.Namespace(
                **{
                    **vars(args),
                    "max_candidates": 1,
                    "top_k": 1,
                    "max_frontier_candidates_per_spec": retry_frontier_budget,
                    "max_total_frontier_candidates": retry_frontier_budget,
                }
            )
            outcome = _execute_real_replay_shard(
                _ReplayShardPlan(
                    shard_index=next_shard_index,
                    args=retry_args,
                    output_dir=output_dir
                    / "strategy-factory-failed-spec-retries"
                    / f"attempt-{attempt:02d}"
                    / f"retry-{retry_index:03d}-{spec.candidate_spec_id}",
                    specs=(spec,),
                    timeout_seconds=retry_timeout_seconds,
                )
            )
            evidence_bundles.extend(outcome.result.evidence_bundles)
            replay_results.extend(outcome.result.replay_results)
            if outcome.failure is not None:
                failure = {
                    **dict(outcome.failure),
                    "retry_attempt": attempt,
                    "retry_candidate_spec_id": spec.candidate_spec_id,
                    "retry_timeout_seconds": retry_timeout_seconds,
                    "retry_max_frontier_candidates_per_spec": retry_frontier_budget,
                }
                attempt_failures.append(failure)
                last_failure_by_spec[spec.candidate_spec_id] = failure
                continue
            completed_spec_ids.add(spec.candidate_spec_id)
            last_failure_by_spec.pop(spec.candidate_spec_id, None)
            attempt_completed.append(spec.candidate_spec_id)
        attempt_summaries.append(
            {
                "attempt": attempt,
                "requested_candidate_spec_ids": [
                    spec.candidate_spec_id for spec in pending_specs
                ],
                "completed_candidate_spec_ids": attempt_completed,
                "failure_count": len(attempt_failures),
                "failures": attempt_failures,
                "new_evidence_bundle_count": len(evidence_bundles)
                - attempt_evidence_before,
            }
        )

    deduped_retry_evidence = _dedupe_replay_evidence(evidence_bundles)
    remaining_failures = tuple(last_failure_by_spec.values())
    summary = {
        "status": "failed_shard_specs_retried",
        "schema_version": "torghut.whitepaper-autoresearch-shard-retry.v1",
        "retry_limit": retry_limit,
        "retry_timeout_seconds": retry_timeout_seconds,
        "retry_max_frontier_candidates_per_spec": retry_frontier_budget,
        "original_failure_count": len(shard_failures),
        "requested_candidate_spec_ids": [
            spec.candidate_spec_id for spec in retry_specs
        ],
        "completed_candidate_spec_ids": sorted(completed_spec_ids),
        "evidence_candidate_spec_ids": sorted(
            _evidenced_spec_ids(deduped_retry_evidence)
        ),
        "remaining_failed_candidate_spec_ids": [
            _string(failure.get("retry_candidate_spec_id"))
            for failure in remaining_failures
            if _string(failure.get("retry_candidate_spec_id"))
        ],
        "attempts": attempt_summaries,
    }
    return deduped_retry_evidence, tuple(replay_results), remaining_failures, summary


def _replay_shard_frontier_candidate_budget(plan: _ReplayShardPlan) -> int:
    return max(1, int(getattr(plan.args, "max_total_frontier_candidates", 1) or 1))


def _bounded_real_replay_shard_workers(
    *,
    args: argparse.Namespace,
    plans: Sequence[_ReplayShardPlan],
) -> int:
    requested_workers = max(
        1,
        min(
            len(plans) or 1,
            _DEFAULT_REAL_REPLAY_SHARD_WORKERS,
            int(
                getattr(
                    args,
                    "real_replay_shard_workers",
                    _DEFAULT_REAL_REPLAY_SHARD_WORKERS,
                )
                or _DEFAULT_REAL_REPLAY_SHARD_WORKERS
            ),
        ),
    )
    max_parallel_frontier_candidates = max(
        0,
        int(
            getattr(
                args,
                "real_replay_max_parallel_frontier_candidates",
                _DEFAULT_REAL_REPLAY_MAX_PARALLEL_FRONTIER_CANDIDATES,
            )
            or 0
        ),
    )
    if not plans or max_parallel_frontier_candidates <= 0:
        return requested_workers
    largest_shard_budget = max(
        _replay_shard_frontier_candidate_budget(plan) for plan in plans
    )
    budget_capped_workers = max(
        1, max_parallel_frontier_candidates // largest_shard_budget
    )
    return max(1, min(requested_workers, budget_capped_workers))


def _bounded_real_replay_shard_timeout_seconds(raw_timeout_seconds: object) -> int:
    requested_timeout_seconds = max(
        0,
        int(raw_timeout_seconds or _DEFAULT_REAL_REPLAY_SHARD_TIMEOUT_SECONDS),
    )
    if requested_timeout_seconds <= 0:
        return _DEFAULT_REAL_REPLAY_SHARD_TIMEOUT_SECONDS
    return min(requested_timeout_seconds, _DEFAULT_REAL_REPLAY_SHARD_TIMEOUT_SECONDS)


def _run_real_replay_shards(
    *,
    args: argparse.Namespace,
    output_dir: Path,
    specs: Sequence[CandidateSpec],
    shard_size: int,
    shard_timeout_seconds: int,
) -> EpochReplayResult:
    evidence_bundles: list[CandidateEvidenceBundle] = []
    replay_results: list[Mapping[str, Any]] = []
    shard_failures: list[dict[str, Any]] = []
    bounded_shard_timeout_seconds = _bounded_real_replay_shard_timeout_seconds(
        shard_timeout_seconds
    )
    plans = _build_real_replay_shards(
        args=args,
        output_dir=output_dir,
        specs=specs,
        shard_size=shard_size,
        shard_timeout_seconds=bounded_shard_timeout_seconds,
    )
    bounded_shard_size = max(1, int(shard_size))
    shard_workers = _bounded_real_replay_shard_workers(
        args=args,
        plans=plans,
    )
    if shard_workers <= 1:
        outcomes = [_execute_real_replay_shard(plan) for plan in plans]
    else:
        outcomes = []
        with ProcessPoolExecutor(max_workers=shard_workers) as executor:
            future_by_plan = {
                executor.submit(_execute_real_replay_shard, plan): plan
                for plan in plans
            }
            for future in as_completed(future_by_plan):
                outcomes.append(future.result())

    for outcome in sorted(outcomes, key=lambda item: item.shard_index):
        evidence_bundles.extend(outcome.result.evidence_bundles)
        replay_results.extend(outcome.result.replay_results)
        if outcome.failure is not None:
            shard_failures.append(dict(outcome.failure))

    deduped_evidence = _dedupe_replay_evidence(evidence_bundles)
    if shard_failures:
        (
            retry_evidence,
            retry_replay_results,
            remaining_failures,
            retry_summary,
        ) = _retry_real_replay_failed_shard_specs(
            args=args,
            output_dir=output_dir,
            specs=specs,
            shard_failures=shard_failures,
            shard_timeout_seconds=bounded_shard_timeout_seconds,
            starting_shard_index=len(plans),
        )
        if retry_evidence:
            evidence_bundles.extend(retry_evidence)
            deduped_evidence = _dedupe_replay_evidence(evidence_bundles)
        replay_results.extend(retry_replay_results)
        if retry_summary is not None:
            replay_results.append(dict(retry_summary))
        shard_failures = [dict(item) for item in remaining_failures]
    if shard_failures and not deduped_evidence:
        raise TimeoutError(f"real_replay_shards_failed:{len(shard_failures)}")
    if shard_failures:
        replay_results.append(
            {
                "status": "partial_replay_shards_interrupted",
                "schema_version": "torghut.whitepaper-autoresearch-shards.v1",
                "shard_size": bounded_shard_size,
                "shard_workers": shard_workers,
                "shard_timeout_seconds": bounded_shard_timeout_seconds,
                "selected_candidate_spec_count": len(specs),
                "evidence_bundle_count": len(deduped_evidence),
                "failures": shard_failures,
            }
        )
    return EpochReplayResult(
        evidence_bundles=deduped_evidence,
        replay_results=tuple(replay_results),
        incomplete=bool(shard_failures),
        failure_reasons=tuple(
            _string(item.get("reason")) for item in shard_failures if item.get("reason")
        ),
    )


def _load_epoch_program(args: argparse.Namespace) -> StrategyAutoresearchProgram:
    program = load_strategy_autoresearch_program(
        _resolve_existing_path(args.program),
        family_dir=_resolve_existing_path(args.family_template_dir),
    )
    if args.replay_mode == "synthetic":
        return replace(
            program,
            runtime_closure_policy=replace(
                program.runtime_closure_policy,
                execute_parity_replay=False,
                execute_approval_replay=False,
            ),
        )
    return program


def _resolved_staged_train_screen_multiplier(
    args: argparse.Namespace, program: StrategyAutoresearchProgram
) -> int:
    override = int(getattr(args, "staged_train_screen_multiplier", 0) or 0)
    if override > 0:
        return max(1, override)
    return max(1, int(program.replay_budget.staged_train_screen_multiplier))


def _resolved_program_family_int_arg(
    args: argparse.Namespace,
    program: StrategyAutoresearchProgram,
    name: str,
    *,
    default: int,
    minimum: int,
) -> int:
    override = int(getattr(args, name, 0) or 0)
    if override > 0:
        return max(minimum, override)
    program_value = max(
        (int(getattr(family, name, default)) for family in program.families),
        default=default,
    )
    return max(minimum, program_value)


def _resolved_real_replay_frontier_controls(
    args: argparse.Namespace, program: StrategyAutoresearchProgram
) -> dict[str, Any]:
    return {
        "symbol_prune_iterations": _resolved_program_family_int_arg(
            args, program, "symbol_prune_iterations", default=0, minimum=0
        ),
        "symbol_prune_candidates": _resolved_program_family_int_arg(
            args, program, "symbol_prune_candidates", default=1, minimum=1
        ),
        "symbol_prune_min_universe_size": _resolved_program_family_int_arg(
            args, program, "symbol_prune_min_universe_size", default=2, minimum=1
        ),
        "loss_repair_iterations": _resolved_program_family_int_arg(
            args, program, "loss_repair_iterations", default=0, minimum=0
        ),
        "loss_repair_candidates": _resolved_program_family_int_arg(
            args, program, "loss_repair_candidates", default=1, minimum=1
        ),
        "consistency_repair_iterations": _resolved_program_family_int_arg(
            args, program, "consistency_repair_iterations", default=0, minimum=0
        ),
        "consistency_repair_candidates": _resolved_program_family_int_arg(
            args, program, "consistency_repair_candidates", default=2, minimum=1
        ),
        "capture_rejected_seed_full_window_ledger": bool(
            getattr(args, "capture_rejected_seed_full_window_ledger", False)
        ),
        "capture_positive_rejected_full_window_ledgers": max(
            0,
            int(getattr(args, "capture_positive_rejected_full_window_ledgers", 0) or 0),
        ),
    }


def _epoch_mlx_snapshot_manifest(
    *,
    args: argparse.Namespace,
    output_dir: Path,
    epoch_id: str,
    program: StrategyAutoresearchProgram,
    source_count: int,
    hypothesis_count: int,
    candidate_spec_count: int,
    pre_replay_proposal_score_count: int,
    replay_candidate_spec_count: int,
    evidence_bundle_count: int,
    proposal_score_count: int,
    portfolio_candidate_count: int,
) -> MlxSnapshotManifest:
    return build_mlx_snapshot_manifest(
        runner_run_id=epoch_id,
        program=program,
        symbols=str(args.symbols),
        train_days=int(args.train_days),
        holdout_days=int(args.holdout_days),
        full_window_start_date=str(args.full_window_start_date),
        full_window_end_date=str(args.full_window_end_date),
        tensor_bundle_paths={
            "hypothesis_cards_jsonl": str(output_dir / "hypothesis-cards.jsonl"),
            "candidate_specs_jsonl": str(output_dir / "candidate-specs.jsonl"),
            "candidate_selection_manifest_json": str(
                output_dir / "candidate-selection-manifest.json"
            ),
            "pre_replay_proposal_scores_jsonl": str(
                output_dir / "pre-replay-mlx-proposal-scores.jsonl"
            ),
            "proposal_scores_jsonl": str(output_dir / "mlx-proposal-scores.jsonl"),
            "candidate_evidence_bundles_jsonl": str(
                output_dir / "candidate-evidence-bundles.jsonl"
            ),
            "portfolio_candidates_jsonl": str(
                output_dir / "portfolio-candidates.jsonl"
            ),
        },
        row_counts={
            "sources": source_count,
            "hypothesis_cards": hypothesis_count,
            "candidate_specs": candidate_spec_count,
            "pre_replay_proposal_scores": pre_replay_proposal_score_count,
            "replay_candidate_specs": replay_candidate_spec_count,
            "candidate_evidence_bundles": evidence_bundle_count,
            "proposal_scores": proposal_score_count,
            "portfolio_candidates": portfolio_candidate_count,
        },
    )


def _runtime_closure_payload(
    *,
    args: argparse.Namespace,
    output_dir: Path,
    epoch_id: str,
    program: StrategyAutoresearchProgram,
    manifest: MlxSnapshotManifest,
    portfolio: PortfolioCandidateSpec | None,
) -> Mapping[str, Any]:
    execution_context = RuntimeClosureExecutionContext(
        strategy_configmap_path=_resolve_existing_path(args.strategy_configmap),
        clickhouse_http_url=str(args.clickhouse_http_url),
        clickhouse_username=str(args.clickhouse_username)
        if args.clickhouse_username
        else None,
        clickhouse_password=str(args.clickhouse_password)
        if args.clickhouse_password
        else None,
        start_equity=_decimal(args.start_equity, default="31590.02"),
        chunk_minutes=int(args.chunk_minutes),
        symbols=tuple(
            symbol.strip() for symbol in str(args.symbols).split(",") if symbol.strip()
        ),
        progress_log_interval_seconds=int(args.progress_log_seconds),
        shadow_validation_artifact_path=_resolve_existing_path(
            cast(Path, getattr(args, "shadow_validation_artifact"))
        )
        if getattr(args, "shadow_validation_artifact", None) is not None
        else None,
    )
    return write_runtime_closure_bundle(
        run_root=output_dir,
        runner_run_id=epoch_id,
        program=program,
        best_candidate=portfolio,
        manifest=manifest,
        execution_context=execution_context if portfolio is not None else None,
    ).to_payload()


def _boolish(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return _string(value).lower() in {"1", "true", "yes", "y", "passed"}


def _oracle_blockers(scorecard: Mapping[str, Any]) -> frozenset[str]:
    raw_blockers = _mapping(scorecard.get("profit_target_oracle")).get("blockers")
    if not isinstance(raw_blockers, Sequence) or isinstance(raw_blockers, str):
        return frozenset()
    return frozenset(
        blocker
        for blocker in (_string(item) for item in cast(Sequence[Any], raw_blockers))
        if blocker
    )


def _portfolio_needs_runtime_closure_proof(portfolio: PortfolioCandidateSpec) -> bool:
    scorecard = _mapping(portfolio.objective_scorecard)
    if _boolish(scorecard.get("oracle_passed")):
        return False
    if not _boolish(scorecard.get("target_met")):
        return False
    blockers = _oracle_blockers(scorecard)
    return bool(blockers) and blockers <= _RUNTIME_CLOSURE_PROOF_ORACLE_BLOCKERS


def _load_json_mapping_artifact(path_value: Any) -> dict[str, Any]:
    path_text = _string(path_value)
    if not path_text:
        return {}
    try:
        payload = json.loads(Path(path_text).read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}
    return _mapping(payload)


def _runtime_closure_artifact_refs(
    runtime_closure: Mapping[str, Any],
) -> tuple[str, ...]:
    refs: list[str] = []
    root = _string(runtime_closure.get("root"))
    if root:
        summary_path = Path(root) / "summary.json"
        if summary_path.exists():
            refs.append(str(summary_path))
    for key in (
        "candidate_configmap_path",
        "gate_report_path",
        "parity_replay_path",
        "parity_report_path",
        "approval_replay_path",
        "approval_report_path",
        "exact_replay_ledger_artifact_path",
        "exact_replay_ledger_artifact_ref",
        "runtime_ledger_artifact_path",
        "runtime_ledger_artifact_ref",
        "shadow_validation_path",
        "portfolio_proof_receipt_path",
        "market_impact_stress_report_path",
        "market_impact_stress_artifact_path",
        "delay_adjusted_depth_stress_report_path",
        "delay_depth_stress_report_path",
        "latency_depth_stress_artifact_path",
        "double_oos_report_path",
        "double_oos_artifact_path",
        "walkforward_double_oos_report_path",
        "stress_metrics_path",
        "profitability_stage_manifest_path",
        "promotion_prerequisites_path",
        "replay_plan_path",
    ):
        ref = _string(runtime_closure.get(key))
        if ref and Path(ref).exists() and ref not in refs:
            refs.append(ref)
    return tuple(refs)


def _runtime_report_summary_int(
    report: Mapping[str, Any], key: str, *, default: int = 0
) -> int:
    value = _mapping(report.get("summary")).get(key)
    try:
        return max(0, int(Decimal(str(value if value is not None else default))))
    except Exception:
        return default


def _runtime_report_int(value: Any, *, default: int = 0) -> int:
    try:
        return max(0, int(Decimal(str(value if value is not None else default))))
    except Exception:
        return default


_EXACT_REPLAY_LEDGER_ARTIFACT_KIND = "exact_replay_ledger"
_EXACT_REPLAY_LEDGER_SCHEMA_VERSIONS = frozenset(
    {
        "torghut.exact_replay_ledger.rows.v1",
        "torghut.exact_replay_ledger.v1",
    }
)
_EXACT_REPLAY_RUNTIME_LEDGER_PNL_SOURCE = "exact_replay_runtime_ledger"


def _runtime_closure_ledger_datetime(
    value: Any, *, date_end: bool = False
) -> datetime | None:
    text = _string(value)
    if not text:
        return None
    try:
        if "T" not in text and len(text) == 10:
            parsed_date = date.fromisoformat(text)
            parsed = datetime.combine(parsed_date, time.min, tzinfo=UTC)
            return parsed + timedelta(days=1) if date_end else parsed
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _runtime_closure_exact_replay_bucket_range(
    ledger: Mapping[str, Any],
) -> tuple[datetime, datetime] | None:
    start = _runtime_closure_ledger_datetime(
        ledger.get("window_start")
        or ledger.get("bucket_started_at")
        or ledger.get("started_at")
        or ledger.get("start"),
    )
    end = _runtime_closure_ledger_datetime(
        ledger.get("window_end")
        or ledger.get("bucket_ended_at")
        or ledger.get("ended_at")
        or ledger.get("end"),
        date_end=True,
    )
    if start is None or end is None or end <= start:
        return None
    return (start, end)


def _runtime_closure_replay_bucket_has_authority(bucket: RuntimeLedgerBucket) -> bool:
    return (
        not bucket.blockers
        and bucket.fill_count > 0
        and bucket.decision_count > 0
        and bucket.submitted_order_count > 0
        and bucket.closed_trade_count > 0
        and bucket.open_position_count == 0
        and bucket.filled_notional > 0
        and bool(bucket.cost_basis_counts)
        and bool(bucket.execution_policy_hash_counts)
        and bool(bucket.cost_model_hash_counts)
        and bool(bucket.lineage_hash_counts)
        and bucket.pnl_basis == POST_COST_PNL_BASIS
    )


def _runtime_closure_exact_replay_bucket(
    *,
    ledger: Mapping[str, Any],
    rows: Sequence[Mapping[str, object]],
) -> RuntimeLedgerBucket | None:
    bucket_range = _runtime_closure_exact_replay_bucket_range(ledger)
    if bucket_range is None:
        return None
    buckets = build_runtime_ledger_buckets(
        rows,
        bucket_ranges=[bucket_range],
        require_order_lifecycle=True,
    )
    if len(buckets) != 1:
        return None
    bucket = buckets[0]
    if not _runtime_closure_replay_bucket_has_authority(bucket):
        return None
    return bucket


def _runtime_report_source_markers(report: Mapping[str, Any]) -> list[str]:
    return sorted(set(_string_list_from_value(report.get("source_markers"))))


def _runtime_closure_start_equity(runtime_closure: Mapping[str, Any]) -> Decimal:
    replay_plan = _load_json_mapping_artifact(runtime_closure.get("replay_plan_path"))
    execution_context = _mapping(replay_plan.get("execution_context"))
    return _decimal(execution_context.get("start_equity"))


def _portfolio_executable_max_notional(portfolio: PortfolioCandidateSpec) -> Decimal:
    max_notional = Decimal("0")
    base_per_leg_notional = Decimal("50000")
    for sleeve in portfolio.sleeves:
        explicit_max = _decimal(sleeve.get("max_notional_per_trade"))
        if explicit_max > 0:
            max_notional = max(max_notional, explicit_max)
            continue
        weight = _decimal(sleeve.get("weight"), default="1")
        if weight <= 0:
            weight = Decimal("1")
        max_notional = max(max_notional, base_per_leg_notional * weight)
    return max_notional


def _runtime_closure_exact_replay_ledger_update(
    runtime_closure: Mapping[str, Any],
) -> dict[str, Any]:
    # Exact-replay rows are useful diagnostics, but they are not runtime or
    # live-paper ledger authority. Final proof must come from source-backed
    # runtime-ledger materialization instead of replay artifacts.
    return {}


def _runtime_closure_market_impact_stress_update(
    runtime_closure: Mapping[str, Any],
) -> dict[str, Any]:
    market_impact_report_path = _string(
        runtime_closure.get("market_impact_stress_report_path")
        or runtime_closure.get("market_impact_stress_artifact_path")
    )
    market_impact_report = _load_json_mapping_artifact(market_impact_report_path)
    if not market_impact_report:
        return {}
    model = _string(
        market_impact_report.get("model")
        or market_impact_report.get("impact_model")
        or market_impact_report.get("cost_model")
    )
    cost_bps = str(
        _decimal(
            market_impact_report.get("impact_cost_bps")
            or market_impact_report.get("market_impact_cost_bps")
            or market_impact_report.get("cost_shock_bps")
        )
    )
    net_pnl_per_day = str(
        _decimal(
            market_impact_report.get("post_impact_net_pnl_per_day")
            or market_impact_report.get("stressed_net_pnl_per_day")
            or market_impact_report.get("net_pnl_per_day")
        )
    )
    components = _mapping(market_impact_report.get("market_impact_stress_components"))
    if not components and model and _decimal(cost_bps) > 0:
        components = {
            "selected_model": model,
            "selected_cost_bps": cost_bps,
            "source_marker": "realistic_market_impact_arxiv_2603_29086_2026",
        }
    return {
        "market_impact_stress_passed": _boolish(
            market_impact_report.get("objective_met")
            or market_impact_report.get("passed")
        ),
        "market_impact_stress_artifact_ref": market_impact_report_path,
        "market_impact_stress_source_markers": _runtime_report_source_markers(
            market_impact_report
        ),
        "market_impact_stress_model": model,
        "market_impact_stress_cost_bps": cost_bps,
        "market_impact_stress_components": components,
        "nonlinear_market_impact_stress_passed": _boolish(
            market_impact_report.get("objective_met")
            or market_impact_report.get("passed")
        ),
        "nonlinear_market_impact_stress_model": model,
        "nonlinear_market_impact_stress_cost_bps": cost_bps,
        "nonlinear_market_impact_stress_net_pnl_per_day": net_pnl_per_day,
        "permanent_impact_decay_model": _string(
            market_impact_report.get("permanent_impact_decay_model")
            or "exponential_decay_proxy"
        ),
        "market_impact_liquidity_evidence_present": _boolish(
            market_impact_report.get("liquidity_evidence_present")
            or market_impact_report.get("market_impact_liquidity_evidence_present")
        ),
        "market_impact_stress_net_pnl_per_day": net_pnl_per_day,
    }


def _runtime_closure_delay_adjusted_depth_stress_update(
    runtime_closure: Mapping[str, Any],
) -> dict[str, Any]:
    delay_depth_report_path = _string(
        runtime_closure.get("delay_adjusted_depth_stress_report_path")
        or runtime_closure.get("delay_depth_stress_report_path")
        or runtime_closure.get("latency_depth_stress_artifact_path")
    )
    delay_depth_report = _load_json_mapping_artifact(delay_depth_report_path)
    if not delay_depth_report:
        return {}
    checked_at = _string(
        delay_depth_report.get("generated_at") or delay_depth_report.get("checked_at")
    )
    fillable_notional_per_day = _decimal(
        delay_depth_report.get("fillable_notional_per_day")
        or delay_depth_report.get("depth_fillable_notional_per_day")
    )
    stress_ms = _decimal(
        delay_depth_report.get("stress_delay_ms") or delay_depth_report.get("delay_ms")
    )
    latency_grid = cast(
        Sequence[Any],
        delay_depth_report.get("latency_grid_ms")
        or delay_depth_report.get("delay_grid_ms")
        or (),
    )
    if not latency_grid and stress_ms > 0:
        latency_grid = ("50", "150", "250")
    fill_survival_sample_count = max(
        _runtime_report_int(
            delay_depth_report.get("delay_adjusted_depth_fill_survival_sample_count")
        ),
        _runtime_report_int(delay_depth_report.get("fill_survival_sample_count")),
    )
    fill_survival_rate = _decimal(
        delay_depth_report.get("delay_adjusted_depth_fill_survival_rate")
        or delay_depth_report.get("fill_survival_fill_rate")
        or delay_depth_report.get("fill_survival_rate")
    )
    fill_survival_evidence_present = _boolish(
        delay_depth_report.get("delay_adjusted_depth_fill_survival_evidence_present")
        or delay_depth_report.get("fill_survival_evidence_present")
        or (fill_survival_sample_count > 0)
    )
    queue_position_survival_evidence_present = _boolish(
        delay_depth_report.get("queue_position_survival_fill_curve_evidence_present")
        or delay_depth_report.get("queue_position_survival_evidence_present")
    )
    queue_position_survival_sample_count = max(
        _runtime_report_int(
            delay_depth_report.get("queue_position_survival_sample_count")
        ),
        _runtime_report_int(
            delay_depth_report.get("queue_position_survival_fill_sample_count")
        ),
    )
    if (
        queue_position_survival_evidence_present
        and queue_position_survival_sample_count == 0
    ):
        queue_position_survival_sample_count = fill_survival_sample_count
    queue_position_survival_fill_rate = _decimal(
        delay_depth_report.get("queue_position_survival_fill_rate")
        or (
            fill_survival_rate
            if queue_position_survival_evidence_present
            else Decimal("0")
        )
    )
    queue_position_survival_queue_ratio_p95 = _decimal(
        delay_depth_report.get("queue_position_survival_queue_ratio_p95")
    )
    queue_ahead_depletion_sample_count = max(
        _runtime_report_int(
            delay_depth_report.get(
                "queue_position_survival_queue_ahead_depletion_sample_count"
            )
        ),
        _runtime_report_int(
            delay_depth_report.get(
                "delay_adjusted_depth_queue_ahead_depletion_sample_count"
            )
        ),
        _runtime_report_int(
            delay_depth_report.get("queue_ahead_depletion_sample_count")
        ),
    )
    queue_ahead_depletion_evidence_present = _boolish(
        delay_depth_report.get(
            "queue_position_survival_queue_ahead_depletion_evidence_present"
        )
        or delay_depth_report.get(
            "delay_adjusted_depth_queue_ahead_depletion_evidence_present"
        )
        or delay_depth_report.get("queue_ahead_depletion_evidence_present")
        or (queue_ahead_depletion_sample_count > 0)
    )
    queue_position_survival_net_pnl_per_day = _decimal(
        delay_depth_report.get(
            "post_cost_net_pnl_after_queue_position_survival_fill_stress"
        )
        or delay_depth_report.get("post_queue_position_survival_net_pnl_per_day")
        or (
            delay_depth_report.get("post_delay_depth_net_pnl_per_day")
            if queue_position_survival_evidence_present
            and queue_ahead_depletion_evidence_present
            else Decimal("0")
        )
    )
    return {
        "delay_adjusted_depth_stress_checks_total": max(
            _runtime_report_int(delay_depth_report.get("stress_case_count")),
            _runtime_report_int(delay_depth_report.get("case_count")),
            _runtime_report_int(delay_depth_report.get("trading_day_count")),
        ),
        "delay_adjusted_depth_stress_passed": _boolish(
            delay_depth_report.get("objective_met") or delay_depth_report.get("passed")
        ),
        "delay_adjusted_depth_stress_checked_at": checked_at,
        "delay_adjusted_depth_stress_artifact_ref": delay_depth_report_path,
        "delay_adjusted_depth_stress_source_markers": _runtime_report_source_markers(
            delay_depth_report
        ),
        "delay_adjusted_depth_stress_report": dict(delay_depth_report),
        "delay_adjusted_depth_stress_model": _string(
            delay_depth_report.get("model") or delay_depth_report.get("stress_model")
        ),
        "delay_adjusted_depth_stress_ms": str(stress_ms),
        "delay_adjusted_depth_latency_grid_ms": [str(item) for item in latency_grid],
        "delay_adjusted_depth_grid_max_stress_ms": str(
            max((_decimal(item) for item in latency_grid), default=stress_ms)
        ),
        "delay_adjusted_depth_liquidity_evidence_present": bool(
            fillable_notional_per_day > 0
        ),
        "delay_adjusted_depth_liquidity_missing_day_count": _runtime_report_int(
            delay_depth_report.get("missing_liquidity_day_count")
        ),
        "delay_adjusted_depth_fillable_notional_per_day": str(
            fillable_notional_per_day
        ),
        "delay_adjusted_depth_worst_active_day_fillable_notional": str(
            _decimal(
                delay_depth_report.get("worst_active_day_fillable_notional")
                or fillable_notional_per_day
            )
        ),
        "delay_adjusted_depth_p10_active_day_fillable_notional": str(
            _decimal(
                delay_depth_report.get("p10_active_day_fillable_notional")
                or fillable_notional_per_day
            )
        ),
        "delay_adjusted_depth_tail_coverage_passed": _boolish(
            delay_depth_report.get("tail_coverage_passed")
            if "tail_coverage_passed" in delay_depth_report
            else fillable_notional_per_day > 0
        ),
        "delay_adjusted_depth_fill_survival_evidence_present": fill_survival_evidence_present,
        "delay_adjusted_depth_fill_survival_sample_count": fill_survival_sample_count,
        "delay_adjusted_depth_fill_survival_rate": str(fill_survival_rate),
        "queue_position_survival_fill_curve_evidence_present": (
            queue_position_survival_evidence_present
        ),
        "queue_position_survival_sample_count": queue_position_survival_sample_count,
        "queue_position_survival_fill_rate": str(queue_position_survival_fill_rate),
        "queue_position_survival_queue_ratio_p95": str(
            queue_position_survival_queue_ratio_p95
        ),
        "queue_position_survival_queue_ahead_depletion_evidence_present": (
            queue_ahead_depletion_evidence_present
        ),
        "queue_position_survival_queue_ahead_depletion_sample_count": (
            queue_ahead_depletion_sample_count
        ),
        "delay_adjusted_depth_queue_ahead_depletion_evidence_present": (
            queue_ahead_depletion_evidence_present
        ),
        "delay_adjusted_depth_queue_ahead_depletion_sample_count": (
            queue_ahead_depletion_sample_count
        ),
        "queue_ahead_depletion_evidence_present": queue_ahead_depletion_evidence_present,
        "queue_ahead_depletion_sample_count": queue_ahead_depletion_sample_count,
        "delay_adjusted_depth_stress_net_pnl_per_day": str(
            _decimal(
                delay_depth_report.get("post_delay_depth_net_pnl_per_day")
                or delay_depth_report.get("stressed_net_pnl_per_day")
            )
        ),
        "post_cost_net_pnl_after_queue_position_survival_fill_stress": str(
            queue_position_survival_net_pnl_per_day
        ),
    }


def _runtime_closure_double_oos_update(
    runtime_closure: Mapping[str, Any],
) -> dict[str, Any]:
    double_oos_report_path = _string(
        runtime_closure.get("double_oos_report_path")
        or runtime_closure.get("double_oos_artifact_path")
        or runtime_closure.get("walkforward_double_oos_report_path")
    )
    double_oos_report = _load_json_mapping_artifact(double_oos_report_path)
    if not double_oos_report:
        return {}
    return {
        "double_oos_passed": _boolish(
            double_oos_report.get("objective_met") or double_oos_report.get("passed")
        ),
        "double_oos_artifact_ref": double_oos_report_path,
        "double_oos_source_markers": _runtime_report_source_markers(double_oos_report),
        "double_oos_independent_window_count": max(
            _runtime_report_int(double_oos_report.get("independent_window_count")),
            _runtime_report_int(double_oos_report.get("window_count")),
            _runtime_report_int(double_oos_report.get("fold_count")),
        ),
        "double_oos_pass_rate": str(_decimal(double_oos_report.get("pass_rate"))),
        "double_oos_net_pnl_per_day": str(
            _decimal(
                double_oos_report.get("net_pnl_per_day")
                or double_oos_report.get("post_double_oos_net_pnl_per_day")
            )
        ),
        "double_oos_cost_shock_net_pnl_per_day": str(
            _decimal(
                double_oos_report.get("cost_shock_net_pnl_per_day")
                or double_oos_report.get("post_cost_shock_net_pnl_per_day")
                or double_oos_report.get("market_impact_stress_net_pnl_per_day")
            )
        ),
    }


def _runtime_closure_scorecard_update(
    *,
    portfolio: PortfolioCandidateSpec,
    runtime_closure: Mapping[str, Any],
) -> dict[str, Any]:
    parity_report = _load_json_mapping_artifact(
        runtime_closure.get("parity_report_path")
    )
    approval_report = _load_json_mapping_artifact(
        runtime_closure.get("approval_report_path")
    )
    shadow_validation = _load_json_mapping_artifact(
        runtime_closure.get("shadow_validation_path")
    )
    parity_pass = _boolish(parity_report.get("objective_met"))
    approval_pass = _boolish(approval_report.get("objective_met"))
    artifact_refs = _runtime_closure_artifact_refs(runtime_closure)
    executable_artifact_refs = tuple(
        ref
        for ref in (
            _string(runtime_closure.get("parity_replay_path")),
            _string(runtime_closure.get("approval_replay_path")),
        )
        if ref and Path(ref).exists()
    )
    executable_report = approval_report if approval_report else parity_report
    filled_order_count = _runtime_report_summary_int(executable_report, "filled_count")
    submitted_order_count = _runtime_report_summary_int(
        executable_report, "decision_count"
    )
    shadow_status = _string(shadow_validation.get("status")) or "missing"
    market_impact_update = _runtime_closure_market_impact_stress_update(runtime_closure)
    delay_depth_update = _runtime_closure_delay_adjusted_depth_stress_update(
        runtime_closure
    )
    double_oos_update = _runtime_closure_double_oos_update(runtime_closure)
    exact_replay_ledger_update = _runtime_closure_exact_replay_ledger_update(
        runtime_closure
    )
    runtime_closure_source_markers = sorted(
        set(
            _string_list_from_value(
                market_impact_update.get("market_impact_stress_source_markers")
            )
            + _string_list_from_value(
                delay_depth_update.get("delay_adjusted_depth_stress_source_markers")
            )
            + _string_list_from_value(
                double_oos_update.get("double_oos_source_markers")
            )
        )
    )
    return {
        "runtime_closure_proof": {
            "status": _string(runtime_closure.get("status")) or "missing",
            "parity_objective_met": parity_pass,
            "approval_objective_met": approval_pass,
            "shadow_status": shadow_status,
            "artifact_refs": list(artifact_refs),
            "executable_replay_artifact_refs": list(executable_artifact_refs),
            "market_impact_stress_artifact_ref": market_impact_update.get(
                "market_impact_stress_artifact_ref", ""
            ),
            "delay_adjusted_depth_stress_artifact_ref": delay_depth_update.get(
                "delay_adjusted_depth_stress_artifact_ref", ""
            ),
            "double_oos_artifact_ref": double_oos_update.get(
                "double_oos_artifact_ref", ""
            ),
            "exact_replay_ledger_artifact_ref": exact_replay_ledger_update.get(
                "exact_replay_ledger_artifact_ref", ""
            ),
        },
        "runtime_closure_artifact_refs": list(artifact_refs),
        "shadow_parity_status": "within_budget"
        if shadow_status == "within_budget"
        else shadow_status,
        "executable_replay_passed": (
            parity_pass and approval_pass and bool(executable_artifact_refs)
        ),
        "executable_replay_artifact_refs": list(executable_artifact_refs),
        "executable_replay_artifact_ref": executable_artifact_refs[-1]
        if executable_artifact_refs
        else "",
        "executable_replay_order_count": filled_order_count,
        "executable_replay_submitted_order_count": submitted_order_count,
        "executable_replay_account_buying_power": str(
            _runtime_closure_start_equity(runtime_closure)
        ),
        "executable_replay_max_notional_per_trade": str(
            _portfolio_executable_max_notional(portfolio)
        ),
        "runtime_closure_source_markers": runtime_closure_source_markers,
        **exact_replay_ledger_update,
        **market_impact_update,
        **delay_depth_update,
        **double_oos_update,
    }


def _runtime_closure_pending_promotion_steps(
    runtime_closure: Mapping[str, Any],
) -> tuple[str, ...]:
    return tuple(
        step
        for step in (
            _string(item)
            for item in cast(
                Sequence[Any], runtime_closure.get("next_required_steps") or ()
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
    if _boolish(prerequisites.get("allowed")):
        return ()
    reasons = tuple(
        reason
        for reason in (
            _string(item)
            for item in cast(Sequence[Any], prerequisites.get("reasons") or ())
        )
        if reason
    )
    return reasons or ("promotion_prerequisites_denied",)


def _promotion_readiness_payload(
    *,
    oracle_candidate_found: bool,
    status: str,
    blockers: Sequence[str],
    runtime_closure: Mapping[str, Any],
) -> dict[str, Any]:
    blocker_list = list(
        dict.fromkeys(_string(item) for item in blockers if _string(item))
    )
    if oracle_candidate_found:
        blocker_list = list(
            dict.fromkeys(
                (
                    *blocker_list,
                    *_runtime_closure_pending_promotion_steps(runtime_closure),
                    *_runtime_closure_promotion_prerequisite_blockers(runtime_closure),
                )
            )
        )
    if oracle_candidate_found and not blocker_list:
        return {
            "status": "promotion_ready",
            "promotable": True,
            "blockers": [],
        }
    return {
        "status": "blocked_pending_promotion_prerequisites"
        if oracle_candidate_found and blocker_list
        else status,
        "promotable": False,
        "blockers": blocker_list,
    }


def _candidate_board_score_rows(
    rows: Sequence[Mapping[str, Any]],
) -> dict[str, Mapping[str, Any]]:
    return {
        _string(row.get("candidate_spec_id")): row
        for row in rows
        if _string(row.get("candidate_spec_id"))
    }


def _candidate_board_decimal_field(scorecard: Mapping[str, Any], key: str) -> str:
    value = scorecard.get(key)
    if value is None:
        return ""
    return str(value)


def _candidate_board_int_field(scorecard: Mapping[str, Any], key: str) -> int:
    try:
        return max(0, int(Decimal(str(scorecard.get(key, 0) or 0))))
    except Exception:
        return 0


def _candidate_board_first_int_field(
    scorecard: Mapping[str, Any], keys: Sequence[str]
) -> int:
    for key in keys:
        value = _candidate_board_int_field(scorecard, key)
        if value > 0:
            return value
    return 0


def _candidate_board_rejected_signal_outcome_summary(
    spec: CandidateSpec, scorecard: Mapping[str, Any]
) -> dict[str, Any]:
    required = _candidate_spec_requires_rejected_signal_outcome_learning(spec)
    required_fields = tuple(
        _string_list_from_value(
            spec.hard_vetoes.get("required_rejected_signal_counterfactual_fields")
        )
        or (
            "counterfactual_return",
            "route_tca",
            "post_cost_net_pnl",
            "executable_quote",
        )
    )
    observed_fields = set(
        _string_list_from_value(
            scorecard.get("rejected_signal_counterfactual_fields")
            or scorecard.get("rejected_signal_outcome_counterfactual_fields")
            or scorecard.get("rejected_signal_counterfactual_fields_present")
        )
    )
    if _boolish(scorecard.get("rejected_signal_counterfactual_fields_present")):
        observed_fields.update(required_fields)
    min_label_count = _candidate_board_int_field(
        spec.hard_vetoes, "required_min_rejected_signal_outcome_label_count"
    )
    if min_label_count <= 0:
        min_label_count = 120
    max_pending_ratio = _decimal(
        spec.hard_vetoes.get("required_max_rejected_signal_outcome_pending_ratio"),
        default="0.05",
    )
    min_reason_coverage = _decimal(
        spec.hard_vetoes.get("required_min_rejected_signal_reason_coverage"),
        default="0.80",
    )
    required_persistence_state = _string(
        spec.hard_vetoes.get("required_rejected_signal_outcome_persistence_state")
        or "ok"
    ).lower()
    label_count = _candidate_board_first_int_field(
        scorecard,
        (
            "rejected_signal_outcome_labeled_count",
            "rejected_signal_outcome_label_count",
            "rejected_signal_outcome_labeled_event_count",
        ),
    )
    pending_ratio = _decimal(
        scorecard.get("rejected_signal_outcome_pending_ratio"), default="1"
    )
    reason_coverage = _decimal(
        scorecard.get("rejected_signal_reason_coverage")
        or scorecard.get("rejected_signal_outcome_reason_coverage")
    )
    persistence_state = _string(
        scorecard.get("rejected_signal_outcome_persistence_state")
        or scorecard.get("rejected_signal_persistence_state")
    ).lower()
    blockers: list[str] = []
    if required:
        if label_count < min_label_count:
            blockers.append("rejected_signal_outcome_labeled_count_failed")
        if pending_ratio > max_pending_ratio:
            blockers.append("rejected_signal_outcome_pending_ratio_failed")
        if reason_coverage < min_reason_coverage:
            blockers.append("rejected_signal_reason_coverage_failed")
        if not set(required_fields).issubset(observed_fields):
            blockers.append("rejected_signal_counterfactual_fields_present_failed")
        if persistence_state != required_persistence_state:
            blockers.append("rejected_signal_outcome_persistence_state_failed")
    return {
        "required": required,
        "passed": not blockers,
        "blockers": blockers,
        "labeled_count": label_count,
        "min_labeled_count": min_label_count,
        "pending_ratio": str(pending_ratio),
        "max_pending_ratio": str(max_pending_ratio),
        "reason_coverage": str(reason_coverage),
        "min_reason_coverage": str(min_reason_coverage),
        "persistence_state": persistence_state,
        "required_persistence_state": required_persistence_state,
        "counterfactual_fields": sorted(observed_fields),
        "required_counterfactual_fields": list(required_fields),
    }


def _candidate_spec_requires_order_type_execution_quality(spec: CandidateSpec) -> bool:
    overlay_ids = set(
        _string_list_from_value(spec.parameter_space.get("mechanism_overlay_ids"))
    )
    return (
        "mixed_market_limit_execution_policy" in overlay_ids
        or _boolish(
            spec.promotion_contract.get("requires_order_type_execution_quality")
        )
        or _boolish(spec.promotion_contract.get("requires_order_type_ablation"))
        or _boolish(spec.promotion_contract.get("requires_market_limit_order_mix"))
        or "required_order_type_ablation_passed" in spec.hard_vetoes
        or "required_market_limit_order_mix_evidence" in spec.hard_vetoes
    )


def _candidate_spec_requires_predictability_decay_stress(
    spec: CandidateSpec,
) -> bool:
    overlay_ids = set(
        _string_list_from_value(spec.parameter_space.get("mechanism_overlay_ids"))
    )
    return (
        "alpha_decay_predictability_stress" in overlay_ids
        or _boolish(spec.promotion_contract.get("requires_predictability_decay_stress"))
        or _boolish(spec.promotion_contract.get("requires_horizon_decay_curve"))
        or _boolish(
            spec.promotion_contract.get("requires_spread_adjusted_label_replay")
        )
        or "required_predictability_decay_stress" in spec.hard_vetoes
        or "required_horizon_decay_curve" in spec.hard_vetoes
        or "required_spread_adjusted_label_replay" in spec.hard_vetoes
    )


def _candidate_board_predictability_decay_summary(
    spec: CandidateSpec, scorecard: Mapping[str, Any], *, target: Decimal
) -> dict[str, Any]:
    required = _candidate_spec_requires_predictability_decay_stress(spec)
    artifact_refs = _string_list_from_value(
        scorecard.get("predictability_decay_stress_artifact_refs")
        or scorecard.get("predictability_decay_stress_artifact_ref")
        or scorecard.get("alpha_decay_stress_artifact_ref")
    )
    available_refs = set(
        _string_list_from_value(scorecard.get("replay_artifact_refs"))
        or _string_list_from_value(scorecard.get("artifact_refs"))
    )
    horizon_count = _candidate_board_first_int_field(
        scorecard,
        (
            "predictability_decay_stress_horizon_count",
            "horizon_decay_curve_horizon_count",
        ),
    )
    tight_spread_count = _candidate_board_first_int_field(
        scorecard,
        ("tight_spread_regime_slice_count", "tight_spread_regime_count"),
    )
    split_pass_rate = _decimal(
        scorecard.get("predictability_decay_stress_split_pass_rate")
        or scorecard.get("decay_stress_split_pass_rate")
    )
    best_split_share = _decimal(
        scorecard.get("predictability_decay_stress_best_split_share")
        or scorecard.get("decay_stress_best_split_share"),
        default="1",
    )
    stress_net_pnl_per_day = _decimal(
        scorecard.get("post_cost_net_pnl_after_predictability_decay_stress")
        or scorecard.get("predictability_decay_stress_net_pnl_per_day")
    )
    min_horizon_count = _candidate_board_int_field(
        spec.hard_vetoes, "required_min_decay_stress_horizon_count"
    )
    if min_horizon_count <= 0:
        min_horizon_count = 3
    min_tight_spread_count = _candidate_board_int_field(
        spec.hard_vetoes, "required_min_tight_spread_regime_count"
    )
    if min_tight_spread_count <= 0:
        min_tight_spread_count = 20
    min_split_pass_rate = _decimal(
        spec.hard_vetoes.get("required_min_decay_stress_split_pass_rate"),
        default="0.60",
    )
    max_best_split_share = _decimal(
        spec.hard_vetoes.get("required_max_decay_stress_best_split_share"),
        default="0.35",
    )
    blockers: list[str] = []
    missing_artifact_refs: list[str] = []
    if required:
        if not _boolish(
            scorecard.get("predictability_decay_stress_passed")
            or scorecard.get("alpha_decay_stress_passed")
        ):
            blockers.append("predictability_decay_stress_passed_failed")
        if not artifact_refs:
            blockers.append("predictability_decay_stress_artifact_present_failed")
        missing_artifact_refs = [
            ref for ref in artifact_refs if available_refs and ref not in available_refs
        ]
        if missing_artifact_refs:
            blockers.append(
                "predictability_decay_stress_artifact_ref_missing_from_bundle"
            )
        if not _boolish(
            scorecard.get("horizon_decay_curve_present")
            or scorecard.get("predictability_horizon_decay_curve_present")
        ):
            blockers.append("horizon_decay_curve_present_failed")
        if not _boolish(
            scorecard.get("spread_adjusted_label_replay_present")
            or scorecard.get("spread_adjusted_labels_present")
        ):
            blockers.append("spread_adjusted_label_replay_present_failed")
        if horizon_count < min_horizon_count:
            blockers.append("predictability_decay_stress_horizon_count_failed")
        if tight_spread_count < min_tight_spread_count:
            blockers.append("tight_spread_regime_slice_count_failed")
        if split_pass_rate < min_split_pass_rate:
            blockers.append("predictability_decay_stress_split_pass_rate_failed")
        if best_split_share > max_best_split_share:
            blockers.append("predictability_decay_stress_best_split_share_failed")
        if stress_net_pnl_per_day < target:
            blockers.append(
                "post_cost_net_pnl_after_predictability_decay_stress_failed"
            )
    return {
        "required": required,
        "passed": not blockers,
        "blockers": blockers,
        "artifact_refs": artifact_refs,
        "missing_replay_artifact_refs": missing_artifact_refs
        if required and artifact_refs
        else [],
        "horizon_count": horizon_count,
        "min_horizon_count": min_horizon_count,
        "tight_spread_regime_slice_count": tight_spread_count,
        "min_tight_spread_regime_slice_count": min_tight_spread_count,
        "split_pass_rate": str(split_pass_rate),
        "min_split_pass_rate": str(min_split_pass_rate),
        "best_split_share": str(best_split_share),
        "max_best_split_share": str(max_best_split_share),
        "stress_net_pnl_per_day": str(stress_net_pnl_per_day),
        "target_net_pnl_per_day": str(target),
        "source_marker": "tkan_lob_alpha_decay_arxiv_2601_02310_2026",
    }


def _candidate_board_scorecard_with_predictability_decay_blockers(
    spec: CandidateSpec, scorecard: Mapping[str, Any], *, target: Decimal
) -> tuple[dict[str, Any], dict[str, Any]]:
    summary = _candidate_board_predictability_decay_summary(
        spec, scorecard, target=target
    )
    updated_scorecard = dict(scorecard)
    blockers = [
        _string(blocker)
        for blocker in cast(Sequence[Any], summary.get("blockers") or ())
        if _string(blocker)
    ]
    if blockers:
        updated_scorecard["oracle_passed"] = False
        oracle_payload = dict(_mapping(updated_scorecard.get("profit_target_oracle")))
        oracle_blockers = [
            _string(blocker)
            for blocker in cast(Sequence[Any], oracle_payload.get("blockers") or ())
            if _string(blocker)
        ]
        oracle_payload["blockers"] = list(dict.fromkeys([*oracle_blockers, *blockers]))
        updated_scorecard["profit_target_oracle"] = oracle_payload
    return updated_scorecard, summary


def _candidate_board_order_type_execution_quality_summary(
    spec: CandidateSpec, scorecard: Mapping[str, Any]
) -> dict[str, Any]:
    required = _candidate_spec_requires_order_type_execution_quality(spec)
    min_sample_count = _candidate_board_int_field(
        spec.hard_vetoes, "required_min_order_type_ablation_sample_count"
    )
    if min_sample_count <= 0:
        min_sample_count = 60
    max_opportunity_cost_bps = _decimal(
        spec.hard_vetoes.get("required_max_order_type_opportunity_cost_bps"),
        default="8",
    )
    max_market_order_spread_bps = _decimal(
        spec.hard_vetoes.get("required_max_market_order_spread_bps"),
        default="8",
    )
    order_type_ablation_passed = _boolish(
        scorecard.get("order_type_ablation_passed")
        or scorecard.get("market_limit_execution_policy_passed")
    )
    raw_artifact_refs = scorecard.get(
        "order_type_ablation_artifact_refs"
    ) or scorecard.get("order_type_ablation_artifact_ref")
    artifact_refs = _string_list_from_value(raw_artifact_refs)
    if not artifact_refs and _string(raw_artifact_refs):
        artifact_refs = [_string(raw_artifact_refs)]
    raw_execution_artifact_refs = (
        scorecard.get("order_type_execution_artifact_refs")
        or scorecard.get("market_limit_order_mix_artifact_refs")
        or scorecard.get("order_type_execution_artifact_ref")
        or scorecard.get("market_limit_order_mix_artifact_ref")
    )
    execution_artifact_refs = _string_list_from_value(raw_execution_artifact_refs)
    if not execution_artifact_refs and _string(raw_execution_artifact_refs):
        execution_artifact_refs = [_string(raw_execution_artifact_refs)]
    sample_count = _candidate_board_first_int_field(
        scorecard,
        (
            "order_type_ablation_sample_count",
            "market_limit_order_mix_sample_count",
            "limit_fill_probability_sample_count",
        ),
    )
    opportunity_cost_bps = _decimal(
        scorecard.get("order_type_opportunity_cost_bps")
        or scorecard.get("market_limit_order_mix_opportunity_cost_bps"),
        default="999999",
    )
    market_order_spread_bps = _decimal(
        scorecard.get("market_order_spread_bps")
        or scorecard.get("market_limit_order_mix_market_spread_bps"),
        default="999999",
    )
    blockers: list[str] = []
    if required:
        if not order_type_ablation_passed:
            blockers.append("order_type_ablation_passed_failed")
        if not artifact_refs:
            blockers.append("order_type_ablation_artifact_present_failed")
        if sample_count < min_sample_count:
            blockers.append("order_type_ablation_sample_count_failed")
        if not _boolish(
            scorecard.get("market_limit_order_mix_evidence_present")
            or scorecard.get("market_limit_order_mix_present")
        ):
            blockers.append("market_limit_order_mix_evidence_present_failed")
        if not _boolish(
            scorecard.get("limit_fill_probability_evidence_present")
            or scorecard.get("limit_fill_probability_present")
        ):
            blockers.append("limit_fill_probability_evidence_present_failed")
        if not _boolish(
            scorecard.get("price_improvement_evidence_present")
            or scorecard.get("route_price_improvement_evidence_present")
        ):
            blockers.append("price_improvement_evidence_present_failed")
        if not _boolish(
            scorecard.get("opportunity_cost_evidence_present")
            or scorecard.get("order_type_opportunity_cost_evidence_present")
        ):
            blockers.append("opportunity_cost_evidence_present_failed")
        if not _boolish(
            scorecard.get("execution_shortfall_evidence_present")
            or scorecard.get("order_type_execution_shortfall_evidence_present")
        ):
            blockers.append("execution_shortfall_evidence_present_failed")
        raw_route_tca_refs = scorecard.get("route_tca_artifact_refs") or scorecard.get(
            "route_tca_artifact_ref"
        )
        route_tca_refs = _string_list_from_value(raw_route_tca_refs)
        if not route_tca_refs and _string(raw_route_tca_refs):
            route_tca_refs = [_string(raw_route_tca_refs)]
        if not route_tca_refs:
            blockers.append("route_tca_evidence_present_failed")
        if opportunity_cost_bps > max_opportunity_cost_bps:
            blockers.append("order_type_opportunity_cost_bps_failed")
        if market_order_spread_bps > max_market_order_spread_bps:
            blockers.append("market_order_spread_bps_failed")
    return {
        "required": required,
        "passed": not blockers,
        "blockers": blockers,
        "artifact_refs": artifact_refs,
        "execution_artifact_refs": execution_artifact_refs,
        "route_tca_artifact_refs": route_tca_refs if required else [],
        "sample_count": sample_count,
        "min_sample_count": min_sample_count,
        "opportunity_cost_bps": str(opportunity_cost_bps),
        "max_opportunity_cost_bps": str(max_opportunity_cost_bps),
        "market_order_spread_bps": str(market_order_spread_bps),
        "max_market_order_spread_bps": str(max_market_order_spread_bps),
    }


def _candidate_board_scorecard_with_order_type_blockers(
    spec: CandidateSpec,
    scorecard: Mapping[str, Any],
    *,
    replay_artifact_refs: Sequence[Any] = (),
) -> tuple[dict[str, Any], dict[str, Any]]:
    summary = _candidate_board_order_type_execution_quality_summary(spec, scorecard)
    updated_scorecard = dict(scorecard)
    blockers = [
        _string(blocker)
        for blocker in cast(Sequence[Any], summary.get("blockers") or ())
        if _string(blocker)
    ]
    required_artifact_refs = tuple(
        dict.fromkeys(
            item
            for item in (
                *cast(Sequence[Any], summary.get("artifact_refs") or ()),
                *cast(Sequence[Any], summary.get("execution_artifact_refs") or ()),
                *cast(Sequence[Any], summary.get("route_tca_artifact_refs") or ()),
            )
            if _string(item)
        )
    )
    available_artifact_refs = {
        _string(item) for item in replay_artifact_refs if _string(item)
    }
    missing_artifact_refs = [
        _string(item)
        for item in required_artifact_refs
        if _string(item) not in available_artifact_refs
    ]
    if bool(summary.get("required")) and missing_artifact_refs:
        blockers.append("order_type_proof_artifact_ref_missing_from_bundle")
        summary = {
            **summary,
            "passed": False,
            "blockers": list(dict.fromkeys(blockers)),
            "missing_replay_artifact_refs": missing_artifact_refs,
            "replay_artifact_refs_checked": sorted(available_artifact_refs),
        }
    if blockers:
        updated_scorecard["oracle_passed"] = False
        oracle_payload = dict(_mapping(updated_scorecard.get("profit_target_oracle")))
        oracle_blockers = [
            _string(blocker)
            for blocker in cast(Sequence[Any], oracle_payload.get("blockers") or ())
            if _string(blocker)
        ]
        oracle_payload["blockers"] = list(dict.fromkeys([*oracle_blockers, *blockers]))
        updated_scorecard["profit_target_oracle"] = oracle_payload
    return updated_scorecard, summary


def _candidate_spec_requires_queue_position_survival(spec: CandidateSpec) -> bool:
    overlay_ids = set(
        _string_list_from_value(spec.parameter_space.get("mechanism_overlay_ids"))
    )
    return (
        "queue_position_survival_fill_curve" in overlay_ids
        or _boolish(
            spec.promotion_contract.get("requires_queue_position_survival_fill_curve")
        )
        or _boolish(spec.promotion_contract.get("requires_nonfill_opportunity_cost"))
        or _boolish(spec.promotion_contract.get("requires_time_to_fill_quantiles"))
        or "required_queue_position_survival_fill_curve" in spec.hard_vetoes
        or "required_min_queue_position_survival_sample_count" in spec.hard_vetoes
        or "required_max_queue_position_nonfill_opportunity_cost_bps"
        in spec.hard_vetoes
    )


def _candidate_board_queue_position_survival_summary(
    spec: CandidateSpec, scorecard: Mapping[str, Any]
) -> dict[str, Any]:
    required = _candidate_spec_requires_queue_position_survival(spec)
    min_sample_count = _candidate_board_int_field(
        spec.hard_vetoes, "required_min_queue_position_survival_sample_count"
    )
    if min_sample_count <= 0:
        min_sample_count = 60
    max_nonfill_opportunity_cost_bps = _decimal(
        spec.hard_vetoes.get(
            "required_max_queue_position_nonfill_opportunity_cost_bps"
        ),
        default="8",
    )
    evidence_present = _boolish(
        scorecard.get("queue_position_survival_fill_curve_evidence_present")
        or scorecard.get("queue_position_survival_evidence_present")
    )
    sample_count = _candidate_board_first_int_field(
        scorecard,
        (
            "queue_position_survival_sample_count",
            "queue_position_survival_fill_sample_count",
        ),
    )
    fill_rate = _decimal(scorecard.get("queue_position_survival_fill_rate"))
    queue_ratio_p95 = _decimal(scorecard.get("queue_position_survival_queue_ratio_p95"))
    queue_ahead_evidence_present = _boolish(
        scorecard.get("queue_position_survival_queue_ahead_depletion_evidence_present")
        or scorecard.get("delay_adjusted_depth_queue_ahead_depletion_evidence_present")
        or scorecard.get("queue_ahead_depletion_evidence_present")
    )
    queue_ahead_sample_count = _candidate_board_first_int_field(
        scorecard,
        (
            "queue_position_survival_queue_ahead_depletion_sample_count",
            "delay_adjusted_depth_queue_ahead_depletion_sample_count",
            "queue_ahead_depletion_sample_count",
        ),
    )
    nonfill_opportunity_cost_raw = scorecard.get(
        "queue_position_survival_nonfill_opportunity_cost_bps"
    ) or scorecard.get("queue_position_nonfill_opportunity_cost_bps")
    nonfill_opportunity_cost_present = nonfill_opportunity_cost_raw not in (None, "")
    nonfill_opportunity_cost_bps = _decimal(
        nonfill_opportunity_cost_raw,
        default="999999",
    )
    require_time_to_fill_quantiles = _boolish(
        spec.hard_vetoes.get("required_time_to_fill_quantiles")
    ) or _boolish(spec.promotion_contract.get("requires_time_to_fill_quantiles"))
    time_to_fill_quantiles_present = scorecard.get("fill_time_ms_p50") not in (
        None,
        "",
    ) and scorecard.get("fill_time_ms_p95") not in (None, "")
    blockers: list[str] = []
    if required:
        if not evidence_present:
            blockers.append(
                "queue_position_survival_fill_curve_evidence_present_failed"
            )
        if sample_count < min_sample_count:
            blockers.append("queue_position_survival_sample_count_failed")
        if fill_rate <= 0:
            blockers.append("queue_position_survival_fill_rate_failed")
        if not queue_ahead_evidence_present:
            blockers.append("queue_ahead_depletion_evidence_present_failed")
        if queue_ahead_sample_count <= 0:
            blockers.append("queue_ahead_depletion_sample_count_failed")
        if not nonfill_opportunity_cost_present:
            blockers.append(
                "queue_position_survival_nonfill_opportunity_cost_present_failed"
            )
        elif nonfill_opportunity_cost_bps > max_nonfill_opportunity_cost_bps:
            blockers.append(
                "queue_position_survival_nonfill_opportunity_cost_bps_failed"
            )
        if require_time_to_fill_quantiles and not time_to_fill_quantiles_present:
            blockers.append("time_to_fill_quantiles_present_failed")
    return {
        "required": required,
        "passed": not blockers,
        "blockers": blockers,
        "evidence_present": evidence_present,
        "sample_count": sample_count,
        "min_sample_count": min_sample_count,
        "fill_rate": str(fill_rate),
        "queue_ratio_p95": str(queue_ratio_p95),
        "queue_ahead_depletion_evidence_present": queue_ahead_evidence_present,
        "queue_ahead_depletion_sample_count": queue_ahead_sample_count,
        "nonfill_opportunity_cost_present": nonfill_opportunity_cost_present,
        "nonfill_opportunity_cost_bps": str(nonfill_opportunity_cost_bps),
        "max_nonfill_opportunity_cost_bps": str(max_nonfill_opportunity_cost_bps),
        "time_to_fill_quantiles_required": require_time_to_fill_quantiles,
        "time_to_fill_quantiles_present": time_to_fill_quantiles_present,
        "source_marker": "queue_position_survival_fill_probability_arxiv_2512_05734_2025",
    }


def _candidate_board_scorecard_with_queue_position_survival_blockers(
    spec: CandidateSpec, scorecard: Mapping[str, Any]
) -> tuple[dict[str, Any], dict[str, Any]]:
    summary = _candidate_board_queue_position_survival_summary(spec, scorecard)
    updated_scorecard = dict(scorecard)
    blockers = [
        _string(blocker)
        for blocker in cast(Sequence[Any], summary.get("blockers") or ())
        if _string(blocker)
    ]
    if blockers:
        updated_scorecard["oracle_passed"] = False
        oracle_payload = dict(_mapping(updated_scorecard.get("profit_target_oracle")))
        oracle_blockers = [
            _string(blocker)
            for blocker in cast(Sequence[Any], oracle_payload.get("blockers") or ())
            if _string(blocker)
        ]
        oracle_payload["blockers"] = list(dict.fromkeys([*oracle_blockers, *blockers]))
        updated_scorecard["profit_target_oracle"] = oracle_payload
    return updated_scorecard, summary


def _candidate_board_scorecard_with_rejected_signal_blockers(
    spec: CandidateSpec, scorecard: Mapping[str, Any]
) -> tuple[dict[str, Any], dict[str, Any]]:
    summary = _candidate_board_rejected_signal_outcome_summary(spec, scorecard)
    updated_scorecard = dict(scorecard)
    blockers = [
        _string(blocker)
        for blocker in cast(Sequence[Any], summary.get("blockers") or ())
        if _string(blocker)
    ]
    if blockers:
        updated_scorecard["oracle_passed"] = False
        oracle_payload = dict(_mapping(updated_scorecard.get("profit_target_oracle")))
        oracle_blockers = [
            _string(blocker)
            for blocker in cast(Sequence[Any], oracle_payload.get("blockers") or ())
            if _string(blocker)
        ]
        oracle_payload["blockers"] = list(dict.fromkeys([*oracle_blockers, *blockers]))
        updated_scorecard["profit_target_oracle"] = oracle_payload
    return updated_scorecard, summary


def _candidate_board_evidence_lineage_summary(
    evidence: CandidateEvidenceBundle | None,
) -> dict[str, Any]:
    if evidence is None:
        return {
            "present": False,
            "passed": False,
            "blockers": ["evidence_bundle_missing"],
            "dataset_snapshot_id": "",
            "feature_spec_hash": "",
            "code_commit": "",
            "replay_artifact_ref_count": 0,
        }

    blockers: list[str] = []
    dataset_snapshot_id = _string(evidence.dataset_snapshot_id)
    feature_spec_hash = _string(evidence.feature_spec_hash)
    code_commit = _string(evidence.code_commit)
    replay_artifact_refs = [
        _string(item) for item in evidence.replay_artifact_refs if _string(item)
    ]

    if not dataset_snapshot_id:
        blockers.append("dataset_snapshot_missing")
    if not feature_spec_hash:
        blockers.append("feature_spec_hash_missing")
    if not code_commit or code_commit.lower() == "unknown":
        blockers.append("code_commit_missing_or_unknown")
    elif code_commit.endswith("-dirty"):
        blockers.append("code_commit_dirty")
    if not replay_artifact_refs:
        blockers.append("replay_artifact_missing")

    return {
        "present": True,
        "passed": not blockers,
        "blockers": blockers,
        "dataset_snapshot_id": dataset_snapshot_id,
        "feature_spec_hash": feature_spec_hash,
        "code_commit": code_commit,
        "replay_artifact_ref_count": len(replay_artifact_refs),
        "sample_replay_artifact_refs": replay_artifact_refs[:5],
    }


def _candidate_board_scorecard_with_lineage_blockers(
    scorecard: Mapping[str, Any], evidence: CandidateEvidenceBundle | None
) -> tuple[dict[str, Any], dict[str, Any]]:
    summary = _candidate_board_evidence_lineage_summary(evidence)
    updated_scorecard = dict(scorecard)
    blockers = [
        _string(blocker)
        for blocker in cast(Sequence[Any], summary.get("blockers") or ())
        if _string(blocker)
    ]
    if blockers:
        updated_scorecard["oracle_passed"] = False
        oracle_payload = dict(_mapping(updated_scorecard.get("profit_target_oracle")))
        oracle_blockers = [
            _string(blocker)
            for blocker in cast(Sequence[Any], oracle_payload.get("blockers") or ())
            if _string(blocker)
        ]
        oracle_payload["blockers"] = list(dict.fromkeys([*oracle_blockers, *blockers]))
        updated_scorecard["profit_target_oracle"] = oracle_payload
    return updated_scorecard, summary


def _candidate_board_replay_window_coverage_summary(
    scorecard: Mapping[str, Any],
) -> dict[str, Any]:
    required = _boolish(scorecard.get("target_met")) or _boolish(
        scorecard.get("oracle_passed")
    )
    replay_lineage = _mapping(scorecard.get("replay_lineage"))
    coverage = _mapping(scorecard.get("replay_window_coverage"))
    expected_windows = _string_list_from_value(
        coverage.get("expected_windows") or replay_lineage.get("expected_windows")
    )
    present_windows = _string_list_from_value(
        coverage.get("present_windows") or replay_lineage.get("present_windows")
    )
    missing_windows = _string_list_from_value(
        coverage.get("missing_windows") or replay_lineage.get("missing_windows")
    )
    if (
        _candidate_board_int_field(scorecard, "double_oos_independent_window_count")
        >= 2
        and _SECOND_OOS_WINDOW_ID not in expected_windows
    ):
        expected_windows.append(_SECOND_OOS_WINDOW_ID)
    for required_window in ("train", "holdout", "full_window"):
        if required_window not in expected_windows:
            expected_windows.append(required_window)

    blockers: list[str] = []
    lineage_hash = _string(replay_lineage.get("lineage_hash"))
    coverage_hash = _string(coverage.get("lineage_hash"))
    if required:
        if not replay_lineage:
            blockers.append("replay_lineage_missing")
        if not coverage:
            blockers.append("replay_window_coverage_missing")
        if not lineage_hash:
            blockers.append("replay_lineage_hash_missing")
        if not coverage_hash:
            blockers.append("replay_window_coverage_hash_missing")
        if lineage_hash and coverage_hash and lineage_hash != coverage_hash:
            blockers.append("replay_lineage_hash_mismatch")
        missing_required_windows = [
            window_id
            for window_id in expected_windows
            if window_id not in present_windows or window_id in missing_windows
        ]
        if missing_required_windows:
            blockers.append("replay_window_missing")
    else:
        missing_required_windows = []

    return {
        "required": required,
        "passed": not blockers,
        "blockers": blockers,
        "lineage_hash": lineage_hash,
        "coverage_hash": coverage_hash,
        "expected_windows": expected_windows,
        "present_windows": present_windows,
        "missing_windows": missing_windows,
        "missing_required_windows": missing_required_windows,
    }


def _candidate_board_market_impact_proof_summary(
    scorecard: Mapping[str, Any],
) -> dict[str, Any]:
    components = _mapping(scorecard.get("market_impact_stress_components"))
    source_marker = _string(components.get("source_marker"))
    model = _string(
        scorecard.get("nonlinear_market_impact_stress_model")
        or scorecard.get("market_impact_stress_model")
    )
    artifact_ref = _string(
        scorecard.get("market_impact_stress_artifact_ref")
        or scorecard.get("impact_stress_artifact_ref")
        or scorecard.get("cost_shock_artifact_ref")
    )
    cost_bps = _candidate_board_decimal_field(
        scorecard, "nonlinear_market_impact_stress_cost_bps"
    ) or _candidate_board_decimal_field(scorecard, "market_impact_stress_cost_bps")
    net_pnl_per_day = _candidate_board_decimal_field(
        scorecard, "nonlinear_market_impact_stress_net_pnl_per_day"
    ) or _candidate_board_decimal_field(
        scorecard, "market_impact_stress_net_pnl_per_day"
    )
    nonlinear_passed = _boolish(
        scorecard.get("nonlinear_market_impact_stress_passed")
        or scorecard.get("market_impact_stress_passed")
    )
    blockers: list[str] = []
    if not artifact_ref:
        blockers.append("market_impact_stress_artifact_missing")
    if not model:
        blockers.append("market_impact_stress_model_missing")
    if not cost_bps or _decimal(cost_bps) <= 0:
        blockers.append("market_impact_stress_cost_bps_missing")
    if not net_pnl_per_day:
        blockers.append("market_impact_stress_net_pnl_missing")
    if not source_marker:
        blockers.append("nonlinear_market_impact_components_missing")
    if model and artifact_ref and cost_bps and not nonlinear_passed:
        blockers.append("nonlinear_market_impact_stress_failed")
    if not scorecard:
        state = "not_replayed"
    elif blockers:
        state = "blocked"
    else:
        state = "passed"
    return {
        "state": state,
        "passed": state == "passed",
        "model": model,
        "cost_bps": cost_bps,
        "net_pnl_per_day": net_pnl_per_day,
        "artifact_ref": artifact_ref,
        "component_source_marker": source_marker,
        "selected_component_model": _string(components.get("selected_model")),
        "selected_component_cost_bps": _string(components.get("selected_cost_bps")),
        "blockers": blockers,
        "source_marker": "realistic_market_impact_arxiv_2603_29086_2026",
    }


def _candidate_board_regime_specialist_summary(
    spec: CandidateSpec,
    scorecard: Mapping[str, Any],
) -> dict[str, Any]:
    required_rate = _decimal(
        spec.hard_vetoes.get("required_min_regime_slice_pass_rate")
        or spec.promotion_contract.get("required_min_regime_slice_pass_rate")
    )
    observed_rate = _decimal(scorecard.get("regime_slice_pass_rate"))
    source_claims = _list_of_mappings(spec.feature_contract.get("source_claims"))
    regime_claim_ids = [
        _string(claim.get("claim_id"))
        for claim in source_claims
        if _string(claim.get("claim_type"))
        in {"market_regime", "validation_requirement", "risk_constraint"}
    ]
    blockers: list[str] = []
    if scorecard and required_rate > 0 and "regime_slice_pass_rate" not in scorecard:
        blockers.append("regime_slice_pass_rate_missing")
    if scorecard and required_rate > 0 and observed_rate < required_rate:
        blockers.append("regime_slice_pass_rate_below_specialist_threshold")
    if not scorecard:
        state = "not_replayed"
    elif blockers:
        state = "blocked"
    else:
        state = "passed"
    return {
        "state": state,
        "passed": state == "passed",
        "regime_slice_pass_rate": str(observed_rate) if scorecard else "",
        "required_min_regime_slice_pass_rate": str(required_rate)
        if required_rate > 0
        else "",
        "regime_claim_ids": [claim_id for claim_id in regime_claim_ids if claim_id],
        "blockers": blockers,
        "source_markers": [
            "risk_sensitive_specialist_routing_arxiv_2604_10402_2026",
            "validated_vvg_classifier_arxiv_2605_11423_2026",
        ],
    }


def _candidate_board_scorecard_with_replay_window_blockers(
    scorecard: Mapping[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    summary = _candidate_board_replay_window_coverage_summary(scorecard)
    updated_scorecard = dict(scorecard)
    blockers = [
        _string(blocker)
        for blocker in cast(Sequence[Any], summary.get("blockers") or ())
        if _string(blocker)
    ]
    if blockers:
        updated_scorecard["oracle_passed"] = False
        oracle_payload = dict(_mapping(updated_scorecard.get("profit_target_oracle")))
        oracle_blockers = [
            _string(blocker)
            for blocker in cast(Sequence[Any], oracle_payload.get("blockers") or ())
            if _string(blocker)
        ]
        oracle_payload["blockers"] = list(dict.fromkeys([*oracle_blockers, *blockers]))
        updated_scorecard["profit_target_oracle"] = oracle_payload
    return updated_scorecard, summary


def _candidate_board_scorecard_with_evidence_blockers(
    scorecard: Mapping[str, Any], evidence: CandidateEvidenceBundle | None
) -> dict[str, Any]:
    if evidence is None:
        return dict(scorecard)
    blockers = [
        _string(blocker)
        for blocker in (
            *evidence_bundle_blockers(evidence),
            *cast(
                Sequence[Any],
                evidence.promotion_readiness.get("blockers") or (),
            ),
        )
        if _string(blocker)
    ]
    if not blockers:
        return dict(scorecard)
    updated_scorecard = dict(scorecard)
    updated_scorecard["oracle_passed"] = False
    oracle_payload = dict(_mapping(updated_scorecard.get("profit_target_oracle")))
    oracle_blockers = [
        _string(blocker)
        for blocker in cast(Sequence[Any], oracle_payload.get("blockers") or ())
        if _string(blocker)
    ]
    oracle_payload["blockers"] = list(dict.fromkeys([*oracle_blockers, *blockers]))
    updated_scorecard["profit_target_oracle"] = oracle_payload
    return updated_scorecard


def _candidate_board_blockers(
    *,
    selected_for_replay: bool,
    evidence: CandidateEvidenceBundle | None,
    scorecard: Mapping[str, Any],
) -> list[str]:
    blockers = list(_oracle_blockers(scorecard))
    if not selected_for_replay:
        blockers.append("not_selected_for_replay")
    elif evidence is None:
        blockers.append("replay_evidence_missing")
    if evidence is not None and not _boolish(scorecard.get("target_met")):
        blockers.append("target_net_pnl_per_day_not_met")
    if (
        evidence is not None
        and _boolish(scorecard.get("target_met"))
        and not _boolish(scorecard.get("oracle_passed"))
        and not blockers
    ):
        blockers.append("profit_target_oracle_failed")
    return list(dict.fromkeys(blockers))


def _candidate_board_status(
    *,
    selected_for_replay: bool,
    evidence: CandidateEvidenceBundle | None,
    scorecard: Mapping[str, Any],
    in_best_portfolio: bool,
    portfolio_oracle_passed: bool,
) -> str:
    if in_best_portfolio and portfolio_oracle_passed:
        return "portfolio_component_passed_oracle"
    if evidence is not None and _boolish(scorecard.get("oracle_passed")):
        return "candidate_oracle_passed"
    if evidence is not None and _boolish(scorecard.get("target_met")):
        return "blocked_by_oracle"
    if evidence is not None:
        return "replayed_below_target"
    if selected_for_replay:
        return "selected_pending_replay_evidence"
    return "research_ranked_not_replayed"


def _candidate_board_activity_count(row: Mapping[str, Any]) -> int:
    return max(
        _candidate_board_int_field(row, "decision_count"),
        _candidate_board_int_field(row, "submitted_order_count"),
        _candidate_board_int_field(row, "filled_order_count"),
        _candidate_board_int_field(row, "executable_replay_order_count"),
    )


def _candidate_board_oracle_blocker_count(row: Mapping[str, Any]) -> int:
    blockers = row.get("blockers")
    if not isinstance(blockers, Sequence) or isinstance(blockers, str):
        return 0
    return sum(
        1
        for blocker in cast(Sequence[Any], blockers)
        if _string(blocker).endswith("_failed")
    )


def _candidate_board_net_pnl(row: Mapping[str, Any]) -> Decimal:
    return _decimal(row.get("net_pnl_per_day"))


def _candidate_board_lower_bound_net_pnl(row: Mapping[str, Any]) -> Decimal:
    lower_bound = deployable_lower_bound_net_pnl_per_day(row)
    if lower_bound is None:
        return Decimal("0")
    if (
        deployable_lower_bound_missing_count(row) > 0
        or deployable_proof_failed_gate_count(row) > 0
    ):
        return Decimal("0")
    return lower_bound


def _candidate_board_best_executed_candidate(
    rows: Sequence[Mapping[str, Any]],
) -> dict[str, Any] | None:
    executed_rows = [
        dict(row) for row in rows if _candidate_board_activity_count(row) > 0
    ]
    if not executed_rows:
        return None
    executed_rows.sort(
        key=lambda row: (
            bool(row.get("oracle_passed")),
            bool(row.get("target_met")),
            _candidate_board_activity_count(row),
            _candidate_board_net_pnl(row),
            -_rank_sort_value(row.get("rank")),
            _string(row.get("candidate_spec_id")),
        ),
        reverse=True,
    )
    return executed_rows[0]


def _candidate_board_closest_promotion_candidate(
    rows: Sequence[Mapping[str, Any]],
) -> dict[str, Any] | None:
    replayed_rows = [dict(row) for row in rows if bool(row.get("has_replay_evidence"))]
    if not replayed_rows:
        return None
    replayed_rows.sort(
        key=lambda row: (
            bool(row.get("oracle_passed")),
            bool(row.get("target_met")),
            -_candidate_board_oracle_blocker_count(row),
            _candidate_board_activity_count(row),
            _candidate_board_net_pnl(row),
            -_rank_sort_value(row.get("rank")),
            _string(row.get("candidate_spec_id")),
        ),
        reverse=True,
    )
    return replayed_rows[0]


def _candidate_board_paper_probation_admission_blockers(
    row: Mapping[str, Any],
) -> list[str]:
    blockers: list[str] = []
    runtime_ledger_refs = _candidate_board_runtime_ledger_refs(row)
    if not runtime_ledger_refs:
        blockers.append("paper_probation_runtime_ledger_artifact_missing")
    if _candidate_board_int_field(row, "runtime_ledger_artifact_row_count") <= 0:
        blockers.append("paper_probation_runtime_ledger_row_count_missing")
    if _candidate_board_int_field(row, "runtime_ledger_artifact_fill_count") <= 0:
        blockers.append("paper_probation_runtime_ledger_fill_count_missing")
    window_start, window_end = _candidate_board_runtime_window_bounds(row)
    if not window_start or not window_end:
        blockers.append("paper_probation_runtime_window_bounds_missing")
    return blockers


def _paper_probation_candidate_payload(
    *,
    candidate: Mapping[str, Any],
    target: Decimal,
    rank: int,
) -> dict[str, Any]:
    payload = dict(candidate)
    lower_bound = _candidate_board_lower_bound_net_pnl(payload)
    deployable_missing_count = deployable_lower_bound_missing_count(payload)
    deployable_failed_gate_count = deployable_proof_failed_gate_count(payload)
    final_promotion_blockers = [
        _string(blocker)
        for blocker in cast(Sequence[Any], payload.get("blockers") or ())
        if _string(blocker)
    ]
    if not final_promotion_blockers:
        final_promotion_blockers.append("final_promotion_requires_runtime_governance")
    payload.update(
        {
            "candidate_selection": "oracle_recommended_paper_probation",
            "paper_probation_tier": "paper_probation",
            "paper_probation_rank": rank,
            "paper_probation_authorized": True,
            "probation_allowed": True,
            "paper_probation_authorization_scope": "evidence_collection_only",
            "evidence_collection_stage": "paper",
            "probation_reason": "runtime_evidence_collection_only",
            "selection_reason": "target_met_but_oracle_blocked"
            if bool(payload.get("target_met"))
            else "closest_lower_bound_economics_below_target",
            "selected_by": "candidate_board_paper_probation_candidate",
            "probation_lower_bound_net_pnl_per_day": str(lower_bound),
            "probation_target_shortfall": str(max(target - lower_bound, Decimal("0"))),
            "deployable_lower_bound_missing_count": deployable_missing_count,
            "deployable_lower_bound_failed_gate_count": deployable_failed_gate_count,
            "promotion_allowed": False,
            "promotion_gate": "existing_runtime_governance_fail_closed",
            "final_promotion_authorized": False,
            "final_promotion_allowed": False,
            "promotion_blockers": list(dict.fromkeys(final_promotion_blockers)),
            "final_promotion_blockers": list(dict.fromkeys(final_promotion_blockers)),
        }
    )
    return payload


def _candidate_board_paper_probation_candidates(
    rows: Sequence[Mapping[str, Any]],
    *,
    target: Decimal,
    limit: int = 1,
) -> tuple[dict[str, Any], ...]:
    candidates = [
        dict(row)
        for row in rows
        if bool(row.get("has_replay_evidence"))
        and not bool(row.get("oracle_passed"))
        and _candidate_board_activity_count(row) > 0
        and _string(row.get("candidate_id"))
        and _string(row.get("hypothesis_id"))
        and _string(row.get("runtime_family"))
        and _string(row.get("runtime_strategy_name"))
    ]
    if not candidates:
        return ()

    admitted_candidates = [
        candidate
        for candidate in candidates
        if not _candidate_board_paper_probation_admission_blockers(candidate)
        and _candidate_board_lower_bound_net_pnl(candidate) > 0
    ]
    if not admitted_candidates:
        return ()

    def rank(row: Mapping[str, Any]) -> tuple[Any, ...]:
        lower_bound = _candidate_board_lower_bound_net_pnl(row)
        target_shortfall = max(target - lower_bound, Decimal("0"))
        return (
            lower_bound > 0,
            _candidate_board_int_field(row, "filled_order_count") > 0,
            _candidate_board_int_field(row, "submitted_order_count") > 0,
            -target_shortfall,
            lower_bound,
            _decimal(row.get("active_day_ratio")),
            _decimal(row.get("positive_day_ratio")),
            -_decimal(row.get("best_day_share"), default="1"),
            -_decimal(row.get("worst_day_loss")),
            -_candidate_board_oracle_blocker_count(row),
            _candidate_board_activity_count(row),
            -_rank_sort_value(row.get("rank")),
            _string(row.get("candidate_spec_id")),
        )

    admitted_candidates.sort(key=rank, reverse=True)
    selected = admitted_candidates[: max(1, int(limit))]
    return tuple(
        _paper_probation_candidate_payload(
            candidate=candidate,
            target=target,
            rank=index,
        )
        for index, candidate in enumerate(selected, start=1)
    )


def _candidate_board_paper_probation_candidate(
    rows: Sequence[Mapping[str, Any]],
    *,
    target: Decimal,
) -> dict[str, Any] | None:
    candidates = _candidate_board_paper_probation_candidates(
        rows,
        target=target,
        limit=1,
    )
    return candidates[0] if candidates else None


def _candidate_board_status_digest(rows: Sequence[Mapping[str, Any]]) -> str:
    digest_rows = [
        {
            "candidate_spec_id": _string(row.get("candidate_spec_id")),
            "candidate_id": _string(row.get("candidate_id")),
            "rank": _rank_sort_value(row.get("rank")),
            "status": _string(row.get("status")),
            "target_met": bool(row.get("target_met")),
            "oracle_passed": bool(row.get("oracle_passed")),
            "activity_count": _candidate_board_activity_count(row),
            "market_impact_proof_state": _string(
                _mapping(row.get("market_impact_proof")).get("state")
            ),
            "regime_specialist_state": _string(
                _mapping(row.get("regime_specialist_validation")).get("state")
            ),
            "blockers": [
                _string(blocker)
                for blocker in cast(Sequence[Any], row.get("blockers") or ())
            ],
        }
        for row in rows
    ]
    encoded = json.dumps(digest_rows, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _candidate_board_double_oos_summary(
    rows: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    replayed_rows = [row for row in rows if bool(row.get("has_replay_evidence"))]
    artifact_rows = [
        row
        for row in replayed_rows
        if bool(_string(row.get("double_oos_artifact_ref")))
    ]
    passed_rows = [row for row in replayed_rows if bool(row.get("double_oos_passed"))]
    missing_artifact_rows = [
        row
        for row in replayed_rows
        if not bool(_string(row.get("double_oos_artifact_ref")))
    ]
    independent_window_counts = [
        _candidate_board_int_field(row, "double_oos_independent_window_count")
        for row in replayed_rows
    ]
    blockers: list[str] = []
    if replayed_rows and missing_artifact_rows:
        blockers.append("double_oos_artifact_missing_for_replayed_candidates")
    if replayed_rows and not passed_rows:
        blockers.append("no_candidate_passed_double_oos")
    return {
        "replayed_candidate_count": len(replayed_rows),
        "artifact_candidate_count": len(artifact_rows),
        "passed_candidate_count": len(passed_rows),
        "missing_artifact_candidate_count": len(missing_artifact_rows),
        "max_independent_window_count": max(independent_window_counts, default=0),
        "blockers": blockers,
    }


def _candidate_board_portfolio_promotion_subject(
    *,
    portfolio: PortfolioCandidateSpec | None,
    portfolio_payload: Mapping[str, Any],
    portfolio_scorecard: Mapping[str, Any],
    promotion_readiness: Mapping[str, Any],
    runtime_closure: Mapping[str, Any],
    rows: Sequence[Mapping[str, Any]],
) -> dict[str, Any] | None:
    if portfolio is None:
        return None
    source_candidate_ids = [
        _string(candidate_id)
        for candidate_id in cast(Sequence[Any], portfolio.source_candidate_ids)
        if _string(candidate_id)
    ]
    sleeve_candidate_spec_ids = [
        _string(sleeve.get("candidate_spec_id"))
        for sleeve in _list_of_mappings(portfolio_payload.get("sleeves"))
        if _string(sleeve.get("candidate_spec_id"))
    ]
    readiness_blockers = [
        _string(blocker)
        for blocker in cast(Sequence[Any], promotion_readiness.get("blockers") or ())
        if _string(blocker)
    ]
    blockers = list(
        dict.fromkeys([*_oracle_blockers(portfolio_scorecard), *readiness_blockers])
    )
    return {
        "type": "portfolio",
        "portfolio_candidate_id": _string(
            portfolio_payload.get("portfolio_candidate_id")
        ),
        "source_candidate_ids": source_candidate_ids,
        "sleeve_candidate_spec_ids": sleeve_candidate_spec_ids,
        "oracle_passed": _boolish(portfolio_scorecard.get("oracle_passed")),
        "target_met": _boolish(portfolio_scorecard.get("target_met")),
        "net_pnl_per_day": _candidate_board_decimal_field(
            portfolio_scorecard, "net_pnl_per_day"
        )
        or _candidate_board_decimal_field(
            portfolio_scorecard, "portfolio_post_cost_net_pnl_per_day"
        ),
        "market_impact_proof": _candidate_board_market_impact_proof_summary(
            portfolio_scorecard
        ),
        "runtime_closure_status": _string(runtime_closure.get("status")),
        "promotion_readiness_status": _string(promotion_readiness.get("status")),
        "promotable": _boolish(promotion_readiness.get("promotable")),
        "component_rows": [
            {
                "candidate_spec_id": _string(row.get("candidate_spec_id")),
                "candidate_id": _string(row.get("candidate_id")),
                "status": _string(row.get("status")),
                "oracle_passed": _boolish(row.get("oracle_passed")),
                "target_met": _boolish(row.get("target_met")),
                "market_impact_proof_state": _string(
                    _mapping(row.get("market_impact_proof")).get("state")
                ),
                "regime_specialist_state": _string(
                    _mapping(row.get("regime_specialist_validation")).get("state")
                ),
            }
            for row in rows
            if _string(row.get("candidate_spec_id")) in set(sleeve_candidate_spec_ids)
        ],
        "blockers": blockers,
    }


def _candidate_board_hypothesis_manifest_ref(hypothesis_id: str | None) -> str:
    normalized = _string(hypothesis_id).lower().replace("_", "-")
    if not normalized:
        return ""
    return f"config/trading/hypotheses/{normalized}.json"


def _candidate_board_runtime_window_bounds(
    scorecard: Mapping[str, Any],
) -> tuple[str, str]:
    for source in (
        scorecard,
        _mapping(scorecard.get("replay_window_spec")),
        _mapping(scorecard.get("candidate_evaluation_key_payload")).get(
            "replay_window_spec"
        ),
    ):
        mapping = _mapping(source)
        start = _string(
            mapping.get("runtime_window_start")
            or mapping.get("window_start")
            or mapping.get("full_window_start")
            or mapping.get("full_window_start_date")
        )
        end = _string(
            mapping.get("runtime_window_end")
            or mapping.get("window_end")
            or mapping.get("full_window_end")
            or mapping.get("full_window_end_date")
        )
        if start and end:
            return start, end

    replay_lineage = _mapping(scorecard.get("replay_lineage"))
    windows = _mapping(replay_lineage.get("windows"))
    for window_id in ("full_window", "holdout", "train"):
        window = _mapping(windows.get(window_id))
        start = _string(window.get("start_date") or window.get("window_start"))
        end = _string(window.get("end_date") or window.get("window_end"))
        if start and end:
            return start, end
    return "", ""


def _candidate_board_date_only(value: str) -> date | None:
    text = _string(value)
    if not text or "T" in text or " " in text:
        return None
    try:
        return date.fromisoformat(text)
    except ValueError:
        return None


def _candidate_board_regular_session_bound(value: str, *, end: bool) -> str:
    text = _string(value)
    trading_day = _candidate_board_date_only(text)
    if trading_day is None:
        return text
    session_time = (
        _CANDIDATE_BOARD_RUNTIME_SESSION_CLOSE
        if end
        else _CANDIDATE_BOARD_RUNTIME_SESSION_OPEN
    )
    return (
        datetime.combine(
            trading_day,
            session_time,
            tzinfo=_CANDIDATE_BOARD_RUNTIME_SESSION_TZ,
        )
        .astimezone(UTC)
        .isoformat()
    )


def _candidate_board_runtime_window_import_bounds(
    row: Mapping[str, Any],
) -> tuple[str, str]:
    window_start = _string(row.get("runtime_window_start") or row.get("window_start"))
    window_end = _string(row.get("runtime_window_end") or row.get("window_end"))
    if not window_start or not window_end:
        window_start, window_end = _candidate_board_runtime_window_bounds(row)
    return (
        _candidate_board_regular_session_bound(window_start, end=False),
        _candidate_board_regular_session_bound(window_end, end=True),
    )


def _candidate_board_runtime_ledger_refs(row: Mapping[str, Any]) -> tuple[str, ...]:
    refs: list[str] = []
    for key in (
        "exact_replay_ledger_artifact_ref",
        "runtime_ledger_artifact_ref",
    ):
        ref = _string(row.get(key))
        if ref:
            refs.append(ref)
    for key in (
        "exact_replay_ledger_artifact_refs",
        "runtime_ledger_artifact_refs",
    ):
        raw_refs = row.get(key)
        if isinstance(raw_refs, str):
            ref = _string(raw_refs)
            if ref:
                refs.append(ref)
            continue
        for raw_ref in cast(Sequence[Any], raw_refs or ()):
            ref = _string(raw_ref)
            if ref:
                refs.append(ref)
    for raw_ref in cast(Sequence[Any], row.get("replay_artifact_refs") or ()):
        ref = _string(raw_ref)
        ref_lower = ref.lower()
        if ref and (
            "exact-replay-ledger" in ref_lower
            or "runtime-ledger" in ref_lower
            or "exact_replay_ledger" in ref_lower
            or "runtime_ledger" in ref_lower
        ):
            refs.append(ref)
    return tuple(dict.fromkeys(refs))


def _candidate_board_runtime_import_args(target: Mapping[str, Any]) -> list[str]:
    args = [
        "uv",
        "run",
        "--frozen",
        "python",
        "scripts/import_hypothesis_runtime_windows.py",
        "--run-id",
        _string(target.get("run_id")) or "candidate-board-runtime-window-import",
        "--candidate-id",
        _string(target.get("candidate_id")),
        "--hypothesis-id",
        _string(target.get("hypothesis_id")),
        "--observed-stage",
        _string(target.get("observed_stage")) or "paper",
        "--strategy-family",
        _string(target.get("strategy_family")),
        "--strategy-name",
        _string(target.get("strategy_name")),
        "--account-label",
        _string(target.get("account_label")),
        "--window-start",
        _string(target.get("window_start")),
        "--window-end",
        _string(target.get("window_end")),
        "--source-kind",
        _string(target.get("source_kind")),
        "--source-manifest-ref",
        _string(target.get("source_manifest_ref")),
        "--dataset-snapshot-ref",
        _string(target.get("dataset_snapshot_ref")),
    ]
    for artifact_ref in cast(
        Sequence[Any], target.get("runtime_ledger_artifact_refs") or ()
    ):
        ref = _string(artifact_ref)
        if ref:
            args.extend(["--artifact-ref", ref])
    target_metadata = _mapping(target.get("target_metadata"))
    if target_metadata:
        args.extend(
            [
                "--target-metadata-json",
                json.dumps(
                    target_metadata,
                    sort_keys=True,
                    separators=(",", ":"),
                    default=str,
                ),
            ]
        )
    args.append("--json")
    return args


def _candidate_board_runtime_window_import_plan(
    *,
    rows: Sequence[Mapping[str, Any]],
    paper_probation_candidate: Mapping[str, Any] | None,
    paper_probation_candidates: Sequence[Mapping[str, Any]] = (),
    promotion_subject: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    source_rows: list[Mapping[str, Any]] = []
    if paper_probation_candidate is not None:
        source_rows.append(paper_probation_candidate)
    source_rows.extend(paper_probation_candidates)

    if promotion_subject is not None and _boolish(promotion_subject.get("target_met")):
        portfolio_spec_ids = {
            _string(candidate_spec_id)
            for candidate_spec_id in cast(
                Sequence[Any],
                promotion_subject.get("sleeve_candidate_spec_ids") or (),
            )
            if _string(candidate_spec_id)
        }
        for row in rows:
            if _string(row.get("candidate_spec_id")) in portfolio_spec_ids:
                source_rows.append(row)

    targets: list[dict[str, Any]] = []
    blockers: list[dict[str, Any]] = []
    seen_keys: set[tuple[str, str, str]] = set()
    for row in source_rows:
        candidate_id = _string(row.get("candidate_id"))
        hypothesis_id = _string(row.get("hypothesis_id"))
        strategy_family = _string(row.get("runtime_family"))
        strategy_name = _string(row.get("runtime_strategy_name"))
        candidate_spec_id = _string(row.get("candidate_spec_id"))
        runtime_ledger_artifact_refs = _candidate_board_runtime_ledger_refs(row)
        exact_replay_ledger_artifact_ref = _string(
            row.get("exact_replay_ledger_artifact_ref")
        )
        if not exact_replay_ledger_artifact_ref:
            exact_replay_ledger_artifact_ref = next(
                (ref for ref in runtime_ledger_artifact_refs if "exact" in ref.lower()),
                "",
            )
        runtime_ledger_artifact_ref = _string(row.get("runtime_ledger_artifact_ref"))
        if not runtime_ledger_artifact_ref and runtime_ledger_artifact_refs:
            runtime_ledger_artifact_ref = runtime_ledger_artifact_refs[0]
        window_start, window_end = _candidate_board_runtime_window_import_bounds(row)
        account_label = _string(row.get("account_label"))
        if not account_label and runtime_ledger_artifact_refs:
            account_label = "TORGHUT_REPLAY"
        missing_fields = [
            field
            for field, value in (
                ("candidate_id", candidate_id),
                ("hypothesis_id", hypothesis_id),
                ("runtime_family", strategy_family),
                ("runtime_strategy_name", strategy_name),
                ("window_start", window_start),
                ("window_end", window_end),
                ("account_label", account_label),
            )
            if not value
        ]
        if missing_fields:
            blockers.append(
                {
                    "blocker": "runtime_window_import_target_incomplete",
                    "candidate_spec_id": candidate_spec_id,
                    "candidate_id": candidate_id,
                    "missing_fields": missing_fields,
                }
            )
            continue
        dedupe_key = (hypothesis_id, candidate_id, strategy_name)
        if dedupe_key in seen_keys:
            continue
        seen_keys.add(dedupe_key)
        target = {
            "run_id": _string(row.get("epoch_id"))
            or "candidate-board-runtime-window-import",
            "candidate_spec_id": candidate_spec_id,
            "candidate_id": candidate_id,
            "hypothesis_id": hypothesis_id,
            "observed_stage": "paper",
            "strategy_family": strategy_family,
            "strategy_name": strategy_name,
            "account_label": account_label,
            "window_start": window_start,
            "window_end": window_end,
            "source_kind": "simulation_exact_replay_runtime_ledger"
            if runtime_ledger_artifact_refs
            else "paper_runtime_observed",
            "source_manifest_ref": _candidate_board_hypothesis_manifest_ref(
                hypothesis_id
            ),
            "dataset_snapshot_ref": _string(row.get("dataset_snapshot_id")),
            "artifact_refs": [
                _string(ref)
                for ref in cast(Sequence[Any], row.get("replay_artifact_refs") or ())
                if _string(ref)
            ],
            "runtime_ledger_artifact_refs": list(runtime_ledger_artifact_refs),
            "runtime_ledger_artifact_ref": runtime_ledger_artifact_ref,
            "exact_replay_ledger_artifact_ref": exact_replay_ledger_artifact_ref,
            "runtime_ledger_artifact_row_count": int(
                _decimal(row.get("runtime_ledger_artifact_row_count"))
            ),
            "runtime_ledger_artifact_fill_count": int(
                _decimal(row.get("runtime_ledger_artifact_fill_count"))
            ),
            "candidate_blockers": [
                _string(blocker)
                for blocker in cast(Sequence[Any], row.get("blockers") or ())
                if _string(blocker)
            ],
            "handoff": "runtime_window_import_only",
            "promotion_gate": "existing_runtime_governance_fail_closed",
        }
        if bool(row.get("paper_probation_authorized")):
            target.update(
                {
                    "candidate_selection": _string(row.get("candidate_selection")),
                    "paper_probation_authorized": True,
                    "paper_probation_authorization_scope": _string(
                        row.get("paper_probation_authorization_scope")
                    ),
                    "evidence_collection_stage": _string(
                        row.get("evidence_collection_stage")
                    ),
                    "probation_allowed": bool(row.get("probation_allowed")),
                    "probation_reason": _string(row.get("probation_reason")),
                    "selection_reason": _string(row.get("selection_reason")),
                    "selected_by": _string(row.get("selected_by")),
                    "probation_lower_bound_net_pnl_per_day": _string(
                        row.get("probation_lower_bound_net_pnl_per_day")
                    ),
                    "probation_target_shortfall": _string(
                        row.get("probation_target_shortfall")
                    ),
                    "promotion_allowed": False,
                    "final_promotion_authorized": False,
                    "final_promotion_allowed": False,
                    "final_promotion_blockers": [
                        _string(blocker)
                        for blocker in cast(
                            Sequence[Any], row.get("final_promotion_blockers") or ()
                        )
                        if _string(blocker)
                    ],
                }
            )
        paper_required_evidence_tokens = _string_list_from_value(
            row.get("paper_required_evidence_tokens")
        )
        paper_mechanism_overlay_ids = _string_list_from_value(
            row.get("paper_mechanism_overlay_ids")
        )
        paper_contract_prior_score = _string(row.get("paper_contract_prior_score"))
        if (
            _boolish(row.get("paper_contract_candidate"))
            or paper_contract_prior_score
            or paper_required_evidence_tokens
            or paper_mechanism_overlay_ids
        ):
            target.update(
                {
                    "replay_selection_reason": _string(
                        row.get("replay_selection_reason")
                    ),
                    "paper_contract_candidate": bool(
                        row.get("paper_contract_candidate")
                    ),
                    "paper_contract_selected_for_replay": bool(
                        row.get("paper_contract_selected_for_replay")
                    ),
                    "paper_contract_prior_score": paper_contract_prior_score,
                    "paper_mechanism_overlay_ids": paper_mechanism_overlay_ids,
                    "paper_required_evidence_tokens": paper_required_evidence_tokens,
                    "paper_required_evidence_count": _candidate_board_int_field(
                        row, "paper_required_evidence_count"
                    ),
                }
            )
        target["target_metadata"] = {
            key: value
            for key, value in target.items()
            if key
            not in {
                "import_command_args",
                "target_metadata",
            }
        }
        target["import_command_args"] = _candidate_board_runtime_import_args(target)
        targets.append(target)

    return {
        "schema_version": "torghut.runtime-window-import-plan.v1",
        "status": "ready" if targets else "blocked",
        "observed_stage": "paper",
        "target_count": len(targets),
        "targets": targets,
        "blockers": blockers,
    }


def _candidate_factor_acceptance_replay_metadata(
    *,
    spec: CandidateSpec,
    evidence: CandidateEvidenceBundle | None,
    candidate_count: int,
) -> dict[str, Any]:
    static_artifact = _mapping(spec.feature_contract.get("factor_acceptance_artifact"))
    if not static_artifact:
        return {}

    if evidence is None:
        artifact = {
            **static_artifact,
            "status": "rejected",
            "rejection_reasons": list(
                dict.fromkeys(
                    [
                        *_string_list_from_value(
                            static_artifact.get("rejection_reasons")
                        ),
                        "replay_evidence_missing",
                    ]
                )
            ),
            "promotion_scope": "research_paper_probation_only",
            "does_not_authorize_live_promotion": True,
        }
        evidence_status = "missing"
        candidate_id = ""
        evidence_bundle_id = ""
    else:
        artifact = build_factor_acceptance_artifact_from_scorecard(
            factor_expression=_string(static_artifact.get("factor_expression"))
            or "candidate_family_score",
            source_idea=_string(static_artifact.get("source_idea"))
            or "2025_2026_signal_discovery_rankic_acceptance_harness",
            allowed_feature_dependencies=_string_list_from_value(
                static_artifact.get("allowed_feature_dependencies")
            )
            or _string_list_from_value(spec.feature_contract.get("required_features")),
            scorecard=evidence.objective_scorecard,
            fold_metrics=evidence.fold_metrics,
            candidate_count=max(1, candidate_count),
            candidate_spec_id=spec.candidate_spec_id,
            candidate_id=evidence.candidate_id,
            evidence_bundle_id=evidence.evidence_bundle_id,
        )
        evidence_status = "replayed"
        candidate_id = evidence.candidate_id
        evidence_bundle_id = evidence.evidence_bundle_id

    return {
        "schema_version": "torghut.factor-acceptance-replay-metadata.v1",
        "candidate_spec_id": spec.candidate_spec_id,
        "candidate_id": candidate_id,
        "evidence_bundle_id": evidence_bundle_id,
        "evidence_status": evidence_status,
        "status": _string(artifact.get("status")) or "rejected",
        "rejection_reasons": _string_list_from_value(artifact.get("rejection_reasons")),
        "lineage_hash": _string(artifact.get("lineage_hash")),
        "replay_artifact": artifact,
        "static_compile_artifact_lineage_hash": _string(
            static_artifact.get("lineage_hash")
        ),
        "promotion_scope": "research_paper_probation_only",
        "promotion_allowed": False,
        "final_promotion_authorized": False,
        "does_not_authorize_live_promotion": True,
    }


def _candidate_board_factor_acceptance_summary(
    rows: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    metadata_rows = [
        _mapping(row.get("factor_acceptance_replay_metadata"))
        for row in rows
        if _mapping(row.get("factor_acceptance_replay_metadata"))
    ]
    accepted = [
        row for row in metadata_rows if _string(row.get("status")) == "accepted"
    ]
    return {
        "schema_version": "torghut.factor-acceptance-board-summary.v1",
        "candidate_count": len(metadata_rows),
        "accepted_count": len(accepted),
        "rejected_count": len(metadata_rows) - len(accepted),
        "promotion_allowed": False,
        "final_promotion_authorized": False,
        "scope": "research_paper_probation_only",
        "accepted_candidate_spec_ids": [
            _string(row.get("candidate_spec_id")) for row in accepted
        ],
    }


def _candidate_board_payload(
    *,
    epoch_id: str,
    output_dir: Path,
    target: Decimal,
    candidate_specs: Sequence[CandidateSpec],
    candidate_selection: Mapping[str, Any],
    pre_replay_proposal_rows: Sequence[Mapping[str, Any]],
    proposal_rows: Sequence[Mapping[str, Any]],
    evidence_bundles: Sequence[CandidateEvidenceBundle],
    portfolio: PortfolioCandidateSpec | None,
    promotion_readiness: Mapping[str, Any],
    runtime_closure: Mapping[str, Any],
    paper_probation_target_limit: int = 1,
) -> dict[str, Any]:
    pre_replay_by_spec = _candidate_board_score_rows(pre_replay_proposal_rows)
    proposal_by_spec = _candidate_board_score_rows(proposal_rows)
    selection_by_spec = _candidate_board_score_rows(
        _list_of_mappings(candidate_selection.get("rows"))
    )
    evidence_by_spec = {bundle.candidate_spec_id: bundle for bundle in evidence_bundles}
    portfolio_payload = portfolio.to_payload() if portfolio is not None else {}
    portfolio_scorecard = _mapping(portfolio_payload.get("objective_scorecard"))
    portfolio_oracle_passed = _boolish(portfolio_scorecard.get("oracle_passed"))
    portfolio_sleeve_spec_ids = {
        _string(sleeve.get("candidate_spec_id"))
        for sleeve in _list_of_mappings(portfolio_payload.get("sleeves"))
        if _string(sleeve.get("candidate_spec_id"))
    }
    factor_acceptance_candidate_count = max(
        _candidate_board_int_field(
            _mapping(candidate_selection.get("budget")),
            "compiled_candidate_count",
        ),
        len(candidate_specs),
        len(evidence_bundles),
        1,
    )
    rows: list[dict[str, Any]] = []
    for spec in candidate_specs:
        selection = selection_by_spec.get(spec.candidate_spec_id, {})
        pre_replay = pre_replay_by_spec.get(spec.candidate_spec_id, {})
        proposal = proposal_by_spec.get(spec.candidate_spec_id, pre_replay)
        evidence = evidence_by_spec.get(spec.candidate_spec_id)
        raw_scorecard = (
            dict(evidence.objective_scorecard) if evidence is not None else {}
        )
        mechanism_overlay_ids = _string_list_from_value(
            spec.parameter_space.get("mechanism_overlay_ids")
        )
        if mechanism_overlay_ids:
            raw_scorecard.setdefault("mechanism_overlay_ids", mechanism_overlay_ids)
        if evidence is not None:
            raw_scorecard.setdefault(
                "replay_artifact_refs", list(evidence.replay_artifact_refs)
            )
        scorecard = _candidate_board_scorecard_with_evidence_blockers(
            raw_scorecard, evidence
        )
        scorecard, evidence_lineage = _candidate_board_scorecard_with_lineage_blockers(
            scorecard, evidence
        )
        scorecard, replay_window_coverage = (
            _candidate_board_scorecard_with_replay_window_blockers(scorecard)
        )
        market_impact_proof = _candidate_board_market_impact_proof_summary(scorecard)
        regime_specialist_validation = _candidate_board_regime_specialist_summary(
            spec, scorecard
        )
        scorecard, rejected_signal_summary = (
            _candidate_board_scorecard_with_rejected_signal_blockers(spec, scorecard)
        )
        scorecard, order_type_summary = (
            _candidate_board_scorecard_with_order_type_blockers(
                spec,
                scorecard,
                replay_artifact_refs=evidence.replay_artifact_refs
                if evidence is not None
                else (),
            )
        )
        scorecard, queue_position_survival_summary = (
            _candidate_board_scorecard_with_queue_position_survival_blockers(
                spec, scorecard
            )
        )
        scorecard, predictability_decay_summary = (
            _candidate_board_scorecard_with_predictability_decay_blockers(
                spec, scorecard, target=target
            )
        )
        selected_for_replay = bool(selection.get("selected_for_replay"))
        replay_selection_reason = _string(selection.get("selection_reason")) or (
            "not_selected_budget"
        )
        paper_contract_prior_score = _string(
            selection.get("paper_contract_prior_score")
        )
        paper_mechanism_overlay_ids = _string_list_from_value(
            selection.get("paper_mechanism_overlay_ids")
        )
        if not paper_mechanism_overlay_ids:
            paper_mechanism_overlay_ids = mechanism_overlay_ids
        paper_required_evidence_tokens = _string_list_from_value(
            selection.get("paper_required_evidence_tokens")
        )
        paper_required_evidence_count = _candidate_board_int_field(
            selection, "paper_required_evidence_count"
        )
        if paper_required_evidence_tokens and paper_required_evidence_count == 0:
            paper_required_evidence_count = len(paper_required_evidence_tokens)
        paper_contract_candidate = bool(
            _decimal(paper_contract_prior_score) > 0
            or paper_required_evidence_tokens
            or paper_mechanism_overlay_ids
        )
        in_best_portfolio = spec.candidate_spec_id in portfolio_sleeve_spec_ids
        blockers = _candidate_board_blockers(
            selected_for_replay=selected_for_replay,
            evidence=evidence,
            scorecard=scorecard,
        )
        runtime_window_start, runtime_window_end = (
            _candidate_board_runtime_window_bounds(scorecard)
        )
        exact_replay_ledger_artifact_ref = _string(
            scorecard.get("exact_replay_ledger_artifact_ref")
        )
        runtime_ledger_artifact_ref = _string(
            scorecard.get("runtime_ledger_artifact_ref")
            or exact_replay_ledger_artifact_ref
        )
        factor_acceptance_replay_metadata = (
            _candidate_factor_acceptance_replay_metadata(
                spec=spec,
                evidence=evidence,
                candidate_count=factor_acceptance_candidate_count,
            )
        )
        rows.append(
            {
                "epoch_id": epoch_id,
                "candidate_spec_id": spec.candidate_spec_id,
                "candidate_id": evidence.candidate_id if evidence is not None else "",
                "hypothesis_id": spec.hypothesis_id,
                "family_template_id": spec.family_template_id,
                "runtime_family": spec.runtime_family,
                "runtime_strategy_name": spec.runtime_strategy_name,
                "mechanism_overlay_ids": mechanism_overlay_ids,
                "pre_replay_rank": _rank_sort_value(pre_replay.get("rank")),
                "pre_replay_proposal_score": str(
                    pre_replay.get("proposal_score") or ""
                ),
                "rank": _rank_sort_value(proposal.get("rank")),
                "proposal_score": str(proposal.get("proposal_score") or ""),
                "selected_for_replay": selected_for_replay,
                "replay_selection_reason": replay_selection_reason,
                "paper_contract_candidate": paper_contract_candidate,
                "paper_contract_selected_for_replay": bool(
                    selected_for_replay and paper_contract_candidate
                ),
                "paper_contract_prior_score": paper_contract_prior_score,
                "paper_mechanism_overlay_ids": paper_mechanism_overlay_ids,
                "paper_required_evidence_tokens": paper_required_evidence_tokens,
                "paper_required_evidence_count": paper_required_evidence_count,
                "has_replay_evidence": evidence is not None,
                "in_best_portfolio": in_best_portfolio,
                "dataset_snapshot_id": evidence.dataset_snapshot_id
                if evidence is not None
                else "",
                "status": _candidate_board_status(
                    selected_for_replay=selected_for_replay,
                    evidence=evidence,
                    scorecard=scorecard,
                    in_best_portfolio=in_best_portfolio,
                    portfolio_oracle_passed=portfolio_oracle_passed,
                ),
                "target_met": _boolish(scorecard.get("target_met")),
                "oracle_passed": _boolish(scorecard.get("oracle_passed")),
                "net_pnl_per_day": _candidate_board_decimal_field(
                    scorecard, "net_pnl_per_day"
                )
                or _candidate_board_decimal_field(
                    scorecard, "portfolio_post_cost_net_pnl_per_day"
                ),
                "market_impact_stress_passed": _boolish(
                    scorecard.get("market_impact_stress_passed")
                ),
                "market_impact_stress_net_pnl_per_day": _candidate_board_decimal_field(
                    scorecard, "market_impact_stress_net_pnl_per_day"
                ),
                "delay_adjusted_depth_stress_passed": _boolish(
                    scorecard.get("delay_adjusted_depth_stress_passed")
                ),
                "delay_adjusted_depth_stress_net_pnl_per_day": _candidate_board_decimal_field(
                    scorecard, "delay_adjusted_depth_stress_net_pnl_per_day"
                ),
                "delay_adjusted_depth_fill_survival_evidence_present": _boolish(
                    scorecard.get("delay_adjusted_depth_fill_survival_evidence_present")
                    or scorecard.get("fill_survival_evidence_present")
                ),
                "delay_adjusted_depth_fill_survival_sample_count": _candidate_board_first_int_field(
                    scorecard,
                    (
                        "delay_adjusted_depth_fill_survival_sample_count",
                        "fill_survival_sample_count",
                    ),
                ),
                "delay_adjusted_depth_fill_survival_rate": _candidate_board_decimal_field(
                    scorecard, "delay_adjusted_depth_fill_survival_rate"
                )
                or _candidate_board_decimal_field(scorecard, "fill_survival_fill_rate")
                or _candidate_board_decimal_field(scorecard, "fill_survival_rate"),
                "queue_position_survival_fill_curve_evidence_present": _boolish(
                    scorecard.get("queue_position_survival_fill_curve_evidence_present")
                ),
                "queue_position_survival_sample_count": _candidate_board_int_field(
                    scorecard, "queue_position_survival_sample_count"
                ),
                "queue_position_survival_fill_rate": _candidate_board_decimal_field(
                    scorecard, "queue_position_survival_fill_rate"
                ),
                "queue_position_survival_queue_ratio_p95": _candidate_board_decimal_field(
                    scorecard, "queue_position_survival_queue_ratio_p95"
                ),
                "queue_position_survival_queue_ahead_depletion_evidence_present": _boolish(
                    scorecard.get(
                        "queue_position_survival_queue_ahead_depletion_evidence_present"
                    )
                ),
                "queue_position_survival_queue_ahead_depletion_sample_count": (
                    _candidate_board_int_field(
                        scorecard,
                        "queue_position_survival_queue_ahead_depletion_sample_count",
                    )
                ),
                "queue_position_survival_nonfill_opportunity_cost_bps": (
                    _candidate_board_decimal_field(
                        scorecard,
                        "queue_position_survival_nonfill_opportunity_cost_bps",
                    )
                    or _candidate_board_decimal_field(
                        scorecard, "queue_position_nonfill_opportunity_cost_bps"
                    )
                ),
                "fill_time_ms_p50": _candidate_board_decimal_field(
                    scorecard, "fill_time_ms_p50"
                ),
                "fill_time_ms_p95": _candidate_board_decimal_field(
                    scorecard, "fill_time_ms_p95"
                ),
                "delay_adjusted_depth_queue_ahead_depletion_evidence_present": _boolish(
                    scorecard.get(
                        "delay_adjusted_depth_queue_ahead_depletion_evidence_present"
                    )
                ),
                "delay_adjusted_depth_queue_ahead_depletion_sample_count": (
                    _candidate_board_int_field(
                        scorecard,
                        "delay_adjusted_depth_queue_ahead_depletion_sample_count",
                    )
                ),
                "queue_ahead_depletion_evidence_present": _boolish(
                    scorecard.get("queue_ahead_depletion_evidence_present")
                ),
                "queue_ahead_depletion_sample_count": _candidate_board_int_field(
                    scorecard, "queue_ahead_depletion_sample_count"
                ),
                "post_cost_net_pnl_after_queue_position_survival_fill_stress": (
                    _candidate_board_decimal_field(
                        scorecard,
                        "post_cost_net_pnl_after_queue_position_survival_fill_stress",
                    )
                ),
                "implementation_uncertainty_stability_passed": _boolish(
                    scorecard.get("implementation_uncertainty_stability_passed")
                ),
                "implementation_uncertainty_lower_net_pnl_per_day": _candidate_board_decimal_field(
                    scorecard, "implementation_uncertainty_lower_net_pnl_per_day"
                ),
                "conformal_tail_risk_required": _boolish(
                    scorecard.get("conformal_tail_risk_required")
                ),
                "conformal_tail_risk_passed": _boolish(
                    scorecard.get("conformal_tail_risk_passed")
                ),
                "conformal_tail_risk_adjusted_net_pnl_per_day": _candidate_board_decimal_field(
                    scorecard, "conformal_tail_risk_adjusted_net_pnl_per_day"
                ),
                "conformal_tail_risk_buffer_per_day": _candidate_board_decimal_field(
                    scorecard, "conformal_tail_risk_buffer_per_day"
                ),
                "trading_day_count": _candidate_board_int_field(
                    scorecard, "trading_day_count"
                ),
                "decision_count": _candidate_board_first_int_field(
                    scorecard,
                    (
                        "decision_count",
                        "trade_decision_count",
                        "paper_decision_count",
                        "runtime_decision_count",
                    ),
                ),
                "submitted_order_count": _candidate_board_first_int_field(
                    scorecard,
                    (
                        "submitted_order_count",
                        "order_count",
                        "orders_submitted_count",
                        "paper_order_count",
                        "runtime_order_count",
                    ),
                ),
                "filled_order_count": _candidate_board_first_int_field(
                    scorecard,
                    (
                        "filled_count",
                        "filled_order_count",
                        "executions_filled_count",
                        "execution_filled_count",
                        "paper_filled_order_count",
                        "trade_count",
                        "runtime_trade_count",
                    ),
                ),
                "executable_replay_order_count": _candidate_board_first_int_field(
                    scorecard,
                    (
                        "executable_replay_order_count",
                        "executable_replay_submitted_order_count",
                        "executable_replay_orders_submitted_total",
                    ),
                ),
                "double_oos_passed": _boolish(scorecard.get("double_oos_passed")),
                "double_oos_artifact_ref": _string(
                    scorecard.get("double_oos_artifact_ref")
                    or scorecard.get("double_oos_report_ref")
                    or scorecard.get("walk_forward_oos_artifact_ref")
                ),
                "double_oos_independent_window_count": _candidate_board_first_int_field(
                    scorecard,
                    (
                        "double_oos_independent_window_count",
                        "double_oos_fold_count",
                        "oos_fold_count",
                    ),
                ),
                "double_oos_pass_rate": _candidate_board_decimal_field(
                    scorecard, "double_oos_pass_rate"
                ),
                "double_oos_net_pnl_per_day": _candidate_board_decimal_field(
                    scorecard, "double_oos_net_pnl_per_day"
                ),
                "double_oos_cost_shock_net_pnl_per_day": _candidate_board_decimal_field(
                    scorecard, "double_oos_cost_shock_net_pnl_per_day"
                ),
                "active_day_ratio": _candidate_board_decimal_field(
                    scorecard, "active_day_ratio"
                ),
                "positive_day_ratio": _candidate_board_decimal_field(
                    scorecard, "positive_day_ratio"
                ),
                "best_day_share": _candidate_board_decimal_field(
                    scorecard, "best_day_share"
                ),
                "worst_day_loss": _candidate_board_decimal_field(
                    scorecard, "worst_day_loss"
                ),
                "avg_filled_notional_per_day": _candidate_board_decimal_field(
                    scorecard, "avg_filled_notional_per_day"
                ),
                "market_impact_proof": market_impact_proof,
                "regime_specialist_validation": regime_specialist_validation,
                "rejected_signal_outcome_learning": rejected_signal_summary,
                "order_type_execution_quality": order_type_summary,
                "queue_position_survival_fill_quality": (
                    queue_position_survival_summary
                ),
                "predictability_decay_stress": predictability_decay_summary,
                "factor_acceptance_replay_metadata": (
                    factor_acceptance_replay_metadata
                ),
                "factor_acceptance_status": _string(
                    factor_acceptance_replay_metadata.get("status")
                ),
                "factor_acceptance_promotion_allowed": False,
                "evidence_lineage": evidence_lineage,
                "replay_window_coverage": replay_window_coverage,
                "blockers": blockers,
                "runtime_window_start": runtime_window_start,
                "runtime_window_end": runtime_window_end,
                "account_label": _string(scorecard.get("account_label"))
                or ("TORGHUT_REPLAY" if runtime_ledger_artifact_ref else ""),
                "exact_replay_ledger_artifact_ref": exact_replay_ledger_artifact_ref,
                "runtime_ledger_artifact_ref": runtime_ledger_artifact_ref,
                "runtime_ledger_artifact_row_count": _candidate_board_first_int_field(
                    scorecard,
                    (
                        "runtime_ledger_artifact_row_count",
                        "exact_replay_ledger_artifact_row_count",
                    ),
                ),
                "runtime_ledger_artifact_fill_count": _candidate_board_first_int_field(
                    scorecard,
                    (
                        "runtime_ledger_artifact_fill_count",
                        "exact_replay_ledger_artifact_fill_count",
                    ),
                ),
                "replay_artifact_refs": list(evidence.replay_artifact_refs)
                if evidence is not None
                else [],
            }
        )
    rows.sort(
        key=lambda row: (
            _rank_sort_value(row.get("rank")),
            -_proposal_sort_value(row.get("proposal_score")),
            _string(row.get("candidate_spec_id")),
        )
    )
    best_research_candidate = rows[0] if rows else None
    best_executed_candidate = _candidate_board_best_executed_candidate(rows)
    closest_promotion_candidate = _candidate_board_closest_promotion_candidate(rows)
    paper_probation_candidates = _candidate_board_paper_probation_candidates(
        rows,
        target=target,
        limit=paper_probation_target_limit,
    )
    paper_probation_candidate = (
        paper_probation_candidates[0] if paper_probation_candidates else None
    )
    promotion_ready = _boolish(promotion_readiness.get("promotable"))
    promotion_subject = _candidate_board_portfolio_promotion_subject(
        portfolio=portfolio,
        portfolio_payload=portfolio_payload,
        portfolio_scorecard=portfolio_scorecard,
        promotion_readiness=promotion_readiness,
        runtime_closure=runtime_closure,
        rows=rows,
    )
    promotion_candidate_found = (
        promotion_ready and portfolio_oracle_passed and promotion_subject is not None
    ) or (
        promotion_ready
        and closest_promotion_candidate is not None
        and bool(closest_promotion_candidate.get("oracle_passed"))
    )
    return {
        "schema_version": "torghut.profit-candidate-board.v1",
        "epoch_id": epoch_id,
        "run_root": str(output_dir),
        "target_net_pnl_per_day": str(target),
        "status_digest": _candidate_board_status_digest(rows),
        "current_answer": "promotion_candidate_found"
        if promotion_candidate_found
        else "no_promotion_ready_candidate",
        "promotion_readiness": dict(promotion_readiness),
        "best_research_candidate": best_research_candidate,
        "best_executed_candidate": best_executed_candidate,
        "closest_promotion_candidate": closest_promotion_candidate,
        "paper_probation_candidate": paper_probation_candidate,
        "paper_probation_candidates": list(paper_probation_candidates),
        "paper_probation_target_limit": max(1, int(paper_probation_target_limit)),
        "promotion_subject": promotion_subject,
        "runtime_window_import_plan": _candidate_board_runtime_window_import_plan(
            rows=rows,
            paper_probation_candidate=None,
            paper_probation_candidates=paper_probation_candidates,
            promotion_subject=promotion_subject,
        ),
        "factor_acceptance_summary": _candidate_board_factor_acceptance_summary(rows),
        "double_oos_summary": _candidate_board_double_oos_summary(rows),
        "best_portfolio_candidate_id": _string(
            portfolio_payload.get("portfolio_candidate_id")
        ),
        "best_portfolio_oracle_passed": portfolio_oracle_passed,
        "runtime_closure_status": _string(runtime_closure.get("status")),
        "row_count": len(rows),
        "rows": rows,
    }


def _paper_probation_handoff_payload(
    candidate_board: Mapping[str, Any],
) -> dict[str, Any]:
    candidates = _list_of_mappings(candidate_board.get("paper_probation_candidates"))
    import_plan = _mapping(candidate_board.get("runtime_window_import_plan"))
    import_plan_ready = _string(import_plan.get("status")) == "ready"
    blockers: list[str] = []
    if not candidates:
        blockers.append("paper_probation_candidate_missing")
    if not import_plan_ready:
        blockers.append("runtime_window_import_plan_not_ready")
    status = "ready" if candidates and import_plan_ready else "not_ready"
    return {
        "schema_version": "torghut.paper-probation-handoff.v1",
        "status": status,
        "current_answer": _string(candidate_board.get("current_answer")),
        "evidence_collection_stage": "paper",
        "authorization_scope": "evidence_collection_only",
        "paper_probation_authorized": status == "ready",
        "probation_allowed": status == "ready",
        "promotion_allowed": False,
        "final_promotion_authorized": False,
        "final_promotion_allowed": False,
        "promotion_gate": "existing_runtime_governance_fail_closed",
        "blockers": blockers,
        "candidate_count": len(candidates),
        "candidates": candidates,
        "runtime_window_import_plan": import_plan,
    }


def _portfolio_with_runtime_closure_proof(
    *,
    portfolio: PortfolioCandidateSpec,
    runtime_closure: Mapping[str, Any],
    target: Decimal,
    oracle_policy: ProfitTargetOraclePolicy,
) -> PortfolioCandidateSpec:
    proof_update = _runtime_closure_scorecard_update(
        portfolio=portfolio, runtime_closure=runtime_closure
    )
    proof_payload = _mapping(proof_update.get("runtime_closure_proof"))
    if not proof_payload.get("executable_replay_artifact_refs") and proof_payload.get(
        "shadow_status"
    ) not in {"within_budget", "invalid_artifact"}:
        return portfolio

    scorecard = {**dict(portfolio.objective_scorecard), **proof_update}
    scorecard["profit_target_oracle"] = evaluate_profit_target_oracle(
        scorecard,
        target_net_pnl_per_day=target,
        policy=oracle_policy,
    )
    scorecard["oracle_passed"] = bool(scorecard["profit_target_oracle"]["passed"])
    runtime_refs = tuple(
        ref
        for ref in cast(
            Sequence[Any], scorecard.get("runtime_closure_artifact_refs") or ()
        )
        if _string(ref)
    )
    evidence_refs = tuple(dict.fromkeys((*portfolio.evidence_refs, *runtime_refs)))
    optimizer_report = {
        **dict(portfolio.optimizer_report),
        "runtime_closure_proof_status": proof_payload.get("status"),
        "runtime_closure_artifact_count": len(runtime_refs),
        "oracle_passed_after_runtime_closure": scorecard["oracle_passed"],
    }
    return replace(
        portfolio,
        objective_scorecard=scorecard,
        evidence_refs=evidence_refs,
        optimizer_report=optimizer_report,
    )


def _runtime_closure_program_for_candidate(
    *,
    program: StrategyAutoresearchProgram,
    manifest: MlxSnapshotManifest,
    portfolio: PortfolioCandidateSpec | None,
    oracle_candidate_found: bool,
) -> StrategyAutoresearchProgram:
    runtime_window_available = bool(manifest.source_window_start) and bool(
        manifest.source_window_end
    )
    if portfolio is None:
        return program
    if runtime_window_available and (
        oracle_candidate_found or _portfolio_needs_runtime_closure_proof(portfolio)
    ):
        return program
    return replace(
        program,
        runtime_closure_policy=replace(
            program.runtime_closure_policy,
            execute_parity_replay=False,
            execute_approval_replay=False,
        ),
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
    args = argparse.Namespace(
        **{
            **vars(args),
            "min_active_day_ratio": str(
                max(
                    _decimal(getattr(args, "min_active_day_ratio", "0.90")),
                    objective.min_active_day_ratio,
                )
            ),
            "min_positive_day_ratio": str(
                max(
                    _decimal(getattr(args, "min_positive_day_ratio", "0.60")),
                    objective.min_positive_day_ratio,
                )
            ),
            "min_daily_net_pnl": str(
                max(
                    _decimal_arg_or_default(
                        args,
                        "min_daily_net_pnl",
                        objective.min_daily_net_pnl,
                    ),
                    objective.min_daily_net_pnl,
                )
            ),
            "min_profit_factor": str(
                max(
                    _decimal(getattr(args, "min_profit_factor", "1.50")),
                    objective.min_profit_factor,
                )
            ),
            "max_worst_day_loss": str(
                min(
                    _decimal(getattr(args, "max_worst_day_loss", "999999999")),
                    objective.max_worst_day_loss,
                )
            ),
            "max_drawdown": str(
                min(
                    _decimal(getattr(args, "max_drawdown", "999999999")),
                    objective.max_drawdown,
                )
            ),
            "max_best_day_share": str(
                min(
                    _decimal(getattr(args, "max_best_day_share", "0.25")),
                    objective.max_best_day_share,
                )
            ),
            "min_avg_filled_notional_per_day": str(
                max(
                    _decimal(
                        getattr(args, "min_avg_filled_notional_per_day", "300000")
                    ),
                    objective.min_daily_notional,
                )
            ),
            "max_worst_day_loss_pct_equity": str(
                min(
                    _decimal(getattr(args, "max_worst_day_loss_pct_equity", "0.05")),
                    objective.max_worst_day_loss_pct_equity,
                )
            ),
            "max_drawdown_pct_equity": str(
                min(
                    _decimal(getattr(args, "max_drawdown_pct_equity", "0.08")),
                    objective.max_drawdown_pct_equity,
                )
            ),
            "extended_max_worst_day_loss_pct_equity": str(
                min(
                    _decimal(
                        getattr(args, "extended_max_worst_day_loss_pct_equity", "0.08")
                    ),
                    objective.extended_max_worst_day_loss_pct_equity,
                )
            ),
            "extended_max_drawdown_pct_equity": str(
                min(
                    _decimal(getattr(args, "extended_max_drawdown_pct_equity", "0.12")),
                    objective.extended_max_drawdown_pct_equity,
                )
            ),
            "min_total_net_pnl_to_drawdown_ratio": str(
                max(
                    _decimal(
                        getattr(args, "min_total_net_pnl_to_drawdown_ratio", "3.00")
                    ),
                    objective.min_total_net_pnl_to_drawdown_ratio,
                )
            ),
            "max_gross_exposure_pct_equity": str(
                min(
                    _decimal(getattr(args, "max_gross_exposure_pct_equity", "1.0")),
                    objective.max_gross_exposure_pct_equity,
                )
            ),
            "min_cash": str(
                max(_decimal(getattr(args, "min_cash", "0")), objective.min_cash)
            ),
            "no_require_double_oos": bool(getattr(args, "no_require_double_oos", False))
            or not bool(getattr(objective, "require_double_oos", True)),
            "min_double_oos_independent_window_count": max(
                _int_arg(args, "min_double_oos_independent_window_count", 2),
                int(getattr(objective, "min_double_oos_independent_window_count", 2)),
            ),
            "min_double_oos_pass_rate": str(
                max(
                    _decimal(getattr(args, "min_double_oos_pass_rate", "1.00")),
                    _decimal(
                        getattr(objective, "min_double_oos_pass_rate", "1.00"),
                        default="1.00",
                    ),
                )
            ),
            "staged_train_screen_multiplier": _resolved_staged_train_screen_multiplier(
                args, program
            ),
            **_resolved_real_replay_frontier_controls(args, program),
        }
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
    if direct_candidate_specs_replay:
        sources: list[WhitepaperResearchSource] = []
        hypothesis_cards: list[HypothesisCard] = []
        try:
            candidate_specs = list(_load_candidate_specs_jsonl(candidate_specs_paths))
        except ValueError as exc:
            return _write_failure_summary(
                output_dir=output_dir,
                epoch_id=epoch_id,
                status="invalid_candidate_specs",
                reason=str(exc),
                started_at=started_at,
                extra={
                    "candidate_specs": [str(path) for path in candidate_specs_paths]
                },
            )
        candidate_compilation_blockers: tuple[CandidateCompilationBlocker, ...] = ()
        candidate_compiler_report: dict[str, Any] = {
            "schema_version": "torghut.whitepaper-candidate-compiler-report.v1",
            "status": "loaded_candidate_specs_for_direct_replay",
            "candidate_specs_artifacts": [str(path) for path in candidate_specs_paths],
            "candidate_spec_count": len(candidate_specs),
            "executable_spec_count": len(candidate_specs),
            "blockers": [],
        }
    else:
        explicit_source_inputs = bool(
            args.seed_recent_whitepapers
            or getattr(args, "source_jsonl", [])
            or getattr(args, "paper_run_id", [])
        )
        sources = (
            list(_program_whitepaper_sources(program))
            if not explicit_source_inputs
            else []
        )
        if args.seed_recent_whitepapers:
            sources.extend(_program_whitepaper_sources(program))
            sources.extend(RECENT_WHITEPAPER_SEEDS)
        for source_jsonl in getattr(args, "source_jsonl", []):
            sources.extend(sources_from_jsonl(source_jsonl))
        sources.extend(_load_sources_from_db(args.paper_run_id))
        sources = _dedupe_whitepaper_sources(sources)
        if not sources:
            return _write_failure_summary(
                output_dir=output_dir,
                epoch_id=epoch_id,
                status="no_sources",
                reason="no_whitepaper_sources",
                started_at=started_at,
            )

        hypothesis_cards = compile_sources_to_hypothesis_cards(sources)
        compilation = compile_whitepaper_candidate_specs(
            hypothesis_cards=hypothesis_cards,
            target_net_pnl_per_day=target,
            family_template_dir=args.family_template_dir.resolve(),
            seed_sweep_dir=args.seed_sweep_dir.resolve(),
            universe_symbols=candidate_universe_symbols,
        )
        candidate_specs = list(compilation.executable_specs)
        candidate_specs = _candidate_specs_with_oracle_policy(
            candidate_specs, oracle_policy=oracle_policy
        )
        candidate_compilation_blockers = tuple(compilation.blockers)
        candidate_compiler_report = compilation.to_payload()
    blocker_by_spec: dict[str, list[CandidateCompilationBlocker]] = {}
    for blocker in candidate_compilation_blockers:
        blocker_by_spec.setdefault(blocker.candidate_spec_id, []).append(blocker)
    if (
        args.persist_results
        and args.replay_mode == "real"
        and not selection_only
        and not direct_candidate_specs_replay
    ):
        for source in sources:
            source_specs = [
                spec
                for spec in candidate_specs
                if spec.feature_contract.get("source_run_id") == source.run_id
            ]
            _persist_vnext_specs(source_run_id=source.run_id, specs=source_specs)

    _write_json(
        output_dir / "epoch-manifest.json",
        {
            "epoch_id": epoch_id,
            "started_at": datetime.now(UTC).isoformat(),
            "target_net_pnl_per_day": str(target),
            "replay_mode": args.replay_mode,
            "source_count": len(sources),
            "paper_sources": [source.to_payload() for source in sources],
        },
    )
    _write_jsonl(
        output_dir / "whitepaper-sources.jsonl",
        [source.to_payload() for source in sources],
    )
    _write_jsonl(
        output_dir / "hypothesis-cards.jsonl",
        [card.to_payload() for card in hypothesis_cards],
    )
    _write_jsonl(
        output_dir / "candidate-specs.jsonl",
        [spec.to_payload() for spec in candidate_specs],
    )
    _write_json(
        output_dir / "candidate-compiler-report.json", candidate_compiler_report
    )

    if not candidate_specs:
        return _write_failure_summary(
            output_dir=output_dir,
            epoch_id=epoch_id,
            status="no_eligible_candidates",
            reason="candidate_compiler_produced_no_executable_specs",
            started_at=started_at,
        )
    try:
        (
            feedback_evidence_bundles,
            feedback_evidence_source_manifest,
        ) = _load_autoresearch_feedback_evidence_bundles(
            cast(Sequence[Path], getattr(args, "feedback_evidence_jsonl", ()) or ()),
            include_persisted=bool(getattr(args, "persist_results", False))
            and not selection_only,
        )
    except ValueError as exc:
        return _write_failure_summary(
            output_dir=output_dir,
            epoch_id=epoch_id,
            status="invalid_feedback_evidence",
            reason=str(exc),
            started_at=started_at,
        )
    _write_json(
        output_dir / "feedback-evidence-source-manifest.json",
        feedback_evidence_source_manifest,
    )
    pre_replay_model, pre_replay_proposal_rows = _pre_replay_proposal_model_and_rows(
        specs=candidate_specs,
        feedback_evidence_bundles=feedback_evidence_bundles,
        oracle_policy=oracle_policy,
        ranker_backend_preference=ranker_backend_preference,
    )
    _write_json(output_dir / "pre-replay-mlx-ranker-model.json", pre_replay_model)
    _write_jsonl(
        output_dir / "pre-replay-mlx-proposal-scores.jsonl",
        pre_replay_proposal_rows,
    )
    if direct_candidate_specs_replay:
        replay_candidate_specs = list(candidate_specs)
        candidate_selection = _candidate_selection_for_direct_replay(
            specs=replay_candidate_specs,
            proposal_rows=pre_replay_proposal_rows,
            candidate_specs_paths=candidate_specs_paths,
        )
    else:
        replay_candidate_specs, candidate_selection = (
            _select_candidate_specs_for_replay(
                specs=candidate_specs,
                proposal_rows=pre_replay_proposal_rows,
                top_k=int(args.top_k),
                exploration_slots=int(args.exploration_slots),
                feedback_block_reaudit_slots=int(
                    getattr(args, "feedback_block_reaudit_slots", 0) or 0
                ),
                max_candidates=int(args.max_candidates),
                portfolio_size_min=int(args.portfolio_size_min),
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
            output_dir / "pre-replay-mlx-proposal-scores.jsonl"
        ),
        "selected_candidate_specs_artifact": str(
            output_dir / "selected-candidate-specs.jsonl"
        ),
    }
    materialized_replay_tape_receipt: dict[str, Any] | None = None
    try:
        args, materialized_replay_tape_receipt = _maybe_materialize_epoch_replay_tape(
            args=args,
            output_dir=output_dir,
            epoch_id=epoch_id,
        )
    except Exception as exc:
        return _write_failure_summary(
            output_dir=output_dir,
            epoch_id=epoch_id,
            status="replay_tape_materialization_failed",
            reason=str(exc),
            started_at=started_at,
        )
    if materialized_replay_tape_receipt is not None:
        candidate_selection = {
            **candidate_selection,
            "replay_tape_materialization": materialized_replay_tape_receipt,
        }
    if replay_source_window_preflight is not None:
        candidate_selection = {
            **candidate_selection,
            "replay_tape_source_window_preflight": replay_source_window_preflight,
        }
    try:
        replay_candidate_specs, candidate_selection = (
            _apply_fast_replay_preview_narrowing(
                args=args,
                output_dir=output_dir,
                specs=replay_candidate_specs,
                candidate_selection=candidate_selection,
            )
        )
    except ValueError as exc:
        return _write_failure_summary(
            output_dir=output_dir,
            epoch_id=epoch_id,
            status="invalid_replay_tape_preview",
            reason=str(exc),
            started_at=started_at,
        )
    _write_json(output_dir / "candidate-selection-manifest.json", candidate_selection)
    _write_jsonl(
        output_dir / "selected-candidate-specs.jsonl",
        [spec.to_payload() for spec in replay_candidate_specs],
    )
    if selection_only:
        selected_candidate_spec_ids = [
            spec.candidate_spec_id for spec in replay_candidate_specs
        ]
        summary = {
            "status": "selection_only",
            "status_reason": "pre_replay_selection_only",
            "epoch_id": epoch_id,
            "run_root": str(output_dir),
            "started_at": started_at.isoformat(),
            "completed_at": datetime.now(UTC).isoformat(),
            "target_net_pnl_per_day": str(target),
            "profit_target_oracle_policy": oracle_policy.to_payload(),
            "source_count": len(sources),
            "hypothesis_count": len(hypothesis_cards),
            "candidate_spec_count": len(candidate_specs),
            "candidate_compiler_blocker_count": len(candidate_compilation_blockers),
            "feedback_evidence_bundle_count": len(feedback_evidence_bundles),
            "pre_replay_proposal_score_count": len(pre_replay_proposal_rows),
            "replay_candidate_spec_count": len(replay_candidate_specs),
            "selected_candidate_spec_ids": selected_candidate_spec_ids,
            "claim_count": sum(len(source.claims) for source in sources),
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
                "epoch_manifest": str(output_dir / "epoch-manifest.json"),
                "hypothesis_cards": str(output_dir / "hypothesis-cards.jsonl"),
                "whitepaper_sources": str(output_dir / "whitepaper-sources.jsonl"),
                "candidate_specs": str(output_dir / "candidate-specs.jsonl"),
                "candidate_selection_manifest": str(
                    output_dir / "candidate-selection-manifest.json"
                ),
                "selected_candidate_specs": str(
                    output_dir / "selected-candidate-specs.jsonl"
                ),
                "pre_replay_proposal_scores": str(
                    output_dir / "pre-replay-mlx-proposal-scores.jsonl"
                ),
                "pre_replay_proposal_model": str(
                    output_dir / "pre-replay-mlx-ranker-model.json"
                ),
                "feedback_evidence_source_manifest": str(
                    output_dir / "feedback-evidence-source-manifest.json"
                ),
                "candidate_compiler_report": str(
                    output_dir / "candidate-compiler-report.json"
                ),
                "summary": str(output_dir / "summary.json"),
                "diagnostics_notebook": str(
                    output_dir / "whitepaper-autoresearch-diagnostics.ipynb"
                ),
            },
        }
        _write_json(output_dir / "summary.json", summary)
        write_whitepaper_autoresearch_diagnostics_notebook(
            output_dir / "whitepaper-autoresearch-diagnostics.ipynb",
            summary=summary,
        )
        return summary
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
        failure_reason = f"{type(exc).__name__}:{exc}"
        partial_replay_result = (
            _collect_partial_real_replay(
                output_dir=output_dir, specs=replay_candidate_specs
            )
            if args.replay_mode == "real"
            else EpochReplayResult(evidence_bundles=(), replay_results=())
        )
        partial_artifact_path = output_dir / "candidate-evidence-bundles.partial.jsonl"
        if partial_replay_result.evidence_bundles:
            _write_jsonl(
                partial_artifact_path,
                [
                    bundle.to_payload()
                    for bundle in partial_replay_result.evidence_bundles
                ],
            )
        replay_diagnostic_rows = _replay_diagnostic_proposal_rows(
            candidate_selection=candidate_selection,
            pre_replay_proposal_rows=pre_replay_proposal_rows,
        )
        false_positive_table = _false_positive_table(
            proposal_rows=replay_diagnostic_rows,
            evidence_bundles=partial_replay_result.evidence_bundles,
            oracle_policy=oracle_policy,
        )
        best_false_negative_table = _best_false_negative_table(
            candidate_selection=candidate_selection,
            pre_replay_proposal_rows=pre_replay_proposal_rows,
            evidence_bundles=partial_replay_result.evidence_bundles,
        )
        remediation = _candidate_search_remediation(
            failure_reason=failure_reason,
            candidate_selection=candidate_selection,
            evidence_bundles=partial_replay_result.evidence_bundles,
            false_positive_table=false_positive_table,
            best_false_negative_table=best_false_negative_table,
            replay_timeout_seconds=int(
                getattr(args, "real_replay_timeout_seconds", 0) or 0
            ),
            max_frontier_candidates_per_spec=int(
                getattr(
                    args,
                    "max_frontier_candidates_per_spec",
                    _DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC,
                )
                or _DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC
            ),
            current_top_k=int(getattr(args, "top_k", 16) or 16),
            current_exploration_slots=int(getattr(args, "exploration_slots", 8) or 8),
            current_portfolio_size_min=int(getattr(args, "portfolio_size_min", 2) or 2),
            current_max_candidates=int(getattr(args, "max_candidates", 64) or 64),
            current_max_total_frontier_candidates=int(
                getattr(args, "max_total_frontier_candidates", 0) or 0
            ),
            current_train_days=int(getattr(args, "train_days", 6) or 6),
            current_holdout_days=int(getattr(args, "holdout_days", 3) or 3),
            current_second_oos_days=int(getattr(args, "second_oos_days", 2) or 2),
        )
        remediation_path = output_dir / "candidate-search-remediation.json"
        _write_json(remediation_path, remediation)
        profitability_goal = _profitability_search_goal(
            args=args,
            output_dir=output_dir,
            status="replay_failed",
            status_reason=failure_reason,
            target=target,
            program=program,
            sources=sources,
            hypothesis_cards=hypothesis_cards,
            candidate_specs=candidate_specs,
            candidate_selection=candidate_selection,
            pre_replay_model=pre_replay_model,
            proposal_model=None,
            evidence_bundles=partial_replay_result.evidence_bundles,
            false_positive_table=false_positive_table,
            best_false_negative_table=best_false_negative_table,
            portfolio=None,
            oracle_candidate_found=False,
            profit_target_oracle=None,
            promotion_blockers=["replay_failed", failure_reason],
            remediation=remediation,
        )
        profitability_goal_path = output_dir / "profitability-search-goal.json"
        _write_json(profitability_goal_path, profitability_goal)
        return _write_failure_summary(
            output_dir=output_dir,
            epoch_id=epoch_id,
            status="replay_failed",
            reason=failure_reason,
            started_at=started_at,
            extra={
                "partial_evidence_bundle_count": len(
                    partial_replay_result.evidence_bundles
                ),
                "partial_replay_result_count": len(
                    partial_replay_result.replay_results
                ),
                "partial_artifacts": {
                    "candidate_evidence_bundles": str(partial_artifact_path)
                    if partial_replay_result.evidence_bundles
                    else None,
                    "strategy_factory_dir": str(output_dir / "strategy-factory"),
                },
                "false_positive_table": false_positive_table,
                "best_false_negative_table": best_false_negative_table,
                "candidate_search_remediation": remediation,
                "profitability_search_goal": profitability_goal,
                "artifacts": {
                    "candidate_search_remediation": str(remediation_path),
                    "profitability_search_goal": str(profitability_goal_path),
                    "candidate_selection_manifest": str(
                        output_dir / "candidate-selection-manifest.json"
                    ),
                    "selected_candidate_specs": str(
                        output_dir / "selected-candidate-specs.jsonl"
                    ),
                    "feedback_evidence_source_manifest": str(
                        output_dir / "feedback-evidence-source-manifest.json"
                    ),
                    "partial_candidate_evidence_bundles": str(partial_artifact_path)
                    if partial_replay_result.evidence_bundles
                    else None,
                    "summary": str(output_dir / "summary.json"),
                    "diagnostics_notebook": str(
                        output_dir / "whitepaper-autoresearch-diagnostics.ipynb"
                    ),
                },
            },
        )
    proposal_model, proposal_rows = _proposal_model_and_rows(
        specs=candidate_specs,
        evidence_bundles=replay_result.evidence_bundles,
        ranker_backend_preference=ranker_backend_preference,
        replay_selection_by_spec=selection_by_spec,
    )
    _write_json(output_dir / "mlx-ranker-model.json", proposal_model)
    _write_jsonl(output_dir / "mlx-proposal-scores.jsonl", proposal_rows)
    _write_jsonl(
        output_dir / "candidate-evidence-bundles.jsonl",
        [bundle.to_payload() for bundle in replay_result.evidence_bundles],
    )

    portfolio = optimize_portfolio_candidate(
        evidence_bundles=replay_result.evidence_bundles,
        target_net_pnl_per_day=target,
        oracle_policy=oracle_policy,
        portfolio_size_min=int(args.portfolio_size_min),
        portfolio_size_max=int(args.portfolio_size_max),
    )
    portfolio_rows = [portfolio.to_payload()] if portfolio is not None else []
    _write_jsonl(output_dir / "portfolio-candidates.jsonl", portfolio_rows)
    _write_json(
        output_dir / "portfolio-optimizer-report.json",
        portfolio.optimizer_report
        if portfolio is not None
        else {"status": "no_portfolio_candidate"},
    )
    mlx_snapshot_manifest = _epoch_mlx_snapshot_manifest(
        args=args,
        output_dir=output_dir,
        epoch_id=epoch_id,
        program=program,
        source_count=len(sources),
        hypothesis_count=len(hypothesis_cards),
        candidate_spec_count=len(candidate_specs),
        pre_replay_proposal_score_count=len(pre_replay_proposal_rows),
        replay_candidate_spec_count=len(replay_candidate_specs),
        evidence_bundle_count=len(replay_result.evidence_bundles),
        proposal_score_count=len(proposal_rows),
        portfolio_candidate_count=len(portfolio_rows),
    )
    write_mlx_snapshot_manifest(
        output_dir / "mlx-snapshot-manifest.json", mlx_snapshot_manifest
    )
    initial_oracle_candidate_found = bool(
        portfolio is not None
        and portfolio.objective_scorecard.get("oracle_passed") is True
        and not replay_result.incomplete
    )
    runtime_closure_program = _runtime_closure_program_for_candidate(
        program=program,
        manifest=mlx_snapshot_manifest,
        portfolio=portfolio,
        oracle_candidate_found=initial_oracle_candidate_found,
    )
    runtime_closure = _runtime_closure_payload(
        args=args,
        output_dir=output_dir,
        epoch_id=epoch_id,
        program=runtime_closure_program,
        manifest=mlx_snapshot_manifest,
        portfolio=portfolio,
    )
    if portfolio is not None:
        portfolio = _portfolio_with_runtime_closure_proof(
            portfolio=portfolio,
            runtime_closure=runtime_closure,
            target=target,
            oracle_policy=oracle_policy,
        )
        portfolio_rows = [portfolio.to_payload()]
        _write_jsonl(output_dir / "portfolio-candidates.jsonl", portfolio_rows)
        _write_json(
            output_dir / "portfolio-optimizer-report.json", portfolio.optimizer_report
        )

    oracle_candidate_found = bool(
        portfolio is not None
        and portfolio.objective_scorecard.get("oracle_passed") is True
        and not replay_result.incomplete
    )
    replay_failure_reasons = list(replay_result.failure_reasons)
    profit_target_oracle = (
        portfolio.objective_scorecard.get("profit_target_oracle")
        if portfolio is not None
        else None
    )
    if portfolio is None:
        promotion_status = "no_candidate"
        promotion_blockers: list[str] = []
    elif replay_result.incomplete:
        promotion_status = "blocked_pending_complete_replay"
        promotion_blockers = ["selected_replay_incomplete", *replay_failure_reasons]
    elif oracle_candidate_found:
        runtime_status = _string(runtime_closure.get("status"))
        promotion_status = runtime_status or "ready_for_promotion_review"
        promotion_blockers = [
            _string(item)
            for item in cast(
                Sequence[Any], runtime_closure.get("next_required_steps") or ()
            )
            if _string(item) and _string(item) != "promotion_review"
        ]
    else:
        runtime_next_steps = [
            _string(item)
            for item in cast(
                Sequence[Any], runtime_closure.get("next_required_steps") or ()
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
        runtime_closure=runtime_closure,
    )
    status = "ok" if oracle_candidate_found else "no_profit_target_candidate"
    status_reason = None
    if not oracle_candidate_found:
        if replay_result.incomplete:
            status_reason = "selected_replay_incomplete"
        elif portfolio is None:
            status_reason = "portfolio_optimizer_produced_no_candidate"
        else:
            status_reason = "portfolio_candidate_failed_profit_target_oracle"
    false_positive_table = _false_positive_table(
        proposal_rows=proposal_rows,
        evidence_bundles=replay_result.evidence_bundles,
        oracle_policy=oracle_policy,
    )
    best_false_negative_table = _best_false_negative_table(
        candidate_selection=candidate_selection,
        pre_replay_proposal_rows=pre_replay_proposal_rows,
        evidence_bundles=replay_result.evidence_bundles,
    )
    candidate_search_remediation: dict[str, Any] | None = None
    remediation_path = output_dir / "candidate-search-remediation.json"
    if not oracle_candidate_found:
        candidate_search_remediation = _candidate_search_remediation(
            failure_reason=status_reason or status,
            candidate_selection=candidate_selection,
            evidence_bundles=replay_result.evidence_bundles,
            false_positive_table=false_positive_table,
            best_false_negative_table=best_false_negative_table,
            replay_timeout_seconds=int(
                getattr(args, "real_replay_timeout_seconds", 0) or 0
            ),
            max_frontier_candidates_per_spec=int(
                getattr(
                    args,
                    "max_frontier_candidates_per_spec",
                    _DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC,
                )
                or _DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC
            ),
            current_top_k=int(getattr(args, "top_k", 16) or 16),
            current_exploration_slots=int(getattr(args, "exploration_slots", 8) or 8),
            current_portfolio_size_min=int(getattr(args, "portfolio_size_min", 2) or 2),
            current_max_candidates=int(getattr(args, "max_candidates", 64) or 64),
            current_max_total_frontier_candidates=int(
                getattr(args, "max_total_frontier_candidates", 0) or 0
            ),
            current_train_days=int(getattr(args, "train_days", 6) or 6),
            current_holdout_days=int(getattr(args, "holdout_days", 3) or 3),
            current_second_oos_days=int(getattr(args, "second_oos_days", 2) or 2),
        )
        _write_json(remediation_path, candidate_search_remediation)
    candidate_board = _candidate_board_payload(
        epoch_id=epoch_id,
        output_dir=output_dir,
        target=target,
        candidate_specs=candidate_specs,
        candidate_selection=candidate_selection,
        pre_replay_proposal_rows=pre_replay_proposal_rows,
        proposal_rows=proposal_rows,
        evidence_bundles=replay_result.evidence_bundles,
        portfolio=portfolio,
        promotion_readiness=promotion_readiness,
        runtime_closure=runtime_closure,
        paper_probation_target_limit=program.replay_budget.exploration_slots,
    )
    candidate_board_path = output_dir / "candidate-board.json"
    _write_json(candidate_board_path, candidate_board)
    paper_probation_handoff = _paper_probation_handoff_payload(candidate_board)
    paper_probation_handoff_path = output_dir / "paper-probation-handoff.json"
    _write_json(paper_probation_handoff_path, paper_probation_handoff)
    profitability_goal = _profitability_search_goal(
        args=args,
        output_dir=output_dir,
        status=status,
        status_reason=status_reason,
        target=target,
        program=program,
        sources=sources,
        hypothesis_cards=hypothesis_cards,
        candidate_specs=candidate_specs,
        candidate_selection=candidate_selection,
        pre_replay_model=pre_replay_model,
        proposal_model=proposal_model,
        evidence_bundles=replay_result.evidence_bundles,
        false_positive_table=false_positive_table,
        best_false_negative_table=best_false_negative_table,
        portfolio=portfolio,
        oracle_candidate_found=oracle_candidate_found,
        profit_target_oracle=cast(Mapping[str, Any], profit_target_oracle)
        if isinstance(profit_target_oracle, Mapping)
        else None,
        promotion_blockers=promotion_blockers,
        remediation=candidate_search_remediation,
    )
    profitability_goal_path = output_dir / "profitability-search-goal.json"
    _write_json(profitability_goal_path, profitability_goal)
    summary = {
        "status": status,
        "status_reason": status_reason,
        "epoch_id": epoch_id,
        "run_root": str(output_dir),
        "target_net_pnl_per_day": str(target),
        "profit_target_oracle_policy": oracle_policy.to_payload(),
        "source_count": len(sources),
        "hypothesis_count": len(hypothesis_cards),
        "candidate_spec_count": len(candidate_specs),
        "candidate_compiler_blocker_count": len(candidate_compilation_blockers),
        "evidence_bundle_count": len(replay_result.evidence_bundles),
        "candidate_evidence_bundle_payloads": _evidence_bundle_payloads_for_epoch_summary(
            replay_result.evidence_bundles
        ),
        "candidate_evidence_bundle_payload_count": min(
            len(replay_result.evidence_bundles),
            _MAX_PERSISTED_FEEDBACK_EVIDENCE_BUNDLES,
        ),
        "replay_candidate_spec_count": len(replay_candidate_specs),
        "selected_candidate_spec_ids": [
            spec.candidate_spec_id for spec in replay_candidate_specs
        ],
        "replay_incomplete": replay_result.incomplete,
        "replay_failure_reasons": replay_failure_reasons,
        "replay_tape_materialization": materialized_replay_tape_receipt,
        "pre_replay_proposal_score_count": len(pre_replay_proposal_rows),
        "proposal_score_count": len(proposal_rows),
        "portfolio_candidate_count": len(portfolio_rows),
        "claim_count": sum(len(source.claims) for source in sources),
        "mlx_rank_bucket_lift": proposal_model.get("rank_bucket_lift", {}),
        "false_positive_table": false_positive_table,
        "best_false_negative_table": best_false_negative_table,
        "candidate_board": candidate_board,
        "paper_probation_handoff": paper_probation_handoff,
        "candidate_search_remediation": candidate_search_remediation,
        "profitability_search_goal": profitability_goal,
        "best_portfolio_candidate": portfolio.to_payload()
        if portfolio is not None
        else None,
        "oracle_candidate_found": oracle_candidate_found,
        "profit_target_oracle": profit_target_oracle,
        "promotion_readiness": promotion_readiness,
        "runtime_closure": runtime_closure,
        "artifacts": {
            "epoch_manifest": str(output_dir / "epoch-manifest.json"),
            "hypothesis_cards": str(output_dir / "hypothesis-cards.jsonl"),
            "whitepaper_sources": str(output_dir / "whitepaper-sources.jsonl"),
            "candidate_specs": str(output_dir / "candidate-specs.jsonl"),
            "candidate_selection_manifest": str(
                output_dir / "candidate-selection-manifest.json"
            ),
            "selected_candidate_specs": str(
                output_dir / "selected-candidate-specs.jsonl"
            ),
            "pre_replay_proposal_scores": str(
                output_dir / "pre-replay-mlx-proposal-scores.jsonl"
            ),
            "pre_replay_proposal_model": str(
                output_dir / "pre-replay-mlx-ranker-model.json"
            ),
            "feedback_evidence_source_manifest": str(
                output_dir / "feedback-evidence-source-manifest.json"
            ),
            "mlx_snapshot_manifest": str(output_dir / "mlx-snapshot-manifest.json"),
            "candidate_compiler_report": str(
                output_dir / "candidate-compiler-report.json"
            ),
            "proposal_scores": str(output_dir / "mlx-proposal-scores.jsonl"),
            "proposal_model": str(output_dir / "mlx-ranker-model.json"),
            "candidate_evidence_bundles": str(
                output_dir / "candidate-evidence-bundles.jsonl"
            ),
            "portfolio_candidates": str(output_dir / "portfolio-candidates.jsonl"),
            "portfolio_optimizer_report": str(
                output_dir / "portfolio-optimizer-report.json"
            ),
            "candidate_board": str(candidate_board_path),
            "paper_probation_handoff": str(paper_probation_handoff_path),
            "candidate_search_remediation": str(remediation_path)
            if candidate_search_remediation is not None
            else None,
            "profitability_search_goal": str(profitability_goal_path),
            "replay_tape": (
                materialized_replay_tape_receipt.get("tape_path")
                if materialized_replay_tape_receipt is not None
                else None
            ),
            "replay_tape_manifest": (
                materialized_replay_tape_receipt.get("manifest_path")
                if materialized_replay_tape_receipt is not None
                else None
            ),
            "replay_tape_receipt": (
                materialized_replay_tape_receipt.get("receipt_path")
                if materialized_replay_tape_receipt is not None
                else None
            ),
            "summary": str(output_dir / "summary.json"),
            "diagnostics_notebook": str(
                output_dir / "whitepaper-autoresearch-diagnostics.ipynb"
            ),
        },
    }
    _write_json(output_dir / "summary.json", summary)
    write_whitepaper_autoresearch_diagnostics_notebook(
        output_dir / "whitepaper-autoresearch-diagnostics.ipynb",
        summary=summary,
    )
    if args.persist_results:
        runner_config = {
            "replay_mode": args.replay_mode,
            "max_candidates": int(args.max_candidates),
            "top_k": int(args.top_k),
            "exploration_slots": int(args.exploration_slots),
            "feedback_block_reaudit_slots": int(
                getattr(args, "feedback_block_reaudit_slots", 0) or 0
            ),
            "replay_candidate_spec_count": len(replay_candidate_specs),
            "replay_incomplete": replay_result.incomplete,
            "replay_failure_reasons": replay_failure_reasons,
            "portfolio_size_min": int(args.portfolio_size_min),
            "portfolio_size_max": int(args.portfolio_size_max),
            "real_replay_shard_size": int(
                getattr(args, "real_replay_shard_size", 0) or 0
            ),
            "real_replay_shard_timeout_seconds": int(
                _bounded_real_replay_shard_timeout_seconds(
                    getattr(
                        args,
                        "real_replay_shard_timeout_seconds",
                        _DEFAULT_REAL_REPLAY_SHARD_TIMEOUT_SECONDS,
                    )
                )
            ),
            "real_replay_shard_workers": int(
                getattr(
                    args,
                    "real_replay_shard_workers",
                    _DEFAULT_REAL_REPLAY_SHARD_WORKERS,
                )
                or _DEFAULT_REAL_REPLAY_SHARD_WORKERS
            ),
            "real_replay_max_parallel_frontier_candidates": int(
                getattr(
                    args,
                    "real_replay_max_parallel_frontier_candidates",
                    _DEFAULT_REAL_REPLAY_MAX_PARALLEL_FRONTIER_CANDIDATES,
                )
                or _DEFAULT_REAL_REPLAY_MAX_PARALLEL_FRONTIER_CANDIDATES
            ),
            "real_replay_failed_spec_retries": int(
                getattr(args, "real_replay_failed_spec_retries", 1) or 0
            ),
            "real_replay_retry_timeout_seconds": int(
                getattr(args, "real_replay_retry_timeout_seconds", 0) or 0
            ),
            "real_replay_retry_max_frontier_candidates_per_spec": int(
                getattr(args, "real_replay_retry_max_frontier_candidates_per_spec", 1)
                or 1
            ),
            "replay_tape_preview_top_k": int(
                getattr(args, "replay_tape_preview_top_k", 0) or 0
            ),
            "replay_tape_preview_min_rows": int(
                getattr(args, "replay_tape_preview_min_rows", 2) or 2
            ),
            "materialize_replay_tape": bool(
                getattr(args, "materialize_replay_tape", False)
            ),
            "replay_tape_path": str(getattr(args, "replay_tape_path", "") or ""),
            "replay_tape_manifest": str(
                getattr(args, "replay_tape_manifest", "") or ""
            ),
            "source_jsonl": [str(path) for path in getattr(args, "source_jsonl", [])],
        }
        try:
            _persist_epoch_ledgers(
                epoch_id=epoch_id,
                status=status,
                target_net_pnl_per_day=target,
                paper_run_ids=[str(item) for item in args.paper_run_id],
                sources=sources,
                candidate_specs=candidate_specs,
                candidate_blockers=blocker_by_spec,
                proposal_rows=proposal_rows,
                portfolio=portfolio,
                summary=summary,
                runner_config=runner_config,
                started_at=started_at,
                completed_at=datetime.now(UTC),
            )
            summary["persistence_status"] = "persisted"
            _write_json(output_dir / "summary.json", summary)
        except Exception as exc:
            summary["pre_persistence_status"] = status
            summary["status"] = "persistence_failed"
            summary["status_reason"] = "epoch_ledger_persistence_failed"
            summary["persistence_status"] = "failed"
            summary["persistence_error"] = str(exc)
            summary["persistence_runner_config"] = runner_config
            _write_json(output_dir / "persistence-error-summary.json", summary)
            _write_json(output_dir / "error-summary.json", summary)
            _write_json(output_dir / "summary.json", summary)
            write_whitepaper_autoresearch_diagnostics_notebook(
                output_dir / "whitepaper-autoresearch-diagnostics.ipynb",
                summary=summary,
            )
    return summary


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
