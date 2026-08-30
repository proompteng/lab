from __future__ import annotations

from tests.runtime_window_import.runtime_window_import_base import (
    Decimal,
    POST_COST_BASIS_RUNTIME_LEDGER,
    Path,
    RuntimeWindowImportTestCaseBase,
    SimpleNamespace,
    TemporaryDirectory,
    _FakeSession,
    _complete_runtime_ledger_bucket,
    datetime,
    json,
    main,
    patch,
    timezone,
)


class TestRuntimeWindowImportMainB(RuntimeWindowImportTestCaseBase):
    def test_main_imports_exact_runtime_ledger_artifact_without_db_activity(
        self,
    ) -> None:
        with TemporaryDirectory() as temp_dir:
            artifact_path = Path(temp_dir) / "exact-ledger.json"
            artifact_path.write_text(
                json.dumps(
                    {
                        "schema_version": "torghut.exact_replay_ledger.rows.v1",
                        "candidate_id": "H-TSMOM-LIQ-01",
                        "account_label": "TORGHUT_SIM",
                        "strategy_id": "intraday-tsmom-profit-v3",
                        "execution_policy_hash": "policy-sha",
                        "cost_model_hash": "cost-sha",
                        "lineage_hash": "lineage-sha",
                        "runtime_ledger_rows": [
                            {
                                "event_type": "decision",
                                "executed_at": "2026-03-06T14:35:00Z",
                                "decision_id": "decision-buy",
                                "order_id": "order-buy",
                            },
                            {
                                "event_type": "order_submitted",
                                "executed_at": "2026-03-06T14:35:01Z",
                                "decision_id": "decision-buy",
                                "order_id": "order-buy",
                            },
                            {
                                "event_type": "fill",
                                "executed_at": "2026-03-06T14:35:02Z",
                                "decision_id": "decision-buy",
                                "order_id": "order-buy",
                                "symbol": "AAPL",
                                "side": "buy",
                                "filled_qty": "1",
                                "avg_fill_price": "100",
                                "cost_amount": "0.10",
                                "cost_basis": "broker_reported_commission_and_fees",
                            },
                            {
                                "event_type": "decision",
                                "executed_at": "2026-03-06T14:40:00Z",
                                "decision_id": "decision-sell",
                                "order_id": "order-sell",
                            },
                            {
                                "event_type": "order_submitted",
                                "executed_at": "2026-03-06T14:40:01Z",
                                "decision_id": "decision-sell",
                                "order_id": "order-sell",
                            },
                            {
                                "event_type": "fill",
                                "executed_at": "2026-03-06T14:40:02Z",
                                "decision_id": "decision-sell",
                                "order_id": "order-sell",
                                "symbol": "AAPL",
                                "side": "sell",
                                "filled_qty": "1",
                                "avg_fill_price": "101",
                                "cost_amount": "0.10",
                                "cost_basis": "broker_reported_commission_and_fees",
                            },
                        ],
                    }
                ),
                encoding="utf-8",
            )
            args = SimpleNamespace(
                run_id="run-ledger-artifact",
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
                dataset_snapshot_ref="runtime-ledger-artifact-snapshot",
                target_metadata_json=json.dumps(
                    {
                        "runtime_ledger_artifact_refs": [str(artifact_path)],
                        "candidate_id": "H-TSMOM-LIQ-01",
                        "runtime_ledger_artifact_row_count": 6,
                        "runtime_ledger_artifact_fill_count": 2,
                        "window_start": "2026-03-06T14:30:00+00:00",
                        "window_end": "2026-03-06T15:00:00+00:00",
                    }
                ),
                dependency_quorum_decision="allow",
                continuity_ok="true",
                drift_ok="true",
                json=False,
            )
            fake_session = _FakeSession()
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
                patch.dict("os.environ", {}, clear=True),
                patch(
                    "scripts.import_hypothesis_runtime_windows._query_timestamps",
                ) as query_timestamps,
                patch(
                    "scripts.import_hypothesis_runtime_windows.build_observed_runtime_buckets",
                    return_value=[],
                ) as build_buckets,
                patch(
                    "scripts.import_hypothesis_runtime_windows.persist_observed_runtime_windows",
                    return_value={"run_id": "run-ledger-artifact"},
                ) as persist_windows,
                patch(
                    "scripts.hypothesis_runtime_window_import.cli_parsing.SessionLocal",
                    return_value=fake_session,
                ),
                patch("builtins.print"),
            ):
                exit_code = main()

        self.assertEqual(exit_code, 0)
        query_timestamps.assert_not_called()
        self.assertEqual(len(build_buckets.call_args.kwargs["decision_times"]), 2)
        self.assertEqual(len(build_buckets.call_args.kwargs["execution_times"]), 2)
        tca_rows = build_buckets.call_args.kwargs["tca_rows"]
        self.assertEqual(len(tca_rows), 1)
        self.assertEqual(
            tca_rows[0]["post_cost_expectancy_basis"],
            POST_COST_BASIS_RUNTIME_LEDGER,
        )
        self.assertEqual(tca_rows[0]["post_cost_promotion_eligible"], False)
        self.assertEqual(
            tca_rows[0]["authority_reason"],
            "exact_replay_artifact_not_runtime_proof",
        )
        self.assertIn(
            "runtime_ledger_source_window_missing",
            tca_rows[0]["runtime_ledger_blockers"],
        )
        runtime_payload = persist_windows.call_args.kwargs[
            "runtime_observation_payload"
        ]
        self.assertEqual(
            runtime_payload["runtime_ledger_artifact_refs"], [str(artifact_path)]
        )
        self.assertEqual(runtime_payload["runtime_ledger_artifact_row_count"], 6)
        self.assertEqual(runtime_payload["runtime_ledger_artifact_fill_count"], 2)
        self.assertEqual(
            runtime_payload["runtime_ledger_artifact_candidate_id"],
            "H-TSMOM-LIQ-01",
        )
        self.assertEqual(runtime_payload["runtime_ledger_target_metadata_blockers"], [])
        self.assertEqual(
            runtime_payload["authority_reason"],
            "exact_replay_artifact_not_runtime_proof",
        )
        self.assertEqual(runtime_payload["promotion_authority"], "blocked")
        self.assertEqual(runtime_payload["runtime_ledger_profit_proof_present"], False)
        self.assertEqual(runtime_payload["authoritative"], False)
        self.assertEqual(
            runtime_payload["runtime_ledger_artifact_authority_class"],
            "exact_replay_artifact_only_not_live",
        )
        self.assertEqual(
            runtime_payload["runtime_ledger_artifact_authority_blockers"],
            [
                "exact_replay_artifact_not_runtime_proof",
                "runtime_ledger_source_window_missing",
                "runtime_ledger_source_refs_missing",
            ],
        )
        self.assertIn(
            "exact_replay_artifact_not_runtime_proof",
            runtime_payload["runtime_ledger_materialization_blockers"],
        )

    def test_main_imports_durable_runtime_ledger_bucket_without_source_dsn(
        self,
    ) -> None:
        args = SimpleNamespace(
            run_id="run-durable-ledger",
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
            artifact_ref=[],
            delay_adjusted_depth_stress_report_ref="",
            dataset_snapshot_ref="durable-runtime-ledger-snapshot",
            target_metadata_json="",
            dependency_quorum_decision="allow",
            continuity_ok="true",
            drift_ok="true",
            json=False,
        )
        fake_session = _FakeSession()
        manifest = SimpleNamespace(
            strategy_family="intraday_tsmom_consistent",
            strategy_id="intraday_tsmom_v2@research",
            max_allowed_slippage_bps=Decimal("6"),
        )
        durable_tca_row = {
            "computed_at": datetime(2026, 3, 6, 14, 59, 59, tzinfo=timezone.utc),
            "abs_slippage_bps": Decimal("10"),
            "post_cost_expectancy_bps": Decimal("40"),
            "post_cost_expectancy_basis": POST_COST_BASIS_RUNTIME_LEDGER,
            "post_cost_promotion_eligible": True,
            "runtime_ledger_bucket": _complete_runtime_ledger_bucket(
                run_id="runtime-proof-1",
                candidate_id="H-TSMOM-LIQ-01",
                hypothesis_id="H-TSMOM-LIQ-01",
                observed_stage="paper",
                account_label="TORGHUT_SIM",
                strategy_id="intraday-tsmom-profit-v3",
                bucket_started_at="2026-03-06T14:30:00+00:00",
                bucket_ended_at="2026-03-06T15:00:00+00:00",
            ),
        }

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
            patch.dict("os.environ", {}, clear=True),
            patch(
                "scripts.import_hypothesis_runtime_windows._query_timestamps",
            ) as query_timestamps,
            patch(
                "scripts.import_hypothesis_runtime_windows._runtime_ledger_tca_rows_from_durable_buckets",
                return_value=(
                    [durable_tca_row],
                    {
                        "runtime_ledger_durable_bucket_count": 1,
                        "runtime_ledger_durable_bucket_run_ids": ["runtime-proof-1"],
                        "runtime_ledger_durable_bucket_fill_count": 2,
                        "runtime_ledger_durable_bucket_tca_row_count": 1,
                        "runtime_ledger_durable_bucket_profit_proof_count": 1,
                    },
                ),
            ) as durable_buckets,
            patch(
                "scripts.import_hypothesis_runtime_windows.build_observed_runtime_buckets",
                return_value=[],
            ) as build_buckets,
            patch(
                "scripts.import_hypothesis_runtime_windows.persist_observed_runtime_windows",
                return_value={"run_id": "run-durable-ledger"},
            ) as persist_windows,
            patch(
                "scripts.hypothesis_runtime_window_import.cli_parsing.SessionLocal",
                return_value=fake_session,
            ),
            patch("builtins.print"),
        ):
            exit_code = main()

        self.assertEqual(exit_code, 0)
        query_timestamps.assert_not_called()
        durable_buckets.assert_called_once()
        tca_rows = build_buckets.call_args.kwargs["tca_rows"]
        self.assertEqual(tca_rows, [durable_tca_row])
        runtime_payload = persist_windows.call_args.kwargs[
            "runtime_observation_payload"
        ]
        self.assertEqual(runtime_payload["runtime_ledger_durable_bucket_count"], 1)
        self.assertEqual(
            runtime_payload["runtime_ledger_durable_bucket_run_ids"],
            ["runtime-proof-1"],
        )
        self.assertEqual(
            runtime_payload["runtime_ledger_durable_bucket_profit_proof_count"],
            1,
        )
        self.assertEqual(
            runtime_payload["authority_reason"], "runtime_ledger_profit_proof"
        )
        self.assertEqual(runtime_payload["promotion_authority"], "runtime_ledger")
        self.assertEqual(runtime_payload["runtime_ledger_profit_proof_present"], True)

    def test_main_imports_source_runtime_ledger_bucket_with_source_dsn(
        self,
    ) -> None:
        args = SimpleNamespace(
            run_id="run-source-ledger",
            candidate_id="H-TSMOM-LIQ-01",
            hypothesis_id="H-TSMOM-LIQ-01",
            observed_stage="paper",
            strategy_family="intraday_tsmom_consistent",
            source_dsn="postgresql://source",
            source_dsn_env="DB_DSN",
            strategy_name="intraday-tsmom-profit-v3",
            account_label="TORGHUT_SIM",
            window_start="2026-03-06T14:30:00Z",
            window_end="2026-03-06T15:00:00Z",
            bucket_minutes=30,
            sample_minutes=5,
            source_manifest_ref="config/trading/hypotheses/h-tsmom-liq-01.json",
            source_kind="paper_route_probe_runtime_observed",
            artifact_ref=[],
            delay_adjusted_depth_stress_report_ref="",
            dataset_snapshot_ref="source-runtime-ledger-snapshot",
            target_metadata_json=json.dumps(
                {
                    "paper_probation_authorized": True,
                    "paper_probation_authorization_scope": ("evidence_collection_only"),
                    "evidence_collection_stage": "paper",
                    "promotion_allowed": False,
                    "final_promotion_authorized": False,
                    "final_promotion_allowed": False,
                    "runtime_ledger_target_metadata_blockers": [
                        "paper_route_runtime_ledger_import_pending"
                    ],
                }
            ),
            dependency_quorum_decision="allow",
            continuity_ok="true",
            drift_ok="true",
            json=False,
        )
        fake_session = _FakeSession()
        manifest = SimpleNamespace(
            strategy_family="intraday_tsmom_consistent",
            strategy_id="intraday_tsmom_v2@research",
            max_allowed_slippage_bps=Decimal("6"),
        )
        source_tca_row = {
            "computed_at": datetime(2026, 3, 6, 14, 59, 59, tzinfo=timezone.utc),
            "abs_slippage_bps": Decimal("10"),
            "post_cost_expectancy_bps": Decimal("40"),
            "post_cost_expectancy_basis": POST_COST_BASIS_RUNTIME_LEDGER,
            "post_cost_promotion_eligible": True,
            "runtime_ledger_bucket": _complete_runtime_ledger_bucket(
                run_id="runtime-proof-source",
                candidate_id="H-TSMOM-LIQ-01",
                hypothesis_id="H-TSMOM-LIQ-01",
                observed_stage="paper",
                account_label="TORGHUT_SIM",
                strategy_id="intraday-tsmom-profit-v3",
                bucket_started_at="2026-03-06T14:30:00+00:00",
                bucket_ended_at="2026-03-06T15:00:00+00:00",
            ),
        }

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
                "scripts.import_hypothesis_runtime_windows._query_timestamps",
                return_value=([], [], []),
            ) as query_timestamps,
            patch(
                "scripts.import_hypothesis_runtime_windows._runtime_ledger_tca_rows_from_source_dsn",
                return_value=(
                    [source_tca_row],
                    {
                        "runtime_ledger_source_bucket_count": 1,
                        "runtime_ledger_source_bucket_run_ids": [
                            "runtime-proof-source"
                        ],
                        "runtime_ledger_source_bucket_fill_count": 2,
                        "runtime_ledger_source_bucket_tca_row_count": 1,
                        "runtime_ledger_source_bucket_profit_proof_count": 1,
                    },
                ),
            ) as source_buckets,
            patch(
                "scripts.import_hypothesis_runtime_windows.build_observed_runtime_buckets",
                return_value=[],
            ) as build_buckets,
            patch(
                "scripts.import_hypothesis_runtime_windows.persist_observed_runtime_windows",
                return_value={"run_id": "run-source-ledger"},
            ) as persist_windows,
            patch(
                "scripts.hypothesis_runtime_window_import.cli_parsing.SessionLocal",
                return_value=fake_session,
            ),
            patch("builtins.print"),
        ):
            exit_code = main()

        self.assertEqual(exit_code, 0)
        query_timestamps.assert_called_once()
        self.assertEqual(
            query_timestamps.call_args.kwargs[
                "allow_authoritative_runtime_ledger_materialization"
            ],
            True,
        )
        source_buckets.assert_called_once()
        tca_rows = build_buckets.call_args.kwargs["tca_rows"]
        self.assertEqual(tca_rows, [source_tca_row])
        runtime_payload = persist_windows.call_args.kwargs[
            "runtime_observation_payload"
        ]
        self.assertEqual(runtime_payload["runtime_ledger_source_bucket_count"], 1)
        self.assertEqual(
            runtime_payload["runtime_ledger_source_bucket_run_ids"],
            ["runtime-proof-source"],
        )
        self.assertEqual(
            runtime_payload["runtime_ledger_source_bucket_profit_proof_count"],
            1,
        )
        self.assertEqual(
            runtime_payload["authority_reason"], "runtime_ledger_profit_proof"
        )
        self.assertEqual(runtime_payload["promotion_authority"], "runtime_ledger")
        self.assertEqual(runtime_payload["runtime_ledger_profit_proof_present"], True)

    def test_main_uses_observed_bucket_materialization_over_stale_source_diagnostics(
        self,
    ) -> None:
        args = SimpleNamespace(
            run_id="run-observed-clean",
            candidate_id="H-TSMOM-LIQ-01",
            hypothesis_id="H-TSMOM-LIQ-01",
            observed_stage="paper",
            strategy_family="intraday_tsmom_consistent",
            source_dsn="postgresql://source",
            source_dsn_env="DB_DSN",
            strategy_name="intraday-tsmom-profit-v3",
            account_label="TORGHUT_SIM",
            source_account_label="TORGHUT_SIM",
            window_start="2026-03-06T14:30:00Z",
            window_end="2026-03-06T15:00:00Z",
            bucket_minutes=30,
            sample_minutes=5,
            source_manifest_ref="config/trading/hypotheses/h-tsmom-liq-01.json",
            source_kind="paper_route_probe_runtime_observed",
            artifact_ref=[],
            delay_adjusted_depth_stress_report_ref="",
            dataset_snapshot_ref="observed-clean-snapshot",
            target_metadata_json=json.dumps(
                {
                    "paper_probation_authorized": True,
                    "paper_probation_authorization_scope": "evidence_collection_only",
                    "evidence_collection_stage": "paper",
                    "promotion_allowed": False,
                    "final_promotion_authorized": False,
                    "final_promotion_allowed": False,
                }
            ),
            dependency_quorum_decision="allow",
            continuity_ok="true",
            drift_ok="true",
            json=False,
        )
        fake_session = _FakeSession()
        manifest = SimpleNamespace(
            strategy_family="intraday_tsmom_consistent",
            strategy_id="intraday_tsmom_v2@research",
            max_allowed_slippage_bps=Decimal("6"),
        )
        stale_source_bucket = _complete_runtime_ledger_bucket(
            closed_trade_count=0,
            open_position_count=1,
            blockers=["unclosed_position"],
            paper_route_target_notional_sizing={
                "requires_target_notional_sizing": True,
                "authoritative_target_notional_sizing_count": 0,
                "missing_target_notional_sizing_count": 2,
                "non_authoritative_sizing_source_counts": {},
                "blockers": ["paper_route_target_notional_sizing_missing"],
            },
        )
        stale_source_tca_row = {
            "computed_at": datetime(2026, 3, 6, 14, 59, 59, tzinfo=timezone.utc),
            "abs_slippage_bps": Decimal("10"),
            "post_cost_expectancy_bps": Decimal("40"),
            "post_cost_expectancy_basis": POST_COST_BASIS_RUNTIME_LEDGER,
            "post_cost_promotion_eligible": True,
            "runtime_ledger_bucket": stale_source_bucket,
        }
        clean_observed_bucket = _complete_runtime_ledger_bucket(
            run_id="run-observed-clean",
            candidate_id="H-TSMOM-LIQ-01",
            hypothesis_id="H-TSMOM-LIQ-01",
            observed_stage="paper",
            account_label="TORGHUT_SIM",
            strategy_id="intraday-tsmom-profit-v3",
            bucket_started_at="2026-03-06T14:30:00+00:00",
            bucket_ended_at="2026-03-06T15:00:00+00:00",
            paper_route_target_notional_sizing={
                "requires_target_notional_sizing": True,
                "authoritative_target_notional_sizing_count": 2,
                "missing_target_notional_sizing_count": 0,
                "non_authoritative_sizing_source_counts": {},
                "blockers": [],
            },
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
                "scripts.import_hypothesis_runtime_windows._query_timestamps",
                return_value=(
                    [datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc)],
                    [datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc)],
                    [],
                ),
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows._runtime_ledger_tca_rows_from_source_dsn",
                return_value=(
                    [stale_source_tca_row],
                    {
                        "runtime_ledger_source_bucket_count": 1,
                        "runtime_ledger_source_bucket_run_ids": ["stale-source-run"],
                        "runtime_ledger_source_bucket_fill_count": 2,
                        "runtime_ledger_source_bucket_tca_row_count": 1,
                        "runtime_ledger_source_bucket_profit_proof_count": 0,
                        "runtime_ledger_source_bucket_profit_proof_blockers": [
                            "unclosed_position",
                            "paper_route_target_notional_sizing_missing",
                        ],
                    },
                ),
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.build_observed_runtime_buckets",
                return_value=[
                    SimpleNamespace(
                        payload_json={
                            "runtime_ledger_buckets": [clean_observed_bucket],
                        }
                    )
                ],
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.persist_observed_runtime_windows",
                return_value={"run_id": "run-observed-clean"},
            ) as persist_windows,
            patch(
                "scripts.hypothesis_runtime_window_import.cli_parsing.SessionLocal",
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
            runtime_payload["runtime_ledger_materialization_authority_source"],
            "observed_runtime_buckets",
        )
        self.assertTrue(runtime_payload["authoritative"])
        self.assertEqual(
            runtime_payload["authority_reason"], "runtime_ledger_profit_proof"
        )
        self.assertEqual(runtime_payload["promotion_authority"], "runtime_ledger")
        self.assertTrue(runtime_payload["runtime_ledger_profit_proof_present"])
        self.assertEqual(runtime_payload["runtime_ledger_tca_profit_proof_count"], 1)
        self.assertEqual(
            runtime_payload["runtime_ledger_tca_runtime_bucket_row_count"], 1
        )
        self.assertEqual(
            runtime_payload[
                "runtime_ledger_source_execution_materialized_bucket_count"
            ],
            1,
        )
        self.assertEqual(runtime_payload["runtime_ledger_materialization_blockers"], [])
        self.assertEqual(runtime_payload["runtime_ledger_profit_proof_blockers"], [])
        self.assertEqual(runtime_payload["source_activity_diagnostic_blockers"], [])
        self.assertEqual(
            runtime_payload["source_activity_diagnostic_blockers_from_source_query"],
            [
                "runtime_ledger_source_bucket_profit_proof_missing",
                "unclosed_position",
                "paper_route_target_notional_sizing_missing",
            ],
        )
        self.assertEqual(
            runtime_payload["paper_route_target_notional_sizing_authoritative_count"],
            2,
        )
        self.assertEqual(
            runtime_payload["paper_route_target_notional_sizing_missing_count"],
            0,
        )

    def test_main_attaches_delay_adjusted_depth_report_to_runtime_payload(
        self,
    ) -> None:
        with TemporaryDirectory() as temp_dir:
            report_path = Path(temp_dir) / "delay-depth.json"
            report_path.write_text(
                '{"passed": true, "case_count": 2, "checked_at": "2026-03-06T15:20:00Z"}',
                encoding="utf-8",
            )
            args = SimpleNamespace(
                run_id="run-depth",
                candidate_id="chip-paper-microbar-composite@execution-proof",
                hypothesis_id="H-MICRO-01",
                observed_stage="paper",
                strategy_family="microstructure_breakout",
                source_dsn="postgresql://example",
                source_dsn_env="DB_DSN",
                strategy_name="microbar_volume_continuation_long_top2_chip_v1@paper",
                account_label="TORGHUT_SIM",
                window_start="2026-03-06T14:30:00Z",
                window_end="2026-03-06T15:00:00Z",
                bucket_minutes=30,
                sample_minutes=5,
                source_manifest_ref="config/trading/hypotheses/h-micro-01.json",
                source_kind="simulation_paper_runtime",
                dataset_snapshot_ref="runtime-depth-snapshot",
                artifact_ref=[],
                delay_adjusted_depth_stress_report_ref=str(report_path),
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
                        SimpleNamespace(
                            path="config/trading/hypotheses/h-micro-01.json"
                        ),
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
                    return_value={"run_id": "run-depth"},
                ) as persist_windows,
                patch(
                    "scripts.hypothesis_runtime_window_import.cli_parsing.SessionLocal",
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
            runtime_payload["delay_adjusted_depth_stress_artifact_ref"],
            str(report_path),
        )
        self.assertEqual(runtime_payload["delay_adjusted_depth_stress_checks_total"], 2)
        self.assertEqual(runtime_payload["delay_adjusted_depth_stress_passed"], True)
        self.assertEqual(
            runtime_payload["delay_adjusted_depth_stress_checked_at"],
            "2026-03-06T15:20:00Z",
        )
        self.assertIn(str(report_path), runtime_payload["artifact_refs"])
        self.assertEqual(runtime_payload["authoritative"], False)
        self.assertEqual(
            runtime_payload["authority_reason"],
            "simulation_source_replay_only",
        )
        self.assertEqual(runtime_payload["promotion_authority"], "blocked")
        self.assertEqual(runtime_payload["runtime_ledger_profit_proof_present"], False)

    def test_main_ignores_report_runtime_pnl_when_tca_rows_are_empty(self) -> None:
        with TemporaryDirectory() as temp_dir:
            report_path = Path(temp_dir) / "simulation-report.json"
            report_path.write_text(
                '{"pnl":{"net_pnl_estimated":"50","execution_notional_total":"10000"}}',
                encoding="utf-8",
            )
            args = SimpleNamespace(
                run_id="run-report-pnl",
                candidate_id="cand-report-pnl",
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
                artifact_ref=[str(report_path)],
                delay_adjusted_depth_stress_report_ref="",
                dataset_snapshot_ref="runtime-report-snapshot",
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
                        SimpleNamespace(
                            path="config/trading/hypotheses/h-cont-01.json"
                        ),
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
                ) as build_buckets,
                patch(
                    "scripts.import_hypothesis_runtime_windows.persist_observed_runtime_windows",
                    return_value={"run_id": "run-report-pnl"},
                ) as persist_windows,
                patch(
                    "scripts.hypothesis_runtime_window_import.cli_parsing.SessionLocal",
                    return_value=fake_session,
                ),
                patch("builtins.print"),
            ):
                exit_code = main()

        self.assertEqual(exit_code, 0)
        tca_rows = build_buckets.call_args.kwargs["tca_rows"]
        self.assertEqual(tca_rows, [])
        runtime_payload = persist_windows.call_args.kwargs[
            "runtime_observation_payload"
        ]
        self.assertNotIn("report_post_cost_expectancy_basis", runtime_payload)
        self.assertNotIn("report_post_cost_expectancy_bps", runtime_payload)
        self.assertEqual(runtime_payload["authoritative"], False)
        self.assertEqual(
            runtime_payload["authority_reason"],
            "simulation_source_replay_only",
        )
        self.assertEqual(runtime_payload["promotion_authority"], "blocked")
        self.assertEqual(runtime_payload["runtime_ledger_profit_proof_present"], False)
