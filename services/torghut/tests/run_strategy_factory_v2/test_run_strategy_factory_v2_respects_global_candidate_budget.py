from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.run_strategy_factory_v2.support import (
    Namespace,
    Path,
    Session,
    TemporaryDirectory,
    VNextExperimentSpec,
    _TestRunStrategyFactoryV2Base,
    json,
    patch,
    runner,
    runpy,
    sys,
)


class TestRunStrategyFactoryV2RespectsGlobalCandidateBudget(
    _TestRunStrategyFactoryV2Base
):
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
