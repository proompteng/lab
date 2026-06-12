from __future__ import annotations

# ruff: noqa: F403,F405
from tests.runtime_window_import.runtime_window_import_base import *


class TestRuntimeWindowImportAuthority(RuntimeWindowImportTestCaseBase):
    def test_runtime_ledger_profit_proof_requires_explicit_authority_marker(
        self,
    ) -> None:
        missing_marker = _complete_runtime_ledger_bucket(
            authority_class=None,
            authority_reason=None,
        )
        missing_reason = _complete_runtime_ledger_bucket(authority_reason=None)

        self.assertIn(
            "runtime_ledger_authority_class_missing",
            _runtime_ledger_bucket_profit_proof_blockers(missing_marker),
        )
        self.assertFalse(_runtime_ledger_bucket_profit_proof_present(missing_marker))
        self.assertIn(
            "runtime_ledger_authority_class_missing",
            _runtime_ledger_bucket_profit_proof_blockers(missing_reason),
        )
        self.assertFalse(_runtime_ledger_bucket_profit_proof_present(missing_reason))

    def test_runtime_ledger_profit_proof_requires_explicit_cost_basis_and_amount(
        self,
    ) -> None:
        for bucket in (
            _complete_runtime_ledger_bucket(cost_amount=None),
            _complete_runtime_ledger_bucket(cost_basis_counts={}, cost_basis=None),
            _complete_runtime_ledger_bucket(
                cost_basis_counts={"modeled_paper_cost_budget": 2},
                cost_basis=None,
            ),
            _complete_runtime_ledger_bucket(
                cost_basis_counts={"broker_reported": "not-a-number"},
                cost_basis=None,
            ),
        ):
            blockers = _runtime_ledger_bucket_profit_proof_blockers(bucket)
            self.assertIn("runtime_ledger_explicit_costs_missing", blockers)
            self.assertFalse(_runtime_ledger_bucket_profit_proof_present(bucket))

        post_cost_basis_bucket = _complete_runtime_ledger_bucket(
            cost_basis_counts={},
            post_cost_basis_counts={"broker_reported": 2},
            cost_basis=None,
        )
        self.assertNotIn(
            "runtime_ledger_explicit_costs_missing",
            _runtime_ledger_bucket_profit_proof_blockers(post_cost_basis_bucket),
        )
        self.assertTrue(
            _runtime_ledger_bucket_profit_proof_present(post_cost_basis_bucket)
        )

    def test_runtime_ledger_profit_proof_blocks_old_exact_replay_empty_blockers(
        self,
    ) -> None:
        old_exact_replay = {
            key: value
            for key, value in _complete_runtime_ledger_bucket(
                ledger_schema_version="torghut.exact_replay_ledger.v1",
                blockers=[],
            ).items()
            if key
            not in {
                "source_refs",
                "source_row_counts",
                "source_window_ids",
                "source_window_refs",
                "trade_decision_ids",
                "execution_ids",
                "execution_order_event_ids",
                "source_offsets",
                "source_materialization",
                "authority_class",
                "authority_reason",
                "pnl_derivation",
            }
        }

        blockers = _runtime_ledger_bucket_profit_proof_blockers(old_exact_replay)

        self.assertIn("runtime_ledger_source_refs_missing", blockers)
        self.assertIn("runtime_ledger_source_window_missing", blockers)
        self.assertIn("runtime_ledger_execution_order_event_refs_missing", blockers)
        self.assertIn("runtime_ledger_execution_refs_missing", blockers)
        self.assertIn("runtime_ledger_trade_decision_refs_missing", blockers)
        self.assertIn("runtime_ledger_source_materialization_missing", blockers)
        self.assertIn("runtime_ledger_authority_class_missing", blockers)
        self.assertFalse(_runtime_ledger_bucket_profit_proof_present(old_exact_replay))

    def test_runtime_ledger_source_context_threads_source_window_classification(
        self,
    ) -> None:
        bucket = _with_runtime_ledger_source_authority_context(
            _complete_runtime_ledger_bucket(
                source_row_counts={
                    "trade_decisions": 1,
                    "executions": 1,
                    "execution_order_events": 1,
                    "order_feed_source_windows": 1,
                }
            ),
            source_window_start=datetime(2026, 5, 29, 14, 30, tzinfo=timezone.utc),
            source_window_end=datetime(2026, 5, 29, 15, 0, tzinfo=timezone.utc),
            source_refs=[
                "postgres:trade_decisions",
                "postgres:executions",
                "postgres:execution_tca_metrics",
                "postgres:execution_order_events",
                "postgres:order_feed_source_windows",
            ],
            source_row_counts={
                "trade_decisions": 1,
                "executions": 1,
                "execution_order_events": 1,
                "order_feed_source_windows": 1,
            },
            trade_decision_ids=["decision-1"],
            execution_ids=["execution-1"],
            execution_order_event_ids=["event-1"],
            source_window_ids=["window-1"],
            source_offsets=[
                {"topic": "alpaca.trade_updates", "partition": 0, "offset": 42}
            ],
            source_window_status_counts={"inserted": 1},
            source_window_classification_counts={"inserted": 1},
            order_feed_lifecycle_complete=True,
            execution_economics_complete=True,
            source_materialization="execution_order_events",
            authority_class="runtime_order_feed_execution_source",
        )

        self.assertEqual(bucket["source_window_status_counts"], {"inserted": 1})
        self.assertEqual(bucket["source_window_classification_counts"], {"inserted": 1})
        self.assertTrue(bucket["order_feed_lifecycle_complete"])
        self.assertTrue(bucket["execution_economics_complete"])
        self.assertEqual(
            bucket["source_row_counts"],
            {
                "execution_order_events": 1,
                "executions": 1,
                "order_feed_source_windows": 1,
                "trade_decisions": 1,
            },
        )
        self.assertEqual(_runtime_ledger_bucket_profit_proof_blockers(bucket), [])

    def test_runtime_ledger_source_context_raises_stale_aggregate_counts(
        self,
    ) -> None:
        bucket = _with_runtime_ledger_source_authority_context(
            _complete_runtime_ledger_bucket(
                source_row_counts={
                    "trade_decisions": 1,
                    "executions": 1,
                    "execution_order_events": 1,
                    "order_feed_source_windows": 1,
                }
            ),
            source_window_start=datetime(2026, 5, 29, 14, 30, tzinfo=timezone.utc),
            source_window_end=datetime(2026, 5, 29, 15, 0, tzinfo=timezone.utc),
            source_refs=[
                "postgres:trade_decisions",
                "postgres:executions",
                "postgres:execution_tca_metrics",
                "postgres:execution_order_events",
                "postgres:order_feed_source_windows",
            ],
            source_row_counts={
                "trade_decisions": 2,
                "executions": 2,
                "execution_tca_metrics": 2,
                "execution_order_events": 4,
                "order_feed_source_windows": 4,
            },
            trade_decision_ids=["decision-buy", "decision-sell"],
            execution_ids=["execution-buy", "execution-sell"],
            execution_tca_metric_ids=["tca-buy", "tca-sell"],
            execution_order_event_ids=[
                "event-new-buy",
                "event-fill-buy",
                "event-new-sell",
                "event-fill-sell",
            ],
            source_window_ids=[
                "window-new-buy",
                "window-fill-buy",
                "window-new-sell",
                "window-fill-sell",
            ],
            source_offsets=[
                {"topic": "alpaca.trade_updates", "partition": 0, "offset": 1},
                {"topic": "alpaca.trade_updates", "partition": 0, "offset": 2},
                {"topic": "alpaca.trade_updates", "partition": 0, "offset": 3},
                {"topic": "alpaca.trade_updates", "partition": 0, "offset": 4},
            ],
            order_feed_lifecycle_complete=True,
            execution_economics_complete=True,
            source_materialization="execution_order_events",
            authority_class="runtime_order_feed_execution_source",
        )

        self.assertEqual(
            bucket["source_row_counts"],
            {
                "execution_order_events": 4,
                "execution_tca_metrics": 2,
                "executions": 2,
                "order_feed_source_windows": 4,
                "trade_decisions": 2,
            },
        )
        self.assertEqual(_runtime_ledger_bucket_profit_proof_blockers(bucket), [])

    def test_source_backed_lifecycle_without_costs_uses_execution_economics_for_authority(
        self,
    ) -> None:
        decision_rows, order_rows, execution_rows = _source_backed_runtime_split_rows()
        order_rows.append(
            {
                "trade_decision_id": "unrelated-decision",
                "event_ts": _runtime_split_ts(3),
                "event_type": "new",
                "symbol": "TSLA",
                "account_label": "paper",
                "strategy_id": "strategy-1",
                "decision_hash": "unrelated-decision",
                "alpaca_order_id": "unrelated-order",
                "execution_order_event_id": "event-unrelated-order",
                "source_window_id": "window-unrelated-order",
                "source_topic": "alpaca.trade_updates",
                "source_partition": 0,
                "source_offset": 900,
                "source_decision_mode": "strategy_signal_paper",
                "lineage_hash": "lineage",
            }
        )

        rows = _build_realized_strategy_pnl_rows(
            execution_rows,
            decision_lifecycle_rows=decision_rows,
            order_lifecycle_rows=order_rows,
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertTrue(row["authoritative"])
        self.assertEqual(row["runtime_ledger_blockers"], [])
        self.assertEqual(
            row["authority_reason"], "event_sourced_runtime_ledger_profit_proof"
        )
        bucket = row["runtime_ledger_bucket"]
        assert isinstance(bucket, dict)
        self.assertTrue(bucket["order_feed_lifecycle_complete"])
        self.assertTrue(bucket["execution_economics_complete"])
        self.assertEqual(bucket["source_materialization"], "source_execution_lifecycle")
        self.assertEqual(
            bucket["authority_class"],
            "source_execution_lifecycle_materialized_runtime_ledger",
        )
        self.assertEqual(
            bucket["source_row_counts"],
            {
                "execution_order_events": 4,
                "execution_tca_metrics": 2,
                "executions": 2,
                "order_feed_source_windows": 4,
                "trade_decisions": 2,
            },
        )
        self.assertEqual(
            bucket["cost_basis_counts"], {"broker_reported_commission_and_fees": 2}
        )

    def test_side_less_order_feed_fills_use_linked_execution_side_for_authority(
        self,
    ) -> None:
        decision_rows, order_rows, execution_rows = _source_backed_runtime_split_rows()
        for row in order_rows:
            row.pop("side", None)
            if row["event_type"] != "fill":
                continue
            if row["alpaca_order_id"] == "order-buy":
                row["filled_qty"] = Decimal("1")
                row["filled_qty_delta"] = Decimal("1")
                row["avg_fill_price"] = Decimal("100")
                row["filled_notional_delta"] = Decimal("100")
            else:
                row["filled_qty"] = Decimal("1")
                row["filled_qty_delta"] = Decimal("1")
                row["avg_fill_price"] = Decimal("101")
                row["filled_notional_delta"] = Decimal("101")
            row["fill_quantity_basis"] = "cumulative_to_delta"
            row["cost_amount"] = Decimal("0.01")
            row["cost_basis"] = "broker_reported_commission_and_fees"

        rows = _build_realized_strategy_pnl_rows(
            execution_rows,
            decision_lifecycle_rows=decision_rows,
            order_lifecycle_rows=order_rows,
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertTrue(row["authoritative"])
        self.assertEqual(row["runtime_ledger_blockers"], [])
        bucket = row["runtime_ledger_bucket"]
        assert isinstance(bucket, dict)
        self.assertEqual(bucket["source_materialization"], "execution_order_events")
        self.assertEqual(bucket["closed_trade_count"], 1)
        self.assertEqual(bucket["open_position_count"], 0)
        self.assertNotIn("unclosed_position", bucket["blockers"])

    def test_source_backed_lifecycle_only_blocks_missing_execution_economics(
        self,
    ) -> None:
        decision_rows, order_rows, _execution_rows = _source_backed_runtime_split_rows(
            include_execution_economics=False
        )
        order_rows.append(
            {
                "trade_decision_id": "unrelated-decision",
                "event_ts": _runtime_split_ts(3),
                "event_type": "new",
                "symbol": "NVDA",
                "account_label": "paper",
                "strategy_id": "strategy-1",
                "decision_hash": "unrelated-decision",
                "alpaca_order_id": "unrelated-order",
                "execution_order_event_id": "event-unrelated-order",
                "source_window_id": "window-unrelated-order",
                "source_topic": "alpaca.trade_updates",
                "source_partition": 0,
                "source_offset": 901,
                "source_decision_mode": "strategy_signal_paper",
                "lineage_hash": "lineage",
            }
        )

        rows = _build_realized_strategy_pnl_rows(
            [],
            decision_lifecycle_rows=decision_rows,
            order_lifecycle_rows=order_rows,
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertFalse(row["authoritative"])
        bucket = row["runtime_ledger_bucket"]
        assert isinstance(bucket, dict)
        self.assertTrue(bucket["order_feed_lifecycle_complete"])
        self.assertFalse(bucket["execution_economics_complete"])
        self.assertIn("execution_economics_missing", row["runtime_ledger_blockers"])
        self.assertIn("runtime_fills_missing", row["runtime_ledger_blockers"])
        self.assertNotIn("order_feed_lifecycle_missing", row["runtime_ledger_blockers"])

    def test_source_backed_lifecycle_blocks_missing_execution_tca_refs(
        self,
    ) -> None:
        decision_rows, order_rows, execution_rows = _source_backed_runtime_split_rows()
        for row in execution_rows:
            row["execution_tca_metric_id"] = None

        rows = _build_realized_strategy_pnl_rows(
            execution_rows,
            decision_lifecycle_rows=decision_rows,
            order_lifecycle_rows=order_rows,
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertFalse(row["authoritative"])
        self.assertFalse(row["post_cost_promotion_eligible"])
        self.assertIn("execution_tca_missing", row["runtime_ledger_blockers"])
        self.assertIn(
            "runtime_ledger_execution_tca_refs_missing",
            row["runtime_ledger_blockers"],
        )
        bucket = row["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertTrue(bucket["execution_tca_required"])
        self.assertIn("execution_tca_missing", bucket["blockers"])
        self.assertIn(
            "runtime_ledger_execution_tca_refs_missing",
            _runtime_ledger_bucket_profit_proof_blockers(bucket),
        )
        self.assertFalse(_runtime_ledger_bucket_profit_proof_present(bucket))

    def test_target_notional_sizing_summary_requires_authoritative_runtime_audit(
        self,
    ) -> None:
        summary = _source_decision_target_notional_sizing_summary(
            [
                {
                    "source_decision_mode": "bounded_paper_route_collection",
                    "paper_route_probe_target_notional": "150",
                    "decision_json": {
                        "paper_route_target_notional_sizing": {
                            "sizing_source": "target_notional",
                            "blockers": [],
                        }
                    },
                },
                {
                    "source_decision_mode": "bounded_paper_route_collection",
                    "paper_route_probe_target_notional": "150",
                },
                {
                    "source_decision_mode": "bounded_paper_route_collection",
                    "paper_route_probe_target_notional": "150",
                    "decision_json": {
                        "paper_route_target_notional_sizing": {
                            "sizing_source": "max_notional",
                            "blockers": [
                                "paper_route_target_notional_qty_below_min_step"
                            ],
                        }
                    },
                },
            ]
        )

        self.assertTrue(summary["requires_target_notional_sizing"])
        self.assertEqual(summary["audit_count"], 2)
        self.assertEqual(summary["authoritative_target_notional_sizing_count"], 1)
        self.assertEqual(summary["missing_target_notional_sizing_count"], 1)
        self.assertEqual(
            summary["non_authoritative_sizing_source_counts"],
            {"max_notional": 1},
        )
        self.assertEqual(
            summary["sizing_blocker_counts"],
            {"paper_route_target_notional_qty_below_min_step": 1},
        )
        self.assertEqual(
            summary["blockers"],
            [
                "paper_route_target_notional_sizing_missing",
                "paper_route_target_notional_sizing_not_authoritative",
                "paper_route_target_notional_qty_below_min_step",
            ],
        )

    def test_target_notional_sizing_summary_excludes_paper_route_exits(
        self,
    ) -> None:
        summary = _source_decision_target_notional_sizing_summary(
            [
                {
                    "trade_decision_id": "entry-decision",
                    "source_decision_mode": "bounded_paper_route_collection",
                    "paper_route_probe_target_notional": "150",
                    "decision_json": {
                        "params": {
                            "source_decision_mode": ("bounded_paper_route_collection"),
                            "paper_route_target_notional_sizing": {
                                "sizing_source": "target_notional",
                                "blockers": [],
                            },
                        }
                    },
                },
                {
                    "trade_decision_id": "exit-decision",
                    "source_decision_mode": "route_acquisition_probe",
                    "decision_json": {
                        "params": {
                            "source_decision_mode": "route_acquisition_probe",
                            "paper_route_probe_exit": {
                                "mode": "paper_route_exit",
                                "source": "filled_paper_route_probe_executions",
                            },
                        }
                    },
                },
                {
                    "trade_decision_id": "exit-decision",
                    "execution_id": "exit-execution",
                    "source_decision_mode": "route_acquisition_probe",
                },
            ]
        )

        self.assertTrue(summary["requires_target_notional_sizing"])
        self.assertEqual(summary["source_row_count"], 3)
        self.assertEqual(summary["target_notional_sizing_required_source_row_count"], 1)
        self.assertEqual(summary["excluded_paper_route_probe_exit_row_count"], 2)
        self.assertEqual(summary["audit_count"], 1)
        self.assertEqual(summary["authoritative_target_notional_sizing_count"], 1)
        self.assertEqual(summary["missing_target_notional_sizing_count"], 0)
        self.assertEqual(summary["blockers"], [])
