from __future__ import annotations

# ruff: noqa: F401

import copy
import json
import sys
from argparse import Namespace
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

import yaml

import app.trading.discovery.autoresearch as autoresearch
from app.trading.discovery.autoresearch import (
    FamilyAutoresearchPlan,
    MutationSpace,
    StrategyObjective,
    apply_program_objective,
    build_mutated_sweep_config,
    candidate_meets_objective,
    load_strategy_autoresearch_program,
)
from app.trading.discovery.autoresearch_notebooks import (
    build_strategy_discovery_history_notebook,
    build_strategy_factory_history_notebook,
    write_autoresearch_notebooks,
    write_strategy_factory_notebooks,
)
from app.trading.discovery.family_templates import FamilyTemplate
from app.trading.models import SignalEnvelope
import scripts.search_consistent_profitability_frontier as frontier
import scripts.run_strategy_autoresearch_loop as runner


def _family_template() -> FamilyTemplate:
    return FamilyTemplate(
        family_id="breakout_reclaim_v2",
        economic_mechanism="Breakout reclaim.",
        supported_markets=("us_equities_intraday",),
        required_features=("quote_quality",),
        allowed_normalizations=("price_scaled", "opening_window_scaled"),
        entry_motifs=("breakout_reclaim",),
        exit_motifs=("trailing_stop",),
        risk_controls=("stop_loss",),
        activity_model={"min_active_day_ratio": "0.50", "min_daily_notional": "200000"},
        liquidity_assumptions={"max_spread_bps": "30"},
        regime_activation_rules=(),
        day_veto_rules=(),
        default_hard_vetoes={"required_max_best_day_share": "0.45"},
        default_selection_objectives={"target_net_pnl_per_day": "300"},
        runtime_harness={
            "family": "breakout_continuation_consistent",
            "strategy_name": "breakout-continuation-long-v1",
            "disable_other_strategies": True,
        },
    )


class StrategyAutoresearchTestCase(TestCase):
    def _write_program_fixture(self, root: Path) -> tuple[Path, Path]:
        family_dir = root / "families"
        family_dir.mkdir()
        (family_dir / "breakout_reclaim_v2.yaml").write_text(
            yaml.safe_dump(
                {
                    "schema_version": "torghut.family-template.v1",
                    "family_id": "breakout_reclaim_v2",
                    "economic_mechanism": "Breakout reclaim.",
                    "supported_markets": ["us_equities_intraday"],
                    "required_features": ["quote_quality"],
                    "allowed_normalizations": ["price_scaled", "opening_window_scaled"],
                    "entry_motifs": ["breakout_reclaim"],
                    "exit_motifs": ["trailing_stop"],
                    "risk_controls": ["stop_loss"],
                    "activity_model": {
                        "min_active_day_ratio": "0.50",
                        "min_daily_notional": "200000",
                    },
                    "liquidity_assumptions": {"max_spread_bps": "30"},
                    "regime_activation_rules": [],
                    "day_veto_rules": [],
                    "default_hard_vetoes": {"required_max_best_day_share": "0.45"},
                    "default_selection_objectives": {"target_net_pnl_per_day": "300"},
                    "runtime_harness": {
                        "family": "breakout_continuation_consistent",
                        "strategy_name": "breakout-continuation-long-v1",
                        "disable_other_strategies": True,
                    },
                },
                sort_keys=False,
            ),
            encoding="utf-8",
        )
        sweep_path = root / "profitability-frontier-consistent-breakout.yaml"
        sweep_path.write_text(
            yaml.safe_dump(
                {
                    "schema_version": "torghut.replay-frontier-sweep.v1",
                    "family": "breakout_continuation_consistent",
                    "family_template_id": "breakout_reclaim_v2",
                    "strategy_name": "breakout-continuation-long-v1",
                    "disable_other_strategies": True,
                    "constraints": {"holdout_target_net_per_day": "300"},
                    "consistency_constraints": {"target_net_per_day": "300"},
                    "strategy_overrides": {
                        "universe_symbols": [["AMAT", "NVDA"]],
                        "max_position_pct_equity": ["10.0"],
                    },
                    "parameters": {
                        "max_entries_per_session": ["2"],
                        "entry_cooldown_seconds": ["600"],
                    },
                },
                sort_keys=False,
            ),
            encoding="utf-8",
        )
        program_path = root / "program.yaml"
        program_path.write_text(
            yaml.safe_dump(
                {
                    "schema_version": "torghut.strategy-autoresearch.v1",
                    "program_id": "daily-profit",
                    "description": "Program fixture.",
                    "objective": {
                        "target_net_pnl_per_day": "500",
                        "min_active_day_ratio": "0.80",
                        "min_positive_day_ratio": "0.55",
                        "min_daily_notional": "300000",
                        "max_best_day_share": "0.35",
                        "max_worst_day_loss": "450",
                        "max_drawdown": "1000",
                        "min_regime_slice_pass_rate": "0.40",
                        "max_gross_exposure_pct_equity": "1.25",
                        "min_cash": "0",
                    },
                    "runtime_closure_policy": {
                        "enabled": False,
                        "execute_parity_replay": True,
                        "execute_approval_replay": True,
                        "parity_window": "full_window",
                        "approval_window": "holdout",
                        "shadow_validation_mode": "require_live_evidence",
                        "promotion_target": "shadow",
                    },
                    "research_sources": [
                        {
                            "source_id": "paper-1",
                            "title": "Paper 1",
                            "url": "https://example.com/paper-1",
                            "published_at": "2026-01-01",
                            "claims": [
                                {
                                    "claim_id": "claim-1",
                                    "summary": "Use realistic replay.",
                                    "implication": "Prefer day-level diagnostics.",
                                }
                            ],
                        }
                    ],
                    "families": [
                        {
                            "family_template_id": "breakout_reclaim_v2",
                            "seed_sweep_config": "./profitability-frontier-consistent-breakout.yaml",
                            "max_iterations": 2,
                            "keep_top_candidates": 1,
                            "frontier_top_n": 2,
                            "symbol_prune_iterations": 1,
                            "symbol_prune_candidates": 1,
                            "symbol_prune_min_universe_size": 2,
                            "loss_repair_iterations": 1,
                            "loss_repair_candidates": 1,
                            "consistency_repair_iterations": 1,
                            "consistency_repair_candidates": 2,
                            "parameter_mutations": {
                                "max_entries_per_session": {
                                    "mode": "numeric_step",
                                    "deltas": ["-1", "0", "1"],
                                    "minimum": "1",
                                    "maximum": "4",
                                }
                            },
                            "strategy_override_mutations": {
                                "normalization_regime": {
                                    "mode": "allowed_normalizations"
                                }
                            },
                        }
                    ],
                },
                sort_keys=False,
            ),
            encoding="utf-8",
        )
        return program_path, family_dir


__all__ = ("StrategyAutoresearchTestCase",)
