from __future__ import annotations

from tests.runtime_window_import.runtime_window_import_base import (
    Decimal,
    POST_COST_BASIS_EXECUTION_RECONSTRUCTION,
    RuntimeWindowImportTestCaseBase,
    _build_realized_strategy_pnl_rows,
    _complete_runtime_ledger_bucket,
    _runtime_ledger_bucket_profit_proof_present,
    _runtime_ledger_tca_materialization_metadata,
    cast,
    datetime,
    timezone,
)


class TestRuntimeWindowImportRealizedPnlE(RuntimeWindowImportTestCaseBase):
    def test_source_backed_round_trip_materializes_nested_fill_economics_over_zero_placeholders(
        self,
    ) -> None:
        common = {
            "account_label": "TORGHUT_SIM",
            "strategy_id": "microbar-cross-sectional-pairs-v1",
            "symbol": "AAPL",
            "lineage_hash": "lineage-sha",
            "source_topic": "alpaca.trade_updates",
            "source_partition": 0,
            "source_window_id": "source-window",
            "source_decision_mode": "strategy_signal_paper",
            "profit_proof_eligible": True,
        }

        def order_row(
            *,
            event_id: str,
            decision_id: str,
            order_id: str,
            event_ts: datetime,
            event_type: str,
            side: str,
            nested_filled_qty: str | None = None,
            nested_avg_price: str | None = None,
            source_offset: int,
        ) -> dict[str, object]:
            raw_order: dict[str, object] = {
                "side": side,
                "runtime_ledger_cost": {
                    "cost_amount": "0.10",
                    "cost_basis": "broker_reported_commission_and_fees",
                },
            }
            raw_event_order: dict[str, object] = {
                "id": order_id,
                "status": "filled" if nested_filled_qty is not None else "new",
                "side": side,
            }
            if nested_filled_qty is not None:
                raw_event_order.update(
                    {
                        "filled_qty": nested_filled_qty,
                        "filled_avg_price": nested_avg_price,
                    }
                )
            row: dict[str, object] = {
                **common,
                "execution_order_event_id": event_id,
                "trade_decision_id": decision_id,
                "decision_hash": decision_id,
                "event_ts": event_ts,
                "event_type": event_type,
                "alpaca_order_id": order_id,
                "execution_policy_hash": f"policy-{side}",
                "cost_model_hash": "cost-sha",
                "source_offset": source_offset,
                "filled_qty": Decimal("0"),
                "avg_fill_price": Decimal("0"),
                "filled_notional": Decimal("0"),
                "raw_event": {"event": event_type, "order": raw_event_order},
                "raw_order": raw_order,
            }
            if nested_filled_qty is not None and nested_avg_price is not None:
                row.update(
                    {
                        "filled_qty_delta": Decimal(nested_filled_qty),
                        "filled_notional_delta": Decimal(nested_filled_qty)
                        * Decimal(nested_avg_price),
                        "fill_quantity_basis": "cumulative_to_delta",
                    }
                )
            return row

        rows = _build_realized_strategy_pnl_rows(
            [
                {
                    **common,
                    "execution_id": "execution-buy",
                    "trade_decision_id": "decision-buy",
                    "computed_at": datetime(2026, 3, 6, 14, 35, 2, tzinfo=timezone.utc),
                    "execution_event_at": datetime(
                        2026, 3, 6, 14, 35, 2, tzinfo=timezone.utc
                    ),
                    "side": "buy",
                    "filled_qty": Decimal("0"),
                    "avg_fill_price": Decimal("0"),
                    "alpaca_order_id": "order-buy",
                    "raw_order": {
                        "side": "buy",
                        "filled_qty": "1",
                        "filled_avg_price": "100",
                        "runtime_ledger_cost": {
                            "cost_amount": "0.10",
                            "cost_basis": "broker_reported_commission_and_fees",
                        },
                    },
                },
                {
                    **common,
                    "execution_id": "execution-sell",
                    "trade_decision_id": "decision-sell",
                    "computed_at": datetime(2026, 3, 6, 14, 40, 2, tzinfo=timezone.utc),
                    "execution_event_at": datetime(
                        2026, 3, 6, 14, 40, 2, tzinfo=timezone.utc
                    ),
                    "side": "sell",
                    "filled_qty": Decimal("0"),
                    "avg_fill_price": Decimal("0"),
                    "alpaca_order_id": "order-sell",
                    "raw_order": {
                        "side": "sell",
                        "filled_qty": "1",
                        "filled_avg_price": "101",
                        "runtime_ledger_cost": {
                            "cost_amount": "0.10",
                            "cost_basis": "broker_reported_commission_and_fees",
                        },
                    },
                },
            ],
            decision_lifecycle_rows=[
                {
                    **common,
                    "trade_decision_id": "decision-buy",
                    "decision_hash": "decision-buy",
                    "event_type": "decision",
                    "computed_at": datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                },
                {
                    **common,
                    "trade_decision_id": "decision-sell",
                    "decision_hash": "decision-sell",
                    "event_type": "decision",
                    "computed_at": datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
                },
            ],
            order_lifecycle_rows=[
                order_row(
                    event_id="event-new-buy",
                    decision_id="decision-buy",
                    order_id="order-buy",
                    event_ts=datetime(2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc),
                    event_type="new",
                    side="buy",
                    source_offset=1,
                ),
                order_row(
                    event_id="event-fill-buy",
                    decision_id="decision-buy",
                    order_id="order-buy",
                    event_ts=datetime(2026, 3, 6, 14, 35, 2, tzinfo=timezone.utc),
                    event_type="filled",
                    side="buy",
                    nested_filled_qty="1",
                    nested_avg_price="100",
                    source_offset=2,
                ),
                order_row(
                    event_id="event-new-sell",
                    decision_id="decision-sell",
                    order_id="order-sell",
                    event_ts=datetime(2026, 3, 6, 14, 40, 1, tzinfo=timezone.utc),
                    event_type="new",
                    side="sell",
                    source_offset=3,
                ),
                order_row(
                    event_id="event-fill-sell",
                    decision_id="decision-sell",
                    order_id="order-sell",
                    event_ts=datetime(2026, 3, 6, 14, 40, 2, tzinfo=timezone.utc),
                    event_type="filled",
                    side="sell",
                    nested_filled_qty="1",
                    nested_avg_price="101",
                    source_offset=4,
                ),
            ],
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0]["authoritative"])
        self.assertTrue(rows[0]["post_cost_promotion_eligible"])
        bucket = rows[0]["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertEqual(bucket["blockers"], [])
        self.assertEqual(bucket["filled_notional"], "201")
        self.assertEqual(bucket["open_position_count"], 0)
        self.assertEqual(bucket["closed_trade_count"], 1)
        self.assertEqual(
            bucket["source_refs"],
            [
                "postgres:trade_decisions",
                "postgres:executions",
                "postgres:execution_order_events",
                "postgres:order_feed_source_windows",
            ],
        )
        self.assertEqual(bucket["source_materialization"], "execution_order_events")
        self.assertEqual(
            bucket["execution_ids"],
            ["execution-buy", "execution-sell"],
        )

    def test_source_backed_round_trip_materializes_alpaca_payload_delta_when_columns_missing(
        self,
    ) -> None:
        common = {
            "account_label": "TORGHUT_SIM",
            "strategy_id": "microbar-cross-sectional-pairs-v1",
            "symbol": "AAPL",
            "lineage_hash": "lineage-sha",
            "source_topic": "torghut.trade-updates.v1",
            "source_partition": 0,
            "source_window_id": "source-window",
            "source_decision_mode": "strategy_signal_paper",
            "profit_proof_eligible": True,
            "execution_policy_hash": "policy-sha",
            "cost_model_hash": "cost-sha",
        }

        def order_row(
            *,
            event_id: str,
            decision_id: str,
            order_id: str,
            event_ts: datetime,
            event_type: str,
            side: str,
            payload_qty: str | None,
            payload_price: str | None,
            source_offset: int,
        ) -> dict[str, object]:
            raw_event_payload: dict[str, object] = {
                "event": event_type,
                "order": {
                    "id": order_id,
                    "asset_class": "us_equity",
                    "status": "filled" if payload_qty is not None else "new",
                    "side": side,
                    "symbol": "AAPL",
                },
            }
            if payload_qty is not None and payload_price is not None:
                raw_event_payload.update({"qty": payload_qty, "price": payload_price})
                cast(dict[str, object], raw_event_payload["order"]).update(
                    {
                        "filled_qty": payload_qty,
                        "filled_avg_price": payload_price,
                    }
                )
            return {
                **common,
                "execution_order_event_id": event_id,
                "trade_decision_id": decision_id,
                "decision_hash": decision_id,
                "event_ts": event_ts,
                "event_type": event_type,
                "alpaca_order_id": order_id,
                "source_offset": source_offset,
                "qty": Decimal("2"),
                "filled_qty": Decimal(payload_qty or "0"),
                "avg_fill_price": Decimal(payload_price or "0"),
                "cost_amount": Decimal("0.10") if payload_qty is not None else None,
                "cost_basis": (
                    "broker_reported_commission_and_fees"
                    if payload_qty is not None
                    else None
                ),
                "raw_event": {
                    "channel": "trade_updates",
                    "payload": raw_event_payload,
                },
            }

        rows = _build_realized_strategy_pnl_rows(
            [
                {
                    **common,
                    "execution_id": "execution-buy",
                    "trade_decision_id": "decision-buy",
                    "computed_at": datetime(2026, 3, 6, 14, 35, 2, tzinfo=timezone.utc),
                    "execution_event_at": datetime(
                        2026, 3, 6, 14, 35, 2, tzinfo=timezone.utc
                    ),
                    "side": "buy",
                    "filled_qty": Decimal("0"),
                    "avg_fill_price": Decimal("0"),
                    "alpaca_order_id": "order-buy",
                    "raw_order": {
                        "side": "buy",
                        "filled_qty": "1",
                        "filled_avg_price": "100",
                    },
                },
                {
                    **common,
                    "execution_id": "execution-sell",
                    "trade_decision_id": "decision-sell",
                    "computed_at": datetime(2026, 3, 6, 14, 40, 2, tzinfo=timezone.utc),
                    "execution_event_at": datetime(
                        2026, 3, 6, 14, 40, 2, tzinfo=timezone.utc
                    ),
                    "side": "sell",
                    "filled_qty": Decimal("0"),
                    "avg_fill_price": Decimal("0"),
                    "alpaca_order_id": "order-sell",
                    "raw_order": {
                        "side": "sell",
                        "filled_qty": "1",
                        "filled_avg_price": "101",
                    },
                },
            ],
            decision_lifecycle_rows=[
                {
                    **common,
                    "trade_decision_id": "decision-buy",
                    "decision_hash": "decision-buy",
                    "event_type": "decision",
                    "computed_at": datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                },
                {
                    **common,
                    "trade_decision_id": "decision-sell",
                    "decision_hash": "decision-sell",
                    "event_type": "decision",
                    "computed_at": datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
                },
            ],
            order_lifecycle_rows=[
                order_row(
                    event_id="event-new-buy",
                    decision_id="decision-buy",
                    order_id="order-buy",
                    event_ts=datetime(2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc),
                    event_type="new",
                    side="buy",
                    payload_qty=None,
                    payload_price=None,
                    source_offset=1,
                ),
                order_row(
                    event_id="event-fill-buy",
                    decision_id="decision-buy",
                    order_id="order-buy",
                    event_ts=datetime(2026, 3, 6, 14, 35, 2, tzinfo=timezone.utc),
                    event_type="filled",
                    side="buy",
                    payload_qty="1",
                    payload_price="100",
                    source_offset=2,
                ),
                order_row(
                    event_id="event-new-sell",
                    decision_id="decision-sell",
                    order_id="order-sell",
                    event_ts=datetime(2026, 3, 6, 14, 40, 1, tzinfo=timezone.utc),
                    event_type="new",
                    side="sell",
                    payload_qty=None,
                    payload_price=None,
                    source_offset=3,
                ),
                order_row(
                    event_id="event-fill-sell",
                    decision_id="decision-sell",
                    order_id="order-sell",
                    event_ts=datetime(2026, 3, 6, 14, 40, 2, tzinfo=timezone.utc),
                    event_type="filled",
                    side="sell",
                    payload_qty="1",
                    payload_price="101",
                    source_offset=4,
                ),
            ],
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0]["authoritative"])
        self.assertTrue(rows[0]["post_cost_promotion_eligible"])
        bucket = rows[0]["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertEqual(bucket["blockers"], [])
        self.assertEqual(bucket["filled_notional"], "201")
        self.assertEqual(bucket["open_position_count"], 0)
        self.assertEqual(bucket["closed_trade_count"], 1)
        self.assertEqual(bucket["source_materialization"], "execution_order_events")

    def test_build_realized_strategy_pnl_rows_does_not_use_idempotency_key_as_policy_hash(
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
                    "execution_idempotency_key": "buy-order-key",
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
                    "execution_idempotency_key": "sell-order-key",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
            ],
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        bucket = rows[0]["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertEqual(bucket["execution_policy_hash_counts"], {})
        self.assertIn("execution_policy_hash_missing", bucket["blockers"])
        self.assertNotIn("execution_policy_hash_ambiguous", bucket["blockers"])
        self.assertEqual(bucket["cost_model_hash_counts"], {"cost-sha": 2})

    def test_runtime_ledger_tca_materialization_metadata_separates_authority(
        self,
    ) -> None:
        metadata = _runtime_ledger_tca_materialization_metadata(
            [
                {
                    "authoritative": True,
                    "authority_reason": "source_execution_runtime_ledger_materialized",
                    "pnl_derivation": (
                        "source_execution_lifecycle_materialized_runtime_ledger"
                    ),
                    "runtime_ledger_bucket": _complete_runtime_ledger_bucket(
                        source_materialization="source_execution_lifecycle",
                        authoritative=True,
                    ),
                },
                {
                    "authoritative": False,
                    "authority_reason": (
                        "execution_reconstruction_not_runtime_ledger_proof"
                    ),
                    "runtime_ledger_blockers": [
                        "execution_reconstruction_not_runtime_ledger_proof"
                    ],
                    "runtime_ledger_bucket": _complete_runtime_ledger_bucket(
                        pnl_basis=POST_COST_BASIS_EXECUTION_RECONSTRUCTION,
                        blockers=["execution_reconstruction_not_runtime_ledger_proof"],
                        source_materialization=None,
                        authority_class=None,
                        authority_reason=None,
                        pnl_derivation=None,
                    ),
                },
            ]
        )

        self.assertEqual(metadata["runtime_ledger_tca_runtime_bucket_row_count"], 2)
        self.assertEqual(metadata["runtime_ledger_tca_profit_proof_count"], 1)
        self.assertEqual(metadata["runtime_ledger_tca_authoritative_bucket_count"], 1)
        self.assertEqual(
            metadata["runtime_ledger_source_execution_materialized_bucket_count"],
            1,
        )
        self.assertEqual(
            metadata["runtime_ledger_execution_reconstruction_bucket_count"],
            1,
        )
        self.assertEqual(
            metadata["runtime_ledger_materialization_blockers"],
            [
                "execution_reconstruction_not_runtime_ledger_proof",
                "runtime_ledger_authority_class_missing",
                "runtime_ledger_pnl_basis_not_runtime_ledger",
                "runtime_ledger_source_materialization_missing",
            ],
        )
        self.assertEqual(
            metadata["runtime_ledger_profit_proof_blockers"],
            [
                "execution_reconstruction_not_runtime_ledger_proof",
                "runtime_ledger_authority_class_missing",
                "runtime_ledger_pnl_basis_not_runtime_ledger",
                "runtime_ledger_source_materialization_missing",
            ],
        )

    def test_runtime_ledger_tca_materialization_counts_only_source_backed_proof(
        self,
    ) -> None:
        source_backed_bucket = _complete_runtime_ledger_bucket(
            source_materialization="source_execution_lifecycle",
            authoritative=True,
        )
        exact_replay_artifact = _complete_runtime_ledger_bucket(
            source_refs=[],
            source_row_counts={},
            source_window_ids=[],
            trade_decision_ids=[],
            execution_ids=[],
            execution_order_event_ids=[],
            source_offsets=[],
            source_materialization="exact_replay_artifact",
            authority_class="exact_replay_artifact_only_not_live",
            authority_reason="exact_replay_artifact_not_runtime_proof",
            pnl_derivation="exact_replay_artifact_only_not_live",
            blockers=["exact_replay_artifact_not_runtime_proof"],
        )

        metadata = _runtime_ledger_tca_materialization_metadata(
            [
                {
                    "authoritative": True,
                    "authority_reason": "source_execution_runtime_ledger_materialized",
                    "runtime_ledger_bucket": source_backed_bucket,
                },
                {
                    "authoritative": False,
                    "authority_reason": "exact_replay_artifact_not_runtime_proof",
                    "pnl_derivation": "exact_replay_artifact_only_not_live",
                    "runtime_ledger_blockers": [
                        "exact_replay_artifact_not_runtime_proof"
                    ],
                    "runtime_ledger_bucket": exact_replay_artifact,
                },
            ]
        )

        self.assertEqual(metadata["runtime_ledger_tca_runtime_bucket_row_count"], 2)
        self.assertEqual(metadata["runtime_ledger_tca_profit_proof_count"], 1)
        self.assertEqual(
            metadata["runtime_ledger_source_execution_materialized_bucket_count"],
            1,
        )
        self.assertIn(
            "exact_replay_artifact_not_runtime_proof",
            metadata["runtime_ledger_materialization_blockers"],
        )
        self.assertIn(
            "runtime_ledger_source_refs_missing",
            metadata["runtime_ledger_profit_proof_blockers"],
        )

    def test_build_realized_strategy_pnl_rows_normalizes_nested_runtime_payloads(
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
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "execution_audit_json": {
                        "fees": {
                            "cost_amount": "0.20",
                            "cost_basis": "broker_reported_commission_and_fees",
                        },
                        "simulation_context": {
                            "simulation_run_id": "sim-run-1",
                            "dataset_event_id": "evt-buy",
                        },
                    },
                    "raw_order": {
                        "execution_policy": {
                            "selected_order_type": "limit",
                            "adaptive": {"max_participation_rate": "0.05"},
                        },
                        "cost_model": {"commission_bps": "0", "min_commission": "0"},
                    },
                },
                {
                    "computed_at": datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "side": "sell",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("101"),
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "execution_audit_json": {
                        "fees": {
                            "cost_amount": "0.10",
                            "cost_basis": "broker_reported_commission_and_fees",
                        },
                        "simulation_context": {
                            "simulation_run_id": "sim-run-1",
                            "dataset_event_id": "evt-sell",
                        },
                    },
                    "raw_order": {
                        "execution_policy": {
                            "selected_order_type": "limit",
                            "adaptive": {"max_participation_rate": "0.05"},
                        },
                        "cost_model": {"commission_bps": "0", "min_commission": "0"},
                    },
                },
            ]
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["post_cost_promotion_eligible"], False)
        self.assertEqual(rows[0]["realized_net_pnl"], Decimal("0.70"))
        bucket = rows[0]["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertIn("runtime_decision_lifecycle_missing", bucket["blockers"])
        self.assertIn("submitted_order_lifecycle_missing", bucket["blockers"])
        self.assertIn("fill_order_submission_missing", bucket["blockers"])
        self.assertIn(
            "execution_reconstruction_not_runtime_ledger_proof",
            bucket["blockers"],
        )
        self.assertEqual(bucket["pnl_basis"], POST_COST_BASIS_EXECUTION_RECONSTRUCTION)
        self.assertEqual(bucket["authoritative"], False)
        self.assertGreaterEqual(len(bucket["execution_policy_hash_counts"]), 1)
        self.assertGreaterEqual(len(bucket["cost_model_hash_counts"]), 1)
        self.assertGreaterEqual(len(bucket["lineage_hash_counts"]), 1)

    def test_build_realized_strategy_pnl_rows_uses_raw_order_fill_fields(
        self,
    ) -> None:
        rows = _build_realized_strategy_pnl_rows(
            [
                {
                    "computed_at": datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                    "execution_created_at": datetime(
                        2026, 3, 6, 15, 45, tzinfo=timezone.utc
                    ),
                    "symbol": "AAPL",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "execution_audit_json": {
                        "fees": {
                            "cost_amount": "0.20",
                            "cost_basis": "broker_reported_commission_and_fees",
                        },
                        "lineage": {"runtime_window_id": "paper-route-session"},
                    },
                    "raw_order": {
                        "side": "buy",
                        "filled_qty": "1",
                        "filled_avg_price": "100",
                        "execution_policy": {"selected_order_type": "limit"},
                        "cost_model": {"source": "broker_reported"},
                    },
                },
                {
                    "computed_at": datetime(2026, 3, 6, 14, 50, tzinfo=timezone.utc),
                    "execution_created_at": datetime(
                        2026, 3, 6, 15, 55, tzinfo=timezone.utc
                    ),
                    "symbol": "AAPL",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "execution_audit_json": {
                        "fees": {
                            "cost_amount": "0.10",
                            "cost_basis": "broker_reported_commission_and_fees",
                        },
                        "lineage": {"runtime_window_id": "paper-route-session"},
                    },
                    "raw_order": {
                        "side": "sell",
                        "filled_qty": "1",
                        "filled_avg_price": "101",
                        "execution_policy": {"selected_order_type": "limit"},
                        "cost_model": {"source": "broker_reported"},
                    },
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
        self.assertEqual(
            rows[0]["computed_at"], datetime(2026, 3, 6, 15, 55, tzinfo=timezone.utc)
        )
        self.assertEqual(rows[0]["realized_net_pnl"], Decimal("0.70"))
        bucket = rows[0]["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertEqual(bucket["fill_count"], 2)
        self.assertEqual(bucket["filled_notional"], "201")
        self.assertNotIn("runtime_fills_missing", bucket["blockers"])
        self.assertNotIn("filled_notional_missing", bucket["blockers"])
        self.assertNotIn("explicit_cost_missing", bucket["blockers"])
        self.assertIn("runtime_decision_lifecycle_missing", bucket["blockers"])
        self.assertIn("submitted_order_lifecycle_missing", bucket["blockers"])
        self.assertIn("fill_order_submission_missing", bucket["blockers"])
        self.assertIn(
            "execution_reconstruction_not_runtime_ledger_proof",
            bucket["blockers"],
        )
        self.assertFalse(_runtime_ledger_bucket_profit_proof_present(bucket))

    def test_build_realized_strategy_pnl_rows_prefers_execution_event_time(
        self,
    ) -> None:
        rows = _build_realized_strategy_pnl_rows(
            [
                {
                    "computed_at": datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    "execution_created_at": datetime(
                        2026, 3, 6, 14, 30, 5, tzinfo=timezone.utc
                    ),
                    "execution_event_at": datetime(
                        2026, 3, 6, 14, 35, tzinfo=timezone.utc
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
                    "computed_at": datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    "execution_created_at": datetime(
                        2026, 3, 6, 14, 30, 10, tzinfo=timezone.utc
                    ),
                    "execution_event_at": datetime(
                        2026, 3, 6, 14, 40, tzinfo=timezone.utc
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
            ]
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(
            rows[0]["computed_at"], datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc)
        )
        self.assertEqual(rows[0]["realized_net_pnl"], Decimal("0.70"))
