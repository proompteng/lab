from __future__ import annotations

from tests.runtime_window_import.runtime_window_import_base import (
    Decimal,
    RuntimeWindowImportTestCaseBase,
    _alpaca_2026_equity_fee_schedule_hash,
    _build_realized_strategy_pnl_rows,
    _order_feed_fill_delta_blockers,
    _order_lifecycle_query_row,
    _required_order_lifecycle_source_row_count,
    _runtime_lifecycle_ledger_row,
    _source_backed_fill_lifecycle_rows,
    _source_backed_order_lifecycle_rows,
    _source_order_feed_payload_delta_fill,
    datetime,
    timezone,
)


class TestRuntimeWindowImportRealizedPnlD(RuntimeWindowImportTestCaseBase):
    def test_source_backed_fill_lifecycle_rows_require_order_event_and_offset_refs(
        self,
    ) -> None:
        rows = _source_backed_fill_lifecycle_rows(
            [
                {
                    "execution_order_event_id": "missing-order-id-event",
                    "event_type": "filled",
                    "symbol": "AAPL",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 110,
                    "source_window_id": "source-window-missing-order",
                },
                {
                    "event_type": "filled",
                    "symbol": "AAPL",
                    "alpaca_order_id": "order-missing-event-ref",
                    "event_fingerprint": "fingerprint-is-not-row-id",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 111,
                    "source_window_id": "source-window-missing-event-ref",
                },
                {
                    "execution_order_event_id": "missing-source-offset-event",
                    "event_type": "filled",
                    "symbol": "AAPL",
                    "alpaca_order_id": "order-missing-source-offset",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_window_id": "source-window-missing-offset",
                },
                {
                    "execution_order_event_id": "source-backed-fill-event",
                    "event_type": "filled",
                    "symbol": "AAPL",
                    "alpaca_order_id": "order-source-backed",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 112,
                    "source_window_id": "source-window-backed",
                },
            ]
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(
            rows[0]["execution_order_event_id"], "source-backed-fill-event"
        )

    def test_source_backed_order_lifecycle_rows_require_row_level_refs(
        self,
    ) -> None:
        rows = _source_backed_order_lifecycle_rows(
            [
                {
                    "execution_order_event_id": "decision-event",
                    "event_type": "decision",
                    "alpaca_order_id": "order-decision",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 120,
                    "source_window_id": "source-window-decision",
                },
                {
                    "execution_order_event_id": "missing-order-id-event",
                    "event_type": "new",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 121,
                    "source_window_id": "source-window-missing-order",
                },
                {
                    "event_type": "new",
                    "alpaca_order_id": "order-missing-event-ref",
                    "event_fingerprint": "fingerprint-is-not-row-id",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 122,
                    "source_window_id": "source-window-missing-event-ref",
                },
                {
                    "execution_order_event_id": "missing-source-window-event",
                    "event_type": "new",
                    "alpaca_order_id": "order-missing-source-window",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 123,
                },
                {
                    "execution_order_event_id": "missing-source-offset-event",
                    "event_type": "new",
                    "alpaca_order_id": "order-missing-source-offset",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_window_id": "source-window-missing-offset",
                },
                {
                    "execution_order_event_id": "source-backed-new-event",
                    "event_type": "new",
                    "alpaca_order_id": "order-source-backed",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 124,
                    "source_window_id": "source-window-backed",
                },
            ]
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["execution_order_event_id"], "source-backed-new-event")
        self.assertEqual(
            _required_order_lifecycle_source_row_count(
                rows,
                expected_order_ids={"order-source-backed", "order-missing"},
            ),
            2,
        )
        self.assertEqual(
            _required_order_lifecycle_source_row_count(
                [
                    {
                        "event_type": "decision",
                        "alpaca_order_id": "order-source-backed",
                    },
                    {
                        "event_type": "new",
                        "alpaca_order_id": "order-other",
                    },
                ],
                expected_order_ids={"order-source-backed"},
            ),
            1,
        )

    def test_build_realized_strategy_pnl_rows_accepts_execution_economics_with_order_feed_lifecycle(
        self,
    ) -> None:
        rows = _build_realized_strategy_pnl_rows(
            [
                {
                    "execution_id": "execution-buy",
                    "computed_at": datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    "execution_event_at": datetime(
                        2026, 3, 6, 14, 31, tzinfo=timezone.utc
                    ),
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
                    "execution_id": "execution-sell",
                    "computed_at": datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    "execution_event_at": datetime(
                        2026, 3, 6, 14, 32, tzinfo=timezone.utc
                    ),
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
                    "computed_at": datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    "event_type": "decision",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-buy",
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
                {
                    "computed_at": datetime(2026, 3, 6, 14, 31, tzinfo=timezone.utc),
                    "event_type": "decision",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-sell",
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
                    "event_ts": datetime(2026, 3, 6, 14, 30, 1, tzinfo=timezone.utc),
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
                    "source_offset": 210,
                    "source_window_id": "source-window-new-buy",
                },
                {
                    "execution_order_event_id": "event-new-sell",
                    "trade_decision_id": "decision-sell",
                    "event_ts": datetime(2026, 3, 6, 14, 31, 1, tzinfo=timezone.utc),
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
                    "source_offset": 211,
                    "source_window_id": "source-window-new-sell",
                },
                {
                    "execution_order_event_id": "event-fill-buy",
                    "trade_decision_id": "decision-buy",
                    "execution_id": "execution-buy",
                    "event_ts": datetime(2026, 3, 6, 14, 31, 1, tzinfo=timezone.utc),
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
                    "source_offset": 212,
                    "source_window_id": "source-window-fill-buy",
                },
                {
                    "execution_order_event_id": "event-fill-sell",
                    "trade_decision_id": "decision-sell",
                    "execution_id": "execution-sell",
                    "event_ts": datetime(2026, 3, 6, 14, 32, 1, tzinfo=timezone.utc),
                    "event_type": "filled",
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
                    "source_offset": 213,
                    "source_window_id": "source-window-fill-sell",
                },
            ],
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["realized_net_pnl"], Decimal("0.70"))
        self.assertEqual(rows[0]["post_cost_promotion_eligible"], True)
        self.assertEqual(rows[0]["authoritative"], True)
        bucket = rows[0]["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertEqual(bucket["blockers"], [])
        self.assertEqual(bucket["source_materialization"], "source_execution_lifecycle")
        self.assertEqual(
            bucket["source_window_start"],
            "2026-03-06T14:30:01+00:00",
        )
        self.assertEqual(
            bucket["source_window_end"],
            "2026-03-06T14:32:01.000001+00:00",
        )
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
            bucket["cost_basis_counts"],
            {"broker_reported_commission_and_fees": 2},
        )

    def test_order_event_lifecycle_uses_execution_raw_order_metadata(self) -> None:
        row = {
            "event_ts": datetime(2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc),
            "event_type": "filled",
            "symbol": "AAPL",
            "account_label": "TORGHUT_SIM",
            "strategy_id": "microbar-cross-sectional-pairs-v1",
            "decision_hash": "decision-buy",
            "alpaca_order_id": "order-buy",
            "raw_event": {
                "event": "fill",
                "order": {
                    "id": "order-buy",
                    "status": "filled",
                    "filled_qty": "1",
                    "filled_avg_price": "100",
                },
            },
            "execution_audit_json": {
                "execution_policy_hash": "policy-sha",
                "cost_model_hash": "cost-sha",
                "lineage_hash": "lineage-sha",
            },
            "raw_order": {
                "side": "buy",
                "runtime_ledger_cost": {
                    "cost_amount": "0.20",
                    "cost_basis": "modeled_paper_cost_budget",
                },
            },
        }

        ledger_row = _runtime_lifecycle_ledger_row(
            row,
            event_type="filled",
            require_complete_fill=True,
        )

        self.assertIsNotNone(ledger_row)
        assert ledger_row is not None
        self.assertEqual(ledger_row["side"], "buy")
        self.assertEqual(ledger_row["filled_qty"], Decimal("1"))
        self.assertEqual(ledger_row["avg_fill_price"], Decimal("100"))
        self.assertEqual(ledger_row["cost_amount"], Decimal("0.20"))
        self.assertEqual(ledger_row["cost_basis"], "modeled_paper_cost_budget")
        self.assertEqual(ledger_row["execution_policy_hash"], "policy-sha")
        self.assertEqual(ledger_row["cost_model_hash"], "cost-sha")
        self.assertEqual(ledger_row["lineage_hash"], "lineage-sha")

    def test_order_event_lifecycle_uses_nested_positive_fill_economics_over_zero_placeholders(
        self,
    ) -> None:
        row = {
            "event_ts": datetime(2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc),
            "event_type": "filled",
            "symbol": "AAPL",
            "account_label": "TORGHUT_SIM",
            "strategy_id": "microbar-cross-sectional-pairs-v1",
            "decision_hash": "decision-buy",
            "alpaca_order_id": "order-buy",
            "filled_qty": Decimal("0"),
            "avg_fill_price": Decimal("0"),
            "filled_notional": Decimal("0"),
            "raw_event": {
                "event": "fill",
                "order": {
                    "id": "order-buy",
                    "status": "filled",
                    "side": "buy",
                    "filled_qty": "1",
                    "filled_avg_price": "100",
                },
            },
            "execution_audit_json": {
                "execution_policy_hash": "policy-sha",
                "cost_model_hash": "cost-sha",
                "lineage_hash": "lineage-sha",
            },
            "raw_order": {
                "runtime_ledger_cost": {
                    "cost_amount": "0.20",
                    "cost_basis": "broker_reported_commission_and_fees",
                },
            },
        }

        ledger_row = _runtime_lifecycle_ledger_row(
            row,
            event_type="filled",
            require_complete_fill=True,
        )

        self.assertIsNotNone(ledger_row)
        assert ledger_row is not None
        self.assertEqual(ledger_row["side"], "buy")
        self.assertEqual(ledger_row["filled_qty"], Decimal("1"))
        self.assertEqual(ledger_row["avg_fill_price"], Decimal("100"))
        self.assertEqual(ledger_row["filled_notional"], Decimal("100"))
        self.assertEqual(ledger_row["cost_amount"], Decimal("0.20"))
        self.assertEqual(
            ledger_row["cost_basis"], "broker_reported_commission_and_fees"
        )

    def test_order_event_lifecycle_does_not_hash_raw_event_as_policy_or_cost(
        self,
    ) -> None:
        row = {
            "event_ts": datetime(2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc),
            "event_type": "filled",
            "symbol": "AAPL",
            "account_label": "TORGHUT_SIM",
            "strategy_id": "microbar-cross-sectional-pairs-v1",
            "decision_hash": "decision-buy",
            "alpaca_order_id": "order-buy",
            "execution_idempotency_key": "order-specific-idempotency-key",
            "decision_json": {
                "candidate_id": "candidate-1",
                "decision_nonce": "changes-every-order",
            },
            "raw_event": {
                "event": "fill",
                "sequence": 25,
                "order": {
                    "id": "order-buy",
                    "status": "filled",
                    "filled_qty": "1",
                    "filled_avg_price": "100",
                },
            },
            "lineage_hash": "lineage-sha",
            "raw_order": {
                "side": "buy",
                "runtime_ledger_cost": {
                    "cost_amount": "0.20",
                    "cost_basis": "broker_reported_commission_and_fees",
                },
            },
        }

        ledger_row = _runtime_lifecycle_ledger_row(
            row,
            event_type="filled",
            require_complete_fill=True,
        )

        self.assertIsNotNone(ledger_row)
        assert ledger_row is not None
        self.assertIsNone(ledger_row["execution_policy_hash"])
        self.assertIsNone(ledger_row["cost_model_hash"])
        self.assertEqual(ledger_row["lineage_hash"], "lineage-sha")
        self.assertEqual(ledger_row["filled_qty"], Decimal("1"))
        self.assertEqual(ledger_row["cost_amount"], Decimal("0.20"))

    def test_source_authority_order_event_lifecycle_requires_fill_delta_basis(
        self,
    ) -> None:
        row = {
            "execution_order_event_id": "event-buy",
            "source_window_id": "source-window-buy",
            "source_offset": 10,
            "event_ts": datetime(2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc),
            "event_type": "filled",
            "symbol": "AAPL",
            "account_label": "TORGHUT_SIM",
            "strategy_id": "microbar-cross-sectional-pairs-v1",
            "decision_hash": "decision-buy",
            "alpaca_order_id": "order-buy",
            "filled_qty": Decimal("2"),
            "avg_fill_price": Decimal("100"),
            "raw_order": {
                "side": "buy",
                "runtime_ledger_cost": {
                    "cost_amount": "0.20",
                    "cost_basis": "broker_reported_commission_and_fees",
                },
            },
        }

        ledger_row = _runtime_lifecycle_ledger_row(
            row,
            event_type="filled",
            require_complete_fill=True,
        )

        self.assertIsNone(ledger_row)

    def test_source_authority_order_event_lifecycle_uses_alpaca_payload_delta(
        self,
    ) -> None:
        row = {
            "execution_order_event_id": "event-sell",
            "source_window_id": "source-window-sell",
            "source_offset": 22007,
            "event_ts": datetime(2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc),
            "event_type": "partial_fill",
            "symbol": "AMZN",
            "account_label": "TORGHUT_SIM",
            "strategy_id": "microbar-cross-sectional-pairs-v1",
            "decision_hash": "decision-sell",
            "alpaca_order_id": "order-sell",
            "source_topic": "torghut.trade-updates.v1",
            "qty": Decimal("41"),
            "filled_qty": Decimal("25"),
            "avg_fill_price": Decimal("271.75"),
            "raw_event": {
                "channel": "trade_updates",
                "payload": {
                    "event": "partial_fill",
                    "qty": "25",
                    "price": "271.75",
                    "order": {
                        "id": "order-sell",
                        "asset_class": "us_equity",
                        "side": "sell",
                        "symbol": "AMZN",
                        "status": "partially_filled",
                        "filled_qty": "25",
                        "filled_avg_price": "271.75",
                    },
                },
            },
            "execution_audit_json": {
                "execution_policy_hash": "policy-sha",
                "lineage_hash": "lineage-sha",
            },
        }

        ledger_row = _runtime_lifecycle_ledger_row(
            row,
            event_type="partial_fill",
            require_complete_fill=True,
        )

        self.assertEqual(_order_feed_fill_delta_blockers(row), [])
        self.assertIsNotNone(ledger_row)
        assert ledger_row is not None
        self.assertEqual(ledger_row["side"], "sell")
        self.assertEqual(ledger_row["filled_qty"], Decimal("25"))
        self.assertEqual(ledger_row["filled_qty_delta"], Decimal("25"))
        self.assertEqual(ledger_row["avg_fill_price"], Decimal("271.75"))
        self.assertEqual(ledger_row["filled_notional"], Decimal("6793.75"))
        self.assertEqual(ledger_row["filled_notional_delta"], Decimal("6793.75"))
        self.assertEqual(ledger_row["fill_quantity_basis"], "delta")
        self.assertEqual(ledger_row["cost_amount"], Decimal("0.16"))
        self.assertEqual(
            ledger_row["cost_basis"],
            "modeled_alpaca_2026_equity_sec_taf_cat_per_order_conservative",
        )
        self.assertEqual(
            ledger_row["cost_model_hash"],
            _alpaca_2026_equity_fee_schedule_hash(),
        )

    def test_source_order_feed_payload_delta_fill_rejects_non_delta_payloads(
        self,
    ) -> None:
        self.assertIsNone(
            _source_order_feed_payload_delta_fill(
                {
                    "raw_event": {
                        "payload": {
                            "event": "fill",
                            "qty": "2",
                            "price": "101.25",
                            "order": {"side": "buy"},
                        }
                    }
                },
                event_type="new",
            )
        )
        self.assertIsNone(
            _source_order_feed_payload_delta_fill(
                {
                    "raw_event": {
                        "payload": {
                            "event": "new",
                            "qty": "2",
                            "price": "101.25",
                            "order": {"side": "buy"},
                        }
                    }
                },
                event_type="fill",
            )
        )
        self.assertIsNone(
            _source_order_feed_payload_delta_fill(
                {
                    "raw_event": {
                        "payload": {
                            "event": "fill",
                            "qty": "0",
                            "price": "101.25",
                            "order": {"side": "buy"},
                        }
                    }
                },
                event_type="fill",
            )
        )

    def test_source_order_feed_payload_delta_fill_accepts_top_level_order_payload(
        self,
    ) -> None:
        self.assertEqual(
            _source_order_feed_payload_delta_fill(
                {
                    "raw_event": {
                        "event": "fill",
                        "qty": "2",
                        "price": "101.25",
                        "order": {"side": "buy"},
                    }
                },
                event_type="fill",
            ),
            (Decimal("2"), Decimal("101.25"), "buy"),
        )

    def test_source_authority_order_event_lifecycle_uses_fill_delta(
        self,
    ) -> None:
        row = {
            "execution_order_event_id": "event-buy",
            "source_window_id": "source-window-buy",
            "source_offset": 10,
            "event_ts": datetime(2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc),
            "event_type": "filled",
            "symbol": "AAPL",
            "account_label": "TORGHUT_SIM",
            "strategy_id": "microbar-cross-sectional-pairs-v1",
            "decision_hash": "decision-buy",
            "alpaca_order_id": "order-buy",
            "filled_qty": Decimal("2"),
            "filled_qty_delta": Decimal("1"),
            "filled_notional_delta": Decimal("100"),
            "fill_quantity_basis": "cumulative_to_delta",
            "avg_fill_price": Decimal("100"),
            "raw_order": {
                "side": "buy",
                "runtime_ledger_cost": {
                    "cost_amount": "0.20",
                    "cost_basis": "broker_reported_commission_and_fees",
                },
            },
        }

        ledger_row = _runtime_lifecycle_ledger_row(
            row,
            event_type="filled",
            require_complete_fill=True,
        )

        self.assertIsNotNone(ledger_row)
        assert ledger_row is not None
        self.assertEqual(ledger_row["filled_qty"], Decimal("1"))
        self.assertEqual(ledger_row["filled_notional"], Decimal("100"))
        self.assertEqual(ledger_row["filled_qty_delta"], Decimal("1"))
        self.assertEqual(ledger_row["fill_quantity_basis"], "cumulative_to_delta")

    def test_order_event_lifecycle_materializes_alpaca_fee_schedule_costs(self) -> None:
        row = {
            "event_ts": datetime(2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc),
            "event_type": "filled",
            "symbol": "AAPL",
            "account_label": "TORGHUT_SIM",
            "strategy_id": "microbar-cross-sectional-pairs-v1",
            "decision_hash": "decision-sell",
            "alpaca_order_id": "order-sell",
            "source_topic": "alpaca-trade-updates",
            "raw_event": {
                "event": "fill",
                "feed": "alpaca",
                "channel": "trade_updates",
                "payload": {
                    "qty": "10",
                    "price": "100",
                    "order": {
                        "id": "order-sell",
                        "asset_class": "us_equity",
                        "side": "sell",
                        "symbol": "AAPL",
                        "status": "filled",
                        "filled_qty": "10",
                        "filled_avg_price": "100",
                    },
                },
            },
            "execution_audit_json": {
                "execution_policy_hash": "policy-sha",
                "lineage_hash": "lineage-sha",
            },
        }

        ledger_row = _runtime_lifecycle_ledger_row(
            row,
            event_type="filled",
            require_complete_fill=True,
        )

        self.assertIsNotNone(ledger_row)
        assert ledger_row is not None
        self.assertEqual(ledger_row["side"], "sell")
        self.assertEqual(ledger_row["filled_qty"], Decimal("10"))
        self.assertEqual(ledger_row["avg_fill_price"], Decimal("100"))
        self.assertEqual(ledger_row["filled_notional"], Decimal("1000"))
        self.assertEqual(ledger_row["cost_amount"], Decimal("0.05"))
        self.assertEqual(
            ledger_row["cost_basis"],
            "modeled_alpaca_2026_equity_sec_taf_cat_per_order_conservative",
        )
        self.assertEqual(
            ledger_row["cost_model_hash"],
            _alpaca_2026_equity_fee_schedule_hash(),
        )

    def test_order_lifecycle_query_row_preserves_fill_economics_columns(
        self,
    ) -> None:
        query_row = (
            "event-1",
            "decision-1",
            "execution-1",
            datetime(2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc),
            "AAPL",
            "TORGHUT_SIM",
            "microbar-cross-sectional-pairs-v1",
            "decision-hash",
            {"source_decision_mode": "strategy_signal_paper"},
            "alpaca-order-1",
            "client-order-1",
            "fill",
            "filled",
            "sell",
            Decimal("10"),
            Decimal("10"),
            Decimal("10"),
            Decimal("100"),
            Decimal("1000"),
            "cumulative_to_delta",
            "fingerprint-1",
            "torghut.trade-updates.v1",
            2,
            22124,
            "source-window-1",
            {"event": "fill"},
            {
                "execution_policy_hash": "policy-sha",
                "lineage_hash": "lineage-sha",
            },
            {
                "runtime_ledger_cost": {
                    "cost_amount": "0.04",
                    "cost_basis": "broker_reported_commission_and_fees",
                }
            },
        )

        row = _order_lifecycle_query_row(query_row)
        ledger_row = _runtime_lifecycle_ledger_row(
            row,
            event_type="fill",
            require_complete_fill=True,
        )

        self.assertEqual(row["side"], "sell")
        self.assertEqual(row["filled_qty"], Decimal("10"))
        self.assertEqual(row["avg_fill_price"], Decimal("100"))
        self.assertEqual(row["source_window_id"], "source-window-1")
        self.assertIsNotNone(ledger_row)
        assert ledger_row is not None
        self.assertEqual(ledger_row["filled_notional"], Decimal("1000"))
        self.assertEqual(ledger_row["cost_amount"], Decimal("0.04"))
        self.assertEqual(ledger_row["source"], "execution_order_event")
