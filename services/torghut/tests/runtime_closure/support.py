from __future__ import annotations


import json
import subprocess
from importlib import import_module
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

import yaml

import app.trading.discovery.runtime_closure as runtime_closure
from app.trading.discovery.autoresearch import (
    ProposalModelPolicy,
    ReplayBudget,
    RuntimeClosurePolicy,
    SnapshotPolicy,
    StrategyAutoresearchProgram,
    StrategyObjective,
)
from app.trading.discovery.mlx_snapshot import build_mlx_snapshot_manifest
from app.trading.discovery.portfolio_candidates import (
    PORTFOLIO_CANDIDATE_SCHEMA_VERSION,
    PortfolioCandidateSpec,
)
from app.trading.discovery.runtime_closure import (
    RuntimeClosureExecutionContext,
    write_runtime_closure_bundle,
)

runtime_closure_candidate_payloads = import_module(
    "app.trading.discovery.runtime_closure_modules.candidate_payloads"
)
runtime_closure_replay_analysis = import_module(
    "app.trading.discovery.runtime_closure_modules.replay_analysis"
)

_REPO_ROOT = Path(__file__).resolve().parents[3]


def _program() -> StrategyAutoresearchProgram:
    return StrategyAutoresearchProgram(
        program_id="program-1",
        description="desc",
        objective=StrategyObjective(
            target_net_pnl_per_day=Decimal("500"),
            min_active_day_ratio=Decimal("1.0"),
            min_positive_day_ratio=Decimal("0.6"),
            min_daily_notional=Decimal("300000"),
            max_best_day_share=Decimal("0.3"),
            max_worst_day_loss=Decimal("350"),
            max_drawdown=Decimal("900"),
            require_every_day_active=True,
            min_regime_slice_pass_rate=Decimal("0.45"),
            stop_when_objective_met=True,
        ),
        snapshot_policy=SnapshotPolicy(
            bar_interval="PT1S",
            feature_set_id="torghut.mlx-autoresearch.v1",
            quote_quality_policy_id="scheduler_v3_default",
            symbol_policy="args_or_sweep",
            allow_prior_day_features=True,
            allow_cross_sectional_features=True,
        ),
        forbidden_mutations=("runtime_code_path",),
        proposal_model_policy=ProposalModelPolicy(
            enabled=True,
            mode="ranking_only",
            backend_preference="mlx",
            top_k=4,
            exploration_slots=1,
            minimum_history_rows=1,
        ),
        replay_budget=ReplayBudget(
            max_candidates_per_round=8,
            exploration_slots=1,
            max_candidates_per_frontier_run=16,
        ),
        runtime_closure_policy=RuntimeClosurePolicy(
            enabled=False,
            execute_parity_replay=True,
            execute_approval_replay=True,
            parity_window="full_window",
            approval_window="holdout",
            shadow_validation_mode="require_live_evidence",
            promotion_target="shadow",
        ),
        parity_requirements=("scheduler_v3_parity_replay",),
        promotion_policy="research_only",
        ledger_policy={"append_only": True},
        research_sources=(),
        families=(),
    )


class _TestRuntimeClosureBase(TestCase):
    pass


__all__ = (
    "json",
    "subprocess",
    "Decimal",
    "Path",
    "TemporaryDirectory",
    "patch",
    "runtime_closure",
    "runtime_closure_candidate_payloads",
    "runtime_closure_replay_analysis",
    "yaml",
    "ProposalModelPolicy",
    "ReplayBudget",
    "RuntimeClosurePolicy",
    "SnapshotPolicy",
    "StrategyAutoresearchProgram",
    "StrategyObjective",
    "build_mlx_snapshot_manifest",
    "PORTFOLIO_CANDIDATE_SCHEMA_VERSION",
    "PortfolioCandidateSpec",
    "RuntimeClosureExecutionContext",
    "write_runtime_closure_bundle",
    "_REPO_ROOT",
    "_program",
    "_TestRuntimeClosureBase",
)
