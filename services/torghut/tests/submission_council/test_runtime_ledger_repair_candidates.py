from __future__ import annotations


from tests.submission_council.support import (
    SubmissionCouncilTestCase,
    _runtime_ledger_paper_probation_blockers,
    _runtime_ledger_paper_probation_import_plan,
    _runtime_ledger_repair_reason_codes,
)


class TestSubmissionCouncilRuntimeLedgerRepairCandidates(SubmissionCouncilTestCase):
    def test_runtime_ledger_repair_reason_codes_require_source_authority(self) -> None:
        payload = {
            "candidate_id": "c88421d619759b2cfaa6f4d0",
            "observed_stage": "paper",
            "fill_count": 2,
            "submitted_order_count": 2,
            "closed_trade_count": 2,
            "open_position_count": 0,
            "filled_notional": "127090.02495200",
            "net_strategy_pnl_after_costs": "567.44720578",
            "post_cost_expectancy_bps": "44.64923238",
            "ledger_schema_version": "torghut.runtime-ledger-bucket.v1",
            "pnl_basis": "realized_strategy_pnl_after_explicit_costs",
            "execution_policy_hash_counts": {"policy": 2},
            "cost_model_hash_counts": {"cost": 2},
            "lineage_hash_counts": {"lineage": 2},
            "blockers": [],
        }

        reasons = _runtime_ledger_repair_reason_codes(
            payload,
            manifest={"candidate_id": "c88421d619759b2cfaa6f4d0"},
        )

        self.assertIn("runtime_ledger_source_window_missing", reasons)
        self.assertIn("runtime_ledger_source_refs_missing", reasons)
        self.assertIn("runtime_ledger_source_window_ids_missing", reasons)
        self.assertIn("runtime_ledger_execution_order_event_refs_missing", reasons)
        self.assertIn("runtime_ledger_source_offsets_missing", reasons)
        self.assertIn("runtime_ledger_stage_not_live", reasons)

        source_backed_reasons = _runtime_ledger_repair_reason_codes(
            {
                **payload,
                "source_window_start": "2026-05-29T14:30:00+00:00",
                "source_window_end": "2026-05-29T15:00:00+00:00",
                "source_refs": [
                    "strategy_runtime_ledger_buckets:pairs-realized-runtime",
                    "postgres:trade_decisions",
                    "postgres:executions",
                    "postgres:execution_order_events",
                    "postgres:order_feed_source_windows",
                ],
                "source_row_counts": {
                    "trade_decisions": 2,
                    "executions": 2,
                    "execution_order_events": 2,
                    "strategy_runtime_ledger_buckets": 1,
                    "order_feed_source_windows": 2,
                },
                "trade_decision_ids": ["decision-buy", "decision-sell"],
                "execution_ids": ["execution-buy", "execution-sell"],
                "execution_order_event_ids": ["event-fill-buy", "event-fill-sell"],
                "source_window_ids": ["source-window-buy", "source-window-sell"],
                "source_offsets": [
                    {"topic": "alpaca.trade_updates", "partition": 0, "offset": 100},
                    {"topic": "alpaca.trade_updates", "partition": 0, "offset": 101},
                ],
                "source_materialization": "execution_order_events",
                "authority_class": "runtime_order_feed_execution_source",
                "authority_reason": "event_sourced_runtime_ledger_profit_proof",
            },
            manifest={"candidate_id": "c88421d619759b2cfaa6f4d0"},
        )

        self.assertNotIn(
            "runtime_ledger_source_window_missing",
            source_backed_reasons,
        )
        self.assertNotIn("runtime_ledger_source_refs_missing", source_backed_reasons)
        self.assertNotIn(
            "runtime_ledger_source_window_ids_missing", source_backed_reasons
        )
        self.assertNotIn(
            "runtime_ledger_execution_order_event_refs_missing",
            source_backed_reasons,
        )
        self.assertEqual(source_backed_reasons, ["runtime_ledger_stage_not_live"])

    def test_paper_probation_blockers_require_source_fills_and_explicit_costs(
        self,
    ) -> None:
        candidate = {
            "hypothesis_id": "H-PAIRS-01",
            "candidate_id": "c88421d619759b2cfaa6f4d0",
            "strategy_id": "microbar_cross_sectional_pairs_v1@research",
            "strategy_family": "microbar_cross_sectional_pairs",
            "account": "TORGHUT_SIM",
            "observed_stage": "paper",
            "bucket_started_at": "2026-05-29T14:30:00+00:00",
            "bucket_ended_at": "2026-05-29T15:00:00+00:00",
            "decision_count": 2,
            "submitted_order_count": 2,
            "fill_count": 0,
            "closed_trade_count": 0,
            "open_position_count": 0,
            "filled_notional": "0",
            "net_strategy_pnl_after_costs": "12.50",
            "post_cost_expectancy_bps": "125",
            "pnl_basis": "realized_strategy_pnl_after_explicit_costs",
            "execution_policy_hash_counts": {"policy": 2},
            "lineage_hash_counts": {"lineage": 2},
            "reason_codes": ["runtime_ledger_stage_not_live"],
        }

        blockers = _runtime_ledger_paper_probation_blockers(candidate)

        self.assertIn("runtime_ledger_fills_missing", blockers)
        self.assertIn("runtime_ledger_filled_notional_missing", blockers)
        self.assertIn("runtime_ledger_closed_round_trips_missing", blockers)
        self.assertIn("runtime_ledger_explicit_costs_missing", blockers)
        self.assertIn("runtime_ledger_cost_model_hash_missing", blockers)
        self.assertIn("runtime_ledger_source_refs_missing", blockers)
        plan = _runtime_ledger_paper_probation_import_plan([candidate])
        self.assertEqual(plan["target_count"], 0)
        self.assertEqual(plan["skipped_target_count"], 1)
        self.assertFalse(plan["canary_collection_authorized"])
        self.assertFalse(plan["bounded_live_paper_collection_authorized"])
        skipped = plan["skipped_targets"][0]
        self.assertEqual(
            skipped["reason"],
            "runtime_ledger_paper_probation_prerequisites_not_satisfied",
        )
        self.assertIn("runtime_ledger_source_refs_missing", skipped["blockers"])

        malformed = {
            "observed_stage": "exact_replay",
            "open_position_count": 1,
            "net_strategy_pnl_after_costs": "-1",
            "post_cost_expectancy_bps": "-1",
            "reason_codes": [
                "runtime_ledger_stage_not_live",
                "exact_replay_candidate_only",
            ],
        }

        malformed_blockers = _runtime_ledger_paper_probation_blockers(malformed)

        self.assertIn("exact_replay_candidate_only", malformed_blockers)
        self.assertIn("runtime_ledger_stage_not_paper", malformed_blockers)
        self.assertIn("runtime_ledger_pnl_basis_missing", malformed_blockers)
        self.assertIn("runtime_ledger_decisions_missing", malformed_blockers)
        self.assertIn("runtime_order_lifecycle_missing", malformed_blockers)
        self.assertIn("unclosed_position", malformed_blockers)
        self.assertIn("post_cost_pnl_non_positive", malformed_blockers)
        self.assertIn("post_cost_expectancy_non_positive", malformed_blockers)
        self.assertIn(
            "runtime_ledger_execution_policy_hash_missing", malformed_blockers
        )
        self.assertIn("runtime_ledger_lineage_hash_missing", malformed_blockers)
