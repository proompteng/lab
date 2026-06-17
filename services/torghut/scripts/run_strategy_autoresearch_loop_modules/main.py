# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false
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

# ruff: noqa: F401,F811,F821

from .shared_context import (
    LatestCompleteWindowRequirement,
    WorkItem,
    _CAPITAL_LIMIT_SAFETY_MULTIPLIER,
    _DEFAULT_CLICKHOUSE_HTTP_URL,
    _REPO_ROOT,
    _apply_exact_replay_guidance_to_next_sweep,
    _apply_objective_capital_limits,
    _as_grid_values,
    _capped_numeric_grid,
    _decimal,
    _default_clickhouse_http_url,
    _default_clickhouse_password,
    _find_repo_root,
    _float,
    _format_decimal,
    _frontier_args,
    _frontier_candidate_budget,
    _iter_symbols,
    _json_clone,
    _keep_candidate_limit,
    _mapping,
    _max_entry_count,
    _maybe_decimal,
    _mlx_bundle_paths,
    _parse_args,
    _positive_decimal_grid_values,
    _promotion_readiness_payload,
    _runtime_missing_candidate_payload,
    _runtime_missing_frontier_payload,
    _slug,
    _snapshot_symbols,
    _string,
    _work_item_candidate_id,
)
from .load_yaml import (
    _default_full_window_day_count,
    _full_window_signal_config,
    _history_record,
    _iso_date,
    _latest_complete_window_requirement,
    _load_yaml,
    _maybe_materialize_run_replay_tape,
    _maybe_write_signal_bundle,
    _provided_replay_tape_receipt,
    _replay_tape_receipt,
    _replay_tape_source_query_digest,
    _sanitize_tsv_field,
    _write_history_jsonl,
)
from .write_results_tsv import (
    _best_history_record,
    _candidate_spec_id_for_portfolio_payload,
    _dedupe_nonempty_strings,
    _exact_replay_history_row,
    _exact_replay_runtime_window_blockers,
    _hypothesis_manifest_for_history_row,
    _hypothesis_manifest_rows,
    _portfolio_evidence_bundles_from_results,
    _portfolio_is_runtime_closure_candidate,
    _portfolio_objective_scorecard,
    _portfolio_oracle_policy,
    _portfolio_promotion_readiness,
    _research_ranking_net_pnl_per_day,
    _runtime_closure_candidate,
    _runtime_closure_pending_promotion_steps,
    _runtime_closure_promotion_prerequisite_blockers,
    _runtime_closure_subject,
    _strategy_autoresearch_runtime_window_import_plan,
    _strategy_name_from_strategy_id,
    _summary_promotion_readiness_for_outputs,
    _write_results_tsv,
)
from .write_portfolio_outputs import (
    _EXACT_REPLAY_EXECUTION_QUALITY_FIELDS,
    _best_experiment_snapshot,
    _exact_replay_candidate_for_payload,
    _exact_replay_ledger_paths,
    _exact_replay_ledger_refs,
    _exact_replay_ranking_by_candidate,
    _experiment_snapshot_from_payload,
    _live_progress_payload,
    _load_experiment_snapshots,
    _persist_run_outputs,
    _proposal_diagnostics,
    _resolve_run_artifact_ref,
    _with_exact_replay_execution_quality,
    _write_exact_replay_ledger_ranking,
    _write_exact_replay_ledger_remediation,
    _write_portfolio_outputs,
)
from .run_strategy_autoresearch_loop import run_strategy_autoresearch_loop


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


__all__ = ("main",)
