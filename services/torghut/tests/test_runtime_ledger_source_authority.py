from __future__ import annotations

from datetime import datetime
from unittest import TestCase

from app.trading.runtime_ledger_source_authority import (
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
