from __future__ import annotations

from datetime import datetime
from unittest import TestCase

from app.trading.runtime_ledger_source_authority import (
    runtime_ledger_promotion_source_authority_blockers,
    runtime_ledger_source_authority_blockers,
    runtime_ledger_source_refs_present,
    runtime_ledger_source_window_present,
)


class TestRuntimeLedgerSourceAuthority(TestCase):
    def test_source_window_accepts_naive_datetime_objects(self) -> None:
        self.assertTrue(
            runtime_ledger_source_window_present(
                {
                    "source_window_start": datetime(2026, 5, 29, 14, 30),
                    "source_window_end": datetime(2026, 5, 29, 15, 0),
                }
            )
        )

    def test_source_window_rejects_invalid_datetime_text(self) -> None:
        self.assertFalse(
            runtime_ledger_source_window_present(
                {
                    "source_window_start": "not-a-date",
                    "source_window_end": "2026-05-29T15:00:00+00:00",
                }
            )
        )

    def test_source_refs_accept_legacy_string_or_mapping_refs_with_rows(self) -> None:
        self.assertTrue(
            runtime_ledger_source_refs_present(
                {
                    "source_ref": "strategy_runtime_ledger_buckets:pairs",
                    "source_row_counts": {
                        "trade_decisions": "not-a-number",
                        "trade_order_events": 2,
                    },
                }
            )
        )
        self.assertTrue(
            runtime_ledger_source_refs_present(
                {
                    "source_ref": {"strategy_runtime_ledger_buckets": "pairs"},
                    "source_row_counts": {"strategy_runtime_ledger_buckets": 1},
                }
            )
        )

    def test_source_refs_require_row_counts(self) -> None:
        self.assertFalse(
            runtime_ledger_source_refs_present(
                {"source_ref": "strategy_runtime_ledger_buckets:pairs"}
            )
        )

    def test_source_authority_blockers_report_missing_parts(self) -> None:
        self.assertEqual(
            runtime_ledger_source_authority_blockers({}),
            [
                "runtime_ledger_source_window_missing",
                "runtime_ledger_source_refs_missing",
            ],
        )

    def test_promotion_source_authority_requires_row_level_runtime_lineage(
        self,
    ) -> None:
        aggregate_only = {
            "source_window_start": "2026-05-29T14:30:00+00:00",
            "source_window_end": "2026-05-29T15:00:00+00:00",
            "source_refs": [
                "postgres:trade_decisions",
                "postgres:executions",
                "postgres:execution_order_events",
            ],
            "source_row_counts": {
                "trade_decisions": 2,
                "executions": 2,
                "execution_order_events": 4,
            },
        }

        blockers = runtime_ledger_promotion_source_authority_blockers(aggregate_only)

        self.assertIn("runtime_ledger_trade_decision_refs_missing", blockers)
        self.assertIn("runtime_ledger_execution_refs_missing", blockers)
        self.assertIn("runtime_ledger_execution_order_event_refs_missing", blockers)
        self.assertIn("runtime_ledger_source_window_ids_missing", blockers)
        self.assertIn("runtime_ledger_source_offsets_missing", blockers)
        self.assertIn("runtime_ledger_source_materialization_missing", blockers)
        self.assertIn("runtime_ledger_authority_class_missing", blockers)

        source_backed = {
            **aggregate_only,
            "trade_decision_ids": ["decision-1", "decision-2"],
            "execution_ids": ["execution-1", "execution-2"],
            "execution_order_event_ids": ["event-1", "event-2"],
            "source_window_ids": ["source-window-1", "source-window-2"],
            "source_offsets": [
                {"topic": "alpaca.trade_updates", "partition": 0, "offset": 42}
            ],
            "source_materialization": "execution_order_events",
            "authority_class": "runtime_order_feed_execution_source",
        }

        self.assertEqual(
            runtime_ledger_promotion_source_authority_blockers(source_backed),
            [],
        )
