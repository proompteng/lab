from __future__ import annotations

from datetime import datetime
from unittest import TestCase

from app.trading.runtime_ledger_source_authority import (
    runtime_ledger_promotion_source_authority_blockers,
    runtime_ledger_promotion_source_authority_present,
    runtime_ledger_source_authority_blockers,
    runtime_ledger_source_refs_present,
    runtime_ledger_source_window_present,
)


def _economics_payload() -> dict[str, object]:
    return {
        "filled_notional": "1000",
        "cost_amount": "0",
        "cost_basis_counts": {"broker_reported_zero_cost": 1},
        "cost_model_hash_counts": {"cost-model": 1},
    }


def _source_backed_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "source_window_start": "2026-05-29T14:30:00+00:00",
        "source_window_end": "2026-05-29T15:00:00+00:00",
        "source_refs": [
            "postgres:trade_decisions",
            "postgres:executions",
            "postgres:execution_order_events",
            "postgres:order_feed_source_windows",
        ],
        "source_row_counts": {
            "trade_decisions": 1,
            "executions": 1,
            "execution_order_events": 1,
            "order_feed_source_windows": 1,
        },
        **_economics_payload(),
        "trade_decision_id": "decision-1",
        "execution_id": "execution-1",
        "execution_order_event_id": "event-1",
        "source_window_id": "source-window-1",
        "source_offsets": [
            {"topic": "alpaca.trade_updates", "partition": 0, "offset": 42}
        ],
        "source_materialization": "execution_order_events",
        "authority_class": "runtime_order_feed_execution_source",
    }
    payload.update(overrides)
    return payload


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
                "postgres:order_feed_source_windows",
            ],
            "source_row_counts": {
                "trade_decisions": 2,
                "executions": 2,
                "execution_order_events": 2,
                "order_feed_source_windows": 2,
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
            **_economics_payload(),
            "trade_decision_ids": ["decision-1", "decision-2"],
            "execution_ids": ["execution-1", "execution-2"],
            "execution_order_event_ids": ["event-1", "event-2"],
            "source_window_ids": ["source-window-1", "source-window-2"],
            "source_offsets": [
                {"topic": "alpaca.trade_updates", "partition": 0, "offset": 42},
                {"topic": "alpaca.trade_updates", "partition": 0, "offset": 43},
            ],
            "source_materialization": "execution_order_events",
            "authority_class": "runtime_order_feed_execution_source",
        }

        self.assertEqual(
            runtime_ledger_promotion_source_authority_blockers(source_backed),
            [],
        )

    def test_promotion_source_authority_accepts_post_cost_basis_counts(
        self,
    ) -> None:
        source_backed = {
            "source_window_start": "2026-05-29T14:30:00+00:00",
            "source_window_end": "2026-05-29T15:00:00+00:00",
            "source_refs": [
                "postgres:trade_decisions",
                "postgres:executions",
                "postgres:execution_order_events",
                "postgres:order_feed_source_windows",
            ],
            "source_row_counts": {
                "trade_decisions": 1,
                "executions": 1,
                "execution_order_events": 1,
                "order_feed_source_windows": 1,
            },
            "trade_decision_id": "decision-1",
            "execution_id": "execution-1",
            "execution_order_event_id": "event-1",
            "source_window_id": "source-window-1",
            "source_offsets": [
                {"topic": "alpaca.trade_updates", "partition": 0, "offset": 42}
            ],
            "source_materialization": "execution_order_events",
            "authority_class": "runtime_order_feed_execution_source",
            "filled_notional": "1000",
            "cost_amount": "0",
            "post_cost_basis_counts": {"broker_reported_zero_cost": 1},
            "cost_model_hash_counts": {"cost-model": 1},
        }

        self.assertEqual(
            runtime_ledger_promotion_source_authority_blockers(source_backed),
            [],
        )

    def test_promotion_source_authority_rejects_underlinked_row_refs(
        self,
    ) -> None:
        underlinked = {
            "source_window_start": "2026-05-29T14:30:00+00:00",
            "source_window_end": "2026-05-29T15:00:00+00:00",
            "source_refs": [
                "postgres:trade_decisions",
                "postgres:executions",
                "postgres:execution_order_events",
                "postgres:order_feed_source_windows",
            ],
            "source_row_counts": {
                "trade_decisions": 3,
                "executions": 3,
                "execution_order_events": 4,
                "order_feed_source_windows": 3,
            },
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

        blockers = runtime_ledger_promotion_source_authority_blockers(underlinked)

        self.assertIn("runtime_ledger_trade_decision_refs_missing", blockers)
        self.assertIn("runtime_ledger_execution_refs_missing", blockers)
        self.assertIn("runtime_ledger_execution_order_event_refs_missing", blockers)
        self.assertIn("runtime_ledger_source_window_ids_missing", blockers)
        self.assertIn("runtime_ledger_source_offsets_missing", blockers)

    def test_promotion_source_authority_counts_mapping_and_scalar_refs(
        self,
    ) -> None:
        blockers = runtime_ledger_promotion_source_authority_blockers(
            {
                "source_window_start": "2026-05-29T14:30:00+00:00",
                "source_window_end": "2026-05-29T15:00:00+00:00",
                "source_refs": [
                    "postgres:trade_decisions",
                    "postgres:executions",
                    "postgres:execution_order_events",
                    "postgres:order_feed_source_windows",
                ],
                "source_row_counts": {
                    "trade_decisions": 1,
                    "executions": 1,
                    "execution_order_events": 1,
                    "order_feed_source_windows": 1,
                },
                **_economics_payload(),
                "trade_decision_id": "decision-1",
                "execution_id": "execution-1",
                "execution_order_event_id": "event-1",
                "source_window_ids": {"source-window-1": True},
                "source_offsets": [
                    {"topic": "alpaca.trade_updates", "partition": 0, "offset": 42}
                ],
                "source_materialization": "execution_order_events",
                "authority_class": "runtime_order_feed_execution_source",
            }
        )

        self.assertEqual(blockers, [])

    def test_promotion_source_authority_rejects_false_mapping_refs(
        self,
    ) -> None:
        blockers = runtime_ledger_promotion_source_authority_blockers(
            {
                "source_window_start": "2026-05-29T14:30:00+00:00",
                "source_window_end": "2026-05-29T15:00:00+00:00",
                "source_refs": [
                    "postgres:trade_decisions",
                    "postgres:executions",
                    "postgres:execution_order_events",
                    "postgres:order_feed_source_windows",
                ],
                "source_row_counts": {
                    "trade_decisions": 1,
                    "executions": 1,
                    "execution_order_events": 1,
                    "order_feed_source_windows": 1,
                },
                "trade_decision_ids": {"decision-1": False},
                "execution_ids": {"execution-1": False},
                "execution_order_event_ids": {"event-1": False},
                "source_window_ids": {"source-window-1": False},
                "source_offsets": [
                    {"topic": "alpaca.trade_updates", "partition": 0, "offset": 42}
                ],
                "source_materialization": "execution_order_events",
                "authority_class": "runtime_order_feed_execution_source",
            }
        )

        self.assertIn("runtime_ledger_trade_decision_refs_missing", blockers)
        self.assertIn("runtime_ledger_execution_refs_missing", blockers)
        self.assertIn("runtime_ledger_execution_order_event_refs_missing", blockers)
        self.assertIn("runtime_ledger_source_window_ids_missing", blockers)

    def test_promotion_source_authority_rejects_duplicate_refs_and_offsets(
        self,
    ) -> None:
        blockers = runtime_ledger_promotion_source_authority_blockers(
            {
                "source_window_start": "2026-05-29T14:30:00+00:00",
                "source_window_end": "2026-05-29T15:00:00+00:00",
                "source_refs": [
                    "postgres:trade_decisions",
                    "postgres:executions",
                    "postgres:execution_order_events",
                    "postgres:order_feed_source_windows",
                ],
                "source_row_counts": {
                    "trade_decisions": 2,
                    "executions": 2,
                    "execution_order_events": 2,
                    "order_feed_source_windows": 2,
                },
                "trade_decision_ids": ["decision-1", "decision-1"],
                "execution_ids": ["execution-1", "execution-1"],
                "execution_order_event_ids": ["event-1", "event-1"],
                "source_window_ids": ["source-window-1", "source-window-1"],
                "source_offsets": [
                    {"topic": "alpaca.trade_updates", "partition": 0, "offset": 42},
                    {"topic": "alpaca.trade_updates", "partition": 0, "offset": 42},
                ],
                "source_materialization": "execution_order_events",
                "authority_class": "runtime_order_feed_execution_source",
            }
        )

        self.assertIn("runtime_ledger_trade_decision_refs_missing", blockers)
        self.assertIn("runtime_ledger_execution_refs_missing", blockers)
        self.assertIn("runtime_ledger_execution_order_event_refs_missing", blockers)
        self.assertIn("runtime_ledger_source_window_ids_missing", blockers)
        self.assertIn("runtime_ledger_source_offsets_missing", blockers)

    def test_promotion_source_authority_rejects_unstructured_source_offsets(
        self,
    ) -> None:
        base = {
            "source_window_start": "2026-05-29T14:30:00+00:00",
            "source_window_end": "2026-05-29T15:00:00+00:00",
            "source_refs": [
                "postgres:trade_decisions",
                "postgres:executions",
                "postgres:execution_order_events",
                "postgres:order_feed_source_windows",
            ],
            "source_row_counts": {
                "trade_decisions": 2,
                "executions": 2,
                "execution_order_events": 4,
                "order_feed_source_windows": 4,
            },
            "trade_decision_ids": ["decision-1", "decision-2"],
            "execution_ids": ["execution-1", "execution-2"],
            "execution_order_event_ids": ["event-1", "event-2"],
            "source_window_ids": ["source-window-1", "source-window-2"],
            "source_materialization": "execution_order_events",
            "authority_class": "runtime_order_feed_execution_source",
        }

        for malformed_offsets in (
            ["alpaca.trade_updates:0:42"],
            [{"topic": "alpaca.trade_updates", "offset": 42}],
            {"topic": "alpaca.trade_updates", "partition": 0},
        ):
            blockers = runtime_ledger_promotion_source_authority_blockers(
                {**base, "source_offsets": malformed_offsets}
            )
            self.assertIn("runtime_ledger_source_offsets_missing", blockers)

    def test_promotion_source_authority_rejects_pnl_derivation_only_authority(
        self,
    ) -> None:
        blockers = runtime_ledger_promotion_source_authority_blockers(
            {
                "source_window_start": "2026-05-29T14:30:00+00:00",
                "source_window_end": "2026-05-29T15:00:00+00:00",
                "source_refs": [
                    "postgres:trade_decisions",
                    "postgres:executions",
                    "postgres:execution_order_events",
                    "postgres:order_feed_source_windows",
                ],
                "source_row_counts": {
                    "trade_decisions": 2,
                    "executions": 2,
                    "execution_order_events": 4,
                    "order_feed_source_windows": 4,
                },
                "trade_decision_ids": ["decision-1", "decision-2"],
                "execution_ids": ["execution-1", "execution-2"],
                "execution_order_event_ids": ["event-1", "event-2"],
                "source_window_ids": ["source-window-1", "source-window-2"],
                "source_offsets": [
                    {"topic": "alpaca.trade_updates", "partition": 0, "offset": 42}
                ],
                "source_materialization": "execution_order_events",
                "pnl_derivation": "execution_order_events_runtime_ledger",
            }
        )

        self.assertIn("runtime_ledger_authority_class_missing", blockers)

    def test_promotion_source_authority_requires_explicit_economics(
        self,
    ) -> None:
        blockers = runtime_ledger_promotion_source_authority_blockers(
            {
                "source_window_start": "2026-05-29T14:30:00+00:00",
                "source_window_end": "2026-05-29T15:00:00+00:00",
                "source_refs": [
                    "postgres:trade_decisions",
                    "postgres:executions",
                    "postgres:execution_order_events",
                    "postgres:order_feed_source_windows",
                ],
                "source_row_counts": {
                    "trade_decisions": 1,
                    "executions": 1,
                    "execution_order_events": 1,
                    "order_feed_source_windows": 1,
                },
                "trade_decision_id": "decision-1",
                "execution_id": "execution-1",
                "execution_order_event_id": "event-1",
                "source_window_id": "source-window-1",
                "source_offsets": [
                    {"topic": "alpaca.trade_updates", "partition": 0, "offset": 42}
                ],
                "source_materialization": "execution_order_events",
                "authority_class": "runtime_order_feed_execution_source",
                "execution_economics_complete": False,
            }
        )

        self.assertIn("execution_economics_missing", blockers)

    def test_promotion_source_authority_rejects_probe_route_authority(
        self,
    ) -> None:
        blockers = runtime_ledger_promotion_source_authority_blockers(
            {
                "source_window_start": "2026-05-29T14:30:00+00:00",
                "source_window_end": "2026-05-29T15:00:00+00:00",
                "source_refs": [
                    "postgres:trade_decisions",
                    "postgres:executions",
                    "postgres:execution_order_events",
                    "postgres:order_feed_source_windows",
                ],
                "source_row_counts": {
                    "trade_decisions": 1,
                    "executions": 1,
                    "execution_order_events": 1,
                    "order_feed_source_windows": 1,
                },
                **_economics_payload(),
                "trade_decision_id": "decision-1",
                "execution_id": "execution-1",
                "execution_order_event_id": "event-1",
                "source_window_id": "source-window-1",
                "source_offsets": [
                    {"topic": "alpaca.trade_updates", "partition": 0, "offset": 42}
                ],
                "source_materialization": "execution_order_events",
                "authority_class": "runtime_order_feed_execution_source",
                "source_kind": "paper_route_probe_runtime_observed",
                "promotion_authority": False,
            }
        )

        self.assertIn("runtime_ledger_authority_class_missing", blockers)

    def test_promotion_source_authority_accepts_runtime_authority_reason_only(
        self,
    ) -> None:
        blockers = runtime_ledger_promotion_source_authority_blockers(
            {
                "source_window_start": "2026-05-29T14:30:00+00:00",
                "source_window_end": "2026-05-29T15:00:00+00:00",
                "source_refs": [
                    "postgres:trade_decisions",
                    "postgres:executions",
                    "postgres:execution_order_events",
                    "postgres:order_feed_source_windows",
                ],
                "source_row_counts": {
                    "trade_decisions": 1,
                    "executions": 1,
                    "execution_order_events": 1,
                    "order_feed_source_windows": 1,
                },
                **_economics_payload(),
                "trade_decision_id": "decision-1",
                "execution_id": "execution-1",
                "execution_order_event_id": "event-1",
                "source_window_id": "source-window-1",
                "source_offsets": [
                    {"topic": "alpaca.trade_updates", "partition": 0, "offset": 42}
                ],
                "source_materialization": "execution_order_events",
                "authority_reason": "event_sourced_runtime_ledger_profit_proof",
            }
        )

        self.assertEqual(blockers, [])

    def test_promotion_source_authority_requires_named_source_ref_tables(
        self,
    ) -> None:
        blockers = runtime_ledger_promotion_source_authority_blockers(
            {
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
                    "order_feed_source_windows": 4,
                },
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
        )

        self.assertIn("runtime_ledger_source_refs_missing", blockers)

    def test_promotion_source_authority_rejects_exact_replay_artifact_derivation(
        self,
    ) -> None:
        source_backed = {
            "source_window_start": "2026-05-29T14:30:00+00:00",
            "source_window_end": "2026-05-29T15:00:00+00:00",
            "source_refs": [
                "postgres:trade_decisions",
                "postgres:executions",
                "postgres:execution_order_events",
                "postgres:order_feed_source_windows",
            ],
            "source_row_counts": {
                "trade_decisions": 1,
                "executions": 1,
                "execution_order_events": 1,
                "order_feed_source_windows": 1,
            },
            **_economics_payload(),
            "trade_decision_id": "decision-1",
            "execution_id": "execution-1",
            "execution_order_event_id": "event-1",
            "source_window_id": "source-window-1",
            "source_offsets": [
                {"topic": "alpaca.trade_updates", "partition": 0, "offset": 42}
            ],
            "source_materialization": "execution_order_events",
            "authority_class": "runtime_order_feed_execution_source",
        }

        blockers = runtime_ledger_promotion_source_authority_blockers(
            {
                **source_backed,
                "pnl_derivation": "exact_replay_artifact_only_not_live",
            }
        )

        self.assertIn("runtime_ledger_authority_class_missing", blockers)
        self.assertFalse(
            runtime_ledger_promotion_source_authority_present(
                {
                    **source_backed,
                    "source_materialization": "exact_replay_artifact",
                }
            )
        )

    def test_promotion_source_authority_rejects_source_window_gaps(self) -> None:
        blockers = runtime_ledger_promotion_source_authority_blockers(
            {
                "source_window_start": "2026-05-29T14:30:00+00:00",
                "source_window_end": "2026-05-29T15:00:00+00:00",
                "source_refs": [
                    "postgres:trade_decisions",
                    "postgres:executions",
                    "postgres:execution_order_events",
                    "postgres:order_feed_source_windows",
                ],
                "source_row_counts": {
                    "trade_decisions": 1,
                    "executions": 1,
                    "execution_order_events": 1,
                    "order_feed_source_windows": 1,
                },
                "trade_decision_id": "decision-1",
                "execution_id": "execution-1",
                "execution_order_event_id": "event-1",
                "source_window_id": "source-window-1",
                "source_offsets": [
                    {"topic": "alpaca.trade_updates", "partition": 0, "offset": 42}
                ],
                "source_materialization": "execution_order_events",
                "authority_class": "runtime_order_feed_execution_source",
                "source_window_gap_count": 1,
            }
        )

        self.assertIn("order_feed_source_window_gap", blockers)

    def test_promotion_source_authority_rejects_source_window_gap_ranges_and_counts(
        self,
    ) -> None:
        base = {
            "source_window_start": "2026-05-29T14:30:00+00:00",
            "source_window_end": "2026-05-29T15:00:00+00:00",
            "source_refs": [
                "postgres:trade_decisions",
                "postgres:executions",
                "postgres:execution_order_events",
                "postgres:order_feed_source_windows",
            ],
            "source_row_counts": {
                "trade_decisions": 1,
                "executions": 1,
                "execution_order_events": 1,
                "order_feed_source_windows": 1,
            },
            **_economics_payload(),
            "trade_decision_id": "decision-1",
            "execution_id": "execution-1",
            "execution_order_event_id": "event-1",
            "source_window_id": "source-window-1",
            "source_offsets": [
                {"topic": "alpaca.trade_updates", "partition": 0, "offset": 42}
            ],
            "source_materialization": "execution_order_events",
            "authority_class": "runtime_order_feed_execution_source",
        }

        range_blockers = runtime_ledger_promotion_source_authority_blockers(
            {**base, "source_window_gap_ranges": [{"start_offset": 41, "end_offset": 41}]}
        )
        mapping_blockers = runtime_ledger_promotion_source_authority_blockers(
            {
                **base,
                "source_window_gap_counts": {
                    "window-ok": 0,
                    "window-bad": 2,
                    "window-invalid": "not-a-number",
                },
            }
        )

        self.assertIn("order_feed_source_window_gap", range_blockers)
        self.assertIn("order_feed_source_window_gap", mapping_blockers)

    def test_promotion_source_authority_distinguishes_lifecycle_and_economics(
        self,
    ) -> None:
        source_backed = {
            "source_window_start": "2026-05-29T14:30:00+00:00",
            "source_window_end": "2026-05-29T15:00:00+00:00",
            "source_refs": [
                "postgres:trade_decisions",
                "postgres:executions",
                "postgres:execution_order_events",
                "postgres:order_feed_source_windows",
            ],
            "source_row_counts": {
                "trade_decisions": 1,
                "executions": 1,
                "execution_order_events": 1,
                "order_feed_source_windows": 1,
            },
            **_economics_payload(),
            "trade_decision_id": "decision-1",
            "execution_id": "execution-1",
            "execution_order_event_id": "event-1",
            "source_window_id": "source-window-1",
            "source_offsets": [
                {"topic": "alpaca.trade_updates", "partition": 0, "offset": 42}
            ],
            "source_materialization": "source_execution_lifecycle",
            "authority_class": "source_execution_lifecycle_materialized_runtime_ledger",
        }

        lifecycle_blockers = runtime_ledger_promotion_source_authority_blockers(
            {
                **source_backed,
                "order_feed_lifecycle_complete": False,
                "execution_economics_complete": True,
            }
        )
        economics_blockers = runtime_ledger_promotion_source_authority_blockers(
            {
                **source_backed,
                "order_feed_lifecycle_complete": "yes",
                "execution_economics_complete": "no",
            }
        )
        unknown_flag_blockers = runtime_ledger_promotion_source_authority_blockers(
            {
                **source_backed,
                "order_feed_lifecycle_complete": "unknown",
                "execution_economics_complete": "unknown",
            }
        )

        self.assertIn("order_feed_lifecycle_missing", lifecycle_blockers)
        self.assertNotIn("execution_economics_missing", lifecycle_blockers)
        self.assertIn("execution_economics_missing", economics_blockers)
        self.assertNotIn("order_feed_lifecycle_missing", economics_blockers)
        self.assertNotIn("order_feed_lifecycle_missing", unknown_flag_blockers)
        self.assertNotIn("execution_economics_missing", unknown_flag_blockers)

    def test_promotion_source_authority_accepts_required_economics_aliases(
        self,
    ) -> None:
        payload = _source_backed_payload(
            execution_economics_required=True,
            cost_amount=None,
            broker_fee="0",
            filled_notional="not-a-decimal",
            runtime_ledger_filled_notional="1000",
        )

        self.assertEqual(runtime_ledger_promotion_source_authority_blockers(payload), [])

    def test_promotion_source_authority_rejects_non_promotion_cost_basis_inputs(
        self,
    ) -> None:
        for overrides in (
            {"cost_basis": "paper_cost_model_estimate"},
            {"cost_basis_counts": {"paper_cost_model_estimate": 1}},
            {
                "cost_basis_counts": {},
                "post_cost_basis_counts": {"paper_cost_model_estimate": 1},
            },
        ):
            with self.subTest(overrides=overrides):
                blockers = runtime_ledger_promotion_source_authority_blockers(
                    _source_backed_payload(
                        execution_economics_required=True,
                        **overrides,
                    )
                )

                self.assertIn("execution_economics_missing", blockers)

    def test_promotion_source_authority_accepts_cost_model_ref_for_zero_cost_bucket(
        self,
    ) -> None:
        payload = _source_backed_payload(
            execution_economics_required=True,
            cost_amount=None,
            cost_model_hash_counts={},
            cost_model_hash="broker-cost-v1",
        )

        self.assertEqual(runtime_ledger_promotion_source_authority_blockers(payload), [])
