from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
import json
from types import SimpleNamespace
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from scripts.import_hypothesis_runtime_windows import (
    EXECUTION_ELIGIBLE_DECISION_STATUSES,
    POST_COST_BASIS_RUNTIME_LEDGER,
    POST_COST_BASIS_SIMULATION_REPORT,
    POST_COST_BASIS_TCA_PROXY,
    _build_realized_strategy_pnl_rows,
    _load_json_artifact,
    _load_report_post_cost_expectancy_bps,
    _nonnegative_int,
    _parse_args,
    _parse_dt_or_none,
    _parse_target_metadata,
    _query_timestamps,
    _runtime_ledger_event_type,
    _runtime_ledger_profit_proof_present,
    _runtime_ledger_tca_rows_from_artifacts,
    _strategy_name_candidates,
    main,
)


class _FakeCursor:
    def __init__(self) -> None:
        self.executed: list[tuple[str, tuple[object, ...]]] = []
        self._results = [
            [(datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),)],
            [
                (
                    datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    "AAPL",
                    "buy",
                    Decimal("1"),
                    Decimal("100"),
                    Decimal("0.01"),
                    {
                        "cost_amount": "0.01",
                        "cost_basis": "broker_reported_commission_and_fees",
                    },
                    {},
                    "TORGHUT_SIM",
                    "intraday_tsmom_v1@paper",
                    "decision-sha",
                    "alpaca-order-1",
                    "client-order-1",
                    "filled",
                )
            ],
            [
                (
                    datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    Decimal("1.25"),
                    Decimal("0.50"),
                )
            ],
        ]

    def __enter__(self) -> _FakeCursor:
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None

    def execute(self, query: str, params: tuple[object, ...]) -> None:
        self.executed.append((query, params))

    def fetchall(self) -> list[tuple[object, ...]]:
        return self._results.pop(0)


class _FakeConnection:
    def __init__(self, cursor: _FakeCursor) -> None:
        self._cursor = cursor

    def __enter__(self) -> _FakeConnection:
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None

    def cursor(self) -> _FakeCursor:
        return self._cursor


class _FakeSession:
    def __init__(self) -> None:
        self.committed = False

    def __enter__(self) -> _FakeSession:
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None

    def commit(self) -> None:
        self.committed = True


class TestImportHypothesisRuntimeWindows(TestCase):
    def test_parse_args_accepts_dataset_snapshot_ref(self) -> None:
        with patch(
            "sys.argv",
            [
                "import_hypothesis_runtime_windows.py",
                "--run-id",
                "run-1",
                "--candidate-id",
                "cand-1",
                "--hypothesis-id",
                "H-CONT-01",
                "--observed-stage",
                "paper",
                "--source-dsn",
                "postgresql://example",
                "--strategy-name",
                "intraday-tsmom-profit-v2",
                "--account-label",
                "TORGHUT_SIM",
                "--window-start",
                "2026-03-06T14:30:00Z",
                "--window-end",
                "2026-03-06T15:00:00Z",
                "--dataset-snapshot-ref",
                "torghut-runtime-window-cand-1",
                "--artifact-ref",
                "s3://torghut-runtime/cand-1/report.json",
                "--target-metadata-json",
                '{"paper_probation_authorized":true}',
                "--json",
            ],
        ):
            args = _parse_args()

        self.assertEqual(args.run_id, "run-1")
        self.assertEqual(args.dataset_snapshot_ref, "torghut-runtime-window-cand-1")
        self.assertEqual(args.artifact_ref, ["s3://torghut-runtime/cand-1/report.json"])
        self.assertEqual(
            args.target_metadata_json, '{"paper_probation_authorized":true}'
        )
        self.assertEqual(args.json, True)

    def test_runtime_ledger_profit_proof_rejects_malformed_bucket_payload(
        self,
    ) -> None:
        self.assertEqual(
            _runtime_ledger_profit_proof_present(
                [
                    {
                        "post_cost_expectancy_basis": POST_COST_BASIS_RUNTIME_LEDGER,
                        "runtime_ledger_bucket": "not-a-bucket",
                    }
                ]
            ),
            False,
        )

    def test_runtime_ledger_profit_proof_rejects_incomplete_bucket_payload(
        self,
    ) -> None:
        self.assertEqual(
            _runtime_ledger_profit_proof_present(
                [
                    {
                        "post_cost_expectancy_basis": POST_COST_BASIS_RUNTIME_LEDGER,
                        "runtime_ledger_bucket": {
                            "fill_count": 0,
                            "filled_notional": "0",
                            "post_cost_expectancy_bps": None,
                            "blockers": ["runtime_ledger_filled_notional_zero"],
                        },
                    }
                ]
            ),
            False,
        )

    def test_parse_target_metadata_requires_json_mapping(self) -> None:
        self.assertEqual(_parse_target_metadata(""), {})
        self.assertEqual(
            _parse_target_metadata('{"paper_probation_authorized": true}'),
            {"paper_probation_authorized": True},
        )
        with self.assertRaisesRegex(RuntimeError, "target_metadata_json_invalid"):
            _parse_target_metadata("{")
        with self.assertRaisesRegex(RuntimeError, "target_metadata_json_not_mapping"):
            _parse_target_metadata("[]")

    def test_main_requires_source_dsn(self) -> None:
        args = SimpleNamespace(
            source_dsn="",
            source_dsn_env="TORGHUT_TEST_MISSING_DSN",
        )

        with (
            patch(
                "scripts.import_hypothesis_runtime_windows._parse_args",
                return_value=args,
            ),
            patch.dict("os.environ", {}, clear=True),
        ):
            with self.assertRaisesRegex(RuntimeError, "source_dsn_not_configured"):
                main()

    def test_load_report_post_cost_expectancy_bps_uses_simulation_report(self) -> None:
        with TemporaryDirectory() as temp_dir:
            report_path = Path(temp_dir) / "simulation-report.json"
            report_path.write_text(
                '{"pnl":{"net_pnl_estimated":"66.16","execution_notional_total":"200061.4"}}',
                encoding="utf-8",
            )

            value = _load_report_post_cost_expectancy_bps([str(report_path)])

        self.assertEqual(value, Decimal("3.306984755680006238084907933"))

    def test_load_report_post_cost_expectancy_bps_rejects_gross_only_report(
        self,
    ) -> None:
        with TemporaryDirectory() as temp_dir:
            report_path = Path(temp_dir) / "simulation-report.json"
            report_path.write_text(
                '{"pnl":{"gross_pnl":"66.16","execution_notional_total":"200061.4"}}',
                encoding="utf-8",
            )

            value = _load_report_post_cost_expectancy_bps([str(report_path)])

        self.assertEqual(value, None)

    def test_json_artifact_and_nonnegative_int_helpers_fail_closed(self) -> None:
        with TemporaryDirectory() as temp_dir:
            missing_path = Path(temp_dir) / "missing.json"
            invalid_path = Path(temp_dir) / "invalid.json"
            valid_path = Path(temp_dir) / "valid.json"
            invalid_path.write_text("{", encoding="utf-8")
            valid_path.write_text('{"case_count": 2}', encoding="utf-8")

            self.assertEqual(_load_json_artifact(""), {})
            self.assertEqual(_load_json_artifact(str(missing_path)), {})
            self.assertEqual(_load_json_artifact(str(invalid_path)), {})
            self.assertEqual(_load_json_artifact(str(valid_path)), {"case_count": 2})

        self.assertEqual(_nonnegative_int("3.9"), 3)
        self.assertEqual(_nonnegative_int("-2"), 0)
        self.assertEqual(_nonnegative_int("bad"), 0)

    def test_strategy_name_candidates_include_catalog_aliases(self) -> None:
        candidates = _strategy_name_candidates(
            "microbar_volume_continuation_long_top2_chip_v1@paper",
            "microbar-volume-continuation-long-top2-chip-v1",
            "",
            None,
        )

        self.assertEqual(
            candidates,
            [
                "microbar_volume_continuation_long_top2_chip_v1@paper",
                "microbar_volume_continuation_long_top2_chip_v1",
                "microbar-volume-continuation-long-top2-chip-v1@paper",
                "microbar-volume-continuation-long-top2-chip-v1",
            ],
        )

    def test_strategy_name_candidates_drop_blank_values(self) -> None:
        self.assertEqual(_strategy_name_candidates("", "   ", None), [])

    def test_build_realized_strategy_pnl_rows_requires_costed_round_trip(
        self,
    ) -> None:
        rows = _build_realized_strategy_pnl_rows(
            [
                {
                    "computed_at": datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "side": "buy",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                    "shortfall_notional": Decimal("99"),
                    "cost_amount": Decimal("0.20"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
                {
                    "computed_at": datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "side": "sell",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("101"),
                    "shortfall_notional": Decimal("99"),
                    "cost_amount": Decimal("0.10"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
            ]
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(
            rows[0]["post_cost_expectancy_basis"],
            POST_COST_BASIS_RUNTIME_LEDGER,
        )
        self.assertEqual(rows[0]["post_cost_promotion_eligible"], True)
        self.assertEqual(rows[0]["realized_net_pnl"], Decimal("0.70"))
        self.assertEqual(
            rows[0]["post_cost_expectancy_bps"],
            Decimal("34.82587064676616915422885572"),
        )

    def test_build_realized_strategy_pnl_rows_rejects_shortfall_only_costs(
        self,
    ) -> None:
        rows = _build_realized_strategy_pnl_rows(
            [
                {
                    "computed_at": datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "side": "buy",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                    "shortfall_notional": Decimal("0.20"),
                },
                {
                    "computed_at": datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "side": "sell",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("101"),
                    "shortfall_notional": Decimal("0.10"),
                },
            ]
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["post_cost_promotion_eligible"], False)
        self.assertIsNone(rows[0]["post_cost_expectancy_bps"])
        self.assertIn("explicit_cost_missing", rows[0]["runtime_ledger_blockers"])
        self.assertIn("cost_basis_missing", rows[0]["runtime_ledger_blockers"])

    def test_build_realized_strategy_pnl_rows_returns_empty_without_event_times(
        self,
    ) -> None:
        rows = _build_realized_strategy_pnl_rows(
            [
                {
                    "computed_at": None,
                    "symbol": "AAPL",
                    "side": "buy",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                    "shortfall_notional": Decimal("0.20"),
                }
            ]
        )

        self.assertEqual(rows, [])

    def test_query_timestamps_filters_to_execution_eligible_decisions(self) -> None:
        cursor = _FakeCursor()
        connection = _FakeConnection(cursor)
        window_start = datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc)

        with patch(
            "scripts.import_hypothesis_runtime_windows.psycopg.connect",
            return_value=connection,
        ):
            decisions, executions, tca_rows = _query_timestamps(
                dsn="postgresql://example",
                strategy_names=["intraday_tsmom_v1@paper", "intraday-tsmom-profit-v2"],
                account_label="TORGHUT_SIM",
                window_start=window_start,
                window_end=window_end,
            )

        self.assertEqual(decisions, [datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc)])
        self.assertEqual(
            executions, [datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc)]
        )
        self.assertEqual(len(tca_rows), 2)
        self.assertEqual(tca_rows[0]["abs_slippage_bps"], Decimal("1.25"))
        self.assertEqual(tca_rows[0]["post_cost_expectancy_bps"], Decimal("0.50"))
        self.assertEqual(
            tca_rows[0]["post_cost_expectancy_basis"], POST_COST_BASIS_TCA_PROXY
        )
        self.assertEqual(tca_rows[0]["post_cost_promotion_eligible"], False)
        self.assertEqual(tca_rows[1]["post_cost_promotion_eligible"], False)
        self.assertIn("unclosed_position", tca_rows[1]["runtime_ledger_blockers"])
        self.assertEqual(len(cursor.executed), 3)
        decision_query, decision_params = cursor.executed[0]
        self.assertIn("s.name = any(%s)", decision_query)
        self.assertIn("d.status = any(%s)", decision_query)
        self.assertEqual(
            decision_params[0],
            ["intraday_tsmom_v1@paper", "intraday-tsmom-profit-v2"],
        )
        self.assertEqual(
            decision_params[2],
            list(EXECUTION_ELIGIBLE_DECISION_STATUSES),
        )
        tca_query, _ = cursor.executed[2]
        execution_query, _ = cursor.executed[1]
        self.assertIn("left join execution_tca_metrics", execution_query)
        self.assertIn("d.created_at >= %s", execution_query)
        self.assertIn("d.created_at < %s", execution_query)
        self.assertNotIn("e.created_at >= %s", execution_query)
        self.assertIn("select\n                    d.created_at", tca_query)
        self.assertIn("d.created_at >= %s", tca_query)
        self.assertIn("d.created_at < %s", tca_query)
        self.assertNotIn("e.created_at >= %s", tca_query)
        self.assertNotIn("t.computed_at >= %s", tca_query)

    def test_query_timestamps_requires_strategy_name_candidates(self) -> None:
        window_start = datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc)

        with self.assertRaisesRegex(RuntimeError, "strategy_name_not_configured"):
            _query_timestamps(
                dsn="postgresql://example",
                strategy_names=[],
                account_label="TORGHUT_SIM",
                window_start=window_start,
                window_end=window_end,
            )

    def test_runtime_ledger_artifacts_build_promotion_grade_tca_rows(self) -> None:
        with TemporaryDirectory() as temp_dir:
            artifact_path = Path(temp_dir) / "exact-ledger.json"
            artifact_path.write_text(
                json.dumps(
                    {
                        "schema_version": "torghut.exact_replay_ledger.rows.v1",
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

            decisions, executions, tca_rows, metadata = (
                _runtime_ledger_tca_rows_from_artifacts(
                    artifact_refs=[str(artifact_path)],
                    bucket_ranges=[
                        (
                            datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                            datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                            6,
                        )
                    ],
                )
            )

        self.assertEqual(
            decisions,
            [
                datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
            ],
        )
        self.assertEqual(len(executions), 2)
        self.assertEqual(len(tca_rows), 1)
        self.assertEqual(
            tca_rows[0]["post_cost_expectancy_basis"],
            POST_COST_BASIS_RUNTIME_LEDGER,
        )
        self.assertEqual(tca_rows[0]["post_cost_promotion_eligible"], True)
        ledger_bucket = tca_rows[0]["runtime_ledger_bucket"]
        assert isinstance(ledger_bucket, dict)
        self.assertEqual(
            ledger_bucket["ledger_schema_version"], "torghut.exact_replay_ledger.v1"
        )
        self.assertEqual(ledger_bucket["pnl_basis"], POST_COST_BASIS_RUNTIME_LEDGER)
        self.assertEqual(ledger_bucket["decision_count"], 2)
        self.assertEqual(ledger_bucket["submitted_order_count"], 2)
        self.assertEqual(ledger_bucket["closed_trade_count"], 1)
        self.assertEqual(ledger_bucket["blockers"], [])
        self.assertEqual(metadata["runtime_ledger_artifact_row_count"], 6)
        self.assertEqual(metadata["runtime_ledger_artifact_tca_row_count"], 1)

    def test_runtime_ledger_artifact_helpers_fail_closed_on_loose_rows(self) -> None:
        aware_time = datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc)
        naive_time = datetime(2026, 3, 6, 14, 35)

        self.assertEqual(_parse_dt_or_none(aware_time), aware_time)
        self.assertEqual(_parse_dt_or_none(naive_time), aware_time)
        self.assertEqual(_parse_dt_or_none(""), None)
        self.assertEqual(_parse_dt_or_none("not-a-date"), None)
        self.assertEqual(_runtime_ledger_event_type({"filled_qty": "1"}), "fill")
        self.assertEqual(
            _runtime_ledger_event_type({"order_id": "alpaca-order-1"}),
            "order_submitted",
        )
        self.assertEqual(
            _runtime_ledger_event_type({"decision_id": "decision-1"}),
            "decision",
        )
        self.assertEqual(_runtime_ledger_event_type({}), "diagnostic")

        with TemporaryDirectory() as temp_dir:
            missing_path = Path(temp_dir) / "missing.json"
            malformed_rows_path = Path(temp_dir) / "malformed-rows.json"
            diagnostic_path = Path(temp_dir) / "diagnostic.json"
            malformed_rows_path.write_text(
                json.dumps(
                    {
                        "schema_version": "torghut.exact_replay_ledger.rows.v1",
                        "runtime_ledger_rows": {"bad": "shape"},
                    }
                ),
                encoding="utf-8",
            )
            diagnostic_path.write_text(
                json.dumps(
                    {
                        "schema_version": "torghut.exact_replay_ledger.rows.v1",
                        "runtime_ledger_rows": [
                            {"event_type": "diagnostic"},
                            {
                                "event_type": "diagnostic",
                                "executed_at": "2026-03-06T14:35:00Z",
                            },
                        ],
                    }
                ),
                encoding="utf-8",
            )

            decisions, executions, tca_rows, metadata = (
                _runtime_ledger_tca_rows_from_artifacts(
                    artifact_refs=[
                        str(missing_path),
                        str(malformed_rows_path),
                        str(diagnostic_path),
                    ],
                    bucket_ranges=[
                        (
                            datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                            datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                            6,
                        )
                    ],
                )
            )

        self.assertEqual(decisions, [])
        self.assertEqual(executions, [])
        self.assertEqual(tca_rows, [])
        self.assertEqual(
            metadata["runtime_ledger_artifact_refs"], [str(diagnostic_path)]
        )
        self.assertEqual(
            metadata["runtime_ledger_ignored_artifact_refs"],
            [str(malformed_rows_path)],
        )
        self.assertEqual(metadata["runtime_ledger_artifact_row_count"], 2)
        self.assertEqual(metadata["runtime_ledger_artifact_tca_row_count"], 0)

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
                "promotion_allowed": False,
                "final_promotion_authorized": False,
            },
        )

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
        self.assertEqual(
            summary["proof_blockers"][0]["blocker"],
            "runtime_window_source_activity_missing",
        )
        self.assertFalse(summary["runtime_observation"]["authoritative"])

    def test_main_imports_exact_runtime_ledger_artifact_without_db_activity(
        self,
    ) -> None:
        with TemporaryDirectory() as temp_dir:
            artifact_path = Path(temp_dir) / "exact-ledger.json"
            artifact_path.write_text(
                json.dumps(
                    {
                        "schema_version": "torghut.exact_replay_ledger.rows.v1",
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
                    "scripts.import_hypothesis_runtime_windows.SessionLocal",
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
        self.assertEqual(tca_rows[0]["post_cost_promotion_eligible"], True)
        runtime_payload = persist_windows.call_args.kwargs[
            "runtime_observation_payload"
        ]
        self.assertEqual(
            runtime_payload["runtime_ledger_artifact_refs"], [str(artifact_path)]
        )
        self.assertEqual(runtime_payload["runtime_ledger_artifact_row_count"], 6)
        self.assertEqual(runtime_payload["runtime_ledger_artifact_fill_count"], 2)
        self.assertEqual(
            runtime_payload["authority_reason"], "runtime_ledger_profit_proof"
        )
        self.assertEqual(runtime_payload["promotion_authority"], "runtime_ledger")
        self.assertEqual(runtime_payload["runtime_ledger_profit_proof_present"], True)
        self.assertEqual(runtime_payload["authoritative"], True)

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
            "simulation_runtime_without_runtime_ledger_profit_proof",
        )
        self.assertEqual(runtime_payload["promotion_authority"], "blocked")
        self.assertEqual(runtime_payload["runtime_ledger_profit_proof_present"], False)

    def test_main_quarantines_report_runtime_pnl_when_tca_rows_are_empty(self) -> None:
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
                    "scripts.import_hypothesis_runtime_windows.SessionLocal",
                    return_value=fake_session,
                ),
                patch("builtins.print"),
            ):
                exit_code = main()

        self.assertEqual(exit_code, 0)
        tca_rows = build_buckets.call_args.kwargs["tca_rows"]
        self.assertEqual(
            tca_rows,
            [
                {
                    "computed_at": datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    "post_cost_expectancy_bps": Decimal("50.000"),
                    "post_cost_expectancy_basis": POST_COST_BASIS_SIMULATION_REPORT,
                    "post_cost_promotion_eligible": False,
                    "promotion_blocker": "simulation_report_not_runtime_ledger_proof",
                }
            ],
        )
        runtime_payload = persist_windows.call_args.kwargs[
            "runtime_observation_payload"
        ]
        self.assertEqual(
            runtime_payload["report_post_cost_expectancy_basis"],
            POST_COST_BASIS_SIMULATION_REPORT,
        )
        self.assertEqual(runtime_payload["authoritative"], False)
        self.assertEqual(
            runtime_payload["authority_reason"],
            "simulation_runtime_without_runtime_ledger_profit_proof",
        )
        self.assertEqual(runtime_payload["promotion_authority"], "blocked")
        self.assertEqual(runtime_payload["runtime_ledger_profit_proof_present"], False)
