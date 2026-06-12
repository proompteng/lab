from __future__ import annotations

# ruff: noqa: F403,F405
from tests.runtime_window_import.runtime_window_import_base import *


class TestRuntimeWindowImportSourceContext(RuntimeWindowImportTestCaseBase):
    def test_post_window_closeout_helpers_fail_closed(self) -> None:
        window_end = datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc)

        self.assertFalse(
            _source_row_lineage_missing_or_matches(
                {"candidate_id": "other-candidate"},
                candidate_id="candidate-1",
                hypothesis_id=None,
            )
        )
        self.assertFalse(
            _source_row_lineage_missing_or_matches(
                {"hypothesis_id": "other-hypothesis"},
                candidate_id=None,
                hypothesis_id="H-PAIRS-01",
            )
        )
        self.assertEqual(
            _runtime_open_qtys_by_symbol_from_execution_rows(
                [
                    {"symbol": "AAPL", "side": "buy", "filled_qty": "0"},
                    {
                        "side": "buy",
                        "filled_qty": "1",
                        "avg_fill_price": "100",
                    },
                    {
                        "symbol": "MSFT",
                        "side": "hold",
                        "filled_qty": "1",
                        "avg_fill_price": "100",
                    },
                ]
            ),
            {},
        )
        self.assertFalse(
            _source_decision_action_offsets_open_qty(
                {"action": "sell"},
                open_qtys={"AAPL": Decimal("1")},
            )
        )
        self.assertFalse(
            _source_decision_action_offsets_open_qty(
                {"symbol": "AAPL", "action": "sell"},
                open_qtys={},
            )
        )
        self.assertTrue(
            _source_decision_action_offsets_open_qty(
                {"symbol": "AAPL", "action": "buy"},
                open_qtys={"AAPL": Decimal("-1")},
            )
        )

        decisions, executions, order_rows, diagnostics = (
            _filter_source_rows_for_runtime_window(
                decision_rows=[
                    {
                        "trade_decision_id": "decision-close",
                        "computed_at": window_end + timedelta(minutes=5),
                        "symbol": "AAPL",
                        "action": "sell",
                        "source_decision_mode": "bounded_paper_route_collection",
                    }
                ],
                execution_rows=[],
                order_lifecycle_rows=[],
                window_end=window_end,
                closeout_end=window_end + timedelta(hours=1),
                candidate_id="candidate-1",
                hypothesis_id="H-PAIRS-01",
                require_source_lineage=True,
            )
        )

        self.assertEqual(decisions, [])
        self.assertEqual(executions, [])
        self.assertEqual(order_rows, [])
        self.assertEqual(diagnostics["post_window_closeout_decision_count"], 0)
        self.assertEqual(diagnostics["post_window_closeout_open_qty_by_symbol"], {})

    def test_runtime_rows_fail_closed_on_non_authoritative_target_notional_sizing(
        self,
    ) -> None:
        decision_rows, order_rows, execution_rows = _source_backed_runtime_split_rows()
        for row in decision_rows:
            row["source_decision_mode"] = "bounded_paper_route_collection"
            row["paper_route_probe_target_notional"] = "150"
            row["decision_json"] = {
                "source_decision_mode": "bounded_paper_route_collection",
                "paper_route_probe_target_notional": "150",
                "paper_route_target_notional_sizing": {
                    "sizing_source": "max_notional",
                    "blockers": ["paper_route_target_notional_qty_below_min_step"],
                },
            }

        rows = _build_realized_strategy_pnl_rows(
            execution_rows,
            decision_lifecycle_rows=decision_rows,
            order_lifecycle_rows=order_rows,
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 2)
        for row in rows:
            self.assertFalse(row["post_cost_promotion_eligible"])
            self.assertIn("promotion_blocker", row)
        rows_with_sizing = [
            row for row in rows if "paper_route_target_notional_sizing" in row
        ]
        self.assertTrue(rows_with_sizing)
        for row in rows_with_sizing:
            self.assertIn(
                "paper_route_target_notional_sizing_not_authoritative",
                row["runtime_ledger_blockers"],
            )
            self.assertIn(
                "paper_route_target_notional_qty_below_min_step",
                row["runtime_ledger_blockers"],
            )
            sizing = row["paper_route_target_notional_sizing"]
            self.assertEqual(sizing["authoritative_target_notional_sizing_count"], 0)
            self.assertEqual(
                sizing["non_authoritative_sizing_source_counts"],
                {"max_notional": 2},
            )
            bucket = row["runtime_ledger_bucket"]
            assert isinstance(bucket, dict)
            self.assertEqual(bucket["paper_route_target_notional_sizing"], sizing)

    def test_runtime_ledger_tca_refs_accept_readback_aliases(self) -> None:
        readback_alias_bucket = _complete_runtime_ledger_bucket(
            execution_tca_metric_ids=[],
            runtime_ledger_execution_tca_metric_ids=["tca-buy", "tca-sell"],
        )
        readback_alias_blockers = _runtime_ledger_bucket_profit_proof_blockers(
            readback_alias_bucket
        )
        self.assertNotIn("execution_tca_missing", readback_alias_blockers)
        self.assertNotIn(
            "runtime_ledger_execution_tca_refs_missing",
            readback_alias_blockers,
        )

        split_alias_bucket = _complete_runtime_ledger_bucket(
            execution_tca_metric_ids=["tca-buy"],
            runtime_ledger_execution_tca_metric_ids=["tca-sell"],
        )
        split_alias_blockers = _runtime_ledger_bucket_profit_proof_blockers(
            split_alias_bucket
        )
        self.assertNotIn("execution_tca_missing", split_alias_blockers)
        self.assertNotIn(
            "runtime_ledger_execution_tca_refs_missing",
            split_alias_blockers,
        )

        mapping_alias_bucket = _complete_runtime_ledger_bucket(
            execution_tca_metric_ids={"id": "tca-buy"},
            runtime_ledger_execution_tca_metric_ids=[{"ref": "tca-sell"}],
        )
        mapping_alias_blockers = _runtime_ledger_bucket_profit_proof_blockers(
            mapping_alias_bucket
        )
        self.assertNotIn("execution_tca_missing", mapping_alias_blockers)
        self.assertNotIn(
            "runtime_ledger_execution_tca_refs_missing",
            mapping_alias_blockers,
        )

        missing_ref_bucket = _complete_runtime_ledger_bucket(
            execution_tca_metric_ids={"ignored": "not-a-ref"},
            execution_tca_metric_refs=["tca-buy"],
        )
        missing_ref_blockers = _runtime_ledger_bucket_profit_proof_blockers(
            missing_ref_bucket
        )
        self.assertIn("execution_tca_missing", missing_ref_blockers)
        self.assertIn(
            "runtime_ledger_execution_tca_refs_missing",
            missing_ref_blockers,
        )

    def test_execution_economics_without_order_lifecycle_blocks_missing_lifecycle(
        self,
    ) -> None:
        decision_rows, _order_rows, execution_rows = _source_backed_runtime_split_rows(
            include_order_lifecycle=False
        )

        rows = _build_realized_strategy_pnl_rows(
            execution_rows,
            decision_lifecycle_rows=decision_rows,
            order_lifecycle_rows=[],
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertFalse(row["authoritative"])
        bucket = row["runtime_ledger_bucket"]
        assert isinstance(bucket, dict)
        self.assertFalse(bucket["order_feed_lifecycle_complete"])
        self.assertTrue(bucket["execution_economics_complete"])
        self.assertIn("order_feed_lifecycle_missing", row["runtime_ledger_blockers"])
        self.assertIn(
            "order_feed_fill_lifecycle_missing", row["runtime_ledger_blockers"]
        )
        self.assertNotIn("execution_economics_missing", row["runtime_ledger_blockers"])

    def test_order_feed_fill_without_submitted_lifecycle_blocks_lifecycle_contract(
        self,
    ) -> None:
        decision_rows, order_rows, execution_rows = _source_backed_runtime_split_rows(
            include_submitted_lifecycle=False
        )

        rows = _build_realized_strategy_pnl_rows(
            execution_rows,
            decision_lifecycle_rows=decision_rows,
            order_lifecycle_rows=order_rows,
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertFalse(row["authoritative"])
        bucket = row["runtime_ledger_bucket"]
        assert isinstance(bucket, dict)
        self.assertFalse(bucket["order_feed_lifecycle_complete"])
        self.assertTrue(bucket["execution_economics_complete"])
        self.assertIn("order_feed_lifecycle_missing", row["runtime_ledger_blockers"])
        self.assertIn(
            "submitted_order_lifecycle_missing", row["runtime_ledger_blockers"]
        )
        self.assertIn("fill_order_submission_missing", row["runtime_ledger_blockers"])

    def test_carry_in_lifecycle_only_filters_mismatched_decision_rows(
        self,
    ) -> None:
        decision_rows, order_rows, execution_rows = _source_backed_runtime_split_rows()

        rows = _build_realized_strategy_pnl_rows(
            execution_rows,
            decision_lifecycle_rows=decision_rows,
            order_lifecycle_rows=order_rows,
            carry_in_decision_lifecycle_rows=[
                {
                    "trade_decision_id": "carry-decision",
                    "computed_at": _runtime_split_ts(-2),
                    "event_type": "decision",
                    "symbol": "NVDA",
                    "account_label": "paper",
                    "strategy_id": "strategy-1",
                    "decision_hash": "carry-decision",
                    "decision_json": {"source_decision_mode": "strategy_signal_paper"},
                    "source_decision_mode": "strategy_signal_paper",
                    "lineage_hash": "lineage",
                },
            ],
            carry_in_order_lifecycle_rows=[
                {
                    "trade_decision_id": "other-carry-decision",
                    "event_ts": _runtime_split_ts(-1),
                    "event_type": "new",
                    "symbol": "NVDA",
                    "account_label": "paper",
                    "strategy_id": "strategy-1",
                    "decision_hash": "other-carry-decision",
                    "alpaca_order_id": "carry-unrelated-order",
                    "execution_order_event_id": "event-carry-unrelated-order",
                    "source_window_id": "window-carry-unrelated-order",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 902,
                    "source_decision_mode": "strategy_signal_paper",
                    "lineage_hash": "lineage",
                },
            ],
            carry_in_execution_rows=[
                {
                    "execution_id": "old-route-buy-exec",
                    "trade_decision_id": "old-route-buy-decision",
                    "computed_at": datetime(2026, 6, 1, 14, 0, tzinfo=timezone.utc),
                    "execution_event_at": datetime(
                        2026, 6, 1, 14, 0, 2, tzinfo=timezone.utc
                    ),
                    "symbol": "AAPL",
                    "side": "buy",
                    "filled_qty": Decimal("2"),
                    "avg_fill_price": Decimal("90"),
                    "cost_amount": Decimal("0.10"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "intraday-tsmom-profit-v3",
                    "decision_hash": "old-route-buy-hash",
                    "alpaca_order_id": "old-route-buy-order",
                    "execution_policy_hash": "old-route-policy",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_decision_mode": "route_acquisition_probe",
                    "profit_proof_eligible": False,
                },
                {
                    "execution_id": "old-route-sell-exec",
                    "trade_decision_id": "old-route-sell-decision",
                    "computed_at": datetime(2026, 6, 1, 14, 5, tzinfo=timezone.utc),
                    "execution_event_at": datetime(
                        2026, 6, 1, 14, 5, 2, tzinfo=timezone.utc
                    ),
                    "symbol": "AAPL",
                    "side": "sell",
                    "filled_qty": Decimal("2"),
                    "avg_fill_price": Decimal("91"),
                    "cost_amount": Decimal("0.10"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "intraday-tsmom-profit-v3",
                    "decision_hash": "old-route-sell-hash",
                    "alpaca_order_id": "old-route-sell-order",
                    "execution_policy_hash": "old-route-policy",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_decision_mode": "route_acquisition_probe",
                    "profit_proof_eligible": False,
                },
            ],
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        bucket = rows[0]["runtime_ledger_bucket"]
        assert isinstance(bucket, dict)
        self.assertNotIn("window-carry-unrelated-order", bucket["source_window_ids"])
        self.assertNotIn(
            "route_acquisition_probe",
            bucket["source_decision_mode_counts"],
        )

    def test_flat_start_snapshot_authority_requires_clean_flat_account(
        self,
    ) -> None:
        valid = _flat_start_position_snapshot_authority(
            {
                "snapshot_id": "snapshot-flat",
                "snapshot_as_of": "2026-06-02T14:30:00+00:00",
                "flat": True,
                "position_count": 0,
                "positions": "[]",
                "blockers": [],
            }
        )

        self.assertIsNotNone(valid)
        assert valid is not None
        self.assertEqual(valid["flat_start_position_snapshot_id"], "snapshot-flat")
        self.assertTrue(valid["carry_in_rows_suppressed_by_flat_start_snapshot"])

        for name, snapshot in {
            "missing_id": {
                "snapshot_as_of": "2026-06-02T14:30:00+00:00",
                "flat": True,
                "position_count": 0,
            },
            "blocked": {
                "snapshot_id": "snapshot-blocked",
                "snapshot_as_of": "2026-06-02T14:30:00+00:00",
                "flat": True,
                "position_count": 0,
                "blockers": ["runtime_ledger_flat_start_position_snapshot_stale"],
            },
            "nonflat_count": {
                "snapshot_id": "snapshot-nonflat-count",
                "snapshot_as_of": "2026-06-02T14:30:00+00:00",
                "flat": True,
                "position_count": 1,
            },
            "nonflat_positions": {
                "snapshot_id": "snapshot-nonflat-positions",
                "snapshot_as_of": "2026-06-02T14:30:00+00:00",
                "flat": True,
                "positions": [{"symbol": "AAPL", "qty": "1"}],
            },
            "invalid_positions_json": {
                "snapshot_id": "snapshot-invalid-positions-json",
                "snapshot_as_of": "2026-06-02T14:30:00+00:00",
                "flat": True,
                "positions": "not-json",
            },
            "invalid_positions_bytes": {
                "snapshot_id": "snapshot-invalid-positions-bytes",
                "snapshot_as_of": "2026-06-02T14:30:00+00:00",
                "flat": True,
                "positions": b"[]",
            },
            "invalid_position_row": {
                "snapshot_id": "snapshot-invalid-position-row",
                "snapshot_as_of": "2026-06-02T14:30:00+00:00",
                "flat": True,
                "positions": [{"symbol": "AAPL"}],
            },
            "not_explicitly_flat": {
                "snapshot_id": "snapshot-not-flat",
                "snapshot_as_of": "2026-06-02T14:30:00+00:00",
                "flat": False,
                "position_count": 0,
            },
        }.items():
            with self.subTest(name=name):
                self.assertIsNone(_flat_start_position_snapshot_authority(snapshot))

    def test_flat_start_snapshot_query_marks_stale_and_nonflat_blockers(
        self,
    ) -> None:
        cursor = _FakeCursor()
        cursor._results = [
            [
                (
                    "snapshot-stale",
                    datetime(2026, 6, 2, 14, 0, tzinfo=timezone.utc),
                    [{"symbol": "AAPL", "qty": "1"}],
                    "latest_before_window_start",
                    0,
                )
            ]
        ]

        snapshot = _flat_start_position_snapshot_from_cursor(
            cursor,
            account_label="TORGHUT_SIM",
            window_start=datetime(2026, 6, 2, 14, 30, tzinfo=timezone.utc),
        )

        self.assertIsNotNone(snapshot)
        assert snapshot is not None
        self.assertEqual(snapshot["snapshot_id"], "snapshot-stale")
        self.assertFalse(snapshot["flat"])
        self.assertEqual(snapshot["position_count"], 1)
        self.assertEqual(
            snapshot["blockers"],
            [
                "runtime_ledger_flat_start_position_snapshot_stale",
                "runtime_ledger_flat_start_position_snapshot_not_flat",
            ],
        )
        query, params = cursor.executed[0]
        self.assertIn("from position_snapshots", query)
        self.assertIn("order by snapshot_priority", query)
        self.assertEqual(params[0], "TORGHUT_SIM")

    def test_flat_start_snapshot_query_rejects_invalid_snapshot_payloads(
        self,
    ) -> None:
        invalid_time_cursor = _FakeCursor()
        invalid_time_cursor._results = [
            [
                (
                    "snapshot-invalid-time",
                    "not-a-timestamp",
                    [],
                    "latest_before_window_start",
                    0,
                )
            ]
        ]

        self.assertIsNone(
            _flat_start_position_snapshot_from_cursor(
                invalid_time_cursor,
                account_label="TORGHUT_SIM",
                window_start=datetime(2026, 6, 2, 14, 30, tzinfo=timezone.utc),
            )
        )

        invalid_positions_cursor = _FakeCursor()
        invalid_positions_cursor._results = [
            [
                (
                    "snapshot-invalid-positions",
                    datetime(2026, 6, 2, 14, 30, tzinfo=timezone.utc),
                    "not-json",
                    "latest_before_window_start",
                    0,
                )
            ]
        ]

        snapshot = _flat_start_position_snapshot_from_cursor(
            invalid_positions_cursor,
            account_label="TORGHUT_SIM",
            window_start=datetime(2026, 6, 2, 14, 30, tzinfo=timezone.utc),
        )

        self.assertIsNotNone(snapshot)
        assert snapshot is not None
        self.assertFalse(snapshot["flat"])
        self.assertEqual(
            snapshot["blockers"],
            ["runtime_ledger_flat_start_position_snapshot_positions_invalid"],
        )

    def test_clean_flat_start_snapshot_suppresses_stale_carry_in_rows(
        self,
    ) -> None:
        decision_rows, order_rows, execution_rows = _source_backed_runtime_split_rows()

        rows = _build_realized_strategy_pnl_rows(
            execution_rows,
            decision_lifecycle_rows=decision_rows,
            order_lifecycle_rows=order_rows,
            carry_in_execution_rows=[
                {
                    "execution_id": "stale-route-buy-exec",
                    "trade_decision_id": "stale-route-buy-decision",
                    "computed_at": _runtime_split_ts(-60),
                    "execution_event_at": _runtime_split_ts(-59),
                    "symbol": "NVDA",
                    "side": "buy",
                    "filled_qty": Decimal("2"),
                    "avg_fill_price": Decimal("90"),
                    "cost_amount": Decimal("0.10"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "account_label": "paper",
                    "strategy_id": "strategy-1",
                    "decision_hash": "stale-route-buy-hash",
                    "alpaca_order_id": "stale-route-buy-order",
                    "execution_policy_hash": "old-route-policy",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_decision_mode": "route_acquisition_probe",
                    "profit_proof_eligible": False,
                }
            ],
            flat_start_position_snapshot={
                "snapshot_id": "snapshot-flat",
                "snapshot_as_of": "2026-05-21T14:30:00+00:00",
                "flat": True,
                "position_count": 0,
                "blockers": [],
            },
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertTrue(row["carry_in_rows_suppressed_by_flat_start_snapshot"])
        self.assertEqual(row["flat_start_position_snapshot_id"], "snapshot-flat")
        bucket = row["runtime_ledger_bucket"]
        assert isinstance(bucket, dict)
        self.assertEqual(bucket["open_position_count"], 0)
        self.assertNotIn("unclosed_position", bucket["blockers"])
        self.assertNotIn(
            "route_acquisition_probe",
            bucket["source_decision_mode_counts"],
        )

    def test_active_carry_in_rows_keep_only_open_residual_lots_and_refs(
        self,
    ) -> None:
        bucket_start = datetime(2026, 6, 2, 14, 10, tzinfo=timezone.utc)
        rows: list[dict[str, object]] = [
            {
                "event_ts": datetime(2026, 6, 2, 13, 58, tzinfo=timezone.utc),
                "event_type": "new",
                "account_label": "TORGHUT_SIM",
                "strategy_id": "intraday-tsmom-profit-v3",
                "symbol": "AAPL",
                "alpaca_order_id": "stale-buy-order",
                "trade_decision_id": "stale-buy-decision",
            },
            {
                "event_ts": datetime(2026, 6, 2, 13, 59, tzinfo=timezone.utc),
                "event_type": "new",
                "account_label": "TORGHUT_SIM",
                "strategy_id": "intraday-tsmom-profit-v3",
                "symbol": "AAPL",
                "alpaca_order_id": "active-buy-order",
                "trade_decision_id": "active-buy-decision",
            },
            {
                "executed_at": datetime(2026, 6, 2, 14, 0, tzinfo=timezone.utc),
                "event_type": "fill",
                "side": "buy",
                "filled_qty": Decimal("2"),
                "avg_fill_price": Decimal("90"),
                "cost_amount": Decimal("0.20"),
                "account_label": "TORGHUT_SIM",
                "strategy_id": "intraday-tsmom-profit-v3",
                "symbol": "AAPL",
                "alpaca_order_id": "stale-buy-order",
                "trade_decision_id": "stale-buy-decision",
            },
            {
                "executed_at": datetime(2026, 6, 2, 14, 1, tzinfo=timezone.utc),
                "event_type": "fill",
                "side": "sell",
                "filled_qty": Decimal("2"),
                "avg_fill_price": Decimal("91"),
                "cost_amount": Decimal("0.20"),
                "account_label": "TORGHUT_SIM",
                "strategy_id": "intraday-tsmom-profit-v3",
                "symbol": "AAPL",
                "alpaca_order_id": "stale-sell-order",
                "trade_decision_id": "stale-sell-decision",
            },
            {
                "executed_at": datetime(2026, 6, 2, 14, 2, tzinfo=timezone.utc),
                "event_type": "fill",
                "side": "buy",
                "filled_qty": Decimal("5"),
                "avg_fill_price": Decimal("100"),
                "cost_amount": Decimal("0.50"),
                "account_label": "TORGHUT_SIM",
                "strategy_id": "intraday-tsmom-profit-v3",
                "symbol": "AAPL",
                "alpaca_order_id": "active-buy-order",
                "trade_decision_id": "active-buy-decision",
            },
            {
                "executed_at": datetime(2026, 6, 2, 14, 3, tzinfo=timezone.utc),
                "event_type": "fill",
                "side": "sell",
                "filled_qty": Decimal("2"),
                "avg_fill_price": Decimal("101"),
                "cost_amount": Decimal("0.20"),
                "account_label": "TORGHUT_SIM",
                "strategy_id": "intraday-tsmom-profit-v3",
                "symbol": "AAPL",
                "alpaca_order_id": "partial-sell-order",
                "trade_decision_id": "partial-sell-decision",
            },
        ]

        active_rows, order_ids, decision_ids = _active_carry_in_ledger_rows(
            rows,
            bucket_start=bucket_start,
        )

        self.assertEqual(order_ids, {"active-buy-order"})
        self.assertEqual(decision_ids, {"active-buy-decision"})
        self.assertEqual(len(active_rows), 2)
        active_fill = next(
            row
            for row in active_rows
            if isinstance(row, dict) and row.get("event_type") == "fill"
        )
        self.assertEqual(active_fill["filled_qty"], Decimal("3"))
        self.assertEqual(active_fill["filled_notional"], Decimal("300"))
        self.assertEqual(active_fill["cost_amount"], Decimal("0.30"))
        self.assertEqual(
            [
                row.get("alpaca_order_id")
                for row in active_rows
                if isinstance(row, dict)
            ],
            ["active-buy-order", "active-buy-order"],
        )

    def test_filter_carry_in_source_rows_keeps_active_lot_lineage_only(
        self,
    ) -> None:
        rows = [
            {
                "alpaca_order_id": "active-buy-order",
                "trade_decision_id": "active-buy-decision",
                "source_window_id": "active-window",
            },
            {
                "alpaca_order_id": "stale-buy-order",
                "trade_decision_id": "stale-buy-decision",
                "source_window_id": "stale-window",
            },
            {
                "trade_decision_id": "active-buy-decision",
                "source_window_id": "active-decision-window",
            },
        ]

        filtered = _filter_carry_in_source_rows_for_active_lots(
            rows,
            active_order_ids={"active-buy-order"},
            active_decision_ids={"active-buy-decision"},
        )

        self.assertIsNotNone(filtered)
        assert filtered is not None
        self.assertEqual(
            [row["source_window_id"] for row in filtered],
            ["active-window", "active-decision-window"],
        )

    def test_runtime_ledger_source_context_merges_gap_metadata(self) -> None:
        bucket = _with_runtime_ledger_source_authority_context(
            {
                **_complete_runtime_ledger_bucket(),
                "source_window_gap_count": 1,
                "source_window_gap_ranges": [{"start_offset": 10, "end_offset": 10}],
            },
            source_window_start=datetime(2026, 5, 29, 14, 30, tzinfo=timezone.utc),
            source_window_end=datetime(2026, 5, 29, 15, 0, tzinfo=timezone.utc),
            source_refs=[],
            source_row_counts={},
            source_window_gap_count=2,
            source_window_gap_ranges=[{"start_offset": 20, "end_offset": 21}],
        )

        self.assertEqual(bucket["source_window_gap_count"], 2)
        self.assertEqual(
            bucket["source_window_gap_ranges"],
            [
                {"start_offset": 10, "end_offset": 10},
                {"start_offset": 20, "end_offset": 21},
            ],
        )

    def test_source_window_metadata_helpers_skip_unusable_rows(self) -> None:
        rows = [
            {"source_window_status": "inserted"},
            {
                "source_window_id": "window-1",
                "source_window_status": "inserted",
                "source_window_inserted_count": 1,
                "source_window_gap_count": 1,
                "source_window_gap_ranges": [{"start_offset": 4, "end_offset": 4}],
            },
            {
                "source_window_id": "window-1",
                "source_window_status": "inserted",
                "source_window_inserted_count": 1,
                "source_window_gap_count": 1,
            },
            {
                "source_window_id": "window-2",
                "source_window_malformed_count": 1,
                "source_window_gap_ranges": "not-a-list",
            },
            {
                "source_window_id": "window-3",
                "source_window_status": None,
                "source_window_gap_ranges": ["not-a-mapping"],
            },
        ]

        self.assertEqual(_source_window_status_counts(rows), {"inserted": 1})
        self.assertEqual(
            _source_window_classification_counts(rows),
            {"inserted": 1, "malformed_json": 1},
        )
        self.assertEqual(_source_window_gap_count(rows), 1)
        self.assertEqual(
            _source_window_gap_ranges(rows),
            [{"start_offset": 4, "end_offset": 4}],
        )

    def test_source_window_query_context_rejects_short_rows(self) -> None:
        self.assertEqual(_source_window_query_context([1, 2, 3], start_index=0), {})
        self.assertEqual(
            _source_window_query_context(
                [
                    "inserted",
                    "ok",
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
                    0,
                    [],
                ],
                start_index=0,
            )["source_window_status"],
            "inserted",
        )

    def test_runtime_ledger_materialization_metadata_counts_only_source_backed_authority(
        self,
    ) -> None:
        aggregate_only = _complete_runtime_ledger_bucket(
            source_window_ids=[],
            trade_decision_ids=[],
            execution_ids=[],
            execution_order_event_ids=[],
            source_offsets=[],
            source_materialization="execution_order_events",
            authority_class="runtime_order_feed_execution_source",
        )
        source_backed = _complete_runtime_ledger_bucket()

        metadata = _runtime_ledger_tca_materialization_metadata(
            [
                {"runtime_ledger_bucket": aggregate_only},
                {"runtime_ledger_bucket": source_backed},
            ]
        )

        self.assertEqual(
            metadata["runtime_ledger_source_execution_materialized_bucket_count"],
            1,
        )
        self.assertEqual(metadata["runtime_ledger_tca_profit_proof_count"], 1)
        self.assertIn(
            "runtime_ledger_execution_order_event_refs_missing",
            metadata["runtime_ledger_profit_proof_blockers"],
        )

    def test_runtime_ledger_materialization_metadata_excludes_exact_replay_artifacts(
        self,
    ) -> None:
        exact_replay_artifact = _complete_runtime_ledger_bucket(
            source_materialization="exact_replay_artifact",
            authority_class="exact_replay_artifact_only_not_live",
            authority_reason="exact_replay_artifact_not_runtime_proof",
            pnl_derivation="exact_replay_artifact_only_not_live",
            promotion_authority="blocked",
        )
        source_backed = _complete_runtime_ledger_bucket(
            run_id="source-backed-runtime-ledger",
            source_materialization="execution_order_events",
            authority_class="runtime_order_feed_execution_source",
            authority_reason="event_sourced_runtime_ledger_profit_proof",
            pnl_derivation="execution_order_events_runtime_ledger",
        )

        tca_rows = [
            {
                "post_cost_expectancy_basis": POST_COST_BASIS_RUNTIME_LEDGER,
                "runtime_ledger_bucket": exact_replay_artifact,
            },
            {
                "post_cost_expectancy_basis": POST_COST_BASIS_RUNTIME_LEDGER,
                "runtime_ledger_bucket": source_backed,
            },
        ]
        metadata = _runtime_ledger_tca_materialization_metadata(tca_rows)
        authority_payload = _runtime_observation_authority_payload(
            source_kind="paper_runtime_observed",
            tca_rows=[dict(row) for row in tca_rows],
        )

        self.assertFalse(
            _runtime_ledger_bucket_profit_proof_present(exact_replay_artifact)
        )
        self.assertTrue(_runtime_ledger_bucket_profit_proof_present(source_backed))
        self.assertEqual(metadata["runtime_ledger_tca_runtime_bucket_row_count"], 2)
        self.assertEqual(metadata["runtime_ledger_tca_profit_proof_count"], 1)
        self.assertEqual(
            metadata["runtime_ledger_source_execution_materialized_bucket_count"],
            1,
        )
        self.assertIn(
            "runtime_ledger_source_materialization_missing",
            metadata["runtime_ledger_profit_proof_blockers"],
        )
        self.assertIn(
            "runtime_ledger_authority_class_missing",
            metadata["runtime_ledger_profit_proof_blockers"],
        )
        self.assertTrue(
            _runtime_ledger_profit_proof_present([dict(row) for row in tca_rows])
        )
        self.assertEqual(authority_payload["runtime_ledger_profit_proof_present"], True)
        self.assertEqual(authority_payload["promotion_authority"], "runtime_ledger")
