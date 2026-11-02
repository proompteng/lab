#!/usr/bin/env python3
"""Import observed paper/live runtime windows into doc29 governance tables."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Mapping, Sequence


from scripts.hypothesis_runtime_window_import.common import (
    _as_mapping,
    _metadata_symbol_list,
)

from scripts.hypothesis_runtime_window_import.source_activity_context import (
    _source_activity_diagnostics_blockers,
)


def _source_activity_missing_summary(
    *,
    run_id: str,
    candidate_id: str,
    hypothesis_id: str,
    observed_stage: str,
    strategy_name: str,
    strategy_names: list[str],
    account_label: str,
    source_account_label: str | None = None,
    window_start: datetime,
    window_end: datetime,
    source_manifest_ref: str,
    source_kind: str,
    dataset_snapshot_ref: str | None,
    source_activity_symbols: Sequence[str] | None = None,
    target_metadata: Mapping[str, Any] | None = None,
    proof_hygiene_blockers: Sequence[str] = (),
    source_activity_diagnostics: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    metadata = _as_mapping(target_metadata)
    symbol_filter = _metadata_symbol_list(source_activity_symbols or ())
    diagnostics = _as_mapping(source_activity_diagnostics)
    diagnostic_blockers = _source_activity_diagnostics_blockers(diagnostics)
    blocker = {
        "blocker": "runtime_window_source_activity_missing",
        "hypothesis_id": hypothesis_id,
        "candidate_id": candidate_id or None,
        "strategy_name": strategy_name,
        "strategy_name_candidates": strategy_names,
        "account_label": account_label,
        "source_account_label": source_account_label or account_label,
        "source_activity_symbol_filter": symbol_filter,
        "diagnostic_blockers": diagnostic_blockers,
        "source_activity_diagnostics": diagnostics,
        "window_start": window_start.isoformat(),
        "window_end": window_end.isoformat(),
        "remediation": (
            "Run live-paper replay or route repair until the source database contains "
            "execution-eligible trade_decisions, executions, and source-backed runtime-ledger rows for this target "
            "before importing promotion evidence."
        ),
    }
    proof_blockers = [blocker]
    for reason in proof_hygiene_blockers:
        proof_blockers.append(
            {
                "blocker": reason,
                "hypothesis_id": hypothesis_id,
                "candidate_id": candidate_id or None,
                "observed_stage": observed_stage,
                "window_start": window_start.isoformat(),
                "window_end": window_end.isoformat(),
                "remediation": (
                    "Provide explicit runtime-window target metadata and health-gate "
                    "inputs before treating this import as proof-grade evidence."
                ),
            }
        )
    return {
        "status": "skipped",
        "proof_status": "blocked",
        "proof_blockers": proof_blockers,
        "run_id": run_id,
        "candidate_id": candidate_id or None,
        "hypothesis_id": hypothesis_id,
        "observed_stage": observed_stage,
        "window_count": 0,
        "market_session_samples": 0,
        "decision_count": 0,
        "trade_count": 0,
        "order_count": 0,
        "avg_abs_slippage_bps": "0",
        "avg_post_cost_expectancy_bps": "0",
        "promotion_allowed": False,
        "promotion_blocking_reasons": list(
            dict.fromkeys(
                [
                    "runtime_window_source_activity_missing",
                    *diagnostic_blockers,
                ]
            )
        ),
        "source_activity_diagnostics": diagnostics,
        "runtime_observation": {
            "authoritative": False,
            "observed_stage": observed_stage,
            "evidence_provenance": (
                "paper_runtime_observed"
                if observed_stage == "paper"
                else "live_runtime_observed"
            ),
            "source_kind": source_kind
            or (
                "simulation_paper_runtime"
                if observed_stage == "paper"
                else "live_runtime"
            ),
            "source_manifest_ref": source_manifest_ref or None,
            "strategy_name": strategy_name,
            "strategy_name_candidates": strategy_names,
            "account_label": account_label,
            "source_account_label": source_account_label or account_label,
            "source_activity_symbol_filter": symbol_filter,
            "window_start": window_start.isoformat(),
            "window_end": window_end.isoformat(),
            "dataset_snapshot_ref": dataset_snapshot_ref,
            "target_metadata": metadata,
            "source_activity_diagnostics": diagnostics,
            "source_activity_diagnostic_blockers": diagnostic_blockers,
            "skip_reason": "runtime_window_source_activity_missing",
        },
    }


__all__ = [
    "_source_activity_missing_summary",
]
