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
