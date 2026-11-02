from __future__ import annotations

from tests.runtime_window_import.runtime_window_import_base import (
    Decimal,
    EXECUTION_ELIGIBLE_DECISION_STATUSES,
    POST_COST_BASIS_EXECUTION_RECONSTRUCTION,
    RuntimeWindowImportTestCaseBase,
    _FakeConnection,
    _FakeCursor,
    _query_timestamps,
    _source_activity_diagnostics_blockers,
    datetime,
    patch,
    timezone,
)


class TestRuntimeWindowImportQueryTimestampsA(RuntimeWindowImportTestCaseBase):
    def test_query_timestamps_filters_to_execution_eligible_decisions(self) -> None:
        cursor = _FakeCursor()
        connection = _FakeConnection(cursor)
        window_start = datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc)
        diagnostics: dict[str, object] = {}

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
                source_activity_diagnostics=diagnostics,
            )

        self.assertEqual(decisions, [datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc)])
        self.assertEqual(
            executions, [datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc)]
        )
        self.assertEqual(len(tca_rows), 1)
        self.assertEqual(
            tca_rows[0]["post_cost_expectancy_basis"],
            POST_COST_BASIS_EXECUTION_RECONSTRUCTION,
        )
        self.assertEqual(tca_rows[0]["post_cost_promotion_eligible"], False)
        self.assertIn("unclosed_position", tca_rows[0]["runtime_ledger_blockers"])
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
        order_event_query, _ = cursor.executed[2]
        execution_query, _ = cursor.executed[1]
        self.assertIn("left join execution_tca_metrics", execution_query)
        self.assertIn("e.alpaca_account_label = %s", execution_query)
        self.assertIn("e.order_feed_last_event_ts", execution_query)
        self.assertIn("e.last_update_at", execution_query)
        self.assertIn("e.updated_at", execution_query)
        self.assertIn("e.created_at", execution_query)
        self.assertNotIn("and d.created_at >= %s", execution_query)
        self.assertNotIn("and d.created_at < %s", execution_query)
        self.assertIn("from execution_order_events oe", order_event_query)
        self.assertIn("oe.alpaca_account_label = %s", order_event_query)
        self.assertIn("e.execution_audit_json", order_event_query)
        self.assertIn("e.raw_order", order_event_query)
        self.assertIn("coalesce(oe.event_ts, oe.created_at) >= %s", order_event_query)
        self.assertIn("coalesce(oe.event_ts, oe.created_at) < %s", order_event_query)
        self.assertNotIn("and d.created_at >= %s", order_event_query)
        self.assertNotIn("and d.created_at < %s", order_event_query)
        self.assertEqual(diagnostics["decision_rows_before_lineage_filter"], 1)
        self.assertEqual(diagnostics["decision_rows_after_lineage_filter"], 1)
        self.assertEqual(diagnostics["execution_rows_before_lineage_filter"], 1)
        self.assertEqual(diagnostics["execution_rows_after_lineage_filter"], 1)
        self.assertEqual(diagnostics["execution_tca_rows_before_lineage_filter"], 1)
        self.assertEqual(diagnostics["execution_tca_rows_after_lineage_filter"], 1)
        self.assertEqual(diagnostics["order_lifecycle_rows_before_lineage_filter"], 1)

    def test_query_timestamps_records_unattributed_fill_lifecycle_diagnostics(
        self,
    ) -> None:
        cursor = _FakeCursor()
        cursor._results = [
            [],
            [],
            [],
            [
                (
                    "unlinked-event-id",
                    None,
                    None,
                    datetime(2026, 3, 6, 14, 41, tzinfo=timezone.utc),
                    "AAPL",
                    "TORGHUT_SIM",
                    None,
                    None,
                    None,
                    "external-close-order",
                    "external-close-client",
                    "fill",
                    "filled",
                    "unlinked-event-fingerprint",
                    "alpaca-trade-updates",
                    0,
                    42,
                    "source-window-external",
                    {},
                    None,
                    None,
                )
            ],
            [],
        ]
        connection = _FakeConnection(cursor)
        diagnostics: dict[str, object] = {}

        with patch(
            "scripts.import_hypothesis_runtime_windows.psycopg.connect",
            return_value=connection,
        ):
            _query_timestamps(
                dsn="postgresql://example",
                strategy_names=["microbar-cross-sectional-pairs-v1"],
                account_label="TORGHUT_SIM",
                window_start=datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                window_end=datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                symbols=["AAPL"],
                source_activity_diagnostics=diagnostics,
            )

        self.assertEqual(len(cursor.executed), 4)
        unlinked_query, unlinked_params = cursor.executed[3]
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
        self.assertEqual(diagnostics["order_feed_unlinked_fill_lifecycle_count"], 1)
        self.assertEqual(
            diagnostics["order_feed_unlinked_fill_lifecycle_event_ids"],
            ["unlinked-event-id"],
        )
        self.assertEqual(
            diagnostics["order_feed_unlinked_strategy_fill_lifecycle_count"], 0
        )
        self.assertEqual(
            diagnostics["order_feed_unlinked_strategy_fill_lifecycle_event_ids"],
            [],
        )
        self.assertEqual(diagnostics["order_feed_unattributed_fill_lifecycle_count"], 1)
        self.assertEqual(
            diagnostics["order_feed_unattributed_fill_lifecycle_event_ids"],
            ["unlinked-event-id"],
        )
        self.assertNotIn(
            "order_feed_unlinked_fill_lifecycle_present",
            _source_activity_diagnostics_blockers(diagnostics),
        )

    def test_query_timestamps_blocks_strategy_matching_unlinked_fill_lifecycle(
        self,
    ) -> None:
        cursor = _FakeCursor()
        execution_row = _FakeCursor()._results[1][0]
        cursor._results = [
            [],
            [execution_row],
            [],
            [
                (
                    "unlinked-event-id",
                    None,
                    None,
                    datetime(2026, 3, 6, 14, 41, tzinfo=timezone.utc),
                    "AAPL",
                    "TORGHUT_SIM",
                    None,
                    None,
                    None,
                    "alpaca-order-1",
                    "client-order-1",
                    "fill",
                    "filled",
                    "unlinked-event-fingerprint",
                    "alpaca-trade-updates",
                    0,
                    42,
                    "source-window-external",
                    {},
                    None,
                    None,
                )
            ],
            [],
        ]
        connection = _FakeConnection(cursor)
        diagnostics: dict[str, object] = {}

        with patch(
            "scripts.import_hypothesis_runtime_windows.psycopg.connect",
            return_value=connection,
        ):
            _query_timestamps(
                dsn="postgresql://example",
                strategy_names=["microbar-cross-sectional-pairs-v1"],
                account_label="TORGHUT_SIM",
                window_start=datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                window_end=datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                symbols=["AAPL"],
                source_activity_diagnostics=diagnostics,
            )

        self.assertEqual(diagnostics["order_feed_unlinked_fill_lifecycle_count"], 1)
        self.assertEqual(
            diagnostics["order_feed_unlinked_strategy_fill_lifecycle_count"], 1
        )
        self.assertEqual(
            diagnostics["order_feed_unlinked_strategy_fill_lifecycle_event_ids"],
            ["unlinked-event-id"],
        )
        self.assertEqual(diagnostics["order_feed_unattributed_fill_lifecycle_count"], 0)
        self.assertIn(
            "order_feed_unlinked_fill_lifecycle_present",
            _source_activity_diagnostics_blockers(diagnostics),
        )

    def test_query_timestamps_materializes_exact_order_identity_lifecycle(
        self,
    ) -> None:
        cursor = _FakeCursor()
        cursor._results = [
            [
                (
                    "decision-id-1",
                    datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                    "AAPL",
                    "TORGHUT_SIM",
                    "microbar-cross-sectional-pairs-v1",
                    "decision-sha",
                    {},
                )
            ],
            [_FakeCursor()._results[1][0]],
            [
                (
                    "source-event-id-1",
                    "decision-id-1",
                    "execution-id-1",
                    datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    "AAPL",
                    "TORGHUT_SIM",
                    "microbar-cross-sectional-pairs-v1",
                    "decision-sha",
                    {},
                    "alpaca-order-1",
                    "client-order-1",
                    "fill",
                    "filled",
                    "buy",
                    Decimal("1"),
                    Decimal("1"),
                    Decimal("100"),
                    "source-event-fingerprint-1",
                    "torghut.trade-updates.v1",
                    0,
                    35803,
                    "source-window-1",
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
                )
            ],
            [],
        ]
        connection = _FakeConnection(cursor)
        diagnostics: dict[str, object] = {}

        with patch(
            "scripts.import_hypothesis_runtime_windows.psycopg.connect",
            return_value=connection,
        ):
            _query_timestamps(
                dsn="postgresql://example",
                strategy_names=["microbar-cross-sectional-pairs-v1"],
                account_label="TORGHUT_SIM",
                window_start=datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                window_end=datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                symbols=["AAPL"],
                source_activity_diagnostics=diagnostics,
            )

        order_event_query, _ = cursor.executed[2]
        unlinked_query, _ = cursor.executed[3]
        self.assertIn("left join lateral", order_event_query)
        self.assertIn("exact_match.match_count = 1", order_event_query)
        self.assertIn(
            "coalesce(oe.trade_decision_id, e.trade_decision_id, d_by_client.id)",
            order_event_query,
        )
        self.assertIn("exact_decision_match.match_count = 1", order_event_query)
        self.assertIn("d_match.decision_hash = oe.client_order_id", order_event_query)
        self.assertIn("left join lateral", unlinked_query)
        self.assertIn("exact_match.match_count = 1", unlinked_query)
        self.assertIn("exact_decision_match.match_count = 1", unlinked_query)
        self.assertIn("d_match.decision_hash = oe.client_order_id", unlinked_query)
        self.assertEqual(diagnostics["order_feed_unlinked_fill_lifecycle_count"], 0)
        self.assertEqual(
            diagnostics["order_feed_unlinked_strategy_fill_lifecycle_count"], 0
        )
        self.assertEqual(
            diagnostics["fill_order_lifecycle_rows_after_lineage_filter"], 1
        )
        self.assertNotIn(
            "order_feed_unlinked_fill_lifecycle_present",
            _source_activity_diagnostics_blockers(diagnostics),
        )
