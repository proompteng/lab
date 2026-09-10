from __future__ import annotations

from tests.runtime_window_import.runtime_window_import_base import (
    Decimal,
    Mapping,
    POST_COST_BASIS_EXECUTION_RECONSTRUCTION,
    POST_COST_BASIS_RUNTIME_LEDGER,
    RuntimeLedgerBucket,
    RuntimeWindowImportTestCaseBase,
    _build_realized_strategy_pnl_rows,
    _fill_quantity_basis,
    _order_feed_fill_delta_blockers,
    _runtime_ledger_bucket_profit_proof_blockers,
    _runtime_ledger_bucket_profit_proof_present,
    _runtime_ledger_tca_row_from_bucket,
    _runtime_lifecycle_ledger_row,
    cast,
    datetime,
    timezone,
)


class TestRuntimeWindowImportRealizedPnlG(RuntimeWindowImportTestCaseBase):
    def test_build_realized_strategy_pnl_rows_keeps_probe_exit_with_source_entry(
        self,
    ) -> None:
        target_notional_sizing_json = {
            "sizing_source": "target_notional",
            "target_notional": "100",
            "reference_price": "100",
            "computed_qty": "1",
            "blockers": [],
        }
        entry_decision_json = {
            "params": {
                "source_decision_mode": "bounded_paper_route_collection",
                "profit_proof_eligible": True,
                "account": {"equity": "10000"},
                "paper_route_target_notional_sizing": target_notional_sizing_json,
            }
        }
        exit_decision_json = {
            "params": {
                "source_decision_mode": "route_acquisition_probe",
                "paper_route_target_notional_sizing": target_notional_sizing_json,
                "paper_route_probe_exit": {
                    "mode": "paper_route_exit",
                    "source": "filled_paper_route_probe_executions",
                    "source_decision_mode": "route_acquisition_probe",
                    "profit_proof_eligible": False,
                    "source_candidate_ids": ["ca4e6e3c7d639e3363dc5860"],
                    "source_hypothesis_ids": ["H-TSMOM-LIQ-01"],
                    "source_strategy_names": ["intraday-tsmom-profit-v3"],
                },
            }
        }
        linked_exit_lifecycle_json = {
            "params": {
                "source_decision_mode": "route_acquisition_probe",
                "profit_proof_eligible": False,
                "paper_route_target_notional_sizing": target_notional_sizing_json,
            }
        }

        rows = _build_realized_strategy_pnl_rows(
            [
                {
                    "execution_id": "entry-exec",
                    "trade_decision_id": "entry-decision",
                    "computed_at": datetime(2026, 6, 2, 13, 51, tzinfo=timezone.utc),
                    "execution_event_at": datetime(
                        2026, 6, 2, 13, 51, 2, tzinfo=timezone.utc
                    ),
                    "symbol": "AAPL",
                    "side": "buy",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                    "cost_amount": Decimal("0.10"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "intraday-tsmom-profit-v3",
                    "decision_hash": "entry-hash",
                    "decision_json": entry_decision_json,
                    "alpaca_order_id": "entry-order",
                    "execution_policy_hash": "entry-policy",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_decision_mode": "bounded_paper_route_collection",
                    "profit_proof_eligible": True,
                },
                {
                    "execution_id": "exit-exec",
                    "trade_decision_id": "exit-decision",
                    "computed_at": datetime(2026, 6, 2, 13, 56, tzinfo=timezone.utc),
                    "execution_event_at": datetime(
                        2026, 6, 2, 13, 56, 2, tzinfo=timezone.utc
                    ),
                    "symbol": "AAPL",
                    "side": "sell",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("101"),
                    "cost_amount": Decimal("0.10"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "intraday-tsmom-profit-v3",
                    "decision_hash": "exit-hash",
                    "decision_json": linked_exit_lifecycle_json,
                    "alpaca_order_id": "exit-order",
                    "execution_policy_hash": "exit-policy",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_decision_mode": "route_acquisition_probe",
                    "profit_proof_eligible": False,
                },
            ],
            decision_lifecycle_rows=[
                {
                    "trade_decision_id": "entry-decision",
                    "computed_at": datetime(2026, 6, 2, 13, 51, tzinfo=timezone.utc),
                    "event_type": "decision",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "intraday-tsmom-profit-v3",
                    "decision_hash": "entry-hash",
                    "decision_json": entry_decision_json,
                    "execution_policy_hash": "entry-policy",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_decision_mode": "bounded_paper_route_collection",
                    "profit_proof_eligible": True,
                },
                {
                    "trade_decision_id": "exit-decision",
                    "computed_at": datetime(2026, 6, 2, 13, 56, tzinfo=timezone.utc),
                    "event_type": "decision",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "intraday-tsmom-profit-v3",
                    "decision_hash": "exit-hash",
                    "decision_json": exit_decision_json,
                    "execution_policy_hash": "exit-policy",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_decision_mode": "route_acquisition_probe",
                    "profit_proof_eligible": False,
                },
            ],
            order_lifecycle_rows=[
                {
                    "execution_order_event_id": "entry-new",
                    "trade_decision_id": "entry-decision",
                    "execution_id": "entry-exec",
                    "event_ts": datetime(2026, 6, 2, 13, 51, 1, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "intraday-tsmom-profit-v3",
                    "decision_hash": "entry-hash",
                    "decision_json": entry_decision_json,
                    "alpaca_order_id": "entry-order",
                    "event_type": "new",
                    "source_topic": "alpaca-trade-updates",
                    "source_partition": 0,
                    "source_offset": 11,
                    "source_window_id": "source-window-entry",
                    "execution_policy_hash": "entry-policy",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_decision_mode": "bounded_paper_route_collection",
                    "profit_proof_eligible": True,
                },
                {
                    "execution_order_event_id": "entry-fill",
                    "trade_decision_id": "entry-decision",
                    "execution_id": "entry-exec",
                    "event_ts": datetime(2026, 6, 2, 13, 51, 2, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "side": "buy",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "intraday-tsmom-profit-v3",
                    "decision_hash": "entry-hash",
                    "decision_json": entry_decision_json,
                    "alpaca_order_id": "entry-order",
                    "event_type": "fill",
                    "filled_qty": Decimal("1"),
                    "filled_qty_delta": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                    "filled_notional_delta": Decimal("100"),
                    "fill_quantity_basis": "cumulative_to_delta",
                    "cost_amount": Decimal("0.10"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "source_topic": "alpaca-trade-updates",
                    "source_partition": 0,
                    "source_offset": 12,
                    "source_window_id": "source-window-entry",
                    "execution_policy_hash": "entry-policy",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_decision_mode": "bounded_paper_route_collection",
                    "profit_proof_eligible": True,
                },
                {
                    "execution_order_event_id": "exit-new",
                    "trade_decision_id": "exit-decision",
                    "execution_id": "exit-exec",
                    "event_ts": datetime(2026, 6, 2, 13, 56, 1, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "intraday-tsmom-profit-v3",
                    "decision_hash": "exit-hash",
                    "decision_json": linked_exit_lifecycle_json,
                    "alpaca_order_id": "exit-order",
                    "event_type": "new",
                    "source_topic": "alpaca-trade-updates",
                    "source_partition": 0,
                    "source_offset": 13,
                    "source_window_id": "source-window-exit",
                    "execution_policy_hash": "exit-policy",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_decision_mode": "route_acquisition_probe",
                    "profit_proof_eligible": False,
                },
                {
                    "execution_order_event_id": "exit-fill",
                    "trade_decision_id": "exit-decision",
                    "execution_id": "exit-exec",
                    "event_ts": datetime(2026, 6, 2, 13, 56, 2, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "side": "sell",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "intraday-tsmom-profit-v3",
                    "decision_hash": "exit-hash",
                    "decision_json": linked_exit_lifecycle_json,
                    "alpaca_order_id": "exit-order",
                    "event_type": "fill",
                    "filled_qty": Decimal("1"),
                    "filled_qty_delta": Decimal("1"),
                    "avg_fill_price": Decimal("101"),
                    "filled_notional_delta": Decimal("101"),
                    "fill_quantity_basis": "cumulative_to_delta",
                    "cost_amount": Decimal("0.10"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "source_topic": "alpaca-trade-updates",
                    "source_partition": 0,
                    "source_offset": 14,
                    "source_window_id": "source-window-exit",
                    "execution_policy_hash": "exit-policy",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_decision_mode": "route_acquisition_probe",
                    "profit_proof_eligible": False,
                },
            ],
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertTrue(row["post_cost_promotion_eligible"])
        self.assertTrue(row["authoritative"])
        self.assertEqual(
            row["authority_reason"],
            "event_sourced_runtime_ledger_profit_proof",
        )
        self.assertEqual(
            row["source_decision_mode_counts"],
            {"bounded_paper_route_collection": 4},
        )
        bucket = cast(Mapping[str, object], row["runtime_ledger_bucket"])
        self.assertEqual(bucket["closed_trade_count"], 1)
        self.assertEqual(bucket["open_position_count"], 0)
        self.assertNotIn(
            "source_decision_mode_not_profit_proof_eligible", bucket["blockers"]
        )
        self.assertTrue(_runtime_ledger_bucket_profit_proof_present(bucket))

    def test_build_realized_strategy_pnl_rows_blocks_unlinked_fill_lifecycle(
        self,
    ) -> None:
        execution_rows = [
            {
                "execution_id": "exec-buy",
                "trade_decision_id": "decision-buy",
                "computed_at": datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                "execution_event_at": datetime(
                    2026, 3, 6, 14, 35, 2, tzinfo=timezone.utc
                ),
                "symbol": "AAPL",
                "side": "buy",
                "filled_qty": Decimal("1"),
                "avg_fill_price": Decimal("100"),
                "cost_amount": Decimal("0.10"),
                "cost_basis": "broker_reported_commission_and_fees",
                "account_label": "TORGHUT_SIM",
                "strategy_id": "microbar-cross-sectional-pairs-v1",
                "decision_hash": "decision-buy-hash",
                "alpaca_order_id": "order-buy",
                "execution_policy_hash": "policy-sha",
                "cost_model_hash": "cost-sha",
                "lineage_hash": "lineage-sha",
                "source_decision_mode": "strategy_signal_paper",
                "profit_proof_eligible": True,
            },
            {
                "execution_id": "exec-sell",
                "trade_decision_id": "decision-sell",
                "computed_at": datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
                "execution_event_at": datetime(
                    2026, 3, 6, 14, 40, 2, tzinfo=timezone.utc
                ),
                "symbol": "AAPL",
                "side": "sell",
                "filled_qty": Decimal("1"),
                "avg_fill_price": Decimal("101"),
                "cost_amount": Decimal("0.10"),
                "cost_basis": "broker_reported_commission_and_fees",
                "account_label": "TORGHUT_SIM",
                "strategy_id": "microbar-cross-sectional-pairs-v1",
                "decision_hash": "decision-sell-hash",
                "alpaca_order_id": "order-sell",
                "execution_policy_hash": "policy-sha",
                "cost_model_hash": "cost-sha",
                "lineage_hash": "lineage-sha",
                "source_decision_mode": "strategy_signal_paper",
                "profit_proof_eligible": True,
            },
        ]
        order_lifecycle_rows = [
            {
                "execution_order_event_id": "event-new-buy",
                "trade_decision_id": "decision-buy",
                "execution_id": "exec-buy",
                "event_ts": datetime(2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc),
                "symbol": "AAPL",
                "account_label": "TORGHUT_SIM",
                "strategy_id": "microbar-cross-sectional-pairs-v1",
                "decision_hash": "decision-buy-hash",
                "alpaca_order_id": "order-buy",
                "event_type": "new",
                "source_topic": "alpaca-trade-updates",
                "source_partition": 0,
                "source_offset": 11,
                "source_window_id": "source-window-buy",
                "execution_policy_hash": "policy-sha",
                "cost_model_hash": "cost-sha",
                "lineage_hash": "lineage-sha",
                "source_decision_mode": "strategy_signal_paper",
                "profit_proof_eligible": True,
            },
            {
                "execution_order_event_id": "event-fill-buy",
                "trade_decision_id": "decision-buy",
                "execution_id": "exec-buy",
                "event_ts": datetime(2026, 3, 6, 14, 35, 2, tzinfo=timezone.utc),
                "symbol": "AAPL",
                "account_label": "TORGHUT_SIM",
                "strategy_id": "microbar-cross-sectional-pairs-v1",
                "decision_hash": "decision-buy-hash",
                "alpaca_order_id": "order-buy",
                "event_type": "fill",
                "source_topic": "alpaca-trade-updates",
                "source_partition": 0,
                "source_offset": 12,
                "source_window_id": "source-window-buy",
                "lineage_hash": "lineage-sha",
                "source_decision_mode": "strategy_signal_paper",
                "profit_proof_eligible": True,
            },
            {
                "execution_order_event_id": "event-new-sell",
                "trade_decision_id": "decision-sell",
                "execution_id": "exec-sell",
                "event_ts": datetime(2026, 3, 6, 14, 40, 1, tzinfo=timezone.utc),
                "symbol": "AAPL",
                "account_label": "TORGHUT_SIM",
                "strategy_id": "microbar-cross-sectional-pairs-v1",
                "decision_hash": "decision-sell-hash",
                "alpaca_order_id": "order-sell",
                "event_type": "new",
                "source_topic": "alpaca-trade-updates",
                "source_partition": 0,
                "source_offset": 13,
                "source_window_id": "source-window-sell",
                "execution_policy_hash": "policy-sha",
                "cost_model_hash": "cost-sha",
                "lineage_hash": "lineage-sha",
                "source_decision_mode": "strategy_signal_paper",
                "profit_proof_eligible": True,
            },
            {
                "execution_order_event_id": "event-fill-sell",
                "trade_decision_id": "decision-sell",
                "execution_id": "exec-sell",
                "event_ts": datetime(2026, 3, 6, 14, 40, 2, tzinfo=timezone.utc),
                "symbol": "AAPL",
                "account_label": "TORGHUT_SIM",
                "strategy_id": "microbar-cross-sectional-pairs-v1",
                "decision_hash": "decision-sell-hash",
                "alpaca_order_id": "order-sell",
                "event_type": "fill",
                "source_topic": "alpaca-trade-updates",
                "source_partition": 0,
                "source_offset": 14,
                "source_window_id": "source-window-sell",
                "lineage_hash": "lineage-sha",
                "source_decision_mode": "strategy_signal_paper",
                "profit_proof_eligible": True,
            },
        ]

        rows = _build_realized_strategy_pnl_rows(
            execution_rows,
            order_lifecycle_rows=order_lifecycle_rows,
            unlinked_order_lifecycle_rows=[
                {
                    "execution_order_event_id": "unlinked-fill",
                    "event_ts": datetime(2026, 3, 6, 14, 41, 2, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "alpaca_order_id": "order-sell",
                    "event_type": "fill",
                    "source_topic": "alpaca-trade-updates",
                    "source_partition": 0,
                    "source_offset": 15,
                    "source_window_id": "source-window-external",
                }
            ],
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertFalse(row["post_cost_promotion_eligible"])
        self.assertFalse(row["authoritative"])
        self.assertIn(
            "order_feed_unlinked_fill_lifecycle_present",
            row["runtime_ledger_blockers"],
        )
        self.assertEqual(
            row["promotion_blocker"],
            "execution_reconstruction_not_runtime_ledger_proof",
        )
        bucket = cast(Mapping[str, object], row["runtime_ledger_bucket"])
        self.assertIn("order_feed_unlinked_fill_lifecycle_present", bucket["blockers"])
        self.assertFalse(_runtime_ledger_bucket_profit_proof_present(bucket))

        rows = _build_realized_strategy_pnl_rows(
            execution_rows,
            order_lifecycle_rows=order_lifecycle_rows,
            unlinked_order_lifecycle_rows=[
                {
                    "execution_order_event_id": "external-fill",
                    "event_ts": datetime(2026, 3, 6, 14, 41, 2, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "alpaca_order_id": "external-close-order",
                    "event_type": "fill",
                    "source_topic": "alpaca-trade-updates",
                    "source_partition": 0,
                    "source_offset": 16,
                    "source_window_id": "source-window-external",
                }
            ],
            allow_authoritative_runtime_ledger_materialization=True,
        )
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertNotIn(
            "order_feed_unlinked_fill_lifecycle_present",
            row["runtime_ledger_blockers"],
        )
        bucket = cast(Mapping[str, object], row["runtime_ledger_bucket"])
        self.assertNotIn(
            "order_feed_unlinked_fill_lifecycle_present", bucket["blockers"]
        )

    def test_build_realized_strategy_pnl_rows_preserves_source_backed_blocked_basis(
        self,
    ) -> None:
        rows = _build_realized_strategy_pnl_rows(
            [
                {
                    "execution_id": "exec-buy",
                    "computed_at": datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "side": "buy",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                    "cost_amount": Decimal("0.20"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_decision_mode": "route_acquisition_probe",
                },
                {
                    "execution_id": "exec-sell",
                    "computed_at": datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "side": "sell",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("101"),
                    "cost_amount": Decimal("0.10"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_decision_mode": "route_acquisition_probe",
                },
            ],
            decision_lifecycle_rows=[
                {
                    "trade_decision_id": "decision-buy",
                    "executed_at": datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-buy",
                    "event_type": "decision",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_decision_mode": "route_acquisition_probe",
                },
                {
                    "trade_decision_id": "decision-sell",
                    "executed_at": datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-sell",
                    "event_type": "decision",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_decision_mode": "route_acquisition_probe",
                },
            ],
            order_lifecycle_rows=[
                {
                    "execution_order_event_id": "event-new-buy",
                    "trade_decision_id": "decision-buy",
                    "execution_id": "exec-buy",
                    "event_ts": datetime(2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "event_type": "new",
                    "source_topic": "alpaca-trade-updates",
                    "source_partition": 0,
                    "source_offset": 11,
                    "source_window_id": "source-window-buy",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_decision_mode": "route_acquisition_probe",
                },
                {
                    "execution_order_event_id": "event-fill-buy",
                    "trade_decision_id": "decision-buy",
                    "execution_id": "exec-buy",
                    "event_ts": datetime(2026, 3, 6, 14, 35, 2, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "event_type": "fill",
                    "side": "buy",
                    "filled_qty": Decimal("1"),
                    "filled_qty_delta": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                    "filled_notional_delta": Decimal("100"),
                    "fill_quantity_basis": "cumulative_to_delta",
                    "cost_amount": Decimal("0.20"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "source_topic": "alpaca-trade-updates",
                    "source_partition": 0,
                    "source_offset": 12,
                    "source_window_id": "source-window-buy",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_decision_mode": "route_acquisition_probe",
                },
                {
                    "execution_order_event_id": "event-new-sell",
                    "trade_decision_id": "decision-sell",
                    "execution_id": "exec-sell",
                    "event_ts": datetime(2026, 3, 6, 14, 40, 1, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "event_type": "new",
                    "source_topic": "alpaca-trade-updates",
                    "source_partition": 0,
                    "source_offset": 13,
                    "source_window_id": "source-window-sell",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_decision_mode": "route_acquisition_probe",
                },
                {
                    "execution_order_event_id": "event-fill-sell",
                    "trade_decision_id": "decision-sell",
                    "execution_id": "exec-sell",
                    "event_ts": datetime(2026, 3, 6, 14, 40, 2, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "event_type": "fill",
                    "side": "sell",
                    "filled_qty": Decimal("1"),
                    "filled_qty_delta": Decimal("1"),
                    "avg_fill_price": Decimal("101"),
                    "filled_notional_delta": Decimal("101"),
                    "fill_quantity_basis": "cumulative_to_delta",
                    "cost_amount": Decimal("0.10"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "source_topic": "alpaca-trade-updates",
                    "source_partition": 0,
                    "source_offset": 14,
                    "source_window_id": "source-window-sell",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_decision_mode": "route_acquisition_probe",
                },
            ],
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertFalse(row["post_cost_promotion_eligible"])
        self.assertFalse(row["authoritative"])
        self.assertEqual(
            row["authority_reason"],
            "source_execution_lifecycle_materialized_runtime_ledger",
        )
        self.assertEqual(row["pnl_derivation"], "execution_order_events_runtime_ledger")
        self.assertEqual(
            row["promotion_blocker"],
            "source_decision_mode_not_profit_proof_eligible",
        )
        self.assertNotIn(
            "execution_reconstruction_not_runtime_ledger_proof",
            row["runtime_ledger_blockers"],
        )

        bucket = row["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertEqual(bucket["pnl_basis"], POST_COST_BASIS_RUNTIME_LEDGER)
        self.assertEqual(bucket["source_materialization"], "execution_order_events")
        self.assertEqual(
            bucket["authority_reason"],
            "source_execution_lifecycle_materialized_runtime_ledger",
        )
        self.assertEqual(
            bucket["source_decision_mode_counts"], {"route_acquisition_probe": 8}
        )
        self.assertIn(
            "source_decision_mode_not_profit_proof_eligible", bucket["blockers"]
        )
        self.assertNotIn(
            "runtime_ledger_pnl_basis_not_runtime_ledger",
            _runtime_ledger_bucket_profit_proof_blockers(bucket),
        )
        self.assertFalse(_runtime_ledger_bucket_profit_proof_present(bucket))

    def test_runtime_ledger_tca_row_separates_explicit_cost_from_slippage(
        self,
    ) -> None:
        bucket = RuntimeLedgerBucket(
            bucket_started_at=datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
            bucket_ended_at=datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
            account_label="TORGHUT_SIM",
            strategy_id="intraday-tsmom-profit-v3",
            symbol="AAPL",
            fill_count=2,
            decision_count=2,
            submitted_order_count=2,
            cancelled_order_count=0,
            rejected_order_count=0,
            unfilled_order_count=0,
            closed_trade_count=1,
            open_position_count=0,
            filled_notional=Decimal("200"),
            gross_strategy_pnl=Decimal("1"),
            cost_amount=Decimal("0.25"),
            net_strategy_pnl_after_costs=Decimal("0.75"),
            post_cost_expectancy_bps=Decimal("37.5"),
            cost_basis_counts={"broker_reported_commission_and_fees": 2},
            execution_policy_hash_counts={"policy-sha": 2},
            cost_model_hash_counts={"cost-sha": 2},
            lineage_hash_counts={"lineage-sha": 2},
            blockers=[],
        )

        row = _runtime_ledger_tca_row_from_bucket(bucket=bucket)

        self.assertIsNone(row["abs_slippage_bps"])
        self.assertEqual(row["explicit_cost_bps"], Decimal("12.50000"))
        self.assertEqual(row["post_cost_promotion_eligible"], False)
        self.assertIn(
            "source_decision_mode_profit_proof_missing",
            _runtime_ledger_bucket_profit_proof_blockers(
                cast(Mapping[str, object], row["runtime_ledger_bucket"])
            ),
        )

    def test_runtime_lifecycle_row_requires_delta_when_source_backed(self) -> None:
        row = _runtime_lifecycle_ledger_row(
            {
                "computed_at": datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                "symbol": "AAPL",
                "side": "buy",
                "filled_qty": Decimal("3"),
                "avg_fill_price": Decimal("100"),
                "cost_amount": Decimal("0"),
                "cost_basis": "broker_reported_zero_cost",
                "source_offset": 14,
                "fill_quantity_basis": "delta",
            },
            event_type="fill",
        )

        self.assertIsNotNone(row)
        assert row is not None
        self.assertNotIn("filled_qty", row)
        self.assertNotIn("filled_notional", row)
        self.assertEqual(row["fill_quantity_basis"], "delta")

    def test_order_feed_fill_delta_blockers_name_missing_basis_and_delta(
        self,
    ) -> None:
        self.assertEqual(
            _order_feed_fill_delta_blockers(
                {
                    "symbol": "AAPL",
                    "source_offset": 14,
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                }
            ),
            ["order_feed_fill_delta_basis_missing"],
        )
        self.assertEqual(
            _order_feed_fill_delta_blockers(
                {
                    "symbol": "AAPL",
                    "source_offset": 14,
                    "fill_quantity_basis": "delta",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                }
            ),
            ["order_feed_fill_delta_missing"],
        )
        self.assertEqual(
            _order_feed_fill_delta_blockers(
                {
                    "symbol": "AAPL",
                    "fill_quantity_basis": "delta",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                }
            ),
            [],
        )
        self.assertEqual(
            _order_feed_fill_delta_blockers(
                {
                    "symbol": "AAPL",
                    "source_offset": 14,
                    "fill_quantity_basis": "delta",
                    "filled_qty_delta": Decimal("1"),
                    "filled_qty": Decimal("2"),
                    "avg_fill_price": Decimal("100"),
                }
            ),
            [],
        )

    def test_fill_quantity_basis_aliases_are_normalized_for_import(self) -> None:
        self.assertEqual(
            _fill_quantity_basis({"fill_quantity_basis": "filled-delta"}), "delta"
        )
        self.assertEqual(
            _fill_quantity_basis({"fill_quantity_basis": "cum"}),
            "cumulative",
        )
        self.assertEqual(
            _fill_quantity_basis({"fill_quantity_basis": "unknown"}),
            "unknown",
        )
        self.assertEqual(
            _fill_quantity_basis({"fill_quantity_basis": "cumulative-non-increasing"}),
            "cumulative_non_increasing",
        )
        self.assertEqual(
            _fill_quantity_basis({"fill_quantity_basis": "broker custom"}),
            "broker_custom",
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
        self.assertEqual(
            rows[0]["post_cost_expectancy_basis"],
            POST_COST_BASIS_EXECUTION_RECONSTRUCTION,
        )
        self.assertIn(
            "execution_reconstruction_not_runtime_ledger_proof",
            rows[0]["runtime_ledger_blockers"],
        )
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
