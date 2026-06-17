from __future__ import annotations


import json
import runpy
import sys
from argparse import Namespace
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

import yaml
from sqlalchemy import create_engine, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

import scripts.run_strategy_factory_v2 as runner
from app.models import Base, VNextExperimentRun, VNextExperimentSpec
from app.trading.discovery.family_templates import FamilyTemplate


class _TestRunStrategyFactoryV2Base(TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(self.engine)

    def tearDown(self) -> None:
        self.engine.dispose()

    def _write_strategy_configmap(self, root: Path) -> Path:
        path = root / "strategy-configmap.yaml"
        path.write_text(
            yaml.safe_dump(
                {
                    "apiVersion": "v1",
                    "kind": "ConfigMap",
                    "data": {
                        "strategies.yaml": yaml.safe_dump(
                            {
                                "strategies": [
                                    {
                                        "name": "breakout-continuation-long-v1",
                                        "enabled": True,
                                        "params": {"existing_param": "1"},
                                    }
                                ]
                            },
                            sort_keys=False,
                        )
                    },
                },
                sort_keys=False,
            ),
            encoding="utf-8",
        )
        return path

    def _write_family_template(self, root: Path) -> Path:
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
                    "allowed_normalizations": ["price_scaled", "trading_value_scaled"],
                    "entry_motifs": ["breakout_reclaim"],
                    "exit_motifs": ["trailing_stop"],
                    "risk_controls": ["stop_loss"],
                    "activity_model": {
                        "min_active_day_ratio": "0.50",
                        "min_daily_notional": "200000",
                    },
                    "liquidity_assumptions": {"max_spread_bps": "30"},
                    "regime_activation_rules": [],
                    "day_veto_rules": [
                        {"rule": "quote_quality", "action": "block_day"}
                    ],
                    "default_hard_vetoes": {
                        "required_min_active_day_ratio": "0.50",
                        "required_min_daily_notional": "200000",
                        "required_max_best_day_share": "0.50",
                        "required_max_worst_day_loss": "400",
                        "required_max_drawdown": "900",
                        "required_min_regime_slice_pass_rate": "0.40",
                    },
                    "default_selection_objectives": {
                        "target_net_pnl_per_day": "300",
                        "require_positive_day_ratio": "0.60",
                    },
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
        return family_dir

    def _write_seed_sweep(self, root: Path) -> Path:
        seed_dir = root / "seed"
        seed_dir.mkdir()
        (seed_dir / "profitability-frontier-consistent-breakout.yaml").write_text(
            yaml.safe_dump(
                {
                    "schema_version": "torghut.replay-frontier-sweep.v1",
                    "family": "breakout_continuation_consistent",
                    "family_template_id": "breakout_reclaim_v2",
                    "strategy_name": "breakout-continuation-long-v1",
                    "disable_other_strategies": True,
                    "constraints": {"min_profit_factor": "1.10"},
                    "consistency_constraints": {"max_negative_days": 2},
                    "strategy_overrides": {
                        "universe_symbols": [["AMAT", "NVDA"]],
                    },
                    "parameters": {
                        "existing_param": ["1", "2"],
                    },
                },
                sort_keys=False,
            ),
            encoding="utf-8",
        )
        return seed_dir

    def _family_template_fixture(self) -> FamilyTemplate:
        return FamilyTemplate(
            family_id="breakout_reclaim_v2",
            economic_mechanism="Breakout reclaim.",
            supported_markets=("us_equities_intraday",),
            required_features=("quote_quality",),
            allowed_normalizations=("price_scaled",),
            entry_motifs=("breakout_reclaim",),
            exit_motifs=("trailing_stop",),
            risk_controls=("stop_loss",),
            activity_model={},
            liquidity_assumptions={},
            regime_activation_rules=(),
            day_veto_rules=(),
            default_hard_vetoes={},
            default_selection_objectives={},
            runtime_harness={
                "family": "breakout_continuation_consistent",
                "strategy_name": "breakout-continuation-long-v1",
                "disable_other_strategies": True,
            },
        )

    def _args(
        self,
        *,
        output_dir: Path,
        strategy_configmap: Path,
        family_template_dir: Path,
        seed_sweep_dir: Path,
    ) -> Namespace:
        return Namespace(
            output_dir=output_dir,
            experiment_id=[],
            paper_run_id=[],
            limit=10,
            strategy_configmap=strategy_configmap,
            family_template_dir=family_template_dir,
            seed_sweep_dir=seed_sweep_dir,
            clickhouse_http_url="http://example.invalid:8123",
            clickhouse_username="torghut",
            clickhouse_password="secret",
            clickhouse_password_env="",
            start_equity="31590.02",
            chunk_minutes=10,
            symbols="",
            progress_log_seconds=30,
            train_days=6,
            holdout_days=3,
            full_window_start_date="",
            full_window_end_date="",
            expected_last_trading_day="",
            allow_stale_tape=False,
            prefetch_full_window_rows=False,
            top_n=3,
            max_candidates_to_evaluate=0,
            max_total_candidates_to_evaluate=0,
            persist_results=True,
        )


__all__: tuple[str, ...] = ()

__all__: tuple[str, ...] = (
    "Base",
    "Decimal",
    "FamilyTemplate",
    "Namespace",
    "OperationalError",
    "Path",
    "Session",
    "TemporaryDirectory",
    "TestCase",
    "VNextExperimentRun",
    "VNextExperimentSpec",
    "_TestRunStrategyFactoryV2Base",
    "create_engine",
    "json",
    "patch",
    "runner",
    "runpy",
    "select",
    "sys",
    "yaml",
)
