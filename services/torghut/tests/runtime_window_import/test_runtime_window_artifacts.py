from __future__ import annotations

from tests.runtime_window_import.runtime_window_import_base import (
    Decimal,
    POST_COST_BASIS_EXECUTION_RECONSTRUCTION,
    POST_COST_BASIS_RUNTIME_LEDGER,
    Path,
    RuntimeWindowImportTestCaseBase,
    TemporaryDirectory,
    _FakeConnection,
    _FakeCursor,
    _parse_dt_or_none,
    _query_timestamps,
    _runtime_ledger_event_type,
    _runtime_ledger_tca_rows_from_artifacts,
    datetime,
    json,
    patch,
    timezone,
)


class TestRuntimeWindowImportArtifacts(RuntimeWindowImportTestCaseBase):
    def test_query_timestamps_requires_source_lineage_for_candidate_import(
        self,
    ) -> None:
        cursor = _FakeCursor()
        matched_json = {"candidate_id": "cand-a", "hypothesis_id": "H-A"}
        unscoped_json: dict[str, object] = {}
        cursor._results = [
            [
                (
                    datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                    "AAPL",
                    "TORGHUT_SIM",
                    "microbar-cross-sectional-pairs-v1",
                    "decision-matched",
                    matched_json,
                ),
                (
                    datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    "AAPL",
                    "TORGHUT_SIM",
                    "microbar-cross-sectional-pairs-v1",
                    "decision-unscoped",
                    unscoped_json,
                ),
            ],
            [
                (
                    datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 14, 35, 30, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 14, 35, 30, tzinfo=timezone.utc),
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
                    "microbar-cross-sectional-pairs-v1",
                    "decision-matched",
                    matched_json,
                    "alpaca-order-matched",
                    "client-order-matched",
                    "filled",
                ),
                (
                    datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 14, 36, 30, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 14, 36, 30, tzinfo=timezone.utc),
                    "AAPL",
                    "buy",
                    Decimal("1"),
                    Decimal("100"),
                    Decimal("0.01"),
                    {},
                    {},
                    "TORGHUT_SIM",
                    "microbar-cross-sectional-pairs-v1",
                    "decision-unscoped",
                    unscoped_json,
                    "alpaca-order-unscoped",
                    "client-order-unscoped",
                    "filled",
                ),
            ],
            [
                (
                    datetime(2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc),
                    "AAPL",
                    "TORGHUT_SIM",
                    "microbar-cross-sectional-pairs-v1",
                    "decision-matched",
                    matched_json,
                    "alpaca-order-matched",
                    "client-order-matched",
                    "new",
                    "new",
                    "event-fingerprint-matched",
                    "alpaca-trade-updates",
                    0,
                    1,
                    {
                        "execution_policy": {"selected_order_type": "market"},
                        "cost_model": {"source": "broker_reported"},
                    },
                    {
                        "execution_policy_hash": "policy-sha",
                        "cost_model_hash": "cost-sha",
                        "lineage_hash": "lineage-sha",
                    },
                    {
                        "cost_amount": "0.01",
                        "cost_basis": "broker_reported_commission_and_fees",
                    },
                ),
                (
                    datetime(2026, 3, 6, 14, 36, 1, tzinfo=timezone.utc),
                    "AAPL",
                    "TORGHUT_SIM",
                    "microbar-cross-sectional-pairs-v1",
                    "decision-unscoped",
                    unscoped_json,
                    "alpaca-order-unscoped",
                    "client-order-unscoped",
                    "new",
                    "new",
                    "event-fingerprint-unscoped",
                    "alpaca-trade-updates",
                    0,
                    2,
                    {},
                    {},
                    {},
                ),
            ],
            [
                (
                    datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 15, 5, tzinfo=timezone.utc),
                    Decimal("1.25"),
                    Decimal("0.50"),
                    "decision-matched",
                    matched_json,
                ),
                (
                    datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 15, 6, tzinfo=timezone.utc),
                    Decimal("9.99"),
                    Decimal("-9.99"),
                    "decision-unscoped",
                    unscoped_json,
                ),
            ],
        ]
        connection = _FakeConnection(cursor)
        window_start = datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc)

        with patch(
            "scripts.import_hypothesis_runtime_windows.psycopg.connect",
            return_value=connection,
        ):
            decisions, executions, tca_rows = _query_timestamps(
                dsn="postgresql://example",
                strategy_names=["microbar-cross-sectional-pairs-v1"],
                account_label="TORGHUT_SIM",
                window_start=window_start,
                window_end=window_end,
                candidate_id="cand-a",
                hypothesis_id="H-A",
                require_source_lineage=True,
            )

        self.assertEqual(decisions, [datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc)])
        self.assertEqual(
            executions, [datetime(2026, 3, 6, 14, 35, 30, tzinfo=timezone.utc)]
        )
        self.assertTrue(tca_rows)
        self.assertTrue(
            all(
                row.get("post_cost_expectancy_basis")
                in {
                    POST_COST_BASIS_RUNTIME_LEDGER,
                    POST_COST_BASIS_EXECUTION_RECONSTRUCTION,
                }
                for row in tca_rows
            )
        )

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

    def test_runtime_ledger_artifacts_build_non_authoritative_tca_rows(self) -> None:
        with TemporaryDirectory() as temp_dir:
            artifact_path = Path(temp_dir) / "exact-ledger.json"
            artifact_path.write_text(
                json.dumps(
                    {
                        "schema_version": "torghut.exact_replay_ledger.rows.v1",
                        "candidate_id": "artifact-candidate-1",
                        "window_start": "2026-03-06",
                        "window_end": "2026-03-06",
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
        self.assertEqual(tca_rows[0]["post_cost_promotion_eligible"], False)
        self.assertEqual(tca_rows[0]["authoritative"], False)
        self.assertEqual(
            tca_rows[0]["authority_reason"],
            "exact_replay_artifact_not_runtime_proof",
        )
        self.assertEqual(
            tca_rows[0]["pnl_derivation"], "exact_replay_artifact_only_not_live"
        )
        self.assertIn(
            "exact_replay_artifact_not_runtime_proof",
            tca_rows[0]["runtime_ledger_blockers"],
        )
        self.assertIn(
            "runtime_ledger_source_window_missing",
            tca_rows[0]["runtime_ledger_blockers"],
        )
        self.assertIn(
            "runtime_ledger_source_refs_missing",
            tca_rows[0]["runtime_ledger_blockers"],
        )
        ledger_bucket = tca_rows[0]["runtime_ledger_bucket"]
        assert isinstance(ledger_bucket, dict)
        self.assertEqual(
            ledger_bucket["ledger_schema_version"], "torghut.exact_replay_ledger.v1"
        )
        self.assertEqual(ledger_bucket["pnl_basis"], POST_COST_BASIS_RUNTIME_LEDGER)
        self.assertEqual(ledger_bucket["decision_count"], 2)
        self.assertEqual(ledger_bucket["submitted_order_count"], 2)
        self.assertEqual(ledger_bucket["closed_trade_count"], 1)
        self.assertIn(
            "exact_replay_artifact_not_runtime_proof", ledger_bucket["blockers"]
        )
        self.assertEqual(metadata["runtime_ledger_artifact_row_count"], 6)
        self.assertEqual(metadata["runtime_ledger_artifact_tca_row_count"], 1)
        self.assertEqual(
            metadata["runtime_ledger_artifact_authority_class"],
            "exact_replay_artifact_only_not_live",
        )
        self.assertEqual(
            metadata["runtime_ledger_artifact_authority_blockers"],
            [
                "exact_replay_artifact_not_runtime_proof",
                "runtime_ledger_source_window_missing",
                "runtime_ledger_source_refs_missing",
            ],
        )
        self.assertEqual(
            metadata["runtime_ledger_artifact_candidate_id"], "artifact-candidate-1"
        )
        self.assertEqual(
            metadata["runtime_ledger_artifact_candidate_ids"],
            ["artifact-candidate-1"],
        )
        self.assertEqual(metadata["runtime_ledger_artifact_window_weekday_count"], 1)

    def test_runtime_ledger_artifacts_derive_candidate_ids_from_rows(self) -> None:
        with TemporaryDirectory() as temp_dir:
            artifact_path = Path(temp_dir) / "exact-ledger-row-candidates.json"
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
                                "candidate_id": "row-candidate-1",
                                "event_type": "decision",
                                "executed_at": "2026-03-06T14:35:00Z",
                                "decision_id": "decision-buy",
                            },
                            {
                                "candidate_id": "row-candidate-1",
                                "event_type": "order_submitted",
                                "executed_at": "2026-03-06T14:35:01Z",
                                "decision_id": "decision-buy",
                                "order_id": "order-buy",
                            },
                            {
                                "candidate_id": "row-candidate-1",
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
                                "candidate_id": "row-candidate-2",
                                "event_type": "decision",
                                "executed_at": "2026-03-06T14:40:00Z",
                                "decision_id": "decision-sell",
                            },
                            {
                                "candidate_id": "row-candidate-2",
                                "event_type": "order_submitted",
                                "executed_at": "2026-03-06T14:40:01Z",
                                "decision_id": "decision-sell",
                                "order_id": "order-sell",
                            },
                            {
                                "candidate_id": "row-candidate-2",
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

            _, _, tca_rows, metadata = _runtime_ledger_tca_rows_from_artifacts(
                artifact_refs=[str(artifact_path)],
                bucket_ranges=[
                    (
                        datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                        datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                        6,
                    )
                ],
            )

        self.assertEqual(
            metadata["runtime_ledger_artifact_candidate_ids"],
            ["row-candidate-1", "row-candidate-2"],
        )
        self.assertNotIn("runtime_ledger_artifact_candidate_id", metadata)
        self.assertEqual(tca_rows[0]["post_cost_promotion_eligible"], False)
        self.assertIn(
            "runtime_ledger_artifact_candidate_id_ambiguous",
            tca_rows[0]["runtime_ledger_blockers"],
        )

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
