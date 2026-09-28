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

from scripts.consistent_profitability_frontier.frontier_payload import (
    _SAFE_EXACT_REPLAY_CANDIDATE_CAP,
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
