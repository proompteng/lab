from __future__ import annotations

# ruff: noqa: F403,F405
from tests.runtime_window_import.runtime_window_import_base import *


class TestRuntimeWindowImportMainA(RuntimeWindowImportTestCaseBase):
    def test_main_rejects_artifact_refs_without_exact_runtime_ledger_rows(self) -> None:
        with TemporaryDirectory() as temp_dir:
            artifact_path = Path(temp_dir) / "malformed-rows.json"
            artifact_path.write_text(
                json.dumps(
                    {
                        "schema_version": "torghut.exact_replay_ledger.rows.v1",
                        "runtime_ledger_rows": {"bad": "shape"},
                    }
                ),
                encoding="utf-8",
            )
            args = SimpleNamespace(
                run_id="run-empty-ledger-artifact",
                candidate_id="H-TSMOM-LIQ-01",
                hypothesis_id="H-TSMOM-LIQ-01",
                observed_stage="paper",
                strategy_family="intraday_tsmom_consistent",
                source_dsn="",
                source_dsn_env="DB_DSN",
                strategy_name="intraday-tsmom-profit-v3",
                account_label="TORGHUT_SIM",
                window_start="2026-03-06T14:30:00Z",
                window_end="2026-03-06T15:00:00Z",
                bucket_minutes=30,
                sample_minutes=5,
                source_manifest_ref="config/trading/hypotheses/h-tsmom-liq-01.json",
                source_kind="paper_runtime_observed",
                artifact_ref=[str(artifact_path)],
                delay_adjusted_depth_stress_report_ref="",
                dataset_snapshot_ref="runtime-ledger-empty-artifact-snapshot",
                target_metadata_json="",
                dependency_quorum_decision="allow",
                continuity_ok="true",
                drift_ok="true",
                json=False,
            )
            manifest = SimpleNamespace(
                strategy_family="intraday_tsmom_consistent",
                strategy_id="intraday_tsmom_v2@research",
                max_allowed_slippage_bps=Decimal("6"),
            )

            with (
                patch(
                    "scripts.import_hypothesis_runtime_windows._parse_args",
                    return_value=args,
                ),
                patch(
                    "scripts.import_hypothesis_runtime_windows.resolve_hypothesis_manifest",
                    return_value=(
                        SimpleNamespace(
                            path="config/trading/hypotheses/h-tsmom-liq-01.json"
                        ),
                        manifest,
                    ),
                ),
                patch(
                    "scripts.import_hypothesis_runtime_windows._runtime_ledger_tca_rows_from_durable_buckets",
                    return_value=(
                        [],
                        {
                            "runtime_ledger_durable_bucket_count": 0,
                            "runtime_ledger_durable_bucket_run_ids": [],
                            "runtime_ledger_durable_bucket_fill_count": 0,
                            "runtime_ledger_durable_bucket_tca_row_count": 0,
                            "runtime_ledger_durable_bucket_profit_proof_count": 0,
                        },
                    ),
                ),
                patch(
                    "scripts.import_hypothesis_runtime_windows.SessionLocal",
                    return_value=_FakeSession(),
                ),
                patch.dict("os.environ", {}, clear=True),
            ):
                with self.assertRaisesRegex(RuntimeError, "source_dsn_not_configured"):
                    main()

    def test_main_preserves_registry_manifest_fallback_when_source_manifest_ref_missing(
        self,
    ) -> None:
        args = SimpleNamespace(
            run_id="run-1",
            candidate_id="cand-1",
            hypothesis_id="H-CONT-01",
            observed_stage="paper",
            strategy_family="",
            source_dsn="postgresql://example",
            source_dsn_env="DB_DSN",
            strategy_name="intraday-tsmom-profit-v2",
            account_label="TORGHUT_SIM",
            window_start="2026-03-06T14:30:00Z",
            window_end="2026-03-06T15:00:00Z",
            bucket_minutes=30,
            sample_minutes=5,
            source_manifest_ref="",
            source_kind="simulation_paper_runtime",
            artifact_ref=[],
            dependency_quorum_decision="allow",
            continuity_ok="true",
            drift_ok="true",
            json=False,
        )
        fake_session = _FakeSession()
        manifest = SimpleNamespace(
            strategy_family="intraday_continuation",
            strategy_id="intraday_tsmom_v1@paper",
            max_allowed_slippage_bps=Decimal("12"),
        )

        with (
            patch(
                "scripts.import_hypothesis_runtime_windows._parse_args",
                return_value=args,
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.resolve_hypothesis_manifest",
                return_value=(
                    SimpleNamespace(path="config/trading/hypotheses/h-cont-01.json"),
                    manifest,
                ),
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows._query_timestamps",
                return_value=(
                    [datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc)],
                    [datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc)],
                    [],
                ),
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.build_regular_session_buckets",
                return_value=[],
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.build_observed_runtime_buckets",
                return_value=[],
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.persist_observed_runtime_windows",
                return_value={"run_id": "run-1"},
            ) as persist_windows,
            patch(
                "scripts.import_hypothesis_runtime_windows.SessionLocal",
                return_value=fake_session,
            ),
            patch("builtins.print"),
        ):
            exit_code = main()

        self.assertEqual(exit_code, 0)
        self.assertTrue(fake_session.committed)
        self.assertEqual(persist_windows.call_args.kwargs["source_manifest_ref"], None)
        runtime_payload = persist_windows.call_args.kwargs[
            "runtime_observation_payload"
        ]
        self.assertEqual(runtime_payload["dataset_snapshot_ref"], None)
        self.assertEqual(
            runtime_payload["strategy_name_candidates"],
            [
                "intraday-tsmom-profit-v2",
                "intraday_tsmom_v1@paper",
                "intraday_tsmom_v1",
                "intraday-tsmom-v1@paper",
                "intraday-tsmom-v1",
            ],
        )

    def test_main_audit_only_reports_source_to_ledger_path_without_persisting(
        self,
    ) -> None:
        args = SimpleNamespace(
            run_id="run-audit",
            candidate_id="cand-audit",
            hypothesis_id="H-CONT-01",
            observed_stage="paper",
            strategy_family="",
            source_dsn="postgresql://example",
            source_dsn_env="DB_DSN",
            strategy_name="intraday-tsmom-profit-v2",
            account_label="TORGHUT_SIM",
            source_account_label="TORGHUT_SIM",
            window_start="2026-03-06T14:30:00Z",
            window_end="2026-03-06T15:00:00Z",
            bucket_minutes=30,
            sample_minutes=5,
            source_manifest_ref="",
            source_kind="paper_runtime_observed",
            artifact_ref=[],
            delay_adjusted_depth_stress_report_ref="",
            dataset_snapshot_ref="runtime-audit-snapshot",
            target_metadata_json="",
            dependency_quorum_decision="allow",
            continuity_ok="true",
            drift_ok="true",
            audit_only=True,
            json=True,
        )
        manifest = SimpleNamespace(
            strategy_family="intraday_continuation",
            strategy_id="intraday_tsmom_v1@paper",
            max_allowed_slippage_bps=Decimal("12"),
        )
        runtime_bucket = _complete_runtime_ledger_bucket()
        tca_row = {
            "computed_at": datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
            "abs_slippage_bps": Decimal("1"),
            "post_cost_expectancy_bps": Decimal("40"),
            "post_cost_expectancy_basis": POST_COST_BASIS_RUNTIME_LEDGER,
            "post_cost_promotion_eligible": True,
            "source_decision_mode": "strategy_signal_paper",
            "runtime_ledger_bucket": runtime_bucket,
        }

        with (
            patch(
                "scripts.import_hypothesis_runtime_windows._parse_args",
                return_value=args,
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.resolve_hypothesis_manifest",
                return_value=(
                    SimpleNamespace(path="config/trading/hypotheses/h-cont-01.json"),
                    manifest,
                ),
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows._query_timestamps",
                return_value=(
                    [datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc)],
                    [datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc)],
                    [tca_row],
                ),
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows._runtime_ledger_tca_rows_from_source_dsn",
                return_value=(
                    [],
                    {
                        "runtime_ledger_source_bucket_count": 0,
                        "runtime_ledger_source_bucket_run_ids": [],
                        "runtime_ledger_source_bucket_fill_count": 0,
                        "runtime_ledger_source_bucket_tca_row_count": 0,
                        "runtime_ledger_source_bucket_profit_proof_count": 0,
                    },
                ),
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.build_regular_session_buckets",
                return_value=[
                    (
                        datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                        datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                        6,
                    )
                ],
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.build_observed_runtime_buckets",
                return_value=[
                    SimpleNamespace(
                        payload_json={
                            "runtime_ledger_profit_proof_present": True,
                            "runtime_ledger_profit_proof_blockers": [],
                        }
                    )
                ],
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.persist_observed_runtime_windows",
                return_value={"run_id": "run-audit"},
            ) as persist_windows,
            patch("builtins.print") as print_result,
        ):
            exit_code = main()

        self.assertEqual(exit_code, 0)
        persist_windows.assert_not_called()
        summary = json.loads(print_result.call_args.args[0])
        self.assertEqual(
            summary["schema_version"],
            "torghut.runtime-window-import-source-audit.v1",
        )
        self.assertEqual(summary["verdict"], "profit_proof_present")
        self.assertEqual(summary["decision_count"], 1)
        self.assertEqual(summary["execution_count"], 1)
        self.assertEqual(summary["tca_row_count"], 1)
        self.assertEqual(summary["runtime_ledger_bucket_row_count"], 1)
        self.assertTrue(summary["runtime_ledger_profit_proof_present"])
        self.assertFalse(summary["would_persist"])

        args_plain = SimpleNamespace(**vars(args))
        args_plain.json = False
        with (
            patch(
                "scripts.import_hypothesis_runtime_windows._parse_args",
                return_value=args_plain,
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.resolve_hypothesis_manifest",
                return_value=(
                    SimpleNamespace(path="config/trading/hypotheses/h-cont-01.json"),
                    manifest,
                ),
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows._query_timestamps",
                return_value=(
                    [datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc)],
                    [datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc)],
                    [tca_row],
                ),
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows._runtime_ledger_tca_rows_from_source_dsn",
                return_value=(
                    [],
                    {
                        "runtime_ledger_source_bucket_count": 0,
                        "runtime_ledger_source_bucket_run_ids": [],
                        "runtime_ledger_source_bucket_fill_count": 0,
                        "runtime_ledger_source_bucket_tca_row_count": 0,
                        "runtime_ledger_source_bucket_profit_proof_count": 0,
                    },
                ),
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.build_regular_session_buckets",
                return_value=[
                    (
                        datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                        datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                        6,
                    )
                ],
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.build_observed_runtime_buckets",
                return_value=[
                    SimpleNamespace(
                        payload_json={
                            "runtime_ledger_profit_proof_present": True,
                            "runtime_ledger_profit_proof_blockers": [],
                        }
                    )
                ],
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.persist_observed_runtime_windows",
                return_value={"run_id": "run-audit"},
            ) as plain_persist_windows,
            patch("builtins.print") as print_plain,
        ):
            plain_exit_code = main()
        self.assertEqual(plain_exit_code, 0)
        plain_persist_windows.assert_not_called()
        self.assertEqual(
            print_plain.call_args.args[0]["schema_version"],
            "torghut.runtime-window-import-source-audit.v1",
        )

    def test_main_attaches_target_metadata_to_runtime_payload(self) -> None:
        args = SimpleNamespace(
            run_id="run-probation",
            candidate_id="cand-paper-probation",
            hypothesis_id="H-MICRO-01",
            observed_stage="paper",
            strategy_family="microstructure_breakout",
            source_dsn="postgresql://example",
            source_dsn_env="DB_DSN",
            strategy_name="microbar-volume-continuation-long-top2-chip-v1",
            account_label="TORGHUT_SIM",
            window_start="2026-03-06T14:30:00Z",
            window_end="2026-03-06T15:00:00Z",
            bucket_minutes=30,
            sample_minutes=5,
            source_manifest_ref="config/trading/hypotheses/h-micro-01.json",
            source_kind="paper_runtime_observed",
            artifact_ref=[],
            delay_adjusted_depth_stress_report_ref="",
            dataset_snapshot_ref="runtime-probation-snapshot",
            target_metadata_json=json.dumps(
                {
                    "paper_probation_authorized": True,
                    "evidence_collection_stage": "paper",
                    "paper_route_probe_symbols": ["aapl", "AAPL"],
                    "promotion_allowed": False,
                    "final_promotion_authorized": False,
                }
            ),
            dependency_quorum_decision="allow",
            continuity_ok="true",
            drift_ok="true",
            json=False,
        )
        fake_session = _FakeSession()
        manifest = SimpleNamespace(
            strategy_family="microstructure_breakout",
            strategy_id="microbar_volume_continuation_long_top2_chip_v1@paper",
            max_allowed_slippage_bps=Decimal("12"),
        )

        with (
            patch(
                "scripts.import_hypothesis_runtime_windows._parse_args",
                return_value=args,
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.resolve_hypothesis_manifest",
                return_value=(
                    SimpleNamespace(path="config/trading/hypotheses/h-micro-01.json"),
                    manifest,
                ),
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows._query_timestamps",
                return_value=(
                    [datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc)],
                    [datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc)],
                    [],
                ),
            ) as query_timestamps,
            patch(
                "scripts.import_hypothesis_runtime_windows.build_regular_session_buckets",
                return_value=[],
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.build_observed_runtime_buckets",
                return_value=[],
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.persist_observed_runtime_windows",
                return_value={"run_id": "run-probation"},
            ) as persist_windows,
            patch(
                "scripts.import_hypothesis_runtime_windows.SessionLocal",
                return_value=fake_session,
            ),
            patch("builtins.print"),
        ):
            exit_code = main()

        self.assertEqual(exit_code, 0)
        runtime_payload = persist_windows.call_args.kwargs[
            "runtime_observation_payload"
        ]
        self.assertEqual(
            runtime_payload["target_metadata"],
            {
                "paper_probation_authorized": True,
                "evidence_collection_stage": "paper",
                "paper_route_probe_symbols": ["aapl", "AAPL"],
                "promotion_allowed": False,
                "final_promotion_authorized": False,
            },
        )
        self.assertEqual(query_timestamps.call_args.kwargs["symbols"], ["AAPL"])
        self.assertEqual(runtime_payload["source_activity_symbol_filter"], ["AAPL"])

    def test_main_skips_persist_when_source_activity_is_empty(self) -> None:
        args = SimpleNamespace(
            run_id="run-empty",
            candidate_id="cand-empty",
            hypothesis_id="H-CONT-01",
            observed_stage="paper",
            strategy_family="",
            source_dsn="postgresql://example",
            source_dsn_env="DB_DSN",
            strategy_name="intraday-tsmom-profit-v2",
            account_label="TORGHUT_SIM",
            window_start="2026-03-06T14:30:00Z",
            window_end="2026-03-06T15:00:00Z",
            bucket_minutes=30,
            sample_minutes=5,
            source_manifest_ref="",
            source_kind="simulation_paper_runtime",
            artifact_ref=[],
            dataset_snapshot_ref="runtime-empty-snapshot",
            dependency_quorum_decision="allow",
            continuity_ok="true",
            drift_ok="true",
            audit_only=True,
            json=False,
        )
        manifest = SimpleNamespace(
            strategy_family="intraday_continuation",
            strategy_id="intraday_tsmom_v1@paper",
            max_allowed_slippage_bps=Decimal("12"),
        )

        with (
            patch(
                "scripts.import_hypothesis_runtime_windows._parse_args",
                return_value=args,
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.resolve_hypothesis_manifest",
                return_value=(
                    SimpleNamespace(path="config/trading/hypotheses/h-cont-01.json"),
                    manifest,
                ),
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows._query_timestamps",
                return_value=([], [], []),
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.build_regular_session_buckets",
            ) as build_buckets,
            patch(
                "scripts.import_hypothesis_runtime_windows.persist_observed_runtime_windows",
            ) as persist_windows,
            patch(
                "scripts.import_hypothesis_runtime_windows.SessionLocal",
            ) as session_local,
            patch("builtins.print") as print_mock,
        ):
            exit_code = main()

        self.assertEqual(exit_code, 0)
        build_buckets.assert_not_called()
        persist_windows.assert_not_called()
        session_local.assert_not_called()
        summary = print_mock.call_args.args[0]
        self.assertEqual(summary["status"], "skipped")
        self.assertEqual(summary["proof_status"], "blocked")
        self.assertEqual(summary["decision_count"], 0)
        self.assertTrue(summary["audit_only"])
        self.assertFalse(summary["would_persist"])
        self.assertEqual(
            summary["proof_blockers"][0]["blocker"],
            "runtime_window_source_activity_missing",
        )
        self.assertFalse(summary["runtime_observation"]["authoritative"])
