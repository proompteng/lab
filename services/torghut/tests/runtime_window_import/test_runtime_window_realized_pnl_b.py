from __future__ import annotations

from tests.runtime_window_import.runtime_window_import_base import (
    Decimal,
    RuntimeLedgerBucket,
    RuntimeWindowImportTestCaseBase,
    _alpaca_2026_equity_fee_schedule_hash,
    _build_realized_strategy_pnl_rows,
    _runtime_decision_rows_before_bucket,
    _runtime_execution_ledger_fill_from_row,
    _runtime_ledger_bucket_profit_proof_present,
    datetime,
    patch,
    timezone,
)


class TestRuntimeWindowImportRealizedPnlB(RuntimeWindowImportTestCaseBase):
    def test_build_realized_strategy_pnl_rows_materializes_runtime_source_aliases(
        self,
    ) -> None:
        rows = _build_realized_strategy_pnl_rows(
            [
                {
                    "computed_at": datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "side": "buy",
                    "filled_qty": Decimal("1"),
                    "filled_qty_delta": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                    "filled_notional_delta": Decimal("100"),
                    "fill_quantity_basis": "cumulative_to_delta",
                    "cost_amount": Decimal("0.20"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "execution_tca_metric_id": "tca-buy",
                    "execution_policy_hash": "policy-buy",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
                {
                    "computed_at": datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "side": "sell",
                    "filled_qty": Decimal("1"),
                    "filled_qty_delta": Decimal("1"),
                    "avg_fill_price": Decimal("101"),
                    "filled_notional_delta": Decimal("101"),
                    "fill_quantity_basis": "cumulative_to_delta",
                    "cost_amount": Decimal("0.10"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "execution_tca_metric_id": "tca-sell",
                    "execution_policy_hash": "policy-sell",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
            ],
            decision_lifecycle_rows=[
                {
                    "trade_decision_id": "decision-buy-id",
                    "computed_at": datetime(2026, 3, 6, 14, 34, tzinfo=timezone.utc),
                    "event_type": "decision",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-buy",
                    "decision_json": {"account": {"equity": "10000"}},
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                    "lineage_hash": "lineage-sha",
                },
                {
                    "trade_decision_id": "decision-sell-id",
                    "computed_at": datetime(2026, 3, 6, 14, 39, tzinfo=timezone.utc),
                    "event_type": "decision",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-sell",
                    "decision_json": {"account": {"equity": "10000"}},
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                    "lineage_hash": "lineage-sha",
                },
            ],
            order_lifecycle_rows=[
                {
                    "runtime_ledger_execution_order_event_id": "event-new-buy",
                    "trade_decision_id": "decision-buy-id",
                    "event_ts": datetime(2026, 3, 6, 14, 34, 1, tzinfo=timezone.utc),
                    "event_type": "new",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "execution_policy_hash": "policy-buy",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 100,
                    "runtime_ledger_source_window_id": "source-window-new-buy",
                },
                {
                    "runtime_ledger_execution_order_event_id": "event-new-sell",
                    "trade_decision_id": "decision-sell-id",
                    "event_ts": datetime(2026, 3, 6, 14, 39, 1, tzinfo=timezone.utc),
                    "event_type": "new",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "execution_policy_hash": "policy-sell",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 101,
                    "runtime_ledger_source_window_id": "source-window-new-sell",
                },
                {
                    "runtime_ledger_execution_order_event_id": "event-fill-buy",
                    "trade_decision_id": "decision-buy-id",
                    "execution_id": "execution-buy",
                    "event_ts": datetime(2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc),
                    "event_type": "filled",
                    "symbol": "AAPL",
                    "side": "buy",
                    "filled_qty": Decimal("1"),
                    "filled_qty_delta": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                    "filled_notional_delta": Decimal("100"),
                    "fill_quantity_basis": "cumulative_to_delta",
                    "cost_amount": Decimal("0.20"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "execution_policy_hash": "policy-buy",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 102,
                    "runtime_ledger_source_window_id": "source-window-fill-buy",
                },
                {
                    "runtime_ledger_execution_order_event_id": "event-fill-sell",
                    "trade_decision_id": "decision-sell-id",
                    "execution_id": "execution-sell",
                    "event_ts": datetime(2026, 3, 6, 14, 40, 1, tzinfo=timezone.utc),
                    "event_type": "filled",
                    "symbol": "AAPL",
                    "side": "sell",
                    "filled_qty": Decimal("1"),
                    "filled_qty_delta": Decimal("1"),
                    "avg_fill_price": Decimal("101"),
                    "filled_notional_delta": Decimal("101"),
                    "fill_quantity_basis": "cumulative_to_delta",
                    "cost_amount": Decimal("0.10"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "execution_policy_hash": "policy-sell",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 103,
                    "runtime_ledger_source_window_id": "source-window-fill-sell",
                },
            ],
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(
            rows[0]["post_cost_promotion_eligible"],
            True,
            rows[0]["runtime_ledger_bucket"],
        )
        self.assertEqual(rows[0]["authoritative"], True)
        bucket = rows[0]["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertEqual(bucket["blockers"], [])
        self.assertEqual(bucket["source_materialization"], "execution_order_events")
        self.assertEqual(
            bucket["source_window_ids"],
            [
                "source-window-new-buy",
                "source-window-new-sell",
                "source-window-fill-buy",
                "source-window-fill-sell",
            ],
        )
        self.assertEqual(
            bucket["execution_order_event_ids"],
            [
                "event-new-buy",
                "event-new-sell",
                "event-fill-buy",
                "event-fill-sell",
            ],
        )
        self.assertTrue(_runtime_ledger_bucket_profit_proof_present(bucket))

    def test_build_realized_strategy_pnl_rows_uses_source_backed_carry_in(
        self,
    ) -> None:
        rows = _build_realized_strategy_pnl_rows(
            [
                {
                    "execution_id": "execution-sell",
                    "trade_decision_id": "decision-sell-id",
                    "computed_at": datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
                    "execution_event_at": datetime(
                        2026, 3, 6, 14, 40, 1, tzinfo=timezone.utc
                    ),
                    "symbol": "AAPL",
                    "side": "sell",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("101"),
                    "cost_amount": Decimal("0.10"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "execution_policy_hash": "policy-sell",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                },
            ],
            decision_lifecycle_rows=[
                {
                    "trade_decision_id": "decision-sell-id",
                    "computed_at": datetime(2026, 3, 6, 14, 39, tzinfo=timezone.utc),
                    "event_type": "decision",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-sell",
                    "decision_json": {"account": {"equity": "10000"}},
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                    "lineage_hash": "lineage-sha",
                },
            ],
            order_lifecycle_rows=[
                {
                    "execution_order_event_id": "event-new-sell",
                    "trade_decision_id": "decision-sell-id",
                    "event_ts": datetime(2026, 3, 6, 14, 39, 1, tzinfo=timezone.utc),
                    "event_type": "new",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "execution_policy_hash": "policy-sell",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 201,
                    "source_window_id": "source-window-new-sell",
                },
                {
                    "execution_order_event_id": "event-fill-sell",
                    "trade_decision_id": "decision-sell-id",
                    "execution_id": "execution-sell",
                    "event_ts": datetime(2026, 3, 6, 14, 40, 1, tzinfo=timezone.utc),
                    "event_type": "filled",
                    "symbol": "AAPL",
                    "side": "sell",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("101"),
                    "cost_amount": Decimal("0.10"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "execution_policy_hash": "policy-sell",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 202,
                    "source_window_id": "source-window-fill-sell",
                },
            ],
            carry_in_execution_rows=[
                {
                    "execution_id": "execution-buy",
                    "trade_decision_id": "decision-buy-id",
                    "computed_at": datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                    "execution_event_at": datetime(
                        2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc
                    ),
                    "symbol": "AAPL",
                    "side": "buy",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                    "cost_amount": Decimal("0.20"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "execution_policy_hash": "policy-buy",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                },
            ],
            carry_in_decision_lifecycle_rows=[
                {
                    "trade_decision_id": "decision-buy-id",
                    "computed_at": datetime(2026, 3, 6, 14, 34, tzinfo=timezone.utc),
                    "event_type": "decision",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-buy",
                    "decision_json": {"account": {"equity": "10000"}},
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                    "lineage_hash": "lineage-sha",
                },
            ],
            carry_in_order_lifecycle_rows=[
                {
                    "execution_order_event_id": "event-new-buy",
                    "trade_decision_id": "decision-buy-id",
                    "event_ts": datetime(2026, 3, 6, 14, 34, 1, tzinfo=timezone.utc),
                    "event_type": "new",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "execution_policy_hash": "policy-buy",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 199,
                    "source_window_id": "source-window-new-buy",
                },
                {
                    "execution_order_event_id": "event-fill-buy",
                    "trade_decision_id": "decision-buy-id",
                    "execution_id": "execution-buy",
                    "event_ts": datetime(2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc),
                    "event_type": "filled",
                    "symbol": "AAPL",
                    "side": "buy",
                    "filled_qty": Decimal("1"),
                    "filled_qty_delta": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                    "filled_notional_delta": Decimal("100"),
                    "fill_quantity_basis": "cumulative_to_delta",
                    "cost_amount": Decimal("0.20"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "execution_policy_hash": "policy-buy",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 200,
                    "source_window_id": "source-window-fill-buy",
                },
                {
                    "execution_order_event_id": "event-unrelated-carry-in",
                    "trade_decision_id": "decision-unrelated-id",
                    "execution_id": "execution-unrelated",
                    "event_ts": datetime(2026, 3, 6, 14, 35, 2, tzinfo=timezone.utc),
                    "event_type": "new",
                    "symbol": "TSLA",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-unrelated",
                    "alpaca_order_id": "order-unrelated",
                    "execution_policy_hash": "policy-unrelated",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 999,
                    "source_decision_mode": "strategy_signal_paper",
                    "source_window_id": "source-window-unrelated-carry-in",
                },
            ],
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0]["post_cost_promotion_eligible"])
        self.assertTrue(rows[0]["authoritative"])
        bucket = rows[0]["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertEqual(bucket["blockers"], [])
        self.assertEqual(bucket["filled_notional"], "201")
        self.assertEqual(bucket["cost_amount"], "0.30")
        self.assertEqual(bucket["net_strategy_pnl_after_costs"], "0.70")
        self.assertEqual(bucket["open_position_count"], 0)
        self.assertEqual(bucket["closed_trade_count"], 1)
        self.assertEqual(bucket["source_window_start"], "2026-03-06T14:34:01+00:00")
        self.assertEqual(
            bucket["source_window_end"], "2026-03-06T14:40:01.000001+00:00"
        )
        self.assertEqual(
            bucket["source_window_ids"],
            [
                "source-window-new-buy",
                "source-window-fill-buy",
                "source-window-new-sell",
                "source-window-fill-sell",
            ],
        )
        self.assertEqual(
            bucket["source_row_counts"],
            {
                "executions": 2,
                "execution_order_events": 4,
                "order_feed_source_windows": 4,
                "trade_decisions": 2,
            },
        )
        self.assertTrue(_runtime_ledger_bucket_profit_proof_present(bucket))

    def test_build_realized_strategy_pnl_rows_precomputes_event_sourced_orders(
        self,
    ) -> None:
        def execution_row(
            execution_id: str,
            event_at: datetime,
            side: str,
            price: str,
            order_id: str,
        ) -> dict[str, object]:
            return {
                "execution_id": execution_id,
                "computed_at": event_at,
                "execution_event_at": event_at,
                "symbol": "AAPL",
                "side": side,
                "filled_qty": Decimal("1"),
                "avg_fill_price": Decimal(price),
                "cost_amount": Decimal("0.01"),
                "cost_basis": "broker_reported_commission_and_fees",
                "account_label": "TORGHUT_SIM",
                "strategy_id": "microbar-cross-sectional-pairs-v1",
                "alpaca_order_id": order_id,
            }

        current_rows = [
            execution_row(
                "execution-current-buy",
                datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                "buy",
                "100",
                "order-current-buy",
            ),
            execution_row(
                "execution-current-sell",
                datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
                "sell",
                "101",
                "order-current-sell",
            ),
        ]
        carry_in_rows = [
            execution_row(
                f"execution-carry-{index}",
                datetime(2026, 3, 6, 14, 30 + index, tzinfo=timezone.utc),
                "buy" if index % 2 == 0 else "sell",
                "100",
                f"order-carry-{index}",
            )
            for index in range(6)
        ]

        with patch(
            "scripts.import_hypothesis_runtime_windows._event_sourced_fill_economics_order_ids",
            return_value=set(),
        ) as event_sourced_order_ids:
            rows = _build_realized_strategy_pnl_rows(
                current_rows,
                carry_in_execution_rows=carry_in_rows,
                allow_authoritative_runtime_ledger_materialization=True,
            )

        self.assertTrue(rows)
        self.assertLessEqual(event_sourced_order_ids.call_count, 3)

    def test_build_realized_strategy_pnl_rows_blocks_modeled_fee_short_round_trip(
        self,
    ) -> None:
        rows = _build_realized_strategy_pnl_rows(
            [
                {
                    "execution_id": "execution-short",
                    "trade_decision_id": "decision-short-id",
                    "computed_at": datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                    "execution_event_at": datetime(
                        2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc
                    ),
                    "symbol": "AMZN",
                    "side": "sell_short",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("101"),
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-short",
                    "alpaca_order_id": "order-short",
                    "execution_policy_hash": "policy-short",
                    "lineage_hash": "lineage-sha",
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                    "source_topic": "alpaca.trade_updates",
                    "asset_class": "us_equity",
                },
                {
                    "execution_id": "execution-cover",
                    "trade_decision_id": "decision-cover-id",
                    "computed_at": datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
                    "execution_event_at": datetime(
                        2026, 3, 6, 14, 40, 1, tzinfo=timezone.utc
                    ),
                    "symbol": "AMZN",
                    "side": "buy_to_cover",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-cover",
                    "alpaca_order_id": "order-cover",
                    "execution_policy_hash": "policy-cover",
                    "lineage_hash": "lineage-sha",
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                    "source_topic": "alpaca.trade_updates",
                    "asset_class": "us_equity",
                },
            ],
            decision_lifecycle_rows=[
                {
                    "trade_decision_id": "decision-short-id",
                    "computed_at": datetime(2026, 3, 6, 14, 34, tzinfo=timezone.utc),
                    "event_type": "decision",
                    "symbol": "AMZN",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-short",
                    "decision_json": {"account": {"equity": "10000"}},
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                    "lineage_hash": "lineage-sha",
                },
                {
                    "trade_decision_id": "decision-cover-id",
                    "computed_at": datetime(2026, 3, 6, 14, 39, tzinfo=timezone.utc),
                    "event_type": "decision",
                    "symbol": "AMZN",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-cover",
                    "decision_json": {"account": {"equity": "10000"}},
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                    "lineage_hash": "lineage-sha",
                },
            ],
            order_lifecycle_rows=[
                {
                    "execution_order_event_id": "event-new-short",
                    "trade_decision_id": "decision-short-id",
                    "event_ts": datetime(2026, 3, 6, 14, 34, 1, tzinfo=timezone.utc),
                    "event_type": "new",
                    "symbol": "AMZN",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-short",
                    "alpaca_order_id": "order-short",
                    "execution_policy_hash": "policy-short",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 300,
                    "source_window_id": "source-window-new-short",
                },
                {
                    "execution_order_event_id": "event-new-cover",
                    "trade_decision_id": "decision-cover-id",
                    "event_ts": datetime(2026, 3, 6, 14, 39, 1, tzinfo=timezone.utc),
                    "event_type": "new",
                    "symbol": "AMZN",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-cover",
                    "alpaca_order_id": "order-cover",
                    "execution_policy_hash": "policy-cover",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 301,
                    "source_window_id": "source-window-new-cover",
                },
                {
                    "execution_order_event_id": "event-fill-short",
                    "trade_decision_id": "decision-short-id",
                    "execution_id": "execution-short",
                    "event_ts": datetime(2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc),
                    "event_type": "filled",
                    "symbol": "AMZN",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-short",
                    "alpaca_order_id": "order-short",
                    "execution_policy_hash": "policy-short",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 302,
                    "source_window_id": "source-window-fill-short",
                },
                {
                    "execution_order_event_id": "event-fill-cover",
                    "trade_decision_id": "decision-cover-id",
                    "execution_id": "execution-cover",
                    "event_ts": datetime(2026, 3, 6, 14, 40, 1, tzinfo=timezone.utc),
                    "event_type": "filled",
                    "symbol": "AMZN",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-cover",
                    "alpaca_order_id": "order-cover",
                    "execution_policy_hash": "policy-cover",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 303,
                    "source_window_id": "source-window-fill-cover",
                },
            ],
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        self.assertFalse(rows[0]["post_cost_promotion_eligible"])
        self.assertFalse(rows[0]["authoritative"])
        bucket = rows[0]["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertIn(
            "runtime_ledger_cost_basis_non_promotion_grade",
            bucket["blockers"],
        )
        self.assertEqual(bucket["closed_trade_count"], 0)
        self.assertEqual(bucket["open_position_count"], 0)
        self.assertEqual(bucket["filled_notional"], "0")
        self.assertEqual(bucket["gross_strategy_pnl"], "0")
        self.assertEqual(bucket["cost_amount"], "0")
        self.assertEqual(bucket["net_strategy_pnl_after_costs"], "0")
        self.assertEqual(bucket["cost_basis_counts"], {})
        self.assertEqual(bucket["cost_model_hash_counts"], {})
        self.assertEqual(
            bucket["source_decision_mode_counts"],
            {"strategy_signal_paper": 4},
        )
        self.assertEqual(bucket["source_materialization"], "source_execution_lifecycle")
        self.assertFalse(_runtime_ledger_bucket_profit_proof_present(bucket))

    def test_runtime_carry_in_source_filters_reject_wrong_symbol_and_decision(
        self,
    ) -> None:
        bucket = RuntimeLedgerBucket(
            bucket_started_at=datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
            bucket_ended_at=datetime(2026, 3, 6, 14, 45, tzinfo=timezone.utc),
            account_label="TORGHUT_SIM",
            strategy_id="microbar-cross-sectional-pairs-v1",
            symbol="AAPL",
            fill_count=0,
            decision_count=0,
            submitted_order_count=0,
            cancelled_order_count=0,
            rejected_order_count=0,
            unfilled_order_count=0,
            closed_trade_count=0,
            open_position_count=0,
            filled_notional=Decimal("0"),
            gross_strategy_pnl=Decimal("0"),
            cost_amount=Decimal("0"),
            net_strategy_pnl_after_costs=Decimal("0"),
            post_cost_expectancy_bps=None,
            cost_basis_counts={},
            execution_policy_hash_counts={},
            cost_model_hash_counts={},
            lineage_hash_counts={},
            blockers=[],
        )

        rows = _runtime_decision_rows_before_bucket(
            bucket=bucket,
            decision_lifecycle_rows=[
                {
                    "computed_at": datetime(2026, 3, 6, 14, 39, tzinfo=timezone.utc),
                    "symbol": "MSFT",
                    "decision_hash": "wanted",
                },
                {
                    "computed_at": datetime(2026, 3, 6, 14, 46, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "decision_hash": "wanted",
                },
                {
                    "computed_at": datetime(2026, 3, 6, 14, 39, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "decision_hash": "other",
                },
                {
                    "computed_at": datetime(2026, 3, 6, 14, 39, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "decision_hash": "wanted",
                },
            ],
            source_rows=[{"decision_hash": "wanted"}],
        )

        self.assertEqual(
            rows,
            [
                {
                    "computed_at": datetime(2026, 3, 6, 14, 39, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "decision_hash": "wanted",
                }
            ],
        )

    def test_runtime_execution_ledger_fill_helper_validates_and_hashes_cost_model(
        self,
    ) -> None:
        invalid_fill, invalid_times = _runtime_execution_ledger_fill_from_row(
            {
                "computed_at": datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                "symbol": "AAPL",
                "side": "buy",
                "filled_qty": Decimal("1"),
                "avg_fill_price": Decimal("0"),
            },
            order_lifecycle_rows=None,
        )

        self.assertIsNone(invalid_fill)
        self.assertEqual(invalid_times, [])

        fill, event_times = _runtime_execution_ledger_fill_from_row(
            {
                "execution_id": "execution-sell",
                "trade_decision_id": "decision-sell-id",
                "computed_at": datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
                "execution_event_at": datetime(
                    2026, 3, 6, 14, 40, 1, tzinfo=timezone.utc
                ),
                "symbol": "AAPL",
                "side": "sell",
                "filled_qty": Decimal("1"),
                "avg_fill_price": Decimal("101"),
                "cost_amount": Decimal("0.02"),
                "cost_basis": "alpaca_2026_equity_fee_schedule",
                "account_label": "TORGHUT_SIM",
                "strategy_id": "microbar-cross-sectional-pairs-v1",
            },
            order_lifecycle_rows=None,
        )

        self.assertIsNotNone(fill)
        assert fill is not None
        self.assertEqual(fill.cost_model_hash, _alpaca_2026_equity_fee_schedule_hash())
        self.assertEqual(
            event_times,
            [
                datetime(2026, 3, 6, 14, 40, 1, tzinfo=timezone.utc),
                datetime(2026, 3, 6, 14, 40, 1, tzinfo=timezone.utc),
            ],
        )
