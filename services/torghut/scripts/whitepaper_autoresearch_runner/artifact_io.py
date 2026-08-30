#!/usr/bin/env python3
"""Run a whitepaper-driven autoresearch epoch targeting a portfolio profit objective."""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Mapping, Sequence
from urllib.parse import urlparse


from app.trading.discovery.candidate_specs import (
    LIVE_SIGNAL_COVERED_SEMICONDUCTOR_UNIVERSE,
)
from app.trading.discovery.whitepaper_autoresearch_notebooks import (
    write_whitepaper_autoresearch_diagnostics_notebook,
)


from scripts.whitepaper_autoresearch_runner.common import (
    _string,
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


__all__ = [
    "_write_json",
    "_write_jsonl",
    "_write_failure_summary",
    "_current_code_commit",
    "_resolved_clickhouse_password",
    "_clickhouse_host_requires_dns_preflight",
    "_clickhouse_endpoint_preflight_failure",
    "_candidate_universe_symbols_from_args",
    "_candidate_universe_symbols_for_compilation",
]
