from __future__ import annotations

from tests.runtime_window_import.runtime_window_import_base import (
    Decimal,
    POST_COST_BASIS_EXECUTION_RECONSTRUCTION,
    RuntimeWindowImportTestCaseBase,
    _build_realized_strategy_pnl_rows,
    _runtime_ledger_bucket_profit_proof_present,
    datetime,
    timezone,
)


class TestRuntimeWindowImportRealizedPnlC(RuntimeWindowImportTestCaseBase):
    def test_build_realized_strategy_pnl_rows_uses_carry_in_execution_economics(
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
                    "execution_policy_hash": "policy-sell",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
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
                    "execution_policy_hash": "policy-buy",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
            ],
            split_mixed_source_decision_modes=False,
        )

        self.assertEqual(len(rows), 1)
        bucket = rows[0]["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertEqual(bucket["closed_trade_count"], 1)
        self.assertEqual(bucket["filled_notional"], "201")
        self.assertEqual(bucket["net_strategy_pnl_after_costs"], "0.70")

    def test_build_realized_strategy_pnl_rows_does_not_borrow_source_refs_from_other_symbol(
        self,
    ) -> None:
        rows = _build_realized_strategy_pnl_rows(
            [
                {
                    "execution_id": "aapl-execution-buy",
                    "computed_at": datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "side": "buy",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                    "cost_amount": Decimal("0.20"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "decision_hash": "aapl-decision-buy",
                    "alpaca_order_id": "aapl-order-buy",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
                {
                    "execution_id": "aapl-execution-sell",
                    "computed_at": datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "side": "sell",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("101"),
                    "cost_amount": Decimal("0.10"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "decision_hash": "aapl-decision-sell",
                    "alpaca_order_id": "aapl-order-sell",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
            ],
            decision_lifecycle_rows=[
                {
                    "trade_decision_id": "aapl-decision-buy-id",
                    "computed_at": datetime(2026, 3, 6, 14, 34, tzinfo=timezone.utc),
                    "event_type": "decision",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "aapl-decision-buy",
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
                {
                    "trade_decision_id": "aapl-decision-sell-id",
                    "computed_at": datetime(2026, 3, 6, 14, 39, tzinfo=timezone.utc),
                    "event_type": "decision",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "aapl-decision-sell",
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
            ],
            order_lifecycle_rows=[
                {
                    "execution_order_event_id": "aapl-event-new-buy",
                    "trade_decision_id": "aapl-decision-buy-id",
                    "event_ts": datetime(2026, 3, 6, 14, 34, 1, tzinfo=timezone.utc),
                    "event_type": "new",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "aapl-decision-buy",
                    "alpaca_order_id": "aapl-order-buy",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
                {
                    "execution_order_event_id": "aapl-event-fill-buy",
                    "trade_decision_id": "aapl-decision-buy-id",
                    "execution_id": "aapl-execution-buy",
                    "event_ts": datetime(2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc),
                    "event_type": "filled",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "aapl-decision-buy",
                    "alpaca_order_id": "aapl-order-buy",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
                {
                    "execution_order_event_id": "aapl-event-new-sell",
                    "trade_decision_id": "aapl-decision-sell-id",
                    "event_ts": datetime(2026, 3, 6, 14, 39, 1, tzinfo=timezone.utc),
                    "event_type": "new",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "aapl-decision-sell",
                    "alpaca_order_id": "aapl-order-sell",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
                {
                    "execution_order_event_id": "aapl-event-fill-sell",
                    "trade_decision_id": "aapl-decision-sell-id",
                    "execution_id": "aapl-execution-sell",
                    "event_ts": datetime(2026, 3, 6, 14, 40, 1, tzinfo=timezone.utc),
                    "event_type": "filled",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "aapl-decision-sell",
                    "alpaca_order_id": "aapl-order-sell",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
                {
                    "execution_order_event_id": "msft-event-fill",
                    "trade_decision_id": "msft-decision-id",
                    "execution_id": "msft-execution",
                    "event_ts": datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    "event_type": "filled",
                    "symbol": "MSFT",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "msft-decision",
                    "alpaca_order_id": "msft-order",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 999,
                    "source_window_id": "msft-source-window",
                },
            ],
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["authoritative"], False)
        self.assertEqual(
            rows[0]["authority_reason"],
            "execution_reconstruction_not_runtime_ledger_proof",
        )
        bucket = rows[0]["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertEqual(bucket["symbol"], "AAPL")
        self.assertNotIn("msft-source-window", bucket.get("source_window_ids", []))
        self.assertIn("runtime_ledger_source_window_ids_missing", bucket["blockers"])
        self.assertIn("runtime_ledger_source_offsets_missing", bucket["blockers"])
        self.assertFalse(_runtime_ledger_bucket_profit_proof_present(bucket))

    def test_build_realized_strategy_pnl_rows_requires_order_feed_fill_lifecycle(
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
                    "cost_amount": Decimal("0.10"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
            ],
            decision_lifecycle_rows=[
                {
                    "computed_at": datetime(2026, 3, 6, 14, 34, tzinfo=timezone.utc),
                    "event_type": "decision",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-buy",
                    "decision_json": {"account": {"equity": "10000"}},
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
                {
                    "computed_at": datetime(2026, 3, 6, 14, 39, tzinfo=timezone.utc),
                    "event_type": "decision",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-sell",
                    "decision_json": {"account": {"equity": "10000"}},
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
            ],
            order_lifecycle_rows=[
                {
                    "execution_order_event_id": "dedupe-event-new-buy",
                    "trade_decision_id": "decision-buy",
                    "event_ts": datetime(2026, 3, 6, 14, 34, 1, tzinfo=timezone.utc),
                    "event_type": "new",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 110,
                    "source_window_id": "source-window-dedupe-new-buy",
                },
                {
                    "execution_order_event_id": "dedupe-event-new-sell",
                    "trade_decision_id": "decision-sell",
                    "event_ts": datetime(2026, 3, 6, 14, 39, 1, tzinfo=timezone.utc),
                    "event_type": "new",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 111,
                    "source_window_id": "source-window-dedupe-new-sell",
                },
                {
                    "execution_order_event_id": "dedupe-event-fill-buy",
                    "trade_decision_id": "decision-buy",
                    "execution_id": "dedupe-execution-buy",
                    "event_ts": datetime(2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc),
                    "event_type": "filled",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 112,
                    "source_window_id": "source-window-dedupe-fill-buy",
                },
                {
                    "execution_order_event_id": "dedupe-event-fill-sell",
                    "trade_decision_id": "decision-sell",
                    "execution_id": "dedupe-execution-sell",
                    "event_ts": datetime(2026, 3, 6, 14, 40, 1, tzinfo=timezone.utc),
                    "event_type": "filled",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-unmatched",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 113,
                    "source_window_id": "source-window-dedupe-fill-sell",
                },
            ],
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["post_cost_promotion_eligible"], False)
        self.assertEqual(rows[0]["authoritative"], False)
        self.assertEqual(
            rows[0]["authority_reason"],
            "execution_reconstruction_not_runtime_ledger_proof",
        )
        self.assertIn(
            "order_feed_fill_lifecycle_incomplete",
            rows[0]["runtime_ledger_blockers"],
        )
        bucket = rows[0]["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertIn("order_feed_fill_lifecycle_incomplete", bucket["blockers"])
        self.assertEqual(bucket["pnl_basis"], POST_COST_BASIS_EXECUTION_RECONSTRUCTION)
        self.assertEqual(bucket["authoritative"], False)

    def test_build_realized_strategy_pnl_rows_counts_order_feed_fill_economics(
        self,
    ) -> None:
        rows = _build_realized_strategy_pnl_rows(
            [
                {
                    "computed_at": datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    "execution_event_at": datetime(
                        2026, 3, 6, 14, 31, tzinfo=timezone.utc
                    ),
                    "symbol": "AAPL",
                    "side": "buy",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                    "cost_amount": Decimal("0.20"),
                    "cost_basis": "modeled_paper_cost_budget",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
                {
                    "computed_at": datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    "execution_event_at": datetime(
                        2026, 3, 6, 14, 32, tzinfo=timezone.utc
                    ),
                    "symbol": "AAPL",
                    "side": "sell",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("101"),
                    "cost_amount": Decimal("0.10"),
                    "cost_basis": "modeled_paper_cost_budget",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
            ],
            decision_lifecycle_rows=[
                {
                    "computed_at": datetime(2026, 3, 6, 14, 34, tzinfo=timezone.utc),
                    "event_type": "decision",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-buy",
                    "decision_json": {"account": {"equity": "10000"}},
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
                {
                    "computed_at": datetime(2026, 3, 6, 14, 39, tzinfo=timezone.utc),
                    "event_type": "decision",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-sell",
                    "decision_json": {"account": {"equity": "10000"}},
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
            ],
            order_lifecycle_rows=[
                {
                    "execution_order_event_id": "dedupe-event-new-buy",
                    "trade_decision_id": "decision-buy",
                    "event_ts": datetime(2026, 3, 6, 14, 34, 1, tzinfo=timezone.utc),
                    "event_type": "new",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 110,
                    "source_window_id": "source-window-dedupe-new-buy",
                },
                {
                    "execution_order_event_id": "dedupe-event-new-sell",
                    "trade_decision_id": "decision-sell",
                    "event_ts": datetime(2026, 3, 6, 14, 39, 1, tzinfo=timezone.utc),
                    "event_type": "new",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 111,
                    "source_window_id": "source-window-dedupe-new-sell",
                },
                {
                    "execution_order_event_id": "dedupe-event-fill-buy",
                    "trade_decision_id": "decision-buy",
                    "execution_id": "dedupe-execution-buy",
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
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 112,
                    "source_window_id": "source-window-dedupe-fill-buy",
                },
                {
                    "execution_order_event_id": "dedupe-event-fill-sell",
                    "trade_decision_id": "decision-sell",
                    "execution_id": "dedupe-execution-sell",
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
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 113,
                    "source_window_id": "source-window-dedupe-fill-sell",
                },
            ],
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(
            rows[0]["computed_at"],
            datetime(2026, 3, 6, 14, 40, 1, tzinfo=timezone.utc),
        )
        self.assertEqual(rows[0]["realized_net_pnl"], Decimal("0.70"))
        self.assertEqual(rows[0]["post_cost_promotion_eligible"], True)
        self.assertEqual(rows[0]["authoritative"], True)
        self.assertEqual(
            rows[0]["authority_reason"],
            "event_sourced_runtime_ledger_profit_proof",
        )
        bucket = rows[0]["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertEqual(bucket["fill_count"], 2)
        self.assertEqual(
            bucket["cost_basis_counts"], {"broker_reported_commission_and_fees": 2}
        )
        self.assertEqual(bucket["cost_amount"], "0.30")
        self.assertEqual(bucket["blockers"], [])
        self.assertEqual(bucket["source_materialization"], "execution_order_events")

    def test_build_realized_strategy_pnl_rows_does_not_borrow_source_refs_from_non_fill_lifecycle(
        self,
    ) -> None:
        rows = _build_realized_strategy_pnl_rows(
            [
                {
                    "computed_at": datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    "execution_event_at": datetime(
                        2026, 3, 6, 14, 31, tzinfo=timezone.utc
                    ),
                    "symbol": "AAPL",
                    "side": "buy",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                    "cost_amount": Decimal("0.20"),
                    "cost_basis": "modeled_paper_cost_budget",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
                {
                    "computed_at": datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    "execution_event_at": datetime(
                        2026, 3, 6, 14, 32, tzinfo=timezone.utc
                    ),
                    "symbol": "AAPL",
                    "side": "sell",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("101"),
                    "cost_amount": Decimal("0.10"),
                    "cost_basis": "modeled_paper_cost_budget",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
            ],
            decision_lifecycle_rows=[
                {
                    "computed_at": datetime(2026, 3, 6, 14, 34, tzinfo=timezone.utc),
                    "event_type": "decision",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-buy",
                    "decision_json": {"account": {"equity": "10000"}},
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
                {
                    "computed_at": datetime(2026, 3, 6, 14, 39, tzinfo=timezone.utc),
                    "event_type": "decision",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-sell",
                    "decision_json": {"account": {"equity": "10000"}},
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
            ],
            order_lifecycle_rows=[
                {
                    "execution_order_event_id": "event-new-buy",
                    "trade_decision_id": "decision-buy",
                    "event_ts": datetime(2026, 3, 6, 14, 34, 1, tzinfo=timezone.utc),
                    "event_type": "new",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 110,
                    "source_window_id": "source-window-new-buy",
                },
                {
                    "execution_order_event_id": "event-new-sell",
                    "trade_decision_id": "decision-sell",
                    "event_ts": datetime(2026, 3, 6, 14, 39, 1, tzinfo=timezone.utc),
                    "event_type": "new",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 111,
                    "source_window_id": "source-window-new-sell",
                },
                {
                    "execution_order_event_id": "event-fill-buy",
                    "trade_decision_id": "decision-buy",
                    "execution_id": "execution-buy",
                    "event_ts": datetime(2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc),
                    "event_type": "filled",
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
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
                {
                    "execution_order_event_id": "event-fill-sell",
                    "trade_decision_id": "decision-sell",
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
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
            ],
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["post_cost_promotion_eligible"], False)
        self.assertEqual(rows[0]["authoritative"], False)
        bucket = rows[0]["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertNotIn("source-window-new-buy", bucket.get("source_window_ids", []))
        self.assertNotIn("source-window-new-sell", bucket.get("source_window_ids", []))
        self.assertIn("runtime_ledger_source_window_ids_missing", bucket["blockers"])
        self.assertIn("runtime_ledger_source_offsets_missing", bucket["blockers"])
        self.assertIn(
            "runtime_ledger_source_materialization_missing",
            bucket["blockers"],
        )
        self.assertIn("runtime_ledger_authority_class_missing", bucket["blockers"])
        self.assertFalse(_runtime_ledger_bucket_profit_proof_present(bucket))
