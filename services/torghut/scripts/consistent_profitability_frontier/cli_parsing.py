#!/usr/bin/env python3
"""Search replay candidates using holdout fitness plus full-window consistency penalties."""

from __future__ import annotations

import argparse
import os
import socket
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


from app.trading.discovery.family_templates import (
    family_template_dir,
)
import scripts.local_intraday_tsmom_replay as replay_mod

from scripts.consistent_profitability_frontier.common import (
    _SECOND_OOS_WINDOW_ID as _SECOND_OOS_WINDOW_ID,
    FullWindowConsistencyPolicy as FullWindowConsistencyPolicy,
    OrderTypeAblationPolicy as OrderTypeAblationPolicy,
    _write_json_output as _write_json_output,
    _replay_tape_selection_metadata as _replay_tape_selection_metadata,
    _resolve_full_window as _resolve_full_window,
    _max_drawdown_from_daily_net as _max_drawdown_from_daily_net,
    _daily_filled_notional as _daily_filled_notional,
    _daily_liquidity_notional as _daily_liquidity_notional,
    _daily_decimal_metric as _daily_decimal_metric,
    _daily_int_metric as _daily_int_metric,
    _int_mapping as _int_mapping,
    _mapping as _mapping,
    _optional_decimal as _optional_decimal,
    _nonnegative_int_metric as _nonnegative_int_metric,
    _truthy_metric as _truthy_metric,
)
from scripts.consistent_profitability_frontier.ledger_order import (
    _order_lifecycle_metrics as _order_lifecycle_metrics,
    _order_type_execution_metrics as _order_type_execution_metrics,
    _normalized_order_type as _normalized_order_type,
    _selected_entry_order_type as _selected_entry_order_type,
    _forced_order_type_sample_count as _forced_order_type_sample_count,
    _payload_digest as _payload_digest,
    _artifact_run_dir_name as _artifact_run_dir_name,
    _order_type_ablation_artifact_dir as _order_type_ablation_artifact_dir,
    _frontier_ledger_text as _frontier_ledger_text,
    _frontier_ledger_datetime as _frontier_ledger_datetime,
    _frontier_exact_replay_bucket_range as _frontier_exact_replay_bucket_range,
    _frontier_exact_replay_rows as _frontier_exact_replay_rows,
    _frontier_exact_replay_bucket_has_authority as _frontier_exact_replay_bucket_has_authority,
    _frontier_exact_replay_bucket as _frontier_exact_replay_bucket,
    _exact_replay_ledger_artifact_update as _exact_replay_ledger_artifact_update,
    _order_type_replay_arm_summary as _order_type_replay_arm_summary,
    _order_type_ablation_payload as _order_type_ablation_payload,
)
from scripts.consistent_profitability_frontier.stress_metrics import (
    DELAY_ADJUSTED_DEPTH_STRESS_GRID_MS as DELAY_ADJUSTED_DEPTH_STRESS_GRID_MS,
    CONFORMAL_TAIL_RISK_ALPHA as CONFORMAL_TAIL_RISK_ALPHA,
    BREAKEVEN_TRANSACTION_COST_BUFFER_MIN_BPS as BREAKEVEN_TRANSACTION_COST_BUFFER_MIN_BPS,
    MARKET_IMPACT_STRESS_SOURCE_MARKERS as MARKET_IMPACT_STRESS_SOURCE_MARKERS,
    _p10 as _p10,
    _conformal_tail_loss_buffer as _conformal_tail_loss_buffer,
    _conformal_tail_risk_metrics as _conformal_tail_risk_metrics,
    _breakeven_transaction_cost_buffer_metrics as _breakeven_transaction_cost_buffer_metrics,
    _delay_depth_fillability as _delay_depth_fillability,
    _implementation_uncertainty_metrics as _implementation_uncertainty_metrics,
    _replay_stress_metrics as _replay_stress_metrics,
    _decimal_payload_metric as _decimal_payload_metric,
    _max_best_day_share_of_total_pnl as _max_best_day_share_of_total_pnl,
    _consistency_penalty as _consistency_penalty,
    _second_oos_summary as _second_oos_summary,
    _holdout_oos_passed as _holdout_oos_passed,
)
from scripts.consistent_profitability_frontier.frontier_payload import (
    _SAFE_EXACT_REPLAY_CANDIDATE_CAP as _SAFE_EXACT_REPLAY_CANDIDATE_CAP,
    _build_economic_shortlist as _build_economic_shortlist,
    _build_frontier_payload as _build_frontier_payload,
    _build_frontier_workflow_states as _build_frontier_workflow_states,
    _frontier_state_item as _frontier_state_item,
    _rank_scored_candidates as _rank_scored_candidates,
)
from scripts.consistent_profitability_frontier.paper_probation import (
    _PAPER_PROBATION_ACTIVITY_REPAIR_REASONS as _PAPER_PROBATION_ACTIVITY_REPAIR_REASONS,
    _PAPER_PROBATION_CAPITAL_REPAIR_REASONS as _PAPER_PROBATION_CAPITAL_REPAIR_REASONS,
    _PAPER_PROBATION_LIVE_PAPER_EVIDENCE_REQUIREMENTS as _PAPER_PROBATION_LIVE_PAPER_EVIDENCE_REQUIREMENTS,
    _PAPER_PROBATION_LOSS_REPAIR_REASONS as _PAPER_PROBATION_LOSS_REPAIR_REASONS,
    _PAPER_PROBATION_QUEUE_SURVIVAL_REASONS as _PAPER_PROBATION_QUEUE_SURVIVAL_REASONS,
    _PAPER_PROBATION_SAFE_EVIDENCE_COLLECTION_PATH as _PAPER_PROBATION_SAFE_EVIDENCE_COLLECTION_PATH,
    _PAPER_PROBATION_TAIL_RISK_REASONS as _PAPER_PROBATION_TAIL_RISK_REASONS,
    _PAPER_PROBATION_TARGET_SCALE_QUANTUM as _PAPER_PROBATION_TARGET_SCALE_QUANTUM,
    _bounded_sim_handoff_metadata as _bounded_sim_handoff_metadata,
    _build_paper_probation_shortlist as _build_paper_probation_shortlist,
    _candidate_artifact_refs as _candidate_artifact_refs,
    _candidate_exact_replay_ledger_artifact_refs as _candidate_exact_replay_ledger_artifact_refs,
    _candidate_exact_replay_parity_ok as _candidate_exact_replay_parity_ok,
    _candidate_handoff_diagnostics as _candidate_handoff_diagnostics,
    _candidate_metric_decimal as _candidate_metric_decimal,
    _candidate_metric_value as _candidate_metric_value,
    _candidate_post_cost_proof_blockers as _candidate_post_cost_proof_blockers,
    _candidate_replay_tape_metadata_blockers as _candidate_replay_tape_metadata_blockers,
    _candidate_runtime_ledger_count as _candidate_runtime_ledger_count,
    _candidate_source_lineage_ok as _candidate_source_lineage_ok,
    _paper_probation_notional_scale as _paper_probation_notional_scale,
    _paper_probation_notional_scale_decimal as _paper_probation_notional_scale_decimal,
    _paper_probation_repair_actions as _paper_probation_repair_actions,
    _paper_probation_repair_plan as _paper_probation_repair_plan,
    _paper_probation_required_actions as _paper_probation_required_actions,
    _paper_probation_target_notional_scale as _paper_probation_target_notional_scale,
    _paper_probation_target_progress as _paper_probation_target_progress,
    _safe_decimal as _safe_decimal,
)
from scripts.consistent_profitability_frontier.repair_math import (
    _LOSS_REPAIR_CAPITAL_SAFETY_BUFFER as _LOSS_REPAIR_CAPITAL_SAFETY_BUFFER,
    _LOSS_REPAIR_DEFAULT_EXPOSURE_SCALE as _LOSS_REPAIR_DEFAULT_EXPOSURE_SCALE,
    _LOSS_REPAIR_MIN_SCALE_QUANTUM as _LOSS_REPAIR_MIN_SCALE_QUANTUM,
    _capital_repair_exposure_scale as _capital_repair_exposure_scale,
    _decimal_or_none as _decimal_or_none,
    _decimal_payload as _decimal_payload,
    _reduced_exposure as _reduced_exposure,
    _tightened_bps as _tightened_bps,
)

_DEFAULT_STAGED_TRAIN_SCREEN_MULTIPLIER = 3


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Search replay configs using holdout profitability plus full-window consistency.",
    )
    parser.add_argument(
        "--strategy-configmap",
        type=Path,
        default=replay_mod.default_strategy_configmap_path(),
    )
    parser.add_argument(
        "--sweep-config",
        type=Path,
        default=Path("config/trading/profitability-frontier-consistent-tsmom.yaml"),
    )
    parser.add_argument(
        "--clickhouse-http-url",
        default=os.environ.get(
            "TA_CLICKHOUSE_URL",
            "http://torghut-clickhouse.torghut.svc.cluster.local:8123",
        ),
    )
    parser.add_argument(
        "--clickhouse-username",
        default=os.environ.get(
            "TA_CLICKHOUSE_USERNAME",
            os.environ.get("CLICKHOUSE_USERNAME", "torghut"),
        ),
    )
    parser.add_argument(
        "--clickhouse-password",
        default=os.environ.get(
            "TA_CLICKHOUSE_PASSWORD",
            os.environ.get("CLICKHOUSE_PASSWORD", ""),
        ),
    )
    parser.add_argument(
        "--clickhouse-password-env",
        default="",
        help="Environment variable that contains the ClickHouse password; ignored when --clickhouse-password is set.",
    )
    parser.add_argument("--start-equity", default="31590.02")
    parser.add_argument("--chunk-minutes", type=int, default=10)
    parser.add_argument("--symbols", default="")
    parser.add_argument("--progress-log-seconds", type=int, default=30)
    parser.add_argument("--train-days", type=int, default=6)
    parser.add_argument("--holdout-days", type=int, default=3)
    parser.add_argument(
        "--second-oos-days",
        type=int,
        default=0,
        help=(
            "Optional independent forward OOS replay days after holdout. "
            "When set, candidates must pass this separate window before they can be ranked as clean."
        ),
    )
    parser.add_argument("--full-window-start-date", default="")
    parser.add_argument("--full-window-end-date", default="")
    parser.add_argument(
        "--expected-last-trading-day",
        default="",
        help="Optional ISO date freshness witness. If omitted, recent sweeps expect the latest completed trading day.",
    )
    parser.add_argument(
        "--allow-stale-tape",
        action="store_true",
        help="Persist and continue even when the latest expected trading day is missing from PT1S tape.",
    )
    parser.add_argument(
        "--family-template-dir",
        type=Path,
        default=family_template_dir(),
    )
    parser.add_argument(
        "--prefetch-full-window-rows",
        action="store_true",
        help="Fetch full-window replay rows once and reuse them for every candidate replay.",
    )
    parser.add_argument(
        "--replay-tape-path",
        type=Path,
        help=(
            "Optional manifest-verified replay tape to reuse for exact scheduler-v3 replays. "
            "This replaces ClickHouse reads only; it does not make preview evidence promotable."
        ),
    )
    parser.add_argument(
        "--replay-tape-manifest",
        type=Path,
        help="Optional replay tape manifest path. Defaults to <replay-tape-path>.manifest.json.",
    )
    parser.add_argument("--top-n", type=int, default=10)
    parser.add_argument(
        "--max-candidates-to-evaluate",
        type=int,
        default=_SAFE_EXACT_REPLAY_CANDIDATE_CAP,
        help=(
            "Safe exact full-window replay candidate cap. Values <= 0 or above "
            f"{_SAFE_EXACT_REPLAY_CANDIDATE_CAP} resolve to the bounded default/cap; "
            "fast train preview may evaluate more candidates before this top shortlist."
        ),
    )
    parser.add_argument(
        "--staged-train-screen-multiplier",
        type=int,
        default=_DEFAULT_STAGED_TRAIN_SCREEN_MULTIPLIER,
        help=(
            "When train screening is enabled, allow this multiple of the expensive "
            "full-replay budget to be evaluated through the cheap train screen."
        ),
    )
    parser.add_argument(
        "--candidate-record",
        type=Path,
        action="append",
        default=[],
        help=(
            "Optional checked-in candidate record JSON to seed before the sweep grid. "
            "This replays known candidate params exactly before exploring variants."
        ),
    )
    parser.add_argument(
        "--capture-rejected-seed-full-window-ledger",
        action="store_true",
        help=(
            "For checked-in candidate-record seeds rejected by the train screen, "
            "still run a full-window exact replay ledger capture as proof-only evidence. "
            "The candidate remains train-screen rejected and non-promotable."
        ),
    )
    parser.add_argument(
        "--capture-positive-rejected-full-window-ledgers",
        dest="capture_positive_rejected_full_window_ledgers",
        type=int,
        default=0,
        help=(
            "Capture up to N proof-only full-window exact replay ledgers for "
            "positive train-screen rejects or candidates that pass the train "
            "screen after the full-replay budget is exhausted. Candidates remain "
            "blocked by their train/budget vetoes and non-promotable."
        ),
    )
    parser.add_argument(
        "--capture-top-rejected-full-window-ledgers",
        dest="capture_positive_rejected_full_window_ledgers",
        type=int,
        default=argparse.SUPPRESS,
        help=argparse.SUPPRESS,
    )
    parser.add_argument("--json-output", type=Path)
    parser.add_argument(
        "--symbol-prune-iterations",
        type=int,
        default=0,
        help="Greedily generate child candidates by removing downside-contributing symbols from replay attribution.",
    )
    parser.add_argument(
        "--symbol-prune-candidates",
        type=int,
        default=1,
        help="How many worst-contributing symbols to branch on per pruning step.",
    )
    parser.add_argument(
        "--symbol-prune-min-universe-size",
        type=int,
        default=2,
        help="Do not prune below this many symbols in the candidate universe.",
    )
    parser.add_argument(
        "--loss-repair-iterations",
        type=int,
        default=0,
        help=(
            "Generate bounded child candidates that tighten loss controls and exposure "
            "after drawdown or worst-day-loss vetoes."
        ),
    )
    parser.add_argument(
        "--loss-repair-candidates",
        type=int,
        default=1,
        help="How many loss/drawdown repair children to branch on per failed candidate.",
    )
    parser.add_argument(
        "--consistency-repair-iterations",
        type=int,
        default=0,
        help=(
            "Generate bounded child candidates that increase activity or breadth "
            "after positive capital-safe candidates fail consistency gates."
        ),
    )
    parser.add_argument(
        "--consistency-repair-candidates",
        type=int,
        default=2,
        help="How many consistency repair children to branch on per positive near-miss.",
    )
    parser.add_argument(
        "--train-screening",
        dest="train_screening",
        action="store_true",
        help="Skip holdout/full-window replay for candidates that fail the cheap train screen.",
    )
    parser.add_argument(
        "--no-train-screening",
        dest="train_screening",
        action="store_false",
        help="Disable cheap train-screen early rejection and always run all replay windows.",
    )
    parser.set_defaults(train_screening=True)
    parser.add_argument(
        "--min-train-screen-net-per-day",
        default="0",
        help="Minimum train net PnL/day required before holdout/full-window replay.",
    )
    parser.add_argument(
        "--min-train-screen-active-ratio",
        default="0.50",
        help="Minimum active train-day ratio required before holdout/full-window replay.",
    )
    parser.add_argument(
        "--max-train-screen-worst-day-loss",
        default="",
        help="Optional max train worst-day loss before holdout/full-window replay. Defaults to the consistency max worst-day loss.",
    )
    parser.add_argument(
        "--collect-train-gate-diagnostics",
        action="store_true",
        help="Capture aggregate train-window gate failure diagnostics in frontier candidates.",
    )
    return parser.parse_args()


def _clickhouse_host_requires_dns_preflight(url: str) -> bool:
    parsed = urlparse(url)
    host = parsed.hostname or ""
    return host.endswith(".svc") or host.endswith(".svc.cluster.local")


def _clickhouse_endpoint_preflight_failure(args: argparse.Namespace) -> str:
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


def _resolved_clickhouse_password(args: argparse.Namespace) -> str | None:
    direct_password = str(getattr(args, "clickhouse_password", "") or "").strip()
    if direct_password:
        return direct_password
    password_env = str(getattr(args, "clickhouse_password_env", "") or "").strip()
    if not password_env:
        return None
    return os.environ.get(password_env) or None


def _frontier_error_payload(exc: Exception) -> dict[str, Any]:
    message = str(exc)
    payload: dict[str, Any] = {
        "schema_version": "torghut.consistent-profitability-frontier-error.v1",
        "status": "error",
        "error_type": type(exc).__name__,
        "error": message,
    }
    if message.startswith("clickhouse_endpoint_"):
        payload["remediation"] = [
            "Run the frontier harness from an in-cluster pod.",
            "Set TA_CLICKHOUSE_URL or CLICKHOUSE_HTTP_URL to a reachable ClickHouse HTTP endpoint.",
            "Pass --clickhouse-http-url for a local port-forward or HTTP endpoint.",
            "Pass --replay-tape-path with a manifest-verified replay tape when ClickHouse is intentionally offline.",
        ]
    return payload


__all__ = [
    "_parse_args",
    "_clickhouse_host_requires_dns_preflight",
    "_clickhouse_endpoint_preflight_failure",
    "_resolved_clickhouse_password",
    "_frontier_error_payload",
]
