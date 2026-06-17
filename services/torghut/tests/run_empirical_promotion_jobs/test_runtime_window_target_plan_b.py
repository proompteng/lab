from __future__ import annotations

from tests.run_empirical_promotion_jobs.support import (
    MagicMock,
    Path,
    RunEmpiricalPromotionJobsTestCase,
    SimpleNamespace,
    json,
    patch,
    renewal,
)


class TestRunEmpiricalPromotionJobsRuntimeWindowTargetPlanB(
    RunEmpiricalPromotionJobsTestCase
):
    def test_runtime_window_target_plan_url_failures_are_fail_closed(self) -> None:
        with self.assertRaisesRegex(
            RuntimeError, "runtime_window_target_plan_url_empty"
        ):
            renewal._read_runtime_window_target_plan_url("", timeout_seconds=1.0)

        with (
            patch.object(
                renewal.urllib.request,
                "urlopen",
                side_effect=renewal.urllib.error.URLError("connection refused"),
            ),
            self.assertRaisesRegex(
                RuntimeError,
                "runtime_window_target_plan_url_fetch_failed",
            ),
        ):
            renewal._read_runtime_window_target_plan_url(
                "http://torghut.invalid/status",
                timeout_seconds=1.0,
            )

        response = MagicMock()
        response.__enter__.return_value.read.return_value = b"x" * 5_000_001
        with (
            patch.object(renewal.urllib.request, "urlopen", return_value=response),
            self.assertRaisesRegex(
                RuntimeError,
                "runtime_window_target_plan_url_too_large",
            ),
        ):
            renewal._read_runtime_window_target_plan_url(
                "http://torghut.invalid/status",
                timeout_seconds=1.0,
            )

        response = MagicMock()
        response.__enter__.return_value.read.return_value = b"{"
        with (
            patch.object(renewal.urllib.request, "urlopen", return_value=response),
            self.assertRaisesRegex(
                RuntimeError,
                "runtime_window_target_plan_url_invalid",
            ),
        ):
            renewal._read_runtime_window_target_plan_url(
                "http://torghut.invalid/status",
                timeout_seconds=1.0,
            )

        response = MagicMock()
        response.__enter__.return_value.read.return_value = b"[]"
        with (
            patch.object(renewal.urllib.request, "urlopen", return_value=response),
            self.assertRaisesRegex(
                RuntimeError,
                "runtime_window_target_plan_url_invalid",
            ),
        ):
            renewal._read_runtime_window_target_plan_url(
                "http://torghut.invalid/status",
                timeout_seconds=1.0,
            )

    def test_runtime_window_target_plan_url_retries_transport_failure(self) -> None:
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps(
            {
                "runtime_window_import_plan": {
                    "targets": [
                        {
                            "candidate_id": "cand-retry",
                            "hypothesis_id": "H-RETRY",
                        }
                    ]
                }
            }
        ).encode("utf-8")

        with (
            patch.object(
                renewal.urllib.request,
                "urlopen",
                side_effect=[
                    renewal.urllib.error.URLError("connection refused"),
                    response,
                ],
            ) as urlopen,
            patch.object(renewal.wall_time, "sleep") as sleep,
        ):
            plan = renewal._read_runtime_window_target_plan_url(
                "http://torghut.invalid/status",
                timeout_seconds=1.0,
                attempts=2,
                retry_backoff_seconds=0.0,
            )

        self.assertEqual(urlopen.call_count, 2)
        sleep.assert_called_once_with(0.0)
        self.assertEqual(plan["targets"][0]["candidate_id"], "cand-retry")

    def test_runtime_window_target_plan_url_retries_transient_empty_paper_route(
        self,
    ) -> None:
        transient = MagicMock()
        transient.__enter__.return_value.read.return_value = json.dumps(
            {
                "schema_version": "torghut.paper-route-evidence.v1",
                "summary": {"blockers": ["paper_probation_import_plan_missing"]},
                "runtime_window_import_audit": {
                    "state": "paper_probation_import_plan_missing",
                    "blockers": ["paper_probation_import_plan_missing"],
                },
                "live_submission_gate": {
                    "paper_route_target_plan_error": (
                        "paper_route_target_plan_fetch_failed:timed out"
                    ),
                    "runtime_ledger_paper_probation_import_plan": {
                        "targets": [],
                        "skipped_targets": [
                            {
                                "reason": "external_paper_route_target_plan_unavailable",
                                "missing_or_blocking_fields": [
                                    "paper_route_target_plan_fetch_failed:timed out"
                                ],
                            }
                        ],
                    },
                },
                "next_paper_route_runtime_window_targets": {
                    "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                    "target_count": 0,
                    "targets": [],
                },
            }
        ).encode("utf-8")
        success = MagicMock()
        success.__enter__.return_value.read.return_value = json.dumps(
            {
                "schema_version": "torghut.paper-route-evidence.v1",
                "next_paper_route_runtime_window_targets": {
                    "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                    "target_count": 1,
                    "targets": [
                        {
                            "candidate_id": "cand-paper-route",
                            "hypothesis_id": "H-PAPER-ROUTE",
                            "strategy_family": "microbar_pairs",
                            "strategy_name": "paper-route-candidate-v1",
                        }
                    ],
                },
            }
        ).encode("utf-8")

        with (
            patch.object(
                renewal.urllib.request,
                "urlopen",
                side_effect=[transient, success],
            ) as urlopen,
            patch.object(renewal.wall_time, "sleep") as sleep,
        ):
            plan = renewal._read_runtime_window_target_plan_url(
                "http://torghut.invalid/status",
                timeout_seconds=1.0,
                attempts=2,
                retry_backoff_seconds=0.0,
            )

        self.assertEqual(urlopen.call_count, 2)
        sleep.assert_called_once_with(0.0)
        self.assertEqual(
            plan["schema_version"],
            "torghut.next-paper-route-runtime-window-targets.v1",
        )
        self.assertEqual(plan["targets"][0]["candidate_id"], "cand-paper-route")

    def test_runtime_window_target_plan_required_stays_fail_closed_after_retries(
        self,
    ) -> None:
        transient = MagicMock()
        transient.__enter__.return_value.read.return_value = json.dumps(
            {
                "schema_version": "torghut.paper-route-evidence.v1",
                "summary": {"blockers": ["paper_probation_import_plan_missing"]},
                "live_submission_gate": {
                    "paper_route_target_plan_error": (
                        "paper_route_target_plan_fetch_failed:timed out"
                    )
                },
                "next_paper_route_runtime_window_targets": {
                    "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                    "target_count": 0,
                    "targets": [],
                },
            }
        ).encode("utf-8")
        args = SimpleNamespace(
            runtime_window_target=[],
            runtime_window_target_plan_ref=[],
            runtime_window_target_plan_url=["http://torghut.invalid/status"],
            runtime_window_target_plan_url_timeout_seconds=1.0,
            runtime_window_target_plan_url_attempts=2,
            runtime_window_target_plan_url_retry_backoff_seconds=0.0,
            runtime_window_target_plan_required=True,
            runtime_window_target_plan_exclusive=True,
            runtime_window_targets_from_latest_autoresearch=True,
            runtime_window_targets_from_registry=True,
        )

        with (
            patch.object(
                renewal.urllib.request,
                "urlopen",
                side_effect=[transient, transient],
            ) as urlopen,
            patch.object(renewal.wall_time, "sleep") as sleep,
            patch.object(
                renewal,
                "_latest_autoresearch_runtime_window_targets",
            ) as latest,
            patch.object(renewal, "_registry_runtime_window_targets") as registry,
            self.assertRaisesRegex(
                RuntimeError,
                "runtime_window_target_plan_required_but_empty",
            ),
        ):
            renewal._runtime_window_targets(args)

        self.assertEqual(urlopen.call_count, 2)
        sleep.assert_called_once_with(0.0)
        latest.assert_not_called()
        registry.assert_not_called()

    def test_runtime_window_targets_from_candidate_board_plan_preserve_probation_handoff(
        self,
    ) -> None:
        plan_path = Path(self.tmp_dir) / "candidate-board.json"
        plan_path.write_text(
            json.dumps(
                {
                    "runtime_window_import_plan": {
                        "schema_version": "torghut.runtime-window-import-plan.v1",
                        "targets": [
                            {
                                "candidate_spec_id": "spec-paper",
                                "candidate_id": "cand-paper-probation",
                                "hypothesis_id": "H-MICRO-01",
                                "observed_stage": "paper",
                                "strategy_family": "microstructure_breakout",
                                "strategy_name": "microbar-volume-continuation-long-top2-chip-v1",
                                "source_kind": "paper_runtime_observed",
                                "source_manifest_ref": "config/trading/hypotheses/h-micro-01.json",
                                "dataset_snapshot_ref": "snapshot-paper-probation",
                                "artifact_refs": [
                                    "proof/replay-summary.json",
                                    "proof/replay-summary.json",
                                    "",
                                ],
                                "candidate_selection": "oracle_recommended_paper_probation",
                                "replay_selection_reason": "paper_contract_exploration",
                                "paper_contract_candidate": True,
                                "paper_contract_selected_for_replay": True,
                                "paper_contract_prior_score": "31.5",
                                "paper_mechanism_overlay_ids": [
                                    "mixed_market_limit_execution_policy",
                                    "queue_position_survival_fill_curve",
                                ],
                                "paper_required_evidence_tokens": [
                                    "live_paper_parity",
                                    "route_tca",
                                    "runtime_ledger",
                                ],
                                "paper_required_evidence_count": 3,
                                "paper_probation_authorized": True,
                                "paper_probation_authorization_scope": "evidence_collection_only",
                                "evidence_collection_stage": "paper",
                                "probation_allowed": True,
                                "selection_reason": "best_lower_bound_candidate",
                                "promotion_allowed": False,
                                "final_promotion_authorized": False,
                                "final_promotion_allowed": False,
                                "final_promotion_blockers": [
                                    "runtime_ledger_pnl_basis_missing"
                                ],
                            }
                        ],
                    }
                }
            ),
            encoding="utf-8",
        )
        args = SimpleNamespace(
            runtime_window_target=[],
            runtime_window_target_plan_ref=[str(plan_path)],
            runtime_window_targets_from_registry=False,
            runtime_window_hypothesis_id="",
            runtime_window_candidate_id="",
            runtime_window_observed_stage="paper",
            runtime_window_strategy_family="",
            runtime_window_source_dsn_env="SIM_DB_DSN",
            runtime_window_strategy_name="",
            runtime_window_account_label="TORGHUT_SIM",
            runtime_window_dataset_snapshot_ref="",
            runtime_window_source_manifest_ref="",
            runtime_window_source_kind="paper_runtime_observed",
        )

        targets = renewal._runtime_window_targets(args)

        self.assertEqual(len(targets), 1)
        self.assertEqual(targets[0].artifact_refs, ("proof/replay-summary.json",))
        self.assertEqual(
            targets[0].target_metadata,
            {
                "candidate_spec_id": "spec-paper",
                "candidate_selection": "oracle_recommended_paper_probation",
                "replay_selection_reason": "paper_contract_exploration",
                "paper_contract_candidate": True,
                "paper_contract_selected_for_replay": True,
                "paper_contract_prior_score": "31.5",
                "paper_mechanism_overlay_ids": [
                    "mixed_market_limit_execution_policy",
                    "queue_position_survival_fill_curve",
                ],
                "paper_required_evidence_tokens": [
                    "live_paper_parity",
                    "route_tca",
                    "runtime_ledger",
                ],
                "paper_required_evidence_count": 3,
                "paper_probation_authorized": True,
                "paper_probation_authorization_scope": "evidence_collection_only",
                "evidence_collection_stage": "paper",
                "probation_allowed": True,
                "selection_reason": "best_lower_bound_candidate",
                "promotion_allowed": False,
                "final_promotion_authorized": False,
                "final_promotion_allowed": False,
                "final_promotion_blockers": ["runtime_ledger_pnl_basis_missing"],
            },
        )

    def test_runtime_window_targets_from_plan_preserve_exact_replay_artifact_handoff(
        self,
    ) -> None:
        plan_path = Path(self.tmp_dir) / "candidate-board.json"
        plan_path.write_text(
            json.dumps(
                {
                    "runtime_window_import_plan": {
                        "schema_version": "torghut.runtime-window-import-plan.v1",
                        "targets": [
                            {
                                "candidate_id": "cand-exact-replay",
                                "hypothesis_id": "H-PAIRS-01",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_cross_sectional_pairs",
                                "strategy_name": "microbar-cross-sectional-pairs-v1",
                                "source_kind": "simulation_exact_replay_runtime_ledger",
                                "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
                                "dataset_snapshot_ref": "snapshot-exact",
                                "artifact_refs": ["proof/replay-summary.json"],
                                "runtime_ledger_artifact_ref": "proof/exact-replay-ledger.json",
                                "runtime_ledger_artifact_row_count": 12,
                                "runtime_ledger_artifact_fill_count": 4,
                                "window_start": "2026-05-18T13:30:00Z",
                                "window_end": "2026-05-18T20:00:00Z",
                                "runtime_ledger_target_metadata_blockers": [
                                    "replay_artifact_only_not_live"
                                ],
                                "paper_probation_authorized": True,
                                "promotion_allowed": False,
                                "final_promotion_authorized": False,
                                "final_promotion_allowed": False,
                            }
                        ],
                    }
                }
            ),
            encoding="utf-8",
        )
        args = SimpleNamespace(
            runtime_window_target=[],
            runtime_window_target_plan_ref=[str(plan_path)],
            runtime_window_targets_from_registry=False,
            runtime_window_hypothesis_id="",
            runtime_window_candidate_id="",
            runtime_window_observed_stage="paper",
            runtime_window_strategy_family="",
            runtime_window_source_dsn_env="SIM_DB_DSN",
            runtime_window_strategy_name="",
            runtime_window_account_label="TORGHUT_SIM",
            runtime_window_dataset_snapshot_ref="",
            runtime_window_source_manifest_ref="",
            runtime_window_source_kind="paper_runtime_observed",
        )

        targets = renewal._runtime_window_targets(args)

        self.assertEqual(len(targets), 1)
        self.assertEqual(
            targets[0].artifact_refs,
            ("proof/replay-summary.json", "proof/exact-replay-ledger.json"),
        )
        self.assertEqual(targets[0].window_start, "2026-05-18T13:30:00Z")
        self.assertEqual(targets[0].window_end, "2026-05-18T20:00:00Z")
        assert targets[0].target_metadata is not None
        self.assertEqual(
            targets[0].target_metadata["runtime_ledger_artifact_ref"],
            "proof/exact-replay-ledger.json",
        )
        self.assertEqual(
            targets[0].target_metadata["runtime_ledger_artifact_row_count"],
            12,
        )
        self.assertEqual(
            targets[0].target_metadata["window_start"],
            "2026-05-18T13:30:00Z",
        )

    def test_runtime_window_targets_from_latest_autoresearch_epoch(self) -> None:
        args = SimpleNamespace(
            runtime_window_autoresearch_status=[],
            runtime_window_observed_stage="paper",
            runtime_window_source_dsn_env="SIM_DB_DSN",
            runtime_window_account_label="TORGHUT_SIM",
            runtime_window_dataset_snapshot_ref="",
            runtime_window_source_manifest_ref="",
            runtime_window_source_kind="paper_runtime_observed",
            runtime_window_delay_adjusted_depth_stress_report_ref="",
            runtime_window_hypothesis_id="",
            runtime_window_candidate_id="",
            runtime_window_strategy_family="",
            runtime_window_strategy_name="",
        )
        skipped_epoch = SimpleNamespace(
            epoch_id="epoch-running",
            status="running",
            summary_json={
                "candidate_board": {
                    "runtime_window_import_plan": {
                        "targets": [
                            {
                                "candidate_id": "cand-running",
                                "hypothesis_id": "H-TSMOM-01",
                                "strategy_family": "intraday_tsmom_consistent",
                                "strategy_name": "intraday-tsmom-profit-v3",
                            }
                        ]
                    }
                }
            },
        )
        latest_epoch = SimpleNamespace(
            epoch_id="epoch-paper-probation",
            status="no_profit_target_candidate",
            summary_json={
                "candidate_board": {
                    "runtime_window_import_plan": {
                        "targets": [
                            {
                                "candidate_id": "cand-paper-probation",
                                "hypothesis_id": "H-MICRO-01",
                                "strategy_family": "microstructure_breakout",
                                "strategy_name": "microbar-volume-continuation-long-top2-chip-v1",
                                "source_manifest_ref": "config/trading/hypotheses/h-micro-01.json",
                                "dataset_snapshot_ref": "snapshot-paper-probation",
                            }
                        ]
                    }
                }
            },
        )

        targets = renewal._runtime_window_targets_from_autoresearch_epochs(
            args=args,
            epochs=[skipped_epoch, latest_epoch],
        )

        self.assertEqual(len(targets), 1)
        self.assertEqual(targets[0].candidate_id, "cand-paper-probation")
        self.assertEqual(targets[0].hypothesis_id, "H-MICRO-01")
        self.assertEqual(targets[0].source_dsn_env, "SIM_DB_DSN")
        self.assertEqual(targets[0].dataset_snapshot_ref, "snapshot-paper-probation")

    def test_latest_autoresearch_targets_query_uses_persisted_candidate_board(
        self,
    ) -> None:
        epoch = SimpleNamespace(
            epoch_id="epoch-latest",
            status="ok",
            summary_json={
                "candidate_board": {
                    "runtime_window_import_plan": {
                        "targets": [
                            {
                                "candidate_id": "cand-latest",
                                "hypothesis_id": "H-TSMOM-01",
                                "strategy_family": "intraday_tsmom_consistent",
                                "strategy_name": "intraday-tsmom-profit-v3",
                            }
                        ]
                    }
                }
            },
        )

        class FakeResult:
            def scalars(self) -> "FakeResult":
                return self

            def all(self) -> list[SimpleNamespace]:
                return [epoch]

        class FakeSession:
            statement: object | None = None

            def __enter__(self) -> "FakeSession":
                return self

            def __exit__(self, *_args: object) -> None:
                return None

            def execute(self, statement: object) -> FakeResult:
                self.statement = statement
                return FakeResult()

        fake_session = FakeSession()
        args = SimpleNamespace(
            runtime_window_targets_from_latest_autoresearch=True,
            runtime_window_autoresearch_status=[],
            runtime_window_autoresearch_scan_limit=5,
            runtime_window_observed_stage="paper",
            runtime_window_source_dsn_env="SIM_DB_DSN",
            runtime_window_account_label="TORGHUT_SIM",
            runtime_window_dataset_snapshot_ref="",
            runtime_window_source_manifest_ref="",
            runtime_window_source_kind="paper_runtime_observed",
            runtime_window_delay_adjusted_depth_stress_report_ref="",
            runtime_window_hypothesis_id="",
            runtime_window_candidate_id="",
            runtime_window_strategy_family="",
            runtime_window_strategy_name="",
        )

        with patch.object(renewal, "SessionLocal", return_value=fake_session):
            targets = renewal._latest_autoresearch_runtime_window_targets(args)

        self.assertIsNotNone(fake_session.statement)
        self.assertEqual(len(targets), 1)
        self.assertEqual(targets[0].candidate_id, "cand-latest")

    def test_runtime_window_target_plan_errors_are_explicit(self) -> None:
        invalid_json_path = Path(self.tmp_dir) / "invalid-candidate-board.json"
        invalid_json_path.write_text("{", encoding="utf-8")
        empty_json_path = Path(self.tmp_dir) / "empty-candidate-board.json"
        empty_json_path.write_text("[]", encoding="utf-8")
        missing_targets_path = Path(self.tmp_dir) / "missing-targets-board.json"
        missing_targets_path.write_text(
            json.dumps({"runtime_window_import_plan": {"targets": "not-a-list"}}),
            encoding="utf-8",
        )
        invalid_target_path = Path(self.tmp_dir) / "invalid-target-board.json"
        invalid_target_path.write_text(
            json.dumps(
                {
                    "runtime_window_import_plan": {
                        "targets": [{"candidate_id": "cand-missing-fields"}]
                    }
                }
            ),
            encoding="utf-8",
        )
        cases = (
            (
                Path(self.tmp_dir) / "missing-candidate-board.json",
                "runtime_window_target_plan_ref_missing",
            ),
            (invalid_json_path, "runtime_window_target_plan_ref_invalid"),
            (empty_json_path, "runtime_window_target_plan_ref_invalid"),
            (missing_targets_path, "runtime_window_target_plan_targets_missing"),
            (invalid_target_path, "runtime_window_target_plan_target_invalid"),
        )
        args = SimpleNamespace(
            runtime_window_target=[],
            runtime_window_targets_from_registry=False,
            runtime_window_hypothesis_id="",
            runtime_window_candidate_id="",
            runtime_window_observed_stage="paper",
            runtime_window_strategy_family="",
            runtime_window_source_dsn_env="SIM_DB_DSN",
            runtime_window_strategy_name="",
            runtime_window_account_label="TORGHUT_SIM",
            runtime_window_dataset_snapshot_ref="",
            runtime_window_source_manifest_ref="",
            runtime_window_source_kind="paper_runtime_observed",
        )

        for path, message in cases:
            with self.subTest(path=path):
                args.runtime_window_target_plan_ref = [str(path)]
                with self.assertRaisesRegex(RuntimeError, message):
                    renewal._runtime_window_targets(args)

    def test_explicit_runtime_window_target_takes_precedence_over_plan(self) -> None:
        plan_path = Path(self.tmp_dir) / "candidate-board.json"
        plan_path.write_text(
            json.dumps(
                {
                    "runtime_window_import_plan": {
                        "targets": [
                            {
                                "candidate_id": "cand-from-plan",
                                "hypothesis_id": "H-MICRO-01",
                                "strategy_family": "microstructure_breakout",
                                "strategy_name": "microbar-volume-continuation-long-top2-chip-v1",
                            }
                        ],
                    }
                }
            ),
            encoding="utf-8",
        )
        args = SimpleNamespace(
            runtime_window_target=[
                (
                    "hypothesis_id=H-MICRO-01,candidate_id=cand-explicit,"
                    "strategy_family=microstructure_breakout,"
                    "strategy_name=microbar-volume-continuation-long-top2-chip-v1"
                )
            ],
            runtime_window_target_plan_ref=[str(plan_path)],
            runtime_window_targets_from_registry=False,
            runtime_window_hypothesis_id="",
            runtime_window_candidate_id="",
            runtime_window_observed_stage="paper",
            runtime_window_strategy_family="",
            runtime_window_source_dsn_env="SIM_DB_DSN",
            runtime_window_strategy_name="",
            runtime_window_account_label="TORGHUT_SIM",
            runtime_window_dataset_snapshot_ref="",
            runtime_window_source_manifest_ref="",
            runtime_window_source_kind="paper_runtime_observed",
        )

        targets = renewal._runtime_window_targets(args)

        self.assertEqual(len(targets), 1)
        self.assertEqual(targets[0].candidate_id, "cand-explicit")

    def test_runtime_window_targets_from_plan_keep_same_hypothesis_candidate_lanes(
        self,
    ) -> None:
        plan_path = Path(self.tmp_dir) / "candidate-board.json"
        plan_path.write_text(
            json.dumps(
                {
                    "runtime_window_import_plan": {
                        "targets": [
                            {
                                "candidate_id": "cand-plan-a",
                                "hypothesis_id": "H-MICRO-01",
                                "strategy_family": "microstructure_breakout",
                                "strategy_name": "microbar-volume-continuation-long-top2-chip-v1",
                            },
                            {
                                "candidate_id": "cand-plan-b",
                                "hypothesis_id": "H-MICRO-01",
                                "strategy_family": "microstructure_breakout",
                                "strategy_name": "microbar-volume-continuation-long-top2-chip-v1",
                            },
                        ],
                    }
                }
            ),
            encoding="utf-8",
        )
        args = SimpleNamespace(
            runtime_window_target=[],
            runtime_window_target_plan_ref=[str(plan_path)],
            runtime_window_targets_from_registry=False,
            runtime_window_hypothesis_id="",
            runtime_window_candidate_id="",
            runtime_window_observed_stage="paper",
            runtime_window_strategy_family="",
            runtime_window_source_dsn_env="SIM_DB_DSN",
            runtime_window_strategy_name="",
            runtime_window_account_label="TORGHUT_SIM",
            runtime_window_dataset_snapshot_ref="",
            runtime_window_source_manifest_ref="",
            runtime_window_source_kind="paper_runtime_observed",
        )

        targets = renewal._runtime_window_targets(args)

        self.assertEqual(
            [target.candidate_id for target in targets],
            ["cand-plan-a", "cand-plan-b"],
        )
        self.assertEqual(
            [target.hypothesis_id for target in targets],
            ["H-MICRO-01", "H-MICRO-01"],
        )

    def test_runtime_window_targets_from_registry_imports_all_hypotheses(
        self,
    ) -> None:
        hypothesis_dir = self.tmp_dir / "hypotheses"
        family_dir = self.tmp_dir / "families"
        hypothesis_dir.mkdir()
        family_dir.mkdir()
        (family_dir / "intraday_tsmom_v2.yaml").write_text(
            "\n".join(
                [
                    "family_id: intraday_tsmom_v2",
                    "runtime_harness:",
                    "  family: intraday_tsmom_consistent",
                    "  strategy_name: intraday-tsmom-profit-v3",
                ]
            ),
            encoding="utf-8",
        )
        (hypothesis_dir / "h-tsmom-01.json").write_text(
            json.dumps(
                {
                    "hypothesis_id": "H-TSMOM-01",
                    "strategy_family": "stale_family",
                    "strategy_id": "intraday_tsmom_v2@research",
                    "candidate_id": "spec-83161ae16d17828eabcc58cc",
                    "dataset_snapshot_ref": "portfolio-profit-autoresearch-500-v1",
                }
            ),
            encoding="utf-8",
        )
        (hypothesis_dir / "h-tsmom-liq-01.json").write_text(
            json.dumps(
                {
                    "hypothesis_id": "H-TSMOM-LIQ-01",
                    "strategy_family": "stale_family",
                    "strategy_id": "intraday_tsmom_v2@research",
                    "candidate_id": "H-TSMOM-LIQ-01",
                    "dataset_snapshot_ref": "portfolio-profit-autoresearch-500-v1",
                }
            ),
            encoding="utf-8",
        )
        (hypothesis_dir / "h-micro-01.json").write_text(
            json.dumps(
                {
                    "hypothesis_id": "H-MICRO-01",
                    "strategy_family": "microstructure_breakout",
                    "strategy_id": "microbar_volume_continuation_long_top2_chip_v1@paper",
                    "candidate_id": "chip-paper-microbar-composite@execution-proof",
                    "dataset_snapshot_ref": "torghut-chip-full-day-20260505-4c330ce9-r1",
                }
            ),
            encoding="utf-8",
        )
        (hypothesis_dir / "h-cont-01.json").write_text(
            json.dumps(
                {
                    "hypothesis_id": "H-CONT-01",
                    "strategy_family": "intraday_continuation",
                    "strategy_id": "microbar_volume_continuation_long_top2_chip_v1@paper",
                    "candidate_id": "chip-paper-microbar-composite@execution-proof",
                    "dataset_snapshot_ref": "torghut-chip-full-day-20260505-4c330ce9-r1",
                }
            ),
            encoding="utf-8",
        )
        args = SimpleNamespace(
            runtime_window_targets_from_registry=True,
            runtime_window_hypothesis_dir=str(hypothesis_dir),
            runtime_window_family_dir=str(family_dir),
            runtime_window_target=[],
            runtime_window_hypothesis_id="",
            runtime_window_candidate_id="",
            runtime_window_observed_stage="paper",
            runtime_window_strategy_family="",
            runtime_window_source_dsn_env="SIM_DB_DSN",
            runtime_window_strategy_name="",
            runtime_window_account_label="TORGHUT_SIM",
            runtime_window_dataset_snapshot_ref="",
            runtime_window_source_manifest_ref="",
            runtime_window_source_kind="paper_runtime_observed",
        )

        targets = renewal._runtime_window_targets(args)

        self.assertEqual(
            [target.hypothesis_id for target in targets],
            ["H-CONT-01", "H-MICRO-01", "H-TSMOM-01", "H-TSMOM-LIQ-01"],
        )
        by_id = {target.hypothesis_id: target for target in targets}
        self.assertEqual(
            by_id["H-CONT-01"].strategy_name,
            "microbar-volume-continuation-long-top2-chip-v1",
        )
        self.assertEqual(
            by_id["H-TSMOM-01"].strategy_name,
            "intraday-tsmom-profit-v3",
        )
        self.assertEqual(
            by_id["H-TSMOM-LIQ-01"].candidate_id,
            "H-TSMOM-LIQ-01",
        )
        self.assertEqual(
            by_id["H-TSMOM-LIQ-01"].strategy_name,
            "intraday-tsmom-profit-v3",
        )
        self.assertEqual(
            by_id["H-MICRO-01"].strategy_name,
            "microbar-volume-continuation-long-top2-chip-v1",
        )
        self.assertEqual(by_id["H-MICRO-01"].source_dsn_env, "SIM_DB_DSN")

    def test_runtime_window_target_rejects_invalid_specs(self) -> None:
        invalid_specs = [
            "{}",
            "hypothesis_id=H-PAIRS-01,strategy_name=pairs",
            "hypothesis_id=H-PAIRS-01,strategy_family=pairs",
            "hypothesis_id=H-PAIRS-01,bad-token",
            "hypothesis_id=H-PAIRS-01,strategy_family=,strategy_name=pairs",
            "[1, 2, 3]",
        ]
        args = SimpleNamespace(
            runtime_window_target=[],
            runtime_window_hypothesis_id="",
            runtime_window_candidate_id="",
            runtime_window_observed_stage="paper",
            runtime_window_strategy_family="",
            runtime_window_source_dsn_env="SIM_DB_DSN",
            runtime_window_strategy_name="",
            runtime_window_account_label="TORGHUT_SIM",
            runtime_window_dataset_snapshot_ref="portfolio-profit-autoresearch-500-v1",
            runtime_window_source_manifest_ref="",
            runtime_window_source_kind="paper_runtime_observed",
        )

        for spec in invalid_specs:
            with self.subTest(spec=spec):
                args.runtime_window_target = [spec]
                with self.assertRaises(RuntimeError):
                    renewal._runtime_window_targets(args)
