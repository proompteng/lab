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


class TestRunStrategyFactoryV2(TestCase):
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

    def test_parse_args_and_helpers_cover_edge_cases(self) -> None:
        with TemporaryDirectory() as tmpdir:
            seed_dir = Path(tmpdir)
            (seed_dir / "profitability-frontier-consistent-invalid.yaml").write_text(
                "[]", encoding="utf-8"
            )
            (seed_dir / "profitability-frontier-consistent-other.yaml").write_text(
                yaml.safe_dump({"family_template_id": "other-family"}, sort_keys=False),
                encoding="utf-8",
            )
            (seed_dir / "profitability-frontier-strict-daily-fallback.yaml").write_text(
                yaml.safe_dump(
                    {"family_template_id": "strict-family"}, sort_keys=False
                ),
                encoding="utf-8",
            )
            with patch.object(
                sys,
                "argv",
                [
                    "run_strategy_factory_v2.py",
                    "--output-dir",
                    tmpdir,
                    "--experiment-id",
                    "exp-1",
                    "--paper-run-id",
                    "paper-1",
                    "--limit",
                    "2",
                    "--clickhouse-password-env",
                    "TORGHUT_CLICKHOUSE_PASSWORD",
                    "--allow-stale-tape",
                    "--prefetch-full-window-rows",
                    "--replay-tape-path",
                    str(seed_dir / "tape.jsonl"),
                    "--replay-tape-manifest",
                    str(seed_dir / "tape.manifest.json"),
                    "--staged-train-screen-multiplier",
                    "4",
                    "--capture-positive-rejected-full-window-ledgers",
                    "2",
                    "--symbol-prune-iterations",
                    "1",
                    "--symbol-prune-candidates",
                    "3",
                    "--symbol-prune-min-universe-size",
                    "5",
                    "--loss-repair-iterations",
                    "1",
                    "--loss-repair-candidates",
                    "2",
                    "--consistency-repair-iterations",
                    "1",
                    "--consistency-repair-candidates",
                    "4",
                    "--no-persist-results",
                ],
            ):
                parsed = runner._parse_args()
            missing_seed = runner._load_seed_sweep_config(
                "missing-family", seed_dir=seed_dir
            )
            fallback = runner._load_seed_sweep_config(
                "strict-family", seed_dir=seed_dir
            )

        self.assertEqual(parsed.output_dir, Path(tmpdir))
        self.assertEqual(parsed.experiment_id, ["exp-1"])
        self.assertEqual(parsed.paper_run_id, ["paper-1"])
        self.assertEqual(parsed.limit, 2)
        self.assertEqual(parsed.clickhouse_password_env, "TORGHUT_CLICKHOUSE_PASSWORD")
        self.assertTrue(parsed.allow_stale_tape)
        self.assertTrue(parsed.prefetch_full_window_rows)
        self.assertEqual(parsed.replay_tape_path, seed_dir / "tape.jsonl")
        self.assertEqual(parsed.replay_tape_manifest, seed_dir / "tape.manifest.json")
        self.assertEqual(parsed.staged_train_screen_multiplier, 4)
        self.assertEqual(parsed.capture_positive_rejected_full_window_ledgers, 2)
        self.assertEqual(parsed.symbol_prune_iterations, 1)
        self.assertEqual(parsed.symbol_prune_candidates, 3)
        self.assertEqual(parsed.symbol_prune_min_universe_size, 5)
        self.assertEqual(parsed.loss_repair_iterations, 1)
        self.assertEqual(parsed.loss_repair_candidates, 2)
        self.assertEqual(parsed.consistency_repair_iterations, 1)
        self.assertEqual(parsed.consistency_repair_candidates, 4)
        self.assertFalse(parsed.persist_results)
        self.assertEqual(runner._list_of_strings("not-a-list"), [])
        self.assertEqual(
            runner._coerce_decimal(Decimal("1.25"), default="0"), Decimal("1.25")
        )
        self.assertEqual(runner._coerce_decimal(7, default="0"), Decimal("7"))
        self.assertEqual(runner._coerce_ratio_days(ratio=Decimal("0"), total_days=5), 0)
        with patch.dict("os.environ", {"TORGHUT_CLICKHOUSE_PASSWORD": "from-env"}):
            self.assertEqual(
                runner._resolved_clickhouse_password(
                    Namespace(
                        clickhouse_password="",
                        clickhouse_password_env="TORGHUT_CLICKHOUSE_PASSWORD",
                    )
                ),
                "from-env",
            )
        self.assertIsNone(missing_seed)
        assert fallback is not None
        self.assertEqual(fallback["family_template_id"], "strict-family")

    def test_parse_args_prefers_clickhouse_http_url_env(self) -> None:
        with TemporaryDirectory() as tmpdir:
            with (
                patch.dict(
                    "os.environ",
                    {
                        "TA_CLICKHOUSE_URL": "jdbc:clickhouse://clickhouse/torghut",
                        "CLICKHOUSE_HTTP_URL": "http://127.0.0.1:8123",
                        "TA_CLICKHOUSE_USERNAME": "reader",
                    },
                ),
                patch.object(
                    sys,
                    "argv",
                    [
                        "run_strategy_factory_v2.py",
                        "--output-dir",
                        tmpdir,
                    ],
                ),
            ):
                parsed = runner._parse_args()

        self.assertEqual(parsed.clickhouse_http_url, "http://127.0.0.1:8123")
        self.assertEqual(parsed.clickhouse_username, "reader")

    def test_frontier_args_forwards_repair_and_proof_capture_controls(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            args = self._args(
                output_dir=root / "out",
                strategy_configmap=root / "strategy-configmap.yaml",
                family_template_dir=root / "families",
                seed_sweep_dir=root / "seed",
            )
            args.staged_train_screen_multiplier = 5
            args.capture_rejected_seed_full_window_ledger = True
            args.capture_positive_rejected_full_window_ledgers = 3
            args.symbol_prune_iterations = 1
            args.symbol_prune_candidates = 2
            args.symbol_prune_min_universe_size = 4
            args.loss_repair_iterations = 1
            args.loss_repair_candidates = 2
            args.consistency_repair_iterations = 1
            args.consistency_repair_candidates = 3

            frontier_args = runner._frontier_args(
                args=args,
                strategy_configmap=args.strategy_configmap,
                sweep_config=root / "compiled-sweep.yaml",
                json_output=root / "result.json",
            )

        self.assertEqual(frontier_args.staged_train_screen_multiplier, 5)
        self.assertTrue(frontier_args.capture_rejected_seed_full_window_ledger)
        self.assertEqual(frontier_args.capture_positive_rejected_full_window_ledgers, 3)
        self.assertEqual(frontier_args.symbol_prune_iterations, 1)
        self.assertEqual(frontier_args.symbol_prune_candidates, 2)
        self.assertEqual(frontier_args.symbol_prune_min_universe_size, 4)
        self.assertEqual(frontier_args.loss_repair_iterations, 1)
        self.assertEqual(frontier_args.loss_repair_candidates, 2)
        self.assertEqual(frontier_args.consistency_repair_iterations, 1)
        self.assertEqual(frontier_args.consistency_repair_candidates, 3)

    def test_frontier_args_forwards_replay_tape_paths(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            args = self._args(
                output_dir=root / "out",
                strategy_configmap=root / "strategy-configmap.yaml",
                family_template_dir=root / "families",
                seed_sweep_dir=root / "seed",
            )
            args.replay_tape_path = root / "tape.jsonl"
            args.replay_tape_manifest = root / "tape.manifest.json"

            frontier_args = runner._frontier_args(
                args=args,
                strategy_configmap=args.strategy_configmap,
                sweep_config=root / "compiled-sweep.yaml",
                json_output=root / "result.json",
            )

        self.assertEqual(
            frontier_args.replay_tape_path, (root / "tape.jsonl").resolve()
        )
        self.assertEqual(
            frontier_args.replay_tape_manifest,
            (root / "tape.manifest.json").resolve(),
        )

    def test_load_source_experiment_specs_applies_filters(self) -> None:
        with Session(self.engine) as session:
            session.add_all(
                [
                    VNextExperimentSpec(
                        run_id="paper-keep",
                        candidate_id=None,
                        experiment_id="exp-keep",
                        payload_json={"family_template_id": "breakout_reclaim_v2"},
                    ),
                    VNextExperimentSpec(
                        run_id="paper-other",
                        candidate_id=None,
                        experiment_id="exp-other",
                        payload_json={"family_template_id": "breakout_reclaim_v2"},
                    ),
                ]
            )
            session.commit()

        args = Namespace(
            experiment_id=["exp-keep"], paper_run_id=["paper-keep"], limit=10
        )
        with patch(
            "scripts.run_strategy_factory_v2.SessionLocal",
            side_effect=lambda: Session(self.engine),
        ):
            rows = runner._load_source_experiment_specs(args)

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].experiment_id, "exp-keep")
        self.assertEqual(rows[0].run_id, "paper-keep")

    def test_compile_sweep_config_raises_for_missing_template_or_runtime_harness(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            family_dir = root / "families"
            family_dir.mkdir()
            seed_dir = root / "seed"
            seed_dir.mkdir()
            (family_dir / "incomplete_family.yaml").write_text(
                yaml.safe_dump(
                    {
                        "schema_version": "torghut.family-template.v1",
                        "family_id": "incomplete_family",
                        "economic_mechanism": "Incomplete.",
                        "supported_markets": ["us_equities_intraday"],
                        "required_features": [],
                        "allowed_normalizations": ["price_scaled"],
                        "entry_motifs": ["breakout"],
                        "exit_motifs": ["stop"],
                        "risk_controls": ["stop_loss"],
                        "activity_model": {},
                        "liquidity_assumptions": {},
                        "regime_activation_rules": [],
                        "day_veto_rules": [],
                        "default_hard_vetoes": {},
                        "default_selection_objectives": {},
                        "runtime_harness": {},
                    },
                    sort_keys=False,
                ),
                encoding="utf-8",
            )

            missing_template_row = VNextExperimentSpec(
                run_id="paper-run-1",
                candidate_id=None,
                experiment_id="exp-missing-template",
                payload_json={},
            )
            with self.assertRaisesRegex(
                ValueError, "experiment_family_template_missing:exp-missing-template"
            ):
                runner._compile_sweep_config(
                    experiment_row=missing_template_row,
                    family_dir=family_dir,
                    seed_dir=seed_dir,
                    train_days=6,
                    holdout_days=3,
                )

            incomplete_runtime_row = VNextExperimentSpec(
                run_id="paper-run-2",
                candidate_id=None,
                experiment_id="exp-incomplete-runtime",
                payload_json={"family_template_id": "incomplete_family"},
            )
            with self.assertRaisesRegex(
                ValueError,
                "family_template_runtime_harness_incomplete:incomplete_family",
            ):
                runner._compile_sweep_config(
                    experiment_row=incomplete_runtime_row,
                    family_dir=family_dir,
                    seed_dir=seed_dir,
                    train_days=6,
                    holdout_days=3,
                )

    def test_whitepaper_profit_target_experiments_force_standalone_replay(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            family_template_dir = self._write_family_template(root)
            seed_sweep_dir = self._write_seed_sweep(root)
            seed_path = (
                seed_sweep_dir / "profitability-frontier-consistent-breakout.yaml"
            )
            seed_payload = yaml.safe_load(seed_path.read_text(encoding="utf-8"))
            seed_payload["disable_other_strategies"] = False
            seed_path.write_text(
                yaml.safe_dump(seed_payload, sort_keys=False),
                encoding="utf-8",
            )
            experiment_row = VNextExperimentSpec(
                run_id="paper-run-standalone",
                candidate_id=None,
                experiment_id="exp-standalone",
                payload_json={
                    "family_template_id": "breakout_reclaim_v2",
                    "selection_objectives": {"target_net_pnl_per_day": "500"},
                    "promotion_contract": {
                        "source": "whitepaper_autoresearch_profit_target",
                    },
                },
            )

            compiled = runner._compile_sweep_config(
                experiment_row=experiment_row,
                family_dir=family_template_dir,
                seed_dir=seed_sweep_dir,
                train_days=6,
                holdout_days=3,
            )

            self.assertTrue(compiled.sweep_config["disable_other_strategies"])

    def test_run_strategy_factory_v2_compiles_executes_and_persists(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            family_template_dir = self._write_family_template(root)
            seed_sweep_dir = self._write_seed_sweep(root)
            output_dir = root / "artifacts"
            output_dir.mkdir()

            with Session(self.engine) as session:
                session.add(
                    VNextExperimentSpec(
                        run_id="paper-run-1",
                        candidate_id=None,
                        experiment_id="exp-breakout-1",
                        payload_json={
                            "family_template_id": "breakout_reclaim_v2",
                            "paper_claim_links": ["claim-1"],
                            "selection_objectives": {
                                "target_net_pnl_per_day": "320",
                                "require_positive_day_ratio": "0.75",
                            },
                            "hard_vetoes": {
                                "required_min_active_day_ratio": "0.50",
                                "required_min_daily_notional": "210000",
                                "required_max_best_day_share": "0.45",
                                "required_max_worst_day_loss": "350",
                                "required_max_drawdown": "800",
                                "required_min_regime_slice_pass_rate": "0.55",
                            },
                            "template_overrides": {
                                "max_notional_per_trade": "50000",
                                "params": {
                                    "long_stop_loss_bps": "12",
                                },
                            },
                            "feature_variants": ["trading_value_scaled"],
                            "veto_controller_variants": [{"rule": "quote_quality"}],
                        },
                    )
                )
                session.commit()

            fake_payload = {
                "dataset_snapshot_receipt": {"snapshot_id": "snap-1"},
                "top": [
                    {
                        "candidate_id": "cand-1",
                        "full_window": {"net_per_day": "321.5"},
                    }
                ],
            }
            with (
                patch(
                    "scripts.run_strategy_factory_v2.SessionLocal",
                    side_effect=lambda: Session(self.engine),
                ),
                patch(
                    "scripts.run_strategy_factory_v2.run_consistent_profitability_frontier",
                    return_value=fake_payload,
                ) as mock_frontier,
            ):
                result = runner.run_strategy_factory_v2(
                    self._args(
                        output_dir=output_dir,
                        strategy_configmap=strategy_configmap,
                        family_template_dir=family_template_dir,
                        seed_sweep_dir=seed_sweep_dir,
                    )
                )

            self.assertEqual(result["status"], "ok")
            self.assertEqual(result["count"], 1)
            self.assertEqual(
                result["experiments"][0]["experiment_id"], "exp-breakout-1"
            )
            self.assertEqual(result["experiments"][0]["top_candidate_id"], "cand-1")
            self.assertEqual(result["experiments"][0]["dataset_snapshot_id"], "snap-1")
            self.assertFalse(
                result["experiments"][0]["promotion_readiness"]["promotable"]
            )
            self.assertEqual(
                result["experiments"][0]["promotion_readiness"][
                    "runtime_strategy_name"
                ],
                "breakout-continuation-long-v1",
            )
            mock_frontier.assert_called_once()

            compiled_sweep_path = output_dir / "exp-breakout-1" / "compiled-sweep.yaml"
            compiled = yaml.safe_load(compiled_sweep_path.read_text(encoding="utf-8"))
            self.assertEqual(compiled["family_template_id"], "breakout_reclaim_v2")
            self.assertEqual(compiled["family"], "breakout_continuation_consistent")
            self.assertEqual(compiled["strategy_name"], "breakout-continuation-long-v1")
            self.assertEqual(
                compiled["constraints"]["holdout_target_net_per_day"], "320"
            )
            self.assertEqual(compiled["consistency_constraints"]["min_active_days"], 5)
            self.assertEqual(
                compiled["consistency_constraints"]["min_positive_days"], 7
            )
            self.assertEqual(
                compiled["consistency_constraints"]["min_avg_filled_notional_per_day"],
                "210000",
            )
            self.assertEqual(
                compiled["strategy_overrides"]["normalization_regime"],
                ["trading_value_scaled"],
            )
            self.assertEqual(
                compiled["strategy_overrides"]["max_notional_per_trade"], ["50000"]
            )
            self.assertEqual(compiled["parameters"]["long_stop_loss_bps"], ["12"])
            self.assertEqual(
                compiled["parameters"]["position_isolation_mode"], ["per_strategy"]
            )
            self.assertEqual(
                compiled["experiment_spec"]["paper_claim_links"], ["claim-1"]
            )

            result_path = output_dir / "exp-breakout-1" / "result.json"
            self.assertEqual(
                json.loads(result_path.read_text(encoding="utf-8")), fake_payload
            )

            with Session(self.engine) as session:
                run_row = session.execute(
                    select(VNextExperimentRun).where(
                        VNextExperimentRun.experiment_id == "exp-breakout-1"
                    )
                ).scalar_one()
                self.assertEqual(run_row.candidate_id, "cand-1")
                persisted_spec = session.execute(
                    select(VNextExperimentSpec)
                    .where(VNextExperimentSpec.experiment_id == "exp-breakout-1")
                    .where(VNextExperimentSpec.run_id != "paper-run-1")
                ).scalar_one()
                self.assertEqual(persisted_spec.candidate_id, "cand-1")
                self.assertFalse(
                    persisted_spec.payload_json["promotion_readiness"]["promotable"]
                )
                self.assertEqual(
                    persisted_spec.payload_json["promotion_readiness"]["status"],
                    "blocked_pending_runtime_parity",
                )

    def test_persist_result_updates_existing_candidate_experiment_pair(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            family_template_dir = self._write_family_template(root)
            seed_sweep_dir = self._write_seed_sweep(root)
            output_dir = root / "artifacts"
            output_dir.mkdir()

            experiment_row = VNextExperimentSpec(
                run_id="paper-run-1",
                candidate_id=None,
                experiment_id="exp-breakout-1",
                payload_json={"family_template_id": "breakout_reclaim_v2"},
            )
            compiled = runner._compile_sweep_config(
                experiment_row=experiment_row,
                family_dir=family_template_dir,
                seed_dir=seed_sweep_dir,
                train_days=6,
                holdout_days=3,
            )
            duplicate_run_experiment = runner._compile_sweep_config(
                experiment_row=VNextExperimentSpec(
                    run_id="paper-run-1",
                    candidate_id=None,
                    experiment_id="exp-breakout-2",
                    payload_json={"family_template_id": "breakout_reclaim_v2"},
                ),
                family_dir=family_template_dir,
                seed_dir=seed_sweep_dir,
                train_days=6,
                holdout_days=3,
            )
            experiment_root = output_dir / compiled.experiment_id
            experiment_root.mkdir()
            compiled_sweep_path = experiment_root / "compiled-sweep.yaml"
            result_path = experiment_root / "result.json"
            result_payload = {
                "dataset_snapshot_receipt": {"snapshot_id": "snap-1"},
                "top": [
                    {
                        "candidate_id": "cand-duplicate",
                        "full_window": {"net_per_day": "501"},
                    }
                ],
            }

            with patch(
                "scripts.run_strategy_factory_v2.SessionLocal",
                side_effect=lambda: Session(self.engine),
            ):
                runner._persist_result(
                    runner_run_id="strategy-factory-v2-old",
                    experiment=compiled,
                    result_payload=result_payload,
                    compiled_sweep_path=compiled_sweep_path,
                    result_path=result_path,
                )
                runner._persist_result(
                    runner_run_id="strategy-factory-v2-new",
                    experiment=compiled,
                    result_payload=result_payload,
                    compiled_sweep_path=compiled_sweep_path,
                    result_path=result_path,
                )
                runner._persist_result(
                    runner_run_id="strategy-factory-v2-new",
                    experiment=duplicate_run_experiment,
                    result_payload=result_payload,
                    compiled_sweep_path=compiled_sweep_path,
                    result_path=result_path,
                )

            with Session(self.engine) as session:
                persisted_specs = (
                    session.execute(
                        select(VNextExperimentSpec).where(
                            VNextExperimentSpec.candidate_id == "cand-duplicate",
                            VNextExperimentSpec.experiment_id == "exp-breakout-1",
                        )
                    )
                    .scalars()
                    .all()
                )
                self.assertEqual(len(persisted_specs), 1)
                self.assertEqual(persisted_specs[0].run_id, "strategy-factory-v2-new")
                self.assertEqual(
                    persisted_specs[0].payload_json["runner_run_id"],
                    "strategy-factory-v2-new",
                )
                run_row = session.execute(
                    select(VNextExperimentRun).where(
                        VNextExperimentRun.candidate_id == "cand-duplicate",
                        VNextExperimentRun.run_id == "strategy-factory-v2-new",
                    )
                ).scalar_one()
                self.assertEqual(run_row.experiment_id, "exp-breakout-2")

    def test_persist_result_retries_transient_sqlalchemy_failure(self) -> None:
        transient_error = OperationalError(
            "insert into vnext_experiment_specs",
            {},
            Exception("server closed the connection unexpectedly"),
        )

        with (
            patch.object(
                runner,
                "_persist_result_once",
                side_effect=[transient_error, None],
            ) as mock_persist_once,
            patch("scripts.run_strategy_factory_v2.time.sleep") as mock_sleep,
        ):
            result = runner._persist_result(
                runner_run_id="strategy-factory-v2-retry",
                experiment=runner.CompiledExperimentSweep(
                    source_run_id="paper-run-1",
                    experiment_id="exp-breakout-1",
                    family_template=self._family_template_fixture(),
                    experiment_payload={"family_template_id": "breakout_reclaim_v2"},
                    sweep_config={},
                ),
                result_payload={"top": []},
                compiled_sweep_path=Path("compiled-sweep.yaml"),
                result_path=Path("result.json"),
            )

        self.assertEqual(result, {"status": "persisted", "attempt": 2})
        self.assertEqual(mock_persist_once.call_count, 2)
        mock_sleep.assert_called_once()

    def test_run_strategy_factory_v2_reports_persistence_warning_without_dropping_replay(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            family_template_dir = self._write_family_template(root)
            seed_sweep_dir = self._write_seed_sweep(root)
            output_dir = root / "artifacts"
            output_dir.mkdir()

            experiment_row = VNextExperimentSpec(
                run_id="paper-run-1",
                candidate_id=None,
                experiment_id="exp-breakout-1",
                payload_json={"family_template_id": "breakout_reclaim_v2"},
            )
            fake_payload = {
                "dataset_snapshot_receipt": {"snapshot_id": "snap-1"},
                "top": [
                    {
                        "candidate_id": "cand-1",
                        "full_window": {"net_per_day": "321.5"},
                    }
                ],
            }
            persistence_failure = {
                "status": "failed",
                "attempts": 3,
                "error_type": "OperationalError",
                "error": "server closed the connection unexpectedly",
            }

            with (
                patch(
                    "scripts.run_strategy_factory_v2.SessionLocal",
                    side_effect=lambda: Session(self.engine),
                ),
                patch(
                    "scripts.run_strategy_factory_v2._load_source_experiment_specs",
                    return_value=[experiment_row],
                ),
                patch(
                    "scripts.run_strategy_factory_v2.run_consistent_profitability_frontier",
                    return_value=fake_payload,
                ),
                patch(
                    "scripts.run_strategy_factory_v2._persist_result",
                    return_value=persistence_failure,
                ),
            ):
                result = runner.run_strategy_factory_v2(
                    self._args(
                        output_dir=output_dir,
                        strategy_configmap=strategy_configmap,
                        family_template_dir=family_template_dir,
                        seed_sweep_dir=seed_sweep_dir,
                    )
                )

        self.assertEqual(result["status"], "ok_with_persistence_warnings")
        self.assertFalse(result["persisted"])
        self.assertEqual(result["count"], 1)
        self.assertEqual(result["experiments"][0]["top_candidate_id"], "cand-1")
        self.assertEqual(
            result["experiments"][0]["persistence_status"], persistence_failure
        )
        self.assertEqual(
            result["persistence_failures"][0]["candidate_spec_id"], "exp-breakout-1"
        )

    def test_run_strategy_factory_v2_applies_replay_ledger_guidance_before_frontier(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            family_template_dir = self._write_family_template(root)
            seed_sweep_dir = self._write_seed_sweep(root)
            output_dir = root / "artifacts"
            output_dir.mkdir()

            experiment_row = runner.InMemoryExperimentSpec(
                run_id="paper-run-1",
                experiment_id="exp-breakout-guided",
                payload_json={
                    "family_template_id": "breakout_reclaim_v2",
                    "selection_objectives": {"target_net_pnl_per_day": "500"},
                    "template_overrides": {"params": {"max_entries_per_session": "1"}},
                    "exact_replay_ledger_remediation": {
                        "status": "blocked_pending_search_remediation",
                        "candidate_id": "cand-replay-blocked",
                        "promotion_blockers": ["avg_filled_notional_per_day_below_min"],
                        "runtime_ledger_blockers": [],
                        "recommended_search_actions": [{"required_multiplier": "2.0"}],
                    },
                },
            )

            observed_sweep_configs: list[dict[str, object]] = []

            def fake_frontier(args: Namespace) -> dict[str, object]:
                observed_sweep_configs.append(
                    yaml.safe_load(Path(args.sweep_config).read_text(encoding="utf-8"))
                )
                return {
                    "candidate_count": 2,
                    "dataset_snapshot_receipt": {"snapshot_id": "snap-guided"},
                    "top": [
                        {
                            "candidate_id": "cand-guided",
                            "full_window": {"net_per_day": "501"},
                        }
                    ],
                }

            with patch(
                "scripts.run_strategy_factory_v2.run_consistent_profitability_frontier",
                side_effect=fake_frontier,
            ):
                result = runner.run_strategy_factory_v2_from_specs(
                    Namespace(
                        **{
                            **vars(
                                self._args(
                                    output_dir=output_dir,
                                    strategy_configmap=strategy_configmap,
                                    family_template_dir=family_template_dir,
                                    seed_sweep_dir=seed_sweep_dir,
                                )
                            ),
                            "persist_results": False,
                        }
                    ),
                    source_specs=[experiment_row],
                )

        self.assertEqual(result["status"], "ok")
        self.assertEqual(
            result["experiments"][0]["replay_ledger_guided_actions"], ["breadth"]
        )
        compiled = observed_sweep_configs[0]
        self.assertEqual(compiled["parameters"]["max_entries_per_session"], ["1", "2"])
        self.assertEqual(
            compiled["metadata"]["replay_ledger_guided_search"]["source_candidate_id"],
            "cand-replay-blocked",
        )

    def test_run_strategy_factory_v2_respects_global_candidate_budget(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            family_template_dir = self._write_family_template(root)
            seed_sweep_dir = self._write_seed_sweep(root)
            output_dir = root / "artifacts"
            output_dir.mkdir()

            base_payload = {
                "family_template_id": "breakout_reclaim_v2",
                "paper_claim_links": ["claim-1"],
            }
            with Session(self.engine) as session:
                for index in range(3):
                    session.add(
                        VNextExperimentSpec(
                            run_id="paper-run-1",
                            candidate_id=None,
                            experiment_id=f"exp-breakout-{index}",
                            payload_json=base_payload,
                        )
                    )
                session.commit()

            observed_budgets: list[int] = []

            def fake_frontier(args: Namespace) -> dict[str, object]:
                observed_budgets.append(int(args.max_candidates_to_evaluate))
                return {
                    "candidate_count": int(args.max_candidates_to_evaluate),
                    "dataset_snapshot_receipt": {
                        "snapshot_id": f"snap-{len(observed_budgets)}"
                    },
                    "top": [
                        {
                            "candidate_id": f"cand-{len(observed_budgets)}",
                            "full_window": {"net_per_day": "1"},
                        }
                    ],
                }

            with (
                patch(
                    "scripts.run_strategy_factory_v2.SessionLocal",
                    side_effect=lambda: Session(self.engine),
                ),
                patch(
                    "scripts.run_strategy_factory_v2.run_consistent_profitability_frontier",
                    side_effect=fake_frontier,
                ),
            ):
                result = runner.run_strategy_factory_v2(
                    Namespace(
                        **{
                            **vars(
                                self._args(
                                    output_dir=output_dir,
                                    strategy_configmap=strategy_configmap,
                                    family_template_dir=family_template_dir,
                                    seed_sweep_dir=seed_sweep_dir,
                                )
                            ),
                            "max_candidates_to_evaluate": 2,
                            "max_total_candidates_to_evaluate": 3,
                            "persist_results": False,
                        }
                    )
                )

        self.assertEqual(observed_budgets, [2, 1])
        self.assertEqual(result["status"], "total_candidate_budget_exhausted")
        self.assertEqual(result["count"], 2)
        self.assertEqual(result["total_candidate_count"], 3)
        self.assertEqual(result["max_total_candidates_to_evaluate"], 3)
        self.assertEqual(
            [item["frontier_candidate_budget"] for item in result["experiments"]],
            [2, 1],
        )
        self.assertEqual(
            [item["frontier_candidate_count"] for item in result["experiments"]],
            [2, 1],
        )

    def test_run_strategy_factory_v2_returns_no_experiments_when_source_empty(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            family_template_dir = self._write_family_template(root)
            seed_sweep_dir = self._write_seed_sweep(root)
            with patch(
                "scripts.run_strategy_factory_v2.SessionLocal",
                side_effect=lambda: Session(self.engine),
            ):
                result = runner.run_strategy_factory_v2(
                    self._args(
                        output_dir=root / "artifacts",
                        strategy_configmap=strategy_configmap,
                        family_template_dir=family_template_dir,
                        seed_sweep_dir=seed_sweep_dir,
                    )
                )

        self.assertEqual(
            result, {"status": "no_experiments", "count": 0, "experiments": []}
        )

    def test_main_and_dunder_main_entrypoint(self) -> None:
        with (
            patch.object(runner, "_parse_args", return_value=Namespace()),
            patch.object(
                runner,
                "run_strategy_factory_v2",
                return_value={"status": "ok", "count": 0},
            ),
            patch("builtins.print") as mock_print,
        ):
            exit_code = runner.main()

        self.assertEqual(exit_code, 0)
        mock_print.assert_called_once_with(
            json.dumps({"status": "ok", "count": 0}, indent=2, sort_keys=True)
        )

        with (
            TemporaryDirectory() as tmpdir,
            patch(
                "app.db.SessionLocal",
                side_effect=lambda: Session(self.engine),
            ),
            patch.object(
                sys,
                "argv",
                [
                    str(Path(runner.__file__).resolve()),
                    "--output-dir",
                    tmpdir,
                    "--no-persist-results",
                ],
            ),
            patch("builtins.print") as mock_dunder_print,
        ):
            with self.assertRaises(SystemExit) as excinfo:
                runpy.run_path(
                    str(Path(runner.__file__).resolve()), run_name="__main__"
                )

        self.assertEqual(excinfo.exception.code, 0)
        mock_dunder_print.assert_called_once_with(
            json.dumps(
                {"status": "no_experiments", "count": 0, "experiments": []},
                indent=2,
                sort_keys=True,
            )
        )
