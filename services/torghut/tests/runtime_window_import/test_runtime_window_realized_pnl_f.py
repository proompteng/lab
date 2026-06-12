from __future__ import annotations

# ruff: noqa: F403,F405
from tests.runtime_window_import.runtime_window_import_base import *


class TestRuntimeWindowImportRealizedPnlF(RuntimeWindowImportTestCaseBase):
    def test_build_realized_strategy_pnl_rows_materializes_audit_only_runtime_metadata(
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
                        "execution_policy": {
                            "selected_order_type": "limit",
                            "adaptive": {"max_participation_rate": "0.05"},
                        },
                        "cost_model": {
                            "source": "broker_reported",
                            "commission_bps": "0",
                        },
                        "lineage": {
                            "candidate_id": "H-PAIRS-LIVE-PAPER",
                            "runtime_window_id": "2026-03-06-paper",
                        },
                        "runtime_ledger_cost": {
                            "cost_amount": "0.20",
                            "cost_basis": "broker_reported_commission",
                        },
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
                        "execution_policy": {
                            "selected_order_type": "limit",
                            "adaptive": {"max_participation_rate": "0.05"},
                        },
                        "cost_model": {
                            "source": "broker_reported",
                            "commission_bps": "0",
                        },
                        "lineage": {
                            "candidate_id": "H-PAIRS-LIVE-PAPER",
                            "runtime_window_id": "2026-03-06-paper",
                        },
                        "runtime_ledger_cost": {
                            "cost_amount": "0.10",
                            "cost_basis": "broker_reported_commission",
                        },
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
        self.assertFalse(_runtime_ledger_bucket_profit_proof_present(bucket))

    def test_build_realized_strategy_pnl_rows_uses_decision_impact_cost_model(
        self,
    ) -> None:
        decision_json = {
            "params": {
                "execution_policy": {"selected_order_type": "market"},
                "impact_assumptions": {
                    "model": {
                        "commission_bps": "0",
                        "impact_bps_at_full_participation": "50",
                    },
                    "estimate": {"total_cost_bps": "10"},
                },
                "simulation_context": {"dataset_id": "runtime-paper-session"},
            }
        }
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
                    "decision_json": decision_json,
                },
                {
                    "computed_at": datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "side": "sell",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("101"),
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "decision_json": decision_json,
                },
            ],
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["authoritative"], False)
        bucket = rows[0]["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertIn(
            "runtime_ledger_cost_basis_non_promotion_grade", bucket["blockers"]
        )
        self.assertIn("runtime_fills_missing", bucket["blockers"])
        self.assertIn("runtime_decision_lifecycle_missing", bucket["blockers"])
        self.assertIn("submitted_order_lifecycle_missing", bucket["blockers"])
        self.assertIn(
            "execution_reconstruction_not_runtime_ledger_proof",
            bucket["blockers"],
        )
        self.assertEqual(
            bucket["cost_basis_counts"],
            {},
        )
        self.assertEqual(bucket["cost_amount"], "0")
        self.assertEqual(rows[0]["realized_net_pnl"], Decimal("0"))

    def test_build_realized_strategy_pnl_rows_marks_route_acquisition_not_profit_proof(
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
                    "source_decision_mode": "route_acquisition_probe",
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
                    "source_decision_mode": "route_acquisition_probe",
                },
            ],
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(
            row["source_decision_mode_counts"], {"route_acquisition_probe": 2}
        )
        self.assertFalse(row["profit_proof_eligible"])
        self.assertFalse(row["post_cost_promotion_eligible"])
        self.assertIn(
            "source_decision_mode_not_profit_proof_eligible",
            row["runtime_ledger_blockers"],
        )
        self.assertEqual(
            row["promotion_blocker"],
            "execution_reconstruction_not_runtime_ledger_proof",
        )
        bucket = row["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertEqual(
            bucket["source_decision_mode_counts"], {"route_acquisition_probe": 2}
        )
        self.assertFalse(bucket["profit_proof_eligible"])
        self.assertIn(
            "source_decision_mode_not_profit_proof_eligible", bucket["blockers"]
        )
        self.assertFalse(_runtime_ledger_bucket_profit_proof_present(bucket))

    def test_build_realized_strategy_pnl_rows_partitions_mixed_source_decision_modes(
        self,
    ) -> None:
        def execution_row(
            *,
            decision_id: str,
            execution_id: str,
            mode: str,
            side: str,
            price: str,
            minute: int,
        ) -> dict[str, object]:
            return {
                "execution_id": execution_id,
                "trade_decision_id": decision_id,
                "computed_at": datetime(2026, 3, 6, 14, minute, tzinfo=timezone.utc),
                "execution_event_at": datetime(
                    2026,
                    3,
                    6,
                    14,
                    minute,
                    tzinfo=timezone.utc,
                ),
                "symbol": "AAPL",
                "side": side,
                "filled_qty": Decimal("1"),
                "avg_fill_price": Decimal(price),
                "cost_amount": Decimal("0.10"),
                "cost_basis": "broker_reported_commission_and_fees",
                "account_label": "TORGHUT_SIM",
                "strategy_id": "microbar-cross-sectional-pairs-v1",
                "decision_hash": f"{decision_id}-hash",
                "alpaca_order_id": f"{execution_id}-order",
                "execution_policy_hash": "policy-sha",
                "cost_model_hash": "cost-sha",
                "lineage_hash": "lineage-sha",
                "source_decision_mode": mode,
            }

        def decision_row(
            *,
            decision_id: str,
            mode: str,
            minute: int,
        ) -> dict[str, object]:
            return {
                "trade_decision_id": decision_id,
                "computed_at": datetime(2026, 3, 6, 14, minute, tzinfo=timezone.utc),
                "symbol": "AAPL",
                "account_label": "TORGHUT_SIM",
                "strategy_id": "microbar-cross-sectional-pairs-v1",
                "decision_hash": f"{decision_id}-hash",
                "event_type": "decision",
                "execution_policy_hash": "policy-sha",
                "cost_model_hash": "cost-sha",
                "lineage_hash": "lineage-sha",
                "source_decision_mode": mode,
            }

        def order_event_row(
            *,
            decision_id: str,
            execution_id: str,
            mode: str,
            event_id: str,
            event_type: str,
            offset: int,
            minute: int,
        ) -> dict[str, object]:
            row: dict[str, object] = {
                "execution_order_event_id": event_id,
                "trade_decision_id": decision_id,
                "execution_id": execution_id,
                "event_ts": datetime(2026, 3, 6, 14, minute, 1, tzinfo=timezone.utc),
                "symbol": "AAPL",
                "account_label": "TORGHUT_SIM",
                "strategy_id": "microbar-cross-sectional-pairs-v1",
                "decision_hash": f"{decision_id}-hash",
                "alpaca_order_id": f"{execution_id}-order",
                "event_type": event_type,
                "source_topic": "alpaca-trade-updates",
                "source_partition": 0,
                "source_offset": offset,
                "source_window_id": f"source-window-{mode}",
                "execution_policy_hash": "policy-sha",
                "cost_model_hash": "cost-sha",
                "lineage_hash": "lineage-sha",
                "source_decision_mode": mode,
            }
            if event_type in {"fill", "filled", "partial_fill"}:
                avg_fill_price = Decimal(
                    {
                        "route-buy": "100",
                        "route-sell": "101",
                        "signal-buy": "110",
                        "signal-sell": "112",
                    }[decision_id]
                )
                row.update(
                    {
                        "side": "sell" if "sell" in decision_id else "buy",
                        "filled_qty": Decimal("1"),
                        "filled_qty_delta": Decimal("1"),
                        "avg_fill_price": avg_fill_price,
                        "filled_notional_delta": avg_fill_price,
                        "fill_quantity_basis": "cumulative_to_delta",
                        "cost_amount": Decimal("0.10"),
                        "cost_basis": "broker_reported_commission_and_fees",
                    }
                )
            return row

        rows = _build_realized_strategy_pnl_rows(
            [
                execution_row(
                    decision_id="route-buy",
                    execution_id="route-buy-exec",
                    mode="route_acquisition_probe",
                    side="buy",
                    price="100",
                    minute=35,
                ),
                execution_row(
                    decision_id="route-sell",
                    execution_id="route-sell-exec",
                    mode="route_acquisition_probe",
                    side="sell",
                    price="101",
                    minute=36,
                ),
                execution_row(
                    decision_id="signal-buy",
                    execution_id="signal-buy-exec",
                    mode="strategy_signal_paper",
                    side="buy",
                    price="110",
                    minute=45,
                ),
                execution_row(
                    decision_id="signal-sell",
                    execution_id="signal-sell-exec",
                    mode="strategy_signal_paper",
                    side="sell",
                    price="112",
                    minute=50,
                ),
            ],
            decision_lifecycle_rows=[
                decision_row(
                    decision_id="route-buy",
                    mode="route_acquisition_probe",
                    minute=35,
                ),
                decision_row(
                    decision_id="route-sell",
                    mode="route_acquisition_probe",
                    minute=36,
                ),
                decision_row(
                    decision_id="signal-buy",
                    mode="strategy_signal_paper",
                    minute=45,
                ),
                decision_row(
                    decision_id="signal-sell",
                    mode="strategy_signal_paper",
                    minute=50,
                ),
            ],
            order_lifecycle_rows=[
                order_event_row(
                    decision_id="route-buy",
                    execution_id="route-buy-exec",
                    mode="route_acquisition_probe",
                    event_id="route-buy-new",
                    event_type="new",
                    offset=11,
                    minute=35,
                ),
                order_event_row(
                    decision_id="route-buy",
                    execution_id="route-buy-exec",
                    mode="route_acquisition_probe",
                    event_id="route-buy-fill",
                    event_type="fill",
                    offset=12,
                    minute=35,
                ),
                order_event_row(
                    decision_id="route-sell",
                    execution_id="route-sell-exec",
                    mode="route_acquisition_probe",
                    event_id="route-sell-new",
                    event_type="new",
                    offset=13,
                    minute=36,
                ),
                order_event_row(
                    decision_id="route-sell",
                    execution_id="route-sell-exec",
                    mode="route_acquisition_probe",
                    event_id="route-sell-fill",
                    event_type="fill",
                    offset=14,
                    minute=36,
                ),
                order_event_row(
                    decision_id="signal-buy",
                    execution_id="signal-buy-exec",
                    mode="strategy_signal_paper",
                    event_id="signal-buy-new",
                    event_type="new",
                    offset=21,
                    minute=45,
                ),
                order_event_row(
                    decision_id="signal-buy",
                    execution_id="signal-buy-exec",
                    mode="strategy_signal_paper",
                    event_id="signal-buy-fill",
                    event_type="fill",
                    offset=22,
                    minute=45,
                ),
                order_event_row(
                    decision_id="signal-sell",
                    execution_id="signal-sell-exec",
                    mode="strategy_signal_paper",
                    event_id="signal-sell-new",
                    event_type="new",
                    offset=23,
                    minute=50,
                ),
                order_event_row(
                    decision_id="signal-sell",
                    execution_id="signal-sell-exec",
                    mode="strategy_signal_paper",
                    event_id="signal-sell-fill",
                    event_type="fill",
                    offset=24,
                    minute=50,
                ),
            ],
            unlinked_order_lifecycle_rows=[
                order_event_row(
                    decision_id="route-buy",
                    execution_id="route-unlinked-exec",
                    mode="route_acquisition_probe",
                    event_id="route-unlinked-fill",
                    event_type="fill",
                    offset=31,
                    minute=46,
                )
            ],
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 2)
        rows_by_mode = {str(row["source_decision_mode"]): row for row in rows}
        self.assertEqual(
            sorted(rows_by_mode),
            ["route_acquisition_probe", "strategy_signal_paper"],
        )

        route_row = rows_by_mode["route_acquisition_probe"]
        self.assertFalse(route_row["post_cost_promotion_eligible"])
        self.assertIn(
            "source_decision_mode_not_profit_proof_eligible",
            route_row["runtime_ledger_blockers"],
        )

        signal_row = rows_by_mode["strategy_signal_paper"]
        self.assertTrue(signal_row["post_cost_promotion_eligible"])
        self.assertEqual(
            signal_row["authority_reason"],
            "event_sourced_runtime_ledger_profit_proof",
        )
        signal_bucket = cast(Mapping[str, object], signal_row["runtime_ledger_bucket"])
        self.assertEqual(
            signal_bucket["source_decision_mode_counts"],
            {"strategy_signal_paper": 8},
        )
        self.assertNotIn(
            "order_feed_unlinked_fill_lifecycle_present",
            signal_bucket["blockers"],
        )
        self.assertEqual(
            signal_bucket["source_materialization"], "execution_order_events"
        )
        self.assertTrue(_runtime_ledger_bucket_profit_proof_present(signal_bucket))
