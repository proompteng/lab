from __future__ import annotations

from tests.runtime_window_import.runtime_window_import_base import (
    Decimal,
    POST_COST_BASIS_RUNTIME_LEDGER,
    RuntimeWindowImportTestCaseBase,
    _FakeConnection,
    _FakeCursor,
    _query_timestamps,
    _source_activity_diagnostics_blockers,
    datetime,
    patch,
    timedelta,
    timezone,
)


class TestRuntimeWindowImportQueryTimestampsB(RuntimeWindowImportTestCaseBase):
    def test_query_timestamps_includes_verified_post_window_closeout(
        self,
    ) -> None:
        window_start = datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc)
        closeout_at = window_end + timedelta(minutes=5)
        entry_payload = {
            "action": "buy",
            "source_decision_mode": "bounded_paper_route_collection",
            "candidate_id": "candidate-1",
            "hypothesis_id": "H-PAIRS-01",
            "paper_route_target_notional_sizing": {
                "schema_version": "torghut.paper-route-target-notional-sizing.v1",
                "sizing_source": "target_notional",
                "target_notional": "75000",
                "requested_qty": "1",
                "resolved_qty": "1",
                "blockers": [],
            },
        }
        closeout_payload = {
            "action": "sell",
            "source_decision_mode": "bounded_paper_route_collection",
        }

        def decision_row(
            decision_id: str,
            created_at: datetime,
            action_payload: dict[str, object],
        ) -> tuple[object, ...]:
            return (
                decision_id,
                created_at,
                "AAPL",
                "TORGHUT_SIM",
                "microbar-cross-sectional-pairs-v1",
                decision_id,
                action_payload,
            )

        def execution_row(
            execution_id: str,
            decision_id: str,
            decision_created_at: datetime,
            event_at: datetime,
            side: str,
            qty: str,
            price: str,
            payload: dict[str, object],
            tca_id: str,
        ) -> tuple[object, ...]:
            return (
                execution_id,
                decision_id,
                decision_created_at,
                event_at,
                event_at,
                "AAPL",
                side,
                Decimal(qty),
                Decimal(price),
                Decimal("0.01"),
                {
                    "cost_amount": "0.01",
                    "cost_basis": "broker_reported_commission_and_fees",
                },
                {},
                "TORGHUT_SIM",
                "microbar-cross-sectional-pairs-v1",
                decision_id,
                payload,
                f"order-{decision_id}",
                f"client-{decision_id}",
                "filled",
                tca_id,
            )

        def order_event_row(
            event_id: str,
            decision_id: str,
            execution_id: str,
            event_at: datetime,
            event_type: str,
            side: str,
            qty: str,
            price: str,
            payload: dict[str, object],
            source_offset: int,
        ) -> tuple[object, ...]:
            is_fill = event_type == "fill"
            return (
                event_id,
                decision_id,
                execution_id,
                event_at,
                "AAPL",
                "TORGHUT_SIM",
                "microbar-cross-sectional-pairs-v1",
                decision_id,
                payload,
                f"order-{decision_id}",
                f"client-{decision_id}",
                event_type,
                "filled" if is_fill else "new",
                side,
                Decimal(qty),
                Decimal(qty) if is_fill else Decimal("0"),
                Decimal(qty) if is_fill else None,
                Decimal(price) if is_fill else None,
                Decimal(qty) * Decimal(price) if is_fill else None,
                "cumulative_to_delta" if is_fill else None,
                f"fingerprint-{event_id}",
                "alpaca.trade_updates",
                0,
                source_offset,
                f"source-window-{event_id}",
                {},
                {
                    "cost_amount": "0.01",
                    "cost_basis": "broker_reported_commission_and_fees",
                },
                {
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
                "inserted",
                None,
                1,
                1,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                [],
            )

        cursor = _FakeCursor()
        cursor._results = [
            [
                decision_row(
                    "decision-buy",
                    window_start + timedelta(minutes=5),
                    entry_payload,
                ),
                decision_row("decision-close", closeout_at, closeout_payload),
            ],
            [
                execution_row(
                    "execution-buy",
                    "decision-buy",
                    window_start + timedelta(minutes=5),
                    window_start + timedelta(minutes=5, seconds=2),
                    "buy",
                    "1",
                    "100",
                    entry_payload,
                    "tca-buy",
                ),
                execution_row(
                    "execution-close",
                    "decision-close",
                    closeout_at,
                    closeout_at + timedelta(seconds=2),
                    "sell",
                    "1",
                    "101",
                    closeout_payload,
                    "tca-close",
                ),
            ],
            [
                order_event_row(
                    "new-buy",
                    "decision-buy",
                    "execution-buy",
                    window_start + timedelta(minutes=5, seconds=1),
                    "new",
                    "buy",
                    "1",
                    "100",
                    entry_payload,
                    10,
                ),
                order_event_row(
                    "fill-buy",
                    "decision-buy",
                    "execution-buy",
                    window_start + timedelta(minutes=5, seconds=2),
                    "fill",
                    "buy",
                    "1",
                    "100",
                    entry_payload,
                    11,
                ),
                order_event_row(
                    "new-close",
                    "decision-close",
                    "execution-close",
                    closeout_at + timedelta(seconds=1),
                    "new",
                    "sell",
                    "1",
                    "101",
                    closeout_payload,
                    12,
                ),
                order_event_row(
                    "fill-close",
                    "decision-close",
                    "execution-close",
                    closeout_at + timedelta(seconds=2),
                    "fill",
                    "sell",
                    "1",
                    "101",
                    closeout_payload,
                    13,
                ),
            ],
            [],
            [],
            [],
            [],
        ]
        connection = _FakeConnection(cursor)
        diagnostics: dict[str, object] = {}

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
                candidate_id="candidate-1",
                hypothesis_id="H-PAIRS-01",
                require_source_lineage=True,
                allow_authoritative_runtime_ledger_materialization=True,
                source_activity_diagnostics=diagnostics,
            )

        self.assertEqual(len(cursor.executed), 7)
        self.assertEqual(
            cursor.executed[0][1][4],
            window_end + timedelta(hours=1),
        )
        self.assertEqual(
            cursor.executed[1][1][4],
            window_end + timedelta(hours=1),
        )
        self.assertEqual(
            cursor.executed[2][1][6],
            window_end + timedelta(hours=1),
        )
        self.assertEqual(len(decisions), 2)
        self.assertEqual(len(executions), 2)
        self.assertEqual(diagnostics["post_window_closeout_decision_count"], 1)
        self.assertEqual(diagnostics["post_window_closeout_execution_count"], 1)
        self.assertEqual(diagnostics["post_window_closeout_order_event_count"], 2)
        runtime_rows = [
            row
            for row in tca_rows
            if row.get("post_cost_expectancy_basis") == POST_COST_BASIS_RUNTIME_LEDGER
        ]
        self.assertEqual(len(runtime_rows), 1)
        runtime_row = runtime_rows[0]
        self.assertTrue(runtime_row["authoritative"])
        self.assertEqual(runtime_row["runtime_ledger_blockers"], [])
        bucket = runtime_row["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertEqual(bucket["closed_trade_count"], 1)
        self.assertEqual(bucket["open_position_count"], 0)
        self.assertEqual(
            bucket["source_window_end"], "2026-03-06T15:05:02.000001+00:00"
        )
        self.assertNotIn("unclosed_position", bucket["blockers"])
        self.assertNotIn(
            "paper_route_target_notional_sizing_missing",
            bucket["blockers"],
        )

    def test_query_timestamps_uses_source_events_but_materializes_target_account(
        self,
    ) -> None:
        cursor = _FakeCursor()
        cursor._results = [
            [
                tuple("PA3SX7FYNUTF" if item == "TORGHUT_SIM" else item for item in row)
                for row in rows
            ]
            for rows in cursor._results
        ]
        connection = _FakeConnection(cursor)
        window_start = datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc)
        diagnostics: dict[str, object] = {}

        with patch(
            "scripts.import_hypothesis_runtime_windows.psycopg.connect",
            return_value=connection,
        ):
            _, _, tca_rows = _query_timestamps(
                dsn="postgresql://example",
                strategy_names=["intraday_tsmom_v1@paper"],
                account_label="PA3SX7FYNUTF",
                target_account_label="TORGHUT_SIM",
                window_start=window_start,
                window_end=window_end,
                source_activity_diagnostics=diagnostics,
            )

        decision_params = cursor.executed[0][1]
        execution_params = cursor.executed[1][1]
        order_event_query, order_event_params = cursor.executed[2]
        self.assertEqual(decision_params[1], "PA3SX7FYNUTF")
        self.assertEqual(execution_params[1], "PA3SX7FYNUTF")
        self.assertEqual(execution_params[2], "PA3SX7FYNUTF")
        self.assertIn("e_match.alpaca_account_label = %s", order_event_query)
        self.assertIn("d_match.alpaca_account_label = %s", order_event_query)
        self.assertEqual(
            order_event_params[:5],
            (
                "PA3SX7FYNUTF",
                "PA3SX7FYNUTF",
                ["intraday_tsmom_v1@paper"],
                "PA3SX7FYNUTF",
                "PA3SX7FYNUTF",
            ),
        )
        self.assertEqual(diagnostics["account_label"], "TORGHUT_SIM")
        self.assertEqual(diagnostics["source_account_label"], "PA3SX7FYNUTF")
        runtime_bucket = tca_rows[0]["runtime_ledger_bucket"]
        self.assertEqual(runtime_bucket["account_label"], "TORGHUT_SIM")
        self.assertEqual(runtime_bucket["source_account_label"], "PA3SX7FYNUTF")
        self.assertEqual(
            diagnostics["order_feed_fill_lifecycle_blockers"],
            ["order_feed_fill_lifecycle_missing"],
        )

    def test_query_timestamps_materializes_source_backed_carry_in(
        self,
    ) -> None:
        def decision_row(
            decision_id: str,
            created_at: datetime,
            decision_hash: str,
        ) -> tuple[object, ...]:
            return (
                decision_id,
                created_at,
                "AAPL",
                "TORGHUT_SIM",
                "microbar-cross-sectional-pairs-v1",
                decision_hash,
                {},
            )

        def execution_row(
            execution_id: str,
            decision_id: str,
            decision_created_at: datetime,
            event_at: datetime,
            side: str,
            qty: str,
            price: str,
            order_id: str,
            decision_hash: str,
        ) -> tuple[object, ...]:
            return (
                execution_id,
                decision_id,
                decision_created_at,
                event_at,
                event_at,
                "AAPL",
                side,
                Decimal(qty),
                Decimal(price),
                Decimal("0.01"),
                {
                    "cost_amount": "0.01",
                    "cost_basis": "broker_reported_commission_and_fees",
                },
                {},
                "TORGHUT_SIM",
                "microbar-cross-sectional-pairs-v1",
                decision_hash,
                {},
                order_id,
                f"client-{order_id}",
                "filled",
            )

        def order_event_row(
            event_id: str,
            decision_id: str,
            execution_id: str,
            event_at: datetime,
            event_type: str,
            side: str,
            qty: str,
            price: str,
            order_id: str,
            decision_hash: str,
            source_offset: int,
        ) -> tuple[object, ...]:
            return (
                event_id,
                decision_id,
                execution_id,
                event_at,
                "AAPL",
                "TORGHUT_SIM",
                "microbar-cross-sectional-pairs-v1",
                decision_hash,
                {},
                order_id,
                f"client-{order_id}",
                event_type,
                "filled" if event_type == "filled" else "new",
                side,
                Decimal(qty),
                Decimal(qty) if event_type == "filled" else Decimal("0"),
                Decimal(price),
                f"fingerprint-{event_id}",
                "alpaca.trade_updates",
                0,
                source_offset,
                f"source-window-{event_id}",
                {},
                {
                    "cost_amount": "0.01",
                    "cost_basis": "broker_reported_commission_and_fees",
                },
                {},
            )

        cursor = _FakeCursor()
        cursor._results = [
            [
                decision_row(
                    "decision-sell-id",
                    datetime(2026, 3, 6, 14, 39, tzinfo=timezone.utc),
                    "decision-sell",
                )
            ],
            [
                execution_row(
                    "execution-sell",
                    "decision-sell-id",
                    datetime(2026, 3, 6, 14, 39, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
                    "sell",
                    "1",
                    "101",
                    "order-sell",
                    "decision-sell",
                )
            ],
            [
                order_event_row(
                    "event-new-sell",
                    "decision-sell-id",
                    "execution-sell",
                    datetime(2026, 3, 6, 14, 39, 1, tzinfo=timezone.utc),
                    "new",
                    "sell",
                    "1",
                    "101",
                    "order-sell",
                    "decision-sell",
                    201,
                ),
                order_event_row(
                    "event-fill-sell",
                    "decision-sell-id",
                    "execution-sell",
                    datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
                    "filled",
                    "sell",
                    "1",
                    "101",
                    "order-sell",
                    "decision-sell",
                    202,
                ),
            ],
            [
                decision_row(
                    "decision-buy-id",
                    datetime(2026, 3, 6, 14, 34, tzinfo=timezone.utc),
                    "decision-buy",
                )
            ],
            [
                execution_row(
                    "execution-buy",
                    "decision-buy-id",
                    datetime(2026, 3, 6, 14, 34, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                    "buy",
                    "1",
                    "100",
                    "order-buy",
                    "decision-buy",
                )
            ],
            [
                order_event_row(
                    "event-new-buy",
                    "decision-buy-id",
                    "execution-buy",
                    datetime(2026, 3, 6, 14, 34, 1, tzinfo=timezone.utc),
                    "new",
                    "buy",
                    "1",
                    "100",
                    "order-buy",
                    "decision-buy",
                    199,
                ),
                order_event_row(
                    "event-fill-buy",
                    "decision-buy-id",
                    "execution-buy",
                    datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                    "filled",
                    "buy",
                    "1",
                    "100",
                    "order-buy",
                    "decision-buy",
                    200,
                ),
            ],
            [],
        ]
        connection = _FakeConnection(cursor)
        diagnostics: dict[str, object] = {}

        with patch(
            "scripts.import_hypothesis_runtime_windows.psycopg.connect",
            return_value=connection,
        ):
            _, _, tca_rows = _query_timestamps(
                dsn="postgresql://example",
                strategy_names=["microbar-cross-sectional-pairs-v1"],
                account_label="TORGHUT_SIM",
                window_start=datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
                window_end=datetime(2026, 3, 6, 14, 45, tzinfo=timezone.utc),
                symbols=["AAPL"],
                allow_authoritative_runtime_ledger_materialization=True,
                source_activity_diagnostics=diagnostics,
            )

        self.assertEqual(len(cursor.executed), 8)
        carry_decision_query, carry_decision_params = cursor.executed[3]
        carry_execution_query, carry_execution_params = cursor.executed[4]
        carry_order_query, carry_order_params = cursor.executed[5]
        self.assertIn("d.created_at >= %s", carry_decision_query)
        self.assertIn("d.created_at < %s", carry_decision_query)
        self.assertIn("from executions e", carry_execution_query)
        self.assertIn("from execution_order_events oe", carry_order_query)
        self.assertEqual(
            carry_decision_params[3],
            datetime(2026, 3, 1, 14, 40, tzinfo=timezone.utc),
        )
        self.assertEqual(
            carry_execution_params[3],
            datetime(2026, 3, 1, 14, 40, tzinfo=timezone.utc),
        )
        self.assertEqual(
            carry_order_params[5],
            datetime(2026, 3, 1, 14, 40, tzinfo=timezone.utc),
        )
        self.assertEqual(diagnostics["carry_in_decision_rows_before_lineage_filter"], 1)
        self.assertEqual(diagnostics["carry_in_decision_rows_after_lineage_filter"], 1)
        self.assertEqual(
            diagnostics["carry_in_execution_rows_before_lineage_filter"], 1
        )
        self.assertEqual(diagnostics["carry_in_execution_rows_after_lineage_filter"], 1)
        self.assertEqual(
            diagnostics["carry_in_fill_execution_rows_before_lineage_filter"], 1
        )
        self.assertEqual(
            diagnostics["carry_in_fill_execution_rows_after_lineage_filter"], 1
        )
        self.assertEqual(
            diagnostics["carry_in_order_lifecycle_rows_before_lineage_filter"], 2
        )
        self.assertEqual(
            diagnostics["carry_in_order_lifecycle_rows_after_lineage_filter"], 2
        )
        self.assertEqual(
            diagnostics["carry_in_fill_order_lifecycle_rows_before_lineage_filter"], 1
        )
        self.assertEqual(
            diagnostics["carry_in_fill_order_lifecycle_rows_after_lineage_filter"], 1
        )
        runtime_rows = [
            row
            for row in tca_rows
            if row.get("post_cost_expectancy_basis") == POST_COST_BASIS_RUNTIME_LEDGER
        ]
        self.assertEqual(len(runtime_rows), 1)
        bucket = runtime_rows[0]["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertEqual(bucket["closed_trade_count"], 1)
        self.assertEqual(bucket["open_position_count"], 0)
        self.assertEqual(bucket["source_window_start"], "2026-03-06T14:34:01+00:00")
        self.assertEqual(
            bucket["source_window_end"], "2026-03-06T14:40:00.000001+00:00"
        )
        self.assertFalse(diagnostics["flat_start_position_snapshot_present"])
        self.assertEqual(
            diagnostics["flat_start_position_snapshot_query_error"], "IndexError"
        )

    def test_query_timestamps_records_clean_flat_start_snapshot_diagnostics(
        self,
    ) -> None:
        cursor = _FakeCursor()
        window_start = datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc)
        cursor._results = [
            *cursor._results,
            [],
            [],
            [],
            [
                (
                    "snapshot-flat",
                    window_start,
                    [],
                    "latest_before_window_start",
                    0,
                )
            ],
        ]
        connection = _FakeConnection(cursor)
        diagnostics: dict[str, object] = {}

        with patch(
            "scripts.import_hypothesis_runtime_windows.psycopg.connect",
            return_value=connection,
        ):
            _, _, tca_rows = _query_timestamps(
                dsn="postgresql://example",
                strategy_names=["intraday_tsmom_v1@paper"],
                account_label="TORGHUT_SIM",
                window_start=window_start,
                window_end=datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                allow_authoritative_runtime_ledger_materialization=True,
                source_activity_diagnostics=diagnostics,
            )

        self.assertTrue(diagnostics["flat_start_position_snapshot_present"])
        self.assertEqual(
            diagnostics["flat_start_position_snapshot_id"], "snapshot-flat"
        )
        self.assertTrue(diagnostics["flat_start_position_snapshot_flat"])
        self.assertTrue(diagnostics["carry_in_rows_suppressed_by_flat_start_snapshot"])
        self.assertEqual(len(tca_rows), 1)
        self.assertTrue(tca_rows[0]["carry_in_rows_suppressed_by_flat_start_snapshot"])
        bucket = tca_rows[0]["runtime_ledger_bucket"]
        assert isinstance(bucket, dict)
        self.assertTrue(bucket["carry_in_rows_suppressed_by_flat_start_snapshot"])

    def test_source_activity_diagnostic_blockers_classify_materialization_gap(
        self,
    ) -> None:
        self.assertEqual(
            _source_activity_diagnostics_blockers(
                {
                    "decision_rows_before_lineage_filter": 2,
                    "decision_rows_after_lineage_filter": 0,
                    "execution_rows_before_lineage_filter": 1,
                    "execution_rows_after_lineage_filter": 0,
                    "runtime_ledger_source_bucket_count": 0,
                }
            ),
            [
                "source_lineage_filter_excluded_activity",
                "runtime_ledger_source_bucket_missing",
            ],
        )
        self.assertEqual(
            _source_activity_diagnostics_blockers(
                {
                    "decision_rows_before_lineage_filter": 1,
                    "decision_rows_after_lineage_filter": 1,
                    "execution_rows_before_lineage_filter": 0,
                    "execution_rows_after_lineage_filter": 0,
                    "runtime_ledger_source_bucket_count": 0,
                }
            ),
            [
                "execution_rows_missing_for_matched_decisions",
                "runtime_ledger_source_bucket_missing",
            ],
        )
        self.assertEqual(
            _source_activity_diagnostics_blockers(
                {
                    "decision_rows_before_lineage_filter": 1,
                    "decision_rows_after_lineage_filter": 1,
                    "execution_rows_before_lineage_filter": 1,
                    "execution_rows_after_lineage_filter": 1,
                    "order_lifecycle_rows_before_lineage_filter": 1,
                    "execution_tca_rows_after_lineage_filter": 1,
                    "runtime_ledger_source_bucket_count": 1,
                    "runtime_ledger_source_bucket_profit_proof_count": 0,
                    "runtime_ledger_source_bucket_profit_proof_blockers": [
                        "runtime_ledger_lineage_hash_missing"
                    ],
                }
            ),
            [
                "runtime_ledger_source_bucket_profit_proof_missing",
                "runtime_ledger_lineage_hash_missing",
            ],
        )

    def test_query_timestamps_filters_to_target_symbols_when_configured(
        self,
    ) -> None:
        cursor = _FakeCursor()
        cursor._results.insert(3, [])
        connection = _FakeConnection(cursor)
        window_start = datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc)

        with patch(
            "scripts.import_hypothesis_runtime_windows.psycopg.connect",
            return_value=connection,
        ):
            _query_timestamps(
                dsn="postgresql://example",
                strategy_names=["intraday_tsmom_v1@paper"],
                account_label="TORGHUT_SIM",
                window_start=window_start,
                window_end=window_end,
                symbols=[" aapl ", "AAPL"],
            )

        self.assertEqual(len(cursor.executed), 4)
        decision_query, decision_params = cursor.executed[0]
        execution_query, execution_params = cursor.executed[1]
        order_event_query, order_event_params = cursor.executed[2]
        unlinked_query, unlinked_params = cursor.executed[3]
        self.assertIn("upper(d.symbol) = any(%s)", decision_query)
        self.assertEqual(decision_params[-1], ["AAPL"])
        self.assertIn("upper(d.symbol) = any(%s)", execution_query)
        self.assertIn("upper(e.symbol) = any(%s)", execution_query)
        self.assertEqual(execution_params[-2:], (["AAPL"], ["AAPL"]))
        self.assertIn("upper(d.symbol) = any(%s)", order_event_query)
        self.assertIn(
            "upper(coalesce(oe.symbol, e.symbol, d.symbol)) = any(%s)",
            order_event_query,
        )
        self.assertEqual(order_event_params[-2:], (["AAPL"], ["AAPL"]))
        self.assertIn("from execution_order_events oe", unlinked_query)
        self.assertIn("left join lateral", unlinked_query)
        self.assertIn("exact_match.match_count = 1", unlinked_query)
        self.assertIn(
            "or coalesce(oe.trade_decision_id, e.trade_decision_id, d_by_client.id) is null",
            unlinked_query,
        )
        self.assertIn("exact_decision_match.match_count = 1", unlinked_query)
        self.assertIn("d_match.decision_hash = oe.client_order_id", unlinked_query)
        self.assertIn("upper(oe.symbol) = any(%s)", unlinked_query)
        self.assertEqual(unlinked_params[-1], ["AAPL"])
