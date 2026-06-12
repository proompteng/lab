# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false
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

# ruff: noqa: F401,F403,F405,F811,F821

from .part_01_statements_97 import *
from .part_02_load_yaml import *
from .part_03_write_results_tsv import *
from .part_04_write_portfolio_outputs import *
from .part_05_run_strategy_autoresearch_loop import *


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


__all__ = [name for name in globals() if not name.startswith("__")]
