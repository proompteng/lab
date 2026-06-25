#!/usr/bin/env python3
"""Run a whitepaper-driven autoresearch epoch targeting a portfolio profit objective."""

from __future__ import annotations

import argparse
import os
from pathlib import Path


from app.trading.discovery.candidate_specs import (
    LIVE_SIGNAL_COVERED_SEMICONDUCTOR_UNIVERSE,
)


from scripts.whitepaper_autoresearch_runner.candidate_board_fields import (
    _candidate_board_score_rows as _candidate_board_score_rows,
    _candidate_board_decimal_field as _candidate_board_decimal_field,
    _candidate_board_int_field as _candidate_board_int_field,
    _candidate_board_first_int_field as _candidate_board_first_int_field,
)
from scripts.whitepaper_autoresearch_runner.candidate_board_paper_probation import (
    _paper_probation_candidate_payload as _paper_probation_candidate_payload,
    _candidate_board_paper_probation_candidates as _candidate_board_paper_probation_candidates,
    _candidate_board_paper_probation_candidate as _candidate_board_paper_probation_candidate,
    _candidate_board_status_digest as _candidate_board_status_digest,
    _candidate_board_double_oos_summary as _candidate_board_double_oos_summary,
    _candidate_board_portfolio_promotion_subject as _candidate_board_portfolio_promotion_subject,
)
from scripts.whitepaper_autoresearch_runner.candidate_board_payloads import (
    _candidate_board_factor_acceptance_summary as _candidate_board_factor_acceptance_summary,
    _candidate_board_payload as _candidate_board_payload,
    _paper_probation_handoff_payload as _paper_probation_handoff_payload,
    _portfolio_with_runtime_closure_proof as _portfolio_with_runtime_closure_proof,
    _runtime_closure_program_for_candidate as _runtime_closure_program_for_candidate,
)
from scripts.whitepaper_autoresearch_runner.candidate_board_runtime_windows import (
    _candidate_board_hypothesis_manifest_ref as _candidate_board_hypothesis_manifest_ref,
    _candidate_board_runtime_window_bounds as _candidate_board_runtime_window_bounds,
    _candidate_board_date_only as _candidate_board_date_only,
    _candidate_board_regular_session_bound as _candidate_board_regular_session_bound,
    _candidate_board_runtime_window_import_bounds as _candidate_board_runtime_window_import_bounds,
    _candidate_board_exact_replay_ledger_refs as _candidate_board_exact_replay_ledger_refs,
    _candidate_board_runtime_import_args as _candidate_board_runtime_import_args,
    _candidate_board_runtime_window_import_plan as _candidate_board_runtime_window_import_plan,
    _candidate_factor_acceptance_replay_metadata as _candidate_factor_acceptance_replay_metadata,
)
from scripts.whitepaper_autoresearch_runner.candidate_board_summaries import (
    _candidate_board_rejected_signal_outcome_summary as _candidate_board_rejected_signal_outcome_summary,
    _candidate_spec_requires_order_type_execution_quality as _candidate_spec_requires_order_type_execution_quality,
    _candidate_spec_requires_predictability_decay_stress as _candidate_spec_requires_predictability_decay_stress,
    _candidate_board_predictability_decay_summary as _candidate_board_predictability_decay_summary,
    _candidate_board_scorecard_with_predictability_decay_blockers as _candidate_board_scorecard_with_predictability_decay_blockers,
    _candidate_board_order_type_execution_quality_summary as _candidate_board_order_type_execution_quality_summary,
    _candidate_board_scorecard_with_order_type_blockers as _candidate_board_scorecard_with_order_type_blockers,
    _candidate_spec_requires_queue_position_survival as _candidate_spec_requires_queue_position_survival,
    _candidate_board_queue_position_survival_summary as _candidate_board_queue_position_survival_summary,
    _candidate_board_scorecard_with_queue_position_survival_blockers as _candidate_board_scorecard_with_queue_position_survival_blockers,
    _candidate_board_scorecard_with_rejected_signal_blockers as _candidate_board_scorecard_with_rejected_signal_blockers,
    _candidate_board_evidence_lineage_summary as _candidate_board_evidence_lineage_summary,
    _candidate_board_scorecard_with_lineage_blockers as _candidate_board_scorecard_with_lineage_blockers,
    _candidate_board_replay_window_coverage_summary as _candidate_board_replay_window_coverage_summary,
    _candidate_board_market_impact_proof_summary as _candidate_board_market_impact_proof_summary,
    _candidate_board_regime_specialist_summary as _candidate_board_regime_specialist_summary,
    _candidate_board_scorecard_with_replay_window_blockers as _candidate_board_scorecard_with_replay_window_blockers,
    _candidate_board_scorecard_with_evidence_blockers as _candidate_board_scorecard_with_evidence_blockers,
)
from scripts.whitepaper_autoresearch_runner.candidate_board_status import (
    _candidate_board_blockers as _candidate_board_blockers,
    _candidate_board_status as _candidate_board_status,
    _candidate_board_activity_count as _candidate_board_activity_count,
    _candidate_board_oracle_blocker_count as _candidate_board_oracle_blocker_count,
    _candidate_board_net_pnl as _candidate_board_net_pnl,
    _candidate_board_lower_bound_net_pnl as _candidate_board_lower_bound_net_pnl,
    _candidate_board_target_progress_ratio as _candidate_board_target_progress_ratio,
    _candidate_board_required_notional_repair_scale as _candidate_board_required_notional_repair_scale,
    _candidate_board_best_executed_candidate as _candidate_board_best_executed_candidate,
    _candidate_board_closest_promotion_candidate as _candidate_board_closest_promotion_candidate,
    _candidate_board_paper_probation_admission_blockers as _candidate_board_paper_probation_admission_blockers,
)
from scripts.whitepaper_autoresearch_runner.common import (
    _CANDIDATE_BOARD_RUNTIME_SESSION_TZ as _CANDIDATE_BOARD_RUNTIME_SESSION_TZ,
    _CANDIDATE_BOARD_RUNTIME_SESSION_OPEN as _CANDIDATE_BOARD_RUNTIME_SESSION_OPEN,
    _CANDIDATE_BOARD_RUNTIME_SESSION_CLOSE as _CANDIDATE_BOARD_RUNTIME_SESSION_CLOSE,
    _PAPER_PROBATION_LIVE_PAPER_EVIDENCE_REQUIREMENTS as _PAPER_PROBATION_LIVE_PAPER_EVIDENCE_REQUIREMENTS,
    _PAPER_PROBATION_SAFE_EVIDENCE_COLLECTION_PATH as _PAPER_PROBATION_SAFE_EVIDENCE_COLLECTION_PATH,
    _SECOND_OOS_WINDOW_ID as _SECOND_OOS_WINDOW_ID,
    _RUNTIME_CLOSURE_PROOF_ORACLE_BLOCKERS as _RUNTIME_CLOSURE_PROOF_ORACLE_BLOCKERS,
    _resolve_existing_path as _resolve_existing_path,
    _stable_hash as _stable_hash,
    _decimal as _decimal,
    _decimal_payload as _decimal_payload,
    _mapping as _mapping,
    _string as _string,
    _list_of_mappings as _list_of_mappings,
    _sequence_of_mappings as _sequence_of_mappings,
    _rank_sort_value as _rank_sort_value,
    _proposal_sort_value as _proposal_sort_value,
    _string_list_from_value as _string_list_from_value,
    _candidate_board_runtime_ledger_lineage_handoff as _candidate_board_runtime_ledger_lineage_handoff,
    _candidate_board_runtime_ledger_required_materialized_artifacts as _candidate_board_runtime_ledger_required_materialized_artifacts,
    _candidate_spec_requires_rejected_signal_outcome_learning as _candidate_spec_requires_rejected_signal_outcome_learning,
    _boolish as _boolish,
    _oracle_blockers as _oracle_blockers,
)
from scripts.whitepaper_autoresearch_runner.runtime_closure import (
    _runtime_closure_payload as _runtime_closure_payload,
    _portfolio_needs_runtime_closure_proof as _portfolio_needs_runtime_closure_proof,
    _load_json_mapping_artifact as _load_json_mapping_artifact,
    _runtime_closure_artifact_refs as _runtime_closure_artifact_refs,
    _runtime_report_summary_int as _runtime_report_summary_int,
    _runtime_report_int as _runtime_report_int,
    _runtime_closure_ledger_datetime as _runtime_closure_ledger_datetime,
    _runtime_closure_exact_replay_bucket_range as _runtime_closure_exact_replay_bucket_range,
    _runtime_closure_replay_bucket_has_authority as _runtime_closure_replay_bucket_has_authority,
    _runtime_closure_exact_replay_bucket as _runtime_closure_exact_replay_bucket,
    _runtime_report_source_markers as _runtime_report_source_markers,
    _market_impact_default_source_markers as _market_impact_default_source_markers,
    _runtime_closure_start_equity as _runtime_closure_start_equity,
    _portfolio_executable_max_notional as _portfolio_executable_max_notional,
    _runtime_closure_exact_replay_ledger_update as _runtime_closure_exact_replay_ledger_update,
    _runtime_closure_market_impact_stress_update as _runtime_closure_market_impact_stress_update,
    _runtime_closure_delay_adjusted_depth_stress_update as _runtime_closure_delay_adjusted_depth_stress_update,
    _runtime_closure_double_oos_update as _runtime_closure_double_oos_update,
    _runtime_closure_scorecard_update as _runtime_closure_scorecard_update,
    _runtime_closure_pending_promotion_steps as _runtime_closure_pending_promotion_steps,
    _runtime_closure_promotion_prerequisite_blockers as _runtime_closure_promotion_prerequisite_blockers,
    _promotion_readiness_payload as _promotion_readiness_payload,
)

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

_DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC = 8

_DEFAULT_REAL_REPLAY_SHARD_TIMEOUT_SECONDS = 900

_DEFAULT_REAL_REPLAY_SHARD_WORKERS = 2

_DEFAULT_REAL_REPLAY_MAX_PARALLEL_FRONTIER_CANDIDATES = 6

_DEFAULT_FAST_REPLAY_PREVIEW_TOP_K = 48

_DEFAULT_FAST_REPLAY_EXACT_CANDIDATE_CAP = 6

_DEFAULT_FAST_REPLAY_EXPLOITATION_SLOTS = 4

_DEFAULT_FAST_REPLAY_EXPLORATION_SLOTS = 2

_DEFAULT_CLICKHOUSE_HTTP_URL = (
    "http://torghut-clickhouse.torghut.svc.cluster.local:8123"
)


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
        "--replay-tape-dataset-snapshot-ref",
        default="",
        help=(
            "Expected replay-tape dataset snapshot when reusing a tape. "
            "If set, fast-preview reuse fails closed when the manifest identity differs."
        ),
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


__all__ = [
    "_default_strategy_config_path",
    "_default_clickhouse_http_url",
    "_ranker_backend_preference",
    "_parse_args",
]
